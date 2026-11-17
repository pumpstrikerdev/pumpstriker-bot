/**
 * PUMP CURVE IX — the pump.fun bonding-curve program as pure "instructions for payer P" (R7-W5 extraction out of pumpfun-swap.ts, A-104).
 *
 * pumpfun-swap.ts imports this file and re-exports every name it exported before. The server path builds its transactions with these
 * functions (byte-identity goldens pin them); the unsigned wallet builder (unsigned-swap.ts) and the wallet verifier (ext-verify.ts) use
 * the same functions, so the instruction a wallet is asked to sign is built by the code the server signs with.
 *
 * FIX-PUMP (2026-11-06): the builders follow pump's 2026-04-28 layout (pump-program.ts holds the ids, lists, discriminators and the math):
 *   buy_exact_sol_in  [56, 252, 116, 8, 158, 223, 205, 95]  18 accounts, 25 bytes: spendable_sol_in u64 | min_tokens_out u64 | track_volume 01
 *   sell              [51, 230, 133, 164, 1, 127, 131, 173]  16 accounts (17 for a cashback coin), 24 bytes: amount u64 | min_sol_output u64
 * The 2026-04-28 accounts are bonding_curve_v2 = PDA(["bonding-curve-v2", mint], pump) read-only, then one of Global's buyback fee recipients
 * writable; account 1 is one of Global's NORMAL fee recipients (RESERVED for a mayhem coin). The recorded mainnet transactions in
 * test-fixtures/execution/pump-chain/ pin every account, flag and byte (pump-chain-layout.test.ts).
 *
 * This file holds no signer, no signing call and no network call.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  ATA_PROGRAM, PUMP_BUYBACK_FEE_RECIPIENTS, PUMP_CREATOR_FEE_BPS_DEFAULT, PUMP_DISC_BUY_EXACT_SOL_IN, PUMP_DISC_SELL, PUMP_EVENT_AUTHORITY,
  PUMP_FEE_PROGRAM, PUMP_FEE_RECIPIENTS_MAYHEM, PUMP_FEE_RECIPIENTS_NORMAL, PUMP_GLOBAL, PUMP_PROGRAM, PUMP_TRACK_VOLUME, TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM, pumpBuyQuote, pumpSellQuote,
} from './pump-program';

// ── Constants ─────────────────────────────────────────────────────
export const PUMPFUN_PROGRAM_ID = new PublicKey(PUMP_PROGRAM);
export const PUMPFUN_GLOBAL            = new PublicKey(PUMP_GLOBAL);
export const PUMPFUN_EVENT_AUTHORITY   = new PublicKey(PUMP_EVENT_AUTHORITY);
export const TOKEN_PROGRAM_PK          = new PublicKey(TOKEN_PROGRAM);
// 2026-05-15 — Pump.fun migrated new bonding-curve mints to Token-2022 (create_v2). The token program is read from the mint account's owner
// for every trade: it changes buy account 8, sell account 9, the seed of both ATAs and the sixth account of CreateIdempotent.
export const TOKEN_2022_PROGRAM_PK     = new PublicKey(TOKEN_2022_PROGRAM);
export const ASSOC_TOKEN_PROGRAM_PK    = new PublicKey(ATA_PROGRAM);
export const PUMPFUN_FEE_PROGRAM       = new PublicKey(PUMP_FEE_PROGRAM);
// Fee config seed: the pump program id bytes (PDA(["fee_config", pump program id], fee program) = 8Wf5..., a test re-derives it).
const FEE_CONFIG_KEY_BYTES = Buffer.from([
  1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170,
  81, 137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
]);

// Anchor instruction discriminators (sha256("global:<name>")[0..8]; pump-program.ts holds them, a test recomputes them).
export const DISCRIMINATOR_BUY_EXACT_SOL_IN = Buffer.from(PUMP_DISC_BUY_EXACT_SOL_IN);
export const DISCRIMINATOR_SELL             = Buffer.from(PUMP_DISC_SELL);

// ── PDA derivations ───────────────────────────────────────────────
export function deriveBondingCurve(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMPFUN_PROGRAM_ID,
  )[0];
}
/** FIX-PUMP: PDA(["bonding-curve-v2", mint], pump), read-only in every trade (the canonical key of every recorded non-agent trade). */
export function deriveBondingCurveV2(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve-v2'), mint.toBuffer()],
    PUMPFUN_PROGRAM_ID,
  )[0];
}
export function deriveCreatorVault(creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PUMPFUN_PROGRAM_ID,
  )[0];
}
export function deriveGlobalVolumeAccumulator(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global_volume_accumulator')],
    PUMPFUN_PROGRAM_ID,
  )[0];
}
export function deriveUserVolumeAccumulator(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()],
    PUMPFUN_PROGRAM_ID,
  )[0];
}
export function deriveFeeConfig(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config'), FEE_CONFIG_KEY_BYTES],
    PUMPFUN_FEE_PROGRAM,
  )[0];
}
// Token-program-aware ATA derivation. The seed includes the token program ID,
// so a Token-2022 mint's ATA address is DIFFERENT from what classic Token
// derivation would produce. Always pass the actual owning program of the mint.
export function deriveAta(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_PK): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOC_TOKEN_PROGRAM_PK,
  )[0];
}

// ── u64 little-endian write (Solana uses LE for Anchor primitives) ──
export function u64LE(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n, 0);
  return buf;
}

// ── Curve math (FIX-PUMP: pump's own fee rule, pump-program.ts) ──
/** Exact (bigint) buy quote: tokens out of buy_exact_sol_in spending `lamps` lamports, fees included (95 + 30 bps); 0 when nothing comes out. */
export function quoteBuyExact(vSol: bigint, vTok: bigint, lamps: bigint): bigint {
  return pumpBuyQuote(vSol, vTok, lamps, PUMP_CREATOR_FEE_BPS_DEFAULT)?.tokensOut ?? 0n;
}
/** Exact (bigint) sell quote: the SOL a seller receives for `tokensIn` atoms after the 95 + 30 bps fees; 0 when nothing comes out. */
export function quoteSellExact(vSol: bigint, vTok: bigint, tokensIn: bigint): bigint {
  const q = pumpSellQuote(vSol, vTok, tokensIn, PUMP_CREATOR_FEE_BPS_DEFAULT);
  return q !== null && q.net > 0n ? q.net : 0n;
}
/** SOL of a buy that enters the curve (the spend net of pump's fees). */
export function buyNetLamports(lamps: bigint): bigint {
  const q = pumpBuyQuote(1n, 1n, lamps, PUMP_CREATOR_FEE_BPS_DEFAULT);
  return q === null ? 0n : q.net;
}

/** Buy quote — given lamports_in (fees included), return tokens_out (number wrapper of quoteBuyExact). */
export function quoteBuy(virtualSolReserves: number, virtualTokenReserves: number, lamportsIn: number): bigint {
  return quoteBuyExact(BigInt(Math.floor(virtualSolReserves)), BigInt(Math.floor(virtualTokenReserves)), BigInt(Math.floor(lamportsIn)));
}

/** Sell quote — given tokens_in, return the lamports the seller receives (number wrapper of quoteSellExact). */
export function quoteSell(virtualSolReserves: number, virtualTokenReserves: number, tokensIn: bigint): bigint {
  return quoteSellExact(BigInt(Math.floor(virtualSolReserves)), BigInt(Math.floor(virtualTokenReserves)), tokensIn);
}

/**
 * Price impact in percent of a constant-product swap whose input (after the fee) enters `reserveIn`, rounded up to 0.0001 %.
 * The same arithmetic as send-context.ts constantProductImpactPct (a test keeps the two equal); send-context.ts imports the server
 * path, so the pure files carry their own copy.
 */
export function constantProductImpactPct(reserveIn: bigint, amountInAfterFee: bigint): number | null {
  if (reserveIn <= 0n || amountInAfterFee < 0n) return null;
  const denom = reserveIn + amountInAfterFee;
  const scaled = (amountInAfterFee * 1_000_000n + denom - 1n) / denom;   // percent * 10_000, rounded up
  return Number(scaled) / 10_000;
}
/** A-26: price impact in percent of a curve buy (the SOL net of pump's fees enters the virtual SOL reserve), fee excluded. */
export function curveBuyImpactPct(virtualSolReserves: number, lamportsIn: number): number | null {
  const vSol = BigInt(Math.floor(virtualSolReserves));
  return constantProductImpactPct(vSol, buyNetLamports(BigInt(Math.floor(lamportsIn))));
}
/** A-26: price impact in percent of a curve sell (the tokens enter the virtual token reserve; the fee comes out of the SOL), fee excluded. */
export function curveSellImpactPct(virtualTokenReserves: number, tokensIn: bigint): number | null {
  return constantProductImpactPct(BigInt(Math.floor(virtualTokenReserves)), tokensIn);
}

// ── Fee accounts (FIX-PUMP) ───────────────────────────────────────
/** Account 1 (fee_recipient) and the last account (buyback_fee_recipient) of a trade. */
export interface PumpFeeAccounts {
  feeRecipient: PublicKey;
  buybackFeeRecipient: PublicKey;
}

/**
 * One NORMAL (or, for a mayhem coin, RESERVED) fee recipient and one buyback recipient, each picked uniformly at random as the SDK's
 * getFeeRecipient and getStaticRandomFeeRecipientForBuyback do (it spreads the write locks). `rand` is injectable; tests pin it.
 */
export function pickPumpFeeAccounts(isMayhem: boolean, rand: () => number = Math.random): PumpFeeAccounts {
  const pick = (list: readonly string[]): string => list[Math.min(list.length - 1, Math.max(0, Math.floor(rand() * list.length)))];
  return {
    feeRecipient: new PublicKey(pick(isMayhem ? PUMP_FEE_RECIPIENTS_MAYHEM : PUMP_FEE_RECIPIENTS_NORMAL)),
    buybackFeeRecipient: new PublicKey(pick(PUMP_BUYBACK_FEE_RECIPIENTS)),
  };
}

// ── Build the buy instruction ─────────────────────────────────────
// buy_exact_sol_in, 18 accounts (the recorded buys 3AUNQ8, 2UmCR7, 2bAbMH and 4YBaBs, byte for byte):
//   0 global R | 1 fee_recipient W | 2 mint R | 3 bonding_curve W | 4 associated_bonding_curve W | 5 associated_user W | 6 user S W |
//   7 system_program R | 8 token_program R | 9 creator_vault W | 10 event_authority R | 11 program R | 12 global_volume_accumulator R |
//   13 user_volume_accumulator W (pump creates it on the first buy) | 14 fee_config R | 15 fee_program R | 16 bonding_curve_v2 R |
//   17 buyback_fee_recipient W
// data: disc | spendable_sol_in (fees included, spent exactly) | min_tokens_out | track_volume 0x01 (25 bytes; partial_fill is not sent).
export function buildBuyInstruction(
  user: PublicKey, mint: PublicKey, creator: PublicKey,
  spendableSolIn: bigint, minTokensOut: bigint,
  tokenProgram: PublicKey, fees: PumpFeeAccounts,
): TransactionInstruction {
  const bondingCurve = deriveBondingCurve(mint);
  const data = Buffer.concat([
    DISCRIMINATOR_BUY_EXACT_SOL_IN,
    u64LE(spendableSolIn),
    u64LE(minTokensOut),
    Buffer.from([PUMP_TRACK_VOLUME]),
  ]);
  return new TransactionInstruction({
    programId: PUMPFUN_PROGRAM_ID,
    keys: [
      { pubkey: PUMPFUN_GLOBAL,                           isSigner: false, isWritable: false },  //  0 global
      { pubkey: fees.feeRecipient,                        isSigner: false, isWritable: true  },  //  1 fee_recipient
      { pubkey: mint,                                     isSigner: false, isWritable: false },  //  2 mint
      { pubkey: bondingCurve,                             isSigner: false, isWritable: true  },  //  3 bonding_curve
      { pubkey: deriveAta(mint, bondingCurve, tokenProgram), isSigner: false, isWritable: true },  //  4 associated_bonding_curve
      { pubkey: deriveAta(mint, user, tokenProgram),      isSigner: false, isWritable: true  },  //  5 associated_user
      { pubkey: user,                                     isSigner: true,  isWritable: true  },  //  6 user (payer)
      { pubkey: SystemProgram.programId,                  isSigner: false, isWritable: false },  //  7 system_program
      { pubkey: tokenProgram,                             isSigner: false, isWritable: false },  //  8 token_program (classic OR Token-2022)
      { pubkey: deriveCreatorVault(creator),              isSigner: false, isWritable: true  },  //  9 creator_vault
      { pubkey: PUMPFUN_EVENT_AUTHORITY,                  isSigner: false, isWritable: false },  // 10 event_authority
      { pubkey: PUMPFUN_PROGRAM_ID,                       isSigner: false, isWritable: false },  // 11 program (self)
      { pubkey: deriveGlobalVolumeAccumulator(),          isSigner: false, isWritable: false },  // 12 global_volume_accumulator (read-only)
      { pubkey: deriveUserVolumeAccumulator(user),        isSigner: false, isWritable: true  },  // 13 user_volume_accumulator
      { pubkey: deriveFeeConfig(),                        isSigner: false, isWritable: false },  // 14 fee_config
      { pubkey: PUMPFUN_FEE_PROGRAM,                      isSigner: false, isWritable: false },  // 15 fee_program
      { pubkey: deriveBondingCurveV2(mint),               isSigner: false, isWritable: false },  // 16 bonding_curve_v2
      { pubkey: fees.buybackFeeRecipient,                 isSigner: false, isWritable: true  },  // 17 buyback_fee_recipient
    ],
    data,
  });
}

// ── Build the sell instruction ────────────────────────────────────
// sell, 16 accounts (top-level 2jca9 with its exact header flags; 3vEJuM; 3cBP): creator_vault comes BEFORE token_program in a sell.
//   0 global R | 1 fee_recipient W | 2 mint R | 3 bonding_curve W | 4 associated_bonding_curve W | 5 associated_user W | 6 user S W |
//   7 system_program R | 8 creator_vault W | 9 token_program R | 10 event_authority R | 11 program R | 12 fee_config R | 13 fee_program R |
//   14 bonding_curve_v2 R | 15 buyback_fee_recipient W
// A cashback coin (curve byte 82 = 1) puts user_volume_accumulator W at 14, then bonding_curve_v2 R and the buyback recipient W: 17
// accounts (pump docs and SDK 4.1.0; no mainnet fixture exists, the pre-sign simulation gates it).
export function buildSellInstruction(
  user: PublicKey, mint: PublicKey, creator: PublicKey,
  amount: bigint, minSolOutput: bigint, cashback: boolean,
  tokenProgram: PublicKey, fees: PumpFeeAccounts,
): TransactionInstruction {
  const bondingCurve = deriveBondingCurve(mint);
  const data = Buffer.concat([
    DISCRIMINATOR_SELL,
    u64LE(amount),
    u64LE(minSolOutput),
  ]);
  const keys = [
    { pubkey: PUMPFUN_GLOBAL,                           isSigner: false, isWritable: false },  //  0 global
    { pubkey: fees.feeRecipient,                        isSigner: false, isWritable: true  },  //  1 fee_recipient
    { pubkey: mint,                                     isSigner: false, isWritable: false },  //  2 mint
    { pubkey: bondingCurve,                             isSigner: false, isWritable: true  },  //  3 bonding_curve
    { pubkey: deriveAta(mint, bondingCurve, tokenProgram), isSigner: false, isWritable: true },  //  4 associated_bonding_curve
    { pubkey: deriveAta(mint, user, tokenProgram),      isSigner: false, isWritable: true  },  //  5 associated_user
    { pubkey: user,                                     isSigner: true,  isWritable: true  },  //  6 user (signer)
    { pubkey: SystemProgram.programId,                  isSigner: false, isWritable: false },  //  7 system_program
    { pubkey: deriveCreatorVault(creator),              isSigner: false, isWritable: true  },  //  8 creator_vault
    { pubkey: tokenProgram,                             isSigner: false, isWritable: false },  //  9 token_program (classic OR Token-2022)
    { pubkey: PUMPFUN_EVENT_AUTHORITY,                  isSigner: false, isWritable: false },  // 10 event_authority
    { pubkey: PUMPFUN_PROGRAM_ID,                       isSigner: false, isWritable: false },  // 11 program (self)
    { pubkey: deriveFeeConfig(),                        isSigner: false, isWritable: false },  // 12 fee_config
    { pubkey: PUMPFUN_FEE_PROGRAM,                      isSigner: false, isWritable: false },  // 13 fee_program
  ];
  if (cashback) keys.push({ pubkey: deriveUserVolumeAccumulator(user), isSigner: false, isWritable: true });   // 14 user_volume_accumulator
  keys.push(
    { pubkey: deriveBondingCurveV2(mint),               isSigner: false, isWritable: false },  // 14 (15) bonding_curve_v2
    { pubkey: fees.buybackFeeRecipient,                 isSigner: false, isWritable: true  },  // 15 (16) buyback_fee_recipient
  );
  return new TransactionInstruction({ programId: PUMPFUN_PROGRAM_ID, keys, data });
}

// ── Idempotent ATA create (so first-time buys work without prior ATA) ──
// tokenProgram must match the actual owner of the mint (classic Token vs
// Token-2022). Passing the wrong one causes IncorrectProgramId — the exact
// failure we saw on $DRAKE + $YINYANG.
export function buildCreateAtaIfNeededIx(
  payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey,
): TransactionInstruction {
  const ata = deriveAta(mint, owner, tokenProgram);
  return new TransactionInstruction({
    programId: ASSOC_TOKEN_PROGRAM_PK,
    keys: [
      { pubkey: payer,                    isSigner: true,  isWritable: true  },
      { pubkey: ata,                      isSigner: false, isWritable: true  },
      { pubkey: owner,                    isSigner: false, isWritable: false },
      { pubkey: mint,                     isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
      { pubkey: tokenProgram,             isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),    // discriminator 1 = idempotent create
  });
}
