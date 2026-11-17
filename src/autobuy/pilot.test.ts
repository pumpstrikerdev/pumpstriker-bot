/**
 * A-114 (owner decision 2026-10-26): the auto-buy PILOT. With AUTOBUY_PILOT on, the ONLY rule relaxed is the arm's go-live PASS
 * requirement; the size is min(buy amount, AUTOBUY_PILOT_MAX_SOL), at most AUTOBUY_PILOT_MAX_PER_DAY pilot buys per UTC day (persisted
 * in autobuy-caps.json before the send), and every other guard stays exactly as it is. With AUTOBUY_PILOT unset nothing changes.
 * Router, RPC, fills, Engine and positions are the auto-buy stubs; no network.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeClock } from '../link/clock';
import { createInbox } from '../link/inbox';
import { cleanupTempDirs, FakeTelegram, fixture, FIXTURE_NOW, freshEvent, MemoryOutbox, newCa, newTestUlid, StubAutoBuy, StubExits, tempDir } from '../link/link-testkit';
import type { ArmsStatusPayload, Envelope, LabelV1, SignalNew } from '../shared/contract/v1';
import { createSendQueue } from '../tg/send-queue';
import { createIntake } from '../intake/handlers';
import { AUTO_BUY_CAPS_FILENAME, AutoBuyCaps } from '../bot/trade-guards';
import { buildConfig, CONFIG_ENV_KEYS, envSnapshot } from '../config';
import { makeHarness, POLICY_VERSION, type Harness } from './autobuy-testkit';
import { decideAutoBuy, type AutoBuyState } from './decide';
import {
  AUTOBUY_PILOT_MAX_PER_DAY_DEFAULT, AUTOBUY_PILOT_MAX_SOL_DEFAULT, PILOT_GRADE_A_REPORT, pilotBlock, pilotConfigFromEnv,
} from './pilot';

afterAll(() => { cleanupTempDirs(); });

const PILOT_ENV = { AUTOBUY_PILOT: '1' };
const HOUR = 3_600_000;

/** The harness with the pilot on (BOT_DRY_RUN off unless a test turns it on) and the arms read once, like the boot does. */
async function pilotRig(env: Record<string, string | undefined> = PILOT_ENV, o: { noArms?: boolean } = {}): Promise<Harness> {
  const h = makeHarness({ env });
  if (o.noArms === true) h.engine.payload = { arms: [] };
  await h.svc.refreshArms();
  return h;
}

/** /autobuy on [ARM] + the PILOT confirmation the reply asks for. */
async function pilotOn(h: Harness, arm: string | null = 'B1'): Promise<string> {
  const on = await h.owner(arm === null ? '/autobuy on' : `/autobuy on ${arm}`);
  const m = /CONFIRM PILOT (\S+)/.exec(on ?? '');
  if (m === null) throw new Error(`no PILOT confirmation asked: ${on}`);
  const r = await h.owner(`CONFIRM PILOT ${m[1]}`);
  if (r === null || !r.includes('LIVE')) throw new Error(`PILOT confirmation refused: ${r}`);
  return r;
}

/** One signal through decide (+ execute on a buy), with the payload edited first. */
async function runWith(h: Harness, edit: (p: SignalNew) => void, so: { pricedAgoMs?: number; arms?: Partial<Record<'BS' | 'B0' | 'B1' | 'B2', boolean>> } = {}) {
  const { env, sig } = h.signal(so);
  edit(sig);
  if (env.ca !== null) h.registry.set(env.ca, env.signal_id as string);
  const now = h.clock.now();
  const d = h.svc.decide(sig, env, now, now);
  const x = d.action === 'buy' ? await h.svc.execute(sig, env, d) : null;
  return { env, sig, d, x };
}

const label = (id: string, value: boolean | null): LabelV1 => ({ id, rule_version: `${id}@1`, value, known: value !== null, acting: true });

describe('PILOT config (AUTOBUY_PILOT, AUTOBUY_PILOT_MAX_SOL, AUTOBUY_PILOT_MAX_PER_DAY)', () => {
  it('PILOT-T01 unset or anything but exactly 1/true/on/yes is off; the defaults are 0.01 SOL and 3 per UTC day', () => {
    for (const v of [undefined, '', '0', 'false', 'off', 'no', '2', 'enabled', 'y', 'onn']) {
      expect(pilotConfigFromEnv({ AUTOBUY_PILOT: v }).enabled, `AUTOBUY_PILOT=${String(v)}`).toBe(false);
    }
    for (const v of ['1', 'true', 'on', 'yes', ' TRUE ', 'Yes']) {
      const c = pilotConfigFromEnv({ AUTOBUY_PILOT: v });
      expect(c.enabled, `AUTOBUY_PILOT=${v}`).toBe(true);
      expect(c.maxSol).toBe(AUTOBUY_PILOT_MAX_SOL_DEFAULT);
      expect(c.maxPerDay).toBe(AUTOBUY_PILOT_MAX_PER_DAY_DEFAULT);
      expect(c.warnings).toEqual([]);
    }
    expect(AUTOBUY_PILOT_MAX_SOL_DEFAULT).toBe(0.01);
    expect(AUTOBUY_PILOT_MAX_PER_DAY_DEFAULT).toBe(3);
  });

  it('PILOT-T02 the cap bounds: MAX_SOL > 0.05 is clamped to 0.05, MAX_PER_DAY > 10 to 10 (warned); an invalid value refuses the pilot', () => {
    const ok = pilotConfigFromEnv({ AUTOBUY_PILOT: '1', AUTOBUY_PILOT_MAX_SOL: '0.05', AUTOBUY_PILOT_MAX_PER_DAY: '10' });
    expect(ok).toMatchObject({ enabled: true, maxSol: 0.05, maxPerDay: 10, warnings: [] });
    expect(pilotConfigFromEnv({ AUTOBUY_PILOT: '1', AUTOBUY_PILOT_MAX_SOL: '0.002', AUTOBUY_PILOT_MAX_PER_DAY: '1' })).toMatchObject({ enabled: true, maxSol: 0.002, maxPerDay: 1 });

    const high = pilotConfigFromEnv({ AUTOBUY_PILOT: '1', AUTOBUY_PILOT_MAX_SOL: '0.5', AUTOBUY_PILOT_MAX_PER_DAY: '50' });
    expect(high).toMatchObject({ enabled: true, maxSol: 0.05, maxPerDay: 10 });
    expect(high.warnings.join('\n')).toMatch(/AUTOBUY_PILOT_MAX_SOL=0\.5 .*clamped to 0\.05/);
    expect(high.warnings.join('\n')).toMatch(/AUTOBUY_PILOT_MAX_PER_DAY=50 .*clamped to 10/);

    for (const [k, v] of [['AUTOBUY_PILOT_MAX_SOL', '0'], ['AUTOBUY_PILOT_MAX_SOL', '-0.01'], ['AUTOBUY_PILOT_MAX_SOL', 'abc'], ['AUTOBUY_PILOT_MAX_SOL', '0,01'],
      ['AUTOBUY_PILOT_MAX_SOL', 'Infinity'], ['AUTOBUY_PILOT_MAX_PER_DAY', '0'], ['AUTOBUY_PILOT_MAX_PER_DAY', '2.5'], ['AUTOBUY_PILOT_MAX_PER_DAY', '-1'],
      ['AUTOBUY_PILOT_MAX_PER_DAY', 'three']] as const) {
      const c = pilotConfigFromEnv({ AUTOBUY_PILOT: '1', [k]: v });
      expect(c.enabled, `${k}=${v}`).toBe(false);
      expect(c.requested).toBe(true);
      expect(c.refused, `${k}=${v}`).toContain(k);
      expect(c.warnings.join('\n')).toContain(k);
    }
    // with the pilot off the limits are never read as a problem
    expect(pilotConfigFromEnv({ AUTOBUY_PILOT_MAX_SOL: 'abc' })).toMatchObject({ enabled: false, requested: false, refused: null, warnings: [] });
  });

  it('PILOT-T02b config.ts reads the three keys with the same parser, and the env snapshot hands them to auto-buy', () => {
    expect(buildConfig({})).toMatchObject({ AUTOBUY_PILOT: false, AUTOBUY_PILOT_MAX_SOL: 0.01, AUTOBUY_PILOT_MAX_PER_DAY: 3 });
    expect(buildConfig({ AUTOBUY_PILOT: 'on', AUTOBUY_PILOT_MAX_SOL: '0.2', AUTOBUY_PILOT_MAX_PER_DAY: '4' })).toMatchObject({ AUTOBUY_PILOT: true, AUTOBUY_PILOT_MAX_SOL: 0.05, AUTOBUY_PILOT_MAX_PER_DAY: 4 });
    expect(buildConfig({ AUTOBUY_PILOT: '1', AUTOBUY_PILOT_MAX_PER_DAY: '0' }).AUTOBUY_PILOT).toBe(false);
    for (const k of ['AUTOBUY_PILOT', 'AUTOBUY_PILOT_MAX_SOL', 'AUTOBUY_PILOT_MAX_PER_DAY'] as const) expect(CONFIG_ENV_KEYS).toContain(k);
    // one rule, two places: the config view equals what auto-buy acts on
    for (const on of [undefined, '0', '1', 'true', ' On ', 'yes', 'enabled']) {
      for (const sol of [undefined, '', '0.01', '0.002', '0.05', '0.06', '1', '0', '-1', 'x', '0,01', '.5']) {
        for (const day of [undefined, '', '1', '3', '10', '11', '0', '2.5', 'x']) {
          const env = { AUTOBUY_PILOT: on, AUTOBUY_PILOT_MAX_SOL: sol, AUTOBUY_PILOT_MAX_PER_DAY: day };
          const p = pilotConfigFromEnv(env);
          const c = buildConfig(env);
          expect(c.AUTOBUY_PILOT, JSON.stringify(env)).toBe(p.enabled);
          if (p.enabled) expect({ s: c.AUTOBUY_PILOT_MAX_SOL, d: c.AUTOBUY_PILOT_MAX_PER_DAY }, JSON.stringify(env)).toEqual({ s: p.maxSol, d: p.maxPerDay });
        }
      }
    }
    expect(envSnapshot({ AUTOBUY_PILOT: '1', AUTOBUY_PILOT_MAX_SOL: '0.01', AUTOBUY_PILOT_MAX_PER_DAY: '2', TG_BOT_TOKEN: 'x' }))
      .toMatchObject({ AUTOBUY_PILOT: '1', AUTOBUY_PILOT_MAX_SOL: '0.01', AUTOBUY_PILOT_MAX_PER_DAY: '2' });
  });
});

describe('PILOT: unset changes nothing', () => {
  it('PILOT-T03 without the pilot a live state whose arm is not PASS skips off, /autobuy on needs a PASS and CONFIRM PILOT is refused', async () => {
    // the pure decision: no pilot member = today's rule
    const ENV = fixture<Envelope<'signal.new', SignalNew>>('signal.new');
    const s: AutoBuyState = {
      mode: 'live', dryRunArm: null, liveArm: 'B1', liveReportId: 'report-1', liveConfirmedAt: 5, dryRun: false,
      armVerdicts: {}, boughtCas: new Set(), signalledCas: new Set(), pause: null,
      caps: { hour: 0, day: 0, solDay: 0, openPositions: 0 },
      limits: { perHour: 3, perDay: 20, solPerDay: 0.2, maxOpen: 5, reserveSol: 0.03, buySol: 0.01 },
      localPolicyVersion: { EA: ENV.payload.policy.version }, sessionWindowOk: true, walletPresent: true, balanceSol: 1, duplicatePosition: () => false,
    };
    const now = ENV.payload.entry.priced_at + 1_000;
    expect(decideAutoBuy(ENV.payload, ENV.ca as string, now, now, s)).toEqual({ action: 'skip', reason: 'off', arm: 'B1', forceDryRun: false });

    for (const env of [{}, { AUTOBUY_PILOT: '0' }, { AUTOBUY_PILOT: 'enabled' }]) {
      const h = makeHarness({ env });
      await h.svc.refreshArms();
      expect(await h.owner('/autobuy on B1')).toMatch(/^Refused: arm B1 is INSUFFICIENT, not PASS/);
      expect(await h.owner('/autobuy on')).toMatch(/^Refused: pick an arm/);
      expect(await h.owner('CONFIRM PILOT B1')).toBe('Refused: the confirmation must be exactly:  CONFIRM <ARM> <report_id>');
      const st = await h.owner('/autobuy status');
      expect(st).not.toContain('PILOT');
      expect(h.svc.bootLine()).not.toContain('PILOT');
      expect(h.svc.pilotLive()).toBe(false);
      const { d } = await h.run({ arms: { B1: true } });
      expect(d).toMatchObject({ action: 'skip', reason: 'off' });
      expect(h.router.calls).toHaveLength(0);
      expect(h.notices).toEqual([]);
    }
  });

  it('PILOT-T04 a state confirmed in PILOT mode is switched off by a start without the pilot', async () => {
    const h = await pilotRig();
    await pilotOn(h, 'B1');
    expect(h.stateFile()).toMatchObject({ mode: 'live', live_arm: 'B1', report_id: 'pilot:arm-B1' });
    const h2 = h.restart({ env: {} });
    expect(h2.svc.heartbeat().autobuy.mode).toBe('off');
    expect(h2.stateFile().mode).toBe('off');
    h2.svc.start();
    expect(h2.logs.join('\n')).toMatch(/PILOT mode .*AUTOBUY_PILOT is off/);
  });
});

describe('PILOT: live buying without a PASS', () => {
  it('PILOT-T05 pilot + BOT_DRY_RUN on: the whole path runs and NOTHING is sent', async () => {
    const h = await pilotRig();
    h.flags.dryRun = true;
    const reply = await pilotOn(h, 'B1');
    expect(reply).toContain('BOT_DRY_RUN is on');
    const { d, x } = await h.run({ arms: { B1: true } });
    expect(d).toMatchObject({ action: 'buy', arm: 'B1', forceDryRun: true });
    expect(x?.status).toBe('dry_run');
    expect(h.router.sends).toHaveLength(0);
    expect(h.router.calls[0].opts.buildOnly).toBe(true);
    expect(h.notices.some(n => n.startsWith('PILOT') && n.includes('dry run'))).toBe(true);
  });

  it('PILOT-T06 pilot + BOT_DRY_RUN=0 + /autobuy on + CONFIRM = a live buy of an arm without a PASS, at min(buy amount, 0.01 SOL)', async () => {
    const h = await pilotRig();
    h.settings.buySol = 0.5;                                      // the configured buy amount is far above the pilot cap
    const on = await h.owner('/autobuy on B1');
    expect(on).toContain('PILOT');
    expect(on).toContain('B1 has no go-live PASS (INSUFFICIENT)');
    expect(on).toContain('CONFIRM PILOT B1');
    expect(h.stateFile.bind(h)).toThrow();                        // nothing is written before the confirmation
    expect(await h.owner('CONFIRM PILOT B2')).toMatch(/^Refused: the waiting PILOT request is for B1/);
    const ok = await h.owner('CONFIRM PILOT B1');
    expect(ok).toMatch(/^Auto-buy is LIVE in PILOT mode/);
    expect(ok).toContain('not go-live tested');
    expect(h.stateFile()).toMatchObject({ mode: 'live', live_arm: 'B1', report_id: 'pilot:arm-B1' });

    const { d, x } = await h.run({ arms: { B1: true } });
    expect(d).toEqual({ action: 'buy', reason: null, arm: 'B1', forceDryRun: false });
    expect(x?.status).toBe('submitted');
    expect(h.router.sends).toHaveLength(1);
    expect(h.router.calls[0].solIn).toBe(0.01);
    expect(h.router.calls[0].opts).toMatchObject({ singleSend: true, maxImpactPct: 15 });
    // the journal and the ledger were written before the send, and the pilot count too
    expect(h.router.sends[0]).toMatchObject({ journalHadSig: true, ledgerHadCa: true });
    const caps = JSON.parse(fs.readFileSync(path.join(h.dir, AUTO_BUY_CAPS_FILENAME), 'utf8')) as { pilot_sent?: number[] };
    expect(caps.pilot_sent).toHaveLength(1);
    // the buy card says PILOT, the size and the selection
    const card = h.notices.find(n => n.includes('auto-buy SENT'));
    expect(card).toBeDefined();
    expect(card).toMatch(/^PILOT: /);
    expect(card).toContain('0.01 SOL');
    expect(card).toContain("arm B1's selection");
    expect(card).toContain('not go-live tested');
    // the Engine verdict staying INSUFFICIENT does not switch the pilot off
    await h.svc.refreshArms();
    expect(h.svc.heartbeat().autobuy.mode).toBe('live');
  });

  it('PILOT-T07 a buy amount below the pilot cap is kept; the pilot never raises it', async () => {
    const h = await pilotRig({ AUTOBUY_PILOT: 'yes', AUTOBUY_PILOT_MAX_SOL: '0.05' });
    h.settings.buySol = 0.02;
    await pilotOn(h, 'B1');
    await h.run({ arms: { B1: true } });
    expect(h.router.calls[0].solIn).toBe(0.02);
  });

  it('PILOT-T08 the 4th pilot buy of the UTC day is skipped (cap_day) and stays skipped after a restart; the next UTC day is free again', async () => {
    const h = await pilotRig();
    await pilotOn(h, 'B1');
    for (let i = 0; i < 3; i++) {
      const { x } = await h.run({ arms: { B1: true } });
      expect(x?.status, `buy ${i + 1}`).toBe('submitted');
      await h.advance(HOUR + 60_000);                              // past the per-hour cap, still the same UTC day
    }
    expect(h.router.sends).toHaveLength(3);
    const fourth = await h.run({ arms: { B1: true } });
    expect(fourth.d).toMatchObject({ action: 'skip', reason: 'cap_day' });
    expect(h.notices.filter(n => n.includes('daily limit'))).toHaveLength(1);
    expect(h.notices.find(n => n.includes('daily limit'))).toMatch(/^PILOT: /);
    const st = await h.owner('/autobuy status');
    expect(st).toContain('PILOT on: max 0.01 SOL per buy, 3 per UTC day, used 3 today, not go-live tested');

    // a restart (new process, same data folder) does not reset the count
    const h2 = h.restart();
    await h2.svc.refreshArms();
    expect(h2.svc.heartbeat().autobuy.mode).toBe('live');
    const again = await h2.run({ arms: { B1: true } });
    expect(again.d).toMatchObject({ action: 'skip', reason: 'cap_day' });
    expect(h2.router.sends).toHaveLength(0);

    // the next UTC day starts at 0
    const nextDay = (Math.floor(h2.clock.now() / 86_400_000) + 1) * 86_400_000 + 60_000;
    await h2.advance(nextDay - h2.clock.now());
    await h2.svc.refreshArms();
    const tomorrow = await h2.run({ arms: { B1: true } });
    expect(tomorrow.x?.status).toBe('submitted');
  });

  it('PILOT-T09 two signals racing for the last pilot slot: only one is sent', async () => {
    const h = await pilotRig({ AUTOBUY_PILOT: '1', AUTOBUY_PILOT_MAX_PER_DAY: '1' });
    await pilotOn(h, 'B1');
    const a = h.signal({ arms: { B1: true } });
    const b = h.signal({ arms: { B1: true } });
    for (const s of [a, b]) h.registry.set(s.env.ca as string, s.env.signal_id as string);
    const now = h.clock.now();
    const da = h.svc.decide(a.sig, a.env, now, now);
    const db = h.svc.decide(b.sig, b.env, now, now);
    expect(da.action).toBe('buy');
    expect(db.action).toBe('buy');
    const [xa, xb] = await Promise.all([h.svc.execute(a.sig, a.env, da), h.svc.execute(b.sig, b.env, db)]);
    expect([xa.status, xb.status].sort()).toEqual(['failed', 'submitted']);
    expect(h.router.sends).toHaveLength(1);
  });

  it('PILOT-T24 a reservation taken just before 00:00 UTC still counts against the new day, so the cap cannot be passed at midnight', () => {
    const file = path.join(tempDir('pilot-midnight'), AUTO_BUY_CAPS_FILENAME);
    const caps = new AutoBuyCaps(file, { perHour: 10, perDay: 20, solPerDay: 1 });
    const midnight = Math.ceil(FIXTURE_NOW / 86_400_000) * 86_400_000;
    const before = caps.pilotReserve(1, midnight - 1_000);          // day 1, still in flight at midnight
    expect(before.ok).toBe(true);
    const after = caps.pilotReserve(1, midnight + 1_000);           // day 2 with a cap of 1: the in-flight one holds the slot
    expect(after).toMatchObject({ ok: false });
    if (before.ok) caps.pilotCommit(before.token, midnight + 2_000); // sent on day 2
    expect(caps.pilotUsedToday(midnight + 3_000)).toBe(1);
    expect(caps.pilotReserve(1, midnight + 4_000)).toMatchObject({ ok: false });
    expect(caps.pilotUsedToday(midnight + 86_400_000 + 1_000)).toBe(0);  // the next day is free again
  });

  it('PILOT-T10 a pilot count that cannot be written aborts the send', async () => {
    const h = await pilotRig();
    await pilotOn(h, 'B1');
    // make the caps file unwritable: a directory with that name where the atomic rename lands
    const capsFile = path.join(h.dir, AUTO_BUY_CAPS_FILENAME);
    const caps = new AutoBuyCaps(capsFile, { perHour: 3, perDay: 20, solPerDay: 1 });
    const res = caps.pilotReserve(3, h.clock.now());
    expect(res.ok).toBe(true);
    fs.rmSync(capsFile, { force: true });
    fs.mkdirSync(capsFile);
    fs.writeFileSync(path.join(capsFile, 'keep'), 'x');
    expect(() => caps.pilotCommit((res as { token: number }).token, h.clock.now())).toThrow();
    expect(caps.pilotUsedToday(h.clock.now())).toBe(1);           // the reservation is still held until it is cancelled
    caps.pilotCancel((res as { token: number }).token);
    expect(caps.pilotUsedToday(h.clock.now())).toBe(0);
    // the service: the pilot write is the first thing onSigned does, so nothing is sent
    const { x } = await h.run({ arms: { B1: true } });
    expect(x?.status).toBe('failed');
    expect(h.router.sends).toHaveLength(0);
    expect(h.journal()).toEqual([]);
  });
});

describe('PILOT: every other guard stays', () => {
  it('PILOT-T11 staleness, the impact cap, the SOL reserve, rug, launch-run, unpriceable and an ineligible arm still skip', async () => {
    const h = await pilotRig();
    await pilotOn(h, 'B1');
    const cases: Array<{ name: string; pre?: () => void; edit?: (p: SignalNew) => void; so?: { pricedAgoMs?: number; arms?: Partial<Record<'BS' | 'B0' | 'B1' | 'B2', boolean>> }; reason: string }> = [
      { name: 'stale', so: { pricedAgoMs: 6_000, arms: { B1: true } }, reason: 'stale' },
      { name: 'reserve', pre: () => { h.flags.balanceSol = 0.035; }, so: { arms: { B1: true } }, reason: 'reserve' },
      { name: 'rug', edit: p => { p.labels.push(label('rug-ratio-60', true)); }, so: { arms: { B1: true } }, reason: 'arm_blocked' },
      { name: 'launch-run', edit: p => { p.labels.push(label('launch-run', true)); }, so: { arms: { B1: true } }, reason: 'arm_blocked' },
      { name: 'unpriceable', edit: p => { p.entry.price_usd = 0; }, so: { arms: { B1: true } }, reason: 'arm_blocked' },
      { name: 'unpriceable mcap', edit: p => { p.entry.mcap_usd = Number.NaN; }, so: { arms: { B1: true } }, reason: 'arm_blocked' },
      { name: 'safety pending', edit: p => { p.safety.status = 'pending'; }, so: { arms: { B1: true } }, reason: 'arm_blocked' },
      { name: 'arm not eligible', so: { arms: { B1: false } }, reason: 'arm_blocked' },
    ];
    for (const c of cases) {
      h.flags.balanceSol = 1;
      c.pre?.();
      const { d } = await runWith(h, c.edit ?? (() => undefined), c.so ?? {});
      expect(d, c.name).toMatchObject({ action: 'skip', reason: c.reason });
    }
    h.flags.balanceSol = 1;
    expect(h.router.calls).toHaveLength(0);
    // the impact cap: refused by the router before signing, nothing sent, not a failed buy
    h.router.impactPct = 40;
    const { x } = await h.run({ arms: { B1: true } });
    expect(x?.status).toBe('failed');
    expect(x?.error).toMatch(/^impact_cap/);
    expect(h.router.sends).toHaveLength(0);
    expect(h.stateFile().consecutive_fails).toBe(0);
    // and the pilot slot was released (0 used)
    expect(await h.owner('/autobuy status')).toContain('used 0 today');
  });

  it('PILOT-T12 pilotBlock names the reason; a clean grade-A signal is not blocked', () => {
    const raw = JSON.parse(JSON.stringify(fixture<Envelope<'signal.new', SignalNew>>('signal.new').payload)) as SignalNew;
    // PILOT-T23: a signal without any launch-run label is blocked (fail closed); with launch-run known false it is not
    expect(pilotBlock(raw, { kind: 'arm', arm: 'B1' })).toMatch(/launch-run not reported/);
    const sig: SignalNew = { ...raw, labels: [...raw.labels, label('launch-run', false)] };
    expect(pilotBlock(sig, { kind: 'grade-A' })).toBeNull();
    expect(pilotBlock(sig, { kind: 'arm', arm: 'B1' })).toBeNull();
    expect(pilotBlock({ ...sig, grade: 'B' }, { kind: 'grade-A' })).toMatch(/grade B/);
    expect(pilotBlock({ ...sig, grade: 'B' }, { kind: 'arm', arm: 'B1' })).toBeNull();
    expect(pilotBlock({ ...sig, labels: [...sig.labels, label('rug-ratio-60', true)] }, { kind: 'arm', arm: 'B1' })).toMatch(/rug/);
    expect(pilotBlock({ ...sig, labels: [...sig.labels, label('rug-ratio-60', null)] }, { kind: 'arm', arm: 'B1' })).toBeNull();
    expect(pilotBlock({ ...raw, labels: [...raw.labels, label('launch-run', true)] }, { kind: 'arm', arm: 'B1' })).toMatch(/launch-run/);
    // a launch-run label that is present but unknown is blocked too (fail closed); a known false one is not
    expect(pilotBlock({ ...raw, labels: [...raw.labels, label('launch-run', null)] }, { kind: 'arm', arm: 'B0' })).toMatch(/launch-run unknown/);
    expect(pilotBlock({ ...raw, labels: [...raw.labels, label('launch-run', false)] }, { kind: 'arm', arm: 'B0' })).toBeNull();
    expect(pilotBlock({ ...sig, entry: { ...sig.entry, price_usd: -1 } }, { kind: 'arm', arm: 'B1' })).toMatch(/unpriceable/);
  });

  it('PILOT-T13 pauses, max open positions and the hour cap still hold; /autobuy off stops the pilot at once', async () => {
    const h = await pilotRig();
    await pilotOn(h, 'B1');
    h.router.failBefore = new Error('route down');
    for (let i = 0; i < 3; i++) await h.run({ arms: { B1: true } });
    expect(h.stateFile().pause).toBe('paused_fails');
    expect(h.notices.some(n => n.startsWith('PILOT: Auto-buy PAUSED (paused_fails)'))).toBe(true);
    expect((await h.run({ arms: { B1: true } })).d).toMatchObject({ action: 'skip', reason: 'paused_fails' });
    expect(await h.owner('/autobuy off')).toMatch(/^Auto-buy is OFF/);
    expect((await h.run({ arms: { B1: true } })).d).toMatchObject({ action: 'skip', reason: 'off' });
  });

  it('PILOT-T14 a FAIL verdict is never piloted: /autobuy on is refused and a live pilot arm that turns FAIL is switched off', async () => {
    const h = await pilotRig();
    h.engine.set('B0', 'FAIL');
    expect(await h.owner('/autobuy on B0')).toMatch(/^Refused: PILOT: arm B0 is FAIL/);
    await pilotOn(h, 'B1');
    h.svc.onArmsStatus(h.engine.set('B1', 'FAIL'));
    expect(h.svc.heartbeat().autobuy.mode).toBe('off');
    expect(h.notices.some(n => n.startsWith('PILOT: Auto-buy switched OFF') && n.includes('FAIL'))).toBe(true);
  });

  it('PILOT-T22 a NORMAL PASS confirmation keeps its PASS rule while the pilot is on; its buys are bounded by the pilot size and count', async () => {
    const h = await pilotRig();
    h.settings.buySol = 0.5;
    await h.goLive('B1');                                          // CONFIRM B1 <report_id> of a standing PASS
    expect(h.stateFile().report_id).toBe('report-b1-0001');
    const { x } = await h.run({ arms: { B1: true } });
    expect(x?.status).toBe('submitted');
    expect(h.router.calls[0].solIn).toBe(0.01);                    // the pilot can only make it stricter
    // the PASS is lost: the arms status switches it off (not tolerated like a PILOT confirmation); T22b pins decide
    h.svc.onArmsStatus(h.engine.set('B1', 'INSUFFICIENT'));
    expect(h.svc.heartbeat().autobuy.mode).toBe('off');
    expect(h.notices.some(n => n.startsWith('PILOT: Auto-buy switched OFF') && n.includes('INSUFFICIENT'))).toBe(true);
  });

  it('PILOT-T22b decide: the pilot member alone does not waive the PASS of a non-pilot report id', () => {
    const ENV = fixture<Envelope<'signal.new', SignalNew>>('signal.new');
    ENV.payload.labels.push(label('launch-run', false));   // the live Engine reports it on every signal; the pilot refuses a missing one
    const base: AutoBuyState = {
      mode: 'live', dryRunArm: null, liveArm: 'B1', liveReportId: 'report-1', liveConfirmedAt: 5, dryRun: false,
      armVerdicts: {}, boughtCas: new Set(), signalledCas: new Set(), pause: null,
      caps: { hour: 0, day: 0, solDay: 0, openPositions: 0 },
      limits: { perHour: 3, perDay: 20, solPerDay: 0.2, maxOpen: 5, reserveSol: 0.03, buySol: 0.01 },
      localPolicyVersion: { EA: ENV.payload.policy.version }, sessionWindowOk: true, walletPresent: true, balanceSol: 1, duplicatePosition: () => false,
      pilot: { selection: { kind: 'arm', arm: 'B1' }, maxPerDay: 3, usedToday: 0, armsKnown: true },
    };
    const now = ENV.payload.entry.priced_at + 1_000;
    expect(decideAutoBuy(ENV.payload, ENV.ca as string, now, now, base)).toMatchObject({ action: 'skip', reason: 'off' });
    expect(decideAutoBuy(ENV.payload, ENV.ca as string, now, now, { ...base, liveReportId: 'pilot:arm-B1' })).toMatchObject({ action: 'buy', arm: 'B1' });
    // the pilot day count blocks at maxPerDay
    expect(decideAutoBuy(ENV.payload, ENV.ca as string, now, now, { ...base, liveReportId: 'pilot:arm-B1', pilot: { ...base.pilot!, usedToday: 3 } }))
      .toMatchObject({ action: 'skip', reason: 'cap_day' });
  });

  it('PILOT-T15 after a restart the pilot skips until the arms were read (fail closed)', async () => {
    const h = await pilotRig();
    await pilotOn(h, 'B1');
    const h2 = h.restart();
    const { d } = await h2.run({ arms: { B1: true } });
    expect(d).toMatchObject({ action: 'skip', reason: 'off' });
    expect(h2.notices.some(n => n.startsWith('PILOT: Live auto-buy is skipping signals'))).toBe(true);
    await h2.svc.refreshArms();
    expect((await h2.run({ arms: { B1: true } })).x?.status).toBe('submitted');
  });
});

describe('PILOT: no arms list -> grade A only', () => {
  it('PILOT-T16 with no arm at all from the Engine, /autobuy on (no arm) offers the grade-A selection; only grade A (B2 eligible) is bought', async () => {
    const h = await pilotRig(PILOT_ENV, { noArms: true });
    const on = await h.owner('/autobuy on');
    expect(on).toContain('PILOT');
    expect(on).toContain('the Engine reports no arms');
    expect(on).toContain('grade A only');
    expect(on).toContain('CONFIRM PILOT GRADE-A');
    const ok = await h.owner('CONFIRM PILOT GRADE-A');
    expect(ok).toMatch(/^Auto-buy is LIVE in PILOT mode/);
    expect(ok).toContain('grade A only');
    expect(h.stateFile()).toMatchObject({ mode: 'live', live_arm: 'B2', report_id: PILOT_GRADE_A_REPORT });

    // grade B (even with B1 eligible) and grade C: skipped
    expect((await runWith(h, p => { p.grade = 'B'; }, { arms: { B1: true, B2: false } })).d).toMatchObject({ action: 'skip', reason: 'arm_blocked' });
    expect((await runWith(h, p => { p.grade = 'C'; }, { arms: { BS: true, B2: true } })).d).toMatchObject({ action: 'skip', reason: 'arm_blocked' });
    // grade A without B2 eligible (an inconsistent signal): skipped, fail closed
    expect((await runWith(h, p => { p.grade = 'A'; }, { arms: { B2: false } })).d).toMatchObject({ action: 'skip', reason: 'arm_blocked' });
    expect(h.router.calls).toHaveLength(0);
    // grade A: bought, and the buy card names the selection
    const { d, x } = await runWith(h, p => { p.grade = 'A'; }, { arms: { B2: true } });
    expect(d).toEqual({ action: 'buy', reason: null, arm: 'B2', forceDryRun: false });
    expect(x?.status).toBe('submitted');
    const card = h.notices.find(n => n.includes('auto-buy SENT'));
    expect(card).toMatch(/^PILOT: /);
    expect(card).toContain('grade A only');
    const st = await h.owner('/autobuy status');
    expect(st).toContain('PILOT on: max 0.01 SOL per buy, 3 per UTC day, used 1 today, not go-live tested');
    expect(st).toContain('grade A only');
  });

  it('PILOT-T17 /autobuy on without an arm is refused while the Engine reports arms; a named arm is used even with no arms list', async () => {
    const h = await pilotRig();
    expect(await h.owner('/autobuy on')).toMatch(/^Refused: pick an arm/);
    const n = await pilotRig(PILOT_ENV, { noArms: true });
    const on = await n.owner('/autobuy on B1');
    expect(on).toContain('B1 has no go-live PASS (not in the Engine\'s arms list)');
    expect(on).toContain('CONFIRM PILOT B1');
    expect(await n.owner('CONFIRM PILOT B1')).toMatch(/^Auto-buy is LIVE in PILOT mode/);
    expect(n.stateFile()).toMatchObject({ live_arm: 'B1', report_id: 'pilot:arm-B1' });
  });

  it('PILOT-T18 the grade-A confirmation is refused when the Engine reports arms by then', async () => {
    const h = await pilotRig(PILOT_ENV, { noArms: true });
    await h.owner('/autobuy on');
    h.engine.payload = fixture<{ payload: ArmsStatusPayload }>('arms.status').payload;
    expect(await h.owner('CONFIRM PILOT GRADE-A')).toMatch(/^Refused: PILOT: the Engine now reports arms/);
    expect(h.svc.heartbeat().autobuy.mode).toBe('off');
  });
});

describe('PILOT: visibility', () => {
  it('PILOT-T19 status line, boot line and the one-time armed notice', async () => {
    const h = await pilotRig({ AUTOBUY_PILOT: 'on', AUTOBUY_PILOT_MAX_SOL: '0.02', AUTOBUY_PILOT_MAX_PER_DAY: '2' });
    h.svc.start();
    h.svc.start();
    const armed = h.notices.filter(n => n.includes('PILOT is armed'));
    expect(armed).toHaveLength(1);
    expect(armed[0]).toContain('max 0.02 SOL per buy, 2 per UTC day');
    expect(armed[0]).toContain('not go-live tested');
    expect(h.svc.bootLine()).toContain('PILOT on (max 0.02 SOL per buy, 2 per UTC day)');
    const st = await h.owner('/autobuy status');
    expect(st).toContain('PILOT on: max 0.02 SOL per buy, 2 per UTC day, used 0 today, not go-live tested');
    expect(h.svc.pilotCard?.()).toBeNull();                                        // PILOT-T25: no card clamp before it is live
    await pilotOn(h, 'B1');
    expect(h.svc.pilotCard?.()).toEqual({ maxSol: 0.02, maxPerDay: 2 });          // PILOT-T25: the card shows the clamped size once live
    expect(await h.owner('/autobuy status')).toMatch(/mode: LIVE in PILOT mode on arm B1/);
    expect(await h.owner('/autobuy status')).toContain("PILOT selection: arm B1's selection");
  });

  it('PILOT-T20 a refused pilot config says so in the status, the boot line and one notice; auto-buy follows the normal rules', async () => {
    const h = await pilotRig({ AUTOBUY_PILOT: '1', AUTOBUY_PILOT_MAX_SOL: 'lots' });
    h.svc.start();
    expect(h.notices.filter(n => n.includes('PILOT refused'))).toHaveLength(1);
    expect(h.svc.bootLine()).toContain('PILOT refused');
    expect(await h.owner('/autobuy status')).toContain('PILOT refused');
    expect(await h.owner('/autobuy on B1')).toMatch(/^Refused: arm B1 is INSUFFICIENT, not PASS/);
    expect(h.svc.pilotLive()).toBe(false);
  });

  it('PILOT-T21 the intake notice of an auto-bought signal says PILOT while the pilot is live', async () => {
    const clock = new FakeClock(FIXTURE_NOW);
    const outbox = new MemoryOutbox();
    const telegram = new FakeTelegram(clock);
    const queue = createSendQueue({ clock, telegram, chatId: 'chat-main', ownerChatId: 'chat-owner', outbox, newEventId: newTestUlid, log: () => undefined });
    const inbox = createInbox({ dir: tempDir(), clock, log: () => undefined });
    const autobuy = new StubAutoBuy(clock);
    const pilot = { live: true };
    const intake = createIntake({
      clock, autobuy, exits: new StubExits(), outbox, tg: queue, registry: inbox, tgMinGrade: () => 'B', newEventId: newTestUlid, log: () => undefined,
      pilotLive: () => pilot.live,
    });
    autobuy.decision = { action: 'buy', reason: null, arm: 'BS', forceDryRun: false };
    const ev = freshEvent(fixture<Envelope<'signal.new', SignalNew>>('signal.new'), newCa());
    ev.payload.grade = 'C';
    await intake.handle(ev, { receivedAt: clock.now(), ackedAt: clock.now() });
    await clock.settle();
    expect(telegram.calls).toHaveLength(1);
    expect(telegram.calls[0].text).toContain('PILOT auto-bought grade-C signal (not in your feed)');
    void POLICY_VERSION;
  });
});
