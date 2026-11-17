/**
 * R7-W6 (A-99; design 6.8 and rev 3 R3-2): the wallet link handler. The pipeline (strict request validators, the internal budgets, the response
 * validators) and the owner's limits that are enforced again on the built answer: slippage, price impact, the optional spend cap, the SOL balance,
 * the amount the owner typed, the transaction size and the compute-unit price range. The HTTP side (auth, 400s, the route table) is routes.test.ts.
 *
 * Everything runs on ONE FakeClock; keys, signatures and transaction bytes are generated at run time (A-20); no socket, no RPC.
 */
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { describe, expect, it, vi } from 'vitest';
import { createRpcBudget } from '../execution/rpc-budget';
import type { WalletRpcPort } from '../execution/wallet-rpc';
import { FakeClock } from '../link/clock';
import type {
  WalletBalancesRequest, WalletCloseFillRequest, WalletCloseQuoteLink, WalletCloseQuoteRequest, WalletFillRequest, WalletFindRequest, WalletLinkRefusal,
  WalletQuoteLink, WalletQuoteRequest,
} from '../shared/contract/wallet-link';
import { WALLET_LINK_BUDGET_MS } from '../shared/contract/wallet-link';
import {
  FRESH_BUY_GRACE_MS, createWalletLinkHandler, createWalletLinkOps, type WalletLinkHandlerDeps, type WalletLinkLimits, type WalletLinkOps, type WalletLinkResult,
  type WalletOpControl,
} from './handler';

// The two builders are replaced by recorders for the tests of the assembly; the chain reads (balances, find, fills) stay the real ones.
const mocked = vi.hoisted(() => ({
  swap: [] as Array<{ deps: any; req: any }>, close: [] as Array<{ deps: any; req: any }>,
  swapAnswer: null as null | ((req: any) => unknown), closeAnswer: null as null | ((req: any) => unknown),
}));
vi.mock('../execution/unsigned-swap', async importOriginal => {
  const real = await importOriginal<typeof import('../execution/unsigned-swap')>();
  return { ...real, buildUnsignedSwap: vi.fn(async (deps: any, req: any) => { mocked.swap.push({ deps, req }); return mocked.swapAnswer!(req); }) };
});
vi.mock('../execution/unsigned-close', async importOriginal => {
  const real = await importOriginal<typeof import('../execution/unsigned-close')>();
  return { ...real, buildUnsignedClose: vi.fn(async (deps: any, req: any) => { mocked.close.push({ deps, req }); return mocked.closeAnswer!(req); }) };
});

const NOW = 1_800_000_000_000;
const key = (i: number): string => bs58.encode(crypto.createHash('sha256').update(`ps-fixture-${i}`).digest());
const newSig = (): string => bs58.encode(crypto.randomBytes(64));
const OWNER = key(0);
const MINT = key(1);
const PROGRAM = key(2);
const LIMITS: WalletLinkLimits = { txMaxBytes: 1100, priorityMinMicrolamports: 10_000, priorityMaxMicrolamports: 1_000_000 };

function buyRequest(over: Partial<WalletQuoteRequest> = {}): WalletQuoteRequest {
  return { owner: OWNER, side: 'buy', mint: MINT, amountLamports: '50000000', slippageBps: 3000, maxImpactPct: 15, maxSpendLamports: null, feeLevel: 'normal', maxTxBytes: 1100, ...over };
}
function sellRequest(over: Partial<WalletQuoteRequest> = {}): WalletQuoteRequest {
  return { owner: OWNER, side: 'sell', mint: MINT, tokensRaw: '2500000', slippageBps: 3000, maxImpactPct: 15, maxSpendLamports: null, feeLevel: 'normal', maxTxBytes: 1100, ...over };
}

interface QuoteOpts { impactPct?: number | null; balance?: string; cuPrice?: number; txBytes?: number; exactOut?: boolean; slippageBps?: number; mint?: string; maxOutflow?: string }
/** A quote that passes every rule of the link contract for the request (the tests then bend one value at a time). */
function makeQuote(req: WalletQuoteRequest, o: QuoteOpts = {}): WalletQuoteLink {
  const buy = req.side === 'buy';
  const mint = o.mint ?? req.mint;
  const cuPrice = o.cuPrice ?? 50_000;
  const cuLimit = 200_000;
  const priorityLamports = String((BigInt(cuLimit) * BigInt(cuPrice) + 999_999n) / 1_000_000n);
  const rent = buy ? 2_039_280n : 0n;
  const amount = buy ? (req.amountLamports as string) : (req.tokensRaw ?? '2500000');
  const sol = (n: string): { baseUnits: string; decimals: number; asset: string } => ({ baseUnits: n, decimals: 9, asset: 'SOL' });
  const tok = (n: string): { baseUnits: string; decimals: number; asset: string } => ({ baseUnits: n, decimals: 6, asset: mint });
  const spend = o.exactOut ? 60_000_000n : buy ? BigInt(amount) : 0n;
  const txBytes = o.txBytes ?? 600;
  const q: WalletQuoteLink = {
    route: o.exactOut ? 'pumpswap' : 'pump', side: req.side, mint,
    bound: o.exactOut ? { kind: 'exact_out', exactOut: tok('1000000'), maxIn: sol('60000000') }
      : buy ? { kind: 'exact_in', amountIn: sol(amount), minOut: tok('700000') } : { kind: 'exact_in', amountIn: tok(amount), minOut: sol('4000000') },
    maxOutflowLamports: o.maxOutflow ?? String(spend + 5000n + BigInt(priorityLamports) + rent),
    quotedOut: o.exactOut ? null : buy ? tok('1000000') : sol('5000000'), quotedIn: o.exactOut ? sol('50000000') : null,
    impactPct: o.impactPct === undefined ? 2.5 : o.impactPct, slippageBps: o.slippageBps ?? req.slippageBps,
    simulatedDeltas: buy ? { sol: sol('-' + String(spend)), token: tok('1000000') } : { sol: sol('5000000'), token: tok('-' + amount) },
    networkFeeLamports: '5000', priorityFee: { cuLimit, cuPriceMicrolamports: cuPrice, lamports: priorityLamports }, innerFees: [], thirdPartyTransfers: [],
    rentLamports: String(rent), programs: [PROGRAM], txBytes, txBase64: crypto.randomBytes(txBytes).toString('base64'), minContextSlot: 250_000_000,
    quotedAt: NOW, simulatedAt: NOW, builtAt: NOW, balance: { lamports: o.balance ?? '10000000000', readAt: NOW, slot: 250_000_001 }, routingNotes: [],
  };
  return q;
}

function closeRequest(over: Partial<WalletCloseQuoteRequest> = {}): WalletCloseQuoteRequest {
  return { owner: OWNER, kind: 'empty', excluded: [], ...over };
}
function makeCloseQuote(accounts: string[], over: Partial<WalletCloseQuoteLink> = {}): WalletCloseQuoteLink {
  const txBytes = 400;
  return {
    kind: 'empty', accounts: accounts.map(a => ({ account: a, mint: MINT, program: 'token' as const, rentLamports: '2039280' })), excluded: [], remainingAccounts: 0,
    returnedLamports: String(2_039_280 * accounts.length), wsolAmount: null, networkFeeLamports: '5000', priorityFee: { cuLimit: 100_000, cuPriceMicrolamports: 50_000, lamports: '5000' },
    maxOutflowLamports: '10000', simulatedDeltas: { sol: { baseUnits: String(2_039_280 * accounts.length - 10_000), decimals: 9, asset: 'SOL' } }, programs: [PROGRAM],
    txBytes, txBase64: crypto.randomBytes(txBytes).toString('base64'), minContextSlot: 250_000_000, simulatedAt: NOW, builtAt: NOW, ...over,
  };
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

interface Recorder { calls: Array<{ route: string; req: unknown; ctl: WalletOpControl }> }
function makeOps(over: Partial<WalletLinkOps> = {}): { ops: WalletLinkOps; rec: Recorder } {
  const rec: Recorder = { calls: [] };
  const ops: WalletLinkOps = {
    async quote(req, ctl) { rec.calls.push({ route: 'quote', req, ctl }); return { ok: true, quote: makeQuote(req) }; },
    async fill(req, ctl) {
      rec.calls.push({ route: 'fill', req, ctl });
      return { ok: true, fill: { status: 'confirmed', reason: null, solDeltaLamports: '-52044280', feeLamports: '15000', rentPaidLamports: '2039280', tokenDeltaRaw: '1000000', decimals: 6, slot: 250_000_010, blockTime: NOW } };
    },
    async find(req, ctl) { rec.calls.push({ route: 'find', req, ctl }); return { ok: true, signatures: [] }; },
    async balances(req, ctl) { rec.calls.push({ route: 'balances', req, ctl }); return { ok: true, balances: { solLamports: '1500000000', tokens: [], readAt: NOW, slot: 250_000_002 } }; },
    async closeQuote(req, ctl) { rec.calls.push({ route: 'closeQuote', req, ctl }); return { ok: true, quote: makeCloseQuote([key(10)]) }; },
    async closeFill(req, ctl) {
      rec.calls.push({ route: 'closeFill', req, ctl });
      return { ok: true, fill: { status: 'confirmed', reason: null, solDeltaLamports: '2024280', feeLamports: '15000', rentReturnedLamports: '2039280', slot: 250_000_011, blockTime: NOW } };
    },
    ...over,
  };
  return { ops, rec };
}

function setup(over: Partial<WalletLinkOps> = {}, deps: Partial<WalletLinkHandlerDeps> = {}) {
  const clock = new FakeClock(NOW);
  const logs: string[] = [];
  const { ops, rec } = makeOps(over);
  const handler = createWalletLinkHandler({ clock, ops, limits: LIMITS, log: m => { logs.push(m); }, ...deps });
  return { clock, handler, rec, logs };
}

type Body = Record<string, any>;
const bodyOf = (r: WalletLinkResult): Body => r.body as Body;
/** A refusal carries a code and a reason and nothing else: no quote, no transaction bytes. */
function expectRefusalOnly(r: WalletLinkResult): void {
  expect(Object.keys(bodyOf(r)).filter(k => k !== 'needLamports' && k !== 'haveLamports').sort()).toEqual(['code', 'ok', 'reason']);
  expect(bodyOf(r).ok).toBe(false);
}

describe('the pipeline', () => {
  it('a valid quote passes both validators and reaches the caller as the validated copy; the operation sees the transaction size capped by the configuration', async () => {
    const { handler, rec } = setup();
    const req = buyRequest({ maxTxBytes: 1132 });
    const r = await handler.handle('quote', req);
    expect(r.status).toBe(200);
    expect(bodyOf(r).ok).toBe(true);
    expect(bodyOf(r).quote.mint).toBe(MINT);
    expect(bodyOf(r).quote.slippageBps).toBe(3000);
    expect(rec.calls).toHaveLength(1);
    expect((rec.calls[0].req as WalletQuoteRequest).maxTxBytes, 'WALLET_TX_MAX_BYTES wins over a larger request').toBe(1100);
    expect(rec.calls[0].ctl.budgetMs).toBe(12_000);
    expect(rec.calls[0].ctl.signal.aborted).toBe(false);
  });

  it('the internal budgets are the design values and an override replaces one', () => {
    const { handler } = setup({}, { budgetMs: { find: 5_000 } });
    expect(handler.budgetOf('quote')).toBe(12_000);
    expect(handler.budgetOf('fill')).toBe(60_000);
    expect(handler.budgetOf('find')).toBe(5_000);
    expect(handler.budgetOf('balances')).toBe(8_000);
    expect(handler.budgetOf('closeQuote')).toBe(10_000);
    expect(handler.budgetOf('closeFill')).toBe(60_000);
    for (const [route, b] of Object.entries(WALLET_LINK_BUDGET_MS)) expect(b.bot, `${route} answers inside the Engine's relay timeout`).toBeLessThan(b.relay);
  });

  it('an invalid body is a 400 that never echoes input and never reaches the operation', async () => {
    const { handler, rec } = setup();
    const planted = `planted-${crypto.randomBytes(6).toString('hex')}`;
    const bad: unknown[] = [null, 'x', [], {}, { ...buyRequest(), [planted]: 1 }, { ...buyRequest(), owner: planted }, { ...buyRequest(), amountLamports: '0.5' }, { ...buyRequest(), slippageBps: 5001 }];
    for (const b of bad) {
      const r = await handler.handle('quote', b);
      expect(r.status).toBe(400);
      expect(bodyOf(r)).toMatchObject({ ok: false, code: 'bad-request' });
      expect(JSON.stringify(r.body)).not.toContain(planted);
    }
    expect(rec.calls).toHaveLength(0);
  });

  it('the log holds the route, the verdict and the time, never an address, an amount or a key', async () => {
    const { handler, logs } = setup();
    await handler.handle('quote', buyRequest());
    await handler.handle('balances', { owner: OWNER });
    await handler.handle('quote', { nonsense: true });
    expect(logs.length).toBe(3);
    const printed = logs.join('\n');
    expect(printed).toContain('wallet link quote: ok');
    expect(printed).toContain('wallet link balances: ok');
    expect(printed).toContain('wallet link quote: bad-request');
    for (const secret of [OWNER, MINT, '50000000', PROGRAM]) expect(printed).not.toContain(secret);
  });
});

describe('the owner limits are enforced again on the built answer', () => {
  it('slippage: the default 30 percent and a per-trade value pass; bytes that encode another slippage than the request are verify-failed', async () => {
    for (const bps of [3000, 1, 5000, 250]) {
      const { handler } = setup();
      const r = await handler.handle('quote', buyRequest({ slippageBps: bps }));
      expect(bodyOf(r), `slippage ${bps}`).toMatchObject({ ok: true });
      expect(bodyOf(r).quote.slippageBps).toBe(bps);
    }
    const { handler } = setup({ quote: async req => ({ ok: true, quote: makeQuote(req, { slippageBps: 4000 }) }) });
    const r = await handler.handle('quote', buyRequest({ slippageBps: 3000 }));
    expect(bodyOf(r)).toMatchObject({ ok: false, code: 'verify-failed' });
    expectRefusalOnly(r);
  });

  it('FIXR7-T02 an unknown price impact is refused (impact-above-limit, no bytes) whatever the limit, as the server path refuses it (A-26)', async () => {
    const unknown = setup({ quote: async req => ({ ok: true, quote: makeQuote(req, { impactPct: null }) }) });
    for (const maxImpactPct of [15, 50]) {
      const r = await unknown.handler.handle('quote', buyRequest({ maxImpactPct }));
      expect(bodyOf(r)).toMatchObject({ ok: false, code: 'impact-above-limit' });
      expect(bodyOf(r).reason).toMatch(/no price impact/);
      expectRefusalOnly(r);
    }
  });

  it('price impact: a route above maxImpactPct is impact-above-limit with no bytes, a higher limit lets the same quote through', async () => {
    const hot = async (req: WalletQuoteRequest): Promise<{ ok: true; quote: WalletQuoteLink }> => ({ ok: true, quote: makeQuote(req, { impactPct: 20 }) });
    const { handler } = setup({ quote: hot });
    const refused = await handler.handle('quote', buyRequest({ maxImpactPct: 15 }));
    expect(bodyOf(refused)).toMatchObject({ ok: false, code: 'impact-above-limit' });
    expect(Object.keys(bodyOf(refused)).sort()).toEqual(['code', 'ok', 'reason']);
    expect(bodyOf(refused).reason).toMatch(/20%.*15%/);
    expect(bodyOf(await handler.handle('quote', buyRequest({ maxImpactPct: 25 })))).toMatchObject({ ok: true });
    expect(bodyOf(await handler.handle('quote', buyRequest({ maxImpactPct: 20 }))), 'equal to the limit passes').toMatchObject({ ok: true });
  });

  it('the optional spend cap: null is no cap at all, a cap below the maximum spend is amount-above-cap, an equal cap passes, an exact-out bound counts its maximum in', async () => {
    const { handler } = setup();
    expect(bodyOf(await handler.handle('quote', buyRequest({ amountLamports: '9000000000', maxSpendLamports: null })))).toMatchObject({ ok: true });
    expect(bodyOf(await handler.handle('quote', buyRequest({ amountLamports: '50000000', maxSpendLamports: '49999999' })))).toMatchObject({ ok: false, code: 'amount-above-cap' });
    expect(bodyOf(await handler.handle('quote', buyRequest({ amountLamports: '50000000', maxSpendLamports: '50000000' })))).toMatchObject({ ok: true });
    const out = setup({ quote: async req => ({ ok: true, quote: makeQuote(req, { exactOut: true }) }) });
    expect(bodyOf(await out.handler.handle('quote', buyRequest({ maxSpendLamports: '59999999' })))).toMatchObject({ ok: false, code: 'amount-above-cap' });
    expect(bodyOf(await out.handler.handle('quote', buyRequest({ maxSpendLamports: '60000000' })))).toMatchObject({ ok: true });
    // a sell spends no SOL on the swap: the cap does not apply to it
    expect(bodyOf(await handler.handle('quote', sellRequest({ maxSpendLamports: '1' })))).toMatchObject({ ok: true });
  });

  it('insufficient-sol: what the transaction can take above the balance read in the same build is refused with the two exact strings; equal passes', async () => {
    const need = String(50_000_000n + 5000n + 10_000n + 2_039_280n);
    const low = setup({ quote: async req => ({ ok: true, quote: makeQuote(req, { balance: String(BigInt(need) - 1n) }) }) });
    const r = await low.handler.handle('quote', buyRequest());
    expect(bodyOf(r)).toEqual({ ok: false, code: 'insufficient-sol', reason: expect.any(String), needLamports: need, haveLamports: String(BigInt(need) - 1n) });
    const equal = setup({ quote: async req => ({ ok: true, quote: makeQuote(req, { balance: need }) }) });
    expect(bodyOf(await equal.handler.handle('quote', buyRequest()))).toMatchObject({ ok: true });
    // above 2^53: the strings stay exact
    const big = '18446744073709551615';
    const huge = setup({ quote: async req => ({ ok: true, quote: makeQuote(req, { balance: '9007199254740993', maxOutflow: big }) }) });
    expect(bodyOf(await huge.handler.handle('quote', buyRequest()))).toMatchObject({ code: 'insufficient-sol', needLamports: big, haveLamports: '9007199254740993' });
  });

  it('the bytes spend the amount the owner typed, for the mint and side asked, with a compute-unit price in the configured range', async () => {
    const wrongMint = setup({ quote: async req => ({ ok: true, quote: makeQuote(req, { mint: key(7) }) }) });
    expect(bodyOf(await wrongMint.handler.handle('quote', buyRequest()))).toMatchObject({ ok: false, code: 'verify-failed' });
    const wrongAmount = setup({ quote: async req => ({ ok: true, quote: makeQuote({ ...req, amountLamports: '50000001' }) }) });
    const amount = await wrongAmount.handler.handle('quote', buyRequest());
    expect(bodyOf(amount)).toMatchObject({ ok: false, code: 'verify-failed' });
    expect(bodyOf(amount).reason).toMatch(/another amount/);
    const wrongTokens = setup({ quote: async req => ({ ok: true, quote: makeQuote({ ...req, tokensRaw: '2500001' }) }) });
    expect(bodyOf(await wrongTokens.handler.handle('quote', sellRequest()))).toMatchObject({ ok: false, code: 'verify-failed' });
    for (const cuPrice of [9_999, 1_000_001]) {
      const range = setup({ quote: async req => ({ ok: true, quote: makeQuote(req, { cuPrice }) }) });
      // 1_000_001 is already refused by the contract validator, 9_999 by the configured range: both never leave the bot
      expect(bodyOf(await range.handler.handle('quote', buyRequest())), `price ${cuPrice}`).toMatchObject({ ok: false, code: 'verify-failed' });
    }
    for (const cuPrice of [10_000, 1_000_000]) {
      const range = setup({ quote: async req => ({ ok: true, quote: makeQuote(req, { cuPrice }) }) });
      expect(bodyOf(await range.handler.handle('quote', buyRequest())), `price ${cuPrice}`).toMatchObject({ ok: true });
    }
    // a sell with a share of the balance (pctBps) carries the amount the bot read: nothing to compare, the rest still applies
    const pct = setup();
    expect(bodyOf(await pct.handler.handle('quote', { ...sellRequest(), tokensRaw: undefined, pctBps: 5000 }))).toMatchObject({ ok: true });
  });

  it('tx-too-large: a transaction above WALLET_TX_MAX_BYTES is refused even when the request allows more, and one at the limit passes', async () => {
    const big = setup({ quote: async req => ({ ok: true, quote: makeQuote(req, { txBytes: 1101 }) }) });
    const r = await big.handler.handle('quote', buyRequest({ maxTxBytes: 1132 }));
    expect(bodyOf(r)).toMatchObject({ ok: false, code: 'tx-too-large' });
    expectRefusalOnly(r);
    const edge = setup({ quote: async req => ({ ok: true, quote: makeQuote(req, { txBytes: 1100 }) }) });
    expect(bodyOf(await edge.handler.handle('quote', buyRequest({ maxTxBytes: 1132 })))).toMatchObject({ ok: true });
    const asked = setup({ quote: async req => ({ ok: true, quote: makeQuote(req, { txBytes: 900 }) }) });
    expect(bodyOf(await asked.handler.handle('quote', buyRequest({ maxTxBytes: 800 })))).toMatchObject({ ok: false, code: 'tx-too-large' });
  });
});

describe('answers of the operations', () => {
  it('a refusal of the operation passes through validated; an unknown code or a surplus field is verify-failed', async () => {
    const refusals: WalletLinkRefusal[] = [
      { ok: false, code: 'nothing-to-sell', reason: 'the wallet holds none of this token' },
      { ok: false, code: 'price-moved', reason: 'the simulation hit the slippage bound' },
      { ok: false, code: 'wsol-balance-present', reason: 'Unwrap your wSOL first' },
      { ok: false, code: 'insufficient-sol', reason: 'short', needLamports: '100', haveLamports: '99' },
      { ok: false, code: 'rpc-budget', reason: 'the wallet RPC budget for today is used up' },
    ];
    for (const refusal of refusals) {
      const { handler } = setup({ quote: async () => refusal });
      const r = await handler.handle('quote', buyRequest());
      expect(r.status).toBe(200);
      expect(bodyOf(r)).toEqual(refusal);
    }
    const unknownCode = setup({ quote: async () => ({ ok: false, code: 'because-i-said-so', reason: 'x' }) as unknown as WalletLinkRefusal });
    expect(bodyOf(await unknownCode.handler.handle('quote', buyRequest()))).toMatchObject({ ok: false, code: 'verify-failed' });
    const surplus = setup({ quote: async () => ({ ok: false, code: 'no-route', reason: 'x', secret: 'y' }) as unknown as WalletLinkRefusal });
    expect(bodyOf(await surplus.handler.handle('quote', buyRequest()))).toMatchObject({ ok: false, code: 'verify-failed' });
    const needOnly = setup({ quote: async () => ({ ok: false, code: 'insufficient-sol', reason: 'x', needLamports: '5' }) as unknown as WalletLinkRefusal });
    expect(bodyOf(await needOnly.handler.handle('quote', buyRequest()))).toMatchObject({ ok: false, code: 'verify-failed' });
  });

  it('a quote with a surplus key, a bad bound for its route or a short maxOutflow never leaves the bot (verify-failed, no bytes)', async () => {
    const bends: Array<(q: WalletQuoteLink) => unknown> = [
      q => ({ ...q, extra: 1 }),
      q => ({ ...q, route: 'jupiter', bound: { kind: 'exact_out', exactOut: { baseUnits: '1', decimals: 6, asset: q.mint }, maxIn: { baseUnits: '1', decimals: 9, asset: 'SOL' } } }),
      q => ({ ...q, maxOutflowLamports: '1' }),
      q => ({ ...q, txBytes: q.txBytes + 1 }),
      q => ({ ...q, priorityFee: { ...q.priorityFee, lamports: '1' } }),
    ];
    for (const bend of bends) {
      const { handler } = setup({ quote: async req => ({ ok: true, quote: bend(makeQuote(req)) as WalletQuoteLink }) });
      const r = await handler.handle('quote', buyRequest());
      expect(bodyOf(r)).toMatchObject({ ok: false, code: 'verify-failed' });
      expectRefusalOnly(r);
    }
  });

  it('an error thrown by the operation is build-failed with a redacted one-line reason of at most 200 characters; the wallet RPC budget keeps its code', async () => {
    const apiKey = crypto.randomUUID();
    const err = new Error(`getBalance failed for https://mainnet.helius-rpc.com/?api-key=${apiKey}\n${'x'.repeat(400)}`);
    const { handler } = setup({ quote: async () => { throw err; } });
    const r = await handler.handle('quote', buyRequest());
    expect(r.status).toBe(200);
    expect(bodyOf(r)).toMatchObject({ ok: false, code: 'build-failed' });
    expect(JSON.stringify(r.body)).not.toContain(apiKey);
    expect(bodyOf(r).reason.length).toBeLessThanOrEqual(200);
    expect(bodyOf(r).reason).not.toMatch(/[\n\r]/);
    const budget = setup({ quote: async () => { throw Object.assign(new Error('wallet RPC daily cap reached'), { code: 'rpc-budget' }); } });
    expect(bodyOf(await budget.handler.handle('quote', buyRequest()))).toMatchObject({ ok: false, code: 'rpc-budget' });
    const thrownString = setup({ quote: async () => Promise.reject('plain text failure') });
    expect(bodyOf(await thrownString.handler.handle('quote', buyRequest()))).toMatchObject({ ok: false, code: 'build-failed', reason: 'plain text failure' });
  });

  it('an operation that answers after the budget changes nothing, and its late failure raises no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      let rejectLate!: (e: Error) => void;
      const late = new Promise<never>((_, reject) => { rejectLate = reject; });
      const { clock, handler, rec } = setup({ quote: () => late });
      const pending = handler.handle('quote', buyRequest());
      await clock.advance(12_000);
      const r = await pending;
      expect(bodyOf(r)).toMatchObject({ ok: false, code: 'build-timeout' });
      expect(rec.calls).toHaveLength(0);
      rejectLate(new Error('too late'));
      await clock.advance(1_000);
      await clock.settle();
      expect(unhandled).toEqual([]);
      expect(bodyOf(r)).toMatchObject({ ok: false, code: 'build-timeout' });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('the other routes', () => {
  it('close-quote: a close of an account the Engine excluded, of one that was not asked for, or of another kind is verify-failed; a clean one passes', async () => {
    const [a, b, c] = [key(20), key(21), key(22)];
    const answer = (accounts: string[], over: Partial<WalletCloseQuoteLink> = {}) => async (): Promise<{ ok: true; quote: WalletCloseQuoteLink }> => ({ ok: true, quote: makeCloseQuote(accounts, over) });
    const ok = setup({ closeQuote: answer([a, b]) });
    const good = await ok.handler.handle('closeQuote', closeRequest({ accounts: [a, b, c], excluded: [c] }));
    expect(bodyOf(good)).toMatchObject({ ok: true });
    const excluded = setup({ closeQuote: answer([a, c]) });
    expect(bodyOf(await excluded.handler.handle('closeQuote', closeRequest({ excluded: [c] })))).toMatchObject({ ok: false, code: 'verify-failed' });
    const unasked = setup({ closeQuote: answer([a, b]) });
    expect(bodyOf(await unasked.handler.handle('closeQuote', closeRequest({ accounts: [a] })))).toMatchObject({ ok: false, code: 'verify-failed' });
    const wrongKind = setup({ closeQuote: answer([a], { kind: 'unwrap', wsolAmount: '1000' }) });
    expect(bodyOf(await wrongKind.handler.handle('closeQuote', closeRequest({ kind: 'empty' })))).toMatchObject({ ok: false, code: 'verify-failed' });
    const cheap = setup({ closeQuote: answer([a], { priorityFee: { cuLimit: 100_000, cuPriceMicrolamports: 5_000, lamports: '500' }, maxOutflowLamports: '10000' }) });
    expect(bodyOf(await cheap.handler.handle('closeQuote', closeRequest()))).toMatchObject({ ok: false, code: 'verify-failed' });
    const tooBig = setup({ closeQuote: answer([a], { txBytes: 1101, txBase64: crypto.randomBytes(1101).toString('base64') }) });
    expect(bodyOf(await tooBig.handler.handle('closeQuote', closeRequest()))).toMatchObject({ ok: false, code: 'tx-too-large' });
  });

  it('a fill read that fails or runs out of budget is unverified with nothing booked; the wallet RPC budget is a refusal; a final fill reaches the operation', async () => {
    const fillReq: WalletFillRequest = { owner: OWNER, signature: newSig(), side: 'buy', mint: MINT, quoteRef: 'q_ref-1', submittedAt: NOW - 1000, final: true };
    const thrown = setup({ fill: async () => { throw new Error('getTransaction returned garbage'); } });
    const r = await thrown.handler.handle('fill', fillReq);
    expect(bodyOf(r)).toEqual({
      ok: true,
      fill: { status: 'unverified', reason: expect.stringContaining('garbage'), solDeltaLamports: null, feeLamports: null, rentPaidLamports: null, tokenDeltaRaw: null, decimals: null, slot: null, blockTime: null },
    });
    const slow = setup({ fill: () => never() });
    const pending = slow.handler.handle('fill', fillReq);
    await slow.clock.advance(59_999);
    let settled = false;
    void pending.then(() => { settled = true; });
    await slow.clock.settle();
    expect(settled, 'still inside the 60 s budget').toBe(false);
    await slow.clock.advance(1);
    expect(bodyOf(await pending)).toMatchObject({ ok: true, fill: { status: 'unverified', solDeltaLamports: null, feeLamports: null, tokenDeltaRaw: null } });
    const budget = setup({ fill: async () => { throw Object.assign(new Error('over budget'), { code: 'rpc-budget' }); } });
    expect(bodyOf(await budget.handler.handle('fill', fillReq))).toMatchObject({ ok: false, code: 'rpc-budget' });
    const seen = setup();
    await seen.handler.handle('fill', fillReq);
    expect((seen.rec.calls[0].req as WalletFillRequest).final).toBe(true);
    expect(seen.rec.calls[0].ctl.budgetMs).toBe(60_000);
    const closeReq: WalletCloseFillRequest = { owner: OWNER, signature: newSig(), submittedAt: NOW - 1000, final: false };
    const closeThrown = setup({ closeFill: async () => { throw new Error('no meta'); } });
    expect(bodyOf(await closeThrown.handler.handle('closeFill', closeReq))).toMatchObject({ ok: true, fill: { status: 'unverified', rentReturnedLamports: null } });
  });

  it('find and balances: a read that runs out of budget is build-timeout (never an empty list or a zero); a valid answer passes', async () => {
    const findReq: WalletFindRequest = { owner: OWNER, mint: MINT, side: 'buy', sinceSlot: 250_000_000 };
    const balReq: WalletBalancesRequest = { owner: OWNER };
    const find = setup({ find: () => never() });
    const pf = find.handler.handle('find', findReq);
    await find.clock.advance(12_000);
    expect(bodyOf(await pf)).toMatchObject({ ok: false, code: 'build-timeout' });
    const bal = setup({ balances: () => never() });
    const pb = bal.handler.handle('balances', balReq);
    await bal.clock.advance(8_000);
    const timedOut = await pb;
    expect(bodyOf(timedOut)).toMatchObject({ ok: false, code: 'build-timeout' });
    expect(JSON.stringify(timedOut.body)).not.toMatch(/solLamports|tokens/);
    const sigs = [newSig(), newSig(), newSig()];
    const found = setup({ find: async () => ({ ok: true, signatures: sigs }) });
    expect(bodyOf(await found.handler.handle('find', findReq))).toEqual({ ok: true, signatures: sigs });
    const four = setup({ find: async () => ({ ok: true, signatures: [...sigs, newSig()] }) });
    expect(bodyOf(await four.handler.handle('find', findReq))).toMatchObject({ ok: false, code: 'verify-failed' });
  });
});

// ── the operations assembled from the R7-W5 modules ───────────────────────────────────────────────────────────────────────

interface FakeNode { port: WalletRpcPort; calls: Array<{ method: string; at: number }>; answers: Map<string, (params: unknown[]) => unknown> }
function fakeNode(clock: FakeClock): FakeNode {
  const calls: FakeNode['calls'] = [];
  const answers: FakeNode['answers'] = new Map();
  const defaults: Record<string, () => unknown> = {
    getBalance: () => ({ context: { slot: 7 }, value: 5_000_000_000 }),
    getTokenAccountsByOwner: () => ({ context: { slot: 7 }, value: [] }),
    getTransaction: () => null,
    getSignatureStatuses: () => ({ context: { slot: 7 }, value: [null] }),
  };
  return {
    calls, answers,
    port: {
      async call(method, params) {
        calls.push({ method, at: clock.now() });
        const make = answers.get(method) ?? defaults[method];
        if (!make) throw new Error(`method not scripted: ${method}`);
        return make(params);
      },
    },
  };
}
const SETTINGS = { txMaxBytes: 1100, priorityMinMicrolamports: 10_000, priorityMaxMicrolamports: 1_000_000, fillPollMs: 2000 };
const control = (budgetMs: number, signal: AbortSignal = new AbortController().signal): WalletOpControl => ({ budgetMs, deadlineAt: NOW + budgetMs, signal });

describe('the operations assembled from the wallet modules', () => {
  it('a quote gets its own budgeted port, the configured range and size and the request budget; the test-only PumpSwap route and a custom Jupiter build are never set', async () => {
    mocked.swap.length = 0;
    mocked.swapAnswer = req => ({ ok: true, quote: makeQuote(req as WalletQuoteRequest) });
    const clock = new FakeClock(NOW);
    const node = fakeNode(clock);
    const ops = createWalletLinkOps({ rpc: node.port, budget: createRpcBudget({}, clock), clock, settings: { ...SETTINGS, txMaxBytes: 1000, priorityMinMicrolamports: 20_000, priorityMaxMicrolamports: 300_000 } });
    const req = buyRequest();
    const answer = await ops.quote(req, control(12_000));
    expect(answer).toMatchObject({ ok: true });
    expect(mocked.swap).toHaveLength(1);
    const { deps, req: seen } = mocked.swap[0];
    expect(seen).toEqual(req);
    expect(Object.keys(deps).sort()).toEqual(['budgetMs', 'cache', 'clock', 'maxTxBytes', 'priorityRange', 'rpc']);
    expect(deps.budgetMs).toBe(12_000);
    expect(deps.maxTxBytes).toBe(1000);
    expect(deps.priorityRange).toEqual({ minPrice: 20_000, maxPrice: 300_000 });
    expect('testOnlyPumpSwapRoute' in deps).toBe(false);
    expect('jupBuild' in deps).toBe(false);
    // the port the builder got is the request's own: its calls reach the node through the wallet budget
    await deps.rpc.call('getBalance', [OWNER]);
    expect(node.calls.map(c => c.method)).toEqual(['getBalance']);
  });

  it('a close leaves the token account of a mint quoted for a buy in the last 90 s alone, for that owner only; a sell quote does not count', async () => {
    mocked.swap.length = 0;
    mocked.close.length = 0;
    mocked.swapAnswer = req => ({ ok: true, quote: makeQuote(req as WalletQuoteRequest) });
    mocked.closeAnswer = () => ({ ok: false, code: 'nothing-to-close', reason: 'stub' });
    const clock = new FakeClock(NOW);
    const ops = createWalletLinkOps({ rpc: fakeNode(clock).port, budget: createRpcBudget({}, clock), clock, settings: SETTINGS });
    const other = key(5);
    const bought = key(6);
    await ops.quote(buyRequest({ mint: bought }), control(12_000));
    await ops.quote(sellRequest({ mint: key(7) }), control(12_000));
    const freshAt = async (owner: string): Promise<(mint: string) => boolean> => {
      await ops.closeQuote({ owner, kind: 'empty', excluded: [] }, control(10_000));
      return mocked.close[mocked.close.length - 1].deps.freshBuy;
    };
    const mine = await freshAt(OWNER);
    expect(mine(bought)).toBe(true);
    expect(mine(key(7)), 'a sell quote is not a fresh buy').toBe(false);
    expect(mine(key(8))).toBe(false);
    expect((await freshAt(other))(bought), 'another owner').toBe(false);
    await clock.advance(FRESH_BUY_GRACE_MS - 1);
    expect((await freshAt(OWNER))(bought)).toBe(true);
    await clock.advance(1);
    expect((await freshAt(OWNER))(bought), 'the grace is over after 90 s').toBe(false);
    // a refused buy quote leaves nothing behind
    mocked.swapAnswer = () => ({ ok: false, code: 'no-route', reason: 'stub' });
    await ops.quote(buyRequest({ mint: key(9) }), control(12_000));
    expect((await freshAt(OWNER))(key(9))).toBe(false);
  });

  it('every call of a request counts against the wallet budget of its owner: past the daily cap the answer is the rpc-budget refusal', async () => {
    const clock = new FakeClock(NOW);
    const node = fakeNode(clock);
    const ops = createWalletLinkOps({ rpc: node.port, budget: createRpcBudget({ dailyCallCap: 2, maxPerSec: 10 }, clock), clock, settings: SETTINGS });
    // a balance read takes three calls (the SOL balance and the two token programs): the third is over the cap
    const answer = await ops.balances({ owner: OWNER }, control(8_000));
    expect(answer).toMatchObject({ ok: false, code: 'rpc-budget' });
    expect(node.calls.length).toBeLessThanOrEqual(2);
  });

  it('once the request budget is over no further call reaches the node and an abandoned fill poll stops sleeping', async () => {
    const clock = new FakeClock(NOW);
    const node = fakeNode(clock);
    const ops = createWalletLinkOps({ rpc: node.port, budget: createRpcBudget({ maxPerSec: 1 }, clock), clock, settings: SETTINGS });
    const abort = new AbortController();
    const fillReq: WalletFillRequest = { owner: OWNER, signature: newSig(), side: 'buy', mint: MINT, quoteRef: 'q_ref-1', submittedAt: NOW, final: false };
    const outcome: { value?: unknown; error?: unknown } = {};
    const pending = ops.fill(fillReq, control(60_000, abort.signal)).then(v => { outcome.value = v; }, e => { outcome.error = e; });
    await clock.advance(0);
    await clock.settle();
    expect(node.calls.map(c => c.method)).toEqual(['getTransaction']);       // the first look; the poll now sleeps for 2 s
    abort.abort();
    await clock.advance(10_000);
    await pending;
    expect((outcome.error as { code?: string } | undefined)?.code, 'the sleeping poll ended with the cancellation').toBe('aborted');
    expect(node.calls.map(c => c.method), 'no call after the abort').toEqual(['getTransaction']);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('balances, find and the fills read through the same budgeted port; a final fill with nothing on the node is not-landed', async () => {
    const clock = new FakeClock(NOW);
    const node = fakeNode(clock);
    node.answers.set('getSignaturesForAddress', () => []);
    const ops = createWalletLinkOps({ rpc: node.port, budget: createRpcBudget({ maxPerSec: 10 }, clock), clock, settings: SETTINGS });
    expect(await ops.balances({ owner: OWNER }, control(8_000))).toMatchObject({ ok: true, balances: { solLamports: '5000000000', tokens: [] } });
    expect(await ops.find({ owner: OWNER, mint: MINT, side: 'buy', sinceSlot: 5 }, control(12_000))).toEqual({ ok: true, signatures: [] });
    const fillReq: WalletFillRequest = { owner: OWNER, signature: newSig(), side: 'buy', mint: MINT, quoteRef: 'q_ref-1', submittedAt: NOW, final: true };
    expect(await ops.fill(fillReq, control(60_000))).toMatchObject({ ok: true, fill: { status: 'not-landed' } });
    expect(await ops.closeFill({ owner: OWNER, signature: newSig(), submittedAt: NOW, final: true }, control(60_000))).toMatchObject({ ok: true, fill: { status: 'not-landed' } });
    const methods = new Set(node.calls.map(c => c.method));
    for (const m of methods) expect(['getBalance', 'getTokenAccountsByOwner', 'getSignaturesForAddress', 'getTransaction', 'getSignatureStatuses']).toContain(m);
  });
});
