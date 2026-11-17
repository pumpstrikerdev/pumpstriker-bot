/**
 * Unit tests for the trading-safety guards (2026-09-29 hardening, T6).
 * No network: addresses are generated locally or are well-known public mints.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import {
  validateCa, parseSolAmount, parsePercent, SETTING_RANGES, parseSetting, parseNonNegative,
  sanitizeKb, MAX_KB_BUTTONS, TOGGLE_FIELDS, isToggleAllowed, BuyLock, AutoBuyCaps,
  AUTO_BUY_CAPS_FILENAME, resolveAutoBuyLimits, AUTO_BUY_CODE_DEFAULTS,
} from './trade-guards';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const T0   = Date.UTC(2026, 8, 29, 12, 0, 0);
const MIN  = 60_000;
const HOUR = 60 * MIN;

describe('validateCa', () => {
  it('accepts real 32-byte base58 addresses (and trims whitespace)', () => {
    const generated = Keypair.generate().publicKey.toBase58();
    expect(validateCa(generated)).toBe(generated);
    expect(validateCa(USDC)).toBe(USDC);
    expect(validateCa(WSOL)).toBe(WSOL);
    expect(validateCa(`  ${USDC}\n`)).toBe(USDC);
  });

  it('rejects non-base58, wrong lengths and wrong decoded sizes', () => {
    const sig88 = bs58.encode(crypto.randomBytes(64));          // tx signature / secret-key shape
    const short = bs58.encode(Buffer.alloc(31, 0xff));          // passes the regex, decodes to 31 bytes
    expect(short.length).toBeGreaterThanOrEqual(32);
    expect(short.length).toBeLessThanOrEqual(44);
    for (const bad of [
      '__proto__', 'constructor', '', '   ', 'PEPE', '$PEPE', sig88, short,
      USDC.slice(0, 31), `${USDC}x`, USDC.replace('E', '0'), USDC.replace('E', 'O'),
      USDC.replace('E', 'I'), USDC.replace('E', 'l'), `${USDC.slice(0, 20)}:${USDC.slice(21)}`,
      `https://dexscreener.com/solana/${USDC}`,
    ]) {
      expect(validateCa(bad)).toBeNull();
    }
  });

  it('rejects non-strings', () => {
    for (const bad of [undefined, null, 123, {}, [], ['x'], true]) expect(validateCa(bad)).toBeNull();
  });
});

describe('parseSolAmount', () => {
  it('accepts finite positive amounts', () => {
    expect(parseSolAmount('0.5')).toBe(0.5);
    expect(parseSolAmount(' 1 ')).toBe(1);
    expect(parseSolAmount('.25')).toBe(0.25);
    expect(parseSolAmount(0.01)).toBe(0.01);
    expect(parseSolAmount('1e-3')).toBe(0.001);
  });

  it('refuses NaN, Infinity, negatives, zero and garbage (no silent default)', () => {
    for (const bad of [
      'NaN', NaN, 'Infinity', Infinity, -Infinity, '-1', -0.5, '0', 0, '', '   ', 'abc', '0.5abc',
      '1O', '0x10', '1,5', undefined, null, {}, '1'.repeat(400), '1e400',
    ]) {
      expect(parseSolAmount(bad)).toBeNull();
    }
  });

  it('enforces min (default 1 lamport) and max', () => {
    expect(parseSolAmount('0.0000000001')).toBeNull();           // < 1 lamport
    expect(parseSolAmount('0.000000001')).toBe(1e-9);
    expect(parseSolAmount('2', { max: 1 })).toBeNull();          // above max
    expect(parseSolAmount('1', { max: 1 })).toBe(1);             // max inclusive
    expect(parseSolAmount('0.05', { min: 0.1 })).toBeNull();
    expect(parseSolAmount('1000000')).toBe(1_000_000);           // no default upper cap (decision #5)
  });
});

describe('parsePercent', () => {
  it('accepts integers 1–100, with or without a trailing %', () => {
    expect(parsePercent('1')).toBe(1);
    expect(parsePercent('50')).toBe(50);
    expect(parsePercent('50%')).toBe(50);
    expect(parsePercent(' 100 ')).toBe(100);
    expect(parsePercent(25)).toBe(25);
  });

  it('refuses garbage instead of defaulting to 100', () => {
    for (const bad of ['1OO', 'l00', '0', '101', '-5', '50.5', '', 'all', 'max', undefined, null, NaN, '100%%']) {
      expect(parsePercent(bad)).toBeNull();
    }
  });
});

describe('parseSetting (range checks)', () => {
  it('exposes the spec ranges', () => {
    expect(SETTING_RANGES.slippageBps).toEqual([10, 5000]);
    expect(SETTING_RANGES.priorityFee).toEqual([0, 5_000_000]);
    expect(SETTING_RANGES.retryMaxAttempts).toEqual([1, 5]);
    expect(SETTING_RANGES.smartSlippageMax).toEqual([10, 5000]);
  });

  it('slippage: percent input → bps, limited to 0.1–50%', () => {
    expect(parseSetting('slippageBps', '3')).toBe(300);
    expect(parseSetting('slippageBps', '3%')).toBe(300);
    expect(parseSetting('slippageBps', '0.1')).toBe(10);
    expect(parseSetting('slippageBps', '50')).toBe(5000);
    expect(parseSetting('smartSlippageMax', '15')).toBe(1500);
    for (const bad of ['0.05', '0', '50.5', '-3', 'abc', '', 'NaN', 'Infinity']) {
      expect(parseSetting('slippageBps', bad)).toBeNull();
      expect(parseSetting('smartSlippageMax', bad)).toBeNull();
    }
  });

  it('priority fee: integer 0–5,000,000', () => {
    expect(parseSetting('priorityFee', '0')).toBe(0);
    expect(parseSetting('priorityFee', '100000')).toBe(100_000);
    expect(parseSetting('priorityFee', '5000000')).toBe(5_000_000);
    for (const bad of ['5000001', '-1', '1.5', 'abc', '']) expect(parseSetting('priorityFee', bad)).toBeNull();
  });

  it('retries: integer 1–5', () => {
    expect(parseSetting('retryMaxAttempts', '1')).toBe(1);
    expect(parseSetting('retryMaxAttempts', '5')).toBe(5);
    for (const bad of ['0', '6', '2.5', '-1', 'x']) expect(parseSetting('retryMaxAttempts', bad)).toBeNull();
  });

  it('unknown / forged fields are refused', () => {
    expect(parseSetting('__proto__' as any, '1')).toBeNull();
    expect(parseSetting('constructor' as any, '1')).toBeNull();
    expect(parseSetting('buyAmount' as any, '1')).toBeNull();
  });

  it('parseNonNegative: finite >= 0 only', () => {
    expect(parseNonNegative('0')).toBe(0);
    expect(parseNonNegative('25000')).toBe(25_000);
    expect(parseNonNegative('25%')).toBe(25);
    for (const bad of ['-1', 'abc', '', 'NaN', 'Infinity']) expect(parseNonNegative(bad)).toBeNull();
  });
});

describe('sanitizeKb', () => {
  it('cleans a buy keyboard and caps it at 8 buttons', () => {
    expect(sanitizeKb('0.1, 0.5,1'.split(','), 'buy')).toEqual([0.1, 0.5, 1]);
    expect(sanitizeKb(['0.1', 'abc', '-1', '0', 'NaN', '2'], 'buy')).toEqual([0.1, 2]);
    const many = Array.from({ length: 12 }, (_, i) => String(i + 1));
    expect(sanitizeKb(many, 'buy')).toHaveLength(MAX_KB_BUTTONS);
    expect(sanitizeKb(many, 'buy')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('drops buy buttons whose callback_data would exceed 64 bytes', () => {
    const ca = Keypair.generate().publicKey.toBase58();
    const kb = sanitizeKb(['0.1', '0.123456789012345', '0.30000000000000004'], 'buy', ca);
    expect(kb).toContain(0.1);
    for (const a of kb) expect(Buffer.byteLength(`buy:${ca}:${a}`, 'utf8')).toBeLessThanOrEqual(64);
    // 'buy:' + 44-char CA + ':' = 49 bytes → amount string must be <= 15 chars.
    expect(sanitizeKb(['0.30000000000000004'], 'buy')).toEqual([]);     // worst-case CA when none given
    expect(sanitizeKb(['0.1234567890123'], 'buy')).toEqual([0.1234567890123]);   // 15 chars → exactly 64 bytes
    expect(sanitizeKb(['0.12345678901234'], 'buy')).toEqual([]);                 // 16 chars → 65 bytes
  });

  it('cleans a sell keyboard to integer percents 1–100', () => {
    expect(sanitizeKb('25,50,75,100'.split(','), 'sell')).toEqual([25, 50, 75, 100]);
    expect(sanitizeKb(['0', '101', '1OO', '33.3', '50%', 'x'], 'sell')).toEqual([50]);
    expect(sanitizeKb(Array.from({ length: 10 }, (_, i) => String(i + 1)), 'sell')).toHaveLength(MAX_KB_BUTTONS);
  });

  it('accepts stored numeric arrays and refuses junk inputs', () => {
    expect(sanitizeKb([0.1, 0.5, 1], 'buy')).toEqual([0.1, 0.5, 1]);
    expect(sanitizeKb(null as any, 'buy')).toEqual([]);
    expect(sanitizeKb(['1'], 'other' as any)).toEqual([]);
  });
});

describe('toggle whitelist', () => {
  it('allows only the menu buttons', () => {
    expect(isToggleAllowed('buy', 'confirmManualBuy')).toBe(true);
    expect(isToggleAllowed('buy', 'retryOnSlippage')).toBe(true);
    expect(isToggleAllowed('sell', 'autoPnlCard')).toBe(true);
    expect(isToggleAllowed('glob', 'antiMev')).toBe(true);
    expect(isToggleAllowed('signal', 'autoSellOnSignal')).toBe(true);
    expect(isToggleAllowed('buy', 'antiMev')).toBe(false);          // right field, wrong menu
  });

  it('refuses prototype keys, unknown fields and unknown menus', () => {
    for (const menu of Object.keys(TOGGLE_FIELDS) as Array<keyof typeof TOGGLE_FIELDS>) {
      for (const bad of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'slippageBps', 'buyKb', '', 'unknownField']) {
        expect(isToggleAllowed(menu, bad)).toBe(false);
      }
    }
    expect(isToggleAllowed('__proto__' as any, 'antiMev')).toBe(false);
    expect(isToggleAllowed('constructor' as any, 'name')).toBe(false);
    expect(isToggleAllowed('glob', undefined as any)).toBe(false);
  });

  it('whitelist cannot be mutated at runtime', () => {
    expect(Object.isFrozen(TOGGLE_FIELDS)).toBe(true);
    expect(Object.isFrozen(TOGGLE_FIELDS.glob)).toBe(true);
    expect(() => (TOGGLE_FIELDS.glob as string[]).push('__proto__')).toThrow();
  });
});

describe('BuyLock', () => {
  it('blocks a second buy of the same wallet+CA until released', () => {
    const lock = new BuyLock();
    expect(lock.acquire('w1', USDC, T0)).toBe(true);
    expect(lock.acquire('w1', USDC, T0 + 1000)).toBe(false);       // double tap
    expect(lock.isHeld('w1', USDC, T0 + 1000)).toBe(true);
    expect(lock.acquire('w2', USDC, T0)).toBe(true);               // other wallet: independent
    expect(lock.acquire('w1', WSOL, T0)).toBe(true);               // other token: independent
    lock.release('w1', USDC);
    expect(lock.isHeld('w1', USDC, T0 + 2000)).toBe(false);
    expect(lock.acquire('w1', USDC, T0 + 2000)).toBe(true);
  });

  it('release in finally frees the lock even when the buy throws', async () => {
    const lock = new BuyLock();
    const buy = async () => {
      if (!lock.acquire('w1', USDC)) throw new Error('locked');
      try { throw new Error('swap failed'); } finally { lock.release('w1', USDC); }
    };
    await expect(buy()).rejects.toThrow('swap failed');
    expect(lock.acquire('w1', USDC)).toBe(true);
  });

  it('a stale lock (older than maxHoldMs) can be re-acquired', () => {
    const lock = new BuyLock(60_000);
    expect(lock.acquire('w1', USDC, T0)).toBe(true);
    expect(lock.acquire('w1', USDC, T0 + 59_999)).toBe(false);
    expect(lock.acquire('w1', USDC, T0 + 60_000)).toBe(true);
  });
});

describe('AutoBuyCaps', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-guards-'));
    file = path.join(dir, 'data', AUTO_BUY_CAPS_FILENAME);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('0 = no cap (off by default)', () => {
    const caps = new AutoBuyCaps(file, { perHour: 0, perDay: 0, solPerDay: 0 });
    expect(caps.enabled).toBe(false);
    for (let i = 0; i < 50; i++) {
      expect(caps.check(5, T0 + i)).toEqual({ ok: true });
      caps.record(5, T0 + i);
    }
  });

  it('per-hour cap uses a rolling 60-minute window', () => {
    const caps = new AutoBuyCaps(file, { perHour: 3, perDay: 0, solPerDay: 0 });
    for (let i = 0; i < 3; i++) { expect(caps.check(0.1, T0 + i * MIN).ok).toBe(true); caps.record(0.1, T0 + i * MIN); }
    const r = caps.check(0.1, T0 + 10 * MIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/3\/3 buys in the last hour/);
    expect(caps.check(0.1, T0 + HOUR - 1).ok).toBe(false);          // all 3 still inside the last 60 min
    expect(caps.check(0.1, T0 + HOUR).ok).toBe(true);               // first buy exactly 60 min ago → out of the window
  });

  it('per-day cap uses a rolling 24h window', () => {
    const caps = new AutoBuyCaps(file, { perHour: 0, perDay: 2, solPerDay: 0 });
    caps.record(0.1, T0);
    caps.record(0.1, T0 + 2 * HOUR);
    const r = caps.check(0.1, T0 + 5 * HOUR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/AUTO_BUY_MAX_PER_DAY/);
    expect(caps.check(0.1, T0 + 24 * HOUR + 1).ok).toBe(true);     // first one aged out
  });

  it('SOL-per-day cap counts the pending buy', () => {
    const caps = new AutoBuyCaps(file, { perHour: 0, perDay: 0, solPerDay: 1 });
    caps.record(0.4, T0);
    caps.record(0.4, T0 + MIN);
    expect(caps.check(0.2, T0 + 2 * MIN).ok).toBe(true);             // exactly 1.0 allowed
    const r = caps.check(0.25, T0 + 2 * MIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/AUTO_BUY_MAX_SOL_PER_DAY/);
    expect(caps.usage(T0 + 2 * MIN)).toEqual({ lastHour: 2, lastDay: 2, solLastDay: 0.8 });
    expect(caps.check(0.25, T0 + 24 * HOUR + 1).ok).toBe(true);     // first 0.4 aged out
  });

  it('counters persist across a new instance (restart)', () => {
    const a = new AutoBuyCaps(file, { perHour: 2, perDay: 0, solPerDay: 0 });
    a.record(0.1, T0);
    a.record(0.1, T0 + MIN);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    const b = new AutoBuyCaps(file, { perHour: 2, perDay: 0, solPerDay: 0 });
    expect(b.loadError).toBeNull();
    expect(b.check(0.1, T0 + 2 * MIN).ok).toBe(false);
    expect(b.usage(T0 + 2 * MIN).lastHour).toBe(2);
  });

  it('prunes entries older than 24h from the persisted file', () => {
    const a = new AutoBuyCaps(file, { perHour: 0, perDay: 0, solPerDay: 0 });
    a.record(0.1, T0);
    a.record(0.1, T0 + 25 * HOUR);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.buys).toEqual([{ ts: T0 + 25 * HOUR, sol: 0.1 }]);
  });

  it('a corrupt file starts empty and reports loadError', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    const caps = new AutoBuyCaps(file, { perHour: 1, perDay: 0, solPerDay: 0 });
    expect(caps.loadError).toBeTruthy();
    expect(caps.check(0.1, T0).ok).toBe(false);                       // A-93f: fail safe, never zero usage
  });

  it('refuses invalid buy amounts and fails SAFE on invalid limits', () => {
    const off = new AutoBuyCaps(file, { perHour: 0, perDay: 0, solPerDay: 0 });
    expect(off.check(NaN, T0).ok).toBe(false);
    expect(off.check(0, T0).ok).toBe(false);
    expect(off.check(-1, T0).ok).toBe(false);
    const bad = new AutoBuyCaps(file, { perHour: NaN, perDay: 0, solPerDay: 0 });
    expect(bad.enabled).toBe(true);
    const r = bad.check(0.1, T0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/AUTO_BUY_MAX_PER_HOUR is invalid/);
    expect(new AutoBuyCaps(file, { perHour: 0, perDay: 2.5, solPerDay: 0 }).check(0.1, T0).ok).toBe(false);
    expect(new AutoBuyCaps(file, { perHour: 0, perDay: 0, solPerDay: -1 }).check(0.1, T0).ok).toBe(false);
  });

  it('record ignores invalid amounts', () => {
    const caps = new AutoBuyCaps(file, { perHour: 1, perDay: 0, solPerDay: 0 });
    caps.record(NaN, T0);
    caps.record(-1, T0);
    expect(caps.check(0.1, T0 + 1).ok).toBe(true);
  });

  // Final review fixes: concurrent auto-buys reserve their slot before the buy.
  it('reserve: an in-flight reservation counts, so a back-to-back second reserve is refused', () => {
    const caps = new AutoBuyCaps(file, { perHour: 1, perDay: 0, solPerDay: 0 });
    const a = caps.reserve(0.1, T0);
    expect(a.ok).toBe(true);
    const b = caps.reserve(0.1, T0);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toMatch(/1\/1 buys in the last hour/);
    expect(caps.usage(T0)).toEqual({ lastHour: 1, lastDay: 1, solLastDay: 0.1 });
  });

  it('cancel releases the slot; reserve succeeds again', () => {
    const caps = new AutoBuyCaps(file, { perHour: 1, perDay: 0, solPerDay: 0 });
    const a = caps.reserve(0.1, T0);
    if (!a.ok) throw new Error('expected a reservation');
    caps.cancel(a.token);
    expect(caps.usage(T0)).toEqual({ lastHour: 0, lastDay: 0, solLastDay: 0 });
    expect(caps.reserve(0.1, T0 + 1).ok).toBe(true);
    expect(fs.existsSync(file)).toBe(false);                         // nothing persisted for a cancelled buy
  });

  it('commit records the buy (persisted); cancel after commit is a no-op', () => {
    const caps = new AutoBuyCaps(file, { perHour: 1, perDay: 0, solPerDay: 0 });
    const a = caps.reserve(0.1, T0);
    if (!a.ok) throw new Error('expected a reservation');
    caps.commit(a.token, T0 + 5);
    expect(caps.usage(T0 + 5).lastHour).toBe(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).buys).toEqual([{ ts: T0 + 5, sol: 0.1 }]);
    caps.cancel(a.token);                                            // no-op: already settled
    caps.commit(a.token, T0 + 6);                                    // no-op: no double count
    expect(caps.usage(T0 + 6)).toEqual({ lastHour: 1, lastDay: 1, solLastDay: 0.1 });
    expect(caps.reserve(0.1, T0 + 7).ok).toBe(false);
    // a restart sees the committed buy
    expect(new AutoBuyCaps(file, { perHour: 1, perDay: 0, solPerDay: 0 }).check(0.1, T0 + 8).ok).toBe(false);
  });

  it('SOL-per-day: a pending reservation counts toward the budget', () => {
    const caps = new AutoBuyCaps(file, { perHour: 0, perDay: 0, solPerDay: 0.15 });
    expect(caps.reserve(0.1, T0).ok).toBe(true);
    const r = caps.reserve(0.1, T0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/AUTO_BUY_MAX_SOL_PER_DAY/);
  });

  it('per-day cap counts pending reservations too', () => {
    const caps = new AutoBuyCaps(file, { perHour: 0, perDay: 2, solPerDay: 0 });
    caps.record(0.1, T0);
    expect(caps.reserve(0.1, T0 + MIN).ok).toBe(true);
    expect(caps.reserve(0.1, T0 + 2 * MIN).ok).toBe(false);
  });
});

describe('resolveAutoBuyLimits (the code defaults of the rebuilt auto-buy, B20)', () => {
  it('B2-T04 with the env unset the caps are 3 per hour and 20 per day, and both are enforced', () => {
    const r = resolveAutoBuyLimits({}, 0.01);
    expect(r.limits.perHour).toBe(3);
    expect(r.limits.perDay).toBe(20);
    expect(r.limits.maxOpen).toBe(5);
    expect(r.limits.reserveSol).toBe(0.03);
    expect(r.limits.buySol).toBe(0.01);
    expect(r.limits.solPerDay).toBeCloseTo(0.2, 12);            // 20 x the buy size
    expect(r.invalid).toEqual([]);
    expect(r.deviations).toEqual([]);

    // 3 per hour: the 4th buy inside the hour is refused, with the env name in the reason
    const hourly = new AutoBuyCaps('', r.limits);
    for (let i = 0; i < 3; i++) {
      const res = hourly.reserve(0.01, T0 + i * MIN);
      expect(res.ok).toBe(true);
      if (res.ok) hourly.commit(res.token, T0 + i * MIN);
    }
    const fourth = hourly.reserve(0.01, T0 + 3 * MIN);
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.reason).toMatch(/3\/3 buys in the last hour \(AUTO_BUY_MAX_PER_HOUR\)/);
    expect(hourly.reserve(0.01, T0 + HOUR + 4 * MIN).ok).toBe(true);   // the hour has passed

    // 20 per day: 20 buys 70 minutes apart never trip the hourly cap, and the 21st inside 24 h is refused
    const daily = new AutoBuyCaps('', r.limits);
    for (let i = 0; i < 20; i++) {
      const res = daily.reserve(0.01, T0 + i * 70 * MIN);
      expect(res.ok, `buy ${i + 1}`).toBe(true);
      if (res.ok) daily.commit(res.token, T0 + i * 70 * MIN);
    }
    const twentyFirst = daily.reserve(0.01, T0 + 20 * 70 * MIN);
    expect(twentyFirst.ok).toBe(false);
    if (!twentyFirst.ok) expect(twentyFirst.reason).toMatch(/20\/20 buys in the last 24h \(AUTO_BUY_MAX_PER_DAY\)/);
    expect(daily.reserve(0.01, T0 + 24 * HOUR + MIN).ok).toBe(true);   // the first buy left the 24 h window
  });

  it('lets the env lower a limit without comment and reports every raise as a deviation', () => {
    const lower = resolveAutoBuyLimits({ AUTO_BUY_MAX_PER_HOUR: '1', AUTO_BUY_MAX_PER_DAY: '5', AUTO_BUY_MAX_OPEN_POSITIONS: '2', AUTO_BUY_MAX_SOL_PER_DAY: '0.05', AUTO_BUY_RESERVE_SOL: '0.5' }, 0.01);
    expect(lower.limits).toEqual({ perHour: 1, perDay: 5, solPerDay: 0.05, maxOpen: 2, reserveSol: 0.5, buySol: 0.01 });
    expect(lower.deviations).toEqual([]);
    const raise = resolveAutoBuyLimits({ AUTO_BUY_MAX_PER_HOUR: '10', AUTO_BUY_MAX_PER_DAY: '100', AUTO_BUY_MAX_OPEN_POSITIONS: '9', AUTO_BUY_MAX_SOL_PER_DAY: '5', AUTO_BUY_RESERVE_SOL: '0.01' }, 0.01);
    expect(raise.limits).toMatchObject({ perHour: 10, perDay: 100, maxOpen: 9, solPerDay: 5, reserveSol: 0.01 });
    expect(raise.invalid).toEqual([]);
    expect(raise.deviations).toHaveLength(5);
    expect(raise.deviations.join('\n')).toMatch(/AUTO_BUY_MAX_PER_HOUR=10 is above the code default 3/);
    expect(raise.deviations.join('\n')).toMatch(/AUTO_BUY_RESERVE_SOL=0.01 is below the code default 0.03/);
  });

  it('follows the buy size for the SOL budget and treats a blank value as unset', () => {
    expect(resolveAutoBuyLimits({}, 0.05).limits.solPerDay).toBeCloseTo(1, 12);
    expect(resolveAutoBuyLimits({ AUTO_BUY_MAX_PER_HOUR: '', AUTO_BUY_MAX_SOL_PER_DAY: '  ' }, 0.1).limits).toMatchObject({ perHour: 3, solPerDay: 2 });
    expect(resolveAutoBuyLimits({ AUTO_BUY_MAX_SOL_PER_DAY: '1.5' }, 0.05).deviations).toHaveLength(1);
  });

  it('an unusable value is never replaced by a default: the limit becomes NaN, is named, and blocks auto-buy', () => {
    for (const bad of ['0', '-1', '2.5', 'x', '1e', 'NaN']) {
      const r = resolveAutoBuyLimits({ AUTO_BUY_MAX_PER_HOUR: bad }, 0.01);
      expect(Number.isNaN(r.limits.perHour), bad).toBe(true);
      expect(r.invalid, bad).toEqual(['AUTO_BUY_MAX_PER_HOUR']);
      expect(new AutoBuyCaps('', r.limits).check(0.01, T0).ok, bad).toBe(false);
    }
    const sol = resolveAutoBuyLimits({ AUTO_BUY_MAX_SOL_PER_DAY: '0', AUTO_BUY_RESERVE_SOL: '-0.1', AUTO_BUY_MAX_OPEN_POSITIONS: '1.5' }, 0.01);
    expect(sol.invalid.sort()).toEqual(['AUTO_BUY_MAX_OPEN_POSITIONS', 'AUTO_BUY_MAX_SOL_PER_DAY', 'AUTO_BUY_RESERVE_SOL']);
    expect(Number.isNaN(sol.limits.solPerDay) && Number.isNaN(sol.limits.reserveSol) && Number.isNaN(sol.limits.maxOpen)).toBe(true);
    // a buy amount that is not a SOL amount poisons the amount and the budget that follows it
    const noBuy = resolveAutoBuyLimits({}, 'abc');
    expect(noBuy.invalid).toEqual(['buy amount']);
    expect(Number.isNaN(noBuy.limits.buySol) && Number.isNaN(noBuy.limits.solPerDay)).toBe(true);
    expect(resolveAutoBuyLimits({}, 0).invalid).toEqual(['buy amount']);
  });

  it('the code defaults are constants, and the old "unset = no cap" env reader is gone', async () => {
    expect(AUTO_BUY_CODE_DEFAULTS).toEqual({ perHour: 3, perDay: 20, maxOpen: 5, solPerDayMultiple: 20, reserveSol: 0.03 });
    expect(Object.isFrozen(AUTO_BUY_CODE_DEFAULTS)).toBe(true);
    const exported = Object.keys(await import('./trade-guards'));
    expect(exported).not.toContain('autoBuyCapLimitsFromEnv');
    expect(exported).not.toContain('filterBlocksOnMissing');
  });

  it('setLimits swaps the limits and keeps the counters', () => {
    const caps = new AutoBuyCaps('', { perHour: 1, perDay: 0, solPerDay: 0 });
    caps.record(0.1, T0);
    expect(caps.check(0.1, T0 + MIN).ok).toBe(false);
    caps.setLimits({ perHour: 5, perDay: 0, solPerDay: 0 });
    expect(caps.getLimits()).toEqual({ perHour: 5, perDay: 0, solPerDay: 0 });
    expect(caps.check(0.1, T0 + MIN).ok).toBe(true);
    expect(caps.usage(T0 + MIN).lastHour).toBe(1);
    caps.setLimits({ perHour: Number.NaN, perDay: 0, solPerDay: 0 });         // invalid fails safe, like the constructor
    expect(caps.check(0.1, T0 + MIN).ok).toBe(false);
  });
});
