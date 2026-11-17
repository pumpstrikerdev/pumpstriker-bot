/**
 * Tests for the GMGN skill commands (WI-C §3.22; B50 section 2, R3-B5). Fixture-driven: the HTTP seam, Telegram and the bot are
 * fakes, so nothing touches the network and the bot is never launched. Addresses below are PUBLIC token mints.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TokenProxyResponse } from '../shared/contract/v1';
import { HttpError, type HttpRequest, type HttpResponse } from '../link/common';

const hoisted = vi.hoisted(() => ({ warn: [] as string[], secret: 'k'.repeat(40) }));
vi.mock('../logger', () => ({
  log: () => {},
  logOk: () => {},
  logDbg: () => {},
  logErr: () => {},
  logWarn: (m: string) => { hoisted.warn.push(m); },
  emitEvent: () => {},
  setBroadcast: () => {},
}));
// Keeps dotenv / settings.json out of the test process.
vi.mock('../config', () => ({ CONFIG: { ENGINE_URL: 'http://engine.test', SIGNAL_SHARED_SECRET: hoisted.secret } }));

import {
  ENGINE_DEFAULT_TIMEOUT_MS, ENGINE_NARRATIVE_TIMEOUT_MS, ENGINE_OFFLINE_TEXT, LINK_OFF_TEXT, QUERY_MAX, RUNNING_TEXT,
  SKILL_BOT_COMMANDS, SKILL_BUTTON_CODES, SKILL_CALLBACK_RE, SKILL_COMMANDS, SKILL_COOLDOWN_MS, PATTERN_RESOLUTIONS, TG_SEND_MAX,
  callEngine, clampText, deliverReply, parseReportArgs, parseSkillArgs, registerSkillCommands, renderTokenReport, reportReply,
  skillButtonsRow, withSkillCommands,
  type EngineReply, type SkillTelegram,
} from './skill-commands';

const CA   = '8LmvqLQhC53pqTyChaGLUCYJgMrcAGiKN8FGEm8Gpump';   // Catemas (public CA)
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';   // USDC mint (public)
const EVM  = '0x' + 'ab'.repeat(20);
const URL_BASE = 'http://engine.test';
const SECRET = hoisted.secret;

// ── fakes ────────────────────────────────────────────────────────────────────

function respond(body: string, status = 200): HttpResponse {
  return { status, body };
}
const envelope = (o: object, status = 200) => respond(JSON.stringify(o), status);

function httpReturning(make: () => HttpResponse) {
  return vi.fn(async (_req: HttpRequest) => make());
}

function deferredHttp() {
  const calls: string[] = [];
  const reqs: HttpRequest[] = [];
  const pending: ((r: HttpResponse) => void)[] = [];
  const fn = vi.fn((req: HttpRequest) => {
    calls.push(req.url);
    reqs.push(req);
    return new Promise<HttpResponse>(resolve => { pending.push(resolve); });
  });
  return { fn, calls, reqs, resolveNext: (r: HttpResponse) => pending.shift()!(r) };
}

function tgError(description: string) {
  return Object.assign(new Error(`400: Bad Request: ${description}`), {
    response: { ok: false, error_code: 400, description: `Bad Request: ${description}` },
  });
}

function fakeTg() {
  let nextId = 100;
  const tg = {
    sendMessage: vi.fn(async (_chatId: any, _text: string, _extra?: any) => ({ message_id: ++nextId })),
    editMessageText: vi.fn(async (..._a: any[]) => true as unknown),
  };
  return tg;
}

function fakeBot() {
  const commands = new Map<string, (ctx: any, next: () => Promise<void>) => Promise<unknown>>();
  const actions: { re: RegExp; fn: (ctx: any) => Promise<unknown> }[] = [];
  const bot = {
    command: (name: string, fn: any) => { commands.set(name, fn); },
    action: (re: RegExp, fn: any) => { actions.push({ re, fn }); },
  };
  return { bot, commands, actions };
}

type HttpStub = (req: HttpRequest) => Promise<HttpResponse>;

function setup(http: HttpStub, extra: { now?: () => number; onCommand?: () => void; engine?: any } = {}) {
  const { bot, commands, actions } = fakeBot();
  registerSkillCommands(bot as any, { http, engineUrl: URL_BASE, secret: () => SECRET, ...extra });
  const tg = fakeTg();
  const run = (text: string, chatId = 1) => {
    const cmd = text.slice(1).split(/[\s@]/)[0];
    const next = vi.fn(async () => {});
    const p = commands.get(cmd)!({ chat: { id: chatId }, message: { text }, telegram: tg }, next);
    return { p, next };
  };
  const tap = (data: string, chatId = 1) => {
    const m = SKILL_CALLBACK_RE.exec(data);
    const answerCbQuery = vi.fn(async (_t?: string) => true);
    const p = actions[0].fn({ chat: { id: chatId }, match: m, telegram: tg, answerCbQuery });
    return { p, answerCbQuery };
  };
  return { commands, actions, tg, run, tap };
}

beforeEach(() => { hoisted.warn.length = 0; });

// ── parseSkillArgs ──────────────────────────────────────────────────────────

describe('parseSkillArgs', () => {
  it('/dd <ca> → dd route with the default 15 s timeout', () => {
    expect(parseSkillArgs('dd', `/dd ${CA}`)).toEqual({ ok: true, path: `/api/skills/dd/${CA}`, timeoutMs: ENGINE_DEFAULT_TIMEOUT_MS });
  });

  it('accepts /cmd@BotName and extra whitespace', () => {
    expect(parseSkillArgs('holders', `/holders@PumpStrikerBot    ${CA}  `)).toMatchObject({ ok: true, path: `/api/skills/holders/${CA}` });
    expect(parseSkillArgs('dev', `/dev ${USDC}`)).toMatchObject({ ok: true, path: `/api/skills/dev/${USDC}` });
  });

  it('missing CA → usage line', () => {
    expect(parseSkillArgs('dd', '/dd')).toEqual({ ok: false, usage: 'Usage: /dd <CA>' });
  });

  it('EVM address is rejected with a Solana-only message', () => {
    const r = parseSkillArgs('dd', `/dd ${EVM}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.usage).toMatch(/Solana addresses only/);
  });

  it.each([
    ['non-base58 characters', 'O0Il' + CA.slice(4)],
    ['too short', 'pump'],
    ['too long', CA + 'x'],
    ['base58 shape but not 32 bytes', 'z'.repeat(44)],
    ['callback-splitting colon', `${CA.slice(0, 20)}:${CA.slice(21)}`],
  ])('invalid CA (%s) is refused', (_label, bad) => {
    const r = parseSkillArgs('holders', `/holders ${bad}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.usage).toMatch(/Invalid token address|Solana addresses only/);
  });

  it('R9CL2-T01 the removed commands (narrative, news, radar, tracked, pftrending, vetting) are not in the menu and parse to the generic unknown-command reply', () => {
    const names = SKILL_BOT_COMMANDS.map(c => c.command);
    for (const cmd of ['narrative', 'news', 'radar', 'tracked', 'pftrending', 'vetting']) {
      expect(names).not.toContain(cmd);
      expect(SKILL_COMMANDS).not.toContain(cmd);
      expect(parseSkillArgs(cmd, `/${cmd} ${CA}`)).toEqual({ ok: false, usage: `Unknown skill command /${cmd}` });
    }
  });

  it('/pattern: default 15m, whitelisted (case-insensitive) resolution, unknown refused', () => {
    expect(parseSkillArgs('pattern', `/pattern ${CA}`)).toMatchObject({ ok: true, path: `/api/skills/pattern/${CA}?res=15m` });
    expect(parseSkillArgs('pattern', `/pattern ${CA} 1H`)).toMatchObject({ ok: true, path: `/api/skills/pattern/${CA}?res=1h` });
    for (const res of PATTERN_RESOLUTIONS) expect(parseSkillArgs('pattern', `/pattern ${CA} ${res}`).ok).toBe(true);
    const bad = parseSkillArgs('pattern', `/pattern ${CA} 2m`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.usage).toMatch(/Unknown resolution/);
  });

  it.each([
    ['hot', '/api/skills/heat-rank'],
    ['surge', '/api/skills/surge'],
    ['watchlist', '/api/skills/watchlist'],
    ['swings', '/api/skills/watchlist/swings'],
    ['calls', '/api/skills/calls'],
    ['feeds', '/api/skills/feeds'],
  ])('/%s → %s (extra words ignored)', (cmd, route) => {
    expect(parseSkillArgs(cmd, `/${cmd} whatever`)).toEqual({ ok: true, path: route, timeoutMs: ENGINE_DEFAULT_TIMEOUT_MS });
  });

  it('/wallet <addr> → wallet dossier route; EVM and garbage refused', () => {
    expect(parseSkillArgs('wallet', `/wallet ${USDC}`)).toMatchObject({ ok: true, path: `/api/skills/wallet/${USDC}` });
    expect(parseSkillArgs('wallet', `/wallet ${EVM}`).ok).toBe(false);
    const r = parseSkillArgs('wallet', '/wallet nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.usage).toMatch(/Invalid wallet address/);
  });

  it('/search: query required, encoded, ≤ 64 chars', () => {
    expect(parseSkillArgs('search', '/search').ok).toBe(false);
    expect(parseSkillArgs('search', '/search bonk dog')).toMatchObject({ ok: true, path: '/api/skills/search?q=bonk%20dog' });
    expect(parseSkillArgs('search', `/search ${'q'.repeat(QUERY_MAX)}`).ok).toBe(true);
    expect(parseSkillArgs('search', `/search ${'q'.repeat(QUERY_MAX + 1)}`).ok).toBe(false);
  });

  it('unknown command → refusal, never a route', () => {
    expect(parseSkillArgs('rm', '/rm -rf').ok).toBe(false);
  });

  // ── WI-G (G8) ──
  it('/migrated → migrated-quality feed route (no arguments)', () => {
    expect(parseSkillArgs('migrated', '/migrated now')).toEqual({ ok: true, path: '/api/skills/migrated-quality', timeoutMs: ENGINE_DEFAULT_TIMEOUT_MS });
  });

  it('/devinfo <ca> → devinfo route on the long timeout; bad CA refused', () => {
    expect(parseSkillArgs('devinfo', `/devinfo ${CA}`)).toEqual({ ok: true, path: `/api/skills/devinfo/${CA}`, timeoutMs: ENGINE_NARRATIVE_TIMEOUT_MS });
    expect(parseSkillArgs('devinfo', '/devinfo')).toEqual({ ok: false, usage: 'Usage: /devinfo <CA>' });
    expect(parseSkillArgs('devinfo', `/devinfo ${EVM}`).ok).toBe(false);
  });

  it('/balance <wallet> <ca> → balance route; both addresses validated', () => {
    expect(parseSkillArgs('balance', `/balance ${USDC} ${CA}`)).toEqual({ ok: true, path: `/api/skills/balance/${USDC}/${CA}`, timeoutMs: ENGINE_NARRATIVE_TIMEOUT_MS });
    const miss = parseSkillArgs('balance', `/balance ${USDC}`);
    expect(miss).toEqual({ ok: false, usage: 'Usage: /balance <wallet> <CA>' });
    const bad = parseSkillArgs('balance', `/balance nope ${CA}`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.usage).toMatch(/Invalid wallet address/);
    const badT = parseSkillArgs('balance', `/balance ${USDC} ${'z'.repeat(44)}`);
    expect(badT.ok).toBe(false);
    if (!badT.ok) expect(badT.usage).toMatch(/Invalid token address/);
  });

  it('/review <wallet> [1d|7d|30d|all] [me] → review route (default 7d, aliases, owner voice)', () => {
    expect(parseSkillArgs('review', `/review ${USDC}`)).toEqual({ ok: true, path: `/api/skills/review/${USDC}?period=7d`, timeoutMs: ENGINE_NARRATIVE_TIMEOUT_MS });
    expect(parseSkillArgs('review', `/review ${USDC} 30D`)).toMatchObject({ ok: true, path: `/api/skills/review/${USDC}?period=30d` });
    expect(parseSkillArgs('review', `/review ${USDC} all me`)).toMatchObject({ ok: true, path: `/api/skills/review/${USDC}?period=all&voice=self` });
    expect(parseSkillArgs('review', `/review ${USDC} me 24h`)).toMatchObject({ ok: true, path: `/api/skills/review/${USDC}?period=1d&voice=self` });
    expect(parseSkillArgs('review', `/review ${USDC} 1w`)).toMatchObject({ ok: true, path: `/api/skills/review/${USDC}?period=7d` });
    const bad = parseSkillArgs('review', `/review ${USDC} 2w`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.usage).toMatch(/Unknown option "2w"\. Usage: \/review <wallet> \[1d\|7d\|30d\|all\] \[me\]/);
    expect(parseSkillArgs('review', '/review').ok).toBe(false);
    expect(parseSkillArgs('review', `/review ${USDC} 7d me extra`).ok).toBe(false);
  });

  it('/report <ca>: the validated address, or the usage line', () => {
    expect(parseReportArgs(`/report ${CA}`)).toEqual({ ok: true, ca: CA });
    expect(parseReportArgs('/report')).toEqual({ ok: false, usage: 'Usage: /report <CA>' });
    expect(parseReportArgs(`/report ${EVM}`).ok).toBe(false);
    expect(parseReportArgs('/report nope').ok).toBe(false);
  });
});

// ── button row + command menu ───────────────────────────────────────────────

describe('skillButtonsRow / SKILL_BOT_COMMANDS', () => {
  it('R9CL2-T02 valid CA → the 4 skill buttons (no Narrative), callback_data ≤ 64 bytes and matching the sk: handler', () => {
    const row = skillButtonsRow(CA);
    expect(row.map(b => b.text)).toEqual(['🔬 DD', 'Pattern', 'Holders', 'Dev']);
    expect(row.map(b => (b as any).callback_data)).toEqual(['dd', 'pt', 'ho', 'dv'].map(c => `sk:${c}:${CA}`));
    expect(Object.keys(SKILL_BUTTON_CODES)).toEqual(['dd', 'pt', 'ho', 'dv']);
    expect(SKILL_CALLBACK_RE.test(`sk:nr:${CA}`)).toBe(false);
    for (const b of row) {
      const data = (b as any).callback_data as string;
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(50);
      expect(SKILL_CALLBACK_RE.test(data)).toBe(true);
    }
  });

  it('invalid CA → empty row', () => {
    for (const bad of ['', EVM, 'z'.repeat(44), 'not a ca', CA + ':x']) expect(skillButtonsRow(bad)).toEqual([]);
  });

  it('18 unique, Telegram-valid skill commands', () => {
    expect(SKILL_BOT_COMMANDS).toHaveLength(18);
    const names = SKILL_BOT_COMMANDS.map(c => c.command);
    expect(new Set(names).size).toBe(18);
    expect(names.sort()).toEqual(['balance', 'caller', 'calls', 'dd', 'dev', 'devinfo', 'feeds', 'holders', 'hot', 'migrated', 'pattern', 'report', 'review', 'search', 'surge', 'swings', 'wallet', 'watchlist']);
    for (const c of SKILL_BOT_COMMANDS) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
  });

  it('withSkillCommands keeps the base order, re-describes /wallet, appends the rest, no duplicates', () => {
    const base = [{ command: 'menu', description: 'Menu' }, { command: 'wallet', description: 'old' }, { command: 'buy', description: 'Buy' }];
    const merged = withSkillCommands(base);
    expect(merged.slice(0, 3).map(c => c.command)).toEqual(['menu', 'wallet', 'buy']);
    expect(merged[1].description).toMatch(/\/wallet <addr>/);
    expect(merged).toHaveLength(3 + 17);
    expect(new Set(merged.map(c => c.command)).size).toBe(merged.length);
  });
});

// ── callEngine ──────────────────────────────────────────────────────────────

describe('callEngine', () => {
  it('ok envelope → the Engine text; GET on ENGINE_URL (trailing slash stripped) with the link bearer', async () => {
    const f = httpReturning(() => envelope({ ok: true, text: '🟢 *DD 82*', data: {} }));
    const r = await callEngine(`/api/skills/dd/${CA}`, 1000, f, `${URL_BASE}/`);
    expect(r).toEqual({ ok: true, text: '🟢 *DD 82*' });
    const req = f.mock.calls[0][0];
    expect(req.url).toBe(`${URL_BASE}/api/skills/dd/${CA}`);
    expect(req.method).toBe('GET');
    expect(req.timeoutMs).toBe(1000);
    expect(req.headers.Authorization).toBe(`Bearer ${SECRET}`);
  });

  it('A30 the request is built for node:http: link headers only, no browser marker, and the global fetch is never used', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('the global fetch must not be used'); });
    try {
      const f = httpReturning(() => envelope({ ok: true, text: 'x' }));
      await callEngine('/api/skills/hot', 1000, f);
      const req = f.mock.calls[0][0];
      expect(Object.keys(req.headers).filter(k => /^(sec-fetch-|origin$)/i.test(k))).toEqual([]);
      expect(req.headers['Content-Type']).toBe('application/json');
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      globalFetch.mockRestore();
    }
    const src = fs.readFileSync(path.join(__dirname, 'skill-commands.ts'), 'utf8');
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/globalThis\.fetch/);
  });

  it('A30 no usable link secret → nothing is sent, one plain line says so', async () => {
    const f = httpReturning(() => envelope({ ok: true, text: 'x' }));
    for (const bad of ['', 'short', ' '.repeat(40)]) {
      expect(await callEngine('/api/skills/hot', 1000, f, URL_BASE, () => bad)).toEqual({ ok: false, text: LINK_OFF_TEXT, plain: true });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('defaults to CONFIG.ENGINE_URL and CONFIG.SIGNAL_SHARED_SECRET', async () => {
    const f = httpReturning(() => envelope({ ok: true, text: 'x' }));
    await callEngine('/api/skills/hot', 1000, f);
    expect(f.mock.calls[0][0].url).toBe(`${URL_BASE}/api/skills/hot`);
    expect(f.mock.calls[0][0].headers.Authorization).toBe(`Bearer ${SECRET}`);
  });

  it('ok:false envelope with text (HTTP 400) → that text, sent as Markdown', async () => {
    const f = httpReturning(() => envelope({ ok: false, text: '⚠️ invalid token address', data: null, error: 'invalid token address' }, 400));
    expect(await callEngine('/api/skills/dd/x', 1000, f)).toEqual({ ok: false, text: '⚠️ invalid token address' });
  });

  it('ok:false envelope with empty text → the error as one plain line', async () => {
    const f = httpReturning(() => envelope({ ok: false, text: '', error: 'GMGN rate_limited' }, 500));
    expect(await callEngine('/api/skills/hot', 1000, f)).toEqual({ ok: false, text: '⚠️ GMGN rate_limited', plain: true });
  });

  it('Engine offline (a refused connection in the message, or ENOTFOUND on the error) → start-engine hint', async () => {
    const refused = vi.fn(async () => { throw new HttpError('network', 'connect ECONNREFUSED 127.0.0.1'); });
    const notFound = vi.fn(async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND engine.test'), { code: 'ENOTFOUND' }); });
    const cause = vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
    expect(await callEngine('/api/skills/hot', 1000, refused)).toEqual({ ok: false, text: ENGINE_OFFLINE_TEXT, plain: true });
    expect((await callEngine('/api/skills/hot', 1000, notFound)).text).toBe(ENGINE_OFFLINE_TEXT);
    expect((await callEngine('/api/skills/hot', 1000, cause)).text).toBe(ENGINE_OFFLINE_TEXT);
    expect(ENGINE_OFFLINE_TEXT).toBe('🔌 Engine is offline — start Engine\\start-engine.bat');
  });

  it('timeout → says how long it waited', async () => {
    const hang = vi.fn(async () => { throw new HttpError('timeout', 'request timed out'); });
    const r = await callEngine(`/api/skills/devinfo/${CA}`, 20, hang);
    expect(r).toEqual({ ok: false, text: '⌛ Engine did not answer in 20ms', plain: true });
    expect((await callEngine('/api/skills/hot', 15_000, hang)).text).toBe('⌛ Engine did not answer in 15s');
  });

  it('non-JSON 200 → one line', async () => {
    const f = httpReturning(() => respond('OK', 200));
    expect(await callEngine('/api/skills/hot', 1000, f)).toEqual({ ok: false, text: '⚠️ Engine sent a non-JSON reply (HTTP 200)', plain: true });
  });

  it('HTML SPA fallback (200) → "has no <route> route yet", CA left out of the label', async () => {
    const f = httpReturning(() => respond('<!DOCTYPE html><html><body><div id="root"></div></body></html>', 200));
    const r = await callEngine(`/api/skills/dd/${CA}`, 1000, f);
    expect(r.text).toBe('⚠️ Engine has no /api/skills/dd route yet — update and restart the Engine');
    expect(r.text).not.toContain(CA);
  });

  it('Express 404 HTML ("Cannot GET") → no route yet', async () => {
    const f = httpReturning(() => respond('<pre>Cannot GET /api/skills/surge</pre>', 404));
    expect((await callEngine('/api/skills/surge', 1000, f)).text).toMatch(/has no \/api\/skills\/surge route yet/);
  });

  it('5xx without the envelope → "Engine error (HTTP n): …", one redacted line', async () => {
    const secretish = 'x'.repeat(24);
    const f = httpReturning(() => respond(`upstream failed\n at https://rpc.example/?api-key=${secretish}\n<b>boom</b>`, 502));
    const r = await callEngine('/api/skills/hot', 1000, f);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/^⚠️ Engine error \(HTTP 502\): upstream failed/);
    expect(r.text).not.toContain(secretish);
    expect(r.text).not.toContain('\n');
    expect(r.text).not.toContain('<b>');
  });

  it('4xx JSON without the envelope (old {error} shape) → Engine error with the error text', async () => {
    const f = httpReturning(() => envelope({ error: 'bad address' }, 400));
    expect((await callEngine('/api/skills/dd/x', 1000, f)).text).toBe('⚠️ Engine error (HTTP 400): bad address');
  });

  it('200 JSON without {ok,text} → missing envelope', async () => {
    const f = httpReturning(() => envelope({ score: 82 }));
    expect((await callEngine('/api/skills/dd/x', 1000, f)).text).toBe('⚠️ Engine reply is missing the {ok,text} envelope');
    const g = httpReturning(() => envelope([1, 2]));
    expect((await callEngine('/api/skills/dd/x', 1000, g)).text).toBe('⚠️ Engine reply is missing the {ok,text} envelope');
  });

  it('ok:true with empty text → says so instead of sending an empty message', async () => {
    const f = httpReturning(() => envelope({ ok: true, text: '  ' }));
    expect((await callEngine('/api/skills/surge', 1000, f)).text).toBe('⚠️ Engine sent an empty reply for /api/skills/surge');
  });

  it('any other request error → "Engine request failed", never throws', async () => {
    const boom = vi.fn(async () => { throw new Error('socket hang up'); });
    expect(await callEngine('/api/skills/hot', 1000, boom)).toEqual({ ok: false, text: '⚠️ Engine request failed: socket hang up', plain: true });
  });
});

// ── /report: rendered from the Engine's token snapshot ──────────────────────

const NOW = 1_800_000_000_000;
function snapshot(over: Partial<TokenProxyResponse['fields']> = {}): TokenProxyResponse {
  const known = (value: number | string | boolean, ageMs: number) => ({ value, src: 'gmgn.token_info' as const, as_of: NOW - ageMs });
  return {
    ok: true, ca: CA, asOf: NOW - 1000,
    fields: {
      symbol: known('CATE', 60_000), name: known('Catemas', 60_000),
      price_usd: known(0.0000123, 4_000),
      mcap_usd: { value: null, src: null, as_of: null },          // the Engine does not know it
      liq_usd: known(5_200, 9_000),
      holder_count: known(312, 180_000),
      top10_rate: known(0.284, 180_000),
      migrated: known(false, 60_000), launchpad_status: known(0, 60_000),
      ...over,
    },
  };
}

describe('/report', () => {
  it('B5-T02 /report prints an em dash for a null field and the age of every known field', () => {
    const text = renderTokenReport(CA, snapshot(), NOW);
    expect(text).toContain('MCap: —');                         // null from the Engine → a dash, never 0 or $0
    expect(text).not.toMatch(/MCap: \$/);
    expect(text).toContain('Price: $0.0000123 (4s old)');       // known: value and age
    expect(text).toContain('Liq: $5.20K (9s old)');
    expect(text).toContain('Holders: 312 (3m old)');
    expect(text).toContain('Top10: 28.4% (3m old)');            // a 0-1 fraction of the Engine is shown as a percentage
    expect(text).toContain('Pool liq: —');                      // a field the Engine did not send at all
    expect(text).toContain('Creator: —');
    expect(text).toContain('5m: —');
    expect(text).toContain('Venue: bonding curve');
    expect(text).toContain('Engine snapshot');
    expect(text).not.toMatch(/dexscreener|rugcheck/i);
  });

  it('a value without an as_of says its age is unknown; names are made Markdown-safe', () => {
    const text = renderTokenReport(CA, snapshot({
      price_usd: { value: 1.5, src: 'gmgn.token_info', as_of: null } as any,
      symbol: { value: '*MO_ON*', src: 'gmgn.token_info', as_of: NOW },
    }), NOW);
    expect(text).toContain('Price: $1.50 (age unknown)');
    expect(text).toContain('🪙 *MOON*');
  });

  it('reportReply: a snapshot is rendered; every Engine error is one plain line', async () => {
    const ok = await reportReply({ token: async () => snapshot() }, CA, NOW);
    expect(ok.ok).toBe(true);
    const cases: Array<[string, string]> = [
      ['engine_offline', ENGINE_OFFLINE_TEXT], ['link_off', LINK_OFF_TEXT], ['timeout', '⌛ Engine did not answer in time'],
      ['budget', '⏳ The Engine has no on-demand budget left right now — try again in a minute'], ['http_500', '⚠️ Engine could not give a report (http_500)'],
    ];
    for (const [error, text] of cases) {
      expect(await reportReply({ token: async () => ({ error }) }, CA, NOW)).toEqual({ ok: false, text, plain: true });
    }
    const thrown = await reportReply({ token: async () => { throw new Error('boom'); } }, CA, NOW);
    expect(thrown).toMatchObject({ ok: false, plain: true });
  });

  it('the /report handler asks the Engine client (not an HTTP skill route) and edits the placeholder with the rendered text', async () => {
    const http = httpReturning(() => envelope({ ok: true, text: 'x' }));
    const token = vi.fn(async (_ca: string) => snapshot());
    const { run, tg } = setup(http, { engine: { token }, now: () => NOW });
    await run(`/report ${CA}`).p;
    await vi.waitFor(() => expect(tg.editMessageText).toHaveBeenCalledTimes(1));
    expect(token).toHaveBeenCalledWith(CA);
    expect(http).not.toHaveBeenCalled();
    expect(tg.sendMessage).toHaveBeenCalledWith(1, RUNNING_TEXT);
    expect(String(tg.editMessageText.mock.calls[0][3])).toContain('MCap: —');
    expect(tg.editMessageText.mock.calls[0][4]).toEqual({ parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
  });

  it('/report without a valid address → usage line, no Engine call', async () => {
    const token = vi.fn(async (_ca: string) => snapshot());
    const { run, tg } = setup(httpReturning(() => envelope({ ok: true, text: 'x' })), { engine: { token } });
    await run('/report').p;
    await run(`/report ${EVM}`).p;
    expect(token).not.toHaveBeenCalled();
    expect(tg.sendMessage.mock.calls[0][1]).toBe('Usage: /report <CA>');
    expect(tg.sendMessage.mock.calls[1][1]).toMatch(/Solana addresses only/);
  });
});

// ── deliverReply ────────────────────────────────────────────────────────────

describe('deliverReply', () => {
  const MD = { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } };
  const PLAIN = { link_preview_options: { is_disabled: true } };

  it('edits the ⏳ message with Markdown, link previews off', async () => {
    const tg = fakeTg();
    await deliverReply(tg as SkillTelegram, 1, 55, { ok: true, text: '*hi*' });
    expect(tg.editMessageText).toHaveBeenCalledWith(1, 55, undefined, '*hi*', MD);
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("Markdown rejected (can't parse entities) → re-edits the same text as plain", async () => {
    const tg = fakeTg();
    tg.editMessageText.mockRejectedValueOnce(tgError("can't parse entities: Can't find end of the entity starting at byte offset 3"));
    await deliverReply(tg as SkillTelegram, 1, 55, { ok: true, text: 'a_b' });
    expect(tg.editMessageText).toHaveBeenCalledTimes(2);
    expect(tg.editMessageText.mock.calls[1]).toEqual([1, 55, undefined, 'a_b', PLAIN]);
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it('⏳ message gone → the result is sent as a new message', async () => {
    const tg = fakeTg();
    tg.editMessageText.mockRejectedValueOnce(tgError('message to edit not found'));
    await deliverReply(tg as SkillTelegram, 1, 55, { ok: true, text: '*hi*' });
    expect(tg.sendMessage).toHaveBeenCalledWith(1, '*hi*', MD);
  });

  it('gone AND bad Markdown → new message, then plain resend', async () => {
    const tg = fakeTg();
    tg.editMessageText
      .mockRejectedValueOnce(tgError("can't parse entities"))
      .mockRejectedValueOnce(tgError('message to edit not found'));
    tg.sendMessage.mockRejectedValueOnce(tgError("can't parse entities"));
    await deliverReply(tg as SkillTelegram, 1, 55, { ok: true, text: 'a_b' });
    expect(tg.sendMessage).toHaveBeenCalledTimes(2);
    expect(tg.sendMessage.mock.calls[1]).toEqual([1, 'a_b', PLAIN]);
  });

  it('no ⏳ message id → sends a new message', async () => {
    const tg = fakeTg();
    await deliverReply(tg as SkillTelegram, 1, null, { ok: true, text: 'x' });
    expect(tg.editMessageText).not.toHaveBeenCalled();
    expect(tg.sendMessage).toHaveBeenCalledWith(1, 'x', MD);
  });

  it('bot-made failure lines go out as plain text', async () => {
    const tg = fakeTg();
    const r: EngineReply = { ok: false, text: '⚠️ Engine error (HTTP 500): rate_limited', plain: true };
    await deliverReply(tg as SkillTelegram, 1, 55, r);
    expect(tg.editMessageText).toHaveBeenCalledWith(1, 55, undefined, r.text, PLAIN);
  });

  it('"message is not modified" → nothing more is sent', async () => {
    const tg = fakeTg();
    tg.editMessageText.mockRejectedValueOnce(tgError('message is not modified: specified new message content and reply markup are exactly the same'));
    await deliverReply(tg as SkillTelegram, 1, 55, { ok: true, text: 'same' });
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it('never throws when Telegram refuses everything (logs a redacted warning)', async () => {
    const tg = fakeTg();
    tg.editMessageText.mockRejectedValue(tgError('chat not found'));
    tg.sendMessage.mockRejectedValue(tgError('chat not found'));
    await expect(deliverReply(tg as SkillTelegram, 1, 55, { ok: true, text: 'x' })).resolves.toBeUndefined();
    expect(hoisted.warn.some(w => w.includes('could not deliver'))).toBe(true);
  });

  it('clampText cuts on a line boundary under the Telegram limit', () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(10)}`).join('\n');
    const out = clampText(long);
    expect(out.length).toBeLessThanOrEqual(TG_SEND_MAX);
    expect(long.startsWith(out)).toBe(true);
    expect(long[out.length]).toBe('\n');
    expect(clampText('short')).toBe('short');
  });
});

// ── registerSkillCommands (handlers) ────────────────────────────────────────

describe('registerSkillCommands', () => {
  it('registers the 21 commands and one sk: action', () => {
    const { commands, actions } = setup(httpReturning(() => envelope({ ok: true, text: 'x' })));
    expect([...commands.keys()].sort()).toEqual(SKILL_BOT_COMMANDS.map(c => c.command).sort());
    expect(actions).toHaveLength(1);
    expect(actions[0].re).toBe(SKILL_CALLBACK_RE);
  });

  it('non-blocking: the handler returns before the Engine answers; ⏳ is then edited with the result', async () => {
    const d = deferredHttp();
    const { run, tg } = setup(d.fn);
    const { p } = run(`/dd ${CA}`);
    await p;                                            // resolved while the request is still pending
    await vi.waitFor(() => expect(d.calls).toHaveLength(1));
    expect(d.calls[0]).toBe(`${URL_BASE}/api/skills/dd/${CA}`);
    expect(d.reqs[0].headers.Authorization).toBe(`Bearer ${SECRET}`);   // A30: the skill request carries the link headers
    expect(tg.sendMessage).toHaveBeenCalledWith(1, RUNNING_TEXT);
    expect(tg.editMessageText).not.toHaveBeenCalled();
    d.resolveNext(envelope({ ok: true, text: '🟢 *DD 82/100*' }));
    await vi.waitFor(() => expect(tg.editMessageText).toHaveBeenCalledTimes(1));
    expect(tg.editMessageText.mock.calls[0]).toEqual([1, 101, undefined, '🟢 *DD 82/100*', { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }]);
  });

  it('bare /wallet falls through to the bot\'s own wallet card; /wallet <addr> runs the skill', async () => {
    const onCommand = vi.fn();
    const f = httpReturning(() => envelope({ ok: true, text: 'dossier' }));
    const { run, tg } = setup(f, { onCommand });
    const bare = run('/wallet');
    await bare.p;
    expect(bare.next).toHaveBeenCalledTimes(1);
    expect(onCommand).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();

    const withAddr = run(`/wallet ${USDC}`);
    await withAddr.p;
    expect(withAddr.next).not.toHaveBeenCalled();
    expect(onCommand).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(tg.editMessageText).toHaveBeenCalled());
    expect(f.mock.calls[0][0].url).toBe(`${URL_BASE}/api/skills/wallet/${USDC}`);
  });

  it('bad arguments → usage reply, no Engine call (onCommand still clears the prompt)', async () => {
    const onCommand = vi.fn();
    const f = httpReturning(() => envelope({ ok: true, text: 'x' }));
    const { run, tg } = setup(f, { onCommand });
    await run(`/dd ${EVM}`).p;
    await run('/search').p;
    expect(f).not.toHaveBeenCalled();
    expect(onCommand).toHaveBeenCalledTimes(2);
    expect(tg.sendMessage.mock.calls[0][1]).toMatch(/Solana addresses only/);
    expect(tg.sendMessage.mock.calls[0][2]).toBeUndefined();   // plain text
    expect(tg.sendMessage.mock.calls[1][1]).toMatch(/^Usage: \/search/);
  });

  it('R9CL2-T03 a removed command has no handler (nothing reaches the Engine) and the old Narrative button is no handled callback', () => {
    const f = httpReturning(() => envelope({ ok: true, text: 'x' }));
    const { commands, actions } = setup(f);
    for (const cmd of ['narrative', 'news', 'radar', 'tracked', 'pftrending', 'vetting']) expect(commands.has(cmd), cmd).toBe(false);
    expect(actions[0].re.test(`sk:nr:${CA}`)).toBe(false);
    expect(actions[0].re.test(`sk:dd:${CA}`)).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it('one run in flight per chat+command; other commands and other chats are not blocked', async () => {
    const d = deferredHttp();
    const { run, tg } = setup(d.fn);
    await run(`/dd ${CA}`).p;
    await run(`/dd ${CA}`).p;                            // same chat, same command → refused
    await run(`/holders ${CA}`).p;                      // other command → runs
    await run(`/dd ${CA}`, 2).p;                        // other chat → runs
    await vi.waitFor(() => expect(d.calls).toHaveLength(3));
    expect(tg.sendMessage.mock.calls.some(c => /\/dd is still running/.test(String(c[1])))).toBe(true);
    for (let i = 0; i < 3; i++) d.resolveNext(envelope({ ok: true, text: 'done' }));
    await vi.waitFor(() => expect(tg.editMessageText).toHaveBeenCalledTimes(3));
  });

  it('5 s cooldown between starts of the same command', async () => {
    let t = 1_000_000;
    const f = httpReturning(() => envelope({ ok: true, text: 'hot list' }));
    const { run, tg } = setup(f, { now: () => t });
    await run('/hot').p;
    await vi.waitFor(() => expect(tg.editMessageText).toHaveBeenCalledTimes(1));   // finished: no longer in flight
    t += SKILL_COOLDOWN_MS - 1500;
    await run('/hot').p;
    expect(f).toHaveBeenCalledTimes(1);
    expect(tg.sendMessage.mock.calls.at(-1)![1]).toBe('⏳ /hot was just run — try again in 2s.');
    t += 1500;
    await run('/hot').p;
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(2));
  });

  it('Engine offline → ⏳ edited with the plain offline line', async () => {
    const refused = vi.fn(async () => { throw new HttpError('network', 'connect ECONNREFUSED 127.0.0.1'); });
    const { run, tg } = setup(refused);
    await run('/hot').p;
    await vi.waitFor(() => expect(tg.editMessageText).toHaveBeenCalled());
    expect(tg.editMessageText.mock.calls[0][3]).toBe(ENGINE_OFFLINE_TEXT);
    expect(tg.editMessageText.mock.calls[0][4]).toEqual({ link_preview_options: { is_disabled: true } });
  });

  it('⏳ placeholder could not be sent → the result still arrives as a new message', async () => {
    const f = httpReturning(() => envelope({ ok: true, text: 'migrated list' }));
    const { run, tg } = setup(f);
    tg.sendMessage.mockRejectedValueOnce(new Error('network'));
    await run('/migrated').p;
    await vi.waitFor(() => expect(tg.sendMessage).toHaveBeenCalledTimes(2));
    expect(tg.editMessageText).not.toHaveBeenCalled();
    expect(tg.sendMessage.mock.calls[1][1]).toBe('migrated list');
    expect(f.mock.calls[0][0].url).toBe(`${URL_BASE}/api/skills/migrated-quality`);
  });

  it('CALLS-T09 /calls is registered and relays the Engine text verbatim over the link', async () => {
    // registered: ONE menu row inside Telegram's limits, once in the merged menu, and a handler on the bot
    const row = { command: 'calls', description: '📣 GMGN call-outs: who is calling which token' };
    expect(SKILL_BOT_COMMANDS.filter(c => c.command === 'calls')).toEqual([row]);
    expect(row.command).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(row.description.length).toBeGreaterThanOrEqual(1);
    expect(row.description.length).toBeLessThanOrEqual(256);
    const menu = withSkillCommands([{ command: 'menu', description: 'Menu' }, { command: 'wallet', description: 'old' }]);
    expect(menu.filter(c => c.command === 'calls')).toEqual([row]);
    expect(new Set(menu.map(c => c.command)).size).toBe(menu.length);

    // an Engine text with everything a relay could damage: Markdown, code spans, em dashes for unknown values, line breaks.
    // It is the Engine's layout of a call-out, four lines a row: the symbol in a code span with the call cap and the age; peak and now
    // with the labelled fields KOL and check; the caller in a code span with the holding; the token address in a code span.
    const engineText = [
      '📣 *GMGN call-outs* · SOL · newest first',
      '',
      '`CATE` · called at $41.2K · 12.0 min ago',
      'peak 3.4× · now 1.9× · KOL yes · check safe',
      'caller `some_caller` · holds $0',
      `\`${CA}\``,
      '',
      '— · called at — · just now',
      'peak — · now — · KOL — · check risk',
      `caller \`${USDC.slice(0, 4)}…${USDC.slice(-4)}\` · holds —`,
      `\`${USDC}\``,
      '',
      'A call-out is a public post, not a trade. Peak = highest multiple since the call. Showing 2 of 2 from the newest page, 1 by KOLs.',
    ].join('\n');
    const f = httpReturning(() => envelope({ ok: true, text: engineText, data: { total: 2, kol: 1 }, generatedAt: NOW }));
    const { commands, run, tg } = setup(f);
    expect(commands.has('calls')).toBe(true);

    const { p, next } = run('/calls');
    await p;
    await vi.waitFor(() => expect(tg.editMessageText).toHaveBeenCalledTimes(1));
    expect(next).not.toHaveBeenCalled();

    // over the link: ONE GET on the Engine's skill route with the link bearer, through the HTTP seam
    expect(f).toHaveBeenCalledTimes(1);
    const req = f.mock.calls[0][0];
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${URL_BASE}/api/skills/calls`);
    expect(req.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(req.timeoutMs).toBe(ENGINE_DEFAULT_TIMEOUT_MS);

    // verbatim: the ⏳ placeholder is edited with exactly that text, as Markdown with link previews off
    expect(tg.sendMessage).toHaveBeenCalledTimes(1);
    expect(tg.sendMessage).toHaveBeenCalledWith(1, RUNNING_TEXT);
    expect(tg.editMessageText.mock.calls[0]).toEqual([1, 101, undefined, engineText, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }]);
  });

  it('JRNL-T32 /feeds is registered and relays the Engine text verbatim over the link', async () => {
    // registered: ONE menu row inside Telegram's limits, once in the merged menu, a handler on the bot, and a route that takes no argument
    const row = { command: 'feeds', description: '📊 Signal journal: GMGN feeds next to our signals' };
    expect(SKILL_BOT_COMMANDS.filter(c => c.command === 'feeds')).toEqual([row]);
    expect(row.command).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(row.description.length).toBeGreaterThanOrEqual(1);
    expect(row.description.length).toBeLessThanOrEqual(256);
    const menu = withSkillCommands([{ command: 'menu', description: 'Menu' }, { command: 'wallet', description: 'old' }]);
    expect(menu.filter(c => c.command === 'feeds')).toEqual([row]);
    expect(new Set(menu.map(c => c.command)).size).toBe(menu.length);
    expect(parseSkillArgs('feeds', '/feeds')).toEqual({ ok: true, path: '/api/skills/feeds', timeoutMs: ENGINE_DEFAULT_TIMEOUT_MS });

    // an Engine text with everything a relay could damage: bold spans, the × of a multiple, em dashes for unknown values, empty lines
    // and the words "(budget)". It is the Engine's layout of the journal report: the title, one block per UTC day (a bold header, a
    // line per recorded source, the line for the sources that are not recorded, the Engine's own signals, the entries that were not
    // measured) and the closing line.
    const engineText = [
      '📊 *Signal journal* · UTC days · 6 h after the first alert, 5 min candles',
      '',
      '*Today*',
      'Smart Money Buy Signal: n seen · n measured · n winners · n rugs · n open · median peak n×',
      'KOL Buy Signal: n seen · n measured · n winners · n rugs · n open · median peak n×',
      'KOL / platform call: n seen · n measured · n winners · n rugs · n open · median peak —',
      'Call-outs: n seen · n measured · n winners · n rugs · n open · median peak n×',
      'Price up, all-time high, Pump claim, bundler sell, CTO: not recorded (off until a GMGN probe accepts these types)',
      'Engine signals: n fired · n winners · n rugs · n flat · n open · median peak n× (own 1 min measure)',
      'not measured: n left out (budget) · n late start · n no candles · n waiting',
      '',
      '*Yesterday*',
      'Smart Money Buy Signal: n seen · n measured · n winners · n rugs · n open · median peak n×',
      'KOL Buy Signal: n seen · n measured · n winners · n rugs · n open · median peak n×',
      'KOL / platform call: n seen · n measured · n winners · n rugs · n open · median peak —',
      'Call-outs: n seen · n measured · n winners · n rugs · n open · median peak n×',
      'Price up, all-time high, Pump claim, bundler sell, CTO: not recorded (off until a GMGN probe accepts these types)',
      'Engine signals: n fired · n winners · n rugs · n flat · n open · median peak n× (own 1 min measure)',
      'not measured: n left out (budget) · n late start · n no candles · n waiting',
      '',
      'Winner = a close at 2× before a close at 0.65×; rug = the reverse; open = neither within 6 h. '
        + 'A token counts once per source and 24 h. Measured rows are a sample, read about 7 h after the alert.',
    ].join('\n');
    const offText = '⚪ signal journal: off';   // the Engine's one line while its journal is off
    let answer: object = { ok: true, text: engineText, data: { extraSignals: 'off' }, generatedAt: NOW };
    const f = httpReturning(() => envelope(answer));
    const { commands, run, tg } = setup(f);
    expect(commands.has('feeds')).toBe(true);

    const { p, next } = run('/feeds');
    await p;
    await vi.waitFor(() => expect(tg.editMessageText).toHaveBeenCalledTimes(1));
    expect(next).not.toHaveBeenCalled();

    // over the link: ONE GET on the Engine's skill route with the link bearer, through the HTTP seam, on the default timeout
    expect(f).toHaveBeenCalledTimes(1);
    const req = f.mock.calls[0][0];
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${URL_BASE}/api/skills/feeds`);
    expect(req.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(req.timeoutMs).toBe(ENGINE_DEFAULT_TIMEOUT_MS);

    // verbatim: the ⏳ placeholder is edited with exactly that text, as Markdown with link previews off
    expect(tg.sendMessage).toHaveBeenCalledTimes(1);
    expect(tg.sendMessage).toHaveBeenCalledWith(1, RUNNING_TEXT);
    expect(tg.editMessageText.mock.calls[0]).toEqual([1, 101, undefined, engineText, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }]);

    // the one line of a journal that is off comes through the same way (asked from another chat: the first one is in its cooldown)
    answer = { ok: true, text: offText, data: { active: false }, generatedAt: NOW };
    await run('/feeds', 2).p;
    await vi.waitFor(() => expect(tg.editMessageText).toHaveBeenCalledTimes(2));
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[1][0].url).toBe(`${URL_BASE}/api/skills/feeds`);
    expect(tg.editMessageText.mock.calls[1]).toEqual([2, 102, undefined, offText, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }]);
  });

  it('CALLR-T08 /caller <wallet> is registered, validates the address, uses the long timeout and relays the Engine text verbatim', async () => {
    // registered: ONE menu row inside Telegram's limits, once in the merged menu, and a handler on the bot
    const row = { command: 'caller', description: '📣 GMGN caller record: /caller <wallet>' };
    expect(SKILL_BOT_COMMANDS.filter(c => c.command === 'caller')).toEqual([row]);
    expect(row.command).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(row.description.length).toBeGreaterThanOrEqual(1);
    expect(row.description.length).toBeLessThanOrEqual(256);
    const menu = withSkillCommands([{ command: 'menu', description: 'Menu' }, { command: 'wallet', description: 'old' }]);
    expect(menu.filter(c => c.command === 'caller')).toEqual([row]);
    expect(new Set(menu.map(c => c.command)).size).toBe(menu.length);

    // validates the address: a real 32-byte base58 key gives the route of that wallet, on the long timeout (words after the wallet are
    // ignored); no wallet, an EVM address and anything else that is no such key give a usage line and no route
    const WALLET = USDC;   // a public address that is a valid key
    const route = { ok: true, path: `/api/skills/caller/${WALLET}`, timeoutMs: ENGINE_NARRATIVE_TIMEOUT_MS };
    expect(ENGINE_NARRATIVE_TIMEOUT_MS).toBeGreaterThan(ENGINE_DEFAULT_TIMEOUT_MS);
    expect(parseSkillArgs('caller', `/caller ${WALLET}`)).toEqual(route);
    expect(parseSkillArgs('caller', `/caller@PumpStrikerBot   ${WALLET}  and more words`)).toEqual(route);
    const usage = 'Usage: /caller <wallet>';
    expect(parseSkillArgs('caller', '/caller')).toEqual({ ok: false, usage });
    const evm = parseSkillArgs('caller', `/caller ${EVM}`);
    expect(evm.ok).toBe(false);
    if (!evm.ok) expect(evm.usage).toMatch(/Solana addresses only/);
    const notAKey = [
      'nope', 'O0Il' + WALLET.slice(4), WALLET + 'x', 'z'.repeat(44), `${WALLET.slice(0, 20)}:${WALLET.slice(21)}`,
      `${WALLET}/../calls`, `${WALLET}?limit=500`, '..%2Fcalls',
    ];
    for (const bad of notAKey) expect(parseSkillArgs('caller', `/caller ${bad}`), bad).toEqual({ ok: false, usage: `❌ Invalid wallet address. ${usage}` });

    // the Engine's layout of a caller record: nine lines of numbers, the handle and the shortened wallet in code spans, the × of a
    // multiple, an em dash for what is unknown; and the one line it sends when it could not read a record
    const engineText = [
      '📣 *GMGN caller record* · SOL · last 30 days',
      `caller \`some_caller\` · wallet \`${WALLET.slice(0, 4)}…${WALLET.slice(-4)}\``,
      'calls 522 (GMGN, 30 d) · 150 newest read · more on GMGN',
      'reached 2× at the peak: 61 of 522 (GMGN, 30 d) · 18 of 143 read',
      'median peak 1.4× · best 37× · average 1.9× (best and average: GMGN, 30 d)',
      'below the call price now: 97 of 141 read with a price',
      'still holds: —',
      'newest call 3.2 h ago · oldest read 6.1 days ago',
      'A call-out is a public post, not a trade. Peak = highest multiple since the call. Numbers from GMGN, no score.',
    ].join('\n');
    const downText = '⚪ caller record unavailable: caller record — (budget)';
    let answer: object = { ok: true, text: engineText, data: { pages: 3, rowsRead: 150 }, generatedAt: NOW };
    const f = httpReturning(() => envelope(answer));
    const { commands, run, tg } = setup(f);
    expect(commands.has('caller')).toBe(true);

    // an address that is no key never reaches the Engine: the owner gets the usage line as plain text
    await run('/caller').p;
    await run(`/caller ${EVM}`).p;
    await run(`/caller ${'z'.repeat(44)}`).p;
    expect(f).not.toHaveBeenCalled();
    expect(tg.editMessageText).not.toHaveBeenCalled();
    expect(tg.sendMessage.mock.calls.map(c => c[1])).toEqual([usage, expect.stringMatching(/Solana addresses only/), `❌ Invalid wallet address. ${usage}`]);
    expect(tg.sendMessage.mock.calls.map(c => c[2])).toEqual([undefined, undefined, undefined]);   // plain text

    const { p, next } = run(`/caller ${WALLET}`);
    await p;
    await vi.waitFor(() => expect(tg.editMessageText).toHaveBeenCalledTimes(1));
    expect(next).not.toHaveBeenCalled();

    // over the link: ONE GET on the route of that wallet with the link bearer, through the HTTP seam, on the long timeout
    expect(f).toHaveBeenCalledTimes(1);
    const req = f.mock.calls[0][0];
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${URL_BASE}/api/skills/caller/${WALLET}`);
    expect(req.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(req.timeoutMs).toBe(ENGINE_NARRATIVE_TIMEOUT_MS);

    // verbatim: the ⏳ placeholder (the fourth message of this chat, after the three usage lines) is edited with exactly that text,
    // as Markdown with link previews off
    expect(tg.sendMessage).toHaveBeenCalledTimes(4);
    expect(tg.sendMessage).toHaveBeenLastCalledWith(1, RUNNING_TEXT);
    expect(tg.editMessageText.mock.calls[0]).toEqual([1, 104, undefined, engineText, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }]);

    // the Engine's line for a record it could not read (an ok:false envelope) comes through the same way (asked from another chat:
    // the first one is in its cooldown)
    answer = { ok: false, text: downText, data: null, generatedAt: NOW };
    await run(`/caller ${WALLET}`, 2).p;
    await vi.waitFor(() => expect(tg.editMessageText).toHaveBeenCalledTimes(2));
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[1][0].timeoutMs).toBe(ENGINE_NARRATIVE_TIMEOUT_MS);
    expect(tg.editMessageText.mock.calls[1]).toEqual([2, 105, undefined, downText, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }]);
  });

  it('sk: taps answer the callback first, then run the mapped skill', async () => {
    const d = deferredHttp();
    const { tap, tg } = setup(d.fn);
    const pt = tap(`sk:pt:${CA}`);
    await pt.p;
    expect(pt.answerCbQuery).toHaveBeenCalledTimes(1);
    expect(pt.answerCbQuery.mock.calls[0][0]).toBeUndefined();
    await vi.waitFor(() => expect(d.calls).toHaveLength(1));
    expect(d.calls[0]).toBe(`${URL_BASE}/api/skills/pattern/${CA}?res=15m`);
    await tap(`sk:ho:${CA}`).p;
    await vi.waitFor(() => expect(d.calls).toHaveLength(2));
    expect(d.calls[1]).toBe(`${URL_BASE}/api/skills/holders/${CA}`);
    d.resolveNext(envelope({ ok: true, text: 'p' }));
    d.resolveNext(envelope({ ok: true, text: 'h' }));
    await vi.waitFor(() => expect(tg.editMessageText).toHaveBeenCalledTimes(2));
  });

  it('a tap while the same skill runs → toast, no second Engine call', async () => {
    const d = deferredHttp();
    const { run, tap } = setup(d.fn);
    await run(`/dd ${CA}`).p;
    const again = tap(`sk:dd:${CA}`);
    await again.p;
    expect(again.answerCbQuery.mock.calls[0][0]).toMatch(/\/dd is still running/);
    await vi.waitFor(() => expect(d.calls).toHaveLength(1));
    d.resolveNext(envelope({ ok: true, text: 'x' }));
  });

  it('sk: callback regex: only the 5 codes and a base58 32-44 address; ≤ 64 bytes', () => {
    expect(SKILL_CALLBACK_RE.test(`sk:dd:${CA}`)).toBe(true);
    expect(SKILL_CALLBACK_RE.test(`sk:xx:${CA}`)).toBe(false);
    expect(SKILL_CALLBACK_RE.test(`sk:dd:${CA}:1`)).toBe(false);
    expect(SKILL_CALLBACK_RE.test(`sk:dd:${EVM}`)).toBe(false);
    expect(SKILL_CALLBACK_RE.test(`buy:${CA}:1`)).toBe(false);
  });

  it('a regex-shaped but invalid address in a tap is refused without an Engine call', async () => {
    const f = httpReturning(() => envelope({ ok: true, text: 'x' }));
    const { tap } = setup(f);
    const t = tap(`sk:dd:${'z'.repeat(44)}`);
    await t.p;
    expect(t.answerCbQuery).toHaveBeenCalledWith('❌ Invalid token address');
    expect(f).not.toHaveBeenCalled();
  });
});

// ── bot.ts wiring (source-level; bot.ts launches the bot on import) ─────────

describe('bot.ts wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, 'bot.ts'), 'utf8');
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    expect(i, `bot.ts should contain: ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  it('registerSkillCommands sits after the access gate + secret guard and before /start, /wallet and the callback handler', () => {
    const reg = at('registerSkillCommands(bot, { onCommand: () => { sess.awaitingInput = null; } });');
    expect(at('bot.use((ctx, next) => isAllowedUpdate(ctx.update, OWNER_ID)')).toBeLessThan(reg);
    expect(at('if (!shouldDeleteForSecrets(text.trim())) return next();')).toBeLessThan(reg);
    // Handler registrations (not the mentions in comments).
    expect(reg).toBeLessThan(at('bot.start(async'));
    expect(reg).toBeLessThan(at("bot.command('wallet', async"));
    expect(reg).toBeLessThan(at("bot.on('callback_query', async"));
  });

  it('command menu uses withSkillCommands; the 🔬 row is on the /signal card, the token report and /check', () => {
    at('setMyCommands(withSkillCommands([');
    // the token report, the deep link, /check and (A-115) the skills row of the signal card
    expect(src.match(/skillButtonsRow\(ca\)/g) || []).toHaveLength(4);
  });
});
