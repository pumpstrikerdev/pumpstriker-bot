/**
 * POSITION CLEANUP — wallet-truth-driven orphan reaper (B50 section 2, R3-B5).
 *
 * Every 10 min (and once at bot startup) this module:
 *   1. Reads the open positions from exits/positions-store.ts (`positions-v2.json`); virtual (dry-run) positions are never
 *      reconciled, there is nothing on chain for them;
 *   2. Asks the RPC "what SPL tokens does this wallet hold?" (`getAllSplBalances`, both token programs; the wallet of a
 *      position comes from `ownerOf(wallet_id)`). No pump.fun balances API and no JWT: the RPC scan is the single source;
 *   3. A position whose wallet shows a CONFIRMED zero of its mint in TWO consecutive sweeps is closed in the store with the
 *      reason `external_sell` (sold outside the bot's own exit flow). A position is never deleted, only closed;
 *   4. Walks every active TG monitor card; a card whose token has no open position any more is deleted from the chat;
 *   5. Sweeps empty token accounts: only mints of `trade-registry.json` (the mints the bot traded itself), through B40
 *      `closeIfEmpty` (a separate low-priority transaction). It never touches a mint the bot did not trade.
 *
 * Safety: an RPC failure for a wallet is "unknown" - that wallet is SKIPPED for this sweep. We never close a position on
 * uncertain (null) data, only on confirmed-empty readings; a position younger than 90 s, one with an unresolved sell, a
 * pending close or a pending cancel is left to the exit engine. Worst case: a stale position lingers one extra 10-min cycle.
 *
 * Dependencies are injected (`configurePositionCleanup`); `bot.ts` keeps calling `startPositionCleanupSchedule(bot)`. Without a
 * wallet resolver no position is reconciled, and without a CloseAccount API the empty-account sweep is skipped (R4-B6 passes both).
 */
import type { Telegraf } from 'telegraf';
import fs from 'fs';
import path from 'path';
import { botDataDir, CONFIG } from '../config';
import { log, logOk, logWarn, logErr } from '../logger';
import type { CloseAccountApi } from '../bot-contracts';
import { createPositionsStore, type PositionsStoreV2 } from '../exits/positions-store';
import { writeFileAtomicSync } from '../link/atomic-file';
import { systemClock, type Clock, type TimerHandle } from '../link/clock';
import { listActiveMonitorCards, stopMonitorCard } from './position-monitor';

// Grace period before a freshly-bought position can be closed by cleanup: the SPL token account takes seconds to show up in
// the RPC's balance indexes, which historically caused brand-new buys to be reaped on the very first sweep.
const CLEANUP_GRACE_MS = 90_000;

// Closing requires TWO consecutive confirmed-empty sweeps (≈10 min apart) for the same position, not one. A single flaky
// read or a not-yet-indexed Token-2022 ATA can no longer close a live position on the first pass. A non-empty reading or a
// skip resets the strike count.
const STRIKES_TO_CLOSE = 2;

/** The empty-account sweep closes at most this many accounts per run (each one is a transaction). */
export const MAX_SWEEP_CLOSES = 10;
const TEN_MINUTES_MS = 10 * 60_000;

export const TRADE_REGISTRY_FILE = 'trade-registry.json';
/** Entries kept in the registry (the oldest are dropped first). */
export const TRADE_REGISTRY_MAX = 2_000;

export interface TradeRegistryEntry { owner: string; mint: string; at: number }

export interface CleanupResult {
  walletsChecked: number;
  walletsSkipped: number;     // RPC failures and wallets that could not be resolved
  slotsCleared: number;       // positions closed because the wallet no longer holds the token
  positionsDeleted: number;   // same count (kept for the callers of the old shape): a position is closed, never deleted
  cardsDeleted: number;       // TG card messages deleted
  positionsKept: number;      // positions still open at end
  accountsClosed: number;     // empty token accounts closed by the registry sweep
  accountsSkipped: number;
  accountsFailed: number;
}

export interface PositionCleanupDeps {
  clock: Clock;
  /** Open positions and `close`. Called once per sweep (the default re-reads positions-v2.json each time). */
  store: () => Pick<PositionsStoreV2, 'listOpen' | 'close'>;
  /** The wallet address of a position's wallet id; null = unknown (the position is not reconciled). */
  ownerOf: (walletId: string) => string | null | Promise<string | null>;
  /** `getAllSplBalances` of execution/jupiter.ts: held mints, or null when the scan failed (unknown, not empty). */
  allBalances: (owner: string) => Promise<Map<string, { rawAtoms: number; decimals: number }> | null>;
  /** B40 `closeIfEmpty`; null = the empty-account sweep is skipped. */
  closeAccount: CloseAccountApi | null;
  /** The live monitor cards and how to stop one. */
  cards: {
    list: () => { chatId: number; messageId: number; ca: string }[];
    stop: (chatId: number, messageId: number) => void;
  };
  dataDir: () => string;
}

let _override: Partial<PositionCleanupDeps> = {};
const _emptyStrikes = new Map<string, number>();   // position_id → consecutive confirmed-empty sweeps

/** Replaces some dependencies (R4-B6 wiring; tests). */
export function configurePositionCleanup(d: Partial<PositionCleanupDeps>): void {
  _override = { ..._override, ...d };
}

/** Forgets the injected dependencies and the strike counters (tests). */
export function resetPositionCleanup(): void {
  _override = {};
  _emptyStrikes.clear();
}

function deps(): PositionCleanupDeps {
  const clock = systemClock;
  const base: PositionCleanupDeps = {
    clock,
    store: () => createPositionsStore({ dir: botDataDir(), clock, policy: { id: CONFIG.EXIT_POLICY_ID, version: 'cleanup' } }),
    ownerOf: () => null,
    allBalances: async (owner) => {
      const { getAllSplBalances } = await import('../execution/jupiter');
      return getAllSplBalances(owner);
    },
    closeAccount: null,
    cards: { list: listActiveMonitorCards, stop: stopMonitorCard },
    dataDir: botDataDir,
  };
  return { ...base, ..._override };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the trade registry
// ---------------------------------------------------------------------------------------------------------------------------------

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Entries of `trade-registry.json` (`{ schema: 1, entries: [{ owner, mint, at }] }`, or a bare array). A missing or broken file is empty. */
export function readTradeRegistry(dir: string): TradeRegistryEntry[] {
  try {
    const fp = path.join(dir, TRADE_REGISTRY_FILE);
    if (!fs.existsSync(fp)) return [];
    const j = JSON.parse(fs.readFileSync(fp, 'utf8')) as unknown;
    const list = Array.isArray(j) ? j : (j as { entries?: unknown } | null)?.entries;
    if (!Array.isArray(list)) return [];
    const out: TradeRegistryEntry[] = [];
    for (const e of list) {
      const r = e as { owner?: unknown; mint?: unknown; at?: unknown } | null;
      if (r && isStr(r.owner) && isStr(r.mint)) out.push({ owner: r.owner, mint: r.mint, at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0 });
    }
    return out;
  } catch {
    return [];
  }
}

function writeTradeRegistry(dir: string, entries: TradeRegistryEntry[]): void {
  writeFileAtomicSync(path.join(dir, TRADE_REGISTRY_FILE), JSON.stringify({ schema: 1, entries: entries.slice(-TRADE_REGISTRY_MAX) }, null, 2));
}

/** Records that the bot traded `mint` from `owner` (the wiring calls this after a buy). Idempotent per (owner, mint). */
export function recordTrade(dir: string, owner: string, mint: string, at: number): void {
  const list = readTradeRegistry(dir);
  if (list.some(e => e.owner === owner && e.mint === mint)) return;
  list.push({ owner, mint, at });
  writeTradeRegistry(dir, list);
}

function removeTrades(dir: string, gone: readonly TradeRegistryEntry[]): void {
  if (gone.length === 0) return;
  const drop = new Set(gone.map(e => `${e.owner}:${e.mint}`));
  writeTradeRegistry(dir, readTradeRegistry(dir).filter(e => !drop.has(`${e.owner}:${e.mint}`)));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the sweep
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Run a single cleanup sweep. Idempotent and safe to call concurrently with normal bot operation: the store writes are atomic.
 */
export async function runPositionCleanup(bot: Pick<Telegraf, 'telegram'>): Promise<CleanupResult> {
  const d = deps();
  const result: CleanupResult = {
    walletsChecked: 0, walletsSkipped: 0,
    slotsCleared: 0, positionsDeleted: 0,
    cardsDeleted: 0, positionsKept: 0,
    accountsClosed: 0, accountsSkipped: 0, accountsFailed: 0,
  };

  let store: ReturnType<PositionCleanupDeps['store']>;
  try {
    store = d.store();
  } catch (e: any) {
    logWarn(`[pos-cleanup] positions unreadable, sweep skipped: ${String(e?.message ?? e).slice(0, 160)}`);
    return result;
  }
  const now = d.clock.now();

  // Real positions the exit engine is not in the middle of handling.
  const open = store.listOpen();
  const candidates = open.filter(p =>
    !p.dry_run && p.pending_sigs.length === 0 && p.close_pending === null && !p.cancel_pending && now - p.entry.opened_at >= CLEANUP_GRACE_MS);

  // Group by wallet address: one scan per wallet.
  const byOwner = new Map<string, typeof candidates>();
  for (const p of candidates) {
    let owner: string | null = null;
    try { owner = (await d.ownerOf(p.wallet_id)) ?? null; } catch { owner = null; }
    if (!owner) { result.walletsSkipped++; continue; }
    const arr = byOwner.get(owner) ?? [];
    arr.push(p);
    byOwner.set(owner, arr);
  }

  const closedIds = new Set<string>();
  for (const [owner, positions] of byOwner) {
    result.walletsChecked++;
    let held: Map<string, { rawAtoms: number; decimals: number }> | null = null;
    try { held = await d.allBalances(owner); } catch { held = null; }
    if (held === null) {
      result.walletsSkipped++;
      logWarn(`[pos-cleanup] balance scan failed for wallet ${owner.slice(0, 8)}… — skipping`);
      continue;
    }
    for (const p of positions) {
      const onChain = held.get(p.ca);
      if (onChain && onChain.rawAtoms > 0) { _emptyStrikes.delete(p.position_id); continue; }   // the wallet still holds it
      const strikes = (_emptyStrikes.get(p.position_id) || 0) + 1;
      if (strikes < STRIKES_TO_CLOSE) {
        _emptyStrikes.set(p.position_id, strikes);
        logWarn(`[pos-cleanup] ${p.ca.slice(0, 8)}… confirmed empty (strike ${strikes}/${STRIKES_TO_CLOSE}) — waiting for confirmation before closing`);
        continue;
      }
      _emptyStrikes.delete(p.position_id);
      try {
        store.close(p.position_id, {
          closed_at: now, reason: 'external_sell', realized_sol_net_lamports: null, rent_reclaimed_lamports: null,
          close_account_status: 'skipped', close_account_tx: null,
        });
        closedIds.add(p.position_id);
        result.slotsCleared++;
        result.positionsDeleted++;
      } catch (e: any) {
        logErr(`[pos-cleanup] close failed for ${p.ca.slice(0, 8)}…: ${String(e?.message ?? e).slice(0, 160)}`);
      }
    }
  }

  // Prune strike entries of positions that are no longer open (closed here or by the exit engine).
  const openNow = store.listOpen();
  result.positionsKept = openNow.length;
  if (_emptyStrikes.size > 0) {
    const live = new Set(openNow.map(p => p.position_id));
    for (const k of _emptyStrikes.keys()) if (!live.has(k)) _emptyStrikes.delete(k);
  }

  // Close TG monitor cards whose token has no open position any more.
  await closeOrphanedCards(bot, d, new Set(openNow.map(p => p.ca)), result);

  // Empty-account sweep over the mints the bot traded itself.
  await sweepEmptyAccounts(d, new Set(openNow.map(p => p.ca)), result);

  const summary =
    `wallets=${result.walletsChecked} skipped=${result.walletsSkipped} closed=${result.slotsCleared} ` +
    `cards-deleted=${result.cardsDeleted} kept=${result.positionsKept} accounts-closed=${result.accountsClosed}`;
  if (result.slotsCleared || result.cardsDeleted || result.accountsClosed) logOk(`[pos-cleanup] swept: ${summary}`);
  else log(`[pos-cleanup] swept: ${summary} (no changes)`);
  return result;
}

/**
 * Walk every active TG monitor card; if no open position of its token is left, delete the chat message and clear the monitor
 * state. This also covers a monitor that lingers from a prior session that exited mid-sell.
 */
async function closeOrphanedCards(
  bot: Pick<Telegraf, 'telegram'>,
  d: PositionCleanupDeps,
  openCas: ReadonlySet<string>,
  result: CleanupResult,
): Promise<void> {
  const cards = d.cards.list();
  for (const card of cards) {
    if (openCas.has(card.ca)) continue;
    try {
      await bot.telegram.deleteMessage(card.chatId, card.messageId);
      result.cardsDeleted++;
    } catch (e: any) {
      // Common: "message to delete not found" (>48h old) — still clear monitor.
      logWarn(`[pos-cleanup] deleteMessage failed for ${card.ca.slice(0, 8)}… msg=${card.messageId}: ${e.message}`);
    }
    d.cards.stop(card.chatId, card.messageId);
  }
}

/**
 * Closes the empty token accounts of mints in trade-registry.json (B40 `closeIfEmpty`: balance exactly zero, a separate
 * low-priority transaction). A mint with an open position is left alone. An entry whose account is closed or gone is removed
 * from the registry; a failure keeps it for the next sweep.
 */
async function sweepEmptyAccounts(d: PositionCleanupDeps, openCas: ReadonlySet<string>, result: CleanupResult): Promise<void> {
  const api = d.closeAccount;
  if (api === null) return;
  const dir = d.dataDir();
  const entries = readTradeRegistry(dir).filter(e => !openCas.has(e.mint));
  const gone: TradeRegistryEntry[] = [];
  let tried = 0;
  for (const e of entries) {
    if (tried >= MAX_SWEEP_CLOSES) break;
    tried++;
    let r: Awaited<ReturnType<CloseAccountApi['closeIfEmpty']>>;
    try {
      r = await api.closeIfEmpty(e.owner, e.mint);
    } catch (err: any) {
      result.accountsFailed++;
      logWarn(`[pos-cleanup] closeIfEmpty threw for ${e.mint.slice(0, 8)}…: ${String(err?.message ?? err).slice(0, 120)}`);
      continue;
    }
    if (r.status === 'closed') { result.accountsClosed++; gone.push(e); }
    else if (r.status === 'failed') { result.accountsFailed++; }
    else {
      result.accountsSkipped++;
      if (r.reason === 'token account missing') gone.push(e);   // nothing left to close: forget the mint
    }
  }
  try { removeTrades(dir, gone); } catch (err: any) { logWarn(`[pos-cleanup] registry write failed: ${String(err?.message ?? err).slice(0, 120)}`); }
}

/**
 * Schedule the cleanup to run every 10 minutes for the lifetime of the bot. Returns a handle with `stop()` for shutdown.
 *
 * Calls `runPositionCleanup` once immediately so the first sweep happens at boot — that's the user-requested "clean the tg
 * position monitor log" pass. The next sweep is armed 10 minutes after the previous one FINISHED (no overlap, no setInterval).
 */
export function startPositionCleanupSchedule(bot: Pick<Telegraf, 'telegram'>): { stop(): void } {
  const clock = deps().clock;
  let stopped = false;
  let timer: TimerHandle | null = null;
  const tick = (what: string): void => {
    runPositionCleanup(bot)
      .catch(e => logErr(`[pos-cleanup] ${what} sweep error: ${e.message}`))
      .finally(() => {
        if (stopped) return;
        timer = clock.setTimeout(() => { timer = null; tick('scheduled'); }, TEN_MINUTES_MS);
      });
  };
  tick('initial');
  logOk(`[pos-cleanup] scheduled — every 10 minutes`);
  return {
    stop(): void {
      stopped = true;
      if (timer !== null) { clock.clearTimeout(timer); timer = null; }
    },
  };
}
