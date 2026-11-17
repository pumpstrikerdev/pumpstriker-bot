/**
 * A-27 / A-39: the pump.fun coin-info fallback now lives in execution/ and no execution module imports the scanner folder.
 * node-fetch is mocked (no socket), time is faked, and every mint used here is unique because the module keeps a cache.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetch: vi.fn(), logWarn: vi.fn() }));
vi.mock('node-fetch', () => ({ default: h.fetch }));
vi.mock('../logger', () => ({ log: vi.fn(), logOk: vi.fn(), logWarn: h.logWarn, logErr: vi.fn(), logDbg: vi.fn(), setBroadcast: vi.fn(), emitEvent: vi.fn() }));

import { fetchPumpFunInfo, getCachedPumpFunInfo } from './pumpfun-info';

let n = 100;
const newMint = (): string => Keypair.fromSeed(new Uint8Array(32).fill(n++ % 250)).publicKey.toBase58();

function coin(mint: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mint, name: 'Test Coin', symbol: 'TST', complete: false,
    virtual_sol_reserves: '30000000000', virtual_token_reserves: '1073000000000000',
    real_sol_reserves: '8500000000', real_token_reserves: '793100000000000', total_supply: '1000000000000000',
    creator: 'CreatorAddr', created_timestamp: 1_760_000_000_000, ath_market_cap: '12000.5', ath_market_cap_timestamp: 1_760_000_100_000,
    usd_market_cap: '9000.25', twitter: 'https://x.example/t', telegram: 'https://t.example/t', website: 'https://w.example', description: 'd',
    ...over,
  };
}
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const bad = (status: number) => ({ ok: false, status, json: async () => ({}) });

beforeEach(() => {
  h.fetch.mockReset();
  h.logWarn.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pumpfun-info (moved from the scanner folder, same behaviour)', () => {
  it('maps the coins-v2 answer, asks the coins-v2 endpoint of the mint, and caches it for a few seconds (A-93f: API_SNAPSHOT_MAX_AGE_MS, no longer 5 minutes)', async () => {
    const mint = newMint();
    h.fetch.mockResolvedValue(ok(coin(mint)));
    const info = await fetchPumpFunInfo(mint);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0][0]).toBe(`https://frontend-api-v3.pump.fun/coins-v2/${mint}`);
    expect(h.fetch.mock.calls[0][1].headers.Accept).toBe('application/json');
    expect(info).toMatchObject({
      hasData: true, mint, name: 'Test Coin', symbol: 'TST', complete: false, isOnBondingCurve: true,
      virtualSolReserves: 30_000_000_000, virtualTokenReserves: 1_073_000_000_000_000,
      realSolReserves: 8_500_000_000, realTokenReserves: 793_100_000_000_000, totalSupply: 1_000_000_000_000_000,
      creator: 'CreatorAddr', createdAtMs: 1_760_000_000_000, athMcap: 12000.5, athAtMs: 1_760_000_100_000, currentMcap: 9000.25,
      safetyVerdict: 'safe-bonding-curve',
    });
    expect(info.bondingCurveProgress).toBeCloseTo(0.1, 6);                       // 8.5 SOL real of the 85 SOL graduation

    await fetchPumpFunInfo(mint);
    expect(h.fetch).toHaveBeenCalledTimes(1);                                    // served from the cache
    expect(getCachedPumpFunInfo(mint)).toBe(info);

    vi.advanceTimersByTime(5_000 + 1);
    await fetchPumpFunInfo(mint);
    expect(h.fetch).toHaveBeenCalledTimes(2);                                    // past the TTL: fetched again
    vi.advanceTimersByTime(5_000 + 1);
    expect(getCachedPumpFunInfo(mint)).toBeUndefined();                          // the sync getter forgets after the TTL
    expect(getCachedPumpFunInfo(newMint())).toBeUndefined();
  });

  it('a graduated coin is progress 1 and graduated-needs-audit', async () => {
    const mint = newMint();
    h.fetch.mockResolvedValue(ok(coin(mint, { complete: true, real_sol_reserves: '85000000000' })));
    const info = await fetchPumpFunInfo(mint);
    expect(info).toMatchObject({ hasData: true, complete: true, isOnBondingCurve: false, bondingCurveProgress: 1, safetyVerdict: 'graduated-needs-audit' });
  });

  it('every failure is an empty hasData:false answer that is not retried for 60 s', async () => {
    // HTTP 404 / 403 / 5xx start the cooldown
    for (const status of [404, 403, 503]) {
      const mint = newMint();
      h.fetch.mockReset();
      h.fetch.mockResolvedValue(bad(status));
      expect((await fetchPumpFunInfo(mint)).hasData).toBe(false);
      expect((await fetchPumpFunInfo(mint)).hasData).toBe(false);
      expect(h.fetch, `status ${status}`).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_001);
      await fetchPumpFunInfo(mint);
      expect(h.fetch, `status ${status} after the cooldown`).toHaveBeenCalledTimes(2);
    }
    // another status (429) is empty but not cooled down
    const m429 = newMint();
    h.fetch.mockReset();
    h.fetch.mockResolvedValue(bad(429));
    await fetchPumpFunInfo(m429);
    await fetchPumpFunInfo(m429);
    expect(h.fetch).toHaveBeenCalledTimes(2);

    // a body for another mint, and a throwing fetch, are empty with a cooldown; the throw is logged
    const mismatch = newMint();
    h.fetch.mockReset();
    h.fetch.mockResolvedValue(ok(coin(newMint())));
    expect((await fetchPumpFunInfo(mismatch)).hasData).toBe(false);
    await fetchPumpFunInfo(mismatch);
    expect(h.fetch).toHaveBeenCalledTimes(1);

    const boom = newMint();
    h.fetch.mockReset();
    h.fetch.mockRejectedValue(new Error('socket hang up'));
    const empty = await fetchPumpFunInfo(boom);
    expect(empty).toMatchObject({ hasData: false, mint: '', creator: '', safetyVerdict: 'unknown' });
    await fetchPumpFunInfo(boom);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.logWarn).toHaveBeenCalledTimes(1);
    expect(String(h.logWarn.mock.calls[0][0])).toContain('socket hang up');
  });

  it('A39 no execution module imports the scanner folder, and the router and pumpfun-swap use pumpfun-info', () => {
    const dir = __dirname;
    const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(sources).toEqual(expect.arrayContaining(['router.ts', 'pumpfun-swap.ts', 'pumpfun-info.ts']));
    const importsScanners = /(?:from|import|require)\s*\(?\s*['"](?:\.\.\/)+scanners\//;
    for (const f of sources) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8'), `${f} must not import the scanner folder`).not.toMatch(importsScanners);
    }
    for (const f of ['router.ts', 'pumpfun-swap.ts']) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8'), f).toMatch(/from '\.\/pumpfun-info'/);
    }
  });
});

describe('PUMPFUN_API_BASE (B50 section 2 test override)', () => {
  it('moves the coin-info call to that base; unset it is the frontend-api-v3.pump.fun literal', async () => {
    const saved = process.env.PUMPFUN_API_BASE;
    try {
      process.env.PUMPFUN_API_BASE = 'http://127.0.0.1:7005/';
      const a = newMint();
      h.fetch.mockResolvedValue(ok(coin(a)));
      await fetchPumpFunInfo(a);
      expect(h.fetch.mock.calls.at(-1)![0]).toBe(`http://127.0.0.1:7005/coins-v2/${a}`);

      delete process.env.PUMPFUN_API_BASE;
      const b = newMint();
      h.fetch.mockResolvedValue(ok(coin(b)));
      await fetchPumpFunInfo(b);
      expect(h.fetch.mock.calls.at(-1)![0]).toBe(`https://frontend-api-v3.pump.fun/coins-v2/${b}`);
    } finally {
      if (saved === undefined) delete process.env.PUMPFUN_API_BASE; else process.env.PUMPFUN_API_BASE = saved;
    }
  });
});