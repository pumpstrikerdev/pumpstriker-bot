/**
 * B40 fills (exact deltas and the 60 s unverified window). Fakes only: a stub RPC that returns the fixture metas of test-fixtures/execution and a fake
 * clock, so the 60 s unreadable-meta window runs in zero real time. Signatures are generated at runtime (A-20).
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import bs58 from 'bs58';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  ATA_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT,
  type ExecClock, type ExecRpc,
} from './exec-common';
import { computeTxDeltas, createFillReader, FILL_META_TIMEOUT_MS, FILL_POLL_MS, waitForTransaction } from './fills';

const FIXTURES = path.resolve(__dirname, '..', '..', 'test-fixtures', 'execution');
const key = (n: number): string => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const OWNER = key(1);
const MINT = key(2);

const VARS: Record<string, string> = {
  OWNER, MINT, ATA: key(3), CURVE: key(4), CURVE_ATA: key(5), PUMP_FEE: key(6), TIP: key(7), PORTAL_FEE: key(8), POOL: key(9),
  POOL_BASE: key(10), POOL_QUOTE: key(11), FEE_VAULT: key(12), WSOL_ATA: key(13),
  SYSTEM: SystemProgram.programId.toBase58(), TOKEN_PROGRAM: TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM: TOKEN_2022_PROGRAM_ID,
  PUMP_PROGRAM: PUMP_PROGRAM_ID, AMM_PROGRAM: PUMPSWAP_PROGRAM_ID, ATA_PROGRAM: ATA_PROGRAM_ID,
  COMPUTE_BUDGET: COMPUTE_BUDGET_PROGRAM_ID, WSOL_MINT,
};

function loadMeta(name: string): any {
  const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  return JSON.parse(raw.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, k: string) => {
    const v = VARS[k];
    if (v === undefined) throw new Error(`fixture placeholder ${k} has no value`);
    return v;
  }));
}

/** A transaction signature, generated at runtime (never a committed literal). */
const newSig = (): string => bs58.encode(randomBytes(64));

class FakeClock implements ExecClock {
  t = 5_000_000;
  now(): number { return this.t; }
  async sleep(ms: number): Promise<void> { this.t += ms; }
}

function rpcReturning(result: () => unknown, calls: unknown[][] = []): ExecRpc {
  return {
    async call(method: string, params: unknown[]): Promise<any> {
      calls.push([method, ...params]);
      return result();
    },
  };
}

describe('fills: fixture metas to exact deltas', () => {
  it('B4-T01 fixture metas (Token, Token-2022, wSOL closed in the tx) give the exact lamport and token deltas', async () => {
    const calls: unknown[][] = [];
    const sig = newSig();

    // 1) classic-Token buy (pf-direct): 0.05 SOL + ATA rent 2,039,280 + fee 6,000 + tip 200,000 leave the owner.
    const classic = loadMeta('meta-buy-token-classic.json');
    const r1 = createFillReader({ rpc: rpcReturning(() => classic, calls), clock: new FakeClock() });
    expect(await r1.buyFill(sig, OWNER, MINT)).toEqual({
      solSpentLamports: '52245280', tokensRaw: '1700000000', feeLamports: '6000', confirmedAt: 1_760_000_000_000,
    });
    // the request is exactly the one B40 rule 1 names
    expect(calls[0]).toEqual(['getTransaction', sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);

    // 2) Token-2022 buy built by PumpPortal: 0.10 SOL + fee transfer 500,000 + Token-2022 ATA rent 2,074,080 + fee 105,000.
    const t22 = loadMeta('meta-buy-token2022.json');
    const r2 = createFillReader({ rpc: rpcReturning(() => t22), clock: new FakeClock() });
    expect(await r2.buyFill(sig, OWNER, MINT)).toEqual({
      solSpentLamports: '102679080', tokensRaw: '3300000000', feeLamports: '105000', confirmedAt: 1_760_000_100_000,
    });

    // 3) PumpSwap sell with the wSOL account created and closed inside the transaction (token accounts come from
    //    meta.loadedAddresses): net = +79,785,000 after the 15,000 fee and the 200,000 tip; gross adds the fee back.
    const sell = loadMeta('meta-sell-wsol-closed.json');
    const r3 = createFillReader({ rpc: rpcReturning(() => sell), clock: new FakeClock() });
    expect(await r3.sellFill(sig, OWNER, MINT)).toEqual({
      solOutNetLamports: '79785000', solOutGrossLamports: '79800000', tokensSoldRaw: '5000000000', feeLamports: '15000', confirmedAt: 1_760_000_200_000,
    });

    // the wSOL balance of the same owner (other mint) and the pool's balances (other owner) never leak into the token delta
    const sellWithWsol = loadMeta('meta-sell-wsol-closed.json');
    sellWithWsol.meta.preTokenBalances.push({
      accountIndex: 8, mint: WSOL_MINT, owner: OWNER, programId: TOKEN_PROGRAM_ID,
      uiTokenAmount: { amount: '123456789', decimals: 9, uiAmount: 0.12, uiAmountString: '0.123456789' },
    });
    const d = computeTxDeltas(sellWithWsol, OWNER, MINT);
    expect(d?.tokenDelta).toBe(-5_000_000_000n);
    expect(d?.lamportsDelta).toBe(79_785_000n);

    // jsonParsed account keys (objects) give the same result as plain keys
    const parsed = loadMeta('meta-buy-token-classic.json');
    parsed.transaction.message.accountKeys = parsed.transaction.message.accountKeys.map((k: string) => ({ pubkey: k, signer: false, writable: true }));
    const r4 = createFillReader({ rpc: rpcReturning(() => parsed), clock: new FakeClock() });
    expect(await r4.buyFill(sig, OWNER, MINT)).toMatchObject({ solSpentLamports: '52245280', tokensRaw: '1700000000' });

    // a transaction that failed on-chain books only what the chain says: no tokens, only the fee spent
    const failed = loadMeta('meta-buy-token-classic.json');
    failed.meta.err = { InstructionError: [3, 'Custom'] };
    failed.meta.postBalances = [...failed.meta.preBalances];
    failed.meta.postBalances[0] = failed.meta.preBalances[0] - failed.meta.fee;
    failed.meta.postTokenBalances = failed.meta.postTokenBalances.filter((b: any) => b.owner !== OWNER);
    const r5 = createFillReader({ rpc: rpcReturning(() => failed), clock: new FakeClock() });
    expect(await r5.buyFill(sig, OWNER, MINT)).toMatchObject({ solSpentLamports: '6000', tokensRaw: '0', feeLamports: '6000' });
  });

  it('B4-T02 a meta that stays unreadable for 60 s gives unverified (the caller reports PnL null, quoted, unverified)', async () => {
    const sig = newSig();

    // never indexed: getTransaction answers null for the whole window
    const clock = new FakeClock();
    const start = clock.now();
    let polls = 0;
    const reader = createFillReader({ rpc: rpcReturning(() => { polls++; return null; }), clock });
    expect(await reader.buyFill(sig, OWNER, MINT)).toBe('unverified');
    expect(clock.now() - start).toBe(FILL_META_TIMEOUT_MS);   // gave up exactly at the 60 s mark, in fake time
    expect(FILL_META_TIMEOUT_MS).toBe(60_000);
    expect(polls).toBe(Math.floor(FILL_META_TIMEOUT_MS / FILL_POLL_MS) + 1);

    // an RPC that throws the whole time is also unreadable, never an exception
    const clock2 = new FakeClock();
    const throwing: ExecRpc = { call: async () => { throw new Error('boom'); } };
    expect(await createFillReader({ rpc: throwing, clock: clock2 }).sellFill(sig, OWNER, MINT)).toBe('unverified');
    expect(clock2.now() - 5_000_000).toBe(FILL_META_TIMEOUT_MS);

    // a meta that arrives late but inside the window is still booked (59 s)
    const clock3 = new FakeClock();
    const classic = loadMeta('meta-buy-token-classic.json');
    const late = createFillReader({ rpc: { call: async () => (clock3.now() - 5_000_000 >= 59_000 ? classic : null) }, clock: clock3 });
    expect(await late.buyFill(sig, OWNER, MINT)).toMatchObject({ solSpentLamports: '52245280' });

    // a meta without the owner among the account keys, or with a broken balance array, is unreadable too
    const wrong = loadMeta('meta-buy-token-classic.json');
    const other = createFillReader({ rpc: rpcReturning(() => wrong), clock: new FakeClock() });
    expect(await other.buyFill(sig, key(77), MINT)).toBe('unverified');
    const broken = loadMeta('meta-buy-token-classic.json');
    broken.meta.postBalances = broken.meta.postBalances.slice(0, 3);
    expect(await createFillReader({ rpc: rpcReturning(() => broken), clock: new FakeClock() }).buyFill(sig, OWNER, MINT)).toBe('unverified');
  });

  it('waitForTransaction returns a transaction view as soon as its meta is readable and null for an empty signature', async () => {
    const classic = loadMeta('meta-buy-token-classic.json');
    const clock = new FakeClock();
    const rpc = rpcReturning(() => classic);
    expect(await waitForTransaction(rpc, clock, newSig(), 1000, 100)).toBe(classic);
    expect(clock.now()).toBe(5_000_000);   // no sleep needed
    expect(await waitForTransaction(rpc, clock, '', 1000, 100)).toBeNull();
  });
});
