/**
 * Trading-safety guards (2026-09-29 security hardening, threat T6).
 *
 * Pure helpers + two small stateful classes that bot.ts wires into every
 * buy/sell path:
 *   - validateCa / parseSolAmount / parsePercent — address and amount checks on
 *     /buy, /sell, /check, every buy:/sell: callback, the order/limit/position
 *     callbacks and Send SOL. Explicit garbage is REFUSED (null) — it never
 *     silently falls back to a default (July `parseFloat(x) || buyAmount`) or to
 *     a 100% sell (July `parseInt(x) || 100` turned a typo into a full exit).
 *     An EMPTY value meaning "use the default" is the caller's decision.
 *   - SETTING_RANGES / parseSetting / sanitizeKb — settings inputs are range-
 *     checked; NaN, negatives and out-of-range values are refused, not saved.
 *   - TOGGLE_FIELDS / isToggleAllowed — whitelist for the `*:tog:<field>`
 *     callbacks. A forged button could previously write onto every object in
 *     the bot (`s.global[field] = !s.global[field]` with field = __proto__ …).
 *   - BuyLock — per wallet+CA lock around executeBuy so double taps / a signal
 *     racing a manual tap can't double-buy. Release in `finally`.
 *   - AutoBuyCaps — AUTO_BUY_MAX_PER_HOUR / _PER_DAY / _SOL_PER_DAY, persisted
 *     to data/autobuy-caps.json so a restart does not reset the counters.
 *     All unset = no cap ("off by default"; recommended values are open user
 *     decision #6). B2 (rebuild): the rebuilt auto-buy resolves its limits with
 *     resolveAutoBuyLimits (code defaults 3 per hour, 20 per day, 5 open positions,
 *     SOL per day 20 x buy size, reserve 0.03 SOL; the env may lower them and a
 *     raise is reported as a deviation) and feeds them to AutoBuyCaps.
 *
 * No network, no logger import (keeps the module trivially testable).
 */
import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';
import { writeFileAtomicSync } from '../link/atomic-file';

// ── Number parsing ────────────────────────────────────────────

// REBUILD-CHOSEN: strict decimal grammar (optional sign, digits with optional
// fraction, optional exponent). Rejects '1OO', '5abc', '0x10', 'Infinity',
// '' and whitespace-only — every case where parseFloat/parseInt/Number()
// silently produced a number from garbage. The exponent is allowed so a
// keyboard value JS stringifies as '1e-7' still round-trips through a
// `buy:<ca>:<amount>` callback.
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const MAX_NUMERIC_INPUT_LEN = 64; // REBUILD-CHOSEN: cheap bound on hostile input

/**
 * Number or numeric string → finite number, else null. `allowPercent` accepts
 * one trailing '%' ("50%" → 50).
 */
function toNumber(s: unknown, allowPercent = false): number | null {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  if (typeof s !== 'string' || s.length > MAX_NUMERIC_INPUT_LEN) return null;
  let t = s.trim();
  // REBUILD-CHOSEN: a trailing '%' is accepted for percent inputs — the old
  // parseInt('50%') accepted it, so refusing it would be a needless UX change.
  if (allowPercent && t.endsWith('%')) t = t.slice(0, -1).trim();
  if (!DECIMAL_RE.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ── Addresses & amounts ───────────────────────────────────────

const BASE58_CA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Base58 32–44 chars that decodes to exactly 32 bytes (a Solana public key).
 * Returns the trimmed address, or null. Rejects `__proto__`, anything with ':'
 * (callback-data splitting), tickers, URLs and 64-byte signatures/secrets.
 */
export function validateCa(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!BASE58_CA_RE.test(t)) return null;
  try {
    return bs58.decode(t).length === 32 ? t : null;
  } catch {
    return null;
  }
}

/** One lamport. REBUILD-CHOSEN default minimum: anything smaller buys nothing. */
export const MIN_SOL_AMOUNT = 1e-9;

/**
 * SOL amount: finite, > 0, >= min (default 1 lamport), <= max (default: no
 * upper bound — a max /buy amount is open user decision #5, so callers pass
 * `max` only once the user has chosen one). NaN / Infinity / negative / zero /
 * garbage → null.
 */
export function parseSolAmount(s: unknown, o?: { min?: number; max?: number }): number | null {
  const n = toNumber(s);
  if (n === null || !(n > 0)) return null;
  const min = o?.min ?? MIN_SOL_AMOUNT;
  const max = o?.max ?? Infinity;
  if (n < min || n > max) return null;
  return n;
}

/**
 * Sell percentage: integer 1–100 ("50%" accepted). Garbage → null, NOT 100 —
 * '1OO' (letter O) used to parse as 1 and an unparseable value as a 100% sell.
 */
export function parsePercent(s: unknown): number | null {
  const n = toNumber(s, true);
  if (n === null || !Number.isInteger(n)) return null;
  return n >= 1 && n <= 100 ? n : null;
}

// ── Settings ranges ───────────────────────────────────────────

/**
 * Stored-unit ranges: slippage fields in bps (0.1%–50%), priority fee in the
 * unit the menu shows ("lamports", 0–5,000,000), retry attempts 1–5.
 */
export const SETTING_RANGES = Object.freeze({
  slippageBps:      [10, 5000] as const,
  priorityFee:      [0, 5_000_000] as const,
  retryMaxAttempts: [1, 5] as const,
  smartSlippageMax: [10, 5000] as const,
});

/** Fields whose menu prompt asks for a PERCENT ("Enter slippage % (e.g. 3 for 3%)"). */
const PERCENT_INPUT_FIELDS: ReadonlySet<string> = new Set(['slippageBps', 'smartSlippageMax']);

/**
 * Parse a settings input exactly as the menu prompts for it and return the
 * value to STORE, or null to refuse.
 *
 * REBUILD-CHOSEN unit contract (matches the existing bot.ts prompts/handlers):
 *   - slippageBps / smartSlippageMax: raw = percent ("3", "3%", "0.5") →
 *     Math.round(pct * 100) bps, must land in [10, 5000];
 *   - priorityFee: raw = integer lamports, [0, 5,000,000];
 *   - retryMaxAttempts: raw = integer, [1, 5].
 * Out-of-range values are refused (null), never clamped-and-saved. An unknown
 * field (forged / typo) → null.
 */
export function parseSetting(field: keyof typeof SETTING_RANGES, raw: unknown): number | null {
  if (typeof field !== 'string' || !Object.prototype.hasOwnProperty.call(SETTING_RANGES, field)) return null;
  const [lo, hi] = SETTING_RANGES[field];
  const isPct = PERCENT_INPUT_FIELDS.has(field);
  const n = toNumber(raw, isPct);
  if (n === null) return null;
  let v: number;
  if (isPct) {
    v = Math.round(n * 100);
  } else {
    if (!Number.isInteger(n)) return null;
    v = n;
  }
  return v >= lo && v <= hi ? v : null;
}

/** REBUILD-CHOSEN helper: finite number >= 0 (USD mcap/liquidity filters, impact-alert %). */
export function parseNonNegative(s: unknown): number | null {
  const n = toNumber(s, true);
  return n !== null && n >= 0 ? n : null;
}

/** Telegram limits. */
export const MAX_KB_BUTTONS = 8;
export const TG_CALLBACK_DATA_MAX_BYTES = 64;
// REBUILD-CHOSEN: when no CA is given (settings input time), size-check the buy
// callback against the longest possible CA (44 chars) so the button fits for
// every token.
const WORST_CASE_CA = 'X'.repeat(44);

/**
 * Clean a buy/sell keyboard list (settings input `"0.1,0.5,1"`.split(',') or a
 * stored array). Keeps order, drops invalid entries, max 8 buttons.
 *   - buy: SOL amounts (parseSolAmount); a button whose callback_data
 *     `buy:${ca}:${a}` exceeds 64 bytes is dropped (Telegram rejects the whole
 *     keyboard otherwise);
 *   - sell: integer percents 1–100 (parsePercent).
 */
export function sanitizeKb(values: unknown[], kind: 'buy' | 'sell', ca?: string): number[] {
  if (!Array.isArray(values)) return [];
  if (kind !== 'buy' && kind !== 'sell') return [];
  const caForLen = typeof ca === 'string' && ca ? ca : WORST_CASE_CA;
  const out: number[] = [];
  for (const raw of values) {
    if (out.length >= MAX_KB_BUTTONS) break;
    if (kind === 'buy') {
      const a = parseSolAmount(raw);
      if (a === null) continue;
      if (Buffer.byteLength(`buy:${caForLen}:${a}`, 'utf8') > TG_CALLBACK_DATA_MAX_BYTES) continue;
      out.push(a);
    } else {
      const p = parsePercent(raw);
      if (p === null) continue;
      out.push(p);
    }
  }
  return out;
}

// ── Toggle whitelist ──────────────────────────────────────────

/**
 * Booleans each `<menu>:tog:<field>` callback may flip — exactly the buttons
 * the menus render (bot.ts buySettingsMenu / sellSettingsMenu /
 * globalSettingsMenu) plus the signal-section booleans the sig:toggle* handlers
 * flip (degenMode/autoBuyOnUpgrade are boolean-or-absent there).
 */
export const TOGGLE_FIELDS: {
  readonly buy: readonly string[];
  readonly sell: readonly string[];
  readonly glob: readonly string[];
  readonly signal: readonly string[];
} = Object.freeze({
  buy:    Object.freeze(['confirmManualBuy', 'duplicateBuy', 'autoSellOnManualBuy', 'retryOnSlippage']),
  sell:   Object.freeze(['confirmManualSell', 'autoPnlCard']),
  glob:   Object.freeze(['antiMev', 'degenMode']),
  signal: Object.freeze(['enabled', 'degenMode', 'duplicateBuy', 'autoSellOnSignal', 'autoBuyOnUpgrade', 'sessionEnabled']),
});

/** True only for a whitelisted (menu, field) pair. `__proto__`, `constructor`, unknown → false. */
export function isToggleAllowed(menu: keyof typeof TOGGLE_FIELDS, field: string): boolean {
  if (typeof menu !== 'string' || typeof field !== 'string') return false;
  if (!Object.prototype.hasOwnProperty.call(TOGGLE_FIELDS, menu)) return false;
  return TOGGLE_FIELDS[menu].includes(field);
}

// ── Per wallet+CA buy lock ────────────────────────────────────

/**
 * In-process lock: `acquire` returns false while the same wallet is already
 * buying the same CA. Always `release` in `finally`.
 *
 * REBUILD-CHOSEN: a lock older than `maxHoldMs` (default 5 min) is treated as
 * stale and may be re-acquired, so one hung RPC await can never block a token
 * forever. A buy still in flight after 5 minutes has long since failed or
 * landed.
 */
export class BuyLock {
  private readonly held = new Map<string, number>();

  constructor(private readonly maxHoldMs: number = 5 * 60_000) {}

  private static key(walletId: string, ca: string): string {
    return `${String(walletId)}:${String(ca)}`;
  }

  acquire(walletId: string, ca: string, now: number = Date.now()): boolean {
    const k = BuyLock.key(walletId, ca);
    const since = this.held.get(k);
    if (since !== undefined && now - since < this.maxHoldMs) return false;
    this.held.set(k, now);
    return true;
  }

  release(walletId: string, ca: string): void {
    this.held.delete(BuyLock.key(walletId, ca));
  }

  isHeld(walletId: string, ca: string, now: number = Date.now()): boolean {
    const since = this.held.get(BuyLock.key(walletId, ca));
    return since !== undefined && now - since < this.maxHoldMs;
  }
}

// ── Auto-buy caps ─────────────────────────────────────────────

/** CHOSEN filename (spec §3.3.8); lives in the bot's data/ dir. */
export const AUTO_BUY_CAPS_FILENAME = 'autobuy-caps.json';

const HOUR_MS = 60 * 60_000;
const DAY_MS  = 24 * HOUR_MS;

export interface AutoBuyCapLimits { perHour: number; perDay: number; solPerDay: number }

interface CapEntry { ts: number; sol: number }

/**
 * Normalised limit: 0 = no cap, positive = cap, -1 = INVALID (fail safe).
 * REBUILD-CHOSEN: an invalid limit (NaN, negative, non-integer count) blocks
 * auto-buy with a reason instead of silently meaning "no cap" — same fail-SAFE
 * posture as the autoBuyMinScore 999 default: someone who typed a cap wanted
 * one.
 */
function normLimit(v: unknown, integer: boolean): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return -1;
  if (integer && !Number.isInteger(v)) return -1;
  return v;
}

/**
 * Rolling-window auto-buy caps. REBUILD-CHOSEN: "per hour" = the last 60 min
 * and "per day" = the last 24 h (rolling, timezone-free), not calendar buckets.
 * Persisted as `{ v: 1, buys: [{ ts, sol }], locked_until? }`, pruned to the last 24 h, written
 * atomically (A-93f: link/atomic-file.ts, tmp + fsync + rename with the EPERM/EBUSY retry).
 *
 * A-93f fail-safe: a caps file that existed but could not be read never means "zero usage": the first
 * check after such a load holds every buy for 24 h (`locked_until`, persisted, so a restart does not clear
 * it), and while a save keeps failing the check refuses too (the next restart would otherwise forget the
 * buys since the last good save).
 *
 * Usage (the auto-buy path): `reserve(buyAmount)` immediately before the buy →
 * on `{ ok: false, reason }` the buy is skipped with that reason; on
 * `{ ok: true, token }` → `commit(token)` after a SUCCESSFUL buy,
 * `cancel(token)` when the buy failed. The reservation counts against every cap
 * while the buy is in flight, so concurrent signals cannot all pass
 * the check before any of them is recorded (REBUILD-CHOSEN, final review fixes).
 * `check()` / `record()` stay for callers that do not overlap.
 */
export class AutoBuyCaps {
  private readonly file: string;
  private limits: AutoBuyCapLimits;
  private buys: CapEntry[] = [];
  /** In-flight reservations (token → entry); in memory only, never persisted. */
  private readonly pending = new Map<number, CapEntry>();
  private seq = 0;
  /** Set when the persisted file existed but could not be read/parsed (counters then start empty). */
  readonly loadError: string | null = null;
  /** Last persistence failure (counters stay correct in memory). */
  saveError: string | null = null;
  /** A-93f: buys are held until then (epoch ms; persisted). */
  private lockedUntil: number | null = null;
  /** A-93f: the file was unreadable at load; the 24 h hold starts at the first check (which knows the time). */
  private holdPending = false;
  /**
   * A-114: the send times of the PILOT buys (persisted as `pilot_sent` in the same file, only while it holds an entry, so the file of a bot
   * without the pilot is byte-for-byte what it was). An entry is written BEFORE its buy is sent (pilotCommit); a restart never resets it.
   */
  private pilotSent: number[] = [];
  /** A-114: in-flight pilot reservations (token -> time); in memory only, like `pending`. */
  private readonly pilotPending = new Map<number, number>();

  constructor(file: string, limits: { perHour: number; perDay: number; solPerDay: number }) {
    this.file = file;
    this.limits = {
      perHour:   normLimit(limits?.perHour, true),
      perDay:    normLimit(limits?.perDay, true),
      solPerDay: normLimit(limits?.solPerDay, false),
    };
    try {
      if (file && fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const list = Array.isArray(parsed) ? parsed : parsed?.buys;
        if (!Array.isArray(list)) throw new Error('unexpected format');
        this.buys = list
          .filter((e: any) => e && Number.isFinite(e.ts) && Number.isFinite(e.sol) && e.sol >= 0)
          .map((e: any) => ({ ts: Number(e.ts), sol: Number(e.sol) }));
        if (!Array.isArray(parsed) && Number.isFinite(parsed?.locked_until)) this.lockedUntil = Number(parsed.locked_until);
        if (!Array.isArray(parsed) && parsed?.pilot_sent !== undefined) {
          if (!Array.isArray(parsed.pilot_sent)) throw new Error('unexpected pilot_sent format');
          this.pilotSent = parsed.pilot_sent.filter((t: unknown) => typeof t === 'number' && Number.isFinite(t)).map(Number);
        }
      }
    } catch (e: any) {
      this.buys = [];
      this.pilotSent = [];
      this.loadError = String(e?.message || e).slice(0, 200);
      this.holdPending = true;
    }
  }

  /** True when at least one cap (or an invalid cap) is configured. */
  get enabled(): boolean {
    return this.limits.perHour !== 0 || this.limits.perDay !== 0 || this.limits.solPerDay !== 0;
  }

  getLimits(): AutoBuyCapLimits {
    return { ...this.limits };
  }

  /**
   * B2 (additive): replace the limits, counters untouched. The SOL-per-day default follows the buy size (20 x buy), so the
   * limits are re-resolved when the owner changes the buy amount. Same normalisation as the constructor (invalid = fail safe).
   */
  setLimits(limits: { perHour: number; perDay: number; solPerDay: number }): void {
    this.limits = {
      perHour:   normLimit(limits?.perHour, true),
      perDay:    normLimit(limits?.perDay, true),
      solPerDay: normLimit(limits?.solPerDay, false),
    };
  }

  private prune(now: number): void {
    const cutoff = now - DAY_MS;
    this.buys = this.buys.filter(e => e.ts > cutoff);
    if (this.pilotSent.length > 0) this.pilotSent = this.pilotSent.filter(t => t >= utcDayStart(now));   // A-114: today's pilot buys only
  }

  /** Buys (recorded + in-flight reservations) and SOL inside the rolling windows (for status lines / tests). */
  usage(now: number = Date.now()): { lastHour: number; lastDay: number; solLastDay: number } {
    this.prune(now);
    const hourCut = now - HOUR_MS;
    let lastHour = 0;
    let solLastDay = 0;
    for (const e of this.buys) {
      if (e.ts > hourCut) lastHour++;
      solLastDay += e.sol;
    }
    let pendDay = 0;
    for (const e of this.pending.values()) {
      if (e.ts > now - DAY_MS) { pendDay++; solLastDay += e.sol; if (e.ts > hourCut) lastHour++; }
    }
    return { lastHour, lastDay: this.buys.length + pendDay, solLastDay };
  }

  check(solAmount: number, now: number = Date.now()): { ok: true } | { ok: false; reason: string } {
    const { perHour, perDay, solPerDay } = this.limits;
    if (perHour < 0)   return { ok: false, reason: 'auto-buy cap: AUTO_BUY_MAX_PER_HOUR is invalid — fix it in .env' };
    if (perDay < 0)    return { ok: false, reason: 'auto-buy cap: AUTO_BUY_MAX_PER_DAY is invalid — fix it in .env' };
    if (solPerDay < 0) return { ok: false, reason: 'auto-buy cap: AUTO_BUY_MAX_SOL_PER_DAY is invalid — fix it in .env' };
    if (!(typeof solAmount === 'number' && Number.isFinite(solAmount) && solAmount > 0)) {
      return { ok: false, reason: 'auto-buy cap: invalid buy amount' };
    }
    if (this.holdPending) {
      this.holdPending = false;
      this.lockedUntil = now + DAY_MS;
      this.save();
    }
    if (this.lockedUntil !== null && now < this.lockedUntil) {
      return { ok: false, reason: `auto-buy cap: ${AUTO_BUY_CAPS_FILENAME} could not be read at start (${this.loadError ?? 'held from an earlier start'}); buys are held until ${new Date(this.lockedUntil).toISOString()} so the daily limits cannot be exceeded` };
    }
    if (this.saveError !== null) {
      this.save();                                     // try again: the hold ends as soon as the file can be written
      if (this.saveError !== null) return { ok: false, reason: `auto-buy cap: ${AUTO_BUY_CAPS_FILENAME} could not be written (${this.saveError}); buys are held until it can` };
    }
    const u = this.usage(now);
    if (perHour > 0 && u.lastHour >= perHour) {
      return { ok: false, reason: `auto-buy cap: ${u.lastHour}/${perHour} buys in the last hour (AUTO_BUY_MAX_PER_HOUR)` };
    }
    if (perDay > 0 && u.lastDay >= perDay) {
      return { ok: false, reason: `auto-buy cap: ${u.lastDay}/${perDay} buys in the last 24h (AUTO_BUY_MAX_PER_DAY)` };
    }
    // Tiny epsilon so 0.1 + 0.2 style float sums never refuse an exact fill.
    if (solPerDay > 0 && u.solLastDay + solAmount > solPerDay + 1e-9) {
      return {
        ok: false,
        reason: `auto-buy cap: ${+u.solLastDay.toFixed(6)} SOL spent in the last 24h + ${solAmount} SOL would exceed ${solPerDay} SOL (AUTO_BUY_MAX_SOL_PER_DAY)`,
      };
    }
    return { ok: true };
  }

  record(solAmount: number, now: number = Date.now()): void {
    if (!(typeof solAmount === 'number' && Number.isFinite(solAmount) && solAmount >= 0)) return;
    this.buys.push({ ts: now, sol: solAmount });
    this.prune(now);
    this.save();
  }

  /** check() + an in-flight reservation, in the same synchronous tick (no await between them). */
  reserve(solAmount: number, now: number = Date.now()): { ok: true; token: number } | { ok: false; reason: string } {
    const c = this.check(solAmount, now);           // synchronous: check + insert happen in the same tick
    if (!c.ok) return c;
    const token = ++this.seq;
    this.pending.set(token, { ts: now, sol: solAmount });
    return { ok: true, token };
  }

  /** The reserved buy landed: record it (persisted). Unknown / already-settled token → no-op. */
  commit(token: number, now: number = Date.now()): void {
    const e = this.pending.get(token);
    if (!e) return;                                  // already committed or cancelled: no-op
    this.pending.delete(token);
    this.buys.push({ ts: now, sol: e.sol });
    this.prune(now);
    this.save();
  }

  /** The reserved buy never landed: release its slot. */
  cancel(token: number): void {
    this.pending.delete(token);
  }

  // ── A-114: the PILOT buys per UTC day ──

  /**
   * Pilot buys today (UTC): the persisted sends plus EVERY in-flight reservation, whatever day it was taken on. A reservation taken just
   * before 00:00 UTC is committed under the new day (pilotCommit stamps the send time), so it must count against the new day too.
   */
  pilotUsedToday(now: number = Date.now()): number {
    const start = utcDayStart(now);
    let n = this.pilotPending.size;
    for (const t of this.pilotSent) if (t >= start) n++;
    return n;
  }

  /** A pilot slot of today, held in memory until the buy is sent (pilotCommit) or not (pilotCancel). Same tick as the check. */
  pilotReserve(maxPerDay: number, now: number = Date.now()): { ok: true; token: number } | { ok: false; reason: string } {
    if (!(Number.isSafeInteger(maxPerDay) && maxPerDay > 0)) return { ok: false, reason: 'PILOT cap: AUTOBUY_PILOT_MAX_PER_DAY is not usable' };
    const used = this.pilotUsedToday(now);
    if (used >= maxPerDay) return { ok: false, reason: `PILOT cap: ${used}/${maxPerDay} pilot buys today (UTC, AUTOBUY_PILOT_MAX_PER_DAY)` };
    const token = ++this.seq;
    this.pilotPending.set(token, now);
    return { ok: true, token };
  }

  /**
   * The reserved pilot buy is about to be SENT: persist it first. Throws when the file cannot be written (the caller aborts the send; the
   * reservation stays held until pilotCancel). Unknown / already-committed token -> no-op.
   */
  pilotCommit(token: number, now: number = Date.now()): void {
    if (!this.pilotPending.has(token)) return;
    if (!this.file) throw new Error('PILOT cap: no caps file to record the pilot buy in');
    const start = utcDayStart(now);
    const next = [...this.pilotSent.filter(t => t >= start), now];
    writeFileAtomicSync(this.file, JSON.stringify(this.doc(next)));
    this.pilotSent = next;
    this.pilotPending.delete(token);
  }

  /** The reserved pilot buy was not sent: release its slot. */
  pilotCancel(token: number): void {
    this.pilotPending.delete(token);
  }

  private doc(pilotSent: number[] = this.pilotSent): Record<string, unknown> {
    return { v: 1, buys: this.buys, ...(this.lockedUntil !== null ? { locked_until: this.lockedUntil } : {}), ...(pilotSent.length > 0 ? { pilot_sent: pilotSent } : {}) };
  }

  private save(): void {
    if (!this.file) return;
    try {
      writeFileAtomicSync(this.file, JSON.stringify(this.doc()));
      this.saveError = null;
    } catch (e: any) {
      this.saveError = String(e?.message || e).slice(0, 200);
    }
  }
}

/** A-114: 00:00 UTC of the day `now` is in. */
function utcDayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

// ── Auto-buy limits: code defaults (B20 section 2; read-bot-interface 5.2 step 9) ──

/**
 * The code defaults of the rebuilt auto-buy. The env may LOWER a limit; a value above the default is accepted (the owner
 * typed it) but is reported in `deviations` so the caller logs it (it is never silent). Max open positions 5, SOL per day
 * 20 x buy size and the 15% impact cap are placeholders the owner confirms (user decision Y-5).
 */
export const AUTO_BUY_CODE_DEFAULTS = Object.freeze({
  perHour: 3,
  perDay: 20,
  maxOpen: 5,
  solPerDayMultiple: 20,
  reserveSol: 0.03,
});

export interface AutoBuyLimits {
  perHour: number;
  perDay: number;
  solPerDay: number;
  maxOpen: number;
  reserveSol: number;
  buySol: number;
}

export interface ResolvedAutoBuyLimits {
  limits: AutoBuyLimits;
  /** Env keys (or 'buy amount') whose value was unusable. The matching limit is NaN, which blocks auto-buy with a reason. */
  invalid: string[];
  /** Human-readable lines for every limit the env set above its code default. */
  deviations: string[];
}

/**
 * AUTO_BUY_MAX_PER_HOUR / _PER_DAY / _SOL_PER_DAY / _MAX_OPEN_POSITIONS / _RESERVE_SOL with the code defaults of
 * AUTO_BUY_CODE_DEFAULTS when unset or blank. `buySol` is the per-trade size (settings.signal.buyAmount); the SOL-per-day
 * default is 20 x buySol. An unusable value (NaN, <= 0, a fractional count) is NOT replaced by the default: the limit
 * becomes NaN, which the decision and AutoBuyCaps treat as "block auto-buy with a reason" (same fail-safe posture as the
 * legacy caps: someone who typed a cap wanted one). Pure.
 */
export function resolveAutoBuyLimits(
  env: Record<string, string | undefined>,
  buySol: unknown,
): ResolvedAutoBuyLimits {
  const invalid: string[] = [];
  const deviations: string[] = [];
  const D = AUTO_BUY_CODE_DEFAULTS;

  const positive = (name: string, dflt: number, integer: boolean): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return dflt;
    const n = toNumber(raw);
    if (n === null || !(n > 0) || (integer && !Number.isInteger(n))) {
      invalid.push(name);
      return NaN;
    }
    if (n > dflt) deviations.push(`${name}=${n} is above the code default ${dflt}`);
    return n;
  };

  const buy = parseSolAmount(buySol);
  if (buy === null) invalid.push('buy amount');
  const solDayDefault = buy === null ? NaN : D.solPerDayMultiple * buy;

  let solPerDay: number;
  const rawSolDay = env.AUTO_BUY_MAX_SOL_PER_DAY;
  if (rawSolDay === undefined || rawSolDay.trim() === '') {
    solPerDay = solDayDefault;
  } else {
    const n = toNumber(rawSolDay);
    if (n === null || !(n > 0)) {
      invalid.push('AUTO_BUY_MAX_SOL_PER_DAY');
      solPerDay = NaN;
    } else {
      solPerDay = n;
      if (Number.isFinite(solDayDefault) && n > solDayDefault) {
        deviations.push(`AUTO_BUY_MAX_SOL_PER_DAY=${n} is above the code default ${solDayDefault} (${D.solPerDayMultiple} x buy size)`);
      }
    }
  }

  let reserveSol: number;
  const rawReserve = env.AUTO_BUY_RESERVE_SOL;
  if (rawReserve === undefined || rawReserve.trim() === '') {
    reserveSol = D.reserveSol;
  } else {
    const n = toNumber(rawReserve);
    if (n === null || n < 0) {
      invalid.push('AUTO_BUY_RESERVE_SOL');
      reserveSol = NaN;
    } else {
      reserveSol = n;
      if (n < D.reserveSol) deviations.push(`AUTO_BUY_RESERVE_SOL=${n} is below the code default ${D.reserveSol}`);
    }
  }

  return {
    limits: {
      perHour: positive('AUTO_BUY_MAX_PER_HOUR', D.perHour, true),
      perDay: positive('AUTO_BUY_MAX_PER_DAY', D.perDay, true),
      solPerDay,
      maxOpen: positive('AUTO_BUY_MAX_OPEN_POSITIONS', D.maxOpen, true),
      reserveSol,
      buySol: buy === null ? NaN : buy,
    },
    invalid,
    deviations,
  };
}
