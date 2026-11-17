/**
 * A-26 on the Jupiter route, end to end against a mock RPC: the real router and the real jupiter.ts run, and the only thing
 * mocked is the HTTP client. The fake network answers Jupiter quote / swap / build / order / execute and the Solana JSON-RPC
 * methods the route uses, and COUNTS every transaction that is sent (sendTransaction on any lane, and Jupiter /execute).
 * Signatures come from the transactions themselves at runtime (A-20); nothing here touches a socket.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import bs58 from 'bs58';
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ http: vi.fn() }));
vi.mock('../lib/http-client', () => ({ fetch: h.http }));
vi.mock('./blockhash-cache', () => ({ getCachedBlockhash: () => null }));
vi.mock('./pumpfun-info', () => ({ getCachedPumpFunInfo: () => undefined, fetchPumpFunInfo: async () => ({ hasData: false }) }));
vi.mock('../logger', () => ({ log: vi.fn(), logOk: vi.fn(), logWarn: vi.fn(), logErr: vi.fn(), logDbg: vi.fn(), setBroadcast: vi.fn(), emitEvent: vi.fn() }));

import { CONFIG, botDataDir } from '../config';
import { invalidateRebatesCache } from '../data/rebate-settings';
import { logWarn } from '../logger';
import { computeBudgetFeeLamports } from './compute-budget';
import {
  executeWithRetry, jupQuote, jupiterImpactPct, jupSwap,
  JUP_ERROR_BODY_CHARS, JUP_MAX_SLIPPAGE_BPS, JupiterNoRouteError, JupiterRequestError, JupiterUnavailableError, jupSlippageBps,
  JupiterExecuteError, JupiterOrderRefusal, ORDER_NEW_ACCOUNT_RENT_MAX, ORDER_PRIORITY_FEE_MAX_FACTOR, jupiterOrderImpactPct, rpcUrlWithRebate,
} from './jupiter';
import { PUMPPORTAL_PRIORITY_FEE_MAX_FACTOR } from './tx-verify';
import { ImpactCapError, PreSignRefusal, RouterSendError, smartBuy, smartSell, type SignedTx } from './router';
import { createSendContext } from './send-context';

const wallet = Keypair.fromSeed(new Uint8Array(32).fill(1));
const PLAIN_MINT = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();   // not a 'pump' vanity mint: Jupiter is the only route
const SOL = CONFIG.SOL_MINT;

// ── the fake network ─────────────────────────────────────────────────────────────────────────────

interface Net {
  /** every sendTransaction call, on every lane */
  sends: Array<{ url: string; sig: string }>;
  /** signatures posted to Jupiter /execute */
  executes: string[];
  quotes: number;
  swaps: number;
  builds: number;
  orders: number;
  /** distinct signatures in order of first appearance on any send path (sendTransaction or /execute) */
  sigOrder: string[];
  events: string[];
  // knobs
  priceImpactPct: string | number | undefined;
  swapLastValid: number;
  buildLastValid: number;
  orderLastValid: number;
  /** per distinct signature (in order of first appearance): 'ok', 'fail' (every lane errors) or an error message */
  sendPlan: string[];
  /** same for Jupiter /execute: 'ok' or 'Failed' */
  executePlan: string[];
  // FIX-BUY
  /** the computeBudgetInstructions of the /swap/v2/build answer */
  buildCb: Array<{ programId: string; accounts: never[]; data: string }>;
  /** what simulateTransaction answers: a value, an error on every lane ('error', today's answer to an unknown method) or nothing ('hang') */
  sim: { err: unknown; logs: string[]; unitsConsumed: unknown } | 'error' | 'hang';
  /** answers used first, one per simulateTransaction call, before `sim` (FIX-BUY review) */
  simPlan: Array<{ err: unknown; logs: string[]; unitsConsumed: unknown }>;
  /** every simulateTransaction call: the decoded transaction and its config */
  sims: Array<{ tx: VersionedTransaction; cfg: any }>;
  /** every transaction handed to sendTransaction, decoded */
  txs: VersionedTransaction[];
  /** also write 'simulate' into `events` */
  traceSims: boolean;
  // FIX-BUY2
  /** answers used first, one per request whose URL contains the key (e.g. '/swap/v2/build'), before the default answer */
  jupPlan: Record<string, JupAnswer[]>;
  /** extra bytes of data in the /swap/v2/build swap instruction (FIX-BUY2 item 3: enough of them puts the transaction over the packet) */
  buildExtra: number;
  // FIX-BUY2 item 7
  /** the accounts the order simulation sees: before (getMultipleAccounts) and after (simulateTransaction accounts); absent = an unchanged system account */
  chain: Map<string, { pre: unknown; post: unknown }>;
  /** what /swap/v2/order answers, from its query (default: a good order for the side, see goodOrder) */
  order: (q: URLSearchParams) => Record<string, unknown>;
  /** the /order price impact in PERCENT (Jupiter's priceImpact) */
  orderImpact: string | number | undefined;
  /** every /swap/v2/order query and every /swap/v2/execute body, in order */
  orderQueries: URLSearchParams[];
  executeBodies: Array<{ signedTransaction: string; requestId: string }>;
}
/** A scripted Jupiter answer: an HTTP status with a JSON (or text) body and optional headers, or 'hang' (no answer: a timeout) or 'throw'. */
type JupAnswer = { status: number; body: unknown; headers?: Record<string, string> } | 'throw';
let net: Net;

const res = (body: unknown, status = 200, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  headers: { get: (n: string): string | null => headers[n.toLowerCase()] ?? null },
});
const sigFromBase64 = (b64: string): string => bs58.encode(Buffer.from(b64, 'base64').subarray(1, 65));   // one signature: compact-u16 count is 1 byte
const freshBlockhash = (): string => Keypair.generate().publicKey.toBase58();

function unsignedTxBase64(payer = wallet.publicKey): string {
  const msg = new TransactionMessage({
    payerKey: payer, recentBlockhash: freshBlockhash(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1_000 })],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

// ── FIX-BUY2 item 7: the /swap/v2/order fixtures ───────────────────────────────────────────────────────────────────────────────────
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** The owner's token account of PLAIN_MINT, and the pool the order pays (the order transaction writes both). */
const OWNER_TOKEN_ACC = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
const POOL = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey;
/** Jupiter's gasless sponsor (the fee payer of a gasless order). */
const GASLESS_SPONSOR = new PublicKey('gasTzr94Pmp4Gf8vknQnqxeYxdgwFjbgdJa4msYRpnB');

/** A system account as getMultipleAccounts / simulateTransaction return it (encoding base64). */
function sysAccount(lamports: number): Record<string, unknown> {
  return { lamports, owner: SystemProgram.programId.toBase58(), data: ['', 'base64'], executable: false, rentEpoch: 0, space: 0 };
}
/** An SPL token account (base layout, 165 bytes) of `mint` owned by `owner`. */
function tokenAccount(mint: string, owner: string, amount: bigint, o: { delegate?: string; lamports?: number } = {}): Record<string, unknown> {
  const d = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(d, 0);
  new PublicKey(owner).toBuffer().copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  if (o.delegate !== undefined) { d.writeUInt32LE(1, 72); new PublicKey(o.delegate).toBuffer().copy(d, 76); }
  d[108] = 1;                                                            // initialized
  return { lamports: o.lamports ?? 1_488_440, owner: TOKEN_PROGRAM, data: [d.toString('base64'), 'base64'], executable: false, rentEpoch: 0, space: 165 };
}
/** An unsigned order transaction: the owner pays the pool and its token account is written; options make it gasless, co-signed or priced. */
function orderTxBase64(o: { payer?: PublicKey; coSigner?: PublicKey; cuPrice?: number; cuLimit?: number } = {}): string {
  const ixs: TransactionInstruction[] = [];
  if (o.cuLimit !== undefined) ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: o.cuLimit }));
  if (o.cuPrice !== undefined) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: o.cuPrice }));
  ixs.push(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: POOL, lamports: 1_000 }));
  ixs.push(new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM), data: Buffer.from([17]),
    keys: [{ pubkey: new PublicKey(OWNER_TOKEN_ACC), isSigner: false, isWritable: true }, ...(o.coSigner ? [{ pubkey: o.coSigner, isSigner: true, isWritable: false }] : [])],
  }));
  const msg = new TransactionMessage({ payerKey: o.payer ?? wallet.publicKey, recentBlockhash: freshBlockhash(), instructions: ixs }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}
/** A good /swap/v2/order answer (Jupiter's documented shape: router metis, lastValidBlockHeight a STRING, priceImpact in percent). */
function goodOrder(q: URLSearchParams, tx: string = orderTxBase64()): Record<string, unknown> {
  return {
    transaction: tx, requestId: `req-${net.orders}`, inAmount: q.get('amount'), outAmount: '777000', otherAmountThreshold: '753690',
    router: 'metis', mode: 'manual', swapType: 'aggregator', feeBps: 50, gasless: false, signatureFeePayer: wallet.publicKey.toBase58(),
    lastValidBlockHeight: String(net.orderLastValid), slippageBps: Number(q.get('slippageBps')),
    ...(net.orderImpact === undefined ? {} : { priceImpact: net.orderImpact }),
  };
}
/** The chain an order simulation sees for a good trade: a buy spends 0.05 SOL and the fee for 777 000 tokens; a sell gives 1 000 tokens for SOL. */
function orderChain(side: 'buy' | 'sell', o: { spend?: number; got?: bigint; sold?: bigint; delegate?: string } = {}): void {
  const owner = wallet.publicKey.toBase58();
  net.chain.clear();
  if (side === 'buy') {
    net.chain.set(owner, { pre: sysAccount(1_000_000_000), post: sysAccount(1_000_000_000 - (o.spend ?? 50_005_000)) });
    net.chain.set(OWNER_TOKEN_ACC, { pre: tokenAccount(PLAIN_MINT, owner, 0n), post: tokenAccount(PLAIN_MINT, owner, o.got ?? 777_000n, { delegate: o.delegate }) });
  } else {
    net.chain.set(owner, { pre: sysAccount(10_000_000), post: sysAccount(10_000_000 + 772_000) });
    net.chain.set(OWNER_TOKEN_ACC, { pre: tokenAccount(PLAIN_MINT, owner, 1_000n), post: tokenAccount(PLAIN_MINT, owner, 1_000n - (o.sold ?? 1_000n), { delegate: o.delegate }) });
  }
}

function noteSig(sig: string): number {
  let i = net.sigOrder.indexOf(sig);
  if (i < 0) {
    net.sigOrder.push(sig);
    net.events.push(`send:${sig}`);
    i = net.sigOrder.length - 1;
  }
  return i;
}

async function fakeHttp(url: string, init: { method?: string; body?: string } = {}): Promise<any> {
  const u = String(url);
  for (const [part, queue] of Object.entries(net.jupPlan)) {
    if (!u.includes(part) || queue.length === 0) continue;
    const a = queue.shift()!;
    if (a === 'throw') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    if (part.includes('/swap/v1/quote')) net.quotes++;
    if (part.includes('/swap/v2/build')) net.builds++;
    if (part.includes('/swap/v1/swap')) net.swaps++;
    if (part.includes('/swap/v2/order')) net.orders++;
    return res(a.body, a.status, a.headers);
  }
  if (u.includes('/swap/v1/quote')) {
    net.quotes++;
    const q = new URL(u).searchParams;
    return res({
      inputMint: q.get('inputMint'), outputMint: q.get('outputMint'), inAmount: q.get('amount'), outAmount: '777000',
      slippageBps: Number(q.get('slippageBps')), ...(net.priceImpactPct === undefined ? {} : { priceImpactPct: net.priceImpactPct }),
    });
  }
  if (u.includes('/swap/v1/swap')) {
    net.swaps++;
    return res({ swapTransaction: unsignedTxBase64(), lastValidBlockHeight: net.swapLastValid });
  }
  if (u.includes('/swap/v2/build')) {
    net.builds++;
    const q = new URL(u).searchParams;
    return res({
      // FIX-BUY2 item 2: the quote of the route (Jupiter's documented /build fields); outAmount differs from the v1 quote's 777000 on purpose
      inputMint: q.get('inputMint'), outputMint: q.get('outputMint'), inAmount: q.get('amount'), outAmount: '888000', otherAmountThreshold: '861360',
      swapMode: 'ExactIn', slippageBps: Number(q.get('slippageBps')), ...(net.priceImpactPct === undefined ? {} : { priceImpactPct: net.priceImpactPct }),
      computeBudgetInstructions: net.buildCb, setupInstructions: [], cleanupInstruction: null, otherInstructions: [], tipInstruction: null,
      swapInstruction: {
        programId: SystemProgram.programId.toBase58(),
        accounts: [{ pubkey: wallet.publicKey.toBase58(), isSigner: true, isWritable: true }, { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: false, isWritable: true }],
        data: Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.from(new BigUint64Array([1_000n]).buffer), Buffer.alloc(net.buildExtra)]).toString('base64'),
      },
      addressesByLookupTableAddress: null,
      blockhashWithMetadata: { blockhash: Array.from(Keypair.generate().publicKey.toBytes()), lastValidBlockHeight: net.buildLastValid },
    });
  }
  if (u.includes('/swap/v2/order')) {
    net.orders++;
    const q = new URL(u).searchParams;
    net.orderQueries.push(q);
    return res(net.order(q));
  }
  if (u.includes('/swap/v2/execute')) {
    const body = JSON.parse(String(init.body));
    net.executeBodies.push(body);
    const sig = sigFromBase64(body.signedTransaction);
    const plan = net.executePlan[noteSig(sig)] ?? 'ok';
    net.executes.push(sig);
    if (plan === 'ok') return res({ signature: sig, status: 'Success', code: 0 });
    if (plan === 'Failed') return res({ status: 'Failed', error: 'swap failed on-chain' });
    return res({ signature: sig, status: 'Failed', code: Number(plan), error: 'Transaction expired' });   // a numeric plan is /execute's code
  }
  // JSON-RPC
  const body = JSON.parse(String(init.body));
  switch (body.method) {
    case 'simulateTransaction': {
      net.sims.push({ tx: VersionedTransaction.deserialize(Buffer.from(body.params[0], 'base64')), cfg: body.params[1] });
      if (net.traceSims) net.events.push('simulate');
      const sim = net.simPlan.length > 0 ? net.simPlan.shift()! : net.sim;
      if (sim === 'hang') return new Promise(() => undefined);
      if (sim === 'error') return res({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: `unexpected method ${body.method}` } });
      const wanted: string[] | undefined = body.params[1]?.accounts?.addresses;
      const accounts = wanted === undefined || sim.err ? null : wanted.map((a) => { const e = net.chain.get(a); return e === undefined ? sysAccount(1_000_000) : e.post; });
      return res({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: { err: sim.err, logs: sim.logs, accounts, unitsConsumed: sim.unitsConsumed, returnData: null } } });
    }
    case 'sendTransaction': {
      const sig = sigFromBase64(body.params[0]);
      const plan = net.sendPlan[noteSig(sig)] ?? 'ok';
      net.txs.push(VersionedTransaction.deserialize(Buffer.from(body.params[0], 'base64')));
      net.sends.push({ url: u, sig });
      if (plan === 'ok') return res({ jsonrpc: '2.0', id: body.id, result: sig });
      return res({ jsonrpc: '2.0', id: body.id, error: { code: -32002, message: plan === 'fail' ? 'node is unhealthy' : plan } });
    }
    case 'getSignatureStatuses': return res({ jsonrpc: '2.0', id: 1, result: { value: [{ confirmationStatus: 'confirmed', err: null }] } });
    case 'getLatestBlockhash': return res({ jsonrpc: '2.0', id: 1, result: { value: { blockhash: freshBlockhash(), lastValidBlockHeight: 123_456 } } });
    case 'getBlockHeight': return res({ jsonrpc: '2.0', id: 1, result: 50_000 });
    case 'getAccountInfo': return res({ jsonrpc: '2.0', id: 1, result: { value: null } });
    case 'getMultipleAccounts': return res({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: (body.params[0] as string[]).map((a) => { const e = net.chain.get(a); return e === undefined ? sysAccount(1_000_000) : e.pre; }) } });
    default: return res({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: `unexpected method ${body.method}` } });
  }
}

const saved: Record<string, unknown> = {};
function setConfig(over: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(over)) {
    if (!(k in saved)) saved[k] = (CONFIG as any)[k];
    (CONFIG as any)[k] = v;
  }
}

beforeEach(() => {
  net = {
    sends: [], executes: [], quotes: 0, swaps: 0, builds: 0, orders: 0, sigOrder: [], events: [],
    priceImpactPct: '0.0123', swapLastValid: 777_001, buildLastValid: 777_002, orderLastValid: 777_003, sendPlan: [], executePlan: [],
    buildCb: [], sim: 'error', simPlan: [], sims: [], txs: [], traceSims: false, jupPlan: {}, buildExtra: 0,
    chain: new Map(), order: (q) => goodOrder(q), orderImpact: '0.1', orderQueries: [], executeBodies: [],
  };
  h.http.mockReset();
  h.http.mockImplementation(fakeHttp);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) (CONFIG as any)[k] = v;
  for (const k of Object.keys(saved)) delete saved[k];
  vi.useRealTimers();
});

const uniqueSends = (): string[] => [...new Set(net.sends.map((s) => s.sig))];
const settle = async <T>(p: Promise<T>): Promise<T | unknown> => p.catch((e) => e);

/** A SetComputeUnitPrice as the /swap/v2/build answer lists it. */
const cuPriceApiIx = (microLamports: number): { programId: string; accounts: never[]; data: string } => {
  const ix = ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
  return { programId: ix.programId.toBase58(), accounts: [], data: Buffer.from(ix.data).toString('base64') };
};
/** The SetComputeUnitLimit and SetComputeUnitPrice values a transaction carries, in order. */
function budgetOf(tx: VersionedTransaction): { limits: number[]; prices: bigint[] } {
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const out = { limits: [] as number[], prices: [] as bigint[] };
  for (const ix of tx.message.compiledInstructions) {
    if (keys[ix.programIdIndex] !== ComputeBudgetProgram.programId.toBase58()) continue;
    const d = Buffer.from(ix.data);
    if (d[0] === 2) out.limits.push(d.readUInt32LE(1));
    if (d[0] === 3) out.prices.push(d.readBigUInt64LE(1));
  }
  return out;
}
/** A failing simulation that is not about SOL (a DEX's slippage error): PreSignRefusal 'simulation-failed'. */
const SIM_SLIPPAGE = { err: { InstructionError: [4, { Custom: 6001 }] }, logs: ['Program log: Error: slippage tolerance exceeded'], unitsConsumed: 150_000 };
/** The slippageBps query value of every request whose URL contains `part` (since the last mockClear), in order. */
const requestedBps = (part: string): number[] => h.http.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(part))
  .map((u) => Number(new URL(u).searchParams.get('slippageBps')));
/** 2jeX: the System program's own log when the wrap transfer finds too little SOL. */
const INSUFFICIENT_LOGS = [
  'Program 11111111111111111111111111111111 invoke [1]',
  'Transfer: insufficient lamports 87517263, need 100000000',
  'Program 11111111111111111111111111111111 failed: custom program error: 0x1',
];

describe('Jupiter route impact unit (A-26)', () => {
  it('A26 jupiterImpactPct reads priceImpactPct as a fraction and returns percent; absent or unparseable is null', () => {
    expect(jupiterImpactPct({ priceImpactPct: '0.0123' })).toBeCloseTo(1.23, 10);
    expect(jupiterImpactPct({ priceImpactPct: 0.02 })).toBeCloseTo(2, 10);
    expect(jupiterImpactPct({ priceImpactPct: '-0.005' })).toBeCloseTo(0.5, 10);
    expect(jupiterImpactPct({ priceImpactPct: '0' })).toBe(0);
    for (const bad of [undefined, null, '', 'abc', Number.NaN, {}, []]) {
      expect(jupiterImpactPct({ priceImpactPct: bad }), String(bad)).toBeNull();
    }
    expect(jupiterImpactPct(null)).toBeNull();
    expect(jupiterImpactPct(undefined)).toBeNull();
  });
});

/** A Jupiter key for a test (FIX-BUY2: every Jupiter request is keyed; without one nothing is requested). */
const testKey = (): string => `jk${randomBytes(8).toString('hex')}`;

describe('Jupiter RPC lane (no Sender URL or anti-MEV off: /swap/v2/build, no tip, multi-RPC send) through the router', () => {
  // FIX-BUY2 item 4: without a Sender URL the trade is the /swap/v2/build route on the RPC lane (every Jupiter request is keyed, item 1)
  beforeEach(() => { setConfig({ JUPITER_API_KEY: testKey(), HELIUS_SENDER_URL: '' }); });

  it('A26 onSigned runs after signing and before the first sendTransaction, with the build answer bound; one transaction is sent', async () => {
    const seen: SignedTx[] = [];
    const r = await smartBuy(wallet, PLAIN_MINT, 0.05, {
      onSigned: async (s) => { net.events.push(`onSigned:${s.sig}`); seen.push(s); },
    });
    expect(r.route).toBe('jupiter');
    expect(r.sent).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ sig: r.sig, lastValidBlockHeight: 777_002, route: 'jupiter' });
    expect(net.events[0]).toBe(`onSigned:${r.sig}`);                   // the callback came first ...
    expect(net.events[1]).toBe(`send:${r.sig}`);                       // ... and only then did anything leave
    expect(uniqueSends()).toEqual([r.sig]);                            // one transaction, blasted to every RPC lane
    expect(net.sends.length).toBeGreaterThanOrEqual(1);
    expect(r.sigs).toEqual([r.sig]);
    expect(r.tokensOutQuoted).toBe(888_000n);                          // the build's own outAmount (FIX-BUY2 item 2)
    expect(net.sends.some((x) => x.url.includes('sender'))).toBe(false);
  });

  it('A26 a throw from onSigned aborts: nothing is sent, nothing is retried, and the callback error comes back unchanged', async () => {
    const boom = new Error('pending-buy write failed');
    const err = await settle(smartBuy(wallet, PLAIN_MINT, 0.05, { onSigned: async () => { throw boom; } }));
    expect(err).toBe(boom);
    expect(net.sends).toEqual([]);
    expect(net.executes).toEqual([]);
    expect(net.builds).toBe(1);                      // one build, no retry after the abort
    expect(net.swaps).toBe(0);
  });

  it('A26 buildOnly: built and signed, never sent, onSigned never called, sent false with the would-be signature', async () => {
    const onSigned = vi.fn(async () => {});
    const buy = await smartBuy(wallet, PLAIN_MINT, 0.05, { buildOnly: true, onSigned });
    const sell = await smartSell(wallet, PLAIN_MINT, 1_000n, { buildOnly: true, onSigned });
    for (const r of [buy, sell]) {
      expect(r.route).toBe('jupiter');
      expect(r.sent).toBe(false);
      expect(r.sigs).toBeUndefined();
      expect(bs58.decode(r.sig)).toHaveLength(64);
    }
    expect(buy.sig).not.toBe(sell.sig);
    expect(net.sends).toEqual([]);
    expect(onSigned).not.toHaveBeenCalled();
    expect(net.builds).toBe(2);
    expect(net.swaps).toBe(0);
  });

  it('A26 maxImpactPct: a build whose impact is above the cap is refused before signing, with no retry; at or under the cap it goes through', async () => {
    net.priceImpactPct = '0.0123';                                       // 1.23 %
    const err = await settle(smartBuy(wallet, PLAIN_MINT, 0.05, { maxImpactPct: 1 }));
    expect(err).toBeInstanceOf(ImpactCapError);
    expect((err as ImpactCapError).refused).toHaveLength(1);
    expect((err as ImpactCapError).refused[0].route).toBe('jupiter');
    expect((err as ImpactCapError).refused[0].impactPct).toBeCloseTo(1.23, 6);
    expect(net.sends).toEqual([]);
    expect(net.sims).toEqual([]);                                       // refused before the transaction was even measured
    expect(net.builds).toBe(1);                                         // and not retried at a higher slippage

    expect((await smartBuy(wallet, PLAIN_MINT, 0.05, { maxImpactPct: 1.23 })).sent).toBe(true);   // exactly the cap passes
    expect(uniqueSends()).toHaveLength(1);

    // a build that does not state its impact cannot be shown to be under the cap: refused (fail closed)
    net.priceImpactPct = undefined;
    const blind = await settle(smartSell(wallet, PLAIN_MINT, 1_000n, { maxImpactPct: 50 }));
    expect(blind).toBeInstanceOf(ImpactCapError);
    expect((blind as ImpactCapError).refused[0].impactPct).toBeNull();
    expect(uniqueSends()).toHaveLength(1);                              // still only the one send from before
    // without a cap the missing field does not matter
    expect((await smartSell(wallet, PLAIN_MINT, 1_000n)).sent).toBe(true);
  });

  it('A26 a retry after a failed send is a second send with its own onSigned; singleSend turns it into one send and a RouterSendError', async () => {
    vi.useFakeTimers();
    // attempt 1: every RPC lane refuses the transaction (it may or may not have reached a validator); attempt 2 would succeed
    net.sendPlan = ['fail'];
    const seen: SignedTx[] = [];
    const run = smartBuy(wallet, PLAIN_MINT, 0.05, { onSigned: async (s) => { seen.push(s); } });
    await vi.advanceTimersByTimeAsync(5_000);
    const r = await run;
    expect(net.builds).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen[0].sig).not.toBe(seen[1].sig);
    expect(uniqueSends()).toEqual(seen.map((s) => s.sig));              // both transactions went out
    expect(r.sig).toBe(seen[1].sig);
    expect(r.sigs).toEqual(seen.map((s) => s.sig));                     // the caller is told about BOTH signatures

    // singleSend: the first send failed, so there is no second one
    net = { ...net, sends: [], sigOrder: [], events: [], builds: 0, swaps: 0, quotes: 0, sendPlan: ['fail'] };
    const seen2: SignedTx[] = [];
    const run2 = settle(smartBuy(wallet, PLAIN_MINT, 0.05, { singleSend: true, onSigned: async (s) => { seen2.push(s); } }));
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await run2;
    expect(err).toBeInstanceOf(RouterSendError);
    expect((err as RouterSendError).sigs).toEqual(seen2.map((s) => s.sig));
    expect((err as RouterSendError).sigs).toHaveLength(1);
    expect((err as Error).message).toMatch(/All RPCs failed to send transaction/);
    expect(net.builds).toBe(1);
    expect(uniqueSends()).toEqual([seen2[0].sig]);
  });

  it('A26 a send that was confirmed as reverted is a RouterSendError with the signature (sells wait for the confirmation)', async () => {
    h.http.mockImplementation(async (url: string, init: { method?: string; body?: string } = {}) => {
      const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : null;
      if (body?.method === 'getSignatureStatuses') {
        return res({ jsonrpc: '2.0', id: 1, result: { value: [{ confirmationStatus: 'confirmed', err: { InstructionError: [1, { Custom: 6001 }] } }] } });
      }
      return fakeHttp(url, init);
    });
    const err = await settle(smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true }));
    expect(err).toBeInstanceOf(RouterSendError);
    expect((err as RouterSendError).sigs).toEqual(uniqueSends());
    expect((err as RouterSendError).sigs).toHaveLength(1);
    expect((err as Error).message).toMatch(/reverted on-chain/);
    expect(net.builds).toBe(1);                      // not retried, no legacy fallback, no second route
    expect(net.swaps).toBe(0);
  });

  it('A26 without a send context nothing changes: executeWithRetry returns { sig, quote } after one send', async () => {
    const { sig, quote } = await executeWithRetry(wallet, SOL, PLAIN_MINT, 50_000_000, 300, 3, true, 100_000, false);
    expect(uniqueSends()).toEqual([sig]);
    expect(quote.outAmount).toBe('888000');
    expect(net.builds).toBe(1);
    const q = { inputMint: SOL, outputMint: PLAIN_MINT, inAmount: '50000000', slippageBps: 300 };
    const sig2 = await jupSwap(wallet, q, true, 100_000, { awaitConfirm: true });
    expect(uniqueSends()).toEqual([sig, sig2]);
  });

  it('FIXBUY-T10 (rewritten, FIX-BUY2 item 4) the legacy /swap runs only as the fallback: a normal trade never asks for it; after a /build outage it is one /swap where Jupiter sets the limit (dynamicComputeUnitLimit) and the owner\'s priority fee, unsimulated as before', async () => {
    vi.useFakeTimers();
    h.http.mockClear();
    const normal = await smartBuy(wallet, PLAIN_MINT, 0.05, { priorityFee: 123_456 });
    expect(normal.sent).toBe(true);
    expect(net.swaps).toBe(0);
    expect(net.quotes).toBe(0);
    // /build has no answer: ONE v1 quote and ONE legacy /swap
    net.jupPlan['/swap/v2/build'] = ['throw'];
    net.sims = [];
    h.http.mockClear();
    const run = smartBuy(wallet, PLAIN_MINT, 0.05, { priorityFee: 123_456 });
    await vi.advanceTimersByTimeAsync(5_000);
    const r = await run;
    expect(r.sent).toBe(true);
    expect(net.swaps).toBe(1);
    const call = h.http.mock.calls.find((c) => String(c[0]).includes('/swap/v1/swap'));
    expect(JSON.parse(String((call?.[1] as { body?: string } | undefined)?.body))).toMatchObject({ dynamicComputeUnitLimit: true, prioritizationFeeLamports: 123_456, wrapAndUnwrapSol: true });
    expect(net.sims).toEqual([]);                                       // the legacy /swap is Jupiter's own transaction: nothing measured
  });

  // ── FIX-BUY2 item 4: the anti-MEV-off lane is built from /build too ──────────────────────────────────────────────────────────────
  it('FIXBUY2-T18 anti-MEV off (the default setting) or no Sender URL: one /build, no /swap/v1/quote, no tip, a multi-RPC send, Jupiter\'s price ignored, the signed price floor(priorityFee x 1e6 / limit) and a fee of at most priorityFee', async () => {
    net.buildCb = [cuPriceApiIx(9)];                                     // Jupiter's own price: not used on this lane
    net.sim = { err: null, logs: [], unitsConsumed: 270_000 };
    net.traceSims = true;
    for (const [opts, config] of [[{ antiMev: false }, {}], [{}, { HELIUS_SENDER_URL: '' }]] as const) {
      setConfig({ HELIUS_SENDER_URL: 'http://127.0.0.1:9/fast', ...config });
      net.sends = []; net.sigOrder = []; net.events = []; net.txs = []; net.sims = []; net.builds = 0; net.quotes = 0; net.swaps = 0;
      const r = await smartBuy(wallet, PLAIN_MINT, 0.05, { ...opts, priorityFee: 123_456, singleSend: true, onSigned: async (s) => { net.events.push(`onSigned:${s.sig}`); } });
      expect(r.sent).toBe(true);
      expect(net.builds).toBe(1);
      expect(net.quotes).toBe(0);
      expect(net.swaps).toBe(0);
      expect(net.events).toEqual(['simulate', `onSigned:${r.sig}`, `send:${r.sig}`]);   // measured before anything is journalled or sent
      expect(net.sends.length).toBeGreaterThan(0);
      expect(net.sends.some((x) => x.url.includes('127.0.0.1:9') || x.url.includes('sender'))).toBe(false);   // the multi-RPC blast, not Sender
      const tx = net.txs[0];
      expect(tx.message.staticAccountKeys.some((k) => CONFIG.HELIUS_TIP_ACCOUNTS.includes(k.toBase58()))).toBe(false);   // no tip
      // 270 000 units x 1.2 = 324 000; floor(123 456 x 1e6 / 324 000) = 381 037 micro-lamports; the fee rounds up to exactly the setting
      expect(budgetOf(tx)).toEqual({ limits: [324_000], prices: [381_037n] });
      expect(computeBudgetFeeLamports(tx)).toEqual({ ok: true, lamports: 123_456n });
      // the measured transaction carries the same fee rule at the 1 400 000-unit maximum, and is otherwise the same transaction
      expect(budgetOf(net.sims[0].tx)).toEqual({ limits: [1_400_000], prices: [88_182n] });
      expect((computeBudgetFeeLamports(net.sims[0].tx) as { lamports: bigint }).lamports <= 123_456n).toBe(true);
      expect(tx.message.compiledInstructions.slice(2)).toEqual(net.sims[0].tx.message.compiledInstructions.slice(2));
    }
  });

  it('FIXBUY2-T18 the RPC lane\'s fee never exceeds the owner\'s setting, at any measured limit: fee 0 signs a zero price; the setting\'s own maximum (5 000 000 lamports) bounds it', async () => {
    for (const [priorityFee, units, limit, price, fee] of [
      [100_000, 150_000, 200_000, 500_000n, 100_000n],                   // a light route at the 200 000 floor
      [100_000, 1_300_000, 1_400_000, 71_428n, 100_000n],                // the runtime maximum
      [0, 150_000, 200_000, 0n, 0n],                                     // no priority fee at all
      [9_000_000, 150_000, 200_000, 25_000_000n, 5_000_000n],            // above the setting's validated range: capped at 5 000 000 lamports
    ] as const) {
      net.txs = []; net.sim = { err: null, logs: [], unitsConsumed: units };
      await smartSell(wallet, PLAIN_MINT, 1_000n, { priorityFee, singleSend: true });
      expect(budgetOf(net.txs[0]), `${priorityFee} at ${units}`).toEqual({ limits: [limit], prices: [price] });
      expect(computeBudgetFeeLamports(net.txs[0]), `${priorityFee} at ${units}`).toEqual({ ok: true, lamports: fee });
    }
    // no usable simulation answer: the 600 000 fallback limit, the same fee rule
    net.txs = []; net.sim = 'error';
    await smartBuy(wallet, PLAIN_MINT, 0.05, { priorityFee: 100_000, singleSend: true });
    expect(budgetOf(net.txs[0])).toEqual({ limits: [600_000], prices: [166_666n] });
    expect((computeBudgetFeeLamports(net.txs[0]) as { lamports: bigint }).lamports <= 100_000n).toBe(true);
  });

  it('FIXBUY2-T19 on the RPC lane a failing simulation is a PreSignRefusal before signing (2jeX: insufficient-sol, final) and nothing is sent; buildOnly never sends', async () => {
    net.sim = { err: { InstructionError: [3, { Custom: 1 }] }, logs: INSUFFICIENT_LOGS, unitsConsumed: 19_863 };
    const onSigned = vi.fn(async () => {});
    const err = await settle(smartBuy(wallet, PLAIN_MINT, 0.1, { singleSend: true, onSigned }));
    expect(err).toBeInstanceOf(PreSignRefusal);
    expect(err).toMatchObject({ kind: 'insufficient-sol', needLamports: 100_000_000n, haveLamports: 87_517_263n });
    expect(onSigned).not.toHaveBeenCalled();
    expect(net.sends).toEqual([]);
    expect(net.txs).toEqual([]);
    expect(net.swaps).toBe(0);                                           // the legacy /swap would send the same failing swap
    expect(net.builds).toBe(1);
    net.sim = { err: null, logs: [], unitsConsumed: 150_000 };
    const built = await smartSell(wallet, PLAIN_MINT, 1_000n, { buildOnly: true, onSigned });
    expect(built.sent).toBe(false);
    expect(net.sends).toEqual([]);
    expect(onSigned).not.toHaveBeenCalled();
  });
});

describe('Jupiter Sender route (/swap/v2/build, tip, Helius Sender) through the router', () => {
  beforeEach(() => {
    setConfig({ JUPITER_API_KEY: `jk${randomBytes(8).toString('hex')}`, USE_JUPITER_V3: false });
  });

  it('A26 the build answer carries the bound, one transaction goes to the Sender lane after onSigned', async () => {
    const seen: SignedTx[] = [];
    const r = await smartBuy(wallet, PLAIN_MINT, 0.05, { onSigned: async (s) => { net.events.push(`onSigned:${s.sig}`); seen.push(s); } });
    expect(net.builds).toBe(1);
    expect(seen).toEqual([{ sig: r.sig, lastValidBlockHeight: 777_002, route: 'jupiter' }]);
    expect(net.sends).toHaveLength(1);
    expect(net.sends[0].url).toContain('sender');
    expect(net.events).toEqual([`onSigned:${r.sig}`, `send:${r.sig}`]);
    expect(net.swaps).toBe(0);
  });

  it('A26 buildOnly and an aborting onSigned never reach the Sender', async () => {
    const onSigned = vi.fn(async () => {});
    const built = await smartBuy(wallet, PLAIN_MINT, 0.05, { buildOnly: true, onSigned });
    expect(built.sent).toBe(false);
    const boom = new Error('journal write failed');
    expect(await settle(smartBuy(wallet, PLAIN_MINT, 0.05, { onSigned: async () => { throw boom; } }))).toBe(boom);
    expect(net.sends).toEqual([]);
    expect(onSigned).not.toHaveBeenCalled();
    expect(net.swaps).toBe(0);                       // the abort did not fall through to the legacy path either
  });

  it('A26 a Sender rejection is never retried without the tip (FIX-BUY2 item 3) nor on the legacy /swap (item 2): without singleSend the next attempt is a second TIPPED Sender transaction; singleSend allows none', async () => {
    vi.useFakeTimers();
    const tipped = (tx: VersionedTransaction): boolean => tx.message.staticAccountKeys.some((k) => CONFIG.HELIUS_TIP_ACCOUNTS.includes(k.toBase58()));
    // (1) Sender rejects the first transaction as too large (no longer expected: an oversized route is refused before signing): no
    // retry without the tip; the next attempt is a new build, measured, tipped and signed with its own onSigned
    net.sendPlan = ['base64 encoded too large'];
    const seen: SignedTx[] = [];
    const run1 = smartBuy(wallet, PLAIN_MINT, 0.05, { onSigned: async (s) => { seen.push(s); } });
    await vi.advanceTimersByTimeAsync(5_000);
    const r = await run1;
    expect(net.builds).toBe(2);
    expect(seen).toHaveLength(2);
    expect(r.sigs).toEqual(seen.map((s) => s.sig));
    expect(r.sig).toBe(seen[1].sig);
    expect(net.txs).toHaveLength(2);
    expect(net.txs.every(tipped)).toBe(true);
    expect(net.swaps).toBe(0);

    // (2) singleSend: the rejection is the end of the call
    net.sends = []; net.sigOrder = []; net.builds = 0; net.txs = []; net.sendPlan = ['base64 encoded too large'];
    const seen2: SignedTx[] = [];
    const run2 = settle(smartBuy(wallet, PLAIN_MINT, 0.05, { singleSend: true, onSigned: async (s) => { seen2.push(s); } }));
    await vi.advanceTimersByTimeAsync(5_000);
    const e2 = await run2;
    expect(e2).toBeInstanceOf(RouterSendError);
    expect((e2 as RouterSendError).sigs).toEqual(seen2.map((s) => s.sig));
    expect(seen2).toHaveLength(1);
    expect(net.builds).toBe(1);
    expect(net.swaps).toBe(0);                       // no legacy /swap fallback

    // (3) another Sender failure: FIX-BUY2 item 2, never the legacy /swap (it only stands in for a /build outage); without singleSend the
    // next attempt is a second Sender transaction with its own onSigned ...
    net.sends = []; net.sigOrder = []; net.builds = 0; net.sendPlan = ['sender is down'];
    const seen3: SignedTx[] = [];
    const run3 = smartBuy(wallet, PLAIN_MINT, 0.05, { onSigned: async (s) => { seen3.push(s); } });
    await vi.advanceTimersByTimeAsync(5_000);
    const r3 = await run3;
    expect(net.swaps).toBe(0);
    expect(net.builds).toBe(2);
    expect(r3.sigs).toEqual(seen3.map((s) => s.sig));
    expect(r3.sigs).toHaveLength(2);
    // ... and does not with it
    net.sends = []; net.sigOrder = []; net.builds = 0; net.swaps = 0; net.sendPlan = ['sender is down'];
    const run4 = settle(smartBuy(wallet, PLAIN_MINT, 0.05, { singleSend: true }));
    await vi.advanceTimersByTimeAsync(5_000);
    const e3 = await run4;
    expect(e3).toBeInstanceOf(RouterSendError);
    expect(net.swaps).toBe(0);
    expect(net.builds).toBe(1);
    expect(uniqueSends()).toHaveLength(1);
  });

  // ── FIX-BUY (38HZ... and 2jeX..., 2026-11-06) ────────────────────────────────────────────────────────────────────────────────
  it('FIXBUY-T02 a route that needs more than 200 000 units signs the measured units x 1.2 and a price scaled so the fee does not grow; one simulation, before onSigned', async () => {
    net.buildCb = [cuPriceApiIx(9)];                                     // 38HZ: Jupiter sent a price of 9 micro-lamports / unit and no limit
    net.sim = { err: null, logs: [], unitsConsumed: 270_000 };
    net.traceSims = true;
    const r = await smartBuy(wallet, PLAIN_MINT, 0.005, { singleSend: true, onSigned: async (s) => { net.events.push(`onSigned:${s.sig}`); } });
    expect(r.sent).toBe(true);
    expect(net.sims).toHaveLength(1);
    expect(net.sims[0].cfg).toEqual({ encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
    expect(net.events).toEqual(['simulate', `onSigned:${r.sig}`, `send:${r.sig}`]);   // measured before anything is journalled or sent
    // the measured message runs at the runtime maximum, with the price scaled to it (its fee is not above the old one either)
    expect(budgetOf(net.sims[0].tx)).toEqual({ limits: [1_400_000], prices: [1n] });
    expect(computeBudgetFeeLamports(net.sims[0].tx)).toEqual({ ok: true, lamports: 2n });
    // the signed transaction: ONE limit, 270 000 x 1.2; the price 9 -> 6; the fee 2 lamports = what price 9 cost at the old 200 000 limit
    expect(net.txs).toHaveLength(1);
    expect(budgetOf(net.txs[0])).toEqual({ limits: [324_000], prices: [6n] });
    expect(computeBudgetFeeLamports(net.txs[0])).toEqual({ ok: true, lamports: 2n });
    // apart from the compute-budget data the measured and the signed transaction are the same (same tip account, swap and blockhash)
    const [m, s] = [net.sims[0].tx.message, net.txs[0].message];
    expect(s.staticAccountKeys.map((k) => k.toBase58())).toEqual(m.staticAccountKeys.map((k) => k.toBase58()));
    expect(s.recentBlockhash).toBe(m.recentBlockhash);
    expect(s.compiledInstructions.slice(2)).toEqual(m.compiledInstructions.slice(2));
    expect(net.sends[0].url).toContain('sender');
    expect(net.swaps).toBe(0);
  });

  it('FIXBUY-T03 a simulation that finds too little SOL (2jeX) refuses before signing: no onSigned, no send, no legacy /swap, no second attempt, and the error names both amounts', async () => {
    net.buildCb = [cuPriceApiIx(1_319)];
    net.sim = { err: { InstructionError: [3, { Custom: 1 }] }, logs: INSUFFICIENT_LOGS, unitsConsumed: 19_863 };
    const onSigned = vi.fn(async () => {});
    const err = await settle(smartBuy(wallet, PLAIN_MINT, 0.1, { singleSend: true, onSigned }));
    expect(err).toBeInstanceOf(PreSignRefusal);
    expect(err).toMatchObject({ kind: 'insufficient-sol', needLamports: 100_000_000n, haveLamports: 87_517_263n });
    expect((err as Error).message).toContain('0.1000 SOL');
    expect((err as Error).message).toContain('0.0875 SOL');
    expect((err as Error).message).toMatch(/Nothing was sent; no fee was paid\.$/);
    expect(onSigned).not.toHaveBeenCalled();
    expect(net.sends).toEqual([]);
    expect(net.txs).toEqual([]);
    expect(net.swaps).toBe(0);                                           // the legacy /swap would send the same failing swap
    expect(net.quotes).toBe(0);                                          // FIX-BUY2 item 2: the build is the quote
    expect(net.builds).toBe(1);                                          // more attempts cannot add SOL
    expect(net.sims).toHaveLength(1);
  });

  it('FIXBUY-T03 any other failing simulation keeps the A-58 retries (a buy at the same slippage), never falls back to the legacy /swap, and nothing is sent', async () => {
    vi.useFakeTimers();
    net.sim = { err: { InstructionError: [4, { Custom: 6001 }] }, logs: ['Program log: Error: slippage tolerance exceeded'], unitsConsumed: 150_000 };
    h.http.mockClear();
    const run = settle(smartBuy(wallet, PLAIN_MINT, 0.05, { singleSend: true }));
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await run;
    expect(err).toBeInstanceOf(PreSignRefusal);
    expect(err).toMatchObject({ kind: 'simulation-failed' });
    expect((err as Error).message).toContain('{"InstructionError":[4,{"Custom":6001}]}');
    // FIX-BUY2 item 2: the slippage of each attempt is read from the /swap/v2/build request (no /swap/v1/quote is asked any more)
    expect(requestedBps('/swap/v2/build')).toEqual([300, 300, 300]);
    expect(requestedBps('/swap/v1/quote')).toEqual([]);
    expect(net.builds).toBe(3);
    expect(net.sims).toHaveLength(3);
    expect(net.sends).toEqual([]);
    expect(net.swaps).toBe(0);
  });

  // FIX-BUY review (P1): before the simulation, a sell that would fail was SENT at the step's slippage, reverted, and singleSend ended
  // the call (mustStop), so the step's slippage was the limit. A refusal must not now come back at 1.5x / 2.25x the step's slippage
  // (above the owner's "max slippage on retry"); the sell ladder (sell-runner, tpAttemptSlippageBps) escalates within the owner's limits.
  it('FIXBUY-T11 a sell step the simulation refuses is retried at the SAME slippage under singleSend: refused twice, then every quote, every build and the one send are at the step\'s 300 bps', async () => {
    vi.useFakeTimers();
    net.simPlan = [SIM_SLIPPAGE, SIM_SLIPPAGE];
    net.sim = { err: null, logs: [], unitsConsumed: 150_000 };
    h.http.mockClear();
    const onSigned = vi.fn(async () => {});
    const run = settle(smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true, slippageBps: 300, onSigned }));
    await vi.advanceTimersByTimeAsync(5_000);
    const r = await run as Awaited<ReturnType<typeof smartSell>>;
    expect(r.sent).toBe(true);
    expect(requestedBps('/swap/v1/quote')).toEqual([]);                 // FIX-BUY2 item 2: the build is the quote
    expect(requestedBps('/swap/v2/build')).toEqual([300, 300, 300]);
    expect(net.sims).toHaveLength(3);
    expect(onSigned).toHaveBeenCalledTimes(1);                          // the one transaction signed is the one sent, built at 300
    expect(uniqueSends()).toEqual([r.sig]);
    expect(r.sigs).toEqual([r.sig]);
    expect(r.slippageBpsUsed).toBe(300);
    expect(net.swaps).toBe(0);
  });

  it('FIXBUY-T12 a 9900 bps panic leg the simulation refuses on every attempt is never quoted at 14 850 bps; nothing is signed or sent', async () => {
    vi.useFakeTimers();
    net.sim = SIM_SLIPPAGE;
    h.http.mockClear();
    const onSigned = vi.fn(async () => {});
    const run = settle(smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true, slippageBps: 9_900, onSigned }));
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await run;
    expect(err).toBeInstanceOf(PreSignRefusal);
    expect(err).toMatchObject({ kind: 'simulation-failed' });
    expect(requestedBps('/swap/v1/quote')).toEqual([]);                 // FIX-BUY2 item 2: the build is the quote
    expect(requestedBps('/swap/v2/build')).toEqual([9_900, 9_900, 9_900]);
    expect(net.sims).toHaveLength(3);
    expect(onSigned).not.toHaveBeenCalled();
    expect(net.sends).toEqual([]);
    expect(net.swaps).toBe(0);
  });

  it('FIXBUY-T13 V3 on: a refusal on the legacy fallback inside an attempt does not raise the next attempt either (the second /order is at the step\'s bps)', async () => {
    vi.useFakeTimers();
    setConfig({ USE_JUPITER_V3: true });
    net.simPlan = [SIM_SLIPPAGE];
    net.sim = { err: null, logs: [], unitsConsumed: 150_000 };
    orderChain('sell');                                                  // FIX-BUY2 item 7(e): the second order is simulated before signing
    let firstOrder = true;
    h.http.mockImplementation(async (url: string, init?: any) => {
      if (firstOrder && String(url).includes('/swap/v2/order')) { firstOrder = false; return res({}); }   // no transaction: refused, attempt 1 goes on with /build
      return fakeHttp(url, init);
    });
    h.http.mockClear();
    const run = settle(smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true, slippageBps: 300 }));
    await vi.advanceTimersByTimeAsync(5_000);
    const r = await run as Awaited<ReturnType<typeof smartSell>>;
    expect(r.sent).toBe(true);
    expect(requestedBps('/swap/v2/order')).toEqual([300, 300]);
    expect(requestedBps('/swap/v2/build')).toEqual([300]);             // the /swap/v2/build fallback of attempt 1 (FIX-BUY2 item 2)
    expect(requestedBps('/swap/v1/quote')).toEqual([]);
    expect(net.sims).toHaveLength(2);                                   // the refused build's measure, and the second order's simulation
    expect(net.executes).toEqual([r.sig]);
    expect(net.sends).toEqual([]);
  });

  it('FIXBUY-T14 a refusal holds for the rest of the call: a Jupiter outage after it does not raise the sell either (A-58 escalation only before any refusal)', async () => {
    vi.useFakeTimers();
    net.simPlan = [SIM_SLIPPAGE];
    net.sim = { err: null, logs: [], unitsConsumed: 150_000 };
    // attempt 2: /swap/v2/build is rate-limited on every try of the key (FIX-BUY2: a 429 has no legacy stand-in, the same rate bucket)
    let buildNo = 0;
    h.http.mockImplementation(async (url: string, init?: any) => {
      if (String(url).includes('/swap/v2/build') && ++buildNo >= 2 && buildNo <= 5) return res({ message: '[API Gateway] Too many requests' }, 429);
      return fakeHttp(url, init);
    });
    h.http.mockClear();
    const run = settle(smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true, slippageBps: 300 }));
    await vi.advanceTimersByTimeAsync(15_000);
    const r = await run as Awaited<ReturnType<typeof smartSell>>;
    expect(r.sent).toBe(true);
    expect(requestedBps('/swap/v2/build')).toEqual([300, 300, 300, 300, 300, 300]);   // 1 refused, 4 rate-limited, 1 sent: all at 300
    expect(requestedBps('/swap/v1/quote')).toEqual([]);
    expect(net.sims).toHaveLength(2);
    expect(uniqueSends()).toEqual([r.sig]);
  });

  it('FIXBUY-T04 no usable simulation answer (every lane errors, no units, or nothing within 2.5 s): one send at the fixed 600 000 limit, price scaled, fee not above the old one', async () => {
    net.buildCb = [cuPriceApiIx(9)];
    net.sim = 'error';
    const r = await smartBuy(wallet, PLAIN_MINT, 0.005, { singleSend: true });
    expect(r.sent).toBe(true);
    expect(net.sims.length).toBeGreaterThanOrEqual(1);
    expect(net.txs).toHaveLength(1);
    expect(budgetOf(net.txs[0])).toEqual({ limits: [600_000], prices: [3n] });
    expect(computeBudgetFeeLamports(net.txs[0])).toEqual({ ok: true, lamports: 2n });

    for (const sim of [{ err: null, logs: [], unitsConsumed: undefined }, { err: null, logs: [], unitsConsumed: 0 }, { err: null, logs: [], unitsConsumed: '270000' }]) {
      net.txs = []; net.sim = sim;
      await smartBuy(wallet, PLAIN_MINT, 0.005, { singleSend: true });
      expect(budgetOf(net.txs[0]), JSON.stringify(sim)).toEqual({ limits: [600_000], prices: [3n] });
    }

    // a node that never answers delays the send by 2.5 s at most
    vi.useFakeTimers();
    net.txs = []; net.sims = []; net.sim = 'hang';
    const run = smartBuy(wallet, PLAIN_MINT, 0.005, { singleSend: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(net.sims).toHaveLength(1);
    expect(net.txs).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    const r2 = await run;
    expect(r2.sent).toBe(true);
    expect(budgetOf(net.txs[0])).toEqual({ limits: [600_000], prices: [3n] });
  });

  it('FIXBUY-T04 a light route keeps the old bytes: limit 200 000 and Jupiter\'s own price; a limit Jupiter sends is dropped, never signed twice', async () => {
    net.buildCb = [cuPriceApiIx(1_319)];
    net.sim = { err: null, logs: [], unitsConsumed: 150_000 };
    await smartBuy(wallet, PLAIN_MINT, 0.005, { singleSend: true });
    expect(budgetOf(net.txs[0])).toEqual({ limits: [200_000], prices: [1_319n] });
    expect(computeBudgetFeeLamports(net.txs[0])).toEqual({ ok: true, lamports: 264n });

    const limitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
    net.buildCb = [{ programId: limitIx.programId.toBase58(), accounts: [], data: Buffer.from(limitIx.data).toString('base64') }, cuPriceApiIx(1_319)];
    net.txs = [];
    await smartBuy(wallet, PLAIN_MINT, 0.005, { singleSend: true });
    expect(budgetOf(net.txs[0])).toEqual({ limits: [200_000], prices: [1_319n] });
  });
});

// ── FIX-BUY2 item 2: /swap/v2/build is the quote and the route ──────────────────────────────────────────────────────────────────
describe('FIX-BUY2 item 2: the /swap/v2/build answer is the quote and the route (Sender lane), buy and sell', () => {
  beforeEach(() => { setConfig({ JUPITER_API_KEY: testKey(), JUPITER_API_KEY_FALLBACK: '', USE_JUPITER_V3: false }); });

  it('FIXBUY2-T09 no /swap/v1/quote when /build answers: one build per trade, and tokensOut (buy) / solOut (sell) are the build\'s outAmount', async () => {
    h.http.mockClear();
    const buy = await smartBuy(wallet, PLAIN_MINT, 0.05, { singleSend: true });
    const sell = await smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true });
    expect(net.quotes).toBe(0);
    expect(net.builds).toBe(2);
    expect(buy.tokensOut).toBe(888_000n);                                // the build's outAmount, not the v1 quote's 777000
    expect(buy.tokensOutQuoted).toBe(888_000n);
    expect(sell.solOut).toBe(888_000n);
    expect(sell.solOutQuoted).toBe(888_000n);
    expect(net.sends.every((s) => s.url.includes('sender'))).toBe(true);
    // executeWithRetry hands back the build's own quote fields
    const out = await executeWithRetry(wallet, SOL, PLAIN_MINT, 50_000_000, 300, 3, true, 100_000, false, createSendContext({ singleSend: true }));
    expect(out.quote).toEqual({ inputMint: SOL, outputMint: PLAIN_MINT, inAmount: '50000000', outAmount: '888000', otherAmountThreshold: '861360', priceImpactPct: '0.0123', slippageBps: 300 });
    expect(requestedBps('/swap/v2/build').at(-1)).toBe(300);
    expect(h.http.mock.calls.some((c) => String(c[0]).includes('/swap/v1/quote'))).toBe(false);
  });

  it('FIXBUY2-T10 the build\'s own priceImpactPct is capped BEFORE the measuring simulation: above the cap is ImpactCapError with no simulation, no signature, no onSigned; missing is refused (fail closed)', async () => {
    net.priceImpactPct = '0.2';                                          // 20 %
    const onSigned = vi.fn(async () => {});
    for (const run of [() => smartBuy(wallet, PLAIN_MINT, 0.05, { maxImpactPct: 15, onSigned }), () => smartSell(wallet, PLAIN_MINT, 1_000n, { maxImpactPct: 15, onSigned })]) {
      const err = await settle(run());
      expect(err).toBeInstanceOf(ImpactCapError);
      expect((err as ImpactCapError).refused[0]).toMatchObject({ route: 'jupiter' });
      expect((err as ImpactCapError).refused[0].impactPct).toBeCloseTo(20, 6);
    }
    expect(net.builds).toBe(2);                                          // one build each, no retry at another slippage
    expect(net.sims).toEqual([]);
    expect(net.txs).toEqual([]);
    expect(net.sends).toEqual([]);
    expect(onSigned).not.toHaveBeenCalled();
    expect(net.quotes).toBe(0);
    net.priceImpactPct = undefined;                                      // a build that states no impact cannot be shown to be under the cap
    const blind = await settle(smartBuy(wallet, PLAIN_MINT, 0.05, { maxImpactPct: 50 }));
    expect(blind).toBeInstanceOf(ImpactCapError);
    expect((blind as ImpactCapError).refused[0].impactPct).toBeNull();
    expect(net.sims).toEqual([]);
    net.priceImpactPct = '0.15';                                         // exactly the cap passes
    expect((await smartBuy(wallet, PLAIN_MINT, 0.05, { maxImpactPct: 15 })).sent).toBe(true);
  });

  it('FIXBUY2-T11 /build "No routes found" on a sell is JupiterNoRouteError: no legacy /swap, no v1 quote, nothing signed', async () => {
    net.jupPlan['/swap/v2/build'] = [{ status: 400, body: { error: 'No routes found' } }];
    const err = await settle(smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true }));
    expect(err).toBeInstanceOf(JupiterNoRouteError);
    expect(net.builds).toBe(1);
    expect(net.quotes).toBe(0);
    expect(net.swaps).toBe(0);
    expect(net.sims).toEqual([]);
    expect(net.sends).toEqual([]);
  });

  it('FIXBUY2-T12 /build 503 after its backoffs, or no answer: ONE v1 quote (maxAccounts=64, restrictIntermediateTokens=false, no dynamicComputeUnitLimit) and ONE legacy /swap through the multi-RPC blast; a 429 has no stand-in', async () => {
    vi.useFakeTimers();
    for (const plan of [Array.from({ length: 4 }, () => ({ status: 503, body: 'upstream down' })), ['throw' as const]]) {
      net.jupPlan['/swap/v2/build'] = [...plan];
      net.quotes = 0; net.swaps = 0; net.sends = []; net.sigOrder = [];
      h.http.mockClear();
      const seen: SignedTx[] = [];
      const run = settle(smartBuy(wallet, PLAIN_MINT, 0.05, { singleSend: true, onSigned: async (s) => { seen.push(s); } }));
      await vi.advanceTimersByTimeAsync(10_000);
      const r = await run as Awaited<ReturnType<typeof smartBuy>>;
      expect(r.sent).toBe(true);
      expect(net.quotes).toBe(1);
      expect(net.swaps).toBe(1);
      expect(seen).toEqual([{ sig: r.sig, lastValidBlockHeight: 777_001, route: 'jupiter' }]);   // the /swap answer's bound
      expect(net.sends.length).toBeGreaterThan(0);
      expect(net.sends.some((s) => s.url.includes('sender'))).toBe(false);
      expect(r.tokensOut).toBe(777_000n);                                // the legacy route's own quote
      const qUrl = new URL(h.http.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/swap/v1/quote'))!);
      expect(qUrl.searchParams.get('maxAccounts')).toBe('64');
      expect(qUrl.searchParams.get('restrictIntermediateTokens')).toBe('false');
      expect(qUrl.searchParams.has('dynamicComputeUnitLimit')).toBe(false);
    }
    // 429: the same rate bucket, so no legacy request; the attempt fails as unavailable (retried by the next attempt, here maxAttempts 1)
    net.jupPlan['/swap/v2/build'] = Array.from({ length: 4 }, () => ({ status: 429, body: { message: '[API Gateway] Too many requests' } }));
    net.quotes = 0; net.swaps = 0;
    const run429 = settle(executeWithRetry(wallet, SOL, PLAIN_MINT, 50_000_000, 300, 1, true, 100_000, false, createSendContext({ singleSend: true })));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await run429).toBeInstanceOf(JupiterUnavailableError);
    expect(net.quotes).toBe(0);
    expect(net.swaps).toBe(0);
  });

  it('FIXBUY2-T13 buildOnly (dry run): builds, measures and signs, never sends and never calls onSigned; no v1 quote', async () => {
    const onSigned = vi.fn(async () => {});
    net.sim = { err: null, logs: [], unitsConsumed: 150_000 };
    const buy = await smartBuy(wallet, PLAIN_MINT, 0.05, { buildOnly: true, onSigned });
    const sell = await smartSell(wallet, PLAIN_MINT, 1_000n, { buildOnly: true, onSigned });
    for (const r of [buy, sell]) {
      expect(r.sent).toBe(false);
      expect(bs58.decode(r.sig)).toHaveLength(64);
    }
    expect(buy.tokensOut).toBe(888_000n);
    expect(net.builds).toBe(2);
    expect(net.sims).toHaveLength(2);
    expect(net.quotes).toBe(0);
    expect(net.sends).toEqual([]);
    expect(onSigned).not.toHaveBeenCalled();
  });

  it('FIXBUY2-T14 the exit valuation\'s quote (jupQuote) asks for the routes /build signs: maxAccounts=64, restrictIntermediateTokens=false, no dynamicComputeUnitLimit', async () => {
    const { createValuation } = await import('../exits/valuation');
    h.http.mockClear();
    const clock = { now: () => 1_000, setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>) };
    const valuation = createValuation({
      clock: clock as never, onchain: { quoteSell: async () => null }, engine: { price: async () => ({ error: 'none' }) } as never,
      decimals: async () => 6, log: () => undefined,
    });
    const q = await valuation.quote({ ca: PLAIN_MINT, tokens: '1000' } as never, false);
    expect(q).toMatchObject({ src: 'jupiter', sol: 777_000 / 1e9 });
    const urls = h.http.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/swap/v1/quote'));
    expect(urls).toHaveLength(1);
    const p = new URL(urls[0]).searchParams;
    expect(p.get('maxAccounts')).toBe('64');
    expect(p.get('restrictIntermediateTokens')).toBe('false');
    expect(p.has('dynamicComputeUnitLimit')).toBe(false);
    expect(p.get('slippageBps')).toBe('500');
  });
});

// ── FIX-BUY2 item 3: FIX-BUY's compute budget aligned with Jupiter's docs ──────────────────────────────────────────────────────────
describe('FIX-BUY2 item 3: Jupiter\'s price clamped to the ceiling; an oversized route is refused before signing', () => {
  beforeEach(() => { setConfig({ JUPITER_API_KEY: testKey(), JUPITER_API_KEY_FALLBACK: '', USE_JUPITER_V3: false }); });

  it('FIXBUY2-T16 an oversized build is refused BEFORE signing: no simulation, no signature, no onSigned, no Sender call; then ONE v1 quote and ONE legacy /swap through the multi-RPC blast (buy and sell, both oversize forms)', async () => {
    net.sim = { err: null, logs: [], unitsConsumed: 150_000 };
    // the size of the Sender transaction the fake build composes, signed, with no extra data
    await smartBuy(wallet, PLAIN_MINT, 0.05, { singleSend: true });
    const base = net.txs[0].serialize().length;
    expect(base).toBeLessThan(1_232);
    // (a) one byte over the packet: the message still fits its buffer, the signed transaction does not; (b) a message over 1 232 bytes
    // (web3.js cannot even serialize it)
    for (const [extra, side] of [[1_233 - base, 'buy'], [1_233 - base, 'sell'], [1_100, 'buy'], [1_100, 'sell']] as const) {
      net.buildExtra = extra;
      net.sends = []; net.sigOrder = []; net.events = []; net.txs = []; net.sims = []; net.builds = 0; net.quotes = 0; net.swaps = 0;
      const seen: SignedTx[] = [];
      const opts = { singleSend: true, onSigned: async (s: SignedTx) => { net.events.push(`onSigned:${s.sig}`); seen.push(s); } };
      const r = side === 'buy' ? await smartBuy(wallet, PLAIN_MINT, 0.05, opts) : await smartSell(wallet, PLAIN_MINT, 1_000n, opts);
      expect(r.sent, side).toBe(true);
      expect(net.builds, side).toBe(1);
      expect(net.sims, side).toEqual([]);                                 // never simulated: no node would take it
      expect(net.quotes, side).toBe(1);
      expect(net.swaps, side).toBe(1);
      expect(seen, side).toEqual([{ sig: r.sig, lastValidBlockHeight: 777_001, route: 'jupiter' }]);   // the one onSigned is the legacy transaction's
      expect(net.events, side).toEqual([`onSigned:${r.sig}`, `send:${r.sig}`]);
      expect(net.sends.some((s) => s.url.includes('sender')), side).toBe(false);
      expect(net.txs.every((tx) => tx.serialize().length <= 1_232), side).toBe(true);
    }
  });

  it('FIXBUY2-T16 an oversized build under buildOnly signs nothing of it: the dry run reports the legacy route\'s transaction, never sent', async () => {
    net.buildExtra = 1_100;
    const onSigned = vi.fn(async () => {});
    const r = await smartBuy(wallet, PLAIN_MINT, 0.05, { buildOnly: true, onSigned });
    expect(r.sent).toBe(false);
    expect(net.swaps).toBe(1);
    expect(net.sims).toEqual([]);
    expect(net.sends).toEqual([]);
    expect(onSigned).not.toHaveBeenCalled();
  });

  it('FIXBUY2-T17 the Sender lane signs Jupiter\'s price clamped to PRIORITY_FEE_CEILING_MICROLAMPORTS (default 5 000 000): a spike costs at most 1 000 000 lamports; a lower configured ceiling is honoured; the recorded prices are unchanged', async () => {
    net.sim = { err: null, logs: [], unitsConsumed: 150_000 };
    net.buildCb = [cuPriceApiIx(50_000_000)];                             // a spike: 50 000 000 micro-lamports per unit
    await smartBuy(wallet, PLAIN_MINT, 0.005, { singleSend: true });
    expect(budgetOf(net.txs[0])).toEqual({ limits: [200_000], prices: [5_000_000n] });
    expect(computeBudgetFeeLamports(net.txs[0])).toEqual({ ok: true, lamports: 1_000_000n });
    expect(budgetOf(net.sims[0].tx).prices[0] <= 5_000_000n).toBe(true);  // the measured transaction is clamped too
    // a route measured at 400 000 units: the clamped price scaled to its limit, the fee still at most 1 000 000
    net.txs = []; net.sims = []; net.sim = { err: null, logs: [], unitsConsumed: 400_000 };
    await smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true });
    expect(budgetOf(net.txs[0]).limits).toEqual([480_000]);
    expect((computeBudgetFeeLamports(net.txs[0]) as { lamports: bigint }).lamports <= 1_000_000n).toBe(true);
    // the owner's own ceiling (env PRIORITY_FEE_CEILING_MICROLAMPORTS) is the clamp
    setConfig({ PRIORITY_FEE_CEILING_MICROLAMPORTS: 100_000 });
    net.txs = []; net.sim = { err: null, logs: [], unitsConsumed: 150_000 };
    await smartBuy(wallet, PLAIN_MINT, 0.005, { singleSend: true });
    expect(budgetOf(net.txs[0])).toEqual({ limits: [200_000], prices: [100_000n] });
    // 38HZ's 9 and 2jeX's 1 319 are far below: unchanged (FIXBUY-T02 / T04 pin the scaled values)
    setConfig({ PRIORITY_FEE_CEILING_MICROLAMPORTS: 5_000_000 });
    net.txs = []; net.buildCb = [cuPriceApiIx(1_319)];
    await smartBuy(wallet, PLAIN_MINT, 0.005, { singleSend: true });
    expect(budgetOf(net.txs[0])).toEqual({ limits: [200_000], prices: [1_319n] });
  });
});

// ── FIX-BUY2 item 7: /order + /execute after a /build no-route (JUP_ORDER_FALLBACK, default off) ─────────────────────────────────
describe('FIX-BUY2 item 7: ONE /swap/v2/order + /execute after /swap/v2/build "No routes found", behind JUP_ORDER_FALLBACK', () => {
  const NO_ROUTE = { status: 400, body: { error: 'No routes found' } };
  beforeEach(() => {
    setConfig({ JUPITER_API_KEY: testKey(), JUPITER_API_KEY_FALLBACK: '', USE_JUPITER_V3: false, JUP_ORDER_FALLBACK: 'sell' });
    net.jupPlan['/swap/v2/build'] = [NO_ROUTE, NO_ROUTE, NO_ROUTE];
    net.sim = { err: null, logs: [], unitsConsumed: 150_000 };
    orderChain('sell');
  });
  const executedTx = (i = 0): VersionedTransaction => VersionedTransaction.deserialize(Buffer.from(net.executeBodies[i].signedTransaction, 'base64'));

  it('FIXBUY2-T21 the flag is off by default and with "off" a /build no-route makes no /order request; "sell" covers sells only; "both" buys too', async () => {
    expect(CONFIG.JUP_ORDER_FALLBACK === 'sell').toBe(true);           // this group's setting; the default is pinned in config.test.ts
    setConfig({ JUP_ORDER_FALLBACK: 'off' });
    for (const run of [() => smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true }), () => smartBuy(wallet, PLAIN_MINT, 0.05, { singleSend: true })]) {
      net.jupPlan['/swap/v2/build'] = [NO_ROUTE];
      expect(await settle(run())).toBeInstanceOf(JupiterNoRouteError);
    }
    expect(net.orders).toBe(0);
    setConfig({ JUP_ORDER_FALLBACK: 'sell' });
    net.jupPlan['/swap/v2/build'] = [NO_ROUTE];
    expect(await settle(smartBuy(wallet, PLAIN_MINT, 0.05, { singleSend: true }))).toBeInstanceOf(JupiterNoRouteError);
    expect(net.orders).toBe(0);                                          // a buy is not an exit
    net.jupPlan['/swap/v2/build'] = [NO_ROUTE];
    expect((await smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true })).sent).toBe(true);
    expect(net.orders).toBe(1);
    setConfig({ JUP_ORDER_FALLBACK: 'both' });
    orderChain('buy');
    net.jupPlan['/swap/v2/build'] = [NO_ROUTE];
    expect((await smartBuy(wallet, PLAIN_MINT, 0.05, { singleSend: true })).sent).toBe(true);
    expect(net.orders).toBe(2);
  });

  it('FIXBUY2-T22 a /build no-route then a good order: ONE /order with Jupiter\'s documented query (no mode), one simulation, onSigned BEFORE /execute, ONE /execute of the unmodified transaction; solOut is the order\'s outAmount', async () => {
    const seen: SignedTx[] = [];
    net.traceSims = true;
    const r = await smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true, slippageBps: 300, priorityFee: 100_000, onSigned: async (s) => { net.events.push(`onSigned:${s.sig}`); seen.push(s); } });
    expect(r.sent).toBe(true);
    expect(net.builds).toBe(1);
    expect(net.orders).toBe(1);
    const q = net.orderQueries[0];
    expect(Object.fromEntries(q)).toEqual({
      inputMint: PLAIN_MINT, outputMint: SOL, amount: '1000', taker: wallet.publicKey.toBase58(), slippageBps: '300',
      excludeRouters: 'jupiterz', priorityFeeLamports: '100000', broadcastFeeType: 'maxCap', jitoTipLamports: '200000',   // anti-MEV on: a Jito tip
    });
    expect(q.has('mode')).toBe(false);
    expect(q.has('swapMode')).toBe(false);
    // one read-only simulation with every writable account, before onSigned; then /execute
    expect(net.events).toEqual(['simulate', `onSigned:${r.sig}`, `send:${r.sig}`]);
    expect(net.sims).toHaveLength(1);
    expect(net.sims[0].cfg).toMatchObject({ encoding: 'base64', sigVerify: false, accounts: { encoding: 'base64' } });
    expect(net.sims[0].cfg.accounts.addresses).toEqual(expect.arrayContaining([wallet.publicKey.toBase58(), OWNER_TOKEN_ACC]));
    expect(net.sims[0].tx.signatures.every((sg) => sg.every((b) => b === 0))).toBe(true);
    expect(seen).toEqual([{ sig: r.sig, lastValidBlockHeight: 777_003, route: 'jupiter' }]);   // the order's lastValidBlockHeight, a string
    expect(net.executeBodies).toHaveLength(1);
    expect(net.executeBodies[0].requestId).toBe('req-1');
    // the transaction signed is Jupiter's, byte for byte (never modified: /execute validates the message)
    const order = VersionedTransaction.deserialize(Buffer.from(String(goodOrder(q, orderTxBase64()).transaction), 'base64'));
    expect(executedTx().message.compiledInstructions).toEqual(order.message.compiledInstructions);
    expect(executedTx().message.staticAccountKeys.map((k) => k.toBase58())).toEqual(order.message.staticAccountKeys.map((k) => k.toBase58()));
    expect(bs58.encode(executedTx().signatures[0])).toBe(r.sig);
    expect(r.solOut).toBe(777_000n);
    expect(net.sends).toEqual([]);                                       // Jupiter broadcasts; nothing goes to an RPC lane
    // anti-MEV off: no Jito tip is asked
    orderChain('sell');
    net.jupPlan['/swap/v2/build'] = [NO_ROUTE];
    await smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true, antiMev: false });
    expect(net.orderQueries[1].has('jitoTipLamports')).toBe(false);
  });

  it('FIXBUY2-T23 an order without a transaction is read by router + errorCode: 2 (and 1 on a buy) is PreSignRefusal insufficient-sol, 1 on a sell is a stale size (final), anything else a refusal; nothing is signed and ONE order is asked', async () => {
    const cases: Array<[Record<string, unknown>, 'buy' | 'sell', (e: unknown) => void]> = [
      [{ router: 'metis', errorCode: 2, errorMessage: 'Insufficient SOL for gas' }, 'sell', (e) => expect(e).toMatchObject({ name: 'PreSignRefusal', kind: 'insufficient-sol' })],
      [{ router: 'okx', errorCode: '1', errorMessage: 'Insufficient funds' }, 'buy', (e) => expect(e).toMatchObject({ name: 'PreSignRefusal', kind: 'insufficient-sol' })],
      [{ router: 'dflow', errorCode: 1, errorMessage: 'Insufficient funds' }, 'sell', (e) => { expect(e).toBeInstanceOf(JupiterOrderRefusal); expect(e).toMatchObject({ kind: 'stale-size' }); expect(String((e as Error).message)).toMatch(/position size is stale/); }],
      [{ router: 'metis', errorCode: 3, errorMessage: 'below the gasless minimum' }, 'sell', (e) => expect(e).toMatchObject({ name: 'JupiterOrderRefusal', kind: 'no-transaction' })],
      [{ router: 'jupiterz', errorCode: 2 }, 'sell', (e) => expect(e).toMatchObject({ name: 'JupiterOrderRefusal', kind: 'no-transaction' })],
    ];
    setConfig({ JUP_ORDER_FALLBACK: 'both' });
    for (const [answer, side, check] of cases) {
      net.orders = 0; net.executeBodies = [];
      net.jupPlan['/swap/v2/build'] = [NO_ROUTE];
      net.order = (q) => ({ ...goodOrder(q), transaction: '', ...answer });
      const onSigned = vi.fn(async () => {});
      const err = await settle(side === 'buy' ? smartBuy(wallet, PLAIN_MINT, 0.05, { singleSend: true, onSigned }) : smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true, onSigned }));
      check(err);
      expect(String((err as Error).message), JSON.stringify(answer)).not.toMatch(/missing transaction/);
      expect(net.orders, JSON.stringify(answer)).toBe(1);
      expect(onSigned).not.toHaveBeenCalled();
      expect(net.executeBodies).toEqual([]);
    }
    expect(net.sends).toEqual([]);
  });

  it('FIXBUY2-T24 refused before signing unless the owner is the fee payer and the only signer, and its priority fee is at most 2 x the one asked (A-27): a gasless order, an RFQ-style co-signer, an inflated fee', async () => {
    expect(ORDER_PRIORITY_FEE_MAX_FACTOR).toBe(PUMPPORTAL_PRIORITY_FEE_MAX_FACTOR);
    const cases: Array<[string, (q: URLSearchParams) => Record<string, unknown>, string]> = [
      ['gasless sponsor pays', (q) => ({ ...goodOrder(q, orderTxBase64({ payer: GASLESS_SPONSOR })), gasless: true, signatureFeePayer: GASLESS_SPONSOR.toBase58() }), 'gasless'],
      ['gasless flagged only', (q) => ({ ...goodOrder(q), gasless: true }), 'gasless'],
      ['two required signers', (q) => goodOrder(q, orderTxBase64({ coSigner: Keypair.generate().publicKey })), 'signer'],
      // 200 000 units x 1 000 001 micro-lamports = 200 000.2 -> 200 001 lamports > 2 x 100 000
      ['fee above 2x', (q) => goodOrder(q, orderTxBase64({ cuLimit: 200_000, cuPrice: 1_000_001 })), 'fee'],
    ];
    for (const [name, order, kind] of cases) {
      net.orders = 0; net.executeBodies = []; net.sims = [];
      net.jupPlan['/swap/v2/build'] = [NO_ROUTE];
      net.order = order;
      const onSigned = vi.fn(async () => {});
      const err = await settle(smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true, priorityFee: 100_000, onSigned }));
      expect(err, name).toBeInstanceOf(JupiterOrderRefusal);
      expect(err, name).toMatchObject({ kind });
      expect(String((err as Error).message), name).toMatch(/Nothing was sent; no fee was paid\.$/);
      expect(net.sims, name).toEqual([]);                                // refused before the simulation, before signing
      expect(onSigned, name).not.toHaveBeenCalled();
      expect(net.executeBodies, name).toEqual([]);
    }
    // exactly 2 x the asked fee passes
    net.jupPlan['/swap/v2/build'] = [NO_ROUTE];
    net.order = (q) => goodOrder(q, orderTxBase64({ cuLimit: 200_000, cuPrice: 1_000_000 }));
    expect((await smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true, priorityFee: 100_000 })).sent).toBe(true);
  });

  it('FIXBUY2-T25 the order\'s own impact is capped on abs(priceImpact), which /order reports in PERCENT: 20 with a 15 % cap is ImpactCapError, nothing simulated or signed', async () => {
    expect(jupiterOrderImpactPct({ priceImpact: '-0.1' })).toBeCloseTo(0.1, 10);
    expect(jupiterOrderImpactPct({ priceImpact: 20 })).toBe(20);
    expect(jupiterOrderImpactPct({ priceImpactPct: '0.2' } as never)).toBeNull();                 // the deprecated fraction is not read
    net.orderImpact = '20';
    const err = await settle(smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true, maxImpactPct: 15 }));
    expect(err).toBeInstanceOf(ImpactCapError);
    expect((err as ImpactCapError).refused.at(-1)?.impactPct).toBeCloseTo(20, 6);
    expect(net.sims).toEqual([]);
    expect(net.executeBodies).toEqual([]);
    net.orderImpact = undefined;                                         // an order that states no impact cannot be shown to be under the cap
    net.jupPlan['/swap/v2/build'] = [NO_ROUTE];
    expect(await settle(smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true, maxImpactPct: 15 }))).toBeInstanceOf(ImpactCapError);
  });

  it('FIXBUY2-T26 a failing or out-of-bound simulation refuses the order before signing: failed, too much SOL out, too many tokens sold, a delegate added, no simulation answer', async () => {
    setConfig({ JUP_ORDER_FALLBACK: 'both' });
    const owner = wallet.publicKey.toBase58();
    const run = async (side: 'buy' | 'sell'): Promise<unknown> => {
      net.jupPlan['/swap/v2/build'] = [NO_ROUTE];
      return settle(side === 'buy' ? smartBuy(wallet, PLAIN_MINT, 0.05, { singleSend: true, priorityFee: 100_000 }) : smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true }));
    };
    // the simulation fails: PreSignRefusal (too little SOL is 'insufficient-sol')
    net.sim = { err: { InstructionError: [3, { Custom: 1 }] }, logs: INSUFFICIENT_LOGS, unitsConsumed: 19_863 };
    orderChain('buy');
    expect(await run('buy')).toMatchObject({ name: 'PreSignRefusal', kind: 'insufficient-sol' });
    net.sim = SIM_SLIPPAGE;
    expect(await run('buy')).toMatchObject({ name: 'PreSignRefusal', kind: 'simulation-failed' });
    net.sim = { err: null, logs: [], unitsConsumed: 150_000 };
    // a buy that takes more SOL than the amount + network fee + 2 x the fee asked + the Jito tip (0.05 SOL + 5 000 + 200 000 + 200 000)
    orderChain('buy', { spend: 50_405_001 });
    const over = await run('buy');
    expect(over).toBeInstanceOf(JupiterOrderRefusal);
    expect(String((over as Error).message)).toContain('owner lamport outflow above bound (50405001 > 50405000)');
    orderChain('buy', { spend: 50_405_000 });
    expect((await run('buy') as { sent?: boolean }).sent).toBe(true);    // exactly the bound passes
    // a buy that delivers no tokens
    orderChain('buy', { got: 0n });
    expect(String((await run('buy') as Error).message)).toContain('no token delta');
    // a sell that takes more tokens than sold
    const sold = net.chain;
    orderChain('sell');
    sold.set(OWNER_TOKEN_ACC, { pre: tokenAccount(PLAIN_MINT, owner, 5_000n), post: tokenAccount(PLAIN_MINT, owner, 3_000n) });
    expect(String((await run('sell') as Error).message)).toContain('owner ATA decrease above tokensIn (2000 > 1000)');
    // a delegate appears on the owner's token account
    orderChain('sell', { delegate: POOL.toBase58() });
    expect(String((await run('sell') as Error).message)).toContain('changed its delegate');
    // another of the owner's token accounts loses tokens
    orderChain('sell');
    const USDC_ACC = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey.toBase58();
    net.chain.set(USDC_ACC, { pre: tokenAccount(SOL.replace('2', '3'), owner, 10n), post: tokenAccount(SOL.replace('2', '3'), owner, 0n) });
    net.order = (q) => {
      const ix = new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM), data: Buffer.from([17]), keys: [{ pubkey: new PublicKey(OWNER_TOKEN_ACC), isSigner: false, isWritable: true }, { pubkey: new PublicKey(USDC_ACC), isSigner: false, isWritable: true }] });
      const msg = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: freshBlockhash(), instructions: [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: POOL, lamports: 1_000 }), ix] }).compileToV0Message();
      return goodOrder(q, Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64'));
    };
    expect(String((await run('sell') as Error).message)).toContain('changed its amount');
    net.order = (q) => goodOrder(q);
    // no simulation answer at all: refused (fail closed), never signed
    orderChain('sell');
    net.sim = 'error';
    const down = await run('sell');
    expect(down).toBeInstanceOf(JupiterOrderRefusal);
    expect(String((down as Error).message)).toMatch(/could not be simulated/);
    expect(net.executeBodies.length).toBe(1);                            // only the one good buy above reached /execute
  });

  it('FIXBUY2-T26 a new token account of the owner may be funded within the rent allowance only; a lookup table the chain cannot show refuses the order', async () => {
    setConfig({ JUP_ORDER_FALLBACK: 'both' });
    const owner = wallet.publicKey.toBase58();
    net.jupPlan['/swap/v2/build'] = [NO_ROUTE, NO_ROUTE];
    orderChain('buy', { spend: 50_405_000 + Number(ORDER_NEW_ACCOUNT_RENT_MAX) });
    net.chain.set(OWNER_TOKEN_ACC, { pre: null, post: tokenAccount(PLAIN_MINT, owner, 777_000n, { lamports: Number(ORDER_NEW_ACCOUNT_RENT_MAX) }) });
    expect((await smartBuy(wallet, PLAIN_MINT, 0.05, { singleSend: true, priorityFee: 100_000 })).sent).toBe(true);
    orderChain('buy', { spend: 50_405_001 + Number(ORDER_NEW_ACCOUNT_RENT_MAX) + 1 });
    net.chain.set(OWNER_TOKEN_ACC, { pre: null, post: tokenAccount(PLAIN_MINT, owner, 777_000n, { lamports: Number(ORDER_NEW_ACCOUNT_RENT_MAX) + 2 }) });
    expect(await settle(smartBuy(wallet, PLAIN_MINT, 0.05, { singleSend: true, priorityFee: 100_000 }))).toBeInstanceOf(JupiterOrderRefusal);
    // an EXISTING account handed over to the owner cost the owner nothing: it widens nothing
    net.jupPlan['/swap/v2/build'] = [NO_ROUTE];
    orderChain('buy', { spend: 50_405_000 + 1_000_000 });
    net.chain.set(OWNER_TOKEN_ACC, { pre: tokenAccount(PLAIN_MINT, POOL.toBase58(), 0n), post: tokenAccount(PLAIN_MINT, owner, 777_000n) });
    const handed = await settle(smartBuy(wallet, PLAIN_MINT, 0.05, { singleSend: true, priorityFee: 100_000 }));
    expect(handed).toBeInstanceOf(JupiterOrderRefusal);
    expect(String((handed as Error).message)).toContain('owner lamport outflow above bound (51405000 > 50405000)');
    // an order compiled against a lookup table: the table is read from the chain (here it does not exist), never trusted
    orderChain('sell');
    net.jupPlan['/swap/v2/build'] = [NO_ROUTE];
    net.order = (q) => {
      const table = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [new PublicKey(OWNER_TOKEN_ACC)] } });
      const ix = new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM), data: Buffer.from([17]), keys: [{ pubkey: new PublicKey(OWNER_TOKEN_ACC), isSigner: false, isWritable: true }] });
      const msg = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: freshBlockhash(), instructions: [ix] }).compileToV0Message([table]);
      return goodOrder(q, Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64'));
    };
    const err = await settle(smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true }));
    expect(err).toBeInstanceOf(JupiterOrderRefusal);
    expect(String((err as Error).message)).toMatch(/lookup table/);
  });

  it('FIXBUY2-T27 /execute: a non-zero code (-1005) is an error carrying the code, with the signature in RouterSendError.sigs; a 5xx is POSTed once more, identical', async () => {
    net.executePlan = ['-1005'];
    const seen: SignedTx[] = [];
    const err = await settle(smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true, onSigned: async (s) => { seen.push(s); } }));
    expect(err).toBeInstanceOf(RouterSendError);
    expect((err as RouterSendError).sigs).toEqual([seen[0].sig]);
    expect((err as Error).message).toMatch(/code -1005/);
    expect(net.executeBodies).toHaveLength(1);
    expect(net.builds).toBe(1);                                          // no retry, no second route under singleSend
    expect(new JupiterExecuteError(-1005, 200, 'x').code).toBe(-1005);
    // a 503 and then success: the second POST is byte-identical (same signed transaction, same requestId)
    vi.useFakeTimers();
    orderChain('sell');
    net.executeBodies = []; net.sigOrder = []; net.executePlan = [];
    net.jupPlan['/swap/v2/build'] = [NO_ROUTE];
    let posts = 0;
    h.http.mockImplementation(async (url: string, init?: any) => {
      if (String(url).includes('/swap/v2/execute') && ++posts === 1) { net.executeBodies.push(JSON.parse(String(init.body))); return res('upstream timeout', 503); }
      return fakeHttp(url, init);
    });
    const run = smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true });
    await vi.advanceTimersByTimeAsync(5_000);
    const r = await run;
    expect(r.sent).toBe(true);
    expect(net.executeBodies).toHaveLength(2);
    expect(net.executeBodies[1]).toEqual(net.executeBodies[0]);
    expect(r.sigs).toEqual([r.sig]);
  });

  it('FIXBUY2-T28 buildOnly (dry run): the order is verified, simulated and signed, /execute is never called and onSigned never runs', async () => {
    const onSigned = vi.fn(async () => {});
    const r = await smartSell(wallet, PLAIN_MINT, 1_000n, { buildOnly: true, onSigned });
    expect(r.sent).toBe(false);
    expect(bs58.decode(r.sig)).toHaveLength(64);
    expect(net.orders).toBe(1);
    expect(net.sims).toHaveLength(1);
    expect(net.executeBodies).toEqual([]);
    expect(onSigned).not.toHaveBeenCalled();
  });
});

describe('Jupiter V3 route (/order, sign, /execute) through the router', () => {
  beforeEach(() => {
    setConfig({ USE_JUPITER_V3: true, JUPITER_API_KEY: testKey(), HELIUS_SENDER_URL: '' });
    net.sim = { err: null, logs: [], unitsConsumed: 150_000 };
    orderChain('buy');                                                   // FIX-BUY2 item 7(e): the order is simulated before signing
  });

  it('A26 the order carries the bound (a STRING since FIX-BUY2) and its impact (priceImpact, percent); /execute is the one send, after onSigned', async () => {
    net.orderImpact = '0.4';                                            // 0.4 %
    const seen: SignedTx[] = [];
    const r = await smartBuy(wallet, PLAIN_MINT, 0.05, { maxImpactPct: 0.5, onSigned: async (s) => { net.events.push(`onSigned:${s.sig}`); seen.push(s); } });
    expect(seen).toEqual([{ sig: r.sig, lastValidBlockHeight: 777_003, route: 'jupiter' }]);
    expect(net.executes).toEqual([r.sig]);
    expect(net.events).toEqual([`onSigned:${r.sig}`, `send:${r.sig}`]);
    expect(net.sends).toEqual([]);                                      // Jupiter broadcasts server-side
  });

  it('A26 an order above the cap is refused before signing (nothing executed), buildOnly never executes, an aborting onSigned never executes', async () => {
    net.orderImpact = '20';                                             // 20 %
    const err = await settle(smartBuy(wallet, PLAIN_MINT, 0.05, { maxImpactPct: 15 }));
    expect(err).toBeInstanceOf(ImpactCapError);
    expect((err as ImpactCapError).refused[0].impactPct).toBeCloseTo(20, 6);
    expect(net.orders).toBe(1);
    expect(net.executes).toEqual([]);

    net.orderImpact = '0.1';
    const built = await smartBuy(wallet, PLAIN_MINT, 0.05, { buildOnly: true });
    expect(built.sent).toBe(false);
    const boom = new Error('journal write failed');
    expect(await settle(smartBuy(wallet, PLAIN_MINT, 0.05, { onSigned: async () => { throw boom; } }))).toBe(boom);
    expect(net.executes).toEqual([]);
    expect(net.swaps).toBe(0);
  });

  it('A26 a failed /execute: singleSend ends the call with a RouterSendError (no V3 retry, no fallback); otherwise the /swap/v2/build route sends a second transaction', async () => {
    vi.useFakeTimers();
    net.executePlan = ['Failed'];
    const run = settle(smartBuy(wallet, PLAIN_MINT, 0.05, { singleSend: true }));
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await run;
    expect(err).toBeInstanceOf(RouterSendError);
    expect((err as RouterSendError).sigs).toEqual(net.executes);
    expect((err as RouterSendError).sigs).toHaveLength(1);
    expect(net.orders).toBe(1);
    expect(net.swaps).toBe(0);

    net.executes = []; net.sigOrder = []; net.orders = 0; net.executePlan = ['Failed'];
    const run2 = smartBuy(wallet, PLAIN_MINT, 0.05);
    await vi.advanceTimersByTimeAsync(5_000);
    const r = await run2;
    expect(net.builds).toBe(1);                      // the V3 -> /swap/v2/build fallback of the first attempt (FIX-BUY2), both signatures reported
    expect(net.swaps).toBe(0);
    expect(r.sigs).toHaveLength(2);
    expect(r.sig).toBe(r.sigs![1]);
  });
});

describe('send context validation on the Jupiter entry points (A-26)', () => {
  beforeEach(() => { setConfig({ JUPITER_API_KEY: testKey(), HELIUS_SENDER_URL: '' }); });

  it('A26 executeWithRetry takes the send context as its tenth argument and records the signature it sent', async () => {
    const ctx = createSendContext({});
    const { sig } = await executeWithRetry(wallet, SOL, PLAIN_MINT, 50_000_000, 300, 3, true, 100_000, true, ctx);
    expect(ctx.sigs).toEqual([sig]);
    const built = createSendContext({ buildOnly: true });
    const out = await executeWithRetry(wallet, SOL, PLAIN_MINT, 50_000_000, 300, 3, true, 100_000, true, built);
    expect(built.builtSig).toBe(out.sig);
    expect(built.sigs).toEqual([]);
    expect(uniqueSends()).toEqual([sig]);
  });

  it('A58 a failure before any send: a buy retries at the caller\'s slippage, never above it; a sell may escalate', async () => {
    vi.useFakeTimers();
    setConfig({ USE_JUPITER_V3: false });
    // FIX-BUY2: the failure before any send is a rate-limited /swap/v2/build (4 tries of the one key; a 429 has no legacy stand-in)
    const failFirstBuild = (): void => {
      net.jupPlan['/swap/v2/build'] = Array.from({ length: 4 }, () => ({ status: 429, body: { message: '[API Gateway] Too many requests' } }));
      h.http.mockClear();
    };
    const builtBps = (): number[] => requestedBps('/swap/v2/build');

    failFirstBuild();
    const buy = settle(executeWithRetry(wallet, SOL, PLAIN_MINT, 50_000_000, 300, 3, true, 100_000, false, createSendContext({ singleSend: true })));
    await vi.advanceTimersByTimeAsync(10_000);
    const out = await buy as { sig: string; quote: any };
    expect(builtBps()).toEqual([300, 300, 300, 300, 300]);
    expect(out.quote.slippageBps).toBe(300);
    expect(uniqueSends()).toEqual([out.sig]);

    failFirstBuild();
    const sell = settle(executeWithRetry(wallet, PLAIN_MINT, SOL, 1_000, 300, 3, true, 100_000, false, createSendContext({ singleSend: true })));
    await vi.advanceTimersByTimeAsync(10_000);
    await sell;
    expect(builtBps()).toEqual([300, 300, 300, 300, 450]);
  });
});

// -- R3-B5 (B50 section 2, A-68): JUP_API_BASE; FIX-BUY2 item 1: one keyed host ---------------------------------------------------

describe('Jupiter URLs derive from JUP_API_BASE; every Jupiter request is keyed (FIX-BUY2 item 1: no keyless or lite-api tier)', () => {
  /** Runs one jupQuote with these environment values and returns the URLs and headers the HTTP client was asked for. */
  async function quoteCalls(env: Record<string, string | undefined>, withKey: boolean): Promise<{ urls: string[]; headers: Array<Record<string, string>>; error: unknown }> {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    setConfig({ JUPITER_API_KEY: withKey ? testKey() : '' });
    h.http.mockClear();
    try {
      const error = await jupQuote(SOL, PLAIN_MINT, 50_000_000, 300).then(() => null, (e) => e);
      return { urls: h.http.mock.calls.map((c) => String(c[0])), headers: h.http.mock.calls.map((c) => ((c[1] as { headers?: Record<string, string> } | undefined)?.headers ?? {})), error };
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }

  it('unset: the api.jup.ag literal, with the key; set: JUP_API_BASE; the old JUP_FALLBACK_BASE is read by nothing', async () => {
    const keyed = await quoteCalls({ JUP_API_BASE: undefined }, true);
    expect(keyed.urls).toHaveLength(1);
    expect(keyed.urls[0].startsWith('https://api.jup.ag/swap/v1/quote?')).toBe(true);
    expect(keyed.headers[0]['x-api-key']).toBe(CONFIG.JUPITER_API_KEY);
    const env = { JUP_API_BASE: 'http://127.0.0.1:7001/', JUP_FALLBACK_BASE: 'http://127.0.0.1:7002' };
    const set = await quoteCalls(env, true);
    expect(set.urls).toHaveLength(1);
    expect(set.urls[0].startsWith('http://127.0.0.1:7001/swap/v1/quote?')).toBe(true);
    for (const u of set.urls) expect(u).not.toMatch(/jup\.ag|7002/);
  });

  it('FIXBUY2-T06 without JUPITER_API_KEY nothing is requested: the Jupiter route refuses with "JUPITER_API_KEY missing" (no keyless, no lite-api request), and the router does not retry it', async () => {
    const none = await quoteCalls({ JUP_API_BASE: undefined }, false);
    expect(none.urls).toEqual([]);
    expect(none.error).toBeInstanceOf(JupiterRequestError);
    expect(String((none.error as Error).message)).toMatch(/^JUPITER_API_KEY missing/);
    setConfig({ JUPITER_API_KEY: '' });
    h.http.mockClear();
    for (const run of [() => smartBuy(wallet, PLAIN_MINT, 0.05), () => smartSell(wallet, PLAIN_MINT, 1_000n, { antiMev: false })]) {
      const err = await settle(run());
      expect(err).toBeInstanceOf(JupiterRequestError);
      expect((err as Error).message).toMatch(/JUPITER_API_KEY missing/);
    }
    expect(h.http.mock.calls.map((c) => String(c[0])).filter((u) => /jup\.ag/.test(u))).toEqual([]);   // final: not one Jupiter request, no retry
    expect(net.sends).toEqual([]);
  });
});

// ── FIX-BUY2 item 1: Jupiter errors keep their reason, one keyed host, slippage inside Jupiter's range ───────────────────────────
describe('FIX-BUY2 item 1: typed Jupiter errors, the refused body logged, no replay of a 400', () => {
  const KEY_A = 'ka-' + randomBytes(6).toString('hex');
  const KEY_B = 'kb-' + randomBytes(6).toString('hex');
  beforeEach(() => { setConfig({ JUPITER_API_KEY: KEY_A, JUPITER_API_KEY_FALLBACK: KEY_B, USE_JUPITER_V3: false }); });
  /** Every Jupiter request since the last mockClear: its URL and the key it carried. */
  const jupCalls = (): Array<{ url: string; key: string | undefined }> => h.http.mock.calls
    .filter((c) => /\/swap\/v[12]\//.test(String(c[0])))
    .map((c) => ({ url: String(c[0]), key: ((c[1] as { headers?: Record<string, string> } | undefined)?.headers ?? {})['x-api-key'] }));

  it('FIXBUY2-T01 /build 400 "No routes found" is JupiterNoRouteError after exactly ONE build request: no second key, no other host, no retry, no legacy /swap', async () => {
    vi.useFakeTimers();
    net.jupPlan['/swap/v2/build'] = [{ status: 400, body: { error: 'No routes found' }, headers: { 'x-api-gateway-request-id': 'req-abc-123' } }];
    h.http.mockClear();
    const run = settle(smartBuy(wallet, PLAIN_MINT, 0.05, { singleSend: true }));
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await run;
    expect(err).toBeInstanceOf(JupiterNoRouteError);
    expect(err).toMatchObject({ endpoint: 'build', status: 400, requestId: 'req-abc-123', body: '{"error":"No routes found"}' });
    expect((err as Error).message).toMatch(/no route/i);
    expect(net.builds).toBe(1);
    expect(net.swaps).toBe(0);
    expect(jupCalls().filter((c) => c.url.includes('/swap/v2/build')).map((c) => c.key)).toEqual([KEY_A]);
    expect(net.sends).toEqual([]);
  });

  it('FIXBUY2-T02 a v1 400 with errorCode NO_ROUTES_FOUND, COULD_NOT_FIND_ANY_ROUTE or TOKEN_NOT_TRADABLE is JupiterNoRouteError after ONE quote request', async () => {
    vi.useFakeTimers();
    for (const errorCode of ['NO_ROUTES_FOUND', 'COULD_NOT_FIND_ANY_ROUTE', 'TOKEN_NOT_TRADABLE']) {
      net.jupPlan['/swap/v1/quote'] = [{ status: 400, body: { error: 'whatever the text', errorCode } }];
      h.http.mockClear();
      const run = settle(jupQuote(SOL, PLAIN_MINT, 50_000_000, 300));
      await vi.advanceTimersByTimeAsync(10_000);
      const err = await run;
      expect(err, errorCode).toBeInstanceOf(JupiterNoRouteError);
      expect(jupCalls(), errorCode).toHaveLength(1);
    }
  });

  it('FIXBUY2-T03 any other 400 is JupiterRequestError, final: one request, never replayed on the fallback key, never retried by executeWithRetry', async () => {
    vi.useFakeTimers();
    net.jupPlan['/swap/v2/build'] = [{ status: 400, body: { error: 'slippageBps: Number must be less than or equal to 10000' } }];
    h.http.mockClear();
    const run = settle(executeWithRetry(wallet, PLAIN_MINT, SOL, 1_000, 300, 3, true, 100_000, true, createSendContext({ singleSend: true })));
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await run;
    expect(err).toBeInstanceOf(JupiterRequestError);
    expect(err).not.toBeInstanceOf(JupiterNoRouteError);
    expect((err as Error).message).toContain('refused the request (HTTP 400');
    expect(jupCalls()).toEqual([expect.objectContaining({ key: KEY_A })]);   // no second key, no legacy /swap, no retry
  });

  it('FIXBUY2-T04 429 on both keys: four tries per key with the 400/1200/3000 ms backoffs, then JupiterUnavailableError that never says "no route"; executeWithRetry retries it and a later answer goes through', async () => {
    vi.useFakeTimers();
    const r429 = { status: 429, body: { message: '[API Gateway] Too many requests' } };
    net.jupPlan['/swap/v1/quote'] = Array.from({ length: 8 }, () => r429);
    h.http.mockClear();
    const run = settle(jupQuote(SOL, PLAIN_MINT, 50_000_000, 300));
    await vi.advanceTimersByTimeAsync(20_000);
    const err = await run;
    expect(err).toBeInstanceOf(JupiterUnavailableError);
    expect(err).toMatchObject({ kind: 'rate-limited', status: 429 });
    expect((err as Error).message).not.toMatch(/no route/i);
    expect(jupCalls().map((c) => c.key)).toEqual([KEY_A, KEY_A, KEY_A, KEY_A, KEY_B, KEY_B, KEY_B, KEY_B]);

    // through the router: the first attempt's /swap/v2/build is rate-limited on both keys (no legacy stand-in after a 429: the same rate
    // bucket), the second attempt gets an answer: one send, never "no route"
    net.jupPlan['/swap/v2/build'] = Array.from({ length: 8 }, () => r429);
    h.http.mockClear();
    const run2 = settle(smartSell(wallet, PLAIN_MINT, 1_000n, { singleSend: true }));
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await run2 as Awaited<ReturnType<typeof smartSell>>;
    expect(r.sent).toBe(true);
    expect(uniqueSends()).toEqual([r.sig]);
    expect(net.swaps).toBe(0);
    expect(jupCalls().filter((c) => c.url.includes('/swap/v2/build'))).toHaveLength(9);
  });

  it('FIXBUY2-T04 a 5xx of the legacy /swap after its backoffs is JupiterUnavailableError (kind server), retried, never "no route"', async () => {
    vi.useFakeTimers();
    setConfig({ HELIUS_SENDER_URL: '' });
    // FIX-BUY2 item 4: the legacy /swap is only the stand-in for a /build outage, so /build is down too
    net.jupPlan['/swap/v2/build'] = Array.from({ length: 8 }, () => ({ status: 503, body: 'upstream unavailable' }));
    net.jupPlan['/swap/v1/swap'] = Array.from({ length: 8 }, () => ({ status: 503, body: 'upstream unavailable' }));
    h.http.mockClear();
    const run = settle(executeWithRetry(wallet, SOL, PLAIN_MINT, 50_000_000, 300, 1, true, 100_000, false, createSendContext({ singleSend: true })));
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await run;
    expect(err).toBeInstanceOf(JupiterUnavailableError);
    expect(err).toMatchObject({ kind: 'server', status: 503, endpoint: 'swap' });
    expect((err as Error).message).not.toMatch(/no route/i);
    expect(net.sends).toEqual([]);
    expect(net.quotes).toBe(1);
  });

  it('FIXBUY2-T05 a 401 tries the fallback key ONCE: a good second key goes through; two refused keys are JupiterRequestError after two requests', async () => {
    vi.useFakeTimers();
    net.jupPlan['/swap/v1/quote'] = [{ status: 401, body: { message: 'Invalid API key' } }];
    h.http.mockClear();
    const ok = await jupQuote(SOL, PLAIN_MINT, 50_000_000, 300);
    expect(ok.outAmount).toBe('777000');
    expect(jupCalls().map((c) => c.key)).toEqual([KEY_A, KEY_B]);

    net.jupPlan['/swap/v1/quote'] = [{ status: 403, body: { message: 'API key does not have access to this endpoint' } }, { status: 401, body: { message: 'Invalid API key' } }];
    h.http.mockClear();
    const run = settle(jupQuote(SOL, PLAIN_MINT, 50_000_000, 300));
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await run;
    expect(err).toBeInstanceOf(JupiterRequestError);
    expect(err).toMatchObject({ status: 401 });
    expect((err as Error).message).toMatch(/refused the API key/);
    expect(jupCalls().map((c) => c.key)).toEqual([KEY_A, KEY_B]);
    // no fallback key configured: one request
    setConfig({ JUPITER_API_KEY_FALLBACK: '' });
    net.jupPlan['/swap/v1/quote'] = [{ status: 401, body: {} }];
    h.http.mockClear();
    expect(await settle(jupQuote(SOL, PLAIN_MINT, 50_000_000, 300))).toBeInstanceOf(JupiterRequestError);
    expect(jupCalls()).toHaveLength(1);
  });

  it('FIXBUY2-T06 no request goes to lite-api.jup.ag and every Jupiter request carries x-api-key (quote, build, legacy /swap, /order, /execute)', async () => {
    h.http.mockClear();
    await smartBuy(wallet, PLAIN_MINT, 0.05);                                   // build (Sender lane)
    setConfig({ HELIUS_SENDER_URL: '' });
    net.jupPlan['/swap/v2/build'] = ['throw'];
    await smartSell(wallet, PLAIN_MINT, 1_000n);                                // build (no answer), then quote + legacy /swap
    setConfig({ USE_JUPITER_V3: true });
    net.sim = { err: null, logs: [], unitsConsumed: 150_000 };
    orderChain('buy');
    await smartBuy(wallet, PLAIN_MINT, 0.05);                                   // /order + /execute
    const calls = jupCalls();
    for (const part of ['/swap/v1/quote', '/swap/v2/build', '/swap/v1/swap', '/swap/v2/order', '/swap/v2/execute']) expect(calls.some((c) => c.url.includes(part)), part).toBe(true);
    for (const c of calls) {
      expect(c.url.startsWith('https://api.jup.ag/'), c.url).toBe(true);
      expect(c.key, c.url).toBe(KEY_A);
    }
    expect(h.http.mock.calls.map((c) => String(c[0])).some((u) => /lite-api/.test(u))).toBe(false);
  });

  it('FIXBUY2-T07 a sell at base 9 900 never asks Jupiter for more than 10 000 bps, however it escalates (A-58 escalation after outages, capped)', async () => {
    vi.useFakeTimers();
    setConfig({ JUPITER_API_KEY_FALLBACK: '' });
    const r429 = { status: 429, body: { message: '[API Gateway] Too many requests' } };
    net.jupPlan['/swap/v2/build'] = Array.from({ length: 8 }, () => r429);    // two rate-limited attempts (4 tries each) before anything is built
    h.http.mockClear();
    const run = settle(executeWithRetry(wallet, PLAIN_MINT, SOL, 1_000, 9_900, 3, true, 100_000, true, createSendContext({ singleSend: true })));
    await vi.advanceTimersByTimeAsync(20_000);
    const out = await run as { sig: string; quote: any };
    expect(requestedBps('/swap/v2/build')).toEqual([9_900, 9_900, 9_900, 9_900, 10_000, 10_000, 10_000, 10_000, 10_000]);
    expect(Math.max(...requestedBps('/swap/v2/'))).toBeLessThanOrEqual(10_000);
    expect(out.quote.slippageBps).toBe(10_000);
    expect(jupSlippageBps(14_850)).toBe(10_000);
    expect(jupSlippageBps(300)).toBe(300);
    expect(JUP_MAX_SLIPPAGE_BPS).toBe(10_000);
  });

  it('FIXBUY2-T08 a refused answer is logged with its body (redacted, at most 120 characters) and Jupiter\'s request id; the error carries both', async () => {
    vi.useFakeTimers();
    const leaky = `bad request api-key=${KEY_A} ${'x'.repeat(300)}`;
    net.jupPlan['/swap/v2/build'] = [{ status: 422, body: { error: leaky }, headers: { 'x-api-gateway-request-id': 'gw-77' } }];
    (logWarn as unknown as ReturnType<typeof vi.fn>).mockClear();
    const run = settle(smartBuy(wallet, PLAIN_MINT, 0.05));
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await run;
    expect(err).toBeInstanceOf(JupiterRequestError);
    const e = err as JupiterRequestError;
    expect(e.requestId).toBe('gw-77');
    expect(e.body.length).toBeLessThanOrEqual(JUP_ERROR_BODY_CHARS);
    expect(e.body).not.toContain(KEY_A);
    expect(e.message).not.toContain(KEY_A);
    expect(e.message.length).toBeLessThanOrEqual(200);
    const lines = (logWarn as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).filter((l) => l.includes('/swap/v2/build HTTP 422'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('(request gw-77)');
    expect(lines[0]).not.toContain(KEY_A);
  });

  it('FIXBUY2-T08 no answer at all (a timeout) is JupiterUnavailableError kind timeout, never "no route"', async () => {
    net.jupPlan['/swap/v1/quote'] = ['throw'];
    h.http.mockClear();
    const err = await settle(jupQuote(SOL, PLAIN_MINT, 50_000_000, 300));
    expect(err).toBeInstanceOf(JupiterUnavailableError);
    expect(err).toMatchObject({ kind: 'timeout', status: null, endpoint: 'quote' });
    expect((err as Error).message).not.toMatch(/no route/i);
    expect(jupCalls()).toHaveLength(1);                                         // no answer is not tried again inside the call
  });
});

// ── B6-T07 (R4-B6): the price-site helper is gone from the execution layer ─────────────────────────────

describe('the price-site helper is removed (plan grind #42, A-39)', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
    }
    return out;
  };

  it('B6-T07 grep: getDexPrice is gone and no file under src/execution names the price site', async () => {
    const files = walk(__dirname);
    expect(files.length).toBeGreaterThan(10);
    const banned = new RegExp(['dex', 'screener'].join(''), 'i');
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      expect(banned.test(text), `${path.basename(f)} names a third-party price site`).toBe(false);
      expect(/getDexPrice/.test(text), `${path.basename(f)} still mentions getDexPrice`).toBe(false);
    }
    const mod = await import('./jupiter');
    expect(Object.keys(mod)).not.toContain('getDexPrice');
  });

  it('no execution module imports src/scanners/** (A-39: the pump.fun scanner is deleted, the coin-info fallback lives in execution/pumpfun-info.ts)', () => {
    for (const f of walk(__dirname)) {
      expect(/from\s+['"]\.\.\/scanners\//.test(fs.readFileSync(f, 'utf8')), `${path.basename(f)} imports a scanner`).toBe(false);
    }
    expect(fs.existsSync(path.resolve(__dirname, '..', 'scanners', 'pumpfun-direct.ts'))).toBe(false);
    expect(fs.existsSync(path.resolve(__dirname, '..', 'lib', 'canonical-pair.ts'))).toBe(false);
  });
});

// PUB-1 (public release): the rebate parameter only ever carries a wallet the user configured; the default configuration has none.
describe('PUB-1 rpcUrlWithRebate: Helius backrun rebates pay only a wallet the user configured', () => {
  const SENDER = 'https://sender.helius-rpc.com/fast';
  const HELIUS_LANE = 'https://mainnet.helius-rpc.com/?api-key=k';
  const OTHER_LANE = 'https://rpc.example.org/';
  const settingsFile = (): string => path.join(botDataDir(), 'settings.json');
  afterEach(() => {
    fs.rmSync(settingsFile(), { force: true });
    invalidateRebatesCache();
  });

  it('the default configuration has no wallet: the switch is on, yet every URL goes out unchanged', () => {
    expect(CONFIG.HELIUS_MARKETING_WALLET).toBe('');
    expect(CONFIG.ENABLE_BACKRUN_REBATES).toBe(true);
    for (const u of [SENDER, HELIUS_LANE, OTHER_LANE, '']) expect(rpcUrlWithRebate(u)).toBe(u);
  });

  it('a wallet in the env adds rebate-address to Helius URLs only, and only once', () => {
    const own = Keypair.generate().publicKey.toBase58();   // a throwaway wallet, made at run time
    setConfig({ HELIUS_MARKETING_WALLET: own });
    expect(rpcUrlWithRebate(SENDER)).toBe(`${SENDER}?rebate-address=${own}`);
    expect(rpcUrlWithRebate(HELIUS_LANE)).toBe(`${HELIUS_LANE}&rebate-address=${own}`);
    expect(rpcUrlWithRebate(OTHER_LANE)).toBe(OTHER_LANE);
    expect(rpcUrlWithRebate(`${SENDER}?rebate-address=${own}`)).toBe(`${SENDER}?rebate-address=${own}`);
  });

  it('a wallet saved with /rebates (settings.json in the bot data folder) adds it; turned OFF there, nothing is added, an env wallet included', () => {
    const own = Keypair.generate().publicKey.toBase58();
    fs.mkdirSync(botDataDir(), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ schema: 2, rebates: { enabled: true, address: own } }));
    invalidateRebatesCache();
    expect(rpcUrlWithRebate(SENDER)).toBe(`${SENDER}?rebate-address=${own}`);
    setConfig({ HELIUS_MARKETING_WALLET: Keypair.generate().publicKey.toBase58() });
    fs.writeFileSync(settingsFile(), JSON.stringify({ schema: 2, rebates: { enabled: false, address: own } }));
    invalidateRebatesCache();
    expect(rpcUrlWithRebate(SENDER)).toBe(SENDER);
  });
});