// R1-B1 (B10 section 3 rule 2): one handler per Engine event type, enforcing "decide the buy BEFORE the Telegram card" (spec D5).
//
// signal.new
//   (a) a second signal.new for a CA already signalled -> bot.contract_violation + delivery.buy skipped (contract_violation), no buy, the card
//       is still shown;
//   (d) an event older than TG_REPLAY_MAX_AGE_MS (600000) at receipt (measured from decision.decided_at) -> delivery.tg expired, no card,
//       no buy (delivery.buy skipped: stale);
//   (b) d = autobuy.decide(...); delivery.buy off / skipped (reason) / dry_run, or for a buy: await autobuy.execute(...) and report
//       submitted / dry_run / failed (confirmed follows from the background confirm, B20);
//   (c) only then the card: enqueue it when grade >= settings.signal.tgMinGrade AND the CA is not suppressed (A-96: label launch-run true), else delivery.tg filtered
//       (error = the filter: null for the grade filter, 'launch-run' for the owner's pre-pump rule). An auto-bought grade-C signal
//       (arm BS) always gets a one-line owner notice, and so does any auto-bought signal the filter hides (the owner must know money moved).
// signal.cancel   exits.cancel(ca, signalId, c) starts first (it sells only when a position is held; B30), the cancel card does not wait for it.
// alert.exit      a card only when the signal's grade >= tgMinGrade and now - priced_at <= 120000; otherwise delivery.tg filtered / expired.
//                 A-150: the 6-hour close (leg H) is not judged by the age of its price: it is a card when now - emitted_at <= 900000, whatever priced_at says.
//                 emitted_at is the time of the Engine's latest POST (its dispatcher sets it again on every attempt, and the validator refuses an alert.exit more
//                 than 120 s past it), so this check only bounds a delay inside intake; the 15-minute life of an H is the Engine's outbox ttl_at (ALERT_EXIT_H_TTL_MS).
// A suppressed CA (A-96) gets NO Telegram card of any kind for as long as its registry entry lives (30 days): no signal card, no cancel card (the protective sell still runs
// first), no exit alert, no auto-buy notice. Each is reported delivery.tg filtered with error 'launch-run'. The suppression is persisted in signalled-cas.json.
// arms.status     autobuy.onArmsStatus.
// ops.alert       the owner's private chat through the send queue, kind 'ops': outside the signal pacing and the tgMinGrade filter.
//
// A failure of the buy side (decide / execute throwing, or a hung execute) never costs the card, and a failure of the card side never
// touches a buy. Events of one CA are handled one after the other (a cancel waits for the buy of the same CA); different CAs run in parallel.
import type { AutoBuyApi, BotOutbox, BuyExecution, ExitApi, TgQueue } from '../bot-contracts';
import type { Clock, TimerHandle } from '../link/clock';
import { buildEnvelope, defaultLog, errMessage, type LinkLog } from '../link/common';
import type { IntakeContext, IntakePort } from '../link/events-server';
import type { SignalRegistry, SignalledInfo } from '../link/inbox';
import { LAUNCH_RUN_SUPPRESSION } from '../link/inbox';
import { hasLaunchRunLabel } from '../autobuy/decide';
import type { Grade } from '../shared/common/ids';
import type {
  BotToEngineType, BuyReason, ContractViolation, DeliveryBuy, DeliveryTg, Envelope, EngineToBotEvent, ExitAlert, OpsAlert, SignalCancel, SignalNew,
} from '../shared/contract/v1';
import { alertCard, cancelCard, noticeCard, opsCard, signalCard, TG_LATE_MS, type InlineRow } from '../tg/cards';
import type { SignalCardExtras } from '../shared/card/render-signal';
import { ownerFilter, ownerFilterError, type OwnerFilterSettings } from './owner-filter';

export const TG_REPLAY_MAX_AGE_MS = 600_000;
export const ALERT_MAX_AGE_MS = 120_000;
/** A-150: the 6-hour close (alert.exit leg H) is not judged by the age of its price (the Engine sends it on time alone, at the last price it has): it is a card
 *  when intake handles it at most this long after its emitted_at, whatever priced_at says. emitted_at is the time of the Engine's latest POST (the dispatcher sets
 *  it again on every attempt), so this only bounds a delay inside the bot; the 15-minute life of an H since the Engine built it is the Engine's outbox ttl_at
 *  (ALERT_EXIT_H_TTL_MS in Engine/src/store/writer.ts). */
export const H_ALERT_MAX_AGE_MS = 900_000;
/** The `error` of a `delivery.tg` with status `filtered` that the owner's pre-pump rule caused (A-96). For `filtered`, DeliveryTg.error names the filter: null is the grade filter. */
export const LAUNCH_RUN_FILTER = LAUNCH_RUN_SUPPRESSION;
/** How long the card waits for a buy that has not returned yet; the outcome of the buy is still reported when it lands. */
export const EXECUTE_WAIT_MS = 15_000;

const GRADE_RANK: Readonly<Record<Grade, number>> = { A: 3, B: 2, C: 1 };
/** True when the registry entry carries a suppression (an entry without the member, or none at all, is not suppressed). */
const isSuppressed = (info: SignalledInfo | null): boolean => info !== null && info.suppressed !== undefined && info.suppressed !== null;
export const gradeAtLeast = (g: Grade, min: Grade): boolean => GRADE_RANK[g] >= GRADE_RANK[min];

export interface IntakeDeps {
  clock: Clock;
  autobuy: AutoBuyApi;
  exits: ExitApi;
  /** The Engine outbox: every delivery / violation event is appended here before anything else happens locally. */
  outbox: BotOutbox;
  tg: TgQueue;
  /** The per-CA registry of the inbox. */
  registry: SignalRegistry;
  /** settings.signal.tgMinGrade (default B). */
  tgMinGrade: () => Grade;
  /** A fresh ULID per call (createUlidFactory). */
  newEventId: () => string;
  replayMaxAgeMs?: number;
  alertMaxAgeMs?: number;
  lateMs?: number;
  executeWaitMs?: number;
  log?: LinkLog;
  /** A-114: true while the auto-buy PILOT is live (autoBuy.pilotLive): the auto-bought notice then says PILOT. Absent = never. */
  pilotLive?: () => boolean;
  /** A-115: the owner's Signals filters (Active, Min Score, MCap and Liq bands), read live; absent = no owner filter. They remove a card AND
   *  the auto-buy of a signal (delivery.buy skipped, reason off, error owner-filter:<names>; decide is not called). */
  ownerFilter?: () => OwnerFilterSettings;
  /** A-115: what the bot adds to a signal card, computed once at enqueue (the playbook, the links, the auto-buy line and the buy buttons). */
  cardExtras?: (sig: SignalNew, ca: string) => { extras?: SignalCardExtras; buttons?: InlineRow[] };
  /** A-115: the bot holds a real position of this CA (a cancel card of an owner-filtered CA is still shown then). */
  holdsPosition?: (ca: string) => boolean;
}

export interface Intake extends IntakePort {
  handle(ev: EngineToBotEvent, ctx: IntakeContext): Promise<void>;
}

type BuyStamps = DeliveryBuy['stamps'];

export function createIntake(deps: IntakeDeps): Intake {
  const { clock, outbox, tg, registry } = deps;
  const log = deps.log ?? defaultLog;
  const replayMax = deps.replayMaxAgeMs ?? TG_REPLAY_MAX_AGE_MS;
  const alertMax = deps.alertMaxAgeMs ?? ALERT_MAX_AGE_MS;
  const lateMs = deps.lateMs ?? TG_LATE_MS;
  const executeWait = deps.executeWaitMs ?? EXECUTE_WAIT_MS;
  const chains = new Map<string, Promise<void>>();
  /** A-115: the owner-filter error of a registry entry, or null. */
  const ownerFilteredOf = (info: SignalledInfo | null): string | null =>
    info !== null && Array.isArray(info.owner_filtered) && info.owner_filtered.length > 0 ? ownerFilterError(info.owner_filtered) : null;
  const holds = (ca: string): boolean => { try { return deps.holdsPosition?.(ca) === true; } catch { return true; } };

  // ---------------------------------------------------------------------------------------------------------------------------------
  // reporting to the Engine (every event goes through the outbox)
  // ---------------------------------------------------------------------------------------------------------------------------------

  function send<T extends BotToEngineType>(type: T, payload: Parameters<typeof buildEnvelope<T>>[1], signalId: string | null, ca: string | null): void {
    try {
      outbox.append(buildEnvelope(type, payload, { eventId: deps.newEventId(), signalId, ca, now: clock.now() }));
    } catch (e) {
      log(`intake: could not record ${type} (${errMessage(e)})`, 'err');
    }
  }

  function reportTg(env: { signal_id: string | null; ca: string | null }, status: DeliveryTg['status'], o: { kind: DeliveryTg['kind']; leg: string | null; latency: number | null; error?: string | null }): void {
    const payload: DeliveryTg = {
      status, message_id: null, error: o.error ?? null, at: clock.now(), latency_ms_from_decision: o.latency === null ? null : Math.max(0, o.latency),
      late: false, kind: o.kind, leg: o.leg,
    };
    send('delivery.tg', payload, env.signal_id, env.ca);
  }

  function reportBuy(env: { signal_id: string | null; ca: string | null }, o: {
    status: DeliveryBuy['status']; reason: BuyReason | null; arm: DeliveryBuy['arm']; stamps: BuyStamps;
    tx?: string | null; error?: string | null; route?: DeliveryBuy['route']; solIn?: string | null; quoteOut?: string | null;
  }): void {
    const payload: DeliveryBuy = {
      status: o.status, reason: o.reason, arm: o.arm, tx: o.tx ?? null, error: o.error ?? null, at: clock.now(), stamps: o.stamps,
      route: o.route ?? null, sol_in_lamports: o.solIn ?? null, quote_tokens_out: o.quoteOut ?? null,
    };
    send('delivery.buy', payload, env.signal_id, env.ca);
  }

  function reportViolation(env: { event_id: string; signal_id: string | null; ca: string | null }, code: string, detail: string): void {
    const payload: ContractViolation = { code, detail, offending_event_id: env.event_id };
    send('bot.contract_violation', payload, env.signal_id, env.ca);
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // signal.new
  // ---------------------------------------------------------------------------------------------------------------------------------

  /** Resolves with the settled value, or 'timeout' after `ms` (the clock's timer is cleared when the value wins). */
  async function withTimeout<T>(p: Promise<T>, ms: number): Promise<{ v: T } | 'timeout'> {
    const timer: { h: TimerHandle | null } = { h: null };
    const timeout = new Promise<'timeout'>(resolve => { timer.h = clock.setTimeout(() => { resolve('timeout'); }, ms); });
    try {
      return await Promise.race([p.then(v => ({ v })), timeout]);
    } finally {
      if (timer.h !== null) clock.clearTimeout(timer.h);
    }
  }

  /** Steps (b): decide, report, execute, report. Returns the execution when money moved (submitted / dry_run), else null. */
  async function runAutoBuy(env: Envelope<'signal.new', SignalNew>, ctx: IntakeContext, suppressed: boolean): Promise<BuyExecution | null> {
    const sig = env.payload;
    let decision: ReturnType<AutoBuyApi['decide']>;
    try {
      decision = deps.autobuy.decide(sig, env, ctx.receivedAt, clock.now());
    } catch (e) {
      log(`intake: autobuy.decide failed for ${env.event_id} (${errMessage(e)})`, 'err');
      reportBuy(env, { status: 'failed', reason: null, arm: null, stamps: { received_at: ctx.receivedAt, decided_at: clock.now(), signed_at: null, submitted_at: null, confirmed_at: null }, error: `decision failed: ${errMessage(e)}` });
      return null;
    }
    const decidedAt = clock.now();
    const base: BuyStamps = { received_at: ctx.receivedAt, decided_at: decidedAt, signed_at: null, submitted_at: null, confirmed_at: null };
    if (decision.action === 'buy' && suppressed) {
      // the second lock of the owner's rule: decide.ts step 7a already skips a launch-run signal at every arm, so a buy here would be a defect; nothing is executed
      log(`intake: autobuy.decide returned a buy for the suppressed signal ${env.event_id}; it is not executed`, 'err');
      reportBuy(env, { status: 'skipped', reason: 'arm_blocked', arm: decision.arm, stamps: base });
      return null;
    }
    if (decision.action !== 'buy') {
      const status: DeliveryBuy['status'] = decision.reason === 'off' ? 'off' : decision.reason === 'dry_run' ? 'dry_run' : 'skipped';
      reportBuy(env, { status, reason: decision.reason, arm: decision.arm, stamps: base });
      return null;
    }
    const settle = (out: { v: BuyExecution } | { e: unknown }): BuyExecution | null => {
      if ('e' in out) {
        log(`intake: autobuy.execute failed for ${env.event_id} (${errMessage(out.e)})`, 'err');
        reportBuy(env, { status: 'failed', reason: 'route_failed', arm: decision.arm, stamps: base, error: errMessage(out.e) });
        return null;
      }
      const x = out.v;
      reportBuy(env, {
        status: x.status, reason: x.status === 'dry_run' ? 'dry_run' : x.status === 'failed' ? 'route_failed' : null, arm: decision.arm,
        stamps: { received_at: ctx.receivedAt, decided_at: x.stamps.decidedAt, signed_at: x.stamps.signedAt, submitted_at: x.stamps.submittedAt, confirmed_at: null },
        tx: x.tx, error: x.error, route: x.route, solIn: x.solInLamports, quoteOut: x.quoteTokensOut,
      });
      return x.status === 'failed' ? null : x;
    };
    // The call starts synchronously; a hung execute must not cost the owner the card, so the card waits for it only up to executeWait.
    const run = (async () => deps.autobuy.execute(sig, env, decision))().then(v => ({ v }), (e: unknown) => ({ e }));
    const first = await withTimeout(run, executeWait);
    if (first === 'timeout') {
      log(`intake: the buy of ${env.event_id} has not returned after ${executeWait} ms; the card goes out, the outcome is reported when it lands`, 'warn');
      void run.then(out => { settle(out); });
      return null;
    }
    return settle(first.v);
  }

  async function onSignalNew(env: Envelope<'signal.new', SignalNew>, ctx: IntakeContext): Promise<void> {
    const sig = env.payload;
    const ca = env.ca;
    const signalId = env.signal_id;
    if (ca === null || signalId === null) { log(`intake: signal.new ${env.event_id} without ca or signal_id`, 'err'); return; }

    const prior = registry.signalled(ca);
    const launchRun = hasLaunchRunLabel(sig.labels);
    // A-115: the owner's filters, judged once on this signal (a settings read that throws fails the signal closed: no card, no buy)
    let ownerNames: string[] = [];
    if (deps.ownerFilter !== undefined) {
      try { ownerNames = ownerFilter(sig, deps.ownerFilter()); } catch (e) { ownerNames = ['settings-unreadable']; log(`intake: the owner filter could not be read (${errMessage(e)}); the signal is filtered`, 'err'); }
    }
    if (prior === null) {
      registry.markSignalled(ca, { signal_id: signalId, at: ctx.receivedAt, grade: sig.grade, symbol: sig.token.symbol, suppressed: launchRun ? LAUNCH_RUN_SUPPRESSION : null,
        ...(ownerNames.length > 0 ? { owner_filtered: ownerNames } : {}) });
    }
    if (ctx.detailDropped === true) reportViolation(env, 'invalid_detail', 'signal.new carried a detail that is not valid; it was dropped and the signal kept');
    // a second signal.new for a suppressed CA stays suppressed whatever its own labels say
    const suppressed = launchRun || isSuppressed(prior);
    const stampsNow = (): BuyStamps => ({ received_at: ctx.receivedAt, decided_at: clock.now(), signed_at: null, submitted_at: null, confirmed_at: null });

    // (a) a second signal.new for a CA already signalled
    if (prior !== null) {
      reportViolation(env, 'duplicate_signal_new', `signal.new for a CA already signalled (first signal ${prior.signal_id}, this one ${signalId})`);
    }

    // (d) a replay older than TG_REPLAY_MAX_AGE_MS at receipt
    const age = ctx.receivedAt - sig.decision.decided_at;
    if (age > replayMax) {
      reportBuy(env, { status: 'skipped', reason: prior !== null ? 'contract_violation' : 'stale', arm: null, stamps: stampsNow() });
      reportTg(env, 'expired', { kind: 'signal', leg: null, latency: age });
      return;
    }

    // (b) the buy is decided and executed BEFORE any Telegram card
    let bought: BuyExecution | null = null;
    if (prior !== null) reportBuy(env, { status: 'skipped', reason: 'contract_violation', arm: null, stamps: stampsNow() });
    else if (ownerNames.length > 0) {
      // the owner's own setting: the auto-buy did not act (an existing reason, so an older Engine accepts it); decide is never asked
      reportBuy(env, { status: 'skipped', reason: 'off', arm: null, stamps: stampsNow(), error: ownerFilterError(ownerNames) });
    } else bought = await runAutoBuy(env, ctx, suppressed);

    // (c) the card, then the owner notice for an auto-bought signal the owner might not see (grade C, or any grade the filter hides)
    const now = clock.now();
    const filtered = !gradeAtLeast(sig.grade, deps.tgMinGrade());
    if (suppressed) {
      reportTg(env, 'filtered', { kind: 'signal', leg: null, latency: now - sig.decision.decided_at, error: LAUNCH_RUN_FILTER });
    } else if (ownerNames.length > 0) {
      reportTg(env, 'filtered', { kind: 'signal', leg: null, latency: now - sig.decision.decided_at, error: ownerFilterError(ownerNames) });
    } else if (filtered) {
      reportTg(env, 'filtered', { kind: 'signal', leg: null, latency: now - sig.decision.decided_at });
    } else {
      let extras: SignalCardExtras | undefined;
      let buttons: InlineRow[] | undefined;
      if (deps.cardExtras !== undefined) {
        try { ({ extras, buttons } = deps.cardExtras(sig, ca)); } catch (e) { log(`intake: the card extras of ${env.event_id} could not be built (${errMessage(e)}); the card goes out without them`, 'warn'); }
      }
      tg.enqueue(signalCard(sig, ca, now, lateMs, extras, buttons), { kind: 'signal', signalId, ca, decidedAt: sig.decision.decided_at, leg: null, grade: sig.grade, replyTo: null });
    }
    if (bought !== null && !suppressed && (filtered || sig.grade === 'C')) {
      const name = sig.token.symbol ?? 'unknown token';
      const feed = filtered ? ' (not in your feed)' : '';
      const mode = bought.status === 'dry_run' ? ' (dry run)' : '';
      let pilot = '';
      try { pilot = deps.pilotLive?.() === true ? 'PILOT ' : ''; } catch { pilot = ''; }
      tg.enqueue(noticeCard(`🤖 ${pilot}auto-bought grade-${sig.grade} signal${feed}${mode}: ${name} ${ca}`),
        { kind: 'ops', signalId: null, ca, decidedAt: null, leg: null, grade: sig.grade, replyTo: null });
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // signal.cancel, alert.exit, arms.status, ops.alert
  // ---------------------------------------------------------------------------------------------------------------------------------

  async function onCancel(env: Envelope<'signal.cancel', SignalCancel>): Promise<void> {
    const ca = env.ca;
    const signalId = env.signal_id;
    if (ca === null || signalId === null) { log(`intake: signal.cancel ${env.event_id} without ca or signal_id`, 'err'); return; }
    // the protective sell starts first (B30 sells only when a position is held); the card does not wait for it
    const sell = (async () => deps.exits.cancel(ca, signalId, env.payload))();
    const info = registry.signalled(ca);
    const ownerOut = ownerFilteredOf(info);
    if (isSuppressed(info)) {
      reportTg(env, 'filtered', { kind: 'cancel', leg: 'CANCEL', latency: null, error: LAUNCH_RUN_FILTER });   // no cancel card for a suppressed CA; the sell above still runs
    } else if (ownerOut !== null && !holds(ca)) {
      reportTg(env, 'filtered', { kind: 'cancel', leg: 'CANCEL', latency: null, error: ownerOut });   // A-115: the owner filtered this CA and holds nothing of it
    } else {
      tg.enqueue(cancelCard(env.payload, ca, info?.symbol ?? null, clock.now(), lateMs),
        { kind: 'cancel', signalId, ca, decidedAt: null, leg: 'CANCEL', grade: info?.grade ?? null, replyTo: null });
    }
    try {
      await sell;
    } catch (e) {
      log(`intake: exits.cancel failed for ${ca} (${errMessage(e)})`, 'err');
    }
  }

  function onAlert(env: Envelope<'alert.exit', ExitAlert>): void {
    const ca = env.ca;
    const signalId = env.signal_id;
    if (ca === null || signalId === null) { log(`intake: alert.exit ${env.event_id} without ca or signal_id`, 'err'); return; }
    const a = env.payload;
    const info = registry.signalled(ca);
    const where = { kind: 'alert' as const, leg: a.leg };
    if (isSuppressed(info)) {
      reportTg(env, 'filtered', { ...where, latency: null, error: LAUNCH_RUN_FILTER });   // the owner's pre-pump rule: no alert card for a suppressed CA
      return;
    }
    const ownerOut = ownerFilteredOf(info);
    if (ownerOut !== null) {
      reportTg(env, 'filtered', { ...where, latency: null, error: ownerOut });   // A-115: the exit alerts of an owner-filtered CA are filtered the same way
      return;
    }
    if (info === null || !gradeAtLeast(info.grade, deps.tgMinGrade())) {
      reportTg(env, 'filtered', { ...where, latency: null });
      return;
    }
    const now = clock.now();
    const age = now - a.priced_at;
    // A-150: an H is judged by now - emitted_at (the time since the Engine's latest POST), every other leg by the age of its price; the report is the same
    const expired = a.leg === 'H' ? now - env.emitted_at > H_ALERT_MAX_AGE_MS : age > alertMax;
    if (expired) {
      reportTg(env, 'expired', { ...where, latency: age });
      return;
    }
    tg.enqueue(alertCard(a, ca, info.symbol, clock.now(), lateMs), { kind: 'alert', signalId, ca, decidedAt: null, leg: a.leg, grade: info.grade, replyTo: null });
  }

  function onOps(env: Envelope<'ops.alert', OpsAlert>): void {
    // the owner's private chat, outside the signal pacing and the grade filter (the queue's ops lane)
    tg.enqueue(opsCard(env.payload, clock.now(), lateMs), { kind: 'ops', signalId: null, ca: null, decidedAt: null, leg: null, grade: null, replyTo: null });
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // dispatch
  // ---------------------------------------------------------------------------------------------------------------------------------

  function serial(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn);
    chains.set(key, next);
    void next.then(() => undefined, () => undefined).then(() => { if (chains.get(key) === next) chains.delete(key); });
    return next;
  }

  return {
    async handle(ev: EngineToBotEvent, ctx: IntakeContext): Promise<void> {
      const guard = async (fn: () => Promise<void> | void): Promise<void> => {
        try {
          await fn();
        } catch (e) {
          log(`intake: ${ev.type} ${ev.event_id} failed (${errMessage(e)})`, 'err');
        }
      };
      switch (ev.type) {
        case 'signal.new': return serial(ev.ca ?? '', () => guard(() => onSignalNew(ev, ctx)));
        case 'signal.cancel': return serial(ev.ca ?? '', () => guard(() => onCancel(ev)));
        case 'alert.exit': return serial(ev.ca ?? '', () => guard(() => onAlert(ev)));
        case 'arms.status': return guard(() => { deps.autobuy.onArmsStatus(ev.payload); });
        case 'ops.alert': return guard(() => { onOps(ev); });
      }
    },
  };
}
