/**
 * SIMULATED OWNER CHECKS — what the simulation of a transaction the bot did not build must show about the owner's own accounts before
 * the owner signs it (pure; FIX-BUY2 item 7(e)). One helper for the three verifiers that simulate a third party's transaction:
 *
 *   - tx-verify.ts step (d), PumpPortal curve transactions: `swapFlowRefusal` over the owner's lamports and the traded token account;
 *   - ext-verify.ts, the wallet swap profile: `ownerTokenAccountsRefusal` (its checkOwnerAccounts, moved here unchanged);
 *   - jupiter.ts, the /swap/v2/order fallback: both, over every writable account of the order transaction, with `ownerHoldings`.
 *
 * The texts are the ones the verifiers have always returned (their tests pin them). Nothing here reads the chain, signs or sends: the
 * callers read the accounts before the simulation and take them from the simulation's `accounts` answer.
 */
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, parseSplTokenAccount, type ChainAccount, type SplTokenAccount } from './wallet-reads';

/** A token account (classic Token or Token-2022, base layout) whose token owner is `owner`, or null. */
export function ownerTokenAccount(owner: string, a: ChainAccount | null | undefined): SplTokenAccount | null {
  if (a === null || a === undefined) return null;
  if ((a.owner !== TOKEN_PROGRAM_ID && a.owner !== TOKEN_2022_PROGRAM_ID) || a.data.length < 165) return null;
  const t = parseSplTokenAccount(a.data);
  return t !== null && t.owner === owner ? t : null;
}

/**
 * The token accounts of the owner must not change except the `allowed` ones, and no account (those included) may gain a delegate, a close
 * authority or another owner. `allowed` accounts may change their AMOUNT (the caller bounds those separately), may be created (with no
 * delegate and no close authority) and may be closed. null = nothing wrong; otherwise the reason (moved unchanged from ext-verify.ts).
 */
export function ownerTokenAccountsRefusal(
  owner: string, addresses: readonly string[], pre: ReadonlyArray<ChainAccount | null>, post: ReadonlyArray<ChainAccount | null>, allowed: ReadonlySet<string>,
): string | null {
  for (let i = 0; i < addresses.length; i++) {
    const a = pre[i];
    const b = post[i];
    const isToken = (x: ChainAccount | null): boolean => x !== null && (x.owner === TOKEN_PROGRAM_ID || x.owner === TOKEN_2022_PROGRAM_ID) && x.data.length >= 165;
    const ta = isToken(a) ? parseSplTokenAccount(a!.data) : null;
    const tb = isToken(b) ? parseSplTokenAccount(b!.data) : null;
    const ownedBefore = ta !== null && ta.owner === owner;
    const ownedAfter = tb !== null && tb.owner === owner;
    if (!ownedBefore && !ownedAfter) continue;
    if (ownedBefore && !ownedAfter) {
      if (b === null && allowed.has(addresses[i])) continue;      // an account the profile lets this transaction close
      return 'a token account of the owner changed owner or was removed';
    }
    if (tb === null) return 'a token account of the owner could not be read after the simulation';
    if (!ownedBefore) {
      // created by this transaction: only an allowed account, with no delegate and no close authority
      if (!allowed.has(addresses[i])) return 'the transaction creates a token account for the owner that it does not disclose';
      if (tb.delegate !== null || tb.closeAuthority !== null) return 'a created token account carries a delegate or a close authority';
      continue;
    }
    if (ta!.delegate !== tb.delegate || ta!.closeAuthority !== tb.closeAuthority || ta!.state !== tb.state) return 'a token account of the owner changed its delegate, close authority or state';
    if (!allowed.has(addresses[i]) && ta!.amount !== tb.amount) return 'a token account of the owner changed its amount';
  }
  return null;
}

/** The owner's SOL and traded token before and after the simulation. */
export interface SwapFlow {
  lamportsBefore: bigint;
  lamportsAfter: bigint;
  tokensBefore: bigint;
  tokensAfter: bigint;
}

/** What the swap may move: a buy may spend at most `maxLamportsOut` and must deliver tokens; a sell may take at most `tokensIn` and must pay SOL. */
export type SwapFlowBound = { side: 'buy'; maxLamportsOut: bigint } | { side: 'sell'; tokensIn: bigint };

/**
 * The swap moved only what was asked (moved unchanged from tx-verify.ts step (d)):
 *   buy  -> the owner's token balance grows, and the owner's lamport outflow is at most maxLamportsOut;
 *   sell -> the owner receives lamports, and the owner's token balance falls by at most tokensIn (never grows).
 * null = within the bounds; otherwise the reason.
 */
export function swapFlowRefusal(f: SwapFlow, bound: SwapFlowBound): string | null {
  if (bound.side === 'buy') {
    if (f.tokensAfter - f.tokensBefore <= 0n) return 'simulation: no token delta on the owner ATA';
    const outflow = f.lamportsBefore - f.lamportsAfter;
    if (outflow > bound.maxLamportsOut) return `simulation: owner lamport outflow above bound (${outflow} > ${bound.maxLamportsOut})`;
    return null;
  }
  if (f.lamportsAfter - f.lamportsBefore <= 0n) return 'simulation: no lamport inflow to the owner';
  const decrease = f.tokensBefore - f.tokensAfter;
  if (decrease < 0n) return 'simulation: owner ATA balance increased on a sell';
  if (decrease > bound.tokensIn) return `simulation: owner ATA decrease above tokensIn (${decrease} > ${bound.tokensIn})`;
  return null;
}

/** The owner's holdings over a set of accounts, before or after a simulation (FIX-BUY2 item 7: the /swap/v2/order fallback). */
export interface OwnerHoldings {
  /** The owner account's own lamports (0 when it is not among the accounts or does not exist). */
  lamports: bigint;
  /** wSOL in the owner's wrapped-SOL token accounts: SOL the swap may take or pay instead of native lamports. */
  wsol: bigint;
  /** The traded token in the owner's token accounts of `mint`. */
  tokens: bigint;
}

/** Sums the owner's lamports, wSOL and `mint` tokens over `accounts` (the owner's account and the owner's token accounts among them). */
export function ownerHoldings(owner: string, mint: string, addresses: readonly string[], accounts: ReadonlyArray<ChainAccount | null>): OwnerHoldings {
  let lamports = 0n;
  let wsol = 0n;
  let tokens = 0n;
  for (let i = 0; i < addresses.length; i++) {
    const a = accounts[i] ?? null;
    if (addresses[i] === owner && a !== null) lamports += a.lamports;
    const t = ownerTokenAccount(owner, a);
    if (t === null) continue;
    if (t.mint === WSOL_MINT) wsol += t.amount;
    else if (t.mint === mint) tokens += t.amount;
  }
  return { lamports, wsol, tokens };
}
