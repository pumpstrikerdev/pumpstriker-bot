/**
 * ON-CHAIN QUOTE — the executable sell value of a bag, computed from on-chain reserves with the routers' OWN math
 * (B40 rule 5). It is source 1 of the B30 valuation chain (`src: 'onchain'`): the reserves of the pump bonding curve (one
 * getAccountInfo) or, for a graduated token, of the PumpSwap pool, run through the same `quoteSell` the swap code uses
 * to compute its `min output`. No third party is involved and nothing is quoted from a constant.
 *
 *   curve   : pumpfun-swap.ts quoteSell(virtualSol, virtualToken, tokensIn)       (1 % fee on the SOL out)
 *   pool    : pumpswap-swap.ts quoteSell(baseReserve, quoteReserve, tokensIn)      (0.95 % fee on the quote out)
 *
 * A null result means "no on-chain price" (account missing, RPC failure, a curve quoted in another mint than SOL, reserves too
 * large for the routers' number math, or a zero quote); the caller moves on to the next valuation source. Errors are never thrown.
 */
import { quoteSell as curveQuoteSell } from './pumpfun-swap';
import { quoteSell as poolQuoteSell } from './pumpswap-swap';
import { createCurveReader, type BondingCurveState, type CurveReader } from './curve-state';
import { isSolQuoted, SOL_QUOTE_MINTS } from './curve-parse';
import { systemClock, type ExecClock } from './exec-common';

export interface OnchainSellQuote {
  venue: 'pump-curve' | 'pumpswap';
  /** SOL out for the whole `tokensIn`, in lamports, net of the venue's fee (same rule as the router's min-output base). */
  solOutLamports: bigint;
  /** The same value in SOL (what Valuation.quote returns in `sol`). */
  sol: number;
  /** Clock time of the read, ms. */
  at: number;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

// FIX-QUOTE: SOL_QUOTE_MINTS and isSolQuoted (the one rule for "a curve's reserves are lamports") live in the pure curve-parse.ts since
// FIX-PUMP (the pump builders and the PF-direct verifier use them too); they are re-exported here under the same names.
export { SOL_QUOTE_MINTS, isSolQuoted };

/**
 * Pure: sell quote of `tokensIn` against a decoded bonding curve; null when the curve is complete, is quoted in another mint than SOL,
 * or numbers overflow.
 *
 * FIX-BUY2 item 6: a curve quoted in USDC or another pump coin holds its reserves in that mint, not lamports, so its quote is never a
 * SOL value (the -25 % floor compares this value with the SOL basis). The valuation then moves on to Jupiter. FIX-QUOTE: SOL-quoted means
 * isSolQuoted (the zero key, WSOL, the Token-2022 native mint, or an account too short to carry the field).
 */
export function quoteSellFromCurve(state: BondingCurveState, tokensIn: bigint): bigint | null {
  if (state.complete || tokensIn <= 0n) return null;
  if (!isSolQuoted(state.quoteMint)) return null;
  if (state.virtualSolReserves > MAX_SAFE || state.virtualTokenReserves > MAX_SAFE) return null;
  const out = curveQuoteSell(Number(state.virtualSolReserves), Number(state.virtualTokenReserves), tokensIn);
  return out > 0n ? out : null;
}

/** Pure: sell quote of `tokensIn` against PumpSwap pool reserves. */
export function quoteSellFromPool(baseReserves: bigint, quoteReserves: bigint, tokensIn: bigint): bigint | null {
  if (tokensIn <= 0n || baseReserves <= 0n || quoteReserves <= 0n) return null;
  const out = poolQuoteSell(baseReserves, quoteReserves, tokensIn);
  return out > 0n ? out : null;
}

export interface OnchainQuoter {
  quoteSell(mint: string, tokensIn: bigint): Promise<OnchainSellQuote | null>;
}

export function createOnchainQuoter(deps: { reader?: CurveReader; clock?: ExecClock } = {}): OnchainQuoter {
  const reader = deps.reader ?? createCurveReader();
  const clock = deps.clock ?? systemClock;
  const make = (venue: OnchainSellQuote['venue'], out: bigint): OnchainSellQuote => ({
    venue, solOutLamports: out, sol: Number(out) / 1e9, at: clock.now(),
  });
  return {
    async quoteSell(mint: string, tokensIn: bigint): Promise<OnchainSellQuote | null> {
      try {
        // Bonding curve first: one getAccountInfo. A live (not complete) curve is the venue.
        const curve = await reader.readBondingCurve(mint);
        if (curve && !curve.complete) {
          const out = quoteSellFromCurve(curve, tokensIn);
          return out === null ? null : make('pump-curve', out);
        }
        // Graduated (curve complete) or no curve account: PumpSwap pool reserves.
        const pool = await reader.readPumpSwapReserves(mint);
        if (!pool) return null;
        const out = quoteSellFromPool(pool.baseReserves, pool.quoteReserves, tokensIn);
        return out === null ? null : make('pumpswap', out);
      } catch {
        return null;
      }
    },
  };
}
