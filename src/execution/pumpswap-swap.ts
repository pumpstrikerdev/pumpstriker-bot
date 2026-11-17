/**
 * PUMPSWAP DIRECT SWAP — bypass Jupiter for post-graduation pump.fun tokens.
 *
 * After a pump.fun token graduates (`pf.complete === true`), liquidity
 * moves from the bonding curve into a PumpSwap AMM pool. This module
 * trades against that pool directly.
 *
 * Program: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA (PumpSwap AMM)
 *   • buy  discriminator [102, 6, 61, 18, 1, 218, 235, 234]   args: base_amount_out(u64) max_quote_amount_in(u64) track_volume(OptionBool)
 *   • sell discriminator [51, 230, 133, 164, 1, 127, 131, 173] args: base_amount_in(u64) min_quote_amount_out(u64)
 *
 * A-93g (2026-10-26) — DIRECT PATH DISABLED (fail closed). The account lists, the pool PDA, the pool byte offsets and
 * the protocol-fee ATA below were rebuilt from the official IDL (they were proven wrong: 17 keys instead of 23 / 21,
 * a pool PDA without the creator seed, offsets 33 bytes off and an on-curve "ATA"). What is still NOT verified:
 *   - whether the program accepts the buy without its trailing `track_volume` OptionBool arg (this module omits it);
 *   - the fee model of the local quote (a flat 0.95 %) against the fee_config tiers.
 * Until both are verified, `PUMPSWAP_DIRECT_ENABLED` stays false: pumpswapBuy / pumpswapSell throw
 * PumpSwapDirectDisabledError before any RPC call, build or signature, and the router falls back (pf-direct when the
 * curve is still open, else Jupiter). Sources for every value: the comments next to it.
 *
 * SCOPE: Post-graduation tokens only. Pre-grad tokens are not in any pool.
 *
 * SLIPPAGE: default 150 bps (1.5%) buy / 200 bps (2.0%) sell, override via
 * explicit slippageBps.
 */
import {
  Keypair, VersionedTransaction,
  PublicKey, TransactionMessage, TransactionInstruction,
  ComputeBudgetProgram, SystemProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { CONFIG } from '../config';
import { logOk, logWarn } from '../logger';
import {
  HELIUS_TIP_LAMPORTS,
  heliusSmartSend, multiRpcSend,
  getResilientBlockhash, resilientRpcCall,
} from './jupiter';
import { getTokenProgramForMint } from './pumpfun-swap';
import { dispatchSigned, enforceImpactCap, type SendContext } from './send-context';
import {
  PUMPSWAP_PROGRAM_ID, PUMPSWAP_FEE_RECIPIENT, PUMPSWAP_DIRECT_ENABLED, PumpSwapDirectDisabledError, PUMPSWAP_FEE_RECIPIENT_ATA,
  PUMPSWAP_GLOBAL_VOLUME_ACCUMULATOR, PUMPSWAP_FEE_CONFIG, derivePumpSwapPoolAuthority, derivePumpSwapCanonicalPool,
  deriveCoinCreatorVaultAuthority, derivePumpSwapUserVolumeAccumulator, parsePumpSwapPoolAccount, quoteBuy, quoteSell,
  poolBuyImpactPct, poolSellImpactPct, buildPumpSwapBuyInstruction, buildPumpSwapSellInstruction, buildCreateAtaIfNeededIx, deriveAta,
  TOKEN_PROGRAM_PK, WSOL_MINT_PK, QUOTE_TOKEN_PROGRAM_PK, type PumpSwapPoolAccount, type PoolRefs,
} from './pumpswap-ix';

// ── Constants, PDAs, the Pool decoder, quote math and the instruction builders ──────
// R7-W5 (A-104): they moved, unchanged, into the pure pumpswap-ix.ts (the unsigned wallet builder and verifier use the same functions;
// byte-identity goldens pin the server bytes). Every name this file exported is re-exported under the same name. PUMPSWAP_DIRECT_ENABLED stays ONE
// source of truth: it lives there and the route guard below reads it.
export {
  PUMPSWAP_PROGRAM_ID, PUMPSWAP_FEE_RECIPIENT, PUMPSWAP_DIRECT_ENABLED, PumpSwapDirectDisabledError, PUMPSWAP_FEE_RECIPIENT_ATA,
  PUMPSWAP_GLOBAL_VOLUME_ACCUMULATOR, PUMPSWAP_FEE_CONFIG, derivePumpSwapPoolAuthority, derivePumpSwapCanonicalPool,
  deriveCoinCreatorVaultAuthority, derivePumpSwapUserVolumeAccumulator, parsePumpSwapPoolAccount, quoteBuy, quoteSell,
  poolBuyImpactPct, poolSellImpactPct, buildPumpSwapBuyInstruction, buildPumpSwapSellInstruction,
};
export type { PumpSwapPoolAccount, PoolRefs };

// ── Pool state cache ──────────────────────────────────────────────
export interface PoolState extends PumpSwapPoolAccount {
  pool:               PublicKey;
  baseReserves:       bigint;
  quoteReserves:      bigint;
  fetchedAt:          number;
}
const _poolCache = new Map<string, PoolState>();
const POOL_TTL_MS = 5_000;          // freshness for trade execution

/** Read PumpSwap pool state from-chain. Reserves are read from the pool's TOKEN ACCOUNTS (not the pool struct itself). */
async function fetchPoolState(baseMint: string): Promise<PoolState | null> {
  const cached = _poolCache.get(baseMint);
  if (cached && Date.now() - cached.fetchedAt < POOL_TTL_MS) return cached;

  const baseMintPk = new PublicKey(baseMint);
  const pool       = derivePumpSwapCanonicalPool(baseMintPk);
  try {
    const acc = await resilientRpcCall('getAccountInfo', [
      pool.toBase58(),
      { encoding: 'base64', commitment: 'processed' },
    ]);
    const data = acc?.value?.data?.[0];
    if (!data) return null;
    const parsed = parsePumpSwapPoolAccount(Buffer.from(data, 'base64'), baseMintPk);
    if (!parsed) return null;

    // Read reserves from the pool token accounts in parallel
    const [baseRes, quoteRes] = await Promise.all([
      resilientRpcCall('getTokenAccountBalance', [parsed.poolBaseAccount.toBase58()]),
      resilientRpcCall('getTokenAccountBalance', [parsed.poolQuoteAccount.toBase58()]),
    ]);
    const baseReserves  = BigInt(baseRes?.value?.amount  || 0);
    const quoteReserves = BigInt(quoteRes?.value?.amount || 0);
    if (baseReserves === 0n || quoteReserves === 0n) return null;

    const state: PoolState = { ...parsed, pool, baseReserves, quoteReserves, fetchedAt: Date.now() };
    _poolCache.set(baseMint, state);
    return state;
  } catch (e: any) {
    logWarn(`[pumpswap] pool fetch err ${baseMint.slice(0, 8)}: ${e.message || e}`);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────
export interface PumpSwapResult {
  sig: string;
  tokensOut?: bigint;
  solOut?: bigint;
  /** B40: the pre-slippage QUOTE (same value as tokensOut/solOut). A quote is never a fill; fills come from fills.ts. */
  tokensOutQuoted?: bigint;
  solOutQuoted?: bigint;
  slippageBpsUsed: number;
}

/** A-26 additions (optional, so every existing call site keeps compiling and behaving). */
export interface PumpSwapExecOpts {
  /** The router's send context: impact cap, onSigned, buildOnly, singleSend and the sent-signature record. */
  send?: SendContext;
  /**
   * TESTS ONLY (A-93g): runs the disabled direct route anyway so its build / sign / send mechanics stay covered by
   * mocked-RPC tests. The router never sets it (pinned by a test), so production always gets the fail-closed refusal.
   */
  testOnlyRunDisabledRoute?: true;
}

function assertDirectEnabled(side: 'buy' | 'sell', execOpts: PumpSwapExecOpts): void {
  if (!PUMPSWAP_DIRECT_ENABLED && execOpts.testOnlyRunDisabledRoute !== true) throw new PumpSwapDirectDisabledError(side);
}

export async function pumpswapBuy(
  keypair: Keypair, mint: string, solIn: number,
  slippageBps?: number | null, priorityFee: number = 100_000,
  antiMev: boolean = true,
  execOpts: PumpSwapExecOpts = {},
): Promise<PumpSwapResult> {
  assertDirectEnabled('buy', execOpts);   // A-93g: before any RPC call, build or signature
  const pool = await fetchPoolState(mint);
  if (!pool) throw new Error(`PumpSwap: no pool for ${mint.slice(0,8)}…`);

  const slip = (slippageBps != null && slippageBps > 0) ? slippageBps : 150;
  const lamportsIn = BigInt(Math.floor(solIn * LAMPORTS_PER_SOL));
  const tokensOut  = quoteBuy(pool.baseReserves, pool.quoteReserves, lamportsIn);
  if (tokensOut === 0n) throw new Error('PumpSwap: buy quote returned 0 tokens');
  // A-26: the route's own quote impact, checked before anything is built or signed.
  enforceImpactCap(execOpts.send, 'pumpswap-direct', poolBuyImpactPct(pool.quoteReserves, lamportsIn));
  const minTokens  = (tokensOut * BigInt(10_000 - slip)) / 10_000n;
  const maxQuoteIn = (lamportsIn * BigInt(10_000 + slip)) / 10_000n;

  const user = keypair.publicKey;
  const baseMint = new PublicKey(mint);
  const baseTokenProgram = await getTokenProgramForMint(mint);
  // Wrap SOL into wSOL ATA atomically — PumpSwap takes wSOL on the quote side
  const wsolAta = deriveAta(WSOL_MINT_PK, user);
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
    buildCreateAtaIfNeededIx(user, user, WSOL_MINT_PK, QUOTE_TOKEN_PROGRAM_PK),
    buildCreateAtaIfNeededIx(user, user, baseMint, baseTokenProgram),
    SystemProgram.transfer({ fromPubkey: user, toPubkey: wsolAta, lamports: Number(maxQuoteIn) }),
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_PK,
      keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }],
      data: Buffer.from([17]),    // SyncNative
    }),
    buildPumpSwapBuyInstruction(user, baseMint, pool, baseTokenProgram, minTokens, maxQuoteIn),
    // Close the wSOL ATA at the end so leftover wSOL refunds to native SOL
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_PK,
      keys: [
        { pubkey: wsolAta, isSigner: false, isWritable: true  },
        { pubkey: user,    isSigner: false, isWritable: true  },
        { pubkey: user,    isSigner: true,  isWritable: false },
      ],
      data: Buffer.from([9]),    // CloseAccount
    }),
  ];

  if (antiMev) {
    const tipAccount = CONFIG.HELIUS_TIP_ACCOUNTS[
      Math.floor(Math.random() * CONFIG.HELIUS_TIP_ACCOUNTS.length)
    ];
    ixs.push(SystemProgram.transfer({
      fromPubkey: user, toPubkey: new PublicKey(tipAccount), lamports: HELIUS_TIP_LAMPORTS,
    }));
  }

  const { blockhash, lastValidBlockHeight } = await getResilientBlockhash();
  const msg = new TransactionMessage({
    payerKey: user, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([keypair]);

  // 2026-05-05 — BUY async confirm: returns sig in ~50-100ms, background logs revert.
  // A-26: the blockhash we built with carries its own lastValidBlockHeight (the builder's value).
  const { sig } = await dispatchSigned(execOpts.send, tx, 'pumpswap-direct', lastValidBlockHeight, () =>
    antiMev && CONFIG.HELIUS_SENDER_URL
      ? heliusSmartSend(tx, { awaitConfirm: false })
      : multiRpcSend(tx, { awaitConfirm: false }));

  logOk(`PumpSwap BUY ${mint.slice(0,8)}… ${solIn} SOL slip=${slip}bps sig=${sig.slice(0,12)}…`);
  return { sig, tokensOut, tokensOutQuoted: tokensOut, slippageBpsUsed: slip };
}

export async function pumpswapSell(
  keypair: Keypair, mint: string, tokensIn: bigint,
  slippageBps?: number | null, priorityFee: number = 100_000,
  antiMev: boolean = true,
  execOpts: PumpSwapExecOpts = {},
): Promise<PumpSwapResult> {
  assertDirectEnabled('sell', execOpts);   // A-93g: before any RPC call, build or signature
  const pool = await fetchPoolState(mint);
  if (!pool) throw new Error(`PumpSwap: no pool for ${mint.slice(0,8)}…`);

  const slip = (slippageBps != null && slippageBps > 0) ? slippageBps : 200;
  const solOut    = quoteSell(pool.baseReserves, pool.quoteReserves, tokensIn);
  if (solOut === 0n) throw new Error('PumpSwap: sell quote returned 0 SOL');
  // A-26: the route's own quote impact, checked before anything is built or signed.
  enforceImpactCap(execOpts.send, 'pumpswap-direct', poolSellImpactPct(pool.baseReserves, tokensIn));
  const minSolOut = (solOut * BigInt(10_000 - slip)) / 10_000n;

  const user = keypair.publicKey;
  const baseMint = new PublicKey(mint);
  const baseTokenProgram = await getTokenProgramForMint(mint);
  const wsolAta = deriveAta(WSOL_MINT_PK, user);
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
    buildCreateAtaIfNeededIx(user, user, WSOL_MINT_PK, QUOTE_TOKEN_PROGRAM_PK),
    buildPumpSwapSellInstruction(user, baseMint, pool, baseTokenProgram, tokensIn, minSolOut),
    // Close wSOL ATA so the SOL out lands as native SOL in the user's wallet
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_PK,
      keys: [
        { pubkey: wsolAta, isSigner: false, isWritable: true  },
        { pubkey: user,    isSigner: false, isWritable: true  },
        { pubkey: user,    isSigner: true,  isWritable: false },
      ],
      data: Buffer.from([9]),    // CloseAccount
    }),
  ];

  if (antiMev) {
    const tipAccount = CONFIG.HELIUS_TIP_ACCOUNTS[
      Math.floor(Math.random() * CONFIG.HELIUS_TIP_ACCOUNTS.length)
    ];
    ixs.push(SystemProgram.transfer({
      fromPubkey: user, toPubkey: new PublicKey(tipAccount), lamports: HELIUS_TIP_LAMPORTS,
    }));
  }

  const { blockhash, lastValidBlockHeight } = await getResilientBlockhash();
  const msg = new TransactionMessage({
    payerKey: user, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([keypair]);

  // 2026-05-05 — SELL blocks on confirm (capital-protection: prevents
  // position monitor from re-firing sells before knowing prior landed →
  // last night's 1500 failed TX storm was caused by missing confirmation).
  const { sig } = await dispatchSigned(execOpts.send, tx, 'pumpswap-direct', lastValidBlockHeight, () =>
    antiMev && CONFIG.HELIUS_SENDER_URL
      ? heliusSmartSend(tx, { awaitConfirm: true })
      : multiRpcSend(tx, { awaitConfirm: true }));

  logOk(`PumpSwap SELL ${mint.slice(0,8)}… ${tokensIn} atoms slip=${slip}bps sig=${sig.slice(0,12)}…`);
  return { sig, solOut, solOutQuoted: solOut, slippageBpsUsed: slip };
}

/** Returns true if a PumpSwap pool exists for this mint (post-grad PF token). */
export async function hasPumpSwapPool(mint: string): Promise<boolean> {
  const p = await fetchPoolState(mint);
  return !!p;
}
