/**
 * The pure auto-buy decision (B20 section 2). Every fixture starts from the signal.new fixture of the link tests; time is explicit.
 */
import { describe, expect, it } from 'vitest';
import { fixture } from '../link/link-testkit';
import type { ArmStatus, BuyReason, Envelope, SignalNew } from '../shared/contract/v1';
import { AUTOBUY_STALE_MS, LAUNCH_RUN_LABEL_ID, activeArm, decideAutoBuy, hasLaunchRunLabel, liveStateComplete, type AutoBuyState } from './decide';
import type { ArmId } from '../shared/common/ids';

const ENV = fixture<Envelope<'signal.new', SignalNew>>('signal.new');
const CA = ENV.ca as string;
const PRICED_AT = ENV.payload.entry.priced_at;
const VERSION = ENV.payload.policy.version;

const pass = (arm: 'B1' | 'BS' = 'B1'): ArmStatus => ({
  arm, registered_at: 1, registry_sha: 'sha', verdict: 'PASS', n_matured: 50, days: 9, look: 1, lcb_token: 0.02, lcb_day: 0.01, report_id: 'report-1', evaluated_at: 2,
});

/** A state in which the decision is a live buy of arm B1. */
function liveState(): AutoBuyState {
  return {
    mode: 'live', dryRunArm: null, liveArm: 'B1', liveReportId: 'report-1', liveConfirmedAt: 5, dryRun: false,
    armVerdicts: { B1: pass() }, boughtCas: new Set(), signalledCas: new Set(), pause: null,
    caps: { hour: 0, day: 0, solDay: 0, openPositions: 0 },
    limits: { perHour: 3, perDay: 20, solPerDay: 0.2, maxOpen: 5, reserveSol: 0.03, buySol: 0.01 },
    localPolicyVersion: { EA: VERSION }, sessionWindowOk: true, walletPresent: true, balanceSol: 1, duplicatePosition: () => false,
  };
}
const sigCopy = (): SignalNew => JSON.parse(JSON.stringify(ENV.payload)) as SignalNew;
const decide = (sig: SignalNew, s: AutoBuyState, now = PRICED_AT + 1_000) => decideAutoBuy(sig, CA, now, now, s);

describe('decideAutoBuy', () => {
  it('B2-T01 every BuyReason of the decision is reached by one fixture, in the order of the spec', () => {
    // One state that breaks every check at once; each step repairs the check that fired and the NEXT one must fire.
    const s = liveState();
    const sig = sigCopy();
    let now = PRICED_AT + 1_000;
    s.mode = 'off';
    s.localPolicyVersion = { EA: 'some-other-version' };
    s.signalledCas = new Set([CA]);
    s.armVerdicts = { B1: { ...pass(), verdict: 'INSUFFICIENT' } };
    now = PRICED_AT + AUTOBUY_STALE_MS + 1;
    s.boughtCas = new Set([CA]);
    sig.arms.B1 = { eligible: false, blocked_by: ['safety-pending'], unknown_inputs: [] };
    s.sessionWindowOk = false;
    s.pause = 'paused_fails';
    s.caps = { hour: 3, day: 20, solDay: 0.2, openPositions: 5 };
    s.balanceSol = 0.03;
    s.duplicatePosition = () => true;
    s.walletPresent = false;

    const steps: Array<{ expect: BuyReason | 'buy'; repair: () => void }> = [
      { expect: 'off', repair: () => { s.mode = 'live'; } },
      { expect: 'policy_mismatch', repair: () => { s.localPolicyVersion = { EA: VERSION }; } },
      { expect: 'contract_violation', repair: () => { s.signalledCas = new Set(); } },
      { expect: 'off', repair: () => { s.armVerdicts = { B1: pass() }; } },
      { expect: 'stale', repair: () => { now = PRICED_AT + 1_000; } },
      { expect: 'already_bought', repair: () => { s.boughtCas = new Set(); } },
      { expect: 'arm_blocked', repair: () => { sig.arms.B1 = { eligible: true, blocked_by: [], unknown_inputs: [] }; } },
      { expect: 'outside_session', repair: () => { s.sessionWindowOk = true; } },
      { expect: 'paused_fails', repair: () => { s.pause = null; } },
      { expect: 'cap_hour', repair: () => { s.caps.hour = 0; } },
      { expect: 'cap_day', repair: () => { s.caps.day = 0; } },
      { expect: 'cap_sol_day', repair: () => { s.caps.solDay = 0; } },
      { expect: 'max_positions', repair: () => { s.caps.openPositions = 0; } },
      { expect: 'reserve', repair: () => { s.balanceSol = 1; } },
      { expect: 'duplicate_position', repair: () => { s.duplicatePosition = () => false; } },
      { expect: 'no_wallet', repair: () => { s.walletPresent = true; } },
      { expect: 'buy', repair: () => undefined },
    ];
    for (const [i, step] of steps.entries()) {
      const d = decide(sig, s, now);
      if (step.expect === 'buy') {
        expect(d, `step ${i}`).toEqual({ action: 'buy', reason: null, arm: 'B1', forceDryRun: false });
      } else {
        expect(d.action, `step ${i}`).toBe('skip');
        expect(d.reason, `step ${i}`).toBe(step.expect);
      }
      step.repair();
    }
    // the other two pauses are the same check with another reason
    for (const pause of ['paused_rolling', 'paused_breaker'] as const) {
      expect(decide(sigCopy(), { ...liveState(), pause }).reason).toBe(pause);
    }
  });

  it('B2-T02 an entry price 5001 ms old is stale and one exactly 5000 ms old is not', () => {
    const sig = sigCopy();
    expect(decide(sig, liveState(), PRICED_AT + 5_001)).toMatchObject({ action: 'skip', reason: 'stale', arm: 'B1' });
    expect(decide(sig, liveState(), PRICED_AT + 5_000).action).toBe('buy');
    // measured from the entry price time, never from first reach: an old first_reach_at does not matter
    const old = sigCopy();
    old.decision.first_reach_at = PRICED_AT - 600_000;
    expect(decide(old, liveState(), PRICED_AT + 4_000).action).toBe('buy');
  });

  it('B2-T09 a pending safety check blocks every arm in the signal and is arm_blocked at once, with no waiting action', () => {
    const sig = sigCopy();
    sig.safety = { status: 'pending', as_of: null, checked: [], missing: ['security'] };
    for (const arm of ['BS', 'B0', 'B1', 'B2'] as const) sig.arms[arm] = { eligible: false, blocked_by: ['safety-pending'], unknown_inputs: [] };
    const d = decide(sig, liveState());
    expect(d).toEqual({ action: 'skip', reason: 'arm_blocked', arm: 'B1', forceDryRun: false });
    expect(Object.keys(d).sort()).toEqual(['action', 'arm', 'forceDryRun', 'reason']);   // nothing in the decision asks for a wait
    // a line-unconfirmed block behaves the same way
    const sig2 = sigCopy();
    sig2.arms.B1 = { eligible: false, blocked_by: ['line-unconfirmed'], unknown_inputs: [] };
    expect(decide(sig2, liveState()).reason).toBe('arm_blocked');
  });

  it('B2-T10 a policy version that differs from the local one is policy_mismatch, with no fallback policy', () => {
    const sig = sigCopy();
    sig.policy = { id: 'EA', version: '0000000000000000' };
    expect(decide(sig, liveState())).toMatchObject({ action: 'skip', reason: 'policy_mismatch' });
    // a policy id the bot has no version for
    expect(decide(sigCopy(), { ...liveState(), localPolicyVersion: {} }).reason).toBe('policy_mismatch');
    // inherited object keys are not policies
    const proto = sigCopy();
    (proto.policy as { id: string }).id = 'toString';
    expect(decide(proto, liveState()).reason).toBe('policy_mismatch');
  });

  it('B2-T11 in dry_run mode an entry price 4000 ms old buys (forceDryRun) and 5001 ms old is stale', () => {
    const dry: AutoBuyState = { ...liveState(), mode: 'dry_run', dryRunArm: 'B1', liveArm: null, liveReportId: null, liveConfirmedAt: null, armVerdicts: {} };
    expect(decide(sigCopy(), dry, PRICED_AT + 4_000)).toEqual({ action: 'buy', reason: null, arm: 'B1', forceDryRun: true });
    expect(decide(sigCopy(), dry, PRICED_AT + 5_001)).toEqual({ action: 'skip', reason: 'stale', arm: 'B1', forceDryRun: true });
  });
});

describe('decideAutoBuy: the owner pre-pump rule (A-96)', () => {
  const launchRun = (value: boolean | null): SignalNew['labels'][number] => ({ id: LAUNCH_RUN_LABEL_ID, rule_version: 'launch-run@1', value, known: value !== null, acting: true });
  const withLabel = (value: boolean | null): SignalNew => { const s = sigCopy(); s.labels = [...s.labels, launchRun(value)]; return s; };
  const armState = (arm: ArmId, mode: 'live' | 'dry_run'): AutoBuyState => (mode === 'live'
    ? { ...liveState(), liveArm: arm, armVerdicts: { [arm]: pass(arm as 'B1' | 'BS') } as AutoBuyState['armVerdicts'] }
    : { ...liveState(), mode: 'dry_run', dryRunArm: arm, liveArm: null, liveReportId: null, liveConfirmedAt: null, armVerdicts: {} });

  it('PPA-T11 a signal with label launch-run true is arm_blocked at EVERY arm (BS, B0, B1 and B2, live and dry-run) even when the Engine marks that arm eligible, while the same signal without it buys; every earlier reason keeps its order', () => {
    for (const mode of ['live', 'dry_run'] as const) {
      for (const arm of ['BS', 'B0', 'B1', 'B2'] as const) {
        const sig = withLabel(true);
        sig.arms[arm] = { eligible: true, blocked_by: [], unknown_inputs: [] };       // the Engine itself would let the arm buy
        const forceDryRun = mode === 'dry_run';
        expect(decide(sig, armState(arm, mode)), `${mode} ${arm}`).toEqual({ action: 'skip', reason: 'arm_blocked', arm, forceDryRun });
        // without the label, or with a false / unknown one, the very same state buys
        for (const v of [false, null] as const) {
          const ok = withLabel(v);
          ok.arms[arm] = { eligible: true, blocked_by: [], unknown_inputs: [] };
          expect(decide(ok, armState(arm, mode)).action, `${mode} ${arm} ${String(v)}`).toBe('buy');
        }
        const plain = sigCopy();
        plain.arms[arm] = { eligible: true, blocked_by: [], unknown_inputs: [] };
        expect(decide(plain, armState(arm, mode)).action).toBe('buy');
      }
    }
    // the check sits after step 7 and before step 8: earlier reasons win, later ones are never reached
    const hot = withLabel(true);
    expect(decide(hot, { ...liveState(), mode: 'off' }).reason).toBe('off');
    expect(decide(hot, { ...liveState(), localPolicyVersion: { EA: 'other' } }).reason).toBe('policy_mismatch');
    expect(decide(hot, { ...liveState(), signalledCas: new Set([CA]) }).reason).toBe('contract_violation');
    expect(decide(hot, liveState(), PRICED_AT + AUTOBUY_STALE_MS + 1).reason).toBe('stale');
    expect(decide(hot, { ...liveState(), boughtCas: new Set([CA]) }).reason).toBe('already_bought');
    expect(decide(hot, { ...liveState(), sessionWindowOk: false }).reason).toBe('arm_blocked');   // not outside_session: 7a comes first
    expect(decide(hot, { ...liveState(), pause: 'paused_fails', caps: { hour: 9, day: 99, solDay: 99, openPositions: 9 }, walletPresent: false }).reason).toBe('arm_blocked');
    // the helper itself: only { id: 'launch-run', value: true } counts
    expect(hasLaunchRunLabel(hot.labels)).toBe(true);
    expect(hasLaunchRunLabel([launchRun(false), launchRun(null)])).toBe(false);
    expect(hasLaunchRunLabel([{ id: 'launch-run-2x', value: true }])).toBe(false);
    expect(hasLaunchRunLabel(undefined)).toBe(false);
  });
});

describe('decideAutoBuy modes', () => {
  it('dry_run needs no PASS verdict, never reads BOT_DRY_RUN for forceDryRun, and uses the dry-run arm', () => {
    const s: AutoBuyState = { ...liveState(), mode: 'dry_run', dryRunArm: 'BS', liveArm: null, liveReportId: null, liveConfirmedAt: null, armVerdicts: {}, dryRun: false };
    expect(decide(sigCopy(), s)).toEqual({ action: 'buy', reason: null, arm: 'BS', forceDryRun: true });
    expect(decide(sigCopy(), { ...s, dryRun: true }).forceDryRun).toBe(true);
  });

  it('live follows BOT_DRY_RUN: env on means forceDryRun true, env off means false', () => {
    expect(decide(sigCopy(), { ...liveState(), dryRun: true })).toEqual({ action: 'buy', reason: null, arm: 'B1', forceDryRun: true });
    expect(decide(sigCopy(), { ...liveState(), dryRun: false }).forceDryRun).toBe(false);
  });

  it('live without the arm, the report id or the confirmation time is off, and so is dry_run without its arm', () => {
    for (const patch of [{ liveArm: null }, { liveReportId: null }, { liveConfirmedAt: null }] as const) {
      const s: AutoBuyState = { ...liveState(), ...patch };
      expect(liveStateComplete(s)).toBe(false);
      expect(activeArm(s)).toBeNull();
      expect(decide(sigCopy(), s)).toEqual({ action: 'skip', reason: 'off', arm: null, forceDryRun: false });
    }
    expect(decide(sigCopy(), { ...liveState(), mode: 'dry_run', dryRunArm: null }).reason).toBe('off');
    expect(activeArm(liveState())).toBe('B1');
  });

  it('live with a verdict that is not PASS (or no verdict at all) is off', () => {
    for (const verdict of ['FAIL', 'RETIRED', 'BIASED', 'INSUFFICIENT'] as const) {
      expect(decide(sigCopy(), { ...liveState(), armVerdicts: { B1: { ...pass(), verdict } } }).reason, verdict).toBe('off');
    }
    expect(decide(sigCopy(), { ...liveState(), armVerdicts: {} }).reason).toBe('off');
  });

  it('a CA signalled before beats the stale check, and the AUTOBUY_STALE_MS override moves the boundary', () => {
    const s = { ...liveState(), signalledCas: new Set([CA]) };
    expect(decide(sigCopy(), s, PRICED_AT + 60_000).reason).toBe('contract_violation');
    expect(decide(sigCopy(), { ...liveState(), staleMs: 1_000 }, PRICED_AT + 1_001).reason).toBe('stale');
    expect(decide(sigCopy(), { ...liveState(), staleMs: 1_000 }, PRICED_AT + 1_000).action).toBe('buy');
  });

  it('the cap checks use >= for counts, + buySol > limit for SOL, and an unusable limit blocks instead of meaning no cap', () => {
    expect(decide(sigCopy(), { ...liveState(), caps: { hour: 2, day: 19, solDay: 0.19, openPositions: 4 } }).action).toBe('buy');
    expect(decide(sigCopy(), { ...liveState(), caps: { hour: 2, day: 19, solDay: 0.1900001, openPositions: 4 } }).reason).toBe('cap_sol_day');
    const nan = liveState();
    nan.limits = { ...nan.limits, perHour: Number.NaN };
    expect(decide(sigCopy(), nan).reason).toBe('cap_hour');
    const noReserve = liveState();
    noReserve.limits = { ...noReserve.limits, reserveSol: Number.NaN };
    expect(decide(sigCopy(), noReserve).reason).toBe('reserve');
    // a known short balance blocks, an exact one does not; an UNKNOWN balance blocks a real send too since A-129 c (see the A-129 c tests below)
    expect(decide(sigCopy(), { ...liveState(), balanceSol: null })).toMatchObject({ action: 'skip', reason: 'reserve' });
    expect(decide(sigCopy(), { ...liveState(), balanceSol: 0.0399 }).reason).toBe('reserve');
    expect(decide(sigCopy(), { ...liveState(), balanceSol: 0.04 }).action).toBe('buy');
  });
});

describe('decideAutoBuy: an unknown wallet balance fails closed (A-129 c, finding #5)', () => {
  const dryRunMode = (): AutoBuyState => ({ ...liveState(), mode: 'dry_run', dryRunArm: 'B1', liveArm: null, liveReportId: null, liveConfirmedAt: null, armVerdicts: {} });

  it('R9FX-T05 a buy that would really be sent is refused with reserve while the balance is null; a dry run, BOT_DRY_RUN and every known balance are unchanged', () => {
    // the live decision that used to pass: mode live, BOT_DRY_RUN off, a known-good state except that the balance has not been read
    const open = decide(sigCopy(), { ...liveState(), balanceSol: null });
    expect(open).toEqual({ action: 'skip', reason: 'reserve', arm: 'B1', forceDryRun: false });
    // the same state with a balance is the buy it always was
    expect(decide(sigCopy(), liveState())).toEqual({ action: 'buy', reason: null, arm: 'B1', forceDryRun: false });
    // a dry run never sends, so an unknown balance changes nothing there: dry_run mode, and live with BOT_DRY_RUN on
    expect(decide(sigCopy(), { ...dryRunMode(), balanceSol: null })).toEqual({ action: 'buy', reason: null, arm: 'B1', forceDryRun: true });
    expect(decide(sigCopy(), { ...liveState(), dryRun: true, balanceSol: null })).toEqual({ action: 'buy', reason: null, arm: 'B1', forceDryRun: true });
    expect(decide(sigCopy(), { ...dryRunMode(), dryRun: true, balanceSol: null }).action).toBe('buy');
    // known balances: short blocks, exact and rich buy, in live and in dry runs, exactly as before
    for (const [balance, expected] of [[0.0399, 'reserve'], [0.04, 'buy'], [1, 'buy'], [0, 'reserve']] as const) {
      const live = decide(sigCopy(), { ...liveState(), balanceSol: balance });
      const dry = decide(sigCopy(), { ...dryRunMode(), balanceSol: balance });
      expect(live.action === 'buy' ? 'buy' : live.reason, String(balance)).toBe(expected);
      expect(dry.action === 'buy' ? 'buy' : dry.reason, String(balance)).toBe(expected);
    }
    // it can only turn a live buy into a skip: every other reason keeps its place and its text with a null balance (no wallet means no balance)
    const noBalance = (patch: Partial<AutoBuyState> = {}): AutoBuyState => ({ ...liveState(), balanceSol: null, ...patch });
    expect(decide(sigCopy(), noBalance({ walletPresent: false })).reason).toBe('no_wallet');
    expect(decide(sigCopy(), noBalance({ duplicatePosition: () => true })).reason).toBe('duplicate_position');
    expect(decide(sigCopy(), noBalance({ mode: 'off' })).reason).toBe('off');
    expect(decide(sigCopy(), noBalance({ pause: 'paused_fails' })).reason).toBe('paused_fails');
    expect(decide(sigCopy(), noBalance({ caps: { hour: 3, day: 0, solDay: 0, openPositions: 0 } })).reason).toBe('cap_hour');
    expect(decide(sigCopy(), noBalance(), PRICED_AT + AUTOBUY_STALE_MS + 1).reason).toBe('stale');
  });

  it('the decision of an unknown balance is a pure function of the state: no mutation, same answer twice', () => {
    const s = { ...liveState(), balanceSol: null };
    const before = JSON.stringify({ ...s, boughtCas: [...s.boughtCas], signalledCas: [...s.signalledCas], duplicatePosition: undefined });
    const first = decide(sigCopy(), s);
    expect(decide(sigCopy(), s)).toEqual(first);
    expect(JSON.stringify({ ...s, boughtCas: [...s.boughtCas], signalledCas: [...s.signalledCas], duplicatePosition: undefined })).toBe(before);
  });
});
