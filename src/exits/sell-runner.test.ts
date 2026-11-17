/**
 * sell-runner tests: one sell attempt (A-28 / A-29 / A-59). The router is a stub that counts sends; the chain is a stub for
 * `getSignatureStatuses` and the token balance.
 */
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import type { SellFill } from '../bot-contracts';
import { FakeClock } from '../link/clock';
import { RouterSendError } from '../execution/send-context';
import type { RouterOpts, RouterResult } from '../execution/router';
import type { SignatureStatus } from './failure-policy';
import { runSellAttempt, sigsOfError, type SellAttemptInput, type SellRunnerDeps } from './sell-runner';
import { START_MS, newSig } from './exits-testkit';

const kp = Keypair.generate();
const MINT = Keypair.generate().publicKey.toBase58();

function fill(sold: bigint, net = 100_000_000n): SellFill {
  return { solOutNetLamports: net.toString(), solOutGrossLamports: (net + 5000n).toString(), tokensSoldRaw: sold.toString(), feeLamports: '5000', confirmedAt: START_MS + 1 };
}

type Send = (opts: RouterOpts, n: number) => Promise<RouterResult> | RouterResult;

function harness(o: { sends: Send[]; fills?: Record<string, SellFill | 'unverified'>; statuses?: Record<string, SignatureStatus | null>; balance?: { rawAtoms: number } | null }) {
  const calls: Array<{ tokens: bigint; opts: RouterOpts }> = [];
  const statusCalls: string[][] = [];
  const clock = new FakeClock(START_MS);
  const deps: SellRunnerDeps = {
    clock,
    log: () => undefined,
    async smartSell(_k, _m, tokens, opts = {}) {
      calls.push({ tokens, opts });
      const f = o.sends[Math.min(calls.length - 1, o.sends.length - 1)];
      return f(opts, calls.length - 1);
    },
    fills: { async buyFill() { return 'unverified'; }, async sellFill(sig) { return o.fills?.[sig] ?? 'unverified'; } },
    chain: {
      async signatureStatuses(sigs) { statusCalls.push([...sigs]); return sigs.map(s => o.statuses?.[s] ?? null); },
      async tokenBalance() { return o.balance === undefined ? null : o.balance; },
      async blockHeight() { return 2_000_000; },
    },
  };
  return { deps, calls, statusCalls };
}

const input = (over: Partial<SellAttemptInput> = {}): SellAttemptInput => ({
  owner: kp.publicKey.toBase58(), keypair: kp, mint: MINT, kind: 'protective', attemptNo: 1, tokens: 1000n, trackedAtoms: 1000, sellPct: 100, priorSigs: [],
  slippage: { baseBps: 300, smartMaxBps: 1500 }, ...over,
});

async function signing(opts: RouterOpts, sig: string): Promise<void> {
  await opts.onSigned?.({ sig, lastValidBlockHeight: 99, route: 'pf-direct' });
}

describe('runSellAttempt', () => {
  it('calls the router with singleSend and the step\'s slippage, reports each signature the moment it is signed, and books the fill, not the request', async () => {
    const sig = newSig();
    const h = harness({ sends: [async (opts) => { await signing(opts, sig); return { sig, route: 'pf-direct', slippageBpsUsed: 4000, sent: true, sigs: [sig] }; }], fills: { [sig]: fill(900n) } });
    const seen: string[] = [];
    const r = await runSellAttempt(h.deps, input({ onSignature: s => seen.push(s) }));
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].opts.singleSend).toBe(true);
    expect(h.calls[0].opts.slippageBps).toBe(4000);
    expect(h.calls[0].tokens).toBe(1000n);
    expect(seen).toEqual([sig]);
    expect(r).toMatchObject({ status: 'filled', sig, tokensSold: 900n, via: 'send', slippageBps: 4000 });
    if (r.status === 'filled') expect(r.fill.solOutNetLamports).toBe('100000000');
  });

  it('A-29: a confirmed fill with 0 tokens sold is a reverted or empty fill, a failed step; the next step of the ladder runs after a landed-check', async () => {
    const s1 = newSig();
    const s2 = newSig();
    const h = harness({
      sends: [
        async (opts) => { await signing(opts, s1); return { sig: s1, route: 'pf-direct', slippageBpsUsed: 4000, sent: true, sigs: [s1] }; },
        async (opts) => { await signing(opts, s2); return { sig: s2, route: 'pf-direct', slippageBpsUsed: 9900, sent: true, sigs: [s2] }; },
      ],
      fills: { [s1]: fill(0n, 0n), [s2]: fill(1000n) },
      statuses: { [s1]: { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' } },
      balance: { rawAtoms: 1000 },
    });
    const r = await runSellAttempt(h.deps, input());
    expect(h.calls.map(c => c.opts.slippageBps)).toEqual([4000, 9900]);
    expect(h.statusCalls).toEqual([[s1]]);       // the landed-check on the first signature ran before the panic leg
    expect(r).toMatchObject({ status: 'filled', sig: s2, tokensSold: 1000n, slippageBps: 9900 });
  });

  it('A-59: a RouterSendError carries the signatures; if one of them landed, nothing more is sent and ITS fill is read', async () => {
    const s1 = newSig();
    const h = harness({
      sends: [async (opts) => { await signing(opts, s1); throw new RouterSendError('confirmation timed out', [s1]); }, async () => { throw new Error('must not be called'); }],
      fills: { [s1]: fill(1000n) }, statuses: { [s1]: { err: null, confirmationStatus: 'confirmed' } },
    });
    const r = await runSellAttempt(h.deps, input());
    expect(h.calls).toHaveLength(1);
    expect(r).toMatchObject({ status: 'filled', sig: s1, via: 'landed_check', tokensSold: 1000n });
  });

  it('A-59: an error that is not a RouterSendError sent nothing, so the next step goes ahead without asking the chain', async () => {
    const s2 = newSig();
    const h = harness({
      sends: [async () => { throw new Error('route refused: no usable route'); }, async (opts) => { await signing(opts, s2); return { sig: s2, route: 'jupiter', slippageBpsUsed: 9900, sent: true }; }],
      fills: { [s2]: fill(1000n) },
    });
    const r = await runSellAttempt(h.deps, input());
    expect(h.calls).toHaveLength(2);
    expect(h.statusCalls).toEqual([]);
    expect(r.status).toBe('filled');
  });

  it('a send that resolves but whose meta cannot be read is filled_unconfirmed, never a booked fill', async () => {
    const sig = newSig();
    const h = harness({ sends: [async () => ({ sig, route: 'pf-direct', slippageBpsUsed: 300, sent: true })] });
    const r = await runSellAttempt(h.deps, input({ kind: 'tp' }));
    expect(r).toMatchObject({ status: 'filled_unconfirmed', sig, via: 'fill_unverified' });
  });

  it('every step failing is a failed attempt that lists every signature and a redacted, bounded error', async () => {
    const s1 = newSig();
    const s2 = newSig();
    const secret = `https://rpc.example.test/?api-key=${Keypair.generate().publicKey.toBase58()}`;
    const h = harness({
      sends: [
        async () => { throw new RouterSendError(`send failed ${secret}`, [s1]); },
        async () => { throw new RouterSendError(`send failed ${secret} ${'y'.repeat(500)}`, [s1, s2]); },
      ],
      statuses: { [s1]: { err: { x: 1 }, confirmationStatus: 'confirmed' }, [s2]: null }, balance: { rawAtoms: 1000 },
    });
    const r = await runSellAttempt(h.deps, input());
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.sigs).toEqual([s1, s2]);
      expect(r.error.length).toBeLessThanOrEqual(200);
      expect(r.error).not.toContain(secret.split('api-key=')[1]);
      expect(r.slippageBps).toBe(9900);
    }
  });

  it('a take-profit attempt is ONE send at the attempt\'s escalated slippage', async () => {
    const h = harness({ sends: [async () => { throw new Error('boom'); }], balance: { rawAtoms: 1000 } });
    for (const [attemptNo, bps] of [[1, 300], [2, 900], [3, 1500]] as const) {
      const before = h.calls.length;
      const r = await runSellAttempt(h.deps, input({ kind: 'tp', attemptNo, sellPct: 30 }));
      expect(r.status).toBe('failed');
      expect(h.calls.length - before).toBe(1);
      expect(h.calls[h.calls.length - 1].opts.slippageBps).toBe(bps);
    }
  });

  it('a retry of an attempt whose wallet reads empty and sent nothing is skipped, not sent (the reconcile rule owns it)', async () => {
    const h = harness({ sends: [async () => { throw new Error('must not be called'); }], balance: { rawAtoms: 0 } });
    const r = await runSellAttempt(h.deps, input({ attemptNo: 2 }));
    expect(r).toMatchObject({ status: 'skipped', reason: 'zero_balance' });
    expect(h.calls).toHaveLength(0);
  });

  it('after a restart, signatures that were signed but never resolved are checked before anything is sent', async () => {
    const prior = newSig();
    const h = harness({
      sends: [async () => { throw new Error('must not be called'); }],
      statuses: { [prior]: { err: null, confirmationStatus: 'finalized' } }, fills: { [prior]: fill(400n) },
    });
    const r = await runSellAttempt(h.deps, input({ priorSigs: [prior], tokens: 400n }));
    expect(h.calls).toHaveLength(0);
    expect(r).toMatchObject({ status: 'filled', sig: prior, via: 'landed_check', tokensSold: 400n });
  });

  it('a landed-check that only sees the balance drop reports filled_unconfirmed with the balance', async () => {
    const prior = newSig();
    const h = harness({ sends: [async () => { throw new Error('must not be called'); }], balance: { rawAtoms: 300 } });
    const r = await runSellAttempt(h.deps, input({ priorSigs: [prior], attemptNo: 2 }));
    expect(r).toMatchObject({ status: 'filled_unconfirmed', via: 'balance', balanceRaw: 300, sig: prior });
  });

  it('a router that built but did not send is a failed step (it must never count as a sell)', async () => {
    const sig = newSig();
    const h = harness({ sends: [async () => ({ sig, route: 'pf-direct', slippageBpsUsed: 1, sent: false })] });
    const r = await runSellAttempt(h.deps, input({ kind: 'tp' }));
    expect(r.status).toBe('failed');
  });

  it('nothing to sell sends nothing', async () => {
    const h = harness({ sends: [async () => { throw new Error('must not be called'); }] });
    expect(await runSellAttempt(h.deps, input({ tokens: 0n }))).toMatchObject({ status: 'skipped', reason: 'nothing_to_sell' });
  });
});

describe('sigsOfError', () => {
  it('reads the signatures of a RouterSendError and nothing from any other error', () => {
    const s = newSig();
    expect(sigsOfError(new RouterSendError('x', [s]))).toEqual([s]);
    expect(sigsOfError(new Error('x'))).toEqual([]);
    expect(sigsOfError(null)).toEqual([]);
    expect(sigsOfError({ sigs: [1, 'a', ''] })).toEqual(['a']);
  });
});
