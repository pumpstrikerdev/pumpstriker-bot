/**
 * The in-flight buy journal and the landed-check (B20 section 3, plan grind #65). No network: the RPC is a stub.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PendingBuy } from '../bot-contracts';
import { cleanupTempDirs, newCa, tempDir } from '../link/link-testkit';
import { newSig, StubRpc } from './autobuy-testkit';
import {
  checkPending, EXPIRED_UNKNOWN_CHECKS, openPendingJournal, PENDING_FILE, recoveryRpcFrom, toPendingBuy, type PendingRecord, type RecoveryRpc,
} from './pending';

afterAll(() => { cleanupTempDirs(); });

function record(over: Partial<PendingRecord> = {}): PendingRecord {
  return {
    sig: newSig(), signal_id: 'dec_1', ca: newCa(), wallet_id: 'wallet-1', owner: newCa(), arm: 'B1', route: 'pf-direct',
    sol_in_lamports: '10000000', quote_tokens_out: '1666000000000', last_valid_block_height: 1_150, submitted_at: 5_000,
    received_at: 4_000, decided_at: 4_100, signed_at: 4_900, ...over,
  };
}
const file = (dir: string): string => path.join(dir, PENDING_FILE);

describe('the pending-buys journal', () => {
  it('appends, persists through a restart and removes, writing through a tmp file that is renamed away', () => {
    const dir = tempDir('ps-b2p-');
    const j = openPendingJournal(dir);
    expect(j.list()).toEqual([]);
    expect(fs.existsSync(file(dir))).toBe(false);          // nothing is written until the first entry
    const a = record();
    const b = record();
    j.add(a);
    j.add(b);
    j.add(a);                                              // adding the same signature twice keeps one entry
    expect(j.list()).toHaveLength(2);
    expect(j.has(a.sig)).toBe(true);
    expect(fs.readdirSync(dir).filter(n => n.endsWith('.tmp'))).toEqual([]);
    const again = openPendingJournal(dir);
    expect(again.list().map(r => r.sig).sort()).toEqual([a.sig, b.sig].sort());
    again.remove(a.sig);
    again.remove(a.sig);                                   // removing a missing entry is a no-op
    expect(openPendingJournal(dir).list().map(r => r.sig)).toEqual([b.sig]);
    expect(JSON.parse(fs.readFileSync(file(dir), 'utf8')).v).toBe(1);
  });

  it('update patches an entry and never changes its signature', () => {
    const dir = tempDir('ps-b2p-');
    const j = openPendingJournal(dir);
    const a = record({ quote_tokens_out: null });
    j.add(a);
    expect(j.update(a.sig, { quote_tokens_out: '77', sig: 'other' as string })).toBe(true);
    expect(openPendingJournal(dir).list()[0]).toMatchObject({ sig: a.sig, quote_tokens_out: '77' });
    expect(j.update('missing', { quote_tokens_out: '1' })).toBe(false);
  });

  it('keeps the optional latency stamps in the file but hands openFromBuy only the frozen PendingBuy fields', () => {
    const r = record();
    const pb: PendingBuy = toPendingBuy(r);
    expect(Object.keys(pb).sort()).toEqual([
      'arm', 'ca', 'last_valid_block_height', 'owner', 'quote_tokens_out', 'route', 'sig', 'signal_id', 'sol_in_lamports', 'submitted_at', 'wallet_id',
    ]);
    const dir = tempDir('ps-b2p-');
    openPendingJournal(dir).add(r);
    expect(openPendingJournal(dir).list()[0]).toMatchObject({ received_at: 4_000, decided_at: 4_100, signed_at: 4_900 });
  });

  it('moves a corrupt or malformed file aside, starts empty and says why', () => {
    const good = JSON.stringify({ v: 1, entries: [record()] });
    const cases: string[] = [
      '{ nope', JSON.stringify({ v: 2, entries: [] }), JSON.stringify({ v: 1, entries: 'x' }),
      JSON.stringify({ v: 1, entries: [{ sig: 'only-a-sig' }] }),
      JSON.stringify({ v: 1, entries: [{ ...record(), arm: 'B9' }] }),
      JSON.stringify({ v: 1, entries: [{ ...record(), sol_in_lamports: '1.5' }] }),
      JSON.stringify({ v: 1, entries: [{ ...record(), route: 'raydium' }] }),
    ];
    for (const text of cases) {
      const dir = tempDir('ps-b2p-');
      fs.writeFileSync(file(dir), text);
      const j = openPendingJournal(dir);
      expect(j.list(), text).toEqual([]);
      expect(j.loadError, text).not.toBeNull();
      expect(fs.readdirSync(dir).some(n => n.startsWith(`${PENDING_FILE}.corrupt-`)), text).toBe(true);
    }
    const dir = tempDir('ps-b2p-');
    fs.writeFileSync(file(dir), good);
    expect(openPendingJournal(dir).loadError).toBeNull();
  });

  it('add throws and keeps nothing when the file cannot be written, so the caller sends nothing', () => {
    const dir = tempDir('ps-b2p-');
    const blocker = path.join(dir, 'file-not-folder');
    fs.writeFileSync(blocker, 'x');
    const j = openPendingJournal(blocker);
    expect(() => j.add(record())).toThrow();
    expect(j.list()).toEqual([]);
  });
});

describe('checkPending', () => {
  const rec = record({ last_valid_block_height: 1_150 });
  const run = (rpc: RecoveryRpc, o: { balanceFirst?: boolean; streak?: number } = {}) =>
    checkPending(rec, rpc, { balanceFirst: o.balanceFirst ?? false, expiredUnknownStreak: o.streak ?? 0 });

  it('a confirmed or finalized status without an error has landed', async () => {
    const rpc = new StubRpc();
    rpc.statuses.set(rec.sig, { err: null, confirmationStatus: 'confirmed' });
    expect(await run(rpc)).toEqual({ kind: 'landed' });
    rpc.statuses.set(rec.sig, { err: null, confirmationStatus: 'finalized' });
    expect(await run(rpc)).toEqual({ kind: 'landed' });
  });

  it('an error status is a failed buy, with the redacted error as the reason', async () => {
    const rpc = new StubRpc();
    rpc.revert(rec.sig);
    const v = await run(rpc);
    expect(v.kind).toBe('failed');
    expect(v.kind === 'failed' && v.reason).toContain('InstructionError');
  });

  it('a status that is still processed, or not found while the blockhash is valid, waits', async () => {
    const rpc = new StubRpc();
    rpc.height = 1_150;                                    // equal to the last valid height: still valid
    expect(await run(rpc)).toEqual({ kind: 'wait', expiredUnknownStreak: 0 });
    rpc.statuses.set(rec.sig, { err: null, confirmationStatus: 'processed' });
    expect(await run(rpc)).toEqual({ kind: 'wait', expiredUnknownStreak: 0 });
    expect(rpc.calls.balance).toBe(0);                     // the live loop does not read the balance before expiry
  });

  it('boot recovery adopts a buy whose status is unknown but whose wallet holds the token, even before expiry', async () => {
    const rpc = new StubRpc();
    rpc.height = 1_000;
    rpc.balance = { rawAtoms: 1_234_567 };
    expect(await run(rpc, { balanceFirst: true })).toEqual({ kind: 'adopt', rawAtoms: 1_234_567n });
    rpc.balance = { rawAtoms: '99' };
    expect(await run(rpc, { balanceFirst: true })).toEqual({ kind: 'adopt', rawAtoms: 99n });
    rpc.balance = { rawAtoms: 0 };
    expect(await run(rpc, { balanceFirst: true })).toEqual({ kind: 'wait', expiredUnknownStreak: 0 });
  });

  it('not found after the blockhash expired with a confirmed zero balance is failed', async () => {
    const rpc = new StubRpc();
    rpc.height = 1_151;
    rpc.balance = { rawAtoms: 0 };
    const v = await run(rpc, { balanceFirst: true });
    expect(v).toMatchObject({ kind: 'failed' });
    expect(v.kind === 'failed' && v.reason).toMatch(/blockhash expired, balance 0/);
  });

  it('an unreadable balance after expiry fails the buy only after EXPIRED_UNKNOWN_CHECKS checks in a row', async () => {
    const rpc = new StubRpc();
    rpc.height = 2_000;
    rpc.balance = null;                                    // neither ATA found: unknown, not zero
    let streak = 0;
    for (let i = 1; i < EXPIRED_UNKNOWN_CHECKS; i++) {
      const v = await run(rpc, { balanceFirst: true, streak });
      expect(v).toEqual({ kind: 'wait', expiredUnknownStreak: i });
      streak = v.kind === 'wait' ? v.expiredUnknownStreak : -1;
    }
    expect(await run(rpc, { balanceFirst: true, streak })).toMatchObject({ kind: 'failed' });
  });

  it('a status RPC that errors never counts as not found', async () => {
    const rpc = new StubRpc();
    rpc.statusThrows = true;
    rpc.height = 5_000;                                    // long expired
    rpc.balance = { rawAtoms: 0 };
    expect(await run(rpc, { balanceFirst: true })).toEqual({ kind: 'wait', expiredUnknownStreak: 0 });
    // and an unreadable block height keeps the live loop waiting
    const rpc2 = new StubRpc();
    rpc2.heightThrows = true;
    expect(await run(rpc2)).toEqual({ kind: 'wait', expiredUnknownStreak: 0 });
  });

  it('in the live loop a late status after expiry still adopts a held token, a thrown balance read waits', async () => {
    const rpc = new StubRpc();
    rpc.height = 1_500;
    rpc.balance = { rawAtoms: 5 };
    expect(await run(rpc)).toEqual({ kind: 'adopt', rawAtoms: 5n });
    rpc.balanceThrows = true;
    expect(await run(rpc, { streak: 0 })).toEqual({ kind: 'wait', expiredUnknownStreak: 1 });
  });
});

describe('recoveryRpcFrom', () => {
  it('maps the three calls onto the JSON-RPC pool and the balance reader', async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const rpc = {
      async call(method: string, params: unknown[]): Promise<unknown> {
        calls.push({ method, params });
        if (method === 'getSignatureStatuses') return { context: { slot: 1 }, value: [{ err: null, confirmationStatus: 'confirmed' }, null] };
        if (method === 'getBlockHeight') return 4242;
        return null;
      },
    };
    const adapter = recoveryRpcFrom(rpc, async () => ({ rawAtoms: 3 }));
    expect(await adapter.getSignatureStatuses(['a', 'b'], { searchTransactionHistory: true })).toEqual([{ err: null, confirmationStatus: 'confirmed' }, null]);
    expect(calls[0]).toEqual({ method: 'getSignatureStatuses', params: [['a', 'b'], { searchTransactionHistory: true }] });
    expect(await adapter.getBlockHeight()).toBe(4242);
    expect(await adapter.getSplTokenBalance('o', 'm')).toEqual({ rawAtoms: 3 });
    const odd = recoveryRpcFrom({ call: async () => ({ value: 'x' }) }, async () => null);
    expect(await odd.getSignatureStatuses(['a'], { searchTransactionHistory: false })).toEqual([]);
    await expect(odd.getBlockHeight()).rejects.toThrow(/unreadable/);
  });
});
