/**
 * R7-W5 compute-budget.ts: computeBudgetFeeLamports (moved unchanged out of tx-verify.ts, which re-exports it) and the wallet rules of design 7.4 V2 and 7.5:
 * exactly one limit and one price, the limit rule ceil(units x 1.2) capped at 400 000, the fee line.
 */
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  cuLimitFromUnits, computeBudgetFeeLamports, priorityFeeLamports, setCuLimitInstruction, setCuPriceInstruction, walletComputeBudget, WALLET_CU_LIMIT_MAX,
  JUP_SENDER_FALLBACK_CU, JUP_SENDER_REFERENCE_CU, MAX_COMPUTE_UNITS, senderComputeBudget, senderLimitFromUnits, senderUnitPrice,
} from './compute-budget';
import * as txVerify from './tx-verify';

const fixtureKey = (i: number): string => bs58.encode(createHash('sha256').update('ps-fixture-' + i).digest());
const PAYER = new PublicKey(fixtureKey(1));
const txOf = (ixs: TransactionInstruction[]): VersionedTransaction => new VersionedTransaction(new TransactionMessage({
  payerKey: PAYER, recentBlockhash: fixtureKey(90), instructions: ixs,
}).compileToV0Message());
const transfer = (): TransactionInstruction => SystemProgram.transfer({ fromPubkey: PAYER, toPubkey: new PublicKey(fixtureKey(2)), lamports: 1n });
const RANGE = { minPrice: 10_000, maxPrice: 1_000_000 };

describe('computeBudgetFeeLamports (moved unchanged, re-exported by tx-verify)', () => {
  it('is the same function the signing file exports, and charges ceil(limit x price / 1e6)', () => {
    expect(txVerify.computeBudgetFeeLamports).toBe(computeBudgetFeeLamports);
    expect(computeBudgetFeeLamports(txOf([transfer()]))).toEqual({ ok: true, lamports: 0n });                                                 // no price: no priority fee
    expect(computeBudgetFeeLamports(txOf([setCuLimitInstruction(200_000), setCuPriceInstruction(5_000), transfer()]))).toEqual({ ok: true, lamports: 1_000n });
    expect(computeBudgetFeeLamports(txOf([setCuLimitInstruction(3), setCuPriceInstruction(333_334), transfer()]))).toEqual({ ok: true, lamports: 2n });   // rounds up
    expect(computeBudgetFeeLamports(txOf([setCuPriceInstruction(1_000_000), transfer(), transfer()]))).toEqual({ ok: true, lamports: 400_000n });        // default 200 000 per other instruction
    // fail closed
    expect(computeBudgetFeeLamports(txOf([setCuLimitInstruction(1), setCuLimitInstruction(2), setCuPriceInstruction(1), transfer()]))).toMatchObject({ ok: false });
    expect(computeBudgetFeeLamports(txOf([setCuPriceInstruction(1), setCuPriceInstruction(2), transfer()]))).toMatchObject({ ok: false });
    const deprecated = new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from([0, 1, 0, 0, 0, 1, 0, 0, 0]) });
    expect(computeBudgetFeeLamports(txOf([deprecated, transfer()]))).toMatchObject({ ok: false, reason: expect.stringContaining('RequestUnits') });
  });
});

describe('the wallet compute-budget rules', () => {
  it('the limit is ceil(units x 1.2) capped at 400 000, the fee line is ceil(limit x price / 1e6)', () => {
    expect(cuLimitFromUnits(0)).toBe(1);
    expect(cuLimitFromUnits(1)).toBe(2);
    expect(cuLimitFromUnits(60_000)).toBe(72_000);
    expect(cuLimitFromUnits(60_001)).toBe(72_002);
    expect(cuLimitFromUnits(333_332)).toBe(399_999);
    expect(cuLimitFromUnits(333_333)).toBe(WALLET_CU_LIMIT_MAX);
    expect(cuLimitFromUnits(333_334)).toBe(WALLET_CU_LIMIT_MAX);
    expect(cuLimitFromUnits(5_000_000n)).toBe(WALLET_CU_LIMIT_MAX);
    expect(priorityFeeLamports(72_000, 50_000)).toBe(3_600n);
    expect(priorityFeeLamports(3, 333_334)).toBe(2n);
    expect(priorityFeeLamports(WALLET_CU_LIMIT_MAX, 1_000_000)).toBe(400_000n);
  });

  it('accepts exactly one limit and one price in range; refuses anything else of the program', () => {
    const ok = walletComputeBudget(txOf([setCuLimitInstruction(72_000), setCuPriceInstruction(50_000), transfer()]), RANGE);
    expect(ok).toEqual({ ok: true, value: { cuLimit: 72_000, cuPriceMicrolamports: 50_000, feeLamports: 3_600n } });
    const reason = (ixs: TransactionInstruction[]): string => {
      const r = walletComputeBudget(txOf(ixs), RANGE);
      return r.ok ? 'accepted' : r.reason;
    };
    expect(reason([setCuLimitInstruction(1), setCuLimitInstruction(2), setCuPriceInstruction(50_000), transfer()])).toMatch(/more than one SetComputeUnitLimit/);
    expect(reason([setCuLimitInstruction(1), setCuPriceInstruction(50_000), setCuPriceInstruction(60_000), transfer()])).toMatch(/more than one SetComputeUnitPrice/);
    expect(reason([ComputeBudgetProgram.requestHeapFrame({ bytes: 65_536 }), setCuLimitInstruction(1), setCuPriceInstruction(50_000), transfer()])).toMatch(/RequestHeapFrame/);
    expect(reason([setCuLimitInstruction(WALLET_CU_LIMIT_MAX + 1), setCuPriceInstruction(50_000), transfer()])).toMatch(/outside 1\.\.400000/);
    expect(reason([setCuLimitInstruction(1_000), setCuPriceInstruction(9_999), transfer()])).toMatch(/outside 10000\.\.1000000/);
    expect(reason([setCuLimitInstruction(1_000), setCuPriceInstruction(1_000_001), transfer()])).toMatch(/outside 10000\.\.1000000/);
    expect(reason([setCuPriceInstruction(50_000), transfer()])).toMatch(/no SetComputeUnitLimit/);
    expect(reason([setCuLimitInstruction(1_000), transfer()])).toMatch(/no SetComputeUnitPrice/);
    expect(reason([new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from([4, 1, 0, 0, 0]) }), setCuLimitInstruction(1_000), setCuPriceInstruction(50_000), transfer()]))
      .toMatch(/SetLoadedAccountsDataSizeLimit/);
    expect(reason([new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from([9]) }), setCuLimitInstruction(1_000), setCuPriceInstruction(50_000), transfer()]))
      .toMatch(/unknown ComputeBudget/);
  });
});

// ── FIX-BUY: the compute budget of the Jupiter Sender (/swap/v2/build) path ───────────────────────────────────────────────────
// 38HZ... (2026-11-06) reverted with ComputationalBudgetExceeded: the bot signed a fixed 200 000-unit limit and a multi-hop route with four
// new token accounts needed more. The limit now comes from a simulation; Jupiter's price is scaled so the fee never grows.

/** [program, tag, value] of each instruction (value = the u32 or u64 argument, null when the data has another length). */
const cbOf = (ixs: readonly TransactionInstruction[]): Array<[string, number, bigint | null]> => ixs.map((ix) => {
  const d = Buffer.from(ix.data);
  return [ix.programId.toBase58(), d.length > 0 ? d[0] : -1, d.length === 5 ? BigInt(d.readUInt32LE(1)) : d.length === 9 ? d.readBigUInt64LE(1) : null];
});
const CB = ComputeBudgetProgram.programId.toBase58();
const priceIx = (p: number | bigint): TransactionInstruction => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p });
/** The fee the OLD composition charged at Jupiter's price: the fixed 200 000 limit and the price passed through. */
const feeBefore = (p: number | bigint): bigint => {
  const r = computeBudgetFeeLamports(txOf([setCuLimitInstruction(200_000), priceIx(p), transfer()]));
  if (!r.ok) throw new Error(r.reason);
  return r.lamports;
};
const feeOf = (ixs: readonly TransactionInstruction[]): bigint => {
  const r = computeBudgetFeeLamports(txOf([...ixs, transfer()]));
  if (!r.ok) throw new Error(r.reason);
  return r.lamports;
};

describe('FIX-BUY the Jupiter Sender compute budget', () => {
  it('FIXBUY-T01 the limit is the measured units x 1.2, at least the old 200 000 and at most 1 400 000; the price is scaled so the fee never exceeds the old fee', () => {
    expect(JUP_SENDER_REFERENCE_CU).toBe(200_000);
    expect(JUP_SENDER_FALLBACK_CU).toBe(600_000);
    expect(MAX_COMPUTE_UNITS).toBe(1_400_000n);
    // the limit rule (the wallet rule ceil(units x 1.2), with the old limit as the floor and the runtime maximum as the cap)
    expect(senderLimitFromUnits(0)).toBe(200_000);
    expect(senderLimitFromUnits(150_000)).toBe(200_000);
    expect(senderLimitFromUnits(166_666)).toBe(200_000);
    expect(senderLimitFromUnits(166_667)).toBe(200_001);
    expect(senderLimitFromUnits(270_000)).toBe(324_000);
    expect(senderLimitFromUnits(1_166_665)).toBe(1_399_998);
    expect(senderLimitFromUnits(1_166_666)).toBe(1_400_000);                // ceil(1 399 999.2)
    expect(senderLimitFromUnits(1_300_000)).toBe(1_400_000);
    expect(senderLimitFromUnits(5_000_000n)).toBe(1_400_000);
    // the wallet rule is unchanged (cap 400 000 by default); a caller may name another cap
    expect(cuLimitFromUnits(333_334)).toBe(WALLET_CU_LIMIT_MAX);
    expect(cuLimitFromUnits(1_000_000, 1_400_000)).toBe(1_200_000);

    // 38HZ: Jupiter sent only a price (9 micro-lamports / unit); a route measured at 270 000 units
    const a = senderComputeBudget([priceIx(9)], 324_000);
    if (!a.ok) throw new Error(a.reason);
    expect(cbOf(a.instructions)).toEqual([[CB, 2, 324_000n], [CB, 3, 6n]]);
    expect(a).toMatchObject({ cuLimit: 324_000, cuPrice: 6n });
    expect(feeOf(a.instructions)).toBe(2n);
    expect(feeBefore(9)).toBe(2n);
    // 2jeX's price (1 319) at the fallback limit
    const b = senderComputeBudget([priceIx(1_319)], JUP_SENDER_FALLBACK_CU);
    if (!b.ok) throw new Error(b.reason);
    expect(cbOf(b.instructions)).toEqual([[CB, 2, 600_000n], [CB, 3, 440n]]);
    expect(feeOf(b.instructions)).toBe(264n);
    expect(feeBefore(1_319)).toBe(264n);
    // a light route keeps exactly the old instructions: limit 200 000 and Jupiter's own price
    const c = senderComputeBudget([priceIx(5_000)], senderLimitFromUnits(150_000));
    if (!c.ok) throw new Error(c.reason);
    expect(c.instructions.map((ix) => Buffer.from(ix.data).toString('hex'))).toEqual([setCuLimitInstruction(200_000), priceIx(5_000)].map((ix) => Buffer.from(ix.data).toString('hex')));

    // a limit from Jupiter is dropped: exactly one limit (the bot's); heap frame and loaded-data limit are kept after the price
    const heap = ComputeBudgetProgram.requestHeapFrame({ bytes: 65_536 });
    const loaded = new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from([4, 0, 0, 4, 0]) });
    const d = senderComputeBudget([setCuLimitInstruction(1_400_000), heap, priceIx(9), loaded], 324_000);
    if (!d.ok) throw new Error(d.reason);
    expect(cbOf(d.instructions)).toEqual([[CB, 2, 324_000n], [CB, 3, 6n], [CB, 1, 65_536n], [CB, 4, 262_144n]]);
    expect(computeBudgetFeeLamports(txOf([...d.instructions, transfer()]))).toEqual({ ok: true, lamports: 2n });
    // no price from Jupiter: no price from the bot either (no priority fee, as before)
    const e = senderComputeBudget([], 600_000);
    if (!e.ok) throw new Error(e.reason);
    expect(cbOf(e.instructions)).toEqual([[CB, 2, 600_000n]]);
    expect(e.cuPrice).toBeNull();
    expect(feeOf(e.instructions)).toBe(0n);

    // refused (nothing is repaired): two prices, the deprecated RequestUnits, an unknown tag, malformed data, another program, two heap frames, a bad limit
    const why = (ixs: TransactionInstruction[], limit = 324_000): string => { const r = senderComputeBudget(ixs, limit); return r.ok ? 'accepted' : r.reason; };
    expect(why([priceIx(9), priceIx(10)])).toMatch(/more than one SetComputeUnitPrice/);
    expect(why([new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from([0, 1, 0, 0, 0, 1, 0, 0, 0]) })])).toMatch(/RequestUnits/);
    expect(why([new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from([9]) })])).toMatch(/unknown ComputeBudget/);
    expect(why([new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.alloc(0) })])).toMatch(/unknown ComputeBudget/);
    expect(why([new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0]) })])).toMatch(/malformed SetComputeUnitPrice/);
    expect(why([new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from([2, 1, 0, 0]) })])).toMatch(/malformed SetComputeUnitLimit/);
    expect(why([transfer()])).toMatch(/not a ComputeBudget instruction/);
    expect(why([heap, heap])).toMatch(/more than one RequestHeapFrame/);
    expect(why([priceIx(9)], 0)).toMatch(/limit/);
    expect(why([priceIx(9)], 1_400_001)).toMatch(/limit/);
    expect(why([priceIx(9)], 324_000.5)).toMatch(/limit/);
  });

  it('FIXBUY-T01 grid: for every Jupiter price and every limit the bot can sign, the price never goes up and the fee is never above the old fee', () => {
    const prices = [0n, 1n, 6n, 7n, 9n, 1_319n, 5_000n, 50_000n, 5_000_000n, 18_446_744_073_709_551_615n];
    const limits = [200_000, 200_001, 324_000, 480_000, JUP_SENDER_FALLBACK_CU, 1_000_000, 1_000_001, Number(MAX_COMPUTE_UNITS)];
    for (const p of prices) {
      for (const limit of limits) {
        const out = senderComputeBudget([priceIx(p)], limit);
        if (!out.ok) throw new Error(out.reason);
        const scaled = out.cuPrice as bigint;
        expect(scaled, `price ${p} at ${limit}`).toBe(senderUnitPrice(p, limit));
        expect(scaled <= p, `price ${p} at ${limit}: ${scaled} is not above Jupiter's`).toBe(true);
        expect(feeOf(out.instructions) <= feeBefore(p), `price ${p} at ${limit}: fee ${feeOf(out.instructions)} is not above the old ${feeBefore(p)}`).toBe(true);
        expect(feeOf(out.instructions), 'the fee is ceil(limit x price / 1e6)').toBe(priorityFeeLamports(limit, scaled));
      }
    }
    // at the old limit nothing changes; the worst case before and after is ceil(200 000 x price / 1e6), e.g. 1 000 000 lamports at the bot's own 5 000 000 ceiling
    for (const p of prices) expect(senderUnitPrice(p, 200_000)).toBe(p);
    expect(feeBefore(5_000_000n)).toBe(1_000_000n);
    expect(senderUnitPrice(5_000_000n, 1_400_000)).toBe(714_285n);
    expect(priorityFeeLamports(1_400_000, 714_285n)).toBe(999_999n);
  });
});

// ── FIX-BUY2 item 3: Jupiter's price is clamped to the bot's own maximum (Jupiter's compute-units page) ────────────────────────────
describe('FIX-BUY2 item 3: Jupiter\'s unit price is clamped to the ceiling before it is scaled', () => {
  const CEILING = 5_000_000n;                                            // PRIORITY_FEE_CEILING_MICROLAMPORTS, default

  it('FIXBUY2-T15 a Jupiter price above the ceiling is signed at the ceiling (then scaled to the limit); 9 and 1 319 (38HZ, 2jeX) are unchanged; the fee at the ceiling is at most 1 000 000 lamports', () => {
    // 50 000 000 micro-lamports per unit (a spike): at the reference limit the ceiling itself, at a measured 324 000 the ceiling scaled
    const spike = senderComputeBudget([priceIx(50_000_000)], 200_000, { maxPrice: CEILING });
    if (!spike.ok) throw new Error(spike.reason);
    expect(cbOf(spike.instructions)).toEqual([[CB, 2, 200_000n], [CB, 3, CEILING]]);
    expect(feeOf(spike.instructions)).toBe(1_000_000n);
    const scaled = senderComputeBudget([priceIx(50_000_000)], 324_000, { maxPrice: CEILING });
    if (!scaled.ok) throw new Error(scaled.reason);
    expect(scaled.cuPrice).toBe(senderUnitPrice(CEILING, 324_000));
    expect(feeOf(scaled.instructions) <= 1_000_000n).toBe(true);
    // without the clamp (FIX-BUY) the same spike cost ten times as much
    const unclamped = senderComputeBudget([priceIx(50_000_000)], 200_000);
    if (!unclamped.ok) throw new Error(unclamped.reason);
    expect(feeOf(unclamped.instructions)).toBe(10_000_000n);
    // the recorded prices are far below the ceiling: the same instructions with or without it
    for (const [p, limit] of [[9, 324_000], [1_319, JUP_SENDER_FALLBACK_CU], [1_319, 200_000], [5_000, 200_000]] as const) {
      const a = senderComputeBudget([priceIx(p)], limit, { maxPrice: CEILING });
      const b = senderComputeBudget([priceIx(p)], limit);
      if (!a.ok || !b.ok) throw new Error('refused');
      expect(a.instructions.map((ix) => Buffer.from(ix.data).toString('hex')), `${p} at ${limit}`).toEqual(b.instructions.map((ix) => Buffer.from(ix.data).toString('hex')));
    }
    // a price exactly at the ceiling is kept; a ceiling of 0 signs a zero price (no priority fee)
    const at = senderComputeBudget([priceIx(CEILING)], 200_000, { maxPrice: CEILING });
    expect(at.ok && at.cuPrice).toBe(CEILING);
    const zero = senderComputeBudget([priceIx(9)], 200_000, { maxPrice: 0n });
    expect(zero.ok && zero.cuPrice).toBe(0n);
    // an unusable maximum is refused (fail closed)
    const bad = senderComputeBudget([priceIx(9)], 200_000, { maxPrice: -1n });
    expect(bad.ok ? 'accepted' : bad.reason).toMatch(/maximum compute unit price/);
  });

  it('FIXBUY2-T20 (item 4) the RPC lane: a fixed fee is spread over the limit, floor(fee x 1e6 / limit); Jupiter\'s price is ignored (still checked); the price is always written; the fee is never above the fixed fee', () => {
    const a = senderComputeBudget([priceIx(9)], 324_000, { fixedFeeLamports: 123_456n, maxPrice: CEILING });
    if (!a.ok) throw new Error(a.reason);
    expect(cbOf(a.instructions)).toEqual([[CB, 2, 324_000n], [CB, 3, 381_037n]]);
    expect(feeOf(a.instructions)).toBe(123_456n);
    // no price from Jupiter: the owner's fee is still signed; a fee of 0 writes a zero price (the measured and signed messages match)
    const b = senderComputeBudget([], 200_000, { fixedFeeLamports: 100_000n });
    if (!b.ok) throw new Error(b.reason);
    expect(cbOf(b.instructions)).toEqual([[CB, 2, 200_000n], [CB, 3, 500_000n]]);
    const z = senderComputeBudget([priceIx(50_000_000)], 200_000, { fixedFeeLamports: 0n });
    if (!z.ok) throw new Error(z.reason);
    expect(cbOf(z.instructions)).toEqual([[CB, 2, 200_000n], [CB, 3, 0n]]);
    expect(feeOf(z.instructions)).toBe(0n);
    // Jupiter's list is still checked; heap frame / loaded-data limit kept after the price
    expect(senderComputeBudget([priceIx(9), priceIx(10)], 200_000, { fixedFeeLamports: 1n }).ok).toBe(false);
    const heap = ComputeBudgetProgram.requestHeapFrame({ bytes: 65_536 });
    const c = senderComputeBudget([heap, priceIx(9)], 200_000, { fixedFeeLamports: 100_000n });
    if (!c.ok) throw new Error(c.reason);
    expect(cbOf(c.instructions)).toEqual([[CB, 2, 200_000n], [CB, 3, 500_000n], [CB, 1, 65_536n]]);
    // grid: the fee is at most the fixed fee for every limit the bot can sign
    for (const fee of [0n, 1n, 5_000n, 100_000n, 123_456n, 5_000_000n]) {
      for (const limit of [200_000, 200_001, 324_000, JUP_SENDER_FALLBACK_CU, 1_000_001, Number(MAX_COMPUTE_UNITS)]) {
        const out = senderComputeBudget([priceIx(9)], limit, { fixedFeeLamports: fee });
        if (!out.ok) throw new Error(out.reason);
        expect(out.cuPrice, `${fee} at ${limit}`).toBe((fee * 1_000_000n) / BigInt(limit));
        expect(feeOf(out.instructions) <= fee, `${fee} at ${limit}`).toBe(true);
      }
    }
    // an unusable fee is refused (fail closed)
    const bad = senderComputeBudget([], 200_000, { fixedFeeLamports: -1n });
    expect(bad.ok ? 'accepted' : bad.reason).toMatch(/fixed priority fee/);
  });

  it('FIXBUY2-T15 grid: with the ceiling, for every Jupiter price up to u64 max and every limit the bot can sign, the fee is at most ceil(200 000 x ceiling / 1e6) = 1 000 000 lamports', () => {
    const prices = [0n, 1n, 9n, 1_319n, 5_000_000n, 5_000_001n, 50_000_000n, 18_446_744_073_709_551_615n];
    const limits = [200_000, 324_000, JUP_SENDER_FALLBACK_CU, 1_000_001, Number(MAX_COMPUTE_UNITS)];
    for (const p of prices) {
      for (const limit of limits) {
        const out = senderComputeBudget([priceIx(p)], limit, { maxPrice: CEILING });
        if (!out.ok) throw new Error(out.reason);
        expect(feeOf(out.instructions) <= 1_000_000n, `price ${p} at ${limit}`).toBe(true);
        expect((out.cuPrice as bigint) <= (p < CEILING ? p : CEILING), `price ${p} at ${limit}`).toBe(true);
      }
    }
  });
});
