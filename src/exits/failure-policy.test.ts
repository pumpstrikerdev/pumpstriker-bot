/**
 * failure-policy tests. The EX-5 cases are the verified grind-fix tests of `grind/fx-tgbot` (d3a2da8, ex c4fd4fe), moved here verbatim from
 * `bot/order-triggers.test.ts` (B30: the test moves to this file; the TSL / hard-rug cases moved to manual-orders.test.ts). The rest tests
 * what B30 adds on top of the six helpers: the leg ladders, the attempt budgets, the per-CA breaker, the (CA, wallet) mutex and the
 * landed-check.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TP_MAX_ATTEMPTS, isProtectiveOrderType, caLockBlocksOrder, tpAttemptSlippageBps, afterOrderSellFailure, priorSellLikelyLanded,
  PROTECTIVE_MAX_ATTEMPTS, PANIC_SLIPPAGE_BPS, MAX_FAILED_TX_PER_CA, afterLegFailure, slippageLadder, errorString, createCaBreaker,
  createSellMutex, sellKey, checkSellLanded, maxAttemptsFor, type LandedCheckDeps,
} from './failure-policy';

// Grind fix EX-5: order-lane failure handling (TP retry budget, breaker exemption).
describe('caLockBlocksOrder (per-CA breaker never disables SL/TSL)', () => {
  it('blocks a TP once the CA is locked', () => {
    expect(caLockBlocksOrder('tp', true)).toBe(true);
  });

  it('never blocks the protective SL/TSL orders, locked or not', () => {
    expect(caLockBlocksOrder('sl', true)).toBe(false);
    expect(caLockBlocksOrder('tsl', true)).toBe(false);
    expect(caLockBlocksOrder('sl', false)).toBe(false);
  });

  it('blocks nothing while the CA is unlocked', () => {
    expect(caLockBlocksOrder('tp', false)).toBe(false);
  });

  it('classifies only sl/tsl as protective', () => {
    expect(isProtectiveOrderType('sl')).toBe(true);
    expect(isProtectiveOrderType('tsl')).toBe(true);
    expect(isProtectiveOrderType('tp')).toBe(false);
    expect(isProtectiveOrderType(undefined)).toBe(false);
  });
});

describe('afterOrderSellFailure (bounded TP retry)', () => {
  it('re-arms a TP until it has failed TP_MAX_ATTEMPTS times, then deactivates it', () => {
    expect(TP_MAX_ATTEMPTS).toBe(3);
    const a1 = afterOrderSellFailure('tp', undefined);
    expect(a1).toEqual({ failedAttempts: 1, rearm: true });
    const a2 = afterOrderSellFailure('tp', a1.failedAttempts);
    expect(a2).toEqual({ failedAttempts: 2, rearm: true });
    const a3 = afterOrderSellFailure('tp', a2.failedAttempts);
    expect(a3).toEqual({ failedAttempts: 3, rearm: false });
  });

  it('keeps SL/TSL single-attempt (the hard-stop lane is their backstop)', () => {
    expect(afterOrderSellFailure('sl', undefined)).toEqual({ failedAttempts: 1, rearm: false });
    expect(afterOrderSellFailure('tsl', 0)).toEqual({ failedAttempts: 1, rearm: false });
  });

  it('repairs a corrupt persisted counter instead of trusting it', () => {
    expect(afterOrderSellFailure('tp', NaN)).toEqual({ failedAttempts: 1, rearm: true });
    expect(afterOrderSellFailure('tp', -4)).toEqual({ failedAttempts: 1, rearm: true });
  });

  it('a TP that already used its budget is never re-armed', () => {
    expect(afterOrderSellFailure('tp', 7).rearm).toBe(false);
  });
});

describe('tpAttemptSlippageBps (escalate to smartSlippageMax on retries)', () => {
  it('first attempt keeps the base, then midpoint, then the cap', () => {
    expect(tpAttemptSlippageBps(1, 300, 1500)).toBe(300);
    expect(tpAttemptSlippageBps(2, 300, 1500)).toBe(900);
    expect(tpAttemptSlippageBps(3, 300, 1500)).toBe(1500);
  });

  it('never exceeds the cap past the last attempt', () => {
    expect(tpAttemptSlippageBps(9, 300, 1500)).toBe(1500);
  });

  it('never drops below the base when the cap is lower or unusable', () => {
    expect(tpAttemptSlippageBps(3, 2000, 1500)).toBe(2000);
    expect(tpAttemptSlippageBps(3, 300, NaN)).toBe(300);
  });

  it('falls back to 300 bps on an unusable base', () => {
    expect(tpAttemptSlippageBps(1, NaN, 1500)).toBe(300);
    expect(tpAttemptSlippageBps(3, 0, 1500)).toBe(1500);
  });
});

describe('priorSellLikelyLanded (no double TP sell on a retry)', () => {
  it('true when the balance already dropped by at least half the TP fraction', () => {
    // 35% TP on 1,000,000 tracked: landed → ~650,000 left
    expect(priorSellLikelyLanded(1_000_000, 650_000, 35)).toBe(true);
    expect(priorSellLikelyLanded(1_000_000, 825_000, 35)).toBe(true);   // exactly half the fraction
  });

  it('false when the balance is intact (a real failure) or above tracked', () => {
    expect(priorSellLikelyLanded(1_000_000, 1_000_000, 35)).toBe(false);
    expect(priorSellLikelyLanded(1_000_000, 990_000, 35)).toBe(false);   // dust drift
    expect(priorSellLikelyLanded(1_000_000, 1_050_000, 35)).toBe(false);
  });

  it('false on unknown or invalid inputs, so the retry proceeds', () => {
    expect(priorSellLikelyLanded(1_000_000, null, 35)).toBe(false);
    expect(priorSellLikelyLanded(1_000_000, undefined, 35)).toBe(false);
    expect(priorSellLikelyLanded(1_000_000, NaN, 35)).toBe(false);
    expect(priorSellLikelyLanded(0, 500, 35)).toBe(false);
    expect(priorSellLikelyLanded(1_000_000, 500_000, 0)).toBe(false);
  });

  it('a 100% TP counts as landed once at most half the bag is left', () => {
    expect(priorSellLikelyLanded(1_000_000, 400_000, 100)).toBe(true);
    expect(priorSellLikelyLanded(1_000_000, 600_000, 100)).toBe(false);
  });
});

describe('EX-5 order-lane walk-through', () => {
  it('B3-T06 both EX-5 walk-throughs: a TP that reverts twice fills on the third tick at the retry cap; one that keeps reverting stops after three attempts', () => {
    // Walk-through 1: revert, revert, fill.
    {
      const order: { type: string; active: boolean; failedAttempts?: number } = { type: 'tp', active: true };
      const slips: number[] = [];
      const outcomes = [false, false, true];   // revert, revert, fill
      for (const filled of outcomes) {
        if (!order.active) break;
        order.active = false;   // deactivate before attempting
        slips.push(tpAttemptSlippageBps((order.failedAttempts || 0) + 1, 300, 1500));
        if (filled) break;
        const fr = afterOrderSellFailure(order.type, order.failedAttempts);
        order.failedAttempts = fr.failedAttempts;
        order.active = fr.rearm;
      }
      expect(slips).toEqual([300, 900, 1500]);
      expect(order.failedAttempts).toBe(2);
    }
    // Walk-through 2: it never fills; bounded fee burn.
    {
      const order: { type: string; active: boolean; failedAttempts?: number } = { type: 'tp', active: true };
      let attempts = 0;
      for (let tick = 0; tick < 10 && order.active; tick++) {
        order.active = false;
        attempts++;
        const fr = afterOrderSellFailure(order.type, order.failedAttempts);
        order.failedAttempts = fr.failedAttempts;
        order.active = fr.rearm;
      }
      expect(attempts).toBe(TP_MAX_ATTEMPTS);
      expect(order.active).toBe(false);
    }
  });
});

// (the re-export shim `bot/order-triggers.ts` and its test case were removed by R4-B6: bot.ts no longer imports it)

// ---------------------------------------------------------------------------------------------------------------------------------
// B30 additions
// ---------------------------------------------------------------------------------------------------------------------------------

describe('attempt budgets', () => {
  it('a take-profit has 3 attempts and then stops; a protective leg has 2 and is then locked out', () => {
    expect(maxAttemptsFor('tp')).toBe(TP_MAX_ATTEMPTS);
    for (const k of ['protective', 'rug', 'cancel'] as const) expect(maxAttemptsFor(k)).toBe(PROTECTIVE_MAX_ATTEMPTS);
    expect(afterLegFailure('tp', 2)).toEqual({ failedAttempts: 3, rearm: false, lockedOut: false });
    expect(afterLegFailure('protective', undefined)).toEqual({ failedAttempts: 1, rearm: true, lockedOut: false });
    expect(afterLegFailure('protective', 1)).toEqual({ failedAttempts: 2, rearm: false, lockedOut: true });
    expect(afterLegFailure('cancel', NaN)).toEqual({ failedAttempts: 1, rearm: true, lockedOut: false });
  });
});

describe('slippageLadder', () => {
  it('a take-profit is one send per attempt at the escalating slippage', () => {
    expect(slippageLadder('tp', 1, 300, 1500)).toEqual([300]);
    expect(slippageLadder('tp', 2, 300, 1500)).toEqual([900]);
    expect(slippageLadder('tp', 3, 300, 1500)).toEqual([1500]);
  });

  it('a protective exit is the guaranteed exit at the 4000 bps cap, then the 9900 bps panic leg', () => {
    expect(slippageLadder('protective', 1, 300, 1500)).toEqual([4000, PANIC_SLIPPAGE_BPS]);
    expect(slippageLadder('protective', 1, 5000, 1500)).toEqual([5000, PANIC_SLIPPAGE_BPS]);
  });

  it('a hard rug goes to the panic leg at once; a cancel doubles the base up to 5000, then the panic leg', () => {
    expect(slippageLadder('rug', 1, 300, 1500)).toEqual([PANIC_SLIPPAGE_BPS]);
    expect(slippageLadder('cancel', 1, 300, 1500)).toEqual([600, 5000, PANIC_SLIPPAGE_BPS]);
    expect(slippageLadder('cancel', 1, 4000, 1500)).toEqual([5000, PANIC_SLIPPAGE_BPS]);
  });
});

describe('errorString (plan grind #64)', () => {
  it('redacts secrets and cuts to 200 characters, never a raw message', () => {
    const fakeKey = randomUUID();   // generated at run time (A-20): no key-shaped literal in the source
    const e = new Error(`All RPCs failed: https://rpc.example.test/?api-key=${fakeKey} ${'x'.repeat(400)}`);
    const s = errorString(e);
    expect(s.length).toBeLessThanOrEqual(200);
    expect(s).not.toContain(fakeKey);
    expect(errorString('plain text')).toBe('plain text');
    expect(errorString(null)).toBe('null');
  });
});

describe('the per-CA breaker', () => {
  it('counts consecutive failures, trips at the limit, resets on a success, and never blocks a protective leg', () => {
    const b = createCaBreaker();
    for (let i = 1; i < MAX_FAILED_TX_PER_CA; i++) expect(b.bump('ca1')).toBe(false);
    b.reset('ca1');   // a filled sell: the count restarts
    expect(b.failures('ca1')).toBe(0);
    for (let i = 1; i < MAX_FAILED_TX_PER_CA; i++) expect(b.bump('ca1')).toBe(false);
    expect(b.bump('ca1')).toBe(true);     // the fifth in a row trips it, exactly once
    expect(b.bump('ca1')).toBe(false);
    expect(b.isLocked('ca1')).toBe(true);
    expect(b.blocks('tp', 'ca1')).toBe(true);
    for (const k of ['protective', 'rug', 'cancel'] as const) expect(b.blocks(k, 'ca1')).toBe(false);
    expect(b.blocks('tp', 'other')).toBe(false);
    b.reset('ca1');
    expect(b.isLocked('ca1')).toBe(true);  // an existing lock lasts until restart
  });
});

describe('the (CA, wallet) sell mutex', () => {
  it('allows one sell at a time per key and frees it on release', () => {
    const m = createSellMutex();
    const k = sellKey('ca', 'w1');
    expect(m.tryAcquire(k)).toBe(true);
    expect(m.tryAcquire(k)).toBe(false);
    expect(m.tryAcquire(sellKey('ca', 'w2'))).toBe(true);
    m.release(k);
    expect(m.has(k)).toBe(false);
    expect(m.tryAcquire(k)).toBe(true);
  });
});

describe('checkSellLanded', () => {
  const deps = (o: { statuses?: Array<{ err?: unknown; confirmationStatus?: string | null } | null> | 'throws'; balance?: { rawAtoms: number } | null | 'throws' }): LandedCheckDeps => ({
    async signatureStatuses() { if (o.statuses === 'throws') throw new Error('rpc down'); return o.statuses ?? []; },
    async tokenBalance() { if (o.balance === 'throws') throw new Error('rpc down'); return o.balance === undefined ? null : o.balance; },
    async blockHeight() { return 2_000_000; },
  });
  const base = { owner: 'o', mint: 'm', trackedAtoms: 1000, sellPct: 100 };

  it('a signature confirmed without an error means landed, and names that signature', async () => {
    const v = await checkSellLanded(deps({ statuses: [{ err: { x: 1 }, confirmationStatus: 'confirmed' }, { err: null, confirmationStatus: 'finalized' }] }),
      { ...base, sigs: ['s1', 's2'] });
    expect(v).toEqual({ landed: true, via: 'status', sig: 's2' });
  });

  it('a failed or unknown signature falls through to the balance heuristic', async () => {
    const dropped = await checkSellLanded(deps({ statuses: [null], balance: { rawAtoms: 300 } }), { ...base, sigs: ['s1'] });
    expect(dropped).toEqual({ landed: true, via: 'balance', rawAtoms: 300 });
    const intact = await checkSellLanded(deps({ statuses: [null], balance: { rawAtoms: 1000 } }), { ...base, sigs: ['s1'] });
    expect(intact).toEqual({ landed: false, balance: 1000 });
  });

  it('an RPC error is unknown, never landed', async () => {
    const v = await checkSellLanded(deps({ statuses: 'throws', balance: 'throws' }), { ...base, sigs: ['s1'] });
    expect(v).toEqual({ landed: false, balance: null });
  });

  it('a confirmed zero balance after a send counts as landed; with nothing sent it is not landed (the reconcile rule owns it)', async () => {
    expect(await checkSellLanded(deps({ statuses: [null], balance: { rawAtoms: 0 } }), { ...base, sigs: ['s1'] })).toEqual({ landed: true, via: 'balance', rawAtoms: 0 });
    expect(await checkSellLanded(deps({ balance: { rawAtoms: 0 } }), { ...base, sigs: [] })).toEqual({ landed: false, balance: 0 });
  });
});
