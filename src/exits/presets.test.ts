/**
 * A-115 (CARD-MENU spec sections 6 and 8): the grade presets, their policy legs, the plan snapshot on a position and every money-safety rule
 * around them (EXITP-T01 ... EXITP-T12, MENU-T06 / MENU-T07 on the preset side). Real positions store and exit engine over the exits
 * testkit (temp folders, a FakeClock, a smartSell stub that counts sends); no network.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newCa, cleanupTempDirs, tempDir } from '../link/link-testkit';
import { validateBotBatch } from '../shared/contract/validate';
import type { PositionV2 } from '../bot-contracts';
import { policyIsReportable } from './exit-engine';
import { createPositionsStore, positionIdForBuy, type PendingBuyWithPlan } from './positions-store';
import { openPendingJournal } from '../autobuy/pending';
import { openManualBuyJournal } from './manual-buy-journal';
import { BASE_PRICE, POLICIES, START_MS, addPosition, makeWorld, newSig, setMultiple, type World } from './exits-testkit';
import {
  addRung, cardBuyPlan, clearAll, defaultGradePresets, editPreset, ladderProblem, materialize, normalizeExitPlan, normalizeGradePreset, planLine,
  presetItems, presetToPolicy, removeItem, resolvePlan, setMaxHold, setNoStop, setStop, setTrail, toggleEnabled, type CustomPreset, type ExitPlanSnapshot,
} from './presets';
import { applyCandidates, applyPlan, switchToOwnOrders } from './plan-apply';
import { importOldSignal } from '../bot/settings-import';

afterEach(() => cleanupTempDirs());
const EA = POLICIES.EA;
const WIRE = ['R0', 'S', 'TP1', 'TP2', 'TP3', 'T', 'H'];
const T0 = START_MS;
const noMutex = { has: (): boolean => false };

/** The owner's imported grade-B preset shape: stop −30% always, TP +50% sells 35%, TP +250% sells 22.75%, trail −35% once +120%. */
const presetB = (over: Partial<CustomPreset> = {}): CustomPreset => ({
  mode: 'custom', rev: 2, enabled: true, source: 'owner', updatedAt: T0, stop: { lossPct: 30, whilePeakBelowPct: null },
  ladder: [{ atPct: 50, sellPctOfOriginal: 35, trigger: 'entryPrice' }, { atPct: 250, sellPctOfOriginal: 22.75, trigger: 'price' }],
  trail: { armAfterPct: 120, trailPct: 35, trigger: 'mcap' }, maxHoldH: null, ...over,
});
const snapB = (p: CustomPreset = presetB()): ExitPlanSnapshot => ({ source: 'preset', grade: 'B', rev: p.rev, policy: presetToPolicy(p, EA, 'B') });

describe('presetToPolicy', () => {
  it('EXITP-T01 stop (always / while the peak is below), ladder, trail (arm 0 -> 1.0), max hold, R0 always present, the order, a stable version', () => {
    const p = presetToPolicy(presetB(), EA, 'B');
    expect(p.id).toBe('PRESET-B');
    expect(p.order).toEqual(['R0', 'S', 'TP1', 'TP2', 'T']);
    expect(p.legs[0]).toEqual(EA.legs.find(l => l.id === 'R0'));
    expect(p.legs.find(l => l.id === 'S')).toEqual({ id: 'S', kind: 'rug_stop', protective: true, atMultiple: 0.7, whilePeakBelow: Number.MAX_VALUE });
    expect(p.legs.filter(l => l.kind === 'take_profit')).toEqual([
      { id: 'TP1', kind: 'take_profit', protective: false, atMultiple: 1.5, sellFractionOfOriginal: 0.35 },
      { id: 'TP2', kind: 'take_profit', protective: false, atMultiple: 3.5, sellFractionOfOriginal: 0.2275 },
    ]);
    expect(p.legs.find(l => l.id === 'T')).toEqual({ id: 'T', kind: 'trail', protective: true, armPeakMultiple: 2.2, exitAtPeakFraction: 0.65 });
    expect(p.closeAccountOnFullExit).toBe(EA.closeAccountOnFullExit);
    expect(p.version).toMatch(/^[0-9a-f]{16}$/);
    expect(presetToPolicy(presetB(), EA, 'B').version).toBe(p.version);                 // stable
    expect(presetToPolicy(presetB({ maxHoldH: 6 }), EA, 'B').version).not.toBe(p.version);
    expect(presetToPolicy(presetB(), EA, 'A').id).toBe('PRESET-A');
    const cond = presetToPolicy(presetB({ stop: { lossPct: 38, whilePeakBelowPct: 50 }, trail: { armAfterPct: 0, trailPct: 30, trigger: 'entryPrice' }, maxHoldH: 6 }), EA, 'C');
    expect(cond.legs.find(l => l.id === 'S')).toMatchObject({ atMultiple: 0.62, whilePeakBelow: 1.5 });
    expect(cond.legs.find(l => l.id === 'T')).toMatchObject({ armPeakMultiple: 1, exitAtPeakFraction: 0.7 });
    expect(cond.legs.find(l => l.id === 'H')).toEqual({ id: 'H', kind: 'max_hold', protective: true, afterMs: 21_600_000 });
    expect(cond.order).toEqual(['R0', 'S', 'TP1', 'TP2', 'T', 'H']);
    // the first edit of a policy preset copies EA exactly: the same legs (only the id, hence the version, differs)
    const ea = presetToPolicy(materialize(EA, T0), EA, 'B');
    expect(ea.legs).toEqual(EA.legs);
    expect(ea.order).toEqual(EA.order);
  });

  it('EXITP-T12 every preset exit leg is a wire leg name (R0, S, TP1-TP3, T, H)', () => {
    const full = presetToPolicy(presetB({ ladder: [10, 20, 30].map(a => ({ atPct: a, sellPctOfOriginal: 10, trigger: 'entryPrice' as const })), maxHoldH: 12 }), EA, 'A');
    expect(full.legs.map(l => l.id)).toEqual(['R0', 'S', 'TP1', 'TP2', 'TP3', 'T', 'H']);
    for (const l of full.legs) expect(WIRE).toContain(l.id);
    expect(policyIsReportable(full)).toBe(true);
  });

  it('EXITP-T07 a ladder over 100%, more than 3 rungs or triggers that do not increase is refused by the input step, by load and by presetToPolicy', () => {
    const over = presetB({ ladder: [{ atPct: 50, sellPctOfOriginal: 60, trigger: 'entryPrice' }, { atPct: 100, sellPctOfOriginal: 50, trigger: 'entryPrice' }] });
    const four = presetB({ ladder: [10, 20, 30, 40].map(a => ({ atPct: a, sellPctOfOriginal: 10, trigger: 'entryPrice' as const })) });
    const flat = presetB({ ladder: [{ atPct: 50, sellPctOfOriginal: 10, trigger: 'entryPrice' }, { atPct: 50, sellPctOfOriginal: 10, trigger: 'entryPrice' }] });
    const down = presetB({ ladder: [{ atPct: 80, sellPctOfOriginal: 10, trigger: 'entryPrice' }, { atPct: 50, sellPctOfOriginal: 10, trigger: 'entryPrice' }] });
    expect(ladderProblem(over.ladder)).toBe('The take-profits would sell 110% of the position (max 100%).');
    expect(ladderProblem(four.ladder)).toBe('A preset holds at most 3 take-profits.');
    expect(ladderProblem(flat.ladder)).not.toBeNull();
    expect(ladderProblem(down.ladder)).not.toBeNull();
    for (const bad of [over, four, flat, down]) {
      expect(() => presetToPolicy(bad, EA, 'B')).toThrow(RangeError);
      const warns: string[] = [];
      expect(normalizeGradePreset(JSON.parse(JSON.stringify(bad)), m => warns.push(m), 'gradePresets.B')).toEqual({ mode: 'policy' });
      expect(warns).toHaveLength(1);
    }
    // the input step (MENU-T06): a 4th TP, a sum over 100 and a duplicate trigger are refused; nothing changes
    const three = presetB({ ladder: [10, 20, 30].map(a => ({ atPct: a, sellPctOfOriginal: 10, trigger: 'entryPrice' as const })) });
    expect(editPreset(three, EA, T0, addRung({ atPct: 40, sellPctOfOriginal: 5, trigger: 'entryPrice' }))).toEqual({ ok: false, reason: 'A preset holds at most 3 take-profits.' });
    expect(editPreset(presetB(), EA, T0, addRung({ atPct: 400, sellPctOfOriginal: 50, trigger: 'entryPrice' }))).toEqual({ ok: false, reason: 'The take-profits would sell 107.75% of the position (max 100%).' });
    expect(editPreset(presetB(), EA, T0, addRung({ atPct: 50, sellPctOfOriginal: 5, trigger: 'entryPrice' }))).toEqual({ ok: false, reason: 'There is already a take-profit at +50%.' });
    const ok = editPreset(presetB(), EA, T0 + 1, addRung({ atPct: 1000, sellPctOfOriginal: 20, trigger: 'mcap' }));
    expect(ok.ok && ok.preset.ladder.map(r => r.atPct)).toEqual([50, 250, 1000]);
    expect(ok.ok && ok.preset.rev).toBe(3);
  });

  it('EXITP-T08 / MENU-T07 a stop-less preset needs confirmedAt; R0 stays; no other path removes the stop; the import never yields a stop-less preset', () => {
    const noStop = presetB({ stop: { none: true, confirmedAt: T0 } });
    const p = presetToPolicy(noStop, EA, 'B');
    expect(p.legs.some(l => l.kind === 'rug_stop')).toBe(false);
    expect(p.legs[0].id).toBe('R0');
    expect(() => presetToPolicy(presetB({ stop: { none: true, confirmedAt: 0 } }), EA, 'B')).toThrow(RangeError);
    expect(normalizeGradePreset({ ...presetB(), stop: { none: true } }, () => undefined, 'x')).toEqual({ mode: 'policy' });
    // removing the stop by any other path is refused or keeps it
    expect(presetItems(presetB())[0]).toEqual({ kind: 'sl' });
    expect(editPreset(presetB(), EA, T0, removeItem(0))).toMatchObject({ ok: false });
    const cleared = editPreset(presetB(), EA, T0, clearAll);
    expect(cleared.ok && cleared.preset).toMatchObject({ stop: { lossPct: 30, whilePeakBelowPct: null }, ladder: [], trail: null, maxHoldH: null });
    const fromPolicy = editPreset({ mode: 'policy' }, EA, T0, clearAll);              // a policy preset: EA's stop is copied first
    expect(fromPolicy.ok && fromPolicy.preset.stop).toEqual({ lossPct: 38, whilePeakBelowPct: 50 });
    expect(normalizeGradePreset({ ...presetB(), stop: undefined }, () => undefined, 'x')).toEqual({ mode: 'policy' });   // a hand-edited file without a stop
    const confirmed = editPreset(presetB(), EA, T0 + 5, setNoStop(T0 + 5));
    expect(confirmed.ok && confirmed.preset.stop).toEqual({ none: true, confirmedAt: T0 + 5 });
    // the import: a tier without a stop-loss gets the policy's stop
    const imp = importOldSignal({ scoreTiers: [{ id: 't', label: 'x', minScore: 90, maxScore: 101, enabled: true, presets: [{ type: 'tp', triggerPct: 50, balance: 50 }] }] }, EA, T0);
    const a = imp.restored.gradePresets.A as CustomPreset;
    expect(a.stop).toEqual({ lossPct: 38, whilePeakBelowPct: 50 });
  });

  it('MENU-T06 the preset edits: stop, trail (arm -> trail), max hold, remove a rung, toggle; each bumps rev; a policy preset is copied first', () => {
    let cur = { mode: 'policy' } as CustomPreset | { mode: 'policy' };
    const step = (fn: Parameters<typeof editPreset>[3]): CustomPreset => { const r = editPreset(cur, EA, T0, fn); if (!r.ok) throw new Error(r.reason); cur = r.preset; return r.preset; };
    expect(step(setStop(25)).stop).toEqual({ lossPct: 25, whilePeakBelowPct: null });
    expect((cur as CustomPreset).rev).toBe(1);
    expect(step(setTrail({ armAfterPct: 0, trailPct: 20, trigger: 'price' })).trail).toEqual({ armAfterPct: 0, trailPct: 20, trigger: 'price' });
    expect(step(setMaxHold(12)).maxHoldH).toBe(12);
    const before = (cur as CustomPreset).ladder.length;
    const i = presetItems(cur as CustomPreset).findIndex(x => x.kind === 'tp');
    expect(step(removeItem(i)).ladder).toHaveLength(before - 1);
    expect(step(toggleEnabled).enabled).toBe(false);
    expect((cur as CustomPreset).rev).toBe(5);
  });
});

describe('which positions get a plan', () => {
  it('EXITP-T02 with every preset on the policy default, a live buy gets NO snapshot: the position and its position.opened are exactly as before', () => {
    const r = resolvePlan({ autoSellOnSignal: true, gradePresets: defaultGradePresets() }, 'B', EA);
    expect(r.snapshot).toBeNull();
    expect(r.playbook).toMatchObject({ source: 'policy', policyId: 'EA', version: EA.version, presetState: 'follows' });
    const dir = tempDir();
    const store = createPositionsStore({ dir, clock: { now: () => T0 } as never, policy: { id: 'EA', version: EA.version } });
    const pb = { sig: newSig(), signal_id: 'dec_x', ca: newCa(), wallet_id: 'w1', owner: 'o', arm: 'B1' as const, route: 'pf-direct' as const,
      sol_in_lamports: '10000000', quote_tokens_out: '5', last_valid_block_height: 9, submitted_at: T0 };
    const plain = store.openFromBuy(pb, { solSpentLamports: '10000000', tokensRaw: '5', feeLamports: '5000', confirmedAt: T0 });
    const withNull = store.openFromBuy({ ...pb, sig: newSig(), exit_plan: null } as PendingBuyWithPlan, { solSpentLamports: '10000000', tokensRaw: '5', feeLamports: '5000', confirmedAt: T0 });
    for (const p of [plain, withNull]) {
      expect(p.policy_id).toBe('EA');
      expect(p.policy_version).toBe(EA.version);
      expect('exit_plan' in p).toBe(false);
    }
    const file = fs.readFileSync(path.join(dir, 'positions-v2.json'), 'utf8');
    expect(file).not.toContain('exit_plan');
    // Auto-Sell by Grade OFF, or the preset switched off: the policy, and the card says why
    expect(resolvePlan({ autoSellOnSignal: false, gradePresets: { ...defaultGradePresets(), B: presetB() } }, 'B', EA)).toMatchObject({ snapshot: null, playbook: { presetState: 'auto-sell-off' } });
    expect(resolvePlan({ autoSellOnSignal: true, gradePresets: { ...defaultGradePresets(), B: presetB({ enabled: false }) } }, 'B', EA)).toMatchObject({ snapshot: null, playbook: { presetState: 'preset-off' } });
  });

  it('EXITP-T03 an edited grade-B preset applies to a NEW live buy (snapshot, PRESET-B and its version on the position) and to a card buy', () => {
    const settings = { autoSellOnSignal: true, gradePresets: { ...defaultGradePresets(), B: presetB() } };
    const r = resolvePlan(settings, 'B', EA);
    expect(r.snapshot).toMatchObject({ source: 'preset', grade: 'B', rev: 2, policy: { id: 'PRESET-B' } });
    expect(r.playbook).toMatchObject({ source: 'preset', policyId: 'PRESET-B', rev: 2 });
    expect(resolvePlan(settings, 'A', EA).snapshot).toBeNull();                       // grade A still follows the policy
    const store = createPositionsStore({ dir: tempDir(), clock: { now: () => T0 } as never, policy: { id: 'EA', version: EA.version } });
    const pb: PendingBuyWithPlan = { sig: newSig(), signal_id: 'dec_x', ca: newCa(), wallet_id: 'w1', owner: 'o', arm: 'B1', route: 'pf-direct',
      sol_in_lamports: '10000000', quote_tokens_out: '5', last_valid_block_height: 9, submitted_at: T0, exit_plan: r.snapshot };
    const pos = store.openFromBuy(pb, { solSpentLamports: '10000000', tokensRaw: '5', feeLamports: '5000', confirmedAt: T0 });
    expect(pos.policy_id).toBe('PRESET-B');
    expect(pos.policy_version).toBe(r.snapshot!.policy.version);
    expect(pos.exit_plan).toEqual(r.snapshot);
    // a card buy always runs a plan: the preset, or the active policy (never the manual path)
    expect(cardBuyPlan(settings, 'B', EA)).toEqual(r.snapshot);
    expect(cardBuyPlan(settings, 'A', EA)).toMatchObject({ source: 'policy', grade: 'A', rev: null, policy: { id: 'EA', version: EA.version } });
  });

  it('EXITP-T04 presets never apply to a dry-run (virtual) position', () => {
    const store = createPositionsStore({ dir: tempDir(), clock: { now: () => T0 } as never, policy: { id: 'EA', version: EA.version } });
    const v = store.openDryRun({ id: 'dry_1', signal_id: 'dec_y', ca: newCa(), wallet_id: 'w1', arm: 'B1', tokens: '7', sol_in_lamports: '1', opened_at: T0 });
    expect(v.policy_id).toBe('EA');
    expect(v.exit_plan).toBeUndefined();
  });

  it('EXITP-T05 the snapshot survives a reload of the store, of the pending-buys journal and of the manual-buy journal; a preset edit later changes nothing', () => {
    const dir = tempDir();
    const snap = snapB();
    const clock = { now: () => T0 } as never;
    const store = createPositionsStore({ dir, clock, policy: { id: 'EA', version: EA.version } });
    const sig = newSig();
    const pos = store.openFromBuy({ sig, signal_id: 'dec_z', ca: newCa(), wallet_id: 'w1', owner: 'o', arm: 'B1', route: 'jupiter', sol_in_lamports: '1', quote_tokens_out: '9',
      last_valid_block_height: 1, submitted_at: T0, exit_plan: snap } as PendingBuyWithPlan, 'unverified');
    expect(pos.position_id).toBe(positionIdForBuy(sig));
    // the owner edits the preset afterwards: the position keeps its plan (the snapshot is a copy, not a reference to the settings)
    const edited = editPreset(presetB(), EA, T0 + 10, setStop(10));
    expect(edited.ok).toBe(true);
    const again = createPositionsStore({ dir, clock, policy: { id: 'EA', version: EA.version } }).get(pos.position_id)!;
    expect(again.exit_plan).toEqual(snap);
    expect(again.policy_id).toBe('PRESET-B');
    // between submit and confirm: the pending-buys journal carries the plan resolved at the decision
    const j = openPendingJournal(dir);
    j.add({ sig: newSig(), signal_id: 'dec_q', ca: newCa(), wallet_id: 'w1', owner: 'o', arm: 'B1', route: 'pf-direct', sol_in_lamports: '1', quote_tokens_out: null,
      last_valid_block_height: 1, submitted_at: T0, exit_plan: snap });
    expect(openPendingJournal(dir).list()[0].exit_plan).toEqual(snap);
    const mj = openManualBuyJournal(dir);
    mj.add({ sig: newSig(), ca: newCa(), wallet_id: 'w1', owner: 'o', sol: 0.1, last_valid_block_height: 1, submitted_at: T0, quote_tokens: null, exit_plan: snap });
    expect(openManualBuyJournal(dir).list()[0].exit_plan).toEqual(snap);
    // a broken snapshot is never loaded as a plan
    expect(normalizeExitPlan({ ...snap, policy: { ...snap.policy, legs: [{ id: 'TP1', kind: 'take_profit', protective: false, atMultiple: 2, sellFractionOfOriginal: 1.5 }], order: ['TP1'] } })).toBeNull();
    expect(normalizeExitPlan({ ...snap, grade: 'D' })).toBeNull();
    expect(normalizeExitPlan(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
  });
});

/** A plan position in the testkit world: a buy from a card (origin manual) or an auto-buy (origin signal) with the grade-B preset. */
function addPlanned(w: World, origin: 'manual' | 'signal', snap: ExitPlanSnapshot = snapB(), ca = newCa()) {
  const p = addPosition(w, { ca, origin, basis: null });
  return w.store.update(p.position_id, { exit_plan: snap, policy_id: snap.policy.id, policy_version: snap.policy.version });
}

describe('the exit engine runs the plan', () => {
  it('EXITP-T09 / EXITP-T03 a card-buy position with the grade-B plan sells its TP once (one send), then its stop; every leg carries the preset version', async () => {
    const w = makeWorld(tempDir());
    const p = addPlanned(w, 'manual');
    const version = p.exit_plan!.policy.version;
    await w.engine.runPass();                                  // the first quote is the basis (as for EA)
    expect(w.store.get(p.position_id)!.basis_sol_per_token).toBeCloseTo(BASE_PRICE, 18);
    setMultiple(w, p.ca, 1.6);
    await w.passAt(5000);
    expect(w.sells).toHaveLength(1);
    expect(w.sells[0].singleSend).toBe(true);
    expect(w.legs().map(l => `${l.leg}:${l.status}`)).toEqual(['TP1:filled']);
    setMultiple(w, p.ca, 1.0);                                 // back to the entry (a slow fall: no hard rug)
    await w.passAt(5000);
    setMultiple(w, p.ca, 0.69);                                // −31%: the always-on stop of the preset
    await w.passAt(5000);
    expect(w.legs().map(l => `${l.leg}:${l.status}`)).toEqual(['TP1:filled', 'S:filled']);
    for (const l of w.legs()) expect(l.policy_version).toBe(version);
    const batch = validateBotBatch({ events: w.outbox.events }, w.clock.now());
    expect(batch.ok && batch.events.every(e => e.result.ok)).toBe(true);
  });

  it('EXITP-T09 the failure policy holds on a plan position: a protective sell that fails twice is locked out (guaranteed exit, then the panic leg)', async () => {
    const w = makeWorld(tempDir(), { sellScript: ['revert'] });
    const p = addPlanned(w, 'signal');
    await w.engine.runPass();
    setMultiple(w, p.ca, 0.75);
    await w.passAt(5000);
    setMultiple(w, p.ca, 0.5);                                 // −33% in one step: no hard rug; the stop fires
    await w.passAt(5000);
    await w.passAt(5000);
    await w.passAt(5000);
    expect(w.legs().map(l => `${l.leg}:${l.status}:${l.attempt}`)).toEqual(['S:failed:1', 'S:locked_out:2']);
    expect(w.sells.map(s => s.slippageBps)).toEqual([4000, 9900, 4000, 9900]);
    expect(w.store.get(p.position_id)!.lockouts).toEqual(expect.arrayContaining(['S', 'R0', 'T']));
  });

  it('EXITP-T10 a plain manual buy (no plan) stays on the manual path: its orders and the −25% floor, never the preset', async () => {
    const w = makeWorld(tempDir());
    const p = addPosition(w, { origin: 'manual' });
    setMultiple(w, p.ca, 1.6);                                 // +60%: the preset would take profit here; the manual path does not
    await w.engine.runPass();
    expect(w.legs()).toEqual([]);
    setMultiple(w, p.ca, 1.0);
    await w.passAt(5000);
    setMultiple(w, p.ca, 0.7);                                 // −30% from the entry: the manual −25% floor
    await w.passAt(5000);
    expect(w.legs().map(l => l.leg)).toEqual(['MANUAL']);
  });

  it('a position stamped PRESET-B whose snapshot is gone falls back to the default policy (a stop, never blind)', async () => {
    const w = makeWorld(tempDir());
    const p = addPosition(w, { basis: BASE_PRICE });
    w.store.update(p.position_id, { policy_id: 'PRESET-B', policy_version: 'ffffffffffffffff' });
    setMultiple(w, p.ca, 0.5);
    await w.engine.runPass();
    expect(w.legs().map(l => l.leg)).toEqual(['S']);
    expect(w.logs.some(l => l.includes('plan is missing'))).toBe(true);
  });
});

describe('changing the plan of open positions', () => {
  it('EXITP-T06 Apply: skips a sell in flight, pending signatures, a lockout and close_pending (with reasons); keeps basis, peak, legs done and the sold part', () => {
    const w = makeWorld(tempDir());
    const ok = addPlanned(w, 'signal');
    w.store.update(ok.position_id, { basis_sol_per_token: 3e-10, peak_multiple: 1.8, legs_done: ['TP1'], tokens: '650000000' });
    const inFlight = addPlanned(w, 'signal');
    const pending = addPlanned(w, 'signal');
    w.store.update(pending.position_id, { pending_sigs: [newSig()] });
    const locked = addPlanned(w, 'signal');
    w.store.update(locked.position_id, { lockouts: ['S'], lockout_until: T0 + 60_000 });
    const closing = addPlanned(w, 'signal');
    w.store.update(closing.position_id, { close_pending: { since: T0, tries: 0, reason: 'policy', close_account: true } });
    const dry = addPosition(w, { dryRun: true });
    const mutex = { has: (k: string): boolean => k === `${inFlight.ca}:${inFlight.wallet_id}` };
    const cands = applyCandidates(w.store, 'B', () => 'B', mutex);
    expect(cands.map(c => c.position.position_id)).not.toContain(dry.position_id);
    const why = Object.fromEntries(cands.map(c => [c.position.position_id, c.skip]));
    expect(why[ok.position_id]).toBeNull();
    expect(why[inFlight.position_id]).toBe('a sell is in flight');
    expect(why[pending.position_id]).toBe('a sent sell is not resolved yet');
    expect(why[locked.position_id]).toBe('locked out after failed sells');
    expect(why[closing.position_id]).toBe('its exit is finishing');
    const next = snapB(presetB({ rev: 3, stop: { lossPct: 20, whilePeakBelowPct: null } }));
    const r = applyPlan(w.store, cands, next, EA, 'B', mutex);
    expect(r.applied).toEqual([ok.position_id]);
    expect(r.skipped.map(s => s.why).sort()).toEqual(['a sell is in flight', 'a sent sell is not resolved yet', 'its exit is finishing', 'locked out after failed sells']);
    const after = w.store.get(ok.position_id)!;
    expect(after).toMatchObject({ basis_sol_per_token: 3e-10, peak_multiple: 1.8, legs_done: ['TP1'], tokens: '650000000', policy_id: 'PRESET-B', policy_version: next.policy.version });
    expect(after.exit_plan?.rev).toBe(3);
    expect(after.entry.opened_at).toBe(ok.entry.opened_at);
    expect(w.store.get(pending.position_id)!.exit_plan?.rev).toBe(2);   // untouched
    // back to the policy: a signal position drops its snapshot and runs EA again
    applyPlan(w.store, applyCandidates(w.store, 'B', () => 'B', noMutex, p => p.position_id === ok.position_id), null, EA, 'B', noMutex);
    expect(w.store.get(ok.position_id)).toMatchObject({ policy_id: 'EA', policy_version: EA.version });
    expect(w.store.get(ok.position_id)!.exit_plan).toBeUndefined();
  });

  it('EXITP-T11 ✋ Switch to my own orders: a card buy leaves its plan for the manual path; an auto-buy position cannot switch', async () => {
    const w = makeWorld(tempDir());
    const card = addPlanned(w, 'manual');
    const auto = addPlanned(w, 'signal');
    expect(switchToOwnOrders(w.store, auto.position_id, noMutex)).toMatchObject({ ok: false });
    expect(switchToOwnOrders(w.store, card.position_id, { has: () => true })).toEqual({ ok: false, why: 'a sell is in flight' });
    expect(switchToOwnOrders(w.store, card.position_id, noMutex)).toEqual({ ok: true });
    const p = w.store.get(card.position_id)!;
    expect(p.exit_plan).toBeUndefined();
    expect(p.policy_id).toBe('MANUAL');
    expect(planLine(p.exit_plan, p.policy_id, null)).toBe('plan: your orders');
    expect(planLine(auto.exit_plan, auto.policy_id, { ...defaultGradePresets(), B: presetB({ rev: 3 }) })).toBe('plan: grade B preset rev 2 (current rev 3)');
    expect(planLine(undefined, 'EA', null)).toBe('plan: policy EA');
    // on the manual path from now on: +60% sells nothing (no orders), −30% hits the −25% floor
    w.store.update(card.position_id, { basis_sol_per_token: BASE_PRICE });
    setMultiple(w, card.ca, 1.6);
    setMultiple(w, auto.ca, 1.0);
    await w.engine.runPass();
    expect(w.legs().filter(l => l.position_id === card.position_id)).toEqual([]);
  });
});

describe('the store never loses a real position over a plan', () => {
  it('a plan on a dry-run record is ignored at open (presets are real money only)', () => {
    const store = createPositionsStore({ dir: tempDir(), clock: { now: () => T0 } as never, policy: { id: 'EA', version: EA.version } });
    const raw = { position_id: 'p1', signal_id: 'd', origin: 'signal', dry_run: true, ca: newCa(), wallet_id: 'w1', policy_id: 'EA', policy_version: EA.version, arm: 'B1',
      entry: { tx: null, opened_at: T0, sol_spent_lamports: null, tokens_raw: '1', fill_source: 'quote_dry_run' }, original_tokens: '1', tokens: '1', basis_sol_per_token: null,
      peak_multiple: 1, legs_done: [], leg_attempts: {}, last_quote: null, lockouts: [], ata: null } as PositionV2;
    expect(store.put(raw).exit_plan).toBeUndefined();
  });
});
