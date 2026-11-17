/**
 * FILLS — book only what the chain says happened (B40 rule 1; read-bot-interface 5.3.5).
 *
 * A fill is read from the confirmed transaction's meta, never from a pre-slippage quote:
 *   getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
 *   - owner lamport delta  = post - pre of the owner's native balance (the fee payer pays `meta.fee` out of it);
 *   - token delta          = sum over pre/postTokenBalances of the entries whose owner AND mint match (both token
 *                            programs are covered because the program id is not part of the filter).
 *   Buy:  solSpent = -delta(lamports) (includes the fee, ATA rent and tip);  tokens = delta(token).
 *   Sell: solOutNet = delta(lamports);  solOutGross = delta(lamports) + fee.
 *
 * The meta is polled for up to 60 s. If it stays unreadable the leg is 'unverified': the caller reports PnL null and
 * "quoted, unverified" and keeps the quote in its `*_quoted` field. This module NEVER builds a fill from a quote, and
 * it is the only place that constructs BuyFill / SellFill objects (a static test in router.test.ts enforces that).
 *
 * A transaction that failed on-chain (meta.err) is not special-cased: the same arithmetic applies, so the result is the
 * truth (no tokens, only the fee spent). The confirm step of the swap code throws on a revert before a caller asks.
 */
import type { BuyFill, FillReader, SellFill } from '../bot-contracts';
import { defaultExecRpc, systemClock, type ExecClock, type ExecRpc } from './exec-common';
import { accountKeysOf, computeTxDeltas, type RpcTokenBalance, type RpcTransactionView, type TxDeltas } from './tx-deltas';

export type FillResult = BuyFill | SellFill;

/** B40 rule 1: the meta must be readable within 60 s, else 'unverified'. */
export const FILL_META_TIMEOUT_MS = 60_000;
/** Pause between getTransaction polls while the transaction is not yet readable. */
export const FILL_POLL_MS = 1_000;

export interface FillReaderDeps {
  rpc?: ExecRpc;
  clock?: ExecClock;
  timeoutMs?: number;
  pollMs?: number;
}

// R7-W5 (A-104): the view types, TxDeltas, accountKeysOf and computeTxDeltas moved into the pure tx-deltas.ts (the unsigned wallet code reads
// fills through it without importing this file or exec-common.ts); they are re-exported here under the same names.
export { accountKeysOf, computeTxDeltas };
export type { RpcTokenBalance, RpcTransactionView, TxDeltas };

/** Pure: BuyFill from a transaction view (confirmedAt falls back to `nowMs` when the node reported no block time). */
export function buyFillFromTx(tx: RpcTransactionView | null | undefined, owner: string, mint: string, nowMs: number): BuyFill | 'unverified' {
  const d = computeTxDeltas(tx, owner, mint);
  if (!d) return 'unverified';
  return {
    solSpentLamports: (-d.lamportsDelta).toString(),
    tokensRaw: d.tokenDelta.toString(),
    feeLamports: d.feeLamports.toString(),
    confirmedAt: d.blockTimeMs ?? nowMs,
  };
}

/** Pure: SellFill from a transaction view. */
export function sellFillFromTx(tx: RpcTransactionView | null | undefined, owner: string, mint: string, nowMs: number): SellFill | 'unverified' {
  const d = computeTxDeltas(tx, owner, mint);
  if (!d) return 'unverified';
  return {
    solOutNetLamports: d.lamportsDelta.toString(),
    solOutGrossLamports: (d.lamportsDelta + d.feeLamports).toString(),
    tokensSoldRaw: (-d.tokenDelta).toString(),
    feeLamports: d.feeLamports.toString(),
    confirmedAt: d.blockTimeMs ?? nowMs,
  };
}

/**
 * Poll getTransaction until the meta is readable or `timeoutMs` elapse on `clock`. RPC errors count as "not yet
 * readable". Resolves null on timeout. Exported for close-account.ts (rent from the CloseAccount meta).
 */
export async function waitForTransaction(
  rpc: ExecRpc, clock: ExecClock, sig: string, timeoutMs: number, pollMs: number,
): Promise<RpcTransactionView | null> {
  if (typeof sig !== 'string' || sig.length === 0) return null;
  const start = clock.now();
  for (;;) {
    try {
      const tx = (await rpc.call('getTransaction', [sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])) as RpcTransactionView | null;
      if (tx && tx.meta) return tx;
    } catch {
      /* unreadable for now: keep polling until the deadline */
    }
    const left = timeoutMs - (clock.now() - start);
    if (left <= 0) return null;
    await clock.sleep(Math.min(pollMs, left));
  }
}

export function createFillReader(deps: FillReaderDeps = {}): FillReader {
  const rpc = deps.rpc ?? defaultExecRpc();
  const clock = deps.clock ?? systemClock;
  const timeoutMs = deps.timeoutMs ?? FILL_META_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? FILL_POLL_MS;
  return {
    async buyFill(sig: string, owner: string, mint: string): Promise<BuyFill | 'unverified'> {
      try {
        const tx = await waitForTransaction(rpc, clock, sig, timeoutMs, pollMs);
        return buyFillFromTx(tx, owner, mint, clock.now());
      } catch {
        return 'unverified';
      }
    },
    async sellFill(sig: string, owner: string, mint: string): Promise<SellFill | 'unverified'> {
      try {
        const tx = await waitForTransaction(rpc, clock, sig, timeoutMs, pollMs);
        return sellFillFromTx(tx, owner, mint, clock.now());
      } catch {
        return 'unverified';
      }
    },
  };
}
