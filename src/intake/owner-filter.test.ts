// A-115 (CARD-MENU spec sections 5.2 and 8): the owner's restored Signals filters on the cards AND on auto-buy, only ever stricter
// (MENU-T08, MENU-T09, MENU-T10), the card extras fixed at enqueue (CARD-T11 on the bot side) and the invalid_detail report (CARD-T15).
// The real send queue and inbox run behind the handlers; Telegram, auto-buy and exits are stubs; the clock is a FakeClock.
import { afterAll, describe, expect, it } from 'vitest';
import type { AutoBuyDecision } from '../bot-contracts';
import { FakeClock } from '../link/clock';
import { createInbox } from '../link/inbox';
import { cleanupTempDirs, FakeTelegram, fixture, FIXTURE_NOW, freshEvent, MemoryOutbox, newCa, newTestUlid, StubAutoBuy, StubExits, tempDir } from '../link/link-testkit';
import type { Grade } from '../shared/common/ids';
import type { EngineToBotEvent, Envelope, ExitAlert, SignalCancel, SignalNew } from '../shared/contract/v1';
import type { SignalCardExtras } from '../shared/card/render-signal';
import type { PlaybookV1 } from '../shared/card/playbook';
import { createSendQueue } from '../tg/send-queue';
import { createIntake, LAUNCH_RUN_FILTER } from './handlers';
import { liquidityOf, ownerFilter, ownerFilterError, type OwnerFilterSettings } from './owner-filter';

afterAll(() => { cleanupTempDirs(); });
const quiet = (): void => undefined;
type SignalEvent = Envelope<'signal.new', SignalNew>;
/** The signal-card deliveries only (an auto-bought hidden signal also gets an ops notice). */
const sigTg = (r: { outbox: MemoryOutbox }) => r.outbox.of('delivery.tg').filter(e => e.payload.kind === 'signal');
const OPEN: OwnerFilterSettings = { enabled: true, minScore: null, minMcap: null, maxMcap: null, minLiquidity: null, maxLiquidity: null };

function rig(o: { tgMin?: Grade; filter?: OwnerFilterSettings; extras?: () => { extras?: SignalCardExtras; buttons?: Array<Array<{ text: string; callback_data: string }>> } } = {}) {
  const clock = new FakeClock(FIXTURE_NOW);
  const outbox = new MemoryOutbox();
  const telegram = new FakeTelegram(clock);
  const queue = createSendQueue({ clock, telegram, chatId: 'chat-main', ownerChatId: 'chat-owner', outbox, newEventId: newTestUlid, log: quiet });
  const inbox = createInbox({ dir: tempDir(), clock, log: quiet });
  const autobuy = new StubAutoBuy(clock);
  const exits = new StubExits();
  const filter = { s: o.filter ?? OPEN };
  const intake = createIntake({
    clock, autobuy, exits, outbox, tg: queue, registry: inbox, tgMinGrade: () => o.tgMin ?? 'B', newEventId: newTestUlid, log: quiet,
    ownerFilter: () => filter.s, holdsPosition: ca => exits.positions.has(ca),
    ...(o.extras !== undefined ? { cardExtras: o.extras } : {}),
  });
  const handle = async (ev: EngineToBotEvent, ctx: { detailDropped?: boolean } = {}): Promise<void> => {
    await intake.handle(ev, { receivedAt: clock.now(), ackedAt: clock.now(), ...ctx });
    await clock.settle();
  };
  const buy = (arm: AutoBuyDecision['arm'] = 'BS'): void => { autobuy.decision = { action: 'buy', reason: null, arm, forceDryRun: false }; };
  const signal = (over: (p: SignalNew) => void = () => undefined, ca: string = newCa()): SignalEvent => {
    const ev = freshEvent(fixture<SignalEvent>('signal.new'), ca);
    over(ev.payload);
    return ev;
  };
  return { clock, outbox, telegram, queue, inbox, autobuy, exits, filter, handle, buy, signal };
}

describe('ownerFilter (pure)', () => {
  it('names every failing filter; blank bounds never filter; a set bound with unknown liquidity fails closed; an invalid bound fails', () => {
    const sig = fixture<SignalEvent>('signal.new').payload;   // confidence 88.5, mcap 30000, liq 12000 / pool 11000
    expect(ownerFilter(sig, OPEN)).toEqual([]);
    expect(ownerFilter(sig, { ...OPEN, enabled: false })).toEqual(['signals-off']);
    expect(ownerFilter(sig, { ...OPEN, minScore: 90 })).toEqual(['min-score']);
    expect(ownerFilter(sig, { ...OPEN, minScore: 88 })).toEqual([]);
    expect(ownerFilter(sig, { ...OPEN, minMcap: 40_000, maxMcap: 20_000 })).toEqual(['min-mcap', 'max-mcap']);
    expect(ownerFilter(sig, { ...OPEN, minMcap: 30_000, maxMcap: 30_000 })).toEqual([]);
    expect(liquidityOf(sig)).toBe(11_000);   // the min of the known readings (the Engine's liq_eff rule)
    expect(ownerFilter(sig, { ...OPEN, minLiquidity: 11_001 })).toEqual(['min-liq']);
    expect(ownerFilter(sig, { ...OPEN, maxLiquidity: 10_000 })).toEqual(['max-liq']);
    const blind: SignalNew = JSON.parse(JSON.stringify(sig));
    blind.market.liq_usd = { value: null, src: null, as_of: null };
    blind.market.pool_liq_usd = { value: null, src: null, as_of: null };
    expect(liquidityOf(blind)).toBeNull();
    expect(ownerFilter(blind, OPEN)).toEqual([]);
    expect(ownerFilter(blind, { ...OPEN, minLiquidity: 1 })).toEqual(['min-liq']);
    expect(ownerFilter(blind, { ...OPEN, maxLiquidity: 1e9 })).toEqual(['max-liq']);
    expect(ownerFilter(sig, { ...OPEN, minScore: 'invalid', maxMcap: 'invalid' })).toEqual(['min-score', 'max-mcap']);
    // the Engine's own liq_eff from the detail wins
    const withDetail: SignalNew = JSON.parse(JSON.stringify(sig));
    const S = (v: number) => ({ value: v, src: 'engine.derived' as const, as_of: 1 });
    withDetail.detail = { vol_24h_usd: S(1), buys_5m: S(1), sells_5m: S(1), burst: S(0.3), liq_eff_usd: S(14_400), token_age_min: S(5),
      cluster: { wallets: 3, kol: 0, sol: S(20), sol_lower_bound: false, first_at: null }, score: { raw: 20, eligible: true, cluster_quality: true, moonshot_gate: false, terms: [], data_gaps: [] } };
    expect(liquidityOf(withDetail)).toBe(14_400);
    expect(ownerFilterError(['min-score', 'max-mcap'])).toBe('owner-filter:min-score,max-mcap');
    expect(ownerFilterError([])).toBeNull();
  });
});

describe('intake with the owner filters', () => {
  it('MENU-T08 a filtered signal: delivery.tg filtered owner-filter:<names>; delivery.buy skipped off with the same error; decide is never asked', async () => {
    const r = rig({ filter: { ...OPEN, minScore: 90, maxMcap: 20_000 } });
    r.buy();
    await r.handle(r.signal());
    expect(r.autobuy.decideCalls).toHaveLength(0);
    expect(r.autobuy.executeCalls).toHaveLength(0);
    expect(r.telegram.calls).toHaveLength(0);
    const buy = r.outbox.of('delivery.buy');
    expect(buy).toHaveLength(1);
    expect(buy[0].payload).toMatchObject({ status: 'skipped', reason: 'off', error: 'owner-filter:min-score,max-mcap' });
    const tg = r.outbox.of('delivery.tg');
    expect(tg).toHaveLength(1);
    expect(tg[0].payload).toMatchObject({ status: 'filtered', kind: 'signal', error: 'owner-filter:min-score,max-mcap' });
    // a passing signal still buys and shows its card
    r.filter.s = OPEN;
    await r.handle(r.signal());
    expect(r.autobuy.decideCalls).toHaveLength(1);
    expect(r.telegram.calls).toHaveLength(1);
  });

  it('MENU-T08 an unknown liquidity with a set bound blocks; the owner filter never un-blocks (grade filter, launch-run and the arms stay)', async () => {
    const r = rig({ filter: { ...OPEN, minLiquidity: 1000 }, tgMin: 'A' });
    r.buy();
    await r.handle(r.signal(p => { p.market.liq_usd = { value: null, src: null, as_of: null }; p.market.pool_liq_usd = { value: null, src: null, as_of: null }; }));
    expect(r.autobuy.decideCalls).toHaveLength(0);
    expect(r.outbox.of('delivery.tg')[0].payload).toMatchObject({ status: 'filtered', error: 'owner-filter:min-liq' });
    // an open filter never brings back what the grade filter hides (grade B under tgMinGrade A): error null as before
    r.filter.s = OPEN;
    await r.handle(r.signal(p => { p.grade = 'B'; }));
    expect(sigTg(r)[1].payload).toMatchObject({ status: 'filtered', error: null });
    // ... nor what launch-run suppresses
    await r.handle(r.signal(p => { p.grade = 'A'; p.labels = [...p.labels, { id: 'launch-run', rule_version: 'launch-run@1', value: true, known: true, acting: true }]; }));
    expect(sigTg(r)[2].payload).toMatchObject({ status: 'filtered', error: LAUNCH_RUN_FILTER });
    // ... and the arms decide the buy as before (decide is asked, its skip is reported unchanged)
    r.autobuy.decision = { action: 'skip', reason: 'arm_blocked', arm: null, forceDryRun: false };
    await r.handle(r.signal(p => { p.grade = 'A'; }));
    expect(r.outbox.of('delivery.buy').at(-1)?.payload).toMatchObject({ status: 'skipped', reason: 'arm_blocked', error: null });
  });

  it('MENU-T09 alert and cancel cards of an owner-filtered CA follow the filter; a cancel card is shown when a position is held; the protective sell always runs', async () => {
    const r = rig({ filter: { ...OPEN, minScore: 95 } });
    const ca = newCa();
    await r.handle(r.signal(() => undefined, ca));
    expect(r.inbox.signalled(ca)?.owner_filtered).toEqual(['min-score']);
    const alert = freshEvent(fixture<Envelope<'alert.exit', ExitAlert>>('alert.exit'), ca);
    alert.payload.priced_at = r.clock.now();
    await r.handle(alert);
    expect(r.outbox.of('delivery.tg').at(-1)?.payload).toMatchObject({ status: 'filtered', kind: 'alert', error: 'owner-filter:min-score' });
    const cancel = freshEvent(fixture<Envelope<'signal.cancel', SignalCancel>>('signal.cancel'), ca);
    await r.handle(cancel);
    expect(r.exits.cancelCalls).toHaveLength(1);                      // the protective sell ran
    expect(r.outbox.of('delivery.tg').at(-1)?.payload).toMatchObject({ status: 'filtered', kind: 'cancel', error: 'owner-filter:min-score' });
    expect(r.telegram.calls).toHaveLength(0);
    // held: the cancel card is shown, and the sell still runs first
    r.exits.positions.add(ca);
    const cancel2 = freshEvent(fixture<Envelope<'signal.cancel', SignalCancel>>('signal.cancel'), ca);
    await r.handle(cancel2);
    expect(r.exits.sells).toEqual([ca]);
    expect(r.telegram.calls).toHaveLength(1);
    expect(r.telegram.calls[0].text).toContain('CANCEL');
  });

  it('MENU-T10 Signals Active OFF: no card, no auto-buy (signals-off)', async () => {
    const r = rig({ filter: { ...OPEN, enabled: false } });
    r.buy();
    await r.handle(r.signal(p => { p.grade = 'A'; }));
    expect(r.autobuy.decideCalls).toHaveLength(0);
    expect(r.autobuy.executeCalls).toHaveLength(0);
    expect(r.telegram.calls).toHaveLength(0);
    expect(r.outbox.of('delivery.buy')[0].payload).toMatchObject({ status: 'skipped', reason: 'off', error: 'owner-filter:signals-off' });
    expect(r.outbox.of('delivery.tg')[0].payload).toMatchObject({ status: 'filtered', error: 'owner-filter:signals-off' });
  });

  it('CARD-T11 the extras and buttons are computed once at enqueue; a LATE card keeps them and the banner is measured at send time', async () => {
    let calls = 0;
    const playbook: PlaybookV1 = { source: 'policy', grade: 'A', policyId: 'EA', version: 'a1b2c3d4e5f60718', rev: null, legs: [{ id: 'H', kind: 'max_hold', protective: true, afterMs: 3_600_000 }], presetState: 'follows' };
    const r = rig({ extras: () => { calls++; return { extras: { playbook, autoBuy: { mode: 'off', arm: null, buySol: 0.01 } }, buttons: [[{ text: '🟢 Buy 0.1 SOL', callback_data: 'sbuy:x:0.1' }]] }; } });
    r.telegram.script.push({ error: Object.assign(new Error('Too Many Requests: retry after 40'), { response: { error_code: 429, description: 'Too Many Requests: retry after 40', parameters: { retry_after: 40 } } }) });
    await r.handle(r.signal());
    expect(calls).toBe(1);
    await r.clock.advance(41_000);
    await r.clock.settle();
    const sent = r.telegram.calls.at(-1)!;
    expect(sent.text.startsWith('⚠ LATE')).toBe(true);
    expect(sent.text).toContain('Exit policy EA (your grade-A preset follows it until you edit it)');
    expect(sent.text).toContain('Auto-buy: OFF · size 0.01 SOL');
    expect(sent.extra.reply_markup).toEqual({ inline_keyboard: [[{ text: '🟢 Buy 0.1 SOL', callback_data: 'sbuy:x:0.1' }]] });
    expect(calls).toBe(1);
  });

  it('CARD-T15 (bot) a signal whose detail was dropped as invalid is still handled, and bot.contract_violation invalid_detail is reported', async () => {
    const r = rig();
    await r.handle(r.signal(), { detailDropped: true });
    const v = r.outbox.of('bot.contract_violation');
    expect(v).toHaveLength(1);
    expect(v[0].payload).toMatchObject({ code: 'invalid_detail' });
    expect(r.telegram.calls).toHaveLength(1);
  });
});
