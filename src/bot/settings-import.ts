/**
 * settings-import.ts (A-115, CARD-MENU spec section 7, "C2: the owner's old settings back"). Imports the restored `signal` keys from a
 * settings file in the OLD bot's format instead of dropping them:
 *
 *   minScore              -> Min Score, the SAME number (never reinterpreted); the one-time summary explains the new scale
 *   minMcap/maxMcap, minLiquidity/maxLiquidity -> the filters (blank / null / 0 stays "no limit")
 *   enabled, autoSellOnSignal -> their restored switches (booleans only)
 *   scoreTiers            -> the grade presets A / B / C, by rank of the tiers that can still occur (every card is >= 85)
 *   everything else of the old `signal` -> kept verbatim in `signal.legacy.oldSignal`, the keys with no control listed with the reason
 *
 * `importOldSignal` is pure. The file helpers below (candidates, the re-import of `/importsettings` and of the script) never take a path
 * from the chat: the command offers only files of the data folder whose NAME matches IMPORT_NAME_RE. A backup of settings.json is written
 * before any change (the atomic write of link/atomic-file.ts). The same source imported twice (same sha256) writes nothing.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomicSync } from '../link/atomic-file';
import { mdSafe } from '../shared/contract/validate';
import type { Grade } from '../shared/common/ids';
import type { ResolvedPolicy } from '../shared/exit-policy/exit-policy';
import { loadPolicies } from '../shared/exit-policy/exit-policy';
import policiesJson from '../shared/exit-policy/exit-policies.json';
import {
  defaultGradePresets, ladderProblem, materialize, presetProblem, presetSummary, type CustomPreset, type GradePresets, type PresetRung, type PresetTrail,
} from '../exits/presets';
import { readRestored, type ImportNotice, type LegacySignal, type RestoredSignal } from './signal-settings';
import type { Bound } from '../intake/owner-filter';

export const SETTINGS_FILE = 'settings.json';
/** The names /importsettings may read from the data folder: settings.json, settings.old-bot.json and their .bak-<stamp> copies. */
export const IMPORT_NAME_RE = /^settings(\.old-bot)?\.json(\.bak-\d{8}-\d{6}(-\d+)?)?$/;
/** Every card is at least this confident (line-85); a tier whose whole range lies below it can never occur. */
export const CARD_FLOOR = 85;
/** The old bot's default trail of a legacy positive TSL (order-triggers.ts LEGACY_TSL_DEFAULT_TRAIL = -30). */
export const LEGACY_TSL_DEFAULT_TRAIL = 30;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const tidy = (x: number): number => Math.round(x * 1e6) / 1e6;
export const sha256Of = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

/** The active exit policy when the caller has none at hand (EA of the shared policy file). */
export function defaultActivePolicy(): ResolvedPolicy {
  return loadPolicies(policiesJson).EA;
}

/** An old-format document: no schema or schema 1, or a `signal` with the old score keys and no grade presets. */
export function isOldFormat(doc: unknown): boolean {
  if (!isObj(doc)) return false;
  if (doc.schema === undefined || doc.schema === 1) return true;
  const s = doc.signal;
  return isObj(s) && (Array.isArray(s.scoreTiers) || s.minScore !== undefined) && s.gradePresets === undefined;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the pure import
// ---------------------------------------------------------------------------------------------------------------------------------

export interface TierMapping { grade: Grade; tierId: string; label: string; range: string; preset: CustomPreset | null; notes: string[] }
export interface ImportResult {
  restored: Omit<RestoredSignal, 'importNotice' | 'legacy'>;
  mapping: TierMapping[];
  /** The tiers that cannot occur any more (or are beyond the third reachable one), with their labels. */
  unused: Array<{ tierId: string; label: string; range: string; why: string }>;
  /** Names (never values) of the old keys that have no control any more, with the reason. */
  notApplicable: Array<{ key: string; why: string }>;
  /** Values that were not imported, with the reason (the summary lists them). */
  problems: string[];
  /** The four bounds in a "min above max" state (imported as they were, the filter then shows ⚠). */
  minAboveMax: string[];
}

const NOT_APPLICABLE: Record<string, string> = {
  duplicateBuy: 'Dupe Buy (one auto-buy per token is always enforced)',
  autoBuyMinScore: 'auto-buy min score (auto-buy is armed only with /autobuy; Min Score now gates auto-buy too)',
  autoBuyHotFilter: 'HOT-only filter (no HOT/COLD tag any more)',
  autoBuySignalCount: 'buy at signal # (one card per token)',
  autoBuyOnUpgrade: 'buy-on-upgrade (one card per token)',
  tierBlocklist: 'tier blocklist (the Engine grades every signal A / B / C)',
};
/** Old signal keys that are kept by the migration as they are (never overwritten by an import). */
const KEPT_AS_IS: readonly string[] = ['buyAmount', 'slippageBps', 'degenMode', 'sessionEnabled', 'sessionPreset', 'sessionStart', 'sessionEnd', 'sessionTz', 'tgMinGrade'];
const IMPORTED: readonly string[] = ['enabled', 'minScore', 'minMcap', 'maxMcap', 'minLiquidity', 'maxLiquidity', 'autoSellOnSignal', 'scoreTiers'];

function importBound(v: unknown, key: string, problems: string[]): Bound {
  if (v === undefined || v === null || v === 0 || v === '') return null;
  if (fin(v) && v > 0 && v <= 1e12) return v;
  problems.push(`${key} was not imported (not a positive USD amount): no limit`);
  return null;
}

function rangeText(t: Record<string, unknown>): string {
  const min = fin(t.minScore) ? t.minScore : null;
  const max = fin(t.maxScore) ? (t.maxScore === 101 ? 100 : t.maxScore) : null;
  return `${min ?? '?'}-${max ?? '?'}`;
}

/** The old tier's orders as a custom preset (spec 7.3 "Leg conversion"); the notes say what could not be carried over. */
export function tierToPreset(tier: Record<string, unknown>, active: Pick<ResolvedPolicy, 'legs'>, now: number): { preset: CustomPreset | null; notes: string[] } {
  const notes: string[] = [];
  const raw = Array.isArray(tier.presets) ? tier.presets.filter(isObj) : [];
  if (raw.some(p => p.duration !== undefined)) notes.push('order durations were not imported (stops never expire now)');
  // take-profits, by trigger; old balance = % of the holdings AT the trigger, new = % of the ORIGINAL
  const tps = raw.filter(p => p.type === 'tp').filter(p => {
    if (fin(p.triggerPct) && p.triggerPct > 0 && p.triggerPct <= 100_000) return true;
    notes.push(`a take-profit with trigger ${String(p.triggerPct)} was not imported`);
    return false;
  }).sort((a, b) => (a.triggerPct as number) - (b.triggerPct as number));
  if (tps.length > 3) notes.push(`${tps.length - 3} take-profit(s) above the first three were not imported`);
  const ladder: PresetRung[] = [];
  let left = 100;
  for (const p of tps.slice(0, 3)) {
    const bal = fin(p.balance) && p.balance > 0 ? Math.min(100, p.balance) : 100;
    const share = tidy((bal * left) / 100);
    if (share <= 0) continue;
    ladder.push({ atPct: tidy(p.triggerPct as number), sellPctOfOriginal: share, trigger: 'entryPrice' });
    left = tidy(left - share);
  }
  // the stop: the first SL, always on (the old SL); none -> the active policy's stop
  const sl = raw.find(p => p.type === 'sl');
  let stop: CustomPreset['stop'];
  if (sl !== undefined && fin(sl.triggerPct) && Math.abs(sl.triggerPct) >= 1 && Math.abs(sl.triggerPct) <= 95) {
    stop = { lossPct: tidy(Math.abs(sl.triggerPct)), whilePeakBelowPct: null };
    if (fin(sl.balance) && sl.balance < 100) notes.push(`the stop sold ${sl.balance}% before; a stop now always sells everything left`);
  } else {
    stop = materialize(active, now).stop;
    notes.push(sl === undefined ? 'no stop-loss in this tier: the exit policy\'s stop is used' : 'the stop-loss could not be read: the exit policy\'s stop is used');
  }
  // the trail (a legacy positive TSL is normalised as the old bot did: its % becomes the arm level, the trail -30%)
  let trail: PresetTrail | null = null;
  const tsl = raw.find(p => p.type === 'tsl');
  if (tsl !== undefined) {
    let trig = tsl.triggerPct;
    let arm: unknown = tsl.armAfterPct;
    if (fin(trig) && trig > 0) { arm = arm ?? trig; trig = -LEGACY_TSL_DEFAULT_TRAIL; notes.push('a legacy positive trailing stop was read as "arm after" with a 30% trail'); }
    const armPct = arm === undefined || arm === null ? 0 : arm;
    if (fin(trig) && Math.abs(trig) >= 1 && Math.abs(trig) <= 95 && fin(armPct) && armPct >= 0 && armPct <= 10_000) {
      trail = { armAfterPct: tidy(armPct), trailPct: tidy(Math.abs(trig)), trigger: 'entryPrice' };
    } else {
      notes.push('the trailing stop could not be read and was not imported');
    }
  }
  if (ladderProblem(ladder) !== null) { notes.push('the take-profits could not be imported'); ladder.length = 0; }
  const id = typeof tier.id === 'string' && tier.id !== '' ? mdSafe(tier.id, 32) : 'tier';
  const preset: CustomPreset = {
    mode: 'custom', rev: 1, enabled: tier.enabled !== false, source: `imported:${id || 'tier'}`, updatedAt: now, stop, ladder, trail, maxHoldH: null,
  };
  const why = presetProblem(preset);
  if (why !== null) { notes.push(`not imported (${why}); the exit policy applies`); return { preset: null, notes }; }
  return { preset, notes };
}

/** Pure: the restored keys from an old `signal` object (spec 7.3). Never throws. */
export function importOldSignal(oldSignal: unknown, active: Pick<ResolvedPolicy, 'legs'> = defaultActivePolicy(), now = 0): ImportResult {
  const s = isObj(oldSignal) ? oldSignal : {};
  const problems: string[] = [];
  let minScore: Bound = null;
  if (s.minScore !== undefined && s.minScore !== null) {
    if (fin(s.minScore) && Number.isInteger(s.minScore) && s.minScore >= 0 && s.minScore <= 100) minScore = s.minScore === 0 ? null : s.minScore;
    else problems.push('minScore was not imported (not a whole number from 0 to 100): no minimum');
  }
  const restored: ImportResult['restored'] = {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : true,
    minScore,
    minMcap: importBound(s.minMcap, 'minMcap', problems), maxMcap: importBound(s.maxMcap, 'maxMcap', problems),
    minLiquidity: importBound(s.minLiquidity, 'minLiquidity', problems), maxLiquidity: importBound(s.maxLiquidity, 'maxLiquidity', problems),
    autoSellOnSignal: typeof s.autoSellOnSignal === 'boolean' ? s.autoSellOnSignal : true,
    gradePresets: defaultGradePresets(),
  };
  if (s.enabled !== undefined && typeof s.enabled !== 'boolean') problems.push('enabled was not a switch: Signals stay Active');
  if (s.autoSellOnSignal !== undefined && typeof s.autoSellOnSignal !== 'boolean') problems.push('autoSellOnSignal was not a switch: Auto-Sell by Grade stays ON');
  const minAboveMax: string[] = [];
  const pairs: Array<[Bound, Bound, string]> = [[restored.minMcap, restored.maxMcap, 'MCap'], [restored.minLiquidity, restored.maxLiquidity, 'Liq']];
  for (const [lo, hi, what] of pairs) if (typeof lo === 'number' && typeof hi === 'number' && lo > hi) minAboveMax.push(what);

  // score tiers -> grades, by rank of the tiers that can still occur
  const tiers = Array.isArray(s.scoreTiers) ? s.scoreTiers.filter(isObj) : [];
  const reachable = tiers.filter(t => !fin(t.maxScore) || t.maxScore > CARD_FLOOR)
    .sort((a, b) => (fin(b.minScore) ? b.minScore : -1) - (fin(a.minScore) ? a.minScore : -1));
  const mapping: TierMapping[] = [];
  const unused: ImportResult['unused'] = [];
  const grades: Grade[] = ['A', 'B', 'C'];
  reachable.forEach((t, i) => {
    const label = mdSafe(typeof t.label === 'string' ? t.label : String(t.id ?? 'tier'), 40) || 'tier';
    const tierId = mdSafe(String(t.id ?? ''), 32);
    if (i >= grades.length) { unused.push({ tierId, label, range: rangeText(t), why: 'only three grades exist' }); return; }
    const { preset, notes } = tierToPreset(t, active, now);
    if (preset !== null) restored.gradePresets[grades[i]] = preset;
    mapping.push({ grade: grades[i], tierId, label, range: rangeText(t), preset, notes });
  });
  for (const t of tiers) {
    if (reachable.includes(t)) continue;
    unused.push({ tierId: mdSafe(String(t.id ?? ''), 32), label: mdSafe(typeof t.label === 'string' ? t.label : String(t.id ?? 'tier'), 40) || 'tier', range: rangeText(t), why: `no card is sent below ${CARD_FLOOR}` });
  }
  if (s.scoreTiers !== undefined && !Array.isArray(s.scoreTiers)) problems.push('scoreTiers could not be read: every grade follows the exit policy');

  const notApplicable: ImportResult['notApplicable'] = [];
  for (const k of Object.keys(s)) {
    if (IMPORTED.includes(k) || KEPT_AS_IS.includes(k)) continue;
    notApplicable.push({ key: k, why: NOT_APPLICABLE[k] ?? `${mdSafe(k, 32)} (no control any more)` });
  }
  return { restored, mapping, unused, notApplicable, problems, minAboveMax };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the one-time Telegram summary (spec 7.4); plain text, every imported label already mdSafe'd
// ---------------------------------------------------------------------------------------------------------------------------------

const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

export function minScoreNote(v: Bound): string {
  if (v === null) return '🎯 Min Score: none (every card is shown).';
  if (v === 'invalid') return '🎯 Min Score: ⚠ invalid (no card passes until you set it again).';
  const scale = 'the scale changed: every card is now ≥ 85 (85-89 STRONG, 90-99 ULTRA).';
  const effect = v <= CARD_FLOOR ? `${v} hides no card` : v === 90 ? '90 shows only ULTRA cards and hides 85-89' : v < 90 ? `${v} hides the cards from 85 to ${v - 1}` : `${v} shows only cards from ${v} up and hides 85-${v - 1}`;
  return `🎯 Min Score ${v} — ${scale} ${effect}; the old and new scorers differ, so ${v} does not pick the same tokens. Blank = every card.`;
}

export function importSummary(r: ImportResult, from: string, autoBuyMode?: string): string {
  const lines: string[] = [`♻️ Your old settings are back (from ${mdSafe(from, 80)})`];
  lines.push(minScoreNote(r.restored.minScore));
  const b: Array<[string, Bound]> = [['📉 Min MCap', r.restored.minMcap], ['📈 Max MCap', r.restored.maxMcap], ['💧 Min Liq', r.restored.minLiquidity], ['💧 Max Liq', r.restored.maxLiquidity]];
  const set = b.filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k} ${usd(v as number)}`);
  const unset = b.filter(([, v]) => v === null).map(([k]) => k.replace(/^\S+ /, ''));
  lines.push([...set, ...(unset.length > 0 ? [`${unset.join(', ')}: no limit`] : [])].join(' · '));
  if (r.minAboveMax.length > 0) lines.push(`⚠ min above max for ${r.minAboveMax.join(' and ')}: no card passes that filter until you fix it.`);
  lines.push(`🟢 Signals: ${r.restored.enabled ? 'Active' : 'Inactive'} · 💸 Auto-Sell by Grade: ${r.restored.autoSellOnSignal ? 'ON' : 'OFF'}`);
  if (r.mapping.length > 0) {
    lines.push('Grade presets from your score tiers (please check, Signals > [A]/[B]/[C]):');
    for (const m of r.mapping) {
      lines.push(` ${m.grade} ← ${m.label} (${m.range}): ${m.preset !== null ? presetSummary(m.preset) :'not imported, the exit policy applies'}`);
      for (const n of m.notes.filter(x => !x.startsWith('order durations'))) lines.push(`   (${n})`);
    }
  } else {
    lines.push('Grade presets: no score tier can occur any more (every card is ≥ 85); every grade follows the exit policy.');
  }
  if (r.unused.length > 0) lines.push(` Not used: ${r.unused.map(u => `${u.label} (${u.range})`).join(', ')}: ${[...new Set(r.unused.map(u => u.why))].join('; ')}.`);
  if (r.mapping.some(m => m.preset !== null && m.preset.ladder.length > 1)) {
    const shares = r.mapping.filter(m => m.preset !== null && m.preset.ladder.length > 1).map(m => `${(m.preset as CustomPreset).ladder[1].sellPctOfOriginal}%`).join('/');
    lines.push(` Sell % now means % of the ORIGINAL position (your share of what was left = ${shares}).`);
  }
  if (r.mapping.some(m => m.notes.some(n => n.startsWith('order durations')))) lines.push(' Order durations were not imported: stops never expire now.');
  for (const p of r.problems) lines.push(`⚠ ${p}`);
  if (r.notApplicable.length > 0) {
    const na = r.notApplicable.map(n => n.key === 'autoBuyMinScore' && autoBuyMode !== undefined ? `${n.why.replace(/\)$/, '')}; it is ${mdSafe(autoBuyMode, 40)} now)` : n.why);
    lines.push(`Not applicable (kept in the file): ${na.join(' · ')}.`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// files: the candidates of /importsettings, the import into settings.json, the one-time notice
// ---------------------------------------------------------------------------------------------------------------------------------

export interface ImportCandidate { name: string; sha256: string }

/** The data-folder files /importsettings may offer: a matching NAME (no path, no traversal), readable JSON, old format. */
export function listImportCandidates(dir: string): ImportCandidate[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: ImportCandidate[] = [];
  for (const name of names.filter(n => IMPORT_NAME_RE.test(n)).sort().reverse()) {
    const read = readOldFormat(dir, name);
    if (read.ok) out.push({ name, sha256: read.sha256 });
  }
  return out;
}

export type ReadOld = { ok: true; doc: Record<string, unknown>; sha256: string } | { ok: false; reason: string };
/** Reads `<dir>/<name>` when `name` is an allowed file name, and accepts it only as an old-format JSON object. */
export function readOldFormat(dir: string, name: string): ReadOld {
  if (typeof name !== 'string' || !IMPORT_NAME_RE.test(name) || name !== path.basename(name)) return { ok: false, reason: 'that file name is not allowed' };
  return readOldFormatPath(path.join(dir, name));
}
/** The script's reader: any path (the owner names it on the command line), the same old-format check. */
export function readOldFormatPath(file: string): ReadOld {
  let raw: Buffer;
  try { raw = fs.readFileSync(file); } catch { return { ok: false, reason: 'the file cannot be read' }; }
  let doc: unknown;
  try { doc = JSON.parse(raw.toString('utf8')); } catch { return { ok: false, reason: 'the file is not JSON' }; }
  if (!isObj(doc)) return { ok: false, reason: 'the file is not a settings object' };
  if (!isOldFormat(doc)) return { ok: false, reason: 'the file is not in the old bot\'s format' };
  return { ok: true, doc, sha256: sha256Of(raw) };
}

/** `YYYYMMDD-HHMMSS` in UTC. */
export function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Writes `<dir>/settings.json.bak-<stamp>[-n]` (a byte copy) and returns its path; a name that exists is never overwritten. */
export function backupSettings(dir: string, raw: Buffer, now: number): string {
  const base = path.join(dir, `${SETTINGS_FILE}.bak-${stamp(now)}`);
  let backup = base;
  for (let n = 1; fs.existsSync(backup); n++) backup = `${base}-${n}`;
  writeFileAtomicSync(backup, raw);
  return backup;
}

export interface ImportOutcome { status: 'imported' | 'already' | 'refused'; reason?: string; summary?: string; backupFile?: string | null; doc?: Record<string, unknown> }

/** Pure: the settings document with the restored keys (only) taken from `source`; every other key is kept as it is. */
export function mergeImport(current: Record<string, unknown>, source: Record<string, unknown>, sourceName: string, sourceSha: string, now: number,
  active: Pick<ResolvedPolicy, 'legs'> = defaultActivePolicy(), autoBuyMode?: string): { doc: Record<string, unknown>; summary: string } | 'already' {
  const curSig = isObj(current.signal) ? current.signal : {};
  const prev = readRestored(curSig).legacy;
  if (prev !== null && prev.sha256 === sourceSha) return 'already';
  const oldSignal = isObj(source.signal) ? source.signal : {};
  const r = importOldSignal(oldSignal, active, now);
  const summary = importSummary(r, sourceName, autoBuyMode);
  const legacy: LegacySignal = { importedFrom: sourceName, sha256: sourceSha, importedAt: now, oldSignal: JSON.parse(JSON.stringify(oldSignal)) as Record<string, unknown> };
  const importNotice: ImportNotice = { createdAt: now, text: summary, sentAt: null };
  const signal: Record<string, unknown> = { ...curSig, ...r.restored, gradePresets: r.restored.gradePresets as GradePresets, legacy, importNotice };
  return { doc: { ...current, signal }, summary };
}

/** The re-import (/importsettings and the script): backup of the current file, then the restored keys only. Same source twice: nothing. */
export function importIntoSettingsFile(dir: string, source: { name: string; doc: Record<string, unknown>; sha256: string }, now: number,
  active?: Pick<ResolvedPolicy, 'legs'>, autoBuyMode?: string): ImportOutcome {
  const file = path.join(dir, SETTINGS_FILE);
  let raw: Buffer | null = null;
  let current: Record<string, unknown> = { schema: 2 };
  try {
    raw = fs.readFileSync(file);
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (!isObj(parsed)) return { status: 'refused', reason: 'settings.json is not a settings object; nothing was written' };
    current = parsed;
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') return { status: 'refused', reason: 'settings.json cannot be read; nothing was written' };
  }
  if (isOldFormat(current)) return { status: 'refused', reason: 'settings.json itself is still in the old format; restart the bot once so it is migrated, then import' };
  const m = mergeImport(current, source.doc, source.name, source.sha256, now, active, autoBuyMode);
  if (m === 'already') return { status: 'already', reason: `${source.name} was already imported; nothing was written` };
  const backupFile = raw !== null ? backupSettings(dir, raw, now) : null;
  writeFileAtomicSync(file, JSON.stringify(m.doc, null, 2));
  return { status: 'imported', summary: m.summary, backupFile, doc: m.doc };
}

/** The notice text to send once, or null (already sent, or none). */
export function noticeToSend(signal: unknown): string | null {
  const n = readRestored(signal).importNotice;
  return n !== null && n.sentAt === null ? n.text : null;
}
/** The signal object with the notice marked as sent (sentAt persisted by the caller). */
export function markNoticeSent<T extends Record<string, unknown>>(signal: T, now: number): T {
  const n = readRestored(signal).importNotice;
  if (n === null) return signal;
  return { ...signal, importNotice: { ...n, sentAt: now } };
}
