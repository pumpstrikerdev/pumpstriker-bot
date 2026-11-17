// TG Bot copy of E\src\shared-tests\link-auth.test.ts (R0-SHIMPL): the same suite over the byte-identical copies of the shared files in src/shared.
// Derived from the Engine file: the property tests and the acceptance ids stay in the Engine file.
// Tests of the link auth (C02 section 4): the cases of the TG Bot's signal-auth test, ported to the shared module and run for two different
// receiver ports. The secret is generated per run (no key-shaped literal in this file). The HTTP part runs an express app on an ephemeral
// 127.0.0.1 port (port 0, loopback only); the Host header is set explicitly to the receiver port under test, which never has to be listened on.
// The TG Bot runs the same suite from B\src\shared-tests\link-auth.test.ts through its byte-identical copy of the shared module.
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LINK_BODY_LIMIT, MIN_SECRET_LEN, checkLinkRequest, linkAuth, linkHeaders, secretUsable, timingSafeEqualStr } from '../shared/link-auth';

const SECRET = crypto.randomBytes(32).toString('base64url');    // 43 chars, generated per run
const SHORT = 'x'.repeat(MIN_SECRET_LEN - 1);
const PORT_A = 41873;                                           // two receiver ports: the verdicts must not depend on the port
const PORT_B = 41874;

type Headers = Record<string, string | string[] | undefined>;
const good = (port: number, over: Headers = {}): Headers => {
  const h: Headers = { host: `localhost:${port}`, authorization: `Bearer ${SECRET}`, 'content-type': 'application/json', ...over };
  for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
  return h;
};

// ---------------------------------------------------------------------------------------------------------------------------------
// the pure check, as a table of cases
// ---------------------------------------------------------------------------------------------------------------------------------

interface PureCase {
  name: string;
  headers: (port: number) => Headers;
  secret?: string | undefined;
  method?: string;
  expect: 'ok' | { status: number; code: string; reason: string };
}
const REFUSE = {
  noSecret: { status: 503, code: 'auth', reason: 'link secret not configured' },
  unauthorized: { status: 401, code: 'auth', reason: 'unauthorized' },
  origin: { status: 403, code: 'auth', reason: 'browser origin refused' },
  secFetch: { status: 403, code: 'auth', reason: 'browser request refused' },
  host: { status: 403, code: 'auth', reason: 'host not allowed' },
  contentType: { status: 415, code: 'invalid', reason: 'content-type must be application/json' },
} as const;

const PURE_CASES: PureCase[] = [
  { name: 'a correct request', headers: p => good(p), expect: 'ok' },
  // 1. the secret is configured, even for an otherwise perfect request
  ...[undefined, '', SHORT, `  ${SHORT}  `, ' '.repeat(40)].map<PureCase>((s, i) => ({ name: `secret not usable #${i}`, headers: p => good(p), secret: s, expect: REFUSE.noSecret })),
  { name: 'a short secret sent by the caller does not help', headers: p => good(p, { authorization: `Bearer ${SHORT}` }), secret: SHORT, expect: REFUSE.noSecret },
  // 4. the bearer
  ...([undefined, '', `Bearer ${crypto.randomBytes(32).toString('base64url')}`, `Bearer ${SECRET.slice(0, 10)}`, `Bearer ${SECRET}x`, `Basic ${SECRET}`, SECRET, 'Bearer '] as Array<string | undefined>)
    .map<PureCase>((a, i) => ({ name: `authorization #${i}`, headers: p => good(p, { authorization: a }), expect: REFUSE.unauthorized })),
  { name: 'case-insensitive scheme', headers: p => good(p, { authorization: `bearer ${SECRET}` }), expect: 'ok' },
  { name: 'surrounding whitespace', headers: p => good(p, { authorization: `Bearer   ${SECRET}  ` }), expect: 'ok' },
  { name: 'the configured secret is trimmed (CRLF)', headers: p => good(p), secret: `${SECRET}\r`, expect: 'ok' },
  { name: 'the configured secret is trimmed (spaces)', headers: p => good(p), secret: ` ${SECRET} `, expect: 'ok' },
  // 2. browser markers, even with a valid secret
  ...['https://evil.example', 'null', 'http://localhost', ''].map<PureCase>((o, i) => ({ name: `origin #${i}`, headers: p => good(p, { origin: o }), expect: REFUSE.origin })),
  ...['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'Sec-Fetch-User'].map<PureCase>(h => ({ name: `${h}`, headers: p => good(p, { [h]: 'cross-site' }), expect: REFUSE.secFetch })),
  // 3. DNS rebinding and non-loopback hosts
  ...([
    (p: number) => `evil.com:${p}`, (p: number) => `192.168.1.5:${p}`, (p: number) => `0.0.0.0:${p}`, () => 'localhost', () => '127.0.0.1',
    (p: number) => `localhost:${p + 1}`, (p: number) => `127.0.0.1.evil.com:${p}`, () => '', (p: number) => `localhost:${p}.evil.com`,
  ]).map<PureCase>((h, i) => ({ name: `host #${i}`, headers: p => good(p, { host: h(p) }), expect: REFUSE.host })),
  { name: 'no host header', headers: p => good(p, { host: undefined }), expect: REFUSE.host },
  { name: 'the other receiver port is not this receiver', headers: p => good(p, { host: `localhost:${p === PORT_A ? PORT_B : PORT_A}` }), expect: REFUSE.host },
  ...[(p: number) => `127.0.0.1:${p}`, (p: number) => `localhost:${p}`, (p: number) => `[::1]:${p}`, (p: number) => `LOCALHOST:${p}`]
    .map<PureCase>((h, i) => ({ name: `loopback host #${i}`, headers: p => good(p, { host: h(p) }), expect: 'ok' })),
  // the order of the checks
  { name: 'a browser origin is refused before the secret is looked at', headers: p => good(p, { origin: 'https://evil.example', authorization: undefined }), expect: REFUSE.origin },
  { name: 'a rebinding host is refused before the secret is looked at', headers: p => good(p, { host: 'evil.com:9', authorization: undefined }), expect: REFUSE.host },
  { name: 'no secret on the receiver beats everything', headers: p => good(p, { origin: 'x', host: 'evil.com:9' }), secret: SHORT, expect: REFUSE.noSecret },
  // 5. JSON only
  ...(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', undefined] as Array<string | undefined>)
    .map<PureCase>((ct, i) => ({ name: `content-type #${i}`, headers: p => good(p, { 'content-type': ct }), expect: REFUSE.contentType })),
  { name: 'application/json with parameters', headers: p => good(p, { 'content-type': 'application/json; charset=utf-8' }), expect: 'ok' },
  { name: 'application/json in any case', headers: p => good(p, { 'content-type': 'Application/JSON' }), expect: 'ok' },
  { name: 'GET skips the content-type check', headers: p => good(p, { 'content-type': undefined }), method: 'GET', expect: 'ok' },
  { name: 'GET still needs the secret', headers: p => good(p, { 'content-type': undefined, authorization: undefined }), method: 'GET', expect: REFUSE.unauthorized },
  // header names and shapes
  { name: 'header names are case-insensitive', headers: p => ({ Host: `127.0.0.1:${p}`, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }), expect: 'ok' },
  { name: 'array values are refused', headers: p => ({ ...good(p), authorization: [`Bearer ${SECRET}`, `Bearer ${SECRET}`] }), expect: REFUSE.unauthorized },
];

function pureVerdicts(port: number): string[] {
  return PURE_CASES.map(c => {
    const r = checkLinkRequest({ headers: c.headers(port), method: c.method ?? 'POST' }, { secret: 'secret' in c ? c.secret : SECRET, receiverPort: port });
    return `${c.name}: ${r.ok ? 'ok' : `${r.status} ${r.code} ${r.reason}`}`;
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the HTTP part
// ---------------------------------------------------------------------------------------------------------------------------------

interface Resp { status: number; contentType: string; json: any }

function send(serverPort: number, urlPath: string, opts: { headers?: Record<string, string>; body?: string; method?: string } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const body = opts.body ?? '';
    const method = opts.method ?? 'POST';
    const headers: Record<string, string> = { ...(method === 'GET' ? {} : { 'content-length': String(Buffer.byteLength(body)) }), ...(opts.headers ?? {}) };
    const req = http.request({ host: '127.0.0.1', port: serverPort, path: urlPath, method, agent: false, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), json });
      });
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : body);
  });
}

let server: http.Server;
let serverPort = 0;

beforeAll(async () => {
  const app = express();
  const mount = (route: string, receiverPort: number, secret: string, maxBodyBytes?: number): void => {
    app.use(route, ...linkAuth({ secret: () => secret, receiverPort, ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }) }));
    app.post(route, (req, res) => { res.json({ ok: true, echoed: req.body }); });
    app.get(route, (_req, res) => { res.json({ ok: true, get: true }); });
  };
  for (const [suffix, port] of [['a', PORT_A], ['b', PORT_B]] as const) {
    mount('/link-' + suffix, port, SECRET);
    mount('/short-' + suffix, port, SHORT);
    mount('/big-' + suffix, port, SECRET, 262144);
  }
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => { serverPort = (server.address() as AddressInfo).port; resolve(); }); });
});
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });

const OK_BODY = JSON.stringify({ hello: 'world', n: 3 });
const hdr = (port: number, over: Record<string, string> = {}): Record<string, string> => ({ host: `127.0.0.1:${port}`, authorization: `Bearer ${SECRET}`, 'content-type': 'application/json', ...over });

interface HttpCase { name: string; route: 'link' | 'short' | 'big'; headers: (port: number) => Record<string, string>; body?: string; method?: string; expect: { status: number; code?: string; ok: boolean } }
const HTTP_CASES: HttpCase[] = [
  { name: 'a valid POST', route: 'link', headers: p => hdr(p), body: OK_BODY, expect: { status: 200, ok: true } },
  { name: 'a valid GET without a content-type', route: 'link', headers: p => { const h = hdr(p); delete h['content-type']; return h; }, method: 'GET', expect: { status: 200, ok: true } },
  { name: 'the receiver secret is short', route: 'short', headers: p => hdr(p, { authorization: `Bearer ${SHORT}` }), body: OK_BODY, expect: { status: 503, code: 'auth', ok: false } },
  { name: 'no authorization', route: 'link', headers: p => { const h = hdr(p); delete h.authorization; return h; }, body: OK_BODY, expect: { status: 401, code: 'auth', ok: false } },
  { name: 'wrong secret', route: 'link', headers: p => hdr(p, { authorization: 'Bearer wrong' }), body: OK_BODY, expect: { status: 401, code: 'auth', ok: false } },
  { name: 'an origin header', route: 'link', headers: p => hdr(p, { origin: 'https://evil.example' }), body: OK_BODY, expect: { status: 403, code: 'auth', ok: false } },
  { name: 'sec-fetch-site', route: 'link', headers: p => hdr(p, { 'sec-fetch-site': 'cross-site' }), body: OK_BODY, expect: { status: 403, code: 'auth', ok: false } },
  { name: 'a rebinding host on the same port', route: 'link', headers: p => hdr(p, { host: `evil.com:${p}` }), body: OK_BODY, expect: { status: 403, code: 'auth', ok: false } },
  { name: 'the other receiver port', route: 'link', headers: p => hdr(p, { host: `127.0.0.1:${p === PORT_A ? PORT_B : PORT_A}` }), body: OK_BODY, expect: { status: 403, code: 'auth', ok: false } },
  { name: 'text/plain', route: 'link', headers: p => hdr(p, { 'content-type': 'text/plain' }), body: OK_BODY, expect: { status: 415, code: 'invalid', ok: false } },
  { name: 'a 33 KB body', route: 'link', headers: p => hdr(p), body: JSON.stringify({ blob: 'x'.repeat(33 * 1024) }), expect: { status: 413, code: 'too_large', ok: false } },
  { name: 'a 100 KB body on the batch limit', route: 'big', headers: p => hdr(p), body: JSON.stringify({ blob: 'x'.repeat(100 * 1024) }), expect: { status: 200, ok: true } },
  { name: 'a 300 KB body above the batch limit', route: 'big', headers: p => hdr(p), body: JSON.stringify({ blob: 'x'.repeat(300 * 1024) }), expect: { status: 413, code: 'too_large', ok: false } },
  { name: 'malformed JSON', route: 'link', headers: p => hdr(p), body: '{"a": 1, b: }', expect: { status: 400, code: 'invalid', ok: false } },
  { name: 'a top-level string (strict parser)', route: 'link', headers: p => hdr(p), body: '"just a string"', expect: { status: 400, code: 'invalid', ok: false } },
];

async function httpVerdicts(receiverPort: number): Promise<string[]> {
  const out: string[] = [];
  for (const c of HTTP_CASES) {
    const route = '/' + c.route + (receiverPort === PORT_A ? '-a' : '-b');
    const r = await send(serverPort, route, { headers: c.headers(receiverPort), body: c.body, method: c.method });
    expect(r.status, `${c.name} (receiver port ${receiverPort})`).toBe(c.expect.status);
    expect(r.contentType, c.name).toMatch(/application\/json/);
    expect(r.json, c.name).toBeTruthy();
    expect(r.json.ok, c.name).toBe(c.expect.ok);
    if (!c.expect.ok) {
      expect(r.json.code, c.name).toBe(c.expect.code);
      expect(typeof r.json.reason, c.name).toBe('string');
      expect(JSON.stringify(r.json), c.name).not.toContain(SECRET);
    }
    out.push(`${c.name}: ${r.status} ${r.json.code ?? ''} ${r.json.reason ?? ''}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------------------------------------------------------------

describe('link auth', () => {
  it('every case of the ported signal-auth suite gives the same verdict for two different receiver ports', async () => {
    // the pure check
    for (const port of [PORT_A, PORT_B]) {
      for (const c of PURE_CASES) {
        const r = checkLinkRequest({ headers: c.headers(port), method: c.method ?? 'POST' }, { secret: 'secret' in c ? c.secret : SECRET, receiverPort: port });
        const want = c.expect === 'ok' ? { ok: true } : { ok: false, ...c.expect };
        expect(r, `${c.name} (receiver port ${port})`).toEqual(want);
      }
    }
    expect(pureVerdicts(PORT_B)).toEqual(pureVerdicts(PORT_A));
    // the express middleware pair
    const viaA = await httpVerdicts(PORT_A);
    const viaB = await httpVerdicts(PORT_B);
    expect(viaB).toEqual(viaA);
    // the strict parser hands the parsed body to the route
    const echoed = await send(serverPort, '/link-a', { headers: hdr(PORT_A), body: OK_BODY });
    expect(echoed.json).toEqual({ ok: true, echoed: { hello: 'world', n: 3 } });
    // a refused request never gets its body parsed: a malformed body with a wrong secret is a 401, not a 400
    const refusedFirst = await send(serverPort, '/link-a', { headers: hdr(PORT_A, { authorization: 'Bearer wrong' }), body: '{"a": 1, b: }' });
    expect(refusedFirst.status).toBe(401);
  });

  it('nothing is printed to the console: neither the secret nor the Authorization header', async () => {
    const captured: string[] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const spies = methods.map(m => vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { captured.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); }));
    try {
      for (const c of PURE_CASES) checkLinkRequest({ headers: c.headers(PORT_A), method: c.method ?? 'POST' }, { secret: 'secret' in c ? c.secret : SECRET, receiverPort: PORT_A });
      linkHeaders(SECRET);
      linkHeaders(SHORT);
      timingSafeEqualStr(SECRET, 'other');
      for (const c of HTTP_CASES) await send(serverPort, '/' + c.route + '-a', { headers: c.headers(PORT_A), body: c.body, method: c.method });
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const text = captured.join('\n');
    expect(captured, 'the module logs nothing at all').toEqual([]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/Bearer\s+\S/);
    expect(text.toLowerCase()).not.toContain('authorization');
  });
});

describe('link auth helpers', () => {
  it('the limits are 32 KB and 32 chars', () => {
    expect(LINK_BODY_LIMIT).toBe(32 * 1024);
    expect(MIN_SECRET_LEN).toBe(32);
  });

  it('secretUsable refuses missing, empty, short and whitespace-padded short secrets and accepts 32 chars', () => {
    expect(secretUsable(undefined)).toBe(false);
    expect(secretUsable('')).toBe(false);
    expect(secretUsable(SHORT)).toBe(false);
    expect(secretUsable(`  ${SHORT}  `)).toBe(false);
    expect(secretUsable(' '.repeat(40))).toBe(false);
    expect(secretUsable('x'.repeat(32))).toBe(true);
    expect(secretUsable(SECRET)).toBe(true);
  });

  it('timingSafeEqualStr compares equal strings true, different ones false, always over 32-byte digests', () => {
    expect(timingSafeEqualStr(SECRET, SECRET)).toBe(true);
    expect(timingSafeEqualStr(SECRET, SECRET.slice(0, -1) + (SECRET.endsWith('A') ? 'B' : 'A'))).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(true);
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    try {
      expect(() => timingSafeEqualStr('a', SECRET)).not.toThrow();
      expect(timingSafeEqualStr(SECRET, SECRET + 'x')).toBe(false);
      expect(timingSafeEqualStr('', SECRET)).toBe(false);
      expect(spy).toHaveBeenCalled();
      for (const call of spy.mock.calls) {
        expect((call[0] as Buffer).length).toBe(32);
        expect((call[1] as Buffer).length).toBe(32);
      }
    } finally {
      spy.mockRestore();
    }
    expect(timingSafeEqualStr(undefined as unknown as string, undefined as unknown as string)).toBe(false);
    expect(timingSafeEqualStr(123 as unknown as string, '123')).toBe(false);
  });

  it('linkHeaders builds the outbound headers and is null for a short secret; the secret is trimmed', () => {
    expect(linkHeaders(SECRET)).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` });
    expect(linkHeaders(`${SECRET}\r\n`)).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` });
    expect(linkHeaders(SHORT)).toBeNull();
    expect(linkHeaders('')).toBeNull();
    // what linkHeaders builds is accepted by the receiver
    const r = checkLinkRequest({ headers: { host: `127.0.0.1:${PORT_A}`, ...Object.fromEntries(Object.entries(linkHeaders(SECRET) ?? {}).map(([k, v]) => [k.toLowerCase(), v])) }, method: 'POST' }, { secret: SECRET, receiverPort: PORT_A });
    expect(r).toEqual({ ok: true });
  });

  it('a refusal never carries the secret and a secret read per request takes effect at once', async () => {
    let current = SECRET;
    const app = express();
    app.use('/x', ...linkAuth({ secret: () => current, receiverPort: PORT_A }));
    app.post('/x', (_req, res) => { res.json({ ok: true }); });
    const s = await new Promise<http.Server>(resolve => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
    try {
      const port = (s.address() as AddressInfo).port;
      expect((await send(port, '/x', { headers: hdr(PORT_A), body: OK_BODY })).status).toBe(200);
      current = SHORT;                                                                        // the secret is rotated away: fail closed at once
      const r = await send(port, '/x', { headers: hdr(PORT_A), body: OK_BODY });
      expect(r.status).toBe(503);
      expect(JSON.stringify(r.json)).not.toContain(SECRET);
    } finally {
      await new Promise<void>(r => s.close(() => r()));
    }
  });
});
