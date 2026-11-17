/**
 * WALLET FIND — look for the transaction a wallet may already have sent (R7-W5, A-104, design 7.6 "Find").
 *
 * After an "outcome unknown" wallet error (the popup closed, a generic error after "send") the page does not know whether the wallet
 * signed and broadcast. `findWalletTransactions` asks the chain: `getSignaturesForAddress(owner, {limit: 10})` for the owner's newest
 * signatures from the quote's slot on, then `getTransaction` for at most 3 candidates (the newest successful ones). A candidate matches
 * when the owner is the fee payer, the transaction succeeded, and the owner's token balance of the quote's mint moved on the quote's
 * side (buy: up, sell: down). At most 1 + 3 RPC calls. Matches are booked by the Engine through the normal fill path; no match is an
 * empty list ("no matching transaction found yet"), never a guess. Reads only, commitment confirmed, through the injected wallet port.
 */
import { computeTxDeltas, accountKeysOf, type RpcTransactionView } from './tx-deltas';
import { refusalFromError, walletRefusal, isRpcBudgetError, type WalletRpcPort } from './wallet-rpc';
import type { WalletFindOk, WalletFindRequest, WalletLinkRefusal } from '../shared/contract/wallet-link';
import { isBase58Pubkey } from '../shared/contract/wallet-validate';

export const WALLET_FIND_SIGNATURE_LIMIT = 10;
export const WALLET_FIND_MAX_CANDIDATES = 3;

export interface WalletFindDeps { rpc: WalletRpcPort }

export async function findWalletTransactions(deps: WalletFindDeps, req: WalletFindRequest): Promise<WalletFindOk | WalletLinkRefusal> {
  if (!isBase58Pubkey(req.owner) || !isBase58Pubkey(req.mint) || (req.side !== 'buy' && req.side !== 'sell') || !Number.isSafeInteger(req.sinceSlot) || req.sinceSlot < 0) {
    return walletRefusal('bad-request', 'owner and mint must be base58 addresses, side buy or sell, sinceSlot a non-negative integer');
  }
  let list: unknown;
  try {
    list = await deps.rpc.call('getSignaturesForAddress', [req.owner, { limit: WALLET_FIND_SIGNATURE_LIMIT, commitment: 'confirmed', minContextSlot: req.sinceSlot }]);
  } catch (e) { return refusalFromError(e); }
  if (!Array.isArray(list)) return walletRefusal('build-failed', 'getSignaturesForAddress answer is malformed');
  const candidates: string[] = [];
  for (const row of list) {
    const r = row as { signature?: unknown; slot?: unknown; err?: unknown };
    if (typeof r?.signature !== 'string' || typeof r.slot !== 'number') return walletRefusal('build-failed', 'getSignaturesForAddress answer is malformed');
    if (r.slot < req.sinceSlot || (r.err !== null && r.err !== undefined)) continue;
    if (candidates.length < WALLET_FIND_MAX_CANDIDATES) candidates.push(r.signature);
  }
  const signatures: string[] = [];
  for (const sig of candidates) {
    let tx: RpcTransactionView | null;
    try {
      tx = (await deps.rpc.call('getTransaction', [sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])) as RpcTransactionView | null;
    } catch (e) {
      if (isRpcBudgetError(e)) return refusalFromError(e);
      continue;
    }
    if (!tx || !tx.meta || (tx.meta.err !== null && tx.meta.err !== undefined)) continue;
    const keys = accountKeysOf(tx);
    if (!keys || keys[0] !== req.owner) continue;
    const d = computeTxDeltas(tx, req.owner, req.mint);
    if (!d) continue;
    if ((req.side === 'buy' && d.tokenDelta > 0n) || (req.side === 'sell' && d.tokenDelta < 0n)) signatures.push(sig);
  }
  return { ok: true, signatures };
}
