/**
 * A-93f FIXBOT-T05: a transient Telegram error (5xx, FetchError, ECONNRESET, socket hang up) no longer drops an ops or cancel card: it
 * stays queued with a backoff and goes out when Telegram answers again; a definitive 4xx still fails at once, signal cards keep the old
 * rule, and an ops card that cannot be sent for an hour is finally reported failed. FakeClock and a fake Telegram only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { FakeClock } from '../link/clock';
import { cleanupTempDirs, FakeTelegram, fixture, MemoryOutbox, newCa, newTestUlid } from '../link/link-testkit';
import type { SignalNew } from '../shared/contract/v1';
import { cancelCard, noticeCard, signalCard } from './cards';
import { createSendQueue } from './send-queue';

afterAll(() => { cleanupTempDirs(); });

const SIG: SignalNew = fixture('signal.new').payload;
const tg5xx = (code: number): Error => Object.assign(new Error(`${code}: Bad Gateway`), { response: { ok: false, error_code: code, description: 'Bad Gateway' }, code });
const fetchErr = (): Error => Object.assign(new Error('request to the Telegram API failed, reason: socket hang up'), { name: 'FetchError', code: 'ECONNRESET' });
const tg400 = (): Error => Object.assign(new Error('400: Bad Request: chat not found'), { response: { ok: false, error_code: 400, description: 'Bad Request: chat not found' }, code: 400 });

function rig() {
  const clock = new FakeClock(SIG.decision.decided_at + 1_000);
  const telegram = new FakeTelegram(clock);
  const outbox = new MemoryOutbox();
  const queue = createSendQueue({ clock, telegram, chatId: 'chat-main', ownerChatId: 'chat-owner', outbox, newEventId: newTestUlid, log: () => undefined });
  const statuses = (): string[] => outbox.of('delivery.tg').map(e => `${e.payload.kind}:${e.payload.status}`);
  return { clock, telegram, outbox, queue, statuses };
}
const meta = (kind: 'signal' | 'cancel' | 'ops') => ({ kind, signalId: kind === 'ops' ? null : 'dec_test', ca: newCa(), decidedAt: null, leg: null, grade: 'A' as const, replyTo: null });

describe('A-93f send queue', () => {
  it('FIXBOT-T05 an ops or cancel card survives a 5xx or a dropped connection and is sent once Telegram answers; a 4xx fails at once, signal cards keep the old rule, and an hour of failures ends the retry', async () => {
    const r = rig();
    r.telegram.script.push({ error: tg5xx(502) }, { error: fetchErr() });
    r.queue.notifyOwner('auto-exit is OFF for this position. Sell it by hand now');
    await r.clock.settle();
    expect(r.queue.pending()).toBe(1);                                        // kept, not dropped
    expect(r.statuses()).toEqual([]);
    await r.clock.advance(2_000);
    await r.clock.advance(4_000);
    expect(r.telegram.calls.map(c => c.chatId)).toEqual(['chat-owner', 'chat-owner', 'chat-owner']);
    expect(r.statuses()).toEqual(['ops:sent']);
    expect(r.queue.pending()).toBe(0);

    // a cancel card after a 503
    r.telegram.script.push({ error: tg5xx(503) });
    r.queue.enqueue(cancelCard({ reason: 'retro_kill', kills: ['K9'], detected_at: 1, detail: 'x', action: 'sell_if_held' }, newCa(), null, r.clock.now(), 30_000), meta('cancel'));
    await r.clock.settle();
    await r.clock.advance(2_000);
    expect(r.statuses()).toEqual(['ops:sent', 'cancel:sent']);

    // a definitive 4xx on ops is still reported failed at once; a signal card on a 5xx keeps the old rule (one failure, no retry)
    r.telegram.script.push({ error: tg400() }, { error: tg5xx(502) });
    r.queue.notifyOwner('second');
    r.queue.enqueue(signalCard(SIG, newCa(), r.clock.now()), meta('signal'));
    await r.clock.settle();
    expect(r.statuses()).toEqual(['ops:sent', 'cancel:sent', 'ops:failed', 'signal:failed']);
    expect(r.queue.pending()).toBe(0);

    // an ops card that cannot get through for an hour is finally reported failed (nothing is held forever)
    const z = rig();
    z.telegram.sendMessage = async () => { throw fetchErr(); };
    z.queue.notifyOwner(noticeCard('x').text);
    await z.clock.settle();
    for (let i = 0; i < 70; i++) await z.clock.advance(60_000);
    expect(z.statuses()).toEqual(['ops:failed']);
    expect(z.queue.pending()).toBe(0);
  });
});
