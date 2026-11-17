// R1-B1 (B10 section 3 rule 5): the bot's GETs to the Engine. A scripted HttpFn covers every answer and error; one case runs against a real
// express app behind the shared link auth on 127.0.0.1 port 0 (so the real headers and the real fetch are exercised end to end).
import crypto from 'crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { linkAuth } from '../shared/link-auth';
import { HttpError, type HttpFn, type HttpRequest } from './common';
import { createEngineClient } from './engine-client';
import { fixture } from './link-testkit';

const SECRET = crypto.randomBytes(32).toString('base64url');
const CA = fixture<{ ca: string }>('token-proxy-response').ca;
const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });

function client(answer: (req: HttpRequest) => ReturnType<HttpFn>, secret: () => string = () => SECRET) {
  const requests: HttpRequest[] = [];
  const c = createEngineClient({ engineUrl: 'http://127.0.0.1:41999/', secret, http: async req => { requests.push(req); return answer(req); } });
  return { c, requests };
}

const armsBody = (): unknown => ({ ok: true, arms: fixture('arms.status').payload.arms });
const priceBody = (): unknown => ({ ok: true, price: { value: 0.00003, src: 'gmgn.token_info', as_of: 1790003999000 }, frozen: false, drained: false });

describe('engine client', () => {
  it('GETs arms, token and price with the link headers and a 1.5 s timeout', async () => {
    const { c, requests } = client(req => {
      if (req.url.endsWith('/arms')) return Promise.resolve(json(200, armsBody()));
      if (req.url.includes('/token/')) return Promise.resolve(json(200, fixture('token-proxy-response')));
      return Promise.resolve(json(200, priceBody()));
    });
    const arms = await c.arms();
    expect('error' in arms).toBe(false);
    expect('arms' in arms && arms.arms.map(a => [a.arm, a.verdict])).toEqual([['BS', 'PASS'], ['B0', 'INSUFFICIENT'], ['B1', 'INSUFFICIENT'], ['B2', 'INSUFFICIENT']]);
    const token = await c.token(CA);
    expect('ok' in token && token.ok && token.fields.price_usd).toEqual({ value: 0.00003, src: 'gmgn.token_info', as_of: 1790003999000 });
    expect('ok' in token && token.ok && token.fields.top10_rate).toEqual({ value: null, src: null, as_of: null });   // a null stays null
    const price = await c.price(CA);
    expect(price).toEqual({ price: { value: 0.00003, src: 'gmgn.token_info', as_of: 1790003999000 }, frozen: false, drained: false });

    expect(requests.map(r => r.url)).toEqual([
      'http://127.0.0.1:41999/api/bot/v1/arms', `http://127.0.0.1:41999/api/bot/v1/token/${CA}`, `http://127.0.0.1:41999/api/bot/v1/price/${CA}`,
    ]);
    for (const r of requests) {
      expect(r.method).toBe('GET');
      expect(r.timeoutMs).toBe(1_500);
      expect(r.headers.Authorization).toBe(`Bearer ${SECRET}`);
    }
  });

  it('returns a typed error, never a default value, when the Engine is offline, slow, refusing or answering nonsense', async () => {
    const cases: Array<[string, () => ReturnType<HttpFn>, string]> = [
      ['offline', () => Promise.reject(new HttpError('network', 'connect ECONNREFUSED')), 'engine_offline'],
      ['timeout', () => Promise.reject(new HttpError('timeout', 'request timed out')), 'timeout'],
      ['fetch AbortError', () => Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })), 'timeout'],
      ['bad bearer', () => Promise.resolve(json(401, { ok: false, code: 'auth', reason: 'unauthorized' })), 'auth'],
      ['budget refusal', () => Promise.resolve(json(429, { ok: false, code: 'budget', retry_after_s: 12 })), 'budget'],
      ['server error without a body', () => Promise.resolve({ status: 500, body: 'oops' }), 'http_500'],
      ['not JSON', () => Promise.resolve({ status: 200, body: '<html>' }), 'invalid_response'],
    ];
    for (const [name, answer, error] of cases) {
      const { c } = client(answer);
      expect(await c.arms(), `arms: ${name}`).toEqual({ error });
      expect(await c.token(CA), `token: ${name}`).toEqual({ error });
      expect(await c.price(CA), `price: ${name}`).toEqual({ error });
    }
  });

  it('rejects an answer that breaks its contract: a Sourced price with a value but no time, a field that is not a ProxyFieldKey, an unknown verdict', async () => {
    const bad = client(req => {
      if (req.url.endsWith('/arms')) return Promise.resolve(json(200, { ok: true, arms: [{ arm: 'BS', verdict: 'GREAT' }] }));
      if (req.url.includes('/token/')) { const t = fixture('token-proxy-response'); t.fields.dev_hold = { value: 1, src: 'gmgn.token_info', as_of: 1 }; return Promise.resolve(json(200, t)); }
      return Promise.resolve(json(200, { ok: true, price: { value: 0.1, src: 'gmgn.token_info', as_of: null }, frozen: false, drained: false }));
    });
    expect(await bad.c.arms()).toEqual({ error: 'invalid_response' });
    expect(await bad.c.token(CA)).toEqual({ error: 'invalid_response' });
    expect(await bad.c.price(CA)).toEqual({ error: 'invalid_response' });
    const nullPrice = client(() => Promise.resolve(json(200, { ok: true, price: { value: null, src: null, as_of: null }, frozen: true, drained: false })));
    expect(await nullPrice.c.price(CA)).toEqual({ price: { value: null, src: null, as_of: null }, frozen: true, drained: false });
  });

  it('sends nothing without a usable link secret or with a malformed token address', async () => {
    const off = client(() => Promise.resolve(json(200, armsBody())), () => 'short');
    expect(await off.c.arms()).toEqual({ error: 'link_off' });
    expect(await off.c.price(CA)).toEqual({ error: 'link_off' });
    expect(off.requests).toHaveLength(0);
    const { c, requests } = client(() => Promise.resolve(json(200, priceBody())));
    expect(await c.token('../../etc/passwd')).toEqual({ error: 'invalid_ca' });
    expect(await c.price('')).toEqual({ error: 'invalid_ca' });
    expect(requests).toHaveLength(0);
  });

  describe('against a real link-authenticated server on 127.0.0.1', () => {
    let server: Server;
    let port = 0;
    const seen: string[] = [];
    const start = async (): Promise<void> => {
      const app = express();
      app.use('/api/bot/v1', (req, res, next) => {
        const chain = linkAuth({ secret: () => SECRET, receiverPort: port });
        chain[0](req, res, err => { if (err !== undefined) next(err); else chain[1](req, res, next); });
      });
      app.get('/api/bot/v1/arms', (req, res) => { seen.push(req.path); res.json(armsBody()); });
      app.get('/api/bot/v1/price/:ca', (req, res) => { seen.push(req.path); res.json(priceBody()); });
      app.get('/api/bot/v1/token/:ca', (_req, _res) => { /* never answers: the client's own timeout decides */ });
      await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => { port = (server.address() as AddressInfo).port; resolve(); }); });
    };
    afterAll(async () => {
      if (server === undefined) return;
      server.closeAllConnections?.();
      await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
    });

    it('authenticates with the real headers, parses the answers, and times out on a server that does not answer', async () => {
      await start();
      const c = createEngineClient({ engineUrl: `http://127.0.0.1:${port}`, secret: () => SECRET, timeoutMs: 150 });
      const arms = await c.arms();
      expect('arms' in arms && arms.arms).toHaveLength(4);
      expect(await c.price(CA)).toMatchObject({ frozen: false, drained: false });
      expect(seen).toEqual(['/api/bot/v1/arms', `/api/bot/v1/price/${CA}`]);
      expect(await c.token(CA)).toEqual({ error: 'timeout' });
      const wrong = createEngineClient({ engineUrl: `http://127.0.0.1:${port}`, secret: () => crypto.randomBytes(32).toString('base64url') });
      expect(await wrong.arms()).toEqual({ error: 'auth' });
    });
  });
});
