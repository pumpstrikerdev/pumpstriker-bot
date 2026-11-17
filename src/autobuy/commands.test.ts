/**
 * The /autobuy commands and the go-live gate (B20 section 4). The Engine is a stub; every test uses its own temp folder and one FakeClock.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeClock } from '../link/clock';
import { cleanupTempDirs, FIXTURE_NOW, tempDir } from '../link/link-testkit';
import type { ArmsStatusPayload } from '../shared/contract/v1';
import { StubEngine } from './autobuy-testkit';
import { CONFIRM_WINDOW_MS, createAutoBuyCommands, type AutoBuyCommands } from './commands';
import { CircuitBreaker } from './guards';
import { AutoBuyStateStore } from './state';

afterAll(() => { cleanupTempDirs(); });

const OWNER = { isOwner: true };

interface Rig {
  clock: FakeClock; engine: StubEngine; state: AutoBuyStateStore; breaker: CircuitBreaker; cmd: AutoBuyCommands;
  fresh: ArmsStatusPayload[]; dryRun: { on: boolean };
}
function rig(): Rig {
  const clock = new FakeClock(FIXTURE_NOW);
  const engine = new StubEngine();
  const state = new AutoBuyStateStore(tempDir('ps-b2c-'));
  const breaker = new CircuitBreaker(clock.now());
  const fresh: ArmsStatusPayload[] = [];
  const dryRun = { on: true };
  const cmd = createAutoBuyCommands({
    clock, state, engine, breaker, dryRunEnv: () => dryRun.on, policyVersion: () => 'policy-v1', onFreshArms: p => { fresh.push(p); },
    extraStatus: () => ['caps used: 0/3 in the last hour'],
  });
  return { clock, engine, state, breaker, cmd, fresh, dryRun };
}
const say = async (r: Rig, text: string): Promise<string> => {
  const out = await r.cmd.handle(text, OWNER);
  if (out === null) throw new Error(`not handled: ${text}`);
  return out;
};

describe('the go-live gate', () => {
  it('B2-T06 /autobuy on is refused without a PASS, and with a PASS a wrong CONFIRM text is refused; only the exact text goes live', async () => {
    const r = rig();
    // 1. no PASS (the fixture arms are PASS for BS only): B1 is INSUFFICIENT
    expect(await say(r, '/autobuy on B1')).toMatch(/^Refused: arm B1 is INSUFFICIENT/);
    expect(r.cmd.pendingConfirm()).toBeNull();
    expect(await say(r, 'CONFIRM B1 report-b1-0001')).toMatch(/^Refused: no \/autobuy on request is waiting/);
    expect(r.state.get().mode).toBe('off');

    // 2. PASS: the request is accepted, shows the evidence, and asks for the exact text; nothing has changed yet
    r.engine.set('B1', 'PASS', 'report-b1-0001');
    const ask = await say(r, '/autobuy on b1');
    expect(ask).toContain('CONFIRM B1 report-b1-0001');
    expect(ask).toMatch(/matured 14/);
    expect(ask).toMatch(/days 3\.5/);
    expect(r.state.get().mode).toBe('off');
    expect(r.cmd.pendingConfirm()).toMatchObject({ arm: 'B1' });

    // 3. wrong texts: every one is refused and changes nothing
    const wrong = [
      'CONFIRM B1 wrong-report', 'CONFIRM B1 report-b1-0002', 'CONFIRM B1', 'CONFIRM B1 report-b1-0001 extra', 'CONFIRM  B1 report-b1-0001',
      'CONFIRM B2 report-b1-0001', 'CONFIRM b1 report-b1-0001', 'CONFIRM BS report-b1-0001', 'CONFIRM', 'CONFIRM report-b1-0001 B1',
    ];
    for (const w of wrong) {
      const out = await say(r, w);
      expect(out, w).toMatch(/^Refused/);
      expect(r.state.get().mode, w).toBe('off');
    }
    expect(await r.cmd.handle('confirm B1 report-b1-0001', OWNER)).toBeNull();   // lower case is not even a command
    expect(r.state.get()).toMatchObject({ mode: 'off', live_arm: null, report_id: null, confirmed_at: null });

    // 4. the exact text: live, with the arm, the report id and the confirmation time
    const ok = await say(r, 'CONFIRM B1 report-b1-0001');
    expect(ok).toMatch(/^Auto-buy is LIVE on arm B1/);
    expect(r.state.get()).toMatchObject({ mode: 'live', live_arm: 'B1', report_id: 'report-b1-0001', confirmed_at: FIXTURE_NOW, policy_version: 'policy-v1' });
    expect(r.cmd.pendingConfirm()).toBeNull();
    // the confirmation is single-use
    expect(await say(r, 'CONFIRM B1 report-b1-0001')).toMatch(/no \/autobuy on request is waiting/);
  });

  it('B2-T16 /autobuy dryrun B2 while live on B1 is refused and the live state is unchanged', async () => {
    const r = rig();
    r.engine.set('B1', 'PASS');
    await say(r, '/autobuy on B1');
    await say(r, 'CONFIRM B1 report-b1-0001');
    const before = r.state.get();
    expect(before.mode).toBe('live');
    const out = await say(r, '/autobuy dryrun B2');
    expect(out).toMatch(/^Refused: auto-buy is live/);
    expect(r.state.get()).toEqual(before);
    // after /autobuy off the dry run can be armed, and it never touches the live record
    await say(r, '/autobuy off');
    expect(await say(r, '/autobuy dryrun B2')).toMatch(/Dry run armed on B2/);
    expect(r.state.get()).toMatchObject({ mode: 'dry_run', dry_run_arm: 'B2', live_arm: 'B1', report_id: 'report-b1-0001' });
  });

  it('dryrun arms any arm without a PASS and never writes the live fields', async () => {
    const r = rig();
    const out = await say(r, '/autobuy dryrun B0');
    expect(out).toContain('NOTHING is sent');
    expect(r.state.get()).toMatchObject({ mode: 'dry_run', dry_run_arm: 'B0', live_arm: null, report_id: null, confirmed_at: null });
    expect(await say(r, '/autobuy dryrun')).toMatch(/^Refused: pick an arm/);
    expect(await say(r, '/autobuy dryrun B9')).toMatch(/^Refused: pick an arm/);
  });

  it('the request expires after the confirmation window', async () => {
    const r = rig();
    r.engine.set('B1', 'PASS');
    await say(r, '/autobuy on B1');
    await r.clock.advance(CONFIRM_WINDOW_MS + 1);
    expect(await say(r, 'CONFIRM B1 report-b1-0001')).toMatch(/^Refused: the confirmation window has expired/);
    expect(r.state.get().mode).toBe('off');
    expect(r.cmd.pendingConfirm()).toBeNull();
  });

  it('CONFIRM re-reads the arms: an arm that left PASS, or a new report id, is refused and nothing changes', async () => {
    const r = rig();
    r.engine.set('B1', 'PASS', 'report-b1-0001');
    await say(r, '/autobuy on B1');
    r.engine.set('B1', 'PASS', 'report-b1-0002');                 // a later look of the same arm
    expect(await say(r, 'CONFIRM B1 report-b1-0001')).toMatch(/does not match arm B1's current PASS report \(report-b1-0002\)/);
    expect(r.state.get().mode).toBe('off');
    expect(await say(r, 'CONFIRM B1 report-b1-0002')).toMatch(/^Auto-buy is LIVE/);

    const r2 = rig();
    r2.engine.set('B1', 'PASS');
    await say(r2, '/autobuy on B1');
    r2.engine.set('B1', 'FAIL');
    expect(await say(r2, 'CONFIRM B1 report-b1-0001')).toMatch(/no longer PASS \(FAIL\)/);
    expect(r2.state.get().mode).toBe('off');
    expect(r2.cmd.pendingConfirm()).toBeNull();

    const r3 = rig();
    r3.engine.set('B1', 'PASS');
    await say(r3, '/autobuy on B1');
    r3.engine.payload = { error: 'timeout' };
    expect(await say(r3, 'CONFIRM B1 report-b1-0001')).toMatch(/arms status is not available \(timeout\)/);
    expect(r3.state.get().mode).toBe('off');
  });

  it('on is refused when the Engine arms cannot be read, for every non-PASS verdict, and for a PASS without a report id', async () => {
    const r = rig();
    r.engine.payload = { error: 'engine_offline' };
    expect(await say(r, '/autobuy on B1')).toMatch(/arms status is not available \(engine_offline\)/);
    r.engine.payload = new StubEngine().payload;
    for (const verdict of ['FAIL', 'RETIRED', 'BIASED', 'INSUFFICIENT'] as const) {
      r.engine.set('B1', verdict, null);
      expect(await say(r, '/autobuy on B1'), verdict).toMatch(new RegExp(`is ${verdict}, not PASS`));
    }
    r.engine.set('B1', 'PASS', null);
    expect(await say(r, '/autobuy on B1')).toMatch(/carries no report id/);
    expect(await say(r, '/autobuy on')).toMatch(/^Refused: pick an arm/);
    expect(r.state.get().mode).toBe('off');
  });

  it('a fresh arms read is applied like an arms.status push', async () => {
    const r = rig();
    r.engine.set('B1', 'PASS');
    await say(r, '/autobuy on B1');
    await say(r, '/autobuy status');
    expect(r.fresh.length).toBeGreaterThanOrEqual(2);
    expect(r.fresh[0].arms.find(a => a.arm === 'B1')?.verdict).toBe('PASS');
  });
});

describe('status, off, resume', () => {
  it('status shows the bot mode, arm and confirmed_at next to every arm of the Engine', async () => {
    const r = rig();
    r.engine.set('B1', 'PASS');
    await say(r, '/autobuy on B1');
    await say(r, 'CONFIRM B1 report-b1-0001');
    const out = await say(r, '/autobuy status');
    expect(out).toMatch(/mode: LIVE on arm B1, confirmed_at 2026-\d\d-\d\dT[\d:]+Z, report report-b1-0001/);
    expect(out).toContain('BOT_DRY_RUN is on');
    expect(out).toContain('caps used: 0/3 in the last hour');
    for (const arm of ['BS', 'B0', 'B1', 'B2']) expect(out).toMatch(new RegExp(`${arm}  (PASS|INSUFFICIENT)  matured \\d+  executable n/a  days 3\\.5`));
    expect(out).toContain('report report-0001');   // the fixture's BS report
    expect(out).toContain('lcb_token 0.0210');
    expect(await say(r, '/autobuy')).toContain('Auto-buy status');           // no sub-command means status
    expect(await say(r, '/autobuy@PumpstrikerBot status')).toContain('Auto-buy status');
  });

  it('status says so when the Engine cannot be read, and shows BIASED and a changed report', async () => {
    const r = rig();
    r.engine.payload = { error: 'timeout' };
    expect(await say(r, '/autobuy status')).toContain('Engine arms: not available (timeout)');
    r.engine.payload = new StubEngine().payload;
    r.engine.set('B1', 'BIASED', null);
    expect(await say(r, '/autobuy status')).toMatch(/B1  BIASED/);
    const live = rig();
    live.engine.set('B1', 'PASS', 'report-b1-0001');
    await say(live, '/autobuy on B1');
    await say(live, 'CONFIRM B1 report-b1-0001');
    live.engine.set('B1', 'PASS', 'report-b1-0007');
    expect(await say(live, '/autobuy status')).toContain('report changed: confirmed report-b1-0001, now report-b1-0007');
  });

  it('off turns auto-buy off at once and cancels a waiting request', async () => {
    const r = rig();
    r.engine.set('B1', 'PASS');
    await say(r, '/autobuy on B1');
    await say(r, 'CONFIRM B1 report-b1-0001');
    await say(r, '/autobuy on B1');
    expect(r.cmd.pendingConfirm()).not.toBeNull();
    expect(await say(r, '/autobuy off')).toBe('Auto-buy is OFF.');
    expect(r.state.get().mode).toBe('off');
    expect(r.cmd.pendingConfirm()).toBeNull();
    expect(await say(r, 'CONFIRM B1 report-b1-0001')).toMatch(/no \/autobuy on request is waiting/);
  });

  it('resume clears a persisted pause, the failure count and the breaker, and leaves the mode alone', async () => {
    const r = rig();
    r.state.setDryRun('B1');
    for (let i = 0; i < 3; i++) r.state.noteFail(i, 'x');
    for (let i = 0; i < 10; i++) r.breaker.noteBuyLanded();
    r.breaker.check(FIXTURE_NOW + 31 * 60_000);
    expect(r.state.get().pause).toBe('paused_fails');
    expect(r.breaker.isTripped()).toBe(true);
    const out = await say(r, '/autobuy resume');
    expect(out).toContain('Cleared: paused_fails, paused_breaker');
    expect(r.state.get()).toMatchObject({ pause: null, consecutive_fails: 0, mode: 'dry_run' });
    expect(r.breaker.isTripped()).toBe(false);
    expect(await say(r, '/autobuy resume')).toContain('No pause was active');
  });
});

describe('who may use the commands', () => {
  it('a non-owner is refused and nothing changes', async () => {
    const r = rig();
    r.engine.set('B1', 'PASS');
    for (const text of ['/autobuy dryrun B1', '/autobuy on B1', '/autobuy off', '/autobuy resume', '/autobuy status', 'CONFIRM B1 report-b1-0001']) {
      expect(await r.cmd.handle(text, { isOwner: false }), text).toMatch(/owner only/);
    }
    expect(r.state.get().mode).toBe('off');
    expect(r.engine.calls).toBe(0);
  });

  it('a text that is not an auto-buy command is not handled', async () => {
    const r = rig();
    for (const text of ['hello', '/start', '/autobuyer', '/positions', '', 'CONFIRMED']) expect(await r.cmd.handle(text, OWNER), text).toBeNull();
    expect(await say(r, '/autobuy frobnicate')).toMatch(/^Unknown command "frobnicate"/);
  });

  it('a failing state write refuses the command instead of pretending', async () => {
    const r = rig();
    r.engine.set('B1', 'PASS');
    // swap the state for one whose folder cannot be written
    const dir = tempDir('ps-b2c-');
    const blocker = path.join(dir, 'file-not-folder');
    fs.writeFileSync(blocker, 'x');
    const broken = new AutoBuyStateStore(blocker);
    const cmd = createAutoBuyCommands({ clock: r.clock, state: broken, engine: r.engine, breaker: r.breaker, dryRunEnv: () => false, policyVersion: () => null, onFreshArms: () => undefined });
    expect(await cmd.handle('/autobuy dryrun B1', OWNER)).toMatch(/^Refused: could not write/);
    await cmd.handle('/autobuy on B1', OWNER);
    expect(await cmd.handle('CONFIRM B1 report-b1-0001', OWNER)).toMatch(/^Refused: could not write/);
    expect(broken.get().mode).toBe('off');
  });
});
