/**
 * exits-testkit.ts: the fakes the B30 tests share (nothing here is used by production code).
 *
 * `makeWorld()` builds a complete exit engine around ONE FakeClock (A-10, bot-local clock of link/clock.ts), a real positions store in a
 * temp folder, a scripted valuation (a price per CA, or the real `createValuation` over stubs), a scripted `smartSell` (A-28: the stub
 * counts sends, signs through `onSigned`, and moves a fake chain balance), a fake fill reader and landed-check chain, a recording
 * CloseAccount and a collecting owner notifier. Signatures are generated at run time (A-20), never written as literals.
 */
import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import type { CloseAccountApi, FillReader, PositionV2, SellFill, Valuation } from '../bot-contracts';
import { FakeClock } from '../link/clock';
import { createUlidFactory } from '../link/ulid';
import { MemoryOutbox, newCa } from '../link/link-testkit';
import { RouterSendError } from '../execution/send-context';
import { loadPolicies, type ResolvedPolicy } from '../shared/exit-policy/exit-policy';
import policiesJson from '../shared/exit-policy/exit-policies.json';
import type { ExitLegV1, PositionClosed } from '../shared/contract/v1';
import { createExitEngine, type ExitEngine, type ExitEngineConfig, type ExitEngineDeps } from './exit-engine';
import type { LandedCheckDeps, SignatureStatus } from './failure-policy';
import { createPositionsStore, type PositionsStoreV2, type StoredPosition } from './positions-store';
import type { SmartSellFn } from './sell-runner';
import type { StoredManualOrder } from './manual-orders';
import { createValuation } from './valuation';

export const START_MS = 1_800_000_000_000;
/** SOL per token atom at multiple 1.0 in the scripted valuation (a 1e9-atom bag is worth 0.2 SOL). */
export const BASE_PRICE = 2e-10;
export const POLICIES: Readonly<Record<string, ResolvedPolicy>> = loadPolicies(policiesJson);

export function newSig(): string { return bs58.encode(randomBytes(64)); }

/** What one `smartSell` call does. */
export type SellStep =
  | 'ok'               // signs, sends, lands; the chain balance drops; the fill reader sees the real fill
  | 'revert'           // signs, the send throws a RouterSendError with the signature; nothing landed (status: error)
  | 'revert-landed'    // the send reports a failure (RouterSendError) but the transaction landed (status confirmed, balance dropped)
  | 'empty'            // resolves, but the fill shows 0 tokens sold (A-29)
  | 'unverified'       // resolves, the balance drops, the fill meta is unreadable
  | 'partial'          // lands, but only half of the requested tokens are sold
  | 'nosend'           // a plain Error: nothing was sent
  | 'timeout'          // A-93f: signs and sends, then the confirm times out (RouterSendError); no status yet, nothing landed so far
  | 'hang'             // A-93f: signs and sends, then the confirm takes 10 minutes on the clock before it lands like 'ok'
  | { revert: string }; // like 'revert', with this error message

export interface SellCall { mint: string; tokens: bigint; slippageBps: number | undefined; singleSend: boolean | undefined; at: number; sig: string | null }

export interface World {
  clock: FakeClock;
  dir: string;
  store: PositionsStoreV2;
  outbox: MemoryOutbox;
  engine: ExitEngine;
  policies: Readonly<Record<string, ResolvedPolicy>>;
  /** SOL per atom now, per CA; null/undefined = no quote. */
  price: Map<string, number | null>;
  /** The source the scripted valuation reports. */
  src: { value: 'onchain' | 'jupiter' | 'engine_gmgn' };
  quoteCalls: Array<{ ca: string; wallet: string; tokens: string; protectiveOnly: boolean; at: number }>;
  sells: SellCall[];
  /** Per-call script for smartSell; the last entry repeats. */
  sellScript: SellStep[];
  balances: Map<string, bigint>;
  /** Atoms the chain still shows after a sale that emptied the wallet (dust a route left behind). */
  dust: bigint;
  balanceUnknown: Set<string>;
  /** A-93f: the block height the chain reports (null = unreadable). The stub signs with lastValidBlockHeight 1_000_000. */
  height: { value: number | null };
  statuses: Map<string, SignatureStatus | null>;
  fills: Map<string, SellFill>;
  closeCalls: Array<{ owner: string; mint: string; balanceSeen: number | null }>;
  closeResult: Awaited<ReturnType<CloseAccountApi['closeIfEmpty']>>;
  order: string[];
  notices: string[];
  logs: string[];
  missingWallets: Set<string>;
  wallets: Map<string, Keypair>;
  slippage: { baseBps: number; smartMaxBps: number };
  /** Moves the clock and runs one pass at the new time. */
  passAt(advanceMs: number): Promise<void>;
  legs(): ExitLegV1[];
  closed(): PositionClosed[];
  /** A new store over the same folder (what a restart sees). */
  reopenStore(): PositionsStoreV2;
}

export interface WorldOpts {
  valuation?: (w: World) => Valuation;
  config?: Partial<ExitEngineConfig>;
  sellScript?: SellStep[];
  policy?: { id: string; version: string };
}

export function makeWorld(dir: string, o: WorldOpts = {}): World {
  const clock = new FakeClock(START_MS);
  const policy = o.policy ?? { id: 'EA', version: POLICIES.EA.version };
  const store = createPositionsStore({ dir, clock, policy });
  const outbox = new MemoryOutbox();
  const w = {
    clock, dir, store, outbox, policies: POLICIES, price: new Map<string, number | null>(), src: { value: 'onchain' as const } as World['src'],
    quoteCalls: [], sells: [], sellScript: o.sellScript ?? ['ok'], balances: new Map<string, bigint>(), dust: 0n, balanceUnknown: new Set<string>(), height: { value: 2_000_000 },
    statuses: new Map<string, SignatureStatus | null>(), fills: new Map<string, SellFill>(), closeCalls: [], order: [], notices: [], logs: [],
    closeResult: { status: 'closed', tx: newSig(), rentLamports: '2039280', reason: null },
    missingWallets: new Set<string>(), wallets: new Map<string, Keypair>(), slippage: { baseBps: 300, smartMaxBps: 1500 },
  } as unknown as World;

  const keypairOf = (id: string): Keypair => { let k = w.wallets.get(id); if (!k) { k = Keypair.generate(); w.wallets.set(id, k); } return k; };

  const scripted: Valuation = {
    async quote(pos: PositionV2, protectiveOnly: boolean) {
      w.quoteCalls.push({ ca: pos.ca, wallet: pos.wallet_id, tokens: pos.tokens, protectiveOnly, at: clock.now() });
      const p = w.price.get(pos.ca);
      if (p === null || p === undefined) return null;
      return { sol: p * Number(pos.tokens), src: w.src.value, at: clock.now() };
    },
  };

  let sellN = 0;
  const smartSell: SmartSellFn = async (_kp, mint, tokensIn, opts) => {
    const step = w.sellScript[Math.min(sellN, w.sellScript.length - 1)];
    sellN += 1;
    const call: SellCall = { mint, tokens: tokensIn, slippageBps: opts?.slippageBps ?? undefined, singleSend: opts?.singleSend, at: clock.now(), sig: null };
    w.sells.push(call);
    w.order.push('sell');
    if (step === 'nosend') throw new Error('route refused: no usable route');
    const sig = newSig();
    call.sig = sig;
    await opts?.onSigned?.({ sig, lastValidBlockHeight: 1_000_000, route: 'pf-direct' });
    if (step === 'timeout') throw new RouterSendError('sender: tx not confirmed within 60s (likely dropped or expired blockhash)', [sig]);
    if (step === 'hang') await clock.sleep(600_000);
    const price = w.price.get(mint) ?? BASE_PRICE;
    const makeFill = (sold: bigint): SellFill => {
      const gross = BigInt(Math.round(price * Number(sold) * 1e9));
      const net = gross - (gross * 2n) / 100n - 5000n;
      return { solOutNetLamports: net.toString(), solOutGrossLamports: (net + 5000n).toString(), tokensSoldRaw: sold.toString(), feeLamports: '5000', confirmedAt: clock.now() };
    };
    const have = w.balances.get(mint) ?? 0n;
    const sold = tokensIn < have ? tokensIn : have;
    if (step === 'revert' || (typeof step === 'object' && 'revert' in step)) {
      w.statuses.set(sig, { err: { InstructionError: [0, { Custom: 6024 }] }, confirmationStatus: 'confirmed' });
      throw new RouterSendError(typeof step === 'object' ? step.revert : 'swap reverted: custom program error 6024', [sig]);
    }
    if (step === 'revert-landed') {
      w.balances.set(mint, have - sold);
      w.statuses.set(sig, { err: null, confirmationStatus: 'confirmed' });
      w.fills.set(sig, makeFill(sold));
      throw new RouterSendError('confirmation timed out', [sig]);
    }
    if (step === 'empty') {
      w.fills.set(sig, { ...makeFill(0n), tokensSoldRaw: '0' });
      return { sig, route: 'pf-direct', slippageBpsUsed: opts?.slippageBps ?? 0, sent: true, sigs: [sig] };
    }
    const soldNow = step === 'partial' ? sold / 2n : sold;
    w.balances.set(mint, have - soldNow === 0n ? w.dust : have - soldNow);
    w.statuses.set(sig, { err: null, confirmationStatus: 'confirmed' });
    if (step === 'ok' || step === 'partial') w.fills.set(sig, makeFill(soldNow));
    return { sig, route: 'pf-direct', slippageBpsUsed: opts?.slippageBps ?? 0, sent: true, sigs: [sig] };
  };

  const fills: FillReader = {
    async buyFill() { return 'unverified'; },
    async sellFill(sig) { return w.fills.get(sig) ?? 'unverified'; },
  };
  const chain: LandedCheckDeps = {
    async signatureStatuses(sigs) { return sigs.map(s => w.statuses.get(s) ?? null); },
    async blockHeight() { if (w.height.value === null) throw new Error('rpc down'); return w.height.value; },
    async tokenBalance(_owner, mint) {
      w.order.push(`balance:${w.balanceUnknown.has(mint) ? 'unknown' : String(w.balances.get(mint) ?? 0n)}`);
      if (w.balanceUnknown.has(mint)) return null;
      return { rawAtoms: Number(w.balances.get(mint) ?? 0n) };
    },
  };
  const closeAccount: CloseAccountApi = {
    async closeIfEmpty(owner, mint) {
      w.order.push('close');
      w.closeCalls.push({ owner, mint, balanceSeen: w.balanceUnknown.has(mint) ? null : Number(w.balances.get(mint) ?? 0n) });
      return w.closeResult;
    },
  };

  const deps: ExitEngineDeps = {
    clock, store, valuation: o.valuation ? o.valuation(w) : scripted, policies: POLICIES, smartSell, fills, closeAccount, chain,
    wallets: id => (w.missingWallets.has(id) ? null : { owner: keypairOf(id).publicKey.toBase58(), keypair: keypairOf(id) }),
    outbox, newId: createUlidFactory(() => clock.now()), notifyOwner: t => { w.notices.push(t); }, slippage: () => w.slippage,
    config: o.config, log: (m, level) => { w.logs.push(`${level ?? 'info'} ${m}`); },
  };
  w.engine = createExitEngine(deps);
  w.passAt = async (ms: number) => { await clock.advance(ms); await w.engine.runPass(); };
  w.legs = () => outbox.of('exit.leg').map(e => e.payload);
  w.closed = () => outbox.of('position.closed').map(e => e.payload);
  w.reopenStore = () => createPositionsStore({ dir, clock, policy });
  return w;
}

export interface AddOpts {
  ca?: string;
  wallet?: string;
  tokens?: bigint;
  origin?: 'signal' | 'manual';
  dryRun?: boolean;
  /** SOL per atom basis; undefined = BASE_PRICE, null = not set yet. */
  basis?: number | null;
  ageMs?: number;
  /** Lamports the buy really cost; null = unknown. */
  spent?: bigint | null;
  fillSource?: PositionV2['entry']['fill_source'];
  id?: string;
}

/** A position in the store, with the fake chain holding its tokens. */
export function addPosition(w: World, a: AddOpts = {}): StoredPosition {
  const ca = a.ca ?? newCa();
  const tokens = a.tokens ?? 1_000_000_000n;
  const origin = a.origin ?? 'signal';
  const now = w.clock.now();
  const p = w.store.put({
    position_id: a.id ?? `pos_${randomBytes(6).toString('hex')}`, signal_id: origin === 'signal' ? `dec_${randomBytes(8).toString('hex')}` : null,
    origin, dry_run: a.dryRun === true, ca, wallet_id: a.wallet ?? 'w1',
    policy_id: origin === 'signal' ? 'EA' : 'MANUAL', policy_version: origin === 'signal' ? POLICIES.EA.version : null, arm: origin === 'signal' ? 'B1' : null,
    entry: { tx: a.dryRun ? null : newSig(), opened_at: now - (a.ageMs ?? 0), sol_spent_lamports: a.spent === undefined ? (Number(tokens) * BASE_PRICE * 1e9).toFixed(0) : a.spent === null ? null : a.spent.toString(),
      tokens_raw: tokens.toString(), fill_source: a.fillSource ?? (a.dryRun ? 'quote_dry_run' : 'tx_meta') },
    original_tokens: tokens.toString(), tokens: tokens.toString(), basis_sol_per_token: a.basis === undefined ? BASE_PRICE : a.basis,
    peak_multiple: 1, legs_done: [], leg_attempts: {}, last_quote: null, lockouts: [], ata: null, next_due_at: now,
  } as PositionV2);
  w.balances.set(ca, tokens);
  if (!w.price.has(ca)) w.price.set(ca, BASE_PRICE);
  return p;
}

export function addOrder(w: World, pos: StoredPosition, o: Partial<StoredManualOrder> & Pick<StoredManualOrder, 'type' | 'trigger_pct'>): StoredManualOrder {
  return w.store.putOrder({
    order_id: `ord_${randomBytes(6).toString('hex')}`, position_id: pos.position_id, ca: pos.ca, wallet_id: pos.wallet_id,
    baseline_multi: null, peak_rel: null, expires_at: null, active: true, attempts: 0, created_at: w.clock.now(), source: 'migrated', ...o,
  });
}

/** Sets the scripted price to `multiple` x the base price. */
export function setMultiple(w: World, ca: string, multiple: number | null): void {
  w.price.set(ca, multiple === null ? null : BASE_PRICE * multiple);
}

/** The real valuation chain over stubs (the Engine-price cases). */
export function realValuation(w: World, o: {
  onchain?: number | null; jupiter?: number | null | 'throws'; engineUsd?: { token: number; sol: number; tokenAgeMs: number; solAgeMs?: number } | 'error'; decimals?: number | null;
}): Valuation {
  return createValuation({
    clock: w.clock,
    onchain: { async quoteSell() { return o.onchain === undefined || o.onchain === null ? null : { venue: 'pump-curve', solOutLamports: BigInt(Math.round(o.onchain * 1e9)), sol: o.onchain, at: w.clock.now() }; } },
    async jupQuote() {
      if (o.jupiter === 'throws') throw new Error('Jupiter quote failed: 429');
      return o.jupiter === undefined || o.jupiter === null ? null : { outAmount: String(Math.round(o.jupiter * 1e9)) };
    },
    engine: {
      async price(ca: string) {
        if (o.engineUsd === undefined || o.engineUsd === 'error') return { error: 'engine offline' };
        const isSol = ca.startsWith('So111');
        const age = isSol ? (o.engineUsd.solAgeMs ?? o.engineUsd.tokenAgeMs) : o.engineUsd.tokenAgeMs;
        return { price: { value: isSol ? o.engineUsd.sol : o.engineUsd.token, src: 'gmgn.token_info', as_of: w.clock.now() - age }, frozen: false, drained: false };
      },
    },
    decimals: async () => (o.decimals === undefined ? 6 : o.decimals),
    log: () => { /* silent */ },
  });
}
