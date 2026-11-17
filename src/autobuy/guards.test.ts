/**
 * The guard pieces of the auto-buy: env knobs, the redacted error string, the buy ledger, the 10-buys-no-sell breaker and the rolling
 * window. Every file test uses its own temp folder.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, tempDir } from '../link/link-testkit';
import { AUTOBUY_STALE_MS } from './decide';
import {
  autoBuyConfigFromEnv, AUTOBUY_MAX_IMPACT_PCT_DEFAULT, AUTOBUY_PAUSE_AFTER_FAILS_DEFAULT, AUTOBUY_ROLLING_MIN_NET_DEFAULT, AUTOBUY_ROLLING_N_DEFAULT,
  BREAKER_MAX_BUYS_WITHOUT_SELL, BREAKER_NO_SELL_WINDOW_MS, BuyLedger, CircuitBreaker, dryRunFromEnv, errText, LEDGER_FILE, netPerSolIn, rollingBreached,
  rollingMeanNet, type RollingEntry,
} from './guards';

afterAll(() => { cleanupTempDirs(); });

describe('autoBuyConfigFromEnv', () => {
  it('uses the code defaults when the env is empty', () => {
    const r = autoBuyConfigFromEnv({});
    expect(r.config).toEqual({
      staleMs: AUTOBUY_STALE_MS, maxImpactPct: AUTOBUY_MAX_IMPACT_PCT_DEFAULT, pauseAfterFails: AUTOBUY_PAUSE_AFTER_FAILS_DEFAULT,
      rollingN: AUTOBUY_ROLLING_N_DEFAULT, rollingMinNet: AUTOBUY_ROLLING_MIN_NET_DEFAULT,
    });
    expect(r.config).toMatchObject({ staleMs: 5000, maxImpactPct: 15, pauseAfterFails: 3, rollingN: 50, rollingMinNet: -0.15 });
    expect(r.invalid).toEqual([]);
    expect(r.deviations).toEqual([]);
    expect(autoBuyConfigFromEnv({ AUTOBUY_STALE_MS: '  ', AUTOBUY_MAX_IMPACT_PCT: '' }).invalid).toEqual([]);
  });

  it('lets the env lower a limit silently and reports every raise as a deviation', () => {
    const lower = autoBuyConfigFromEnv({ AUTOBUY_STALE_MS: '2000', AUTOBUY_MAX_IMPACT_PCT: '5', AUTOBUY_PAUSE_AFTER_FAILS: '2', AUTOBUY_ROLLING_MIN_NET: '-0.1' });
    expect(lower.config).toMatchObject({ staleMs: 2000, maxImpactPct: 5, pauseAfterFails: 2, rollingMinNet: -0.1 });
    expect(lower.deviations).toEqual([]);
    const raise = autoBuyConfigFromEnv({ AUTOBUY_STALE_MS: '9000', AUTOBUY_MAX_IMPACT_PCT: '30', AUTOBUY_PAUSE_AFTER_FAILS: '9', AUTOBUY_ROLLING_MIN_NET: '-0.5' });
    expect(raise.config).toMatchObject({ staleMs: 9000, maxImpactPct: 30, pauseAfterFails: 9, rollingMinNet: -0.5 });
    expect(raise.deviations).toHaveLength(4);
    for (const d of raise.deviations) expect(d).toMatch(/looser than the code default/);
  });

  it('refuses unusable values and keeps the code default for them', () => {
    const r = autoBuyConfigFromEnv({
      AUTOBUY_STALE_MS: 'soon', AUTOBUY_MAX_IMPACT_PCT: '0', AUTOBUY_PAUSE_AFTER_FAILS: '1.5', AUTOBUY_ROLLING_N: '-3', AUTOBUY_ROLLING_MIN_NET: '0.2',
    });
    expect(r.invalid.sort()).toEqual(['AUTOBUY_MAX_IMPACT_PCT', 'AUTOBUY_PAUSE_AFTER_FAILS', 'AUTOBUY_ROLLING_MIN_NET', 'AUTOBUY_ROLLING_N', 'AUTOBUY_STALE_MS']);
    expect(r.config.staleMs).toBe(AUTOBUY_STALE_MS);
    expect(r.config.maxImpactPct).toBe(15);
    expect(autoBuyConfigFromEnv({ AUTOBUY_MAX_IMPACT_PCT: '101' }).invalid).toEqual(['AUTOBUY_MAX_IMPACT_PCT']);
    expect(autoBuyConfigFromEnv({ AUTOBUY_STALE_MS: '0x10' }).invalid).toEqual(['AUTOBUY_STALE_MS']);
  });
});

describe('dryRunFromEnv', () => {
  it('is a dry run unless the value is an explicit off word', () => {
    expect(dryRunFromEnv({})).toBe(true);
    expect(dryRunFromEnv({ BOT_DRY_RUN: '' })).toBe(true);
    expect(dryRunFromEnv({ BOT_DRY_RUN: '1' })).toBe(true);
    expect(dryRunFromEnv({ BOT_DRY_RUN: 'true' })).toBe(true);
    expect(dryRunFromEnv({ BOT_DRY_RUN: 'maybe' })).toBe(true);
    for (const off of ['0', 'false', 'FALSE', 'no', 'off', ' 0 ']) expect(dryRunFromEnv({ BOT_DRY_RUN: off }), off).toBe(false);
  });
});

describe('errText', () => {
  it('redacts, caps at 200 characters and never needs a raw message', () => {
    expect(errText(new Error('rpc said api-key=SECRETVALUE123 to us'))).not.toContain('SECRETVALUE123');
    expect(errText('https://x.example/path?api-key=SECRETVALUE456&b=1')).not.toContain('SECRETVALUE456');
    expect(errText(new Error('x'.repeat(500))).length).toBe(200);
    expect(errText('plain text')).toBe('plain text');
    expect(errText(undefined)).toBe('undefined');
    expect(errText(null)).toBe('null');
    expect(errText({ message: 'from a message field' })).toBe('from a message field');
  });
});

describe('BuyLedger', () => {
  it('remembers a CA across a restart and writes through a tmp file that is renamed away', () => {
    const dir = tempDir('ps-b2g-');
    const l = new BuyLedger(dir);
    expect(l.has('CA1')).toBe(false);
    l.add('CA1', { at: 10, signal_id: 'dec_1', tx: null });
    l.setTx('CA1', 'sig-1');
    expect(l.has('CA1')).toBe(true);
    expect(l.size()).toBe(1);
    expect(fs.readdirSync(dir).filter(n => n.endsWith('.tmp'))).toEqual([]);
    const again = new BuyLedger(dir);
    expect(again.has('CA1')).toBe(true);
    expect(again.has('CA2')).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, LEDGER_FILE), 'utf8'))).toEqual({ v: 1, cas: { CA1: { at: 10, signal_id: 'dec_1', tx: 'sig-1' } } });
  });

  it('moves an unreadable file aside, starts empty and says why', () => {
    for (const text of ['{ nope', JSON.stringify({ v: 2, cas: {} }), JSON.stringify({ v: 1, cas: { CA1: { at: 'x' } } })]) {
      const dir = tempDir('ps-b2g-');
      fs.writeFileSync(path.join(dir, LEDGER_FILE), text);
      const l = new BuyLedger(dir);
      expect(l.size()).toBe(0);
      expect(l.loadError).not.toBeNull();
      expect(fs.readdirSync(dir).some(n => n.startsWith(`${LEDGER_FILE}.corrupt-`))).toBe(true);
      l.add('CA9', { at: 1, signal_id: 's', tx: null });
      expect(new BuyLedger(dir).has('CA9')).toBe(true);
    }
  });

  it('add throws and keeps nothing when the file cannot be written (the caller then sends nothing)', () => {
    const dir = tempDir('ps-b2g-');
    const blocker = path.join(dir, 'file-not-folder');
    fs.writeFileSync(blocker, 'x');
    const l = new BuyLedger(blocker);
    expect(() => l.add('CA1', { at: 1, signal_id: 's', tx: null })).toThrow();
    expect(l.has('CA1')).toBe(false);
  });
});

describe('CircuitBreaker', () => {
  it('trips at 10 buys without a sell for more than 30 minutes, latches, and clears only on request', () => {
    const b = new CircuitBreaker(0);
    for (let i = 0; i < BREAKER_MAX_BUYS_WITHOUT_SELL; i++) b.noteBuyLanded();
    expect(b.check(BREAKER_NO_SELL_WINDOW_MS)).toEqual({ tripped: false, justTripped: false, detail: '' });   // not yet "more than" 30 min
    const t = b.check(BREAKER_NO_SELL_WINDOW_MS + 1);
    expect(t).toMatchObject({ tripped: true, justTripped: true });
    expect(t.detail).toContain('10 buys');
    expect(b.check(BREAKER_NO_SELL_WINDOW_MS + 2)).toMatchObject({ tripped: true, justTripped: false });
    b.noteSellOk(BREAKER_NO_SELL_WINDOW_MS + 3);          // a good sell does not unlatch it
    expect(b.isTripped()).toBe(true);
    b.clear(100);
    expect(b.isTripped()).toBe(false);
    expect(b.counters()).toEqual({ buysSinceSell: 0, lastSellOkAt: 100 });
  });

  it('does not trip below 10 buys, or when a sell succeeded inside the window', () => {
    const a = new CircuitBreaker(0);
    for (let i = 0; i < 9; i++) a.noteBuyLanded();
    expect(a.check(10 * BREAKER_NO_SELL_WINDOW_MS).tripped).toBe(false);
    const b = new CircuitBreaker(0);
    for (let i = 0; i < 12; i++) b.noteBuyLanded();
    b.noteSellOk(BREAKER_NO_SELL_WINDOW_MS - 1);
    expect(b.check(BREAKER_NO_SELL_WINDOW_MS + 5).tripped).toBe(false);
    expect(b.counters().buysSinceSell).toBe(0);
  });
});

describe('rolling window helpers', () => {
  const mk = (n: number, net: number): RollingEntry[] => Array.from({ length: n }, (_, i) => ({ tx: `t${i}`, net_per_sol_in: net, closed_at: i }));

  it('breaches only with a full window whose mean is below the limit', () => {
    expect(rollingMeanNet([])).toBeNull();
    expect(rollingBreached(mk(49, -0.9), 50, -0.15)).toBe(false);
    expect(rollingBreached(mk(50, -0.16), 50, -0.15)).toBe(true);
    expect(rollingBreached(mk(50, -0.5), 50, -0.5)).toBe(false);   // exactly at the limit is not below it (0.5 is exact in binary)
    expect(rollingBreached([...mk(25, -0.5), ...mk(25, 0.3)], 50, -0.15)).toBe(false);
  });

  it('computes net per SOL in from verified lamport strings only', () => {
    expect(netPerSolIn('-3000000', '10000000')).toBeCloseTo(-0.3, 10);
    expect(netPerSolIn('25000000', '10000000')).toBeCloseTo(2.5, 10);
    expect(netPerSolIn(null, '10000000')).toBeNull();
    expect(netPerSolIn('1', null)).toBeNull();
    expect(netPerSolIn('1.5', '10')).toBeNull();
    expect(netPerSolIn('1', '0')).toBeNull();
    expect(netPerSolIn('1', '-5')).toBeNull();
    expect(netPerSolIn('abc', '5')).toBeNull();
  });
});
