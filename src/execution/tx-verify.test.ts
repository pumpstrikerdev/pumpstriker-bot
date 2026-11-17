/**
 * B40 tx-verify (refusal reasons, bounds, simulation). Every transaction here is built in memory from instructions; the RPC is a
 * fake that answers getMultipleAccounts (pre-state) and simulateTransaction (post-state). Nothing is sent or signed.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { deriveBondingCurvePda } from './curve-state';
import {
  ATA_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, PUMP_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, deriveAta, type ExecRpc,
} from './exec-common';
import {
  anchorInstructionDiscriminator, checkPumpPortalPriorityFee, computeBudgetFeeLamports, createTxVerifier, PUMP_BUY_DISCRIMINATORS,
  PUMP_IX_NAMES, PUMP_SELL_DISCRIMINATORS, PUMPPORTAL_FEE_ACCOUNTS, PUMPPORTAL_FEE_BPS, pumpPortalMaxFeeLamports,
  PUMPPORTAL_PRIORITY_FEE_MAX_FACTOR, TIP_ACCOUNTS, verifyPumpDirectStatic, verifyPumpDirectTx, type PumpDirectVerifyCtx,
} from './tx-verify';
import * as pumpfunIx from './pumpfun-ix';
import { PumpDirectRefusal, classifyPumpCurve, pumpTradeBounds } from './pump-program';
import { addPumpWorld, createPumpDirectChain, pumpMintBytes, type PumpDirectChain } from './pump-direct-testkit';
import { PreSignRefusal } from './send-context';

const key = (n: number): string => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
/** A secret-shaped value generated at runtime (A-20). */
const SECRET = `k${randomBytes(12).toString('hex')}`;
const OWNER = key(1);
const MINT = key(2);
const PORTAL_FEE = key(8);
const BLOCKHASH = key(90);
const SYSTEM = SystemProgram.programId.toBase58();
const OWNER_ATA = deriveAta(OWNER, MINT, 'token2022');
const CURVE = deriveBondingCurvePda(MINT);
const TIP = TIP_ACCOUNTS[0];

const pk = (s: string): PublicKey => new PublicKey(s);
const u64 = (n: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

function ix(programId: string, keys: Array<[string, boolean, boolean]>, data: Buffer | number[]): TransactionInstruction {
  return new TransactionInstruction({
    programId: pk(programId),
    keys: keys.map(([k, signer, writable]) => ({ pubkey: pk(k), isSigner: signer, isWritable: writable })),
    data: Buffer.from(data),
  });
}

/** A pump buy/sell instruction with the account layout of pumpfun-swap.ts (mint, curve and the user ATA at the usual slots). */
function pumpIx(kind: 'buy' | 'sell', o: { mint?: string; curve?: string; ata?: string; disc?: readonly number[] } = {}): TransactionInstruction {
  const mint = o.mint ?? MINT;
  const curve = o.curve ?? deriveBondingCurvePda(mint);
  const ata = o.ata ?? deriveAta(OWNER, mint, 'token2022');
  const disc = o.disc ?? (kind === 'buy' ? PUMP_BUY_DISCRIMINATORS[0] : PUMP_SELL_DISCRIMINATORS[0]);
  return ix(PUMP_PROGRAM_ID, [
    [key(20), false, false], [key(21), false, true], [mint, false, false], [curve, false, true], [key(22), false, true],
    [ata, false, true], [OWNER, true, true], [SYSTEM, false, false], [TOKEN_2022_PROGRAM_ID, false, false], [key(23), false, true],
    [key(24), false, false], [PUMP_PROGRAM_ID, false, false],
  ], Buffer.concat([Buffer.from(disc), u64(1_000_000n), u64(2_000_000n)]));
}
const createAtaIx = (ata = OWNER_ATA, mint = MINT): TransactionInstruction =>
  ix(ATA_PROGRAM_ID, [[OWNER, true, true], [ata, false, true], [OWNER, false, false], [mint, false, false], [SYSTEM, false, false], [TOKEN_2022_PROGRAM_ID, false, false]], [1]);
const transferIx = (to: string, lamports: bigint, from = OWNER): TransactionInstruction =>
  SystemProgram.transfer({ fromPubkey: pk(from), toPubkey: pk(to), lamports });
const budget = (): TransactionInstruction[] => [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })];

function toBase64(ixs: TransactionInstruction[], payer = OWNER, alts: AddressLookupTableAccount[] = []): string {
  const msg = new TransactionMessage({ payerKey: pk(payer), recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message(alts);
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

const validBuy = (): TransactionInstruction[] => [...budget(), createAtaIx(), pumpIx('buy'), transferIx(PORTAL_FEE, 500_000n)];
const validSell = (): TransactionInstruction[] => [...budget(), pumpIx('sell'), transferIx(PORTAL_FEE, 300_000n)];

type Ctx = Parameters<ReturnType<typeof createTxVerifier>['verify']>[1];
const buyCtx = (o: Partial<Ctx> = {}): Ctx => ({
  owner: OWNER, mint: MINT, side: 'buy', tokenProgram: 'token2022', maxLamportsOut: 200_000_000n, tokensIn: null,
  maxFeeLamports: 1_000_000n, maxTipLamports: 200_000n, ...o,
});
const sellCtx = (o: Partial<Ctx> = {}): Ctx => buyCtx({ side: 'sell', maxLamportsOut: 0n, tokensIn: 1_000_000n, ...o });

const tokenAcct = (amount: bigint): any => {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return { lamports: 2_074_080, owner: TOKEN_2022_PROGRAM_ID, data: [b.toString('base64'), 'base64'], executable: false };
};
const solAcct = (lamports: bigint): any => ({ lamports: Number(lamports), owner: SYSTEM, data: ['', 'base64'], executable: false });

interface Sim { preLam?: bigint; postLam?: bigint; preTok?: bigint | null; postTok?: bigint | null; err?: unknown; throws?: boolean; alt?: { key: string; bytes: Buffer } | null }
/** Fake RPC: pre-state through getMultipleAccounts, post-state through simulateTransaction; records every call. */
function fakeRpc(s: Sim = {}) {
  const calls: Array<{ method: string; params: any[] }> = [];
  const rpc: ExecRpc = {
    async call(method: string, params: unknown[]): Promise<any> {
      calls.push({ method, params: params as any[] });
      if (s.throws) throw new Error(`rpc exploded https://rpc.example.invalid/?api-key=${SECRET}`);
      if (method === 'getAccountInfo') {
        const a = (params as string[])[0];
        if (s.alt && a === s.alt.key) return { value: { data: [s.alt.bytes.toString('base64'), 'base64'], owner: key(71), lamports: 1 } };
        return { value: null };
      }
      if (method === 'getMultipleAccounts') {
        const preTok = s.preTok === undefined ? 0n : s.preTok;
        return { value: [solAcct(s.preLam ?? 1_000_000_000n), preTok === null ? null : tokenAcct(preTok)] };
      }
      if (method === 'simulateTransaction') {
        const postTok = s.postTok === undefined ? 1_000_000n : s.postTok;
        return { value: { err: s.err ?? null, logs: [], accounts: [solAcct(s.postLam ?? 900_000_000n), postTok === null ? null : tokenAcct(postTok)] } };
      }
      throw new Error(`unexpected rpc ${method}`);
    },
  };
  return { rpc, calls };
}
const verifierWith = (rpc: ExecRpc) => createTxVerifier({ rpc, feeAccounts: [PORTAL_FEE] });
const OK = { ok: true } as const;

describe('tx-verify', () => {
  it('B4-T04 refuses a foreign program, an extra signer and an outflow above the bound, each with its reason', async () => {
    const { rpc, calls } = fakeRpc();
    const v = verifierWith(rpc);
    // the unmodified transaction passes, so the refusals below come from the injected defect and nothing else
    expect(await v.verify(toBase64(validBuy()), buyCtx())).toEqual(OK);

    // foreign program (static refusal: no RPC call)
    const before = calls.length;
    const foreign = new TransactionInstruction({ programId: pk(key(50)), keys: [], data: Buffer.from([1, 2, 3]) });
    const r1 = await v.verify(toBase64([...validBuy(), foreign]), buyCtx());
    expect(r1.ok).toBe(false);
    expect(r1.ok === false && r1.reason).toBe(`program not allowed: ${key(50)}`);

    // extra signer: a second required signature
    const extra = ix(ATA_PROGRAM_ID, [[OWNER, true, true], [OWNER_ATA, false, true], [OWNER, false, false], [MINT, false, false], [SYSTEM, false, false], [TOKEN_2022_PROGRAM_ID, false, false], [key(51), true, false]], [1]);
    const r2 = await v.verify(toBase64([...budget(), extra, pumpIx('buy')]), buyCtx());
    expect(r2.ok).toBe(false);
    expect(r2.ok === false && r2.reason).toMatch(/^extra signer/);
    expect(calls.length).toBe(before);   // both refusals were decided without a single RPC call

    // outflow above the bound: everything static is fine, the simulation shows 300M leaving a 200M bound
    const heavy = fakeRpc({ preLam: 1_000_000_000n, postLam: 700_000_000n });
    const r3 = await verifierWith(heavy.rpc).verify(toBase64(validBuy()), buyCtx());
    expect(r3.ok).toBe(false);
    expect(r3.ok === false && r3.reason).toMatch(/lamport outflow above bound/);
    // exactly at the bound is fine
    const exact = fakeRpc({ preLam: 1_000_000_000n, postLam: 800_000_000n });
    expect(await verifierWith(exact.rpc).verify(toBase64(validBuy()), buyCtx())).toEqual(OK);
  });

  it('B4-T09 a transfer-only transaction to an allowlisted fee or tip account within the bound is refused: no pump instruction', async () => {
    const { rpc, calls } = fakeRpc();
    const v = verifierWith(rpc);
    for (const ixs of [
      [...budget(), transferIx(PORTAL_FEE, 400_000n)],
      [...budget(), transferIx(TIP, 150_000n)],
      [...budget(), transferIx(PORTAL_FEE, 400_000n), transferIx(TIP, 150_000n)],
    ]) {
      const r = await v.verify(toBase64(ixs), buyCtx());
      expect(r).toEqual({ ok: false, reason: 'no pump instruction' });
    }
    expect(calls).toHaveLength(0);
  });

  it('B4-T10 a pump buy for a different mint is refused: mint mismatch', async () => {
    const { rpc } = fakeRpc();
    const v = verifierWith(rpc);
    const other = key(60);
    const wrongMint = [...budget(), createAtaIx(), pumpIx('buy', { mint: other }), transferIx(PORTAL_FEE, 500_000n)];
    expect(await v.verify(toBase64(wrongMint), buyCtx())).toEqual({ ok: false, reason: 'mint mismatch' });
    // the right mint with another curve or another ATA is refused as well
    expect(await v.verify(toBase64([...budget(), pumpIx('buy', { curve: deriveBondingCurvePda(other) })]), buyCtx())).toEqual({ ok: false, reason: 'bonding curve mismatch' });
    expect(await v.verify(toBase64([...budget(), pumpIx('buy', { ata: deriveAta(OWNER, MINT, 'token') })]), buyCtx())).toEqual({ ok: false, reason: 'owner ATA mismatch' });
  });

  it('B4-T11 a sell carrying an extra Token Transfer, TransferChecked or Approve from the owner ATA is refused', async () => {
    const { rpc } = fakeRpc({ preLam: 1_000_000_000n, postLam: 1_070_000_000n, preTok: 1_000_000n, postTok: 0n });
    const v = verifierWith(rpc);
    expect(await v.verify(toBase64(validSell()), sellCtx())).toEqual(OK);   // baseline sell passes

    const dest = key(61);
    const extras: Array<[string, TransactionInstruction]> = [
      ['Transfer', ix(TOKEN_2022_PROGRAM_ID, [[OWNER_ATA, false, true], [dest, false, true], [OWNER, true, false]], Buffer.concat([Buffer.from([3]), u64(1n)]))],
      ['TransferChecked', ix(TOKEN_2022_PROGRAM_ID, [[OWNER_ATA, false, true], [MINT, false, false], [dest, false, true], [OWNER, true, false]], Buffer.concat([Buffer.from([12]), u64(1n), Buffer.from([6])]))],
      ['Approve', ix(TOKEN_2022_PROGRAM_ID, [[OWNER_ATA, false, true], [dest, false, false], [OWNER, true, false]], Buffer.concat([Buffer.from([4]), u64(1n)]))],
      ['ApproveChecked', ix(TOKEN_PROGRAM_ID, [[OWNER_ATA, false, true], [MINT, false, false], [dest, false, false], [OWNER, true, false]], Buffer.concat([Buffer.from([13]), u64(1n), Buffer.from([6])]))],
      ['SetAuthority', ix(TOKEN_2022_PROGRAM_ID, [[OWNER_ATA, false, true], [OWNER, true, false]], Buffer.from([6, 2, 1, ...pk(dest).toBytes()]))],
      ['Burn', ix(TOKEN_2022_PROGRAM_ID, [[OWNER_ATA, false, true], [MINT, false, true], [OWNER, true, false]], Buffer.concat([Buffer.from([8]), u64(1n)]))],
    ];
    for (const [name, extra] of extras) {
      const r = await v.verify(toBase64([...validSell(), extra]), sellCtx());
      expect(r.ok, name).toBe(false);
      expect(r.ok === false && r.reason, name).toBe(`token instruction not allowed: ${name}`);
      // also when the extra instruction comes before the swap
      const r2 = await v.verify(toBase64([...budget(), extra, pumpIx('sell')]), sellCtx());
      expect(r2.ok, `${name} first`).toBe(false);
    }
    // a CloseAccount or SyncNative of anything but the owner's wSOL account, and a create-ATA for another account, are refused too
    const closeOther = ix(TOKEN_2022_PROGRAM_ID, [[OWNER_ATA, false, true], [OWNER, false, true], [OWNER, true, false]], [9]);
    expect((await v.verify(toBase64([...validSell(), closeOther]), sellCtx())).ok).toBe(false);
    const syncOther = ix(TOKEN_PROGRAM_ID, [[OWNER_ATA, false, true]], [17]);
    expect((await v.verify(toBase64([...validSell(), syncOther]), sellCtx())).ok).toBe(false);
    expect((await v.verify(toBase64([...budget(), createAtaIx(key(62)), pumpIx('sell')]), sellCtx())).ok).toBe(false);
  });

  it('B4-T12 a fee transfer above maxFeeLamports is refused', async () => {
    const { rpc } = fakeRpc();
    const v = verifierWith(rpc);
    const withFee = (n: bigint): string => toBase64([...budget(), createAtaIx(), pumpIx('buy'), transferIx(PORTAL_FEE, n)]);
    const r = await v.verify(withFee(1_000_001n), buyCtx({ maxFeeLamports: 1_000_000n }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/^fee transfer above bound/);
    expect(await v.verify(withFee(1_000_000n), buyCtx({ maxFeeLamports: 1_000_000n }))).toEqual(OK);   // exactly the bound passes
    // the same holds for tips
    const tip = (n: bigint): string => toBase64([...budget(), createAtaIx(), pumpIx('buy'), transferIx(TIP, n)]);
    const t = await v.verify(tip(200_001n), buyCtx({ maxTipLamports: 200_000n }));
    expect(t.ok === false && t.reason).toMatch(/^tip transfer above bound/);
    expect(await v.verify(tip(200_000n), buyCtx({ maxTipLamports: 200_000n }))).toEqual(OK);
    // two fee transfers that each fit but together exceed the bound are refused
    const two = toBase64([...budget(), createAtaIx(), pumpIx('buy'), transferIx(PORTAL_FEE, 600_000n), transferIx(PORTAL_FEE, 600_000n)]);
    expect((await v.verify(two, buyCtx({ maxFeeLamports: 1_000_000n }))).ok).toBe(false);
  });

  it('B4-T13 a simulation that shows a zero token delta on a buy is refused', async () => {
    const zero = fakeRpc({ preTok: 0n, postTok: 0n });
    const r = await verifierWith(zero.rpc).verify(toBase64(validBuy()), buyCtx());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/no token delta/);
    // the owner ATA absent after the simulation counts as zero as well
    const absent = fakeRpc({ preTok: null, postTok: null });
    expect((await verifierWith(absent.rpc).verify(toBase64(validBuy()), buyCtx())).ok).toBe(false);
    // a positive delta from a not-yet-created ATA passes
    const fresh = fakeRpc({ preTok: null, postTok: 5_000n });
    expect(await verifierWith(fresh.rpc).verify(toBase64(validBuy()), buyCtx())).toEqual(OK);
  });

  it('asks the simulation for exactly what B40 rule 4(d) lists, and checks the sell side', async () => {
    const sim = fakeRpc({ preLam: 1_000_000_000n, postLam: 1_050_000_000n, preTok: 1_000_000n, postTok: 400_000n });
    const v = verifierWith(sim.rpc);
    expect(await v.verify(toBase64(validSell()), sellCtx())).toEqual(OK);
    const call = sim.calls.find((c) => c.method === 'simulateTransaction');
    expect(call?.params[1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: false, accounts: { addresses: [OWNER, OWNER_ATA] } });

    // sell: no lamport inflow, a decrease above tokensIn, and an increase are refused; so is a missing tokensIn
    const noInflow = fakeRpc({ preLam: 1_000_000_000n, postLam: 999_000_000n, preTok: 1_000_000n, postTok: 0n });
    expect((await verifierWith(noInflow.rpc).verify(toBase64(validSell()), sellCtx())).ok).toBe(false);
    const tooMany = fakeRpc({ preLam: 1_000_000_000n, postLam: 1_050_000_000n, preTok: 5_000_000n, postTok: 0n });
    const r = await verifierWith(tooMany.rpc).verify(toBase64(validSell()), sellCtx({ tokensIn: 1_000_000n }));
    expect(r.ok === false && r.reason).toMatch(/decrease above tokensIn/);
    const increase = fakeRpc({ preLam: 1_000_000_000n, postLam: 1_050_000_000n, preTok: 1n, postTok: 9n });
    expect((await verifierWith(increase.rpc).verify(toBase64(validSell()), sellCtx())).ok).toBe(false);
    expect((await v.verify(toBase64(validSell()), sellCtx({ tokensIn: null }))).ok).toBe(false);
  });

  it('fails closed: a throwing RPC, a failed simulation, an undecodable transaction and a bad context are all refusals with short redacted reasons', async () => {
    const down = fakeRpc({ throws: true });
    const r1 = await verifierWith(down.rpc).verify(toBase64(validBuy()), buyCtx());
    expect(r1.ok).toBe(false);
    expect(r1.ok === false && r1.reason).toMatch(/^simulation unavailable/);
    expect(r1.ok === false && r1.reason).not.toContain(SECRET);
    expect(r1.ok === false && r1.reason.length).toBeLessThanOrEqual(200);

    const failedSim = fakeRpc({ err: { InstructionError: [3, { Custom: 6002 }] } });
    const r2 = await verifierWith(failedSim.rpc).verify(toBase64(validBuy()), buyCtx());
    expect(r2.ok === false && r2.reason).toMatch(/^simulation failed/);

    const { rpc, calls } = fakeRpc();
    const v = verifierWith(rpc);
    expect(await v.verify('', buyCtx())).toEqual({ ok: false, reason: 'undecodable transaction' });
    expect(await v.verify('AAAA', buyCtx())).toEqual({ ok: false, reason: 'undecodable transaction' });
    expect((await v.verify(toBase64(validBuy()), buyCtx({ owner: 'nope' }))).ok).toBe(false);
    // the fee payer must be the owner
    const otherPayer = toBase64([...budget(), pumpIx('buy')], key(3));
    expect(await v.verify(otherPayer, buyCtx())).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it('refuses the wrong side, two pump instructions, an unknown pump discriminator, System Assign/CreateAccount and an unlisted transfer', async () => {
    const { rpc, calls } = fakeRpc({ preLam: 1_000_000_000n, postLam: 1_070_000_000n, preTok: 1_000_000n, postTok: 0n });
    const v = verifierWith(rpc);
    const why = async (ixs: TransactionInstruction[], ctx: Ctx): Promise<string> => {
      const r = await v.verify(toBase64(ixs), ctx);
      return r.ok ? 'ACCEPTED' : r.reason;
    };
    expect(await why(validSell(), buyCtx())).toMatch(/^side mismatch/);
    expect(await why(validBuy(), sellCtx())).toMatch(/^side mismatch/);
    expect(await why([...budget(), pumpIx('buy'), pumpIx('buy')], buyCtx())).toBe('multiple pump instructions');
    expect(await why([...budget(), pumpIx('buy', { disc: [1, 2, 3, 4, 5, 6, 7, 8] })], buyCtx())).toBe('pump instruction is not a known buy or sell');
    expect(await why([...validBuy(), SystemProgram.assign({ accountPubkey: pk(OWNER), programId: pk(key(50)) })], buyCtx())).toBe('system instruction not allowed: Assign');
    expect(await why([...validBuy(), SystemProgram.createAccount({ fromPubkey: pk(OWNER), newAccountPubkey: pk(key(52)), lamports: 1, space: 0, programId: pk(key(50)) })], buyCtx())).toMatch(/^extra signer/);   // the new account must sign too: refused before the instruction is even looked at
    expect(await why([...validBuy(), transferIx(key(53), 1n)], buyCtx())).toBe(`system transfer to non-allowlisted address ${key(53)}`);
    // a transfer from somebody else (not even marked as a signer, which the runtime would reject anyway) is refused by its own rule
    const foreignFrom = ix(SYSTEM, [[key(54), false, true], [PORTAL_FEE, false, true]], Buffer.concat([Buffer.from([2, 0, 0, 0]), u64(1n)]));
    expect(await why([...validBuy(), foreignFrom], buyCtx())).toBe('system transfer not from the owner');
    // a transfer that needs another signer is refused as an extra signer
    expect(await why([...validBuy(), transferIx(PORTAL_FEE, 1n, key(54))], buyCtx())).toMatch(/^extra signer/);
    expect(calls).toHaveLength(0);   // all of these are static refusals
    // ComputeBudget, CreateIdempotent for the owner ATA, SyncNative and CloseAccount of the owner wSOL account are allowed
    const wsolAta = deriveAta(OWNER, WSOL_MINT, 'token');
    const sync = ix(TOKEN_PROGRAM_ID, [[wsolAta, false, true]], [17]);
    const close = ix(TOKEN_PROGRAM_ID, [[wsolAta, false, true], [OWNER, false, true], [OWNER, true, false]], [9]);
    expect(await why([...budget(), createAtaIx(), sync, pumpIx('sell'), close], sellCtx())).toBe('ACCEPTED');
  });

  it('resolves v0 address-table lookups before checking the pump accounts, and refuses when the table cannot be read', async () => {
    const tableKey = key(70);
    const addrs = [OWNER_ATA, CURVE, MINT].map(pk);
    const header = Buffer.alloc(56);
    header.writeUInt32LE(1, 0);
    const bytes = Buffer.concat([header, ...addrs.map((a) => Buffer.from(a.toBytes()))]);
    const alt = new AddressLookupTableAccount({
      key: pk(tableKey),
      state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: addrs },
    });
    const ixs = [...budget(), pumpIx('buy'), transferIx(PORTAL_FEE, 500_000n)];
    const b64 = toBase64(ixs, OWNER, [alt]);
    expect(VersionedTransaction.deserialize(Buffer.from(b64, 'base64')).message.addressTableLookups.length).toBe(1);

    const good = fakeRpc({ alt: { key: tableKey, bytes } });
    expect(await verifierWith(good.rpc).verify(b64, buyCtx())).toEqual(OK);
    const missing = fakeRpc({ alt: null });
    const r = await verifierWith(missing.rpc).verify(b64, buyCtx());
    expect(r.ok === false && r.reason).toMatch(/^unresolved address lookup table/);
  });

  it('keeps its constants honest: Anchor discriminators, the tip list, the fee bound and the open PumpPortal fee list', () => {
    // every discriminator is sha256("global:<name>")[0..8] of the IDL name (the rule that also reproduces the three pumpfun-swap.ts uses)
    PUMP_IX_NAMES.buy.forEach((name, i) => expect(anchorInstructionDiscriminator(name), name).toEqual([...PUMP_BUY_DISCRIMINATORS[i]]));
    PUMP_IX_NAMES.sell.forEach((name, i) => expect(anchorInstructionDiscriminator(name), name).toEqual([...PUMP_SELL_DISCRIMINATORS[i]]));
    expect(PUMP_BUY_DISCRIMINATORS[1]).toEqual([56, 252, 116, 8, 158, 223, 205, 95]);   // buy_exact_sol_in, as sent by pumpfun-swap.ts
    expect(PUMP_SELL_DISCRIMINATORS[0]).toEqual([51, 230, 133, 164, 1, 127, 131, 173]); // sell, as sent by pumpfun-swap.ts
    // tip accounts are the same ten addresses as config.ts, all valid keys
    expect([...TIP_ACCOUNTS]).toEqual([...CONFIG.HELIUS_TIP_ACCOUNTS]);
    for (const a of [...TIP_ACCOUNTS, ...PUMPPORTAL_FEE_ACCOUNTS]) expect(() => new PublicKey(a)).not.toThrow();
    // fee bound: ceil(amount * bps / 10000) + 1 lamport
    expect(PUMPPORTAL_FEE_BPS).toBe(50);
    expect(pumpPortalMaxFeeLamports(100_000_000n)).toBe(500_001n);
    expect(pumpPortalMaxFeeLamports(100_000_001n)).toBe(500_002n);
    expect(pumpPortalMaxFeeLamports(1n)).toBe(2n);
  });

  it('with the shipped constants a fee transfer to an unlisted address is refused with the address in the reason (the open PumpPortal fee list fails closed)', async () => {
    const { rpc } = fakeRpc();
    const shipped = createTxVerifier({ rpc });
    const r = await shipped.verify(toBase64(validBuy()), buyCtx());
    if (PUMPPORTAL_FEE_ACCOUNTS.includes(PORTAL_FEE)) throw new Error('test fee account must not be in the shipped list');
    expect(r).toEqual({ ok: false, reason: `system transfer to non-allowlisted address ${PORTAL_FEE}` });
  });
});

// ── FIX-BUY2 item 5: PumpPortal's current wrapper stays refused (the decision is pinned here) ───────────────────────────

/**
 * The program PumpPortal trade-local now wraps pump's buy or sell in: undocumented, closed-source, upgradeable, its upgrade authority
 * attributed to nobody (FIX-BUY2 research, 2026-11-06), and the two fee wallets hard-coded in it. None of them may ever enter an allowlist.
 */
const FADO9 = 'FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe';
const FADO9_FEE_WALLETS = ['7FeFBYbewCqXG7LP6gC8Fnqzk7hmQFMtntXVRqnXi4g6', 'FgX1cdFq7khWeivEfHCULBA6ovtSr9djdAfJ9r3LvNST'];

/**
 * PumpPortal's current shape: ONE FAdo9 instruction that forwards pump's accounts (pump itself as its 12th account, which it calls with the
 * owner's signature) plus the fee wallet. Data: pump's own instruction code with byte 1 changed to 0x32, amount, max cost / min output, fee
 * bps 50, and on a sell an f64 -1.0 (19 accounts and 26 bytes for a buy, 18 accounts and 34 bytes for a sell).
 */
function fado9Ix(kind: 'buy' | 'sell'): TransactionInstruction {
  const head: Array<[string, boolean, boolean]> = [
    [key(20), false, false], [key(21), false, true], [MINT, false, false], [CURVE, false, true], [key(22), false, true],
    [OWNER_ATA, false, true], [OWNER, true, true], [SYSTEM, false, false],
  ];
  const keys: Array<[string, boolean, boolean]> = kind === 'buy'
    ? [...head, [TOKEN_2022_PROGRAM_ID, false, false], [key(23), false, true], [key(24), false, false], [PUMP_PROGRAM_ID, false, false],
      [key(25), false, true], [key(26), false, true], [key(27), false, false], [key(28), false, false], [key(29), false, true],
      [FADO9_FEE_WALLETS[0], false, true], [key(30), false, true]]
    : [...head, [key(23), false, true], [TOKEN_2022_PROGRAM_ID, false, false], [key(24), false, false], [PUMP_PROGRAM_ID, false, false],
      [key(27), false, false], [key(28), false, false], [FADO9_FEE_WALLETS[1], false, true], [key(29), false, true],
      [FADO9_FEE_WALLETS[0], false, true], [key(30), false, true]];
  const code = kind === 'buy' ? [0x66, 0x32, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea] : [0x33, 0x32, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad];
  const feeBps = Buffer.alloc(2);
  feeBps.writeUInt16LE(50);
  const notPercent = Buffer.alloc(8);
  notPercent.writeDoubleLE(-1);
  const data = Buffer.concat([Buffer.from(code), u64(1_000_000n), u64(kind === 'buy' ? 60_000_000n : 0n), feeBps, ...(kind === 'sell' ? [notPercent] : [])]);
  return ix(FADO9, keys, data);
}

describe('FIX-BUY2 item 5: the FAdo9 wrapper stays refused', () => {
  it('FIXBUY2-I5-T07 a transaction whose only swap instruction is FAdo9 (PumpPortal\'s current shape) is refused before any RPC call: program not allowed', async () => {
    const portalBudget = (): TransactionInstruction[] => [ComputeBudgetProgram.setComputeUnitLimit({ units: 170_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })];
    expect(fado9Ix('buy').keys).toHaveLength(19);
    expect(fado9Ix('buy').data).toHaveLength(26);
    expect(fado9Ix('sell').keys).toHaveLength(18);
    expect(fado9Ix('sell').data).toHaveLength(34);
    expect(fado9Ix('buy').keys[11].pubkey.toBase58()).toBe(PUMP_PROGRAM_ID);
    const shapes: Array<[string, TransactionInstruction[], Ctx]> = [
      ['buy', [...portalBudget(), createAtaIx(), fado9Ix('buy')], buyCtx()],
      ['sell', [...portalBudget(), fado9Ix('sell')], sellCtx()],
      // a top-level pump instruction beside it does not let the wrapper through either
      ['buy beside a pump instruction', [...budget(), createAtaIx(), pumpIx('buy'), fado9Ix('buy')], buyCtx()],
    ];
    const { rpc, calls } = fakeRpc({ preLam: 1_000_000_000n, postLam: 1_070_000_000n, preTok: 1_000_000n, postTok: 0n });
    // the shipped verifier, and one that even counts the wrapper's fee wallets as fee accounts: the wrapper program itself is refused
    for (const v of [createTxVerifier({ rpc }), createTxVerifier({ rpc, feeAccounts: [...FADO9_FEE_WALLETS] })]) {
      for (const [name, ixs, ctx] of shapes) {
        expect(await v.verify(toBase64(ixs), ctx), name).toEqual({ ok: false, reason: `program not allowed: ${FADO9}` });
      }
    }
    expect(calls).toHaveLength(0);   // static refusals: no lookup table read, no simulation
  });

  it('FIXBUY2-I5-T08 FAdo9 and its two fee wallets are in no shipped allowlist, and no verifier source names them', () => {
    for (const a of [FADO9, ...FADO9_FEE_WALLETS]) {
      expect(() => new PublicKey(a)).not.toThrow();
      expect(PUMPPORTAL_FEE_ACCOUNTS).not.toContain(a);
      expect(TIP_ACCOUNTS).not.toContain(a);
      expect([PUMP_PROGRAM_ID, ATA_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, SYSTEM]).not.toContain(a);
    }
    expect(PUMPPORTAL_FEE_ACCOUNTS).toEqual([]);   // still empty on purpose (A-51); FIX-BUY2 adds no PumpPortal fee account either
    // Every verifier source: tx-verify step (d) and ext-verify's owner-account check now live in sim-owner-checks.ts (FIX-BUY2 item 7(e)),
    // and jupiter.ts holds the third verifier, the /swap/v2/order simulation check (verifyOrderBySimulation).
    // FIX-PUMP: pump-program.ts (the pinned lists of the PF-direct verifier) and the PF-direct route files are scanned too
    for (const f of ['tx-verify.ts', 'ext-verify.ts', 'sim-owner-checks.ts', 'jupiter.ts', 'pump-program.ts', 'pumpfun-ix.ts', 'pumpfun-swap.ts']) {
      const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
      for (const a of [FADO9, ...FADO9_FEE_WALLETS]) expect(src.includes(a), `${f} names ${a}`).toBe(false);
    }
  });
});

describe('PumpPortal priority-fee bound (A-27)', () => {
  const toTx = (ixs: TransactionInstruction[]): VersionedTransaction =>
    new VersionedTransaction(new TransactionMessage({ payerKey: pk(OWNER), recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message());
  const cb = (data: number[]): TransactionInstruction => new TransactionInstruction({ programId: pk(COMPUTE_BUDGET_PROGRAM_ID), keys: [], data: Buffer.from(data) });
  const limit = (units: number): TransactionInstruction => ComputeBudgetProgram.setComputeUnitLimit({ units });
  const price = (microLamports: number | bigint): TransactionInstruction => ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
  const fee = (ixs: TransactionInstruction[]): bigint => {
    const r = computeBudgetFeeLamports(toTx(ixs));
    if (!r.ok) throw new Error(`unexpected refusal: ${r.reason}`);
    return r.lamports;
  };
  const why = (ixs: TransactionInstruction[]): string => {
    const r = computeBudgetFeeLamports(toTx(ixs));
    return r.ok ? 'ACCEPTED' : r.reason;
  };

  it('A27 the bound is a named constant of 2 x the requested priority fee', () => {
    expect(PUMPPORTAL_PRIORITY_FEE_MAX_FACTOR).toBe(2);
  });

  it('A27 computes the priority fee as unit price (micro-lamports) x unit limit / 1_000_000, rounded up', () => {
    expect(fee([limit(200_000), price(50_000), pumpIx('buy')])).toBe(10_000n);             // 50_000 x 200_000 / 1e6
    expect(fee([price(5), limit(200_000), pumpIx('buy')])).toBe(1n);                       // exactly 1 lamport
    expect(fee([limit(1), price(1)])).toBe(1n);                                            // 1e-6 lamport rounds UP to 1
    expect(fee([limit(250_000), price(1_000_000)])).toBe(250_000n);
    expect(fee([price(2n ** 40n), limit(1_000_000)])).toBe(2n ** 40n);                     // bigint-sized prices do not overflow
    expect(fee([limit(200_000), pumpIx('buy')])).toBe(0n);                                 // a limit alone costs no priority fee
    expect(fee([pumpIx('buy')])).toBe(0n);                                                 // neither: no priority fee
    // no limit instruction: the runtime default of 200_000 units per other instruction applies, capped at 1_400_000
    expect(fee([price(1_000_000), createAtaIx(), pumpIx('buy')])).toBe(400_000n);
    expect(fee([price(1_000_000), ...Array.from({ length: 10 }, () => transferIx(TIP, 1n))])).toBe(1_400_000n);
    // a limit above the runtime maximum is clamped to it
    expect(fee([limit(5_000_000), price(1_000_000)])).toBe(1_400_000n);
    // instructions that carry no fee are ignored
    expect(fee([cb([1, 0, 0, 1, 0]), cb([4, 0, 0, 1, 0]), limit(200_000), price(50_000)])).toBe(10_000n);
  });

  it('A27 fails closed on a duplicated, deprecated, unknown or malformed ComputeBudget instruction', () => {
    expect(why([price(1), price(2)])).toBe('duplicate SetComputeUnitPrice');
    expect(why([limit(1), limit(2)])).toBe('duplicate SetComputeUnitLimit');
    expect(why([cb([0, 1, 0, 0, 0, 255, 255, 255, 255]), pumpIx('buy')])).toBe('deprecated ComputeBudget RequestUnits instruction');
    expect(why([cb([9, 1, 2, 3])])).toBe('unknown ComputeBudget instruction');
    expect(why([cb([])])).toBe('unknown ComputeBudget instruction');
    expect(why([cb([2, 1, 2])])).toBe('malformed SetComputeUnitLimit');
    expect(why([cb([3, 1, 2, 3])])).toBe('malformed SetComputeUnitPrice');
  });

  it('A27 refuses a priority fee above 2 x the requested prioritySol in lamports, and accepts exactly 2 x', () => {
    const requested = 0.0001;                                                    // 100_000 lamports -> bound 200_000
    const at = toTx([limit(200_000), price(1_000_000), pumpIx('buy')]);         // fee 200_000
    const over = toTx([limit(200_000), price(1_000_005), pumpIx('buy')]);       // fee 200_001
    expect(checkPumpPortalPriorityFee(at, requested)).toEqual({ ok: true });
    const r = checkPumpPortalPriorityFee(over, requested);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('priority fee above bound (200001 > 2 x requested 100000 lamports)');
    // the same transaction is fine when more was asked for
    expect(checkPumpPortalPriorityFee(over, 0.00011)).toEqual({ ok: true });
    // a fee of 10x what was requested (a builder inflating the price) is refused
    expect(checkPumpPortalPriorityFee(toTx([limit(200_000), price(5_000_000), pumpIx('sell')]), requested).ok).toBe(false);
    // no fee at all always passes; a fee against a zero request is refused
    expect(checkPumpPortalPriorityFee(toTx([pumpIx('buy')]), 0)).toEqual({ ok: true });
    expect(checkPumpPortalPriorityFee(toTx([limit(1), price(1), pumpIx('buy')]), 0).ok).toBe(false);
    // the lamport value is rounded from the float: 0.00123 SOL = 1_230_000 lamports
    expect(checkPumpPortalPriorityFee(toTx([limit(1_000_000), price(2_460_000)]), 0.00123)).toEqual({ ok: true });   // fee 2_460_000
    expect(checkPumpPortalPriorityFee(toTx([limit(1_000_000), price(2_460_001)]), 0.00123).ok).toBe(false);
  });

  it('A27 refuses an unusable requested fee and an unparseable ComputeBudget section, with short reasons', () => {
    const ok = toTx([limit(200_000), price(1), pumpIx('buy')]);
    for (const bad of [Number.NaN, -0.0001, Number.POSITIVE_INFINITY]) {
      expect(checkPumpPortalPriorityFee(ok, bad)).toEqual({ ok: false, reason: 'invalid requested priority fee' });
    }
    const dup = checkPumpPortalPriorityFee(toTx([price(1), price(2)]), 0.01);
    expect(dup).toEqual({ ok: false, reason: 'duplicate SetComputeUnitPrice' });
    const longReason = checkPumpPortalPriorityFee(toTx([limit(1_400_000), price(2n ** 62n)]), 1e-9);
    expect(longReason.ok).toBe(false);
    expect(longReason.ok === false && longReason.reason.length).toBeLessThanOrEqual(200);
  });
});
// ── FIX-PUMP: the strict verifier of a PF-direct transaction (verifyPumpDirectStatic / verifyPumpDirectTx) ─────────────────────────────

const PD_OWNER = key(41);
const PD_MINT = key(42);
const PD_CREATOR = key(43);
const PD_OTHER = key(44);
const PD_PROGRAM_T22 = TOKEN_2022_PROGRAM_ID;
/** A Token-2022 coin on a 166-byte SOL curve; the owner holds 5 000 000 000 atoms, its user_volume_accumulator exists. */
function pdChain(curve: Parameters<typeof addPumpWorld>[1]['curve'] = {}): PumpDirectChain {
  return addPumpWorld(createPumpDirectChain(), { mint: PD_MINT, owner: PD_OWNER, creator: PD_CREATOR, program: 'token2022', curve, held: 5_000_000_000n, uva: true });
}
function pdCtx(chain: PumpDirectChain, side: 'buy' | 'sell', over: Partial<PumpDirectVerifyCtx> = {}): PumpDirectVerifyCtx {
  const curve = chain.accounts.get(pumpfunIx.deriveBondingCurve(pk(PD_MINT)).toBase58())!;
  const mint = chain.accounts.get(PD_MINT)!;
  return {
    owner: PD_OWNER, mint: PD_MINT, side, amountIn: side === 'buy' ? 50_000_000n : 1_000_000_000n, slippageBps: 300, antiMev: false,
    curve: { owner: curve.owner, data: curve.data }, mintAccount: { owner: mint.owner, data: mint.data }, maxCuPriceMicroLamports: 5_000_000n, ...over,
  };
}
function pdMinOut(ctx: PumpDirectVerifyCtx): bigint {
  const c = classifyPumpCurve(ctx.curve);
  if (!c.ok) throw new Error(c.detail);
  const b = pumpTradeBounds(c.value, ctx.side, ctx.amountIn, ctx.slippageBps);
  if (!b.ok) throw new Error(b.detail);
  return b.value.minOut;
}
interface PdBuild { amountIn?: bigint; minOut?: bigint; antiMev?: boolean; fees?: pumpfunIx.PumpFeeAccounts; cuLimit?: number; cuPrice?: number; tip?: { to?: string; lamports?: number } }
/** The instructions the route builds, from the same pieces (pumpfun-ix builders), before compiling. */
function pdIxs(ctx: PumpDirectVerifyCtx, o: PdBuild = {}): TransactionInstruction[] {
  const fees = o.fees ?? pumpfunIx.pickPumpFeeAccounts(false, () => 0);
  const amountIn = o.amountIn ?? ctx.amountIn;
  const minOut = o.minOut ?? pdMinOut(ctx);
  const tp = pk(PD_PROGRAM_T22);
  const out: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: o.cuLimit ?? 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: o.cuPrice ?? 100_000 }),
  ];
  if (ctx.side === 'buy') {
    out.push(pumpfunIx.buildCreateAtaIfNeededIx(pk(PD_OWNER), pk(PD_OWNER), pk(PD_MINT), tp), pumpfunIx.buildBuyInstruction(pk(PD_OWNER), pk(PD_MINT), pk(PD_CREATOR), amountIn, minOut, tp, fees));
  } else {
    out.push(pumpfunIx.buildSellInstruction(pk(PD_OWNER), pk(PD_MINT), pk(PD_CREATOR), amountIn, minOut, false, tp, fees));
  }
  if (o.antiMev ?? ctx.antiMev) out.push(SystemProgram.transfer({ fromPubkey: pk(PD_OWNER), toPubkey: pk(o.tip?.to ?? TIP), lamports: o.tip?.lamports ?? 200_000 }));
  return out;
}
const pdTx = (ixs: TransactionInstruction[], payer = PD_OWNER, alts: AddressLookupTableAccount[] = []): VersionedTransaction =>
  new VersionedTransaction(new TransactionMessage({ payerKey: pk(payer), recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message(alts));
const pdPumpAt = (ixs: TransactionInstruction[]): number => ixs.findIndex((x) => x.programId.toBase58() === PUMP_PROGRAM_ID);
/** The instruction list with the pump instruction's account `i` replaced (key and / or flags). */
function pdWithAccount(ixs: TransactionInstruction[], i: number, edit: Partial<TransactionInstruction['keys'][number]>): TransactionInstruction[] {
  const at = pdPumpAt(ixs);
  const p = ixs[at];
  const copy = [...ixs];
  copy[at] = new TransactionInstruction({ programId: p.programId, data: p.data, keys: p.keys.map((k, j) => (j === i ? { ...k, ...edit } : k)) });
  return copy;
}
function pdWithData(ixs: TransactionInstruction[], data: Buffer): TransactionInstruction[] {
  const at = pdPumpAt(ixs);
  const copy = [...ixs];
  copy[at] = new TransactionInstruction({ programId: ixs[at].programId, keys: ixs[at].keys, data });
  return copy;
}
const pdReason = (tx: VersionedTransaction, ctx: PumpDirectVerifyCtx): string => {
  const r = verifyPumpDirectStatic(tx, ctx);
  return r.ok ? 'ACCEPTED' : r.reason;
};

describe('FIX-PUMP strict PF-direct verifier: static pins', () => {
  it('PDV-T01 the transaction the route builds passes, buy and sell, with and without the Sender tip, on NORMAL and RESERVED coins', () => {
    for (const side of ['buy', 'sell'] as const) {
      for (const antiMev of [false, true]) {
        const chain = pdChain();
        const ctx = pdCtx(chain, side, { antiMev });
        const r = verifyPumpDirectStatic(pdTx(pdIxs(ctx)), ctx);
        expect(r.ok, `${side} ${antiMev} ${r.ok ? '' : r.reason}`).toBe(true);
        if (r.ok) {
          expect(r.minOut).toBe(pdMinOut(ctx));
          expect(r.priorityFeeLamports).toBe(20_000n);   // ceil(100 000 x 200 000 / 1e6)
          expect(r.tipLamports).toBe(antiMev ? 200_000n : 0n);
        }
      }
    }
    const mayhem = pdChain({ mayhem: true });
    const mctx = pdCtx(mayhem, 'buy');
    expect(pdReason(pdTx(pdIxs(mctx, { fees: pumpfunIx.pickPumpFeeAccounts(true, () => 0.5) })), mctx)).toBe('ACCEPTED');
    // a mayhem coin refuses the NORMAL list at account 1, a normal coin the RESERVED list
    expect(pdReason(pdTx(pdIxs(mctx)), mctx)).toBe('account 1 (fee_recipient) is not in the RESERVED list');
    const nctx = pdCtx(pdChain(), 'buy');
    expect(pdReason(pdTx(pdIxs(nctx, { fees: pumpfunIx.pickPumpFeeAccounts(true, () => 0) })), nctx)).toBe('account 1 (fee_recipient) is not in the NORMAL list');
  });

  it('PDV-T02 every account position swapped for a plausible wrong key is refused at that position', () => {
    const chain = pdChain();
    for (const side of ['buy', 'sell'] as const) {
      const ctx = pdCtx(chain, side);
      const base = pdIxs(ctx);
      const n = base[pdPumpAt(base)].keys.length;
      expect(n).toBe(side === 'buy' ? 18 : 16);
      const otherMint = key(45);
      const wrong: Record<string, string> = {
        global: PD_OTHER, fee_recipient: FADO9_FEE_WALLETS[0], mint: otherMint, bonding_curve: deriveBondingCurvePda(otherMint),
        associated_bonding_curve: deriveAta(deriveBondingCurvePda(PD_MINT), PD_MINT, 'token'), associated_user: deriveAta(PD_OWNER, PD_MINT, 'token'),
        user: PD_OTHER, system_program: TOKEN_PROGRAM_ID, token_program: TOKEN_PROGRAM_ID, creator_vault: pumpfunIx.deriveCreatorVault(pk(PD_OTHER)).toBase58(),
        event_authority: PD_OTHER, program: PD_OTHER, global_volume_accumulator: PD_OTHER, user_volume_accumulator: pumpfunIx.deriveUserVolumeAccumulator(pk(PD_OTHER)).toBase58(),
        fee_config: PD_OTHER, fee_program: PD_OTHER, bonding_curve_v2: pumpfunIx.deriveBondingCurveV2(pk(otherMint)).toBase58(), buyback_fee_recipient: FADO9_FEE_WALLETS[1],
      };
      const names = side === 'buy'
        ? ['global', 'fee_recipient', 'mint', 'bonding_curve', 'associated_bonding_curve', 'associated_user', 'user', 'system_program', 'token_program', 'creator_vault', 'event_authority', 'program', 'global_volume_accumulator', 'user_volume_accumulator', 'fee_config', 'fee_program', 'bonding_curve_v2', 'buyback_fee_recipient']
        : ['global', 'fee_recipient', 'mint', 'bonding_curve', 'associated_bonding_curve', 'associated_user', 'user', 'system_program', 'creator_vault', 'token_program', 'event_authority', 'program', 'fee_config', 'fee_program', 'bonding_curve_v2', 'buyback_fee_recipient'];
      for (let i = 0; i < n; i++) {
        const reason = pdReason(pdTx(pdWithAccount(base, i, { pubkey: pk(wrong[names[i]]) })), ctx);
        // another key as the signing user makes a second signer: refused before the positions are read
        const want = names[i] === 'user' ? /^extra signer: 2 required signatures$/ : new RegExp(`^account ${i} \\(${names[i]}\\)`);
        expect(reason, `${side} ${i} ${names[i]}`).toMatch(want);
      }
      // the FAdo9 wrapper's fee wallets are in no list
      for (const w of FADO9_FEE_WALLETS) expect(pdReason(pdTx(pdWithAccount(base, 1, { pubkey: pk(w) })), ctx)).toBe('account 1 (fee_recipient) is not in the NORMAL list');
    }
  });

  it('PDV-T03 every flag flipped is refused (role pin), and an extra signer is refused', () => {
    const chain = pdChain();
    for (const side of ['buy', 'sell'] as const) {
      const ctx = pdCtx(chain, side);
      const base = pdIxs(ctx);
      const original = Buffer.from(pdTx(base).message.serialize());
      let visible = 0;
      for (let i = 0; i < base[pdPumpAt(base)].keys.length; i++) {
        const k = base[pdPumpAt(base)].keys[i];
        const flipped = pdTx(pdWithAccount(base, i, { isWritable: !k.isWritable }));
        if (Buffer.from(flipped.message.serialize()).equals(original)) continue;   // the key is writable through another instruction too
        visible++;
        expect(pdReason(flipped, ctx), `${side} ${i}`).toMatch(/^role of /);
      }
      expect(visible).toBeGreaterThanOrEqual(side === 'buy' ? 15 : 14);
      expect(pdReason(pdTx(pdWithAccount(base, 3, { isSigner: true })), ctx)).toBe('extra signer: 2 required signatures');
    }
  });

  it('PDV-T04 data mutations: a 24- or 26-byte buy, track_volume 00, the legacy buy and v3 discriminators, the amount or the minimum off by one, a slippage of 0 or 5001', () => {
    const chain = pdChain();
    const ctx = pdCtx(chain, 'buy');
    const base = pdIxs(ctx);
    const data = base[pdPumpAt(base)].data;
    expect(data).toHaveLength(25);
    const r = (d: Buffer): string => pdReason(pdTx(pdWithData(base, d)), ctx);
    expect(r(data.subarray(0, 24))).toBe('pump buy data is 24 bytes, expected 25');
    expect(r(Buffer.concat([data, Buffer.from([0])]))).toBe('pump buy data is 26 bytes, expected 25');
    const t0 = Buffer.from(data); t0[24] = 0;
    expect(r(t0)).toBe('pump buy track_volume is not 01');
    for (const name of ['buy', 'buy_exact_quote_in_v3', 'buy_v3', 'buy_v2', 'buy_exact_quote_in_v2']) {
      expect(r(Buffer.concat([Buffer.from(anchorInstructionDiscriminator(name)), data.subarray(8)])), name).toBe('pump instruction is not buy_exact_sol_in');
    }
    expect(pdReason(pdTx(pdIxs(ctx, { amountIn: ctx.amountIn + 1n })), ctx)).toBe('spendable_sol_in differs from the requested amount');
    expect(pdReason(pdTx(pdIxs(ctx, { amountIn: ctx.amountIn - 1n })), ctx)).toBe('spendable_sol_in differs from the requested amount');
    const min = pdMinOut(ctx);
    expect(pdReason(pdTx(pdIxs(ctx, { minOut: min + 1n })), ctx)).toMatch(/^min_tokens_out .* differs from the bound/);
    expect(pdReason(pdTx(pdIxs(ctx, { minOut: min - 1n })), ctx)).toMatch(/^min_tokens_out .* differs from the bound/);
    // no slippage bound at all (a minimum of 0) is refused like any other minimum
    expect(pdReason(pdTx(pdIxs(ctx, { minOut: 0n })), ctx)).toBe(`min_tokens_out 0 differs from the bound ${min}`);
    expect(pdReason(pdTx(base), { ...ctx, slippageBps: 0 })).toBe('slippage outside 1..5000 bps');
    expect(pdReason(pdTx(base), { ...ctx, slippageBps: 5001 })).toBe('slippage outside 1..5000 bps');
    // the sell: the legacy / v2 / v3 sells and the amount or minimum off by one
    const sctx = pdCtx(chain, 'sell');
    const sbase = pdIxs(sctx);
    for (const name of ['sell_v2', 'sell_v3']) {
      expect(pdReason(pdTx(pdWithData(sbase, Buffer.concat([Buffer.from(anchorInstructionDiscriminator(name)), sbase[pdPumpAt(sbase)].data.subarray(8)]))), sctx), name).toBe('pump instruction is not sell');
    }
    expect(pdReason(pdTx(pdIxs(sctx, { amountIn: sctx.amountIn + 1n })), sctx)).toBe('sell amount differs from the requested amount');
    expect(pdReason(pdTx(pdIxs(sctx, { minOut: pdMinOut(sctx) - 1n })), sctx)).toMatch(/^min_sol_output .* differs from the bound/);
    expect(pdReason(pdTx(pdIxs(sctx, { minOut: 0n })), sctx)).toBe(`min_sol_output 0 differs from the bound ${pdMinOut(sctx)}`);
  });

  it('PDV-T05 compute budget, tip and extra-instruction mutations, and message mutations', () => {
    const chain = pdChain();
    const ctx = pdCtx(chain, 'buy');
    const tctx = { ...ctx, antiMev: true };
    expect(pdReason(pdTx(pdIxs(ctx, { cuLimit: 199_999 })), ctx)).toBe('instruction 0 is not SetComputeUnitLimit(200000)');
    expect(pdReason(pdTx(pdIxs(ctx, { cuLimit: 200_001 })), ctx)).toBe('instruction 0 is not SetComputeUnitLimit(200000)');
    expect(pdReason(pdTx(pdIxs(ctx, { cuPrice: 5_000_001 })), ctx)).toBe('compute unit price 5000001 above the ceiling 5000000');
    expect(pdReason(pdTx(pdIxs(ctx, { cuPrice: 5_000_000 })), ctx)).toBe('ACCEPTED');
    const heap = [ComputeBudgetProgram.requestHeapFrame({ bytes: 65_536 }), ...pdIxs(ctx)];
    expect(pdReason(pdTx(heap), ctx)).toBe('unexpected instruction 2');
    const heapLast = [...pdIxs(ctx), ComputeBudgetProgram.requestHeapFrame({ bytes: 65_536 })];
    expect(pdReason(pdTx(heapLast), ctx)).toBe('unexpected instruction 4');
    // the tip: missing, extra, 199 999 lamports, to a non-allowlisted account
    expect(pdReason(pdTx(pdIxs(tctx, { antiMev: false })), tctx)).toBe('the Sender tip instruction is missing');
    expect(pdReason(pdTx(pdIxs(ctx, { antiMev: true })), ctx)).toBe('unexpected instruction 4');
    expect(pdReason(pdTx(pdIxs(tctx, { tip: { lamports: 199_999 } })), tctx)).toBe('tip instruction is not a 200000-lamport System transfer');
    expect(pdReason(pdTx(pdIxs(tctx, { tip: { to: PD_OTHER } })), tctx)).toBe(`tip to non-allowlisted address ${PD_OTHER}`);
    // extra instructions: CloseAccount, SyncNative, Token Transfer, System Assign
    const ata = deriveAta(PD_OWNER, PD_MINT, 'token2022');
    const extras: Array<[string, TransactionInstruction, string]> = [
      ['CloseAccount', ix(TOKEN_2022_PROGRAM_ID, [[ata, false, true], [PD_OWNER, false, true], [PD_OWNER, true, false]], [9]), `program not allowed: ${TOKEN_2022_PROGRAM_ID}`],
      ['SyncNative', ix(TOKEN_PROGRAM_ID, [[ata, false, true]], [17]), `program not allowed: ${TOKEN_PROGRAM_ID}`],
      ['Transfer', ix(TOKEN_2022_PROGRAM_ID, [[ata, false, true], [PD_OTHER, false, true], [PD_OWNER, true, false]], [3, 1, 0, 0, 0, 0, 0, 0, 0]), `program not allowed: ${TOKEN_2022_PROGRAM_ID}`],
      ['Assign', ix(SYSTEM, [[PD_OWNER, true, true]], [1, 0, 0, 0, ...pk(PD_OTHER).toBytes()]), 'unexpected instruction 4'],
    ];
    for (const [name, extra, why] of extras) expect(pdReason(pdTx([...pdIxs(ctx), extra]), ctx), name).toBe(why);
    // message: a lookup table, a second signer, a payer other than the owner, a legacy message
    const table = new AddressLookupTableAccount({ key: pk(key(46)), state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [pk(PUMP_PROGRAM_ID), pk(TOKEN_2022_PROGRAM_ID)] } });
    expect(pdReason(pdTx(pdIxs(ctx), PD_OWNER, [table]), ctx)).toBe('address lookup tables are not allowed');
    const second = [...pdIxs(ctx)];
    second.push(ix(SYSTEM, [[PD_OTHER, true, true], [PD_OWNER, false, true]], [2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]));
    expect(pdReason(pdTx(second), ctx)).toBe('extra signer: 2 required signatures');
    expect(pdReason(pdTx(pdIxs(ctx), PD_OTHER), ctx)).toBe('extra signer: 2 required signatures');
    const legacy = new VersionedTransaction(new TransactionMessage({ payerKey: pk(PD_OWNER), recentBlockhash: BLOCKHASH, instructions: pdIxs(ctx) }).compileToLegacyMessage());
    expect(pdReason(legacy, ctx)).toBe('not a v0 message');
    const signed = pdTx(pdIxs(ctx));
    signed.signatures[0] = Uint8Array.from({ length: 64 }, (_v, i) => (i === 3 ? 1 : 0));
    expect(pdReason(signed, ctx)).toBe('the transaction already carries a signature');
    // the curve and mint the verifier is given are re-classified: a complete or USDC-quoted curve, a mint with a freeze authority
    const usdc = pdChain({ quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
    expect(pdReason(pdTx(pdIxs(ctx)), pdCtx(usdc, 'buy'))).toMatch(/^curve refused \(non-sol-quote\)/);
    const done = pdChain({ complete: true });
    expect(pdReason(pdTx(pdIxs(ctx)), pdCtx(done, 'buy'))).toMatch(/^curve refused \(curve-complete\)/);
    expect(pdReason(pdTx(pdIxs(ctx)), { ...ctx, mintAccount: { owner: TOKEN_2022_PROGRAM_ID, data: pumpMintBytes({ program: 'token2022', freezeAuthority: PD_OTHER }) } })).toMatch(/^mint refused \(mint-unsupported\)/);
    // the reason is redacted and at most 200 characters
    expect(pdReason(pdTx(pdIxs(tctx, { tip: { to: PD_OTHER } })), tctx).length).toBeLessThanOrEqual(200);
  });
});

describe('FIX-PUMP strict PF-direct verifier: the simulation', () => {
  const run = (chain: PumpDirectChain, side: 'buy' | 'sell', deps: { onLayoutRejected?: (c: number) => void; timeoutMs?: number } = {}) => {
    const ctx = pdCtx(chain, side);
    return verifyPumpDirectTx(pdTx(pdIxs(ctx)), ctx, { rpc: chain, ...deps });
  };
  it('PDV-T06 a clean simulation passes with one simulateTransaction and one pre-state read at processed; nothing is signed', async () => {
    for (const side of ['buy', 'sell'] as const) {
      const chain = pdChain();
      const v = await run(chain, side);
      expect(v.unitsConsumed).toBe(72_480);
      expect(chain.calls.map((c) => c.method).sort()).toEqual(['getMultipleAccounts', 'simulateTransaction']);
      const sim = chain.calls.find((c) => c.method === 'simulateTransaction')!;
      expect(sim.params[1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: false, commitment: 'processed', accounts: { encoding: 'base64' } });
      const tx = VersionedTransaction.deserialize(Buffer.from(sim.params[0], 'base64'));
      expect(tx.signatures[0].every((b) => b === 0)).toBe(true);
      expect(chain.calls.find((c) => c.method === 'getMultipleAccounts')!.params[1]).toMatchObject({ commitment: 'processed' });
    }
  });

  it('PDV-T07 refusals: 6042 reads as price moved, 6057 is a layout error (the breaker hook), a token delta below the minimum, an outflow 1 lamport above the bound, a sell decrease other than the amount, a delegate, a creator changed between the reads, a timeout', async () => {
    const chain = pdChain();
    chain.sim.err = { InstructionError: [3, { Custom: 6042 }] };
    const e1 = await run(chain, 'buy').catch((e) => e);
    expect(e1).toBeInstanceOf(PreSignRefusal);
    expect((e1 as Error).message).toBe('the price moved past the slippage limit (pump error 6042). Nothing was sent; no fee was paid.');
    const layout: number[] = [];
    chain.sim.err = { InstructionError: [3, { Custom: 6057 }] };
    expect(await run(chain, 'buy', { onLayoutRejected: (c) => layout.push(c) }).catch((e) => e)).toBeInstanceOf(PreSignRefusal);
    chain.sim.err = { InstructionError: [2, { Custom: 6000 }] };
    expect(await run(chain, 'sell', { onLayoutRejected: (c) => layout.push(c) }).catch((e) => (e as Error).message)).toMatch(/pump refused the transaction layout \(error 6000\)/);
    chain.sim.err = { InstructionError: [3, { Custom: 6021 }] };
    expect(await run(chain, 'buy', { onLayoutRejected: (c) => layout.push(c) }).catch((e) => (e as Error).message)).toMatch(/fewer tokens left/);
    expect(layout).toEqual([6057, 6000]);   // 6021 (sold out) is not a layout error
    chain.sim.err = undefined;

    const refusedWith = async (c: PumpDirectChain, side: 'buy' | 'sell', why: RegExp): Promise<void> => {
      const e = await run(c, side).catch((x) => x);
      expect(e, String(why)).toBeInstanceOf(PumpDirectRefusal);
      expect((e as Error).message).toMatch(why);
    };
    const c2 = pdChain();
    const min = pdMinOut(pdCtx(c2, 'buy'));
    c2.sim.editPost = (p) => { p.ata!.data.writeBigUInt64LE(5_000_000_000n + min - 1n, 64); };
    await refusedWith(c2, 'buy', /token delta .* below min_tokens_out/);
    // the outflow bound: amountIn + priority (20 000) + 5 000, the ATA and the accumulator exist, the creator vault holds 650 240 (top-up 240 640)
    const c3 = pdChain();
    const bound = 50_000_000n + 20_000n + 5_000n + (890_880n - 650_240n);
    c3.sim.editPost = (p) => { p.owner.lamports = 10_000_000_000n - bound; };
    await run(c3, 'buy');
    c3.sim.editPost = (p) => { p.owner.lamports = 10_000_000_000n - bound - 1n; };
    await refusedWith(c3, 'buy', new RegExp(`owner lamport outflow ${bound + 1n} above the bound ${bound}`));
    const c4 = pdChain();
    c4.sim.editPost = (p) => { p.ata!.data.writeBigUInt64LE(5_000_000_000n - 1_000_000_000n + 1n, 64); };
    await refusedWith(c4, 'sell', /owner token decrease 999999999, expected exactly 1000000000/);
    const c5 = pdChain();
    c5.sim.editPost = (p) => { p.ata!.data.writeUInt32LE(1, 72); Buffer.from(pk(PD_OTHER).toBytes()).copy(p.ata!.data, 76); };
    await refusedWith(c5, 'sell', /delegate, close authority or state/);
    const c6 = pdChain();
    c6.editPreState = (addresses, values) => {
      const curve = values[addresses.indexOf(pumpfunIx.deriveBondingCurve(pk(PD_MINT)).toBase58())]!;
      Buffer.from(pk(PD_OTHER).toBytes()).copy(curve.data, 49);
    };
    await refusedWith(c6, 'buy', /the curve identity changed between the reads/);
    const c7 = pdChain();
    c7.sim.hang = true;
    const t0 = Date.now();
    const e7 = await run(c7, 'buy', { timeoutMs: 50 }).catch((x) => x);
    expect(e7).toBeInstanceOf(PumpDirectRefusal);
    expect((e7 as Error).message).toMatch(/simulation: timed out/);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
