/**
 * R7-W5 tx-deltas.ts: the delta helpers moved unchanged out of fills.ts (re-exported there), plus rentPaidLamports and the decimals of the meta.
 * Synthetic metas only; every address is derived at test time (A-20).
 */
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import * as fills from './fills';
import { accountKeysOf, computeTxDeltas, rentPaidLamports, type RpcTransactionView } from './tx-deltas';

const fixtureKey = (i: number): string => bs58.encode(createHash('sha256').update('ps-fixture-' + i).digest());
const OWNER = fixtureKey(1);
const MINT = fixtureKey(2);
const TRADE_ATA = fixtureKey(3);
const WSOL_ATA = fixtureKey(4);
const CURVE = fixtureKey(5);
const WSOL = 'So11111111111111111111111111111111111111112';
const tokenBal = (accountIndex: number, owner: string, mint: string, amount: string, decimals = 6) => ({ accountIndex, mint, owner, uiTokenAmount: { amount, decimals } });

/** A buy that creates the trade account (index 1), wraps SOL into a wSOL account (index 2) and closes it again in the same transaction. */
function buyView(over: Partial<NonNullable<RpcTransactionView['meta']>> = {}): RpcTransactionView {
  return {
    slot: 4242, blockTime: 1_760_000_000,
    transaction: { message: { accountKeys: [OWNER, TRADE_ATA, WSOL_ATA, CURVE], header: { numRequiredSignatures: 1 }, instructions: [] } },
    meta: {
      err: null, fee: 5_000,
      preBalances: [5_000_000_000, 0, 0, 30_000_000_000],
      postBalances: [4_947_955_720, 2_039_280, 0, 30_050_000_000],
      preTokenBalances: [tokenBal(3, CURVE, MINT, '800000000000')],
      postTokenBalances: [tokenBal(1, OWNER, MINT, '1700000000'), tokenBal(3, CURVE, MINT, '799998300000')],
      ...over,
    },
  };
}

describe('tx-deltas', () => {
  it('moved unchanged: fills.ts re-exports the same functions, and the deltas are exact', () => {
    expect(fills.computeTxDeltas).toBe(computeTxDeltas);
    expect(fills.accountKeysOf).toBe(accountKeysOf);
    const d = computeTxDeltas(buyView(), OWNER, MINT)!;
    expect(d.lamportsDelta).toBe(-52_044_280n);
    expect(d.tokenDelta).toBe(1_700_000_000n);
    expect(d.feeLamports).toBe(5_000n);
    expect(d.metaFee).toBe(5_000n);
    expect(d.blockTimeMs).toBe(1_760_000_000_000);
    expect(d.decimals).toBe(6);
    expect(accountKeysOf(buyView())).toEqual([OWNER, TRADE_ATA, WSOL_ATA, CURVE]);
    // the fee counts for the owner only when the owner is the fee payer
    const other = computeTxDeltas(buyView({ preBalances: [1, 5, 5, 5], postBalances: [1, 5, 5, 5] }), CURVE, MINT)!;
    expect(other.feeLamports).toBe(0n);
  });

  it('rentPaidLamports counts the owner token accounts this transaction created, not the ones that existed, not a closed wSOL account', () => {
    // the trade account was created (pre 0, post 2 039 280); the wSOL account was created and closed (absent from the post list)
    expect(rentPaidLamports(buyView(), OWNER)).toBe(2_039_280n);
    expect(computeTxDeltas(buyView(), OWNER, MINT)!.rentPaidLamports).toBe(2_039_280n);
    // the trade account existed before: no rent paid
    const existed = buyView({ preBalances: [5_000_000_000, 2_039_280, 0, 30_000_000_000], postBalances: [4_949_994_000, 2_039_280, 0, 30_050_000_000], preTokenBalances: [tokenBal(1, OWNER, MINT, '10'), tokenBal(3, CURVE, MINT, '800000000000')] });
    expect(rentPaidLamports(existed, OWNER)).toBe(0n);
    // a wSOL account left open holds its wrapped amount on top of its rent: only the rent counts
    const wrapped = buyView({
      preBalances: [5_000_000_000, 0, 0, 30_000_000_000], postBalances: [4_900_000_000, 2_039_280, 52_039_280, 30_050_000_000],
      postTokenBalances: [tokenBal(1, OWNER, MINT, '1700000000'), tokenBal(2, OWNER, WSOL, '50000000', 9), tokenBal(3, CURVE, MINT, '799998300000')],
    });
    expect(rentPaidLamports(wrapped, OWNER)).toBe(2_039_280n + 2_039_280n);
    // somebody else's new token account is not the owner's rent
    const foreign = buyView({ postTokenBalances: [tokenBal(1, CURVE, MINT, '1700000000')] });
    expect(rentPaidLamports(foreign, OWNER)).toBe(0n);
  });

  it('an amount that cannot be read is null (or makes the whole read null), never 0', () => {
    expect(rentPaidLamports(null, OWNER)).toBeNull();
    expect(rentPaidLamports(buyView({ preBalances: [1, 2] }), OWNER)).toBeNull();                                    // pre/post lengths differ
    expect(rentPaidLamports(buyView({ postBalances: [4_947_955_720, 'x' as unknown as number, 0, 1] }), OWNER)).toBeNull();
    expect(computeTxDeltas({ ...buyView(), meta: null }, OWNER, MINT)).toBeNull();
    expect(computeTxDeltas(buyView(), fixtureKey(77), MINT)).toBeNull();                                              // the owner is not in the transaction
    expect(computeTxDeltas(buyView({ postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: OWNER, uiTokenAmount: { amount: '1.5', decimals: 6 } }] }), OWNER, MINT)).toBeNull();
    expect(computeTxDeltas(buyView(), OWNER, fixtureKey(78))!.decimals).toBeNull();                                  // no entry of the owner for that mint
  });

  it('amounts above 2^53 stay exact', () => {
    const big = 9_007_199_254_740_993n;   // 2^53 + 1
    const v = buyView({
      preBalances: [String(big * 3n) as unknown as number, 0, 0, 1], postBalances: [String(big * 2n) as unknown as number, 2_039_280, 0, 1],
      preTokenBalances: [], postTokenBalances: [tokenBal(1, OWNER, MINT, (big * 5n).toString(), 9)],
    });
    const d = computeTxDeltas(v, OWNER, MINT)!;
    expect(d.lamportsDelta).toBe(-big);
    expect(d.tokenDelta).toBe(big * 5n);
    expect(d.decimals).toBe(9);
  });
});
