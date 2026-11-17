/**
 * BLOCKHASH CACHE — pre-warmed in background, served instantly to swap path.
 *
 * 2026-05-05 — was: every swap synchronously called `getLatestBlockhash` →
 * waited 100-300ms for RPC roundtrip BEFORE assembling tx. Now: a background
 * loop refreshes the latest blockhash every 800ms; swap path reads from
 * memory in <1ms.
 *
 * Solana blockhash validity: ~150 blocks (~60 seconds). 800ms refresh = always
 * fresh, never stale. If the cache is cold (first call after boot), the
 * caller should fall back to a synchronous fetch.
 *
 * Latency savings per swap: 100-300ms (RTT-dependent).
 */
import { Connection } from '@solana/web3.js';
import { CONFIG } from '../config';
import { logWarn } from '../logger';

interface CachedBlockhash {
  blockhash:            string;
  lastValidBlockHeight: number;
  fetchedAt:            number;
}

let _cache: CachedBlockhash | null = null;
let _started = false;
let _refreshTimer: NodeJS.Timeout | null = null;

const REFRESH_MS    = 800;            // sub-second refresh — always fresh
const MAX_AGE_MS    = 5_000;          // cache stale after 5s (still well under Solana 60s)
const STALE_WARN_MS = 30_000;         // warn if refresh has been broken >30s

// 2026-06-25 — blockhash poll now prefers the funded Alchemy lane (high RPS,
// no free-tier 429s). Helius bot key kept as ordered fallback. Trade-critical,
// so a reliably-fresh blockhash matters more than lane isolation now that
// Alchemy has the headroom.
function rpcUrl(): string {
  return CONFIG.ALCHEMY_RPC || CONFIG.HELIUS_RPC_BOT || CONFIG.HELIUS_RPC || '';
}

let _conn: Connection | null = null;
function conn(): Connection {
  // 2026-06-25 — disableRetryOnRateLimit: on a 429, web3.js was retrying
  // getLatestBlockhash up to 5× with exponential backoff, spamming the
  // "Retrying after Nms" flood AND multiplying RPC load 5× on the free-tier
  // bot key — the dominant engine 429 source. Disabling it makes each 800ms
  // refresh ONE attempt; on failure refresh()'s catch keeps the prior cached
  // hash (valid ~60s), so blockhash freshness for swaps is UNCHANGED. Cadence
  // untouched = zero execution risk.
  if (!_conn) _conn = new Connection(rpcUrl(), { commitment: 'confirmed', disableRetryOnRateLimit: true });
  return _conn;
}

async function refresh(): Promise<void> {
  try {
    const r = await conn().getLatestBlockhash('confirmed');
    _cache = {
      blockhash:            r.blockhash,
      lastValidBlockHeight: r.lastValidBlockHeight,
      fetchedAt:            Date.now(),
    };
  } catch (e: any) {
    // Don't crash — leave the prior cached value in place. Stale-staleness
    // is still preferable to no value at all (next swap caller will fall
    // back to synchronous fetch if too old).
    if (_cache && Date.now() - _cache.fetchedAt > STALE_WARN_MS) {
      logWarn(`[blockhash-cache] refresh failing for >${STALE_WARN_MS/1000}s: ${e?.message || e}`);
    }
  }
}

/**
 * Start the background refresh loop. Call ONCE at engine boot.
 * Idempotent — safe to call from multiple init paths.
 */
export function startBlockhashCache(): void {
  if (_started) return;
  _started = true;

  // Kick a first fetch immediately so the cache is warm by the time the
  // first signal fires.
  refresh().catch(() => {});

  _refreshTimer = setInterval(() => { refresh().catch(() => {}); }, REFRESH_MS);
  // Don't keep the process alive just because of this timer
  if (_refreshTimer.unref) _refreshTimer.unref();
}

/** Graceful shutdown — clears the timer. */
export function stopBlockhashCache(): void {
  if (_refreshTimer) clearInterval(_refreshTimer);
  _refreshTimer = null;
  _started = false;
}

/**
 * Read the cached blockhash. Returns null if cold or stale beyond MAX_AGE_MS,
 * in which case the caller should fall back to a synchronous getLatestBlockhash.
 */
export function getCachedBlockhash(): { blockhash: string; lastValidBlockHeight: number } | null {
  if (!_cache) return null;
  if (Date.now() - _cache.fetchedAt > MAX_AGE_MS) return null;
  return {
    blockhash:            _cache.blockhash,
    lastValidBlockHeight: _cache.lastValidBlockHeight,
  };
}

/** Diagnostic — for /api/status. */
export function getBlockhashCacheStats() {
  return {
    started: _started,
    hasCache: !!_cache,
    ageMs: _cache ? Date.now() - _cache.fetchedAt : null,
    refreshMs: REFRESH_MS,
    maxAgeMs: MAX_AGE_MS,
  };
}
