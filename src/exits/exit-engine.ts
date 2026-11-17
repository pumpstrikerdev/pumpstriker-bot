/**
 * exit-engine.ts (B30 rules 2, 4, 5, 6, 8, 9): the one exit engine of the bot.
 *
 * SCHEDULER. Each position carries `next_due_at`: 5 s while it is younger than EXIT_YOUNG_AGE_MS (10 min), then 15 s. A tick every
 * `tickMs` on the injected Clock picks the groups that are due. A GROUP is every open position of one (CA, wallet): the group is quoted
 * ONCE per pass (`Valuation.quote`, the bag of the whole group) and that one quote is used for every leg and every manual order of the
 * group. At most `concurrency` (4) groups run at a time; a pass longer than `passWarnMs` (15 s) logs a warning. Three passes in a row
 * without any quote alert the owner ("no price for X - exits blind").
 *
 * SIGNAL POSITIONS run the one EA policy: `evaluateExit` (C02) on SOL per token atom, basis B = the first successful quote after the fill
 * (persisted), peak persisted. A protective leg (R0, S, T, H) sells the whole remainder and skips the take-profits of that pass; several
 * take-profits on one quote are ONE sell of the summed fraction (`min(current, round(original x fraction))`). The universal -25% floor does
 * not apply to them (accepted decision 5). When the only quote is the Engine price (`engine_gmgn`), take-profit legs are skipped.
 *
 * MANUAL POSITIONS run `evaluateManual` (manual-orders.ts): the user's own SL / TP / TSL orders, the -25% floor and R0, exactly as the
 * old order and hard-stop lanes decided them, against the same one quote.
 *
 * SELLING never talks to the router directly (A-28): `runSellAttempt` (sell-runner.ts) calls the injected `smartSell` with
 * `{ singleSend: true }` and runs the landed-check before every retry. The failure policy is failure-policy.ts: take-profits get 3
 * attempts at an escalating slippage, protective legs never wait for the per-CA breaker, get the guaranteed exit (4000 bps, then the
 * 9900 bps panic leg) and 2 attempts, then `locked_out` and an owner alert. One sell at a time per (CA, wallet): the `SellMutex` is
 * shared with cancel and with the manual sells of bot.ts.
 *
 * A-93f: a lockout is a cool-down (LOCKOUT_REPROBE_MS, doubled after each failed re-probe up to LOCKOUT_REPROBE_MAX_MS, re-probed while
 * the trigger holds, cleared by a filled sell, probed at once after a restart; its owner alert is rate-limited); an attempt that sent nothing does not count (backoff + owner alert); a take-profit is never sent again while an earlier send
 * may still land (blockhash not expired); a failed CANCEL waits for the young cadence; a group whose sell is out holds no quote slot.
 *
 * REPORTING. Every leg attempt is an `exit.leg` event (all stamps, quote source and age, quoted and real SOL out, `fill_multiple`,
 * `dry_run`, `policy_version`, `error = redactSecrets(String(e?.message ?? e)).slice(0, 200)`), built with `buildEnvelope` and a ULID
 * and appended to the BotOutbox. A full exit reads the token balance, and only when it is confirmed zero asks B40 to close the account;
 * then `position.closed` carries the realized net (verified fills only; null if any leg or the entry is unverified) and the rent.
 *
 * DRY-RUN positions run the same evaluation on real quotes and report their legs with `sol_out_quoted_lamports` only. Nothing is sent.
 */
import type { Keypair } from '@solana/web3.js';
import type { BotOutbox, CloseAccountApi, FillReader, Valuation } from '../bot-contracts';
import { evaluateExit, type ExitState, type LegId, type LegSpec, type ResolvedPolicy } from '../shared/exit-policy/exit-policy';
import type { ExitLegV1, PositionClosed } from '../shared/contract/v1';
import type { Clock, TimerHandle } from '../link/clock';
import { buildEnvelope, defaultLog, errMessage, type LinkLog } from '../link/common';
import {
  afterLegFailure, createCaBreaker, createSellMutex, sellKey, LOCKOUT_REALERT_MS, LOCKOUT_REPROBE_MAX_MS, lockoutCooldownMs,
  MAX_FAILED_TX_PER_CA, NOSEND_ALERT_MS, NOSEND_BACKOFF_MAX_MS, NOSEND_REALERT_MS, type CaBreaker, type LandedCheckDeps, type SellKind, type SellMutex,
} from './failure-policy';
import { DEFAULT_HARD_RUG_DROP_PCT, evaluateManual, executionOrder, sellPctOf } from './manual-orders';
import type { PositionsStoreV2, StoredPosition } from './positions-store';
import { MAX_PENDING_SIGS } from './positions-store';
import type { PlanPolicy } from './presets';
import { runSellAttempt, type SellAttemptResult, type SellRunnerDeps, type SmartSellFn } from './sell-runner';
import type { BagQuote } from './valuation';

// ---------------------------------------------------------------------------------------------------------------------------------
// configuration and dependencies
// ---------------------------------------------------------------------------------------------------------------------------------

export interface ExitEngineConfig {
  /** EXIT_YOUNG_CADENCE_MS: the interval while a position is younger than `youngAgeMs`. */
  youngCadenceMs: number;
  /** EXIT_CADENCE_MS: the interval afterwards. */
  cadenceMs: number;
  /** EXIT_YOUNG_AGE_MS. */
  youngAgeMs: number;
  /** EXIT_QUOTE_CONCURRENCY. */
  concurrency: number;
  /** How often the scheduler looks for due groups. */
  tickMs: number;
  /** HARD_RUG_DROP_PCT, for manual positions (the EA policy carries its own R0 threshold). */
  hardRugDropPct: number;
  /** A pass longer than this logs a warning. */
  passWarnMs: number;
  /** Passes in a row without a quote before the owner is alerted. */
  blindPassesBeforeAlert: number;
  /** A sell that could not start because another sell holds the (CA, wallet) is looked at again after this long. */
  busyRetryMs: number;
  /** After a full exit, how many passes to try to confirm the empty token account before giving up on CloseAccount. */
  closeConfirmTries: number;
  /** Tokens left after a full exit below this share of the original are dust: the position closes, the account is not. */
  dustShare: number;
}

export const DEFAULT_EXIT_CONFIG: Readonly<ExitEngineConfig> = {
  youngCadenceMs: 5_000,
  cadenceMs: 15_000,
  youngAgeMs: 600_000,
  concurrency: 4,
  tickMs: 500,
  hardRugDropPct: DEFAULT_HARD_RUG_DROP_PCT,
  passWarnMs: 15_000,
  blindPassesBeforeAlert: 3,
  busyRetryMs: 1_000,
  closeConfirmTries: 3,
  dustShare: 0.01,
};

/** The leg-event `policy_version` of manual positions (they run no policy file). */
export const MANUAL_POLICY_VERSION = 'manual';
/** The key of the attempt counter that all protective legs of a position share (`PositionV2.leg_attempts`). */
export const PROTECTIVE_KEY = 'PROT';

export interface WalletRef { owner: string; keypair: Keypair }

export interface ExitEngineDeps {
  clock: Clock;
  store: PositionsStoreV2;
  valuation: Valuation;
  /** `loadPolicies(json)` of the shared exit policy file, keyed by policy id. There is no fallback policy. */
  policies: Readonly<Record<string, ResolvedPolicy>>;
  /** The policy a signal position without a policy_id uses (EXIT_POLICY_ID). */
  defaultPolicyId?: string;
  /** `smartSell` of execution/router.ts (A-28). */
  smartSell: SmartSellFn;
  fills: FillReader;
  closeAccount: CloseAccountApi;
  /** `getSignatureStatuses` + the confirmed token balance (the landed-check and the zero-balance confirmation). */
  chain: LandedCheckDeps;
  /** The wallet of a position: its address and its signer. null = unknown wallet. */
  wallets: (walletId: string) => WalletRef | null | Promise<WalletRef | null>;
  outbox: BotOutbox;
  /** `createUlidFactory(clock.now)` (A-55). */
  newId: () => string;
  /** A message for the owner's chat (`SendQueue.notifyOwner`); plain text. */
  notifyOwner: (text: string) => void;
  /** The current base slippage and the retry cap (settings.global.slippageBps and smartSlippageMax). */
  slippage: () => { baseBps: number; smartMaxBps: number };
  /** Shared with the manual sells of bot.ts when given. */
  breaker?: CaBreaker;
  mutex?: SellMutex;
  config?: Partial<ExitEngineConfig>;
  log?: LinkLog;
}

export interface PassReport { groups: number; durationMs: number }

export interface ExitEngine {
  start(): void;
  stop(): void;
  /** One scheduler pass: every due group not already running, up to the concurrency limit. Resolves when they are done. */
  runPass(): Promise<PassReport>;
  /** Guaranteed exit of one signal position (leg CANCEL). 'done' = nothing is left to do; 'pending' = it will be retried by the passes. */
  cancelPosition(positionId: string): Promise<'done' | 'pending'>;
  /** Closes a position the chain no longer holds (reason external_sell, realized null). */
  closeExternal(positionId: string): Promise<void>;
  readonly breaker: CaBreaker;
  readonly mutex: SellMutex;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// pure helpers (exported for the tests)
// ---------------------------------------------------------------------------------------------------------------------------------

const E12 = 1_000_000_000_000n;

/** `round(original x fraction)` in exact integer arithmetic (the fraction is taken to 12 decimals). */
export function scaleTokens(original: bigint, fraction: number): bigint {
  if (!(fraction > 0) || original <= 0n) return 0n;
  const f = BigInt(Math.round(Math.min(fraction, 1) * 1e12));
  return (original * f + E12 / 2n) / E12;
}

/** Share of the original already sold, from the token counts (never from a running sum that could drift). */
export function soldFractionOf(original: bigint, current: bigint): number {
  if (original <= 0n) return 1;
  const sold = original > current ? original - current : 0n;
  return Number((sold * E12) / original) / 1e12;
}

/** Splits `total` over `weights` in proportion; the last part takes the remainder, so the parts always add up to `total`. */
export function allocate(total: bigint, weights: readonly number[]): bigint[] {
  if (weights.length === 0) return [];
  const w = weights.map(x => (Number.isFinite(x) && x > 0 ? BigInt(Math.round(x * 1e12)) : 0n));
  let sum = w.reduce((a, b) => a + b, 0n);
  const eq = sum === 0n;
  if (eq) { w.fill(1n); sum = BigInt(w.length); }
  const out: bigint[] = [];
  let used = 0n;
  for (let i = 0; i < w.length; i++) {
    if (i === w.length - 1) out.push(total - used);
    else { const part = (total * w[i]) / sum; out.push(part); used += part; }
  }
  return out;
}

export function lamportsOf(sol: number): bigint {
  return Number.isFinite(sol) && sol > 0 ? BigInt(Math.round(sol * 1e9)) : 0n;
}

export function shortCa(ca: string): string {
  return ca.length > 10 ? `${ca.slice(0, 4)}…${ca.slice(-4)}` : ca;
}

const LEG_IDS: readonly LegId[] = ['R0', 'S', 'TP1', 'TP2', 'TP3', 'T', 'H', 'C1'];
const WIRE_LEGS: readonly string[] = ['R0', 'S', 'TP1', 'TP2', 'TP3', 'T', 'H'];
const isLegId = (s: string): s is LegId => (LEG_IDS as readonly string[]).includes(s);
/** The lockout entries that the A-93f cool-down re-probes (protective legs, the manual hard-stop lane and CANCEL; never a take-profit). */
const PROTECTIVE_LOCKOUT_IDS: readonly string[] = ['R0', 'S', 'T', 'H', 'floor', 'CANCEL'];

/** Every leg of the policy must be one the wire contract can name (ExitLegV1.leg has no C1): C1 belongs to paper arms only. */
export function policyIsReportable(p: Pick<ResolvedPolicy, 'legs'>): boolean {
  return p.legs.every(l => WIRE_LEGS.includes(l.id));
}

function triggerMultipleOf(spec: LegSpec | undefined, peak: number): number | null {
  if (!spec) return null;
  switch (spec.kind) {
    case 'take_profit':
    case 'rug_stop': return spec.atMultiple ?? null;
    case 'trail': return spec.exitAtPeakFraction !== undefined ? spec.exitAtPeakFraction * peak : null;
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the plan of one sell
// ---------------------------------------------------------------------------------------------------------------------------------

interface LegPlan {
  leg: ExitLegV1['leg'];
  /** Where the attempt counter of this leg lives (leg id, or `order:<id>`). */
  key: string;
  /** Failed attempts so far. */
  prior: number;
  /** Fraction of the ORIGINAL position this leg stands for (a take-profit: its policy fraction; otherwise the sold share). */
  fraction: number;
  triggerMultiple: number | null;
}

interface SellPlan {
  pos: StoredPosition;
  legs: LegPlan[];
  kind: SellKind;
  /** Tokens to sell (the whole remainder when `full`). */
  tokens: bigint;
  full: boolean;
  qc: QuoteCtx;
  multiple: number;
  peak: number;
  triggerAt: number;
  policyVersion: string;
  closeReason: PositionClosed['reason'];
  closeAccount: boolean;
  /** Persist the failure bookkeeping of one leg (counter, lockouts, order state). */
  onFailure(l: LegPlan, f: { failedAttempts: number; rearm: boolean; lockedOut: boolean }, error: string): void;
  /** Persist the success bookkeeping (legs done, order switched off). */
  onSuccess(): void;
}

interface QuoteCtx {
  q: BagQuote | null;
  /** SOL per token atom, null when there is no quote (a cancel without any price). */
  price: number | null;
  /** The clock at the time the group was judged. */
  t: number;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the engine
// ---------------------------------------------------------------------------------------------------------------------------------

export function createExitEngine(deps: ExitEngineDeps): ExitEngine {
  const cfg: ExitEngineConfig = { ...DEFAULT_EXIT_CONFIG, ...(deps.config ?? {}) };
  const log = deps.log ?? defaultLog;
  const store = deps.store;
  const clock = deps.clock;
  const breaker = deps.breaker ?? createCaBreaker();
  const mutex = deps.mutex ?? createSellMutex();
  const defaultPolicyId = deps.defaultPolicyId ?? 'EA';
  const sellDeps: SellRunnerDeps = { smartSell: deps.smartSell, fills: deps.fills, chain: deps.chain, clock, log };

  const inFlight = new Set<string>();
  /** A-93f: groups whose sell is out (sending or confirming). They stay in `inFlight` (one pass per group) but do not hold a quote slot,
   *  so slow sells in an RPC brownout never stop the other positions from being judged. */
  const selling = new Set<string>();
  /** A-93f: consecutive attempts of a position that sent nothing (an outage before signing): backoff and the owner alert. */
  const noSend = new Map<string, { since: number; n: number; alertedAt: number | null }>();
  /** A-93f (review): when each position last got the 🚨 lockout alert (rate-limited to LOCKOUT_REALERT_MS). */
  const lockAlertAt = new Map<string, number>();
  /** A-93f (review): positions whose pending CANCEL already ran once without using an attempt (nothing sent, still in flight, busy):
   *  from then on they follow next_due_at (their backoff), not the "always due" rule of a fresh cancel. */
  const cancelTried = new Set<string>();
  const blind = new Map<string, { passes: number; alerted: boolean }>();
  const zeroReads = new Map<string, number>();
  const closing = new Set<string>();
  const warned = new Set<string>();
  let running = false;
  let timer: TimerHandle | null = null;

  const groupKey = (p: { ca: string; wallet_id: string }): string => `${p.ca}:${p.wallet_id}`;
  const intervalFor = (pos: StoredPosition, t: number): number => (t - pos.entry.opened_at < cfg.youngAgeMs ? cfg.youngCadenceMs : cfg.cadenceMs);
  const warnOnce = (key: string, msg: string): void => { if (!warned.has(key)) { warned.add(key); log(msg, 'warn'); } };
  const fmtWait = (ms: number): string => (ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

  /** Another open LIVE position holds the same mint in the same wallet (the token account and its balance are not this position's alone). */
  function sharesWallet(pos: StoredPosition): boolean {
    return store.findOpen(pos.ca, pos.wallet_id).some(p => p.position_id !== pos.position_id && !p.dry_run);
  }

  function notify(text: string): void {
    try { deps.notifyOwner(text); } catch (e) { log(`[exits] owner notice failed: ${errMessage(e).slice(0, 100)}`, 'warn'); }
  }

  // --- events ---------------------------------------------------------------------------------------------------------------------

  function emitLeg(pos: StoredPosition, payload: ExitLegV1): void {
    try {
      deps.outbox.append(buildEnvelope('exit.leg', payload, { eventId: deps.newId(), signalId: pos.signal_id, ca: pos.ca, now: clock.now() }));
    } catch (e) { log(`[exits] exit.leg was not queued: ${errMessage(e).slice(0, 100)}`, 'err'); }
  }

  function emitClosed(pos: StoredPosition, payload: PositionClosed): void {
    try {
      deps.outbox.append(buildEnvelope('position.closed', payload, { eventId: deps.newId(), signalId: pos.signal_id, ca: pos.ca, now: clock.now() }));
    } catch (e) { log(`[exits] position.closed was not queued: ${errMessage(e).slice(0, 100)}`, 'err'); }
  }

  interface LegShare { sold: bigint; net: bigint | null; quoted: bigint | null }

  function legPayload(plan: SellPlan, l: LegPlan, status: ExitLegV1['status'], attempt: number, o: {
    share: LegShare | null; sendAt: number | null; confirmAt: number | null; tx: string | null; error: string | null; dryRun: boolean;
    basis: number | null;
  }): ExitLegV1 {
    const orig = BigInt(plan.pos.original_tokens);
    const q = plan.qc.q;
    const fraction = o.share !== null && orig > 0n ? Math.min(1, Math.max(0, Number((o.share.sold * E12) / orig) / 1e12)) : Math.min(1, Math.max(0, l.fraction));
    let fillMultiple: number | null = null;
    if (!o.dryRun && o.share !== null && o.share.net !== null && o.share.sold > 0n && o.basis !== null && o.basis > 0) {
      const perAtom = Number(o.share.net) / 1e9 / Number(o.share.sold);
      fillMultiple = Number.isFinite(perAtom) && perAtom >= 0 ? perAtom / o.basis : null;
    }
    return {
      position_id: plan.pos.position_id, leg: l.leg, status, attempt, fraction_of_original: fraction,
      trigger_multiple: l.triggerMultiple, peak_multiple: Number.isFinite(plan.peak) ? plan.peak : null,
      quote_multiple: Number.isFinite(plan.multiple) ? plan.multiple : null,
      quote_src: q ? q.src : null, quote_age_s: q ? Math.max(0, (plan.triggerAt - q.at) / 1000) : null,
      trigger_at: plan.triggerAt, send_at: o.sendAt, confirm_at: o.confirmAt, tx: o.tx,
      sol_out_quoted_lamports: o.share?.quoted !== null && o.share?.quoted !== undefined ? o.share.quoted.toString() : null,
      // The wire field is unsigned: a sale whose fee exceeded its proceeds reports 0 here (the signed net still enters the realized PnL).
      sol_out_real_lamports: o.share?.net !== null && o.share?.net !== undefined && !o.dryRun ? (o.share.net < 0n ? '0' : o.share.net.toString()) : null,
      fill_multiple: fillMultiple, error: o.error, dry_run: o.dryRun, policy_version: plan.policyVersion,
    };
  }

  /** The quoted SOL out of `tokens` at this plan's price, in lamports. */
  function quotedLamports(plan: SellPlan, tokens: bigint): bigint | null {
    if (plan.qc.price === null) return null;
    return lamportsOf(plan.qc.price * Number(tokens));
  }

  // --- the position bookkeeping ----------------------------------------------------------------------------------------------------

  function persistSignature(positionId: string, sig: string, lastValidBlockHeight: number | null): void {
    const cur = store.get(positionId);
    if (!cur || cur.pending_sigs.includes(sig)) return;
    const heights = lastValidBlockHeight === null ? cur.pending_sig_heights : { ...cur.pending_sig_heights, [sig]: lastValidBlockHeight };
    store.update(positionId, { pending_sigs: [...cur.pending_sigs, sig].slice(-MAX_PENDING_SIGS), pending_sig_heights: heights });
  }

  /** A-93f: the locked legs of this position may be probed again (the cool-down is over). */
  function reprobeDue(pos: StoredPosition, t: number): boolean {
    return pos.lockout_until !== null && t >= pos.lockout_until;
  }

  /** A-93f: an attempt that sent nothing is not an attempt. Retry with a backoff; alert the owner once it has lasted NOSEND_ALERT_MS. */
  function noteNothingSent(pos: StoredPosition, t: number, error: string): void {
    const s = noSend.get(pos.position_id) ?? { since: t, n: 0, alertedAt: null };
    s.n += 1;
    noSend.set(pos.position_id, s);
    const backoff = Math.min(cfg.youngCadenceMs * 2 ** Math.min(s.n - 1, 10), Math.max(NOSEND_BACKOFF_MAX_MS, cfg.youngCadenceMs));
    log(`[exits] ${shortCa(pos.ca)}: the sell could not be sent (nothing reached the chain): ${error.slice(0, 120)}; retrying in ${Math.round(backoff / 1000)} s`, 'warn');
    if (t - s.since >= NOSEND_ALERT_MS && (s.alertedAt === null || t - s.alertedAt >= NOSEND_REALERT_MS)) {
      s.alertedAt = t;
      notify(`⚠️ ${shortCa(pos.ca)}: an exit could not be sent for ${Math.round((t - s.since) / 60_000)} min (nothing reached the chain: ${error.slice(0, 100)}). The bot keeps retrying; check the RPC and Jupiter, or sell it by hand.`);
    }
    store.update(pos.position_id, { next_due_at: t + backoff });
  }

  // --- closing --------------------------------------------------------------------------------------------------------------------

  function realizedNet(pos: StoredPosition, rentLamports: string | null): string | null {
    if (pos.dry_run || pos.sell_unverified || pos.entry.fill_source !== 'tx_meta' || pos.entry.sol_spent_lamports === null) return null;
    let total = BigInt(pos.real_out_lamports) - BigInt(pos.entry.sol_spent_lamports);
    if (rentLamports !== null) total += BigInt(rentLamports);
    return total.toString();
  }

  function closePosition(pos: StoredPosition, c: { reason: PositionClosed['reason']; status: PositionClosed['close_account_status'];
    tx: string | null; rent: string | null; realized: string | null }): void {
    const closedAt = clock.now();
    const closed = store.close(pos.position_id, {
      closed_at: closedAt, reason: c.reason, realized_sol_net_lamports: c.realized, rent_reclaimed_lamports: c.rent,
      close_account_status: c.status, close_account_tx: c.tx,
    });
    emitClosed(closed, {
      position_id: closed.position_id, closed_at: closedAt, reason: c.reason, realized_sol_net_lamports: c.realized,
      rent_reclaimed_lamports: c.rent, close_account_tx: c.tx, close_account_status: c.status,
    });
    zeroReads.delete(pos.position_id);
  }

  /**
   * After a full exit: confirm the token account is EMPTY (a confirmed zero balance), only then ask B40 to close it, then report
   * `position.closed`. An unreadable balance is retried on the next passes; a balance left above zero keeps the position open
   * (or closes it as dust, without touching the account, when it is below `dustShare` of the original).
   */
  async function finishClose(positionId: string): Promise<void> {
    if (closing.has(positionId)) return;       // the passes and a cancel can both reach a finished exit: report it once
    closing.add(positionId);
    try { await finishCloseOnce(positionId); } finally { closing.delete(positionId); }
  }

  async function finishCloseOnce(positionId: string): Promise<void> {
    const pos = store.get(positionId);
    if (!pos || pos.closed_at !== null) return;
    const reason: PositionClosed['reason'] = pos.close_pending?.reason ?? 'policy';
    const closeAccountWanted = pos.close_pending?.close_account ?? true;
    const t = clock.now();
    if (pos.dry_run) {
      closePosition(pos, { reason, status: 'skipped', tx: null, rent: null, realized: null });
      return;
    }
    if (sharesWallet(pos)) {
      // Another open position holds this mint in this wallet: the token account is still in use, so it is not closed and its balance
      // says nothing about this position.
      closePosition(pos, { reason, status: 'skipped', tx: null, rent: null, realized: realizedNet(pos, null) });
      return;
    }
    const w = await resolveWallet(pos);
    if (!w) return;
    let bal: { rawAtoms: number } | null = null;
    try { bal = await deps.chain.tokenBalance(w.owner, pos.ca); } catch { bal = null; }
    if (bal === null) {
      const tries = (pos.close_pending?.tries ?? 0) + 1;
      if (tries >= cfg.closeConfirmTries) {
        warnOnce(`close-unknown:${pos.position_id}`, `[exits] ${shortCa(pos.ca)}: token balance unreadable after the exit; closing the position without CloseAccount`);
        closePosition(pos, { reason, status: 'skipped', tx: null, rent: null, realized: realizedNet(pos, null) });
        return;
      }
      store.update(positionId, { close_pending: { since: pos.close_pending?.since ?? t, tries, reason, close_account: closeAccountWanted }, tokens: '0',
        next_due_at: t + cfg.youngCadenceMs });
      return;
    }
    if (bal.rawAtoms > 0) {
      const orig = Number(pos.original_tokens);
      if (orig > 0 && bal.rawAtoms / orig < cfg.dustShare) {
        closePosition(pos, { reason, status: 'skipped', tx: null, rent: null, realized: realizedNet(pos, null) });
        return;
      }
      // A real amount is still held: the exit was not complete. Back to normal evaluation with what the chain says is there.
      store.update(positionId, { close_pending: null, tokens: String(bal.rawAtoms), next_due_at: t + cfg.youngCadenceMs });
      return;
    }
    // Confirmed zero balance.
    if (!closeAccountWanted) {
      closePosition(pos, { reason, status: 'skipped', tx: null, rent: null, realized: realizedNet(pos, null) });
      return;
    }
    let res: Awaited<ReturnType<CloseAccountApi['closeIfEmpty']>>;
    try {
      res = await deps.closeAccount.closeIfEmpty(w.owner, pos.ca);
    } catch (e) {
      res = { status: 'failed', tx: null, rentLamports: null, reason: errMessage(e).slice(0, 200) };
    }
    const rent = res.status === 'closed' && res.rentLamports !== null && /^\d+$/.test(res.rentLamports) ? res.rentLamports : null;
    closePosition(pos, { reason, status: res.status, tx: res.tx, rent, realized: realizedNet(pos, rent) });
  }

  async function closeExternal(positionId: string): Promise<void> {
    const pos = store.get(positionId);
    if (!pos || pos.closed_at !== null) return;
    closePosition(pos, { reason: 'external_sell', status: 'skipped', tx: null, rent: null, realized: null });
  }

  // --- the wallet -----------------------------------------------------------------------------------------------------------------

  async function resolveWallet(pos: StoredPosition): Promise<WalletRef | null> {
    try {
      const w = await deps.wallets(pos.wallet_id);
      if (w) return w;
    } catch (e) { log(`[exits] wallet lookup failed: ${errMessage(e).slice(0, 100)}`, 'warn'); }
    if (!warned.has(`wallet:${pos.position_id}`)) {
      warned.add(`wallet:${pos.position_id}`);
      notify(`⚠️ ${shortCa(pos.ca)}: the wallet of this position is not loaded, so its exits cannot be sent. Check the wallet list.`);
    }
    return null;
  }

  // --- settling one attempt -------------------------------------------------------------------------------------------------------

  async function settle(plan: SellPlan, r: SellAttemptResult, intended: bigint): Promise<void> {
    const pos0 = plan.pos;
    const t = clock.now();
    const fresh = store.get(pos0.position_id);
    if (!fresh || fresh.closed_at !== null) return;

    if (r.status === 'skipped') {
      if (r.reason === 'zero_balance') noteZeroRead(fresh, t);
      else store.update(fresh.position_id, { next_due_at: t + cfg.busyRetryMs });
      return;
    }

    if (r.status === 'in_flight') {
      // A-93f: an earlier send of this sale may still land (its blockhash is valid, or the height is unreadable): never send it twice.
      warnOnce(`inflight:${fresh.position_id}:${r.sigs[r.sigs.length - 1] ?? ''}`, `[exits] ${shortCa(fresh.ca)}: an earlier sell may still land; waiting for it (or for its blockhash to expire) before sending again`);
      store.update(fresh.position_id, { next_due_at: t + cfg.youngCadenceMs });
      if (plan.kind === 'cancel') cancelTried.add(fresh.position_id);
      return;
    }
    if (r.status === 'failed' && !r.sent) {
      noteNothingSent(fresh, t, r.error);
      // A-93f (review): a cancel that sent nothing used no attempt, so the "fresh cancel is always due" rule would re-run it on every
      // 500 ms tick; from now on it follows its backoff (next_due_at).
      if (plan.kind === 'cancel') cancelTried.add(fresh.position_id);
      return;
    }
    noSend.delete(fresh.position_id);
    cancelTried.delete(fresh.position_id);

    if (r.status === 'failed') {
      const lastSig = r.sigs.length > 0 ? r.sigs[r.sigs.length - 1] : null;
      const shares = allocate(intended, plan.legs.map(l => l.fraction));
      let anyLocked = false;
      let lockWaitMs = 0;
      let tpExhausted = false;
      plan.legs.forEach((l, i) => {
        const f = afterLegFailure(plan.kind, l.prior);
        plan.onFailure(l, f, r.error);
        if (f.lockedOut) { anyLocked = true; lockWaitMs = Math.max(lockWaitMs, lockoutCooldownMs(f.failedAttempts)); }
        if (plan.kind === 'tp' && !f.rearm) tpExhausted = true;
        emitLeg(fresh, legPayload(plan, l, f.lockedOut ? 'locked_out' : 'failed', f.failedAttempts, {
          share: { sold: shares[i], net: null, quoted: quotedLamports(plan, shares[i]) },
          sendAt: r.sendAt, confirmAt: null, tx: lastSig, error: r.error, dryRun: false, basis: fresh.basis_sol_per_token,
        }));
      });
      if (breaker.bump(fresh.ca)) {
        notify(`🛑 Circuit breaker: ${shortCa(fresh.ca)} has failed ${MAX_FAILED_TX_PER_CA} sells in a row. Take-profit sells on it are OFF until the bot restarts (protective exits stay on).`);
      }
      if (anyLocked) {
        // A-93f (review): the first lockout always alerts; a failed re-probe repeats it at most every LOCKOUT_REALERT_MS.
        const last = lockAlertAt.get(fresh.position_id);
        if (last === undefined || t - last >= LOCKOUT_REALERT_MS) {
          lockAlertAt.set(fresh.position_id, t);
          notify(`🚨 ${shortCa(fresh.ca)}: the exit failed ${plan.legs[0].prior + 1} times and auto-exit is OFF for this position for now: the bot tries once more in ${fmtWait(lockWaitMs)} if the trigger still holds (the wait doubles after each failed try, up to ${fmtWait(LOCKOUT_REPROBE_MAX_MS)}). Sell it by hand now if you can. Last error: ${r.error.slice(0, 100)}`);
        }
      } else if (tpExhausted) {
        notify(`⚠️ ${shortCa(fresh.ca)}: a take-profit sell failed ${plan.legs[0].prior + 1} times and is switched off. Last error: ${r.error.slice(0, 100)}`);
      }
      const cur = store.get(fresh.position_id);
      if (cur && cur.closed_at === null) {
        store.update(cur.position_id, { pending_sigs: r.sigs.slice(-MAX_PENDING_SIGS), next_due_at: t + cfg.youngCadenceMs });
      }
      return;
    }

    // filled / filled_unconfirmed
    const curTokens = BigInt(fresh.tokens);
    let sold: bigint;
    let remaining: bigint;
    let net: bigint | null = null;
    if (r.status === 'filled') {
      sold = r.tokensSold < curTokens ? r.tokensSold : curTokens;
      remaining = curTokens - sold;
      net = BigInt(r.fill.solOutNetLamports);
    } else if (r.via === 'balance' && r.balanceRaw !== null) {
      const bal = BigInt(Math.max(0, Math.floor(r.balanceRaw)));
      remaining = bal < curTokens ? bal : curTokens;
      sold = curTokens - remaining;
    } else {
      sold = intended < curTokens ? intended : curTokens;
      remaining = curTokens - sold;
    }
    const verified = r.status === 'filled';
    const confirmAt = r.status === 'filled' ? r.confirmAt : null;
    const shares = allocate(sold, plan.legs.map(l => l.fraction));
    const nets = net === null ? null : allocate(net, plan.legs.map(l => l.fraction));
    plan.legs.forEach((l, i) => {
      emitLeg(fresh, legPayload(plan, l, verified ? 'filled' : 'filled_unconfirmed', l.prior + 1, {
        share: { sold: shares[i], net: nets === null ? null : nets[i], quoted: quotedLamports(plan, shares[i]) },
        sendAt: r.sendAt, confirmAt, tx: r.sig, error: null, dryRun: false, basis: fresh.basis_sol_per_token,
      }));
    });
    plan.onSuccess();
    if (plan.full) lockAlertAt.delete(fresh.position_id);
    breaker.reset(fresh.ca);
    zeroReads.delete(fresh.position_id);
    const realOut = (BigInt(fresh.real_out_lamports) + (net ?? 0n)).toString();
    store.update(fresh.position_id, {
      tokens: remaining.toString(), real_out_lamports: realOut, sell_unverified: fresh.sell_unverified || !verified,
      pending_sigs: [], next_due_at: t + intervalFor(fresh, t),
    });
    if (remaining === 0n) {
      store.update(fresh.position_id, { close_pending: { since: t, tries: 0, reason: plan.closeReason, close_account: plan.closeAccount } });
      await finishClose(fresh.position_id);
    }
  }

  function noteZeroRead(pos: StoredPosition, t: number): void {
    const n = (zeroReads.get(pos.position_id) ?? 0) + 1;
    zeroReads.set(pos.position_id, n);
    if (n >= 2) {
      log(`[exits] ${shortCa(pos.ca)}: the wallet holds none of it on two readings; closing the position as an external sell`, 'warn');
      closePosition(pos, { reason: 'external_sell', status: 'skipped', tx: null, rent: null, realized: null });
      return;
    }
    store.update(pos.position_id, { next_due_at: t + cfg.youngCadenceMs });
  }

  /** The dry-run version of settle: the legs fill at the quote, nothing is sent. */
  async function settleDry(plan: SellPlan): Promise<void> {
    const t = clock.now();
    const fresh = store.get(plan.pos.position_id);
    if (!fresh || fresh.closed_at !== null) return;
    const curTokens = BigInt(fresh.tokens);
    const sold = plan.full || plan.tokens > curTokens ? curTokens : plan.tokens;
    const remaining = curTokens - sold;
    const shares = allocate(sold, plan.legs.map(l => l.fraction));
    plan.legs.forEach((l, i) => {
      emitLeg(fresh, legPayload(plan, l, 'filled', l.prior + 1, {
        share: { sold: shares[i], net: null, quoted: quotedLamports(plan, shares[i]) },
        sendAt: null, confirmAt: null, tx: null, error: null, dryRun: true, basis: fresh.basis_sol_per_token,
      }));
    });
    plan.onSuccess();
    store.update(fresh.position_id, { tokens: remaining.toString(), next_due_at: t + intervalFor(fresh, t) });
    if (remaining === 0n) {
      store.update(fresh.position_id, { close_pending: { since: t, tries: 0, reason: plan.closeReason, close_account: false } });
      await finishClose(fresh.position_id);
    }
  }

  // --- executing a plan -----------------------------------------------------------------------------------------------------------

  async function executePlan(plan: SellPlan): Promise<void> {
    const pos = plan.pos;
    if (pos.dry_run) { await settleDry(plan); return; }
    const w = await resolveWallet(pos);
    if (!w) { store.update(pos.position_id, { next_due_at: plan.triggerAt + intervalFor(pos, plan.triggerAt) }); return; }
    const key = sellKey(pos.ca, pos.wallet_id);
    if (!mutex.tryAcquire(key)) {
      store.update(pos.position_id, { next_due_at: clock.now() + cfg.busyRetryMs });
      return;
    }
    try {
      const fresh = store.get(pos.position_id);
      if (!fresh || fresh.closed_at !== null) return;
      // A cancel that another caller already worked on (the API and the passes can both reach it) is not attempted twice in a row.
      if (plan.kind === 'cancel' && (!fresh.cancel_pending || (fresh.leg_attempts.CANCEL ?? 0) !== plan.legs[0].prior)) return;
      if (fresh.tokens !== pos.tokens) {
        // The holding changed while this pass was judging it (a manual sell, an add-on buy): judge it again on the next pass.
        store.update(pos.position_id, { next_due_at: clock.now() + cfg.busyRetryMs });
        return;
      }
      let tokens = plan.tokens;
      if (plan.full) {
        // A full exit sells the whole on-chain balance (the tracked amount drifts: fills, fees, rounding), as the old executeSell did,
        // unless another open position holds the same mint in this wallet: its tokens are not this position's to sell.
        let bal: { rawAtoms: number } | null = null;
        try { bal = await deps.chain.tokenBalance(w.owner, pos.ca); } catch { bal = null; }
        if (bal !== null) {
          if (bal.rawAtoms === 0 && fresh.pending_sigs.length === 0) { noteZeroRead(fresh, clock.now()); return; }
          if (!sharesWallet(pos) && bal.rawAtoms > 0 && Number.isSafeInteger(bal.rawAtoms)) tokens = BigInt(bal.rawAtoms);
        }
      }
      const attemptNo = Math.max(0, ...plan.legs.map(l => l.prior)) + 1;
      const slip = deps.slippage();
      const trackedAtoms = Number(fresh.tokens);
      const gk = groupKey(pos);
      selling.add(gk);
      let r: SellAttemptResult;
      try {
        r = await runSellAttempt(sellDeps, {
          owner: w.owner, keypair: w.keypair, mint: pos.ca, kind: plan.kind, attemptNo, tokens,
          trackedAtoms, sellPct: trackedAtoms > 0 ? Math.min(100, (Number(tokens) / trackedAtoms) * 100) : 100,
          priorSigs: fresh.pending_sigs, priorSigHeights: fresh.pending_sig_heights, slippage: slip,
          onSignature: (sig, h) => persistSignature(pos.position_id, sig, h),
        });
      } finally {
        selling.delete(gk);
      }
      await settle(plan, r, tokens);
    } finally {
      mutex.release(key);
    }
  }

  // --- signal positions -----------------------------------------------------------------------------------------------------------

  /** A-115: the plan snapshot of the position first (a grade preset, or the policy a card buy was stamped with), else the loaded policy of its
   *  policy_id. A PRESET-* id whose snapshot is gone (a damaged file) falls back to the default policy: it keeps a stop, never runs blind. */
  function policyFor(pos: StoredPosition): PlanPolicy | ResolvedPolicy | null {
    if (pos.exit_plan !== undefined) {
      const plan = pos.exit_plan.policy;
      if (policyIsReportable(plan)) return plan;
      warnOnce(`plan-wire:${pos.position_id}`, `[exits] the exit plan of ${shortCa(pos.ca)} has a leg the wire contract cannot name; the default policy runs`);
    }
    let id = pos.policy_id ?? defaultPolicyId;
    if (id.startsWith('PRESET-') && !deps.policies[id]) {
      warnOnce(`plan-lost:${pos.position_id}`, `[exits] ${shortCa(pos.ca)} was opened with a grade preset but its plan is missing; the default policy ${defaultPolicyId} runs`);
      id = defaultPolicyId;
    }
    const p = deps.policies[id];
    if (!p) { warnOnce(`policy:${id}`, `[exits] no exit policy "${id}" is loaded; positions that use it are not evaluated (there is no fallback policy)`); return null; }
    if (!policyIsReportable(p)) { warnOnce(`policy-wire:${id}`, `[exits] policy "${id}" has a leg the wire contract cannot name; not evaluated`); return null; }
    return p;
  }

  function prevQuoteOf(pos: StoredPosition): { value: number; at: number; src: string } | null {
    const lq = pos.last_quote;
    if (!lq || pos.last_quote_tokens === null) return null;
    const tokens = Number(pos.last_quote_tokens);
    if (!(tokens > 0) || !Number.isFinite(lq.sol)) return null;
    return { value: lq.sol / tokens, at: lq.at, src: lq.src };
  }

  async function processSignal(pos: StoredPosition, qc: QuoteCtx & { q: BagQuote; price: number }): Promise<void> {
    const t = qc.t;
    const interval = intervalFor(pos, t);
    const bag = BigInt(pos.tokens);
    const policy = policyFor(pos);
    if (!policy) { store.update(pos.position_id, { next_due_at: t + interval }); return; }

    const patch: Partial<StoredPosition> = {
      next_due_at: t + interval, last_quote: { sol: qc.price * Number(bag), src: qc.q.src, at: qc.q.at }, last_quote_tokens: pos.tokens,
    };
    let basis = pos.basis_sol_per_token;
    if (basis === null || !(basis > 0)) {
      if (!(qc.price > 0)) { store.update(pos.position_id, { next_due_at: t + interval }); return; }   // a zero quote cannot become the basis
      basis = qc.price;
      patch.basis_sol_per_token = basis;
    }
    const tpIds = policy.legs.filter(l => !l.protective).map(l => l.id);
    const protectiveIds = policy.legs.filter(l => l.protective).map(l => l.id as string);
    let skip: LegId[] = pos.lockouts.filter(isLegId);
    // A-93f: a protective lockout cools down; after it the locked protective legs are probed again while their trigger holds.
    if (reprobeDue(pos, t)) skip = skip.filter(id => !protectiveIds.includes(id));
    if (qc.q.src === 'engine_gmgn' || breaker.blocks('tp', pos.ca)) skip.push(...tpIds);

    const orig = BigInt(pos.original_tokens);
    const state: ExitState = {
      basis, peak: pos.peak_multiple, legsDone: pos.legs_done.filter(isLegId), soldFractionOfOriginal: soldFractionOf(orig, bag),
      openedAt: pos.entry.opened_at, lastQuote: prevQuoteOf(pos),
    };
    const { actions, next } = evaluateExit(policy as ResolvedPolicy, state, { value: qc.price, at: qc.q.at, src: qc.q.src }, t, { skipLegs: skip });
    patch.peak_multiple = next.peak;
    if (actions.length === 0) { store.update(pos.position_id, patch); return; }

    const stored = store.update(pos.position_id, patch);
    const protective = actions.find(a => a.protective);
    const acts = protective ? [protective] : actions;
    const full = protective !== undefined;
    const intended = full ? bag : (() => { const s = scaleTokens(orig, acts.reduce((a, x) => a + x.sellFractionOfOriginal, 0)); return s < bag ? s : bag; })();
    if (intended <= 0n) {
      // A bag so small that its take-profit share rounds to nothing: there is nothing to sell, so the legs are simply done.
      store.update(pos.position_id, { legs_done: [...new Set([...stored.legs_done, ...acts.map(a => a.leg as string)])] });
      return;
    }
    const kind: SellKind = !full ? 'tp' : protective!.leg === 'R0' ? 'rug' : 'protective';
    const specs = new Map<string, LegSpec>(policy.legs.map(l => [l.id, l]));
    // Every protective leg sells the same thing (the whole remainder), so they share ONE attempt budget (PROTECTIVE_KEY): a rug
    // that fails R0 and then T has spent two attempts, not one each. A take-profit leg has its own budget.
    const legs: LegPlan[] = acts.map(a => {
      const key = a.protective ? PROTECTIVE_KEY : a.leg;
      return { leg: a.leg as ExitLegV1['leg'], key, prior: stored.leg_attempts[key] ?? 0, fraction: a.sellFractionOfOriginal,
        triggerMultiple: triggerMultipleOf(specs.get(a.leg), next.peak) };
    });
    const plan: SellPlan = {
      pos: stored, legs, kind, tokens: intended, full, qc, multiple: qc.price / basis, peak: next.peak, triggerAt: t,
      policyVersion: policy.version, closeReason: 'policy', closeAccount: policy.closeAccountOnFullExit,
      onFailure(l, f) {
        const cur = store.get(stored.position_id);
        if (!cur) return;
        const attempts = { ...cur.leg_attempts, [l.key]: f.failedAttempts };
        const lockouts = new Set(cur.lockouts);
        if (f.lockedOut) { for (const id of protectiveIds) lockouts.add(id); }
        else if (kind === 'tp' && !f.rearm) lockouts.add(l.key);
        store.update(cur.position_id, { leg_attempts: attempts, lockouts: [...lockouts], ...(f.lockedOut ? { lockout_until: clock.now() + lockoutCooldownMs(f.failedAttempts) } : {}) });
      },
      onSuccess() {
        const cur = store.get(stored.position_id);
        if (!cur) return;
        const attempts = { ...cur.leg_attempts };
        const done = new Set(cur.legs_done);
        for (const l of legs) { delete attempts[l.key]; if (!full) done.add(l.key); }
        // A protective leg is marked done only when the exit completes (the position closes); if tokens remain it fires again.
        // A-93f: a filled protective sell ends the lockout of the protective legs.
        const lockouts = full ? cur.lockouts.filter(id => !protectiveIds.includes(id)) : cur.lockouts;
        store.update(cur.position_id, { leg_attempts: attempts, legs_done: [...done], lockouts, ...(full ? { lockout_until: null } : {}) });
      },
    };
    await executePlan(plan);
  }

  // --- manual positions -----------------------------------------------------------------------------------------------------------

  async function processManual(pos: StoredPosition, qc: QuoteCtx & { q: BagQuote; price: number }): Promise<void> {
    const t = qc.t;
    const interval = intervalFor(pos, t);
    const bag = BigInt(pos.tokens);
    // A-93f: a protective order that was locked out is armed again once its cool-down is over.
    for (const o of store.ordersOf(pos.position_id)) {
      if (!o.active && o.deactivated_reason === 'locked-out' && typeof o.retry_at === 'number' && t >= o.retry_at) {
        store.updateOrder(o.order_id, { active: true, deactivated_reason: null, retry_at: null });
      }
    }
    const orders = store.activeOrdersOf(pos.position_id);
    const prev = (() => { const p = prevQuoteOf(pos); return p ? { price: p.value, at: p.at, src: p.src } : null; })();
    const ev = evaluateManual({
      basis: pos.basis_sol_per_token, floorBase: pos.floor_base, prev, orders,
      quote: { price: qc.price, at: qc.q.at, src: qc.q.src }, now: t, hardRugDropPct: cfg.hardRugDropPct,
      allowTp: qc.q.src !== 'engine_gmgn', caLocked: breaker.isLocked(pos.ca),
    });
    const patch: Partial<StoredPosition> = {
      next_due_at: t + interval, last_quote: { sol: qc.price * Number(bag), src: qc.q.src, at: qc.q.at }, last_quote_tokens: pos.tokens,
      ...ev.positionPatch,
    };
    if (Number.isFinite(ev.multi)) patch.peak_multiple = Math.max(pos.peak_multiple, ev.multi);
    for (const oe of ev.orders) if (Object.keys(oe.patch).length > 0) store.updateOrder(oe.orderId, oe.patch);
    const stored = store.update(pos.position_id, patch);
    if (!Number.isFinite(ev.multi)) return;

    const base = {
      multiple: ev.multi, peak: Math.max(stored.peak_multiple, ev.multi), triggerAt: t, policyVersion: MANUAL_POLICY_VERSION,
      closeReason: 'manual' as const, closeAccount: true, qc,
    };
    const orig = BigInt(stored.original_tokens);

    // The hard-stop lane first: it sells everything.
    if (ev.emergency && (!stored.lockouts.includes(ev.emergency.reason === 'rug' ? 'R0' : 'floor') || reprobeDue(stored, t))) {
      const rug = ev.emergency.reason === 'rug';
      const leg: LegPlan = { leg: rug ? 'R0' : 'MANUAL', key: PROTECTIVE_KEY, prior: stored.leg_attempts[PROTECTIVE_KEY] ?? 0,
        fraction: orig > 0n ? Math.min(1, Number((bag * E12) / orig) / 1e12) : 1, triggerMultiple: null };
      await executePlan({
        ...base, pos: stored, legs: [leg], kind: rug ? 'rug' : 'protective', tokens: bag, full: true,
        onFailure(l, f) {
          const cur = store.get(stored.position_id);
          if (!cur) return;
          const lockouts = new Set(cur.lockouts);
          if (f.lockedOut) { lockouts.add('R0'); lockouts.add('floor'); }
          store.update(cur.position_id, { leg_attempts: { ...cur.leg_attempts, [l.key]: f.failedAttempts }, lockouts: [...lockouts],
            ...(f.lockedOut ? { lockout_until: clock.now() + lockoutCooldownMs(f.failedAttempts) } : {}) });
        },
        onSuccess() {
          // a full exit: the position closes; a lockout of the hard-stop lane ends with a filled sell (A-93f)
          const cur = store.get(stored.position_id);
          if (cur) store.update(cur.position_id, { lockouts: cur.lockouts.filter(x => x !== 'R0' && x !== 'floor'), lockout_until: null });
        },
      });
      return;
    }

    // The order lane: the orders that fired, protective ones first.
    const firedIds = new Set(ev.orders.filter(o => o.verdict === 'fired').map(o => o.orderId));
    if (firedIds.size === 0) return;
    const fired = executionOrder(store.activeOrdersOf(stored.position_id).filter(o => firedIds.has(o.order_id)));
    for (const order of fired) {
      const cur = store.get(stored.position_id);
      if (!cur || cur.closed_at !== null) return;
      const curBag = BigInt(cur.tokens);
      if (curBag <= 0n) return;
      const pct = sellPctOf(order);
      const full = pct >= 100;
      const tokens = full ? curBag : (curBag * BigInt(Math.floor(pct * 1e6))) / 100_000_000n;
      if (tokens <= 0n) { store.updateOrder(order.order_id, { active: false, deactivated_reason: 'nothing-to-sell' }); continue; }
      const kind: SellKind = order.type === 'tp' ? 'tp' : 'protective';
      const key = `order:${order.order_id}`;
      const leg: LegPlan = { leg: 'MANUAL', key, prior: order.attempts, fraction: orig > 0n ? Math.min(1, Number((tokens * E12) / orig) / 1e12) : 1,
        triggerMultiple: null };
      await executePlan({
        ...base, pos: cur, legs: [leg], kind, tokens, full,
        onFailure(l, f, error) {
          if (f.rearm) store.updateOrder(order.order_id, { attempts: f.failedAttempts, active: true, last_failure: error });
          else store.updateOrder(order.order_id, { attempts: f.failedAttempts, active: false, last_failure: error,
            deactivated_reason: f.lockedOut ? 'locked-out' : `failed (attempt ${f.failedAttempts})`,
            ...(f.lockedOut ? { retry_at: clock.now() + lockoutCooldownMs(f.failedAttempts) } : {}) });
        },
        onSuccess() { store.updateOrder(order.order_id, { active: false, attempts: 0, deactivated_reason: 'filled' }); },
      });
    }
  }

  // --- cancel ---------------------------------------------------------------------------------------------------------------------

  async function runCancel(positionId: string): Promise<'done' | 'pending'> {
    const pos = store.get(positionId);
    if (!pos || pos.closed_at !== null) return 'done';
    const t = clock.now();
    const bag = BigInt(pos.tokens);
    if (bag <= 0n) {
      if (pos.close_pending) await finishClose(positionId);
      store.update(positionId, { cancel_pending: false });
      return 'done';
    }
    // A cancel is never skipped for lack of a quote: the quote only fills the report.
    let q: BagQuote | null = null;
    try { q = await deps.valuation.quote(pos, true); } catch { q = null; }
    const price = q && Number.isFinite(q.sol) && q.sol >= 0 ? q.sol / Number(bag) : null;
    const qc: QuoteCtx = { q: price === null ? null : q, price, t };
    const basis = pos.basis_sol_per_token;
    const policy = policyFor(pos);
    const protectiveIds = (policy?.legs ?? []).filter(l => l.protective).map(l => l.id as string);
    const orig = BigInt(pos.original_tokens);
    const leg: LegPlan = { leg: 'CANCEL', key: 'CANCEL', prior: pos.leg_attempts.CANCEL ?? 0,
      fraction: orig > 0n ? Math.min(1, Number((bag * E12) / orig) / 1e12) : 1, triggerMultiple: null };
    const plan: SellPlan = {
      pos, legs: [leg], kind: 'cancel', tokens: bag, full: true, qc,
      multiple: price !== null && basis !== null && basis > 0 ? price / basis : NaN, peak: pos.peak_multiple, triggerAt: t,
      policyVersion: pos.policy_version ?? policy?.version ?? MANUAL_POLICY_VERSION, closeReason: 'cancel', closeAccount: policy?.closeAccountOnFullExit ?? true,
      onFailure(l, f) {
        const cur = store.get(positionId);
        if (!cur) return;
        const lockouts = new Set(cur.lockouts);
        if (f.lockedOut) { lockouts.add('CANCEL'); for (const id of protectiveIds) lockouts.add(id); }
        store.update(positionId, { leg_attempts: { ...cur.leg_attempts, CANCEL: f.failedAttempts }, lockouts: [...lockouts], cancel_pending: f.rearm,
          ...(f.lockedOut ? { lockout_until: clock.now() + lockoutCooldownMs(f.failedAttempts) } : {}) });
      },
      onSuccess() {
        const cur = store.get(positionId);
        const lockouts = (cur?.lockouts ?? []).filter(x => x !== 'CANCEL' && !protectiveIds.includes(x));
        store.update(positionId, { cancel_pending: false, lockouts, lockout_until: null });
      },
    };
    await executePlan(plan);
    const after = store.get(positionId);
    return !after || after.closed_at !== null || !after.cancel_pending ? 'done' : 'pending';
  }

  async function cancelPosition(positionId: string): Promise<'done' | 'pending'> {
    const pos = store.get(positionId);
    if (!pos || pos.closed_at !== null) return 'done';
    if (!pos.cancel_pending) store.update(positionId, { cancel_pending: true });
    return runCancel(positionId);
  }

  // --- groups and passes ----------------------------------------------------------------------------------------------------------

  function noteBlind(key: string, ca: string): void {
    const b = blind.get(key) ?? { passes: 0, alerted: false };
    b.passes += 1;
    if (b.passes >= cfg.blindPassesBeforeAlert && !b.alerted) {
      b.alerted = true;
      notify(`⚠️ no price for ${shortCa(ca)} — exits blind. ${b.passes} passes in a row got no quote (chain, Jupiter, Engine). Its exits cannot fire until a price returns; check the position by hand.`);
    }
    blind.set(key, b);
  }

  async function processGroup(key: string, memberIds: string[]): Promise<void> {
    // Cancels and half-finished exits first: they need no quote.
    for (const id of memberIds) {
      const p = store.get(id);
      if (!p || p.closed_at !== null) continue;
      if (p.cancel_pending) { await runCancel(id); continue; }
      if (p.lockouts.includes('CANCEL') && reprobeDue(p, clock.now()) && BigInt(p.tokens) > 0n) {
        // A-93f: a locked-out CANCEL is probed again after its cool-down.
        store.update(id, { cancel_pending: true });
        await runCancel(id);
        continue;
      }
      if (p.close_pending) await finishClose(id);
    }
    // A-93f (review): a pending cancel that is backing off (it sent nothing, or an earlier send may still land) owns its position until
    // its next try: the regular evaluation would overwrite its backoff with the cadence (and judge legs of a position being dumped).
    const live = memberIds.map(id => store.get(id)).filter((p): p is StoredPosition => p !== undefined && p.closed_at === null && !p.close_pending
      && !(p.cancel_pending && cancelTried.has(p.position_id)) && /^\d+$/.test(p.tokens) && BigInt(p.tokens) > 0n);
    if (live.length === 0) return;
    const total = live.reduce((a, p) => a + BigInt(p.tokens), 0n);
    const agg: StoredPosition = { ...live[0], tokens: total.toString() };
    let q: BagQuote | null = null;
    try { q = await deps.valuation.quote(agg, true); } catch (e) { log(`[exits] valuation threw: ${errMessage(e).slice(0, 100)}`, 'warn'); q = null; }
    const t = clock.now();
    if (!q || !Number.isFinite(q.sol) || q.sol < 0 || !Number.isFinite(q.at)) {
      noteBlind(key, live[0].ca);
      for (const p of live) store.update(p.position_id, { next_due_at: t + intervalFor(p, t) });
      return;
    }
    blind.delete(key);
    const price = q.sol / Number(total);
    const qc = { q, price, t };
    for (const p of live) {
      const cur = store.get(p.position_id);
      if (!cur || cur.closed_at !== null || BigInt(cur.tokens) <= 0n) continue;
      try {
        // A-115: a manual-origin position with a plan (a buy from a signal card) runs its plan; other manual positions run the owner's orders
        if (cur.origin === 'manual' && cur.exit_plan === undefined) await processManual(cur, qc);
        else await processSignal(cur, qc);
      } catch (e) {
        log(`[exits] ${shortCa(cur.ca)}: pass failed: ${errMessage(e).slice(0, 160)}`, 'err');
        try { store.update(cur.position_id, { next_due_at: clock.now() + intervalFor(cur, t) }); } catch { /* the store is the thing that failed */ }
      }
    }
  }

  async function runPass(): Promise<PassReport> {
    const t0 = clock.now();
    const open = store.listOpen();
    const groups = new Map<string, { ids: string[]; due: number }>();
    for (const p of open) {
      const key = groupKey(p);
      const g = groups.get(key) ?? { ids: [], due: Number.POSITIVE_INFINITY };
      g.ids.push(p.position_id);
      // A cancel that has not failed yet is always due (a guaranteed exit does not wait for the cadence); after a failed attempt it
      // follows next_due_at (A-93f: the young cadence, not the next 500 ms tick), and so does one that already ran without using an
      // attempt (A-93f review: nothing sent, still in flight, busy: its backoff). A half-finished close honours its own next_due_at:
      // the balance read that confirms the empty account is retried on the cadence (5 s), not on every scheduler tick.
      const freshCancel = p.cancel_pending && (p.leg_attempts.CANCEL ?? 0) === 0 && !cancelTried.has(p.position_id);
      g.due = Math.min(g.due, freshCancel ? 0 : p.next_due_at);
      groups.set(key, g);
    }
    const ready = [...groups.entries()].filter(([k, g]) => g.due <= t0 && !inFlight.has(k)).sort((a, b) => a[1].due - b[1].due);
    // A-93f: a group whose sell is out does not hold a quote slot (its own pass is still running, so it is not picked again).
    const busy = [...inFlight].filter(k => !selling.has(k)).length;
    const free = Math.max(0, cfg.concurrency - busy);
    const take = ready.slice(0, free);
    for (const [k] of take) inFlight.add(k);
    await Promise.all(take.map(async ([k, g]) => {
      try {
        await processGroup(k, g.ids);
      } catch (e) {
        log(`[exits] group ${k.slice(0, 8)} failed: ${errMessage(e).slice(0, 160)}`, 'err');
      } finally {
        inFlight.delete(k);
      }
    }));
    const durationMs = clock.now() - t0;
    if (durationMs > cfg.passWarnMs) log(`[exits] a pass took ${(durationMs / 1000).toFixed(1)} s (> ${cfg.passWarnMs / 1000} s)`, 'warn');
    return { groups: take.length, durationMs };
  }

  /** A-93f: a restart probes every protective lockout at once (also the ones written before the cool-down existed). */
  function reprobeAtStart(): void {
    const t = clock.now();
    try {
      for (const p of store.listOpen()) {
        const locked = p.lockouts.some(x => PROTECTIVE_LOCKOUT_IDS.includes(x));
        if (locked && (p.lockout_until === null || p.lockout_until > t)) store.update(p.position_id, { lockout_until: t });
        for (const o of store.ordersOf(p.position_id)) {
          if (!o.active && o.deactivated_reason === 'locked-out' && (typeof o.retry_at !== 'number' || o.retry_at > t)) store.updateOrder(o.order_id, { retry_at: t });
        }
      }
    } catch (e) { log(`[exits] could not re-arm the lockouts at start: ${errMessage(e).slice(0, 120)}`, 'err'); }
  }

  function schedule(): void {
    if (!running) return;
    timer = clock.setTimeout(() => {
      timer = null;
      if (!running) return;
      void runPass().catch(e => log(`[exits] pass failed: ${errMessage(e).slice(0, 160)}`, 'err'));
      schedule();
    }, cfg.tickMs);
  }

  return {
    start() { if (running) return; running = true; reprobeAtStart(); schedule(); },
    stop() { running = false; if (timer) { clock.clearTimeout(timer); timer = null; } },
    runPass,
    cancelPosition,
    closeExternal,
    breaker,
    mutex,
  };
}
