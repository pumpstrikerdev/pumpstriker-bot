// R2-B2 (B20 section 4): the owner's /autobuy commands and the go-live gate.
//
//   /autobuy [status]       the Engine's arms (verdict, n matured, days, both LCBs, report id) and the bot's mode, arm, confirmed_at
//   /autobuy dryrun <ARM>   mode dry_run on any arm (no PASS needed, nothing is ever sent); refused while mode is live
//   /autobuy on <ARM>       refused unless the arm's standing verdict is PASS; then the owner must type exactly
//                           CONFIRM <ARM> <report_id> (the arm's CURRENT PASS report id); only that sets mode live
//   /autobuy off            mode off at once
//   /autobuy resume         clears a persisted pause, the failure count and the in-memory breaker; the mode does not change
//
// Every reply is plain text (no Markdown), so no character in a report id can break the message. `handle` answers null for a text that is
// not an auto-buy command, so bot.ts can route every owner message through it. The state file is written BEFORE a permissive change takes
// effect (state.ts); a failed write refuses the command.
import type { EngineClient } from '../bot-contracts';
import type { Clock } from '../link/clock';
import { defaultLog, type LinkLog } from '../link/common';
import type { ArmId } from '../shared/common/ids';
import type { ArmsStatusPayload, ArmStatus } from '../shared/contract/v1';
import { errText, type CircuitBreaker } from './guards';
import {
  isPilotReport, pilotArmReport, pilotSelectionOf, pilotSelectionText, pilotStatusLine, PILOT_GRADE_A_ARM, PILOT_GRADE_A_REPORT, PILOT_REFUSED_VERDICTS,
  solText, type PilotView,
} from './pilot';
import { ARM_IDS, isArmId, type AutoBuyStateStore } from './state';

/** How long a /autobuy on request waits for its CONFIRM (spec silent, chosen). */
export const CONFIRM_WINDOW_MS = 300_000;

export interface CommandsDeps {
  clock: Clock;
  state: AutoBuyStateStore;
  engine: Pick<EngineClient, 'arms'>;
  breaker: CircuitBreaker;
  /** BOT_DRY_RUN right now. */
  dryRunEnv: () => boolean;
  /** The local EA policy version, recorded with the confirmation. */
  policyVersion: () => string | null;
  /** Every fresh GET of the arms is applied like an arms.status push (verdict cache, live-arm check). */
  onFreshArms: (p: ArmsStatusPayload) => void;
  /** More status lines (caps used, open positions, pending buys). */
  extraStatus?: () => string[];
  notifyOwner?: (text: string) => void;
  log?: LinkLog;
  /** A-114: the PILOT (pilot.ts) when AUTOBUY_PILOT asked for it; absent = the commands are exactly the ones without the pilot. */
  pilot?: () => PilotView;
}

export interface AutoBuyCommands {
  /** The reply text, or null when `text` is not an auto-buy command. */
  handle(text: string, from: { isOwner: boolean }): Promise<string | null>;
  /** The /autobuy on request that waits for its CONFIRM, or null (for tests and the status line). `pilot` marks a PILOT request (A-114). */
  pendingConfirm(): { arm: ArmId; requestedAt: number; pilot?: 'arm' | 'grade-A' } | null;
}

const COMMAND_RE = /^\/autobuy(?:@\w+)?(?:\s+([\s\S]*))?$/i;
const CONFIRM_RE = /^CONFIRM (BS|B0|B1|B2) (\S+)$/;
const USAGE = 'Usage: /autobuy status | dryrun <ARM> | on <ARM> | off | resume   (ARM is one of BS, B0, B1, B2)';
/** A-114: the PILOT confirmation (only while the pilot is on; otherwise it is refused like any malformed CONFIRM). */
const PILOT_CONFIRM_RE = /^CONFIRM PILOT (BS|B0|B1|B2|GRADE-A)$/;
const PILOT_USAGE = 'PILOT: /autobuy on <ARM> buys that arm\'s selection without a go-live PASS; /autobuy on with no arm, when the Engine reports no arms, buys grade A only.';

const iso = (ms: number | null): string => (ms === null ? 'none' : new Date(ms).toISOString().replace('.000Z', 'Z'));
const num = (v: number | null, digits: number): string => (v === null ? 'n/a' : v.toFixed(digits));

function armLine(a: ArmStatus): string {
  const exec = (a as ArmStatus & { n_executable?: unknown }).n_executable;
  return `${a.arm}  ${a.verdict}  matured ${a.n_matured}  executable ${typeof exec === 'number' ? exec : 'n/a'}  days ${a.days}  `
    + `lcb_token ${num(a.lcb_token, 4)}  lcb_day ${num(a.lcb_day, 4)}  report ${a.report_id ?? 'none'}`;
}

export function createAutoBuyCommands(deps: CommandsDeps): AutoBuyCommands {
  const { clock, state, engine, breaker } = deps;
  const log = deps.log ?? defaultLog;
  let pending: { arm: ArmId; requestedAt: number; pilot?: 'arm' | 'grade-A' } | null = null;
  /** A-114: the pilot view when the pilot is ON (null = the normal go-live rules). */
  const pilotOn = (): PilotView | null => {
    const v = deps.pilot?.();
    return v !== undefined && v.enabled ? v : null;
  };

  async function freshArms(): Promise<ArmsStatusPayload | { error: string }> {
    let r: Awaited<ReturnType<EngineClient['arms']>>;
    try { r = await engine.arms(); } catch (e) { return { error: errText(e).slice(0, 80) }; }
    if ('error' in r) return r;
    try { deps.onFreshArms(r); } catch (e) { log(`autobuy: applying the fresh arms failed (${errText(e)})`, 'err'); }
    return r;
  }

  function modeLine(): string {
    const s = state.get();
    const dry = deps.dryRunEnv();
    const base = s.mode === 'off' ? 'OFF'
      : s.mode === 'dry_run' ? `DRY RUN on arm ${s.dry_run_arm ?? 'none'} (nothing is ever sent)`
      : isPilotReport(s.report_id) ? `LIVE in PILOT mode on arm ${s.live_arm ?? 'none'} (not go-live tested), confirmed_at ${iso(s.confirmed_at)}`
      : `LIVE on arm ${s.live_arm ?? 'none'}, confirmed_at ${iso(s.confirmed_at)}, report ${s.report_id ?? 'none'}`;
    return `mode: ${base}${s.mode === 'live' && dry ? ' (BOT_DRY_RUN is on: no transaction is sent)' : ''}`;
  }

  async function status(): Promise<string> {
    const s = state.get();
    const lines = ['Auto-buy status', modeLine(), `BOT_DRY_RUN: ${deps.dryRunEnv() ? 'on (no transaction is ever sent)' : 'off'}`];
    // A-114: the pilot lines (only when AUTOBUY_PILOT asked for it)
    const pv = deps.pilot?.();
    if (pv !== undefined && pv.enabled) {
      lines.push(pilotStatusLine(pv, pv.usedToday));
      if (s.mode === 'live') lines.push(`PILOT selection: ${pilotSelectionText(pilotSelectionOf(s.report_id, s.live_arm))}; buy size min(buy amount, ${solText(pv.maxSol)} SOL)`);
    } else if (pv !== undefined && pv.requested) {
      lines.push(`PILOT refused: ${pv.refused ?? 'invalid limits'} (the normal go-live rules apply)`);
    }
    const br = breaker.check(clock.now());
    lines.push(`pause: ${s.pause !== null ? `${s.pause} (${s.pause_reason ?? 'no reason recorded'}) - /autobuy resume` : br.tripped ? `paused_breaker (${br.detail}) - /autobuy resume` : 'none'}`);
    lines.push(`consecutive failed buys: ${s.consecutive_fails}; rolling window: ${s.rolling.length} closed real trades`
      + (state.rollingMean() === null ? '' : `, mean net ${((state.rollingMean() ?? 0) * 100).toFixed(1)}% per SOL in`));
    if (deps.extraStatus) for (const l of deps.extraStatus()) lines.push(l);
    const arms = await freshArms();
    if ('error' in arms) {
      lines.push(`Engine arms: not available (${arms.error})`);
    } else {
      lines.push('Engine arms:');
      for (const a of arms.arms) lines.push(armLine(a));
      if (arms.arms.length === 0 && pv !== undefined && pv.enabled) lines.push('(the Engine reports no arms yet: the PILOT can buy grade A only, /autobuy on with no arm)');
      if (s.mode === 'live' && !isPilotReport(s.report_id)) {
        const v = arms.arms.find(a => a.arm === s.live_arm);
        if (v !== undefined && v.verdict === 'PASS' && v.report_id !== s.report_id) lines.push(`report changed: confirmed ${s.report_id ?? 'none'}, now ${v.report_id ?? 'none'} (the confirmation stays valid)`);
      }
    }
    return lines.join('\n');
  }

  function parseArm(raw: string | undefined): ArmId | null {
    const up = (raw ?? '').toUpperCase();
    return isArmId(up) ? up : null;
  }

  function dryrun(raw: string | undefined): string {
    const arm = parseArm(raw);
    if (arm === null) return `Refused: pick an arm (${ARM_IDS.join(', ')}). ${USAGE}`;
    const r = state.setDryRun(arm);
    if (!r.ok) return `Refused: ${r.reason}`;
    pending = null;
    return `Dry run armed on ${arm}: matching signals run the whole buy path up to signing, a virtual position is opened and NOTHING is sent, whatever BOT_DRY_RUN says.`
      + (r.warning ? `\nWarning: ${r.warning}` : '');
  }

  /** A-114: the PILOT request text (the owner then types CONFIRM PILOT <ARM | GRADE-A>). */
  function pilotRequest(pv: PilotView, arm: ArmId, kind: 'arm' | 'grade-A', why: string): string {
    pending = { arm, requestedAt: clock.now(), pilot: kind };
    const sel = pilotSelectionText(kind === 'grade-A' ? { kind: 'grade-A' } : { kind: 'arm', arm });
    return [
      `PILOT: ${why}. The pilot relaxes ONLY the go-live PASS; every other auto-buy guard stays on.`,
      `Selection: ${sel}.`,
      `Size: min(buy amount, ${solText(pv.maxSol)} SOL) per buy; at most ${pv.maxPerDay} pilot buys per UTC day (used ${pv.usedToday} today).`,
      deps.dryRunEnv() ? 'Note: BOT_DRY_RUN is on, so even a live mode will send nothing until it is turned off.' : 'This enables REAL-MONEY buying that is NOT go-live tested.',
      `To confirm, send exactly:  CONFIRM PILOT ${kind === 'grade-A' ? 'GRADE-A' : arm}`,
      `(valid for ${Math.round(CONFIRM_WINDOW_MS / 60_000)} minutes; /autobuy off cancels)`,
    ].join('\n');
  }

  async function on(raw: string | undefined): Promise<string> {
    const arm = parseArm(raw);
    const pv = pilotOn();
    if (pv !== null && (arm !== null || (raw ?? '') === '')) {
      // A-114: the PILOT route (a PASS arm still takes the normal route below, with its report id)
      const arms = await freshArms();
      if ('error' in arms) return `Refused: the Engine's arms status is not available (${arms.error}), so the PILOT cannot check the arms.`;
      if (arm === null) {
        if (arms.arms.length > 0) return `Refused: pick an arm (${ARM_IDS.join(', ')}). The Engine reports arms, so the PILOT buys a named arm's selection. ${USAGE}`;
        return pilotRequest(pv, PILOT_GRADE_A_ARM, 'grade-A', 'the Engine reports no arms at all, so no arm has a go-live PASS');
      }
      const a = arms.arms.find(x => x.arm === arm);
      if (a !== undefined && PILOT_REFUSED_VERDICTS.has(a.verdict)) return `Refused: PILOT: arm ${arm} is ${a.verdict}; the pilot never buys an arm the Engine rated ${a.verdict}.\n${armLine(a)}`;
      if (a === undefined || a.verdict !== 'PASS' || a.report_id === null) {
        return pilotRequest(pv, arm, 'arm', `arm ${arm} has no go-live PASS (${a === undefined ? "not in the Engine's arms list" : a.verdict})`);
      }
    }
    if (arm === null) return `Refused: pick an arm (${ARM_IDS.join(', ')}). ${USAGE}${pv !== null ? `\n${PILOT_USAGE}` : ''}`;
    const arms = await freshArms();
    if ('error' in arms) return `Refused: the Engine's arms status is not available (${arms.error}), so the verdict of ${arm} cannot be checked.`;
    const a = arms.arms.find(x => x.arm === arm);
    if (a === undefined) return `Refused: the Engine reported no status for arm ${arm}.`;
    if (a.verdict !== 'PASS') return `Refused: arm ${arm} is ${a.verdict}, not PASS. Live buying needs a standing PASS.\n${armLine(a)}`;
    if (a.report_id === null) return `Refused: arm ${arm} is PASS but carries no report id to confirm.`;
    pending = { arm, requestedAt: clock.now() };
    return [
      `Arm ${arm} passed the go-live test.`, armLine(a),
      deps.dryRunEnv() ? 'Note: BOT_DRY_RUN is on, so even a live mode will send nothing until it is turned off.' : 'This enables REAL-MONEY buying.',
      `To confirm, send exactly:  CONFIRM ${arm} ${a.report_id}`,
      `(valid for ${Math.round(CONFIRM_WINDOW_MS / 60_000)} minutes; /autobuy off cancels)`,
    ].join('\n');
  }

  /** A-114: CONFIRM PILOT <ARM | GRADE-A>. Same window, same "nothing changes on a refusal", the state is written before it takes effect. */
  async function pilotConfirm(pv: PilotView, typed: string): Promise<string> {
    if (pending === null) return 'Refused: no /autobuy on request is waiting. Send /autobuy on <ARM> first.';
    if (clock.now() - pending.requestedAt > CONFIRM_WINDOW_MS) {
      pending = null;
      return 'Refused: the confirmation window has expired. Send /autobuy on <ARM> again.';
    }
    if (pending.pilot === undefined) return `Refused: the waiting request is for arm ${pending.arm} with its PASS report; confirm it with CONFIRM ${pending.arm} <report_id>.`;
    const kind = pending.pilot;
    const want = kind === 'grade-A' ? 'GRADE-A' : pending.arm;
    if (typed !== want) return `Refused: the waiting PILOT request is for ${want}, not ${typed}.`;
    const arm = pending.arm;
    const arms = await freshArms();
    if ('error' in arms) return `Refused: the Engine's arms status is not available (${arms.error}); nothing was changed.`;
    if (kind === 'grade-A' && arms.arms.length > 0) {
      pending = null;
      return 'Refused: PILOT: the Engine now reports arms; send /autobuy on <ARM> to pick one. Nothing was changed.';
    }
    const a = arms.arms.find(x => x.arm === arm);
    if (kind === 'arm' && a !== undefined && PILOT_REFUSED_VERDICTS.has(a.verdict)) {
      pending = null;
      return `Refused: PILOT: arm ${arm} is now ${a.verdict}; nothing was changed.`;
    }
    const reportId = kind === 'grade-A' ? PILOT_GRADE_A_REPORT : pilotArmReport(arm);
    const r = state.goLive({ arm, reportId, confirmedAt: clock.now(), policyVersion: deps.policyVersion() });
    if (!r.ok) return `Refused: ${r.reason}`;
    pending = null;
    const br = breaker.check(clock.now());
    return `Auto-buy is LIVE in PILOT mode (not go-live tested) on arm ${arm}, confirmed ${iso(clock.now())}.`
      + `\nSelection: ${pilotSelectionText(pilotSelectionOf(reportId, arm))}.`
      + `\nMax ${solText(pv.maxSol)} SOL per buy, ${pv.maxPerDay} per UTC day (used ${pv.usedToday} today). Every other auto-buy guard stays on; /autobuy off stops it.`
      + (deps.dryRunEnv() ? '\nBOT_DRY_RUN is on: no transaction will be sent until it is turned off.' : '')
      + (br.tripped ? `\nNote: paused_breaker is still active (${br.detail}); /autobuy resume clears it.` : '')
      + (r.warning ? `\nWarning: ${r.warning}` : '');
  }

  async function confirm(t: string): Promise<string> {
    const pm = PILOT_CONFIRM_RE.exec(t);
    const pv = pilotOn();
    if (pm !== null && pv !== null) return pilotConfirm(pv, pm[1]);
    const m = CONFIRM_RE.exec(t);
    if (m === null) return 'Refused: the confirmation must be exactly:  CONFIRM <ARM> <report_id>';
    if (pending === null) return 'Refused: no /autobuy on request is waiting. Send /autobuy on <ARM> first.';
    if (clock.now() - pending.requestedAt > CONFIRM_WINDOW_MS) {
      pending = null;
      return 'Refused: the confirmation window has expired. Send /autobuy on <ARM> again.';
    }
    const arm = m[1] as ArmId;
    const typedReport = m[2];
    if (arm !== pending.arm) return `Refused: the waiting request is for arm ${pending.arm}, not ${arm}.`;
    const arms = await freshArms();
    if ('error' in arms) return `Refused: the Engine's arms status is not available (${arms.error}); nothing was changed.`;
    const a = arms.arms.find(x => x.arm === arm);
    if (a === undefined || a.verdict !== 'PASS' || a.report_id === null) {
      pending = null;
      return `Refused: arm ${arm} is no longer PASS (${a === undefined ? 'missing' : a.verdict}); nothing was changed.`;
    }
    if (typedReport !== a.report_id) return `Refused: the report id does not match arm ${arm}'s current PASS report (${a.report_id}); nothing was changed.`;
    const r = state.goLive({ arm, reportId: a.report_id, confirmedAt: clock.now(), policyVersion: deps.policyVersion() });
    if (!r.ok) return `Refused: ${r.reason}`;
    pending = null;
    const br = breaker.check(clock.now());
    return `Auto-buy is LIVE on arm ${arm} (report ${a.report_id}, confirmed ${iso(clock.now())}).`
      + (deps.dryRunEnv() ? '\nBOT_DRY_RUN is on: no transaction will be sent until it is turned off.' : '')
      + (br.tripped ? `\nNote: paused_breaker is still active (${br.detail}); /autobuy resume clears it.` : '')
      + (r.warning ? `\nWarning: ${r.warning}` : '');
  }

  function off(): string {
    const r = state.setOff();
    pending = null;
    return `Auto-buy is OFF.${r.ok && r.warning ? `\nWarning: ${r.warning}` : ''}`;
  }

  function resume(): string {
    const before = state.get();
    const br = breaker.check(clock.now());
    const r = state.resume();
    if (!r.ok) return `Refused: ${r.reason}`;
    breaker.clear(clock.now());
    const cleared = [before.pause, br.tripped ? 'paused_breaker' : null].filter((x): x is string => x !== null);
    return (cleared.length > 0 ? `Cleared: ${cleared.join(', ')}; failed-buy count reset.` : 'No pause was active; failed-buy count reset.')
      + `\n${modeLine()}`;
  }

  return {
    pendingConfirm: () => (pending === null ? null : { ...pending }),
    async handle(text, from): Promise<string | null> {
      const t = text.trim();
      const isConfirm = /^CONFIRM(?:\s|$)/.test(t);
      const cm = COMMAND_RE.exec(t);
      if (!isConfirm && cm === null) return null;
      if (!from.isOwner) return 'Refused: auto-buy commands are for the owner only.';
      try {
        if (isConfirm) return await confirm(t);
        const args = (cm?.[1] ?? '').trim().split(/\s+/).filter(x => x !== '');
        const sub = (args[0] ?? 'status').toLowerCase();
        switch (sub) {
          case 'status': return await status();
          case 'dryrun': return dryrun(args[1]);
          case 'on': return await on(args[1]);
          case 'off': return off();
          case 'resume': return resume();
          default: return `Unknown command "${sub.slice(0, 20)}". ${USAGE}`;
        }
      } catch (e) {
        log(`autobuy: command failed (${errText(e)})`, 'err');
        return 'Refused: the command failed; nothing was changed.';
      }
    },
  };
}
