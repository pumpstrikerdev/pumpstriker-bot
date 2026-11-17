/**
 * CURVE PARSE — decode the pump bonding-curve account (pure; R7-W5 extraction out of curve-state.ts, A-104).
 *
 * `anchorAccountDiscriminator`, `GRADUATION_REAL_SOL_LAMPORTS`, `BondingCurveState`, `deriveBondingCurvePda` and `parseBondingCurve`
 * moved here UNCHANGED from curve-state.ts, which re-exports them under the same names. No RPC, no exec-common.ts, so the unsigned
 * wallet builder reads the curve without pulling the server path into its import closure (G-S19).
 *
 * Bonding-curve account layout (Anchor, little endian):
 *    0  discriminator  = sha256("account:BondingCurve")[0..8]  (checked)
 *    8  virtual_token_reserves u64     16 virtual_sol_reserves u64     24 real_token_reserves u64
 *   32  real_sol_reserves u64          40 token_total_supply u64       48 complete bool
 *   49  creator pubkey (32)            81 is_mayhem_mode bool          82 is_cashback_coin bool
 *   83  quote_mint pubkey (32)         ... 141 depth u8 (166 bytes in all)
 *
 * FIX-BUY2 item 6 (2026-11-06; pump IDL BondingCurve, read by the FIX-BUY2 research): a curve may now be quoted in another mint than SOL
 * (USDC or another pump coin). The IDL then names the second reserve virtual_quote_reserves: its unit is that mint's, not lamports, so
 * `virtualSolReserves` / `realSolReserves` below are in quote units whenever `quoteMint` is not WSOL. `quoteMint` is read when the
 * account carries the whole field (115 bytes or more); an older, shorter account has none and stays SOL-quoted, as before.
 */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

/** Pump bonding-curve program (same constant as pumpfun-swap.ts PUMPFUN_PROGRAM_ID; a test keeps them equal). */
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/** Anchor account discriminator rule: first 8 bytes of sha256("account:<Name>"). */
export function anchorAccountDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}
const BONDING_CURVE_DISCRIMINATOR = anchorAccountDiscriminator('BondingCurve');

/** Graduation trigger in lamports of real SOL reserves, the same constant pumpfun-info.ts uses. */
export const GRADUATION_REAL_SOL_LAMPORTS = 85_000_000_000;

export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: string;
  /** null when the account is too short to carry the flag (older curve accounts). */
  isMayhemMode: boolean | null;
  isCashbackCoin: boolean | null;
  /**
   * FIX-BUY2: the curve's quote mint (base58, bytes 83..115), or null when the account is too short to carry it (an older curve: quoted
   * in SOL). All-zero bytes decode to the zero key 11111111111111111111111111111111: that is what pump writes for a SOL-quoted curve
   * (FIX-QUOTE; isSolQuoted below, re-exported by onchain-quote.ts, is the one rule for "reserves are lamports").
   */
  quoteMint: string | null;
}

/**
 * FIX-QUOTE (2026-11-06): the quote mints whose curve reserves are lamports. pump writes Pubkey::default() (all zeros, base58
 * 11111111111111111111111111111111) into `quote_mint` of every SOL-quoted curve: pump's BUY/SELL docs say "bonding_curve.quote_mint is
 * Pubkey::default()" for SOL, the official SDK 4.1.0 treats SOL_LIKE_QUOTE_MINTS = [default, NATIVE_MINT, NATIVE_MINT_2022] as SOL, and
 * read-only mainnet reads on 2026-11-06 found all zeros on every SOL curve checked (mayhem and non-mayhem, plus an older 151-byte one)
 * while a USDC-quoted curve carried the USDC mint. FIX-BUY2 had counted the zero key as "another mint", which sent every SOL curve's
 * valuation to Jupiter.
 * FIX-PUMP: moved here unchanged from onchain-quote.ts (which re-exports both names) so the pure pump files (pump-program.ts, the wallet
 * builder) and the server verifier share the one rule without importing the server path.
 */
export const SOL_QUOTE_MINTS: ReadonlySet<string> = new Set([
  '11111111111111111111111111111111',               // Pubkey::default(): what pump writes for SOL
  'So11111111111111111111111111111111111111112',    // wrapped SOL (SPL Token; exec-common WSOL_MINT, a test keeps them equal)
  '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP',   // wrapped SOL (Token-2022 native mint)
]);

/** True when a curve with this quote mint holds its quote reserves in lamports (null: an older account too short for the field). */
export function isSolQuoted(quoteMint: string | null): boolean {
  return quoteMint === null || SOL_QUOTE_MINTS.has(quoteMint);
}

/** FIX-BUY2: the quote_mint field of the BondingCurve account, bytes [83, 115). */
const QUOTE_MINT_OFFSET = 83;
const QUOTE_MINT_END = QUOTE_MINT_OFFSET + 32;

export function deriveBondingCurvePda(mint: string): string {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    new PublicKey(PUMP_PROGRAM),
  )[0].toBase58();
}

/** Pure: decode a bonding-curve account; null when it is too short or carries another discriminator. */
export function parseBondingCurve(data: Uint8Array | null | undefined): BondingCurveState | null {
  if (!data || data.length < 81) return null;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (!buf.subarray(0, 8).equals(BONDING_CURVE_DISCRIMINATOR)) return null;
  return {
    virtualTokenReserves: buf.readBigUInt64LE(8),
    virtualSolReserves: buf.readBigUInt64LE(16),
    realTokenReserves: buf.readBigUInt64LE(24),
    realSolReserves: buf.readBigUInt64LE(32),
    tokenTotalSupply: buf.readBigUInt64LE(40),
    complete: buf[48] !== 0,
    creator: new PublicKey(buf.subarray(49, 81)).toBase58(),
    isMayhemMode: buf.length > 81 ? buf[81] !== 0 : null,
    isCashbackCoin: buf.length > 82 ? buf[82] !== 0 : null,
    quoteMint: buf.length >= QUOTE_MINT_END ? new PublicKey(buf.subarray(QUOTE_MINT_OFFSET, QUOTE_MINT_END)).toBase58() : null,
  };
}
