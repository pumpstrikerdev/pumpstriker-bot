/**
 * B40 routers: smartBuy / smartSell keep every existing RouterResult field, add the quotes under their honest
 * names, and book NO fill from a quote. The swap modules, Jupiter and the curve reader are mocked: nothing touches a
 * network, a wallet or an RPC. Signatures are generated at runtime (A-20).
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import bs58 from 'bs58';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuyFill, FillReader, SellFill } from '../bot-contracts';

const h = vi.hoisted(() => ({
  pumpfunBuy: vi.fn(),
  pumpfunSell: vi.fn(),
  pumpswapBuy: vi.fn(),
  pumpswapSell: vi.fn(),
  executeWithRetry: vi.fn(),
  getCachedPumpFunInfo: vi.fn(),
  fetchPumpFunInfo: vi.fn(),
  readCurveView: vi.fn(),
  nodeFetch: vi.fn(),
  // FIX-PUMP: the real pf-direct route's RPC pool, blockhash, priority estimate and senders (only the FIX-PUMP block points them anywhere)
  rpc: vi.fn(),
  blockhash: vi.fn(),
  prio: vi.fn(),
  sender: vi.fn(),
}));
/** FIX-BUY2: the real pumpfun-swap module; the router calls the spies above, and the item 5 tests point them at the real functions. */
const realPf = vi.hoisted(() => ({ mod: null as null | typeof import('./pumpfun-swap') }));
vi.mock('./pumpfun-swap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pumpfun-swap')>();
  realPf.mod = actual;
  return { ...actual, pumpfunBuy: h.pumpfunBuy, pumpfunSell: h.pumpfunSell };
});
vi.mock('./pumpswap-swap', () => ({ pumpswapBuy: h.pumpswapBuy, pumpswapSell: h.pumpswapSell }));
vi.mock('./jupiter', () => ({
  executeWithRetry: h.executeWithRetry, lamports: (sol: number) => Math.round(sol * 1e9),
  resilientRpcCall: h.rpc, getResilientBlockhash: h.blockhash, getPriorityFeeForSwap: h.prio, heliusSmartSend: h.sender, multiRpcSend: h.sender,
  HELIUS_TIP_LAMPORTS: 200_000,
}));
vi.mock('./pumpfun-info', () => ({ getCachedPumpFunInfo: h.getCachedPumpFunInfo, fetchPumpFunInfo: h.fetchPumpFunInfo }));
vi.mock('./curve-state', () => ({ readCurveView: h.readCurveView }));
vi.mock('node-fetch', () => ({ default: h.nodeFetch }));   // PumpPortal trade-local and the mint-owner probes of the real pumpfun-swap

import { smartBuy, smartSell } from './router';
import { dispatchSigned, enforceImpactCap, ImpactCapError, PreSignRefusal, RouterSendError, type SendContext, type SignedTx } from './send-context';
import { addPumpWorld, createPumpDirectChain, type PumpDirectChain } from './pump-direct-testkit';

const keypair = Keypair.fromSeed(new Uint8Array(32).fill(1));
const PLAIN_MINT = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();   // not a 'pump' vanity mint
const PUMP_MINT = `${PLAIN_MINT.slice(0, PLAIN_MINT.length - 4)}pump`;
const newSig = (): string => bs58.encode(randomBytes(64));
const SRC = path.resolve(__dirname);

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.readCurveView.mockResolvedValue(null);
  h.fetchPumpFunInfo.mockResolvedValue({ hasData: false });
  h.getCachedPumpFunInfo.mockReturnValue(undefined);
});

/** Every file in which a fill could be (wrongly) built from a quote. */
function sourceOf(file: string): string { return fs.readFileSync(path.join(SRC, file), 'utf8'); }

describe('routers', () => {
  it('B4-T05 routers return the quote and the tx with additive *Quoted fields, unchanged RouterResult fields, and book no fill from a quote', async () => {
    // ── pf-direct buy ──
    const sigA = newSig();
    h.getCachedPumpFunInfo.mockReturnValue({ hasData: true, complete: false });
    h.pumpfunBuy.mockResolvedValue({ sig: sigA, tokensOut: 5_000_000n, tokensOutQuoted: 5_000_000n, slippageBpsUsed: 150 });
    const b1 = await smartBuy(keypair, PUMP_MINT, 0.05, { slippageBps: 150 });
    expect(b1).toEqual({ sig: sigA, route: 'pf-direct', tokensOut: 5_000_000n, tokensOutQuoted: 5_000_000n, slippageBpsUsed: 150, sent: true });
    expect(b1.fill).toBeUndefined();   // no fill without awaitFill: a quote is never promoted to a fill

    // ── pumpswap-direct buy (graduated) ──
    const sigB = newSig();
    h.getCachedPumpFunInfo.mockReturnValue({ hasData: true, complete: true });
    h.pumpswapBuy.mockResolvedValue({ sig: sigB, tokensOut: 9_000n, slippageBpsUsed: 150 });   // a module that has not been updated: the router fills the alias
    const b2 = await smartBuy(keypair, PUMP_MINT, 0.05);
    expect(b2).toEqual({ sig: sigB, route: 'pumpswap-direct', tokensOut: 9_000n, tokensOutQuoted: 9_000n, slippageBpsUsed: 150, sent: true });

    // ── jupiter buy (no pump.fun data, not a pump mint) ──
    const sigC = newSig();
    h.getCachedPumpFunInfo.mockReturnValue(undefined);
    h.executeWithRetry.mockResolvedValue({ sig: sigC, quote: { outAmount: '777' } });
    const b3 = await smartBuy(keypair, PLAIN_MINT, 0.05, { slippageBps: 400 });
    expect(b3).toEqual({ sig: sigC, route: 'jupiter', tokensOut: 777n, tokensOutQuoted: 777n, slippageBpsUsed: 400, sent: true });

    // ── sells: solOut stays, solOutQuoted is added ──
    const sigD = newSig();
    h.getCachedPumpFunInfo.mockReturnValue({ hasData: true, complete: false });
    h.pumpfunSell.mockResolvedValue({ sig: sigD, solOut: 88_000_000n, solOutQuoted: 88_000_000n, slippageBpsUsed: 200 });
    expect(await smartSell(keypair, PUMP_MINT, 123n)).toEqual({ sig: sigD, route: 'pf-direct', solOut: 88_000_000n, solOutQuoted: 88_000_000n, slippageBpsUsed: 200, sent: true });
    const sigE = newSig();
    h.getCachedPumpFunInfo.mockReturnValue(undefined);
    h.executeWithRetry.mockResolvedValue({ sig: sigE, quote: { outAmount: '4242' } });
    expect(await smartSell(keypair, PLAIN_MINT, 5n)).toEqual({ sig: sigE, route: 'jupiter', solOut: 4242n, solOutQuoted: 4242n, slippageBpsUsed: 300, sent: true });

    // ── the real fill only ever comes from the FillReader, and only on request ──
    const owner = keypair.publicKey.toBase58();
    const realBuy: BuyFill = { solSpentLamports: '52245280', tokensRaw: '4999000', feeLamports: '6000', confirmedAt: 1_760_000_000_000 };
    const realSell: SellFill = { solOutNetLamports: '79785000', solOutGrossLamports: '79800000', tokensSoldRaw: '123', feeLamports: '15000', confirmedAt: 1_760_000_000_000 };
    const reader: FillReader = {
      buyFill: vi.fn(async () => realBuy),
      sellFill: vi.fn(async () => realSell),
    };
    h.getCachedPumpFunInfo.mockReturnValue({ hasData: true, complete: false });
    h.pumpfunBuy.mockResolvedValue({ sig: sigA, tokensOut: 5_000_000n, slippageBpsUsed: 150 });
    const f1 = await smartBuy(keypair, PUMP_MINT, 0.05, { awaitFill: true, fillReader: reader });
    expect(reader.buyFill).toHaveBeenCalledWith(sigA, owner, PUMP_MINT);
    expect(f1.fill).toBe(realBuy);                 // exactly what the reader returned
    expect(f1.tokensOut).toBe(5_000_000n);         // the quote is still the quote ...
    expect(f1.tokensOutQuoted).toBe(5_000_000n);
    expect(f1.fill).not.toMatchObject({ tokensRaw: '5000000' });   // ... and was not booked as the fill
    h.pumpfunSell.mockResolvedValue({ sig: sigD, solOut: 88_000_000n, slippageBpsUsed: 200 });
    const f2 = await smartSell(keypair, PUMP_MINT, 123n, { awaitFill: true, fillReader: reader });
    expect(reader.sellFill).toHaveBeenCalledWith(sigD, owner, PUMP_MINT);
    expect(f2.fill).toBe(realSell);
    expect(f2.solOutQuoted).toBe(88_000_000n);
    // an unreadable meta stays 'unverified' (quoted, unverified); it is not replaced by the quote
    const blind: FillReader = { buyFill: async () => 'unverified', sellFill: async () => { throw new Error('rpc down'); } };
    expect((await smartBuy(keypair, PUMP_MINT, 0.05, { awaitFill: true, fillReader: blind })).fill).toBe('unverified');
    expect((await smartSell(keypair, PUMP_MINT, 123n, { awaitFill: true, fillReader: blind })).fill).toBe('unverified');

    // ── static: no router / swap module builds a BuyFill or SellFill (only fills.ts does) ──
    const fillFields = /solSpentLamports|tokensRaw|solOutNetLamports|solOutGrossLamports|tokensSoldRaw|confirmedAt/;
    for (const f of ['router.ts', 'jupiter.ts', 'pumpswap-swap.ts', 'pumpfun-swap.ts']) {
      expect(sourceOf(f), `${f} must not construct a fill`).not.toMatch(fillFields);
    }
    const routerSrc = sourceOf('router.ts');
    const fillAssignments = routerSrc.match(/\bfill\s*[:=][^=]/g) ?? [];
    expect(fillAssignments.length).toBe(2);                                       // only the two `out.fill = await readFill(...)` lines ...
    expect(routerSrc.match(/\.fill\s*=\s*await readFill\(/g)?.length).toBe(2);   // ... buy and sell, both through the FillReader
    for (const f of ['jupiter.ts', 'pumpswap-swap.ts', 'pumpfun-swap.ts']) {
      expect(sourceOf(f), `${f} must not assign a fill`).not.toMatch(/\bfill\s*[:=][^=]/);
    }
  });

  it('reads the curve on-chain before the pump.fun API, and only falls back to the API when the chain read gives nothing (FIX-PUMP: never for a pump mint)', async () => {
    const sig = newSig();
    h.pumpfunBuy.mockResolvedValue({ sig, tokensOut: 1n, slippageBpsUsed: 100 });
    h.readCurveView.mockResolvedValue({ hasData: true, complete: false });
    const r = await smartBuy(keypair, PUMP_MINT, 0.05);
    expect(r.route).toBe('pf-direct');
    expect(h.readCurveView).toHaveBeenCalledWith(PUMP_MINT);
    expect(h.fetchPumpFunInfo).not.toHaveBeenCalled();   // no pump.fun API on the buy path

    // FIX-PUMP (speed): a 'pump' mint the chain read cannot see yet goes straight to PF-direct, whose own 'processed' read decides
    h.readCurveView.mockResolvedValue(null);
    h.fetchPumpFunInfo.mockResolvedValue({ hasData: true, complete: false });
    expect((await smartBuy(keypair, PUMP_MINT, 0.05)).route).toBe('pf-direct');
    h.pumpfunSell.mockResolvedValue({ sig: newSig(), solOut: 1n, slippageBpsUsed: 100 });
    expect((await smartSell(keypair, PUMP_MINT, 5n)).route).toBe('pf-direct');
    expect(h.fetchPumpFunInfo).not.toHaveBeenCalled();
    // any other mint keeps the API as the fallback of the chain read
    await smartBuy(keypair, PLAIN_MINT, 0.05);
    expect(h.fetchPumpFunInfo).toHaveBeenCalledTimes(1);   // fallback only
  });
});

// ── A-26: how the router passes the options on and reports a failed call (module mocks: the policy, not the routes) ──

const signedDummy = (): VersionedTransaction => {
  const t = new VersionedTransaction(new TransactionMessage({
    payerKey: keypair.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message());
  t.sign([keypair]);
  return t;
};
/** A route mock that sends one dummy transaction through the real gate and then fails with `err` (or succeeds when null). */
const sendThen = (route: 'pf-direct' | 'pumpswap-direct' | 'jupiter', err: Error | null, extra: Record<string, unknown> = {}) =>
  async (...a: any[]): Promise<any> => {
    const ctx: SendContext | undefined = route === 'jupiter' ? a[9] : a[6]?.send;
    const { sig } = await dispatchSigned(ctx, signedDummy(), route, 1, async () => 'sender-answer');
    if (err) throw err;
    return { sig, slippageBpsUsed: 100, ...extra };
  };

describe('router send control (A-26)', () => {
  it('A26 the options reach every route as ONE send context (pump routes: 7th argument; Jupiter: 10th, after awaitConfirm)', async () => {
    const onSigned = vi.fn(async () => {});
    h.getCachedPumpFunInfo.mockReturnValue({ hasData: true, complete: false });
    h.pumpfunBuy.mockResolvedValue({ sig: newSig(), tokensOut: 1n, slippageBpsUsed: 100 });
    await smartBuy(keypair, PUMP_MINT, 0.05, { onSigned, singleSend: true, buildOnly: false, maxImpactPct: 12.5 });
    const c1 = h.pumpfunBuy.mock.calls[0][6].send as SendContext;
    expect(c1).toMatchObject({ onSigned, singleSend: true, buildOnly: false, maxImpactPct: 12.5, sigs: [] });

    h.getCachedPumpFunInfo.mockReturnValue({ hasData: true, complete: true });
    h.pumpswapSell.mockResolvedValue({ sig: newSig(), solOut: 1n, slippageBpsUsed: 100 });
    await smartSell(keypair, PUMP_MINT, 5n, { buildOnly: true });
    const c2 = h.pumpswapSell.mock.calls[0][6].send as SendContext;
    expect(c2).toMatchObject({ onSigned: undefined, singleSend: false, buildOnly: true, maxImpactPct: null });
    expect(c2).not.toBe(c1);                                                   // a context per call

    h.getCachedPumpFunInfo.mockReturnValue(undefined);
    h.executeWithRetry.mockResolvedValue({ sig: newSig(), quote: { outAmount: '1' } });
    await smartBuy(keypair, PLAIN_MINT, 0.05, { singleSend: true });
    await smartSell(keypair, PLAIN_MINT, 5n, { singleSend: true });
    const buyArgs = h.executeWithRetry.mock.calls[0];
    const sellArgs = h.executeWithRetry.mock.calls[1];
    expect(buyArgs[8]).toBe(false);                                            // awaitConfirm: buys do not wait, sells do
    expect(sellArgs[8]).toBe(true);
    expect(buyArgs[9]).toMatchObject({ singleSend: true });
    expect(sellArgs[9]).toMatchObject({ singleSend: true });
  });

  it('A26 every send is recorded on the result (sent true, sigs in order); without a recorded send the result carries no sigs', async () => {
    h.getCachedPumpFunInfo.mockReturnValue({ hasData: true, complete: false });
    h.pumpfunSell.mockImplementation(sendThen('pf-direct', new Error('sender: tx reverted on-chain')));
    h.pumpswapSell.mockImplementation(sendThen('pumpswap-direct', null, { solOut: 9n }));
    const r = await smartSell(keypair, PUMP_MINT, 5n);                          // pump mint: pf-direct fails after a send, PumpSwap second chance sends
    expect(r.route).toBe('pumpswap-direct');
    expect(r.sent).toBe(true);
    expect(r.sigs).toHaveLength(2);
    expect(r.sigs![1]).toBe(r.sig);

    h.pumpfunSell.mockResolvedValue({ sig: newSig(), solOut: 1n, slippageBpsUsed: 100 });   // a route that does not use the gate records nothing
    expect((await smartSell(keypair, PUMP_MINT, 5n)).sigs).toBeUndefined();
  });

  it('A26 after a send the error is a RouterSendError with a redacted message and every signature; the cause message is not lost', async () => {
    const secret = randomBytes(10).toString('hex');
    h.getCachedPumpFunInfo.mockReturnValue(undefined);
    h.executeWithRetry.mockImplementation(async (...a: any[]) => {
      await sendThen('jupiter', null)(...a);
      throw new Error(`confirm timed out via https://rpc.example.invalid/?api-key=${secret}`);
    });
    const err = await smartSell(keypair, PLAIN_MINT, 5n).catch((e) => e);
    expect(err).toBeInstanceOf(RouterSendError);
    expect((err as RouterSendError).sigs).toHaveLength(1);
    expect((err as Error).message).toContain('confirm timed out');
    expect((err as Error).message).not.toContain(secret);
  });

  it('A26 which error the caller gets when nothing was sent and the impact cap refused routes', async () => {
    const quiet = (impact: number | null) => async (...a: any[]) => { enforceImpactCap(a[6]?.send, 'pf-direct', impact); return { sig: newSig(), slippageBpsUsed: 1 }; };
    h.getCachedPumpFunInfo.mockReturnValue({ hasData: true, complete: false });

    // (a) the only route that could quote was refused; the others could not quote at all -> ImpactCapError
    h.pumpfunBuy.mockImplementation(quiet(10));
    h.pumpswapBuy.mockRejectedValue(new Error('PumpSwap: no pool'));
    h.executeWithRetry.mockRejectedValue(new Error('Jupiter quote failed: 429 (all tiers exhausted)'));
    const a = await smartBuy(keypair, PUMP_MINT, 0.05, { maxImpactPct: 5 }).catch((e) => e);
    expect(a).toBeInstanceOf(ImpactCapError);
    expect((a as ImpactCapError).refused).toEqual([{ route: 'pf-direct', impactPct: 10 }]);

    // (b) a route that was UNDER the cap failed for another reason; a later route was refused -> the under-cap failure is reported
    const verifyErr = new Error('tx-verify refused the PumpPortal buy transaction: mint mismatch');
    h.pumpfunBuy.mockImplementation(async (...args: any[]) => { enforceImpactCap(args[6]?.send, 'pf-direct', 2); throw verifyErr; });
    h.executeWithRetry.mockImplementation(async (...args: any[]) => { enforceImpactCap(args[9], 'jupiter', 30); return { sig: newSig(), quote: {} }; });
    const b = await smartBuy(keypair, PUMP_MINT, 0.05, { maxImpactPct: 5 }).catch((e) => e);
    expect(b).toBe(verifyErr);

    // (c) no cap: the last error as the last route threw it, exactly as before A-26
    const jupErr = new Error('Jupiter quote failed: 500');
    h.pumpfunBuy.mockRejectedValue(new Error('PumpFun: no curve data'));
    h.executeWithRetry.mockRejectedValue(jupErr);
    expect(await smartBuy(keypair, PUMP_MINT, 0.05).catch((e) => e)).toBe(jupErr);

    // (d) a cap that nobody refused changes nothing either
    h.pumpfunBuy.mockImplementation(quiet(1));
    const d = await smartBuy(keypair, PUMP_MINT, 0.05, { maxImpactPct: 5 });
    expect(d.route).toBe('pf-direct');
  });
});

// ── FIX-PUMP: the real, enabled pf-direct route (local builder only) behind the router; FIX-BUY2 item 5's ids are kept ─────────────

describe('FIX-PUMP: PF-direct is on (the real route behind the router)', () => {
  /** A live bonding curve as the router's own read sees it (the route reads the chain itself through the scripted pool below). */
  const LIVE_CURVE = {
    hasData: true, complete: false, virtualSolReserves: 30_000_000_000, virtualTokenReserves: 1_073_000_000_000_000,
    bondingCurveProgress: 0.1, creator: Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58(),
  };
  const OWNER = keypair.publicKey.toBase58();
  /** Points the pf-direct spies at the REAL pumpfunBuy / pumpfunSell and the resilient RPC pool at a scripted chain holding both coins. */
  function realPfDirect(): { thrown: unknown[]; chain: PumpDirectChain } {
    const pf = realPf.mod!;
    pf.resetPfDirectBreakerForTests();
    const thrown: unknown[] = [];
    const keep = (fn: (...a: any[]) => Promise<unknown>) => async (...a: any[]) => {
      try { return await fn(...a); } catch (e) { thrown.push(e); throw e; }
    };
    h.pumpfunBuy.mockImplementation(keep(pf.pumpfunBuy));
    h.pumpfunSell.mockImplementation(keep(pf.pumpfunSell));
    h.pumpswapBuy.mockRejectedValue(new Error('PumpSwap direct disabled (A-93g)'));   // what the real PumpSwap route answers today
    h.pumpswapSell.mockRejectedValue(new Error('PumpSwap direct disabled (A-93g)'));
    const chain = createPumpDirectChain();
    addPumpWorld(chain, { mint: PUMP_MINT, owner: OWNER, creator: LIVE_CURVE.creator, program: 'token2022', held: 1_000_000_000n, uva: true });
    addPumpWorld(chain, { mint: PLAIN_MINT, owner: OWNER, creator: LIVE_CURVE.creator, program: 'token', held: 1_000_000_000n, uva: true });
    h.rpc.mockImplementation((method: string, params: any[]) => chain.call(method, params));
    h.blockhash.mockResolvedValue({ blockhash: Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58(), lastValidBlockHeight: 4_242 });
    h.prio.mockResolvedValue(100_000);
    h.sender.mockImplementation(async (tx: VersionedTransaction) => bs58.encode(tx.signatures[0]));
    return { thrown, chain };
  }

  it('FIXBUY2-I5-T04 (amended by FIX-PUMP) a pre-graduation Token-2022 mint and a classic-Token mint, buy and sell, trade on pf-direct in one call: one read, one simulation, one send each, no Jupiter, no PumpPortal', async () => {
    const pf = realPf.mod!;
    expect(pf.PF_DIRECT_ENABLED).toBe(true);
    const { thrown, chain } = realPfDirect();
    h.readCurveView.mockResolvedValue(LIVE_CURVE);   // both mints are live bonding curves (the router's own chain read)
    const onSigned = vi.fn(async (_s: SignedTx) => {});
    for (const mint of [PUMP_MINT, PLAIN_MINT]) {   // a 'pump' vanity coin (Token-2022) and a classic-Token coin
      chain.calls.length = 0;
      h.sender.mockClear();
      const b = await smartBuy(keypair, mint, 0.05, { onSigned, singleSend: true, maxImpactPct: 15 });
      const s = await smartSell(keypair, mint, 5_000_000n, { onSigned, singleSend: true, maxImpactPct: 15 });
      for (const r of [b, s]) {
        expect(r.route, mint).toBe('pf-direct');
        expect(r.sent).toBe(true);
        expect(r.sigs).toEqual([r.sig]);
      }
      expect(b.tokensOutQuoted).toBeGreaterThan(0n);
      expect(s.solOutQuoted).toBeGreaterThan(0n);
      expect(chain.calls.map((c) => c.method)).toEqual(['getMultipleAccounts', 'simulateTransaction', 'getMultipleAccounts', 'getMultipleAccounts', 'simulateTransaction', 'getMultipleAccounts']);
      expect(h.sender).toHaveBeenCalledTimes(2);
    }
    expect(thrown).toEqual([]);
    expect(h.executeWithRetry).not.toHaveBeenCalled();
    expect(onSigned.mock.calls.map((c) => c[0].route)).toEqual(['pf-direct', 'pf-direct', 'pf-direct', 'pf-direct']);
    expect(h.nodeFetch).not.toHaveBeenCalled();                    // no PumpPortal request, no mint-owner probe
    expect(h.fetchPumpFunInfo).not.toHaveBeenCalled();
  });

  it('FIXBUY2-I5-T05 (amended by FIX-PUMP) a refused pf-direct (a USDC-quoted curve, a failed simulation) still reaches Jupiter in the same call, singleSend included, with nothing sent by pf-direct', async () => {
    const pf = realPf.mod!;
    const { thrown, chain } = realPfDirect();
    h.getCachedPumpFunInfo.mockReturnValue(LIVE_CURVE);
    h.executeWithRetry.mockImplementation(async (...a: any[]) => {
      enforceImpactCap(a[9], 'jupiter', 1);
      return sendThen('jupiter', null, { quote: { outAmount: '777' } })(...a);
    });
    // a curve quoted in USDC: refused from the build read (FIX-BUY2 item 6), nothing simulated
    addPumpWorld(chain, { mint: PUMP_MINT, owner: OWNER, creator: LIVE_CURVE.creator, program: 'token2022', curve: { quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, held: 1_000_000_000n, uva: true });
    const a = await smartBuy(keypair, PUMP_MINT, 0.05, { singleSend: true, maxImpactPct: 5 });
    expect(a.route).toBe('jupiter');
    expect(a.sigs).toEqual([a.sig]);
    expect(chain.calls.filter((c) => c.method === 'simulateTransaction')).toHaveLength(0);
    expect((thrown[0] as Error).message).toMatch(/\(non-sol-quote\)/);
    // the simulation fails (the price moved): refused before signing, Jupiter trades in the same call
    chain.sim.err = { InstructionError: [2, { Custom: 6003 }] };
    const b = await smartSell(keypair, PLAIN_MINT, 5_000_000n, { singleSend: true, maxImpactPct: 5 });
    expect(b.route).toBe('jupiter');
    expect(b.sigs).toEqual([b.sig]);
    expect(thrown[1]).toBeInstanceOf(PreSignRefusal);
    expect(h.sender).not.toHaveBeenCalled();                 // pf-direct signed and sent nothing
    // Jupiter under the cap, then failing: the caller reads Jupiter's failure, never the pf-direct refusal
    const jupErr = new Error('Jupiter /build failed: 503 after retries');
    h.executeWithRetry.mockImplementation(async (...args: any[]) => { enforceImpactCap(args[9], 'jupiter', 1); throw jupErr; });
    const e = await smartSell(keypair, PLAIN_MINT, 5_000_000n, { maxImpactPct: 5 }).catch((x) => x);
    expect(e).toBe(jupErr);
    expect(e).not.toBeInstanceOf(pf.PfDirectDisabledError);
  });

  it('FIXBUY2-I5-T06 (amended by FIX-PUMP) dry run (buildOnly): a pre-graduation mint is built, verified, simulated and signed by pf-direct and never sent; onSigned is never called', async () => {
    const { chain } = realPfDirect();
    h.getCachedPumpFunInfo.mockReturnValue(LIVE_CURVE);
    const onSigned = vi.fn(async () => {});
    for (const mint of [PUMP_MINT, PLAIN_MINT]) {
      const b = await smartBuy(keypair, mint, 0.05, { buildOnly: true, onSigned });
      const s = await smartSell(keypair, mint, 5_000_000n, { buildOnly: true, onSigned });
      for (const r of [b, s]) {
        expect(r.route).toBe('pf-direct');
        expect(r.sent).toBe(false);
        expect(r.sigs).toBeUndefined();
        expect(bs58.decode(r.sig)).toHaveLength(64);
      }
    }
    expect(chain.calls.filter((c) => c.method === 'simulateTransaction')).toHaveLength(4);
    expect(h.sender).not.toHaveBeenCalled();
    expect(onSigned).not.toHaveBeenCalled();
    expect(h.executeWithRetry).not.toHaveBeenCalled();
    expect(h.nodeFetch).not.toHaveBeenCalled();
  });
});
