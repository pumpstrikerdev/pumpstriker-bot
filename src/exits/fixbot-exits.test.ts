/**
 * A-93f (orchestrator fix, rb/FIX-BOT): regression tests for the confirmed exit-engine bugs.
 *   FIXBOT-T01  a protective lockout is a cool-down (re-probed, cleared by a fill, probed at once after a restart); an attempt that sent
 *               nothing does not use the attempt budget; a failed CANCEL is retried after the young cadence, not at once.
 *   FIXBOT-T08  an unresolved sell signature whose blockhash is still valid survives a restart and blocks a second send of the same leg.
 *   FIXBOT-T13  the landed-check knows about blockhash expiry: no re-send of a take-profit while an earlier send may still land.
 *   FIXBOT-T18  slow sells do not hold the quote slots: a fifth position is judged and sold while four sells hang.
 *   FIXBOT-T19  a first CANCEL attempt that sent nothing honours its backoff (it is not re-run on every 500 ms tick).
 *   FIXBOT-T20  the lockout cool-down grows after each failed re-probe (capped) and the owner alert is rate-limited: an hour of
 *               reverting probes sends a bounded number of transactions and alerts (signal stop, CANCEL, manual SL order).
 * Everything runs on the FakeClock of exits-testkit.ts over stubs (no RPC, no router, no network).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDirs, tempDir } from '../link/link-testkit';
import { LOCKOUT_REPROBE_MS } from './failure-policy';
import { BASE_PRICE, addOrder, addPosition, makeWorld, setMultiple, type World, type WorldOpts } from './exits-testkit';

afterEach(() => cleanupTempDirs());

const world = (o?: WorldOpts): World => makeWorld(tempDir(), o);
const shape = (w: World) => w.legs().map(l => `${l.leg}:${l.status}:${l.attempt}`);

describe('A-93f exit engine fixes', () => {
  it('FIXBOT-T01 protective lockouts are a cool-down: nothing-sent attempts are free, locked legs are re-probed and cleared by a fill, a restart probes at once, and a failed CANCEL waits for the cadence', async () => {
    // (a) a signal position under a stop: two passes where nothing could be sent, then two reverts, then the re-probe that fills
    const a = world({ sellScript: ['nosend', 'nosend', 'nosend', 'nosend', 'revert', 'revert', 'revert', 'revert', 'revert', 'revert', 'ok'] });
    const pa = addPosition(a);
    setMultiple(a, pa.ca, 0.5);
    await a.engine.runPass();
    await a.passAt(10_000);
    expect(a.sells).toHaveLength(4);
    expect(a.legs()).toEqual([]);                                             // nothing was sent: not an attempt
    expect(a.store.get(pa.position_id)!.lockouts).toEqual([]);
    expect(a.store.get(pa.position_id)!.leg_attempts.PROT ?? 0).toBe(0);
    await a.passAt(10_000);
    await a.passAt(10_000);
    expect(shape(a)).toEqual(['S:failed:1', 'S:locked_out:2']);
    expect(a.store.get(pa.position_id)!.lockouts).toEqual(expect.arrayContaining(['S', 'R0', 'T', 'H']));
    await a.passAt(10_000);
    expect(a.sells).toHaveLength(8);                                          // cooling down
    await a.passAt(LOCKOUT_REPROBE_MS);
    expect(a.sells).toHaveLength(10);                                         // re-probed while the stop still holds
    expect(shape(a)).toEqual(['S:failed:1', 'S:locked_out:2', 'S:locked_out:3']);
    expect(a.notices.filter(n => n.includes('auto-exit is OFF'))).toHaveLength(1);   // the alert is rate-limited (A-93f review)
    await a.passAt(LOCKOUT_REPROBE_MS);
    expect(a.sells).toHaveLength(10);                                         // the cool-down doubled after the failed re-probe
    await a.passAt(LOCKOUT_REPROBE_MS);
    expect(shape(a)).toEqual(['S:failed:1', 'S:locked_out:2', 'S:locked_out:3', 'S:filled:4']);
    expect(a.store.get(pa.position_id)!.closed_at).not.toBeNull();

    // (b) an outage where nothing can ever be sent: no lockout, a backoff, and one owner alert after two minutes
    const b = world({ sellScript: ['nosend'] });
    const pb = addPosition(b);
    setMultiple(b, pb.ca, 0.5);
    await b.engine.runPass();
    for (let i = 0; i < 14; i++) await b.passAt(10_000);
    expect(b.legs()).toEqual([]);
    expect(b.store.get(pb.position_id)!.lockouts).toEqual([]);
    expect(b.sells.length).toBeLessThan(2 * 15);                              // backed off, not every pass
    expect(b.notices.filter(n => /could not be sent/.test(n))).toHaveLength(1);

    // (c) a restart probes a locked position at once
    const c = world({ sellScript: ['revert', 'revert', 'revert', 'revert', 'ok'] });
    const pc = addPosition(c);
    setMultiple(c, pc.ca, 0.5);
    await c.engine.runPass();
    await c.passAt(10_000);
    expect(shape(c)).toEqual(['S:failed:1', 'S:locked_out:2']);
    c.engine.start();
    c.engine.stop();
    expect(c.store.get(pc.position_id)!.lockout_until).toBeLessThanOrEqual(c.clock.now());
    await c.passAt(10_000);
    expect(shape(c)).toEqual(['S:failed:1', 'S:locked_out:2', 'S:filled:3']);

    // (d) a manual SL order that was locked out is re-armed after the cool-down
    const d = world({ sellScript: ['revert', 'revert', 'revert', 'revert', 'ok'] });
    const pd = addPosition(d, { origin: 'manual' });
    d.store.update(pd.position_id, { floor_base: BASE_PRICE * 0.01 });
    const sl = addOrder(d, pd, { type: 'sl', trigger_pct: -10, baseline_multi: 1 });
    setMultiple(d, pd.ca, 0.8);
    await d.engine.runPass();
    await d.passAt(5_000);
    expect(d.store.getOrder(sl.order_id)).toMatchObject({ active: false, deactivated_reason: 'locked-out' });
    await d.passAt(5_000);
    expect(d.sells).toHaveLength(4);
    await d.passAt(LOCKOUT_REPROBE_MS);
    expect(d.sells).toHaveLength(5);
    expect(d.store.getOrder(sl.order_id)).toMatchObject({ active: false, deactivated_reason: 'filled' });

    // (e) a CANCEL that failed waits for the young cadence; once locked out it is re-probed after the cool-down
    const e = world({ sellScript: ['revert'] });
    const pe = addPosition(e);
    await e.engine.cancelPosition(pe.position_id);
    expect(e.sells).toHaveLength(3);
    await e.engine.runPass();
    expect(e.sells).toHaveLength(3);                                          // not again 500 ms later
    await e.passAt(5_000);
    expect(e.sells).toHaveLength(6);
    expect(e.legs().map(l => `${l.leg}:${l.status}:${l.attempt}`)).toEqual(['CANCEL:failed:1', 'CANCEL:locked_out:2']);
    await e.passAt(5_000);
    expect(e.sells).toHaveLength(6);
    await e.passAt(LOCKOUT_REPROBE_MS);
    expect(e.sells).toHaveLength(9);
    expect(e.legs().at(-1)).toMatchObject({ leg: 'CANCEL', status: 'locked_out', attempt: 3 });
  });

  it('FIXBOT-T08 a take-profit signature still in flight when the bot restarts is not sent again until its blockhash has expired', async () => {
    const dir = tempDir();
    const w = makeWorld(dir, { sellScript: ['timeout'] });
    const p = addPosition(w);
    setMultiple(w, p.ca, 2.1);
    w.height.value = 999_000;
    await w.engine.runPass();                                                 // TP1 attempt 1: sent, the confirm timed out
    expect(w.sells).toHaveLength(1);
    const sig = w.sells[0].sig as string;
    expect(w.store.get(p.position_id)!.pending_sigs).toEqual([sig]);

    // the restart: a new engine over the same data folder; the transaction is still in flight
    const r = makeWorld(dir, { sellScript: ['ok'] });
    r.balances.set(p.ca, 1_000_000_000n);
    setMultiple(r, p.ca, 2.1);
    r.height.value = 999_500;
    expect(r.store.get(p.position_id)!.pending_sig_heights).toEqual({ [sig]: 1_000_000 });
    await r.passAt(5_000);
    await r.passAt(5_000);
    expect(r.sells).toHaveLength(0);                                          // it may still land: no second TP1
    r.height.value = 1_000_001;                                               // the blockhash has expired and it never landed
    await r.passAt(5_000);
    expect(r.sells).toHaveLength(1);
    expect(r.legs().map(l => `${l.leg}:${l.status}:${l.attempt}`)).toEqual(['TP1:filled:2']);
    expect(r.store.get(p.position_id)!.tokens).toBe('700000000');
  });

  it('FIXBOT-T13 the landed-check waits for blockhash expiry (or a readable height) before it re-sends a take-profit', async () => {
    const w = world({ sellScript: ['timeout', 'ok'] });
    const p = addPosition(w);
    setMultiple(w, p.ca, 2.1);
    w.height.value = 999_000;
    await w.engine.runPass();
    expect(shape(w)).toEqual(['TP1:failed:1']);
    await w.passAt(5_000);
    expect(w.sells).toHaveLength(1);                                          // still valid: wait
    w.height.value = null;
    await w.passAt(5_000);
    expect(w.sells).toHaveLength(1);                                          // height unreadable: wait, never assume expiry
    w.height.value = 1_000_001;
    await w.passAt(5_000);
    expect(w.sells).toHaveLength(2);
    expect(shape(w)).toEqual(['TP1:failed:1', 'TP1:filled:2']);
    expect(w.store.get(p.position_id)!.tokens).toBe('700000000');             // 30% sold once, not twice
    expect(w.store.get(p.position_id)!.pending_sigs).toEqual([]);
  });

  it('FIXBOT-T18 four sells that hang do not hold the quote slots: a fifth position is quoted and sold meanwhile', async () => {
    const w = world({ sellScript: ['hang', 'hang', 'hang', 'hang', 'ok'] });
    const ps = [addPosition(w), addPosition(w), addPosition(w), addPosition(w)];
    for (const p of ps) setMultiple(w, p.ca, 0.5);
    const fifth = addPosition(w);
    setMultiple(w, fifth.ca, 0.5);
    const pass1 = w.engine.runPass();
    await w.clock.advance(5_000);
    expect(w.sells).toHaveLength(4);                                          // four sells are waiting for their confirm
    const pass2 = w.engine.runPass();
    await w.clock.advance(1);
    expect(w.quoteCalls.some(q => q.ca === fifth.ca)).toBe(true);
    expect(w.sells.map(s => s.mint)).toContain(fifth.ca);
    expect(w.store.get(fifth.position_id)!.closed_at).not.toBeNull();
    await w.clock.advance(600_000);
    await Promise.all([pass1, pass2]);
  });

  it('FIXBOT-T19 a first CANCEL that sent nothing is not re-run before its backoff', async () => {
    const w = world({ sellScript: ['nosend'] });
    const p = addPosition(w);
    await w.engine.cancelPosition(p.position_id);
    const first = w.sells.length;
    expect(first).toBeGreaterThan(0);
    for (let i = 0; i < 9; i++) await w.passAt(500);                          // 4.5 s: inside the first backoff (the young cadence)
    expect(w.sells).toHaveLength(first);
    for (let i = 0; i < 11; i++) await w.passAt(500);                         // 10 s: one more attempt at 5 s, the next one backs off further
    expect(w.sells).toHaveLength(2 * first);
    const cur = w.store.get(p.position_id)!;
    expect(cur.cancel_pending).toBe(true);
    expect(cur.leg_attempts.CANCEL ?? 0).toBe(0);                             // nothing was sent: not an attempt
    expect(w.legs()).toEqual([]);
  });

  it('FIXBOT-T20 an hour of reverting probes sends a bounded number of transactions and alerts (the cool-down grows, the alert is rate-limited)', async () => {
    const HOUR = 3_600_000;
    const alerts = (w: World) => w.notices.filter(n => n.includes('auto-exit is OFF')).length;

    // a signal position under a stop whose every sell reverts on chain
    const a = world({ sellScript: ['revert'] });
    const pa = addPosition(a);
    setMultiple(a, pa.ca, 0.5);
    await a.engine.runPass();
    for (let i = 0; i < HOUR / 30_000; i++) await a.passAt(30_000);
    expect(a.store.get(pa.position_id)!.closed_at).toBeNull();
    expect(a.sells.length).toBeLessThanOrEqual(16);                           // was 82
    expect(alerts(a)).toBeLessThanOrEqual(6);                                 // was 40
    expect(a.legs().length).toBeLessThanOrEqual(8);                           // was 41
    const ua = a.store.get(pa.position_id)!;
    expect(ua.lockout_until! - a.clock.now()).toBeGreaterThan(LOCKOUT_REPROBE_MS);   // still cooling down, longer than the first wait
    expect(ua.lockout_until! - a.clock.now()).toBeLessThanOrEqual(30 * 60_000);      // the cool-down is capped

    // a CANCEL whose every sell reverts
    const c = world({ sellScript: ['revert'] });
    const pc = addPosition(c);
    await c.engine.cancelPosition(pc.position_id);
    for (let i = 0; i < HOUR / 30_000; i++) await c.passAt(30_000);
    expect(c.sells.length).toBeLessThanOrEqual(24);                           // 3 steps per attempt
    expect(alerts(c)).toBeLessThanOrEqual(6);

    // a manual SL order whose every sell reverts
    const d = world({ sellScript: ['revert'] });
    const pd = addPosition(d, { origin: 'manual' });
    d.store.update(pd.position_id, { floor_base: BASE_PRICE * 0.01 });
    const sl = addOrder(d, pd, { type: 'sl', trigger_pct: -10, baseline_multi: 1 });
    setMultiple(d, pd.ca, 0.8);
    await d.engine.runPass();
    for (let i = 0; i < HOUR / 30_000; i++) await d.passAt(30_000);
    expect(d.sells.length).toBeLessThanOrEqual(16);
    expect(alerts(d)).toBeLessThanOrEqual(6);
    const od = d.store.getOrder(sl.order_id)!;
    expect(od).toMatchObject({ active: false, deactivated_reason: 'locked-out' });
    expect((od.retry_at as number) - d.clock.now()).toBeGreaterThan(LOCKOUT_REPROBE_MS);
  });
});
