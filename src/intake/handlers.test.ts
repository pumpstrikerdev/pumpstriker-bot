// R1-B1 (B10 section 4): the intake acceptance tests (replay expiry, buy before card, 429 handling, cancel without a position, grade filter, second signal, ops lane) and the rules around them. The real send queue and inbox run behind the
// handlers; Telegram, auto-buy and exits are stubs; the clock is a FakeClock. Token addresses and ids are generated per test.
import { afterAll, describe, expect, it } from 'vitest';
import type { AutoBuyDecision, BuyExecution } from '../bot-contracts';
import { FakeClock } from '../link/clock';
import { createInbox } from '../link/inbox';
import { cleanupTempDirs, FakeTelegram, fixture, FIXTURE_NOW, freshEvent, MemoryOutbox, newCa, newTestUlid, StubAutoBuy, StubExits, tempDir, telegram429 } from '../link/link-testkit';
import type { Grade } from '../shared/common/ids';
import type { EngineToBotEvent, Envelope, ExitAlert, SignalCancel, SignalNew } from '../shared/contract/v1';
import { createSendQueue } from '../tg/send-queue';
import { createIntake, gradeAtLeast, LAUNCH_RUN_FILTER, TG_REPLAY_MAX_AGE_MS } from './handlers';
import type { OwnerFilterSettings } from './owner-filter';

afterAll(() => { cleanupTempDirs(); });
const quiet = (): void => undefined;
/** The owner's Signals filters with every bound blank (filters nothing). */
const OPEN_FILTER: OwnerFilterSettings = { enabled: true, minScore: null, minMcap: null, maxMcap: null, minLiquidity: null, maxLiquidity: null };

type SignalEvent = Envelope<'signal.new', SignalNew>;

function rig(o: { tgMin?: Grade; start?: number; executeWaitMs?: number; dir?: string; filter?: OwnerFilterSettings } = {}) {
  const clock = new FakeClock(o.start ?? FIXTURE_NOW);
  const filter = { s: o.filter ?? null };
  const order: string[] = [];
  const outbox = new MemoryOutbox(ev => { order.push(`outbox:${ev.type}:${String((ev.payload as { status?: string }).status ?? '')}`); });
  const telegram = new FakeTelegram(clock, () => { order.push('tg:send'); });
  const queue = createSendQueue({ clock, telegram, chatId: 'chat-main', ownerChatId: 'chat-owner', outbox, newEventId: newTestUlid, log: quiet });
  const dir = o.dir ?? tempDir();
  const inbox = createInbox({ dir, clock, log: quiet });
  const autobuy = new StubAutoBuy(clock);
  const exits = new StubExits();
  const min = { g: o.tgMin ?? ('B' as Grade) };
  const intake = createIntake({
    clock, autobuy, exits, outbox, tg: queue, registry: inbox, tgMinGrade: () => min.g, newEventId: newTestUlid, log: quiet,
    ...(o.executeWaitMs !== undefined ? { executeWaitMs: o.executeWaitMs } : {}),
    ...(o.filter !== undefined ? { ownerFilter: () => filter.s ?? OPEN_FILTER } : {}),
  });
  const handle = async (ev: EngineToBotEvent): Promise<void> => {
    await intake.handle(ev, { receivedAt: clock.now(), ackedAt: clock.now() });
    await clock.settle();
  };
  const buy = (arm: AutoBuyDecision['arm'] = 'BS'): void => { autobuy.decision = { action: 'buy', reason: null, arm, forceDryRun: false }; };
  const signal = (over: (p: SignalNew) => void = () => undefined, ca: string = newCa()): SignalEvent => {
    const ev = freshEvent(fixture<SignalEvent>('signal.new'), ca);
    over(ev.payload);
    return ev;
  };
  /** A-96: the same bot after a restart: a NEW inbox and intake over the same data folder, the same Telegram, queue, outbox, exits and auto-buy stubs. */
  const restart = async (): Promise<{ inbox: ReturnType<typeof createInbox>; handle: (ev: EngineToBotEvent) => Promise<void> }> => {
    await inbox.persisted();
    const inbox2 = createInbox({ dir, clock, log: quiet });
    const intake2 = createIntake({ clock, autobuy, exits, outbox, tg: queue, registry: inbox2, tgMinGrade: () => min.g, newEventId: newTestUlid, log: quiet });
    return { inbox: inbox2, handle: async (ev) => { await intake2.handle(ev, { receivedAt: clock.now(), ackedAt: clock.now() }); await clock.settle(); } };
  };
  return { clock, order, outbox, telegram, queue, inbox, autobuy, exits, min, filter, intake, handle, buy, signal, restart };
}

/** The label the Engine puts on a token that already pumped (A-88): launch-run@1, acting, true. */
const LAUNCH_RUN_TRUE = { id: 'launch-run', rule_version: 'launch-run@1', value: true as boolean | null, known: true, acting: true };
const withLaunchRun = (p: SignalNew, g: Grade, label = LAUNCH_RUN_TRUE): void => { p.grade = g; p.labels = [...p.labels.filter((l) => l.id !== 'launch-run'), label]; };

const statusOf = (e: { payload: unknown }): string => String((e.payload as { status: string }).status);

describe('intake: signal.new', () => {
  it('B1-T03 a 10-minute-old signal.new replay is expired: no card and no buy', async () => {
    const r = rig();
    r.buy();
    const ev = r.signal(p => {
      const old = 660_000;
      p.decision.first_reach_at -= old; p.decision.decided_at -= old; p.decision.recorded_at -= old; p.entry.priced_at -= old;
    });
    await r.handle(ev);
    expect(r.autobuy.decideCalls).toHaveLength(0);
    expect(r.autobuy.executeCalls).toHaveLength(0);
    expect(r.telegram.calls).toHaveLength(0);
    expect(r.queue.pending()).toBe(0);
    const tg = r.outbox.of('delivery.tg');
    expect(tg).toHaveLength(1);
    expect(tg[0].payload).toMatchObject({ status: 'expired', kind: 'signal', leg: null, message_id: null, late: false });
    expect(tg[0].payload.latency_ms_from_decision).toBeGreaterThan(TG_REPLAY_MAX_AGE_MS);
    expect(tg[0].signal_id).toBe(ev.signal_id);
    expect(tg[0].ca).toBe(ev.ca);
    const buys = r.outbox.of('delivery.buy');
    expect(buys).toHaveLength(1);
    expect(buys[0].payload).toMatchObject({ status: 'skipped', reason: 'stale' });
  });

  it('a signal exactly at the replay limit is still delivered; one millisecond older is expired', async () => {
    const r = rig();
    const atLimit = r.signal(p => { p.decision.decided_at = r.clock.now() - TG_REPLAY_MAX_AGE_MS; });
    await r.handle(atLimit);
    expect(r.telegram.calls).toHaveLength(1);
    expect(r.telegram.calls[0].text.split('\n')[0]).toContain('LATE');
    const over = r.signal(p => { p.decision.decided_at = r.clock.now() - TG_REPLAY_MAX_AGE_MS - 1; });
    await r.handle(over);
    expect(r.telegram.calls).toHaveLength(1);
    expect(r.outbox.of('delivery.tg').map(statusOf)).toEqual(['sent', 'expired']);
  });

  it('B1-T05 the buy is submitted BEFORE the Telegram send starts (ordering asserted with stamps and with the event order)', async () => {
    const r = rig();
    r.buy('BS');
    r.autobuy.execution = async () => {
      const decidedAt = r.clock.now();
      await r.clock.advance(1);
      const signedAt = r.clock.now();
      await r.clock.advance(1);
      const submittedAt = r.clock.now();
      await r.clock.advance(1);                                  // time passes between the submit and whatever comes next
      return { status: 'submitted', tx: 'tx-stub-1', error: null, route: 'pf-direct', solInLamports: '50000000', quoteTokensOut: '1666666000000',
        stamps: { decidedAt, signedAt, submittedAt } };
    };
    const ev = r.signal();
    await r.handle(ev);
    expect(r.autobuy.decideCalls).toHaveLength(1);
    expect(r.autobuy.executeCalls).toEqual([ev.event_id]);
    expect(r.telegram.calls).toHaveLength(1);
    const buy = r.outbox.of('delivery.buy')[0];
    expect(buy.payload).toMatchObject({ status: 'submitted', reason: null, arm: 'BS', tx: 'tx-stub-1', route: 'pf-direct', sol_in_lamports: '50000000', quote_tokens_out: '1666666000000' });
    const s = buy.payload.stamps;
    expect(s.received_at).toBeLessThanOrEqual(s.decided_at as number);
    expect(s.decided_at as number).toBeLessThan(s.signed_at as number);
    expect(s.signed_at as number).toBeLessThan(s.submitted_at as number);
    expect(s.submitted_at as number).toBeLessThan(r.telegram.calls[0].at);                 // submitted_at < Telegram send start
    expect(r.order.indexOf('outbox:delivery.buy:submitted')).toBeGreaterThanOrEqual(0);
    expect(r.order.indexOf('outbox:delivery.buy:submitted')).toBeLessThan(r.order.indexOf('tg:send'));
    expect(buy.signal_id).toBe(ev.signal_id);
    expect(r.outbox.of('delivery.tg').map(statusOf)).toEqual(['sent']);
  });

  it('B1-T06 a Telegram 429 (retry_after 3) never blocks a buy: the card goes out after 3 s, retrying_429 then sent', async () => {
    const r = rig();
    r.buy();
    r.telegram.script.push({ error: telegram429(3) });
    const first = r.signal();
    await r.handle(first);
    expect(r.outbox.of('delivery.buy').map(statusOf)).toEqual(['submitted']);
    expect(r.telegram.calls).toHaveLength(1);                    // the first attempt hit the 429
    const firstAttemptAt = r.telegram.calls[0].at;

    // while the queue sits in its pause, the next signal is still decided and bought at once
    const second = r.signal();
    await r.handle(second);
    expect(r.autobuy.executeCalls).toEqual([first.event_id, second.event_id]);
    expect(r.outbox.of('delivery.buy').map(statusOf)).toEqual(['submitted', 'submitted']);
    expect(r.telegram.calls).toHaveLength(1);

    await r.clock.advance(2_999);
    expect(r.telegram.calls).toHaveLength(1);
    await r.clock.advance(1);
    expect(r.telegram.calls).toHaveLength(3);                    // both cards, the held one first
    expect(r.telegram.calls[1].at).toBe(firstAttemptAt + 3_000);
    const forFirst = r.outbox.of('delivery.tg').filter(e => e.signal_id === first.signal_id).map(statusOf);
    expect(forFirst).toEqual(['retrying_429', 'sent']);
    expect(r.outbox.of('delivery.tg').filter(e => e.signal_id === second.signal_id).map(statusOf)).toEqual(['sent']);
  });

  it('B1-T08 a grade-C signal below tgMinGrade B is filtered when it is not bought, and a bought one gets a one-line owner notice', async () => {
    const r = rig({ tgMin: 'B' });
    // not bought
    const plain = r.signal(p => { p.grade = 'C'; });
    await r.handle(plain);
    expect(r.telegram.calls).toHaveLength(0);
    expect(r.outbox.of('delivery.buy').map(statusOf)).toEqual(['off']);
    const filtered = r.outbox.of('delivery.tg');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].payload).toMatchObject({ status: 'filtered', kind: 'signal', message_id: null });
    expect(filtered[0].signal_id).toBe(plain.signal_id);

    // bought (arm BS): the card stays out of the feed, one line goes to the owner
    r.buy('BS');
    const bought = r.signal(p => { p.grade = 'C'; });
    await r.handle(bought);
    expect(r.outbox.of('delivery.buy').map(statusOf)).toEqual(['off', 'submitted']);
    expect(r.telegram.calls).toHaveLength(1);
    expect(r.telegram.calls[0].chatId).toBe('chat-owner');
    expect(r.telegram.calls[0].text).toContain('auto-bought grade-C signal (not in your feed)');
    expect(r.telegram.calls[0].text).not.toContain('\n');
    expect(r.telegram.calls[0].text).toContain(bought.ca as string);
    const tg = r.outbox.of('delivery.tg');
    expect(tg.filter(e => e.signal_id === bought.signal_id).map(statusOf)).toEqual(['filtered']);
    expect(tg.filter(e => e.payload.kind === 'ops').map(e => ({ s: statusOf(e), id: e.signal_id }))).toEqual([{ s: 'sent', id: null }]);

    // grades at or above the filter are delivered
    const b = r.signal(p => { p.grade = 'B'; });
    await r.handle(b);
    expect(r.telegram.calls).toHaveLength(2);
    expect(r.telegram.calls[1].chatId).toBe('chat-main');
    r.autobuy.decision = { action: 'skip', reason: 'off', arm: null, forceDryRun: false };
    r.min.g = 'A';
    await r.handle(r.signal(p => { p.grade = 'B'; }));
    expect(r.telegram.calls).toHaveLength(2);
    expect(gradeAtLeast('A', 'A') && gradeAtLeast('A', 'C') && !gradeAtLeast('C', 'B') && gradeAtLeast('B', 'B')).toBe(true);
  });

  it('PPA-T10 the bot never sends a launch-run true signal at grade A, B or C, even at tgMinGrade C, and reports delivery.tg filtered with error launch-run; a signal without it, or with an unknown or false launch-run, is delivered as before', async () => {
    const r = rig({ tgMin: 'C' });
    const hot: SignalEvent[] = [];
    for (const g of ['A', 'B', 'C'] as const) {
      const ev = r.signal(p => { withLaunchRun(p, g); });
      hot.push(ev);
      await r.handle(ev);
    }
    expect(r.telegram.calls).toHaveLength(0);
    expect(r.queue.pending()).toBe(0);
    const tg = r.outbox.of('delivery.tg');
    expect(tg).toHaveLength(3);
    for (const [k, e] of tg.entries()) {
      expect(e.payload, `grade ${'ABC'[k]}`).toMatchObject({ status: 'filtered', kind: 'signal', leg: null, message_id: null, error: 'launch-run', late: false });
      expect(e.payload.error).toBe(LAUNCH_RUN_FILTER);
      expect(e.payload.latency_ms_from_decision).toBeGreaterThanOrEqual(0);
      expect(e.signal_id).toBe(hot[k].signal_id);
      expect(e.ca).toBe(hot[k].ca);
    }
    // the grade filter keeps its own (null) error: a grade-C signal below tgMinGrade B without the label
    r.min.g = 'B';
    await r.handle(r.signal(p => { p.grade = 'C'; }));
    expect(r.outbox.of('delivery.tg').at(-1)?.payload).toMatchObject({ status: 'filtered', error: null });
    // controls at tgMinGrade C: no label, a false launch-run and an unknown launch-run are all delivered
    r.min.g = 'C';
    await r.handle(r.signal(p => { p.grade = 'A'; }));
    await r.handle(r.signal(p => { withLaunchRun(p, 'B', { ...LAUNCH_RUN_TRUE, value: false }); }));
    await r.handle(r.signal(p => { withLaunchRun(p, 'C', { ...LAUNCH_RUN_TRUE, value: null, known: false }); }));
    expect(r.telegram.calls).toHaveLength(3);
    expect(r.outbox.of('delivery.tg').slice(-3).map(statusOf)).toEqual(['sent', 'sent', 'sent']);
  });

  it('B1-T08b a launch-run signal at grade A, B and C gets no card; the suppression survives a bot restart; its cancel still runs the protective sell but sends no cancel card; its exit alert and any auto-buy notice send no card either', async () => {
    const r = rig({ tgMin: 'B' });
    // what decide.ts says for such a signal at every arm (step 7a): arm_blocked, so no money moves and no owner notice can be needed
    r.autobuy.decision = { action: 'skip', reason: 'arm_blocked', arm: 'BS', forceDryRun: false };
    const sigs: SignalEvent[] = [];
    for (const g of ['A', 'B', 'C'] as const) {
      const ev = r.signal(p => { withLaunchRun(p, g); });
      sigs.push(ev);
      await r.handle(ev);
    }
    expect(r.telegram.calls).toHaveLength(0);
    expect(r.outbox.of('delivery.buy').map(statusOf)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(r.outbox.of('delivery.tg').map((e) => [statusOf(e), e.payload.error, e.payload.kind])).toEqual([['filtered', 'launch-run', 'signal'], ['filtered', 'launch-run', 'signal'], ['filtered', 'launch-run', 'signal']]);
    expect(r.inbox.signalled(sigs[0].ca as string)).toMatchObject({ grade: 'A', suppressed: 'launch-run' });

    // the bot restarts: the registry is read back from signalled-cas.json
    const again = await r.restart();
    for (const ev of sigs) expect(again.inbox.signalled(ev.ca as string)?.suppressed).toBe('launch-run');

    // its cancel: the protective sell runs first (a position is held), the card does not go out
    const [a, b, c] = sigs;
    r.exits.positions.add(a.ca as string);
    const cancelA = { ...freshEvent(fixture<Envelope<'signal.cancel', SignalCancel>>('signal.cancel'), a.ca as string), signal_id: a.signal_id };
    await again.handle(cancelA);
    expect(r.exits.cancelCalls.map((x) => x.ca)).toEqual([a.ca]);
    expect(r.exits.sells).toEqual([a.ca]);
    expect(r.telegram.calls).toHaveLength(0);
    expect(r.outbox.of('delivery.tg').at(-1)).toMatchObject({ signal_id: a.signal_id, ca: a.ca });
    expect(r.outbox.of('delivery.tg').at(-1)?.payload).toMatchObject({ status: 'filtered', kind: 'cancel', leg: 'CANCEL', error: 'launch-run', message_id: null });

    // its exit alert (fresh, grade B in the registry): no card, reported filtered with the same error
    const alert = freshEvent(fixture<Envelope<'alert.exit', ExitAlert>>('alert.exit'), b.ca as string);
    alert.signal_id = b.signal_id;
    alert.payload.priced_at = r.clock.now() - 1_000;
    await again.handle(alert);
    expect(r.telegram.calls).toHaveLength(0);
    expect(r.outbox.of('delivery.tg').at(-1)?.payload).toMatchObject({ status: 'filtered', kind: 'alert', leg: 'TP1', error: 'launch-run' });
    // a grade-C CA of the same kind (below tgMinGrade, but the reason reported is the owner's rule, not the grade filter)
    const alertC = freshEvent(fixture<Envelope<'alert.exit', ExitAlert>>('alert.exit'), c.ca as string);
    alertC.signal_id = c.signal_id;
    alertC.payload.priced_at = r.clock.now() - 1_000;
    await again.handle(alertC);
    expect(r.outbox.of('delivery.tg').at(-1)?.payload).toMatchObject({ status: 'filtered', kind: 'alert', error: 'launch-run' });
    expect(r.outbox.of('exit.leg')).toHaveLength(0);

    // a second signal.new for a suppressed CA (a contract violation) stays suppressed whatever its own labels say, and is never bought
    const dup = { ...freshEvent(fixture<SignalEvent>('signal.new'), c.ca as string) };
    dup.payload.grade = 'A';
    await again.handle(dup);
    expect(r.telegram.calls).toHaveLength(0);
    expect(r.outbox.of('bot.contract_violation')).toHaveLength(1);
    expect(r.outbox.of('delivery.tg').at(-1)?.payload).toMatchObject({ status: 'filtered', kind: 'signal', error: 'launch-run' });

    // control: a CA without the suppression still gets its cancel card and its alert card after the same restart
    const okSig = r.signal(p => { p.grade = 'A'; });
    await again.handle(okSig);
    expect(r.telegram.calls).toHaveLength(1);
    await again.handle({ ...freshEvent(fixture<Envelope<'signal.cancel', SignalCancel>>('signal.cancel'), okSig.ca as string), signal_id: okSig.signal_id });
    expect(r.telegram.calls).toHaveLength(2);
    expect(r.telegram.calls[1].text).toContain('CANCEL');
  });

  it('the second lock: a buy that decide() should never have returned for a launch-run signal is not executed, is reported skipped arm_blocked, and sends no owner notice', async () => {
    const r = rig({ tgMin: 'B' });
    r.buy('BS');                                                            // a stub (or a defect) that says buy
    const ev = r.signal(p => { withLaunchRun(p, 'C'); });
    await r.handle(ev);
    expect(r.autobuy.decideCalls).toHaveLength(1);
    expect(r.autobuy.executeCalls).toHaveLength(0);
    expect(r.outbox.of('delivery.buy')).toHaveLength(1);
    expect(r.outbox.of('delivery.buy')[0].payload).toMatchObject({ status: 'skipped', reason: 'arm_blocked', arm: 'BS', tx: null });
    expect(r.telegram.calls).toHaveLength(0);                               // neither the signal card nor an "auto-bought" notice
    expect(r.outbox.of('delivery.tg').map((e) => [statusOf(e), e.payload.error])).toEqual([['filtered', 'launch-run']]);
    // the same stub on a signal without the label still buys: the lock is only for the owner's rule
    await r.handle(r.signal(p => { p.grade = 'A'; }));
    expect(r.autobuy.executeCalls).toHaveLength(1);
  });

  it('an auto-bought grade-C signal gets the one-line notice even when tgMinGrade lets its card through, and an auto-bought grade-A one does not', async () => {
    const r = rig({ tgMin: 'C' });
    r.buy('BS');
    await r.handle(r.signal(p => { p.grade = 'C'; }));
    expect(r.telegram.calls).toHaveLength(2);
    const card = r.telegram.calls.find(c => c.chatId === 'chat-main');
    const notice = r.telegram.calls.find(c => c.chatId === 'chat-owner');   // the ops lane goes first, so the order of the two is not part of the rule
    expect(card?.text).toContain('GRADE C');   // A-115: the old card header
    expect(notice?.text).toContain('auto-bought grade-C signal');
    expect(notice?.text).not.toContain('not in your feed');
    await r.handle(r.signal());
    expect(r.telegram.calls).toHaveLength(3);                       // grade A, shown: card only
  });

  it('B1-T11 a second signal.new for a CA is a contract violation: reported, shown, and NOT bought', async () => {
    const r = rig();
    r.buy();
    const ca = newCa();
    const first = r.signal(() => undefined, ca);
    const second = r.signal(() => undefined, ca);
    await r.handle(first);
    expect(r.autobuy.decideCalls).toHaveLength(1);
    expect(r.autobuy.executeCalls).toHaveLength(1);
    expect(r.outbox.of('bot.contract_violation')).toHaveLength(0);

    await r.handle(second);
    expect(r.autobuy.decideCalls, 'no second decision').toHaveLength(1);
    expect(r.autobuy.executeCalls, 'no second buy').toHaveLength(1);
    const v = r.outbox.of('bot.contract_violation');
    expect(v).toHaveLength(1);
    expect(v[0].payload.offending_event_id).toBe(second.event_id);
    expect(v[0].payload.code).toBe('duplicate_signal_new');
    expect(v[0].payload.detail).toContain(first.signal_id as string);
    expect(v[0].ca).toBe(ca);
    const buys = r.outbox.of('delivery.buy').filter(e => e.signal_id === second.signal_id);
    expect(buys).toHaveLength(1);
    expect(buys[0].payload).toMatchObject({ status: 'skipped', reason: 'contract_violation' });
    expect(r.telegram.calls, 'the card of the second signal is still shown').toHaveLength(2);
  });

  it('maps a skipped decision to off / skipped / dry_run and keeps the arm and the reason', async () => {
    const r = rig();
    const cases: Array<[AutoBuyDecision, string, string | null]> = [
      [{ action: 'skip', reason: 'off', arm: null, forceDryRun: false }, 'off', 'off'],
      [{ action: 'skip', reason: 'cap_hour', arm: 'BS', forceDryRun: false }, 'skipped', 'cap_hour'],
      [{ action: 'skip', reason: 'arm_blocked', arm: 'B1', forceDryRun: false }, 'skipped', 'arm_blocked'],
      [{ action: 'skip', reason: 'dry_run', arm: 'BS', forceDryRun: true }, 'dry_run', 'dry_run'],
    ];
    for (const [decision, status, reason] of cases) {
      r.autobuy.decision = decision;
      await r.handle(r.signal());
      const last = r.outbox.of('delivery.buy').at(-1) as { payload: { status: string; reason: string | null; arm: string | null; stamps: { decided_at: number | null } } };
      expect(last.payload).toMatchObject({ status, reason, arm: decision.arm });
      expect(last.payload.stamps.decided_at).not.toBeNull();
    }
    expect(r.autobuy.executeCalls).toHaveLength(0);
  });

  it('a decide() that throws, an execute() that throws and one that reports failed each leave the owner the card', async () => {
    const r = rig();
    r.buy();
    r.autobuy.decide = () => { throw new Error('decide exploded'); };
    await r.handle(r.signal());
    expect(r.outbox.of('delivery.buy').at(-1)?.payload).toMatchObject({ status: 'failed', arm: null });
    expect(r.telegram.calls).toHaveLength(1);

    const r2 = rig();
    r2.buy();
    r2.autobuy.execution = async () => { throw new Error('rpc down'); };
    await r2.handle(r2.signal());
    expect(r2.outbox.of('delivery.buy').at(-1)?.payload).toMatchObject({ status: 'failed', reason: 'route_failed', error: 'rpc down', arm: 'BS' });
    expect(r2.telegram.calls).toHaveLength(1);

    const r3 = rig();
    r3.buy();
    r3.autobuy.execution = async () => ({ status: 'failed', tx: null, error: 'no route', route: null, solInLamports: null, quoteTokensOut: null, stamps: { decidedAt: r3.clock.now(), signedAt: null, submittedAt: null } } satisfies BuyExecution);
    await r3.handle(r3.signal(p => { p.grade = 'C'; }));
    expect(r3.outbox.of('delivery.buy').at(-1)?.payload).toMatchObject({ status: 'failed', reason: 'route_failed', error: 'no route' });
    expect(r3.telegram.calls, 'a failed buy is not "auto-bought": no notice for a filtered card').toHaveLength(0);
  });

  it('a buy that has not returned after executeWaitMs does not hold the card back; its outcome is still reported when it lands', async () => {
    const r = rig({ executeWaitMs: 15_000 });
    r.buy();
    let land!: (x: BuyExecution) => void;
    r.autobuy.execution = () => new Promise<BuyExecution>(resolve => { land = resolve; });
    const done = r.intake.handle(r.signal(), { receivedAt: r.clock.now(), ackedAt: r.clock.now() });
    await r.clock.advance(14_999);
    expect(r.telegram.calls).toHaveLength(0);
    await r.clock.advance(1);
    await done;
    await r.clock.settle();
    expect(r.telegram.calls).toHaveLength(1);
    expect(r.outbox.of('delivery.buy')).toHaveLength(0);
    land({ status: 'submitted', tx: 'tx-late', error: null, route: 'jupiter', solInLamports: '1', quoteTokensOut: '2', stamps: { decidedAt: r.clock.now(), signedAt: r.clock.now(), submittedAt: r.clock.now() } });
    await r.clock.settle();
    expect(r.outbox.of('delivery.buy').map(statusOf)).toEqual(['submitted']);
  });

  it('a dry-run execution is reported as dry_run and a filtered dry-run buy says so in the owner notice', async () => {
    const r = rig();
    r.autobuy.decision = { action: 'buy', reason: null, arm: 'BS', forceDryRun: true };
    r.autobuy.execution = async () => ({ status: 'dry_run', tx: null, error: null, route: 'pf-direct', solInLamports: '50000000', quoteTokensOut: '1666666000000',
      stamps: { decidedAt: r.clock.now(), signedAt: r.clock.now(), submittedAt: null } });
    await r.handle(r.signal(p => { p.grade = 'C'; }));
    expect(r.outbox.of('delivery.buy')[0].payload).toMatchObject({ status: 'dry_run', reason: 'dry_run', tx: null });
    expect(r.telegram.calls[0].text).toContain('(dry run)');
  });

  it('handles the events of one CA one after the other: a cancel waits for the buy of the same CA', async () => {
    const r = rig();
    r.buy();
    r.autobuy.execution = async () => { await r.clock.sleep(5_000); return { status: 'submitted', tx: 'tx-slow', error: null, route: 'pf-direct', solInLamports: '1', quoteTokensOut: '2', stamps: { decidedAt: r.clock.now(), signedAt: r.clock.now(), submittedAt: r.clock.now() } }; };
    const ca = newCa();
    const sig = r.signal(() => undefined, ca);
    const cancel = { ...freshEvent(fixture<Envelope<'signal.cancel', SignalCancel>>('signal.cancel'), ca), signal_id: sig.signal_id };
    const a = r.intake.handle(sig, { receivedAt: r.clock.now(), ackedAt: r.clock.now() });
    const b = r.intake.handle(cancel, { receivedAt: r.clock.now(), ackedAt: r.clock.now() });
    await r.clock.advance(4_999);
    expect(r.exits.cancelCalls).toHaveLength(0);
    await r.clock.advance(1);
    await Promise.all([a, b]);
    expect(r.exits.cancelCalls).toHaveLength(1);
    expect(r.outbox.events.findIndex(e => e.type === 'delivery.buy')).toBeLessThan(r.outbox.events.findIndex(e => e.type === 'delivery.tg' && e.payload.kind === 'cancel'));
  });
});

describe('intake: signal.cancel, alert.exit, arms.status, ops.alert', () => {
  it('B1-T07 a signal.cancel for an unknown CA without a position sells nothing and sends the cancel card only', async () => {
    const r = rig();
    const cancel = freshEvent(fixture<Envelope<'signal.cancel', SignalCancel>>('signal.cancel'));
    await r.handle(cancel);
    expect(r.exits.cancelCalls).toEqual([{ ca: cancel.ca, signalId: cancel.signal_id, kills: ['K4', 'K9'] }]);
    expect(r.exits.sells, 'no position, no sell').toEqual([]);
    expect(r.outbox.of('exit.leg')).toHaveLength(0);
    expect(r.telegram.calls).toHaveLength(1);
    expect(r.telegram.calls[0].text).toContain('CANCEL');
    expect(r.telegram.calls[0].text).toContain('retro-kill');
    expect(r.outbox.of('delivery.tg')).toHaveLength(1);
    expect(r.outbox.of('delivery.tg')[0].payload).toMatchObject({ status: 'sent', kind: 'cancel', leg: 'CANCEL' });
    expect(r.outbox.of('delivery.tg')[0].signal_id).toBe(cancel.signal_id);

    // with a position held the same cancel does sell (B30 decides; the intake only delegates), and the card uses the signalled symbol
    const ca = newCa();
    const sig = r.signal(() => undefined, ca);
    await r.handle(sig);
    r.exits.positions.add(ca);
    await r.handle({ ...freshEvent(fixture<Envelope<'signal.cancel', SignalCancel>>('signal.cancel'), ca), signal_id: sig.signal_id });
    expect(r.exits.sells).toEqual([ca]);
    expect(r.telegram.calls.at(-1)?.text).toContain('CREW');
  });

  it('an exit alert is a card only for a signalled grade at or above tgMinGrade and at most 120 s after its price', async () => {
    const r = rig({ tgMin: 'B' });
    const ca = newCa();
    const sig = r.signal(() => undefined, ca);
    await r.handle(sig);
    const alert = (priced: number, caOverride: string = ca): Envelope<'alert.exit', ExitAlert> => {
      const ev = freshEvent(fixture<Envelope<'alert.exit', ExitAlert>>('alert.exit'), caOverride);
      ev.payload.priced_at = priced;
      return ev;
    };
    const sentBefore = r.telegram.calls.length;
    await r.handle(alert(r.clock.now() - 120_000));
    expect(r.telegram.calls).toHaveLength(sentBefore + 1);
    expect(r.telegram.calls.at(-1)?.text).toContain('TP1');
    expect(r.outbox.of('delivery.tg').at(-1)?.payload).toMatchObject({ status: 'sent', kind: 'alert', leg: 'TP1' });

    await r.handle(alert(r.clock.now() - 120_001));
    expect(r.telegram.calls).toHaveLength(sentBefore + 1);
    expect(r.outbox.of('delivery.tg').at(-1)?.payload).toMatchObject({ status: 'expired', kind: 'alert', leg: 'TP1' });

    await r.handle(alert(r.clock.now() - 1_000, newCa()));        // a CA this bot never saw a signal for
    expect(r.outbox.of('delivery.tg').at(-1)?.payload).toMatchObject({ status: 'filtered', kind: 'alert', leg: 'TP1' });

    r.min.g = 'A';
    const caB = newCa();
    await r.handle(r.signal(p => { p.grade = 'B'; }, caB));       // grade B is below the new filter: filtered, not delivered
    await r.handle(alert(r.clock.now() - 1_000, caB));
    expect(r.outbox.of('delivery.tg').at(-1)?.payload).toMatchObject({ status: 'filtered', kind: 'alert' });
    expect(r.telegram.calls).toHaveLength(sentBefore + 1);
  });

  it('an arms.status goes to autobuy.onArmsStatus and nowhere else', async () => {
    const r = rig();
    const ev = fixture<EngineToBotEvent>('arms.status');
    await r.handle(ev);
    expect(r.autobuy.armsStatus).toHaveLength(1);
    expect(r.autobuy.armsStatus[0].arms.map(a => a.arm)).toEqual(['BS', 'B0', 'B1', 'B2']);
    expect(r.telegram.calls).toHaveLength(0);
    expect(r.outbox.events).toHaveLength(0);
  });

  it('B1-T12 an ops.alert reaches the owner at once even when the pacing queue is full and tgMinGrade is A', async () => {
    const r = rig({ tgMin: 'A' });
    for (let i = 0; i < 10; i++) await r.handle(r.signal());     // grade A: 8 go out, 2 wait for a free slot
    expect(r.telegram.calls).toHaveLength(8);
    expect(r.queue.pending()).toBe(2);

    const ops = freshEvent(fixture<EngineToBotEvent>('ops.alert'));
    await r.handle(ops);                                         // no clock movement: nothing may wait
    expect(r.telegram.calls).toHaveLength(9);
    const sent = r.telegram.calls[8];
    expect(sent.chatId).toBe('chat-owner');
    expect(sent.text).toContain('ENGINE red');
    expect(sent.text).toContain('GMGN feed dark for 3 min');
    expect(r.queue.pending()).toBe(2);                           // the two paced cards still wait
    const delivery = r.outbox.of('delivery.tg').filter(e => e.payload.kind === 'ops');
    expect(delivery).toHaveLength(1);
    expect(delivery[0].signal_id).toBeNull();
    expect(delivery[0].ca).toBeNull();
    expect(delivery[0].payload).toMatchObject({ status: 'sent', kind: 'ops', message_id: sent.messageId, leg: null, latency_ms_from_decision: null });
  });
});

// A-150: the 6-hour close (leg H) is sent on time alone, priced at the last price the Engine has, which can be minutes old. Intake judges it by
// now - emitted_at (at most 15 minutes), whatever priced_at says; every other leg keeps the price rule (120 s). Over HTTP emitted_at is the time of
// the Engine's latest POST (set again on every attempt), so the 15-minute life of an H is the Engine's outbox ttl_at; these tests drive intake alone.
describe('intake: the 6-hour close is not dropped for the age of its price (A-150)', () => {
  const SEC = 1_000;
  const MIN = 60_000;
  type Rig = ReturnType<typeof rig>;
  /** An exit alert of the signal `sig`: its leg, the age of its price and the age of the alert itself (now - emitted_at) at the rig's clock. */
  const exitAlert = (r: Rig, sig: SignalEvent, leg: ExitAlert['leg'], o: { priceAgeMs: number; alertAgeMs: number }): Envelope<'alert.exit', ExitAlert> => {
    const ev = freshEvent(fixture<Envelope<'alert.exit', ExitAlert>>('alert.exit'), sig.ca);
    ev.signal_id = sig.signal_id;
    ev.emitted_at = r.clock.now() - o.alertAgeMs;
    ev.payload.leg = leg;
    ev.payload.priced_at = r.clock.now() - o.priceAgeMs;
    ev.payload.quote_age_s = o.priceAgeMs / SEC;
    return ev;
  };
  const lastTg = (r: Rig) => r.outbox.of('delivery.tg').at(-1)?.payload;

  it('HEX-T01 an H whose price is 10 minutes old and whose event was emitted 5 s ago is sent as a card', async () => {
    const r = rig();
    const sig = r.signal();
    await r.handle(sig);
    const before = r.telegram.calls.length;
    await r.handle(exitAlert(r, sig, 'H', { priceAgeMs: 10 * MIN, alertAgeMs: 5 * SEC }));
    expect(lastTg(r)).toMatchObject({ status: 'sent', kind: 'alert', leg: 'H', error: null });
    expect(r.telegram.calls).toHaveLength(before + 1);
    expect(r.telegram.calls.at(-1)?.text.startsWith('H CREW: ')).toBe(true);
  });

  it('HEX-T02 an H that intake handles more than 15 minutes after its emitted_at (the rule alone: over HTTP the validator refuses it first) is expired, whatever priced_at says (15 minutes exactly is still sent)', async () => {
    const r = rig();
    const sig = r.signal();
    await r.handle(sig);
    const before = r.telegram.calls.length;
    await r.handle(exitAlert(r, sig, 'H', { priceAgeMs: 15 * MIN, alertAgeMs: 15 * MIN }));          // the limit itself
    expect(lastTg(r)).toMatchObject({ status: 'sent', kind: 'alert', leg: 'H' });
    expect(r.telegram.calls).toHaveLength(before + 1);
    await r.handle(exitAlert(r, sig, 'H', { priceAgeMs: 15 * MIN + 1, alertAgeMs: 15 * MIN + 1 }));  // one millisecond past it
    expect(lastTg(r)).toMatchObject({ status: 'expired', kind: 'alert', leg: 'H', message_id: null, latency_ms_from_decision: 15 * MIN + 1 });
    await r.handle(exitAlert(r, sig, 'H', { priceAgeMs: 1 * SEC, alertAgeMs: 16 * MIN }));          // a fresh price does not save an old alert
    expect(lastTg(r)).toMatchObject({ status: 'expired', kind: 'alert', leg: 'H', message_id: null });
    expect(r.telegram.calls).toHaveLength(before + 1);
  });

  it('HEX-T03 TP1, TP2, TP3, T and S keep the price rule: a price 121 s old is expired even on an alert emitted 5 s ago, a fresh price is sent whatever the age of the alert', async () => {
    const r = rig();
    const sig = r.signal();
    await r.handle(sig);
    const before = r.telegram.calls.length;
    const legs = ['TP1', 'TP2', 'TP3', 'T', 'S'] as const;
    for (const leg of legs) {
      await r.handle(exitAlert(r, sig, leg, { priceAgeMs: 121 * SEC, alertAgeMs: 5 * SEC }));
      expect(lastTg(r)).toMatchObject({ status: 'expired', kind: 'alert', leg, message_id: null, error: null, latency_ms_from_decision: 121 * SEC });
    }
    expect(r.telegram.calls).toHaveLength(before);
    for (const leg of legs) {
      await r.handle(exitAlert(r, sig, leg, { priceAgeMs: 120 * SEC, alertAgeMs: 5 * SEC }));       // the price limit itself
      expect(lastTg(r)).toMatchObject({ status: 'sent', kind: 'alert', leg });
      await r.handle(exitAlert(r, sig, leg, { priceAgeMs: 2 * SEC, alertAgeMs: 20 * MIN }));        // the age of the alert plays no part for these legs
      expect(lastTg(r)).toMatchObject({ status: 'sent', kind: 'alert', leg });
      expect(r.telegram.calls.at(-1)?.text.startsWith(`${leg} CREW: `)).toBe(true);
    }
    expect(r.telegram.calls).toHaveLength(before + 2 * legs.length);
  });

  it('HEX-T04 the filters still come first for an H (launch-run, then the owner filter, then the grade), before its age: filtered, never sent, never expired', async () => {
    const r = rig({ tgMin: 'B', filter: OPEN_FILTER });
    const run = r.signal(p => { withLaunchRun(p, 'A'); });       // the owner's pre-pump rule only
    await r.handle(run);
    r.filter.s = { ...OPEN_FILTER, minScore: 95 };               // the fixture's score is 88.5
    const runOwner = r.signal(p => { withLaunchRun(p, 'A'); });  // launch-run AND under the owner's Min Score
    const owner = r.signal(p => { p.grade = 'A'; });             // under the owner's Min Score only
    const ownerLow = r.signal(p => { p.grade = 'C'; });          // under the owner's Min Score AND under tgMinGrade
    for (const ev of [runOwner, owner, ownerLow]) await r.handle(ev);
    r.filter.s = OPEN_FILTER;
    const low = r.signal(p => { p.grade = 'C'; });               // under tgMinGrade only
    await r.handle(low);
    expect(r.inbox.signalled(runOwner.ca as string)).toMatchObject({ suppressed: LAUNCH_RUN_FILTER, owner_filtered: ['min-score'] });
    expect(r.inbox.signalled(ownerLow.ca as string)).toMatchObject({ grade: 'C', owner_filtered: ['min-score'] });
    expect(r.inbox.signalled(run.ca as string)?.owner_filtered).toBeUndefined();
    expect(r.inbox.signalled(low.ca as string)?.owner_filtered).toBeUndefined();
    const sent = r.telegram.calls.length;
    const cases: Array<[SignalEvent, string | null]> = [[run, LAUNCH_RUN_FILTER], [runOwner, LAUNCH_RUN_FILTER], [owner, 'owner-filter:min-score'], [ownerLow, 'owner-filter:min-score'], [low, null]];
    for (const alertAgeMs of [5 * SEC, 20 * MIN]) {              // an H the bot would send, and one too old to send
      for (const [sig, error] of cases) {
        await r.handle(exitAlert(r, sig, 'H', { priceAgeMs: 10 * MIN, alertAgeMs }));
        expect(lastTg(r)).toMatchObject({ status: 'filtered', kind: 'alert', leg: 'H', message_id: null, error });
      }
    }
    expect(r.telegram.calls).toHaveLength(sent);
    expect(r.outbox.of('delivery.tg').filter(e => e.payload.kind === 'alert').map(statusOf)).toEqual(Array(2 * cases.length).fill('filtered'));
  });

  it('HEX-T06 the card of an H with a price 10 minutes old renders and shows the age of the quote', async () => {
    const r = rig();
    const sig = r.signal();
    await r.handle(sig);
    const h = exitAlert(r, sig, 'H', { priceAgeMs: 10 * MIN, alertAgeMs: 5 * SEC });
    h.payload.multiple = 0.62;
    h.payload.peak_multiple = 1.4;
    await r.handle(h);
    expect(lastTg(r)).toMatchObject({ status: 'sent', kind: 'alert', leg: 'H' });
    expect(r.telegram.calls.at(-1)?.text).toBe(`H CREW: 0.62x (peak 1.40x) on the signal basis · quote 600s old · policy ${h.payload.policy.version}`);
  });
});
