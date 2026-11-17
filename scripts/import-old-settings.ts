/**
 * import-old-settings.ts (A-115, CARD-MENU spec section 7.4): the one-shot re-import of the owner's old settings from a named old-format
 * file, the script twin of the bot's /importsettings command (the same pure import, the same document).
 *
 *   npm run import-old-settings -- <path to the old settings.json> [--data-dir <bot data folder>] --bot-stopped
 *
 * Only the restored keys are written into <data-dir>/settings.json (Active, Min Score, the MCap and liquidity limits, Auto-Sell by Grade,
 * the grade presets, plus the verbatim legacy copy and the one-time Telegram summary the bot sends at its next start); every other key
 * stays as it is, and a backup of settings.json is written first. The same source twice writes nothing. It refuses to run without
 * --bot-stopped: the running bot caches its settings and would overwrite the file. No network, no .env: the data folder defaults to
 * "TG Bot/data" next to this script.
 */
import * as path from 'node:path';
import { importIntoSettingsFile, readOldFormatPath } from '../src/bot/settings-import';

export interface CliResult { code: number; lines: string[] }

export function runImportCli(argv: readonly string[], now: number, defaultDataDir = path.resolve(__dirname, '..', 'data')): CliResult {
  const lines: string[] = [];
  const args = [...argv];
  let dataDir = defaultDataDir;
  let stopped = false;
  const rest: string[] = [];
  while (args.length > 0) {
    const a = args.shift() as string;
    if (a === '--bot-stopped') stopped = true;
    else if (a === '--data-dir') { const d = args.shift(); if (d === undefined) return { code: 2, lines: ['--data-dir needs a folder'] }; dataDir = path.resolve(d); }
    else rest.push(a);
  }
  if (rest.length !== 1) return { code: 2, lines: ['usage: npm run import-old-settings -- <old settings.json> [--data-dir <dir>] --bot-stopped'] };
  if (!stopped) return { code: 2, lines: ['refused: stop the bot first and pass --bot-stopped (a running bot would overwrite settings.json from its cache)'] };
  const file = path.resolve(rest[0]);
  const read = readOldFormatPath(file);
  if (!read.ok) return { code: 1, lines: [`refused: ${read.reason}; nothing was written`] };
  const out = importIntoSettingsFile(dataDir, { name: path.basename(file), doc: read.doc, sha256: read.sha256 }, now);
  if (out.status !== 'imported') return { code: out.status === 'already' ? 0 : 1, lines: [String(out.reason)] };
  lines.push(`imported into ${path.join(dataDir, 'settings.json')} (backup: ${out.backupFile === null || out.backupFile === undefined ? 'none, there was no file' : path.basename(out.backupFile)})`);
  lines.push('', String(out.summary));
  return { code: 0, lines };
}

if (require.main === module) {
  const r = runImportCli(process.argv.slice(2), Date.now());
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
