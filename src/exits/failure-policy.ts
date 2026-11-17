/**
 * failure-policy.ts (B30 rule 6): what the exit engine does after a failed sell.
 *
 * The six EX-5 helpers are the verified grind fix `grind/fx-tgbot` (d3a2da8, ex c4fd4fe), moved here verbatim from
 * `bot/order-triggers.ts` (which is now a re-export shim until R4-B6). On top of them this module holds the rest of the
 * failure policy of read-bot-interface 5.3.4, as pure functions and two tiny state holders:
 *
 *   - take-profit legs: TP_MAX_ATTEMPTS (3) attempts, slippage escalating with `tpAttemptSlippageBps`, and a landed-check
 *     (`getSignatureStatuses` on every signature the failed attempt sent + `priorSellLikelyLanded` on the balance) before any retry;
 *   - protective legs (R0, S, T, H, CANCEL and the manual SL/TSL orders): never blocked by the per-CA breaker, a guaranteed exit
 *     (cap 4000 bps, then the 9900 bps panic leg), PROTECTIVE_MAX_ATTEMPTS (2) attempts, then `locked_out` and an owner alert
 *     (A-93f: a cool-down of LOCKOUT_REPROBE_MS, not a latch; an attempt that sent nothing is not counted);
 *   - the per-CA breaker counts consecutive failures, resets on a success and blocks take-profit legs only;
 *   - one sell at a time per (CA, wallet) across exits, cancel and manual sells (the `_autoSellInFlight` mutex, kept).
 */
import { redactSecrets } from '../lib/redact';

/** Grind fix EX-5 (2026-10-16): order-lane failure handling.
 *
 *  Before: every triggered order was deactivated before the sell and never
 *  re-armed, so ONE reverted TP swap during a pump (quotes go stale between
 *  quote and land exactly then) removed the only profit-taking order. Every
 *  failure also bumped the per-CA breaker, and once it tripped the order lane
 *  deactivated SL/TSL orders WITHOUT attempting them, although the hard-stop
 *  lane had already been exempted from that lock for the same reason.
 *
 *  Now:
 *   • SL/TSL (protective) orders ignore the CA lock. Each is still attempted at
 *     most once (deactivate-before-attempt), with executeSell's escalation and
 *     9900-bps panic leg, so no unbounded fee-burn loop is possible.
 *   • A TP gets TP_MAX_ATTEMPTS attempts on later ticks (each re-quoted by the
 *     next pass), slippage escalating from the base to smartSlippageMax.
 *   • Before a retry, a balance already reduced by about the TP's fraction means
 *     the earlier attempt probably landed even though it reported failure, so
 *     the TP is not sent again (no double sell). */
export const TP_MAX_ATTEMPTS = 3;

export function isProtectiveOrderType(type: unknown): boolean {
  return type === 'sl' || type === 'tsl';
}

/** True when the per-CA failed-tx breaker must block this order. Protective
 *  orders are never blocked; the breaker only bounds take-profit fee burn. */
export function caLockBlocksOrder(type: unknown, caLocked: boolean): boolean {
  return caLocked && !isProtectiveOrderType(type);
}

/** Slippage for TP attempt `attempt` (1-based): the base on the first attempt,
 *  the midpoint on the second, the retry cap on the last. Never below the base;
 *  an unusable cap keeps the base. */
export function tpAttemptSlippageBps(attempt: number, baseBps: number, maxBps: number, maxAttempts = TP_MAX_ATTEMPTS): number {
  const base = Number.isFinite(baseBps) && baseBps > 0 ? baseBps : 300;
  const cap  = Number.isFinite(maxBps) && maxBps > base ? maxBps : base;
  if (!(maxAttempts > 1) || !(attempt > 1)) return base;
  const step = Math.min(attempt, maxAttempts) - 1;
  return Math.round(base + (cap - base) * (step / (maxAttempts - 1)));
}

/** What the order lane does after a failed sell. TPs are re-armed until they
 *  have failed `maxAttempts` times; SL/TSL keep the single-attempt rule (the
 *  hard-stop lane is their bounded backstop). */
export function afterOrderSellFailure(
  type: unknown,
  priorFailedAttempts: number | undefined,
  maxAttempts = TP_MAX_ATTEMPTS,
): { failedAttempts: number; rearm: boolean } {
  const prev = Number.isFinite(priorFailedAttempts as number) && (priorFailedAttempts as number) > 0
    ? Math.floor(priorFailedAttempts as number) : 0;
  const failedAttempts = prev + 1;
  return { failedAttempts, rearm: type === 'tp' && failedAttempts < maxAttempts };
}

/** Before re-sending a failed TP: did the earlier attempt probably land anyway?
 *  True when the confirmed on-chain balance sits at or below the tracked amount
 *  minus half of the TP's sell fraction. Unknown/invalid inputs → false (retry). */
export function priorSellLikelyLanded(trackedAtoms: number, onchainAtoms: number | null | undefined, sellPct: number): boolean {
  if (onchainAtoms === null || onchainAtoms === undefined || !Number.isFinite(onchainAtoms) || onchainAtoms < 0) return false;
  if (!Number.isFinite(trackedAtoms) || trackedAtoms <= 0) return false;
  if (!Number.isFinite(sellPct) || sellPct <= 0) return false;
  const frac = Math.min(sellPct, 100) / 100;
  return onchainAtoms <= trackedAtoms * (1 - frac / 2);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// B30 additions on top of the ported helpers
// ---------------------------------------------------------------------------------------------------------------------------------

/** What kind of sell an attempt is. 'rug' is the R0 leg (no escalation ladder: the pool is emptying NOW). */
export type SellKind = 'tp' | 'protective' | 'rug' | 'cancel';

/** Protective legs: 2 attempts per leg (the old MAX_EMERGENCY_ATTEMPTS bound), then locked_out and an owner alert. */
export const PROTECTIVE_MAX_ATTEMPTS = 2;
/** Guaranteed-exit slippage cap of the protective legs (the old SL/TSL cap). */
export const PROTECTIVE_CAP_BPS = 4000;
/** The CANCEL leg escalates to this cap (the old RUG branch) before the panic leg. */
export const CANCEL_CAP_BPS = 5000;
/** The get-out-at-any-price leg after a failed guaranteed exit (9900 bps accepts whatever the pool gives). */
export const PANIC_SLIPPAGE_BPS = 9900;
/** Consecutive failed sells on one CA before take-profit sells on it are switched off until restart. */
export const MAX_FAILED_TX_PER_CA = 5;
/** A-93f: a protective lockout is a cool-down, not a latch. After this long the locked legs (and CANCEL) are probed again while their
 *  trigger still holds; every failed probe re-arms a longer cool-down (lockoutCooldownMs), a filled sell clears it, and a restart
 *  probes at once. */
export const LOCKOUT_REPROBE_MS = 90_000;
/** A-93f (review): the cool-down doubles after each failed re-probe, up to this cap, so a sell that keeps reverting is not re-sent
 *  (and its fees paid) every 90 s forever. */
export const LOCKOUT_REPROBE_MAX_MS = 30 * 60_000;
/** A-93f (review): the 🚨 lockout alert of one position is repeated at most this often (the first lockout always alerts). */
export const LOCKOUT_REALERT_MS = 600_000;

/** A-93f (review): the cool-down after a failed attempt that locked (or kept locked) a leg out. `failedAttempts` is the leg's persisted
 *  counter after that failure: the first lockout waits LOCKOUT_REPROBE_MS, each failed re-probe doubles the wait, capped at
 *  LOCKOUT_REPROBE_MAX_MS. The counter survives a restart, so a restart probes at once but does not reset the growth. */
export function lockoutCooldownMs(failedAttempts: number): number {
  const over = Math.max(0, repairedCount(failedAttempts) - PROTECTIVE_MAX_ATTEMPTS);
  return Math.min(LOCKOUT_REPROBE_MS * 2 ** Math.min(over, 20), LOCKOUT_REPROBE_MAX_MS);
}
/** A-93f: an attempt that sent nothing (an RPC or quote outage before signing) is not an attempt. It is retried on the cadence with this
 *  backoff cap, and the owner is alerted once it has lasted NOSEND_ALERT_MS (then every NOSEND_REALERT_MS). */
export const NOSEND_BACKOFF_MAX_MS = 30_000;
export const NOSEND_ALERT_MS = 120_000;
export const NOSEND_REALERT_MS = 600_000;

export function maxAttemptsFor(kind: SellKind): number {
  return kind === 'tp' ? TP_MAX_ATTEMPTS : PROTECTIVE_MAX_ATTEMPTS;
}

function repairedCount(n: number | undefined): number {
  return Number.isFinite(n as number) && (n as number) > 0 ? Math.floor(n as number) : 0;
}

/** The result of one failed attempt of a leg. TP: `afterOrderSellFailure` (re-armed until TP_MAX_ATTEMPTS). Protective: re-armed until
 *  PROTECTIVE_MAX_ATTEMPTS, then `lockedOut`. A corrupt persisted counter is repaired, never trusted. */
export function afterLegFailure(kind: SellKind, priorFailedAttempts: number | undefined): { failedAttempts: number; rearm: boolean; lockedOut: boolean } {
  if (kind === 'tp') {
    const r = afterOrderSellFailure('tp', priorFailedAttempts);
    return { failedAttempts: r.failedAttempts, rearm: r.rearm, lockedOut: false };
  }
  const failedAttempts = repairedCount(priorFailedAttempts) + 1;
  const rearm = failedAttempts < PROTECTIVE_MAX_ATTEMPTS;
  return { failedAttempts, rearm, lockedOut: !rearm };
}

/** The slippage steps (bps) of ONE attempt, in the order they are sent. A step is only sent after the landed-check of the previous one.
 *   tp          one send at `tpAttemptSlippageBps(attempt, base, smartMax)` (later attempts happen on later passes, re-quoted);
 *   protective  the guaranteed exit at max(base, 4000), then the 9900 panic leg;
 *   rug         the 9900 panic leg at once;
 *   cancel      the doubled base (at most 5000), then 5000, then the 9900 panic leg. */
export function slippageLadder(kind: SellKind, attempt: number, baseBps: number, smartMaxBps: number): number[] {
  const base = Number.isFinite(baseBps) && baseBps > 0 ? baseBps : 300;
  let steps: number[];
  switch (kind) {
    case 'tp': steps = [tpAttemptSlippageBps(attempt, base, smartMaxBps)]; break;
    case 'protective': steps = [Math.max(base, PROTECTIVE_CAP_BPS), PANIC_SLIPPAGE_BPS]; break;
    case 'rug': steps = [PANIC_SLIPPAGE_BPS]; break;
    case 'cancel': steps = [Math.min(base * 2, CANCEL_CAP_BPS), CANCEL_CAP_BPS, PANIC_SLIPPAGE_BPS]; break;
  }
  const out: number[] = [];
  for (const s of steps) if (out.length === 0 || s > out[out.length - 1]) out.push(s);
  return out;
}

/** `redactSecrets(String(e?.message ?? e)).slice(0, 200)` (plan grind #64): the one rule for every error string the exit engine reports. */
export function errorString(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message ?? e;
  return redactSecrets(String(msg)).slice(0, 200);
}

// --- the per-CA breaker ----------------------------------------------------------------------------------------------------------

export interface CaBreaker {
  /** Counts one failed sell on `ca`. Returns true exactly when this failure tripped the lock. */
  bump(ca: string): boolean;
  /** A filled sell: the counter counts CONSECUTIVE failures. An existing lock still lasts until restart. */
  reset(ca: string): void;
  isLocked(ca: string): boolean;
  /** True when the breaker must stop a leg of this kind on this CA: take-profit legs only, never a protective one. */
  blocks(kind: SellKind, ca: string): boolean;
  failures(ca: string): number;
}

export function createCaBreaker(maxFails = MAX_FAILED_TX_PER_CA): CaBreaker {
  const fails = new Map<string, number>();
  const locked = new Set<string>();
  return {
    bump(ca) {
      const n = (fails.get(ca) ?? 0) + 1;
      fails.set(ca, n);
      if (n >= maxFails && !locked.has(ca)) {
        locked.add(ca);
        return true;
      }
      return false;
    },
    reset(ca) { fails.delete(ca); },
    isLocked(ca) { return locked.has(ca); },
    blocks(kind, ca) { return caLockBlocksOrder(kind === 'tp' ? 'tp' : 'sl', locked.has(ca)); },
    failures(ca) { return fails.get(ca) ?? 0; },
  };
}

// --- the per-(CA, wallet) sell mutex ---------------------------------------------------------------------------------------------

export interface SellMutex {
  tryAcquire(key: string): boolean;
  release(key: string): void;
  has(key: string): boolean;
}

/** One sell at a time per `${ca}:${walletId}`, across exits, cancel and manual sells. */
export function createSellMutex(): SellMutex {
  const held = new Set<string>();
  return {
    tryAcquire(key) {
      if (held.has(key)) return false;
      held.add(key);
      return true;
    },
    release(key) { held.delete(key); },
    has(key) { return held.has(key); },
  };
}

export function sellKey(ca: string, walletId: string): string {
  return `${ca}:${walletId}`;
}

// --- the landed-check ----------------------------------------------------------------------------------------------------------------

export interface SignatureStatus { err?: unknown; confirmationStatus?: string | null }
export interface LandedCheckDeps {
  /** RPC getSignatureStatuses(sigs, { searchTransactionHistory: true }); one entry per signature, null when unknown. */
  signatureStatuses(sigs: string[]): Promise<Array<SignatureStatus | null>>;
  /** Confirmed on-chain balance of (owner, mint): `{ rawAtoms: 0 }` is a confirmed empty account, null is UNKNOWN (never zero). */
  tokenBalance(owner: string, mint: string): Promise<{ rawAtoms: number } | null>;
  /** A-93f: the current block height at 'confirmed' (the blockhash-expiry check before any re-send). A throw is "unknown". */
  blockHeight(): Promise<number>;
}

/**
 * A-93f: may an earlier send still land? True when at least one signature has no readable final status (not confirmed, no error) and
 * its blockhash may still be valid: the block height is unreadable, or it is at or below that signature's lastValidBlockHeight. A
 * signature whose lastValidBlockHeight is not known (written before this rule) is treated as expired, the old behaviour. A status RPC
 * that errors leaves every signature unresolved. The caller must not send the same sell again while this is true; it waits and checks
 * again on the next pass.
 */
export async function sendsMayStillLand(
  deps: LandedCheckDeps, sigs: readonly string[], heights: Readonly<Record<string, number>>,
): Promise<boolean> {
  if (sigs.length === 0) return false;
  let statuses: Array<SignatureStatus | null> = [];
  try { statuses = await deps.signatureStatuses([...sigs]); } catch { statuses = []; }
  const open = sigs.filter((s, i) => {
    const st = statuses[i];
    if (!st) return true;
    if (st.err !== null && st.err !== undefined) return false;
    return st.confirmationStatus !== 'confirmed' && st.confirmationStatus !== 'finalized';
  }).filter(s => Number.isFinite(heights[s]));
  if (open.length === 0) return false;
  let height: number | null = null;
  try {
    const h = await deps.blockHeight();
    height = typeof h === 'number' && Number.isFinite(h) ? h : null;
  } catch { height = null; }
  if (height === null) return true;
  return open.some(s => height! <= heights[s]);
}

export type LandedVerdict =
  | { landed: true; via: 'status'; sig: string }
  | { landed: true; via: 'balance'; rawAtoms: number }
  | { landed: false; balance: number | null };

/**
 * Did an earlier sell attempt land even though it reported a failure? (A-28; read-bot-interface 3.3.)
 *   1. `getSignatureStatuses` on every signature the failed attempt sent: one confirmed without an error means it landed, and the
 *      caller reads the fill from THAT signature;
 *   2. else the balance heuristic `priorSellLikelyLanded` (the wallet already holds about the sold fraction less than tracked);
 *      a confirmed zero balance after a send counts as landed too (we did send a sell, and the account is empty).
 * With NO signatures (nothing was sent) a zero balance is not "landed": it returns `{ landed: false, balance: 0 }` and the caller
 * leaves the position to the reconcile rule (two zero readings). An RPC error is "unknown" and falls through; unknown never means landed.
 */
export async function checkSellLanded(
  deps: LandedCheckDeps,
  a: { owner: string; mint: string; sigs: readonly string[]; trackedAtoms: number; sellPct: number; balance?: { rawAtoms: number } | null },
): Promise<LandedVerdict> {
  if (a.sigs.length > 0) {
    try {
      const statuses = await deps.signatureStatuses([...a.sigs]);
      for (let i = 0; i < a.sigs.length; i++) {
        const s = statuses[i];
        if (s && (s.err === null || s.err === undefined) && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
          return { landed: true, via: 'status', sig: a.sigs[i] };
        }
      }
    } catch { /* unknown: fall through to the balance heuristic */ }
  }
  let bal = a.balance;
  if (bal === undefined) {
    try { bal = await deps.tokenBalance(a.owner, a.mint); } catch { bal = null; }
  }
  if (bal && bal.rawAtoms === 0 && a.sigs.length === 0) return { landed: false, balance: 0 };
  if (bal && priorSellLikelyLanded(a.trackedAtoms, bal.rawAtoms, a.sellPct)) return { landed: true, via: 'balance', rawAtoms: bal.rawAtoms };
  return { landed: false, balance: bal ? bal.rawAtoms : null };
}
