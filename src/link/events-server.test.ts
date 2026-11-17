// R1-B1 (B10 section 4): the receiver's acceptance tests (202 before intake, dedup across a restart, auth cases) and its refusal paths. The server listens on 127.0.0.1 port 0; the Host header is set
// explicitly (the receiver port is the one the OS picked). Secrets are generated per run. The console is captured in the auth test.
import crypto from 'crypto';
import http from 'http';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineToBotEvent } from '../shared/contract/v1';
import { FakeClock } from './clock';
import { createEventsServer, type IntakeContext, type IntakePort, type RunningEventsServer } from './events-server';
import { createInbox } from './inbox';
import { cleanupTempDirs, fixture, FIXTURE_NOW, tempDir, TickClock } from './link-testkit';
import type { WalletLinkHandler } from '../wallet-link/handler';
import { createWalletRouter } from '../wallet-link/routes';

const SECRET = crypto.randomBytes(32).toString('base64url');
const quiet = (): void => undefined;

interface Resp { status: number; json: any }

function send(port: number, opts: { path?: string; method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const method = opts.method ?? 'POST';
    const body = opts.body ?? '';
    const headers: Record<string, string> = {
      host: `127.0.0.1:${port}`, authorization: `Bearer ${SECRET}`, 'content-type': 'application/json',
      ...(method === 'GET' ? {} : { 'content-length': String(Buffer.byteLength(body)) }), ...(opts.headers ?? {}),
    };
    for (const k of Object.keys(headers)) if (headers[k] === '') delete headers[k];
    const req = http.request({ host: '127.0.0.1', port, path: opts.path ?? '/v1/events', method, agent: false, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : body);
  });
}

const open: RunningEventsServer[] = [];
async function start(clock: FakeClock, intake: IntakePort, dir: string, secret: () => string = () => SECRET): Promise<RunningEventsServer> {
  const server = createEventsServer({ secret, port: 0, clock, inbox: createInbox({ dir, clock, log: quiet }), intake, log: quiet });
  const running = await server.listen(0);
  open.push(running);
  return running;
}

afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});
afterAll(() => { cleanupTempDirs(); });

describe('events server', () => {
  let calls: Array<{ ev: EngineToBotEvent; ctx: IntakeContext; calledAt: number }>;
  let clock: TickClock;
  beforeEach(() => { calls = []; clock = new TickClock(FIXTURE_NOW); });

  const recording = (): IntakePort => ({ handle: (ev, ctx) => { calls.push({ ev, ctx, calledAt: clock.now() }); } });

  it('B1-T01 the 202 is sent BEFORE the intake handler is called (order checked by injected Clock stamps)', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const intake: IntakePort = { handle: async (ev, ctx) => { calls.push({ ev, ctx, calledAt: clock.now() }); await gate; } };
    const s = await start(clock, intake, tempDir());
    const ev = fixture('signal.new');

    const res = await send(s.port, { body: JSON.stringify(ev) });
    // the client has its answer while the intake handler is still blocked: the Engine never waits for the bot's work
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ ok: true, event_id: ev.event_id, duplicate: false, received_at: expect.any(Number) });
    for (let i = 0; i < 20 && calls.length === 0; i++) await new Promise<void>(r => { setTimeout(r, 5); });
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.ev.event_id).toBe(ev.event_id);
    expect(c.ctx.receivedAt).toBe(res.json.received_at);
    expect(c.ctx.ackedAt).toBeGreaterThan(c.ctx.receivedAt);        // acked after receipt ...
    expect(c.calledAt).toBeGreaterThan(c.ctx.ackedAt);              // ... and the handler started after the 202 was written
    release();
  });

  it('B1-T02 the same event_id twice (also across a restart) answers duplicate:true and has no side effect', async () => {
    const dir = tempDir();
    const ev = fixture('signal.new');
    let s = await start(clock, recording(), dir);
    const first = await send(s.port, { body: JSON.stringify(ev) });
    expect(first.status).toBe(202);
    expect(first.json.duplicate).toBe(false);
    for (let i = 0; i < 20 && calls.length === 0; i++) await new Promise<void>(r => { setTimeout(r, 5); });
    expect(calls).toHaveLength(1);

    // a retry of the same event (attempt 2, later emitted_at) is a duplicate
    const retry = { ...ev, attempt: 2, emitted_at: ev.emitted_at + 50 };
    const second = await send(s.port, { body: JSON.stringify(retry) });
    expect(second.status).toBe(202);
    expect(second.json).toEqual({ ok: true, event_id: ev.event_id, duplicate: true, received_at: expect.any(Number) });

    // restart: a new server and a new inbox over the same data folder still know the event
    await s.close();
    open.splice(open.indexOf(s), 1);
    calls = [];
    s = await start(clock, recording(), dir);
    const third = await send(s.port, { body: JSON.stringify(ev) });
    expect(third.status).toBe(202);
    expect(third.json.duplicate).toBe(true);
    await new Promise<void>(r => { setTimeout(r, 30); });
    expect(calls, 'a duplicate must not reach intake').toHaveLength(0);
  });

  it('B1-T10 auth cases (the C02 link auth in front of /v1/events): refusals, verdicts and no secret in the console', async () => {
    const logs: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); }));
    try {
      const s = await start(clock, recording(), tempDir());
      const short = await start(clock, recording(), tempDir(), () => 'too-short');
      const body = JSON.stringify(fixture('signal.new'));
      const port = s.port;
      const cases: Array<{ name: string; run: () => Promise<Resp>; status: number; code: string }> = [
        { name: 'browser Origin', run: () => send(port, { body, headers: { origin: 'https://evil.example' } }), status: 403, code: 'auth' },
        { name: 'Sec-Fetch-Site', run: () => send(port, { body, headers: { 'sec-fetch-site': 'cross-site' } }), status: 403, code: 'auth' },
        { name: 'rebinding Host on the right port', run: () => send(port, { body, headers: { host: `evil.example:${port}` } }), status: 403, code: 'auth' },
        { name: 'loopback Host on another port', run: () => send(port, { body, headers: { host: `127.0.0.1:${port + 1}` } }), status: 403, code: 'auth' },
        { name: 'no bearer', run: () => send(port, { body, headers: { authorization: '' } }), status: 401, code: 'auth' },
        { name: 'wrong bearer', run: () => send(port, { body, headers: { authorization: `Bearer ${crypto.randomBytes(32).toString('base64url')}` } }), status: 401, code: 'auth' },
        { name: 'not JSON content type', run: () => send(port, { body, headers: { 'content-type': 'text/plain' } }), status: 415, code: 'invalid' },
        { name: 'body above 32 KB', run: () => send(port, { body: JSON.stringify({ pad: 'x'.repeat(40_000) }) }), status: 413, code: 'too_large' },
        { name: 'invalid JSON', run: () => send(port, { body: '{"v":' }), status: 400, code: 'invalid' },
        { name: 'no secret configured on the receiver', run: () => send(short.port, { body, headers: { authorization: 'Bearer too-short' } }), status: 503, code: 'auth' },
      ];
      for (const c of cases) {
        const r = await c.run();
        expect({ name: c.name, status: r.status, ok: r.json?.ok, code: r.json?.code }, c.name).toEqual({ name: c.name, status: c.status, ok: false, code: c.code });
        expect(typeof r.json?.reason, `${c.name} carries a reason`).toBe('string');
      }
      // a correct request still passes, and none of the refused ones reached intake
      const good = await send(port, { body });
      expect(good.status).toBe(202);
      await new Promise<void>(r => { setTimeout(r, 30); });
      expect(calls).toHaveLength(1);
      // the secret and the Authorization header are never printed
      const printed = logs.join('\n');
      expect(printed).not.toContain(SECRET);
      expect(printed.toLowerCase()).not.toContain('bearer ');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('refuses a malformed event with a Nack body: v=2 is 409, a bad id is 400, a stale emitted_at is 400 clock', async () => {
    const s = await start(clock, recording(), tempDir());
    const ev = fixture('signal.new');
    const v2 = await send(s.port, { body: JSON.stringify({ ...ev, v: 2 }) });
    expect(v2.status).toBe(409);
    expect(v2.json).toMatchObject({ ok: false, code: 'contract_version' });
    const badId = await send(s.port, { body: JSON.stringify({ ...ev, event_id: 'not-a-ulid' }) });
    expect(badId.status).toBe(400);
    expect(badId.json).toMatchObject({ ok: false, code: 'invalid' });
    const stale = await send(s.port, { body: JSON.stringify({ ...ev, emitted_at: FIXTURE_NOW - 700_000 }) });
    expect(stale.status).toBe(400);
    expect(stale.json).toMatchObject({ ok: false, code: 'clock' });
    const botType = await send(s.port, { body: JSON.stringify({ ...ev, type: 'delivery.tg' }) });
    expect(botType.status).toBe(400);
    await new Promise<void>(r => { setTimeout(r, 30); });
    expect(calls).toHaveLength(0);
  });

  it('answers a JSON 404 for the old /signal route and for unknown paths, and 404 for a GET of /v1/events', async () => {
    const s = await start(clock, recording(), tempDir());
    const old = await send(s.port, { path: '/signal', body: '{}' });
    expect(old.status).toBe(404);
    expect(old.json).toMatchObject({ ok: false, code: 'invalid' });
    const unknown = await send(s.port, { path: '/v1/nothing', body: '{}' });
    expect(unknown.status).toBe(404);
    const get = await send(s.port, { method: 'GET' });
    expect(get.status).toBe(404);
  });

  it('WBL-T07 /v1/events behaves exactly as before with the wallet router mounted: the same statuses and bodies for the same requests; /v1/nothing and GET /v1/events stay 404; the wallet paths sit behind the same auth', async () => {
    const ev = fixture('signal.new');
    const walletCalls: string[] = [];
    const stub: WalletLinkHandler = {
      async handle(route) { walletCalls.push(route); return { status: 200, body: { ok: true, via: 'stub' } }; },
      budgetOf: () => 1,
    };
    const cases: Array<{ name: string; req: (port: number) => Promise<Resp> }> = [
      { name: 'a valid event', req: port => send(port, { body: JSON.stringify(ev) }) },
      { name: 'the same event again (duplicate)', req: port => send(port, { body: JSON.stringify({ ...ev, attempt: 2, emitted_at: ev.emitted_at + 50 }) }) },
      { name: 'invalid JSON', req: port => send(port, { body: '{"v":' }) },
      { name: 'v=2', req: port => send(port, { body: JSON.stringify({ ...ev, v: 2, event_id: 'x' }) }) },
      { name: 'wrong bearer', req: port => send(port, { body: JSON.stringify(ev), headers: { authorization: 'Bearer nope' } }) },
      { name: 'not JSON content type', req: port => send(port, { body: JSON.stringify(ev), headers: { 'content-type': 'text/plain' } }) },
      { name: 'body above 32 KB', req: port => send(port, { body: JSON.stringify({ pad: 'x'.repeat(40_000) }) }) },
      { name: 'GET /v1/events', req: port => send(port, { method: 'GET' }) },
      { name: 'POST /v1/nothing', req: port => send(port, { path: '/v1/nothing', body: '{}' }) },
      { name: 'POST /signal', req: port => send(port, { path: '/signal', body: '{}' }) },
      { name: 'GET /v1/wallet/quote (the routes are POST only)', req: port => send(port, { method: 'GET', path: '/v1/wallet/quote' }) },
      { name: 'POST /v1/wallet/nothing', req: port => send(port, { path: '/v1/wallet/nothing', body: '{}' }) },
    ];
    const runAll = async (withWallet: boolean): Promise<{ answers: Array<{ name: string; status: number; json: unknown }>; intake: string[] }> => {
      const clk = new TickClock(FIXTURE_NOW);
      const intake: string[] = [];
      const server = createEventsServer({
        secret: () => SECRET, port: 0, clock: clk, inbox: createInbox({ dir: tempDir(), clock: clk, log: quiet }), intake: { handle: e => { intake.push(e.event_id); } }, log: quiet,
        ...(withWallet ? { wallet: createWalletRouter({ handler: stub }) } : {}),
      });
      const running = await server.listen(0);
      open.push(running);
      const answers: Array<{ name: string; status: number; json: unknown }> = [];
      for (const c of cases) {
        const r = await c.req(running.port);
        answers.push({ name: c.name, status: r.status, json: r.json });
      }
      await new Promise<void>(r => { setTimeout(r, 30); });
      return { answers, intake };
    };
    const without = await runAll(false);
    const withRouter = await runAll(true);
    expect(withRouter.answers).toEqual(without.answers);
    expect(withRouter.intake).toEqual(without.intake);
    expect(without.intake).toEqual([ev.event_id]);
    expect(walletCalls, 'none of the cases above is a POST of a wallet route').toEqual([]);
    // the router really is mounted: a wallet POST with the link credentials reaches it, and the auth refuses everything else before it
    const clk = new TickClock(FIXTURE_NOW);
    const server = createEventsServer({
      secret: () => SECRET, port: 0, clock: clk, inbox: createInbox({ dir: tempDir(), clock: clk, log: quiet }), intake: { handle: () => undefined }, log: quiet,
      wallet: createWalletRouter({ handler: stub }),
    });
    const running = await server.listen(0);
    open.push(running);
    const good = await send(running.port, { path: '/v1/wallet/quote', body: '{}' });
    expect(good).toEqual({ status: 200, json: { ok: true, via: 'stub' } });
    expect(walletCalls).toEqual(['quote']);
    const refused: Array<Record<string, string>> = [{ authorization: 'Bearer nope' }, { origin: 'https://evil.example' }, { host: 'evil.example:' + running.port }, { 'content-type': 'text/plain' }];
    for (const headers of refused) {
      const r = await send(running.port, { path: '/v1/wallet/fill', body: '{}', headers });
      expect(r.status, JSON.stringify(headers)).toBeGreaterThanOrEqual(401);
      expect(r.json?.ok).toBe(false);
    }
    expect(walletCalls, 'a refused request never reaches the wallet handler').toEqual(['quote']);
  });

  it('keeps answering after an intake handler throws', async () => {
    const intake: IntakePort = { handle: () => { throw new Error('boom'); } };
    const s = await start(clock, intake, tempDir());
    const a = fixture('signal.new');
    expect((await send(s.port, { body: JSON.stringify(a) })).status).toBe(202);
    const b = fixture('arms.status');
    expect((await send(s.port, { body: JSON.stringify(b) })).status).toBe(202);
  });
});
