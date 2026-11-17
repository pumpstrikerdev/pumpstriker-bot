/**
 * UNSIGNED CLOSE — build, verify and simulate an UNSIGNED CloseAccount transaction for an external payer (R7-W5, A-104, design 5.4 and 7.4 C1-C6).
 *
 * `buildUnsignedClose(deps, req)` closes the owner's EMPTY token accounts (kind 'empty', at most one batch) or unwraps the owner's wSOL
 * account (kind 'unwrap'). Each close is the CloseAccount instruction of close-ix.ts (data [9], destination and authority = the owner)
 * under the account's own token program. The rent returns 100 % to the owner; there is no fee of ours and no trade instruction.
 *
 * Selection (the bot's own read in this build, design 5.4): an account is skipped, and listed with a reason, when it holds a balance, is
 * frozen, holds withheld Token-2022 transfer fees, has a close authority other than the owner, belongs to a mint the owner bought a
 * moment ago (the `freshBuy` dep), or is on the Engine's `excluded` list (UnclaimedSol marks it protected). More eligible accounts than
 * one batch -> `remainingAccounts` says how many are left; the Engine asks again.
 *
 * Fees follow the swap rule (design 7.5): the bot sets one limit (ceil(units x 1.2) from a measuring simulation, capped at 400 000) and one
 * price from the estimator at level 'normal'; ext-verify's close profile then re-checks the bytes and simulates every writable account.
 */
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { buildCloseAccountInstruction } from './close-ix';
import { cuLimitFromUnits, priorityFeeLamports, WALLET_CU_LIMIT_MAX } from './compute-budget';
import { LAMPORTS_PER_SIGNATURE, simulateUnits, verifyCloseTx, type CloseExpectation, type CloseTarget } from './ext-verify';
import { compileWalletTx, DEFAULT_PRIORITY_MAX_MICROLAMPORTS, DEFAULT_PRIORITY_MIN_MICROLAMPORTS, DEFAULT_WALLET_TX_MAX_BYTES, estimatePriorityPrice, latestBlockhash } from './unsigned-swap';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, deriveAtaAddress, readOwnedTokenAccounts, readSolBalance, type OwnedTokenAccount,
} from './wallet-reads';
import { refusalFromError, walletRefusal, type WalletClock, type WalletRpcPort } from './wallet-rpc';
import { WALLET_LINK_BUDGET_MS } from '../shared/contract/wallet-link';
import type { WalletCloseAccount, WalletCloseExcluded, WalletCloseQuoteOk, WalletCloseQuoteRequest, WalletLinkRefusal } from '../shared/contract/wallet-link';
import { WALLET_TX_BYTES_HARD_MAX, isBase58Pubkey } from '../shared/contract/wallet-validate';

/**
 * The tested close-batch maximum: ten CloseAccount instructions plus the compute-budget pair fit far below WALLET_TX_MAX_BYTES (1100); the
 * test serializes a full batch. The Engine's WALLET_CLOSE_BATCH default is this number and it is never above it (the link validator's own
 * list limit is the same 10).
 */
export const WALLET_CLOSE_BATCH_DEFAULT = 10;
export const WALLET_CLOSE_BATCH_HARD_MAX = 10;
/** The closer's own budget (design 6.8): 10 s. */
export const WALLET_CLOSE_QUOTE_BUDGET_MS = WALLET_LINK_BUDGET_MS.closeQuote.bot;

export interface UnsignedCloseDeps {
  rpc: WalletRpcPort;
  clock: WalletClock;
  priorityRange?: { minPrice: number; maxPrice: number };
  maxTxBytes?: number;
  budgetMs?: number;
  /** WALLET_CLOSE_BATCH: accounts per transaction (1..10, default 10). */
  batchMax?: number;
  /** true when the owner bought this mint a moment ago (the fresh-buy grace of 90 s): the account is skipped, reason 'recent-buy'. */
  freshBuy?: (mint: string) => boolean;
}

const isRefusal = (x: unknown): x is WalletLinkRefusal => typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;
const programId = (a: OwnedTokenAccount): string => (a.program === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);

export interface CloseSelection { batch: OwnedTokenAccount[]; excluded: WalletCloseExcluded[]; remaining: number }

/** Pure: which accounts a close takes, which it skips and why. */
export function selectCloseTargets(
  kind: 'empty' | 'unwrap', owner: string, owned: readonly OwnedTokenAccount[], requested: readonly string[] | undefined, excludedByEngine: ReadonlySet<string>,
  batchMax: number, freshBuy: (mint: string) => boolean,
): CloseSelection {
  const excluded: WalletCloseExcluded[] = [];
  const byAccount = new Map(owned.map((a) => [a.account, a] as const));
  const skipReason = (a: OwnedTokenAccount, empty: boolean): string | null => {
    if (excludedByEngine.has(a.account)) return 'engine-excluded';
    if (empty && BigInt(a.amountRaw) > 0n) return 'has-balance';
    if (a.frozen !== false) return 'frozen';
    if (a.closeAuthority !== null && a.closeAuthority !== owner) return 'close-authority';
    if (BigInt(a.withheldFee) > 0n) return 'withheld-fees';
    if (freshBuy(a.mint)) return 'recent-buy';
    return null;
  };
  if (kind === 'unwrap') {
    const wsolAta = deriveAtaAddress(owner, WSOL_MINT, TOKEN_PROGRAM_ID);
    const a = byAccount.get(wsolAta);
    if (!a) return { batch: [], excluded: [], remaining: 0 };
    const why = skipReason(a, false);
    if (why) return { batch: [], excluded: [{ account: a.account, reason: why }], remaining: 0 };
    return { batch: [a], excluded: [], remaining: 0 };
  }
  const eligible: OwnedTokenAccount[] = [];
  const considered = requested === undefined ? owned : requested.map((k) => byAccount.get(k) ?? k);
  for (const x of considered) {
    if (typeof x === 'string') { excluded.push({ account: x, reason: 'not-found' }); continue; }
    const why = skipReason(x, true);
    if (why === null) { eligible.push(x); continue; }
    // discovery lists only the accounts that are empty but cannot be closed; a requested account is always answered
    if (requested !== undefined || why !== 'has-balance') excluded.push({ account: x.account, reason: why });
  }
  const batch = eligible.slice(0, batchMax);
  return { batch, excluded, remaining: eligible.length - batch.length };
}

function validate(req: WalletCloseQuoteRequest, batchMax: number): WalletLinkRefusal | null {
  const bad = (m: string): WalletLinkRefusal => walletRefusal('bad-request', m);
  if (!isBase58Pubkey(req.owner)) return bad('owner must be a 32-byte base58 address');
  if (req.kind !== 'empty' && req.kind !== 'unwrap') return bad('kind must be empty or unwrap');
  if (!Array.isArray(req.excluded) || !req.excluded.every((k) => isBase58Pubkey(k))) return bad('excluded must list base58 addresses');
  if (req.accounts !== undefined) {
    if (!Array.isArray(req.accounts) || req.accounts.length === 0 || req.accounts.length > batchMax || !req.accounts.every((k) => isBase58Pubkey(k))) {
      return bad(`accounts must list 1 to ${batchMax} base58 addresses`);
    }
    if (new Set(req.accounts).size !== req.accounts.length) return bad('accounts must not repeat an account');
    if (req.kind === 'unwrap') return bad('an unwrap takes no account list');
  }
  return null;
}

export async function buildUnsignedClose(deps: UnsignedCloseDeps, req: WalletCloseQuoteRequest): Promise<WalletCloseQuoteOk | WalletLinkRefusal> {
  const batchMax = Math.max(1, Math.min(deps.batchMax ?? WALLET_CLOSE_BATCH_DEFAULT, WALLET_CLOSE_BATCH_HARD_MAX));
  const invalid = validate(req, batchMax);
  if (invalid) return invalid;
  const clock = deps.clock;
  const deadline = clock.now() + (deps.budgetMs ?? WALLET_CLOSE_QUOTE_BUDGET_MS);
  const range = deps.priorityRange ?? { minPrice: DEFAULT_PRIORITY_MIN_MICROLAMPORTS, maxPrice: DEFAULT_PRIORITY_MAX_MICROLAMPORTS };
  const txCap = Math.min(deps.maxTxBytes ?? DEFAULT_WALLET_TX_MAX_BYTES, WALLET_TX_BYTES_HARD_MAX);
  const opts = (): { timeoutMs: number } => ({ timeoutMs: Math.max(250, deadline - clock.now()) });
  const owner = req.owner;
  const ownerPk = new PublicKey(owner);

  let balance: { lamports: bigint; slot: number };
  let owned: OwnedTokenAccount[];
  let blockhash: string;
  let price: { price: number; unavailable: boolean };
  try {
    const [b, o, bh, pr] = await Promise.all([
      readSolBalance(deps.rpc, owner, opts()),
      readOwnedTokenAccounts(deps.rpc, owner, opts()),
      latestBlockhash(deps.rpc, opts()),
      estimatePriorityPrice(deps.rpc, [owner, TOKEN_PROGRAM_ID], 'normal', range, opts()),
    ]);
    balance = b; owned = o.accounts; blockhash = bh; price = pr;
  } catch (e) { return refusalFromError(e); }

  const sel = selectCloseTargets(req.kind, owner, owned, req.accounts, new Set(req.excluded), batchMax, deps.freshBuy ?? (() => false));
  if (sel.batch.length === 0) {
    return walletRefusal('nothing-to-close', req.kind === 'unwrap' ? 'the wallet has no wrapped-SOL account to close' : 'no empty token account can be closed here');
  }
  const ixs: TransactionInstruction[] = sel.batch.map((a) => buildCloseAccountInstruction(programId(a), a.account, ownerPk));
  const measuringTx = compileWalletTx(ownerPk, blockhash, ixs, WALLET_CU_LIMIT_MAX, price.price);
  const measuring = measuringTx.serialize();
  if (measuring.length > txCap) return walletRefusal('tx-too-large', `the transaction is ${measuring.length} bytes, above the ${txCap} byte cap`);
  const mm = measuringTx.message;
  const programOf = (i: number): string | null => { const ix = mm.compiledInstructions[i]; return ix ? mm.staticAccountKeys[ix.programIdIndex]?.toBase58() ?? null : null; };
  const s1 = await simulateUnits(deps.rpc, measuring, programOf, opts().timeoutMs);
  const network = LAMPORTS_PER_SIGNATURE;
  if (isRefusal(s1)) {
    const upper = network + priorityFeeLamports(WALLET_CU_LIMIT_MAX, price.price);
    if (s1.code === 'simulation-failed' && balance.lamports < upper) {
      return walletRefusal('insufficient-sol', 'the wallet balance is below the fees of this transaction', { needLamports: upper.toString(), haveLamports: balance.lamports.toString() });
    }
    return s1;
  }
  const cuLimit = cuLimitFromUnits(s1.value.unitsConsumed);
  const fee = priorityFeeLamports(cuLimit, price.price);
  const maxOutflow = network + fee;
  if (maxOutflow > balance.lamports) {
    return walletRefusal('insufficient-sol', 'the wallet balance is below the fees of this transaction', { needLamports: maxOutflow.toString(), haveLamports: balance.lamports.toString() });
  }
  const finalBytes = compileWalletTx(ownerPk, blockhash, ixs, cuLimit, price.price).serialize();
  const targets: CloseTarget[] = sel.batch.map((a) => ({
    account: a.account, mint: a.mint, program: programId(a), tokenOwner: owner, amountRaw: BigInt(a.amountRaw), lamports: BigInt(a.lamports),
    frozen: a.frozen !== false, closeAuthority: a.closeAuthority, withheldFee: BigInt(a.withheldFee),
  }));
  const exp: CloseExpectation = {
    kind: req.kind, owner, accounts: targets, excluded: new Set(req.excluded), cuLimit, cuPriceMicrolamports: price.price, priorityFeeLamports: fee,
    networkFeeLamports: network, maxOutflowLamports: maxOutflow, balanceLamports: balance.lamports,
  };
  const v = await verifyCloseTx({ rpc: deps.rpc, priorityRange: range, maxTxBytes: txCap, timeoutMs: opts().timeoutMs }, finalBytes, exp);
  if (isRefusal(v)) return v;
  const now = clock.now();
  const accounts: WalletCloseAccount[] = sel.batch.map((a) => ({ account: a.account, mint: a.mint, program: a.program, rentLamports: a.lamports }));
  return {
    ok: true,
    quote: {
      kind: req.kind, accounts, excluded: sel.excluded, remainingAccounts: sel.remaining, returnedLamports: v.value.returnedLamports.toString(),
      wsolAmount: req.kind === 'unwrap' ? sel.batch[0].amountRaw : null,
      networkFeeLamports: network.toString(), priorityFee: { cuLimit, cuPriceMicrolamports: price.price, lamports: fee.toString() }, maxOutflowLamports: maxOutflow.toString(),
      simulatedDeltas: { sol: { baseUnits: v.value.ownerDeltaLamports.toString(), decimals: 9, asset: 'SOL' } },
      programs: v.value.programs, txBytes: finalBytes.length, txBase64: Buffer.from(finalBytes).toString('base64'), minContextSlot: v.value.slot,
      simulatedAt: now, builtAt: now,
    },
  };
}
