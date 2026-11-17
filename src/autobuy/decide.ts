// R2-B2 (B20 section 2): the pure auto-buy decision. No clock, no file, no network: everything it needs is in `AutoBuyState`, which the
// api module assembles per signal. The first failing check returns a `skip` with its reason; nothing here waits for anything (D-09: no
// safety wait; a pending safety check already blocks every arm in the Engine's eligibility).
import type { AutoBuyDecision } from '../bot-contracts';
import type { ArmId } from '../shared/common/ids';
import type { ArmStatus, BuyReason, LabelV1, SignalNew } from '../shared/contract/v1';
import { isPilotReport, pilotBlock, PILOT_REFUSED_VERDICTS, type PilotSelection } from './pilot';

/** The acting label of the owner's pre-pump rule (A-88, A-96): a token younger than 60 min that is already at 3.0x its true launch. */
export const LAUNCH_RUN_LABEL_ID = 'launch-run';

/** True when the labels hold { id: 'launch-run', value: true } (an unknown or false launch-run does not count; a missing list is not a launch-run). */
export function hasLaunchRunLabel(labels: readonly Pick<LabelV1, 'id' | 'value'>[] | undefined): boolean {
  return Array.isArray(labels) && labels.some((l) => l.id === LAUNCH_RUN_LABEL_ID && l.value === true);
}

/** Entry price older than this (measured from `entry.priced_at`, never from first reach) is stale. B20 rule 5. */
export const AUTOBUY_STALE_MS = 5000;

export type AutoBuyMode = 'off' | 'dry_run' | 'live';
export type AutoBuyPause = 'paused_fails' | 'paused_rolling' | 'paused_breaker';

export interface AutoBuyState {
  mode: AutoBuyMode; dryRunArm: ArmId | null; liveArm: ArmId | null; liveReportId: string | null; liveConfirmedAt: number | null;
  /** env BOT_DRY_RUN (true = no send, ever). */
  dryRun: boolean;
  armVerdicts: Partial<Record<ArmId, ArmStatus>>; boughtCas: Set<string>; signalledCas: Set<string>; pause: AutoBuyPause | null;
  caps: { hour: number; day: number; solDay: number; openPositions: number };
  limits: { perHour: number; perDay: number; solPerDay: number; maxOpen: number; reserveSol: number; buySol: number };
  localPolicyVersion: Record<string, string>; sessionWindowOk: boolean; walletPresent: boolean;
  /** The wallet's SOL balance; null = unknown (not read yet). A buy that would really be sent is refused with 'reserve' while it is null (A-129 c). */
  balanceSol: number | null;
  duplicatePosition: (ca: string) => boolean;
  /** Optional override of AUTOBUY_STALE_MS (env AUTOBUY_STALE_MS, read by guards.autoBuyConfigFromEnv). */
  staleMs?: number;
  /**
   * A-114: present only while AUTOBUY_PILOT is on and the mode is live (api.ts). Absent = the decision is exactly the one without the
   * pilot. Present: step 4 tolerates a verdict that is not PASS for a state confirmed in PILOT mode (a "pilot:" report id; never FAIL,
   * RETIRED or BIASED, and only once the verdicts were read since the start; a normal PASS confirmation keeps its PASS check), step 7b
   * applies pilotBlock, and step 10 adds the pilot buys per UTC day. `limits.buySol` is already the pilot size.
   */
  pilot?: { selection: PilotSelection; maxPerDay: number; usedToday: number; armsKnown: boolean };
}

/** True when the state holds everything a live send needs (mode live plus the arm, the report id and the confirmation time). */
export function liveStateComplete(s: Pick<AutoBuyState, 'mode' | 'liveArm' | 'liveReportId' | 'liveConfirmedAt'>): boolean {
  return s.mode === 'live' && s.liveArm !== null && s.liveReportId !== null && s.liveConfirmedAt !== null;
}

/** The arm the current mode acts on: the live arm in mode live, the dry-run arm in mode dry_run, else null. */
export function activeArm(s: Pick<AutoBuyState, 'mode' | 'liveArm' | 'liveReportId' | 'liveConfirmedAt' | 'dryRunArm'>): ArmId | null {
  if (s.mode === 'live') return liveStateComplete(s) ? s.liveArm : null;
  if (s.mode === 'dry_run') return s.dryRunArm;
  return null;
}

const skip = (reason: BuyReason, arm: ArmId | null, forceDryRun: boolean): AutoBuyDecision => ({ action: 'skip', reason, arm, forceDryRun });

/** A limit that is not a positive finite number blocks (an unusable env value must never mean "no cap"). */
const limitBlocks = (used: number, limit: number): boolean => !(limit > 0) || used >= limit;

/**
 * The decision, in the order of B20 section 2. `receivedAt` is carried for the callers' stamps; the stale rule is measured from the
 * entry price time against `now` (at receipt the two are the same instant within the bot's own latency).
 */
export function decideAutoBuy(sig: SignalNew, ca: string, _receivedAt: number, now: number, s: AutoBuyState): AutoBuyDecision {
  // 1. mode: off, or a live mode that lacks its confirmation (a hand-edited state file), is off
  if (s.mode === 'off') return skip('off', null, false);
  if (s.mode === 'live' && !liveStateComplete(s)) return skip('off', null, false);
  if (s.mode === 'dry_run' && s.dryRunArm === null) return skip('off', null, false);
  const arm: ArmId = s.mode === 'live' ? (s.liveArm as ArmId) : (s.dryRunArm as ArmId);
  // dry_run never sends whatever BOT_DRY_RUN says; live follows the env (BOT_DRY_RUN=1 still blocks sends)
  const forceDryRun = s.mode === 'dry_run' ? true : s.dryRun;

  // 2. the exit policy the Engine named must be the one this bot has (no fallback policy)
  const local = Object.prototype.hasOwnProperty.call(s.localPolicyVersion, sig.policy.id) ? s.localPolicyVersion[sig.policy.id] : undefined;
  if (sig.policy.version !== local) return skip('policy_mismatch', arm, forceDryRun);

  // 3. a second signal.new for a CA already signalled
  if (s.signalledCas.has(ca)) return skip('contract_violation', arm, forceDryRun);

  // 4. live: the arm's standing verdict must still be PASS (dry_run skips this check)
  //    (A-114: waived only for a state confirmed in PILOT mode, i.e. with the pilot member AND a "pilot:" report id)
  const pilotWaiver = s.pilot !== undefined && isPilotReport(s.liveReportId);
  if (s.mode === 'live' && !pilotWaiver && s.armVerdicts[arm]?.verdict !== 'PASS') return skip('off', arm, forceDryRun);
  // 4 (A-114 pilot): no PASS is needed, but the verdicts must have been read since the start and a negative verdict is never piloted
  if (s.mode === 'live' && s.pilot !== undefined) {
    const v = s.armVerdicts[arm]?.verdict;
    if (!s.pilot.armsKnown || (v !== undefined && PILOT_REFUSED_VERDICTS.has(v))) return skip('off', arm, forceDryRun);
  }

  // 5. stale: from the entry price time
  const staleMs = s.staleMs !== undefined && Number.isFinite(s.staleMs) && s.staleMs > 0 ? s.staleMs : AUTOBUY_STALE_MS;
  if (now - sig.entry.priced_at > staleMs) return skip('stale', arm, forceDryRun);

  // 6. one auto-buy per CA, ever (the persisted ledger)
  if (s.boughtCas.has(ca)) return skip('already_bought', arm, forceDryRun);

  // 7. the Engine's frozen arm eligibility is the only source (safety-pending and line-unconfirmed arrive here as blocked: no waiting)
  const elig = sig.arms[arm];
  if (!elig || !elig.eligible) return skip('arm_blocked', arm, forceDryRun);

  // 7a. (A-96, round 6) the owner's rule "never send or buy a token that already pumped": a launch-run signal is blocked at EVERY arm, BS and B0 included (user decision
  //     2026-10-25). Every earlier reason keeps its order; no money moves on such a token, so no owner notice can be needed.
  if (hasLaunchRunLabel(sig.labels)) return skip('arm_blocked', arm, forceDryRun);

  // 7b. (A-114 pilot) the pilot selection (grade A only) and never a killed, rug-flagged, launch-run, safety-pending or unpriceable token
  if (s.pilot !== undefined && pilotBlock(sig, s.pilot.selection) !== null) return skip('arm_blocked', arm, forceDryRun);

  // 8. owner session window (off by default)
  if (!s.sessionWindowOk) return skip('outside_session', arm, forceDryRun);

  // 9. pauses
  if (s.pause !== null) return skip(s.pause, arm, forceDryRun);

  // 10. caps and reserve
  const L = s.limits;
  if (limitBlocks(s.caps.hour, L.perHour)) return skip('cap_hour', arm, forceDryRun);
  if (limitBlocks(s.caps.day, L.perDay)) return skip('cap_day', arm, forceDryRun);
  // (A-114 pilot) at most maxPerDay pilot buys per UTC day (counted when sent, persisted in autobuy-caps.json)
  if (s.pilot !== undefined && limitBlocks(s.pilot.usedToday, s.pilot.maxPerDay)) return skip('cap_day', arm, forceDryRun);
  // 1e-9: float sums such as 0.1 + 0.2 must not refuse an exact fill (same epsilon as AutoBuyCaps)
  if (!(L.buySol > 0) || !(L.solPerDay > 0) || s.caps.solDay + L.buySol > L.solPerDay + 1e-9) return skip('cap_sol_day', arm, forceDryRun);
  if (limitBlocks(s.caps.openPositions, L.maxOpen)) return skip('max_positions', arm, forceDryRun);
  if (!(L.reserveSol >= 0)) return skip('reserve', arm, forceDryRun);
  if (s.balanceSol !== null && s.balanceSol + 1e-9 < L.buySol + L.reserveSol) return skip('reserve', arm, forceDryRun);

  // 11. duplicates and the wallet
  if (s.duplicatePosition(ca)) return skip('duplicate_position', arm, forceDryRun);
  if (!s.walletPresent) return skip('no_wallet', arm, forceDryRun);

  // 11b. (A-129 c, finding #5) fail closed: the reserve check of step 10 runs only on a KNOWN balance, so a null one (the first refresh after the start has not
  //      finished, a wallet was linked less than a refresh ago) used to pass as "enough SOL". A buy that would really be sent (forceDryRun already folds in the
  //      dry_run mode and BOT_DRY_RUN) is refused with 'reserve' while the wallet's balance is unknown. A dry-run decision and every other path are unchanged; this
  //      can only turn a live 'buy' into a skip, never a skip into a buy. It sits after the wallet checks so 'duplicate_position' and 'no_wallet' (no wallet means no
  //      balance) keep their reasons.
  if (s.balanceSol === null && !forceDryRun) return skip('reserve', arm, forceDryRun);

  // 12. buy
  return { action: 'buy', reason: null, arm, forceDryRun };
}
