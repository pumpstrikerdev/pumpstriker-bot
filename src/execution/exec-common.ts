/**
 * Shared plumbing of the B40 execution-truth modules (fills, close-account, tx-verify, curve-state, onchain-quote).
 *
 * Everything here is dependency-injectable so the modules can be tested with fakes (no RPC, no clock, no network):
 *   - ExecRpc    a JSON-RPC caller that returns the `result` member and throws on an RPC error. The default
 *                implementation delegates to jupiter.ts `resilientRpcCall` (round-robin lanes with failover) and is
 *                imported lazily so unit tests of the pure parts never load the config.
 *   - ExecClock  `now()` and `sleep()`; the default is the system clock. Tests drive a fake one.
 *   - errorReason(e)  the one error-to-string rule of B40 rule 4 (plan grind #64): redacted and cut to 200 characters.
 */
import { PublicKey } from '@solana/web3.js';
import { redactSecrets } from '../lib/redact';

// ── Program ids and constants (public addresses) ─────────────────────────────────────────────────
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** Pump bonding-curve program (same constant as pumpfun-swap.ts PUMPFUN_PROGRAM_ID; a test keeps them equal). */
export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
/** PumpSwap AMM program (same constant as pumpswap-swap.ts PUMPSWAP_PROGRAM_ID; a test keeps them equal). */
export const PUMPSWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

export type TokenProgramKind = 'token' | 'token2022';

export function tokenProgramAddress(kind: TokenProgramKind): string {
  return kind === 'token2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/** Associated token account address of (owner, mint) under the given token program. Throws on a malformed key. */
export function deriveAta(owner: string, mint: string, program: TokenProgramKind | string): string {
  const programId = program === 'token' || program === 'token2022' ? tokenProgramAddress(program) : program;
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(programId).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ATA_PROGRAM_ID),
  )[0].toBase58();
}

export function isBase58Key(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

// ── Clock ────────────────────────────────────────────────────────────────────────────────────────
export interface ExecClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: ExecClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

// ── RPC ──────────────────────────────────────────────────────────────────────────────────────────
export interface ExecRpc {
  /** JSON-RPC call; resolves with the `result` member, rejects on an RPC or transport error. */
  call(method: string, params: unknown[]): Promise<any>;
}

/** Default RPC: jupiter.ts resilientRpcCall (loaded on first use, so the pure parts of B40 stay import-light). */
export function defaultExecRpc(): ExecRpc {
  return {
    async call(method: string, params: unknown[]): Promise<any> {
      const { resilientRpcCall } = await import('./jupiter');
      return resilientRpcCall(method, params as any[]);
    },
  };
}

/** B40 rule 4 (plan grind #64): every error and `reason` string is redacted and at most 200 characters. */
export function errorReason(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message ?? e;
  return redactSecrets(String(msg)).slice(0, 200);
}

/** Resolve `p`, or `null` when it takes longer than `ms` (the underlying work is not cancelled). */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Raw account data helpers ─────────────────────────────────────────────────────────────────────
/** `data` member of a getAccountInfo / getMultipleAccounts value with `encoding: 'base64'` → bytes, or null. */
export function accountBytes(value: any): Buffer | null {
  const d = value?.data;
  const b64 = Array.isArray(d) ? d[0] : typeof d === 'string' ? d : null;
  if (typeof b64 !== 'string') return null;
  try {
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
}

/** SPL token account (classic or Token-2022 base layout): amount is the u64 LE at offset 64. */
export function tokenAccountAmount(bytes: Buffer | null): bigint | null {
  if (!bytes || bytes.length < 72) return null;
  return bytes.readBigUInt64LE(64);
}

/** BigInt from an RPC number-or-string field; null when absent or not an integer. */
export function toBigInt(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : null;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return null;
}
