// TG Bot copy of E\src\shared-tests\exit-policy.test.ts (R0-SHIMPL): the same suite over the byte-identical copies of the shared files in src/shared.
// Derived from the Engine file: the property tests and the acceptance ids stay in the Engine file.
// Tests of the exit policy (C02 section 5 and section 7): the policy file, its version and the pure evaluateExit. The TG Bot runs the same suite
// from B\src\shared-tests\exit-policy.test.ts through its byte-identical copies of the shared files.
import { describe, it, expect, vi } from 'vitest';
import policiesJson from '../shared/exit-policy/exit-policies.json';
import { evaluateExit, loadPolicies, policyVersion } from '../shared/exit-policy/exit-policy';
import type { ExitQuote, ExitState, LegId, LegSpec, ResolvedPolicy } from '../shared/exit-policy/exit-policy';

const POLICIES = loadPolicies(policiesJson);
const EA = POLICIES.EA;
const OPENED = 1_790_000_000_000;
const SRC = 'onchain';

/** basis 1, so a quote value is the multiple m. */
const state = (over: Partial<ExitState> = {}): ExitState => ({ basis: 1, peak: 1, legsDone: [], soldFractionOfOriginal: 0, openedAt: OPENED, lastQuote: null, ...over });
const quote = (value: number, atOffsetMs = 60_000, src = SRC): ExitQuote => ({ value, at: OPENED + atOffsetMs, src });
const legs = (r: { actions: Array<{ leg: LegId }> }): LegId[] => r.actions.map(a => a.leg);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** The same policy object with its keys in the reverse order, at every depth. */
function reverseKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(reverseKeys);
  if (x !== null && typeof x === 'object') {
    const rec = x as Record<string, unknown>;
    return Object.fromEntries(Object.keys(rec).reverse().map(k => [k, reverseKeys(rec[k])]));
  }
  return x;
}
const unversioned = (p: ResolvedPolicy): Omit<ResolvedPolicy, 'version'> => { const { version: _v, ...rest } = p; return clone(rest); };

describe('exit policy file', () => {
  it('policyVersion is stable under key reordering and changes when any threshold changes', () => {
    for (const id of ['EA', 'EA-C1', 'HOLD-1H'] as const) {
      const p = POLICIES[id];
      expect(p.version).toMatch(/^[0-9a-f]{16}$/);
      const bare = unversioned(p);
      expect(policyVersion(bare), `${id} version is the version of its own resolved object`).toBe(p.version);
      expect(policyVersion(reverseKeys(bare) as Omit<ResolvedPolicy, 'version'>), `${id} stable under reordering`).toBe(p.version);
    }
    // loading the file with every key of every object reversed gives the same versions
    const reloaded = loadPolicies(reverseKeys(clone(policiesJson)));
    for (const id of ['EA', 'EA-C1', 'HOLD-1H'] as const) expect(reloaded[id].version).toBe(POLICIES[id].version);
    // three different policies, three different versions
    expect(new Set([POLICIES.EA.version, POLICIES['EA-C1'].version, POLICIES['HOLD-1H'].version]).size).toBe(3);

    // changing any threshold of any leg changes the version, and no two changes collide
    const numericKeys: Array<keyof LegSpec> = ['dropPct', 'maxGapS', 'atMultiple', 'whilePeakBelow', 'sellFractionOfOriginal', 'armPeakMultiple', 'exitAtPeakFraction', 'afterMs', 'belowMultiple'];
    const seen = new Set<string>([EA.version]);
    let changes = 0;
    const base = unversioned(EA);
    for (let i = 0; i < base.legs.length; i++) {
      for (const key of numericKeys) {
        const current = base.legs[i][key];
        if (typeof current !== 'number') continue;
        const changed = clone(base);
        (changed.legs[i] as unknown as Record<string, number>)[key] = current + 0.01;
        const v = policyVersion(changed);
        expect(seen.has(v), `${base.legs[i].id}.${key} must change the version`).toBe(false);
        seen.add(v);
        changes++;
      }
    }
    expect(changes).toBeGreaterThanOrEqual(12);
    // so do the order, the protective flags and the close-account flag
    const reordered = clone(base);
    reordered.order = ['S', 'R0', ...reordered.order.slice(2)];
    const unprotected = clone(base);
    unprotected.legs[0].protective = false;
    const keepOpen = clone(base);
    keepOpen.closeAccountOnFullExit = false;
    for (const other of [reordered, unprotected, keepOpen]) expect(policyVersion(other)).not.toBe(EA.version);
  });

  it('loadPolicies resolves EA, EA-C1 (EA plus C1) and HOLD-1H exactly as the file states', () => {
    expect(EA.id).toBe('EA');
    expect(EA.order).toEqual(['R0', 'S', 'TP1', 'TP2', 'TP3', 'T', 'H']);
    expect(EA.closeAccountOnFullExit).toBe(true);
    const byId = Object.fromEntries(EA.legs.map(l => [l.id, l]));
    expect(byId.R0).toEqual({ id: 'R0', kind: 'hard_rug', protective: true, dropPct: 40, maxGapS: 15 });
    expect(byId.S).toEqual({ id: 'S', kind: 'rug_stop', protective: true, atMultiple: 0.62, whilePeakBelow: 1.5 });
    expect(byId.TP1).toEqual({ id: 'TP1', kind: 'take_profit', protective: false, atMultiple: 2, sellFractionOfOriginal: 0.3 });
    expect(byId.TP2).toEqual({ id: 'TP2', kind: 'take_profit', protective: false, atMultiple: 3, sellFractionOfOriginal: 0.3 });
    expect(byId.TP3).toEqual({ id: 'TP3', kind: 'take_profit', protective: false, atMultiple: 5, sellFractionOfOriginal: 0.2 });
    expect(byId.T).toEqual({ id: 'T', kind: 'trail', protective: true, armPeakMultiple: 1.5, exitAtPeakFraction: 0.6 });
    expect(byId.H).toEqual({ id: 'H', kind: 'max_hold', protective: true, afterMs: 21_600_000 });

    const c1 = POLICIES['EA-C1'];
    expect(c1.id).toBe('EA-C1');
    expect(c1.order).toEqual(['R0', 'S', 'C1', 'TP1', 'TP2', 'TP3', 'T', 'H']);
    expect(c1.legs.map(l => l.id)).toEqual([...EA.legs.map(l => l.id), 'C1']);
    expect(c1.legs.find(l => l.id === 'C1')).toEqual({ id: 'C1', kind: 'no_ignition', protective: true, afterMs: 1_800_000, whilePeakBelow: 1.5, belowMultiple: 1 });
    expect(c1.closeAccountOnFullExit).toBe(true);

    const hold = POLICIES['HOLD-1H'];
    expect(hold.order).toEqual(['H']);
    expect(hold.legs).toEqual([{ id: 'H', kind: 'max_hold', protective: true, afterMs: 3_600_000 }]);
    expect(hold.closeAccountOnFullExit).toBe(true);
  });

  it('loadPolicies refuses a malformed file and never invents a policy', () => {
    const broken = (edit: (j: any) => void): unknown => { const j = clone(policiesJson) as any; edit(j); return j; };
    expect(() => loadPolicies(null)).toThrow();
    expect(() => loadPolicies({ schema: 2, policies: {} })).toThrow(/schema/);
    expect(() => loadPolicies(broken(j => { delete j.policies.EA; }))).toThrow(/EA is missing|extends/);
    expect(() => loadPolicies(broken(j => { j.policies.FAST = j.policies.EA; }))).toThrow(/unknown policy id/);
    expect(() => loadPolicies(broken(j => { delete j.policies.EA.legs[0].drop_pct; }))).toThrow(/drop_pct/);
    expect(() => loadPolicies(broken(j => { j.policies.EA.legs[2].sell_fraction_of_original = 1.5; }))).toThrow(/sell_fraction_of_original/);
    expect(() => loadPolicies(broken(j => { j.policies.EA.legs[2].sell_fraction_of_original = 0.9; }))).toThrow(/more than 1/);
    expect(() => loadPolicies(broken(j => { j.policies.EA.evaluation_order = ['R0', 'S']; }))).toThrow(/missing from evaluation_order/);
    expect(() => loadPolicies(broken(j => { j.policies.EA.evaluation_order.push('ZZ'); }))).toThrow(/does not exist/);
    expect(() => loadPolicies(broken(j => { j.policies.EA.legs[0].id = 'X9'; }))).toThrow(/leg id/);
    expect(() => loadPolicies(broken(j => { j.policies.EA.legs[0].kind = 'panic'; }))).toThrow(/leg kind/);
    expect(() => loadPolicies(broken(j => { j.policies.EA.legs[0].sell = 'half'; }))).toThrow(/sell/);
    expect(() => loadPolicies(broken(j => { delete j.policies.EA.close_account_on_full_exit; }))).toThrow(/close_account_on_full_exit/);
    expect(() => loadPolicies(broken(j => { j.policies['EA-C1'].extends = 'EA-C1'; }))).toThrow(/extends itself/);
    expect(() => loadPolicies(broken(j => { delete j.policies['EA-C1'].evaluation_order; }))).toThrow(/evaluation_order/);
  });
});

describe('evaluateExit', () => {
  it('the EA take-profit legs, as sells of the original, are 30%, 42.857% and 50% of the current bag', () => {
    let s = state();
    const asBagShare: number[] = [];
    for (const [i, m] of [2.0, 3.0, 5.0].entries()) {
      const before = s.soldFractionOfOriginal;
      const r = evaluateExit(EA, s, quote(m, 60_000 * (i + 1)), OPENED + 60_000 * (i + 1));
      expect(legs(r)).toEqual([`TP${i + 1}`]);
      asBagShare.push(r.actions[0].sellFractionOfOriginal / (1 - before));
      s = r.next;
    }
    expect(asBagShare[0]).toBeCloseTo(0.3, 9);
    expect(asBagShare[1]).toBeCloseTo(0.3 / 0.7, 9);
    expect(asBagShare[1] * 100).toBeCloseTo(42.857142857, 8);
    expect(asBagShare[2]).toBeCloseTo(0.5, 9);
    expect(s.soldFractionOfOriginal).toBeCloseTo(0.8, 9);
    expect(s.legsDone).toEqual(['TP1', 'TP2', 'TP3']);
  });

  it('the trail: peak 1.6 then m 0.96 fires T; peak 1.49 and m 0.62 fires S, not T', () => {
    const trail = evaluateExit(EA, state({ peak: 1.6 }), quote(0.96), OPENED + 60_000);
    expect(trail.actions).toEqual([{ leg: 'T', sellFractionOfOriginal: 1, protective: true }]);
    expect(trail.next.legsDone).toEqual(['T']);
    expect(trail.next.soldFractionOfOriginal).toBe(1);
    expect(trail.next.peak).toBe(1.6);
    // just above the trail line nothing fires
    expect(evaluateExit(EA, state({ peak: 1.6 }), quote(0.97), OPENED + 60_000).actions).toEqual([]);
    const stop = evaluateExit(EA, state({ peak: 1.49 }), quote(0.62), OPENED + 60_000);
    expect(stop.actions).toEqual([{ leg: 'S', sellFractionOfOriginal: 1, protective: true }]);
    expect(evaluateExit(EA, state({ peak: 1.49 }), quote(0.63), OPENED + 60_000).actions).toEqual([]);
    // once the peak reached 1.5 the rug stop is off: m 0.62 after a 1.5 peak is a trail exit (0.62 <= 0.9)
    expect(legs(evaluateExit(EA, state({ peak: 1.5 }), quote(0.62), OPENED + 60_000))).toEqual(['T']);
    // the peak moves up with the quote
    expect(evaluateExit(EA, state({ peak: 1.2 }), quote(1.4), OPENED + 60_000).next.peak).toBe(1.4);
  });

  it('a protective leg pre-empts the take-profits: m 2.1 with H due is one action H selling the remainder', () => {
    const due = OPENED + 21_600_000;
    const r = evaluateExit(EA, state({ peak: 2.1 }), quote(2.1, 21_600_000), due);
    expect(r.actions).toEqual([{ leg: 'H', sellFractionOfOriginal: 1, protective: true }]);
    expect(r.next.legsDone).toEqual(['H']);                                   // TP1 was not evaluated, so it is not marked
    // with TP1 already sold the remainder is 0.7
    const after = evaluateExit(EA, state({ peak: 2.1, legsDone: ['TP1'], soldFractionOfOriginal: 0.3 }), quote(2.1, 21_600_000), due);
    expect(after.actions).toHaveLength(1);
    expect(after.actions[0].leg).toBe('H');
    expect(after.actions[0].sellFractionOfOriginal).toBeCloseTo(0.7, 12);
    expect(after.next.soldFractionOfOriginal).toBe(1);
    // the trail also pre-empts a take-profit: peak 5.5, m 3.2 (<= 0.6 * 5.5) with TP2 in reach
    expect(legs(evaluateExit(EA, state({ peak: 5.5, legsDone: ['TP1'], soldFractionOfOriginal: 0.3 }), quote(3.2), OPENED + 60_000))).toEqual(['T']);
    // before H is due the take-profit goes out
    expect(legs(evaluateExit(EA, state({ peak: 2.1 }), quote(2.1, 21_599_999), OPENED + 21_599_999))).toEqual(['TP1']);
    // and nothing is sold twice once the position is gone
    expect(evaluateExit(EA, r.next, quote(2.1, 21_700_000), due + 100_000).actions).toEqual([]);
  });

  it('several take-profits on one quote: m 3.2 with none done is TP1 and TP2 (0.30 + 0.30)', () => {
    const r = evaluateExit(EA, state(), quote(3.2), OPENED + 60_000);
    expect(r.actions).toEqual([
      { leg: 'TP1', sellFractionOfOriginal: 0.3, protective: false },
      { leg: 'TP2', sellFractionOfOriginal: 0.3, protective: false },
    ]);
    expect(r.next.legsDone).toEqual(['TP1', 'TP2']);
    expect(r.next.soldFractionOfOriginal).toBeCloseTo(0.6, 12);
    expect(r.next.peak).toBe(3.2);
    expect(r.next.lastQuote).toEqual({ value: 3.2, at: OPENED + 60_000, src: SRC });
    // a leg already done is not sold again
    expect(legs(evaluateExit(EA, r.next, quote(3.3, 120_000), OPENED + 120_000))).toEqual([]);
    expect(legs(evaluateExit(EA, r.next, quote(5.1, 180_000), OPENED + 180_000))).toEqual(['TP3']);
  });

  it('R0 needs the same source: sources that differ do not fire it; same source, 14 s apart, -41% fires it', () => {
    const last = { value: 1, at: OPENED + 10_000, src: 'onchain' };
    const fires = evaluateExit(EA, state({ lastQuote: last }), { value: 0.59, at: last.at + 14_000, src: 'onchain' }, last.at + 14_000);
    expect(fires.actions).toEqual([{ leg: 'R0', sellFractionOfOriginal: 1, protective: true }]);          // R0 comes first, ahead of the rug stop
    const otherSource = evaluateExit(EA, state({ lastQuote: last }), { value: 0.59, at: last.at + 14_000, src: 'jupiter' }, last.at + 14_000);
    expect(legs(otherSource)).toEqual(['S']);                                                              // the rug stop catches it, R0 does not
    const tooLate = evaluateExit(EA, state({ lastQuote: last }), { value: 0.59, at: last.at + 16_000, src: 'onchain' }, last.at + 16_000);
    expect(legs(tooLate)).toEqual(['S']);
    // R0 alone (no other leg in reach): peak 1.2, quote falls 41.7% from 1.2 to 0.7
    const calm = { value: 1.2, at: OPENED + 10_000, src: 'onchain' };
    const only = evaluateExit(EA, state({ peak: 1.2, lastQuote: calm }), { value: 0.7, at: calm.at + 14_000, src: 'onchain' }, calm.at + 14_000);
    expect(only.actions).toEqual([{ leg: 'R0', sellFractionOfOriginal: 1, protective: true }]);
    expect(evaluateExit(EA, state({ peak: 1.2, lastQuote: calm }), { value: 0.7, at: calm.at + 14_000, src: 'jupiter' }, calm.at + 14_000).actions).toEqual([]);
    expect(evaluateExit(EA, state({ peak: 1.2, lastQuote: calm }), { value: 0.7, at: calm.at + 15_001, src: 'onchain' }, calm.at + 15_001).actions).toEqual([]);
    expect(evaluateExit(EA, state({ peak: 1.2, lastQuote: calm }), { value: 0.73, at: calm.at + 14_000, src: 'onchain' }, calm.at + 14_000).actions, 'a 39.2% drop is not a hard rug').toEqual([]);
    expect(legs(evaluateExit(EA, state({ peak: 1.2, lastQuote: calm }), { value: 0.72, at: calm.at + 15_000, src: 'onchain' }, calm.at + 15_000)), 'exactly 40% in exactly 15 s').toEqual(['R0']);
    // no previous quote, no R0
    expect(evaluateExit(EA, state({ peak: 1.2 }), { value: 0.1, at: OPENED + 1000, src: 'onchain' }, OPENED + 1000).actions.map(a => a.leg)).toEqual(['S']);
  });

  it('skipLegs R0 means R0 never fires', () => {
    const calm = { value: 1.2, at: OPENED + 10_000, src: 'onchain' };
    const q = { value: 0.7, at: calm.at + 14_000, src: 'onchain' };
    expect(legs(evaluateExit(EA, state({ peak: 1.2, lastQuote: calm }), q, q.at))).toEqual(['R0']);
    const skipped = evaluateExit(EA, state({ peak: 1.2, lastQuote: calm }), q, q.at, { skipLegs: ['R0'] });
    expect(skipped.actions).toEqual([]);
    expect(skipped.next.legsDone).toEqual([]);
    // with the stop in reach the stop goes out instead; the skipped leg is never marked done
    const last = { value: 1, at: OPENED + 10_000, src: 'onchain' };
    const stop = evaluateExit(EA, state({ lastQuote: last }), { value: 0.59, at: last.at + 14_000, src: 'onchain' }, last.at + 14_000, { skipLegs: ['R0'] });
    expect(legs(stop)).toEqual(['S']);
    expect(stop.next.legsDone).toEqual(['S']);
  });

  it('C1 of EA-C1 fires from 30 minutes while the trail is unarmed and m is below 1; HOLD-1H sells after one hour', () => {
    const c1 = POLICIES['EA-C1'];
    const at30 = OPENED + 1_800_000;
    expect(legs(evaluateExit(c1, state(), quote(0.99, 1_800_000), at30))).toEqual(['C1']);
    expect(evaluateExit(c1, state(), quote(0.99, 1_799_999), at30 - 1).actions, 'not yet 30 minutes').toEqual([]);
    expect(evaluateExit(c1, state(), quote(1.0, 1_800_000), at30).actions, 'm must be below 1.00').toEqual([]);
    expect(evaluateExit(c1, state({ peak: 1.5 }), quote(0.99, 1_800_000), at30).actions.map(a => a.leg), 'trail armed: the trail line (0.9) is lower').toEqual([]);
    expect(evaluateExit(EA, state(), quote(0.99, 1_800_000), at30).actions, 'plain EA has no C1').toEqual([]);
    const hold = POLICIES['HOLD-1H'];
    expect(evaluateExit(hold, state(), quote(5, 3_599_999), OPENED + 3_599_999).actions, 'HOLD-1H has no take-profit').toEqual([]);
    expect(evaluateExit(hold, state(), quote(0.01, 3_600_000), OPENED + 3_600_000).actions).toEqual([{ leg: 'H', sellFractionOfOriginal: 1, protective: true }]);
  });

  it('evaluateExit is pure: it does not read the clock, does not change its input and refuses an unusable quote', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      const s = state({ peak: 1.6, legsDone: ['TP1'], soldFractionOfOriginal: 0.3, lastQuote: { value: 1.2, at: OPENED, src: SRC } });
      const frozen = JSON.stringify(s);
      const policyBefore = JSON.stringify(EA);
      evaluateExit(EA, s, quote(0.5), OPENED + 60_000);
      expect(JSON.stringify(s)).toBe(frozen);
      expect(JSON.stringify(EA)).toBe(policyBefore);
      expect(now).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.1]) expect(() => evaluateExit(EA, state(), quote(bad), OPENED + 1), String(bad)).toThrow(RangeError);
    for (const basis of [0, -1, Number.NaN]) expect(() => evaluateExit(EA, state({ basis }), quote(1), OPENED + 1), String(basis)).toThrow(RangeError);
    // a quote of exactly 0 (a drained token) is a real quote: the rug stop sells everything
    expect(legs(evaluateExit(EA, state(), quote(0), OPENED + 1))).toEqual(['S']);
  });
});
