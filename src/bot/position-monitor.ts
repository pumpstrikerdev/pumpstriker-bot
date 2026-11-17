/**
 * POSITION MONITOR — live, auto-refreshing position card with carousel (B50 section 2, R3-B5).
 *
 * Per (chatId|messageId) tracks:
 *   • currently displayed CA + position-list snapshot for arrow navigation
 *   • 5-second refresh (re-armed on the injected Clock, no setInterval)
 *   • TSL peak-bump detection (so the ✨ moved sparkle appears for 10s)
 *   • 30-min idle auto-pause (saves RPC; resume via 🔄 manual refresh)
 *
 * WHERE THE DATA COMES FROM (nothing else is consulted: no price API, no market-data site):
 *   • positions and manual orders: exits/positions-store.ts (`positions-v2.json`, `manual-orders-v2.json`), re-read on every
 *     refresh so the card follows what the exit engine writes. This module never writes a position;
 *   • worth of the bag: exits/valuation.ts (`{ sol, src, at }`: on-chain curve or pool, Jupiter quote, or the Engine's GMGN price),
 *     printed with its source and age. A fresh quote that the exit engine just stored on the position is reused;
 *   • market cap, liquidity, symbol, name, venue: `EngineClient.token(ca)` (the Engine's GMGN fields, each with its own as_of age).
 *     An unknown field is printed as an em dash, never as 0;
 *   • token decimals: RPC `getTokenSupply` (cached for the process); network fee of the first buy: RPC `getTransaction` (cached).
 *
 * Dependencies are injected (`configurePositionMonitor`); the defaults build the real ones on first use, so `bot.ts` calls the same
 * exports whether or not the shared instances were configured.
 *
 * Public API (unchanged):
 *   • startPositionMonitor(ctx)               — open card on first position
 *   • handlePmCallback(ctx, action)           — wire to bot.on('callback_query')
 *   • stopAllForChat(chatId)                  — kill all timers (e.g. /start)
 */
import type { Context } from 'telegraf';
import fs from 'fs';
import path from 'path';
import { CONFIG, botDataDir } from '../config';
import { logWarn } from '../logger';
import type { EngineClient, PositionV2, Valuation } from '../bot-contracts';
import type { TokenProxyResponse } from '../shared/contract/v1';
import { createPositionsStore, type PositionsStoreV2, type StoredPosition } from '../exits/positions-store';
import { createValuation } from '../exits/valuation';
import { createEngineClient } from '../link/engine-client';
import { writeFileAtomicSync } from '../link/atomic-file';
import { systemClock, type Clock, type TimerHandle } from '../link/clock';
import { renderPositionCard, type Aged, type PositionCardInput } from './position-card';
import { mdSafe } from './md-safe';

// ── Constants ─────────────────────────────────────────────────────
const REFRESH_MS            = 5_000;
const IDLE_PAUSE_MS         = 30 * 60_000;        // pause after 30 min of no taps
const TSL_MOVE_FRESH_MS     = 10_000;             // ✨ sparkle window after peak bump
/** A quote the exit engine stored on the position is reused for the card when it is at most this old. */
const LAST_QUOTE_REUSE_MS   = 6_000;
const DEFAULT_SLIPPAGE_BPS  = 300;
const DEFAULT_TIP_SOL       = 0.0002;
const PREFS_FILE            = 'position-prefs.json';

// ── Dependencies ──────────────────────────────────────────────────
/** What the card needs from the positions store (a live store shared with the exit engine, or a fresh read of the file). */
export type PositionsView = Pick<PositionsStoreV2, 'listOpen' | 'activeOrdersOf'>;

export interface PositionMonitorDeps {
  clock: Clock;
  /** Open positions and active manual orders. Called on every refresh. */
  store: () => PositionsView;
  /** exits/valuation.ts: the executable value of a bag with its source and time. */
  valuation: Valuation;
  /** The Engine's GMGN snapshot of a token. */
  engine: Pick<EngineClient, 'token'>;
  /** Decimals of a mint; null = unknown. */
  decimals: (ca: string) => Promise<number | null>;
  /** Network fee in SOL of a transaction; null = unknown. */
  feeSol: (sig: string) => Promise<number | null>;
  /** The bot data folder (settings.json, position-prefs.json; the legacy positions.json only as a read fallback for old installs). */
  dataDir: () => string;
  /** A-115: the plan line and plan buttons of a card's positions (absent = no plan line). */
  planOf?: (positions: StoredPosition[]) => { line: string | null; apply: boolean; own: boolean };
}

let _override: Partial<PositionMonitorDeps> = {};
let _defaults: PositionMonitorDeps | null = null;

/** Replaces some dependencies (R4-B6 wiring with the shared store and valuation; tests). */
export function configurePositionMonitor(d: Partial<PositionMonitorDeps>): void {
  _override = { ..._override, ...d };
}

/** Stops every card, forgets the injected dependencies and the process-wide caches (tests). */
export function resetPositionMonitor(): void {
  for (const key of [..._monitors.keys()]) stopMonitor(key);
  _override = {};
  _defaults = null;
  _decimalsCache.clear();
  _feesCache.clear();
}

const _decimalsCache = new Map<string, number>();     // ca → decimals
const _feesCache = new Map<string, number>();         // signature → network fee in SOL

async function rpc(method: string, params: unknown[]): Promise<any> {
  const { resilientRpcCall } = await import('../execution/jupiter');
  return resilientRpcCall(method, params as any[]);
}

async function defaultDecimals(ca: string): Promise<number | null> {
  const cached = _decimalsCache.get(ca);
  if (cached !== undefined) return cached;
  try {
    const r = await rpc('getTokenSupply', [ca, { commitment: 'confirmed' }]);
    const d = r?.value?.decimals;
    if (Number.isInteger(d) && d >= 0 && d <= 18) {
      _decimalsCache.set(ca, d);
      return d;
    }
  } catch (e: any) { logWarn(`[pos-mon] decimals ${ca.slice(0, 8)}: ${String(e?.message ?? e).slice(0, 120)}`); }
  return null;
}

async function defaultFeeSol(sig: string): Promise<number | null> {
  const cached = _feesCache.get(sig);
  if (cached !== undefined) return cached;
  try {
    const t = await rpc('getTransaction', [sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
    const fee = Number(t?.meta?.fee);
    if (Number.isFinite(fee) && fee >= 0) {
      _feesCache.set(sig, fee / 1e9);
      return fee / 1e9;
    }
  } catch (e: any) { logWarn(`[pos-mon] fee ${sig.slice(0, 8)}: ${String(e?.message ?? e).slice(0, 120)}`); }
  return null;
}

function buildDefaults(): PositionMonitorDeps {
  const engine = createEngineClient({ engineUrl: CONFIG.ENGINE_URL, secret: () => CONFIG.SIGNAL_SHARED_SECRET });
  const clock = systemClock;
  return {
    clock,
    // a fresh read of positions-v2.json each time: the exit engine writes it, this module only looks
    store: () => createPositionsStore({ dir: botDataDir(), clock, policy: { id: CONFIG.EXIT_POLICY_ID, version: 'card' } }),
    valuation: createValuation({
      clock, engine, decimals: defaultDecimals,
      onchain: {
        async quoteSell(mint: string, tokensIn: bigint) {
          const { createOnchainQuoter } = await import('../execution/onchain-quote');
          return createOnchainQuoter().quoteSell(mint, tokensIn);
        },
      },
    }),
    engine,
    decimals: defaultDecimals,
    feeSol: defaultFeeSol,
    dataDir: botDataDir,
  };
}

/** A-115: the plan line and buttons of the card (never throws: a plan that cannot be described shows no line). */
function planInfo(group: StoredPosition[]): { plan: string | null; planButtons: { apply: boolean; own: boolean } } {
  try {
    const p = deps().planOf?.(group);
    return p === undefined ? { plan: null, planButtons: { apply: false, own: false } } : { plan: p.line, planButtons: { apply: p.apply, own: p.own } };
  } catch {
    return { plan: null, planButtons: { apply: false, own: false } };
  }
}

function deps(): PositionMonitorDeps {
  if (_defaults === null) _defaults = buildDefaults();
  return { ..._defaults, ..._override };
}

// ── Per-card state ────────────────────────────────────────────────
interface MonitorState {
  chatId: number;
  messageId: number;
  ca: string;
  positionIndex: number;        // 0-based into the positions list snapshot
  positionList: string[];       // CA list at the time of last navigation
  timer: TimerHandle | null;
  paused: boolean;              // idle auto-pause: no timer until a tap
  lastTapAt: number;            // for idle-pause detection
  lastRefreshedAt: number;
  // TSL move detection
  lastSeenHighestMultiplier: number | null;
  lastTslMoveAt: number | null;
}
const _monitors = new Map<string, MonitorState>();   // key = chatId:messageId
const monKey = (chatId: number, messageId: number) => `${chatId}:${messageId}`;

// ── Helper: read JSON sync with fallback ──────────────────────────
function readJson<T>(filename: string, fallback: T): T {
  try {
    const fp = path.join(deps().dataDir(), filename);
    if (!fs.existsSync(fp)) return fallback;
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch { return fallback; }
}

/** Open CAs in the order of the oldest open position of each. */
function openCas(store: PositionsView): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of store.listOpen()) {
    if (BigInt(p.tokens) <= 0n && !p.dry_run) continue;
    if (!seen.has(p.ca)) { seen.add(p.ca); out.push(p.ca); }
  }
  return out;
}

// ── Engine fields ─────────────────────────────────────────────────
type TokenAnswer = TokenProxyResponse | { error: string };

function ageOf(asOf: number | null | undefined, now: number): number | null {
  return typeof asOf === 'number' && Number.isFinite(asOf) ? Math.max(0, (now - asOf) / 1000) : null;
}

function numField(t: TokenAnswer, key: keyof TokenProxyResponse['fields'], now: number): Aged {
  if ('error' in t) return { value: null, ageSec: null };
  const f = t.fields[key];
  if (!f || typeof f.value !== 'number' || !Number.isFinite(f.value)) return { value: null, ageSec: null };
  return { value: f.value, ageSec: ageOf(f.as_of, now) };
}

function textField(t: TokenAnswer, key: 'symbol' | 'name'): string | null {
  if ('error' in t) return null;
  const v = t.fields[key]?.value;
  return typeof v === 'string' ? (mdSafe(v, 24) || null) : null;
}

function venueOf(t: TokenAnswer): PositionCardInput['venue'] {
  if ('error' in t) return null;
  if (t.fields.migrated?.value === true) return 'graduated';
  if (t.fields.migrated?.value === false && t.fields.launchpad_status?.value === 0) return 'curve';
  return null;
}

// ── Build the card input from current state ───────────────────────
async function buildCardInput(state: MonitorState, ca: string): Promise<PositionCardInput | null> {
  const d = deps();
  const now = d.clock.now();
  const store = d.store();
  const group = store.listOpen().filter(p => p.ca === ca && (p.dry_run || BigInt(p.tokens) > 0n));
  if (group.length === 0) return null;

  // Aggregate across wallets: one card per token.
  let atoms = 0n;
  let entryLamports = 0n;
  let entryKnown = true;
  for (const p of group) {
    atoms += BigInt(p.tokens);
    if (p.entry.sol_spent_lamports !== null) entryLamports += BigInt(p.entry.sol_spent_lamports);
    else entryKnown = false;
  }
  const agg: PositionV2 = { ...group[0], tokens: atoms.toString() };
  const initialBuySol = entryKnown && entryLamports > 0n ? Number(entryLamports) / 1e9 : null;
  const firstBuyTxSig = [...group].sort((a, b) => a.entry.opened_at - b.entry.opened_at).map(p => p.entry.tx).find((s): s is string => !!s) ?? null;

  // Pull all the live data in parallel (each source is bounded by its own timeout; a failure is "unknown", never an error)
  const reuse = group.length === 1 ? reusableQuote(group[0], now) : null;
  const [quote, token, decimals, fee] = await Promise.all([
    reuse ? Promise.resolve(reuse) : d.valuation.quote(agg, true).catch(() => null),
    d.engine.token(ca).catch((): TokenAnswer => ({ error: 'engine_offline' })),
    d.decimals(ca).catch(() => null),
    firstBuyTxSig ? d.feeSol(firstBuyTxSig).catch(() => null) : Promise.resolve(null),
  ]);

  const tokenAmount = decimals === null ? null : Number(atoms) / Math.pow(10, decimals);
  const worth: PositionCardInput['worth'] = quote
    ? { value: quote.sol, src: quote.src, ageSec: ageOf(quote.at, now) }
    : { value: null, src: null, ageSec: null };

  let avgCost: number | null = null;
  if (initialBuySol !== null && tokenAmount !== null && tokenAmount > 0) avgCost = initialBuySol / tokenAmount;
  else if (group.length === 1 && decimals !== null && group[0].basis_sol_per_token !== null) avgCost = group[0].basis_sol_per_token * Math.pow(10, decimals);

  const netPnlSol = worth.value !== null && initialBuySol !== null ? worth.value - initialBuySol : null;
  const netPnlPct = netPnlSol !== null && initialBuySol !== null && initialBuySol > 0 ? (netPnlSol / initialBuySol) * 100 : null;

  // TSL state — re-read each tick so trailing peaks update immediately
  const orders = group.flatMap(p => store.activeOrdersOf(p.position_id));
  const activeTsl = orders.find(o => o.type === 'tsl');
  let tslOut: PositionCardInput['tsl'] = null;
  if (activeTsl) {
    const highest = Number(activeTsl.peak_rel ?? 1);
    const trigger = Number(activeTsl.trigger_pct);
    const securedPct = (highest - 1) * 100 + trigger;
    // Detect peak bump since last tick
    if (state.lastSeenHighestMultiplier != null && highest > state.lastSeenHighestMultiplier + 1e-6) state.lastTslMoveAt = now;
    state.lastSeenHighestMultiplier = highest;
    const movedAgoMs = state.lastTslMoveAt ? now - state.lastTslMoveAt : Infinity;
    tslOut = {
      triggerPct: trigger,
      highestMultiplier: highest,
      securedPct,
      movedRecently: movedAgoMs < TSL_MOVE_FRESH_MS,
      movedAgoSec: Math.floor(movedAgoMs / 1000),
    };
  }

  // Limits summary for the button
  const limits = {
    tp:  orders.filter(o => o.type === 'tp').length,
    sl:  orders.filter(o => o.type === 'sl').length,
    tsl: orders.filter(o => o.type === 'tsl').length,
    buy: 0,
  };

  const prefs = readPrefs(ca);

  return {
    ca,
    ticker: textField(token, 'symbol'),
    name: textField(token, 'name'),
    origin: group.some(p => p.origin === 'signal') ? 'signal' : 'manual',
    dryRun: group.some(p => p.dry_run),
    venue: venueOf(token),
    tokenAmount,
    worth,
    avgCostSolPerToken: avgCost,
    initialBuySol,
    feesPaidSol: fee,
    mcUsd: numField(token, 'mcap_usd', now),
    liqUsd: numField(token, 'liq_usd', now),
    netPnlSol, netPnlPct,
    tsl: tslOut,
    positionIndex: state.positionIndex + 1,
    positionTotal: state.positionList.length,
    refreshedAgoSec: Math.floor((now - state.lastRefreshedAt) / 1000),
    slippageBps: prefs.slippageBps, tipSol: prefs.tipSol, antiMev: prefs.antiMev,
    ...planInfo(group),
    limits,
    firstBuyTxSig,
  };
}

/** The quote the exit engine stored on a position, when it is fresh and was taken for the same bag. */
function reusableQuote(p: StoredPosition, now: number): { sol: number; src: 'onchain' | 'jupiter' | 'engine_gmgn'; at: number } | null {
  const q = p.last_quote;
  if (!q || p.last_quote_tokens !== p.tokens) return null;
  return now - q.at <= LAST_QUOTE_REUSE_MS ? q : null;
}

// ── Per-token overrides (slippage, tip, anti-MEV) ─────────────────
interface Prefs { slippageBps: number; tipSol: number; antiMev: boolean }

/** A usable per-token number: finite and at least `min` (a missing, null, blank or non-numeric entry falls through to the next source). */
function numAtLeast(v: unknown, min: number): number | null {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : null;
}
const positiveNum = (v: unknown): number | null => { const n = numAtLeast(v, 0); return n !== null && n > 0 ? n : null; };

/**
 * Display values for the buttons, per token, first source that has a value wins (A-80 (1)):
 *   1. `position-prefs.json[ca]`: the per-token slippage, tip and anti-MEV that bot.ts writes (and the anti-MEV toggle here);
 *   2. the legacy `positions.json[ca]` entry, read only while a token has no prefs row for that field (old installs before the
 *      cutover archives that file); nothing is ever written to it;
 *   3. `settings.json` `global` (slippage, anti-MEV), else the built-in defaults.
 * Read-only except the anti-MEV toggle, which writes position-prefs.json.
 */
function readPrefs(ca: string): Prefs {
  const mine = readJson<any>(PREFS_FILE, {})?.[ca] ?? {};
  const legacy = readJson<any>('positions.json', {})?.[ca] ?? {};
  const g = readJson<any>('settings.json', {})?.global ?? {};
  return {
    slippageBps: positiveNum(mine.slippageBps) ?? positiveNum(legacy.slippageBps) ?? positiveNum(g.slippageBps) ?? DEFAULT_SLIPPAGE_BPS,
    tipSol: numAtLeast(mine.tipSol, 0) ?? numAtLeast(legacy.tipSol, 0) ?? DEFAULT_TIP_SOL,      // a tip of 0 is a valid choice
    antiMev: typeof mine.antiMev === 'boolean' ? mine.antiMev : legacy.antiMev != null ? !!legacy.antiMev : !!g.antiMev,
  };
}

// ── Refresh + edit message ────────────────────────────────────────
async function refreshCard(ctx: Context, key: string, force = false): Promise<void> {
  const state = _monitors.get(key);
  if (!state) return;
  const clock = deps().clock;

  // Idle pause
  if (!force && clock.now() - state.lastTapAt > IDLE_PAUSE_MS) {
    state.paused = true;
    if (state.timer) { clock.clearTimeout(state.timer); state.timer = null; }
    return;
  }

  let input: PositionCardInput | null = null;
  try {
    input = await buildCardInput(state, state.ca);
  } catch (e: any) {
    logWarn(`[pos-mon] build err: ${e?.message || e}`);
    return;
  }

  if (!input) {
    // Position closed — show empty state and stop the timer
    stopMonitor(key);
    try {
      await ctx.telegram.editMessageText(state.chatId, state.messageId, undefined,
        '📊 <b>Position closed</b> — fully sold or removed.',
        { parse_mode: 'HTML' } as any);
    } catch { /* ignore */ }
    return;
  }

  state.lastRefreshedAt = clock.now();
  const { text, keyboard } = renderPositionCard(input);
  try {
    await ctx.telegram.editMessageText(state.chatId, state.messageId, undefined, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...keyboard,
    } as any);
  } catch (e: any) {
    const desc = String(e?.description || '');
    const msg  = String(e?.message     || '');
    // Silent on:
    //   • "not modified"  — same content, no-op
    //   • ECONNRESET / EACCES / ETIMEDOUT — transient network blips, next
    //     5s tick will retry on its own; no point spamming logs
    //   • "message to edit not found" — user closed/deleted the card
    if (
      desc.includes('not modified') ||
      desc.includes('message to edit not found') ||
      msg.includes('ECONNRESET')   || msg.includes('EACCES') ||
      msg.includes('ETIMEDOUT')    || msg.includes('ENOTFOUND') ||
      msg.includes('socket hang up')
    ) return;
    logWarn(`[pos-mon] edit err: ${desc || msg || e}`);
  }
}

/** Arms the next refresh of a card on the injected clock; re-arms itself after every refresh until the card stops or goes idle. */
function startInterval(ctx: Context, key: string): void {
  const state = _monitors.get(key);
  if (!state) return;
  const clock = deps().clock;
  if (state.timer) clock.clearTimeout(state.timer);
  state.paused = false;
  state.timer = clock.setTimeout(() => {
    state.timer = null;
    refreshCard(ctx, key)
      .catch(() => {})
      .finally(() => {
        if (_monitors.get(key) === state && !state.paused && state.timer === null) startInterval(ctx, key);
      });
  }, REFRESH_MS);
}

function stopMonitor(key: string): void {
  const state = _monitors.get(key);
  if (!state) return;
  if (state.timer) { deps().clock.clearTimeout(state.timer); state.timer = null; }
  state.paused = true;
  _monitors.delete(key);
}

export function stopAllForChat(chatId: number): void {
  for (const [key, state] of _monitors) {
    if (state.chatId === chatId) stopMonitor(key);
  }
}

/**
 * Snapshot of every active monitor card. Used by the orphan-position cleanup
 * job to know which chat messages correspond to a now-closed CA so it can
 * delete the dead card from the TG chat history.
 */
export function listActiveMonitorCards(): { chatId: number; messageId: number; ca: string }[] {
  return Array.from(_monitors.values()).map(s => ({
    chatId: s.chatId, messageId: s.messageId, ca: s.ca,
  }));
}

/**
 * Stop and forget a single monitor card. Idempotent — safe to call on a key
 * that doesn't exist. Used by the cleanup job after deleting the TG message.
 */
export function stopMonitorCard(chatId: number, messageId: number): void {
  stopMonitor(monKey(chatId, messageId));
}

// ── Entry: open the card on first position ────────────────────────
export async function startPositionMonitor(ctx: Context, ca?: string): Promise<void> {
  const d = deps();
  let allCas: string[];
  try {
    allCas = openCas(d.store());
  } catch (e: any) {
    logWarn(`[pos-mon] positions unreadable: ${String(e?.message ?? e).slice(0, 160)}`);
    await ctx.reply('📊 <b>Positions</b>\n\nThe positions file cannot be read - nothing was changed. Check the bot log.', { parse_mode: 'HTML' } as any);
    return;
  }
  if (!allCas.length) {
    await ctx.reply('📊 <b>Positions</b>\n\nNo open positions.', { parse_mode: 'HTML' } as any);
    return;
  }

  const startCa = ca && allCas.includes(ca) ? ca : allCas[0];
  const idx = allCas.indexOf(startCa);
  const chatId = ctx.chat!.id;

  // Initial render uses placeholder values — first tick fills in real data
  const placeholder =
    '📊 <i>Loading position…</i>';
  const sent = await ctx.reply(placeholder, { parse_mode: 'HTML' } as any);
  const messageId = (sent as any).message_id;

  const key = monKey(chatId, messageId);
  // If somehow re-opening the same message, clean up previous timer
  stopMonitor(key);

  const now = d.clock.now();
  const state: MonitorState = {
    chatId, messageId,
    ca: startCa,
    positionIndex: idx,
    positionList: allCas,
    timer: null,
    paused: false,
    lastTapAt: now,
    lastRefreshedAt: now,
    lastSeenHighestMultiplier: null,
    lastTslMoveAt: null,
  };
  _monitors.set(key, state);

  // Immediate refresh so the card paints fast, then arm the timer
  await refreshCard(ctx, key, true);
  if (_monitors.get(key) === state) startInterval(ctx, key);
}

/** Find the monitor state for the current callback message (if any). */
function findStateForCallback(ctx: Context): { state: MonitorState; key: string } | null {
  const cq = ctx.callbackQuery as any;
  if (!cq?.message) return null;
  const key = monKey(cq.message.chat.id, cq.message.message_id);
  const state = _monitors.get(key);
  return state ? { state, key } : null;
}

// ── Callback dispatcher ───────────────────────────────────────────
// Patterns:
//   pm:nav:prev | pm:nav:next
//   pm:refresh
//   pm:close
//   pm:cfg:mev:<ca>
//   (sell + slip + tip + limits handlers live in bot.ts since they need the
//    bot's existing executeSell, settings menus, and order CRUD)
export async function handlePmCallback(ctx: Context, action: string): Promise<boolean> {
  const found = findStateForCallback(ctx);
  if (!found && action !== 'pm:close') return false;

  if (action === 'pm:close') {
    if (found) stopMonitor(found.key);
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    return true;
  }

  const { state, key } = found!;
  state.lastTapAt = deps().clock.now();

  if (action === 'pm:refresh') {
    await refreshCard(ctx, key, true);
    if (state.paused || !state.timer) startInterval(ctx, key);   // resume from idle pause
    return true;
  }

  if (action === 'pm:nav:next' || action === 'pm:nav:prev') {
    try {
      const fresh = openCas(deps().store());
      if (fresh.length) state.positionList = fresh;
    } catch { /* keep the snapshot */ }
    if (!state.positionList.length) return true;
    const cur = state.positionList.indexOf(state.ca);
    const dir = action === 'pm:nav:next' ? 1 : -1;
    const from = cur >= 0 ? cur : state.positionIndex;
    state.positionIndex = (from + dir + state.positionList.length) % state.positionList.length;
    state.ca = state.positionList[state.positionIndex];
    state.lastSeenHighestMultiplier = null;
    state.lastTslMoveAt = null;
    await refreshCard(ctx, key, true);
    if (state.paused || !state.timer) startInterval(ctx, key);
    return true;
  }

  // Anti-MEV toggle (per-token override)
  if (action.startsWith('pm:cfg:mev:')) {
    const ca = action.split(':')[3];
    if (ca === state.ca) {
      togglePerTokenAntiMev(ca);
      await refreshCard(ctx, key, true);
    }
    return true;
  }

  return false;   // not handled here — let bot.ts default handler take it
}

/**
 * Flips the per-token anti-MEV choice. It is kept in position-prefs.json, the file bot.ts reads for a sell; the legacy
 * positions.json is never written (A-80 (1)).
 */
function togglePerTokenAntiMev(ca: string): void {
  try {
    const next = !readPrefs(ca).antiMev;
    const dir = deps().dataDir();
    const prefs = readJson<Record<string, any>>(PREFS_FILE, {});
    prefs[ca] = { ...(prefs[ca] ?? {}), antiMev: next };
    writeFileAtomicSync(path.join(dir, PREFS_FILE), JSON.stringify(prefs, null, 2));
  } catch (e: any) { logWarn(`[pos-mon] mev toggle err: ${String(e?.message ?? e).slice(0, 160)}`); }
}

/** Refresh the active card after any external mutation (e.g. limit edit). */
export async function bumpRefresh(ctx: Context): Promise<void> {
  const found = findStateForCallback(ctx);
  if (!found) return;
  found.state.lastTapAt = deps().clock.now();
  await refreshCard(ctx, found.key, true);
}

/** Look up the current displayed CA for the callback's message — used by
 *  bot.ts handlers that need to know which token a generic-looking button
 *  (Sell X, Slippage, Tip) refers to. */
export function getCurrentCaForCallback(ctx: Context): string | null {
  const found = findStateForCallback(ctx);
  return found?.state.ca || null;
}

/** External trigger: after a limit-order edit/add/delete, refresh the card. */
export function refreshActiveCardForChat(ctx: Context): void {
  bumpRefresh(ctx).catch(() => {});
}
