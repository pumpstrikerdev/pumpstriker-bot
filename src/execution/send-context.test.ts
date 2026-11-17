/**
 * A-26 send control (send-context.ts): the gate between "signed" and "sent", the impact cap and the error classes.
 * Transactions are built and signed in memory with a throw-away key; nothing is sent anywhere and signatures are
 * generated at runtime (A-20).
 */
import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./jupiter', () => ({ resilientRpcCall: h.rpc }));

import {
  BLOCKHASH_VALIDITY_BLOCKS, constantProductImpactPct, createSendContext, dispatchSigned, enforceImpactCap, ImpactCapError,
  mustStop, OnSignedAbort, PreSignRefusal, RouterSendError, signatureOf, simulationRefusal, type SendContext, type SignedTx,
} from './send-context';

const payer = Keypair.generate();
const other = Keypair.generate();

function tx(signed = true, kp: Keypair = payer): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),   // any 32 bytes: the transaction is never sent
    instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: other.publicKey, lamports: 1_000 })],
  }).compileToV0Message();
  const t = new VersionedTransaction(msg);
  if (signed) t.sign([kp]);
  return t;
}

beforeEach(() => {
  h.rpc.mockReset();
});

describe('send gate (A-26)', () => {
  it('A26 awaits onSigned after signing and before the send, with the signature, the builder bound and the route', async () => {
    const events: string[] = [];
    const t = tx();
    const seen: SignedTx[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ctx = createSendContext({
      onSigned: async (s) => { events.push('onSigned:start'); seen.push(s); await gate; events.push('onSigned:end'); },
    });
    const send = vi.fn(async () => { events.push('send'); return signatureOf(t); });

    const p = dispatchSigned(ctx, t, 'pf-direct', 12_345, send);
    await Promise.resolve();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();            // onSigned has not finished: the send waits for it
    release();
    const out = await p;

    expect(events).toEqual(['onSigned:start', 'onSigned:end', 'send']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ sig: bs58.encode(t.signatures[0]), lastValidBlockHeight: 12_345, route: 'pf-direct' });
    expect(out).toEqual({ sig: seen[0].sig, sent: true });
    expect(ctx.sigs).toEqual([seen[0].sig]);
  });

  it('A26 uses the block height at signing + 151 when the builder gives no bound, and reads the height only then', async () => {
    const heights = vi.fn(async () => 5_000);
    const seen: SignedTx[] = [];
    const onSigned = async (s: SignedTx): Promise<void> => { seen.push(s); };
    const send = async (): Promise<string> => 'sig';

    const noBound = createSendContext({ onSigned }, { blockHeight: heights });
    await dispatchSigned(noBound, tx(), 'jupiter', null, send);
    await dispatchSigned(noBound, tx(), 'jupiter', undefined, send);
    await dispatchSigned(noBound, tx(), 'jupiter', 0, send);                      // a zero bound is no bound
    expect(heights).toHaveBeenCalledTimes(3);
    expect(seen.map((s) => s.lastValidBlockHeight)).toEqual([5_000 + BLOCKHASH_VALIDITY_BLOCKS, 5_151, 5_151]);
    expect(BLOCKHASH_VALIDITY_BLOCKS).toBe(151);

    heights.mockClear();
    await dispatchSigned(noBound, tx(), 'jupiter', 9_999, send);                  // builder's value wins, no RPC
    expect(heights).not.toHaveBeenCalled();
    expect(seen[3].lastValidBlockHeight).toBe(9_999);

    const noCallback = createSendContext({}, { blockHeight: heights });           // no onSigned: the height is not needed
    await dispatchSigned(noCallback, tx(), 'pumpswap-direct', null, send);
    expect(heights).not.toHaveBeenCalled();
  });

  it('A26 the default block-height reader asks the resilient RPC pool for getBlockHeight and fails when it cannot read a height', async () => {
    h.rpc.mockResolvedValueOnce(777);
    const seen: SignedTx[] = [];
    const ctx = createSendContext({ onSigned: async (s) => { seen.push(s); } });
    await dispatchSigned(ctx, tx(), 'pf-direct', null, async () => 'sig');
    expect(h.rpc).toHaveBeenCalledWith('getBlockHeight', [{ commitment: 'confirmed' }]);
    expect(seen[0].lastValidBlockHeight).toBe(777 + 151);

    // unreadable height: nothing is sent, nothing was journalled, and the error is a plain one (the router may try another route)
    h.rpc.mockResolvedValueOnce(null);
    const send = vi.fn(async () => 'sig');
    const cb = vi.fn(async () => {});
    const ctx2 = createSendContext({ onSigned: cb });
    const err = await dispatchSigned(ctx2, tx(), 'pf-direct', null, send).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OnSignedAbort);
    expect(send).not.toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
    expect(ctx2.sigs).toEqual([]);
  });

  it('A26 a throw from onSigned aborts that send: nothing is sent, nothing is recorded, and the call must stop', async () => {
    const boom = new Error('journal write failed');
    const send = vi.fn(async () => 'sig');
    const ctx = createSendContext({ onSigned: async () => { throw boom; } });
    const err = await dispatchSigned(ctx, tx(), 'jupiter', 100, send).catch((e) => e);
    expect(err).toBeInstanceOf(OnSignedAbort);
    expect((err as OnSignedAbort).original).toBe(boom);
    expect(send).not.toHaveBeenCalled();
    expect(ctx.sigs).toEqual([]);
    expect(mustStop(ctx, err)).toBe(true);
  });

  it('A26 buildOnly signs and returns the would-be signature, never calls onSigned or the sender, and records no send', async () => {
    const onSigned = vi.fn(async () => {});
    const send = vi.fn(async () => 'sig');
    const ctx = createSendContext({ buildOnly: true, onSigned });
    const t = tx();
    const out = await dispatchSigned(ctx, t, 'pf-direct', 100, send);
    expect(out).toEqual({ sig: bs58.encode(t.signatures[0]), sent: false });
    expect(ctx.builtSig).toBe(out.sig);
    expect(onSigned).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(ctx.sigs).toEqual([]);
  });

  it('A26 records the signature BEFORE the sender runs (a send that throws may still have reached a validator), in order', async () => {
    const ctx = createSendContext({});
    const t1 = tx();
    const t2 = tx();
    const seenDuringSend: string[][] = [];
    const failing = async (): Promise<string> => { seenDuringSend.push([...ctx.sigs]); throw new Error('All RPCs failed to send transaction'); };
    await expect(dispatchSigned(ctx, t1, 'jupiter', 1, failing)).rejects.toThrow(/All RPCs failed/);
    expect(seenDuringSend[0]).toEqual([signatureOf(t1)]);        // already recorded when the sender ran
    await dispatchSigned(ctx, t2, 'jupiter', 1, async () => 'ok');
    expect(ctx.sigs).toEqual([signatureOf(t1), signatureOf(t2)]);
  });

  it('A26 without a context the gate is a plain send, and an unsigned transaction is refused when there is one', async () => {
    const send = vi.fn(async () => 'plain-sig');
    expect(await dispatchSigned(undefined, tx(false), 'jupiter', null, send)).toEqual({ sig: 'plain-sig', sent: true });
    const ctx = createSendContext({});
    await expect(dispatchSigned(ctx, tx(false), 'jupiter', null, send)).rejects.toThrow(/not signed/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(() => signatureOf(tx(false))).toThrow(/not signed/);
  });

  it('A26 mustStop is true for an onSigned abort and, under singleSend, once a send was attempted - never otherwise', async () => {
    const plain = createSendContext({});
    const single = createSendContext({ singleSend: true });
    expect(mustStop(plain, new Error('x'))).toBe(false);
    expect(mustStop(single, new Error('x'))).toBe(false);                      // singleSend, nothing sent yet: other routes may still run
    expect(mustStop(undefined, new Error('x'))).toBe(false);
    expect(mustStop(plain, new OnSignedAbort(new Error('x')))).toBe(true);
    await dispatchSigned(single, tx(), 'jupiter', 1, async () => 'sig');
    expect(mustStop(single, new Error('x'))).toBe(true);                       // singleSend and a send was attempted
    await dispatchSigned(plain, tx(), 'jupiter', 1, async () => 'sig');
    expect(mustStop(plain, new Error('x'))).toBe(false);                       // without singleSend a later route may still run
  });
});

describe('impact cap (A-26)', () => {
  it('A26 constantProductImpactPct is amount / (reserve + amount) in percent, rounded up to 4 decimals, null on a degenerate reserve', () => {
    expect(constantProductImpactPct(1_000_000n, 1_000_000n)).toBe(50);
    expect(constantProductImpactPct(9_000_000n, 1_000_000n)).toBe(10);
    expect(constantProductImpactPct(30_000_000_000n, 49_500_000n)).toBeCloseTo(0.1648, 4);
    // 1 / 3 -> 33.3333.. rounds UP to 33.3334, so a cap of 33.3333 refuses it
    expect(constantProductImpactPct(2n, 1n)).toBe(33.3334);
    expect(constantProductImpactPct(1_000n, 0n)).toBe(0);
    expect(constantProductImpactPct(0n, 5n)).toBeNull();
    expect(constantProductImpactPct(-1n, 5n)).toBeNull();
    expect(constantProductImpactPct(5n, -1n)).toBeNull();
  });

  it('A26 enforceImpactCap: no cap is a no-op, at or under the cap passes, over the cap or unknown is refused and recorded', () => {
    const none = createSendContext({});
    expect(() => enforceImpactCap(none, 'pf-direct', 99)).not.toThrow();
    expect(() => enforceImpactCap(undefined, 'pf-direct', 99)).not.toThrow();
    expect(none.refusals).toEqual([]);

    const ctx = createSendContext({ maxImpactPct: 15 });
    enforceImpactCap(ctx, 'pf-direct', 15);                                   // exactly the cap passes
    enforceImpactCap(ctx, 'pumpswap-direct', 0.4);
    expect(ctx.passed).toEqual(['pf-direct', 'pumpswap-direct']);

    const over = (() => { try { enforceImpactCap(ctx, 'jupiter', 15.0001); } catch (e) { return e; } return null; })();
    expect(over).toBeInstanceOf(ImpactCapError);
    expect((over as ImpactCapError).capPct).toBe(15);
    expect((over as ImpactCapError).refused).toEqual([{ route: 'jupiter', impactPct: 15.0001 }]);
    expect((over as Error).message).toMatch(/15\.00%.*cap|cap.*15\.00%/);

    for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => enforceImpactCap(ctx, 'jupiter', bad)).toThrow(ImpactCapError);   // fail closed: an unmeasurable impact is refused
    }
    expect(ctx.refusals).toHaveLength(4);
    expect(ctx.refusals[1]).toEqual({ route: 'jupiter', impactPct: null });
  });

  it('A26 createSendContext rejects an unusable cap and accepts 0', () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, '15' as unknown as number]) {
      expect(() => createSendContext({ maxImpactPct: bad })).toThrow(RangeError);
    }
    expect(createSendContext({ maxImpactPct: 0 }).maxImpactPct).toBe(0);
    expect(createSendContext({}).maxImpactPct).toBeNull();
    const zero = createSendContext({ maxImpactPct: 0 });
    expect(() => enforceImpactCap(zero, 'pf-direct', 0)).not.toThrow();
    expect(() => enforceImpactCap(zero, 'pf-direct', 0.0001)).toThrow(ImpactCapError);
  });
});

describe('error classes (A-26)', () => {
  it('A26 RouterSendError carries a copy of the signatures in order; ImpactCapError names the refused routes', () => {
    const sigs = [bs58.encode(Keypair.generate().secretKey.slice(0, 32)), bs58.encode(Keypair.generate().secretKey.slice(0, 32))];
    const e = new RouterSendError('tx reverted', sigs);
    sigs.push('mutated');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('RouterSendError');
    expect(e.message).toBe('tx reverted');
    expect(e.sigs).toHaveLength(2);

    const c = new ImpactCapError(15, [{ route: 'pf-direct', impactPct: 18.25 }, { route: 'jupiter', impactPct: null }]);
    expect(c).toBeInstanceOf(Error);
    expect(c.name).toBe('ImpactCapError');
    expect(c.message).toContain('pf-direct 18.25%');
    expect(c.message).toContain('jupiter impact unknown');
    expect(c.message).toContain('nothing was sent');
  });

  it('A26 OnSignedAbort keeps the callback error and a redacted message', () => {
    const secret = randomBytes(12).toString('hex');   // runtime-generated (A-20)
    const original = new Error(`write failed https://rpc.example.invalid/?api-key=${secret}`);
    const a = new OnSignedAbort(original);
    expect(a.original).toBe(original);
    expect(a.message).not.toContain(secret);
    const ctx: SendContext = createSendContext({});
    expect(mustStop(ctx, a)).toBe(true);
  });
});

describe('FIX-BUY a simulation that fails refuses before signing', () => {
  it('FIXBUY-T09 simulationRefusal: the System log of 2jeX is not-enough-SOL with both amounts; the other errors say what failed; every text says nothing was paid', () => {
    // 2jeX (2026-11-06): the wrap transfer of 0.1 SOL found 0.0875 SOL left after the fee and the wSOL account rent
    const logs = [
      'Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL success',
      'Program 11111111111111111111111111111111 invoke [1]',
      'Transfer: insufficient lamports 87517263, need 100000000',
      'Program 11111111111111111111111111111111 failed: custom program error: 0x1',
    ];
    const r = simulationRefusal({ InstructionError: [3, { Custom: 1 }] }, logs);
    expect(r).toBeInstanceOf(PreSignRefusal);
    expect(r).toBeInstanceOf(Error);
    expect(r.name).toBe('PreSignRefusal');
    expect(r).toMatchObject({ kind: 'insufficient-sol', needLamports: 100_000_000n, haveLamports: 87_517_263n });
    expect(r.message).toContain('needs 0.1000 SOL');
    expect(r.message).toContain('only 0.0875 SOL');
    expect(r.message).toMatch(/Nothing was sent; no fee was paid\.$/);
    // a program's own log line that imitates the System program is not read as one (only the exact runtime line counts)
    expect(simulationRefusal({ InstructionError: [5, { Custom: 1 }] }, ['Program log: Transfer: insufficient lamports 1, need 2']).kind).toBe('simulation-failed');

    const fee = simulationRefusal('InsufficientFundsForFee', null);
    expect(fee).toMatchObject({ kind: 'insufficient-sol', needLamports: null, haveLamports: null });
    expect(fee.message).toMatch(/network fee/);
    expect(simulationRefusal({ InsufficientFundsForRent: { account_index: 0 } }, [])).toMatchObject({ kind: 'insufficient-sol', message: expect.stringMatching(/rent/) });
    expect(simulationRefusal('AccountNotFound', undefined)).toMatchObject({ kind: 'insufficient-sol', message: expect.stringMatching(/no SOL/) });

    // a route too heavy for the runtime maximum, and any other failure (slippage, a program error): refused, not classified as SOL
    const heavy = simulationRefusal({ InstructionError: [8, 'ComputationalBudgetExceeded'] }, []);
    expect(heavy.kind).toBe('simulation-failed');
    expect(heavy.message).toMatch(/1,400,000 compute units/);
    const slip = simulationRefusal({ InstructionError: [4, { Custom: 6001 }] }, ['Program log: Error: slippage']);
    expect(slip.kind).toBe('simulation-failed');
    expect(slip.message).toContain('{"InstructionError":[4,{"Custom":6001}]}');
    expect(slip.message).toMatch(/Nothing was sent; no fee was paid\.$/);
    // the error text is redacted and bounded like every other reason (B40 rule 4)
    const key = randomBytes(16).toString('hex');
    const leaky = simulationRefusal({ odd: `https://rpc.example.invalid/?api-key=${key} ${'x'.repeat(500)}` }, []);
    expect(leaky.message).not.toContain(key);
    expect(leaky.message).toMatch(/Nothing was sent; no fee was paid\.$/);
    // every text fits the 200 characters a Telegram error reply shows (bot.ts errText), the 2jeX one included
    for (const m of [r, fee, heavy, slip, leaky].map((x) => x.message)) expect(m.length, m).toBeLessThanOrEqual(200);
  });
});
