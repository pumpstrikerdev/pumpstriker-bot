/**
 * unclaimedsol.ts — UnclaimedSol partner integration, v4 (2026-07-21).
 *
 * Rent recovery for old token accounts, done the affiliate-link way:
 *   • The bot scans the default wallet ON-CHAIN, read-only
 *     (getParsedTokenAccountsByOwner on the classic Token and Token-2022
 *     programs) and shows the real rent lamports — the same arithmetic the
 *     unclaimedsol.com dashboard shows. UnclaimedSol's own Scan API just returns
 *     tokenCount × 0.002 and never matches, so it is only pinged for partner
 *     attribution and its response is ignored.
 *   • The claim itself happens on UnclaimedSol's hosted partner flow
 *     (UCS_CLAIM_URL). Only claims made through the partner link credit the
 *     partner's 20% revenue share, which is why the in-Telegram SDK signing flow
 *     was retired. THE BOT SIGNS NOTHING FOR THIS FEATURE.
 *   • 'pump-striker' is the PUBLIC partner key (attribution only). Forks: set
 *     UCS_PARTNER_KEY to your own key. The partner-dashboard PIN is a credential
 *     and must NEVER appear in this repo.
 *
 * REBUILD-CHOSEN: the original module is lost. The exports are fixed by the
 * bot.ts call sites; internals (claim URL form, fee model, dust definition,
 * frozen/wSOL exclusion, RPC lane order, ping dedupe) follow WI-A §3.B.1.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../config';
import { fetch } from '../lib/http-client';
import { logWarn } from '../logger';

/** Public attribution key (not a secret). */
export const UCS_PARTNER_KEY: string = (process.env.UCS_PARTNER_KEY || 'pump-striker').trim();
export const UCS_SITE = 'https://unclaimedsol.com';
export const UCS_CLAIM_URL: string = `${UCS_SITE}/partner-widget/continue?partner=${encodeURIComponent(UCS_PARTNER_KEY)}&mode=top`;
export const UCS_SCAN_API = 'https://unclaimedsol.com/api/check-claimable-sol';
/** The user keeps at most 0.002 SOL per closed account. */
export const UCS_KEEP_CAP_LAMPORTS = 2_000_000;
/** REBUILD-CHOSEN: the published "greater of 2% …" fee rule (Sep 2026). Set 0 for the July/SDK rule. */
export const UCS_MIN_FEE_BPS = 200;

const TOKEN_PROGRAM_ID      = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const WSOL_MINT             = 'So11111111111111111111111111111111111111112';

export interface ClaimablePair {
  mint: PublicKey; ata: PublicKey; programId: PublicKey;   // {mint, ata} = the SDK's "pairs" shape (v3 heritage)
  lamports: number;          // the account's real rent lamports
  amountRaw: string; decimals: number; uiAmount: number;
  dust: boolean;             // true = non-zero token balance (burned before close on the site)
}

export interface ClaimSummary { count: number; dustCount: number; totalLamports: number; feeLamports: number; keepLamports: number }

/** UnclaimedSol's fee for closing ONE account holding `lamports` of rent:
 *  the greater of `minFeeBps` of the lamports and everything above the keep cap,
 *  never more than the lamports themselves. */
export function ucsFeeForAccount(
  lamports: number,
  minFeeBps: number = UCS_MIN_FEE_BPS,
  keepCapLamports: number = UCS_KEEP_CAP_LAMPORTS,
): number {
  if (!Number.isFinite(lamports) || lamports <= 0) return 0;
  const lam = Math.floor(lamports);
  const bpsFee = Math.floor((lam * Math.max(0, minFeeBps)) / 10_000);
  const excess = Math.max(0, lam - keepCapLamports);
  return Math.min(lam, Math.max(bpsFee, excess));
}

/** Totals for the claim card. All values are integer lamports. */
export function summarizeClaim(
  pairs: Array<Pick<ClaimablePair, 'lamports' | 'dust'>>,
  opts: { minFeeBps?: number; keepCapLamports?: number } = {},
): ClaimSummary {
  let totalLamports = 0;
  let feeLamports = 0;
  let dustCount = 0;
  for (const p of pairs) {
    const lam = Number.isFinite(p.lamports) && p.lamports > 0 ? Math.floor(p.lamports) : 0;
    totalLamports += lam;
    feeLamports += ucsFeeForAccount(lam, opts.minFeeBps ?? UCS_MIN_FEE_BPS, opts.keepCapLamports ?? UCS_KEEP_CAP_LAMPORTS);
    if (p.dust) dustCount++;
  }
  return { count: pairs.length, dustCount, totalLamports, feeLamports, keepLamports: totalLamports - feeLamports };
}

/**
 * Read-only on-chain scan of every closable token account owned by `owner`.
 * Empty accounts always; non-empty ("dust") ones only when includeDust.
 * Skips wSOL (closing it is unwrapping — the bot's own unwrapAllWsol does that)
 * and frozen accounts (cannot be closed). Result: empty first, then dust, each
 * sorted by lamports descending.
 */
export async function scanClaimableAccounts(
  conn: Pick<Connection, 'getParsedTokenAccountsByOwner'>,
  owner: PublicKey,
  includeDust: boolean = false,
): Promise<ClaimablePair[]> {
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  const results = await Promise.allSettled(
    programs.map(programId => conn.getParsedTokenAccountsByOwner(owner, { programId }, 'confirmed')),
  );
  // Never put the RPC URL or the raw error text in this message: bot.ts shows
  // e.message in Telegram and web3.js errors can embed a keyed RPC URL.
  if (results.every(r => r.status === 'rejected')) {
    throw new Error('token-account scan failed on both token programs');
  }

  const empty: ClaimablePair[] = [];
  const dust: ClaimablePair[] = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const programId = programs[i];
    for (const { pubkey, account } of r.value?.value || []) {
      const info: any = (account?.data as any)?.parsed?.info;
      if (!info) continue;
      if (info.isNative === true || info.mint === WSOL_MINT) continue;
      if (info.state === 'frozen') continue;
      const lamports = Number(account.lamports);
      if (!Number.isFinite(lamports) || lamports <= 0) continue;
      let amount: bigint;
      try { amount = BigInt(info.tokenAmount?.amount ?? '0'); } catch { continue; }
      const isEmpty = amount === 0n;
      if (!isEmpty && !includeDust) continue;
      let mint: PublicKey;
      try { mint = new PublicKey(info.mint); } catch { continue; }
      const pair: ClaimablePair = {
        mint,
        ata: pubkey,
        programId,
        lamports,
        amountRaw: amount.toString(),
        decimals: Number(info.tokenAmount?.decimals) || 0,
        uiAmount: Number(info.tokenAmount?.uiAmount) || 0,
        dust: !isEmpty,
      };
      (isEmpty ? empty : dust).push(pair);
    }
  });
  empty.sort((a, b) => b.lamports - a.lamports);
  dust.sort((a, b) => b.lamports - a.lamports);
  return [...empty, ...dust];
}

let _conn: Connection | null = null;
/** Read-only connection for the scan. Keeps off the trading lane (HELIUS_RPC_BOT)
 *  when another lane exists, and never uses Alchemy (disabled since 2026-09-25). */
export function ucsConnection(): Connection {
  if (!_conn) {
    const url = CONFIG.HELIUS_RPC_WALLET || CONFIG.HELIUS_RPC || CONFIG.HELIUS_RPC_BOT || 'https://api.mainnet-beta.solana.com';
    _conn = new Connection(url, 'confirmed');
  }
  return _conn;
}

const PING_DEDUPE_MS = 10 * 60_000;
const PING_MAP_CAP = 1_000;
const _lastPing = new Map<string, number>();

/** Fire-and-forget partner attribution ping. Never throws; the response is
 *  ignored (it does not match on-chain truth). Same wallet at most every 10 min. */
export function notifyPartnerScan(wallet: string): void {
  try {
    if (!wallet) return;
    const now = Date.now();
    const last = _lastPing.get(wallet);
    if (last !== undefined && now - last < PING_DEDUPE_MS) return;
    if (_lastPing.size >= PING_MAP_CAP) {
      const oldest = _lastPing.keys().next().value;
      if (oldest !== undefined) _lastPing.delete(oldest);
    }
    _lastPing.delete(wallet);
    _lastPing.set(wallet, now);
    fetch(UCS_SCAN_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Partner-Key': UCS_PARTNER_KEY },
      body: JSON.stringify({ publicKey: wallet }),
      timeout: 8000,
    })
      .then((r: any) => {
        if (r && r.ok === false) logWarn(`[ucs] partner scan ping failed: HTTP ${r.status}`);
        if (r && typeof r.text === 'function') r.text().catch(() => {});   // drain; body ignored
      })
      .catch((e: any) => {
        logWarn(`[ucs] partner scan ping failed: ${e?.code || e?.name || 'network error'}`);
      });
  } catch {
    /* never throw from a fire-and-forget */
  }
}
