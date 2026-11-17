/**
 * positions-store.ts (B30 rule 1): `PositionV2` records in `<BOT_DATA_DIR>/positions-v2.json` and `ManualOrderV2` records in
 * `<BOT_DATA_DIR>/manual-orders-v2.json` (plan grind #46). Every mutation rewrites its file atomically (temp file in the same folder,
 * fsync, rename: link/atomic-file.ts) before the call returns, so a crash leaves the old state or the new one, never half of one.
 *
 * `openFromBuy(pending, fill)` is the ONLY way to create a signal position (plan grind #65): the normal confirm path and the B20 boot
 * recovery both call it. It is idempotent: the position id is derived from the buy signature, so a second call for the same pending buy
 * (a crash between "position opened" and "journal entry removed") returns the existing record.
 *
 * The stored record is the frozen `PositionV2` plus the engine's own fields (`next_due_at`, the quote it was valued at, the manual
 * hard-stop anchor, the unresolved sell signatures, the verified sell proceeds ...). The frozen interface has no room for them, so
 * they are an extension (`StoredPosition`); a file written without them (the R4-B6 migration writes plain `PositionV2` records) is
 * normalised on load, never rejected.
 *
 * A file that exists but cannot be parsed is a hard error (`PositionsStoreError`): treating it as empty would make the next save
 * overwrite the only record of live holdings. Nothing is ever deleted: a closed position stays in the file (`closed_at`) and is pruned
 * only after PRUNE_CLOSED_AFTER_MS.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ArmId } from '../shared/common/ids';
import type { PositionClosed } from '../shared/contract/v1';
import type { BuyFill, PendingBuy, PositionsStore, PositionV2 } from '../bot-contracts';
import type { Clock } from '../link/clock';
import { writeFileAtomicSync } from '../link/atomic-file';
import type { StoredManualOrder } from './manual-orders';
import { normalizeExitPlan, type ExitPlanSnapshot } from './presets';

export const POSITIONS_FILE = 'positions-v2.json';
export const MANUAL_ORDERS_FILE = 'manual-orders-v2.json';
export const STORE_SCHEMA = 2;
export const PRUNE_CLOSED_AFTER_MS = 30 * 86_400_000;
/** Unresolved sell signatures kept per position (the landed-check asks the RPC about all of them in one call). */
export const MAX_PENDING_SIGS = 8;

export class PositionsStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PositionsStoreError';
  }
}

export interface StoredPosition extends PositionV2 {
  /** When the exit engine looks at this position next (epoch ms). Set to "now" when the position opens. */
  next_due_at: number;
  /** Token atoms the `last_quote.sol` value was quoted for (`last_quote.sol / last_quote_tokens` = the last value per atom). */
  last_quote_tokens: string | null;
  /** Manual positions: SOL per atom of the first evaluated quote, the anchor of the -25% floor. */
  floor_base: number | null;
  /** Signatures of sell transactions that were signed or sent and whose outcome is not resolved yet (checked before any retry). */
  pending_sigs: string[];
  /** A-93f: lastValidBlockHeight of each pending signature (sig -> height), so a re-send waits while an earlier send may still land. */
  pending_sig_heights: Record<string, number>;
  /** A-93f: until when the protective lockout of this position cools down (epoch ms); null = not locked. The locked legs are probed again
   *  after it, a filled sell clears it, and the engine's start() sets it to "now" (a restart probes at once). */
  lockout_until: number | null;
  /** Sum of the verified net SOL out of this position's sells (lamports, decimal string). */
  real_out_lamports: string;
  /** True when any sell leg could not be verified from its transaction meta (realized PnL is then null). */
  sell_unverified: boolean;
  /** A signal.cancel asked for a guaranteed exit that is not finished yet. */
  cancel_pending: boolean;
  /** A full exit was sold but the empty token account is not confirmed yet: finish it (balance read, CloseAccount) on the next passes.
   *  `reason` and `close_account` are what the finished close reports and whether it asks B40 to close the account. */
  close_pending: { since: number; tries: number; reason: PositionClosed['reason']; close_account: boolean } | null;
  closed_at: number | null;
  close_reason: PositionClosed['reason'] | null;
  realized_sol_net_lamports: string | null;
  rent_reclaimed_lamports: string | null;
  close_account_status: PositionClosed['close_account_status'] | null;
  close_account_tx: string | null;
  /** A-115: the exit plan the position was opened with (a grade preset, or the active policy for a card buy). Absent = the position runs
   *  its policy_id (signal) or the owner's orders (manual), exactly as before A-115. A position keeps its plan when the preset changes. */
  exit_plan?: ExitPlanSnapshot;
}

/** A-115: a pending buy may carry the plan resolved when the buy was decided (the frozen PendingBuy has no room for it). */
export type PendingBuyWithPlan = PendingBuy & { exit_plan?: ExitPlanSnapshot | null };

export interface PositionsFileV2 { schema: 2; positions: StoredPosition[] }
export interface ManualOrdersFileV2 { schema: 2; orders: StoredManualOrder[] }

export interface PositionsStoreDeps {
  /** The bot data folder (BOT_DATA_DIR). */
  dir: string;
  clock: Clock;
  /** The policy a new signal position is stamped with (EXIT_POLICY_ID and the version `loadPolicies` computed). */
  policy: { id: string; version: string };
}

/** Everything the engine and the API need from the store. `openFromBuy` is the frozen `PositionsStore` method. */
export interface PositionsStoreV2 extends PositionsStore {
  openFromBuy(p: PendingBuy, fill: BuyFill | 'unverified'): StoredPosition;
  /** A virtual position for a dry-run buy (fill_source 'quote_dry_run'); nothing is ever sent from it. Idempotent per `id`. */
  openDryRun(a: { id: string; signal_id: string; ca: string; wallet_id: string; arm: ArmId | null; tokens: string; sol_in_lamports: string | null; opened_at: number }): StoredPosition;
  /** Inserts (or replaces by position_id) a record, normalising missing engine fields; used by manual buys and the R4-B6 migration. */
  put(raw: PositionV2 & Partial<StoredPosition>): StoredPosition;
  get(positionId: string): StoredPosition | undefined;
  /** Open (not closed) positions, oldest first. */
  listOpen(): StoredPosition[];
  openCount(): number;
  findOpen(ca: string, walletId: string): StoredPosition[];
  update(positionId: string, patch: Partial<StoredPosition>): StoredPosition;
  close(positionId: string, c: { closed_at: number; reason: PositionClosed['reason']; realized_sol_net_lamports: string | null;
    rent_reclaimed_lamports: string | null; close_account_status: PositionClosed['close_account_status']; close_account_tx: string | null }): StoredPosition;
  // manual orders
  putOrder(o: StoredManualOrder): StoredManualOrder;
  getOrder(orderId: string): StoredManualOrder | undefined;
  ordersOf(positionId: string): StoredManualOrder[];
  activeOrdersOf(positionId: string): StoredManualOrder[];
  updateOrder(orderId: string, patch: Partial<StoredManualOrder>): StoredManualOrder;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// ids and normalisation
// ---------------------------------------------------------------------------------------------------------------------------------

/** The position id of a pending buy: a digest of its signature, so re-running the open for the same buy finds the same record. */
export function positionIdForBuy(sig: string): string {
  return 'pos_' + createHash('sha256').update('position:' + sig, 'utf8').digest('hex').slice(0, 24);
}

const DIGITS_RE = /^\d+$/;
const isDigits = (v: unknown): v is string => typeof v === 'string' && DIGITS_RE.test(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function bad(what: string): never {
  throw new PositionsStoreError(what);
}

/** The heights of the signatures that are still pending (entries of signatures no longer pending are dropped). */
function sigHeights(v: unknown, sigs: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out;
  for (const s of sigs) {
    const h = (v as Record<string, unknown>)[s];
    if (isFiniteNum(h) && h >= 0) out[s] = h;
  }
  return out;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Validates the frozen `PositionV2` fields and fills every engine field that is missing. Throws PositionsStoreError on a broken record. */
export function normalizePosition(raw: unknown, nowMs: number): StoredPosition {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('a position record is not an object');
  const r = raw as Record<string, unknown>;
  const id = r.position_id;
  if (!isStr(id)) bad('a position record has no position_id');
  const where = `position ${id}`;
  if (!isStr(r.ca)) bad(`${where}: ca missing`);
  if (!isStr(r.wallet_id)) bad(`${where}: wallet_id missing`);
  if (r.origin !== 'signal' && r.origin !== 'manual') bad(`${where}: origin must be signal or manual`);
  if (!isDigits(r.tokens)) bad(`${where}: tokens must be a decimal string`);
  if (!isDigits(r.original_tokens)) bad(`${where}: original_tokens must be a decimal string`);
  const entry = r.entry as Record<string, unknown> | undefined;
  if (typeof entry !== 'object' || entry === null || !isFiniteNum(entry.opened_at)) bad(`${where}: entry.opened_at missing`);
  const e = entry as Record<string, unknown>;
  const fillSource = e.fill_source;
  if (fillSource !== 'tx_meta' && fillSource !== 'quote_dry_run' && fillSource !== 'unverified') bad(`${where}: entry.fill_source invalid`);
  const lq = r.last_quote as Record<string, unknown> | null | undefined;
  const lastQuote: PositionV2['last_quote'] = lq && isFiniteNum(lq.sol) && isFiniteNum(lq.at)
    && (lq.src === 'onchain' || lq.src === 'jupiter' || lq.src === 'engine_gmgn') ? { sol: lq.sol, src: lq.src, at: lq.at } : null;
  const ata = r.ata as Record<string, unknown> | null | undefined;
  const basis = r.basis_sol_per_token;
  const attempts: Record<string, number> = {};
  if (typeof r.leg_attempts === 'object' && r.leg_attempts !== null) {
    for (const [k, v] of Object.entries(r.leg_attempts as Record<string, unknown>)) if (isFiniteNum(v) && v >= 0) attempts[k] = Math.floor(v);
  }
  const cp = r.close_pending as Record<string, unknown> | null | undefined;
  const closedAt = isFiniteNum(r.closed_at) ? r.closed_at : null;
  const pendingSigs = strArray(r.pending_sigs).slice(-MAX_PENDING_SIGS);
  const plan = r.exit_plan === undefined || r.exit_plan === null ? null : normalizeExitPlan(r.exit_plan);
  return {
    position_id: id,
    signal_id: isStr(r.signal_id) ? r.signal_id : null,
    origin: r.origin as 'signal' | 'manual',
    dry_run: r.dry_run === true,
    ca: r.ca as string,
    wallet_id: r.wallet_id as string,
    policy_id: isStr(r.policy_id) ? r.policy_id : null,
    policy_version: isStr(r.policy_version) ? r.policy_version : null,
    arm: isStr(r.arm) ? (r.arm as ArmId) : null,
    entry: {
      tx: isStr(e.tx) ? e.tx : null,
      opened_at: e.opened_at as number,
      sol_spent_lamports: isDigits(e.sol_spent_lamports) ? e.sol_spent_lamports : null,
      tokens_raw: isDigits(e.tokens_raw) ? e.tokens_raw : null,
      fill_source: fillSource as PositionV2['entry']['fill_source'],
    },
    original_tokens: r.original_tokens as string,
    tokens: r.tokens as string,
    basis_sol_per_token: isFiniteNum(basis) && basis > 0 ? basis : null,
    peak_multiple: isFiniteNum(r.peak_multiple) && r.peak_multiple > 0 ? r.peak_multiple : 1,
    legs_done: strArray(r.legs_done),
    leg_attempts: attempts,
    last_quote: lastQuote,
    lockouts: strArray(r.lockouts),
    ata: ata && isStr(ata.address) && (ata.program === 'token' || ata.program === 'token2022') ? { address: ata.address, program: ata.program } : null,
    next_due_at: isFiniteNum(r.next_due_at) ? r.next_due_at : nowMs,
    last_quote_tokens: isDigits(r.last_quote_tokens) ? r.last_quote_tokens : null,
    floor_base: isFiniteNum(r.floor_base) && r.floor_base > 0 ? r.floor_base : null,
    pending_sigs: pendingSigs,
    pending_sig_heights: sigHeights(r.pending_sig_heights, pendingSigs),
    lockout_until: isFiniteNum(r.lockout_until) ? r.lockout_until : null,
    real_out_lamports: typeof r.real_out_lamports === 'string' && /^-?\d+$/.test(r.real_out_lamports) ? r.real_out_lamports : '0',
    sell_unverified: r.sell_unverified === true,
    cancel_pending: r.cancel_pending === true,
    close_pending: cp && isFiniteNum(cp.since) && isFiniteNum(cp.tries)
      ? { since: cp.since, tries: Math.max(0, Math.floor(cp.tries)),
          reason: cp.reason === 'cancel' || cp.reason === 'manual' || cp.reason === 'external_sell' ? cp.reason : 'policy',
          close_account: cp.close_account !== false }
      : null,
    closed_at: closedAt,
    close_reason: r.close_reason === 'policy' || r.close_reason === 'cancel' || r.close_reason === 'manual' || r.close_reason === 'external_sell' ? r.close_reason : null,
    realized_sol_net_lamports: isDigits(r.realized_sol_net_lamports) || (typeof r.realized_sol_net_lamports === 'string' && /^-\d+$/.test(r.realized_sol_net_lamports)) ? (r.realized_sol_net_lamports as string) : null,
    rent_reclaimed_lamports: isDigits(r.rent_reclaimed_lamports) ? r.rent_reclaimed_lamports : null,
    close_account_status: r.close_account_status === 'closed' || r.close_account_status === 'skipped' || r.close_account_status === 'failed' ? r.close_account_status : null,
    close_account_tx: isStr(r.close_account_tx) ? r.close_account_tx : null,
    ...(plan !== null ? { exit_plan: plan } : {}),
  };
}

export function normalizeOrder(raw: unknown): StoredManualOrder {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('an order record is not an object');
  const r = raw as Record<string, unknown>;
  const id = r.order_id;
  if (!isStr(id)) bad('an order record has no order_id');
  const where = `order ${id}`;
  if (!isStr(r.position_id)) bad(`${where}: position_id missing`);
  if (!isStr(r.ca)) bad(`${where}: ca missing`);
  if (!isStr(r.wallet_id)) bad(`${where}: wallet_id missing`);
  if (r.type !== 'tp' && r.type !== 'sl' && r.type !== 'tsl') bad(`${where}: type must be tp, sl or tsl`);
  if (!isFiniteNum(r.trigger_pct)) bad(`${where}: trigger_pct must be a number`);
  const out: StoredManualOrder = {
    order_id: id,
    position_id: r.position_id as string,
    ca: r.ca as string,
    wallet_id: r.wallet_id as string,
    type: r.type as 'tp' | 'sl' | 'tsl',
    trigger_pct: r.trigger_pct as number,
    baseline_multi: isFiniteNum(r.baseline_multi) && r.baseline_multi > 0 ? r.baseline_multi : null,
    peak_rel: isFiniteNum(r.peak_rel) && r.peak_rel > 0 ? r.peak_rel : null,
    expires_at: isFiniteNum(r.expires_at) ? r.expires_at : null,
    active: r.active === true,
    attempts: isFiniteNum(r.attempts) && r.attempts > 0 ? Math.floor(r.attempts) : 0,
    created_at: isFiniteNum(r.created_at) ? r.created_at : 0,
    source: r.source === 'ui' ? 'ui' : 'migrated',
  };
  if (isFiniteNum(r.sell_pct) && r.sell_pct > 0) out.sell_pct = Math.min(r.sell_pct, 100);
  if (r.arm_after_pct === null || isFiniteNum(r.arm_after_pct)) out.arm_after_pct = r.arm_after_pct as number | null;
  if (typeof r.deactivated_reason === 'string') out.deactivated_reason = r.deactivated_reason;
  if (typeof r.last_failure === 'string') out.last_failure = r.last_failure;
  if (isFiniteNum(r.retry_at)) out.retry_at = r.retry_at;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------------------------------------------------------------

function readJsonFile(file: string): unknown | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return undefined;
    throw new PositionsStoreError(`${path.basename(file)} cannot be read`);
  }
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PositionsStoreError(`${path.basename(file)} exists but is not valid JSON; it was left untouched`);
  }
}

export function createPositionsStore(deps: PositionsStoreDeps): PositionsStoreV2 {
  const posFile = path.join(deps.dir, POSITIONS_FILE);
  const ordFile = path.join(deps.dir, MANUAL_ORDERS_FILE);
  const positions = new Map<string, StoredPosition>();
  const orders = new Map<string, StoredManualOrder>();
  const now = (): number => deps.clock.now();

  // --- load ---
  const rawPos = readJsonFile(posFile);
  if (rawPos !== undefined) {
    const list = Array.isArray(rawPos) ? rawPos : (rawPos as { positions?: unknown }).positions;
    if (!Array.isArray(list)) bad(`${POSITIONS_FILE}: no positions array`);
    for (const item of list as unknown[]) {
      const p = normalizePosition(item, now());
      positions.set(p.position_id, p);
    }
  }
  const rawOrd = readJsonFile(ordFile);
  if (rawOrd !== undefined) {
    const list = Array.isArray(rawOrd) ? rawOrd : (rawOrd as { orders?: unknown }).orders;
    if (!Array.isArray(list)) bad(`${MANUAL_ORDERS_FILE}: no orders array`);
    for (const item of list as unknown[]) {
      const o = normalizeOrder(item);
      orders.set(o.order_id, o);
    }
  }

  // --- save ---
  function savePositions(): void {
    const cutoff = now() - PRUNE_CLOSED_AFTER_MS;
    for (const [id, p] of positions) if (p.closed_at !== null && p.closed_at < cutoff) positions.delete(id);
    const file: PositionsFileV2 = { schema: STORE_SCHEMA, positions: [...positions.values()] };
    writeFileAtomicSync(posFile, JSON.stringify(file, null, 2));
  }
  function saveOrders(): void {
    const file: ManualOrdersFileV2 = { schema: STORE_SCHEMA, orders: [...orders.values()] };
    writeFileAtomicSync(ordFile, JSON.stringify(file, null, 2));
  }

  function freshSignalPosition(a: {
    id: string; signal_id: string; ca: string; wallet_id: string; arm: ArmId | null; dry_run: boolean;
    entry: PositionV2['entry']; tokens: string; plan?: ExitPlanSnapshot | null;
  }): StoredPosition {
    // A-115: a real position with a plan snapshot is stamped with the plan's policy (PRESET-<grade> and its version); without one, exactly as before
    const plan = a.plan !== undefined && a.plan !== null && !a.dry_run ? a.plan : null;
    return normalizePosition({
      position_id: a.id, signal_id: a.signal_id, origin: 'signal', dry_run: a.dry_run, ca: a.ca, wallet_id: a.wallet_id,
      policy_id: plan !== null ? plan.policy.id : deps.policy.id, policy_version: plan !== null ? plan.policy.version : deps.policy.version, arm: a.arm, entry: a.entry,
      original_tokens: a.tokens, tokens: a.tokens, basis_sol_per_token: null, peak_multiple: 1, legs_done: [], leg_attempts: {},
      last_quote: null, lockouts: [], ata: null, next_due_at: now(), ...(plan !== null ? { exit_plan: plan } : {}),
    }, now());
  }

  const store: PositionsStoreV2 = {
    openFromBuy(p, fill) {
      const id = positionIdForBuy(p.sig);
      const existing = positions.get(id);
      if (existing) return existing;
      let tokens: string;
      let entry: PositionV2['entry'];
      if (fill === 'unverified') {
        // Plan grind #65: the buy's own quote stands in for the amount; it is never booked as a fill (fill_source says so).
        tokens = p.quote_tokens_out !== null && isDigits(p.quote_tokens_out) ? p.quote_tokens_out : '0';
        entry = { tx: p.sig, opened_at: p.submitted_at, sol_spent_lamports: null, tokens_raw: null, fill_source: 'unverified' };
      } else {
        if (!isDigits(fill.tokensRaw) || BigInt(fill.tokensRaw) <= 0n) {
          throw new PositionsStoreError('openFromBuy: a fill with zero tokens is a reverted buy, not a position (A-29)');
        }
        tokens = fill.tokensRaw;
        entry = { tx: p.sig, opened_at: fill.confirmedAt, sol_spent_lamports: isDigits(fill.solSpentLamports) ? fill.solSpentLamports : null,
          tokens_raw: fill.tokensRaw, fill_source: 'tx_meta' };
      }
      const plan = normalizeExitPlan((p as PendingBuyWithPlan).exit_plan);
      const pos = freshSignalPosition({ id, signal_id: p.signal_id, ca: p.ca, wallet_id: p.wallet_id, arm: p.arm, dry_run: false, entry, tokens, plan });
      positions.set(id, pos);
      savePositions();
      return pos;
    },

    openDryRun(a) {
      const existing = positions.get(a.id);
      if (existing) return existing;
      if (!isDigits(a.tokens) || BigInt(a.tokens) <= 0n) throw new PositionsStoreError('openDryRun: tokens must be a positive decimal string');
      const pos = freshSignalPosition({
        id: a.id, signal_id: a.signal_id, ca: a.ca, wallet_id: a.wallet_id, arm: a.arm, dry_run: true, tokens: a.tokens,
        entry: { tx: null, opened_at: a.opened_at, sol_spent_lamports: a.sol_in_lamports !== null && isDigits(a.sol_in_lamports) ? a.sol_in_lamports : null,
          tokens_raw: a.tokens, fill_source: 'quote_dry_run' },
      });
      positions.set(a.id, pos);
      savePositions();
      return pos;
    },

    put(raw) {
      const pos = normalizePosition(raw, now());
      positions.set(pos.position_id, pos);
      savePositions();
      return pos;
    },

    get: (id) => positions.get(id),
    listOpen: () => [...positions.values()].filter(p => p.closed_at === null).sort((a, b) => a.entry.opened_at - b.entry.opened_at),
    openCount: () => { let n = 0; for (const p of positions.values()) if (p.closed_at === null) n++; return n; },
    findOpen: (ca, walletId) => [...positions.values()].filter(p => p.closed_at === null && p.ca === ca && p.wallet_id === walletId),

    update(id, patch) {
      const cur = positions.get(id);
      if (!cur) throw new PositionsStoreError(`update: unknown position ${id}`);
      const next = normalizePosition({ ...cur, ...patch, position_id: id }, now());
      positions.set(id, next);
      savePositions();
      return next;
    },

    close(id, c) {
      const cur = positions.get(id);
      if (!cur) throw new PositionsStoreError(`close: unknown position ${id}`);
      const next = normalizePosition({
        ...cur, closed_at: c.closed_at, close_reason: c.reason, realized_sol_net_lamports: c.realized_sol_net_lamports,
        rent_reclaimed_lamports: c.rent_reclaimed_lamports, close_account_status: c.close_account_status, close_account_tx: c.close_account_tx,
        close_pending: null, cancel_pending: false, pending_sigs: [],
      }, now());
      positions.set(id, next);
      savePositions();
      // The orders of a closed position never fire again.
      let changed = false;
      for (const o of orders.values()) {
        if (o.position_id === id && o.active) { orders.set(o.order_id, { ...o, active: false, deactivated_reason: 'position-closed' }); changed = true; }
      }
      if (changed) saveOrders();
      return next;
    },

    putOrder(o) {
      const norm = normalizeOrder(o);
      orders.set(norm.order_id, norm);
      saveOrders();
      return norm;
    },
    getOrder: (id) => orders.get(id),
    ordersOf: (positionId) => [...orders.values()].filter(o => o.position_id === positionId),
    activeOrdersOf: (positionId) => [...orders.values()].filter(o => o.position_id === positionId && o.active),
    updateOrder(id, patch) {
      const cur = orders.get(id);
      if (!cur) throw new PositionsStoreError(`updateOrder: unknown order ${id}`);
      const next = normalizeOrder({ ...cur, ...patch, order_id: id });
      orders.set(id, next);
      saveOrders();
      return next;
    },
  };
  return store;
}
