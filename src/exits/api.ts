/**
 * api.ts (B30 rule 7): `ExitApi.cancel`, the one call the intake makes when the Engine retracts a signal (`signal.cancel`, retro-kill).
 *
 *   a signal position is held   -> leg CANCEL: a guaranteed exit of 100% (the doubled base slippage escalating to 5000 bps, then the
 *                                  9900 bps panic leg), 2 attempts, then locked_out and an owner alert -> 'executed';
 *   none held                   -> 'no_position' (the intake shows the cancel card and sells nothing). A-93f: when the auto-buy of the CA
 *                                  is still in the pending-buys journal the cancel is recorded (cancel-requests.ts) and applied to the
 *                                  position the moment it opens, so the CANCEL exit is not lost to that race (or to a restart).
 *
 * 'executed' means a CANCEL exit was run for every signal position of the CA; each attempt is reported by its own `exit.leg` event, so
 * a CANCEL that could not be sold shows up there (and in the owner alert), not in this return value. A cancel the engine could not finish
 * (another sell holds the wallet, or the first attempt failed) stays pending on the position and the passes retry it at once.
 * Manual positions are never touched: a retro-kill retracts a signal, not the user's own holding.
 */
import type { ExitApi } from '../bot-contracts';
import type { PositionsStoreV2 } from './positions-store';
import type { ExitEngine } from './exit-engine';
import { defaultLog, errMessage, type LinkLog } from '../link/common';
import type { CancelRequests } from './cancel-requests';

export interface ExitApiDeps {
  store: Pick<PositionsStoreV2, 'listOpen'>;
  engine: Pick<ExitEngine, 'cancelPosition'>;
  /** A-93f: is a live buy of this CA still in the pending-buys journal (no position yet)? */
  pendingBuy?: (ca: string) => boolean;
  /** A-93f: where such a cancel is remembered until the position opens. */
  requests?: CancelRequests;
  log?: LinkLog;
}

export function createExitApi(deps: ExitApiDeps): ExitApi {
  const log = deps.log ?? defaultLog;
  return {
    async cancel(ca, signalId) {
      const held = deps.store.listOpen().filter(p =>
        p.origin === 'signal' && p.ca === ca && (BigInt(p.tokens) > 0n || p.close_pending !== null));
      if (held.length === 0) {
        if (deps.requests !== undefined && deps.pendingBuy?.(ca) === true) {
          try {
            deps.requests.add(ca, signalId);
            log(`[exits] cancel for ${ca.slice(0, 8)}.. arrived while its buy is still pending: it is applied when the position opens`, 'warn');
          } catch (e) { log(`[exits] the cancel for ${ca.slice(0, 8)}.. could not be recorded: ${errMessage(e).slice(0, 120)}`, 'err'); }
        }
        return 'no_position';
      }
      for (const p of held) {
        if (p.signal_id !== null && p.signal_id !== signalId) log(`[exits] cancel for signal ${signalId.slice(0, 12)} reaches a position of signal ${p.signal_id.slice(0, 12)} on the same CA`, 'warn');
      }
      await Promise.all(held.map(async p => {
        try {
          await deps.engine.cancelPosition(p.position_id);
        } catch (e) {
          // The position stays cancel_pending (the engine sets it before it tries), so the passes retry it.
          log(`[exits] cancel of ${p.position_id.slice(0, 12)} did not finish: ${errMessage(e).slice(0, 120)}`, 'err');
        }
      }));
      return 'executed';
    },
  };
}
