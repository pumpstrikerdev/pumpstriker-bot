/**
 * PUMPFUN DIRECT SWAP — bypass Jupiter for pre-graduation pump.fun tokens.
 *
 * FIX-PUMP (owner decision 2026-11-06: "rebuild direct pump.fun buying"): PF-direct is ON again, with the LOCAL builder only. The bot builds
 * pump's own buy_exact_sol_in / sell for the 2026-04-28 layout itself (pumpfun-ix.ts, pump-program.ts) for classic Token and Token-2022
 * coins, verifies the exact transaction strictly and simulates it (tx-verify.ts verifyPumpDirectTx), and only then signs that same object.
 * PumpPortal is never asked for anything: its local-transaction API now wraps pump inside the FAdo9... wrapper (an
 * undocumented upgradeable program taking 0.5 %), which createTxVerifier keeps refusing, and no code path here calls it.
 *
 * Every refusal (curve, mint, quote, verifier, simulation) is thrown BEFORE signing: nothing is signed, journalled or sent, so the router
 * goes on to Jupiter in the same call, singleSend included.
 *
 * Program: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P (PumpFun v1)
 *   • buy_exact_sol_in [56, 252, 116, 8, 158, 223, 205, 95]: spendable_sol_in u64 | min_tokens_out u64 | track_volume 01 (18 accounts)
 *   • sell [51, 230, 133, 164, 1, 127, 131, 173]: amount u64 | min_sol_output u64 (16 accounts, 17 for a cashback coin)
 *   Sources: the recorded mainnet transactions pinned by pump-chain-layout.test.ts, pump-public-docs BREAKING_FEE_RECIPIENT.md, SDK 4.1.0.
 *
 * Latency path (two RPC round trips plus the send): (1) in parallel ONE getMultipleAccounts at 'processed' [bonding curve, mint, owner,
 * owner ATA under Token-2022, owner ATA under Token, user_volume_accumulator], the cached blockhash and the priority-fee estimate;
 * (2) classify, build and the static verify (pure); (3) in parallel simulateTransaction and the pre-state read; (4) sign, dispatchSigned.
 *
 * SCOPE: Pre-graduation, SOL-quoted curves only (the zero key / WSOL rule of curve-parse isSolQuoted; USDC- and coin-quoted curves are
 * refused, FIX-BUY2 item 6). After graduation the curve is complete: the router uses PumpSwap or Jupiter.
 *
 * SLIPPAGE: smart, curve-progress-aware (see smartSlippageBps below); an explicit slippageBps must be an integer from 1 to 5000.
 */
import {
  Keypair, VersionedTransaction,
  PublicKey, TransactionMessage, TransactionInstruction,
  ComputeBudgetProgram, SystemProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import fetch from 'node-fetch';
import { CONFIG, rpcOnlyUrl } from '../config';
import { logErr, logOk, logWarn, emitEvent } from '../logger';
import {
  HELIUS_TIP_LAMPORTS,
  heliusSmartSend, multiRpcSend,
  getResilientBlockhash,
  getPriorityFeeForSwap,
  resilientRpcCall,
} from './jupiter';
import { getCachedPumpFunInfo } from './pumpfun-info';
import { GRADUATION_REAL_SOL_LAMPORTS } from './curve-parse';
import { TIP_ACCOUNTS, verifyPumpDirectTx } from './tx-verify';
import { dispatchSigned, enforceImpactCap, type SendContext } from './send-context';
import { errorReason, withTimeout, type ExecRpc } from './exec-common';
import { ownerTokenAccount } from './sim-owner-checks';
import { parseChainAccount, type ChainAccount } from './wallet-reads';
import {
  PF_DIRECT_CU_LIMIT, PUMP_PROGRAM, PumpDirectRefusal, classifyPumpCurve, classifyPumpMint, pumpTradeBounds, type PumpCurveInfo, type RawAccount,
} from './pump-program';
import {
  PUMPFUN_PROGRAM_ID, TOKEN_PROGRAM_PK, TOKEN_2022_PROGRAM_PK, deriveAta, deriveBondingCurve, deriveUserVolumeAccumulator,
  buildBuyInstruction, buildSellInstruction, buildCreateAtaIfNeededIx, pickPumpFeeAccounts,
  quoteBuy, quoteSell, curveBuyImpactPct, curveSellImpactPct,
} from './pumpfun-ix';

// ── Constants, PDAs, curve math and the instruction builders ──────
// R7-W5 (A-104): they live in the pure pumpfun-ix.ts (the unsigned wallet builder and verifier use the same functions, so a wallet is asked
// to sign what the server signs; byte-identity goldens pin the server bytes). Every name this file exported is re-exported.
export { PUMPFUN_PROGRAM_ID, quoteBuy, quoteSell, curveBuyImpactPct, curveSellImpactPct };
export { PumpDirectRefusal };

// ── FIX-PUMP: the direct bonding-curve route is ON (local builder only) ──
/**
 * FIX-PUMP (2026-11-06, owner decision): ON. The local builder follows pump's 2026-04-28 layout (18 accounts for a buy, 16 or 17 for a
 * sell, bonding_curve_v2 and the published fee recipients) for Token and Token-2022 coins, and every transaction is verified strictly and
 * simulated before it is signed. The PumpPortal / FAdo9 path is gone from this file (FIX-BUY2 had turned the route off because of it).
 */
export const PF_DIRECT_ENABLED: boolean = true;

export class PfDirectDisabledError extends Error {
  constructor(side: 'buy' | 'sell', why: string = 'the route is turned off') {
    super(`PF-direct disabled: ${why}, ${side} falls back to Jupiter`);
    this.name = 'PfDirectDisabledError';
  }
}

// ── the layout breaker ────────────────────────────────────────────
/** Two consecutive 'layout rejected' simulations within this window open the breaker ... */
export const PF_DIRECT_BREAKER_WINDOW_MS = 10 * 60_000;
/** ... for this long: PF-direct then refuses on its first line and the router goes straight to Jupiter. */
export const PF_DIRECT_BREAKER_OPEN_MS = 10 * 60_000;
const breaker = { lastLayoutAt: null as number | null, openUntil: 0 };

/** A simulation failed with a pump layout error (tx-verify PUMP_LAYOUT_ERROR_CODES): the second one in a row within the window opens the breaker. */
export function notePfDirectLayoutRejected(code: number, now: number = Date.now()): void {
  if (breaker.lastLayoutAt !== null && now - breaker.lastLayoutAt <= PF_DIRECT_BREAKER_WINDOW_MS) {
    breaker.openUntil = now + PF_DIRECT_BREAKER_OPEN_MS;
    breaker.lastLayoutAt = null;
    const text = `PF-direct breaker OPEN for ${PF_DIRECT_BREAKER_OPEN_MS / 60_000} min: pump refused the transaction layout twice (last error ${code}); curve trades go to Jupiter. Check pump's fee-recipient lists and account layout.`;
    logErr(`[pf-direct] ${text}`);
    emitEvent('ops-alert', { source: 'pf-direct', text });
    return;
  }
  breaker.lastLayoutAt = now;
}
/** A simulation passed: the layout works, so the next layout error starts a new count. */
function notePfDirectLayoutOk(): void {
  breaker.lastLayoutAt = null;
}
export function pfDirectBreakerOpen(now: number = Date.now()): boolean {
  return breaker.openUntil > now;
}
/** TESTS ONLY: close the breaker and forget the last layout error. */
export function resetPfDirectBreakerForTests(): void {
  breaker.lastLayoutAt = null;
  breaker.openUntil = 0;
}

// 2026-05-15 — Per-mint token-program detection. Cached aggressively (the
// program owner of a mint never changes after creation). FIX-PUMP: PF-direct reads the mint owner in its own chain read; this stays for
// pumpswap-swap.ts.
const _mintProgramCache = new Map<string, PublicKey>();
// 2026-05-16 — Negative cache for 429/transient errors. We don't want to
// hammer Helius when it's already throttling us. Short TTL so we re-check
// once the rate-limit window passes.
const _mintProgramNegCache = new Map<string, number>();  // mint → unix-ms-until
const NEG_CACHE_TTL_MS = 10_000;

/**
 * Smart per-mint default. Pump.fun migrated all NEW bonding-curve mints to
 * Token-2022 in their Feb 2026 cashback upgrade — every fresh "pump"-suffix
 * mint we see is Token-2022. Pre-migration tokens are mostly graduated by
 * now and wouldn't go through the pf-direct route anyway.
 *
 * Non-pump mints default to classic Token (still the dominant case).
 */
function defaultTokenProgramForMint(mint: string): PublicKey {
  return mint.endsWith('pump') ? TOKEN_2022_PROGRAM_PK : TOKEN_PROGRAM_PK;
}

/**
 * Try one RPC endpoint and return the parsed token program, or null on
 * any error (HTTP, JSON, missing field). Errors logged at the callsite so
 * each lane's failure can be distinguished.
 */
async function _probeMintOwner(url: string, mint: string): Promise<PublicKey | null> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
        params: [mint, { encoding: 'base64', commitment: 'confirmed' }],
      }),
      timeout: 5000,
    } as any);
    if (!r.ok) return null;
    const j = await r.json() as any;
    const owner = j?.result?.value?.owner;
    if (typeof owner !== 'string') return null;
    return owner === TOKEN_2022_PROGRAM_PK.toBase58()
      ? TOKEN_2022_PROGRAM_PK
      : TOKEN_PROGRAM_PK;
  } catch {
    return null;
  }
}

export async function getTokenProgramForMint(mint: string): Promise<PublicKey> {
  const cached = _mintProgramCache.get(mint);
  if (cached) return cached;

  // 2026-05-16 — If we recently 429'd on this mint, skip the RPC entirely
  // and use the smart default. This eliminates the hammering pattern that
  // was burning through Helius free-tier limits during burst snipes.
  const negUntil = _mintProgramNegCache.get(mint);
  if (negUntil && Date.now() < negUntil) {
    return defaultTokenProgramForMint(mint);
  }

  // Try every Helius lane we have, in priority order, then fall through to
  // mainnet-beta as a last resort. Each probe is 5s; the whole detection
  // budget is bounded by length-of-list × 5s but caches mean it's typically
  // ONE call.
  // RPC_URL set and RPC_FALLBACKS=off (B50 section 2, test override): that one endpoint and nothing else - no derived
  // provider lane, no mainnet-beta last resort. Unset: the lanes below, unchanged.
  const only = rpcOnlyUrl();
  const lanes: string[] = [];
  if (!only) {
    if (CONFIG.HELIUS_RPC_BOT)    lanes.push(CONFIG.HELIUS_RPC_BOT);
    if (CONFIG.HELIUS_RPC_WALLET) lanes.push(CONFIG.HELIUS_RPC_WALLET);
    if (CONFIG.ALCHEMY_RPC)       lanes.push(CONFIG.ALCHEMY_RPC);   // keyed quality lane (2026-06-12)
    if (CONFIG.HELIUS_RPC)        lanes.push(CONFIG.HELIUS_RPC);
  }
  // Dedupe (lanes often fall back to the same key in single-key setups)
  const uniqueLanes = only ? [only] : Array.from(new Set(lanes));
  // Final fallback — public mainnet, no key, but still gives a real answer
  if (!only) uniqueLanes.push('https://api.mainnet-beta.solana.com');

  for (const url of uniqueLanes) {
    const result = await _probeMintOwner(url, mint);
    if (result) {
      _mintProgramCache.set(mint, result);
      _mintProgramNegCache.delete(mint);   // clear any prior neg-cache
      const isT22 = result.equals(TOKEN_2022_PROGRAM_PK);
      logOk(`[pf-token-prog] ${mint.slice(0,8)}… → ${isT22 ? 'Token-2022' : 'classic-Token'} (via ${url.includes('helius') ? 'helius' : 'public'})`);
      return result;
    }
  }

  // Every lane failed. Cache the failure briefly so we don't keep hammering
  // every send. Use the smart default — for pump-suffix mints this is
  // Token-2022 (matches the on-chain reality for all post-Feb-2026 mints),
  // which is the correct answer in ~99% of cases. The user's terminal log
  // showed this fallback firing classic Token on Token-2022 mints and
  // reverting the buy on-chain — that's what this change fixes.
  _mintProgramNegCache.set(mint, Date.now() + NEG_CACHE_TTL_MS);
  const fallback = defaultTokenProgramForMint(mint);
  const isT22 = fallback.equals(TOKEN_2022_PROGRAM_PK);
  logWarn(`[pf-token-prog] ${mint.slice(0,8)}… all RPC lanes failed — using smart default ${isT22 ? 'Token-2022' : 'classic-Token'}`);
  return fallback;
}

// ── Smart slippage (curve-progress-aware) ─────────────────────────
/**
 * Returns slippage in bps based on the bonding curve's progress to graduation.
 *   <50% progress  → 100 bps  (1.0%)  buys / 100 bps sells
 *   50-90% progress → 200 bps (2.0%)  buys / 200 bps sells
 *   90-99% (grad rush) → 500 bps (5.0%) buys / 300 bps (3.0%) sells
 *
 * Sells are always ≤ buys' bps so we get tighter exit fills (we want clean
 * sells; bad-fill sells are real loss, bad-fill buys can be retried).
 */
export function smartSlippageBps(progress: number, side: 'buy' | 'sell'): number {
  const p = Math.max(0, Math.min(1, progress));
  if (p < 0.5)  return 100;
  if (p < 0.9)  return 200;
  return side === 'buy' ? 500 : 300;
}

// ── PumpPortal (inert since FIX-PUMP) ─────────────────────────────
// FIX-PUMP: no code path asks PumpPortal for anything (its local-transaction API wraps pump inside an unverified program). These three pinned exports
// stay (WTX-T15) and are used by nothing on the trade path.
/** Bounds of the PumpPortal `priorityFee` request, in SOL (a sane snipe range). */
export const PUMPPORTAL_PRIORITY_SOL_MIN = 0.0001;
export const PUMPPORTAL_PRIORITY_SOL_MAX = 0.005;
/**
 * A-93g: the PumpPortal `priorityFee` (total SOL, not micro-lamports/CU) for a unit price in micro-lamports per CU,
 * used by BOTH the buy and the sell: price x 200_000 CU / 1e6 micro-lamports per lamport / 1e9 lamports per SOL, clamped
 * to [0.0001, 0.005] SOL so a dynamic fee estimate never asks for more. The A-27 bound (2 x this) is then the same on both
 * sides. Sources (2026-10-26): https://solana.com/docs/core/fees (prioritization fee = ceil(compute_unit_price x
 * compute_unit_limit / 1_000_000) lamports, price in micro-lamports per CU); jupiter.ts getPriorityFeeForSwap
 * (returns micro-lamports per CU).
 */
export function pumpPortalPrioritySol(microLamportsPerCu: number): number {
  const sol = (microLamportsPerCu * 200_000) / 1e15;
  if (Number.isNaN(sol)) return PUMPPORTAL_PRIORITY_SOL_MIN;
  return Math.max(PUMPPORTAL_PRIORITY_SOL_MIN, Math.min(PUMPPORTAL_PRIORITY_SOL_MAX, sol));
}

// ── Public API ────────────────────────────────────────────────────
export interface PumpFunSwapResult {
  sig: string;
  tokensOut?: bigint;
  solOut?: bigint;
  /** B40: the pre-slippage QUOTE (same value as tokensOut/solOut). A quote is never a fill; fills come from fills.ts. */
  tokensOutQuoted?: bigint;
  solOutQuoted?: bigint;
  slippageBpsUsed: number;
}

/** B40 additions (optional, so every existing call site keeps compiling and behaving). */
export interface PumpFunExecOpts {
  /** A-26: the router's send context (impact cap, onSigned, buildOnly, singleSend, sent-signature record). */
  send?: SendContext;
  /** FIX-PUMP: the JSON-RPC caller of the chain read and the pre-sign simulation (default: the resilient RPC pool). Tests inject a fake. */
  rpc?: ExecRpc;
}

/** The default RPC of the route: the resilient pool (round-robin lanes with failover), the one every other server-path read uses. */
const poolRpc: ExecRpc = { call: (method: string, params: unknown[]) => resilientRpcCall(method, params as any[]) };

/** The first line of pumpfunBuy / pumpfunSell: off, or the layout breaker open, refuses before any read, build, signature or send. */
function assertPfDirectEnabled(side: 'buy' | 'sell'): void {
  if (!PF_DIRECT_ENABLED) throw new PfDirectDisabledError(side);
  if (pfDirectBreakerOpen()) throw new PfDirectDisabledError(side, 'the layout breaker is open (pump refused the transaction layout twice)');
}

// ── the one chain read of a trade ─────────────────────────────────
/** Budget of the build read; past it the trade is refused (nothing signed) and the router goes on to Jupiter. */
export const PF_DIRECT_READ_BUDGET_MS = 1_500;

export interface PumpDirectRead {
  curve: RawAccount | null;
  mint: RawAccount | null;
  ataToken2022: ChainAccount | null;
  ataToken: ChainAccount | null;
  userVolumeAccumulator: ChainAccount | null;
}

/**
 * ONE getMultipleAccounts at 'processed' (a curve created in the last second is visible): [bonding curve, mint, owner, owner ATA under
 * Token-2022, owner ATA under Token, user_volume_accumulator]. No pump.fun API, no warm cache, no guess from the 'pump' suffix.
 */
export async function readPumpDirectState(rpc: ExecRpc, mint: string, owner: string): Promise<PumpDirectRead> {
  const mintPk = new PublicKey(mint);
  const ownerPk = new PublicKey(owner);
  const addresses = [
    deriveBondingCurve(mintPk).toBase58(), mint, owner,
    deriveAta(mintPk, ownerPk, TOKEN_2022_PROGRAM_PK).toBase58(), deriveAta(mintPk, ownerPk, TOKEN_PROGRAM_PK).toBase58(),
    deriveUserVolumeAccumulator(ownerPk).toBase58(),
  ];
  let res: any;
  try {
    res = await withTimeout(rpc.call('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'processed' }]), PF_DIRECT_READ_BUDGET_MS);
  } catch (e) {
    throw new PumpDirectRefusal('read-failed', `the chain read failed: ${errorReason(e)}`);
  }
  if (res === null) throw new PumpDirectRefusal('read-failed', `the chain read took longer than ${PF_DIRECT_READ_BUDGET_MS} ms`);
  const list = res?.value;
  if (!Array.isArray(list) || list.length !== addresses.length) throw new PumpDirectRefusal('read-failed', 'the chain read answer is malformed');
  const parsed = list.map((v: unknown) => parseChainAccount(v));
  if (parsed.some((a) => a === undefined)) throw new PumpDirectRefusal('read-failed', 'an account of the chain read is unreadable');
  const raw = (a: ChainAccount | null | undefined): RawAccount | null => (a ? { owner: a.owner, data: a.data } : null);
  return {
    curve: raw(parsed[0]), mint: raw(parsed[1]),
    ataToken2022: parsed[3] ?? null, ataToken: parsed[4] ?? null, userVolumeAccumulator: parsed[5] ?? null,
  };
}

/** The most the bot signs per compute unit (PRIORITY_FEE_CEILING_MICROLAMPORTS, default 5 000 000); the verifier pins it. */
function priceCeiling(): bigint {
  const c = CONFIG.PRIORITY_FEE_CEILING_MICROLAMPORTS;
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? BigInt(Math.floor(Math.min(c, Number.MAX_SAFE_INTEGER))) : 5_000_000n;
}

/** The unit price: the dynamic estimate (VeryHigh, clamped to [floor, ceiling] by jupiter.ts) or the caller's fee, never above the ceiling. */
async function unitPrice(owner: string, keys: string[], fallback: number): Promise<bigint> {
  let p = fallback;
  try {
    const dyn = await getPriorityFeeForSwap(owner, keys, /*snipe=*/true);
    if (dyn && dyn > 0) p = dyn;
  } catch { /* keep the caller's fee */ }
  const v = Number.isFinite(p) && p > 0 ? BigInt(Math.floor(p)) : 0n;
  const ceiling = priceCeiling();
  return v > ceiling ? ceiling : v;
}

function tipInstruction(owner: PublicKey): TransactionInstruction {
  const tipAccount = TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)] ?? TIP_ACCOUNTS[0];
  return SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(tipAccount), lamports: HELIUS_TIP_LAMPORTS });
}

function classified(state: PumpDirectRead): { curve: PumpCurveInfo; tokenProgram: PublicKey; curveAccount: RawAccount; mintAccount: RawAccount } {
  const c = classifyPumpCurve(state.curve);
  if (!c.ok) throw new PumpDirectRefusal(c.code, c.detail);
  const m = classifyPumpMint(state.mint);
  if (!m.ok) throw new PumpDirectRefusal(m.code, m.detail);
  return { curve: c.value, tokenProgram: new PublicKey(m.value), curveAccount: state.curve!, mintAccount: state.mint! };
}

function progressOf(curve: PumpCurveInfo): number {
  return Math.min(1, Number(curve.realSolReserves) / GRADUATION_REAL_SOL_LAMPORTS);
}

/**
 * Direct PumpFun bonding-curve buy (buy_exact_sol_in: spends exactly the lamports of `solIn`, pump's fees included).
 *   solIn — SOL to spend (UI form, e.g. 0.05).
 *   slippageBps — null/undefined → smart default based on curve progress.
 *
 * Throws BEFORE signing (the router goes on to Jupiter) when the route is off or its breaker is open, the curve is missing, complete,
 * not SOL-quoted or of another layout, the mint is not a plain pump mint, the quote is zero or larger than the curve, the impact is over
 * the cap, or the verifier or its simulation refuses. After signing it throws only what the send gate throws.
 */
export async function pumpfunBuy(
  keypair: Keypair, mint: string, solIn: number,
  slippageBps?: number | null, priorityFee: number = 100_000,
  antiMev: boolean = true,
  execOpts: PumpFunExecOpts = {},
): Promise<PumpFunSwapResult> {
  assertPfDirectEnabled('buy');
  const rpc = execOpts.rpc ?? poolRpc;
  const user = keypair.publicKey;
  const owner = user.toBase58();
  const mintPk = new PublicKey(mint);
  const lamportsIn = BigInt(Math.floor(solIn * LAMPORTS_PER_SOL));
  if (lamportsIn <= 0n) throw new PumpDirectRefusal('bad-request', 'the SOL amount must be positive');

  // 1. the chain read, the cached blockhash and the priority estimate, in parallel
  const [state, bh, price] = await Promise.all([
    readPumpDirectState(rpc, mint, owner),
    getResilientBlockhash(),
    unitPrice(owner, [mint, deriveBondingCurve(mintPk).toBase58(), PUMP_PROGRAM], priorityFee),
  ]);

  // 2. classify (every refusal is before anything is built), slippage, the A-26 impact cap, the quote and its minimum
  const { curve, tokenProgram, curveAccount, mintAccount } = classified(state);
  const slip = (slippageBps != null && slippageBps > 0) ? slippageBps : smartSlippageBps(progressOf(curve), 'buy');
  enforceImpactCap(execOpts.send, 'pf-direct', curveBuyImpactPct(Number(curve.virtualSolReserves), Number(lamportsIn)));
  const bounds = pumpTradeBounds(curve, 'buy', lamportsIn, slip);
  if (!bounds.ok) throw new PumpDirectRefusal(bounds.code, bounds.detail);

  // 3. build
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: PF_DIRECT_CU_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
    buildCreateAtaIfNeededIx(user, user, mintPk, tokenProgram),
    buildBuyInstruction(user, mintPk, new PublicKey(curve.creator), lamportsIn, bounds.value.minOut, tokenProgram, pickPumpFeeAccounts(curve.mayhem)),
  ];
  if (antiMev) ixs.push(tipInstruction(user));
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message());

  // 4. verify the exact object (static pins, then the pre-sign simulation), then sign THAT object
  const v = await verifyPumpDirectTx(tx, {
    owner, mint, side: 'buy', amountIn: lamportsIn, slippageBps: slip, antiMev, curve: curveAccount, mintAccount, maxCuPriceMicroLamports: priceCeiling(),
  }, { rpc, onLayoutRejected: (code) => notePfDirectLayoutRejected(code) });
  notePfDirectLayoutOk();
  tx.sign([keypair]);

  // 2026-05-05 — async confirm: returns sig in ~50-100ms; background logs success/revert
  // A-26: the blockhash we built with carries its own lastValidBlockHeight (the builder's value).
  const { sig } = await dispatchSigned(execOpts.send, tx, 'pf-direct', bh.lastValidBlockHeight, () =>
    antiMev && CONFIG.HELIUS_SENDER_URL
      ? heliusSmartSend(tx, { awaitConfirm: false })
      : multiRpcSend(tx, { awaitConfirm: false }));

  logOk(`PF-direct BUY ${mint.slice(0,8)}… ${solIn} SOL slip=${slip}bps sim=${v.unitsConsumed ?? '?'}CU sig=${sig.slice(0,12)}…`);
  return { sig, tokensOut: bounds.value.quoted, tokensOutQuoted: bounds.value.quoted, slippageBpsUsed: slip };
}

/**
 * Direct PumpFun bonding-curve sell.
 *   tokensIn — RAW atom units (matches positions.json storage).
 * The owner's token account of the mint (under the mint's token program) must exist, be the owner's, not be frozen and hold tokensIn; a
 * cashback coin also needs the owner's user_volume_accumulator. Refusals throw before signing, as for the buy.
 */
export async function pumpfunSell(
  keypair: Keypair, mint: string, tokensIn: bigint,
  slippageBps?: number | null, priorityFee: number = 100_000,
  antiMev: boolean = true,
  execOpts: PumpFunExecOpts = {},
): Promise<PumpFunSwapResult> {
  assertPfDirectEnabled('sell');
  const rpc = execOpts.rpc ?? poolRpc;
  const user = keypair.publicKey;
  const owner = user.toBase58();
  const mintPk = new PublicKey(mint);
  if (typeof tokensIn !== 'bigint' || tokensIn <= 0n) throw new PumpDirectRefusal('bad-request', 'the token amount must be positive');

  const [state, bh, price] = await Promise.all([
    readPumpDirectState(rpc, mint, owner),
    getResilientBlockhash(),
    unitPrice(owner, [mint, deriveBondingCurve(mintPk).toBase58(), PUMP_PROGRAM], priorityFee),
  ]);

  const { curve, tokenProgram, curveAccount, mintAccount } = classified(state);
  const ata = tokenProgram.equals(TOKEN_2022_PROGRAM_PK) ? state.ataToken2022 : state.ataToken;
  const held = ata ? ownerTokenAccount(owner, ata) : null;
  if (held === null || held.mint !== mint || held.state !== 1 || held.amount < tokensIn) {
    throw new PumpDirectRefusal('insufficient-tokens', 'the owner token account of the mint is missing, frozen or holds less than the sell');
  }
  if (curve.cashback && state.userVolumeAccumulator === null) {
    throw new PumpDirectRefusal('cashback-no-uva', 'a cashback coin sell needs the owner user_volume_accumulator, which does not exist');
  }
  const slip = (slippageBps != null && slippageBps > 0) ? slippageBps : smartSlippageBps(progressOf(curve), 'sell');
  enforceImpactCap(execOpts.send, 'pf-direct', curveSellImpactPct(Number(curve.virtualTokenReserves), tokensIn));
  const bounds = pumpTradeBounds(curve, 'sell', tokensIn, slip);
  if (!bounds.ok) throw new PumpDirectRefusal(bounds.code, bounds.detail);

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: PF_DIRECT_CU_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
    buildSellInstruction(user, mintPk, new PublicKey(curve.creator), tokensIn, bounds.value.minOut, curve.cashback, tokenProgram, pickPumpFeeAccounts(curve.mayhem)),
  ];
  if (antiMev) ixs.push(tipInstruction(user));
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message());

  const v = await verifyPumpDirectTx(tx, {
    owner, mint, side: 'sell', amountIn: tokensIn, slippageBps: slip, antiMev, curve: curveAccount, mintAccount, maxCuPriceMicroLamports: priceCeiling(),
  }, { rpc, onLayoutRejected: (code) => notePfDirectLayoutRejected(code) });
  notePfDirectLayoutOk();
  tx.sign([keypair]);

  // 2026-05-05 — SELL blocks on confirm (capital-protection: last night's rug
  // had position monitor re-firing sells before knowing prior landed → 1500
  // failed TX storm draining wallet). Cost: ~600-2000ms blocking. Worth it.
  const { sig } = await dispatchSigned(execOpts.send, tx, 'pf-direct', bh.lastValidBlockHeight, () =>
    antiMev && CONFIG.HELIUS_SENDER_URL
      ? heliusSmartSend(tx, { awaitConfirm: true })
      : multiRpcSend(tx, { awaitConfirm: true }));

  logOk(`PF-direct SELL ${mint.slice(0,8)}… ${tokensIn} atoms slip=${slip}bps sim=${v.unitsConsumed ?? '?'}CU sig=${sig.slice(0,12)}…`);
  return { sig, solOut: bounds.value.quoted, solOutQuoted: bounds.value.quoted, slippageBpsUsed: slip };
}

/** Quick boolean: is this mint a PumpFun pre-grad token (so direct path applies)? */
export function isPumpFunPreGrad(mint: string): boolean {
  const pf = getCachedPumpFunInfo(mint);
  return !!(pf?.hasData && !pf.complete);
}
