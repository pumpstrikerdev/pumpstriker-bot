/**
 * COMPUTE BUDGET — the priority fee a transaction commits to (pure; R7-W5 extraction out of tx-verify.ts, A-104).
 *
 * `computeBudgetFeeLamports` moved here UNCHANGED from tx-verify.ts, which re-exports it (and `PriorityFeeResult`) under the same
 * names. It has no dependency on the signing code, the RPC layer or exec-common.ts, so the unsigned wallet builders and the
 * wallet verifier (ext-verify.ts) can use it without pulling a signing module into their import closure (G-S19).
 *
 * New in this file for the wallet flows (design 7.4 V2, 7.5): `walletComputeBudget` (exactly one limit <= 400 000 and one price in
 * the configured range, nothing else), the limit rule `ceil(units x 1.2)` capped at 400 000, and the two instruction builders.
 *
 * FIX-BUY (2026-11-06, 38HZ... reverted with ComputationalBudgetExceeded): the compute budget of the Jupiter /swap/v2/build (Helius
 * Sender) path. The limit is the measured units under the same rule (at least the old fixed 200 000, at most the runtime's 1 400 000),
 * and Jupiter's unit price is scaled so the priority fee is never above what that price cost at the old 200 000 limit.
 *
 * FIX-BUY2 item 3, against Jupiter's compute-units page (simulate the full transaction at 1 400 000 with replaceRecentBlockhash, sign
 * min(ceil(units x 1.2), 1 400 000), clamp the price to your own maximum): the measuring rule above already follows it; Jupiter's price is
 * now clamped to the caller's maximum before it is scaled. Two documented deviations are kept on purpose: the 200 000 floor (a light route
 * keeps its bytes and price) and 600 000 instead of 1 400 000 when no units come back (under the fee rule a smaller limit keeps a higher
 * price per unit; FIXBUY-T04 pins it).
 */
import { ComputeBudgetProgram, type TransactionInstruction, type VersionedTransaction } from '@solana/web3.js';

export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';

/** Compute-budget instruction tags (ComputeBudgetInstruction enum of the Solana runtime). */
export const CB_REQUEST_UNITS_DEPRECATED = 0;
export const CB_REQUEST_HEAP_FRAME = 1;
export const CB_SET_UNIT_LIMIT = 2;
export const CB_SET_UNIT_PRICE = 3;
export const CB_SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 4;
/** Runtime defaults: 200_000 units per instruction that is not a compute-budget instruction, at most 1_400_000 in all. */
export const DEFAULT_UNITS_PER_INSTRUCTION = 200_000n;
export const MAX_COMPUTE_UNITS = 1_400_000n;

export type PriorityFeeResult = { ok: true; lamports: bigint } | { ok: false; reason: string };

/**
 * The priority fee in lamports a transaction commits to through its ComputeBudget instructions. Fails closed: a
 * deprecated RequestUnits instruction (it can carry an extra fee), a duplicated limit or price instruction, an unknown or
 * malformed ComputeBudget instruction, or a program index outside the static keys is a refusal. No price instruction
 * means no priority fee (0). Without a limit instruction the runtime default applies (200_000 units per other instruction).
 */
export function computeBudgetFeeLamports(tx: VersionedTransaction): PriorityFeeResult {
  const msg = tx.message;
  const staticKeys = msg.staticAccountKeys.map((k) => k.toBase58());
  let limit: bigint | null = null;
  let price: bigint | null = null;
  let others = 0n;
  for (const ix of msg.compiledInstructions) {
    if (ix.programIdIndex >= staticKeys.length) return { ok: false, reason: 'program id outside the static account keys' };
    if (staticKeys[ix.programIdIndex] !== COMPUTE_BUDGET_PROGRAM_ID) {
      others++;
      continue;
    }
    const data = Buffer.from(ix.data);
    const tag = data.length > 0 ? data[0] : -1;
    if (tag === CB_SET_UNIT_LIMIT) {
      if (data.length !== 5) return { ok: false, reason: 'malformed SetComputeUnitLimit' };
      if (limit !== null) return { ok: false, reason: 'duplicate SetComputeUnitLimit' };
      limit = BigInt(data.readUInt32LE(1));
    } else if (tag === CB_SET_UNIT_PRICE) {
      if (data.length !== 9) return { ok: false, reason: 'malformed SetComputeUnitPrice' };
      if (price !== null) return { ok: false, reason: 'duplicate SetComputeUnitPrice' };
      price = data.readBigUInt64LE(1);
    } else if (tag === CB_REQUEST_HEAP_FRAME || tag === CB_SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT) {
      continue;   // no fee in these
    } else if (tag === CB_REQUEST_UNITS_DEPRECATED) {
      return { ok: false, reason: 'deprecated ComputeBudget RequestUnits instruction' };
    } else {
      return { ok: false, reason: 'unknown ComputeBudget instruction' };
    }
  }
  if (price === null) return { ok: true, lamports: 0n };
  let units = limit ?? others * DEFAULT_UNITS_PER_INSTRUCTION;
  if (units > MAX_COMPUTE_UNITS) units = MAX_COMPUTE_UNITS;
  return { ok: true, lamports: (price * units + 999_999n) / 1_000_000n };
}

// ── wallet flows (design 7.4 V2 and 7.5) ─────────────────────────────────────────────────────────────────────────────────────

/** The hard ceiling of the compute-unit limit of a wallet transaction. */
export const WALLET_CU_LIMIT_MAX = 400_000;
/** The measured units are multiplied by 1.2 (12 / 10), rounded up, then capped at WALLET_CU_LIMIT_MAX. */
export const WALLET_CU_HEADROOM_NUM = 12n;
export const WALLET_CU_HEADROOM_DEN = 10n;

/** ceil(units x 1.2) capped at `cap` (default 400 000, the wallet ceiling) and at least 1. Integer arithmetic only. */
export function cuLimitFromUnits(unitsConsumed: number | bigint, cap: number = WALLET_CU_LIMIT_MAX): number {
  const u = BigInt(unitsConsumed);
  if (u <= 0n) return 1;
  const l = (u * WALLET_CU_HEADROOM_NUM + WALLET_CU_HEADROOM_DEN - 1n) / WALLET_CU_HEADROOM_DEN;
  return Number(l > BigInt(cap) ? BigInt(cap) : l);
}

/** The priority fee the two instructions commit to: ceil(limit x price / 1e6) lamports (price in micro-lamports per compute unit). */
export function priorityFeeLamports(cuLimit: number | bigint, cuPriceMicrolamports: number | bigint): bigint {
  return (BigInt(cuLimit) * BigInt(cuPriceMicrolamports) + 999_999n) / 1_000_000n;
}

export function setCuLimitInstruction(units: number): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitLimit({ units });
}
export function setCuPriceInstruction(microLamports: number): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
}

export interface WalletComputeBudget {
  cuLimit: number;
  cuPriceMicrolamports: number;
  /** ceil(limit x price / 1e6): the number computeBudgetFeeLamports computes from the same bytes. */
  feeLamports: bigint;
}
export type WalletComputeBudgetResult = { ok: true; value: WalletComputeBudget } | { ok: false; reason: string };

/**
 * Design 7.4 V2: exactly ONE SetComputeUnitLimit with units <= 400 000 and exactly ONE SetComputeUnitPrice with a price in
 * [minPrice, maxPrice] micro-lamports per unit. Any other ComputeBudget instruction (RequestHeapFrame,
 * SetLoadedAccountsDataSizeLimit, the deprecated RequestUnits, an unknown tag), a missing one or a malformed one is a refusal.
 * The fee comes from computeBudgetFeeLamports over the same bytes, so the number the caller compares with the disclosed line is
 * the one the runtime charges.
 */
export function walletComputeBudget(tx: VersionedTransaction, range: { minPrice: number; maxPrice: number }): WalletComputeBudgetResult {
  const staticKeys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  let limit: number | null = null;
  let price: bigint | null = null;
  for (const ix of tx.message.compiledInstructions) {
    if (ix.programIdIndex >= staticKeys.length) return { ok: false, reason: 'program id outside the static account keys' };
    if (staticKeys[ix.programIdIndex] !== COMPUTE_BUDGET_PROGRAM_ID) continue;
    const data = Buffer.from(ix.data);
    const tag = data.length > 0 ? data[0] : -1;
    if (tag === CB_SET_UNIT_LIMIT) {
      if (data.length !== 5) return { ok: false, reason: 'malformed SetComputeUnitLimit' };
      if (limit !== null) return { ok: false, reason: 'more than one SetComputeUnitLimit' };
      limit = data.readUInt32LE(1);
    } else if (tag === CB_SET_UNIT_PRICE) {
      if (data.length !== 9) return { ok: false, reason: 'malformed SetComputeUnitPrice' };
      if (price !== null) return { ok: false, reason: 'more than one SetComputeUnitPrice' };
      price = data.readBigUInt64LE(1);
    } else if (tag === CB_REQUEST_HEAP_FRAME) {
      return { ok: false, reason: 'ComputeBudget RequestHeapFrame is not allowed' };
    } else if (tag === CB_SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT) {
      return { ok: false, reason: 'ComputeBudget SetLoadedAccountsDataSizeLimit is not allowed' };
    } else if (tag === CB_REQUEST_UNITS_DEPRECATED) {
      return { ok: false, reason: 'deprecated ComputeBudget RequestUnits instruction' };
    } else {
      return { ok: false, reason: 'unknown ComputeBudget instruction' };
    }
  }
  if (limit === null) return { ok: false, reason: 'no SetComputeUnitLimit' };
  if (price === null) return { ok: false, reason: 'no SetComputeUnitPrice' };
  if (limit < 1 || limit > WALLET_CU_LIMIT_MAX) return { ok: false, reason: `compute unit limit ${limit} outside 1..${WALLET_CU_LIMIT_MAX}` };
  if (price < BigInt(range.minPrice) || price > BigInt(range.maxPrice)) {
    return { ok: false, reason: `compute unit price ${price} outside ${range.minPrice}..${range.maxPrice} micro-lamports` };
  }
  const fee = computeBudgetFeeLamports(tx);
  if (!fee.ok) return { ok: false, reason: fee.reason };
  return { ok: true, value: { cuLimit: limit, cuPriceMicrolamports: Number(price), feeLamports: fee.lamports } };
}

// ── the Jupiter Sender path (FIX-BUY) ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The limit the Jupiter /swap/v2/build path signed for every route before FIX-BUY. It is now the fee reference: whatever limit the bot
 * signs, the priority fee is at most what Jupiter's unit price cost at this many units.
 */
export const JUP_SENDER_REFERENCE_CU = 200_000;
/** The limit signed when the units could not be measured (no simulation answer in time): more than twice what 38HZ... needed. */
export const JUP_SENDER_FALLBACK_CU = 600_000;

/** The limit of a Sender transaction from its measured units: ceil(units x 1.2), at least the old 200 000, at most 1 400 000. */
export function senderLimitFromUnits(unitsConsumed: number | bigint): number {
  return Math.max(JUP_SENDER_REFERENCE_CU, cuLimitFromUnits(unitsConsumed, Number(MAX_COMPUTE_UNITS)));
}

/**
 * Jupiter's unit price for a transaction signed with `limit` units: the highest price, never above Jupiter's own, whose fee
 * ceil(limit x price / 1e6) is at most the fee that price cost at the reference limit, ceil(200 000 x price / 1e6). At the reference
 * limit it is Jupiter's price unchanged. It reaches 0 only when that reference fee is 1 lamport (a price of at most 5) and the limit is
 * above 1 000 000. Integer arithmetic only.
 */
export function senderUnitPrice(jupiterPrice: bigint, limit: number): bigint {
  const referenceFee = (BigInt(JUP_SENDER_REFERENCE_CU) * jupiterPrice + 999_999n) / 1_000_000n;
  const fits = (referenceFee * 1_000_000n) / BigInt(limit);
  return fits < jupiterPrice ? fits : jupiterPrice;
}

const CB_NAMES: Record<number, string> = {
  [CB_REQUEST_HEAP_FRAME]: 'RequestHeapFrame', [CB_SET_UNIT_LIMIT]: 'SetComputeUnitLimit', [CB_SET_UNIT_PRICE]: 'SetComputeUnitPrice',
  [CB_SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT]: 'SetLoadedAccountsDataSizeLimit',
};

export type SenderComputeBudgetResult =
  | { ok: true; instructions: TransactionInstruction[]; cuLimit: number; cuPrice: bigint | null }
  | { ok: false; reason: string };

/** The largest u64: a SetComputeUnitPrice argument cannot be above it. */
const U64_MAX = 18_446_744_073_709_551_615n;

/** How the unit price of a /swap/v2/build transaction is chosen (FIX-BUY2). */
export interface SenderBudgetOpts {
  /**
   * FIX-BUY2 item 3: Jupiter's SetComputeUnitPrice is clamped to this (micro-lamports per unit) BEFORE it is scaled to the limit. Jupiter's
   * compute-units page: clamp the price to your own maximum, spikes inflate the percentile. The server path passes
   * PRIORITY_FEE_CEILING_MICROLAMPORTS (5 000 000 by default): the fee is then at most ceil(200 000 x 5 000 000 / 1e6) = 1 000 000 lamports.
   * Absent: no clamp (the FIX-BUY behaviour).
   */
  maxPrice?: bigint;
  /**
   * FIX-BUY2 item 4, the no-tip (multi-RPC) lane: the owner's priority fee in lamports, spread over the signed limit:
   * price = floor(fee x 1 000 000 / limit) micro-lamports per unit, so the fee ceil(limit x price / 1e6) is at most `fixedFeeLamports`
   * (what /swap/v1/swap charged through prioritizationFeeLamports). Jupiter's own price is then ignored (still read and checked), and the
   * price instruction is always written (0 included), so the measured and the signed transaction have the same instructions.
   */
  fixedFeeLamports?: bigint;
}

/**
 * The compute-budget instructions of a /swap/v2/build transaction, from the `computeBudgetInstructions` of Jupiter's build answer:
 *   [SetComputeUnitLimit(limit), SetComputeUnitPrice(senderUnitPrice(min(P, maxPrice), limit)) when Jupiter sent a price P, then Jupiter's
 *    RequestHeapFrame / SetLoadedAccountsDataSizeLimit as they came].
 * With `fixedFeeLamports` (the no-tip lane) the price is floor(fee x 1e6 / limit) instead, always written, and Jupiter's price is ignored.
 * Jupiter's own SetComputeUnitLimit is dropped: the bot's is the only one (two would make the runtime refuse the transaction).
 * Refused (fail closed, nothing is repaired): an instruction of another program, the deprecated RequestUnits (it can carry a fee), an
 * unknown tag, malformed data, an instruction that comes twice, a limit outside 1 .. 1 400 000, and a maxPrice outside 0 .. u64.
 */
export function senderComputeBudget(jupiterIxs: readonly TransactionInstruction[], limit: number, opts: SenderBudgetOpts = {}): SenderComputeBudgetResult {
  if (!Number.isSafeInteger(limit) || limit < 1 || BigInt(limit) > MAX_COMPUTE_UNITS) {
    return { ok: false, reason: `compute unit limit ${limit} outside 1..${MAX_COMPUTE_UNITS}` };
  }
  const maxPrice = opts.maxPrice;
  if (maxPrice !== undefined && (typeof maxPrice !== 'bigint' || maxPrice < 0n || maxPrice > U64_MAX)) {
    return { ok: false, reason: 'maximum compute unit price outside 0..u64' };
  }
  const fixedFee = opts.fixedFeeLamports;
  if (fixedFee !== undefined && (typeof fixedFee !== 'bigint' || fixedFee < 0n || fixedFee > U64_MAX / 1_000_000n)) {
    return { ok: false, reason: 'fixed priority fee outside 0..u64 / 1e6 lamports' };
  }
  let price: bigint | null = null;
  const kept: TransactionInstruction[] = [];
  const seen = new Set<number>();
  for (const ix of jupiterIxs) {
    if (ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM_ID) return { ok: false, reason: 'a Jupiter compute-budget instruction is not a ComputeBudget instruction' };
    const data = Buffer.from(ix.data);
    const tag = data.length > 0 ? data[0] : -1;
    if (tag === CB_REQUEST_UNITS_DEPRECATED) return { ok: false, reason: 'deprecated ComputeBudget RequestUnits instruction' };
    const name = CB_NAMES[tag];
    if (name === undefined) return { ok: false, reason: 'unknown ComputeBudget instruction' };
    if (data.length !== (tag === CB_SET_UNIT_PRICE ? 9 : 5)) return { ok: false, reason: `malformed ${name}` };
    if (seen.has(tag)) return { ok: false, reason: `more than one ${name}` };
    seen.add(tag);
    if (tag === CB_SET_UNIT_PRICE) price = data.readBigUInt64LE(1);
    else if (tag !== CB_SET_UNIT_LIMIT) kept.push(ix);           // Jupiter's limit is dropped; heap frame and loaded-data limit stay
  }
  // FIX-BUY2 item 3: Jupiter's price is clamped to the bot's own maximum first (tag 3, u64 LE at byte 1), then scaled to the limit.
  // FIX-BUY2 item 4: with a fixed fee, the owner's fee spread over the limit replaces Jupiter's price.
  if (price !== null && maxPrice !== undefined && price > maxPrice) price = maxPrice;
  const cuPrice = fixedFee !== undefined ? (fixedFee * 1_000_000n) / BigInt(limit) : price === null ? null : senderUnitPrice(price, limit);
  return {
    ok: true, cuLimit: limit, cuPrice,
    instructions: [setCuLimitInstruction(limit), ...(cuPrice === null ? [] : [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice })]), ...kept],
  };
}
