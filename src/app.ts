/**
 * app.ts (B50 section 3, R4-B6; plan grind #69): the wiring of the rebuilt bot, as a factory.
 *
 *   createBotApp(deps)  builds every module and connects them; it starts no timer and opens no socket.
 *   boot(deps)          createBotApp + the start sequence + the events server listening on 127.0.0.1.
 *
 * `bot.ts` keeps the Telegram UI and calls `boot` from its `main()`; tests call the factory with stubs and never import `bot.ts`. Nothing
 * here talks to Telegram, an RPC node, Jupiter or PumpPortal unless the caller hands in the real function (the defaults load the real
 * execution modules lazily, at the first call).
 *
 * WIRING (A-28, A-30, A-52, A-55, B50 section 3):
 *   events server (B10)  ->  intake  ->  auto-buy (B20)  ->  smartBuy
 *                                    ->  ExitApi.cancel -> exit engine (B30) -> smartSell, fills, CloseAccount (B40)
 *   every bot -> Engine event goes through ONE BotOutbox (link/engine-outbox.ts), built with buildEnvelope and a ULID factory
 *   the exit engine gets a DECORATING outbox: position.closed feeds autoBuy.onPositionClosed and a successful sell exit.leg feeds
 *   autoBuy.noteSellOk (the engine has no such hook), the real outbox still receives every event unchanged
 *   outbox.setNotifier(text => queue.notifyOwner(text)) once the queue exists; heartbeat source; shutdown = flushNow() then stop()
 *   every Engine call (events, token/price proxies, skill commands) uses node:http (link/common.ts defaultHttp), never the global fetch
 *
 * WALLET LINK (R7-W6, A-99, A-104): the six synchronous /v1/wallet routes of the Engine's browser-wallet flows are built here from the execution
 * layer's unsigned builders and mounted on the events server behind the same link auth (WALLET_LINK_ROUTES=0 leaves them out). They build for an
 * external payer and read the chain on their own RPC port (wallet RPC lane, own daily cap and per-second bucket); they never sign or send, and they
 * share nothing with the positions store, auto-buy, the exit engine, the manual-buy journal, the cancel requests, the send queue or Telegram.
 *
 * START ORDER (boot): auto-buy start -> pending-buy boot recovery (B20, `await autoBuy.recover()`, A-93f: bounded by its deadline, the
 * rest runs in the background) -> exit engine start -> manual-buy journal resumed -> arm verdicts read (A-93f: a few tries) -> events
 * server listen (intake) -> outbox flusher and heartbeat -> Engine watch. The recovery therefore runs BEFORE the exit engine starts and
 * BEFORE the events server accepts a single event.
 *
 * MANUAL TRADES. The Telegram UI's buy and sell buttons go through `app.manual` (createManualTrader): a manual buy opens a PositionV2
 * (origin 'manual') that the same exit engine manages, a manual sell runs one sell attempt on the shared per-(CA, wallet) mutex with its
 * fill read from the chain, and a full sell is finished by the engine (confirmed zero balance, CloseAccount, position.closed). FIX-BUY: a manual
 * buy is refused before the router when the wallet's native SOL is below the amount plus BUY_SOL_HEADROOM_LAMPORTS or cannot be read, and a buy
 * that reverted is told to the owner with the chain's reason and its cost.
 *
 * Secrets: this module never logs a value from the environment and never builds a log line from a token, a key or the link secret.
 */
import { createHash } from 'node:crypto';
import type { Keypair } from '@solana/web3.js';
import type {
  BotOutbox, CloseAccountApi, EngineClient, FillReader, PendingBuy, PositionV2, Valuation,
} from './bot-contracts';
import {
  createAutoBuy, type AutoBuyPositions, type AutoBuyService, type SmartBuyFn, type VirtualBuy,
} from './autobuy/api';
import { dryRunFromEnv, errText } from './autobuy/guards';
import { cardAutoBuy } from './autobuy/card-mode';
import { checkPending, recoveryRpcFrom, type PendingVerdict, type RecoveryRpc } from './autobuy/pending';
import { parseSolAmount, BuyLock } from './bot/trade-guards';
import { recordTrade } from './bot/position-cleanup';
import { envSnapshot, rpcOnlyUrl, rpcUrlOverride, type BotConfig, type EnvRecord } from './config';
import { createCloseAccountApi } from './execution/close-account';
import { defaultExecRpc, deriveAta, withTimeout, WSOL_MINT, type ExecRpc } from './execution/exec-common';
import { solText4 } from './execution/send-context';
import { createFillReader } from './execution/fills';
import { createExitApi } from './exits/api';
import { MANUAL_BUYS_FILE, openManualBuyJournal, type ManualBuyJournal, type ManualBuyRecord } from './exits/manual-buy-journal';
import { applyCancelRequest, openCancelRequests } from './exits/cancel-requests';
import { allocate, createExitEngine, MANUAL_POLICY_VERSION, type ExitEngine } from './exits/exit-engine';
import { sellKey, type LandedCheckDeps, type SellMutex } from './exits/failure-policy';
import { createPositionsStore, MAX_PENDING_SIGS, type PositionsStoreV2, type StoredPosition } from './exits/positions-store';
import { resolvePlan, type ExitPlanSnapshot, type PresetSettings } from './exits/presets';
import type { OwnerFilterSettings } from './intake/owner-filter';
import { cardLinks } from './tg/card-links';
import type { InlineRow } from './tg/cards';
import { runSellAttempt, type SmartSellFn } from './exits/sell-runner';
import type { SignedTx } from './execution/router';
import { createValuation, type ValuationDeps } from './exits/valuation';
import { createIntake, type Intake } from './intake/handlers';
import { createEngineClient } from './link/engine-client';
import { createEngineOutbox, type EngineOutbox, type HeartbeatFields } from './link/engine-outbox';
import { createEngineWatch, type EngineWatch } from './link/engine-watch';
import { createEventsServer, type EventsServer, type RunningEventsServer } from './link/events-server';
import { createInbox, type Inbox } from './link/inbox';
import { systemClock, type Clock, type TimerHandle } from './link/clock';
import { buildEnvelope, defaultLog, errMessage, type HttpFn, type LinkLog } from './link/common';
import { createUlidFactory } from './link/ulid';
import { redactSecrets } from './lib/redact';
import type { Grade, Ms } from './shared/common/ids';
import { CONTRACT_VERSION, type BotToEngineEvent, type PositionClosed, type PositionOpened, type SignalNew } from './shared/contract/v1';
import type { SignalCardExtras } from './shared/card/render-signal';
import { linkHeaders } from './shared/link-auth';
import { loadPolicies, type ResolvedPolicy } from './shared/exit-policy/exit-policy';
import policiesJson from './shared/exit-policy/exit-policies.json';
import { createSendQueue, type SendQueue, type TelegramApi } from './tg/send-queue';
import { createRpcBudget } from './execution/rpc-budget';
import { createWalletRpc, resolveWalletRpcUrl } from './execution/wallet-rpc';
import { createWalletLinkHandler, createWalletLinkOps, type WalletLinkOps } from './wallet-link/handler';
import { createWalletRouter } from './wallet-link/routes';

/** The bot's name wherever a brand appears (A-7, user decision 2026-10-18). */
export const BRAND = 'Pumpstriker Bots';

export const ARMS_REFRESH_MS = 300_000;
/** A-93f: while the arm verdicts are unknown (no successful GET /arms since the start) they are read again this often. */
export const ARMS_RETRY_MS = 10_000;
/** A-93f: immediate tries of GET /arms during the start, before the events server accepts the first event. */
export const ARMS_BOOT_TRIES = 3;
export const BALANCE_REFRESH_MS = 30_000;

// ---------------------------------------------------------------------------------------------------------------------------------
// the heartbeat's A-110 inputs (R8-RDB1): the RPC provider label, the lamports of a getBalance answer, the bot username
// ---------------------------------------------------------------------------------------------------------------------------------

const U64_MAX = 18_446_744_073_709_551_615n;
const BOT_USERNAME_RE = /^[A-Za-z0-9_]{1,32}$/;

/**
 * The label of the RPC provider the bot's reads go through, for the heartbeat's rpc_provider (A-110): one of a FIXED set of words, so it can never
 * be a URL and never carry key material. 'custom' = RPC_URL is set (the first lane of the pool, or the only one with RPC_FALLBACKS=off); 'helius' =
 * the bot lane (HELIUS_RPC_BOT, else HELIUS_RPC) points at a helius-rpc.com host; 'primary' = any other configured lane; 'public' = no lane is
 * configured, only the public pool. It names the configured first choice: resilientRpcCall may fail over to a later lane, which this label does not track.
 */
export function rpcProviderLabel(config: Pick<BotConfig, 'HELIUS_RPC' | 'HELIUS_RPC_BOT'>, env: EnvRecord): 'custom' | 'helius' | 'primary' | 'public' {
  if (rpcUrlOverride(env) !== '') return 'custom';
  const lane = config.HELIUS_RPC_BOT || config.HELIUS_RPC;
  if (lane === '') return 'public';
  try {
    const host = new URL(lane).hostname.toLowerCase();
    return host === 'helius-rpc.com' || host.endsWith('.helius-rpc.com') ? 'helius' : 'primary';
  } catch {
    return 'primary';
  }
}

/** The RPC's `value` of a getBalance answer as a canonical lamports string (no sign, no leading zero, within u64), or null when it is none. */
export function canonicalLamports(v: unknown): string | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  if (typeof v === 'string') return /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) <= U64_MAX ? v : null;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// what the wiring needs from the UI side (wallets, settings)
// ---------------------------------------------------------------------------------------------------------------------------------

export interface AppWallet { walletId: string; owner: string; keypair: Keypair }
export interface AppWallets {
  /** The wallet auto-buy trades with (the default wallet), or null. */
  current(): AppWallet | null;
  get(walletId: string): AppWallet | null;
  byOwner(owner: string): AppWallet | null;
}

/** A live view of settings.json: read on every call, so a change in the Telegram menus acts at once. */
export interface AppSettings {
  buySol(): number;
  /** settings.signal.slippageBps (else the global one): the slippage cap of an auto-buy. */
  autoBuySlippageBps(): number;
  priorityFee(): number;
  antiMev(): boolean;
  tgMinGrade(): Grade;
  /** The owner's trading-session window (always true while it is off). */
  sessionOk(nowMs: number): boolean;
  /** settings.global.slippageBps and smartSlippageMax. */
  slippage(): { baseBps: number; smartMaxBps: number };
  /** settings.global.duplicateBuy: may the owner buy a token again while a position is open? */
  duplicateBuy(): boolean;
  /** A-115: the owner's restored Signals filters (absent = none). */
  ownerFilter?(): OwnerFilterSettings;
  /** A-115: Auto-Sell by Grade and the grade presets (absent = every grade follows the active exit policy). */
  presets?(): PresetSettings;
  /** A-115: the inline keyboard of a signal card (the buy row of global.buyKb and the skills row), built by the Telegram UI. */
  cardButtons?(ca: string): InlineRow[];
}

export interface BotAppDeps {
  /** buildConfig(env). */
  config: BotConfig;
  /** The environment the modules that take an env record read (AUTOBUY_*, BOT_DRY_RUN ...). Never logged. */
  env: EnvRecord;
  /** BOT_DATA_DIR. */
  dataDir: string;
  telegram: TelegramApi;
  wallets: AppWallets;
  settings: AppSettings;
  clock?: Clock;
  log?: LinkLog;
  /** The HTTP seam of every Engine call (default: node:http). */
  http?: HttpFn;
  /** Override of the Engine client (tests). */
  engine?: EngineClient;
  /** exit-policies.json (default: the shared file). */
  policiesJson?: unknown;
  // --- the execution layer: the real functions by default, stubs in tests --------------------------------------------------------
  smartBuy?: SmartBuyFn;
  smartSell?: SmartSellFn;
  fills?: FillReader;
  closeAccount?: CloseAccountApi;
  rpc?: ExecRpc;
  /** Token balance of (owner, mint): null = unknown, `{ rawAtoms: 0 }` = a confirmed empty account (execution/jupiter.ts getSplTokenBalance). */
  splBalance?: (owner: string, mint: string) => Promise<{ rawAtoms: number } | null>;
  /**
   * Buying power of a wallet in SOL (native + wSOL), or null when unknown. Default (A-110, R8-RDB1): ONE getBalance call plus the wSOL token-account
   * read, both through `rpc`; the getBalance answer's lamports and context slot also feed the heartbeat's bot_wallet. An injected function reports
   * no lamports or slot, so the heartbeat's bot_wallet stays null then (never a guess).
   */
  walletBalanceSol?: (owner: string) => Promise<number | null>;
  /**
   * A-110 (R8-RDB1): Telegraf's `bot.botInfo`, undefined until `launch()` has fetched it. The heartbeat carries `bot_username` from it (null before).
   * bot.ts passes `() => bot.botInfo`. Absent = the username is never reported.
   */
  botInfo?: () => { username?: string | null } | null | undefined;
  onchain?: ValuationDeps['onchain'];
  jupQuote?: ValuationDeps['jupQuote'];
  /** Token decimals; null = unknown. Default: RPC getTokenSupply, cached. */
  decimals?: (ca: string) => Promise<number | null>;
  /**
   * R7-W6 (A-99): the operations behind POST /v1/wallet/{quote,fill,find,balances,close-quote,close-fill}. Default: built from the execution layer's
   * unsigned builders on the wallet RPC lane. Tests hand in stubs. Unused when config.WALLET_LINK_ROUTES is off.
   */
  walletLink?: WalletLinkOps;
  armsRefreshMs?: number;
  /** A-93f: the re-read interval while the verdicts are unknown (default ARMS_RETRY_MS). */
  armsRetryMs?: number;
  balanceRefreshMs?: number;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the manual trader (the Telegram UI's buy and sell buttons)
// ---------------------------------------------------------------------------------------------------------------------------------

export interface ManualBuyArgs {
  walletId: string; ca: string; sol: number;
  slippageBps?: number | null; priorityFee?: number; antiMev?: boolean; allowDupe?: boolean;
  /** A-115: a buy from a signal card (sbuy:) runs this plan (resolved at the tap) instead of the owner's orders. */
  exitPlan?: ExitPlanSnapshot | null;
}
export interface ManualBuyResult {
  sig: string; positionId: string | null;
  /** The route's QUOTE in token atoms (what the chain filled is read later and replaces it on the position). */
  tokenAmt: number; impact: number; route: string;
}
export interface ManualSellArgs {
  walletId: string; ca: string; pct: number;
  /** A per-token override of the base slippage (else settings.global.slippageBps). */
  slippageBps?: number | null;
  priorityFee?: number; antiMev?: boolean;
}
export interface ManualSellResult {
  sig: string | null;
  /** SOL received (net, from the transaction meta); null when the fill could not be read. */
  solOut: number | null;
  /** Realised PnL of the part sold in SOL and percent; null when the cost or the proceeds are unknown. */
  pnl: number | null; pnlPct: number | null;
  closed: boolean; verified: boolean;
  /** For the trade-closed card. */
  entryTs: number | null; entrySol: number | null; usedSlip: number | null;
}

export interface ManualTrader {
  buy(a: ManualBuyArgs): Promise<ManualBuyResult>;
  sell(a: ManualSellArgs): Promise<ManualSellResult>;
  /** A-93f: settles the manual buys left in the journal by the previous run (boot; background). */
  resume(): void;
  /** Clears the re-check timers. */
  stop(): void;
}

export interface ManualTraderDeps {
  clock: Clock;
  store: PositionsStoreV2;
  wallets: AppWallets;
  settings: AppSettings;
  smartBuy: SmartBuyFn;
  smartSell: SmartSellFn;
  fills: FillReader;
  chain: LandedCheckDeps;
  mutex: SellMutex;
  outbox: BotOutbox;
  newEventId: () => string;
  dataDir: string;
  notifyOwner: (text: string) => void;
  log: LinkLog;
  lock?: BuyLock;
  /** A-93f: the manual-buy journal (default: <dataDir>/manual-buys.json). */
  journal?: ManualBuyJournal;
  /** A-93f: how often an unresolved manual buy is checked again (default MANUAL_SETTLE_RETRY_MS). */
  settleRetryMs?: number;
  /**
   * FIX-BUY: the wallet's native SOL in lamports ('confirmed'), or null when it cannot be read. A manual buy reads it before the router is
   * asked and is refused when it is null (fail closed) or below the amount plus BUY_SOL_HEADROOM_LAMPORTS. createBotApp reads it with
   * getBalance on its `rpc`.
   */
  solLamports: (owner: string) => Promise<bigint | null>;
}

/**
 * FIX-BUY (2jeX..., 2026-11-06: a 0.1 SOL buy was sent from a wallet holding 0.089 SOL and reverted): the native SOL a manual buy needs
 * on top of its amount. It covers up to four new token accounts (wSOL, the token, two route intermediates: about 0.0015 to 0.0022 SOL
 * each at the rent those transactions paid), the 0.0002 SOL Sender tip, the 0.000005 SOL signature fee, the priority fee and the
 * payer's own rent-exempt minimum. Every route spends NATIVE SOL (Jupiter wraps it in the transaction), so wSOL is not counted. The
 * exact need of a Jupiter route is checked by its simulation before signing; this is the cheap first check, for every route.
 */
export const BUY_SOL_HEADROOM_LAMPORTS = 10_000_000n;
/** FIX-BUY: the balance read before a manual buy may take this long; no answer refuses the buy. */
export const BUY_BALANCE_READ_MS = 5_000;

const LAMPORTS = 1_000_000_000;
/** A buy fill the chain confirmed (FillReader.buyFill minus 'unverified'). */
type VerifiedBuyFill = Exclude<Awaited<ReturnType<FillReader['buyFill']>>, 'unverified'>;
/** A-93f: an unresolved manual buy (meta unreadable, blockhash still valid or RPC down) is checked again this often. */
export const MANUAL_SETTLE_RETRY_MS = 5_000;
const lamportsOf = (sol: number): string => BigInt(Math.round(sol * LAMPORTS)).toString();
const shortCa = (ca: string): string => (ca.length > 10 ? `${ca.slice(0, 4)}..${ca.slice(-4)}` : ca);
const isDigits = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);

/** Position id of a manual buy: a digest of its signature, so a repeated open for the same buy finds the same record. */
export function manualPositionId(sig: string): string {
  return 'man_' + createHash('sha256').update('manual:' + sig, 'utf8').digest('hex').slice(0, 24);
}

/**
 * The one-line owner notice of a REAL exit: a sold leg or a closed position. A dry-run leg, a failed leg (the engine alerts those
 * itself) and every other event give null. Plain text; the send queue escapes it.
 */
export function ownerLineOf(ev: BotToEngineEvent, pos: StoredPosition | undefined): string | null {
  const what = pos ? shortCa(pos.ca) : 'a position';
  if (ev.type === 'exit.leg') {
    const p = ev.payload;
    if (p.dry_run || (p.status !== 'filled' && p.status !== 'filled_unconfirmed')) return null;
    const got = p.sol_out_real_lamports !== null ? `${(Number(p.sol_out_real_lamports) / LAMPORTS).toFixed(4)} SOL` : 'proceeds not verified';
    return `Exit ${p.leg} on ${what}: sold ${Math.round(p.fraction_of_original * 100)}% of the position, got ${got}`
      + `${p.status === 'filled_unconfirmed' ? ' (fill not verified)' : ''}${p.tx !== null ? `, tx ${p.tx}` : ''}`;
  }
  if (ev.type === 'position.closed') {
    if (pos?.dry_run === true) return null;
    const p = ev.payload;
    const net = p.realized_sol_net_lamports !== null ? `${(Number(p.realized_sol_net_lamports) / LAMPORTS).toFixed(4)} SOL net` : 'net result not verified';
    const rent = p.rent_reclaimed_lamports !== null ? `, rent back ${(Number(p.rent_reclaimed_lamports) / LAMPORTS).toFixed(4)} SOL` : '';
    return `Position closed (${p.reason}) ${what}: ${net}${rent}`;
  }
  return null;
}

/** Lamports as SOL, exact (up to 9 decimals, trailing zeros dropped): 5002 -> "0.000005002". */
function solExact(lamports: bigint): string {
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return frac === '' ? (lamports / 1_000_000_000n).toString() : `${lamports / 1_000_000_000n}.${frac}`;
}

/**
 * FIX-BUY: the owner's words for a transaction's on-chain error (the `err` of getSignatureStatuses): the compute-unit limit (38HZ...), a step
 * without enough SOL or tokens (custom error 1 of the System and Token programs: 2jeX...), the fee and rent errors, else the error itself
 * (redacted, at most 120 characters).
 */
export function chainErrorText(err: unknown): string {
  const o = err !== null && typeof err === 'object' && !Array.isArray(err) ? err as Record<string, unknown> : null;
  if (err === 'InsufficientFundsForFee') return 'the wallet did not have enough SOL for the network fee';
  if (o !== null && 'InsufficientFundsForRent' in o) return 'the wallet did not have enough SOL for the rent of a new account';
  const ie = o?.InstructionError;
  if (Array.isArray(ie) && ie.length === 2) {
    if (ie[1] === 'ComputationalBudgetExceeded') return 'the route ran out of compute units';
    if ((ie[1] as { Custom?: unknown } | null)?.Custom === 1) return 'a step of the swap did not have enough SOL (or tokens) in the wallet';
  }
  let text: string;
  try { text = JSON.stringify(err) ?? String(err); } catch { text = String(err); }
  return `the chain reported ${redactSecrets(text).slice(0, 120)}`;
}

/** The signatures a router error carries (RouterSendError.sigs; A-59). An error without them sent nothing. */
function sigsOf(e: unknown): string[] {
  const s = (e as { sigs?: unknown } | null | undefined)?.sigs;
  return Array.isArray(s) ? s.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

export function createManualTrader(d: ManualTraderDeps): ManualTrader {
  const { clock, store, log } = d;
  const lock = d.lock ?? new BuyLock();

  function emit(ev: BotToEngineEvent): void {
    try { d.outbox.append(ev); } catch (e) { log(`manual: could not queue ${ev.type} (${errMessage(e).slice(0, 100)})`, 'err'); }
  }

  function emitOpened(pos: StoredPosition): void {
    const payload: PositionOpened = {
      position_id: pos.position_id, wallet_id: pos.wallet_id, origin: 'manual', dry_run: false, arm: null,
      policy: pos.exit_plan !== undefined ? { id: pos.exit_plan.policy.id, version: pos.exit_plan.policy.version } : null, entry_tx: pos.entry.tx,
      opened_at: pos.entry.opened_at, sol_spent_lamports: pos.entry.sol_spent_lamports, tokens_raw: pos.entry.tokens_raw, fill_source: pos.entry.fill_source,
      basis_sol_per_token: pos.basis_sol_per_token,
    };
    emit(buildEnvelope('position.opened', payload, { eventId: d.newEventId(), signalId: null, ca: pos.ca, now: clock.now() }));
  }

  function emitClosed(pos: StoredPosition, payload: PositionClosed): void {
    emit(buildEnvelope('position.closed', payload, { eventId: d.newEventId(), signalId: pos.signal_id, ca: pos.ca, now: clock.now() }));
  }

  /** A position that never landed is closed, not deleted (nothing is ever deleted from the store). `extra` is appended to the owner notice. */
  function dropPhantom(positionId: string, why: string, extra = ''): void {
    const cur = store.get(positionId);
    if (!cur || cur.closed_at !== null) return;
    const closedAt = clock.now();
    const closed = store.close(positionId, { closed_at: closedAt, reason: 'manual', realized_sol_net_lamports: null, rent_reclaimed_lamports: null, close_account_status: 'skipped', close_account_tx: null });
    emitClosed(closed, { position_id: positionId, closed_at: closedAt, reason: 'manual', realized_sol_net_lamports: null, rent_reclaimed_lamports: null, close_account_tx: null, close_account_status: 'skipped' });
    d.notifyOwner(`Buy did NOT land: ${shortCa(closed.ca)} ${why}. The position was closed; no tokens were received.${extra}`);
  }

  /** FIX-BUY: why a buy that delivered no tokens did not land, from the chain's own status (one getSignatureStatuses); unreadable keeps the old words. */
  async function revertWhy(sig: string): Promise<string> {
    let st: { err?: unknown } | null | undefined = null;
    try { st = (await d.chain.signatureStatuses([sig]))[0]; } catch { st = null; }
    if (st === null || st === undefined) return 'reverted on the chain';
    if (st.err === null || st.err === undefined) return 'delivered no tokens (the transaction confirmed without an error)';
    return `failed on the chain: ${chainErrorText(st.err)}`;
  }

  /** FIX-BUY: what a buy that delivered no tokens cost the wallet (the fill's own numbers), and its signature. */
  function revertCost(sig: string, fill: VerifiedBuyFill): string {
    const spent = isDigits(fill.solSpentLamports) ? BigInt(fill.solSpentLamports) : null;
    const feeOnly = spent !== null && isDigits(fill.feeLamports) && BigInt(fill.feeLamports) === spent;
    return `${spent === null ? '' : ` The transaction cost the wallet ${solExact(spent)} SOL${feeOnly ? ' (the network fee only)' : ''}.`} Tx ${sig}.`;
  }

  /** A-115: the policy stamp of a manual position: the card plan (its policy id, version and the snapshot; the basis is the first quote after
   *  the fill, as for EA), or the owner's orders exactly as before. */
  function planFields(plan: ExitPlanSnapshot | null | undefined): Partial<StoredPosition> & { policy_id: string; policy_version: string | null } {
    return plan !== null && plan !== undefined ? { policy_id: plan.policy.id, policy_version: plan.policy.version, exit_plan: plan } : { policy_id: 'MANUAL', policy_version: null };
  }

  function openManual(a: { sig: string; w: { walletId: string; owner: string }; ca: string; sol: number; tokens: bigint; plan?: ExitPlanSnapshot | null }): StoredPosition {
    const now = clock.now();
    const tokens = a.tokens.toString();
    const basis = Number(a.tokens) > 0 && (a.plan === null || a.plan === undefined) ? a.sol / Number(a.tokens) : null;
    const pos = store.put({
      position_id: manualPositionId(a.sig), signal_id: null, origin: 'manual', dry_run: false, ca: a.ca, wallet_id: a.w.walletId,
      arm: null, ...planFields(a.plan),
      entry: { tx: a.sig, opened_at: now, sol_spent_lamports: lamportsOf(a.sol), tokens_raw: null, fill_source: 'unverified' },
      original_tokens: tokens, tokens, basis_sol_per_token: basis !== null && Number.isFinite(basis) && basis > 0 ? basis : null,
      peak_multiple: 1, legs_done: [], leg_attempts: {}, last_quote: null, lockouts: [], ata: null,
    });
    emitOpened(pos);
    return pos;
  }

  // --- A-93f: the manual-buy journal; every signature a buy reports is settled; nothing is decided before its blockhash expired ------

  const journal: ManualBuyJournal = d.journal ?? openManualBuyJournal(d.dataDir);
  if (journal.loadError !== null) log(`manual: ${MANUAL_BUYS_FILE} could not be read (${journal.loadError}); a copy was kept aside`, 'err');
  const retryMs = d.settleRetryMs ?? MANUAL_SETTLE_RETRY_MS;
  const timers = new Set<TimerHandle>();
  const settling = new Set<string>();
  let stopped = false;

  /** The chain as one journalled buy sees it: the balance is what THIS buy may have added (other open positions of the token in the
   *  same wallet are subtracted), so a duplicate buy is never sized from the tokens of an earlier one. */
  function chainFor(rec: ManualBuyRecord): RecoveryRpc {
    const id = manualPositionId(rec.sig);
    return {
      async getSignatureStatuses(sigs) {
        return (await d.chain.signatureStatuses(sigs)).map(s => (s === null || s === undefined ? null : { err: s.err ?? null, confirmationStatus: s.confirmationStatus ?? null }));
      },
      getBlockHeight: () => d.chain.blockHeight(),
      async getSplTokenBalance(owner, mint) {
        const b = await d.chain.tokenBalance(owner, mint);
        if (b === null || !Number.isSafeInteger(b.rawAtoms) || b.rawAtoms < 0) return null;
        const others = store.findOpen(mint, rec.wallet_id)
          .filter(p => p.position_id !== id && !p.dry_run && isDigits(p.tokens)).reduce((s, p) => s + BigInt(p.tokens), 0n);
        const rest = BigInt(b.rawAtoms) - others;
        return { rawAtoms: rest > 0n ? rest : 0n };
      },
    };
  }

  /** The journal entry of a signature; a router that sent without onSigned gets one now (its blockhash bound is then an estimate). */
  async function recordOf(sig: string, w: { walletId: string; owner: string }, ca: string, sol: number, plan?: ExitPlanSnapshot | null): Promise<ManualBuyRecord> {
    const have = journal.get(sig);
    if (have !== undefined) return have;
    let lvbh = Number.MAX_SAFE_INTEGER;
    try { const h = await d.chain.blockHeight(); if (Number.isFinite(h)) lvbh = h + 151; } catch { /* unknown: never treated as expired */ }
    const rec: ManualBuyRecord = { sig, ca, wallet_id: w.walletId, owner: w.owner, sol, last_valid_block_height: lvbh, submitted_at: clock.now(), quote_tokens: null,
      ...(plan !== null && plan !== undefined ? { exit_plan: plan } : {}) };
    try { journal.add(rec); } catch (e) { log(`manual: the buy ${sig.slice(0, 8)}.. could not be journalled (${errText(e)})`, 'err'); }
    return rec;
  }

  /** A verified fill: open the position from it, or replace the quote on the position the buy opened at once. */
  async function applyFill(rec: ManualBuyRecord, fill: VerifiedBuyFill, quoteTokens: bigint | null): Promise<void> {
    const id = manualPositionId(rec.sig);
    const cur = store.get(id);
    if (!isDigits(fill.tokensRaw) || BigInt(fill.tokensRaw) <= 0n) {
      // FIX-BUY: the owner reads why (the chain's status error) and what it cost (the fill), not only that it did not land
      if (cur && cur.closed_at === null) dropPhantom(id, await revertWhy(rec.sig), revertCost(rec.sig, fill));
      return;
    }
    if (cur === undefined) {
      // the buy landed but no position exists yet (the router reported a failure after sending): open it from the real fill
      const pos = store.put({
        position_id: id, signal_id: null, origin: 'manual', dry_run: false, ca: rec.ca, wallet_id: rec.wallet_id,
        arm: null, ...planFields(rec.exit_plan),
        entry: { tx: rec.sig, opened_at: Number.isFinite(fill.confirmedAt) ? fill.confirmedAt : clock.now(), sol_spent_lamports: isDigits(fill.solSpentLamports) ? fill.solSpentLamports : lamportsOf(rec.sol), tokens_raw: fill.tokensRaw, fill_source: 'tx_meta' },
        original_tokens: fill.tokensRaw, tokens: fill.tokensRaw, basis_sol_per_token: null, peak_multiple: 1, legs_done: [], leg_attempts: {}, last_quote: null, lockouts: [], ata: null,
      });
      emitOpened(pos);
      return;
    }
    if (cur.closed_at !== null) return;
    const spent = isDigits(fill.solSpentLamports) ? fill.solSpentLamports : cur.entry.sol_spent_lamports;
    const patch: Partial<StoredPosition> = { entry: { ...cur.entry, sol_spent_lamports: spent, tokens_raw: fill.tokensRaw, fill_source: 'tx_meta' } };
    // the holding is replaced by the real amount only while nobody has sold from it since (the exit engine may have)
    if (quoteTokens !== null && cur.tokens === quoteTokens.toString() && cur.original_tokens === cur.tokens) {
      patch.tokens = fill.tokensRaw;
      patch.original_tokens = fill.tokensRaw;
      if (spent !== null && Number(fill.tokensRaw) > 0 && cur.exit_plan === undefined) {   // a plan position keeps the first-quote basis
        const basis = Number(spent) / LAMPORTS / Number(fill.tokensRaw);
        if (Number.isFinite(basis) && basis > 0) patch.basis_sol_per_token = basis;
      }
    }
    store.update(id, patch);
  }

  /** The buy landed (or the wallet shows it) but its meta is unreadable: the position comes from the wallet balance, fill unverified. */
  function adopt(rec: ManualBuyRecord, atoms: bigint): void {
    const id = manualPositionId(rec.sig);
    const cur = store.get(id);
    const tokens = atoms.toString();
    const basis = rec.sol / Number(atoms);
    const basisOk = Number.isFinite(basis) && basis > 0 && rec.exit_plan === undefined ? basis : null;
    if (cur === undefined) {
      const pos = store.put({
        position_id: id, signal_id: null, origin: 'manual', dry_run: false, ca: rec.ca, wallet_id: rec.wallet_id,
        arm: null, ...planFields(rec.exit_plan),
        entry: { tx: rec.sig, opened_at: rec.submitted_at, sol_spent_lamports: lamportsOf(rec.sol), tokens_raw: null, fill_source: 'unverified' },
        original_tokens: tokens, tokens, basis_sol_per_token: basisOk, peak_multiple: 1, legs_done: [], leg_attempts: {}, last_quote: null, lockouts: [], ata: null,
      });
      emitOpened(pos);
      d.notifyOwner(`A buy of ${shortCa(rec.ca)} (${rec.sig}) landed but its fill could not be read: the position was opened from the wallet balance (not verified), and its exits run. Check it in /positions.`);
      return;
    }
    // the position the buy opened from its quote: the wallet says what really arrived, while nothing was sold from it yet
    if (cur.closed_at === null && cur.entry.fill_source === 'unverified' && cur.tokens === cur.original_tokens && cur.tokens !== tokens) {
      store.update(id, { tokens, original_tokens: tokens, ...(basisOk !== null ? { basis_sol_per_token: basisOk } : {}) });
    }
  }

  function later(rec: ManualBuyRecord, streak: number, rereadFill: boolean): void {
    if (stopped) return;
    const h = clock.setTimeout(() => {
      timers.delete(h);
      const next = rereadFill ? settleBuys([rec]) : resolveUnverified(rec, streak);
      next.catch(e => log(`manual: settling ${rec.sig.slice(0, 8)}.. failed (${errText(e)})`, 'warn'));
    }, retryMs);
    timers.add(h);
  }

  /**
   * The meta is unreadable: ask the chain (B20 checkPending, balance first). Landed or in the wallet -> the position (from the wallet
   * balance when it does not exist yet); an error status, or a blockhash that EXPIRED with nothing on chain -> it did not land (a phantom
   * position is closed); anything else (the blockhash is still valid, the RPC is down) -> look again later, never decide early.
   */
  async function resolveUnverified(rec: ManualBuyRecord, streak: number): Promise<void> {
    const id = manualPositionId(rec.sig);
    let v: PendingVerdict;
    try { v = await checkPending(rec, chainFor(rec), { balanceFirst: true, expiredUnknownStreak: streak }); } catch { v = { kind: 'wait', expiredUnknownStreak: streak }; }
    if (v.kind === 'failed') {
      const cur = store.get(id);
      if (cur && cur.closed_at === null) dropPhantom(id, v.reason.includes('failed on chain') ? 'failed on the chain' : 'never reached the chain before its blockhash expired');
      else log(`manual: the buy ${rec.sig.slice(0, 8)}.. of ${shortCa(rec.ca)} did not land (${v.reason})`, 'warn');
      journal.remove(rec.sig);
      return;
    }
    if (v.kind === 'adopt') { adopt(rec, v.rawAtoms); journal.remove(rec.sig); return; }
    if (v.kind === 'landed') {
      let atoms: bigint | null = null;
      try {
        const b = await chainFor(rec).getSplTokenBalance(rec.owner, rec.ca);
        atoms = b === null ? null : BigInt(b.rawAtoms as bigint);
      } catch { atoms = null; }
      if (atoms !== null && atoms > 0n) { adopt(rec, atoms); journal.remove(rec.sig); return; }
      const cur = store.get(id);
      if (cur && cur.closed_at === null) { journal.remove(rec.sig); return; }    // the quote stands in: unknown is not a revert
      later(rec, 0, true);                                                        // confirmed, nothing readable yet: read the fill again
      return;
    }
    later(rec, v.expiredUnknownStreak, false);
  }

  /** Reads the fill of every signature first, books the verified ones, then resolves the others (so a buy whose meta is unreadable is
   *  never sized from the tokens a sibling signature delivered). */
  async function settleBuys(recs: readonly ManualBuyRecord[], quotes: ReadonlyMap<string, bigint | null> = new Map()): Promise<void> {
    const todo = recs.filter(r => !settling.has(r.sig));
    for (const r of todo) settling.add(r.sig);
    try {
      const read = await Promise.all(todo.map(async r => {
        let fill: Awaited<ReturnType<FillReader['buyFill']>> = 'unverified';
        try { fill = await d.fills.buyFill(r.sig, r.owner, r.ca); } catch { fill = 'unverified'; }
        return { r, fill };
      }));
      for (const { r, fill } of read) {
        if (fill === 'unverified') continue;
        const q = quotes.get(r.sig) ?? (r.quote_tokens !== null ? BigInt(r.quote_tokens) : null);
        try {
          await applyFill(r, fill, q);
          journal.remove(r.sig);
        } catch (e) {
          log(`manual: the fill of ${r.sig.slice(0, 8)}.. could not be booked (${errText(e)}); trying again`, 'err');
          later(r, 0, true);
        }
      }
      for (const { r, fill } of read) if (fill === 'unverified') await resolveUnverified(r, 0);
    } finally {
      for (const r of todo) settling.delete(r.sig);
    }
  }

  async function buy(a: ManualBuyArgs): Promise<ManualBuyResult> {
    const amount = parseSolAmount(a.sol);
    if (amount === null) throw new Error('Invalid buy amount');
    const w = d.wallets.get(a.walletId);
    if (!w) throw new Error('Cannot load keypair');
    if (!lock.acquire(a.walletId, a.ca, clock.now())) throw new Error('A buy for this token is already in progress on this wallet');
    try {
      // A-93f: a buy of this token sent earlier that has no position and is not resolved yet may still land: never send a second one
      const unresolved = journal.list().filter(e => e.wallet_id === a.walletId && e.ca === a.ca && store.get(manualPositionId(e.sig)) === undefined);
      if (unresolved.length > 0) {
        throw new Error(`A buy of this token sent earlier (${unresolved[0].sig.slice(0, 8)}..) is not resolved yet and may still land. Wait for it (about a minute at most) before buying again.`);
      }
      if (a.allowDupe !== true && !d.settings.duplicateBuy() && store.findOpen(a.ca, a.walletId).some(p => !p.dry_run)) {
        throw new Error('Already holding this token. Enable Duplicate Buy to override.');
      }
      // FIX-BUY: the wallet must hold the amount plus the headroom in native SOL, read now (2jeX... was sent from a wallet 0.018 SOL short and
      // reverted); an unreadable balance refuses the buy (fail closed, like auto-buy since A-129 c). Nothing is built, signed or journalled first.
      const have = await d.solLamports(w.owner).catch(() => null);
      if (have === null) throw new Error('The wallet balance could not be read, so nothing was sent. Try again.');
      const need = BigInt(lamportsOf(amount)) + BUY_SOL_HEADROOM_LAMPORTS;
      if (have < need) {
        throw new Error(`Not enough SOL: buying ${amount} SOL needs about ${solText4(need, 'ceil')} SOL (the amount plus up to 0.01 SOL for fees, the tip and new token `
          + `accounts); the wallet has ${solText4(have, 'floor')} SOL. Nothing was sent.`);
      }
      const signed: string[] = [];
      let r;
      try {
        r = await d.smartBuy(w.keypair, a.ca, amount, {
          slippageBps: a.slippageBps ?? null,
          priorityFee: a.priorityFee ?? d.settings.priorityFee(),
          antiMev: a.antiMev ?? d.settings.antiMev(),
          // A-93f: one send per buy (the router still falls back to another route while nothing was sent), journalled before the send
          singleSend: true,
          onSigned: async (s: SignedTx): Promise<void> => {
            journal.add({
              sig: s.sig, ca: a.ca, wallet_id: w.walletId, owner: w.owner, sol: amount,
              last_valid_block_height: Number.isFinite(s.lastValidBlockHeight) ? s.lastValidBlockHeight : Number.MAX_SAFE_INTEGER,
              submitted_at: clock.now(), quote_tokens: null, ...(a.exitPlan !== null && a.exitPlan !== undefined ? { exit_plan: a.exitPlan } : {}),
            });                                                                     // a throw here aborts the send
            if (!signed.includes(s.sig)) signed.push(s.sig);
          },
        });
      } catch (e) {
        // an error after a send: the buy may have landed anyway, so the chain decides (every signature is settled)
        const sigs = [...signed];
        for (const s of sigsOf(e)) if (!sigs.includes(s)) sigs.push(s);
        if (sigs.length > 0) {
          try { recordTrade(d.dataDir, w.owner, a.ca, clock.now()); } catch { /* the registry is a convenience */ }
          const recs = await Promise.all(sigs.map(s => recordOf(s, w, a.ca, amount, a.exitPlan)));
          void settleBuys(recs).catch(err => log(`manual: settling the buy of ${shortCa(a.ca)} failed (${errText(err)})`, 'warn'));
          d.notifyOwner(`A buy of ${shortCa(a.ca)} reported "${errText(e).slice(0, 80)}" after it was sent (${sigs.join(', ')}). The bot checks the chain and opens the position only if it landed.`);
        }
        throw e;
      }
      try { recordTrade(d.dataDir, w.owner, a.ca, clock.now()); } catch { /* the registry is a convenience */ }
      const all = [r.sig];
      for (const s of [...(r.sigs ?? []), ...signed]) if (!all.includes(s)) all.push(s);
      if (all.length > 1) log(`manual: the buy of ${shortCa(a.ca)} reports ${all.length} signatures; each one is settled`, 'warn');
      const recs = await Promise.all(all.map(s => recordOf(s, w, a.ca, amount, a.exitPlan)));
      const quote = r.tokensOutQuoted ?? r.tokensOut;
      if (quote !== undefined && quote > 0n) {
        let positionId: string | null = null;
        try {
          positionId = openManual({ sig: r.sig, w, ca: a.ca, sol: amount, tokens: quote, plan: a.exitPlan }).position_id;
          journal.update(r.sig, { quote_tokens: quote.toString() });
        } catch (e) {
          // the buy WAS sent: say so, never report it as failed because the books could not be written
          log(`manual: the position of ${r.sig.slice(0, 8)}.. could not be saved (${errText(e)})`, 'err');
          d.notifyOwner(`A buy of ${shortCa(a.ca)} was sent (${r.sig}) but the position could not be saved (${errText(e)}). The bot tries once more from the chain fill; check /positions.`);
        }
        void settleBuys(recs, new Map([[r.sig, quote]])).catch(e => log(`manual: fill check of ${r.sig.slice(0, 8)}.. failed (${errText(e)})`, 'warn'));
        return { sig: r.sig, positionId, tokenAmt: Number(quote), impact: 0, route: r.route };
      }
      // no quote to size the position with: the real fill (or the wallet balance) sizes it
      void settleBuys(recs).catch(e => log(`manual: fill check of ${r.sig.slice(0, 8)}.. failed (${errText(e)})`, 'warn'));
      return { sig: r.sig, positionId: null, tokenAmt: 0, impact: 0, route: r.route };
    } finally {
      lock.release(a.walletId, a.ca);
    }
  }

  /** A-93f: at boot, every manual buy still in the journal is settled again (in the background). */
  function resume(): void {
    const recs = journal.list();
    if (recs.length === 0) return;
    log(`manual: ${recs.length} manual buy${recs.length === 1 ? '' : 's'} from before the restart ${recs.length === 1 ? 'is' : 'are'} checked on the chain`, 'info');
    void settleBuys(recs).catch(e => log(`manual: resuming the journalled buys failed (${errText(e)})`, 'warn'));
  }

  function stop(): void {
    stopped = true;
    for (const h of timers) clock.clearTimeout(h);
    timers.clear();
  }

  async function sell(a: ManualSellArgs): Promise<ManualSellResult> {
    const w = d.wallets.get(a.walletId);
    if (!w) throw new Error('Cannot load keypair');
    const live = (): StoredPosition[] => store.findOpen(a.ca, a.walletId)
      .filter(p => !p.dry_run && p.close_pending === null && isDigits(p.tokens) && BigInt(p.tokens) > 0n);
    if (live().length === 0) throw new Error('No position found');
    const key = sellKey(a.ca, a.walletId);
    if (!d.mutex.tryAcquire(key)) throw new Error('A sell for this token is already in progress');
    try {
      const group = live();
      if (group.length === 0) throw new Error('No position found');
      const total = group.reduce((s, p) => s + BigInt(p.tokens), 0n);
      const pct = Math.min(100, Math.max(1, Math.round(a.pct)));
      let amount = (total * BigInt(pct)) / 100n;
      if (pct >= 100) {
        // a FULL close sells the whole on-chain balance (the tracked amount drifts: fills, fees, rounding), as the old executeSell did;
        // an unreadable balance never blocks the exit
        let bal: { rawAtoms: number } | null = null;
        try { bal = await d.chain.tokenBalance(w.owner, a.ca); } catch { bal = null; }
        if (bal !== null && bal.rawAtoms > 0 && Number.isSafeInteger(bal.rawAtoms)) amount = BigInt(bal.rawAtoms);
      }
      if (amount <= 0n) throw new Error('Nothing to sell');
      const slip = d.settings.slippage();
      const t0 = clock.now();
      const send: SmartSellFn = a.priorityFee === undefined && a.antiMev === undefined
        ? d.smartSell
        : (kp, mint, tokensIn, opts) => d.smartSell(kp, mint, tokensIn, {
          ...(a.priorityFee !== undefined ? { priorityFee: a.priorityFee } : {}), ...(a.antiMev !== undefined ? { antiMev: a.antiMev } : {}), ...opts,
        });
      // A-93f: the unresolved sells of the group (an earlier manual or exit sell that reported a failure) go into the landed-check, so a
      // sell that landed is booked instead of sold again, and a sell that may still land blocks a second one until its blockhash expires.
      const priorSigs: string[] = [];
      const priorHeights: Record<string, number> = {};
      for (const p of group) {
        for (const s of p.pending_sigs) if (!priorSigs.includes(s)) priorSigs.push(s);
        Object.assign(priorHeights, p.pending_sig_heights);
      }
      const remember = (sigs: readonly string[], heights: Readonly<Record<string, number>>): void => {
        for (const p of group) {
          const cur = store.get(p.position_id);
          if (!cur || cur.closed_at !== null) continue;
          const add = sigs.filter(s => !cur.pending_sigs.includes(s));
          if (add.length === 0) continue;
          store.update(p.position_id, { pending_sigs: [...cur.pending_sigs, ...add].slice(-MAX_PENDING_SIGS), pending_sig_heights: { ...cur.pending_sig_heights, ...heights } });
        }
      };
      const res = await runSellAttempt({ smartSell: send, fills: d.fills, chain: d.chain, clock, log }, {
        owner: w.owner, keypair: w.keypair, mint: a.ca, kind: 'tp', attemptNo: 1, tokens: amount, trackedAtoms: Number(total), sellPct: pct,
        priorSigs, priorSigHeights: priorHeights,
        slippage: { baseBps: a.slippageBps ?? slip.baseBps, smartMaxBps: slip.smartMaxBps },
        onSignature: (sig, h) => { remember([sig], h === null ? {} : { [sig]: h }); },
      });
      if (res.status === 'in_flight') {
        throw new Error('An earlier sell of this token was sent and may still land. Nothing was sent now; try again in about a minute.');
      }
      if (res.status === 'skipped') throw new Error(res.reason === 'zero_balance' ? 'The wallet holds none of this token' : 'Nothing to sell');
      if (res.status === 'failed') {
        remember(res.sigs, {});              // a send that reported a failure may still land: the next sell checks it first
        throw new Error(res.error);
      }

      // what was sold, and what it brought
      const verified = res.status === 'filled';
      let sold: bigint;
      let net: bigint | null = null;
      if (res.status === 'filled') {
        sold = res.tokensSold < total ? res.tokensSold : total;
        net = BigInt(res.fill.solOutNetLamports);
      } else if (res.via === 'balance' && res.balanceRaw !== null) {
        const bal = BigInt(Math.max(0, Math.floor(res.balanceRaw)));
        sold = total > bal ? total - bal : 0n;
      } else {
        sold = amount < total ? amount : total;
      }
      const sig = res.sig;
      const shares = allocate(sold, group.map(p => Number(p.tokens)));
      const nets = net === null ? null : allocate(net, group.map(p => Number(p.tokens)));
      const now = clock.now();
      let entrySol = 0;
      let entryKnown = true;
      let remainingAll = 0n;
      group.forEach((p, i) => {
        const cur = store.get(p.position_id);
        if (!cur || cur.closed_at !== null) return;
        const have = BigInt(cur.tokens);
        const share = shares[i] < have ? shares[i] : have;
        const remaining = have - share;
        remainingAll += remaining;
        if (cur.entry.sol_spent_lamports !== null && have > 0n) entrySol += (Number(cur.entry.sol_spent_lamports) / LAMPORTS) * (Number(share) / Number(have));
        else entryKnown = false;
        const realShare = nets === null ? null : nets[i];
        store.update(p.position_id, {
          tokens: remaining.toString(),
          real_out_lamports: (BigInt(cur.real_out_lamports) + (realShare ?? 0n)).toString(),
          sell_unverified: cur.sell_unverified || !verified,
          pending_sigs: [],
          next_due_at: now,
          ...(remaining === 0n ? { close_pending: { since: now, tries: 0, reason: 'manual' as const, close_account: true } } : {}),
        });
        const orig = BigInt(cur.original_tokens);
        emit(buildEnvelope('exit.leg', {
          position_id: cur.position_id, leg: 'MANUAL', status: verified ? 'filled' : 'filled_unconfirmed', attempt: 1,
          fraction_of_original: orig > 0n ? Math.min(1, Number(share) / Number(orig)) : 1,
          trigger_multiple: null, peak_multiple: Number.isFinite(cur.peak_multiple) ? cur.peak_multiple : null, quote_multiple: null, quote_src: null, quote_age_s: null,
          trigger_at: t0, send_at: res.sendAt, confirm_at: res.status === 'filled' ? res.confirmAt : null, tx: sig,
          sol_out_quoted_lamports: null, sol_out_real_lamports: realShare === null ? null : (realShare < 0n ? '0' : realShare.toString()), fill_multiple: null,
          error: null, dry_run: false, policy_version: MANUAL_POLICY_VERSION,
        }, { eventId: d.newEventId(), signalId: cur.signal_id, ca: cur.ca, now }));
      });
      const solOut = net === null ? null : Number(net) / LAMPORTS;
      const pnl = solOut !== null && entryKnown && entrySol > 0 ? solOut - entrySol : null;
      const entryTs = group.reduce((m, p) => Math.min(m, p.entry.opened_at), Number.POSITIVE_INFINITY);
      return {
        sig, solOut, pnl, pnlPct: pnl !== null && entrySol > 0 ? (pnl / entrySol) * 100 : null,
        closed: remainingAll === 0n, verified,
        entryTs: Number.isFinite(entryTs) ? entryTs : null, entrySol: entryKnown && entrySol > 0 ? entrySol : null, usedSlip: res.slippageBps,
      };
    } finally {
      d.mutex.release(key);
    }
  }

  return { buy, sell, resume, stop };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the app
// ---------------------------------------------------------------------------------------------------------------------------------

export interface BotApp {
  readonly config: BotConfig;
  readonly clock: Clock;
  readonly dataDir: string;
  readonly store: PositionsStoreV2;
  readonly policy: ResolvedPolicy;
  readonly engineClient: EngineClient;
  readonly valuation: Valuation;
  readonly fills: FillReader;
  readonly closeAccount: CloseAccountApi;
  readonly chain: LandedCheckDeps;
  readonly outbox: EngineOutbox;
  readonly queue: SendQueue;
  readonly inbox: Inbox;
  readonly autoBuy: AutoBuyService;
  readonly exits: ExitEngine;
  readonly intake: Intake;
  readonly events: EventsServer;
  /** R7-W6: are the six /v1/wallet link routes mounted (WALLET_LINK_ROUTES)? */
  readonly walletLinkRoutes: boolean;
  readonly engineWatch: EngineWatch;
  readonly manual: ManualTrader;
  /** What position-cleanup closes positions through: the store, plus the position.closed event the Engine must hear. */
  readonly cleanupStore: Pick<PositionsStoreV2, 'listOpen' | 'close'>;
  /** Token decimals (RPC getTokenSupply, cached); null = unknown. */
  readonly decimals: (ca: string) => Promise<number | null>;
  /** The lines the boot log prints: contract version, policy version, dry-run and auto-buy state; never a secret. */
  bootLines(): string[];
  /** The auto-buy wallet's cached buying power in SOL (null = unknown). */
  walletBalance(): number | null;
  /** The start sequence (see the file header). */
  start(): Promise<RunningBotApp>;
}

export interface RunningBotApp extends BotApp {
  /** The port the events server really listens on. */
  readonly port: number;
  stop(): Promise<void>;
}

function lazyRouter<K extends 'smartBuy' | 'smartSell'>(name: K): NonNullable<BotAppDeps[K]> {
  return (async (...args: unknown[]) => {
    const m = await import('./execution/router');
    return (m[name] as (...a: unknown[]) => unknown)(...args);
  }) as unknown as NonNullable<BotAppDeps[K]>;
}

export function createBotApp(deps: BotAppDeps): BotApp {
  const { config, dataDir } = deps;
  const clock = deps.clock ?? systemClock;
  const log: LinkLog = deps.log ?? defaultLog;
  const secret = (): string => config.SIGNAL_SHARED_SECRET;
  const newEventId = createUlidFactory(() => clock.now());
  const rpc = deps.rpc ?? defaultExecRpc();

  // --- the exit policy (no fallback policy: a missing one stops the boot) ---
  const policies = loadPolicies(deps.policiesJson ?? policiesJson);
  const policy = policies[config.EXIT_POLICY_ID as ResolvedPolicy['id']];
  if (!policy) throw new Error(`EXIT_POLICY_ID "${config.EXIT_POLICY_ID}" is not in exit-policies.json`);
  const policyVersions = (): Record<string, string> => ({ [policy.id]: policy.version });

  // --- the execution functions ---
  const smartBuy: SmartBuyFn = deps.smartBuy ?? lazyRouter('smartBuy');
  const routerSell: SmartSellFn = deps.smartSell ?? lazyRouter('smartSell');
  // exits and manual sells honour the owner's Global Settings (priority fee, Anti-MEV) like the old executeSell did; a caller's own option wins
  const smartSell: SmartSellFn = (keypair, mint, tokensIn, opts) =>
    routerSell(keypair, mint, tokensIn, { priorityFee: deps.settings.priorityFee(), antiMev: deps.settings.antiMev(), ...opts });
  const splBalance = deps.splBalance ?? (async (owner: string, mint: string) => {
    const { getSplTokenBalance } = await import('./execution/jupiter');
    return getSplTokenBalance(owner, mint);
  });
  // A-110 (R8-RDB1): the last native-balance read of a wallet, as ONE getBalance answer: its lamports (the RPC's own integer), its context slot, and
  // the bot clock at the moment the answer arrived. The heartbeat's bot_wallet is built from it, so the dashboard shows exactly what the bot read.
  let lastWalletRead: { owner: string; lamports: string; slot: number | null; readAt: Ms } | null = null;
  // The native part of the buying power: the one getBalance call the balance refresh makes (the call getSolBalance made before), commitment
  // 'confirmed' as before, now through `rpc` so the answer's context slot is kept. No second call. An answer that cannot be read counts as 0 SOL, as
  // getSolBalance did when every RPC failed (cachedBalance and rpc_ok behave as before), and records NO read: a failure is never shown as a balance.
  const nativeLamports = async (owner: string): Promise<number> => {
    try {
      const res = await rpc.call('getBalance', [owner, { commitment: 'confirmed' }]);
      const readAt = clock.now();
      const lamports = canonicalLamports(res?.value);
      if (lamports === null) return 0;
      const slot: unknown = res?.context?.slot;
      const prev = lastWalletRead;
      if (prev === null || prev.owner !== owner || readAt >= prev.readAt) {
        lastWalletRead = { owner, lamports, slot: typeof slot === 'number' && Number.isSafeInteger(slot) && slot >= 0 ? slot : null, readAt };
      }
      return Number(lamports);
    } catch (e) {
      log(`balance: getBalance failed (${redactSecrets(errMessage(e)).slice(0, 100)})`, 'warn');
      return 0;
    }
  };
  // The wSOL token account (usePreWrappedSol buying power): what getWsolBalance did, 0 when the account does not exist or the lookup fails.
  const wsolBalance = async (owner: string): Promise<number> => {
    try {
      const res = await rpc.call('getTokenAccountBalance', [deriveAta(owner, WSOL_MINT, 'token'), { commitment: 'confirmed' }]);
      return Number(res?.value?.uiAmount || 0);
    } catch {
      return 0;
    }
  };
  const walletBalanceSol = deps.walletBalanceSol ?? (async (owner: string): Promise<number | null> => {
    const [lamports, wsol] = await Promise.all([nativeLamports(owner), wsolBalance(owner)]);
    return lamports / LAMPORTS + wsol;
  });
  // FIX-BUY: the native SOL a manual buy is checked against: ONE getBalance at 'confirmed' on `rpc`, at most BUY_BALANCE_READ_MS. Anything that is
  // not an exact lamports value is null, and null refuses the buy (nativeLamports above counts a failed read as 0 for the cached balance and feeds
  // the heartbeat; this read does neither).
  const solLamports = async (owner: string): Promise<bigint | null> => {
    try {
      const res = await withTimeout(rpc.call('getBalance', [owner, { commitment: 'confirmed' }]), BUY_BALANCE_READ_MS);
      const lamports = canonicalLamports((res as { value?: unknown } | null | undefined)?.value);
      return lamports === null ? null : BigInt(lamports);
    } catch (e) {
      log(`manual buy: getBalance failed (${redactSecrets(errMessage(e)).slice(0, 100)})`, 'warn');
      return null;
    }
  };
  const fills = deps.fills ?? createFillReader({ rpc });
  const closeAccount = deps.closeAccount ?? createCloseAccountApi({ getSigner: owner => deps.wallets.byOwner(owner)?.keypair ?? null, rpc });
  const chain: LandedCheckDeps = {
    async signatureStatuses(sigs) {
      const res = await rpc.call('getSignatureStatuses', [sigs, { searchTransactionHistory: true }]);
      const v = (res as { value?: unknown } | null | undefined)?.value;
      return Array.isArray(v) ? (v as Array<{ err?: unknown; confirmationStatus?: string | null } | null>) : sigs.map(() => null);
    },
    async tokenBalance(owner, mint) {
      const b = await splBalance(owner, mint);
      return b === null ? null : { rawAtoms: b.rawAtoms };
    },
    async blockHeight() {
      const h = await rpc.call('getBlockHeight', [{ commitment: 'confirmed' }]);
      if (typeof h !== 'number' || !Number.isFinite(h)) throw new Error('block height unreadable');
      return h;
    },
  };
  const decimalsCache = new Map<string, number>();
  const decimals = deps.decimals ?? (async (ca: string): Promise<number | null> => {
    const hit = decimalsCache.get(ca);
    if (hit !== undefined) return hit;
    try {
      const r = (await rpc.call('getTokenSupply', [ca, { commitment: 'confirmed' }])) as { value?: { decimals?: unknown } } | null;
      const dec = r?.value?.decimals;
      if (typeof dec === 'number' && Number.isInteger(dec) && dec >= 0 && dec <= 18) { decimalsCache.set(ca, dec); return dec; }
    } catch { /* unknown */ }
    return null;
  });
  const onchain: ValuationDeps['onchain'] = deps.onchain ?? {
    async quoteSell(mint, tokensIn) {
      const [{ createOnchainQuoter }, { createCurveReader }] = await Promise.all([import('./execution/onchain-quote'), import('./execution/curve-state')]);
      return createOnchainQuoter({ reader: createCurveReader({ rpc }) }).quoteSell(mint, tokensIn);
    },
  };

  // --- store, link, Telegram ---
  const store = createPositionsStore({ dir: dataDir, clock, policy: { id: policy.id, version: policy.version } });
  const engineClient: EngineClient = deps.engine ?? createEngineClient({ engineUrl: config.ENGINE_URL, secret, http: deps.http });
  const inbox = createInbox({ dir: dataDir, clock, log });
  const cancelRequests = openCancelRequests(dataDir, clock);   // A-93f: cancels that arrived while their buy was pending

  // state read by the heartbeat before the pieces below exist
  let autoBuy!: AutoBuyService;
  let rpcOk = true;
  let cachedBalance: number | null = null;

  // A-110 (R8-RDB1): Telegraf's botInfo.username once launch() has fetched it, else null. A value the Engine's validator would refuse is not sent.
  const botUsernameNow = (): string | null => {
    try {
      const u = deps.botInfo?.()?.username;
      return typeof u === 'string' && BOT_USERNAME_RE.test(u) ? u : null;
    } catch {
      return null;
    }
  };
  // A-110: the default wallet's last getBalance read, only while it is still the wallet that was read (a switch of the default wallet shows null
  // until the next refresh, never the old balance under the new address). wallet_id and address come from the wallet that was read.
  const botWalletNow = (): HeartbeatFields['bot_wallet'] => {
    const r = lastWalletRead;
    const w = deps.wallets.current();
    if (r === null || w === null || w.owner !== r.owner) return null;
    return { wallet_id: w.walletId, address: r.owner, lamports: r.lamports, read_at: r.readAt, slot: r.slot };
  };

  const heartbeat = (): HeartbeatFields | null => {
    const hb = autoBuy.heartbeat();
    return {
      policy_versions: policyVersions(), autobuy: hb.autobuy, caps_used: hb.caps_used, open_positions: store.openCount(),
      tg_min_grade: deps.settings.tgMinGrade(), rpc_ok: rpcOk,
      bot_username: botUsernameNow(), bot_wallet: botWalletNow(), rpc_provider: rpcProviderLabel(config, deps.env),
    };
  };
  const outbox = createEngineOutbox({ dir: dataDir, engineUrl: config.ENGINE_URL, secret, clock, newEventId, http: deps.http, heartbeat, log });
  const queue = createSendQueue({
    clock, telegram: deps.telegram, chatId: config.TG_CHAT_ID, outbox, newEventId,
    paceMaxPer10Min: config.TG_PACE_MAX_PER_10MIN, lateMs: config.TG_LATE_MS, log,
  });
  outbox.setNotifier(text => queue.notifyOwner(text));   // A-55: after the queue exists
  const notifyOwner = (text: string): void => queue.notifyOwner(text);

  // The exit engine has no close/sell hook: this outbox forwards every event unchanged and then feeds auto-buy. The one for the exit
  // engine also tells the owner about REAL fills (a dry run stays silent: the dashboard shows it); the one for manual sells does not,
  // because the Telegram UI already answers a manual sell itself.
  const feedAutoBuy = (ev: BotToEngineEvent): void => {
    try {
      if (ev.type === 'position.closed') {
        const pos = store.get(ev.payload.position_id);
        if (pos) {
          autoBuy.onPositionClosed({
            origin: pos.origin, dryRun: pos.dry_run, entryTx: pos.entry.tx, fillSource: pos.entry.fill_source,
            realizedNetLamports: ev.payload.realized_sol_net_lamports, solSpentLamports: pos.entry.sol_spent_lamports, closedAt: ev.payload.closed_at,
          });
        }
      } else if (ev.type === 'exit.leg' && !ev.payload.dry_run && (ev.payload.status === 'filled' || ev.payload.status === 'filled_unconfirmed')) {
        autoBuy.noteSellOk();
      }
    } catch (e) {
      log(`exits: auto-buy feed failed (${errMessage(e).slice(0, 100)})`, 'warn');
    }
  };
  const quietOutbox: BotOutbox = {
    append(ev: BotToEngineEvent): void { outbox.append(ev); feedAutoBuy(ev); },
    backlog: () => outbox.backlog(),
    deadLettered: () => outbox.deadLettered(),
  };
  const exitOutbox: BotOutbox = {
    append(ev: BotToEngineEvent): void {
      quietOutbox.append(ev);
      try {
        const line = ownerLineOf(ev, store.get(ev.type === 'exit.leg' || ev.type === 'position.closed' ? ev.payload.position_id : ''));
        if (line !== null) notifyOwner(line);
      } catch (e) {
        log(`exits: owner notice failed (${errMessage(e).slice(0, 100)})`, 'warn');
      }
    },
    backlog: () => outbox.backlog(),
    deadLettered: () => outbox.deadLettered(),
  };

  // --- valuation and the exit engine ---
  const valuation = createValuation({ clock, onchain, jupQuote: deps.jupQuote, engine: engineClient, decimals, log });
  const exits = createExitEngine({
    clock, store, valuation, policies, defaultPolicyId: policy.id, smartSell, fills, closeAccount, chain,
    wallets: id => { const w = deps.wallets.get(id); return w ? { owner: w.owner, keypair: w.keypair } : null; },
    outbox: exitOutbox, newId: newEventId, notifyOwner, slippage: () => deps.settings.slippage(),
    config: {
      youngCadenceMs: config.EXIT_YOUNG_CADENCE_MS, cadenceMs: config.EXIT_CADENCE_MS, youngAgeMs: config.EXIT_YOUNG_AGE_MS,
      concurrency: config.EXIT_QUOTE_CONCURRENCY, hardRugDropPct: config.HARD_RUG_DROP_PCT,
    },
    log,
  });

  // --- auto-buy: the positions adapter (round-3 ruling 1) ---
  const positions: AutoBuyPositions = {
    openFromBuy(p: PendingBuy, fill) {
      const pos = store.openFromBuy(p, fill);
      try { recordTrade(dataDir, p.owner, p.ca, clock.now()); } catch { /* the registry is a convenience */ }
      try {
        if (applyCancelRequest(store, cancelRequests, pos.position_id)) {
          log(`autobuy: ${shortCa(p.ca)} was cancelled by the Engine while its buy was pending: the CANCEL exit starts now`, 'warn');
          return store.get(pos.position_id) ?? pos;
        }
      } catch (e) { log(`autobuy: the pending cancel of ${shortCa(p.ca)} could not be applied (${errMessage(e).slice(0, 100)})`, 'err'); }
      return pos;
    },
    openVirtual(v: VirtualBuy): PositionV2 {
      // a dry-run position needs the quote's token amount; without it nothing is opened (never a '0' stand-in)
      if (v.quote_tokens_out === null || !isDigits(v.quote_tokens_out) || BigInt(v.quote_tokens_out) <= 0n) {
        log(`autobuy: dry-run buy of ${shortCa(v.ca)} failed with reason quote_tokens_unknown (the route gave no token amount): no virtual position was opened`, 'warn');
        throw new Error('quote_tokens_unknown');
      }
      const id = 'dry_' + createHash('sha256').update(`dry:${v.signal_id}:${v.wallet_id}`, 'utf8').digest('hex').slice(0, 24);
      return store.openDryRun({
        id, signal_id: v.signal_id, ca: v.ca, wallet_id: v.wallet_id, arm: v.arm, tokens: v.quote_tokens_out, sol_in_lamports: v.sol_in_lamports, opened_at: v.opened_at,
      });
    },
    hasOpen(ca: string, walletId: string | null): boolean {
      return walletId === null ? store.listOpen().some(p => p.ca === ca) : store.findOpen(ca, walletId).length > 0;
    },
    openCount(dryRun: boolean): number {
      return store.listOpen().filter(p => p.origin === 'signal' && p.dry_run === dryRun).length;
    },
  };
  autoBuy = createAutoBuy({
    dir: dataDir, clock, env: envSnapshot(deps.env), dryRun: () => dryRunFromEnv(deps.env), smartBuy, fills,
    rpc: recoveryRpcFrom(rpc, splBalance), positions, outbox, engine: engineClient,
    wallet: { current: () => deps.wallets.current(), balanceSol: () => cachedBalance },
    settings: () => ({ buySol: deps.settings.buySol(), slippageBps: deps.settings.autoBuySlippageBps(), priorityFee: deps.settings.priorityFee(), antiMev: deps.settings.antiMev() }),
    policyVersions, signalledBy: ca => inbox.signalled(ca)?.signal_id ?? null, sessionWindowOk: now => deps.settings.sessionOk(now),
    newEventId, notifyOwner, log,
    // A-115: the owner's grade preset of a LIVE buy (null = the active policy exactly as before); presets never touch a dry run
    exitPlan: sig => (deps.settings.presets === undefined ? null : resolvePlan(deps.settings.presets(), sig.grade, policy, m => log(`autobuy: ${m}`, 'warn')).snapshot),
  });

  /** A-115: what the bot adds to a signal card at enqueue: the REAL exit plan of a buy from it, the links, the auto-buy line, the buttons. */
  const cardExtras = (sig: SignalNew, ca: string): { extras: SignalCardExtras; buttons: InlineRow[] } => {
    const presets = deps.settings.presets?.();
    const plan = presets === undefined
      ? resolvePlan({ autoSellOnSignal: true, gradePresets: { A: { mode: 'policy' }, B: { mode: 'policy' }, C: { mode: 'policy' } } }, sig.grade, policy)
      : resolvePlan(presets, sig.grade, policy);
    // the auto-buy line says what a buy from this card REALLY does (BOT_DRY_RUN, an unconfirmed live state, a pause), never only the set mode
    const ab0 = cardAutoBuy(autoBuy.heartbeat().autobuy, deps.settings.buySol());
    // A-114: while the PILOT is live every live buy is clamped to the pilot size; the card says so instead of the configured amount
    const pl = ab0.mode === 'live' ? (autoBuy.pilotCard?.() ?? null) : null;
    const ab = pl === null ? ab0 : {
      ...ab0,
      buySol: ab0.buySol === null ? null : Math.min(ab0.buySol, pl.maxSol),
      // plainTag keeps [A-Za-z0-9_ .:=-] and 60 chars: no commas
      note: `PILOT max ${String(+pl.maxSol.toFixed(9))} SOL ${pl.maxPerDay} per UTC day not go-live tested`,
    };
    return {
      extras: { playbook: plan.playbook, links: cardLinks(ca), autoBuy: ab },
      buttons: deps.settings.cardButtons?.(ca) ?? [],
    };
  };

  // --- intake and the events server ---
  const intake = createIntake({
    clock, autobuy: autoBuy, exits: createExitApi({ store, engine: exits, pendingBuy: ca => autoBuy.hasPendingBuy(ca), requests: cancelRequests, log }), outbox, tg: queue, registry: inbox,
    tgMinGrade: () => deps.settings.tgMinGrade(), newEventId,
    replayMaxAgeMs: config.TG_REPLAY_MAX_AGE_MS, lateMs: config.TG_LATE_MS, log,
    pilotLive: () => autoBuy.pilotLive(),   // A-114: the auto-bought notice says PILOT while the pilot is live
    ...(deps.settings.ownerFilter !== undefined ? { ownerFilter: () => (deps.settings.ownerFilter as () => OwnerFilterSettings)() } : {}),
    cardExtras, holdsPosition: ca => store.listOpen().some(p => p.ca === ca && !p.dry_run),
  });
  // --- the wallet link routes (R7-W6, A-99, A-104): the wallet RPC port (ONE URL: the wallet lane, or RPC_URL under the A-68 override), wrapped in the wallet
  // RPC budget with the configured values; the R7-W5 builders do the rest. Nothing here is shared with the server path above: its `rpc` is another object,
  // the budget's bucket delays wallet calls only. The builders' test-only PumpSwap route is never set.
  const walletRpcUrl = (): string | null => resolveWalletRpcUrl(config, rpcOnlyUrl(deps.env));
  const walletOps = (): WalletLinkOps => createWalletLinkOps({
    rpc: createWalletRpc({ url: walletRpcUrl }),
    budget: createRpcBudget({ dailyCallCap: config.WALLET_RPC_DAILY_CALL_CAP, maxPerSec: config.WALLET_RPC_MAX_PER_SEC }, clock),
    clock,
    settings: {
      txMaxBytes: config.WALLET_TX_MAX_BYTES, priorityMinMicrolamports: config.WALLET_PRIORITY_MIN_MICROLAMPORTS,
      priorityMaxMicrolamports: config.WALLET_PRIORITY_MAX_MICROLAMPORTS, fillPollMs: config.WALLET_FILL_POLL_MS,
    },
  });
  const walletRouter = config.WALLET_LINK_ROUTES
    ? createWalletRouter({
      handler: createWalletLinkHandler({
        clock, ops: deps.walletLink ?? walletOps(), log,
        limits: {
          txMaxBytes: config.WALLET_TX_MAX_BYTES, priorityMinMicrolamports: config.WALLET_PRIORITY_MIN_MICROLAMPORTS,
          priorityMaxMicrolamports: config.WALLET_PRIORITY_MAX_MICROLAMPORTS,
        },
      }),
    })
    : undefined;
  const events = createEventsServer({ secret, port: config.BOT_PORT, clock, inbox, intake, log, wallet: walletRouter });
  const engineWatch = createEngineWatch({
    clock, engineUrl: config.ENGINE_URL, tg: queue, http: deps.http, log,
    onBack: () => { void autoBuy.refreshArms().catch(() => undefined); },   // A-93f: an Engine that is back (or restarted) is asked again
  });
  const manual = createManualTrader({
    clock, store, wallets: deps.wallets, settings: deps.settings, smartBuy, smartSell, fills, chain, mutex: exits.mutex, outbox: quietOutbox, newEventId,
    dataDir, notifyOwner, log, solLamports,
  });
  // position-cleanup closes positions the wallet no longer holds: through here the Engine hears about it, like every other close
  const cleanupStore: BotApp['cleanupStore'] = {
    listOpen: () => store.listOpen(),
    close(id, c) {
      const closed = store.close(id, c);
      exitOutbox.append(buildEnvelope('position.closed', {
        position_id: id, closed_at: c.closed_at, reason: c.reason, realized_sol_net_lamports: c.realized_sol_net_lamports,
        rent_reclaimed_lamports: c.rent_reclaimed_lamports, close_account_tx: c.close_account_tx, close_account_status: c.close_account_status,
      }, { eventId: newEventId(), signalId: closed.signal_id, ca: closed.ca, now: clock.now() }));
      return closed;
    },
  };

  function bootLines(): string[] {
    const dry = dryRunFromEnv(deps.env);
    let engineHost = 'unknown';
    try { engineHost = new URL(config.ENGINE_URL).host; } catch { /* keep unknown */ }
    return [
      `${BRAND}: contract v${CONTRACT_VERSION}, exit policy ${policy.id}@${policy.version}`,
      `BOT_DRY_RUN ${dry ? 'on (auto-buy builds and signs but never sends; your manual trades and the exits of real positions still send)' : 'OFF (auto-buy may send once the owner has armed it live)'}`,
      autoBuy.bootLine(),
      `Engine link ${engineHost}; events endpoint 127.0.0.1:${config.BOT_PORT}; link secret ${linkHeaders(secret()) === null ? 'MISSING or too short (every event is refused)' : 'set'}`,
      `wallet link routes ${config.WALLET_LINK_ROUTES ? `on (the bot builds unsigned transactions for the Engine dashboard wallet; it signs and sends nothing for them${deps.walletLink === undefined && walletRpcUrl() === null ? '; the wallet RPC lane is NOT configured: every wallet request is refused' : ''})` : 'off'}`,
      `data folder ${dataDir}`,
    ];
  }

  async function start(): Promise<RunningBotApp> {
    for (const l of bootLines()) if (l !== autoBuy.bootLine()) log(l, l.includes('MISSING') ? 'warn' : 'info');
    autoBuy.start();                                    // logs the auto-buy line (mode, arm, confirmed_at, pause, dry run) and its env problems
    // B20 boot recovery: before the exit engine starts and before the events server accepts a single event
    try {
      const rep = await autoBuy.recover();
      if (rep.resolved > 0 || rep.waiting > 0) log(`autobuy: boot recovery resolved ${rep.resolved}, ${rep.waiting} still waiting`, 'info');
    } catch (e) {
      log(`autobuy: boot recovery failed (${errText(e)}); the journal entries stay for the next boot`, 'err');
    }
    exits.start();
    manual.resume();                                    // A-93f: manual buys left in the journal by the previous run
    // A-93f: the arm verdicts before the first event is accepted (live auto-buy decides on them), with a few immediate tries
    for (let i = 0; i < ARMS_BOOT_TRIES; i++) {
      if (await autoBuy.refreshArms().catch(() => false)) break;
    }
    const server: RunningEventsServer = await events.listen(config.BOT_PORT);
    outbox.start();
    engineWatch.start();

    // periodic work on the bot clock
    const timers: { h: TimerHandle | null }[] = [];
    let stopped = false;
    const every = (ms: number | (() => number), fn: () => Promise<unknown>): void => {
      const slot: { h: TimerHandle | null } = { h: null };
      timers.push(slot);
      const arm = (): void => {
        if (stopped) return;
        slot.h = clock.setTimeout(() => {
          slot.h = null;
          fn().catch(() => undefined).finally(arm);
        }, typeof ms === 'function' ? ms() : ms);
      };
      arm();
    };
    const refreshBalance = async (): Promise<void> => {
      const w = deps.wallets.current();
      if (w === null) { cachedBalance = null; return; }
      try {
        const b = await walletBalanceSol(w.owner);
        cachedBalance = b;
        rpcOk = b !== null;
      } catch {
        rpcOk = false;
      }
    };
    void refreshBalance();
    every(deps.balanceRefreshMs ?? BALANCE_REFRESH_MS, refreshBalance);
    every(() => (autoBuy.armsKnown() ? deps.armsRefreshMs ?? ARMS_REFRESH_MS : deps.armsRetryMs ?? ARMS_RETRY_MS), () => autoBuy.refreshArms());

    if (linkHeaders(secret()) === null) {
      notifyOwner('SIGNAL_SHARED_SECRET is missing or shorter than 32 characters: the bot refuses EVERY event from the Engine. Set the same value in Engine/.env and TG Bot/.env, restart the Engine, then restart the bot.');
    }

    const running: RunningBotApp = {
      ...app,
      port: server.port,
      async stop(): Promise<void> {
        stopped = true;
        for (const t of timers) if (t.h !== null) { clock.clearTimeout(t.h); t.h = null; }
        await engineWatch.stop();
        exits.stop();
        manual.stop();
        autoBuy.stop();
        await server.close();
        await outbox.flushNow();   // shutdown: flush what the Engine can still take, then stop
        await outbox.stop();
      },
    };
    return running;
  }

  const app: BotApp = {
    config, clock, dataDir, store, policy, engineClient, valuation, fills, closeAccount, chain, outbox, queue, inbox, autoBuy, exits, intake, events,
    walletLinkRoutes: config.WALLET_LINK_ROUTES, engineWatch, manual, cleanupStore, decimals, bootLines, walletBalance: () => cachedBalance, start,
  };
  return app;
}

/** createBotApp + the start sequence. */
export async function boot(deps: BotAppDeps): Promise<RunningBotApp> {
  return createBotApp(deps).start();
}
