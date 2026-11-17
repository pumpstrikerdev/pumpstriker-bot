/**
 * B40 curve-state: bonding-curve and PumpSwap pool decoding, PDA derivation and the router-facing view. Fake RPC only.
 */
import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  anchorAccountDiscriminator, createCurveReader, curveStateToView, deriveBondingCurvePda, derivePumpSwapPool, GRADUATION_REAL_SOL_LAMPORTS,
  parseBondingCurve, parsePumpSwapPool, readCurveView,
} from './curve-state';
import { PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, type ExecRpc } from './exec-common';
import { PUMPFUN_PROGRAM_ID } from './pumpfun-swap';
import { PUMPSWAP_PROGRAM_ID as PUMPSWAP_PROGRAM_PK } from './pumpswap-swap';

const key = (n: number): string => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const MINT = key(2);
const CREATOR = key(3);

function encodeCurve(o: { vToken: bigint; vSol: bigint; rToken: bigint; rSol: bigint; supply?: bigint; complete?: boolean; creator?: string; cashback?: boolean; len?: number }): Buffer {
  const b = Buffer.alloc(o.len ?? 151);
  createHash('sha256').update('account:BondingCurve').digest().subarray(0, 8).copy(b, 0);
  b.writeBigUInt64LE(o.vToken, 8);
  b.writeBigUInt64LE(o.vSol, 16);
  b.writeBigUInt64LE(o.rToken, 24);
  b.writeBigUInt64LE(o.rSol, 32);
  b.writeBigUInt64LE(o.supply ?? 1_000_000_000_000_000n, 40);
  b[48] = o.complete ? 1 : 0;
  Buffer.from(new PublicKey(o.creator ?? CREATOR).toBytes()).copy(b, 49);
  b[82] = o.cashback ? 1 : 0;
  return b;
}
const value = (data: Buffer, owner: string): any => ({ lamports: 1_461_600, owner, data: [data.toString('base64'), 'base64'], executable: false });

const FRESH = { vToken: 1_073_000_000_000_000n, vSol: 30_000_000_000n, rToken: 793_100_000_000_000n, rSol: 0n };

describe('curve-state', () => {
  it('derives the same PDAs as the swap modules and uses the Anchor discriminator rule', () => {
    expect(PUMP_PROGRAM_ID).toBe(PUMPFUN_PROGRAM_ID.toBase58());
    expect(PUMPSWAP_PROGRAM_ID).toBe(PUMPSWAP_PROGRAM_PK.toBase58());
    const expectedCurve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(MINT).toBuffer()], new PublicKey(PUMP_PROGRAM_ID))[0];
    expect(deriveBondingCurvePda(MINT)).toBe(expectedCurve.toBase58());
    const idx = Buffer.alloc(2);
    const expectedPool = PublicKey.findProgramAddressSync(
      [Buffer.from('pool'), idx, new PublicKey(MINT).toBuffer(), new PublicKey(WSOL_MINT).toBuffer()], new PublicKey(PUMPSWAP_PROGRAM_ID),
    )[0];
    expect(derivePumpSwapPool(MINT)).toBe(expectedPool.toBase58());
    expect([...anchorAccountDiscriminator('BondingCurve')]).toEqual([23, 183, 248, 55, 96, 216, 172, 96]);
  });

  it('decodes a bonding-curve account and rejects other data', () => {
    const s = parseBondingCurve(encodeCurve({ ...FRESH, rSol: 12_345_678_901n, complete: false, cashback: true }));
    expect(s).toMatchObject({
      virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n,
      realSolReserves: 12_345_678_901n, tokenTotalSupply: 1_000_000_000_000_000n, complete: false, creator: CREATOR, isCashbackCoin: true, isMayhemMode: false,
    });
    expect(parseBondingCurve(encodeCurve({ ...FRESH, complete: true }))?.complete).toBe(true);
    // minimal-length (81 bytes) account: the optional flags are unknown
    expect(parseBondingCurve(encodeCurve({ ...FRESH, len: 81 }))).toMatchObject({ isMayhemMode: null, isCashbackCoin: null });
    expect(parseBondingCurve(encodeCurve({ ...FRESH, len: 60 }))).toBeNull();
    const wrong = encodeCurve(FRESH);
    wrong[0] ^= 0xff;
    expect(parseBondingCurve(wrong)).toBeNull();
    expect(parseBondingCurve(null)).toBeNull();
  });

  it('reads the curve with ONE getAccountInfo, refuses a foreign owner and maps it to the router view', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const data = encodeCurve({ ...FRESH, rSol: 42_500_000_000n });
    const rpc: ExecRpc = {
      async call(method, params) {
        calls.push([method, params]);
        return { value: value(data, PUMP_PROGRAM_ID) };
      },
    };
    const state = await createCurveReader({ rpc }).readBondingCurve(MINT);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('getAccountInfo');
    expect(calls[0][1][0]).toBe(deriveBondingCurvePda(MINT));
    expect(state).not.toBeNull();
    const view = curveStateToView(state!);
    expect(view).toMatchObject({ hasData: true, complete: false, isOnBondingCurve: true, creator: CREATOR, virtualSolReserves: 30_000_000_000, virtualTokenReserves: 1.073e15 });
    expect(view.bondingCurveProgress).toBeCloseTo(42_500_000_000 / GRADUATION_REAL_SOL_LAMPORTS, 10);
    expect(curveStateToView({ ...state!, complete: true }).bondingCurveProgress).toBe(1);

    const foreign: ExecRpc = { call: async () => ({ value: value(data, TOKEN_PROGRAM_ID) }) };
    expect(await createCurveReader({ rpc: foreign }).readBondingCurve(MINT)).toBeNull();
    const none: ExecRpc = { call: async () => ({ value: null }) };
    expect(await createCurveReader({ rpc: none }).readBondingCurve(MINT)).toBeNull();
  });

  it('readCurveView never throws: an RPC error or a slow lane gives null so the router can fall back to the API', async () => {
    const failing = createCurveReader({ rpc: { call: async () => { throw new Error('429'); } } });
    expect(await readCurveView(MINT, failing)).toBeNull();
    const slow = createCurveReader({ rpc: { call: () => new Promise(() => { /* never answers */ }) } });
    expect(await readCurveView(MINT, slow, 20)).toBeNull();
    const ok = createCurveReader({ rpc: { call: async () => ({ value: value(encodeCurve(FRESH), PUMP_PROGRAM_ID) }) } });
    expect(await readCurveView(MINT, ok)).toMatchObject({ hasData: true, complete: false });
  });

  it('decodes a PumpSwap pool in either known layout and accepts a layout only when the mints match', () => {
    const baseVault = key(10);
    const quoteVault = key(11);
    const put = (b: Buffer, off: number, k: string): void => { Buffer.from(new PublicKey(k).toBytes()).copy(b, off); };
    const layoutA = Buffer.alloc(300);   // the offsets pumpswap-swap.ts fetchPoolState reads
    put(layoutA, 76, MINT); put(layoutA, 108, WSOL_MINT); put(layoutA, 172, baseVault); put(layoutA, 204, quoteVault);
    expect(parsePumpSwapPool(layoutA, MINT)).toEqual({ baseMint: MINT, quoteMint: WSOL_MINT, poolBaseAccount: baseVault, poolQuoteAccount: quoteVault });
    const layoutB = Buffer.alloc(300);   // plain Anchor layout
    put(layoutB, 43, MINT); put(layoutB, 75, WSOL_MINT); put(layoutB, 139, baseVault); put(layoutB, 171, quoteVault);
    expect(parsePumpSwapPool(layoutB, MINT)).toEqual({ baseMint: MINT, quoteMint: WSOL_MINT, poolBaseAccount: baseVault, poolQuoteAccount: quoteVault });
    expect(parsePumpSwapPool(layoutA, key(99))).toBeNull();       // another mint
    expect(parsePumpSwapPool(Buffer.alloc(300), MINT)).toBeNull(); // garbage
    expect(parsePumpSwapPool(Buffer.alloc(100), MINT)).toBeNull(); // too short
  });
});
