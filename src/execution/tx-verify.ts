/**
 * TX VERIFY — refuse to sign an externally built transaction that does anything unexpected (B40 rule 4; plan grind #71).
 *
 * Every new pump.fun mint is Token-2022, and for those the curve transaction is BUILT BY A THIRD PARTY (PumpPortal
 * trade-local). Signing it blindly would hand that third party the wallet's authority. This module checks the unsigned
 * transaction against constant, source-cited allowlists and a pre-sign simulation, and FAILS CLOSED: any parse problem,
 * unresolvable lookup table, RPC error or unreadable delta is a refusal with a reason.
 *
 *   (a) System program: only Transfer from the owner, only to a constant fee or tip account, and within
 *       maxFeeLamports / maxTipLamports. Assign, Allocate, CreateAccount and every other transfer are refused.
 *   (b) Exactly ONE pump-program instruction, a known buy or sell discriminator, on the side the caller asked for,
 *       whose accounts include the expected mint, the bonding-curve PDA ["bonding-curve", mint] and the owner's ATA
 *       under the mint's token program.
 *   (c) Token / Token-2022 / ATA programs: only CreateIdempotent for the owner's ATA of the mint, SyncNative and
 *       CloseAccount of the owner's wSOL account. Transfer, TransferChecked, Approve, ApproveChecked, SetAuthority,
 *       Burn and anything touching another account are refused. ComputeBudget instructions are allowed. The owner is
 *       the only required signer (and the fee payer).
 *   (d) simulateTransaction (sigVerify false, replaceRecentBlockhash false, accounts [owner, owner ATA]):
 *       buy  -> owner ATA token delta > 0 and owner lamport outflow <= maxLamportsOut;
 *       sell -> owner lamport delta > 0 and owner ATA decrease <= tokensIn.
 *
 * The static checks (a)-(c) cost no RPC call, so a refusal for them is immediate.
 *
 * FIX-PUMP (2026-11-06): PF-direct no longer signs a third party's transaction. verifyPumpDirectStatic / verifyPumpDirectTx (end of this
 * file) pin the transaction the bot builds itself with pumpfun-ix.ts, strictly: programs, instruction order, every account and role, the
 * discriminators, the amounts and the slippage bound, then one pre-sign simulation. createTxVerifier stays as it is (PF-direct no longer
 * calls it) and still refuses every wrapper program.
 */
import { AddressLookupTableAccount, PublicKey, SystemProgram, VersionedTransaction, type MessageV0 } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import type { TxVerifier } from '../bot-contracts';
import { CB_SET_UNIT_PRICE, computeBudgetFeeLamports, type PriorityFeeResult } from './compute-budget';
import { deriveBondingCurvePda } from './curve-state';
import { swapFlowRefusal } from './sim-owner-checks';
import { ownerTokenAccount, ownerTokenAccountsRefusal } from './sim-owner-checks';   // FIX-PUMP: the PF-direct verifier's owner-account rules
import {
  ATA_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, PUMP_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT,
  accountBytes, defaultExecRpc, deriveAta, errorReason, isBase58Key, tokenAccountAmount, tokenProgramAddress, toBigInt, withTimeout,
  type ExecRpc,
} from './exec-common';
import {
  PF_DIRECT_CU_LIMIT, PUMP_BUY_DATA_LEN, PUMP_BUYBACK_FEE_RECIPIENTS, PUMP_DISC_BUY_EXACT_SOL_IN, PUMP_DISC_SELL, PUMP_EVENT_AUTHORITY,
  PUMP_FEE_CONFIG, PUMP_FEE_PROGRAM, PUMP_FEE_RECIPIENTS_MAYHEM, PUMP_FEE_RECIPIENTS_NORMAL, PUMP_GLOBAL, PUMP_GLOBAL_VOLUME_ACCUMULATOR,
  PUMP_PROGRAM, PUMP_SELL_DATA_LEN, PUMP_TRACK_VOLUME, PumpDirectRefusal, TX_PACKET_BYTES, classifyPumpCurve, classifyPumpMint,
  isPumpSlippageBps, pumpTradeBounds, type PumpCurveInfo, type RawAccount,
} from './pump-program';
import { PreSignRefusal, simulationRefusal } from './send-context';
import { parseChainAccount, type ChainAccount } from './wallet-reads';

// ── Constant allowlists ──────────────────────────────────────────────────────────────────────────

/**
 * PumpPortal trade-local fee accounts: the only addresses a System Transfer may pay as a PumpPortal fee.
 *
 * OPEN ITEM (R1-B4): this list is EMPTY on purpose. The fee account(s) are published in the PumpPortal trade-local
 * documentation / visible in a recorded trade-local transaction, and this package had no network access, so no address
 * could be sourced and none is guessed (an unverified address in a signing allowlist would be worse than none). With
 * the list empty, a PumpPortal transaction that carries a fee transfer is REFUSED (fail closed) and the refusal reason
 * names the destination address. Before any live use (pilot / cutover probe): take the address from a recorded
 * trade-local transaction, check it against the PumpPortal documentation, add it here with its source in a comment.
 * A-93g (2026-10-26): still no source. https://pumpportal.fun/fees, https://pumpportal.fun/local-trading-api/trading-api
 * and the vendor's GitHub README give the rate but no fee-recipient address, and no recorded trade-local transaction
 * exists yet. The list stays empty (A-51).
 */
export const PUMPPORTAL_FEE_ACCOUNTS: readonly string[] = [];

/**
 * Helius Sender tip accounts (staked-validator tip accounts). Source: the Helius Sender documentation
 * (https://www.helius.dev/docs/sending-transactions/sender), the same ten addresses as CONFIG.HELIUS_TIP_ACCOUNTS in
 * config.ts, which carries the note "verified against Helius docs 2026-05-02".
 */
export const TIP_ACCOUNTS: readonly string[] = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE', // Helius Sender tip account 1
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ', // Helius Sender tip account 2
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta', // Helius Sender tip account 3
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn', // Helius Sender tip account 4
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD', // Helius Sender tip account 5
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ', // Helius Sender tip account 6
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',  // Helius Sender tip account 7
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT', // Helius Sender tip account 8
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey', // Helius Sender tip account 9
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or', // Helius Sender tip account 10
];

/**
 * PumpPortal trade-local fee in basis points (the fee is a % of the trade's SOL side).
 * Documented: https://pumpportal.fun/fees ("0.5% fee on each Local trade", calculated before slippage; checked
 * 2026-10-26, A-93g). NOT yet confirmed on-chain (every source traces back to the vendor), so it stays an open item
 * with the fee accounts above. Too low a value fails closed (the fee transfer is refused as above the bound).
 */
export const PUMPPORTAL_FEE_BPS = 50;

/** maxFeeLamports for the caller: ceil(amountLamports * feeBps / 10000) + 1 lamport of rounding tolerance (B40 rule 4a). */
export function pumpPortalMaxFeeLamports(amountLamports: bigint, feeBps: number = PUMPPORTAL_FEE_BPS): bigint {
  const bps = BigInt(feeBps);
  return (amountLamports * bps + 9_999n) / 10_000n + 1n;
}

// ── A-27: the ComputeBudget (priority) fee of a PumpPortal-built transaction ─────────────────────────

/**
 * A-27: a PumpPortal-built transaction may pay at most this multiple of the priority fee we asked it to pay. We send
 * `priorityFee` (SOL) in the trade-local request and PumpPortal turns it into SetComputeUnitLimit + SetComputeUnitPrice
 * instructions; a builder that inflates the price would drain the wallet through the priority fee, which no System
 * Transfer rule above can see. 2 leaves room for PumpPortal's own rounding and fee model, and nothing more.
 * The bound is a lamport value compared with the real fee: ceil(unit price in micro-lamports x unit limit / 1_000_000).
 */
export const PUMPPORTAL_PRIORITY_FEE_MAX_FACTOR = 2;

// R7-W5 (A-104): computeBudgetFeeLamports and PriorityFeeResult moved, unchanged, into the pure compute-budget.ts (so the unsigned wallet
// code can use them without importing this file); they are re-exported here under the same names.
export { computeBudgetFeeLamports };
export type { PriorityFeeResult };

/**
 * A-27: refuse (before signing) a PumpPortal-built transaction whose priority fee is more than
 * PUMPPORTAL_PRIORITY_FEE_MAX_FACTOR x the `prioritySol` that was requested. Static: no RPC call. The frozen TxVerifier
 * ctx has no field for this, so pumpfun-swap.ts calls it next to verify().
 */
export function checkPumpPortalPriorityFee(tx: VersionedTransaction, requestedPrioritySol: number): { ok: true } | { ok: false; reason: string } {
  if (typeof requestedPrioritySol !== 'number' || !Number.isFinite(requestedPrioritySol) || requestedPrioritySol < 0) {
    return { ok: false, reason: 'invalid requested priority fee' };
  }
  const fee = computeBudgetFeeLamports(tx);
  if (!fee.ok) return { ok: false, reason: fee.reason.slice(0, 200) };
  const requested = BigInt(Math.round(requestedPrioritySol * 1e9));
  const bound = BigInt(PUMPPORTAL_PRIORITY_FEE_MAX_FACTOR) * requested;
  if (fee.lamports > bound) {
    return { ok: false, reason: `priority fee above bound (${fee.lamports} > ${PUMPPORTAL_PRIORITY_FEE_MAX_FACTOR} x requested ${requested} lamports)`.slice(0, 200) };
  }
  return { ok: true };
}

/**
 * Pump program instruction discriminators. Anchor rule: the first 8 bytes of sha256("global:<instruction name>").
 * The same rule reproduces the three discriminators pumpfun-swap.ts has been sending (`buy`, `sell`,
 * `buy_exact_sol_in`), and tx-verify.test.ts re-computes every entry below from its name. Names are the pump IDL
 * instruction names (https://github.com/pump-fun/pump-public-docs/tree/main/idl); `buy_v2` / `sell_v2` are the
 * Token-2022 multi-quote variants named in pumpfun-swap.ts.
 */
export const PUMP_IX_NAMES = {
  buy: ['buy', 'buy_exact_sol_in', 'buy_v2'],
  sell: ['sell', 'sell_v2'],
} as const;

export function anchorInstructionDiscriminator(name: string): number[] {
  return [...createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)];
}

/** Buy variants (constant set). */
export const PUMP_BUY_DISCRIMINATORS: readonly (readonly number[])[] = [
  [102, 6, 61, 18, 1, 218, 235, 234],   // buy                (IDL name `buy`)
  [56, 252, 116, 8, 158, 223, 205, 95], // buy_exact_sol_in   (IDL name `buy_exact_sol_in`)
  [184, 23, 238, 97, 103, 197, 211, 61], // buy_v2            (IDL name `buy_v2`)
];
/** Sell variants (constant set). */
export const PUMP_SELL_DISCRIMINATORS: readonly (readonly number[])[] = [
  [51, 230, 133, 164, 1, 127, 131, 173], // sell              (IDL name `sell`)
  [93, 246, 130, 60, 231, 233, 64, 178], // sell_v2           (IDL name `sell_v2`)
];

const SYSTEM_PROGRAM_ID = SystemProgram.programId.toBase58();
const SYSTEM_IX_NAMES: Readonly<Record<number, string>> = {
  0: 'CreateAccount', 1: 'Assign', 2: 'Transfer', 3: 'CreateAccountWithSeed', 4: 'AdvanceNonceAccount',
  5: 'WithdrawNonceAccount', 6: 'InitializeNonceAccount', 7: 'AuthorizeNonceAccount', 8: 'Allocate',
  9: 'AllocateWithSeed', 10: 'AssignWithSeed', 11: 'TransferWithSeed', 12: 'UpgradeNonceAccount',
};
const TOKEN_IX_NAMES: Readonly<Record<number, string>> = {
  0: 'InitializeMint', 1: 'InitializeAccount', 2: 'InitializeMultisig', 3: 'Transfer', 4: 'Approve', 5: 'Revoke',
  6: 'SetAuthority', 7: 'MintTo', 8: 'Burn', 10: 'FreezeAccount', 11: 'ThawAccount', 12: 'TransferChecked',
  13: 'ApproveChecked', 14: 'MintToChecked', 15: 'BurnChecked', 16: 'InitializeAccount2', 18: 'InitializeAccount3',
};
const TOKEN_IX_SYNC_NATIVE = 17;
const TOKEN_IX_CLOSE_ACCOUNT = 9;

export interface TxVerifyDeps {
  rpc?: ExecRpc;
  /** Override for tests; production uses the constants above. */
  feeAccounts?: readonly string[];
  tipAccounts?: readonly string[];
}

type VerifyCtx = Parameters<TxVerifier['verify']>[1];
type VerifyResult = Awaited<ReturnType<TxVerifier['verify']>>;

function matchesAny(data: Buffer, set: readonly (readonly number[])[]): boolean {
  if (data.length < 8) return false;
  return set.some((d) => d.every((b, i) => data[i] === b));
}

/** Resolve v0 address-table lookups to the loaded addresses (writable first, then readonly), or throw. */
async function resolveLookups(
  rpc: ExecRpc,
  lookups: ReadonlyArray<{ accountKey: PublicKey; writableIndexes: number[]; readonlyIndexes: number[] }>,
): Promise<string[]> {
  const writable: string[] = [];
  const readonly: string[] = [];
  for (const l of lookups) {
    const res = await rpc.call('getAccountInfo', [l.accountKey.toBase58(), { encoding: 'base64', commitment: 'confirmed' }]);
    const bytes = accountBytes(res?.value);
    if (!bytes) throw new Error('lookup table account unreadable');
    const table = AddressLookupTableAccount.deserialize(bytes);
    for (const i of l.writableIndexes) {
      const a = table.addresses[i];
      if (!a) throw new Error('lookup table index out of range');
      writable.push(a.toBase58());
    }
    for (const i of l.readonlyIndexes) {
      const a = table.addresses[i];
      if (!a) throw new Error('lookup table index out of range');
      readonly.push(a.toBase58());
    }
  }
  return [...writable, ...readonly];
}

export function createTxVerifier(deps: TxVerifyDeps = {}): TxVerifier {
  const rpc = deps.rpc ?? defaultExecRpc();
  const feeSet = new Set(deps.feeAccounts ?? PUMPPORTAL_FEE_ACCOUNTS);
  const tipSet = new Set(deps.tipAccounts ?? TIP_ACCOUNTS);

  async function verify(txBase64: string, ctx: VerifyCtx): Promise<VerifyResult> {
    const refuse = (reason: string): VerifyResult => ({ ok: false, reason: reason.slice(0, 200) });
    try {
      if (!isBase58Key(ctx?.owner) || !isBase58Key(ctx?.mint)) return refuse('invalid verification context');
      if (ctx.side !== 'buy' && ctx.side !== 'sell') return refuse('invalid verification context');
      if (ctx.side === 'sell' && (ctx.tokensIn === null || ctx.tokensIn === undefined || ctx.tokensIn <= 0n)) {
        return refuse('sell verification needs tokensIn');
      }
      const owner = ctx.owner;
      const mint = ctx.mint;

      // ── decode ──
      let tx: VersionedTransaction;
      try {
        const bytes = Buffer.from(String(txBase64), 'base64');
        if (bytes.length === 0) return refuse('undecodable transaction');
        tx = VersionedTransaction.deserialize(bytes);
      } catch {
        return refuse('undecodable transaction');
      }
      const msg = tx.message;
      const staticKeys = msg.staticAccountKeys.map((k) => k.toBase58());
      let keys = staticKeys;
      const lookups = msg.addressTableLookups ?? [];
      if (lookups.length > 0) {
        try {
          keys = [...staticKeys, ...(await resolveLookups(rpc, lookups))];
        } catch (e) {
          return refuse(`unresolved address lookup table: ${errorReason(e)}`);
        }
      }

      // ── signer: the owner, alone ──
      if (msg.header.numRequiredSignatures !== 1) return refuse(`extra signer: ${msg.header.numRequiredSignatures} required signatures`);
      if (staticKeys[0] !== owner) return refuse('fee payer is not the owner');

      // ── instruction allowlist ──
      const ownerAta = deriveAta(owner, mint, ctx.tokenProgram);
      const wsolAta = deriveAta(owner, WSOL_MINT, 'token');
      const bondingCurve = deriveBondingCurvePda(mint);
      const ataProgramTokenAddr = tokenProgramAddress(ctx.tokenProgram);
      let pumpCount = 0;
      let feeTotal = 0n;
      let tipTotal = 0n;

      for (const ix of msg.compiledInstructions) {
        if (ix.programIdIndex >= staticKeys.length) return refuse('program id outside the static account keys');
        const program = staticKeys[ix.programIdIndex];
        const acc: string[] = [];
        for (const i of ix.accountKeyIndexes) {
          const k = keys[i];
          if (k === undefined) return refuse('instruction account index out of range');
          acc.push(k);
        }
        const data = Buffer.from(ix.data);

        if (program === COMPUTE_BUDGET_PROGRAM_ID) continue;

        if (program === SYSTEM_PROGRAM_ID) {
          const type = data.length >= 4 ? data.readUInt32LE(0) : -1;
          if (type !== 2 || data.length !== 12 || acc.length < 2) {
            return refuse(`system instruction not allowed: ${SYSTEM_IX_NAMES[type] ?? 'unknown'}`);
          }
          if (acc[0] !== owner) return refuse('system transfer not from the owner');
          const lamports = data.readBigUInt64LE(4);
          const to = acc[1];
          if (feeSet.has(to)) {
            feeTotal += lamports;
            if (feeTotal > ctx.maxFeeLamports) return refuse(`fee transfer above bound (${lamports} > ${ctx.maxFeeLamports})`);
          } else if (tipSet.has(to)) {
            tipTotal += lamports;
            if (tipTotal > ctx.maxTipLamports) return refuse(`tip transfer above bound (${lamports} > ${ctx.maxTipLamports})`);
          } else {
            return refuse(`system transfer to non-allowlisted address ${to}`);
          }
          continue;
        }

        if (program === ATA_PROGRAM_ID) {
          if (data.length !== 1 || data[0] !== 1) return refuse('associated-token instruction not allowed: only CreateIdempotent');
          const expected = [owner, ownerAta, owner, mint, SYSTEM_PROGRAM_ID, ataProgramTokenAddr];
          if (acc.length < 6 || expected.some((e, i) => acc[i] !== e)) return refuse('CreateIdempotent for an account other than the owner ATA of the mint');
          continue;
        }

        if (program === TOKEN_PROGRAM_ID || program === TOKEN_2022_PROGRAM_ID) {
          const d = data.length > 0 ? data[0] : -1;
          if (d === TOKEN_IX_SYNC_NATIVE) {
            if (acc[0] !== wsolAta) return refuse('SyncNative of an account other than the owner wSOL account');
            continue;
          }
          if (d === TOKEN_IX_CLOSE_ACCOUNT) {
            if (acc[0] !== wsolAta || acc[1] !== owner || acc[2] !== owner) return refuse('CloseAccount of an account other than the owner wSOL account');
            continue;
          }
          return refuse(`token instruction not allowed: ${TOKEN_IX_NAMES[d] ?? `unknown (${d})`}`);
        }

        if (program === PUMP_PROGRAM_ID) {
          pumpCount++;
          if (pumpCount > 1) return refuse('multiple pump instructions');
          const isBuy = matchesAny(data, PUMP_BUY_DISCRIMINATORS);
          const isSell = !isBuy && matchesAny(data, PUMP_SELL_DISCRIMINATORS);
          if (!isBuy && !isSell) return refuse('pump instruction is not a known buy or sell');
          if ((isBuy ? 'buy' : 'sell') !== ctx.side) return refuse(`side mismatch (transaction ${isBuy ? 'buys' : 'sells'}, expected ${ctx.side})`);
          if (!acc.includes(mint)) return refuse('mint mismatch');
          if (!acc.includes(bondingCurve)) return refuse('bonding curve mismatch');
          if (!acc.includes(ownerAta)) return refuse('owner ATA mismatch');
          if (!acc.includes(owner)) return refuse('owner is not an account of the pump instruction');
          continue;
        }

        return refuse(`program not allowed: ${program}`);
      }
      if (pumpCount === 0) return refuse('no pump instruction');

      // ── (d) simulation (fail closed) ──
      try {
        const [pre, sim] = await Promise.all([
          rpc.call('getMultipleAccounts', [[owner, ownerAta], { encoding: 'base64', commitment: 'confirmed' }]),
          rpc.call('simulateTransaction', [String(txBase64), {
            encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed',
            accounts: { encoding: 'base64', addresses: [owner, ownerAta] },
          }]),
        ]);
        const simValue = sim?.value;
        if (!simValue) return refuse('simulation returned no result');
        if (simValue.err) return refuse(`simulation failed: ${JSON.stringify(simValue.err)}`);

        const preList = pre?.value;
        const postList = simValue.accounts;
        if (!Array.isArray(preList) || !Array.isArray(postList) || postList.length < 2) return refuse('simulation accounts unreadable');
        if (!preList[0] || !postList[0]) return refuse('simulation: owner account unreadable');
        const lamPre = toBigInt(preList[0].lamports);
        const lamPost = toBigInt(postList[0].lamports);
        if (lamPre === null || lamPost === null) return refuse('simulation: owner lamports unreadable');
        let tokPre = 0n;
        if (preList[1]) {
          const t = tokenAccountAmount(accountBytes(preList[1]));
          if (t === null) return refuse('simulation: token balance unreadable');
          tokPre = t;
        }
        let tokPost = 0n;
        if (postList[1]) {
          const t = tokenAccountAmount(accountBytes(postList[1]));
          if (t === null) return refuse('simulation: token balance unreadable');
          tokPost = t;
        }

        // FIX-BUY2 item 7(e): the rule lives in sim-owner-checks.ts (shared with the Jupiter /swap/v2/order fallback), unchanged
        const flow = { lamportsBefore: lamPre, lamportsAfter: lamPost, tokensBefore: tokPre, tokensAfter: tokPost };
        const why = swapFlowRefusal(flow, ctx.side === 'buy' ? { side: 'buy', maxLamportsOut: ctx.maxLamportsOut } : { side: 'sell', tokensIn: ctx.tokensIn as bigint });
        if (why !== null) return refuse(why);
      } catch (e) {
        return refuse(`simulation unavailable: ${errorReason(e)}`);
      }
      return { ok: true };
    } catch (e) {
      return refuse(`verification error: ${errorReason(e)}`);
    }
  }

  return { verify };
}

// ── FIX-PUMP: the strict verifier of a PF-direct transaction (pump buy_exact_sol_in / sell built by the bot) ──────────────────────────

/**
 * What a PF-direct transaction is checked against. Never builder output: the trade the caller asked for, the curve and mint accounts of
 * the build's own chain read, and the bot's price ceiling. The verifier re-parses the accounts (pump-program.ts classifyPumpCurve /
 * classifyPumpMint, the variant table of the build), computes the quote and the signed minimum itself (pump-program.ts math), and derives
 * every PDA and ATA from string seeds here (exec-common deriveAta, findProgramAddressSync), never through the pumpfun-ix builders.
 * Not a TxVerifier: the frozen contract of bot-contracts.ts is unchanged, and createTxVerifier above still refuses every wrapper.
 */
export interface PumpDirectVerifyCtx {
  owner: string;
  mint: string;
  side: 'buy' | 'sell';
  /** buy: lamports to spend, pump's fees included (spendable_sol_in); sell: token atoms (amount). */
  amountIn: bigint;
  /** An integer from 1 to 5000. */
  slippageBps: number;
  /** The Sender tip is required exactly when this is true. */
  antiMev: boolean;
  curve: RawAccount;
  mintAccount: RawAccount;
  /** PRIORITY_FEE_CEILING_MICROLAMPORTS (default 5 000 000): the most the transaction may pay per compute unit. */
  maxCuPriceMicroLamports: bigint;
}

/** One expected account of the pump instruction: a fixed key, or (fee and buyback recipients) a member of a pinned list. */
export interface PumpExpectedAccount {
  name: string;
  key: string | null;
  list: readonly string[] | null;
  listName: string | null;
  signer: boolean;
  writable: boolean;
}

/** SetComputeUnitLimit(200 000), the only limit a PF-direct transaction carries. */
export const PF_DIRECT_CU_LIMIT_DATA: readonly number[] = [2, 0x40, 0x0d, 0x03, 0x00];
/** The Sender tip of a PF-direct transaction, in lamports (jupiter.ts's tip amount; a test keeps them equal). */
export const PF_DIRECT_TIP_LAMPORTS = 200_000n;
const PF_DIRECT_TIP_DATA: readonly number[] = [2, 0, 0, 0, 0x40, 0x0d, 0x03, 0, 0, 0, 0, 0];
/** The signature fee of the one signature. */
export const LAMPORTS_PER_SIGNATURE_FEE = 5_000n;
/** Rent bounds of a first buy (the old, higher rate: 6 960 lamports per data byte + 128). */
export const PF_RENT_BOUND_ATA_TOKEN_2022 = 2_074_080n;
export const PF_RENT_BOUND_ATA_TOKEN = 2_039_280n;
export const PF_RENT_BOUND_USER_VOLUME_ACCUMULATOR = 1_844_400n;
export const PF_RENT_BOUND_CREATOR_VAULT = 890_880n;
/** The simulation and its pre-state read together. */
export const PF_DIRECT_SIM_BUDGET_MS = 2_500;

/**
 * pump error codes that mean "pump refused the accounts we sent": they feed the PF-direct breaker (pumpfun-swap.ts). 6000 NotAuthorized
 * is what an unlisted fee_recipient raises (there is no specific code), then the buyback, cashback and bonding_curve_v2 codes and Anchor's
 * account, constraint and instruction-data errors. 6042 / 6002 / 6003 (price moved), 6021 (sold out) and 6005 (complete) are not layout.
 */
export const PUMP_LAYOUT_ERROR_CODES: ReadonlySet<number> = new Set([
  6000, 6027, 6057, 6062, 6072, 6073, 6074, 101, 102, 2000, 2002, 2003, 2006, 2012, 3005, 3006, 3007, 3012,
]);

function findPda(seeds: ReadonlyArray<string | Uint8Array>, program: string): string {
  return PublicKey.findProgramAddressSync(
    seeds.map((s) => (typeof s === 'string' ? Buffer.from(s, 'utf8') : Buffer.from(s))),
    new PublicKey(program),
  )[0].toBase58();
}
const keyBytesOf = (k: string): Uint8Array => new PublicKey(k).toBytes();

/** The verifier's own derivations for one trade (string seeds; independent of pumpfun-ix.ts). */
export function pumpDirectDerived(owner: string, mint: string, tokenProgram: string, creator: string): {
  bondingCurve: string; bondingCurveV2: string; associatedBondingCurve: string; associatedUser: string; creatorVault: string; userVolumeAccumulator: string;
} {
  const bondingCurve = findPda(['bonding-curve', keyBytesOf(mint)], PUMP_PROGRAM);
  return {
    bondingCurve,
    bondingCurveV2: findPda(['bonding-curve-v2', keyBytesOf(mint)], PUMP_PROGRAM),
    associatedBondingCurve: deriveAta(bondingCurve, mint, tokenProgram),
    associatedUser: deriveAta(owner, mint, tokenProgram),
    creatorVault: findPda(['creator-vault', keyBytesOf(creator)], PUMP_PROGRAM),
    userVolumeAccumulator: findPda(['user_volume_accumulator', keyBytesOf(owner)], PUMP_PROGRAM),
  };
}

/** The pump instruction's accounts, in order, with their roles (pumpfun-ix.ts tables; section C of the FIX-PUMP design). */
export function pumpDirectExpectedAccounts(p: { side: 'buy' | 'sell'; owner: string; mint: string; tokenProgram: string; creator: string; mayhem: boolean; cashback: boolean }): PumpExpectedAccount[] {
  const d = pumpDirectDerived(p.owner, p.mint, p.tokenProgram, p.creator);
  const fixed = (name: string, key: string, writable: boolean, signer = false): PumpExpectedAccount => ({ name, key, list: null, listName: null, signer, writable });
  const listed = (name: string, list: readonly string[], listName: string): PumpExpectedAccount => ({ name, key: null, list, listName, signer: false, writable: true });
  const head = [
    fixed('global', PUMP_GLOBAL, false),
    p.mayhem ? listed('fee_recipient', PUMP_FEE_RECIPIENTS_MAYHEM, 'RESERVED') : listed('fee_recipient', PUMP_FEE_RECIPIENTS_NORMAL, 'NORMAL'),
    fixed('mint', p.mint, false),
    fixed('bonding_curve', d.bondingCurve, true),
    fixed('associated_bonding_curve', d.associatedBondingCurve, true),
    fixed('associated_user', d.associatedUser, true),
    fixed('user', p.owner, true, true),
    fixed('system_program', SYSTEM_PROGRAM_ID, false),
  ];
  const buyback = listed('buyback_fee_recipient', PUMP_BUYBACK_FEE_RECIPIENTS, 'BUYBACK');
  if (p.side === 'buy') {
    return [
      ...head,
      fixed('token_program', p.tokenProgram, false),
      fixed('creator_vault', d.creatorVault, true),
      fixed('event_authority', PUMP_EVENT_AUTHORITY, false),
      fixed('program', PUMP_PROGRAM, false),
      fixed('global_volume_accumulator', PUMP_GLOBAL_VOLUME_ACCUMULATOR, false),
      fixed('user_volume_accumulator', d.userVolumeAccumulator, true),
      fixed('fee_config', PUMP_FEE_CONFIG, false),
      fixed('fee_program', PUMP_FEE_PROGRAM, false),
      fixed('bonding_curve_v2', d.bondingCurveV2, false),
      buyback,
    ];
  }
  return [
    ...head,
    fixed('creator_vault', d.creatorVault, true),
    fixed('token_program', p.tokenProgram, false),
    fixed('event_authority', PUMP_EVENT_AUTHORITY, false),
    fixed('program', PUMP_PROGRAM, false),
    fixed('fee_config', PUMP_FEE_CONFIG, false),
    fixed('fee_program', PUMP_FEE_PROGRAM, false),
    ...(p.cashback ? [fixed('user_volume_accumulator', d.userVolumeAccumulator, true)] : []),
    fixed('bonding_curve_v2', d.bondingCurveV2, false),
    buyback,
  ];
}

export interface PumpDirectStaticOk {
  ok: true;
  tokenProgram: string;
  curve: PumpCurveInfo;
  quoted: bigint;
  minOut: bigint;
  ownerAta: string;
  bondingCurve: string;
  creatorVault: string;
  userVolumeAccumulator: string;
  priorityFeeLamports: bigint;
  tipLamports: bigint;
  pumpIndex: number;
}
export type PumpDirectStaticResult = PumpDirectStaticOk | { ok: false; reason: string };

const sameBytes = (a: Uint8Array, b: readonly number[]): boolean => a.length === b.length && b.every((x, i) => a[i] === x);

/**
 * The static pins of a PF-direct transaction (no RPC; the first failure refuses, the reason is redacted and at most 200 characters):
 *   1. a v0 message with no lookup table, one signature (still all zeros), the owner as fee payer, no duplicate key;
 *   2. exactly [ComputeBudget, ComputeBudget, ATA, pump] (buy) or [ComputeBudget, ComputeBudget, pump] (sell), then the System tip only
 *      when antiMev; any other program is 'program not allowed', any other instruction 'unexpected instruction';
 *   3. SetComputeUnitLimit exactly 200 000 and one SetComputeUnitPrice at most maxCuPriceMicroLamports, neither with accounts;
 *   4. the buy's CreateIdempotent exactly for the owner's ATA of the mint under the mint's token program;
 *   5. the pump data: buy_exact_sol_in of 25 bytes ending 01 or sell of 24, the requested amount and the verifier's own minimum;
 *   6. every pump account at its position (fee and buyback recipients from the pinned lists, bonding_curve_v2 canonical, the canonical ATA);
 *   7. the tip: the last instruction, 200 000 lamports from the owner to a Sender tip account;
 *   8. the static keys are exactly the expected set and each key's (signer, writable) pair is the expected role;
 *   9. at most 1 232 bytes.
 */
export function verifyPumpDirectStatic(tx: VersionedTransaction, ctx: PumpDirectVerifyCtx): PumpDirectStaticResult {
  const no = (reason: string): { ok: false; reason: string } => ({ ok: false, reason: errorReason(reason) });
  try {
    if (!ctx || !isBase58Key(ctx.owner) || !isBase58Key(ctx.mint)) return no('invalid verification context');
    if (ctx.side !== 'buy' && ctx.side !== 'sell') return no('invalid verification context: side');
    if (typeof ctx.amountIn !== 'bigint' || ctx.amountIn <= 0n) return no('invalid verification context: amount');
    if (!isPumpSlippageBps(ctx.slippageBps)) return no('slippage outside 1..5000 bps');
    if (typeof ctx.antiMev !== 'boolean') return no('invalid verification context: antiMev');
    if (typeof ctx.maxCuPriceMicroLamports !== 'bigint' || ctx.maxCuPriceMicroLamports < 0n) return no('invalid verification context: price ceiling');
    const cc = classifyPumpCurve(ctx.curve);
    if (!cc.ok) return no(`curve refused (${cc.code}): ${cc.detail}`);
    const mc = classifyPumpMint(ctx.mintAccount);
    if (!mc.ok) return no(`mint refused (${mc.code}): ${mc.detail}`);
    const curve = cc.value;
    const tokenProgram = mc.value;
    const bounds = pumpTradeBounds(curve, ctx.side, ctx.amountIn, ctx.slippageBps);
    if (!bounds.ok) return no(`quote refused (${bounds.code}): ${bounds.detail}`);
    const { owner, mint, side } = ctx;
    const isBuy = side === 'buy';

    // 1. message shape
    if (tx.version !== 0) return no('not a v0 message');
    const msg = tx.message as MessageV0;
    if ((msg.addressTableLookups ?? []).length !== 0) return no('address lookup tables are not allowed');
    const header = msg.header;
    if (header.numRequiredSignatures !== 1 || header.numReadonlySignedAccounts !== 0) return no(`extra signer: ${header.numRequiredSignatures} required signatures`);
    const keys = msg.staticAccountKeys.map((k) => k.toBase58());
    if (keys[0] !== owner) return no('fee payer is not the owner');
    if (new Set(keys).size !== keys.length) return no('duplicate static account key');
    if (tx.signatures.length !== 1 || tx.signatures[0].some((b) => b !== 0)) return no('the transaction already carries a signature');

    // 2. the instruction list, exactly
    const ixs = msg.compiledInstructions;
    const expectedPrograms = isBuy ? [COMPUTE_BUDGET_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, ATA_PROGRAM_ID, PUMP_PROGRAM] : [COMPUTE_BUDGET_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, PUMP_PROGRAM];
    if (ctx.antiMev) expectedPrograms.push(SYSTEM_PROGRAM_ID);
    const allowedPrograms = new Set([COMPUTE_BUDGET_PROGRAM_ID, ATA_PROGRAM_ID, PUMP_PROGRAM, SYSTEM_PROGRAM_ID]);
    const accountsOf: string[][] = [];
    for (let i = 0; i < ixs.length; i++) {
      const ix = ixs[i];
      if (ix.programIdIndex >= keys.length) return no('program id outside the static account keys');
      const program = keys[ix.programIdIndex];
      if (!allowedPrograms.has(program)) return no(`program not allowed: ${program}`);
      if (i >= expectedPrograms.length || program !== expectedPrograms[i]) return no(`unexpected instruction ${i}`);
      const acc: string[] = [];
      for (const k of ix.accountKeyIndexes) {
        if (k >= keys.length) return no('instruction account index out of range');
        acc.push(keys[k]);
      }
      accountsOf.push(acc);
    }
    if (ixs.length !== expectedPrograms.length) {
      return no(ctx.antiMev && ixs.length === expectedPrograms.length - 1 ? 'the Sender tip instruction is missing' : `missing instruction ${ixs.length}`);
    }

    // 3. compute budget
    const data = (i: number): Uint8Array => ixs[i].data;
    if (!sameBytes(data(0), PF_DIRECT_CU_LIMIT_DATA) || accountsOf[0].length !== 0) return no('instruction 0 is not SetComputeUnitLimit(200000)');
    const d1 = Buffer.from(data(1));
    if (d1.length !== 9 || d1[0] !== CB_SET_UNIT_PRICE || accountsOf[1].length !== 0) return no('instruction 1 is not SetComputeUnitPrice');
    const price = d1.readBigUInt64LE(1);
    if (price > ctx.maxCuPriceMicroLamports) return no(`compute unit price ${price} above the ceiling ${ctx.maxCuPriceMicroLamports}`);

    // 4. the buy's CreateIdempotent
    const derived = pumpDirectDerived(owner, mint, tokenProgram, curve.creator);
    if (isBuy) {
      if (!sameBytes(data(2), [1])) return no('associated-token instruction not allowed: only CreateIdempotent');
      const want = [owner, derived.associatedUser, owner, mint, SYSTEM_PROGRAM_ID, tokenProgram];
      if (accountsOf[2].length !== want.length || want.some((k, i) => accountsOf[2][i] !== k)) return no('CreateIdempotent for an account other than the owner ATA of the mint');
    }

    // 5. the pump data
    const pumpIndex = isBuy ? 3 : 2;
    const pd = Buffer.from(data(pumpIndex));
    if (isBuy) {
      if (pd.length < 8 || !sameBytes(pd.subarray(0, 8), PUMP_DISC_BUY_EXACT_SOL_IN)) return no('pump instruction is not buy_exact_sol_in');
      if (pd.length !== PUMP_BUY_DATA_LEN) return no(`pump buy data is ${pd.length} bytes, expected ${PUMP_BUY_DATA_LEN}`);
      if (pd[24] !== PUMP_TRACK_VOLUME) return no('pump buy track_volume is not 01');
      if (pd.readBigUInt64LE(8) !== ctx.amountIn) return no('spendable_sol_in differs from the requested amount');
      if (pd.readBigUInt64LE(16) !== bounds.value.minOut) return no(`min_tokens_out ${pd.readBigUInt64LE(16)} differs from the bound ${bounds.value.minOut}`);
    } else {
      if (pd.length < 8 || !sameBytes(pd.subarray(0, 8), PUMP_DISC_SELL)) return no('pump instruction is not sell');
      if (pd.length !== PUMP_SELL_DATA_LEN) return no(`pump sell data is ${pd.length} bytes, expected ${PUMP_SELL_DATA_LEN}`);
      if (pd.readBigUInt64LE(8) !== ctx.amountIn) return no('sell amount differs from the requested amount');
      if (pd.readBigUInt64LE(16) !== bounds.value.minOut) return no(`min_sol_output ${pd.readBigUInt64LE(16)} differs from the bound ${bounds.value.minOut}`);
    }

    // 6. the pump accounts, position by position
    const expected = pumpDirectExpectedAccounts({ side, owner, mint, tokenProgram, creator: curve.creator, mayhem: curve.mayhem, cashback: curve.cashback });
    const pacc = accountsOf[pumpIndex];
    if (pacc.length !== expected.length) return no(`pump instruction has ${pacc.length} accounts, expected ${expected.length}`);
    for (let i = 0; i < expected.length; i++) {
      const e = expected[i];
      if (e.key !== null ? pacc[i] !== e.key : !(e.list ?? []).includes(pacc[i])) {
        return no(e.listName !== null ? `account ${i} (${e.name}) is not in the ${e.listName} list` : `account ${i} (${e.name})`);
      }
    }

    // 7. the tip (before the roles: its account is part of the expected key set)
    let tip: string | null = null;
    if (ctx.antiMev) {
      const t = ixs.length - 1;
      if (!sameBytes(data(t), PF_DIRECT_TIP_DATA)) return no(`tip instruction is not a ${PF_DIRECT_TIP_LAMPORTS}-lamport System transfer`);
      if (accountsOf[t].length !== 2 || accountsOf[t][0] !== owner) return no('tip transfer not from the owner');
      if (!TIP_ACCOUNTS.includes(accountsOf[t][1])) return no(`tip to non-allowlisted address ${accountsOf[t][1]}`);
      tip = accountsOf[t][1];
    }

    // 8. the static key set and each key's role (signer, writable) as the header gives it
    const roles = new Map<string, { name: string; signer: boolean; writable: boolean }>();
    const role = (key: string, name: string, signer: boolean, writable: boolean): void => {
      const prev = roles.get(key);
      roles.set(key, prev ? { name: prev.name, signer: prev.signer || signer, writable: prev.writable || writable } : { name, signer, writable });
    };
    role(owner, 'owner', true, true);
    role(COMPUTE_BUDGET_PROGRAM_ID, 'compute budget program', false, false);
    if (isBuy) role(ATA_PROGRAM_ID, 'associated token program', false, false);
    expected.forEach((e, i) => role(pacc[i], e.name, e.signer, e.writable));
    role(PUMP_PROGRAM, 'program', false, false);
    if (tip !== null) role(tip, 'tip account', false, true);
    for (const k of keys) if (!roles.has(k)) return no(`unexpected account ${k}`);
    if (roles.size !== keys.length) return no('an expected account is missing from the message');
    const n = keys.length;
    for (let i = 0; i < n; i++) {
      const isSigner = i < header.numRequiredSignatures;
      const isWritable = isSigner ? i < header.numRequiredSignatures - header.numReadonlySignedAccounts : i < n - header.numReadonlyUnsignedAccounts;
      const want = roles.get(keys[i])!;
      if (want.signer !== isSigner || want.writable !== isWritable) {
        const fmt = (s: boolean, w: boolean): string => `${s ? 'signer' : 'not signer'} ${w ? 'writable' : 'read-only'}`;
        return no(`role of ${want.name}: ${fmt(isSigner, isWritable)}, expected ${fmt(want.signer, want.writable)}`);
      }
    }
    const readonlyUnsigned = isBuy ? 12 : 10;
    if (header.numReadonlyUnsignedAccounts !== readonlyUnsigned) return no(`header: ${header.numReadonlyUnsignedAccounts} read-only unsigned accounts, expected ${readonlyUnsigned}`);

    // 9. size
    const size = tx.serialize().length;
    if (size > TX_PACKET_BYTES) return no(`transaction is ${size} bytes, above ${TX_PACKET_BYTES}`);

    const fee = computeBudgetFeeLamports(tx);
    if (!fee.ok) return no(fee.reason);
    return {
      ok: true, tokenProgram, curve, quoted: bounds.value.quoted, minOut: bounds.value.minOut, ownerAta: derived.associatedUser,
      bondingCurve: derived.bondingCurve, creatorVault: derived.creatorVault, userVolumeAccumulator: derived.userVolumeAccumulator,
      priorityFeeLamports: fee.lamports, tipLamports: ctx.antiMev ? PF_DIRECT_TIP_LAMPORTS : 0n, pumpIndex,
    };
  } catch (e) {
    return no(`verification error: ${errorReason(e)}`);
  }
}

/** The custom program error of `err` when its failing instruction is `index`, else null. */
export function customErrorAt(err: unknown, index: number): number | null {
  const ie = (err as { InstructionError?: unknown } | null)?.InstructionError;
  if (!Array.isArray(ie) || ie[0] !== index) return null;
  const c = (ie[1] as { Custom?: unknown } | null)?.Custom;
  return typeof c === 'number' && Number.isInteger(c) ? c : null;
}

const NOTHING_SENT = 'Nothing was sent; no fee was paid.';
/** The PreSignRefusal of a failed PF-direct simulation, in words the owner reads (insufficient SOL as send-context.ts words it). */
export function pumpSimulationRefusal(err: unknown, logs: unknown, pumpIndex: number): PreSignRefusal {
  const base = simulationRefusal(err, logs);
  if (base.kind === 'insufficient-sol') return base;
  const code = customErrorAt(err, pumpIndex);
  if (code === 6042 || code === 6002 || code === 6003) return new PreSignRefusal('simulation-failed', `the price moved past the slippage limit (pump error ${code}). ${NOTHING_SENT}`);
  if (code === 6021) return new PreSignRefusal('simulation-failed', `the bonding curve has fewer tokens left than this buy (pump error 6021). ${NOTHING_SENT}`);
  if (code === 6005) return new PreSignRefusal('simulation-failed', `the bonding curve is complete, the coin has migrated (pump error 6005). ${NOTHING_SENT}`);
  if (code !== null && PUMP_LAYOUT_ERROR_CODES.has(code)) return new PreSignRefusal('simulation-failed', `pump refused the transaction layout (error ${code}). ${NOTHING_SENT}`);
  return base;
}

export interface PumpDirectSimDeps {
  rpc: ExecRpc;
  /** Budget of the simulation and its pre-state read together (default 2 500 ms). */
  timeoutMs?: number;
  /** Called with the pump error code when the simulation failed with a layout error (PUMP_LAYOUT_ERROR_CODES): feeds the breaker. */
  onLayoutRejected?(code: number): void;
}

export interface PumpDirectVerified {
  tokenProgram: string;
  quoted: bigint;
  minOut: bigint;
  unitsConsumed: number | null;
  priorityFeeLamports: bigint;
}

const rawOf = (v: ChainAccount | null | undefined): RawAccount | null => (v ? { owner: v.owner, data: v.data } : null);

/**
 * verifyPumpDirectStatic, then ONE round trip at 'processed' within PF_DIRECT_SIM_BUDGET_MS: simulateTransaction of the unsigned bytes
 * (sigVerify false, replaceRecentBlockhash false, post states of the owner and the owner's ATA) and, in parallel, the pre-state of
 * [owner, owner ATA, user_volume_accumulator, creator_vault, bonding_curve, mint]. Throws (nothing is signed) on:
 *   a static refusal, a timeout or an RPC error (PumpDirectRefusal 'verify');
 *   value.err (PreSignRefusal through pumpSimulationRefusal; a layout error also calls onLayoutRejected);
 *   identity drift between the build read and the fresh read (creator, mayhem, cashback, quote mint, complete, mint program);
 *   a buy whose token delta is below min_tokens_out or whose lamport outflow is above amountIn + priority fee + tip + 5 000 + the rent of a
 *   missing ATA / user_volume_accumulator + the creator vault's shortfall to rent; a sell whose ATA does not fall by exactly amountIn or
 *   whose SOL received + fees is below min_sol_output; any delegate, close authority, owner or state change on the owner's token account;
 *   more than 200 000 units.
 */
export async function verifyPumpDirectTx(tx: VersionedTransaction, ctx: PumpDirectVerifyCtx, deps: PumpDirectSimDeps): Promise<PumpDirectVerified> {
  const st = verifyPumpDirectStatic(tx, ctx);
  if (!st.ok) throw new PumpDirectRefusal('verify', `tx-verify refused the ${ctx?.side ?? ''} transaction: ${st.reason}`);
  const refuse = (why: string): PumpDirectRefusal => new PumpDirectRefusal('verify', `${ctx.side} simulation: ${errorReason(why)}`);
  const owner = ctx.owner;
  const b64 = Buffer.from(tx.serialize()).toString('base64');
  let res: [any, any] | null;
  try {
    res = await withTimeout(Promise.all([
      deps.rpc.call('simulateTransaction', [b64, {
        encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'processed',
        accounts: { encoding: 'base64', addresses: [owner, st.ownerAta] },
      }]),
      deps.rpc.call('getMultipleAccounts', [[owner, st.ownerAta, st.userVolumeAccumulator, st.creatorVault, st.bondingCurve, ctx.mint], { encoding: 'base64', commitment: 'processed' }]),
    ]), deps.timeoutMs ?? PF_DIRECT_SIM_BUDGET_MS);
  } catch (e) {
    throw refuse(`unavailable: ${errorReason(e)}`);
  }
  if (res === null) throw refuse('timed out');
  const [sim, pre] = res;
  const v = sim?.value;
  if (!v || typeof v !== 'object') throw refuse('no result');
  if (v.err !== null && v.err !== undefined) {
    const code = customErrorAt(v.err, st.pumpIndex);
    if (code !== null && PUMP_LAYOUT_ERROR_CODES.has(code)) deps.onLayoutRejected?.(code);
    throw pumpSimulationRefusal(v.err, v.logs, st.pumpIndex);
  }
  const units = typeof v.unitsConsumed === 'number' ? v.unitsConsumed : null;
  if (units !== null && units > PF_DIRECT_CU_LIMIT) throw refuse(`${units} compute units, above ${PF_DIRECT_CU_LIMIT}`);

  // identity drift between the build read and the fresh read (reserves may move)
  const preList = pre?.value;
  if (!Array.isArray(preList) || preList.length !== 6) throw refuse('pre-state unreadable');
  const parsed = preList.map((x: unknown) => parseChainAccount(x));
  if (parsed.some((x) => x === undefined)) throw refuse('pre-state unreadable');
  const fresh = classifyPumpCurve(rawOf(parsed[4]));
  if (!fresh.ok) throw refuse(`the curve changed (${fresh.code})`);
  const was = st.curve;
  const now = fresh.value;
  if (now.creator !== was.creator || now.mayhem !== was.mayhem || now.cashback !== was.cashback || now.quoteMint !== was.quoteMint) throw refuse('the curve identity changed between the reads');
  if (parsed[5]?.owner !== st.tokenProgram) throw refuse('the mint program changed between the reads');

  // the owner's flows
  const post = v.accounts;
  if (!Array.isArray(post) || post.length !== 2) throw refuse('accounts unreadable');
  const postOwner = parseChainAccount(post[0]);
  const postAta = parseChainAccount(post[1]);
  const preOwner = parsed[0];
  const preAta = parsed[1] ?? null;
  if (!preOwner || !postOwner || postAta === undefined) throw refuse('owner accounts unreadable');
  const tokensOf = (a: ChainAccount | null): bigint | null => {
    if (a === null) return 0n;
    const t = ownerTokenAccount(owner, a);
    return t !== null && t.mint === ctx.mint ? t.amount : null;
  };
  const tokPre = tokensOf(preAta);
  const tokPost = tokensOf(postAta);
  if (tokPre === null || tokPost === null) throw refuse('the token account is not the owner account of the mint');
  const fees = st.priorityFeeLamports + st.tipLamports + LAMPORTS_PER_SIGNATURE_FEE;
  if (ctx.side === 'buy') {
    if (tokPost - tokPre < st.minOut) throw refuse(`token delta ${tokPost - tokPre} below min_tokens_out ${st.minOut}`);
    const vaultLamports = parsed[3]?.lamports ?? 0n;
    const bound = ctx.amountIn + fees
      + (preAta === null ? (st.tokenProgram === TOKEN_2022_PROGRAM_ID ? PF_RENT_BOUND_ATA_TOKEN_2022 : PF_RENT_BOUND_ATA_TOKEN) : 0n)
      + (parsed[2] === null ? PF_RENT_BOUND_USER_VOLUME_ACCUMULATOR : 0n)
      + (vaultLamports < PF_RENT_BOUND_CREATOR_VAULT ? PF_RENT_BOUND_CREATOR_VAULT - vaultLamports : 0n);
    const outflow = preOwner.lamports - postOwner.lamports;
    if (outflow > bound) throw refuse(`owner lamport outflow ${outflow} above the bound ${bound}`);
  } else {
    if (tokPre - tokPost !== ctx.amountIn) throw refuse(`owner token decrease ${tokPre - tokPost}, expected exactly ${ctx.amountIn}`);
    const received = postOwner.lamports - preOwner.lamports + fees;
    if (received < st.minOut) throw refuse(`SOL received ${received} below min_sol_output ${st.minOut}`);
  }
  const why = ownerTokenAccountsRefusal(owner, [st.ownerAta], [preAta], [postAta], new Set([st.ownerAta]));
  if (why !== null) throw refuse(why);
  return { tokenProgram: st.tokenProgram, quoted: st.quoted, minOut: st.minOut, unitsConsumed: units, priorityFeeLamports: st.priorityFeeLamports };
}
