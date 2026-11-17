// R1-B1 (B10 section 4): the Engine dead-man alert and its edges. /health is a scripted HttpFn, the clock a FakeClock, the send queue a
// capture of what the watch asks it to send (kind 'ops').
import { describe, expect, it } from 'vitest';
import type { TgQueue } from '../bot-contracts';
import { FakeClock } from './clock';
import { hhmm, HttpError, type HttpFn } from './common';
import { createEngineWatch, WATCH_DOWN_AFTER_MS, WATCH_INTERVAL_MS } from './engine-watch';
import { FIXTURE_NOW } from './link-testkit';

const quiet = (): void => undefined;
type Meta = Parameters<TgQueue['enqueue']>[1];

function rig() {
  const clock = new FakeClock(FIXTURE_NOW);
  const sent: Array<{ text: string; meta: Meta }> = [];
  const tg: TgQueue = { enqueue: (card, meta) => { sent.push({ text: card.text, meta }); } };
  const health: { mode: 'up' | 'down' | 'bad'; runId: string | null } = { mode: 'up', runId: 'run-1' };
  const requests: Array<{ url: string; method: string; timeoutMs: number }> = [];
  const http: HttpFn = async req => {
    requests.push({ url: req.url, method: req.method, timeoutMs: req.timeoutMs });
    if (health.mode === 'down') throw new HttpError('network', 'connect ECONNREFUSED');
    if (health.mode === 'bad') return { status: 503, body: '{"ok":false}' };
    return { status: 200, body: JSON.stringify({ ok: true, runId: health.runId, serverNow: clock.now() }) };
  };
  const watch = createEngineWatch({ clock, engineUrl: 'http://127.0.0.1:41999/', tg, http, log: quiet });
  return { clock, sent, health, requests, watch };
}

describe('engine watch', () => {
  it('B1-T13 an Engine that stops answering gives exactly one "unreachable" message after 3 min and one recovery message after the restart; a runId change alone gives one restart notice', async () => {
    const r = rig();
    r.watch.start();
    await r.clock.advance(120_000);                                // two minutes of a healthy Engine: nothing to say
    expect(r.sent).toHaveLength(0);
    expect(r.watch.state()).toMatchObject({ up: true, runId: 'run-1', reported: false });

    r.health.mode = 'down';                                        // the Engine is killed (the last 200 was at +120 s, the first miss at +150 s)
    await r.clock.advance(WATCH_DOWN_AFTER_MS - 1);
    expect(r.sent, 'not before three minutes without a 200').toHaveLength(0);
    await r.clock.advance(1);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].text).toBe(`Engine unreachable since ${hhmm(FIXTURE_NOW + 150_000)} UTC`);
    expect(r.sent[0].meta).toEqual({ kind: 'ops', signalId: null, ca: null, decidedAt: null, leg: null, grade: null, replyTo: null });
    await r.clock.advance(600_000);                                // ten more minutes down: still only the one message
    expect(r.sent).toHaveLength(1);

    r.health.mode = 'up';                                          // restarted: a new runId
    r.health.runId = 'run-2';
    await r.clock.advance(WATCH_INTERVAL_MS);
    expect(r.sent).toHaveLength(2);
    const recovered = FIXTURE_NOW + 120_000 + WATCH_DOWN_AFTER_MS + 600_000 + WATCH_INTERVAL_MS;
    expect(r.sent[1].text).toBe(`Engine back at ${hhmm(recovered)} UTC (down ${Math.round((recovered - (FIXTURE_NOW + 150_000)) / 60_000)} min, restarted)`);
    expect(r.sent[1].meta.kind).toBe('ops');
    await r.clock.advance(300_000);
    expect(r.sent, 'one "unreachable" and one recovery, nothing more').toHaveLength(2);

    r.health.runId = 'run-3';                                      // a quick restart that never looked like an outage
    await r.clock.advance(WATCH_INTERVAL_MS);
    expect(r.sent).toHaveLength(3);
    expect(r.sent[2].text).toMatch(/^Engine restarted at \d\d:\d\d UTC$/);
    await r.clock.advance(300_000);
    expect(r.sent).toHaveLength(3);
    await r.watch.stop();
  });

  it('probes GET /health every 30 s with a 1.5 s timeout and no body', async () => {
    const r = rig();
    r.watch.start();
    await r.clock.advance(90_000);
    expect(r.requests.map(q => q.url)).toEqual(Array(4).fill('http://127.0.0.1:41999/health'));
    expect(r.requests.every(q => q.method === 'GET' && q.timeoutMs === 1_500)).toBe(true);
    await r.watch.stop();
    const n = r.requests.length;
    await r.clock.advance(120_000);
    expect(r.requests, 'stop() stops the probing').toHaveLength(n);
  });

  it('an Engine that answers again before three minutes is never reported', async () => {
    const r = rig();
    r.watch.start();
    await r.clock.advance(60_000);
    r.health.mode = 'down';
    await r.clock.advance(150_000);                                // 2.5 minutes down
    r.health.mode = 'up';
    await r.clock.advance(300_000);
    expect(r.sent).toHaveLength(0);
    expect(r.watch.state()).toMatchObject({ up: true, downSince: null, reported: false });
    await r.watch.stop();
  });

  it('an Engine that never answered since the bot started is reported three minutes after the start; a non-200 counts as down', async () => {
    const r = rig();
    r.health.mode = 'bad';
    r.watch.start();
    await r.clock.advance(WATCH_DOWN_AFTER_MS - 1);
    expect(r.sent).toHaveLength(0);
    await r.clock.advance(1);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].text).toBe(`Engine unreachable since ${hhmm(FIXTURE_NOW)} UTC`);
    r.health.mode = 'up';
    await r.clock.advance(WATCH_INTERVAL_MS);
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1].text).toMatch(/^Engine back at \d\d:\d\d UTC \(down 4 min\)$/);   // 3.5 min between the first miss (+0 s) and the next 200 (+210 s); first run id seen: no "restarted"
    await r.watch.stop();
  });

  it('a second outage is reported again, with its own start time', async () => {
    const r = rig();
    r.watch.start();
    await r.clock.advance(60_000);
    for (let round = 0; round < 2; round++) {
      r.health.mode = 'down';
      await r.clock.advance(WATCH_DOWN_AFTER_MS + WATCH_INTERVAL_MS);
      r.health.mode = 'up';
      await r.clock.advance(WATCH_INTERVAL_MS);
    }
    expect(r.sent.map(m => m.text.split(' ').slice(0, 2).join(' '))).toEqual(['Engine unreachable', 'Engine back', 'Engine unreachable', 'Engine back']);
    expect(r.sent[0].text).not.toBe(r.sent[2].text);
    await r.watch.stop();
  });

  it('a health answer without a runId is a 200 but never a restart', async () => {
    const r = rig();
    r.watch.start();
    await r.clock.advance(30_000);
    r.health.runId = null;
    await r.clock.advance(120_000);
    r.health.runId = 'run-1';
    await r.clock.advance(60_000);
    expect(r.sent).toHaveLength(0);
    await r.watch.stop();
  });
});
