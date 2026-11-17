/**
 * exit-engine tests (B30). One FakeClock drives the scheduler, the store is a real store in a temp folder, and `smartSell` is a stub that
 * counts sends (A-28); the chain, the fills and CloseAccount are scripted fakes (see exits-testkit.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { validateBotBatch } from '../shared/contract/validate';
import { newCa, cleanupTempDirs, tempDir } from '../link/link-testkit';
import { sellKey } from './failure-policy';
import { DEFAULT_EXIT_CONFIG, allocate, scaleTokens, shortCa, soldFractionOf, createExitEngine } from './exit-engine';
import {
  BASE_PRICE, START_MS, addOrder, addPosition, makeWorld, newSig, realValuation, setMultiple, type World, type WorldOpts,
} from './exits-testkit';

afterEach(() => cleanupTempDirs());

const world = (o?: WorldOpts): World => makeWorld(tempDir(), o);
const shape = (w: World) => w.legs().map(l => `${l.leg}:${l.status}:${l.attempt}`);

describe('scheduler', () => {
  it('B3-T01 three positions on two CAs in one pass cost exactly one quote per (CA, wallet), used for every position of the group', async () => {
    const w = world();
    const ca1 = newCa();
    const ca2 = newCa();
    addPosition(w, { ca: ca1 });
    addPosition(w, { ca: ca1, origin: 'manual' });
    addPosition(w, { ca: ca2 });
    const rep = await w.engine.runPass();
    expect(rep.groups).toBe(2);
    expect(w.quoteCalls).toHaveLength(2);
    const byCa = Object.fromEntries(w.quoteCalls.map(c => [c.ca, c]));
    expect(byCa[ca1]).toMatchObject({ wallet: 'w1', tokens: '2000000000', protectiveOnly: true });   // the bag of the whole group
    expect(byCa[ca2]).toMatchObject({ wallet: 'w1', tokens: '1000000000' });
    for (const p of w.store.listOpen()) expect(p.last_quote).toMatchObject({ src: 'onchain' });      // every position was judged on it
    // a second wallet holding the same CA is its own group
    addPosition(w, { ca: ca1, wallet: 'w2' });
    await w.passAt(5000);
    expect(w.quoteCalls.slice(2).map(c => `${c.ca}:${c.wallet}`).sort()).toEqual([`${ca1}:w1`, `${ca1}:w2`, `${ca2}:w1`].sort());
  });

  it('B3-T02 a position is looked at every 5 s for its first 10 minutes and every 15 s after (fake clock)', async () => {
    const w = world();
    addPosition(w);
    w.engine.start();
    await w.clock.advance(11 * 60_000 + 20_000);
    w.engine.stop();
    const times = w.quoteCalls.map(c => c.at - START_MS);
    expect(times.length).toBeGreaterThan(120);   // 120 passes in the first 10 minutes, then one every 15 s
    for (let i = 1; i < times.length; i++) {
      const prev = times[i - 1];
      expect(times[i] - prev, `pass ${i} at ${prev} ms of age`).toBe(prev < DEFAULT_EXIT_CONFIG.youngAgeMs ? 5000 : 15000);
    }
    expect(times.some(t => t > DEFAULT_EXIT_CONFIG.youngAgeMs)).toBe(true);
    expect(w.clock.pendingTimers()).toBe(0);   // stop() leaves no timer behind
  }, 60_000);

  it('B3-T04 three passes in a row with no quote alert the owner once ("no price for X - exits blind"); a price that returns re-arms the alert', async () => {
    const w = world();
    const p = addPosition(w);
    setMultiple(w, p.ca, null);
    await w.engine.runPass();
    await w.passAt(5000);
    expect(w.notices).toEqual([]);
    await w.passAt(5000);
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]).toContain('no price for');
    expect(w.notices[0]).toContain('exits blind');
    expect(w.notices[0]).toContain(shortCa(p.ca));
    await w.passAt(5000);
    await w.passAt(5000);
    expect(w.notices).toHaveLength(1);           // not repeated while it stays dark
    setMultiple(w, p.ca, 1);
    await w.passAt(5000);
    setMultiple(w, p.ca, null);
    await w.passAt(5000);
    await w.passAt(5000);
    await w.passAt(5000);
    expect(w.notices).toHaveLength(2);
    expect(w.sells).toHaveLength(0);
  });

  it('runs at most EXIT_QUOTE_CONCURRENCY groups at once and takes the rest on the next pass; a pass over 15 s logs a warning', async () => {
    let inFlight = 0;
    let peak = 0;
    const w = world({
      valuation: ww => ({
        async quote(pos) {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await ww.clock.sleep(4000);
          inFlight--;
          return { sol: BASE_PRICE * Number(pos.tokens), src: 'onchain', at: ww.clock.now() };
        },
      }),
    });
    for (let i = 0; i < 6; i++) addPosition(w);
    const first = w.engine.runPass();
    await w.clock.advance(4000);
    expect((await first).groups).toBe(4);
    const second = w.engine.runPass();
    await w.clock.advance(4000);
    expect((await second).groups).toBe(2);
    expect(peak).toBe(4);
    expect(w.logs.some(l => l.startsWith('warn') && l.includes('a pass took'))).toBe(false);
    // a slow valuation (16 s) trips the warning
    const slow = world({ valuation: ww => ({ async quote(pos) { await ww.clock.sleep(16_000); return { sol: BASE_PRICE * Number(pos.tokens), src: 'onchain', at: ww.clock.now() }; } }) });
    addPosition(slow);
    const pass = slow.engine.runPass();
    await slow.clock.advance(16_000);
    await pass;
    expect(slow.logs.some(l => l.startsWith('warn') && l.includes('a pass took 16.0 s'))).toBe(true);
  });

  it('does not judge a position with a policy that is not loaded (there is no fallback policy)', async () => {
    const w = world();
    const p = addPosition(w);
    w.store.update(p.position_id, { policy_id: 'NOPE' });
    setMultiple(w, p.ca, 0.5);
    await w.engine.runPass();
    await w.passAt(5000);
    expect(w.sells).toHaveLength(0);
    expect(w.logs.filter(l => l.includes('no exit policy "NOPE"'))).toHaveLength(1);   // once, not every pass
  });
});

describe('valuation chain in the engine', () => {
  it('B3-T03 with the chain and Jupiter dark and an Engine price 20 s old, a protective leg proceeds on engine_gmgn and a take-profit leg does not', async () => {
    const solUsd = 100;
    const tokenUsd = (m: number): number => BASE_PRICE * m * 1e6 * solUsd;   // 6-decimal token: USD per whole token
    const dark = (m: number) => world({ valuation: w => realValuation(w, { onchain: null, jupiter: 'throws', engineUsd: { token: tokenUsd(m), sol: solUsd, tokenAgeMs: 20_000 } }) });

    // (a) the rug-stop level (m = 0.5): S fires and sells on the Engine price
    const a = dark(0.5);
    const pa = addPosition(a);
    await a.engine.runPass();
    expect(a.sells).toHaveLength(1);
    expect(a.legs()).toHaveLength(1);
    expect(a.legs()[0]).toMatchObject({ leg: 'S', status: 'filled', quote_src: 'engine_gmgn', position_id: pa.position_id });
    expect(a.legs()[0].quote_age_s).toBeCloseTo(20, 6);

    // (b) a take-profit level (m = 2.5) on the same dark sources: TP1 would fire, and nothing is sent
    const b = dark(2.5);
    const pb = addPosition(b);
    await b.engine.runPass();
    await b.passAt(5000);
    expect(b.sells).toHaveLength(0);
    expect(b.legs()).toEqual([]);
    expect(b.store.get(pb.position_id)!.legs_done).toEqual([]);
    expect(b.store.get(pb.position_id)!.peak_multiple).toBeCloseTo(2.5, 6);   // the quote still counts for the peak

    // (c) a price older than 30 s is no quote at all, even for a protective leg
    const stale = world({ valuation: w => realValuation(w, { onchain: null, jupiter: 'throws', engineUsd: { token: tokenUsd(0.5), sol: solUsd, tokenAgeMs: 31_000 } }) });
    addPosition(stale);
    await stale.engine.runPass();
    expect(stale.sells).toHaveLength(0);

    // (d) control: with the on-chain read back, the same m = 2.5 does sell the take-profits
    const c = world({ valuation: w => realValuation(w, { onchain: BASE_PRICE * 2.5 * 1e9, engineUsd: 'error' }) });
    addPosition(c);
    await c.engine.runPass();
    expect(c.legs().map(l => l.leg)).toEqual(['TP1']);
  });
});

describe('failure policy in the engine', () => {
  it('B3-T07 a take-profit that fails stops after 3 attempts at the escalating slippage; a protective leg that fails twice is locked out with an owner alert', async () => {
    // (a) the take-profit
    const a = world({ sellScript: ['revert'] });
    const pa = addPosition(a);
    setMultiple(a, pa.ca, 2.1);
    await a.engine.runPass();
    await a.passAt(5000);
    await a.passAt(5000);
    await a.passAt(5000);
    await a.passAt(5000);
    expect(a.sells.map(s => s.slippageBps)).toEqual([300, 900, 1500]);
    expect(a.sells.every(s => s.singleSend === true)).toBe(true);
    expect(shape(a)).toEqual(['TP1:failed:1', 'TP1:failed:2', 'TP1:failed:3']);
    const sa = a.store.get(pa.position_id)!;
    expect(sa.leg_attempts.TP1).toBe(3);
    expect(sa.lockouts).toContain('TP1');
    expect(sa.tokens).toBe(pa.tokens);
    expect(a.notices.some(n => n.includes('take-profit'))).toBe(true);
    expect(a.legs().every(l => l.error !== null && l.error.length <= 200)).toBe(true);

    // (b) the protective leg
    const b = world({ sellScript: ['revert'] });
    const pb = addPosition(b);
    setMultiple(b, pb.ca, 0.5);
    await b.engine.runPass();
    await b.passAt(5000);
    await b.passAt(5000);
    await b.passAt(5000);
    expect(b.sells.map(s => s.slippageBps)).toEqual([4000, 9900, 4000, 9900]);   // guaranteed exit, then the panic leg, twice
    expect(shape(b)).toEqual(['S:failed:1', 'S:locked_out:2']);
    expect(b.notices.some(n => n.includes('auto-exit is OFF'))).toBe(true);
    expect(b.store.get(pb.position_id)!.lockouts).toEqual(expect.arrayContaining(['S', 'R0', 'T', 'H']));
    expect(b.store.get(pb.position_id)!.closed_at).toBeNull();
  });

  it('all protective legs of a position share one attempt budget: R0 failing and then T failing is attempt 1 and attempt 2, then everything protective is locked out', async () => {
    const w = world({ sellScript: ['revert'] });
    const p = addPosition(w);
    setMultiple(w, p.ca, 1.6);
    await w.engine.runPass();                     // peak 1.6: the trail is armed
    setMultiple(w, p.ca, 0.5);                    // down 69%: R0 (hard rug) and T both fire; R0 is first
    await w.passAt(5000);
    await w.passAt(5000);                         // same price now: only T still fires
    await w.passAt(5000);
    expect(shape(w)).toEqual(['R0:failed:1', 'T:locked_out:2']);
    expect(w.sells.map(s => s.slippageBps)).toEqual([9900, 4000, 9900]);
    expect(w.store.get(p.position_id)!.lockouts).toEqual(expect.arrayContaining(['R0', 'S', 'T', 'H']));
  });

  it('B3-T08 with the per-CA breaker tripped, protective legs still execute and take-profit legs do not', async () => {
    const w = world();
    const ca1 = newCa();
    const ca2 = newCa();
    addPosition(w, { ca: ca1 });
    const b = addPosition(w, { ca: ca2, wallet: 'w2' });
    setMultiple(w, ca1, 0.5);   // S
    setMultiple(w, ca2, 2.1);   // TP1
    for (const ca of [ca1, ca2]) for (let i = 0; i < 5; i++) w.engine.breaker.bump(ca);
    expect(w.engine.breaker.isLocked(ca1)).toBe(true);
    await w.engine.runPass();
    expect(w.sells).toHaveLength(1);
    expect(w.sells[0].mint).toBe(ca1);
    expect(w.legs().map(l => `${l.leg}:${l.status}`)).toEqual(['S:filled']);
    expect(w.store.get(b.position_id)!.tokens).toBe(b.tokens);
    expect(w.engine.breaker.failures(ca1)).toBe(0);       // a fill resets the consecutive count
    expect(w.engine.breaker.isLocked(ca2)).toBe(true);
  });

  it('five failed sells in a row trip the breaker with one owner notice; take-profits then stop, a success resets the count', async () => {
    const w = world({ sellScript: ['revert', 'revert', 'revert', 'ok'] });
    const p = addPosition(w);
    setMultiple(w, p.ca, 2.1);
    await w.engine.runPass();
    await w.passAt(5000);
    await w.passAt(5000);
    expect(w.engine.breaker.failures(p.ca)).toBe(3);
    expect(w.engine.breaker.isLocked(p.ca)).toBe(false);
    // a new leg level reached: TP2 at 3.0 (TP1 is locked out after its 3 attempts)
    setMultiple(w, p.ca, 3.1);
    await w.passAt(5000);   // TP2 attempt 1 -> 'ok' in the script
    expect(w.legs().map(l => `${l.leg}:${l.status}`)).toEqual(['TP1:failed', 'TP1:failed', 'TP1:failed', 'TP2:filled']);
    expect(w.engine.breaker.failures(p.ca)).toBe(0);
  });

  it('A-29: a sell that confirms with 0 tokens sold is a failed leg, retried at the next attempt\'s slippage', async () => {
    const w = world({ sellScript: ['empty', 'ok'] });
    const p = addPosition(w);
    setMultiple(w, p.ca, 2.1);
    await w.engine.runPass();
    await w.passAt(5000);
    expect(w.sells.map(s => s.slippageBps)).toEqual([300, 900]);
    expect(shape(w)).toEqual(['TP1:failed:1', 'TP1:filled:2']);
    expect(w.legs()[0].error).toMatch(/sold no tokens/);
    expect(w.store.get(p.position_id)!.tokens).toBe('700000000');
  });

  it('a send that reported a failure but landed is found by the landed-check and never sent twice', async () => {
    const w = world({ sellScript: ['revert-landed', 'ok'] });
    const p = addPosition(w);
    setMultiple(w, p.ca, 2.1);
    await w.engine.runPass();
    await w.passAt(5000);
    expect(w.sells).toHaveLength(1);
    expect(shape(w)).toEqual(['TP1:filled:1']);
    expect(w.legs()[0].tx).toBe(w.sells[0].sig);
    expect(w.store.get(p.position_id)!.tokens).toBe('700000000');
    expect(w.store.get(p.position_id)!.pending_sigs).toEqual([]);
  });

  it('a failure message that carries a secret reaches the Engine redacted and at most 200 characters long', async () => {
    const key = newCa();
    const w = world({ sellScript: [{ revert: `All RPCs failed for sendTransaction: https://rpc.example.test/?api-key=${key}: 429 ${'z'.repeat(400)}` }] });
    const p = addPosition(w);
    setMultiple(w, p.ca, 2.1);
    await w.engine.runPass();
    const l = w.legs()[0];
    expect(l.error!.length).toBeLessThanOrEqual(200);
    expect(l.error).not.toContain(key);
    expect(JSON.stringify(w.outbox.events)).not.toContain(key);
  });

  it('a signature that was signed but never resolved (a crash mid-sell) is checked first after a restart; if it landed, nothing is sent', async () => {
    const w = world();
    const p = addPosition(w);
    const sig = newSig();
    w.store.update(p.position_id, { pending_sigs: [sig] });
    setMultiple(w, p.ca, 2.1);
    w.statuses.set(sig, { err: null, confirmationStatus: 'confirmed' });
    w.balances.set(p.ca, 700_000_000n);
    w.fills.set(sig, { solOutNetLamports: '123000000', solOutGrossLamports: '123005000', tokensSoldRaw: '300000000', feeLamports: '5000', confirmedAt: START_MS });
    await w.engine.runPass();
    expect(w.sells).toHaveLength(0);
    expect(shape(w)).toEqual(['TP1:filled:1']);
    expect(w.legs()[0]).toMatchObject({ tx: sig, sol_out_real_lamports: '123000000' });
    expect(w.store.get(p.position_id)!.tokens).toBe('700000000');
  });

  it('the signature of every sell is on disk before the engine knows the outcome', async () => {
    const w = world({ sellScript: ['revert'] });
    const p = addPosition(w);
    setMultiple(w, p.ca, 2.1);
    await w.engine.runPass();
    const stored = w.reopenStore().get(p.position_id)!;
    expect(stored.pending_sigs).toEqual([w.sells[0].sig]);
  });

  it('only one sell at a time per (CA, wallet): a busy wallet is retried in a second, not skipped or doubled', async () => {
    const w = world();
    const p = addPosition(w);
    setMultiple(w, p.ca, 0.5);
    const key = sellKey(p.ca, 'w1');
    expect(w.engine.mutex.tryAcquire(key)).toBe(true);   // a manual sell holds it
    await w.engine.runPass();
    expect(w.sells).toHaveLength(0);
    expect(w.store.get(p.position_id)!.next_due_at).toBe(w.clock.now() + 1000);
    w.engine.mutex.release(key);
    await w.passAt(1000);
    expect(w.sells).toHaveLength(1);
    expect(w.engine.mutex.has(key)).toBe(false);
  });

  it('a position whose wallet is not loaded sends nothing and tells the owner once', async () => {
    const w = world();
    const p = addPosition(w);
    w.missingWallets.add('w1');
    setMultiple(w, p.ca, 0.5);
    await w.engine.runPass();
    await w.passAt(5000);
    expect(w.sells).toHaveLength(0);
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]).toContain('wallet');
  });

  it('a full exit finds the wallet empty twice and closes the position as an external sell instead of burning fees', async () => {
    const w = world();
    const p = addPosition(w);
    setMultiple(w, p.ca, 0.5);
    w.balances.set(p.ca, 0n);
    await w.engine.runPass();
    expect(w.store.get(p.position_id)!.closed_at).toBeNull();
    await w.passAt(5000);
    expect(w.sells).toHaveLength(0);
    expect(w.closed()).toHaveLength(1);
    expect(w.closed()[0]).toMatchObject({ reason: 'external_sell', realized_sol_net_lamports: null, close_account_status: 'skipped' });
    expect(w.closeCalls).toEqual([]);
  });
});

describe('signal positions', () => {
  it('B3-T09 basis and peak are restored after a restart, and a new engine keeps them', async () => {
    const w = world();
    const p = addPosition(w, { basis: null });
    setMultiple(w, p.ca, 1);
    await w.engine.runPass();                         // the first successful quote is the basis
    const basis = w.store.get(p.position_id)!.basis_sol_per_token;
    expect(basis).toBeCloseTo(BASE_PRICE, 18);
    setMultiple(w, p.ca, 1.2);
    await w.passAt(5000);
    expect(w.store.get(p.position_id)!.peak_multiple).toBeCloseTo(1.2, 9);
    // restart: a new store over the same folder
    const again = w.reopenStore().get(p.position_id)!;
    expect(again.basis_sol_per_token).toBe(basis);
    expect(again.peak_multiple).toBeCloseTo(1.2, 9);
    // and a new engine over it (a second world on the same folder, later in time) neither re-anchors nor lowers the peak
    const w2 = makeWorld(w.dir);
    w2.price.set(p.ca, BASE_PRICE * 1.1);
    await w2.clock.advance(60_000);
    await w2.engine.runPass();
    const after = w2.store.get(p.position_id)!;
    expect(after.basis_sol_per_token).toBe(basis);
    expect(after.peak_multiple).toBeCloseTo(1.2, 9);
    expect(w2.sells).toHaveLength(0);
  });

  it('B3-T11 a full exit asks for CloseAccount only after the confirmed zero balance, and position.closed carries the rent and the verified realized net', async () => {
    const w = world();
    const p = addPosition(w);                    // bought for 0.2 SOL
    setMultiple(w, p.ca, 0.5);                   // S
    await w.engine.runPass();
    expect(w.order).toEqual(['balance:1000000000', 'sell', 'balance:0', 'close']);
    expect(w.closeCalls).toEqual([{ owner: w.closeCalls[0].owner, mint: p.ca, balanceSeen: 0 }]);
    expect(w.outbox.events.map(e => e.type)).toEqual(['exit.leg', 'position.closed']);
    const leg = w.legs()[0];
    expect(leg).toMatchObject({ leg: 'S', status: 'filled', attempt: 1, dry_run: false, quote_src: 'onchain', policy_version: p.policy_version, sol_out_real_lamports: '97995000' });
    expect(leg.sol_out_quoted_lamports).toBe('100000000');
    expect(leg.fill_multiple).toBeCloseTo(0.97995 * 0.5, 4);
    expect(leg.tx).toBe(w.sells[0].sig);
    expect(leg.send_at).not.toBeNull();
    expect(leg.confirm_at).not.toBeNull();
    const closed = w.closed()[0];
    expect(closed).toMatchObject({
      position_id: p.position_id, reason: 'policy', rent_reclaimed_lamports: '2039280', close_account_status: 'closed', close_account_tx: w.closeResult.tx,
      realized_sol_net_lamports: String(97_995_000 + 2_039_280 - 200_000_000),
    });
    expect(w.store.get(p.position_id)!.closed_at).not.toBeNull();
    expect(w.store.listOpen()).toEqual([]);
  });

  it('a partial sell never asks for CloseAccount and does not close the position', async () => {
    const w = world();
    const p = addPosition(w);
    setMultiple(w, p.ca, 2.1);
    await w.engine.runPass();
    expect(w.sells).toHaveLength(1);
    expect(w.closeCalls).toEqual([]);
    expect(w.closed()).toEqual([]);
    expect(w.store.get(p.position_id)).toMatchObject({ tokens: '700000000', closed_at: null });
  });

  it('a protective sell that only fills half is not an exit: the position stays open, no account is closed, and the leg fires again for the rest', async () => {
    const w = world({ sellScript: ['partial', 'ok'] });
    const p = addPosition(w);
    setMultiple(w, p.ca, 0.5);
    await w.engine.runPass();                    // half was sold: the protective leg is not done
    expect(w.closeCalls).toEqual([]);
    expect(w.store.get(p.position_id)).toMatchObject({ tokens: '500000000', closed_at: null, legs_done: [] });
    expect(w.legs().map(l => `${l.leg}:${l.status}`)).toEqual(['S:filled']);
    await w.passAt(5000);                        // S fires again for the rest
    expect(w.sells.map(s => s.tokens)).toEqual([1_000_000_000n, 500_000_000n]);
    expect(w.closed()).toHaveLength(1);
    expect(w.closeCalls).toHaveLength(1);
  });

  it('a few atoms of dust left on the chain after a full sell close the position but never the account; a real remainder keeps it open', async () => {
    const d = world();
    d.dust = 10n;
    const pd = addPosition(d);
    setMultiple(d, pd.ca, 0.5);
    await d.engine.runPass();
    expect(d.closed()).toHaveLength(1);
    expect(d.closed()[0]).toMatchObject({ close_account_status: 'skipped', rent_reclaimed_lamports: null });
    expect(d.closeCalls).toEqual([]);

    const r = world();
    r.dust = 50_000_000n;                        // 5% of the original is still in the wallet
    const pr = addPosition(r);
    setMultiple(r, pr.ca, 0.5);
    await r.engine.runPass();
    expect(r.closed()).toEqual([]);
    expect(r.closeCalls).toEqual([]);
    expect(r.store.get(pr.position_id)).toMatchObject({ tokens: '50000000', closed_at: null, close_pending: null });
  });

  it('an unreadable token balance after the exit is retried on later passes, then the position closes without CloseAccount', async () => {
    const x = world();
    const px = addPosition(x);
    setMultiple(x, px.ca, 0.5);
    x.balanceUnknown.add(px.ca);                 // the wallet balance can never be read
    await x.engine.runPass();                    // full exit: the tracked amount is sold; confirming the empty account fails (try 1)
    expect(x.sells).toHaveLength(1);
    expect(x.closed()).toEqual([]);
    expect(x.store.get(px.position_id)!.close_pending).toMatchObject({ tries: 1, reason: 'policy' });
    await x.passAt(5000);                        // try 2
    expect(x.closed()).toEqual([]);
    await x.passAt(5000);                        // try 3: give up on the account, never on the report
    expect(x.closed()).toHaveLength(1);
    expect(x.closed()[0]).toMatchObject({ close_account_status: 'skipped', reason: 'policy' });
    expect(x.closeCalls).toEqual([]);
    expect(x.sells).toHaveLength(1);
  });

  it('the empty-account confirmation is retried on the 5 s cadence of the scheduler, not on every tick', async () => {
    const w = world();
    const p = addPosition(w);
    setMultiple(w, p.ca, 0.5);
    w.balanceUnknown.add(p.ca);                  // the wallet balance can never be read
    const reads = (): number => w.order.filter(o => o === 'balance:unknown').length;
    w.engine.start();
    await w.clock.advance(4500);                 // ticks every 500 ms: the exit sells at 500 ms and the first confirm try fails
    expect(w.sells).toHaveLength(1);
    expect(reads()).toBe(2);                     // one read before the sale, one confirm try (not one per tick)
    expect(w.closed()).toEqual([]);
    await w.clock.advance(1000);                 // 5.5 s: the second try
    expect(reads()).toBe(3);
    expect(w.closed()).toEqual([]);
    await w.clock.advance(5000);                 // 10.5 s: the third try gives up on the account, never on the report
    w.engine.stop();
    expect(reads()).toBe(4);
    expect(w.closed()).toHaveLength(1);
    expect(w.closed()[0]).toMatchObject({ close_account_status: 'skipped', reason: 'policy' });
  });

  it('B3-T12 m = 3.2 with none done makes ONE sell of 60% of the original (TP1 + TP2) and reports two filled legs', async () => {
    const w = world();
    const p = addPosition(w);
    setMultiple(w, p.ca, 3.2);
    await w.engine.runPass();
    expect(w.sells).toHaveLength(1);
    expect(w.sells[0].tokens).toBe(600_000_000n);
    expect(w.legs().map(l => `${l.leg}:${l.status}:${l.attempt}`)).toEqual(['TP1:filled:1', 'TP2:filled:1']);
    const [a, b] = w.legs();
    expect(a.fraction_of_original).toBeCloseTo(0.3, 9);
    expect(b.fraction_of_original).toBeCloseTo(0.3, 9);
    expect(a.tx).toBe(b.tx);
    expect(BigInt(a.sol_out_real_lamports!) + BigInt(b.sol_out_real_lamports!)).toBe(376_315_000n);   // the one fill, split between the two legs
    expect(a.trigger_multiple).toBe(2);
    expect(b.trigger_multiple).toBe(3);
    expect(a.quote_multiple).toBeCloseTo(3.2, 9);
    expect(a.peak_multiple).toBeCloseTo(3.2, 9);
    const st = w.store.get(p.position_id)!;
    expect(st.legs_done).toEqual(['TP1', 'TP2']);
    expect(st.tokens).toBe('400000000');
    expect(w.closed()).toEqual([]);
    // the remainder is protected by the trail: peak 3.2, so m <= 0.6 x 3.2 = 1.92 sells the rest (no single step falls 40%, so not R0)
    for (const m of [2.6, 2.1, 1.9]) { setMultiple(w, p.ca, m); await w.passAt(5000); }
    expect(w.legs().map(l => l.leg)).toEqual(['TP1', 'TP2', 'T']);
    expect(w.sells[1].tokens).toBe(400_000_000n);
    expect(w.closed()).toHaveLength(1);
  });

  it('a position sharing its mint and wallet with another open position sells only its own tokens and leaves the token account alone', async () => {
    const w = world();
    const ca = newCa();
    const sig = addPosition(w, { ca, tokens: 1_000_000_000n });
    const manual = addPosition(w, { ca, tokens: 500_000_000n, origin: 'manual' });
    w.balances.set(ca, 1_500_000_000n);          // the wallet holds both
    setMultiple(w, ca, 0.5);
    await w.engine.runPass();
    expect(w.sells).toHaveLength(1);
    expect(w.sells[0].tokens).toBe(1_000_000_000n);   // not the wallet's whole balance
    expect(w.closed().map(c => c.position_id)).toEqual([sig.position_id]);
    expect(w.closed()[0]).toMatchObject({ close_account_status: 'skipped', rent_reclaimed_lamports: null });
    expect(w.closeCalls).toEqual([]);
    expect(w.store.get(manual.position_id)).toMatchObject({ closed_at: null, tokens: '500000000' });
  });

  it('a bag so small that a take-profit share rounds to nothing marks the leg done instead of looping on it', async () => {
    const w = world();
    const p = addPosition(w, { tokens: 1n });
    setMultiple(w, p.ca, 2.1);
    await w.engine.runPass();
    expect(w.sells).toHaveLength(0);
    expect(w.legs()).toEqual([]);
    expect(w.store.get(p.position_id)!.legs_done).toEqual(['TP1']);
    expect(w.store.get(p.position_id)!.next_due_at).toBe(w.clock.now() + 5000);
  });

  it('a hard rug (R0) between two quotes of one source sells at once at the panic slippage', async () => {
    const w = world();
    const p = addPosition(w);
    await w.engine.runPass();                    // m = 1, nothing to do
    setMultiple(w, p.ca, 0.5);                   // down 50% in one pass
    await w.passAt(5000);
    expect(w.sells.map(s => s.slippageBps)).toEqual([9900]);
    expect(w.legs()[0]).toMatchObject({ leg: 'R0', status: 'filled' });
    expect(w.closed()).toHaveLength(1);
  });

  it('the trail leg exits at 60% of the peak', async () => {
    const w = world();
    const p = addPosition(w);
    setMultiple(w, p.ca, 1.6);
    await w.engine.runPass();
    setMultiple(w, p.ca, 1.2);
    await w.passAt(5000);
    expect(w.sells).toHaveLength(0);
    setMultiple(w, p.ca, 0.95);                  // <= 0.6 x 1.6 = 0.96, and only 21% below the previous quote: not a hard rug
    await w.passAt(5000);
    expect(w.legs()[0]).toMatchObject({ leg: 'T', status: 'filled' });
    expect(w.legs()[0].peak_multiple).toBeCloseTo(1.6, 9);
    expect(w.legs()[0].trigger_multiple).toBeCloseTo(0.96, 9);
  });

  it('a fill whose meta cannot be read is filled_unconfirmed and the realized net stays null', async () => {
    const w = world({ sellScript: ['unverified'] });
    const p = addPosition(w);
    setMultiple(w, p.ca, 0.5);
    await w.engine.runPass();
    expect(w.legs()[0]).toMatchObject({ leg: 'S', status: 'filled_unconfirmed', sol_out_real_lamports: null, fill_multiple: null });
    expect(w.closed()).toHaveLength(1);
    expect(w.closed()[0].realized_sol_net_lamports).toBeNull();
    expect(w.closed()[0].close_account_status).toBe('closed');
  });

  it('an entry that was never verified (a recovered buy) has a null realized net too', async () => {
    const w = world();
    const p = addPosition(w, { spent: null, fillSource: 'unverified' });
    setMultiple(w, p.ca, 0.5);
    await w.engine.runPass();
    expect(w.closed()[0].realized_sol_net_lamports).toBeNull();
  });

  it('a position opened from an unverified buy (boot recovery) takes its basis from the first quote and is exited like any other', async () => {
    const w = world();
    const ca = newCa();
    const pos = w.store.openFromBuy({ sig: newSig(), signal_id: 'dec_r', ca, wallet_id: 'w1', owner: newCa(), arm: 'B1', route: 'pf-direct',
      sol_in_lamports: '50000000', quote_tokens_out: '250000000', last_valid_block_height: 9, submitted_at: START_MS }, 'unverified');
    w.balances.set(ca, 250_000_000n);
    w.price.set(ca, BASE_PRICE);
    await w.engine.runPass();                    // first quote: the basis
    expect(w.store.get(pos.position_id)!.basis_sol_per_token).toBeCloseTo(BASE_PRICE, 18);
    for (const m of [0.8, 0.6]) { w.price.set(ca, BASE_PRICE * m); await w.passAt(5000); }
    expect(w.legs()[0]).toMatchObject({ leg: 'S', status: 'filled' });
    expect(w.sells[0].tokens).toBe(250_000_000n);
  });
});

describe('dry-run positions', () => {
  it('run EA on real quotes, report legs with quoted SOL only, and never send', async () => {
    const w = world();
    const p = addPosition(w, { dryRun: true });
    setMultiple(w, p.ca, 3.2);
    await w.engine.runPass();
    expect(w.sells).toHaveLength(0);
    expect(w.legs().map(l => `${l.leg}:${l.status}`)).toEqual(['TP1:filled', 'TP2:filled']);
    for (const l of w.legs()) {
      expect(l).toMatchObject({ dry_run: true, tx: null, send_at: null, confirm_at: null, sol_out_real_lamports: null, fill_multiple: null });
      expect(l.sol_out_quoted_lamports).not.toBeNull();
    }
    expect(BigInt(w.legs()[0].sol_out_quoted_lamports!) + BigInt(w.legs()[1].sol_out_quoted_lamports!)).toBe(BigInt(Math.round(BASE_PRICE * 3.2 * 600_000_000 * 1e9)));
    expect(w.store.get(p.position_id)!.tokens).toBe('400000000');
    setMultiple(w, p.ca, 0.5);
    await w.passAt(5000);
    expect(w.sells).toHaveLength(0);
    expect(w.legs().at(-1)).toMatchObject({ leg: 'R0', dry_run: true, status: 'filled' });   // 3.2 -> 0.5 in one pass is a hard rug
    expect(w.closed()).toHaveLength(1);
    expect(w.closed()[0]).toMatchObject({ realized_sol_net_lamports: null, close_account_status: 'skipped', rent_reclaimed_lamports: null });
    expect(w.closeCalls).toEqual([]);
    expect(w.order.filter(o => o === 'sell')).toEqual([]);
  });
});

describe('manual positions', () => {
  /** The order lane of runOrderMonitorPass, reduced to its decision (see manual-orders.test.ts). */
  function oldFires(o: { type: 'tp' | 'sl' | 'tsl'; pct: number; high: number; base: number }, multi: number): { fires: boolean; high: number } {
    const rel = multi / o.base;
    if (o.type === 'tp') return { fires: (rel - 1) * 100 >= o.pct, high: o.high };
    if (o.type === 'sl') return { fires: (rel - 1) * 100 <= o.pct, high: o.high };
    const high = Math.max(o.high, rel);
    return { fires: rel <= high * (1 + o.pct / 100), high };
  }

  it('B3-T14 a ManualOrderV2 SL / TP / TSL with a baseline_multi fires at the same relative move as today\'s runOrderMonitorPass', async () => {
    const baseline = 0.8;
    const cases: Array<{ type: 'tp' | 'sl' | 'tsl'; pct: number; path: number[]; sellPct: number }> = [
      { type: 'tp', pct: 100, path: [1.03, 1.55, 1.65], sellPct: 35 },
      { type: 'sl', pct: -20, path: [0.97, 0.7, 0.6], sellPct: 100 },
      { type: 'tsl', pct: -10, path: [1.0, 1.4, 1.3, 1.2], sellPct: 100 },
    ];
    for (const c of cases) {
      const w = world();
      const pos = addPosition(w, { origin: 'manual' });                  // basis = the entry price: multi = curSol / entrySol
      w.store.update(pos.position_id, { floor_base: BASE_PRICE * 0.01 });   // this test is about the order lane, not the -25% floor
      const o = addOrder(w, pos, { type: c.type, trigger_pct: c.pct, baseline_multi: baseline, sell_pct: c.sellPct });
      let state = { type: c.type, pct: c.pct, high: 1, base: baseline };
      let firedAt = -1;
      for (let i = 0; i < c.path.length; i++) {
        const ref = oldFires(state, c.path[i]);
        state = { ...state, high: ref.high };
        setMultiple(w, pos.ca, c.path[i]);
        if (i === 0) await w.engine.runPass(); else await w.passAt(5000);
        const sellsNow = w.sells.length;
        expect(sellsNow > 0, `${c.type} ${c.pct}% at multiple ${c.path[i]}`).toBe(ref.fires || firedAt >= 0);
        if (ref.fires && firedAt < 0) firedAt = i;
        if (firedAt >= 0) break;
      }
      expect(firedAt, `${c.type} never fired`).toBeGreaterThan(0);
      expect(w.sells).toHaveLength(1);
      const expectTokens = c.sellPct === 100 ? 1_000_000_000n : 350_000_000n;
      expect(w.sells[0].tokens).toBe(expectTokens);
      expect(w.legs().map(l => `${l.leg}:${l.status}`)).toEqual(['MANUAL:filled']);
      expect(w.store.getOrder(o.order_id)).toMatchObject({ active: false, deactivated_reason: 'filled' });
      if (c.type === 'tsl') expect(w.store.getOrder(o.order_id)!.peak_rel).toBeCloseTo(1.75, 9);   // 1.4 / 0.8, persisted
      expect(w.store.getOrder(o.order_id)!.baseline_multi).toBe(baseline);                          // copied, never reset
      expect(w.store.get(pos.position_id)!.closed_at !== null).toBe(c.sellPct === 100);
    }
  });

  it('the -25% floor is measured from the first evaluated quote and sells everything on the guaranteed-exit ladder', async () => {
    const w = world();
    const pos = addPosition(w, { origin: 'manual' });
    setMultiple(w, pos.ca, 0.9);
    await w.engine.runPass();                           // the anchor: 0.9 x entry
    expect(w.store.get(pos.position_id)!.floor_base).toBeCloseTo(BASE_PRICE * 0.9, 18);
    setMultiple(w, pos.ca, 0.7);                         // -22%: above the floor
    await w.passAt(5000);
    expect(w.sells).toHaveLength(0);
    setMultiple(w, pos.ca, 0.65);                        // -27.8%: below it
    await w.passAt(5000);
    expect(w.sells.map(s => s.slippageBps)).toEqual([4000]);
    expect(w.legs()[0]).toMatchObject({ leg: 'MANUAL', status: 'filled' });
    expect(w.closed()[0]).toMatchObject({ reason: 'manual' });
  });

  it('a hard rug on a manual position sells at the panic slippage as leg R0, and its orders go off with the position', async () => {
    const w = world();
    const pos = addPosition(w, { origin: 'manual' });
    const o = addOrder(w, pos, { type: 'tp', trigger_pct: 500 });
    setMultiple(w, pos.ca, 1.5);
    await w.engine.runPass();
    setMultiple(w, pos.ca, 0.8);                         // -46.7% between two passes
    await w.passAt(5000);
    expect(w.sells.map(s => s.slippageBps)).toEqual([9900]);
    expect(w.legs()[0]).toMatchObject({ leg: 'R0', status: 'filled' });
    expect(w.store.getOrder(o.order_id)).toMatchObject({ active: false, deactivated_reason: 'position-closed' });
  });

  it('a TP order fails like a take-profit (3 attempts, re-armed in between); an SL fails like a protective leg (2 attempts, then locked out)', async () => {
    const w = world({ sellScript: ['revert'] });
    const pos = addPosition(w, { origin: 'manual' });
    w.store.update(pos.position_id, { floor_base: BASE_PRICE * 0.01 });
    const tp = addOrder(w, pos, { type: 'tp', trigger_pct: 50, baseline_multi: 1 });
    setMultiple(w, pos.ca, 1.6);
    await w.engine.runPass();
    expect(w.store.getOrder(tp.order_id)).toMatchObject({ active: true, attempts: 1 });
    await w.passAt(5000);
    expect(w.store.getOrder(tp.order_id)).toMatchObject({ active: true, attempts: 2 });
    await w.passAt(5000);
    expect(w.store.getOrder(tp.order_id)).toMatchObject({ active: false, attempts: 3 });
    expect(w.sells.map(s => s.slippageBps)).toEqual([300, 900, 1500]);

    const v = world({ sellScript: ['revert'] });
    const pv = addPosition(v, { origin: 'manual' });
    v.store.update(pv.position_id, { floor_base: BASE_PRICE * 0.01 });
    const sl = addOrder(v, pv, { type: 'sl', trigger_pct: -10, baseline_multi: 1 });
    setMultiple(v, pv.ca, 0.8);
    await v.engine.runPass();
    expect(v.store.getOrder(sl.order_id)).toMatchObject({ active: true, attempts: 1 });
    await v.passAt(5000);
    expect(v.store.getOrder(sl.order_id)).toMatchObject({ active: false, attempts: 2, deactivated_reason: 'locked-out' });
    expect(v.sells.map(s => s.slippageBps)).toEqual([4000, 9900, 4000, 9900]);
    expect(v.notices.some(n => n.includes('auto-exit is OFF'))).toBe(true);
  });

  it('runs only the protective orders when the only quote is the Engine price', async () => {
    const solUsd = 100;
    const w = world({ valuation: ww => realValuation(ww, { onchain: null, jupiter: null, engineUsd: { token: BASE_PRICE * 1.6 * 1e6 * solUsd, sol: solUsd, tokenAgeMs: 5000 } }) });
    const pos = addPosition(w, { origin: 'manual' });
    w.store.update(pos.position_id, { floor_base: BASE_PRICE * 0.01 });
    const tp = addOrder(w, pos, { type: 'tp', trigger_pct: 50, baseline_multi: 1 });
    await w.engine.runPass();
    await w.passAt(5000);
    expect(w.sells).toHaveLength(0);
    expect(w.store.getOrder(tp.order_id)).toMatchObject({ active: true, baseline_multi: 1 });
  });

  it('a TP on a CA whose breaker is locked is switched off (ca-locked), as before; the SL on the same CA still sells', async () => {
    const w = world();
    const pos = addPosition(w, { origin: 'manual' });
    w.store.update(pos.position_id, { floor_base: BASE_PRICE * 0.01 });
    const tp = addOrder(w, pos, { type: 'tp', trigger_pct: 50, baseline_multi: 1 });
    for (let i = 0; i < 5; i++) w.engine.breaker.bump(pos.ca);
    setMultiple(w, pos.ca, 1.6);
    await w.engine.runPass();
    expect(w.sells).toHaveLength(0);
    expect(w.store.getOrder(tp.order_id)).toMatchObject({ active: false, deactivated_reason: 'ca-locked' });
    const sl = addOrder(w, pos, { type: 'sl', trigger_pct: -10, baseline_multi: 2 });   // 1.6 / 2 = -20%
    await w.passAt(5000);
    expect(w.sells).toHaveLength(1);
    expect(w.store.getOrder(sl.order_id)).toMatchObject({ active: false, deactivated_reason: 'filled' });
  });
});

describe('engine plumbing', () => {
  it('start() drives passes from the clock and stop() ends them', async () => {
    const w = world();
    const p = addPosition(w);
    setMultiple(w, p.ca, 0.5);
    w.engine.start();
    w.engine.start();                              // idempotent
    await w.clock.advance(1000);
    expect(w.sells).toHaveLength(1);
    w.engine.stop();
    expect(w.clock.pendingTimers()).toBe(0);
  });

  it('closeExternal closes a position the chain no longer holds without a sale', async () => {
    const w = world();
    const p = addPosition(w);
    await w.engine.closeExternal(p.position_id);
    expect(w.closed()).toHaveLength(1);
    expect(w.closed()[0]).toMatchObject({ reason: 'external_sell', realized_sol_net_lamports: null });
    await w.engine.closeExternal(p.position_id);   // a second call changes nothing
    expect(w.closed()).toHaveLength(1);
  });

  it('a pass that throws inside one group does not stop the others', async () => {
    const w = world();
    const bad = addPosition(w);
    const good = addPosition(w, { wallet: 'w2' });
    setMultiple(w, good.ca, 0.5);
    const origUpdate = w.store.update.bind(w.store);
    w.store.update = (id, patch) => { if (id === bad.position_id) throw new Error('disk full'); return origUpdate(id, patch); };
    await w.engine.runPass();
    expect(w.legs().map(l => l.position_id)).toEqual([good.position_id]);
    expect(w.logs.some(l => l.startsWith('err') && l.includes('disk full'))).toBe(true);
  });
});

describe('events', () => {
  /** Every event the world's outbox holds must pass the real contract validator (the Engine would dead-letter anything else). */
  function expectAccepted(w: World): void {
    const events = w.outbox.events;
    expect(events.length).toBeGreaterThan(0);
    const res = validateBotBatch({ events }, w.clock.now());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const e of res.events) expect(e.result.ok, `${events[e.index].type}: ${e.result.ok ? '' : e.result.reason}`).toBe(true);
  }

  it('every exit.leg and position.closed the engine emits is accepted by the contract validator, in every kind of flow', async () => {
    // a full protective exit with CloseAccount
    const a = world();
    const pa = addPosition(a);
    setMultiple(a, pa.ca, 0.5);
    await a.engine.runPass();
    expectAccepted(a);

    // two take-profits in one sell, then failed attempts and a lockout
    const b = world({ sellScript: ['ok', 'revert'] });
    const pb = addPosition(b);
    setMultiple(b, pb.ca, 3.2);
    await b.engine.runPass();
    setMultiple(b, pb.ca, 0.5);
    await b.passAt(5000);
    await b.passAt(5000);
    await b.passAt(5000);
    expect(b.legs().map(l => l.status)).toEqual(['filled', 'filled', 'failed', 'locked_out']);
    expectAccepted(b);

    // dry run, a cancel without a price, a manual order and the floor
    const c = world();
    const pc = addPosition(c, { dryRun: true });
    setMultiple(c, pc.ca, 3.2);
    await c.engine.runPass();
    expectAccepted(c);
    const d = world();
    const pd = addPosition(d);
    setMultiple(d, pd.ca, null);
    await d.engine.cancelPosition(pd.position_id);
    expectAccepted(d);
    const e = world();
    const pe = addPosition(e, { origin: 'manual' });
    addOrder(e, pe, { type: 'tp', trigger_pct: 50, baseline_multi: 1, sell_pct: 35 });
    setMultiple(e, pe.ca, 1.6);
    await e.engine.runPass();
    setMultiple(e, pe.ca, 0.5);
    await e.passAt(5000);
    expectAccepted(e);

    // a sale whose fee exceeds its proceeds: the unsigned wire field reports 0, the realized net is negative and signed
    const f = world();
    f.closeResult = { status: 'skipped', tx: null, rentLamports: null, reason: 'balance above zero' };
    const pf = addPosition(f, { tokens: 100n, spent: 20_000n });
    setMultiple(f, pf.ca, 0.5);
    await f.engine.runPass();
    expect(f.legs()[0].sol_out_real_lamports).toBe('0');
    expect(f.closed()[0].realized_sol_net_lamports).toBe(String(-4990 - 20_000));
    expectAccepted(f);
  });
});

describe('pure helpers', () => {
  it('scaleTokens takes round(original x fraction) in exact integer arithmetic', () => {
    expect(scaleTokens(1_000_000_000n, 0.6)).toBe(600_000_000n);
    expect(scaleTokens(10n, 0.25)).toBe(3n);                 // round half up
    expect(scaleTokens(123_456_789_012_345_678n, 0.3)).toBe(37_037_036_703_703_703n);
    expect(scaleTokens(100n, 0)).toBe(0n);
    expect(scaleTokens(100n, 5)).toBe(100n);
  });

  it('soldFractionOf derives the share sold from the token counts', () => {
    expect(soldFractionOf(1000n, 400n)).toBe(0.6);
    expect(soldFractionOf(1000n, 1000n)).toBe(0);
    expect(soldFractionOf(1000n, 1500n)).toBe(0);
    expect(soldFractionOf(0n, 0n)).toBe(1);
  });

  it('allocate splits a total in proportion and the parts always add up', () => {
    expect(allocate(600n, [0.3, 0.3])).toEqual([300n, 300n]);
    const parts = allocate(1001n, [0.3, 0.3, 0.2]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(1001n);
    expect(allocate(7n, [0, 0])).toEqual([3n, 4n]);
    expect(allocate(5n, [])).toEqual([]);
  });

  it('shortCa keeps both ends of a long address', () => {
    expect(shortCa('abcdefghijklmnop')).toBe('abcd…mnop');
    expect(shortCa('short')).toBe('short');
  });

  it('createExitEngine can be built over its own breaker and mutex (the ones bot.ts will share)', () => {
    const w = world();
    expect(w.engine.breaker.isLocked('x')).toBe(false);
    expect(typeof createExitEngine).toBe('function');
  });
});
