/**
 * A-115 (CARD-MENU spec 6.3 and 6.4 rule 4): the owner's grade preset on auto-buy. The plan is resolved when the buy is decided, travels in
 * the pending-buys journal and stamps the position at open (normal confirm and boot recovery alike); with the default presets nothing
 * changes (EXITP-T02); a dry run never gets a plan (EXITP-T04). The auto-buy harness of autobuy-testkit.ts (stubs, FakeClock, temp folder).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../link/link-testkit';
import { loadPolicies } from '../shared/exit-policy/exit-policy';
import policiesJson from '../shared/exit-policy/exit-policies.json';
import { validateBotBatch } from '../shared/contract/validate';
import { presetToPolicy, resolvePlan, defaultGradePresets, type CustomPreset, type GradePresets } from '../exits/presets';
import { makeHarness, POLICY_VERSION, type Harness } from './autobuy-testkit';

afterAll(() => { cleanupTempDirs(); });
const EA = loadPolicies(policiesJson).EA;
const presetB: CustomPreset = {
  mode: 'custom', rev: 4, enabled: true, source: 'owner', updatedAt: 1, stop: { lossPct: 30, whilePeakBelowPct: null },
  ladder: [{ atPct: 50, sellPctOfOriginal: 35, trigger: 'entryPrice' }], trail: { armAfterPct: 120, trailPct: 35, trigger: 'entryPrice' }, maxHoldH: null,
};

function harness(presets: { value: GradePresets }): Harness {
  return makeHarness({ exitPlan: sig => resolvePlan({ autoSellOnSignal: true, gradePresets: presets.value }, sig.grade, EA).snapshot });
}

async function liveBuyOfGrade(h: Harness, grade: 'A' | 'B' | 'C') {
  await h.goLive('B1');
  const { env, sig } = h.signal();
  sig.grade = grade;
  if (env.ca !== null) h.registry.set(env.ca, env.signal_id as string);
  const now = h.clock.now();
  const d = h.svc.decide(sig, env, now, now);
  const x = d.action === 'buy' ? await h.svc.execute(sig, env, d) : null;
  return { env, d, x };
}

describe('auto-buy with grade presets', () => {
  it('EXITP-T02 every preset on the policy default: the journal has no plan, the position and position.opened carry EA exactly as before', async () => {
    const h = harness({ value: defaultGradePresets() });
    const { x } = await liveBuyOfGrade(h, 'B');
    expect(x?.status).toBe('submitted');
    expect(Object.keys(h.journal()[0])).not.toContain('exit_plan');
    h.rpc.land(x!.tx as string);
    await h.advance(1_000);
    expect(h.positions.openCalls[0].p).not.toHaveProperty('exit_plan');
    expect(h.outbox.of('position.opened')[0].payload.policy).toEqual({ id: 'EA', version: POLICY_VERSION });
  });

  it('EXITP-T03 an edited grade-B preset applies to a NEW live auto-buy: resolved at the decision, journalled, stamped PRESET-B with its version', async () => {
    const presets: { value: GradePresets } = { value: { ...defaultGradePresets(), B: presetB } };
    const h = harness(presets);
    const { x } = await liveBuyOfGrade(h, 'B');
    const want = presetToPolicy(presetB, EA, 'B');
    const j = h.journal()[0] as { exit_plan?: { source: string; grade: string; rev: number; policy: { id: string; version: string } } };
    expect(j.exit_plan).toMatchObject({ source: 'preset', grade: 'B', rev: 4, policy: { id: 'PRESET-B', version: want.version } });
    // EXITP-T05: an edit between submit and confirm changes nothing: the journal entry holds the plan of the decision
    presets.value = { ...defaultGradePresets(), B: { ...presetB, rev: 5, stop: { lossPct: 10, whilePeakBelowPct: null } } };
    h.rpc.land(x!.tx as string);
    await h.advance(1_000);
    expect(h.positions.real[0]).toMatchObject({ policy_id: 'PRESET-B', policy_version: want.version });
    const opened = h.outbox.of('position.opened')[0].payload;
    expect(opened.policy).toEqual({ id: 'PRESET-B', version: want.version });
    const batch = validateBotBatch({ events: h.outbox.events }, h.clock.now());
    expect(batch.ok && batch.events.every(e => e.result.ok)).toBe(true);
  });

  it('EXITP-T05 a restart between the send and the confirm (boot recovery) opens the position with the plan of the decision', async () => {
    const presets: { value: GradePresets } = { value: { ...defaultGradePresets(), B: presetB } };
    const h = harness(presets);
    const { x } = await liveBuyOfGrade(h, 'B');
    presets.value = defaultGradePresets();                      // the owner resets the preset while the bot is down
    const h2 = h.restart();
    h2.rpc.land(x!.tx as string);
    expect(await h2.svc.recover()).toEqual({ resolved: 1, waiting: 0 });
    expect(h2.positions.real.at(-1)).toMatchObject({ policy_id: 'PRESET-B', policy_version: presetToPolicy(presetB, EA, 'B').version });
  });

  it('EXITP-T04 a dry run never gets a plan (presets are real money only)', async () => {
    let asked = 0;
    const h = makeHarness({ exitPlan: sig => { asked++; return resolvePlan({ autoSellOnSignal: true, gradePresets: { ...defaultGradePresets(), B: presetB } }, sig.grade, EA).snapshot; } });
    await h.armDry('B1');
    const r = await h.run();
    expect(r.x?.status).toBe('dry_run');
    expect(asked).toBe(0);
    expect(h.positions.virtual[0].policy_id).toBe('EA');
  });
});
