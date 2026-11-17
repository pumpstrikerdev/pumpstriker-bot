/**
 * R7-W5 ext-verify.ts, swap profile (design 7.4 V1-V3, S1-S8, 10.1): the verifier reads the BYTES of an unsigned transaction and a simulation of
 * the resolved message, and fails closed. Each case below builds a valid transaction from the pure builders, changes ONE thing, and expects a refusal.
 * A scripted chain (getMultipleAccounts, simulateTransaction with per-account post states); nothing is signed; addresses derive at test time (A-20).
 */
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import {
  AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { setCuLimitInstruction, setCuPriceInstruction } from './compute-budget';
import { JUPITER_V6_PROGRAM_ID, PUMP_PROGRAM, verifySwapTx, type SwapExpectation, type WalletVerifyDeps } from './ext-verify';
import * as pumpfunIx from './pumpfun-ix';
import { PUMP_BUYBACK_FEE_RECIPIENTS, PUMP_FEE_RECIPIENTS_NORMAL, pumpBuyQuote, pumpSellQuote } from './pump-program';
import * as pumpswapIx from './pumpswap-ix';
import { deriveAtaAddress, parseSplTokenAccount, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from './wallet-reads';
import type { WalletRpcPort } from './wallet-rpc';

// ── ids and accounts ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const fixtureKey = (i: number): string => bs58.encode(createHash('sha256').update('ps-fixture-' + i).digest());
const pk = (s: string): PublicKey => new PublicKey(s);
const OWNER = fixtureKey(1);
const MINT = fixtureKey(31);
const CREATOR = fixtureKey(3);
const OTHER = fixtureKey(79);
const SYSTEM = SystemProgram.programId.toBase58();
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
const ALT_KEY = fixtureKey(45);
const U64_MAX = 18446744073709551615n;
const SOL = 1_000_000_000n;
const RENT = 2_039_280n;
const A = 50_000_000n;
const TOKEN = pk(TOKEN_PROGRAM_ID);

interface Acct { lamports: bigint; owner: string; data: Buffer }
const sysAcct = (lamports: bigint): Acct => ({ lamports, owner: SYSTEM, data: Buffer.alloc(0) });
interface TokenOpts { mint: string; owner: string; amount: bigint; program?: string; delegate?: string; closeAuthority?: string }
function tokenAcct(o: TokenOpts): Acct {
  const d = Buffer.alloc(165);
  Buffer.from(bs58.decode(o.mint)).copy(d, 0);
  Buffer.from(bs58.decode(o.owner)).copy(d, 32);
  d.writeBigUInt64LE(o.amount, 64);
  if (o.delegate) { d.writeUInt32LE(1, 72); Buffer.from(bs58.decode(o.delegate)).copy(d, 76); }
  d[108] = 1;
  if (o.closeAuthority) { d.writeUInt32LE(1, 129); Buffer.from(bs58.decode(o.closeAuthority)).copy(d, 133); }
  return { lamports: RENT, owner: o.program ?? TOKEN_PROGRAM_ID, data: d };
}
function altAcct(addresses: string[], deactivationSlot = U64_MAX, owner = ALT_PROGRAM): Acct {
  const d = Buffer.alloc(56 + addresses.length * 32);
  d.writeUInt32LE(1, 0);
  d.writeBigUInt64LE(deactivationSlot, 4);
  addresses.forEach((a, i) => Buffer.from(bs58.decode(a)).copy(d, 56 + i * 32));
  return { lamports: SOL, owner, data: d };
}
const rpcAccount = (a: Acct | null): unknown => (a === null ? null : { lamports: Number(a.lamports), owner: a.owner, data: [a.data.toString('base64'), 'base64'], executable: false, rentEpoch: 0, space: a.data.length });
interface Delta { lamports?: bigint; tokens?: bigint; create?: { mint: string; owner: string; program?: string }; close?: boolean; delegate?: string; closeAuthority?: string; ownerTo?: string }
function applyDelta(pre: Acct | null, d: Delta | undefined): Acct | null {
  if (!d) return pre;
  if (d.close) return null;
  let a = pre;
  if (a === null && d.create) a = tokenAcct({ mint: d.create.mint, owner: d.create.owner, amount: 0n, program: d.create.program });
  if (a === null) a = sysAcct(0n);
  const out: Acct = { lamports: a.lamports + (d.lamports ?? 0n), owner: a.owner, data: Buffer.from(a.data) };
  if (d.tokens !== undefined) out.data.writeBigUInt64LE(parseSplTokenAccount(out.data)!.amount + d.tokens, 64);
  if (d.delegate) { out.data.writeUInt32LE(1, 72); Buffer.from(bs58.decode(d.delegate)).copy(out.data, 76); }
  if (d.closeAuthority) { out.data.writeUInt32LE(1, 129); Buffer.from(bs58.decode(d.closeAuthority)).copy(out.data, 133); }
  if (d.ownerTo) Buffer.from(bs58.decode(d.ownerTo)).copy(out.data, 32);
  return out;
}
class FakeChain implements WalletRpcPort {
  accounts = new Map<string, Acct | null>();
  deltas = new Map<string, Delta>();
  balance = 10n * SOL;
  err: unknown = null;
  sims = 0;
  set(addr: string, a: Acct | null): this { this.accounts.set(addr, a); return this; }
  pre(addr: string): Acct | null { return this.accounts.has(addr) ? this.accounts.get(addr)! : addr === OWNER ? sysAcct(this.balance) : null; }
  async call(method: string, params: unknown[]): Promise<any> {
    const p = params as any[];
    if (method === 'getMultipleAccounts') return { context: { slot: 10 }, value: (p[0] as string[]).map((k) => rpcAccount(this.pre(k))) };
    if (method === 'simulateTransaction') {
      this.sims++;
      const addresses: string[] = p[1].accounts.addresses;
      return { context: { slot: 11 }, value: { err: this.err, logs: [], accounts: this.err ? null : addresses.map((a) => rpcAccount(applyDelta(this.pre(a), this.deltas.get(a)))), unitsConsumed: 60_000 } };
    }
    throw new Error(`unexpected ${method}`);
  }
}

// ── a valid transaction per route, as instructions + the expectation the builder would disclose ─────────────────────────────────────────
// FIX-PUMP: account 1 is one of Global's NORMAL fee recipients and the last account one of its buyback recipients (pump-program.ts lists)
const FEE_RECIPIENT = PUMP_FEE_RECIPIENTS_NORMAL[0];
const BUYBACK = PUMP_BUYBACK_FEE_RECIPIENTS[0];
const FEES = { feeRecipient: pk(FEE_RECIPIENT), buybackFeeRecipient: pk(BUYBACK) };
const CREATOR_VAULT = pumpfunIx.deriveCreatorVault(pk(CREATOR)).toBase58();
const tradeAta = deriveAtaAddress(OWNER, MINT, TOKEN_PROGRAM_ID);
const wsolAta = deriveAtaAddress(OWNER, WSOL_MINT, TOKEN_PROGRAM_ID);
/** FIX-PUMP: buy_exact_sol_in's quote, pump's 95 + 30 bps fees out of the spend (pump-program.ts, pinned against mainnet TradeEvents). */
const curveOut = (amount: bigint): bigint => pumpBuyQuote(30_000_000_000n, 1_073_000_000_000_000n, amount)!.tokensOut;
const floorMin = (q: bigint, slip: number): bigint => (q * BigInt(10_000 - slip)) / 10_000n;

interface Case {
  payer: string;
  ixs: TransactionInstruction[];
  tables: AddressLookupTableAccount[];
  exp: SwapExpectation;
  chain: FakeChain;
  deps: WalletVerifyDeps;
  /** change the serialized bytes after compiling (a non-zero signature, a size) */
  after?: (tx: VersionedTransaction) => void;
  legacy?: boolean;
}
const CB = (limit = 72_000, price = 60_000): TransactionInstruction[] => [setCuLimitInstruction(limit), setCuPriceInstruction(price)];
const create = (wallet = OWNER, mint = MINT, program = TOKEN): TransactionInstruction => pumpfunIx.buildCreateAtaIfNeededIx(pk(OWNER), pk(wallet), pk(mint), program);
const baseExp = (over: Partial<SwapExpectation>): SwapExpectation => ({
  route: 'pump', side: 'buy', owner: OWNER, mint: MINT, tokenProgram: TOKEN_PROGRAM_ID, slippageBps: 300,
  bound: { kind: 'exact_in', amountIn: A, minOut: floorMin(curveOut(A), 300) }, quotedOut: curveOut(A), quotedIn: null, tokensRaw: null,
  cuLimit: 72_000, cuPriceMicrolamports: 60_000, priorityFeeLamports: 4_320n, networkFeeLamports: 5_000n, rentMinLamports: RENT, rentLamports: RENT,
  maxOutflowLamports: A + 5_000n + 4_320n + RENT, thirdPartyTransfers: [], balanceLamports: 10n * SOL, maxSpendCapLamports: null, wsolPreAmount: null,
  creator: CREATOR, innerFees: [
    { label: 'Pump protocol fee', recipient: FEE_RECIPIENT, address: FEE_RECIPIENT, kind: 'lamports' },
    { label: 'Creator fee', recipient: CREATOR_VAULT, address: CREATOR_VAULT, kind: 'lamports' },
  ], ...over,
});
function pumpBuyCase(): Case {
  const out = curveOut(A);
  const chain = new FakeChain();
  chain.set(FEE_RECIPIENT, sysAcct(5n * SOL)).set(CREATOR_VAULT, sysAcct(SOL));
  chain.deltas.set(OWNER, { lamports: -(A + 5_000n + 4_320n + RENT) });
  chain.deltas.set(tradeAta, { create: { mint: MINT, owner: OWNER }, tokens: out });
  chain.deltas.set(FEE_RECIPIENT, { lamports: 495_000n });
  chain.deltas.set(CREATOR_VAULT, { lamports: 150_000n });
  return {
    payer: OWNER, tables: [], chain, after: undefined,
    ixs: [...CB(), create(), pumpfunIx.buildBuyInstruction(pk(OWNER), pk(MINT), pk(CREATOR), A, floorMin(out, 300), TOKEN, FEES)],
    exp: baseExp({}),
    deps: { rpc: chain, priorityRange: { minPrice: 10_000, maxPrice: 1_000_000 }, maxTxBytes: 1100 },
  };
}
const SELL_HELD = 5_000_000_000n;
function pumpSellCase(): Case {
  const vSol = 30_000_000_000n; const vTok = 1_073_000_000_000_000n;
  const solOut = pumpSellQuote(vSol, vTok, SELL_HELD)!.net;
  const minOut = floorMin(solOut, 300);
  const chain = new FakeChain();
  chain.set(tradeAta, tokenAcct({ mint: MINT, owner: OWNER, amount: SELL_HELD })).set(FEE_RECIPIENT, sysAcct(5n * SOL)).set(CREATOR_VAULT, sysAcct(SOL));
  chain.deltas.set(OWNER, { lamports: solOut - 9_320n });
  chain.deltas.set(tradeAta, { tokens: -SELL_HELD });
  chain.deltas.set(FEE_RECIPIENT, { lamports: 800_000n });
  return {
    payer: OWNER, tables: [], chain,
    ixs: [...CB(), pumpfunIx.buildSellInstruction(pk(OWNER), pk(MINT), pk(CREATOR), SELL_HELD, minOut, false, TOKEN, FEES)],
    exp: baseExp({
      side: 'sell', bound: { kind: 'exact_in', amountIn: SELL_HELD, minOut }, quotedOut: solOut, tokensRaw: SELL_HELD, rentLamports: 0n, maxOutflowLamports: 5_000n + 4_320n,
      innerFees: [{ label: 'Pump protocol fee', recipient: FEE_RECIPIENT, address: FEE_RECIPIENT, kind: 'lamports' }],
    }),
    deps: { rpc: chain, priorityRange: { minPrice: 10_000, maxPrice: 1_000_000 }, maxTxBytes: 1100 },
  };
}
// PumpSwap (the test-only route of the builder; the verifier still checks its IDL positions)
const POOL: pumpswapIx.PoolRefs = { pool: pk(fixtureKey(20)), poolBaseAccount: pk(fixtureKey(10)), poolQuoteAccount: pk(fixtureKey(11)), coinCreator: pk(fixtureKey(12)) };
const POOL_EXP = { pool: fixtureKey(20), poolBaseAccount: fixtureKey(10), poolQuoteAccount: fixtureKey(11), coinCreator: fixtureKey(12) };
const FEE_ATA = pumpswapIx.PUMPSWAP_FEE_RECIPIENT_ATA.toBase58();
const VAULT_ATA = pumpswapIx.deriveAta(pumpswapIx.WSOL_MINT_PK, pumpswapIx.deriveCoinCreatorVaultAuthority(POOL.coinCreator), pumpswapIx.TOKEN_PROGRAM_PK).toBase58();
const SWAP_OUT = 1_700_000_000n;
const SWAP_MAX_IN = (A * 10_300n + 9_999n) / 10_000n;
const wrapIxs = (amount: bigint): TransactionInstruction[] => [
  pumpfunIx.buildCreateAtaIfNeededIx(pk(OWNER), pk(OWNER), pk(WSOL_MINT), TOKEN),
  SystemProgram.transfer({ fromPubkey: pk(OWNER), toPubkey: pk(wsolAta), lamports: amount }),
  new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: pk(wsolAta), isSigner: false, isWritable: true }], data: Buffer.from([17]) }),
];
const closeWsol = (): TransactionInstruction => new TransactionInstruction({
  programId: TOKEN, data: Buffer.from([9]),
  keys: [{ pubkey: pk(wsolAta), isSigner: false, isWritable: true }, { pubkey: pk(OWNER), isSigner: false, isWritable: true }, { pubkey: pk(OWNER), isSigner: true, isWritable: false }],
});
function pumpSwapBuyCase(): Case {
  const chain = new FakeChain();
  chain.deltas.set(OWNER, { lamports: -(A + 5_000n + 4_320n + RENT) });
  chain.deltas.set(tradeAta, { create: { mint: MINT, owner: OWNER }, tokens: SWAP_OUT });
  chain.deltas.set(FEE_ATA, { tokens: 400_000n });
  chain.deltas.set(VAULT_ATA, { tokens: 120_000n });
  chain.set(FEE_ATA, tokenAcct({ mint: WSOL_MINT, owner: fixtureKey(81), amount: 1n })).set(VAULT_ATA, tokenAcct({ mint: WSOL_MINT, owner: fixtureKey(82), amount: 1n }));
  return {
    payer: OWNER, tables: [], chain,
    ixs: [...CB(), ...wrapIxs(SWAP_MAX_IN).slice(0, 1), create(), ...wrapIxs(SWAP_MAX_IN).slice(1), pumpswapIx.buildPumpSwapBuyInstruction(pk(OWNER), pk(MINT), POOL, TOKEN, SWAP_OUT, SWAP_MAX_IN), closeWsol()],
    exp: baseExp({
      route: 'pumpswap', bound: { kind: 'exact_out', exactOut: SWAP_OUT, maxIn: SWAP_MAX_IN }, quotedOut: null, quotedIn: A, creator: undefined, pool: POOL_EXP,
      rentLamports: 2n * RENT, maxOutflowLamports: SWAP_MAX_IN + 5_000n + 4_320n + 2n * RENT,
      innerFees: [{ label: 'PumpSwap protocol fee', recipient: FEE_ATA, address: FEE_ATA, kind: 'token' }, { label: 'Creator fee', recipient: VAULT_ATA, address: VAULT_ATA, kind: 'token' }],
    }),
    deps: { rpc: chain, priorityRange: { minPrice: 10_000, maxPrice: 1_000_000 }, maxTxBytes: 1100 },
  };
}
function pumpSwapSellCase(): Case {
  const held = 3_000_000_000_000n; const minOut = 40_000_000n;
  const chain = new FakeChain();
  chain.set(tradeAta, tokenAcct({ mint: MINT, owner: OWNER, amount: held }));
  chain.deltas.set(OWNER, { lamports: 60_000_000n });
  chain.deltas.set(tradeAta, { tokens: -held });
  return {
    payer: OWNER, tables: [], chain,
    ixs: [...CB(), pumpfunIx.buildCreateAtaIfNeededIx(pk(OWNER), pk(OWNER), pk(WSOL_MINT), TOKEN), pumpswapIx.buildPumpSwapSellInstruction(pk(OWNER), pk(MINT), POOL, TOKEN, held, minOut), closeWsol()],
    exp: baseExp({
      route: 'pumpswap', side: 'sell', bound: { kind: 'exact_in', amountIn: held, minOut }, quotedOut: 41_200_000n, tokensRaw: held, creator: undefined, pool: POOL_EXP,
      rentLamports: RENT, maxOutflowLamports: 5_000n + 4_320n + RENT, innerFees: [],
    }),
    deps: { rpc: chain, priorityRange: { minPrice: 10_000, maxPrice: 1_000_000 }, maxTxBytes: 1100 },
  };
}
// Jupiter, with a lookup table
const TABLE = [fixtureKey(60), fixtureKey(61), fixtureKey(62), fixtureKey(63), fixtureKey(64), fixtureKey(65)];
const QUOTED = 1_650_000_000n;
const SHARED = [193, 32, 155, 51, 65, 214, 156, 129];
const ROUTE = [229, 23, 203, 151, 122, 227, 173, 42];
function jupSwapIx(o: { side?: 'buy' | 'sell'; disc?: number[]; amount?: bigint; quoted?: bigint; slippage?: number; fee?: number; extra?: Array<{ key: string; writable?: boolean }>; user?: string }): TransactionInstruction {
  const buy = (o.side ?? 'buy') === 'buy';
  const tail = Buffer.alloc(19);
  tail.writeBigUInt64LE(o.amount ?? (buy ? A : SELL_HELD), 0); tail.writeBigUInt64LE(o.quoted ?? QUOTED, 8); tail.writeUInt16LE(o.slippage ?? 300, 16); tail[18] = o.fee ?? 0;
  const disc = o.disc ?? SHARED;
  const data = Buffer.concat([Buffer.from(disc), ...(disc === SHARED || disc.join() === SHARED.join() ? [Buffer.from([7])] : []), Buffer.alloc(24, 9), tail]);
  const k = (a: string, s = false, w = false) => ({ pubkey: pk(a), isSigner: s, isWritable: w });
  const user = o.user ?? OWNER;
  const keys = disc.join() === ROUTE.join()
    ? [k(TOKEN_PROGRAM_ID), k(user, true), k(buy ? wsolAta : tradeAta, false, true), k(buy ? tradeAta : wsolAta, false, true), k(JUPITER_V6_PROGRAM_ID), k(buy ? MINT : WSOL_MINT), k(JUPITER_V6_PROGRAM_ID), k(fixtureKey(53)), k(JUPITER_V6_PROGRAM_ID)]
    : [k(TOKEN_PROGRAM_ID), k(fixtureKey(50)), k(user, true), k(buy ? wsolAta : tradeAta, false, true), k(fixtureKey(51), false, true), k(fixtureKey(52), false, true), k(buy ? tradeAta : wsolAta, false, true),
      k(buy ? WSOL_MINT : MINT), k(buy ? MINT : WSOL_MINT), k(JUPITER_V6_PROGRAM_ID), k(TOKEN_2022_PROGRAM_ID), k(fixtureKey(53)), k(JUPITER_V6_PROGRAM_ID)];
  for (const x of TABLE) keys.push(k(x, false, true));
  for (const x of o.extra ?? []) keys.push(k(x.key, false, x.writable ?? true));
  return new TransactionInstruction({ programId: pk(JUPITER_V6_PROGRAM_ID), keys, data });
}
const altObject = (addresses: string[] = TABLE): AddressLookupTableAccount => new AddressLookupTableAccount({
  key: pk(ALT_KEY), state: { deactivationSlot: U64_MAX, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: addresses.map(pk) },
});
function jupiterBuyCase(): Case {
  const chain = new FakeChain();
  chain.set(ALT_KEY, altAcct(TABLE));
  chain.deltas.set(OWNER, { lamports: -(A + 5_000n + 4_320n + RENT) });
  chain.deltas.set(tradeAta, { create: { mint: MINT, owner: OWNER }, tokens: 1_700_000_000n });
  return {
    payer: OWNER, tables: [altObject()], chain,
    ixs: [...CB(), pumpfunIx.buildCreateAtaIfNeededIx(pk(OWNER), pk(OWNER), pk(WSOL_MINT), TOKEN), create(), SystemProgram.transfer({ fromPubkey: pk(OWNER), toPubkey: pk(wsolAta), lamports: A }),
      new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: pk(wsolAta), isSigner: false, isWritable: true }], data: Buffer.from([17]) }), jupSwapIx({}), closeWsol()],
    exp: baseExp({
      route: 'jupiter', quotedOut: QUOTED, bound: { kind: 'exact_in', amountIn: A, minOut: floorMin(QUOTED, 300) }, creator: undefined, innerFees: [],
      rentLamports: 2n * RENT, maxOutflowLamports: A + 5_000n + 4_320n + 2n * RENT, claimedTables: { [ALT_KEY]: TABLE },
    }),
    deps: { rpc: chain, priorityRange: { minPrice: 10_000, maxPrice: 1_000_000 }, maxTxBytes: 1100 },
  };
}

async function run(c: Case): Promise<any> {
  const msg = new TransactionMessage({ payerKey: pk(c.payer), recentBlockhash: fixtureKey(90), instructions: c.ixs });
  const tx = c.legacy ? new VersionedTransaction(msg.compileToLegacyMessage()) : new VersionedTransaction(msg.compileToV0Message(c.tables));
  c.after?.(tx);
  return verifySwapTx(c.deps, tx.serialize(), c.exp);
}
const show = (x: unknown): string => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
const accepted = async (c: Case): Promise<void> => { const r = await run(c); expect(r, show(r)).toMatchObject({ ok: true }); };
/** One change, one refusal: the code, a part of the reason, and no simulation when the refusal is static. */
async function refuses(name: string, make: () => Case, change: (c: Case) => void, code: string, why: RegExp): Promise<void> {
  const c = make();
  change(c);
  const r = await run(c);
  expect(r, name).toMatchObject({ ok: false, code });
  expect(r.reason, name).toMatch(why);
  expect(r.reason.length, name).toBeLessThanOrEqual(200);
}
const tokenIx = (data: number[], keys: Array<[string, boolean, boolean]>): TransactionInstruction => new TransactionInstruction({
  programId: TOKEN, data: Buffer.from(data), keys: keys.map(([a, s, w]) => ({ pubkey: pk(a), isSigner: s, isWritable: w })),
});
const systemIx = (type: number, extra = 0): TransactionInstruction => {
  const d = Buffer.alloc(4 + extra); d.writeUInt32LE(type, 0);
  return new TransactionInstruction({ programId: SystemProgram.programId, data: d, keys: [{ pubkey: pk(OWNER), isSigner: true, isWritable: true }, { pubkey: pk(OTHER), isSigner: false, isWritable: true }] });
};
const replaceAt = <T,>(arr: T[], pred: (x: T) => boolean, make: (x: T) => T): void => { const i = arr.findIndex(pred); if (i < 0) throw new Error('no such instruction'); arr[i] = make(arr[i]); };
const isProgram = (id: string) => (ix: TransactionInstruction): boolean => ix.programId.toBase58() === id;
const withData = (ix: TransactionInstruction, data: Buffer): TransactionInstruction => new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data });

describe('ext-verify: the valid transactions pass', () => {
  it('the pump buy and sell, the PumpSwap buy and sell, and the Jupiter buy are accepted as built', async () => {
    for (const make of [pumpBuyCase, pumpSellCase, pumpSwapBuyCase, pumpSwapSellCase, jupiterBuyCase]) await accepted(make());
    const r = await run(pumpBuyCase());
    expect(r.value).toMatchObject({ unitsConsumed: 60_000, slot: 11, tokenDelta: curveOut(A), maxSpendLamports: A, rentBoundLamports: RENT });
    expect(r.value.innerFees.map((f: { recipient: string; amountBase: bigint }) => [f.recipient, f.amountBase])).toEqual([[FEE_RECIPIENT, 495_000n], [CREATOR_VAULT, 150_000n]]);
    expect(r.value.programs).toEqual([ComputeBudgetProgram.programId.toBase58(), ATA_PROGRAM, PUMP_PROGRAM]);
    expect((await run(jupiterBuyCase())).value.jupiter).toEqual({ inAmount: A, quotedOutAmount: QUOTED, slippageBps: 300, platformFeeBps: 0 });
  });
});

describe('ext-verify: the swap profile refuses', () => {
  it('WTX-T05 a foreign program, a second signer, Approve, SetAuthority, Assign, AdvanceNonce, an undisclosed transfer, a transfer to a lookup-table index, payer other than the owner, an unreadable or deactivated table, a map that differs from the chain, an owner key in a lookup, a CreateIdempotent for a foreign wallet, a trade instruction with a foreign user or mint', async () => {
    await refuses('foreign program', pumpBuyCase, (c) => c.ixs.push(new TransactionInstruction({ programId: pk(fixtureKey(77)), keys: [], data: Buffer.alloc(0) })), 'verify-failed', /program not allowed on the pump route/);
    await refuses('a program of another route', pumpBuyCase, (c) => c.ixs.push(new TransactionInstruction({ programId: pk(JUPITER_V6_PROGRAM_ID), keys: [], data: Buffer.alloc(0) })), 'verify-failed', /program not allowed on the pump route/);
    await refuses('second signer', pumpBuyCase, (c) => c.ixs.push(new TransactionInstruction({ programId: TOKEN, data: Buffer.from([17]), keys: [{ pubkey: pk(OTHER), isSigner: true, isWritable: true }] })), 'verify-failed', /extra signer/);
    await refuses('Approve', pumpBuyCase, (c) => c.ixs.splice(3, 0, tokenIx([4, 1, 0, 0, 0, 0, 0, 0, 0], [[tradeAta, false, true], [OTHER, false, false], [OWNER, true, false]])), 'verify-failed', /token instruction not allowed: Approve/);
    await refuses('SetAuthority', pumpBuyCase, (c) => c.ixs.splice(3, 0, tokenIx([6, 2, 1], [[tradeAta, false, true], [OWNER, true, false]])), 'verify-failed', /token instruction not allowed: SetAuthority/);
    await refuses('Transfer', pumpBuyCase, (c) => c.ixs.splice(3, 0, tokenIx([3, 1, 0, 0, 0, 0, 0, 0, 0], [[tradeAta, false, true], [fixtureKey(88), false, true], [OWNER, true, false]])), 'verify-failed', /token instruction not allowed: Transfer/);
    await refuses('Assign', pumpBuyCase, (c) => c.ixs.splice(3, 0, systemIx(1, 32)), 'verify-failed', /system instruction not allowed: Assign/);
    await refuses('AdvanceNonce', pumpBuyCase, (c) => c.ixs.splice(3, 0, systemIx(4)), 'verify-failed', /system instruction not allowed: AdvanceNonceAccount/);
    await refuses('CreateAccount', pumpBuyCase, (c) => c.ixs.splice(3, 0, systemIx(0, 52)), 'verify-failed', /system instruction not allowed: CreateAccount/);
    await refuses('an undisclosed transfer', pumpBuyCase, (c) => c.ixs.splice(3, 0, SystemProgram.transfer({ fromPubkey: pk(OWNER), toPubkey: pk(OTHER), lamports: 5n })), 'verify-failed', /undisclosed recipient/);
    await refuses('a transfer into the wrapped-SOL account without SyncNative', jupiterBuyCase, (c) => c.ixs.splice(c.ixs.findIndex((x) => x.programId.equals(TOKEN) && x.data[0] === 17), 1), 'verify-failed', /not followed by SyncNative/);
    await refuses('a wSOL transfer to a non-derived account, with its SyncNative', jupiterBuyCase, (c) => {
      replaceAt(c.ixs, isProgram(SYSTEM), () => SystemProgram.transfer({ fromPubkey: pk(OWNER), toPubkey: pk(OTHER), lamports: A }));
      replaceAt(c.ixs, (x) => x.programId.equals(TOKEN) && x.data[0] === 17, () => tokenIx([17], [[OTHER, false, true]]));
    }, 'verify-failed', /undisclosed recipient/);
    await refuses('a wrapped amount above the maximum spend', jupiterBuyCase, (c) => replaceAt(c.ixs, isProgram(SYSTEM), () => SystemProgram.transfer({ fromPubkey: pk(OWNER), toPubkey: pk(wsolAta), lamports: A + 1n })), 'verify-failed', /wrapped amount is above the maximum spend/);
    await refuses('SyncNative of another account', jupiterBuyCase, (c) => replaceAt(c.ixs, (x) => x.programId.equals(TOKEN) && x.data[0] === 17, () => tokenIx([17], [[OTHER, false, true]])), 'verify-failed', /SyncNative of an account other than/);
    await refuses('a transfer to a lookup-table index (Jupiter route)', jupiterBuyCase, (c) => {
      const dest = TABLE[0];
      c.ixs.splice(c.ixs.findIndex(isProgram(SYSTEM)) + 1, 0, SystemProgram.transfer({ fromPubkey: pk(OWNER), toPubkey: pk(dest), lamports: 5n }));
    }, 'owner-key-in-lookup', /lookup-table index/);
    await refuses('payer other than the owner', pumpBuyCase, (c) => {
      c.payer = OTHER;
      for (const ix of c.ixs) for (let i = 0; i < ix.keys.length; i++) if (ix.keys[i].pubkey.toBase58() === OWNER) ix.keys[i] = { ...ix.keys[i], isSigner: false };
    }, 'verify-failed', /fee payer is not the owner/);
    await refuses('a CreateIdempotent for a foreign wallet', pumpBuyCase, (c) => replaceAt(c.ixs, isProgram(ATA_PROGRAM), () => create(OTHER)), 'verify-failed', /CreateIdempotent for a wallet other than the owner/);
    await refuses('a CreateIdempotent for a foreign mint', pumpBuyCase, (c) => replaceAt(c.ixs, isProgram(ATA_PROGRAM), () => create(OWNER, fixtureKey(55))), 'verify-failed', /mint other than the trade mint/);
    await refuses('a CreateIdempotent that is not the idempotent form', pumpBuyCase, (c) => replaceAt(c.ixs, isProgram(ATA_PROGRAM), (x) => withData(x, Buffer.from([0]))), 'verify-failed', /only CreateIdempotent/);
    await refuses('a CloseAccount to another destination', jupiterBuyCase, (c) => replaceAt(c.ixs, (x) => x.programId.equals(TOKEN) && x.data[0] === 9, () => tokenIx([9], [[wsolAta, false, true], [OTHER, false, true], [OWNER, true, false]])), 'verify-failed', /CloseAccount of an account other than the owner wrapped-SOL account, or to another destination/);
    await refuses('a trade instruction with a foreign mint', pumpBuyCase, (c) => replaceAt(c.ixs, isProgram(PUMP_PROGRAM), () => pumpfunIx.buildBuyInstruction(pk(OWNER), pk(fixtureKey(56)), pk(CREATOR), A, floorMin(curveOut(A), 300), TOKEN, FEES)), 'verify-failed', /builder positions/);
    await refuses('a trade instruction with a foreign user', pumpBuyCase, (c) => replaceAt(c.ixs, isProgram(PUMP_PROGRAM), (x) => {
      const keys = x.keys.map((k, i) => (i === 6 ? { pubkey: pk(OTHER), isSigner: false, isWritable: true } : k));
      return new TransactionInstruction({ programId: x.programId, keys, data: x.data });
    }), 'verify-failed', /builder positions/);
    await refuses('a trade instruction naming another creator vault', pumpBuyCase, (c) => { c.exp.creator = OTHER; }, 'verify-failed', /builder positions/);
    await refuses('two trade instructions', pumpBuyCase, (c) => c.ixs.push(c.ixs[3]), 'verify-failed', /more than one trade instruction/);
    await refuses('no trade instruction', pumpBuyCase, (c) => c.ixs.splice(3, 1), 'verify-failed', /no trade instruction/);
    await refuses('a legacy message', pumpBuyCase, (c) => { c.legacy = true; }, 'verify-failed', /only version 0/);
    await refuses('a signature slot that is not zero', pumpBuyCase, (c) => { c.after = (tx) => { tx.signatures[0] = Uint8Array.from({ length: 64 }, (_, i) => (i === 7 ? 1 : 0)); }; }, 'verify-failed', /not all zero/);
    await refuses('a message over the size cap', pumpBuyCase, (c) => { c.deps.maxTxBytes = 300; }, 'tx-too-large', /byte cap/);
    await refuses('the Jupiter swap with a foreign user transfer authority', jupiterBuyCase, (c) => replaceAt(c.ixs, isProgram(JUPITER_V6_PROGRAM_ID), () => jupSwapIx({ user: OTHER })), 'verify-failed', /extra signer|other than the owner/);

    // lookup tables (design 7.4 S6): read from the chain; a lookup on a route other than Jupiter; an unreadable, deactivated or foreign table
    await refuses('a lookup table on the pump route', pumpBuyCase, (c) => { c.tables = [altObject([CREATOR_VAULT, fixtureKey(98)])]; }, 'verify-failed', /Jupiter route only/);
    await refuses('an unreadable table', jupiterBuyCase, (c) => { c.chain.set(ALT_KEY, null); }, 'verify-failed', /lookup table/);
    await refuses('a deactivated table', jupiterBuyCase, (c) => { c.chain.set(ALT_KEY, altAcct(TABLE, 12_345n)); }, 'verify-failed', /deactivated/);
    await refuses('a table owned by another program', jupiterBuyCase, (c) => { c.chain.set(ALT_KEY, altAcct(TABLE, U64_MAX, SYSTEM)); }, 'verify-failed', /lookup-table program/);
    await refuses('a Jupiter map that differs from the chain table', jupiterBuyCase, (c) => { c.exp.claimedTables = { [ALT_KEY]: [TABLE[1], TABLE[0], ...TABLE.slice(2)] }; }, 'alt-mismatch', /differs from the one the route claimed/);
    await refuses('a table the route did not claim', jupiterBuyCase, (c) => { c.exp.claimedTables = {}; }, 'alt-mismatch', /differs/);
    await refuses('a message that uses a table when none was claimed', jupiterBuyCase, (c) => { c.exp.claimedTables = null; }, 'alt-mismatch', /claimed no lookup table/);
    await refuses('the trade account sits only in a lookup table', jupiterBuyCase, (c) => {
      c.tables = [altObject([...TABLE, tradeAta])];
      c.chain.set(ALT_KEY, altAcct([...TABLE, tradeAta]));
      c.exp.claimedTables = { [ALT_KEY]: [...TABLE, tradeAta] };
    }, 'owner-key-in-lookup', /owner key sits in a lookup table/);
    await refuses('the owner wrapped-SOL account sits only in a lookup table', jupiterBuyCase, (c) => {
      c.tables = [altObject([...TABLE, wsolAta])];
      c.chain.set(ALT_KEY, altAcct([...TABLE, wsolAta]));
      c.exp.claimedTables = { [ALT_KEY]: [...TABLE, wsolAta] };
    }, 'owner-key-in-lookup', /owner key sits in a lookup table/);
    // an RPC that fails while the tables are read is a refusal, not a pass
    const down = jupiterBuyCase();
    down.deps = { ...down.deps, rpc: { call: async () => { throw new Error('rpc down'); } } };
    expect(await run(down)).toMatchObject({ ok: false });

    // S4: a wrapped-SOL account that holds a balance and a route that wraps it
    await refuses('wSOL balance present (Jupiter)', jupiterBuyCase, (c) => { c.exp.wsolPreAmount = 1n; }, 'wsol-balance-present', /Unwrap your wSOL first/);
    await refuses('wSOL balance present (PumpSwap)', pumpSwapBuyCase, (c) => { c.exp.wsolPreAmount = 7_000n; }, 'wsol-balance-present', /Unwrap your wSOL first/);
    await accepted((() => { const c = pumpBuyCase(); c.exp.wsolPreAmount = 7_000n; return c; })());       // the pump route never touches that account
  });

  it('FIXPUMP-EV-T01 the 2026-04-28 pump layout: a buy of 24 bytes or with track_volume 00, a fee recipient off the NORMAL list, a buyback recipient off the BUYBACK list, and the old 16-account buy are refused', async () => {
    const pumpIdx = (c: Case): number => c.ixs.findIndex(isProgram(PUMP_PROGRAM));
    await refuses('a 24-byte buy (no track_volume)', pumpBuyCase, (c) => { const i = pumpIdx(c); c.ixs[i] = withData(c.ixs[i], c.ixs[i].data.subarray(0, 24)); }, 'verify-failed', /not buy_exact_sol_in or sell/);
    await refuses('track_volume 00', pumpBuyCase, (c) => { const i = pumpIdx(c); const d = Buffer.from(c.ixs[i].data); d[24] = 0; c.ixs[i] = withData(c.ixs[i], d); }, 'verify-failed', /track_volume is not 01/);
    const withKeyAt = (k: number, key: string) => (c: Case): void => {
      const i = pumpIdx(c);
      const ix = c.ixs[i];
      const at = k < 0 ? ix.keys.length + k : k;
      c.ixs[i] = new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: ix.keys.map((x, j) => (j === at ? { ...x, pubkey: pk(key) } : x)) });
    };
    await refuses('a fee recipient off the NORMAL list (a RESERVED one)', pumpBuyCase, withKeyAt(1, 'GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS'), 'verify-failed', /fee recipient is not in the NORMAL list/);
    await refuses('a buyback recipient off the BUYBACK list', pumpBuyCase, withKeyAt(-1, FEE_RECIPIENT), 'verify-failed', /buyback fee recipient is not in the BUYBACK list/);
    await refuses('a sell whose buyback recipient is off the list', pumpSellCase, withKeyAt(-1, OTHER), 'verify-failed', /buyback fee recipient is not in the BUYBACK list/);
    await refuses('the old 16-account buy (no bonding_curve_v2, no buyback recipient)', pumpBuyCase, (c) => {
      const i = pumpIdx(c);
      const ix = c.ixs[i];
      c.ixs[i] = new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: ix.keys.slice(0, 16) });
    }, 'verify-failed', /BUYBACK list|builder positions/);
    // another member of each list is accepted (the builder picks one at random)
    await accepted((() => {
      const c = pumpBuyCase();
      withKeyAt(1, PUMP_FEE_RECIPIENTS_NORMAL[5])(c);
      withKeyAt(-1, PUMP_BUYBACK_FEE_RECIPIENTS[7])(c);
      c.exp.innerFees = c.exp.innerFees.filter((f) => f.recipient !== FEE_RECIPIENT);   // the disclosed fee lines name the accounts the build chose
      return c;
    })());
  });

  it('WTX-T05b compute budget: two limit instructions, a RequestHeapFrame, a limit above 400 000, a price outside [MIN, MAX], a committed fee other than the disclosed line', async () => {
    const withCb = (cb: TransactionInstruction[]) => (c: Case): void => { c.ixs.splice(0, 2, ...cb); };
    await refuses('two limits', pumpBuyCase, withCb([setCuLimitInstruction(72_000), setCuLimitInstruction(72_000), setCuPriceInstruction(60_000)]), 'verify-failed', /more than one SetComputeUnitLimit/);
    await refuses('two prices', pumpBuyCase, withCb([setCuLimitInstruction(72_000), setCuPriceInstruction(60_000), setCuPriceInstruction(60_000)]), 'verify-failed', /more than one SetComputeUnitPrice/);
    await refuses('a RequestHeapFrame', pumpBuyCase, withCb([setCuLimitInstruction(72_000), setCuPriceInstruction(60_000), ComputeBudgetProgram.requestHeapFrame({ bytes: 65_536 })]), 'verify-failed', /RequestHeapFrame/);
    await refuses('a loaded-accounts limit', pumpBuyCase, withCb([setCuLimitInstruction(72_000), setCuPriceInstruction(60_000), new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from([4, 64, 66, 15, 0]) })]), 'verify-failed', /SetLoadedAccountsDataSizeLimit/);
    await refuses('a limit above 400 000', pumpBuyCase, withCb(CB(400_001, 60_000)), 'verify-failed', /outside 1\.\.400000/);
    await refuses('a price above the maximum', pumpBuyCase, withCb(CB(72_000, 1_000_001)), 'verify-failed', /outside 10000\.\.1000000/);
    await refuses('a price below the minimum', pumpBuyCase, withCb(CB(72_000, 9_999)), 'verify-failed', /outside 10000\.\.1000000/);
    await refuses('no limit', pumpBuyCase, withCb([setCuPriceInstruction(60_000)]), 'verify-failed', /no SetComputeUnitLimit/);
    await refuses('no price', pumpBuyCase, withCb([setCuLimitInstruction(72_000)]), 'verify-failed', /no SetComputeUnitPrice/);
    await refuses('a committed fee other than the disclosed line', pumpBuyCase, (c) => { c.exp.priorityFeeLamports = 4_321n; }, 'verify-failed', /differs from the disclosed priority-fee line/);
    await refuses('a limit other than the disclosed one', pumpBuyCase, (c) => { c.exp.cuLimit = 72_001; }, 'verify-failed', /differs from the disclosed priority-fee line/);
    await refuses('a price other than the disclosed one', pumpBuyCase, (c) => { c.exp.cuPriceMicrolamports = 60_001; }, 'verify-failed', /differs from the disclosed priority-fee line/);
    // the range is the injected one
    const tight = pumpBuyCase();
    tight.deps = { ...tight.deps, priorityRange: { minPrice: 70_000, maxPrice: 80_000 } };
    expect(await run(tight)).toMatchObject({ ok: false, reason: expect.stringContaining('outside 70000..80000') });
  });

  it('WTX-T05c bound: arguments other than the disclosed bound, a minimum below the quote minus the slippage, a slippage above the cap, a Jupiter platform fee of 1, an unpinned Jupiter discriminator', async () => {
    const out = curveOut(A);
    // pump: min_tokens_out (buy) and min_sol_output (sell) differ from the disclosed bound
    await refuses('pump min_tokens_out', pumpBuyCase, (c) => { (c.exp.bound as { minOut: bigint }).minOut += 1n; }, 'verify-failed', /pump buy arguments differ from the disclosed bound/);
    await refuses('pump spendable_sol_in', pumpBuyCase, (c) => { (c.exp.bound as { amountIn: bigint }).amountIn += 1n; }, 'verify-failed', /pump buy arguments differ/);
    await refuses('pump min_sol_output', pumpSellCase, (c) => { (c.exp.bound as { minOut: bigint }).minOut -= 1n; }, 'verify-failed', /pump sell arguments differ from the disclosed bound/);
    await refuses('pump sell amount', pumpSellCase, (c) => { (c.exp.bound as { amountIn: bigint }).amountIn -= 1n; }, 'verify-failed', /pump sell arguments differ/);
    // PumpSwap: base_amount_out / max_quote_amount_in (buy), base_amount_in / min_quote_amount_out (sell)
    await refuses('PumpSwap max_quote_amount_in', pumpSwapBuyCase, (c) => { (c.exp.bound as { maxIn: bigint }).maxIn -= 1n; }, 'verify-failed', /PumpSwap buy arguments differ from the disclosed bound/);
    await refuses('PumpSwap base_amount_out', pumpSwapBuyCase, (c) => { (c.exp.bound as { exactOut: bigint }).exactOut += 1n; }, 'verify-failed', /PumpSwap buy arguments differ/);
    await refuses('PumpSwap min_quote_amount_out', pumpSwapSellCase, (c) => { (c.exp.bound as { minOut: bigint }).minOut += 1n; }, 'verify-failed', /PumpSwap sell arguments differ from the disclosed bound/);
    await refuses('PumpSwap accounts off the IDL positions', pumpSwapBuyCase, (c) => { c.exp.pool = { ...POOL_EXP, poolBaseAccount: fixtureKey(99) }; }, 'verify-failed', /PumpSwap buy accounts differ from the IDL positions/);
    // minOut below quotedOut x (1 - slippage), arguments consistent with the disclosed (too low) bound
    const low = floorMin(out, 300) - 1n;
    await refuses('a minimum below the quote minus the slippage', pumpBuyCase, (c) => {
      replaceAt(c.ixs, isProgram(PUMP_PROGRAM), () => pumpfunIx.buildBuyInstruction(pk(OWNER), pk(MINT), pk(CREATOR), A, low, TOKEN, FEES));
      (c.exp.bound as { minOut: bigint }).minOut = low;
    }, 'verify-failed', /minimum output is below the quote minus the slippage/);
    await refuses('a maximum input above the quote plus the slippage (exact-out)', pumpSwapBuyCase, (c) => {
      const high = (A * 10_300n + 9_999n) / 10_000n + 1n;
      replaceAt(c.ixs, isProgram(PUMPSWAP), () => pumpswapIx.buildPumpSwapBuyInstruction(pk(OWNER), pk(MINT), POOL, TOKEN, SWAP_OUT, high));
      (c.exp.bound as { maxIn: bigint }).maxIn = high;
    }, 'verify-failed', /maximum input is above the quote plus the slippage/);
    // the rule is exactly the boundary: the floor itself passes
    await accepted(pumpBuyCase());
    // slippage above the cap, or zero
    await refuses('slippage 5001', pumpBuyCase, (c) => { c.exp.slippageBps = 5001; }, 'verify-failed', /slippage outside 1\.\.5000/);
    await refuses('slippage 0', pumpBuyCase, (c) => { c.exp.slippageBps = 0; }, 'verify-failed', /slippage outside/);
    // Jupiter: the platform fee, an unpinned discriminator, the slippage, the amount and the quote
    await refuses('Jupiter platform_fee_bps 1', jupiterBuyCase, (c) => replaceAt(c.ixs, isProgram(JUPITER_V6_PROGRAM_ID), () => jupSwapIx({ fee: 1 })), 'verify-failed', /platform fee is not zero/);
    for (const [name, disc] of [['exact_out_route', [208, 51, 239, 151, 123, 43, 237, 92]], ['shared_accounts_exact_out_route', [176, 209, 105, 168, 154, 125, 69, 62]], ['route_with_token_ledger', [150, 86, 71, 116, 167, 93, 14, 104]], ['unknown', [1, 2, 3, 4, 5, 6, 7, 8]]] as const) {
      await refuses(`Jupiter ${name}`, jupiterBuyCase, (c) => replaceAt(c.ixs, isProgram(JUPITER_V6_PROGRAM_ID), () => jupSwapIx({ disc: [...disc] })), 'verify-failed', /not a pinned exact-in route/);
    }
    await refuses('Jupiter slippage above the request', jupiterBuyCase, (c) => replaceAt(c.ixs, isProgram(JUPITER_V6_PROGRAM_ID), () => jupSwapIx({ slippage: 301 })), 'verify-failed', /slippage differs/);
    await refuses('Jupiter in_amount other than the disclosed', jupiterBuyCase, (c) => replaceAt(c.ixs, isProgram(JUPITER_V6_PROGRAM_ID), () => jupSwapIx({ amount: A + 1n })), 'verify-failed', /in_amount differs/);
    await refuses('Jupiter quoted_out other than the disclosed', jupiterBuyCase, (c) => replaceAt(c.ixs, isProgram(JUPITER_V6_PROGRAM_ID), () => jupSwapIx({ quoted: QUOTED + 1n })), 'verify-failed', /quoted_out_amount differs/);
    // the `route` variant is accepted with its own positions
    const viaRoute = jupiterBuyCase();
    replaceAt(viaRoute.ixs, isProgram(JUPITER_V6_PROGRAM_ID), () => jupSwapIx({ disc: ROUTE }));
    await accepted(viaRoute);
  });

  it('WTX-T05d simulation: an output 1 unit below the minimum, an outflow above the maximum, and a change to another token account of the owner (amount, delegate, close authority) inside the CPI are refused', async () => {
    const out = curveOut(A);
    const min = floorMin(out, 300);
    // output
    await refuses('1 unit below the minimum', pumpBuyCase, (c) => c.chain.deltas.set(tradeAta, { create: { mint: MINT, owner: OWNER }, tokens: min - 1n }), 'simulation-failed', /below the minimum/);
    await accepted((() => { const c = pumpBuyCase(); c.chain.deltas.set(tradeAta, { create: { mint: MINT, owner: OWNER }, tokens: min }); return c; })());   // exactly the minimum passes
    await refuses('no tokens at all', pumpBuyCase, (c) => c.chain.deltas.set(tradeAta, { create: { mint: MINT, owner: OWNER }, tokens: 0n }), 'simulation-failed', /below the minimum/);
    await refuses('the exact output of an exact-out buy, one more', pumpSwapBuyCase, (c) => c.chain.deltas.set(tradeAta, { create: { mint: MINT, owner: OWNER }, tokens: SWAP_OUT + 1n }), 'simulation-failed', /not the exact output/);
    await refuses('the exact output of an exact-out buy, one less', pumpSwapBuyCase, (c) => c.chain.deltas.set(tradeAta, { create: { mint: MINT, owner: OWNER }, tokens: SWAP_OUT - 1n }), 'simulation-failed', /not the exact output/);
    // sell: SOL received below the minimum, and a token decrease other than the amount sold
    const sell = pumpSellCase();
    const need = (sell.exp.bound as { minOut: bigint }).minOut;
    await refuses('a sell 1 unit below the minimum', pumpSellCase, (c) => c.chain.deltas.set(OWNER, { lamports: need - 9_320n - 1n }), 'simulation-failed', /below the minimum/);
    await accepted((() => { const c = pumpSellCase(); c.chain.deltas.set(OWNER, { lamports: need - 9_320n }); return c; })());
    await refuses('a sell that leaves tokens behind', pumpSellCase, (c) => c.chain.deltas.set(tradeAta, { tokens: -(SELL_HELD - 1n) }), 'simulation-failed', /not the amount sold/);
    // outflow
    const max = pumpBuyCase().exp.maxOutflowLamports;
    await refuses('an outflow above the maximum', pumpBuyCase, (c) => c.chain.deltas.set(OWNER, { lamports: -(max + 1n) }), 'simulation-failed', /simulated outflow .* above the maximum/);
    await accepted((() => { const c = pumpBuyCase(); c.chain.deltas.set(OWNER, { lamports: -max }); return c; })());      // exactly the maximum passes
    // the simulation itself fails
    await refuses('a simulation error', pumpBuyCase, (c) => { c.chain.err = { InstructionError: [3, { Custom: 6999 }] }; }, 'simulation-failed', /simulation failed/);
    await refuses('a pinned slippage error', pumpBuyCase, (c) => { c.chain.err = { InstructionError: [3, { Custom: 6002 }] }; }, 'price-moved', /price moved/);
    // other token accounts of the owner, in the CPI of the Jupiter swap (a writable account the route passes along)
    const withVictim = (delta: Delta, pre?: Partial<TokenOpts>) => (c: Case): void => {
      const victim = fixtureKey(90 + 5);
      replaceAt(c.ixs, isProgram(JUPITER_V6_PROGRAM_ID), () => jupSwapIx({ extra: [{ key: victim }] }));
      c.chain.set(victim, tokenAcct({ mint: fixtureKey(57), owner: OWNER, amount: 1_000n, ...pre }));
      c.chain.deltas.set(victim, delta);
    };
    await refuses('amount of another token account', jupiterBuyCase, withVictim({ tokens: -1n }), 'verify-failed', /changed its amount/);
    await refuses('amount raised on another token account', jupiterBuyCase, withVictim({ tokens: 5n }), 'verify-failed', /changed its amount/);
    await refuses('delegate on another token account', jupiterBuyCase, withVictim({ delegate: OTHER }), 'verify-failed', /delegate, close authority or state/);
    await refuses('close authority on another token account', jupiterBuyCase, withVictim({ closeAuthority: OTHER }), 'verify-failed', /delegate, close authority or state/);
    await refuses('another token account closed', jupiterBuyCase, withVictim({ close: true }), 'verify-failed', /changed owner or was removed/);
    await refuses('another token account handed to a new owner', jupiterBuyCase, withVictim({ ownerTo: OTHER }), 'verify-failed', /changed owner or was removed/);
    await accepted((() => { const c = jupiterBuyCase(); withVictim({})(c); return c; })());                                  // an untouched account of the owner is fine
    // a new account of the owner that the transaction does not disclose
    await refuses('an undisclosed new token account of the owner', jupiterBuyCase, (c) => {
      const extra = fixtureKey(96);
      replaceAt(c.ixs, isProgram(JUPITER_V6_PROGRAM_ID), () => jupSwapIx({ extra: [{ key: extra }] }));
      c.chain.deltas.set(extra, { create: { mint: fixtureKey(57), owner: OWNER } });
    }, 'verify-failed', /creates a token account for the owner that it does not disclose/);
    // the trade account and the wrapped-SOL account may change their amount, but never gain a delegate or a close authority
    await refuses('a delegate on the trade account', pumpBuyCase, (c) => c.chain.deltas.set(tradeAta, { create: { mint: MINT, owner: OWNER }, tokens: out, delegate: OTHER }), 'verify-failed', /carries a delegate or a close authority/);
    await refuses('a close authority on the trade account', pumpBuyCase, (c) => c.chain.deltas.set(tradeAta, { create: { mint: MINT, owner: OWNER }, tokens: out, closeAuthority: OTHER }), 'verify-failed', /carries a delegate or a close authority/);
    await refuses('a delegate added to an existing trade account', pumpSellCase, (c) => c.chain.deltas.set(tradeAta, { tokens: -SELL_HELD, delegate: OTHER }), 'verify-failed', /delegate, close authority or state/);
    // the inner fee accounts are measured and never negative
    await refuses('a fee account that decreases', pumpBuyCase, (c) => c.chain.deltas.set(FEE_RECIPIENT, { lamports: -1n }), 'verify-failed', /fee account decreased/);
    // the balance and the cap are checked on the same bytes
    await refuses('balance below the maximum outflow', pumpBuyCase, (c) => { c.exp.balanceLamports = c.exp.maxOutflowLamports - 1n; }, 'insufficient-sol', /above the wallet balance/);
    const poor = pumpBuyCase();
    poor.exp.balanceLamports = poor.exp.maxOutflowLamports - 1n;
    expect(await run(poor)).toMatchObject({ needLamports: poor.exp.maxOutflowLamports.toString(), haveLamports: (poor.exp.maxOutflowLamports - 1n).toString() });
    await refuses('maximum spend above the cap', pumpBuyCase, (c) => { c.exp.maxSpendCapLamports = A - 1n; }, 'amount-above-cap', /above the configured cap/);
    await accepted((() => { const c = pumpBuyCase(); c.exp.maxSpendCapLamports = A; return c; })());
    await refuses('disclosed outflow lines that differ from the bytes', pumpBuyCase, (c) => { c.exp.maxOutflowLamports += 1n; }, 'verify-failed', /disclosed outflow lines differ/);
    await refuses('a disclosed rent that differs from the bytes', pumpBuyCase, (c) => { c.exp.rentLamports = 0n; }, 'verify-failed', /disclosed outflow lines differ/);
    await refuses('a disclosed third-party transfer that is not in the bytes', pumpBuyCase, (c) => { c.exp.thirdPartyTransfers = [{ recipient: OTHER, lamports: 5n }]; }, 'verify-failed', /disclosed third-party transfer is missing/);
    // a disclosed third-party transfer with the exact amount is allowed when it is in the bytes
    const paid = pumpBuyCase();
    paid.ixs.splice(3, 0, SystemProgram.transfer({ fromPubkey: pk(OWNER), toPubkey: pk(OTHER), lamports: 5n }));
    paid.exp.thirdPartyTransfers = [{ recipient: OTHER, lamports: 5n }];
    await accepted(paid);
    const wrong = pumpBuyCase();
    wrong.ixs.splice(3, 0, SystemProgram.transfer({ fromPubkey: pk(OWNER), toPubkey: pk(OTHER), lamports: 6n }));
    wrong.exp.thirdPartyTransfers = [{ recipient: OTHER, lamports: 5n }];
    expect(await run(wrong)).toMatchObject({ ok: false, reason: expect.stringContaining('undisclosed recipient') });
  });
});
