// R0-SHIMPL (round 0b; C02 section 3). Pure, hand-written, dependency-free validators for contract v1. Canonical source:
// R\shared\contract\validate.ts; byte-identical copies live in Engine\src\shared\ and TG Bot\src\shared\ (R\scripts\sync-shared.ps1).
//
// Every validator builds a FRESH object that holds only the known keys (unknown keys are dropped, an own "__proto__" key can never
// pollute). A nullable field accepts null or a missing key (both become null); a field whose type does not allow null rejects it.
// Free text that crosses the wire from the bot (DeliveryTg.error, DeliveryBuy.error, ExitLegV1.error, ContractViolation.detail) is
// built as mdSafe(redactSecrets(s), max), redaction FIRST (plan grind #64). No clock is read: `now` is a parameter.
// Amended by A-110 (R8-RD0, round 8a): parseHeartbeat reads the three optional keys bot_username, bot_wallet and rpc_provider (an absent key stays absent, a valid one is kept,
// a malformed one becomes null and its name is returned in the optional `warnings` of the ok result), and ValidationResult's ok branch gains `warnings?: string[]`.
import { GMGN_SOURCE_IDS } from '../common/ids';
import type { ArmId, Grade, Level, Ms } from '../common/ids';
import { redactSecrets } from '../redact';
import { TTL_MS } from './v1';
import type {
  ArmEligibilityV1, ArmStatus, ArmsStatusPayload, BotToEngineEvent, BotToEngineType, BuyReason, ContractViolation, DeliveryBuy,
  DeliveryTg, EngineToBotEvent, EngineToBotType, ExitAlert, ExitLegV1, Heartbeat, LabelV1, OpsAlert, PositionClosed, PositionOpened,
  ProxyFieldKey, ScoreTermV1, SignalCancel, SignalDetailV1, SignalNew, Sourced, TokenProxyResponse, WireSource,
} from './v1';

/** `warnings` (A-110) is set only when something optional was malformed and nulled while the rest was kept: it names the keys (today the three optional heartbeat keys).
 *  The caller counts each one as a contract violation. It is absent, not empty, when there is nothing to report. */
export type ValidationResult<T> = { ok: true; value: T; warnings?: string[] } | { ok: false; status: 400 | 409; code: 'invalid' | 'clock' | 'contract_version'; reason: string };
/** Per-event validation (plan grind #66): a malformed envelope ARRAY -> whole-batch 400; a wrong contract version -> whole-batch 409;
 *  otherwise every event is validated on its own and reported per index. */
export type BatchValidation = { ok: true; events: Array<{ index: number; result: ValidationResult<BotToEngineEvent> }> }
  | { ok: false; status: 400 | 409; code: 'invalid' | 'contract_version'; reason: string };

// ---------------------------------------------------------------------------------------------------------------------------------
// mdSafe (port of the behaviour of the bot's md-safe.ts)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Legacy-Markdown entity characters * _ ` [ ] plus the backslash. */
const MD_CHARS = /[*_`[\]\\]/g;
/** Line-breaking controls become a space so "foo\nbar" reads "foo bar". */
const BREAKING_WS = /[\t\n\v\f\r\u{85}\u{2028}\u{2029}]/gu;
/** Every other C0/C1 control character and DEL is removed. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
/** Unicode Bidi_Control characters are removed (ZWJ stays: emoji sequences rely on it). */
const BIDI_CONTROLS = /[\u{61C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
/** Lone UTF-16 surrogates are removed (Telegram rejects text that is not valid UTF-8). */
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const MD_DEFAULT_MAX = 64;

/** Clean a name, ticker or free text for Telegram: removes * _ ` [ ] and the backslash, control and bidi characters and lone surrogates,
 *  collapses whitespace runs to one space, trims, and caps the length at `max` code points (never splitting a surrogate pair).
 *  Primitives other than strings are stringified; anything else becomes ''. Idempotent. Never throws. */
export function mdSafe(s: string, max: number): string {
  try {
    const cap = typeof max === 'number' && max >= 0 ? Math.floor(max) : MD_DEFAULT_MAX;
    const text = typeof s === 'string' ? s
      : (typeof s === 'number' || typeof s === 'bigint' || typeof s === 'boolean') ? String(s) : '';
    const cleaned = text
      .replace(BREAKING_WS, ' ')
      .replace(CONTROL_CHARS, '')
      .replace(BIDI_CONTROLS, '')
      .replace(LONE_SURROGATES, '')
      .replace(MD_CHARS, '')
      .replace(/\s+/g, ' ')
      .trim();
    const points = Array.from(cleaned);
    return points.length <= cap ? cleaned : points.slice(0, cap).join('').trimEnd();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------------------------------------------------------------

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const POLICY_VERSION_RE = /^[0-9a-f]{16}$/;
const UINT_STRING_RE = /^\d{1,20}$/;
const INT_STRING_RE = /^-?\d{1,20}$/;
const MAX_FUTURE_SKEW_MS = 5000;
const MAX_ENTRY_TO_DECISION_MS = 30000;
const MAX_LABELS = 64;
const BATCH_MAX_EVENTS = 50;
const BATCH_MAX_BYTES = 262144;
const MAX_STR = 256;
/** A-110: a canonical non-negative integer string (no sign, no leading zero, no fraction) of at most 20 digits; with 20 digits it must also fit an unsigned 64-bit integer. */
const LAMPORTS_RE = /^(0|[1-9]\d{0,19})$/;
const U64_MAX = '18446744073709551615';
/** A-110: a Telegram username as the bot reports it (letters, digits and underscore, at most 32; no '@', no slash, no space, so it can never inject markup into a link). */
const BOT_USERNAME_RE = /^[A-Za-z0-9_]{1,32}$/;
/** A-110: an RPC provider LABEL ('primary', 'public', 'fallback-2'): no slash, no '?', no '=', no '@', so neither a URL nor a keyed URL can pass; at most 32 characters. */
const RPC_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:+-]{0,31}$/;

const ENGINE_TYPES: readonly EngineToBotType[] = ['signal.new', 'signal.cancel', 'alert.exit', 'arms.status', 'ops.alert'];
const BOT_TYPES: readonly BotToEngineType[] = ['delivery.tg', 'delivery.buy', 'position.opened', 'exit.leg', 'position.closed', 'bot.heartbeat', 'bot.contract_violation'];
/** Types whose envelope may carry ca: null (delivery.tg with kind 'ops' is checked on the payload). */
const CA_NULL_TYPES: ReadonlySet<string> = new Set(['arms.status', 'ops.alert', 'bot.heartbeat', 'bot.contract_violation']);
/** Types whose envelope may carry signal_id: null without looking at the payload. */
const SIGNAL_ID_NULL_TYPES: ReadonlySet<string> = new Set(['arms.status', 'ops.alert', 'bot.heartbeat', 'bot.contract_violation']);

const ARMS: readonly ArmId[] = ['BS', 'B0', 'B1', 'B2'];
const GRADES: readonly Grade[] = ['A', 'B', 'C'];
const LEVELS: readonly Level[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'LATCHED'];
const WIRE_SOURCES: ReadonlySet<string> = new Set<string>([...GMGN_SOURCE_IDS, 'engine.derived']);
const BUY_REASONS: readonly BuyReason[] = [
  'off', 'dry_run', 'policy_mismatch', 'contract_violation', 'stale', 'already_bought', 'arm_blocked', 'outside_session', 'cap_hour', 'cap_day',
  'cap_sol_day', 'max_positions', 'reserve', 'paused_fails', 'paused_rolling', 'paused_breaker', 'duplicate_position', 'no_wallet', 'impact_cap', 'route_failed',
];
const PROXY_KEYS: readonly ProxyFieldKey[] = [
  'price_usd', 'mcap_usd', 'liq_usd', 'pool_liq_usd', 'liq_eff_usd', 'vol_5m_usd', 'vol_1h_usd', 'c5m_pct_info', 'c1h_pct_info',
  'holder_count', 'top10_rate', 'creator_balance_rate', 'age_min', 'symbol', 'name', 'launchpad_status', 'migrated',
];

// ---------------------------------------------------------------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------------------------------------------------------------

class Rej extends Error {
  constructor(readonly status: 400 | 409, readonly code: 'invalid' | 'clock' | 'contract_version', reason: string) { super(reason); }
}
function inv(reason: string): never { throw new Rej(400, 'invalid', reason); }
function failure(e: unknown): { ok: false; status: 400 | 409; code: 'invalid' | 'clock' | 'contract_version'; reason: string } {
  if (e instanceof Rej) return { ok: false, status: e.status, code: e.code, reason: e.message };
  return { ok: false, status: 400, code: 'invalid', reason: 'event could not be validated' };   // never echo an unexpected error message
}

type Obj = Record<string, unknown>;
/** Own property or undefined (an inherited member such as "constructor" is never a field). */
function rd(o: Obj, k: string): unknown { return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; }
function objAt(x: unknown, w: string): Obj {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return inv(`${w} must be an object`);
  return x as Obj;
}
const isMs = (v: unknown): v is Ms => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const absent = (v: unknown): boolean => v === undefined || v === null;

function finite(o: Obj, k: string, w: string, rule: (n: number) => boolean = () => true, what = 'a finite number'): number {
  const v = rd(o, k);
  if (typeof v !== 'number' || !Number.isFinite(v) || !rule(v)) return inv(`${w}.${k} must be ${what}`);
  return v;
}
function finiteN(o: Obj, k: string, w: string, rule: (n: number) => boolean = () => true, what = 'a finite number or null'): number | null {
  const v = rd(o, k);
  if (absent(v)) return null;
  return finite(o, k, w, rule, what);
}
const nonNeg = (n: number): boolean => n >= 0;
const positive = (n: number): boolean => n > 0;
function ms(o: Obj, k: string, w: string): Ms {
  const v = rd(o, k);
  if (!isMs(v)) return inv(`${w}.${k} must be epoch milliseconds (a non-negative integer)`);
  return v;
}
function msN(o: Obj, k: string, w: string): Ms | null {
  const v = rd(o, k);
  if (absent(v)) return null;
  return ms(o, k, w);
}
function int(o: Obj, k: string, w: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const v = rd(o, k);
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) return inv(`${w}.${k} must be an integer >= ${min}`);
  return v;
}
function intN(o: Obj, k: string, w: string, min: number, max = Number.MAX_SAFE_INTEGER): number | null {
  const v = rd(o, k);
  if (absent(v)) return null;
  return int(o, k, w, min, max);
}
function str(o: Obj, k: string, w: string, nonEmpty = false, max = MAX_STR): string {
  const v = rd(o, k);
  if (typeof v !== 'string' || v.length > max || (nonEmpty && v.length === 0)) return inv(`${w}.${k} must be a${nonEmpty ? ' non-empty' : ''} string of at most ${max} chars`);
  return v;
}
function strN(o: Obj, k: string, w: string, max = MAX_STR): string | null {
  const v = rd(o, k);
  if (absent(v)) return null;
  return str(o, k, w, false, max);
}
function bool(o: Obj, k: string, w: string): boolean {
  const v = rd(o, k);
  if (typeof v !== 'boolean') return inv(`${w}.${k} must be a boolean`);
  return v;
}
function boolN(o: Obj, k: string, w: string): boolean | null {
  const v = rd(o, k);
  if (absent(v)) return null;
  return bool(o, k, w);
}
function oneOf<T extends string>(o: Obj, k: string, w: string, allowed: readonly T[]): T {
  const v = rd(o, k);
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) return inv(`${w}.${k} must be one of ${allowed.join('|')}`);
  return v as T;
}
function oneOfN<T extends string>(o: Obj, k: string, w: string, allowed: readonly T[]): T | null {
  const v = rd(o, k);
  if (absent(v)) return null;
  return oneOf(o, k, w, allowed);
}
function b58(o: Obj, k: string, w: string): string {
  const v = rd(o, k);
  if (typeof v !== 'string' || !BASE58_RE.test(v)) return inv(`${w}.${k} must be a base58 address (32-44 chars)`);
  return v;
}
function b58N(o: Obj, k: string, w: string): string | null {
  const v = rd(o, k);
  if (absent(v)) return null;
  return b58(o, k, w);
}
function strList(o: Obj, k: string, w: string, nonEmptyList = false): string[] {
  const v = rd(o, k);
  if (!Array.isArray(v) || (nonEmptyList && v.length === 0)) return inv(`${w}.${k} must be ${nonEmptyList ? 'a non-empty ' : 'an '}array of strings`);
  return v.map((e, i) => {
    if (typeof e !== 'string' || e.length === 0 || e.length > MAX_STR) return inv(`${w}.${k}[${i}] must be a non-empty string of at most ${MAX_STR} chars`);
    return e;
  });
}
/** A decimal string for a bigint amount (lamports, raw token units). */
function amountN(o: Obj, k: string, w: string, signed = false): string | null {
  const v = rd(o, k);
  if (absent(v)) return null;
  if (typeof v !== 'string' || !(signed ? INT_STRING_RE : UINT_STRING_RE).test(v)) return inv(`${w}.${k} must be a decimal ${signed ? 'integer' : 'non-negative integer'} string or null`);
  return v;
}
/** Free text from the bot: redaction FIRST, then mdSafe (plan grind #64). */
function cleanText(s: string, max: number): string { return mdSafe(redactSecrets(s), max); }
function freeTextN(o: Obj, k: string, w: string, max: number): string | null {
  const v = rd(o, k);
  if (absent(v)) return null;
  if (typeof v !== 'string') return inv(`${w}.${k} must be a string or null`);
  return cleanText(v, max);
}
function freeText(o: Obj, k: string, w: string, max: number): string {
  const v = rd(o, k);
  if (typeof v !== 'string') return inv(`${w}.${k} must be a string`);
  return cleanText(v, max);
}

/** Rule 3: a Sourced value holds the null <=> null <=> null invariant (value, src, as_of). */
function sourcedCore(x: unknown, w: string): { value: unknown; src: WireSource | null; as_of: Ms | null } {
  const s = objAt(x, w);
  const rawValue = rd(s, 'value');
  const value = rawValue === undefined ? null : rawValue;
  const rawSrc = rd(s, 'src');
  const src = rawSrc === undefined ? null : rawSrc;
  const rawAsOf = rd(s, 'as_of');
  const asOf = rawAsOf === undefined ? null : rawAsOf;
  if (src !== null && (typeof src !== 'string' || !WIRE_SOURCES.has(src))) return inv(`${w}.src is not a known source`);
  if (asOf !== null && !isMs(asOf)) return inv(`${w}.as_of must be epoch milliseconds or null`);
  const nulls = [value === null, src === null, asOf === null];
  if (nulls.some(Boolean) && !nulls.every(Boolean)) return inv(`${w}: value, src and as_of must be all null or all set`);
  return { value, src: src as WireSource | null, as_of: asOf };
}
function sourcedNum(o: Obj, k: string, w: string): Sourced<number> {
  const c = sourcedCore(rd(o, k), `${w}.${k}`);
  if (c.value !== null && (typeof c.value !== 'number' || !Number.isFinite(c.value))) return inv(`${w}.${k}.value must be a finite number or null`);
  return { value: c.value as number | null, src: c.src, as_of: c.as_of };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Engine -> bot payloads
// ---------------------------------------------------------------------------------------------------------------------------------

function parseArmEligibility(x: unknown, w: string): ArmEligibilityV1 {
  const a = objAt(x, w);
  return { eligible: bool(a, 'eligible', w), blocked_by: strList(a, 'blocked_by', w), unknown_inputs: strList(a, 'unknown_inputs', w) };
}

function parseSignalNew(p: Obj, emittedAt: Ms): SignalNew {
  const W = 'payload';
  const d = objAt(rd(p, 'decision'), `${W}.decision`);
  const wd = `${W}.decision`;
  const decision = {
    first_reach_at: ms(d, 'first_reach_at', wd), decided_at: ms(d, 'decided_at', wd), recorded_at: ms(d, 'recorded_at', wd),
    rules_version: str(d, 'rules_version', wd, true), code_version: str(d, 'code_version', wd, true),
    line: ((): 85 => { if (rd(d, 'line') !== 85) return inv(`${wd}.line must be 85`); return 85; })(),
    confidence: finite(d, 'confidence', wd), tier: str(d, 'tier', wd, true), ban_window: bool(d, 'ban_window', wd),
    budget_level: oneOf(d, 'budget_level', wd, LEVELS),
  };
  const e = objAt(rd(p, 'entry'), `${W}.entry`);
  const we = `${W}.entry`;
  const entry = {
    price_usd: finite(e, 'price_usd', we, positive, 'a finite number > 0'), mcap_usd: finite(e, 'mcap_usd', we, positive, 'a finite number > 0'),
    mcap_basis: oneOf(e, 'mcap_basis', we, ['circ', 'total'] as const), priced_at: ms(e, 'priced_at', we),
    src: ((): 'gmgn.token_info' => { if (rd(e, 'src') !== 'gmgn.token_info') return inv(`${we}.src must be gmgn.token_info`); return 'gmgn.token_info'; })(),
    quote_age_s: finite(e, 'quote_age_s', we, nonNeg, 'a finite number >= 0'),
  };
  const t = objAt(rd(p, 'token'), `${W}.token`);
  const wt = `${W}.token`;
  const lpStatus = rd(t, 'launchpad_status');
  if (!absent(lpStatus) && lpStatus !== 0 && lpStatus !== 1 && lpStatus !== 2) inv(`${wt}.launchpad_status must be 0, 1, 2 or null`);
  const nameRaw = strN(t, 'name', wt, 4096);
  const symbolRaw = strN(t, 'symbol', wt, 4096);
  const token = {
    name: nameRaw === null ? null : mdSafe(nameRaw, 64), symbol: symbolRaw === null ? null : mdSafe(symbolRaw, 16),
    decimals: intN(t, 'decimals', wt, 0, 255), total_supply: finiteN(t, 'total_supply', wt, nonNeg),
    launchpad: strN(t, 'launchpad', wt), launchpad_status: (absent(lpStatus) ? null : lpStatus) as 0 | 1 | 2 | null,
    launchpad_progress: finiteN(t, 'launchpad_progress', wt), created_at: msN(t, 'created_at', wt), creator: b58N(t, 'creator', wt),
  };
  const v = objAt(rd(p, 'venue'), `${W}.venue`);
  const wv = `${W}.venue`;
  const venue = {
    pool_address: b58N(v, 'pool_address', wv), exchange: strN(v, 'exchange', wv), quote_mint: b58N(v, 'quote_mint', wv),
    migrated: boolN(v, 'migrated', wv), as_of: msN(v, 'as_of', wv),
  };
  const m = objAt(rd(p, 'market'), `${W}.market`);
  const wm = `${W}.market`;
  const market = {
    liq_usd: sourcedNum(m, 'liq_usd', wm), pool_liq_usd: sourcedNum(m, 'pool_liq_usd', wm), vol_5m_usd: sourcedNum(m, 'vol_5m_usd', wm),
    vol_1h_usd: sourcedNum(m, 'vol_1h_usd', wm), chg_5m_pct: sourcedNum(m, 'chg_5m_pct', wm), chg_1h_pct: sourcedNum(m, 'chg_1h_pct', wm),
    holders: sourcedNum(m, 'holders', wm), age_min: sourcedNum(m, 'age_min', wm), top10_pct: sourcedNum(m, 'top10_pct', wm),
    creator_hold_pct: sourcedNum(m, 'creator_hold_pct', wm),
  };
  const sf = objAt(rd(p, 'safety'), `${W}.safety`);
  const wsf = `${W}.safety`;
  const safety = {
    status: oneOf(sf, 'status', wsf, ['clean', 'pending'] as const), as_of: msN(sf, 'as_of', wsf),
    checked: strList(sf, 'checked', wsf), missing: strList(sf, 'missing', wsf),
  };
  const rawLabels = rd(p, 'labels');
  if (!Array.isArray(rawLabels)) inv(`${W}.labels must be an array`);
  if ((rawLabels as unknown[]).length > MAX_LABELS) inv(`${W}.labels holds more than ${MAX_LABELS} entries`);
  const labels: LabelV1[] = (rawLabels as unknown[]).map((x, i) => {
    const l = objAt(x, `${W}.labels[${i}]`);
    const wl = `${W}.labels[${i}]`;
    return { id: str(l, 'id', wl, true), rule_version: str(l, 'rule_version', wl, true), value: boolN(l, 'value', wl), known: bool(l, 'known', wl), acting: bool(l, 'acting', wl) };
  });
  const grade = oneOf(p, 'grade', W, GRADES);
  const rawArms = objAt(rd(p, 'arms'), `${W}.arms`);
  const arms = {} as Record<ArmId, ArmEligibilityV1>;
  for (const arm of ARMS) {
    if (rd(rawArms, arm) === undefined) inv(`${W}.arms.${arm} is missing (all four arms are required)`);
    arms[arm] = parseArmEligibility(rd(rawArms, arm), `${W}.arms.${arm}`);
  }
  const pol = objAt(rd(p, 'policy'), `${W}.policy`);
  const wp = `${W}.policy`;
  if (rd(pol, 'id') !== 'EA') inv(`${wp}.id must be EA`);
  const version = str(pol, 'version', wp, true);
  if (!POLICY_VERSION_RE.test(version)) inv(`${wp}.version must be 16 lowercase hex chars`);
  const policy = { id: 'EA' as const, version };
  // A-115: the optional card detail; an invalid one is dropped and never costs the signal (signalDetailDropped tells the bot)
  const detail = absent(rd(p, 'detail')) ? null : parseSignalDetail(rd(p, 'detail'));

  // time order (rule 4)
  if (entry.priced_at > decision.recorded_at) inv(`${we}.priced_at must be <= decision.recorded_at`);
  if (decision.recorded_at > emittedAt) inv(`${wd}.recorded_at must be <= emitted_at`);
  if (decision.first_reach_at > decision.decided_at) inv(`${wd}.first_reach_at must be <= decided_at`);
  if (decision.decided_at > decision.recorded_at) inv(`${wd}.decided_at must be <= recorded_at`);
  if (decision.decided_at - entry.priced_at > MAX_ENTRY_TO_DECISION_MS) inv(`decision.decided_at - entry.priced_at must be <= ${MAX_ENTRY_TO_DECISION_MS} ms`);
  const out: SignalNew = { decision, entry, token, venue, market, safety, labels, grade, arms, policy };
  if (detail !== null) out.detail = detail;
  return out;
}

const SCORE_TERMS: readonly ScoreTermV1[] = ['cluster', 'quietAged', 'burstAged', 'launchpad', 'ecosystem'];
const DETAIL_MAX_TERMS = 8;
const DETAIL_MAX_GAPS = 16;
const DETAIL_GAP_MAX_LEN = 32;
const DETAIL_MAX_WALLETS = 100000;

/** A-115: SignalNew.detail, or null when it is not valid (the signal is kept without it). Never throws. */
export function parseSignalDetail(x: unknown): SignalDetailV1 | null {
  try {
    const W = 'payload.detail';
    const d = objAt(x, W);
    const c = objAt(rd(d, 'cluster'), `${W}.cluster`);
    const wc = `${W}.cluster`;
    const wallets = int(c, 'wallets', wc, 0, DETAIL_MAX_WALLETS);
    const kol = int(c, 'kol', wc, 0, DETAIL_MAX_WALLETS);
    if (kol > wallets) inv(`${wc}.kol must be <= wallets`);
    const cluster = { wallets, kol, sol: sourcedNum(c, 'sol', wc), sol_lower_bound: bool(c, 'sol_lower_bound', wc), first_at: msN(c, 'first_at', wc) };
    const s = objAt(rd(d, 'score'), `${W}.score`);
    const ws = `${W}.score`;
    const rawTerms = rd(s, 'terms');
    if (!Array.isArray(rawTerms) || rawTerms.length > DETAIL_MAX_TERMS) inv(`${ws}.terms must be an array of at most ${DETAIL_MAX_TERMS}`);
    const terms = (rawTerms as unknown[]).map((t, i) => {
      const o = objAt(t, `${ws}.terms[${i}]`);
      return { term: oneOf(o, 'term', `${ws}.terms[${i}]`, SCORE_TERMS), points: finite(o, 'points', `${ws}.terms[${i}]`, n => n >= -100 && n <= 100, 'a number in [-100, 100]') };
    });
    const rawGaps = rd(s, 'data_gaps');
    if (!Array.isArray(rawGaps) || rawGaps.length > DETAIL_MAX_GAPS) inv(`${ws}.data_gaps must be an array of at most ${DETAIL_MAX_GAPS}`);
    const dataGaps = (rawGaps as unknown[]).map((g, i) => {
      if (typeof g !== 'string' || g.length === 0 || g.length > DETAIL_GAP_MAX_LEN) return inv(`${ws}.data_gaps[${i}] must be a string of 1-${DETAIL_GAP_MAX_LEN} chars`);
      return g;
    });
    const score = {
      raw: finite(s, 'raw', ws), eligible: bool(s, 'eligible', ws), cluster_quality: bool(s, 'cluster_quality', ws), moonshot_gate: bool(s, 'moonshot_gate', ws),
      terms, data_gaps: dataGaps,
    };
    return {
      vol_24h_usd: sourcedNum(d, 'vol_24h_usd', W), buys_5m: sourcedNum(d, 'buys_5m', W), sells_5m: sourcedNum(d, 'sells_5m', W),
      burst: sourcedNum(d, 'burst', W), liq_eff_usd: sourcedNum(d, 'liq_eff_usd', W), token_age_min: sourcedNum(d, 'token_age_min', W),
      cluster, score,
    };
  } catch {
    return null;
  }
}

/** A-115: true when the raw signal.new body carried a `detail` that the validator dropped as invalid (the bot reports invalid_detail). */
export function signalDetailDropped(body: unknown, validated: SignalNew): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const p = rd(body as Obj, 'payload');
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return false;
  return !absent(rd(p as Obj, 'detail')) && validated.detail === undefined;
}

function parseSignalCancel(p: Obj): SignalCancel {
  const W = 'payload';
  if (rd(p, 'reason') !== 'retro_kill') inv(`${W}.reason must be retro_kill`);
  const kills = strList(p, 'kills', W, true);
  if (rd(p, 'action') !== 'sell_if_held') inv(`${W}.action must be sell_if_held`);
  return { reason: 'retro_kill', kills, detected_at: ms(p, 'detected_at', W), detail: freeText(p, 'detail', W, 300), action: 'sell_if_held' };
}

function parseExitAlert(p: Obj): ExitAlert {
  const W = 'payload';
  const pol = objAt(rd(p, 'policy'), `${W}.policy`);
  if (rd(pol, 'id') !== 'EA') inv(`${W}.policy.id must be EA`);
  const version = str(pol, 'version', `${W}.policy`, true);
  if (!POLICY_VERSION_RE.test(version)) inv(`${W}.policy.version must be 16 lowercase hex chars`);
  if (rd(p, 'basis') !== 'signal_entry') inv(`${W}.basis must be signal_entry`);
  return {
    leg: oneOf(p, 'leg', W, ['TP1', 'TP2', 'TP3', 'T', 'S', 'H'] as const), policy: { id: 'EA', version },
    multiple: finite(p, 'multiple', W, positive, 'a finite number > 0'), peak_multiple: finite(p, 'peak_multiple', W, positive, 'a finite number > 0'),
    basis: 'signal_entry', price_usd: finite(p, 'price_usd', W, positive, 'a finite number > 0'), priced_at: ms(p, 'priced_at', W),
    quote_age_s: finite(p, 'quote_age_s', W, nonNeg, 'a finite number >= 0'),
  };
}

function parseArmsStatus(p: Obj): ArmsStatusPayload {
  const W = 'payload';
  const raw = rd(p, 'arms');
  if (!Array.isArray(raw)) return inv(`${W}.arms must be an array`);
  const arms: ArmStatus[] = raw.map((x, i) => {
    const a = objAt(x, `${W}.arms[${i}]`);
    const wa = `${W}.arms[${i}]`;
    return {
      arm: oneOf(a, 'arm', wa, ARMS), registered_at: ms(a, 'registered_at', wa), registry_sha: str(a, 'registry_sha', wa, true),
      verdict: oneOf(a, 'verdict', wa, ['INSUFFICIENT', 'PASS', 'FAIL', 'RETIRED', 'BIASED'] as const),
      n_matured: int(a, 'n_matured', wa, 0), days: finite(a, 'days', wa, nonNeg, 'a finite number >= 0'),
      look: ((): 0 | 1 | 2 | 3 => { const l = int(a, 'look', wa, 0, 3); return l as 0 | 1 | 2 | 3; })(),
      lcb_token: finiteN(a, 'lcb_token', wa), lcb_day: finiteN(a, 'lcb_day', wa), report_id: strN(a, 'report_id', wa), evaluated_at: ms(a, 'evaluated_at', wa),
    };
  });
  return { arms };
}

function parseOpsAlert(p: Obj): OpsAlert {
  const W = 'payload';
  const rawText = rd(p, 'text');
  if (typeof rawText !== 'string') inv(`${W}.text must be a string`);
  const text = mdSafe(rawText as string, 301);
  if (Array.from(text).length > 300) inv(`${W}.text must be at most 300 chars`);
  const since = ms(p, 'since', W);
  const clearedAt = msN(p, 'cleared_at', W);
  if (clearedAt !== null && clearedAt < since) inv(`${W}.cleared_at must be >= since`);
  return { alarm_id: str(p, 'alarm_id', W, true, 128), severity: oneOf(p, 'severity', W, ['warn', 'red'] as const), text, since, cleared_at: clearedAt };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// bot -> Engine payloads
// ---------------------------------------------------------------------------------------------------------------------------------

function parseDeliveryTg(p: Obj): DeliveryTg {
  const W = 'payload';
  return {
    status: oneOf(p, 'status', W, ['sent', 'failed', 'filtered', 'expired', 'retrying_429'] as const), message_id: intN(p, 'message_id', W, 0),
    error: freeTextN(p, 'error', W, 200), at: ms(p, 'at', W), latency_ms_from_decision: finiteN(p, 'latency_ms_from_decision', W, nonNeg),
    late: bool(p, 'late', W), kind: oneOf(p, 'kind', W, ['signal', 'cancel', 'alert', 'ops'] as const), leg: strN(p, 'leg', W, 32),
  };
}

function parseDeliveryBuy(p: Obj): DeliveryBuy {
  const W = 'payload';
  const st = objAt(rd(p, 'stamps'), `${W}.stamps`);
  const ws = `${W}.stamps`;
  return {
    status: oneOf(p, 'status', W, ['off', 'skipped', 'submitted', 'confirmed', 'failed', 'dry_run'] as const), reason: oneOfN(p, 'reason', W, BUY_REASONS),
    arm: oneOfN(p, 'arm', W, ARMS), tx: strN(p, 'tx', W, 128), error: freeTextN(p, 'error', W, 200), at: ms(p, 'at', W),
    stamps: { received_at: ms(st, 'received_at', ws), decided_at: msN(st, 'decided_at', ws), signed_at: msN(st, 'signed_at', ws),
      submitted_at: msN(st, 'submitted_at', ws), confirmed_at: msN(st, 'confirmed_at', ws) },
    route: oneOfN(p, 'route', W, ['pf-direct', 'pumpswap-direct', 'jupiter'] as const),
    sol_in_lamports: amountN(p, 'sol_in_lamports', W), quote_tokens_out: amountN(p, 'quote_tokens_out', W),
  };
}

function parsePositionOpened(p: Obj): PositionOpened {
  const W = 'payload';
  const rawPolicy = rd(p, 'policy');
  let policy: { id: string; version: string } | null = null;
  if (!absent(rawPolicy)) {
    const po = objAt(rawPolicy, `${W}.policy`);
    policy = { id: str(po, 'id', `${W}.policy`, true, 32), version: str(po, 'version', `${W}.policy`, true, 64) };
  }
  return {
    position_id: str(p, 'position_id', W, true, 128), wallet_id: str(p, 'wallet_id', W, true, 128), origin: oneOf(p, 'origin', W, ['signal', 'manual'] as const),
    dry_run: bool(p, 'dry_run', W), arm: oneOfN(p, 'arm', W, ARMS), policy, entry_tx: strN(p, 'entry_tx', W, 128), opened_at: ms(p, 'opened_at', W),
    sol_spent_lamports: amountN(p, 'sol_spent_lamports', W), tokens_raw: amountN(p, 'tokens_raw', W),
    fill_source: oneOf(p, 'fill_source', W, ['tx_meta', 'quote_dry_run', 'unverified'] as const),
    basis_sol_per_token: finiteN(p, 'basis_sol_per_token', W, positive, 'a finite number > 0 or null'),
  };
}

function parseExitLeg(p: Obj): ExitLegV1 {
  const W = 'payload';
  return {
    position_id: str(p, 'position_id', W, true, 128),
    leg: oneOf(p, 'leg', W, ['R0', 'S', 'TP1', 'TP2', 'TP3', 'T', 'H', 'CANCEL', 'MANUAL'] as const),
    status: oneOf(p, 'status', W, ['filled', 'failed', 'filled_unconfirmed', 'locked_out'] as const), attempt: int(p, 'attempt', W, 1),
    fraction_of_original: finite(p, 'fraction_of_original', W, n => n >= 0 && n <= 1, 'a number in [0, 1]'),
    trigger_multiple: finiteN(p, 'trigger_multiple', W, nonNeg), peak_multiple: finiteN(p, 'peak_multiple', W, nonNeg), quote_multiple: finiteN(p, 'quote_multiple', W, nonNeg),
    quote_src: oneOfN(p, 'quote_src', W, ['onchain', 'jupiter', 'engine_gmgn'] as const), quote_age_s: finiteN(p, 'quote_age_s', W, nonNeg),
    trigger_at: ms(p, 'trigger_at', W), send_at: msN(p, 'send_at', W), confirm_at: msN(p, 'confirm_at', W), tx: strN(p, 'tx', W, 128),
    sol_out_quoted_lamports: amountN(p, 'sol_out_quoted_lamports', W), sol_out_real_lamports: amountN(p, 'sol_out_real_lamports', W),
    fill_multiple: finiteN(p, 'fill_multiple', W, nonNeg), error: freeTextN(p, 'error', W, 200), dry_run: bool(p, 'dry_run', W),
    policy_version: str(p, 'policy_version', W, true, 64),
  };
}

function parsePositionClosed(p: Obj): PositionClosed {
  const W = 'payload';
  return {
    position_id: str(p, 'position_id', W, true, 128), closed_at: ms(p, 'closed_at', W),
    reason: oneOf(p, 'reason', W, ['policy', 'cancel', 'manual', 'external_sell'] as const),
    realized_sol_net_lamports: amountN(p, 'realized_sol_net_lamports', W, true), rent_reclaimed_lamports: amountN(p, 'rent_reclaimed_lamports', W),
    close_account_tx: strN(p, 'close_account_tx', W, 128), close_account_status: oneOf(p, 'close_account_status', W, ['closed', 'skipped', 'failed'] as const),
  };
}

/** A-110: the optional heartbeat key `key`. Absent (no own property, or undefined): nothing is written, so the parsed heartbeat has no such key. null: kept as null.
 *  A valid value: kept. A malformed value: the key is set to null and its name is pushed to `warnings`. Never throws. */
function optionalKey(p: Obj, out: Obj, key: string, check: (v: unknown) => unknown, warnings: string[]): void {
  const v = rd(p, key);
  if (v === undefined) return;
  if (v === null) { out[key] = null; return; }
  const ok = check(v);
  if (ok === undefined) { out[key] = null; warnings.push(key); } else out[key] = ok;
}
const botUsernameOf = (v: unknown): string | undefined => (typeof v === 'string' && BOT_USERNAME_RE.test(v) ? v : undefined);
/** An RPC label: the charset refuses a URL, and a label that redaction would change (it holds a key shape) is refused as well. */
const rpcProviderOf = (v: unknown): string | undefined => (typeof v === 'string' && RPC_LABEL_RE.test(v) && redactSecrets(v) === v ? v : undefined);
/** The bot's own default-wallet balance read. wallet_id and slot may be null or missing (both become null); address, lamports and read_at are required. */
function botWalletOf(v: unknown): NonNullable<Heartbeat['bot_wallet']> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Obj;
  const walletId = rd(o, 'wallet_id');
  if (!absent(walletId) && (typeof walletId !== 'string' || walletId.length === 0 || walletId.length > 128)) return undefined;
  const address = rd(o, 'address');
  if (typeof address !== 'string' || !BASE58_RE.test(address)) return undefined;
  const lamports = rd(o, 'lamports');
  if (typeof lamports !== 'string' || !LAMPORTS_RE.test(lamports) || (lamports.length === 20 && lamports > U64_MAX)) return undefined;
  const readAt = rd(o, 'read_at');
  if (!isMs(readAt)) return undefined;
  const slot = rd(o, 'slot');
  if (!absent(slot) && (typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 0)) return undefined;
  return { wallet_id: absent(walletId) ? null : (walletId as string), address, lamports, read_at: readAt, slot: absent(slot) ? null : (slot as number) };
}

function parseHeartbeat(p: Obj, warnings: string[]): Heartbeat {
  const W = 'payload';
  if (rd(p, 'contract_v') !== 1) inv(`${W}.contract_v must be 1`);
  const pv = objAt(rd(p, 'policy_versions'), `${W}.policy_versions`);
  const policyVersions: Record<string, string> = {};
  for (const k of Object.keys(pv)) {
    if (k === '__proto__' || k.length === 0 || k.length > 32) inv(`${W}.policy_versions has an invalid key`);
    policyVersions[k] = str(pv, k, `${W}.policy_versions`, true, 64);
  }
  const ab = objAt(rd(p, 'autobuy'), `${W}.autobuy`);
  const wa = `${W}.autobuy`;
  const cu = objAt(rd(p, 'caps_used'), `${W}.caps_used`);
  const wc = `${W}.caps_used`;
  const hb: Heartbeat = {
    at: ms(p, 'at', W), contract_v: 1, policy_versions: policyVersions,
    autobuy: { enabled: bool(ab, 'enabled', wa), mode: oneOf(ab, 'mode', wa, ['off', 'dry_run', 'live'] as const), arm: oneOfN(ab, 'arm', wa, ARMS),
      report_id: strN(ab, 'report_id', wa), confirmed_at: msN(ab, 'confirmed_at', wa), dry_run: bool(ab, 'dry_run', wa), paused: strN(ab, 'paused', wa) },
    caps_used: { hour: finite(cu, 'hour', wc, nonNeg, 'a finite number >= 0'), day: finite(cu, 'day', wc, nonNeg, 'a finite number >= 0'),
      sol_day: finite(cu, 'sol_day', wc, nonNeg, 'a finite number >= 0') },
    open_positions: int(p, 'open_positions', W, 0), tg_min_grade: oneOf(p, 'tg_min_grade', W, GRADES), outbox_backlog: int(p, 'outbox_backlog', W, 0),
    rpc_ok: bool(p, 'rpc_ok', W), dead_lettered: int(p, 'dead_lettered', W, 0), dead_last_code: strN(p, 'dead_last_code', W, 64),
  };
  // A-110: the three optional keys, in this order (so `warnings` is in this order). A key the sender left out stays out of the parsed value.
  optionalKey(p, hb as unknown as Obj, 'bot_username', botUsernameOf, warnings);
  optionalKey(p, hb as unknown as Obj, 'bot_wallet', botWalletOf, warnings);
  optionalKey(p, hb as unknown as Obj, 'rpc_provider', rpcProviderOf, warnings);
  return hb;
}

function parseContractViolation(p: Obj): ContractViolation {
  const W = 'payload';
  return { code: str(p, 'code', W, true, 64), detail: freeText(p, 'detail', W, 300), offending_event_id: strN(p, 'offending_event_id', W, 64) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// envelope
// ---------------------------------------------------------------------------------------------------------------------------------

type Direction = 'engine-to-bot' | 'bot-to-engine';

function parseEvent(body: unknown, now: Ms, direction: Direction, warnings: string[]): EngineToBotEvent | BotToEngineEvent {
  const b = objAt(body, 'event');
  // rule 1: the version first, so a v=2 event is a 409 whatever else it holds
  if (rd(b, 'v') !== 1) throw new Rej(409, 'contract_version', 'contract version not supported; supported:[1]');
  const types: readonly string[] = direction === 'engine-to-bot' ? ENGINE_TYPES : BOT_TYPES;
  const type = rd(b, 'type');
  if (typeof type !== 'string' || !types.includes(type)) return inv(`type is not a known ${direction} event type`);
  const eventId = rd(b, 'event_id');
  if (typeof eventId !== 'string' || !ULID_RE.test(eventId)) return inv('event_id must be a ULID');
  const attempt = int(b, 'attempt', 'event', 1);
  const emittedAt = ms(b, 'emitted_at', 'event');
  // rule 2
  if (emittedAt > now + MAX_FUTURE_SKEW_MS) throw new Rej(400, 'clock', 'emitted_at is more than 5 s in the future');
  if (direction === 'engine-to-bot') {
    const ttl = TTL_MS[type as EngineToBotType];
    if (ttl !== null && now - emittedAt > ttl) throw new Rej(400, 'clock', `${type} is older than its TTL of ${ttl} ms`);
  }
  const ca = b58N(b, 'ca', 'event');
  const rawSignalId = rd(b, 'signal_id');
  if (!absent(rawSignalId) && (typeof rawSignalId !== 'string' || rawSignalId.length === 0 || rawSignalId.length > 128)) inv('signal_id must be a non-empty string or null');
  const signalId = absent(rawSignalId) ? null : (rawSignalId as string);
  const p = objAt(rd(b, 'payload'), 'payload');

  let payload: unknown;
  switch (type) {
    case 'signal.new': payload = parseSignalNew(p, emittedAt); break;
    case 'signal.cancel': payload = parseSignalCancel(p); break;
    case 'alert.exit': payload = parseExitAlert(p); break;
    case 'arms.status': payload = parseArmsStatus(p); break;
    case 'ops.alert': payload = parseOpsAlert(p); break;
    case 'delivery.tg': payload = parseDeliveryTg(p); break;
    case 'delivery.buy': payload = parseDeliveryBuy(p); break;
    case 'position.opened': payload = parsePositionOpened(p); break;
    case 'exit.leg': payload = parseExitLeg(p); break;
    case 'position.closed': payload = parsePositionClosed(p); break;
    case 'bot.heartbeat': payload = parseHeartbeat(p, warnings); break;
    default: payload = parseContractViolation(p); break;      // bot.contract_violation (the type list above admits nothing else)
  }

  // ca / signal_id may be null only where the contract says so (rule 1). Implementation notes: a delivery.tg with kind 'ops' is the
  // delivery of an ops.alert and has neither a CA nor a signal; a manual position (and its exit legs and close) has no signal.
  const isOpsDelivery = type === 'delivery.tg' && (payload as DeliveryTg).kind === 'ops';
  if (ca === null && !CA_NULL_TYPES.has(type) && !isOpsDelivery) inv('ca must not be null for this event type');
  if (type === 'delivery.tg') {
    if (isOpsDelivery && signalId !== null) inv('signal_id must be null when kind is ops');
    if (!isOpsDelivery && signalId === null) inv('signal_id must not be null unless kind is ops');
  } else if (signalId === null && !SIGNAL_ID_NULL_TYPES.has(type)) {
    const manualOk = (type === 'position.opened' && (payload as PositionOpened).origin === 'manual') || type === 'exit.leg' || type === 'position.closed';
    if (!manualOk) inv('signal_id must not be null for this event type');
  }
  return { v: 1, type, event_id: eventId, signal_id: signalId, ca, emitted_at: emittedAt, attempt, payload } as EngineToBotEvent | BotToEngineEvent;
}

export function validateEngineToBot(body: unknown, now: Ms): ValidationResult<EngineToBotEvent> {
  try {
    return { ok: true, value: parseEvent(body, now, 'engine-to-bot', []) as EngineToBotEvent };
  } catch (e) {
    return failure(e);
  }
}

function validateBotEvent(body: unknown, now: Ms): ValidationResult<BotToEngineEvent> {
  try {
    const warnings: string[] = [];
    const value = parseEvent(body, now, 'bot-to-engine', warnings) as BotToEngineEvent;
    return warnings.length > 0 ? { ok: true, value, warnings } : { ok: true, value };
  } catch (e) {
    return failure(e);
  }
}

/** The bot POSTs `{ events: [1..50 envelopes] }` (BotBatch). Rule 7: 1-50 events and at most 262144 bytes, each event validated on its own
 *  and reported per index; only a malformed events array (400) or a wrong contract version (409) rejects the whole batch. */
export function validateBotBatch(body: unknown, now: Ms): BatchValidation {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, status: 400, code: 'invalid', reason: 'body must be an object holding an events array' };
  const events = rd(body as Obj, 'events');
  if (!Array.isArray(events)) return { ok: false, status: 400, code: 'invalid', reason: 'events must be an array' };
  if (events.length < 1 || events.length > BATCH_MAX_EVENTS) return { ok: false, status: 400, code: 'invalid', reason: `events must hold 1 to ${BATCH_MAX_EVENTS} envelopes` };
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(body)).length;
  } catch {
    return { ok: false, status: 400, code: 'invalid', reason: 'body is not serialisable' };
  }
  if (bytes > BATCH_MAX_BYTES) return { ok: false, status: 400, code: 'invalid', reason: `batch is larger than ${BATCH_MAX_BYTES} bytes` };
  for (const ev of events) {
    if (typeof ev === 'object' && ev !== null && !Array.isArray(ev) && rd(ev as Obj, 'v') !== 1) {
      return { ok: false, status: 409, code: 'contract_version', reason: 'contract version not supported; supported:[1]' };
    }
  }
  return { ok: true, events: events.map((ev, index) => ({ index, result: validateBotEvent(ev, now) })) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// token proxy response
// ---------------------------------------------------------------------------------------------------------------------------------

/** Rule 8: ok === true, ca base58, asOf finite, every fields key a ProxyFieldKey, every value a valid Sourced. */
export function validateTokenProxyResponse(body: unknown): ValidationResult<TokenProxyResponse> {
  try {
    const b = objAt(body, 'response');
    if (rd(b, 'ok') !== true) inv('ok must be true');
    const ca = b58(b, 'ca', 'response');
    const asOf = ms(b, 'asOf', 'response');
    const rawFields = objAt(rd(b, 'fields'), 'response.fields');
    const fields: TokenProxyResponse['fields'] = {};
    for (const key of Object.keys(rawFields)) {
      if (!(PROXY_KEYS as readonly string[]).includes(key)) inv('response.fields holds a key that is not a ProxyFieldKey');
      const c = sourcedCore(rawFields[key], `response.fields.${key}`);
      let value: number | string | boolean | null = null;
      if (c.value !== null) {
        const raw = c.value;
        if (typeof raw === 'number') {
          if (!Number.isFinite(raw)) inv(`response.fields.${key}.value must be finite`);
          value = raw;
        } else if (typeof raw === 'string') {
          value = key === 'symbol' ? mdSafe(raw, 16) : key === 'name' ? mdSafe(raw, 64) : raw.length <= MAX_STR ? raw : inv(`response.fields.${key}.value is too long`);
        } else if (typeof raw === 'boolean') {
          value = raw;
        } else {
          inv(`response.fields.${key}.value must be a number, string, boolean or null`);
        }
      }
      fields[key as ProxyFieldKey] = { value, src: c.src, as_of: c.as_of };
    }
    return { ok: true, value: { ok: true, ca, asOf, fields } };
  } catch (e) {
    return failure(e);
  }
}
