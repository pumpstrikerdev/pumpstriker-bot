// R2-B2: test helpers of the auto-buy tests. Not a test file (vitest does not collect it) and not imported by any production module.
// The router stub is built on the REAL A-26 send gate (send-context.ts createSendContext + dispatchSigned) over a real signed v0
// transaction, so `sends` counts exactly what the real router would hand to a sender: nothing in buildOnly mode, one entry per send
// otherwise, and onSigned is awaited before the send. Signatures and keys are generated at runtime (planner amendment A-20). No network.
import bs58 from 'bs58';
import type { ExitPlanSnapshot } from '../exits/presets';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { AutoBuyDecision, BuyExecution, BuyFill, FillReader, PendingBuy, PositionV2, SellFill } from '../bot-contracts';
import { AUTO_BUY_CAPS_FILENAME, AutoBuyCaps, resolveAutoBuyLimits } from '../bot/trade-guards';
import { ImpactCapError, RouterSendError, type RouterOpts, type RouterResult, type SwapRoute } from '../execution/router';
import { createSendContext, dispatchSigned, OnSignedAbort } from '../execution/send-context';
import { FakeClock } from '../link/clock';
import { createUlidFactory } from '../link/ulid';
import { fixture, FIXTURE_NOW, freshEvent, MemoryOutbox, tempDir } from '../link/link-testkit';
import type { ArmId } from '../shared/common/ids';
import type { ArmsStatusPayload, ArmStatus, Envelope, SignalNew } from '../shared/contract/v1';
import { createAutoBuy, type AutoBuyPositions, type AutoBuyService, type AutoBuySettings, type SmartBuyFn, type VirtualBuy } from './api';
import { LEDGER_FILE } from './guards';
import { PENDING_FILE, type RecoveryRpc, type SigStatus } from './pending';
import { STATE_FILE } from './state';

export { FIXTURE_NOW };
export const POLICY_VERSION: string = fixture<Envelope<'signal.new', SignalNew>>('signal.new').payload.policy.version;
export const KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(7));
export const OWNER_ADDR = KEYPAIR.publicKey.toBase58();
export const WALLET_ID = 'wallet-1';
export const QUOTE_TOKENS = 1_666_666_000_000n;

export const newSig = (): string => bs58.encode(crypto.randomBytes(64));

// ---------------------------------------------------------------------------------------------------------------------------------
// router stub (real send gate)
// ---------------------------------------------------------------------------------------------------------------------------------

export interface SendRecord { sig: string; journalHadSig: boolean; ledgerHadCa: boolean; at: number }
export interface RouterCall { mint: string; solIn: number; opts: RouterOpts }

function signedTx(keypair: Keypair): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: keypair.publicKey, recentBlockhash: bs58.encode(crypto.randomBytes(32)),
    instructions: [SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: keypair.publicKey, lamports: 1 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([keypair]);
  return tx;
}

export class StubRouter {
  readonly calls: RouterCall[] = [];
  /** One entry per transaction handed to the sender. A buildOnly call adds none. */
  readonly sends: SendRecord[] = [];
  route: SwapRoute = 'pf-direct';
  quote: bigint = QUOTE_TOKENS;
  /** Block height at signing; with no builder bound onSigned receives height + 151. */
  height = 1_000;
  /** The builder's lastValidBlockHeight handed to onSigned (null = the builder gave none). */
  lastValid: number | null = 1_150;
  /** Thrown before anything is signed. */
  failBefore: unknown = null;
  /** The sender throws this after it counted the send. */
  failSend: unknown = null;
  /** The impact the route measures (percent); above opts.maxImpactPct it is refused before signing, like the real router. */
  impactPct: number | null = null;
  /** A broken router: a buildOnly call answers `sent: true`. Only the dry-run safety stop is tested with it. */
  reportSentOnBuildOnly = false;
  journalFile = '';
  ledgerFile = '';
  constructor(private readonly clock: { now(): number }) {}

  private has(file: string, needle: string): boolean {
    try { return file !== '' && fs.readFileSync(file, 'utf8').includes(needle); } catch { return false; }
  }

  readonly smartBuy: SmartBuyFn = async (keypair, mint, solIn, opts = {}) => {
    this.calls.push({ mint, solIn, opts: { ...opts } });
    if (this.failBefore !== null) throw this.failBefore;
    if (this.impactPct !== null && opts.maxImpactPct !== undefined && this.impactPct > opts.maxImpactPct) {
      throw new ImpactCapError(opts.maxImpactPct, [{ route: this.route, impactPct: this.impactPct }]);
    }
    const ctx = createSendContext(opts, { blockHeight: async () => this.height });
    const tx = signedTx(keypair);
    const slip = opts.slippageBps ?? 0;
    if (this.reportSentOnBuildOnly && opts.buildOnly === true) {
      return { sig: bs58.encode(tx.signatures[0]), route: this.route, tokensOut: this.quote, tokensOutQuoted: this.quote, slippageBpsUsed: slip, sent: true };
    }
    try {
      const { sig, sent } = await dispatchSigned(ctx, tx, this.route, this.lastValid, async () => {
        const s = bs58.encode(tx.signatures[0]);
        this.sends.push({ sig: s, journalHadSig: this.has(this.journalFile, s), ledgerHadCa: this.has(this.ledgerFile, mint), at: this.clock.now() });
        if (this.failSend !== null) throw this.failSend;
        return s;
      });
      const base: RouterResult = { sig, route: this.route, tokensOut: this.quote, tokensOutQuoted: this.quote, slippageBpsUsed: slip };
      return sent ? { ...base, sent: true, sigs: [...ctx.sigs] } : { ...base, sent: false };
    } catch (e) {
      const inner = e instanceof OnSignedAbort ? e.original : e;
      if (ctx.sigs.length > 0) throw new RouterSendError(String((inner as { message?: unknown } | null)?.message ?? inner), ctx.sigs);
      throw inner;
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// rpc, fills, engine, positions
// ---------------------------------------------------------------------------------------------------------------------------------

export class StubRpc implements RecoveryRpc {
  /** sig -> status; a sig that is not here reads as "not found" (null). */
  readonly statuses = new Map<string, SigStatus | null>();
  statusThrows = false;
  height = 1_000;
  heightThrows = false;
  balance: { rawAtoms: number | bigint | string } | null = null;
  balanceThrows = false;
  readonly calls = { statuses: 0, height: 0, balance: 0 };

  async getSignatureStatuses(sigs: string[]): Promise<Array<SigStatus | null>> {
    this.calls.statuses++;
    if (this.statusThrows) throw new Error('rpc down');
    return sigs.map(s => this.statuses.get(s) ?? null);
  }
  async getBlockHeight(): Promise<number> {
    this.calls.height++;
    if (this.heightThrows) throw new Error('rpc down');
    return this.height;
  }
  async getSplTokenBalance(): Promise<{ rawAtoms: number | bigint | string } | null> {
    this.calls.balance++;
    if (this.balanceThrows) throw new Error('rpc down');
    return this.balance;
  }
  land(sig: string): void { this.statuses.set(sig, { err: null, confirmationStatus: 'confirmed' }); }
  revert(sig: string): void { this.statuses.set(sig, { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }); }
}

export class StubFills implements FillReader {
  readonly calls: Array<{ sig: string; owner: string; mint: string }> = [];
  /** What buyFill answers: a fill, 'unverified', or an Error to throw. */
  next: BuyFill | 'unverified' | Error | null = null;
  constructor(private readonly clock: { now(): number }) {}
  async buyFill(sig: string, owner: string, mint: string): Promise<BuyFill | 'unverified'> {
    this.calls.push({ sig, owner, mint });
    const n = this.next;
    if (n instanceof Error) throw n;
    if (n !== null) return n;
    return { solSpentLamports: '10005000', tokensRaw: '1666000000000', feeLamports: '5000', confirmedAt: this.clock.now() };
  }
  async sellFill(): Promise<SellFill | 'unverified'> { return 'unverified'; }
}

export class StubEngine {
  payload: ArmsStatusPayload | { error: string };
  calls = 0;
  constructor() {
    this.payload = fixture<{ payload: ArmsStatusPayload }>('arms.status').payload;
  }
  async arms(): Promise<ArmsStatusPayload | { error: string }> {
    this.calls++;
    return JSON.parse(JSON.stringify(this.payload)) as ArmsStatusPayload | { error: string };
  }
  /** Sets one arm's standing verdict (and report id). */
  set(arm: ArmId, verdict: ArmStatus['verdict'], reportId: string | null = verdict === 'PASS' ? `report-${arm.toLowerCase()}-0001` : null): ArmsStatusPayload {
    const p = this.payload as ArmsStatusPayload;
    const a = p.arms.find(x => x.arm === arm);
    if (a === undefined) throw new Error('no such arm in the fixture');
    a.verdict = verdict;
    a.report_id = reportId;
    return JSON.parse(JSON.stringify(p)) as ArmsStatusPayload;
  }
}

export class StubPositions implements AutoBuyPositions {
  readonly real: PositionV2[] = [];
  readonly virtual: PositionV2[] = [];
  readonly openCalls: Array<{ p: PendingBuy; fill: BuyFill | 'unverified' }> = [];
  failOpen: Error | null = null;
  private n = 0;
  constructor(private readonly clock: { now(): number }) {}

  private make(o: { dry: boolean; signal_id: string; ca: string; wallet_id: string; arm: ArmId; tx: string | null; sol: string | null; tokens: string | null; source: PositionV2['entry']['fill_source'] }): PositionV2 {
    return {
      position_id: `pos-${++this.n}`, signal_id: o.signal_id, origin: 'signal', dry_run: o.dry, ca: o.ca, wallet_id: o.wallet_id,
      policy_id: 'EA', policy_version: POLICY_VERSION, arm: o.arm,
      entry: { tx: o.tx, opened_at: this.clock.now(), sol_spent_lamports: o.sol, tokens_raw: o.tokens, fill_source: o.source },
      original_tokens: o.tokens ?? '0', tokens: o.tokens ?? '0', basis_sol_per_token: null, peak_multiple: 1, legs_done: [], leg_attempts: {},
      last_quote: null, lockouts: [], ata: null,
    };
  }

  openFromBuy(p: PendingBuy, fill: BuyFill | 'unverified'): PositionV2 {
    this.openCalls.push({ p, fill });
    if (this.failOpen !== null) throw this.failOpen;
    const plan = (p as PendingBuy & { exit_plan?: { policy: { id: string; version: string } } | null }).exit_plan;   // A-115: stamped like the real store
    const v0 = fill === 'unverified'
      ? this.make({ dry: false, signal_id: p.signal_id, ca: p.ca, wallet_id: p.wallet_id, arm: p.arm, tx: p.sig, sol: p.sol_in_lamports, tokens: p.quote_tokens_out, source: 'unverified' })
      : this.make({ dry: false, signal_id: p.signal_id, ca: p.ca, wallet_id: p.wallet_id, arm: p.arm, tx: p.sig, sol: fill.solSpentLamports, tokens: fill.tokensRaw, source: 'tx_meta' });
    const v = plan ? { ...v0, policy_id: plan.policy.id, policy_version: plan.policy.version } : v0;
    this.real.push(v);
    return v;
  }
  openVirtual(v: VirtualBuy): PositionV2 {
    const p = this.make({ dry: true, signal_id: v.signal_id, ca: v.ca, wallet_id: v.wallet_id, arm: v.arm, tx: null, sol: v.sol_in_lamports, tokens: v.quote_tokens_out, source: 'quote_dry_run' });
    this.virtual.push(p);
    return p;
  }
  hasOpen(ca: string, walletId: string | null): boolean {
    return [...this.real, ...this.virtual].some(p => p.ca === ca && (walletId === null || p.wallet_id === walletId));
  }
  openCount(dryRun: boolean): number { return (dryRun ? this.virtual : this.real).length; }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------------------------------------------

export interface HarnessOpts {
  dir?: string;
  clock?: FakeClock;
  env?: Record<string, string | undefined>;
  /** Share the outbox, positions, engine, settings, flags, registry, notices and logs of an earlier harness (a restart of the process). */
  from?: Harness;
  confirmPollMs?: number;
  recoverPollMs?: number;
  /** A-115: the exit plan of a live buy (the owner's grade preset); absent = none. */
  exitPlan?: (sig: SignalNew) => ExitPlanSnapshot | null;
}

export interface Harness {
  dir: string;
  clock: FakeClock;
  env: Record<string, string | undefined>;
  outbox: MemoryOutbox;
  notices: string[];
  logs: string[];
  router: StubRouter;
  rpc: StubRpc;
  fills: StubFills;
  positions: StubPositions;
  engine: StubEngine;
  settings: AutoBuySettings;
  flags: { dryRun: boolean; walletPresent: boolean; balanceSol: number | null; sessionOk: boolean };
  registry: Map<string, string>;
  caps: AutoBuyCaps;
  svc: AutoBuyService;
  signal(o?: { pricedAgoMs?: number; arms?: Partial<Record<ArmId, boolean>>; ca?: string }): { env: Envelope<'signal.new', SignalNew>; sig: SignalNew };
  /** The intake's order for one signal.new: register the CA, decide, and execute when the decision is a buy. */
  run(o?: { pricedAgoMs?: number; arms?: Partial<Record<ArmId, boolean>>; ca?: string }): Promise<{ env: Envelope<'signal.new', SignalNew>; sig: SignalNew; d: AutoBuyDecision; x: BuyExecution | null }>;
  owner(text: string): Promise<string | null>;
  goLive(arm?: ArmId): Promise<string>;
  armDry(arm?: ArmId): Promise<string>;
  /** Stops this service (the process "dies") and starts a new one on the same data folder. */
  restart(o?: { env?: Record<string, string | undefined> }): Harness;
  journal(): Array<Record<string, unknown>>;
  stateFile(): Record<string, any>;
  /** Moves the clock and lets the confirm loops run. */
  advance(ms: number): Promise<void>;
}

export function makeHarness(o: HarnessOpts = {}): Harness {
  const from = o.from;
  const dir = o.dir ?? from?.dir ?? tempDir('ps-b2-');
  const clock = o.clock ?? from?.clock ?? new FakeClock(FIXTURE_NOW);
  const env = o.env ?? from?.env ?? {};
  const outbox = from?.outbox ?? new MemoryOutbox();
  const notices = from?.notices ?? [];
  const logs = from?.logs ?? [];
  const positions = from?.positions ?? new StubPositions(clock);
  const engine = from?.engine ?? new StubEngine();
  const settings: AutoBuySettings = from?.settings ?? { buySol: 0.01, slippageBps: 300 };
  const flags = from?.flags ?? { dryRun: false, walletPresent: true, balanceSol: 1, sessionOk: true };
  const registry = from?.registry ?? new Map<string, string>();
  const router = new StubRouter(clock);
  router.journalFile = path.join(dir, PENDING_FILE);
  router.ledgerFile = path.join(dir, LEDGER_FILE);
  const rpc = new StubRpc();
  const fills = new StubFills(clock);
  const caps = new AutoBuyCaps(path.join(dir, AUTO_BUY_CAPS_FILENAME), resolveAutoBuyLimits(env, settings.buySol).limits);
  const ulid = createUlidFactory(() => clock.now());
  const svc = createAutoBuy({
    dir, clock, env, dryRun: () => flags.dryRun, smartBuy: router.smartBuy, fills, rpc, positions, outbox, engine,
    wallet: {
      current: () => (flags.walletPresent ? { walletId: WALLET_ID, owner: OWNER_ADDR, keypair: KEYPAIR } : null),
      balanceSol: () => flags.balanceSol,
    },
    settings: () => settings, policyVersions: () => ({ EA: POLICY_VERSION }), signalledBy: ca => registry.get(ca) ?? null,
    sessionWindowOk: () => flags.sessionOk, newEventId: ulid, notifyOwner: t => { notices.push(t); }, caps,
    log: (m, l) => { logs.push(`${l ?? 'info'}: ${m}`); },
    confirmPollMs: o.confirmPollMs ?? 1_000, recoverPollMs: o.recoverPollMs ?? 5_000,
    ...(o.exitPlan !== undefined ? { exitPlan: o.exitPlan } : {}),
  });

  const h: Harness = {
    dir, clock, env, outbox, notices, logs, router, rpc, fills, positions, engine, settings, flags, registry, caps, svc,
    signal(so = {}) {
      const ev = freshEvent(fixture<Envelope<'signal.new', SignalNew>>('signal.new'), so.ca);
      ev.emitted_at = clock.now();
      ev.payload.entry.priced_at = clock.now() - (so.pricedAgoMs ?? 1_000);
      for (const [arm, eligible] of Object.entries(so.arms ?? {})) {
        ev.payload.arms[arm as ArmId] = { eligible: eligible as boolean, blocked_by: eligible ? [] : ['blocked-in-test'], unknown_inputs: [] };
      }
      // the live Engine reports launch-run on every signal (A-96); the shared fixture predates it, and the pilot refuses a missing one
      if (!ev.payload.labels.some(l => l.id === 'launch-run')) {
        ev.payload.labels.push({ id: 'launch-run', rule_version: 'launch-run@1', value: false, known: true, acting: true });
      }
      return { env: ev, sig: ev.payload };
    },
    async run(so) {
      const { env: e, sig } = h.signal(so);
      if (e.ca !== null && !registry.has(e.ca)) registry.set(e.ca, e.signal_id as string);
      const now = clock.now();
      const d = svc.decide(sig, e, now, now);
      const x = d.action === 'buy' ? await svc.execute(sig, e, d) : null;
      return { env: e, sig, d, x };
    },
    owner: text => svc.commands.handle(text, { isOwner: true }),
    async goLive(arm = 'B1') {
      engine.set(arm, 'PASS');
      const on = await svc.commands.handle(`/autobuy on ${arm}`, { isOwner: true });
      if (on === null || !on.includes('CONFIRM')) throw new Error(`goLive: /autobuy on did not ask for a confirmation: ${on}`);
      const reportId = (engine.payload as ArmsStatusPayload).arms.find(a => a.arm === arm)?.report_id as string;
      const r = await svc.commands.handle(`CONFIRM ${arm} ${reportId}`, { isOwner: true });
      if (r === null || !r.includes('LIVE')) throw new Error(`goLive: the confirmation was not accepted: ${r}`);
      return reportId;
    },
    async armDry(arm = 'B1') {
      const r = await svc.commands.handle(`/autobuy dryrun ${arm}`, { isOwner: true });
      if (r === null || !r.includes('Dry run armed')) throw new Error(`armDry: ${r}`);
      return r;
    },
    restart(ro = {}) {
      svc.stop();
      return makeHarness({ from: h, dir, clock, env: ro.env ?? env, confirmPollMs: o.confirmPollMs, recoverPollMs: o.recoverPollMs, exitPlan: o.exitPlan });
    },
    journal() {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(dir, PENDING_FILE), 'utf8')) as { entries: Array<Record<string, unknown>> };
        return doc.entries;
      } catch {
        return [];
      }
    },
    stateFile() {
      return JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8')) as Record<string, any>;
    },
    advance: ms => clock.advance(ms),
  };
  return h;
}
