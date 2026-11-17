// R1-B1 (B10 section 3 rule 1): the inbox. Seen event ids (48 h, persisted) and the per-CA signal registry (persisted), group-committed.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeClock } from './clock';
import { createInbox, INBOX_SEEN_FILE, LAUNCH_RUN_SUPPRESSION, SEEN_TTL_MS, SIGNALLED_FILE, SIGNALLED_TTL_MS } from './inbox';
import { cleanupTempDirs, FIXTURE_NOW, newCa, newTestUlid, tempDir } from './link-testkit';

afterAll(() => { cleanupTempDirs(); });
const quiet = (): void => undefined;

describe('inbox', () => {
  it('marks an event id as seen once and reports a second mark as a duplicate', async () => {
    const clock = new FakeClock(FIXTURE_NOW);
    const inbox = createInbox({ dir: tempDir(), clock, log: quiet });
    const id = newTestUlid();
    expect(inbox.seen(id)).toBe(false);
    expect(inbox.checkAndMark(id)).toBe('new');
    expect(inbox.checkAndMark(id)).toBe('duplicate');
    expect(inbox.seen(id)).toBe(true);
    await inbox.persisted();
    expect(inbox.sizes()).toEqual({ seen: 1, signalled: 0 });
  });

  it('persists the seen ids atomically (group commit) and a new inbox over the same folder still knows them', async () => {
    const dir = tempDir();
    const clock = new FakeClock(FIXTURE_NOW);
    const a = createInbox({ dir, clock, log: quiet });
    const ids = Array.from({ length: 200 }, () => newTestUlid());
    for (const id of ids) a.checkAndMark(id);                       // 200 marks in one tick share one write
    await a.persisted();
    const doc = JSON.parse(fs.readFileSync(path.join(dir, INBOX_SEEN_FILE), 'utf8')) as { v: number; seen: Record<string, number> };
    expect(doc.v).toBe(1);
    expect(Object.keys(doc.seen).sort()).toEqual([...ids].sort());
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
    const b = createInbox({ dir, clock, log: quiet });
    expect(ids.every(id => b.checkAndMark(id) === 'duplicate')).toBe(true);
    expect(b.checkAndMark(newTestUlid())).toBe('new');
  });

  it('persisted() covers marks made while an earlier write is still in flight', async () => {
    const dir = tempDir();
    const inbox = createInbox({ dir, clock: new FakeClock(FIXTURE_NOW), log: quiet });
    inbox.checkAndMark(newTestUlid());
    const first = inbox.persisted();
    const late = newTestUlid();
    await Promise.resolve();
    inbox.checkAndMark(late);
    await inbox.persisted();
    await first;
    const doc = JSON.parse(fs.readFileSync(path.join(dir, INBOX_SEEN_FILE), 'utf8')) as { seen: Record<string, number> };
    expect(Object.keys(doc.seen)).toContain(late);
  });

  it('forgets an event id after 48 hours and keeps it up to then', async () => {
    const dir = tempDir();
    const clock = new FakeClock(FIXTURE_NOW);
    const a = createInbox({ dir, clock, log: quiet });
    const id = newTestUlid();
    a.checkAndMark(id);
    await a.persisted();
    const justInside = new FakeClock(FIXTURE_NOW + SEEN_TTL_MS);
    expect(createInbox({ dir, clock: justInside, log: quiet }).seen(id)).toBe(true);
    const outside = new FakeClock(FIXTURE_NOW + SEEN_TTL_MS + 1);
    expect(createInbox({ dir, clock: outside, log: quiet }).seen(id)).toBe(false);
  });

  it('keeps the per-CA registry (grade and symbol for the later cards), persists it and prunes it after its retention', async () => {
    const dir = tempDir();
    const clock = new FakeClock(FIXTURE_NOW);
    const a = createInbox({ dir, clock, log: quiet });
    const ca = newCa();
    expect(a.signalled(ca)).toBeNull();
    a.markSignalled(ca, { signal_id: 'dec_one', at: FIXTURE_NOW, grade: 'B', symbol: 'CREW' });
    await a.persisted();
    expect(a.signalled(ca)).toEqual({ signal_id: 'dec_one', at: FIXTURE_NOW, grade: 'B', symbol: 'CREW' });
    expect(fs.existsSync(path.join(dir, SIGNALLED_FILE))).toBe(true);
    const b = createInbox({ dir, clock: new FakeClock(FIXTURE_NOW + 3_600_000), log: quiet });
    expect(b.signalled(ca)).toMatchObject({ signal_id: 'dec_one', grade: 'B', symbol: 'CREW' });
    const c = createInbox({ dir, clock: new FakeClock(FIXTURE_NOW + SIGNALLED_TTL_MS + 1), log: quiet });
    expect(c.signalled(ca)).toBeNull();
  });

  it('persists the launch-run suppression with the entry (A-96): it survives a restart for the whole retention, and an entry written before A-96, or with an unknown value, reads as not suppressed', async () => {
    const dir = tempDir();
    const clock = new FakeClock(FIXTURE_NOW);
    const a = createInbox({ dir, clock, log: quiet });
    const hot = newCa();
    const plain = newCa();
    a.markSignalled(hot, { signal_id: 'dec_hot', at: FIXTURE_NOW, grade: 'A', symbol: 'HOT', suppressed: LAUNCH_RUN_SUPPRESSION });
    a.markSignalled(plain, { signal_id: 'dec_plain', at: FIXTURE_NOW, grade: 'B', symbol: 'OK', suppressed: null });
    await a.persisted();
    const doc = JSON.parse(fs.readFileSync(path.join(dir, SIGNALLED_FILE), 'utf8')) as { cas: Record<string, { suppressed?: unknown }> };
    expect(doc.cas[hot].suppressed).toBe('launch-run');
    expect(doc.cas[plain].suppressed).toBeNull();
    const later = createInbox({ dir, clock: new FakeClock(FIXTURE_NOW + SIGNALLED_TTL_MS - 1), log: quiet });
    expect(later.signalled(hot)).toMatchObject({ signal_id: 'dec_hot', grade: 'A', suppressed: 'launch-run' });
    expect(later.signalled(plain)?.suppressed).toBeNull();
    // an old file (no member) and a hand-edited one (an unknown value) load as not suppressed
    const old = tempDir();
    fs.writeFileSync(path.join(old, SIGNALLED_FILE), JSON.stringify({ v: 1, cas: {
      [hot]: { signal_id: 'dec_old', at: FIXTURE_NOW, grade: 'C', symbol: null },
      [plain]: { signal_id: 'dec_odd', at: FIXTURE_NOW, grade: 'C', symbol: null, suppressed: 'something-else' },
    } }));
    const legacy = createInbox({ dir: old, clock, log: quiet });
    expect(legacy.signalled(hot)).toEqual({ signal_id: 'dec_old', at: FIXTURE_NOW, grade: 'C', symbol: null, suppressed: null });
    expect(legacy.signalled(plain)?.suppressed).toBeNull();
    // and a legacy entry is written back with the member the next time the file is rewritten
    legacy.markSignalled(newCa(), { signal_id: 'dec_new', at: FIXTURE_NOW, grade: 'B', symbol: null, suppressed: null });
    await legacy.persisted();
    const rewritten = JSON.parse(fs.readFileSync(path.join(old, SIGNALLED_FILE), 'utf8')) as { cas: Record<string, { suppressed?: unknown }> };
    expect(rewritten.cas[hot].suppressed).toBeNull();
  });

  it('starts empty, without throwing, over a missing, corrupt or wrongly shaped file', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, INBOX_SEEN_FILE), '{"v":1,"seen":');
    fs.writeFileSync(path.join(dir, SIGNALLED_FILE), JSON.stringify({ v: 1, cas: { x: { signal_id: 5 }, y: 'no', z: { signal_id: 'd', at: 1, grade: 'Z' } } }));
    const inbox = createInbox({ dir, clock: new FakeClock(FIXTURE_NOW), log: quiet });
    expect(inbox.sizes()).toEqual({ seen: 0, signalled: 0 });
    expect(inbox.checkAndMark('x')).toBe('new');
    await inbox.persisted();
    expect(JSON.parse(fs.readFileSync(path.join(dir, INBOX_SEEN_FILE), 'utf8'))).toMatchObject({ v: 1, seen: { x: expect.any(Number) } });
  });

  it('keeps working in memory, and never rejects, when the data folder cannot be written', async () => {
    const dir = tempDir();
    const blocked = path.join(dir, 'blocked');
    fs.writeFileSync(blocked, 'a file where a folder should be');
    const messages: string[] = [];
    const inbox = createInbox({ dir: path.join(blocked, 'data'), clock: new FakeClock(FIXTURE_NOW), log: m => { messages.push(m); } });
    expect(inbox.checkAndMark('e1')).toBe('new');
    await expect(inbox.persisted()).resolves.toBeUndefined();
    expect(inbox.checkAndMark('e1')).toBe('duplicate');
    expect(messages.some(m => m.includes('could not persist'))).toBe(true);
  });
});
