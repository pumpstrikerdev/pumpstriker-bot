/**
 * R7-W5 rpc-budget.ts: the bot's own limit on wallet RPC traffic (daily cap, per owner per minute, a global per-second bucket).
 * A fake clock drives every window and every wait: no real time passes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRpcBudget, DEFAULT_RPC_BUDGET, RpcBudgetError, withRpcBudget, type BudgetClock } from './rpc-budget';
import { refusalFromError, type WalletRpcPort } from './wallet-rpc';

class FakeClock implements BudgetClock {
  t = Date.UTC(2026, 9, 26, 12, 0, 0);
  sleeps: number[] = [];
  now(): number { return this.t; }
  async sleep(ms: number): Promise<void> { this.sleeps.push(ms); this.t += ms; }
}
const port = (log: string[]): WalletRpcPort => ({ async call(method: string): Promise<any> { log.push(method); return { ok: true }; } });
const refusalOf = async (p: Promise<unknown>): Promise<{ code: string; reason: string }> => {
  try { await p; } catch (e) { const r = refusalFromError(e); return { code: r.code, reason: r.reason }; }
  throw new Error('expected a refusal');
};

describe('wallet RPC budget', () => {
  it('WTX-T11 refuses over a cap with the rpc-budget reason, and the per-second bucket delays wallet calls only', async () => {
    expect(DEFAULT_RPC_BUDGET).toMatchObject({ dailyCallCap: 3000, perOwnerPerMin: 60, maxPerSec: 4 });

    // the bucket: a burst of 4, then one call per 250 ms; the wait is a sleep on the injected clock, never a refusal
    const clock = new FakeClock();
    const budget = createRpcBudget({}, clock);
    for (let i = 0; i < 4; i++) await budget.acquire('owner-a');
    expect(clock.sleeps).toEqual([]);
    await budget.acquire('owner-a');
    expect(clock.sleeps).toEqual([250]);
    await Promise.all([budget.acquire('owner-b'), budget.acquire('owner-b'), budget.acquire('owner-b')]);    // concurrent callers share the bucket, in order
    expect(clock.sleeps.length).toBe(4);
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBe(1000);
    clock.t += 5000;                                                                                          // idle: the bucket is full again
    clock.sleeps = [];
    for (let i = 0; i < 4; i++) await budget.acquire('owner-c');
    expect(clock.sleeps).toEqual([]);

    // a server-path call is not behind the budget: it needs no token and never waits, while a wallet call does
    const log: string[] = [];
    const wallet = withRpcBudget(port(log), createRpcBudget({ maxPerSec: 1 }, clock), 'owner-d');
    const server = async (): Promise<string> => 'sent';
    await wallet.call('getBalance', []);
    clock.sleeps = [];
    const [w, s] = await Promise.all([wallet.call('getBalance', []), server()]);
    expect(s).toBe('sent');
    expect(w).toEqual({ ok: true });
    expect(clock.sleeps).toEqual([1000]);                                                                     // the wallet call waited ...
    const here = path.resolve(__dirname);
    const importers = fs.readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'rpc-budget.ts')
      .filter((f) => /from\s+'\.\/rpc-budget'/.test(fs.readFileSync(path.join(here, f), 'utf8')));
    expect(importers).toEqual([]);                                                                            // ... and nothing on the server path imports the budget

    // the daily cap: counted per UTC day, resets at the rollover
    const c2 = new FakeClock();
    c2.t = Date.UTC(2026, 9, 26, 23, 59, 59);
    const daily = createRpcBudget({ dailyCallCap: 3, maxPerSec: 100 }, c2);
    for (let i = 0; i < 3; i++) await daily.acquire('o');
    expect(await refusalOf(daily.acquire('o'))).toEqual({ code: 'rpc-budget', reason: 'wallet RPC daily call cap reached' });
    c2.t += 2000;                                                                                             // 2026-10-27 00:00:01 UTC
    await daily.acquire('o');
    expect(daily.snapshot()).toMatchObject({ utcDay: '2026-10-27', callsToday: 1 });

    // the per-owner minute cap is per owner and slides
    const c3 = new FakeClock();
    const perOwner = createRpcBudget({ perOwnerPerMin: 2, maxPerSec: 100 }, c3);
    await perOwner.acquire('a');
    await perOwner.acquire('a');
    expect((await refusalOf(perOwner.acquire('a'))).code).toBe('rpc-budget');
    await perOwner.acquire('b');                                                                              // another owner is not affected
    c3.t += 60_001;
    await perOwner.acquire('a');

    // a call that would wait longer than maxWaitMs is refused instead of held
    const c4 = new FakeClock();
    const slow = createRpcBudget({ maxPerSec: 1, maxWaitMs: 100 }, c4);
    await slow.acquire('o');
    const r = await refusalOf(slow.acquire('o'));
    expect(r.code).toBe('rpc-budget');
    expect(r.reason).toMatch(/busy/);
    expect(c4.sleeps).toEqual([]);

    // withRpcBudget: the port is not called when the budget refuses
    const log2: string[] = [];
    const refusing = withRpcBudget(port(log2), createRpcBudget({ dailyCallCap: 1, maxPerSec: 100 }, new FakeClock()), 'o');
    await refusing.call('getBalance', []);
    await expect(refusing.call('getBalance', [])).rejects.toBeInstanceOf(RpcBudgetError);
    expect(log2).toEqual(['getBalance']);
  });
});
