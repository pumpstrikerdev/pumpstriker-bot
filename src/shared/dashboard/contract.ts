// FROZEN CONTRACT (R0-CONTRACTS, round 0a; C01 section 4). Changes only by a numbered plan amendment.
// Amended by A-84 (R6-PP3, round 6a): HealthView.pumpPortal (optional) with PumpPortalHealthView, ProvenanceView.kind 'stream_event', the Measured.path comment.
// Amended by A-98 (R7-W3, round 7a): ExactAmount and the wallet views (WalletEnvelope, WalletSessionView, WalletLimitsView, WalletView, TradeQuoteView, WalletTradeView,
// WalletActivityView, WalletPositionsView, CloseQuoteView, UcsView), ProvenanceView.kind 'wallet', the Measured.prov comment. SCHEMA stays 1 (members are additive).
// Amended by A-109 (R8-RD0, round 8a, DASHBOARD-REDESIGN section 9.1): SortKey and TgSignalStatus (types), Envelope.list, OverviewView, ActivityView, CohortView.tz / daily rug and flat /
// peakBuckets / paperDaily / split checkpointsMedian, SignalSummary.peak.mcap and bucket, outcome.minCloseX and peakHighX, wouldKill, TradesView.summary, HealthView.run / counts /
// delivery.bot. EVERY new member was added optional; Envelope.list stays optional.
// Amended by A-118 (R8-RDE6, round 8h, A-112 tighten): the A-109 members peak.mcap / peak.bucket, outcome.minCloseX / peakHighX, wouldKill, CohortView.daily rug / flat, split
// checkpointsMedian, tz, peakBuckets, paperDaily, TradesView.summary, HealthView.delivery.bot / run / counts are now REQUIRED (fill-in only; no behaviour change). No new exported const.
// Canonical source: R\shared\dashboard\contract.ts; byte-identical copies are written only by R\scripts\sync-shared.ps1.
// Every API view, the SSE union and SCHEMA. Types only apart from SCHEMA (the dashboard imports this file).
import type { Ms, Grade, ArmId, Level, TrackTier, SourceId, NullReason, Freshness, Unit, PromiseId } from '../common/ids';
import type { FreshClass } from './freshness';
export const SCHEMA = 1 as const;

/** Every displayed fact, counts and rates included. */
export interface Measured<T> {
  v: T | null;                  // null whenever unknown; NEVER 0, '', false or another field as a stand-in
  unit: Unit;
  cls: FreshClass;              // REQUIRED: the freshness class the server classified with; the client re-classifies with it (reclassify)
  src: SourceId;
  path?: string;                // JSON path in the source payload, e.g. 'price.price' (GMGN) or 'marketCapSol' (a PumpPortal frame)
  prov: string | null;          // provenance ref resolvable at /api/v2/provenance/:prov; null only for engine.query; `w:` refs resolve at /api/wallet/v1/provenance/:ref under the wallet session
  obsAt: Ms | null;             // when the fact was true: srcTs if the source gives one, else the fetch time
  obsBasis: 'source' | 'fetch' | 'candle-close' | 'decision' | 'query';
  fetchedAt: Ms | null;         // the ORIGINAL fetch time (also on cache hits)
  ageMs: number | null;         // serverNow − obsAt, computed by the server for this response
  state: Freshness;
  reason?: NullReason;          // REQUIRED when v === null or state ∈ {stale, frozen, missing, error}; absent for live/aging/final/pending with a value
  deps?: string[];              // derived values: prov refs of ALL inputs (frozen entry included); obsAt = oldest obsAt among the inputs whose cls is not DECISION/IDENTITY (deriveMeasured)
  method?: string;              // 'candle-1m-close' | 'candle-1m-high' | 'tracker' | 'ipw-mean' | 'lower-bound' | 'wilson'
  promise?: { id: PromiseId; targetMaxAgeMs: number | null; level: Level };
}

/** A-109: the sort orders of the list routes (`sort=` on /signals, /outcomes/rows and /export). A type only. */
export type SortKey = 'recent' | 'conf' | 'peak' | 'now' | 'trough' | 'maxDd';
/** A-109: the status of a decision's Telegram SIGNAL card (the delivery machine of store/delivery-machine.ts). A type only. */
export type TgSignalStatus = 'pending' | 'sent' | 'failed' | 'filtered' | 'expired' | 'bot_offline' | 'retrying_429' | 'link_off';

export interface Envelope<T> {
  schema: typeof SCHEMA; serverNow: Ms; codeVersion: string; rulesVersion: string; policyVersion: string;
  cutoverAt: Ms; runId: string; dashboardBuildExpected: string;
  budget: { level: Level; effWPerMin: number | null; latch: { kind: 'exceeded' | 'banned' | 'banned_max'; until: Ms } | null };
  data: T; cohort?: Cohort; nextCursor?: string | null;
  /** A-109: set by the list routes. `count` = COUNT of the same filter in the page's transaction; `nullKeys` = rows whose sort key is null (sorted last, never 0);
   *  `sortedAt` is set only for `sort=now` (one page, no cursor). */
  list?: { count: number; nullKeys: number; sort: SortKey; sortedAt: Ms | null };
}
export interface Cohort {
  from: Ms; to: Ms; rulesVersions: string[]; maturedOnly: boolean;
  nTotal: number; nMatured: number; nPending: number; nFailed: Record<string, number>; nNotSampled: number;
  banWindow: 'included' | 'excluded' | 'split'; budgetLevels: 'all' | 'S0-S1' | 'S2+'; ipw: boolean;
}   // invariant: nTotal = nMatured + nPending + Σ nFailed + nNotSampled

export interface LabelChip { id: string; ruleVersion: string; role: 'acting' | 'measured' | 'quality'; value: boolean | null; known: boolean }
export type DeliveryChannel = 'bot_post' | 'tg' | 'autobuy' | 'cancel' | 'alert';
export interface DeliveryView { channel: DeliveryChannel; status: string; reason: string | null; leg: string | null;
  at: Ms; signalAgeMs: number | null; messageId: number | null; tx: string | null; prov: string }
export type CheckpointKey = '5m' | '15m' | '30m' | '1h' | '3h' | '6h' | '24h';
export type FpLabel = 'win' | 'rug' | 'flat' | 'open';
export type OutcomeStatus = 'pending' | 'provisional' | 'final' | 'unmeasurable' | 'not_sampled';

export interface SignalSummary {
  decisionId: string; ca: string; symbol: Measured<string>; name: Measured<string>; logoUrl: string | null;
  decidedAt: Ms; firstReachAt: Ms; triggerEventAt: Ms | null;
  lateness: Measured<number>;                     // decidedAt − triggerEventAt, unit 'ms', src 'engine.derived'
  grade: Grade; conf: number; tier: string;
  labels: LabelChip[];                            // acting first, then measured, then quality
  entry: { price: Measured<number>; mcap: Measured<number>; mcapBasis: 'circ' | 'total'; liqEff: Measured<number>;
           poolLiq: Measured<number>; quoteAgeMs: number; flags: Array<'stale-input' | 'stale-entry'> };
  live: { tracked: boolean; tier: TrackTier | null; price: Measured<number>; mcap: Measured<number>; poolLiq: Measured<number>;
          multiple: Measured<number>; frozenSince: Ms | null; drainedAt: Ms | null };   // untracked ⇒ v null, reason 'not-tracked-live'
  peak: { multiple: Measured<number>; method: 'candle-1m-close' | 'candle-5m-close' | 'tracker' | null; at: Ms | null;
          /** A-109 / A-118: the implied peak market cap (src engine.derived, deps on the entry mcap and the peak refs); null with its reason, never a guess. */
          mcap: Measured<number>;
          /** A-109 / A-118: the label of the cohort peak bucket (the NEW-3 edges 0, 1, 2, 5, 10) this multiple falls in; null when the peak is unknown. */
          bucket: string | null };
  checkpoints: Record<CheckpointKey, Measured<number>>;
  outcome: { status: OutcomeStatus; basisKind: 'entry' | 'first_reach_candle' | null; fpLabel: Measured<FpLabel>; fpFinal: boolean;
             staleEntry: boolean | null /* true ⇒ flagged and excluded with reason 'stale-entry', never shown as a rug */; drained: boolean | null; failReason: string | null;
             /** A-109 / A-118: the lowest and the highest-high multiples of the outcome row already read (the Winners "Max drawdown ×" is minCloseX). */
             minCloseX: Measured<number>; peakHighX: Measured<number> };
  paperEA: Measured<number>;                      // net per $1, conservative fills, cancel-aware; from the R1 (or final) outcome's paper row
  delivery: { botPost: DeliveryView | null; tg: DeliveryView | null; autobuy: DeliveryView | null;
              alertPause: DeliveryView | null /* latest open 'paused_budget' alert delivery (leg 'PAUSE'): "exit alerts paused (budget S2) since HH:MM" */ };
  cancelled: { at: Ms; reason: string; kills: string[]; prov: string } | null;
  flags: { banWindow: boolean; feedGap: boolean; budgetLevel: Level; preCutoverToken: boolean | null; staleInput: boolean };
  versions: { rules: string; policy: string; code: string; exitPolicyId: string };
  /** A-109 / A-118: the would-kill names of the decision record (already stored), for the card's warning row. */
  wouldKill: string[];
}
export interface DecisionKilled {
  decisionId: string; ca: string; symbol: Measured<string>; action: 'killed' | 'unpriceable';
  decidedAt: Ms; firstReachAt: Ms; unpriceableReason: string | null;
  kills: Array<{ id: string; ruleVersion: string; input: Measured<number | boolean>; threshold: string }>;
  outcome: SignalSummary['outcome']; flags: SignalSummary['flags']; versions: SignalSummary['versions'];
}
export interface FrozenInputView { field: string; value: Measured<number | string | boolean>; ageAtDecisionMs: number | null; known: boolean; usedBy: string[] }
export interface KillView { id: string; ruleVersion: string; status: 'pass' | 'fail' | 'unknown' | 'not_applicable'; value: boolean | null; inputs: string[]; threshold: string }
export interface ArmView { status: 'eligible' | 'blocked' | 'unknown'; by: string[]; unknownInputs: string[] }
export interface OutcomeReadView { readId: string; read: 'R0' | 'R1' | 'R2'; attempt: number; dueAt: Ms; status: string; failReason: string | null;
  completedAt: Ms | null; pages: number; weight: number; nCandles: number; coverage: number | null; prov: string }
export interface OutcomeView { outcomeVersion: string; status: OutcomeStatus; basisKind: 'entry' | 'first_reach_candle'; fpFinal: boolean; computedAt: Ms; fpLabel: FpLabel | null; fpAt: Ms | null;
  fp05Label: FpLabel | null; rug1h: boolean | null; rugAfter1h: boolean | null; win2x6h: boolean | null; dead24h: boolean | null;
  peakCloseX: number | null; peakHighX: number | null; minCloseX: number | null; t2xFirst: Ms | null;
  entryConservative: number | null; staleEntry: boolean | null; drained: boolean | null; gone: boolean | null;
  coverage: number | null; failReason: string | null; prov: string }
export interface ExitLegView { legId: string; positionId: string; leg: string; status: string; attempt: number; fractionOfOriginal: number;
  triggerMultiple: number | null; peakMultiple: number | null; quoteMultiple: number | null; quoteSrc: string | null; quoteAgeMs: number | null;
  triggerAt: Ms; sendAt: Ms | null; confirmAt: Ms | null; tx: string | null; solOutQuotedLamports: string | null;
  solOutRealLamports: string | null; fillMultiple: number | null; dryRun: boolean; error: string | null; prov: string }
export interface PositionView { positionId: string; decisionId: string | null; ca: string; walletId: string; origin: 'signal' | 'manual';
  dryRun: boolean; arm: ArmId | null; openedAt: Ms; closedAt: Ms | null; closeReason: string | null;
  solSpentLamports: string | null; realizedSolNetLamports: string | null; rentReclaimedLamports: string | null;
  closeAccountStatus: string | null; fillSource: string | null; prov: string }
export interface CandleSeries { res: '1m' | '5m'; points: Array<{ t: Ms; o: number; h: number; l: number; c: number }>; prov: string[] }
export interface TrackerSeries { points: Array<{ t: Ms; price: number; frozen: boolean }>; prov: string[] }

export interface DecisionRecord {
  action: 'signal' | 'killed' | 'unpriceable';
  summary: SignalSummary | null;                  // set when action = 'signal'
  killed: DecisionKilled | null;                  // set otherwise
  identity: { decisionId: string; ca: string; firstReachAt: Ms; decidedAt: Ms; recordedAt: Ms; deferSweeps: number;
              packMs: number | null; runId: string; scopePlatform: string };
  inputs: FrozenInputView[];
  score: { tier: string; confidence: number; rawScore: number; terms: Array<{ term: string; points: number; inputs: string[] }>; dataGaps: string[] };
  kills: KillView[];
  labels: Array<LabelChip & { inputs: string[]; threshold: string }>;
  wouldKill: string[];
  arms: Record<ArmId, ArmView>;
  gradeDerivation: string[];                      // server-generated lines, e.g. "B2 blocked by band-10-25k=false"
  sampling: { stratum: string; pInclude: number; sampled: boolean };
  deliveryTimeline: DeliveryView[];
  signalEvents: Array<{ type: 'cancel' | 'late_data'; at: Ms; reason: string; prov: string }>;
  positions: PositionView[]; exitLegs: ExitLegView[];
  outcomeReads: OutcomeReadView[]; outcomeVersions: OutcomeView[];
  candles: CandleSeries | null; tracker: TrackerSeries | null;
  markers: Array<{ kind: 'decision' | 'entry' | 'checkpoint' | 'exit_leg' | 'paper_leg'; at: Ms; label: string }>;
}

export interface SignalsStrip { signals1h: Record<Grade, Measured<number>>; signals24h: Record<Grade, Measured<number>>;
  killed1h: Measured<number>; killed24h: Measured<number>; unpriceable24h: Measured<number>; medianQuoteAge1h: Measured<number> }
export interface RateView { value: Measured<number>; k: number; n: number; ci: [number, number] | null; ciMethod: 'wilson' | 'newcombe' | 'bootstrap' }
export interface CohortView {
  rates: { win: RateView; rug: RateView; flat: RateView; rug1h: RateView };
  checkpointsMedian: Record<CheckpointKey, Measured<number>>;
  /** A-109 / A-118: `rug` and `flat` join `win` per UTC day, and the list covers EVERY UTC day of the cohort window (a day with no matured rows has nMatured 0 and null RateViews, `not-applicable`). */
  daily: Array<{ day: string; nMatured: number; win: RateView; rug: RateView; flat: RateView }>;
  /** By rules_version, ban window, budget level or grade (A-109: the key `grade`) when requested. A-109 / A-118: each item has its own median checkpoints. */
  split: Array<{ key: string; cohort: Cohort; rates: CohortView['rates']; checkpointsMedian: Record<CheckpointKey, Measured<number>> }> | null;
  /** A-109 / A-118: the days of `daily` are UTC days. */
  tz: 'UTC';
  /** A-109 / A-118: the peak multiple histogram, edges [0,1) [1,2) [2,5) [5,10) [10,inf) (the last bucket has `to` null); n = matured rows with a peak, so the counts sum to n; `max` is the exact best multiple. */
  peakBuckets: { edges: number[]; buckets: Array<{ from: number; to: number | null; k: number }>; n: number; max: Measured<number> } | null;
  /** A-109 / A-118: the daily and cumulative paper (policy EA) net per $1; null with a reason (on the Measured values) when a matured row lacks a paper row. */
  paperDaily: Array<{ day: string; n: number; sum: Measured<number>; cum: Measured<number> }> | null;
}
export interface TradesView {
  positions: PositionView[]; exitLegs: ExitLegView[]; realizedNetSol: Measured<number>; rolling50Net: Measured<number>;
  /** A-109 / A-118 (NEW-13): one read over ALL bot positions since cutover, no row limit. realizedNetSol is null with 'quoted-only-leg' while any closed non-dry position has a quoted-only filled leg. */
  summary: { realizedNetSol: Measured<number>; nVerified: Measured<number>; nQuotedOnly: Measured<number>; nOpen: Measured<number>; openCostSol: Measured<number>; nPositions: Measured<number> };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A-109 (R8-RD0, round 8a): the Overview and Activity views of the redesigned dashboard (DASHBOARD-REDESIGN sections 4.1, 9.1, 9.2 NEW-1 and NEW-10).
// Every number is a Measured of class QUERY. The views are served by /api/v2/overview and /api/v2/activity (R8-RDE1).
// ---------------------------------------------------------------------------------------------------------------------------------

/** GET /api/v2/overview. perGrade + ungraded = total, and the tg record (every TgSignalStatus plus 'none') sums to total, both in one read transaction. */
export interface OverviewView {
  sinceCutover: { total: Measured<number>; perGrade: Record<Grade, Measured<number>>; ungraded: Measured<number> };
  /** The current Telegram signal-card status of each counted decision (exit-alert and cancel legs excluded); 'none' = no such row. */
  delivery: { tg: Record<TgSignalStatus | 'none', Measured<number>> };
  trackedNow: Measured<number>;
}

/** What one outbox row names, never today's state of the decision: the outcome version with its own label, that delivery row, that leg row, and so on. */
export interface ActivityDecisionEntity { action: 'signal' | 'killed' | 'unpriceable'; grade: Grade | null; conf: number | null }
export interface ActivityOutcomeEntity { outcomeId: string; fpLabel: FpLabel | null; status: OutcomeStatus; fpFinal: boolean; computedAt: Ms }
export interface ActivityDeliveryEntity { deliveryId: string; channel: DeliveryChannel; leg: string | null; status: string; at: Ms }
export interface ActivityExitLegEntity { legId: string; leg: string; status: string; at: Ms }
export interface ActivityPositionEntity { positionId: string; event: 'opened' | 'closed'; at: Ms }
export interface ActivitySignalEventEntity { eventId: string; type: 'cancel' | 'late_data'; at: Ms }
export type ActivityKind = 'decision' | 'outcome' | 'delivery' | 'exit_leg' | 'position' | 'signal_event';
export interface ActivityRowBase {
  seq: number;                                    // the outbox sequence number of the event
  at: Ms;
  decisionId: string | null;                      // null only for a manual position (no signal)
  ca: string;
  symbol: Measured<string>;
}
/** One row per durable outbox event; `entity` is the version the row names, typed by `kind`. */
export type ActivityRow = ActivityRowBase & (
  | { kind: 'decision'; entity: ActivityDecisionEntity }
  | { kind: 'outcome'; entity: ActivityOutcomeEntity }
  | { kind: 'delivery'; entity: ActivityDeliveryEntity }
  | { kind: 'exit_leg'; entity: ActivityExitLegEntity }
  | { kind: 'position'; entity: ActivityPositionEntity }
  | { kind: 'signal_event'; entity: ActivitySignalEventEntity }
);
/** GET /api/v2/activity?limit=N (max 50): the last N durable outbox events. */
export interface ActivityView { rows: ActivityRow[] }
export interface RulesView { registrySha: string;
  rules: Array<{ ruleId: string; ruleVersion: string; kind: string; definition: string; threshold: Record<string, unknown>; inputs: string[]; evidence: string;
    registeredAt: string; status: string; promotionTarget: string | null;
    evals: Array<{ look: number; verdict: string; computedAt: Ms; stats: Record<string, unknown> }> }>;
  killAudit: Array<{ killId: string; killed: number; matured: number; winnersLost: number; decisions: string[] }>;
  overlap: Array<{ a: string; b: string; jaccard: number; n: number }> }
export interface ArmsView { arms: Array<{ arm: ArmId; verdict: 'INSUFFICIENT' | 'PASS' | 'FAIL' | 'RETIRED' | 'BIASED'; nMatured: number; nExecutable: number | null; days: number;
  look: 0 | 1 | 2 | 3; meanNet: Measured<number>; lcbToken: Measured<number>; lcbDay: Measured<number>;
  blockSigns: [boolean | null, boolean | null, boolean | null]; dropTop3: Measured<number>; trimmedMean: Measured<number>;
  paperVsDryRunGap: Measured<number>; missingShare: number | null; aborted: boolean; reportId: string | null; evaluatedAt: Ms | null }>;
  /** Built ONLY from the bot heartbeat (C71 rule 10); never a default. state = heartbeatState(15000, heartbeatAt, serverNow).
   *  heartbeatAt null → every value null, state 'missing', reason 'not-fetched'. state 'stale' → last known values kept, reason 'stale' (labelled "last known", never current). */
  autobuy: { enabled: boolean | null; mode: 'off' | 'dry_run' | 'live' | null; arm: ArmId | null; reportId: string | null; dryRun: boolean | null; paused: string | null;
    heartbeatAt: Ms | null; ageMs: number | null; state: Freshness; reason?: NullReason;
    engineVerdict: 'INSUFFICIENT' | 'PASS' | 'FAIL' | 'RETIRED' | 'BIASED' | null;   // the Engine's standing verdict for `arm`
    verdictMatch: boolean | null;   // mode 'live' only: engineVerdict === 'PASS'; null otherwise
    reportMatch: boolean | null } } // mode 'live' only: reportId === the arm's current standing reportId (false after a later PASS look: amber, informational)
export interface ProvenanceView { ref: string; kind: 'snapshot' | 'evidence' | 'outcome_read' | 'trade' | 'bot_event' | 'decision' | 'stream_event' /* A-84: a PumpPortal frame (pp:launch, pp:mig, pp:trade, pp:tmin, pp:trades) */
    | 'wallet' /* A-98: a wallet quote, balance read, fill or UnclaimedSol item (w:quote, w:bal, w:tx, w:ucs); served only by /api/wallet/v1/provenance under the wallet session */;
  source: SourceId | null; route: string | null; fetchedAt: Ms | null; srcTs: Ms | null; retained: boolean;
  fields: Record<string, unknown> | null; raw: unknown | null; note: string | null }

export interface BudgetStatus {
  level: Level; effWPerMin: number | null; startWPerMin: number; targetWPerMin: number; ceilingWPerMin: number; lastViolationAt: Ms | null;
  mirror: { level: number; cap: number; drainWPerS: number };
  lanes: Record<'decide' | 'feed' | 'candidate' | 'track' | 'outcome' | 'observe',
    { demandWPerMin: number; used1m: number; used15m: number; floorWPerMin: number; queue: number; oldestWaitMs: number | null; refused15m: Record<string, number> }>;
  routes: Array<{ route: string; calls1h: number; weight1h: number; errors1h: number; r429_24h: number; p50LatencyMs: number | null }>;
  promises: Array<{ id: PromiseId; targetMs: number | null; p50Ms: number | null; p95Ms: number | null; keptShare15m: number | null }>;
  latchHistory24h: Array<{ kind: string; from: Ms; until: Ms }>;
  unexplained429_24h: number; unattributedCalls24h: number; headersSeen: boolean; tier: string | null;
  levelTimeline24h: Array<{ at: Ms; level: Level }>;
  candleBudget: { day: string; capWeight: number; usedWeight: number; byStratum: Record<string, number> };
}
/** A-84 (round 6, PUMPPORTAL-DESIGN sections 5.4, 5.5, 6.3 item 11): the PumpPortal block of the Health page, built by R6-PP12 from ApiDeps.pumpPortal().
 *  The literal unions mirror the Engine's PpStatus / PpMeterDay (Engine/src/pumpportal/types.ts); this file cannot import Engine types.
 *  Times are plain Ms (like HealthView.delivery.botHeartbeatAt), counts and rates are Measured (an observation: null with a reason, never 0).
 *  The API key and the URL are never part of this view. */
export interface PumpPortalCountsView { desired: Measured<number>; pending: Measured<number>; live: Measured<number> }
export interface PumpPortalMeterView {
  day: string;                                   // UTC day 'YYYY-MM-DD' the counters belong to
  billed: Measured<number>; metered: Measured<number>; freeKeyed: Measured<number>; freeKeyless: Measured<number>;
  control: Measured<number>; unknown: Measured<number>; dupes: Measured<number>;
  solEst: Measured<number>;                      // unit 'sol': billed x price / 10,000 (a bound on the vendor's count, never claimed exact)
  capSol: number; stopAtMsgs: number;            // the configured daily cap and the message count at which the hard stop fires (cap minus the in-flight reserve)
  freeKeyedBilled: boolean;                      // PUMPPORTAL_KEYED_FREE_BILLED: free frames on a keyed socket count toward the stop
  warnAt: Ms | null; capHitAt: Ms | null;
}
export interface PumpPortalAlarmView { id: string; severity: 'warn' | 'red'; since: Ms; text: string }
export interface PumpPortalHealthView {
  mode: 'off' | 'free' | 'full';                 // 'off' here means lockHeldElsewhere (the configured mode off serves HealthView.pumpPortal = null)
  keyed: boolean;
  state: 'off' | 'connecting' | 'live' | 'degraded' | 'disconnected' | 'banned';
  connectedSince: Ms | null; lastFrameAt: Ms | null; lastPongAt: Ms | null;
  reconnects1h: Measured<number>;
  bannedUntil: Ms | null;
  meteredOff: NullReason | null;                 // why the metered streams are off ('metered-cap', 'metered-unfunded', 'metered-key-refused', 'stream-keyless', 'stream-banned') or null
  keyedFreeStreams: boolean;                     // false while a keyed socket runs metered-only (small-cap rule, design section 5.4)
  lockHeldElsewhere: boolean;
  accounts: PumpPortalCountsView; tokens: PumpPortalCountsView;
  meter: PumpPortalMeterView;
  triggerUnconfirmed: { n: Measured<number>; ratio: Measured<number> };   // the metric pp.trigger.unconfirmed, per UTC day (n, and the ratio to all PP-triggered clusters)
  alarms: PumpPortalAlarmView[];                 // active pumpportal-* alarms
}
export interface HealthView {
  loops: Array<{ loop: string; intervalMs: number; lastAt: Ms | null; lastOkAt: Ms | null; state: Freshness; lastError: string | null; signalPath: boolean }>;
  dataQuality: { window: '1h' | '24h'; mktCompleteShare: Measured<number>; quoteAgeP50: Measured<number>; quoteAgeP95: Measured<number>;
    deferRate: Measured<number>; unpriceableRate: Measured<number>; frozenCount: Measured<number>; drainedCount: Measured<number>;
    banWindowShare: Measured<number>; discoveryLagP50: Measured<number>; discoveryLagP95: Measured<number>; feedGapRate: Measured<number>;
    decisionsPerHour: Measured<number> }[];
  delivery: { botHeartbeatAt: Ms | null; botState: Freshness /* heartbeatState(15000, …): same rule as ArmsView.autobuy */; tgCounts24h: Record<string, number>; buyCounts24h: Record<string, number>;
    botTgMinGrade: Grade | null; engineTgMinGrade: Grade;
    deadLettered: number | null; deadLastCode: string | null;   // from the bot heartbeat (null when no heartbeat)
    ingressRejects24h: Record<'invalid' | 'transition' | 'unknown_signal', number>; opsDeliveries24h: Record<string, number>;
    /** A-109 / A-118 (NEW-8): the bot's own surface. username and rpcProvider come from the last valid heartbeat (src bot.heartbeat); the wallet from the newest persisted bot_wallet_reads row
     *  (src bot.wallet, class WALLET, prov bot:<event_id>). A stale heartbeat keeps the last-known values with state 'stale'; null 'bot-unavailable' only with no heartbeat / no stored
     *  read; a field the bot did not send is null 'not-reported'. Never a rebates or marketing wallet. */
    bot: { username: Measured<string>; wallet: { walletId: string | null; address: Measured<string>; sol: Measured<ExactAmount> }; rpcProvider: Measured<string> } };
  peerGmgnClient: { detected: boolean; lastSeenAt: Ms | null; pids: number[] };   // C72 peer-clients backstop (process name + PID only)
  integrity: { lastRunAt: Ms | null; ok: boolean | null; failed: Array<{ id: string; detail: string }> };
  versions: { code: string; dirty: boolean; sourceNewerThanProcess: boolean; rules: string; policy: string; schema: number; dashboardBuildExpected: string };
  clockSkewMs: Measured<number>; sseClients: number;
  latency: { recordedToEmittedP95Ms: Measured<number>; firstReachToRecordedP95Ms: Measured<number> };
  signalsEnabled: boolean; gmgnState: 'ok' | 'rate_limited' | 'banned' | 'disabled_routes' | 'not_configured';
  /** A-84: optional so every existing producer and fixture compiles. null = PumpPortal is configured off; absent = an Engine that predates round 6. */
  pumpPortal?: PumpPortalHealthView | null;
  /** A-109 / A-118 (NEW-9): the Engine run (runs.started_at of env.runId); null when the run row is missing. */
  run: { runId: string; startedAt: Ms } | null;
  /** A-109 / A-118 (NEW-9): tokens first seen and PumpPortal launches in the last hour and day (counted from tokens.first_seen_at and pp_launches). */
  counts: { tokensSeen1h: Measured<number>; tokensSeen24h: Measured<number>; launches1h: Measured<number>; launches24h: Measured<number> };
}
export interface MetaView { freshness: typeof import('./freshness').FRESHNESS; stream: typeof import('./freshness').STREAM;
  tgMinGrade: Grade; trackMinGrade: Grade; promises: Record<Level, Partial<Record<PromiseId, number | null>>>;
  taxonomy: { grades: Grade[]; arms: ArmId[]; labels: Array<{ id: string; ruleVersion: string; role: 'acting' | 'measured' | 'quality' }>;
              kills: Array<{ id: string; ruleVersion: string }> } }

export type StreamEvent =
  | { event: 'decision'; id: number; data: SignalSummary | DecisionKilled }
  | { event: 'signal_event'; id: number; data: { decisionId: string; summary: SignalSummary } }
  | { event: 'delivery'; id: number; data: { decisionId: string; view: DeliveryView } }
  | { event: 'outcome'; id: number; data: { decisionId: string; outcome: SignalSummary['outcome']; checkpoints: SignalSummary['checkpoints']; paperEA: Measured<number> } }
  | { event: 'exit_leg' | 'position'; id: number; data: ExitLegView | PositionView }
  | { event: 'arm_status' | 'integrity' | 'source_window' | 'budget'; id: number; data: unknown }
  | { event: 'quote'; data: { decisionId: string | null; ca: string; live: SignalSummary['live'] } }        // ephemeral, no id
  | { event: 'heartbeat'; data: { serverNow: Ms; maxSeq: number; outboxLagMs: number; budget: Envelope<unknown>['budget'] } } // no id
  | { event: 'resync'; data: { oldestSeq: number } };

// ---------------------------------------------------------------------------------------------------------------------------------
// A-98 (R7-W3, round 7a): the browser-wallet views (WALLET-DASHBOARD-DESIGN sections 6.3, 8, 11.7, 12.2 and "Rev 3" R3-2, R3-3).
// They are served by /api/wallet/v1 (never by /api/v2), each inside a WalletEnvelope, and only to the signed-in owner. Every displayed number is a
// Measured; a plain number here is an identifier, a protocol parameter, an echo of the owner's own input or a limit served by GET /limits.
// A value that is unknown is a Measured with v null and its reason, never a default. No wallet value is ever put on SSE (StreamEvent is unchanged)
// or in an export. PositionView.origin is unchanged: wallet trades are not positions of the bot.
// ---------------------------------------------------------------------------------------------------------------------------------

/** An exact quantity of one asset in base units. `baseUnits` is a SIGNED CANONICAL integer string (^-?(0|[1-9][0-9]*)$, never "-0"), `decimals` is 0-18,
 *  `asset` is 'SOL' (lamports, decimals 9) or the token's mint address. It travels in a Measured with unit 'exact_amount'; the page formats it by
 *  string arithmetic and never converts it to a Number (an amount can exceed 2^53). */
export interface ExactAmount { baseUnits: string; decimals: number; asset: string }

/** The C01 envelope of a wallet answer plus the address of the wallet session that asked: the page ends its session when it differs from the
 *  connected account (design section 5.1 step 5). null on the answers that exist without a session (GET /session). */
export interface WalletEnvelope<T> extends Envelope<T> { sessionOwner: string | null }

/** Why the wallet features are off: 'lan-mode' (the Engine binds a non-loopback address), 'no-allowed-owners' (WALLET_ALLOWED_OWNERS is empty),
 *  'wallet-off' (WALLET_DASHBOARD=0), 'not-configured' (UnclaimedSol has no key; trading may still be on), 'bot-unavailable' (the bot link is down). */
export type WalletOffReason = 'lan-mode' | 'no-allowed-owners' | 'wallet-off' | 'not-configured' | 'bot-unavailable';
export interface WalletSessionView {
  owner: string | null;                 // the signed-in address, null without a session
  expiresAt: Ms | null;                 // the session's end (the earlier of its idle and absolute limits), null without a session
  features: { trading: boolean; selfClose: boolean; ucs: boolean; reason: WalletOffReason | null };
}

export type WalletRoute = 'pump' | 'pumpswap' | 'jupiter';
export type WalletSide = 'buy' | 'sell';
export type WalletFeeLevel = 'normal' | 'fast';

/** GET /limits. The page holds no numeric policy: every default and bound it shows or checks comes from here (owner answers Q2 a-c). There are no
 *  buy-amount presets: the owner types the SOL amount in every dialog. */
export interface WalletLimitsView {
  tradeMaxSol: string | null;           // WALLET_TRADE_MAX_SOL as a decimal string (> 0, at most 9 decimals); null = no cap (the default)
  slippage: { buyDefaultBps: number; sellDefaultBps: number; minBps: number; maxBps: number };   // integer bps; per-trade value in [minBps, maxBps]
  impact: { defaultPct: number; maxPct: number };                                              // percent; per-trade value in (0, maxPct], at most 2 decimals
  sellPctPresets: number[];             // basis points of the held balance (2500, 5000, 10000)
  feeLevels: WalletFeeLevel[];          // the priority-fee levels the owner may pick
  closeBatch: number;                   // the most token accounts one close transaction carries
}

/** One token account of the last balance read. */
export interface WalletTokenView {
  account: string; mint: string; program: 'token' | 'token-2022';
  amount: Measured<ExactAmount>;        // raw balance, decimals of the mint, asset = the mint; src chain.wallet, cls WALLET
  rentLamports: Measured<ExactAmount>;  // the account's own lamports: what a close returns to the owner
  frozen: boolean | null;               // null = the read did not say
  protections: string[];                // plain-text protection names from the owner's unexpired UnclaimedSol snapshot; [] without one
}
/** GET /wallet: the last bot read of the owner's balances. A missing read is a Measured with v null and a reason ('not-fetched', 'bot-unavailable',
 *  'stale'), and `tokens` is null: an absent list is never shown as an empty wallet. */
export interface WalletView {
  owner: string;
  sol: Measured<ExactAmount>;           // lamports, decimals 9, asset 'SOL'; src chain.wallet, cls WALLET, obsAt = the read time, prov w:bal:<owner>:<readAt>
  tokens: WalletTokenView[] | null;
  wsol: { account: string; amount: Measured<ExactAmount> } | null;   // the owner's wrapped-SOL account, for Unwrap; null = none in the read
  emptyAccounts: { count: Measured<number>; rentLamports: Measured<ExactAmount> };   // closable empty accounts (protected ones excluded) and the rent they return
  readAt: Ms | null; slot: number | null;
}

/** The bound the program enforces, decoded from the signed bytes. exact_in: the owner pays exactly `amountIn` and receives at least `minOut`.
 *  exact_out (PumpSwap buy): the owner receives exactly `exactOut` and pays at most `maxIn`. Each amount: src bot.route_quote, cls TX_QUOTE. */
export type WalletQuoteBoundView =
  | { kind: 'exact_in'; amountIn: Measured<ExactAmount>; minOut: Measured<ExactAmount> }
  | { kind: 'exact_out'; exactOut: Measured<ExactAmount>; maxIn: Measured<ExactAmount> };
/** A fee charged inside the swap program (simulated, so an estimate): label, the account that receives it and the exact simulated amount. */
export interface WalletInnerFeeView { label: string; recipient: string; amount: Measured<ExactAmount> }
/** A top-level transfer to a third party; each is its own disclosed line with the exact lamports. */
export interface WalletTransferView { recipient: string; amount: Measured<ExactAmount> }
/** A token flag frozen with the decision ("at decision HH:MM"). known false => value null: shown as "unknown", never as "none". */
export interface WalletSecurityFlagView { field: string; value: Measured<boolean> | null; known: boolean; atDecision: Ms | null }
export type WalletQuoteWarning = 'slippage-above-default' | 'impact-above-default';

/** POST /trade/quote: a server-built, verified and simulated UNSIGNED transaction plus everything the confirmation step shows (design 8.4). Only the
 *  program-enforced `bound` is guaranteed; every other value is an estimate and is labelled so. */
export interface TradeQuoteView {
  quoteId: string;                      // 128 random bits, base64url (22 chars); owned by the session owner, single use, persisted
  route: WalletRoute; side: WalletSide; mint: string; decisionId: string | null;
  bound: WalletQuoteBoundView;
  maxOutflowLamports: Measured<ExactAmount>;   // the most the transaction can take from the wallet: amount or max in + network + priority fee + rent bound
  estimates: {
    quotedOut: Measured<ExactAmount> | null;   // exact_in routes; null on exact_out
    quotedIn: Measured<ExactAmount> | null;    // exact_out routes; null on exact_in
    impactPct: Measured<number>;               // unit pct; v null with 'provider-null' when the route gives none
    simulatedDeltas: { sol: Measured<ExactAmount>; token: Measured<ExactAmount> };   // signed changes of the owner's SOL and trade token; src bot.simulation
  };
  networkFeeLamports: Measured<ExactAmount>;
  priorityFee: { cuLimit: Measured<number>; cuPriceMicrolamports: Measured<number>; lamports: Measured<ExactAmount> };   // set in this transaction; the wallet may change it
  innerFees: WalletInnerFeeView[];
  thirdPartyTransfers: WalletTransferView[];
  rentLamports: Measured<ExactAmount>;         // token-account rent, refundable when the account is closed
  securityFlags: WalletSecurityFlagView[];     // from the decision; [] for a sell or a close (no decision)
  programs: string[];                          // the program ids the transaction invokes
  txBytes: Measured<number>;                   // serialized size
  txBase64: string;                            // the unsigned transaction; the page decodes it once and inspects that copy
  minContextSlot: number;                      // passed to the wallet as options.minContextSlot
  builtAt: Ms;
  balanceLamports: Measured<ExactAmount>;      // the owner's SOL balance read in this build; src chain.wallet, cls WALLET, obsAt = the read time
  usd: { amount: Measured<number>; maxOutflow: Measured<number> };   // display only, never cost or PnL: src engine.derived, cls SOL_USD; v null with its reason when SOL/USD is stale
  slippageBps: number; maxImpactPct: number;   // echoes of the owner's per-trade choices
  warnings: WalletQuoteWarning[];              // a choice above the side's / the .env default
  routingNotes: string[];                      // why a route was skipped, e.g. 'pumpswap-direct-disabled', 'pumpportal-not-offered', 'mayhem-mode-unsupported'
}

/** `submitted` -> `unverified` -> one final state; `unverified` may still become any final one. A final state never changes. */
export type WalletTradeStatus = 'submitted' | 'unverified' | 'confirmed' | 'failed' | 'not-landed' | 'rejected-not-owner';
/** One wallet trade as booked from the chain. The fill values come ONLY from the transaction meta (src chain.tx, cls DECISION, prov w:tx:<signature>) and
 *  are null with 'fill-pending' / 'fill-unverified' until booked; a quote is never booked as a fill. */
export interface WalletTradeView {
  tradeId: string; quoteId: string; decisionId: string | null; mint: string; symbol: Measured<string> | null;
  side: WalletSide; route: WalletRoute; signature: string; submittedAt: Ms;
  status: WalletTradeStatus; reason: string | null;   // a short code or sentence for failed / unverified / not-landed, e.g. 'price-moved'
  solDelta: Measured<ExactAmount>;      // signed change of the owner's SOL, fee and rent included
  feeLamports: Measured<ExactAmount>;   // the network and priority fee paid (also on a failed trade)
  rentPaidLamports: Measured<ExactAmount>;   // token-account rent paid by this transaction (refundable)
  tokenDelta: Measured<ExactAmount>;    // signed change of the trade token
  slot: number | null; blockTime: Ms | null; verifiedAt: Ms | null;
}
/** One token-account close or wSOL unwrap, booked like a trade. */
export interface WalletCloseView {
  closeId: string; quoteId: string; kind: 'empty' | 'unwrap'; signature: string; submittedAt: Ms;
  status: WalletTradeStatus; reason: string | null;
  accounts: string[]; rentReturnedLamports: Measured<ExactAmount>; feeLamports: Measured<ExactAmount>;
  slot: number | null; blockTime: Ms | null; verifiedAt: Ms | null;
}
/** A quote whose wallet outcome is unknown (the wallet errored after "send"): "Look again" posts /trade/find. */
export interface WalletUnknownOutcomeView { quoteId: string; mint: string; side: WalletSide; at: Ms }
/** GET /trades (page with ?limit&cursor; the cursor travels in Envelope.nextCursor): one row per wallet trade, close, analysis and unresolved outcome, newest first. */
export type WalletActivityRow =
  | { kind: 'trade'; at: Ms; trade: WalletTradeView }
  | { kind: 'close'; at: Ms; close: WalletCloseView }
  | { kind: 'unknown'; at: Ms; unknown: WalletUnknownOutcomeView }
  | { kind: 'analysis'; at: Ms; job: UcsJobView };
export interface WalletActivityView { rows: WalletActivityRow[] }

/** One (owner, mint), computed at query time from the owner's trade rows (never stored, design 12.5). A value that cannot be computed is a Measured with
 *  v null and the first applicable reason, in this order and never as a partial sum: 'fill-pending', 'fill-unverified', 'balance-older-than-fill',
 *  'external-activity'. "If sold now" is not here: it comes only from a sell quote the owner asks for. */
export interface WalletPositionView {
  mint: string; symbol: Measured<string> | null;
  tokensHeld: Measured<ExactAmount>;          // last balance read (src chain.wallet) with its slot
  balanceSlot: number | null;
  bookedNetTokens: Measured<ExactAmount>;     // sum of the token deltas of confirmed trades
  costLamports: Measured<ExactAmount>;        // sum over confirmed buys of (SOL out - rent paid), fees included
  rentLamports: Measured<ExactAmount>;        // token-account rent paid, its own line: refundable when the account is closed, never netted into cost
  realizedLamports: Measured<ExactAmount>;    // sum of SOL received by confirmed sells
  failedFeesLamports: Measured<ExactAmount>;  // fees of failed trades: spent, included in `pnl`, shown as their own line
  pnl: Measured<ExactAmount>;                 // signed net cash result so far: realized - cost - failed fees; no mark-to-market value for a position still held
}
export interface WalletPositionsView { positions: WalletPositionView[] }

/** One token account a close transaction closes. */
export interface CloseQuoteAccountView { account: string; mint: string; program: 'token' | 'token-2022'; rentLamports: Measured<ExactAmount> }
/** One account that is NOT closed here, with the reason (e.g. 'has-balance', 'frozen', 'withheld-fees', 'close-authority', 'recent-buy', 'protected') and
 *  the protection name when UnclaimedSol marks it protected. */
export interface CloseQuoteExcludedView { account: string; reason: string; protection: string | null }
/** POST /close/quote: one transaction for one batch of at most WalletLimitsView.closeBatch accounts. The rent returns 100 % to the owner. */
export interface CloseQuoteView {
  quoteId: string; kind: 'empty' | 'unwrap';
  accounts: CloseQuoteAccountView[]; excluded: CloseQuoteExcludedView[];
  remainingAccounts: number;                  // accounts still to close in later batches (0 on the last)
  returnedLamports: Measured<ExactAmount>;    // the rent (or the wSOL amount, for unwrap) that returns to the owner; src bot.route_quote
  wsolAmount: Measured<ExactAmount> | null;   // unwrap only
  networkFeeLamports: Measured<ExactAmount>;
  priorityFee: { cuLimit: Measured<number>; cuPriceMicrolamports: Measured<number>; lamports: Measured<ExactAmount> };
  maxOutflowLamports: Measured<ExactAmount>;  // network + priority fee only: a close takes nothing else
  simulatedDeltas: { sol: Measured<ExactAmount> };
  programs: string[]; txBytes: Measured<number>; txBase64: string; minContextSlot: number; builtAt: Ms;
}

// UnclaimedSol analysis (design 11; rev 3 R3-3). All provider text is plain text; USD figures are validated text shown verbatim. Every amount is an estimate.
/** Estimated value of an item or a total in one asset: gross, the service fee and the net after the fee. */
export interface UcsAmountView { gross: Measured<ExactAmount>; serviceFee: Measured<ExactAmount>; net: Measured<ExactAmount> }
export interface UcsItemView {
  itemId: string; pageIndex: number;
  kind: string; program: string | null; account: string; mint: string | null;   // kind: a provider enum member validated against the contract pin
  balance: Measured<ExactAmount> | null;      // raw balance with decimals; null = the item has none
  rentLamports: Measured<ExactAmount>;
  disposition: string; action: string; confidence: string | null;
  reasons: string[]; protections: string[];   // plain-text chips
  recoverable: boolean;                       // false for protected and action 'none' items: listed under "Not recoverable", never selectable or counted
  value: UcsAmountView[];                     // value components, each an estimate
  costs: Array<{ label: string; amount: Measured<ExactAmount> }> | null;   // null = "unavailable", never 0
  costsScope: string | null;                  // 'standalone_estimate' for burn costs
  estimatedNetUsd: Measured<string>;          // unit 'usd_text', verbatim; v null with 'provider-null' when the provider sent none
  marketQuoteStatus: string | null;
  consent: string | null;                     // shown verbatim as plain text for information
  executionSupported: boolean;                // shown as NOT executable here whatever it says: execution is off
  alternativeGroupId: string | null; reviewRequired: boolean;
}
export type UcsJobStatus = 'queued' | 'in_flight' | 'succeeded' | 'failed' | 'uncertain' | 'abandoned';
export type UcsRetryAction = 'same_key' | 'new_key' | 'restart_snapshot' | 'none';
export interface UcsJobView {
  requestId: string; pageIndex: number; status: UcsJobStatus;
  stagesReserved: number; stagesCounted: boolean;
  createdAt: Ms; sentAt: Ms | null; resultAt: Ms | null; replays: number;
  httpStatus: number | null; errorCode: string | null;   // errorCode: a provider code or 'contract-mismatch'; plain text
  retryAction: UcsRetryAction | null; retryAfterMs: number | null;
  retryAvailableAt: Ms | null;                // when "Start a new attempt" becomes allowed (resultAt + retryAfterMs); null = not applicable
  hasMore: boolean | null; analyzedAt: Ms | null; expiresAt: Ms | null;
  chargedUsd: Measured<string>;               // unit 'usd_text', billing.chargedUsd of the response ("charged for this request, invoiced manually"); v null with 'provider-null' when absent
  /** What the owner may click now, decided by the server from the stored row (any other retry action is refused with 409 retry-not-allowed). */
  allowed: { checkAgain: boolean; newAttempt: boolean; restartSnapshot: boolean; nextPage: boolean; giveUp: boolean };
}
/** The quota of the Engine's local counter (stages counted once per key at its first send) and of the provider. There is NO per-owner counter. */
export interface UcsQuotaView {
  utcDate: string;                            // the UTC day of the local counter, YYYY-MM-DD
  stagesUsedToday: Measured<number>;          // local count; "UnclaimedSol's own count decides"
  requestsSentToday: Measured<number>;
  localCap: number | null;                    // UNCLAIMEDSOL_DAILY_STAGE_CAP; null = no local cap
  documentedAllowance: string;                // "UnclaimedSol documents 100 stages per UTC day per customer"
  providerRefusal: { at: Ms; text: string } | null;   // a provider quota refusal, shown verbatim; stops new pages until pausedUntil
  pausedUntil: Ms | null;                     // no new first or next page before this time (00:02 UTC after a provider quota refusal)
  pacing: { waitMs: Measured<number>; reason: 'min-gap' | 'retry-after' | 'utc-rollover' | 'in-flight' | null };   // unit ms; "next request possible in N s"
}
export interface UcsSnapshotView {
  analyzedAt: Ms; expiresAt: Ms; pagesLoaded: number; hasMore: boolean;
  totals: UcsAmountView[];                    // over the loaded pages of this snapshot only, deduped (accounting), never a sum of page summaries
  lastPageSummary: UcsAmountView[] | null;    // the provider's page-scoped summary of the newest page: "this page only, estimate"
}
/** GET /ucs. enabled false with its reason when the key, the allowed owners or the loopback bind is missing: no value is invented. */
export interface UcsView {
  enabled: boolean; reason: 'not-configured' | 'no-allowed-owners' | 'lan-mode' | 'wallet-off' | null;
  quota: UcsQuotaView; jobs: UcsJobView[]; snapshot: UcsSnapshotView | null; items: UcsItemView[];
  claimLink: string | null;                   // the hosted claim link: null while HOSTED_CLAIM_LINK_ENABLED is false; an https: URL otherwise
}
