/**
 * valuation tests: the three-source chain (onchain, jupiter, engine_gmgn), the age bound and the protective-only rule of the Engine price,
 * and the static rule that no non-execution price site and no constant SOL price is anywhere in the exit modules.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { PositionV2 } from '../bot-contracts';
import { FakeClock } from '../link/clock';
import { newCa } from '../link/link-testkit';
import { CONSTANT_SOL_PRICE_RE, G_S13_RE, ScanContext, formatViolations, runGuard } from '../guards/guard-lib';
import { anchorAccountDiscriminator } from '../execution/curve-parse';
import { createCurveReader, deriveBondingCurvePda } from '../execution/curve-state';
import { PUMP_PROGRAM_ID, type ExecRpc } from '../execution/exec-common';
import { createOnchainQuoter } from '../execution/onchain-quote';
import { ENGINE_PRICE_MAX_AGE_MS, SOURCE_TIMEOUT_MS, WSOL_MINT, createValuation, type ValuationDeps } from './valuation';
import { START_MS } from './exits-testkit';

const BOT_ROOT = path.resolve(__dirname, '..', '..');

function pos(tokens = '1000000000', ca = newCa()): PositionV2 {
  return {
    position_id: 'p1', signal_id: 'dec_1', origin: 'signal', dry_run: false, ca, wallet_id: 'w1', policy_id: 'EA', policy_version: null, arm: null,
    entry: { tx: null, opened_at: START_MS, sol_spent_lamports: null, tokens_raw: null, fill_source: 'tx_meta' },
    original_tokens: tokens, tokens, basis_sol_per_token: null, peak_multiple: 1, legs_done: [], leg_attempts: {}, last_quote: null, lockouts: [], ata: null,
  };
}

interface Script {
  onchain?: number | null | 'throws' | 'hangs';
  jup?: unknown | 'throws';
  token?: { usd: number | null; ageMs: number } | 'error';
  sol?: { usd: number | null; ageMs: number } | 'error';
  decimals?: number | null;
  frozen?: boolean;
}

function build(clock: FakeClock, s: Script): { deps: ValuationDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: ValuationDeps = {
    clock,
    onchain: {
      async quoteSell() {
        calls.push('onchain');
        if (s.onchain === 'throws') throw new Error('rpc down');
        if (s.onchain === 'hangs') return new Promise<null>(() => undefined);
        return s.onchain === undefined || s.onchain === null ? null : { venue: 'pump-curve', solOutLamports: BigInt(Math.round(s.onchain * 1e9)), sol: s.onchain, at: clock.now() - 100 };
      },
    },
    async jupQuote(inputMint, outputMint, amount) {
      calls.push(`jupiter:${outputMint === WSOL_MINT ? 'sol' : 'other'}:${amount}`);
      if (s.jup === 'throws') throw new Error('Jupiter quote failed: 429');
      return s.jup;
    },
    engine: {
      async price(ca: string) {
        calls.push(ca === WSOL_MINT ? 'engine:sol' : 'engine:token');
        const e = ca === WSOL_MINT ? s.sol : s.token;
        if (e === undefined || e === 'error') return { error: 'engine offline' };
        return { price: { value: e.usd, src: e.usd === null ? null : 'gmgn.token_info', as_of: e.usd === null ? null : clock.now() - e.ageMs }, frozen: s.frozen === true, drained: false };
      },
    },
    decimals: async () => (s.decimals === undefined ? 6 : s.decimals),
    log: () => undefined,
  };
  return { deps, calls };
}

describe('the valuation chain', () => {
  it('uses the on-chain quote first and reports it with its own time', async () => {
    const clock = new FakeClock(START_MS);
    const { deps, calls } = build(clock, { onchain: 0.25, jup: { outAmount: '999' } });
    const q = await createValuation(deps).quote(pos(), true);
    expect(q).toEqual({ sol: 0.25, src: 'onchain', at: START_MS - 100 });
    expect(calls).toEqual(['onchain']);
  });

  it('falls back to Jupiter when the on-chain read has nothing or throws, converting lamports to SOL for the current bag', async () => {
    const clock = new FakeClock(START_MS);
    for (const onchain of [null, 'throws'] as const) {
      const { deps, calls } = build(clock, { onchain, jup: { outAmount: '123456789' } });
      const q = await createValuation(deps).quote(pos('4242'), false);
      expect(q).toEqual({ sol: 0.123456789, src: 'jupiter', at: START_MS });
      expect(calls).toEqual(['onchain', 'jupiter:sol:4242']);
    }
  });

  it('a Jupiter answer without a usable amount is no quote', async () => {
    const clock = new FakeClock(START_MS);
    for (const jup of [null, {}, { outAmount: '0' }, { outAmount: 'abc' }, 'throws'] as const) {
      const { deps } = build(clock, { onchain: null, jup });
      expect(await createValuation(deps).quote(pos(), false)).toBeNull();
    }
  });

  it('the Engine price is the third source: only for protective legs, only when it is at most 30 s old, converted with the Engine SOL price', async () => {
    const clock = new FakeClock(START_MS);
    // 1000 tokens (1e9 atoms, 6 decimals) at 0.00002 USD each, SOL at 100 USD: 0.0002 SOL.
    const fresh: Script = { onchain: null, jup: 'throws', token: { usd: 0.00002, ageMs: 20_000 }, sol: { usd: 100, ageMs: 5_000 } };
    const a = build(clock, fresh);
    expect(await createValuation(a.deps).quote(pos(), false)).toBeNull();           // a take-profit is never judged on it
    expect(a.calls.filter(c => c.startsWith('engine'))).toEqual([]);                 // and the Engine is not even asked
    const b = build(clock, fresh);
    const q = await createValuation(b.deps).quote(pos(), true);
    expect(q?.src).toBe('engine_gmgn');
    expect(q?.sol).toBeCloseTo(0.0002, 12);
    expect(q?.at).toBe(START_MS - 20_000);                                           // the OLDER of the two prices
  });

  it('refuses an Engine price older than 30 s (token or SOL), a missing SOL price, unknown decimals, a frozen price, an offline Engine', async () => {
    const clock = new FakeClock(START_MS);
    const base: Script = { onchain: null, jup: null, token: { usd: 0.00002, ageMs: 10_000 }, sol: { usd: 100, ageMs: 10_000 } };
    const ask = (s: Script) => createValuation(build(clock, { ...base, ...s }).deps).quote(pos(), true);
    expect((await ask({}))?.src).toBe('engine_gmgn');
    expect((await ask({ token: { usd: 0.00002, ageMs: ENGINE_PRICE_MAX_AGE_MS } }))?.src).toBe('engine_gmgn');   // exactly 30 s is still fresh
    expect(await ask({ token: { usd: 0.00002, ageMs: ENGINE_PRICE_MAX_AGE_MS + 1 } })).toBeNull();
    expect(await ask({ sol: { usd: 100, ageMs: ENGINE_PRICE_MAX_AGE_MS + 1 } })).toBeNull();
    expect(await ask({ sol: { usd: null, ageMs: 0 } })).toBeNull();      // no SOL price: there is NO constant to fall back on
    expect(await ask({ sol: 'error' })).toBeNull();
    expect(await ask({ token: { usd: null, ageMs: 0 } })).toBeNull();
    expect(await ask({ token: 'error' })).toBeNull();
    expect(await ask({ decimals: null })).toBeNull();
    expect(await ask({ frozen: true })).toBeNull();
    expect(await ask({ sol: { usd: 0, ageMs: 0 } })).toBeNull();
  });

  it('a token worth 0 on the Engine price is a real quote of 0 (the protective legs must see it)', async () => {
    const clock = new FakeClock(START_MS);
    const { deps } = build(clock, { onchain: null, jup: null, token: { usd: 0, ageMs: 1_000 }, sol: { usd: 100, ageMs: 1_000 } });
    const q = await createValuation(deps).quote(pos(), true);
    expect(q?.sol).toBe(0);
    expect(q?.src).toBe('engine_gmgn');
  });

  it('a source that hangs costs only its time budget, then the chain goes on', async () => {
    const clock = new FakeClock(START_MS);
    const { deps } = build(clock, { onchain: 'hangs', jup: { outAmount: '500000000' } });
    const pending = createValuation(deps).quote(pos(), false);
    await clock.advance(SOURCE_TIMEOUT_MS);
    expect(await pending).toEqual({ sol: 0.5, src: 'jupiter', at: START_MS + SOURCE_TIMEOUT_MS });
  });

  it('FIXBUY2-I6-T03 a bag on a curve quoted in USDC is never valued as SOL: the real on-chain quoter has no price and the Jupiter stub values it', async () => {
    const clock = new FakeClock(START_MS);
    const ca = newCa();
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    /** A live 166-byte bonding curve of `ca` (pump IDL); its 30,000,000,000 quote reserve is 30 SOL in WSOL and 30,000 USDC in USDC. */
    const curve = (quoteMint: string): Buffer => {
      const b = Buffer.alloc(166);
      anchorAccountDiscriminator('BondingCurve').copy(b, 0);
      b.writeBigUInt64LE(1_073_000_000_000_000n, 8);
      b.writeBigUInt64LE(30_000_000_000n, 16);
      b.writeBigUInt64LE(793_100_000_000_000n, 24);
      b.writeBigUInt64LE(1n, 32);
      b.writeBigUInt64LE(1_000_000_000_000_000n, 40);
      Buffer.from(new PublicKey(newCa()).toBytes()).copy(b, 49);
      Buffer.from(new PublicKey(quoteMint).toBytes()).copy(b, 83);
      return b;
    };
    const onchainOver = (data: Buffer): ValuationDeps['onchain'] => {
      const rpc: ExecRpc = {
        async call(method, params) {
          if (method === 'getAccountInfo' && (params as string[])[0] === deriveBondingCurvePda(ca)) {
            return { value: { lamports: 1, owner: PUMP_PROGRAM_ID, data: [data.toString('base64'), 'base64'], executable: false } };
          }
          return { value: null };
        },
      };
      return createOnchainQuoter({ reader: createCurveReader({ rpc }), clock });
    };

    const bag = 50_000_000_000_000n;   // 50 M tokens of 6 decimals
    const usdc = build(clock, { jup: { outAmount: '123456789' } });
    const q = await createValuation({ ...usdc.deps, onchain: onchainOver(curve(USDC)) }).quote(pos(String(bag), ca), false);
    expect(q).toEqual({ sol: 0.123456789, src: 'jupiter', at: START_MS });
    expect(usdc.calls).toEqual([`jupiter:sol:${bag}`]);

    // control: the same reserves quoted in WSOL are valued on-chain from the curve (constant product, pump's 95 + 30 bps fees; FIX-PUMP), and
    // Jupiter is not asked
    const wsol = build(clock, { jup: { outAmount: '123456789' } });
    const q2 = await createValuation({ ...wsol.deps, onchain: onchainOver(curve(WSOL_MINT)) }).quote(pos(String(bag), ca), false);
    const gross = (bag * 30_000_000_000n) / (1_073_000_000_000_000n + bag);
    const net = gross - (gross * 95n + 9_999n) / 10_000n - (gross * 30n + 9_999n) / 10_000n;
    expect(q2).toEqual({ sol: Number(net) / 1e9, src: 'onchain', at: START_MS });
    expect(wsol.calls).toEqual([]);
  });

  it('an empty bag, a broken amount, or a bag too large for jupQuote\'s number gives no quote from that source', async () => {
    const clock = new FakeClock(START_MS);
    const { deps, calls } = build(clock, { onchain: null, jup: { outAmount: '1' } });
    const v = createValuation(deps);
    expect(await v.quote(pos('0'), true)).toBeNull();
    expect(await v.quote(pos('not-a-number'), true)).toBeNull();
    expect(calls).toEqual([]);
    expect(await v.quote(pos('9007199254740993'), false)).toBeNull();
    expect(calls).toEqual(['onchain']);   // Jupiter was skipped: the amount cannot be expressed exactly
  });
});

describe('the exit modules use no non-execution price source', () => {
  it('B3-T05 static: no price-site import or name and no constant SOL price in src/exits (G-S13), none of the GMGN API either (G-S1)', () => {
    const files = [
      ...fs.readdirSync(path.join(BOT_ROOT, 'src', 'exits')).filter(n => n.endsWith('.ts') && !/\.test\.ts$/.test(n)).map(n => `src/exits/${n}`),
    ];
    expect(files.length).toBeGreaterThanOrEqual(7);
    const banned = new RegExp(['dex', 'screener'].join(''), 'i');
    for (const rel of files) {
      const text = fs.readFileSync(path.join(BOT_ROOT, ...rel.split('/')), 'utf8');
      expect(banned.test(text), `${rel} names a third-party price site`).toBe(false);
      expect(CONSTANT_SOL_PRICE_RE.test(text), `${rel} has a constant SOL price`).toBe(false);
      expect(G_S13_RE.test(text), `${rel} matches a banned endpoint`).toBe(false);
    }
    // And the real guards, with NO exemption, over the same files.
    const ctx = new ScanContext(BOT_ROOT);
    for (const id of ['G-S13', 'G-S1'] as const) {
      const res = runGuard(id, { root: BOT_ROOT, exemptions: {}, ctx });
      const mine = res.violations.filter(v => files.includes(v.file));
      expect(mine, formatViolations(mine)).toEqual([]);
    }
  });
});
