/**
 * Unit tests for the manual-position trigger logic. The TSL, preset, hard-rug and rescale cases are today's cases of
 * `bot/order-triggers.test.ts`, moved here verbatim: the 2026-06-10 sign-inversion regression (a positive preset triggerPct used to make
 * a TSL dump 100% on the first order-monitor tick), the REBUILD-CHOSEN hard-rug cases and the bag-size rescale. The rest checks
 * `evaluateManual` against a reference copy of the old order lane and hard-stop lane.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateTsl, normalizeTslPreset, detectHardRug, rescaleHardStopState, LEGACY_TSL_DEFAULT_TRAIL, type TslPresetLike,
  evaluateManual, executionOrder, sellPctOf, MANUAL_FLOOR_PCT, MANUAL_R0_MAX_GAP_MS, type StoredManualOrder,
} from './manual-orders';

describe('evaluateTsl', () => {
  it('NEVER triggers on the legacy bug shape (positive trail) — fail-safe', () => {
    // The exact preset that caused the instant dump: triggerPct +50, fresh order.
    const order = { triggerPct: 50, highestMultiplier: 1 };
    expect(evaluateTsl(order, 1.0).triggered).toBe(false);   // first tick at entry
    expect(evaluateTsl(order, 0.5).triggered).toBe(false);   // even on a -50% dump
    expect(evaluateTsl(order, 3.0).triggered).toBe(false);   // and on a pump
  });

  it('does not trigger while UNARMED, even through a deep drawdown', () => {
    // Arms at +50%; peak only reached +30% then collapsed -40%.
    const order = { triggerPct: -25, armAfterPct: 50, highestMultiplier: 1.3 };
    const r = evaluateTsl(order, 0.6);
    expect(r.armed).toBe(false);
    expect(r.triggered).toBe(false);
  });

  it('arms once PEAK crosses the activation level and stays armed', () => {
    const order = { triggerPct: -25, armAfterPct: 50, highestMultiplier: 1.6 };
    // Price fell back below the arm level — trail must remain armed.
    const r = evaluateTsl(order, 1.45);
    expect(r.armed).toBe(true);
    expect(r.triggered).toBe(false); // 1.45 > 1.6 * 0.75 = 1.2 — no breach yet
  });

  it('triggers when armed and price gives back the trail width from peak', () => {
    const order = { triggerPct: -25, armAfterPct: 50, highestMultiplier: 1.6 };
    const r = evaluateTsl(order, 1.15); // 1.15 <= 1.6 * 0.75 = 1.2
    expect(r.armed).toBe(true);
    expect(r.triggered).toBe(true);
  });

  it('tracks a new peak and does not trigger at the peak itself', () => {
    const order = { triggerPct: -30, armAfterPct: 50, highestMultiplier: 1.4 };
    const r = evaluateTsl(order, 2.0);
    expect(r.newHighestMultiplier).toBe(2.0);
    expect(r.triggered).toBe(false);
  });

  it('treats a missing armAfterPct as always-armed (manual orders)', () => {
    // Manual path validates negative triggerPct and has no activation gate.
    const order = { triggerPct: -10, highestMultiplier: 1.5 };
    expect(evaluateTsl(order, 1.34).triggered).toBe(true);   // 1.34 <= 1.5*0.9
    expect(evaluateTsl(order, 1.36).triggered).toBe(false);
  });

  it('repairs a corrupt highestMultiplier instead of trusting it', () => {
    const order = { triggerPct: -25, highestMultiplier: NaN as unknown as number };
    const r = evaluateTsl(order, 1.1);
    expect(r.newHighestMultiplier).toBe(1.1);
    expect(r.triggered).toBe(false);
  });
});

describe('normalizeTslPreset', () => {
  it('reinterprets the legacy positive triggerPct as the activation level', () => {
    const legacy: TslPresetLike = { type: 'tsl', triggerPct: 120, balance: 100 };
    const fixed = normalizeTslPreset(legacy);
    expect(fixed).not.toBeNull();
    expect(fixed!.armAfterPct).toBe(120);
    expect(fixed!.triggerPct).toBe(LEGACY_TSL_DEFAULT_TRAIL);
  });

  it('passes a valid negative-trail preset through unchanged', () => {
    const preset = { type: 'tsl', triggerPct: -35, armAfterPct: 200, balance: 100 };
    expect(normalizeTslPreset(preset)).toBe(preset);
  });

  it('rejects zero / non-finite trail widths', () => {
    expect(normalizeTslPreset({ type: 'tsl', triggerPct: 0 })).toBeNull();
    expect(normalizeTslPreset({ type: 'tsl', triggerPct: NaN })).toBeNull();
    expect(normalizeTslPreset({ type: 'tsl' })).toBeNull();
  });

  it('leaves non-TSL presets untouched', () => {
    const tp = { type: 'tp', triggerPct: 100, balance: 35 };
    expect(normalizeTslPreset(tp)).toBe(tp);
  });
});

// REBUILD-CHOSEN: the 6 Sep 25 detectHardRug cases are lost; these follow WI-A C2.6.
describe('detectHardRug', () => {
  it('never fires on the first sighting (no previous tick)', () => {
    expect(detectHardRug(undefined, 10, 40).isRug).toBe(false);
  });

  it('fires when the value drops by exactly the threshold in one tick', () => {
    const r = detectHardRug(100, 60, 40);
    expect(r.isRug).toBe(true);
    expect(r.dropPct).toBe(40);
  });

  it('does not fire just below the threshold', () => {
    const r = detectHardRug(100, 61, 40);
    expect(r.isRug).toBe(false);
    expect(r.dropPct).toBe(39);
  });

  it('reports no drop when the value went up', () => {
    const r = detectHardRug(100, 150, 40);
    expect(r.isRug).toBe(false);
    expect(r.dropPct).toBe(0);
  });

  it('threshold 0 disables the detector', () => {
    expect(detectHardRug(100, 1, 0).isRug).toBe(false);
  });

  it('fails safe on invalid inputs', () => {
    expect(detectHardRug(0, 0, 40).isRug).toBe(false);
    expect(detectHardRug(NaN, 10, 40).isRug).toBe(false);
    expect(detectHardRug(100, NaN, 40).isRug).toBe(false);
  });
});

// REBUILD-CHOSEN (FIX-1): hard-stop bag-size rescale (partial sell must not read as a crash).
describe('rescaleHardStopState', () => {
  const STOP_LOSS_PCT = -25;

  it('a 60% partial sell is not a rug and not a -25% breach', () => {
    const N = 1_000_000;
    // tick 1: 1.0 SOL quoted for N tokens → prev = base = 1.0
    // 60% sell leaves 0.4N; tick 2 quotes 0.48 SOL for the rest (+20%)
    const rs = rescaleHardStopState(N, 0.4 * N, 1.0, 1.0);
    expect(rs.rescaled).toBe(true);
    expect(rs.lastSol).toBeCloseTo(0.4, 12);
    expect(rs.baseSol).toBeCloseTo(0.4, 12);
    const curSol = 0.48;
    expect(detectHardRug(rs.lastSol, curSol, 40).isRug).toBe(false);
    const pnlPct = ((curSol - (rs.baseSol as number)) / (rs.baseSol as number)) * 100;
    expect(pnlPct).toBeCloseTo(20, 9);
    expect(pnlPct).toBeGreaterThan(STOP_LOSS_PCT);
  });

  it('without the rescale the same tick would false-fire (regression guard)', () => {
    expect(detectHardRug(1.0, 0.48, 40).isRug).toBe(true);
  });

  it('still detects a real crash after a partial sell', () => {
    const rs = rescaleHardStopState(1000, 400, 1.0, 1.0);
    // remaining 400 tokens now quote 0.2 SOL (was worth 0.4) → -50% in one tick
    expect(detectHardRug(rs.lastSol, 0.2, 40).isRug).toBe(true);
  });

  it('an add-on buy scales the stored values up (floor stays as tight)', () => {
    const rs = rescaleHardStopState(1000, 2000, 1.0, 0.8);
    expect(rs.rescaled).toBe(true);
    expect(rs.lastSol).toBeCloseTo(2.0, 12);
    expect(rs.baseSol).toBeCloseTo(1.6, 12);
  });

  it('no change / first sighting / invalid amounts leave values untouched', () => {
    expect(rescaleHardStopState(1000, 1000, 1.0, 0.9)).toEqual({ lastSol: 1.0, baseSol: 0.9, rescaled: false });
    expect(rescaleHardStopState(undefined, 1000, undefined, undefined)).toEqual({ lastSol: undefined, baseSol: undefined, rescaled: false });
    expect(rescaleHardStopState(0, 1000, 1.0, 1.0).rescaled).toBe(false);
    expect(rescaleHardStopState(NaN, 1000, 1.0, 1.0).rescaled).toBe(false);
    expect(rescaleHardStopState(1000, 0, 1.0, 1.0).rescaled).toBe(false);
    expect(rescaleHardStopState(1000, NaN, 1.0, 1.0).rescaled).toBe(false);
  });

  it('keeps a missing stored value missing', () => {
    const rs = rescaleHardStopState(1000, 500, undefined, 1.0);
    expect(rs.lastSol).toBeUndefined();
    expect(rs.baseSol).toBeCloseTo(0.5, 12);
  });
});

// (the re-export shim `bot/order-triggers.ts` and its test case were removed by R4-B6: bot.ts no longer imports it)

// ---------------------------------------------------------------------------------------------------------------------------------
// evaluateManual against a reference copy of the old lanes
// ---------------------------------------------------------------------------------------------------------------------------------

function order(o: Partial<StoredManualOrder> & Pick<StoredManualOrder, 'type' | 'trigger_pct'>): StoredManualOrder {
  return { order_id: 'o1', position_id: 'p1', ca: 'ca', wallet_id: 'w1', baseline_multi: null, peak_rel: null, expires_at: null, active: true,
    attempts: 0, created_at: 1, source: 'migrated', ...o };
}

/** The order lane of `runOrderMonitorPass` (bot.ts 3033-3056), reduced to the decision. */
function oldOrderLane(o: { type: string; triggerPct: number; armAfterPct?: number | null; highestMultiplier: number; baselineMulti?: number }, multi: number) {
  let baseMulti = Number(o.baselineMulti);
  if (!Number.isFinite(baseMulti) || baseMulti <= 0) baseMulti = multi;
  const rel = multi / baseMulti;
  let triggered = false;
  let high = o.highestMultiplier;
  if (o.type === 'tp') triggered = (rel - 1) * 100 >= o.triggerPct;
  if (o.type === 'sl') triggered = (rel - 1) * 100 <= o.triggerPct;
  if (o.type === 'tsl') {
    const tsl = evaluateTsl(o, rel);
    high = tsl.newHighestMultiplier;
    triggered = tsl.triggered;
  }
  return { triggered, baseMulti, high };
}

const T0 = 1_800_000_000_000;
const PRICE_AT_ENTRY = 0.05 / 1e9;   // SOL per atom: a 0.05 SOL buy of 1e9 atoms

describe('evaluateManual', () => {
  it('B3-T10 manual positions decide exactly as today: order lane (TP / SL / TSL, baseline-relative), the -25% floor and the hard-rug check', () => {
    // --- order lane: sweep the multiple (curSol / entrySol) and compare every verdict with the old inline code ---
    // The path goes up (arming a trail, passing a TP), gives some back (a TSL fires), and falls through the SL levels. No value sits on a
    // threshold, so a one-ulp difference between the two computations cannot flip a verdict.
    const sweep = [1.03, 1.43, 1.37, 1.29, 1.62, 1.21, 0.97, 0.52, 0.31];
    for (const baselineMulti of [undefined, 0.8, 0.5]) {
      for (const spec of [
        { type: 'tp' as const, triggerPct: 100 }, { type: 'tp' as const, triggerPct: 20 },
        { type: 'sl' as const, triggerPct: -20 }, { type: 'sl' as const, triggerPct: -5 },
        { type: 'tsl' as const, triggerPct: -10 }, { type: 'tsl' as const, triggerPct: -25, armAfterPct: 50 },
      ]) {
        // A stateful walk: each step feeds the persisted baseline and peak back in, as the old lane did.
        let baseline = baselineMulti ?? null;
        let peak: number | null = null;
        let oldHigh = 1;
        let oldBase = baselineMulti;
        for (const multi of sweep) {
          const old = oldOrderLane({ ...spec, highestMultiplier: oldHigh, baselineMulti: oldBase }, multi);
          const ev = evaluateManual({
            basis: PRICE_AT_ENTRY, floorBase: PRICE_AT_ENTRY * 100, prev: null, now: T0, hardRugDropPct: 0, allowTp: true, caLocked: false,
            quote: { price: PRICE_AT_ENTRY * multi, at: T0, src: 'onchain' },
            orders: [order({ type: spec.type, trigger_pct: spec.triggerPct, arm_after_pct: spec.armAfterPct ?? null, baseline_multi: baseline, peak_rel: peak })],
          });
          const o = ev.orders[0];
          expect(o.verdict === 'fired', `${spec.type} ${spec.triggerPct} baseline ${baselineMulti} multi ${multi}`).toBe(old.triggered);
          baseline = o.patch.baseline_multi ?? baseline;
          if (o.patch.peak_rel !== undefined) peak = o.patch.peak_rel;
          oldBase = old.baseMulti;
          oldHigh = old.high;
          if (spec.type === 'tsl') expect(peak ?? 1).toBeCloseTo(oldHigh, 12);
        }
      }
    }

    // --- hard-stop lane: the -25% floor from the first evaluated quote, and a >= 40% drop between consecutive quotes ---
    const floorBase = PRICE_AT_ENTRY * 0.7;   // the first evaluated quote was already below entry (friction): the floor is relative to IT
    const at = (mult: number, prev: number | null) => evaluateManual({
      basis: PRICE_AT_ENTRY, floorBase, prev: prev === null ? null : { price: floorBase * prev, at: T0 - 7_500, src: 'jupiter' }, orders: [], now: T0,
      hardRugDropPct: 40, allowTp: true, caLocked: false, quote: { price: floorBase * mult, at: T0, src: 'jupiter' },
    }).emergency;
    expect(at(0.8, null)).toBeNull();                       // -20% from the first quote: above the floor
    expect(at(0.751, null)).toBeNull();                     // -24.9%
    expect(at(0.749, null)?.reason).toBe('floor');          // -25.1% fires, like pnlPct <= STOP_LOSS_PCT
    expect(at(0.5, null)?.reason).toBe('floor');
    expect(at(1.4, 2.4)?.reason).toBe('rug');               // still +40% over the anchor but down 41.7% in one tick: a pumped token rugging
    expect(at(1.5, 2.4)).toBeNull();                        // down 37.5%: not a rug, above the floor
    expect(MANUAL_FLOOR_PCT).toBe(-25);
    // The old lane's own detector decides the same number:
    expect(detectHardRug(2.4, 1.4, 40).isRug).toBe(true);
    expect(detectHardRug(2.4, 1.5, 40).isRug).toBe(false);
  });

  it('takes the basis and the floor anchor from the first quote, and baselines an order at its first evaluated multiple', () => {
    const ev = evaluateManual({
      basis: null, floorBase: null, prev: null, now: T0, hardRugDropPct: 40, allowTp: true, caLocked: false,
      quote: { price: 7e-9, at: T0, src: 'onchain' }, orders: [order({ type: 'sl', trigger_pct: -10 }), order({ order_id: 'o2', type: 'tp', trigger_pct: 100 })],
    });
    expect(ev.positionPatch).toEqual({ basis_sol_per_token: 7e-9, floor_base: 7e-9 });
    expect(ev.multi).toBe(1);
    expect(ev.orders.map(o => o.patch.baseline_multi)).toEqual([1, 1]);
    expect(ev.emergency).toBeNull();
    expect(ev.orders.every(o => o.verdict === 'idle')).toBe(true);
  });

  it('a migrated position keeps its entry basis, and an order keeps its copied baseline_multi (never reset to a preset)', () => {
    const ev = evaluateManual({
      basis: PRICE_AT_ENTRY, floorBase: null, prev: null, now: T0, hardRugDropPct: 40, allowTp: true, caLocked: false,
      quote: { price: PRICE_AT_ENTRY * 0.8, at: T0, src: 'onchain' }, orders: [order({ type: 'sl', trigger_pct: -20, baseline_multi: 0.8 })],
    });
    expect(ev.positionPatch.basis_sol_per_token).toBeUndefined();
    expect(ev.positionPatch.floor_base).toBe(PRICE_AT_ENTRY * 0.8);
    expect(ev.orders[0].patch.baseline_multi).toBeUndefined();
    expect(ev.orders[0].relPct).toBeCloseTo(0, 9);
    expect(ev.orders[0].verdict).toBe('idle');
  });

  it('a TP is not judged on a quote that is not executable truth, and is blocked (deactivated) by the per-CA lock; SL and TSL never are', () => {
    const quote = { price: PRICE_AT_ENTRY * 3, at: T0, src: 'engine_gmgn' };
    const tp = order({ type: 'tp', trigger_pct: 100, baseline_multi: 1 });
    const common = { basis: PRICE_AT_ENTRY, floorBase: PRICE_AT_ENTRY, prev: null, now: T0, hardRugDropPct: 0, orders: [tp] };
    expect(evaluateManual({ ...common, quote, allowTp: false, caLocked: false }).orders[0].verdict).toBe('skipped_quote');
    const locked = evaluateManual({ ...common, quote: { ...quote, src: 'onchain' }, allowTp: true, caLocked: true }).orders[0];
    expect(locked.verdict).toBe('blocked_ca_lock');
    expect(locked.patch).toMatchObject({ active: false, deactivated_reason: 'ca-locked' });
    const sl = order({ type: 'sl', trigger_pct: -20, baseline_multi: 1 });
    const falling = { price: PRICE_AT_ENTRY * 0.5, at: T0, src: 'onchain' };
    expect(evaluateManual({ ...common, orders: [sl], quote: falling, allowTp: true, caLocked: true }).orders[0].verdict).toBe('fired');
    const tsl = order({ type: 'tsl', trigger_pct: -10, baseline_multi: 1, peak_rel: 3 });
    expect(evaluateManual({ ...common, orders: [tsl], quote: falling, allowTp: true, caLocked: true }).orders[0].verdict).toBe('fired');
  });

  it('an expired order is switched off and never fires; inactive orders are ignored', () => {
    const ev = evaluateManual({
      basis: PRICE_AT_ENTRY, floorBase: PRICE_AT_ENTRY, prev: null, now: T0, hardRugDropPct: 0, allowTp: true, caLocked: false,
      quote: { price: PRICE_AT_ENTRY * 5, at: T0, src: 'onchain' },
      orders: [order({ type: 'tp', trigger_pct: 10, baseline_multi: 1, expires_at: T0 - 1 }), order({ order_id: 'o2', type: 'tp', trigger_pct: 10, baseline_multi: 1, active: false })],
    });
    expect(ev.orders).toHaveLength(1);
    expect(ev.orders[0]).toMatchObject({ verdict: 'expired', patch: { active: false, deactivated_reason: 'expired' } });
  });

  it('the hard-rug check needs two quotes of the same source close together; otherwise only the floor judges', () => {
    const base = { basis: PRICE_AT_ENTRY, floorBase: PRICE_AT_ENTRY * 0.1, orders: [], now: T0, hardRugDropPct: 40, allowTp: true, caLocked: false };
    const q = { price: PRICE_AT_ENTRY * 0.5, at: T0, src: 'onchain' };
    const prev = (over: Partial<{ price: number; at: number; src: string }>) => ({ price: PRICE_AT_ENTRY * 1.0, at: T0 - 10_000, src: 'onchain', ...over });
    expect(evaluateManual({ ...base, quote: q, prev: prev({}) }).emergency?.reason).toBe('rug');
    expect(evaluateManual({ ...base, quote: q, prev: prev({ src: 'jupiter' }) }).emergency).toBeNull();
    expect(evaluateManual({ ...base, quote: q, prev: prev({ at: T0 - MANUAL_R0_MAX_GAP_MS - 1 }) }).emergency).toBeNull();
    expect(evaluateManual({ ...base, quote: q, prev: prev({ at: T0 - MANUAL_R0_MAX_GAP_MS }) }).emergency?.reason).toBe('rug');
    expect(evaluateManual({ ...base, quote: q, prev: null }).emergency).toBeNull();
  });

  it('an unusable quote judges nothing', () => {
    for (const price of [NaN, -1, Infinity]) {
      const ev = evaluateManual({ basis: 1e-9, floorBase: 1e-9, prev: null, orders: [order({ type: 'sl', trigger_pct: -5, baseline_multi: 1 })], now: T0,
        hardRugDropPct: 40, allowTp: true, caLocked: false, quote: { price, at: T0, src: 'onchain' } });
      expect(ev.emergency).toBeNull();
      expect(ev.orders).toEqual([]);
    }
    // A zero quote cannot become the basis of a position that has none.
    const zero = evaluateManual({ basis: null, floorBase: null, prev: null, orders: [], now: T0, hardRugDropPct: 40, allowTp: true, caLocked: false,
      quote: { price: 0, at: T0, src: 'onchain' } });
    expect(Number.isNaN(zero.multi)).toBe(true);
  });

  it('runs the protective orders before the take-profits, the take-profits by ascending trigger; a missing sell_pct means 100', () => {
    const fired = [
      order({ order_id: 'a', type: 'tp', trigger_pct: 200, created_at: 1 }), order({ order_id: 'b', type: 'tsl', trigger_pct: -10, created_at: 2 }),
      order({ order_id: 'c', type: 'tp', trigger_pct: 50, created_at: 3 }), order({ order_id: 'd', type: 'sl', trigger_pct: -10, created_at: 0 }),
    ];
    expect(executionOrder(fired).map(o => o.order_id)).toEqual(['d', 'b', 'c', 'a']);
    expect(sellPctOf({})).toBe(100);
    expect(sellPctOf({ sell_pct: 35 })).toBe(35);
    expect(sellPctOf({ sell_pct: 0 })).toBe(100);
    expect(sellPctOf({ sell_pct: 250 })).toBe(100);
  });
});
