/**
 * R7-W5 curve-parse.ts: the bonding-curve decoder moved unchanged out of curve-state.ts (re-exported there).
 * The extraction contract: every name the seven signing files exported before the extraction is still exported under the same name, the
 * moved ones are the SAME functions, and the suites that pin the server path keep their test ids (they are not edited by this package).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import * as closeAccount from './close-account';
import * as closeIx from './close-ix';
import * as computeBudget from './compute-budget';
import * as curveParse from './curve-parse';
import * as curveState from './curve-state';
import * as fills from './fills';
import * as jupiter from './jupiter';
import * as onchainQuote from './onchain-quote';
import { WSOL_MINT } from './exec-common';
import * as pumpfunIx from './pumpfun-ix';
import * as pumpfunSwap from './pumpfun-swap';
import * as pumpswapIx from './pumpswap-ix';
import * as pumpswapSwap from './pumpswap-swap';
import * as txDeltas from './tx-deltas';
import * as txVerify from './tx-verify';

const fixtureKey = (i: number): string => bs58.encode(createHash('sha256').update('ps-fixture-' + i).digest());
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

function curveBytes(over: { complete?: boolean; mayhem?: boolean | null; cashback?: boolean; len?: number; quote?: string | null } = {}): Buffer {
  const b = Buffer.alloc(over.len ?? 151);
  curveParse.anchorAccountDiscriminator('BondingCurve').copy(b, 0);
  b.writeBigUInt64LE(1_073_000_000_000_000n, 8);
  b.writeBigUInt64LE(30_000_000_000n, 16);
  b.writeBigUInt64LE(793_100_000_000_000n, 24);
  b.writeBigUInt64LE(5n, 32);
  b.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  b[48] = over.complete ? 1 : 0;
  Buffer.from(new PublicKey(fixtureKey(3)).toBytes()).copy(b, 49);
  if (b.length > 81 && over.mayhem !== null) b[81] = over.mayhem ? 1 : 0;
  if (b.length > 82) b[82] = over.cashback ? 1 : 0;
  if (over.quote !== undefined && over.quote !== null && b.length >= 115) Buffer.from(new PublicKey(over.quote).toBytes()).copy(b, 83);   // quote_mint
  return b;
}

describe('curve-parse', () => {
  it('decodes the bonding-curve account, refuses another discriminator or a short account, and is the function curve-state re-exports', () => {
    const c = curveParse.parseBondingCurve(curveBytes({ mayhem: true, cashback: true }))!;
    expect(c).toMatchObject({ virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n, realSolReserves: 5n, complete: false, creator: fixtureKey(3), isMayhemMode: true, isCashbackCoin: true });
    expect(curveParse.parseBondingCurve(curveBytes({ complete: true }))!.complete).toBe(true);
    expect(curveParse.parseBondingCurve(curveBytes({ len: 81 }))).toMatchObject({ isMayhemMode: null, isCashbackCoin: null });   // an older, shorter account carries no flag
    expect(curveParse.parseBondingCurve(curveBytes({ len: 80 }))).toBeNull();
    expect(curveParse.parseBondingCurve(null)).toBeNull();
    const wrong = curveBytes(); wrong[0] ^= 0xff;
    expect(curveParse.parseBondingCurve(wrong)).toBeNull();
    expect(curveState.parseBondingCurve).toBe(curveParse.parseBondingCurve);
    expect(curveState.deriveBondingCurvePda).toBe(curveParse.deriveBondingCurvePda);
    expect(curveState.anchorAccountDiscriminator).toBe(curveParse.anchorAccountDiscriminator);
    expect(curveState.GRADUATION_REAL_SOL_LAMPORTS).toBe(85_000_000_000);
    const mint = fixtureKey(31);
    expect(curveParse.deriveBondingCurvePda(mint)).toBe(PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], new PublicKey(PUMP))[0].toBase58());
  });

  it('FIXBUY2-I6-T01 reads quote_mint (bytes 83..115) of a 166-byte account, WSOL, USDC or all zeros; an account too short for the field has none (SOL-quoted)', () => {
    const WSOL = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const ZERO_KEY = new PublicKey(new Uint8Array(32)).toBase58();   // what all-zero bytes decode to: a key, and not WSOL
    const at = (quote: string | null, len = 166) => curveParse.parseBondingCurve(curveBytes({ len, quote, mayhem: false, cashback: true }))!;
    expect(at(WSOL).quoteMint).toBe(WSOL);
    expect(at(USDC).quoteMint).toBe(USDC);
    expect(at(null).quoteMint).toBe(ZERO_KEY);
    expect(ZERO_KEY).not.toBe(WSOL);
    // the rest of the account decodes exactly as before, whatever the quote mint
    for (const q of [WSOL, USDC, null]) {
      expect(at(q)).toMatchObject({
        virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n, realSolReserves: 5n,
        tokenTotalSupply: 1_000_000_000_000_000n, complete: false, creator: fixtureKey(3), isMayhemMode: false, isCashbackCoin: true,
      });
    }
    // an 83-byte account carries both flags and no quote mint; so does one a byte short of the field; the first one that fits has it
    expect(curveParse.parseBondingCurve(curveBytes({ len: 83, mayhem: true, cashback: true }))).toMatchObject({ isMayhemMode: true, isCashbackCoin: true, quoteMint: null });
    expect(at(USDC, 114).quoteMint).toBeNull();
    expect(at(USDC, 115).quoteMint).toBe(USDC);
    expect(curveParse.parseBondingCurve(curveBytes({ len: 81 }))!.quoteMint).toBeNull();
  });
});

// Every value export of the seven signing files at the base commit of this package, by name (types are erased and not listed).
const BEFORE: Record<string, { module: Record<string, unknown>; names: string[] }> = {
  'pumpfun-swap': { module: pumpfunSwap, names: ['PUMPFUN_PROGRAM_ID', 'getTokenProgramForMint', 'smartSlippageBps', 'quoteBuy', 'quoteSell', 'curveBuyImpactPct', 'curveSellImpactPct', 'PUMPPORTAL_PRIORITY_SOL_MIN', 'PUMPPORTAL_PRIORITY_SOL_MAX', 'pumpPortalPrioritySol', 'pumpfunBuy', 'pumpfunSell', 'isPumpFunPreGrad'] },
  'pumpswap-swap': { module: pumpswapSwap, names: ['PUMPSWAP_PROGRAM_ID', 'PUMPSWAP_FEE_RECIPIENT', 'PUMPSWAP_DIRECT_ENABLED', 'PumpSwapDirectDisabledError', 'PUMPSWAP_FEE_RECIPIENT_ATA', 'PUMPSWAP_GLOBAL_VOLUME_ACCUMULATOR', 'PUMPSWAP_FEE_CONFIG', 'derivePumpSwapPoolAuthority', 'derivePumpSwapCanonicalPool', 'deriveCoinCreatorVaultAuthority', 'derivePumpSwapUserVolumeAccumulator', 'parsePumpSwapPoolAccount', 'quoteBuy', 'quoteSell', 'poolBuyImpactPct', 'poolSellImpactPct', 'buildPumpSwapBuyInstruction', 'buildPumpSwapSellInstruction', 'pumpswapBuy', 'pumpswapSell', 'hasPumpSwapPool'] },
  jupiter: { module: jupiter, names: ['HELIUS_TIP_LAMPORTS', 'rpcUrlWithRebate', 'getPriorityFeeEstimate', 'getPriorityFeeForSwap', 'startSenderKeepalive', 'stopSenderKeepalive', 'resilientRpcCall', 'getResilientBlockhash', 'jupQuote', 'jupSwap', 'heliusSmartSend', 'confirmTx', 'confirmTxBackground', 'multiRpcSend', 'jupiterImpactPct', 'jupiterOrderAndExecute', 'executeWithRetry', 'lamports', 'getSolBalance', 'getWsolBalance', 'getSplTokenBalance', 'getAllSplBalances', 'wrapSol', 'unwrapAllWsol'] },
  'close-account': { module: closeAccount, names: ['CLOSE_ACCOUNT_IX_DATA', 'CLOSE_ACCOUNT_RETRIES', 'CLOSE_CU_LIMIT', 'CLOSE_CU_PRICE_MICROLAMPORTS', 'buildCloseAccountTx', 'createCloseAccountApi'] },
  'tx-verify': { module: txVerify, names: ['PUMPPORTAL_FEE_ACCOUNTS', 'TIP_ACCOUNTS', 'PUMPPORTAL_FEE_BPS', 'pumpPortalMaxFeeLamports', 'PUMPPORTAL_PRIORITY_FEE_MAX_FACTOR', 'computeBudgetFeeLamports', 'checkPumpPortalPriorityFee', 'PUMP_IX_NAMES', 'anchorInstructionDiscriminator', 'PUMP_BUY_DISCRIMINATORS', 'PUMP_SELL_DISCRIMINATORS', 'createTxVerifier'] },
  fills: { module: fills, names: ['FILL_META_TIMEOUT_MS', 'FILL_POLL_MS', 'accountKeysOf', 'computeTxDeltas', 'buyFillFromTx', 'sellFillFromTx', 'waitForTransaction', 'createFillReader'] },
  'curve-state': { module: curveState, names: ['anchorAccountDiscriminator', 'GRADUATION_REAL_SOL_LAMPORTS', 'deriveBondingCurvePda', 'derivePumpSwapPool', 'parseBondingCurve', 'parsePumpSwapPool', 'createCurveReader', 'curveStateToView', 'CURVE_READ_BUDGET_MS', 'readCurveView'] },
};

describe('the extraction keeps the server path', () => {
  it('WTX-T15 every name the signing files exported is still exported, the moved ones are the pure files own, and the pinned suites keep their ids', () => {
    for (const [file, { module, names }] of Object.entries(BEFORE)) {
      for (const n of names) expect(Object.keys(module), `${file} still exports ${n}`).toContain(n);
    }
    // moved names are the same objects (not copies)
    expect(pumpfunSwap.quoteBuy).toBe(pumpfunIx.quoteBuy);
    expect(pumpfunSwap.quoteSell).toBe(pumpfunIx.quoteSell);
    expect(pumpfunSwap.curveBuyImpactPct).toBe(pumpfunIx.curveBuyImpactPct);
    expect(pumpfunSwap.PUMPFUN_PROGRAM_ID).toBe(pumpfunIx.PUMPFUN_PROGRAM_ID);
    for (const n of ['PUMPSWAP_PROGRAM_ID', 'PUMPSWAP_FEE_RECIPIENT', 'PUMPSWAP_DIRECT_ENABLED', 'PumpSwapDirectDisabledError', 'PUMPSWAP_FEE_RECIPIENT_ATA', 'derivePumpSwapCanonicalPool', 'parsePumpSwapPoolAccount', 'buildPumpSwapBuyInstruction', 'buildPumpSwapSellInstruction', 'quoteBuy', 'quoteSell']) {
      expect((pumpswapSwap as Record<string, unknown>)[n], n).toBe((pumpswapIx as Record<string, unknown>)[n]);
    }
    expect(closeAccount.CLOSE_ACCOUNT_IX_DATA).toBe(closeIx.CLOSE_ACCOUNT_IX_DATA);
    expect(txVerify.computeBudgetFeeLamports).toBe(computeBudget.computeBudgetFeeLamports);
    expect(fills.computeTxDeltas).toBe(txDeltas.computeTxDeltas);
    expect(fills.accountKeysOf).toBe(txDeltas.accountKeysOf);
    expect(curveState.parseBondingCurve).toBe(curveParse.parseBondingCurve);
    // FIX-PUMP: the one SOL-quote rule moved into the pure curve-parse.ts; onchain-quote.ts re-exports the same objects
    expect(onchainQuote.isSolQuoted).toBe(curveParse.isSolQuoted);
    expect(onchainQuote.SOL_QUOTE_MINTS).toBe(curveParse.SOL_QUOTE_MINTS);
    expect(curveParse.SOL_QUOTE_MINTS.has(WSOL_MINT)).toBe(true);
    // FIX-PUMP: the bonding-curve-v2 seed is proven on mainnet (pump-chain-layout.test.ts), so the pure builder file holds it and exports
    // deriveBondingCurveV2; the signing file no longer has a private copy
    expect(Object.keys(pumpfunIx)).toContain('deriveBondingCurveV2');
    expect(Object.keys(pumpfunSwap)).not.toContain('deriveBondingCurveV2');
    expect(fs.readFileSync(path.join(__dirname, 'pumpfun-ix.ts'), 'utf8')).toMatch(/bonding-curve-v2/);
    expect(fs.readFileSync(path.join(__dirname, 'pumpfun-swap.ts'), 'utf8')).not.toMatch(/bonding-curve-v2/);
    // the suites that pin the server path still carry their ids (this package edits none of their assertions)
    const text = (f: string): string => fs.readFileSync(path.join(__dirname, f), 'utf8');
    const all = ['fills.test.ts', 'close-account.test.ts', 'tx-verify.test.ts', 'router.test.ts', 'onchain-quote.test.ts', 'pumpfun-swap.test.ts', 'pumpswap-swap.test.ts', 'jupiter.test.ts', 'fixbot-balance.test.ts', 'fixbot-curve.test.ts', 'send-context.test.ts'].map(text).join('\n');
    for (const id of ['B4-T01', 'B4-T02', 'B4-T03', 'B4-T04', 'B4-T05', 'B4-T07', 'B4-T08', 'B4-T09', 'B4-T10', 'B4-T11', 'B4-T12', 'B4-T13',
      'FIXAB-T01', 'FIXAB-T02', 'FIXAB-T03', 'FIXAB-T04', 'FIXAB-T05', 'FIXAB-T06', 'FIXAB-T07', 'FIXBOT-T14', 'FIXBOT-T15']) {
      expect(all, id).toContain(`'${id} `);
    }
    expect(all).toMatch(/it\('A26 /);
    expect(all).toMatch(/it\('A27 /);
  });
});
