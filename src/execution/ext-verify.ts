/**
 * EXT VERIFY — the pre-hand-off verifier of every wallet-flow transaction (R7-W5, A-104, design 7.4 and 10.1, rev 3 R3-5).
 *
 * The bot builds an UNSIGNED transaction for an external payer; nothing reaches the wallet until this file has checked the BYTES (not
 * the builder's intentions) and a simulation of the resolved message. It fails closed: any decoding problem, unreadable table, RPC
 * error or unreadable delta is a refusal with a redacted reason of at most 200 characters.
 *
 * Common checks (both profiles):  V1 one required signature, the fee payer is the owner, the signature slot is all zero.
 *   V2 exactly one SetComputeUnitLimit (<= 400 000) and one SetComputeUnitPrice in [min, max], nothing else of the ComputeBudget
 *      program; the fee they commit to equals the disclosed line.   V3 the serialized size is within the cap.
 * Swap profile:  S1 program allowlist per route.  S2 System: only Transfer from the owner to the owner's own wSOL account (followed by
 *   SyncNative of it, within the maximum spend) or to a disclosed recipient with the exact amount; every destination is a STATIC key.
 *   S3 token programs: only CreateIdempotent for the owner (trade mint or wSOL, the derived account), SyncNative and CloseAccount of
 *   the owner's wSOL account to the owner.  S4 the wSOL account holds nothing when the route wraps or closes it.  S5 exactly one trade
 *   instruction, decoded: pump (`buy_exact_sol_in` / `sell` only, the builder's positions), PumpSwap (the IDL positions), Jupiter (the
 *   pinned exact-in layouts, platform fee 0); the disclosed bound follows the slippage rule.  S6 lookup tables are read from the chain
 *   (never trusted from the third party): a deactivated or unreadable table, a claim that differs from the chain, an owner key in a lookup
 *   are refusals.  S7 the maximum outflow is recomputed from the bytes and equals the disclosed one; it fits the balance and the cap.
 *   S8 a simulation of every writable account: no error, the outflow within the maximum, the output within the bound, no other account
 *   of the owner changed (amount, owner, delegate, close authority), the inner-program fee accounts measured for disclosure.
 * Close profile:  C1 only ComputeBudget, Token, Token-2022.  C2 only CloseAccount [9] and the V2 pair.  C3 every account per the build's
 *   own read (owned by the owner, empty or the owner's wSOL account, not frozen, no foreign close authority, no withheld fees, not
 *   excluded).  C4 destination and authority are the owner, the program is the account's own.  C5 the simulation shows exactly the
 *   returned lamports minus the fees, and nothing else changes.  C6 V1 and V3.
 *
 * Nothing here signs, sends or builds; it reads through the injected wallet RPC port only.
 */
import { AddressLookupTableAccount, PublicKey, VersionedTransaction, type MessageV0, type TransactionInstruction } from '@solana/web3.js';
import { COMPUTE_BUDGET_PROGRAM_ID, walletComputeBudget } from './compute-budget';
import { buildBuyInstruction, buildSellInstruction } from './pumpfun-ix';
import { PUMP_BUY_DATA_LEN, PUMP_BUYBACK_FEE_RECIPIENTS, PUMP_FEE_RECIPIENTS_NORMAL, PUMP_SELL_DATA_LEN, PUMP_TRACK_VOLUME } from './pump-program';
import { buildPumpSwapBuyInstruction, buildPumpSwapSellInstruction, type PoolRefs } from './pumpswap-ix';
import {
  ATA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, deriveAtaAddress, isSlippageError, parseChainAccount, parseSplTokenAccount, readAccounts,
  type ChainAccount,
} from './wallet-reads';
import { refusalFromError, walletRefusal, type WalletRpcPort } from './wallet-rpc';
import { ownerTokenAccountsRefusal } from './sim-owner-checks';
import type { WalletLinkRefusal } from '../shared/contract/wallet-link';

// ── constants (public program ids) ───────────────────────────────────────────────────────────────────────────────────────────

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const JUPITER_V6_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = 'AddressLookupTab1e1111111111111111111111111';
/** Bytes of a token account used for the rent bound (design 7.4 S7): 300 covers Token-2022 accounts with their extensions. */
export const WALLET_ATA_RENT_BYTES = 300;
export const LAMPORTS_PER_SIGNATURE = 5_000n;
/** The most writable accounts a simulation can return the state of. */
export const MAX_SIMULATED_ACCOUNTS = 64;
const U64_MAX = 18446744073709551615n;

/**
 * The pinned exact-in Jupiter v6 swap layouts (design 7.4 S5). Discriminators: sha256("global:<name>")[0..8] (computed locally, pinned
 * in test-fixtures/execution/wallet/jupiter-ix-pin.json, which a test keeps equal to this table). Account positions are from the Jupiter v6
 * IDL (see the fixture's `positionsStatus`: not fetched in the offline build, re-checked by the owner before go-live); a wrong position
 * only makes the verifier refuse a real route (fail closed). The fixed-size TAIL of the data, read from the END, is
 * `in_amount u64, quoted_out_amount u64, slippage_bps u16, platform_fee_bps u8` (19 bytes). Exact-out and token-ledger variants are not accepted.
 */
export interface JupiterVariantPin {
  name: 'route' | 'shared_accounts_route';
  discriminator: readonly number[];
  minAccounts: number;
  positions: { userTransferAuthority: number; userSource: number; userDestination: number; sourceMint: number | null; destinationMint: number };
}
export const JUPITER_TAIL_BYTES = 19;
export const JUPITER_EXACT_IN_PINS: readonly JupiterVariantPin[] = [
  { name: 'route', discriminator: [229, 23, 203, 151, 122, 227, 173, 42], minAccounts: 9, positions: { userTransferAuthority: 1, userSource: 2, userDestination: 3, sourceMint: null, destinationMint: 5 } },
  { name: 'shared_accounts_route', discriminator: [193, 32, 155, 51, 65, 214, 156, 129], minAccounts: 13, positions: { userTransferAuthority: 2, userSource: 3, userDestination: 6, sourceMint: 7, destinationMint: 8 } },
];

const SYSTEM_IX_NAMES: Readonly<Record<number, string>> = {
  0: 'CreateAccount', 1: 'Assign', 2: 'Transfer', 3: 'CreateAccountWithSeed', 4: 'AdvanceNonceAccount', 5: 'WithdrawNonceAccount', 6: 'InitializeNonceAccount',
  7: 'AuthorizeNonceAccount', 8: 'Allocate', 9: 'AllocateWithSeed', 10: 'AssignWithSeed', 11: 'TransferWithSeed', 12: 'UpgradeNonceAccount',
};
const TOKEN_IX_NAMES: Readonly<Record<number, string>> = {
  0: 'InitializeMint', 1: 'InitializeAccount', 2: 'InitializeMultisig', 3: 'Transfer', 4: 'Approve', 5: 'Revoke', 6: 'SetAuthority', 7: 'MintTo', 8: 'Burn',
  10: 'FreezeAccount', 11: 'ThawAccount', 12: 'TransferChecked', 13: 'ApproveChecked', 14: 'MintToChecked', 15: 'BurnChecked', 16: 'InitializeAccount2', 18: 'InitializeAccount3',
};
const TOKEN_IX_CLOSE_ACCOUNT = 9;
const TOKEN_IX_SYNC_NATIVE = 17;

// ── expectations (what the builder says it built) ────────────────────────────────────────────────────────────────────────────

export type DisclosedBound =
  | { kind: 'exact_in'; amountIn: bigint; minOut: bigint }
  | { kind: 'exact_out'; exactOut: bigint; maxIn: bigint };

/** A fee charged INSIDE the swap program: the account whose balance change is measured (a wallet for lamports, a token account for tokens). */
export interface InnerFeeAccount { label: string; recipient: string; address: string; kind: 'lamports' | 'token' }

export interface SwapExpectation {
  route: 'pump' | 'pumpswap' | 'jupiter';
  side: 'buy' | 'sell';
  owner: string;
  mint: string;
  /** The mint's own token program (Token or Token-2022), from the build's chain read. */
  tokenProgram: string;
  /** The request's slippage in basis points (1-5000). */
  slippageBps: number;
  bound: DisclosedBound;
  quotedOut: bigint | null;
  quotedIn: bigint | null;
  /** sell: the exact token amount that must leave the trade account. */
  tokensRaw: bigint | null;
  cuLimit: number;
  cuPriceMicrolamports: number;
  priorityFeeLamports: bigint;
  networkFeeLamports: bigint;
  /** getMinimumBalanceForRentExemption(WALLET_ATA_RENT_BYTES): the rent bound of ONE CreateIdempotent. */
  rentMinLamports: bigint;
  rentLamports: bigint;
  maxOutflowLamports: bigint;
  thirdPartyTransfers: ReadonlyArray<{ recipient: string; lamports: bigint }>;
  /** The owner's SOL balance read in the same build. */
  balanceLamports: bigint;
  /** WALLET_TRADE_MAX_SOL as lamports, or null = no cap. */
  maxSpendCapLamports: bigint | null;
  /** The owner's wSOL account balance read in the same build; null = the account does not exist. */
  wsolPreAmount: bigint | null;
  /** pump route: the creator from the curve account. */
  creator?: string;
  /** PumpSwap route: the pool references from the pool account. */
  pool?: { pool: string; poolBaseAccount: string; poolQuoteAccount: string; coinCreator: string };
  /** Jupiter route: the lookup-table contents Jupiter CLAIMED (compared with the chain, never compiled against). */
  claimedTables?: Record<string, string[]> | null;
  innerFees: readonly InnerFeeAccount[];
}

export interface WalletVerifyDeps {
  rpc: WalletRpcPort;
  priorityRange: { minPrice: number; maxPrice: number };
  /** The size cap in bytes (WALLET_TX_MAX_BYTES, at most 1132). */
  maxTxBytes: number;
  timeoutMs?: number;
}

export interface VerifiedInnerFee { label: string; recipient: string; amountBase: bigint; asset: string; decimals: number }
export interface VerifiedSwap {
  unitsConsumed: number;
  /** The simulation's context slot. */
  slot: number;
  ownerDeltaLamports: bigint;
  tokenDelta: bigint;
  innerFees: VerifiedInnerFee[];
  programs: string[];
  rentBoundLamports: bigint;
  maxSpendLamports: bigint;
  maxOutflowLamports: bigint;
  /** Jupiter route: the tail decoded from the swap instruction. */
  jupiter: JupiterTail | null;
}
export type VerifyOutcome<T> = { ok: true; value: T } | WalletLinkRefusal;

export interface JupiterTail { inAmount: bigint; quotedOutAmount: bigint; slippageBps: number; platformFeeBps: number }
/** The fixed-size tail of a Jupiter exact-in swap instruction, read from the end of the data; null when the data is too short. */
export function decodeJupiterTail(data: Uint8Array): JupiterTail | null {
  if (data.length < 8 + JUPITER_TAIL_BYTES) return null;
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const o = b.length - JUPITER_TAIL_BYTES;
  return { inAmount: b.readBigUInt64LE(o), quotedOutAmount: b.readBigUInt64LE(o + 8), slippageBps: b.readUInt16LE(o + 16), platformFeeBps: b[o + 18] };
}
/** Which pinned exact-in variant an instruction's discriminator names; null for any other discriminator (exact-out, ledger, unknown). */
export function jupiterVariantOf(data: Uint8Array): JupiterVariantPin | null {
  if (data.length < 8) return null;
  return JUPITER_EXACT_IN_PINS.find((p) => p.discriminator.every((x, i) => data[i] === x)) ?? null;
}

// ── lookup tables (S6) ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every table the message names, read from the chain (confirmed) and decoded; throws on an unreadable, foreign or deactivated table. */
export async function readChainLookupTables(rpc: WalletRpcPort, keys: readonly string[], timeoutMs?: number): Promise<AddressLookupTableAccount[]> {
  if (keys.length === 0) return [];
  const { accounts } = await readAccounts(rpc, keys, { timeoutMs });
  return accounts.map((a, i) => {
    if (a === null) throw new Error(`lookup table ${i} is unreadable`);
    if (a.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM_ID) throw new Error(`lookup table ${i} is not owned by the lookup-table program`);
    const t = new AddressLookupTableAccount({ key: new PublicKey(keys[i]), state: AddressLookupTableAccount.deserialize(a.data) });
    if (t.state.deactivationSlot !== U64_MAX) throw new Error(`lookup table ${i} is deactivated`);
    return t;
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const fail = (reason: string): WalletLinkRefusal => walletRefusal('verify-failed', reason);
const isRefusal = (x: unknown): x is WalletLinkRefusal => typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const isZero = (a: Uint8Array): boolean => a.every((v) => v === 0);
const sameKeys = (actual: readonly string[], ix: TransactionInstruction): boolean => actual.length === ix.keys.length && ix.keys.every((k, i) => k.pubkey.toBase58() === actual[i]);

interface DecodedIx { index: number; program: string; programIdx: number; acc: number[]; accKeys: string[]; data: Buffer }
interface Resolved {
  tx: VersionedTransaction;
  msg: MessageV0;
  staticKeys: string[];
  keys: string[];
  ixs: DecodedIx[];
  writable: string[];
  tables: AddressLookupTableAccount[];
  loaded: Set<string>;
}

/** Decode the bytes and resolve the lookups against the CHAIN. A refusal for anything that cannot be decoded or resolved. */
async function decodeAndResolve(
  deps: WalletVerifyDeps, bytes: Uint8Array, owner: string, claimed: Record<string, string[]> | null | undefined, allowLookups: boolean,
): Promise<Resolved | WalletLinkRefusal> {
  const cap = Math.min(deps.maxTxBytes, 1132);
  if (bytes.length > cap) return walletRefusal('tx-too-large', `transaction is ${bytes.length} bytes, above the ${cap} byte cap`);
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(bytes); } catch { return fail('undecodable transaction'); }
  if (tx.version !== 0) return fail('only version 0 messages are accepted');
  const msg = tx.message as MessageV0;
  // V1
  if (msg.header.numRequiredSignatures !== 1) return fail(`extra signer: ${msg.header.numRequiredSignatures} required signatures`);
  const staticKeys = msg.staticAccountKeys.map((k) => k.toBase58());
  if (staticKeys[0] !== owner) return fail('fee payer is not the owner');
  if (tx.signatures.length !== 1 || !isZero(tx.signatures[0])) return fail('the signature slot is not all zero');
  // S6: lookup tables from the chain, on the Jupiter route only
  let tables: AddressLookupTableAccount[] = [];
  if (msg.addressTableLookups.length > 0 && !allowLookups) return fail('lookup tables are allowed on the Jupiter route only');
  if (msg.addressTableLookups.length > 0) {
    try { tables = await readChainLookupTables(deps.rpc, msg.addressTableLookups.map((l) => l.accountKey.toBase58()), deps.timeoutMs); } catch (e) {
      const r = refusalFromError(e, 'verify-failed');
      return r.code === 'rpc-budget' || r.code === 'build-timeout' ? r : fail(`lookup table: ${r.reason}`);
    }
  }
  const loadedWritable: string[] = [];
  const loadedReadonly: string[] = [];
  for (let i = 0; i < msg.addressTableLookups.length; i++) {
    const l = msg.addressTableLookups[i];
    const chain = tables[i].state.addresses;
    const table = l.accountKey.toBase58();
    for (const [idxs, into] of [[l.writableIndexes, loadedWritable], [l.readonlyIndexes, loadedReadonly]] as const) {
      for (const idx of idxs) {
        const a = chain[idx];
        if (a === undefined) return fail('lookup table index out of range');
        if (claimed !== undefined && claimed !== null) {
          const c = claimed[table];
          if (c === undefined || c[idx] !== a.toBase58()) return walletRefusal('alt-mismatch', 'a lookup table differs from the one the route claimed');
        } else if (claimed === null) {
          return walletRefusal('alt-mismatch', 'the route claimed no lookup table but the message uses one');
        }
        into.push(a.toBase58());
      }
    }
  }
  const keys = [...staticKeys, ...loadedWritable, ...loadedReadonly];
  const ixs: DecodedIx[] = [];
  for (let i = 0; i < msg.compiledInstructions.length; i++) {
    const ix = msg.compiledInstructions[i];
    if (ix.programIdIndex >= staticKeys.length) return fail('program id outside the static account keys');
    const accKeys: string[] = [];
    for (const a of ix.accountKeyIndexes) {
      const k = keys[a];
      if (k === undefined) return fail('instruction account index out of range');
      accKeys.push(k);
    }
    ixs.push({ index: i, program: staticKeys[ix.programIdIndex], programIdx: ix.programIdIndex, acc: [...ix.accountKeyIndexes], accKeys, data: Buffer.from(ix.data) });
  }
  const writable: string[] = [];
  for (let i = 0; i < keys.length; i++) if (msg.isAccountWritable(i) && !writable.includes(keys[i])) writable.push(keys[i]);
  return { tx, msg, staticKeys, keys, ixs, writable, tables, loaded: new Set([...loadedWritable, ...loadedReadonly]) };
}

// ── simulation ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface SimResult { unitsConsumed: number; slot: number; err: unknown; accounts: Array<ChainAccount | null> | null }

async function runSimulation(rpc: WalletRpcPort, txBytes: Uint8Array, addresses: readonly string[] | null, timeoutMs?: number): Promise<SimResult> {
  const cfg: Record<string, unknown> = { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' };
  if (addresses !== null) cfg.accounts = { encoding: 'base64', addresses: [...addresses] };
  const res = await rpc.call('simulateTransaction', [Buffer.from(txBytes).toString('base64'), cfg], { timeoutMs });
  const value = res?.value;
  const slot = res?.context?.slot;
  if (!value || typeof slot !== 'number') throw new Error('simulation returned no result');
  const units = value.unitsConsumed;
  let accounts: Array<ChainAccount | null> | null = null;
  if (addresses !== null && !value.err) {
    if (!Array.isArray(value.accounts) || value.accounts.length !== addresses.length) throw new Error('simulation accounts unreadable');
    accounts = value.accounts.map((v: unknown) => {
      const a = parseChainAccount(v);
      if (a === undefined) throw new Error('a simulated account could not be decoded');
      return a;
    });
  }
  return { unitsConsumed: typeof units === 'number' && Number.isSafeInteger(units) && units >= 0 ? units : -1, slot, err: value.err ?? null, accounts };
}

function errText(err: unknown): string {
  let t: string;
  try { t = JSON.stringify(err); } catch { t = 'error'; }
  return t.slice(0, 120);
}

/** A simulation error as a refusal: a pinned slippage code of the failing program is 'price-moved', anything else 'simulation-failed'. */
function simulationRefusal(err: unknown, programOf: (index: number) => string | null): WalletLinkRefusal {
  return isSlippageError(err, programOf)
    ? walletRefusal('price-moved', 'the price moved beyond the slippage while the trade was prepared')
    : walletRefusal('simulation-failed', `simulation failed: ${errText(err)}`);
}

/**
 * The measuring simulation (design 7.5): the transaction as built with the 400 000 limit, no accounts returned. Gives the units the
 * transaction consumed; the limit the bot signs is ceil(units x 1.2), capped (compute-budget.ts cuLimitFromUnits).
 */
export async function simulateUnits(rpc: WalletRpcPort, txBytes: Uint8Array, programOf: (index: number) => string | null, timeoutMs?: number): Promise<VerifyOutcome<{ unitsConsumed: number; slot: number }>> {
  let sim: SimResult;
  try { sim = await runSimulation(rpc, txBytes, null, timeoutMs); } catch (e) { return refusalFromError(e, 'simulation-failed'); }
  if (sim.err) return simulationRefusal(sim.err, programOf);
  if (sim.unitsConsumed <= 0) return walletRefusal('simulation-failed', 'simulation reported no compute units');
  return { ok: true, value: { unitsConsumed: sim.unitsConsumed, slot: sim.slot } };
}

const lamportsOf = (a: ChainAccount | null): bigint => (a === null ? 0n : a.lamports);
function tokenAmountOf(a: ChainAccount | null): bigint | null {
  if (a === null) return 0n;
  const t = parseSplTokenAccount(a.data);
  return t === null ? null : t.amount;
}

/**
 * The token accounts of the owner must not change except the trade account and the wSOL account, and no account (those two
 * included) may gain a delegate, a close authority or another owner. `allowed` accounts may change their AMOUNT (the checks of the
 * profile bound those separately). FIX-BUY2 item 7(e): the rule lives in sim-owner-checks.ts (shared with the /swap/v2/order fallback).
 */
function checkOwnerAccounts(owner: string, addresses: readonly string[], pre: ReadonlyArray<ChainAccount | null>, post: ReadonlyArray<ChainAccount | null>, allowed: ReadonlySet<string>): WalletLinkRefusal | null {
  const why = ownerTokenAccountsRefusal(owner, addresses, pre, post, allowed);
  return why === null ? null : fail(why);
}

// ── the swap profile ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function routeProgram(route: SwapExpectation['route']): string {
  return route === 'pump' ? PUMP_PROGRAM : route === 'pumpswap' ? PUMPSWAP_PROGRAM : JUPITER_V6_PROGRAM_ID;
}

/** floor(quoted x (10000 - slippage) / 10000): the lowest minimum out the slippage rule allows (rounding against the user). */
export function minOutFloor(quotedOut: bigint, slippageBps: number): bigint {
  return (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}
/** ceil(quoted x (10000 + slippage) / 10000): the highest maximum in the slippage rule allows (rounding against the user). */
export function maxInCeil(quotedIn: bigint, slippageBps: number): bigint {
  return (quotedIn * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
}

export async function verifySwapTx(deps: WalletVerifyDeps, bytes: Uint8Array, exp: SwapExpectation): Promise<VerifyOutcome<VerifiedSwap>> {
  if (exp.slippageBps < 1 || exp.slippageBps > 5000 || !Number.isInteger(exp.slippageBps)) return fail('slippage outside 1..5000 basis points');
  const dec = await decodeAndResolve(deps, bytes, exp.owner, exp.route === 'jupiter' ? exp.claimedTables ?? null : undefined, exp.route === 'jupiter');
  if (isRefusal(dec)) return dec;
  const { tx, ixs, staticKeys } = dec;

  // V2
  const cb = walletComputeBudget(tx, deps.priorityRange);
  if (!cb.ok) return fail(cb.reason);
  if (cb.value.cuLimit !== exp.cuLimit || cb.value.cuPriceMicrolamports !== exp.cuPriceMicrolamports || cb.value.feeLamports !== exp.priorityFeeLamports) {
    return fail('the compute budget differs from the disclosed priority-fee line');
  }

  const owner = exp.owner;
  const tokenProgramOk = exp.tokenProgram === TOKEN_PROGRAM_ID || exp.tokenProgram === TOKEN_2022_PROGRAM_ID;
  if (!tokenProgramOk) return fail('the mint is not owned by a token program');
  if (exp.mint === WSOL_MINT) return fail('the trade mint is the wrapped-SOL mint');
  const tradeAta = deriveAtaAddress(owner, exp.mint, exp.tokenProgram);
  const wsolAta = deriveAtaAddress(owner, WSOL_MINT, TOKEN_PROGRAM_ID);
  const ownerSpecific = [owner, tradeAta, wsolAta];
  const isStatic = (key: string): boolean => staticKeys.includes(key);
  // S6: an owner-specific key that was loaded from a lookup table instead of named in the static keys
  for (const k of ownerSpecific) if (dec.loaded.has(k)) return walletRefusal('owner-key-in-lookup', 'an owner key sits in a lookup table');

  // S1 and S2-S3 over every instruction
  const allowedPrograms = new Set([SYSTEM_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ATA_PROGRAM_ID, routeProgram(exp.route)]);
  let trade: DecodedIx | null = null;
  let tradeCount = 0;
  let createCount = 0;
  let touchesWsol = exp.route !== 'pump';
  let wrapTotal = 0n;
  const wrapAt: number[] = [];
  const syncAt: number[] = [];
  const thirdParty: Array<{ recipient: string; lamports: bigint }> = [];
  const programsSeen: string[] = [];

  for (const ix of ixs) {
    if (!programsSeen.includes(ix.program)) programsSeen.push(ix.program);
    if (!allowedPrograms.has(ix.program)) return fail(`program not allowed on the ${exp.route} route: ${ix.program}`);
    if (ix.program === COMPUTE_BUDGET_PROGRAM_ID) continue;

    if (ix.program === SYSTEM_PROGRAM_ID) {
      const type = ix.data.length >= 4 ? ix.data.readUInt32LE(0) : -1;
      if (type !== 2 || ix.data.length !== 12 || ix.acc.length !== 2) return fail(`system instruction not allowed: ${SYSTEM_IX_NAMES[type] ?? 'unknown'}`);
      if (ix.accKeys[0] !== owner || !isStatic(owner)) return fail('system transfer not from the owner');
      const lamports = ix.data.readBigUInt64LE(4);
      const to = ix.accKeys[1];
      if (ix.acc[1] >= staticKeys.length) return walletRefusal('owner-key-in-lookup', 'a transfer destination is a lookup-table index');
      if (to === wsolAta) {
        wrapTotal += lamports;
        wrapAt.push(ix.index);
        touchesWsol = true;
      } else {
        const hit = exp.thirdPartyTransfers.find((t) => t.recipient === to && t.lamports === lamports && !thirdParty.some((x) => x === t));
        if (!hit) return fail('a transfer to an undisclosed recipient');
        thirdParty.push(hit);
      }
      continue;
    }

    if (ix.program === ATA_PROGRAM_ID) {
      if (ix.data.length !== 1 || ix.data[0] !== 1) return fail('associated-token instruction not allowed: only CreateIdempotent');
      if (ix.acc.length !== 6) return fail('CreateIdempotent has an unexpected account list');
      const [payer, ata, wallet, mint, system, tokenProgram] = ix.accKeys;
      if (payer !== owner || wallet !== owner) return fail('CreateIdempotent for a wallet other than the owner');
      if (mint !== exp.mint && mint !== WSOL_MINT) return fail('CreateIdempotent for a mint other than the trade mint or wrapped SOL');
      const program = mint === WSOL_MINT ? TOKEN_PROGRAM_ID : exp.tokenProgram;
      if (tokenProgram !== program || system !== SYSTEM_PROGRAM_ID) return fail('CreateIdempotent names the wrong token program');
      if (ata !== deriveAtaAddress(owner, mint, program)) return fail('CreateIdempotent for an account other than the derived token account of the owner');
      if (!isStatic(ata) || !isStatic(wallet)) return walletRefusal('owner-key-in-lookup', 'an owner key sits in a lookup table');
      if (mint === WSOL_MINT) touchesWsol = true;
      createCount++;
      continue;
    }

    if (ix.program === TOKEN_PROGRAM_ID || ix.program === TOKEN_2022_PROGRAM_ID) {
      const tag = ix.data.length > 0 ? ix.data[0] : -1;
      if (tag === TOKEN_IX_SYNC_NATIVE && ix.data.length === 1) {
        if (ix.accKeys[0] !== wsolAta || ix.program !== TOKEN_PROGRAM_ID) return fail('SyncNative of an account other than the owner wrapped-SOL account');
        if (!isStatic(wsolAta)) return walletRefusal('owner-key-in-lookup', 'an owner key sits in a lookup table');
        syncAt.push(ix.index);
        touchesWsol = true;
        continue;
      }
      if (tag === TOKEN_IX_CLOSE_ACCOUNT && ix.data.length === 1) {
        if (ix.acc.length !== 3 || ix.accKeys[0] !== wsolAta || ix.accKeys[1] !== owner || ix.accKeys[2] !== owner || ix.program !== TOKEN_PROGRAM_ID) {
          return fail('CloseAccount of an account other than the owner wrapped-SOL account, or to another destination');
        }
        if (!isStatic(wsolAta)) return walletRefusal('owner-key-in-lookup', 'an owner key sits in a lookup table');
        touchesWsol = true;
        continue;
      }
      return fail(`token instruction not allowed: ${TOKEN_IX_NAMES[tag] ?? `unknown (${tag})`}`);
    }

    // the route's own program: the trade instruction
    tradeCount++;
    trade = ix;
  }
  if (tradeCount !== 1 || trade === null) return fail(tradeCount === 0 ? 'no trade instruction' : 'more than one trade instruction');
  // S2: every wrap is followed by SyncNative of the same account, and the wrapped amount fits the maximum spend
  for (const w of wrapAt) if (!syncAt.some((s) => s > w)) return fail('a transfer to the wrapped-SOL account is not followed by SyncNative');
  if (thirdParty.length !== exp.thirdPartyTransfers.length) return fail('a disclosed third-party transfer is missing from the transaction');
  // S4
  if (touchesWsol && exp.wsolPreAmount !== null && exp.wsolPreAmount > 0n) {
    return walletRefusal('wsol-balance-present', 'Unwrap your wSOL first (Recover SOL tab), so this trade does not unwrap it for you');
  }

  // S5 (decoded)
  const sideOk = decodeTrade(exp, trade, tradeAta, wsolAta, isStatic);
  if (isRefusal(sideOk)) return sideOk;
  const bound = exp.bound;
  // the slippage rule on the disclosed bound, integer arithmetic, rounding against the user
  if (bound.kind === 'exact_in') {
    if (exp.quotedOut === null) return fail('an exact-in quote needs a quoted output');
    if (bound.minOut < minOutFloor(exp.quotedOut, exp.slippageBps)) return fail('the minimum output is below the quote minus the slippage');
  } else {
    if (exp.quotedIn === null) return fail('an exact-out quote needs a quoted input');
    if (bound.maxIn > maxInCeil(exp.quotedIn, exp.slippageBps)) return fail('the maximum input is above the quote plus the slippage');
  }
  if (wrapTotal > (bound.kind === 'exact_in' ? (exp.side === 'buy' ? bound.amountIn : 0n) : bound.maxIn)) return fail('the wrapped amount is above the maximum spend');

  // S7
  const maxSpend = exp.side === 'sell' ? 0n : bound.kind === 'exact_in' ? bound.amountIn : bound.maxIn;
  const network = LAMPORTS_PER_SIGNATURE * BigInt(tx.message.header.numRequiredSignatures);
  const rentBound = BigInt(createCount) * exp.rentMinLamports;
  const maxOutflow = maxSpend + network + cb.value.feeLamports + rentBound;
  if (network !== exp.networkFeeLamports || rentBound !== exp.rentLamports || maxOutflow !== exp.maxOutflowLamports) return fail('the disclosed outflow lines differ from the transaction bytes');
  if (exp.maxSpendCapLamports !== null && maxSpend > exp.maxSpendCapLamports) return walletRefusal('amount-above-cap', 'the maximum spend is above the configured cap');
  if (maxOutflow > exp.balanceLamports) {
    return walletRefusal('insufficient-sol', 'the maximum outflow is above the wallet balance', { needLamports: maxOutflow.toString(), haveLamports: exp.balanceLamports.toString() });
  }

  // S8: the simulation of every writable account
  if (dec.writable.length > MAX_SIMULATED_ACCOUNTS) return fail(`too many writable accounts to simulate (${dec.writable.length})`);
  let sim: SimResult;
  let pre: Array<ChainAccount | null>;
  try {
    const [p, s] = await Promise.all([readAccounts(deps.rpc, dec.writable, { timeoutMs: deps.timeoutMs }), runSimulation(deps.rpc, bytes, dec.writable, deps.timeoutMs)]);
    pre = p.accounts;
    sim = s;
  } catch (e) { return refusalFromError(e, 'simulation-failed'); }
  if (sim.err) return simulationRefusal(sim.err, (i) => ixs[i]?.program ?? null);
  const post = sim.accounts!;
  const at = (addr: string): { pre: ChainAccount | null; post: ChainAccount | null } | null => {
    const i = dec.writable.indexOf(addr);
    return i < 0 ? null : { pre: pre[i], post: post[i] };
  };
  const ownerAcc = at(owner);
  if (!ownerAcc) return fail('the owner account is not writable in the transaction');
  const ownerDelta = lamportsOf(ownerAcc.post) - lamportsOf(ownerAcc.pre);
  const outflow = -ownerDelta;
  if (outflow > maxOutflow) return walletRefusal('simulation-failed', `the simulated outflow ${outflow} is above the maximum ${maxOutflow}`);
  const tradeAcc = at(tradeAta);
  if (!tradeAcc) return fail('the trade token account is not writable in the transaction');
  const preTok = tokenAmountOf(tradeAcc.pre);
  const postTok = tokenAmountOf(tradeAcc.post);
  if (preTok === null || postTok === null) return fail('the trade token account could not be read in the simulation');
  const tokenDelta = postTok - preTok;
  const owned = checkOwnerAccounts(owner, dec.writable, pre, post, new Set([tradeAta, wsolAta]));
  if (owned) return owned;
  if (exp.side === 'buy') {
    if (bound.kind === 'exact_in') {
      if (tokenDelta < bound.minOut || tokenDelta <= 0n) return walletRefusal('simulation-failed', `the simulated output ${tokenDelta} is below the minimum ${bound.minOut}`);
    } else if (tokenDelta !== bound.exactOut) {
      return walletRefusal('simulation-failed', `the simulated output ${tokenDelta} is not the exact output ${bound.exactOut}`);
    }
  } else {
    if (exp.tokensRaw === null || -tokenDelta !== exp.tokensRaw) return walletRefusal('simulation-failed', `the simulated token decrease ${-tokenDelta} is not the amount sold`);
    // the SOL the trade paid out: the simulated change of the wallet with the fees added back (the simulation charges the fee payer the fees the
    // transaction commits to), so the figure is the swap proceeds, the quantity the program's minimum-output argument bounds
    const received = ownerDelta + network + cb.value.feeLamports;
    if (bound.kind !== 'exact_in') return fail('a sell is exact-in');
    if (received < bound.minOut) return walletRefusal('simulation-failed', `the simulated SOL received ${received} is below the minimum ${bound.minOut}`);
  }

  // the inner-program fee lines (I3 b): measured, never negative
  const innerFees: VerifiedInnerFee[] = [];
  for (const f of exp.innerFees) {
    const x = at(f.address);
    if (!x) return fail('an inner-program fee account is not writable in the transaction');
    let delta: bigint;
    if (f.kind === 'lamports') delta = lamportsOf(x.post) - lamportsOf(x.pre);
    else {
      const a = tokenAmountOf(x.pre);
      const b = tokenAmountOf(x.post);
      if (a === null || b === null) return fail('an inner-program fee account could not be read in the simulation');
      delta = b - a;
    }
    if (delta < 0n) return fail('an inner-program fee account decreased');
    innerFees.push({ label: f.label, recipient: f.recipient, amountBase: delta, asset: f.kind === 'lamports' ? 'SOL' : WSOL_MINT, decimals: 9 });
  }

  return {
    ok: true,
    value: {
      unitsConsumed: sim.unitsConsumed, slot: sim.slot, ownerDeltaLamports: ownerDelta, tokenDelta, innerFees, programs: programsSeen, rentBoundLamports: rentBound,
      maxSpendLamports: maxSpend, maxOutflowLamports: maxOutflow, jupiter: exp.route === 'jupiter' ? decodeJupiterTail(trade.data) : null,
    },
  };
}

/** S5: the trade instruction against the route's layout and the disclosed bound. */
function decodeTrade(exp: SwapExpectation, trade: DecodedIx, tradeAta: string, wsolAta: string, isStatic: (k: string) => boolean): true | WalletLinkRefusal {
  const owner = new PublicKey(exp.owner);
  const mint = new PublicKey(exp.mint);
  const tokenProgram = new PublicKey(exp.tokenProgram);
  const b = exp.bound;
  const want = (ix: TransactionInstruction): boolean => sameKeys(trade.accKeys, ix) && ix.data.length === trade.data.length && bytesEqual(ix.data, trade.data);
  // S5: the owner and the owner's token accounts are named by STATIC keys in the trade instruction, on every route
  for (const k of trade.accKeys) {
    if ((k === exp.owner || k === tradeAta || k === wsolAta) && !isStatic(k)) return walletRefusal('owner-key-in-lookup', 'an owner key sits in a lookup table');
  }

  if (exp.route === 'pump') {
    if (exp.tokenProgram !== TOKEN_PROGRAM_ID) return fail('the pump route needs a classic Token mint');
    if (!exp.creator) return fail('the pump route needs the curve creator');
    if (b.kind !== 'exact_in') return fail('a pump trade is exact-in');
    // FIX-PUMP: buy_exact_sol_in is 25 bytes ending in track_volume 01, sell 24; account 1 is a NORMAL fee recipient and the last account a
    // buyback recipient (pump-program.ts lists); the instruction is rebuilt with those two keys and compared key for key and byte for byte.
    const isBuy = exp.side === 'buy';
    if (trade.data.length !== (isBuy ? PUMP_BUY_DATA_LEN : PUMP_SELL_DATA_LEN)) return fail('pump instruction is not buy_exact_sol_in or sell');
    if (isBuy && trade.data[PUMP_BUY_DATA_LEN - 1] !== PUMP_TRACK_VOLUME) return fail('pump buy track_volume is not 01');
    const a1 = trade.data.readBigUInt64LE(8);
    const a2 = trade.data.readBigUInt64LE(16);
    const creator = new PublicKey(exp.creator);
    const k = trade.accKeys;
    if (k.length < 2 || !PUMP_FEE_RECIPIENTS_NORMAL.includes(k[1])) return fail('pump fee recipient is not in the NORMAL list');
    if (!PUMP_BUYBACK_FEE_RECIPIENTS.includes(k[k.length - 1])) return fail('pump buyback fee recipient is not in the BUYBACK list');
    const fees = { feeRecipient: new PublicKey(k[1]), buybackFeeRecipient: new PublicKey(k[k.length - 1]) };
    if (isBuy) {
      if (a1 !== b.amountIn || a2 !== b.minOut) return fail('the pump buy arguments differ from the disclosed bound');
      return want(buildBuyInstruction(owner, mint, creator, a1, a2, tokenProgram, fees)) ? true : fail('pump instruction is not buy_exact_sol_in with the builder positions');
    }
    if (a1 !== b.amountIn || a2 !== b.minOut) return fail('the pump sell arguments differ from the disclosed bound');
    return want(buildSellInstruction(owner, mint, creator, a1, a2, false, tokenProgram, fees)) ? true : fail('pump instruction is not sell with the builder positions');
  }

  if (exp.route === 'pumpswap') {
    if (!exp.pool) return fail('the PumpSwap route needs the pool references');
    if (trade.data.length !== 24) return fail('PumpSwap instruction has unexpected data');
    const pool: PoolRefs = {
      pool: new PublicKey(exp.pool.pool), poolBaseAccount: new PublicKey(exp.pool.poolBaseAccount),
      poolQuoteAccount: new PublicKey(exp.pool.poolQuoteAccount), coinCreator: new PublicKey(exp.pool.coinCreator),
    };
    const a1 = trade.data.readBigUInt64LE(8);
    const a2 = trade.data.readBigUInt64LE(16);
    if (exp.side === 'buy') {
      if (b.kind !== 'exact_out' || a1 !== b.exactOut || a2 !== b.maxIn) return fail('the PumpSwap buy arguments differ from the disclosed bound');
      return want(buildPumpSwapBuyInstruction(owner, mint, pool, tokenProgram, a1, a2)) ? true : fail('PumpSwap buy accounts differ from the IDL positions');
    }
    if (b.kind !== 'exact_in' || a1 !== b.amountIn || a2 !== b.minOut) return fail('the PumpSwap sell arguments differ from the disclosed bound');
    return want(buildPumpSwapSellInstruction(owner, mint, pool, tokenProgram, a1, a2)) ? true : fail('PumpSwap sell accounts differ from the IDL positions');
  }

  // Jupiter
  if (b.kind !== 'exact_in') return fail('a Jupiter trade is exact-in');
  const variant = jupiterVariantOf(trade.data);
  if (!variant) return fail('Jupiter instruction is not a pinned exact-in route');
  const tail = decodeJupiterTail(trade.data);
  if (!tail) return fail('Jupiter instruction data is too short');
  if (trade.acc.length < variant.minAccounts) return fail('Jupiter instruction has too few accounts');
  if (tail.platformFeeBps !== 0) return fail('Jupiter platform fee is not zero');
  if (tail.slippageBps !== exp.slippageBps) return fail('Jupiter slippage differs from the requested slippage');
  if (tail.inAmount !== b.amountIn) return fail('Jupiter in_amount differs from the disclosed amount');
  if (exp.quotedOut === null || tail.quotedOutAmount !== exp.quotedOut) return fail('Jupiter quoted_out_amount differs from the disclosed quote');
  const p = variant.positions;
  const [source, dest] = exp.side === 'buy' ? [wsolAta, tradeAta] : [tradeAta, wsolAta];
  if (trade.accKeys[p.userTransferAuthority] !== exp.owner || trade.accKeys[p.userSource] !== source || trade.accKeys[p.userDestination] !== dest) {
    return fail('Jupiter instruction names accounts other than the owner and the derived token accounts');
  }
  if (p.sourceMint !== null && trade.accKeys[p.sourceMint] !== (exp.side === 'buy' ? WSOL_MINT : exp.mint)) return fail('Jupiter source mint differs from the trade');
  if (trade.accKeys[p.destinationMint] !== (exp.side === 'buy' ? exp.mint : WSOL_MINT)) return fail('Jupiter destination mint differs from the trade');
  return true;
}

// ── the close profile ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CloseTarget {
  account: string;
  mint: string;
  /** The account's own token program (Token or Token-2022). */
  program: string;
  /** The build's own read of the account. */
  tokenOwner: string;
  amountRaw: bigint;
  lamports: bigint;
  frozen: boolean;
  closeAuthority: string | null;
  withheldFee: bigint;
}
export interface CloseExpectation {
  kind: 'empty' | 'unwrap';
  owner: string;
  accounts: readonly CloseTarget[];
  excluded: ReadonlySet<string>;
  cuLimit: number;
  cuPriceMicrolamports: number;
  priorityFeeLamports: bigint;
  networkFeeLamports: bigint;
  maxOutflowLamports: bigint;
  balanceLamports: bigint;
}
export interface VerifiedClose {
  unitsConsumed: number;
  slot: number;
  ownerDeltaLamports: bigint;
  returnedLamports: bigint;
  programs: string[];
}

export async function verifyCloseTx(deps: WalletVerifyDeps, bytes: Uint8Array, exp: CloseExpectation): Promise<VerifyOutcome<VerifiedClose>> {
  const dec = await decodeAndResolve(deps, bytes, exp.owner, undefined, false);
  if (isRefusal(dec)) return dec;
  const { tx, ixs, staticKeys } = dec;
  const cb = walletComputeBudget(tx, deps.priorityRange);
  if (!cb.ok) return fail(cb.reason);
  if (cb.value.cuLimit !== exp.cuLimit || cb.value.cuPriceMicrolamports !== exp.cuPriceMicrolamports || cb.value.feeLamports !== exp.priorityFeeLamports) {
    return fail('the compute budget differs from the disclosed priority-fee line');
  }
  const owner = exp.owner;
  const wsolAta = deriveAtaAddress(owner, WSOL_MINT, TOKEN_PROGRAM_ID);
  const byAccount = new Map(exp.accounts.map((a) => [a.account, a] as const));
  if (byAccount.size !== exp.accounts.length) return fail('the same account is listed twice');
  if (exp.kind === 'unwrap' && (exp.accounts.length !== 1 || exp.accounts[0].account !== wsolAta)) return fail('an unwrap closes the owner wrapped-SOL account and nothing else');

  // C3 over the build's own read
  for (const a of exp.accounts) {
    if (a.tokenOwner !== owner) return fail('an account to close is not owned by the owner');
    if (exp.excluded.has(a.account)) return fail('an account to close is on the excluded list');
    if (a.frozen) return fail('an account to close is frozen');
    if (a.closeAuthority !== null && a.closeAuthority !== owner) return fail('an account to close has a close authority other than the owner');
    if (a.withheldFee > 0n) return fail('an account to close holds withheld transfer fees');
    if (exp.kind === 'empty' && a.amountRaw !== 0n) return fail('an account to close is not empty');
    if (a.program !== TOKEN_PROGRAM_ID && a.program !== TOKEN_2022_PROGRAM_ID) return fail('an account to close is not owned by a token program');
  }

  const closed: string[] = [];
  const programs: string[] = [];
  for (const ix of ixs) {
    if (!programs.includes(ix.program)) programs.push(ix.program);
    // C1
    if (ix.program !== COMPUTE_BUDGET_PROGRAM_ID && ix.program !== TOKEN_PROGRAM_ID && ix.program !== TOKEN_2022_PROGRAM_ID) return fail(`program not allowed in a close: ${ix.program}`);
    if (ix.program === COMPUTE_BUDGET_PROGRAM_ID) continue;
    // C2
    if (ix.data.length !== 1 || ix.data[0] !== TOKEN_IX_CLOSE_ACCOUNT) return fail(`token instruction not allowed in a close: ${TOKEN_IX_NAMES[ix.data[0]] ?? 'unknown'}`);
    // C4
    if (ix.acc.length !== 3 || ix.accKeys[1] !== owner || ix.accKeys[2] !== owner) return fail('CloseAccount destination or authority is not the owner');
    const target = byAccount.get(ix.accKeys[0]);
    if (!target) return fail('CloseAccount of an account that is not in the requested list');
    if (ix.program !== target.program) return fail('CloseAccount under a program other than the account own');
    if (closed.includes(target.account)) return fail('the same account is closed twice');
    if (ix.acc[1] >= staticKeys.length) return walletRefusal('owner-key-in-lookup', 'an owner key sits in a lookup table');
    closed.push(target.account);
  }
  if (closed.length !== exp.accounts.length) return fail('the transaction does not close exactly the requested accounts');

  // balance
  const maxOutflow = LAMPORTS_PER_SIGNATURE * BigInt(tx.message.header.numRequiredSignatures) + cb.value.feeLamports;
  if (maxOutflow !== exp.maxOutflowLamports || LAMPORTS_PER_SIGNATURE * BigInt(tx.message.header.numRequiredSignatures) !== exp.networkFeeLamports) return fail('the disclosed outflow lines differ from the transaction bytes');
  if (maxOutflow > exp.balanceLamports) {
    return walletRefusal('insufficient-sol', 'the fees are above the wallet balance', { needLamports: maxOutflow.toString(), haveLamports: exp.balanceLamports.toString() });
  }

  // C5: the simulation
  if (dec.writable.length > MAX_SIMULATED_ACCOUNTS) return fail(`too many writable accounts to simulate (${dec.writable.length})`);
  let sim: SimResult;
  let pre: Array<ChainAccount | null>;
  try {
    const [p, s] = await Promise.all([readAccounts(deps.rpc, dec.writable, { timeoutMs: deps.timeoutMs }), runSimulation(deps.rpc, bytes, dec.writable, deps.timeoutMs)]);
    pre = p.accounts;
    sim = s;
  } catch (e) { return refusalFromError(e, 'simulation-failed'); }
  if (sim.err) return simulationRefusal(sim.err, (i) => ixs[i]?.program ?? null);
  const post = sim.accounts!;
  const returned = exp.accounts.reduce((s, a) => s + a.lamports, 0n);
  for (let i = 0; i < dec.writable.length; i++) {
    const addr = dec.writable[i];
    if (addr === owner) {
      const delta = lamportsOf(post[i]) - lamportsOf(pre[i]);
      const expected = returned - maxOutflow;
      if (delta !== expected) return walletRefusal('simulation-failed', `the simulated change of the wallet ${delta} is not the returned lamports minus the fees ${expected}`);
      continue;
    }
    const target = byAccount.get(addr);
    if (target) {
      if (pre[i] === null || pre[i]!.lamports !== target.lamports) return fail('an account to close changed between the read and the simulation');
      if (post[i] !== null && post[i]!.lamports !== 0n) return fail('an account to close is still open after the simulation');
      continue;
    }
    if (!sameAccount(pre[i], post[i])) return fail('the simulation changes an account that is not being closed');
  }
  return { ok: true, value: { unitsConsumed: sim.unitsConsumed, slot: sim.slot, ownerDeltaLamports: lamportsOf(post[dec.writable.indexOf(owner)]) - lamportsOf(pre[dec.writable.indexOf(owner)]), returnedLamports: returned, programs } };
}

function sameAccount(a: ChainAccount | null, b: ChainAccount | null): boolean {
  if (a === null || b === null) return a === b;
  return a.lamports === b.lamports && a.owner === b.owner && bytesEqual(a.data, b.data);
}
