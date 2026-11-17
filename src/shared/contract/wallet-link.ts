// FROZEN CONTRACT (R7-W3, round 7a, amendment A-99; C02 section 9, WALLET-DASHBOARD-DESIGN section 6.8 and "Rev 3" R3-2 item 8). Changes only by a numbered plan amendment.
// Canonical source: R\shared\contract\wallet-link.ts; byte-identical copies live in Engine\src\shared\contract\ and TG Bot\src\shared\contract\ and are written only by
// R\scripts\sync-shared.ps1. The dashboard never imports this file (A-16).
//
// The six SYNCHRONOUS request/response routes the bot adds behind the same linkAuth as /v1/events:
//   POST /v1/wallet/quote, /fill, /find, /balances, /close-quote, /close-fill
// (unlike /v1/events, which answers 202 first). The Engine calls them through its bot relay; the bot builds UNSIGNED transactions for an external payer (the
// connected wallet is the only signer and fee payer) and reads the chain; it never signs and never sends. v1.ts, validate.ts and the event types are unchanged.
//
// Conventions: every amount is a canonical integer STRING (UintString / IntString, base units, never a float) or an ExactAmount; a value the bot could not read is
// a refusal, never 0. The bot answers either {ok:true, ...} or a refusal {ok:false, code, reason}. The strict validators of both directions are in wallet-validate.ts.
import type { Ms } from '../common/ids';
import type { ExactAmount, WalletFeeLevel, WalletRoute, WalletSide, WalletTradeStatus } from '../dashboard/contract';
import type { Base58 } from './v1';

/** A canonical UNSIGNED integer string, ^(0|[1-9][0-9]*)$, at most 18446744073709551615 (u64). */
export type UintString = string;
/** A canonical SIGNED integer string, ^-?(0|[1-9][0-9]*)$ ("-0" is not canonical), magnitude at most 18446744073709551615. */
export type IntString = string;

/** The six route paths, relative to the bot's events server. */
export const WALLET_LINK_PATHS = {
  quote: '/v1/wallet/quote', fill: '/v1/wallet/fill', find: '/v1/wallet/find',
  balances: '/v1/wallet/balances', closeQuote: '/v1/wallet/close-quote', closeFill: '/v1/wallet/close-fill',
} as const;
export type WalletLinkRoute = keyof typeof WALLET_LINK_PATHS;
/** Design section 6.8: the Engine's relay timeout and the bot's own internal budget per route, in ms (the bot answers inside its budget). */
export const WALLET_LINK_BUDGET_MS: Readonly<Record<WalletLinkRoute, { relay: number; bot: number }>> = {
  quote: { relay: 15_000, bot: 12_000 }, fill: { relay: 75_000, bot: 60_000 }, find: { relay: 15_000, bot: 12_000 },
  balances: { relay: 10_000, bot: 8_000 }, closeQuote: { relay: 12_000, bot: 10_000 }, closeFill: { relay: 75_000, bot: 60_000 },
};

/** Refusal codes of a link answer {ok:false}. Closed on purpose: an unforeseen case is 'build-failed' (quote routes) or 'verify-failed' (the verifier), with
 *  its reason text; a new code is an amendment. 'insufficient-sol' also carries needLamports and haveLamports. */
export const WALLET_REFUSAL_CODES = [
  'bad-request', 'nothing-to-sell', 'nothing-to-close', 'insufficient-sol', 'amount-above-cap', 'impact-above-limit', 'price-moved', 'simulation-failed',
  'wsol-balance-present', 'alt-mismatch', 'owner-key-in-lookup', 'tx-too-large', 'build-timeout', 'rpc-budget', 'verify-failed', 'no-route', 'build-failed',
] as const;
export type WalletRefusalCode = (typeof WALLET_REFUSAL_CODES)[number];
/** The bot's refusal. `reason` is redacted and at most 200 characters. needLamports / haveLamports only with code 'insufficient-sol' (the exact strings the dialog shows). */
export interface WalletLinkRefusal { ok: false; code: WalletRefusalCode; reason: string; needLamports?: UintString; haveLamports?: UintString }

// ---------------------------------------------------------------------------------------------------------------------------------
// POST /v1/wallet/quote
// ---------------------------------------------------------------------------------------------------------------------------------

/** buy: amountLamports only. sell: exactly one of tokensRaw and pctBps (1-10000 of the balance the bot reads in the build). `owner` is the payer and the only signer.
 *  maxSpendLamports: the cap on the maximum spend (amount in, or max in on an exact-out route); null = no cap (WALLET_TRADE_MAX_SOL unset). No allowPumpPortal. */
export interface WalletQuoteRequest {
  owner: Base58; side: WalletSide; mint: Base58;
  amountLamports?: UintString; tokensRaw?: UintString; pctBps?: number;
  slippageBps: number;             // integer 1-5000
  maxImpactPct: number;            // percent, 0 < x <= 50, at most 2 decimals
  maxSpendLamports: UintString | null;
  feeLevel: WalletFeeLevel;
  maxTxBytes: number;              // integer 1-1132
}
/** The bound the program enforces, decoded from the unsigned bytes: exact_out only for a PumpSwap buy, exact_in on every other route and side. */
export type WalletLinkBound =
  | { kind: 'exact_in'; amountIn: ExactAmount; minOut: ExactAmount }
  | { kind: 'exact_out'; exactOut: ExactAmount; maxIn: ExactAmount };
export interface WalletLinkInnerFee { label: string; recipient: Base58; amount: ExactAmount }
export interface WalletLinkTransfer { recipient: Base58; lamports: UintString }
export interface WalletLinkPriorityFee { cuLimit: number; cuPriceMicrolamports: number; lamports: UintString }   // limit 1-400000, price 1-1000000
/** The built, verified and simulated unsigned transaction with everything the confirmation step discloses. All values are plain: the Engine wraps them in Measured
 *  (src bot.route_quote / bot.simulation / chain.wallet) with the times below. */
export interface WalletQuoteLink {
  route: WalletRoute; side: WalletSide; mint: Base58;
  bound: WalletLinkBound;
  maxOutflowLamports: UintString;                     // amount or max in + network fee + priority fee + rent bound (sell: fees + rent bound)
  quotedOut: ExactAmount | null; quotedIn: ExactAmount | null;   // quotedOut on exact_in, quotedIn on exact_out, the other null
  impactPct: number | null;                           // the route's own quote impact in percent; null = the route gave none
  slippageBps: number;                                // the slippage encoded in the bytes: equals the request's
  simulatedDeltas: { sol: ExactAmount; token: ExactAmount };   // signed changes of the owner's SOL and trade token in the simulation
  networkFeeLamports: UintString;
  priorityFee: WalletLinkPriorityFee;
  innerFees: WalletLinkInnerFee[];                    // fees charged inside the swap program, from the simulated fee accounts
  thirdPartyTransfers: WalletLinkTransfer[];          // top-level transfers to third parties (none in round 7)
  rentLamports: UintString;                           // the rent bound of the token accounts the transaction creates
  programs: Base58[];
  txBytes: number; txBase64: string;                  // the serialized unsigned transaction; txBytes is its exact decoded length
  minContextSlot: number;
  quotedAt: Ms; simulatedAt: Ms; builtAt: Ms;
  balance: { lamports: UintString; readAt: Ms; slot: number };   // the owner's SOL balance read in this build (commitment confirmed)
  routingNotes: string[];                             // kebab-case codes: 'pumpswap-direct-disabled', 'pumpportal-not-offered', 'mayhem-mode-unsupported', ...
}
export interface WalletQuoteOk { ok: true; quote: WalletQuoteLink }

// ---------------------------------------------------------------------------------------------------------------------------------
// POST /v1/wallet/fill   (and /close-fill)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Read the transaction by signature and verify it. quoteRef is the Engine's quoteId (correlation only: the bot keeps no quotes). final: the Engine sets it on a
 *  recheck at least 180 s after submittedAt; with no transaction and no status the fill is then 'not-landed'. */
export interface WalletFillRequest { owner: Base58; signature: string; side: WalletSide; mint: Base58; quoteRef: string; submittedAt: Ms; final: boolean }
/** The booked values come ONLY from the transaction meta. status is never 'submitted' (that is the Engine's state before the first answer).
 *  confirmed: all values present. failed: feeLamports present (the fee paid is booked). not-landed and rejected-not-owner: no values. unverified: a reason. */
export interface WalletFillLink {
  status: Exclude<WalletTradeStatus, 'submitted'>; reason: string | null;   // 'price-moved' for a pinned slippage error code
  solDeltaLamports: IntString | null; feeLamports: UintString | null; rentPaidLamports: UintString | null;
  tokenDeltaRaw: IntString | null; decimals: number | null; slot: number | null; blockTime: Ms | null;
}
export interface WalletFillOk { ok: true; fill: WalletFillLink }

// ---------------------------------------------------------------------------------------------------------------------------------
// POST /v1/wallet/find   (after an "outcome unknown" wallet error)
// ---------------------------------------------------------------------------------------------------------------------------------

export interface WalletFindRequest { owner: Base58; mint: Base58; side: WalletSide; sinceSlot: number }
/** At most 3 candidate signatures of the owner that match the mint and side; [] = no match yet. */
export interface WalletFindOk { ok: true; signatures: string[] }

// ---------------------------------------------------------------------------------------------------------------------------------
// POST /v1/wallet/balances
// ---------------------------------------------------------------------------------------------------------------------------------

export interface WalletBalancesRequest { owner: Base58 }
export interface WalletTokenBalance {
  account: Base58; mint: Base58; program: 'token' | 'token-2022';
  amountRaw: UintString; decimals: number; rentLamports: UintString; frozen: boolean | null;
}
/** Exact strings as the RPC returned them at commitment confirmed. A read that failed is a refusal, never an empty list or 0. */
export interface WalletBalancesLink { solLamports: UintString; tokens: WalletTokenBalance[]; readAt: Ms; slot: number }
export interface WalletBalancesOk { ok: true; balances: WalletBalancesLink }

// ---------------------------------------------------------------------------------------------------------------------------------
// POST /v1/wallet/close-quote   and   /close-fill
// ---------------------------------------------------------------------------------------------------------------------------------

/** kind 'empty': close empty token accounts (at most 10 in `accounts`, or the bot picks up to one batch when `accounts` is absent). kind 'unwrap': close the owner's
 *  wSOL account. `excluded`: accounts the Engine removes (UnclaimedSol marks them protected); the bot never closes them. */
export interface WalletCloseQuoteRequest { owner: Base58; kind: 'empty' | 'unwrap'; accounts?: Base58[]; excluded: Base58[] }
export interface WalletCloseAccount { account: Base58; mint: Base58; program: 'token' | 'token-2022'; rentLamports: UintString }
export interface WalletCloseExcluded { account: Base58; reason: string }      // reason: kebab-case code, e.g. 'has-balance', 'frozen', 'withheld-fees', 'close-authority', 'recent-buy'
export interface WalletCloseQuoteLink {
  kind: 'empty' | 'unwrap';
  accounts: WalletCloseAccount[]; excluded: WalletCloseExcluded[]; remainingAccounts: number;
  returnedLamports: UintString;                       // the rent (empty) or the wSOL amount (unwrap) that returns to the owner
  wsolAmount: UintString | null;                      // unwrap only
  networkFeeLamports: UintString; priorityFee: WalletLinkPriorityFee; maxOutflowLamports: UintString;
  simulatedDeltas: { sol: ExactAmount };
  programs: Base58[]; txBytes: number; txBase64: string; minContextSlot: number;
  simulatedAt: Ms; builtAt: Ms;
}
export interface WalletCloseQuoteOk { ok: true; quote: WalletCloseQuoteLink }
export interface WalletCloseFillRequest { owner: Base58; signature: string; submittedAt: Ms; final: boolean }
export interface WalletCloseFillLink {
  status: Exclude<WalletTradeStatus, 'submitted'>; reason: string | null;
  solDeltaLamports: IntString | null; feeLamports: UintString | null; rentReturnedLamports: UintString | null; slot: number | null; blockTime: Ms | null;
}
export interface WalletCloseFillOk { ok: true; fill: WalletCloseFillLink }
