/**
 * A-93f (orchestrator fix, rb/FIX-BOT): regression tests for the confirmed auto-buy bugs.
 *   FIXBOT-T02  a buy that landed but whose position cannot be opened yet is never dropped: slow retries forever, the owner is alerted.
 *   FIXBOT-T03  boot recovery is bounded: a journal entry whose RPC hangs does not hold the boot; its watcher keeps going.
 *   FIXBOT-T10  the caps file is written atomically, and an unreadable or unwritable caps file fails SAFE (live auto-buy held) and is logged.
 * FakeClock, stub router, stub RPC and stub positions only (autobuy-testkit.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, tempDir } from '../link/link-testkit';
import { AUTO_BUY_CAPS_FILENAME, AutoBuyCaps } from '../bot/trade-guards';
import { RouterSendError } from '../execution/router';
import { OPEN_RETRIES_MAX, type RecoveryReport } from './api';
import { makeHarness } from './autobuy-testkit';

afterAll(() => { cleanupTempDirs(); });

const flush = (): Promise<void> => new Promise<void>(r => { setImmediate(r); });

describe('A-93f auto-buy fixes', () => {
  it('FIXBOT-T02 a landed buy whose position cannot be sized yet keeps its watcher: slow retries after the fast ones, an owner alert, and the position opens once a balance is read', async () => {
    const h = makeHarness();
    await h.goLive();
    h.router.failSend = new RouterSendError('confirmation timed out', []);   // the send is counted, then the router reports an error
    const r = await h.run();
    expect(r.x?.status).toBe('submitted');
    const sig = r.x?.tx as string;
    h.rpc.land(sig);
    h.fills.next = 'unverified';                                              // the meta is not readable
    h.rpc.balance = null;                                                     // and the balance lane errors
    await h.advance(1_000 + 5_000 * OPEN_RETRIES_MAX);
    expect(h.positions.real).toHaveLength(0);
    expect(h.notices.some(n => /could not be opened/.test(n))).toBe(true);
    expect(h.journal().map(e => e.sig)).toEqual([sig]);
    await h.advance(60_000);
    h.rpc.balance = { rawAtoms: 1_234_567 };                                  // the balance lane is back
    await h.advance(60_000);
    expect(h.positions.real).toHaveLength(1);
    expect(h.positions.openCalls.at(-1)?.p).toMatchObject({ sig, quote_tokens_out: '1234567' });
    expect(h.journal()).toEqual([]);
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it('FIXBOT-T03 boot recovery returns within its deadline when the RPC hangs, and the entry keeps being watched in the background', async () => {
    const h = makeHarness();
    await h.goLive();
    const r = await h.run();
    const sig = r.x?.tx as string;
    const h2 = h.restart();
    const realStatuses = h2.rpc.getSignatureStatuses.bind(h2.rpc);
    let hang = true;
    h2.rpc.getSignatureStatuses = async (sigs: string[]) => {
      if (hang) await h2.clock.sleep(120_000);                                // a degraded RPC: 7 lanes x 8 s, then a 60 s fill poll ...
      return realStatuses(sigs);
    };
    let report: RecoveryReport | null = null;
    void h2.svc.recover().then(x => { report = x; });
    await h2.advance(10_000);
    await flush();
    expect(report).toEqual({ resolved: 0, waiting: 1 });                      // the boot goes on
    hang = false;
    h2.rpc.land(sig);
    await h2.advance(120_000);
    expect(h2.positions.real).toHaveLength(1);                                // the background watcher finished the job
    expect(h2.journal()).toEqual([]);
  });

  it('FIXBOT-T10 the caps file is written atomically, and a caps file that cannot be read or written holds live auto-buy and is reported at start', async () => {
    const dir = tempDir();
    const file = path.join(dir, AUTO_BUY_CAPS_FILENAME);
    const T0 = 1_800_000_000_000;
    const limits = { perHour: 3, perDay: 20, solPerDay: 1 };

    // a good save leaves no temp file behind and a complete document
    const a = new AutoBuyCaps(file, limits);
    a.record(0.1, T0);
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).buys).toEqual([{ ts: T0, sol: 0.1 }]);

    // a torn (empty) file after a crash: never "zero usage"; auto-buy is held for 24 h, also across another restart
    fs.writeFileSync(file, '');
    const b = new AutoBuyCaps(file, limits);
    expect(b.loadError).toBeTruthy();
    const refused = b.check(0.1, T0 + 1_000);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/could not be read/);
    expect(new AutoBuyCaps(file, limits).check(0.1, T0 + 2_000).ok).toBe(false);
    expect(new AutoBuyCaps(file, limits).check(0.1, T0 + 1_000 + 86_400_000 + 1).ok).toBe(true);

    // a file that cannot be written: the next check retries the save and refuses while it still fails
    const blocker = path.join(dir, 'not-a-folder');
    fs.writeFileSync(blocker, 'x');
    const c = new AutoBuyCaps(path.join(blocker, AUTO_BUY_CAPS_FILENAME), limits);
    c.record(0.1, T0);
    expect(c.saveError).toBeTruthy();
    const r2 = c.check(0.1, T0 + 1_000);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toMatch(/could not be written/);

    // the auto-buy service names the problem at start and tells the owner
    fs.writeFileSync(file, '{not json');
    const h = makeHarness({ dir });
    h.svc.start();
    expect(h.logs.some(l => /autobuy-caps\.json/.test(l) && /could not be read/.test(l))).toBe(true);
    expect(h.notices.some(n => /autobuy-caps\.json/.test(n))).toBe(true);
  });
});
