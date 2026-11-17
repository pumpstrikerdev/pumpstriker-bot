/**
 * Unit tests for the UnclaimedSol partner module (9, the Sep 25 count).
 * REBUILD-CHOSEN: the original test file is lost; cases follow WI-A §6.
 * No network: the Connection is a stub and the HTTP client is mocked.
 */
import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

vi.mock('../lib/http-client', () => ({
  fetch: vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })),
}));

import { ucsFeeForAccount, summarizeClaim, scanClaimableAccounts } from './unclaimedsol';

const TOKEN_PROGRAM      = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WSOL_MINT          = 'So11111111111111111111111111111111111111112';
const RENT               = 2_039_280;   // standard 165-byte token account

interface AcctOpts { mint?: string; amount?: string; lamports?: number; isNative?: boolean; state?: string }

function acct(o: AcctOpts = {}) {
  const amount = o.amount ?? '0';
  return {
    pubkey: Keypair.generate().publicKey,
    account: {
      lamports: o.lamports ?? RENT,
      executable: false,
      owner: new PublicKey(TOKEN_PROGRAM),
      data: {
        program: 'spl-token',
        space: 165,
        parsed: {
          type: 'account',
          info: {
            mint: o.mint ?? Keypair.generate().publicKey.toBase58(),
            owner: 'OWNER',
            isNative: o.isNative ?? false,
            state: o.state ?? 'initialized',
            tokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) },
          },
        },
      },
    },
  };
}

/** Stub Connection: per-program account lists, or an Error to reject with. */
function stubConn(byProgram: { classic?: any[] | Error; t22?: any[] | Error }) {
  return {
    getParsedTokenAccountsByOwner: vi.fn(async (_owner: PublicKey, filter: { programId: PublicKey }) => {
      const key = filter.programId.toBase58() === TOKEN_2022_PROGRAM ? 't22' : 'classic';
      const v = byProgram[key] ?? [];
      if (v instanceof Error) throw v;
      return { context: { slot: 1 }, value: v };
    }),
  } as any;
}

const owner = Keypair.generate().publicKey;

describe('ucsFeeForAccount', () => {
  it('July/SDK rule (0 bps): user keeps 0.002 SOL, fee = rent above the cap', () => {
    expect(ucsFeeForAccount(RENT, 0)).toBe(39_280);
  });

  it('current rule (200 bps): the published 2,039,280 → fee 40,785 example', () => {
    const fee = ucsFeeForAccount(RENT, 200);
    expect(fee).toBe(40_785);
    expect(RENT - fee).toBe(1_998_495);
  });

  it('0 / negative / NaN lamports give 0, and the fee never exceeds the lamports', () => {
    expect(ucsFeeForAccount(0)).toBe(0);
    expect(ucsFeeForAccount(-5)).toBe(0);
    expect(ucsFeeForAccount(NaN)).toBe(0);
    expect(ucsFeeForAccount(1_000, 20_000)).toBe(1_000);   // 200% bps clamps to lamports
    expect(ucsFeeForAccount(5_000, 0, 0)).toBe(5_000);     // keep cap 0 → everything is fee
  });
});

describe('summarizeClaim', () => {
  it('totals mixed pairs: keep = total − fee, count and dustCount', () => {
    const s = summarizeClaim([
      { lamports: RENT, dust: false },
      { lamports: RENT, dust: true },
      { lamports: 1_000_000, dust: false },
    ]);
    expect(s.count).toBe(3);
    expect(s.dustCount).toBe(1);
    expect(s.totalLamports).toBe(2 * RENT + 1_000_000);
    expect(s.feeLamports).toBe(40_785 + 40_785 + 20_000);
    expect(s.keepLamports).toBe(s.totalLamports - s.feeLamports);
    for (const v of Object.values(s)) expect(Number.isInteger(v)).toBe(true);
  });

  it('empty input gives all zeros', () => {
    expect(summarizeClaim([])).toEqual({ count: 0, dustCount: 0, totalLamports: 0, feeLamports: 0, keepLamports: 0 });
  });
});

describe('scanClaimableAccounts', () => {
  it('includeDust=false returns only zero-balance accounts, from BOTH token programs', async () => {
    const conn = stubConn({
      classic: [acct({ amount: '0' }), acct({ amount: '123' })],
      t22:     [acct({ amount: '0', lamports: 2_074_080 })],
    });
    const pairs = await scanClaimableAccounts(conn, owner, false);
    expect(conn.getParsedTokenAccountsByOwner).toHaveBeenCalledTimes(2);
    expect(pairs).toHaveLength(2);
    expect(pairs.every(p => !p.dust && p.amountRaw === '0')).toBe(true);
    expect(pairs.map(p => p.programId.toBase58()).sort()).toEqual([TOKEN_2022_PROGRAM, TOKEN_PROGRAM].sort());
    expect(pairs[0].lamports).toBe(2_074_080);   // sorted by lamports desc
  });

  it('includeDust=true adds the non-empty accounts with dust:true, after the empty ones', async () => {
    const conn = stubConn({
      classic: [acct({ amount: '5000000', lamports: 3_000_000 }), acct({ amount: '0' })],
      t22:     [acct({ amount: '1' })],
    });
    const pairs = await scanClaimableAccounts(conn, owner, true);
    expect(pairs).toHaveLength(3);
    expect(pairs[0].dust).toBe(false);
    expect(pairs[0].amountRaw).toBe('0');
    expect(pairs.slice(1).every(p => p.dust)).toBe(true);
    expect(pairs[1].lamports).toBe(3_000_000);   // dust group sorted by lamports desc
    expect(pairs[1].uiAmount).toBe(5);
  });

  it('skips wSOL / isNative and frozen accounts', async () => {
    const conn = stubConn({
      classic: [
        acct({ mint: WSOL_MINT }),
        acct({ isNative: true }),
        acct({ state: 'frozen' }),
        acct({ lamports: 0 }),
        acct({ amount: '0' }),
      ],
    });
    const pairs = await scanClaimableAccounts(conn, owner, true);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].mint.toBase58()).not.toBe(WSOL_MINT);
  });

  it('one program failing still returns the other; both failing throws without leaking the RPC URL', async () => {
    const leaky = new Error('failed to get token accounts: https://rpc.example.invalid/?token=REDACTED 429');
    const half = await scanClaimableAccounts(stubConn({ classic: leaky, t22: [acct()] }), owner, false);
    expect(half).toHaveLength(1);
    expect(half[0].programId.toBase58()).toBe(TOKEN_2022_PROGRAM);

    const err = await scanClaimableAccounts(stubConn({ classic: leaky, t22: leaky }), owner, true).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toMatch(/https?:\/\//);
    expect(err.message).not.toMatch(/token=|REDACTED|example\.invalid/);
  });
});
