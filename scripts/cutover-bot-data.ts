/**
 * cutover-bot-data.ts (B50 section 3, plan grind #46 + #62): archives the OLD bot's data at the cutover. Move, never delete.
 *
 *   node ./node_modules/tsx/dist/cli.mjs scripts/cutover-bot-data.ts --data-dir <abs> [--state <cutover-state.json>] [--execute]
 *
 *   --data-dir <abs>      REQUIRED. The live bot data folder (from cutover-state.json). There is no default and `B\data` is never assumed.
 *   --state <file>        cutover-state.json: the per-position choices ("leave unmanaged" with its written acknowledgement).
 *   --leave <ca>:<wallet> acknowledge one open position as "leave unmanaged" (repeatable; the flag itself is the acknowledgement).
 *   --accept-unmigrated   the user's explicit choice to archive even though an open position is neither migrated nor acknowledged.
 *   --logs-dir <abs>      also archive the telemetry JSONL files (fires, sells, silenced, scoring-v1) of this folder.
 *   --date YYYY-MM-DD     the archive folder's date (default: today, UTC).
 *   --execute             move the files. Without it (the default, `--dry-run`) the run prints the plan and moves nothing.
 *
 * Exit codes: 0 = ok (a dry run included), 1 = refused (nothing was moved), 2 = usage or environment error, or an archive that did not verify.
 *
 * It FIRST prints the open positions of positions.json, each marked migrated (present in positions-v2.json), left unmanaged
 * (acknowledged) or UNRESOLVED. While any is UNRESOLVED it refuses to archive positions.json and orders.json (and therefore
 * everything: the set moves as one) unless --accept-unmigrated is given.
 *
 * It moves positions.json, orders.json, sent-signals-dedup.json, autobuy-caps.json and the telemetry CSVs (every *.csv of the data
 * folder) to `<data-dir>\_archive-<date>\` with a sha256 manifest (MANIFEST.json, hashed BEFORE the move and re-hashed AFTER it; any
 * difference exits 2). It NEVER moves wallets.json, settings.json, the v2 files or anything under .env*, and it never overwrites a
 * file or a second archive (a folder that already has a manifest refuses a second --execute). Restoring is moving the files back and
 * re-checking their hashes against the manifest.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { systemClock } from '../src/link/clock';
import { writeFileAtomicSync } from '../src/link/atomic-file';
import { POSITIONS_FILE } from '../src/exits/positions-store';
import { LEGACY_ORDERS_FILE, LEGACY_POSITIONS_FILE, choiceFor, parseCutoverState, readLegacyOpen, type CutoverState } from './migrate-positions-v2';

export const MANIFEST_NAME = 'MANIFEST.json';
/** The fixed files of the old bot's state (the telemetry CSVs are matched by extension). */
export const ARCHIVE_FILES: readonly string[] = [LEGACY_POSITIONS_FILE, LEGACY_ORDERS_FILE, 'sent-signals-dedup.json', 'autobuy-caps.json'];
export const TELEMETRY_JSONL: readonly string[] = ['fires.jsonl', 'sells.jsonl', 'silenced.jsonl', 'scoring-v1.jsonl'];
/** Files that must never be moved, whatever else is added to the lists above. */
const NEVER_MOVED = /^(wallets\.json(\..*)?|settings\.json(\..*)?|\.env.*|positions-v2\.json|manual-orders-v2\.json)$/i;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const shortCa = (ca: string): string => (ca.length > 12 ? `${ca.slice(0, 6)}..${ca.slice(-4)}` : ca);

export type PositionState = 'migrated' | 'left' | 'unresolved';
export interface OpenLine { ca: string; walletId: string; tokenAmount: number; state: PositionState; detail: string }

export interface ArchiveFile { source: string; relName: string; archivedAs: string }

export interface ArchiveOptions {
  dataDir: string;
  execute: boolean;
  state?: CutoverState | null;
  leave?: ReadonlySet<string>;
  acceptUnmigrated?: boolean;
  logsDir?: string | null;
  /** YYYY-MM-DD */
  date?: string;
  now?: () => number;
}

export interface ArchivePlan {
  status: 'dry_run' | 'archived' | 'refused';
  reasons: string[];
  open: OpenLine[];
  archiveDir: string;
  files: ArchiveFile[];
  manifestFile: string | null;
}

export const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The open positions of positions.json and what happened to each. `error` is set when positions.json cannot be read. */
export function inspectOpenPositions(o: ArchiveOptions): { open: OpenLine[]; error: string | null } {
  const posPath = path.join(o.dataDir, LEGACY_POSITIONS_FILE);
  if (!fs.existsSync(posPath)) return { open: [], error: null };
  let parsed: unknown;
  try {
    const text = fs.readFileSync(posPath, 'utf8');
    parsed = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return { open: [], error: `${LEGACY_POSITIONS_FILE} cannot be read as JSON, so its open positions cannot be checked` };
  }
  const open = readLegacyOpen(parsed);

  // migrated = present (and open) in positions-v2.json
  const migrated = new Set<string>();
  const v2Path = path.join(o.dataDir, POSITIONS_FILE);
  if (fs.existsSync(v2Path)) {
    try {
      const j = JSON.parse(fs.readFileSync(v2Path, 'utf8')) as unknown;
      const list = Array.isArray(j) ? j : isObj(j) && Array.isArray(j.positions) ? j.positions : [];
      for (const p of list) {
        if (isObj(p) && typeof p.ca === 'string' && typeof p.wallet_id === 'string' && (p.closed_at === null || p.closed_at === undefined)) migrated.add(`${p.ca}:${p.wallet_id}`);
      }
    } catch { /* an unreadable v2 file migrates nothing */ }
  }
  const lines: OpenLine[] = open.map(p => {
    const key = `${p.ca}:${p.walletId}`;
    if (migrated.has(key)) return { ca: p.ca, walletId: p.walletId, tokenAmount: p.tokenAmount, state: 'migrated', detail: 'present in positions-v2.json' };
    const choice = choiceFor(o.state ?? null, p.ca, p.walletId);
    if (o.leave?.has(key)) return { ca: p.ca, walletId: p.walletId, tokenAmount: p.tokenAmount, state: 'left', detail: 'left unmanaged (acknowledged with --leave)' };
    if (choice !== null && choice.choice === 'leave' && choice.ack !== null) {
      return { ca: p.ca, walletId: p.walletId, tokenAmount: p.tokenAmount, state: 'left', detail: `left unmanaged (acknowledged: ${choice.ack.slice(0, 80)})` };
    }
    const why = choice === null ? 'no choice recorded' : choice.choice === 'leave' ? 'chose "leave unmanaged" without a written acknowledgement' : `chose "${choice.choice}" but it is still open here`;
    return { ca: p.ca, walletId: p.walletId, tokenAmount: p.tokenAmount, state: 'unresolved', detail: `neither migrated nor acknowledged (${why})` };
  });
  return { open: lines, error: null };
}

/** Builds the plan and, with `execute`, runs it. Reads the folder; moves nothing unless executing and not refused. */
export function archiveBotData(o: ArchiveOptions): ArchivePlan {
  const now = (o.now ?? (() => systemClock.now()))();
  const date = o.date ?? utcDate(now);
  const archiveDir = path.join(o.dataDir, `_archive-${date}`);
  const plan: ArchivePlan = { status: o.execute ? 'archived' : 'dry_run', reasons: [], open: [], archiveDir, files: [], manifestFile: null };
  const refuse = (why: string): ArchivePlan => { plan.status = 'refused'; plan.reasons.push(why); return plan; };

  if (!fs.existsSync(o.dataDir) || !fs.statSync(o.dataDir).isDirectory()) return refuse(`${o.dataDir} is not a folder`);

  const ins = inspectOpenPositions(o);
  plan.open = ins.open;
  const unresolved = ins.open.filter(l => l.state === 'unresolved');
  if (ins.error !== null && o.acceptUnmigrated !== true) return refuse(ins.error);
  if (unresolved.length > 0 && o.acceptUnmigrated !== true) {
    for (const l of unresolved) plan.reasons.push(`open position ${shortCa(l.ca)} wallet ${l.walletId} is ${l.detail}`);
    plan.status = 'refused';
    plan.reasons.push('refusing to archive positions.json and orders.json: migrate each open position (migrate-positions-v2), acknowledge it as "leave unmanaged", or pass --accept-unmigrated');
    return plan;
  }

  // the files to move
  const names: ArchiveFile[] = [];
  for (const n of ARCHIVE_FILES) names.push({ source: path.join(o.dataDir, n), relName: n, archivedAs: path.join(archiveDir, n) });
  for (const e of fs.readdirSync(o.dataDir, { withFileTypes: true })) {
    if (e.isFile() && /\.csv$/i.test(e.name)) names.push({ source: path.join(o.dataDir, e.name), relName: e.name, archivedAs: path.join(archiveDir, e.name) });
  }
  if (o.logsDir) {
    for (const n of TELEMETRY_JSONL) names.push({ source: path.join(o.logsDir, n), relName: `logs/${n}`, archivedAs: path.join(archiveDir, 'logs', n) });
  }
  plan.files = names.filter(f => !NEVER_MOVED.test(path.basename(f.source)) && fs.existsSync(f.source) && fs.statSync(f.source).isFile());

  if (plan.files.length === 0) {              // nothing of the old bot's state is here (already archived?): no folder, no manifest
    plan.reasons.push('nothing to archive: none of the old bot state files is in this folder');
    return plan;
  }

  if (o.execute) {
    if (fs.existsSync(path.join(archiveDir, MANIFEST_NAME))) return refuse(`${archiveDir} already has a manifest: the data was archived before; nothing was moved`);
    for (const f of plan.files) if (fs.existsSync(f.archivedAs)) return refuse(`${f.archivedAs} already exists; an archive file is never overwritten`);
  }
  if (!o.execute) return plan;

  // hash BEFORE the move, move, hash AFTER, compare
  const entries: Array<{ name: string; archivedAs: string; bytes: number; sha256: string; mtimeMs: number }> = [];
  for (const f of plan.files) {
    const raw = fs.readFileSync(f.source);
    entries.push({ name: f.relName, archivedAs: path.relative(archiveDir, f.archivedAs).split(path.sep).join('/'), bytes: raw.length, sha256: sha256(raw), mtimeMs: fs.statSync(f.source).mtimeMs });
  }
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const f of plan.files) {
    fs.mkdirSync(path.dirname(f.archivedAs), { recursive: true });
    fs.renameSync(f.source, f.archivedAs);
  }
  const manifest = {
    schema: 1,
    createdAt: now,
    date,
    dataDir: o.dataDir,
    acceptedUnmigrated: o.acceptUnmigrated === true,
    openPositions: plan.open.map(l => ({ ca: l.ca, wallet_id: l.walletId, token_amount: l.tokenAmount, state: l.state, detail: l.detail })),
    neverMoved: ['wallets.json', 'settings.json', 'positions-v2.json', 'manual-orders-v2.json', '.env*'],
    files: entries,
  };
  writeFileAtomicSync(path.join(archiveDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  writeFileAtomicSync(path.join(archiveDir, 'README.txt'), [
    'Old bot data, archived at the cutover (move, never delete; B50 section 3).',
    'MANIFEST.json lists every file with its sha256 as it was before the move.',
    'To restore: move the files back to the data folder and compare their sha256 with the manifest.',
    'wallets.json, settings.json and the .env files were NOT touched.',
    '',
  ].join('\n'));
  plan.manifestFile = path.join(archiveDir, MANIFEST_NAME);
  const bad = verifyManifest(archiveDir);
  if (bad.length > 0) { plan.status = 'refused'; plan.reasons.push(`the archive did not verify: ${bad.join('; ')}`); }
  return plan;
}

/** Re-hashes every file of an archive against its manifest. Returns the problems (empty = verified). */
export function verifyManifest(archiveDir: string): string[] {
  const problems: string[] = [];
  let m: { files?: Array<{ name: string; archivedAs: string; bytes: number; sha256: string }> };
  try { m = JSON.parse(fs.readFileSync(path.join(archiveDir, MANIFEST_NAME), 'utf8')); } catch { return [`${MANIFEST_NAME} cannot be read`]; }
  for (const f of m.files ?? []) {
    try {
      const raw = fs.readFileSync(path.join(archiveDir, ...f.archivedAs.split('/')));
      if (raw.length !== f.bytes) problems.push(`${f.name}: ${raw.length} bytes, the manifest says ${f.bytes}`);
      else if (sha256(raw) !== f.sha256) problems.push(`${f.name}: sha256 differs from the manifest`);
    } catch {
      problems.push(`${f.name}: missing from the archive`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// report and CLI
// ---------------------------------------------------------------------------------------------------------------------------------

export function renderPlan(p: ArchivePlan): string[] {
  const lines: string[] = [];
  lines.push(`open positions in positions.json: ${p.open.length}`);
  for (const l of p.open) lines.push(`  ${l.ca} wallet ${l.walletId} tokenAmount=${l.tokenAmount}: ${l.state.toUpperCase()} - ${l.detail}`);
  lines.push(`cutover-bot-data: ${p.status}${p.status === 'dry_run' ? ' (nothing is moved; pass --execute to move)' : ''}`);
  for (const why of p.reasons) lines.push(`  ${p.status === 'refused' ? 'REFUSED: ' : ''}${why}`);
  if (p.status !== 'refused' || p.files.length > 0) {
    lines.push(`  archive folder: ${p.archiveDir}`);
    if (p.files.length === 0) lines.push('  no file to archive');
    for (const f of p.files) lines.push(`  ${p.status === 'archived' ? 'moved' : 'would move'} ${f.relName}`);
  }
  if (p.manifestFile) lines.push(`  manifest: ${p.manifestFile}`);
  lines.push('  wallets.json and the .env files are never touched');
  return lines;
}

interface Cli {
  dataDir: string | null; state: string | null; leave: string[]; accept: boolean; logsDir: string | null; date: string | null; execute: boolean; bad: string | null;
}

export function parseArgs(argv: readonly string[]): Cli {
  const c: Cli = { dataDir: null, state: null, leave: [], accept: false, logsDir: null, date: null, execute: false, bad: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | null => (i + 1 < argv.length ? argv[++i] : null);
    if (a === '--data-dir') c.dataDir = next();
    else if (a === '--state') c.state = next();
    else if (a === '--leave') { const v = next(); if (v) c.leave.push(v); else c.bad = '--leave needs <ca>:<walletId>'; }
    else if (a === '--accept-unmigrated') c.accept = true;
    else if (a === '--logs-dir') c.logsDir = next();
    else if (a === '--date') c.date = next();
    else if (a === '--execute') c.execute = true;
    else if (a === '--dry-run') c.execute = false;
    else c.bad = `unknown argument ${a}`;
  }
  return c;
}

export async function main(argv: readonly string[], out: (line: string) => void = console.log): Promise<number> {
  const c = parseArgs(argv);
  if (c.bad !== null) { out(`usage error: ${c.bad}`); return 2; }
  if (c.dataDir === null || !path.isAbsolute(c.dataDir)) { out('usage error: --data-dir <absolute folder> is required (from cutover-state.json; there is no default)'); return 2; }
  if (c.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(c.date)) { out('usage error: --date must be YYYY-MM-DD'); return 2; }
  if (c.logsDir !== null && !path.isAbsolute(c.logsDir)) { out('usage error: --logs-dir must be an absolute folder'); return 2; }
  let state: CutoverState | null = null;
  if (c.state !== null) {
    try { state = parseCutoverState(JSON.parse(fs.readFileSync(c.state, 'utf8'))); } catch { out(`usage error: ${c.state} cannot be read as JSON`); return 2; }
  }
  const plan = archiveBotData({
    dataDir: c.dataDir, execute: c.execute, state, leave: new Set(c.leave), acceptUnmigrated: c.accept, logsDir: c.logsDir, date: c.date ?? undefined,
  });
  for (const line of renderPlan(plan)) out(line);
  if (plan.status === 'refused' && plan.reasons.some(r => r.startsWith('the archive did not verify'))) return 2;
  return plan.status === 'refused' ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error(`cutover-bot-data failed: ${(e as Error)?.message ?? e}`); process.exitCode = 2; });
}
