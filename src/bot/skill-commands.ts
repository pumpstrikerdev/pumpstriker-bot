/**
 * GMGN skill commands (2026-09-26, rebuilt 2026-10 per WI-C §3.22; B50 section 2, R3-B5).
 *
 * Every GMGN skill the Engine runs is reachable from the bot. The Engine does
 * the work (`GET ${ENGINE_URL}/api/skills/*`, envelope `{ ok, text, data,
 * error? }` where `text` is ready-to-send Telegram Markdown v1, ≤ 3500 chars);
 * this module only validates the arguments, gates spam, calls the Engine and
 * delivers the text.
 *
 *   /dd <ca>  /pattern <ca> [res]  /holders <ca>  /dev <ca>  /hot
 *   /wallet <addr>  /surge  /watchlist  /swings  /search <q>
 * WI-G (2026-10):
 *   /migrated  /devinfo <ca>  /balance <wallet> <ca>  /review <wallet> [1d|7d|30d|all] [me]
 * R3-B5:
 *   /report <ca>  the token report, rendered here from `EngineClient.token` (the Engine's GMGN snapshot), every value with its age
 *                 and an em dash for what the Engine does not know
 * A-141 (2026-11-14):
 *   /calls  GMGN's public call-out feed (who is calling which token); the Engine writes the text, the bot relays it unchanged
 * A-142 (2026-11-15):
 *   /feeds  the report of the Engine's signal journal (GMGN's feeds next to the Engine's own signals, today and yesterday); no
 *           argument and no GMGN call; the Engine writes the text, the bot relays it unchanged
 *   /caller <wallet>  the call-out record of ONE wallet (GMGN, the last 30 days, numbers only); the address is checked here, the
 *           request waits on the long timeout; the Engine writes the text, the bot relays it unchanged
 *
 * plus the "🔬 DD · Pattern · Holders · Dev" button row
 * (callback data `sk:<dd|pt|ho|dv>:<ca>`, ≤ 50 bytes) that bot.ts puts on
 * the /signal card, the pasted-CA token report and /check.
 *
 * LINK AUTH (A-30): the Engine's `/api/skills/*` and `/api/bot/v1/*` routes sit behind the link bearer. Every request is sent with
 * `linkHeaders(secret)` through link/common.ts `defaultHttp` (node:http), NEVER through Node's global fetch: that adds a
 * `Sec-Fetch-Mode` header and the Engine's link auth refuses it with 403. With no usable secret nothing is sent.
 *
 * Security (2026-09-29 hardening, access-control.ts): bot.ts registers this
 * AFTER the update-level access gate and the secret guard, so every command
 * and every `sk:` tap here is owner-only and private-chat-only, and a key
 * pasted as an argument is deleted before it reaches a handler. Addresses are
 * checked with trade-guards `validateCa` (real 32-byte base58 key); chat
 * error text is redacted (lib/redact.ts).
 *
 * Non-blocking: Telegraf's polling loop awaits a whole update batch
 * (`await Promise.all(updates.map(handleUpdate))`), so an awaited 60 s
 * Engine call would freeze every button, sells included. Handlers validate
 * and gate synchronously, start the Engine call in the background
 * (`void run()`), and return.
 *
 * Anti-spam: per chat AND per command, at most one run in flight plus a 5 s
 * cooldown between starts (so a stuck finger can't hammer GMGN through the
 * Engine).
 */

import { Telegraf, Context, Markup } from 'telegraf';
import { CONFIG } from '../config';
import { logWarn } from '../logger';
import { redactSecrets } from '../lib/redact';
import type { EngineClient } from '../bot-contracts';
import type { TokenProxyResponse } from '../shared/contract/v1';
import { linkHeaders } from '../shared/link-auth';
import { createEngineClient } from '../link/engine-client';
import { defaultHttp, isTimeout, trimBase, type HttpFn, type HttpResponse } from '../link/common';
import { isEntityParseError, mdSafe } from './md-safe';
import { validateCa } from './trade-guards';

export const ENGINE_DEFAULT_TIMEOUT_MS   = 15_000;
export const ENGINE_NARRATIVE_TIMEOUT_MS = 60_000;
export const SKILL_COOLDOWN_MS           = 5_000;
export const QUERY_MAX                   = 64;

export const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** = Engine `KLINE_PATTERN_RESOLUTIONS` (src/skills/kline-pattern.ts). */
export const PATTERN_RESOLUTIONS = ['30s', '1m', '5m', '15m', '1h', '4h', '1d'];
export const PATTERN_DEFAULT_RES = '15m';
export const RADAR_CHAINS = ['sol', 'base', 'bsc'];

/** "⏳" placeholder text, edited in place with the result. */
export const RUNNING_TEXT = '⏳ Running…';
/** Quoted from the Sep 26 report (NAR L743). */
export const ENGINE_OFFLINE_TEXT = '🔌 Engine is offline — start Engine\\start-engine.bat';
/** The link secret is missing or shorter than 32 characters: nothing is sent. */
export const LINK_OFF_TEXT = '⚠️ The Engine link is not configured (SIGNAL_SHARED_SECRET missing or too short) — nothing was sent';

/**
 * REBUILD-CHOSEN: Telegram rejects messages over 4096 chars; the Engine
 * already caps its text at 3500, this is only a backstop (cut on a line
 * boundary, same 4000 as the Engine's tg-send.ts).
 */
export const TG_SEND_MAX = 4000;

/** The 18 skill commands (10 WI-C + 4 WI-G + /report + /calls + /feeds + /caller), spread into setMyCommands by bot.ts (via withSkillCommands). */
// REBUILD-CHOSEN: descriptions (the Sep 26 wording is lost); /wallet keeps the
// bot's own wallet card and mentions the new `<addr>` dossier.
export const SKILL_BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'dd',         description: '🔬 Due-diligence score — /dd <CA>' },
  { command: 'pattern',    description: '📈 Chart pattern — /pattern <CA> [15m]' },
  { command: 'holders',    description: '👥 Holder analysis — /holders <CA>' },
  { command: 'dev',        description: '🛠 Dev score — /dev <CA>' },
  { command: 'hot',        description: '🔥 GMGN hot list' },
  { command: 'wallet',     description: '👛 Wallet & balance · /wallet <addr> = wallet dossier' },
  { command: 'surge',      description: '⚡ Screened price-surge signals' },
  { command: 'watchlist',  description: '👀 GMGN watchlist tokens' },
  { command: 'swings',     description: '📉 Watchlist price swings' },
  { command: 'search',     description: '🔎 Token / wallet search — /search <query>' },
  // WI-G (2026-10). REBUILD-CHOSEN descriptions except /review (G7-requests R2).
  { command: 'migrated',   description: '🎓 Migrated token quality screen' },
  { command: 'devinfo',    description: '👤 Dev info — /devinfo <CA>' },
  { command: 'balance',    description: '💼 Wallet token balance — /balance <wallet> <CA>' },
  { command: 'review',     description: '🔎 Wallet review — /review <wallet> [1d|7d|30d|all]' },
  // R3-B5: rendered by the bot from the Engine's token snapshot
  { command: 'report',     description: '📋 Token report — /report <CA>' },
  // A-141 (2026-11-14): GMGN's public call-out feed; no argument, the Engine's text is relayed as it is
  { command: 'calls',      description: '📣 GMGN call-outs: who is calling which token' },
  // A-142 (2026-11-15): the report of the Engine's signal journal (no argument) and the call-out record of one wallet; for both
  // the Engine's text is relayed as it is
  { command: 'feeds',      description: '📊 Signal journal: GMGN feeds next to our signals' },
  { command: 'caller',     description: '📣 GMGN caller record: /caller <wallet>' },
];

/** WI-G §2.5: /review periods (the Engine also accepts 24h 1w 1m total). */
export const REVIEW_PERIODS = ['1d', '7d', '30d', 'all'];
const REVIEW_PERIOD_ALIASES: Record<string, string> = { '24h': '1d', '1w': '7d', '1m': '30d', total: 'all' };

/**
 * REBUILD-CHOSEN: merge the skill commands into the bot's existing menu
 * without duplicates. bot.ts already lists `/wallet`; a duplicate command in
 * setMyCommands risks Telegram refusing the WHOLE menu, so an existing entry
 * keeps its position and takes the skill description, and the rest are
 * appended in SKILL_BOT_COMMANDS order.
 */
export function withSkillCommands(base: { command: string; description: string }[]): { command: string; description: string }[] {
  const skill = new Map(SKILL_BOT_COMMANDS.map(c => [c.command, c.description] as const));
  const seen = new Set<string>();
  const out: { command: string; description: string }[] = [];
  for (const c of base) {
    if (seen.has(c.command)) continue;
    seen.add(c.command);
    out.push({ command: c.command, description: skill.get(c.command) ?? c.description });
  }
  for (const c of SKILL_BOT_COMMANDS) {
    if (seen.has(c.command)) continue;
    seen.add(c.command);
    out.push({ ...c });
  }
  return out;
}

export interface SkillCommandOpts {
  /** Called at the start of every skill command (bot.ts clears the pending input prompt). */
  onCommand?: () => void;
  /** The HTTP seam (default: link/common.ts defaultHttp, node:http). Never Node's global fetch, see A-30. */
  http?: HttpFn;
  engineUrl?: string;
  /** The link secret (default: CONFIG.SIGNAL_SHARED_SECRET). */
  secret?: () => string;
  /** The Engine client of /report (default: createEngineClient over the same http / engineUrl / secret). */
  engine?: Pick<EngineClient, 'token'>;
  now?: () => number;
}

/**
 * What gets sent. `text` is the Engine's Markdown on success (and on an
 * Engine-supplied `ok:false` text); every failure produced by the bot itself
 * is ONE plain-text line.
 * REBUILD-CHOSEN: `plain` marks those bot-made lines so they go out with no
 * parse_mode (an Engine error string with `_` must not be eaten as italics).
 */
export type EngineReply = { ok: true; text: string } | { ok: false; text: string; plain?: boolean };

// ── Engine call ─────────────────────────────────────────────────────────────

/** REBUILD-CHOSEN: connection-level failures reported as "Engine is offline". */
const OFFLINE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH']);

function errorCodes(e: any): string[] {
  const codes: string[] = [];
  const push = (v: unknown) => { if (typeof v === 'string' && v) codes.push(v); };
  push(e?.code);
  push(e?.cause?.code);
  for (const x of [e?.errors, e?.cause?.errors]) {
    if (Array.isArray(x)) for (const y of x) push(y?.code);
  }
  return codes;
}

/** A refused / unresolvable connection: by error code, or by the code names inside the message (defaultHttp keeps only the message). */
function isOffline(e: any): boolean {
  if (errorCodes(e).some(c => OFFLINE_CODES.has(c))) return true;
  const msg = String(e?.message ?? '');
  return [...OFFLINE_CODES].some(c => msg.includes(c));
}

/** One redacted line: tags stripped, whitespace collapsed, ≤ max chars. */
function oneLine(s: unknown, max = 200): string {
  return redactSecrets(String(s ?? ''))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function fmtTimeout(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

/** `/api/skills/dd/<ca>?x=1` → `/api/skills/dd` (no CA/wallet, no query) for messages. */
function routeLabel(path: string): string {
  const p = path.split('?')[0];
  const parts = p.split('/');
  // WI-G: /api/skills/balance/<wallet>/<ca> ends in two addresses — drop every trailing one.
  while (parts.length > 1 && SOLANA_ADDR_RE.test(parts[parts.length - 1])) parts.pop();
  return parts.join('/') || '/';
}

/** The dashboard SPA fallback / Express "Cannot GET" page: the body is markup, not the JSON envelope. (The HTTP seam returns no headers.) */
function looksLikeHtml(body: string): boolean {
  return body.trimStart().startsWith('<');
}

function fail(text: string): EngineReply {
  return { ok: false, text, plain: true };
}

/**
 * GET `${engineUrl}${path}` with the link bearer and a timeout, and turn every outcome into the text to send. Never throws.
 * `http` is the HTTP seam (default node:http); with no usable secret nothing is sent (LINK_OFF_TEXT).
 */
export async function callEngine(
  path: string,
  timeoutMs: number,
  http: HttpFn = defaultHttp,
  engineUrl: string = CONFIG.ENGINE_URL,
  secret: () => string = () => CONFIG.SIGNAL_SHARED_SECRET,
): Promise<EngineReply> {
  const headers = linkHeaders(secret());
  if (headers === null) return fail(LINK_OFF_TEXT);
  const url = `${trimBase(String(engineUrl || ''))}${path}`;
  try {
    let res: HttpResponse;
    try {
      res = await http({ method: 'GET', url, headers: { ...headers, Accept: 'application/json' }, timeoutMs });
    } catch (e: any) {
      if (isTimeout(e)) return fail(`⌛ Engine did not answer in ${fmtTimeout(timeoutMs)}`);
      if (isOffline(e)) return fail(ENGINE_OFFLINE_TEXT);
      return fail(`⚠️ Engine request failed: ${oneLine(e?.message || e)}`);
    }

    const status = res.status;
    const body = String(res.body ?? '');
    const isOk = status >= 200 && status < 300;

    let json: any;
    let isJson = false;
    try { json = JSON.parse(body); isJson = true; } catch { /* not JSON */ }

    if (isJson && json && typeof json === 'object' && !Array.isArray(json)) {
      if (typeof json.ok === 'boolean' && typeof json.text === 'string') {
        if (json.ok) {
          return json.text.trim()
            ? { ok: true, text: json.text }
            : fail(`⚠️ Engine sent an empty reply for ${routeLabel(path)}`);
        }
        if (json.text.trim()) return { ok: false, text: json.text };
        if (typeof json.error === 'string' && json.error.trim()) return fail(`⚠️ ${oneLine(json.error, 300)}`);
        return fail(`⚠️ Engine reported an error (HTTP ${status})`);
      }
      if (!isOk) {
        const detail = typeof json.error === 'string' ? json.error : JSON.stringify(json);
        return fail(`⚠️ Engine error (HTTP ${status}): ${oneLine(detail)}`);
      }
      return fail('⚠️ Engine reply is missing the {ok,text} envelope');
    }

    if (looksLikeHtml(body) && (isOk || status === 404)) {
      // The dashboard SPA fallback (or Express "Cannot GET") answers routes the Engine doesn't have.
      return fail(`⚠️ Engine has no ${routeLabel(path)} route yet — update and restart the Engine`);
    }
    if (!isOk) return fail(`⚠️ Engine error (HTTP ${status}): ${oneLine(body) || 'empty body'}`);
    if (isJson) return fail('⚠️ Engine reply is missing the {ok,text} envelope');
    return fail(`⚠️ Engine sent a non-JSON reply (HTTP ${status})`);
  } catch (e: any) {
    return fail(`⚠️ Engine request failed: ${oneLine(e?.message || e)}`);
  }
}

// ── /report: the token report, rendered from the Engine's GMGN snapshot ─────

const DASH = '—';

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return DASH;
  if (n === 0) return '$0';
  // below $1: four significant digits, never exponent notation
  if (n < 1) return `$${n.toFixed(Math.min(18, 3 - Math.floor(Math.log10(n)))).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}
const fmtSigned = (n: number): string => (Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}%` : DASH);
const fmtShare = (frac: number): string => (Number.isFinite(frac) ? `${(frac * 100).toFixed(1)}%` : DASH);   // a 0-1 fraction of the Engine
const fmtCount = (n: number): string => (Number.isFinite(n) ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : DASH);
function fmtMinutes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return DASH;
  if (n < 120) return `${Math.round(n)}m`;
  if (n < 2880) return `${(n / 60).toFixed(1)}h`;
  return `${(n / 1440).toFixed(1)}d`;
}

/** "12s", "3m", "2h" (an age from the Engine's as_of to `nowMs`; a reading from the future counts as 0). */
function ageWord(ms: number): string {
  const a = Math.max(0, ms);
  if (a < 120_000) return `${Math.round(a / 1000)}s`;
  if (a < 7_200_000) return `${Math.floor(a / 60_000)}m`;
  return `${Math.floor(a / 3_600_000)}h`;
}

type ProxyFields = TokenProxyResponse['fields'];

/** One numeric field: "value (age old)", or an em dash when the Engine does not know it. */
function fieldText(fields: ProxyFields, key: keyof ProxyFields, fmt: (n: number) => string, nowMs: number): string {
  const f = fields[key];
  if (!f || typeof f.value !== 'number' || !Number.isFinite(f.value)) return DASH;
  const v = fmt(f.value);
  if (v === DASH) return DASH;
  return typeof f.as_of === 'number' && Number.isFinite(f.as_of) ? `${v} (${ageWord(nowMs - f.as_of)} old)` : `${v} (age unknown)`;
}

function hhmmss(ms: number): string {
  if (!Number.isFinite(ms)) return '--:--:--';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * The /report text (Telegram Markdown v1): every value of the Engine's snapshot with the age of its own reading, an em dash for
 * every field the Engine does not know. Nothing is invented and no other source is consulted. Names pass mdSafe.
 */
export function renderTokenReport(ca: string, t: TokenProxyResponse, nowMs: number): string {
  const f = t.fields;
  const sym = typeof f.symbol?.value === 'string' ? mdSafe(f.symbol.value, 24) : '';
  const name = typeof f.name?.value === 'string' ? mdSafe(f.name.value, 32) : '';
  const venue = f.migrated?.value === true ? 'graduated (pool)' : f.migrated?.value === false && f.launchpad_status?.value === 0 ? 'bonding curve' : DASH;
  const lines = [
    `🪙 *${sym || DASH}* (${name || DASH})`,
    `\`${ca}\``,
    '',
    `💵 Price: ${fieldText(f, 'price_usd', fmtUsd, nowMs)}`,
    `🧢 MCap: ${fieldText(f, 'mcap_usd', fmtUsd, nowMs)}`,
    `💧 Liq: ${fieldText(f, 'liq_usd', fmtUsd, nowMs)} · Pool liq: ${fieldText(f, 'pool_liq_usd', fmtUsd, nowMs)}`,
    `📈 5m: ${fieldText(f, 'c5m_pct_info', fmtSigned, nowMs)} · 1h: ${fieldText(f, 'c1h_pct_info', fmtSigned, nowMs)}`,
    `📊 Vol 5m: ${fieldText(f, 'vol_5m_usd', fmtUsd, nowMs)} · Vol 1h: ${fieldText(f, 'vol_1h_usd', fmtUsd, nowMs)}`,
    `👥 Holders: ${fieldText(f, 'holder_count', fmtCount, nowMs)}`,
    `🔟 Top10: ${fieldText(f, 'top10_rate', fmtShare, nowMs)} · Creator: ${fieldText(f, 'creator_balance_rate', fmtShare, nowMs)}`,
    `🕒 Age: ${fieldText(f, 'age_min', fmtMinutes, nowMs)}`,
    `🚀 Venue: ${venue}`,
    `🧾 Engine snapshot ${hhmmss(t.asOf)} UTC · ages are from each reading`,
    '',
    `[GMGN](https://gmgn.ai/sol/token/${ca}) | [Jupiter](https://jup.ag/swap/SOL-${ca})`,
  ];
  return lines.join('\n');
}

/** The reply of /report: the rendered snapshot, or one plain line saying why there is none. */
export async function reportReply(engine: Pick<EngineClient, 'token'>, ca: string, nowMs: number): Promise<EngineReply> {
  let r: Awaited<ReturnType<EngineClient['token']>>;
  try {
    r = await engine.token(ca);
  } catch (e: any) {
    return fail(`⚠️ Engine request failed: ${oneLine(e?.message || e)}`);
  }
  if ('error' in r) {
    switch (r.error) {
      case 'engine_offline': return fail(ENGINE_OFFLINE_TEXT);
      case 'link_off': return fail(LINK_OFF_TEXT);
      case 'timeout': return fail('⌛ Engine did not answer in time');
      case 'budget': return fail('⏳ The Engine has no on-demand budget left right now — try again in a minute');
      case 'invalid_ca': return fail('❌ Invalid token address');
      default: return fail(`⚠️ Engine could not give a report (${oneLine(r.error, 40)})`);
    }
  }
  return { ok: true, text: renderTokenReport(ca, r, nowMs) };
}

// ── Arguments ───────────────────────────────────────────────────────────────

type ParsedArgs = { ok: true; path: string; timeoutMs: number } | { ok: false; usage: string };

/** Everything after `/cmd` or `/cmd@BotName`, whitespace-collapsed. */
function argText(text: string): string {
  return String(text || '').replace(/^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?/, '').replace(/\s+/g, ' ').trim();
}

function addrArg(raw: string | undefined, kind: 'token' | 'wallet', usage: string): { ok: true; addr: string } | { ok: false; usage: string } {
  if (!raw) return { ok: false, usage };
  if (EVM_ADDR_RE.test(raw)) return { ok: false, usage: '❌ Solana addresses only — EVM (0x…) addresses are not supported.' };
  const addr = validateCa(raw);
  if (!addr) return { ok: false, usage: `❌ Invalid ${kind} address. ${usage}` };
  return { ok: true, addr };
}

function queryArg(q: string): { ok: true; q: string } | { ok: false; usage: string } {
  if (q.length > QUERY_MAX) return { ok: false, usage: `❌ Query too long (max ${QUERY_MAX} characters).` };
  return { ok: true, q };
}

const ok = (path: string, timeoutMs = ENGINE_DEFAULT_TIMEOUT_MS): ParsedArgs => ({ ok: true, path, timeoutMs });

/** Feed/summary commands: no arguments (extra words are ignored). */
const NO_ARG_ROUTES: Record<string, string> = {
  hot:        '/api/skills/heat-rank',
  surge:      '/api/skills/surge',
  watchlist:  '/api/skills/watchlist',
  swings:     '/api/skills/watchlist/swings',
  migrated:   '/api/skills/migrated-quality',     // WI-G §2.1
  calls:      '/api/skills/calls',                // A-141
  feeds:      '/api/skills/feeds',                // A-142
};

const CA_ROUTES: Record<string, string> = {
  dd:        '/api/skills/dd/',
  holders:   '/api/skills/holders/',
  dev:       '/api/skills/dev/',
  devinfo:   '/api/skills/devinfo/',               // WI-G §2.2
};

/**
 * Commands that wait on the long Engine timeout: /review (≤ 15 GMGN calls incl. signed gmgn-cli pages, G7-requests R2).
 * REBUILD-CHOSEN: /devinfo and /balance too — a GMGN call (12 s timeout) plus
 * the on-chain RPC fallback (10 s) can exceed the 15 s default.
 * A-142: /caller too — the Engine reads up to three GMGN pages for one record (4 s timeout each, 1 s between two), which
 * alone can take 14 s of the 15 s default.
 */
const LONG_TIMEOUT_CMDS = new Set(['review', 'devinfo', 'balance', 'caller']);
const timeoutFor = (cmd: string) => (LONG_TIMEOUT_CMDS.has(cmd) ? ENGINE_NARRATIVE_TIMEOUT_MS : ENGINE_DEFAULT_TIMEOUT_MS);

/** The command names handled here (= SKILL_BOT_COMMANDS). */
export const SKILL_COMMANDS = SKILL_BOT_COMMANDS.map(c => c.command);

/**
 * Validate a command's arguments and build the Engine route.
 * `cmd` is the bare name (`dd`), `text` the whole message (`/dd <ca>`).
 * A removed command answers "not available in this build" as its usage line (no route, no Engine call). `/report` has no
 * Engine skill route: use `parseReportArgs`.
 */
export function parseSkillArgs(cmd: string, text: string): ParsedArgs {
  const rest = argText(text);
  const args = rest ? rest.split(' ') : [];

  if (cmd in NO_ARG_ROUTES) return ok(NO_ARG_ROUTES[cmd]);

  if (cmd in CA_ROUTES) {
    const a = addrArg(args[0], 'token', `Usage: /${cmd} <CA>`);
    if (!a.ok) return a;
    return ok(`${CA_ROUTES[cmd]}${a.addr}`, timeoutFor(cmd));
  }

  switch (cmd) {
    case 'pattern': {
      const usage = `Usage: /pattern <CA> [${PATTERN_RESOLUTIONS.join('|')}] (default ${PATTERN_DEFAULT_RES})`;
      const a = addrArg(args[0], 'token', usage);
      if (!a.ok) return a;
      // REBUILD-CHOSEN: case-insensitive ('1H' → '1h'); unknown values are refused, not defaulted.
      const res = (args[1] || PATTERN_DEFAULT_RES).toLowerCase();
      if (!PATTERN_RESOLUTIONS.includes(res)) return { ok: false, usage: `❌ Unknown resolution. ${usage}` };
      return ok(`/api/skills/pattern/${a.addr}?res=${encodeURIComponent(res)}`);
    }
    case 'wallet': {
      const a = addrArg(args[0], 'wallet', 'Usage: /wallet <address>');
      if (!a.ok) return a;
      return ok(`/api/skills/wallet/${a.addr}`);
    }
    case 'search': {
      if (!rest) return { ok: false, usage: `Usage: /search <query> (max ${QUERY_MAX} characters)` };
      const q = queryArg(rest);
      if (!q.ok) return q;
      return ok(`/api/skills/search?q=${encodeURIComponent(q.q)}`);
    }
    case 'balance': {
      // WI-G §2.3: /balance <wallet> <ca>
      const usage = 'Usage: /balance <wallet> <CA>';
      const w = addrArg(args[0], 'wallet', usage);
      if (!w.ok) return w;
      const t = addrArg(args[1], 'token', usage);
      if (!t.ok) return t;
      return ok(`/api/skills/balance/${w.addr}/${t.addr}`, timeoutFor(cmd));
    }
    case 'review': {
      // WI-G §2.5 (G7-requests R2): /review <wallet> [1d|7d|30d|all] [me]
      const usage = `Usage: /review <wallet> [${REVIEW_PERIODS.join('|')}] [me]`;
      const w = addrArg(args[0], 'wallet', usage);
      if (!w.ok) return w;
      let period = '7d';
      let self = false;
      for (const raw of args.slice(1, 3)) {
        const v = raw.toLowerCase();
        // REBUILD-CHOSEN (G7-requests R2 suggestion): `me` = owner voice (Next step instead of Takeaway).
        if (v === 'me' && !self) { self = true; continue; }
        const p = REVIEW_PERIODS.includes(v) ? v : REVIEW_PERIOD_ALIASES[v];
        if (!p) return { ok: false, usage: `❌ Unknown option "${raw.slice(0, 16)}". ${usage}` };
        period = p;
      }
      if (args.length > 3) return { ok: false, usage };
      return ok(`/api/skills/review/${w.addr}?period=${period}${self ? '&voice=self' : ''}`, timeoutFor(cmd));
    }
    case 'caller': {
      // A-142: /caller <wallet>, the call-out record of one wallet (words after the wallet are ignored)
      const a = addrArg(args[0], 'wallet', 'Usage: /caller <wallet>');
      if (!a.ok) return a;
      return ok(`/api/skills/caller/${a.addr}`, timeoutFor(cmd));
    }
    default:
      return { ok: false, usage: `Unknown skill command /${String(cmd).slice(0, 32)}` };
  }
}

/** `/report <CA>`: the validated address, or the usage line. */
export function parseReportArgs(text: string): { ok: true; ca: string } | { ok: false; usage: string } {
  const args = argText(text).split(' ').filter(Boolean);
  const a = addrArg(args[0], 'token', 'Usage: /report <CA>');
  return a.ok ? { ok: true, ca: a.addr } : a;
}

// ── Skills button row ───────────────────────────────────────────────────────

/** Callback code → command. Callback data `sk:<code>:<ca>` is ≤ 3+3+44 = 50 bytes. */
export const SKILL_BUTTON_CODES: Record<string, string> = { dd: 'dd', pt: 'pattern', ho: 'holders', dv: 'dev' };
export const SKILL_CALLBACK_RE = /^sk:(dd|pt|ho|dv):([1-9A-HJ-NP-Za-km-z]{32,44})$/;

/** The "🔬 DD · Pattern · Holders · Dev" row, or [] when the CA is not a valid address. */
export function skillButtonsRow(ca: string): ReturnType<typeof Markup.button.callback>[] {
  const addr = validateCa(ca);
  if (!addr) return [];
  return [
    Markup.button.callback('🔬 DD',      `sk:dd:${addr}`),
    Markup.button.callback('Pattern',   `sk:pt:${addr}`),
    Markup.button.callback('Holders',   `sk:ho:${addr}`),
    Markup.button.callback('Dev',       `sk:dv:${addr}`),
  ];
}

// ── Delivery ────────────────────────────────────────────────────────────────

/** The two Telegram calls the skill runner uses (ctx.telegram satisfies it). */
export interface SkillTelegram {
  sendMessage(chatId: number | string, text: string, extra?: any): Promise<{ message_id: number } | any>;
  editMessageText(chatId: number | string | undefined, messageId: number | undefined, inlineMessageId: string | undefined, text: string, extra?: any): Promise<unknown>;
}

const MD_EXTRA    = { parse_mode: 'Markdown' as const, link_preview_options: { is_disabled: true } };
const PLAIN_EXTRA = { link_preview_options: { is_disabled: true } };

/** Cut to ≤ max chars on a line boundary when possible. */
export function clampText(text: string, max = TG_SEND_MAX): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  return (nl > max * 0.5 ? cut.slice(0, nl) : cut).trimEnd();
}

function tgDescription(e: any): string {
  return String(e?.response?.description || e?.description || e?.message || e || '');
}

const errText = (e: any) => redactSecrets(tgDescription(e)).slice(0, 200);

async function sendWithFallback(tg: SkillTelegram, chatId: number | string, text: string, markdown: boolean): Promise<void> {
  try {
    await tg.sendMessage(chatId, text, markdown ? MD_EXTRA : PLAIN_EXTRA);
  } catch (e: any) {
    if (!(markdown && isEntityParseError(e))) throw e;
    await tg.sendMessage(chatId, text, PLAIN_EXTRA);
  }
}

/**
 * Put the reply where the "⏳" placeholder is: edit it (Markdown for Engine
 * text, re-edited as plain if Telegram can't parse the entities); if the
 * placeholder is gone (deleted, too old, never sent), send a new message.
 * Never throws.
 */
export async function deliverReply(tg: SkillTelegram, chatId: number | string, msgId: number | null, reply: EngineReply): Promise<void> {
  const text = clampText(reply.text);
  const markdown = !(reply.ok === false && reply.plain);
  try {
    if (msgId != null) {
      try {
        await tg.editMessageText(chatId, msgId, undefined, text, markdown ? MD_EXTRA : PLAIN_EXTRA);
        return;
      } catch (e: any) {
        let err: any = e;
        if (markdown && isEntityParseError(e)) {
          try {
            await tg.editMessageText(chatId, msgId, undefined, text, PLAIN_EXTRA);
            return;
          } catch (e2: any) { err = e2; }
        }
        if (/message is not modified/i.test(tgDescription(err))) return;   // already shows this text
        // REBUILD-CHOSEN: any other edit failure ("message to edit not found",
        // "message can't be edited", …) means the placeholder is unusable → new message.
      }
    }
    await sendWithFallback(tg, chatId, text, markdown);
  } catch (e: any) {
    logWarn(`[skills] could not deliver the reply: ${errText(e)}`);
  }
}

// ── Registration ────────────────────────────────────────────────────────────

/** REBUILD-CHOSEN: bound on the cooldown map (one owner × 18 commands never gets near it). */
const COOLDOWN_MAP_MAX = 500;

/**
 * Register the 18 skill commands and the `sk:` button handler on `bot`.
 * bot.ts calls this right after its two `bot.use` middlewares (access gate,
 * secret guard) and BEFORE `bot.command('wallet')` and
 * `bot.on('callback_query')`: bare `/wallet` falls through (`next()`) to the
 * bot's own wallet card, and `sk:` taps never reach the big callback handler.
 */
export function registerSkillCommands(bot: Telegraf<Context>, opts: SkillCommandOpts = {}): void {
  const now = opts.now ?? Date.now;
  const inFlight = new Set<string>();
  const lastStart = new Map<string, number>();
  const engineUrl = opts.engineUrl ?? CONFIG.ENGINE_URL;
  const secret = opts.secret ?? (() => CONFIG.SIGNAL_SHARED_SECRET);
  const engine: Pick<EngineClient, 'token'> = opts.engine ?? createEngineClient({ engineUrl, secret, http: opts.http });

  /** null = may start; otherwise the plain-text reason it may not. */
  function gate(chatId: number | string, cmd: string): string | null {
    const key = `${chatId}:${cmd}`;
    if (inFlight.has(key)) return `⏳ /${cmd} is still running — wait for it to finish.`;
    const last = lastStart.get(key);
    const t = now();
    if (last !== undefined && t - last < SKILL_COOLDOWN_MS) {
      const s = Math.max(1, Math.ceil((SKILL_COOLDOWN_MS - (t - last)) / 1000));
      return `⏳ /${cmd} was just run — try again in ${s}s.`;
    }
    return null;
  }

  /** Sends the ⏳ placeholder, runs `work` in the background and puts its reply where the placeholder is. */
  function start(tg: SkillTelegram, chatId: number | string, cmd: string, work: () => Promise<EngineReply>): void {
    const key = `${chatId}:${cmd}`;
    inFlight.add(key);
    const t = now();
    if (lastStart.size >= COOLDOWN_MAP_MAX) {
      for (const [k, v] of lastStart) if (t - v >= SKILL_COOLDOWN_MS) lastStart.delete(k);
    }
    lastStart.set(key, t);
    void (async () => {
      try {
        let msgId: number | null = null;
        try {
          const m: any = await tg.sendMessage(chatId, RUNNING_TEXT);
          msgId = typeof m?.message_id === 'number' ? m.message_id : null;
        } catch { /* deliverReply sends a fresh message instead */ }
        const reply = await work();
        await deliverReply(tg, chatId, msgId, reply);
      } catch (e: any) {
        logWarn(`[skills] /${cmd} failed: ${errText(e)}`);
      } finally {
        inFlight.delete(key);
      }
    })();
  }

  const skillWork = (path: string, timeoutMs: number) => () => callEngine(path, timeoutMs, opts.http, engineUrl, secret);

  for (const cmd of SKILL_COMMANDS) {
    bot.command(cmd, async (ctx: any, next: () => Promise<void>) => {
      const text: string = ctx.message?.text || '';
      // Bare /wallet is the bot's own wallet card (bot.ts), not the skill.
      if (cmd === 'wallet' && !argText(text)) return next();
      try { opts.onCommand?.(); } catch { /* never block a command on the hook */ }
      const chatId = ctx.chat?.id;
      if (chatId === undefined || chatId === null) return;
      const tg = ctx.telegram as SkillTelegram;

      if (cmd === 'report') {
        const rep = parseReportArgs(text);
        if (!rep.ok) {
          await tg.sendMessage(chatId, rep.usage).catch(() => {});
          return;
        }
        const blockedReport = gate(chatId, cmd);
        if (blockedReport) {
          await tg.sendMessage(chatId, blockedReport).catch(() => {});
          return;
        }
        start(tg, chatId, cmd, () => reportReply(engine, rep.ca, now()));
        return;
      }

      const parsed = parseSkillArgs(cmd, text);
      if (!parsed.ok) {
        await tg.sendMessage(chatId, parsed.usage).catch(() => {});
        return;
      }
      const blocked = gate(chatId, cmd);
      if (blocked) {
        await tg.sendMessage(chatId, blocked).catch(() => {});
        return;
      }
      start(tg, chatId, cmd, skillWork(parsed.path, parsed.timeoutMs));
    });
  }

  bot.action(SKILL_CALLBACK_RE, async (ctx: any) => {
    const m: string[] = ctx.match || [];
    const cmd = SKILL_BUTTON_CODES[m[1]];
    const ca = validateCa(m[2]);
    const chatId = ctx.chat?.id;
    if (!cmd || !ca || chatId === undefined || chatId === null) {
      await ctx.answerCbQuery('❌ Invalid token address').catch(() => {});
      return;
    }
    const blocked = gate(chatId, cmd);
    // answerCbQuery first (stops the button spinner); a refusal shows as a toast.
    await ctx.answerCbQuery(blocked ?? undefined).catch(() => {});
    if (blocked) return;
    const parsed = parseSkillArgs(cmd, `/${cmd} ${ca}`);
    if (!parsed.ok) return;   // unreachable: ca is validated above
    start(ctx.telegram as SkillTelegram, chatId, cmd, skillWork(parsed.path, parsed.timeoutMs));
  });
}
