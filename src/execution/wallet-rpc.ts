/**
 * WALLET RPC — the one JSON-RPC port every wallet flow reads the chain through (R7-W5, A-104, rev 3 R3-5 g).
 *
 * One URL and nothing else: `CONFIG.HELIUS_RPC_WALLET` (the wallet lane), or `rpcOnlyUrl()` when the A-68 test override is set
 * (RPC_URL with RPC_FALLBACKS=off). No public lane, no failover, no second provider, no rebate parameter on the URL, and a method
 * allowlist of reads and simulation: a method outside it (anything that would send or sign) is refused BEFORE the network is touched.
 * Reads carry commitment 'confirmed' (A-93f): this port forces it on every call that takes a commitment, whatever the caller passed.
 *
 * Priority estimates (`getPriorityFeeEstimate`) and blockhashes (`getLatestBlockhash`) are plain methods on this same port; lookup
 * tables are read from the chain through it (never from a third party's claim).
 *
 * Every error is redacted (the provider URL carries its key) and at most 200 characters. Nothing here signs, sends, retries or logs a
 * URL. Wrapped by rpc-budget.ts (daily cap, per-owner minute, per-second bucket) before the wallet builders use it.
 */
import { CONFIG, rpcOnlyUrl } from '../config';
import { fetch as httpFetch } from '../lib/http-client';
import { redactSecrets } from '../lib/redact';
import type { WalletLinkRefusal, WalletRefusalCode } from '../shared/contract/wallet-link';

/** The clock the wallet code reads (Date.now() only through it). */
export interface WalletClock { now(): number }
export const systemWalletClock: WalletClock = { now: () => Date.now() };
/** A clock that can also wait: the fill poll and the per-second budget sleep through it (tests drive a fake one). */
export interface WalletSleepClock extends WalletClock { sleep(ms: number): Promise<void> }
export const systemWalletSleepClock: WalletSleepClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

export interface WalletRpcCallOpts {
  /** Upper bound for this one call; the port also applies its own default. */
  timeoutMs?: number;
}
/** What the wallet builders take: a JSON-RPC caller that resolves with the `result` member and throws WalletRpcError otherwise. */
export interface WalletRpcPort {
  call(method: string, params: unknown[], opts?: WalletRpcCallOpts): Promise<any>;
}

export type WalletRpcErrorKind = 'no-url' | 'method-refused' | 'timeout' | 'network' | 'http' | 'rpc' | 'parse';
export class WalletRpcError extends Error {
  readonly kind: WalletRpcErrorKind;
  readonly httpStatus: number | null;
  readonly rpcCode: number | null;
  constructor(kind: WalletRpcErrorKind, message: string, extra: { httpStatus?: number; rpcCode?: number } = {}) {
    super(redactSecrets(message).slice(0, 200));
    this.name = 'WalletRpcError';
    this.kind = kind;
    this.httpStatus = extra.httpStatus ?? null;
    this.rpcCode = extra.rpcCode ?? null;
  }
}

/** Reads and simulation only. Nothing that sends, signs, airdrops or subscribes is on this list. */
export const WALLET_RPC_METHODS: readonly string[] = [
  'getBalance', 'getAccountInfo', 'getMultipleAccounts', 'getTokenAccountsByOwner', 'getLatestBlockhash', 'simulateTransaction',
  'getMinimumBalanceForRentExemption', 'getTransaction', 'getSignatureStatuses', 'getSignaturesForAddress', 'getPriorityFeeEstimate',
];

/** Index of the config object (the one that carries `commitment`) in the params of each method that takes a commitment. */
const COMMITMENT_PARAM_INDEX: Readonly<Record<string, number>> = {
  getBalance: 1, getAccountInfo: 1, getMultipleAccounts: 1, getTokenAccountsByOwner: 2, getLatestBlockhash: 0, simulateTransaction: 1,
  getMinimumBalanceForRentExemption: 1, getTransaction: 1, getSignaturesForAddress: 1,
};

/** Pure: the params with commitment 'confirmed' set (copied, never mutated) on a method that takes one; others are returned as they are. */
export function withConfirmedCommitment(method: string, params: readonly unknown[]): unknown[] {
  const idx = COMMITMENT_PARAM_INDEX[method];
  const out = [...params];
  if (idx === undefined) return out;
  while (out.length < idx) out.push(null);
  const cur = out[idx];
  const cfg = typeof cur === 'object' && cur !== null && !Array.isArray(cur) ? { ...(cur as Record<string, unknown>) } : {};
  cfg.commitment = 'confirmed';
  out[idx] = cfg;
  return out;
}

/** The one URL: the override when the A-68 test override is set, else the wallet lane; null when neither is configured. */
export function resolveWalletRpcUrl(cfg: { HELIUS_RPC_WALLET?: string } = CONFIG, only: string | null = rpcOnlyUrl()): string | null {
  if (only) return only;
  return cfg.HELIUS_RPC_WALLET ? cfg.HELIUS_RPC_WALLET : null;
}

export const WALLET_RPC_TIMEOUT_MS = 8_000;

export type WalletFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; timeout: number },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface WalletRpcOptions {
  /** A fixed URL, or a function resolved on every call. Default: resolveWalletRpcUrl(). */
  url?: string | (() => string | null);
  fetch?: WalletFetch;
  timeoutMs?: number;
}

export function createWalletRpc(opts: WalletRpcOptions = {}): WalletRpcPort {
  const doFetch: WalletFetch = opts.fetch ?? httpFetch;
  const defaultTimeout = opts.timeoutMs ?? WALLET_RPC_TIMEOUT_MS;
  let nextId = 1;
  return {
    async call(method: string, params: unknown[], callOpts: WalletRpcCallOpts = {}): Promise<any> {
      if (!WALLET_RPC_METHODS.includes(method)) throw new WalletRpcError('method-refused', `wallet RPC method not allowed: ${String(method).slice(0, 40)}`);
      const url = typeof opts.url === 'function' ? opts.url() : opts.url ?? resolveWalletRpcUrl();
      if (!url) throw new WalletRpcError('no-url', 'wallet RPC is not configured');
      const timeout = Math.max(100, Math.min(callOpts.timeoutMs ?? defaultTimeout, defaultTimeout));
      const body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: withConfirmedCommitment(method, params) });
      let text: string;
      try {
        const r = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeout });
        if (!r.ok) throw new WalletRpcError('http', `wallet RPC ${method}: HTTP ${r.status}`, { httpStatus: r.status });
        text = await r.text();
      } catch (e) {
        if (e instanceof WalletRpcError) throw e;
        const name = (e as { name?: unknown } | null)?.name;
        const msg = String((e as { message?: unknown } | null)?.message ?? e);
        const timedOut = name === 'TimeoutError' || name === 'AbortError' || /timeout|timed out|aborted/i.test(msg);
        throw new WalletRpcError(timedOut ? 'timeout' : 'network', `wallet RPC ${method}: ${timedOut ? 'timed out' : msg}`);
      }
      let json: any;
      try { json = JSON.parse(text); } catch { throw new WalletRpcError('parse', `wallet RPC ${method}: answer is not JSON`); }
      if (json === null || typeof json !== 'object') throw new WalletRpcError('parse', `wallet RPC ${method}: answer is not an object`);
      if (json.error !== undefined && json.error !== null) {
        const code = typeof json.error.code === 'number' ? json.error.code : undefined;
        throw new WalletRpcError('rpc', `wallet RPC ${method}: ${String(json.error.message ?? 'error').slice(0, 120)}`, code === undefined ? {} : { rpcCode: code });
      }
      if (!('result' in json)) throw new WalletRpcError('parse', `wallet RPC ${method}: answer has no result`);
      return json.result;
    },
  };
}

// ── refusals (shared by every wallet module) ─────────────────────────────────────────────────────────────────────────────────

/** A link refusal: the reason is redacted and at most 200 characters (design 7.4). needLamports / haveLamports only with 'insufficient-sol'. */
export function walletRefusal(code: WalletRefusalCode, reason: string, extra: { needLamports?: string; haveLamports?: string } = {}): WalletLinkRefusal {
  const out: WalletLinkRefusal = { ok: false, code, reason: redactSecrets(reason).slice(0, 200) };
  if (extra.needLamports !== undefined) out.needLamports = extra.needLamports;
  if (extra.haveLamports !== undefined) out.haveLamports = extra.haveLamports;
  return out;
}

/** True for the error the RPC budget throws (duck-typed so this file does not import rpc-budget.ts). */
export function isRpcBudgetError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'rpc-budget';
}

/**
 * A thrown RPC-side error as a refusal: the budget's error is 'rpc-budget', a port timeout is 'build-timeout', anything else is the
 * fallback code with the redacted message. A read that failed is never turned into a value.
 */
export function refusalFromError(e: unknown, fallback: WalletRefusalCode = 'build-failed'): WalletLinkRefusal {
  const msg = String((e as { message?: unknown } | null)?.message ?? e);
  if (isRpcBudgetError(e)) return walletRefusal('rpc-budget', msg);
  if (e instanceof WalletRpcError && e.kind === 'timeout') return walletRefusal('build-timeout', msg);
  return walletRefusal(fallback, msg);
}
