/**
 * R7-W5 unsigned-swap.ts: the unsigned swap for an external payer, end to end against a scripted chain (a fake RPC with simulateTransaction post
 * states, getMultipleAccounts, lookup-table accounts, a priority-fee estimator) and a mock Jupiter on 127.0.0.1:0. No network, no signing.
 * Every address derives at test time (A-20): fixtureKey(i) = base58 of sha256("ps-fixture-" + i).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import bs58 from 'bs58';
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeBudgetFeeLamports } from './compute-budget';
import { PUMP_PROGRAM, verifySwapTx, type SwapExpectation } from './ext-verify';
import { jupBuildOnce } from './jupiter-ix';
import * as pumpfunIx from './pumpfun-ix';
import { PUMP_BUYBACK_FEE_RECIPIENTS, PUMP_FEE_RECIPIENTS_NORMAL, pumpBuyQuote, pumpSellQuote } from './pump-program';
import * as pumpswapIx from './pumpswap-ix';
import * as pumpswapSwap from './pumpswap-swap';
import { RpcBudgetError } from './rpc-budget';
import { PUMPPORTAL_FEE_ACCOUNTS } from './tx-verify';
import { buildUnsignedSwap, createWalletBuildCache, DEFAULT_PRIORITY_MAX_MICROLAMPORTS, DEFAULT_PRIORITY_MIN_MICROLAMPORTS, type UnsignedSwapDeps } from './unsigned-swap';
import { deriveAtaAddress, parseSplTokenAccount, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from './wallet-reads';
import type { WalletRpcPort } from './wallet-rpc';
import type { WalletQuoteLink, WalletQuoteOk, WalletQuoteRequest } from '../shared/contract/wallet-link';
import { validateWalletQuoteResponse } from '../shared/contract/wallet-validate';
import { CONFIG } from '../config';

// ── ids ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const fixtureKey = (i: number): string => bs58.encode(createHash('sha256').update('ps-fixture-' + i).digest());
const pk = (s: string): PublicKey => new PublicKey(s);
const OWNER = fixtureKey(1);
const MINT_C = fixtureKey(31);     // classic Token mint on an open pump curve
const MINT_G = fixtureKey(32);     // classic Token mint that graduated (PumpSwap pool)
const MINT_22 = fixtureKey(33);    // Token-2022 mint on an open pump curve
const MINT_PLAIN = fixtureKey(34); // classic Token mint with no pump curve at all
const CREATOR = fixtureKey(3);
const POOL_BASE = fixtureKey(10);
const POOL_QUOTE = fixtureKey(11);
const POOL_CREATOR = fixtureKey(12);
const ALT_KEY = fixtureKey(45);
const SYSTEM = SystemProgram.programId.toBase58();
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
const U64_MAX = 18446744073709551615n;
const SOL = 1_000_000_000n;
const RENT = 2_039_280n;
const A = 50_000_000n;             // 0.05 SOL

// ── accounts as bytes ───────────────────────────────────────────────────────────────────────────────────────────────────────────
interface Acct { lamports: bigint; owner: string; data: Buffer }
const sysAcct = (lamports: bigint): Acct => ({ lamports, owner: SYSTEM, data: Buffer.alloc(0) });
interface TokenOpts { mint: string; owner: string; amount: bigint; program?: string; delegate?: string; closeAuthority?: string; state?: number; lamports?: bigint }
function tokenAcct(o: TokenOpts): Acct {
  const d = Buffer.alloc(165);
  Buffer.from(bs58.decode(o.mint)).copy(d, 0);
  Buffer.from(bs58.decode(o.owner)).copy(d, 32);
  d.writeBigUInt64LE(o.amount, 64);
  if (o.delegate) { d.writeUInt32LE(1, 72); Buffer.from(bs58.decode(o.delegate)).copy(d, 76); }
  d[108] = o.state ?? 1;
  if (o.closeAuthority) { d.writeUInt32LE(1, 129); Buffer.from(bs58.decode(o.closeAuthority)).copy(d, 133); }
  return { lamports: o.lamports ?? RENT, owner: o.program ?? TOKEN_PROGRAM_ID, data: d };
}
function mintAcct(program: string, decimals = 6): Acct {
  const d = Buffer.alloc(82);
  d.writeBigUInt64LE(1_000_000_000_000_000n, 36); d[44] = decimals; d[45] = 1;
  return { lamports: 1_461_600n, owner: program, data: d };
}
function curveAcct(o: { complete?: boolean; mayhem?: boolean; vSol?: bigint; vTok?: bigint } = {}): Acct {
  const d = Buffer.alloc(151);
  pumpfunCurveDisc().copy(d, 0);
  d.writeBigUInt64LE(o.vTok ?? 1_073_000_000_000_000n, 8);
  d.writeBigUInt64LE(o.vSol ?? 30_000_000_000n, 16);
  d.writeBigUInt64LE(793_100_000_000_000n, 24);
  d.writeBigUInt64LE(0n, 32);
  d.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  d[48] = o.complete ? 1 : 0;
  Buffer.from(bs58.decode(CREATOR)).copy(d, 49);
  d[81] = o.mayhem ? 1 : 0;
  return { lamports: 2_000_000_000n, owner: PUMP_PROGRAM, data: d };
}
function pumpfunCurveDisc(): Buffer { return createHash('sha256').update('account:BondingCurve').digest().subarray(0, 8); }
function poolAcct(): Acct {
  const d = Buffer.alloc(300);
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(d, 0);
  Buffer.from(bs58.decode(MINT_G)).copy(d, 43);
  Buffer.from(bs58.decode(WSOL_MINT)).copy(d, 75);
  Buffer.from(bs58.decode(POOL_BASE)).copy(d, 139);
  Buffer.from(bs58.decode(POOL_QUOTE)).copy(d, 171);
  Buffer.from(bs58.decode(POOL_CREATOR)).copy(d, 211);
  return { lamports: 3_000_000_000n, owner: PUMPSWAP, data: d };
}
/** An address-lookup-table account: the 56 byte meta header (type 1, deactivation slot, authority none) and the addresses. */
function altAcct(addresses: string[], deactivationSlot = U64_MAX): Acct {
  const d = Buffer.alloc(56 + addresses.length * 32);
  d.writeUInt32LE(1, 0);
  d.writeBigUInt64LE(deactivationSlot, 4);
  addresses.forEach((a, i) => Buffer.from(bs58.decode(a)).copy(d, 56 + i * 32));
  return { lamports: 1_000_000_000n, owner: ALT_PROGRAM, data: d };
}
const rpcAccount = (a: Acct | null): unknown => (a === null ? null : {
  lamports: a.lamports > BigInt(Number.MAX_SAFE_INTEGER) ? a.lamports.toString() : Number(a.lamports), owner: a.owner, data: [a.data.toString('base64'), 'base64'], executable: false, rentEpoch: 0, space: a.data.length,
});

// ── the scripted chain ──────────────────────────────────────────────────────────────────────────────────────────────────────────
interface Delta { lamports?: bigint; tokens?: bigint; create?: { mint: string; owner: string; program?: string }; close?: boolean; delegate?: string; closeAuthority?: string }
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
  return out;
}

class FakeChain implements WalletRpcPort {
  accounts = new Map<string, Acct | null>();
  balance = 10n * SOL;
  slot = 1000;
  rentMin: number | Error = 2_039_280;
  /** the priority estimate; an Error makes the estimator fail, null makes it answer nothing usable */
  priority: number | Error | null = 60_000;
  blockhash = fixtureKey(90);
  units = 60_000;
  deltas = new Map<string, Delta>();
  /** the error the simulation WITH accounts returns (the final one), or a function of the transaction */
  finalErr: unknown | ((tx: VersionedTransaction) => unknown) = null;
  /** the error the measuring simulation (no accounts) returns */
  measureErr: unknown = null;
  calls: Array<{ method: string; params: any[] }> = [];
  sims: Array<{ tx: VersionedTransaction; withAccounts: boolean }> = [];

  set(addr: string, a: Acct | null): this { this.accounts.set(addr, a); return this; }
  /** The state before the transaction: what was set, and the owner's wallet holding `balance`. */
  pre(addr: string): Acct | null { return this.accounts.has(addr) ? this.accounts.get(addr)! : addr === OWNER ? sysAcct(this.balance) : null; }
  count(method: string): number { return this.calls.filter((c) => c.method === method).length; }

  async call(method: string, params: unknown[]): Promise<any> {
    const p = params as any[];
    this.calls.push({ method, params: p });
    switch (method) {
      case 'getBalance': return { context: { slot: this.slot }, value: Number(this.balance) };
      case 'getMultipleAccounts': return { context: { slot: this.slot }, value: (p[0] as string[]).map((k) => rpcAccount(this.pre(k))) };
      case 'getMinimumBalanceForRentExemption': if (this.rentMin instanceof Error) throw this.rentMin; return this.rentMin;
      case 'getPriorityFeeEstimate':
        if (this.priority instanceof Error) throw this.priority;
        return this.priority === null ? {} : { priorityFeeEstimate: this.priority };
      case 'getLatestBlockhash': return { context: { slot: this.slot }, value: { blockhash: this.blockhash, lastValidBlockHeight: 5000 } };
      case 'simulateTransaction': {
        const tx = VersionedTransaction.deserialize(Buffer.from(p[0], 'base64'));
        const addresses: string[] | undefined = p[1].accounts?.addresses;
        this.sims.push({ tx, withAccounts: addresses !== undefined });
        const err = addresses === undefined ? this.measureErr : typeof this.finalErr === 'function' ? this.finalErr(tx) : this.finalErr;
        const accounts = addresses === undefined || err ? null : addresses.map((a) => rpcAccount(applyDelta(this.pre(a), this.deltas.get(a))));
        return { context: { slot: this.slot + 1 }, value: { err, logs: [], accounts, unitsConsumed: this.units, returnData: null } };
      }
      default: throw new Error(`unexpected RPC method ${method}`);
    }
  }
}

/** FIX-PUMP: the pump route picks its fee and buyback recipients with Math.random (pinned to 0 below): NORMAL[0] and BUYBACK[0]. */
const PUMP_FEE = PUMP_FEE_RECIPIENTS_NORMAL[0];
const PUMP_BUYBACK = PUMP_BUYBACK_FEE_RECIPIENTS[0];
beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0); });
afterEach(() => { vi.restoreAllMocks(); });

/** A chain where `owner` holds SOL and the mints and curves below exist. */
function chainWorld(): FakeChain {
  const c = new FakeChain();
  c.set(MINT_C, mintAcct(TOKEN_PROGRAM_ID)).set(MINT_G, mintAcct(TOKEN_PROGRAM_ID)).set(MINT_22, mintAcct(TOKEN_2022_PROGRAM_ID)).set(MINT_PLAIN, mintAcct(TOKEN_PROGRAM_ID, 9));
  c.set(pumpfunIx.deriveBondingCurve(pk(MINT_C)).toBase58(), curveAcct());
  c.set(pumpfunIx.deriveBondingCurve(pk(MINT_22)).toBase58(), curveAcct());
  c.set(pumpfunIx.deriveBondingCurve(pk(MINT_G)).toBase58(), curveAcct({ complete: true }));
  c.set(PUMP_FEE, sysAcct(5n * SOL)).set(PUMP_BUYBACK, sysAcct(SOL)).set(pumpfunIx.deriveCreatorVault(pk(CREATOR)).toBase58(), sysAcct(SOL));
  return c;
}

const ataOf = (mint: string, program = TOKEN_PROGRAM_ID, owner = OWNER): string => deriveAtaAddress(owner, mint, program);
const WSOL_ATA = ataOf(WSOL_MINT);

/** The scripted post state of a successful pump buy of `amount` lamports for `tokens` raw tokens. */
function scriptPumpBuy(c: FakeChain, mint: string, amount: bigint, tokens: bigint, fees = { protocol: 247_500n, buyback: 247_500n, creator: 150_000n }): void {
  c.deltas.set(OWNER, { lamports: -(amount + 5_000n + 4_320n + RENT) });
  c.deltas.set(ataOf(mint), { create: { mint, owner: OWNER }, tokens });
  c.deltas.set(PUMP_FEE, { lamports: fees.protocol });
  c.deltas.set(PUMP_BUYBACK, { lamports: fees.buyback });
  c.deltas.set(pumpfunIx.deriveCreatorVault(pk(CREATOR)).toBase58(), { lamports: fees.creator });
}

const jupDown = async (): Promise<never> => { throw new Error('Jupiter is not reachable in this test'); };
function deps(chain: FakeChain, over: Partial<UnsignedSwapDeps> = {}): UnsignedSwapDeps {
  let t = 5_000_000;
  return { rpc: chain, clock: { now: () => (t += 1) }, jupBuild: jupDown, cache: createWalletBuildCache(), ...over };
}
const req = (over: Partial<WalletQuoteRequest> = {}): WalletQuoteRequest => ({
  owner: OWNER, side: 'buy', mint: MINT_C, amountLamports: A.toString(), slippageBps: 300, maxImpactPct: 15, maxSpendLamports: null, feeLevel: 'normal', maxTxBytes: 1100, ...over,
});
function ok(r: unknown): WalletQuoteLink {
  const x = r as WalletQuoteOk;
  expect(x, JSON.stringify(r)).toMatchObject({ ok: true });
  return x.quote;
}
const refused = (r: unknown): { code: string; reason: string; needLamports?: string; haveLamports?: string } => {
  const x = r as { ok: boolean; code: string };
  expect(x.ok, JSON.stringify(r)).toBe(false);
  return r as never;
};
const txOf = (q: { txBase64: string }): VersionedTransaction => VersionedTransaction.deserialize(Buffer.from(q.txBase64, 'base64'));
const programsOf = (tx: VersionedTransaction): string[] => tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58());
/** The quote must also pass the Engine-side validators of the frozen link contract. */
function expectContractOk(q: WalletQuoteLink, r: WalletQuoteRequest): void {
  const v = validateWalletQuoteResponse({ ok: true, quote: q }, { maxTxBytes: r.maxTxBytes, slippageBps: r.slippageBps });
  expect(v.ok && v.value.ok, JSON.stringify(v)).toBe(true);
}
const floorMin = (q: bigint, slip: number): bigint => (q * BigInt(10_000 - slip)) / 10_000n;
/** FIX-PUMP: buy_exact_sol_in's quote (pump's 95 + 30 bps out of the spend; pump-program.ts, pinned against mainnet TradeEvents). */
const curveOut = (amount: bigint): bigint => pumpBuyQuote(30_000_000_000n, 1_073_000_000_000_000n, amount)!.tokensOut;

// ── the mock Jupiter (GET /swap/v2/build) on 127.0.0.1:0 ──────────────────────────────────────────────────────────────────────────
interface Seen { path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders }
interface JupServer { url: string; seen: Seen[]; close(): Promise<void> }
const jupServers: JupServer[] = [];
afterEach(async () => { for (const s of jupServers.splice(0)) await s.close(); });
async function jupiterServer(answer: (q: URLSearchParams) => { status?: number; body: unknown }): Promise<JupServer> {
  const seen: Seen[] = [];
  const open = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    seen.push({ path: u.pathname, query: u.searchParams, headers: req.headers });
    const a = answer(u.searchParams);
    res.writeHead(a.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(a.body));
  });
  server.on('connection', (s) => { open.add(s); s.on('close', () => open.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const s: JupServer = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen,
    close: () => new Promise<void>((resolve) => { for (const x of open) x.destroy(); server.close(() => resolve()); }),
  };
  jupServers.push(s);
  return s;
}
const ixJson = (ix: TransactionInstruction): unknown => ({
  programId: ix.programId.toBase58(), accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data).toString('base64'),
});
const SHARED_ROUTE = [193, 32, 155, 51, 65, 214, 156, 129];
const TABLE_ADDRESSES = [fixtureKey(60), fixtureKey(61), fixtureKey(62), fixtureKey(63), fixtureKey(64), fixtureKey(65)];
const JUP_QUOTED = 1_650_000_000n;
/** The lean answer keeps every account of the swap that is not the owner's in the table. */
const LEAN_TABLE = [...TABLE_ADDRESSES, fixtureKey(50), fixtureKey(51), fixtureKey(52), fixtureKey(53)];
interface JupAnswerOpts { lean?: boolean; platformFee?: number; discriminator?: number[]; slippage?: number; quotedOut?: bigint; claimed?: Record<string, string[]> | null; tokenProgram?: string; noTable?: boolean; withCb?: boolean; impact?: string }
/** What /swap/v2/build answers for a taker: wrap + create accounts, the shared_accounts_route swap, an unwrap, Jupiter's own compute-budget instruction and a tip. */
function jupAnswer(q: URLSearchParams, o: JupAnswerOpts = {}): unknown {
  const taker = q.get('taker')!;
  const inputMint = q.get('inputMint')!; const outputMint = q.get('outputMint')!;
  const buy = inputMint === WSOL_MINT;
  const mint = buy ? outputMint : inputMint;
  const program = o.tokenProgram ?? TOKEN_PROGRAM_ID;
  const tradeAta = deriveAtaAddress(taker, mint, program);
  const wsolAta = deriveAtaAddress(taker, WSOL_MINT, TOKEN_PROGRAM_ID);
  const amount = BigInt(q.get('amount')!);
  const create = (ata: string, m: string, prog: string): TransactionInstruction => new TransactionInstruction({
    programId: pk('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'), data: Buffer.from([1]),
    keys: [[taker, true, true], [ata, false, true], [taker, false, false], [m, false, false], [SYSTEM, false, false], [prog, false, false]].map(([a, s, w]) => ({ pubkey: pk(a as string), isSigner: s as boolean, isWritable: w as boolean })),
  });
  const setup: TransactionInstruction[] = o.lean ? [create(tradeAta, mint, program)] : [create(wsolAta, WSOL_MINT, TOKEN_PROGRAM_ID), create(tradeAta, mint, program)];
  if (buy && !o.lean) {
    setup.push(SystemProgram.transfer({ fromPubkey: pk(taker), toPubkey: pk(wsolAta), lamports: amount }));
    setup.push(new TransactionInstruction({ programId: pk(TOKEN_PROGRAM_ID), keys: [{ pubkey: pk(wsolAta), isSigner: false, isWritable: true }], data: Buffer.from([17]) }));
  }
  const tail = Buffer.alloc(19);
  tail.writeBigUInt64LE(amount, 0); tail.writeBigUInt64LE(o.quotedOut ?? JUP_QUOTED, 8); tail.writeUInt16LE(o.slippage ?? Number(q.get('slippageBps')), 16); tail[18] = o.platformFee ?? 0;
  const data = Buffer.concat([Buffer.from(o.discriminator ?? SHARED_ROUTE), Buffer.from([7]), Buffer.alloc(24, 9), tail]);
  const acc = (a: string, s = false, w = false) => ({ pubkey: pk(a), isSigner: s, isWritable: w });
  const swap = new TransactionInstruction({
    programId: pk(JUP), data,
    keys: [
      acc(TOKEN_PROGRAM_ID), acc(fixtureKey(50), false, true), acc(taker, true, false), acc(buy ? wsolAta : tradeAta, false, true), acc(fixtureKey(51), false, true), acc(fixtureKey(52), false, true),
      acc(buy ? tradeAta : wsolAta, false, true), acc(buy ? WSOL_MINT : mint), acc(buy ? mint : WSOL_MINT), acc(JUP), acc(TOKEN_2022_PROGRAM_ID), acc(fixtureKey(53)), acc(JUP),
      ...TABLE_ADDRESSES.map((a) => acc(a, false, true)),
    ],
  });
  const cleanup = new TransactionInstruction({
    programId: pk(TOKEN_PROGRAM_ID), data: Buffer.from([9]),
    keys: [acc(wsolAta, false, true), acc(taker, false, true), acc(taker, true, false)],
  });
  return {
    computeBudgetInstructions: o.withCb === false ? [] : [ixJson(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 999_999 }))],
    setupInstructions: setup.map(ixJson), swapInstruction: ixJson(swap), cleanupInstruction: o.lean ? null : ixJson(cleanup), otherInstructions: [],
    tipInstruction: ixJson(SystemProgram.transfer({ fromPubkey: pk(taker), toPubkey: pk(fixtureKey(70)), lamports: 200_000n })),
    addressesByLookupTableAddress: o.noTable ? null : o.claimed === undefined ? { [ALT_KEY]: o.lean ? LEAN_TABLE : TABLE_ADDRESSES } : o.claimed,
    priceImpactPct: o.impact ?? '0.002',
    blockhashWithMetadata: { blockhash: Array.from(bs58.decode(fixtureKey(91))), lastValidBlockHeight: 1 },
  };
}
const JUP_KEY = 'jup-key-' + createHash('sha256').update('ps-fixture-w5-jup-key').digest('hex').slice(0, 16);
/** deps whose Jupiter build goes over real HTTP to the mock, through jupBuildOnce. */
const viaServer = (s: JupServer) => (r: Parameters<typeof jupBuildOnce>[0]) => jupBuildOnce(r, { apiKey: JUP_KEY, buildUrl: `${s.url}/swap/v2/build` });
/** Jupiter's table must exist on the chain (the wallet reads it from there). */
const withTable = (c: FakeChain, addresses = TABLE_ADDRESSES): FakeChain => c.set(ALT_KEY, altAcct(addresses));
/** The scripted post state of a Jupiter buy. */
function scriptJupiterBuy(c: FakeChain, mint: string, program: string, amount: bigint, tokens: bigint): void {
  c.deltas.set(OWNER, { lamports: -(amount + 5_000n + 4_320n + RENT) });
  c.deltas.set(ataOf(mint, program), { create: { mint, owner: OWNER, program }, tokens });
}

describe('unsigned swap: the pump curve route', () => {
  it('WTX-T01 builds a pump-curve buy for a runtime pubkey: one signer (the payer) with a zero signature, no tip, no rebate, exact simulated deltas, inner fee lines from the simulated fee accounts', async () => {
    const chain = chainWorld();
    const out = curveOut(A);
    scriptPumpBuy(chain, MINT_C, A, out);
    const r = req();
    const q = ok(await buildUnsignedSwap(deps(chain), r));
    expectContractOk(q, r);

    // the route, the bound (program-enforced) and the estimates
    expect(q.route).toBe('pump');
    expect(q.routingNotes).toEqual([]);
    const minOut = floorMin(out, 300);
    expect(q.bound).toEqual({ kind: 'exact_in', amountIn: { baseUnits: A.toString(), decimals: 9, asset: 'SOL' }, minOut: { baseUnits: minOut.toString(), decimals: 6, asset: MINT_C } });
    expect(q.quotedOut).toEqual({ baseUnits: out.toString(), decimals: 6, asset: MINT_C });
    expect(q.quotedIn).toBeNull();
    expect(q.slippageBps).toBe(300);
    expect(q.impactPct).toBeCloseTo(0.1648, 3);        // 49.5 M lamports into 30 000 M virtual reserves

    // the transaction: version 0, one required signature = the payer, an all-zero signature slot
    const tx = txOf(q);
    expect(tx.version).toBe(0);
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(tx.message.staticAccountKeys[0].toBase58()).toBe(OWNER);
    expect(tx.signatures.length).toBe(1);
    expect(tx.signatures[0].every((b) => b === 0)).toBe(true);
    expect(q.txBytes).toBe(Buffer.from(q.txBase64, 'base64').length);
    // no tip, no rebate, no transfer at all: only the compute budget, the account create and the curve trade
    expect(programsOf(tx)).toEqual([ComputeBudgetProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(), 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', PUMP_PROGRAM]);
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    for (const tipAccount of CONFIG.HELIUS_TIP_ACCOUNTS) expect(keys).not.toContain(tipAccount);
    expect(JSON.stringify(chain.calls)).not.toMatch(/rebate/i);
    expect(q.thirdPartyTransfers).toEqual([]);

    // exact simulated deltas (strings) and the inner fee lines, from the simulated fee accounts, with their own labels
    expect(q.simulatedDeltas.sol).toEqual({ baseUnits: (-(A + 5_000n + 4_320n + RENT)).toString(), decimals: 9, asset: 'SOL' });
    expect(q.simulatedDeltas.token).toEqual({ baseUnits: out.toString(), decimals: 6, asset: MINT_C });
    expect(q.innerFees).toEqual([
      { label: 'Pump protocol fee, charged inside the swap program', recipient: PUMP_FEE, amount: { baseUnits: '247500', decimals: 9, asset: 'SOL' } },
      { label: 'Pump buyback fee, charged inside the swap program', recipient: PUMP_BUYBACK, amount: { baseUnits: '247500', decimals: 9, asset: 'SOL' } },
      { label: 'Creator fee, charged inside the swap program', recipient: pumpfunIx.deriveCreatorVault(pk(CREATOR)).toBase58(), amount: { baseUnits: '150000', decimals: 9, asset: 'SOL' } },
    ]);
    // the lines add up: amount + network + priority fee + the rent bound of the one account the transaction creates
    expect(q.networkFeeLamports).toBe('5000');
    expect(q.priorityFee).toEqual({ cuLimit: 72_000, cuPriceMicrolamports: 60_000, lamports: '4320' });
    expect(q.rentLamports).toBe(RENT.toString());
    expect(q.maxOutflowLamports).toBe((A + 5_000n + 4_320n + RENT).toString());
    expect(q.balance).toMatchObject({ lamports: (10n * SOL).toString(), slot: 1000 });
    expect(q.minContextSlot).toBe(1001);
    expect(q.programs).toEqual([...new Set(programsOf(tx))]);

    // two simulations: the first measures at the 400 000 limit, the second is the final transaction over every writable account; every read at confirmed
    expect(chain.sims.map((s) => s.withAccounts)).toEqual([false, true]);
    const limitOf = (t: VersionedTransaction): number => Buffer.from(t.message.compiledInstructions[0].data).readUInt32LE(1);
    expect(limitOf(chain.sims[0].tx)).toBe(400_000);
    expect(limitOf(chain.sims[1].tx)).toBe(72_000);
    expect(limitOf(tx)).toBe(72_000);
    for (const c of chain.calls) {
      const cfg = c.params.find((p) => typeof p === 'object' && p !== null && !Array.isArray(p) && 'commitment' in p);
      if (['getBalance', 'getMultipleAccounts', 'simulateTransaction', 'getLatestBlockhash'].includes(c.method)) expect(cfg?.commitment, c.method).toBe('confirmed');
    }
    expect(chain.sims[1].tx.serialize()).toEqual(tx.serialize());
    expect(chain.sims[1].tx.message.recentBlockhash).toBe(chain.blockhash);

    // a sell on the same curve
    const held = 5_000_000_000n;
    const sellChain = chainWorld();
    sellChain.set(ataOf(MINT_C), tokenAcct({ mint: MINT_C, owner: OWNER, amount: held }));
    const vSol = 30_000_000_000n; const vTok = 1_073_000_000_000_000n;
    const solOut = pumpSellQuote(vSol, vTok, held)!.net;
    sellChain.deltas.set(OWNER, { lamports: solOut - 9_320n });
    sellChain.deltas.set(ataOf(MINT_C), { tokens: -held });
    sellChain.deltas.set(PUMP_FEE, { lamports: 800_000n });
    const sr = req({ side: 'sell', amountLamports: undefined, tokensRaw: held.toString() });
    const sq = ok(await buildUnsignedSwap(deps(sellChain), sr));
    expectContractOk(sq, sr);
    expect(sq.route).toBe('pump');
    expect(sq.bound).toEqual({ kind: 'exact_in', amountIn: { baseUnits: held.toString(), decimals: 6, asset: MINT_C }, minOut: { baseUnits: floorMin(solOut, 300).toString(), decimals: 9, asset: 'SOL' } });
    expect(sq.maxOutflowLamports).toBe((5_000n + 4_320n).toString());     // a sell takes only its fees (no account is created)
    expect(sq.rentLamports).toBe('0');
    expect(programsOf(txOf(sq))).toEqual([ComputeBudgetProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(), PUMP_PROGRAM]);
  });
});

describe('unsigned swap: PumpSwap', () => {
  const graduate = (c: FakeChain): FakeChain => {
    c.set(pumpswapIx.derivePumpSwapCanonicalPool(pk(MINT_G)).toBase58(), poolAcct());
    c.set(POOL_BASE, tokenAcct({ mint: MINT_G, owner: fixtureKey(80), amount: 250_000_000_000_000n }));
    c.set(POOL_QUOTE, tokenAcct({ mint: WSOL_MINT, owner: fixtureKey(80), amount: 91_000_000_000n }));
    c.set(pumpswapIx.PUMPSWAP_FEE_RECIPIENT_ATA.toBase58(), tokenAcct({ mint: WSOL_MINT, owner: pumpswapIx.PUMPSWAP_FEE_RECIPIENT.toBase58(), amount: 10n }));
    const vault = pumpswapIx.deriveAta(pumpswapIx.WSOL_MINT_PK, pumpswapIx.deriveCoinCreatorVaultAuthority(pk(POOL_CREATOR)), pumpswapIx.TOKEN_PROGRAM_PK).toBase58();
    c.set(vault, tokenAcct({ mint: WSOL_MINT, owner: fixtureKey(81), amount: 5n }));
    return c;
  };
  const vaultAta = pumpswapIx.deriveAta(pumpswapIx.WSOL_MINT_PK, pumpswapIx.deriveCoinCreatorVaultAuthority(pk(POOL_CREATOR)), pumpswapIx.TOKEN_PROGRAM_PK).toBase58();

  it('WTX-T02 PumpSwap buy (exact-out bound exactOut/maxIn, the maximum outflow uses maxIn) and sell, through the test-only route; wsol-balance-present when the wSOL account holds a balance', async () => {
    const baseRes = 250_000_000_000_000n; const quoteRes = 91_000_000_000n;
    const out = baseRes - (baseRes * quoteRes) / (quoteRes + (A * 9905n) / 10_000n);
    const maxIn = (A * 10_300n + 9_999n) / 10_000n;
    const chain = graduate(chainWorld());
    chain.deltas.set(OWNER, { lamports: -(A + 5_000n + 4_320n + 2n * RENT - RENT) });       // the wSOL account is created and closed again: one ATA's rent stays
    chain.deltas.set(ataOf(MINT_G), { create: { mint: MINT_G, owner: OWNER }, tokens: out });
    chain.deltas.set(pumpswapIx.PUMPSWAP_FEE_RECIPIENT_ATA.toBase58(), { tokens: 400_000n });
    chain.deltas.set(vaultAta, { tokens: 120_000n });
    const r = req({ mint: MINT_G });
    const q = ok(await buildUnsignedSwap(deps(chain, { testOnlyPumpSwapRoute: true }), r));
    expectContractOk(q, r);
    expect(q.route).toBe('pumpswap');
    expect(q.routingNotes).toEqual([]);
    expect(q.bound).toEqual({ kind: 'exact_out', exactOut: { baseUnits: out.toString(), decimals: 6, asset: MINT_G }, maxIn: { baseUnits: maxIn.toString(), decimals: 9, asset: 'SOL' } });
    expect(q.quotedIn).toEqual({ baseUnits: A.toString(), decimals: 9, asset: 'SOL' });
    expect(q.quotedOut).toBeNull();
    // the maximum outflow is built from maxIn (not from the amount), the fee lines and the rent of the TWO accounts the transaction creates
    expect(q.maxOutflowLamports).toBe((maxIn + 5_000n + 4_320n + 2n * RENT).toString());
    expect(q.rentLamports).toBe((2n * RENT).toString());
    // the trade instruction: the IDL's 23 accounts, the user at 1, the base mint at 3, the user's token accounts at 5 and 6, the fee accounts at 10 and 17
    const tx = txOf(q);
    const swapIx = tx.message.compiledInstructions.find((ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58() === PUMPSWAP)!;
    expect(swapIx.accountKeyIndexes.length).toBe(23);
    const at = (i: number): string => tx.message.staticAccountKeys[swapIx.accountKeyIndexes[i]].toBase58();
    expect([at(1), at(3), at(5), at(6), at(10), at(17)]).toEqual([OWNER, MINT_G, ataOf(MINT_G), WSOL_ATA, pumpswapIx.PUMPSWAP_FEE_RECIPIENT_ATA.toBase58(), vaultAta]);
    expect(Buffer.from(swapIx.data).readBigUInt64LE(8)).toBe(out);
    expect(Buffer.from(swapIx.data).readBigUInt64LE(16)).toBe(maxIn);
    expect(q.innerFees.map((f) => [f.recipient, f.amount])).toEqual([
      [pumpswapIx.PUMPSWAP_FEE_RECIPIENT_ATA.toBase58(), { baseUnits: '400000', decimals: 9, asset: WSOL_MINT }],
      [vaultAta, { baseUnits: '120000', decimals: 9, asset: WSOL_MINT }],
    ]);
    // a sell: exact-in, the wSOL account is created for the proceeds and closed again
    const held = 3_000_000_000_000n;
    const sellChain = graduate(chainWorld());
    sellChain.set(ataOf(MINT_G), tokenAcct({ mint: MINT_G, owner: OWNER, amount: held }));
    const gross = quoteRes - (baseRes * quoteRes) / (baseRes + held);
    const solOut = (gross * 9905n) / 10_000n;
    sellChain.deltas.set(OWNER, { lamports: solOut - 9_320n });
    sellChain.deltas.set(ataOf(MINT_G), { tokens: -held });
    sellChain.deltas.set(pumpswapIx.PUMPSWAP_FEE_RECIPIENT_ATA.toBase58(), { tokens: 100n });
    const sr = req({ mint: MINT_G, side: 'sell', amountLamports: undefined, pctBps: 10_000 });
    const sq = ok(await buildUnsignedSwap(deps(sellChain, { testOnlyPumpSwapRoute: true }), sr));
    expectContractOk(sq, sr);
    expect(sq.route).toBe('pumpswap');
    expect(sq.bound).toMatchObject({ kind: 'exact_in', amountIn: { baseUnits: held.toString(), asset: MINT_G }, minOut: { baseUnits: floorMin(solOut, 300).toString(), asset: 'SOL' } });
    expect(sq.maxOutflowLamports).toBe((5_000n + 4_320n + RENT).toString());

    // the owner's wSOL account holds a balance: the route would unwrap it, so it is refused (Jupiter, which also wraps, is refused too; Jupiter is down here)
    const loaded = graduate(chainWorld());
    loaded.set(WSOL_ATA, tokenAcct({ mint: WSOL_MINT, owner: OWNER, amount: 7_000n }));
    const refusal = refused(await buildUnsignedSwap(deps(loaded, { testOnlyPumpSwapRoute: true }), r));
    expect(refusal.code).toBe('wsol-balance-present');
    expect(refusal.reason).toMatch(/Unwrap your wSOL first/);
    expect(loaded.sims.length).toBe(0);                                                       // refused before any simulation of that route's final transaction
    expect(JSON.stringify(refusal)).not.toContain('txBase64');
  });
});

describe('unsigned swap: Jupiter', () => {
  it('WTX-T03 builds through the mock Jupiter: its compute-budget instructions and tip are dropped for exactly one limit and one price, platform_fee_bps 0 is decoded, no /order, one build attempt', async () => {
    const server = await jupiterServer((q) => ({ body: jupAnswer(q, { tokenProgram: TOKEN_2022_PROGRAM_ID }) }));
    const chain = withTable(chainWorld());
    scriptJupiterBuy(chain, MINT_22, TOKEN_2022_PROGRAM_ID, A, 1_700_000_000n);
    chain.deltas.set(OWNER, { lamports: -(A + 5_000n + 4_320n + RENT) });
    const r = req({ mint: MINT_22 });
    const q = ok(await buildUnsignedSwap(deps(chain, { jupBuild: viaServer(server) }), r));
    expectContractOk(q, r);
    expect(q.route).toBe('jupiter');
    // exactly one request, to the build path, for the taker, with the first key; no order, no execute, no second attempt
    expect(server.seen.length).toBe(1);
    expect(server.seen[0].path).toBe('/swap/v2/build');
    expect(server.seen.map((s) => s.path).join(' ')).not.toMatch(/order|execute/);
    expect(Object.fromEntries(server.seen[0].query)).toEqual({ inputMint: WSOL_MINT, outputMint: MINT_22, amount: A.toString(), slippageBps: '300', taker: OWNER });
    expect(server.seen[0].headers['x-api-key']).toBe(JUP_KEY);
    // the bytes: one limit and one price of ours, none of Jupiter's (its price was 999 999), no tip transfer, platform fee 0 decoded
    const tx = txOf(q);
    const cb = tx.message.compiledInstructions.filter((ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58() === ComputeBudgetProgram.programId.toBase58());
    expect(cb.map((ix) => ix.data[0]).sort()).toEqual([2, 3]);
    expect(cb.find((ix) => ix.data[0] === 3) && Buffer.from(cb.find((ix) => ix.data[0] === 3)!.data).readBigUInt64LE(1)).toBe(60_000n);
    const priority = computeBudgetFeeLamports(tx);
    expect(priority).toEqual({ ok: true, lamports: BigInt(q.priorityFee.lamports) });
    const jupIx = tx.message.compiledInstructions.find((ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58() === JUP)!;
    expect(Buffer.from(jupIx.data)[jupIx.data.length - 1]).toBe(0);                        // platform_fee_bps
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    expect(keys).not.toContain(fixtureKey(70));                                           // Jupiter's tip account
    expect(programsOf(tx).filter((p) => p === SYSTEM)).toEqual([SYSTEM]);                  // the one wrap transfer into the owner's own wSOL account
    // the bound is decoded from the bytes: exact-in, min out = quoted out minus the slippage
    expect(q.quotedOut).toEqual({ baseUnits: JUP_QUOTED.toString(), decimals: 6, asset: MINT_22 });
    expect(q.bound).toMatchObject({ kind: 'exact_in', amountIn: { baseUnits: A.toString() }, minOut: { baseUnits: floorMin(JUP_QUOTED, 300).toString() } });
    expect(q.impactPct).toBeCloseTo(0.2, 6);
    expect(q.innerFees).toEqual([]);
    expect(q.maxOutflowLamports).toBe((A + 5_000n + 4_320n + 2n * RENT).toString());      // two accounts are created: the wrapped-SOL account and the trade account
    // the lookup table was read from the chain, and the message is compiled against it
    expect(chain.calls.some((c) => c.method === 'getMultipleAccounts' && c.params[0].includes(ALT_KEY))).toBe(true);
    expect(tx.message.addressTableLookups.map((l) => l.accountKey.toBase58())).toEqual([ALT_KEY]);

    // a failing Jupiter is ONE request and one refusal: no retry, no second key
    const bad = await jupiterServer(() => ({ status: 500, body: { error: 'boom' } }));
    const down = refused(await buildUnsignedSwap(deps(withTable(chainWorld()), { jupBuild: viaServer(bad) }), req({ mint: MINT_22 })));
    expect(down.code).toBe('build-failed');
    expect(bad.seen.length).toBe(1);
    const noRoute = await jupiterServer(() => ({ status: 400, body: { error: 'COULD_NOT_FIND_ANY_ROUTE' } }));
    expect(refused(await buildUnsignedSwap(deps(withTable(chainWorld()), { jupBuild: viaServer(noRoute) }), req({ mint: MINT_22 }))).code).toBe('no-route');
    expect(noRoute.seen.length).toBe(1);
  });
});

describe('unsigned swap: routing without PumpPortal and without the direct PumpSwap route', () => {
  it('WTX-T04 a Token-2022 pre-graduation mint with empty fee accounts skips PumpPortal and uses Jupiter, with the reason recorded', async () => {
    expect(PUMPPORTAL_FEE_ACCOUNTS).toEqual([]);                      // the fee account list is still empty (A-51), so a PumpPortal-built transaction could not pass anyway
    const server = await jupiterServer((q) => ({ body: jupAnswer(q, { tokenProgram: TOKEN_2022_PROGRAM_ID }) }));
    const chain = withTable(chainWorld());
    scriptJupiterBuy(chain, MINT_22, TOKEN_2022_PROGRAM_ID, A, 1_700_000_000n);
    const r = req({ mint: MINT_22 });
    const q = ok(await buildUnsignedSwap(deps(chain, { jupBuild: viaServer(server) }), r));
    expectContractOk(q, r);
    expect(q.route).toBe('jupiter');
    expect(q.routingNotes).toEqual(['pumpportal-not-offered']);
    expect(server.seen.length).toBe(1);
    // a Token-2022 sell goes the same way
    const sellChain = withTable(chainWorld());
    sellChain.set(ataOf(MINT_22, TOKEN_2022_PROGRAM_ID), tokenAcct({ mint: MINT_22, owner: OWNER, amount: 9_000_000n, program: TOKEN_2022_PROGRAM_ID }));
    sellChain.deltas.set(OWNER, { lamports: JUP_QUOTED - 9_320n });
    sellChain.deltas.set(ataOf(MINT_22, TOKEN_2022_PROGRAM_ID), { tokens: -9_000_000n });
    const sq = ok(await buildUnsignedSwap(deps(sellChain, { jupBuild: viaServer(server) }), req({ mint: MINT_22, side: 'sell', amountLamports: undefined, pctBps: 10_000 })));
    expect(sq).toMatchObject({ route: 'jupiter', routingNotes: ['pumpportal-not-offered'] });
    expect(server.seen[1].query.get('inputMint')).toBe(MINT_22);
    expect(server.seen[1].query.get('amount')).toBe('9000000');
    // no wallet code names the PumpPortal builder, its endpoint or a switch for it
    for (const f of ['unsigned-swap.ts', 'ext-verify.ts', 'wallet-rpc.ts', 'wallet-reads.ts', 'jupiter-ix.ts', 'pumpfun-ix.ts', 'pumpswap-ix.ts']) {
      expect(fs.readFileSync(path.join(__dirname, f), 'utf8'), f).not.toMatch(/trade-local|pumpportal\.fun|PUMPPORTAL_BASE|buildPumpPortalTx|WALLET_ALLOW_PUMPPORTAL_BUILD|pumpPortalPrioritySol/);
    }
  });

  it('WTX-T18 with the shipped PUMPSWAP_DIRECT_ENABLED = false a graduated mint is never built on PumpSwap: Jupiter, the note pumpswap-direct-disabled, zero PumpSwap instructions; pumpswap-swap re-exports the moved names unchanged', async () => {
    expect(pumpswapIx.PUMPSWAP_DIRECT_ENABLED).toBe(false);
    expect(pumpswapSwap.PUMPSWAP_DIRECT_ENABLED).toBe(false);
    const server = await jupiterServer((q) => ({ body: jupAnswer(q) }));
    const chain = withTable(chainWorld());
    chain.set(pumpswapIx.derivePumpSwapCanonicalPool(pk(MINT_G)).toBase58(), poolAcct());
    scriptJupiterBuy(chain, MINT_G, TOKEN_PROGRAM_ID, A, 1_700_000_000n);
    const r = req({ mint: MINT_G });
    const q = ok(await buildUnsignedSwap(deps(chain, { jupBuild: viaServer(server) }), r));
    expectContractOk(q, r);
    expect(q.route).toBe('jupiter');
    expect(q.routingNotes).toEqual(['pumpswap-direct-disabled']);
    const tx = txOf(q);
    expect(programsOf(tx)).not.toContain(PUMPSWAP);
    expect(tx.message.staticAccountKeys.map((k) => k.toBase58())).not.toContain(PUMPSWAP);
    // the pool was not even read
    const poolKey = pumpswapIx.derivePumpSwapCanonicalPool(pk(MINT_G)).toBase58();
    expect(chain.calls.filter((c) => c.method === 'getMultipleAccounts').some((c) => c.params[0].includes(poolKey))).toBe(false);
    // the signing file re-exports the moved names, the same objects; the server route refuses before any RPC call, build or signature
    for (const n of ['PUMPSWAP_PROGRAM_ID', 'PUMPSWAP_FEE_RECIPIENT', 'PUMPSWAP_DIRECT_ENABLED', 'PumpSwapDirectDisabledError', 'PUMPSWAP_FEE_RECIPIENT_ATA', 'PUMPSWAP_GLOBAL_VOLUME_ACCUMULATOR', 'PUMPSWAP_FEE_CONFIG',
      'derivePumpSwapPoolAuthority', 'derivePumpSwapCanonicalPool', 'deriveCoinCreatorVaultAuthority', 'derivePumpSwapUserVolumeAccumulator', 'parsePumpSwapPoolAccount', 'buildPumpSwapBuyInstruction', 'buildPumpSwapSellInstruction']) {
      expect((pumpswapSwap as Record<string, unknown>)[n], n).toBe((pumpswapIx as Record<string, unknown>)[n]);
    }
    await expect(pumpswapSwap.pumpswapBuy({} as never, MINT_G, 0.05)).rejects.toBeInstanceOf(pumpswapIx.PumpSwapDirectDisabledError);
    await expect(pumpswapSwap.pumpswapSell({} as never, MINT_G, 1n)).rejects.toThrow(/PumpSwap direct disabled/);
    // the test-only switch is not a dep the link routes can reach: only unsigned-swap.ts and tests name it
    const files = fs.readdirSync(path.resolve(__dirname, '..'), { recursive: true }) as string[];
    const naming = files.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && /testOnlyPumpSwapRoute/.test(fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8')));
    expect(naming.map((f) => f.replace(/\\/g, '/'))).toEqual(['execution/unsigned-swap.ts']);
  });
});

describe('unsigned swap: failures, fees and sizes', () => {
  it('WTX-T06 a failing simulation is a refusal and no bytes are returned; a pinned slippage error code of the failing program is price-moved', async () => {
    const out = curveOut(A);
    const tryCase = async (mutate: (c: FakeChain) => void, r = req(), d: Partial<UnsignedSwapDeps> = {}) => {
      const chain = withTable(chainWorld());
      scriptPumpBuy(chain, MINT_C, A, out);
      mutate(chain);
      const res = await buildUnsignedSwap(deps(chain, d), r);
      expect(JSON.stringify(res), 'a refusal carries no transaction').not.toContain('txBase64');
      return { res: refused(res), chain };
    };
    // [CB limit, CB price, create ATA, pump buy]: the pump instruction is number 3
    expect((await tryCase((c) => { c.measureErr = { InstructionError: [3, { Custom: 6999 }] }; })).res.code).toBe('simulation-failed');
    expect((await tryCase((c) => { c.measureErr = 'AccountNotFound'; })).res.code).toBe('simulation-failed');
    const generic = await tryCase((c) => { c.finalErr = { InstructionError: [3, { Custom: 6999 }] }; });
    expect(generic.res).toMatchObject({ code: 'simulation-failed', reason: expect.stringContaining('6999') });
    expect(generic.chain.sims.map((s) => s.withAccounts)).toEqual([false, true]);
    // a pinned code of the program that ran the failing instruction: the price moved, in the measuring simulation and in the final one
    expect((await tryCase((c) => { c.measureErr = { InstructionError: [3, { Custom: 6002 }] }; })).res.code).toBe('price-moved');
    expect((await tryCase((c) => { c.finalErr = { InstructionError: [3, { Custom: 6002 }] }; })).res.code).toBe('price-moved');
    // a pump code on an instruction of another program (the account create is instruction 2) is NOT a slippage error
    expect((await tryCase((c) => { c.finalErr = { InstructionError: [2, { Custom: 6002 }] }; })).res.code).toBe('simulation-failed');
    // Jupiter: 6001 on the Jupiter instruction (after two compute-budget instructions, two creates, a wrap, a sync: number 6)
    const server = await jupiterServer((q) => ({ body: jupAnswer(q, { tokenProgram: TOKEN_2022_PROGRAM_ID }) }));
    const jchain = withTable(chainWorld());
    scriptJupiterBuy(jchain, MINT_22, TOKEN_2022_PROGRAM_ID, A, 1_700_000_000n);
    jchain.finalErr = { InstructionError: [6, { Custom: 6001 }] };
    const j = refused(await buildUnsignedSwap(deps(jchain, { jupBuild: viaServer(server) }), req({ mint: MINT_22 })));
    expect(j.code).toBe('price-moved');
    // the simulated output is checked as well: a final simulation that returns less than the minimum is a refusal with no bytes
    const low = await tryCase((c) => { c.deltas.set(ataOf(MINT_C), { create: { mint: MINT_C, owner: OWNER }, tokens: floorMin(out, 300) - 1n }); });
    expect(low.res.code).toBe('simulation-failed');
  });

  it('WTX-T13 a transaction over the size cap is re-routed once, else tx-too-large', async () => {
    const server = await jupiterServer((q) => ({ body: jupAnswer(q, { lean: true }) }));
    const out = curveOut(A);
    const world = (): FakeChain => { const c = chainWorld().set(ALT_KEY, altAcct(LEAN_TABLE)); scriptPumpBuy(c, MINT_C, A, out); scriptJupiterBuy(c, MINT_22, TOKEN_2022_PROGRAM_ID, A, 1_700_000_000n); return c; };
    // the two sizes: the pump transaction, and the Jupiter one (its accounts sit in a lookup table, so it is the smaller)
    const pumpBytes = ok(await buildUnsignedSwap(deps(world()), req())).txBytes;
    const jupServer = await jupiterServer((q) => ({ body: jupAnswer(q, { lean: true }) }));
    const jchain = chainWorld().set(ALT_KEY, altAcct(LEAN_TABLE));
    scriptJupiterBuy(jchain, MINT_C, TOKEN_PROGRAM_ID, A, 1_700_000_000n);
    jchain.set(pumpfunIx.deriveBondingCurve(pk(MINT_C)).toBase58(), null);                  // no curve: Jupiter is the only route
    const jupBytes = ok(await buildUnsignedSwap(deps(jchain, { jupBuild: viaServer(jupServer) }), req())).txBytes;
    expect(jupBytes).toBeLessThan(pumpBytes);
    const cap = Math.floor((jupBytes + pumpBytes) / 2);
    // pump is over the cap: it is skipped (a note says why) and Jupiter, once, fits
    const chain = world();
    const q = ok(await buildUnsignedSwap(deps(chain, { jupBuild: viaServer(server), maxTxBytes: cap }), req({ maxTxBytes: 1100 })));
    expect(q.route).toBe('jupiter');
    expect(q.routingNotes).toContain('pump-tx-too-large');
    expect(q.txBytes).toBeLessThanOrEqual(cap);
    expect(server.seen.length).toBe(1);                                                      // Jupiter was asked once
    // the request can lower the cap as well
    const q2 = ok(await buildUnsignedSwap(deps(world(), { jupBuild: viaServer(server) }), req({ maxTxBytes: cap })));
    expect(q2.route).toBe('jupiter');
    // both over the cap: tx-too-large, the preferred route's answer, no bytes
    const small = jupBytes - 1;
    const both = world();
    const refusal = refused(await buildUnsignedSwap(deps(both, { jupBuild: viaServer(server) }), req({ maxTxBytes: small })));
    expect(refusal.code).toBe('tx-too-large');
    expect(refusal.reason).toMatch(/bytes, above the \d+ byte cap/);
    expect(JSON.stringify(refusal)).not.toContain('txBase64');
    // a route with nothing to fall back on
    const only = chainWorld().set(ALT_KEY, altAcct(LEAN_TABLE));
    scriptJupiterBuy(only, MINT_22, TOKEN_2022_PROGRAM_ID, A, 1_700_000_000n);
    expect(refused(await buildUnsignedSwap(deps(only, { jupBuild: viaServer(server) }), req({ mint: MINT_22, maxTxBytes: 200 }))).code).toBe('tx-too-large');
    // the hard maximum is 1132 whatever the request says
    expect(refused(await buildUnsignedSwap(deps(world()), req({ maxTxBytes: 1133 }))).code).toBe('bad-request');
  });

  it('WTX-T14 the limit is ceil(units x 1.2) capped at 400 000, the price is clamped, the priority fee line equals the fee computed from the bytes, never the snipe level', async () => {
    const out = curveOut(A);
    const build = async (setup: (c: FakeChain) => void, r = req(), d: Partial<UnsignedSwapDeps> = {}) => {
      const chain = chainWorld();
      scriptPumpBuy(chain, MINT_C, A, out);
      chain.deltas.set(OWNER, { lamports: -(A + RENT) });         // below the maximum outflow whatever the priority fee is
      setup(chain);
      const q = ok(await buildUnsignedSwap(deps(chain, d), r));
      const tx = txOf(q);
      // the fee line is exactly what the bytes commit to
      expect(computeBudgetFeeLamports(tx)).toEqual({ ok: true, lamports: BigInt(q.priorityFee.lamports) });
      expect(q.priorityFee.lamports).toBe(((BigInt(q.priorityFee.cuLimit) * BigInt(q.priorityFee.cuPriceMicrolamports) + 999_999n) / 1_000_000n).toString());
      return { q, chain };
    };
    // units -> limit
    for (const [units, limit] of [[60_000, 72_000], [60_001, 72_002], [1, 2], [333_333, 400_000], [350_000, 400_000], [400_000, 400_000]] as const) {
      const { q } = await build((c) => { c.units = units; });
      expect(q.priorityFee.cuLimit, `units ${units}`).toBe(limit);
    }
    // the estimate is clamped to the configured range; the default range is [10 000, 1 000 000]
    expect(DEFAULT_PRIORITY_MIN_MICROLAMPORTS).toBe(10_000);
    expect(DEFAULT_PRIORITY_MAX_MICROLAMPORTS).toBe(1_000_000);
    expect((await build((c) => { c.priority = 5_000; })).q.priorityFee.cuPriceMicrolamports).toBe(10_000);
    expect((await build((c) => { c.priority = 5_000_000; })).q.priorityFee.cuPriceMicrolamports).toBe(1_000_000);
    expect((await build((c) => { c.priority = 123_456.9; })).q.priorityFee.cuPriceMicrolamports).toBe(123_456);
    expect((await build((c) => { c.priority = 5_000; }, req(), { priorityRange: { minPrice: 20_000, maxPrice: 30_000 } })).q.priorityFee.cuPriceMicrolamports).toBe(20_000);
    expect((await build((c) => { c.priority = 90_000; }, req(), { priorityRange: { minPrice: 20_000, maxPrice: 30_000 } })).q.priorityFee.cuPriceMicrolamports).toBe(30_000);
    // the level: normal asks for Medium, fast for High, and nothing asks for VeryHigh
    const levels: string[] = [];
    for (const feeLevel of ['normal', 'fast'] as const) {
      const { chain } = await build(() => undefined, req({ feeLevel }));
      const call = chain.calls.find((c) => c.method === 'getPriorityFeeEstimate')!;
      levels.push(call.params[0].options.priorityLevel);
      expect(call.params[0].accountKeys).toContain(OWNER);
    }
    expect(levels).toEqual(['Medium', 'High']);
    // an estimator that fails or answers nothing falls back to the minimum price and says so
    for (const bad of [new Error('estimator down'), null]) {
      const { q } = await build((c) => { c.priority = bad; });
      expect(q.priorityFee.cuPriceMicrolamports).toBe(10_000);
      expect(q.routingNotes).toContain('priority-estimate-unavailable');
    }
    // the fee line enters the maximum outflow
    const { q } = await build(() => undefined);
    expect(BigInt(q.maxOutflowLamports)).toBe(A + 5_000n + BigInt(q.priorityFee.lamports) + RENT);
  });
});

describe('unsigned swap: limits (owner answers Q2)', () => {
  const out = curveOut(A);
  const world = (): FakeChain => { const c = withTable(chainWorld()); scriptPumpBuy(c, MINT_C, A, out); return c; };

  it('WTX-T19 no cap when maxSpendLamports is null, a set cap refuses above it (PumpSwap max-in included), insufficient-sol carries the exact need and have, a passing quote carries the balance, the impact limit refuses', async () => {
    // no cap: any amount the wallet can pay is built
    const big = 5n * SOL;
    const bigChain = chainWorld();
    scriptPumpBuy(bigChain, MINT_C, big, curveOut(big));
    const bq = ok(await buildUnsignedSwap(deps(bigChain), req({ amountLamports: big.toString(), maxImpactPct: 50 })));
    expect(bq.bound).toMatchObject({ amountIn: { baseUnits: big.toString() } });
    expect(bq.balance.lamports).toBe((10n * SOL).toString());                // a passing quote carries the balance it was checked against
    expect(bq.balance.readAt).toBeGreaterThan(0);

    // a set cap: at the cap passes, above it is refused; the slippage is not part of an exact-in spend
    const capped = (amount: bigint, cap: bigint | null, d: Partial<UnsignedSwapDeps> = {}): Promise<unknown> => {
      const c = chainWorld();
      scriptPumpBuy(c, MINT_C, amount, curveOut(amount));
      return buildUnsignedSwap(deps(c, d), req({ amountLamports: amount.toString(), maxSpendLamports: cap === null ? null : cap.toString() }));
    };
    ok(await capped(A, A));
    expect(refused(await capped(A + 1n, A)).code).toBe('amount-above-cap');
    expect(refused(await capped(A, A - 1n)).reason).toMatch(/above the cap/);

    // PumpSwap: the cap applies to the MAXIMUM input, so an amount at the cap is already over it; Jupiter, with its smaller maximum spend, is then used
    const swapWorld = (): FakeChain => {
      const c = withTable(chainWorld());
      c.set(pumpswapIx.derivePumpSwapCanonicalPool(pk(MINT_G)).toBase58(), poolAcct());
      c.set(POOL_BASE, tokenAcct({ mint: MINT_G, owner: fixtureKey(80), amount: 250_000_000_000_000n }));
      c.set(POOL_QUOTE, tokenAcct({ mint: WSOL_MINT, owner: fixtureKey(80), amount: 91_000_000_000n }));
      scriptJupiterBuy(c, MINT_G, TOKEN_PROGRAM_ID, A, 1_700_000_000n);
      return c;
    };
    const server = await jupiterServer((q) => ({ body: jupAnswer(q) }));
    const viaJup = ok(await buildUnsignedSwap(deps(swapWorld(), { testOnlyPumpSwapRoute: true, jupBuild: viaServer(server) }), req({ mint: MINT_G, maxSpendLamports: A.toString() })));
    expect(viaJup.route).toBe('jupiter');
    expect(viaJup.routingNotes).toContain('pumpswap-amount-above-cap');
    // with the cap above maxIn the PumpSwap route is built
    const maxIn = (A * 10_300n + 9_999n) / 10_000n;
    const swapChain = swapWorld();
    swapChain.deltas.set(OWNER, { lamports: -(A + 5_000n + 4_320n + RENT) });
    swapChain.deltas.set(ataOf(MINT_G), { create: { mint: MINT_G, owner: OWNER }, tokens: 250_000_000_000_000n - (250_000_000_000_000n * 91_000_000_000n) / (91_000_000_000n + (A * 9905n) / 10_000n) });
    const viaSwap = ok(await buildUnsignedSwap(deps(swapChain, { testOnlyPumpSwapRoute: true, jupBuild: viaServer(server) }), req({ mint: MINT_G, maxSpendLamports: maxIn.toString() })));
    expect(viaSwap.route).toBe('pumpswap');
    expect(refused(await buildUnsignedSwap(deps(swapWorld(), { testOnlyPumpSwapRoute: true, jupBuild: jupDown }), req({ mint: MINT_G, maxSpendLamports: (maxIn - 1n).toString() }))).code).toBe('amount-above-cap');

    // the balance is read in the same build; the maximum outflow above it is insufficient-sol with both exact strings
    const ref = ok(await buildUnsignedSwap(deps(world()), req()));
    const need = BigInt(ref.maxOutflowLamports);
    const short = world();
    short.balance = need - 1n;
    const refusal = refused(await buildUnsignedSwap(deps(short), req()));
    expect(refusal).toMatchObject({ code: 'insufficient-sol', needLamports: need.toString(), haveLamports: (need - 1n).toString() });
    expect(validateWalletQuoteResponse(refusal).ok).toBe(true);                    // the Engine validator accepts the refusal with its two strings
    const exact = world();
    exact.balance = need;                                                         // exactly enough passes
    expect(ok(await buildUnsignedSwap(deps(exact), req())).balance.lamports).toBe(need.toString());
    // a wallet far below the amount: the simulation cannot even run, and the answer is still insufficient-sol with the most the trade can take
    const empty = world();
    empty.balance = 1_000_000n;
    empty.finalErr = 'InsufficientFundsForFee';
    empty.measureErr = 'InsufficientFundsForFee';
    const poor = refused(await buildUnsignedSwap(deps(empty), req()));
    expect(poor.code).toBe('insufficient-sol');
    expect(poor.haveLamports).toBe('1000000');
    expect(BigInt(poor.needLamports!)).toBeGreaterThan(A);
    // an unreadable balance is a refusal, never 0
    const noBalance = world();
    const broken = deps(noBalance, { rpc: { call: async (m: string, p: unknown[]) => { if (m === 'getBalance') throw new Error('rpc down'); return noBalance.call(m, p); } } });
    expect(refused(await buildUnsignedSwap(broken, req())).code).toBe('build-failed');

    // the impact limit: the curve's own impact is 0.1648 %
    expect(refused(await buildUnsignedSwap(deps(world()), req({ maxImpactPct: 0.1 }))).code).toBe('impact-above-limit');
    ok(await buildUnsignedSwap(deps(world()), req({ maxImpactPct: 0.17 })));
    // Jupiter's own impact (0.2 %) is checked the same way, and a route that gives none is refused (A-108b: fail closed as A-26)
    const jserver = await jupiterServer((q) => ({ body: jupAnswer(q, { tokenProgram: TOKEN_2022_PROGRAM_ID }) }));
    const jc = withTable(chainWorld());
    scriptJupiterBuy(jc, MINT_22, TOKEN_2022_PROGRAM_ID, A, 1_700_000_000n);
    expect(refused(await buildUnsignedSwap(deps(jc, { jupBuild: viaServer(jserver) }), req({ mint: MINT_22, maxImpactPct: 0.1 }))).code).toBe('impact-above-limit');
    const noImpact = await jupiterServer((q) => ({ body: { ...(jupAnswer(q, { tokenProgram: TOKEN_2022_PROGRAM_ID }) as object), priceImpactPct: undefined } }));
    expect(refused(await buildUnsignedSwap(deps(jc, { jupBuild: viaServer(noImpact) }), req({ mint: MINT_22, maxImpactPct: 0.1 }))).code).toBe('impact-above-limit');

    // the slippage rule uses the request's slippage (1 to 5000 bps): a wider slippage lowers the signed minimum, 5001 is refused
    const wide = ok(await buildUnsignedSwap(deps(world()), req({ slippageBps: 5000 })));
    expect(wide.slippageBps).toBe(5000);
    expect(wide.bound).toMatchObject({ minOut: { baseUnits: floorMin(out, 5000).toString() } });
    expect(refused(await buildUnsignedSwap(deps(world()), req({ slippageBps: 5001 }))).code).toBe('bad-request');
    expect(refused(await buildUnsignedSwap(deps(world()), req({ slippageBps: 0 }))).code).toBe('bad-request');
    expect(refused(await buildUnsignedSwap(deps(world()), req({ maxImpactPct: 50.01 }))).code).toBe('bad-request');
    expect(refused(await buildUnsignedSwap(deps(world()), req({ maxImpactPct: 1.005 }))).code).toBe('bad-request');
  });

  it('FIXR7-T01 a route whose price impact is unknown is refused (impact-above-limit, no bytes) whatever the limit: Jupiter without priceImpactPct, a pump curve with a degenerate reserve', async () => {
    // Jupiter (a Token-2022 mint goes straight to it) answers /build without a priceImpactPct: even the widest limit cannot be checked, so it is refused
    const noImpact = await jupiterServer((q) => ({ body: { ...(jupAnswer(q, { tokenProgram: TOKEN_2022_PROGRAM_ID }) as object), priceImpactPct: undefined } }));
    const jc = withTable(chainWorld());
    scriptJupiterBuy(jc, MINT_22, TOKEN_2022_PROGRAM_ID, A, 1_700_000_000n);
    const jr = refused(await buildUnsignedSwap(deps(jc, { jupBuild: viaServer(noImpact) }), req({ mint: MINT_22, maxImpactPct: 50 })));
    expect(jr.code).toBe('impact-above-limit');
    expect(jr.reason).toMatch(/no price impact/);
    expect(jr).not.toHaveProperty('quote');
    // a pump curve with zero virtual SOL reserves has no measurable impact: refused, and with Jupiter down that refusal is the answer
    const degenerate = withTable(chainWorld());
    degenerate.set(pumpfunIx.deriveBondingCurve(pk(MINT_C)).toBase58(), curveAcct({ vSol: 0n }));
    const pr = refused(await buildUnsignedSwap(deps(degenerate, { jupBuild: jupDown }), req({ maxImpactPct: 50 })));
    expect(pr.code).toBe('impact-above-limit');
    expect(pr.reason).toMatch(/no price impact/);
  });

  it('FIXPUMP-US-T01 a curve quoted in another mint than SOL and a cashback coin are not built on the pump route (notes pump-non-sol-quote, pump-cashback-unsupported); the pump buy carries the 2026-04-28 layout', async () => {
    const server = await jupiterServer((q) => ({ body: jupAnswer(q) }));
    const patched = (f: (d: Buffer) => void): Acct => { const a = curveAcct(); f(a.data); return a; };
    for (const [name, curve, note] of [
      ['USDC-quoted', patched((d) => pk('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v').toBuffer().copy(d, 83)), 'pump-non-sol-quote'],
      ['cashback', patched((d) => { d[82] = 1; }), 'pump-cashback-unsupported'],
    ] as const) {
      const c = withTable(chainWorld());
      c.set(pumpfunIx.deriveBondingCurve(pk(MINT_C)).toBase58(), curve);
      scriptJupiterBuy(c, MINT_C, TOKEN_PROGRAM_ID, A, 1_700_000_000n);
      const q = ok(await buildUnsignedSwap(deps(c, { jupBuild: viaServer(server) }), req()));
      expect([q.route, q.routingNotes], name).toEqual(['jupiter', [note]]);
      expect(programsOf(txOf(q)), name).not.toContain(PUMP_PROGRAM);
    }
    // the pump buy itself: buy_exact_sol_in of 25 bytes ending 01, 18 accounts, NORMAL[0] at 1 and BUYBACK[0] last (Math.random pinned to 0)
    const chain = world();
    const q = ok(await buildUnsignedSwap(deps(chain), req()));
    expect(q.route).toBe('pump');
    const tx = txOf(q);
    const pumpIx = tx.message.compiledInstructions.find((ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58() === PUMP_PROGRAM)!;
    expect(pumpIx.data).toHaveLength(25);
    expect(pumpIx.data[24]).toBe(1);
    const keys = pumpIx.accountKeyIndexes.map((i) => tx.message.staticAccountKeys[i].toBase58());
    expect(keys).toHaveLength(18);
    expect([keys[1], keys[17], keys[16]]).toEqual([PUMP_FEE, PUMP_BUYBACK, pumpfunIx.deriveBondingCurveV2(pk(MINT_C)).toBase58()]);
    expect(q.innerFees.map((f) => f.recipient)).toEqual([PUMP_FEE, PUMP_BUYBACK, pumpfunIx.deriveCreatorVault(pk(CREATOR)).toBase58()]);
  });

  it('WTX-T20 a mayhem-mode curve is not built on the pump route (Jupiter is tried, note mayhem-mode-unsupported); a legacy buy, buy_v2 or sell_v2 discriminator is refused by ext-verify on the wallet path', async () => {
    const server = await jupiterServer((q) => ({ body: jupAnswer(q) }));
    const mayhem = withTable(chainWorld());
    mayhem.set(pumpfunIx.deriveBondingCurve(pk(MINT_C)).toBase58(), curveAcct({ mayhem: true }));
    scriptJupiterBuy(mayhem, MINT_C, TOKEN_PROGRAM_ID, A, 1_700_000_000n);
    const q = ok(await buildUnsignedSwap(deps(mayhem, { jupBuild: viaServer(server) }), req()));
    expect(q.route).toBe('jupiter');
    expect(q.routingNotes).toEqual(['mayhem-mode-unsupported']);
    expect(programsOf(txOf(q))).not.toContain(PUMP_PROGRAM);
    expect(server.seen.length).toBe(1);
    // with Jupiter down the mayhem curve is a refusal, not a pump transaction
    const simsBefore = mayhem.sims.length;
    const stuck = refused(await buildUnsignedSwap(deps(mayhem), req()));
    expect(stuck.code).toBe('build-failed');
    expect(mayhem.sims.length).toBe(simsBefore);                                            // no simulation: nothing was built

    // legacy discriminators: take a built pump buy and a built pump sell, swap the first 8 data bytes, and run the verifier on the wallet path
    const chain = world();
    const buyQuote = ok(await buildUnsignedSwap(deps(chain), req()));
    const held = 5_000_000_000n;
    const sellChain = chainWorld();
    sellChain.set(ataOf(MINT_C), tokenAcct({ mint: MINT_C, owner: OWNER, amount: held }));
    const vSol = 30_000_000_000n; const vTok = 1_073_000_000_000_000n;
    const solOut = pumpSellQuote(vSol, vTok, held)!.net;
    sellChain.deltas.set(OWNER, { lamports: solOut - 9_320n });
    sellChain.deltas.set(ataOf(MINT_C), { tokens: -held });
    const sellQuote = ok(await buildUnsignedSwap(deps(sellChain), req({ side: 'sell', amountLamports: undefined, tokensRaw: held.toString() })));
    const expOf = (qq: WalletQuoteLink, side: 'buy' | 'sell', tokens: bigint | null, c: FakeChain): SwapExpectation => ({
      route: 'pump', side, owner: OWNER, mint: MINT_C, tokenProgram: TOKEN_PROGRAM_ID, slippageBps: 300,
      bound: { kind: 'exact_in', amountIn: BigInt((qq.bound as { amountIn: { baseUnits: string } }).amountIn.baseUnits), minOut: BigInt((qq.bound as { minOut: { baseUnits: string } }).minOut.baseUnits) },
      quotedOut: BigInt(qq.quotedOut!.baseUnits), quotedIn: null, tokensRaw: tokens, cuLimit: qq.priorityFee.cuLimit, cuPriceMicrolamports: qq.priorityFee.cuPriceMicrolamports,
      priorityFeeLamports: BigInt(qq.priorityFee.lamports), networkFeeLamports: 5_000n, rentMinLamports: RENT, rentLamports: BigInt(qq.rentLamports), maxOutflowLamports: BigInt(qq.maxOutflowLamports),
      thirdPartyTransfers: [], balanceLamports: c.balance, maxSpendCapLamports: null, wsolPreAmount: null, creator: CREATOR,
      innerFees: qq.innerFees.map((f) => ({ label: f.label, recipient: f.recipient, address: f.recipient, kind: 'lamports' as const })),
    });
    const vdeps = { rpc: chain, priorityRange: { minPrice: 10_000, maxPrice: 1_000_000 }, maxTxBytes: 1100 };
    const buyBytes = Buffer.from(buyQuote.txBase64, 'base64');
    // the built transactions pass the verifier as they are
    expect(await verifySwapTx(vdeps, buyBytes, expOf(buyQuote, 'buy', null, chain))).toMatchObject({ ok: true });
    expect(await verifySwapTx({ ...vdeps, rpc: sellChain }, Buffer.from(sellQuote.txBase64, 'base64'), expOf(sellQuote, 'sell', held, sellChain))).toMatchObject({ ok: true });
    const patch = (bytes: Buffer, from: readonly number[], to: readonly number[]): Buffer => {
      const out = Buffer.from(bytes);
      const i = out.indexOf(Buffer.from(from));
      expect(i, 'the discriminator is in the transaction').toBeGreaterThan(0);
      Buffer.from(to).copy(out, i);
      return out;
    };
    const BUY = [56, 252, 116, 8, 158, 223, 205, 95]; const SELL = [51, 230, 133, 164, 1, 127, 131, 173];
    const LEGACY_BUY = [102, 6, 61, 18, 1, 218, 235, 234]; const BUY_V2 = [184, 23, 238, 97, 103, 197, 211, 61]; const SELL_V2 = [93, 246, 130, 60, 231, 233, 64, 178];
    for (const [name, disc] of [['buy', LEGACY_BUY], ['buy_v2', BUY_V2]] as const) {
      const r = refused(await verifySwapTx(vdeps, patch(buyBytes, BUY, disc), expOf(buyQuote, 'buy', null, chain)));
      expect(r, name).toMatchObject({ code: 'verify-failed', reason: expect.stringContaining('buy_exact_sol_in') });
    }
    const sv2 = refused(await verifySwapTx({ ...vdeps, rpc: sellChain }, patch(Buffer.from(sellQuote.txBase64, 'base64'), SELL, SELL_V2), expOf(sellQuote, 'sell', held, sellChain)));
    expect(sv2).toMatchObject({ code: 'verify-failed', reason: expect.stringContaining('sell') });
    // the sell discriminator in a buy (or the reverse) is refused too
    expect(refused(await verifySwapTx(vdeps, patch(buyBytes, BUY, SELL), expOf(buyQuote, 'buy', null, chain))).code).toBe('verify-failed');
  });
});

describe('unsigned swap: the rest of the contract', () => {
  const out = curveOut(A);
  const world = (): FakeChain => { const c = withTable(chainWorld()); scriptPumpBuy(c, MINT_C, A, out); return c; };

  it('refuses a malformed request, a sell of nothing, and an unknown or foreign mint', async () => {
    const bads: Array<Partial<WalletQuoteRequest>> = [
      { owner: 'nope' }, { mint: 'nope' }, { mint: OWNER }, { side: 'hold' as never }, { amountLamports: '0' }, { amountLamports: '1.5' }, { amountLamports: undefined },
      { mint: WSOL_MINT, side: 'sell', amountLamports: undefined, pctBps: 5_000 },       // a SELL of wrapped SOL stays a malformed request (a BUY of it is a no-route refusal, A-117: see the mint-check test below)
      { tokensRaw: '5' }, { feeLevel: 'turbo' as never }, { maxSpendLamports: '0' }, { maxSpendLamports: 'x' }, { maxTxBytes: 0 },
      { side: 'sell', amountLamports: undefined }, { side: 'sell', amountLamports: undefined, tokensRaw: '5', pctBps: 100 }, { side: 'sell', amountLamports: undefined, pctBps: 0 }, { side: 'sell', amountLamports: undefined, pctBps: 10_001 },
    ];
    for (const b of bads) {
      const chain = world();
      expect(refused(await buildUnsignedSwap(deps(chain), req(b))).code, JSON.stringify(b)).toBe('bad-request');
      expect(chain.calls, 'nothing is read for a request that is not valid').toEqual([]);
    }
    // a sell of a token the wallet does not hold, or holds at zero
    const none = refused(await buildUnsignedSwap(deps(world()), req({ side: 'sell', amountLamports: undefined, pctBps: 5_000 })));
    expect(none.code).toBe('nothing-to-sell');
    const zero = world().set(ataOf(MINT_C), tokenAcct({ mint: MINT_C, owner: OWNER, amount: 0n }));
    expect(refused(await buildUnsignedSwap(deps(zero), req({ side: 'sell', amountLamports: undefined, tokensRaw: '5' }))).code).toBe('nothing-to-sell');
    // an address that is not a token mint, or does not exist
    expect(refused(await buildUnsignedSwap(deps(world()), req({ mint: fixtureKey(99) }))).code).toBe('no-route');
    const notMint = world().set(fixtureKey(98), sysAcct(1n));
    expect(refused(await buildUnsignedSwap(deps(notMint), req({ mint: fixtureKey(98) }))).code).toBe('no-route');
  });

  it('a sell takes tokensRaw capped at the balance the build reads, or pctBps of it', async () => {
    const held = 9_999_999_999n;
    const sellWorld = (): FakeChain => {
      const c = chainWorld();
      c.set(ataOf(MINT_C), tokenAcct({ mint: MINT_C, owner: OWNER, amount: held }));
      c.deltas.set(OWNER, { lamports: 300_000n });
      c.deltas.set(ataOf(MINT_C), { tokens: -held });
      return c;
    };
    // tokensRaw above the balance is capped at it
    const cappedChain = sellWorld();
    cappedChain.deltas.set(OWNER, { lamports: 300_000n });
    const capped = await buildUnsignedSwap(deps(cappedChain), req({ side: 'sell', amountLamports: undefined, tokensRaw: (held * 1000n).toString() }));
    expect(capped, JSON.stringify(capped)).toMatchObject({ ok: true });
    expect((capped as WalletQuoteOk).quote.bound).toMatchObject({ amountIn: { baseUnits: held.toString() } });
    // pctBps rounds down: 33.33 % of the balance
    const pctChain = sellWorld();
    const pctTokens = (held * 3_333n) / 10_000n;
    pctChain.deltas.set(ataOf(MINT_C), { tokens: -pctTokens });
    pctChain.deltas.set(OWNER, { lamports: 300_000n });
    const pct = await buildUnsignedSwap(deps(pctChain), req({ side: 'sell', amountLamports: undefined, pctBps: 3_333 }));
    expect(pct, JSON.stringify(pct)).toMatchObject({ ok: true });
    expect((pct as WalletQuoteOk).quote.bound).toMatchObject({ amountIn: { baseUnits: pctTokens.toString() } });
    // a percentage that rounds to nothing sells nothing
    const dust = chainWorld().set(ataOf(MINT_C), tokenAcct({ mint: MINT_C, owner: OWNER, amount: 9_999n }));
    const tiny = refused(await buildUnsignedSwap(deps(dust), req({ side: 'sell', amountLamports: undefined, pctBps: 1 })));
    expect(tiny.code).toBe('nothing-to-sell');
  });

  it('falls through to Jupiter when the pump route is refused, lets the request errors through, and reads the rent of a token account once per boot', async () => {
    const server = await jupiterServer((q) => ({ body: jupAnswer(q) }));
    // pump is over the impact limit, Jupiter (impact 0.2 %) is under a limit of 1 %: Jupiter is used and the note says why
    const chain = withTable(chainWorld());
    chain.set(pumpfunIx.deriveBondingCurve(pk(MINT_C)).toBase58(), curveAcct({ vSol: 100_000_000n }));      // a thin curve: a big impact
    scriptJupiterBuy(chain, MINT_C, TOKEN_PROGRAM_ID, A, 1_700_000_000n);
    const q = ok(await buildUnsignedSwap(deps(chain, { jupBuild: viaServer(server) }), req({ maxImpactPct: 1 })));
    expect(q.route).toBe('jupiter');
    expect(q.routingNotes).toEqual(['pump-impact-above-limit']);
    // the rent is read once for the cache of a boot, however many quotes follow
    const cache = createWalletBuildCache();
    const c2 = world();
    ok(await buildUnsignedSwap(deps(c2, { cache }), req()));
    ok(await buildUnsignedSwap(deps(c2, { cache }), req()));
    expect(c2.count('getMinimumBalanceForRentExemption')).toBe(1);
    expect(c2.calls.find((c) => c.method === 'getMinimumBalanceForRentExemption')!.params[0]).toBe(300);
    // the budget's refusal and a timeout surface as they are
    const budget = world();
    const limited = deps(budget, { rpc: { call: async (m: string, p: unknown[]) => { if (m === 'simulateTransaction') throw new RpcBudgetError('daily'); return budget.call(m, p); } } });
    expect(refused(await buildUnsignedSwap(limited, req())).code).toBe('rpc-budget');
    let t = 0;
    const late = deps(world(), { clock: { now: () => (t += 4_000) }, budgetMs: 12_000 });
    expect(refused(await buildUnsignedSwap(late, req())).code).toBe('build-timeout');
  });

  it('a Jupiter table that differs from the chain, or a deactivated one, is refused (alt-mismatch, verify-failed); an owner key found only in a table is refused', async () => {
    const server = await jupiterServer((q) => ({ body: jupAnswer(q, { tokenProgram: TOKEN_2022_PROGRAM_ID }) }));
    const base = (): FakeChain => { const c = chainWorld(); scriptJupiterBuy(c, MINT_22, TOKEN_2022_PROGRAM_ID, A, 1_700_000_000n); return c; };
    const r = req({ mint: MINT_22 });
    // the chain table holds a different address at an index the transaction uses
    const mismatch = base().set(ALT_KEY, altAcct([TABLE_ADDRESSES[1], TABLE_ADDRESSES[0], ...TABLE_ADDRESSES.slice(2)]));
    expect(refused(await buildUnsignedSwap(deps(mismatch, { jupBuild: viaServer(server) }), r)).code).toBe('alt-mismatch');
    // a table Jupiter claims that is not on the chain, a deactivated one, one owned by another program
    expect(refused(await buildUnsignedSwap(deps(base(), { jupBuild: viaServer(server) }), r)).code).toBe('verify-failed');
    const dead = base().set(ALT_KEY, altAcct(TABLE_ADDRESSES, 12_345n));
    expect(refused(await buildUnsignedSwap(deps(dead, { jupBuild: viaServer(server) }), r))).toMatchObject({ code: 'verify-failed', reason: expect.stringContaining('deactivated') });
    const foreign = base().set(ALT_KEY, { ...altAcct(TABLE_ADDRESSES), owner: SYSTEM });
    expect(refused(await buildUnsignedSwap(deps(foreign, { jupBuild: viaServer(server) }), r)).code).toBe('verify-failed');
    // the owner's own accounts sit in the table: the message would hide them in a lookup
    const hiding = base().set(ALT_KEY, altAcct([...TABLE_ADDRESSES, ataOf(MINT_22, TOKEN_2022_PROGRAM_ID), OWNER]));
    const hiddenServer = await jupiterServer((q) => ({ body: jupAnswer(q, { tokenProgram: TOKEN_2022_PROGRAM_ID, claimed: { [ALT_KEY]: [...TABLE_ADDRESSES, ataOf(MINT_22, TOKEN_2022_PROGRAM_ID), OWNER] } }) }));
    expect(refused(await buildUnsignedSwap(deps(hiding, { jupBuild: viaServer(hiddenServer) }), r)).code).toBe('owner-key-in-lookup');
    // no table claimed and none used: a plain static transaction is fine when it fits
    const plain = await jupiterServer((q) => ({ body: jupAnswer(q, { tokenProgram: TOKEN_2022_PROGRAM_ID, noTable: true }) }));
    const chain = base();
    const nq = await buildUnsignedSwap(deps(chain, { jupBuild: viaServer(plain), maxTxBytes: 1132 }), req({ mint: MINT_22, maxTxBytes: 1132 }));
    expect(nq).toMatchObject({ ok: true });
    expect(txOf((nq as WalletQuoteOk).quote).message.addressTableLookups).toEqual([]);
    // the swap instruction of another program, an exact-out discriminator, a non-zero platform fee and another slippage are refused
    const variants: Array<[string, JupAnswerOpts, RegExp]> = [
      ['exact-out discriminator', { tokenProgram: TOKEN_2022_PROGRAM_ID, discriminator: [208, 51, 239, 151, 123, 43, 237, 92] }, /pinned exact-in route/],
      ['unknown discriminator', { tokenProgram: TOKEN_2022_PROGRAM_ID, discriminator: [1, 2, 3, 4, 5, 6, 7, 8] }, /pinned exact-in route/],
      ['platform fee', { tokenProgram: TOKEN_2022_PROGRAM_ID, platformFee: 1 }, /platform fee/],
      ['other slippage', { tokenProgram: TOKEN_2022_PROGRAM_ID, slippage: 299 }, /slippage differs/],
    ];
    for (const [name, o, why] of variants) {
      const s = await jupiterServer((q) => ({ body: jupAnswer(q, o) }));
      const res = refused(await buildUnsignedSwap(deps(withTable(base()), { jupBuild: viaServer(s) }), r));
      expect(res.code, name).toBe('verify-failed');
      expect(res.reason, name).toMatch(why);
    }
  });
});

// ── A-117 (Q-RD3): pasted mints, and the mint checks of every dashboard buy ────────────────────────────────────────────────────

/** A Token-2022 mint account with extensions: the 82-byte base mint padded to 165 bytes, the account type, then TLV entries (type u16, length u16, value). */
function mintAcctExt(program: string, entries: Array<{ type: number; value: Buffer }>, tail: Buffer = Buffer.alloc(0)): Acct {
  const d = Buffer.alloc(166);
  mintAcct(program).data.copy(d, 0);
  d[165] = 1;
  const tlv = entries.map((e) => { const h = Buffer.alloc(4); h.writeUInt16LE(e.type, 0); h.writeUInt16LE(e.value.length, 2); return Buffer.concat([h, e.value]); });
  return { lamports: 1_461_600n, owner: program, data: Buffer.concat([d, ...tlv, tail]) };
}
const EXT_NON_TRANSFERABLE = { type: 9, value: Buffer.alloc(0) };
const EXT_DEFAULT_FROZEN = { type: 6, value: Buffer.from([2]) };
const EXT_DEFAULT_INITIALIZED = { type: 6, value: Buffer.from([1]) };
const EXT_HOOK_WITH_PROGRAM = { type: 14, value: Buffer.concat([Buffer.alloc(32), Buffer.from(bs58.decode(fixtureKey(210)))]) };
const EXT_HOOK_NO_PROGRAM = { type: 14, value: Buffer.concat([Buffer.from(bs58.decode(fixtureKey(211))), Buffer.alloc(32)]) };
const EXT_METADATA_POINTER = { type: 18, value: Buffer.alloc(64, 3) };
const EXT_MINT_CLOSE_AUTHORITY = { type: 3, value: Buffer.alloc(32, 4) };

describe('unsigned swap: pasted mints and the mint checks of a dashboard buy (A-117)', () => {
  // mints the build has never seen: each exists only on the scripted chain of its case
  const FRESH_PUMP = fixtureKey(201);      // classic Token on an open pump curve
  const FRESH_GRAD = fixtureKey(202);      // classic Token whose curve is complete
  const FRESH_PLAIN = fixtureKey(203);     // classic Token with no pump curve at all
  const FRESH_22 = fixtureKey(204);        // Token-2022 with no curve
  const FRESH_22_PUMP = fixtureKey(205);   // Token-2022 on an open curve
  const FRESH_22_EXT = fixtureKey(206);    // Token-2022 whose extensions do not block a buy
  const out = curveOut(A);
  const vdeps = (rpc: FakeChain) => ({ rpc, priorityRange: { minPrice: 10_000, maxPrice: 1_000_000 }, maxTxBytes: 1100 });
  const pumpExpectation = (qq: WalletQuoteLink, mint: string, c: FakeChain): SwapExpectation => ({
    route: 'pump', side: 'buy', owner: OWNER, mint, tokenProgram: TOKEN_PROGRAM_ID, slippageBps: 300,
    bound: { kind: 'exact_in', amountIn: BigInt((qq.bound as { amountIn: { baseUnits: string } }).amountIn.baseUnits), minOut: BigInt((qq.bound as { minOut: { baseUnits: string } }).minOut.baseUnits) },
    quotedOut: BigInt(qq.quotedOut!.baseUnits), quotedIn: null, tokensRaw: null, cuLimit: qq.priorityFee.cuLimit, cuPriceMicrolamports: qq.priorityFee.cuPriceMicrolamports,
    priorityFeeLamports: BigInt(qq.priorityFee.lamports), networkFeeLamports: 5_000n, rentMinLamports: RENT, rentLamports: BigInt(qq.rentLamports), maxOutflowLamports: BigInt(qq.maxOutflowLamports),
    thirdPartyTransfers: [], balanceLamports: c.balance, maxSpendCapLamports: null, wsolPreAmount: null, creator: CREATOR,
    innerFees: qq.innerFees.map((f) => ({ label: f.label, recipient: f.recipient, address: f.recipient, kind: 'lamports' as const })),
  });

  it('RDQ-T05 a mint the bot never saw builds on the pump route with a live curve, on Jupiter when graduated (note pumpswap-direct-disabled) and for a non-pump Token or Token-2022 mint, and the same ext-verify verdicts hold', async () => {
    const server = await jupiterServer((q) => ({ body: jupAnswer(q) }));
    const server22 = await jupiterServer((q) => ({ body: jupAnswer(q, { tokenProgram: TOKEN_2022_PROGRAM_ID }) }));

    // 1. an unknown classic mint with a live curve: the pump route, built from the one chain read, and ext-verify accepts the bytes it built
    const c1 = chainWorld().set(FRESH_PUMP, mintAcct(TOKEN_PROGRAM_ID)).set(pumpfunIx.deriveBondingCurve(pk(FRESH_PUMP)).toBase58(), curveAcct());
    scriptPumpBuy(c1, FRESH_PUMP, A, out);
    const r1 = req({ mint: FRESH_PUMP });
    const q1 = ok(await buildUnsignedSwap(deps(c1), r1));
    expectContractOk(q1, r1);
    expect(q1.route).toBe('pump');
    expect(q1.routingNotes).toEqual([]);
    expect(q1.mint).toBe(FRESH_PUMP);
    expect(q1.bound).toMatchObject({ kind: 'exact_in', amountIn: { baseUnits: A.toString() }, minOut: { baseUnits: floorMin(out, 300).toString(), asset: FRESH_PUMP } });
    expect(programsOf(txOf(q1))).toContain(PUMP_PROGRAM);
    const mintReads = c1.calls.filter((c) => c.method === 'getMultipleAccounts');
    expect(mintReads[0].params[0]).toEqual(expect.arrayContaining([FRESH_PUMP, pumpfunIx.deriveBondingCurve(pk(FRESH_PUMP)).toBase58()]));   // the build's own first read names the unknown mint and its curve
    // the verdicts of ext-verify on this unknown mint are the ones it gives any mint: the built bytes pass, a legacy discriminator or a foreign mint does not
    const bytes1 = Buffer.from(q1.txBase64, 'base64');
    expect(await verifySwapTx(vdeps(c1), bytes1, pumpExpectation(q1, FRESH_PUMP, c1))).toMatchObject({ ok: true });
    const legacy = Buffer.from(bytes1);
    const at = legacy.indexOf(Buffer.from([56, 252, 116, 8, 158, 223, 205, 95]));
    expect(at).toBeGreaterThan(0);
    Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]).copy(legacy, at);
    expect(refused(await verifySwapTx(vdeps(c1), legacy, pumpExpectation(q1, FRESH_PUMP, c1)))).toMatchObject({ code: 'verify-failed', reason: expect.stringContaining('buy_exact_sol_in') });
    expect(refused(await verifySwapTx(vdeps(c1), bytes1, pumpExpectation(q1, MINT_C, c1))).code).toBe('verify-failed');

    // 2. an unknown graduated mint goes to Jupiter with the note pumpswap-direct-disabled: no PumpSwap instruction, and the pool is not even read
    const c2 = withTable(chainWorld()).set(FRESH_GRAD, mintAcct(TOKEN_PROGRAM_ID)).set(pumpfunIx.deriveBondingCurve(pk(FRESH_GRAD)).toBase58(), curveAcct({ complete: true }));
    scriptJupiterBuy(c2, FRESH_GRAD, TOKEN_PROGRAM_ID, A, 1_700_000_000n);
    const r2 = req({ mint: FRESH_GRAD });
    const q2 = ok(await buildUnsignedSwap(deps(c2, { jupBuild: viaServer(server) }), r2));
    expectContractOk(q2, r2);
    expect(q2.route).toBe('jupiter');
    expect(q2.routingNotes).toEqual(['pumpswap-direct-disabled']);
    expect(programsOf(txOf(q2))).not.toContain(PUMPSWAP);
    const poolKey = pumpswapIx.derivePumpSwapCanonicalPool(pk(FRESH_GRAD)).toBase58();
    expect(c2.calls.filter((c) => c.method === 'getMultipleAccounts').some((c) => c.params[0].includes(poolKey))).toBe(false);

    // 3. an unknown classic mint with no pump curve, and unknown Token-2022 mints (with no curve and on an open curve): Jupiter, one attempt each
    const c3 = withTable(chainWorld()).set(FRESH_PLAIN, mintAcct(TOKEN_PROGRAM_ID, 9));
    scriptJupiterBuy(c3, FRESH_PLAIN, TOKEN_PROGRAM_ID, A, 1_700_000_000n);
    const q3 = ok(await buildUnsignedSwap(deps(c3, { jupBuild: viaServer(server) }), req({ mint: FRESH_PLAIN })));
    expect([q3.route, q3.routingNotes]).toEqual(['jupiter', []]);
    expect(q3.quotedOut).toMatchObject({ asset: FRESH_PLAIN, decimals: 9 });
    const c4 = withTable(chainWorld()).set(FRESH_22, mintAcct(TOKEN_2022_PROGRAM_ID));
    scriptJupiterBuy(c4, FRESH_22, TOKEN_2022_PROGRAM_ID, A, 1_700_000_000n);
    const q4 = ok(await buildUnsignedSwap(deps(c4, { jupBuild: viaServer(server22) }), req({ mint: FRESH_22 })));
    expect([q4.route, q4.routingNotes]).toEqual(['jupiter', []]);
    const c5 = withTable(chainWorld()).set(FRESH_22_PUMP, mintAcct(TOKEN_2022_PROGRAM_ID)).set(pumpfunIx.deriveBondingCurve(pk(FRESH_22_PUMP)).toBase58(), curveAcct());
    scriptJupiterBuy(c5, FRESH_22_PUMP, TOKEN_2022_PROGRAM_ID, A, 1_700_000_000n);
    const q5 = ok(await buildUnsignedSwap(deps(c5, { jupBuild: viaServer(server22) }), req({ mint: FRESH_22_PUMP })));
    expect([q5.route, q5.routingNotes]).toEqual(['jupiter', ['pumpportal-not-offered']]);
    // extensions that do not block a buy (a metadata pointer, a close authority, a DefaultAccountState that is not Frozen, a hook with no program) are not refused
    for (const [name, entries] of [
      ['metadata pointer and close authority', [EXT_METADATA_POINTER, EXT_MINT_CLOSE_AUTHORITY]], ['default state initialized', [EXT_DEFAULT_INITIALIZED]],
      ['a hook with no program', [EXT_HOOK_NO_PROGRAM]], ['all of them', [EXT_METADATA_POINTER, EXT_DEFAULT_INITIALIZED, EXT_HOOK_NO_PROGRAM, EXT_MINT_CLOSE_AUTHORITY]],
    ] as const) {
      const c6 = withTable(chainWorld()).set(FRESH_22_EXT, mintAcctExt(TOKEN_2022_PROGRAM_ID, [...entries], Buffer.alloc(12)));
      scriptJupiterBuy(c6, FRESH_22_EXT, TOKEN_2022_PROGRAM_ID, A, 1_700_000_000n);
      const r6 = req({ mint: FRESH_22_EXT });
      const q6 = ok(await buildUnsignedSwap(deps(c6, { jupBuild: viaServer(server22) }), r6));
      expectContractOk(q6, r6);
      expect(q6.route, name).toBe('jupiter');
    }
    expect(server.seen.length + server22.seen.length).toBe(2 + 1 + 1 + 4);   // one Jupiter request per build, never a retry

    // 4. the verdicts of ext-verify on the Jupiter route of an unknown Token-2022 mint are the ones it gives any mint
    const base = (): FakeChain => { const c = chainWorld().set(FRESH_22, mintAcct(TOKEN_2022_PROGRAM_ID)); scriptJupiterBuy(c, FRESH_22, TOKEN_2022_PROGRAM_ID, A, 1_700_000_000n); return c; };
    const r = req({ mint: FRESH_22 });
    const mismatch = base().set(ALT_KEY, altAcct([TABLE_ADDRESSES[1], TABLE_ADDRESSES[0], ...TABLE_ADDRESSES.slice(2)]));
    expect(refused(await buildUnsignedSwap(deps(mismatch, { jupBuild: viaServer(server22) }), r)).code).toBe('alt-mismatch');
    expect(refused(await buildUnsignedSwap(deps(base(), { jupBuild: viaServer(server22) }), r)).code).toBe('verify-failed');       // the table Jupiter claims is not on the chain
    const variants: Array<[string, JupAnswerOpts, RegExp]> = [
      ['exact-out discriminator', { tokenProgram: TOKEN_2022_PROGRAM_ID, discriminator: [208, 51, 239, 151, 123, 43, 237, 92] }, /pinned exact-in route/],
      ['platform fee', { tokenProgram: TOKEN_2022_PROGRAM_ID, platformFee: 1 }, /platform fee/],
      ['other slippage', { tokenProgram: TOKEN_2022_PROGRAM_ID, slippage: 299 }, /slippage differs/],
    ];
    for (const [name, o, why] of variants) {
      const s = await jupiterServer((q) => ({ body: jupAnswer(q, o) }));
      const res = refused(await buildUnsignedSwap(deps(withTable(base()), { jupBuild: viaServer(s) }), r));
      expect([name, res.code]).toEqual([name, 'verify-failed']);
      expect(res.reason, name).toMatch(why);
    }
  });

  it('RDQ-T06 every dashboard buy (a signal\'s or a pasted mint) is refused no-route with a plain reason from the SAME chain read, with no extra RPC call, when the mint is the native mint, is not initialized, is a Token-2022 mint with NonTransferable, DefaultAccountState Frozen or a TransferHook program, or cannot be read; sells are never refused by these rules', async () => {
    const OWN_READ = ['getBalance', 'getMultipleAccounts', 'getMinimumBalanceForRentExemption'];   // the build's own reads, in the order it issues them
    const world = (mint: string, acct: Acct | null): FakeChain => { const c = withTable(chainWorld()); if (acct !== null) c.set(mint, acct); return c; };
    const asked = { jupiter: 0 };
    const jupSpy = async (): Promise<never> => { asked.jupiter++; throw new Error('Jupiter must not be asked for a refused mint'); };
    /** A buy that is refused: no-route, the stated reason, the Engine validator accepts the refusal, and the chain saw exactly the build's own three reads and no simulation. */
    const refusedBuy = async (name: string, mint: string, acct: Acct | null, reason: RegExp): Promise<void> => {
      const chain = world(mint, acct);
      const res = refused(await buildUnsignedSwap(deps(chain, { jupBuild: jupSpy }), req({ mint })));
      expect([name, res.code]).toEqual([name, 'no-route']);
      expect(res.reason, name).toMatch(reason);
      expect(validateWalletQuoteResponse(res).ok, name).toBe(true);
      expect(chain.calls.map((c) => c.method), name).toEqual(OWN_READ);
      expect(chain.count('getMultipleAccounts'), name).toBe(1);
      expect(chain.sims, name).toHaveLength(0);
      expect(asked.jupiter, name).toBe(0);
    };

    // the native mint: refused before any read at all; a SELL of it is still a malformed request
    const native = world(WSOL_MINT, null);
    const nr = refused(await buildUnsignedSwap(deps(native, { jupBuild: jupSpy }), req({ mint: WSOL_MINT })));
    expect(nr.code).toBe('no-route');
    expect(nr.reason).toMatch(/native SOL mint|wrapped SOL/);
    expect(native.calls).toEqual([]);
    expect(refused(await buildUnsignedSwap(deps(world(WSOL_MINT, null)), req({ mint: WSOL_MINT, side: 'sell', amountLamports: undefined, pctBps: 5_000 }))).code).toBe('bad-request');

    // not initialized (both token programs), not found, not a mint, too short to be a mint
    const uninit = (program: string): Acct => { const a = mintAcct(program); a.data[45] = 0; return a; };
    await refusedBuy('uninitialized classic mint', fixtureKey(220), uninit(TOKEN_PROGRAM_ID), /not initialized/);
    await refusedBuy('uninitialized Token-2022 mint', fixtureKey(221), uninit(TOKEN_2022_PROGRAM_ID), /not initialized/);
    await refusedBuy('no such account', fixtureKey(222), null, /not found/);
    await refusedBuy('not a token mint', fixtureKey(223), sysAcct(1n), /not a token mint/);
    await refusedBuy('data too short for a mint', fixtureKey(224), { lamports: 1n, owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(40) }, /could not be read/);

    // Token-2022 extensions: each one that blocks a buy, alone and among harmless ones, and an extension list that cannot be read
    await refusedBuy('NonTransferable', fixtureKey(230), mintAcctExt(TOKEN_2022_PROGRAM_ID, [EXT_NON_TRANSFERABLE]), /non-transferable/);
    await refusedBuy('NonTransferable among harmless ones', fixtureKey(231), mintAcctExt(TOKEN_2022_PROGRAM_ID, [EXT_METADATA_POINTER, EXT_NON_TRANSFERABLE, EXT_MINT_CLOSE_AUTHORITY], Buffer.alloc(8)), /non-transferable/);
    await refusedBuy('DefaultAccountState Frozen', fixtureKey(232), mintAcctExt(TOKEN_2022_PROGRAM_ID, [EXT_DEFAULT_FROZEN]), /start frozen/);
    await refusedBuy('TransferHook with a program', fixtureKey(233), mintAcctExt(TOKEN_2022_PROGRAM_ID, [EXT_METADATA_POINTER, EXT_HOOK_WITH_PROGRAM]), /transfer-hook/);
    await refusedBuy('a cut-off extension entry', fixtureKey(234), mintAcctExt(TOKEN_2022_PROGRAM_ID, [EXT_MINT_CLOSE_AUTHORITY], Buffer.from([9, 0])), /extensions of this mint could not be read/);
    await refusedBuy('a value past the end', fixtureKey(235), mintAcctExt(TOKEN_2022_PROGRAM_ID, [], Buffer.from([18, 0, 64, 0, 1, 2, 3])), /extensions of this mint could not be read/);
    const between = mintAcct(TOKEN_2022_PROGRAM_ID); between.data = Buffer.concat([between.data, Buffer.alloc(38)]);         // 120 bytes: longer than a base mint, shorter than a padded one
    await refusedBuy('a mint that is neither base nor padded to an account', fixtureKey(236), between, /extensions of this mint could not be read/);
    // a classic Token mint is never judged by extensions it cannot have
    const classicOk = world(fixtureKey(237), mintAcct(TOKEN_PROGRAM_ID, 6));
    classicOk.set(pumpfunIx.deriveBondingCurve(pk(fixtureKey(237))).toBase58(), curveAcct());
    scriptPumpBuy(classicOk, fixtureKey(237), A, out);
    expect(ok(await buildUnsignedSwap(deps(classicOk), req({ mint: fixtureKey(237) }))).route).toBe('pump');

    // SELLS are never refused by these rules: the same blocking Token-2022 mints can always be sold (a holder must be able to leave)
    const server = await jupiterServer((q) => ({ body: jupAnswer(q, { tokenProgram: TOKEN_2022_PROGRAM_ID }) }));
    const sellWorld = (mint: string, acct: Acct): FakeChain => {
      const c = world(mint, acct);
      c.set(ataOf(mint, TOKEN_2022_PROGRAM_ID), tokenAcct({ mint, owner: OWNER, amount: 9_000_000n, program: TOKEN_2022_PROGRAM_ID }));
      c.deltas.set(OWNER, { lamports: JUP_QUOTED - 9_320n });
      c.deltas.set(ataOf(mint, TOKEN_2022_PROGRAM_ID), { tokens: -9_000_000n });
      return c;
    };
    const blocking: Array<[string, Acct]> = [
      ['NonTransferable', mintAcctExt(TOKEN_2022_PROGRAM_ID, [EXT_NON_TRANSFERABLE])], ['DefaultAccountState Frozen', mintAcctExt(TOKEN_2022_PROGRAM_ID, [EXT_DEFAULT_FROZEN])],
      ['TransferHook with a program', mintAcctExt(TOKEN_2022_PROGRAM_ID, [EXT_HOOK_WITH_PROGRAM])], ['an unreadable extension list', mintAcctExt(TOKEN_2022_PROGRAM_ID, [], Buffer.from([9, 0]))],
      ['all of them', mintAcctExt(TOKEN_2022_PROGRAM_ID, [EXT_NON_TRANSFERABLE, EXT_DEFAULT_FROZEN, EXT_HOOK_WITH_PROGRAM])],
    ];
    for (const [i, [name, acct]] of blocking.entries()) {
      const mint = fixtureKey(240 + i);
      const sellReq = req({ mint, side: 'sell', amountLamports: undefined, pctBps: 10_000 });
      const sq = ok(await buildUnsignedSwap(deps(sellWorld(mint, acct), { jupBuild: viaServer(server) }), sellReq));
      expectContractOk(sq, sellReq);
      expect([name, sq.route, sq.side]).toEqual([name, 'jupiter', 'sell']);
      expect(sq.bound).toMatchObject({ amountIn: { baseUnits: '9000000', asset: mint } });
      // and the same mint, as a buy, is refused from the same kind of read
      await refusedBuy(`${name} (buy)`, mint, acct, /non-transferable|start frozen|transfer-hook|extensions of this mint could not be read/);
    }
    expect(server.seen.length).toBe(blocking.length);                      // one Jupiter request per sell, none for a refused buy
    // an uninitialized mint is not a holder's mint, and that refusal is not one of the new rules: the old text stays for a sell
    expect(refused(await buildUnsignedSwap(deps(world(fixtureKey(250), uninit(TOKEN_PROGRAM_ID))), req({ mint: fixtureKey(250), side: 'sell', amountLamports: undefined, pctBps: 5_000 }))).reason).toBe('the mint account could not be read');
  });
});
