// FROZEN CONTRACT (R0-CONTRACTS, round 0a; C01 section 2). Changes only by a numbered plan amendment.
// Amended by A-84 (R6-PP3, round 6a): four pumpportal.* SourceIds, PumpPortalSourceId (type), seven NullReasons, PromiseId P-track-push.
// Amended by A-98 (R7-W3, round 7a): four wallet SourceIds (28 in all), Unit exact_amount and usd_text, nine NullReasons (38 in all). No new exported const.
// Amended by A-109 (R8-RD0, round 8a): SourceId bot.heartbeat (29 in all), three NullReasons not-reported, quoted-only-leg, price-basis-mismatch (41 in all). No new exported const.
// Canonical source: R\shared\common\ids.ts. The copies under Engine\src\shared\ and TG Bot\src\shared\ are byte-identical
// and written only by R\scripts\sync-shared.ps1. Pure types and constants: no imports, no Node APIs (the dashboard imports this file).

export type Ms = number;                       // epoch milliseconds, UTC, finite integer
export type Grade = 'A' | 'B' | 'C';
export type ArmId = 'BS' | 'B0' | 'B1' | 'B2';
export type Level = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'LATCHED';
export type TrackTier = 'HOT' | 'WARM' | 'COOL' | 'DORMANT' | 'STOPPED';

export type SourceId =
  | 'gmgn.token_info' | 'gmgn.security' | 'gmgn.pool_info' | 'gmgn.top_holders'
  | 'gmgn.kline_1m' | 'gmgn.kline_5m'
  | 'gmgn.trenches.new_creation' | 'gmgn.trenches.near_completion' | 'gmgn.trenches.completed'
  | 'gmgn.signal' | 'gmgn.smartmoney' | 'gmgn.kol'
  | 'pumpportal.new_token' | 'pumpportal.migration' | 'pumpportal.account_trade' | 'pumpportal.token_trade'
  | 'engine.derived' | 'engine.decision' | 'engine.query'
  | 'bot.delivery' | 'bot.exit_leg' | 'bot.position' | 'bot.wallet' | 'chain.tx'
  // A-98 (round 7, WALLET-DASHBOARD-DESIGN section 12.1): the connected wallet's own reads, simulations, route quotes and the UnclaimedSol analysis.
  | 'chain.wallet'               // a bot RPC read of a connected wallet's balances (distinct from bot.wallet, the server wallet)
  | 'bot.simulation'             // expected balance changes from the bot's pre-hand-off simulation
  | 'bot.route_quote'            // route quote values (quoted out, min out, impact, fees)
  | 'unclaimedsol.check_wallet'  // values from a validated UnclaimedSol check-wallet page
  // A-109 (round 8, DASHBOARD-REDESIGN section 9.1): values read from the bot's last heartbeat (the bot username and the RPC label). The bot wallet balance keeps 'bot.wallet'.
  | 'bot.heartbeat';
export type GmgnSourceId = Extract<SourceId, `gmgn.${string}`>;
/** A-84 (round 6): the second token-data source. Type only: there is no exported list, so GMGN_SOURCE_IDS (12) and SH1-T12 stay as they are. */
export type PumpPortalSourceId = Extract<SourceId, `pumpportal.${string}`>;
export const GMGN_SOURCE_IDS: readonly GmgnSourceId[] = [
  'gmgn.token_info','gmgn.security','gmgn.pool_info','gmgn.top_holders','gmgn.kline_1m','gmgn.kline_5m',
  'gmgn.trenches.new_creation','gmgn.trenches.near_completion','gmgn.trenches.completed','gmgn.signal','gmgn.smartmoney','gmgn.kol',
];

/** Why a value is null (or why a non-live state applies). One vocabulary for Engine, wire and UI. */
export type NullReason =
  | 'not-fetched' | 'fetch-failed' | 'timeout' | 'gmgn-ban' | 'gmgn-budget-skip'
  | 'source-field-absent' | 'empty-string' | 'unparseable' | 'stale' | 'not-applicable'
  | 'not-tracked-live' | 'not-tracked-at-level' | 'not-matured' | 'not-sampled'
  | 'read-failed' | 'read-overdue' | 'frozen-price' | 'pool-drained' | 'unpriceable'
  | 'stale-entry' | 'query-failed' | 'dormant'
  // A-84 (round 6, PUMPPORTAL-DESIGN section 4.2): source-neutral reasons of push (stream) values.
  | 'stream-gap' | 'stream-keyless' | 'metered-cap' | 'metered-unfunded' | 'metered-key-refused' | 'stream-banned' | 'launch-not-observed'
  // A-98 (round 7, WALLET-DASHBOARD-DESIGN section 12.1): wallet and UnclaimedSol reasons.
  | 'not-configured'             // the provider key or the feature is not configured
  | 'provider-null'              // the provider returned null (unavailable), never zero
  | 'quota-exhausted'            // UnclaimedSol refused for quota, or the optional local daily stage cap is reached
  | 'bot-unavailable'            // the bot link is down or the bot refused (rpc-budget, timeout)
  | 'quote-expired'              // the quote is older than the TX_QUOTE aging limit
  | 'external-activity'          // the chain balance differs from the booked trades, so PnL is not computable
  | 'fill-pending'               // a trade of this (owner, mint) is submitted and has no booked deltas yet
  | 'fill-unverified'            // a trade of this (owner, mint) is unverified (or an "outcome unknown" quote is not yet found)
  | 'balance-older-than-fill'    // the last balance read's slot is older than the last booked fill's slot
  // A-109 (round 8, DASHBOARD-REDESIGN section 9.1): honest nulls of the redesigned pages.
  | 'not-reported'               // the bot did not send this field (an old bot, or a heartbeat without it)
  | 'quoted-only-leg'            // realized PnL is hidden because a sell leg has only a quoted amount, no verified one
  | 'price-basis-mismatch';      // Peak MC: the price basis is not the entry, or the quote and the candle disagree beyond the tolerance

export type Freshness = 'live' | 'aging' | 'stale' | 'frozen' | 'final' | 'pending' | 'missing' | 'error';
/** Worst first. A derived value takes the worst state of its inputs. */
export const FRESHNESS_WORST_ORDER: readonly Freshness[] = ['error','missing','stale','frozen','aging','pending','live','final'];

export type Unit = 'usd' | 'sol' | 'x' | 'pct' | 'frac01' | 'count' | 'ms' | 'bool' | 'enum' | 'text' | 'addr'
  // A-98 (round 7): exact_amount carries v: ExactAmount (contract.ts) = {baseUnits: signed canonical integer string, decimals 0-18, asset: 'SOL' | mint};
  // usd_text carries v: string (1-40 printable ASCII), a provider's USD text shown verbatim and never parsed to a number.
  | 'exact_amount' | 'usd_text';

export type PromiseId =
  | 'P-decision-price' | 'P-decision-latency' | 'P-feed' | 'P-track-hot' | 'P-track-warm'
  | 'P-track-cool' | 'P-outcome-r0' | 'P-trench-risk'
  | 'P-track-push';   // A-84 (round 6): move-to-read latency of push-covered tracked tokens (PUMPPORTAL-DESIGN section 4.3)
