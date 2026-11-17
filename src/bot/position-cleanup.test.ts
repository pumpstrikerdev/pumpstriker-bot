/**
 * B50 section 2 (R3-B5): the position cleanup reads positions from the positions store, reconciles them against the wallets' RPC
 * balances (two consecutive confirmed-empty sweeps, never on unknown data) and sweeps empty token accounts only for mints in
 * trade-registry.json, through B40 closeIfEmpty. Everything is injected; one FakeClock (A-10); a real store in a temp folder.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { CloseAccountApi, PositionV2 } from '../bot-contracts';
import { createPositionsStore, type PositionsStoreV2 } from '../exits/positions-store';
import { FakeClock } from '../link/clock';

vi.mock('../logger', () => ({
  log: () => {}, logOk: () => {}, logDbg: () => {}, logErr: () => {}, logWarn: () => {}, emitEvent: () => {}, setBroadcast: () => {},
}));

import {
  MAX_SWEEP_CLOSES, TRADE_REGISTRY_FILE, TRADE_REGISTRY_MAX, configurePositionCleanup, readTradeRegistry, recordTrade, resetPositionCleanup,
  runPositionCleanup, startPositionCleanupSchedule,
} from './position-cleanup';

const T0 = 1_800_000_000_000;
const key = (n: number): string => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const CA1 = key(51);
const CA2 = key(52);
const OWNER_A = key(61);
const OWNER_B = key(62);

let dir: string;
let clock: FakeClock;
let writer: PositionsStoreV2;
const mkStore = (): PositionsStoreV2 => createPositionsStore({ dir, clock, policy: { id: 'EA', version: 'test' } });

function pos(over: Partial<PositionV2> & { position_id: string }): PositionV2 {
  return {
    signal_id: 'sig1', origin: 'signal', dry_run: false, ca: CA1, wallet_id: 'wA', policy_id: 'EA', policy_version: 'test', arm: 'B1',
    entry: { tx: 'buyTxSigA', opened_at: T0 - 600_000, sol_spent_lamports: '50000000', tokens_raw: '1000000000', fill_source: 'tx_meta' },
    original_tokens: '1000000000', tokens: '1000000000', basis_sol_per_token: null, peak_multiple: 1, legs_done: [], leg_attempts: {},
    last_quote: null, lockouts: [], ata: null, ...over,
  };
}

type Held = Map<string, { rawAtoms: number; decimals: number }>;
const held = (...cas: string[]): Held => new Map(cas.map(c => [c, { rawAtoms: 1_000_000, decimals: 6 }]));

let balances: Map<string, Held | null>;
let cards: { chatId: number; messageId: number; ca: string }[];
let stopped: Array<[number, number]>;
let bot: { telegram: { deleteMessage: Mock<any[], any> } };
let allBalances: Mock<any[], any>;
let closeAccount: { closeIfEmpty: Mock<any[], any> };

function configure(over: Parameters<typeof configurePositionCleanup>[0] = {}): void {
  configurePositionCleanup({
    clock, store: mkStore, dataDir: () => dir,
    ownerOf: (w: string) => (w === 'wA' ? OWNER_A : w === 'wB' ? OWNER_B : null),
    allBalances: allBalances as any,
    closeAccount: closeAccount as unknown as CloseAccountApi,
    cards: { list: () => cards, stop: (c: number, m: number) => { stopped.push([c, m]); cards = cards.filter(x => !(x.chatId === c && x.messageId === m)); } },
    ...over,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-poscl-'));
  clock = new FakeClock(T0);
  writer = mkStore();
  balances = new Map();
  cards = [];
  stopped = [];
  bot = { telegram: { deleteMessage: vi.fn(async () => true) } };
  allBalances = vi.fn(async (owner: string) => (balances.has(owner) ? balances.get(owner)! : held()));
  closeAccount = { closeIfEmpty: vi.fn(async () => ({ status: 'skipped' as const, tx: null, rentLamports: null, reason: 'balance above zero (1 raw)' })) };
  configure();
});
afterEach(() => {
  resetPositionCleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

const openIds = (): string[] => mkStore().listOpen().map(p => p.position_id);

describe('reconcile from the RPC balances', () => {
  it('a position the wallet no longer holds is closed after TWO consecutive confirmed-empty sweeps, never after one', async () => {
    writer.put(pos({ position_id: 'p1' }));
    balances.set(OWNER_A, held());                                       // the wallet holds nothing
    const first = await runPositionCleanup(bot as any);
    expect(first).toMatchObject({ walletsChecked: 1, slotsCleared: 0, positionsKept: 1 });
    expect(openIds()).toEqual(['p1']);
    const second = await runPositionCleanup(bot as any);
    expect(second).toMatchObject({ slotsCleared: 1, positionsDeleted: 1, positionsKept: 0 });
    expect(openIds()).toEqual([]);
    const closed = mkStore().get('p1')!;
    expect(closed).toMatchObject({ close_reason: 'external_sell', closed_at: T0, realized_sol_net_lamports: null, close_account_status: 'skipped' });
  });

  it('a non-empty reading in between resets the strike', async () => {
    writer.put(pos({ position_id: 'p1' }));
    balances.set(OWNER_A, held());
    await runPositionCleanup(bot as any);                                // strike 1
    balances.set(OWNER_A, held(CA1));                                    // it is back (an indexing blip)
    await runPositionCleanup(bot as any);
    balances.set(OWNER_A, held());
    await runPositionCleanup(bot as any);                                // strike 1 again
    expect(openIds()).toEqual(['p1']);
    await runPositionCleanup(bot as any);
    expect(openIds()).toEqual([]);
  });

  it('only the position whose token is missing is closed; the others of the wallet stay', async () => {
    writer.put(pos({ position_id: 'p1', ca: CA1 }));
    writer.put(pos({ position_id: 'p2', ca: CA2 }));
    balances.set(OWNER_A, held(CA2));
    await runPositionCleanup(bot as any);
    await runPositionCleanup(bot as any);
    expect(openIds()).toEqual(['p2']);
  });

  it('unknown data never closes anything: a failed scan, an unknown wallet, a thrown scan', async () => {
    writer.put(pos({ position_id: 'p1' }));
    writer.put(pos({ position_id: 'p2', wallet_id: 'wUnknown' }));
    balances.set(OWNER_A, null);                                         // the scan failed
    for (let i = 0; i < 4; i++) {
      const r = await runPositionCleanup(bot as any);
      expect(r.slotsCleared).toBe(0);
      expect(r.walletsSkipped).toBeGreaterThanOrEqual(1);
    }
    allBalances.mockRejectedValue(new Error('rpc down'));
    for (let i = 0; i < 3; i++) await runPositionCleanup(bot as any);
    expect(openIds().sort()).toEqual(['p1', 'p2']);
    expect(allBalances).toHaveBeenCalledWith(OWNER_A);
    expect(allBalances).not.toHaveBeenCalledWith(null);
  });

  it('a skipped sweep does not count as a strike (null in between resets nothing but adds nothing)', async () => {
    writer.put(pos({ position_id: 'p1' }));
    balances.set(OWNER_A, held());
    await runPositionCleanup(bot as any);                                // strike 1
    balances.set(OWNER_A, null);
    await runPositionCleanup(bot as any);                                // skipped
    balances.set(OWNER_A, held());
    await runPositionCleanup(bot as any);                                // strike 2 -> closes
    expect(openIds()).toEqual([]);
  });

  it('positions the exit engine is handling, virtual positions and brand-new positions are left alone', async () => {
    writer.put(pos({ position_id: 'pending', pending_sigs: ['sellSigA'] } as any));
    writer.put(pos({ position_id: 'closing', close_pending: { since: T0 - 1000, tries: 0, reason: 'policy', close_account: true } } as any));
    writer.put(pos({ position_id: 'cancel', cancel_pending: true } as any));
    writer.put(pos({ position_id: 'virtual', dry_run: true }));
    writer.put(pos({ position_id: 'fresh', entry: { tx: 'buyTxSigF', opened_at: T0 - 30_000, sol_spent_lamports: '1', tokens_raw: '1', fill_source: 'tx_meta' } }));
    balances.set(OWNER_A, held());
    for (let i = 0; i < 3; i++) await runPositionCleanup(bot as any);
    expect(openIds().sort()).toEqual(['cancel', 'closing', 'fresh', 'pending', 'virtual']);
    expect(allBalances).not.toHaveBeenCalled();                          // nothing was eligible: no scan at all
  });

  it('a wallet is scanned once for all its positions; two wallets are two scans', async () => {
    writer.put(pos({ position_id: 'p1', ca: CA1, wallet_id: 'wA' }));
    writer.put(pos({ position_id: 'p2', ca: CA2, wallet_id: 'wA' }));
    writer.put(pos({ position_id: 'p3', ca: CA1, wallet_id: 'wB' }));
    balances.set(OWNER_A, held(CA1, CA2));
    balances.set(OWNER_B, held(CA1));
    const r = await runPositionCleanup(bot as any);
    expect(allBalances).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ walletsChecked: 2, positionsKept: 3 });
  });

  it('a corrupt positions file skips the sweep and leaves it untouched', async () => {
    fs.writeFileSync(path.join(dir, 'positions-v2.json'), '{ broken');
    const r = await runPositionCleanup(bot as any);
    expect(r).toMatchObject({ walletsChecked: 0, slotsCleared: 0 });
    expect(fs.readFileSync(path.join(dir, 'positions-v2.json'), 'utf8')).toBe('{ broken');
  });

  it('the module has no pump.fun balances client and no JWT: the RPC scan is the only source', () => {
    const src = fs.readFileSync(path.join(__dirname, 'position-cleanup.ts'), 'utf8');
    expect(src).not.toMatch(/scanners\//);
    expect(src).not.toMatch(/pumpfun-(balances|jwt)|PUMPFUN_JWT/i);
    expect(src).toMatch(/getAllSplBalances/);
  });
});

describe('orphaned monitor cards', () => {
  it('a card whose token has no open position any more is deleted from the chat and stopped; a live one stays', async () => {
    writer.put(pos({ position_id: 'p1', ca: CA1 }));
    cards = [{ chatId: 7, messageId: 11, ca: CA1 }, { chatId: 7, messageId: 12, ca: CA2 }];
    const r = await runPositionCleanup(bot as any);
    expect(bot.telegram.deleteMessage).toHaveBeenCalledTimes(1);
    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith(7, 12);
    expect(stopped).toEqual([[7, 12]]);
    expect(r.cardsDeleted).toBe(1);
    expect(cards).toEqual([{ chatId: 7, messageId: 11, ca: CA1 }]);
  });

  it('a message that cannot be deleted (too old) still clears the monitor', async () => {
    cards = [{ chatId: 7, messageId: 12, ca: CA2 }];
    bot.telegram.deleteMessage.mockRejectedValue(new Error('message to delete not found'));
    const r = await runPositionCleanup(bot as any);
    expect(r.cardsDeleted).toBe(0);
    expect(stopped).toEqual([[7, 12]]);
  });

  it('the card of a position closed by this very sweep goes in the same sweep', async () => {
    writer.put(pos({ position_id: 'p1' }));
    balances.set(OWNER_A, held());
    cards = [{ chatId: 7, messageId: 11, ca: CA1 }];
    await runPositionCleanup(bot as any);
    expect(stopped).toEqual([]);
    const r = await runPositionCleanup(bot as any);
    expect(r).toMatchObject({ slotsCleared: 1, cardsDeleted: 1 });
    expect(stopped).toEqual([[7, 11]]);
  });
});

describe('empty-account sweep over trade-registry.json', () => {
  const E = (owner: string, mint: string) => ({ owner, mint, at: T0 });

  it('closes only the mints of the registry, through closeIfEmpty, and forgets closed and vanished accounts', async () => {
    const m = [key(71), key(72), key(73), key(74), key(75)];
    for (const mint of m) recordTrade(dir, OWNER_A, mint, T0);
    closeAccount.closeIfEmpty.mockImplementation(async (_o: string, mint: string) => {
      if (mint === m[0]) return { status: 'closed', tx: 'closeSigA', rentLamports: '2039280', reason: null };
      if (mint === m[1]) return { status: 'skipped', tx: null, rentLamports: null, reason: 'balance above zero (5 raw)' };
      if (mint === m[2]) return { status: 'skipped', tx: null, rentLamports: null, reason: 'token account missing' };
      if (mint === m[3]) return { status: 'failed', tx: null, rentLamports: null, reason: 'no signer for this owner' };
      throw new Error('rpc down');
    });
    const r = await runPositionCleanup(bot as any);
    expect(closeAccount.closeIfEmpty.mock.calls.map(c => c[1])).toEqual(m);                 // exactly the registry mints, in order
    for (const c of closeAccount.closeIfEmpty.mock.calls) expect(c[0]).toBe(OWNER_A);
    expect(r).toMatchObject({ accountsClosed: 1, accountsSkipped: 2, accountsFailed: 2 });
    expect(readTradeRegistry(dir).map(e => e.mint)).toEqual([m[1], m[3], m[4]]);             // closed and missing are forgotten; the rest is kept
  });

  it('a mint with an open position is not touched', async () => {
    writer.put(pos({ position_id: 'p1', ca: CA1 }));
    recordTrade(dir, OWNER_A, CA1, T0);
    recordTrade(dir, OWNER_A, CA2, T0);
    await runPositionCleanup(bot as any);
    expect(closeAccount.closeIfEmpty.mock.calls.map(c => c[1])).toEqual([CA2]);
  });

  it('without a CloseAccount API, or with an empty or broken registry, nothing is sent', async () => {
    recordTrade(dir, OWNER_A, CA2, T0);
    configure({ closeAccount: null });
    expect(await runPositionCleanup(bot as any)).toMatchObject({ accountsClosed: 0, accountsSkipped: 0, accountsFailed: 0 });
    configure();
    fs.writeFileSync(path.join(dir, TRADE_REGISTRY_FILE), '{ broken');
    await runPositionCleanup(bot as any);
    fs.rmSync(path.join(dir, TRADE_REGISTRY_FILE));
    await runPositionCleanup(bot as any);
    expect(closeAccount.closeIfEmpty).not.toHaveBeenCalled();
  });

  it('at most MAX_SWEEP_CLOSES accounts are tried per sweep', async () => {
    for (let i = 0; i < MAX_SWEEP_CLOSES + 5; i++) recordTrade(dir, OWNER_A, key(100 + i), T0);
    await runPositionCleanup(bot as any);
    expect(closeAccount.closeIfEmpty).toHaveBeenCalledTimes(MAX_SWEEP_CLOSES);
  });

  it('recordTrade is idempotent per (owner, mint) and bounded; readTradeRegistry accepts a bare array and skips bad rows', () => {
    recordTrade(dir, OWNER_A, CA1, T0);
    recordTrade(dir, OWNER_A, CA1, T0 + 5);
    recordTrade(dir, OWNER_B, CA1, T0);
    expect(readTradeRegistry(dir)).toEqual([E(OWNER_A, CA1), E(OWNER_B, CA1)]);
    fs.writeFileSync(path.join(dir, TRADE_REGISTRY_FILE), JSON.stringify([{ owner: OWNER_A, mint: CA2, at: 5 }, { owner: 1, mint: 'x' }, null, { owner: OWNER_B, mint: CA1 }]));
    expect(readTradeRegistry(dir)).toEqual([{ owner: OWNER_A, mint: CA2, at: 5 }, { owner: OWNER_B, mint: CA1, at: 0 }]);
    const big = Array.from({ length: TRADE_REGISTRY_MAX + 3 }, (_, i) => ({ owner: OWNER_A, mint: `m${i}`, at: i }));
    fs.writeFileSync(path.join(dir, TRADE_REGISTRY_FILE), JSON.stringify({ schema: 1, entries: big }));
    recordTrade(dir, OWNER_A, 'newest', T0);
    const after = readTradeRegistry(dir);
    expect(after).toHaveLength(TRADE_REGISTRY_MAX);
    expect(after.at(-1)!.mint).toBe('newest');
  });
});

describe('schedule', () => {
  it('sweeps once at start and then 10 minutes after each sweep finished, on the injected clock; stop() ends it', async () => {
    const sweeps = vi.fn(async () => held(CA1));                         // the wallet still holds the token: the position stays
    configure({ allBalances: sweeps as any });
    writer.put(pos({ position_id: 'p1' }));
    const handle = startPositionCleanupSchedule(bot as any);
    await clock.advance(0);
    expect(sweeps).toHaveBeenCalledTimes(1);
    await clock.advance(10 * 60_000 - 1);
    expect(sweeps).toHaveBeenCalledTimes(1);
    await clock.advance(1);
    expect(sweeps).toHaveBeenCalledTimes(2);
    await clock.advance(20 * 60_000);
    expect(sweeps).toHaveBeenCalledTimes(4);
    handle.stop();
    await clock.advance(60 * 60_000);
    expect(sweeps).toHaveBeenCalledTimes(4);
    expect(clock.pendingTimers()).toBe(0);
  });
});
