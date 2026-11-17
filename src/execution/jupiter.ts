/**
 * Jupiter Swap Execution — Quote + Swap + Smart Slippage Retry
 *
 * 2026-05-02: jupSwap rewritten to use /swap/v2/build (raw instructions)
 * so we can inject a Helius Sender tip transfer (≥0.0002 SOL to a staked-
 * validator tip account) — the previous /swap/v1/swap path returned a
 * fully-compiled tx that we couldn't modify, which silently disabled
 * Sender's fast lane. Now spec-compliant per
 * https://www.helius.dev/docs/sending-transactions/sender.
 */
// 2026-05-05 — node-fetch → undici with persistent keep-alive pool.
// Eliminates TCP/TLS handshake on every Jupiter / Helius / RPC call.
// Saves 50-200ms per request after the first connection per origin.
import { fetch } from '../lib/http-client';
import {
  Connection, Keypair, VersionedTransaction,
  PublicKey, TransactionMessage, TransactionInstruction,
  AddressLookupTableAccount, SystemProgram,
  LAMPORTS_PER_SOL, PACKET_DATA_SIZE,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { CONFIG, jupUrls, rpcOnlyUrl, rpcUrlOverride } from '../config';
import { log, logOk, logWarn, logErr } from '../logger';
import { redactSecrets } from '../lib/redact';
import { resolveEffectiveRebates } from '../data/rebate-settings';
import { dispatchSigned, enforceImpactCap, mustStop, ImpactCapError, PreSignRefusal, simulationRefusal, type SendContext } from './send-context';
// FIX-BUY: the Sender path's compute-unit limit is measured by a simulation (compute-budget.ts holds the pure rules)
import { JUP_SENDER_FALLBACK_CU, MAX_COMPUTE_UNITS, computeBudgetFeeLamports, senderComputeBudget, senderLimitFromUnits } from './compute-budget';
import { accountBytes, errorReason, withTimeout } from './exec-common';
// FIX-BUY2 item 7(e): the simulated-balance rules shared with tx-verify (step d) and ext-verify (owner accounts)
import { ownerHoldings, ownerTokenAccount, ownerTokenAccountsRefusal, swapFlowRefusal } from './sim-owner-checks';
import { parseChainAccount, type ChainAccount } from './wallet-reads';
// R7-W5 (A-104): the /swap/v2/build answer types, toIx and the request query moved, unchanged, into the pure jupiter-ix.ts (the unsigned wallet
// builder shares them); the HTTP calls, key alternation and retries below stay here, so the server bytes do not change (byte-identity goldens pin them).
import { jupBuildQuery, toIx, type BuildResponse } from './jupiter-ix';

// Helius Sender minimum tip: 0.0002 SOL (200_000 lamports). Per the spec.
export const HELIUS_TIP_LAMPORTS = 200_000;

// ───────────────────────────────────────────────────────────────────
// 2026-05-16 — Helius Backrun Rebates
// https://www.helius.dev/docs/sending-transactions/backrun-rebates
//
// Appends `&rebate-address=<USER_WALLET>` to ANY Helius mainnet RPC URL
// passed in. Helius forwards an unsigned copy of the tx to a KYC'd-searcher
// auction; our tx executes FIRST in the bundle; 50% of captured MEV is paid
// to the configured wallet in the same block. Zero added latency.
//
// 2026-05-16 UX migration — Config source changed from .env (static) to
// data/settings.json (live, TG-editable). Users toggle via `/rebates` menu.
// The TG settings win when set; the .env values remain as a back-compat
// fallback so existing deployments don't regress. See data/rebate-settings.ts.
//
// We only append on URLs that resolve to a Helius host — public RPCs and
// non-Helius endpoints ignore unknown query params at best, reject at worst.
// ───────────────────────────────────────────────────────────────────
export function rpcUrlWithRebate(baseUrl: string): string {
  if (!baseUrl) return baseUrl;
  // Resolve effective config: settings.json (TG) wins, falls back to env.
  // `resolveEffectiveRebates` returns enabled=false unless an address is set,
  // so we never accidentally send rebates with an empty recipient.
  const reb = resolveEffectiveRebates(
    CONFIG.ENABLE_BACKRUN_REBATES,
    CONFIG.HELIUS_MARKETING_WALLET,
  );
  if (!reb.enabled || !reb.address) return baseUrl;
  // Helius-only — public RPCs don't honour this and may reject unknown params.
  if (!/helius-rpc\.com/i.test(baseUrl)) return baseUrl;
  // Don't double-append if URL already carries a rebate-address param.
  if (/[?&]rebate-address=/i.test(baseUrl)) return baseUrl;
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}rebate-address=${encodeURIComponent(reb.address)}`;
}

// ───────────────────────────────────────────────────────────────────
// 2026-05-16 — Helius getPriorityFeeEstimate (account-keys mode)
// https://www.helius.dev/docs/priority-fee-api
// https://www.helius.dev/docs/priority-fee/estimating-fees-using-account-keys
//
// Returns priority fee in microlamports/CU at the requested level. We use
// the account-keys variant (no need to serialize the tx upfront — caller
// passes the writable accounts and program IDs). Cached per (sorted-keys
// fingerprint, level) for CONFIG.PRIORITY_FEE_CACHE_MS.
//
// Falls back to PRIORITY_FEE_FLOOR_MICROLAMPORTS on any error so we never
// pay 0 priority fee on a snipe. Result is clamped to
// [PRIORITY_FEE_FLOOR, PRIORITY_FEE_CEILING] microlamports.
// ───────────────────────────────────────────────────────────────────
export type PriorityFeeLevel = 'Min' | 'Low' | 'Medium' | 'High' | 'VeryHigh' | 'UnsafeMax';

interface PriorityFeeCacheEntry { fee: number; ts: number; }
const _priorityFeeCache = new Map<string, PriorityFeeCacheEntry>();

function clampPriorityFee(microLamports: number): number {
  const floor   = CONFIG.PRIORITY_FEE_FLOOR_MICROLAMPORTS;
  const ceiling = CONFIG.PRIORITY_FEE_CEILING_MICROLAMPORTS;
  if (!Number.isFinite(microLamports) || microLamports <= 0) return floor;
  return Math.min(Math.max(Math.floor(microLamports), floor), ceiling);
}

export async function getPriorityFeeEstimate(
  accountKeys: string[],
  level: PriorityFeeLevel = 'High',
): Promise<number> {
  // Feature-flagged off → caller's hardcoded fee path stays untouched.
  if (!CONFIG.ENABLE_DYNAMIC_PRIORITY_FEE) {
    return clampPriorityFee(CONFIG.PRIORITY_FEE_FLOOR_MICROLAMPORTS);
  }
  // Need an RPC + at least one account key
  const rpc = CONFIG.HELIUS_RPC_BOT || CONFIG.HELIUS_RPC;
  if (!rpc || !accountKeys || accountKeys.length === 0) {
    return clampPriorityFee(CONFIG.PRIORITY_FEE_FLOOR_MICROLAMPORTS);
  }
  // Cache key: sorted account keys + level (so equivalent calls dedupe)
  const cacheKey = `${level}|${[...accountKeys].sort().join(',')}`;
  const cached = _priorityFeeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CONFIG.PRIORITY_FEE_CACHE_MS) {
    return cached.fee;
  }
  try {
    const r = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getPriorityFeeEstimate',
        params: [{
          accountKeys,
          options: { priorityLevel: level, recommended: false, evaluateEmptySlotAsZero: true },
        }],
      }),
      timeout: 4_000,
    } as any);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json() as any;
    const raw = Number(j?.result?.priorityFeeEstimate);
    const clamped = clampPriorityFee(raw);
    _priorityFeeCache.set(cacheKey, { fee: clamped, ts: Date.now() });
    return clamped;
  } catch (e: any) {
    logWarn(`[priority-fee] estimate failed (${e?.message || e}) — using floor ${CONFIG.PRIORITY_FEE_FLOOR_MICROLAMPORTS}`);
    return clampPriorityFee(CONFIG.PRIORITY_FEE_FLOOR_MICROLAMPORTS);
  }
}

/**
 * Convenience: returns the priority fee for a typical swap given the standard
 * writable accounts (payer + token mints + the routing program). Pre-fills the
 * common Solana programs so callers can just hand in the swap-specific keys.
 */
export async function getPriorityFeeForSwap(
  payer: string, swapKeys: string[], snipe = false,
): Promise<number> {
  const level: PriorityFeeLevel = snipe
    ? (CONFIG.PRIORITY_FEE_LEVEL_SNIPE as PriorityFeeLevel)
    : (CONFIG.PRIORITY_FEE_LEVEL_NORMAL as PriorityFeeLevel);
  // Filter empty / dupe keys before sending
  const keys = Array.from(new Set([payer, ...swapKeys].filter(k => !!k && k.length >= 32 && k.length <= 44)));
  return getPriorityFeeEstimate(keys, level);
}

// ───────────────────────────────────────────────────────────────────
// 2026-05-16 — Helius Sender keepalive
// https://www.helius.dev/docs/sending-transactions/sender
//   "Use GET /ping every 30-60s to reduce cold-start latency on the
//    Sender endpoint during idle gaps between snipes."
//
// Fire-and-forget: we just want the TCP connection + DNS warm. Logs only
// on first 5 failures to avoid noise; resumes warming silently afterwards.
// ───────────────────────────────────────────────────────────────────
let _senderKeepaliveTimer: NodeJS.Timeout | null = null;
let _senderKeepaliveFailCount = 0;

function deriveSenderPingUrl(senderUrl: string): string {
  // Strip query, swap /fast → /ping. If url is malformed, fall back to the
  // public ping endpoint.
  try {
    const u = new URL(senderUrl);
    const pathname = u.pathname.replace(/\/fast\/?$/i, '/ping');
    return `${u.protocol}//${u.host}${pathname}`;
  } catch {
    return 'https://sender.helius-rpc.com/ping';
  }
}

export function startSenderKeepalive(): void {
  if (!CONFIG.ENABLE_SENDER_KEEPALIVE) return;
  if (_senderKeepaliveTimer) return;   // already running
  const senderUrl = CONFIG.HELIUS_SENDER_URL || CONFIG.HELIUS_SEND_URL_BOT || CONFIG.HELIUS_SEND_URL;
  if (!senderUrl) return;
  const pingUrl = deriveSenderPingUrl(senderUrl);
  const intervalMs = Math.max(15_000, CONFIG.SENDER_KEEPALIVE_MS);
  const tick = async () => {
    try {
      const r = await fetch(pingUrl, { method: 'GET', timeout: 3_000 } as any);
      if (r.ok) {
        _senderKeepaliveFailCount = 0;
      } else if (_senderKeepaliveFailCount < 5) {
        _senderKeepaliveFailCount++;
        logWarn(`[sender-keepalive] HTTP ${r.status} from ${pingUrl}`);
      }
    } catch (e: any) {
      if (_senderKeepaliveFailCount < 5) {
        _senderKeepaliveFailCount++;
        logWarn(`[sender-keepalive] ${e?.message || e}`);
      }
    }
  };
  // Tick once now, then on interval
  void tick();
  _senderKeepaliveTimer = setInterval(tick, intervalMs);
  // Don't keep the Node process alive purely on this timer
  if (_senderKeepaliveTimer && typeof _senderKeepaliveTimer.unref === 'function') {
    _senderKeepaliveTimer.unref();
  }
  logOk(`[sender-keepalive] started → ${pingUrl} every ${intervalMs}ms`);
}

export function stopSenderKeepalive(): void {
  if (_senderKeepaliveTimer) {
    clearInterval(_senderKeepaliveTimer);
    _senderKeepaliveTimer = null;
  }
}

// SPL Token + Associated Token program IDs — used for wSOL wrap/unwrap helpers.
const WSOL_MINT_PK         = new PublicKey('So11111111111111111111111111111111111111112');
const TOKEN_PROGRAM_PK     = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
// Token-2022 program (2026-06-10): many newer Solana memecoins mint under
// Token-2022, NOT the classic program. Balance reads that only knew about the
// classic program saw those holdings as ZERO, which made the position monitor
// close live cards and the cleanup job delete real positions ("held tokens
// vanish after a few minutes"). Both programs are now queried everywhere.
const TOKEN_2022_PROGRAM_PK = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOC_TOKEN_PROGRAM_PK = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/** Deterministic Associated Token Account address (no fetch). Defaults to the
 *  classic Token program; pass Token-2022 for 2022 mints (the token program
 *  is part of the ATA derivation seeds, so the address differs per program). */
function deriveAtaAddress(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_PK): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOC_TOKEN_PROGRAM_PK,
  )[0];
}

const SOL_MINT = CONFIG.SOL_MINT;
const PUBLIC_RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-mainnet.core.chainstack.com',
  'https://solana.publicnode.com',
  'https://rpc.ankr.com/solana',
];

// Round-robin RPC pool with auto-failover on 429.
// Bot lane: prefer HELIUS_RPC_BOT (separate trading-only key) so engine
// scan-bursts on HELIUS_RPC don't push trades onto slow public RPCs.
let _rpcIdx = 0;
export async function resilientRpcCall(method: string, params: any[]): Promise<any> {
  const primary = CONFIG.HELIUS_RPC_BOT || CONFIG.HELIUS_RPC;
  // Alchemy is the FIRST failover (2026-06-12) — a 429 on Helius lands on a
  // keyed, quality lane instead of congested public endpoints. This is the
  // path every position-monitor/cleanup balance read takes.
  // RPC_URL set and RPC_FALLBACKS=off (B50 section 2, test override): that one endpoint and nothing else - no public RPC,
  // no mainnet-beta, no derived provider lane. With RPC_URL set and fallbacks on it is simply the first lane. Unset: unchanged.
  const only = rpcOnlyUrl();
  const pool = only ? [only] : [rpcUrlOverride(), primary, CONFIG.ALCHEMY_RPC, ...PUBLIC_RPCS].filter(Boolean);
  const errors: string[] = [];
  for (let i = 0; i < pool.length; i++) {
    const rpc = pool[(_rpcIdx + i) % pool.length];
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        timeout: 8000,
      });
      if (r.status === 429) { errors.push(`${rpc}: 429`); continue; }
      const d = await r.json() as any;
      if (d.error) { errors.push(`${rpc}: ${d.error.message}`); continue; }
      if (i > 0) { _rpcIdx = (_rpcIdx + i) % pool.length; logWarn(`RPC failover → ${rpc.split('?')[0]}`); }
      return d.result;
    } catch (e: any) {
      errors.push(`${rpc}: ${e.message}`);
    }
  }
  throw new Error(`All RPCs failed for ${method}: ${errors.join(' | ')}`);
}

export async function getResilientBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  // 2026-05-05 — fast path: read from background-warmed cache (refreshed every
  // 800ms by startBlockhashCache in src/index.ts). Saves 100-300ms per swap.
  // Cold/stale → fall back to synchronous multi-RPC fetch (legacy behavior).
  const { getCachedBlockhash } = await import('./blockhash-cache');
  const cached = getCachedBlockhash();
  if (cached) return cached;

  const res = await resilientRpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  return { blockhash: res.value.blockhash, lastValidBlockHeight: res.value.lastValidBlockHeight };
}

// ── Jupiter HTTP: one keyed host, typed errors (FIX-BUY2 item 1) ──────────────────────────────────────────────────────────────
// Incident 3 ("Jupiter quote failed: 400 (all tiers exhausted)", 2026-11-06) could not be diagnosed: the 400 body was thrown away, the
// same deterministic 400 was replayed on the second key and on keyless lite-api, and the "tiers exhausted" text also turned a 429 storm
// or a 5xx into "no route". Now every Jupiter call goes to the keyed host only (jupUrls(), JUP_API_BASE), reads and logs the body of a
// refused answer (redacted, 120 characters) with Jupiter's x-api-gateway-request-id, and throws one of three typed errors.

/** Jupiter's documented slippage range on /swap/v1/quote, /swap/v2/build and /swap/v2/order: 0 .. 10 000 bps. */
export const JUP_MAX_SLIPPAGE_BPS = 10_000;
/** The waits between the tries of one key after a 429 or a 5xx (unchanged since 2026-05). */
const JUP_BACKOFFS_MS: readonly number[] = [400, 1200, 3000];
/** At most this many characters of a refused answer's body (redacted) are logged and kept on the error. */
export const JUP_ERROR_BODY_CHARS = 120;

export type JupEndpoint = 'quote' | 'build' | 'swap' | 'order' | 'execute';
const JUP_PATHS: Readonly<Record<JupEndpoint, string>> = {
  quote: '/swap/v1/quote', build: '/swap/v2/build', swap: '/swap/v1/swap', order: '/swap/v2/order', execute: '/swap/v2/execute',
};

/**
 * A Jupiter answer that was not a success. `status` is the HTTP status (null: no answer at all, a timeout or a network error),
 * `requestId` Jupiter's x-api-gateway-request-id (quote it to Jupiter support), `body` the answer's body, redacted and cut.
 */
export class JupiterError extends Error {
  readonly endpoint: JupEndpoint;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly body: string;
  constructor(name: string, message: string, endpoint: JupEndpoint, status: number | null, requestId: string | null, body: string) {
    super(redactSecrets(message).slice(0, 200));
    this.name = name;
    this.endpoint = endpoint;
    this.status = status;
    this.requestId = requestId;
    this.body = body;
  }
}

/**
 * Jupiter has no route for this pair: /swap/v2/build (or /order) 400 "No routes found", or a v1 400 errorCode NO_ROUTES_FOUND,
 * COULD_NOT_FIND_ANY_ROUTE or TOKEN_NOT_TRADABLE. Final for the call: a higher slippage cannot make a route, and the same request is
 * never sent again on another key.
 */
export class JupiterNoRouteError extends JupiterError {
  constructor(message: string, endpoint: JupEndpoint, status: number | null, requestId: string | null, body: string) {
    super('JupiterNoRouteError', message, endpoint, status, requestId, body);
  }
}

/**
 * Jupiter refused the request itself: any other 4xx, a 401/403 that the fallback key did not fix, or no JUPITER_API_KEY at all.
 * Final: a 400 is the same answer on every key and host, so it is never replayed.
 */
export class JupiterRequestError extends JupiterError {
  constructor(message: string, endpoint: JupEndpoint, status: number | null, requestId: string | null, body: string) {
    super('JupiterRequestError', message, endpoint, status, requestId, body);
  }
}

/** Why Jupiter could not answer: its rate limit (429), a server error (5xx), or no answer at all (timeout or network error). */
export type JupiterUnavailableKind = 'rate-limited' | 'server' | 'timeout';

/**
 * Jupiter could not answer: a 429 or a 5xx after the 400/1200/3000 ms backoffs and the fallback key, or no answer (timeout, network).
 * executeWithRetry retries it like any outage; it is never reported as "no route".
 */
export class JupiterUnavailableError extends JupiterError {
  readonly kind: JupiterUnavailableKind;
  constructor(kind: JupiterUnavailableKind, message: string, endpoint: JupEndpoint, status: number | null, requestId: string | null, body: string) {
    super('JupiterUnavailableError', message, endpoint, status, requestId, body);
    this.kind = kind;
  }
}

/** Every Jupiter slippage is sent inside Jupiter's range: at most 10 000 bps (a sell retried at 9 900 x 1.5 asked for 14 850 and got a 400). */
export function jupSlippageBps(bps: number): number {
  if (!Number.isFinite(bps) || bps <= 0) return 0;
  return Math.min(Math.round(bps), JUP_MAX_SLIPPAGE_BPS);
}

const JUP_NO_ROUTE_CODES: ReadonlySet<string> = new Set(['NO_ROUTES_FOUND', 'COULD_NOT_FIND_ANY_ROUTE', 'TOKEN_NOT_TRADABLE']);

/** A refused answer's body says "no route": errorCode NO_ROUTES_FOUND / COULD_NOT_FIND_ANY_ROUTE / TOKEN_NOT_TRADABLE, or error "No routes found". */
function isNoRouteBody(raw: string): boolean {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return false; }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return false;
  const o = j as { errorCode?: unknown; error?: unknown };
  if (typeof o.errorCode === 'string' && JUP_NO_ROUTE_CODES.has(o.errorCode.trim().toUpperCase())) return true;
  return typeof o.error === 'string' && /^\s*no routes? found\.?\s*$/i.test(o.error);
}

/** Jupiter's x-api-gateway-request-id of an answer, when it carries one (a printable token, at most 64 characters). */
function gatewayRequestId(r: { headers?: { get?: (name: string) => string | null } }): string | null {
  let v: string | null | undefined;
  try { v = r.headers?.get?.('x-api-gateway-request-id'); } catch { v = null; }
  return typeof v === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(v) ? v : null;
}

/** The refused answer as a typed error: its body is read once, redacted, cut to 120 characters and logged with the request id. */
async function refusedAnswer(endpoint: JupEndpoint, r: { status: number; text(): Promise<string>; headers?: { get?: (name: string) => string | null } }): Promise<JupiterError> {
  const raw = await r.text().catch(() => '');
  const body = redactSecrets(String(raw)).replace(/\s+/g, ' ').trim().slice(0, JUP_ERROR_BODY_CHARS);
  const requestId = gatewayRequestId(r);
  const path = JUP_PATHS[endpoint];
  logWarn(`[jupiter] ${path} HTTP ${r.status}${requestId === null ? '' : ` (request ${requestId})`}: ${body || '(empty body)'}`);
  const said = body === '' ? `HTTP ${r.status}` : `HTTP ${r.status}: ${body}`;
  if (r.status === 429 || r.status >= 500) {
    return new JupiterUnavailableError(r.status === 429 ? 'rate-limited' : 'server', `Jupiter ${path} is unavailable (${said})`, endpoint, r.status, requestId, body);
  }
  if (r.status === 400 && isNoRouteBody(String(raw))) {
    return new JupiterNoRouteError(`Jupiter found no route for this pair (${path} ${said})`, endpoint, r.status, requestId, body);
  }
  if (r.status === 401 || r.status === 403) {
    return new JupiterRequestError(`Jupiter ${path} refused the API key (${said})`, endpoint, r.status, requestId, body);
  }
  return new JupiterRequestError(`Jupiter ${path} refused the request (${said})`, endpoint, r.status, requestId, body);
}

interface JupCall {
  endpoint: JupEndpoint;
  url: string;
  method: 'GET' | 'POST';
  /** A JSON body (POST only). */
  body?: string;
  timeoutMs: number;
  /** 'backoff' (default): a 429 or 5xx is tried again after 400, 1200 and 3000 ms, then on the fallback key. 'once' (/execute): ONE
   *  more identical request after a 429, a 5xx or no answer (Jupiter's /execute is idempotent for about 2 minutes). */
  retry?: 'backoff' | 'once';
}

const sleepMs = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/**
 * ONE Jupiter call on the keyed host, with x-api-key on every request (FIX-BUY2 item 1). Without JUPITER_API_KEY nothing is requested:
 * JupiterRequestError "JUPITER_API_KEY missing". A refused answer is final unless it is a 401/403 (tried once more on
 * JUPITER_API_KEY_FALLBACK) or a 429/5xx (the backoffs, then the fallback key). A 400 is never replayed on another key or host.
 */
async function jupRequest(c: JupCall): Promise<any> {
  const primary = CONFIG.JUPITER_API_KEY;
  if (!primary) {
    throw new JupiterRequestError(`JUPITER_API_KEY missing: every Jupiter request needs the key (there is no keyless tier)`, c.endpoint, null, null, '');
  }
  const second = CONFIG.JUPITER_API_KEY_FALLBACK;
  const keys = second && second !== primary ? [primary, second] : [primary];
  const path = JUP_PATHS[c.endpoint];
  let last: JupiterError | null = null;
  for (const key of keys) {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { 'x-api-key': key, 'Accept': 'application/json' };
      if (c.body !== undefined) headers['Content-Type'] = 'application/json';
      let r: any;
      try {
        r = await fetch(c.url, { method: c.method, headers, ...(c.body !== undefined ? { body: c.body } : {}), timeout: c.timeoutMs } as any);
      } catch (e) {
        const why = errorReason(e).slice(0, JUP_ERROR_BODY_CHARS);
        const err = new JupiterUnavailableError('timeout', `Jupiter ${path} did not answer (${why})`, c.endpoint, null, null, '');
        logWarn(`[jupiter] ${path} no answer: ${why}`);
        if (c.retry === 'once' && attempt === 0) { last = err; continue; }
        throw err;
      }
      if (r.ok) {
        try {
          return await r.json();
        } catch (e) {
          throw new JupiterUnavailableError('server', `Jupiter ${path} answered ${r.status} with a body that is not JSON`, c.endpoint, r.status, gatewayRequestId(r), '');
        }
      }
      const refused = await refusedAnswer(c.endpoint, r);
      if (refused instanceof JupiterUnavailableError) {
        last = refused;
        if (c.retry === 'once') {
          if (attempt === 0) { await sleepMs(JUP_BACKOFFS_MS[0]); continue; }
          throw refused;
        }
        if (attempt >= JUP_BACKOFFS_MS.length) break;          // this key is exhausted: the fallback key, if any
        await sleepMs(JUP_BACKOFFS_MS[attempt]);
        continue;
      }
      if (refused.status === 401 || refused.status === 403) { last = refused; break; }   // the fallback key, once
      throw refused;                                             // no route, or any other 4xx: final
    }
  }
  throw last as JupiterError;
}

// ── Jupiter Quote (/swap/v1/quote) ──
/**
 * A v1 quote: ONLY the exit valuation (exits/valuation.ts) and the legacy /swap/v1/swap fallback use it (FIX-BUY2 item 2: a trade's quote
 * is its /swap/v2/build answer). Errors are the typed ones above; the old keyless and lite-api.jup.ag tiers are gone (item 1).
 *
 * FIX-BUY2 item 2: the routes it may see are the ones /build signs: maxAccounts=64 (Jupiter: values below 50 "can cause no route found";
 * the old 40 did) and restrictIntermediateTokens=false (true blocked a non-stable middle hop such as the DNUT-quoted pool of 38HZ...).
 * dynamicComputeUnitLimit is a /swap body parameter, not a /quote one, so it is no longer sent here.
 */
export async function jupQuote(
  inputMint: string, outputMint: string, amount: number, slippageBps: number
): Promise<any> {
  const qs = `?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${jupSlippageBps(slippageBps)}&restrictIntermediateTokens=false&maxAccounts=64`;
  return jupRequest({ endpoint: 'quote', url: `${jupUrls().quote}${qs}`, method: 'GET', timeoutMs: 10_000 });
}

// ────────────────────────────────────────────────────────────
// Jupiter /swap/v2/build helpers — for Helius Sender compliance
// ────────────────────────────────────────────────────────────

function altsFromMap(raw: Record<string, string[]> | null): AddressLookupTableAccount[] {
  if (!raw) return [];
  return Object.entries(raw).map(([key, addresses]) =>
    new AddressLookupTableAccount({
      key: new PublicKey(key),
      state: {
        deactivationSlot: BigInt('18446744073709551615'),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: addresses.map(a => new PublicKey(a)),
      },
    }),
  );
}

/**
 * Fetch raw instructions from Jupiter /swap/v2/build. Single round-trip —
 * combines quote + swap-instructions and includes ALTs already resolved.
 */
async function jupBuild(
  taker: string, inputMint: string, outputMint: string,
  amount: number, slippageBps: number,
  wrapAndUnwrapSol = true,
): Promise<BuildResponse> {
  // Jupiter v2 nomenclature: `taker` (the user signing the tx). v1 used
  // `userPublicKey` — different name, same role. Confirmed via 400 ZodError.
  const qs = jupBuildQuery({ taker, inputMint, outputMint, amount, slippageBps: jupSlippageBps(slippageBps), wrapAndUnwrapSol });
  // 2026-05-07: the fallback key after a 429 (May 7: rate-limit failures blocked stop-loss and buy paths). FIX-BUY2: typed errors
  // (a 400 "No routes found" is JupiterNoRouteError after ONE request), the body and Jupiter's request id are logged.
  return await jupRequest({ endpoint: 'build', url: `${jupUrls().build}?${qs.toString()}`, method: 'GET', timeoutMs: 12_000 }) as BuildResponse;
}

/** The Helius Sender tip of one Sender attempt: the tip account (picked once per attempt) and the lamports (0 = no tip instruction). */
interface SenderTip { account: string; lamports: number }

/**
 * How a /swap/v2/build transaction is composed (FIX-BUY2 item 4):
 *   'sender' — the Helius tip (account picked once per attempt) and Jupiter's unit price, clamped to the ceiling and scaled to the limit;
 *   'rpc'    — no tip, and the owner's priority fee spread over the limit (the fee is at most `feeLamports`), for the multi-RPC blast.
 */
type BuildLane = { kind: 'sender'; tip: SenderTip } | { kind: 'rpc'; feeLamports: bigint };

/**
 * Compose an UNSIGNED VersionedTransaction from a /v2/build response. Spec-compliant assembly (Jupiter's Build page):
 *   [computeBudget..., setup..., swap, HELIUS_TIP (Sender lane only), cleanup?, other...]
 * FIX-BUY: the compute budget is the bot's limit `cuLimit` plus the lane's price (compute-budget.ts senderComputeBudget); the caller
 * measures the limit (measureBuildLimit) and signs.
 */
function composeSwapTxWithSenderTip(
  build: BuildResponse, payer: PublicKey, lane: BuildLane, cuLimit: number,
): VersionedTransaction {
  // 2026-05-05 — when tipLamports === 0 we skip the tip IX entirely (about 80 bytes). FIX-BUY2 item 3: the Sender lane always tips (Helius
  // Sender rejects untipped transactions); an oversized route is now refused before signing and goes to the legacy /swap instead.
  // FIX-BUY2 item 4: the RPC lane has no tip (the multi-RPC blast reaches no Sender).
  const tipIx = lane.kind === 'sender' && lane.tip.lamports > 0 ? SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey:   new PublicKey(lane.tip.account),
    lamports:   lane.tip.lamports,
  }) : null;

  // Per Helius spec: compute-budget at the BEGINNING. Jupiter returns a
  // setComputeUnitPrice (priority fee) but not a setComputeUnitLimit. FIX-BUY (38HZ..., 2026-11-06): the old fixed 200K limit
  // ran out on a multi-hop route; the bot's limit is the measured one, Jupiter's price is scaled so the fee does not grow, and a
  // limit Jupiter might send is dropped (one limit only). Anything unexpected in Jupiter's list refuses (the caller falls back).
  // FIX-BUY2 item 3: Jupiter's price is first clamped to PRIORITY_FEE_CEILING_MICROLAMPORTS (Jupiter's compute-units page: clamp to your own
  // maximum), so the fee is at most ceil(200 000 x ceiling / 1e6): 1 000 000 lamports at the default ceiling, whatever Jupiter returns.
  // FIX-BUY2 item 4: the RPC lane signs floor(priorityFee x 1e6 / limit) instead: the fee is at most the owner's priorityFee lamports.
  const cb = senderComputeBudget(build.computeBudgetInstructions.map(toIx), cuLimit,
    lane.kind === 'sender' ? { maxPrice: jupPriceCeiling() } : { fixedFeeLamports: lane.feeLamports });
  if (!cb.ok) throw new Error(`Jupiter compute-budget instructions refused: ${cb.reason}`);

  const instructions: TransactionInstruction[] = [
    ...cb.instructions,
    ...build.setupInstructions.map(toIx),
    toIx(build.swapInstruction),
    ...(tipIx ? [tipIx] : []),                                      // ← Helius tip (Sender lane only)
    ...(build.cleanupInstruction ? [toIx(build.cleanupInstruction)] : []),
    ...build.otherInstructions.map(toIx),
  ];

  // Build response gives blockhash as byte array — bs58-encode for web3.js
  const blockhash = bs58.encode(Uint8Array.from(build.blockhashWithMetadata.blockhash));
  const alts = altsFromMap(build.addressesByLookupTableAddress);

  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(alts);

  return new VersionedTransaction(msg);
}

/** FIX-BUY: how long the measuring simulation of a /swap/v2/build transaction (either lane) may take; no answer by then = the fixed fallback limit. */
export const SENDER_SIM_TIMEOUT_MS = 2_500;

/** The default of PRIORITY_FEE_CEILING_MICROLAMPORTS (config.ts), used when the configured value is not a usable number. */
const JUP_PRICE_CEILING_DEFAULT = 5_000_000n;

/** FIX-BUY2 item 3: the most the bot signs per compute unit of Jupiter's price: PRIORITY_FEE_CEILING_MICROLAMPORTS (default 5 000 000). */
function jupPriceCeiling(): bigint {
  const c = CONFIG.PRIORITY_FEE_CEILING_MICROLAMPORTS;
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? BigInt(Math.floor(Math.min(c, Number.MAX_SAFE_INTEGER))) : JUP_PRICE_CEILING_DEFAULT;
}

/**
 * FIX-BUY2 item 3: the composed transaction is over the 1 232-byte packet. Nothing was signed or journalled (the caller takes the legacy
 * /swap/v1/swap once). Before, it was signed with the fallback limit and sent: no node accepts it, and singleSend then blocked every
 * fallback, while the manual-buy journal blocked the next buy for about a minute.
 */
class SenderOversizeError extends Error {
  /** The serialized size, or null when web3.js could not serialize the message at all (a message over 1 232 bytes overruns its buffer). */
  readonly bytes: number | null;
  constructor(bytes: number | null) {
    super(bytes === null
      ? `the Jupiter transaction is over the ${PACKET_DATA_SIZE}-byte packet limit (its message alone does not fit)`
      : `the Jupiter transaction is ${bytes} bytes, over the ${PACKET_DATA_SIZE}-byte packet limit`);
    this.name = 'SenderOversizeError';
    this.bytes = bytes;
  }
}

/**
 * The wire bytes of an (unsigned or signed) transaction, or SenderOversizeError when it does not fit one packet. Two forms: a message that
 * fits while message + signature does not (serialize works, the length is over 1 232), and a message over 1 232 bytes, which web3.js v1
 * cannot serialize at all (RangeError "encoding overruns Uint8Array": before FIX-BUY2 that error fell through to the legacy /swap by luck).
 */
function packetBytes(tx: VersionedTransaction): Uint8Array {
  let wire: Uint8Array;
  try {
    wire = tx.serialize();
  } catch (e) {
    if (e instanceof RangeError) throw new SenderOversizeError(null);
    throw e;
  }
  if (wire.length > PACKET_DATA_SIZE) throw new SenderOversizeError(wire.length);
  return wire;
}

/**
 * FIX-BUY: the compute-unit limit of a /swap/v2/build transaction (either lane), measured. The same transaction, unsigned and at the runtime maximum of
 * 1 400 000 units (its price scaled to that limit, so even its fee is not above the old one), is simulated once (sigVerify false,
 * replaceRecentBlockhash true, 'confirmed') within SENDER_SIM_TIMEOUT_MS. Read-only: nothing is signed or sent.
 *   - the transaction is over the packet size (no node takes it) -> SenderOversizeError, before anything is simulated or signed (FIX-BUY2);
 *   - the simulation fails             -> PreSignRefusal (simulationRefusal): the caller signs and sends nothing;
 *   - it succeeds with N units         -> senderLimitFromUnits(N) = ceil(N x 1.2), at least 200 000, at most 1 400 000;
 *   - no usable answer (RPC down, slow, no units) -> JUP_SENDER_FALLBACK_CU.
 */
async function measureBuildLimit(build: BuildResponse, payer: PublicKey, lane: BuildLane): Promise<number> {
  // unsigned (zero signature slot); FIX-BUY2 item 3: the limit is a fixed-size field, so this is the size of the transaction that would be
  // signed, and one over the packet is refused here, before it is simulated or signed
  const wire = packetBytes(composeSwapTxWithSenderTip(build, payer, lane, Number(MAX_COMPUTE_UNITS)));
  let why = 'the answer carries no compute units';
  let sim: any = null;
  try {
    sim = await withTimeout(resilientRpcCall('simulateTransaction', [
      Buffer.from(wire).toString('base64'),
      { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' },
    ]), SENDER_SIM_TIMEOUT_MS);
    if (sim === null) why = `no answer within ${SENDER_SIM_TIMEOUT_MS} ms`;
  } catch (e) {
    why = errorReason(e);
  }
  const v = sim?.value;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    if (v.err !== null && v.err !== undefined) throw simulationRefusal(v.err, v.logs);
    const units = v.unitsConsumed;
    if (typeof units === 'number' && Number.isSafeInteger(units) && units > 0) return senderLimitFromUnits(units);
  }
  logWarn(`[jupiter] ${lane.kind} lane compute units not measured (${why.slice(0, 160)}): signing the fixed ${JUP_SENDER_FALLBACK_CU} limit`);
  return JUP_SENDER_FALLBACK_CU;
}

/** The Sender lane of one attempt: a random Helius tip account, picked ONCE (the measured and the signed transaction then differ only in
 *  the compute-budget data). Address list verified against Helius docs 2026-05-02 — the same 10 staked-validator accounts. */
function senderLane(): BuildLane {
  return {
    kind: 'sender',
    tip: { account: CONFIG.HELIUS_TIP_ACCOUNTS[Math.floor(Math.random() * CONFIG.HELIUS_TIP_ACCOUNTS.length)], lamports: HELIUS_TIP_LAMPORTS },
  };
}

/** The validated range of the owner's priority fee setting (bot/trade-guards.ts): 0 .. 5 000 000 lamports. */
const RPC_LANE_MAX_FEE_LAMPORTS = 5_000_000;

/**
 * FIX-BUY2 item 4: the RPC lane of one attempt: no tip, and at most the owner's priority fee (global.priorityFee, lamports), the fee the
 * legacy /swap/v1/swap charged through prioritizationFeeLamports. Never above the setting's own maximum; an unusable value is no fee.
 */
function rpcLane(priorityFee: number): BuildLane {
  return { kind: 'rpc', feeLamports: BigInt(ownerFeeLamports(priorityFee)) };
}

/**
 * FIX-BUY: one /swap/v2/build transaction, signed: measure the limit, compose, sign. Throws PreSignRefusal, with nothing signed, when the
 * simulation says the swap would fail, and SenderOversizeError when it does not fit a packet (FIX-BUY2 item 3).
 */
async function signedBuildTx(build: BuildResponse, keypair: Keypair, lane: BuildLane): Promise<VersionedTransaction> {
  const cuLimit = await measureBuildLimit(build, keypair.publicKey, lane);
  const tx = composeSwapTxWithSenderTip(build, keypair.publicKey, lane, cuLimit);
  packetBytes(tx);                                                      // FIX-BUY2 item 3: never sign what no node takes (unsigned = the signed size)
  tx.sign([keypair]);
  return tx;
}

// ────────────────────────────────────────────────────────────
// The Jupiter trade routes (FIX-BUY2 items 2-4): ONE /swap/v2/build answer is the quote AND the route, on either lane. Its own price
// impact is capped, it is measured and simulated before signing (FIX-BUY), and no /swap/v1/quote is asked first.
//   anti-MEV on and a Sender URL set: the Helius tip, Jupiter's price clamped to the ceiling and scaled, sent through Helius Sender;
//   otherwise (anti-MEV is off by default): no tip, the owner's priority fee spread over the limit, sent through the multi-RPC blast.
//   The legacy /swap/v1/swap stands in, ONCE, only when /swap/v2/build had no answer or a 5xx (never after a 429, the same rate bucket;
//   never after "no route" or a refused request; never after a pre-sign refusal: it would send the same failing swap), or when the
//   composed transaction is over the packet (item 3).
// ────────────────────────────────────────────────────────────

/** One Jupiter trade: exact-in `amount` base units of `inputMint` for `outputMint` at `slippageBps`. */
interface JupTrade { inputMint: string; outputMint: string; amount: number; slippageBps: number }

interface JupRouteOpts {
  /** The owner's priority fee in lamports (the legacy /swap's prioritizationFeeLamports). */
  priorityFee: number;
  /** 2026-05-05: false (buys) returns once sent and confirms in the background; true (sells) blocks until landed. */
  awaitConfirm: boolean;
  /** A-26: every send goes through the send gate (onSigned before the send, buildOnly never sends, sigs recorded). */
  send?: SendContext;
  /** Jupiter's own wrap/unwrap of SOL (default true). */
  wrapSol: boolean;
}

/** A canonical unsigned integer string (what Jupiter returns for amounts), else undefined: a quote never carries a number it did not state. */
function amountText(v: unknown): string | undefined {
  if (typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v)) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  return undefined;
}

/**
 * FIX-BUY2 item 2: the quote of the route that is SIGNED, from its /swap/v2/build answer, as the router reads it (outAmount is the
 * expected tokensOut of a buy and solOut of a sell). Before, the router booked a v1 quote while /build was asked for a new route.
 */
function quoteOfBuild(build: BuildResponse, t: JupTrade): {
  inputMint: string; outputMint: string; inAmount: string; outAmount: string | undefined; otherAmountThreshold: string | undefined;
  priceImpactPct: string | number | undefined; slippageBps: number;
} {
  return {
    inputMint: t.inputMint, outputMint: t.outputMint,
    inAmount: amountText(build.inAmount) ?? String(t.amount),
    outAmount: amountText(build.outAmount),
    otherAmountThreshold: amountText(build.otherAmountThreshold),
    priceImpactPct: build.priceImpactPct,
    slippageBps: t.slippageBps,
  };
}

/** FIX-BUY2 item 2: the one /swap/v2/build failure the legacy /swap/v1/swap may stand in for: a 5xx or no answer (not a 429). */
function legacyFallbackAfter(e: unknown): boolean {
  return e instanceof JupiterUnavailableError && e.kind !== 'rate-limited';
}

/**
 * The /swap/v2/build route of one attempt, on either lane (FIX-BUY2 items 2 and 4): ONE /swap/v2/build request is the quote and the route.
 * Its own priceImpactPct is capped (A-26, before the measuring simulation and before signing); then FIX-BUY measures, signs and sends
 * (signedBuildTx -> dispatchSigned -> Helius Sender on the anti-MEV lane, the multi-RPC blast on the RPC lane), and the quote returned is
 * the build's own. The legacy /swap/v1/swap stands in once for a /build outage (5xx, no answer) or an oversized transaction (item 3).
 */
async function buildRoute(keypair: Keypair, t: JupTrade, o: JupRouteOpts, kind: BuildLane['kind']): Promise<{ sig: string; quote: any }> {
  const taker = keypair.publicKey.toString();
  let build: BuildResponse;
  try {
    build = await jupBuild(taker, t.inputMint, t.outputMint, t.amount, t.slippageBps, o.wrapSol);
  } catch (e) {
    if (!legacyFallbackAfter(e)) throw e;
    logWarn(`[jupiter] /swap/v2/build gave no usable answer (${errorReason(e).slice(0, 120)}): one legacy /swap/v1/swap instead`);
    return legacyRoute(keypair, t, o);
  }
  // A-26 on the route that is signed: the build's own impact, before anything is simulated or signed
  enforceImpactCap(o.send, 'jupiter', jupiterImpactPct(build));
  // FIX-BUY: measured (one read-only simulation), then signed; the simulation runs before onSigned, so a refusal journals nothing
  const lane = kind === 'sender' ? senderLane() : rpcLane(o.priorityFee);
  let tx: VersionedTransaction;
  try {
    tx = await signedBuildTx(build, keypair, lane);
  } catch (e) {
    // FIX-BUY2 item 3: an oversized route is refused before signing (nothing journalled): the legacy /swap/v1/swap, once. (The old
    // retry without the tip is gone: it never ran under singleSend, and Helius Sender rejects untipped transactions.)
    if (!(e instanceof SenderOversizeError)) throw e;
    logWarn(`[jupiter] ${e.message}: nothing was signed; one legacy /swap/v1/swap instead`);
    return legacyRoute(keypair, t, o);
  }
  // Any failure of the send goes back to the caller (executeWithRetry's next attempt, or nothing more under singleSend), never to the
  // legacy /swap (FIX-BUY2 item 2): the transaction may have reached a validator.
  const sender = (): Promise<string> => (lane.kind === 'sender' ? heliusSmartSend(tx, { awaitConfirm: o.awaitConfirm }) : multiRpcSend(tx, { awaitConfirm: o.awaitConfirm }));
  const sig = (await dispatchSigned(o.send, tx, 'jupiter', build.blockhashWithMetadata?.lastValidBlockHeight, sender)).sig;
  return { sig, quote: quoteOfBuild(build, t) };
}

/** The legacy route: one v1 quote (its own impact capped before anything is built, A-26), then /swap/v1/swap. */
async function legacyRoute(keypair: Keypair, t: JupTrade, o: JupRouteOpts): Promise<{ sig: string; quote: any }> {
  const quote = await jupQuote(t.inputMint, t.outputMint, t.amount, t.slippageBps);
  enforceImpactCap(o.send, 'jupiter', jupiterImpactPct(quote));
  const sig = await legacySwap(keypair, quote, o);
  return { sig, quote };
}

/** /swap/v1/swap: Jupiter's compiled transaction (its dynamic compute-unit limit, the owner's priority fee), signed, multi-RPC blast. */
async function legacySwap(keypair: Keypair, quote: any, o: JupRouteOpts): Promise<string> {
  const body: any = {
    quoteResponse: quote,
    userPublicKey: keypair.publicKey.toString(),
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: o.priorityFee,
    wrapAndUnwrapSol: o.wrapSol,
  };

  // FIX-BUY2 item 1: the keyed host only (the lite-api tier is gone), typed errors, the refused body logged
  const data = await jupRequest({ endpoint: 'swap', url: jupUrls().swap, method: 'POST', body: JSON.stringify(body), timeoutMs: 15_000 });

  const txBuf = Buffer.from(data.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  // Jupiter's /swap answer carries the blockhash's lastValidBlockHeight (the builder's value).
  return (await dispatchSigned(o.send, tx, 'jupiter', data.lastValidBlockHeight,
    () => multiRpcSend(tx, { awaitConfirm: o.awaitConfirm }))).sig;
}

// ────────────────────────────────────────────────────────────
// jupSwap — kept for direct callers: the /swap/v2/build route for `quote`'s pair, amount and slippage (FIX-BUY2 items 2 and 4), on the
// Sender lane when antiMev is on and a Sender URL is set, otherwise on the RPC lane. executeWithRetry no longer asks for a v1 quote.
// ────────────────────────────────────────────────────────────
export async function jupSwap(
  keypair: Keypair, quote: any, antiMev: boolean = true, priorityFee: number = 100000,
  opts: { wrapAndUnwrapSol?: boolean; awaitConfirm?: boolean; send?: SendContext } = {},
): Promise<string> {
  const o: JupRouteOpts = { priorityFee, awaitConfirm: opts.awaitConfirm === true, send: opts.send, wrapSol: opts.wrapAndUnwrapSol !== false };
  const t: JupTrade = { inputMint: quote.inputMint, outputMint: quote.outputMint, amount: Number(quote.inAmount), slippageBps: Number(quote.slippageBps || 100) };
  return (await buildRoute(keypair, t, o, antiMev && CONFIG.HELIUS_SENDER_URL ? 'sender' : 'rpc')).sig;
}

// ── Helius Smart-Send (MEV Protection) ──
// SPEC: https://www.helius.dev/docs/sending-transactions/sender
//   • POST to /fast endpoint
//   • Body: jsonrpc=sendTransaction, params=[base64Tx, {encoding:'base64', skipPreflight:true, maxRetries:0}]
//   • Tip is NOT a JSON-RPC param — it's a SystemProgram.transfer instruction
//     INSIDE the serialized tx (handled by composeSwapTxWithSenderTip).
//   • If the tx has no tip-instruction-to-a-staked-validator address, Sender
//     falls back to its slow path (no MEV benefit).
export interface SendOpts {
  /** When false (swap path default), fire confirmation in background and
   *  return sig immediately. When true or omitted, block up to 60s for confirmation. */
  awaitConfirm?: boolean;
  /** Optional callback fired in background if async confirm fails (revert,
   *  timeout, etc.). Caller uses this to roll back optimistic state. */
  onConfirmErr?: (e: Error) => void;
}

export async function heliusSmartSend(tx: VersionedTransaction, opts: SendOpts = {}): Promise<string> {
  const serialized = Buffer.from(tx.serialize()).toString('base64');
  // 2026-05-16 — wrap the send URL with the rebate-address param so MEV
  // captured from this snipe pays the rebate wallet the user configured. No-op
  // if no wallet is set or the URL isn't a Helius host (Sender + helius-rpc.com are both fine).
  const sendUrl = rpcUrlWithRebate(
    CONFIG.HELIUS_SENDER_URL || CONFIG.HELIUS_SEND_URL_BOT || CONFIG.HELIUS_SEND_URL
  );

  const r = await fetch(sendUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: Date.now(),
      method: 'sendTransaction',
      params: [serialized, {
        encoding: 'base64',
        skipPreflight: true,    // mandatory per spec
        maxRetries: 0,          // mandatory per spec — Sender handles re-broadcast
      }],
    }),
    timeout: 15000,
  });
  const data = await r.json() as any;
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const sig = data.result as string | undefined;
  if (!sig || typeof sig !== 'string' || sig.length < 32) {
    // Sender accepted the call but returned no usable signature — could be
    // a transient infra hiccup or a malformed response. Surface a clean
    // error so the caller can fall back to multiRpcSend instead of pretending.
    throw new Error(`Sender returned no signature (response: ${JSON.stringify(data).slice(0, 200)})`);
  }
  logOk(`Sender: ${sig.slice(0, 12)}...`);

  // 2026-05-05 — confirm asynchronously by default (returns sig immediately,
  // saves 600-2000ms per swap). Caller can opt into blocking with awaitConfirm: true.
  // Background confirm logs success or fires onConfirmErr on revert/timeout —
  // caller uses that to roll back optimistic state.
  if (opts.awaitConfirm) {
    await confirmTx(sig, 60_000, 'sender');
  } else {
    confirmTxBackground(sig, 'sender', opts.onConfirmErr);
  }
  return sig;
}

/**
 * Poll getSignatureStatuses until the tx is confirmed/finalized OR errored.
 * Throws on:
 *   • on-chain error (status.err present)
 *   • timeout exceeded (tx never landed — likely dropped or expired blockhash)
 *
 * Used by both Sender and multi-RPC paths so callers always get an honest
 * "tx landed cleanly" signal — no more fake-position bugs.
 */
export async function confirmTx(sig: string, timeoutMs: number, label: string): Promise<void> {
  if (!sig) throw new Error(`${label}: no signature returned`);
  const start = Date.now();
  let lastFetchErr: any = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await resilientRpcCall('getSignatureStatuses',
        [[sig], { searchTransactionHistory: true }]);
      const status = res?.value?.[0];
      if (status) {
        if (status.err) {
          // Tx landed but reverted — surface the on-chain error verbatim
          throw new Error(`${label}: tx reverted on-chain: ${JSON.stringify(status.err)}`);
        }
        if (status.confirmationStatus === 'confirmed' ||
            status.confirmationStatus === 'finalized') {
          logOk(`${label}: confirmed ${sig.slice(0, 12)}...`);
          return;
        }
      }
      lastFetchErr = null;
    } catch (e: any) {
      // If we successfully read a revert, re-throw immediately
      if (String(e?.message || '').includes('reverted on-chain')) throw e;
      lastFetchErr = e;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  // Timed out — never seen as confirmed. Caller MUST treat this as a failure.
  throw new Error(`${label}: tx not confirmed within ${timeoutMs / 1000}s — sig=${sig} (likely dropped or expired blockhash)`);
}

/**
 * Non-blocking confirm. Returns IMMEDIATELY so the caller can present the
 * sig to the user / TG card without waiting 0.4-1s for confirmation.
 *
 * 2026-05-05 latency optimization. Background poller logs success/failure
 * and invokes the optional onErr callback if the tx reverts on-chain or
 * times out — caller uses this to roll back any optimistically-recorded state
 * (e.g. delete the position entry from positions.json).
 *
 *   bot.ts pattern:
 *     const sig = await heliusSmartSend(tx);
 *     confirmTxBackground(sig, 'Buy DOGE', () => rollbackPosition(ca));
 *     return sig;   // user sees the sig in ~150ms instead of ~600-1500ms
 */
export function confirmTxBackground(
  sig: string, label: string,
  onErr?: (err: Error) => void,
  timeoutMs: number = 60_000,
): void {
  if (!sig) {
    if (onErr) onErr(new Error(`${label}: no signature returned`));
    return;
  }
  // Fire-and-forget. Errors are caught + logged + dispatched to onErr.
  confirmTx(sig, timeoutMs, label).catch((e: any) => {
    logWarn(`[bg-confirm] ${label}: ${e?.message || e}`);
    if (onErr) {
      try { onErr(e); } catch (cbErr: any) {
        logWarn(`[bg-confirm] onErr callback threw for ${label}: ${cbErr?.message || cbErr}`);
      }
    }
  });
}

// ── Multi-RPC Send + Confirm ──
export async function multiRpcSend(tx: VersionedTransaction, opts: SendOpts = {}): Promise<string> {
  const serialized = Buffer.from(tx.serialize()).toString('base64');

  // Blast to Helius + Alchemy + public RPCs. The Helius URL gets the
  // rebate-address param so 50% of any MEV captured pays the rebate wallet the
  // user configured (none set = no param); other lanes are unchanged
  // (rpcUrlWithRebate is a no-op for non-Helius hosts).
  const rpcs = [rpcUrlWithRebate(CONFIG.HELIUS_RPC), CONFIG.ALCHEMY_RPC, ...PUBLIC_RPCS].filter(Boolean);
  const sendPromises = rpcs.map(rpc =>
    fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'sendTransaction',
        params: [serialized, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }],
      }),
      timeout: 10000,
    }).then(r => r.json()).catch(() => null)
  );

  const results = await Promise.allSettled(sendPromises);
  let sig = '';
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value?.result) {
      sig = r.value.result;
      break;
    }
  }

  if (!sig) throw new Error('All RPCs failed to send transaction');

  // 2026-05-05 — confirm asynchronously by default. Background confirm logs
  // success or fires onConfirmErr on revert/timeout. Caller opts into
  // blocking with awaitConfirm: true (e.g. emergency stop / manual sell).
  if (opts.awaitConfirm) {
    await confirmTx(sig, 60_000, 'multi-rpc');
  } else {
    confirmTxBackground(sig, 'multi-rpc', opts.onConfirmErr);
  }
  return sig;
}

// ── Smart Slippage Retry ──
// ════════════════════════════════════════════════════════════════════════
// JUPITER SWAP V2 /order + /execute (2026-05-15; FIX-BUY2 item 7)
// ════════════════════════════════════════════════════════════════════════
// GET /swap/v2/order asks Jupiter's meta-aggregator (Metis, Dflow, OKX; JupiterZ RFQ is excluded here) for a built, UNSIGNED transaction
// and a requestId; the owner signs it and POST /swap/v2/execute broadcasts and confirms it server-side. Two callers:
//   - USE_JUPITER_V3=1 (off by default): every attempt orders first; the first attempt's failed order goes on with the /swap/v2/build route;
//   - JUP_ORDER_FALLBACK=sell|both (off by default): ONE order after /swap/v2/build answered "No routes found" (Jupiter's market-listing
//     page: when Metis drops a market, /build says no route while /order may still route it through OKX or Dflow).
// The order transaction is never modified (/execute validates the message: no tip, no compute-budget or close instruction is added), and it
// is signed only when (a) Jupiter built one, (b) the owner is its fee payer and only signer, (c) its priority fee is at most 2 x the one
// asked (A-27), (d) its own price impact is under the cap and (e) its simulation moves only what was asked. (f) onSigned journals it before
// /execute; (g) lastValidBlockHeight arrives as a string.
// ════════════════════════════════════════════════════════════════════════

/** The /swap/v2/order answer (Jupiter's documented fields that the bot reads). */
interface JupOrderResponse {
  /** base64 unsigned VersionedTransaction; '' when Jupiter will not build one (see errorCode). */
  transaction?: string | null;
  requestId?: string;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  /** 'metis' (renamed from 'iris' in May 2026) | 'jupiterz' | 'dflow' | 'okx'. */
  router?: string;
  /** A RESPONSE field ('ultra' when no optional parameter was sent, else 'manual'); there is no mode request parameter. */
  mode?: string;
  feeBps?: number;
  gasless?: boolean;
  signatureFeePayer?: string;
  /** The order's price impact in PERCENT (-0.1 = -0.1 %). */
  priceImpact?: string | number;
  /** DEPRECATED by Jupiter (a fraction); not read. */
  priceImpactPct?: string | number;
  slippageBps?: number;
  /** A STRING on /swap/v2/order. */
  lastValidBlockHeight?: string | number;
  errorCode?: number | string;
  errorMessage?: string;
  error?: string;
}

/**
 * A-26: price impact in PERCENT of a Jupiter quote or order, from its `priceImpactPct` field. Jupiter reports that field
 * as a fraction ("0.0123" = 1.23%), as a string in the quote API, so it is multiplied by 100 here. Absent, empty or
 * unparseable gives null, and a null impact is refused when a cap is set (fail closed). The sign is dropped.
 * The unit is the documented one and is pinned by jupiter.test.ts; R5-CUT re-checks it against a recorded response.
 * (FIX-BUY2: /swap/v1/quote and /swap/v2/build use it; /swap/v2/order reports `priceImpact` in percent: jupiterOrderImpactPct.)
 */
export function jupiterImpactPct(q: { priceImpactPct?: unknown } | null | undefined): number | null {
  const raw = q?.priceImpactPct;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.abs(n) * 100;
}

/**
 * FIX-BUY2 item 7(d): the price impact in PERCENT of a /swap/v2/order answer: abs(priceImpact), which /order already reports in percent
 * (its priceImpactPct fraction is deprecated and not read). Absent, empty or unparseable is null: refused when a cap is set.
 */
export function jupiterOrderImpactPct(o: { priceImpact?: unknown } | null | undefined): number | null {
  const raw = o?.priceImpact;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.abs(n) : null;
}

interface JupExecuteResponse {
  status?: 'Success' | 'Failed' | string;
  signature?: string;
  /** 0 = success; Jupiter's table gives the others (see JUP_EXECUTE_CODES). */
  code?: number | string;
  error?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
}

/** Why an /order transaction was refused before signing (nothing was signed, journalled or sent). */
export type JupiterOrderRefusalKind = 'no-transaction' | 'stale-size' | 'gasless' | 'signer' | 'fee' | 'simulation' | 'malformed';

/**
 * FIX-BUY2 item 7: Jupiter's /swap/v2/order answer was refused before signing. Final for the call (the order fallback is ONE order; in
 * USE_JUPITER_V3 mode the first attempt goes on with the /swap/v2/build route, except after a stale sell size).
 */
export class JupiterOrderRefusal extends Error {
  readonly kind: JupiterOrderRefusalKind;
  constructor(kind: JupiterOrderRefusalKind, reason: string) {
    super(`Jupiter /swap/v2/order refused before signing: ${redactSecrets(reason).slice(0, 130)}. Nothing was sent; no fee was paid.`);
    this.name = 'JupiterOrderRefusal';
    this.kind = kind;
  }
}

/** /swap/v2/execute codes (Jupiter's table), as the owner reads them. */
const JUP_EXECUTE_CODES: Readonly<Record<number, string>> = {
  [-1]: 'the order expired or is unknown', [-2]: 'invalid signed transaction', [-3]: 'invalid message bytes',
  [-1000]: 'failed to land', [-1001]: 'unknown error', [-1002]: 'invalid transaction', [-1003]: 'not fully signed',
  [-1004]: 'invalid block height', [-1005]: 'expired before landing (signed too late)',
  [-2000]: 'RFQ failed to land', [-2001]: 'RFQ unknown error', [-2002]: 'invalid RFQ payload', [-2003]: 'RFQ quote expired', [-2004]: 'rejected by the market maker',
};

/**
 * FIX-BUY2 item 7(f): /swap/v2/execute did not report success (a non-zero code, status Failed, or a refused request) AFTER the signed
 * transaction was handed over. The signature is already in the journal and in the router's RouterSendError.sigs: the caller's landed-check
 * decides, never this error.
 */
export class JupiterExecuteError extends Error {
  /** Jupiter's code (null when the answer carried none). */
  readonly code: number | null;
  /** The HTTP status of the answer (null: no answer). */
  readonly status: number | null;
  constructor(code: number | null, status: number | null, detail: string) {
    const what = code === null ? '' : ` code ${code}${JUP_EXECUTE_CODES[code] ? ` (${JUP_EXECUTE_CODES[code]})` : ''}`;
    super(`Jupiter /swap/v2/execute did not confirm the swap:${what} ${redactSecrets(detail).slice(0, 110)}`.trim().slice(0, 200));
    this.name = 'JupiterExecuteError';
    this.code = code;
    this.status = status;
  }
}

/** A-27 (tx-verify PUMPPORTAL_PRIORITY_FEE_MAX_FACTOR): a third party's transaction may pay at most 2 x the priority fee the bot asked for. */
export const ORDER_PRIORITY_FEE_MAX_FACTOR = 2;
/** The network fee per signature. */
const LAMPORTS_PER_SIGNATURE = 5_000n;
/**
 * FIX-BUY2 item 7(e): the rent the owner may pay for each token account of the owner the order creates (an output or intermediate
 * account): (300 + 128) bytes x 6 960 lamports, the pre-2026 rate, above any token account's rent today (1 488 440 for 165 bytes).
 */
export const ORDER_NEW_ACCOUNT_RENT_MAX = 2_978_880n;
/** The most writable accounts whose state a simulation is asked to return. */
const ORDER_MAX_SIMULATED_ACCOUNTS = 64;
/** FIX-BUY2 item 7(e): how long the order's account reads and simulation may take; no answer is a refusal (fail closed). */
export const ORDER_SIM_TIMEOUT_MS = 4_000;
const ALT_PROGRAM_ID = 'AddressLookupTab1e1111111111111111111111111';

/** The owner's priority fee setting in lamports, inside its validated range (bot/trade-guards.ts: 0 .. 5 000 000); unusable = 0. */
function ownerFeeLamports(priorityFee: number): number {
  return Number.isFinite(priorityFee) && priorityFee > 0 ? Math.floor(Math.min(priorityFee, RPC_LANE_MAX_FEE_LAMPORTS)) : 0;
}

/**
 * FIX-BUY2 item 7: ONE GET /swap/v2/order (keyed, typed errors: item 1). The query is Jupiter's documented one: inputMint, outputMint,
 * amount, taker = the owner, slippageBps (at most 10 000), excludeRouters=jupiterz (no RFQ maker co-signs), priorityFeeLamports = the
 * owner's priority fee with broadcastFeeType=maxCap, and jitoTipLamports only with anti-MEV. No `mode` (it is not a request parameter:
 * the bot used to send mode=ultra) and no swapMode (ExactIn is the only mode).
 */
async function jupOrderRequest(
  inputMint: string, outputMint: string, amount: number,
  taker: string, slippageBps: number, priorityFeeLamports: number, jitoTipLamports: number,
): Promise<JupOrderResponse> {
  const qs = new URLSearchParams({
    inputMint, outputMint,
    amount: String(amount),
    taker,
    slippageBps: String(jupSlippageBps(slippageBps)),
    excludeRouters: 'jupiterz',
    priorityFeeLamports: String(priorityFeeLamports),
    broadcastFeeType: 'maxCap',
  });
  if (jitoTipLamports > 0) qs.set('jitoTipLamports', String(jitoTipLamports));
  const j = await jupRequest({ endpoint: 'order', url: `${jupUrls().order}?${qs.toString()}`, method: 'GET', timeoutMs: 12_000 });
  if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new JupiterOrderRefusal('malformed', 'the order answer is not an object');
  return j as JupOrderResponse;
}

/** A /execute body's code (an HTTP 400 carries {error, code}), when the redacted body shows one. */
function executeCodeOf(body: string): number | null {
  const m = /"code"\s*:\s*(-?\d{1,6})/.exec(body);
  return m === null ? null : Number(m[1]);
}

/**
 * FIX-BUY2 item 7(f): POST /swap/v2/execute {signedTransaction, requestId}. A 429, 5xx or no answer is POSTed ONCE more, identical
 * (idempotent at Jupiter for about 2 minutes: the same signature cannot execute twice). Success is code 0 (status Success); anything else
 * is a JupiterExecuteError carrying the code.
 */
async function jupExecuteRequest(signedTxBase64: string, requestId: string): Promise<JupExecuteResponse> {
  let j: JupExecuteResponse;
  try {
    j = await jupRequest({
      endpoint: 'execute', url: jupUrls().execute, method: 'POST', retry: 'once', timeoutMs: 30_000,
      body: JSON.stringify({ signedTransaction: signedTxBase64, requestId }),
    }) as JupExecuteResponse;
  } catch (e) {
    if (e instanceof JupiterError) throw new JupiterExecuteError(executeCodeOf(e.body), e.status, e.message);
    throw e;
  }
  const rawCode = j?.code;
  const code = rawCode === undefined || rawCode === null || rawCode === '' ? null : Number(rawCode);
  const ok = j?.status !== 'Failed' && (code === 0 || (code === null && j?.status === 'Success'));
  if (!ok) {
    throw new JupiterExecuteError(code !== null && Number.isFinite(code) ? code : null, 200, `status ${String(j?.status ?? '-')}: ${String(j?.error ?? '')}`);
  }
  return j;
}

/**
 * FIX-BUY2 item 7(a): a /swap/v2/order answer with no transaction. Read by router and errorCode (Jupiter's table, metis/dflow/okx):
 * 2 = too little SOL for the fees; 1 = too little of the input: SOL on a buy, the TOKEN on a sell (the position size is stale: final).
 */
function orderWithoutTransaction(o: JupOrderResponse, side: 'buy' | 'sell'): Error {
  const router = typeof o.router === 'string' ? o.router.toLowerCase() : '';
  const code = o.errorCode === undefined || o.errorCode === null || o.errorCode === '' ? null : Number(o.errorCode);
  const said = redactSecrets(String(o.errorMessage ?? o.error ?? '')).replace(/\s+/g, ' ').trim().slice(0, 80);
  const paid = 'Nothing was sent; no fee was paid.';
  if (['metis', 'iris', 'dflow', 'okx'].includes(router)) {
    if (code === 2) return new PreSignRefusal('insufficient-sol', `Jupiter /order: not enough SOL in the wallet for the network fee (errorCode 2). ${paid}`);
    if (code === 1 && side === 'buy') return new PreSignRefusal('insufficient-sol', `Jupiter /order: the wallet holds less SOL than the buy amount (errorCode 1). ${paid}`);
    if (code === 1) return new JupiterOrderRefusal('stale-size', 'the wallet holds fewer tokens than this sell (errorCode 1): the position size is stale');
  }
  return new JupiterOrderRefusal('no-transaction', `Jupiter built no transaction (router ${router || '-'}, errorCode ${code ?? '-'}${said ? `: ${said}` : ''})`);
}

/** The addresses a v0 message loads from its lookup tables (writable first, then readonly), read from the CHAIN, never from the answer. */
async function orderLookupAddresses(lookups: ReadonlyArray<{ accountKey: PublicKey; writableIndexes: number[]; readonlyIndexes: number[] }>): Promise<string[]> {
  const writable: string[] = [];
  const readonly: string[] = [];
  for (const l of lookups) {
    let res: any = null;
    try {
      res = await withTimeout(resilientRpcCall('getAccountInfo', [l.accountKey.toBase58(), { encoding: 'base64', commitment: 'confirmed' }]), ORDER_SIM_TIMEOUT_MS);
    } catch (e) {
      throw new JupiterOrderRefusal('simulation', `a lookup table of the order cannot be read (${errorReason(e).slice(0, 60)})`);
    }
    const bytes = accountBytes(res?.value);
    if (bytes === null || res?.value?.owner !== ALT_PROGRAM_ID) throw new JupiterOrderRefusal('simulation', 'a lookup table of the order cannot be read');
    let table: AddressLookupTableAccount['state'];
    try { table = AddressLookupTableAccount.deserialize(bytes); } catch { throw new JupiterOrderRefusal('simulation', 'a lookup table of the order cannot be decoded'); }
    for (const i of l.writableIndexes) {
      const a = table.addresses[i];
      if (!a) throw new JupiterOrderRefusal('simulation', 'a lookup table index of the order is out of range');
      writable.push(a.toBase58());
    }
    for (const i of l.readonlyIndexes) {
      const a = table.addresses[i];
      if (!a) throw new JupiterOrderRefusal('simulation', 'a lookup table index of the order is out of range');
      readonly.push(a.toBase58());
    }
  }
  return [...writable, ...readonly];
}

/**
 * FIX-BUY2 item 7(e): ONE simulation (sigVerify false) of the unsigned order transaction, with the state of every writable account read
 * before it (getMultipleAccounts) and returned after it (the simulation's `accounts`). It must succeed and move only what was asked:
 *   buy  -> the owner's tokens of the mint grow, and the owner's SOL (lamports + wSOL) falls by at most the amount + the network fee +
 *           2 x the priority fee asked + the Jito tip asked + the rent of the owner's own new token accounts (each at most
 *           ORDER_NEW_ACCOUNT_RENT_MAX);
 *   sell -> the owner's SOL grows, and the owner's tokens of the mint fall by at most the amount sold;
 *   and no token account of the owner gains a delegate, a close authority or another owner, changes the amount of another mint, or (other
 *   than a wSOL account) is closed. These are tx-verify step (d) and ext-verify's owner-account rule (sim-owner-checks.ts).
 * A failed simulation is a PreSignRefusal (too little SOL: 'insufficient-sol'); anything else wrong, or no answer, is a JupiterOrderRefusal.
 */
async function verifyOrderBySimulation(
  tx: VersionedTransaction,
  c: { owner: string; side: 'buy' | 'sell'; mint: string; amount: bigint; priorityFeeLamports: bigint; tipLamports: bigint },
): Promise<void> {
  const msg = tx.message;
  const staticKeys = msg.staticAccountKeys.map((k) => k.toBase58());
  const lookups = (msg as { addressTableLookups?: Array<{ accountKey: PublicKey; writableIndexes: number[]; readonlyIndexes: number[] }> }).addressTableLookups ?? [];
  const keys = lookups.length > 0 ? [...staticKeys, ...(await orderLookupAddresses(lookups))] : staticKeys;
  const writable: string[] = [];
  for (let i = 0; i < keys.length; i++) if (msg.isAccountWritable(i) && !writable.includes(keys[i])) writable.push(keys[i]);
  if (!writable.includes(c.owner)) throw new JupiterOrderRefusal('simulation', 'the owner account is not writable in the order');
  if (writable.length > ORDER_MAX_SIMULATED_ACCOUNTS) throw new JupiterOrderRefusal('simulation', `the order writes ${writable.length} accounts, too many to simulate`);

  const wire = Buffer.from(tx.serialize()).toString('base64');            // unsigned: zero signature slot
  let pre: any;
  let sim: any;
  try {
    [pre, sim] = await Promise.all([
      withTimeout(resilientRpcCall('getMultipleAccounts', [writable, { encoding: 'base64', commitment: 'confirmed' }]), ORDER_SIM_TIMEOUT_MS),
      withTimeout(resilientRpcCall('simulateTransaction', [wire, {
        encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
        accounts: { encoding: 'base64', addresses: writable },
      }]), ORDER_SIM_TIMEOUT_MS),
    ]);
  } catch (e) {
    throw new JupiterOrderRefusal('simulation', `the order could not be simulated (${errorReason(e).slice(0, 60)})`);
  }
  if (pre === null || sim === null) throw new JupiterOrderRefusal('simulation', `no simulation answer within ${ORDER_SIM_TIMEOUT_MS} ms`);
  const v = sim?.value;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new JupiterOrderRefusal('simulation', 'the simulation returned no result');
  if (v.err !== null && v.err !== undefined) throw simulationRefusal(v.err, v.logs);
  const preList = pre?.value;
  const postList = v.accounts;
  if (!Array.isArray(preList) || !Array.isArray(postList) || preList.length !== writable.length || postList.length !== writable.length) {
    throw new JupiterOrderRefusal('simulation', 'the simulated accounts are unreadable');
  }
  const preA = preList.map(parseChainAccount);
  const postA = postList.map(parseChainAccount);
  if (preA.some((a) => a === undefined) || postA.some((a) => a === undefined)) throw new JupiterOrderRefusal('simulation', 'a simulated account could not be decoded');
  const before = preA as Array<ChainAccount | null>;
  const after = postA as Array<ChainAccount | null>;

  // the owner's token accounts: authorities unchanged; only the traded mint and wSOL change amounts; only wSOL accounts may be closed
  const allowed = new Set<string>();
  let rentAllowance = 0n;
  for (let i = 0; i < writable.length; i++) {
    const ta = ownerTokenAccount(c.owner, before[i]);
    const tb = ownerTokenAccount(c.owner, after[i]);
    if (ta === null || ta.mint === c.mint || ta.mint === WSOL_MINT_PK.toBase58()) allowed.add(writable[i]);
    if (ta !== null && tb === null && ta.mint !== WSOL_MINT_PK.toBase58()) throw new JupiterOrderRefusal('simulation', 'the order closes or hands over a token account of the owner');
    // rent: only an account that did not exist before and is the owner's token account after (an existing account handed over cost nothing)
    if (before[i] === null && tb !== null) {
      const lam = after[i]?.lamports ?? 0n;
      rentAllowance += lam < ORDER_NEW_ACCOUNT_RENT_MAX ? lam : ORDER_NEW_ACCOUNT_RENT_MAX;
    }
  }
  const owned = ownerTokenAccountsRefusal(c.owner, writable, before, after, allowed);
  if (owned !== null) throw new JupiterOrderRefusal('simulation', owned);

  // what the swap moved (tx-verify step (d)): the owner's SOL is its lamports plus its wSOL
  const h0 = ownerHoldings(c.owner, c.mint, writable, before);
  const h1 = ownerHoldings(c.owner, c.mint, writable, after);
  const flow = { lamportsBefore: h0.lamports + h0.wsol, lamportsAfter: h1.lamports + h1.wsol, tokensBefore: h0.tokens, tokensAfter: h1.tokens };
  const network = LAMPORTS_PER_SIGNATURE * BigInt(msg.header.numRequiredSignatures);
  const maxLamportsOut = c.amount + network + BigInt(ORDER_PRIORITY_FEE_MAX_FACTOR) * c.priorityFeeLamports + c.tipLamports + rentAllowance;
  const why = swapFlowRefusal(flow, c.side === 'buy' ? { side: 'buy', maxLamportsOut } : { side: 'sell', tokensIn: c.amount });
  if (why !== null) throw new JupiterOrderRefusal('simulation', why);
}

/**
 * One /swap/v2/order + /execute (FIX-BUY2 item 7; also the USE_JUPITER_V3 path). Returns the signature and the order's quote, shaped like
 * the other routes' { sig, quote } (quote.outAmount is the route's expected output).
 */
export async function jupiterOrderAndExecute(
  keypair: Keypair, inputMint: string, outputMint: string,
  amount: number, slippageBps: number,
  priorityFee: number = 100_000,
  jitoTip: number = HELIUS_TIP_LAMPORTS,
  send?: SendContext,
): Promise<{ sig: string; quote: any }> {
  const taker = keypair.publicKey.toBase58();
  const side: 'buy' | 'sell' = inputMint === SOL_MINT ? 'buy' : 'sell';
  const feeLamports = ownerFeeLamports(priorityFee);
  const tipLamports = Number.isFinite(jitoTip) && jitoTip > 0 ? Math.floor(jitoTip) : 0;
  const order = await jupOrderRequest(inputMint, outputMint, amount, taker, slippageBps, feeLamports, tipLamports);

  // (a) no transaction: Jupiter's own balance pre-check, read by router + errorCode (never "missing transaction")
  if (typeof order.transaction !== 'string' || order.transaction === '') throw orderWithoutTransaction(order, side);
  if (typeof order.requestId !== 'string' || order.requestId === '') throw new JupiterOrderRefusal('malformed', 'the order carries no requestId');
  // (d) A-26: the order's own impact (percent), before the transaction is decoded, simulated or signed
  enforceImpactCap(send, 'jupiter', jupiterOrderImpactPct(order));

  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64')); } catch { throw new JupiterOrderRefusal('malformed', 'the order transaction cannot be decoded'); }
  // (b) the owner pays and signs alone: no gasless sponsor (its signature slot would come first) and no RFQ maker
  const payer = tx.message.staticAccountKeys[0]?.toBase58();
  const sponsor = typeof order.signatureFeePayer === 'string' && order.signatureFeePayer !== '' && order.signatureFeePayer !== taker;
  if (payer !== taker || order.gasless === true || sponsor) throw new JupiterOrderRefusal('gasless', 'the owner is not the fee payer (a gasless order)');
  if (tx.message.header.numRequiredSignatures !== 1) {
    throw new JupiterOrderRefusal('signer', `it needs ${tx.message.header.numRequiredSignatures} signatures: the owner must be the only signer`);
  }
  // (c) A-27: its priority fee is at most 2 x the one asked
  const fee = computeBudgetFeeLamports(tx);
  if (!fee.ok) throw new JupiterOrderRefusal('fee', `its compute-budget instructions are refused (${fee.reason})`);
  const feeBound = BigInt(ORDER_PRIORITY_FEE_MAX_FACTOR) * BigInt(feeLamports);
  if (fee.lamports > feeBound) throw new JupiterOrderRefusal('fee', `its priority fee ${fee.lamports} lamports is above ${ORDER_PRIORITY_FEE_MAX_FACTOR} x the ${feeLamports} asked`);
  // (e) one simulation that must succeed and move only what was asked
  await verifyOrderBySimulation(tx, {
    owner: taker, side, mint: side === 'buy' ? outputMint : inputMint, amount: BigInt(amount),
    priorityFeeLamports: BigInt(feeLamports), tipLamports: BigInt(tipLamports),
  });

  // (f) sign, journal (onSigned) BEFORE /execute; the "send" of this route is the /execute call (Jupiter broadcasts server-side)
  tx.sign([keypair]);
  const signedB64 = Buffer.from(tx.serialize()).toString('base64');
  const requestId = order.requestId;
  // (g) lastValidBlockHeight arrives as a string
  const lvbh = Number(order.lastValidBlockHeight);
  const { sig } = await dispatchSigned(send, tx, 'jupiter', Number.isFinite(lvbh) && lvbh > 0 ? lvbh : null, async () => {
    const exec = await jupExecuteRequest(signedB64, requestId);
    const ours = bs58.encode(tx.signatures[0]);
    if (typeof exec.signature === 'string' && exec.signature !== ours) logWarn(`[jupiter] /swap/v2/execute reported ${exec.signature.slice(0, 12)}… for ${ours.slice(0, 12)}…: the signed one is recorded`);
    logOk(`Jupiter /order ${order.router || '?'} → ${ours.slice(0, 12)}…  out=${order.outAmount}`);
    return ours;
  });
  return {
    sig,
    quote: {
      inputMint, outputMint,
      inAmount: amountText(order.inAmount) ?? String(amount),
      outAmount: amountText(order.outAmount),
      otherAmountThreshold: amountText(order.otherAmountThreshold),
      priceImpact: order.priceImpact,
      slippageBps: jupSlippageBps(slippageBps),
      router: order.router,
      mode: order.mode,
      feeBps: order.feeBps,
    },
  };
}

export async function executeWithRetry(
  keypair: Keypair, inputMint: string, outputMint: string,
  amount: number, baseSlippage: number, maxAttempts: number = 3,
  antiMev: boolean = true, priorityFee: number = 100000,
  awaitConfirm: boolean = false,    // 2026-05-05 — pass true for SELL paths
  send?: SendContext,               // A-26: onSigned / buildOnly / singleSend / maxImpactPct (additive; absent = old behaviour)
): Promise<{ sig: string; quote: any }> {
  // FIX-BUY2 item 1: every Jupiter slippage stays inside Jupiter's 0..10 000 bps (a sell at 9 900 escalated to 14 850 got a 400)
  let slippage = jupSlippageBps(baseSlippage);
  // A-58: a buy (SOL in) never retries above the caller's slippage (RouterOpts.slippageBps is its cap); sells may escalate, but never
  // once the simulation has refused a transaction of this call (FIX-BUY review, `refused` below), and never above 10 000 bps.
  const maxSlippage = inputMint === SOL_MINT ? slippage : jupSlippageBps(baseSlippage * 3);
  const useV3 = CONFIG.USE_JUPITER_V3;
  // FIX-BUY (review): the Sender simulation refused a transaction of this call (PreSignRefusal, nothing sent). From then on every attempt
  // keeps the slippage, buy or sell. Before the simulation that transaction was SENT at this slippage and reverted, and singleSend (every
  // production buy and sell) ended the call there; the router must not now raise a sell to 1.5x / 2.25x on its own, above the owner's
  // retry maximum. The sell ladder (sell-runner, tpAttemptSlippageBps) escalates within the owner's limits.
  let refused = false;
  // FIX-BUY2 item 7: at most ONE /swap/v2/order per call (the V3 path's own order counts): the fallback after a /build no-route
  let orderTried = false;
  const side: 'buy' | 'sell' = inputMint === SOL_MINT ? 'buy' : 'sell';
  const orderFallback = CONFIG.JUP_ORDER_FALLBACK === 'both' || (CONFIG.JUP_ORDER_FALLBACK === 'sell' && side === 'sell');

  /**
   * One attempt's route (FIX-BUY2 items 2 and 4): the /swap/v2/build answer is the quote and the route, no /swap/v1/quote first (the v1
   * quote was only a gate, stricter than the route signed, and its impact and output described another route). Anti-MEV with a Sender
   * URL: the Sender lane; otherwise (the default setting) the RPC lane, from the same build, impact check, measuring and simulation.
   */
  const route = async (): Promise<{ sig: string; quote: any }> => {
    const t: JupTrade = { inputMint, outputMint, amount, slippageBps: slippage };
    const o: JupRouteOpts = { priorityFee, awaitConfirm, send, wrapSol: true };
    return buildRoute(keypair, t, o, antiMev && CONFIG.HELIUS_SENDER_URL ? 'sender' : 'rpc');
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (!useV3) return await route();
      // ── 2026-05-15 — Ultra V3 path (order+execute meta-aggregator)
      try {
        orderTried = true;
        const jitoTip = antiMev ? HELIUS_TIP_LAMPORTS : 0;
        return await jupiterOrderAndExecute(keypair, inputMint, outputMint, amount, slippage, priorityFee, jitoTip, send);
      } catch (eo: any) {
        // the first attempt's failed order goes on, in the same attempt, with the /swap/v2/build route (FIX-BUY2 item 7: also after
        // Jupiter refused the order request or the bot refused the order, unless /build would meet the same answer: v3MayFallBack)
        if (attempt !== 1 || !v3MayFallBack(send, eo)) throw eo;
        logWarn(`V3 attempt ${attempt} failed (${String(eo?.message || eo).slice(0, 100)}); this attempt goes on with the /swap/v2/build route`);
        return await route();
      }
    } catch (e: any) {
      // FIX-BUY2 item 7: /swap/v2/build has no route for this pair; with JUP_ORDER_FALLBACK on for this side, ONE /swap/v2/order + /execute
      // (Jupiter's meta-aggregator may still route a market Metis dropped). Whatever it answers ends the call.
      if (e instanceof JupiterNoRouteError && e.endpoint === 'build' && orderFallback && !orderTried && !mustStop(send, e)) {
        orderTried = true;
        logWarn(`[jupiter] /swap/v2/build: no route; JUP_ORDER_FALLBACK=${CONFIG.JUP_ORDER_FALLBACK}: one /swap/v2/order + /execute`);
        return await jupiterOrderAndExecute(keypair, inputMint, outputMint, amount, slippage, priorityFee, antiMev ? HELIUS_TIP_LAMPORTS : 0, send);
      }
      if (finalJupiterFailure(send, e)) {
        if (e instanceof JupiterNoRouteError) logWarn(`[jupiter] no route for this pair: no retry at another slippage (${String(e.message).slice(0, 120)})`);
        throw e;
      }
      if (e instanceof PreSignRefusal) refused = true;
      if (attempt === maxAttempts) throw e;
      if (!refused) slippage = Math.min(Math.round(slippage * 1.5), maxSlippage, JUP_MAX_SLIPPAGE_BPS);
      logWarn(`Attempt ${attempt} failed, retrying with ${slippage}bps slippage: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('All retry attempts exhausted');
}

/**
 * The failures after which executeWithRetry tries nothing else for the call:
 *   - ImpactCapError (A-26: a higher slippage does not change the impact); onSigned threw, or singleSend after a send (mustStop);
 *   - PreSignRefusal 'insufficient-sol' (FIX-BUY: another attempt cannot add SOL; 'simulation-failed' is retried at the same slippage);
 *   - JupiterNoRouteError (FIX-BUY2: no route at any slippage, replacing the old "tiers exhausted" / "no route" text match, which also
 *     caught 429 storms and 5xx) and JupiterRequestError (a 400 or a key problem is the same answer on every attempt);
 *   - JupiterOrderRefusal (FIX-BUY2 item 7: an /order transaction the bot will not sign is the same answer on the next attempt).
 * JupiterUnavailableError (429, 5xx, no answer) is retried like any outage.
 */
function finalJupiterFailure(send: SendContext | undefined, e: unknown): boolean {
  if (e instanceof ImpactCapError || mustStop(send, e)) return true;
  if (e instanceof PreSignRefusal) return e.kind === 'insufficient-sol';
  return e instanceof JupiterNoRouteError || e instanceof JupiterRequestError || e instanceof JupiterOrderRefusal;
}

/**
 * USE_JUPITER_V3: may the first attempt's failed /order go on with the /swap/v2/build route? Not after a send (mustStop), an impact
 * refusal, too little SOL or a stale sell size: /build would meet the same. Any other failure of the order (Jupiter refused the order
 * request or found no order route, the bot refused the order transaction, an outage) is that route's own answer.
 */
function v3MayFallBack(send: SendContext | undefined, e: unknown): boolean {
  if (e instanceof ImpactCapError || mustStop(send, e)) return false;
  if (e instanceof PreSignRefusal) return e.kind !== 'insufficient-sol';
  if (e instanceof JupiterOrderRefusal) return e.kind !== 'stale-size';
  return true;
}

// ── Helper: SOL to lamports ──
export function lamports(sol: number): number {
  return Math.round(sol * 1e9);
}

// ── Helper: Get SOL balance ──
export async function getSolBalance(address: string): Promise<number> {
  // Use bot lane first (dedicated trading key) so engine scan-bursts can't
  // make balance checks return 0 from rate-limit failures. Fall back to
  // resilientRpcCall (full pool with public-RPC failover) if both Helius
  // keys fail. This is what the user saw in the TG bot — balance "0" when
  // the engine had eaten the shared key's quota.
  const primary = CONFIG.HELIUS_RPC_BOT || CONFIG.HELIUS_RPC;
  try {
    const r = await fetch(primary, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address, { commitment: 'confirmed' }] }),
      timeout: 6000,
    } as any);
    if (r.status === 429) throw new Error('429 rate limit');
    const data = await r.json() as any;
    if (data.error) throw new Error(data.error.message);
    if (typeof data.result?.value === 'number') return data.result.value;
    throw new Error('unexpected response shape');
  } catch (e: any) {
    // Fall back to the resilient pool — slower but reliable
    try {
      const result = await resilientRpcCall('getBalance', [address, { commitment: 'confirmed' }]);
      return result?.value || 0;
    } catch (e2: any) {
      logWarn(`getSolBalance ${address.slice(0, 6)} all RPCs failed: ${e2.message}`);
      return 0;
    }
  }
}

// ── Helper: Get wSOL balance for an address ──
// Returns the balance in SOL units (uiAmount). 0 if the wSOL ATA doesn't
// exist yet or the lookup fails. Used by the bot to decide whether to skip
// Jupiter's auto-wrap when usePreWrappedSol is on.
export async function getWsolBalance(address: string): Promise<number> {
  try {
    const ata = deriveAtaAddress(WSOL_MINT_PK, new PublicKey(address));
    const res = await resilientRpcCall('getTokenAccountBalance', [ata.toBase58(), { commitment: 'confirmed' }]);
    return Number(res?.value?.uiAmount || 0);
  } catch { return 0; }
}

// ── Helper: Get any SPL token balance for an address ──
// Returns:
//   • { uiAmount, decimals, rawAtoms } — confirmed reading from RPC
//   • null                              — lookup failed (RPC error, ATA not yet
//                                          indexed after a fresh buy, etc.)
//
// CRITICAL: callers MUST distinguish null (unknown) from rawAtoms===0
// (confirmed empty). Treating null as zero deletes positions immediately
// after they're created, because the SPL ATA takes 1-2 slots to index after
// the create+transfer+sync sequence in a buy tx.
export async function getSplTokenBalance(
  ownerAddress: string,
  mintAddress: string,
): Promise<{ uiAmount: number; decimals: number; rawAtoms: number } | null> {
  // Try BOTH token programs (classic + Token-2022). The mint lives under
  // exactly one, so the other ATA simply won't exist. Semantics:
  //   • any program returns a real balance → return it
  //   • a program's ATA confirmly does not exist → that's a real zero for it
  //   • every lookup errored (RPC blip) → null (unknown — caller leaves state)
  const mint = (() => { try { return new PublicKey(mintAddress); } catch { return null; } })();
  const owner = (() => { try { return new PublicKey(ownerAddress); } catch { return null; } })();
  if (!mint || !owner) return null;

  let sawConfirmedZero = false;
  for (const program of [TOKEN_PROGRAM_PK, TOKEN_2022_PROGRAM_PK]) {
    try {
      const ata = deriveAtaAddress(mint, owner, program);
      // A-93f: 'confirmed', like the fills and the statuses (the RPC default 'finalized' lags about 13 s: stale full-exit sizes, a stale
      // landed-check balance and false zero reads right after a buy)
      const res = await resilientRpcCall('getTokenAccountBalance', [ata.toBase58(), { commitment: 'confirmed' }]);
      // resilientRpcCall surfaces "could not find account" as an error (caught
      // below). A successful call with a value field is authoritative.
      const v = res?.value;
      if (v) {
        const rawAtoms = Number(v.amount || 0);
        if (rawAtoms > 0) {
          return { uiAmount: Number(v.uiAmount || 0), decimals: Number(v.decimals || 0), rawAtoms };
        }
        sawConfirmedZero = true; // ATA exists but is empty — note it, keep checking the other program
      }
    } catch {
      // "could not find account" for THIS program's ATA — fine, the mint is
      // probably under the other program. Keep trying.
    }
  }
  // No program held a positive balance. If at least one ATA confirmly existed
  // and read zero, that's a real zero; otherwise neither ATA was found → null
  // (unknown — could be a not-yet-indexed fresh buy, never delete on this).
  return sawConfirmedZero ? { uiAmount: 0, decimals: 0, rawAtoms: 0 } : null;
}

// ── Wallet-wide SPL balances ──────────────────────────────────────
//
// Returns every SPL token the wallet currently holds with non-zero balance.
//
// Returns:
//   • Map<mint, { rawAtoms, decimals }>  — confirmed list of held mints
//   • null                                — RPC failure (caller MUST treat as
//                                            "unknown" and NOT delete state)
//
// Critical: same null-vs-empty semantics as getSplTokenBalance. If RPC blips
// during a periodic cleanup sweep, returning null prevents accidentally
// wiping every position because a single call timed out.
export async function getAllSplBalances(
  ownerAddress: string,
): Promise<Map<string, { rawAtoms: number; decimals: number }> | null> {
  try {
    const owner = new PublicKey(ownerAddress);
    // Query BOTH token programs. A wallet's Token-2022 holdings are invisible
    // to a classic-program-only scan — which previously made the cleanup job
    // treat them as sold and delete the position.
    const result = new Map<string, { rawAtoms: number; decimals: number }>();
    let anyOk = false;
    for (const program of [TOKEN_PROGRAM_PK, TOKEN_2022_PROGRAM_PK]) {
      let res: any;
      try {
        res = await resilientRpcCall('getTokenAccountsByOwner', [
          owner.toBase58(),
          { programId: program.toBase58() },
          { encoding: 'jsonParsed', commitment: 'confirmed' },
        ]);
      } catch {
        continue; // this program's scan failed — try the other
      }
      const accounts = res?.value;
      if (!Array.isArray(accounts)) continue;
      anyOk = true;
      for (const acc of accounts) {
        const info = acc?.account?.data?.parsed?.info;
        if (!info) continue;
        const mint = info.mint;
        const ta = info.tokenAmount || {};
        const rawAtoms = Number(ta.amount || 0);
        const decimals = Number(ta.decimals || 0);
        if (!mint || rawAtoms <= 0) continue;
        result.set(mint, { rawAtoms, decimals });
      }
    }
    // Only return a (possibly empty) list if AT LEAST one program scan
    // succeeded. If both failed, it's unknown → null (cleanup must not delete).
    return anyOk ? result : null;
  } catch {
    return null;     // RPC error path — unknown, not empty
  }
}

// ── Helper: Wrap SOL → wSOL (one-time setup or top-up) ──
//   1. CreateAssociatedTokenAccountIdempotent  (fine if already exists)
//   2. SystemProgram.transfer  (native lamports → ATA)
//   3. SyncNative              (mark token-account balance as deposited)
export async function wrapSol(keypair: Keypair, amountSol: number): Promise<string> {
  const owner = keypair.publicKey;
  const ata   = deriveAtaAddress(WSOL_MINT_PK, owner);
  const lamps = Math.floor(amountSol * LAMPORTS_PER_SOL);
  if (lamps <= 0) throw new Error('Wrap amount must be > 0');

  const { blockhash } = await getResilientBlockhash();
  const ixs: TransactionInstruction[] = [
    // Idempotent ATA create — discriminator 1 (succeeds whether or not it exists)
    new TransactionInstruction({
      programId: ASSOC_TOKEN_PROGRAM_PK,
      keys: [
        { pubkey: owner,                  isSigner: true,  isWritable: true  },
        { pubkey: ata,                    isSigner: false, isWritable: true  },
        { pubkey: owner,                  isSigner: false, isWritable: false },
        { pubkey: WSOL_MINT_PK,           isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId,isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_PK,       isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),
    }),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports: lamps }),
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_PK,
      keys: [{ pubkey: ata, isSigner: false, isWritable: true }],
      data: Buffer.from([17]),   // SyncNative discriminator
    }),
  ];

  const msg = new TransactionMessage({
    payerKey: owner, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([keypair]);
  return await multiRpcSend(tx);
}

// ── Helper: Unwrap all wSOL → SOL (closes the wSOL ATA) ──
// Closing the wSOL token account auto-credits the owner with all wSOL +
// the ATA rent (~0.002039 SOL). Use this to drain wSOL back to native.
export async function unwrapAllWsol(keypair: Keypair): Promise<string> {
  const owner = keypair.publicKey;
  const ata   = deriveAtaAddress(WSOL_MINT_PK, owner);
  const { blockhash } = await getResilientBlockhash();

  const closeIx = new TransactionInstruction({
    programId: TOKEN_PROGRAM_PK,
    keys: [
      { pubkey: ata,   isSigner: false, isWritable: true  },
      { pubkey: owner, isSigner: false, isWritable: true  },   // SOL refund destination
      { pubkey: owner, isSigner: true,  isWritable: false },   // owner authority
    ],
    data: Buffer.from([9]),   // CloseAccount discriminator
  });

  const msg = new TransactionMessage({
    payerKey: owner, recentBlockhash: blockhash, instructions: [closeIx],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([keypair]);
  return await multiRpcSend(tx);
}
