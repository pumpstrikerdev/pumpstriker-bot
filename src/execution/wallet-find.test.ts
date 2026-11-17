/**
 * R7-W5 wallet-find.ts: after an "outcome unknown" wallet error, look for the transaction the wallet may have sent. A scripted RPC port counts
 * every call; addresses derive at test time and signatures are generated at runtime (A-20).
 */
import { createHash, randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { RpcBudgetError } from './rpc-budget';
import type { RpcTransactionView } from './tx-deltas';
import { findWalletTransactions, WALLET_FIND_MAX_CANDIDATES, WALLET_FIND_SIGNATURE_LIMIT } from './wallet-find';
import { WalletRpcError, type WalletRpcPort } from './wallet-rpc';

const fixtureKey = (i: number): string => bs58.encode(createHash('sha256').update('ps-fixture-' + i).digest());
const newSig = (): string => bs58.encode(randomBytes(64));
const OWNER = fixtureKey(1);
const MINT = fixtureKey(2);
const OTHER_MINT = fixtureKey(3);
const ATA = fixtureKey(4);

/** A transaction that moved `delta` of `mint` for the owner (positive: a buy, negative: a sell), paid by `payer`. */
function tx(mint: string, delta: bigint, payer = OWNER, err: unknown = null): RpcTransactionView {
  const pre = delta < 0n ? -delta : 0n;
  const post = delta > 0n ? delta : 0n;
  return {
    slot: 900, blockTime: 1_760_000_000,
    transaction: { message: { accountKeys: [payer, ATA, fixtureKey(5)], header: { numRequiredSignatures: 1 }, instructions: [] } },
    meta: {
      err, fee: 5000, preBalances: [1_000_000_000, 2_039_280, 1], postBalances: [990_000_000, 2_039_280, 1],
      preTokenBalances: [{ accountIndex: 1, mint, owner: OWNER, uiTokenAmount: { amount: pre.toString(), decimals: 6 } }],
      postTokenBalances: [{ accountIndex: 1, mint, owner: OWNER, uiTokenAmount: { amount: post.toString(), decimals: 6 } }],
    },
  };
}

interface Row { signature: string; slot: number; err: unknown }
function setup(rows: Row[], txs: Map<string, RpcTransactionView | null | Error>) {
  const log: Array<{ method: string; params: any[] }> = [];
  const rpc: WalletRpcPort = {
    async call(method: string, params: unknown[]): Promise<any> {
      log.push({ method, params: params as any[] });
      if (method === 'getSignaturesForAddress') return rows;
      if (method === 'getTransaction') {
        const t = txs.get((params as string[])[0]);
        if (t instanceof Error) throw t;
        return t ?? null;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { rpc, log };
}

describe('wallet find', () => {
  it('WTX-T16 matches the owner transaction for the quote mint and side, ignores others, and stays within 1 + 3 RPC calls', async () => {
    const sigs = Array.from({ length: 6 }, newSig);
    const rows: Row[] = [
      { signature: sigs[0], slot: 905, err: null },          // newest: another mint
      { signature: sigs[1], slot: 904, err: { InstructionError: [0, { Custom: 6002 }] } },   // failed: skipped before any call
      { signature: sigs[2], slot: 903, err: null },          // the match
      { signature: sigs[3], slot: 902, err: null },          // a sell of the same mint (wrong side for a buy)
      { signature: sigs[4], slot: 901, err: null },          // a 4th candidate: never looked at (at most 3 transactions are read)
      { signature: sigs[5], slot: 899, err: null },          // before the quote: never looked at
    ];
    const txs = new Map<string, RpcTransactionView | null>([
      [sigs[0], tx(OTHER_MINT, 5n)], [sigs[2], tx(MINT, 1_700_000_000n)], [sigs[3], tx(MINT, -40n)], [sigs[4], tx(MINT, 7n, fixtureKey(88))], [sigs[5], tx(MINT, 9n)],
    ]);
    const { rpc, log } = setup(rows, txs);
    const r = await findWalletTransactions({ rpc }, { owner: OWNER, mint: MINT, side: 'buy', sinceSlot: 900 });
    expect(r).toEqual({ ok: true, signatures: [sigs[2]] });
    expect(log.map((l) => l.method)).toEqual(['getSignaturesForAddress', 'getTransaction', 'getTransaction', 'getTransaction']);   // 1 + at most 3
    expect(WALLET_FIND_SIGNATURE_LIMIT).toBe(10);
    expect(WALLET_FIND_MAX_CANDIDATES).toBe(3);
    expect(log[0].params).toEqual([OWNER, { limit: 10, commitment: 'confirmed', minContextSlot: 900 }]);
    expect(log.slice(1).map((l) => l.params[0])).toEqual([sigs[0], sigs[2], sigs[3]]);   // the three newest successful ones from the quote slot on; sigs[1] failed, sigs[5] is older
    expect(log.slice(1).every((l) => l.params[1].commitment === 'confirmed' && l.params[1].maxSupportedTransactionVersion === 0)).toBe(true);

    // the same history for a sell finds the sell
    const sell = await findWalletTransactions({ rpc: setup(rows, txs).rpc }, { owner: OWNER, mint: MINT, side: 'sell', sinceSlot: 900 });
    expect(sell).toEqual({ ok: true, signatures: [sigs[3]] });

    // no match yet is an empty list, never a guess; an unreadable candidate is skipped
    const none = await findWalletTransactions({ rpc: setup(rows, new Map<string, RpcTransactionView | null | Error>([[sigs[0], null], [sigs[2], new WalletRpcError('http', 'HTTP 502')], [sigs[3], tx(OTHER_MINT, 1n)]])).rpc }, { owner: OWNER, mint: MINT, side: 'buy', sinceSlot: 900 });
    expect(none).toEqual({ ok: true, signatures: [] });
    const empty = await findWalletTransactions({ rpc: setup([], new Map()).rpc }, { owner: OWNER, mint: MINT, side: 'buy', sinceSlot: 900 });
    expect(empty).toEqual({ ok: true, signatures: [] });

    // a failed transaction of the owner is not a match even if the signature list did not mark it
    const failedTx = setup([{ signature: sigs[0], slot: 905, err: null }], new Map([[sigs[0], tx(MINT, 5n, OWNER, { InstructionError: [2, { Custom: 6002 }] })]]));
    expect((await findWalletTransactions({ rpc: failedTx.rpc }, { owner: OWNER, mint: MINT, side: 'buy', sinceSlot: 900 }))).toEqual({ ok: true, signatures: [] });

    // errors are refusals with a reason: the budget's code, a malformed list, a failing call
    const budget = await findWalletTransactions({ rpc: { async call() { throw new RpcBudgetError('daily'); } } }, { owner: OWNER, mint: MINT, side: 'buy', sinceSlot: 900 });
    expect(budget).toMatchObject({ ok: false, code: 'rpc-budget' });
    const malformed = await findWalletTransactions({ rpc: { async call() { return [{ signature: 5 }]; } } }, { owner: OWNER, mint: MINT, side: 'buy', sinceSlot: 900 });
    expect(malformed).toMatchObject({ ok: false, code: 'build-failed' });
    const down = await findWalletTransactions({ rpc: { async call() { throw new WalletRpcError('http', 'wallet RPC getSignaturesForAddress: HTTP 503'); } } }, { owner: OWNER, mint: MINT, side: 'buy', sinceSlot: 900 });
    expect(down).toMatchObject({ ok: false, code: 'build-failed', reason: expect.stringContaining('503') });
    const badReq = await findWalletTransactions({ rpc }, { owner: 'nope', mint: MINT, side: 'buy', sinceSlot: 900 });
    expect(badReq).toMatchObject({ ok: false, code: 'bad-request' });
  });
});
