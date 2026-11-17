// A-114 (owner decision 2026-10-26): the auto-buy PILOT. Pure: no clock, no file, no network, no process.env.
//
// The owner wants to try live auto-buy with tiny amounts before any arm has a go-live PASS (a fresh Engine store reports no arms). With
// AUTOBUY_PILOT on, the ONLY rule relaxed is the arm's go-live PASS requirement (decide.ts step 4, the api.ts switch-off when a verdict is
// not PASS, and what /autobuy on + CONFIRM require about a PASS or about the arm being in the Engine's arms list). Everything else stays:
// the owner types /autobuy on and the CONFIRM, BOT_DRY_RUN=0 is still needed for a send, staleness, the impact cap, the reserve, the
// hour/day/SOL caps, max open positions, the pending journal, single-send, one buy per CA, fill verification, exits, the pauses and every
// fail-closed route rule. On top of them the pilot is stricter:
//   - size min(buy amount, AUTOBUY_PILOT_MAX_SOL) (default 0.01, never above 0.05);
//   - at most AUTOBUY_PILOT_MAX_PER_DAY pilot buys per UTC day (default 3, 1..10), counted when the buy is SENT and persisted in
//     autobuy-caps.json before the send (trade-guards.AutoBuyCaps), so a restart never resets it;
//   - never a token the signal marks as killed, rug-flagged, launch-run (already pumped, or present but unknown), safety-pending or
//     unpriceable (pilotBlock);
//   - an arm the Engine rated FAIL, RETIRED or BIASED is never piloted (only "no PASS yet" is tolerated, not a negative verdict);
//   - only a state confirmed with CONFIRM PILOT (a "pilot:" report id) is excused from the PASS: a normal PASS confirmation keeps its
//     PASS rule while the pilot is on, and its buys still get the pilot size and the pilot count.
//
// Which signals: the arm the owner names in /autobuy on (the Engine's per-signal eligibility of that arm), or, when the Engine reports no
// arms at all and the owner names none, the grade-A selection: signals the Engine delivers to Telegram with grade A only (the Engine gives
// grade A exactly when arm B2 is eligible, so the state records arm B2 and the decision also requires B2 eligible: fail closed).
// A pilot confirmation is recorded with a report id that starts with "pilot:"; a start without the pilot switches such a state off.
import type { ArmId } from '../shared/common/ids';
import type { ArmStatus, SignalNew } from '../shared/contract/v1';

/** decide.ts LAUNCH_RUN_LABEL_ID (repeated here so decide.ts can import this module without an import cycle). */
const LAUNCH_RUN_ID = 'launch-run';

export const AUTOBUY_PILOT_MAX_SOL_DEFAULT = 0.01;
export const AUTOBUY_PILOT_MAX_SOL_CEILING = 0.05;
export const AUTOBUY_PILOT_MAX_PER_DAY_DEFAULT = 3;
export const AUTOBUY_PILOT_MAX_PER_DAY_MIN = 1;
export const AUTOBUY_PILOT_MAX_PER_DAY_MAX = 10;

/** The values of AUTOBUY_PILOT that turn the pilot on (trimmed, any case). Anything else, unset included, is off. */
export const PILOT_ON_WORDS: ReadonlySet<string> = new Set(['1', 'true', 'on', 'yes']);

export const PILOT_REPORT_PREFIX = 'pilot:';
/** The report id of the grade-A selection (arm B2 in the state). */
export const PILOT_GRADE_A_REPORT = 'pilot:grade-A';
/** The report id of a named-arm pilot confirmation. */
export const pilotArmReport = (arm: ArmId): string => `${PILOT_REPORT_PREFIX}arm-${arm}`;
export const isPilotReport = (reportId: string | null): boolean => typeof reportId === 'string' && reportId.startsWith(PILOT_REPORT_PREFIX);

/** The arm the grade-A selection is recorded with: the Engine gives grade A exactly when B2 is eligible. */
export const PILOT_GRADE_A_ARM: ArmId = 'B2';

/** Verdicts the pilot never buys (the pilot tolerates "no PASS yet", not a negative verdict). */
export const PILOT_REFUSED_VERDICTS: ReadonlySet<ArmStatus['verdict']> = new Set(['FAIL', 'RETIRED', 'BIASED']);

export interface PilotConfig {
  /** True only when AUTOBUY_PILOT is on AND both pilot limits are usable. */
  enabled: boolean;
  /** AUTOBUY_PILOT asked for the pilot (true even when a limit refused it). */
  requested: boolean;
  maxSol: number;
  maxPerDay: number;
  /** Why a requested pilot is refused (null when it is enabled or was not asked for). */
  refused: string | null;
  /** One line per clamped or refused value, for the log. */
  warnings: string[];
}

export type PilotSelection = { kind: 'grade-A' } | { kind: 'arm'; arm: ArmId | null };

const DECIMAL_RE = /^(\d+(\.\d*)?|\.\d+)$/;

/** AUTOBUY_PILOT, AUTOBUY_PILOT_MAX_SOL, AUTOBUY_PILOT_MAX_PER_DAY. A value above its bound is clamped DOWN (warned); a value that is not
 *  usable (not a number, <= 0, a fractional count) refuses the pilot: someone who typed a limit wanted one, so it is never replaced by a default. Pure. */
export function pilotConfigFromEnv(env: Readonly<Record<string, string | undefined>>): PilotConfig {
  const requested = PILOT_ON_WORDS.has((env.AUTOBUY_PILOT ?? '').trim().toLowerCase());
  const off: PilotConfig = {
    enabled: false, requested, maxSol: AUTOBUY_PILOT_MAX_SOL_DEFAULT, maxPerDay: AUTOBUY_PILOT_MAX_PER_DAY_DEFAULT, refused: null, warnings: [],
  };
  if (!requested) return off;
  const warnings: string[] = [];
  const problems: string[] = [];

  let maxSol = AUTOBUY_PILOT_MAX_SOL_DEFAULT;
  const rawSol = (env.AUTOBUY_PILOT_MAX_SOL ?? '').trim();
  if (rawSol !== '') {
    const n = DECIMAL_RE.test(rawSol) ? Number(rawSol) : Number.NaN;
    if (!Number.isFinite(n) || !(n >= 1e-9)) {
      problems.push(`AUTOBUY_PILOT_MAX_SOL=${rawSol.slice(0, 20)} is not a SOL amount above 0`);
    } else if (n > AUTOBUY_PILOT_MAX_SOL_CEILING) {
      maxSol = AUTOBUY_PILOT_MAX_SOL_CEILING;
      warnings.push(`AUTOBUY_PILOT_MAX_SOL=${n} is above the pilot ceiling: clamped to ${AUTOBUY_PILOT_MAX_SOL_CEILING}`);
    } else {
      maxSol = n;
    }
  }

  let maxPerDay = AUTOBUY_PILOT_MAX_PER_DAY_DEFAULT;
  const rawDay = (env.AUTOBUY_PILOT_MAX_PER_DAY ?? '').trim();
  if (rawDay !== '') {
    const n = /^\d+$/.test(rawDay) ? Number(rawDay) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < AUTOBUY_PILOT_MAX_PER_DAY_MIN) {
      problems.push(`AUTOBUY_PILOT_MAX_PER_DAY=${rawDay.slice(0, 20)} is not a whole number from ${AUTOBUY_PILOT_MAX_PER_DAY_MIN} to ${AUTOBUY_PILOT_MAX_PER_DAY_MAX}`);
    } else if (n > AUTOBUY_PILOT_MAX_PER_DAY_MAX) {
      maxPerDay = AUTOBUY_PILOT_MAX_PER_DAY_MAX;
      warnings.push(`AUTOBUY_PILOT_MAX_PER_DAY=${n} is above the pilot ceiling: clamped to ${AUTOBUY_PILOT_MAX_PER_DAY_MAX}`);
    } else {
      maxPerDay = n;
    }
  }

  if (problems.length > 0) {
    const refused = `${problems.join('; ')}: the pilot stays off`;
    return { ...off, refused, warnings: [...warnings, refused] };
  }
  return { enabled: true, requested, maxSol, maxPerDay, refused: null, warnings };
}

/** The selection a live state stands for: the grade-A selection for its report id, else the live arm's eligibility. */
export function pilotSelectionOf(reportId: string | null, liveArm: ArmId | null): PilotSelection {
  return reportId === PILOT_GRADE_A_REPORT ? { kind: 'grade-A' } : { kind: 'arm', arm: liveArm };
}

/** The owner-facing name of a selection (the /autobuy status text and the buy card). */
export function pilotSelectionText(sel: PilotSelection): string {
  if (sel.kind === 'grade-A') return 'signals the Engine delivers to Telegram with grade A only (grade A = arm B2 eligible)';
  return `arm ${sel.arm ?? '?'}'s selection (signals the Engine marks eligible for ${sel.arm ?? '?'})`;
}

const RUG_ID_RE = /rug/i;

/**
 * Why the pilot must not buy this signal, or null. On top of the arm eligibility (decide.ts step 7) and the launch-run rule (step 7a):
 * the grade-A selection needs grade A; never a rug-flagged (a label whose id names a rug, true),
 * launch-run (true, unknown or not reported: fail closed, the pilot is not go-live tested), safety-pending or unpriceable (entry price or
 * market cap not a positive finite number) token. Pure.
 */
export function pilotBlock(sig: SignalNew, sel: PilotSelection): string | null {
  if (sel.kind === 'grade-A' && sig.grade !== 'A') return `grade ${String(sig.grade)} (the pilot selection is grade A only)`;
  const labels = Array.isArray(sig.labels) ? sig.labels : [];
  const rug = labels.find(l => RUG_ID_RE.test(l.id) && l.value === true);
  if (rug !== undefined) return `rug-flagged (${rug.id})`;
  // fail closed: the pilot buys only when the Engine reported launch-run AND it is known false (an absent label is unknown, A-96)
  const lr = labels.find(l => l.id === LAUNCH_RUN_ID);
  if (lr === undefined) return 'launch-run not reported (fail closed)';
  if (lr.value !== false) return lr.value === true ? 'launch-run (already pumped)' : 'launch-run unknown (the run-up since launch was not measured)';
  if (sig.safety?.status !== 'clean') return 'safety not clean';
  const e = sig.entry;
  const pos = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (e === undefined || e === null || !pos(e.price_usd) || !pos(e.mcap_usd) || !(typeof e.priced_at === 'number' && Number.isFinite(e.priced_at))) return 'unpriceable (no usable entry price)';
  return null;
}

/** "0.01" for 0.01: the SOL amount as typed, without float noise. */
export const solText = (n: number): string => String(+n.toFixed(9));

/** The /autobuy status line of an enabled pilot. */
export function pilotStatusLine(cfg: Pick<PilotConfig, 'maxSol' | 'maxPerDay'>, usedToday: number): string {
  return `PILOT on: max ${solText(cfg.maxSol)} SOL per buy, ${cfg.maxPerDay} per UTC day, used ${usedToday} today, not go-live tested`;
}

/** What the commands module needs to know about the pilot (null-free view; `enabled` false = the normal go-live rules). */
export interface PilotView {
  enabled: boolean;
  requested: boolean;
  refused: string | null;
  maxSol: number;
  maxPerDay: number;
  usedToday: number;
}
