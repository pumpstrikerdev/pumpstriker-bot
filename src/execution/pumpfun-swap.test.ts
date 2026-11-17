/**
 * B40 pumpfun-swap / pumpswap-swap wiring: the latency harness, the pre-sign gate of the PF-direct route, the additive *Quoted fields and
 * the on-chain curve read. Everything external is mocked (Jupiter senders and RPC pool, node-fetch, the pump.fun API reader, the logger):
 * no socket, no wallet file, no real signature.
 *
 * A-26 / A-27 sections: the real router and the real pump routes run against a counting sender (the mocked heliusSmartSend /
 * multiRpcSend are the only way a transaction leaves) and a stubbed Jupiter route that goes through the same send gate.
 *
 * FIX-PUMP (2026-11-06): PF-direct is ON again with the LOCAL builder only, for classic Token and Token-2022 coins. The route's chain read,
 * the strict verifier's pre-state read and its simulation are answered by a scripted chain (pump-direct-testkit.ts) behind the mocked
 * resilient RPC pool. PumpPortal is never asked for anything (every test counts its requests). PumpSwap-direct stays off (A-93g); its
 * mechanics tests still run through its test-only opt-in (RUN_DISABLED).
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import bs58 from 'bs58';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  send: vi.fn(),
  blockhash: vi.fn(),
  prio: vi.fn(),
  rpc: vi.fn(),
  fetch: vi.fn(),
  cached: vi.fn(),
  fetchInfo: vi.fn(),
  exec: vi.fn(),
}));
vi.mock('./jupiter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jupiter')>();
  return {
    ...actual,
    heliusSmartSend: h.send,
    multiRpcSend: h.send,
    getResilientBlockhash: h.blockhash,
    getPriorityFeeForSwap: h.prio,
    resilientRpcCall: h.rpc,
    executeWithRetry: h.exec,
  };
});
vi.mock('node-fetch', () => ({ default: h.fetch }));
vi.mock('./pumpfun-info', () => ({ getCachedPumpFunInfo: h.cached, fetchPumpFunInfo: h.fetchInfo }));
vi.mock('../logger', () => ({ log: vi.fn(), logOk: vi.fn(), logWarn: vi.fn(), logErr: vi.fn(), logDbg: vi.fn(), setBroadcast: vi.fn(), emitEvent: vi.fn() }));

import { PUMP_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from './exec-common';
import {
  getTokenProgramForMint, notePfDirectLayoutRejected, PF_DIRECT_ENABLED, PfDirectDisabledError, pfDirectBreakerOpen, pumpfunBuy, pumpfunSell,
  pumpPortalPrioritySol, PumpDirectRefusal, resetPfDirectBreakerForTests,
} from './pumpfun-swap';
import { CONFIG } from '../config';
import { derivePumpSwapCanonicalPool, pumpswapBuy, pumpswapSell } from './pumpswap-swap';
import { createSendContext, dispatchSigned, ImpactCapError, enforceImpactCap, mustStop, OnSignedAbort, PreSignRefusal, RouterSendError, type SignedTx } from './send-context';
import { smartBuy, smartSell } from './router';
import { addPumpWorld, createPumpDirectChain, type PumpDirectChain } from './pump-direct-testkit';
import { pumpBuyQuote, pumpSellQuote } from './pump-program';
import { PF_DIRECT_TIP_LAMPORTS, TIP_ACCOUNTS } from './tx-verify';
import { HELIUS_TIP_LAMPORTS } from './jupiter';
import { buyNetLamports } from './pumpfun-ix';

const key = (n: number): string => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const wallet = Keypair.fromSeed(new Uint8Array(32).fill(1));
const OWNER = wallet.publicKey.toBase58();
const pk = (s: string): PublicKey => new PublicKey(s);

const CLASSIC_MINT = key(31);                                   // classic Token program
const SWAP_MINT = key(32);                                      // graduated, PumpSwap pool
const T22_MINT = `${key(33).slice(0, key(33).length - 4)}pump`;  // Token-2022 pump.fun mint (vanity suffix)

const info = {
  hasData: true, complete: false, virtualSolReserves: 30_000_000_000, virtualTokenReserves: 1_073_000_000_000_000,
  realSolReserves: 0, realTokenReserves: 0, bondingCurveProgress: 0.1, creator: key(3),
};
/** The owner holds 400 T atoms of each curve coin; the curves hold 20 SOL of real SOL (a 300 T sell fits). */
const HELD = 400_000_000_000_000n;

/** A PumpSwap Pool account at the IDL offsets (A-93g; pumpswap-swap.test.ts pins them against the IDL fixture). */
function poolBytes(): Buffer {
  const b = Buffer.alloc(300);
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(b, 0);   // Pool account discriminator
  Buffer.from(pk(SWAP_MINT).toBytes()).copy(b, 43);
  Buffer.from(pk(WSOL_MINT).toBytes()).copy(b, 75);
  Buffer.from(pk(key(10)).toBytes()).copy(b, 139);
  Buffer.from(pk(key(11)).toBytes()).copy(b, 171);
  Buffer.from(pk(key(12)).toBytes()).copy(b, 211);                  // coin_creator
  return b;
}
/** A-93g: the direct PumpSwap route is disabled in production; its mechanics tests run it through the test-only opt-in. */
const RUN_DISABLED = { testOnlyRunDisabledRoute: true } as const;
/** Requests that reached PumpPortal (through the mocked node-fetch): FIX-PUMP keeps this at zero everywhere. */
const pumpPortalRequests = (): number => h.fetch.mock.calls.filter((c) => /pumpportal|trade-local/.test(String(c[0]))).length;

/** The scripted chain of the PF-direct route (see pump-direct-testkit.ts), rebuilt for every test. */
let chain: PumpDirectChain;
const rpcCalls = (method: string): number => chain.calls.filter((c) => c.method === method).length;

/** The signature a real sender would answer with: the one the signed transaction carries. */
const signatureOfSent = async (tx: VersionedTransaction): Promise<string> => bs58.encode(tx.signatures[0]);

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  resetPfDirectBreakerForTests();
  chain = createPumpDirectChain();
  addPumpWorld(chain, { mint: CLASSIC_MINT, owner: OWNER, creator: key(3), program: 'token', curve: { realSol: 20_000_000_000n }, held: HELD, uva: true });
  addPumpWorld(chain, { mint: T22_MINT, owner: OWNER, creator: key(3), program: 'token2022', curve: { realSol: 20_000_000_000n }, held: HELD, uva: true });
  h.send.mockImplementation(signatureOfSent);
  h.blockhash.mockResolvedValue({ blockhash: key(90), lastValidBlockHeight: BUILDER_LAST_VALID });
  h.prio.mockResolvedValue(100_000);
  h.cached.mockImplementation((mint: string) => (mint === SWAP_MINT ? { ...info, complete: true } : { ...info }));
  h.fetchInfo.mockResolvedValue({ hasData: false });
  // node-fetch: only the mint-owner probe of getTokenProgramForMint (PumpSwap) may use it; nothing answers a PumpPortal request
  h.fetch.mockImplementation(async (url: string, init?: { body?: string }) => {
    if (/pumpportal|trade-local/.test(String(url))) throw new Error('PumpPortal must never be called');
    const req = JSON.parse(String(init?.body));
    const mint = req.params?.[0];
    const owner = mint === T22_MINT ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    return { ok: true, status: 200, json: async () => ({ result: { value: { owner } } }) };
  });
  // Jupiter's resilient RPC pool: the PF-direct chain (build read, pre-state read, simulation), the PumpSwap pool state
  h.rpc.mockImplementation(async (method: string, params: any[]) => {
    if (method === 'getMultipleAccounts' || method === 'simulateTransaction') return chain.call(method, params);
    if (method === 'getAccountInfo') {
      if (params[0] === derivePumpSwapCanonicalPool(pk(SWAP_MINT)).toBase58()) return { value: { data: [poolBytes().toString('base64'), 'base64'] } };
      return { value: null };
    }
    if (method === 'getTokenAccountBalance') {
      return { value: { amount: params[0] === key(10) ? '250000000000000' : '91000000000' } };
    }
    if (method === 'getBlockHeight') return BLOCK_HEIGHT;
    throw new Error(`unexpected rpc ${method}`);
  });
  // The Jupiter route is a stub that goes through the same send gate as the real one (jupiter.test.ts covers the real route).
  h.exec.mockImplementation(jupiterStub());
});

const BLOCK_HEIGHT = 9_000;
const BUILDER_LAST_VALID = 4_242;
const JUPITER_LAST_VALID = 31_337;
/**
 * executeWithRetry stand-in: measures `impactPct`, then builds, signs and sends one dummy transaction through the gate. With `attempts` > 1
 * it tries again after a failed attempt the way executeWithRetry does: never after onSigned threw, never after a send under singleSend.
 */
function jupiterStub(o: { impactPct?: number | null; failAfterCap?: Error; attempts?: number } = {}) {
  return async (...a: any[]): Promise<{ sig: string; quote: any }> => {
    const send = a[9];
    enforceImpactCap(send, 'jupiter', o.impactPct === undefined ? 0.01 : o.impactPct);
    if (o.failAfterCap) throw o.failAfterCap;
    for (let attempt = 1; ; attempt++) {
      const t = new VersionedTransaction(new TransactionMessage({
        payerKey: wallet.publicKey, recentBlockhash: key(90),
        instructions: [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: pk(key(5)), lamports: attempt })],
      }).compileToV0Message());
      t.sign([wallet]);
      try {
        const { sig } = await dispatchSigned(send, t, 'jupiter', JUPITER_LAST_VALID, () => h.send(t, {}));
        return { sig, quote: { outAmount: '1234' } };
      } catch (e) {
        if (attempt >= (o.attempts ?? 1) || mustStop(send, e)) throw e;
      }
    }
  };
}

function p95(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.95 * s.length) - 1)];
}
async function harness(label: string, run: () => Promise<unknown>, n: number): Promise<{ label: string; p95: number; samples: number[] }> {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();   // signal received
    await run();                    // ... to the transaction handed to the sender (the mocked heliusSmartSend)
    samples.push(performance.now() - t0);
  }
  return { label, p95: p95(samples), samples };
}
/** The compute-unit price a sent transaction signs (its second instruction, SetComputeUnitPrice). */
const priceOf = (tx: VersionedTransaction): bigint => Buffer.from(tx.message.compiledInstructions[1].data).readBigUInt64LE(1);
const sigOf = (t: VersionedTransaction): string => bs58.encode(t.signatures[0]);
/** The transactions that left through the (mocked) senders, in order: this is the "mock RPC" send counter. */
const sentTxs = (): VersionedTransaction[] => h.send.mock.calls.map((c) => c[0] as VersionedTransaction);

describe('execution wiring', () => {
  it('B4-T08 latency harness reports received-to-submitted p95 for pf-direct classic, pf-direct Token-2022 (local build, verified and simulated) and PumpSwap, with no threshold', async () => {
    const N = 40;
    const classic = await harness('pf-direct classic', () => pumpfunBuy(wallet, CLASSIC_MINT, 0.05, null, 100_000, true), N);
    const pumpswap = await harness('PumpSwap', () => pumpswapBuy(wallet, SWAP_MINT, 0.05, null, 100_000, true, RUN_DISABLED), N);
    const token2022 = await harness('pf-direct Token-2022 (local build, strict verify and simulation)', () => pumpfunBuy(wallet, T22_MINT, 0.05, null, 100_000, true), N);

    // The harness only REPORTS (plan grind #54): the < 150 ms threshold lives in E2E-10 / vitest.perf.config.ts, not here.
    const lines = [classic, pumpswap, token2022].map((r) => `${r.label}: p95 ${r.p95.toFixed(2)} ms over ${r.samples.length} runs (mock RPC)`);
    console.info(`[latency harness] received -> submitted\n  ${lines.join('\n  ')}`);
    for (const r of [classic, pumpswap, token2022]) {
      expect(r.samples).toHaveLength(N);
      expect(Number.isFinite(r.p95)).toBe(true);
      expect(r.p95).toBeGreaterThanOrEqual(0);
    }
    expect(h.send).toHaveBeenCalledTimes(3 * N);   // every run reached the sender
    expect(rpcCalls('simulateTransaction')).toBe(2 * N);   // every PF-direct run was simulated before it was signed
    expect(pumpPortalRequests()).toBe(0);
  });

  it('FIXPUMP-S-T01 a Token-2022 and a classic-Token pf-direct buy and sell build locally, are verified and simulated before signing, and carry the quote fields', async () => {
    for (const mint of [T22_MINT, CLASSIC_MINT]) {
      chain.calls.length = 0;
      const buy = await pumpfunBuy(wallet, mint, 0.05, null, 100_000, true);
      expect(buy.tokensOut).toBe(pumpBuyQuote(30_000_000_000n, 1_073_000_000_000_000n, 50_000_000n)!.tokensOut);
      expect(buy.tokensOutQuoted).toBe(buy.tokensOut);
      expect(buy.slippageBpsUsed).toBe(100);                                     // smart default at 20 / 85 SOL progress
      const sell = await pumpfunSell(wallet, mint, 5_000_000n, null, 100_000, true);
      expect(sell.solOut).toBe(pumpSellQuote(30_000_000_000n, 1_073_000_000_000_000n, 5_000_000n)!.net);
      expect(sell.solOutQuoted).toBe(sell.solOut);
      // per trade: ONE build read and ONE simulation with its pre-state read, all at 'processed'
      expect(chain.calls.map((c) => c.method)).toEqual(['getMultipleAccounts', 'simulateTransaction', 'getMultipleAccounts', 'getMultipleAccounts', 'simulateTransaction', 'getMultipleAccounts']);
      for (const c of chain.calls) expect(c.params[1].commitment, c.method).toBe('processed');
      // the simulated transaction is the one that was signed and sent, byte for byte (the signature aside)
      const simulated = chain.calls.filter((c) => c.method === 'simulateTransaction').map((c) => VersionedTransaction.deserialize(Buffer.from(c.params[0], 'base64')));
      const sent = sentTxs().slice(-2);
      expect(simulated.map((t) => Buffer.from(t.message.serialize()).toString('base64'))).toEqual(sent.map((t) => Buffer.from(t.message.serialize()).toString('base64')));
      expect(simulated.every((t) => t.signatures[0].every((b) => b === 0))).toBe(true);
    }
    expect(pumpPortalRequests()).toBe(0);
    // the tip the route signs is the amount and the account set the verifier pins (jupiter.ts HELIUS_TIP_LAMPORTS, config's Sender accounts)
    expect(PF_DIRECT_TIP_LAMPORTS).toBe(BigInt(HELIUS_TIP_LAMPORTS));
    expect([...TIP_ACCOUNTS]).toEqual([...CONFIG.HELIUS_TIP_ACCOUNTS]);
  });

  it('FIXPUMP-S-T02 every refusal is thrown before signing: non-SOL quote, complete or short curve, an extension mint, a missing or short token account, a cashback coin without its accumulator, a failed simulation', async () => {
    const reset = (w: Parameters<typeof addPumpWorld>[1]): void => { addPumpWorld(chain, w); };
    const base = { mint: T22_MINT, owner: OWNER, creator: key(3), program: 'token2022' as const, held: HELD, uva: true };
    const cases: Array<[string, () => void, 'buy' | 'sell', RegExp]> = [
      ['USDC-quoted curve', () => reset({ ...base, curve: { quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } }), 'buy', /\(non-sol-quote\)/],
      ['complete curve', () => reset({ ...base, curve: { complete: true } }), 'buy', /\(curve-complete\)/],
      ['151-byte curve', () => reset({ ...base, curve: { len: 151 } }), 'buy', /\(curve-layout\)/],
      ['creator_fee_bps on a SOL curve', () => reset({ ...base, curve: { creatorFeeBps: 100n } }), 'buy', /\(curve-fee\)/],
      ['no curve', () => { chain.set(PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), pk(T22_MINT).toBuffer()], pk(PUMP_PROGRAM_ID))[0].toBase58(), null); }, 'buy', /\(no-curve\)/],
      ['a buy larger than the curve', () => reset({ ...base, curve: { realTok: 1_000n } }), 'buy', /\(oversized-buy\)/],
      ['no token account on a sell', () => { chain = createPumpDirectChain(); reset({ ...base, held: undefined }); }, 'sell', /\(insufficient-tokens\)/],
      ['too few tokens on a sell', () => reset({ ...base, held: 4_999_999n }), 'sell', /\(insufficient-tokens\)/],
      ['cashback coin without its accumulator', () => { chain = createPumpDirectChain(); reset({ ...base, curve: { cashback: true }, uva: false }); }, 'sell', /\(cashback-no-uva\)/],
    ];
    for (const [name, arrange, side, why] of cases) {
      chain = createPumpDirectChain();
      reset(base);
      arrange();
      const ctx = createSendContext({ onSigned: vi.fn(async () => {}) });
      const e = await (side === 'buy' ? pumpfunBuy(wallet, T22_MINT, 0.05, null, 100_000, true, { send: ctx }) : pumpfunSell(wallet, T22_MINT, 5_000_000n, null, 100_000, true, { send: ctx })).catch((x) => x);
      expect(e, name).toBeInstanceOf(PumpDirectRefusal);
      expect((e as Error).message, name).toMatch(why);
      expect(ctx.sigs, name).toEqual([]);
      expect(rpcCalls('simulateTransaction'), name).toBe(0);           // refused from the build read, before anything was built
    }
    // a mint with a TransferHook (14) is refused too
    chain = createPumpDirectChain();
    reset(base);
    const { pumpMintBytes } = await import('./pump-direct-testkit');
    chain.set(T22_MINT, { lamports: 1n, owner: TOKEN_2022_PROGRAM_ID, data: pumpMintBytes({ program: 'token2022', extensions: [18, 14] }) });
    expect((await pumpfunBuy(wallet, T22_MINT, 0.05, null, 100_000, true).catch((x) => x) as Error).message).toMatch(/\(mint-unsupported\)/);
    // a simulation that fails (the price moved) is a PreSignRefusal: nothing signed, nothing sent
    chain = createPumpDirectChain();
    reset(base);
    chain.sim.err = { InstructionError: [3, { Custom: 6042 }] };
    const ctx = createSendContext({ onSigned: vi.fn(async () => {}) });
    const e = await pumpfunBuy(wallet, T22_MINT, 0.05, null, 100_000, true, { send: ctx }).catch((x) => x);
    expect(e).toBeInstanceOf(PreSignRefusal);
    expect((e as Error).message).toMatch(/price moved/);
    expect(ctx.sigs).toEqual([]);
    expect(ctx.onSigned).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(pumpPortalRequests()).toBe(0);
  });

  it('reads the bonding curve on-chain in its own one read at processed: never the warm cache or the pump.fun API', async () => {
    h.cached.mockReturnValue(undefined);
    const r = await pumpfunBuy(wallet, CLASSIC_MINT, 0.05, null, 100_000, true);
    expect(r.tokensOut).toBeGreaterThan(0n);
    expect(h.fetchInfo).not.toHaveBeenCalled();   // no pump.fun API call: one account read gave the reserves and the creator
    expect(h.cached).not.toHaveBeenCalled();      // and no warm cache either: the route decides from its own read
    const read = chain.calls[0];
    expect(read.method).toBe('getMultipleAccounts');
    expect(read.params[0]).toHaveLength(6);
    expect(read.params[1]).toEqual({ encoding: 'base64', commitment: 'processed' });
    // no curve account on-chain: refused (no API fallback inside the route); the router then goes on to Jupiter
    chain.set(PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), pk(CLASSIC_MINT).toBuffer()], pk(PUMP_PROGRAM_ID))[0].toBase58(), null);
    h.fetchInfo.mockResolvedValue({ ...info });
    await expect(pumpfunBuy(wallet, CLASSIC_MINT, 0.05, null, 100_000, true)).rejects.toThrow(/PF-direct refused \(no-curve\)/);
    expect(h.fetchInfo).not.toHaveBeenCalled();
  });
});

// ── A-26 / A-27 ─────────────────────────────────────────────────────────────────────────────────────

/** Every pump route in both directions, runnable against a send context. */
function pumpRoutes(): Array<[string, (send: ReturnType<typeof createSendContext>) => Promise<unknown>]> {
  return [
    ['pf-direct classic buy', (send) => pumpfunBuy(wallet, CLASSIC_MINT, 0.05, null, 100_000, true, { send })],
    ['pf-direct classic sell', (send) => pumpfunSell(wallet, CLASSIC_MINT, 1_000_000n, null, 100_000, true, { send })],
    ['pf-direct Token-2022 buy', (send) => pumpfunBuy(wallet, T22_MINT, 0.05, null, 100_000, true, { send })],
    ['pf-direct Token-2022 sell', (send) => pumpfunSell(wallet, T22_MINT, 5_000_000n, null, 100_000, true, { send })],
    ['PumpSwap buy', (send) => pumpswapBuy(wallet, SWAP_MINT, 0.05, null, 100_000, true, { send, ...RUN_DISABLED })],
    ['PumpSwap sell', (send) => pumpswapSell(wallet, SWAP_MINT, 1_000_000n, null, 100_000, true, { send, ...RUN_DISABLED })],
  ];
}

describe('A-26 send control on the pump routes (real modules, counting sender)', () => {
  it('A26 local builds: onSigned runs after signing and before the send, with the blockhash lastValidBlockHeight, one send each', async () => {
    const events: string[] = [];
    const seen: SignedTx[] = [];
    h.send.mockImplementation(async (tx: VersionedTransaction) => { events.push('send'); return signatureOfSent(tx); });
    const ctx = createSendContext({ onSigned: async (s) => { events.push('onSigned'); seen.push(s); } });

    const buy = await pumpfunBuy(wallet, CLASSIC_MINT, 0.05, null, 100_000, true, { send: ctx });
    expect(events).toEqual(['onSigned', 'send']);
    expect(seen[0]).toEqual({ sig: buy.sig, lastValidBlockHeight: BUILDER_LAST_VALID, route: 'pf-direct' });
    expect(sentTxs().map(sigOf)).toEqual([buy.sig]);

    const sell = await pumpfunSell(wallet, CLASSIC_MINT, 1_000_000n, null, 100_000, true, { send: ctx });
    const pb = await pumpswapBuy(wallet, SWAP_MINT, 0.05, null, 100_000, true, { send: ctx, ...RUN_DISABLED });
    const ps = await pumpswapSell(wallet, SWAP_MINT, 1_000_000n, null, 100_000, true, { send: ctx, ...RUN_DISABLED });
    expect(events).toEqual(['onSigned', 'send', 'onSigned', 'send', 'onSigned', 'send', 'onSigned', 'send']);
    expect(seen.map((s) => s.route)).toEqual(['pf-direct', 'pf-direct', 'pumpswap-direct', 'pumpswap-direct']);
    expect(seen.every((s) => s.lastValidBlockHeight === BUILDER_LAST_VALID)).toBe(true);
    expect(ctx.sigs).toEqual([buy.sig, sell.sig, pb.sig, ps.sig]);
    expect(h.send).toHaveBeenCalledTimes(4);
    // the builder gave a bound every time, so the block height was never read
    expect(h.rpc).not.toHaveBeenCalledWith('getBlockHeight', expect.anything());
  });

  it('A26 Token-2022 local builds: simulated first, then onSigned with the blockhash lastValidBlockHeight, then the send (no PumpPortal round trip)', async () => {
    const order: string[] = [];
    const call = chain.call;
    chain.call = async (method, params) => { if (method === 'simulateTransaction') order.push('simulate'); return call(method, params); };
    const seen: SignedTx[] = [];
    h.send.mockImplementation(async (tx: VersionedTransaction) => { order.push('send'); return signatureOfSent(tx); });
    const ctx = createSendContext({ onSigned: async (s) => { order.push('onSigned'); seen.push(s); } });

    const buy = await pumpfunBuy(wallet, T22_MINT, 0.05, null, 100_000, true, { send: ctx });
    const sell = await pumpfunSell(wallet, T22_MINT, 5_000_000n, null, 100_000, true, { send: ctx });
    expect(order).toEqual(['simulate', 'onSigned', 'send', 'simulate', 'onSigned', 'send']);
    expect(seen.map((s) => s.lastValidBlockHeight)).toEqual([BUILDER_LAST_VALID, BUILDER_LAST_VALID]);
    expect(seen.map((s) => s.route)).toEqual(['pf-direct', 'pf-direct']);
    expect(ctx.sigs).toEqual([buy.sig, sell.sig]);
    expect(h.rpc).not.toHaveBeenCalledWith('getBlockHeight', expect.anything());
    expect(pumpPortalRequests()).toBe(0);
  });

  it('A26 a throw from onSigned aborts the send on every pump route: nothing leaves, nothing is recorded', async () => {
    const boom = new Error('journal disk full');
    for (const [name, run] of pumpRoutes()) {
      const ctx = createSendContext({ onSigned: async () => { throw boom; } });
      const err = await run(ctx).catch((e) => e);
      expect(err, name).toBeInstanceOf(OnSignedAbort);
      expect((err as OnSignedAbort).original, name).toBe(boom);
      expect(ctx.sigs, name).toEqual([]);
    }
    expect(h.send).not.toHaveBeenCalled();
  });

  it('A26 buildOnly builds, verifies and signs on every pump route, but never sends and never calls onSigned', async () => {
    const onSigned = vi.fn(async () => {});
    for (const [name, run] of pumpRoutes()) {
      const ctx = createSendContext({ buildOnly: true, onSigned });
      const r = (await run(ctx)) as { sig: string };
      expect(ctx.builtSig, name).not.toBeNull();
      expect(r.sig, name).toBe(ctx.builtSig);
      expect(ctx.sigs, name).toEqual([]);
    }
    expect(rpcCalls('simulateTransaction')).toBe(4);      // the four pf-direct routes were still verified and simulated
    expect(h.send).not.toHaveBeenCalled();
    expect(onSigned).not.toHaveBeenCalled();
    // a verifier refusal stops a buildOnly call too
    chain.sim.err = { InstructionError: [3, { Custom: 6042 }] };
    await expect(pumpfunBuy(wallet, T22_MINT, 0.05, null, 100_000, true, { send: createSendContext({ buildOnly: true }) })).rejects.toBeInstanceOf(PreSignRefusal);
  });

  it('A26 maxImpactPct refuses a pump route before anything is built, simulated or signed, and lets an under-cap one through', async () => {
    const refused = async (run: () => Promise<unknown>): Promise<ImpactCapError> => {
      const e = await run().catch((x) => x);
      expect(e).toBeInstanceOf(ImpactCapError);
      return e as ImpactCapError;
    };
    // pf-direct buy: 0.05 SOL spends 49 382 715 lamports into the curve after pump's 1.25 % = 0.1644 % of 30 SOL of virtual reserve
    const e1 = await refused(() => pumpfunBuy(wallet, CLASSIC_MINT, 0.05, null, 100_000, true, { send: createSendContext({ maxImpactPct: 0.1 }) }));
    expect(e1.refused[0].route).toBe('pf-direct');
    expect(e1.refused[0].impactPct).toBeCloseTo(0.1644, 4);
    expect(e1.capPct).toBe(0.1);
    // the Token-2022 buy is refused on the same curve quote
    await refused(() => pumpfunBuy(wallet, T22_MINT, 0.05, null, 100_000, true, { send: createSendContext({ maxImpactPct: 0.1 }) }));
    // sell: 300 T of 1073 T virtual tokens = 300 / 1373 = 21.85 %
    const e2 = await refused(() => pumpfunSell(wallet, CLASSIC_MINT, 300_000_000_000_000n, null, 100_000, true, { send: createSendContext({ maxImpactPct: 15 }) }));
    expect(e2.refused[0].impactPct).toBeCloseTo(21.85, 2);
    // PumpSwap: 0.05 SOL into 91 SOL = 0.0544 %, and 25 T of 250 T base = 9.09 %
    await refused(() => pumpswapBuy(wallet, SWAP_MINT, 0.05, null, 100_000, true, { send: createSendContext({ maxImpactPct: 0.05 }), ...RUN_DISABLED }));
    await refused(() => pumpswapSell(wallet, SWAP_MINT, 25_000_000_000_000n, null, 100_000, true, { send: createSendContext({ maxImpactPct: 5 }), ...RUN_DISABLED }));
    expect(rpcCalls('simulateTransaction')).toBe(0);   // nothing was built or simulated
    expect(h.send).not.toHaveBeenCalled();            // nothing was sent

    // under the cap (and exactly at no cap) the same calls go through
    await pumpfunBuy(wallet, CLASSIC_MINT, 0.05, null, 100_000, true, { send: createSendContext({ maxImpactPct: 0.2 }) });
    await pumpfunSell(wallet, CLASSIC_MINT, 300_000_000_000_000n, null, 100_000, true, { send: createSendContext({ maxImpactPct: 25 }) });
    await pumpswapBuy(wallet, SWAP_MINT, 0.05, null, 100_000, true, { send: createSendContext({ maxImpactPct: 0.06 }), ...RUN_DISABLED });
    await pumpswapSell(wallet, SWAP_MINT, 25_000_000_000_000n, null, 100_000, true, { send: createSendContext({ maxImpactPct: 10 }), ...RUN_DISABLED });
    expect(h.send).toHaveBeenCalledTimes(4);
  });

  it('A26 the impact figures agree with the quote math of the same routes (shortfall against the spot price, fee excluded)', async () => {
    const { quoteBuy, quoteSell, curveBuyImpactPct, curveSellImpactPct } = await import('./pumpfun-swap');
    const { quoteBuy: poolBuy, quoteSell: poolSell, poolBuyImpactPct, poolSellImpactPct } = await import('./pumpswap-swap');
    const pct = (num: bigint, den: bigint): number => Number((num * 10_000_000n) / den) / 100_000;   // num / den in percent, 5 decimals
    const vSol = 30_000_000_000n;
    const vTok = 1_073_000_000_000_000n;

    // curve buy (FIX-PUMP: pump's own rule): the spend net of the 95 + 30 bps fees enters the curve; tokens at the spot price = net x vTok / vSol
    const lamportsIn = 2_000_000_000n;
    const net = buyNetLamports(lamportsIn);
    expect(net).toBe(pumpBuyQuote(vSol, vTok, lamportsIn)!.net);
    const out = quoteBuy(Number(vSol), Number(vTok), Number(lamportsIn));
    expect(out).toBe(((net - 1n) * vTok) / (vSol + net - 1n));                 // the quote is the curve at `net`
    const atSpot = (net * vTok) / vSol;
    expect(curveBuyImpactPct(Number(vSol), Number(lamportsIn))!).toBeCloseTo(100 - pct(out, atSpot), 3);

    // curve sell: SOL out before the fees, against tokensIn at the spot price
    const tokensIn = 90_000_000_000_000n;
    const q = pumpSellQuote(vSol, vTok, tokensIn)!;
    expect(quoteSell(Number(vSol), Number(vTok), tokensIn)).toBe(q.net);
    const atSpotSol = (tokensIn * vSol) / vTok;
    expect(curveSellImpactPct(Number(vTok), tokensIn)!).toBeCloseTo(100 - pct(q.gross, atSpotSol), 2);

    // pool: the same shapes with the 0.95 % LP fee on the buy input and on the sell output
    const base = 250_000_000_000_000n;
    const quote = 91_000_000_000n;
    const poolIn = 1_000_000_000n;
    const poolUsable = (poolIn * 9905n) / 10_000n;
    const poolOut = poolBuy(base, quote, poolIn);
    expect(poolOut).toBe(base - (base * quote) / (quote + poolUsable));
    expect(poolBuyImpactPct(quote, poolIn)!).toBeCloseTo(100 - pct(poolOut, (poolUsable * base) / quote), 3);
    const poolTokens = 25_000_000_000_000n;
    const poolGross = (poolSell(base, quote, poolTokens) * 10_000n) / 9905n;
    expect(poolSellImpactPct(base, poolTokens)!).toBeCloseTo(100 - pct(poolGross, (poolTokens * quote) / base), 2);
  });

  it('A27 the PF-direct priority price is the estimate clamped to PRIORITY_FEE_CEILING_MICROLAMPORTS on both sides (the verifier pins it), the caller fee when the estimate fails', async () => {
    const ceiling = BigInt(CONFIG.PRIORITY_FEE_CEILING_MICROLAMPORTS);
    h.prio.mockResolvedValue(Number(ceiling) * 3);                 // a spiking estimate
    await pumpfunBuy(wallet, T22_MINT, 0.05, null, 100_000, true);
    await pumpfunSell(wallet, T22_MINT, 5_000_000n, null, 100_000, true);
    expect(sentTxs().map(priceOf)).toEqual([ceiling, ceiling]);   // the most it signs: ceiling x 200 000 / 1e6 lamports
    h.prio.mockResolvedValue(250_000);
    await pumpfunBuy(wallet, CLASSIC_MINT, 0.05, null, 100_000, true);
    expect(priceOf(sentTxs()[2])).toBe(250_000n);
    // the estimate failing: the caller's fee is used, clamped the same way
    h.prio.mockRejectedValue(new Error('estimator down'));
    await pumpfunSell(wallet, CLASSIC_MINT, 1_000_000n, null, 7_000_000, true);
    expect(priceOf(sentTxs()[3])).toBe(ceiling);
    // the verifier pins price <= ceiling statically (tx-verify.test.ts PDV-T05: ceiling + 1 is refused before any simulation)
    expect(h.send).toHaveBeenCalledTimes(4);
  });

  it('FIXAB-T07 the buy and the sell turn the same micro-lamports/CU estimate into the same signed price; the inert PumpPortal conversion keeps its pinned values', async () => {
    // the shared PumpPortal conversion stays exported (WTX-T15) with its values, and no code path uses it
    expect(pumpPortalPrioritySol(50_000)).toBe(0.0001);          // 0.00001 SOL, raised to the floor
    expect(pumpPortalPrioritySol(5_000_000)).toBe(0.001);
    expect(pumpPortalPrioritySol(100_000_000)).toBe(0.005);      // 0.02 SOL, capped
    expect(pumpPortalPrioritySol(Number.NaN)).toBe(0.0001);
    for (const estimate of [50_000, 1_234_567, 5_000_000]) {
      h.send.mockClear();
      h.prio.mockResolvedValue(estimate);
      await pumpfunBuy(wallet, T22_MINT, 0.05, null, 100_000, true);
      await pumpfunSell(wallet, T22_MINT, 5_000_000n, null, 100_000, true);
      expect(sentTxs().map(priceOf), String(estimate)).toEqual([BigInt(estimate), BigInt(estimate)]);
    }
    expect(pumpPortalRequests()).toBe(0);
  });
});

describe('A-26 through the router (real router and pump routes, stubbed Jupiter route behind the same gate)', () => {
  // FIX-PUMP: pf-direct is on again, so a pre-graduation curve is traded by pf-direct first; PumpSwap-direct stays off (A-93g). The
  // Jupiter stub retries a failed attempt the way executeWithRetry does (see jupiterStub).
  it('A26 without singleSend a failed send is tried again (the next route), and the result lists every signature that was sent', async () => {
    h.exec.mockImplementation(jupiterStub({ attempts: 2 }));
    h.send.mockImplementationOnce(async () => { throw new Error('sender: tx reverted on-chain: {"InstructionError":[2,{"Custom":6003}]}'); });
    const r = await smartSell(wallet, CLASSIC_MINT, 1_000_000n);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(r.route).toBe('jupiter');
    expect(r.sent).toBe(true);
    expect(r.sigs).toHaveLength(2);
    expect(r.sigs![1]).toBe(r.sig);
    expect(r.sigs![0]).toBe(sigOf(sentTxs()[0]));       // the pf-direct sell that was sent and failed
    expect(r.solOutQuoted).toBe(1234n);
  });

  it('A26 singleSend: after one send there is no retry and no route fallback, and the error is a RouterSendError with the signature', async () => {
    h.exec.mockImplementation(jupiterStub({ attempts: 3 }));   // would try again, but never after a send under singleSend
    h.send.mockImplementation(async () => { throw new Error('sender: tx reverted on-chain: {"InstructionError":[2,{"Custom":6003}]}'); });
    const seen: SignedTx[] = [];
    const err = await smartSell(wallet, CLASSIC_MINT, 1_000_000n, { singleSend: true, onSigned: async (s) => { seen.push(s); } }).catch((e) => e);
    expect(err).toBeInstanceOf(RouterSendError);
    expect((err as RouterSendError).sigs).toEqual(seen.map((s) => s.sig));
    expect((err as RouterSendError).sigs).toHaveLength(1);
    expect((err as RouterSendError).sigs[0]).toBe(sigOf(sentTxs()[0]));
    expect((err as Error).message).toMatch(/reverted on-chain/);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(seen.map((s) => s.route)).toEqual(['pf-direct']);   // FIX-PUMP: the one send of a pre-graduation token is pf-direct's

    // the same holds for a graduated token (PumpSwap refuses before it builds anything, Jupiter sends once) and for buys of both coin kinds
    for (const run of [
      () => smartSell(wallet, SWAP_MINT, 1_000_000n, { singleSend: true }),
      () => smartBuy(wallet, CLASSIC_MINT, 0.05, { singleSend: true }),
      () => smartBuy(wallet, T22_MINT, 0.05, { singleSend: true }),
    ]) {
      h.send.mockClear();
      expect(await run().catch((e) => e)).toBeInstanceOf(RouterSendError);
      expect(h.send).toHaveBeenCalledTimes(1);
    }
    expect(h.exec).toHaveBeenCalledTimes(1);   // only the graduated token reached Jupiter
  });

  it('A26 singleSend still lets the next route run when the first ones failed BEFORE they sent (a pf-direct simulation refusal, PumpSwap-direct off)', async () => {
    // Token-2022 pump coin: the pf-direct simulation fails (price moved) before signing, PumpSwap refuses before any RPC call, Jupiter sends once
    chain.sim.err = { InstructionError: [3, { Custom: 6042 }] };
    const seen: SignedTx[] = [];
    const r = await smartBuy(wallet, T22_MINT, 0.05, { singleSend: true, onSigned: async (s) => { seen.push(s); } });
    expect(r.route).toBe('jupiter');
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ sig: r.sig, lastValidBlockHeight: JUPITER_LAST_VALID, route: 'jupiter' }]);
    expect(r.sigs).toEqual([r.sig]);
    expect(rpcCalls('simulateTransaction')).toBe(1);
    expect(pumpPortalRequests()).toBe(0);
  });

  it('A26 a throw from onSigned stops the call: no later route, the callback error comes back unchanged, and a RouterSendError if something was already sent', async () => {
    const boom = new Error('pending-buy write failed');
    const e1 = await smartBuy(wallet, CLASSIC_MINT, 0.05, { onSigned: async () => { throw boom; } }).catch((e) => e);
    expect(e1).toBe(boom);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.exec).not.toHaveBeenCalled();     // FIX-PUMP: pf-direct signed first; its onSigned threw, nothing ran after it

    // the pf-direct sell sends and reverts, the Jupiter attempt signs and its onSigned throws: nothing more is sent, the first signature is reported
    h.exec.mockImplementation(jupiterStub({ attempts: 3 }));
    h.send.mockImplementationOnce(async () => { throw new Error('sender: tx reverted on-chain'); });
    const onSigned = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(boom);
    const e2 = await smartSell(wallet, CLASSIC_MINT, 1_000_000n, { onSigned }).catch((e) => e);
    expect(e2).toBeInstanceOf(RouterSendError);
    expect((e2 as RouterSendError).sigs).toEqual([sigOf(sentTxs()[0])]);
    expect((e2 as Error).message).toContain('onSigned failed');
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(onSigned).toHaveBeenCalledTimes(2);
  });

  it('A26 buildOnly through the router: sent false, the would-be signature, no send, no onSigned, no fill read', async () => {
    const onSigned = vi.fn(async () => {});
    const fillReader = { buyFill: vi.fn(), sellFill: vi.fn() };
    for (const [mint, route] of [[CLASSIC_MINT, 'pf-direct'], [T22_MINT, 'pf-direct'], [SWAP_MINT, 'jupiter']] as const) {
      const r = await smartBuy(wallet, mint, 0.05, { buildOnly: true, onSigned, awaitFill: true, fillReader });
      // FIX-PUMP: the curve coins are built (verified, simulated, signed) by pf-direct; the graduated one by Jupiter (PumpSwap-direct is off)
      expect(r.route, mint).toBe(route);
      expect(r.sent).toBe(false);
      expect(r.sigs).toBeUndefined();
      expect(r.fill).toBeUndefined();
      expect(bs58.decode(r.sig)).toHaveLength(64);
      expect(r.tokensOutQuoted).toBeGreaterThan(0n);
      const s = await smartSell(wallet, mint, 1_000_000n, { buildOnly: true, onSigned });
      expect(s.route, mint).toBe(route);
      expect(s.sent).toBe(false);
      expect(s.solOutQuoted).toBeGreaterThan(0n);
    }
    expect(h.send).not.toHaveBeenCalled();
    expect(onSigned).not.toHaveBeenCalled();
    expect(fillReader.buyFill).not.toHaveBeenCalled();
    expect(h.exec).toHaveBeenCalledTimes(2);                  // the graduated token's buy and sell
    expect(rpcCalls('simulateTransaction')).toBe(4);          // the curve coins' buy and sell
    expect(pumpPortalRequests()).toBe(0);
  });

  it('A26 maxImpactPct: every route that quoted is measured; when all of them are over the cap the call fails with ImpactCapError and nothing is sent', async () => {
    // pf-direct measures 0.1644 % (over a 0.1 % cap) and is refused before building; Jupiter measures 0.01 % and sends
    const r = await smartBuy(wallet, CLASSIC_MINT, 0.05, { maxImpactPct: 0.1 });
    expect(r.route).toBe('jupiter');
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(rpcCalls('simulateTransaction')).toBe(0);    // pf-direct built nothing

    // both routes over the cap: the refusal names both, in order, and nothing is sent
    h.send.mockClear();
    h.exec.mockImplementation(jupiterStub({ impactPct: 0.5 }));
    const err = await smartBuy(wallet, CLASSIC_MINT, 0.05, { maxImpactPct: 0.1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ImpactCapError);
    expect((err as ImpactCapError).refused).toEqual([{ route: 'pf-direct', impactPct: 0.1644 }, { route: 'jupiter', impactPct: 0.5 }]);
    expect((err as ImpactCapError).capPct).toBe(0.1);
    expect(h.send).not.toHaveBeenCalled();

    // under the cap pf-direct trades: no Jupiter call
    h.exec.mockClear();
    const ok = await smartBuy(wallet, CLASSIC_MINT, 0.05, { maxImpactPct: 0.2 });
    expect(ok.route).toBe('pf-direct');
    expect(h.exec).not.toHaveBeenCalled();

    // a route that passed the cap and then failed for another reason is reported as that failure, not as an impact refusal
    h.send.mockClear();
    chain.sim.err = { InstructionError: [3, { Custom: 6042 }] };
    h.exec.mockImplementation(jupiterStub({ impactPct: 0.5 }));
    const err3 = await smartBuy(wallet, CLASSIC_MINT, 0.05, { maxImpactPct: 0.2 }).catch((e) => e);
    expect(err3).not.toBeInstanceOf(ImpactCapError);
    expect((err3 as Error).message).toMatch(/price moved/);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('A26 an unusable maxImpactPct rejects the call before anything happens', async () => {
    await expect(smartBuy(wallet, CLASSIC_MINT, 0.05, { maxImpactPct: Number.NaN })).rejects.toThrow(RangeError);
    await expect(smartSell(wallet, CLASSIC_MINT, 1n, { maxImpactPct: -1 })).rejects.toThrow(RangeError);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.cached).not.toHaveBeenCalled();
  });
});

// ── FIX-PUMP: PF-direct is on (local builder only); FIX-BUY2 item 5's ids are kept for the route's new contract ───────────────────

describe('FIX-PUMP: PF-direct is on with the local builder (real modules, counting sender)', () => {
  it('FIXBUY2-I5-T01 (amended by FIX-PUMP) pf-direct is enabled: buy and sell of a Token-2022 and a classic-Token coin make one read, one simulation, one send, and zero PumpPortal requests', async () => {
    expect(PF_DIRECT_ENABLED).toBe(true);
    for (const mint of [CLASSIC_MINT, T22_MINT]) {
      chain.calls.length = 0;
      h.send.mockClear();
      const onSigned = vi.fn(async () => {});
      const ctx = createSendContext({ onSigned, maxImpactPct: 50 });
      await pumpfunBuy(wallet, mint, 0.05, null, 100_000, true, { send: ctx });
      await pumpfunSell(wallet, mint, 5_000_000n, null, 100_000, true, { send: ctx });
      expect(rpcCalls('getMultipleAccounts'), mint).toBe(4);    // per trade: the build read and the verifier's pre-state read
      expect(rpcCalls('simulateTransaction'), mint).toBe(2);
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(ctx.passed).toEqual(['pf-direct', 'pf-direct']);
      expect(onSigned).toHaveBeenCalledTimes(2);
    }
    expect(h.fetch).not.toHaveBeenCalled();        // no PumpPortal request, no token-program probe, no cashback read
    expect(h.fetchInfo).not.toHaveBeenCalled();    // no pump.fun API
    expect(h.cached).not.toHaveBeenCalled();       // the route's own chain read decides, not the cache
    expect(pumpPortalRequests()).toBe(0);
  });

  it('FIXBUY2-I5-T02 (amended by FIX-PUMP) through the real router a pre-graduation Token-2022 mint and a classic-Token mint, buy and sell, trade on pf-direct in one call; PumpPortal is never asked', async () => {
    const onSigned = vi.fn(async (_s: SignedTx) => {});
    for (const mint of [T22_MINT, CLASSIC_MINT]) {   // both are live curves in the warm cache (the router's own read)
      h.exec.mockClear();
      h.send.mockClear();
      onSigned.mockClear();
      const b = await smartBuy(wallet, mint, 0.05, { onSigned, singleSend: true, maxImpactPct: 15 });
      const s = await smartSell(wallet, mint, 5_000_000n, { onSigned, singleSend: true, maxImpactPct: 15 });
      for (const r of [b, s]) {
        expect(r.route, mint).toBe('pf-direct');
        expect(r.sent).toBe(true);
        expect(r.sigs).toEqual([r.sig]);
      }
      expect(b.tokensOutQuoted).toBeGreaterThan(0n);
      expect(s.solOutQuoted).toBeGreaterThan(0n);
      expect(h.exec).not.toHaveBeenCalled();
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(onSigned.mock.calls.map((c) => c[0].route)).toEqual(['pf-direct', 'pf-direct']);
    }
    expect(h.fetch).not.toHaveBeenCalled();      // no PumpPortal request, not even the probe that tells Token-2022 from classic Token
    expect(pumpPortalRequests()).toBe(0);
    // the router never opts in to a disabled direct route (FIXAB-T06 pins every other source file)
    expect(fs.readFileSync(path.resolve(__dirname, 'router.ts'), 'utf8')).not.toMatch(/testOnlyRunDisabledRoute/);
    // and no PF-direct source names the PumpPortal trade-local endpoint any more
    expect(fs.readFileSync(path.resolve(__dirname, 'pumpfun-swap.ts'), 'utf8')).not.toMatch(/pumpPortalTradeLocalUrl|trade-local/);
  });

  it('FIXBUY2-I5-T03 (amended by FIX-PUMP) a refused pf-direct route is never what the caller reads when Jupiter answers: a USDC-quoted curve and a failed simulation go to Jupiter in the same call, with nothing sent by pf-direct', async () => {
    addPumpWorld(chain, { mint: T22_MINT, owner: OWNER, creator: key(3), program: 'token2022', curve: { quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, held: HELD, uva: true });
    const a = await smartBuy(wallet, T22_MINT, 0.05, { singleSend: true });
    expect(a.route).toBe('jupiter');
    expect(rpcCalls('simulateTransaction')).toBe(0);           // refused from the build read (FIX-BUY2 item 6: non-SOL quote)
    chain.sim.err = { InstructionError: [2, { Custom: 6003 }] };
    const b = await smartSell(wallet, CLASSIC_MINT, 5_000_000n, { singleSend: true });
    expect(b.route).toBe('jupiter');
    expect(h.send).toHaveBeenCalledTimes(2);                   // the two Jupiter sends, nothing from pf-direct
    // Jupiter failing too: the caller reads Jupiter's own error
    const jupErr = new Error('Jupiter /build failed: 503 after retries');
    h.exec.mockRejectedValue(jupErr);
    expect(await smartSell(wallet, CLASSIC_MINT, 5_000_000n).catch((e) => e)).toBe(jupErr);
    expect(pumpPortalRequests()).toBe(0);
  });

  it('FIXPUMP-S-T03 two layout rejections in a row open the breaker: pf-direct then refuses on its first line (no read) and the router goes straight to Jupiter; a passing simulation resets the count', async () => {
    chain.sim.err = { InstructionError: [3, { Custom: 6057 }] };
    await expect(pumpfunBuy(wallet, T22_MINT, 0.05, null, 100_000, true)).rejects.toBeInstanceOf(PreSignRefusal);
    expect(pfDirectBreakerOpen()).toBe(false);
    // a passing simulation in between resets the count
    chain.sim.err = undefined;
    await pumpfunBuy(wallet, T22_MINT, 0.05, null, 100_000, true);
    chain.sim.err = { InstructionError: [3, { Custom: 6057 }] };
    await expect(pumpfunBuy(wallet, T22_MINT, 0.05, null, 100_000, true)).rejects.toBeInstanceOf(PreSignRefusal);
    expect(pfDirectBreakerOpen()).toBe(false);
    await expect(pumpfunBuy(wallet, T22_MINT, 0.05, null, 100_000, true)).rejects.toBeInstanceOf(PreSignRefusal);
    expect(pfDirectBreakerOpen()).toBe(true);
    const calls = chain.calls.length;
    const e = await pumpfunSell(wallet, T22_MINT, 5_000_000n, null, 100_000, true).catch((x) => x);
    expect(e).toBeInstanceOf(PfDirectDisabledError);
    expect((e as Error).message).toMatch(/breaker is open/);
    expect(chain.calls.length).toBe(calls);                    // refused before any read
    const r = await smartBuy(wallet, T22_MINT, 0.05, { singleSend: true });
    expect(r.route).toBe('jupiter');
    expect(chain.calls.length).toBe(calls);
    // 10 minutes later it is closed again
    expect(pfDirectBreakerOpen(Date.now() + 10 * 60_000 + 1)).toBe(false);
    // two errors more than 10 minutes apart do not open it
    resetPfDirectBreakerForTests();
    notePfDirectLayoutRejected(6057, 1_000);
    notePfDirectLayoutRejected(6057, 1_000 + 10 * 60_000 + 1);
    expect(pfDirectBreakerOpen(1_000 + 10 * 60_000 + 2)).toBe(false);
  });
});

// -- R3-B5 (B50 section 2, A-68): the test-override keys in the execution layer ------------------------------------------------------

/** Runs `fn` with these environment values set (and restores them), the way a test harness points the bot at loopback servers. */
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

describe('R3-B5 test-override keys', () => {
  const ONLY = 'http://127.0.0.1:9/rpc-only';
  const LANES = {
    HELIUS_RPC_BOT: 'https://derived-helius-bot.invalid/?api-key=k1', HELIUS_RPC_WALLET: 'https://derived-helius-wallet.invalid/?api-key=k2',
    ALCHEMY_RPC: 'https://derived-alchemy.invalid/v2/k3', HELIUS_RPC: 'https://derived-helius.invalid/?api-key=k4',
  };
  const FORBIDDEN = /derived-|mainnet-beta|chainstack|publicnode|ankr|helius|alchemy/i;

  async function loadRealJupiter(httpCalls: string[]): Promise<typeof import('./jupiter')> {
    vi.resetModules();
    vi.doMock('../lib/http-client', () => ({
      fetch: vi.fn(async (url: string) => { httpCalls.push(String(url)); throw new Error('rpc down'); }),
    }));
    return vi.importActual<typeof import('./jupiter')>('./jupiter');
  }

  it('B5-T05 with RPC_URL set and RPC_FALLBACKS=off a failing RPC is never answered by a public RPC, mainnet-beta or a derived lane', async () => {
    const savedCfg: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(LANES)) { savedCfg[k] = (CONFIG as any)[k]; (CONFIG as any)[k] = v; }
    try {
      // resilientRpcCall (the real one, with a failing HTTP client behind it)
      const httpCalls: string[] = [];
      await withEnv({ RPC_URL: ONLY, RPC_FALLBACKS: 'off', HELIUS_KEY: 'derivedkey', ALCHEMY_API_KEY: 'derivedalchemy' }, async () => {
        const real = await loadRealJupiter(httpCalls);
        await expect(real.resilientRpcCall('getBalance', ['x'])).rejects.toThrow(/All RPCs failed for getBalance/);
      });
      expect(httpCalls).toEqual([ONLY]);                               // one endpoint, one try
      expect(httpCalls.join(' ')).not.toMatch(FORBIDDEN);

      // getTokenProgramForMint (the real one; the probes go through the node-fetch mock)
      h.fetch.mockReset();
      const probes: string[] = [];
      h.fetch.mockImplementation(async (url: string) => { probes.push(String(url)); return { ok: false, status: 500, json: async () => ({}) }; });
      const onlyMint = key(81);
      const smart = await withEnv({ RPC_URL: ONLY, RPC_FALLBACKS: 'off' }, () => getTokenProgramForMint(onlyMint));
      expect(probes).toEqual([ONLY]);
      expect(probes.join(' ')).not.toMatch(FORBIDDEN);
      expect(smart.toBase58()).toBe(TOKEN_PROGRAM_ID);                 // every probe failed: the smart default for a non-pump mint

      // control: with the fallbacks on (the default) the same call walks the derived lanes and ends on mainnet-beta, and RPC_URL is a first lane
      const httpCalls2: string[] = [];
      await withEnv({ RPC_URL: ONLY, RPC_FALLBACKS: undefined, HELIUS_KEY: 'derivedkey', ALCHEMY_API_KEY: 'derivedalchemy' }, async () => {
        const real = await loadRealJupiter(httpCalls2);
        await expect(real.resilientRpcCall('getBalance', ['x'])).rejects.toThrow(/All RPCs failed/);
      });
      expect(httpCalls2[0]).toBe(ONLY);
      expect(httpCalls2.join(' ')).toMatch(/mainnet-beta/);
      expect(httpCalls2.length).toBeGreaterThan(3);
      probes.length = 0;
      await withEnv({ RPC_URL: ONLY, RPC_FALLBACKS: 'on' }, () => getTokenProgramForMint(key(82)));
      expect(probes.join(' ')).toMatch(/derived-helius-bot/);
      expect(probes.at(-1)).toBe('https://api.mainnet-beta.solana.com');
    } finally {
      for (const [k, v] of Object.entries(savedCfg)) (CONFIG as any)[k] = v;
      vi.doUnmock('../lib/http-client');
      vi.resetModules();
    }
  });

  it('PUMPPORTAL_BASE (still a config key) is never reached by PF-direct: buy and sell, Token-2022 and classic Token, with the base set or unset', async () => {
    const urls: string[] = [];
    h.fetch.mockImplementation(async (url: string) => { urls.push(String(url)); throw new Error('no network in this test'); });
    for (const base of ['http://127.0.0.1:7004/', undefined]) {
      await withEnv({ PUMPPORTAL_BASE: base }, async () => {
        for (const mint of [T22_MINT, CLASSIC_MINT]) {
          await pumpfunBuy(wallet, mint, 0.05, null, 100_000, true);
          await pumpfunSell(wallet, mint, 5_000_000n, null, 100_000, true);
        }
      });
    }
    expect(urls).toEqual([]);
    expect(h.send).toHaveBeenCalledTimes(8);
  });
});
