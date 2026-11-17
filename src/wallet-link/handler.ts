/**
 * R7-W6 (A-99, A-104; WALLET-DASHBOARD-DESIGN 6.8, 6.5 and "Rev 3" R3-2 item 8, R3-5 g-h; B40 section 4): the logic behind the six synchronous
 * wallet link routes `POST /v1/wallet/{quote, fill, find, balances, close-quote, close-fill}`.
 *
 * The bot builds an UNSIGNED transaction for an external payer (the Engine's browser-wallet session owner, the only signer and fee payer) and reads
 * the chain. It signs nothing and sends nothing here. This file is the request/answer boundary of that link and holds no chain logic of its own:
 *
 *   1. the request body is validated with the strict validators of the frozen contract (`wallet-validate.ts`): a bad body is a 400 that never echoes
 *      input;
 *   2. the operation (`WalletLinkOps`, assembled by `createWalletLinkOps` from the R7-W5 wallet modules) runs inside the route's INTERNAL budget (quote 12 s, fill
 *      60 s, find 12 s, balances 8 s, close-quote 10 s, close-fill 60 s; `WALLET_LINK_BUDGET_MS`): on the clock's deadline the answer is the refusal
 *      `build-timeout` (a fill: `unverified`) and nothing else, so no partial bytes ever leave the bot, and the operation's signal is aborted;
 *   3. every answer is validated again with the contract's response validators, so a built quote that breaks a safety rule of the link contract
 *      never reaches the Engine or the page (`verify-failed`);
 *   4. the owner's per-trade limits are enforced HERE as well, whatever the builder did: the slippage in the bytes equals the request's, the route's own
 *      price impact is known and does not exceed `maxImpactPct` (`impact-above-limit`), the maximum spend does not exceed `maxSpendLamports` when the Engine set a
 *      cap (`amount-above-cap`; null = no cap), the bound's amount is the amount the owner typed, and the most the transaction can take does not exceed
 *      the SOL balance read in the same build (`insufficient-sol` with the exact lamport strings). The transaction size is held to WALLET_TX_MAX_BYTES and
 *      the compute-unit price to the configured range.
 *
 * `createWalletLinkOps` (bottom of the file) assembles the six operations from the R7-W5 wallet modules: the unsigned swap and close builders, the exact
 * chain reads, the find lookup and the RPC budget. The wallet RPC port itself is built in app.ts (wallet-rpc.ts: one URL, reads and simulation only) and
 * handed in, so nothing here reads the environment.
 *
 * Isolation (G-S19): everything this folder depends on is the frozen link contract, the redaction module and the R7-W5 wallet modules (pure builders,
 * no key, no signing, no send). It does not reach the positions store, auto-buy, the exit engine, the manual-buy journal, the cancel requests, the
 * launch supervisor, the send queue, Telegram or the signing execution files.
 */
import { withRpcBudget, type RpcBudget } from '../execution/rpc-budget';
import { buildUnsignedClose } from '../execution/unsigned-close';
import { buildUnsignedSwap, createWalletBuildCache } from '../execution/unsigned-swap';
import { findWalletTransactions } from '../execution/wallet-find';
import { readWalletBalances, readWalletCloseFill, readWalletFill } from '../execution/wallet-reads';
import type { WalletRpcPort } from '../execution/wallet-rpc';
import type { Clock, TimerHandle } from '../link/clock';
import { redactSecrets } from '../shared/redact';
import {
  WALLET_LINK_BUDGET_MS,
  type WalletBalancesOk, type WalletBalancesRequest, type WalletCloseFillOk, type WalletCloseFillRequest, type WalletCloseQuoteOk,
  type WalletCloseQuoteRequest, type WalletFillOk, type WalletFillRequest, type WalletFindOk, type WalletFindRequest, type WalletLinkRefusal,
  type WalletLinkRoute, type WalletQuoteOk, type WalletQuoteRequest, type WalletRefusalCode,
} from '../shared/contract/wallet-link';
import {
  validateWalletBalancesRequest, validateWalletBalancesResponse, validateWalletCloseFillRequest, validateWalletCloseFillResponse,
  validateWalletCloseQuoteRequest, validateWalletCloseQuoteResponse, validateWalletFillRequest, validateWalletFillResponse, validateWalletFindRequest,
  validateWalletFindResponse, validateWalletQuoteRequest, validateWalletQuoteResponse, WALLET_TX_BYTES_HARD_MAX,
  type WalletValidation,
} from '../shared/contract/wallet-validate';

export type { WalletLinkRoute } from '../shared/contract/wallet-link';

/** What an operation may use besides its request: the end of its route's budget and a signal that aborts when the budget is over. */
export interface WalletOpControl {
  /** The route's internal budget in ms. */
  budgetMs: number;
  /** The end of the budget on the bot clock. */
  deadlineAt: number;
  /** Aborted when the budget is over: the operation stops calling the chain. */
  signal: AbortSignal;
}

/**
 * The six operations behind the routes. Each returns the answer body of its route (`{ok:true, ...}`) or a refusal `{ok:false, code, reason}`; a thrown
 * error is an unforeseen failure (an error whose `code` is 'rpc-budget' is the wallet RPC budget, anything else is 'build-failed'). The operations build
 * and read; none of them signs or sends.
 */
export interface WalletLinkOps {
  quote(req: WalletQuoteRequest, ctl: WalletOpControl): Promise<WalletQuoteOk | WalletLinkRefusal>;
  fill(req: WalletFillRequest, ctl: WalletOpControl): Promise<WalletFillOk | WalletLinkRefusal>;
  find(req: WalletFindRequest, ctl: WalletOpControl): Promise<WalletFindOk | WalletLinkRefusal>;
  balances(req: WalletBalancesRequest, ctl: WalletOpControl): Promise<WalletBalancesOk | WalletLinkRefusal>;
  closeQuote(req: WalletCloseQuoteRequest, ctl: WalletOpControl): Promise<WalletCloseQuoteOk | WalletLinkRefusal>;
  closeFill(req: WalletCloseFillRequest, ctl: WalletOpControl): Promise<WalletCloseFillOk | WalletLinkRefusal>;
}

/** The configured limits of every wallet transaction (WALLET_TX_MAX_BYTES, WALLET_PRIORITY_MIN/MAX_MICROLAMPORTS). */
export interface WalletLinkLimits {
  /** At most WALLET_TX_BYTES_HARD_MAX (1132): no quote is larger, whatever the request allows. */
  txMaxBytes: number;
  priorityMinMicrolamports: number;
  priorityMaxMicrolamports: number;
}

export type WalletLinkLogLevel = 'info' | 'warn' | 'err';

export interface WalletLinkHandlerDeps {
  clock: Clock;
  ops: WalletLinkOps;
  limits: WalletLinkLimits;
  /** Overrides of the internal budgets in ms (default: the bot side of WALLET_LINK_BUDGET_MS). Tests only. */
  budgetMs?: Partial<Record<WalletLinkRoute, number>>;
  /** One line per request: the route, the verdict and the time. Never an address, an amount or a key. */
  log?: (msg: string, level?: WalletLinkLogLevel) => void;
}

/** The HTTP status and JSON body the route answers with. */
export interface WalletLinkResult { status: number; body: unknown }

export interface WalletLinkHandler {
  /** Validates, runs and checks one request. Never throws. */
  handle(route: WalletLinkRoute, body: unknown): Promise<WalletLinkResult>;
  /** The internal budget of a route in ms. */
  budgetOf(route: WalletLinkRoute): number;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------------------------------------------

const REASON_MAX = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Free text for a refusal: redacted first, control characters out, one line, at most 200 characters. */
function cleanReason(text: unknown): string {
  const raw = typeof text === 'string' ? text : String((text as { message?: unknown } | null | undefined)?.message ?? text);
  const t = redactSecrets(raw).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return (t === '' ? 'no reason given' : t).slice(0, REASON_MAX);
}

function refuse(code: WalletRefusalCode, reason: string): WalletLinkRefusal {
  return { ok: false, code, reason: cleanReason(reason) };
}

function errorCode(e: unknown): string | null {
  const c = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof c === 'string' ? c : null;
}

const textOf = (e: unknown): string => cleanReason(e instanceof Error ? e.message || e.name : e);

/** A thrown error as a refusal: the wallet RPC budget keeps its code, everything else is an unforeseen build failure with its redacted text. */
function refusalOfError(e: unknown): WalletLinkRefusal {
  return refuse(errorCode(e) === 'rpc-budget' ? 'rpc-budget' : 'build-failed', textOf(e));
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const secondsOf = (ms: number): string => `${Math.round(ms / 100) / 10}`.replace(/\.0$/, '');

/** The fill answer of a read that did not finish: nothing is booked, the Engine re-reads it later (a status only moves forward from unverified). */
function unverifiedFill(reason: string): WalletFillOk {
  return {
    ok: true,
    fill: {
      status: 'unverified', reason: cleanReason(reason), solDeltaLamports: null, feeLamports: null, rentPaidLamports: null,
      tokenDeltaRaw: null, decimals: null, slot: null, blockTime: null,
    },
  };
}
function unverifiedCloseFill(reason: string): WalletCloseFillOk {
  return {
    ok: true,
    fill: { status: 'unverified', reason: cleanReason(reason), solDeltaLamports: null, feeLamports: null, rentReturnedLamports: null, slot: null, blockTime: null },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the owner's limits, checked against the built answer (design R3-2)
// ---------------------------------------------------------------------------------------------------------------------------------

/** The most a buy can spend on the swap itself: the amount in (exact in) or the maximum in (exact out). A sell spends no SOL on the swap. */
function maxSpendOf(q: WalletQuoteOk['quote']): bigint {
  if (q.side === 'sell') return 0n;
  return BigInt(q.bound.kind === 'exact_in' ? q.bound.amountIn.baseUnits : q.bound.maxIn.baseUnits);
}

function priorityRangeProblem(priority: { cuPriceMicrolamports: number }, limits: WalletLinkLimits): string | null {
  const p = priority.cuPriceMicrolamports;
  return p < limits.priorityMinMicrolamports || p > limits.priorityMaxMicrolamports
    ? `the compute-unit price ${p} is outside the configured range ${limits.priorityMinMicrolamports}-${limits.priorityMaxMicrolamports} micro-lamports`
    : null;
}

/** The checks a validated quote must also pass against the request that asked for it. Null = it passes. */
function quoteAgainstRequest(req: WalletQuoteRequest, ok: WalletQuoteOk, limits: WalletLinkLimits): WalletLinkRefusal | null {
  const q = ok.quote;
  if (q.mint !== req.mint || q.side !== req.side) return refuse('verify-failed', 'the built quote is for another mint or side than the request');
  // the amount the wallet is asked to approve is the amount the owner typed
  if (req.side === 'buy' && q.bound.kind === 'exact_in' && q.bound.amountIn.baseUnits !== req.amountLamports) {
    return refuse('verify-failed', 'the built quote spends another amount than the request');
  }
  if (req.side === 'sell' && req.tokensRaw !== undefined && q.bound.kind === 'exact_in' && q.bound.amountIn.baseUnits !== req.tokensRaw) {
    return refuse('verify-failed', 'the built quote sells another token amount than the request');
  }
  if (q.bound.kind === 'exact_in' && BigInt(q.bound.amountIn.baseUnits) <= 0n) return refuse('verify-failed', 'the built quote trades nothing');
  const priority = priorityRangeProblem(q.priorityFee, limits);
  if (priority !== null) return refuse('verify-failed', priority);
  // price impact: a route whose own quote impact is above the owner's limit is refused before any byte leaves; a route that gave none
  // cannot be checked and is refused too, as the server path refuses it (A-26, A-108b)
  if (q.impactPct === null || !Number.isFinite(q.impactPct)) {
    return refuse('impact-above-limit', `the route gave no price impact, so your limit of ${req.maxImpactPct}% cannot be checked`);
  }
  if (q.impactPct > req.maxImpactPct) {
    return refuse('impact-above-limit', `the route's price impact ${q.impactPct}% is above your limit of ${req.maxImpactPct}%`);
  }
  // an optional hard cap on the maximum spend (WALLET_TRADE_MAX_SOL on the Engine; null = none)
  if (req.maxSpendLamports !== null && maxSpendOf(q) > BigInt(req.maxSpendLamports)) {
    return refuse('amount-above-cap', 'the most this trade can spend is above the cap set on the Engine');
  }
  // the most the transaction can take must be in the wallet: the balance was read in the same build
  if (BigInt(q.maxOutflowLamports) > BigInt(q.balance.lamports)) {
    return {
      ok: false, code: 'insufficient-sol', reason: cleanReason('the wallet holds less SOL than this trade can take'),
      needLamports: q.maxOutflowLamports, haveLamports: q.balance.lamports,
    };
  }
  return null;
}

/** A close quote must close what was asked for and nothing the Engine excluded. */
function closeQuoteAgainstRequest(req: WalletCloseQuoteRequest, ok: WalletCloseQuoteOk, limits: WalletLinkLimits): WalletLinkRefusal | null {
  const q = ok.quote;
  if (q.kind !== req.kind) return refuse('verify-failed', 'the built close is of another kind than the request');
  const excluded = new Set(req.excluded);
  if (q.accounts.some(a => excluded.has(a.account))) return refuse('verify-failed', 'the built close includes an account the Engine excluded');
  if (req.accounts !== undefined) {
    const asked = new Set(req.accounts);
    if (q.accounts.some(a => !asked.has(a.account))) return refuse('verify-failed', 'the built close includes an account that was not asked for');
  }
  const priority = priorityRangeProblem(q.priorityFee, limits);
  return priority === null ? null : refuse('verify-failed', priority);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the route table
// ---------------------------------------------------------------------------------------------------------------------------------

interface RouteSpec<Req, Ok extends { ok: true }> {
  validateRequest(body: unknown): WalletValidation<Req>;
  /** The request as the operation sees it (the transaction size capped by the configuration). */
  prepare(req: Req): Req;
  run(req: Req, ctl: WalletOpControl): Promise<Ok | WalletLinkRefusal>;
  validateAnswer(answer: unknown, req: Req): WalletValidation<Ok | WalletLinkRefusal>;
  /** The largest transaction an answer of this route may carry, when it carries one. */
  maxTxBytes?(req: Req): number;
  /** Request-versus-answer checks of a validated ok answer. */
  check(req: Req, ok: Ok): WalletLinkRefusal | null;
  /** The answer when the budget is over. */
  onTimeout(budgetMs: number): Ok | WalletLinkRefusal;
  /** The answer when the operation threw. */
  onError(e: unknown): Ok | WalletLinkRefusal;
}

function timeoutRefusal(what: string, budgetMs: number): WalletLinkRefusal {
  return refuse('build-timeout', `${what} took longer than its ${secondsOf(budgetMs)} s budget; nothing was returned`);
}

/** Before validation: a quote larger than the allowed size is the dedicated refusal, not a generic contract failure. */
function oversizeRefusal(answer: unknown, maxTxBytes: number): WalletLinkRefusal | null {
  const quote = isRecord(answer) && answer.ok === true && isRecord(answer.quote) ? answer.quote : null;
  const bytes = quote === null ? undefined : quote.txBytes;
  return typeof bytes === 'number' && bytes > maxTxBytes ? refuse('tx-too-large', `the built transaction is ${bytes} bytes; the limit is ${maxTxBytes}`) : null;
}

export function createWalletLinkHandler(deps: WalletLinkHandlerDeps): WalletLinkHandler {
  const { clock, ops, limits } = deps;
  const log = deps.log ?? ((): void => undefined);
  const capBytes = (n: number): number => Math.max(1, Math.min(n, limits.txMaxBytes, WALLET_TX_BYTES_HARD_MAX));
  const budgetOf = (route: WalletLinkRoute): number => {
    const own = deps.budgetMs?.[route];
    return typeof own === 'number' && Number.isFinite(own) && own > 0 ? own : WALLET_LINK_BUDGET_MS[route].bot;
  };

  const quote: RouteSpec<WalletQuoteRequest, WalletQuoteOk> = {
    validateRequest: validateWalletQuoteRequest,
    prepare: req => ({ ...req, maxTxBytes: capBytes(req.maxTxBytes) }),
    run: (req, ctl) => ops.quote(req, ctl),
    validateAnswer: (answer, req) => validateWalletQuoteResponse(answer, { maxTxBytes: req.maxTxBytes, slippageBps: req.slippageBps }),
    maxTxBytes: req => req.maxTxBytes,
    check: (req, ok) => quoteAgainstRequest(req, ok, limits),
    onTimeout: ms => timeoutRefusal('the build', ms),
    onError: refusalOfError,
  };
  const fill: RouteSpec<WalletFillRequest, WalletFillOk> = {
    validateRequest: validateWalletFillRequest,
    prepare: req => req,
    run: (req, ctl) => ops.fill(req, ctl),
    validateAnswer: answer => validateWalletFillResponse(answer),
    check: () => null,
    onTimeout: ms => unverifiedFill(`the transaction could not be read within ${secondsOf(ms)} s`),
    onError: e => (errorCode(e) === 'rpc-budget' ? refusalOfError(e) : unverifiedFill(`the transaction could not be read: ${textOf(e)}`)),
  };
  const find: RouteSpec<WalletFindRequest, WalletFindOk> = {
    validateRequest: validateWalletFindRequest,
    prepare: req => req,
    run: (req, ctl) => ops.find(req, ctl),
    validateAnswer: answer => validateWalletFindResponse(answer),
    check: () => null,
    onTimeout: ms => timeoutRefusal('the search', ms),
    onError: refusalOfError,
  };
  const balances: RouteSpec<WalletBalancesRequest, WalletBalancesOk> = {
    validateRequest: validateWalletBalancesRequest,
    prepare: req => req,
    run: (req, ctl) => ops.balances(req, ctl),
    validateAnswer: answer => validateWalletBalancesResponse(answer),
    check: () => null,
    onTimeout: ms => timeoutRefusal('the balance read', ms),
    onError: refusalOfError,
  };
  const closeQuote: RouteSpec<WalletCloseQuoteRequest, WalletCloseQuoteOk> = {
    validateRequest: validateWalletCloseQuoteRequest,
    prepare: req => req,
    run: (req, ctl) => ops.closeQuote(req, ctl),
    validateAnswer: answer => validateWalletCloseQuoteResponse(answer, { maxTxBytes: capBytes(WALLET_TX_BYTES_HARD_MAX) }),
    maxTxBytes: () => capBytes(WALLET_TX_BYTES_HARD_MAX),
    check: (req, ok) => closeQuoteAgainstRequest(req, ok, limits),
    onTimeout: ms => timeoutRefusal('the build', ms),
    onError: refusalOfError,
  };
  const closeFill: RouteSpec<WalletCloseFillRequest, WalletCloseFillOk> = {
    validateRequest: validateWalletCloseFillRequest,
    prepare: req => req,
    run: (req, ctl) => ops.closeFill(req, ctl),
    validateAnswer: answer => validateWalletCloseFillResponse(answer),
    check: () => null,
    onTimeout: ms => unverifiedCloseFill(`the transaction could not be read within ${secondsOf(ms)} s`),
    onError: e => (errorCode(e) === 'rpc-budget' ? refusalOfError(e) : unverifiedCloseFill(`the transaction could not be read: ${textOf(e)}`)),
  };

  async function execute<Req, Ok extends { ok: true }>(route: WalletLinkRoute, spec: RouteSpec<Req, Ok>, rawBody: unknown): Promise<WalletLinkResult> {
    const startedAt = clock.now();
    const finish = (status: number, body: unknown, verdict: string): WalletLinkResult => {
      log(`wallet link ${route}: ${verdict} in ${Math.max(0, clock.now() - startedAt)} ms`, 'info');
      return { status, body };
    };

    // 1. the strict validators of the frozen contract: a bad body is a 400 and its reason never echoes input
    const v = spec.validateRequest(rawBody);
    if (!v.ok) return finish(400, { ok: false, code: 'bad-request', reason: cleanReason(v.reason) }, 'bad-request');
    const req = spec.prepare(v.value);

    // 2. the operation inside the route's internal budget; an answer that comes later is dropped
    const budgetMs = budgetOf(route);
    const abort = new AbortController();
    const timer: { h: TimerHandle | null } = { h: null };
    const timedOut = new Promise<{ kind: 'timeout' }>(resolve => { timer.h = clock.setTimeout(() => resolve({ kind: 'timeout' }), budgetMs); });
    const ran = Promise.resolve()
      .then(() => spec.run(req, { budgetMs, deadlineAt: startedAt + budgetMs, signal: abort.signal }))
      .then(
        (answer): { kind: 'answer'; answer: unknown } => ({ kind: 'answer', answer }),
        (error: unknown): { kind: 'error'; error: unknown } => ({ kind: 'error', error }),
      );
    const outcome = await Promise.race([ran, timedOut]);
    if (timer.h !== null) clock.clearTimeout(timer.h);
    if (outcome.kind === 'timeout') {
      abort.abort();
      return finish(200, spec.onTimeout(budgetMs), 'budget over');
    }
    if (outcome.kind === 'error') {
      const a = spec.onError(outcome.error);
      return finish(200, a, a.ok ? 'unverified (the read failed)' : a.code);
    }

    // 3. the contract's response validators: nothing that breaks a rule of the link contract is handed on
    if (spec.maxTxBytes !== undefined) {
      const big = oversizeRefusal(outcome.answer, spec.maxTxBytes(req));
      if (big !== null) return finish(200, big, big.code);
    }
    const checked = spec.validateAnswer(outcome.answer, req);
    if (!checked.ok) return finish(200, refuse('verify-failed', `the answer did not pass the link contract: ${checked.reason}`), 'verify-failed');
    const answer = checked.value;
    if (!answer.ok) return finish(200, answer, answer.code);

    // 4. the owner's limits against the answer
    const problem = spec.check(req, answer);
    if (problem !== null) return finish(200, problem, problem.code);
    return finish(200, answer, 'ok');
  }

  async function handle(route: WalletLinkRoute, body: unknown): Promise<WalletLinkResult> {
    try {
      switch (route) {
        case 'quote': return await execute(route, quote, body);
        case 'fill': return await execute(route, fill, body);
        case 'find': return await execute(route, find, body);
        case 'balances': return await execute(route, balances, body);
        case 'closeQuote': return await execute(route, closeQuote, body);
        case 'closeFill': return await execute(route, closeFill, body);
        default: return { status: 404, body: { ok: false, code: 'bad-request', reason: 'unknown wallet route' } };
      }
    } catch (e) {
      // the pipeline above does not throw; this keeps the promise that handle() never does
      log(`wallet link ${route}: internal error (${textOf(e)})`, 'err');
      return { status: 200, body: refuse('build-failed', 'internal error') };
    }
  }

  return { handle, budgetOf };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the operations, assembled from the R7-W5 wallet modules
// ---------------------------------------------------------------------------------------------------------------------------------

/** How long after a buy quote the owner's token account for that mint is left alone by a close (design 5.4, the fresh-buy grace). */
export const FRESH_BUY_GRACE_MS = 90_000;

export interface WalletLinkOpsSettings {
  /** WALLET_TX_MAX_BYTES. */
  txMaxBytes: number;
  /** WALLET_PRIORITY_MIN_MICROLAMPORTS / WALLET_PRIORITY_MAX_MICROLAMPORTS. */
  priorityMinMicrolamports: number;
  priorityMaxMicrolamports: number;
  /** WALLET_FILL_POLL_MS. */
  fillPollMs: number;
}

export interface WalletLinkOpsDeps {
  /** The wallet RPC port of wallet-rpc.ts (one URL, reads and simulation only, commitment confirmed). */
  rpc: WalletRpcPort;
  /** The wallet RPC budget (daily cap, per owner per minute, global per-second bucket): wallet traffic only, never the server path. */
  budget: RpcBudget;
  /** The bot clock: deadlines, the fill poll sleep and the budget's bucket wait all run on it. */
  clock: Clock;
  settings: WalletLinkOpsSettings;
}

function abortedError(): Error {
  return Object.assign(new Error('the wallet request was cancelled: its budget is over'), { code: 'aborted' });
}

/** The RPC port of ONE request: budgeted for its owner, and dead once the request's budget is over (no call after an abort spends the wallet budget). */
function requestPort(d: WalletLinkOpsDeps, owner: string, signal: AbortSignal): WalletRpcPort {
  const live: WalletRpcPort = {
    call(method, params, opts) {
      if (signal.aborted) return Promise.reject(abortedError());
      return d.rpc.call(method, params, opts);
    },
  };
  // the abort check sits INSIDE the budget wrapper, i.e. after the call has waited for its token
  return withRpcBudget(live, d.budget, owner);
}

/** The bot clock for ONE request: a sleep (the fill poll, the bucket wait) ends at once when the request's budget is over. */
function requestClock(clock: Clock, signal: AbortSignal): Pick<Clock, 'now' | 'sleep'> {
  return {
    now: () => clock.now(),
    sleep: ms => new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(abortedError()); return; }
      const h = clock.setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      const onAbort = (): void => { clock.clearTimeout(h); reject(abortedError()); };
      signal.addEventListener('abort', onAbort, { once: true });
    }),
  };
}

/**
 * The six operations behind the wallet link routes. Every chain read goes through the request's own budgeted port; the builders take the owner's
 * PUBLIC key only. The server-path RPC (auto-buy, exits, fills of the bot's own positions) is never handed to anything here. Nothing in this function sets
 * a test-only route of the builders.
 */
export function createWalletLinkOps(d: WalletLinkOpsDeps): WalletLinkOps {
  const cache = createWalletBuildCache();
  const priorityRange = { minPrice: d.settings.priorityMinMicrolamports, maxPrice: d.settings.priorityMaxMicrolamports };
  // buys quoted a moment ago: a close leaves the token account of such a mint alone
  const recentBuys = new Map<string, number>();
  const buyKey = (owner: string, mint: string): string => `${owner}:${mint}`;
  const freshBuyOf = (owner: string) => (mint: string): boolean => {
    const at = recentBuys.get(buyKey(owner, mint));
    return at !== undefined && d.clock.now() - at < FRESH_BUY_GRACE_MS;
  };
  const forget = (): void => {
    const now = d.clock.now();
    for (const [k, at] of recentBuys) if (now - at >= FRESH_BUY_GRACE_MS) recentBuys.delete(k);
  };

  return {
    async quote(req, ctl) {
      const answer = await buildUnsignedSwap({
        rpc: requestPort(d, req.owner, ctl.signal), clock: requestClock(d.clock, ctl.signal), cache, priorityRange, maxTxBytes: d.settings.txMaxBytes, budgetMs: ctl.budgetMs,
      }, req);
      if (answer.ok && req.side === 'buy') { forget(); recentBuys.set(buyKey(req.owner, req.mint), d.clock.now()); }
      return answer;
    },
    fill: (req, ctl) => readWalletFill({
      rpc: requestPort(d, req.owner, ctl.signal), clock: requestClock(d.clock, ctl.signal), pollMs: d.settings.fillPollMs, timeoutMs: ctl.budgetMs,
    }, req),
    find: (req, ctl) => findWalletTransactions({ rpc: requestPort(d, req.owner, ctl.signal) }, req),
    balances: (req, ctl) => readWalletBalances({ rpc: requestPort(d, req.owner, ctl.signal), clock: requestClock(d.clock, ctl.signal) }, req),
    closeQuote: (req, ctl) => buildUnsignedClose({
      rpc: requestPort(d, req.owner, ctl.signal), clock: requestClock(d.clock, ctl.signal), priorityRange, maxTxBytes: d.settings.txMaxBytes, budgetMs: ctl.budgetMs,
      freshBuy: freshBuyOf(req.owner),
    }, req),
    closeFill: (req, ctl) => readWalletCloseFill({
      rpc: requestPort(d, req.owner, ctl.signal), clock: requestClock(d.clock, ctl.signal), pollMs: d.settings.fillPollMs, timeoutMs: ctl.budgetMs,
    }, req),
  };
}
