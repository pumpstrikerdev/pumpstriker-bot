// FROZEN CONTRACT (R7-W3, round 7a, amendment A-99; C02 section 9, WALLET-DASHBOARD-DESIGN sections 6.2, 6.3, 6.8 and "Rev 3" R3-2). Changes only by a numbered plan amendment.
// Amended once, additively, by R8-RDQ1 (amendment A-117, owner answer Q-RD3): WalletTradeQuoteBody gains `freeMint?: true`, the free-mint buy of a pasted mint. Nothing else changed.
// Canonical source: R\shared\contract\wallet-validate.ts; byte-identical copies live in Engine\src\shared\contract\ and TG Bot\src\shared\contract\ and are written only by
// R\scripts\sync-shared.ps1. The dashboard never imports this file (A-16).
//
// Pure, hand-written, dependency-free STRICT validators for (1) the bodies the Engine's wallet API accepts from the page (POST /api/wallet/v1/...), (2) the request
// bodies of the six bot link routes (wallet-link.ts) and (3) the answers the Engine reads back from the bot.
//
// Rules, for every validator:
//  - the input must be a plain JSON object; an UNKNOWN KEY IS REFUSED (code 'unknown-key', and the key's name is never echoed); that includes a body `owner`: the owner
//    of an Engine API call is always the wallet session's, so `owner` is simply not a key of any Engine API body;
//  - an amount is a canonical integer STRING, greater than 0 (or at least 0 in an answer) and at most 18446744073709551615 (u64): a number, a float, an exponent,
//    a sign, a leading zero, whitespace or any other form is refused; parseSolDecimal turns a decimal SOL text (at most 9 decimals) into lamports by string arithmetic;
//  - slippage is an integer in [1, WALLET_SLIPPAGE_HARD_MAX_BPS]; maxImpactPct is in (0, WALLET_IMPACT_HARD_MAX_PCT] with at most 2 decimals;
//  - an address is base58 and decodes to exactly 32 bytes (a signature to 64), by a hand-written decoder;
//  - a refusal is {ok:false, status:400, code:'bad-request'|'unknown-key', reason} and the reason NEVER echoes input (it names the field and the rule);
//  - the result is a FRESH object holding only the known keys; free text from the bot is redacted (redactSecrets) and capped (200 characters).
// Answers are checked against what the Engine asked for and against the design's safety rules (the bound kind matches the route, the amounts add up, the
// transaction is not oversized, the disclosed priority fee equals the one the compute-budget instructions commit to), so the dialog never states less than the truth.
import type { Ms } from '../common/ids';
import type { ExactAmount, WalletFeeLevel, WalletRoute, WalletSide } from '../dashboard/contract';
import { redactSecrets } from '../redact';
import { WALLET_REFUSAL_CODES } from './wallet-link';
import type {
  UintString, WalletBalancesLink, WalletBalancesOk, WalletBalancesRequest, WalletCloseAccount, WalletCloseExcluded, WalletCloseFillLink, WalletCloseFillOk,
  WalletCloseFillRequest, WalletCloseQuoteLink, WalletCloseQuoteOk, WalletCloseQuoteRequest, WalletFillLink, WalletFillOk, WalletFillRequest, WalletFindOk,
  WalletFindRequest, WalletLinkBound, WalletLinkInnerFee, WalletLinkPriorityFee, WalletLinkRefusal, WalletLinkTransfer, WalletQuoteLink, WalletQuoteOk,
  WalletQuoteRequest, WalletRefusalCode, WalletTokenBalance,
} from './wallet-link';

/** Hard bound of a per-trade slippage, in basis points (owner answer Q2 b). Changing it is an amendment. */
export const WALLET_SLIPPAGE_HARD_MAX_BPS = 5000;
/** Hard bound of a per-trade price-impact limit, in percent (owner answer Q2 c). Changing it is an amendment. */
export const WALLET_IMPACT_HARD_MAX_PCT = 50;
/** The largest serialized transaction a wallet quote may carry: 1232 (the packet limit) minus 100 bytes of headroom for instructions a wallet adds. */
export const WALLET_TX_BYTES_HARD_MAX = 1132;

export type WalletValidation<T> = { ok: true; value: T } | { ok: false; status: 400; code: 'bad-request' | 'unknown-key'; reason: string };

// ---------------------------------------------------------------------------------------------------------------------------------
// bodies of the Engine wallet API (the page -> /api/wallet/v1)
// ---------------------------------------------------------------------------------------------------------------------------------

export interface WalletSessionChallengeBody { address: string }
export interface WalletSessionVerifyBody { address: string; signedMessageB64: string; signatureB64: string; via: 'signIn' | 'signMessage' }
/** A buy is EITHER the signal form OR the free-mint form (A-117):
 *  - signal buy: decisionId and amountLamports (the mint comes from the decision, so this body has no mint and no freeMint).
 *  - free-mint buy: `{ side: 'buy', mint, freeMint: true, amountLamports, slippageBps, maxImpactPct, feeLevel }` for a pasted mint that is not a signal; freeMint is the JSON
 *    literal true, mint is a base58 address of 32 bytes that is not the native (wrapped SOL) mint, and there is no decisionId (so no security flags exist for it).
 *  - sell: mint, and exactly one of tokensRaw and pctBps; decisionId is optional there (it only ties the trade to a signal); freeMint is refused. */
export interface WalletTradeQuoteBody {
  decisionId?: string; side: WalletSide; mint?: string;
  /** Present only on the free-mint buy form, and then always the literal true. */
  freeMint?: true;
  amountLamports?: UintString; tokensRaw?: UintString; pctBps?: number;
  slippageBps: number; maxImpactPct: number; feeLevel: WalletFeeLevel;
}
/** POST /trade/submitted and /close/submitted. signatureB64: the 64-byte signature as standard base64. */
export interface WalletSubmittedBody { quoteId: string; signatureB64: string }
export interface WalletTradeFindBody { quoteId: string }
export interface WalletTradeRecheckBody { tradeId: string }
export interface WalletCloseQuoteBody { kind: 'empty' | 'unwrap'; accounts?: string[] }
/** POST /ucs/analyze, normalized from the five wire forms: {} | {confirmNew:true} | {page:'next', requestId} | {retry:'same_key'|'new_key', requestId} | {abandon:true, requestId}. */
export type WalletUcsAnalyzeBody =
  | { kind: 'first'; confirmNew: boolean }
  | { kind: 'next'; requestId: string }
  | { kind: 'retry'; retry: 'same_key' | 'new_key'; requestId: string }
  | { kind: 'abandon'; requestId: string };

// ---------------------------------------------------------------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------------------------------------------------------------

class Rej extends Error {
  constructor(readonly code: 'bad-request' | 'unknown-key', reason: string) { super(reason); }
}
function bad(reason: string): never { throw new Rej('bad-request', reason); }
function run<T>(f: () => T): WalletValidation<T> {
  try {
    return { ok: true, value: f() };
  } catch (e) {
    if (e instanceof Rej) return { ok: false, status: 400, code: e.code, reason: e.message };
    return { ok: false, status: 400, code: 'bad-request', reason: 'body could not be validated' };   // never echo an unexpected error message
  }
}

type Obj = Record<string, unknown>;
/** Own property or undefined (an inherited member such as "constructor" is never a field). */
function rd(o: Obj, k: string): unknown { return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; }
function plain(x: unknown, what: string): Obj {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return bad(`${what} must be a JSON object`);
  const proto: unknown = Object.getPrototypeOf(x);
  if (proto !== Object.prototype && proto !== null) return bad(`${what} must be a plain JSON object`);
  return x as Obj;
}
/** A plain object whose keys are ALL in `allowed`: an unknown key (an own "__proto__" included) is refused without echoing it. */
function rec(x: unknown, what: string, allowed: readonly string[]): Obj {
  const o = plain(x, what);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Rej('unknown-key', `${what} has an unknown key`);
  return o;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// numbers and amounts
// ---------------------------------------------------------------------------------------------------------------------------------

const U64_MAX = '18446744073709551615';
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const INT_RE = /^(0|-?[1-9][0-9]*)$/;
const lte64 = (digits: string): boolean => digits.length < U64_MAX.length || (digits.length === U64_MAX.length && digits <= U64_MAX);
/** A canonical unsigned integer string, 0 .. u64 max. */
export function isUintString(s: unknown): s is string { return typeof s === 'string' && UINT_RE.test(s) && lte64(s); }
/** A canonical SIGNED integer string ("-0" is not canonical), magnitude at most u64 max. */
export function isIntString(s: unknown): s is string { return typeof s === 'string' && INT_RE.test(s) && lte64(s.startsWith('-') ? s.slice(1) : s); }

const SOL_DECIMAL_RE = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,9}))?$/;
/** A decimal SOL text ("0.05", "12", at most 9 decimals, no sign, no exponent, no spaces) to a lamports string by string arithmetic. null when the text is
 *  not canonical, has more than 9 decimals, is zero, or exceeds u64 lamports. */
export function parseSolDecimal(text: unknown): UintString | null {
  if (typeof text !== 'string') return null;
  const m = SOL_DECIMAL_RE.exec(text);
  if (m === null) return null;
  const lamports = (m[1] + (m[2] ?? '').padEnd(9, '0')).replace(/^0+(?=[0-9])/, '');
  return lamports === '0' || !lte64(lamports) ? null : lamports;
}

function positiveAmount(v: unknown, name: string): UintString {
  if (typeof v !== 'string' || !isUintString(v) || v === '0') {
    return bad(`${name} must be a canonical integer string greater than 0 and at most ${U64_MAX} (no float, exponent, sign or leading zero)`);
  }
  return v;
}
function uintAt(o: Obj, k: string): UintString {
  const v = rd(o, k);
  if (!isUintString(v)) return bad(`${k} must be a canonical integer string from 0 to ${U64_MAX}`);
  return v;
}
function intStringAt(o: Obj, k: string): string {
  const v = rd(o, k);
  if (!isIntString(v)) return bad(`${k} must be a canonical signed integer string (magnitude at most ${U64_MAX}, no "-0")`);
  return v;
}
function intAt(o: Obj, k: string, min: number, max: number): number {
  const v = rd(o, k);
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) return bad(`${k} must be an integer from ${min} to ${max}`);
  return v;
}
function msAt(o: Obj, k: string): Ms { return intAt(o, k, 0, Number.MAX_SAFE_INTEGER); }
function boolAt(o: Obj, k: string): boolean {
  const v = rd(o, k);
  if (typeof v !== 'boolean') return bad(`${k} must be true or false`);
  return v;
}
function enumAt<T extends string>(o: Obj, k: string, allowed: readonly T[]): T {
  const v = rd(o, k);
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) return bad(`${k} must be one of ${allowed.join(', ')}`);
  return v as T;
}
function slippageAt(o: Obj): number { return intAt(o, 'slippageBps', 1, WALLET_SLIPPAGE_HARD_MAX_BPS); }
const IMPACT_TEXT_RE = /^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/;
function impactAt(o: Obj): number {
  const v = rd(o, 'maxImpactPct');
  // String(v) is the shortest round-trip text: an exponent form (1e-7) or a third decimal fails the pattern, so "at most 2 decimals" needs no float arithmetic
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > WALLET_IMPACT_HARD_MAX_PCT || !IMPACT_TEXT_RE.test(String(v))) {
    return bad(`maxImpactPct must be a number above 0 and at most ${WALLET_IMPACT_HARD_MAX_PCT} with at most 2 decimals`);
  }
  return v;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// base58 and base64
// ---------------------------------------------------------------------------------------------------------------------------------

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Base58 to bytes (the Bitcoin/Solana alphabet), by schoolbook base conversion. null for an empty string, a character outside the alphabet or more than 128 characters. */
export function decodeBase58(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > 128) return null;
  let zeros = 0;
  while (zeros < s.length && s.charAt(zeros) === '1') zeros++;
  const digits: number[] = [];   // little-endian base 256
  for (let i = 0; i < s.length; i++) {
    let carry = B58_ALPHABET.indexOf(s.charAt(i));
    if (carry < 0) return null;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 58;
      digits[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      digits.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + digits.length);
  for (let i = 0; i < digits.length; i++) out[zeros + i] = digits[digits.length - 1 - i];
  return out;
}
/** A base58 address that decodes to exactly 32 bytes. */
export function isBase58Pubkey(s: unknown): s is string { const b = decodeBase58(s); return b !== null && b.length === 32; }
/** A base58 transaction signature that decodes to exactly 64 bytes. */
export function isBase58Signature(s: unknown): s is string { const b = decodeBase58(s); return b !== null && b.length === 64; }

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** The decoded byte length of a canonical standard base64 string (padded, trailing bits zero), else null. */
export function base64DecodedLength(s: unknown, maxChars: number): number | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > maxChars || !B64_RE.test(s)) return null;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  if (pad > 0) {
    const last = B64_ALPHABET.indexOf(s.charAt(s.length - pad - 1));
    if (last % (pad === 2 ? 16 : 4) !== 0) return null;   // non-zero trailing bits: not the canonical encoding
  }
  return (s.length / 4) * 3 - pad;
}

function pubkeyAt(o: Obj, k: string): string {
  const v = rd(o, k);
  if (typeof v !== 'string' || !isBase58Pubkey(v)) return bad(`${k} must be a base58 address that decodes to 32 bytes`);
  return v;
}
function signatureAt(o: Obj, k: string): string {
  const v = rd(o, k);
  if (typeof v !== 'string' || !isBase58Signature(v)) return bad(`${k} must be a base58 signature that decodes to 64 bytes`);
  return v;
}
function signatureB64At(o: Obj, k: string): string {
  const v = rd(o, k);
  if (base64DecodedLength(v, 88) !== 64) return bad(`${k} must be a 64-byte signature as canonical standard base64`);
  return v as string;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// ids and text
// ---------------------------------------------------------------------------------------------------------------------------------

const QUOTE_ID_RE = /^[A-Za-z0-9_-]{22}$/;                // 128 random bits, base64url
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;                  // decisionId, tradeId, requestId, quoteRef
const KEBAB_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
function quoteIdAt(o: Obj, k: string): string {
  const v = rd(o, k);
  if (typeof v !== 'string' || !QUOTE_ID_RE.test(v)) return bad(`${k} must be a 22-character base64url quote id`);
  return v;
}
function idAt(o: Obj, k: string): string {
  const v = rd(o, k);
  if (typeof v !== 'string' || !ID_RE.test(v)) return bad(`${k} must be an id of 1-64 characters from A-Z a-z 0-9 _ . : -`);
  return v;
}
function kebabAt(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length > 40 || !KEBAB_RE.test(v)) return bad(`${name} must be a kebab-case code of at most 40 characters`);
  return v;
}
/** C0 and C1 control characters, DEL and the Unicode bidi controls, built from code points so that this source holds no invisible character. */
const UNSAFE_CHARS = new RegExp('[' + [[0, 31], [127, 159], [0x61c, 0x61c], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069]]
  .map(([a, b]) => String.fromCharCode(a) + (b > a ? '-' + String.fromCharCode(b) : '')).join('') + ']', 'g');
const WS_RUN = /\s+/g;
/** Free text from the bot: redaction first, control and bidi characters out, whitespace collapsed, capped at `max` code points. */
function plainText(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string') return bad(`${name} must be a string`);
  const t = redactSecrets(v).replace(UNSAFE_CHARS, ' ').replace(WS_RUN, ' ').trim();
  const points = Array.from(t);
  return points.length <= max ? t : points.slice(0, max).join('').trimEnd();
}
function arrAt(o: Obj, k: string, max: number): unknown[] {
  const v = rd(o, k);
  if (!Array.isArray(v) || v.length > max) return bad(`${k} must be a list of at most ${max} entries`);
  return v;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Engine wallet API bodies
// ---------------------------------------------------------------------------------------------------------------------------------

/** POST /session/end and POST /wallet/refresh: the body is exactly {}. */
export function validateWalletEmptyBody(body: unknown): WalletValidation<Record<string, never>> {
  return run(() => { rec(body, 'body', []); return {}; });
}
export function validateWalletSessionChallengeBody(body: unknown): WalletValidation<WalletSessionChallengeBody> {
  return run(() => {
    const o = rec(body, 'body', ['address']);
    return { address: pubkeyAt(o, 'address') };
  });
}
export function validateWalletSessionVerifyBody(body: unknown): WalletValidation<WalletSessionVerifyBody> {
  return run(() => {
    const o = rec(body, 'body', ['address', 'signedMessageB64', 'signatureB64', 'via']);
    const address = pubkeyAt(o, 'address');
    const message = rd(o, 'signedMessageB64');
    if (base64DecodedLength(message, 4096) === null) bad('signedMessageB64 must be canonical standard base64 of at most 4096 characters');
    return { address, signedMessageB64: message as string, signatureB64: signatureB64At(o, 'signatureB64'), via: enumAt(o, 'via', ['signIn', 'signMessage'] as const) };
  });
}

/** The amount fields of a trade: a buy has amountLamports; a sell has exactly one of tokensRaw and pctBps (1-10000). */
function tradeAmounts(o: Obj, side: WalletSide): { amountLamports?: UintString; tokensRaw?: UintString; pctBps?: number } {
  const a = rd(o, 'amountLamports');
  const t = rd(o, 'tokensRaw');
  const p = rd(o, 'pctBps');
  if (side === 'buy') {
    if (t !== undefined || p !== undefined) bad('a buy takes amountLamports only');
    return { amountLamports: positiveAmount(a, 'amountLamports') };
  }
  if (a !== undefined) bad('a sell takes tokensRaw or pctBps, not amountLamports');
  if ((t === undefined) === (p === undefined)) bad('a sell takes exactly one of tokensRaw and pctBps');
  return t !== undefined ? { tokensRaw: positiveAmount(t, 'tokensRaw') } : { pctBps: intAt(o, 'pctBps', 1, 10_000) };
}

/** The native (wrapped SOL) mint, public. A free-mint buy of it is refused (A-117). Module-private: this amendment adds no export. */
const NATIVE_MINT = 'So11111111111111111111111111111111111111112';

export function validateWalletTradeQuoteBody(body: unknown): WalletValidation<WalletTradeQuoteBody> {
  return run(() => {
    const o = rec(body, 'body', ['decisionId', 'side', 'mint', 'freeMint', 'amountLamports', 'tokensRaw', 'pctBps', 'slippageBps', 'maxImpactPct', 'feeLevel']);
    const side = enumAt(o, 'side', ['buy', 'sell'] as const);
    // A-117: freeMint is the free-mint buy marker. Only the JSON literal true counts; any other value (false, null, a string, a number) is refused, and so is the key on a sell.
    const free = rd(o, 'freeMint');
    if (free !== undefined && free !== true) bad('freeMint must be the JSON literal true');
    if (free !== undefined && side !== 'buy') bad('freeMint is accepted on a buy only');
    const out: WalletTradeQuoteBody = { side, ...tradeAmounts(o, side), slippageBps: slippageAt(o), maxImpactPct: impactAt(o), feeLevel: enumAt(o, 'feeLevel', ['normal', 'fast'] as const) };
    if (side === 'buy') {
      if (free === true) {
        // the free-mint form: the mint is named by the page, there is no decision to name
        if (rd(o, 'decisionId') !== undefined) bad('a free-mint buy takes no decisionId: decisionId is not accepted');
        const mint = pubkeyAt(o, 'mint');
        if (mint === NATIVE_MINT) bad('mint cannot be the native SOL mint (wrapped SOL)');
        out.mint = mint;
        out.freeMint = true;
      } else {
        if (rd(o, 'mint') !== undefined) bad('a buy takes its mint from the decision: mint is not accepted');
        out.decisionId = idAt(o, 'decisionId');
      }
    } else {
      out.mint = pubkeyAt(o, 'mint');
      if (rd(o, 'decisionId') !== undefined) out.decisionId = idAt(o, 'decisionId');
    }
    return out;
  });
}
export function validateWalletSubmittedBody(body: unknown): WalletValidation<WalletSubmittedBody> {
  return run(() => {
    const o = rec(body, 'body', ['quoteId', 'signatureB64']);
    return { quoteId: quoteIdAt(o, 'quoteId'), signatureB64: signatureB64At(o, 'signatureB64') };
  });
}
export function validateWalletTradeFindBody(body: unknown): WalletValidation<WalletTradeFindBody> {
  return run(() => ({ quoteId: quoteIdAt(rec(body, 'body', ['quoteId']), 'quoteId') }));
}
export function validateWalletTradeRecheckBody(body: unknown): WalletValidation<WalletTradeRecheckBody> {
  return run(() => ({ tradeId: idAt(rec(body, 'body', ['tradeId']), 'tradeId') }));
}

const CLOSE_BATCH_MAX = 10;
function pubkeyList(o: Obj, k: string, max: number): string[] {
  const out: string[] = [];
  for (const v of arrAt(o, k, max)) {
    if (typeof v !== 'string' || !isBase58Pubkey(v)) return bad(`${k} must hold base58 addresses that decode to 32 bytes`);
    if (out.includes(v)) return bad(`${k} must not repeat an address`);
    out.push(v);
  }
  return out;
}
export function validateWalletCloseQuoteBody(body: unknown): WalletValidation<WalletCloseQuoteBody> {
  return run(() => {
    const o = rec(body, 'body', ['kind', 'accounts']);
    const out: WalletCloseQuoteBody = { kind: enumAt(o, 'kind', ['empty', 'unwrap'] as const) };
    if (rd(o, 'accounts') !== undefined) {
      const accounts = pubkeyList(o, 'accounts', CLOSE_BATCH_MAX);
      if (accounts.length === 0) bad('accounts must not be empty when present');
      out.accounts = accounts;
    }
    return out;
  });
}

export function validateWalletUcsAnalyzeBody(body: unknown): WalletValidation<WalletUcsAnalyzeBody> {
  return run(() => {
    const o = rec(body, 'body', ['confirmNew', 'page', 'retry', 'abandon', 'requestId']);
    const keys = Object.keys(o).sort().join(',');
    if (keys === '') return { kind: 'first', confirmNew: false };
    if (keys === 'confirmNew') {
      if (rd(o, 'confirmNew') !== true) bad('confirmNew must be true when present');
      return { kind: 'first', confirmNew: true };
    }
    if (keys === 'page,requestId') {
      if (rd(o, 'page') !== 'next') bad('page must be "next"');
      return { kind: 'next', requestId: idAt(o, 'requestId') };
    }
    if (keys === 'requestId,retry') return { kind: 'retry', retry: enumAt(o, 'retry', ['same_key', 'new_key'] as const), requestId: idAt(o, 'requestId') };
    if (keys === 'abandon,requestId') {
      if (rd(o, 'abandon') !== true) bad('abandon must be true when present');
      return { kind: 'abandon', requestId: idAt(o, 'requestId') };
    }
    return bad('the body is not one of the five analyze forms');
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// bot link request bodies (the Engine -> POST /v1/wallet/*)
// ---------------------------------------------------------------------------------------------------------------------------------

export function validateWalletQuoteRequest(body: unknown): WalletValidation<WalletQuoteRequest> {
  return run(() => {
    const o = rec(body, 'quote request', ['owner', 'side', 'mint', 'amountLamports', 'tokensRaw', 'pctBps', 'slippageBps', 'maxImpactPct', 'maxSpendLamports', 'feeLevel', 'maxTxBytes']);
    const side = enumAt(o, 'side', ['buy', 'sell'] as const);
    const cap = rd(o, 'maxSpendLamports');
    if (cap !== null && cap !== undefined) positiveAmount(cap, 'maxSpendLamports');
    if (cap === undefined) bad('maxSpendLamports must be present: a canonical integer string, or null for no cap');
    return {
      owner: pubkeyAt(o, 'owner'), side, mint: pubkeyAt(o, 'mint'), ...tradeAmounts(o, side),
      slippageBps: slippageAt(o), maxImpactPct: impactAt(o), maxSpendLamports: cap as UintString | null,
      feeLevel: enumAt(o, 'feeLevel', ['normal', 'fast'] as const), maxTxBytes: intAt(o, 'maxTxBytes', 1, WALLET_TX_BYTES_HARD_MAX),
    };
  });
}
export function validateWalletFillRequest(body: unknown): WalletValidation<WalletFillRequest> {
  return run(() => {
    const o = rec(body, 'fill request', ['owner', 'signature', 'side', 'mint', 'quoteRef', 'submittedAt', 'final']);
    return {
      owner: pubkeyAt(o, 'owner'), signature: signatureAt(o, 'signature'), side: enumAt(o, 'side', ['buy', 'sell'] as const), mint: pubkeyAt(o, 'mint'),
      quoteRef: idAt(o, 'quoteRef'), submittedAt: msAt(o, 'submittedAt'), final: boolAt(o, 'final'),
    };
  });
}
export function validateWalletFindRequest(body: unknown): WalletValidation<WalletFindRequest> {
  return run(() => {
    const o = rec(body, 'find request', ['owner', 'mint', 'side', 'sinceSlot']);
    return { owner: pubkeyAt(o, 'owner'), mint: pubkeyAt(o, 'mint'), side: enumAt(o, 'side', ['buy', 'sell'] as const), sinceSlot: intAt(o, 'sinceSlot', 0, Number.MAX_SAFE_INTEGER) };
  });
}
export function validateWalletBalancesRequest(body: unknown): WalletValidation<WalletBalancesRequest> {
  return run(() => ({ owner: pubkeyAt(rec(body, 'balances request', ['owner']), 'owner') }));
}
const EXCLUDED_MAX = 400;
export function validateWalletCloseQuoteRequest(body: unknown): WalletValidation<WalletCloseQuoteRequest> {
  return run(() => {
    const o = rec(body, 'close-quote request', ['owner', 'kind', 'accounts', 'excluded']);
    const out: WalletCloseQuoteRequest = { owner: pubkeyAt(o, 'owner'), kind: enumAt(o, 'kind', ['empty', 'unwrap'] as const), excluded: [] };
    if (rd(o, 'accounts') !== undefined) {
      out.accounts = pubkeyList(o, 'accounts', CLOSE_BATCH_MAX);
      if (out.accounts.length === 0) bad('accounts must not be empty when present');
    }
    out.excluded = pubkeyList(o, 'excluded', EXCLUDED_MAX);
    return out;
  });
}
export function validateWalletCloseFillRequest(body: unknown): WalletValidation<WalletCloseFillRequest> {
  return run(() => {
    const o = rec(body, 'close-fill request', ['owner', 'signature', 'submittedAt', 'final']);
    return { owner: pubkeyAt(o, 'owner'), signature: signatureAt(o, 'signature'), submittedAt: msAt(o, 'submittedAt'), final: boolAt(o, 'final') };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// bot link answers (the bot -> the Engine)
// ---------------------------------------------------------------------------------------------------------------------------------

const ASSET_SOL = 'SOL';
function exactAt(o: Obj, k: string): ExactAmount {
  const e = rec(rd(o, k), k, ['baseUnits', 'decimals', 'asset']);
  const baseUnits = intStringAt(e, 'baseUnits');
  const decimals = intAt(e, 'decimals', 0, 18);
  const asset = rd(e, 'asset');
  if (asset !== ASSET_SOL && !isBase58Pubkey(asset)) bad(`${k}.asset must be "SOL" or a base58 mint address`);
  if (asset === ASSET_SOL && decimals !== 9) bad(`${k}.decimals must be 9 for SOL`);
  return { baseUnits, decimals, asset: asset as string };
}
function exactIs(a: ExactAmount, asset: string, name: string, nonNegative = true): void {
  if (a.asset !== asset) bad(`${name} is in the wrong asset for this side`);
  if (nonNegative && a.baseUnits.startsWith('-')) bad(`${name} must not be negative`);
}
function refusalOf(top: Obj): WalletLinkRefusal {
  const o = rec(top, 'refusal', ['ok', 'code', 'reason', 'needLamports', 'haveLamports']);
  const code = enumAt(o, 'code', WALLET_REFUSAL_CODES as readonly WalletRefusalCode[]);
  const out: WalletLinkRefusal = { ok: false, code, reason: plainText(rd(o, 'reason'), 'reason', 200) };
  const hasNeed = rd(o, 'needLamports') !== undefined;
  const hasHave = rd(o, 'haveLamports') !== undefined;
  if (code === 'insufficient-sol') {
    if (!hasNeed || !hasHave) bad('an insufficient-sol refusal must carry needLamports and haveLamports');
    out.needLamports = uintAt(o, 'needLamports');
    out.haveLamports = uintAt(o, 'haveLamports');
  } else if (hasNeed || hasHave) {
    bad('needLamports and haveLamports belong to an insufficient-sol refusal only');
  }
  return out;
}
/** `{ok:true, ...}` or a refusal. Returns null for a refusal handled by the caller through `refusalOf`. */
function answerOf(body: unknown, what: string, okKeys: readonly string[]): { refusal: WalletLinkRefusal } | { ok: Obj } {
  const top = plain(body, what);
  const ok = rd(top, 'ok');
  if (ok === false) return { refusal: refusalOf(top) };
  if (ok !== true) return bad(`${what} must carry ok true or false`);
  return { ok: rec(top, what, ['ok', ...okKeys]) };
}

const TX_B64_MAX_CHARS = 1512;   // base64 of WALLET_TX_BYTES_HARD_MAX (1132) bytes
const ROUTES: readonly WalletRoute[] = ['pump', 'pumpswap', 'jupiter'];
const CU_LIMIT_MAX = 400_000;
const CU_PRICE_MAX = 1_000_000;

function priorityFeeAt(o: Obj, k: string): WalletLinkPriorityFee {
  const p = rec(rd(o, k), k, ['cuLimit', 'cuPriceMicrolamports', 'lamports']);
  const cuLimit = intAt(p, 'cuLimit', 1, CU_LIMIT_MAX);
  const cuPriceMicrolamports = intAt(p, 'cuPriceMicrolamports', 1, CU_PRICE_MAX);
  const lamports = uintAt(p, 'lamports');
  // the fee the two compute-budget instructions commit to: ceil(limit x price / 1e6) (computeBudgetFeeLamports)
  if (BigInt(lamports) !== (BigInt(cuLimit) * BigInt(cuPriceMicrolamports) + 999_999n) / 1_000_000n) bad(`${k}.lamports must equal ceil(cuLimit x cuPriceMicrolamports / 1e6)`);
  return { cuLimit, cuPriceMicrolamports, lamports };
}
function programsAt(o: Obj): string[] {
  const out: string[] = [];
  const list = arrAt(o, 'programs', 16);
  if (list.length === 0) bad('programs must list at least one program id');
  for (const v of list) {
    if (typeof v !== 'string' || !isBase58Pubkey(v) || out.includes(v)) return bad('programs must hold distinct base58 program ids');
    out.push(v);
  }
  return out;
}
/** txBase64 is canonical base64 of 1..1132 bytes (and at most the request's maxTxBytes), and txBytes is its exact decoded length. */
function txAt(o: Obj, maxTxBytes: number | undefined): { txBytes: number; txBase64: string } {
  const txBytes = intAt(o, 'txBytes', 1, WALLET_TX_BYTES_HARD_MAX);
  if (maxTxBytes !== undefined && txBytes > maxTxBytes) bad('txBytes is above the requested maxTxBytes');
  const txBase64 = rd(o, 'txBase64');
  const decoded = base64DecodedLength(txBase64, TX_B64_MAX_CHARS);
  if (decoded === null) return bad('txBase64 must be canonical standard base64 of at most 1512 characters');
  if (decoded !== txBytes) bad('txBytes must equal the decoded length of txBase64');
  return { txBytes, txBase64: txBase64 as string };
}
function routingNotesAt(o: Obj): string[] { return arrAt(o, 'routingNotes', 8).map((v, i) => kebabAt(v, `routingNotes[${i}]`)); }

function boundAt(o: Obj, route: WalletRoute, side: WalletSide, mint: string): WalletLinkBound {
  const bd = plain(rd(o, 'bound'), 'bound');
  const kind = rd(bd, 'kind');
  // the bound kind follows the route: exact_out only for a PumpSwap buy, exact_in everywhere else (design 7.3)
  const expected = route === 'pumpswap' && side === 'buy' ? 'exact_out' : 'exact_in';
  if (kind !== expected) bad(`bound.kind must be ${expected} for a ${route} ${side}`);
  const tokenLeg = side === 'buy' ? 'out' : 'in';
  if (kind === 'exact_in') {
    const b = rec(bd, 'bound', ['kind', 'amountIn', 'minOut']);
    const amountIn = exactAt(b, 'amountIn');
    const minOut = exactAt(b, 'minOut');
    exactIs(amountIn, tokenLeg === 'in' ? mint : ASSET_SOL, 'bound.amountIn');
    exactIs(minOut, tokenLeg === 'out' ? mint : ASSET_SOL, 'bound.minOut');
    return { kind: 'exact_in', amountIn, minOut };
  }
  const b = rec(bd, 'bound', ['kind', 'exactOut', 'maxIn']);
  const exactOut = exactAt(b, 'exactOut');
  const maxIn = exactAt(b, 'maxIn');
  exactIs(exactOut, mint, 'bound.exactOut');
  exactIs(maxIn, ASSET_SOL, 'bound.maxIn');
  return { kind: 'exact_out', exactOut, maxIn };
}

const QUOTE_KEYS = [
  'route', 'side', 'mint', 'bound', 'maxOutflowLamports', 'quotedOut', 'quotedIn', 'impactPct', 'slippageBps', 'simulatedDeltas', 'networkFeeLamports', 'priorityFee',
  'innerFees', 'thirdPartyTransfers', 'rentLamports', 'programs', 'txBytes', 'txBase64', 'minContextSlot', 'quotedAt', 'simulatedAt', 'builtAt', 'balance', 'routingNotes',
] as const;

/** The answer to POST /v1/wallet/quote: {ok:true, quote} or a refusal. `opts.maxTxBytes` is the request's maxTxBytes; `opts.slippageBps` the request's slippage
 *  (the quote must carry exactly that). Every check that fails refuses the whole answer: nothing partial is ever handed to the page. */
export function validateWalletQuoteResponse(body: unknown, opts: { maxTxBytes?: number; slippageBps?: number } = {}): WalletValidation<WalletQuoteOk | WalletLinkRefusal> {
  return run(() => {
    const a = answerOf(body, 'quote answer', ['quote']);
    if ('refusal' in a) return a.refusal;
    const q = rec(rd(a.ok, 'quote'), 'quote', QUOTE_KEYS);
    const route = enumAt(q, 'route', ROUTES);
    const side = enumAt(q, 'side', ['buy', 'sell'] as const);
    const mint = pubkeyAt(q, 'mint');
    const bound = boundAt(q, route, side, mint);
    const quotedOutRaw = rd(q, 'quotedOut');
    const quotedInRaw = rd(q, 'quotedIn');
    let quotedOut: ExactAmount | null = null;
    let quotedIn: ExactAmount | null = null;
    if (bound.kind === 'exact_in') {
      if (quotedInRaw !== null) bad('quotedIn must be null on an exact_in quote');
      quotedOut = exactAt(q, 'quotedOut');
      exactIs(quotedOut, side === 'buy' ? mint : ASSET_SOL, 'quotedOut');
    } else {
      if (quotedOutRaw !== null) bad('quotedOut must be null on an exact_out quote');
      quotedIn = exactAt(q, 'quotedIn');
      exactIs(quotedIn, ASSET_SOL, 'quotedIn');
    }
    const impact = rd(q, 'impactPct');
    if (impact !== null && (typeof impact !== 'number' || !Number.isFinite(impact))) bad('impactPct must be a number or null');
    const slippageBps = slippageAt(q);
    if (opts.slippageBps !== undefined && slippageBps !== opts.slippageBps) bad('slippageBps must equal the requested slippage');
    const sd = rec(rd(q, 'simulatedDeltas'), 'simulatedDeltas', ['sol', 'token']);
    const simulatedDeltas = { sol: exactAt(sd, 'sol'), token: exactAt(sd, 'token') };
    exactIs(simulatedDeltas.sol, ASSET_SOL, 'simulatedDeltas.sol', false);
    exactIs(simulatedDeltas.token, mint, 'simulatedDeltas.token', false);

    const maxOutflowLamports = uintAt(q, 'maxOutflowLamports');
    const networkFeeLamports = uintAt(q, 'networkFeeLamports');
    const priorityFee = priorityFeeAt(q, 'priorityFee');
    const rentLamports = uintAt(q, 'rentLamports');
    const spend = side === 'buy' ? BigInt(bound.kind === 'exact_in' ? bound.amountIn.baseUnits : bound.maxIn.baseUnits) : 0n;
    // the dialog's "most this transaction can take" never states less than the parts it is made of (design 7.4 S7)
    if (BigInt(maxOutflowLamports) < spend + BigInt(networkFeeLamports) + BigInt(priorityFee.lamports) + BigInt(rentLamports)) {
      bad('maxOutflowLamports is below the spend plus the network fee, the priority fee and the rent');
    }

    const innerFees: WalletLinkInnerFee[] = arrAt(q, 'innerFees', 8).map((v, i) => {
      const f = rec(v, `innerFees[${i}]`, ['label', 'recipient', 'amount']);
      const label = plainText(rd(f, 'label'), `innerFees[${i}].label`, 60);
      if (label === '') bad(`innerFees[${i}].label must not be empty`);
      const amount = exactAt(f, 'amount');
      exactIs(amount, amount.asset, `innerFees[${i}].amount`);
      return { label, recipient: pubkeyAt(f, 'recipient'), amount };
    });
    const thirdPartyTransfers: WalletLinkTransfer[] = arrAt(q, 'thirdPartyTransfers', 8).map((v, i) => {
      const t = rec(v, `thirdPartyTransfers[${i}]`, ['recipient', 'lamports']);
      return { recipient: pubkeyAt(t, 'recipient'), lamports: positiveAmount(rd(t, 'lamports'), `thirdPartyTransfers[${i}].lamports`) };
    });
    const programs = programsAt(q);
    const tx = txAt(q, opts.maxTxBytes);
    const bal = rec(rd(q, 'balance'), 'balance', ['lamports', 'readAt', 'slot']);
    const quote: WalletQuoteLink = {
      route, side, mint, bound, maxOutflowLamports, quotedOut, quotedIn, impactPct: impact as number | null, slippageBps, simulatedDeltas, networkFeeLamports, priorityFee,
      innerFees, thirdPartyTransfers, rentLamports, programs, ...tx, minContextSlot: intAt(q, 'minContextSlot', 0, Number.MAX_SAFE_INTEGER),
      quotedAt: msAt(q, 'quotedAt'), simulatedAt: msAt(q, 'simulatedAt'), builtAt: msAt(q, 'builtAt'),
      balance: { lamports: uintAt(bal, 'lamports'), readAt: msAt(bal, 'readAt'), slot: intAt(bal, 'slot', 0, Number.MAX_SAFE_INTEGER) },
      routingNotes: routingNotesAt(q),
    };
    return { ok: true, quote };
  });
}

interface FillShape { status: WalletFillLink['status']; reason: string | null; solDeltaLamports: string | null; feeLamports: string | null; slot: number | null; blockTime: number | null }
const FILL_STATUSES = ['confirmed', 'failed', 'unverified', 'not-landed', 'rejected-not-owner'] as const;
function nullableAt<T>(o: Obj, k: string, read: () => T): T | null { return rd(o, k) === null ? null : read(); }
/** The status and the values every fill answer shares, with the per-status rules: confirmed carries every value, failed carries the fee, unverified a reason,
 *  not-landed and rejected-not-owner nothing booked. */
function fillCommon(o: Obj, requiredWhenConfirmed: readonly string[], valueKeys: readonly string[]): FillShape {
  const status = enumAt(o, 'status', FILL_STATUSES);
  const reasonRaw = rd(o, 'reason');
  const reason = reasonRaw === null ? null : plainText(reasonRaw, 'reason', 200);
  const solDeltaLamports = nullableAt(o, 'solDeltaLamports', () => intStringAt(o, 'solDeltaLamports'));
  const feeLamports = nullableAt(o, 'feeLamports', () => uintAt(o, 'feeLamports'));
  const slot = nullableAt(o, 'slot', () => intAt(o, 'slot', 0, Number.MAX_SAFE_INTEGER));
  const blockTime = nullableAt(o, 'blockTime', () => msAt(o, 'blockTime'));
  const present = (k: string): boolean => rd(o, k) !== null;
  if (status === 'confirmed' && !requiredWhenConfirmed.every(present)) bad('a confirmed fill must carry every booked value');
  if (status === 'failed' && feeLamports === null) bad('a failed fill must carry the fee paid');
  if (status === 'unverified' && reason === null) bad('an unverified fill must carry a reason');
  if ((status === 'not-landed' || status === 'rejected-not-owner') && valueKeys.some(present)) bad(`a ${status} fill books no value`);
  return { status, reason, solDeltaLamports, feeLamports, slot, blockTime };
}

const FILL_KEYS = ['status', 'reason', 'solDeltaLamports', 'feeLamports', 'rentPaidLamports', 'tokenDeltaRaw', 'decimals', 'slot', 'blockTime'] as const;
export function validateWalletFillResponse(body: unknown): WalletValidation<WalletFillOk | WalletLinkRefusal> {
  return run(() => {
    const a = answerOf(body, 'fill answer', ['fill']);
    if ('refusal' in a) return a.refusal;
    const f = rec(rd(a.ok, 'fill'), 'fill', FILL_KEYS);
    const common = fillCommon(f, ['solDeltaLamports', 'feeLamports', 'rentPaidLamports', 'tokenDeltaRaw', 'decimals', 'slot', 'blockTime'],
      ['solDeltaLamports', 'feeLamports', 'rentPaidLamports', 'tokenDeltaRaw', 'decimals', 'slot', 'blockTime']);
    const fill: WalletFillLink = {
      ...common, rentPaidLamports: nullableAt(f, 'rentPaidLamports', () => uintAt(f, 'rentPaidLamports')),
      tokenDeltaRaw: nullableAt(f, 'tokenDeltaRaw', () => intStringAt(f, 'tokenDeltaRaw')), decimals: nullableAt(f, 'decimals', () => intAt(f, 'decimals', 0, 18)),
    };
    return { ok: true, fill };
  });
}

const CLOSE_FILL_KEYS = ['status', 'reason', 'solDeltaLamports', 'feeLamports', 'rentReturnedLamports', 'slot', 'blockTime'] as const;
export function validateWalletCloseFillResponse(body: unknown): WalletValidation<WalletCloseFillOk | WalletLinkRefusal> {
  return run(() => {
    const a = answerOf(body, 'close-fill answer', ['fill']);
    if ('refusal' in a) return a.refusal;
    const f = rec(rd(a.ok, 'fill'), 'fill', CLOSE_FILL_KEYS);
    const common = fillCommon(f, ['solDeltaLamports', 'feeLamports', 'rentReturnedLamports', 'slot', 'blockTime'],
      ['solDeltaLamports', 'feeLamports', 'rentReturnedLamports', 'slot', 'blockTime']);
    const fill: WalletCloseFillLink = { ...common, rentReturnedLamports: nullableAt(f, 'rentReturnedLamports', () => uintAt(f, 'rentReturnedLamports')) };
    return { ok: true, fill };
  });
}

export function validateWalletFindResponse(body: unknown): WalletValidation<WalletFindOk | WalletLinkRefusal> {
  return run(() => {
    const a = answerOf(body, 'find answer', ['signatures']);
    if ('refusal' in a) return a.refusal;
    const signatures: string[] = [];
    for (const v of arrAt(a.ok, 'signatures', 3)) {
      if (typeof v !== 'string' || !isBase58Signature(v) || signatures.includes(v)) return bad('signatures must hold distinct base58 signatures that decode to 64 bytes');
      signatures.push(v);
    }
    return { ok: true, signatures };
  });
}

const TOKEN_ACCOUNTS_MAX = 2000;
export function validateWalletBalancesResponse(body: unknown): WalletValidation<WalletBalancesOk | WalletLinkRefusal> {
  return run(() => {
    const a = answerOf(body, 'balances answer', ['balances']);
    if ('refusal' in a) return a.refusal;
    const b = rec(rd(a.ok, 'balances'), 'balances', ['solLamports', 'tokens', 'readAt', 'slot']);
    const seen = new Set<string>();
    const tokens: WalletTokenBalance[] = arrAt(b, 'tokens', TOKEN_ACCOUNTS_MAX).map((v, i) => {
      const t = rec(v, `tokens[${i}]`, ['account', 'mint', 'program', 'amountRaw', 'decimals', 'rentLamports', 'frozen']);
      const account = pubkeyAt(t, 'account');
      if (seen.has(account)) bad('tokens must not repeat an account');
      seen.add(account);
      const frozen = rd(t, 'frozen');
      if (frozen !== null && typeof frozen !== 'boolean') bad(`tokens[${i}].frozen must be true, false or null`);
      return {
        account, mint: pubkeyAt(t, 'mint'), program: enumAt(t, 'program', ['token', 'token-2022'] as const), amountRaw: uintAt(t, 'amountRaw'),
        decimals: intAt(t, 'decimals', 0, 18), rentLamports: uintAt(t, 'rentLamports'), frozen: frozen as boolean | null,
      };
    });
    const balances: WalletBalancesLink = { solLamports: uintAt(b, 'solLamports'), tokens, readAt: msAt(b, 'readAt'), slot: intAt(b, 'slot', 0, Number.MAX_SAFE_INTEGER) };
    return { ok: true, balances };
  });
}

const CLOSE_QUOTE_KEYS = [
  'kind', 'accounts', 'excluded', 'remainingAccounts', 'returnedLamports', 'wsolAmount', 'networkFeeLamports', 'priorityFee', 'maxOutflowLamports', 'simulatedDeltas',
  'programs', 'txBytes', 'txBase64', 'minContextSlot', 'simulatedAt', 'builtAt',
] as const;
export function validateWalletCloseQuoteResponse(body: unknown, opts: { maxTxBytes?: number } = {}): WalletValidation<WalletCloseQuoteOk | WalletLinkRefusal> {
  return run(() => {
    const a = answerOf(body, 'close-quote answer', ['quote']);
    if ('refusal' in a) return a.refusal;
    const q = rec(rd(a.ok, 'quote'), 'quote', CLOSE_QUOTE_KEYS);
    const kind = enumAt(q, 'kind', ['empty', 'unwrap'] as const);
    const seen = new Set<string>();
    const accounts: WalletCloseAccount[] = arrAt(q, 'accounts', CLOSE_BATCH_MAX).map((v, i) => {
      const c = rec(v, `accounts[${i}]`, ['account', 'mint', 'program', 'rentLamports']);
      const account = pubkeyAt(c, 'account');
      if (seen.has(account)) bad('accounts must not repeat an account');
      seen.add(account);
      return { account, mint: pubkeyAt(c, 'mint'), program: enumAt(c, 'program', ['token', 'token-2022'] as const), rentLamports: uintAt(c, 'rentLamports') };
    });
    if (accounts.length === 0) bad('a close quote must close at least one account');
    if (kind === 'unwrap' && accounts.length !== 1) bad('an unwrap closes exactly one account');
    const excluded: WalletCloseExcluded[] = arrAt(q, 'excluded', TOKEN_ACCOUNTS_MAX).map((v, i) => {
      const e = rec(v, `excluded[${i}]`, ['account', 'reason']);
      return { account: pubkeyAt(e, 'account'), reason: kebabAt(rd(e, 'reason'), `excluded[${i}].reason`) };
    });
    const returnedLamports = uintAt(q, 'returnedLamports');
    const wsolRaw = rd(q, 'wsolAmount');
    if (kind === 'unwrap' ? wsolRaw === null : wsolRaw !== null) bad('wsolAmount is present on an unwrap quote and null on an empty-account quote');
    const networkFeeLamports = uintAt(q, 'networkFeeLamports');
    const priorityFee = priorityFeeAt(q, 'priorityFee');
    const maxOutflowLamports = uintAt(q, 'maxOutflowLamports');
    // a close takes nothing but its fees: the stated maximum is never below them
    if (BigInt(maxOutflowLamports) < BigInt(networkFeeLamports) + BigInt(priorityFee.lamports)) bad('maxOutflowLamports is below the network fee plus the priority fee');
    const sd = rec(rd(q, 'simulatedDeltas'), 'simulatedDeltas', ['sol']);
    const sol = exactAt(sd, 'sol');
    exactIs(sol, ASSET_SOL, 'simulatedDeltas.sol', false);
    const quote: WalletCloseQuoteLink = {
      kind, accounts, excluded, remainingAccounts: intAt(q, 'remainingAccounts', 0, 1_000_000), returnedLamports,
      wsolAmount: wsolRaw === null ? null : uintAt(q, 'wsolAmount'), networkFeeLamports, priorityFee, maxOutflowLamports, simulatedDeltas: { sol },
      programs: programsAt(q), ...txAt(q, opts.maxTxBytes), minContextSlot: intAt(q, 'minContextSlot', 0, Number.MAX_SAFE_INTEGER),
      simulatedAt: msAt(q, 'simulatedAt'), builtAt: msAt(q, 'builtAt'),
    };
    return { ok: true, quote };
  });
}
