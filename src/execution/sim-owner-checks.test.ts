/**
 * FIX-BUY2 item 7(e): the simulated-balance rules shared by tx-verify.ts (step d), ext-verify.ts (owner accounts) and the Jupiter
 * /swap/v2/order fallback. The verifiers' own suites pin their behaviour; this file pins the helper itself and that the three use it.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { ownerHoldings, ownerTokenAccount, ownerTokenAccountsRefusal, swapFlowRefusal } from './sim-owner-checks';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, WSOL_MINT, type ChainAccount } from './wallet-reads';

const key = (i: number): string => bs58.encode(createHash('sha256').update('ps-fixture-' + i).digest());
const OWNER = key(1);
const MINT = key(2);
const OTHER_MINT = key(3);
const SYSTEM = '11111111111111111111111111111111';

function tokenAcc(mint: string, owner: string, amount: bigint, o: { delegate?: string; program?: string } = {}): ChainAccount {
  const d = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(d, 0);
  new PublicKey(owner).toBuffer().copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  if (o.delegate !== undefined) { d.writeUInt32LE(1, 72); new PublicKey(o.delegate).toBuffer().copy(d, 76); }
  d[108] = 1;
  return { lamports: 1_488_440n, owner: o.program ?? TOKEN_PROGRAM_ID, data: d };
}
const sys = (lamports: bigint): ChainAccount => ({ lamports, owner: SYSTEM, data: Buffer.alloc(0) });

describe('FIX-BUY2 item 7(e): sim-owner-checks', () => {
  it('FIXBUY2-T30 swapFlowRefusal keeps tx-verify\'s rules and texts: a buy must deliver tokens within the SOL bound, a sell must pay SOL for at most tokensIn', () => {
    const buy = { lamportsBefore: 1_000n, lamportsAfter: 400n, tokensBefore: 0n, tokensAfter: 5n };
    expect(swapFlowRefusal(buy, { side: 'buy', maxLamportsOut: 600n })).toBeNull();
    expect(swapFlowRefusal(buy, { side: 'buy', maxLamportsOut: 599n })).toBe('simulation: owner lamport outflow above bound (600 > 599)');
    expect(swapFlowRefusal({ ...buy, tokensAfter: 0n }, { side: 'buy', maxLamportsOut: 600n })).toBe('simulation: no token delta on the owner ATA');
    const sell = { lamportsBefore: 400n, lamportsAfter: 1_000n, tokensBefore: 5n, tokensAfter: 0n };
    expect(swapFlowRefusal(sell, { side: 'sell', tokensIn: 5n })).toBeNull();
    expect(swapFlowRefusal(sell, { side: 'sell', tokensIn: 4n })).toBe('simulation: owner ATA decrease above tokensIn (5 > 4)');
    expect(swapFlowRefusal({ ...sell, lamportsAfter: 400n }, { side: 'sell', tokensIn: 5n })).toBe('simulation: no lamport inflow to the owner');
    expect(swapFlowRefusal({ ...sell, tokensAfter: 6n }, { side: 'sell', tokensIn: 5n })).toBe('simulation: owner ATA balance increased on a sell');
  });

  it('FIXBUY2-T30 ownerTokenAccountsRefusal keeps ext-verify\'s rule: authorities never change, only allowed accounts change amount, are created or closed', () => {
    const A = key(10);
    const B = key(11);
    const addrs = [A, B];
    const pre = [tokenAcc(MINT, OWNER, 10n), tokenAcc(OTHER_MINT, OWNER, 7n)];
    expect(ownerTokenAccountsRefusal(OWNER, addrs, pre, [tokenAcc(MINT, OWNER, 0n), tokenAcc(OTHER_MINT, OWNER, 7n)], new Set([A]))).toBeNull();
    expect(ownerTokenAccountsRefusal(OWNER, addrs, pre, [tokenAcc(MINT, OWNER, 10n), tokenAcc(OTHER_MINT, OWNER, 6n)], new Set([A]))).toBe('a token account of the owner changed its amount');
    expect(ownerTokenAccountsRefusal(OWNER, addrs, pre, [tokenAcc(MINT, OWNER, 10n, { delegate: key(12) }), pre[1]], new Set([A]))).toBe('a token account of the owner changed its delegate, close authority or state');
    expect(ownerTokenAccountsRefusal(OWNER, addrs, pre, [tokenAcc(MINT, key(13), 10n), pre[1]], new Set([A]))).toBe('a token account of the owner changed owner or was removed');
    expect(ownerTokenAccountsRefusal(OWNER, addrs, pre, [null, pre[1]], new Set([A]))).toBeNull();                       // an allowed close
    expect(ownerTokenAccountsRefusal(OWNER, addrs, pre, [pre[0], null], new Set([A]))).toBe('a token account of the owner changed owner or was removed');
    expect(ownerTokenAccountsRefusal(OWNER, [A], [null], [tokenAcc(MINT, OWNER, 1n)], new Set())).toBe('the transaction creates a token account for the owner that it does not disclose');
    expect(ownerTokenAccountsRefusal(OWNER, [A], [null], [tokenAcc(MINT, OWNER, 1n, { delegate: key(12) })], new Set([A]))).toBe('a created token account carries a delegate or a close authority');
  });

  it('FIXBUY2-T30 ownerHoldings sums the owner\'s lamports, wSOL and traded tokens (Token and Token-2022), ignoring everyone else\'s accounts', () => {
    const addrs = [OWNER, key(20), key(21), key(22), key(23), key(24)];
    const accounts: Array<ChainAccount | null> = [
      sys(5_000n),
      tokenAcc(WSOL_MINT, OWNER, 300n),
      tokenAcc(MINT, OWNER, 40n),
      tokenAcc(MINT, OWNER, 2n, { program: TOKEN_2022_PROGRAM_ID }),
      tokenAcc(MINT, key(30), 1_000n),                                  // someone else's
      null,
    ];
    expect(ownerHoldings(OWNER, MINT, addrs, accounts)).toEqual({ lamports: 5_000n, wsol: 300n, tokens: 42n });
    expect(ownerTokenAccount(OWNER, accounts[4])).toBeNull();
    expect(ownerTokenAccount(OWNER, sys(1n))).toBeNull();
    expect(ownerTokenAccount(OWNER, accounts[3])?.amount).toBe(2n);
  });

  it('FIXBUY2-T30 one helper: tx-verify step (d), ext-verify\'s owner accounts and the Jupiter /swap/v2/order fallback all import it, and the old copies are gone', () => {
    const src = (f: string): string => fs.readFileSync(path.join(__dirname, f), 'utf8');
    expect(src('tx-verify.ts')).toMatch(/import \{ swapFlowRefusal \} from '\.\/sim-owner-checks'/);
    expect(src('ext-verify.ts')).toMatch(/import \{ ownerTokenAccountsRefusal \} from '\.\/sim-owner-checks'/);
    expect(src('jupiter.ts')).toMatch(/ownerTokenAccountsRefusal, swapFlowRefusal \} from '\.\/sim-owner-checks'/);
    expect(src('tx-verify.ts')).not.toMatch(/owner lamport outflow above bound/);
    expect(src('ext-verify.ts')).not.toMatch(/changed its delegate, close authority or state/);
  });
});
