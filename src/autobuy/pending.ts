// R2-B2 (B20 section 3; plan grind #65): the in-flight buy journal and the landed-check behind boot recovery.
//
//   B\data\pending-buys.json  { v: 1, entries: PendingBuy[] }  written tmp + fsync + rename.
//
// An entry is appended after signing and BEFORE the send (inside the router's onSigned callback: if the append fails the send never
// happens) and removed when the buy is resolved (position opened, or failed). A restart in between therefore never orphans a buy: boot
// recovery asks the chain what became of every entry. A dry-run buy never writes this file.
//
// Entries may carry three optional stamps beyond the frozen PendingBuy shape (received_at, decided_at, signed_at) so the late
// `delivery.buy` events that recovery emits keep the real latency stamps. The frozen PendingBuy fields are untouched, and the stamps are
// stripped before an entry is handed to PositionsStore.openFromBuy.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PendingBuy } from '../bot-contracts';
import { writeFileAtomicSync } from '../link/atomic-file';
import { errText } from './guards';
import { normalizeExitPlan, type ExitPlanSnapshot } from '../exits/presets';

export const PENDING_FILE = 'pending-buys.json';

export interface PendingRecord extends PendingBuy {
  received_at?: number;
  decided_at?: number | null;
  signed_at?: number | null;
  /** A-115: the exit plan resolved when the buy was decided (a grade preset); absent = the active policy, as before. */
  exit_plan?: ExitPlanSnapshot;
}

/** The frozen PendingBuy fields only. */
export function toPendingBuy(r: PendingRecord): PendingBuy {
  return {
    sig: r.sig, signal_id: r.signal_id, ca: r.ca, wallet_id: r.wallet_id, owner: r.owner, arm: r.arm, route: r.route,
    sol_in_lamports: r.sol_in_lamports, quote_tokens_out: r.quote_tokens_out, last_valid_block_height: r.last_valid_block_height, submitted_at: r.submitted_at,
  };
}

const ARMS: readonly string[] = ['BS', 'B0', 'B1', 'B2'];
const ROUTES: readonly (string | null)[] = ['pf-direct', 'pumpswap-direct', 'jupiter', null];
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const isMs = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isAmount = (x: unknown): x is string => typeof x === 'string' && /^\d+$/.test(x);

function validRecord(x: unknown): PendingRecord | null {
  if (typeof x !== 'object' || x === null) return null;
  const r = x as Record<string, unknown>;
  if (!isStr(r.sig) || !isStr(r.signal_id) || !isStr(r.ca) || !isStr(r.wallet_id) || !isStr(r.owner)) return null;
  if (typeof r.arm !== 'string' || !ARMS.includes(r.arm)) return null;
  if (!ROUTES.includes(r.route as string | null)) return null;
  if (!isAmount(r.sol_in_lamports) || !(r.quote_tokens_out === null || isAmount(r.quote_tokens_out))) return null;
  if (!isMs(r.last_valid_block_height) || !isMs(r.submitted_at)) return null;
  const out: PendingRecord = {
    sig: r.sig, signal_id: r.signal_id, ca: r.ca, wallet_id: r.wallet_id, owner: r.owner, arm: r.arm as PendingBuy['arm'], route: r.route as PendingBuy['route'],
    sol_in_lamports: r.sol_in_lamports, quote_tokens_out: r.quote_tokens_out as string | null, last_valid_block_height: r.last_valid_block_height, submitted_at: r.submitted_at,
  };
  if (isMs(r.received_at)) out.received_at = r.received_at;
  if (r.decided_at === null || isMs(r.decided_at)) out.decided_at = r.decided_at as number | null;
  if (r.signed_at === null || isMs(r.signed_at)) out.signed_at = r.signed_at as number | null;
  const plan = r.exit_plan === undefined ? null : normalizeExitPlan(r.exit_plan);
  if (plan !== null) out.exit_plan = plan;
  return out;
}

export interface PendingJournal {
  list(): PendingRecord[];
  has(sig: string): boolean;
  /** Appends and persists. Throws when the file cannot be written (the caller then sends nothing); the in-memory entry is rolled back. */
  add(rec: PendingRecord): void;
  /** Patches an entry and persists (best effort: a failed patch keeps the older, still valid entry). Returns false when it is not there. */
  update(sig: string, patch: Partial<PendingRecord>): boolean;
  remove(sig: string): void;
  /** Set when the file existed but could not be read; it was renamed aside to `<file>.corrupt-<n>` (never deleted). */
  readonly loadError: string | null;
}

export function openPendingJournal(dir: string): PendingJournal {
  const file = path.join(dir, PENDING_FILE);
  const entries = new Map<string, PendingRecord>();
  let loadError: string | null = null;
  if (fs.existsSync(file)) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { v?: unknown; entries?: unknown };
      if (doc === null || typeof doc !== 'object' || doc.v !== 1 || !Array.isArray(doc.entries)) throw new Error('unexpected format');
      for (const e of doc.entries) {
        const r = validRecord(e);
        if (r === null) throw new Error('a journal entry is malformed');
        entries.set(r.sig, r);
      }
    } catch (e) {
      entries.clear();
      loadError = errText(e);
      for (let i = 1; i < 1000; i++) {
        const aside = `${file}.corrupt-${i}`;
        if (fs.existsSync(aside)) continue;
        try { fs.renameSync(file, aside); } catch { /* the next write replaces the file */ }
        break;
      }
    }
  }
  const persist = (): void => { writeFileAtomicSync(file, JSON.stringify({ v: 1, entries: [...entries.values()] })); };
  return {
    list: () => [...entries.values()].map(r => ({ ...r })),
    has: sig => entries.has(sig),
    add(rec) {
      if (entries.has(rec.sig)) return;
      entries.set(rec.sig, { ...rec });
      try { persist(); } catch (e) { entries.delete(rec.sig); throw e; }
    },
    update(sig, patch) {
      const cur = entries.get(sig);
      if (!cur) return false;
      entries.set(sig, { ...cur, ...patch, sig });
      try { persist(); } catch { entries.set(sig, cur); }
      return true;
    },
    remove(sig) {
      const cur = entries.get(sig);
      if (!cur) return;
      entries.delete(sig);
      try { persist(); } catch (e) { entries.set(sig, cur); throw e; }
    },
    get loadError() { return loadError; },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the landed-check
// ---------------------------------------------------------------------------------------------------------------------------------

export interface SigStatus { err: unknown; confirmationStatus?: string | null }

/** The three RPC calls boot recovery and the confirm loop need; the wiring maps them to the resilient RPC pool. */
export interface RecoveryRpc {
  getSignatureStatuses(sigs: string[], opts: { searchTransactionHistory: boolean }): Promise<Array<SigStatus | null>>;
  getBlockHeight(): Promise<number>;
  /** null = unknown (RPC error, ATA not found); `{ rawAtoms: 0 }` = a confirmed empty account. */
  getSplTokenBalance(owner: string, mint: string): Promise<{ rawAtoms: number | bigint | string } | null>;
}

/**
 * The wiring's adapter: the JSON-RPC pool (`ExecRpc.call`, resolves with the `result` member) plus the balance reader
 * (execution/jupiter.ts getSplTokenBalance, null = unknown) become the three calls above.
 */
export function recoveryRpcFrom(
  rpc: { call(method: string, params: unknown[]): Promise<unknown> },
  getSplTokenBalance: RecoveryRpc['getSplTokenBalance'],
): RecoveryRpc {
  return {
    async getSignatureStatuses(sigs, opts) {
      const res = await rpc.call('getSignatureStatuses', [sigs, { searchTransactionHistory: opts.searchTransactionHistory }]);
      const value = (res as { value?: unknown } | null | undefined)?.value;
      return Array.isArray(value) ? (value as Array<SigStatus | null>) : [];
    },
    async getBlockHeight() {
      const h = await rpc.call('getBlockHeight', [{ commitment: 'confirmed' }]);
      if (typeof h !== 'number' || !Number.isFinite(h)) throw new Error('block height unreadable');
      return h;
    },
    getSplTokenBalance,
  };
}

/** After the blockhash expired, a status that stays unknown AND a balance that stays unknown this many checks in a row is a failed buy. */
export const EXPIRED_UNKNOWN_CHECKS = 3;

export type PendingVerdict =
  | { kind: 'landed' }
  | { kind: 'failed'; reason: string }
  /** The status is unknown but the wallet holds the token: the buy landed; adopt it with fill_source 'unverified'. */
  | { kind: 'adopt'; rawAtoms: bigint }
  | { kind: 'wait'; expiredUnknownStreak: number };

function atomsOf(v: number | bigint | string): bigint | null {
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? BigInt(Math.trunc(v)) : null;
    return /^\d+$/.test(v) ? BigInt(v) : null;
  } catch {
    return null;
  }
}

/**
 * Asks the chain what became of one journalled buy (B20 section 3, boot recovery):
 *   landed without an error                          -> landed (the caller reads the fill and opens the position);
 *   an error status                                  -> failed;
 *   status unknown, the wallet holds the token       -> adopt (only when `balanceFirst`, or once the blockhash has expired: in the
 *                                                       live confirm loop a status that is merely late must not turn a verified fill
 *                                                       into an unverified one);
 *   status unknown, block height > last valid        -> failed once the balance is a confirmed zero, or stays unreadable for
 *                                                       EXPIRED_UNKNOWN_CHECKS checks in a row;
 *   anything else (blockhash still valid, RPC down)  -> wait.
 * A status RPC that errors never counts as "not found".
 */
export async function checkPending(
  rec: Pick<PendingBuy, 'sig' | 'owner' | 'ca' | 'last_valid_block_height'>, rpc: RecoveryRpc, o: { balanceFirst: boolean; expiredUnknownStreak: number },
): Promise<PendingVerdict> {
  let statusReadable = true;
  let st: SigStatus | null = null;
  try {
    const res = await rpc.getSignatureStatuses([rec.sig], { searchTransactionHistory: true });
    st = Array.isArray(res) ? (res[0] ?? null) : null;
  } catch {
    statusReadable = false;
  }
  if (st !== null) {
    if (st.err !== null && st.err !== undefined) return { kind: 'failed', reason: `transaction failed on chain: ${errText(JSON.stringify(st.err))}` };
    if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return { kind: 'landed' };
  }

  let height: number | null = null;
  try {
    const h = await rpc.getBlockHeight();
    height = typeof h === 'number' && Number.isFinite(h) ? h : null;
  } catch {
    height = null;
  }
  const expired = height !== null && height > rec.last_valid_block_height;

  if (!o.balanceFirst && !expired) return { kind: 'wait', expiredUnknownStreak: 0 };

  let bal: { rawAtoms: number | bigint | string } | null = null;
  try {
    bal = await rpc.getSplTokenBalance(rec.owner, rec.ca);
  } catch {
    bal = null;
  }
  const atoms = bal === null ? null : atomsOf(bal.rawAtoms);
  if (atoms !== null && atoms > 0n) return { kind: 'adopt', rawAtoms: atoms };
  if (!expired) return { kind: 'wait', expiredUnknownStreak: 0 };
  if (!statusReadable) return { kind: 'wait', expiredUnknownStreak: 0 };
  if (atoms !== null) return { kind: 'failed', reason: 'not found on chain, blockhash expired, balance 0' };
  const streak = o.expiredUnknownStreak + 1;
  if (streak >= EXPIRED_UNKNOWN_CHECKS) return { kind: 'failed', reason: 'not found on chain and the blockhash expired (balance unreadable)' };
  return { kind: 'wait', expiredUnknownStreak: streak };
}
