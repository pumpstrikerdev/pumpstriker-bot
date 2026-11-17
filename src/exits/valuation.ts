/**
 * valuation.ts (B30 rule 3): the executable SOL value of a position's bag, as `{ sol, src, at }`, from three sources in this order:
 *
 *   1. 'onchain'     pump bonding-curve PDA or PumpSwap pool reserves through B40's quote math (execution/onchain-quote.ts);
 *   2. 'jupiter'     `jupQuote` for the current bag (token -> SOL);
 *   3. 'engine_gmgn' `GET /api/bot/v1/price/:ca` through the Engine, only when its `as_of` is at most 30 s old, and ONLY when the caller
 *                    says the quote is for protective legs (E-3: a protective leg is never skipped for lack of a quote, a take-profit
 *                    leg is never judged on a number that is not executable truth).
 *
 * No other price site is ever consulted and no constant stands in for a missing number: the SOL price that turns the Engine's USD price
 * into SOL comes from the same Engine endpoint (the WSOL mint) and must be just as fresh; when it is missing the third source returns
 * nothing. Every source is injected (A-28), has a time budget, and a source that throws or hangs is "no quote", never an error.
 *
 * `sol` is the value of the WHOLE bag (`pos.tokens`). The exit engine divides it by the bag's token count to get SOL per token atom.
 */
import type { EngineClient, PositionV2, Valuation } from '../bot-contracts';
import type { Clock } from '../link/clock';
import { defaultLog, errMessage, type LinkLog } from '../link/common';
import type { OnchainSellQuote } from '../execution/onchain-quote';

export type QuoteSrc = 'onchain' | 'jupiter' | 'engine_gmgn';
export interface BagQuote { sol: number; src: QuoteSrc; at: number }

/** The Engine price is usable only when its as_of is at most this old (B30 rule 3). */
export const ENGINE_PRICE_MAX_AGE_MS = 30_000;
/** Time budget of each source; the three together stay inside one pass of the young cadence. */
export const SOURCE_TIMEOUT_MS = 3_000;
/** Wrapped SOL: the mint whose Engine price is the SOL price (read-bot-interface 2.4). */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** Jupiter slippage for a valuation quote only (nothing is sent from it). */
export const VALUATION_SLIPPAGE_BPS = 500;

export interface ValuationDeps {
  clock: Clock;
  /** B40's on-chain quoter (`createOnchainQuoter()`); only `quoteSell` is used. */
  onchain: { quoteSell(mint: string, tokensIn: bigint): Promise<OnchainSellQuote | null> };
  /** `jupQuote(inputMint, outputMint, amount, slippageBps)` of execution/jupiter.ts, or a stub. Default: that function, loaded on first use. */
  jupQuote?: (inputMint: string, outputMint: string, amount: number, slippageBps: number) => Promise<unknown>;
  engine: Pick<EngineClient, 'price'>;
  /** Decimals of a mint (only the Engine source needs them: its price is per whole token). null = unknown. */
  decimals: (ca: string) => Promise<number | null>;
  log?: LinkLog;
  timeoutMs?: number;
  maxEngineAgeMs?: number;
}

async function defaultJupQuote(inputMint: string, outputMint: string, amount: number, slippageBps: number): Promise<unknown> {
  const { jupQuote } = await import('../execution/jupiter');
  return jupQuote(inputMint, outputMint, amount, slippageBps);
}

/** A promise that resolves null when `p` takes longer than `ms` on the injected clock (the underlying work is not cancelled). */
function within<T>(clock: Clock, p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const timer = clock.setTimeout(() => resolve(null), ms);
    p.then(v => { clock.clearTimeout(timer); resolve(v); }, e => { clock.clearTimeout(timer); reject(e); });
  });
}

function lamportsToSol(v: unknown): number | null {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n / 1e9 : null;
}

export function createValuation(deps: ValuationDeps): Valuation {
  const log = deps.log ?? defaultLog;
  const timeoutMs = deps.timeoutMs ?? SOURCE_TIMEOUT_MS;
  const maxAge = deps.maxEngineAgeMs ?? ENGINE_PRICE_MAX_AGE_MS;
  const jup = deps.jupQuote ?? defaultJupQuote;

  async function guarded<T>(name: string, run: () => Promise<T | null>): Promise<T | null> {
    try {
      return await within(deps.clock, run(), timeoutMs);
    } catch (e) {
      log(`[valuation] ${name}: ${errMessage(e).slice(0, 120)}`, 'debug');
      return null;
    }
  }

  async function fromOnchain(pos: PositionV2, tokens: bigint): Promise<BagQuote | null> {
    const q = await deps.onchain.quoteSell(pos.ca, tokens);
    if (!q || !Number.isFinite(q.sol) || !(q.sol > 0)) return null;
    return { sol: q.sol, src: 'onchain', at: Number.isFinite(q.at) ? q.at : deps.clock.now() };
  }

  async function fromJupiter(pos: PositionV2, tokens: bigint): Promise<BagQuote | null> {
    if (tokens > BigInt(Number.MAX_SAFE_INTEGER)) return null;   // jupQuote takes a JS number: a larger bag cannot be expressed exactly
    const q = await jup(pos.ca, WSOL_MINT, Number(tokens), VALUATION_SLIPPAGE_BPS);
    const out = (q as { outAmount?: unknown } | null | undefined)?.outAmount;
    const sol = lamportsToSol(out);
    return sol === null ? null : { sol, src: 'jupiter', at: deps.clock.now() };
  }

  async function fromEngine(pos: PositionV2, tokens: bigint): Promise<BagQuote | null> {
    const [tok, sol, dec] = await Promise.all([deps.engine.price(pos.ca), deps.engine.price(WSOL_MINT), deps.decimals(pos.ca)]);
    if ('error' in tok || 'error' in sol) return null;
    if (tok.frozen || sol.frozen) return null;                                  // a frozen price is not a live quote
    const now = deps.clock.now();
    const usdPerToken = tok.price.value;
    const usdPerSol = sol.price.value;
    if (usdPerToken === null || usdPerSol === null || tok.price.as_of === null || sol.price.as_of === null) return null;
    if (!Number.isFinite(usdPerToken) || usdPerToken < 0 || !Number.isFinite(usdPerSol) || !(usdPerSol > 0)) return null;
    if (now - tok.price.as_of > maxAge || now - sol.price.as_of > maxAge) return null;
    if (dec === null || !Number.isInteger(dec) || dec < 0 || dec > 18) return null;
    const bag = Number(tokens) / Math.pow(10, dec);
    const value = (usdPerToken / usdPerSol) * bag;
    if (!Number.isFinite(value)) return null;
    return { sol: value, src: 'engine_gmgn', at: Math.min(tok.price.as_of, sol.price.as_of) };
  }

  return {
    async quote(pos: PositionV2, protectiveOnly: boolean): Promise<BagQuote | null> {
      let tokens: bigint;
      try { tokens = BigInt(pos.tokens); } catch { return null; }
      if (tokens <= 0n) return null;
      const a = await guarded('onchain', () => fromOnchain(pos, tokens));
      if (a) return a;
      const b = await guarded('jupiter', () => fromJupiter(pos, tokens));
      if (b) return b;
      if (!protectiveOnly) return null;
      return guarded('engine_gmgn', () => fromEngine(pos, tokens));
    },
  };
}
