/**
 * A-93g (2026-10-26): PumpSwap direct route against the official pump_amm IDL. Every expected value is built from the
 * fixture test-fixtures/execution/pump-amm-idl-swap.json (IDL seed bytes, account order and flags, Pool field order),
 * never from the module's own helpers. Everything external is mocked (RPC pool, senders, node-fetch, logger): no
 * socket, no wallet file, nothing sent.
 */
import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ send: vi.fn(), blockhash: vi.fn(), rpc: vi.fn(), fetch: vi.fn() }));
vi.mock('./jupiter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jupiter')>();
  return { ...actual, heliusSmartSend: h.send, multiRpcSend: h.send, getResilientBlockhash: h.blockhash, resilientRpcCall: h.rpc };
});
vi.mock('node-fetch', () => ({ default: h.fetch }));
vi.mock('./pumpfun-info', () => ({ getCachedPumpFunInfo: vi.fn(), fetchPumpFunInfo: vi.fn() }));
vi.mock('../logger', () => ({ log: vi.fn(), logOk: vi.fn(), logWarn: vi.fn(), logErr: vi.fn(), logDbg: vi.fn(), setBroadcast: vi.fn(), emitEvent: vi.fn() }));

import * as ps from './pumpswap-swap';

const FIX = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'test-fixtures', 'execution', 'pump-amm-idl-swap.json'), 'utf8'));
const P = (s: string): PublicKey => new PublicKey(s);
const AMM = P(FIX.programs.pump_amm);
const PUMP = P(FIX.programs.pump);
const ATA_PROG = new PublicKey(Uint8Array.from(FIX.programs.associated_token_program_bytes));
const TOKEN = P(FIX.programs.token_program);
const T22 = P(FIX.programs.token_2022_program);
const WSOL = P(FIX.programs.wsol_mint);
const seed = (name: string): Buffer => Buffer.from(FIX.seeds[name]);
const pda = (seeds: Buffer[], program: PublicKey): PublicKey => PublicKey.findProgramAddressSync(seeds, program)[0];
const ata = (owner: PublicKey, mint: PublicKey, program: PublicKey): PublicKey => pda([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROG);
const key = (n: number): PublicKey => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;

const wallet = Keypair.fromSeed(new Uint8Array(32).fill(1));
const USER = wallet.publicKey;
const CLASSIC_MINT = key(41);
const T22_MINT = key(42);
const COIN_CREATOR = key(43);
const POOL_BASE_VAULT = key(44);
const POOL_QUOTE_VAULT = key(45);

/** Canonical pool of a migrated coin, from the IDL seeds alone (pump `migrate`: 'pool', [0,0], pool_authority, mint, wsol). */
function fixturePool(mint: PublicKey): PublicKey {
  const authority = pda([seed('pool_authority'), mint.toBuffer()], PUMP);
  return pda([seed('pool'), seed('pool_index_migrate'), authority.toBuffer(), mint.toBuffer(), WSOL.toBuffer()], AMM);
}

const SIZES: Record<string, number> = { u8: 1, u16: 2, pubkey: 32, u64: 8, bool: 1, i128: 16 };
/** A Pool account laid out by walking the IDL field order of the fixture (Borsh, little endian). */
function poolAccountBytes(values: Record<string, PublicKey | bigint | number>, discriminator: number[] = FIX.discriminators.account_Pool): Buffer {
  const total = 8 + (FIX.poolType.fields as Array<[string, string]>).reduce((n, [, t]) => n + SIZES[t], 0);
  const b = Buffer.alloc(total);
  Buffer.from(discriminator).copy(b, 0);
  let off = 8;
  for (const [name, type] of FIX.poolType.fields as Array<[string, string]>) {
    const v = values[name];
    if (v instanceof PublicKey) Buffer.from(v.toBytes()).copy(b, off);
    else if (v !== undefined && type === 'u64') b.writeBigUInt64LE(BigInt(v), off);
    else if (v !== undefined && type === 'i128') { const x = BigInt.asUintN(128, BigInt(v)); b.writeBigUInt64LE(x & ((1n << 64n) - 1n), off); b.writeBigUInt64LE(x >> 64n, off + 8); }
    else if (v !== undefined && (type === 'u8' || type === 'bool')) b.writeUInt8(Number(v), off);
    else if (v !== undefined && type === 'u16') b.writeUInt16LE(Number(v), off);
    off += SIZES[type];
  }
  return b;
}
const poolValues = (mint: PublicKey): Record<string, PublicKey | bigint | number> => ({
  pool_bump: 254, index: 0, creator: pda([seed('pool_authority'), mint.toBuffer()], PUMP), base_mint: mint, quote_mint: WSOL,
  lp_mint: key(46), pool_base_token_account: POOL_BASE_VAULT, pool_quote_token_account: POOL_QUOTE_VAULT, lp_supply: 1_000_000n,
  coin_creator: COIN_CREATOR, is_mayhem_mode: 0, is_cashback_coin: 0, virtual_quote_reserves: 0n,
});

/** Every account of the IDL buy / sell lists, by name, built from the fixture only. */
function expectedKeys(mint: PublicKey, baseTokenProgram: PublicKey): Record<string, PublicKey> {
  const vaultAuthority = pda([seed('creator_vault'), COIN_CREATOR.toBuffer()], AMM);
  return {
    pool: fixturePool(mint), user: USER, global_config: P(FIX.fixed.global_config), base_mint: mint, quote_mint: WSOL,
    user_base_token_account: ata(USER, mint, baseTokenProgram), user_quote_token_account: ata(USER, WSOL, TOKEN),
    pool_base_token_account: POOL_BASE_VAULT, pool_quote_token_account: POOL_QUOTE_VAULT,
    protocol_fee_recipient: P(FIX.fixed.protocol_fee_recipient),
    protocol_fee_recipient_token_account: ata(P(FIX.fixed.protocol_fee_recipient), WSOL, TOKEN),
    base_token_program: baseTokenProgram, quote_token_program: TOKEN, system_program: P(FIX.programs.system_program),
    associated_token_program: ATA_PROG, event_authority: P(FIX.fixed.event_authority), program: AMM,
    coin_creator_vault_ata: ata(vaultAuthority, WSOL, TOKEN), coin_creator_vault_authority: vaultAuthority,
    global_volume_accumulator: pda([seed('global_volume_accumulator')], AMM),
    user_volume_accumulator: pda([seed('user_volume_accumulator'), USER.toBuffer()], AMM),
    fee_config: pda([seed('fee_config'), seed('fee_config_second_seed')], P(FIX.programs.fee_program)),
    fee_program: P(FIX.programs.fee_program),
  };
}

const signatureOfSent = async (tx: VersionedTransaction): Promise<string> => bs58.encode(tx.signatures[0]);
const sentTxs = (): VersionedTransaction[] => h.send.mock.calls.map((c) => c[0] as VersionedTransaction);
/** The pAMM instruction of a sent transaction: its account keys (in order) and data. */
function ammIx(tx: VersionedTransaction): { keys: PublicKey[]; data: Buffer } {
  const msg = tx.message;
  const ixs = msg.compiledInstructions.filter((ix) => msg.staticAccountKeys[ix.programIdIndex].equals(AMM));
  expect(ixs).toHaveLength(1);
  return { keys: ixs[0].accountKeyIndexes.map((i) => msg.staticAccountKeys[i]), data: Buffer.from(ixs[0].data) };
}

let poolMints: PublicKey[] = [];
const requested: string[] = [];
beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  requested.length = 0;
  poolMints = [CLASSIC_MINT, T22_MINT];
  h.send.mockImplementation(signatureOfSent);
  h.blockhash.mockResolvedValue({ blockhash: key(90).toBase58(), lastValidBlockHeight: 4_242 });
  h.rpc.mockImplementation(async (method: string, params: any[]) => {
    if (method === 'getAccountInfo') {
      requested.push(params[0]);
      const mint = poolMints.find((m) => fixturePool(m).toBase58() === params[0]);
      return { value: mint ? { data: [poolAccountBytes(poolValues(mint)).toString('base64'), 'base64'] } : null };
    }
    if (method === 'getTokenAccountBalance') return { value: { amount: params[0] === POOL_BASE_VAULT.toBase58() ? '250000000000000' : '91000000000' } };
    throw new Error(`unexpected rpc ${method}`);
  });
  // getTokenProgramForMint probes (pumpfun-swap.ts): the T22 mint is owned by Token-2022, every other mint by Token
  h.fetch.mockImplementation(async (_url: string, init?: { body?: string }) => {
    const mint = JSON.parse(String(init?.body)).params?.[0];
    return { ok: true, status: 200, json: async () => ({ result: { value: { owner: mint === T22_MINT.toBase58() ? T22.toBase58() : TOKEN.toBase58() } } }) };
  });
});

describe('A-93g PumpSwap constants and PDAs against the pump_amm IDL', () => {
  it('FIXAB-T01 the protocol-fee token account is the derived ATA of 62qc2... for WSOL (off the curve); the volume and fee-config PDAs match the IDL seeds', () => {
    const derived = ata(P(FIX.fixed.protocol_fee_recipient), WSOL, TOKEN);
    expect(derived.toBase58()).toBe(FIX.fixed.protocol_fee_recipient_token_account);
    expect(ps.PUMPSWAP_FEE_RECIPIENT_ATA.toBase58()).toBe(derived.toBase58());
    expect(PublicKey.isOnCurve(ps.PUMPSWAP_FEE_RECIPIENT_ATA.toBytes())).toBe(false);
    // the replaced literal is a curve point, so it can never be an ATA (the program would refuse every buy and sell)
    expect(PublicKey.isOnCurve(P(FIX.fixed.protocol_fee_recipient_token_account_old_wrong).toBytes())).toBe(true);
    expect(ps.PUMPSWAP_FEE_RECIPIENT.toBase58()).toBe(FIX.fixed.protocol_fee_recipient);

    expect(ps.PUMPSWAP_GLOBAL_VOLUME_ACCUMULATOR.toBase58()).toBe(pda([seed('global_volume_accumulator')], AMM).toBase58());
    expect(ps.PUMPSWAP_GLOBAL_VOLUME_ACCUMULATOR.toBase58()).toBe(FIX.fixed.global_volume_accumulator);
    expect(seed('fee_config_second_seed').equals(AMM.toBuffer())).toBe(true);    // the IDL's 32 const bytes are the pAMM id
    expect(ps.PUMPSWAP_FEE_CONFIG.toBase58()).toBe(pda([seed('fee_config'), seed('fee_config_second_seed')], P(FIX.programs.fee_program)).toBase58());
    expect(ps.PUMPSWAP_FEE_CONFIG.toBase58()).toBe(FIX.fixed.fee_config);
  });

  it('FIXAB-T02 the pool PDA carries the pool_authority (creator) seed, and the pool read asks for exactly that address', async () => {
    for (const mint of [CLASSIC_MINT, T22_MINT, key(47)]) {
      expect(ps.derivePumpSwapCanonicalPool(mint).toBase58()).toBe(fixturePool(mint).toBase58());
    }
    const fresh = key(48);
    poolMints = [fresh];
    expect(await ps.hasPumpSwapPool(fresh.toBase58())).toBe(true);
    expect(requested).toEqual([fixturePool(fresh).toBase58()]);
    // the old seed set (no creator) names another address, which holds no pool
    const oldPda = pda([seed('pool'), seed('pool_index_migrate'), fresh.toBuffer(), WSOL.toBuffer()], AMM);
    expect(oldPda.equals(fixturePool(fresh))).toBe(false);
  });

  it('FIXAB-T03 the Pool account is read at the IDL offsets (u8 bump), and anything unexpected fails closed', () => {
    const bytes = poolAccountBytes(poolValues(CLASSIC_MINT));
    const acc = ps.parsePumpSwapPoolAccount(bytes, CLASSIC_MINT)!;
    expect(acc).not.toBeNull();
    expect(acc.baseMint.equals(CLASSIC_MINT)).toBe(true);
    expect(acc.quoteMint.equals(WSOL)).toBe(true);
    expect(acc.poolBaseAccount.equals(POOL_BASE_VAULT)).toBe(true);
    expect(acc.poolQuoteAccount.equals(POOL_QUOTE_VAULT)).toBe(true);
    expect(acc.coinCreator.equals(COIN_CREATOR)).toBe(true);

    expect(ps.parsePumpSwapPoolAccount(bytes, T22_MINT)).toBeNull();                                                  // another base mint
    expect(ps.parsePumpSwapPoolAccount(poolAccountBytes({ ...poolValues(CLASSIC_MINT), quote_mint: key(49) }), CLASSIC_MINT)).toBeNull();   // quote not WSOL
    expect(ps.parsePumpSwapPoolAccount(poolAccountBytes(poolValues(CLASSIC_MINT), [0, 0, 0, 0, 0, 0, 0, 0]), CLASSIC_MINT)).toBeNull();      // wrong discriminator
    expect(ps.parsePumpSwapPoolAccount(bytes.subarray(0, 242), CLASSIC_MINT)).toBeNull();                              // no full coin_creator
    expect(ps.parsePumpSwapPoolAccount(poolAccountBytes({ ...poolValues(CLASSIC_MINT), virtual_quote_reserves: -5n }), CLASSIC_MINT)).toBeNull();   // the x*y quote ignores it
    // a legacy account without the virtual_quote_reserves field reads as before
    expect(ps.parsePumpSwapPoolAccount(bytes.subarray(0, 245), CLASSIC_MINT)).not.toBeNull();
    // the old reader's layout (2-byte bump: base_mint at 76) is not a pool
    const old = Buffer.alloc(300);
    Buffer.from(FIX.discriminators.account_Pool).copy(old, 0);
    Buffer.from(CLASSIC_MINT.toBytes()).copy(old, 76);
    Buffer.from(WSOL.toBytes()).copy(old, 108);
    expect(ps.parsePumpSwapPoolAccount(old, CLASSIC_MINT)).toBeNull();
  });
});

describe('A-93g PumpSwap buy / sell account lists against the pump_amm IDL', () => {
  const names = (side: 'buy' | 'sell'): string[] => FIX.instructions[side].accounts.map((a: { name: string }) => a.name);
  const flags = (side: 'buy' | 'sell'): Array<[boolean, boolean]> => FIX.instructions[side].accounts.map((a: { writable: boolean; signer: boolean }) => [a.writable, a.signer]);
  const refs = (mint: PublicKey) => ({ pool: fixturePool(mint), poolBaseAccount: POOL_BASE_VAULT, poolQuoteAccount: POOL_QUOTE_VAULT, coinCreator: COIN_CREATOR });

  it('FIXAB-T04 buy: 23 accounts in IDL order with IDL flags, the mint\'s own token program in slot 11, discriminator + two u64 args', async () => {
    expect(names('buy')).toHaveLength(23);
    for (const [mint, prog] of [[CLASSIC_MINT, TOKEN], [T22_MINT, T22]] as const) {
      const want = expectedKeys(mint, prog);
      const ix = ps.buildPumpSwapBuyInstruction(USER, mint, refs(mint), prog, 7n, 9n);
      expect(ix.programId.equals(AMM)).toBe(true);
      expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(names('buy').map((n) => want[n].toBase58()));
      expect(ix.keys.map((k) => [k.isWritable, k.isSigner])).toEqual(flags('buy'));
      expect(ix.data.subarray(0, 8)).toEqual(Buffer.from(FIX.discriminators.buy));
      expect(ix.data.readBigUInt64LE(8)).toBe(7n);
      expect(ix.data.readBigUInt64LE(16)).toBe(9n);
      expect(ix.data).toHaveLength(24);

      // the same list reaches the transaction the (test-only enabled) route signs, with the pool the RPC read gave
      h.send.mockClear();
      await ps.pumpswapBuy(wallet, mint.toBase58(), 0.05, null, 100_000, false, { testOnlyRunDisabledRoute: true });
      const sent = ammIx(sentTxs()[0]);
      expect(sent.keys.map((k) => k.toBase58())).toEqual(names('buy').map((n) => want[n].toBase58()));
      expect(sent.data.subarray(0, 8)).toEqual(Buffer.from(FIX.discriminators.buy));
    }
  });

  it('FIXAB-T05 sell: 21 accounts in IDL order with IDL flags (no volume accumulators), discriminator + two u64 args', async () => {
    expect(names('sell')).toHaveLength(21);
    for (const [mint, prog] of [[CLASSIC_MINT, TOKEN], [T22_MINT, T22]] as const) {
      const want = expectedKeys(mint, prog);
      const ix = ps.buildPumpSwapSellInstruction(USER, mint, refs(mint), prog, 11n, 13n);
      expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(names('sell').map((n) => want[n].toBase58()));
      expect(ix.keys.map((k) => [k.isWritable, k.isSigner])).toEqual(flags('sell'));
      expect(ix.data).toEqual(Buffer.concat([Buffer.from(FIX.discriminators.sell), Buffer.from([11, 0, 0, 0, 0, 0, 0, 0, 13, 0, 0, 0, 0, 0, 0, 0])]));

      h.send.mockClear();
      await ps.pumpswapSell(wallet, mint.toBase58(), 1_000_000n, null, 100_000, false, { testOnlyRunDisabledRoute: true });
      expect(ammIx(sentTxs()[0]).keys.map((k) => k.toBase58())).toEqual(names('sell').map((n) => want[n].toBase58()));
    }
  });

  it('FIXAB-T06 the direct route is disabled by default: buy and sell throw before any RPC call, build, signature or send, and the router never opts in', async () => {
    expect(ps.PUMPSWAP_DIRECT_ENABLED).toBe(false);
    await expect(ps.pumpswapBuy(wallet, CLASSIC_MINT.toBase58(), 0.05, null, 100_000, true)).rejects.toBeInstanceOf(ps.PumpSwapDirectDisabledError);
    await expect(ps.pumpswapSell(wallet, CLASSIC_MINT.toBase58(), 1_000_000n, null, 100_000, true, {})).rejects.toThrow(/PumpSwap direct disabled/);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.blockhash).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    const routerSrc = fs.readFileSync(path.resolve(__dirname, 'router.ts'), 'utf8');
    expect(routerSrc).not.toMatch(/testOnlyRunDisabledRoute/);
    for (const f of fs.readdirSync(path.resolve(__dirname, '..'), { recursive: true }) as string[]) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      const src = fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
      // the two disabled direct routes define the opt-in (A-93g here, FIX-BUY2 pf-direct); no other source may name it
      if (path.basename(f) === 'pumpswap-swap.ts' || path.basename(f) === 'pumpfun-swap.ts') continue;
      expect(src, f).not.toMatch(/testOnlyRunDisabledRoute/);
    }
  });
});
