// R2-B2 (B20 sections 2-4): AutoBuyApi, the auto-buy service the intake calls (decide, execute, onArmsStatus) plus the pieces the wiring
// (R4-B6) calls around it: boot recovery, the arms refresh, the closed-position and sell-ok feeds, the heartbeat fields and the /autobuy
// commands.
//
// What this module never does: it never calls router.ts itself. It takes `smartBuy` (with the A-26 options), the FillReader, the RPC
// status/balance calls and the positions store as injected deps, so every send is countable on a stub. The transaction verification of a
// PumpPortal-built transaction (B40 rule 4) happens inside smartBuy, before signing. No Date.now(): time comes from the bot Clock.
//
// Execute, live (decision `buy`, mode live, env BOT_DRY_RUN off):
//   reserve the caps -> smartBuy({ singleSend, maxImpactPct, slippageBps, awaitFill:false, onSigned }) where onSigned appends the PendingBuy
//   to the journal (tmp + fsync + rename) and writes the buy ledger BEFORE the send (a throw there aborts the send) -> resolve 'submitted'
//   right after the send -> the confirm loop runs asynchronously: checkPending -> FillReader.buyFill -> PositionsStore.openFromBuy ->
//   position.opened -> journal entry removed -> delivery.buy confirmed. A failed confirm cancels the reservation, counts toward
//   paused_fails and reports delivery.buy failed. A BuyFill with tokensRaw '0' is a failed buy (A-29).
// Execute, dry run (mode dry_run, forceDryRun, env BOT_DRY_RUN on, or a state that is not a complete live one): smartBuy({ buildOnly })
//   builds and signs, never sends and never calls onSigned; a virtual position is opened and position.opened (dry_run) reported. A dry run
//   never touches the journal, the ledger, the caps or the failure count.
import * as path from 'node:path';
import type { Keypair } from '@solana/web3.js';
import type {
  AutoBuyApi, AutoBuyDecision, BotOutbox, BuyExecution, BuyFill, EngineClient, FillReader, PendingBuy, PositionsStore, PositionV2,
} from '../bot-contracts';
import { AUTO_BUY_CAPS_FILENAME, AutoBuyCaps, BuyLock, parseSolAmount, resolveAutoBuyLimits, type AutoBuyLimits } from '../bot/trade-guards';
import { ImpactCapError, RouterSendError, type RouterOpts, type RouterResult, type SignedTx } from '../execution/router';
import type { Clock, TimerHandle } from '../link/clock';
import { buildEnvelope, defaultLog, type LinkLog } from '../link/common';
import type { ArmId } from '../shared/common/ids';
import type {
  ArmsStatusPayload, ArmStatus, BotToEngineType, DeliveryBuy, Envelope, Heartbeat, PositionOpened, SignalNew,
} from '../shared/contract/v1';
import { createAutoBuyCommands, type AutoBuyCommands } from './commands';
import { decideAutoBuy, liveStateComplete, type AutoBuyState } from './decide';
import {
  autoBuyConfigFromEnv, BuyLedger, CircuitBreaker, errText, netPerSolIn, type AutoBuyConfig,
} from './guards';
import {
  checkPending, openPendingJournal, toPendingBuy, type PendingJournal, type PendingRecord, type PendingVerdict, type RecoveryRpc,
} from './pending';
import { AutoBuyStateStore } from './state';
import {
  isPilotReport, pilotBlock, pilotConfigFromEnv, pilotSelectionOf, pilotSelectionText, PILOT_REFUSED_VERDICTS, solText, type PilotConfig,
} from './pilot';
import type { ExitPlanSnapshot } from '../exits/presets';
import type { PendingBuyWithPlan } from '../exits/positions-store';

/** smartBuy as router.ts exports it (A-26 options included). The wiring passes the real function, tests pass a stub that counts sends. */
export type SmartBuyFn = (keypair: Keypair, mint: string, solIn: number, opts?: RouterOpts) => Promise<RouterResult>;

export interface WalletRef { walletId: string; owner: string; keypair: Keypair }
export interface AutoBuyWallet {
  /** The wallet auto-buy trades with, or null when none is set up. */
  current(): WalletRef | null;
  /** Buying power in SOL (native + wSOL) from the wiring's cache, or null when unknown. Never an RPC call: decide() is synchronous. */
  balanceSol(): number | null;
}

/** A dry-run buy: what the virtual position is opened from. No signature: the transaction was built and signed, never sent. */
export interface VirtualBuy {
  signal_id: string; ca: string; wallet_id: string; owner: string; arm: ArmId; route: BuyExecution['route'];
  sol_in_lamports: string; quote_tokens_out: string | null; opened_at: number;
}

/**
 * The positions store as auto-buy sees it. `openFromBuy` is the frozen PositionsStore method (the only way to create a real signal
 * position). The other three are declared here because the frozen interface has no entry point for a virtual (dry-run) position and no
 * query for the duplicate / max-open checks: the wiring (R4-B6) provides them on top of exits/positions-store.ts.
 */
export interface AutoBuyPositions extends PositionsStore {
  openVirtual(v: VirtualBuy): PositionV2;
  /** An open position (virtual ones included) for this CA on this wallet (walletId null = any wallet). */
  hasOpen(ca: string, walletId: string | null): boolean;
  /** Open signal positions: the virtual ones when dryRun is true, the real ones otherwise. */
  openCount(dryRun: boolean): number;
}

export interface AutoBuySettings {
  /** settings.signal.buyAmount, SOL per trade. */
  buySol: number;
  /** settings.signal.slippageBps: the slippage cap of an auto-buy. */
  slippageBps: number;
  priorityFee?: number;
  antiMev?: boolean;
}

export interface AutoBuyDeps {
  /** B\data */
  dir: string;
  clock: Clock;
  /** A snapshot of the process env (AUTOBUY_*, AUTO_BUY_*); this module never reads process.env. */
  env: Record<string, string | undefined>;
  /** BOT_DRY_RUN right now (guards.dryRunFromEnv(env)); read again at execute time. */
  dryRun: () => boolean;
  smartBuy: SmartBuyFn;
  fills: FillReader;
  rpc: RecoveryRpc;
  positions: AutoBuyPositions;
  outbox: BotOutbox;
  engine: Pick<EngineClient, 'arms'>;
  wallet: AutoBuyWallet;
  settings: () => AutoBuySettings;
  /** policy id -> version of the local exit-policies.json (for example { EA: '...' }). */
  policyVersions: () => Record<string, string>;
  /** The signal_id of the first signal.new seen for this CA (the inbox registry), or null. */
  signalledBy: (ca: string) => string | null;
  /** The owner's session window (off by default: always true). */
  sessionWindowOk?: (now: number) => boolean;
  /** A fresh ULID per call (createUlidFactory). */
  newEventId: () => string;
  /** The owner's private chat through the send queue (kind ops). */
  notifyOwner?: (text: string) => void;
  /** Default: new AutoBuyCaps(<dir>/autobuy-caps.json, ...) with the limits resolved from the env. */
  caps?: AutoBuyCaps;
  log?: LinkLog;
  /** Poll interval of the live confirm loop in ms (default CONFIRM_POLL_MS). */
  confirmPollMs?: number;
  /** Re-check interval of boot recovery in ms (default RECOVER_POLL_MS). */
  recoverPollMs?: number;
  /** A-93f: the boot-recovery deadline in ms (default RECOVER_BOOT_DEADLINE_MS). */
  recoverDeadlineMs?: number;
  /** A-115: the exit plan of a LIVE buy of this signal (the owner's grade preset), resolved when the buy is decided and journalled with it;
   *  null = the active policy exactly as before. Never asked for a dry run (presets never touch virtual positions). */
  exitPlan?: (sig: SignalNew) => ExitPlanSnapshot | null;
}

/** What the exit engine tells auto-buy when a position closes (rolling window, B20 section 3). */
export interface ClosedPositionInfo {
  origin: 'signal' | 'manual'; dryRun: boolean; entryTx: string | null; fillSource: 'tx_meta' | 'quote_dry_run' | 'unverified';
  realizedNetLamports: string | null; solSpentLamports: string | null; closedAt: number;
}

export interface RecoveryReport { resolved: number; waiting: number }

export interface AutoBuyService extends AutoBuyApi {
  /** Logs the boot line (mode, arm, confirmed_at) and the env problems; no timers. */
  start(): void;
  /** Clears every timer. A buy still in the journal is picked up by recover() on the next boot. */
  stop(): void;
  /** GET the Engine's arms and apply them like an arms.status push. False when the Engine could not be read. */
  refreshArms(): Promise<boolean>;
  /** A-93f: the arm verdicts were read (a GET or an arms.status push) since the start. */
  armsKnown(): boolean;
  /** Boot recovery of the in-flight buy journal. Run BEFORE the exit engine starts and before the events server accepts intake. */
  recover(): Promise<RecoveryReport>;
  commands: AutoBuyCommands;
  /** The exit engine reports every closed position here (only verified real signal trades enter the rolling window). */
  onPositionClosed(p: ClosedPositionInfo): void;
  /** A-93f: a live buy of this CA is in the pending-buys journal (sent, no position yet). */
  hasPendingBuy(ca: string): boolean;
  /** The exit engine reports a successful sell (resets the 10-buys-no-sell breaker count). */
  noteSellOk(): void;
  /** The heartbeat fields B20 owns (C02 Heartbeat.autobuy and caps_used). */
  heartbeat(): { autobuy: Heartbeat['autobuy']; caps_used: Heartbeat['caps_used'] };
  /** The one-line boot summary: mode, arm, confirmed_at, pause. */
  bootLine(): string;
  /** A-114: AUTOBUY_PILOT is on and the mode is live (every live buy is then a PILOT buy). */
  pilotLive(): boolean;
  /** A-114 + A-115: the pilot limits while the pilot is live (the card's auto-buy line shows the real, clamped size), else null. */
  pilotCard?(): { maxSol: number; maxPerDay: number } | null;
}

export const CONFIRM_POLL_MS = 2_000;
export const RECOVER_POLL_MS = 5_000;
/** After this long the live confirm loop slows down to RECOVER_POLL_MS. */
export const CONFIRM_FAST_WINDOW_MS = 120_000;
/** How many times a resolved buy retries openFromBuy (5 s apart) before the watcher slows down to OPEN_SLOW_RETRY_MS. */
export const OPEN_RETRIES_MAX = 6;
/** A-93f: after the fast retries a landed buy whose position cannot be opened yet is retried at this pace, for as long as it takes (the
 *  watcher is never dropped: real tokens without a position have no exits); the owner is alerted again every OPEN_REALERT_MS. */
export const OPEN_SLOW_RETRY_MS = 30_000;
export const OPEN_REALERT_MS = 600_000;
/** A-93f: boot recovery waits at most this long (on the bot clock) for the first check of the journal entries; the rest is left to the
 *  background watchers, so a degraded RPC never holds the exit engine, the events server and the Telegram UI. */
export const RECOVER_BOOT_DEADLINE_MS = 10_000;
const DECIDE_STAMPS_MAX = 256;

const LAMPORTS_PER_SOL = 1_000_000_000;
const lamportsOf = (sol: number): string => BigInt(Math.round(sol * LAMPORTS_PER_SOL)).toString();
const shortCa = (ca: string): string => `${ca.slice(0, 4)}..${ca.slice(-4)}`;

interface Watch {
  rec: PendingRecord;
  /** The caps reservation of this buy while it lives in this process; null after a restart. */
  token: number | null;
  kind: 'live' | 'recovery';
  streak: number;
  openTries: number;
  /** A-93f: when the owner was last told that this landed buy has no position yet (null = not yet). */
  alertedAt: number | null;
  startedAt: number;
  timer: TimerHandle | null;
}

export function createAutoBuy(deps: AutoBuyDeps): AutoBuyService {
  const { clock, outbox } = deps;
  const log = deps.log ?? defaultLog;
  const cfgResult = autoBuyConfigFromEnv(deps.env);
  const cfg: AutoBuyConfig = cfgResult.config;
  const state = new AutoBuyStateStore(deps.dir, {
    rollingN: cfg.rollingN, rollingMinNet: cfg.rollingMinNet, pauseAfterFails: cfg.pauseAfterFails, log,
  });
  const ledger = new BuyLedger(deps.dir);
  const journal: PendingJournal = openPendingJournal(deps.dir);
  const breaker = new CircuitBreaker(clock.now());
  const lock = new BuyLock();
  const verdicts: Partial<Record<ArmId, ArmStatus>> = {};
  /** A-93f: the verdicts live in memory only; until the first read after a start every live decision is 'off'. */
  let armsLoaded = false;
  let blindWarned = false;
  const watches = new Map<string, Watch>();
  const decideStamps = new Map<string, { receivedAt: number; decidedAt: number }>();
  const confirmPollMs = deps.confirmPollMs ?? CONFIRM_POLL_MS;
  const recoverPollMs = deps.recoverPollMs ?? RECOVER_POLL_MS;
  let stopped = false;

  // A-114: the PILOT (pilot.ts). Off unless AUTOBUY_PILOT is exactly 1/true/on/yes and both pilot limits are usable.
  const pilot: PilotConfig = pilotConfigFromEnv(deps.env);
  let pilotNoticeSent = false;
  let pilotCapNoticeDay: number | null = null;
  /** A state confirmed in PILOT mode by an earlier start is switched off by a start without the pilot (restrictive). */
  let pilotStartNote: string | null = null;
  {
    const st = state.get();
    if (!pilot.enabled && st.mode === 'live' && isPilotReport(st.report_id)) {
      state.setOff();
      pilotStartNote = `auto-buy was LIVE in PILOT mode (arm ${st.live_arm ?? '?'}, ${st.report_id ?? '?'}) but AUTOBUY_PILOT is off now: switched OFF. Without the pilot, live buying needs a standing PASS and a new /autobuy on + CONFIRM.`;
    }
  }
  const pilotLive = (p: { mode: string }): boolean => pilot.enabled && p.mode === 'live';

  // with the pilot on, every notice the owner sees about auto-buy says PILOT
  const notify = (text0: string): void => {
    const text = pilot.enabled ? `PILOT: ${text0}` : text0;
    try { deps.notifyOwner?.(text); } catch (e) { log(`autobuy: owner notice failed (${errText(e)})`, 'err'); }
    log(`autobuy: ${text}`, 'warn');
  };

  // ---------------------------------------------------------------------------------------------------------------------------------
  // limits and caps
  // ---------------------------------------------------------------------------------------------------------------------------------

  let limitsCache: { buy: number; limits: AutoBuyLimits } | null = null;
  const caps: AutoBuyCaps = deps.caps ?? (() => {
    const r = resolveAutoBuyLimits(deps.env, deps.settings().buySol);
    return new AutoBuyCaps(path.join(deps.dir, AUTO_BUY_CAPS_FILENAME), r.limits);
  })();

  /** The limits for the current buy size (the SOL-per-day default follows it). Problems and raises are logged once per buy size. */
  /** The per-trade size: the configured buy amount, or min(it, AUTOBUY_PILOT_MAX_SOL) while the pilot is live (the pilot never raises it). */
  function buySize(): number {
    const configured = deps.settings().buySol;
    return pilotLive(state.get()) ? Math.min(configured, pilot.maxSol) : configured;
  }

  function currentLimits(): AutoBuyLimits {
    const buy = buySize();
    if (limitsCache !== null && Object.is(limitsCache.buy, buy)) return limitsCache.limits;
    const r = resolveAutoBuyLimits(deps.env, buy);
    for (const k of r.invalid) log(`autobuy: ${k} is not usable; auto-buy is blocked until it is fixed`, 'warn');
    for (const d of r.deviations) log(`autobuy: deviation from the code defaults: ${d}`, 'warn');
    caps.setLimits({ perHour: r.limits.perHour, perDay: r.limits.perDay, solPerDay: r.limits.solPerDay });
    limitsCache = { buy, limits: r.limits };
    return r.limits;
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // events to the Engine (every one goes through the outbox)
  // ---------------------------------------------------------------------------------------------------------------------------------

  function send<T extends BotToEngineType>(type: T, payload: Parameters<typeof buildEnvelope<T>>[1], signalId: string | null, ca: string | null): void {
    try {
      outbox.append(buildEnvelope(type, payload, { eventId: deps.newEventId(), signalId, ca, now: clock.now() }));
    } catch (e) {
      log(`autobuy: could not record ${type} (${errText(e)})`, 'err');
    }
  }

  function emitBuy(rec: PendingRecord, status: 'confirmed' | 'failed', o: { error: string | null; confirmedAt: number | null }): void {
    const payload: DeliveryBuy = {
      status, reason: status === 'failed' ? 'route_failed' : null, arm: rec.arm, tx: rec.sig, error: o.error === null ? null : errText(o.error), at: clock.now(),
      stamps: {
        received_at: rec.received_at ?? rec.submitted_at, decided_at: rec.decided_at ?? null, signed_at: rec.signed_at ?? null,
        submitted_at: rec.submitted_at, confirmed_at: status === 'confirmed' ? o.confirmedAt : null,
      },
      route: rec.route, sol_in_lamports: rec.sol_in_lamports, quote_tokens_out: rec.quote_tokens_out,
    };
    send('delivery.buy', payload, rec.signal_id, rec.ca);
  }

  function emitPositionOpened(pos: PositionV2, signalId: string, ca: string): void {
    const basis = pos.basis_sol_per_token;
    const payload: PositionOpened = {
      position_id: pos.position_id, wallet_id: pos.wallet_id, origin: pos.origin, dry_run: pos.dry_run, arm: pos.arm,
      policy: pos.policy_id !== null && pos.policy_version !== null ? { id: pos.policy_id, version: pos.policy_version } : null,
      entry_tx: pos.entry.tx, opened_at: pos.entry.opened_at, sol_spent_lamports: pos.entry.sol_spent_lamports, tokens_raw: pos.entry.tokens_raw,
      fill_source: pos.entry.fill_source, basis_sol_per_token: basis !== null && Number.isFinite(basis) && basis > 0 ? basis : null,
    };
    send('position.opened', payload, pos.signal_id ?? signalId, ca);
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // arms
  // ---------------------------------------------------------------------------------------------------------------------------------

  function onArmsStatus(p: ArmsStatusPayload): void {
    for (const a of p.arms) verdicts[a.arm] = a;
    armsLoaded = true;
    blindWarned = false;
    const st = state.get();
    if (st.mode !== 'live') return;
    const arm = st.live_arm;
    const v = p.arms.find(a => a.arm === arm);
    // A-114: a state CONFIRMED IN PILOT MODE tolerates an arm without a PASS (missing from the list or INSUFFICIENT); a negative verdict
    // still switches it off. A normal PASS confirmation keeps the normal rule (losing its PASS switches it off) even while the pilot is on.
    if (pilot.enabled && isPilotReport(st.report_id)) {
      if (v === undefined || !PILOT_REFUSED_VERDICTS.has(v.verdict)) return;
    }
    if (v === undefined || v.verdict !== 'PASS') {
      state.setOff();
      notify(`Auto-buy switched OFF: live arm ${arm ?? '?'} is ${v === undefined ? 'missing from the arms status' : v.verdict}. A new /autobuy on + CONFIRM is required.`);
      return;
    }
    if (v.report_id !== st.report_id) {
      log(`autobuy: live arm ${arm} report changed (confirmed ${st.report_id ?? '?'}, now ${v.report_id ?? '?'}); the confirmed report stays as the audit record`, 'info');
    }
  }

  async function refreshArms(): Promise<boolean> {
    let r: Awaited<ReturnType<EngineClient['arms']>>;
    try { r = await deps.engine.arms(); } catch (e) { log(`autobuy: arms refresh failed (${errText(e)})`, 'warn'); return false; }
    if ('error' in r) { log(`autobuy: arms refresh failed (${r.error})`, 'warn'); return false; }
    onArmsStatus(r);
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // decide
  // ---------------------------------------------------------------------------------------------------------------------------------

  function decide(sig: SignalNew, env: Envelope<'signal.new', SignalNew>, receivedAt: number, now: number): AutoBuyDecision {
    const ca = env.ca;
    if (ca === null) return { action: 'skip', reason: 'contract_violation', arm: null, forceDryRun: false };
    const p = state.get();
    const w = deps.wallet.current();
    const limits = currentLimits();
    const usage = caps.usage(now);
    const prior = deps.signalledBy(ca);
    const dryRunEnv = deps.dryRun();
    const br = breaker.check(now);
    if (br.justTripped) notify(`Auto-buy PAUSED (paused_breaker): ${br.detail}. /autobuy resume clears it; a restart also clears it.`);
    const s: AutoBuyState = {
      mode: p.mode, dryRunArm: p.dry_run_arm, liveArm: p.live_arm, liveReportId: p.report_id, liveConfirmedAt: p.confirmed_at,
      dryRun: dryRunEnv, armVerdicts: verdicts,
      boughtCas: new Set(ledger.has(ca) ? [ca] : []),
      // the intake marks the CA as signalled BEFORE it calls decide, so only a different signal id is a second signal.new
      signalledCas: new Set(prior !== null && prior !== env.signal_id ? [ca] : []),
      pause: p.pause ?? (br.tripped ? 'paused_breaker' : null),
      caps: { hour: usage.lastHour, day: usage.lastDay, solDay: usage.solLastDay, openPositions: deps.positions.openCount(p.mode !== 'live' || dryRunEnv) },
      limits, localPolicyVersion: deps.policyVersions(),
      sessionWindowOk: deps.sessionWindowOk ? deps.sessionWindowOk(now) : true,
      walletPresent: w !== null, balanceSol: w !== null ? deps.wallet.balanceSol() : null,
      duplicatePosition: c => deps.positions.hasOpen(c, w !== null ? w.walletId : null),
      staleMs: cfg.staleMs,
    };
    const piloting = pilotLive(p);
    if (piloting) {
      s.pilot = { selection: pilotSelectionOf(p.report_id, p.live_arm), maxPerDay: pilot.maxPerDay, usedToday: caps.pilotUsedToday(now), armsKnown: armsLoaded };
    }
    const d = decideAutoBuy(sig, ca, receivedAt, now, s);
    if (piloting && s.pilot !== undefined && d.action === 'skip') {
      if (d.reason === 'arm_blocked') {
        const why = pilotBlock(sig, s.pilot.selection);
        if (why !== null) log(`autobuy: PILOT skip ${shortCa(ca)}: ${why}`, 'info');
      } else if (d.reason === 'cap_day' && s.pilot.usedToday >= s.pilot.maxPerDay) {
        const day = Math.floor(now / 86_400_000);
        if (pilotCapNoticeDay !== day) {
          pilotCapNoticeDay = day;
          notify(`the daily limit of ${pilot.maxPerDay} pilot buys is used (${s.pilot.usedToday} today, UTC). Signals are skipped (cap_day) until 00:00 UTC.`);
        }
      }
    }
    if (p.mode === 'live' && !armsLoaded && d.action === 'skip' && d.reason === 'off' && !blindWarned) {
      blindWarned = true;
      notify('Live auto-buy is skipping signals: the arm verdicts have not been read from the Engine since the restart (GET /arms failed). The bot asks again every 10 s; until then every signal is reported as delivery.buy off.');
    }
    decideStamps.set(env.event_id, { receivedAt, decidedAt: now });
    if (decideStamps.size > DECIDE_STAMPS_MAX) {
      const oldest = decideStamps.keys().next();
      if (!oldest.done) decideStamps.delete(oldest.value);
    }
    return d;
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // execute
  // ---------------------------------------------------------------------------------------------------------------------------------

  function countFail(why: string): void {
    const f = state.noteFail(clock.now(), why);
    if (f.pausedNow) notify(`Auto-buy PAUSED (paused_fails) after ${f.fails} consecutive failed buys (last: ${why}). /autobuy resume clears it.`);
  }

  async function execute(sig: SignalNew, env: Envelope<'signal.new', SignalNew>, d: AutoBuyDecision): Promise<BuyExecution> {
    const stamps0 = decideStamps.get(env.event_id);
    decideStamps.delete(env.event_id);
    const receivedAt = stamps0?.receivedAt ?? clock.now();
    const decidedAt = stamps0?.decidedAt ?? clock.now();
    const fail = (why: string, route: BuyExecution['route'] = null, signedAt: number | null = null): BuyExecution => ({
      status: 'failed', tx: null, error: errText(why), route, solInLamports: null, quoteTokensOut: null, stamps: { decidedAt, signedAt, submittedAt: null },
    });
    try {
      if (d.action !== 'buy' || d.arm === null) return fail('not a buy decision');
      const ca = env.ca;
      const signalId = env.signal_id;
      if (ca === null || signalId === null) return fail('signal without ca or signal_id');
      const p = state.get();
      if (p.mode === 'off') return fail('auto-buy is off');
      const wallet = deps.wallet.current();
      if (wallet === null) return fail('no wallet');
      const set = deps.settings();
      const configuredSol = parseSolAmount(set.buySol);
      if (configuredSol === null) return fail('buy amount is not a valid SOL amount');
      // A-114: a PILOT buy is min(the configured amount, AUTOBUY_PILOT_MAX_SOL)
      const piloting = pilotLive(p);
      const buySol = piloting ? Math.min(configuredSol, pilot.maxSol) : configuredSol;
      // A send needs ALL of: the decision says live, the persisted state is a complete live one, and BOT_DRY_RUN is off right now.
      const dry = d.forceDryRun || !liveStateComplete({ mode: p.mode, liveArm: p.live_arm, liveReportId: p.report_id, liveConfirmedAt: p.confirmed_at }) || deps.dryRun();
      if (!lock.acquire(wallet.walletId, ca, clock.now())) return fail('a buy of this token is already in progress');
      try {
        // A-115: the plan is resolved at the decision (before anything is signed) and travels in the journal entry; a dry run never gets one
        let plan: ExitPlanSnapshot | null = null;
        if (!dry && deps.exitPlan !== undefined) {
          try { plan = deps.exitPlan(sig); } catch (e) { log(`autobuy: the exit plan of ${shortCa(ca)} could not be resolved (${errText(e)}); the active policy applies`, 'warn'); plan = null; }
        }
        const ctx: ExecCtx = {
          ca, signalId, arm: d.arm, wallet, buySol, set, receivedAt, decidedAt, fail, plan,
          pilot: piloting ? { configuredSol, selection: pilotSelectionText(pilotSelectionOf(p.report_id, p.live_arm)), symbol: sig?.token?.symbol ?? null } : null,
        };
        return dry ? await executeDry(ctx) : await executeLive(ctx);
      } finally {
        lock.release(wallet.walletId, ca);
      }
    } catch (e) {
      return fail(errText(e));
    }
  }

  interface ExecCtx {
    ca: string; signalId: string; arm: ArmId; wallet: WalletRef; buySol: number; set: AutoBuySettings;
    receivedAt: number; decidedAt: number;
    fail: (why: string, route?: BuyExecution['route'], signedAt?: number | null) => BuyExecution;
    /** A-114: set for a PILOT buy (the buy card's facts); null otherwise. */
    pilot: { configuredSol: number; selection: string; symbol: string | null } | null;
    /** A-115: the exit plan snapshot of a live buy (null: the active policy). */
    plan: ExitPlanSnapshot | null;
  }

  /** A-114: the PILOT buy card (the owner's private chat; notify() adds the PILOT prefix). */
  function pilotCard(c: ExecCtx, what: string, tx: string | null): void {
    if (c.pilot === null) return;
    const clamped = c.buySol < c.pilot.configuredSol ? ` (buy amount ${solText(c.pilot.configuredSol)}, pilot max ${solText(pilot.maxSol)})` : '';
    notify(`auto-buy ${what} ${c.pilot.symbol ?? 'unknown token'} ${c.ca}: ${solText(c.buySol)} SOL${clamped}, arm ${c.arm}, selection: ${c.pilot.selection}; `
      + `not go-live tested. Pilot buys today: ${caps.pilotUsedToday(clock.now())}/${pilot.maxPerDay} (UTC).${tx !== null ? ` tx ${tx}` : ''}`);
  }

  function routerOpts(c: ExecCtx, extra: RouterOpts): RouterOpts {
    const o: RouterOpts = { singleSend: true, maxImpactPct: cfg.maxImpactPct, slippageBps: c.set.slippageBps, awaitFill: false, ...extra };
    if (c.set.priorityFee !== undefined) o.priorityFee = c.set.priorityFee;
    if (c.set.antiMev !== undefined) o.antiMev = c.set.antiMev;
    return o;
  }

  const failText = (e: unknown): string => (e instanceof ImpactCapError ? `impact_cap: ${errText(e)}`.slice(0, 200) : errText(e));

  async function executeDry(c: ExecCtx): Promise<BuyExecution> {
    let r: RouterResult;
    try {
      r = await deps.smartBuy(c.wallet.keypair, c.ca, c.buySol, routerOpts(c, { buildOnly: true }));
    } catch (e) {
      return c.fail(failText(e));
    }
    if (r.sent !== false) {
      // Cannot be undone, so stop everything: a dry run must never send.
      state.setOff();
      notify(`DRY RUN SAFETY STOP: the router reported a send for ${shortCa(c.ca)} during a dry run (tx ${r.sig}). Auto-buy is OFF; check the wallet.`);
      return c.fail('dry run: the router reported a send; auto-buy switched off');
    }
    const quote = r.tokensOutQuoted ?? r.tokensOut;
    const quoteStr = quote !== undefined ? quote.toString() : null;
    const solIn = lamportsOf(c.buySol);
    let pos: PositionV2;
    try {
      pos = deps.positions.openVirtual({
        signal_id: c.signalId, ca: c.ca, wallet_id: c.wallet.walletId, owner: c.wallet.owner, arm: c.arm, route: r.route,
        sol_in_lamports: solIn, quote_tokens_out: quoteStr, opened_at: clock.now(),
      });
    } catch (e) {
      return c.fail(errText(e), r.route);
    }
    emitPositionOpened(pos, c.signalId, c.ca);
    pilotCard(c, 'dry run (BOT_DRY_RUN is on: nothing was sent) of', null);
    return {
      status: 'dry_run', tx: null, error: null, route: r.route, solInLamports: solIn, quoteTokensOut: quoteStr,
      stamps: { decidedAt: c.decidedAt, signedAt: clock.now(), submittedAt: null },
    };
  }

  async function executeLive(c: ExecCtx): Promise<BuyExecution> {
    if (ledger.has(c.ca)) return c.fail('already_bought');
    const res = caps.reserve(c.buySol, clock.now());
    if (!res.ok) return c.fail(res.reason);
    const token = res.token;
    // A-114: a PILOT buy also holds one of today's pilot slots (same tick as the check, so two signals cannot both take the last one)
    let pilotToken: number | null = null;
    if (c.pilot !== null) {
      const pr = caps.pilotReserve(pilot.maxPerDay, clock.now());
      if (!pr.ok) { caps.cancel(token); return c.fail(pr.reason); }
      pilotToken = pr.token;
    }
    const solIn = lamportsOf(c.buySol);
    const holder: { signed: SignedTx | null; at: number | null; rec: PendingRecord | null } = { signed: null, at: null, rec: null };
    const opts = routerOpts(c, {
      async onSigned(s: SignedTx): Promise<void> {
        const at = clock.now();
        if (pilotToken !== null) caps.pilotCommit(pilotToken, at);   // A-114: the pilot count is on disk before the send; a throw aborts the send
        const rec: PendingRecord = {
          sig: s.sig, signal_id: c.signalId, ca: c.ca, wallet_id: c.wallet.walletId, owner: c.wallet.owner, arm: c.arm, route: s.route,
          sol_in_lamports: solIn, quote_tokens_out: null, last_valid_block_height: s.lastValidBlockHeight, submitted_at: at,
          received_at: c.receivedAt, decided_at: c.decidedAt, signed_at: at, ...(c.plan !== null ? { exit_plan: c.plan } : {}),
        };
        journal.add(rec);                                          // a throw here aborts the send
        try {
          ledger.add(c.ca, { at, signal_id: c.signalId, tx: s.sig });
        } catch (e) {
          try { journal.remove(s.sig); } catch { /* the entry is harmless: nothing was sent */ }
          throw e;
        }
        holder.signed = s;
        holder.at = at;
        holder.rec = rec;
      },
    });

    let result: RouterResult | null = null;
    let error: unknown = null;
    try {
      result = await deps.smartBuy(c.wallet.keypair, c.ca, c.buySol, opts);
    } catch (e) {
      error = e;
    }

    const sentSigs: string[] = [];
    if (holder.signed !== null) sentSigs.push(holder.signed.sig);
    if (error instanceof RouterSendError) for (const s of error.sigs) if (!sentSigs.includes(s)) sentSigs.push(s);
    if (error === null && result !== null && result.sent !== false && !sentSigs.includes(result.sig)) sentSigs.push(result.sig);

    if (sentSigs.length === 0) {
      // nothing was sent: release the slot; a refusal by the impact cap is a protective decision, not a failed buy
      caps.cancel(token);
      if (pilotToken !== null) caps.pilotCancel(pilotToken);   // a no-op when onSigned already recorded it (the slot then stays used)
      const why = error !== null ? failText(error) : 'the router did not send';
      if (!(error instanceof ImpactCapError)) countFail(why);
      return c.fail(why);
    }
    if (sentSigs.length > 1) log(`autobuy: singleSend produced ${sentSigs.length} signatures for ${shortCa(c.ca)}; watching the first`, 'err');

    // a transaction was sent (or the send was attempted): the chain decides what happened to it
    const sigOut = sentSigs[0];
    let rec = holder.rec !== null && holder.rec.sig === sigOut ? holder.rec : null;
    if (rec === null) rec = await lateJournal(c, sigOut, solIn);
    const quote = result !== null ? (result.tokensOutQuoted ?? result.tokensOut) : undefined;
    const quoteStr = quote !== undefined ? quote.toString() : null;
    if (quoteStr !== null) {
      rec = { ...rec, quote_tokens_out: quoteStr };
      journal.update(sigOut, { quote_tokens_out: quoteStr });
    }
    if (error !== null) log(`autobuy: the send of ${shortCa(c.ca)} reported "${errText(error)}"; checking the chain for ${sigOut}`, 'warn');
    if (pilotToken !== null) {
      // a router that sent without onSigned (late journal): record the pilot buy now (still held in memory if the write fails)
      try { caps.pilotCommit(pilotToken, clock.now()); } catch (e) { log(`autobuy: PILOT count write failed after the send (${errText(e)}); the slot stays held in memory`, 'err'); }
    }
    startWatch({ rec, token, kind: 'live', streak: 0, openTries: 0, alertedAt: null, startedAt: clock.now(), timer: null }, confirmPollMs);
    pilotCard(c, 'SENT', sigOut);
    return {
      status: 'submitted', tx: sigOut, error: null, route: result?.route ?? rec.route, solInLamports: solIn, quoteTokensOut: quoteStr,
      stamps: { decidedAt: c.decidedAt, signedAt: holder.at, submittedAt: clock.now() },
    };
  }

  /** A signature that reached a sender without an onSigned journal entry (a router that broke its A-26 contract): journal it now. */
  async function lateJournal(c: ExecCtx, sig: string, solIn: string): Promise<PendingRecord> {
    let height = 0;
    try { height = await deps.rpc.getBlockHeight(); } catch { /* the watcher keeps retrying */ }
    const at = clock.now();
    const rec: PendingRecord = {
      sig, signal_id: c.signalId, ca: c.ca, wallet_id: c.wallet.walletId, owner: c.wallet.owner, arm: c.arm, route: null,
      sol_in_lamports: solIn, quote_tokens_out: null, last_valid_block_height: height > 0 ? height + 151 : Number.MAX_SAFE_INTEGER, submitted_at: at,
      received_at: c.receivedAt, decided_at: c.decidedAt, signed_at: at, ...(c.plan !== null ? { exit_plan: c.plan } : {}),
    };
    log(`autobuy: ${sig} was sent without an onSigned journal entry; journalling it now`, 'err');
    try { journal.add(rec); } catch (e) { log(`autobuy: late journal write failed (${errText(e)})`, 'err'); }
    try { if (!ledger.has(c.ca)) ledger.add(c.ca, { at, signal_id: c.signalId, tx: sig }); } catch (e) { log(`autobuy: late ledger write failed (${errText(e)})`, 'err'); }
    return rec;
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // the confirm loop and boot recovery (one watcher per journalled buy)
  // ---------------------------------------------------------------------------------------------------------------------------------

  function pollMs(w: Watch): number {
    if (w.kind === 'recovery') return recoverPollMs;
    return clock.now() - w.startedAt < CONFIRM_FAST_WINDOW_MS ? confirmPollMs : recoverPollMs;
  }

  function startWatch(w: Watch, firstDelayMs: number): void {
    watches.set(w.rec.sig, w);
    schedule(w, firstDelayMs);
  }

  function schedule(w: Watch, ms: number): void {
    if (stopped) return;
    w.timer = clock.setTimeout(() => { void tick(w); }, ms);
  }

  /** One check of one journalled buy. True when it is resolved (position opened or buy failed) and the journal entry is gone. */
  async function tick(w: Watch): Promise<boolean> {
    w.timer = null;
    if (stopped || watches.get(w.rec.sig) !== w) return false;
    let verdict: PendingVerdict;
    try {
      verdict = await checkPending(w.rec, deps.rpc, { balanceFirst: w.kind === 'recovery', expiredUnknownStreak: w.streak });
    } catch (e) {
      log(`autobuy: landed-check of ${w.rec.sig} failed (${errText(e)})`, 'warn');
      schedule(w, pollMs(w));
      return false;
    }
    if (verdict.kind === 'wait') {
      w.streak = verdict.expiredUnknownStreak;
      schedule(w, pollMs(w));
      return false;
    }
    let done: boolean;
    try {
      done = verdict.kind === 'failed' ? settleFailed(w, verdict.reason)
        : verdict.kind === 'adopt' ? await openPosition(w, 'unverified', verdict.rawAtoms)
        : await settleLanded(w);
    } catch (e) {
      log(`autobuy: settling ${w.rec.sig} failed (${errText(e)})`, 'err');
      done = false;
    }
    if (done) {
      watches.delete(w.rec.sig);
      return true;
    }
    w.openTries++;
    if (w.openTries >= OPEN_RETRIES_MAX) {
      // A-93f: never drop the watcher of a buy that may have landed: real tokens without a position have no exits. Slow down instead.
      const now = clock.now();
      if (w.alertedAt === null || now - w.alertedAt >= OPEN_REALERT_MS) {
        w.alertedAt = now;
        notify(`Auto-buy ${shortCa(w.rec.ca)}: the buy ${w.rec.sig} landed but its position could not be opened after ${w.openTries} tries, so it has NO exits yet. The bot keeps trying every ${Math.round(OPEN_SLOW_RETRY_MS / 1000)} s; check the wallet and /positions.`);
      }
      schedule(w, OPEN_SLOW_RETRY_MS);
      return false;
    }
    schedule(w, recoverPollMs);
    return false;
  }

  async function settleLanded(w: Watch): Promise<boolean> {
    let fill: BuyFill | 'unverified';
    try {
      fill = await deps.fills.buyFill(w.rec.sig, w.rec.owner, w.rec.ca);
    } catch (e) {
      log(`autobuy: fill read of ${w.rec.sig} failed (${errText(e)}); the fill stays unverified`, 'warn');
      fill = 'unverified';
    }
    // A-29: a confirmed transaction that delivered no tokens is a reverted or empty buy, never a position
    if (fill !== 'unverified' && fill.tokensRaw === '0') return settleFailed(w, 'transaction confirmed but delivered 0 tokens (reverted or empty fill)');
    return openPosition(w, fill, null);
  }

  /** The tokens the wallet holds for this buy, from the balance call (null when unknown or empty). */
  async function walletAtoms(rec: PendingRecord): Promise<bigint | null> {
    try {
      const b = await deps.rpc.getSplTokenBalance(rec.owner, rec.ca);
      if (b === null) return null;
      const v = typeof b.rawAtoms === 'bigint' ? b.rawAtoms : typeof b.rawAtoms === 'number' ? (Number.isFinite(b.rawAtoms) && b.rawAtoms >= 0 ? BigInt(Math.trunc(b.rawAtoms)) : null) : /^\d+$/.test(b.rawAtoms) ? BigInt(b.rawAtoms) : null;
      return v !== null && v > 0n ? v : null;
    } catch {
      return null;
    }
  }

  async function openPosition(w: Watch, fill: BuyFill | 'unverified', adoptedAtoms: bigint | null): Promise<boolean> {
    const rec = w.rec;
    let pb: PendingBuyWithPlan = toPendingBuy(rec);
    if (rec.exit_plan !== undefined) pb = { ...pb, exit_plan: rec.exit_plan };
    if (fill === 'unverified') {
      // PositionsStore opens an unverified fill from quote_tokens_out; the wallet balance is better when we have it
      const atoms = adoptedAtoms ?? (pb.quote_tokens_out === null ? await walletAtoms(rec) : null);
      if (atoms !== null) pb = { ...pb, quote_tokens_out: atoms.toString() };
      if (pb.quote_tokens_out === null) return false;       // nothing to size the position with yet: try again
    }
    let pos: PositionV2 | null = null;
    try {
      if (deps.positions.hasOpen(rec.ca, rec.wallet_id)) log(`autobuy: ${shortCa(rec.ca)} already has an open position (an earlier attempt got that far); not opening a second one`, 'warn');
      else pos = deps.positions.openFromBuy(pb, fill);
    } catch (e) {
      log(`autobuy: openFromBuy failed for ${rec.sig} (${errText(e)})`, 'err');
      if (w.openTries === 0) notify(`Auto-buy ${shortCa(rec.ca)} landed (${rec.sig}) but the position could not be saved (${errText(e)}). Retrying; the buy stays in the pending-buys journal.`);
      return false;
    }
    if (pos !== null) emitPositionOpened(pos, rec.signal_id, rec.ca);
    try { journal.remove(rec.sig); } catch (e) { log(`autobuy: could not remove the journal entry ${rec.sig} (${errText(e)})`, 'err'); }
    const confirmedAt = fill !== 'unverified' ? fill.confirmedAt : clock.now();
    emitBuy(rec, 'confirmed', { error: null, confirmedAt });   // the event keeps the original quote; only the position uses the wallet balance
    const sol = Number(BigInt(rec.sol_in_lamports)) / LAMPORTS_PER_SOL;
    if (w.token !== null) caps.commit(w.token, clock.now()); else caps.record(sol, clock.now());
    state.noteSuccess();
    breaker.noteBuyLanded();
    if (fill === 'unverified') {
      notify(`Auto-buy ${shortCa(rec.ca)}: the fill could not be verified from the transaction; the position was opened from the ${adoptedAtoms !== null ? 'wallet balance' : 'quote'} (unverified). Check it.`);
    }
    return true;
  }

  function settleFailed(w: Watch, reason: string): boolean {
    const rec = w.rec;
    if (w.token !== null) caps.cancel(w.token);
    countFail(reason);
    try { journal.remove(rec.sig); } catch (e) { log(`autobuy: could not remove the journal entry ${rec.sig} (${errText(e)})`, 'err'); }
    emitBuy(rec, 'failed', { error: reason, confirmedAt: null });
    return true;
  }

  /**
   * A-93f: the first check of every journal entry runs at once (in parallel) and the boot waits for them at most RECOVER_BOOT_DEADLINE_MS
   * on the bot clock. An entry still unresolved then is counted as waiting; its watcher goes on in the background (tick re-schedules
   * itself), so a degraded RPC never holds the exit engine, the events server or the Telegram UI for minutes.
   */
  function recover(): Promise<RecoveryReport> {
    const ws: Watch[] = [];
    for (const rec of journal.list()) {
      if (watches.has(rec.sig)) continue;
      const w: Watch = { rec, token: null, kind: 'recovery', streak: 0, openTries: 0, alertedAt: null, startedAt: clock.now(), timer: null };
      watches.set(rec.sig, w);
      ws.push(w);
    }
    if (ws.length === 0) return Promise.resolve({ resolved: 0, waiting: 0 });
    return new Promise<RecoveryReport>(resolve => {
      let resolved = 0;
      let settled = 0;
      let finished = false;
      let deadline: TimerHandle | null = null;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (deadline !== null) { clock.clearTimeout(deadline); deadline = null; }
        resolve({ resolved, waiting: ws.length - resolved });
      };
      deadline = clock.setTimeout(() => {
        deadline = null;
        if (!finished) log(`autobuy: boot recovery is still checking ${ws.length - settled} journal entr${ws.length - settled === 1 ? 'y' : 'ies'} after ${Math.round((deps.recoverDeadlineMs ?? RECOVER_BOOT_DEADLINE_MS) / 1000)} s; the boot goes on and the watchers keep checking`, 'warn');
        finish();
      }, deps.recoverDeadlineMs ?? RECOVER_BOOT_DEADLINE_MS);
      for (const w of ws) {
        void tick(w).then(ok => { if (!finished && ok) resolved++; }, e => { log(`autobuy: recovery of ${w.rec.sig} failed (${errText(e)})`, 'err'); })
          .finally(() => { settled++; if (settled === ws.length) finish(); });
      }
    });
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // feeds from the exit engine, heartbeat, commands, lifecycle
  // ---------------------------------------------------------------------------------------------------------------------------------

  function onPositionClosed(p: ClosedPositionInfo): void {
    // verified real signal trades only: a dry-run, manual or unverified position never enters the rolling window
    if (p.origin !== 'signal' || p.dryRun || p.fillSource !== 'tx_meta' || p.entryTx === null) return;
    const n = netPerSolIn(p.realizedNetLamports, p.solSpentLamports);
    if (n === null) return;
    const r = state.addClosedTrade({ tx: p.entryTx, net_per_sol_in: n, closed_at: p.closedAt }, clock.now());
    if (r.pausedNow) notify(`Auto-buy PAUSED (paused_rolling): ${state.get().pause_reason ?? 'the rolling window is below the limit'}. /autobuy resume clears it.`);
  }

  function heartbeat(): { autobuy: Heartbeat['autobuy']; caps_used: Heartbeat['caps_used'] } {
    const now = clock.now();
    const p = state.get();
    const usage = caps.usage(now);
    const br = breaker.check(now);
    if (br.justTripped) notify(`Auto-buy PAUSED (paused_breaker): ${br.detail}. /autobuy resume clears it; a restart also clears it.`);
    const live = p.mode === 'live';
    return {
      autobuy: {
        enabled: p.mode !== 'off', mode: p.mode, arm: live ? p.live_arm : p.mode === 'dry_run' ? p.dry_run_arm : null,
        report_id: live ? p.report_id : null, confirmed_at: live ? p.confirmed_at : null, dry_run: deps.dryRun(),
        paused: p.pause ?? (br.tripped ? 'paused_breaker' : null),
      },
      caps_used: { hour: usage.lastHour, day: usage.lastDay, sol_day: usage.solLastDay },
    };
  }

  function bootLine(): string {
    const h = heartbeat().autobuy;
    return `auto-buy: mode ${h.mode}, arm ${h.arm ?? 'none'}, confirmed_at ${h.confirmed_at === null ? 'none' : new Date(h.confirmed_at).toISOString()}, `
      + `paused ${h.paused ?? 'no'}, BOT_DRY_RUN ${h.dry_run ? 'on' : 'off'}`
      + (pilot.enabled ? `, PILOT on (max ${solText(pilot.maxSol)} SOL per buy, ${pilot.maxPerDay} per UTC day)` : pilot.requested ? `, PILOT refused (${pilot.refused ?? 'invalid limits'})` : '');
  }

  const commands = createAutoBuyCommands({
    clock, state, engine: deps.engine, breaker,
    dryRunEnv: deps.dryRun, policyVersion: () => deps.policyVersions().EA ?? null,
    onFreshArms: onArmsStatus,
    extraStatus: () => {
      const hb = heartbeat();
      const l = currentLimits();
      return [
        `caps used: ${hb.caps_used.hour}/${l.perHour} in the last hour, ${hb.caps_used.day}/${l.perDay} in 24 h, ${hb.caps_used.sol_day.toFixed(4)}/${l.solPerDay} SOL in 24 h`,
        `open positions: ${deps.positions.openCount(false)} real, ${deps.positions.openCount(true)} dry run (max ${l.maxOpen})`,
        `pending buys in the journal: ${journal.list().length}`,
      ];
    },
    notifyOwner: deps.notifyOwner, log,
    ...(pilot.requested ? {
      pilot: () => ({
        enabled: pilot.enabled, requested: pilot.requested, refused: pilot.refused, maxSol: pilot.maxSol, maxPerDay: pilot.maxPerDay,
        usedToday: caps.pilotUsedToday(clock.now()),
      }),
    } : {}),
  });

  return {
    decide,
    execute,
    onArmsStatus,
    refreshArms,
    armsKnown: () => armsLoaded,
    recover,
    commands,
    onPositionClosed,
    noteSellOk(): void { breaker.noteSellOk(clock.now()); },
    hasPendingBuy: (ca: string): boolean => journal.list().some(r => r.ca === ca),
    heartbeat,
    bootLine,
    pilotLive: () => pilotLive(state.get()),
    pilotCard: () => (pilotLive(state.get()) ? { maxSol: pilot.maxSol, maxPerDay: pilot.maxPerDay } : null),
    start(): void {
      for (const k of cfgResult.invalid) log(`autobuy: ${k} is not usable; the code default is used`, 'warn');
      for (const d of cfgResult.deviations) log(`autobuy: deviation from the code defaults: ${d}`, 'warn');
      // A-114: the pilot's warnings, and ONE owner notice per process when it is armed (or refused)
      for (const w of pilot.warnings) log(`autobuy: ${w}`, 'warn');
      if (pilotStartNote !== null) {
        log(`autobuy: ${pilotStartNote}`, 'warn');
        try { deps.notifyOwner?.(pilotStartNote); } catch (e) { log(`autobuy: owner notice failed (${errText(e)})`, 'err'); }
        pilotStartNote = null;
      }
      if (!pilotNoticeSent && pilot.requested) {
        pilotNoticeSent = true;
        if (pilot.enabled) {
          notify(`the auto-buy PILOT is armed (AUTOBUY_PILOT): max ${solText(pilot.maxSol)} SOL per buy, ${pilot.maxPerDay} per UTC day, not go-live tested. `
            + 'It relaxes ONLY the go-live PASS: every other auto-buy guard stays on. Nothing is bought until you send /autobuy on <ARM> (or /autobuy on when the Engine reports no arms: grade A only) and the CONFIRM'
            + (deps.dryRun() ? '; BOT_DRY_RUN is on, so nothing is sent until it is turned off.' : '.'));
        } else {
          const t = `PILOT refused: ${pilot.refused ?? 'invalid limits'}. Auto-buy follows the normal go-live rules (a standing PASS).`;
          try { deps.notifyOwner?.(t); } catch (e) { log(`autobuy: owner notice failed (${errText(e)})`, 'err'); }
        }
      }
      currentLimits();
      if (state.loadNote !== null) log(`autobuy: ${state.loadNote}`, 'warn');
      if (ledger.loadError !== null) log(`autobuy: the buy ledger could not be read (${ledger.loadError}); it was moved aside and starts empty`, 'err');
      if (journal.loadError !== null) log(`autobuy: the pending-buys journal could not be read (${journal.loadError}); it was moved aside`, 'err');
      // A-93f: the caps counters are the daily limits; an unreadable file never means zero usage (AutoBuyCaps holds the buys).
      if (caps.loadError !== null) {
        log(`autobuy: ${AUTO_BUY_CAPS_FILENAME} could not be read (${caps.loadError}); live auto-buy is held for 24 h so the daily limits cannot be exceeded`, 'err');
        notify(`${AUTO_BUY_CAPS_FILENAME} could not be read at start (${caps.loadError}). Live auto-buy is held for 24 h so the hour/day/SOL limits cannot be exceeded. Fix or delete the file and restart to clear it.`);
      }
      if (caps.saveError !== null) log(`autobuy: ${AUTO_BUY_CAPS_FILENAME} could not be written (${caps.saveError}); live auto-buy is held until it can`, 'err');
      log(bootLine(), 'info');
    },
    stop(): void {
      stopped = true;
      for (const w of watches.values()) {
        if (w.timer !== null) clock.clearTimeout(w.timer);
        w.timer = null;
      }
      watches.clear();
    },
  };
}
