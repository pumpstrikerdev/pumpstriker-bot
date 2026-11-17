/**
 * signal-settings.ts (A-115, CARD-MENU spec sections 5.1 and 7.1): the restored `settings.signal` keys (Active, Min Score, the MCap and
 * liquidity bands, Auto-Sell by Grade, the grade presets, the one-time import notice and the verbatim legacy copy), how a (possibly
 * hand-edited) file is read, and the validation of every number the owner types in the restored menus.
 *
 * Reading never crashes and never loosens: an invalid value falls back to the default of its key with a warning, except a filter bound
 * that is SET but unreadable, which is kept as 'invalid' so the filter fails closed until the owner re-enters it (the menu shows ⚠ invalid).
 * Pure: no I/O, no clock.
 */
import { defaultGradePresets, normalizeGradePresets, type GradePresets } from '../exits/presets';
import type { Bound } from '../intake/owner-filter';

export interface ImportNotice { createdAt: number; text: string; sentAt: number | null }
export interface LegacySignal { importedFrom: string; sha256: string; importedAt: number; oldSignal: Record<string, unknown> }
export interface RestoredSignal {
  enabled: boolean;
  minScore: Bound;
  minMcap: Bound; maxMcap: Bound; minLiquidity: Bound; maxLiquidity: Bound;
  autoSellOnSignal: boolean;
  gradePresets: GradePresets;
  importNotice: ImportNotice | null;
  legacy: LegacySignal | null;
}

/** The A-115 keys of `settings.signal` (schema 2, additive). */
export const RESTORED_SIGNAL_KEYS: readonly (keyof RestoredSignal)[] = [
  'enabled', 'minScore', 'minMcap', 'maxMcap', 'minLiquidity', 'maxLiquidity', 'autoSellOnSignal', 'gradePresets', 'importNotice', 'legacy',
];
export const BOUND_KEYS = ['minMcap', 'maxMcap', 'minLiquidity', 'maxLiquidity'] as const;
export type BoundKey = (typeof BOUND_KEYS)[number];

export function restoredDefaults(): RestoredSignal {
  return {
    enabled: true, minScore: null, minMcap: null, maxMcap: null, minLiquidity: null, maxLiquidity: null, autoSellOnSignal: true,
    gradePresets: defaultGradePresets(), importNotice: null, legacy: null,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const MAX_USD = 1e12;

function readBound(v: unknown, key: string, warn: (m: string) => void): Bound {
  if (v === undefined || v === null || v === 0) return null;
  if (v === 'invalid') return 'invalid';
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_USD) return v;
  warn(`signal.${key} is not a USD amount; the filter stays closed until you set it again`);
  return 'invalid';
}

function readMinScore(v: unknown, warn: (m: string) => void): Bound {
  if (v === undefined || v === null) return null;
  if (v === 'invalid') return 'invalid';
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100) return v;
  warn('signal.minScore is not a whole number from 0 to 100; the filter stays closed until you set it again');
  return 'invalid';
}

/** The restored keys of a `signal` object as the file holds them (missing keys take their defaults). */
export function readRestored(rawSignal: unknown, warn: (m: string) => void = () => undefined): RestoredSignal {
  const s = isObj(rawSignal) ? rawSignal : {};
  const d = restoredDefaults();
  const bool = (k: 'enabled' | 'autoSellOnSignal'): boolean => {
    if (s[k] === undefined) return d[k];
    if (typeof s[k] === 'boolean') return s[k] as boolean;
    warn(`signal.${k} is not true/false; the default (${d[k] ? 'ON' : 'OFF'}) is used`);
    return d[k];
  };
  const notice = isObj(s.importNotice) && typeof s.importNotice.text === 'string' && typeof s.importNotice.createdAt === 'number'
    ? { createdAt: s.importNotice.createdAt, text: s.importNotice.text.slice(0, 3500), sentAt: typeof s.importNotice.sentAt === 'number' ? s.importNotice.sentAt : null }
    : null;
  const legacy = isObj(s.legacy) && typeof s.legacy.importedFrom === 'string' && typeof s.legacy.sha256 === 'string' && isObj(s.legacy.oldSignal)
    ? { importedFrom: s.legacy.importedFrom, sha256: s.legacy.sha256, importedAt: typeof s.legacy.importedAt === 'number' ? s.legacy.importedAt : 0, oldSignal: s.legacy.oldSignal }
    : null;
  return {
    enabled: bool('enabled'),
    minScore: readMinScore(s.minScore, warn),
    minMcap: readBound(s.minMcap, 'minMcap', warn), maxMcap: readBound(s.maxMcap, 'maxMcap', warn),
    minLiquidity: readBound(s.minLiquidity, 'minLiquidity', warn), maxLiquidity: readBound(s.maxLiquidity, 'maxLiquidity', warn),
    autoSellOnSignal: bool('autoSellOnSignal'),
    gradePresets: s.gradePresets === undefined ? defaultGradePresets() : normalizeGradePresets(s.gradePresets, warn),
    importNotice: notice, legacy,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// typed inputs (spec 5.1). Each returns the value to save, or the refusal (the caller replies "❌ <reason> Nothing was saved.").
// ---------------------------------------------------------------------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const no = <T>(error: string): Parsed<T> => ({ ok: false, error });
const blank = (v: string): boolean => v.trim() === '' || /^(none|blank|-|—)$/i.test(v.trim());

export const MIN_SCORE_ERROR = 'Enter a whole number from 0 to 100 (blank = no minimum).';
export const USD_ERROR = 'Enter a USD amount ≥ 0 (0 = no limit).';

/** Min Score: blank -> no minimum; else a whole number 0-100. */
export function parseMinScore(v: string): Parsed<number | null> {
  if (blank(v)) return ok(null);
  const t = v.trim();
  if (!/^\d{1,3}$/.test(t)) return no(MIN_SCORE_ERROR);
  const n = Number(t);
  return n <= 100 ? ok(n) : no(MIN_SCORE_ERROR);
}

/** A USD bound: blank or 0 -> no limit; else a finite number >= 0 and <= 1e12 ("$150,000", "150k" and "1.5m" are read too). */
export function parseUsdBound(v: string): Parsed<number | null> {
  if (blank(v)) return ok(null);
  const m = /^\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?|\.[0-9]+)\s*([kKmM])?$/.exec(v.trim());
  if (m === null) return no(USD_ERROR);
  const base = Number(m[1].replace(/,/g, ''));
  const mult = m[2] === undefined ? 1 : /k/i.test(m[2]) ? 1e3 : 1e6;
  const n = base * mult;
  if (!Number.isFinite(n) || n < 0 || n > MAX_USD) return no(USD_ERROR);
  return ok(n === 0 ? null : n);
}

const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
const BOUND_LABEL: Record<BoundKey, string> = { minMcap: 'Min MCap', maxMcap: 'Max MCap', minLiquidity: 'Min Liq', maxLiquidity: 'Max Liq' };
const PAIR: Record<BoundKey, BoundKey> = { minMcap: 'maxMcap', maxMcap: 'minMcap', minLiquidity: 'maxLiquidity', maxLiquidity: 'minLiquidity' };

/** min <= max when both are set: the refusal text, or null. */
export function boundPairError(key: BoundKey, value: number | null, cur: Pick<RestoredSignal, BoundKey>): string | null {
  if (value === null) return null;
  const other = cur[PAIR[key]];
  if (typeof other !== 'number') return null;
  const isMin = key.startsWith('min');
  if (isMin && value > other) return `${BOUND_LABEL[key]} ${usd(value)} is above ${BOUND_LABEL[PAIR[key]]} ${usd(other)}. Lower it or raise ${BOUND_LABEL[PAIR[key]]} first.`;
  if (!isMin && value < other) return `${BOUND_LABEL[key]} ${usd(value)} is below ${BOUND_LABEL[PAIR[key]]} ${usd(other)}. Raise it or lower ${BOUND_LABEL[PAIR[key]]} first.`;
  return null;
}

export function boundText(b: Bound): string {
  if (b === null) return 'None';
  if (b === 'invalid') return '⚠ invalid';
  return usd(b);
}
export const boundLabel = (k: BoundKey): string => BOUND_LABEL[k];

/** TP trigger: finite, > 0, <= 100000. */
export function parseTpTrigger(v: string): Parsed<number> {
  const n = numOf(v);
  return n !== null && n > 0 && n <= 100_000 ? ok(n) : no('Enter a positive % (100 = 2×).');
}
/** TP sell %: a whole number 1-100. */
export function parseSellPct(v: string): Parsed<number> {
  const t = v.trim().replace(/%$/, '');
  if (!/^\d{1,3}$/.test(t)) return no('Enter a whole number from 1 to 100.');
  const n = Number(t);
  return n >= 1 && n <= 100 ? ok(n) : no('Enter a whole number from 1 to 100.');
}
/** SL: the loss in %, 1-95 (a leading minus is accepted). */
export function parseStopPct(v: string): Parsed<number> {
  const n = numOf(v.trim().replace(/^[-−]/, ''));
  return n !== null && n >= 1 && n <= 95 ? ok(n) : no('Enter the loss in % from 1 to 95 (30 = sell all at −30%).');
}
/** TSL arm-after %: 0-10000 (0 = from the first quote). */
export function parseArmAfter(v: string): Parsed<number> {
  const n = numOf(v);
  return n !== null && n >= 0 && n <= 10_000 ? ok(n) : no('Enter a % from 0 to 10000 (0 = trail from the first quote).');
}
/** TSL trail %: 1-95 (a leading minus is accepted). */
export function parseTrailPct(v: string): Parsed<number> {
  const n = numOf(v.trim().replace(/^[-−]/, ''));
  return n !== null && n >= 1 && n <= 95 ? ok(n) : no('Enter the trail in % from 1 to 95 (40 = sell all 40% under the peak).');
}
/** Max hold: a whole number of hours 0-168 (0 = none). */
export function parseMaxHold(v: string): Parsed<number | null> {
  const t = v.trim();
  if (!/^\d{1,3}$/.test(t)) return no('Enter whole hours from 0 to 168 (0 = no max hold).');
  const n = Number(t);
  if (n > 168) return no('Enter whole hours from 0 to 168 (0 = no max hold).');
  return ok(n === 0 ? null : n);
}

function numOf(v: string): number | null {
  const t = v.trim().replace(/%$/, '').replace(/^\+/, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
