// R0-SHIMPL (round 0b; C02 section 5). The one exit policy used by the bot, the Engine exit alerts and the paper engine:
// load the policy file, version it, and evaluate one quote with a pure function. Canonical source: R\shared\exit-policy\exit-policy.ts;
// byte-identical copies live in Engine\src\shared\ and TG Bot\src\shared\ (R\scripts\sync-shared.ps1).
//
// This file uses Node crypto (policyVersion): the dashboard must not import it; it shows the version string it gets from the API.
// evaluateExit never reads the clock (the caller passes `now`) and there is no fallback policy: a malformed policy file throws.
import { createHash } from 'crypto';
import type { Ms } from '../common/ids';

export type LegId = 'R0' | 'S' | 'TP1' | 'TP2' | 'TP3' | 'T' | 'H' | 'C1';
export interface ResolvedPolicy { id: 'EA' | 'EA-C1' | 'HOLD-1H'; version: string; legs: LegSpec[]; order: LegId[]; closeAccountOnFullExit: boolean }
export interface LegSpec { id: LegId; kind: 'hard_rug' | 'rug_stop' | 'take_profit' | 'trail' | 'max_hold' | 'no_ignition'; protective: boolean;
  dropPct?: number; maxGapS?: number; atMultiple?: number; whilePeakBelow?: number; sellFractionOfOriginal?: number;
  armPeakMultiple?: number; exitAtPeakFraction?: number; afterMs?: number; belowMultiple?: number }
export interface ExitState { basis: number; peak: number; legsDone: LegId[]; soldFractionOfOriginal: number; openedAt: Ms;
  lastQuote: { value: number; at: Ms; src: string } | null }
export interface ExitQuote { value: number; at: Ms; src: string }        // same unit as basis (SOL/token or USD/token)
export interface ExitAction { leg: LegId; sellFractionOfOriginal: number; protective: boolean }

// ---------------------------------------------------------------------------------------------------------------------------------
// canonical JSON and the version
// ---------------------------------------------------------------------------------------------------------------------------------

/** Key-sorted canonical JSON (UTF-16 code unit order, recursive); numbers via String(n); undefined object members dropped. */
function canon(v: unknown, path: string): string | undefined {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string': return JSON.stringify(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError(`policy canonical JSON: non-finite number at ${path}`);
      return String(v);
    case 'undefined': return undefined;
    case 'object': break;
    default: throw new TypeError(`policy canonical JSON: unsupported ${typeof v} at ${path}`);
  }
  if (Array.isArray(v)) return '[' + v.map((e, i) => canon(e, `${path}[${i}]`) ?? 'null').join(',') + ']';
  const rec = v as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(rec).sort()) {
    const s = canon(rec[k], `${path}.${k}`);
    if (s !== undefined) parts.push(JSON.stringify(k) + ':' + s);
  }
  return '{' + parts.join(',') + '}';
}

/** First 16 hex of sha256 over the key-sorted canonical JSON of the resolved policy object (numbers via String(n)). */
export function policyVersion(p: Omit<ResolvedPolicy, 'version'>): string {
  const text = canon(p, '$');
  if (text === undefined) throw new TypeError('policyVersion: undefined policy');
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------------------------------------------------------------

const POLICY_IDS: readonly ResolvedPolicy['id'][] = ['EA', 'EA-C1', 'HOLD-1H'];
const LEG_IDS: readonly LegId[] = ['R0', 'S', 'TP1', 'TP2', 'TP3', 'T', 'H', 'C1'];
const KINDS: readonly LegSpec['kind'][] = ['hard_rug', 'rug_stop', 'take_profit', 'trail', 'max_hold', 'no_ignition'];

type Raw = Record<string, unknown>;
const isObj = (x: unknown): x is Raw => typeof x === 'object' && x !== null && !Array.isArray(x);
function fail(msg: string): never { throw new Error(`exit-policies: ${msg}`); }

function readNum(raw: Raw, key: string, where: string, ok: (n: number) => boolean, rule: string): number {
  const v = raw[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) fail(`${where}.${key} must be ${rule}`);
  return v;
}
const positive = (n: number): boolean => n > 0;
const fraction01 = (n: number): boolean => n > 0 && n <= 1;

function parseLeg(rawLeg: unknown, where: string): LegSpec {
  if (!isObj(rawLeg)) return fail(`${where} must be an object`);
  const id = rawLeg.id;
  if (typeof id !== 'string' || !(LEG_IDS as readonly string[]).includes(id)) return fail(`${where}.id is not a known leg id`);
  const kind = rawLeg.kind;
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return fail(`${where}.kind is not a known leg kind`);
  const w = `${where}(${id})`;
  const protective = rawLeg.protective === undefined ? false : rawLeg.protective;
  if (typeof protective !== 'boolean') return fail(`${w}.protective must be a boolean`);
  const leg: LegSpec = { id: id as LegId, kind: kind as LegSpec['kind'], protective };
  switch (leg.kind) {
    case 'hard_rug':
      leg.dropPct = readNum(rawLeg, 'drop_pct', w, n => n > 0 && n <= 100, 'a number in (0, 100]');
      leg.maxGapS = readNum(rawLeg, 'max_gap_s', w, positive, 'a positive number');
      break;
    case 'rug_stop':
      leg.atMultiple = readNum(rawLeg, 'at_multiple', w, positive, 'a positive number');
      leg.whilePeakBelow = readNum(rawLeg, 'while_peak_below', w, positive, 'a positive number');
      break;
    case 'take_profit':
      leg.atMultiple = readNum(rawLeg, 'at_multiple', w, positive, 'a positive number');
      leg.sellFractionOfOriginal = readNum(rawLeg, 'sell_fraction_of_original', w, fraction01, 'a number in (0, 1]');
      break;
    case 'trail':
      leg.armPeakMultiple = readNum(rawLeg, 'arm_peak_multiple', w, positive, 'a positive number');
      leg.exitAtPeakFraction = readNum(rawLeg, 'exit_at_peak_fraction', w, n => n > 0 && n < 1, 'a number in (0, 1)');
      break;
    case 'max_hold':
      leg.afterMs = readNum(rawLeg, 'after_ms', w, positive, 'a positive number');
      break;
    case 'no_ignition':
      leg.afterMs = readNum(rawLeg, 'after_ms', w, positive, 'a positive number');
      leg.whilePeakBelow = readNum(rawLeg, 'while_peak_below', w, positive, 'a positive number');
      leg.belowMultiple = readNum(rawLeg, 'below_multiple', w, positive, 'a positive number');
      break;
  }
  if (leg.kind === 'take_profit') {
    if (leg.protective) return fail(`${w} a take_profit leg cannot be protective`);
  } else if (rawLeg.sell !== 'all') {
    return fail(`${w}.sell must be "all"`);
  }
  return leg;
}

function parseLegList(raw: unknown, where: string): LegSpec[] {
  if (!Array.isArray(raw)) return fail(`${where} must be an array`);
  return raw.map((l, i) => parseLeg(l, `${where}[${i}]`));
}

function parseOrder(raw: unknown, legs: readonly LegSpec[], where: string): LegId[] {
  if (!Array.isArray(raw) || raw.length === 0) return fail(`${where}.evaluation_order must be a non-empty array`);
  const ids = legs.map(l => l.id as string);
  if (new Set(ids).size !== ids.length) return fail(`${where} has a duplicate leg id`);
  const order: LegId[] = [];
  for (const e of raw) {
    if (typeof e !== 'string' || !ids.includes(e)) return fail(`${where}.evaluation_order names a leg that does not exist`);
    if (order.includes(e as LegId)) return fail(`${where}.evaluation_order lists ${e} twice`);
    order.push(e as LegId);
  }
  for (const id of ids) if (!order.includes(id as LegId)) return fail(`${where}: leg ${id} is missing from evaluation_order (it would never run)`);
  return order;
}

type Unversioned = Omit<ResolvedPolicy, 'version'>;

function resolveOne(id: ResolvedPolicy['id'], policies: Raw, stack: readonly string[]): Unversioned {
  if (stack.includes(id)) return fail(`policy ${id} extends itself (${[...stack, id].join(' -> ')})`);
  const raw = policies[id];
  if (!isObj(raw)) return fail(`policy ${id} must be an object`);
  const where = `policies.${id}`;
  let legs: LegSpec[];
  let closeAccount: boolean | undefined;
  let baseOrder: LegId[] | null = null;
  if (raw.extends !== undefined) {
    const baseId = raw.extends;
    if (typeof baseId !== 'string' || !(POLICY_IDS as readonly string[]).includes(baseId)) return fail(`${where}.extends names an unknown policy`);
    const base = resolveOne(baseId as ResolvedPolicy['id'], policies, [...stack, id]);
    legs = [...base.legs, ...(raw.extra_legs === undefined ? [] : parseLegList(raw.extra_legs, `${where}.extra_legs`))];
    closeAccount = base.closeAccountOnFullExit;
    baseOrder = base.order;
  } else {
    legs = parseLegList(raw.legs, `${where}.legs`);
  }
  if (raw.close_account_on_full_exit !== undefined) {
    if (typeof raw.close_account_on_full_exit !== 'boolean') return fail(`${where}.close_account_on_full_exit must be a boolean`);
    closeAccount = raw.close_account_on_full_exit;
  }
  if (closeAccount === undefined) return fail(`${where}.close_account_on_full_exit is required`);
  const order = raw.evaluation_order === undefined && baseOrder !== null && (raw.extra_legs === undefined)
    ? baseOrder
    : parseOrder(raw.evaluation_order, legs, where);
  const tpSum = legs.filter(l => l.kind === 'take_profit').reduce((a, l) => a + (l.sellFractionOfOriginal ?? Number.NaN), 0);
  if (tpSum > 1 + 1e-9) return fail(`${where}: take_profit fractions add up to more than 1`);
  return { id, legs, order, closeAccountOnFullExit: closeAccount };
}

/** Resolves "extends" (the base legs plus extra_legs; the child's evaluation_order, close_account_on_full_exit override), validates every
 *  threshold and stamps each policy with its version. Throws on a malformed file; there is no fallback policy. */
export function loadPolicies(json: unknown): Record<ResolvedPolicy['id'], ResolvedPolicy> {
  if (!isObj(json)) return fail('the file must be an object');
  if (json.schema !== 1) return fail('schema must be 1');
  const policies = json.policies;
  if (!isObj(policies)) return fail('policies must be an object');
  for (const key of Object.keys(policies)) {
    if (!(POLICY_IDS as readonly string[]).includes(key)) return fail(`unknown policy id ${key}`);
  }
  const out = {} as Record<ResolvedPolicy['id'], ResolvedPolicy>;
  for (const id of POLICY_IDS) {
    if (!(id in policies)) return fail(`policy ${id} is missing`);
    const p = resolveOne(id, policies, []);
    out[id] = { ...p, version: policyVersion(p) };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------------------------------------------------------------

/** Below this much of the original position left, nothing is sold (float dust of the fraction arithmetic). */
const EPS = 1e-9;

function need(v: number | undefined, leg: LegSpec, field: string): number {
  if (v === undefined) throw new RangeError(`policy leg ${leg.id} (${leg.kind}) has no ${field}`);
  return v;
}

function fires(leg: LegSpec, m: number, pk: number, q: ExitQuote, s: ExitState, now: Ms): boolean {
  switch (leg.kind) {
    case 'hard_rug': {
      const last = s.lastQuote;
      if (last === null || last.src !== q.src) return false;
      if (!(q.at - last.at <= need(leg.maxGapS, leg, 'maxGapS') * 1000)) return false;
      if (!(last.value > 0)) return false;
      return (last.value - q.value) / last.value >= need(leg.dropPct, leg, 'dropPct') / 100;
    }
    case 'rug_stop':
      return pk < need(leg.whilePeakBelow, leg, 'whilePeakBelow') && m <= need(leg.atMultiple, leg, 'atMultiple');
    case 'no_ignition':
      return now - s.openedAt >= need(leg.afterMs, leg, 'afterMs')
        && pk < need(leg.whilePeakBelow, leg, 'whilePeakBelow') && m < need(leg.belowMultiple, leg, 'belowMultiple');
    case 'take_profit':
      return m >= need(leg.atMultiple, leg, 'atMultiple');
    case 'trail':
      return pk >= need(leg.armPeakMultiple, leg, 'armPeakMultiple') && m <= need(leg.exitAtPeakFraction, leg, 'exitAtPeakFraction') * pk;
    case 'max_hold':
      return now - s.openedAt >= need(leg.afterMs, leg, 'afterMs');
  }
}

/** Pure. m = quote.value / basis; pk = max(state.peak, m).
 *  Evaluate legs in `order`, skipping legsDone and any id in opts.skipLegs:
 *  R0: lastQuote non-null and same src and quote.at - lastQuote.at <= maxGapS*1000 and (lastQuote.value - quote.value)/lastQuote.value >= dropPct/100
 *  S: pk < whilePeakBelow and m <= atMultiple.   C1: now - openedAt >= afterMs and pk < whilePeakBelow and m < belowMultiple.
 *  TPn: m >= atMultiple.   T: pk >= armPeakMultiple and m <= exitAtPeakFraction * pk.   H: now - openedAt >= afterMs.
 *  The first protective leg that fires -> exactly one action selling the remainder (1 - soldFractionOfOriginal); TPs are not evaluated.
 *  Otherwise every firing TP -> one action each (the caller makes ONE sell of the summed fraction).
 *  nextState: peak = pk, lastQuote = quote, legsDone += fired, soldFractionOfOriginal += fractions.
 *  A quote that is not a finite number >= 0, or a basis that is not a finite number > 0, throws RangeError: the caller must have a real quote. */
export function evaluateExit(p: ResolvedPolicy, s: ExitState, q: ExitQuote, now: Ms, opts?: { skipLegs?: LegId[] }): { actions: ExitAction[]; next: ExitState } {
  if (!Number.isFinite(s.basis) || !(s.basis > 0)) throw new RangeError('evaluateExit: basis must be a finite number > 0');
  if (!Number.isFinite(q.value) || q.value < 0) throw new RangeError('evaluateExit: quote value must be a finite number >= 0');
  const m = q.value / s.basis;
  const pk = Math.max(s.peak, m);
  const done = new Set<LegId>(s.legsDone);
  const skip = new Set<LegId>(opts?.skipLegs ?? []);
  const byId = new Map<LegId, LegSpec>(p.legs.map(l => [l.id, l]));
  const firedLegs: LegSpec[] = [];
  for (const id of p.order) {
    if (done.has(id) || skip.has(id)) continue;
    const leg = byId.get(id);
    if (leg !== undefined && fires(leg, m, pk, q, s, now)) firedLegs.push(leg);
  }

  const remainder = Math.max(0, 1 - s.soldFractionOfOriginal);
  const actions: ExitAction[] = [];
  const legsDone: LegId[] = [...s.legsDone];
  let sold = s.soldFractionOfOriginal;
  if (remainder > EPS) {
    const protectiveHit = firedLegs.find(l => l.protective);
    if (protectiveHit !== undefined) {
      actions.push({ leg: protectiveHit.id, sellFractionOfOriginal: remainder, protective: true });
      legsDone.push(protectiveHit.id);
      sold = 1;
    } else {
      let room = remainder;
      for (const leg of firedLegs) {
        const f = Math.min(need(leg.sellFractionOfOriginal, leg, 'sellFractionOfOriginal'), room);
        if (f <= EPS) continue;
        actions.push({ leg: leg.id, sellFractionOfOriginal: f, protective: false });
        legsDone.push(leg.id);
        room -= f;
        sold += f;
      }
    }
  }
  const next: ExitState = {
    basis: s.basis, peak: pk, legsDone, soldFractionOfOriginal: sold, openedAt: s.openedAt,
    lastQuote: { value: q.value, at: q.at, src: q.src },
  };
  return { actions, next };
}
