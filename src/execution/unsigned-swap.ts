/**
 * UNSIGNED SWAP — build, verify and simulate an UNSIGNED trade for an external payer (R7-W5, A-104, design 7.1-7.5, rev 3 R3-2 and R3-5).
 *
 * `buildUnsignedSwap(deps, req)` takes the connected wallet's PUBLIC key as owner, fee payer and the only signer and returns the
 * quote the dashboard shows before the wallet opens, or a refusal. It never signs and never sends: the wallet is the only signer, and
 * what it signs is exactly the bytes ext-verify.ts checked and simulated.
 *
 * Routes (design 7.3, rev 3 R3-5 a-c):
 *   - pump curve (local builder: buy_exact_sol_in / sell): a classic Token mint on a curve that is open and not in mayhem mode;
 *   - PumpSwap: OFF while PUMPSWAP_DIRECT_ENABLED is false (a graduated mint goes to Jupiter, note 'pumpswap-direct-disabled'). The
 *     mechanics run only through the test-only dep `testOnlyPumpSwapRoute`, which the link routes never set;
 *   - no PumpPortal route: a Token-2022 pre-graduation mint goes to Jupiter, note 'pumpportal-not-offered';
 *   - Jupiter /swap/v2/build with taker = owner, exact-in, ONE attempt (jupBuildOnce); its compute-budget instructions and tip are
 *     dropped; lookup tables are read from the chain.
 * A route that cannot be used (or whose build is refused) falls through to the next one at BUILD time (nothing is signed yet); a note
 * records why. Refusals that are about the request or the budget (bad-request, nothing-to-sell, rpc-budget, build-timeout) stop at once.
 *
 * Limits (rev 3 R3-2): no cap on the SOL amount unless `maxSpendLamports` is set (then a route whose maximum spend exceeds it is refused);
 * the owner's SOL balance is read in the same build and `insufficient-sol` carries the exact need and have; the slippage bound rule
 * uses the request's slippage (1-5000 bps); a route over the request's maxImpactPct, or whose impact is unknown, is refused.
 *
 * Mint checks of a BUY (A-117, owner answer Q-RD3: the dashboard may buy any pasted mint, so these apply to a signal's mint too): refused `no-route`
 * with a plain reason, before any build and from the SAME chain read the build does anyway (no extra RPC call; the native mint is refused before any read),
 * when the mint is the native/wrapped-SOL mint, is not initialized, cannot be read, or is a Token-2022 mint whose extensions carry NonTransferable,
 * DefaultAccountState Frozen or a TransferHook with a program (parseMintExtensions in wallet-reads.ts; an unreadable extension list is refused too). A SELL is
 * never refused by these rules: holders must always be able to leave.
 *
 * Fees (design 7.5): the bot replaces any route compute-budget instructions with exactly one limit, ceil(units x 1.2) capped at 400 000
 * (two simulations: one to measure, one final inside the verifier), and one price from the priority estimate at level normal=Medium /
 * fast=High, clamped to the configured range. No tip, no rebate, no send, no journal, no Ultra/RFQ.
 */
import {
  PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount,
} from '@solana/web3.js';
import { cuLimitFromUnits, priorityFeeLamports, setCuLimitInstruction, setCuPriceInstruction, WALLET_CU_LIMIT_MAX } from './compute-budget';
import { isSolQuoted, parseBondingCurve } from './curve-parse';
import {
  JUPITER_V6_PROGRAM_ID, LAMPORTS_PER_SIGNATURE, PUMP_PROGRAM, WALLET_ATA_RENT_BYTES, decodeJupiterTail, jupiterVariantOf, maxInCeil, minOutFloor,
  readChainLookupTables, simulateUnits, verifySwapTx, type DisclosedBound, type InnerFeeAccount, type SwapExpectation, type VerifiedSwap,
} from './ext-verify';
import { buildCloseAccountInstruction } from './close-ix';
import { JupBuildError, jupBuildOnce, jupiterBuildImpactPct, toIx, type JupBuildRequest, type WalletBuild } from './jupiter-ix';
import {
  TOKEN_PROGRAM_PK, buildBuyInstruction, buildCreateAtaIfNeededIx, buildSellInstruction, buyNetLamports, constantProductImpactPct, deriveCreatorVault,
  pickPumpFeeAccounts, quoteBuyExact, quoteSellExact,
} from './pumpfun-ix';
import {
  PUMPSWAP_DIRECT_ENABLED, PUMPSWAP_FEE_RECIPIENT_ATA, buildPumpSwapBuyInstruction, buildPumpSwapSellInstruction, deriveCoinCreatorVaultAuthority,
  derivePumpSwapCanonicalPool, parsePumpSwapPoolAccount, poolBuyImpactPct, poolSellImpactPct, quoteBuy as poolQuoteBuy, quoteSell as poolQuoteSell,
  deriveAta as pumpSwapDeriveAta, type PoolRefs,
} from './pumpswap-ix';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, deriveAtaAddress, parseMintExtensions, parseSplMint, parseSplTokenAccount, readAccounts, readSolBalance, type ChainAccount,
} from './wallet-reads';
import { refusalFromError, walletRefusal, type WalletClock, type WalletRpcPort } from './wallet-rpc';
import { WALLET_LINK_BUDGET_MS } from '../shared/contract/wallet-link';
import type { ExactAmount, WalletRoute } from '../shared/dashboard/contract';
import type { WalletLinkRefusal, WalletQuoteLink, WalletQuoteOk, WalletQuoteRequest } from '../shared/contract/wallet-link';
import {
  WALLET_IMPACT_HARD_MAX_PCT, WALLET_SLIPPAGE_HARD_MAX_BPS, WALLET_TX_BYTES_HARD_MAX, isBase58Pubkey, isUintString,
} from '../shared/contract/wallet-validate';

// ── defaults (injected as deps; the bot config of R7-W6 passes the configured values) ───────────────────────────────────────────

/** WALLET_PRIORITY_MIN_MICROLAMPORTS / WALLET_PRIORITY_MAX_MICROLAMPORTS defaults (the maximum may not exceed 1 000 000). */
export const DEFAULT_PRIORITY_MIN_MICROLAMPORTS = 10_000;
export const DEFAULT_PRIORITY_MAX_MICROLAMPORTS = 1_000_000;
/** WALLET_TX_MAX_BYTES default: 1232 (the packet limit) minus headroom for instructions the wallet adds; the configured value is at most 1132. */
export const DEFAULT_WALLET_TX_MAX_BYTES = 1100;
/** The quote route's own budget (design 6.8): 12 s in total. */
export const WALLET_QUOTE_BUDGET_MS = WALLET_LINK_BUDGET_MS.quote.bot;
/** feeLevel -> the priority-estimate level; never the snipe level 'VeryHigh'. */
export const WALLET_FEE_LEVELS = { normal: 'Medium', fast: 'High' } as const;

/** State that lives for the boot: the rent of one token account is read once. */
export interface WalletBuildCache { rentMinLamports: bigint | null }
export function createWalletBuildCache(): WalletBuildCache { return { rentMinLamports: null }; }
const defaultCache = createWalletBuildCache();

export interface UnsignedSwapDeps {
  /** The wallet RPC port (one URL, confirmed reads), already wrapped by the RPC budget for this owner. */
  rpc: WalletRpcPort;
  clock: WalletClock;
  /** One Jupiter build attempt. Default: jupBuildOnce (first key, 6 s, no retry). */
  jupBuild?: (req: JupBuildRequest) => Promise<WalletBuild>;
  cache?: WalletBuildCache;
  priorityRange?: { minPrice: number; maxPrice: number };
  /** WALLET_TX_MAX_BYTES (at most 1132); the request's maxTxBytes can only lower it. */
  maxTxBytes?: number;
  /** The whole build must finish inside this many ms (default 12 000). */
  budgetMs?: number;
  /** TESTS ONLY: build the PumpSwap route although PUMPSWAP_DIRECT_ENABLED is false. The link routes never set it. */
  testOnlyPumpSwapRoute?: true;
}

// ── small helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const sol = (n: bigint): ExactAmount => ({ baseUnits: n.toString(), decimals: 9, asset: 'SOL' });
const kebab = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const GLOBAL_CODES = new Set(['bad-request', 'nothing-to-sell', 'rpc-budget', 'build-timeout']);
const isRefusal = (x: unknown): x is WalletLinkRefusal => typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;

interface Ctx {
  deps: UnsignedSwapDeps;
  req: WalletQuoteRequest;
  ownerPk: PublicKey;
  mintPk: PublicKey;
  tokenProgram: string;
  decimals: number;
  tradeAta: string;
  wsolAta: string;
  /** buy: the SOL to spend; sell: 0. */
  amount: bigint;
  /** sell: the exact tokens that leave the account (capped at the balance). */
  tokens: bigint | null;
  balanceLamports: bigint;
  balanceSlot: number;
  readAt: number;
  wsolPreAmount: bigint | null;
  rentMin: bigint;
  txCap: number;
  priorityRange: { minPrice: number; maxPrice: number };
  deadline: number;
  curve: ReturnType<typeof parseBondingCurve>;
  memo: { blockhash?: string; price?: Map<string, { price: number; unavailable: boolean }> };
  /** The routing notes so far (kebab-case codes); a route that finishes adds to it. */
  notes: string[];
}
const left = (c: Ctx): number => c.deadline - c.deps.clock.now();
const timedOut = (c: Ctx): boolean => left(c) <= 0;
const rpcOpts = (c: Ctx): { timeoutMs: number } => ({ timeoutMs: Math.max(250, left(c)) });

/** What a route hands to the common finishing step. */
interface RoutePlan {
  route: WalletRoute;
  ixs: TransactionInstruction[];
  bound: DisclosedBound;
  quotedOut: bigint | null;
  quotedIn: bigint | null;
  impactPct: number | null;
  /** The most SOL the route can spend: the amount (exact-in buy), the maximum input (PumpSwap buy), 0 (sell). */
  maxSpend: bigint;
  tables: AddressLookupTableAccount[];
  claimedTables: Record<string, string[]> | null;
  creator?: string;
  pool?: SwapExpectation['pool'];
  innerFees: InnerFeeAccount[];
  priorityKeys: string[];
}

function validate(req: WalletQuoteRequest): WalletLinkRefusal | null {
  const bad = (m: string): WalletLinkRefusal => walletRefusal('bad-request', m);
  if (!isBase58Pubkey(req.owner) || !isBase58Pubkey(req.mint)) return bad('owner and mint must be 32-byte base58 addresses');
  // the owner as the mint, and a SELL of wrapped SOL, stay malformed requests; a BUY of the native mint is a plain no-route refusal (A-117 c), made right after this check
  if (req.owner === req.mint || (req.mint === WSOL_MINT && req.side !== 'buy')) return bad('the mint cannot be the owner or wrapped SOL');
  if (req.side !== 'buy' && req.side !== 'sell') return bad('side must be buy or sell');
  if (!Number.isInteger(req.slippageBps) || req.slippageBps < 1 || req.slippageBps > WALLET_SLIPPAGE_HARD_MAX_BPS) return bad(`slippageBps must be an integer from 1 to ${WALLET_SLIPPAGE_HARD_MAX_BPS}`);
  if (typeof req.maxImpactPct !== 'number' || !Number.isFinite(req.maxImpactPct) || req.maxImpactPct <= 0 || req.maxImpactPct > WALLET_IMPACT_HARD_MAX_PCT || Math.round(req.maxImpactPct * 100) / 100 !== req.maxImpactPct) {
    return bad(`maxImpactPct must be in (0, ${WALLET_IMPACT_HARD_MAX_PCT}] with at most 2 decimals`);
  }
  if (req.feeLevel !== 'normal' && req.feeLevel !== 'fast') return bad('feeLevel must be normal or fast');
  if (!Number.isInteger(req.maxTxBytes) || req.maxTxBytes < 1 || req.maxTxBytes > WALLET_TX_BYTES_HARD_MAX) return bad(`maxTxBytes must be an integer from 1 to ${WALLET_TX_BYTES_HARD_MAX}`);
  if (req.maxSpendLamports !== null && (!isUintString(req.maxSpendLamports) || req.maxSpendLamports === '0')) return bad('maxSpendLamports must be null or a canonical integer string above 0');
  if (req.side === 'buy') {
    if (req.amountLamports === undefined || !isUintString(req.amountLamports) || req.amountLamports === '0' || req.tokensRaw !== undefined || req.pctBps !== undefined) return bad('a buy takes amountLamports only, above 0');
  } else {
    const hasTokens = req.tokensRaw !== undefined;
    const hasPct = req.pctBps !== undefined;
    if (hasTokens === hasPct || req.amountLamports !== undefined) return bad('a sell takes exactly one of tokensRaw and pctBps');
    if (hasTokens && (!isUintString(req.tokensRaw) || req.tokensRaw === '0')) return bad('tokensRaw must be a canonical integer string above 0');
    if (hasPct && (!Number.isInteger(req.pctBps) || (req.pctBps as number) < 1 || (req.pctBps as number) > 10_000)) return bad('pctBps must be an integer from 1 to 10000');
  }
  return null;
}

// ── the build ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Build, verify and simulate an unsigned swap for `req.owner`. Returns `{ok:true, quote}` or a link refusal; never throws for an RPC,
 * Jupiter or builder problem.
 */
export async function buildUnsignedSwap(deps: UnsignedSwapDeps, req: WalletQuoteRequest): Promise<WalletQuoteOk | WalletLinkRefusal> {
  const invalid = validate(req);
  if (invalid) return invalid;
  // A-117 (c): every dashboard BUY (a signal's or a pasted mint) is refused here, before any read, when the mint is the native mint
  if (req.side === 'buy' && req.mint === WSOL_MINT) return walletRefusal('no-route', 'the native SOL mint (wrapped SOL) cannot be bought here: choose a token');
  const clock = deps.clock;
  const deadline = clock.now() + (deps.budgetMs ?? WALLET_QUOTE_BUDGET_MS);
  const cache = deps.cache ?? defaultCache;
  const priorityRange = deps.priorityRange ?? { minPrice: DEFAULT_PRIORITY_MIN_MICROLAMPORTS, maxPrice: DEFAULT_PRIORITY_MAX_MICROLAMPORTS };
  const txCap = Math.min(req.maxTxBytes, deps.maxTxBytes ?? DEFAULT_WALLET_TX_MAX_BYTES, WALLET_TX_BYTES_HARD_MAX);
  const ownerPk = new PublicKey(req.owner);
  const mintPk = new PublicKey(req.mint);
  const wsolAta = deriveAtaAddress(req.owner, WSOL_MINT, TOKEN_PROGRAM_ID);
  const curvePda = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mintPk.toBuffer()], new PublicKey(PUMP_PROGRAM))[0].toBase58();
  const ataClassic = deriveAtaAddress(req.owner, req.mint, TOKEN_PROGRAM_ID);
  const ata22 = deriveAtaAddress(req.owner, req.mint, TOKEN_2022_PROGRAM_ID);

  // 1. the reads of this build (confirmed): balance, the accounts the routing needs, the rent of a token account
  let balance: { lamports: bigint; slot: number };
  let accts: Array<ChainAccount | null>;
  let rentMin: bigint;
  try {
    const opts = { timeoutMs: Math.max(250, deadline - clock.now()) };
    const [b, a, r] = await Promise.all([
      readSolBalance(deps.rpc, req.owner, opts),
      readAccounts(deps.rpc, [req.mint, curvePda, wsolAta, ataClassic, ata22], opts),
      cache.rentMinLamports !== null ? Promise.resolve(cache.rentMinLamports) : readRentMin(deps.rpc, opts),
    ]);
    balance = b;
    accts = a.accounts;
    rentMin = r;
    cache.rentMinLamports = r;
  } catch (e) { return refusalFromError(e); }
  const readAt = clock.now();

  const [mintAcc, curveAcc, wsolAcc, classicAcc, acc22] = accts;
  if (mintAcc === null) return walletRefusal('no-route', 'the mint account was not found');
  if (mintAcc.owner !== TOKEN_PROGRAM_ID && mintAcc.owner !== TOKEN_2022_PROGRAM_ID) return walletRefusal('no-route', 'the address is not a token mint');
  const mintInfo = parseSplMint(mintAcc.data);
  if (mintInfo === null) return walletRefusal('no-route', 'the mint account could not be read');
  if (!mintInfo.isInitialized) return walletRefusal('no-route', req.side === 'buy' ? 'this mint is not initialized, so it cannot be bought' : 'the mint account could not be read');
  if (mintInfo.decimals > 18) return walletRefusal('build-failed', 'a mint with more than 18 decimals is not supported');
  const tokenProgram = mintAcc.owner;
  // A-117 (c): a BUY of a Token-2022 mint is refused, from the data this same read returned (no extra call), when an extension would trap or block the buyer; a sell never is
  if (req.side === 'buy' && tokenProgram === TOKEN_2022_PROGRAM_ID) {
    const why = token2022BuyRefusal(mintAcc.data);
    if (why !== null) return walletRefusal('no-route', why);
  }
  const tradeAta = tokenProgram === TOKEN_PROGRAM_ID ? ataClassic : ata22;
  const tradeAcc = tokenProgram === TOKEN_PROGRAM_ID ? classicAcc : acc22;

  let wsolPreAmount: bigint | null = null;
  if (wsolAcc !== null) {
    const w = wsolAcc.owner === TOKEN_PROGRAM_ID ? parseSplTokenAccount(wsolAcc.data) : null;
    if (w === null) return walletRefusal('build-failed', 'the wrapped-SOL account could not be read');
    wsolPreAmount = w.amount;
  }

  // amounts
  let amount = 0n;
  let tokens: bigint | null = null;
  if (req.side === 'buy') amount = BigInt(req.amountLamports as string);
  else {
    const held = tradeAcc === null ? null : parseSplTokenAccount(tradeAcc.data);
    if (tradeAcc !== null && held === null) return walletRefusal('build-failed', 'the token account could not be read');
    const have = held?.amount ?? 0n;
    if (have === 0n) return walletRefusal('nothing-to-sell', 'the wallet holds none of this token');
    if (held!.state === 2) return walletRefusal('build-failed', 'the token account is frozen');
    const want = req.tokensRaw !== undefined ? BigInt(req.tokensRaw) : (have * BigInt(req.pctBps as number)) / 10_000n;
    tokens = want > have ? have : want;
    if (tokens === 0n) return walletRefusal('nothing-to-sell', 'the amount to sell rounds to nothing');
  }

  const ctx: Ctx = {
    deps, req, ownerPk, mintPk, tokenProgram, decimals: mintInfo.decimals, tradeAta, wsolAta, amount, tokens, balanceLamports: balance.lamports, balanceSlot: balance.slot,
    readAt, wsolPreAmount, rentMin, txCap, priorityRange, deadline, curve: curveAcc !== null && curveAcc.owner === PUMP_PROGRAM ? parseBondingCurve(curveAcc.data) : null, memo: {}, notes: [],
  };

  // 2. the routes in order, with the reason each skipped one is skipped
  const notes = ctx.notes;
  const order: WalletRoute[] = [];
  if (ctx.curve) {
    if (ctx.curve.complete) {
      if (PUMPSWAP_DIRECT_ENABLED || deps.testOnlyPumpSwapRoute === true) order.push('pumpswap');
      else notes.push('pumpswap-direct-disabled');
    } else if (ctx.curve.isMayhemMode !== false) notes.push('mayhem-mode-unsupported');
    else if (!isSolQuoted(ctx.curve.quoteMint)) notes.push('pump-non-sol-quote');            // FIX-PUMP: a USDC- or coin-quoted curve
    else if (ctx.curve.isCashbackCoin !== false) notes.push('pump-cashback-unsupported');    // FIX-PUMP: the 17-account sell is not offered here
    else if (tokenProgram !== TOKEN_PROGRAM_ID) notes.push('pumpportal-not-offered');
    else order.push('pump');
  }
  order.push('jupiter');

  let first: WalletLinkRefusal | null = null;
  for (const route of order) {
    if (timedOut(ctx)) return walletRefusal('build-timeout', 'the quote did not finish inside its budget');
    const r = await attemptRoute(ctx, route);
    if (!isRefusal(r)) return { ok: true, quote: { ...r, routingNotes: notes.slice(0, 8) } };
    if (GLOBAL_CODES.has(r.code)) return r;
    first ??= r;
    notes.push(kebab(`${route}-${r.code}`));
  }
  return first ?? walletRefusal('no-route', 'no route could be built');
}

/**
 * A-117 (c): why a Token-2022 mint cannot be bought from the dashboard, read from the mint account data the build already fetched; null when it can.
 * NonTransferable (the tokens could never be sold or moved), DefaultAccountState Frozen (the buyer's new token account starts frozen) and a TransferHook
 * with a program (an unvetted program runs on every transfer) are refused, and so is a mint whose extensions cannot be read (fail closed). Sells never call this.
 */
function token2022BuyRefusal(mintData: Uint8Array): string | null {
  const ext = parseMintExtensions(mintData);
  if (ext === null) return 'the Token-2022 extensions of this mint could not be read, so it cannot be bought';
  if (ext.nonTransferable) return 'this token is non-transferable (NonTransferable extension), so it cannot be bought';
  if (ext.defaultAccountStateFrozen) return 'new token accounts of this mint start frozen (DefaultAccountState extension), so a buy would leave the tokens frozen';
  if (ext.transferHookProgram !== null) return 'this token runs a transfer-hook program on every transfer (TransferHook extension), which is not supported';
  return null;
}

async function readRentMin(rpc: WalletRpcPort, opts: { timeoutMs: number }): Promise<bigint> {
  const r = await rpc.call('getMinimumBalanceForRentExemption', [WALLET_ATA_RENT_BYTES], opts);
  if (typeof r !== 'number' || !Number.isSafeInteger(r) || r <= 0) throw new Error('getMinimumBalanceForRentExemption answer is malformed');
  return BigInt(r);
}

async function attemptRoute(c: Ctx, route: WalletRoute): Promise<Omit<WalletQuoteLink, 'routingNotes'> | WalletLinkRefusal> {
  let plan: RoutePlan | WalletLinkRefusal;
  try {
    plan = route === 'pump' ? planPump(c) : route === 'pumpswap' ? await planPumpSwap(c) : await planJupiter(c);
  } catch (e) { return refusalFromError(e); }
  if (isRefusal(plan)) return plan;
  return finish(c, plan);
}

// ── route plans ────────────────────────────────────────────────────────────────────────────────────────────────────────────

function planPump(c: Ctx): RoutePlan | WalletLinkRefusal {
  const curve = c.curve!;
  const slip = BigInt(10_000 - c.req.slippageBps);
  const creator = new PublicKey(curve.creator);
  const vSol = curve.virtualSolReserves;
  const vTok = curve.virtualTokenReserves;
  const common = { route: 'pump' as const, tables: [], claimedTables: null, creator: curve.creator, priorityKeys: [c.req.owner, c.req.mint, PUMP_PROGRAM] };
  // FIX-PUMP: one NORMAL fee recipient and one buyback recipient (pump-program.ts lists, picked at random as pump's SDK does)
  const fees = pickPumpFeeAccounts(false);
  const innerFees: InnerFeeAccount[] = [
    { label: 'Pump protocol fee, charged inside the swap program', recipient: fees.feeRecipient.toBase58(), address: fees.feeRecipient.toBase58(), kind: 'lamports' },
    { label: 'Pump buyback fee, charged inside the swap program', recipient: fees.buybackFeeRecipient.toBase58(), address: fees.buybackFeeRecipient.toBase58(), kind: 'lamports' },
    { label: 'Creator fee, charged inside the swap program', recipient: deriveCreatorVault(creator).toBase58(), address: deriveCreatorVault(creator).toBase58(), kind: 'lamports' },
  ];
  if (c.req.side === 'buy') {
    const impactPct = constantProductImpactPct(vSol, buyNetLamports(c.amount));
    if (impactPct === null) return walletRefusal('impact-above-limit', `the route gave no price impact, so the limit ${c.req.maxImpactPct}% cannot be checked`);
    const out = quoteBuyExact(vSol, vTok, c.amount);
    if (out === 0n) return walletRefusal('build-failed', 'the curve quote is zero tokens: the amount is too small');
    const minOut = (out * slip) / 10_000n;
    return {
      ...common, ixs: [
        buildCreateAtaIfNeededIx(c.ownerPk, c.ownerPk, c.mintPk, TOKEN_PROGRAM_PK),
        buildBuyInstruction(c.ownerPk, c.mintPk, creator, c.amount, minOut, TOKEN_PROGRAM_PK, fees),
      ],
      bound: { kind: 'exact_in', amountIn: c.amount, minOut }, quotedOut: out, quotedIn: null,
      impactPct, maxSpend: c.amount, innerFees,
    };
  }
  const tokens = c.tokens!;
  const out = quoteSellExact(vSol, vTok, tokens);
  if (out === 0n) return walletRefusal('build-failed', 'the curve quote is zero SOL');
  const minOut = (out * slip) / 10_000n;
  return {
    ...common, ixs: [buildSellInstruction(c.ownerPk, c.mintPk, creator, tokens, minOut, false, TOKEN_PROGRAM_PK, fees)],
    bound: { kind: 'exact_in', amountIn: tokens, minOut }, quotedOut: out, quotedIn: null,
    impactPct: constantProductImpactPct(vTok, tokens), maxSpend: 0n, innerFees,
  };
}

async function planPumpSwap(c: Ctx): Promise<RoutePlan | WalletLinkRefusal> {
  const poolKey = derivePumpSwapCanonicalPool(c.mintPk);
  const { accounts } = await readAccounts(c.deps.rpc, [poolKey.toBase58()], rpcOpts(c));
  const poolAcc = accounts[0];
  if (poolAcc === null) return walletRefusal('no-route', 'no PumpSwap pool for this mint');
  const parsed = parsePumpSwapPoolAccount(poolAcc.data, c.mintPk);
  if (parsed === null) return walletRefusal('no-route', 'the PumpSwap pool account could not be read');
  const vaults = await readAccounts(c.deps.rpc, [parsed.poolBaseAccount.toBase58(), parsed.poolQuoteAccount.toBase58()], rpcOpts(c));
  const baseRes = vaults.accounts[0] === null ? null : parseSplTokenAccount(vaults.accounts[0]!.data)?.amount ?? null;
  const quoteRes = vaults.accounts[1] === null ? null : parseSplTokenAccount(vaults.accounts[1]!.data)?.amount ?? null;
  if (baseRes === null || quoteRes === null || baseRes === 0n || quoteRes === 0n) return walletRefusal('no-route', 'the PumpSwap pool has an empty side');
  const pool: PoolRefs = { pool: poolKey, poolBaseAccount: parsed.poolBaseAccount, poolQuoteAccount: parsed.poolQuoteAccount, coinCreator: parsed.coinCreator };
  const tokenProgram = new PublicKey(c.tokenProgram);
  const wsolAta = new PublicKey(c.wsolAta);
  const slip = BigInt(10_000 - c.req.slippageBps);
  const vaultAuthority = deriveCoinCreatorVaultAuthority(parsed.coinCreator);
  const wsol = new PublicKey(WSOL_MINT);
  const innerFees: InnerFeeAccount[] = [
    { label: 'PumpSwap protocol fee, charged inside the swap program', recipient: PUMPSWAP_FEE_RECIPIENT_ATA.toBase58(), address: PUMPSWAP_FEE_RECIPIENT_ATA.toBase58(), kind: 'token' },
    { label: 'Creator fee, charged inside the swap program', recipient: pumpSwapDeriveAta(wsol, vaultAuthority, TOKEN_PROGRAM_PK).toBase58(), address: pumpSwapDeriveAta(wsol, vaultAuthority, TOKEN_PROGRAM_PK).toBase58(), kind: 'token' },
  ];
  const syncNative = new TransactionInstruction({ programId: TOKEN_PROGRAM_PK, keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }], data: Buffer.from([17]) });
  const closeWsol = buildCloseAccountInstruction(TOKEN_PROGRAM_PK, wsolAta, c.ownerPk);
  const poolOut = { route: 'pumpswap' as const, tables: [], claimedTables: null, pool: { pool: poolKey.toBase58(), poolBaseAccount: parsed.poolBaseAccount.toBase58(), poolQuoteAccount: parsed.poolQuoteAccount.toBase58(), coinCreator: parsed.coinCreator.toBase58() }, priorityKeys: [c.req.owner, c.req.mint, poolKey.toBase58()] };
  if (c.req.side === 'buy') {
    const out = poolQuoteBuy(baseRes, quoteRes, c.amount);
    if (out === 0n) return walletRefusal('build-failed', 'the pool quote is zero tokens: the amount is too small');
    const maxIn = maxInCeil(c.amount, c.req.slippageBps);
    return {
      ...poolOut, innerFees, ixs: [
        buildCreateAtaIfNeededIx(c.ownerPk, c.ownerPk, wsol, TOKEN_PROGRAM_PK),
        buildCreateAtaIfNeededIx(c.ownerPk, c.ownerPk, c.mintPk, tokenProgram),
        SystemProgram.transfer({ fromPubkey: c.ownerPk, toPubkey: wsolAta, lamports: maxIn }),
        syncNative,
        buildPumpSwapBuyInstruction(c.ownerPk, c.mintPk, pool, tokenProgram, out, maxIn),
        closeWsol,
      ],
      bound: { kind: 'exact_out', exactOut: out, maxIn }, quotedOut: null, quotedIn: c.amount,
      impactPct: poolBuyImpactPct(quoteRes, c.amount), maxSpend: maxIn,
    };
  }
  const tokens = c.tokens!;
  const out = poolQuoteSell(baseRes, quoteRes, tokens);
  if (out === 0n) return walletRefusal('build-failed', 'the pool quote is zero SOL');
  const minOut = (out * slip) / 10_000n;
  return {
    ...poolOut, innerFees, ixs: [
      buildCreateAtaIfNeededIx(c.ownerPk, c.ownerPk, wsol, TOKEN_PROGRAM_PK),
      buildPumpSwapSellInstruction(c.ownerPk, c.mintPk, pool, tokenProgram, tokens, minOut),
      closeWsol,
    ],
    bound: { kind: 'exact_in', amountIn: tokens, minOut }, quotedOut: out, quotedIn: null,
    impactPct: poolSellImpactPct(baseRes, tokens), maxSpend: 0n,
  };
}

async function planJupiter(c: Ctx): Promise<RoutePlan | WalletLinkRefusal> {
  const buy = c.req.side === 'buy';
  const request: JupBuildRequest = {
    taker: c.req.owner, inputMint: buy ? WSOL_MINT : c.req.mint, outputMint: buy ? c.req.mint : WSOL_MINT,
    amount: (buy ? c.amount : c.tokens!).toString(), slippageBps: c.req.slippageBps,
  };
  let b: WalletBuild;
  try { b = await (c.deps.jupBuild ?? jupBuildOnce)(request); } catch (e) {
    if (e instanceof JupBuildError) {
      if (e.kind === 'timeout') return walletRefusal('build-timeout', e.message);
      return walletRefusal(e.kind === 'http' && e.status !== null && e.status >= 400 && e.status < 500 ? 'no-route' : e.kind === 'no-key' ? 'no-route' : 'build-failed', e.message);
    }
    return refusalFromError(e);
  }
  if (b.swapInstruction.programId !== JUPITER_V6_PROGRAM_ID) return walletRefusal('verify-failed', 'the Jupiter swap instruction is not the Jupiter aggregator program');
  const data = Buffer.from(b.swapInstruction.data, 'base64');
  if (jupiterVariantOf(data) === null) return walletRefusal('verify-failed', 'the Jupiter swap instruction is not a pinned exact-in route');
  const tail = decodeJupiterTail(data);
  if (tail === null) return walletRefusal('verify-failed', 'the Jupiter swap instruction data is too short');
  const quotedOut = tail.quotedOutAmount;
  const minOut = minOutFloor(quotedOut, c.req.slippageBps);
  // lookup tables: read from the chain, never compiled against Jupiter's claim
  const claimed = b.addressesByLookupTableAddress;
  let tables: AddressLookupTableAccount[] = [];
  if (claimed !== null && Object.keys(claimed).length > 0) {
    try { tables = await readChainLookupTables(c.deps.rpc, Object.keys(claimed), rpcOpts(c).timeoutMs); } catch (e) {
      const r = refusalFromError(e, 'verify-failed');
      return r.code === 'rpc-budget' || r.code === 'build-timeout' ? r : walletRefusal('verify-failed', `lookup table: ${r.reason}`);
    }
  }
  const ixs = [...b.setupInstructions.map(toIx), toIx(b.swapInstruction), ...(b.cleanupInstruction ? [toIx(b.cleanupInstruction)] : [])];
  return {
    route: 'jupiter', ixs, tables, claimedTables: claimed,
    bound: { kind: 'exact_in', amountIn: buy ? c.amount : c.tokens!, minOut }, quotedOut, quotedIn: null,
    impactPct: jupiterBuildImpactPct(b), maxSpend: buy ? c.amount : 0n, innerFees: [],
    priorityKeys: [c.req.owner, c.req.mint, JUPITER_V6_PROGRAM_ID],
  };
}

// ── priority fee, blockhash, the two simulations, the verifier ─────────────────────────────────────────────────────────────────

/**
 * The priority price (micro-lamports per compute unit) from the priority-fee estimator on the wallet RPC port: level normal=Medium,
 * fast=High (never the snipe level), clamped to [minPrice, maxPrice]. When the estimator fails or answers nothing usable the price is
 * the configured MINIMUM and `unavailable` is true; only the RPC budget's refusal is passed on.
 */
export async function estimatePriorityPrice(
  rpc: WalletRpcPort, keys: readonly string[], level: 'normal' | 'fast', range: { minPrice: number; maxPrice: number }, opts: { timeoutMs?: number } = {},
): Promise<{ price: number; unavailable: boolean }> {
  try {
    const r = await rpc.call('getPriorityFeeEstimate', [{ accountKeys: [...keys], options: { priorityLevel: WALLET_FEE_LEVELS[level], recommended: false, evaluateEmptySlotAsZero: true } }], opts);
    const est = Number(r?.priorityFeeEstimate);
    return Number.isFinite(est) && est > 0 ? { price: Math.min(range.maxPrice, Math.max(range.minPrice, Math.floor(est))), unavailable: false } : { price: range.minPrice, unavailable: true };
  } catch (e) {
    if (refusalFromError(e).code === 'rpc-budget') throw e;
    return { price: range.minPrice, unavailable: true };
  }
}

/** A fresh blockhash (getLatestBlockhash, confirmed). Throws on a malformed answer. */
export async function latestBlockhash(rpc: WalletRpcPort, opts: { timeoutMs?: number } = {}): Promise<string> {
  const r = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }], opts);
  const bh = r?.value?.blockhash;
  if (typeof bh !== 'string' || bh.length < 32 || bh.length > 44) throw new Error('getLatestBlockhash answer is malformed');
  return bh;
}

/** Compile an UNSIGNED v0 transaction for `owner` as fee payer: [limit, price, ...instructions], against the given chain-read tables. */
export function compileWalletTx(owner: PublicKey, blockhash: string, instructions: TransactionInstruction[], limit: number, price: number, tables: AddressLookupTableAccount[] = []): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: owner, recentBlockhash: blockhash, instructions: [setCuLimitInstruction(limit), setCuPriceInstruction(price), ...instructions],
  }).compileToV0Message(tables);
  return new VersionedTransaction(msg);
}

async function priceFor(c: Ctx, keys: string[]): Promise<{ price: number; unavailable: boolean }> {
  const k = keys.join(',');
  c.memo.price ??= new Map();
  const hit = c.memo.price.get(k);
  if (hit) return hit;
  const out = await estimatePriorityPrice(c.deps.rpc, keys, c.req.feeLevel, c.priorityRange, rpcOpts(c));
  c.memo.price.set(k, out);
  return out;
}

async function blockhashOf(c: Ctx): Promise<string> {
  c.memo.blockhash ??= await latestBlockhash(c.deps.rpc, rpcOpts(c));
  return c.memo.blockhash;
}

function compile(c: Ctx, blockhash: string, plan: RoutePlan, limit: number, price: number): VersionedTransaction {
  return compileWalletTx(c.ownerPk, blockhash, plan.ixs, limit, price, plan.tables);
}

const isCreateIdempotent = (ix: TransactionInstruction): boolean => ix.programId.toBase58() === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' && ix.data.length === 1 && ix.data[0] === 1;

async function finish(c: Ctx, plan: RoutePlan): Promise<Omit<WalletQuoteLink, 'routingNotes'> | WalletLinkRefusal> {
  const req = c.req;
  // a route that wraps or closes the owner's wrapped-SOL account would unwrap what is in it: refused before any simulation (ext-verify S4 checks it again)
  if (plan.route !== 'pump' && c.wsolPreAmount !== null && c.wsolPreAmount > 0n) {
    return walletRefusal('wsol-balance-present', 'Unwrap your wSOL first (Recover SOL tab), so this trade does not unwrap it for you');
  }
  // the cap on the maximum spend and the impact limit come before any simulation
  if (req.maxSpendLamports !== null && plan.maxSpend > BigInt(req.maxSpendLamports)) {
    return walletRefusal('amount-above-cap', `the maximum spend ${plan.maxSpend} lamports is above the cap ${req.maxSpendLamports}`);
  }
  // an impact the route did not give (or a degenerate reserve) cannot be checked against the limit: refused, as the server path does (A-26, A-108b)
  if (plan.impactPct === null || !Number.isFinite(plan.impactPct)) {
    return walletRefusal('impact-above-limit', `the route gave no price impact, so the limit ${req.maxImpactPct}% cannot be checked`);
  }
  if (plan.impactPct > req.maxImpactPct) {
    return walletRefusal('impact-above-limit', `the price impact ${plan.impactPct}% is above the limit ${req.maxImpactPct}%`);
  }
  const createCount = plan.ixs.filter(isCreateIdempotent).length;
  const rentBound = BigInt(createCount) * c.rentMin;
  const network = LAMPORTS_PER_SIGNATURE;
  let blockhash: string;
  let price: { price: number; unavailable: boolean };
  try { [blockhash, price] = await Promise.all([blockhashOf(c), priceFor(c, plan.priorityKeys)]); } catch (e) { return refusalFromError(e); }
  if (price.unavailable && !c.notes.includes('priority-estimate-unavailable')) c.notes.push('priority-estimate-unavailable');
  if (timedOut(c)) return walletRefusal('build-timeout', 'the quote did not finish inside its budget');

  // simulation 1: measure the units with the 400 000 limit
  const measuring = compile(c, blockhash, plan, WALLET_CU_LIMIT_MAX, price.price).serialize();
  if (measuring.length > c.txCap) return walletRefusal('tx-too-large', `the transaction is ${measuring.length} bytes, above the ${c.txCap} byte cap`);
  const measuringMsg = VersionedTransaction.deserialize(measuring).message;
  const programOf = (i: number): string | null => {
    const ix = measuringMsg.compiledInstructions[i];
    return ix ? measuringMsg.staticAccountKeys[ix.programIdIndex]?.toBase58() ?? null : null;
  };
  const s1 = await simulateUnits(c.deps.rpc, measuring, programOf, rpcOpts(c).timeoutMs);
  if (isRefusal(s1)) {
    const upper = plan.maxSpend + network + priorityFeeLamports(WALLET_CU_LIMIT_MAX, price.price) + rentBound;
    if (s1.code === 'simulation-failed' && c.balanceLamports < upper) {
      return walletRefusal('insufficient-sol', 'the wallet balance is below the most this trade can take', { needLamports: upper.toString(), haveLamports: c.balanceLamports.toString() });
    }
    return s1;
  }
  const cuLimit = cuLimitFromUnits(s1.value.unitsConsumed);
  const feeLamports = priorityFeeLamports(cuLimit, price.price);
  const maxOutflow = plan.maxSpend + network + feeLamports + rentBound;
  if (maxOutflow > c.balanceLamports) {
    return walletRefusal('insufficient-sol', 'the wallet balance is below the most this trade can take', { needLamports: maxOutflow.toString(), haveLamports: c.balanceLamports.toString() });
  }

  // the final transaction, verified from its bytes and simulated again (simulation 2)
  const finalBytes = compile(c, blockhash, plan, cuLimit, price.price).serialize();
  const exp: SwapExpectation = {
    route: plan.route, side: req.side, owner: req.owner, mint: req.mint, tokenProgram: c.tokenProgram, slippageBps: req.slippageBps, bound: plan.bound,
    quotedOut: plan.quotedOut, quotedIn: plan.quotedIn, tokensRaw: c.tokens, cuLimit, cuPriceMicrolamports: price.price, priorityFeeLamports: feeLamports,
    networkFeeLamports: network, rentMinLamports: c.rentMin, rentLamports: rentBound, maxOutflowLamports: maxOutflow, thirdPartyTransfers: [],
    balanceLamports: c.balanceLamports, maxSpendCapLamports: req.maxSpendLamports === null ? null : BigInt(req.maxSpendLamports), wsolPreAmount: c.wsolPreAmount,
    ...(plan.creator ? { creator: plan.creator } : {}), ...(plan.pool ? { pool: plan.pool } : {}), ...(plan.route === 'jupiter' ? { claimedTables: plan.claimedTables } : {}),
    innerFees: plan.innerFees,
  };
  const v = await verifySwapTx({ rpc: c.deps.rpc, priorityRange: c.priorityRange, maxTxBytes: c.txCap, timeoutMs: rpcOpts(c).timeoutMs }, finalBytes, exp);
  if (isRefusal(v)) return v;
  return assemble(c, plan, exp, v.value, finalBytes);
}

function assemble(c: Ctx, plan: RoutePlan, exp: SwapExpectation, v: VerifiedSwap, bytes: Uint8Array): Omit<WalletQuoteLink, 'routingNotes'> {
  const req = c.req;
  const tok = (n: bigint): ExactAmount => ({ baseUnits: n.toString(), decimals: c.decimals, asset: req.mint });
  const buy = req.side === 'buy';
  const b = plan.bound;
  const bound: WalletQuoteLink['bound'] = b.kind === 'exact_in'
    ? (buy ? { kind: 'exact_in', amountIn: sol(b.amountIn), minOut: tok(b.minOut) } : { kind: 'exact_in', amountIn: tok(b.amountIn), minOut: sol(b.minOut) })
    : { kind: 'exact_out', exactOut: tok(b.exactOut), maxIn: sol(b.maxIn) };
  const now = c.deps.clock.now();
  return {
    route: plan.route, side: req.side, mint: req.mint, bound, maxOutflowLamports: exp.maxOutflowLamports.toString(),
    quotedOut: plan.quotedOut === null ? null : (buy ? tok(plan.quotedOut) : sol(plan.quotedOut)),
    quotedIn: plan.quotedIn === null ? null : sol(plan.quotedIn),
    impactPct: plan.impactPct, slippageBps: req.slippageBps,
    simulatedDeltas: { sol: sol(v.ownerDeltaLamports), token: tok(v.tokenDelta) },
    networkFeeLamports: exp.networkFeeLamports.toString(),
    priorityFee: { cuLimit: exp.cuLimit, cuPriceMicrolamports: exp.cuPriceMicrolamports, lamports: exp.priorityFeeLamports.toString() },
    innerFees: v.innerFees.map((f) => ({ label: f.label, recipient: f.recipient, amount: { baseUnits: f.amountBase.toString(), decimals: f.decimals, asset: f.asset } })),
    thirdPartyTransfers: [], rentLamports: exp.rentLamports.toString(), programs: v.programs,
    txBytes: bytes.length, txBase64: Buffer.from(bytes).toString('base64'), minContextSlot: v.slot,
    quotedAt: c.readAt, simulatedAt: now, builtAt: now,
    balance: { lamports: c.balanceLamports.toString(), readAt: c.readAt, slot: c.balanceSlot },
  };
}
