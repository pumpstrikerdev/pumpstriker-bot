/**
 * ExitApi.cancel tests (B30 rule 7): a position held -> leg CANCEL (guaranteed exit, doubled base slippage escalating to 5000 bps, then the
 * panic leg) -> 'executed'; none held -> 'no_position'.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SignalCancel } from '../shared/contract/v1';
import { cleanupTempDirs, newCa, tempDir } from '../link/link-testkit';
import { sellKey } from './failure-policy';
import { createExitApi } from './api';
import { addPosition, makeWorld, setMultiple, type World, type WorldOpts } from './exits-testkit';

afterEach(() => cleanupTempDirs());

const world = (o?: WorldOpts): World => makeWorld(tempDir(), o);
const retro: SignalCancel = { reason: 'retro_kill', kills: ['K9'], detected_at: 1, detail: 'creator holds 40%', action: 'sell_if_held' };
const apiOf = (w: World) => createExitApi({ store: w.store, engine: w.engine, log: () => undefined });

describe('ExitApi.cancel', () => {
  it('answers no_position, and sells nothing, when no signal position is held on the CA', async () => {
    const w = world();
    const api = apiOf(w);
    expect(await api.cancel(newCa(), 'dec_1', retro)).toBe('no_position');
    // a manual holding of the same CA is the user\'s own: a retro-kill does not touch it
    const manual = addPosition(w, { origin: 'manual' });
    expect(await api.cancel(manual.ca, 'dec_1', retro)).toBe('no_position');
    // a position that is already empty is not "held"
    const empty = addPosition(w);
    w.store.update(empty.position_id, { tokens: '0' });
    expect(await api.cancel(empty.ca, 'dec_1', retro)).toBe('no_position');
    expect(w.sells).toHaveLength(0);
    expect(w.outbox.events).toEqual([]);
  });

  it('a held position gets a guaranteed exit of 100% (leg CANCEL, the doubled base slippage first) and the answer is executed', async () => {
    const w = world();
    const p = addPosition(w);
    setMultiple(w, p.ca, 0.9);
    expect(await apiOf(w).cancel(p.ca, p.signal_id!, retro)).toBe('executed');
    expect(w.sells).toHaveLength(1);
    expect(w.sells[0]).toMatchObject({ tokens: 1_000_000_000n, slippageBps: 600, singleSend: true });
    expect(w.legs().map(l => `${l.leg}:${l.status}:${l.attempt}`)).toEqual(['CANCEL:filled:1']);
    expect(w.legs()[0]).toMatchObject({ fraction_of_original: 1, dry_run: false, quote_src: 'onchain', policy_version: p.policy_version });
    expect(w.closed()).toHaveLength(1);
    expect(w.closed()[0]).toMatchObject({ reason: 'cancel', close_account_status: 'closed' });
    expect(w.store.get(p.position_id)).toMatchObject({ closed_at: expect.any(Number), cancel_pending: false });
  });

  it('escalates 600 -> 5000 bps -> the 9900 bps panic leg inside one attempt, with a landed-check between the sends', async () => {
    const w = world({ sellScript: ['revert', 'revert', 'ok'] });
    const p = addPosition(w);
    expect(await apiOf(w).cancel(p.ca, p.signal_id!, retro)).toBe('executed');
    expect(w.sells.map(s => s.slippageBps)).toEqual([600, 5000, 9900]);
    expect(w.legs().map(l => `${l.leg}:${l.status}:${l.attempt}`)).toEqual(['CANCEL:filled:1']);
    expect(w.closed()).toHaveLength(1);
  });

  it('a cancel that cannot be sold is retried by the passes, and after 2 failed attempts is locked out with an owner alert', async () => {
    const w = world({ sellScript: ['revert'] });
    const p = addPosition(w);
    expect(await apiOf(w).cancel(p.ca, p.signal_id!, retro)).toBe('executed');
    expect(w.store.get(p.position_id)).toMatchObject({ cancel_pending: true, closed_at: null });
    expect(w.legs().map(l => `${l.leg}:${l.status}:${l.attempt}`)).toEqual(['CANCEL:failed:1']);
    await w.passAt(5000);                        // the failed cancel is taken up by the pass after the young cadence (A-93f)
    expect(w.sells.map(s => s.slippageBps)).toEqual([600, 5000, 9900, 600, 5000, 9900]);
    expect(w.legs().map(l => `${l.leg}:${l.status}:${l.attempt}`)).toEqual(['CANCEL:failed:1', 'CANCEL:locked_out:2']);
    expect(w.notices.some(n => n.includes('auto-exit is OFF'))).toBe(true);
    expect(w.store.get(p.position_id)).toMatchObject({ cancel_pending: false, closed_at: null });
    await w.engine.runPass();
    await w.passAt(5000);
    expect(w.sells).toHaveLength(6);             // locked out: no more sends
  });

  it('is never skipped for lack of a price: the quote only fills the report', async () => {
    const w = world();
    const p = addPosition(w);
    setMultiple(w, p.ca, null);
    expect(await apiOf(w).cancel(p.ca, p.signal_id!, retro)).toBe('executed');
    expect(w.sells).toHaveLength(1);
    expect(w.legs()[0]).toMatchObject({ leg: 'CANCEL', status: 'filled', quote_src: null, quote_age_s: null, quote_multiple: null, sol_out_quoted_lamports: null });
    expect(w.closed()).toHaveLength(1);
  });

  it('while another sell holds the wallet the cancel stays pending and goes out as soon as the wallet is free', async () => {
    const w = world();
    const p = addPosition(w);
    const key = sellKey(p.ca, 'w1');
    expect(w.engine.mutex.tryAcquire(key)).toBe(true);
    expect(await apiOf(w).cancel(p.ca, p.signal_id!, retro)).toBe('executed');
    expect(w.sells).toHaveLength(0);
    expect(w.store.get(p.position_id)!.cancel_pending).toBe(true);
    w.engine.mutex.release(key);
    await w.engine.runPass();
    expect(w.sells).toHaveLength(1);
    expect(w.closed()).toHaveLength(1);
    expect(w.store.get(p.position_id)!.cancel_pending).toBe(false);
  });

  it('a dry-run position is cancelled on paper: the leg is reported with dry_run and nothing is sent', async () => {
    const w = world();
    const p = addPosition(w, { dryRun: true });
    expect(await apiOf(w).cancel(p.ca, p.signal_id!, retro)).toBe('executed');
    expect(w.sells).toHaveLength(0);
    expect(w.legs()[0]).toMatchObject({ leg: 'CANCEL', status: 'filled', dry_run: true, tx: null, sol_out_real_lamports: null });
    expect(w.closed()[0]).toMatchObject({ reason: 'cancel', close_account_status: 'skipped' });
  });

  it('two cancels for the same position at once make one sale and one position.closed', async () => {
    const w = world();
    const p = addPosition(w);
    await Promise.all([w.engine.cancelPosition(p.position_id), w.engine.cancelPosition(p.position_id)]);
    expect(w.sells).toHaveLength(1);
    expect(w.closed()).toHaveLength(1);
    expect(w.legs().map(l => `${l.leg}:${l.status}`)).toEqual(['CANCEL:filled']);
  });

  it('every signal position of the CA is cancelled, one per wallet', async () => {
    const w = world();
    const ca = newCa();
    const a = addPosition(w, { ca, wallet: 'w1' });
    const b = addPosition(w, { ca, wallet: 'w2' });
    expect(await apiOf(w).cancel(ca, a.signal_id!, retro)).toBe('executed');
    expect(w.sells).toHaveLength(2);
    expect(w.closed().map(c => c.position_id).sort()).toEqual([a.position_id, b.position_id].sort());
  });

  it('a cancel during a take-profit that is still being retried goes through the same guarantee, not the TP budget', async () => {
    const w = world({ sellScript: ['revert', 'ok'] });
    const p = addPosition(w);
    setMultiple(w, p.ca, 2.1);
    await w.engine.runPass();                    // TP1 attempt 1 fails
    expect(w.legs().map(l => `${l.leg}:${l.status}`)).toEqual(['TP1:failed']);
    expect(await apiOf(w).cancel(p.ca, p.signal_id!, retro)).toBe('executed');
    expect(w.sells.at(-1)).toMatchObject({ tokens: 1_000_000_000n, slippageBps: 600 });
    expect(w.legs().at(-1)).toMatchObject({ leg: 'CANCEL', status: 'filled' });
  });
});
