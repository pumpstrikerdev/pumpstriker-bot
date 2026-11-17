/**
 * sell-runner.ts: ONE sell attempt of a leg or a manual order (A-28, A-29, A-59).
 *
 * An attempt walks the slippage ladder of its kind (`slippageLadder`: a take-profit has one step, a protective exit has the guaranteed
 * exit and then the 9900 bps panic leg, a cancel has the doubled base, 5000 and the panic leg). Every step is ONE send:
 * `smartSell(keypair, mint, tokens, { singleSend: true, slippageBps, onSigned })`, so the router never retries or falls back on its own
 * and every signature it signs is known here. Before any retry (the next step, the next attempt, a restart that finds an unresolved
 * signature) the landed-check runs on every signature that was signed or sent and on the wallet balance (`checkSellLanded`): a sell that
 * landed although it reported a failure is never sent again.
 *
 * What a resolved send is worth is decided by the real fill (`FillReader.sellFill`), never by the quote:
 *   - a verified fill with tokens sold is 'filled';
 *   - a fill with `tokensSoldRaw` 0 is an empty or reverted transaction (A-29): a failed step, retried per the failure policy;
 *   - an unreadable meta is 'filled_unconfirmed' (the send resolved, so the sell is assumed to have landed; PnL for it stays null).
 * An error that is not a RouterSendError means nothing was sent; a RouterSendError carries `sigs` (A-59).
 *
 * The router is injected (`SmartSellFn`); this module never imports router.ts as a value and never reads the clock except through
 * the injected one.
 */
import type { Keypair } from '@solana/web3.js';
import type { FillReader, SellFill } from '../bot-contracts';
import type { Clock } from '../link/clock';
import { defaultLog, errMessage, type LinkLog } from '../link/common';
import type { RouterOpts, RouterResult, RouterSendError, SignedTx } from '../execution/router';
import type { smartSell } from '../execution/router';
import { checkSellLanded, errorString, sendsMayStillLand, slippageLadder, type LandedCheckDeps, type SellKind } from './failure-policy';

/** `smartSell` of execution/router.ts (A-26 options included); R4-B6 passes the real function, tests pass stubs. */
export type SmartSellFn = typeof smartSell;
export type { RouterOpts, RouterResult, RouterSendError, SignedTx };

export interface SellRunnerDeps {
  smartSell: SmartSellFn;
  fills: FillReader;
  chain: LandedCheckDeps;
  clock: Clock;
  log?: LinkLog;
}

export interface SellAttemptInput {
  owner: string;
  keypair: Keypair;
  mint: string;
  kind: SellKind;
  /** 1-based attempt number of the leg(s) this sell belongs to. */
  attemptNo: number;
  /** Token atoms to sell now. */
  tokens: bigint;
  /** What the engine tracks as held now (atoms), for the balance heuristic of the landed-check. */
  trackedAtoms: number;
  /** Percent of the tracked holding this sell is (100 for a full exit). */
  sellPct: number;
  /** Signatures of earlier sends whose outcome is not resolved (persisted across passes and restarts). */
  priorSigs: readonly string[];
  /** A-93f: lastValidBlockHeight of the prior signatures (sig -> height), persisted with them. */
  priorSigHeights?: Readonly<Record<string, number>>;
  slippage: { baseBps: number; smartMaxBps: number };
  /** Called with every signature the moment it is signed (before the send) and its lastValidBlockHeight: the caller persists both. */
  onSignature?: (sig: string, lastValidBlockHeight: number | null) => void;
  /** A-93f: refuse to send while an earlier send may still land (status unknown, blockhash not expired); default true for a take-profit
   *  ('tp', a partial sale that would sell twice). A full exit may go on (a second full exit cannot sell more than the wallet holds). */
  waitForInFlight?: boolean;
}

export type SellAttemptResult =
  | { status: 'filled'; sig: string; fill: SellFill; tokensSold: bigint; sendAt: number | null; confirmAt: number | null; slippageBps: number | null; sigs: string[]; via: 'send' | 'landed_check' }
  | { status: 'filled_unconfirmed'; sig: string | null; sendAt: number | null; slippageBps: number | null; sigs: string[];
      /** 'balance': the landed-check saw the balance drop; 'fill_unverified': the send resolved but its meta could not be read. */
      via: 'balance' | 'fill_unverified'; balanceRaw: number | null }
  /** `sent` (A-93f): false when this attempt signed and sent nothing (an RPC or quote failure before signing); such an attempt does
   *  not count against the attempt budget. */
  | { status: 'failed'; error: string; sigs: string[]; sendAt: number | null; slippageBps: number | null; sent: boolean }
  /** Nothing was sent and nothing counts as an attempt: the wallet reads empty and the reconcile rule owns that case. */
  | { status: 'skipped'; reason: 'zero_balance' | 'nothing_to_sell'; sigs: string[] }
  /** A-93f: nothing was sent because an earlier send may still land (its blockhash has not expired); check again later. */
  | { status: 'in_flight'; sigs: string[] };

/** The signatures an error carries (RouterSendError.sigs). An error that has none sent nothing (A-59). */
export function sigsOfError(e: unknown): string[] {
  const s = (e as Pick<RouterSendError, 'sigs'> | null | undefined)?.sigs;
  return Array.isArray(s) ? s.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

function pushUnique(list: string[], sig: string): void {
  if (sig.length > 0 && !list.includes(sig)) list.push(sig);
}

export async function runSellAttempt(deps: SellRunnerDeps, a: SellAttemptInput): Promise<SellAttemptResult> {
  const log = deps.log ?? defaultLog;
  if (a.tokens <= 0n) return { status: 'skipped', reason: 'nothing_to_sell', sigs: [...a.priorSigs] };
  const sigs: string[] = [...a.priorSigs];
  const heights: Record<string, number> = { ...(a.priorSigHeights ?? {}) };
  const waitInFlight = a.waitForInFlight ?? a.kind === 'tp';
  const checkArgs = (): Parameters<typeof checkSellLanded>[1] => ({
    owner: a.owner, mint: a.mint, sigs, trackedAtoms: a.trackedAtoms, sellPct: a.sellPct,
  });

  /** The outcome when the landed-check says an earlier send landed: read ITS fill, never assume one. */
  async function landed(v: Awaited<ReturnType<typeof checkSellLanded>> & { landed: true }): Promise<SellAttemptResult> {
    if (v.via === 'status') {
      const fill = await readSellFill(deps.fills, v.sig, a.owner, a.mint);
      if (fill !== 'unverified' && BigInt(fill.tokensSoldRaw) > 0n) {
        return { status: 'filled', sig: v.sig, fill, tokensSold: BigInt(fill.tokensSoldRaw), sendAt: null,
          confirmAt: Number.isFinite(fill.confirmedAt) ? fill.confirmedAt : null, slippageBps: null, sigs, via: 'landed_check' };
      }
      return { status: 'filled_unconfirmed', sig: v.sig, sendAt: null, slippageBps: null, sigs, via: 'fill_unverified', balanceRaw: null };
    }
    return { status: 'filled_unconfirmed', sig: sigs.length > 0 ? sigs[sigs.length - 1] : null, sendAt: null, slippageBps: null, sigs,
      via: 'balance', balanceRaw: v.rawAtoms };
  }

  // Before a retry (or when a restart left an unresolved signature): did the earlier send land after all?
  if (a.attemptNo > 1 || sigs.length > 0) {
    const v = await checkSellLanded(deps.chain, checkArgs());
    if (v.landed) return landed(v);
    if (v.balance === 0 && sigs.length === 0) return { status: 'skipped', reason: 'zero_balance', sigs };
    // A-93f: not landed (yet). While an earlier send may still land, a second send of the same sale would sell it twice.
    if (waitInFlight && sigs.length > 0 && await sendsMayStillLand(deps.chain, sigs, heights)) return { status: 'in_flight', sigs };
  }

  const ladder = slippageLadder(a.kind, a.attemptNo, a.slippage.baseBps, a.slippage.smartMaxBps);
  let lastError: unknown = new Error('no sell was attempted');
  let lastSendAt: number | null = null;
  let lastBps: number | null = null;
  for (let step = 0; step < ladder.length; step++) {
    if (step > 0 && sigs.length > 0) {
      const v = await checkSellLanded(deps.chain, checkArgs());
      if (v.landed) return landed(v);
      if (waitInFlight && await sendsMayStillLand(deps.chain, sigs, heights)) break;
    }
    const bps = ladder[step];
    lastBps = bps;
    lastSendAt = deps.clock.now();
    try {
      const opts: RouterOpts = {
        singleSend: true,
        slippageBps: bps,
        onSigned: async (s: SignedTx) => {
          pushUnique(sigs, s.sig);
          const h = Number.isFinite(s.lastValidBlockHeight) ? s.lastValidBlockHeight : null;
          if (h !== null) heights[s.sig] = h;
          a.onSignature?.(s.sig, h);
        },
      };
      const res = await deps.smartSell(a.keypair, a.mint, a.tokens, opts);
      pushUnique(sigs, res.sig);
      for (const s of res.sigs ?? []) pushUnique(sigs, s);
      if (res.sent === false) throw new Error('the router built the transaction but did not send it');
      const fill = await readSellFill(deps.fills, res.sig, a.owner, a.mint);
      if (fill === 'unverified') {
        return { status: 'filled_unconfirmed', sig: res.sig, sendAt: lastSendAt, slippageBps: bps, sigs, via: 'fill_unverified', balanceRaw: null };
      }
      const sold = BigInt(fill.tokensSoldRaw);
      if (sold <= 0n) {
        // A-29: a confirmed transaction that sold nothing is a reverted or empty fill; it is a failed step.
        lastError = new Error('the sell transaction confirmed but sold no tokens (reverted or empty fill)');
        log(`[exits] empty sell fill on ${res.sig.slice(0, 8)}…; treated as a failed step`, 'warn');
        continue;
      }
      return { status: 'filled', sig: res.sig, fill, tokensSold: sold, sendAt: lastSendAt,
        confirmAt: Number.isFinite(fill.confirmedAt) ? fill.confirmedAt : null, slippageBps: bps, sigs, via: 'send' };
    } catch (e) {
      lastError = e;
      for (const s of sigsOfError(e)) pushUnique(sigs, s);
      log(`[exits] sell step ${step + 1}/${ladder.length} at ${bps} bps failed: ${errMessage(e).slice(0, 120)}`, 'warn');
    }
  }
  // The ladder is exhausted. A send that reported a failure (a confirmation timeout, a dropped connection) may still have landed:
  // look once more before the attempt is reported as failed.
  if (sigs.length > 0) {
    const v = await checkSellLanded(deps.chain, checkArgs());
    if (v.landed) return landed(v);
  }
  return { status: 'failed', error: errorString(lastError), sigs, sendAt: lastSendAt, slippageBps: lastBps, sent: sigs.length > a.priorSigs.length };
}

async function readSellFill(fills: FillReader, sig: string, owner: string, mint: string): Promise<SellFill | 'unverified'> {
  try {
    const f = await fills.sellFill(sig, owner, mint);
    if (f === 'unverified') return 'unverified';
    // A fill the engine cannot read as integers is not a fill.
    if (!/^\d+$/.test(f.tokensSoldRaw) || !/^-?\d+$/.test(f.solOutNetLamports)) return 'unverified';
    return f;
  } catch {
    return 'unverified';
  }
}
