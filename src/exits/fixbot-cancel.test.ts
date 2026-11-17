/**
 * A-93f FIXBOT-T07: a signal.cancel that arrives while the auto-buy of the same CA is still in the pending journal is remembered (on disk)
 * and applied to the position the moment it opens, so the guaranteed CANCEL exit is never lost. FakeClock and stubs only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SignalCancel } from '../shared/contract/v1';
import { cleanupTempDirs, newCa, tempDir } from '../link/link-testkit';
import { createExitApi } from './api';
import { applyCancelRequest, openCancelRequests } from './cancel-requests';
import { addPosition, makeWorld } from './exits-testkit';

afterEach(() => cleanupTempDirs());

const retro: SignalCancel = { reason: 'retro_kill', kills: ['K9'], detected_at: 1, detail: 'creator holds 40%', action: 'sell_if_held' };

describe('A-93f cancel while the buy is pending', () => {
  it('FIXBOT-T07 a cancel for a CA whose buy is still pending is persisted and turns into a CANCEL exit when the position opens, also across a restart', async () => {
    const w = makeWorld(tempDir());
    const ca = newCa();
    const requests = openCancelRequests(w.dir, w.clock);
    const api = createExitApi({ store: w.store, engine: w.engine, pendingBuy: c => c === ca, requests, log: () => undefined });
    expect(await api.cancel(ca, 'dec_pending', retro)).toBe('no_position');
    expect(w.sells).toHaveLength(0);

    // the bot restarts; the recovery watcher then opens the position of the pending buy
    const after = openCancelRequests(w.dir, w.clock);
    const p = addPosition(w, { ca });
    expect(applyCancelRequest(w.store, after, p.position_id)).toBe(true);
    expect(w.store.get(p.position_id)).toMatchObject({ cancel_pending: true });
    await w.engine.runPass();
    expect(w.legs().map(l => `${l.leg}:${l.status}:${l.attempt}`)).toEqual(['CANCEL:filled:1']);
    expect(w.closed()[0]).toMatchObject({ reason: 'cancel' });
    expect(after.list()).toEqual([]);                                         // used once

    // a cancel for a CA that has no pending buy records nothing; a later position of that CA is not touched
    const other = newCa();
    expect(await api.cancel(other, 'dec_none', retro)).toBe('no_position');
    const q = addPosition(w, { ca: other });
    expect(applyCancelRequest(w.store, openCancelRequests(w.dir, w.clock), q.position_id)).toBe(false);
    expect(w.store.get(q.position_id)!.cancel_pending).toBe(false);
  });
});
