/**
 * R7-W5 (A-104) pump-curve pure builders and the server-path byte-identity goldens.
 *
 * Byte identity: the transactions the SERVER path signs (the pump route, the PumpSwap route through its test-only opt-in since A-93g turned
 * it off, buildCloseAccountTx) serialize to exactly the recorded bytes. The PumpSwap and close goldens were recorded BEFORE the extraction
 * into the *-ix.ts files; the pump goldens were re-recorded by FIX-PUMP (2026-11-06) for pump's 2026-04-28 layout (18 / 16 / 17 accounts,
 * a 25-byte buy_exact_sol_in), with Math.random pinned to 0 (NORMAL[0] or RESERVED[0], BUYBACK[0], tip account 1), a scripted 'processed'
 * read of a 166-byte SOL curve with creator fixtureKey(3) and a scripted successful simulation (pump-direct-testkit.ts).
 * The goldens live in test-fixtures/execution/wallet/goldens/*.json: the message as base64 chunks of at most 60 characters plus its
 * sha256 (A-20, G-S18). Keys appear only as fixtureKey(i) indices. Recorded with VITEST_WTX_WRITE_GOLDENS=1 (never in a gate).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  send: vi.fn(),
  blockhash: vi.fn(),
  prio: vi.fn(),
  rpc: vi.fn(),
  fetch: vi.fn(),
  cached: vi.fn(),
  fetchInfo: vi.fn(),
}));
vi.mock('./jupiter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jupiter')>();
  return {
    ...actual,
    heliusSmartSend: h.send,
    multiRpcSend: h.send,
    getResilientBlockhash: h.blockhash,
    getPriorityFeeForSwap: h.prio,
    resilientRpcCall: h.rpc,
  };
});
vi.mock('node-fetch', () => ({ default: h.fetch }));
vi.mock('./pumpfun-info', () => ({ getCachedPumpFunInfo: h.cached, fetchPumpFunInfo: h.fetchInfo }));
vi.mock('../logger', () => ({ log: vi.fn(), logOk: vi.fn(), logWarn: vi.fn(), logErr: vi.fn(), logDbg: vi.fn(), setBroadcast: vi.fn(), emitEvent: vi.fn() }));

import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, deriveAta } from './exec-common';
import { buildCloseAccountTx } from './close-account';
import { derivePumpSwapCanonicalPool, pumpswapBuy, pumpswapSell } from './pumpswap-swap';
import * as pumpfunIx from './pumpfun-ix';
import * as pumpfunSwap from './pumpfun-swap';
import { constantProductImpactPct as serverImpactPct } from './send-context';
import { addPumpWorld, createPumpDirectChain } from './pump-direct-testkit';
import { PUMP_BUYBACK_FEE_RECIPIENTS, PUMP_FEE_RECIPIENTS_MAYHEM, PUMP_FEE_RECIPIENTS_NORMAL, pumpBuyQuote } from './pump-program';

// ── fixtures: every key is derived at test time (A-20); nothing below is a committed address or secret ──────────────────
const b58 = (bytes: Uint8Array): string => bs58.encode(bytes);
const fixtureKey = (i: number): string => b58(createHash('sha256').update('ps-fixture-' + i).digest());
const signer = Keypair.fromSeed(createHash('sha256').update('ps-fixture-w5-signer').digest());
const OWNER = signer.publicKey.toBase58();
const BLOCKHASH = b58(createHash('sha256').update('ps-fixture-w5-blockhash').digest());
const pk = (s: string): PublicKey => new PublicKey(s);

const CLASSIC_MINT = fixtureKey(31);   // classic Token program, pump curve open
const T22_MINT = fixtureKey(33);       // FIX-PUMP: Token-2022 coin
const MAYHEM_MINT = fixtureKey(34);    // FIX-PUMP: mayhem coin (Token-2022)
const CASHBACK_MINT = fixtureKey(35);  // FIX-PUMP: cashback coin (Token-2022)
const SWAP_MINT = fixtureKey(32);      // graduated: PumpSwap pool
const CREATOR = fixtureKey(3);
const POOL_BASE_VAULT = fixtureKey(10);
const POOL_QUOTE_VAULT = fixtureKey(11);
const POOL_COIN_CREATOR = fixtureKey(12);

const info = {
  hasData: true, complete: false, virtualSolReserves: 30_000_000_000, virtualTokenReserves: 1_073_000_000_000_000,
  realSolReserves: 0, realTokenReserves: 0, bondingCurveProgress: 0.1, creator: CREATOR,
};
/** A PumpSwap Pool account at the IDL offsets (the same layout pumpswap-swap.test.ts pins against the IDL fixture). */
function poolBytes(): Buffer {
  const b = Buffer.alloc(300);
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(b, 0);
  Buffer.from(pk(SWAP_MINT).toBytes()).copy(b, 43);
  Buffer.from(pk(WSOL_MINT).toBytes()).copy(b, 75);
  Buffer.from(pk(POOL_BASE_VAULT).toBytes()).copy(b, 139);
  Buffer.from(pk(POOL_QUOTE_VAULT).toBytes()).copy(b, 171);
  Buffer.from(pk(POOL_COIN_CREATOR).toBytes()).copy(b, 211);
  return b;
}

// ── goldens ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const GOLDEN_DIR = path.resolve(__dirname, '..', '..', 'test-fixtures', 'execution', 'wallet', 'goldens');
const WRITE = process.env.VITEST_WTX_WRITE_GOLDENS === '1';
const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const chunks = (b64: string, n = 60): string[] => { const out: string[] = []; for (let i = 0; i < b64.length; i += n) out.push(b64.slice(i, i + n)); return out; };

interface Golden { _about: string; case: string; inputs: Record<string, unknown>; messageB64: string[]; sha256: string }
const ABOUT_PRE_EXTRACTION = 'Server-path golden: the serialized message the SERVER path signs, recorded before the extraction into the *-ix.ts files. Keys are fixtureKey(i) indices (base58 of sha256 of "ps-fixture-" + i, computed at test time).';
const ABOUT_FIX_PUMP = "Server-path golden (FIX-PUMP, 2026-11-06): the serialized message the PF-direct route signs for pump's 2026-04-28 layout (buy_exact_sol_in 18 accounts and 25 bytes, sell 16 accounts), Math.random pinned to 0 (fee recipient [0] of its list, buyback recipient [0], Sender tip account 1). Keys are fixtureKey(i) indices (base58 of sha256 of \"ps-fixture-\" + i, computed at test time); pump's fixed accounts are pinned against mainnet by pump-chain-layout.test.ts.";
const ABOUT_FIX_PUMP_CASHBACK = "Server-path golden (FIX-PUMP, 2026-11-06): a cashback-coin sell, 17 accounts (user_volume_accumulator at 14, then bonding_curve_v2 and the buyback recipient). DERIVED FROM pump's docs and SDK 4.1.0 only: no mainnet fixture shows this shape, and the pre-sign simulation gates it. Math.random pinned to 0; keys are fixtureKey(i) indices.";
function checkGolden(name: string, inputs: Record<string, unknown>, message: Uint8Array, about: string = ABOUT_PRE_EXTRACTION): void {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  const b64 = Buffer.from(message).toString('base64');
  if (WRITE) {
    const g: Golden = {
      _about: about,
      case: name, inputs, messageB64: chunks(b64), sha256: sha256Hex(message),
    };
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(g, null, 2) + '\n');
    return;
  }
  const g = JSON.parse(fs.readFileSync(file, 'utf8')) as Golden;
  expect(g.messageB64.every((c) => c.length <= 60), `${name}: chunks are at most 60 characters`).toBe(true);
  expect(g.messageB64.join(''), `${name}: message bytes`).toBe(b64);
  expect(g.sha256, `${name}: sha256`).toBe(sha256Hex(message));
}
const sentMessage = (n = 0): Uint8Array => (h.send.mock.calls[n][0] as VersionedTransaction).message.serialize();

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  vi.spyOn(Math, 'random').mockReturnValue(0);     // the Helius tip account is picked with Math.random: pin the first one
  h.send.mockImplementation(async (tx: VersionedTransaction) => bs58.encode(tx.signatures[0]));
  h.blockhash.mockResolvedValue({ blockhash: BLOCKHASH, lastValidBlockHeight: 4_242 });
  h.prio.mockResolvedValue(100_000);
  h.cached.mockImplementation((mint: string) => (mint === SWAP_MINT ? { ...info, complete: true } : { ...info }));
  h.fetchInfo.mockResolvedValue({ hasData: false });
  h.fetch.mockImplementation(async (_url: string, init?: { body?: string }) => {
    const req = JSON.parse(String(init?.body));
    return { ok: true, status: 200, json: async () => ({ result: { value: { owner: TOKEN_PROGRAM_ID } } }), text: async () => '', req };
  });
  h.rpc.mockImplementation(async (method: string, params: any[]) => {
    if (method === 'getAccountInfo') {
      if (params[0] === derivePumpSwapCanonicalPool(pk(SWAP_MINT)).toBase58()) return { value: { data: [poolBytes().toString('base64'), 'base64'] } };
      return { value: null };
    }
    if (method === 'getTokenAccountBalance') return { value: { amount: params[0] === POOL_BASE_VAULT ? '250000000000000' : '91000000000' } };
    if (method === 'getBlockHeight') return 9_000;
    throw new Error(`unexpected rpc ${method}`);
  });
});

describe('server path byte identity', () => {
  it('WTX-T08 the pump route and PumpSwap through the test-only opt-in, and buildCloseAccountTx, serialize to the recorded goldens', async () => {
    const base = { signerSeed: 'sha256("ps-fixture-w5-signer")', blockhash: 'base58(sha256("ps-fixture-w5-blockhash"))', mintKey: 31, creatorKey: 3 };

    // pump route (classic Token mint), with the Sender tip (tip account = the first of the table: Math.random pinned to 0) and without it.
    // FIX-PUMP: PF-direct is on again (local builder only). The route reads the curve, mint and owner accounts at 'processed', builds, verifies
    // strictly and simulates the exact transaction, then signs it: the scripted chain below answers those reads and the simulation.
    const chain = createPumpDirectChain();
    addPumpWorld(chain, { mint: CLASSIC_MINT, owner: OWNER, creator: CREATOR, program: 'token', held: 1_000_000n, uva: true });
    const viaChain = { rpc: chain };
    const classicCurve = '166 bytes, SOL (zero key), classic Token mint';
    const buyTip = await pumpfunSwap.pumpfunBuy(signer, CLASSIC_MINT, 0.05, 300, 100_000, true, viaChain);
    expect(buyTip.slippageBpsUsed).toBe(300);
    checkGolden('server-pump-buy-tip', { ...base, call: 'pumpfunBuy(signer, mint, 0.05, 300, 100000, antiMev true)', curve: classicCurve }, sentMessage(0), ABOUT_FIX_PUMP);
    await pumpfunSwap.pumpfunBuy(signer, CLASSIC_MINT, 0.05, 300, 100_000, false, viaChain);
    checkGolden('server-pump-buy', { ...base, call: 'pumpfunBuy(signer, mint, 0.05, 300, 100000, antiMev false)', curve: classicCurve }, sentMessage(1), ABOUT_FIX_PUMP);
    const sellTip = await pumpfunSwap.pumpfunSell(signer, CLASSIC_MINT, 1_000_000n, 300, 100_000, true, viaChain);
    expect(sellTip.slippageBpsUsed).toBe(300);
    checkGolden('server-pump-sell-tip', { ...base, call: 'pumpfunSell(signer, mint, 1000000, 300, 100000, antiMev true)', curve: classicCurve }, sentMessage(2), ABOUT_FIX_PUMP);
    await pumpfunSwap.pumpfunSell(signer, CLASSIC_MINT, 1_000_000n, 300, 100_000, false, viaChain);
    checkGolden('server-pump-sell', { ...base, call: 'pumpfunSell(signer, mint, 1000000, 300, 100000, antiMev false)', curve: classicCurve }, sentMessage(3), ABOUT_FIX_PUMP);

    // FIX-PUMP new goldens: a Token-2022 coin, a mayhem coin (RESERVED[0] at account 1) and a cashback coin's 17-account sell
    addPumpWorld(chain, { mint: T22_MINT, owner: OWNER, creator: CREATOR, program: 'token2022', held: 1_000_000n, uva: true });
    await pumpfunSwap.pumpfunBuy(signer, T22_MINT, 0.05, 300, 100_000, true, viaChain);
    checkGolden('server-pump-buy-t22-tip', { ...base, mintKey: 33, call: 'pumpfunBuy(signer, mint, 0.05, 300, 100000, antiMev true)', curve: '166 bytes, SOL (zero key), Token-2022 mint (MetadataPointer, TokenMetadata)' }, sentMessage(4), ABOUT_FIX_PUMP);
    addPumpWorld(chain, { mint: MAYHEM_MINT, owner: OWNER, creator: CREATOR, program: 'token2022', curve: { mayhem: true }, uva: true });
    await pumpfunSwap.pumpfunBuy(signer, MAYHEM_MINT, 0.05, 300, 100_000, true, viaChain);
    checkGolden('server-pump-buy-mayhem-tip', { ...base, mintKey: 34, call: 'pumpfunBuy(signer, mint, 0.05, 300, 100000, antiMev true)', curve: '166 bytes, SOL (zero key), mayhem (byte 81 = 1), Token-2022 mint' }, sentMessage(5), ABOUT_FIX_PUMP);
    addPumpWorld(chain, { mint: CASHBACK_MINT, owner: OWNER, creator: CREATOR, program: 'token2022', curve: { cashback: true }, held: 1_000_000n, uva: true });
    await pumpfunSwap.pumpfunSell(signer, CASHBACK_MINT, 1_000_000n, 300, 100_000, true, viaChain);
    checkGolden('server-pump-sell-cashback-tip', { ...base, mintKey: 35, call: 'pumpfunSell(signer, mint, 1000000, 300, 100000, antiMev true)', curve: '166 bytes, SOL (zero key), cashback (byte 82 = 1), Token-2022 mint' }, sentMessage(6), ABOUT_FIX_PUMP_CASHBACK);

    // the decoded goldens carry the tables of the design: header 1/0/12 (buy) or 1/0/10 (sell), the key counts, the fee accounts
    const decoded = (n: number): VersionedTransaction => VersionedTransaction.deserialize(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(sentMessage(n))]));
    const shape = (n: number): number[] => {
      const m = decoded(n).message;
      return [m.header.numRequiredSignatures, m.header.numReadonlySignedAccounts, m.header.numReadonlyUnsignedAccounts, m.staticAccountKeys.length];
    };
    expect([0, 1, 2, 3, 4, 5, 6].map(shape)).toEqual([[1, 0, 12, 21], [1, 0, 12, 20], [1, 0, 10, 18], [1, 0, 10, 17], [1, 0, 12, 21], [1, 0, 12, 21], [1, 0, 10, 19]]);
    const pumpKeys = (n: number): string[] => {
      const m = decoded(n).message;
      const ix = m.compiledInstructions.find((x) => m.staticAccountKeys[x.programIdIndex].toBase58() === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')!;
      return ix.accountKeyIndexes.map((i) => m.staticAccountKeys[i].toBase58());
    };
    expect([pumpKeys(0)[1], pumpKeys(0)[17], pumpKeys(5)[1], pumpKeys(6)[16]]).toEqual([PUMP_FEE_RECIPIENTS_NORMAL[0], PUMP_BUYBACK_FEE_RECIPIENTS[0], PUMP_FEE_RECIPIENTS_MAYHEM[0], PUMP_BUYBACK_FEE_RECIPIENTS[0]]);
    expect(pumpKeys(6)[14]).toBe(pumpfunIx.deriveUserVolumeAccumulator(pk(OWNER)).toBase58());
    // the quote the route returns is pump's own (pinned against mainnet TradeEvents in pump-chain-layout.test.ts)
    expect(buyTip.tokensOut).toBe(pumpBuyQuote(30_000_000_000n, 1_073_000_000_000_000n, 50_000_000n)!.tokensOut);
    // PumpPortal is never asked for anything
    expect(h.fetch.mock.calls.filter((c) => String(c[0]).includes('pumpportal'))).toEqual([]);

    // PumpSwap (the router never opts in: only the existing test-only opt-in reaches the mechanics)
    const swapBase = { ...base, mintKey: 32, poolBaseVaultKey: 10, poolQuoteVaultKey: 11, coinCreatorKey: 12 };
    h.send.mockClear();
    await pumpswapBuy(signer, SWAP_MINT, 0.05, 300, 100_000, true, { testOnlyRunDisabledRoute: true });
    checkGolden('server-pumpswap-buy-tip', { ...swapBase, call: 'pumpswapBuy(signer, mint, 0.05, 300, 100000, antiMev true, testOnlyRunDisabledRoute)' }, sentMessage(0));
    await pumpswapBuy(signer, SWAP_MINT, 0.05, 300, 100_000, false, { testOnlyRunDisabledRoute: true });
    checkGolden('server-pumpswap-buy', { ...swapBase, call: 'pumpswapBuy(signer, mint, 0.05, 300, 100000, antiMev false, testOnlyRunDisabledRoute)' }, sentMessage(1));
    await pumpswapSell(signer, SWAP_MINT, 1_000_000n, 300, 100_000, true, { testOnlyRunDisabledRoute: true });
    checkGolden('server-pumpswap-sell-tip', { ...swapBase, call: 'pumpswapSell(signer, mint, 1000000, 300, 100000, antiMev true, testOnlyRunDisabledRoute)' }, sentMessage(2));
    await pumpswapSell(signer, SWAP_MINT, 1_000_000n, 300, 100_000, false, { testOnlyRunDisabledRoute: true });
    checkGolden('server-pumpswap-sell', { ...swapBase, call: 'pumpswapSell(signer, mint, 1000000, 300, 100000, antiMev false, testOnlyRunDisabledRoute)' }, sentMessage(3));

    // CloseAccount (the separate transaction of B40 rule 3): classic Token and Token-2022
    const ata = deriveAta(OWNER, CLASSIC_MINT, 'token');
    const closeClassic = buildCloseAccountTx(signer, ata, TOKEN_PROGRAM_ID, BLOCKHASH);
    checkGolden('server-close-account', { ...base, call: 'buildCloseAccountTx(signer, ata(owner, mint, Token), Token program, blockhash)' }, closeClassic.message.serialize());
    const ata22 = deriveAta(OWNER, CLASSIC_MINT, 'token2022');
    const close22 = buildCloseAccountTx(signer, ata22, TOKEN_2022_PROGRAM_ID, BLOCKHASH, { cuLimit: 40_000, cuPriceMicroLamports: 20_000 });
    checkGolden('server-close-account-token2022', { ...base, call: 'buildCloseAccountTx(signer, ata(owner, mint, Token-2022), Token-2022 program, blockhash, {cuLimit 40000, cuPrice 20000})' }, close22.message.serialize());
  });
});

// ── the pure pump builders ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('pumpfun-ix', () => {
  const owner = pk(fixtureKey(1));
  const mint = pk(CLASSIC_MINT);
  const creator = pk(CREATOR);
  const TOKEN = pk(TOKEN_PROGRAM_ID);
  const keysOf = (ix: { keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> }): string[] => ix.keys.map((k) => `${k.pubkey.toBase58()}:${k.isSigner ? 's' : '-'}${k.isWritable ? 'w' : '-'}`);

  it("builds buy_exact_sol_in with the 18 accounts of pump's 2026-04-28 layout and sell with 16 (17 for a cashback coin), for any payer, nothing else", () => {
    const fees = pumpfunIx.pickPumpFeeAccounts(false, () => 0);
    const buy = pumpfunIx.buildBuyInstruction(owner, mint, creator, 50_000_000n, 1_700_000_000n, TOKEN, fees);
    expect(buy.programId.toBase58()).toBe('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    expect(Array.from(buy.data.subarray(0, 8))).toEqual([56, 252, 116, 8, 158, 223, 205, 95]);     // sha256("global:buy_exact_sol_in")[0..8]
    expect(buy.data.length).toBe(25);                                                               // two u64 args and track_volume = 01; partial_fill absent
    expect(buy.data.readBigUInt64LE(8)).toBe(50_000_000n);
    expect(buy.data.readBigUInt64LE(16)).toBe(1_700_000_000n);
    expect(buy.data[24]).toBe(1);
    expect(buy.keys.length).toBe(18);
    const curve = pumpfunIx.deriveBondingCurve(mint);
    expect(buy.keys[3].pubkey.equals(curve)).toBe(true);
    expect(buy.keys[2].pubkey.equals(mint)).toBe(true);
    expect(buy.keys[4].pubkey.equals(pumpfunIx.deriveAta(mint, curve, TOKEN))).toBe(true);
    expect(buy.keys[5].pubkey.equals(pumpfunIx.deriveAta(mint, owner, TOKEN))).toBe(true);
    expect(buy.keys[6]).toMatchObject({ isSigner: true, isWritable: true });
    expect(buy.keys[6].pubkey.equals(owner)).toBe(true);
    expect(buy.keys[9].pubkey.equals(pumpfunIx.deriveCreatorVault(creator))).toBe(true);
    expect(buy.keys[1].pubkey.toBase58()).toBe(PUMP_FEE_RECIPIENTS_NORMAL[0]);
    expect(buy.keys[12]).toMatchObject({ isWritable: false });                                      // global_volume_accumulator read-only
    expect(buy.keys[16].pubkey.equals(pumpfunIx.deriveBondingCurveV2(mint))).toBe(true);
    expect(buy.keys[16]).toMatchObject({ isWritable: false });
    expect(buy.keys[17]).toMatchObject({ isWritable: true });
    expect(buy.keys[17].pubkey.toBase58()).toBe(PUMP_BUYBACK_FEE_RECIPIENTS[0]);
    expect(buy.keys.filter((k) => k.isSigner).length).toBe(1);                                      // the payer is the only signer
    const sell = pumpfunIx.buildSellInstruction(owner, mint, creator, 1_000_000n, 900n, false, TOKEN, fees);
    expect(Array.from(sell.data.subarray(0, 8))).toEqual([51, 230, 133, 164, 1, 127, 131, 173]);   // sha256("global:sell")[0..8]
    expect(sell.data.length).toBe(24);
    expect(sell.keys.length).toBe(16);
    expect(sell.keys[8].pubkey.equals(pumpfunIx.deriveCreatorVault(creator))).toBe(true);          // creator_vault BEFORE token_program on a sell
    expect(sell.keys[9].pubkey.equals(TOKEN)).toBe(true);
    expect(sell.keys[14].pubkey.equals(pumpfunIx.deriveBondingCurveV2(mint))).toBe(true);
    expect(sell.keys.filter((k) => k.isSigner).length).toBe(1);
    // FIX-PUMP: the cashback flag now matters: the user_volume_accumulator (writable) sits at 14, then bonding_curve_v2 and the buyback recipient
    const cashback = pumpfunIx.buildSellInstruction(owner, mint, creator, 1_000_000n, 900n, true, TOKEN, fees);
    expect(cashback.keys.length).toBe(17);
    expect(keysOf(cashback).slice(0, 14)).toEqual(keysOf(sell).slice(0, 14));
    expect(cashback.keys[14].pubkey.equals(pumpfunIx.deriveUserVolumeAccumulator(owner))).toBe(true);
    expect(cashback.keys[14]).toMatchObject({ isWritable: true });
    expect(keysOf(cashback).slice(15)).toEqual(keysOf(sell).slice(14));
    // the fee and buyback recipients come from the pinned lists; a mayhem coin pays the RESERVED list
    expect(pumpfunIx.pickPumpFeeAccounts(true, () => 0).feeRecipient.toBase58()).toBe(PUMP_FEE_RECIPIENTS_MAYHEM[0]);
    expect(pumpfunIx.pickPumpFeeAccounts(false, () => 0.99).feeRecipient.toBase58()).toBe(PUMP_FEE_RECIPIENTS_NORMAL[7]);
    expect(pumpfunIx.pickPumpFeeAccounts(false, () => 0.99).buybackFeeRecipient.toBase58()).toBe(PUMP_BUYBACK_FEE_RECIPIENTS[7]);
    expect(Object.keys(pumpfunIx)).not.toContain('PUMPFUN_FEE_RECIPIENT');                          // the CebN5 constant left the build path
    // the discriminators are the Anchor rule
    for (const [name, d] of [['buy_exact_sol_in', pumpfunIx.DISCRIMINATOR_BUY_EXACT_SOL_IN], ['sell', pumpfunIx.DISCRIMINATOR_SELL]] as const) {
      expect(Array.from(d)).toEqual(Array.from(createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)));
    }
    // the create-ATA instruction is the idempotent one, payer = owner
    const create = pumpfunIx.buildCreateAtaIfNeededIx(owner, owner, mint, TOKEN);
    expect(Array.from(create.data)).toEqual([1]);
    expect(create.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    // FIX-PUMP: the bonding-curve-v2 seed is proven on mainnet (pump-chain-layout.test.ts), so the pure file exports it; the signing file has no copy
    expect(Object.keys(pumpfunIx)).toContain('deriveBondingCurveV2');
    expect(Object.keys(pumpfunSwap)).not.toContain('deriveBondingCurveV2');
  });

  it('the exact (bigint) curve math equals the number forms, and the impact helper equals the server one', () => {
    for (const [vSol, vTok, lamports] of [[30_000_000_000, 1_073_000_000_000_000, 50_000_000], [85_000_000_000, 206_900_000_000_000, 2_000_000_000], [30_000_000_000, 1_073_000_000_000_000, 1]]) {
      expect(pumpfunIx.quoteBuy(vSol, vTok, lamports)).toBe(pumpfunIx.quoteBuyExact(BigInt(vSol), BigInt(vTok), BigInt(lamports)));
      expect(pumpfunSwap.quoteBuy(vSol, vTok, lamports)).toBe(pumpfunIx.quoteBuy(vSol, vTok, lamports));
    }
    expect(pumpfunIx.quoteSell(30_000_000_000, 1_073_000_000_000_000, 5_000_000_000n)).toBe(pumpfunIx.quoteSellExact(30_000_000_000n, 1_073_000_000_000_000n, 5_000_000_000n));
    expect(pumpfunIx.quoteBuyExact(30_000_000_000n, 1_073_000_000_000_000n, 0n)).toBe(0n);
    expect(pumpfunIx.quoteSellExact(30_000_000_000n, 1_073_000_000_000_000n, 0n)).toBe(0n);
    for (const [reserve, amount] of [[30_000_000_000n, 49_500_000n], [1n, 1n], [0n, 5n], [5n, -1n], [1_073_000_000_000_000n, 5_000_000_000n]] as const) {
      expect(pumpfunIx.constantProductImpactPct(reserve, amount)).toBe(serverImpactPct(reserve, amount));
    }
  });
});
