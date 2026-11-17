// R2-B2 (B20 section 4; plan grind #58 + #59): the persisted auto-buy state, B\data\autobuy-state.json (schema 2).
//
//   { schema: 2, mode: 'off'|'dry_run'|'live', dry_run_arm, live_arm, report_id, confirmed_at, policy_version,
//     pause: 'paused_fails'|'paused_rolling'|null, pause_reason, paused_at, consecutive_fails,
//     rolling: [{ tx, net_per_sol_in, closed_at }] }
//
// Written atomically (tmp + fsync + rename) on EVERY change of these fields, BEFORE the decision that depends on the change takes
// effect: a transition that makes the bot more permissive (dry run, live, resume) is applied in memory only after the file is on disk and
// is refused when the write fails; a transition that makes it more restrictive (off, a pause, a counted failure) is applied in memory even
// when the write fails (the failure is reported), so a full disk can never keep a pause from taking effect.
// A missing, corrupt, schema-invalid or schema-1 file means mode 'off' (disabled) with the defaults. A corrupt file is renamed aside, never
// deleted. `paused_breaker` is never persisted (guards.CircuitBreaker). `rolling` keeps the last N verified closed REAL trades, one entry per tx.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomicSync } from '../link/atomic-file';
import { defaultLog, type LinkLog } from '../link/common';
import type { ArmId } from '../shared/common/ids';
import type { AutoBuyMode } from './decide';
import {
  AUTOBUY_PAUSE_AFTER_FAILS_DEFAULT, AUTOBUY_ROLLING_MIN_NET_DEFAULT, AUTOBUY_ROLLING_N_DEFAULT, errText, rollingBreached, rollingMeanNet,
  type RollingEntry,
} from './guards';

export const STATE_FILE = 'autobuy-state.json';
export const STATE_SCHEMA = 2 as const;
export const ARM_IDS: readonly ArmId[] = ['BS', 'B0', 'B1', 'B2'];
export type PersistedPause = 'paused_fails' | 'paused_rolling';

export interface AutoBuyPersisted {
  schema: 2;
  mode: AutoBuyMode;
  dry_run_arm: ArmId | null;
  live_arm: ArmId | null;
  report_id: string | null;
  confirmed_at: number | null;
  policy_version: string | null;
  pause: PersistedPause | null;
  pause_reason: string | null;
  paused_at: number | null;
  consecutive_fails: number;
  rolling: RollingEntry[];
}

export type StateResult = { ok: true; warning?: string } | { ok: false; reason: string };

export interface StateOptions {
  rollingN?: number;
  rollingMinNet?: number;
  pauseAfterFails?: number;
  log?: LinkLog;
}

export function isArmId(x: unknown): x is ArmId {
  return typeof x === 'string' && (ARM_IDS as readonly string[]).includes(x);
}

function fresh(): AutoBuyPersisted {
  return {
    schema: 2, mode: 'off', dry_run_arm: null, live_arm: null, report_id: null, confirmed_at: null, policy_version: null,
    pause: null, pause_reason: null, paused_at: null, consecutive_fails: 0, rolling: [],
  };
}

const isRec = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** The persisted document as a state, or the reason it is not valid. Pure. */
export function parseState(doc: unknown, rollingN: number): { state: AutoBuyPersisted; note: string | null } | { error: string } {
  if (!isRec(doc)) return { error: 'not an object' };
  if (doc.schema !== STATE_SCHEMA) return { error: `schema ${String(doc.schema)} is not ${STATE_SCHEMA}` };
  if (doc.mode !== 'off' && doc.mode !== 'dry_run' && doc.mode !== 'live') return { error: 'mode is not off, dry_run or live' };
  const armOrNull = (k: string): ArmId | null | undefined => (doc[k] === null ? null : isArmId(doc[k]) ? (doc[k] as ArmId) : undefined);
  const dryArm = armOrNull('dry_run_arm');
  const liveArm = armOrNull('live_arm');
  if (dryArm === undefined) return { error: 'dry_run_arm is not an arm id or null' };
  if (liveArm === undefined) return { error: 'live_arm is not an arm id or null' };
  const strOrNull = (k: string, max: number): string | null | undefined =>
    doc[k] === null ? null : typeof doc[k] === 'string' && (doc[k] as string).length <= max ? (doc[k] as string) : undefined;
  const numOrNull = (k: string): number | null | undefined => (doc[k] === null ? null : finite(doc[k]) ? (doc[k] as number) : undefined);
  const reportId = strOrNull('report_id', 128);
  const policyVersion = strOrNull('policy_version', 64);
  const pauseReason = strOrNull('pause_reason', 400);
  const confirmedAt = numOrNull('confirmed_at');
  const pausedAt = numOrNull('paused_at');
  if (reportId === undefined) return { error: 'report_id is not a string or null' };
  if (policyVersion === undefined) return { error: 'policy_version is not a string or null' };
  if (pauseReason === undefined) return { error: 'pause_reason is not a string or null' };
  if (confirmedAt === undefined) return { error: 'confirmed_at is not a number or null' };
  if (pausedAt === undefined) return { error: 'paused_at is not a number or null' };
  const pause = doc.pause;
  if (pause !== null && pause !== 'paused_fails' && pause !== 'paused_rolling') return { error: 'pause is not paused_fails, paused_rolling or null' };
  const fails = doc.consecutive_fails;
  if (typeof fails !== 'number' || !Number.isInteger(fails) || fails < 0) return { error: 'consecutive_fails is not a non-negative integer' };
  if (!Array.isArray(doc.rolling)) return { error: 'rolling is not an array' };
  const seen = new Set<string>();
  const rolling: RollingEntry[] = [];
  for (const r of doc.rolling) {
    if (!isRec(r) || typeof r.tx !== 'string' || r.tx === '' || !finite(r.net_per_sol_in) || !finite(r.closed_at)) return { error: 'a rolling entry is malformed' };
    if (seen.has(r.tx)) continue;
    seen.add(r.tx);
    rolling.push({ tx: r.tx, net_per_sol_in: r.net_per_sol_in, closed_at: r.closed_at });
  }
  let state: AutoBuyPersisted = {
    schema: 2, mode: doc.mode, dry_run_arm: dryArm, live_arm: liveArm, report_id: reportId, confirmed_at: confirmedAt, policy_version: policyVersion,
    pause, pause_reason: pauseReason, paused_at: pausedAt, consecutive_fails: fails, rolling: rolling.slice(-rollingN),
  };
  // a hand-edited mode that lacks what it needs is off: live needs arm + report id + confirmation time, dry_run needs its arm
  let note: string | null = null;
  if (state.mode === 'live' && (state.live_arm === null || state.report_id === null || state.confirmed_at === null)) {
    state = { ...state, mode: 'off' };
    note = 'mode live without live_arm, report_id and confirmed_at: treated as off';
  } else if (state.mode === 'dry_run' && state.dry_run_arm === null) {
    state = { ...state, mode: 'off' };
    note = 'mode dry_run without dry_run_arm: treated as off';
  }
  return { state, note };
}

export class AutoBuyStateStore {
  readonly file: string;
  /** Why the store started disabled (corrupt / schema-invalid file) or normalised the file, else null. */
  readonly loadNote: string | null;
  /** The last persistence failure, or null. */
  writeError: string | null = null;
  private cur: AutoBuyPersisted;
  private readonly rollingN: number;
  private readonly rollingMinNet: number;
  private readonly pauseAfterFails: number;
  private readonly log: LinkLog;

  constructor(dir: string, opts: StateOptions = {}) {
    this.file = path.join(dir, STATE_FILE);
    this.rollingN = opts.rollingN ?? AUTOBUY_ROLLING_N_DEFAULT;
    this.rollingMinNet = opts.rollingMinNet ?? AUTOBUY_ROLLING_MIN_NET_DEFAULT;
    this.pauseAfterFails = opts.pauseAfterFails ?? AUTOBUY_PAUSE_AFTER_FAILS_DEFAULT;
    this.log = opts.log ?? defaultLog;
    this.cur = fresh();
    let note: string | null = null;
    if (fs.existsSync(this.file)) {
      let parsed: ReturnType<typeof parseState>;
      try {
        parsed = parseState(JSON.parse(fs.readFileSync(this.file, 'utf8')), this.rollingN);
      } catch (e) {
        parsed = { error: `unreadable: ${errText(e)}` };
      }
      if ('error' in parsed) {
        note = `${STATE_FILE} is not usable (${parsed.error}): auto-buy starts disabled`;
        this.moveAside();
      } else {
        this.cur = parsed.state;
        note = parsed.note;
      }
    }
    this.loadNote = note;
  }

  /** A copy of the persisted state. */
  get(): AutoBuyPersisted {
    return { ...this.cur, rolling: this.cur.rolling.map(r => ({ ...r })) };
  }

  /** Mean net per SOL in of the rolling window (null while empty). */
  rollingMean(): number | null { return rollingMeanNet(this.cur.rolling); }

  // -- owner commands (permissive: refused when the file cannot be written) -----------------------------------------------------

  /** /autobuy dryrun <ARM>: only mode and dry_run_arm; never touches live_arm, report_id or confirmed_at. Refused while live. */
  setDryRun(arm: ArmId): StateResult {
    if (this.cur.mode === 'live') return { ok: false, reason: 'auto-buy is live; turn it off first (/autobuy off)' };
    return this.commit({ ...this.cur, mode: 'dry_run', dry_run_arm: arm }, false);
  }

  /**
   * The typed CONFIRM: mode live with the arm, the report id and the confirmation time; clears a persisted pause and the failure count.
   * Clearing `paused_rolling` also restarts the rolling window (spec silent, chosen): the owner has acknowledged the pause, and the same
   * 50 trades would otherwise re-trigger it on the very next closed trade, so the pause could never be lifted.
   */
  goLive(p: { arm: ArmId; reportId: string; confirmedAt: number; policyVersion: string | null }): StateResult {
    return this.commit({
      ...this.cur, mode: 'live', live_arm: p.arm, report_id: p.reportId, confirmed_at: p.confirmedAt, policy_version: p.policyVersion,
      pause: null, pause_reason: null, paused_at: null, consecutive_fails: 0,
      rolling: this.cur.pause === 'paused_rolling' ? [] : this.cur.rolling,
    }, false);
  }

  /** /autobuy resume: clears a persisted pause and resets consecutive_fails (and the rolling window after paused_rolling, see goLive). The mode does not change. */
  resume(): StateResult {
    return this.commit({
      ...this.cur, pause: null, pause_reason: null, paused_at: null, consecutive_fails: 0,
      rolling: this.cur.pause === 'paused_rolling' ? [] : this.cur.rolling,
    }, false);
  }

  // -- restrictive transitions (applied in memory even when the write fails) ----------------------------------------------------

  /** /autobuy off, an arm verdict that left PASS: mode off at once. The arm, report id and confirmation time stay as the audit record. */
  setOff(): StateResult {
    if (this.cur.mode === 'off') return { ok: true };
    return this.commit({ ...this.cur, mode: 'off' }, true);
  }

  /** One failed buy. Returns whether this failure set the pause. */
  noteFail(now: number, why: string): { fails: number; pausedNow: boolean } {
    const fails = this.cur.consecutive_fails + 1;
    let next: AutoBuyPersisted = { ...this.cur, consecutive_fails: fails };
    let pausedNow = false;
    if (fails >= this.pauseAfterFails && next.pause === null) {
      next = { ...next, pause: 'paused_fails', pause_reason: `${fails} consecutive failed buys (last: ${why})`.slice(0, 400), paused_at: now };
      pausedNow = true;
    }
    this.commit(next, true);
    return { fails, pausedNow };
  }

  /** A buy that confirmed (or a dry-run build that worked): the consecutive-failure count restarts. */
  noteSuccess(): void {
    if (this.cur.consecutive_fails === 0) return;
    this.commit({ ...this.cur, consecutive_fails: 0 }, true);
  }

  /** One verified closed REAL trade (deduplicated by tx). Returns whether it set paused_rolling. */
  addClosedTrade(e: RollingEntry, now: number): { added: boolean; pausedNow: boolean } {
    if (this.cur.rolling.some(r => r.tx === e.tx)) return { added: false, pausedNow: false };
    const rolling = [...this.cur.rolling, { ...e }].slice(-this.rollingN);
    let next: AutoBuyPersisted = { ...this.cur, rolling };
    let pausedNow = false;
    if (next.pause === null && rollingBreached(rolling, this.rollingN, this.rollingMinNet)) {
      const mean = rollingMeanNet(rolling) ?? 0;
      next = { ...next, pause: 'paused_rolling', pause_reason: `rolling ${rolling.length} closed trades: net ${(mean * 100).toFixed(1)}% per SOL in`, paused_at: now };
      pausedNow = true;
    }
    this.commit(next, true);
    return { added: true, pausedNow };
  }

  // -- internals ---------------------------------------------------------------------------------------------------------------

  private commit(next: AutoBuyPersisted, restrictive: boolean): StateResult {
    try {
      writeFileAtomicSync(this.file, JSON.stringify(next, null, 2));
      this.writeError = null;
      this.cur = next;
      return { ok: true };
    } catch (e) {
      const msg = errText(e);
      this.writeError = msg;
      if (restrictive) {
        this.cur = next;
        this.log(`autobuy-state: could not persist (${msg}); the change is applied in memory only`, 'err');
        return { ok: true, warning: `not persisted: ${msg}` };
      }
      return { ok: false, reason: `could not write ${STATE_FILE}: ${msg}` };
    }
  }

  private moveAside(): void {
    for (let i = 1; i < 1000; i++) {
      const aside = `${this.file}.invalid-${i}`;
      if (fs.existsSync(aside)) continue;
      try { fs.renameSync(this.file, aside); } catch { /* the next write replaces the file */ }
      return;
    }
  }
}
