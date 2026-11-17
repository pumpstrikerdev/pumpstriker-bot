/**
 * A-93f FIXBOT-T04: Telegram polling is supervised. A launch that fails (getMe FetchError at boot, a 409 Conflict, any error that ends
 * Telegraf's polling loop) is retried forever with a backoff (5 s doubling to 60 s), the owner is told once per outage, a 401 gets its own
 * alert, and nothing is relaunched while the bot shuts down. FakeClock only; no Telegram.
 */
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../link/clock';
import { superviseLaunch } from './launch-supervisor';

const tgErr = (code: number, description: string): Error => Object.assign(new Error(`${code}: ${description}`), { code, response: { ok: false, error_code: code, description } });
const fetchErr = (): Error => Object.assign(new Error('request to the Telegram API failed, reason: getaddrinfo ENOTFOUND'), { name: 'FetchError', code: 'ENOTFOUND' });

describe('A-93f Telegram launch supervisor', () => {
  it('FIXBOT-T04 a failed or ended launch is retried with a backoff, the owner is told once per outage (and separately for a 401), and a shutdown stops it', async () => {
    const clock = new FakeClock(1_800_000_000_000);
    const notices: string[] = [];
    let stopping = false;
    const script: Array<() => Promise<void>> = [
      async () => { throw fetchErr(); },                                      // boot before the network is up
      async () => { throw tgErr(409, 'Conflict: terminated by other getUpdates request'); },
      async () => undefined,                                                  // polling ended without a stop
      () => new Promise<void>(() => undefined),                               // polling runs
    ];
    let launches = 0;
    const sup = superviseLaunch({
      clock, stopping: () => stopping, notifyOwner: t => { notices.push(t); }, log: () => undefined,
      launch: () => { const f = script[Math.min(launches, script.length - 1)]; launches++; return f(); },
    });
    await clock.settle();
    expect(launches).toBe(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/Telegram polling stopped/);
    await clock.advance(5_000);
    expect(launches).toBe(2);                                                 // 5 s later
    await clock.advance(10_000);
    expect(launches).toBe(3);                                                 // then 10 s
    await clock.advance(20_000);
    expect(launches).toBe(4);                                                 // then 20 s: polling runs again
    expect(notices).toHaveLength(1);                                          // one alert for the whole outage
    sup.stop();
    expect(clock.pendingTimers()).toBe(0);

    // a revoked token gets its own alert; a shutdown never relaunches
    const c2 = new FakeClock(1_800_000_000_000);
    const n2: string[] = [];
    let l2 = 0;
    superviseLaunch({
      clock: c2, stopping: () => stopping, notifyOwner: t => { n2.push(t); }, log: () => undefined,
      launch: async () => { l2++; if (l2 === 2) stopping = true; throw tgErr(401, 'Unauthorized'); },
    });
    await c2.settle();
    expect(n2.some(t => /401/.test(t) && /token/i.test(t))).toBe(true);
    await c2.advance(5_000);
    expect(l2).toBe(2);
    await c2.advance(120_000);
    expect(l2).toBe(2);                                                       // shutting down: no third launch
    expect(c2.pendingTimers()).toBe(0);
  });
});
