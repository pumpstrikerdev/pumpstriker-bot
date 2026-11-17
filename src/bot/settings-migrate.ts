/**
 * settings-migrate.ts (B50 section 3, R4-B6; read-bot-interface 5.6; A-115 CARD-MENU spec section 7.2): `settings.json` -> schema 2.
 *
 *   - An OLD-format file (no `schema`, `schema: 1`, or a `signal` with the old score keys and no grade presets) is IMPORTED, not dropped
 *     (A-115): the restored keys (Active, Min Score, the MCap and liquidity bands, Auto-Sell by Grade, the grade presets from the score
 *     tiers) are filled by settings-import.ts `importOldSignal`, the whole old `signal` object is kept verbatim in `signal.legacy.oldSignal`
 *     and a one-time Telegram summary is queued in `signal.importNotice`. `dropped` stays empty; `notApplicable` names (never values) the
 *     old keys that have no control any more.
 *   - A schema-2 file without the restored keys (a file the 746bf27 migration already stripped) gets their defaults and nothing is imported
 *     automatically; when the data folder still holds an old-format copy (settings.json.bak-* or settings.old-bot.json), the notice says
 *     to tap /importsettings.
 *   - `signal.tgMinGrade: 'B'` is added (an existing valid value is kept: A, B or C); `signal.buyAmount`, `signal.slippageBps`,
 *     `signal.degenMode` and the session window are kept, `global.*` and `rebates` are kept as they are, and so is any other top-level key.
 *   - `schema: 2` marks the file.
 *
 * Idempotent: a file that is already schema 2 and already normal is not touched (no write, no backup). A run that does change the
 * file writes `settings.json.bak-<stamp>` FIRST (a byte-for-byte copy of the file as it was), then replaces the file atomically. A
 * file that cannot be read as a JSON object is never overwritten (the result says `unreadable`). Nothing here reads the wall clock:
 * the caller passes `now`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomicSync } from '../link/atomic-file';
import type { ResolvedPolicy } from '../shared/exit-policy/exit-policy';
import { defaultActivePolicy, importOldSignal, importSummary, isOldFormat, listImportCandidates, sha256Of } from './settings-import';
import { RESTORED_SIGNAL_KEYS, restoredDefaults } from './signal-settings';

export const SETTINGS_FILE = 'settings.json';
export const SETTINGS_SCHEMA = 2 as const;
export type TgMinGrade = 'A' | 'B' | 'C';
export const DEFAULT_TG_MIN_GRADE: TgMinGrade = 'B';

/** The `signal.*` keys kept as they are since R4-B6. */
export const KEPT_SIGNAL_KEYS: readonly string[] = [
  'buyAmount', 'slippageBps', 'degenMode', 'sessionEnabled', 'sessionPreset', 'sessionStart', 'sessionEnd', 'sessionTz',
];
/** Every `signal.*` key of schema 2 (A-115 added the restored ones); anything else in `signal` is dropped from a schema-2 file. */
export const SCHEMA2_SIGNAL_KEYS: readonly string[] = [...KEPT_SIGNAL_KEYS, 'tgMinGrade', ...RESTORED_SIGNAL_KEYS];

export interface MigrateOutcome {
  /** The normalised document (what the file holds after a successful migration). */
  doc: Record<string, unknown>;
  /** True when `doc` differs from the input. */
  changed: boolean;
  /** Names (never values) of the keys that were dropped from `signal` (a schema-2 file only; an old file is imported, never dropped). */
  dropped: string[];
  /** A-115: names of the old keys that were kept in `signal.legacy` but have no control any more. */
  notApplicable: string[];
  /** A-115: the restored keys were imported from the old `signal`. */
  imported: boolean;
}

export interface MigrateOpts {
  now?: number;
  /** The active exit policy (its stop stands in for an old tier without a stop-loss). Default: EA of the shared policy file. */
  active?: Pick<ResolvedPolicy, 'legs'>;
  /** The name the import summary and `legacy.importedFrom` show (default settings.json). */
  sourceName?: string;
  /** sha256 of the source file bytes (default: of the old signal's JSON). */
  sourceSha?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function isTgMinGrade(v: unknown): v is TgMinGrade {
  return v === 'A' || v === 'B' || v === 'C';
}

/** Pure. Normalises any parsed settings document to schema 2. Never mutates its input. */
export function migrateSettingsDoc(input: Record<string, unknown>, opts: MigrateOpts = {}): MigrateOutcome {
  const now = opts.now ?? 0;
  const out: Record<string, unknown> = { schema: SETTINGS_SCHEMA };
  const dropped: string[] = [];
  let notApplicable: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (k === 'schema' || k === 'signal') continue;
    out[k] = v;
  }
  const sig = isObj(input.signal) ? input.signal : {};
  const nextSig: Record<string, unknown> = {};
  for (const k of KEPT_SIGNAL_KEYS) if (k in sig) nextSig[k] = sig[k];
  nextSig.tgMinGrade = isTgMinGrade(sig.tgMinGrade) ? sig.tgMinGrade : DEFAULT_TG_MIN_GRADE;
  const old = isOldFormat(input);
  if (old) {
    // A-115: import, never drop
    const r = importOldSignal(sig, opts.active ?? defaultActivePolicy(), now);
    Object.assign(nextSig, r.restored);
    const name = opts.sourceName ?? SETTINGS_FILE;
    nextSig.legacy = { importedFrom: name, sha256: opts.sourceSha ?? sha256Of(JSON.stringify(sig)), importedAt: now, oldSignal: JSON.parse(JSON.stringify(sig)) };
    nextSig.importNotice = { createdAt: now, text: importSummary(r, name), sentAt: null };
    notApplicable = r.notApplicable.map(n => n.key);
  } else {
    const d = restoredDefaults() as unknown as Record<string, unknown>;
    for (const k of RESTORED_SIGNAL_KEYS) nextSig[k] = k in sig ? sig[k] : d[k];
    for (const k of Object.keys(sig)) if (!SCHEMA2_SIGNAL_KEYS.includes(k)) dropped.push(k);
  }
  out.signal = nextSig;
  const changed = JSON.stringify(canonical(input)) !== JSON.stringify(canonical(out));
  return { doc: out, changed, dropped, notApplicable, imported: old };
}

/** Key-order independent form, so "changed" compares content and not the order the keys happen to be in. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}

export type MigrateStatus = 'migrated' | 'already_v2' | 'missing' | 'unreadable';
export interface MigrateResult {
  status: MigrateStatus;
  /** The backup file written by this run, or null (nothing changed, or nothing to back up). */
  backupFile: string | null;
  dropped: string[];
  /** A-115 */
  notApplicable: string[];
  imported: boolean;
  /** A-115: an old-format copy the owner can re-import with /importsettings (a schema-2 file that lost the restored keys). */
  importCandidate: string | null;
}

/** `YYYYMMDD-HHMMSS` in UTC. */
export function backupStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

const nothing = (status: MigrateStatus): MigrateResult => ({ status, backupFile: null, dropped: [], notApplicable: [], imported: false, importCandidate: null });

/**
 * Migrates `<dir>/settings.json`. `missing`: no file, nothing to do. `unreadable`: not a JSON object, left untouched (the owner fixes
 * or moves it). `already_v2`: nothing to change. `migrated`: backup written, then the new file.
 */
export function migrateSettingsFile(dir: string, now: () => number, active?: Pick<ResolvedPolicy, 'legs'>): MigrateResult {
  const file = path.join(dir, SETTINGS_FILE);
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return nothing('missing');
    return nothing('unreadable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return nothing('unreadable');
  }
  if (!isObj(parsed)) return nothing('unreadable');

  const t = now();
  const m = migrateSettingsDoc(parsed, { now: t, active, sourceName: SETTINGS_FILE, sourceSha: sha256Of(raw) });
  if (!m.changed) return nothing('already_v2');

  // A-115: a schema-2 file that lost the restored keys earlier: point the owner at the old-format copy (never imported automatically)
  let importCandidate: string | null = null;
  const sigIn = isObj(parsed.signal) ? parsed.signal : {};
  if (!m.imported && !RESTORED_SIGNAL_KEYS.some(k => k in sigIn)) {
    const c = listImportCandidates(dir);
    if (c.length > 0) {
      importCandidate = c[0].name;
      (m.doc.signal as Record<string, unknown>).importNotice = {
        createdAt: t, sentAt: null,
        text: `♻️ Your previous update dropped settings (Min Score, the MCap and liquidity limits, the score-tier sell presets). Tap /importsettings to bring them back from ${c[0].name}.`,
      };
    }
  }

  // The backup comes first and must be on disk before the file changes. A name that exists is never overwritten.
  const stamp = backupStamp(t);
  let backup = path.join(dir, `${SETTINGS_FILE}.bak-${stamp}`);
  for (let n = 1; fs.existsSync(backup); n++) backup = path.join(dir, `${SETTINGS_FILE}.bak-${stamp}-${n}`);
  writeFileAtomicSync(backup, raw);
  writeFileAtomicSync(file, JSON.stringify(m.doc, null, 2));
  return { status: 'migrated', backupFile: backup, dropped: m.dropped, notApplicable: m.notApplicable, imported: m.imported, importCandidate };
}
