/**
 * positions-store tests: the v2 files, `openFromBuy` (plan grind #65), restart safety and the normalisation of records written by
 * other code (the R4-B6 migration writes plain PositionV2 / ManualOrderV2 records without the engine's extension fields).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PendingBuy, PositionV2 } from '../bot-contracts';
import { FakeClock } from '../link/clock';
import { cleanupTempDirs, newCa, tempDir } from '../link/link-testkit';
import {
  MANUAL_ORDERS_FILE, POSITIONS_FILE, PRUNE_CLOSED_AFTER_MS, PositionsStoreError, createPositionsStore, positionIdForBuy, type PositionsStoreV2,
} from './positions-store';
import { START_MS, newSig } from './exits-testkit';

afterEach(() => cleanupTempDirs());

const POLICY = { id: 'EA', version: '0123456789abcdef' };

function open(dir: string, clock = new FakeClock(START_MS)): { store: PositionsStoreV2; clock: FakeClock } {
  return { store: createPositionsStore({ dir, clock, policy: POLICY }), clock };
}

function pending(o: Partial<PendingBuy> = {}): PendingBuy {
  return { sig: newSig(), signal_id: 'dec_abc123', ca: newCa(), wallet_id: 'w1', owner: newCa(), arm: 'B1', route: 'pf-direct',
    sol_in_lamports: '50000000', quote_tokens_out: '123456789', last_valid_block_height: 1000, submitted_at: START_MS - 800, ...o };
}

function plainPosition(o: Partial<PositionV2> = {}): PositionV2 {
  return {
    position_id: 'pos_migrated_1', signal_id: null, origin: 'manual', dry_run: false, ca: newCa(), wallet_id: 'w1', policy_id: 'MANUAL', policy_version: null, arm: null,
    entry: { tx: null, opened_at: START_MS - 86_400_000, sol_spent_lamports: '50000000', tokens_raw: null, fill_source: 'unverified' },
    original_tokens: '1000000', tokens: '1000000', basis_sol_per_token: 5e-8, peak_multiple: 1, legs_done: [], leg_attempts: {}, last_quote: null, lockouts: [], ata: null, ...o,
  };
}

describe('openFromBuy', () => {
  it('B3-T15 openFromBuy(pending, unverified) makes a PositionV2 with tokens = quote_tokens_out, fill_source unverified, basis null and next_due_at set', () => {
    const { store, clock } = open(tempDir());
    const p = pending();
    const pos = store.openFromBuy(p, 'unverified');
    expect(pos.tokens).toBe('123456789');
    expect(pos.original_tokens).toBe('123456789');
    expect(pos.entry.fill_source).toBe('unverified');
    expect(pos.entry.tx).toBe(p.sig);
    expect(pos.entry.sol_spent_lamports).toBeNull();   // the quote is never booked as a fill
    expect(pos.entry.tokens_raw).toBeNull();
    expect(pos.basis_sol_per_token).toBeNull();
    expect(pos.next_due_at).toBe(clock.now());
    expect(pos).toMatchObject({ origin: 'signal', dry_run: false, signal_id: 'dec_abc123', ca: p.ca, wallet_id: 'w1', arm: 'B1', policy_id: 'EA', policy_version: POLICY.version, peak_multiple: 1 });
    expect(pos.legs_done).toEqual([]);
    expect(pos.lockouts).toEqual([]);
    // the same pending buy again (a crash between "opened" and "journal entry removed") is the same position
    expect(store.openFromBuy(p, 'unverified').position_id).toBe(pos.position_id);
    expect(store.listOpen()).toHaveLength(1);
  });

  it('a verified fill books the real tokens and the real SOL spent, and stamps the open time from the fill', () => {
    const { store } = open(tempDir());
    const p = pending();
    const pos = store.openFromBuy(p, { solSpentLamports: '50234567', tokensRaw: '999000', feeLamports: '5000', confirmedAt: START_MS - 300 });
    expect(pos.tokens).toBe('999000');
    expect(pos.entry).toMatchObject({ fill_source: 'tx_meta', sol_spent_lamports: '50234567', tokens_raw: '999000', opened_at: START_MS - 300, tx: p.sig });
  });

  it('a fill with zero tokens is a reverted buy, not a position (A-29)', () => {
    const { store } = open(tempDir());
    expect(() => store.openFromBuy(pending(), { solSpentLamports: '5000', tokensRaw: '0', feeLamports: '5000', confirmedAt: START_MS })).toThrow(PositionsStoreError);
    expect(store.listOpen()).toHaveLength(0);
  });

  it('an unverified buy without a quoted amount opens with 0 tokens (nothing to sell yet), never a made-up amount', () => {
    const { store } = open(tempDir());
    expect(store.openFromBuy(pending({ quote_tokens_out: null }), 'unverified').tokens).toBe('0');
  });

  it('the position id is a pure function of the signature', () => {
    const sig = newSig();
    expect(positionIdForBuy(sig)).toBe(positionIdForBuy(sig));
    expect(positionIdForBuy(sig)).not.toBe(positionIdForBuy(newSig()));
  });

  it('openDryRun makes a virtual position (fill_source quote_dry_run), once per id', () => {
    const { store } = open(tempDir());
    const a = { id: 'virt_1', signal_id: 'dec_x', ca: newCa(), wallet_id: 'w1', arm: 'B1' as const, tokens: '5000', sol_in_lamports: '50000000', opened_at: START_MS };
    const v = store.openDryRun(a);
    expect(v).toMatchObject({ dry_run: true, origin: 'signal', tokens: '5000' });
    expect(v.entry).toMatchObject({ fill_source: 'quote_dry_run', tx: null });
    expect(store.openDryRun(a).position_id).toBe(v.position_id);
    expect(store.openCount()).toBe(1);
  });
});

describe('persistence', () => {
  it('every mutation is on disk before the call returns, and a new store over the folder sees exactly it (a restart)', () => {
    const dir = tempDir();
    const { store } = open(dir);
    const pos = store.openFromBuy(pending(), { solSpentLamports: '50000000', tokensRaw: '1000000', feeLamports: '5000', confirmedAt: START_MS });
    store.update(pos.position_id, { basis_sol_per_token: 4.2e-8, peak_multiple: 2.5, legs_done: ['TP1'], leg_attempts: { TP2: 1 }, lockouts: ['TP3'],
      last_quote: { sol: 0.1, src: 'onchain', at: START_MS + 5 }, last_quote_tokens: '1000000', pending_sigs: ['sigA'] });
    const file = JSON.parse(fs.readFileSync(path.join(dir, POSITIONS_FILE), 'utf8'));
    expect(file.schema).toBe(2);
    expect(file.positions).toHaveLength(1);
    const again = open(dir).store.get(pos.position_id)!;
    expect(again).toMatchObject({ basis_sol_per_token: 4.2e-8, peak_multiple: 2.5, legs_done: ['TP1'], leg_attempts: { TP2: 1 }, lockouts: ['TP3'],
      last_quote: { sol: 0.1, src: 'onchain', at: START_MS + 5 }, last_quote_tokens: '1000000', pending_sigs: ['sigA'] });
    expect(fs.readdirSync(dir).filter(n => n.endsWith('.tmp'))).toEqual([]);
  });

  it('a file that is not valid JSON is a hard error and is left untouched (never read as "no positions")', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, POSITIONS_FILE), '{ "schema": 2, "positions": [ {');
    expect(() => open(dir)).toThrow(PositionsStoreError);
    expect(fs.readFileSync(path.join(dir, POSITIONS_FILE), 'utf8')).toBe('{ "schema": 2, "positions": [ {');
  });

  it('a record with a broken field names the position and stops the load', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, POSITIONS_FILE), JSON.stringify({ schema: 2, positions: [{ ...plainPosition(), tokens: 'lots' }] }));
    expect(() => open(dir)).toThrow(/pos_migrated_1.*tokens/);
  });

  it('records written without the engine fields (the migration writes plain PositionV2 / ManualOrderV2) load with safe defaults', () => {
    const dir = tempDir();
    const ca = newCa();
    fs.writeFileSync(path.join(dir, POSITIONS_FILE), JSON.stringify([plainPosition({ ca })]));   // a bare array is accepted too
    fs.writeFileSync(path.join(dir, MANUAL_ORDERS_FILE), JSON.stringify({ schema: 2, orders: [
      { order_id: 'o1', position_id: 'pos_migrated_1', ca, wallet_id: 'w1', type: 'tp', trigger_pct: 100, baseline_multi: 0.8, peak_rel: null, expires_at: START_MS + 1000, active: true, attempts: 0, created_at: 1, source: 'migrated' },
    ] }));
    const { store, clock } = open(dir);
    const pos = store.get('pos_migrated_1')!;
    expect(pos).toMatchObject({ origin: 'manual', basis_sol_per_token: 5e-8, pending_sigs: [], real_out_lamports: '0', sell_unverified: false, cancel_pending: false,
      close_pending: null, closed_at: null, floor_base: null, next_due_at: clock.now() });
    const o = store.getOrder('o1')!;
    expect(o).toMatchObject({ type: 'tp', trigger_pct: 100, baseline_multi: 0.8, active: true, source: 'migrated' });
    expect(o.sell_pct).toBeUndefined();   // missing = 100 (sellPctOf)
    expect(store.activeOrdersOf('pos_migrated_1')).toHaveLength(1);
  });

  it('refuses a record that is not a valid position or order (unknown order type, bad position)', () => {
    const { store } = open(tempDir());
    expect(() => store.put({ ...plainPosition(), tokens: '-5' } as unknown as PositionV2)).toThrow(PositionsStoreError);
    expect(() => store.putOrder({ order_id: 'x', position_id: 'p', ca: 'c', wallet_id: 'w', type: 'oco' as unknown as 'tp', trigger_pct: 5, baseline_multi: null,
      peak_rel: null, expires_at: null, active: true, attempts: 0, created_at: 0, source: 'ui' })).toThrow(/type/);
    expect(() => store.update('missing', { tokens: '1' })).toThrow(PositionsStoreError);
  });
});

describe('closing and listing', () => {
  it('close() records the result, hides the position from listOpen and switches its orders off', () => {
    const { store, clock } = open(tempDir());
    const pos = store.put(plainPosition());
    store.putOrder({ order_id: 'o1', position_id: pos.position_id, ca: pos.ca, wallet_id: 'w1', type: 'sl', trigger_pct: -10, baseline_multi: null,
      peak_rel: null, expires_at: null, active: true, attempts: 0, created_at: 1, source: 'ui' });
    expect(store.findOpen(pos.ca, 'w1')).toHaveLength(1);
    const closed = store.close(pos.position_id, { closed_at: clock.now(), reason: 'manual', realized_sol_net_lamports: '-1234', rent_reclaimed_lamports: '2039280',
      close_account_status: 'closed', close_account_tx: 'txsig' });
    expect(closed).toMatchObject({ closed_at: clock.now(), close_reason: 'manual', realized_sol_net_lamports: '-1234', rent_reclaimed_lamports: '2039280' });
    expect(store.listOpen()).toEqual([]);
    expect(store.openCount()).toBe(0);
    expect(store.getOrder('o1')).toMatchObject({ active: false, deactivated_reason: 'position-closed' });
  });

  it('a closed position is kept for audit and pruned only after a long time', async () => {
    const dir = tempDir();
    const { store, clock } = open(dir);
    const pos = store.put(plainPosition());
    store.close(pos.position_id, { closed_at: clock.now(), reason: 'policy', realized_sol_net_lamports: null, rent_reclaimed_lamports: null, close_account_status: 'skipped', close_account_tx: null });
    store.put(plainPosition({ position_id: 'other' }));
    expect(store.get(pos.position_id)).toBeDefined();
    await clock.advance(PRUNE_CLOSED_AFTER_MS + 1000);
    store.put(plainPosition({ position_id: 'another' }));   // any write prunes
    expect(store.get(pos.position_id)).toBeUndefined();
    expect(open(dir, clock).store.get(pos.position_id)).toBeUndefined();
  });

  it('lists open positions oldest first and finds them by (CA, wallet)', () => {
    const { store } = open(tempDir());
    const ca = newCa();
    store.put(plainPosition({ position_id: 'b', ca, entry: { tx: null, opened_at: START_MS - 10, sol_spent_lamports: null, tokens_raw: null, fill_source: 'unverified' } }));
    store.put(plainPosition({ position_id: 'a', ca, wallet_id: 'w2', entry: { tx: null, opened_at: START_MS - 20, sol_spent_lamports: null, tokens_raw: null, fill_source: 'unverified' } }));
    expect(store.listOpen().map(p => p.position_id)).toEqual(['a', 'b']);
    expect(store.findOpen(ca, 'w1').map(p => p.position_id)).toEqual(['b']);
  });
});
