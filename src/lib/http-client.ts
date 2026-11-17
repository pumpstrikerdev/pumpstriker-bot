/**
 * HIGH-PERFORMANCE HTTP CLIENT — undici with kept-alive connection pool
 *
 * 2026-05-05 — drop-in replacement for `node-fetch` to eliminate the TCP/TLS
 * handshake on every Jupiter/Helius call. Each fresh handshake
 * costs ~50-200ms depending on RTT to the API; with persistent connections
 * subsequent requests reuse the socket and skip the round-trip entirely.
 *
 * Hot-path estimated wins:
 *   - Jupiter quote first call:  no change (~80ms RTT cold)
 *   - Jupiter quote subsequent:  -120-180ms (kept-alive)
 *   - Helius RPC subsequent:     -100-150ms
 *
 * USAGE — drop in for `node-fetch`:
 *   // before:  import fetch from 'node-fetch';
 *   // after:   import { fetch } from '../lib/http-client';
 *
 * Returned response is an undici Response (web-spec). Same shape as fetch:
 *   .ok, .status, .json(), .text(), .headers
 *
 * The `timeout` option is honored via `signal: AbortSignal.timeout(ms)`.
 */
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

// Singleton agent shared across the entire process.
//   - keepAliveTimeout: 30s — connection stays warm for 30s of idle
//   - keepAliveMaxTimeout: 60s — hard ceiling
//   - connections: 8 per origin — enough for parallel scanner bursts without
//                                  overwhelming the API
//   - pipelining: 1 — Solana RPC providers don't always support HTTP/1.1 pipelining
//                     reliably; one in-flight at a time per connection avoids
//                     head-of-line blocking surprises
//   - allowH2: true — opt into HTTP/2 when origin supports it (Jupiter does)
const _sharedAgent = new Agent({
  keepAliveTimeout:    30_000,
  keepAliveMaxTimeout: 60_000,
  connections:         8,
  pipelining:          1,
  allowH2:             true,
});

/**
 * Drop-in fetch with persistent keep-alive connections.
 * Compatible signature with node-fetch v2: `fetch(url, opts)`.
 *
 * Adds: `opts.timeout` (ms) is converted to AbortSignal.timeout() for cancel.
 */
export async function fetch(
  url: string,
  opts: (UndiciRequestInit & { timeout?: number }) = {},
): Promise<any /* loose return — callers expect node-fetch shape */> {
  const { timeout, ...rest } = opts as any;

  const init: UndiciRequestInit = {
    ...rest,
    dispatcher: _sharedAgent,
  };
  if (typeof timeout === 'number' && timeout > 0) {
    init.signal = (AbortSignal as any).timeout
      ? (AbortSignal as any).timeout(timeout)
      : undefined;
  }

  const r = await undiciFetch(url, init);
  return r;
}

/** Diagnostic — show pool stats (use in /api/status route if needed). */
export function getHttpStats() {
  return {
    keepAliveTimeoutMs: 30_000,
    pooledConnectionsPerOrigin: 8,
    http2: true,
  };
}

/** Manually close the agent (graceful shutdown only — never call in hot path). */
export async function closeHttpClient() {
  await _sharedAgent.close();
}
