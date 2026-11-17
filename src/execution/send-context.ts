/**
 * SEND CONTEXT (A-26): the one place where "sign, tell the caller, then send" is decided.
 *
 * Every route (pf-direct, pumpswap-direct, jupiter) builds a transaction, signs it and hands it to a sender. Auto-buy and
 * the sell machine need three things from that moment, and this module gives them to all three routes the same way:
 *
 *   onSigned     awaited AFTER signing and BEFORE each send. A throw aborts that send, and the whole call (the journal
 *                the callback writes is the safety record: if it cannot be written, nothing is sent). The callback gets
 *                the signature, the last block height at which the transaction can still land, and the route.
 *                `lastValidBlockHeight` is the builder's value when the builder returns one (Jupiter does, and so does
 *                the blockhash a local build is made with); otherwise it is the block height at signing + 151, an upper bound.
 *   buildOnly    build, verify and sign, but NEVER send and never call onSigned. The result says `sent: false`.
 *   singleSend   after one send there is no retry and no route fallback.
 *   maxImpactPct a route whose own quote impact is above the cap is refused BEFORE signing. When every route is refused
 *                the call fails with ImpactCapError and nothing was sent.
 *
 * A signature is recorded in `ctx.sigs` BEFORE the sender is called: a send that throws midway (timeout, 5xx) may still
 * have reached a validator, so "attempted" counts as "sent" for RouterSendError.sigs. Callers run their landed-check on
 * those signatures before they retry.
 *
 * Nothing here talks to the network except the default block-height reader, which uses the same resilient RPC pool as
 * the rest of the execution layer and is only called when an onSigned callback is set and the builder gave no bound.
 */
import bs58 from 'bs58';
import type { VersionedTransaction } from '@solana/web3.js';
import { defaultExecRpc, errorReason } from './exec-common';

export type SwapRoute = 'pf-direct' | 'pumpswap-direct' | 'jupiter';

/** A blockhash is valid for 150 blocks after the height it was fetched at; +1 makes the signing-height bound an upper bound. */
export const BLOCKHASH_VALIDITY_BLOCKS = 151;

/** What onSigned receives for every transaction that is about to be sent. */
export interface SignedTx {
  sig: string;
  lastValidBlockHeight: number;
  route: SwapRoute;
}

/** The A-26 options of smartBuy / smartSell (RouterOpts extends this). */
export interface SendOpts26 {
  onSigned?(s: SignedTx): Promise<void>;
  buildOnly?: boolean;
  singleSend?: boolean;
  maxImpactPct?: number;
}

export interface ImpactRefusal {
  route: SwapRoute;
  /** Measured impact in percent, or null when the route could not measure it (refused: fail closed). */
  impactPct: number | null;
}

/** Thrown before signing when a route's own quote impact is above `maxImpactPct`, or when every route was refused. */
export class ImpactCapError extends Error {
  readonly capPct: number;
  readonly refused: readonly ImpactRefusal[];
  constructor(capPct: number, refused: readonly ImpactRefusal[], message?: string) {
    super(message ?? describeRefusals(capPct, refused));
    this.name = 'ImpactCapError';
    this.capPct = capPct;
    this.refused = refused;
  }
}

function describeRefusals(capPct: number, refused: readonly ImpactRefusal[]): string {
  const parts = refused.map((r) => `${r.route} ${r.impactPct === null ? 'impact unknown' : `${r.impactPct.toFixed(2)}%`}`);
  return `price impact above the ${capPct}% cap (${parts.join(', ')}); nothing was sent`;
}

/** Any error thrown after at least one send: `sigs` holds every signature the call sent (or began to send), in order. */
export class RouterSendError extends Error {
  readonly sigs: string[];
  constructor(message: string, sigs: readonly string[]) {
    super(message);
    this.name = 'RouterSendError';
    this.sigs = [...sigs];
  }
}

// ── FIX-BUY: refused before signing ─────────────────────────────────────────────────────────────

export type PreSignRefusalKind = 'insufficient-sol' | 'simulation-failed';

/**
 * Thrown BEFORE signing when the simulation of the exact transaction says it would fail on-chain (FIX-BUY, 2026-11-06: 2jeX... and
 * 38HZ... were sent and reverted). Nothing was signed, journalled or sent, so no fee was paid. 'insufficient-sol' is final for the call
 * (another attempt cannot add SOL); 'simulation-failed' may be retried, but from then on no attempt of the call raises the slippage, buy
 * or sell (executeWithRetry; the sell ladder escalates within the owner's limits). Its message is what the owner reads.
 */
export class PreSignRefusal extends Error {
  readonly kind: PreSignRefusalKind;
  /** What the failing step needed and what the wallet had at that step, in lamports, when the System program's log says so. */
  readonly needLamports: bigint | null;
  readonly haveLamports: bigint | null;
  constructor(kind: PreSignRefusalKind, message: string, needLamports: bigint | null = null, haveLamports: bigint | null = null) {
    super(message);
    this.name = 'PreSignRefusal';
    this.kind = kind;
    this.needLamports = needLamports;
    this.haveLamports = haveLamports;
  }
}

/** Lamports as SOL with 4 decimals, rounded down ('floor') or up ('ceil'), so a shortfall never reads as enough. */
export function solText4(lamports: bigint, round: 'floor' | 'ceil'): string {
  const q = round === 'ceil' ? (lamports + 99_999n) / 100_000n : lamports / 100_000n;
  return `${q / 10_000n}.${(q % 10_000n).toString().padStart(4, '0')}`;
}

/** The System program's own line (the runtime's message, never a program's "Program log: ...") when a transfer finds too few lamports. */
const SYSTEM_INSUFFICIENT_LAMPORTS = /^Transfer: insufficient lamports (\d{1,20}), need (\d{1,20})$/;
const NOTHING_PAID = 'Nothing was sent; no fee was paid.';

/**
 * The refusal for a simulation that reported `err` (the `value.err` and `value.logs` of simulateTransaction). Too little SOL is
 * 'insufficient-sol': the System program's transfer line (with both amounts), InsufficientFundsForFee, InsufficientFundsForRent, or a fee
 * payer with no account (AccountNotFound). Anything else is 'simulation-failed', with the error redacted and cut (B40 rule 4). Every
 * message fits the 200 characters a Telegram error reply shows.
 */
export function simulationRefusal(err: unknown, logs: unknown): PreSignRefusal {
  for (const line of Array.isArray(logs) ? logs : []) {
    const m = typeof line === 'string' ? SYSTEM_INSUFFICIENT_LAMPORTS.exec(line) : null;
    if (m === null) continue;
    const have = BigInt(m[1]);
    const need = BigInt(m[2]);
    return new PreSignRefusal('insufficient-sol', `not enough SOL in the wallet: a step of the swap needs ${solText4(need, 'ceil')} SOL and only ${solText4(have, 'floor')} SOL `
      + `is left after the network fee and the new token accounts. ${NOTHING_PAID}`, need, have);
  }
  const o = err !== null && typeof err === 'object' && !Array.isArray(err) ? err as Record<string, unknown> : null;
  if (err === 'InsufficientFundsForFee') return new PreSignRefusal('insufficient-sol', `not enough SOL in the wallet for the network fee. ${NOTHING_PAID}`);
  if (o !== null && 'InsufficientFundsForRent' in o) return new PreSignRefusal('insufficient-sol', `not enough SOL in the wallet for the rent of a new account. ${NOTHING_PAID}`);
  if (err === 'AccountNotFound') return new PreSignRefusal('insufficient-sol', `the wallet has no SOL. ${NOTHING_PAID}`);
  const ie = o?.InstructionError;
  if (Array.isArray(ie) && ie[1] === 'ComputationalBudgetExceeded') {
    return new PreSignRefusal('simulation-failed', `the route needs more than 1,400,000 compute units, the most a transaction may use. ${NOTHING_PAID}`);
  }
  let text: string;
  try { text = JSON.stringify(err) ?? String(err); } catch { text = String(err); }
  return new PreSignRefusal('simulation-failed', `the swap would fail on-chain (simulation: ${errorReason(text).slice(0, 120)}). ${NOTHING_PAID}`);
}

/** Internal: the onSigned callback threw. Carries the callback's own error; the router unwraps it. */
export class OnSignedAbort extends Error {
  readonly original: unknown;
  constructor(original: unknown) {
    super(`onSigned failed: ${errorReason(original)}`);
    this.name = 'OnSignedAbort';
    this.original = original;
  }
}

export interface SendContext {
  readonly onSigned?: (s: SignedTx) => Promise<void>;
  readonly buildOnly: boolean;
  readonly singleSend: boolean;
  /** null = no cap. */
  readonly maxImpactPct: number | null;
  /** Signatures this call sent (or began to send), in order. */
  readonly sigs: string[];
  /** Signature of the transaction signed in buildOnly mode; it was never sent. */
  builtSig: string | null;
  /** Routes refused by the impact cap, in the order they were tried. */
  readonly refusals: ImpactRefusal[];
  /** Routes whose own impact was measured and was within the cap. */
  readonly passed: SwapRoute[];
  /** The last failure (not a refusal) of a route that had passed the cap; the router reports it instead of an impact refusal. */
  underCapFailure: unknown;
  /** Block height now; used for the +151 bound when the builder gave none. */
  blockHeight(): Promise<number>;
}

export interface SendContextDeps {
  blockHeight?: () => Promise<number>;
}

async function defaultBlockHeight(): Promise<number> {
  const h = await defaultExecRpc().call('getBlockHeight', [{ commitment: 'confirmed' }]);
  if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) throw new Error('block height unreadable');
  return Math.floor(h);
}

/** One context per smartBuy / smartSell call. Throws RangeError on an unusable `maxImpactPct` (nothing has been sent yet). */
export function createSendContext(opts: SendOpts26 = {}, deps: SendContextDeps = {}): SendContext {
  const cap = opts.maxImpactPct;
  if (cap !== undefined && cap !== null && (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0)) {
    throw new RangeError('maxImpactPct must be a finite number >= 0');
  }
  return {
    onSigned: opts.onSigned,
    buildOnly: opts.buildOnly === true,
    singleSend: opts.singleSend === true,
    maxImpactPct: cap === undefined || cap === null ? null : cap,
    sigs: [],
    builtSig: null,
    refusals: [],
    passed: [],
    underCapFailure: undefined,
    blockHeight: deps.blockHeight ?? defaultBlockHeight,
  };
}

/** Base58 transaction signature (first signature = the fee payer's). Throws when the transaction is not signed. */
export function signatureOf(tx: VersionedTransaction): string {
  const s = tx.signatures[0];
  if (!s || s.every((b) => b === 0)) throw new Error('transaction is not signed');
  return bs58.encode(s);
}

/**
 * The gate between "signed" and "sent". `send` is the actual sender (heliusSmartSend, multiRpcSend, Jupiter /execute);
 * it is called at most once, and never in buildOnly mode. Without a context this is a plain `send()`.
 *
 * `builderLastValid`: the last valid block height the transaction's builder reported, or null/undefined when it gave none.
 */
export async function dispatchSigned(
  ctx: SendContext | undefined,
  tx: VersionedTransaction,
  route: SwapRoute,
  builderLastValid: number | null | undefined,
  send: () => Promise<string>,
): Promise<{ sig: string; sent: boolean }> {
  if (!ctx) return { sig: await send(), sent: true };
  const sig = signatureOf(tx);
  if (ctx.buildOnly) {
    ctx.builtSig = sig;
    return { sig, sent: false };
  }
  if (ctx.onSigned) {
    let lastValid: number;
    if (typeof builderLastValid === 'number' && Number.isFinite(builderLastValid) && builderLastValid > 0) {
      lastValid = Math.floor(builderLastValid);
    } else {
      // No bound from the builder: the height now + 151 is an upper bound for any blockhash a transaction signed now can carry.
      // A failure here is plain (nothing was sent, nothing was journalled): the router may still try another route.
      lastValid = (await ctx.blockHeight()) + BLOCKHASH_VALIDITY_BLOCKS;
    }
    try {
      await ctx.onSigned({ sig, lastValidBlockHeight: lastValid, route });
    } catch (e) {
      throw new OnSignedAbort(e);
    }
  }
  ctx.sigs.push(sig);   // attempted == sent: the sender may throw after the transaction reached a validator
  await send();
  // The signature of the transaction we signed is the truth (it is what onSigned journalled); a sender's answer only confirms it.
  return { sig, sent: true };
}

/** True when the call must not try anything else: onSigned threw, or singleSend and a send was already attempted. */
export function mustStop(ctx: SendContext | undefined, e: unknown): boolean {
  if (e instanceof OnSignedAbort) return true;
  return !!ctx && ctx.singleSend && ctx.sigs.length > 0;
}

/**
 * Router bookkeeping for a route that failed: when the route had passed the impact cap, the failure is an
 * "under-cap failure" and is what the caller is told if no route succeeds (an impact refusal of another route is not).
 */
export function noteRouteFailure(ctx: SendContext | undefined, route: SwapRoute, e: unknown): void {
  if (!ctx || e instanceof ImpactCapError || e instanceof OnSignedAbort) return;
  if (ctx.passed.includes(route)) ctx.underCapFailure = e;
}

// ── Impact ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Price impact of a constant-product swap in percent: how far the average price is from the spot price, fee excluded.
 *   out = R_out * a / (R_in + a),  out at spot = R_out * a / R_in   =>   impact = a / (R_in + a)
 * `amountInAfterFee` is the amount that actually enters the curve (buys: the SOL after the fee; sells: the tokens, the fee
 * comes out of the SOL). Rounded UP to 4 decimals so the cap comparison never lets a marginal excess through.
 * Returns null on a degenerate reserve (the caller then fails closed).
 */
export function constantProductImpactPct(reserveIn: bigint, amountInAfterFee: bigint): number | null {
  if (reserveIn <= 0n || amountInAfterFee < 0n) return null;
  const denom = reserveIn + amountInAfterFee;
  const scaled = (amountInAfterFee * 1_000_000n + denom - 1n) / denom;   // percent * 10_000, rounded up
  return Number(scaled) / 10_000;
}

/**
 * Apply the cap to one route's measured impact (null = could not be measured). No cap set: nothing happens.
 * A refusal is recorded on the context and thrown as ImpactCapError; a pass is recorded too (the router uses both to decide
 * between "every route was refused" and "an under-cap route failed for another reason").
 */
export function enforceImpactCap(ctx: SendContext | undefined, route: SwapRoute, impactPct: number | null): void {
  if (!ctx || ctx.maxImpactPct === null) return;
  const ok = impactPct !== null && Number.isFinite(impactPct) && impactPct <= ctx.maxImpactPct;
  if (ok) {
    ctx.passed.push(route);
    return;
  }
  const refusal: ImpactRefusal = { route, impactPct: impactPct !== null && Number.isFinite(impactPct) ? impactPct : null };
  ctx.refusals.push(refusal);
  throw new ImpactCapError(ctx.maxImpactPct, [refusal]);
}
