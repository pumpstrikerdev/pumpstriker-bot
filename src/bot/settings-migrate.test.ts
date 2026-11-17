/**
 * B50 section 3 (R4-B6): settings.json -> schema 2. B6-T03 (a migration run twice) plus the cases around it: the removed keys, the kept
 * keys, the backup that comes first, a file that is never overwritten when it cannot be read. Temp folders only.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SCHEMA2_SIGNAL_KEYS, SETTINGS_FILE, SETTINGS_SCHEMA, backupStamp, isTgMinGrade, migrateSettingsDoc, migrateSettingsFile,
} from './settings-migrate';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-settings-'));
  dirs.push(d);
  return d;
}
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const T0 = Date.UTC(2026, 9, 18, 12, 30, 5);

/** A schema-1 file as the old bot wrote it, with every key the rebuild removed. */
function legacyDoc(): Record<string, unknown> {
  return {
    global: { slippageBps: 450, priorityFee: 120000, buyKb: [0.2, 1], degenMode: true, antiMev: true, smartSlippageMax: 2000 },
    signal: {
      enabled: false, minScore: 80, buyAmount: 0.05, autoBuyMinScore: 90, minMcap: 1000, maxMcap: 5e6, minLiquidity: 500, maxLiquidity: null,
      slippageBps: 700, degenMode: null, autoSellOnSignal: true, duplicateBuy: true, sessionEnabled: true, sessionPreset: 'europe',
      sessionStart: '08:00', sessionEnd: '17:00', sessionTz: 'Europe/London', tierBlocklist: ['S+'], autoBuyHotFilter: 'both',
      autoBuySignalCount: 2, autoBuyOnUpgrade: true, scoreTiers: [{ id: 'tier1', presets: [{ type: 'tp' }] }],
    },
    rebates: { enabled: true, address: 'AddrAddrAddrAddrAddrAddrAddrAddr11' },
  };
}

function write(dir: string, doc: unknown): string {
  const f = path.join(dir, SETTINGS_FILE);
  fs.writeFileSync(f, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
  return f;
}
const read = (f: string): Record<string, any> => JSON.parse(fs.readFileSync(f, 'utf8'));
const backups = (dir: string): string[] => fs.readdirSync(dir).filter(n => n.startsWith(`${SETTINGS_FILE}.bak-`));

describe('settings migration to schema 2', () => {
  it('B6-T03 migrating twice is idempotent: the first run backs up first and migrates, the second changes nothing and writes no second backup', () => {
    const dir = tmp();
    const original = JSON.stringify(legacyDoc(), null, 2);
    const f = write(dir, original);

    const first = migrateSettingsFile(dir, () => T0);
    expect(first.status).toBe('migrated');
    expect(backups(dir)).toHaveLength(1);
    const bak = path.join(dir, backups(dir)[0]);
    expect(bak).toBe(first.backupFile);
    expect(fs.readFileSync(bak, 'utf8')).toBe(original);   // the backup is the file exactly as it was
    expect(path.basename(bak)).toBe(`settings.json.bak-${backupStamp(T0)}`);
    const afterFirst = fs.readFileSync(f, 'utf8');
    expect(read(f).schema).toBe(SETTINGS_SCHEMA);

    const second = migrateSettingsFile(dir, () => T0 + 60_000);
    expect(second).toMatchObject({ status: 'already_v2', backupFile: null });
    expect(fs.readFileSync(f, 'utf8')).toBe(afterFirst);   // byte-identical
    expect(backups(dir)).toHaveLength(1);                  // still the one backup of the run that changed the file
  });

  it('IMPORT-T01 an old-format file is IMPORTED, not dropped: the restored keys, tgMinGrade B, the kept keys, global.* and rebates; legacy holds the old signal verbatim', () => {
    const m = migrateSettingsDoc(legacyDoc(), { now: T0 });
    const s = m.doc.signal as Record<string, unknown>;
    expect(m.changed).toBe(true);
    expect(m.imported).toBe(true);
    expect(m.dropped).toEqual([]);
    expect(Object.keys(s).sort()).toEqual([...SCHEMA2_SIGNAL_KEYS].sort());
    expect(s).toMatchObject({ buyAmount: 0.05, slippageBps: 700, degenMode: null, sessionEnabled: true, sessionPreset: 'europe',
      sessionStart: '08:00', sessionEnd: '17:00', sessionTz: 'Europe/London', tgMinGrade: 'B' });
    // the restored keys come from the old file (Active OFF, Min Score 80, the bands, Auto-Sell ON)
    expect(s).toMatchObject({ enabled: false, minScore: 80, minMcap: 1000, maxMcap: 5e6, minLiquidity: 500, maxLiquidity: null, autoSellOnSignal: true });
    expect((s.legacy as any).oldSignal).toEqual(legacyDoc().signal);
    expect((s.importNotice as any)).toMatchObject({ createdAt: T0, sentAt: null });
    expect(m.notApplicable.sort()).toEqual(['autoBuyHotFilter', 'autoBuyMinScore', 'autoBuyOnUpgrade', 'autoBuySignalCount', 'duplicateBuy', 'tierBlocklist']);
    expect(m.doc.global).toEqual(legacyDoc().global);
    expect(m.doc.rebates).toEqual(legacyDoc().rebates);
  });

  it('a schema-2 file drops a key that is not schema 2 and adds the restored defaults (nothing is imported from a schema-2 file)', () => {
    const m = migrateSettingsDoc({ schema: 2, signal: { buyAmount: 0.01, tgMinGrade: 'C', junk: 1 } });
    const s = m.doc.signal as Record<string, unknown>;
    expect(m.imported).toBe(false);
    expect(m.dropped).toEqual(['junk']);
    expect(s).toMatchObject({ enabled: true, minScore: null, minMcap: null, maxMcap: null, minLiquidity: null, maxLiquidity: null, autoSellOnSignal: true,
      gradePresets: { A: { mode: 'policy' }, B: { mode: 'policy' }, C: { mode: 'policy' } }, importNotice: null, legacy: null });
  });

  it('keeps a valid tgMinGrade and replaces an invalid one; keeps unknown top-level keys; never mutates its input', () => {
    const input = { ...legacyDoc(), note: 'mine', signal: { buyAmount: 0.01, tgMinGrade: 'A' } };
    const frozen = JSON.stringify(input);
    expect((migrateSettingsDoc(input).doc.signal as any).tgMinGrade).toBe('A');
    expect(migrateSettingsDoc(input).doc.note).toBe('mine');
    expect((migrateSettingsDoc({ signal: { tgMinGrade: 'S+' } }).doc.signal as any).tgMinGrade).toBe('B');
    expect((migrateSettingsDoc({}).doc.signal as any).tgMinGrade).toBe('B');
    expect(JSON.stringify(input)).toBe(frozen);
    expect(['A', 'B', 'C'].every(isTgMinGrade)).toBe(true);
    expect(isTgMinGrade('D')).toBe(false);
  });

  it('IMPORT-T06 a file that is already schema 2 and normal is not touched; a schema 2 file that lacks tgMinGrade is fixed with a backup', () => {
    const dir = tmp();
    const f = write(dir, migrateSettingsDoc({ schema: 2, global: { slippageBps: 300 }, signal: { buyAmount: 0.01, tgMinGrade: 'C' } }).doc);
    const before = fs.readFileSync(f, 'utf8');
    expect(migrateSettingsFile(dir, () => T0).status).toBe('already_v2');
    expect(fs.readFileSync(f, 'utf8')).toBe(before);
    expect(backups(dir)).toHaveLength(0);

    write(dir, { schema: 2, signal: { buyAmount: 0.01 } });
    expect(migrateSettingsFile(dir, () => T0).status).toBe('migrated');
    expect(read(f).signal.tgMinGrade).toBe('B');
    expect(backups(dir)).toHaveLength(1);
  });

  it('a missing file is left missing; a file that is not a JSON object is never overwritten', () => {
    const dir = tmp();
    expect(migrateSettingsFile(dir, () => T0)).toMatchObject({ status: 'missing', backupFile: null });
    expect(fs.existsSync(path.join(dir, SETTINGS_FILE))).toBe(false);

    for (const bad of ['{ not json', '[1,2,3]', '"text"', '']) {
      const f = write(dir, bad);
      expect(migrateSettingsFile(dir, () => T0).status, JSON.stringify(bad)).toBe('unreadable');
      expect(fs.readFileSync(f, 'utf8')).toBe(bad);
      expect(backups(dir)).toHaveLength(0);
    }
  });

  it('two runs in the same second never overwrite an earlier backup', () => {
    const dir = tmp();
    write(dir, legacyDoc());
    const a = migrateSettingsFile(dir, () => T0);
    write(dir, legacyDoc());   // the owner put an old file back
    const b = migrateSettingsFile(dir, () => T0);
    expect(a.backupFile).not.toBe(b.backupFile);
    expect(backups(dir)).toHaveLength(2);
  });
});
