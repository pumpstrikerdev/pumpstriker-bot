/**
 * A-115 (CARD-MENU spec section 7, "C2: the owner's old settings back"): the import of an old-format settings file (IMPORT-T01 ... T11).
 * The fixture test-fixtures/settings/old-bot.json is SHAPED like the owner's old file (the same keys, six score tiers) with fake values.
 * Temp folders only; nothing here touches the network.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPolicies } from '../shared/exit-policy/exit-policy';
import policiesJson from '../shared/exit-policy/exit-policies.json';
import type { CustomPreset } from '../exits/presets';
import { migrateSettingsDoc, migrateSettingsFile, SETTINGS_FILE } from './settings-migrate';
import {
  IMPORT_NAME_RE, importIntoSettingsFile, importOldSignal, importSummary, isOldFormat, listImportCandidates, markNoticeSent, mergeImport, minScoreNote,
  noticeToSend, readOldFormat, sha256Of, tierToPreset,
} from './settings-import';
import { readRestored } from './signal-settings';

const EA = loadPolicies(policiesJson).EA;
const FIXTURE = path.resolve(__dirname, '..', '..', 'test-fixtures', 'settings', 'old-bot.json');
const T0 = Date.UTC(2026, 9, 27, 9, 0, 0);
const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-import-'));
  dirs.push(d);
  return d;
}
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const oldDoc = (): Record<string, any> => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const read = (f: string): Record<string, any> => JSON.parse(fs.readFileSync(f, 'utf8'));
const backups = (dir: string): string[] => fs.readdirSync(dir).filter(n => /^settings\.json\.bak-/.test(n)).sort();

describe('the boot migration imports an old file', () => {
  it('IMPORT-T01 minScore, the bounds (null stays null), enabled, autoSellOnSignal and the tiers -> A/B/C; global, rebates, session and buyAmount untouched; backup first', () => {
    const dir = tmp();
    const raw = fs.readFileSync(FIXTURE);
    fs.writeFileSync(path.join(dir, SETTINGS_FILE), raw);
    const r = migrateSettingsFile(dir, () => T0, EA);
    expect(r).toMatchObject({ status: 'migrated', imported: true, dropped: [] });
    expect(backups(dir)).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, backups(dir)[0]))).toEqual(raw);   // the backup is the old file, byte for byte
    const doc = read(path.join(dir, SETTINGS_FILE));
    const old = oldDoc();
    expect(doc.schema).toBe(2);
    expect(doc.global).toEqual(old.global);
    expect(doc.rebates).toEqual(old.rebates);
    expect(doc.signal).toMatchObject({
      enabled: true, minScore: 90, minMcap: null, maxMcap: 150000, minLiquidity: null, maxLiquidity: null, autoSellOnSignal: true,
      buyAmount: old.signal.buyAmount, sessionEnabled: true, sessionPreset: 'europe', sessionStart: '08:00', sessionEnd: '17:00', sessionTz: 'Europe/London',
    });
    expect(doc.signal.gradePresets.A).toMatchObject({ mode: 'custom', source: 'imported:tier5', rev: 1, enabled: true });
    expect(doc.signal.gradePresets.B).toMatchObject({ mode: 'custom', source: 'imported:tier4' });
    expect(doc.signal.gradePresets.C).toMatchObject({ mode: 'custom', source: 'imported:tier3' });
    expect(doc.signal.legacy).toMatchObject({ importedFrom: 'settings.json', sha256: sha256Of(raw), importedAt: T0 });
    // the file reads back through the bot's checks without a warning
    const warns: string[] = [];
    expect(readRestored(doc.signal, m => warns.push(m)).gradePresets.A).toEqual(doc.signal.gradePresets.A);
    expect(warns).toEqual([]);
    // idempotent: a second boot touches nothing
    expect(migrateSettingsFile(dir, () => T0 + 1, EA).status).toBe('already_v2');
    expect(backups(dir)).toHaveLength(1);
  });
});

describe('importOldSignal', () => {
  it('IMPORT-T02 % of the holdings -> % of the original (25, 35 -> 25, 26.25); SL -> an always-on stop; TSL arm/trail; a legacy positive TSL; partial SL; > 3 TPs; durations', () => {
    const r = importOldSignal(oldDoc().signal, EA, T0);
    const A = r.restored.gradePresets.A as CustomPreset;
    const B = r.restored.gradePresets.B as CustomPreset;
    const C = r.restored.gradePresets.C as CustomPreset;
    expect(A.stop).toEqual({ lossPct: 35, whilePeakBelowPct: null });
    expect(A.ladder.map(x => [x.atPct, x.sellPctOfOriginal])).toEqual([[80, 25], [400, 26.25]]);
    expect(A.trail).toEqual({ armAfterPct: 200, trailPct: 40, trigger: 'entryPrice' });
    expect(B.ladder.map(x => [x.atPct, x.sellPctOfOriginal])).toEqual([[50, 35], [250, 22.75]]);
    expect(B.trail).toMatchObject({ armAfterPct: 120, trailPct: 35 });
    expect(C.ladder.map(x => [x.atPct, x.sellPctOfOriginal])).toEqual([[30, 40], [150, 21]]);
    expect(C.stop).toEqual({ lossPct: 25, whilePeakBelowPct: null });
    for (const p of [A, B, C]) { expect(p.maxHoldH).toBeNull(); expect(p.mode).toBe('custom'); }
    expect(r.mapping.every(m => m.notes.some(n => n.startsWith('order durations')))).toBe(true);
    // a legacy positive TSL: its % becomes the arm level and the trail is the old default 30%
    const legacy = tierToPreset({ id: 'x', enabled: true, presets: [{ type: 'sl', triggerPct: -20, balance: 100 }, { type: 'tsl', triggerPct: 50, balance: 100 }] }, EA, T0);
    expect(legacy.preset?.trail).toEqual({ armAfterPct: 50, trailPct: 30, trigger: 'entryPrice' });
    expect(legacy.notes.some(n => n.includes('legacy positive trailing stop'))).toBe(true);
    // a stop that sold only part: a full stop now, listed
    const partial = tierToPreset({ id: 'y', enabled: true, presets: [{ type: 'sl', triggerPct: -20, balance: 50 }] }, EA, T0);
    expect(partial.preset?.stop).toEqual({ lossPct: 20, whilePeakBelowPct: null });
    expect(partial.notes.some(n => n.includes('stop sold 50%'))).toBe(true);
    // more than 3 TPs: the first 3 by trigger, the rest listed
    const many = tierToPreset({ id: 'z', enabled: false, presets: [400, 10, 200, 50].map(p => ({ type: 'tp', triggerPct: p, balance: 10 })).concat([{ type: 'sl', triggerPct: -30, balance: 100 }]) }, EA, T0);
    expect(many.preset?.ladder.map(x => x.atPct)).toEqual([10, 50, 200]);
    expect(many.preset?.enabled).toBe(false);
    expect(many.notes.some(n => n.includes('1 take-profit(s) above the first three'))).toBe(true);
  });

  it('IMPORT-T03 tiers entirely below 85 are not applicable; fewer than three reachable tiers leave the other grades on the policy; a tier without SL gets the policy stop', () => {
    const r = importOldSignal(oldDoc().signal, EA, T0);
    expect(r.unused.map(u => u.tierId)).toEqual(['tier0', 'tier1', 'tier2']);
    expect(r.unused.every(u => u.why === 'no card is sent below 85')).toBe(true);
    const two = importOldSignal({ scoreTiers: [
      { id: 'low', label: 'Low', minScore: 0, maxScore: 85, enabled: true, presets: [] },
      { id: 'hi', label: 'High', minScore: 90, maxScore: 101, enabled: true, presets: [{ type: 'tp', triggerPct: 100, balance: 50 }] },
    ] }, EA, T0);
    expect(two.restored.gradePresets.A).toMatchObject({ mode: 'custom', source: 'imported:hi', stop: { lossPct: 38, whilePeakBelowPct: 50 } });
    expect(two.mapping[0].notes).toContain('no stop-loss in this tier: the exit policy\'s stop is used');
    expect(two.restored.gradePresets.B).toEqual({ mode: 'policy' });
    expect(two.restored.gradePresets.C).toEqual({ mode: 'policy' });
    expect(two.unused.map(u => u.tierId)).toEqual(['low']);
  });

  it('IMPORT-T04 the not-applicable keys stay verbatim in legacy.oldSignal (deep-equal to the input) and are listed with their reasons', () => {
    const old = oldDoc();
    const m = migrateSettingsDoc(old, { now: T0 });
    expect((m.doc.signal as any).legacy.oldSignal).toEqual(old.signal);
    const r = importOldSignal(old.signal, EA, T0);
    const keys = r.notApplicable.map(n => n.key).sort();
    expect(keys).toEqual(['autoBuyHotFilter', 'autoBuyMinScore', 'autoBuyOnUpgrade', 'duplicateBuy']);
    for (const n of r.notApplicable) expect(n.why.length).toBeGreaterThan(10);
    const text = importSummary(r, 'settings.json', 'OFF');
    expect(text).toContain('Dupe Buy (one auto-buy per token is always enforced)');
    expect(text).toContain('HOT-only filter (no HOT/COLD tag any more)');
    expect(text).toContain('it is OFF now');
  });

  it('IMPORT-T10 minScore 90 stays 90; a string, NaN or negative minScore is not imported (listed); an old 0 bound means no limit', () => {
    expect(importOldSignal({ minScore: 90 }).restored.minScore).toBe(90);
    for (const bad of ['90', Number.NaN, -5, 101, 90.5]) {
      const r = importOldSignal({ minScore: bad });
      expect(r.restored.minScore, String(bad)).toBeNull();
      expect(r.problems.some(p => p.startsWith('minScore was not imported')), String(bad)).toBe(true);
    }
    const b = importOldSignal({ minMcap: 0, maxMcap: 0, minLiquidity: -1, maxLiquidity: 'x' });
    expect(b.restored).toMatchObject({ minMcap: null, maxMcap: null, minLiquidity: null, maxLiquidity: null });
    expect(b.problems.filter(p => p.includes('not a positive USD amount'))).toHaveLength(2);
    const inverted = importOldSignal({ minLiquidity: 9000, maxLiquidity: 1000 });
    expect(inverted.restored).toMatchObject({ minLiquidity: 9000, maxLiquidity: 1000 });
    expect(inverted.minAboveMax).toEqual(['Liq']);
  });
});

describe('the one-time summary', () => {
  it('IMPORT-T07 sent once (sentAt persisted, not re-sent after a restart), with the scale note, the tier -> grade lines and the not-applicable lines; Markdown-safe', () => {
    const m = migrateSettingsDoc(oldDoc(), { now: T0 });
    const sig = m.doc.signal as Record<string, unknown>;
    const text = noticeToSend(sig);
    expect(text).not.toBeNull();
    expect(text).toContain('♻️ Your old settings are back (from settings.json)');
    expect(text).toContain(minScoreNote(90));
    expect(minScoreNote(90)).toContain('90 shows only ULTRA cards and hides 85-89; the old and new scorers differ, so 90 does not pick the same tokens. Blank = every card.');
    expect(text).toContain('📈 Max MCap $150,000 · Min MCap, Min Liq, Max Liq: no limit');
    expect(text).toContain('🟢 Signals: Active · 💸 Auto-Sell by Grade: ON');
    expect(text).toContain(' A ← 🌙 Moon Shot (93-100): stop −35% · sell 25% at +80% · 26.25% at +400% · trail −40% once +200%');
    expect(text).toContain(' B ← 🔥 Fire Signal (88-93): stop −30% · sell 35% at +50% · 22.75% at +250% · trail −35% once +120%');
    expect(text).toContain(' C ← 💎 Strong Conviction (82-88): stop −25% · sell 40% at +30% · 21% at +150% · trail −30% once +80%');
    expect(text).toContain('Not used: ⚠️ Risky Play (0-65), 🟡 Alpha Signal (65-75), 💚 High Potential (75-82): no card is sent below 85.');
    expect(text).toContain('Order durations were not imported: stops never expire now.');
    expect(text).toContain('Not applicable (kept in the file):');
    // sent as plain text; still no Markdown entity character comes from the data (the fixed "[A]/[B]/[C]" is the menu's own wording)
    expect(String(text).replace('[A]/[B]/[C]', '')).not.toMatch(/[*_`[\]]/);
    // a hostile tier label is cleaned
    const hostile = importOldSignal({ scoreTiers: [{ id: 't_[x]', label: '*bold* _it_ [link](x) `c`', minScore: 90, maxScore: 101, enabled: true, presets: [{ type: 'sl', triggerPct: -20 }] }] });
    expect(importSummary(hostile, 'settings.json').replace('[A]/[B]/[C]', '')).not.toMatch(/[*_`[\]]/);
    // sent: marked, and a restart does not send it again
    const after = markNoticeSent(sig, T0 + 5);
    expect(noticeToSend(after)).toBeNull();
    expect((after.importNotice as any).sentAt).toBe(T0 + 5);
    const reloaded = readRestored(JSON.parse(JSON.stringify(after)));
    expect(reloaded.importNotice?.sentAt).toBe(T0 + 5);
  });
});

describe('re-import of an already-v2 file', () => {
  /** The live test bot's situation: the 746bf27 code migrated the old file (dropping the keys) and kept the old file as settings.json.bak-<stamp>. */
  function strippedFolder(): { dir: string; bakName: string } {
    const dir = tmp();
    const old = oldDoc();
    const bakName = 'settings.json.bak-20261027-080000';
    fs.writeFileSync(path.join(dir, bakName), JSON.stringify(old, null, 2));
    const stripped = { schema: 2, global: old.global, signal: { buyAmount: old.signal.buyAmount, slippageBps: null, degenMode: null, sessionEnabled: true, sessionPreset: 'europe',
      sessionStart: '08:00', sessionEnd: '17:00', sessionTz: 'Europe/London', tgMinGrade: 'B' }, rebates: old.rebates };
    fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(stripped, null, 2));
    return { dir, bakName };
  }

  it('IMPORT-T05 no automatic import, the notice points to /importsettings; the import from the .bak- file fills the restored keys only, every other key unchanged, backup written', () => {
    const { dir, bakName } = strippedFolder();
    const r = migrateSettingsFile(dir, () => T0, EA);
    expect(r).toMatchObject({ status: 'migrated', imported: false, importCandidate: bakName });
    const migrated = read(path.join(dir, SETTINGS_FILE));
    expect(migrated.signal.minScore).toBeNull();
    expect(migrated.signal.gradePresets).toEqual({ A: { mode: 'policy' }, B: { mode: 'policy' }, C: { mode: 'policy' } });
    expect(noticeToSend(migrated.signal)).toContain(`/importsettings to bring them back from ${bakName}`);
    expect(listImportCandidates(dir).map(c => c.name)).toEqual([bakName]);   // the migration's own backup of a schema-2 file is not old format

    const src = readOldFormat(dir, bakName);
    expect(src.ok).toBe(true);
    if (!src.ok) return;
    const before = backups(dir).length;
    const out = importIntoSettingsFile(dir, { name: bakName, doc: src.doc, sha256: src.sha256 }, T0 + 60_000, EA);
    expect(out.status).toBe('imported');
    expect(backups(dir)).toHaveLength(before + 1);
    const doc = read(path.join(dir, SETTINGS_FILE));
    const restoredKeys = ['enabled', 'minScore', 'minMcap', 'maxMcap', 'minLiquidity', 'maxLiquidity', 'autoSellOnSignal', 'gradePresets', 'legacy', 'importNotice'];
    for (const k of Object.keys(migrated.signal)) if (!restoredKeys.includes(k)) expect(doc.signal[k], k).toEqual(migrated.signal[k]);
    expect(doc.global).toEqual(migrated.global);
    expect(doc.rebates).toEqual(migrated.rebates);
    expect(doc.schema).toBe(2);
    expect(doc.signal).toMatchObject({ minScore: 90, maxMcap: 150000, enabled: true, autoSellOnSignal: true });
    expect(doc.signal.gradePresets.A.source).toBe('imported:tier5');
    expect(doc.signal.legacy).toMatchObject({ importedFrom: bakName, sha256: src.sha256 });
    expect(noticeToSend(doc.signal)).toContain('♻️ Your old settings are back');
  });

  it('IMPORT-T06 idempotent: the same source twice -> no write, no backup, no second notice', () => {
    const { dir, bakName } = strippedFolder();
    migrateSettingsFile(dir, () => T0, EA);
    const src = readOldFormat(dir, bakName);
    if (!src.ok) throw new Error(src.reason);
    expect(importIntoSettingsFile(dir, { name: bakName, doc: src.doc, sha256: src.sha256 }, T0 + 1, EA).status).toBe('imported');
    // the summary was sent once
    const f = path.join(dir, SETTINGS_FILE);
    const d1 = read(f);
    d1.signal = markNoticeSent(d1.signal, T0 + 2);
    fs.writeFileSync(f, JSON.stringify(d1, null, 2));
    const bytes = fs.readFileSync(f, 'utf8');
    const n = backups(dir).length;
    const again = importIntoSettingsFile(dir, { name: bakName, doc: src.doc, sha256: src.sha256 }, T0 + 3, EA);
    expect(again.status).toBe('already');
    expect(fs.readFileSync(f, 'utf8')).toBe(bytes);
    expect(backups(dir)).toHaveLength(n);
    expect(noticeToSend(read(f).signal)).toBeNull();
    expect(mergeImport(read(f), src.doc, bakName, src.sha256, T0, EA)).toBe('already');
  });

  it('IMPORT-T08 /importsettings only offers data-dir files matching the pattern; a .. / absolute / other name is never read; unreadable or non-object JSON is refused, nothing written', () => {
    const dir = tmp();
    const old = JSON.stringify(oldDoc());
    for (const name of ['settings.old-bot.json', 'settings.json.bak-20261027-080000-1', 'settings.json.bak-x', 'other.json', 'settings.json.bak-20261027-080000.tmp']) fs.writeFileSync(path.join(dir, name), old);
    fs.writeFileSync(path.join(dir, 'settings.json.bak-20261026-000000'), '{ broken');
    fs.writeFileSync(path.join(dir, 'settings.json.bak-20261025-000000'), '[1, 2]');
    expect(listImportCandidates(dir).map(c => c.name).sort()).toEqual(['settings.json.bak-20261027-080000-1', 'settings.old-bot.json']);
    for (const bad of ['../settings.old-bot.json', path.join(dir, 'settings.old-bot.json'), 'other.json', 'settings.json.bak-x', 'sub/settings.json']) {
      expect(readOldFormat(dir, bad)).toEqual({ ok: false, reason: 'that file name is not allowed' });
    }
    expect(readOldFormat(dir, 'settings.json.bak-20261026-000000')).toEqual({ ok: false, reason: 'the file is not JSON' });
    expect(readOldFormat(dir, 'settings.json.bak-20261025-000000')).toEqual({ ok: false, reason: 'the file is not a settings object' });
    expect(IMPORT_NAME_RE.test('settings.json')).toBe(true);
    expect(isOldFormat({ schema: 2, signal: { gradePresets: {} } })).toBe(false);
    expect(isOldFormat({ schema: 2, signal: { minScore: 90, scoreTiers: [] } })).toBe(true);
    // nothing was written while refusing
    expect(fs.existsSync(path.join(dir, SETTINGS_FILE))).toBe(false);
  });

  it('IMPORT-T09 the script gives the same document as the command; refuses without --bot-stopped; no network', async () => {
    const mod = await import(path.resolve(__dirname, '..', '..', 'scripts', 'import-old-settings.ts') as string);
    const runImportCli = mod.runImportCli as (argv: string[], now: number, dataDir?: string) => { code: number; lines: string[] };
    const a = strippedFolderPair();
    expect(runImportCli([a.oldFile, '--data-dir', a.dirScript], T0)).toMatchObject({ code: 2 });
    expect(runImportCli([a.oldFile, '--data-dir', a.dirScript], T0).lines[0]).toContain('--bot-stopped');
    const r = runImportCli([a.oldFile, '--data-dir', a.dirScript, '--bot-stopped'], T0);
    expect(r.code).toBe(0);
    const viaCommand = importIntoSettingsFile(a.dirCommand, { name: path.basename(a.oldFile), doc: JSON.parse(fs.readFileSync(a.oldFile, 'utf8')), sha256: sha256Of(fs.readFileSync(a.oldFile)) }, T0);
    expect(viaCommand.status).toBe('imported');
    expect(read(path.join(a.dirScript, SETTINGS_FILE))).toEqual(read(path.join(a.dirCommand, SETTINGS_FILE)));
    // the script source holds no network module and reads no env file
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'scripts', 'import-old-settings.ts'), 'utf8');
    expect(src).not.toMatch(/require\(['"](https?|net|undici|node-fetch)['"]\)|from ['"](https?|node:https?|undici|node-fetch|net)['"]|dotenv|fetch\(/);
    expect(runImportCli(['/no/such/file.json', '--bot-stopped', '--data-dir', a.dirScript], T0).code).toBe(1);
  });

  /** Two identical stripped folders and an old file outside them. */
  function strippedFolderPair(): { dirScript: string; dirCommand: string; oldFile: string } {
    const base = tmp();
    const oldFile = path.join(base, 'my-old-settings.json');
    fs.writeFileSync(oldFile, JSON.stringify(oldDoc(), null, 2));
    const mk = (n: string): string => {
      const d = path.join(base, n);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, SETTINGS_FILE), JSON.stringify(migrateSettingsDoc({ schema: 2, global: oldDoc().global, signal: { buyAmount: 0.25, tgMinGrade: 'B' } }).doc, null, 2));
      return d;
    };
    return { dirScript: mk('a'), dirCommand: mk('b'), oldFile };
  }
});

describe('a hand-edited schema-2 file', () => {
  it('IMPORT-T11 invalid restored keys load with safe defaults and a warning, never crash, never loosen a set filter', () => {
    const warns: string[] = [];
    const r = readRestored({
      enabled: 'yes', minScore: 'ninety', minMcap: -5, maxMcap: 'lots', minLiquidity: 0, maxLiquidity: null, autoSellOnSignal: 7,
      gradePresets: { A: { mode: 'custom', rev: 1, enabled: true, source: 'owner', updatedAt: 1, stop: { none: true }, ladder: [], trail: null, maxHoldH: null }, B: 'x', C: { mode: 'policy' } },
      importNotice: 'x', legacy: 5,
    }, m => warns.push(m));
    expect(r.enabled).toBe(true);
    expect(r.autoSellOnSignal).toBe(true);
    expect(r.minScore).toBe('invalid');           // set but unreadable: the filter stays closed
    expect(r.minMcap).toBe('invalid');
    expect(r.maxMcap).toBe('invalid');
    expect(r.minLiquidity).toBeNull();             // 0 = no limit
    expect(r.maxLiquidity).toBeNull();
    expect(r.gradePresets).toEqual({ A: { mode: 'policy' }, B: { mode: 'policy' }, C: { mode: 'policy' } });   // an unconfirmed no-stop preset is never loaded
    expect(r.importNotice).toBeNull();
    expect(r.legacy).toBeNull();
    expect(warns.length).toBeGreaterThanOrEqual(6);
    expect(() => readRestored(null)).not.toThrow();
    expect(() => readRestored([1, 2])).not.toThrow();
  });
});
