// R1-B1 (B10 section 4): the outbox acceptance tests (restart, redaction, poison event, byte-bounded batches) and the rules around them (backoff, 413 split, poison events, dead letters, the separate
// heartbeat, torn writes). The Engine is a scripted HttpFn (FakeEngine), the clock a FakeClock, the data folder a temp dir. Fake secrets and
// signatures are generated at runtime (planner amendment A-20); no secret-shaped literal appears in this file.
import bs58 from 'bs58';
import crypto from 'crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { BotToEngineEvent } from '../shared/contract/v1';
import { validateBotBatch } from '../shared/contract/validate';
import { FakeClock } from './clock';
import type { HttpFn } from './common';
import {
  BATCH_MAX_BYTES, createEngineOutbox, indexFromReason, OUTBOX_DEAD_FILE, OUTBOX_FILE, OUTBOX_OFFSET_FILE, sanitizeEvent, sanitizeHeartbeat, type EngineOutboxDeps, type HeartbeatFields,
} from './engine-outbox';
import { cleanupTempDirs, FakeEngine, fixture, FIXTURE_NOW, newTestUlid, tempDir } from './link-testkit';
import { createUlidFactory } from './ulid';

afterAll(() => { cleanupTempDirs(); });
const quiet = (): void => undefined;
const SECRET = crypto.randomBytes(32).toString('base64url');
const ENGINE_URL = 'http://127.0.0.1:41999';

const hbFields = (): HeartbeatFields => ({
  policy_versions: { EA: 'a1b2c3d4e5f60718' },
  autobuy: { enabled: true, mode: 'dry_run', arm: 'BS', report_id: null, confirmed_at: null, dry_run: true, paused: null },
  caps_used: { hour: 0, day: 1, sol_day: 0.05 }, open_positions: 1, tg_min_grade: 'B', rpc_ok: true,
});

/** A bot event built from a fixture, with its own event id and an optional payload edit. */
function botEvent(name: string, edit: (p: any) => void = () => undefined): BotToEngineEvent {
  const ev = fixture(name);
  ev.event_id = newTestUlid();
  edit(ev.payload);
  return ev as BotToEngineEvent;
}
const leg = (error: string | null = null): BotToEngineEvent => botEvent('exit.leg', p => { p.position_id = `pos_${crypto.randomBytes(4).toString('hex')}`; p.error = error; });

function setup(over: Partial<EngineOutboxDeps> = {}, o: { dir?: string; start?: number; engine?: FakeEngine } = {}) {
  const clock = new FakeClock(o.start ?? FIXTURE_NOW);
  const dir = o.dir ?? tempDir();
  const engine = o.engine ?? new FakeEngine();
  const notices: string[] = [];
  const outbox = createEngineOutbox({
    dir, engineUrl: ENGINE_URL, secret: () => SECRET, clock, newEventId: createUlidFactory(() => clock.now()), http: engine.http,
    notifyOwner: t => { notices.push(t); }, log: quiet, ...over,
  });
  const file = (n: string): string => path.join(dir, n);
  const read = (n: string): string => { try { return fs.readFileSync(file(n), 'utf8'); } catch { return ''; } };
  return { clock, dir, engine, notices, outbox, file, read };
}

describe('engine outbox', () => {
  it('B1-T09 the outbox survives a restart: Engine down for 2 minutes, then every event is delivered once, none lost or duplicated', async () => {
    const a = setup();
    const events = [leg(), leg(), leg(), leg(), leg()];
    a.outbox.append(events[0]);
    a.outbox.append(events[1]);
    expect(await a.outbox.flushNow()).toBe(0);
    expect(a.engine.accepted).toEqual([events[0].event_id, events[1].event_id]);

    a.engine.up = false;                                           // the Engine goes down
    for (const e of events.slice(2)) a.outbox.append(e);
    a.outbox.start();
    await a.clock.advance(120_000);                                // two minutes of backoff
    expect(a.outbox.backlog()).toBe(3);
    expect(a.engine.accepted).toHaveLength(2);
    expect(a.read(OUTBOX_FILE).split('\n').filter(Boolean)).toHaveLength(3);
    await a.outbox.stop();

    // the bot restarts: a new outbox over the same data folder picks the three events up
    const b = setup({}, { dir: a.dir, engine: a.engine, start: FIXTURE_NOW + 120_000 });
    expect(b.outbox.backlog()).toBe(3);
    a.engine.up = true;
    b.outbox.start();
    await b.clock.advance(1_000);
    expect(a.engine.accepted).toEqual(events.map(e => e.event_id));          // each exactly once, in order
    expect(new Set(a.engine.accepted).size).toBe(5);
    expect(b.outbox.backlog()).toBe(0);
    expect(fs.statSync(b.file(OUTBOX_FILE)).size).toBe(0);                    // everything acknowledged: a fresh file
    await b.outbox.stop();
    // a third start finds nothing to resend
    const c = setup({}, { dir: a.dir, engine: a.engine });
    expect(c.outbox.backlog()).toBe(0);
  });

  it('B1-T14 planted secrets in delivery.buy.error, exit.leg.error and contract_violation.detail never reach the outbox file, the Engine or the console; an 88-char signature survives', async () => {
    const logs: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); }));
    try {
      // fake secrets, generated per run
      const uuid = [4, 2, 2, 2, 6].map(n => crypto.randomBytes(n).toString('hex')).join('-');
      const tgSecret = crypto.randomBytes(40).toString('base64url').slice(0, 35);
      const tgToken = `${crypto.randomInt(100_000_000, 999_999_999)}:${tgSecret}`;
      const bytes = Array.from(crypto.randomBytes(64));
      const byteArray = JSON.stringify(bytes);
      const keypair = bs58.encode(Keypair.generate().secretKey);
      const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
      const phrase = words.join(' ');
      const signature = bs58.encode(crypto.randomBytes(64));
      expect(signature.length).toBeGreaterThanOrEqual(86);
      const planted = `All RPCs failed for sendTransaction: https://mainnet.helius-rpc.com/?api-key=${uuid}: 429 ${tgToken} ${byteArray} key ${keypair} note; ${phrase}`;
      const withSig = `sendTransaction failed, signature ${signature} not confirmed`;
      const mk = (text: string): BotToEngineEvent[] => [
        botEvent('delivery.buy', p => { p.error = text; }),
        botEvent('exit.leg', p => { p.error = text; }),
        botEvent('bot.contract_violation', p => { p.detail = text; }),
        botEvent('delivery.tg', p => { p.error = text; p.status = 'failed'; }),
      ];
      const s = setup();
      const bad = mk(planted);
      const good = mk(withSig);
      for (const e of [...bad, ...good]) s.outbox.append(e);

      const onDisk = s.read(OUTBOX_FILE);
      const secrets = [uuid, tgToken, tgSecret, byteArray, bytes.slice(0, 8).join(','), keypair, phrase];
      for (const v of secrets) expect(onDisk, `outbox file must not hold ${v.slice(0, 6)}...`).not.toContain(v);
      expect(onDisk).toContain('429');                             // the rest of the message is kept
      expect(onDisk).toContain(signature);                         // a transaction signature is not a secret
      expect(onDisk.split('\n').filter(Boolean)).toHaveLength(8);

      expect(await s.outbox.flushNow()).toBe(0);
      const sent = s.engine.bodies.join('\n');
      for (const v of secrets) expect(sent, `what the Engine receives must not hold ${v.slice(0, 6)}...`).not.toContain(v);
      expect(sent).toContain(signature);
      const printed = logs.join('\n');
      for (const v of secrets) expect(printed, 'console output').not.toContain(v);
      // the same text still validates at the Engine (redaction first, then the cap)
      for (const body of s.engine.bodies) {
        const verdict = validateBotBatch(JSON.parse(body), FIXTURE_NOW + 1_000);
        expect(verdict.ok).toBe(true);
        if (verdict.ok) for (const e of verdict.events) expect(e.result.ok, e.result.ok ? '' : e.result.reason).toBe(true);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('B1-T15 a batch with a 400 event at index 3: that event is dead-lettered, events 0-2 and 4+ are delivered, the heartbeat keeps arriving', async () => {
    const s = setup({ heartbeat: hbFields });
    const events = Array.from({ length: 8 }, () => leg());
    s.engine.poison.set(events[3].event_id, 'index400');
    for (const e of events) s.outbox.append(e);
    s.outbox.start();
    await s.clock.advance(1_000);

    expect(s.engine.accepted).toEqual(events.filter((_, i) => i !== 3).map(e => e.event_id));
    const statuses = s.engine.posts.filter(p => !p.types.includes('bot.heartbeat')).map(p => p.status);
    expect(statuses).toEqual([400, 202]);                          // the rest of the batch was resent at once
    expect(s.outbox.backlog()).toBe(0);
    expect(s.outbox.deadLettered()).toEqual({ count: 1, lastCode: 'invalid' });
    const dead = s.read(OUTBOX_DEAD_FILE).split('\n').filter(Boolean).map(l => JSON.parse(l) as { code: string; reason: string; event: { event_id: string } });
    expect(dead).toHaveLength(1);
    expect(dead[0].event.event_id).toBe(events[3].event_id);
    expect(dead[0].code).toBe('invalid');
    expect(dead[0].reason).toContain('event 3');
    expect(s.notices).toHaveLength(1);                             // one owner alert for the code
    expect(s.notices[0]).toContain('invalid');

    await s.clock.advance(15_000);
    expect(s.engine.heartbeats.length).toBeGreaterThanOrEqual(2);  // at start and every 15 s, outside the outbox
    const hb = s.engine.heartbeats.at(-1) as { type: string; payload: { dead_lettered: number; dead_last_code: string | null; outbox_backlog: number; contract_v: number } };
    expect(hb.type).toBe('bot.heartbeat');
    expect(hb.payload).toMatchObject({ dead_lettered: 1, dead_last_code: 'invalid', outbox_backlog: 0, contract_v: 1 });
    // a second poison event of the same code within the hour does not alert the owner again
    const another = leg();
    s.engine.poison.set(another.event_id, 'index400');
    s.outbox.append(another);
    await s.clock.advance(2_000);
    expect(s.outbox.deadLettered().count).toBe(2);
    expect(s.notices).toHaveLength(1);
    await s.outbox.stop();
  });

  it('B1-T16 50 exit.leg events larger than 32 KB are split by bytes (at most 24 KB per POST) and all delivered', async () => {
    const s = setup();
    const events = Array.from({ length: 50 }, () => leg('x'.repeat(190) + 'end'));
    for (const e of events) s.outbox.append(e);
    const total = s.read(OUTBOX_FILE).length;
    expect(total).toBeGreaterThan(32 * 1024);
    expect(await s.outbox.flushNow()).toBe(0);

    const posts = s.engine.posts.filter(p => p.status === 202);
    expect(posts.length).toBeGreaterThanOrEqual(2);
    for (const p of posts) {
      expect(p.bytes).toBeLessThanOrEqual(BATCH_MAX_BYTES);
      expect(p.ids.length).toBeLessThanOrEqual(50);
    }
    expect(posts.reduce((n, p) => n + p.ids.length, 0)).toBe(50);
    expect(s.engine.accepted).toEqual(events.map(e => e.event_id));          // in order, each once
    expect(s.outbox.deadLettered().count).toBe(0);
    // every POST is a valid bot batch for the Engine's own validator
    for (const body of s.engine.bodies) {
      const verdict = validateBotBatch(JSON.parse(body), FIXTURE_NOW + 1_000);
      expect(verdict.ok && verdict.events.every(e => e.result.ok)).toBe(true);
    }
  });

  it('caps the batch at 50 events', async () => {
    const s = setup();
    for (let i = 0; i < 120; i++) s.outbox.append(botEvent('position.closed'));
    expect(await s.outbox.flushNow()).toBe(0);
    expect(s.engine.posts.map(p => p.ids.length)).toEqual([50, 50, 20]);
  });

  it('backs off 0.5 s doubling up to 30 s while the Engine refuses or is down, never dead-letters for it, and resets after success', async () => {
    const engine = new FakeEngine();
    const times: number[] = [];
    let clockRef!: FakeClock;
    const s = setup({ http: async req => { times.push(clockRef.now() - FIXTURE_NOW); return engine.http(req); } }, { engine });
    clockRef = s.clock;
    engine.up = false;
    s.outbox.append(leg());
    s.outbox.start();
    await s.clock.advance(100_000);
    // the 0.5 s tick, then waits of 0.5, 1, 2, 4, 8, 16 and 30, 30 s
    expect(times.slice(0, 9)).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 62_000, 92_000]);
    expect(s.outbox.deadLettered().count).toBe(0);

    engine.up = true;
    engine.status = 503;                                           // reachable but refusing: still the link, not the event
    await s.clock.advance(30_000);
    expect(s.outbox.backlog()).toBe(1);
    expect(s.outbox.deadLettered().count).toBe(0);
    engine.status = null;
    await s.clock.advance(30_000);
    expect(s.outbox.backlog()).toBe(0);

    // after the success the waiting starts at 0.5 s again
    times.length = 0;
    engine.up = false;
    s.outbox.append(leg());
    const before = s.clock.now();
    await s.clock.advance(10_000);
    expect(times.slice(0, 3).map(x => x + FIXTURE_NOW - before)).toEqual([500, 1_000, 2_000]);
    await s.outbox.stop();
  });

  it('a 400 without an index halves the batch until the bad event is alone, then dead-letters only it', async () => {
    const s = setup();
    const events = Array.from({ length: 6 }, () => leg());
    s.engine.poison.set(events[4].event_id, 'plain400');
    for (const e of events) s.outbox.append(e);
    s.outbox.start();
    await s.clock.advance(5_000);
    expect(s.engine.accepted.sort()).toEqual(events.filter((_, i) => i !== 4).map(e => e.event_id).sort());
    expect(s.outbox.deadLettered()).toEqual({ count: 1, lastCode: 'invalid' });
    expect(JSON.parse(s.read(OUTBOX_DEAD_FILE).trim()).event.event_id).toBe(events[4].event_id);
    expect(s.outbox.backlog()).toBe(0);
    await s.outbox.stop();
  });

  it('a 202 with a per-event reject dead-letters that event with the Engine\'s code; the others are acknowledged', async () => {
    const s = setup();
    const events = Array.from({ length: 5 }, () => leg());
    s.engine.poison.set(events[2].event_id, 'results202');
    for (const e of events) s.outbox.append(e);
    expect(await s.outbox.flushNow()).toBe(0);
    expect(s.engine.accepted).toEqual(events.filter((_, i) => i !== 2).map(e => e.event_id));
    expect(s.outbox.deadLettered()).toEqual({ count: 1, lastCode: 'invalid' });
    expect(s.engine.posts).toHaveLength(1);
  });

  it('a 413 halves the batch; a single event that is still too large is dead-lettered', async () => {
    const s = setup();
    const events = Array.from({ length: 8 }, () => leg('y'.repeat(150)));
    for (const e of events) s.outbox.append(e);
    s.engine.maxBytes = 3_000;                                     // about three events fit
    expect(await s.outbox.flushNow()).toBe(0);
    expect(s.engine.accepted).toEqual(events.map(e => e.event_id));
    expect(s.engine.posts.filter(p => p.status === 413).length).toBeGreaterThanOrEqual(1);
    expect(s.outbox.deadLettered().count).toBe(0);

    const t = setup();
    t.engine.maxBytes = 100;                                       // not even one event fits
    t.outbox.append(leg());
    expect(await t.outbox.flushNow()).toBe(0);
    expect(t.outbox.deadLettered()).toEqual({ count: 1, lastCode: 'too_large' });
  });

  it('a 500 is retried with backoff and the head event is dead-lettered after five attempts; the rest goes through', async () => {
    const s = setup();
    const events = [leg(), leg(), leg()];
    s.engine.poison.set(events[0].event_id, 'status500');
    for (const e of events) s.outbox.append(e);
    s.outbox.start();
    await s.clock.advance(7_999);                                  // attempts at 0.5, 1, 2 and 4 s
    expect(s.engine.posts.filter(p => p.status === 500)).toHaveLength(4);
    expect(s.outbox.deadLettered().count).toBe(0);
    await s.clock.advance(1);                                      // the fifth attempt, at 8 s
    expect(s.outbox.deadLettered()).toEqual({ count: 1, lastCode: 'engine_500' });
    expect(s.engine.accepted).toEqual([events[1].event_id, events[2].event_id]);
    expect(s.outbox.backlog()).toBe(0);
    await s.outbox.stop();
  });

  it('a 409 without an event index is a link problem: backoff, one owner alert, nothing dead-lettered', async () => {
    const s = setup({ http: async () => ({ status: 409, body: JSON.stringify({ ok: false, code: 'contract_version', reason: 'contract version not supported; supported:[1]' }) }) });
    s.outbox.append(leg());
    s.outbox.start();
    await s.clock.advance(60_000);
    expect(s.outbox.backlog()).toBe(1);
    expect(s.outbox.deadLettered().count).toBe(0);
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toContain('contract version');
    await s.outbox.stop();
  });

  it('a heartbeat is a separate POST that keeps arriving while the outbox is blocked, and carries the backlog', async () => {
    const s = setup({ heartbeat: hbFields });
    s.engine.blockEventBatches = true;
    for (let i = 0; i < 3; i++) s.outbox.append(leg());
    s.outbox.start();
    await s.clock.advance(60_000);
    expect(s.engine.heartbeats).toHaveLength(5);                   // 0, 15, 30, 45, 60 s
    expect(s.outbox.backlog()).toBe(3);
    expect((s.engine.heartbeats.at(-1) as { payload: { outbox_backlog: number } }).payload.outbox_backlog).toBe(3);
    const beats = s.engine.posts.filter(p => p.types.includes('bot.heartbeat'));
    expect(beats.every(p => p.ids.length === 1 && p.status === 202)).toBe(true);
    // heartbeat events are never written to the outbox file
    expect(s.read(OUTBOX_FILE)).not.toContain('bot.heartbeat');
    await s.outbox.stop();
  });

  it('RDB-T03 the Engine validator parses the heartbeat with the A-110 fields (the RDA-T01 shape), and an old Engine ignores them: the rest of the heartbeat is the same with or without them', async () => {
    const wallet = { wallet_id: 'w1', address: Keypair.generate().publicKey.toBase58(), lamports: '2500000000', read_at: FIXTURE_NOW - 4_000, slot: 250_000_123 };
    const NEW = ['bot_username', 'bot_wallet', 'rpc_provider'] as const;
    const withNew = (): HeartbeatFields => ({ ...hbFields(), bot_username: 'PumpstrikerTest_bot', bot_wallet: wallet, rpc_provider: 'helius' });
    const fresh = setup({ heartbeat: withNew });          // a bot that reports the three fields
    const old = setup({ heartbeat: hbFields });           // an old bot: none of them
    await fresh.outbox.sendHeartbeat();
    await old.outbox.sendHeartbeat();
    const sentOld = old.engine.heartbeats[0] as { payload: Record<string, unknown> };
    const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

    // the Engine's validator (the byte-identical copy of the bot) keeps all three, with no warning
    const parse = (ev: unknown, now: number) => {
      const batch = validateBotBatch({ events: [ev] }, now);
      if (!batch.ok) throw new Error(`the batch was refused: ${batch.reason}`);
      const result = batch.events[0]!.result;
      if (!result.ok) throw new Error(`the heartbeat was refused: ${result.reason}`);
      return { result, hb: result.value.payload as unknown as Record<string, unknown> };
    };
    const got = parse(fresh.engine.heartbeats[0], fresh.clock.now());
    expect(got.hb.bot_username).toBe('PumpstrikerTest_bot');
    expect(got.hb.bot_wallet).toEqual(wallet);
    expect(got.hb.rpc_provider).toBe('helius');
    expect(has(got.result, 'warnings'), 'no field was malformed').toBe(false);

    // an old bot sends none of the keys, and the validator leaves them absent (RDA-T01)
    for (const k of NEW) expect(has(sentOld.payload, k), `old bot: ${k} not sent`).toBe(false);
    const gotOld = parse(old.engine.heartbeats[0], old.clock.now());
    for (const k of NEW) expect(has(gotOld.hb, k), `old bot: ${k} stays absent`).toBe(false);
    expect(has(gotOld.result, 'warnings')).toBe(false);

    // an old Engine reads only the keys it knows: dropping the three keys from what the new bot sent leaves exactly what the old bot sent
    const stripped = Object.fromEntries(Object.entries(got.hb).filter(([k]) => !(NEW as readonly string[]).includes(k)));
    expect(stripped).toEqual(gotOld.hb);
  });

  it('a heartbeat source that hands in a URL, a keyed string or a malformed value for the A-110 fields sends null for those fields only, never the value', async () => {
    const key = crypto.randomUUID();
    const hostile = (): HeartbeatFields => ({
      ...hbFields(), bot_username: '@not a name/', rpc_provider: `https://mainnet.helius-rpc.com/?api-key=${key}`,
      bot_wallet: { wallet_id: 'w1', address: 'not an address', lamports: '1.5', read_at: -1, slot: 1.5 } as unknown as NonNullable<HeartbeatFields['bot_wallet']>,
    });
    const s = setup({ heartbeat: hostile });
    await s.outbox.sendHeartbeat();
    const payload = (s.engine.heartbeats[0] as { payload: Record<string, unknown> }).payload;
    expect([payload.bot_username, payload.bot_wallet, payload.rpc_provider]).toEqual([null, null, null]);
    expect(payload.open_positions, 'the rest of the heartbeat is kept').toBe(1);
    expect(payload.tg_min_grade).toBe('B');
    expect(s.engine.bodies.join('')).not.toContain(key);
    expect(s.engine.bodies.join('')).not.toMatch(/https?:|api-key/i);

    // a label that redaction would change (a bearer token) is refused too; a valid label passes
    const bearer = setup({ heartbeat: () => ({ ...hbFields(), rpc_provider: `Bearer ${crypto.randomBytes(16).toString('hex')}` }) });
    await bearer.outbox.sendHeartbeat();
    expect((bearer.engine.heartbeats[0] as { payload: Record<string, unknown> }).payload.rpc_provider).toBeNull();
    const ok = setup({ heartbeat: () => ({ ...hbFields(), rpc_provider: 'public', bot_username: null, bot_wallet: null }) });
    await ok.outbox.sendHeartbeat();
    const okPayload = (ok.engine.heartbeats[0] as { payload: Record<string, unknown> }).payload;
    expect([okPayload.rpc_provider, okPayload.bot_username, okPayload.bot_wallet]).toEqual(['public', null, null]);
  });

  it('sanitizeHeartbeat returns a valid heartbeat as it is, and one the validator refuses for another reason unchanged', () => {
    const now = FIXTURE_NOW;
    const eventId = newTestUlid();
    const good = { at: now, contract_v: 1 as const, ...hbFields(), outbox_backlog: 0, dead_lettered: 0, dead_last_code: null, rpc_provider: 'primary' };
    const same = sanitizeHeartbeat(good, eventId, now);
    expect(same.hb).toBe(good);
    expect(same.nulled).toEqual([]);
    // a bad contract_v is refused by the validator for its own reason: nothing is touched, nothing thrown
    const odd = { ...good, contract_v: 2 as unknown as 1, rpc_provider: 'http://x' };
    const unchanged = sanitizeHeartbeat(odd, eventId, now);
    expect(unchanged.hb).toBe(odd);
    expect(unchanged.nulled).toEqual([]);
    // an event id that is no ULID makes the probe fail for its own reason as well
    expect(sanitizeHeartbeat({ ...good, rpc_provider: 'http://x' }, 'not-a-ulid', now).nulled).toEqual([]);
  });

  it('records the acknowledged offset: a restart does not resend what the Engine already answered', async () => {
    const answered: string[] = [];
    let calls = 0;
    const http: HttpFn = async req => {
      if (++calls > 1) throw new Error('offline');                 // the Engine answers once, then goes away
      const events = (JSON.parse(req.body ?? '{}') as { events: Array<{ event_id: string }> }).events;
      const first = events.slice(0, 2);                           // the Engine answers only the first two events of the batch
      answered.push(...first.map(e => e.event_id));
      return { status: 202, body: JSON.stringify({ ok: true, results: first.map(e => ({ ok: true, event_id: e.event_id, duplicate: false, received_at: 0 })) }) };
    };
    const a = setup({ http });
    const events = [leg(), leg(), leg()];
    for (const e of events) a.outbox.append(e);
    a.outbox.start();
    await a.clock.advance(600);
    await a.outbox.stop();
    expect(a.outbox.backlog()).toBe(1);
    expect(Number(a.read(OUTBOX_OFFSET_FILE))).toBeGreaterThan(0);
    const b = setup({}, { dir: a.dir });
    expect(b.outbox.backlog()).toBe(1);
    expect(await b.outbox.flushNow()).toBe(0);
    expect(b.engine.accepted).toEqual([events[2].event_id]);
    expect(answered.slice(0, 2)).toEqual([events[0].event_id, events[1].event_id]);
  });

  it('drops a torn last line on restart and dead-letters an unreadable one as corrupt', () => {
    const dir = tempDir();
    const e1 = leg();
    const e2 = leg();
    const torn = JSON.stringify(leg()).slice(0, 120);
    fs.writeFileSync(path.join(dir, OUTBOX_FILE), `${JSON.stringify(e1)}\nthis is not json\n${JSON.stringify(e2)}\n${torn}`);
    const s = setup({}, { dir });
    expect(s.outbox.backlog()).toBe(2);
    expect(s.outbox.deadLettered()).toEqual({ count: 1, lastCode: 'corrupt' });
    expect(fs.readFileSync(path.join(dir, OUTBOX_FILE), 'utf8').endsWith('\n')).toBe(true);
    s.outbox.append(leg());
    const lines = fs.readFileSync(path.join(dir, OUTBOX_FILE), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(4);                                 // e1, the unreadable line, e2, the new event: the torn tail is gone
    expect(lines.every((l, i) => i === 1 || (JSON.parse(l) as { v: number }).v === 1)).toBe(true);
  });

  it('sanitizeEvent redacts and caps only the four free-text fields and leaves every other event untouched', () => {
    const long = 'z'.repeat(500);
    expect((sanitizeEvent(botEvent('delivery.buy', p => { p.error = long; })).payload as { error: string }).error).toHaveLength(200);
    expect((sanitizeEvent(botEvent('bot.contract_violation', p => { p.detail = long; })).payload as { detail: string }).detail).toHaveLength(300);
    expect((sanitizeEvent(botEvent('exit.leg', p => { p.error = null; })).payload as { error: string | null }).error).toBeNull();
    const closed = botEvent('position.closed');
    expect(sanitizeEvent(closed)).toBe(closed);
    const again = sanitizeEvent(botEvent('delivery.tg', p => { p.error = 'a *b* c'; }));
    expect(sanitizeEvent(again)).toEqual(again);                  // idempotent
  });

  it('indexFromReason reads the event index out of a 400 reason, within the batch only', () => {
    expect(indexFromReason('event 3: payload.leg is not a known leg', 8)).toBe(3);
    expect(indexFromReason('events[5].payload invalid', 8)).toBe(5);
    expect(indexFromReason('index 2', 8)).toBe(2);
    expect(indexFromReason('bad value at [4]', 8)).toBeNull();
    expect(indexFromReason('contract version not supported; supported:[1]', 8)).toBeNull();
    expect(indexFromReason('event 9: nope', 8)).toBeNull();
    expect(indexFromReason('a payload is invalid', 8)).toBeNull();
    expect(indexFromReason(undefined, 8)).toBeNull();
  });
});
