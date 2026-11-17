/**
 * PUMP PROGRAM — the pump bonding-curve program's legacy trade family as pure data and math (FIX-PUMP, owner decision 2026-11-06:
 * rebuild direct pump.fun buying and selling without PumpPortal). No signing, no RPC, no network.
 *
 * Built (pumpfun-ix.ts) and pinned (tx-verify.ts verifyPumpDirectStatic), on program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P, for
 * classic Token and Token-2022 mints:
 *   buy_exact_sol_in  every SOL-amount buy: 18 accounts, 25 bytes = disc | spendable_sol_in u64 | min_tokens_out u64 | track_volume 0x01
 *                     (partial_fill absent: an oversized buy fails with 6021 and never fills partly);
 *   sell              16 accounts (17 for a cashback coin), 24 bytes = disc | amount u64 | min_sol_output u64.
 * Not built, and refused by the strict verifier: legacy `buy` (exact token amount), the v2 and the v3 families.
 *
 * Sources, and where they disagree the recorded mainnet transactions win (test-fixtures/execution/pump-chain/, pinned byte for byte by
 * pump-chain-layout.test.ts): top-level sell 2jca9E3k9xbz (exact header flags), buy_exact_sol_in 3AUNQ8x89cfp, 2UmCR7snPvqa, 2bAbMHx3AxuU,
 * 4YBaBsoaqmQd (slots 466206364-466206463), the non-mayhem legacy buy 5bdqztZDnkuY and sell 3vEJuMHF6xec, the satasb sell 3cBPhfAEwv;
 * pump-public-docs BREAKING_FEE_RECIPIENT.md (the two accounts added on 2026-04-28 come after bonding_curve_v2, the buyback recipient
 * writable) and pump SDK 4.1.0. The fee-recipient lists equal Global at slot 466207859 (offsets 41, 162, 483, 516, 741) and the fees equal
 * FeeConfig 8Wf5... (protocol 95 bps, creator 30 bps); both are admin-mutable, so a rotation makes every PF-direct simulation fail and
 * the router goes on to Jupiter (pumpfun-swap.ts opens its breaker on repeated layout errors).
 *
 * pumpfun-ix.ts (the builders) and tx-verify.ts (the verifier) both import this file. The verifier never uses the builders: it derives
 * every PDA and ATA itself, and the chain fixtures pin every constant here.
 */
import { createHash } from 'node:crypto';
import { isSolQuoted, parseBondingCurve } from './curve-parse';
import { parseMintExtensions, parseSplMint } from './wallet-reads';

// ── program ids and fixed accounts ─────────────────────────────────────────────────────────────────────────────────────────────
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_FEE_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

/** PDA(["global"], pump), bump 255. */
export const PUMP_GLOBAL = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
/** PDA(["__event_authority"], pump). */
export const PUMP_EVENT_AUTHORITY = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';
/** PDA(["global_volume_accumulator"], pump), bump 255; read-only in every recorded trade (the IDL agrees). */
export const PUMP_GLOBAL_VOLUME_ACCUMULATOR = 'Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y';
/** PDA(["fee_config", pump program id bytes], fee program), bump 253. */
export const PUMP_FEE_CONFIG = '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt';

/** Account 1 of a NORMAL coin (curve byte 81 = 0): Global.fee_recipient @41, then fee_recipients[7] @162. */
export const PUMP_FEE_RECIPIENTS_NORMAL: readonly string[] = [
  '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV', '7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ', '7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX',
  '9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz', 'AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY', 'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
  'FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz', 'G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP',
];
/** Account 1 of a mayhem coin (curve byte 81 = 1): Global.reserved_fee_recipient @483, then reserved_fee_recipients[7] @516. */
export const PUMP_FEE_RECIPIENTS_MAYHEM: readonly string[] = [
  'GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS', '4budycTjhs9fD6xw62VBducVTNgMgJJ5BgtKq7mAZwn6', '8SBKzEQU4nLSzcwF4a74F2iaUDQyTfjGndn6qUWBnrpR',
  '4UQeTP1T39KZ9Sfxzo3WR5skgsaP6NZa87BAkuazLEKH', '8sNeir4QsLsJdYpc9RZacohhK1Y5FLU3nC5LXgYB4aa6', 'Fh9HmeLNUMVCvejxCtCL2DbYaRyBFVJ5xrWkLnMH6fdk',
  '463MEnMeGyJekNZFQSTUABBEbLnvMTALbT6ZmsxAbAdq', '6AUH3WEHucYZyC61hqpqYUWVto5qA5hjHuNQ32GNnNxA',
];
/** The last account of every trade (mayhem coins included, their buyback share is 0): Global.buyback_fee_recipients[8] @741. */
export const PUMP_BUYBACK_FEE_RECIPIENTS: readonly string[] = [
  '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD', '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7', 'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL',
  '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR', '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6', 'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL',
  '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD', 'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW',
];

// ── fees ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** FeeConfig flat fees (and its single tier): protocol 95 bps, creator 30 bps, LP 0. Every recorded SOL-coin TradeEvent matches. */
export const PUMP_PROTOCOL_FEE_BPS = 95n;
export const PUMP_CREATOR_FEE_BPS_DEFAULT = 30n;
/** Global.max_configurable_creator_fee_bps. A SOL-quoted curve never uses its own creator_fee_bps (pump error 6091): see classifyPumpCurve. */
export const PUMP_CREATOR_FEE_BPS_MAX = 300n;

// ── instructions ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** sha256("global:buy_exact_sol_in")[0..8] and sha256("global:sell")[0..8] (a test recomputes both). */
export const PUMP_DISC_BUY_EXACT_SOL_IN: readonly number[] = [56, 252, 116, 8, 158, 223, 205, 95];
export const PUMP_DISC_SELL: readonly number[] = [51, 230, 133, 164, 1, 127, 131, 173];
export const PUMP_BUY_DATA_LEN = 25;
export const PUMP_SELL_DATA_LEN = 24;
/** track_volume = Some(true) is sent as the single byte 0x01 (all four recorded buy_exact_sol_in end in 01). */
export const PUMP_TRACK_VOLUME = 1;
export const PUMP_BUY_ACCOUNTS = 18;
export const PUMP_SELL_ACCOUNTS = 16;
export const PUMP_SELL_ACCOUNTS_CASHBACK = 17;
/** SetComputeUnitLimit of every PF-direct transaction (measured on chain: buy_exact_sol_in 72 480 CU, sell 57 911 to 58 543). */
export const PF_DIRECT_CU_LIMIT = 200_000;
/** The largest transaction packet. */
export const TX_PACKET_BYTES = 1_232;

// ── bonding-curve account (166 bytes) ──────────────────────────────────────────────────────────────────────────────────────────
export const PUMP_CURVE_LEN = 166;
export const PUMP_CURVE_DISCRIMINATOR: readonly number[] = [...createHash('sha256').update('account:BondingCurve').digest().subarray(0, 8)];
const CURVE_COMPLETE = 48;
const CURVE_CREATOR = 49;
const CURVE_MAYHEM = 81;
const CURVE_CASHBACK = 82;
const CURVE_CREATOR_FEE_BPS = 115;
const CURVE_HOLDER_REWARD = 124;
/** The mint of every recorded pump coin: decimals 6, no mint authority, no freeze authority. */
export const PUMP_MINT_DECIMALS = 6;
/** Token-2022 extensions a pump mint may carry: MetadataPointer (18) and TokenMetadata (19). All 7 recorded mints carry exactly these. */
export const PUMP_MINT_ALLOWED_EXTENSIONS: ReadonlySet<number> = new Set([18, 19]);

// ── refusals ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type PumpDirectRefusalCode =
  | 'no-curve' | 'curve-owner' | 'curve-layout' | 'curve-complete' | 'non-sol-quote' | 'no-creator' | 'curve-fee' | 'curve-reserves'
  | 'mint-program' | 'mint-unsupported' | 'oversized-buy' | 'curve-drained' | 'zero-quote' | 'insufficient-tokens' | 'cashback-no-uva'
  | 'bad-request' | 'read-failed' | 'verify';

/** Thrown BEFORE anything is signed: nothing was signed, journalled or sent, so the router goes on to the next route in the same call. */
export class PumpDirectRefusal extends Error {
  readonly code: PumpDirectRefusalCode;
  constructor(code: PumpDirectRefusalCode, detail: string) {
    super(`PF-direct refused (${code}): ${detail}`.slice(0, 200));
    this.name = 'PumpDirectRefusal';
    this.code = code;
  }
}

export type Classified<T> = { ok: true; value: T } | { ok: false; code: PumpDirectRefusalCode; detail: string };
const refuse = <T>(code: PumpDirectRefusalCode, detail: string): Classified<T> => ({ ok: false, code, detail });

/** A raw account as read: its owner program and its data. */
export interface RawAccount { owner: string; data: Uint8Array }

export interface PumpCurveInfo {
  creator: string;
  mayhem: boolean;
  cashback: boolean;
  holderReward: boolean;
  quoteMint: string;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  /** The creator fee the program charges: always the FeeConfig 30 bps on a SOL-quoted curve. */
  creatorFeeBps: bigint;
}

/**
 * The variant table of a bonding-curve account (the same table for the builder's read and the verifier's re-read):
 * missing 'no-curve'; owner not pump 'curve-owner'; not 166 bytes or another discriminator 'curve-layout' (the 151-byte curves are old and
 * complete, extend_account is not built); complete 'curve-complete'; a quote mint that is not SOL (curve-parse isSolQuoted: the zero key,
 * WSOL, the Token-2022 native mint) 'non-sol-quote' (FIX-BUY2 item 6, as corrected by FIX-QUOTE); a zero creator 'no-creator'; byte 81 or
 * 82 other than 0/1 'curve-layout'; a non-zero creator_fee_bps (u64 @115) 'curve-fee' (pump ignores it on SOL curves, error 6091, so it
 * is never used as the rate: the FeeConfig 30 bps always is); a zero virtual or real token reserve 'curve-reserves'.
 */
export function classifyPumpCurve(a: RawAccount | null | undefined): Classified<PumpCurveInfo> {
  if (!a) return refuse('no-curve', 'no bonding-curve account');
  if (a.owner !== PUMP_PROGRAM) return refuse('curve-owner', 'the bonding-curve account is not owned by the pump program');
  const d = Buffer.from(a.data.buffer, a.data.byteOffset, a.data.byteLength);
  if (d.length !== PUMP_CURVE_LEN) return refuse('curve-layout', `bonding-curve account of ${d.length} bytes, expected ${PUMP_CURVE_LEN}`);
  if (!PUMP_CURVE_DISCRIMINATOR.every((b, i) => d[i] === b)) return refuse('curve-layout', 'bonding-curve discriminator mismatch');
  const s = parseBondingCurve(d);
  if (s === null) return refuse('curve-layout', 'bonding-curve account unreadable');
  if (d[CURVE_COMPLETE] === 1) return refuse('curve-complete', 'the bonding curve is complete (migrated)');
  if (d[CURVE_COMPLETE] !== 0) return refuse('curve-layout', 'bonding-curve complete flag is not 0 or 1');
  const quoteMint = s.quoteMint ?? SYSTEM_PROGRAM;
  if (!isSolQuoted(quoteMint)) return refuse('non-sol-quote', 'the curve is quoted in another mint than SOL');
  if (d.subarray(CURVE_CREATOR, CURVE_CREATOR + 32).every((b) => b === 0)) return refuse('no-creator', 'the curve has no creator');
  if (d[CURVE_MAYHEM] > 1 || d[CURVE_CASHBACK] > 1 || d[CURVE_HOLDER_REWARD] > 1) return refuse('curve-layout', 'a curve flag is not 0 or 1');
  if (d.readBigUInt64LE(CURVE_CREATOR_FEE_BPS) !== 0n) return refuse('curve-fee', 'a SOL curve carries a creator_fee_bps (pump ignores it; refused)');
  if (s.virtualTokenReserves <= 0n || s.virtualSolReserves <= 0n || s.realTokenReserves <= 0n) return refuse('curve-reserves', 'a curve reserve is zero');
  return {
    ok: true,
    value: {
      creator: s.creator, mayhem: d[CURVE_MAYHEM] === 1, cashback: d[CURVE_CASHBACK] === 1, holderReward: d[CURVE_HOLDER_REWARD] === 1, quoteMint,
      virtualTokenReserves: s.virtualTokenReserves, virtualSolReserves: s.virtualSolReserves, realTokenReserves: s.realTokenReserves,
      realSolReserves: s.realSolReserves, creatorFeeBps: PUMP_CREATOR_FEE_BPS_DEFAULT,
    },
  };
}

/**
 * The mint of a pump coin: owned by Token (classic coins) or Token-2022 (create_v2, every fresh coin), else 'mint-program'; decimals 6,
 * initialized, no mint and no freeze authority, and on Token-2022 only the MetadataPointer / TokenMetadata extensions, else
 * 'mint-unsupported' (TransferHook, NonTransferable, DefaultAccountState, TransferFeeConfig, PermanentDelegate, an unreadable list...).
 * The value is the token program: it changes buy account 8, sell account 9, both ATA seeds and the CreateIdempotent program account.
 */
export function classifyPumpMint(a: RawAccount | null | undefined): Classified<string> {
  if (!a) return refuse('mint-program', 'no mint account');
  if (a.owner !== TOKEN_PROGRAM && a.owner !== TOKEN_2022_PROGRAM) return refuse('mint-program', 'the mint is not owned by Token or Token-2022');
  const m = parseSplMint(a.data);
  if (m === null || !m.isInitialized || m.decimals !== PUMP_MINT_DECIMALS || m.mintAuthority !== null || m.freezeAuthority !== null) {
    return refuse('mint-unsupported', 'the mint is not a plain 6-decimal mint without authorities');
  }
  if (a.owner === TOKEN_2022_PROGRAM) {
    const ext = parseMintExtensions(a.data);
    if (ext === null) return refuse('mint-unsupported', 'the Token-2022 extensions of the mint could not be read');
    const extra = ext.types.find((t) => !PUMP_MINT_ALLOWED_EXTENSIONS.has(t));
    if (extra !== undefined) return refuse('mint-unsupported', `the mint carries Token-2022 extension ${extra}`);
  } else if (a.data.length !== 82) {
    return refuse('mint-unsupported', 'a classic Token mint of an unexpected size');
  }
  return { ok: true, value: a.owner };
}

// ── quote math (bigint; ceil(a / b) = (a + b - 1) / b) ─────────────────────────────────────────────────────────────────────────
export const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export interface PumpBuyQuote {
  /** SOL that enters the curve. */
  net: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  tokensOut: bigint;
}

/**
 * buy_exact_sol_in with `spend` lamports (fees included): net = spend x 10000 / (10000 + 95 + creator bps), the fees are ceil(net x bps /
 * 10000) and net is lowered when net + fees would pass spend; tokensOut = (net - 1) x vTok / (vSol + net - 1). Reproduces the four recorded
 * buy_exact_sol_in TradeEvents to the lamport and the atom. null on a zero or negative input.
 */
export function pumpBuyQuote(vSol: bigint, vTok: bigint, spend: bigint, creatorBps: bigint = PUMP_CREATOR_FEE_BPS_DEFAULT): PumpBuyQuote | null {
  if (spend <= 0n || vSol <= 0n || vTok <= 0n || creatorBps < 0n) return null;
  let net = (spend * 10_000n) / (10_000n + PUMP_PROTOCOL_FEE_BPS + creatorBps);
  const feesOf = (n: bigint): [bigint, bigint] => [ceilDiv(n * PUMP_PROTOCOL_FEE_BPS, 10_000n), ceilDiv(n * creatorBps, 10_000n)];
  let [protocolFee, creatorFee] = feesOf(net);
  if (net + protocolFee + creatorFee > spend) {
    net -= net + protocolFee + creatorFee - spend;
    [protocolFee, creatorFee] = feesOf(net);
  }
  if (net <= 1n) return { net, protocolFee, creatorFee, tokensOut: 0n };
  const tokensOut = ((net - 1n) * vTok) / (vSol + net - 1n);
  return { net, protocolFee, creatorFee, tokensOut };
}

export interface PumpSellQuote {
  /** SOL out of the curve before the fees. */
  gross: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  /** What the seller receives (may be zero or negative on a dust amount). */
  net: bigint;
}

/** sell of `amount` atoms: gross = amount x vSol / (vTok + amount), net = gross - ceil(gross x 95 / 10000) - ceil(gross x creator bps / 10000). */
export function pumpSellQuote(vSol: bigint, vTok: bigint, amount: bigint, creatorBps: bigint = PUMP_CREATOR_FEE_BPS_DEFAULT): PumpSellQuote | null {
  if (amount <= 0n || vSol <= 0n || vTok <= 0n || creatorBps < 0n) return null;
  const gross = (amount * vSol) / (vTok + amount);
  const protocolFee = ceilDiv(gross * PUMP_PROTOCOL_FEE_BPS, 10_000n);
  const creatorFee = ceilDiv(gross * creatorBps, 10_000n);
  return { gross, protocolFee, creatorFee, net: gross - protocolFee - creatorFee };
}

/** floor(amount x (10000 - slippage) / 10000). */
export function minOutAfterSlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** The slippage a PF-direct trade may sign: an integer from 1 to 5000 bps. */
export function isPumpSlippageBps(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5_000;
}

export interface PumpTradeBounds {
  /** buy: tokens out of the quote; sell: the net SOL of the quote. */
  quoted: bigint;
  /** The min_tokens_out / min_sol_output the instruction carries. */
  minOut: bigint;
}

/**
 * The quote and the signed minimum of a trade on a classified curve, or the refusal: a buy whose quote is zero ('zero-quote') or passes the
 * real token reserve ('oversized-buy', partial_fill is not used); a sell whose gross passes the real SOL reserve ('curve-drained') or whose
 * net is not positive ('zero-quote'); a minimum that rounds to 0 ('zero-quote').
 */
export function pumpTradeBounds(curve: PumpCurveInfo, side: 'buy' | 'sell', amountIn: bigint, slippageBps: number): Classified<PumpTradeBounds> {
  if (amountIn <= 0n) return refuse('bad-request', 'the amount must be positive');
  if (!isPumpSlippageBps(slippageBps)) return refuse('bad-request', 'slippage must be an integer from 1 to 5000 bps');
  if (side === 'buy') {
    const q = pumpBuyQuote(curve.virtualSolReserves, curve.virtualTokenReserves, amountIn, curve.creatorFeeBps);
    if (q === null || q.tokensOut <= 0n) return refuse('zero-quote', 'the curve quote is zero tokens');
    if (q.tokensOut > curve.realTokenReserves) return refuse('oversized-buy', 'the buy is larger than the tokens left on the curve');
    const minOut = minOutAfterSlippage(q.tokensOut, slippageBps);
    if (minOut < 1n) return refuse('zero-quote', 'the minimum tokens out rounds to zero');
    return { ok: true, value: { quoted: q.tokensOut, minOut } };
  }
  const q = pumpSellQuote(curve.virtualSolReserves, curve.virtualTokenReserves, amountIn, curve.creatorFeeBps);
  if (q === null || q.net <= 0n) return refuse('zero-quote', 'the curve quote is zero SOL');
  if (q.gross > curve.realSolReserves) return refuse('curve-drained', 'the sell needs more SOL than the curve holds');
  const minOut = minOutAfterSlippage(q.net, slippageBps);
  if (minOut < 1n) return refuse('zero-quote', 'the minimum SOL out rounds to zero');
  return { ok: true, value: { quoted: q.net, minOut } };
}
