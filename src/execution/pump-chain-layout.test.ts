/**
 * FIX-PUMP: the local pump builders and the strict PF-direct verifier against RECORDED MAINNET data (test-fixtures/execution/pump-chain/,
 * read-only getTransaction / getMultipleAccounts on 2026-11-06). Each recorded transaction's pump instruction is rebuilt from the same
 * inputs and must carry the same program id, data bytes and account list (order and flags). Fixture storage follows A-20 / G-S18: keys are
 * base64 of their 32 bytes (program ids by name), transactions only by their 12-character signature label.
 *
 *   T1 buy_exact_sol_in (3AUNQ8, 2UmCR7, 2bAbMH, 4YBaBs)   T2 top-level sell 2jca9 (exact header flags)
 *   T3 non-mayhem legacy buy 5bdqzt and sell 3vEJuM, satasb sell 3cBP (all but its non-canonical account 5)
 *   T4 the verifier's own expected-key table equals the same keys   T5 negatives   T6 quotes = TradeEvents   T7 constants   T8 variants
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import * as pp from './pump-program';
import {
  TOKEN_2022_PROGRAM_PK, TOKEN_PROGRAM_PK, buildBuyInstruction, buildCreateAtaIfNeededIx, buildSellInstruction, deriveBondingCurveV2, deriveCreatorVault,
  pickPumpFeeAccounts, type PumpFeeAccounts,
} from './pumpfun-ix';
import { pumpDirectExpectedAccounts, verifyPumpDirectStatic, type PumpDirectVerifyCtx } from './tx-verify';
import { parseBondingCurve } from './curve-parse';

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const DIR = path.resolve(__dirname, '..', '..', 'test-fixtures', 'execution', 'pump-chain');
interface FxKey { k: string; s: 0 | 1; w: 0 | 1 }
interface FxEvent {
  mint: string; user: string; creator: string; isBuy: boolean; mayhem: boolean; solAmount: string; tokenAmount: string;
  virtualSolReserves: string; virtualTokenReserves: string; realSolReserves: string; realTokenReserves: string;
  feeRecipient: string; feeBps: string; fee: string; creatorFeeBps: string; creatorFee: string; buybackFee: string; quoteMint: string;
}
interface FxTrade { label: string; slot: number; where: string; flags: string; feePayer: string; topLevelPrograms: string[]; keys: FxKey[]; data: string[]; event: FxEvent }
interface FxAccount { label?: string; key: string; owner: string; lamports: string; length: number; data: string[] }
const TRADES = (JSON.parse(fs.readFileSync(path.join(DIR, 'trades.json'), 'utf8')) as { trades: FxTrade[] }).trades;
const ACCOUNTS = JSON.parse(fs.readFileSync(path.join(DIR, 'accounts.json'), 'utf8')) as {
  global: FxAccount; feeConfig: FxAccount; curves: FxAccount[]; mints: FxAccount[]; creatorVaultFUoMp: { key: string; lamports: string };
};

/** Program ids are stored by name; this table spells them out (it does not import the constants under test). */
const PROGRAMS: Record<string, string> = {
  '@system': '11111111111111111111111111111111',
  '@token': 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  '@token2022': 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  '@ata': 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  '@computeBudget': 'ComputeBudget111111111111111111111111111111',
  '@pump': '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  '@pumpFees': 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
};
const dec = (k: string): string => (k.startsWith('@') ? PROGRAMS[k] : new PublicKey(Buffer.from(k, 'base64')).toBase58());
const bytes = (c: string[]): Buffer => Buffer.from(c.join(''), 'base64');
const pk = (s: string): PublicKey => new PublicKey(s);
const trade = (label: string): FxTrade => {
  const t = TRADES.find((x) => x.label === label);
  if (!t) throw new Error(`no fixture ${label}`);
  return t;
};
const curveFx = (label: string): FxAccount => ACCOUNTS.curves.find((c) => c.label === label)!;
const mintFx = (label: string): FxAccount => ACCOUNTS.mints.find((m) => m.label === label)!;
const raw = (a: FxAccount): pp.RawAccount => ({ owner: dec(a.owner), data: bytes(a.data) });
const keysOf = (ix: TransactionInstruction): string[] => ix.keys.map((k) => k.pubkey.toBase58());
const fixtureKeys = (t: FxTrade): string[] => t.keys.map((k) => dec(k.k));
const feesOf = (t: FxTrade): PumpFeeAccounts => ({ feeRecipient: pk(dec(t.keys[1].k)), buybackFeeRecipient: pk(dec(t.keys[t.keys.length - 1].k)) });
const indexes = (pred: (i: number) => boolean, n: number): number[] => Array.from({ length: n }, (_v, i) => i).filter(pred);

const BUYS = ['3AUNQ8x89cfp', '2UmCR7snPvqa', '2bAbMHx3AxuU', '4YBaBsoaqmQd'];
/** The creator of fUoMp, read from its bonding curve 5Ux9 (bytes 49..81). */
const FUOMP_CREATOR = new PublicKey(bytes(curveFx('5Ux9').data).subarray(49, 81)).toBase58();

describe('FIX-PUMP chain layout: the builders reproduce recorded mainnet instructions', () => {
  it('PUMPCHAIN-T1 buy_exact_sol_in: the four recorded buys rebuild to the same program, 18 keys in order, 25 data bytes and flags', () => {
    for (const label of BUYS) {
      const t = trade(label);
      const data = bytes(t.data);
      expect(data).toHaveLength(25);
      const ix = buildBuyInstruction(pk(dec(t.keys[6].k)), pk(dec(t.keys[2].k)), pk(FUOMP_CREATOR), data.readBigUInt64LE(8), data.readBigUInt64LE(16), TOKEN_2022_PROGRAM_PK, feesOf(t));
      expect(ix.programId.toBase58(), label).toBe(PROGRAMS['@pump']);
      expect(keysOf(ix), label).toEqual(fixtureKeys(t));
      expect(ix.data.equals(data), label).toBe(true);
      expect(data[24]).toBe(1);   // track_volume, partial_fill absent
      expect(indexes((i) => ix.keys[i].isSigner, 18)).toEqual([6]);
      expect(indexes((i) => ix.keys[i].isWritable, 18)).toEqual([1, 3, 4, 5, 6, 9, 13, 17]);
      // every key read-only at transaction level in the fixture is read-only in the builder, every builder-writable key is writable there
      expect(indexes((i) => t.keys[i].w === 0, 18)).toEqual([0, 2, 7, 8, 10, 11, 12, 14, 15, 16]);
      for (let i = 0; i < 18; i++) if (t.keys[i].w === 0) expect(ix.keys[i].isWritable, `${label} ${i}`).toBe(false);
      for (let i = 0; i < 18; i++) if (ix.keys[i].isWritable) expect(t.keys[i].w, `${label} ${i}`).toBe(1);
    }
    // the creator vault derived from the curve's creator is the recorded one (2WvoSrBf...)
    expect(deriveCreatorVault(pk(FUOMP_CREATOR)).toBase58()).toBe(dec(ACCOUNTS.creatorVaultFUoMp.key));
    expect(fixtureKeys(trade(BUYS[0]))[9]).toBe(dec(ACCOUNTS.creatorVaultFUoMp.key));
  });

  it('PUMPCHAIN-T2 the top-level sell 2jca9 rebuilds to the same 16 keys, 24 data bytes and the exact (signer, writable) of its header', () => {
    const t = trade('2jca9E3k9xbz');
    const data = bytes(t.data);
    expect(data.readBigUInt64LE(8)).toBe(8_295_905_939_227n);
    expect(data.readBigUInt64LE(16)).toBe(0n);
    const ix = buildSellInstruction(pk(dec(t.keys[6].k)), pk(dec(t.keys[2].k)), pk(FUOMP_CREATOR), 8_295_905_939_227n, 0n, false, TOKEN_2022_PROGRAM_PK, feesOf(t));
    expect(keysOf(ix)).toEqual(fixtureKeys(t));
    expect(ix.data.equals(data)).toBe(true);
    expect(ix.keys.map((k) => [k.isSigner ? 1 : 0, k.isWritable ? 1 : 0])).toEqual(t.keys.map((k) => [k.s, k.w]));
    expect(dec(t.keys[1].k)).toBe(pp.PUMP_FEE_RECIPIENTS_MAYHEM[0]);       // GesfTA...: a mayhem coin pays the RESERVED list
    expect(dec(t.keys[15].k)).toBe(pp.PUMP_BUYBACK_FEE_RECIPIENTS[1]);     // 9M4giFFM...
  });

  it('PUMPCHAIN-T3 non-mayhem coins: the legacy buy 5bdqzt and the sell 3vEJuM rebuild key for key, and 3cBP at every position but its non-canonical account 5', () => {
    const b = trade('5bdqztZDnkuY');
    const buy = buildBuyInstruction(pk(dec(b.keys[6].k)), pk(dec(b.keys[2].k)), pk(dec(b.event.creator)), 1n, 1n, TOKEN_2022_PROGRAM_PK, feesOf(b));
    expect(keysOf(buy)).toEqual(fixtureKeys(b));
    expect(dec(b.keys[1].k)).toBe(pp.PUMP_FEE_RECIPIENTS_NORMAL[0]);       // 62qc...
    expect(dec(b.keys[17].k)).toBe(pp.PUMP_BUYBACK_FEE_RECIPIENTS[7]);     // A7hAgC...
    expect(dec(b.keys[16].k)).toBe(deriveBondingCurveV2(pk(dec(b.keys[2].k))).toBase58());

    const s = trade('3vEJuMHF6xec');
    const sd = bytes(s.data);
    const sell = buildSellInstruction(pk(dec(s.keys[6].k)), pk(dec(s.keys[2].k)), pk(dec(s.event.creator)), sd.readBigUInt64LE(8), sd.readBigUInt64LE(16), false, TOKEN_2022_PROGRAM_PK, feesOf(s));
    expect(keysOf(sell)).toEqual(fixtureKeys(s));
    expect(sell.data.equals(sd)).toBe(true);
    expect(dec(s.keys[1].k)).toBe(pp.PUMP_FEE_RECIPIENTS_NORMAL[0]);
    expect(dec(s.keys[15].k)).toBe(pp.PUMP_BUYBACK_FEE_RECIPIENTS[7]);

    const c = trade('3cBPhfAEwv');
    const cd = bytes(c.data);
    const satasb = buildSellInstruction(pk(dec(c.keys[6].k)), pk(dec(c.keys[2].k)), pk(dec(c.event.creator)), cd.readBigUInt64LE(8), cd.readBigUInt64LE(16), false, TOKEN_2022_PROGRAM_PK, feesOf(c));
    expect(satasb.data.equals(cd)).toBe(true);
    const got = keysOf(satasb);
    const want = fixtureKeys(c);
    for (let i = 0; i < 16; i++) if (i !== 5) expect(got[i], `3cBP ${i}`).toBe(want[i]);
    expect(got[5]).not.toBe(want[5]);   // pump accepted a non-canonical associated_user here; the builder and the verifier pin the canonical ATA
  });

  it('PUMPCHAIN-T4 the verifier derives the same keys itself (no builder): every recorded position, list members where a list is pinned', () => {
    const cases: Array<[FxTrade, 'buy' | 'sell', number[]]> = [
      ...BUYS.map((l) => [trade(l), 'buy', []] as [FxTrade, 'buy', number[]]),
      [trade('2jca9E3k9xbz'), 'sell', []], [trade('5bdqztZDnkuY'), 'buy', []], [trade('3vEJuMHF6xec'), 'sell', []], [trade('3cBPhfAEwv'), 'sell', [5]],
    ];
    for (const [t, side, skip] of cases) {
      const keys = fixtureKeys(t);
      const exp = pumpDirectExpectedAccounts({
        side, owner: keys[6], mint: keys[2], tokenProgram: PROGRAMS['@token2022'], creator: dec(t.event.creator), mayhem: t.event.mayhem, cashback: false,
      });
      expect(exp).toHaveLength(keys.length);
      exp.forEach((e, i) => {
        if (skip.includes(i)) return;
        if (e.key !== null) expect(keys[i], `${t.label} ${i} ${e.name}`).toBe(e.key);
        else expect(e.list, `${t.label} ${i} ${e.name}`).toContain(keys[i]);
      });
    }
  });
});

// ── a well-formed PF-direct transaction of the fUoMp curve, and its mutations ───────────────────────────────────────────────────
const FUOMP = dec(trade(BUYS[0]).keys[2].k);
const OWNER = dec(trade(BUYS[0]).keys[6].k);
const BLOCKHASH = new PublicKey(createHash('sha256').update('pumpchain-blockhash').digest()).toBase58();
const ctxFor = (side: 'buy' | 'sell', amountIn: bigint): PumpDirectVerifyCtx => ({
  owner: OWNER, mint: FUOMP, side, amountIn, slippageBps: 300, antiMev: false,
  curve: raw(curveFx('5Ux9')), mintAccount: raw(mintFx('fUoMp')), maxCuPriceMicroLamports: 5_000_000n,
});
function minOutFor(ctx: PumpDirectVerifyCtx): bigint {
  const c = pp.classifyPumpCurve(ctx.curve);
  if (!c.ok) throw new Error(c.detail);
  const b = pp.pumpTradeBounds(c.value, ctx.side, ctx.amountIn, ctx.slippageBps);
  if (!b.ok) throw new Error(b.detail);
  return b.value.minOut;
}
function txOf(ixs: TransactionInstruction[]): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({ payerKey: pk(OWNER), recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message());
}
const cb = (): TransactionInstruction[] => [
  new TransactionInstruction({ programId: pk(PROGRAMS['@computeBudget']), keys: [], data: Buffer.from([2, 0x40, 0x0d, 0x03, 0x00]) }),
  new TransactionInstruction({ programId: pk(PROGRAMS['@computeBudget']), keys: [], data: Buffer.concat([Buffer.from([3]), Buffer.from(new BigUint64Array([100_000n]).buffer)]) }),
];
const mayhemFees = (): PumpFeeAccounts => pickPumpFeeAccounts(true, () => 0);
function buyIxs(edit?: (ix: TransactionInstruction) => TransactionInstruction): TransactionInstruction[] {
  const ctx = ctxFor('buy', 50_000_000n);
  const ix = buildBuyInstruction(pk(OWNER), pk(FUOMP), pk(FUOMP_CREATOR), ctx.amountIn, minOutFor(ctx), TOKEN_2022_PROGRAM_PK, mayhemFees());
  return [...cb(), buildCreateAtaIfNeededIx(pk(OWNER), pk(OWNER), pk(FUOMP), TOKEN_2022_PROGRAM_PK), edit ? edit(ix) : ix];
}
const withKey = (ix: TransactionInstruction, i: number, k: Partial<TransactionInstruction['keys'][number]>): TransactionInstruction =>
  new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: ix.keys.map((x, j) => (j === i ? { ...x, ...k } : x)) });

describe('FIX-PUMP chain layout: what the strict verifier refuses', () => {
  it('PUMPCHAIN-T5 refuses the shapes pump tolerates on chain: the mayhem agent\'s bonding_curve_v2, a writable global volume accumulator, 3cBP\'s non-ATA account 5, the FAdo9 wrapper and a v3 discriminator', () => {
    const ok = verifyPumpDirectStatic(txOf(buyIxs()), ctxFor('buy', 50_000_000n));
    expect(ok.ok, ok.ok ? '' : ok.reason).toBe(true);

    // (a) the mayhem agent's (non-canonical) bonding_curve_v2 at position 16
    const agent = trade('5basE6MS26VK');
    const agentV2 = dec(agent.keys[16].k);
    expect(agentV2).not.toBe(deriveBondingCurveV2(pk(dec(agent.keys[2].k))).toBase58());
    expect(verifyPumpDirectStatic(txOf(buyIxs((ix) => withKey(ix, 16, { pubkey: pk(agentV2) }))), ctxFor('buy', 50_000_000n)))
      .toEqual({ ok: false, reason: 'account 16 (bonding_curve_v2)' });
    // (b) global_volume_accumulator writable (the old bot shape) is refused by the role pin
    expect(verifyPumpDirectStatic(txOf(buyIxs((ix) => withKey(ix, 12, { isWritable: true }))), ctxFor('buy', 50_000_000n)))
      .toEqual({ ok: false, reason: 'role of global_volume_accumulator: not signer writable, expected not signer read-only' });
    // bonding_curve_v2 writable (the FAdo9 and satasb shape) too
    expect(verifyPumpDirectStatic(txOf(buyIxs((ix) => withKey(ix, 16, { isWritable: true }))), ctxFor('buy', 50_000_000n)))
      .toEqual({ ok: false, reason: 'role of bonding_curve_v2: not signer writable, expected not signer read-only' });
    // (c) 3cBP's shape: a token account of the owner that is not the canonical ATA at position 5 of a sell
    const c = trade('3cBPhfAEwv');
    const sellCtx = ctxFor('sell', 1_000_000_000n);
    const sell = buildSellInstruction(pk(OWNER), pk(FUOMP), pk(FUOMP_CREATOR), sellCtx.amountIn, minOutFor(sellCtx), false, TOKEN_2022_PROGRAM_PK, mayhemFees());
    expect(verifyPumpDirectStatic(txOf([...cb(), sell]), sellCtx).ok).toBe(true);
    expect(verifyPumpDirectStatic(txOf([...cb(), withKey(sell, 5, { pubkey: pk(dec(c.keys[5].k)) })]), sellCtx))
      .toEqual({ ok: false, reason: 'account 5 (associated_user)' });
    // (d) the FAdo9 wrapper (the program PumpPortal's trade-local returns, from the recorded 5bdqzt) in place of the pump instruction
    const fado9 = dec(trade('5bdqztZDnkuY').topLevelPrograms[3]);
    const wrapped = buyIxs((ix) => new TransactionInstruction({ programId: pk(fado9), keys: ix.keys, data: ix.data }));
    expect(verifyPumpDirectStatic(txOf(wrapped), ctxFor('buy', 50_000_000n))).toEqual({ ok: false, reason: `program not allowed: ${fado9}` });
    // (e) a v3 discriminator (buy_exact_quote_in_v3) and the legacy buy discriminator
    for (const name of ['buy_exact_quote_in_v3', 'buy']) {
      const disc = createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
      const v3 = buyIxs((ix) => new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: Buffer.concat([disc, ix.data.subarray(8)]) }));
      expect(verifyPumpDirectStatic(txOf(v3), ctxFor('buy', 50_000_000n)), name).toEqual({ ok: false, reason: 'pump instruction is not buy_exact_sol_in' });
    }
    // an extra System transfer the caller did not ask for (no antiMev) is an unexpected instruction
    const extra = [...buyIxs(), SystemProgram.transfer({ fromPubkey: pk(OWNER), toPubkey: pk(fado9), lamports: 1 })];
    expect(verifyPumpDirectStatic(txOf(extra), ctxFor('buy', 50_000_000n))).toEqual({ ok: false, reason: 'unexpected instruction 4' });
  });
});

describe('FIX-PUMP chain layout: quotes and constants', () => {
  it('PUMPCHAIN-T6 the quote math reproduces every recorded TradeEvent: the four buy_exact_sol_in to the lamport and atom, the sells 2jca9, 3vEJuM and 3cBP', () => {
    for (const label of BUYS) {
      const e = trade(label).event;
      const spend = bytes(trade(label).data).readBigUInt64LE(8);
      const sol = BigInt(e.solAmount);
      const tok = BigInt(e.tokenAmount);
      // the event carries the post-trade virtual reserves: the pre-trade ones are post minus / plus this trade
      const q = pp.pumpBuyQuote(BigInt(e.virtualSolReserves) - sol, BigInt(e.virtualTokenReserves) + tok, spend)!;
      expect([q.net, q.tokensOut, q.protocolFee, q.creatorFee], label).toEqual([sol, tok, BigInt(e.fee), BigInt(e.creatorFee)]);
      expect(q.net + q.protocolFee + q.creatorFee, label).toBe(spend);
      expect([e.feeBps, e.creatorFeeBps]).toEqual(['95', '30']);
    }
    expect(bytes(trade('3AUNQ8x89cfp').data).readBigUInt64LE(8)).toBe(99_000_000n);
    expect(bytes(trade('2UmCR7snPvqa').data).readBigUInt64LE(8)).toBe(29_700_000n);
    const sells: Array<[string, bigint, bigint]> = [['2jca9E3k9xbz', 3_529_047n, 3_484_933n], ['3vEJuMHF6xec', 41_683_523n, 41_162_478n], ['3cBPhfAEwv', 506_173_120n, 499_845_955n]];
    for (const [label, gross, net] of sells) {
      const e = trade(label).event;
      const tok = BigInt(e.tokenAmount);
      const q = pp.pumpSellQuote(BigInt(e.virtualSolReserves) + BigInt(e.solAmount), BigInt(e.virtualTokenReserves) - tok, tok)!;
      expect([q.gross, q.net, q.protocolFee, q.creatorFee], label).toEqual([gross, net, BigInt(e.fee), BigInt(e.creatorFee)]);
    }
  });

  it('PUMPCHAIN-T7 the pinned constants equal Global and FeeConfig, re-derive from their seeds, and the discriminators are the Anchor rule', () => {
    const g = bytes(ACCOUNTS.global.data);
    expect(g).toHaveLength(1088);
    const keyAt = (off: number): string => new PublicKey(g.subarray(off, off + 32)).toBase58();
    const list = (off: number, n: number): string[] => Array.from({ length: n }, (_v, i) => keyAt(off + 32 * i));
    expect([keyAt(41), ...list(162, 7)]).toEqual([...pp.PUMP_FEE_RECIPIENTS_NORMAL]);
    expect([keyAt(483), ...list(516, 7)]).toEqual([...pp.PUMP_FEE_RECIPIENTS_MAYHEM]);
    expect(list(741, 8)).toEqual([...pp.PUMP_BUYBACK_FEE_RECIPIENTS]);
    // FeeConfig flat fees lp / protocol / creator at 41 (after the discriminator, the bump and the admin)
    const fc = bytes(ACCOUNTS.feeConfig.data);
    expect([fc.readBigUInt64LE(41), fc.readBigUInt64LE(49), fc.readBigUInt64LE(57)]).toEqual([0n, pp.PUMP_PROTOCOL_FEE_BPS, pp.PUMP_CREATOR_FEE_BPS_DEFAULT]);
    const pda = (seeds: Array<string | Uint8Array>, program: string): [string, number] => {
      const [a, bump] = PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === 'string' ? Buffer.from(s) : Buffer.from(s))), pk(program));
      return [a.toBase58(), bump];
    };
    expect(pda(['global'], PROGRAMS['@pump'])).toEqual([pp.PUMP_GLOBAL, 255]);
    expect(pda(['__event_authority'], PROGRAMS['@pump'])[0]).toBe(pp.PUMP_EVENT_AUTHORITY);
    expect(pda(['global_volume_accumulator'], PROGRAMS['@pump'])).toEqual([pp.PUMP_GLOBAL_VOLUME_ACCUMULATOR, 255]);
    expect(pda(['fee_config', pk(PROGRAMS['@pump']).toBytes()], PROGRAMS['@pumpFees'])).toEqual([pp.PUMP_FEE_CONFIG, 253]);
    expect(dec(ACCOUNTS.global.key)).toBe(pp.PUMP_GLOBAL);
    expect(dec(ACCOUNTS.feeConfig.key)).toBe(pp.PUMP_FEE_CONFIG);
    // and the recorded instructions carry them at their positions
    const t = fixtureKeys(trade(BUYS[0]));
    expect([t[0], t[10], t[12], t[14], t[15]]).toEqual([pp.PUMP_GLOBAL, pp.PUMP_EVENT_AUTHORITY, pp.PUMP_GLOBAL_VOLUME_ACCUMULATOR, pp.PUMP_FEE_CONFIG, pp.PUMP_FEE_PROGRAM]);
    for (const [name, d] of [['buy_exact_sol_in', pp.PUMP_DISC_BUY_EXACT_SOL_IN], ['sell', pp.PUMP_DISC_SELL]] as const) {
      expect([...d]).toEqual([...createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)]);
    }
    // the canonical bonding_curve_v2 of fUoMp is the recorded DC8p8e2m...
    expect(deriveBondingCurveV2(pk(FUOMP)).toBase58()).toBe(t[16]);
    expect(t[16].startsWith('DC8p8e2m')).toBe(true);
  });

  it('PUMPCHAIN-T8 every recorded curve and mint classifies as the variant table says, and synthetic byte patterns cover the rest', () => {
    const cls = (l: string) => pp.classifyPumpCurve(raw(curveFx(l)));
    for (const l of ['8K9Y', 'AZi4', '5Ux9']) expect(cls(l)).toMatchObject({ ok: true, value: { mayhem: true, cashback: false, quoteMint: PROGRAMS['@system'], creatorFeeBps: 30n } });
    for (const l of ['BfMX', 'DbR7']) expect(cls(l)).toMatchObject({ ok: true, value: { mayhem: false, holderReward: true } });
    expect(cls('DGjCB3')).toMatchObject({ ok: false, code: 'non-sol-quote' });
    expect(cls('5S9aQZ')).toMatchObject({ ok: false, code: 'curve-layout' });
    for (const m of ACCOUNTS.mints) expect(pp.classifyPumpMint(raw(m)), m.label).toEqual({ ok: true, value: PROGRAMS['@token2022'] });
    // a mayhem coin pays the RESERVED list, a normal one the NORMAL list (account 1)
    expect(pumpDirectExpectedAccounts({ side: 'buy', owner: OWNER, mint: FUOMP, tokenProgram: PROGRAMS['@token2022'], creator: FUOMP_CREATOR, mayhem: true, cashback: false })[1].listName).toBe('RESERVED');
    expect(pumpDirectExpectedAccounts({ side: 'buy', owner: OWNER, mint: FUOMP, tokenProgram: PROGRAMS['@token2022'], creator: FUOMP_CREATOR, mayhem: false, cashback: false })[1].listName).toBe('NORMAL');

    // synthetic patterns on the BfMX curve (non-mayhem)
    const base = bytes(curveFx('BfMX').data);
    const patched = (f: (b: Buffer) => void): pp.RawAccount => { const b = Buffer.from(base); f(b); return { owner: PROGRAMS['@pump'], data: b }; };
    const cashback = pp.classifyPumpCurve(patched((b) => { b[82] = 1; }));
    expect(cashback).toMatchObject({ ok: true, value: { cashback: true } });
    const exp = pumpDirectExpectedAccounts({ side: 'sell', owner: OWNER, mint: FUOMP, tokenProgram: PROGRAMS['@token2022'], creator: FUOMP_CREATOR, mayhem: false, cashback: true });
    expect(exp).toHaveLength(17);
    expect(exp[14]).toMatchObject({ name: 'user_volume_accumulator', writable: true });
    const cashbackSell = buildSellInstruction(pk(OWNER), pk(FUOMP), pk(FUOMP_CREATOR), 1n, 1n, true, TOKEN_2022_PROGRAM_PK, pickPumpFeeAccounts(false, () => 0));
    expect(keysOf(cashbackSell)).toHaveLength(17);
    exp.forEach((e, i) => { if (e.key !== null) expect(keysOf(cashbackSell)[i], e.name).toBe(e.key); });
    // creator_fee_bps on a SOL curve is never the rate: 100 and 301 are both refused ('curve-fee')
    for (const bps of [100n, 301n]) expect(pp.classifyPumpCurve(patched((b) => b.writeBigUInt64LE(bps, 115)))).toMatchObject({ ok: false, code: 'curve-fee' });
    expect(pp.classifyPumpCurve(patched((b) => b.fill(0, 49, 81)))).toMatchObject({ ok: false, code: 'no-creator' });
    expect(pp.classifyPumpCurve(patched((b) => { b[81] = 2; }))).toMatchObject({ ok: false, code: 'curve-layout' });
    expect(pp.classifyPumpCurve(patched((b) => { b[48] = 1; }))).toMatchObject({ ok: false, code: 'curve-complete' });
    expect(pp.classifyPumpCurve(patched((b) => pk('So11111111111111111111111111111111111111112').toBuffer().copy(b, 83)))).toMatchObject({ ok: true });
    expect(pp.classifyPumpCurve({ owner: PROGRAMS['@token'], data: base })).toMatchObject({ ok: false, code: 'curve-owner' });
    expect(pp.classifyPumpCurve(null)).toMatchObject({ ok: false, code: 'no-curve' });
    expect(parseBondingCurve(base)!.isMayhemMode).toBe(false);

    // mints: extensions 14, 9, 6, 1 and 12 are refused, a freeze authority is refused, a classic Token mint gives Tokenkeg
    const m = bytes(mintFx('fUoMp').data);
    const withExt = (type: number): Buffer => {
      const b = Buffer.from(m);
      // replace the first TLV entry's type (MetadataPointer, right after the account-type byte at 165)
      b.writeUInt16LE(type, 166);
      return b;
    };
    expect(m.readUInt16LE(166)).toBe(18);
    for (const t of [14, 9, 6, 1, 12]) expect(pp.classifyPumpMint({ owner: PROGRAMS['@token2022'], data: withExt(t) }), String(t)).toMatchObject({ ok: false, code: 'mint-unsupported' });
    const frozen = Buffer.from(m); frozen.writeUInt32LE(1, 46); pk(OWNER).toBuffer().copy(frozen, 50);
    expect(pp.classifyPumpMint({ owner: PROGRAMS['@token2022'], data: frozen })).toMatchObject({ ok: false, code: 'mint-unsupported' });
    const classic = Buffer.from(m.subarray(0, 82));
    expect(pp.classifyPumpMint({ owner: PROGRAMS['@token'], data: classic })).toEqual({ ok: true, value: PROGRAMS['@token'] });
    expect(pp.classifyPumpMint({ owner: PROGRAMS['@system'], data: classic })).toMatchObject({ ok: false, code: 'mint-program' });
    // a classic Token mint puts Tokenkeg in buy[8], sell[9], both ATA seeds and CreateIdempotent
    const fees = pickPumpFeeAccounts(false, () => 0);
    const b = buildBuyInstruction(pk(OWNER), pk(FUOMP), pk(FUOMP_CREATOR), 1n, 1n, TOKEN_PROGRAM_PK, fees);
    const s = buildSellInstruction(pk(OWNER), pk(FUOMP), pk(FUOMP_CREATOR), 1n, 1n, false, TOKEN_PROGRAM_PK, fees);
    const expB = pumpDirectExpectedAccounts({ side: 'buy', owner: OWNER, mint: FUOMP, tokenProgram: PROGRAMS['@token'], creator: FUOMP_CREATOR, mayhem: false, cashback: false });
    expect(keysOf(b)[8]).toBe(PROGRAMS['@token']);
    expect(keysOf(s)[9]).toBe(PROGRAMS['@token']);
    expect(keysOf(b)[4]).toBe(expB[4].key);
    expect(keysOf(b)[5]).toBe(expB[5].key);
    expect(keysOf(buildCreateAtaIfNeededIx(pk(OWNER), pk(OWNER), pk(FUOMP), TOKEN_PROGRAM_PK))[5]).toBe(PROGRAMS['@token']);
  });
});
