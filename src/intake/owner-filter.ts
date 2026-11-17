// A-115 (CARD-MENU spec section 5.2): the owner's restored Signals filters (Active, Min Score, Min/Max MCap, Min/Max Liq), applied by the
// bot to the cards the owner gets AND to auto-buy. They are only ever STRICTER than the Engine: they can remove a card or a buy, never bring
// back what the Engine, the grade filter, launch-run or the arms block.
//
// Pure. A bound that is SET but cannot be read (a hand-edited file, kept as 'invalid') fails closed, and so does a set liquidity bound when
// the liquidity of the decision is unknown (the old bot's T6 rule).
import type { SignalNew } from '../shared/contract/v1';

/** A USD bound or the minimum score: null = no limit; 'invalid' = set in the file but unreadable (fails closed until re-entered). */
export type Bound = number | null | 'invalid';
export interface OwnerFilterSettings {
  enabled: boolean;
  minScore: Bound;
  minMcap: Bound; maxMcap: Bound;
  minLiquidity: Bound; maxLiquidity: Bound;
}
export type OwnerFilterName = 'signals-off' | 'min-score' | 'min-mcap' | 'max-mcap' | 'min-liq' | 'max-liq';
/** The `error` prefix of a delivery the owner filter removed. */
export const OWNER_FILTER_PREFIX = 'owner-filter:';

/** The liquidity the filter compares: the Engine's own liq_eff (detail), else the smaller of the known liquidity readings (the same rule). */
export function liquidityOf(sig: SignalNew): number | null {
  const eff = sig.detail?.liq_eff_usd.value;
  if (typeof eff === 'number' && Number.isFinite(eff)) return eff;
  const known = [sig.market.liq_usd.value, sig.market.pool_liq_usd.value].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return known.length > 0 ? Math.min(...known) : null;
}

const set = (b: Bound): boolean => b !== null;
const fails = (b: Bound, ok: (n: number) => boolean): boolean => b !== null && (b === 'invalid' || !Number.isFinite(b) || !ok(b));

/** The names of the filters the signal fails; [] = it passes. */
export function ownerFilter(sig: SignalNew, s: OwnerFilterSettings): OwnerFilterName[] {
  const out: OwnerFilterName[] = [];
  if (s.enabled !== true) out.push('signals-off');
  const conf = sig.decision.confidence;
  if (fails(s.minScore, n => Number.isFinite(conf) && conf >= n)) out.push('min-score');
  const mcap = sig.entry.mcap_usd;
  if (fails(s.minMcap, n => mcap >= n)) out.push('min-mcap');
  if (fails(s.maxMcap, n => mcap <= n)) out.push('max-mcap');
  const liq = liquidityOf(sig);
  if (set(s.minLiquidity) && (liq === null || fails(s.minLiquidity, n => liq >= n))) out.push('min-liq');
  if (set(s.maxLiquidity) && (liq === null || fails(s.maxLiquidity, n => liq <= n))) out.push('max-liq');
  return out;
}

/** `owner-filter:min-score,max-mcap` (the delivery error), or null when nothing failed. */
export function ownerFilterError(names: readonly string[]): string | null {
  return names.length === 0 ? null : `${OWNER_FILTER_PREFIX}${names.join(',')}`;
}
