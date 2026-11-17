// FROZEN CONTRACT (R0-CONTRACTS, round 0a; C01 section 3, D-10). Changes only by a numbered plan amendment.
// Canonical source: R\shared\dashboard\freshness.ts; byte-identical copies are written only by R\scripts\sync-shared.ps1.
// Amended by A-98 (R7-W3, round 7a): FreshClass TX_QUOTE (live 20 s, aging 45 s) and ANALYSIS (900 s / 3600 s): 12 aging classes.
// The ONE freshness table of the system. Pure functions: nothing here reads the clock or any Node API (the dashboard imports this file).
import { FRESHNESS_WORST_ORDER } from '../common/ids';
import type { Freshness, Ms } from '../common/ids';
import type { Measured } from './contract';
export type FreshClass = 'MARKET' | 'POOL' | 'KLINE' | 'HOLDERS' | 'SECURITY' | 'TRENCH_RISK' | 'FEED' | 'SOL_USD' | 'WALLET' | 'QUERY' | 'IDENTITY' | 'DECISION'
  | 'TX_QUOTE' | 'ANALYSIS';   // A-98 (round 7): a wallet transaction quote; an UnclaimedSol analysis snapshot

/** liveMs/agingMs are ages of obsAt at serverNow. Beyond agingMs the state is 'stale'. null = class never ages. */
export const FRESHNESS: Readonly<Record<FreshClass, { liveMs: number | null; agingMs: number | null }>> = Object.freeze({
  MARKET:      { liveMs: 45_000,  agingMs: 120_000 },     // price, mcap, multiple, info liquidity, vol/buys/sells/swaps, info c5m/c1h
  POOL:        { liveMs: 60_000,  agingMs: 180_000 },     // pool_info liquidity and reserves
  KLINE:       { liveMs: 120_000, agingMs: 600_000 },     // candle-derived values, obsAt = candle close
  HOLDERS:     { liveMs: 120_000, agingMs: 600_000 },     // holder count, top10, dev/creator rates, wallet-tag counts
  SECURITY:    { liveMs: 600_000, agingMs: 1_800_000 },   // mint/freeze, taxes, wash, honeypot
  TRENCH_RISK: { liveMs: 600_000, agingMs: 21_600_000 },  // rug_ratio, insider, bundler from trench rows
  FEED:        { liveMs: 30_000,  agingMs: 120_000 },     // smart-money / KOL feed poll time
  SOL_USD:     { liveMs: 120_000, agingMs: 300_000 },
  WALLET:      { liveMs: 60_000,  agingMs: 300_000 },     // bot wallet and position values
  QUERY:       { liveMs: 30_000,  agingMs: 120_000 },     // counts, rates, health/budget/integrity query values (obsAt = query time)
  IDENTITY:    { liveMs: null,    agingMs: null },        // symbol, creation/open time, launchpad: always 'live'
  DECISION:    { liveMs: null,    agingMs: null },        // frozen decision snapshot: always 'final'
  TX_QUOTE:    { liveMs: 20_000,  agingMs: 45_000 },      // A-98: a wallet quote (route quote, bound, simulation); a stale quote cannot be signed
  ANALYSIS:    { liveMs: 900_000, agingMs: 3_600_000 },   // A-98: an UnclaimedSol analysis; the 60-min snapshot expiry is the aging limit
});
export const HEARTBEAT_FACTOR = Object.freeze({ live: 2, aging: 5 }); // × loop interval; beyond → 'stale' (= down)
export const STREAM = Object.freeze({ heartbeatMs: 5_000, degradedMs: 12_000, disconnectedMs: 20_000, VIEW_REFRESH_MS: 15_000 });
export const CHECKPOINT_GRACE_MS = 900_000;   // a checkpoint read is 'pending' until due + 15 min, then 'stale' (read-overdue)

/** Pure. Rules, in order:
 *  1 cls DECISION → 'final'. 2 obsAt null → 'missing'. 3 frozenSince non-null → 'frozen'.
 *  4 cls IDENTITY → 'live'. 5 age = max(0, serverNow − obsAt). 6 age ≤ liveMs → 'live'; age ≤ agingMs → 'aging'; else 'stale'. */
export function classifyFreshness(cls: FreshClass, obsAt: Ms | null, serverNow: Ms, frozenSince?: Ms | null): Freshness {
  if (cls === 'DECISION') return 'final';
  if (obsAt === null) return 'missing';
  if (frozenSince !== undefined && frozenSince !== null) return 'frozen';
  if (cls === 'IDENTITY') return 'live';
  const age = Math.max(0, serverNow - obsAt);
  const { liveMs, agingMs } = FRESHNESS[cls];
  if (liveMs === null || agingMs === null) return 'live';   // a class that never ages (only IDENTITY and DECISION, both handled above)
  if (age <= liveMs) return 'live';
  if (age <= agingMs) return 'aging';
  return 'stale';
}

/** live if age ≤ 2×interval, aging if ≤ 5×interval, else stale; lastAt null → 'missing'. */
export function heartbeatState(intervalMs: number, lastAt: Ms | null, now: Ms): Freshness {
  if (lastAt === null) return 'missing';
  const age = Math.max(0, now - lastAt);
  if (age <= HEARTBEAT_FACTOR.live * intervalMs) return 'live';
  if (age <= HEARTBEAT_FACTOR.aging * intervalMs) return 'aging';
  return 'stale';
}

/** connected while the last stream heartbeat is ≤ STREAM.degradedMs old, degraded up to STREAM.disconnectedMs, then disconnected.
 *  No heartbeat yet (null) → 'disconnected'. */
export function streamState(lastHeartbeatAt: Ms | null, now: Ms): 'connected' | 'degraded' | 'disconnected' {
  if (lastHeartbeatAt === null) return 'disconnected';
  const age = Math.max(0, now - lastHeartbeatAt);
  if (age <= STREAM.degradedMs) return 'connected';
  if (age <= STREAM.disconnectedMs) return 'degraded';
  return 'disconnected';
}

/** Worst by FRESHNESS_WORST_ORDER; empty array → 'missing'. */
export function worstState(states: readonly Freshness[]): Freshness {
  if (states.length === 0) return 'missing';
  let worst = states[0];
  for (const s of states) if (FRESHNESS_WORST_ORDER.indexOf(s) < FRESHNESS_WORST_ORDER.indexOf(worst)) worst = s;
  return worst;
}

/** Pure; never reads the clock. Client-side re-classification of a received value after elapsedMs of local monotonic time.
 *  m.state ∈ {live, aging, stale} and m.ageMs !== null → classifyFreshness(m.cls, 0, m.ageMs + Math.max(0, elapsedMs));
 *  otherwise m.state unchanged (frozen, final, pending, missing, error are kept as sent). */
export function reclassify(m: Measured<unknown>, elapsedMs: number): Freshness {
  if ((m.state === 'live' || m.state === 'aging' || m.state === 'stale') && m.ageMs !== null) {
    return classifyFreshness(m.cls, 0, m.ageMs + Math.max(0, elapsedMs));
  }
  return m.state;
}
