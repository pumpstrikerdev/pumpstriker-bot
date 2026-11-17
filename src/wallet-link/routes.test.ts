/**
 * R7-W6 (A-99; design 6.8): the six wallet link routes over a real HTTP server on 127.0.0.1:0 (node:http client, A-30): the same link auth as
 * /v1/events, strict bodies that are refused without an echo, the validated quote, the internal budget with no partial bytes, and the fill, balances and
 * find routes. The operations behind the routes are scripted stubs: the
 * builders belong to the execution layer and are tested there; the handler's own limits are in handler.test.ts.
 *
 * One FakeClock; keys, signatures and transaction bytes are generated at run time (A-20).
 */
import crypto from 'node:crypto';
import http from 'node:http';
import bs58 from 'bs58';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createEventsServer, type RunningEventsServer } from '../link/events-server';
import { FakeClock } from '../link/clock';
import { createInbox } from '../link/inbox';
import { cleanupTempDirs, tempDir } from '../link/link-testkit';
import type { WalletLinkRoute, WalletQuoteLink, WalletQuoteRequest } from '../shared/contract/wallet-link';
import { WALLET_LINK_PATHS } from '../shared/contract/wallet-link';
import { createWalletLinkHandler, type WalletLinkOps } from './handler';
import { createWalletRouter, walletRoutePath } from './routes';

const NOW = 1_800_000_000_000;
const SECRET = crypto.randomBytes(32).toString('base64url');
const quiet = (): void => undefined;
const key = (i: number): string => bs58.encode(crypto.createHash('sha256').update(`ps-fixture-${i}`).digest());
const newSig = (): string => bs58.encode(crypto.randomBytes(64));
const OWNER = key(0);
const MINT = key(1);
const ROUTES = Object.keys(WALLET_LINK_PATHS) as WalletLinkRoute[];

interface Resp { status: number; json: any; headers: http.IncomingHttpHeaders; raw: string }
function post(port: number, path: string, body: unknown, over: { headers?: Record<string, string>; raw?: string; method?: string; secret?: string } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const method = over.method ?? 'POST';
    const text = over.raw ?? JSON.stringify(body);
    const headers: Record<string, string> = {
      host: `127.0.0.1:${port}`, authorization: `Bearer ${over.secret ?? SECRET}`, 'content-type': 'application/json',
      ...(method === 'GET' ? {} : { 'content-length': String(Buffer.byteLength(text)) }), ...(over.headers ?? {}),
    };
    for (const k of Object.keys(headers)) if (headers[k] === '') delete headers[k];
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: any;
        try { json = JSON.parse(raw); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers, raw });
      });
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : text);
  });
}

// ── bodies and answers ─────────────────────────────────────────────────────────────────────────────

const quoteBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  owner: OWNER, side: 'buy', mint: MINT, amountLamports: '50000000', slippageBps: 3000, maxImpactPct: 15, maxSpendLamports: null, feeLevel: 'normal', maxTxBytes: 1100, ...over,
});
const BODIES: Record<WalletLinkRoute, () => Record<string, unknown>> = {
  quote: () => quoteBody(),
  fill: () => ({ owner: OWNER, signature: newSig(), side: 'buy', mint: MINT, quoteRef: 'quote-ref-1', submittedAt: NOW - 5000, final: false }),
  find: () => ({ owner: OWNER, mint: MINT, side: 'sell', sinceSlot: 250_000_000 }),
  balances: () => ({ owner: OWNER }),
  closeQuote: () => ({ owner: OWNER, kind: 'empty', excluded: [] }),
  closeFill: () => ({ owner: OWNER, signature: newSig(), submittedAt: NOW - 5000, final: true }),
};

function quoteFor(req: WalletQuoteRequest): WalletQuoteLink {
  const buy = req.side === 'buy';
  const sol = (n: string): { baseUnits: string; decimals: number; asset: string } => ({ baseUnits: n, decimals: 9, asset: 'SOL' });
  const tok = (n: string): { baseUnits: string; decimals: number; asset: string } => ({ baseUnits: n, decimals: 6, asset: req.mint });
  const amount = buy ? (req.amountLamports as string) : (req.tokensRaw ?? '2500000');
  const spend = buy ? BigInt(amount) : 0n;
  return {
    route: 'pump', side: req.side, mint: req.mint,
    bound: buy ? { kind: 'exact_in', amountIn: sol(amount), minOut: tok('700000') } : { kind: 'exact_in', amountIn: tok(amount), minOut: sol('4000000') },
    maxOutflowLamports: String(spend + 5000n + 10_000n + (buy ? 2_039_280n : 0n)), quotedOut: buy ? tok('1000000') : sol('5000000'), quotedIn: null,
    impactPct: 2.5, slippageBps: req.slippageBps,
    simulatedDeltas: buy ? { sol: sol('-' + String(spend)), token: tok('1000000') } : { sol: sol('5000000'), token: tok('-' + amount) },
    networkFeeLamports: '5000', priorityFee: { cuLimit: 200_000, cuPriceMicrolamports: 50_000, lamports: '10000' }, innerFees: [], thirdPartyTransfers: [],
    rentLamports: buy ? '2039280' : '0', programs: [key(2)], txBytes: 600, txBase64: crypto.randomBytes(600).toString('base64'), minContextSlot: 250_000_000,
    quotedAt: NOW, simulatedAt: NOW, builtAt: NOW, balance: { lamports: '10000000000', readAt: NOW, slot: 250_000_001 }, routingNotes: [],
  };
}

interface Calls { quote: unknown[]; fill: unknown[]; find: unknown[]; balances: unknown[]; closeQuote: unknown[]; closeFill: unknown[] }
function stubOps(over: Partial<WalletLinkOps> = {}): { ops: WalletLinkOps; calls: Calls; total: () => number } {
  const calls: Calls = { quote: [], fill: [], find: [], balances: [], closeQuote: [], closeFill: [] };
  const ops: WalletLinkOps = {
    async quote(req) { calls.quote.push(req); return { ok: true, quote: quoteFor(req) }; },
    async fill(req) {
      calls.fill.push(req);
      return req.final
        ? { ok: true, fill: { status: 'not-landed', reason: null, solDeltaLamports: null, feeLamports: null, rentPaidLamports: null, tokenDeltaRaw: null, decimals: null, slot: null, blockTime: null } }
        : { ok: true, fill: { status: 'confirmed', reason: null, solDeltaLamports: '-52044280', feeLamports: '15000', rentPaidLamports: '2039280', tokenDeltaRaw: '1000000', decimals: 6, slot: 250_000_010, blockTime: NOW } };
    },
    async find(req) { calls.find.push(req); return { ok: true, signatures: [] }; },
    async balances(req) { calls.balances.push(req); return { ok: true, balances: { solLamports: '1500000000', tokens: [], readAt: NOW, slot: 250_000_002 } }; },
    async closeQuote(req) { calls.closeQuote.push(req); return { ok: false, code: 'nothing-to-close', reason: 'no empty token account' }; },
    async closeFill(req) {
      calls.closeFill.push(req);
      return { ok: true, fill: { status: 'confirmed', reason: null, solDeltaLamports: '2024280', feeLamports: '15000', rentReturnedLamports: '2039280', slot: 250_000_011, blockTime: NOW } };
    },
    ...over,
  };
  return { ops, calls, total: () => Object.values(calls).reduce((n, l) => n + l.length, 0) };
}

const open: RunningEventsServer[] = [];
async function start(ops: WalletLinkOps, clock: FakeClock = new FakeClock(NOW), secret: () => string = () => SECRET): Promise<{ port: number; clock: FakeClock }> {
  const handler = createWalletLinkHandler({ clock, ops, limits: { txMaxBytes: 1100, priorityMinMicrolamports: 10_000, priorityMaxMicrolamports: 1_000_000 } });
  const server = createEventsServer({
    secret, port: 0, clock, inbox: createInbox({ dir: tempDir(), clock, log: quiet }), intake: { handle: () => undefined }, log: quiet, wallet: createWalletRouter({ handler }),
  });
  const running = await server.listen(0);
  open.push(running);
  return { port: running.port, clock };
}
afterEach(async () => { for (const s of open.splice(0)) await s.close(); });
afterAll(() => { cleanupTempDirs(); });

describe('the route table', () => {
  it('six POST routes under /v1/wallet, taken from the frozen path table; any other method or path is the /v1 JSON 404', async () => {
    expect(ROUTES.map(r => WALLET_LINK_PATHS[r]).sort()).toEqual([
      '/v1/wallet/balances', '/v1/wallet/close-fill', '/v1/wallet/close-quote', '/v1/wallet/fill', '/v1/wallet/find', '/v1/wallet/quote',
    ]);
    for (const r of ROUTES) expect(`/v1/wallet${walletRoutePath(r)}`).toBe(WALLET_LINK_PATHS[r]);
    const { ops, total } = stubOps();
    const { port } = await start(ops);
    for (const r of ROUTES) {
      const get = await post(port, WALLET_LINK_PATHS[r], undefined, { method: 'GET' });
      expect(get.status, `GET ${r}`).toBe(404);
      expect(get.json).toMatchObject({ ok: false, code: 'invalid' });
    }
    for (const path of ['/v1/wallet', '/v1/wallet/', '/v1/wallet/trade', '/v1/wallet/quote/extra', '/wallet/quote', '/v1/walletquote']) {
      const r = await post(port, path, {});
      expect(r.status, path).toBe(404);
      expect(r.json).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(total()).toBe(0);
  });
});

describe('WBL link routes', () => {
  it('WBL-T01 the wallet routes sit behind the link auth: browser markers 403, a bad or missing bearer 401, a Host that is not loopback on the bot port 403, no JSON 415, 32 KB, invalid JSON, no secret; nothing reaches an operation', async () => {
    const logs: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); }));
    try {
      const { ops, total } = stubOps();
      const { port } = await start(ops);
      const short = await start(ops, new FakeClock(NOW), () => 'too-short');
      for (const route of ROUTES) {
        const path = WALLET_LINK_PATHS[route];
        const body = BODIES[route]();
        const cases: Array<{ name: string; run: () => Promise<Resp>; status: number; code: string }> = [
          { name: 'browser Origin', run: () => post(port, path, body, { headers: { origin: 'https://evil.example' } }), status: 403, code: 'auth' },
          { name: 'Sec-Fetch-Site', run: () => post(port, path, body, { headers: { 'sec-fetch-site': 'cross-site' } }), status: 403, code: 'auth' },
          { name: 'Sec-Fetch-Mode (what the global fetch sends)', run: () => post(port, path, body, { headers: { 'sec-fetch-mode': 'cors' } }), status: 403, code: 'auth' },
          { name: 'rebinding Host on the right port', run: () => post(port, path, body, { headers: { host: `evil.example:${port}` } }), status: 403, code: 'auth' },
          { name: 'loopback Host on another port', run: () => post(port, path, body, { headers: { host: `127.0.0.1:${port + 1}` } }), status: 403, code: 'auth' },
          { name: 'a LAN address as Host', run: () => post(port, path, body, { headers: { host: `192.168.1.20:${port}` } }), status: 403, code: 'auth' },
          { name: 'no bearer', run: () => post(port, path, body, { headers: { authorization: '' } }), status: 401, code: 'auth' },
          { name: 'wrong bearer', run: () => post(port, path, body, { secret: crypto.randomBytes(32).toString('base64url') }), status: 401, code: 'auth' },
          { name: 'not JSON content type', run: () => post(port, path, body, { headers: { 'content-type': 'text/plain' } }), status: 415, code: 'invalid' },
          { name: 'body above 32 KB', run: () => post(port, path, { pad: 'x'.repeat(40_000) }), status: 413, code: 'too_large' },
          { name: 'invalid JSON', run: () => post(port, path, undefined, { raw: '{"owner":' }), status: 400, code: 'invalid' },
          { name: 'no secret configured on the receiver', run: () => post(short.port, path, body, { secret: 'too-short' }), status: 503, code: 'auth' },
        ];
        for (const c of cases) {
          const r = await c.run();
          expect({ route, name: c.name, status: r.status, ok: r.json?.ok, code: r.json?.code }, `${route} ${c.name}`).toEqual({ route, name: c.name, status: c.status, ok: false, code: c.code });
          expect(typeof r.json?.reason, `${route} ${c.name} carries a reason`).toBe('string');
        }
      }
      expect(total(), 'no refused request reached an operation').toBe(0);
      // a correct request of every route does pass
      for (const route of ROUTES) expect((await post(port, WALLET_LINK_PATHS[route], BODIES[route]())).status, route).toBe(200);
      expect(total()).toBe(ROUTES.length);
      const printed = logs.join('\n');
      expect(printed).not.toContain(SECRET);
      expect(printed.toLowerCase()).not.toContain('bearer ');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('WBL-T02 invalid bodies are 400 with a reason that never echoes input, on every route; nothing reaches an operation', async () => {
    const { ops, total } = stubOps();
    const { port } = await start(ops);
    const planted = `planted-${crypto.randomBytes(6).toString('hex')}`;
    const bad: Record<WalletLinkRoute, Array<Record<string, unknown>>> = {
      quote: [
        {}, quoteBody({ [planted]: 1 }), quoteBody({ owner: planted }), quoteBody({ owner: 'abc' }), quoteBody({ mint: planted }), quoteBody({ side: planted }), quoteBody({ amountLamports: 50_000_000 }),
        quoteBody({ amountLamports: '0' }), quoteBody({ amountLamports: '1.5' }), quoteBody({ amountLamports: '007' }), quoteBody({ amountLamports: '18446744073709551616' }),
        quoteBody({ tokensRaw: '5' }), quoteBody({ slippageBps: 0 }), quoteBody({ slippageBps: 5001 }), quoteBody({ slippageBps: 30.5 }), quoteBody({ slippageBps: '3000' }),
        quoteBody({ maxImpactPct: 0 }), quoteBody({ maxImpactPct: 50.01 }), quoteBody({ maxImpactPct: 12.345 }), quoteBody({ maxImpactPct: '15' }), quoteBody({ maxSpendLamports: 0 }),
        quoteBody({ maxSpendLamports: '0' }), quoteBody({ maxSpendLamports: undefined }), quoteBody({ feeLevel: 'turbo' }), quoteBody({ maxTxBytes: 1133 }), quoteBody({ maxTxBytes: 0 }),
        quoteBody({ allowPumpPortal: true }),
        quoteBody({ side: 'sell', amountLamports: undefined }), quoteBody({ side: 'sell', amountLamports: undefined, tokensRaw: '5', pctBps: 5000 }),
        quoteBody({ side: 'sell', amountLamports: undefined, pctBps: 10_001 }),
      ],
      fill: [{}, { ...BODIES.fill(), [planted]: 1 }, { ...BODIES.fill(), signature: planted }, { ...BODIES.fill(), final: 'yes' }, { ...BODIES.fill(), submittedAt: -1 }, { ...BODIES.fill(), quoteRef: `${planted} ${planted}` }],
      find: [{}, { ...BODIES.find(), sinceSlot: -5 }, { ...BODIES.find(), side: planted }, { ...BODIES.find(), [planted]: true }],
      balances: [{}, { owner: planted }, { owner: OWNER, [planted]: 1 }],
      closeQuote: [{}, { ...BODIES.closeQuote(), kind: planted }, { ...BODIES.closeQuote(), excluded: [planted] }, { ...BODIES.closeQuote(), accounts: [] }, { ...BODIES.closeQuote(), [planted]: 1 }],
      closeFill: [{}, { ...BODIES.closeFill(), signature: 'short' }, { ...BODIES.closeFill(), [planted]: 1 }, { ...BODIES.closeFill(), final: 1 }],
    };
    let n = 0;
    for (const route of ROUTES) {
      for (const body of bad[route]) {
        const r = await post(port, WALLET_LINK_PATHS[route], body);
        expect(r.status, `${route} ${JSON.stringify(body).slice(0, 80)}`).toBe(400);
        expect(r.json).toMatchObject({ ok: false, code: 'bad-request' });
        expect(typeof r.json.reason).toBe('string');
        expect(r.raw, 'the planted value is never echoed').not.toContain(planted);
        n++;
      }
      // a JSON array or a bare string is refused too
      for (const raw of ['[]', '"x"', 'null']) {
        const r = await post(port, WALLET_LINK_PATHS[route], undefined, { raw });
        expect([400]).toContain(r.status);
        expect(r.json).toMatchObject({ ok: false });
        n++;
      }
    }
    expect(n).toBeGreaterThan(50);
    expect(total()).toBe(0);
  });

  it('WBL-T03 a valid quote request returns the validated quote; the default 30 percent slippage, a per-trade value, a sell by percentage and an uncapped large amount all pass', async () => {
    const { ops, calls } = stubOps();
    const { port } = await start(ops);
    const r = await post(port, WALLET_LINK_PATHS.quote, quoteBody());
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json.ok).toBe(true);
    expect(Object.keys(r.json).sort()).toEqual(['ok', 'quote']);
    const q = r.json.quote as WalletQuoteLink;
    expect(q).toMatchObject({ route: 'pump', side: 'buy', mint: MINT, slippageBps: 3000, impactPct: 2.5, networkFeeLamports: '5000', txBytes: 600 });
    expect(Buffer.from(q.txBase64, 'base64')).toHaveLength(q.txBytes);
    expect(BigInt(q.maxOutflowLamports)).toBe(50_000_000n + 5000n + 10_000n + 2_039_280n);
    expect(calls.quote).toHaveLength(1);
    expect(calls.quote[0]).toEqual(quoteBody());

    for (const slippageBps of [1, 250, 5000]) expect((await post(port, WALLET_LINK_PATHS.quote, quoteBody({ slippageBps }))).json.quote.slippageBps).toBe(slippageBps);
    const sell = await post(port, WALLET_LINK_PATHS.quote, quoteBody({ side: 'sell', amountLamports: undefined, pctBps: 2500 }));
    expect(sell.json).toMatchObject({ ok: true, quote: { side: 'sell' } });
    // no fixed maximum per trade: 9000 SOL with no cap on the request goes through; with a cap below it the Engine's cap refuses it
    const huge = await post(port, WALLET_LINK_PATHS.quote, quoteBody({ amountLamports: '9000000000000', maxSpendLamports: null }));
    expect(huge.json.code, 'only the wallet balance (10 SOL in this stub) can stop an uncapped amount').toBe('insufficient-sol');
    expect(huge.json).toMatchObject({ needLamports: String(9_000_000_000_000n + 5000n + 10_000n + 2_039_280n), haveLamports: '10000000000' });
    const capped = await post(port, WALLET_LINK_PATHS.quote, quoteBody({ amountLamports: '5000000000', maxSpendLamports: '1000000000' }));
    expect(capped.json).toMatchObject({ ok: false, code: 'amount-above-cap' });
  });

  it('WBL-T04 an operation that exceeds the 12 s internal budget is answered build-timeout with no partial bytes, and the signal it was given is aborted', async () => {
    const seen: { signal: AbortSignal | null } = { signal: null };
    const { ops } = stubOps({ quote: (_req, ctl) => { seen.signal = ctl.signal; return new Promise(() => undefined); } });
    const { port, clock } = await start(ops);
    const pending = post(port, WALLET_LINK_PATHS.quote, quoteBody());
    for (let i = 0; i < 200 && seen.signal === null; i++) await new Promise<void>(r => { setTimeout(r, 5); });
    const signal = seen.signal as AbortSignal | null;
    expect(signal, 'the operation started').not.toBeNull();
    await clock.advance(11_999);
    expect(signal?.aborted, 'still inside the budget').toBe(false);
    await clock.advance(1);
    const r = await pending;
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort(), 'a refusal and nothing else').toEqual(['code', 'ok', 'reason']);
    expect(r.json).toMatchObject({ ok: false, code: 'build-timeout' });
    expect(r.raw).not.toMatch(/txBase64|quote/);
    expect(signal?.aborted).toBe(true);
    // the server keeps answering afterwards
    const next = await post(port, WALLET_LINK_PATHS.balances, BODIES.balances());
    expect(next.status).toBe(200);
  });

  it('WBL-T05 the fill route returns the validated fill: confirmed with every booked value, failed with the fee, unverified with a reason, and a final read with nothing found is not-landed', async () => {
    const { ops, calls } = stubOps();
    const { port } = await start(ops);
    const confirmed = await post(port, WALLET_LINK_PATHS.fill, { ...BODIES.fill(), final: false });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json).toEqual({
      ok: true,
      fill: { status: 'confirmed', reason: null, solDeltaLamports: '-52044280', feeLamports: '15000', rentPaidLamports: '2039280', tokenDeltaRaw: '1000000', decimals: 6, slot: 250_000_010, blockTime: NOW },
    });
    const final = await post(port, WALLET_LINK_PATHS.fill, { ...BODIES.fill(), final: true });
    expect(final.json).toMatchObject({ ok: true, fill: { status: 'not-landed', solDeltaLamports: null, feeLamports: null, tokenDeltaRaw: null } });
    expect((calls.fill[0] as { final: boolean }).final).toBe(false);
    expect((calls.fill[1] as { final: boolean }).final).toBe(true);

    const scripted = (fill: unknown): WalletLinkOps['fill'] => async () => ({ ok: true, fill }) as never;
    const failed = stubOps({ fill: scripted({ status: 'failed', reason: 'price-moved', solDeltaLamports: '-5000', feeLamports: '5000', rentPaidLamports: null, tokenDeltaRaw: null, decimals: null, slot: 7, blockTime: NOW }) });
    const f = await post((await start(failed.ops)).port, WALLET_LINK_PATHS.fill, BODIES.fill());
    expect(f.json).toMatchObject({ ok: true, fill: { status: 'failed', reason: 'price-moved', feeLamports: '5000' } });
    const unverified = stubOps({ fill: scripted({ status: 'unverified', reason: 'meta not readable yet', solDeltaLamports: null, feeLamports: null, rentPaidLamports: null, tokenDeltaRaw: null, decimals: null, slot: null, blockTime: null }) });
    const u = await post((await start(unverified.ops)).port, WALLET_LINK_PATHS.fill, BODIES.fill());
    expect(u.json).toMatchObject({ ok: true, fill: { status: 'unverified', reason: 'meta not readable yet' } });
    // a confirmed fill missing a booked value, a failed one without its fee, and an unverified one without a reason are refused before the Engine sees them
    for (const broken of [
      { status: 'confirmed', reason: null, solDeltaLamports: '-1', feeLamports: '1', rentPaidLamports: null, tokenDeltaRaw: '1', decimals: 6, slot: 1, blockTime: NOW },
      { status: 'failed', reason: null, solDeltaLamports: null, feeLamports: null, rentPaidLamports: null, tokenDeltaRaw: null, decimals: null, slot: 1, blockTime: NOW },
      { status: 'unverified', reason: null, solDeltaLamports: null, feeLamports: null, rentPaidLamports: null, tokenDeltaRaw: null, decimals: null, slot: null, blockTime: null },
      { status: 'submitted', reason: null, solDeltaLamports: null, feeLamports: null, rentPaidLamports: null, tokenDeltaRaw: null, decimals: null, slot: null, blockTime: null },
    ]) {
      const b = stubOps({ fill: scripted(broken) });
      const r = await post((await start(b.ops)).port, WALLET_LINK_PATHS.fill, BODIES.fill());
      expect(r.json, JSON.stringify(broken.status)).toMatchObject({ ok: false, code: 'verify-failed' });
    }
    // the close fill follows the same rules with the rent returned
    const cf = await post(port, WALLET_LINK_PATHS.closeFill, BODIES.closeFill());
    expect(cf.json).toEqual({
      ok: true, fill: { status: 'confirmed', reason: null, solDeltaLamports: '2024280', feeLamports: '15000', rentReturnedLamports: '2039280', slot: 250_000_011, blockTime: NOW },
    });
  });

  it('WBL-T06 the balances route returns the exact strings the operation read; a read that failed is a refusal, never an empty list or a zero', async () => {
    const token = { account: key(30), mint: MINT, program: 'token', amountRaw: '18446744073709551615', decimals: 6, rentLamports: '2039280', frozen: false };
    const { ops } = stubOps({ balances: async () => ({ ok: true, balances: { solLamports: '9007199254740993', tokens: [token as never], readAt: NOW, slot: 250_000_002 } }) });
    const { port } = await start(ops);
    const r = await post(port, WALLET_LINK_PATHS.balances, BODIES.balances());
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, balances: { solLamports: '9007199254740993', tokens: [token], readAt: NOW, slot: 250_000_002 } });
    const failing = stubOps({ balances: async () => ({ ok: false, code: 'build-failed', reason: 'getBalance was refused by the node' }) });
    const f = await post((await start(failing.ops)).port, WALLET_LINK_PATHS.balances, BODIES.balances());
    expect(f.json).toEqual({ ok: false, code: 'build-failed', reason: 'getBalance was refused by the node' });
    expect(f.raw).not.toMatch(/solLamports|tokens/);
    const dup = stubOps({ balances: async () => ({ ok: true, balances: { solLamports: '1', tokens: [token as never, token as never], readAt: NOW, slot: 1 } }) });
    expect((await post((await start(dup.ops)).port, WALLET_LINK_PATHS.balances, BODIES.balances())).json).toMatchObject({ ok: false, code: 'verify-failed' });
  });

  it('WBL-T11 the find route returns at most three signatures of the owner, [] when nothing matches yet, and refuses a longer or malformed list', async () => {
    const { ops, calls } = stubOps();
    const { port } = await start(ops);
    const none = await post(port, WALLET_LINK_PATHS.find, BODIES.find());
    expect(none.json).toEqual({ ok: true, signatures: [] });
    expect(calls.find).toHaveLength(1);
    expect(calls.find[0]).toMatchObject({ owner: OWNER, mint: MINT, side: 'sell', sinceSlot: 250_000_000 });
    const sigs = [newSig(), newSig(), newSig()];
    const three = stubOps({ find: async () => ({ ok: true, signatures: sigs }) });
    expect((await post((await start(three.ops)).port, WALLET_LINK_PATHS.find, BODIES.find())).json).toEqual({ ok: true, signatures: sigs });
    const four = stubOps({ find: async () => ({ ok: true, signatures: [...sigs, newSig()] }) });
    expect((await post((await start(four.ops)).port, WALLET_LINK_PATHS.find, BODIES.find())).json).toMatchObject({ ok: false, code: 'verify-failed' });
    const garbage = stubOps({ find: async () => ({ ok: true, signatures: ['not-a-signature'] }) });
    expect((await post((await start(garbage.ops)).port, WALLET_LINK_PATHS.find, BODIES.find())).json).toMatchObject({ ok: false, code: 'verify-failed' });
  });
});
