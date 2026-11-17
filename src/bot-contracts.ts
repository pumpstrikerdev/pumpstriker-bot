// FROZEN CONTRACT (R0-CONTRACTS, round 0a; B10 section 2, transcribed from the C02/B10-B40 specs). Changes only by a numbered plan amendment.
// Bot-internal interfaces between B10 (link, intake, tg), B20 (auto-buy), B30 (exits) and B40 (execution). Types only.
import type { SignalNew, SignalCancel, ExitAlert, ArmsStatusPayload, Envelope, BotToEngineEvent, BuyReason, TokenProxyResponse } from './shared/contract/v1';
import type { ArmId, Grade } from './shared/common/ids';
import type { CardText } from './shared/common/card-types';   // round-0a file (plan grind #40); never the round-0b render-signal
/** forceDryRun: true for mode 'dry_run' — execute() never sends, whatever BOT_DRY_RUN says (plan grind #58). */
export interface AutoBuyDecision { action: 'buy' | 'skip'; reason: BuyReason | null; arm: ArmId | null; forceDryRun: boolean }
export interface BuyExecution { status: 'submitted' | 'dry_run' | 'failed'; tx: string | null; error: string | null;
  route: 'pf-direct' | 'pumpswap-direct' | 'jupiter' | null; solInLamports: string | null; quoteTokensOut: string | null;
  stamps: { decidedAt: number; signedAt: number | null; submittedAt: number | null } }
export interface AutoBuyApi {
  decide(sig: SignalNew, env: Envelope<'signal.new', SignalNew>, receivedAt: number, now: number): AutoBuyDecision;   // pure decision (B20)
  execute(sig: SignalNew, env: Envelope<'signal.new', SignalNew>, d: AutoBuyDecision): Promise<BuyExecution>;          // B20 + B40
  onArmsStatus(p: ArmsStatusPayload): void;
}
export interface ExitApi { cancel(ca: string, signalId: string, c: SignalCancel): Promise<'executed' | 'no_position'>; }   // B30
export interface EngineClient {
  arms(): Promise<ArmsStatusPayload | { error: string }>;
  token(ca: string): Promise<TokenProxyResponse | { error: string }>;      // GET /api/bot/v1/token/:ca (validated with validateTokenProxyResponse; plan grind #50)
  price(ca: string): Promise<{ price: { value: number | null; src: string | null; as_of: number | null }; frozen: boolean; drained: boolean } | { error: string }>;
}
export interface BotOutbox { append(ev: BotToEngineEvent): void; backlog(): number; deadLettered(): { count: number; lastCode: string | null } }
export interface TgQueue { enqueue(card: CardText, meta: { kind: 'signal' | 'cancel' | 'alert' | 'ops'; signalId: string | null; ca: string | null; decidedAt: number | null;
  leg: string | null; grade: Grade | null; replyTo: number | null }): void }   // kind 'ops': owner's private chat, outside pacing and the tgMinGrade filter (plan grind #60)
/** Manual orders migrated from orders.json or created in the UI (plan grind #46); persisted in B\data\manual-orders-v2.json by positions-store (atomic writes). */
export interface ManualOrderV2 { order_id: string; position_id: string; ca: string; wallet_id: string; type: 'tp' | 'sl' | 'tsl'; trigger_pct: number;
  baseline_multi: number | null; peak_rel: number | null; expires_at: number | null; active: boolean; attempts: number; created_at: number; source: 'migrated' | 'ui' }
/** In-flight buy journal entry (plan grind #65): appended to B\data\pending-buys.json (tmp + fsync + rename) after signing and BEFORE sendTransaction. */
export interface PendingBuy { sig: string; signal_id: string; ca: string; wallet_id: string; owner: string; arm: ArmId; route: BuyExecution['route'];
  sol_in_lamports: string; quote_tokens_out: string | null; last_valid_block_height: number; submitted_at: number }
/** The ONLY way to create a signal PositionV2 (normal confirm path and boot recovery alike). 'unverified' uses quote_tokens_out with fill_source 'unverified'; basis null until the first quote. */
export interface PositionsStore { openFromBuy(p: PendingBuy, fill: BuyFill | 'unverified'): PositionV2 }
export interface PositionV2 { position_id: string; signal_id: string | null; origin: 'signal' | 'manual'; dry_run: boolean; ca: string; wallet_id: string;
  policy_id: string | null; policy_version: string | null; arm: ArmId | null;
  entry: { tx: string | null; opened_at: number; sol_spent_lamports: string | null; tokens_raw: string | null; fill_source: 'tx_meta' | 'quote_dry_run' | 'unverified' };
  original_tokens: string; tokens: string; basis_sol_per_token: number | null; peak_multiple: number; legs_done: string[];
  leg_attempts: Record<string, number>; last_quote: { sol: number; src: 'onchain' | 'jupiter' | 'engine_gmgn'; at: number } | null; lockouts: string[];
  ata: { address: string; program: 'token' | 'token2022' } | null }
export interface BuyFill { solSpentLamports: string; tokensRaw: string; feeLamports: string; confirmedAt: number }
export interface SellFill { solOutNetLamports: string; solOutGrossLamports: string; tokensSoldRaw: string; feeLamports: string; confirmedAt: number }
export interface FillReader { buyFill(sig: string, owner: string, mint: string): Promise<BuyFill | 'unverified'>; sellFill(sig: string, owner: string, mint: string): Promise<SellFill | 'unverified'> }
export interface Valuation { quote(pos: PositionV2, protectiveOnly: boolean): Promise<{ sol: number; src: 'onchain' | 'jupiter' | 'engine_gmgn'; at: number } | null> }
export interface CloseAccountApi { closeIfEmpty(owner: string, mint: string): Promise<{ status: 'closed' | 'skipped' | 'failed'; tx: string | null; rentLamports: string | null; reason: string | null }> }
/** Strict, mint-bound verification incl. a simulation before signing (B40 rule 4; plan grind #71). Fails closed. */
export interface TxVerifier { verify(txBase64: string, ctx: { owner: string; mint: string; side: 'buy' | 'sell'; tokenProgram: 'token' | 'token2022';
  maxLamportsOut: bigint; tokensIn: bigint | null /* sell only */; maxFeeLamports: bigint; maxTipLamports: bigint }): Promise<{ ok: true } | { ok: false; reason: string }> }
