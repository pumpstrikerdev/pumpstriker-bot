/**
 * B50 section 3 (R4-B6): the wiring. B6-T05 (the removed /signal route), B6-T06 (the boot log holds no secret) and the cases that prove
 * the pieces are connected the way the plan says: a signal reaches the Telegram card with auto-buy OFF and nothing is sent; the dry-run
 * path opens a virtual position through the positions adapter (a missing quote opens none); the exit engine's sells feed auto-buy and
 * tell the owner; the manual trader (the buy and sell buttons) books fills, not quotes. The scripts' tests (B6-T04, B6-T08 ... B6-T12)
 * are at the end: vitest only collects src/**, so they load the two scripts by path.
 *
 * Everything runs on ONE FakeClock (A-10) over stubs: no socket except the 127.0.0.1 server a test starts on port 0, no Telegram, no RPC,
 * no Jupiter. Keys, secrets, signatures and addresses are generated at run time (A-20).
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { BuyFill, EngineClient, FillReader, SellFill } from './bot-contracts';
import {
  BRAND, boot, canonicalLamports, createBotApp, createManualTrader, manualPositionId, ownerLineOf, rpcProviderLabel,
  type AppSettings, type AppWallet, type AppWallets, type BotApp, type BotAppDeps, type ManualTraderDeps,
} from './app';
import { makeHarness, StubRouter } from './autobuy/autobuy-testkit';
import { buildConfig } from './config';
import { FakeClock } from './link/clock';
import { HEARTBEAT_MS } from './link/engine-outbox';
import {
  cleanupTempDirs, fixture, FakeEngine, FakeTelegram, FIXTURE_NOW, freshEvent, MemoryOutbox, newCa, newTestUlid, tempDir,
} from './link/link-testkit';
import { createPositionsStore } from './exits/positions-store';
import { createSellMutex, sellKey } from './exits/failure-policy';
import { makeWorld, START_MS } from './exits/exits-testkit';
import { evaluateTsl } from './exits/manual-orders';
import { RouterSendError } from './execution/send-context';
import { CONTRACT_VERSION, type ArmsStatusPayload, type BotToEngineEvent, type Envelope, type SignalNew } from './shared/contract/v1';
import { WALLET_LINK_PATHS, type WalletLinkRoute } from './shared/contract/wallet-link';
import { MANUAL_BUYS_FILE } from './exits/manual-buy-journal';
import { ScanContext, importClosure, runAllGuards, runGuard } from './guards/guard-lib';
import type { WalletLinkOps } from './wallet-link/handler';

const newSig = (): string => bs58.encode(crypto.randomBytes(64));

// ── the world ────────────────────────────────────────────────────────────────────────────────────

const WALLET_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(5));   // a fixed TEST key, never a real one
const WALLET: AppWallet = { walletId: 'w1', owner: WALLET_KEYPAIR.publicKey.toBase58(), keypair: WALLET_KEYPAIR };
const wallets: AppWallets = {
  current: () => WALLET,
  get: id => (id === WALLET.walletId ? WALLET : null),
  byOwner: owner => (owner === WALLET.owner ? WALLET : null),
};

interface Settings extends AppSettings { state: { buySol: number; dupe: boolean; tgMinGrade: 'A' | 'B' | 'C' } }
function makeSettings(): Settings {
  const state = { buySol: 0.01, dupe: false, tgMinGrade: 'B' as 'A' | 'B' | 'C' };
  return {
    state,
    buySol: () => state.buySol, autoBuySlippageBps: () => 300, priorityFee: () => 100_000, antiMev: () => false, tgMinGrade: () => state.tgMinGrade,
    sessionOk: () => true, slippage: () => ({ baseBps: 300, smartMaxBps: 1500 }), duplicateBuy: () => state.dupe,
  };
}

interface World {
  clock: FakeClock;
  dir: string;
  tg: FakeTelegram;
  engine: FakeEngine;
  router: StubRouter;
  settings: Settings;
  logs: string[];
  secrets: string[];
  linkSecret: string;
  deps: BotAppDeps;
  /** SOL per token atom the scripted on-chain quote answers with, per CA (undefined = no quote). */
  price: Map<string, number>;
  balances: Map<string, bigint>;
  sellFills: Map<string, SellFill>;
  buyFill: { next: BuyFill | 'unverified' };
  sells: Array<{ mint: string; tokens: bigint; opts: Record<string, unknown> }>;
  closes: Array<{ owner: string; mint: string }>;
}

function build(over: Partial<BotAppDeps> = {}, envOver: Record<string, string> = {}): World {
  const clock = new FakeClock(FIXTURE_NOW);
  const dir = tempDir('ps-app-');
  const linkSecret = crypto.randomBytes(32).toString('base64url');
  const botToken = `${crypto.randomInt(100_000_000, 999_999_999)}:AA${crypto.randomBytes(24).toString('base64url')}`;
  const encKey = crypto.randomBytes(32).toString('base64url');
  const heliusKey = crypto.randomUUID();
  const env = {
    NODE_ENV: 'test', BOT_PORT: '0', TG_CHAT_ID: '4242', TG_BOT_TOKEN: botToken, SIGNAL_SHARED_SECRET: linkSecret, WALLET_ENC_KEY: encKey,
    HELIUS_KEY: heliusKey, ENGINE_URL: 'http://127.0.0.1:9', ...envOver,
  };
  const router = new StubRouter(clock);
  const tg = new FakeTelegram(clock);
  const engine = new FakeEngine();
  const settings = makeSettings();
  const price = new Map<string, number>();
  const balances = new Map<string, bigint>();
  const sellFills = new Map<string, SellFill>();
  const buyFill: World['buyFill'] = { next: 'unverified' };
  const sells: World['sells'] = [];
  const closes: World['closes'] = [];
  const logs: string[] = [];

  const fills: FillReader = {
    async buyFill() { return buyFill.next; },
    async sellFill(sig) { return sellFills.get(sig) ?? 'unverified'; },
  };
  const deps: BotAppDeps = {
    config: buildConfig(env), env, dataDir: dir, telegram: tg, wallets, settings, clock, http: engine.http,
    log: (m, l) => { logs.push(`${l ?? 'info'}: ${m}`); },
    smartBuy: router.smartBuy,
    smartSell: async (_kp, mint, tokensIn, opts) => {
      const sig = newSig();
      sells.push({ mint, tokens: tokensIn, opts: { ...(opts ?? {}) } });
      await opts?.onSigned?.({ sig, lastValidBlockHeight: 1_150, route: 'pf-direct' });
      const have = balances.get(mint) ?? 0n;
      const sold = tokensIn < have ? tokensIn : have;
      balances.set(mint, have - sold);
      const gross = BigInt(Math.round((price.get(mint) ?? 0) * Number(sold) * 1e9));
      sellFills.set(sig, { solOutNetLamports: (gross - 5000n).toString(), solOutGrossLamports: gross.toString(), tokensSoldRaw: sold.toString(), feeLamports: '5000', confirmedAt: clock.now() });
      return { sig, route: 'pf-direct', slippageBpsUsed: opts?.slippageBps ?? 0, sent: true, sigs: [sig] };
    },
    fills,
    closeAccount: { async closeIfEmpty(owner, mint) { closes.push({ owner, mint }); return { status: 'closed', tx: newSig(), rentLamports: '2039280', reason: null }; } },
    rpc: { async call() { return { value: [] }; } },
    splBalance: async (_owner, mint) => ({ rawAtoms: Number(balances.get(mint) ?? 0n) }),
    walletBalanceSol: async () => 2,
    onchain: { async quoteSell(mint, tokensIn) {
      const p = price.get(mint);
      if (p === undefined) return null;
      const sol = p * Number(tokensIn);
      return { venue: 'pump-curve', solOutLamports: BigInt(Math.round(sol * 1e9)), sol, at: clock.now() };
    } },
    decimals: async () => 6,
    ...over,
  };
  return { clock, dir, tg, engine, router, settings, logs, secrets: [linkSecret, botToken, encKey, heliusKey, bs58.encode(WALLET_KEYPAIR.secretKey)], linkSecret, deps, price, balances, sellFills, buyFill, sells, closes };
}

interface Resp { status: number; json: any }
function send(port: number, secret: string, opts: { path?: string; method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const method = opts.method ?? 'POST';
    const body = opts.body ?? '';
    const headers: Record<string, string> = {
      host: `127.0.0.1:${port}`, authorization: `Bearer ${secret}`, 'content-type': 'application/json',
      ...(method === 'GET' ? {} : { 'content-length': String(Buffer.byteLength(body)) }), ...(opts.headers ?? {}),
    };
    for (const k of Object.keys(headers)) if (headers[k] === '') delete headers[k];
    const req = http.request({ host: '127.0.0.1', port, path: opts.path ?? '/v1/events', method, agent: false, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => {
        let json: any;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : body);
  });
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise<void>(r => { setTimeout(r, 5); });
  expect(cond(), what).toBe(true);
}

/** Everything the FakeEngine has accepted, parsed from the posted bodies. */
function acceptedEvents(w: World): BotToEngineEvent[] {
  const out: BotToEngineEvent[] = [];
  for (const b of w.engine.bodies) for (const e of (JSON.parse(b) as { events: BotToEngineEvent[] }).events) out.push(e);
  return out;
}

const running: Array<{ stop(): Promise<void> }> = [];
const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const r of running.splice(0)) { try { await r.stop(); } catch { /* already stopped */ } }
  for (const s of servers.splice(0)) { try { await s.close(); } catch { /* already closed */ } }
});
afterAll(() => { cleanupTempDirs(); });

/** A signal.new event for this app: a fresh CA and signal id, the app's own policy version. */
function signalFor(app: BotApp, clock: FakeClock): Envelope<'signal.new', SignalNew> {
  // the fixture's own times stay (decided 2.5 s and priced 4 s before the fixture clock, inside the 5 s freshness bound); only ids and the policy version change
  void clock;
  const ev = freshEvent(fixture<Envelope<'signal.new', SignalNew>>('signal.new'));
  ev.payload.policy.version = app.policy.version;
  return ev;
}

// ── B6-T05 ───────────────────────────────────────────────────────────────────────────────────────

describe('createBotApp and boot', () => {
  it('B6-T05 createBotApp(deps): the removed /signal route answers 404 whatever the body or the credentials, and /v1/events stays behind the link auth', async () => {
    const w = build();
    const app = createBotApp(w.deps);
    const s = await app.events.listen(0);
    servers.push(s);

    const withAuth = await send(s.port, w.linkSecret, { path: '/signal', body: JSON.stringify({ ca: newCa(), score: 91, grade: 'S', name: 'x' }) });
    expect(withAuth.status).toBe(404);
    const noAuth = await send(s.port, w.linkSecret, { path: '/signal', headers: { authorization: '' }, body: '{}' });
    expect(noAuth.status).toBe(404);
    const getIt = await send(s.port, w.linkSecret, { path: '/signal', method: 'GET' });
    expect(getIt.status).toBe(404);
    const rug = await send(s.port, w.linkSecret, { path: '/signal', body: JSON.stringify({ ca: newCa(), grade: 'RUG' }) });
    expect(rug.status).toBe(404);

    // the one route that exists is the Engine's event endpoint, and it still wants the bearer
    const noBearer = await send(s.port, w.linkSecret, { headers: { authorization: '' }, body: JSON.stringify(fixture('signal.new')) });
    expect(noBearer.status).toBe(401);
    expect(app.store.listOpen()).toEqual([]);
    expect(w.router.calls).toEqual([]);
  });

  it('B6-T06 boot(deps): the boot log names the contract version, the policy version, dry run and the auto-buy state, and holds no secret value', async () => {
    const w = build();
    const run = await boot(w.deps);
    running.push(run);
    expect(run.port).toBeGreaterThan(0);

    const lines = w.logs.join('\n');
    expect(lines).toContain(BRAND);
    expect(lines).toContain(`contract v${CONTRACT_VERSION}`);
    expect(lines).toContain(`exit policy ${run.policy.id}@${run.policy.version}`);
    expect(lines).toMatch(/BOT_DRY_RUN on/);
    expect(lines).toMatch(/auto-buy: mode off/);
    for (const l of run.bootLines()) expect(w.logs.some(x => x.endsWith(l)), `boot line missing from the log: ${l}`).toBe(true);

    // not one secret value anywhere the boot wrote or sent: the log, the owner's Telegram messages, the bodies posted to the Engine
    await run.stop();
    const everything = [lines, ...w.tg.calls.map(c => c.text), ...w.engine.bodies].join('\n');
    for (const secret of w.secrets) expect(everything).not.toContain(secret);
  });

  it('boot warns the owner when the link secret is missing or short, and still starts', async () => {
    const w = build({}, { SIGNAL_SHARED_SECRET: 'too-short' });
    const run = await boot(w.deps);
    running.push(run);
    expect(w.logs.join('\n')).toMatch(/link secret MISSING or too short/);
    await until(() => w.tg.calls.some(c => /SIGNAL_SHARED_SECRET is missing or shorter/.test(c.text)), 'the owner is told');
  });

  it('starts nothing by itself: createBotApp opens no socket and arms no timer; boot recovers the pending-buy journal BEFORE the exit engine and the intake', async () => {
    const w = build();
    const order: string[] = [];
    const app = createBotApp(w.deps);
    expect(app.clock).toBe(w.clock);
    expect((w.clock as FakeClock).pendingTimers()).toBe(0);
    const recover = vi.spyOn(app.autoBuy, 'recover').mockImplementation(async () => { order.push('recover'); return { resolved: 0, waiting: 0 }; });
    const exitsStart = vi.spyOn(app.exits, 'start').mockImplementation(() => { order.push('exits.start'); });
    const listen = vi.spyOn(app.events, 'listen').mockImplementation(async (p?: number) => {
      order.push('listen');
      return { port: p ?? 0, server: null as never, close: async () => undefined };
    });
    const run = await app.start();
    running.push(run);
    expect(order).toEqual(['recover', 'exits.start', 'listen']);
    recover.mockRestore(); exitsStart.mockRestore(); listen.mockRestore();
  });
});

// ── a signal through the whole wiring ────────────────────────────────────────────────────────────

describe('a signal through the wiring', () => {
  it('auto-buy is OFF by default: the card is sent, nothing is bought or signed, and the Engine hears delivery.buy off and delivery.tg sent', async () => {
    const w = build();
    const run = await boot(w.deps);
    running.push(run);
    const ev = signalFor(run, w.clock);

    const res = await send(run.port, w.linkSecret, { body: JSON.stringify(ev) });
    expect(res.status).toBe(202);
    await until(() => w.tg.calls.length === 1, 'the signal card is sent');
    expect(w.tg.calls[0].text).toContain(ev.ca as string);
    expect(w.tg.calls[0].chatId).toBe('4242');

    expect(w.router.calls).toEqual([]);          // no buy attempt, not even a build
    expect(w.router.sends).toEqual([]);          // nothing sent
    expect(run.store.listOpen()).toEqual([]);

    await run.outbox.flushNow();
    const got = acceptedEvents(w);
    const buy = got.find(e => e.type === 'delivery.buy');
    const tgd = got.find(e => e.type === 'delivery.tg');
    expect(buy?.payload).toMatchObject({ status: 'off', reason: 'off' });
    expect(tgd?.payload).toMatchObject({ status: 'sent', kind: 'signal' });
    expect(buy?.signal_id).toBe(ev.signal_id);
  });

  it('a grade below tgMinGrade is filtered, not sent, and reported', async () => {
    const w = build();
    w.settings.state.tgMinGrade = 'A';
    const run = await boot(w.deps);
    running.push(run);
    const ev = signalFor(run, w.clock);
    ev.payload.grade = 'B';
    expect((await send(run.port, w.linkSecret, { body: JSON.stringify(ev) })).status).toBe(202);
    await until(() => run.outbox.backlog() >= 2, 'the deliveries are queued');
    expect(w.tg.calls).toEqual([]);
    await run.outbox.flushNow();
    expect(acceptedEvents(w).find(e => e.type === 'delivery.tg')?.payload).toMatchObject({ status: 'filtered' });
  });

  it('dry-run: the buy is built and signed, never sent; the positions adapter opens a virtual position from the quote and the Engine hears position.opened (dry_run)', async () => {
    const w = build();
    const run = await boot(w.deps);
    running.push(run);
    expect(await run.autoBuy.commands.handle('/autobuy dryrun B1', { isOwner: true })).toContain('Dry run armed on B1');
    const ev = signalFor(run, w.clock);
    expect((await send(run.port, w.linkSecret, { body: JSON.stringify(ev) })).status).toBe(202);
    await until(() => run.store.listOpen().length === 1, 'the virtual position is opened');

    expect(w.router.calls).toHaveLength(1);
    expect(w.router.calls[0].opts).toMatchObject({ buildOnly: true, singleSend: true, maxImpactPct: 15, slippageBps: 300 });
    expect(w.router.sends).toEqual([]);                       // zero sends (B2-T08 / T12)
    const pos = run.store.listOpen()[0];
    expect(pos).toMatchObject({ dry_run: true, origin: 'signal', ca: ev.ca, wallet_id: 'w1', arm: 'B1' });
    expect(pos.entry.fill_source).toBe('quote_dry_run');
    expect(pos.tokens).toBe(w.router.quote.toString());       // the quote, as the position's size
    expect(run.autoBuy.heartbeat().caps_used).toEqual({ hour: 0, day: 0, sol_day: 0 });   // a dry run never touches the caps

    await run.outbox.flushNow();
    const got = acceptedEvents(w);
    expect(got.find(e => e.type === 'delivery.buy')?.payload).toMatchObject({ status: 'dry_run', arm: 'B1' });
    expect(got.find(e => e.type === 'position.opened')?.payload).toMatchObject({ dry_run: true, origin: 'signal', fill_source: 'quote_dry_run', arm: 'B1' });
  });

  it('CARD-T17 mode live with BOT_DRY_RUN unset: the card says DRY RUN on the arm (never LIVE), and indeed nothing is sent', async () => {
    const armsPayload = fixture<{ payload: ArmsStatusPayload }>('arms.status').payload;          // BS is PASS with report-0001
    const engine: EngineClient = {
      async arms() { return JSON.parse(JSON.stringify(armsPayload)); },
      async token() { return { error: 'engine_offline' }; },
      async price() { return { error: 'engine_offline' }; },
    };
    const w = build({ engine });                                       // the env has no BOT_DRY_RUN: on by default
    const run = await boot(w.deps);
    running.push(run);
    expect(await run.autoBuy.commands.handle('/autobuy on BS', { isOwner: true })).toContain('CONFIRM BS report-0001');
    expect(await run.autoBuy.commands.handle('CONFIRM BS report-0001', { isOwner: true })).toMatch(/^Auto-buy is LIVE on arm BS/);
    expect(run.autoBuy.heartbeat().autobuy).toMatchObject({ mode: 'live', arm: 'BS', dry_run: true });

    const ev = signalFor(run, w.clock);
    expect((await send(run.port, w.linkSecret, { body: JSON.stringify(ev) })).status).toBe(202);
    await until(() => w.tg.calls.length >= 1, 'the signal card is sent');
    const card = w.tg.calls[0].text.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
    expect(card).toContain('Auto-buy: DRY RUN on arm BS (BOT_DRY_RUN on: nothing is sent) · size 0.01 SOL');
    expect(card).not.toContain('LIVE on arm');
    expect(w.router.sends).toEqual([]);                                // the card told the truth: zero sends
  });

  it('dry-run with no token amount in the quote opens NO virtual position (never a 0) and reports delivery.buy failed with quote_tokens_unknown', async () => {
    const w = build();
    const noQuote = async (...a: Parameters<StubRouter['smartBuy']>) => {
      const r = await w.router.smartBuy(...a);
      return { ...r, tokensOut: undefined, tokensOutQuoted: undefined };
    };
    const run = await boot({ ...w.deps, smartBuy: noQuote });
    running.push(run);
    await run.autoBuy.commands.handle('/autobuy dryrun B1', { isOwner: true });
    const ev = signalFor(run, w.clock);
    expect((await send(run.port, w.linkSecret, { body: JSON.stringify(ev) })).status).toBe(202);
    await until(() => run.outbox.backlog() >= 2, 'the deliveries are queued');
    expect(run.store.listOpen()).toEqual([]);
    expect(w.router.sends).toEqual([]);
    await run.outbox.flushNow();
    const buy = acceptedEvents(w).find(e => e.type === 'delivery.buy');
    expect(buy?.payload).toMatchObject({ status: 'failed' });
    expect(String((buy?.payload as { error: string }).error)).toMatch(/quote.?tokens.?unknown/);   // (the outbox strips Markdown characters such as the underscore)
    expect(w.logs.join('\n')).toContain('failed with reason quote_tokens_unknown');
    expect(acceptedEvents(w).some(e => e.type === 'position.opened')).toBe(false);
  });

  it('a signal.cancel with no position sells nothing and still shows the cancel card', async () => {
    const w = build();
    const run = await boot(w.deps);
    running.push(run);
    const first = signalFor(run, w.clock);
    await send(run.port, w.linkSecret, { body: JSON.stringify(first) });
    await until(() => w.tg.calls.length === 1, 'the card');
    const cancel = freshEvent(fixture<Envelope<'signal.cancel', any>>('signal.cancel'), first.ca);
    cancel.signal_id = first.signal_id;
    cancel.emitted_at = w.clock.now();
    expect((await send(run.port, w.linkSecret, { body: JSON.stringify(cancel) })).status).toBe(202);
    await until(() => w.tg.calls.length === 2, 'the cancel card');
    expect(w.sells).toEqual([]);
  });
});

// ── the exit engine inside the app ───────────────────────────────────────────────────────────────

describe('the exit engine inside the app', () => {
  it('a stop-loss sale feeds auto-buy (noteSellOk, the rolling window), tells the owner, and the Engine hears exit.leg and position.closed', async () => {
    const w = build();
    const app = createBotApp(w.deps);
    const noteSellOk = vi.spyOn(app.autoBuy, 'noteSellOk');
    const ca = newCa();
    const BASE = 2e-10;
    const tokens = 1_000_000_000n;
    const entryTx = newSig();
    app.store.put({
      position_id: 'pos_a', signal_id: 'dec_test', origin: 'signal', dry_run: false, ca, wallet_id: 'w1', policy_id: 'EA', policy_version: app.policy.version, arm: 'B1',
      entry: { tx: entryTx, opened_at: w.clock.now() - 60_000, sol_spent_lamports: '200000000', tokens_raw: tokens.toString(), fill_source: 'tx_meta' },
      original_tokens: tokens.toString(), tokens: tokens.toString(), basis_sol_per_token: BASE, peak_multiple: 1, legs_done: [], leg_attempts: {},
      last_quote: null, lockouts: [], ata: null,
    });
    w.balances.set(ca, tokens);
    w.price.set(ca, BASE * 0.5);                     // 0.5x: below the 0.62 stop while the peak is under 1.5

    await app.exits.runPass();
    const pos = app.store.get('pos_a');
    expect(pos?.closed_at).not.toBeNull();
    expect(pos?.close_reason).toBe('policy');
    expect(w.sells).toHaveLength(1);
    expect(w.sells[0].tokens).toBe(tokens);
    expect(w.sells[0].opts).toMatchObject({ singleSend: true });
    expect(w.sells[0].opts).toMatchObject({ priorityFee: 100_000, antiMev: false });   // the Global Settings reach the exit sell
    expect(w.closes).toEqual([{ owner: WALLET.owner, mint: ca }]);

    expect(noteSellOk).toHaveBeenCalledTimes(1);
    expect(await app.autoBuy.commands.handle('/autobuy status', { isOwner: true })).toMatch(/rolling window: 1 closed real trades/);

    await w.clock.settle();
    const texts = w.tg.calls.map(c => c.text);
    expect(texts.some(t => /^Exit S on /.test(t) && t.includes('sold 100%'))).toBe(true);
    expect(texts.some(t => /^Position closed \(policy\)/.test(t))).toBe(true);

    await app.outbox.flushNow();
    const types = acceptedEvents(w).map(e => e.type);
    expect(types).toContain('exit.leg');
    expect(types).toContain('position.closed');
  });

  it('a dry-run exit stays silent towards Telegram and does not count as a sell for the breaker', async () => {
    const w = build();
    const app = createBotApp(w.deps);
    const noteSellOk = vi.spyOn(app.autoBuy, 'noteSellOk');
    const ca = newCa();
    app.store.openDryRun({ id: 'dry_a', signal_id: 'dec_t', ca, wallet_id: 'w1', arm: 'B1', tokens: '1000000000', sol_in_lamports: '10000000', opened_at: w.clock.now() - 60_000 });
    app.store.update('dry_a', { basis_sol_per_token: 1e-11 });
    w.price.set(ca, 1e-11 * 0.4);
    await app.exits.runPass();
    expect(app.store.get('dry_a')?.closed_at).not.toBeNull();
    expect(w.sells).toEqual([]);                      // nothing is ever sent
    expect(noteSellOk).not.toHaveBeenCalled();
    await w.clock.settle();
    expect(w.tg.calls).toEqual([]);                   // and the owner is not paged for a virtual exit
  });
});

// ── the owner line ───────────────────────────────────────────────────────────────────────────────

describe('ownerLineOf', () => {
  const leg = (o: Record<string, unknown> = {}): BotToEngineEvent => ({
    v: 1, type: 'exit.leg', event_id: newTestUlid(), signal_id: null, ca: newCa(), emitted_at: FIXTURE_NOW, attempt: 1,
    payload: { position_id: 'p', leg: 'TP1', status: 'filled', attempt: 1, fraction_of_original: 0.3, trigger_multiple: 2, peak_multiple: 2, quote_multiple: 2, quote_src: 'onchain',
      quote_age_s: 1, trigger_at: FIXTURE_NOW, send_at: FIXTURE_NOW, confirm_at: FIXTURE_NOW, tx: 'sigX', sol_out_quoted_lamports: null, sol_out_real_lamports: '150000000',
      fill_multiple: null, error: null, dry_run: false, policy_version: 'v', ...o },
  } as BotToEngineEvent);

  it('says what was sold and what it brought; stays silent for a dry run, a failed leg and any other event', () => {
    expect(ownerLineOf(leg(), undefined)).toBe('Exit TP1 on a position: sold 30% of the position, got 0.1500 SOL, tx sigX');
    expect(ownerLineOf(leg({ status: 'filled_unconfirmed', sol_out_real_lamports: null }), undefined)).toContain('proceeds not verified');
    expect(ownerLineOf(leg({ dry_run: true }), undefined)).toBeNull();
    expect(ownerLineOf(leg({ status: 'failed' }), undefined)).toBeNull();
    expect(ownerLineOf(leg({ status: 'locked_out' }), undefined)).toBeNull();
    const hb = { ...leg(), type: 'bot.heartbeat' } as unknown as BotToEngineEvent;
    expect(ownerLineOf(hb, undefined)).toBeNull();
  });
});

// ── the manual trader ────────────────────────────────────────────────────────────────────────────

describe('the manual trader (the Telegram buy and sell buttons)', () => {
  interface Rig {
    clock: FakeClock; dir: string; outbox: MemoryOutbox; store: ReturnType<typeof createPositionsStore>; notices: string[];
    buys: Array<{ mint: string; sol: number; opts: Record<string, unknown> }>; sells: Array<{ tokens: bigint; opts: Record<string, unknown> }>;
    chain: { balances: Map<string, bigint>; statuses: Map<string, { err: unknown; confirmationStatus?: string | null } | null>; height: { value: number } }; fills: { buy: BuyFill | 'unverified'; sell: Map<string, SellFill> };
    smartBuyImpl: { fn: (mint: string, sol: number, opts?: any) => Promise<any> };
    smartSellImpl: { fn: (mint: string, tokens: bigint, opts: any) => Promise<any> };
    mutex: ReturnType<typeof createSellMutex>;
    trader: ReturnType<typeof createManualTrader>;
    settings: ReturnType<typeof makeSettings>;
    /** The deps of `trader`: a second trader over them is what a restart sees (same folder, same store). */
    tdeps: ManualTraderDeps;
    /** FIX-BUY: the wallet's native SOL the trader reads before a buy (null = unreadable), and the owners it was read for. */
    sol: { lamports: bigint | null; calls: string[] };
  }
  function rig(): Rig {
    const clock = new FakeClock(FIXTURE_NOW);
    const dir = tempDir('ps-manual-');
    const outbox = new MemoryOutbox();
    const store = createPositionsStore({ dir, clock, policy: { id: 'EA', version: 'test' } });
    const notices: string[] = [];
    const buys: Rig['buys'] = [];
    const sells: Rig['sells'] = [];
    const balances = new Map<string, bigint>();
    const statuses = new Map<string, { err: unknown; confirmationStatus?: string | null } | null>();
    const height = { value: 2_000_000 };
    const sellFills = new Map<string, SellFill>();
    const fillState = { buy: 'unverified' as BuyFill | 'unverified', sell: sellFills };
    const smartBuyImpl: Rig['smartBuyImpl'] = {
      fn: async (_mint, _sol, opts) => {
        const sig = newSig();
        await opts?.onSigned?.({ sig, lastValidBlockHeight: 1_150, route: 'pf-direct' });
        return { sig, route: 'pf-direct', tokensOut: 1_000_000_000n, tokensOutQuoted: 1_000_000_000n, slippageBpsUsed: 100, sent: true, sigs: [sig] };
      },
    };
    const smartSellImpl: Rig['smartSellImpl'] = {
      fn: async (mint, tokens, opts) => {
        const sig = newSig();
        await opts?.onSigned?.({ sig, lastValidBlockHeight: 1_150, route: 'pf-direct' });
        const have = balances.get(mint) ?? 0n;
        const sold = tokens < have ? tokens : have;
        balances.set(mint, have - sold);
        sellFills.set(sig, { solOutNetLamports: (sold * 300n / 1000n).toString(), solOutGrossLamports: (sold * 300n / 1000n + 5000n).toString(), tokensSoldRaw: sold.toString(), feeLamports: '5000', confirmedAt: clock.now() });
        return { sig, route: 'pf-direct', slippageBpsUsed: opts?.slippageBps ?? 0, sent: true, sigs: [sig] };
      },
    };
    const mutex = createSellMutex();
    const settings = makeSettings();
    const solState: Rig['sol'] = { lamports: 2_000_000_000n, calls: [] };
    const tdeps: ManualTraderDeps = {
      clock, store, wallets, settings,
      smartBuy: async (_kp, mint, sol, opts) => { buys.push({ mint, sol, opts: { ...(opts ?? {}) } }); return smartBuyImpl.fn(mint, sol, opts); },
      smartSell: async (_kp, mint, tokens, opts) => { sells.push({ tokens, opts: { ...(opts ?? {}) } }); return smartSellImpl.fn(mint, tokens, opts); },
      fills: { async buyFill() { return fillState.buy; }, async sellFill(sig) { return sellFills.get(sig) ?? 'unverified'; } },
      chain: { async signatureStatuses(sigs) { return sigs.map(s => statuses.get(s) ?? null); }, async tokenBalance(_o, mint) { return { rawAtoms: Number(balances.get(mint) ?? 0n) }; }, async blockHeight() { return height.value; } },
      solLamports: async (owner) => { solState.calls.push(owner); return solState.lamports; },
      mutex, outbox, newEventId: newTestUlid, dataDir: dir, notifyOwner: t => { notices.push(t); }, log: () => undefined,
    };
    const trader = createManualTrader(tdeps);
    return { clock, dir, outbox, store, notices, buys, sells, chain: { balances, statuses, height }, fills: fillState, smartBuyImpl, smartSellImpl, mutex, trader, settings, tdeps, sol: solState };
  }
  const seedManual = (r: Rig, ca: string, tokens = 1_000_000_000n, spent = '100000000'): void => {
    r.store.put({
      position_id: `man_${ca.slice(0, 6)}`, signal_id: null, origin: 'manual', dry_run: false, ca, wallet_id: 'w1', policy_id: 'MANUAL', policy_version: null, arm: null,
      entry: { tx: newSig(), opened_at: r.clock.now() - 120_000, sol_spent_lamports: spent, tokens_raw: null, fill_source: 'unverified' },
      original_tokens: tokens.toString(), tokens: tokens.toString(), basis_sol_per_token: null, peak_multiple: 1, legs_done: [], leg_attempts: {}, last_quote: null, lockouts: [], ata: null,
    });
    r.chain.balances.set(ca, tokens);
  };

  it('a manual buy opens a manual PositionV2 from the quote at once, then replaces it with the REAL fill (tx_meta) and keeps the quote out of the books', async () => {
    const r = rig();
    const ca = newCa();
    const fill: BuyFill = { solSpentLamports: '101500000', tokensRaw: '990000000', feeLamports: '5000', confirmedAt: r.clock.now() };
    r.fills.buy = fill;
    const res = await r.trader.buy({ walletId: 'w1', ca, sol: 0.1 });
    expect(res.tokenAmt).toBe(1_000_000_000);
    const id = manualPositionId(res.sig);
    expect(res.positionId).toBe(id);
    await vi.waitFor(() => expect(r.store.get(id)?.entry.fill_source).toBe('tx_meta'));
    const pos = r.store.get(id)!;
    expect(pos).toMatchObject({ origin: 'manual', dry_run: false, wallet_id: 'w1', policy_id: 'MANUAL', tokens: '990000000', original_tokens: '990000000' });
    expect(pos.entry).toMatchObject({ tx: res.sig, sol_spent_lamports: '101500000', tokens_raw: '990000000', fill_source: 'tx_meta' });
    expect(r.outbox.of('position.opened')).toHaveLength(1);
    expect(r.outbox.of('position.opened')[0].payload).toMatchObject({ origin: 'manual', fill_source: 'unverified', dry_run: false, entry_tx: res.sig });
    expect(r.buys[0].opts).toMatchObject({ priorityFee: 100_000, antiMev: false });
    expect(r.buys[0].opts.singleSend).toBe(true);                 // A-93f: one send per buy (fallbacks only before anything was sent)
  });

  it('a buy that never landed (the fill shows 0 tokens) closes the phantom position and tells the owner', async () => {
    const r = rig();
    r.fills.buy = { solSpentLamports: '5000', tokensRaw: '0', feeLamports: '5000', confirmedAt: r.clock.now() };
    const res = await r.trader.buy({ walletId: 'w1', ca: newCa(), sol: 0.1 });
    await vi.waitFor(() => expect(r.store.get(res.positionId as string)?.closed_at).not.toBeNull());
    expect(r.notices.some(n => /Buy did NOT land/.test(n))).toBe(true);
    expect(r.outbox.of('position.closed')).toHaveLength(1);
    expect(r.store.listOpen()).toEqual([]);
  });

  it('an unreadable fill keeps the position (unknown is not a revert) unless the wallet is CONFIRMED empty', async () => {
    const r = rig();
    const ca = newCa();
    r.chain.balances.set(ca, 5_000n);
    const res = await r.trader.buy({ walletId: 'w1', ca, sol: 0.1 });
    await new Promise<void>(x => { setTimeout(x, 30); });
    expect(r.store.get(res.positionId as string)?.closed_at).toBeNull();
    expect(r.store.get(res.positionId as string)?.entry.fill_source).toBe('unverified');

    const ca2 = newCa();
    r.chain.balances.set(ca2, 0n);   // an account that exists and is empty
    const res2 = await r.trader.buy({ walletId: 'w1', ca: ca2, sol: 0.1 });
    await vi.waitFor(() => expect(r.store.get(res2.positionId as string)?.closed_at).not.toBeNull());
  });

  it('refuses a second buy of a held token unless Duplicate Buy is on, and a bad amount or an unknown wallet', async () => {
    const r = rig();
    const ca = newCa();
    await r.trader.buy({ walletId: 'w1', ca, sol: 0.1 });
    await expect(r.trader.buy({ walletId: 'w1', ca, sol: 0.1 })).rejects.toThrow(/Already holding/);
    r.settings.state.dupe = true;
    await expect(r.trader.buy({ walletId: 'w1', ca, sol: 0.1 })).resolves.toBeDefined();
    await expect(r.trader.buy({ walletId: 'w1', ca: newCa(), sol: Number.NaN })).rejects.toThrow(/Invalid buy amount/);
    await expect(r.trader.buy({ walletId: 'nope', ca: newCa(), sol: 0.1 })).rejects.toThrow(/Cannot load keypair/);
  });

  it('a router error AFTER a send opens no position by itself: the chain decides, and the owner is told', async () => {
    const r = rig();
    const sig = newSig();
    r.smartBuyImpl.fn = async () => { throw new RouterSendError('confirmation timed out', [sig]); };
    r.fills.buy = { solSpentLamports: '100500000', tokensRaw: '900000000', feeLamports: '5000', confirmedAt: r.clock.now() };
    const ca = newCa();
    await expect(r.trader.buy({ walletId: 'w1', ca, sol: 0.1 })).rejects.toThrow(/confirmation timed out/);
    await vi.waitFor(() => expect(r.store.listOpen()).toHaveLength(1));    // it did land: opened from the real fill
    expect(r.store.listOpen()[0]).toMatchObject({ ca, tokens: '900000000', origin: 'manual' });
    expect(r.store.listOpen()[0].entry.fill_source).toBe('tx_meta');
    expect(r.notices.some(n => n.includes(sig))).toBe(true);
  });

  it('a partial sell books the REAL fill: tokens down, proceeds added, one exit.leg MANUAL, PnL from the cost share', async () => {
    const r = rig();
    const ca = newCa();
    seedManual(r, ca);
    const res = await r.trader.sell({ walletId: 'w1', ca, pct: 50 });
    expect(res.closed).toBe(false);
    expect(res.verified).toBe(true);
    expect(res.solOut).toBeCloseTo(0.15, 9);                        // 500_000_000 atoms x 0.3 lamports
    expect(res.pnl).toBeCloseTo(0.15 - 0.05, 9);
    expect(res.pnlPct).toBeCloseTo(200, 6);
    const pos = r.store.listOpen()[0];
    expect(pos.tokens).toBe('500000000');
    expect(pos.real_out_lamports).toBe('150000000');
    expect(pos.close_pending).toBeNull();
    expect(pos.pending_sigs).toEqual([]);
    const legs = r.outbox.of('exit.leg');
    expect(legs).toHaveLength(1);
    expect(legs[0].payload).toMatchObject({ leg: 'MANUAL', status: 'filled', fraction_of_original: 0.5, dry_run: false, policy_version: 'manual', sol_out_real_lamports: '150000000' });
    expect(r.sells[0].opts).toMatchObject({ singleSend: true, slippageBps: 300 });
  });

  it('a full sell sells the whole on-chain balance and leaves the close (zero-balance check, CloseAccount, position.closed) to the exit engine', async () => {
    const r = rig();
    const ca = newCa();
    seedManual(r, ca);
    r.chain.balances.set(ca, 1_000_000_123n);                       // the wallet holds a few atoms more than the books say
    const res = await r.trader.sell({ walletId: 'w1', ca, pct: 100, slippageBps: 900, antiMev: true });
    expect(r.sells[0].tokens).toBe(1_000_000_123n);
    expect(r.sells[0].opts).toMatchObject({ slippageBps: 900, antiMev: true });
    expect(res.closed).toBe(true);
    const pos = r.store.listOpen()[0];
    expect(pos.tokens).toBe('0');
    expect(pos.close_pending).toMatchObject({ reason: 'manual', close_account: true, tries: 0 });
    expect(pos.next_due_at).toBe(r.clock.now());                    // due at once: the engine's next pass finishes it
  });

  it('an unreadable sell fill is reported as not verified: proceeds and PnL stay unknown, never the quote', async () => {
    const r = rig();
    const ca = newCa();
    seedManual(r, ca);
    // a trader whose fill reader knows nothing about the signature it signs
    const noFill = createManualTrader({
      clock: r.clock, store: r.store, wallets, settings: r.settings,
      smartBuy: async () => { throw new Error('unused'); },
      smartSell: async (_kp, mint, tokens, opts) => r.smartSellImpl.fn(mint, tokens, opts),
      fills: { async buyFill() { return 'unverified'; }, async sellFill() { return 'unverified'; } },
      chain: { async signatureStatuses(s) { return s.map(() => null); }, async tokenBalance(_o, mint) { return { rawAtoms: Number(r.chain.balances.get(mint) ?? 0n) }; }, async blockHeight() { return 2_000_000; } },
      solLamports: async () => 2_000_000_000n,
      mutex: r.mutex, outbox: r.outbox, newEventId: newTestUlid, dataDir: r.dir, notifyOwner: () => undefined, log: () => undefined,
    });
    const res = await noFill.sell({ walletId: 'w1', ca, pct: 40 });
    expect(res.verified).toBe(false);
    expect(res.solOut).toBeNull();
    expect(res.pnl).toBeNull();
    const pos = r.store.listOpen()[0];
    expect(pos.sell_unverified).toBe(true);
    expect(pos.real_out_lamports).toBe('0');
    expect(r.outbox.of('exit.leg')[0].payload).toMatchObject({ status: 'filled_unconfirmed', sol_out_real_lamports: null });
  });

  it('refuses a sell while another sell holds the (CA, wallet), when nothing is held, and reports a failed send as an error with the position untouched', async () => {
    const r = rig();
    const ca = newCa();
    await expect(r.trader.sell({ walletId: 'w1', ca, pct: 50 })).rejects.toThrow(/No position found/);
    seedManual(r, ca);
    expect(r.mutex.tryAcquire(sellKey(ca, 'w1'))).toBe(true);
    await expect(r.trader.sell({ walletId: 'w1', ca, pct: 50 })).rejects.toThrow(/already in progress/);
    r.mutex.release(sellKey(ca, 'w1'));

    r.smartSellImpl.fn = async () => { throw new RouterSendError('swap reverted: custom program error 6024', [newSig()]); };
    await expect(r.trader.sell({ walletId: 'w1', ca, pct: 50 })).rejects.toThrow(/6024/);
    const pos = r.store.listOpen()[0];
    expect(pos.tokens).toBe('1000000000');
    expect(r.outbox.of('exit.leg')).toEqual([]);
    expect(r.mutex.has(sellKey(ca, 'w1'))).toBe(false);             // released
  });

  it('splits one sale over two positions of the same token in proportion to what each holds', async () => {
    const r = rig();
    const ca = newCa();
    for (const [id, tokens] of [['a', 600_000_000n], ['b', 400_000_000n]] as const) {
      r.store.put({
        position_id: `man_${id}`, signal_id: null, origin: 'manual', dry_run: false, ca, wallet_id: 'w1', policy_id: 'MANUAL', policy_version: null, arm: null,
        entry: { tx: newSig(), opened_at: r.clock.now() - 1000, sol_spent_lamports: '100000000', tokens_raw: null, fill_source: 'unverified' },
        original_tokens: tokens.toString(), tokens: tokens.toString(), basis_sol_per_token: null, peak_multiple: 1, legs_done: [], leg_attempts: {}, last_quote: null, lockouts: [], ata: null,
      });
    }
    r.chain.balances.set(ca, 1_000_000_000n);
    await r.trader.sell({ walletId: 'w1', ca, pct: 50 });
    expect(r.store.get('man_a')?.tokens).toBe('300000000');
    expect(r.store.get('man_b')?.tokens).toBe('200000000');
    expect(r.outbox.of('exit.leg')).toHaveLength(2);
  });
  // ── A-93f (orchestrator fix, rb/FIX-BOT) ─────────────────────────────────────────────────────────

  const manualJournal = (r: Rig): string[] => {
    try { return (JSON.parse(fs.readFileSync(path.join(r.dir, 'manual-buys.json'), 'utf8')) as { entries: Array<{ sig: string }> }).entries.map(e => e.sig); } catch { return []; }
  };

  it('FIXBOT-T09 a manual buy is journalled before its send: a restart in the fill wait resumes it, and a landed buy whose meta stays unreadable is opened from the wallet balance', async () => {
    const r = rig();
    const ca = newCa();
    const sig = newSig();
    r.smartBuyImpl.fn = async (_m, _s, opts) => {
      await opts?.onSigned?.({ sig, lastValidBlockHeight: 1_150, route: 'pf-direct' });
      throw new RouterSendError('confirmation timed out', [sig]);
    };
    const dying = createManualTrader({ ...r.tdeps, fills: { buyFill: () => new Promise(() => undefined), async sellFill() { return 'unverified'; } } });
    await expect(dying.buy({ walletId: 'w1', ca, sol: 0.1 })).rejects.toThrow(/confirmation timed out/);
    expect(r.store.listOpen()).toEqual([]);
    expect(manualJournal(r)).toEqual([sig]);                                  // written before the send: the restart knows it

    // the restart: the meta is still unreadable, the status says landed and the wallet holds the tokens
    r.chain.statuses.set(sig, { err: null, confirmationStatus: 'confirmed' });
    r.chain.balances.set(ca, 777_000n);
    r.fills.buy = 'unverified';
    const after = createManualTrader(r.tdeps);
    after.resume();
    await vi.waitFor(() => expect(r.store.listOpen()).toHaveLength(1));
    expect(r.store.listOpen()[0]).toMatchObject({ ca, tokens: '777000', origin: 'manual', position_id: manualPositionId(sig) });
    expect(r.store.listOpen()[0].entry.fill_source).toBe('unverified');
    await vi.waitFor(() => expect(manualJournal(r)).toEqual([]));
    after.stop();
  });

  it('FIXBOT-T11 a manual buy asks the router for a single send, and every signature a buy reports is settled into its own position', async () => {
    const r = rig();
    const fillsBy = new Map<string, BuyFill>();
    const t = createManualTrader({ ...r.tdeps, fills: { async buyFill(s) { return fillsBy.get(s) ?? 'unverified'; }, async sellFill() { return 'unverified'; } } });
    const ca = newCa();
    const [a, b] = [newSig(), newSig()];
    fillsBy.set(a, { solSpentLamports: '100500000', tokensRaw: '400000000', feeLamports: '5000', confirmedAt: r.clock.now() });
    fillsBy.set(b, { solSpentLamports: '100500000', tokensRaw: '300000000', feeLamports: '5000', confirmedAt: r.clock.now() });
    r.smartBuyImpl.fn = async (_m, _s, opts) => {
      await opts?.onSigned?.({ sig: a, lastValidBlockHeight: 1_150, route: 'pf-direct' });
      await opts?.onSigned?.({ sig: b, lastValidBlockHeight: 1_150, route: 'jupiter' });
      return { sig: b, route: 'jupiter', tokensOut: 300_000_000n, tokensOutQuoted: 300_000_000n, slippageBpsUsed: 300, sent: true, sigs: [a, b] };
    };
    await t.buy({ walletId: 'w1', ca, sol: 0.1 });
    expect(r.buys[0].opts.singleSend).toBe(true);
    await vi.waitFor(() => expect(r.store.listOpen().filter(p => p.ca === ca).map(p => p.tokens).sort()).toEqual(['300000000', '400000000']));

    // the error path settles every signature the error carries, not only the first
    const ca2 = newCa();
    const [c, d] = [newSig(), newSig()];
    fillsBy.set(d, { solSpentLamports: '100500000', tokensRaw: '250000000', feeLamports: '5000', confirmedAt: r.clock.now() });
    r.chain.balances.set(ca2, 250_000_000n);
    r.smartBuyImpl.fn = async (_m, _s, opts) => {
      await opts?.onSigned?.({ sig: c, lastValidBlockHeight: 1_150, route: 'pf-direct' });
      await opts?.onSigned?.({ sig: d, lastValidBlockHeight: 1_150, route: 'jupiter' });
      throw new RouterSendError('confirmation timed out', [c, d]);
    };
    await expect(t.buy({ walletId: 'w1', ca: ca2, sol: 0.1 })).rejects.toThrow(/timed out/);
    await vi.waitFor(() => expect(r.store.listOpen().filter(p => p.ca === ca2).map(p => p.position_id)).toEqual([manualPositionId(d)]));
    await vi.waitFor(() => expect(manualJournal(r)).toEqual([]));             // c never landed (expired, wallet holds only d's tokens)
    t.stop();
  });

  it('FIXBOT-T12 a manual sell after a sell that reported a failure checks it first: no second send while it may still land, and a landed one is booked instead of sold again', async () => {
    const r = rig();
    const ca = newCa();
    seedManual(r, ca);
    r.chain.height.value = 1_100;                                             // the blockhash of the first sell (1_150) is still valid
    const okSell = r.smartSellImpl.fn;
    let sig1 = '';
    r.smartSellImpl.fn = async (_mint, _tokens, opts) => {
      sig1 = newSig();
      await opts?.onSigned?.({ sig: sig1, lastValidBlockHeight: 1_150, route: 'pf-direct' });
      throw new RouterSendError('sender: tx not confirmed within 60s (likely dropped or expired blockhash)', [sig1]);
    };
    await expect(r.trader.sell({ walletId: 'w1', ca, pct: 50 })).rejects.toThrow(/not confirmed/);
    expect(r.store.listOpen()[0].pending_sigs).toEqual([sig1]);
    r.smartSellImpl.fn = okSell;
    await expect(r.trader.sell({ walletId: 'w1', ca, pct: 50 })).rejects.toThrow(/may still land/);
    expect(r.sells).toHaveLength(1);                                          // the re-tap sent nothing
    // it did land after all: the next sell books it and sends nothing
    r.chain.balances.set(ca, 500_000_000n);
    r.chain.statuses.set(sig1, { err: null, confirmationStatus: 'confirmed' });
    const res = await r.trader.sell({ walletId: 'w1', ca, pct: 50 });
    expect(r.sells).toHaveLength(1);
    expect(res.sig).toBe(sig1);
    expect(r.store.listOpen()[0].tokens).toBe('500000000');
  });

  it('FIXBOT-T16 an unreadable buy meta and a confirmed-empty wallet are not a phantom while the blockhash is valid: a late landing is kept, and a buy that never lands is dropped only after expiry', async () => {
    const r = rig();
    const ca = newCa();
    r.chain.balances.set(ca, 0n);                                             // an empty token account from an earlier position
    r.chain.height.value = 1_100;                                             // the buy's blockhash (1_150) is still valid
    const res = await r.trader.buy({ walletId: 'w1', ca, sol: 0.1 });
    const id = res.positionId as string;
    await new Promise<void>(x => { setTimeout(x, 30); });
    expect(r.store.get(id)?.closed_at).toBeNull();                            // not dropped as a phantom
    r.chain.balances.set(ca, 990_000_000n);                                   // it landed late
    await r.clock.advance(5_000);
    await vi.waitFor(() => expect(manualJournal(r)).toEqual([]));
    expect(r.store.get(id)).toMatchObject({ closed_at: null, tokens: '990000000' });

    const ca2 = newCa();
    r.chain.balances.set(ca2, 0n);
    const res2 = await r.trader.buy({ walletId: 'w1', ca: ca2, sol: 0.1 });
    await new Promise<void>(x => { setTimeout(x, 30); });
    expect(r.store.get(res2.positionId as string)?.closed_at).toBeNull();
    r.chain.height.value = 1_151;                                             // expired and never seen: it did not land
    await r.clock.advance(5_000);
    await vi.waitFor(() => expect(r.store.get(res2.positionId as string)?.closed_at).not.toBeNull());
    expect(r.notices.some(n => /Buy did NOT land/.test(n))).toBe(true);
    r.trader.stop();
  });

  it('FIXBOT-T17 re-tapping Buy after a buy failed post-send is refused while that buy is unresolved, and allowed once its blockhash has expired', async () => {
    const r = rig();
    const ca = newCa();
    const sig = newSig();
    r.chain.height.value = 1_100;
    r.chain.balances.set(ca, 0n);
    const okBuy = r.smartBuyImpl.fn;
    r.smartBuyImpl.fn = async (_m, _s, opts) => {
      await opts?.onSigned?.({ sig, lastValidBlockHeight: 1_150, route: 'pf-direct' });
      throw new RouterSendError('sender timeout', [sig]);
    };
    await expect(r.trader.buy({ walletId: 'w1', ca, sol: 0.1 })).rejects.toThrow(/sender timeout/);
    r.smartBuyImpl.fn = okBuy;
    await expect(r.trader.buy({ walletId: 'w1', ca, sol: 0.1 })).rejects.toThrow(/not resolved yet/);
    expect(r.buys).toHaveLength(1);                                           // no second buy was sent
    r.chain.height.value = 1_151;                                             // expired, never landed
    await r.clock.advance(5_000);
    await vi.waitFor(() => expect(manualJournal(r)).toEqual([]));
    await expect(r.trader.buy({ walletId: 'w1', ca, sol: 0.1 })).resolves.toMatchObject({ positionId: expect.any(String) });
    expect(r.buys).toHaveLength(2);
    r.trader.stop();
  });

  // ── FIX-BUY (2jeX..., 38HZ..., 2026-11-06) ───────────────────────────────────────────────────────────────────────────────────

  it('FIXBUY-T06 a buy the wallet cannot pay for is refused before the router: the error names the need and the balance, nothing is journalled, sent or told, and the lock is free again', async () => {
    const r = rig();
    const ca = newCa();
    r.sol.lamports = 89_010_967n;                                             // 2jeX: 0.0890 SOL held for a 0.1 SOL buy
    const err = await r.trader.buy({ walletId: 'w1', ca, sol: 0.1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/^Not enough SOL: buying 0\.1 SOL needs about 0\.1100 SOL/);
    expect(msg).toContain('the wallet has 0.0890 SOL');
    expect(msg).toMatch(/Nothing was sent\.$/);
    expect(msg.length, 'the Telegram reply shows at most 200 characters of an error').toBeLessThanOrEqual(200);
    expect(r.sol.calls).toEqual([WALLET.owner]);                             // the trading wallet's own balance, read once
    expect(r.buys).toEqual([]);                                               // the router was never asked: nothing was built, signed or sent
    expect(manualJournal(r)).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(r.store.listOpen()).toEqual([]);
    expect(r.outbox.events).toEqual([]);

    // the lock was released: a buy the wallet can pay right after goes to the router once
    await r.trader.buy({ walletId: 'w1', ca, sol: 0.005 });
    expect(r.buys.map(b => b.sol)).toEqual([0.005]);
    // the amount plus the 0.01 SOL headroom is enough; one lamport less is not
    r.sol.lamports = 110_000_000n;
    await r.trader.buy({ walletId: 'w1', ca: newCa(), sol: 0.1 });
    expect(r.buys).toHaveLength(2);
    r.sol.lamports = 109_999_999n;
    await expect(r.trader.buy({ walletId: 'w1', ca: newCa(), sol: 0.1 })).rejects.toThrow(/Not enough SOL: .*the wallet has 0\.1099 SOL/);
    // a balance that cannot be read refuses the buy (fail closed, as auto-buy does since A-129 c)
    r.sol.lamports = null;
    await expect(r.trader.buy({ walletId: 'w1', ca: newCa(), sol: 0.005 })).rejects.toThrow(/^The wallet balance could not be read, so nothing was sent\. Try again\.$/);
    expect(r.buys).toHaveLength(2);
    r.trader.stop();
  });

  it('FIXBUY-T07 a buy that reverted tells the owner why (the chain status error) and what it cost (the fill), and the phantom position is closed as before', async () => {
    const r = rig();
    const cases: Array<{ status: { err: unknown; confirmationStatus: string } | null; says: RegExp }> = [
      { status: { err: { InstructionError: [8, 'ComputationalBudgetExceeded'] }, confirmationStatus: 'confirmed' }, says: /failed on the chain: the route ran out of compute units\./ },
      { status: { err: { InstructionError: [3, { Custom: 1 }] }, confirmationStatus: 'confirmed' }, says: /failed on the chain: a step of the swap did not have enough SOL \(or tokens\) in the wallet\./ },
      { status: { err: 'InsufficientFundsForFee', confirmationStatus: 'confirmed' }, says: /failed on the chain: the wallet did not have enough SOL for the network fee\./ },
      { status: { err: { InstructionError: [5, 'ProgramFailedToComplete'] }, confirmationStatus: 'confirmed' }, says: /failed on the chain: the chain reported \{"InstructionError":\[5,"ProgramFailedToComplete"\]\}\./ },
      { status: null, says: /reverted on the chain\./ },                    // no readable status: the old words, still with the cost
    ];
    for (const c of cases) {
      const sig = newSig();
      r.smartBuyImpl.fn = async (_m, _s, opts) => {
        await opts?.onSigned?.({ sig, lastValidBlockHeight: 1_150, route: 'jupiter' });
        return { sig, route: 'jupiter', tokensOut: 1_000_000_000n, tokensOutQuoted: 1_000_000_000n, slippageBpsUsed: 300, sent: true, sigs: [sig] };
      };
      r.fills.buy = { solSpentLamports: '5002', tokensRaw: '0', feeLamports: '5002', confirmedAt: r.clock.now() };   // 38HZ: the fee only
      r.chain.statuses.set(sig, c.status);
      const res = await r.trader.buy({ walletId: 'w1', ca: newCa(), sol: 0.005 });
      await vi.waitFor(() => expect(r.store.get(res.positionId as string)?.closed_at).not.toBeNull());
      const notice = r.notices.find(n => n.includes(sig));
      expect(notice, JSON.stringify(c.status)).toBeDefined();
      expect(notice).toMatch(/^Buy did NOT land: \S+ /);
      expect(notice).toMatch(c.says);
      expect(notice).toContain('The position was closed; no tokens were received.');
      expect(notice).toContain('The transaction cost the wallet 0.000005002 SOL');
      expect(notice).toMatch(new RegExp(`Tx ${sig}\\.$`));
    }
    expect(r.notices).toHaveLength(cases.length);
    expect(r.outbox.of('position.closed')).toHaveLength(cases.length);
    expect(r.store.listOpen()).toEqual([]);
    r.trader.stop();
  });
});

describe('FIX-BUY the balance check in the app wiring', () => {
  it('FIXBUY-T06 the default wiring reads the wallet\'s native SOL (getBalance, confirmed) on the injected rpc before the router is asked, and refuses when it cannot', async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    let answer: unknown = { context: { slot: 9 }, value: 50_000_000 };
    const w = build({
      rpc: {
        async call(method, params) {
          calls.push({ method, params });
          if (method !== 'getBalance') return { value: [] };
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    });
    const app = createBotApp(w.deps);
    await expect(app.manual.buy({ walletId: 'w1', ca: newCa(), sol: 0.1 })).rejects.toThrow(/^Not enough SOL: buying 0\.1 SOL needs about 0\.1100 SOL .*the wallet has 0\.0500 SOL/);
    expect(calls).toEqual([{ method: 'getBalance', params: [WALLET.owner, { commitment: 'confirmed' }] }]);
    expect(w.router.calls).toEqual([]);

    // a read that fails, or an answer that is not a lamports value, refuses the buy; the keyed RPC URL in an error never reaches the log
    answer = new Error(`All RPCs failed for getBalance: ${w.deps.config.HELIUS_RPC}: 429`);
    await expect(app.manual.buy({ walletId: 'w1', ca: newCa(), sol: 0.1 })).rejects.toThrow(/balance could not be read/);
    for (const bad of [{ value: -1 }, { value: 1.5 }, { value: '01' }, { context: { slot: 1 } }, null, { value: [] }]) {
      answer = bad;
      await expect(app.manual.buy({ walletId: 'w1', ca: newCa(), sol: 0.1 }), JSON.stringify(bad)).rejects.toThrow(/balance could not be read/);
    }
    expect(w.router.calls).toEqual([]);
    expect(w.logs.join('\n')).not.toContain(w.secrets[3]);

    // funded: the buy goes to the router once
    answer = { context: { slot: 9 }, value: 5_000_000_000 };
    await app.manual.buy({ walletId: 'w1', ca: newCa(), sol: 0.1 });
    expect(w.router.calls).toHaveLength(1);
    app.manual.stop();
  });
});

// ── bot.ts holds none of the removed gates ───────────────────────────────────────────────────────

describe('bot.ts after the purge', () => {
  const src = fs.readFileSync(path.join(__dirname, 'bot', 'bot.ts'), 'utf8');
  it('has no /signal route, no score floor, no tier or dedup code, no old lane and no price-site or risk-report call', () => {
    for (const gone of [
      "app.post('/signal'", 'validateSignalBody', 'signalAuthMiddleware', 'BOT_SCORE_FLOOR', 'tierBlocklist', 'autoBuyMinScore', 'autoBuyHotFilter', 'autoBuySignalCount',
      'autoBuyOnUpgrade', 'scoreTiers', 'sentSignalCAs', 'shouldDedupAllow', 'REFIRE_CAP', "grade === 'RUG'", 'fullMsg', 'runOrderMonitor', 'runHardStopLossPass',
      'getDexPrice', 'getTokenMetaFromDex', 'fetchRugCheck', 'fetchGmgnToken', 'pickCanonicalPair', 'filterBlocksOnMissing', 'express()', '_autoSellInFlight',
    ]) {
      expect(src.includes(gone), `bot.ts still has: ${gone}`).toBe(false);
    }
  });

  it('says "Pumpstriker Bots" wherever a brand appears (A-7) and keeps every side effect behind main()', () => {
    expect(BRAND).toBe('Pumpstriker Bots');
    expect(src).not.toMatch(/Bathyr/i);
    expect(src).toMatch(/if \(require\.main === module\) \{\s*main\(\)/);
    // the top level of the module only declares: no Telegraf construction, no listen, no launch outside main()
    const outside = src.slice(0, src.indexOf('export async function main()'));
    expect(outside).not.toMatch(/new Telegraf\(/);
    expect(outside).not.toMatch(/\.launch\(/);
    expect(outside).not.toMatch(/\.listen\(/);
    expect(outside).not.toMatch(/setInterval\(/);
  });

  it('FIXBUY-T08 a manual buy that was only sent is reported as sent and not confirmed yet, never as bought; a refusal still reads "Buy failed: <reason>"', () => {
    const start = src.indexOf('async function runBuy(');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).not.toMatch(/Bought/);
    expect(body).toMatch(/Buy sent/);
    expect(body).toMatch(/not confirmed yet/);
    expect(body).toMatch(/if it fails on-chain/);
    expect(body).toContain('Buy failed: ${errText(e)}');
  });

  it('FIXBUY2-T31 (part-1 review P2) the buy reply promises an on-chain failure message only when a position was opened; with none it says the chain fill opens it, and a missing quote reads "none", not "0 tokens"', () => {
    const start = src.indexOf('async function runBuy(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toMatch(/const opened = result\.positionId !== null;/);
    expect(body).toMatch(/const after = opened\s*\?\s*'_You get a message if it fails on-chain\._'\s*:\s*'_No position was opened yet: the bot opens it only if the chain shows the buy landed\. Check \/positions\._';/);
    expect(body).toMatch(/const quoted = result\.tokenAmt > 0 \? `\$\{result\.tokenAmt\.toLocaleString\(\)\} tokens` : 'none';/);
    expect(body).toContain('• Quoted: ${quoted} (not confirmed yet)');
    expect(body).toContain('\\n${after}`');
    // the promise is never written unconditionally into the reply any more
    expect(body).not.toMatch(/\\n_You get a message if it fails on-chain\._`/);
    // both texts are legacy-Markdown safe: no underscore, asterisk, bracket or backtick inside the italic span
    for (const t of ['You get a message if it fails on-chain.', 'No position was opened yet: the bot opens it only if the chain shows the buy landed. Check /positions.']) {
      expect(t).not.toMatch(/[_*[\]`]/);
    }
  });

  it('wires the A-30 rule: no global fetch on an Engine call anywhere in the wiring', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.ts'), 'utf8');
    expect(app).not.toMatch(/\bfetch\(/);
    expect(app).not.toMatch(/node-fetch/);
    expect(src).not.toMatch(/\bfetch\(/);
  });
});

// ── the scripts (B6-T04, B6-T08 ... B6-T12) ──────────────────────────────────────────────────────
// vitest collects src/** only and tsc roots at src, so the two scripts are loaded by path at run time.

interface MigrateResult { status: string; reasons: string[]; refusals: Array<{ orderId: string }>; items: Array<{ ca: string; position: any; orders: any[]; skip: string | null }>; written: string[] }
interface MigrateMod {
  migratePositions(o: Record<string, unknown>): Promise<MigrateResult>;
  parseCutoverState(j: unknown): any;
  renderReport(r: MigrateResult): string[];
  main(argv: string[], out?: (l: string) => void): Promise<number>;
  migratedPositionId(ca: string, walletId: string): string;
}
interface CutoverMod {
  archiveBotData(o: Record<string, unknown>): { status: string; reasons: string[]; open: Array<{ state: string }>; files: Array<{ relName: string }>; archiveDir: string };
  verifyManifest(dir: string): string[];
  main(argv: string[], out?: (l: string) => void): Promise<number>;
}
async function loadScript<T>(name: string): Promise<T> {
  const file = path.join(__dirname, '..', 'scripts', name);
  return (await import(/* @vite-ignore */ file)) as T;
}

describe('the cutover scripts', () => {
  const sha = (f: string): string => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const treeOf = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = sha(p);
      }
    };
    walk(dir);
    return out;
  };

  const cleanups: string[] = [];
  afterAll(() => { for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true }); });
  const T0 = START_MS;                      // the clock of the exit-engine test world
  const rpc = { call: async () => ({ value: null }) };

  /** A temp bot data folder as the OLD bot left it: wallets (opaque), one open position with a TP, an SL and a TSL, and the other state files. */
  function oldBotData(): { dir: string; ca: string; owner: string; orders: any } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-oldbot-'));
    cleanups.push(dir);
    const ca = newCa();
    const owner = Keypair.generate().publicKey.toBase58();
    const positions = { [ca]: { ca, name: 'TestCoin', ticker: 'TST', wallets: { w1: { tokenAmount: 2_000_000_000, entryAmountSol: 0.2, entryTs: T0 - 3_600_000, txSigs: [newSig()], ownerAddress: owner } } } };
    const orders = { [ca]: [
      { id: 'tp1aaaaaaaa', walletId: 'w1', type: 'tp', triggerType: 'entryPrice', balance: 50, triggerPct: 100, highestMultiplier: 1, duration: 48, createdAt: T0 - 3_000_000, expiresAt: T0 + 80_000_000, active: true, baselineMulti: 0.8 },
      { id: 'sl1bbbbbbbb', walletId: 'w1', type: 'sl', triggerType: 'entryPrice', balance: 100, triggerPct: -20, highestMultiplier: 1, duration: 24, createdAt: T0 - 3_000_000, expiresAt: T0 + 80_000_000, active: true, baselineMulti: 0.8 },
      { id: 'ts1cccccccc', walletId: 'w1', type: 'tsl', triggerType: 'entryPrice', balance: 100, triggerPct: -25, armAfterPct: 50, highestMultiplier: 1.7, duration: 96, createdAt: T0 - 3_000_000, expiresAt: T0 + 80_000_000, active: true, baselineMulti: 0.8 },
      { id: 'old1dddddddd', walletId: 'w1', type: 'tp', balance: 100, triggerPct: 400, highestMultiplier: 1, duration: 24, createdAt: 1, expiresAt: 2, active: false, baselineMulti: 1 },
    ] };
    fs.writeFileSync(path.join(dir, 'positions.json'), JSON.stringify(positions, null, 2));
    fs.writeFileSync(path.join(dir, 'orders.json'), JSON.stringify(orders, null, 2));
    fs.writeFileSync(path.join(dir, 'sent-signals-dedup.json'), JSON.stringify([[ca, { ts: 1, score: 80 }]]));
    fs.writeFileSync(path.join(dir, 'autobuy-caps.json'), JSON.stringify({ v: 1, buys: [] }));
    fs.writeFileSync(path.join(dir, 'fires.csv'), 'ts,ca\n1,x\n');
    fs.writeFileSync(path.join(dir, 'wallets.json'), JSON.stringify([{ id: 'w1', name: 'Wallet 1', isDefault: true, enc: { opaque: crypto.randomBytes(16).toString('hex') } }]));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ global: {}, signal: {} }));
    return { dir, ca, owner, orders };
  }

  const holding = (owner: string, ca: string, atoms: number | null) => async (o: string) => {
    if (atoms === null) return null;
    return o === owner ? new Map([[ca, { rawAtoms: atoms, decimals: 6 }]]) : new Map<string, { rawAtoms: number; decimals: number }>();
  };
  const migrateOpts = (d: { dir: string; owner: string; ca: string }, atoms: number | null = 2_000_000_000, o: Record<string, unknown> = {}) => ({
    from: d.dir, execute: true, select: 'all', allBalances: holding(d.owner, d.ca, atoms), rpc, now: () => T0, ...o,
  });

  it('B6-T04 cutover-bot-data --execute --data-dir <temp> moves the listed files with a verifying manifest and leaves wallets.json (and settings, .env, the v2 files) untouched', async () => {
    const cut = await loadScript<CutoverMod>('cutover-bot-data.ts');
    const mig = await loadScript<MigrateMod>('migrate-positions-v2.ts');
    const d = oldBotData();
    fs.writeFileSync(path.join(d.dir, '.env'), 'DUMMY=1\n');
    // the position is migrated first (the cutover refuses otherwise, B6-T10)
    expect((await mig.migratePositions(migrateOpts(d))).status).toBe('migrated');

    const keep = ['wallets.json', 'settings.json', '.env', 'positions-v2.json', 'manual-orders-v2.json'].map(n => [n, sha(path.join(d.dir, n))] as const);
    const moving = ['positions.json', 'orders.json', 'sent-signals-dedup.json', 'autobuy-caps.json', 'fires.csv'].map(n => [n, sha(path.join(d.dir, n))] as const);

    const dry = cut.archiveBotData({ dataDir: d.dir, execute: false, date: '2026-10-19', now: () => T0 });
    expect(dry.status).toBe('dry_run');
    expect(fs.existsSync(path.join(d.dir, 'positions.json'))).toBe(true);   // a dry run moves nothing
    expect(dry.open.map(o => o.state)).toEqual(['migrated']);

    const r = cut.archiveBotData({ dataDir: d.dir, execute: true, date: '2026-10-19', now: () => T0 });
    expect(r.status).toBe('archived');
    const arch = path.join(d.dir, '_archive-2026-10-19');
    expect(r.archiveDir).toBe(arch);
    expect(r.files.map(f => f.relName).sort()).toEqual(['autobuy-caps.json', 'fires.csv', 'orders.json', 'positions.json', 'sent-signals-dedup.json']);
    for (const [n, h] of moving) {
      expect(fs.existsSync(path.join(d.dir, n)), `${n} moved out`).toBe(false);
      expect(sha(path.join(arch, n)), `${n} intact in the archive`).toBe(h);
    }
    expect(cut.verifyManifest(arch)).toEqual([]);                          // the manifest verifies

    for (const [n, h] of keep) expect(sha(path.join(d.dir, n)), `${n} untouched`).toBe(h);
    expect(fs.existsSync(path.join(arch, 'wallets.json'))).toBe(false);

    // a corrupted archive file no longer verifies
    fs.appendFileSync(path.join(arch, 'orders.json'), ' ');
    expect(cut.verifyManifest(arch).join(' ')).toMatch(/orders\.json/);
    // and a second --execute finds nothing left to move and leaves the archive alone
    const again = cut.archiveBotData({ dataDir: d.dir, execute: true, date: '2026-10-19', now: () => T0 });
    expect(again.files).toEqual([]);
    expect(cut.verifyManifest(arch).join(' ')).toMatch(/orders\.json/);     // still the corrupted state: nothing rewrote it
  });

  it('B6-T10 archiving with an unmigrated, unacknowledged open position is refused; --leave, an acknowledged state file and --accept-unmigrated are the ways through', async () => {
    const cut = await loadScript<CutoverMod>('cutover-bot-data.ts');
    const mig = await loadScript<MigrateMod>('migrate-positions-v2.ts');
    const d = oldBotData();
    const before = treeOf(d.dir);

    const refused = cut.archiveBotData({ dataDir: d.dir, execute: true, date: '2026-10-19', now: () => T0 });
    expect(refused.status).toBe('refused');
    expect(refused.open.map(o => o.state)).toEqual(['unresolved']);
    expect(refused.reasons.join(' ')).toContain(d.ca.slice(0, 6));
    expect(treeOf(d.dir)).toEqual(before);                                  // nothing moved
    expect(await cut.main(['--data-dir', d.dir, '--execute', '--date', '2026-10-19'], () => undefined)).toBe(1);
    expect(await cut.main(['--data-dir', d.dir, '--dry-run'], () => undefined)).toBe(1);   // a dry run shows the same refusal
    expect(await cut.main(['--data-dir', 'relative/path'], () => undefined)).toBe(2);       // no default folder
    expect(treeOf(d.dir)).toEqual(before);

    // "leave unmanaged" without a written acknowledgement does not count; with one it does
    const state = path.join(d.dir, 'cutover-state.json');
    fs.writeFileSync(state, JSON.stringify({ positions: { [`${d.ca}:w1`]: { choice: 'leave' } } }));
    expect(await cut.main(['--data-dir', d.dir, '--state', state, '--execute', '--date', '2026-10-19'], () => undefined)).toBe(1);
    expect(treeOf(d.dir)).not.toEqual({});                                   // (the state file itself is new; the rest is unchanged)
    fs.writeFileSync(state, JSON.stringify({ positions: { [`${d.ca}:w1`]: { choice: 'leave', ack: 'I keep this one by hand' } } }));
    const parsed = mig.parseCutoverState(JSON.parse(fs.readFileSync(state, 'utf8')));
    const viaState = cut.archiveBotData({ dataDir: d.dir, execute: false, state: parsed, date: '2026-10-19' });
    expect(viaState.status).toBe('dry_run');
    expect(viaState.open.map(o => o.state)).toEqual(['left']);
    expect(cut.archiveBotData({ dataDir: d.dir, execute: false, leave: new Set([`${d.ca}:w1`]), date: '2026-10-19' }).status).toBe('dry_run');

    // the user's explicit choice
    const forced = cut.archiveBotData({ dataDir: d.dir, execute: true, acceptUnmigrated: true, date: '2026-10-19', now: () => T0 });
    expect(forced.status).toBe('archived');
    expect(fs.existsSync(path.join(d.dir, 'positions.json'))).toBe(false);
    expect(fs.existsSync(path.join(d.dir, 'wallets.json'))).toBe(true);
  });

  it('B6-T08 migrate-positions-v2 as a dry run writes nothing (not even the manifest) and prints each source record next to its target record', async () => {
    const mig = await loadScript<MigrateMod>('migrate-positions-v2.ts');
    const d = oldBotData();
    const before = treeOf(d.dir);
    const plan = await mig.migratePositions(migrateOpts(d, 2_000_000_000, { execute: false }));
    expect(plan.status).toBe('dry_run');
    expect(plan.written).toEqual([]);
    expect(plan.items[0].position).not.toBeNull();
    expect(treeOf(d.dir)).toEqual(before);

    // through the CLI entry point (nothing selected, so no chain read): the plan is printed, still nothing is written
    const lines: string[] = [];
    expect(await mig.main(['--from', d.dir], l => lines.push(l))).toBe(0);
    expect(treeOf(d.dir)).toEqual(before);
    const text = lines.join('\n');
    expect(text).toContain('dry_run');
    expect(text).toContain(d.ca);
    expect(text).toMatch(/source: tokenAmount=2000000000 entryAmountSol=0\.2/);
    expect(text).toMatch(/not selected/);
    expect(text).not.toMatch(/secret|private|keypair|enc"/i);
    // the report of a selected position shows the target next to the source
    const rep = mig.renderReport(plan).join('\n');
    expect(rep).toMatch(/source: tokenAmount=2000000000/);
    expect(rep).toMatch(/target: mig_[0-9a-f]{24} origin=manual policy_id=MANUAL tokens=2000000000/);
    expect(rep).toMatch(/order tp1aaaaaaaa: tp trigger_pct=100 sell_pct=50 baseline_multi=0\.8/);
  });

  it('B6-T09 a migrated manual position with an active SL, TP and TSL, archived: the B30 engine fires each trigger at the same relative move as runOrderMonitorPass, with the same baselineMulti', async () => {
    const mig = await loadScript<MigrateMod>('migrate-positions-v2.ts');
    const cut = await loadScript<CutoverMod>('cutover-bot-data.ts');
    const d = oldBotData();
    const r = await mig.migratePositions(migrateOpts(d));
    expect(r.status).toBe('migrated');
    const item = r.items[0];
    const pid = item.position.position_id as string;
    // the target keeps the entry basis, so triggers stay relative to the real entry; the orders are copied unchanged, never reset to presets
    expect(item.position).toMatchObject({ origin: 'manual', signal_id: null, policy_id: 'MANUAL', policy_version: null, arm: null, tokens: '2000000000', original_tokens: '2000000000' });
    expect(item.position.basis_sol_per_token).toBeCloseTo(0.2 / 2_000_000_000, 20);
    expect(item.position.entry).toMatchObject({ sol_spent_lamports: '200000000', fill_source: 'unverified' });
    expect(item.orders.map((o: any) => [o.type, o.trigger_pct, o.baseline_multi, o.expires_at])).toEqual([
      ['tp', 100, 0.8, T0 + 80_000_000], ['sl', -20, 0.8, T0 + 80_000_000], ['tsl', -25, 0.8, T0 + 80_000_000],
    ]);
    expect(item.orders.find((o: any) => o.type === 'tsl')).toMatchObject({ peak_rel: 1.7, arm_after_pct: 50, sell_pct: 100 });
    expect(item.orders.find((o: any) => o.type === 'tp')).toMatchObject({ sell_pct: 50 });
    expect(cut.archiveBotData({ dataDir: d.dir, execute: true, date: '2026-10-19', now: () => T0 }).status).toBe('archived');   // archive after the migration

    // The legacy decision, as runOrderMonitorPass took it: multi = curSol / entryAmountSol, rel = multi / baselineMulti,
    // TP fires at (rel - 1) * 100 >= triggerPct, SL at <= triggerPct, TSL through evaluateTsl.
    const rel = (curSol: number): number => (curSol / 0.2) / 0.8;
    const legacy = {
      tp: (cur: number): boolean => (rel(cur) - 1) * 100 >= 100,
      sl: (cur: number): boolean => (rel(cur) - 1) * 100 <= -20,
      tsl: (cur: number): boolean => evaluateTsl({ triggerPct: -25, armAfterPct: 50, highestMultiplier: 1.7 }, rel(cur)).triggered,
    };
    const ATOMS = 2_000_000_000n;
    /** A fresh engine over a COPY of the migrated files, with only `only` active, and the whole bag worth `cur` SOL. */
    async function engineAt(only: 'tp' | 'sl' | 'tsl', cur: number) {
      const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-b6t09-'));
      cleanups.push(copy);
      for (const n of ['positions-v2.json', 'manual-orders-v2.json']) fs.copyFileSync(path.join(d.dir, n), path.join(copy, n));
      const w = makeWorld(copy);
      for (const o of w.store.ordersOf(pid)) if (o.type !== only) w.store.updateOrder(o.order_id, { active: false });
      w.balances.set(d.ca, ATOMS);
      w.price.set(d.ca, cur / Number(ATOMS));
      await w.passAt(5_000);
      return w;
    }
    // just before and just after each trigger (1% of margin, so float noise at the exact threshold decides nothing)
    const cases: Array<['tp' | 'sl' | 'tsl', number]> = [
      ['tp', 0.31], ['tp', 0.33], ['sl', 0.14], ['sl', 0.12], ['tsl', 0.25], ['tsl', 0.20],
    ];
    for (const [type, cur] of cases) {
      const w = await engineAt(type, cur);
      const fired = w.sells.length > 0;
      expect(fired, `${type} at ${cur} SOL: legacy ${legacy[type](cur)}, engine ${fired}`).toBe(legacy[type](cur));
      const o = w.store.ordersOf(pid).find(x => x.type === type)!;
      if (!fired) {
        expect(o.active).toBe(true);
        expect(o.baseline_multi).toBe(0.8);                              // the baseline is never reset
      } else {
        expect(w.legs().map(l => [l.leg, l.status])).toEqual([['MANUAL', 'filled']]);
        expect(w.sells[0].tokens).toBe(type === 'tp' ? ATOMS / 2n : ATOMS);   // the order's own sell percentage of the holding
      }
    }
    expect(legacy.tp(0.33) && !legacy.tp(0.31) && legacy.sl(0.12) && !legacy.sl(0.14) && legacy.tsl(0.2) && !legacy.tsl(0.25)).toBe(true);
  });

  it('B6-T11 a second migrate --execute is a no-op: refused because the positions are already migrated, the files byte-identical', async () => {
    const mig = await loadScript<MigrateMod>('migrate-positions-v2.ts');
    const d = oldBotData();
    expect((await mig.migratePositions(migrateOpts(d))).status).toBe('migrated');
    const after1 = treeOf(d.dir);
    const second = await mig.migratePositions(migrateOpts(d, 2_000_000_000, { now: () => T0 + 60_000 }));
    expect(second.status).toBe('refused');
    expect(second.reasons.join(' ')).toMatch(/already migrated/);
    expect(treeOf(d.dir)).toEqual(after1);
    // the CLI refuses with exit code 1 as well (before it reads the chain)
    const lines: string[] = [];
    expect(await mig.main(['--from', d.dir, '--execute', '--migrate-all'], l => lines.push(l))).toBe(1);
    expect(lines.join(' ')).toMatch(/already migrated/);
    expect(treeOf(d.dir)).toEqual(after1);
  });

  it('B6-T12 an old orders.json with an unknown order type is refused, the refusal names the order, and nothing is written', async () => {
    const mig = await loadScript<MigrateMod>('migrate-positions-v2.ts');
    const d = oldBotData();
    d.orders[d.ca].push({ id: 'zz9weirdorder', walletId: 'w1', type: 'oco', balance: 100, triggerPct: 30, highestMultiplier: 1, duration: 24, createdAt: 1, expiresAt: T0 + 1000, active: true });
    fs.writeFileSync(path.join(d.dir, 'orders.json'), JSON.stringify(d.orders, null, 2));
    const before = treeOf(d.dir);
    const r = await mig.migratePositions(migrateOpts(d));
    expect(r.status).toBe('refused');
    expect(r.refusals.map(x => x.orderId)).toEqual(['zz9weirdorder']);
    expect(r.reasons.join(' ')).toContain('zz9weirdorder');
    expect(r.reasons.join(' ')).toContain('oco');
    expect(treeOf(d.dir)).toEqual(before);
    expect(fs.existsSync(path.join(d.dir, 'positions-v2.json'))).toBe(false);
    expect(fs.existsSync(path.join(d.dir, 'manual-orders-v2.json'))).toBe(false);
    // a dry run refuses just the same
    expect((await mig.migratePositions(migrateOpts(d, 2_000_000_000, { execute: false }))).status).toBe('refused');
    // an INACTIVE order of an unknown type is not a reason to refuse
    d.orders[d.ca][d.orders[d.ca].length - 1].active = false;
    fs.writeFileSync(path.join(d.dir, 'orders.json'), JSON.stringify(d.orders, null, 2));
    expect((await mig.migratePositions(migrateOpts(d, 2_000_000_000, { execute: false }))).status).toBe('dry_run');
  });

  it('migrates only what the chain still shows: a confirmed zero, an unreadable scan and an unknown wallet skip the record with a reason; a smaller chain amount scales the cost', async () => {
    const mig = await loadScript<MigrateMod>('migrate-positions-v2.ts');
    const zero = oldBotData();
    const r0 = await mig.migratePositions(migrateOpts(zero, 2_000_000_000, { execute: false, allBalances: async () => new Map() }));
    expect(r0.items[0].position).toBeNull();
    expect(r0.items[0].skip).toMatch(/holds none/);
    const unreadable = oldBotData();
    const r1 = await mig.migratePositions(migrateOpts(unreadable, null, { execute: false }));
    expect(r1.items[0].position).toBeNull();
    expect(r1.items[0].skip).toMatch(/wallet scan failed/);
    // with nothing migratable an --execute writes nothing and says so
    const r1x = await mig.migratePositions(migrateOpts(unreadable, null));
    expect(r1x.status).toBe('refused');
    expect(fs.existsSync(path.join(unreadable.dir, 'positions-v2.json'))).toBe(false);

    // no ownerAddress anywhere
    const d1 = oldBotData();
    const p = JSON.parse(fs.readFileSync(path.join(d1.dir, 'positions.json'), 'utf8'));
    delete p[d1.ca].wallets.w1.ownerAddress;
    fs.writeFileSync(path.join(d1.dir, 'positions.json'), JSON.stringify(p));
    const noOwner = await mig.migratePositions(migrateOpts(d1, 2_000_000_000, { execute: false }));
    expect(noOwner.items[0].skip).toMatch(/wallet address unknown/);
    const withFlag = await mig.migratePositions(migrateOpts(d1, 2_000_000_000, { execute: false, owners: { w1: d1.owner } }));
    expect(withFlag.items[0].position).not.toBeNull();

    // the chain holds less than the books say: migrated at the chain amount, the cost scaled the same way, the entry price unchanged
    const d2 = oldBotData();
    const r2 = await mig.migratePositions(migrateOpts(d2, 1_000_000_000, { execute: false }));
    expect(r2.items[0].position).toMatchObject({ tokens: '1000000000' });
    expect(r2.items[0].position.entry.sol_spent_lamports).toBe('100000000');
    expect(r2.items[0].position.basis_sol_per_token).toBeCloseTo(0.2 / 2_000_000_000, 20);

    // nothing is selected without a choice: --execute needs one; the choice of cutover-state.json counts
    const lines: string[] = [];
    expect(await mig.main(['--from', d2.dir, '--execute'], l => lines.push(l))).toBe(1);
    expect(lines.join(' ')).toMatch(/needs a selection/);
    const state = mig.parseCutoverState({ botDataDir: d2.dir, positions: { [`${d2.ca}:w1`]: { choice: 'b' } } }) as { choices: Map<string, { choice: string }> };
    expect(state.choices.get(`${d2.ca}:w1`)?.choice).toBe('migrate');
    const chosen = await mig.migratePositions(migrateOpts(d2, 2_000_000_000, { execute: false, select: new Set<string>(), state }));
    expect(chosen.items[0].position).not.toBeNull();
    const notChosen = await mig.migratePositions(migrateOpts(d2, 2_000_000_000, { execute: false, select: new Set<string>() }));
    expect(notChosen.items[0].position).toBeNull();
  });
});

// ── A-93f (orchestrator fix, rb/FIX-BOT): the arm verdicts at boot ───────────────────────────────

describe('A-93f arm verdicts after a restart', () => {
  it('FIXBOT-T06 the arm verdicts are read before the events server listens (with retries), re-read every 10 s while unknown and when the Engine comes back, and live auto-buy tells the owner it is blind', async () => {
    const armsPayload = fixture<{ payload: ArmsStatusPayload }>('arms.status').payload;
    const order: string[] = [];
    const engineOf = (failFirst: number): { client: EngineClient; calls: () => number } => {
      let n = 0;
      return {
        calls: () => n,
        client: {
          async arms() { n++; order.push('arms'); return n <= failFirst ? { error: 'engine_offline' } : JSON.parse(JSON.stringify(armsPayload)); },
          async token() { return { error: 'engine_offline' }; },
          async price() { return { error: 'engine_offline' }; },
        },
      };
    };

    // (a) the Engine is still booting: two failed reads, the third works, all before the server listens
    const e1 = engineOf(2);
    const w1 = build({ engine: e1.client });
    const app1 = createBotApp(w1.deps);
    const realListen = app1.events.listen.bind(app1.events);
    vi.spyOn(app1.events, 'listen').mockImplementation(async (p?: number) => { order.push('listen'); return realListen(p); });
    running.push(await app1.start());
    expect(order).toEqual(['arms', 'arms', 'arms', 'listen']);

    // (b) the Engine stays down: re-read every 10 s, not every 5 minutes; and once more when the Engine is back
    let healthUp = false;
    const e2 = engineOf(Number.MAX_SAFE_INTEGER);
    const w2 = build({ engine: e2.client });
    const fakeHttp = w2.deps.http!;
    w2.deps.http = async req => {
      if (req.method === 'GET' && req.url.endsWith('/health')) {
        if (!healthUp) throw new Error('connect ECONNREFUSED');
        return { status: 200, body: JSON.stringify({ ok: true, runId: 'run-2' }) };
      }
      return fakeHttp(req);
    };
    const app2 = createBotApp(w2.deps);
    running.push(await app2.start());
    const atBoot = e2.calls();
    expect(atBoot).toBeGreaterThanOrEqual(2);
    await w2.clock.advance(10_000);
    expect(e2.calls()).toBeGreaterThan(atBoot);
    const beforeBack = e2.calls();
    await app2.engineWatch.probeOnce();                                       // down
    healthUp = true;
    await app2.engineWatch.probeOnce();                                       // back: the verdicts are read again at once
    await w2.clock.settle();
    expect(e2.calls()).toBeGreaterThan(beforeBack);

    // (c) live auto-buy whose verdicts are unknown after a restart tells the owner once
    const h = makeHarness();
    await h.goLive();
    const h2 = h.restart();
    expect((await h2.run()).d).toMatchObject({ action: 'skip', reason: 'off' });
    await h2.run();
    expect(h2.notices.filter(n => /verdicts/.test(n))).toHaveLength(1);
    expect(await h2.svc.refreshArms()).toBe(true);
    expect((await h2.run()).d.action).toBe('buy');
  });
});


// ── R7-W6: the wallet link routes inside the app: mounting, isolation from the server path, the final guard ───────────────────────────────────

const BOT_ROOT = path.resolve(__dirname, '..');
const WALLET_ROUTES = Object.keys(WALLET_LINK_PATHS) as WalletLinkRoute[];
const walletKey = (i: number): string => bs58.encode(crypto.createHash('sha256').update(`ps-fixture-${i}`).digest());

/** Wallet operations that answer plain valid bodies (no transaction is built) and count their calls. */
function walletStub(): { ops: WalletLinkOps; calls: string[] } {
  const calls: string[] = [];
  const ops: WalletLinkOps = {
    async quote() { calls.push('quote'); return { ok: false, code: 'no-route', reason: 'stub: no route' }; },
    async fill() {
      calls.push('fill');
      return { ok: true, fill: { status: 'not-landed', reason: null, solDeltaLamports: null, feeLamports: null, rentPaidLamports: null, tokenDeltaRaw: null, decimals: null, slot: null, blockTime: null } };
    },
    async find() { calls.push('find'); return { ok: true, signatures: [] }; },
    async balances() { calls.push('balances'); return { ok: true, balances: { solLamports: '1500000000', tokens: [], readAt: FIXTURE_NOW, slot: 250_000_002 } }; },
    async closeQuote() { calls.push('closeQuote'); return { ok: false, code: 'nothing-to-close', reason: 'stub: nothing to close' }; },
    async closeFill() {
      calls.push('closeFill');
      return { ok: true, fill: { status: 'not-landed', reason: null, solDeltaLamports: null, feeLamports: null, rentReturnedLamports: null, slot: null, blockTime: null } };
    },
  };
  return { ops, calls };
}
function walletBody(route: WalletLinkRoute): Record<string, unknown> {
  const owner = walletKey(0);
  const mint = walletKey(1);
  switch (route) {
    case 'quote': return { owner, side: 'buy', mint, amountLamports: '50000000', slippageBps: 3000, maxImpactPct: 15, maxSpendLamports: null, feeLevel: 'normal', maxTxBytes: 1100 };
    case 'fill': return { owner, signature: newSig(), side: 'buy', mint, quoteRef: 'quote-ref-1', submittedAt: FIXTURE_NOW - 5000, final: false };
    case 'find': return { owner, mint, side: 'buy', sinceSlot: 250_000_000 };
    case 'balances': return { owner };
    case 'closeQuote': return { owner, kind: 'empty', excluded: [] };
    case 'closeFill': return { owner, signature: newSig(), submittedAt: FIXTURE_NOW - 5000, final: false };
    default: throw new Error('unknown wallet route');
  }
}

describe('the wallet link routes inside the app (R7-W6)', () => {
  it('WBL-T10 WALLET_LINK_ROUTES=0 leaves the six routes out (404 like any unknown path); on, they are mounted behind the link auth and the boot line says so without an address or a key', async () => {
    const off = walletStub();
    const wOff = build({ walletLink: off.ops }, { WALLET_LINK_ROUTES: '0' });
    const appOff = createBotApp(wOff.deps);
    expect(appOff.walletLinkRoutes).toBe(false);
    const sOff = await appOff.events.listen(0);
    servers.push(sOff);
    for (const route of WALLET_ROUTES) {
      const r = await send(sOff.port, wOff.linkSecret, { path: WALLET_LINK_PATHS[route], body: JSON.stringify(walletBody(route)) });
      expect(r.status, `off: ${route}`).toBe(404);
      expect(r.json).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(off.calls).toEqual([]);
    expect(appOff.bootLines().join('\n')).toMatch(/wallet link routes off/);

    const on = walletStub();
    const wOn = build({ walletLink: on.ops });
    const appOn = createBotApp(wOn.deps);
    expect(appOn.walletLinkRoutes, 'the default is on').toBe(true);
    const sOn = await appOn.events.listen(0);
    servers.push(sOn);
    for (const route of WALLET_ROUTES) {
      const refused = await send(sOn.port, wOn.linkSecret, { path: WALLET_LINK_PATHS[route], headers: { authorization: '' }, body: JSON.stringify(walletBody(route)) });
      expect(refused.status, `on, no bearer: ${route}`).toBe(401);
      const r = await send(sOn.port, wOn.linkSecret, { path: WALLET_LINK_PATHS[route], body: JSON.stringify(walletBody(route)) });
      expect(r.status, `on: ${route}`).toBe(200);
      expect(typeof r.json?.ok).toBe('boolean');
    }
    expect(on.calls).toEqual(['quote', 'fill', 'find', 'balances', 'closeQuote', 'closeFill']);
    const line = appOn.bootLines().find(l => /^wallet link routes/.test(l)) ?? '';
    expect(line).toMatch(/^wallet link routes on/);
    for (const secret of [...wOn.secrets, walletKey(0), walletKey(1)]) expect(line).not.toContain(secret);

    // boot logs the line
    const w3 = build({ walletLink: on.ops });
    const run = await boot(w3.deps);
    running.push(run);
    expect(w3.logs.join('\n')).toMatch(/wallet link routes on/);
    await run.stop();
  });

  it('WBL-T08 wallet routes never touch the positions store, auto-buy, the exit engine, the manual-buy journal, the cancel requests, the send queue or Telegram (spies, the data folder and the import closure)', async () => {
    const w = build();
    // every server-path collaborator is counted
    const touched: string[] = [];
    const count = <F extends (...a: any[]) => any>(name: string, f: F): F => ((...a: unknown[]) => { touched.push(name); return f(...a); }) as F;
    const d = w.deps;
    d.smartBuy = count('smartBuy', d.smartBuy!);
    d.smartSell = count('smartSell', d.smartSell!);
    d.splBalance = count('splBalance', d.splBalance!);
    d.walletBalanceSol = count('walletBalanceSol', d.walletBalanceSol!);
    d.decimals = count('decimals', d.decimals!);
    d.rpc = { call: count('rpc.call', d.rpc!.call.bind(d.rpc!)) };
    d.closeAccount = { closeIfEmpty: count('closeAccount', d.closeAccount!.closeIfEmpty.bind(d.closeAccount!)) } as typeof d.closeAccount;
    d.fills = { buyFill: count('fills.buyFill', d.fills!.buyFill.bind(d.fills!)), sellFill: count('fills.sellFill', d.fills!.sellFill.bind(d.fills!)) };
    d.onchain = { quoteSell: count('onchain.quoteSell', d.onchain!.quoteSell.bind(d.onchain!)) };
    const stub = walletStub();
    d.walletLink = stub.ops;
    const app = createBotApp(d);
    const spied: Array<{ mock: { calls: unknown[] }; getMockName(): string }> = [];
    for (const [name, part] of Object.entries({ store: app.store, autoBuy: app.autoBuy, exits: app.exits, queue: app.queue, intake: app.intake, manual: app.manual, outbox: app.outbox, inbox: app.inbox })) {
      const obj = part as unknown as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        if (typeof obj[k] !== 'function') continue;
        spied.push(vi.spyOn(obj as Record<string, (...a: unknown[]) => unknown>, k).mockName(`${name}.${k}`));
      }
    }
    expect(spied.length, 'the spies really cover the server path').toBeGreaterThan(30);
    const snapshot = (): string => fs.readdirSync(w.dir).sort().map(f => { const st = fs.statSync(path.join(w.dir, f)); return `${f}:${st.size}:${st.mtimeMs}`; }).join('|');
    const before = snapshot();
    const s = await app.events.listen(0);
    servers.push(s);

    for (const route of WALLET_ROUTES) {
      const r = await send(s.port, w.linkSecret, { path: WALLET_LINK_PATHS[route], body: JSON.stringify(walletBody(route)) });
      expect(r.status, route).toBe(200);
    }
    // a refused and a malformed request touch nothing either
    await send(s.port, w.linkSecret, { path: WALLET_LINK_PATHS.quote, headers: { authorization: '' }, body: '{}' });
    await send(s.port, w.linkSecret, { path: WALLET_LINK_PATHS.fill, body: '{"nope":1}' });
    expect(stub.calls).toEqual(['quote', 'fill', 'find', 'balances', 'closeQuote', 'closeFill']);

    expect(touched, 'no execution function, RPC call, balance read or fill read of the server path').toEqual([]);
    const hit = spied.filter(sp => sp.mock.calls.length > 0).map(sp => sp.getMockName());
    expect(hit, 'no method of the store, auto-buy, the exit engine, the send queue, the intake, the manual trader, the outbox or the inbox').toEqual([]);
    expect(w.tg.calls, 'no Telegram message').toEqual([]);
    expect(w.engine.bodies, 'nothing posted to the Engine').toEqual([]);
    expect(snapshot(), 'the data folder is untouched (no positions, journal, cancel-request or caps file written)').toBe(before);
    expect(fs.existsSync(path.join(w.dir, MANUAL_BUYS_FILE))).toBe(false);

    // positive controls: the same spies and counters do see a call of the server path
    app.store.listOpen();
    await d.rpc!.call('getHealth', []);
    expect(spied.filter(sp => sp.mock.calls.length > 0).map(sp => sp.getMockName())).toEqual(['store.listOpen']);
    expect(touched).toEqual(['rpc.call']);

    // statically: the import closure of src/wallet-link reaches none of the server path
    const ctx = new ScanContext(BOT_ROOT);
    const entries = ctx.select({ include: ['src/wallet-link/**'] }).map(f => f.rel).filter(rel => /\.tsx?$/.test(rel));
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const closure = importClosure(ctx, entries).files;
    const forbidden = [
      /^src\/(autobuy|exits|intake|tg|data|scanners)\//, /^src\/bot\/(?!secret-guard\.ts$)/, /^src\/app\.ts$/, /^src\/link\/(engine-outbox|inbox|engine-client|engine-watch|events-server)\.ts$/,
      /manual-buy-journal|cancel-requests|launch-supervisor|send-queue|positions-store/,
      /^src\/execution\/(router|jupiter|pumpfun-swap|pumpswap-swap|close-account|fills|exec-common|curve-state|onchain-quote|tx-verify|send-context|pumpfun-info|unclaimedsol)\.ts$/,
    ];
    const reached = closure.filter(f => forbidden.some(re => re.test(f)));
    expect(reached, 'files of the server path in the closure of src/wallet-link').toEqual([]);
    for (const f of closure) {
      const text = fs.readFileSync(path.join(BOT_ROOT, f), 'utf8');
      expect(/\b(autoBuy|createExitEngine|openManualBuyJournal|openCancelRequests|createSendQueue|createPositionsStore)\b/.test(text), `${f} names a server-path part`).toBe(false);
    }

    // the wallet bucket: the same server-path RPC schedule (the real resilientRpcCall, every 250 ms of fake time, 20 times) with and without a quote build,
    // fill polls, a balance read, a find and a close build queued behind a wallet bucket of 1 call per second, on one fake clock
    const idle = await bucketScenario(false);
    const busy = await bucketScenario(true);
    expect(idle.serverAt).toEqual(new Array(SERVER_STEPS).fill(0));
    expect(busy.serverAt, 'every server-path call reached the node at the instant it was made').toEqual(idle.serverAt);
    expect(busy.serverDoneAt, 'and was answered without waiting on the wallet bucket').toEqual(idle.serverDoneAt);
    expect(idle.walletAt, 'no wallet traffic in the baseline').toEqual([]);
    // the wallet traffic really did saturate its bucket: at most 1 + 5 calls got through in the 5 s, the requests are still waiting behind it
    expect(busy.walletAt.length).toBeGreaterThanOrEqual(1);
    expect(busy.walletAt.length).toBeLessThanOrEqual(6);
    expect(busy.pending, 'wallet requests still queued behind the bucket').toBeGreaterThan(0);
    expect(busy.walletRequests).toBe(8);
  });

  it('WBL-T12 wallet-link never sets testOnlyPumpSwapRoute or builds a PumpPortal route; the wallet routes sit before the /v1 catch-all; the final bot guard scans the wallet-link closure (G-S19 scanned > 0) and finds it clean', async () => {
    for (const f of ['src/wallet-link/handler.ts', 'src/wallet-link/routes.ts', 'src/app.ts', 'src/config.ts']) {
      const text = fs.readFileSync(path.join(BOT_ROOT, f), 'utf8');
      expect(text, `${f} names testOnlyPumpSwapRoute`).not.toMatch(/testOnlyPumpSwapRoute/);
      expect(text, `${f} names the removed PumpPortal wallet key`).not.toMatch(/WALLET_ALLOW_PUMPPORTAL_BUILD/);
    }

    const stub = walletStub();
    const w = build({ walletLink: stub.ops });
    const app = createBotApp(w.deps);
    const s = await app.events.listen(0);
    servers.push(s);
    // ahead of the catch-all: a wallet route answers, everything else under /v1 is still the JSON 404
    expect((await send(s.port, w.linkSecret, { path: WALLET_LINK_PATHS.balances, body: JSON.stringify(walletBody('balances')) })).status).toBe(200);
    for (const [method, p] of [['POST', '/v1/nothing'], ['GET', '/v1/events'], ['POST', '/v1/wallet/nothing'], ['GET', WALLET_LINK_PATHS.quote], ['POST', '/v1/walletquote']] as const) {
      const r = await send(s.port, w.linkSecret, { path: p, method, body: method === 'POST' ? '{}' : undefined });
      expect(r.status, `${method} ${p}`).toBe(404);
      expect(r.json).toMatchObject({ ok: false, code: 'invalid' });
    }

    // the final bot guards, empty exemption map: G-S19 scans the closure of src/wallet-link and finds nothing
    const res = runGuard('G-S19', { root: BOT_ROOT, exemptions: {} });
    expect(res.scanned).toBeGreaterThan(0);
    expect(res.violations).toEqual([]);
    const all = runAllGuards({ root: BOT_ROOT, exemptions: {} });
    expect(Object.values(all).flatMap(g => g.violations)).toEqual([]);
    expect(all['G-S19'].scanned).toBe(res.scanned);
  });
});

// ── R7-W6: the default wiring against a mock RPC node (the real wallet port, budget and builders) ──────────────────────────────────

interface MockRpc { url: string; arrivals: Array<{ at: number; method: string }>; answers: Map<string, (params: any[]) => unknown>; close(): Promise<void> }
/** A JSON-RPC node on 127.0.0.1:0. Every request is stamped with the FakeClock; `answers` holds the scripted results by method. */
async function startMockRpc(clock: { now(): number }): Promise<MockRpc> {
  const arrivals: MockRpc['arrivals'] = [];
  const answers: MockRpc['answers'] = new Map();
  const slot = 301;
  const defaults: Record<string, (p: any[]) => unknown> = {
    getBlockHeight: () => 1_000,
    getBalance: () => ({ context: { slot }, value: 5_000_000_000 }),
    getTokenAccountsByOwner: () => ({ context: { slot }, value: [] }),
    getMultipleAccounts: p => ({ context: { slot }, value: (p[0] as string[]).map(() => null) }),
    getMinimumBalanceForRentExemption: () => 2_039_280,
    getSignaturesForAddress: () => [],
    getTransaction: () => null,
    getSignatureStatuses: () => ({ context: { slot }, value: [null] }),
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string; params: any[] };
      arrivals.push({ at: clock.now(), method: body.method });
      const make = answers.get(body.method) ?? defaults[body.method];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(make ? { jsonrpc: '2.0', id: body.id, result: make(body.params) } : { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not scripted' } }));
    });
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, arrivals, answers, close: () => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections?.(); }) };
}

/** Runs `fn` with process.env.RPC_URL / RPC_FALLBACKS=off (the A-68 single-endpoint override both RPC paths of the bot honour), then restores them. */
async function withRpcOverride<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const saved = { RPC_URL: process.env.RPC_URL, RPC_FALLBACKS: process.env.RPC_FALLBACKS };
  process.env.RPC_URL = url;
  process.env.RPC_FALLBACKS = 'off';
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** Waits for a request whose handler sleeps on the fake clock (the wallet bucket): the clock moves 250 ms at a time until the answer is in. */
async function pump<T>(clock: FakeClock, p: Promise<T>): Promise<T> {
  let done = false;
  const result = p.finally(() => { done = true; });
  result.catch(() => undefined);
  while (!done) {
    await clock.advance(250);
    await new Promise<void>(r => { setTimeout(r, 2); });
  }
  return result;
}

const SERVER_STEPS = 20;
const SERVER_STEP_MS = 250;
/**
 * One run of the timing scenario: the app's REAL server-path RPC (resilientRpcCall) asks for the block height every 250 ms of fake time, 20 times
 * (the landed-check read of auto-buy and the exits). With \`wallet\` set, a quote build, two fill polls, a balance read, a find and a close build are
 * started first, and the wallet bucket is 1 call per second: they queue behind it for the whole run.
 */
async function bucketScenario(wallet: boolean): Promise<{ serverAt: number[]; serverDoneAt: number[]; walletAt: number[]; walletRequests: number; pending: number }> {
  const w = build({}, { WALLET_RPC_MAX_PER_SEC: '1', WALLET_RPC_DAILY_CALL_CAP: '100000' });
  const mock = await startMockRpc(w.clock);
  try {
    return await withRpcOverride(mock.url, async () => {
      w.deps.rpc = undefined;                                  // the default server-path RPC: the real one, on the same mock node
      w.deps.env = { ...w.deps.env, RPC_URL: mock.url, RPC_FALLBACKS: 'off' };
      const app = createBotApp(w.deps);
      const s = await app.events.listen(0);
      servers.push(s);
      let pending = 0;
      let walletRequests = 0;
      if (wallet) {
        const fire = (route: WalletLinkRoute, body: Record<string, unknown>): void => {
          pending++; walletRequests++;
          void send(s.port, w.linkSecret, { path: WALLET_LINK_PATHS[route], body: JSON.stringify(body) }).then(() => { pending--; }, () => { pending--; });
        };
        for (let i = 1; i <= 3; i++) fire('quote', { ...walletBody('quote'), mint: walletKey(10 + i) });
        fire('fill', { ...walletBody('fill'), final: false });
        fire('fill', { ...walletBody('fill'), final: false });
        fire('balances', walletBody('balances'));
        fire('find', walletBody('find'));
        fire('closeQuote', walletBody('closeQuote'));
        for (let i = 0; i < 200 && mock.arrivals.length === 0; i++) await new Promise<void>(r => { setTimeout(r, 5); });
      }
      const serverAt: number[] = [];
      const serverDoneAt: number[] = [];
      for (let i = 0; i < SERVER_STEPS; i++) {
        const before = mock.arrivals.length;
        const startedAt = w.clock.now();
        const h = await app.chain.blockHeight();
        expect(h).toBe(1_000);
        const mine = mock.arrivals.slice(before).filter(a => a.method === 'getBlockHeight');
        expect(mine, `server-path call ${i} reached the node`).toHaveLength(1);
        serverAt.push(mine[0].at - startedAt);                 // fake time between the call and its arrival at the node
        serverDoneAt.push(w.clock.now() - startedAt);          // fake time until the answer: any wait on the wallet bucket would show here
        await w.clock.advance(SERVER_STEP_MS);
      }
      return { serverAt, serverDoneAt, walletAt: mock.arrivals.filter(a => a.method !== 'getBlockHeight').map(a => a.at), walletRequests, pending };
    });
  } finally {
    await mock.close();
  }
}

describe('the wallet link routes on the real wallet port (R7-W6)', () => {
  it('the default wiring answers balances, find and fill from the wallet RPC node: exact strings, the confirmed meta, a final fill with nothing found is not-landed', async () => {
    const w = build();
    const mock = await startMockRpc(w.clock);
    const owner = walletKey(0);
    const mint = walletKey(1);
    const ata = walletKey(2);
    mock.answers.set('getBalance', () => ({ context: { slot: 301 }, value: 4_000_000_000_123 }));
    const tokenAccount = {
      pubkey: ata,
      account: {
        lamports: 2_039_280, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        data: { parsed: { type: 'account', info: { mint, owner, state: 'initialized', tokenAmount: { amount: '18446744073709551615', decimals: 6 } } } },
      },
    };
    mock.answers.set('getTokenAccountsByOwner', p => ({ context: { slot: 302 }, value: p[1]?.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ? [tokenAccount] : [] }));
    const sig = newSig();
    mock.answers.set('getTransaction', p => (p[0] === sig ? {
      slot: 310, blockTime: 1_800_000_000,
      transaction: { message: { accountKeys: [owner, ata, walletKey(3)], header: { numRequiredSignatures: 1 }, instructions: [{ programIdIndex: 2 }] } },
      meta: {
        err: null, fee: 5000, preBalances: [10_000_000_000, 0, 1], postBalances: [9_947_955_720, 2_039_280, 1],
        preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint, owner, uiTokenAmount: { amount: '1000000', decimals: 6 } }],
      },
    } : null));
    try {
      const r = await withRpcOverride(mock.url, async () => {
        const app = createBotApp({ ...w.deps, env: { ...w.deps.env, RPC_URL: mock.url, RPC_FALLBACKS: 'off' } });
        const s = await app.events.listen(0);
        servers.push(s);
        const post = (route: WalletLinkRoute, body: Record<string, unknown>) => pump(w.clock, send(s.port, w.linkSecret, { path: WALLET_LINK_PATHS[route], body: JSON.stringify(body) }));
        return {
          balances: await post('balances', { owner }),
          find: await post('find', { owner, mint, side: 'buy', sinceSlot: 250 }),
          filled: await post('fill', { owner, signature: sig, side: 'buy', mint, quoteRef: 'quote-ref-1', submittedAt: FIXTURE_NOW - 1000, final: false }),
          gone: await post('fill', { owner, signature: newSig(), side: 'buy', mint, quoteRef: 'quote-ref-2', submittedAt: FIXTURE_NOW - 1000, final: true }),
          noQuote: await post('quote', { ...walletBody('quote'), mint }),
        };
      });
      expect(r.balances.json).toEqual({
        ok: true,
        balances: {
          solLamports: '4000000000123', slot: 301, readAt: expect.any(Number),
          tokens: [{ account: ata, mint, program: 'token', amountRaw: '18446744073709551615', decimals: 6, rentLamports: '2039280', frozen: false }],
        },
      });
      expect(r.find.json).toEqual({ ok: true, signatures: [] });
      expect(r.filled.json).toEqual({
        ok: true,
        fill: { status: 'confirmed', reason: null, solDeltaLamports: '-52044280', feeLamports: '5000', rentPaidLamports: '2039280', tokenDeltaRaw: '1000000', decimals: 6, slot: 310, blockTime: 1_800_000_000_000 },
      });
      expect(r.gone.json).toMatchObject({ ok: true, fill: { status: 'not-landed', solDeltaLamports: null, feeLamports: null, tokenDeltaRaw: null } });
      // a mint the node has no account for: a refusal with a reason and no bytes, never a made-up quote
      expect(r.noQuote.json).toMatchObject({ ok: false, code: 'no-route' });
      expect(Object.keys(r.noQuote.json).sort()).toEqual(['code', 'ok', 'reason']);
      // every call the wallet lane made went to the one node, with a read-only method
      const methods = new Set(mock.arrivals.map(a => a.method));
      for (const m of methods) expect(['getBalance', 'getTokenAccountsByOwner', 'getTransaction', 'getSignatureStatuses', 'getSignaturesForAddress', 'getMultipleAccounts', 'getMinimumBalanceForRentExemption']).toContain(m);
    } finally {
      await mock.close();
    }
  });

  it('without a wallet RPC lane (no key, no override) every wallet request is a refusal with a reason, the boot line says so, and nothing is made up', async () => {
    const w = build({}, { HELIUS_KEY: '' });
    const app = createBotApp(w.deps);
    expect(app.config.HELIUS_RPC_WALLET).toBe('');
    expect(app.bootLines().join('\n')).toMatch(/wallet RPC lane is NOT configured/);
    const s = await app.events.listen(0);
    servers.push(s);
    for (const route of WALLET_ROUTES) {
      // a fill that is not final would poll for its whole minute of (fake) time: ask for the single final look
      const body = route === 'fill' || route === 'closeFill' ? { ...walletBody(route), final: true } : walletBody(route);
      const r = await pump(w.clock, send(s.port, w.linkSecret, { path: WALLET_LINK_PATHS[route], body: JSON.stringify(body) }));
      expect(r.status).toBe(200);
      if (route === 'fill' || route === 'closeFill') expect(r.json, route).toMatchObject({ ok: true, fill: { status: 'unverified' } });
      else expect(r.json, route).toMatchObject({ ok: false });
      expect(JSON.stringify(r.json)).not.toMatch(/api-key|https?:\/\//i);
    }
  });
});

// ── A-110 (R8-RDB1): the heartbeat inputs bot_username, bot_wallet and rpc_provider ───────────────────────────────────────────────

describe('the heartbeat inputs of A-110 (R8-RDB1)', () => {
  const heartbeats = (w: World): Array<{ type: string; payload: Record<string, any> }> =>
    acceptedEvents(w).filter(e => e.type === 'bot.heartbeat') as unknown as Array<{ type: string; payload: Record<string, any> }>;
  const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

  it('RDB-T01 bot_username is null before launch and Telegraf botInfo.username after', async () => {
    let botInfo: { username?: string } | undefined;      // Telegraf: bot.botInfo is undefined until launch() has fetched getMe
    const w = build({ botInfo: () => botInfo });
    const app = createBotApp(w.deps);

    await app.outbox.sendHeartbeat();
    const before = heartbeats(w).at(-1)!.payload;
    expect(has(before, 'bot_username'), 'the key is sent').toBe(true);
    expect(before.bot_username, 'before launch').toBeNull();

    botInfo = { username: 'PumpstrikerTest_bot' };      // after launch
    await app.outbox.sendHeartbeat();
    expect(heartbeats(w).at(-1)!.payload.bot_username).toBe('PumpstrikerTest_bot');

    // a username the Engine's validator would refuse is never sent, and a getter that throws is null as well
    for (const bad of ['@PumpstrikerTest_bot', 'has space', 'a/b', '', 'x'.repeat(33)]) {
      botInfo = { username: bad };
      await app.outbox.sendHeartbeat();
      expect(heartbeats(w).at(-1)!.payload.bot_username, `username "${bad}"`).toBeNull();
    }
    const w2 = build({ botInfo: () => { throw new Error('boom'); } });
    await createBotApp(w2.deps).outbox.sendHeartbeat();
    expect(heartbeats(w2).at(-1)!.payload.bot_username).toBeNull();

    // the heartbeat is still one every 15 s, with no retry: the cadence constant did not move
    expect(HEARTBEAT_MS).toBe(15_000);
  });

  it('RDB-T02 bot_wallet carries the default wallet and the lamports, read_at and slot of the bot own getBalance read (one call, no extra RPC), and the heartbeat holds no key material or keyed URL', async () => {
    const slot = 250_000_000 + crypto.randomInt(1_000_000);
    const lamports = 1_000_000_000 + crypto.randomInt(1_000_000_000);
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const w = build({
      walletBalanceSol: undefined,                        // the DEFAULT balance read, on the injectable rpc
      rpc: {
        async call(method, params) {
          calls.push({ method, params });
          if (method === 'getBalance') return { context: { slot }, value: lamports };
          if (method === 'getTokenAccountBalance') throw new Error('could not find account');   // no wSOL account: 0
          return { value: [] };
        },
      },
    });
    const run = await boot(w.deps);
    running.push(run);
    await until(() => run.walletBalance() !== null, 'the first balance read');
    const readAt = w.clock.now();
    expect(run.walletBalance(), 'cachedBalance is the native SOL plus wSOL as before').toBe(lamports / 1e9);

    // the clock moves on before the next heartbeat: read_at is the clock at the RESPONSE, not at the heartbeat
    await w.clock.advance(7_000);
    await run.outbox.sendHeartbeat();
    const hb = heartbeats(w).at(-1)!.payload;
    expect(hb.at).toBe(readAt + 7_000);
    expect(hb.bot_wallet).toEqual({ wallet_id: WALLET.walletId, address: WALLET.owner, lamports: String(lamports), read_at: readAt, slot });
    expect(typeof hb.bot_wallet.lamports, 'a canonical integer string').toBe('string');
    expect(hb.rpc_ok).toBe(true);
    expect(hb.rpc_provider).toBe('helius');

    // ONE getBalance call (commitment confirmed, the call the balance refresh already made) plus the wSOL account lookup; nothing else was added
    expect(calls.filter(c => c.method === 'getBalance')).toEqual([{ method: 'getBalance', params: [WALLET.owner, { commitment: 'confirmed' }] }]);
    expect(calls.filter(c => c.method === 'getTokenAccountBalance')).toHaveLength(1);

    // switching the default wallet shows null until the next refresh: never the old balance under the new address
    const other = Keypair.generate();
    const otherWallet: AppWallet = { walletId: 'w2', owner: other.publicKey.toBase58(), keypair: other };
    w.deps.wallets = { current: () => otherWallet, get: id => (id === 'w2' ? otherWallet : null), byOwner: o => (o === otherWallet.owner ? otherWallet : null) };
    await run.outbox.sendHeartbeat();
    expect(heartbeats(w).at(-1)!.payload.bot_wallet).toBeNull();

    // redaction: no key material, no URL and no keyed URL anywhere in a heartbeat, and no key in the log
    const heartbeatBodies = w.engine.bodies.filter(b => b.includes('"bot.heartbeat"')).join('\n');
    expect(heartbeatBodies.length).toBeGreaterThan(0);
    for (const secret of w.secrets) expect(heartbeatBodies, 'a secret value').not.toContain(secret);
    expect(heartbeatBodies).not.toMatch(/https?:|wss?:|api-key|apikey|helius-rpc|\.com\b/i);   // the label 'helius' is the only provider text
    expect(w.logs.join('\n')).not.toContain(w.secrets[3]);
  });

  it('a getBalance that fails or cannot be read records NO read: bot_wallet stays null, cachedBalance and rpc_ok keep their old meaning (0 SOL, ok), and the log holds no key', async () => {
    const w = build({
      walletBalanceSol: undefined,
      rpc: {
        async call(method) {
          if (method === 'getBalance') throw new Error(`All RPCs failed for getBalance: ${w.deps.config.HELIUS_RPC}: 429`);
          return { value: [] };
        },
      },
    });
    const run = await boot(w.deps);
    running.push(run);
    await until(() => run.walletBalance() !== null, 'the first balance refresh');
    expect(run.walletBalance(), 'as getSolBalance did when every RPC failed').toBe(0);
    await run.outbox.sendHeartbeat();
    const hb = heartbeats(w).at(-1)!.payload;
    expect(hb.bot_wallet).toBeNull();
    expect(hb.rpc_ok).toBe(true);
    const logged = w.logs.join('\n');
    expect(logged).toMatch(/balance: getBalance failed/);
    expect(logged).not.toContain(w.secrets[3]);       // the keyed URL in the error is redacted before it is logged
    await run.stop();

    // answers that are not a lamports value are no read either
    for (const bad of [{ context: { slot: 5 }, value: -1 }, { context: { slot: 5 }, value: 1.5 }, { context: { slot: 5 }, value: '01' }, { context: { slot: 5 } }, null, { value: [] }]) {
      const w2 = build({ walletBalanceSol: undefined, rpc: { async call(method) { return method === 'getBalance' ? bad : { value: [] }; } } });
      const run2 = await boot(w2.deps);
      running.push(run2);
      await until(() => run2.walletBalance() !== null, 'the balance refresh');
      await run2.outbox.sendHeartbeat();
      expect(heartbeats(w2).at(-1)!.payload.bot_wallet, JSON.stringify(bad)).toBeNull();
      await run2.stop();
    }

    // a missing slot is sent as null, the lamports are still the read
    const w3 = build({ walletBalanceSol: undefined, rpc: { async call(method) { return method === 'getBalance' ? { value: 42 } : { value: [] }; } } });
    const run3 = await boot(w3.deps);
    running.push(run3);
    await until(() => run3.walletBalance() !== null, 'the balance refresh');
    await run3.outbox.sendHeartbeat();
    expect(heartbeats(w3).at(-1)!.payload.bot_wallet).toEqual({ wallet_id: WALLET.walletId, address: WALLET.owner, lamports: '42', read_at: w3.clock.now(), slot: null });
  });

  it('an injected walletBalanceSol reports no lamports or slot, so bot_wallet is null (never a guess from the SOL float); rpc_provider is still a plain label', async () => {
    const w = build();                                    // walletBalanceSol: async () => 2
    const run = await boot(w.deps);
    running.push(run);
    await until(() => run.walletBalance() === 2, 'the injected balance');
    await run.outbox.sendHeartbeat();
    const hb = heartbeats(w).at(-1)!.payload;
    expect(has(hb, 'bot_wallet')).toBe(true);
    expect(hb.bot_wallet).toBeNull();
    expect(hb.bot_username, 'no botInfo dep: never reported').toBeNull();
    expect(hb.rpc_provider).toMatch(/^[a-z]+$/);
  });

  it('rpcProviderLabel is a word from a fixed set (never a URL, never a key) and canonicalLamports accepts only an exact non-negative u64', () => {
    const key = crypto.randomUUID();
    const lane = (host: string): string => `https://${host}/?api-key=${key}`;
    const cfg = (bot: string, main: string) => ({ HELIUS_RPC_BOT: bot, HELIUS_RPC: main });
    const local = (): string => `http://127.0.0.1:${crypto.randomInt(20000, 60000)}`;
    expect(rpcProviderLabel(cfg(lane('mainnet.helius-rpc.com'), ''), {})).toBe('helius');
    expect(rpcProviderLabel(cfg('', lane('mainnet.helius-rpc.com')), {})).toBe('helius');
    expect(rpcProviderLabel(cfg(lane('rpc.example.org'), lane('mainnet.helius-rpc.com')), {})).toBe('primary');   // the bot lane is the one read first
    expect(rpcProviderLabel(cfg('not a url', ''), {})).toBe('primary');
    expect(rpcProviderLabel(cfg('', ''), {})).toBe('public');
    expect(rpcProviderLabel(cfg(lane('mainnet.helius-rpc.com'), ''), { RPC_URL: local(), RPC_FALLBACKS: 'off' })).toBe('custom');
    expect(rpcProviderLabel(cfg('', ''), { RPC_URL: local() })).toBe('custom');
    for (const label of [rpcProviderLabel(cfg(lane('mainnet.helius-rpc.com'), ''), {}), rpcProviderLabel(cfg('', ''), {}), rpcProviderLabel(cfg('x', ''), { RPC_URL: lane('a.b') })]) {
      expect(label).toMatch(/^[a-z]+$/);
      expect(label).not.toContain(key);
    }

    expect(canonicalLamports(0)).toBe('0');
    expect(canonicalLamports(2_500_000_000)).toBe('2500000000');
    expect(canonicalLamports('18446744073709551615')).toBe('18446744073709551615');
    for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 60, '18446744073709551616', '01', '-5', '1.5', '1e9', '', 'abc', null, undefined, true, {}, []]) {
      expect(canonicalLamports(bad), String(bad)).toBeNull();
    }
  });
});
