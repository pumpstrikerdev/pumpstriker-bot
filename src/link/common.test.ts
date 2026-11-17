// R1-B1: the shared pieces of the link modules: the default HTTP (a real round trip to a 127.0.0.1 server on port 0), envelopes and time text.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildEnvelope, defaultHttp, errMessage, hhmm, HttpError, isTimeout, parseJson, trimBase } from './common';
import { fixture, FIXTURE_NOW } from './link-testkit';

let server: http.Server;
let port = 0;
const seen: Array<{ method: string; headers: http.IncomingHttpHeaders; body: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (req.url === '/slow') return;                               // never answers
      if (req.url === '/redirect') { res.writeHead(302, { location: '/ok' }); res.end(); return; }
      if (req.url === '/big') { res.writeHead(200); res.end('x'.repeat(2_000_000)); return; }
      res.writeHead(req.url === '/fail' ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: req.url !== '/fail', echoed: Buffer.concat(chunks).toString('utf8') }));
    });
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => { port = (server.address() as AddressInfo).port; resolve(); }); });
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
});

describe('link common', () => {
  it('defaultHttp sends the headers and body as given and no browser header (the link auth refuses Sec-Fetch-*)', async () => {
    const res = await defaultHttp({ method: 'POST', url: `http://127.0.0.1:${port}/ok`, headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: '{"é":1}', timeoutMs: 2_000 });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, echoed: '{"é":1}' });
    const got = seen.at(-1);
    expect(got?.method).toBe('POST');
    expect(got?.headers.authorization).toBe('Bearer test-token');
    expect(got?.headers['content-length']).toBe(String(Buffer.byteLength('{"é":1}')));
    expect(got?.headers.host).toBe(`127.0.0.1:${port}`);
    expect(Object.keys(got?.headers ?? {}).filter(k => k.startsWith('sec-fetch-') || k === 'origin')).toEqual([]);
    const get = await defaultHttp({ method: 'GET', url: `http://127.0.0.1:${port}/fail`, headers: {}, timeoutMs: 2_000 });
    expect(get.status).toBe(503);
    expect(seen.at(-1)?.method).toBe('GET');
  });

  it('defaultHttp times out on a server that does not answer, reports a refused connection, does not follow redirects and bounds the answer', async () => {
    const slow = await defaultHttp({ method: 'GET', url: `http://127.0.0.1:${port}/slow`, headers: {}, timeoutMs: 80 }).catch((e: unknown) => e);
    expect(slow).toBeInstanceOf(HttpError);
    expect(isTimeout(slow)).toBe(true);
    const closed = await new Promise<number>(resolve => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => { resolve(p); }); }); });
    const refused = await defaultHttp({ method: 'GET', url: `http://127.0.0.1:${closed}/`, headers: {}, timeoutMs: 1_000 }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HttpError);
    expect((refused as HttpError).kind).toBe('network');
    const redirect = await defaultHttp({ method: 'GET', url: `http://127.0.0.1:${port}/redirect`, headers: {}, timeoutMs: 1_000 });
    expect(redirect.status).toBe(302);
    const big = await defaultHttp({ method: 'GET', url: `http://127.0.0.1:${port}/big`, headers: {}, timeoutMs: 5_000 });
    expect(big.body.length).toBeLessThanOrEqual(1_000_000);
    const bad = await defaultHttp({ method: 'GET', url: 'not a url', headers: {}, timeoutMs: 100 }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(HttpError);
  });

  it('builds a bot-to-Engine envelope: attempt 1, emitted now, ids as given', () => {
    const payload = fixture('delivery.buy').payload;
    const env = buildEnvelope('delivery.buy', payload, { eventId: 'EVENTID', signalId: 'dec_1', ca: 'CA1', now: FIXTURE_NOW });
    expect(env).toEqual({ v: 1, type: 'delivery.buy', event_id: 'EVENTID', signal_id: 'dec_1', ca: 'CA1', emitted_at: FIXTURE_NOW, attempt: 1, payload });
  });

  it('formats UTC HH:MM, trims base URLs, parses JSON without throwing and describes errors in one line', () => {
    expect(hhmm(Date.UTC(2026, 9, 18, 3, 7))).toBe('03:07');
    expect(hhmm(Number.NaN)).toBe('--:--');
    expect(trimBase('http://127.0.0.1:9///')).toBe('http://127.0.0.1:9');
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson('{')).toBeUndefined();
    expect(errMessage(new Error('boom'))).toBe('boom');
    expect(errMessage('plain')).toBe('plain');
    expect(errMessage({ a: 1 })).toBe('{"a":1}');
    expect(isTimeout(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isTimeout(new Error('x'))).toBe(false);
  });
});
