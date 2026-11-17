/**
 * B40 on-chain quote: the quote computed from on-chain reserves equals the routers' own quote math on the same
 * fixture curve / pool. Fake RPC serving account bytes; no network.
 */
import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { createCurveReader, deriveBondingCurvePda, derivePumpSwapPool, type BondingCurveState } from './curve-state';
import { PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID, WSOL_MINT, type ExecClock, type ExecRpc } from './exec-common';
import { createOnchainQuoter, isSolQuoted, quoteSellFromCurve, quoteSellFromPool, SOL_QUOTE_MINTS } from './onchain-quote';
import { quoteSell as curveRouterQuoteSell } from './pumpfun-swap';
import { quoteSell as poolRouterQuoteSell } from './pumpswap-swap';

const key = (n: number): string => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const MINT = key(2);
const put = (b: Buffer, off: number, k: string): void => { Buffer.from(new PublicKey(k).toBytes()).copy(b, off); };

/** FIX-BUY2: a current BondingCurve account (166 bytes, pump IDL) quoted in WSOL unless `quoteMint` says otherwise (null: left all zeros);
 *  `len` below 115 gives an older account too short to carry quote_mint. */
function encodeCurve(o: { vToken: bigint; vSol: bigint; rToken: bigint; rSol: bigint; complete?: boolean; quoteMint?: string | null; len?: number }): Buffer {
  const b = Buffer.alloc(o.len ?? 166);
  createHash('sha256').update('account:BondingCurve').digest().subarray(0, 8).copy(b, 0);
  b.writeBigUInt64LE(o.vToken, 8);
  b.writeBigUInt64LE(o.vSol, 16);
  b.writeBigUInt64LE(o.rToken, 24);
  b.writeBigUInt64LE(o.rSol, 32);
  b.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  b[48] = o.complete ? 1 : 0;
  put(b, 49, key(3));
  if (b.length >= 115 && o.quoteMint !== null) put(b, 83, o.quoteMint ?? WSOL_MINT);   // quote_mint
  return b;
}
function encodePool(baseVault: string, quoteVault: string): Buffer {
  const b = Buffer.alloc(300);
  put(b, 76, MINT); put(b, 108, WSOL_MINT); put(b, 172, baseVault); put(b, 204, quoteVault);
  return b;
}
function tokenAccount(amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b;
}
const val = (data: Buffer, owner: string): any => ({ lamports: 1, owner, data: [data.toString('base64'), 'base64'], executable: false });

interface Chain { curve?: Buffer | null; pool?: Buffer | null; baseRes?: bigint; quoteRes?: bigint; calls?: string[] }
function chainRpc(c: Chain): ExecRpc {
  const baseVault = key(10);
  const quoteVault = key(11);
  return {
    async call(method, params) {
      c.calls?.push(method);
      if (method === 'getAccountInfo') {
        const a = (params as string[])[0];
        if (a === deriveBondingCurvePda(MINT)) return { value: c.curve ? val(c.curve, PUMP_PROGRAM_ID) : null };
        if (a === derivePumpSwapPool(MINT)) return { value: c.pool ? val(c.pool, PUMPSWAP_PROGRAM_ID) : null };
        return { value: null };
      }
      if (method === 'getMultipleAccounts') {
        const addrs = (params as [string[]])[0];
        expect(addrs).toEqual([baseVault, quoteVault]);
        return { value: [val(tokenAccount(c.baseRes ?? 0n), key(70)), val(tokenAccount(c.quoteRes ?? 0n), key(70))] };
      }
      throw new Error(`unexpected rpc ${method}`);
    },
  };
}
const clock: ExecClock = { now: () => 1_234_567, sleep: async () => undefined };

describe('onchain-quote', () => {
  it('B4-T07 the on-chain quote equals the router quote math on a fixture curve (and on a fixture pool)', async () => {
    // pump bonding curve: 30 SOL virtual / 1.073e15 virtual tokens, 12.5 SOL real
    const curve = { vToken: 1_073_000_000_000_000n, vSol: 30_000_000_000n, rToken: 793_100_000_000_000n, rSol: 12_500_000_000n };
    const calls: string[] = [];
    const quoter = createOnchainQuoter({ reader: createCurveReader({ rpc: chainRpc({ curve: encodeCurve(curve), calls }) }), clock });
    for (const tokensIn of [1_000_000n, 123_456_789_000n, 50_000_000_000_000n]) {
      const q = await quoter.quoteSell(MINT, tokensIn);
      const routerOut = curveRouterQuoteSell(Number(curve.vSol), Number(curve.vToken), tokensIn);   // pumpfun-swap.ts quoteSell
      expect(q).not.toBeNull();
      expect(q!.venue).toBe('pump-curve');
      expect(q!.solOutLamports).toBe(routerOut);
      expect(q!.sol).toBe(Number(routerOut) / 1e9);
      expect(q!.at).toBe(1_234_567);
      // the same number by hand (FIX-PUMP: pump's own rule): gross = A x vSol / (vTok + A), minus ceil(gross x 95 / 10000) and ceil(gross x 30 / 10000)
      const gross = (tokensIn * curve.vSol) / (curve.vToken + tokensIn);
      expect(q!.solOutLamports).toBe(gross - (gross * 95n + 9_999n) / 10_000n - (gross * 30n + 9_999n) / 10_000n);
    }
    expect(calls).toEqual(['getAccountInfo', 'getAccountInfo', 'getAccountInfo']);   // one read per quote

    // graduated token: the curve account says complete, so the PumpSwap pool reserves are used (0.95 % fee)
    const baseRes = 250_000_000_000_000n;
    const quoteRes = 91_000_000_000n;
    const poolChain: Chain = { curve: encodeCurve({ ...curve, complete: true }), pool: encodePool(key(10), key(11)), baseRes, quoteRes };
    const poolQuoter = createOnchainQuoter({ reader: createCurveReader({ rpc: chainRpc(poolChain) }), clock });
    const tokensIn = 7_777_000_000n;
    const pq = await poolQuoter.quoteSell(MINT, tokensIn);
    expect(pq).toMatchObject({ venue: 'pumpswap' });
    expect(pq!.solOutLamports).toBe(poolRouterQuoteSell(baseRes, quoteRes, tokensIn));   // pumpswap-swap.ts quoteSell
    const newBase = baseRes + tokensIn;
    const gross = quoteRes - (baseRes * quoteRes) / newBase;
    expect(pq!.solOutLamports).toBe((gross * 9905n) / 10_000n);

    // no curve account at all (a non-pump mint that has a pool) also falls to the pool
    const noCurve = createOnchainQuoter({ reader: createCurveReader({ rpc: chainRpc({ curve: null, pool: encodePool(key(10), key(11)), baseRes, quoteRes }) }), clock });
    expect((await noCurve.quoteSell(MINT, tokensIn))?.solOutLamports).toBe(pq!.solOutLamports);
  });

  it('returns null (never throws) when there is no on-chain price: nothing found, RPC error, empty pool side, zero tokens, oversized reserves', async () => {
    const none = createOnchainQuoter({ reader: createCurveReader({ rpc: chainRpc({ curve: null, pool: null }) }), clock });
    expect(await none.quoteSell(MINT, 1_000_000n)).toBeNull();
    const boom = createOnchainQuoter({ reader: createCurveReader({ rpc: { call: async () => { throw new Error('rpc down'); } } }), clock });
    expect(await boom.quoteSell(MINT, 1_000_000n)).toBeNull();
    const emptySide = createOnchainQuoter({ reader: createCurveReader({ rpc: chainRpc({ curve: null, pool: encodePool(key(10), key(11)), baseRes: 5n, quoteRes: 0n }) }), clock });
    expect(await emptySide.quoteSell(MINT, 1_000_000n)).toBeNull();

    const state = (o: Partial<BondingCurveState>): BondingCurveState => ({
      virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, realTokenReserves: 1n, realSolReserves: 1n,
      tokenTotalSupply: 1n, complete: false, creator: key(3), isMayhemMode: false, isCashbackCoin: false, quoteMint: WSOL_MINT, ...o,
    });
    expect(quoteSellFromCurve(state({}), 0n)).toBeNull();
    expect(quoteSellFromCurve(state({ complete: true }), 1_000_000n)).toBeNull();
    expect(quoteSellFromCurve(state({ virtualTokenReserves: 2n ** 60n }), 1_000_000n)).toBeNull();   // beyond the routers' exact number range
    expect(quoteSellFromPool(0n, 5n, 5n)).toBeNull();
    expect(quoteSellFromPool(10n, 10n, 0n)).toBeNull();
  });

  it('FIXBUY2-I6-T02 (amended by FIX-QUOTE) a live curve quoted in USDC or another coin has no on-chain price; an all-zero quote mint (what pump writes for SOL), WSOL and an account too short for the field are SOL', async () => {
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const curve = { vToken: 1_073_000_000_000_000n, vSol: 30_000_000_000n, rToken: 793_100_000_000_000n, rSol: 12_500_000_000n };
    const tokensIn = 123_456_789_000n;
    const asSol = curveRouterQuoteSell(Number(curve.vSol), Number(curve.vToken), tokensIn);
    // a pool exists too, so a fall-through to the pool would show up as extra reads
    const quote = (data: Buffer, calls?: string[]) => createOnchainQuoter({
      reader: createCurveReader({ rpc: chainRpc({ curve: data, pool: encodePool(key(10), key(11)), baseRes: 250_000_000_000_000n, quoteRes: 91_000_000_000n, calls }) }), clock,
    }).quoteSell(MINT, tokensIn);

    // quoted in USDC: its 30,000,000,000 reserve is 30,000 USDC, not 30 SOL. No on-chain price, after ONE read (the live curve is the venue)
    const calls: string[] = [];
    expect(await quote(encodeCurve({ ...curve, quoteMint: USDC }), calls)).toBeNull();
    expect(calls).toEqual(['getAccountInfo']);
    // another pump coin as the quote mint: no price either
    expect(await quote(encodeCurve({ ...curve, quoteMint: key(44) }))).toBeNull();
    // FIX-QUOTE: an all-zero quote mint (encodeCurve leaves the field zeroed for null) is pump's SOL marker: the router quote math, after ONE read
    const zeroCalls: string[] = [];
    expect(await quote(encodeCurve({ ...curve, quoteMint: null }), zeroCalls)).toMatchObject({ venue: 'pump-curve', solOutLamports: asSol });
    expect(zeroCalls).toEqual(['getAccountInfo']);
    // quoted in WSOL: exactly the router quote math, as before
    expect(await quote(encodeCurve({ ...curve, quoteMint: WSOL_MINT }))).toMatchObject({ venue: 'pump-curve', solOutLamports: asSol });
    // an older account too short to carry quote_mint is SOL-quoted, as before
    for (const len of [81, 83, 114]) expect((await quote(encodeCurve({ ...curve, len })))?.solOutLamports, `${len} bytes`).toBe(asSol);

    // the pure function, on decoded states
    const state = (quoteMint: string | null): BondingCurveState => ({
      virtualTokenReserves: curve.vToken, virtualSolReserves: curve.vSol, realTokenReserves: curve.rToken, realSolReserves: curve.rSol,
      tokenTotalSupply: 1n, complete: false, creator: key(3), isMayhemMode: false, isCashbackCoin: false, quoteMint,
    });
    expect(quoteSellFromCurve(state(USDC), tokensIn)).toBeNull();
    expect(quoteSellFromCurve(state(key(44)), tokensIn)).toBeNull();
    expect(quoteSellFromCurve(state(new PublicKey(new Uint8Array(32)).toBase58()), tokensIn)).toBe(asSol);
    expect(quoteSellFromCurve(state(WSOL_MINT), tokensIn)).toBe(asSol);
    expect(quoteSellFromCurve(state(null), tokensIn)).toBe(asSol);
  });

  it('FIXQ-T01 isSolQuoted: the zero key (pump\'s SOL marker), WSOL, the Token-2022 native mint and a missing field are SOL; USDC and any other mint are not', () => {
    const ZERO = new PublicKey(new Uint8Array(32)).toBase58();
    expect(ZERO).toBe('11111111111111111111111111111111');
    expect(isSolQuoted(ZERO)).toBe(true);
    expect(isSolQuoted(WSOL_MINT)).toBe(true);
    expect(isSolQuoted('9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP')).toBe(true);
    expect(isSolQuoted(null)).toBe(true);
    expect(isSolQuoted('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(false);
    expect(isSolQuoted(key(44))).toBe(false);
    expect([...SOL_QUOTE_MINTS].sort()).toEqual(['11111111111111111111111111111111', '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP', WSOL_MINT].sort());
  });
});
