/**
 * A-93f FIXBOT-T15: a pump.fun API snapshot (the fallback after one slow on-chain curve read) is used for a few seconds at most. It never
 * shadows the chain read of the next trade for minutes: reserves, the complete flag, minOut and the impact cap come from fresh data.
 * node-fetch is mocked (no socket) and time is faked.
 */
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('node-fetch', () => ({ default: h.fetch }));
vi.mock('../logger', () => ({ log: vi.fn(), logOk: vi.fn(), logWarn: vi.fn(), logErr: vi.fn(), logDbg: vi.fn(), setBroadcast: vi.fn(), emitEvent: vi.fn() }));

import { API_SNAPSHOT_MAX_AGE_MS, fetchPumpFunInfo, getCachedPumpFunInfo } from './pumpfun-info';

const mint = Keypair.fromSeed(new Uint8Array(32).fill(77)).publicKey.toBase58();
const coin = (sol: string) => ({ ok: true, status: 200, json: async () => ({ mint, complete: false, virtual_sol_reserves: sol, virtual_token_reserves: '1073000000000000', real_sol_reserves: '1', real_token_reserves: '1', total_supply: '1' }) });

beforeEach(() => {
  h.fetch.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('A-93f curve freshness', () => {
  it('FIXBOT-T15 an API snapshot is served for at most a few seconds; after that the sync getter forgets it and the next fallback fetches again', async () => {
    expect(API_SNAPSHOT_MAX_AGE_MS).toBeLessThanOrEqual(5_000);
    h.fetch.mockResolvedValueOnce(coin('30000000000')).mockResolvedValueOnce(coin('20000000000'));
    const first = await fetchPumpFunInfo(mint);
    expect(first.virtualSolReserves).toBe(30_000_000_000);
    expect(getCachedPumpFunInfo(mint)).toBe(first);                           // the same trade may use it
    vi.advanceTimersByTime(API_SNAPSHOT_MAX_AGE_MS + 1);
    expect(getCachedPumpFunInfo(mint)).toBeUndefined();                       // the next trade reads the chain first
    const second = await fetchPumpFunInfo(mint);
    expect(h.fetch).toHaveBeenCalledTimes(2);                                 // and a fallback is a fresh snapshot, not a 5-minute-old one
    expect(second.virtualSolReserves).toBe(20_000_000_000);
  });
});
