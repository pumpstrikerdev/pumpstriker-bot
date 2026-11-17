/**
 * manual-orders.ts (B30 rule 5): the trigger logic of MANUAL positions (buttons, `/buy`, migrated positions) and of the user's own
 * SL / TP / TSL orders. Manual positions keep today's presets and the -25% floor exactly as today, plus R0.
 *
 * Part 1 is the pure trigger code that used to live in `bot/order-triggers.ts` (extracted from bot.ts 2026-06-10), moved here
 * verbatim: `evaluateTsl`, `normalizeTslPreset`, `detectHardRug`, `rescaleHardStopState`, `LEGACY_TSL_DEFAULT_TRAIL` and the three
 * types. `bot/order-triggers.ts` is now a re-export shim of this file and of `failure-policy.ts` until R4-B6 deletes it.
 *
 * Part 2 is `evaluateManual`: ONE pure function that takes the single quote of a pass and decides, for one manual position and its
 * `ManualOrderV2` records, exactly what `runOrderMonitorPass` (order lane) and `runHardStopLossPass` (hard-stop lane) decide today:
 *   - an order's multiple is `multi = value per token / basis`, with `basis = entry SOL / tokens` for a migrated position, so it is
 *     the same `curSol / entryAmountSol` the old lane computed; `baseline_multi` is the order's FIRST evaluated multiple, persisted;
 *     `rel = multi / baseline_multi`; TP fires at `(rel - 1) * 100 >= trigger_pct`, SL at `<=`, TSL through `evaluateTsl`;
 *   - the hard-stop lane: the -25% floor measured from the FIRST evaluated quote (`floor_base`), and the hard-rug detector
 *     (`detectHardRug`: a drop of >= HARD_RUG_DROP_PCT between two consecutive quotes of one source).
 * Values are SOL per token ATOM, so a change of the bag size between two passes needs no rescale (the quote of the whole bag divided by
 * its token count is already independent of the bag; `rescaleHardStopState` stays for `bot.ts`).
 */
import type { ManualOrderV2 } from '../bot-contracts';

export interface TslOrderLike {
  /** Trail width, NEGATIVE percent below tracked peak (e.g. -30). */
  triggerPct: number;
  /** Optional activation level, positive percent above entry (e.g. 80). */
  armAfterPct?: number | null;
  /** Highest multiplier seen so far (1 = entry price). */
  highestMultiplier: number;
}

export interface TslEvaluation {
  triggered: boolean;
  /** Peak after this tick — caller persists it back onto the order. */
  newHighestMultiplier: number;
  /** Whether the trail is armed after this tick (for UI/diagnostics). */
  armed: boolean;
}

/**
 * Evaluate a trailing-stop order against the current multiplier
 * (multi = currentValue / entryValue, 1 = breakeven).
 */
export function evaluateTsl(order: TslOrderLike, multi: number): TslEvaluation {
  const prevHigh = Number.isFinite(order.highestMultiplier) && order.highestMultiplier > 0
    ? order.highestMultiplier : 1;
  const newHighestMultiplier = Math.max(prevHigh, multi);

  // Arming: the PEAK (not the current price) must have reached the activation
  // level — once armed, a later fall below the level does not disarm.
  const armAfter = order.armAfterPct;
  const armed = armAfter == null || !Number.isFinite(armAfter)
    ? true
    : newHighestMultiplier >= 1 + armAfter / 100;

  // Defensive: a trail width must be negative. A zero/positive width would
  // re-create the instant-dump bug, so it fails SAFE (never triggers).
  const trail = order.triggerPct;
  if (!Number.isFinite(trail) || trail >= 0) {
    return { triggered: false, newHighestMultiplier, armed };
  }

  const triggered = armed && multi <= newHighestMultiplier * (1 + trail / 100);
  return { triggered, newHighestMultiplier, armed };
}

/** Default trail width applied when fixing legacy positive-value TSL presets. */
export const LEGACY_TSL_DEFAULT_TRAIL = -30;

export interface TslPresetLike {
  type?: string;
  triggerPct?: number;
  armAfterPct?: number | null;
  [k: string]: unknown;
}

/**
 * Normalize a TSL preset loaded from settings.json/defaults.
 * Returns the fixed preset, or null if the preset is unusable (caller skips it).
 *  • Legacy positive triggerPct (the bug shape) → reinterpreted as the
 *    activation level it was meant to be, with the default −30 trail.
 *  • Valid negative triggerPct → unchanged (armAfterPct passes through).
 *  • Zero/NaN/missing triggerPct → rejected.
 * Non-TSL presets pass through untouched.
 */
export function normalizeTslPreset<T extends TslPresetLike>(preset: T): T | null {
  if (!preset || preset.type !== 'tsl') return preset ?? null;
  const t = preset.triggerPct;
  if (!Number.isFinite(t as number) || t === 0) return null;
  if ((t as number) > 0) {
    return {
      ...preset,
      armAfterPct: preset.armAfterPct ?? (t as number),
      triggerPct: LEGACY_TSL_DEFAULT_TRAIL,
    };
  }
  return preset;
}

/** Hard-rug detector (2026-07-12). Compares this hard-stop tick's quoted SOL value
 *  with the previous tick's for the same (CA, wallet). A drop of >= thresholdPct in
 *  one tick is a liquidity pull in progress → caller panic-sells at max slippage.
 *  thresholdPct <= 0 disables. No/invalid previous value (first sighting) → never fires. */
// REBUILD-CHOSEN: body reconstructed from the Sep 25 bot.ts call-site contract (WI-A C2.5).
export function detectHardRug(
  prevSol: number | undefined,
  curSol: number,
  thresholdPct: number,
): { isRug: boolean; dropPct: number } {
  if (!(thresholdPct > 0)) return { isRug: false, dropPct: 0 };
  if (prevSol === undefined || !Number.isFinite(prevSol) || prevSol <= 0) return { isRug: false, dropPct: 0 };
  if (!Number.isFinite(curSol)) return { isRug: false, dropPct: 0 };
  const dropPct = Math.max(0, ((prevSol - curSol) / prevSol) * 100);
  return { isRug: dropPct >= thresholdPct, dropPct };
}

/** Hard-stop bag-size rescale. The hard-stop lane stores a previous-tick SOL quote
 *  (detectHardRug input) and a first-tick baseline (-25% floor) for each (CA, wallet),
 *  both quoted for the WHOLE bag. When the token amount changes between ticks (tier
 *  TP partial sell, manual 50%/75% sell, reconcile after an external partial sell,
 *  add-on buy), those values must be scaled by curAmt/prevAmt, otherwise a 60% sell
 *  reads as a 60% one-tick crash (9900-bps rug dump) and an add-on buy loosens the
 *  floor. No/invalid previous amount, an invalid current amount, or no change →
 *  values returned untouched (rescaled=false). */
// REBUILD-CHOSEN (FIX-1): deviation from the verbatim Sep 25 bot.ts, which never rescaled.
export function rescaleHardStopState(
  prevAmt: number | undefined,
  curAmt: number,
  lastSol: number | undefined,
  baseSol: number | undefined,
): { lastSol: number | undefined; baseSol: number | undefined; rescaled: boolean } {
  if (prevAmt === undefined || !Number.isFinite(prevAmt) || prevAmt <= 0) return { lastSol, baseSol, rescaled: false };
  if (!Number.isFinite(curAmt) || curAmt <= 0 || curAmt === prevAmt) return { lastSol, baseSol, rescaled: false };
  const k = curAmt / prevAmt;
  return {
    lastSol: lastSol === undefined ? undefined : lastSol * k,
    baseSol: baseSol === undefined ? undefined : baseSol * k,
    rescaled: true,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Part 2: the manual-position evaluation
// ---------------------------------------------------------------------------------------------------------------------------------

/** The universal hard-stop floor of today's hard-stop lane (STOP_LOSS_PCT): percent below the first evaluated quote. Manual positions only. */
export const MANUAL_FLOOR_PCT = -25;
/** HARD_RUG_DROP_PCT default (env HARD_RUG_DROP_PCT, read by config.ts and passed in). */
export const DEFAULT_HARD_RUG_DROP_PCT = 40;
/** Two quotes count as "consecutive ticks" for the manual hard-rug check only when they are at most this far apart (today's ticks are
 *  7.5-15 s apart and the previous tick lived in memory; a quote persisted before a restart must not read as one tick). */
export const MANUAL_R0_MAX_GAP_MS = 60_000;

/** A `ManualOrderV2` as stored: the frozen fields plus optional extensions the frozen type has no room for (plan grind #46 copies
 *  `type`, `triggerPct`, `expiresAt` and `baselineMulti`; the old record also carries `balance` and `armAfterPct`, see sell_pct / arm_after_pct). */
export interface StoredManualOrder extends ManualOrderV2 {
  /** Percent of the CURRENT holding the order sells when it fires (the old `balance`). Missing = 100. */
  sell_pct?: number;
  /** TSL activation level in percent above entry (the old `armAfterPct`). Missing/null = armed at once. */
  arm_after_pct?: number | null;
  deactivated_reason?: string | null;
  last_failure?: string | null;
  /** A-93f: a protective order that was locked out is armed again at this time (epoch ms) and probed once more while it still fires. */
  retry_at?: number | null;
}

export function sellPctOf(o: Pick<StoredManualOrder, 'sell_pct'>): number {
  const p = o.sell_pct;
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? Math.min(p, 100) : 100;
}

export interface ManualQuoteIn {
  /** SOL per token atom now. */
  price: number;
  at: number;
  src: string;
}

export interface ManualEvalInput {
  /** `basis_sol_per_token` of the position (entry SOL / tokens for a migrated one), or null (taken from this quote). */
  basis: number | null;
  /** SOL per atom of the first evaluated quote (the hard-stop anchor), or null (taken from this quote). */
  floorBase: number | null;
  /** The previous quote of this position (per atom), or null. */
  prev: ManualQuoteIn | null;
  orders: readonly StoredManualOrder[];
  quote: ManualQuoteIn;
  now: number;
  /** HARD_RUG_DROP_PCT; <= 0 disables the rug check. */
  hardRugDropPct: number;
  /** False when the quote is not executable truth (the Engine price): TP orders are not evaluated then. */
  allowTp: boolean;
  /** The per-CA breaker is locked: a fired TP is blocked (SL / TSL never are). */
  caLocked: boolean;
}

export type ManualOrderVerdict = 'idle' | 'fired' | 'blocked_ca_lock' | 'expired' | 'skipped_quote';

export interface ManualOrderEval {
  orderId: string;
  verdict: ManualOrderVerdict;
  /** Fields to persist on the order (baseline_multi, peak_rel, active, deactivated_reason). Empty when nothing changed. */
  patch: Partial<StoredManualOrder>;
  /** (rel - 1) * 100 at this quote; null when not evaluated. */
  relPct: number | null;
  /** Highest rel seen (TSL), after this quote. */
  peakRel: number | null;
}

export interface ManualEvaluation {
  multi: number;
  basis: number;
  floorBase: number;
  /** Position fields to persist: the basis and the floor anchor when they were taken from this quote. */
  positionPatch: { basis_sol_per_token?: number; floor_base?: number };
  /** The hard-stop lane fired: sell 100% at once (a hard rug at the panic slippage, a floor breach on the guaranteed-exit ladder). */
  emergency: { reason: 'rug' | 'floor'; dropPct: number; pnlPct: number } | null;
  orders: ManualOrderEval[];
}

/**
 * Pure. See the file header. Never reads the clock (`now` is passed in) and never throws on bad numbers: an unusable quote returns
 * no verdicts. Orders are evaluated even when the emergency lane fires (their baselines and peaks stay current); the caller skips
 * their sells then, because the emergency lane sells the whole holding.
 */
export function evaluateManual(i: ManualEvalInput): ManualEvaluation {
  const price = i.quote.price;
  const positionPatch: ManualEvaluation['positionPatch'] = {};
  if (!Number.isFinite(price) || price < 0) {
    return { multi: NaN, basis: i.basis ?? NaN, floorBase: i.floorBase ?? NaN, positionPatch, emergency: null, orders: [] };
  }
  let basis = i.basis;
  if (basis === null || !Number.isFinite(basis) || basis <= 0) {
    if (!(price > 0)) {
      // A zero quote cannot become the basis; nothing can be judged against it yet.
      return { multi: NaN, basis: NaN, floorBase: i.floorBase ?? NaN, positionPatch, emergency: null, orders: [] };
    }
    basis = price;
    positionPatch.basis_sol_per_token = price;
  }
  let floorBase = i.floorBase;
  if (floorBase === null || !Number.isFinite(floorBase) || floorBase <= 0) {
    floorBase = price > 0 ? price : basis;
    positionPatch.floor_base = floorBase;
  }
  const multi = price / basis;

  // --- hard-stop lane: R0 (hard rug) or the -25% floor ---
  let emergency: ManualEvaluation['emergency'] = null;
  const prev = i.prev;
  const consecutive = prev !== null && prev.src === i.quote.src && i.quote.at - prev.at >= 0 && i.quote.at - prev.at <= MANUAL_R0_MAX_GAP_MS;
  const rug = detectHardRug(consecutive && prev !== null ? prev.price : undefined, price, i.hardRugDropPct);
  const pnlPct = ((price - floorBase) / floorBase) * 100;
  if (rug.isRug) emergency = { reason: 'rug', dropPct: rug.dropPct, pnlPct };
  else if (pnlPct <= MANUAL_FLOOR_PCT) emergency = { reason: 'floor', dropPct: rug.dropPct, pnlPct };

  // --- order lane ---
  const orders: ManualOrderEval[] = [];
  for (const o of i.orders) {
    if (!o.active) continue;
    if (o.expires_at !== null && i.now > o.expires_at) {
      orders.push({ orderId: o.order_id, verdict: 'expired', patch: { active: false, deactivated_reason: 'expired' }, relPct: null, peakRel: o.peak_rel });
      continue;
    }
    const patch: Partial<StoredManualOrder> = {};
    let baseline = o.baseline_multi;
    if (baseline === null || !Number.isFinite(baseline) || baseline <= 0) {
      baseline = multi;
      patch.baseline_multi = multi;
    }
    const rel = multi / baseline;
    const relPct = (rel - 1) * 100;
    let triggered = false;
    let peakRel: number | null = o.peak_rel;
    if (o.type === 'tp') {
      triggered = relPct >= o.trigger_pct;
    } else if (o.type === 'sl') {
      triggered = relPct <= o.trigger_pct;
    } else if (o.type === 'tsl') {
      const tsl = evaluateTsl({ triggerPct: o.trigger_pct, armAfterPct: o.arm_after_pct ?? null, highestMultiplier: o.peak_rel ?? 1 }, rel);
      if (tsl.newHighestMultiplier !== (o.peak_rel ?? 1) || o.peak_rel === null) patch.peak_rel = tsl.newHighestMultiplier;
      peakRel = tsl.newHighestMultiplier;
      triggered = tsl.triggered;
    }
    let verdict: ManualOrderVerdict = 'idle';
    if (triggered) {
      if (o.type === 'tp' && !i.allowTp) verdict = 'skipped_quote';
      else if (o.type === 'tp' && i.caLocked) {
        verdict = 'blocked_ca_lock';
        patch.active = false;
        patch.deactivated_reason = 'ca-locked';
      } else verdict = 'fired';
    }
    orders.push({ orderId: o.order_id, verdict, patch, relPct, peakRel });
  }
  return { multi, basis, floorBase, positionPatch, emergency, orders };
}

/** Execution order of the orders that fired in one pass: the protective ones (SL, TSL) first, then the TPs by ascending trigger. */
export function executionOrder(fired: readonly StoredManualOrder[]): StoredManualOrder[] {
  const rank = (o: StoredManualOrder): number => (o.type === 'tp' ? 1 : 0);
  return [...fired].sort((a, b) => rank(a) - rank(b) || (a.type === 'tp' && b.type === 'tp' ? a.trigger_pct - b.trigger_pct : 0) || a.created_at - b.created_at);
}
