/**
 * CURVE STATE — read the pump bonding curve (or the PumpSwap pool reserves) straight from the chain (B40 rule 5).
 *
 * One `getAccountInfo` on the bonding-curve PDA ["bonding-curve", mint] gives the exact reserves: no third party, no
 * pump.fun API on the hot path. Graduated tokens are read from the PumpSwap pool (the pool account, then its two vault
 * token accounts in one getMultipleAccounts). Used by onchain-quote.ts (B30 valuation source 1) and, where it applies,
 * by the routers to avoid the pump.fun API on the buy path.
 *
 * Bonding-curve account layout (Anchor, little endian):
 *    0  discriminator  = sha256("account:BondingCurve")[0..8]  (checked)
 *    8  virtual_token_reserves u64     16 virtual_sol_reserves u64     24 real_token_reserves u64
 *   32  real_sol_reserves u64          40 token_total_supply u64       48 complete bool
 *   49  creator pubkey (32)            81 is_mayhem_mode bool          82 is_cashback_coin bool
 *   83  quote_mint pubkey (32)         (FIX-BUY2: decoded by curve-parse.ts; a curve not quoted in WSOL holds its reserves in that mint)
 * (offset 82 is the same cashback byte pumpfun-swap.ts has been reading in production.)
 *
 * PumpSwap pool account: the byte offsets of base_mint, quote_mint and the two vault accounts differ between the legacy
 * layout pumpswap-swap.ts read before A-93g and the plain Anchor layout; both are tried and a layout is accepted only when
 * it yields the requested base mint and the WSOL quote mint, so a wrong offset can never produce a quote (it returns null).
 * A-93g (2026-10-26) open item: pumpswap-swap.ts now follows the IDL (canonical pool PDA with the pool_authority seed,
 * u8 bump = the plain Anchor offsets); derivePumpSwapPool below still has no creator seed (valuation only, separate item).
 */
import { PublicKey } from '@solana/web3.js';
import {
  anchorAccountDiscriminator, deriveBondingCurvePda, GRADUATION_REAL_SOL_LAMPORTS, parseBondingCurve, type BondingCurveState,
} from './curve-parse';
import {
  PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID, WSOL_MINT, accountBytes, defaultExecRpc, tokenAccountAmount, withTimeout,
  type ExecRpc,
} from './exec-common';

// R7-W5 (A-104): the bonding-curve decoder moved, unchanged, into the pure curve-parse.ts (the unsigned wallet code reads the curve without
// importing this file or exec-common.ts); every moved name is re-exported here under the same name.
export { anchorAccountDiscriminator, deriveBondingCurvePda, GRADUATION_REAL_SOL_LAMPORTS, parseBondingCurve };
export type { BondingCurveState };

/** PumpSwap pool PDA ["pool", index u16 = 0, base_mint, quote_mint] (index is always 0 for graduated pump.fun pools). */
export function derivePumpSwapPool(baseMint: string): string {
  const index = Buffer.alloc(2);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), index, new PublicKey(baseMint).toBuffer(), new PublicKey(WSOL_MINT).toBuffer()],
    new PublicKey(PUMPSWAP_PROGRAM_ID),
  )[0].toBase58();
}

export interface PumpSwapPoolRefs {
  baseMint: string;
  quoteMint: string;
  poolBaseAccount: string;
  poolQuoteAccount: string;
}

/** Offsets tried in order; the first whose mints match the request wins. */
const POOL_LAYOUTS: ReadonlyArray<{ base: number; quote: number; vaultBase: number; vaultQuote: number; minLen: number }> = [
  // the legacy layout pumpswap-swap.ts fetchPoolState read before A-93g
  { base: 76, quote: 108, vaultBase: 172, vaultQuote: 204, minLen: 236 },
  // plain Anchor layout: 8 disc, 1 bump, 2 index, 32 creator, then base_mint, quote_mint, lp_mint, base vault, quote vault
  { base: 43, quote: 75, vaultBase: 139, vaultQuote: 171, minLen: 203 },
];

function keyAt(buf: Buffer, off: number): string {
  return new PublicKey(buf.subarray(off, off + 32)).toBase58();
}

/** Pure: pool references for `baseMint` (quote must be WSOL); null when no known layout matches. */
export function parsePumpSwapPool(data: Uint8Array | null | undefined, baseMint: string): PumpSwapPoolRefs | null {
  if (!data) return null;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  for (const l of POOL_LAYOUTS) {
    if (buf.length < l.minLen) continue;
    const refs: PumpSwapPoolRefs = {
      baseMint: keyAt(buf, l.base),
      quoteMint: keyAt(buf, l.quote),
      poolBaseAccount: keyAt(buf, l.vaultBase),
      poolQuoteAccount: keyAt(buf, l.vaultQuote),
    };
    if (refs.baseMint === baseMint && refs.quoteMint === WSOL_MINT) return refs;
  }
  return null;
}

export interface PumpSwapReserves {
  pool: string;
  baseReserves: bigint;
  quoteReserves: bigint;
}

export interface CurveReader {
  /** One getAccountInfo on the bonding-curve PDA. null: no such account, wrong owner, unreadable. Throws on RPC errors. */
  readBondingCurve(mint: string): Promise<BondingCurveState | null>;
  /** Pool account + both vault balances. null when the pool does not exist or has an empty side. Throws on RPC errors. */
  readPumpSwapReserves(mint: string): Promise<PumpSwapReserves | null>;
}

export function createCurveReader(deps: { rpc?: ExecRpc } = {}): CurveReader {
  const rpc = deps.rpc ?? defaultExecRpc();
  return {
    async readBondingCurve(mint: string): Promise<BondingCurveState | null> {
      const pda = deriveBondingCurvePda(mint);
      const res = await rpc.call('getAccountInfo', [pda, { encoding: 'base64', commitment: 'confirmed' }]);
      const value = res?.value;
      if (!value || value.owner !== PUMP_PROGRAM_ID) return null;
      return parseBondingCurve(accountBytes(value));
    },
    async readPumpSwapReserves(mint: string): Promise<PumpSwapReserves | null> {
      const pool = derivePumpSwapPool(mint);
      const acc = await rpc.call('getAccountInfo', [pool, { encoding: 'base64', commitment: 'confirmed' }]);
      const value = acc?.value;
      if (!value || value.owner !== PUMPSWAP_PROGRAM_ID) return null;
      const refs = parsePumpSwapPool(accountBytes(value), mint);
      if (!refs) return null;
      const vaults = await rpc.call('getMultipleAccounts', [
        [refs.poolBaseAccount, refs.poolQuoteAccount],
        { encoding: 'base64', commitment: 'confirmed' },
      ]);
      const list = vaults?.value;
      if (!Array.isArray(list) || list.length < 2) return null;
      const baseReserves = tokenAccountAmount(accountBytes(list[0]));
      const quoteReserves = tokenAccountAmount(accountBytes(list[1]));
      if (baseReserves === null || quoteReserves === null || baseReserves === 0n || quoteReserves === 0n) return null;
      return { pool, baseReserves, quoteReserves };
    },
  };
}

// ── Router-facing view (same shape the pump.fun API reader hands the routers) ───────────────────────

/** The subset of pumpfun-info.ts PumpFunInfo the routers read; every field comes from the account. */
export interface CurveView {
  hasData: true;
  complete: boolean;
  isOnBondingCurve: boolean;
  virtualSolReserves: number;
  virtualTokenReserves: number;
  realSolReserves: number;
  realTokenReserves: number;
  bondingCurveProgress: number;
  creator: string;
}

export function curveStateToView(s: BondingCurveState): CurveView {
  return {
    hasData: true,
    complete: s.complete,
    isOnBondingCurve: !s.complete,
    virtualSolReserves: Number(s.virtualSolReserves),
    virtualTokenReserves: Number(s.virtualTokenReserves),
    realSolReserves: Number(s.realSolReserves),
    realTokenReserves: Number(s.realTokenReserves),
    bondingCurveProgress: s.complete ? 1 : Math.min(1, Number(s.realSolReserves) / GRADUATION_REAL_SOL_LAMPORTS),
    creator: s.creator,
  };
}

/** Hot-path read budget: past this the caller falls back to the pump.fun API instead of waiting on a slow RPC lane. */
export const CURVE_READ_BUDGET_MS = 1_500;

let defaultReader: CurveReader | null = null;

/**
 * On-chain curve view for the routers, or null (never throws): no account, graduated-and-closed data is still returned
 * with `complete: true`, an RPC error or a read slower than CURVE_READ_BUDGET_MS gives null so the caller can fall back.
 */
export async function readCurveView(mint: string, reader?: CurveReader, budgetMs: number = CURVE_READ_BUDGET_MS): Promise<CurveView | null> {
  try {
    const r = reader ?? (defaultReader ??= createCurveReader());
    const state = await withTimeout(r.readBondingCurve(mint), budgetMs);
    return state ? curveStateToView(state) : null;
  } catch {
    return null;
  }
}
