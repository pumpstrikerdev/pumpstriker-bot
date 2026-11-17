/**
 * The persisted auto-buy state (B20 section 4, schema 2). Every test uses its own temp folder.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fixture, cleanupTempDirs, tempDir } from '../link/link-testkit';
import type { Envelope, SignalNew } from '../shared/contract/v1';
import { decideAutoBuy, type AutoBuyState } from './decide';
import { AutoBuyStateStore, parseState, STATE_FILE } from './state';

afterAll(() => { cleanupTempDirs(); });

const ENV = fixture<Envelope<'signal.new', SignalNew>>('signal.new');
const file = (dir: string): string => path.join(dir, STATE_FILE);
const readState = (dir: string): Record<string, any> => JSON.parse(fs.readFileSync(file(dir), 'utf8')) as Record<string, any>;
const live = { arm: 'B1' as const, reportId: 'report-1', confirmedAt: 1_000, policyVersion: 'v1' };
const trade = (i: number, net = -0.3) => ({ tx: `tx-${i}`, net_per_sol_in: net, closed_at: 1_000 + i });

function validDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 2, mode: 'off', dry_run_arm: null, live_arm: null, report_id: null, confirmed_at: null, policy_version: null,
    pause: null, pause_reason: null, paused_at: null, consecutive_fails: 0, rolling: [], ...over,
  };
}

describe('AutoBuyStateStore', () => {
  it('B2-T14 a hand-edited state with mode live and confirmed_at null is off, for the store and for the decision', () => {
    const dir = tempDir('ps-b2s-');
    fs.writeFileSync(file(dir), JSON.stringify(validDoc({ mode: 'live', live_arm: 'B1', report_id: 'report-1', confirmed_at: null })));
    const store = new AutoBuyStateStore(dir);
    const p = store.get();
    expect(p.mode).toBe('off');
    expect(store.loadNote).toMatch(/treated as off/);
    // the decision refuses a state that claims live without the confirmation, even if a caller passes it straight through
    const s: AutoBuyState = {
      mode: 'live', dryRunArm: null, liveArm: 'B1', liveReportId: 'report-1', liveConfirmedAt: null, dryRun: false,
      armVerdicts: { B1: { arm: 'B1', registered_at: 1, registry_sha: 'x', verdict: 'PASS', n_matured: 1, days: 1, look: 1, lcb_token: 0, lcb_day: 0, report_id: 'report-1', evaluated_at: 1 } },
      boughtCas: new Set(), signalledCas: new Set(), pause: null, caps: { hour: 0, day: 0, solDay: 0, openPositions: 0 },
      limits: { perHour: 3, perDay: 20, solPerDay: 0.2, maxOpen: 5, reserveSol: 0.03, buySol: 0.01 },
      localPolicyVersion: { EA: ENV.payload.policy.version }, sessionWindowOk: true, walletPresent: true, balanceSol: 1, duplicatePosition: () => false,
    };
    const now = ENV.payload.entry.priced_at + 1_000;
    expect(decideAutoBuy(ENV.payload, ENV.ca as string, now, now, s).reason).toBe('off');
  });

  it('a missing, corrupt, schema-1 or schema-invalid file starts disabled, and a corrupt file is moved aside, not deleted', () => {
    const empty = new AutoBuyStateStore(tempDir('ps-b2s-'));
    expect(empty.get()).toEqual({
      schema: 2, mode: 'off', dry_run_arm: null, live_arm: null, report_id: null, confirmed_at: null, policy_version: null,
      pause: null, pause_reason: null, paused_at: null, consecutive_fails: 0, rolling: [],
    });
    expect(empty.loadNote).toBeNull();

    const bad: Array<[string, string]> = [
      ['not json', '{ nope'],
      ['schema 1', JSON.stringify({ enabled: true, arm: 'B1', report_id: 'r', confirmed_at: 1, policy_version: 'v' })],
      ['wrong schema number', JSON.stringify(validDoc({ schema: 1 }))],
      ['unknown mode', JSON.stringify(validDoc({ mode: 'on' }))],
      ['bad arm', JSON.stringify(validDoc({ mode: 'dry_run', dry_run_arm: 'B9' }))],
      ['bad pause', JSON.stringify(validDoc({ pause: 'paused_breaker' }))],
      ['negative fails', JSON.stringify(validDoc({ consecutive_fails: -1 }))],
      ['rolling not an array', JSON.stringify(validDoc({ rolling: {} }))],
      ['malformed rolling entry', JSON.stringify(validDoc({ rolling: [{ tx: 'a' }] }))],
    ];
    for (const [name, text] of bad) {
      const dir = tempDir('ps-b2s-');
      fs.writeFileSync(file(dir), text);
      const store = new AutoBuyStateStore(dir);
      expect(store.get().mode, name).toBe('off');
      expect(store.loadNote, name).toMatch(/starts disabled/);
      expect(fs.existsSync(file(dir)), name).toBe(false);
      expect(fs.readdirSync(dir).some(n => n.startsWith(`${STATE_FILE}.invalid-`)), name).toBe(true);
    }
    expect('error' in parseState(null, 50)).toBe(true);
  });

  it('dryrun sets only the mode and the dry-run arm, and is refused while live', () => {
    const dir = tempDir('ps-b2s-');
    const store = new AutoBuyStateStore(dir);
    expect(store.setDryRun('B2')).toEqual({ ok: true });
    expect(store.get()).toMatchObject({ mode: 'dry_run', dry_run_arm: 'B2', live_arm: null, report_id: null, confirmed_at: null });
    expect(readState(dir).mode).toBe('dry_run');
    expect(store.goLive(live)).toEqual({ ok: true });
    const before = store.get();
    const r = store.setDryRun('B0');
    expect(r.ok).toBe(false);
    expect(store.get()).toEqual(before);
  });

  it('goLive records the arm, the report id and the confirmation, and survives a restart', () => {
    const dir = tempDir('ps-b2s-');
    const store = new AutoBuyStateStore(dir);
    store.goLive(live);
    const again = new AutoBuyStateStore(dir).get();
    expect(again).toMatchObject({ mode: 'live', live_arm: 'B1', report_id: 'report-1', confirmed_at: 1_000, policy_version: 'v1' });
    store.setOff();
    // off keeps the audit record of the last confirmation
    expect(new AutoBuyStateStore(dir).get()).toMatchObject({ mode: 'off', live_arm: 'B1', report_id: 'report-1', confirmed_at: 1_000 });
  });

  it('three failed buys set paused_fails once, a success resets the count, and resume clears the pause', () => {
    const dir = tempDir('ps-b2s-');
    const store = new AutoBuyStateStore(dir);
    expect(store.noteFail(10, 'a')).toEqual({ fails: 1, pausedNow: false });
    store.noteSuccess();
    expect(store.get().consecutive_fails).toBe(0);
    store.noteFail(11, 'a');
    store.noteFail(12, 'b');
    expect(store.noteFail(13, 'c')).toEqual({ fails: 3, pausedNow: true });
    expect(store.get()).toMatchObject({ pause: 'paused_fails', paused_at: 13, consecutive_fails: 3 });
    expect(store.get().pause_reason).toContain('last: c');
    expect(store.noteFail(14, 'd').pausedNow).toBe(false);
    expect(store.resume()).toEqual({ ok: true });
    expect(store.get()).toMatchObject({ pause: null, pause_reason: null, paused_at: null, consecutive_fails: 0 });
  });

  it('the rolling window keeps the last N verified trades once per tx and pauses when the mean is below the limit', () => {
    const dir = tempDir('ps-b2s-');
    const store = new AutoBuyStateStore(dir, { rollingN: 5, rollingMinNet: -0.15 });
    expect(store.addClosedTrade(trade(1, -0.5), 1)).toEqual({ added: true, pausedNow: false });
    expect(store.addClosedTrade(trade(1, -0.5), 2)).toEqual({ added: false, pausedNow: false });   // same tx
    for (let i = 2; i <= 4; i++) expect(store.addClosedTrade(trade(i, -0.5), i).pausedNow).toBe(false);   // 4 of 5: the window is not full
    expect(store.addClosedTrade(trade(5, -0.5), 5)).toEqual({ added: true, pausedNow: true });
    expect(store.get().pause).toBe('paused_rolling');
    expect(store.rollingMean()).toBeCloseTo(-0.5, 10);
    // a window above the limit never pauses
    const ok = new AutoBuyStateStore(tempDir('ps-b2s-'), { rollingN: 3, rollingMinNet: -0.15 });
    for (let i = 1; i <= 6; i++) ok.addClosedTrade(trade(i, i % 2 === 0 ? -0.2 : 0.1), i);
    expect(ok.get().pause).toBeNull();
    expect(ok.get().rolling.map(r => r.tx)).toEqual(['tx-4', 'tx-5', 'tx-6']);   // only the last N
  });

  it('resuming a paused_rolling restarts the rolling window, so the same trades cannot re-pause at once', () => {
    const dir = tempDir('ps-b2s-');
    const store = new AutoBuyStateStore(dir, { rollingN: 3, rollingMinNet: -0.15 });
    for (let i = 1; i <= 3; i++) store.addClosedTrade(trade(i, -0.4), i);
    expect(store.get().pause).toBe('paused_rolling');
    store.resume();
    expect(store.get()).toMatchObject({ pause: null, rolling: [] });
    // a failure pause keeps the window
    const other = new AutoBuyStateStore(tempDir('ps-b2s-'), { rollingN: 3 });
    other.addClosedTrade(trade(1), 1);
    for (let i = 0; i < 3; i++) other.noteFail(i, 'x');
    other.resume();
    expect(other.get().rolling).toHaveLength(1);
    // the same rule for a new CONFIRM
    const c = new AutoBuyStateStore(tempDir('ps-b2s-'), { rollingN: 3, rollingMinNet: -0.15 });
    for (let i = 1; i <= 3; i++) c.addClosedTrade(trade(i, -0.4), i);
    c.goLive(live);
    expect(c.get()).toMatchObject({ mode: 'live', pause: null, rolling: [] });
  });

  it('a permissive change is refused when the file cannot be written, a restrictive one still takes effect in memory', () => {
    // the data folder is a plain file, so every write fails
    const dir = tempDir('ps-b2s-');
    const blocker = path.join(dir, 'not-a-folder');
    fs.writeFileSync(blocker, 'x');
    const store = new AutoBuyStateStore(blocker, { log: () => undefined });
    const dry = store.setDryRun('B1');
    expect(dry.ok).toBe(false);
    expect(store.get().mode).toBe('off');
    expect(store.goLive(live).ok).toBe(false);
    expect(store.get().mode).toBe('off');
    expect(store.writeError).not.toBeNull();
    // restrictive: the counted failure and the pause apply in memory with a warning
    for (let i = 0; i < 2; i++) store.noteFail(i, 'x');
    expect(store.noteFail(3, 'x').pausedNow).toBe(true);
    expect(store.get().pause).toBe('paused_fails');
  });

  it('a state written by one store is read back identically (schema 2 shape)', () => {
    const dir = tempDir('ps-b2s-');
    const store = new AutoBuyStateStore(dir);
    store.goLive(live);
    store.noteFail(5, 'boom');
    store.addClosedTrade(trade(1), 6);
    const doc = readState(dir);
    expect(Object.keys(doc).sort()).toEqual([
      'confirmed_at', 'consecutive_fails', 'dry_run_arm', 'live_arm', 'mode', 'pause', 'pause_reason', 'paused_at', 'policy_version', 'report_id', 'rolling', 'schema',
    ]);
    expect(doc.schema).toBe(2);
    expect(new AutoBuyStateStore(dir).get()).toEqual(store.get());
  });
});
