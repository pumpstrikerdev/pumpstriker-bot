// FROZEN CONTRACT (R0-CONTRACTS, round 0a; C02 section 2). Changes only by a numbered plan amendment.
// Amended by A-110 (R8-RD0, round 8a): Heartbeat gains the optional bot_username, bot_wallet and rpc_provider. Nothing else changes.
// Canonical source: R\shared\contract\v1.ts; byte-identical copies are written only by R\scripts\sync-shared.ps1.
// The single wire contract between Engine and TG Bot. Types only apart from CONTRACT_VERSION and TTL_MS.
// The validators live in validate.ts (R0-SHIMPL, round 0b), never in this file.
import type { Ms, Grade, ArmId, Level, GmgnSourceId } from '../common/ids';
export const CONTRACT_VERSION = 1 as const;
export type Base58 = string;                        // /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
export type Ulid = string;                          // /^[0-9A-HJKMNP-TV-Z]{26}$/
export type WireSource = GmgnSourceId | 'engine.derived';

/** null = unknown, never 0/false. Invariant: value === null ⇔ as_of === null ⇔ src === null. */
export interface Sourced<T> { value: T | null; src: WireSource | null; as_of: Ms | null }

export type EngineToBotType = 'signal.new' | 'signal.cancel' | 'alert.exit' | 'arms.status' | 'ops.alert';
export type BotToEngineType = 'delivery.tg' | 'delivery.buy' | 'position.opened' | 'exit.leg' | 'position.closed' | 'bot.heartbeat' | 'bot.contract_violation';

export interface Envelope<T extends string, P> {
  v: 1; type: T; event_id: Ulid;                    // stable across retries (idempotency key)
  signal_id: string | null;                         // Engine decision_id for signal-scoped events
  ca: Base58 | null; emitted_at: Ms; attempt: number; payload: P;
}

export interface LabelV1 { id: string; rule_version: string; value: boolean | null; known: boolean; acting: boolean }
/** Fail-closed: any unknown acting input → eligible=false and 'risk-unknown' in blocked_by. */
export interface ArmEligibilityV1 { eligible: boolean; blocked_by: string[]; unknown_inputs: string[] }

/** A-115: the score terms of the Engine's v2 scorer, by name (the card prints the ones with points > 0). */
export type ScoreTermV1 = 'cluster' | 'quietAged' | 'burstAged' | 'launchpad' | 'ecosystem';
/** A-115: optional card detail, all from the frozen DecisionInput and ScoreV2 at decision time. An older Engine omits it; an older bot
 *  drops it (the validators keep known keys only). An invalid detail is dropped by the validator and never costs the signal. */
export interface SignalDetailV1 {
  vol_24h_usd: Sourced<number>; buys_5m: Sourced<number>; sells_5m: Sourced<number>;
  burst: Sourced<number>; liq_eff_usd: Sourced<number>; token_age_min: Sourced<number>;
  cluster: { wallets: number; kol: number; sol: Sourced<number>; sol_lower_bound: boolean; first_at: Ms | null };
  score: { raw: number; eligible: boolean; cluster_quality: boolean; moonshot_gate: boolean;
           terms: Array<{ term: ScoreTermV1; points: number }>; data_gaps: string[] };
}

export interface SignalNew {                        // exactly one per CA, ever
  decision: { first_reach_at: Ms; decided_at: Ms; recorded_at: Ms; rules_version: string; code_version: string;
              line: 85; confidence: number; tier: string; ban_window: boolean; budget_level: Level };
  entry: { price_usd: number; mcap_usd: number; mcap_basis: 'circ' | 'total'; priced_at: Ms; src: 'gmgn.token_info'; quote_age_s: number };
  token: { name: string | null; symbol: string | null; decimals: number | null; total_supply: number | null;
           launchpad: string | null; launchpad_status: 0 | 1 | 2 | null; launchpad_progress: number | null;
           created_at: Ms | null; creator: Base58 | null };
  venue: { pool_address: Base58 | null; exchange: string | null; quote_mint: Base58 | null; migrated: boolean | null; as_of: Ms | null };
  market: { liq_usd: Sourced<number>; pool_liq_usd: Sourced<number>; vol_5m_usd: Sourced<number>; vol_1h_usd: Sourced<number>;
            chg_5m_pct: Sourced<number>; chg_1h_pct: Sourced<number>; holders: Sourced<number>; age_min: Sourced<number>;
            top10_pct: Sourced<number>; creator_hold_pct: Sourced<number> };
  safety: { status: 'clean' | 'pending'; as_of: Ms | null; checked: string[]; missing: string[] };  // killed ⇒ never sent; pending ⇒ every arm blocked
  labels: LabelV1[]; grade: Grade; arms: Record<ArmId, ArmEligibilityV1>;
  policy: { id: 'EA'; version: string };
  /** A-115 (additive, optional): the measured card detail of this decision. */
  detail?: SignalDetailV1;
}
export interface SignalCancel { reason: 'retro_kill'; kills: string[]; detected_at: Ms; detail: string; action: 'sell_if_held' }
export interface ExitAlert { leg: 'TP1' | 'TP2' | 'TP3' | 'T' | 'S' | 'H'; policy: { id: 'EA'; version: string };
  multiple: number; peak_multiple: number; basis: 'signal_entry'; price_usd: number; priced_at: Ms; quote_age_s: number }
export interface ArmStatus { arm: ArmId; registered_at: Ms; registry_sha: string; verdict: 'INSUFFICIENT' | 'PASS' | 'FAIL' | 'RETIRED' | 'BIASED';
  n_matured: number; days: number; look: 0 | 1 | 2 | 3; lcb_token: number | null; lcb_day: number | null; report_id: string | null; evaluated_at: Ms }
export interface ArmsStatusPayload { arms: ArmStatus[] }
/** Engine health alarm for the owner's phone (plan grind #60). ca and signal_id are null. */
export interface OpsAlert { alarm_id: string; severity: 'warn' | 'red'; text: string; since: Ms; cleared_at: Ms | null }

export type BuyReason =
  | 'off' | 'dry_run' | 'policy_mismatch' | 'contract_violation' | 'stale' | 'already_bought' | 'arm_blocked'
  | 'outside_session' | 'cap_hour' | 'cap_day' | 'cap_sol_day' | 'max_positions' | 'reserve'
  | 'paused_fails' | 'paused_rolling' | 'paused_breaker' | 'duplicate_position' | 'no_wallet' | 'impact_cap' | 'route_failed';
export interface DeliveryTg { status: 'sent' | 'failed' | 'filtered' | 'expired' | 'retrying_429';
  message_id: number | null; error: string | null; at: Ms; latency_ms_from_decision: number | null; late: boolean;
  kind: 'signal' | 'cancel' | 'alert' | 'ops'; leg: string | null }      // kind 'ops' ⇔ envelope signal_id null (ops.alert delivery)
export interface DeliveryBuy { status: 'off' | 'skipped' | 'submitted' | 'confirmed' | 'failed' | 'dry_run';
  reason: BuyReason | null; arm: ArmId | null; tx: string | null; error: string | null; at: Ms;
  stamps: { received_at: Ms; decided_at: Ms | null; signed_at: Ms | null; submitted_at: Ms | null; confirmed_at: Ms | null };
  route: 'pf-direct' | 'pumpswap-direct' | 'jupiter' | null; sol_in_lamports: string | null; quote_tokens_out: string | null }
export interface PositionOpened { position_id: string; wallet_id: string; origin: 'signal' | 'manual'; dry_run: boolean; arm: ArmId | null;
  policy: { id: string; version: string } | null; entry_tx: string | null; opened_at: Ms;
  sol_spent_lamports: string | null; tokens_raw: string | null; fill_source: 'tx_meta' | 'quote_dry_run' | 'unverified'; basis_sol_per_token: number | null }
export interface ExitLegV1 { position_id: string; leg: 'R0' | 'S' | 'TP1' | 'TP2' | 'TP3' | 'T' | 'H' | 'CANCEL' | 'MANUAL';
  status: 'filled' | 'failed' | 'filled_unconfirmed' | 'locked_out'; attempt: number; fraction_of_original: number;
  trigger_multiple: number | null; peak_multiple: number | null; quote_multiple: number | null;
  quote_src: 'onchain' | 'jupiter' | 'engine_gmgn' | null; quote_age_s: number | null;
  trigger_at: Ms; send_at: Ms | null; confirm_at: Ms | null; tx: string | null;
  sol_out_quoted_lamports: string | null; sol_out_real_lamports: string | null; fill_multiple: number | null;
  error: string | null; dry_run: boolean; policy_version: string }
export interface PositionClosed { position_id: string; closed_at: Ms; reason: 'policy' | 'cancel' | 'manual' | 'external_sell';
  realized_sol_net_lamports: string | null; rent_reclaimed_lamports: string | null; close_account_tx: string | null;
  close_account_status: 'closed' | 'skipped' | 'failed' }
export interface Heartbeat { at: Ms; contract_v: 1; policy_versions: Record<string, string>;
  autobuy: { enabled: boolean; mode: 'off' | 'dry_run' | 'live'; arm: ArmId | null /* the live arm in mode live, the dry-run arm in mode dry_run */;
             report_id: string | null; confirmed_at: Ms | null; dry_run: boolean /* env BOT_DRY_RUN */; paused: string | null };
  caps_used: { hour: number; day: number; sol_day: number }; open_positions: number; tg_min_grade: Grade; outbox_backlog: number; rpc_ok: boolean;
  dead_lettered: number; dead_last_code: string | null;    // bot outbox dead-letter counter (plan grind #66)
  // A-110 (R8-RD0, round 8a): three OPTIONAL fields, so an old bot stays valid. An absent key is ABSENT after parseHeartbeat (never filled in); a valid key is kept;
  // a malformed key becomes null and its name is reported in the optional `warnings` of the validation result (the rest of the heartbeat is kept).
  bot_username?: string | null;                            // Telegraf botInfo.username after launch (null before)
  bot_wallet?: { wallet_id: string | null; address: Base58; lamports: string /* canonical non-negative integer string */; read_at: Ms; slot: number | null } | null;   // the bot's own default-wallet balance read (same call, same context slot)
  rpc_provider?: string | null }                           // a label such as 'primary' or 'public'; never a key and never a URL
export interface ContractViolation { code: string; detail: string; offending_event_id: string | null }

export type EngineToBotEvent =
  | Envelope<'signal.new', SignalNew> | Envelope<'signal.cancel', SignalCancel>
  | Envelope<'alert.exit', ExitAlert> | Envelope<'arms.status', ArmsStatusPayload> | Envelope<'ops.alert', OpsAlert>;
export type BotToEngineEvent =
  | Envelope<'delivery.tg', DeliveryTg> | Envelope<'delivery.buy', DeliveryBuy> | Envelope<'position.opened', PositionOpened>
  | Envelope<'exit.leg', ExitLegV1> | Envelope<'position.closed', PositionClosed> | Envelope<'bot.heartbeat', Heartbeat>
  | Envelope<'bot.contract_violation', ContractViolation>;
export interface BotBatch { events: BotToEngineEvent[] }   // 1..50
export interface Ack { ok: true; event_id: string; duplicate: boolean; received_at: Ms }
export interface Nack { ok: false; code: 'invalid' | 'clock' | 'contract_version' | 'auth' | 'too_large'; reason: string }

/** TTLs (ms) after which the sender stops and records 'expired'; null = latest wins. */
export const TTL_MS: Readonly<Record<EngineToBotType, number | null>> = { 'signal.new': 600_000, 'signal.cancel': 172_800_000, 'alert.exit': 120_000, 'arms.status': null, 'ops.alert': 3_600_000 };

/** Bot token proxy (GET /api/bot/v1/token/:ca, C70 §5; plan grind #50). ProxyFieldKey is an explicit subset of the Engine FieldId. */
export type ProxyFieldKey = 'price_usd' | 'mcap_usd' | 'liq_usd' | 'pool_liq_usd' | 'liq_eff_usd' | 'vol_5m_usd' | 'vol_1h_usd' | 'c5m_pct_info' | 'c1h_pct_info'
  | 'holder_count' | 'top10_rate' | 'creator_balance_rate' | 'age_min' | 'symbol' | 'name' | 'launchpad_status' | 'migrated';
export interface TokenProxyResponse { ok: true; ca: string; asOf: Ms; fields: Partial<Record<ProxyFieldKey, Sourced<number | string | boolean>>> }
