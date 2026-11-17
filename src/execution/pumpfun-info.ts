/**
 * PUMPFUN INFO - the pump.fun coin-info fallback of the execution layer (A-27, A-39).
 *
 * The routers read the bonding curve from the chain first (curve-state.ts, B40 rule 5). When the chain read gives
 * nothing they fall back to pump.fun's own coin-info endpoint, which is what this module fetches. It used to live in
 * the scanner folder (pumpfun-direct.ts); it moved here, with the same behaviour (same endpoint, same field mapping,
 * same 60 s failure cooldown; A-93f: the cache now lives API_SNAPSHOT_MAX_AGE_MS, not 5 minutes), so that no execution module imports from the scanner folder
 * (A-27, A-39). A pump.fun host literal is allowed in src/execution/** only (guard G-S13), which is where this file lives.
 *
 *   Endpoint:  GET https://frontend-api-v3.pump.fun/coins-v2/{ca}
 *   Cost:      free, no auth, no rate limit observed
 *
 * The old scanner copy stays in place, untouched, until R4-B6 deletes it together with the other scanners;
 * position-monitor.ts no longer imports it (R3-B5: valuation comes from exits/valuation.ts).
 */
import fetch from 'node-fetch';
import { pumpfunCoinInfoUrl } from '../config';
import { logWarn } from '../logger';

/** A-93f: an API snapshot is used for at most this long (the trade that fetched it, a few seconds). It used to be 5 minutes (and 10 for
 *  the sync getter), so one slow chain read made every trade of the mint use reserves, minOut and the impact cap from a stale quote. */
export const API_SNAPSHOT_MAX_AGE_MS = 5_000;
const TTL = API_SNAPSHOT_MAX_AGE_MS;
const FAILURE_COOLDOWN_MS = 60_000;
const _cache = new Map<string, { data: PumpFunInfo; ts: number }>();
const _failed = new Map<string, number>();
const INFLIGHT = new Set<string>();

export interface PumpFunInfo {
  hasData: boolean;
  // Identity
  mint: string;
  name?: string;
  symbol?: string;
  // Status
  complete: boolean;             // true = graduated to PumpSwap
  isOnBondingCurve: boolean;     // !complete
  // Curve state
  virtualSolReserves: number;
  virtualTokenReserves: number;
  realSolReserves: number;
  realTokenReserves: number;
  totalSupply: number;
  bondingCurveProgress: number;   // 0-1, % toward graduation
  // Identity
  creator: string;                 // deployer address
  createdAtMs: number;
  // ATH / current MC as pump.fun reports them
  athMcap: number;                 // all-time-high market cap (USD)
  athAtMs: number;                 // when ATH was hit
  currentMcap: number;             // pump.fun's own MC reading (USD)
  // Socials
  twitter?: string;
  telegram?: string;
  website?: string;
  description?: string;
  // What is known for sure about a pump.fun bonding-curve token
  safetyVerdict: 'safe-bonding-curve' | 'graduated-needs-audit' | 'unknown';
}

function emptyInfo(): PumpFunInfo {
  return {
    hasData: false,
    mint: '',
    complete: false,
    isOnBondingCurve: false,
    virtualSolReserves: 0,
    virtualTokenReserves: 0,
    realSolReserves: 0,
    realTokenReserves: 0,
    totalSupply: 0,
    bondingCurveProgress: 0,
    creator: '',
    createdAtMs: 0,
    athMcap: 0,
    athAtMs: 0,
    currentMcap: 0,
    safetyVerdict: 'unknown',
  };
}

function isCoolingDown(ca: string): boolean {
  const next = _failed.get(ca);
  if (!next) return false;
  if (Date.now() > next) { _failed.delete(ca); return false; }
  return true;
}

/**
 * Fetch pump.fun coin-info for a mint. Async; populates the cache for the next sync read.
 * Never throws: every failure is an empty `hasData: false` answer plus a 60 s cooldown for that mint.
 */
export async function fetchPumpFunInfo(ca: string): Promise<PumpFunInfo> {
  const cached = _cache.get(ca);
  if (cached && Date.now() - cached.ts < TTL) return cached.data;
  if (isCoolingDown(ca)) return emptyInfo();
  if (INFLIGHT.has(ca)) return cached?.data || emptyInfo();
  INFLIGHT.add(ca);

  try {
    // 2026-09-25: /coins/{ca} now 404s for every mint; pump.fun serves the
    // same object (superset of the fields read below) at /coins-v2/{ca}.
    // The host derives from PUMPFUN_API_BASE (test override, config.ts); unset = https://frontend-api-v3.pump.fun.
    const url = pumpfunCoinInfoUrl(ca);
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; pumpstriker/5.1)',
        'Accept': 'application/json',
      },
      timeout: 8000,
    });
    INFLIGHT.delete(ca);

    if (!r.ok) {
      // 404 = unknown CA (probably not a pumpfun token), 503 = challenge wall
      if (r.status === 404 || r.status === 403 || r.status >= 500) {
        _failed.set(ca, Date.now() + FAILURE_COOLDOWN_MS);
      }
      return emptyInfo();
    }

    const d = await r.json() as any;
    if (!d?.mint || d.mint !== ca) {
      _failed.set(ca, Date.now() + FAILURE_COOLDOWN_MS);
      return emptyInfo();
    }

    const virtualSol = parseFloat(d.virtual_sol_reserves || 0);
    const virtualTok = parseFloat(d.virtual_token_reserves || 0);
    const realSol    = parseFloat(d.real_sol_reserves || 0);
    const realTok    = parseFloat(d.real_token_reserves || 0);
    const totalSup   = parseFloat(d.total_supply || 0);
    const complete   = !!d.complete;

    // Bonding curve progress - pumpfun graduates at ~85 SOL real reserves
    // (price-dependent but 85 SOL is the standard graduation trigger)
    const GRADUATION_SOL = 85e9; // 85 SOL in lamports
    const progress = complete ? 1 : Math.min(1, realSol / GRADUATION_SOL);

    // Safety verdict - bonding-curve tokens are protocol-locked
    let safetyVerdict: PumpFunInfo['safetyVerdict'] = 'unknown';
    if (!complete) safetyVerdict = 'safe-bonding-curve';
    else safetyVerdict = 'graduated-needs-audit';

    const info: PumpFunInfo = {
      hasData: true,
      mint: d.mint,
      name: d.name,
      symbol: d.symbol,
      complete,
      isOnBondingCurve: !complete,
      virtualSolReserves: virtualSol,
      virtualTokenReserves: virtualTok,
      realSolReserves: realSol,
      realTokenReserves: realTok,
      totalSupply: totalSup,
      bondingCurveProgress: progress,
      creator: d.creator || '',
      createdAtMs: parseFloat(d.created_timestamp || 0),
      athMcap: parseFloat(d.ath_market_cap || 0),
      athAtMs: parseFloat(d.ath_market_cap_timestamp || 0),
      currentMcap: parseFloat(d.usd_market_cap || 0),
      twitter: d.twitter,
      telegram: d.telegram,
      website: d.website,
      description: d.description,
      safetyVerdict,
    };

    _cache.set(ca, { data: info, ts: Date.now() });
    return info;
  } catch (e: any) {
    INFLIGHT.delete(ca);
    logWarn(`pumpfun-info ${ca.slice(0, 8)}: ${e.message}`);
    _failed.set(ca, Date.now() + FAILURE_COOLDOWN_MS);
    return emptyInfo();
  }
}

/**
 * Sync getter for the cache. `undefined` when the mint was never fetched or the entry is older than API_SNAPSHOT_MAX_AGE_MS (A-93f:
 * a snapshot never shadows the chain read of a later trade).
 */
export function getCachedPumpFunInfo(ca: string): PumpFunInfo | undefined {
  const c = _cache.get(ca);
  if (!c) return undefined;
  if (Date.now() - c.ts > TTL) return undefined;
  return c.data;
}
