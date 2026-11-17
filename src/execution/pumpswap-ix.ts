/**
 * PUMPSWAP IX — the PumpSwap AMM program as pure "instructions for payer P" (R7-W5 extraction out of pumpswap-swap.ts, A-104, A-93g).
 *
 * Everything here moved UNCHANGED from pumpswap-swap.ts (the A-93g IDL layouts), which imports it and re-exports every name it
 * exported before under the same name; FIXAB-T01 ... T07 and every other test of pumpswap-swap.ts stay as they were. The server path
 * builds its transactions with these functions and produces the same bytes (byte-identity goldens pin them).
 *
 * This file never imports pumpfun-swap.ts (which pumpswap-swap.ts imports for getTokenProgramForMint): the unsigned builder learns the
 * mint's token program from its own chain read. It holds no Keypair, no signing call and no network call.
 *
 * Program: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA (PumpSwap AMM)
 *   - buy  discriminator [102, 6, 61, 18, 1, 218, 235, 234]   args: base_amount_out(u64) max_quote_amount_in(u64) track_volume(OptionBool)
 *   - sell discriminator [51, 230, 133, 164, 1, 127, 131, 173] args: base_amount_in(u64) min_quote_amount_out(u64)
 *
 * A-93g (2026-10-26) - DIRECT PATH DISABLED (fail closed): `PUMPSWAP_DIRECT_ENABLED` stays false, ONE source of truth for the server
 * route and for the wallet route. What is still NOT verified:
 *   - whether the program accepts the buy without its trailing `track_volume` OptionBool arg (the builder omits it);
 *   - the fee model of the local quote (a flat 0.95 %) against the fee_config tiers.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

// ── Constants ─────────────────────────────────────────────────────
// Sources (checked 2026-10-26): https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump_amm.json
// (program address; global_config seed 'global_config'; event_authority seed '__event_authority') and
// https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md (62qc2... is protocol fee recipient
// #1); the PDAs were re-derived locally from the IDL seeds with @solana/web3.js findProgramAddressSync.
export const PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const PUMPSWAP_GLOBAL            = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
export const PUMPSWAP_EVENT_AUTHORITY   = new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
export const PUMPSWAP_FEE_RECIPIENT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');

export const TOKEN_PROGRAM_PK         = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOC_TOKEN_PROGRAM_PK   = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const WSOL_MINT_PK             = new PublicKey('So11111111111111111111111111111111111111112');
/** The quote side is always WSOL, owned by the classic Token program (the IDL's quote_token_program). */
export const QUOTE_TOKEN_PROGRAM_PK   = TOKEN_PROGRAM_PK;
/** Pump bonding-curve program: the `migrate` instruction derives the canonical pool from its pool_authority PDA. */
const PUMP_PROGRAM_PK          = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
// Fee program, mandatory on buy and sell from Sept 1. Sources (2026-10-26): pump_amm.json (buy/sell fee_program
// address) and https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_PROGRAM_README.md.
export const PUMPSWAP_FEE_PROGRAM     = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

export const DISCRIMINATOR_BUY  = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
export const DISCRIMINATOR_SELL = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
/**
 * Pool account discriminator. Sources (2026-10-26): pump_amm.json `accounts` entry "Pool", and locally
 * sha256('account:Pool')[0..8] (the Anchor rule) — both [241, 154, 109, 4, 17, 177, 109, 188].
 */
export const POOL_ACCOUNT_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);

/**
 * A-93g: the direct PumpSwap route stays OFF (fail closed) until the buy's trailing track_volume arg and the fee model
 * of the local quote are verified (CUTOVER section 6). Changing this needs an amendment, not a config value.
 */
export const PUMPSWAP_DIRECT_ENABLED: boolean = false;

export class PumpSwapDirectDisabledError extends Error {
  constructor(side: 'buy' | 'sell') {
    super(`PumpSwap direct disabled: instruction data layout and fee model unverified (A-93g), ${side} falls back`);
    this.name = 'PumpSwapDirectDisabledError';
  }
}

// ── PDA derivations ───────────────────────────────────────────────
export function deriveAta(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_PK): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOC_TOKEN_PROGRAM_PK,
  )[0];
}

/**
 * Protocol fee recipient's WSOL token account = ATA(62qc2..., WSOL) under the classic Token program.
 * The IDL constrains protocol_fee_recipient_token_account to exactly this ATA (seeds protocol_fee_recipient,
 * quote_token_program, quote_mint; program ATokenGP...). Sources (2026-10-26): pump_amm.json buy/sell accounts;
 * local findProgramAddressSync. The old literal ...YDgK was ON the ed25519 curve, so it could never be an ATA.
 */
export const PUMPSWAP_FEE_RECIPIENT_ATA = new PublicKey('94qWNrtmfn42h3ZjUZwWvK1MEo9uVmmrBPd2hpNjYDjb');

/** PDA(['global_volume_accumulator'], pAMM). Sources (2026-10-26): pump_amm.json buy accounts (seed, read-only); local derivation. */
export const PUMPSWAP_GLOBAL_VOLUME_ACCUMULATOR = new PublicKey('C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw');
/**
 * PDA(['fee_config', pAMM program id], pfee). Sources (2026-10-26): pump_amm.json buy/sell fee_config seeds (const
 * 'fee_config' + the 32 bytes of pAMMBay6...; program = fee_program); FEE_PROGRAM_README.md; local derivation.
 */
export const PUMPSWAP_FEE_CONFIG = new PublicKey('5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx');

/** PDA(['pool-authority', mint], pump). Source (2026-10-26): pump.json `migrate` / `admin_cto` pool_authority seeds. */
export function derivePumpSwapPoolAuthority(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), mint.toBuffer()], PUMP_PROGRAM_PK)[0];
}

/**
 * Canonical pool of a migrated pump.fun coin: PDA(['pool', u16LE(0), pool_authority, base_mint, WSOL], pAMM).
 * Sources (2026-10-26): pump_amm.json create_pool seeds ('pool', index, creator, base_mint, quote_mint); pump.json
 * migrate pool seeds ('pool', [0,0], pool_authority, mint, wsol_mint); PUMP_SWAP_README.md (migrate uses index 0).
 * The old derivation had no creator seed, so it never named a real pool.
 */
export function derivePumpSwapCanonicalPool(baseMint: PublicKey): PublicKey {
  const indexBuf = Buffer.alloc(2);
  indexBuf.writeUInt16LE(0, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), indexBuf, derivePumpSwapPoolAuthority(baseMint).toBuffer(), baseMint.toBuffer(), WSOL_MINT_PK.toBuffer()],
    PUMPSWAP_PROGRAM_ID,
  )[0];
}

/** PDA(['creator_vault', pool.coin_creator], pAMM). Sources (2026-10-26): pump_amm.json; PUMP_SWAP_CREATOR_FEE_README.md. */
export function deriveCoinCreatorVaultAuthority(coinCreator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('creator_vault'), coinCreator.toBuffer()], PUMPSWAP_PROGRAM_ID)[0];
}

/** PDA(['user_volume_accumulator', user], pAMM). Source (2026-10-26): pump_amm.json buy accounts. */
export function derivePumpSwapUserVolumeAccumulator(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMPSWAP_PROGRAM_ID)[0];
}

export function u64LE(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n, 0);
  return buf;
}

// ── Pool account ──────────────────────────────────────────────────
/**
 * The fields of a Pool account this module reads. Byte offsets from the IDL Pool type in field order (Borsh):
 *   0 discriminator(8)  8 pool_bump u8  9 index u16  11 creator  43 base_mint  75 quote_mint  107 lp_mint
 *   139 pool_base_token_account  171 pool_quote_token_account  203 lp_supply u64  211 coin_creator
 *   243 is_mayhem_mode bool  244 is_cashback_coin bool  245 virtual_quote_reserves i128 (to 261)
 * Sources (2026-10-26): pump_amm.json Pool type (pool_bump is u8); PUMP_SWAP_README.md (same field list); local
 * Borsh offset arithmetic. The old reader assumed a 2-byte bump and read every key 33 bytes off.
 */
export interface PumpSwapPoolAccount {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  poolBaseAccount: PublicKey;
  poolQuoteAccount: PublicKey;
  coinCreator: PublicKey;
}
const POOL_COIN_CREATOR_END = 243;
const POOL_VIRTUAL_QUOTE_OFF = 245;

/**
 * Pure: decode a Pool account for `baseMint`; null (fail closed) when the discriminator, the base mint or the WSOL
 * quote mint do not match, the account is too short, or virtual_quote_reserves is non-zero (the local x*y quote does
 * not model it; an absent field counts as 0, the legacy behaviour the IDL describes).
 */
export function parsePumpSwapPoolAccount(data: Uint8Array, baseMint: PublicKey): PumpSwapPoolAccount | null {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < POOL_COIN_CREATOR_END) return null;
  if (!buf.subarray(0, 8).equals(POOL_ACCOUNT_DISCRIMINATOR)) return null;
  const key = (off: number): PublicKey => new PublicKey(buf.subarray(off, off + 32));
  const acc: PumpSwapPoolAccount = {
    baseMint: key(43), quoteMint: key(75), poolBaseAccount: key(139), poolQuoteAccount: key(171), coinCreator: key(211),
  };
  if (!acc.baseMint.equals(baseMint) || !acc.quoteMint.equals(WSOL_MINT_PK)) return null;
  if (buf.length >= POOL_VIRTUAL_QUOTE_OFF + 16) {
    const lo = buf.readBigUInt64LE(POOL_VIRTUAL_QUOTE_OFF);
    const hi = buf.readBigUInt64LE(POOL_VIRTUAL_QUOTE_OFF + 8);
    if (lo !== 0n || hi !== 0n) return null;
  }
  return acc;
}

// ── Curve math (constant product with 0.95% fee on quote side) ────
// NOT verified against the fee_config tiers (A-93g open item): one reason the direct route stays disabled.
/** Exported for onchain-quote.ts / tests (B40): the router's own quote math. */
export function quoteBuy(baseRes: bigint, quoteRes: bigint, lamportsIn: bigint): bigint {
  if (lamportsIn === 0n) return 0n;
  const usable = (lamportsIn * 9905n) / 10_000n;     // -0.95% LP fee
  if (usable === 0n) return 0n;
  const newQuote = quoteRes + usable;
  const newBase  = (baseRes * quoteRes) / newQuote;
  return baseRes - newBase;
}
/** Exported for onchain-quote.ts / tests (B40): the router's own quote math. */
export function quoteSell(baseRes: bigint, quoteRes: bigint, tokensIn: bigint): bigint {
  if (tokensIn === 0n) return 0n;
  const newBase   = baseRes + tokensIn;
  const newQuote  = (baseRes * quoteRes) / newBase;
  const grossOut  = quoteRes - newQuote;
  return (grossOut * 9905n) / 10_000n;               // -0.95% LP fee
}

/** The same arithmetic as send-context.ts constantProductImpactPct (a test keeps the two equal): percent rounded up to 0.0001 %. */
export function constantProductImpactPct(reserveIn: bigint, amountInAfterFee: bigint): number | null {
  if (reserveIn <= 0n || amountInAfterFee < 0n) return null;
  const denom = reserveIn + amountInAfterFee;
  const scaled = (amountInAfterFee * 1_000_000n + denom - 1n) / denom;   // percent * 10_000, rounded up
  return Number(scaled) / 10_000;
}
/** A-26: price impact in percent of a buy (the SOL after the 0.95% LP fee enters the quote reserve), fee excluded. */
export function poolBuyImpactPct(quoteRes: bigint, lamportsIn: bigint): number | null {
  return constantProductImpactPct(quoteRes, (lamportsIn * 9905n) / 10_000n);
}
/** A-26: price impact in percent of a sell (the tokens enter the base reserve; the fee comes out of the SOL), fee excluded. */
export function poolSellImpactPct(baseRes: bigint, tokensIn: bigint): number | null {
  return constantProductImpactPct(baseRes, tokensIn);
}

// ── Build buy/sell instructions ───────────────────────────────────
/** What the builders need from the pool: its address and the fields of its account. */
export type PoolRefs = Pick<PumpSwapPoolAccount, 'poolBaseAccount' | 'poolQuoteAccount' | 'coinCreator'> & { pool: PublicKey };

/**
 * Accounts 0..18, shared by buy and sell (IDL order and flags). Sources (2026-10-26): pump_amm.json buy/sell accounts
 * (pool writable; base_token_program = the mint's real owner, Token or Token-2022); PUMP_SWAP_CREATOR_FEE_README.md
 * (coin_creator_vault_ata at 17 (mut) and coin_creator_vault_authority at 18 appended to buy and sell).
 */
export function pumpSwapSharedKeys(user: PublicKey, baseMint: PublicKey, pool: PoolRefs, baseTokenProgram: PublicKey) {
  const coinCreatorVaultAuthority = deriveCoinCreatorVaultAuthority(pool.coinCreator);
  return [
    { pubkey: pool.pool,                     isSigner: false, isWritable: true  },  //  0 pool
    { pubkey: user,                          isSigner: true,  isWritable: true  },  //  1 user
    { pubkey: PUMPSWAP_GLOBAL,               isSigner: false, isWritable: false },  //  2 global_config
    { pubkey: baseMint,                      isSigner: false, isWritable: false },  //  3 base_mint
    { pubkey: WSOL_MINT_PK,                  isSigner: false, isWritable: false },  //  4 quote_mint
    { pubkey: deriveAta(baseMint, user, baseTokenProgram), isSigner: false, isWritable: true },  //  5 user_base_token_account
    { pubkey: deriveAta(WSOL_MINT_PK, user, QUOTE_TOKEN_PROGRAM_PK), isSigner: false, isWritable: true },  //  6 user_quote_token_account
    { pubkey: pool.poolBaseAccount,          isSigner: false, isWritable: true  },  //  7 pool_base_token_account
    { pubkey: pool.poolQuoteAccount,         isSigner: false, isWritable: true  },  //  8 pool_quote_token_account
    { pubkey: PUMPSWAP_FEE_RECIPIENT,        isSigner: false, isWritable: false },  //  9 protocol_fee_recipient
    { pubkey: PUMPSWAP_FEE_RECIPIENT_ATA,    isSigner: false, isWritable: true  },  // 10 protocol_fee_recipient_token_account
    { pubkey: baseTokenProgram,              isSigner: false, isWritable: false },  // 11 base_token_program
    { pubkey: QUOTE_TOKEN_PROGRAM_PK,        isSigner: false, isWritable: false },  // 12 quote_token_program
    { pubkey: SystemProgram.programId,       isSigner: false, isWritable: false },  // 13 system_program
    { pubkey: ASSOC_TOKEN_PROGRAM_PK,        isSigner: false, isWritable: false },  // 14 associated_token_program
    { pubkey: PUMPSWAP_EVENT_AUTHORITY,      isSigner: false, isWritable: false },  // 15 event_authority
    { pubkey: PUMPSWAP_PROGRAM_ID,           isSigner: false, isWritable: false },  // 16 program
    { pubkey: deriveAta(WSOL_MINT_PK, coinCreatorVaultAuthority, QUOTE_TOKEN_PROGRAM_PK), isSigner: false, isWritable: true },  // 17 coin_creator_vault_ata
    { pubkey: coinCreatorVaultAuthority,     isSigner: false, isWritable: false },  // 18 coin_creator_vault_authority
  ];
}

/**
 * PumpSwap `buy`: 23 accounts (IDL). The data is the discriminator and the two u64 args; the trailing track_volume
 * OptionBool is omitted, and whether the program accepts that is UNVERIFIED (the reason the route is disabled).
 */
export function buildPumpSwapBuyInstruction(
  user: PublicKey, baseMint: PublicKey, pool: PoolRefs, baseTokenProgram: PublicKey,
  baseAmountOut: bigint, maxQuoteAmountIn: bigint,
): TransactionInstruction {
  const data = Buffer.concat([DISCRIMINATOR_BUY, u64LE(baseAmountOut), u64LE(maxQuoteAmountIn)]);
  return new TransactionInstruction({
    programId: PUMPSWAP_PROGRAM_ID,
    keys: [
      ...pumpSwapSharedKeys(user, baseMint, pool, baseTokenProgram),
      { pubkey: PUMPSWAP_GLOBAL_VOLUME_ACCUMULATOR,          isSigner: false, isWritable: false },  // 19 global_volume_accumulator
      { pubkey: derivePumpSwapUserVolumeAccumulator(user),   isSigner: false, isWritable: true  },  // 20 user_volume_accumulator
      { pubkey: PUMPSWAP_FEE_CONFIG,                         isSigner: false, isWritable: false },  // 21 fee_config
      { pubkey: PUMPSWAP_FEE_PROGRAM,                        isSigner: false, isWritable: false },  // 22 fee_program
    ],
    data,
  });
}

/** PumpSwap `sell`: 21 accounts (IDL; no volume accumulators on sell). Data: discriminator + two u64 args, as the IDL. */
export function buildPumpSwapSellInstruction(
  user: PublicKey, baseMint: PublicKey, pool: PoolRefs, baseTokenProgram: PublicKey,
  baseAmountIn: bigint, minQuoteAmountOut: bigint,
): TransactionInstruction {
  const data = Buffer.concat([DISCRIMINATOR_SELL, u64LE(baseAmountIn), u64LE(minQuoteAmountOut)]);
  return new TransactionInstruction({
    programId: PUMPSWAP_PROGRAM_ID,
    keys: [
      ...pumpSwapSharedKeys(user, baseMint, pool, baseTokenProgram),
      { pubkey: PUMPSWAP_FEE_CONFIG,                         isSigner: false, isWritable: false },  // 19 fee_config
      { pubkey: PUMPSWAP_FEE_PROGRAM,                        isSigner: false, isWritable: false },  // 20 fee_program
    ],
    data,
  });
}

// Idempotent ATA create — needed for fresh wSOL/base ATAs (under the mint's own token program)
export function buildCreateAtaIfNeededIx(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
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
    data: Buffer.from([1]),
  });
}
