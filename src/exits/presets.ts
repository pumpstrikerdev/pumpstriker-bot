/**
 * presets.ts (A-115, CARD-MENU spec section 6): the owner's per-grade exit presets (the old bot's per-tier TP / SL / TSL orders, now per
 * signal grade A / B / C) and how they become an exit policy for the owner's REAL positions.
 *
 *   - A preset is `{ mode: 'policy' }` (the DEFAULT: follow the active exit policy, whatever version is loaded) or a `custom` preset:
 *     a stop, a take-profit ladder of 0-3 rungs, an optional trailing stop and an optional max hold.
 *   - presetToPolicy() turns a custom preset into the legs the unchanged shared evaluateExit runs (R0 always copied from the active policy,
 *     then S, TP1-TP3, T, H) and versions it like loadPolicies does. Every check of loadPolicies runs again here, so a broken preset can
 *     never reach the exit engine.
 *   - Money safety (spec 6.4): a stop is never removed implicitly. The only stop-less preset is one whose `stop` is `{ none: true,
 *     confirmedAt }` (the owner's confirmed "No stop"); presetToPolicy refuses a stop-less preset without `confirmedAt`, and the hard-rug
 *     leg R0 always stays. Ladders hold at most 3 rungs, strictly increasing triggers, and sell at most 100% of the original in total.
 *   - A position keeps the plan it was opened with: the resolved plan is a snapshot (`ExitPlanSnapshot`) stored on the position.
 *   - The trigger kind of a rung (Entry Price % / Price % / Market Cap %) is display only: the old bot evaluated all three on the same
 *     entry-relative multiple, and with a fixed supply the market cap moves exactly with the price. The basis is the first quote after
 *     the fill, as for EA.
 *
 * Pure: no clock (callers pass `now`), no I/O.
 */
import type { Grade } from '../shared/common/ids';
import { policyVersion, type LegId, type LegSpec, type ResolvedPolicy } from '../shared/exit-policy/exit-policy';
import type { PlaybookV1 } from '../shared/card/playbook';

export type TriggerKind = 'entryPrice' | 'price' | 'mcap';
export const TRIGGER_KINDS: readonly TriggerKind[] = ['entryPrice', 'price', 'mcap'];
export interface PresetRung { atPct: number; sellPctOfOriginal: number; trigger: TriggerKind }
export interface PresetTrail { armAfterPct: number; trailPct: number; trigger: TriggerKind }
export type PresetStop = { lossPct: number; whilePeakBelowPct: number | null } | { none: true; confirmedAt: number };
export interface CustomPreset {
  mode: 'custom'; rev: number; enabled: boolean;
  /** 'owner' or `imported:<old tier id>`. */
  source: string;
  updatedAt: number;
  stop: PresetStop;
  ladder: PresetRung[];
  trail: PresetTrail | null;
  maxHoldH: number | null;
}
export type GradePreset = { mode: 'policy' } | CustomPreset;
export type GradePresets = Record<Grade, GradePreset>;
export const GRADES: readonly Grade[] = ['A', 'B', 'C'];

/** An exit policy the exit engine can run: a loaded one (EA ...) or a preset turned into legs (id PRESET-<grade>). */
export interface PlanPolicy { id: string; version: string; legs: LegSpec[]; order: LegId[]; closeAccountOnFullExit: boolean }
/** The plan a position was opened with (spec 6.3). `source: 'policy'` is used for a card buy that follows the active policy. */
export interface ExitPlanSnapshot { source: 'preset' | 'policy'; grade: Grade; rev: number | null; policy: PlanPolicy }

export const MAX_RUNGS = 3;
export const MAX_TP_PCT = 100_000;
export const STOP_MIN_PCT = 1;
export const STOP_MAX_PCT = 95;
export const ARM_MAX_PCT = 10_000;
export const TRAIL_MIN_PCT = 1;
export const TRAIL_MAX_PCT = 95;
export const MAX_HOLD_MAX_H = 168;
const EPS = 1e-9;
const ORDER: readonly LegId[] = ['R0', 'S', 'TP1', 'TP2', 'TP3', 'T', 'H'];
const TP_IDS: readonly LegId[] = ['TP1', 'TP2', 'TP3'];

export const defaultGradePresets = (): GradePresets => ({ A: { mode: 'policy' }, B: { mode: 'policy' }, C: { mode: 'policy' } });
export const isCustom = (p: GradePreset | null | undefined): p is CustomPreset => p !== null && p !== undefined && p.mode === 'custom';
export const hasNoStop = (s: PresetStop): s is { none: true; confirmedAt: number } => (s as { none?: unknown }).none === true;
export const presetPolicyId = (g: Grade): string => `PRESET-${g}`;

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Float noise off a percentage derived from a multiple ((1 - 0.62) * 100 = 38.000000000000004 -> 38). */
const tidy = (x: number): number => Math.round(x * 1e6) / 1e6;

// ---------------------------------------------------------------------------------------------------------------------------------
// validation (input, load and presetToPolicy all use it)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Why a ladder is not acceptable, or null: at most 3 rungs, triggers in (0, 100000] strictly increasing, sells in (0, 100], sum <= 100. */
export function ladderProblem(ladder: readonly PresetRung[]): string | null {
  if (ladder.length > MAX_RUNGS) return `A preset holds at most ${MAX_RUNGS} take-profits.`;
  let prev = 0;
  let sum = 0;
  for (const r of ladder) {
    if (!fin(r.atPct) || r.atPct <= 0 || r.atPct > MAX_TP_PCT) return 'Enter a positive % (100 = 2×).';
    if (r.atPct <= prev) return 'Take-profit triggers must be different and increasing.';
    if (!fin(r.sellPctOfOriginal) || r.sellPctOfOriginal <= 0 || r.sellPctOfOriginal > 100) return 'A take-profit sells 1-100% of the position.';
    if (!TRIGGER_KINDS.includes(r.trigger)) return 'Unknown trigger type.';
    prev = r.atPct;
    sum += r.sellPctOfOriginal;
  }
  if (sum > 100 + EPS) return `The take-profits would sell ${tidy(sum)}% of the position (max 100%).`;
  return null;
}

/** Why a custom preset is not acceptable, or null. */
export function presetProblem(p: CustomPreset): string | null {
  if (p.mode !== 'custom') return 'not a custom preset';
  if (!Number.isSafeInteger(p.rev) || p.rev < 1) return 'rev must be a positive integer';
  if (typeof p.enabled !== 'boolean') return 'enabled must be a boolean';
  if (typeof p.source !== 'string' || p.source === '' || p.source.length > 64) return 'source must be a short string';
  if (!fin(p.updatedAt) || p.updatedAt < 0) return 'updatedAt must be a time';
  if (typeof p.stop !== 'object' || p.stop === null) return 'stop missing';
  if (hasNoStop(p.stop)) {
    if (!fin(p.stop.confirmedAt) || p.stop.confirmedAt <= 0) return 'a preset without a stop needs the owner\'s confirmation';
  } else {
    const s = p.stop as { lossPct: unknown; whilePeakBelowPct: unknown };
    if (!fin(s.lossPct) || s.lossPct < STOP_MIN_PCT || s.lossPct > STOP_MAX_PCT) return `Enter the loss in % from ${STOP_MIN_PCT} to ${STOP_MAX_PCT} (30 = sell all at −30%).`;
    if (s.whilePeakBelowPct !== null && (!fin(s.whilePeakBelowPct) || s.whilePeakBelowPct <= 0)) return 'the stop condition must be a positive % or none';
  }
  if (!Array.isArray(p.ladder)) return 'ladder must be a list';
  const lp = ladderProblem(p.ladder);
  if (lp !== null) return lp;
  if (p.trail !== null) {
    const t = p.trail;
    if (typeof t !== 'object' || !fin(t.armAfterPct) || t.armAfterPct < 0 || t.armAfterPct > ARM_MAX_PCT) return `Arm after must be from 0 to ${ARM_MAX_PCT}%.`;
    if (!fin(t.trailPct) || t.trailPct < TRAIL_MIN_PCT || t.trailPct > TRAIL_MAX_PCT) return `The trail must be from ${TRAIL_MIN_PCT} to ${TRAIL_MAX_PCT}% under the peak.`;
    if (!TRIGGER_KINDS.includes(t.trigger)) return 'Unknown trigger type.';
  }
  if (p.maxHoldH !== null && (!Number.isSafeInteger(p.maxHoldH) || p.maxHoldH < 1 || p.maxHoldH > MAX_HOLD_MAX_H)) return `Max hold must be 1-${MAX_HOLD_MAX_H} hours, or none.`;
  return null;
}

/** A preset read from a (possibly hand-edited) settings file: a valid custom preset as it is, anything else the policy default (which has
 *  a stop) with a warning. Never throws, never loosens. */
export function normalizeGradePreset(raw: unknown, warn: (m: string) => void, where: string): GradePreset {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { if (raw !== undefined) warn(`${where}: not a preset; the exit policy is used`); return { mode: 'policy' }; }
  const r = raw as Record<string, unknown>;
  if (r.mode === 'policy') return { mode: 'policy' };
  if (r.mode !== 'custom') { warn(`${where}: unknown mode; the exit policy is used`); return { mode: 'policy' }; }
  const stopRaw = r.stop as Record<string, unknown> | null | undefined;
  const stop: PresetStop | null = stopRaw && typeof stopRaw === 'object'
    ? (stopRaw.none === true ? { none: true, confirmedAt: stopRaw.confirmedAt as number }
      : { lossPct: stopRaw.lossPct as number, whilePeakBelowPct: stopRaw.whilePeakBelowPct === undefined ? null : stopRaw.whilePeakBelowPct as number | null })
    : null;
  const ladder = Array.isArray(r.ladder) ? r.ladder.map(x => {
    const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
    return { atPct: o.atPct as number, sellPctOfOriginal: o.sellPctOfOriginal as number, trigger: (o.trigger ?? 'entryPrice') as TriggerKind };
  }) : null;
  const tr = r.trail as Record<string, unknown> | null | undefined;
  const trail: PresetTrail | null = tr && typeof tr === 'object'
    ? { armAfterPct: tr.armAfterPct as number, trailPct: tr.trailPct as number, trigger: (tr.trigger ?? 'entryPrice') as TriggerKind } : null;
  if (stop === null || ladder === null) { warn(`${where}: the stop or the ladder is missing; the exit policy is used`); return { mode: 'policy' }; }
  const p: CustomPreset = {
    mode: 'custom', rev: r.rev as number, enabled: r.enabled as boolean, source: r.source as string, updatedAt: r.updatedAt as number,
    stop, ladder, trail, maxHoldH: r.maxHoldH === undefined ? null : r.maxHoldH as number | null,
  };
  const why = presetProblem(p);
  if (why !== null) { warn(`${where}: ${why}; the exit policy is used`); return { mode: 'policy' }; }
  return p;
}

export function normalizeGradePresets(raw: unknown, warn: (m: string) => void): GradePresets {
  const r = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (raw !== undefined && raw !== null && r !== raw) warn('signal.gradePresets is not an object; the exit policy is used for every grade');
  return { A: normalizeGradePreset(r.A, warn, 'gradePresets.A'), B: normalizeGradePreset(r.B, warn, 'gradePresets.B'), C: normalizeGradePreset(r.C, warn, 'gradePresets.C') };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// preset -> legs
// ---------------------------------------------------------------------------------------------------------------------------------

function checkLegs(legs: readonly LegSpec[]): void {
  const pos = (n: number | undefined): boolean => n !== undefined && Number.isFinite(n) && n > 0;
  for (const l of legs) {
    switch (l.kind) {
      case 'hard_rug': if (!pos(l.dropPct) || (l.dropPct as number) > 100 || !pos(l.maxGapS)) throw new RangeError('presetToPolicy: bad R0'); break;
      case 'rug_stop': if (!pos(l.atMultiple) || (l.atMultiple as number) >= 1 || !pos(l.whilePeakBelow)) throw new RangeError('presetToPolicy: bad stop'); break;
      case 'take_profit':
        if (!pos(l.atMultiple) || (l.atMultiple as number) <= 1 || !pos(l.sellFractionOfOriginal) || (l.sellFractionOfOriginal as number) > 1) throw new RangeError('presetToPolicy: bad take-profit');
        break;
      case 'trail':
        if (!pos(l.armPeakMultiple) || !pos(l.exitAtPeakFraction) || (l.exitAtPeakFraction as number) >= 1) throw new RangeError('presetToPolicy: bad trail');
        break;
      case 'max_hold': if (!pos(l.afterMs)) throw new RangeError('presetToPolicy: bad max hold'); break;
      default: throw new RangeError(`presetToPolicy: a preset has no ${l.kind} leg`);
    }
  }
  const tpSum = legs.filter(l => l.kind === 'take_profit').reduce((a, l) => a + (l.sellFractionOfOriginal as number), 0);
  if (tpSum > 1 + EPS) throw new RangeError('presetToPolicy: take-profit fractions add up to more than 1');
}

/** The exit policy of a custom preset (spec 6.2). Throws RangeError on a preset that is not valid, or a stop-less preset that the owner did
 *  not confirm; R0 is always copied from the active policy. */
export function presetToPolicy(p: CustomPreset, active: Pick<ResolvedPolicy, 'legs' | 'closeAccountOnFullExit'>, grade: Grade): PlanPolicy {
  const why = presetProblem(p);
  if (why !== null) throw new RangeError(`presetToPolicy: ${why}`);
  const legs: LegSpec[] = [];
  const r0 = active.legs.find(l => l.id === 'R0' && l.kind === 'hard_rug');
  if (r0 === undefined) throw new RangeError('presetToPolicy: the active policy has no hard-rug leg R0');
  legs.push({ ...r0 });
  if (!hasNoStop(p.stop)) {
    const s = p.stop as { lossPct: number; whilePeakBelowPct: number | null };
    legs.push({ id: 'S', kind: 'rug_stop', protective: true, atMultiple: tidy(1 - s.lossPct / 100),
      whilePeakBelow: s.whilePeakBelowPct === null ? Number.MAX_VALUE : tidy(1 + s.whilePeakBelowPct / 100) });
  } else if (!(p.stop.confirmedAt > 0)) {
    throw new RangeError('presetToPolicy: a preset without a stop needs the owner\'s confirmation');
  }
  [...p.ladder].sort((a, b) => a.atPct - b.atPct).forEach((r, i) => {
    legs.push({ id: TP_IDS[i], kind: 'take_profit', protective: false, atMultiple: tidy(1 + r.atPct / 100), sellFractionOfOriginal: tidy(r.sellPctOfOriginal / 100) });
  });
  if (p.trail !== null) {
    legs.push({ id: 'T', kind: 'trail', protective: true, armPeakMultiple: tidy(1 + p.trail.armAfterPct / 100), exitAtPeakFraction: tidy(1 - p.trail.trailPct / 100) });
  }
  if (p.maxHoldH !== null) legs.push({ id: 'H', kind: 'max_hold', protective: true, afterMs: p.maxHoldH * 3_600_000 });
  checkLegs(legs);
  const order = ORDER.filter(id => legs.some(l => l.id === id));
  const id = presetPolicyId(grade);
  const unversioned = { id, legs, order, closeAccountOnFullExit: active.closeAccountOnFullExit };
  return { ...unversioned, version: policyVersion(unversioned as unknown as Omit<ResolvedPolicy, 'version'>) };
}

/** A copy of a loaded policy as a plan policy (the legs are copied, so the snapshot never shares objects with the loaded file). */
export function policyAsPlan(p: Pick<ResolvedPolicy, 'id' | 'version' | 'legs' | 'order' | 'closeAccountOnFullExit'>): PlanPolicy {
  return { id: p.id, version: p.version, legs: p.legs.map(l => ({ ...l })), order: [...p.order], closeAccountOnFullExit: p.closeAccountOnFullExit };
}

/** The first edit of a `policy` preset copies the active policy's legs (S with its condition, TP1-3, T, H) as custom rev 1. */
export function materialize(active: Pick<ResolvedPolicy, 'legs'>, now: number): CustomPreset {
  const s = active.legs.find(l => l.kind === 'rug_stop');
  const stop: PresetStop = s !== undefined && s.atMultiple !== undefined
    ? { lossPct: tidy((1 - s.atMultiple) * 100), whilePeakBelowPct: s.whilePeakBelow === undefined || s.whilePeakBelow >= 1e9 ? null : tidy((s.whilePeakBelow - 1) * 100) }
    : { lossPct: 35, whilePeakBelowPct: null };
  const ladder: PresetRung[] = active.legs.filter(l => l.kind === 'take_profit' && l.atMultiple !== undefined && l.sellFractionOfOriginal !== undefined)
    .sort((a, b) => (a.atMultiple as number) - (b.atMultiple as number)).slice(0, MAX_RUNGS)
    .map(l => ({ atPct: tidy(((l.atMultiple as number) - 1) * 100), sellPctOfOriginal: tidy((l.sellFractionOfOriginal as number) * 100), trigger: 'entryPrice' as const }));
  const t = active.legs.find(l => l.kind === 'trail');
  const trail: PresetTrail | null = t !== undefined && t.armPeakMultiple !== undefined && t.exitAtPeakFraction !== undefined
    ? { armAfterPct: tidy(Math.max(0, (t.armPeakMultiple - 1) * 100)), trailPct: tidy((1 - t.exitAtPeakFraction) * 100), trigger: 'entryPrice' } : null;
  const h = active.legs.find(l => l.kind === 'max_hold');
  const hours = h !== undefined && h.afterMs !== undefined ? h.afterMs / 3_600_000 : null;
  return {
    mode: 'custom', rev: 1, enabled: true, source: 'owner', updatedAt: now, stop, ladder, trail,
    maxHoldH: hours !== null && Number.isSafeInteger(hours) && hours >= 1 && hours <= MAX_HOLD_MAX_H ? hours : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// edits (each returns the next preset, rev + 1, or the refusal text)
// ---------------------------------------------------------------------------------------------------------------------------------

export type EditResult = { ok: true; preset: CustomPreset } | { ok: false; reason: string };

/** Applies `fn` to the custom form of `cur` (a `policy` preset is materialised first), bumps rev and validates the result. */
export function editPreset(cur: GradePreset, active: Pick<ResolvedPolicy, 'legs'>, now: number, fn: (c: CustomPreset) => CustomPreset | string): EditResult {
  const base = isCustom(cur) ? cur : materialize(active, now);
  const out = fn({ ...base, ladder: base.ladder.map(r => ({ ...r })), trail: base.trail === null ? null : { ...base.trail }, stop: { ...base.stop } as PresetStop });
  if (typeof out === 'string') return { ok: false, reason: out };
  const next: CustomPreset = { ...out, rev: isCustom(cur) ? cur.rev + 1 : 1, updatedAt: now, source: 'owner' };
  const why = presetProblem(next);
  return why === null ? { ok: true, preset: next } : { ok: false, reason: why };
}

export const addRung = (r: PresetRung) => (c: CustomPreset): CustomPreset | string => {
  if (c.ladder.length >= MAX_RUNGS) return `A preset holds at most ${MAX_RUNGS} take-profits.`;
  if (c.ladder.some(x => Math.abs(x.atPct - r.atPct) < EPS)) return `There is already a take-profit at +${tidy(r.atPct)}%.`;
  const ladder = [...c.ladder, r].sort((a, b) => a.atPct - b.atPct);
  const sum = ladder.reduce((a, x) => a + x.sellPctOfOriginal, 0);
  if (sum > 100 + EPS) return `The take-profits would sell ${tidy(sum)}% of the position (max 100%).`;
  return { ...c, ladder };
};
export const setStop = (lossPct: number) => (c: CustomPreset): CustomPreset => ({ ...c, stop: { lossPct, whilePeakBelowPct: null } });
export const setTrail = (t: PresetTrail) => (c: CustomPreset): CustomPreset => ({ ...c, trail: t });
export const setMaxHold = (h: number | null) => (c: CustomPreset): CustomPreset => ({ ...c, maxHoldH: h });
export const setNoStop = (confirmedAt: number) => (c: CustomPreset): CustomPreset => ({ ...c, stop: { none: true, confirmedAt } });
export const toggleEnabled = (c: CustomPreset): CustomPreset => ({ ...c, enabled: !c.enabled });
/** Clear All: the ladder, the trail and the max hold go; the stop stays (spec 6.4 rule 1). */
export const clearAll = (c: CustomPreset): CustomPreset => ({ ...c, ladder: [], trail: null, maxHoldH: null });

/** The removable items of a preset in display order (the stop first). */
export type PresetItem = { kind: 'sl' } | { kind: 'tp'; index: number } | { kind: 'tsl' } | { kind: 'hold' };
export function presetItems(c: CustomPreset): PresetItem[] {
  const out: PresetItem[] = [];
  if (!hasNoStop(c.stop)) out.push({ kind: 'sl' });
  c.ladder.forEach((_, index) => out.push({ kind: 'tp', index }));
  if (c.trail !== null) out.push({ kind: 'tsl' });
  if (c.maxHoldH !== null) out.push({ kind: 'hold' });
  return out;
}
/** Removes item `i` of presetItems(); removing the stop is refused (only "No stop" with its confirmation removes it). */
export const removeItem = (i: number) => (c: CustomPreset): CustomPreset | string => {
  const it = presetItems(c)[i];
  if (it === undefined) return 'That order is no longer there.';
  if (it.kind === 'sl') return 'The stop-loss cannot be removed here. Set a different stop, or use 🚫 No stop… (it asks you to confirm).';
  if (it.kind === 'tp') return { ...c, ladder: c.ladder.filter((_, j) => j !== it.index) };
  if (it.kind === 'tsl') return { ...c, trail: null };
  return { ...c, maxHoldH: null };
};

const fmtP = (x: number): string => String(tidy(x));
/** One line per item, for the menus and the import summary. */
export function itemText(c: CustomPreset, it: PresetItem): string {
  switch (it.kind) {
    case 'sl': { const s = c.stop as { lossPct: number; whilePeakBelowPct: number | null }; return `🛑 SL −${fmtP(s.lossPct)}%${s.whilePeakBelowPct === null ? '' : ` while the peak is below +${fmtP(s.whilePeakBelowPct)}%`}`; }
    case 'tp': { const r = c.ladder[it.index]; return `🎯 TP +${fmtP(r.atPct)}% → sell ${fmtP(r.sellPctOfOriginal)}%`; }
    case 'tsl': { const t = c.trail as PresetTrail; return `📉 TSL −${fmtP(t.trailPct)}% from the peak${t.armAfterPct > 0 ? ` once +${fmtP(t.armAfterPct)}%` : ''}`; }
    case 'hold': return `⏳ Max hold ${c.maxHoldH}h`;
  }
}
/** "stop −35% · sell 25% at +80% · 26.25% at +400% · trail −40% once +200%" (the import summary form). */
export function presetSummary(c: CustomPreset): string {
  const parts: string[] = [];
  if (hasNoStop(c.stop)) parts.push('NO stop'); else parts.push(`stop −${fmtP((c.stop as { lossPct: number }).lossPct)}%`);
  c.ladder.forEach((r, i) => parts.push(`${i === 0 ? 'sell ' : ''}${fmtP(r.sellPctOfOriginal)}% at +${fmtP(r.atPct)}%`));
  if (c.trail !== null) parts.push(`trail −${fmtP(c.trail.trailPct)}%${c.trail.armAfterPct > 0 ? ` once +${fmtP(c.trail.armAfterPct)}%` : ''}`);
  if (c.maxHoldH !== null) parts.push(`max hold ${c.maxHoldH}h`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// which plan a buy gets (spec 6.3)
// ---------------------------------------------------------------------------------------------------------------------------------

export interface PresetSettings { autoSellOnSignal: boolean; gradePresets: GradePresets }
export type ActivePolicy = Pick<ResolvedPolicy, 'id' | 'version' | 'legs' | 'order' | 'closeAccountOnFullExit'>;

/**
 * The plan of a REAL buy from a card of grade `grade` now: the grade preset when Auto-Sell by Grade is on and the preset is custom and
 * enabled (snapshot source 'preset'), else no snapshot (the active policy exactly as before A-115). The playbook is what the card shows.
 */
export function resolvePlan(s: PresetSettings, grade: Grade, active: ActivePolicy, warn: (m: string) => void = () => undefined): { snapshot: ExitPlanSnapshot | null; playbook: PlaybookV1 } {
  const preset = s.gradePresets[grade];
  if (s.autoSellOnSignal && isCustom(preset) && preset.enabled) {
    try {
      const policy = presetToPolicy(preset, active, grade);
      return {
        snapshot: { source: 'preset', grade, rev: preset.rev, policy },
        playbook: { source: 'preset', grade, policyId: policy.id, version: policy.version, rev: preset.rev, legs: policy.legs },
      };
    } catch (e) {
      warn(`grade-${grade} preset cannot be used (${e instanceof Error ? e.message : String(e)}); the exit policy ${active.id} applies`);
    }
  }
  const presetState: PlaybookV1['presetState'] = !s.autoSellOnSignal ? 'auto-sell-off' : isCustom(preset) && !preset.enabled ? 'preset-off' : 'follows';
  return { snapshot: null, playbook: { source: 'policy', grade, policyId: active.id, version: active.version, rev: null, legs: active.legs.map(l => ({ ...l })), presetState } };
}

/** The snapshot a card buy (sbuy) stores: the preset plan, or the active policy (a card buy always runs a plan, never the manual path). */
export function cardBuyPlan(s: PresetSettings, grade: Grade, active: ActivePolicy, warn?: (m: string) => void): ExitPlanSnapshot {
  const r = resolvePlan(s, grade, active, warn);
  return r.snapshot ?? { source: 'policy', grade, rev: null, policy: policyAsPlan(active) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the snapshot on a position (positions store, pending-buys journal, manual-buy journal)
// ---------------------------------------------------------------------------------------------------------------------------------

const LEG_IDS: readonly string[] = ['R0', 'S', 'TP1', 'TP2', 'TP3', 'T', 'H', 'C1'];
const KINDS: readonly string[] = ['hard_rug', 'rug_stop', 'take_profit', 'trail', 'max_hold', 'no_ignition'];
const NUM_KEYS: readonly (keyof LegSpec)[] = ['dropPct', 'maxGapS', 'atMultiple', 'whilePeakBelow', 'sellFractionOfOriginal', 'armPeakMultiple', 'exitAtPeakFraction', 'afterMs', 'belowMultiple'];

/** A stored snapshot, validated (every leg id/kind known, every number finite and positive, every leg in the order, TP sum <= 1), or
 *  null when absent or broken. A broken snapshot is reported by the caller; the position then falls back to its policy id (fail-safe). */
export function normalizeExitPlan(raw: unknown): ExitPlanSnapshot | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.source !== 'preset' && r.source !== 'policy') return null;
  if (r.grade !== 'A' && r.grade !== 'B' && r.grade !== 'C') return null;
  const rev = r.rev === null ? null : Number.isSafeInteger(r.rev) && (r.rev as number) >= 1 ? r.rev as number : undefined;
  if (rev === undefined) return null;
  const p = r.policy as Record<string, unknown> | null | undefined;
  if (typeof p !== 'object' || p === null) return null;
  if (typeof p.id !== 'string' || p.id === '' || p.id.length > 32 || typeof p.version !== 'string' || p.version === '' || p.version.length > 64) return null;
  if (typeof p.closeAccountOnFullExit !== 'boolean' || !Array.isArray(p.legs) || !Array.isArray(p.order)) return null;
  const legs: LegSpec[] = [];
  for (const x of p.legs as unknown[]) {
    if (typeof x !== 'object' || x === null) return null;
    const l = x as Record<string, unknown>;
    if (typeof l.id !== 'string' || !LEG_IDS.includes(l.id) || typeof l.kind !== 'string' || !KINDS.includes(l.kind) || typeof l.protective !== 'boolean') return null;
    const leg: LegSpec = { id: l.id as LegId, kind: l.kind as LegSpec['kind'], protective: l.protective };
    for (const k of NUM_KEYS) {
      const v = l[k];
      if (v === undefined) continue;
      if (!fin(v) || v <= 0) return null;
      (leg as unknown as Record<string, number>)[k] = v;
    }
    legs.push(leg);
  }
  const ids = legs.map(l => l.id);
  if (new Set(ids).size !== ids.length) return null;
  const order = (p.order as unknown[]).filter((x): x is LegId => typeof x === 'string' && ids.includes(x as LegId));
  if (order.length !== (p.order as unknown[]).length || order.length !== ids.length) return null;
  try { checkSnapshotLegs(legs); } catch { return null; }
  return { source: r.source, grade: r.grade, rev, policy: { id: p.id, version: p.version, legs, order, closeAccountOnFullExit: p.closeAccountOnFullExit } };
}

function checkSnapshotLegs(legs: readonly LegSpec[]): void {
  for (const l of legs) {
    const need = (v: number | undefined): void => { if (v === undefined) throw new RangeError(`leg ${l.id} incomplete`); };
    switch (l.kind) {
      case 'hard_rug': need(l.dropPct); need(l.maxGapS); break;
      case 'rug_stop': need(l.atMultiple); need(l.whilePeakBelow); break;
      case 'take_profit': need(l.atMultiple); need(l.sellFractionOfOriginal); if ((l.sellFractionOfOriginal as number) > 1) throw new RangeError('fraction'); break;
      case 'trail': need(l.armPeakMultiple); need(l.exitAtPeakFraction); if ((l.exitAtPeakFraction as number) >= 1) throw new RangeError('trail'); break;
      case 'max_hold': need(l.afterMs); break;
      case 'no_ignition': need(l.afterMs); need(l.whilePeakBelow); need(l.belowMultiple); break;
    }
  }
  const tpSum = legs.filter(l => l.kind === 'take_profit').reduce((a, l) => a + (l.sellFractionOfOriginal as number), 0);
  if (tpSum > 1 + EPS) throw new RangeError('tp sum');
}

/** One line for the Positions view: "plan: grade B preset rev 2 (current rev 3)" / "plan: policy EA" / "plan: your orders". */
export function planLine(plan: ExitPlanSnapshot | null | undefined, policyId: string | null, current: GradePresets | null): string {
  if (plan === null || plan === undefined) return policyId === 'MANUAL' || policyId === null ? 'plan: your orders' : `plan: policy ${policyId}`;
  if (plan.source === 'policy') return `plan: policy ${plan.policy.id}`;
  const cur = current?.[plan.grade];
  const now = isCustom(cur) ? cur.rev : null;
  return `plan: grade ${plan.grade} preset rev ${plan.rev ?? '—'}${now !== null && now !== plan.rev ? ` (current rev ${now})` : ''}`;
}
