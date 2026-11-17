// R2-B2 (B20 sections 2-4): the guard pieces of the auto-buy that are not the decision itself:
//   - the env knobs (AUTOBUY_*) with their code defaults, and BOT_DRY_RUN;
//   - the buy ledger (one auto-buy per CA, ever; persisted B\data\autobuy-ledger.json, tmp + fsync + rename);
//   - the 10-buys-no-sell circuit breaker (in memory only: it clears on a restart, B20 section 3);
//   - the rolling-window rule behind `paused_rolling`;
//   - the one error-to-string rule (plan grind #64): redacted and at most 200 characters.
// No module here reads the wall clock or process.env: time arrives as an argument, the env as a record.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactSecrets } from '../lib/redact';
import { writeFileAtomicSync } from '../link/atomic-file';
import { AUTOBUY_STALE_MS } from './decide';

// ---------------------------------------------------------------------------------------------------------------------------------
// env knobs
// ---------------------------------------------------------------------------------------------------------------------------------

export const AUTOBUY_MAX_IMPACT_PCT_DEFAULT = 15;           // REBUILD-CHOSEN placeholder (user decision Y-5): the owner confirms it
export const AUTOBUY_PAUSE_AFTER_FAILS_DEFAULT = 3;
export const AUTOBUY_ROLLING_N_DEFAULT = 50;
export const AUTOBUY_ROLLING_MIN_NET_DEFAULT = -0.15;
export const BREAKER_MAX_BUYS_WITHOUT_SELL = 10;
export const BREAKER_NO_SELL_WINDOW_MS = 30 * 60_000;

export interface AutoBuyConfig {
  staleMs: number;
  maxImpactPct: number;
  pauseAfterFails: number;
  rollingN: number;
  rollingMinNet: number;
}

export interface AutoBuyConfigResult {
  config: AutoBuyConfig;
  /** Env keys whose value was unusable; the code default is used for them. */
  invalid: string[];
  /** Lines for every knob the env set on the looser side of its code default (logged, never silent). */
  deviations: string[];
}

function num(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t === '' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** AUTOBUY_STALE_MS, AUTOBUY_MAX_IMPACT_PCT, AUTOBUY_PAUSE_AFTER_FAILS, AUTOBUY_ROLLING_N, AUTOBUY_ROLLING_MIN_NET. Pure. */
export function autoBuyConfigFromEnv(env: Record<string, string | undefined>): AutoBuyConfigResult {
  const invalid: string[] = [];
  const deviations: string[] = [];
  const pick = (name: string, dflt: number, ok: (n: number) => boolean, looser: (n: number) => boolean): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return dflt;
    const n = num(raw);
    if (n === null || !ok(n)) { invalid.push(name); return dflt; }
    if (looser(n)) deviations.push(`${name}=${n} is looser than the code default ${dflt}`);
    return n;
  };
  return {
    config: {
      staleMs: pick('AUTOBUY_STALE_MS', AUTOBUY_STALE_MS, n => Number.isInteger(n) && n > 0, n => n > AUTOBUY_STALE_MS),
      maxImpactPct: pick('AUTOBUY_MAX_IMPACT_PCT', AUTOBUY_MAX_IMPACT_PCT_DEFAULT, n => n > 0 && n <= 100, n => n > AUTOBUY_MAX_IMPACT_PCT_DEFAULT),
      pauseAfterFails: pick('AUTOBUY_PAUSE_AFTER_FAILS', AUTOBUY_PAUSE_AFTER_FAILS_DEFAULT, n => Number.isInteger(n) && n >= 1, n => n > AUTOBUY_PAUSE_AFTER_FAILS_DEFAULT),
      rollingN: pick('AUTOBUY_ROLLING_N', AUTOBUY_ROLLING_N_DEFAULT, n => Number.isInteger(n) && n >= 1, () => false),
      rollingMinNet: pick('AUTOBUY_ROLLING_MIN_NET', AUTOBUY_ROLLING_MIN_NET_DEFAULT, n => n >= -1 && n < 0, n => n < AUTOBUY_ROLLING_MIN_NET_DEFAULT),
    },
    invalid,
    deviations,
  };
}

/** BOT_DRY_RUN: dry run unless the value is an explicit "off" word. Unset, blank or anything else means dry run (fail safe). */
export function dryRunFromEnv(env: Record<string, string | undefined>): boolean {
  const raw = env.BOT_DRY_RUN;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

/** plan grind #64: every error string is the redacted message, at most 200 characters, never a raw `e.message`. */
export function errText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message ?? e;
  return redactSecrets(String(msg)).slice(0, 200);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the buy ledger
// ---------------------------------------------------------------------------------------------------------------------------------

export const LEDGER_FILE = 'autobuy-ledger.json';

export interface LedgerEntry { at: number; signal_id: string; tx: string | null }

/**
 * One auto-buy per CA, ever. A CA is written BEFORE the send (inside onSigned, next to the in-flight journal), so a crash between the
 * send and the confirm can never lead to a second buy; a buy that failed on chain stays in the ledger (no second buy of that CA).
 * A dry-run buy never writes it. An unreadable file is moved aside (never deleted) and the ledger starts empty with `loadError` set.
 */
export class BuyLedger {
  private readonly file: string;
  private readonly cas = new Map<string, LedgerEntry>();
  /** Set when the file existed but could not be read; it was renamed to `<file>.corrupt-<n>`. */
  readonly loadError: string | null;

  constructor(dir: string) {
    this.file = path.join(dir, LEDGER_FILE);
    let loadError: string | null = null;
    if (fs.existsSync(this.file)) {
      try {
        const doc = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { v?: unknown; cas?: unknown };
        if (doc === null || typeof doc !== 'object' || doc.v !== 1 || typeof doc.cas !== 'object' || doc.cas === null || Array.isArray(doc.cas)) throw new Error('unexpected format');
        for (const [ca, e] of Object.entries(doc.cas as Record<string, unknown>)) {
          const x = e as { at?: unknown; signal_id?: unknown; tx?: unknown } | null;
          if (!x || typeof x.at !== 'number' || !Number.isFinite(x.at) || typeof x.signal_id !== 'string' || (x.tx !== null && typeof x.tx !== 'string')) throw new Error('bad entry');
          this.cas.set(ca, { at: x.at, signal_id: x.signal_id, tx: x.tx as string | null });
        }
      } catch (e) {
        this.cas.clear();
        loadError = errText(e);
        for (let i = 1; i < 1000; i++) {
          const aside = `${this.file}.corrupt-${i}`;
          if (fs.existsSync(aside)) continue;
          try { fs.renameSync(this.file, aside); } catch { /* the next atomic write replaces the file anyway */ }
          break;
        }
      }
    }
    this.loadError = loadError;
  }

  has(ca: string): boolean { return this.cas.has(ca); }
  size(): number { return this.cas.size; }

  /** Adds the CA and persists. Throws when the file cannot be written (the caller then sends nothing); the in-memory entry is rolled back. */
  add(ca: string, e: LedgerEntry): void {
    const had = this.cas.get(ca);
    this.cas.set(ca, e);
    try {
      this.persist();
    } catch (err) {
      if (had) this.cas.set(ca, had); else this.cas.delete(ca);
      throw err;
    }
  }

  /** Sets the transaction signature of an existing entry (best effort: the entry itself is what matters). */
  setTx(ca: string, tx: string): void {
    const e = this.cas.get(ca);
    if (!e || e.tx === tx) return;
    this.cas.set(ca, { ...e, tx });
    try { this.persist(); } catch { /* the CA is already recorded */ }
  }

  private persist(): void {
    writeFileAtomicSync(this.file, JSON.stringify({ v: 1, cas: Object.fromEntries(this.cas) }));
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the 10-buys-no-sell breaker (paused_breaker)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Port of the legacy bot.ts breaker (May 7 postmortem: 85 auto-buys, no sell): at least `maxBuys` buys landed and no sell succeeded
 * for more than `windowMs` trips it. It LATCHES until `clear` (the owner's /autobuy resume) or a restart: it is never persisted.
 * Only real (live) buys count. The wiring calls `noteSellOk` from the exit engine's successful sells.
 */
export class CircuitBreaker {
  private buysSinceSell = 0;
  private lastSellOkAt: number;
  private latched = false;
  private detail = '';

  constructor(startedAt: number, private readonly maxBuys = BREAKER_MAX_BUYS_WITHOUT_SELL, private readonly windowMs = BREAKER_NO_SELL_WINDOW_MS) {
    this.lastSellOkAt = startedAt;
  }

  noteBuyLanded(): void { this.buysSinceSell++; }

  noteSellOk(now: number): void {
    this.buysSinceSell = 0;
    this.lastSellOkAt = now;
  }

  /** Evaluates and latches. `justTripped` is true only on the call that trips it, so the owner is told once. */
  check(now: number): { tripped: boolean; justTripped: boolean; detail: string } {
    if (this.latched) return { tripped: true, justTripped: false, detail: this.detail };
    const noSellMs = now - this.lastSellOkAt;
    if (this.buysSinceSell >= this.maxBuys && noSellMs > this.windowMs) {
      this.latched = true;
      this.detail = `${this.buysSinceSell} buys and no successful sell in ${Math.round(noSellMs / 60_000)} min (the sell path may be broken)`;
      return { tripped: true, justTripped: true, detail: this.detail };
    }
    return { tripped: false, justTripped: false, detail: '' };
  }

  isTripped(): boolean { return this.latched; }

  clear(now: number): void {
    this.latched = false;
    this.detail = '';
    this.buysSinceSell = 0;
    this.lastSellOkAt = now;
  }

  counters(): { buysSinceSell: number; lastSellOkAt: number } { return { buysSinceSell: this.buysSinceSell, lastSellOkAt: this.lastSellOkAt }; }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// rolling window (paused_rolling)
// ---------------------------------------------------------------------------------------------------------------------------------

export interface RollingEntry { tx: string; net_per_sol_in: number; closed_at: number }

/** Mean net per SOL in over the entries (each closed trade is one SOL-in unit of the same size), or null with no entries. */
export function rollingMeanNet(rolling: readonly RollingEntry[]): number | null {
  if (rolling.length === 0) return null;
  let sum = 0;
  for (const r of rolling) sum += r.net_per_sol_in;
  return sum / rolling.length;
}

/** True when the window holds `n` closed real trades and their mean net per SOL in is below `minNet` (for example -0.15). */
export function rollingBreached(rolling: readonly RollingEntry[], n: number, minNet: number): boolean {
  if (rolling.length < n) return false;
  const mean = rollingMeanNet(rolling.slice(-n));
  return mean !== null && mean < minNet;
}

/**
 * net per SOL in of one closed position from verified numbers (decimal lamport strings): realized net / SOL spent.
 * null when either is missing, not an integer, or the SOL spent is not positive.
 */
export function netPerSolIn(realizedNetLamports: string | null, solSpentLamports: string | null): number | null {
  if (realizedNetLamports === null || solSpentLamports === null) return null;
  if (!/^-?\d+$/.test(realizedNetLamports) || !/^\d+$/.test(solSpentLamports)) return null;
  const spent = BigInt(solSpentLamports);
  if (spent <= 0n) return null;
  const v = Number(BigInt(realizedNetLamports)) / Number(spent);
  return Number.isFinite(v) ? v : null;
}
