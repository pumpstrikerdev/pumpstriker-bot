/**
 * SMART SWAP ROUTER — picks the optimal execution path per token state.
 *
 * Decision tree:
 *   pf.complete === false  →  PumpFun direct (bonding curve)
 *   pf.complete === true   →  PumpSwap direct (post-grad AMM)
 *   else                   →  Jupiter (catch-all for non-PF ecosystem)
 *
 * Direct paths fall through to Jupiter on revert/error so a token mid-graduation
 * (the ~30-60s window where curve closed but pool not yet indexed) still trades.
 *
 * Reduces "Jupiter 400 both tiers exhausted" failures and the quote-vs-swap drift
 * window that masked stop-losses during the rug.
 *
 * A-26 (send control, every route, every Jupiter retry): onSigned (awaited after signing, before each send; a throw aborts
 * the call), buildOnly (build, verify, sign, never send), singleSend (after one send: no retry, no route fallback) and
 * maxImpactPct (a route over the cap is refused before signing; all routes refused = ImpactCapError). Any error after at
 * least one send is a RouterSendError carrying every signature the call sent. See send-context.ts.
 */
import { Keypair } from '@solana/web3.js';
import { logWarn } from '../logger';
import { redactSecrets } from '../lib/redact';
import { getCachedPumpFunInfo, fetchPumpFunInfo } from './pumpfun-info';
import { pumpfunBuy, pumpfunSell } from './pumpfun-swap';
import { pumpswapBuy, pumpswapSell } from './pumpswap-swap';
import { executeWithRetry, lamports as solToLamports } from './jupiter';
import { CONFIG } from '../config';
import type { FillReader } from '../bot-contracts';
import { readCurveView } from './curve-state';
import { createFillReader, type FillResult } from './fills';
import {
  createSendContext, ImpactCapError, mustStop, noteRouteFailure, OnSignedAbort, PreSignRefusal, RouterSendError,
  type SendContext, type SignedTx, type SwapRoute,
} from './send-context';

// FIX-BUY: PreSignRefusal = the Jupiter Sender route's simulation refused the swap before signing (nothing sent, no fee paid)
export { ImpactCapError, PreSignRefusal, RouterSendError };
export type { SignedTx, SwapRoute };

export interface RouterResult {
  sig: string;
  route: SwapRoute;
  /** The pre-slippage QUOTE of the route (kept for existing callers; it is NOT what the chain filled). */
  tokensOut?: bigint;
  solOut?: bigint;
  slippageBpsUsed: number;
  /** B40: the same quotes under their honest names (additive). A quote is never booked as a fill. */
  tokensOutQuoted?: bigint;
  solOutQuoted?: bigint;
  /** B40: the real fill read from the transaction meta; present only when RouterOpts.awaitFill is set, and 'unverified'
   *  when the meta stayed unreadable (the caller then reports PnL null, 'quoted, unverified'). */
  fill?: FillResult | 'unverified';
  /** A-26: false only for a buildOnly call (the transaction was built, verified and signed, and never sent). */
  sent?: boolean;
  /** A-26: every signature this call sent, in order (more than one when an earlier route or retry also sent). */
  sigs?: string[];
}

export interface RouterOpts {
  slippageBps?: number | null;
  priorityFee?: number;
  antiMev?: boolean;
  /** B40: wait (up to 60 s) for the confirmed transaction meta and return the real fill in RouterResult.fill. Default off. */
  awaitFill?: boolean;
  /** B40: fill reader used when waitFill is set (default: createFillReader() on the resilient RPC pool). */
  fillReader?: FillReader;
  /** A-26: awaited after signing and before each send (every route, every Jupiter retry). A throw aborts the call and
   *  nothing is sent for that transaction. `lastValidBlockHeight` is the builder's value when it returns one, else the
   *  block height at signing + 151 (an upper bound). Never called when buildOnly is set. */
  onSigned?(s: SignedTx): Promise<void>;
  /** A-26: build, verify and sign, never send and never call onSigned; the result says `sent: false`. */
  buildOnly?: boolean;
  /** A-26: after one send there is no retry and no route fallback. */
  singleSend?: boolean;
  /** A-26: a route whose own quote impact (percent) is above this is refused before signing; if every route is
   *  refused the call throws ImpactCapError and nothing is sent. */
  maxImpactPct?: number;
}

/**
 * First line of every route catch block. Records a failure of a route that had passed the impact cap (it is what the
 * caller is told if nothing else works), then stops the whole call (rethrow) when onSigned threw, or when singleSend and a
 * send was already attempted. Anything else lets the caller go on to the next route.
 */
function routeFailed(ctx: SendContext, route: SwapRoute, e: unknown): void {
  noteRouteFailure(ctx, route, e);
  if (mustStop(ctx, e)) throw e;
}

/** Jupiter is the last route: nothing follows it, but its failure is still recorded for finalError. */
async function viaJupiter<T>(ctx: SendContext, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    noteRouteFailure(ctx, 'jupiter', e);
    throw e;
  }
}

/**
 * Smart-routed buy. Returns the route used so the caller can log/display it.
 *
 *   solIn — UI form (e.g. 0.05 = 0.05 SOL)
 */
async function routeBuy(
  keypair: Keypair, mint: string, solIn: number, opts: RouterOpts, ctx: SendContext,
): Promise<RouterResult> {
  const { slippageBps = null, priorityFee = 100_000, antiMev = true } = opts;

  // pump.fun mints almost always end in "pump" — use this as a strong hint
  // when the PF cache is cold. Without this, the very first buy on a
  // freshly-spotted token skips PF-direct and goes straight to Jupiter.
  const isPumpMint   = mint.endsWith('pump');

  // Resolve PF state (may be cached, fresh-fetched, or null)
  // B40 rule 5: warm cache, else ONE on-chain curve read, and the pump.fun API only as the fallback.
  // FIX-PUMP (speed): a 'pump' mint never waits for the pump.fun API: PF-direct runs next anyway and its own 'processed' read decides
  // (a coin a few seconds old is not yet visible to the 'confirmed' read above). Other mints keep the API fallback.
  let pf: any = getCachedPumpFunInfo(mint);
  if (!pf || !pf.hasData) pf = await readCurveView(mint);
  if ((!pf || !pf.hasData) && !isPumpMint) pf = await fetchPumpFunInfo(mint).catch(() => null) as any;
  let   knownGrad    = !!(pf?.hasData && pf.complete);
  let   knownPreGrad = !!(pf?.hasData && !pf.complete);

  // ── PumpSwap first when we KNOW the token has graduated ──
  if (knownGrad) {
    try {
      const r = await pumpswapBuy(keypair, mint, solIn, slippageBps, priorityFee, antiMev, { send: ctx });
      return { ...r, route: 'pumpswap-direct' };
    } catch (e: any) {
      routeFailed(ctx, 'pumpswap-direct', e);
      // 2026-05-15 — When pf says graduated but PumpSwap has no pool, the pf
      // cache may be stale (token is still pre-grad, pump.fun's API
      // momentarily reported complete=true, OR pool not yet indexed). Force-
      // refresh pf state and try PF-direct ONLY if the fresh fetch flips to
      // pre-grad. Otherwise we know the curve really is closed → Jupiter.
      if (isPumpMint) {
        const fresh = (await readCurveView(mint)) ?? await fetchPumpFunInfo(mint).catch(() => null) as any;
        if (fresh?.hasData && !fresh.complete) {
          logWarn(`[router] PumpSwap-direct buy failed (${e.message || e}) — pf cache was stale, trying PF-direct`);
          knownGrad    = false;
          knownPreGrad = true;
          pf           = fresh;
        } else {
          logWarn(`[router] PumpSwap-direct buy failed (${e.message || e}) — curve confirmed closed, falling back to Jupiter`);
        }
      } else {
        logWarn(`[router] PumpSwap-direct buy failed (${e.message || e}) — falling back to Jupiter`);
      }
    }
  }

  // ── PF-direct for pre-grad or pump-suffixed mints (cache may be cold) ──
  // FIX-PUMP: on again with the local builder only (pumpfun-swap.ts). Every refusal (curve, mint, quote, strict verifier, pre-sign
  // simulation) is thrown before signing, so the call goes on (PumpSwap is off, A-93g) to Jupiter, singleSend included.
  if (knownPreGrad || (isPumpMint && !knownGrad)) {
    try {
      const r = await pumpfunBuy(keypair, mint, solIn, slippageBps, priorityFee, antiMev, { send: ctx });
      return { ...r, route: 'pf-direct' };
    } catch (e: any) {
      routeFailed(ctx, 'pf-direct', e);
      logWarn(`[router] PF-direct buy failed (${e.message || e}) — trying PumpSwap then Jupiter`);
    }
  }

  // ── PumpSwap second-chance (token may have just graduated mid-flight) ──
  if (isPumpMint && !knownGrad) {
    try {
      const r = await pumpswapBuy(keypair, mint, solIn, slippageBps, priorityFee, antiMev, { send: ctx });
      return { ...r, route: 'pumpswap-direct' };
    } catch (e: any) {
      routeFailed(ctx, 'pumpswap-direct', e);
      logWarn(`[router] PumpSwap-direct buy failed (${e.message || e}) — falling back to Jupiter`);
    }
  }

  // ── Jupiter (final fallback for non-PF tokens or transition windows) ──
  const lamportsIn = solToLamports(solIn);
  const baseSlip   = (slippageBps != null && slippageBps > 0) ? slippageBps : 300;
  const { sig, quote } = await viaJupiter(ctx, () => executeWithRetry(
    keypair, CONFIG.SOL_MINT, mint, lamportsIn, baseSlip, 3, antiMev, priorityFee, false, ctx,
  ));
  return {
    sig, route: 'jupiter',
    // FIX-BUY2 item 2: the quote of the route that was SIGNED (the /swap/v2/build answer's outAmount on the Sender lane), not a v1 quote
    tokensOut: BigInt(quote?.outAmount || 0),
    slippageBpsUsed: baseSlip,
  };
}

/**
 * Smart-routed sell.
 *   tokensIn — RAW atom units (matches positions.json storage)
 */
async function routeSell(
  keypair: Keypair, mint: string, tokensIn: bigint, opts: RouterOpts, ctx: SendContext,
): Promise<RouterResult> {
  const { slippageBps = null, priorityFee = 100_000, antiMev = true } = opts;

  const isPumpMint   = mint.endsWith('pump');

  // B40 rule 5: warm cache, else ONE on-chain curve read, and the pump.fun API only as the fallback (FIX-PUMP: not for a 'pump' mint, as
  // in routeBuy: PF-direct's own read decides).
  let pf: any = getCachedPumpFunInfo(mint);
  if (!pf || !pf.hasData) pf = await readCurveView(mint);
  if ((!pf || !pf.hasData) && !isPumpMint) pf = await fetchPumpFunInfo(mint).catch(() => null) as any;
  let   knownGrad    = !!(pf?.hasData && pf.complete);
  let   knownPreGrad = !!(pf?.hasData && !pf.complete);

  // PumpSwap first when we KNOW the token has graduated
  if (knownGrad) {
    try {
      const r = await pumpswapSell(keypair, mint, tokensIn, slippageBps, priorityFee, antiMev, { send: ctx });
      return { ...r, route: 'pumpswap-direct' };
    } catch (e: any) {
      routeFailed(ctx, 'pumpswap-direct', e);
      // 2026-05-15 — symmetrical sanity-check to smartBuy: if pf cache says
      // graduated but PumpSwap has no pool, re-fetch pf and flip to pre-grad
      // route ONLY if the fresh fetch confirms.
      if (isPumpMint) {
        const fresh = (await readCurveView(mint)) ?? await fetchPumpFunInfo(mint).catch(() => null) as any;
        if (fresh?.hasData && !fresh.complete) {
          logWarn(`[router] PumpSwap-direct sell failed (${e.message || e}) — pf cache was stale, trying PF-direct`);
          knownGrad    = false;
          knownPreGrad = true;
          pf           = fresh;
        } else {
          logWarn(`[router] PumpSwap-direct sell failed (${e.message || e}) — curve confirmed closed, falling back to Jupiter`);
        }
      } else {
        logWarn(`[router] PumpSwap-direct sell failed (${e.message || e}) — falling back to Jupiter`);
      }
    }
  }

  // PF-direct for pre-grad or pump-suffixed mints (cache may be cold)
  // FIX-PUMP: on again, as in routeBuy: a refusal comes before signing and the call goes on to Jupiter.
  if (knownPreGrad || (isPumpMint && !knownGrad)) {
    try {
      const r = await pumpfunSell(keypair, mint, tokensIn, slippageBps, priorityFee, antiMev, { send: ctx });
      return { ...r, route: 'pf-direct' };
    } catch (e: any) {
      routeFailed(ctx, 'pf-direct', e);
      logWarn(`[router] PF-direct sell failed (${e.message || e}) — trying PumpSwap then Jupiter`);
    }
  }

  // PumpSwap second-chance (token may have graduated mid-flight)
  if (isPumpMint && !knownGrad) {
    try {
      const r = await pumpswapSell(keypair, mint, tokensIn, slippageBps, priorityFee, antiMev, { send: ctx });
      return { ...r, route: 'pumpswap-direct' };
    } catch (e: any) {
      routeFailed(ctx, 'pumpswap-direct', e);
      logWarn(`[router] PumpSwap-direct sell failed (${e.message || e}) — falling back to Jupiter`);
    }
  }

  // Jupiter fallback — SELL blocks on confirm (capital-protection: prevents
  // position monitor from re-firing sells before knowing prior landed).
  const baseSlip = (slippageBps != null && slippageBps > 0) ? slippageBps : 300;
  const { sig, quote } = await viaJupiter(ctx, () => executeWithRetry(
    keypair, mint, CONFIG.SOL_MINT, Number(tokensIn), baseSlip, 3, antiMev, priorityFee, true, ctx,
  ));
  return {
    sig, route: 'jupiter',
    // FIX-BUY2 item 2: the quote of the route that was SIGNED (the /swap/v2/build answer's outAmount on the Sender lane), not a v1 quote
    solOut: BigInt(quote?.outAmount || 0),
    slippageBpsUsed: baseSlip,
  };
}

// ── A-26: how a failed call is reported ─────────────────────────────────────────────────────────────

/**
 * The error the caller sees when no route succeeded.
 *   - at least one send was attempted  -> RouterSendError (same redacted message, every signature in order);
 *   - nothing sent, onSigned threw     -> the callback's own error, unchanged;
 *   - nothing sent, the impact cap refused routes: the failure of a route that was UNDER the cap if there was one (that is
 *     the actionable reason), otherwise ImpactCapError naming every refused route (routes that could not quote at all
 *     are not counted: all the routes that could were refused);
 *   - anything else                    -> the error as the route threw it.
 */
function finalError(ctx: SendContext, e: unknown): unknown {
  const inner = e instanceof OnSignedAbort ? e.original : e;
  if (ctx.sigs.length > 0) {
    const raw = e instanceof OnSignedAbort ? e.message : (inner as { message?: unknown } | null | undefined)?.message ?? inner;
    return new RouterSendError(redactSecrets(String(raw)), ctx.sigs);
  }
  if (e instanceof OnSignedAbort) return inner;
  if (ctx.maxImpactPct !== null && ctx.refusals.length > 0) {
    return ctx.underCapFailure !== undefined ? ctx.underCapFailure : new ImpactCapError(ctx.maxImpactPct, [...ctx.refusals]);
  }
  return inner;
}

// ── B40: quotes under their honest names, and the real fill on request ──────────────────────────────

/** Real fill from the transaction meta; never derived from a quote. 'unverified' when the meta cannot be read. */
async function readFill(side: 'buy' | 'sell', sig: string, keypair: Keypair, mint: string, opts: RouterOpts): Promise<FillResult | 'unverified'> {
  try {
    const reader = opts.fillReader ?? createFillReader();
    const owner = keypair.publicKey.toBase58();
    return side === 'buy' ? await reader.buyFill(sig, owner, mint) : await reader.sellFill(sig, owner, mint);
  } catch {
    return 'unverified';
  }
}

/** The result as the caller gets it: the route's own fields plus the A-26 `sent` / `sigs`. */
function describeSent(r: RouterResult, ctx: SendContext): RouterResult {
  if (ctx.buildOnly) return { ...r, sig: ctx.builtSig ?? r.sig, sent: false };
  const out: RouterResult = { ...r, sent: true };
  if (ctx.sigs.length > 0) out.sigs = [...ctx.sigs];
  return out;
}

/**
 * Smart-routed buy. Returns the route used so the caller can log/display it.
 *
 *   solIn — UI form (e.g. 0.05 = 0.05 SOL)
 *
 * `tokensOut` / `tokensOutQuoted` are the route's QUOTE. With `opts.awaitFill` the result also carries `fill`, the
 * amounts the chain reports (B40 rule 1); without it `fill` is absent and the caller reads it later via fills.ts.
 */
export async function smartBuy(
  keypair: Keypair, mint: string, solIn: number, opts: RouterOpts = {},
): Promise<RouterResult> {
  const ctx = createSendContext(opts);
  let r: RouterResult;
  try {
    r = await routeBuy(keypair, mint, solIn, opts, ctx);
  } catch (e) {
    throw finalError(ctx, e);
  }
  const out: RouterResult = describeSent({ ...r, tokensOutQuoted: r.tokensOutQuoted ?? r.tokensOut }, ctx);
  if (opts.awaitFill && out.sent) out.fill = await readFill('buy', r.sig, keypair, mint, opts);
  return out;
}

/**
 * Smart-routed sell.
 *   tokensIn — RAW atom units (matches positions.json storage)
 *
 * `solOut` / `solOutQuoted` are the route's QUOTE; `fill` (opt-in, see smartBuy) is what the chain paid.
 */
export async function smartSell(
  keypair: Keypair, mint: string, tokensIn: bigint, opts: RouterOpts = {},
): Promise<RouterResult> {
  const ctx = createSendContext(opts);
  let r: RouterResult;
  try {
    r = await routeSell(keypair, mint, tokensIn, opts, ctx);
  } catch (e) {
    throw finalError(ctx, e);
  }
  const out: RouterResult = describeSent({ ...r, solOutQuoted: r.solOutQuoted ?? r.solOut }, ctx);
  if (opts.awaitFill && out.sent) out.fill = await readFill('sell', r.sig, keypair, mint, opts);
  return out;
}
