// R1-B1 (B10 section 4): the LATE-banner acceptance test and the send queue's own rules (pacing that never drops, the ops lane, 429 handling, honest failures).
// Telegram is a fake; the clock is a FakeClock. The fake secrets are generated at runtime.
import crypto from 'crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { SignalNew } from '../shared/contract/v1';
import { FakeClock } from '../link/clock';
import { cleanupTempDirs, FakeTelegram, fixture, MemoryOutbox, newCa, newTestUlid, telegram429 } from '../link/link-testkit';
import { signalCard, alertCard, cancelCard, noticeCard } from './cards';
import type { Telegram } from 'telegraf';
import { classifyTelegramError, createSendQueue, TG_PACE_MAX_PER_10MIN, type SendQueueDeps, type TelegramApi } from './send-queue';

afterAll(() => { cleanupTempDirs(); });
const quiet = (): void => undefined;

const sigEvent = fixture('signal.new');
const SIG: SignalNew = sigEvent.payload;
const DECIDED = SIG.decision.decided_at;

function rig(start: number, over: Partial<SendQueueDeps> = {}) {
  const clock = new FakeClock(start);
  const telegram = new FakeTelegram(clock);
  const outbox = new MemoryOutbox();
  const queue = createSendQueue({ clock, telegram, chatId: 'chat-main', ownerChatId: 'chat-owner', outbox, newEventId: newTestUlid, log: quiet, ...over });
  const meta = (kind: 'signal' | 'cancel' | 'alert' | 'ops', ca: string | null = newCa(), extra: Partial<Parameters<typeof queue.enqueue>[1]> = {}): Parameters<typeof queue.enqueue>[1] =>
    ({ kind, signalId: kind === 'ops' ? null : 'dec_test', ca, decidedAt: kind === 'signal' ? DECIDED : null, leg: null, grade: 'A', replyTo: null, ...extra });
  const tgEvents = () => outbox.of('delivery.tg');
  return { clock, telegram, outbox, queue, meta, tgEvents };
}

describe('send queue', () => {
  it('B1-T04 a card sent 31 s after the decision carries the LATE banner and is reported late:true (30 s is not late)', async () => {
    const r = rig(DECIDED + 31_000);
    r.queue.enqueue(signalCard(SIG, newCa(), r.clock.now()), r.meta('signal'));
    await r.clock.settle();
    expect(r.telegram.calls).toHaveLength(1);
    expect(r.telegram.calls[0].text.split('\n')[0]).toBe('⚠ LATE: sent 31 s after the decision');
    expect(r.telegram.calls[0].chatId).toBe('chat-main');
    expect(r.telegram.calls[0].extra).toMatchObject({ parse_mode: 'HTML' });
    const [d] = r.tgEvents();
    expect(d.payload).toMatchObject({ status: 'sent', message_id: r.telegram.calls[0].messageId, kind: 'signal', leg: null, late: true, latency_ms_from_decision: 31_000, error: null });
    expect(d.signal_id).toBe('dec_test');

    const edge = rig(DECIDED + 30_000);
    edge.queue.enqueue(signalCard(SIG, newCa(), edge.clock.now()), edge.meta('signal'));
    await edge.clock.settle();
    expect(edge.telegram.calls[0].text).not.toContain('LATE');
    expect(edge.tgEvents()[0].payload).toMatchObject({ status: 'sent', late: false, latency_ms_from_decision: 30_000 });
  });

  it('re-renders the card at the moment of the real send, so a card held back by a 429 gets the banner it has earned', async () => {
    const r = rig(DECIDED + 10_000);
    r.telegram.script.push({ error: telegram429(40) });
    r.queue.enqueue(signalCard(SIG, newCa(), r.clock.now()), r.meta('signal'));
    await r.clock.settle();
    expect(r.telegram.calls).toHaveLength(1);
    expect(r.telegram.calls[0].text).not.toContain('LATE');       // 10 s after the decision: on time
    await r.clock.advance(39_999);
    expect(r.telegram.calls).toHaveLength(1);
    await r.clock.advance(1);
    expect(r.telegram.calls).toHaveLength(2);
    expect(r.telegram.calls[1].text.split('\n')[0]).toBe('⚠ LATE: sent 50 s after the decision');
    expect(r.tgEvents().map(e => e.payload.status)).toEqual(['retrying_429', 'sent']);
    expect(r.tgEvents()[1].payload.late).toBe(true);
  });

  it('paces signal cards at 8 per 10 minutes: the ninth waits for a free slot and nothing is ever dropped', async () => {
    const r = rig(DECIDED + 1_000);
    expect(TG_PACE_MAX_PER_10MIN).toBe(8);
    for (let i = 0; i < 10; i++) {
      r.queue.enqueue(signalCard(SIG, newCa(), r.clock.now()), r.meta('signal'));
      await r.clock.advance(1_000);                              // the first one goes out at t0, the last at t0 + 9 s
    }
    await r.clock.settle();
    expect(r.telegram.calls).toHaveLength(8);
    expect(r.queue.pending()).toBe(2);
    await r.clock.advance(599_000);                              // t0 + 609 s: the first slot (t0) has been free for 9 s, the second (t0+1s) for 8 s
    expect(r.telegram.calls).toHaveLength(10);
    expect(r.queue.pending()).toBe(0);
    expect(r.tgEvents().filter(e => e.payload.status === 'sent')).toHaveLength(10);
  });

  it('the ops lane, cancel cards and alert cards bypass the pacing and go first; ops goes to the owner chat', async () => {
    const r = rig(DECIDED + 1_000, { paceMaxPer10Min: 1 });
    r.queue.enqueue(signalCard(SIG, newCa(), r.clock.now()), r.meta('signal'));
    await r.clock.settle();
    r.queue.enqueue(signalCard(SIG, newCa(), r.clock.now()), r.meta('signal'));
    r.queue.enqueue(alertCard(fixture('alert.exit').payload, newCa(), 'CREW', r.clock.now()), r.meta('alert', newCa(), { leg: 'TP1' }));
    r.queue.enqueue(cancelCard(fixture('signal.cancel').payload, newCa(), 'CREW', r.clock.now()), r.meta('cancel', newCa(), { leg: 'CANCEL' }));
    r.queue.enqueue(noticeCard('owner notice'), r.meta('ops'));
    await r.clock.settle();
    expect(r.telegram.calls.map(c => c.chatId)).toEqual(['chat-main', 'chat-owner', 'chat-main', 'chat-main']);
    expect(r.telegram.calls[1].text).toBe('owner notice');
    expect(r.telegram.calls[2].text).toContain('CANCEL');
    expect(r.queue.pending()).toBe(1);                           // only the second signal card waits for its slot
    const ops = r.tgEvents().find(e => e.payload.kind === 'ops');
    expect(ops?.signal_id).toBeNull();
    expect(ops?.payload).toMatchObject({ status: 'sent', kind: 'ops', latency_ms_from_decision: null, late: false });
    expect(r.tgEvents().find(e => e.payload.kind === 'cancel')?.payload.leg).toBe('CANCEL');
    expect(r.tgEvents().find(e => e.payload.kind === 'alert')?.payload.leg).toBe('TP1');
  });

  it('a 429 pauses the whole queue for retry_after, is reported once as retrying_429, then the card is sent', async () => {
    const r = rig(DECIDED + 1_000);
    r.telegram.script.push({ error: telegram429(3) });
    r.queue.enqueue(signalCard(SIG, newCa(), r.clock.now()), r.meta('signal'));
    await r.clock.settle();
    const t0 = r.clock.now();
    expect(r.telegram.calls).toHaveLength(1);
    r.queue.notifyOwner('queued behind the pause');
    await r.clock.advance(2_999);
    expect(r.telegram.calls).toHaveLength(1);                    // still paused: even the ops lane honours Telegram's own limit
    await r.clock.advance(1);
    expect(r.telegram.calls.map(c => c.text === 'queued behind the pause')).toEqual([false, true, false]);   // ops lane first, then the held card
    expect(r.telegram.calls[1].at).toBe(t0 + 3_000);
    expect(r.telegram.calls[2].at).toBe(t0 + 3_000);
    expect(r.tgEvents().filter(e => e.payload.kind === 'signal').map(e => e.payload.status)).toEqual(['retrying_429', 'sent']);
  });

  it('a second 429 for the same card pauses again but is not reported again', async () => {
    const r = rig(DECIDED + 1_000);
    r.telegram.script.push({ error: telegram429(1) }, { error: telegram429(2) });
    r.queue.enqueue(signalCard(SIG, newCa(), r.clock.now()), r.meta('signal'));
    await r.clock.advance(1_000);
    expect(r.telegram.calls).toHaveLength(2);
    await r.clock.advance(2_000);
    expect(r.telegram.calls).toHaveLength(3);
    expect(r.tgEvents().map(e => e.payload.status)).toEqual(['retrying_429', 'sent']);
  });

  it('reports a failure other than 429 once, with a redacted reason of at most 200 chars, and drops nothing else', async () => {
    const r = rig(DECIDED + 1_000);
    const token = `${crypto.randomInt(100_000_000, 999_999_999)}:${crypto.randomBytes(26).toString('base64url').slice(0, 35)}`;
    r.telegram.script.push({ error: new Error(`400: Bad Request: chat not found at /bot${token}/sendMessage ${'x'.repeat(400)}`) });
    r.queue.enqueue(signalCard(SIG, newCa(), r.clock.now()), r.meta('signal'));
    r.queue.enqueue(signalCard(SIG, newCa(), r.clock.now()), r.meta('signal'));
    await r.clock.settle();
    const events = r.tgEvents();
    expect(events.map(e => e.payload.status)).toEqual(['failed', 'sent']);
    const err = events[0].payload.error ?? '';
    expect(err.length).toBeGreaterThan(0);
    expect(err.length).toBeLessThanOrEqual(200);
    expect(err).not.toContain(token);
    expect(err).not.toContain(token.split(':')[1]);
    expect(r.queue.pending()).toBe(0);
  });

  it('sends a card as first rendered when rendering it again fails, and a sender that throws synchronously is a failed delivery, not a stuck queue', async () => {
    const r = rig(DECIDED + 1_000);
    const card = signalCard(SIG, newCa(), r.clock.now());
    card.rerender = () => { throw new Error('render exploded'); };
    r.queue.enqueue(card, r.meta('signal'));
    await r.clock.settle();
    expect(r.telegram.calls).toHaveLength(1);
    expect(r.telegram.calls[0].text).toBe(card.text);
    const broken = rig(DECIDED + 1_000);
    // a definitive error (A-93f: a transient one such as 'socket hang up' is retried for ops and cancel cards, see fixbot-send-queue.test.ts)
    broken.telegram.sendMessage = () => { throw new Error('400: Bad Request: chat not found'); };
    broken.queue.enqueue(noticeCard('first'), broken.meta('ops'));
    broken.queue.enqueue(noticeCard('second'), broken.meta('ops'));
    await broken.clock.settle();
    expect(broken.tgEvents().map(e => e.payload.status)).toEqual(['failed', 'failed']);
    expect(broken.queue.pending()).toBe(0);
  });

  it('passes replyTo as a reply and keeps a card in the queue in first-come order within its kind', async () => {
    const r = rig(DECIDED + 1_000);
    r.queue.enqueue(noticeCard('first'), r.meta('ops'));
    r.queue.enqueue(noticeCard('second'), r.meta('ops', null, { replyTo: 55 }));
    await r.clock.settle();
    expect(r.telegram.calls.map(c => c.text)).toEqual(['first', 'second']);
    expect(r.telegram.calls[0].extra.reply_parameters).toBeUndefined();
    expect(r.telegram.calls[1].extra.reply_parameters).toEqual({ message_id: 55, allow_sending_without_reply: true });
  });

  it('classifyTelegramError reads a Telegraf-shaped 429, a bare retry_after, a description and a plain error', () => {
    expect(classifyTelegramError(telegram429(7)).retryAfterS).toBe(7);
    expect(classifyTelegramError({ parameters: { retry_after: 1.2 } }).retryAfterS).toBe(2);
    expect(classifyTelegramError({ code: 429, response: { description: 'Too Many Requests: retry after 9' } }).retryAfterS).toBe(9);
    expect(classifyTelegramError({ error_code: 429 }).retryAfterS).toBe(5);
    expect(classifyTelegramError(new Error('boom'))).toEqual({ retryAfterS: null, message: 'boom', transient: false });
    expect(classifyTelegramError({ response: { error_code: 403, description: 'Forbidden: bot was blocked' } })).toEqual({ retryAfterS: null, message: 'Forbidden: bot was blocked', transient: false });
    expect(classifyTelegramError(undefined).retryAfterS).toBeNull();
  });

  it('accepts Telegraf\'s own telegram client as its sender (type-level check of the wiring)', () => {
    const wiring = (tg: Pick<Telegram, 'sendMessage'>): TelegramApi => tg;
    expect(typeof wiring).toBe('function');
  });
});
