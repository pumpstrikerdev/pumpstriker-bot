/**
 * R7-W5 pumpswap-ix.ts: the PumpSwap AMM program as pure builders (A-93g IDL layouts), and the PDA/ATA goldens the dashboard inspector
 * reproduces. The goldens are generated here with @solana/web3.js findProgramAddressSync, independent of the code under test.
 * Format (A-20, G-S18): no base58 at all. A PDA stores its seeds and its 32 address bytes as base64; keys are fixtureKey(i) indices;
 * programs are named. Recorded with VITEST_WTX_WRITE_GOLDENS=1 (never in a gate).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import * as pumpfunIx from './pumpfun-ix';
import * as pumpswapIx from './pumpswap-ix';
import { constantProductImpactPct as serverImpactPct } from './send-context';

const fixtureKey = (i: number): string => bs58.encode(createHash('sha256').update('ps-fixture-' + i).digest());
const pk = (s: string): PublicKey => new PublicKey(s);
const WRITE = process.env.VITEST_WTX_WRITE_GOLDENS === '1';
const FILE = path.resolve(__dirname, '..', '..', 'test-fixtures', 'execution', 'wallet', 'goldens', 'pda-ata.json');

const PROGRAMS: Record<string, string> = {
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pumpswap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  fee: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
};
const WSOL = 'So11111111111111111111111111111111111111112';
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const keyBytes = (i: number): Uint8Array => pk(fixtureKey(i)).toBytes();
const utf8 = (s: string): Uint8Array => Buffer.from(s);
const u16le = (n: number): Uint8Array => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };

type Seed = { desc: string; bytes: Uint8Array };
const S = {
  utf8: (s: string): Seed => ({ desc: `utf8 ${s}`, bytes: utf8(s) }),
  key: (i: number): Seed => ({ desc: `key ${i}`, bytes: keyBytes(i) }),
  program: (name: string): Seed => ({ desc: `program ${name}`, bytes: pk(PROGRAMS[name]).toBytes() }),
  wsol: (): Seed => ({ desc: 'wsol mint', bytes: pk(WSOL).toBytes() }),
  u16: (n: number): Seed => ({ desc: `u16le ${n}`, bytes: u16le(n) }),
  raw: (desc: string, bytes: Uint8Array): Seed => ({ desc, bytes }),
};
const poolAuthority = (mintKey: number): PublicKey => PublicKey.findProgramAddressSync([utf8('pool-authority'), keyBytes(mintKey)], pk(PROGRAMS.pump))[0];
const FEE_CONFIG_SEED = Buffer.from([1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81, 137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176]);

interface PdaCase { name: string; program: string; seeds: Seed[] }
const PDA_CASES: PdaCase[] = [
  { name: 'pump bonding_curve', program: 'pump', seeds: [S.utf8('bonding-curve'), S.key(31)] },
  { name: 'pump creator_vault', program: 'pump', seeds: [S.utf8('creator-vault'), S.key(3)] },
  { name: 'pump global_volume_accumulator', program: 'pump', seeds: [S.utf8('global_volume_accumulator')] },
  { name: 'pump user_volume_accumulator', program: 'pump', seeds: [S.utf8('user_volume_accumulator'), S.key(1)] },
  { name: 'pump pool_authority', program: 'pump', seeds: [S.utf8('pool-authority'), S.key(32)] },
  { name: 'pump fee_config', program: 'fee', seeds: [S.utf8('fee_config'), S.raw('fee config seed (32 bytes)', FEE_CONFIG_SEED)] },
  { name: 'pumpswap canonical pool', program: 'pumpswap', seeds: [S.utf8('pool'), S.u16(0), S.raw('pool_authority of key 32', poolAuthority(32).toBytes()), S.key(32), S.wsol()] },
  { name: 'pumpswap coin creator vault authority', program: 'pumpswap', seeds: [S.utf8('creator_vault'), S.key(12)] },
  { name: 'pumpswap user_volume_accumulator', program: 'pumpswap', seeds: [S.utf8('user_volume_accumulator'), S.key(1)] },
  { name: 'pumpswap global_volume_accumulator', program: 'pumpswap', seeds: [S.utf8('global_volume_accumulator')] },
  { name: 'pumpswap fee_config', program: 'fee', seeds: [S.utf8('fee_config'), S.program('pumpswap')] },
];
const ATA_OWNERS = [1, 2];
const ATA_MINTS = [31, 32, 33];

interface Golden {
  _about: string;
  atas: Array<{ owner: number; mint: number | 'wsol'; program: 'token' | 'token2022'; address: string }>;
  pdas: Array<{ name: string; program: string; seedsDescription: string[]; seedsB64: string[]; address: string; bump: number }>;
}
function generate(): Golden {
  const ata = (owner: number, mint: Uint8Array, program: 'token' | 'token2022'): string => b64(PublicKey.findProgramAddressSync([keyBytes(owner), pk(PROGRAMS[program]).toBytes(), mint], pk(PROGRAMS.ata))[0].toBytes());
  const atas: Golden['atas'] = [];
  for (const owner of ATA_OWNERS) {
    for (const mint of ATA_MINTS) for (const program of ['token', 'token2022'] as const) atas.push({ owner, mint, program, address: ata(owner, keyBytes(mint), program) });
    atas.push({ owner, mint: 'wsol', program: 'token', address: ata(owner, pk(WSOL).toBytes(), 'token') });
  }
  const pdas: Golden['pdas'] = PDA_CASES.map((c) => {
    const [addr, bump] = PublicKey.findProgramAddressSync(c.seeds.map((s) => s.bytes), pk(PROGRAMS[c.program]));
    return { name: c.name, program: c.program, seedsDescription: c.seeds.map((s) => s.desc), seedsB64: c.seeds.map((s) => b64(s.bytes)), address: b64(addr.toBytes()), bump };
  });
  return {
    _about: 'PDA/ATA goldens, generated with @solana/web3.js findProgramAddressSync. keys are fixtureKey(i) = base58(sha256("ps-fixture-" + i)); programs are named (token, token2022, ata, pump, pumpswap, fee); addresses and seeds are base64 of the raw bytes; no base58 appears. The dashboard page-side pda.ts reproduces every entry.',
    atas, pdas,
  };
}

describe('pumpswap-ix', () => {
  it('WTX-T17 the PDA and ATA goldens are what web3.js derives, and the pure derivations reproduce them', () => {
    if (WRITE) fs.writeFileSync(FILE, JSON.stringify(generate(), null, 2) + '\n');
    const g = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Golden;
    expect(g).toEqual(generate());                                       // the file is exactly what web3.js derives today
    // no base58 address of ours appears in the file: not a fixture key, not a program id, not the wSOL mint
    const known = new Set<string>([...Array.from({ length: 100 }, (_, i) => fixtureKey(i)), ...Object.values(PROGRAMS), WSOL]);
    const strings: string[] = [];
    JSON.stringify(g, (_k, v) => { if (typeof v === 'string') strings.push(v); return v; });
    expect(strings.filter((x) => known.has(x))).toEqual([]);
    for (const a of g.atas) expect(Buffer.from(a.address, 'base64').length).toBe(32);
    expect(g.atas.length).toBe(ATA_OWNERS.length * (ATA_MINTS.length * 2 + 1));

    // the ATA address under each token program: the program id is part of the seeds, so the two programs differ
    for (const a of g.atas) {
      const mint = pk(a.mint === 'wsol' ? WSOL : fixtureKey(a.mint));
      const program = pk(PROGRAMS[a.program]);
      const viaPump = pumpfunIx.deriveAta(mint, pk(fixtureKey(a.owner)), program);
      const viaSwap = pumpswapIx.deriveAta(mint, pk(fixtureKey(a.owner)), program);
      expect(b64(viaPump.toBytes()), `${a.owner}/${a.mint}/${a.program} pumpfun-ix`).toBe(a.address);
      expect(b64(viaSwap.toBytes()), `${a.owner}/${a.mint}/${a.program} pumpswap-ix`).toBe(a.address);
    }
    const t = g.atas.find((a) => a.owner === 1 && a.mint === 31 && a.program === 'token')!;
    const t22 = g.atas.find((a) => a.owner === 1 && a.mint === 31 && a.program === 'token2022')!;
    expect(t.address).not.toBe(t22.address);

    // the PDAs the builders use
    const byName = (n: string): string => g.pdas.find((p) => p.name === n)!.address;
    const m = pk(fixtureKey(31));
    expect(b64(pumpfunIx.deriveBondingCurve(m).toBytes())).toBe(byName('pump bonding_curve'));
    expect(b64(pumpfunIx.deriveCreatorVault(pk(fixtureKey(3))).toBytes())).toBe(byName('pump creator_vault'));
    expect(b64(pumpfunIx.deriveGlobalVolumeAccumulator().toBytes())).toBe(byName('pump global_volume_accumulator'));
    expect(b64(pumpfunIx.deriveUserVolumeAccumulator(pk(fixtureKey(1))).toBytes())).toBe(byName('pump user_volume_accumulator'));
    expect(b64(pumpfunIx.deriveFeeConfig().toBytes())).toBe(byName('pump fee_config'));
    expect(b64(pumpswapIx.derivePumpSwapPoolAuthority(pk(fixtureKey(32))).toBytes())).toBe(byName('pump pool_authority'));
    expect(b64(pumpswapIx.derivePumpSwapCanonicalPool(pk(fixtureKey(32))).toBytes())).toBe(byName('pumpswap canonical pool'));
    expect(b64(pumpswapIx.deriveCoinCreatorVaultAuthority(pk(fixtureKey(12))).toBytes())).toBe(byName('pumpswap coin creator vault authority'));
    expect(b64(pumpswapIx.derivePumpSwapUserVolumeAccumulator(pk(fixtureKey(1))).toBytes())).toBe(byName('pumpswap user_volume_accumulator'));
    expect(b64(pumpswapIx.PUMPSWAP_GLOBAL_VOLUME_ACCUMULATOR.toBytes())).toBe(byName('pumpswap global_volume_accumulator'));
    expect(b64(pumpswapIx.PUMPSWAP_FEE_CONFIG.toBytes())).toBe(byName('pumpswap fee_config'));
    // the protocol-fee token account is the ATA of the fee recipient for wSOL (and is off the curve)
    expect(pumpswapIx.PUMPSWAP_FEE_RECIPIENT_ATA.equals(pumpswapIx.deriveAta(pumpswapIx.WSOL_MINT_PK, pumpswapIx.PUMPSWAP_FEE_RECIPIENT, pumpswapIx.TOKEN_PROGRAM_PK))).toBe(true);
    // every golden PDA is off the ed25519 curve, with a bump of 255 or below
    for (const p of g.pdas) {
      expect(PublicKey.isOnCurve(Buffer.from(p.address, 'base64'))).toBe(false);
      expect(p.bump).toBeLessThanOrEqual(255);
    }
  });

  it('builds the IDL buy (23 accounts) and sell (21 accounts) for any payer, and the route stays off', () => {
    expect(pumpswapIx.PUMPSWAP_DIRECT_ENABLED).toBe(false);
    expect(() => { throw new pumpswapIx.PumpSwapDirectDisabledError('buy'); }).toThrow(/PumpSwap direct disabled/);
    const owner = pk(fixtureKey(1));
    const mint = pk(fixtureKey(32));
    const pool: pumpswapIx.PoolRefs = { pool: pk(fixtureKey(20)), poolBaseAccount: pk(fixtureKey(10)), poolQuoteAccount: pk(fixtureKey(11)), coinCreator: pk(fixtureKey(12)) };
    const TOKEN = pumpswapIx.TOKEN_PROGRAM_PK;
    const buy = pumpswapIx.buildPumpSwapBuyInstruction(owner, mint, pool, TOKEN, 7n, 9n);
    const sell = pumpswapIx.buildPumpSwapSellInstruction(owner, mint, pool, TOKEN, 11n, 13n);
    expect(buy.keys.length).toBe(23);
    expect(sell.keys.length).toBe(21);
    expect(Array.from(buy.data.subarray(0, 8))).toEqual([102, 6, 61, 18, 1, 218, 235, 234]);
    expect(Array.from(sell.data.subarray(0, 8))).toEqual([51, 230, 133, 164, 1, 127, 131, 173]);
    expect(buy.data.length).toBe(24);
    expect(sell.data.length).toBe(24);
    for (const ix of [buy, sell]) {
      expect(ix.keys[1].pubkey.equals(owner)).toBe(true);                                                          // user
      expect(ix.keys[3].pubkey.equals(mint)).toBe(true);                                                           // base_mint
      expect(ix.keys[5].pubkey.equals(pumpswapIx.deriveAta(mint, owner, TOKEN))).toBe(true);                      // user base ATA under the mint's program
      expect(ix.keys[6].pubkey.equals(pumpswapIx.deriveAta(pumpswapIx.WSOL_MINT_PK, owner, TOKEN))).toBe(true);  // user quote ATA
      expect(ix.keys[10].pubkey.equals(pumpswapIx.PUMPSWAP_FEE_RECIPIENT_ATA)).toBe(true);                         // protocol fee ATA
      expect(ix.keys[17].pubkey.equals(pumpswapIx.deriveAta(pumpswapIx.WSOL_MINT_PK, pumpswapIx.deriveCoinCreatorVaultAuthority(pool.coinCreator), TOKEN))).toBe(true);
      expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([owner.toBase58()]);
    }
    // the impact helpers equal the server-side arithmetic
    for (const [reserve, amount] of [[250_000_000_000_000n, 49_500_000n], [91_000_000_000n, 1_000_000n], [1n, 1n]] as const) {
      expect(pumpswapIx.constantProductImpactPct(reserve, amount)).toBe(serverImpactPct(reserve, amount));
    }
    expect(pumpswapIx.poolBuyImpactPct(91_000_000_000n, 50_000_000n)).toBe(serverImpactPct(91_000_000_000n, (50_000_000n * 9905n) / 10_000n));
    expect(pumpswapIx.poolSellImpactPct(250_000_000_000_000n, 1_000_000n)).toBe(serverImpactPct(250_000_000_000_000n, 1_000_000n));
  });
});
