// R1-B1 (B10): test helpers shared by the link, intake and Telegram tests. Not a test file (vitest does not collect it) and not imported by
// any production module. Fake Telegram, an in-memory Engine outbox, a scripted Engine ingress (an HttpFn, so no socket is opened), fixture
// loading and temp folders. Everything here is deterministic under a FakeClock; ids and keys are generated at runtime (planner amendment A-20).
import bs58 from 'bs58';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AutoBuyApi, AutoBuyDecision, BotOutbox, BuyExecution, ExitApi } from '../bot-contracts';
import type { ArmsStatusPayload, BotToEngineEvent, BotToEngineType, SignalCancel } from '../shared/contract/v1';
import type { TelegramApi, TelegramSendExtra } from '../tg/send-queue';
import { FakeClock } from './clock';
import type { HttpFn, HttpRequest, HttpResponse } from './common';
import { HttpError } from './common';
import { createUlidFactory } from './ulid';

export const FIXTURE_DIR = path.resolve(__dirname, '..', '..', 'test-fixtures', 'link');

/** A fresh deep copy of a fixture (test-fixtures/link/<name>.json). */
export function fixture<T = any>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')) as T;
}

/** The validator clock of every fixture. */
export const FIXTURE_NOW: number = (fixture<{ now: number }>('meta')).now;

const testUlid = createUlidFactory(() => FIXTURE_NOW);
/** A fresh ULID (event ids of test events are generated, never typed). */
export function newTestUlid(): string { return testUlid(); }

/** A fresh base58 token address (43 or 44 chars, from random bytes). */
export function newCa(): string { return bs58.encode(crypto.randomBytes(32)); }

/** A copy of an Engine event with its own event id, signal id and (when it has one) CA. */
export function freshEvent<T extends { event_id: string; signal_id: string | null; ca: string | null }>(ev: T, ca: string | null = ev.ca === null ? null : newCa()): T {
  return {
    ...ev,
    event_id: newTestUlid(),
    signal_id: ev.signal_id === null ? null : `dec_${crypto.randomBytes(12).toString('hex').slice(0, 25)}`,
    ca,
  };
}

const tempDirs: string[] = [];
export function tempDir(prefix = 'ps-b1-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
export function cleanupTempDirs(): void {
  for (const d of tempDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** A clock whose now() moves one millisecond on every read, so two reads never tie: ordering is then checkable with plain stamps. */
export class TickClock extends FakeClock {
  private reads = 0;
  override now(): number { return super.now() + this.reads++; }
}

/** The Engine outbox of the intake and send-queue tests: keeps the events in memory, in order. */
export class MemoryOutbox implements BotOutbox {
  readonly events: BotToEngineEvent[] = [];
  constructor(private readonly onAppend?: (ev: BotToEngineEvent) => void) {}
  append(ev: BotToEngineEvent): void { this.events.push(ev); this.onAppend?.(ev); }
  backlog(): number { return this.events.length; }
  deadLettered(): { count: number; lastCode: string | null } { return { count: 0, lastCode: null }; }
  of<T extends BotToEngineType>(type: T): Array<Extract<BotToEngineEvent, { type: T }>> {
    return this.events.filter((e): e is Extract<BotToEngineEvent, { type: T }> => e.type === type);
  }
}

/** A Telegraf-shaped 429. */
export function telegram429(retryAfterS: number): Error {
  const description = `Too Many Requests: retry after ${retryAfterS}`;
  return Object.assign(new Error(`429: ${description}`), {
    response: { ok: false, error_code: 429, description, parameters: { retry_after: retryAfterS } },
    code: 429,
  });
}

export type TelegramScript = 'ok' | { error: unknown };
export interface TelegramCall { chatId: string | number; text: string; extra: TelegramSendExtra; at: number; messageId: number | null }

/** Fake `bot.telegram`: records every sendMessage; `script` is consumed one entry per call ('ok' when empty). */
export class FakeTelegram implements TelegramApi {
  readonly calls: TelegramCall[] = [];
  readonly script: TelegramScript[] = [];
  private nextMessageId = 700;
  constructor(private readonly clock: { now(): number }, private readonly onCall?: (c: TelegramCall) => void) {}
  async sendMessage(chatId: string | number, text: string, extra: TelegramSendExtra): Promise<{ message_id: number }> {
    const step = this.script.shift() ?? 'ok';
    const call: TelegramCall = { chatId, text, extra, at: this.clock.now(), messageId: null };
    this.calls.push(call);
    this.onCall?.(call);
    if (step !== 'ok') throw step.error;
    call.messageId = this.nextMessageId++;
    return { message_id: call.messageId };
  }
}

/** Stub auto-buy (B20): the decision and the execution are scripted per test. */
export class StubAutoBuy implements AutoBuyApi {
  decision: AutoBuyDecision = { action: 'skip', reason: 'off', arm: null, forceDryRun: false };
  execution: () => Promise<BuyExecution>;
  readonly decideCalls: Array<{ eventId: string; receivedAt: number; now: number }> = [];
  readonly executeCalls: string[] = [];
  readonly armsStatus: ArmsStatusPayload[] = [];
  constructor(private readonly clock: { now(): number }) {
    this.execution = async () => ({
      status: 'submitted', tx: 'tx-stub-submitted', error: null, route: 'pf-direct', solInLamports: '50000000', quoteTokensOut: '1666666000000',
      stamps: { decidedAt: this.clock.now(), signedAt: this.clock.now(), submittedAt: this.clock.now() },
    });
  }
  decide(_sig: unknown, env: { event_id: string }, receivedAt: number, now: number): AutoBuyDecision {
    this.decideCalls.push({ eventId: env.event_id, receivedAt, now });
    return this.decision;
  }
  execute(_sig: unknown, env: { event_id: string }): Promise<BuyExecution> {
    this.executeCalls.push(env.event_id);
    return this.execution();
  }
  onArmsStatus(p: ArmsStatusPayload): void { this.armsStatus.push(p); }
}

/** Stub exits (B30): sells only for CAs in `positions`, like the real ExitApi. */
export class StubExits implements ExitApi {
  readonly positions = new Set<string>();
  readonly cancelCalls: Array<{ ca: string; signalId: string; kills: string[] }> = [];
  readonly sells: string[] = [];
  async cancel(ca: string, signalId: string, c: SignalCancel): Promise<'executed' | 'no_position'> {
    this.cancelCalls.push({ ca, signalId, kills: c.kills });
    if (!this.positions.has(ca)) return 'no_position';
    this.sells.push(ca);
    return 'executed';
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// scripted Engine ingress (an HttpFn)
// ---------------------------------------------------------------------------------------------------------------------------------

export interface EnginePost { ids: string[]; types: string[]; bytes: number; status: number }

/**
 * The Engine side of POST /api/bot/v1/events as the bot's outbox sees it. Accepted events are recorded in `accepted` (one entry per
 * delivery, so a duplicate delivery shows up as a repeated id). Behaviour switches:
 *   up = false          every request fails like a refused connection
 *   status = N          every request answers N with `{ ok:false, code, reason }` (401 / 503 ...)
 *   poison(id) -> mode  an event the Engine refuses: 'index400' answers the whole batch 400 naming the event index, 'plain400' answers 400
 *                       without an index, 'results202' answers 202 with a per-event reject, 'status500' answers 500
 *   maxBytes            a body larger than this answers 413
 */
export class FakeEngine {
  up = true;
  status: number | null = null;
  maxBytes: number | null = null;
  /** Event batches answer 503 while heartbeats are still accepted (a blocked outbox with a live heartbeat). */
  blockEventBatches = false;
  readonly poison = new Map<string, 'index400' | 'plain400' | 'results202' | 'status500'>();
  readonly accepted: string[] = [];
  readonly heartbeats: Array<Record<string, any>> = [];
  readonly posts: EnginePost[] = [];
  readonly bodies: string[] = [];

  readonly http: HttpFn = async (req: HttpRequest): Promise<HttpResponse> => {
    if (!this.up) throw new HttpError('network', 'connect ECONNREFUSED');
    if (req.method !== 'POST') return { status: 404, body: '{"ok":false,"code":"invalid","reason":"not found"}' };
    this.bodies.push(req.body ?? '');
    if (this.status !== null) {
      this.posts.push({ ids: [], types: [], bytes: Buffer.byteLength(req.body ?? ''), status: this.status });
      return { status: this.status, body: JSON.stringify({ ok: false, code: 'auth', reason: 'scripted' }) };
    }
    const bytes = Buffer.byteLength(req.body ?? '');
    const events = (JSON.parse(req.body ?? '{"events":[]}') as { events: Array<{ event_id: string; type: string }> }).events;
    const record = (status: number): void => { this.posts.push({ ids: events.map(e => e.event_id), types: events.map(e => e.type), bytes, status }); };
    if (this.maxBytes !== null && bytes > this.maxBytes) {
      record(413);
      return { status: 413, body: JSON.stringify({ ok: false, code: 'too_large', reason: 'body too large' }) };
    }
    if (events.length === 1 && events[0].type === 'bot.heartbeat') {
      this.heartbeats.push(events[0]);
      record(202);
      return { status: 202, body: JSON.stringify({ ok: true, results: [{ ok: true, event_id: events[0].event_id, duplicate: false, received_at: 0 }] }) };
    }
    if (this.blockEventBatches) {
      record(503);
      return { status: 503, body: JSON.stringify({ ok: false, code: 'auth', reason: 'blocked' }) };
    }
    const poisoned = events.findIndex(e => this.poison.has(e.event_id));
    if (poisoned >= 0) {
      const mode = this.poison.get(events[poisoned].event_id);
      if (mode === 'index400') {
        record(400);
        return { status: 400, body: JSON.stringify({ ok: false, code: 'invalid', reason: `event ${poisoned}: payload.leg is not a known leg` }) };
      }
      if (mode === 'plain400') {
        record(400);
        return { status: 400, body: JSON.stringify({ ok: false, code: 'invalid', reason: 'a payload is invalid' }) };
      }
      if (mode === 'status500') {
        record(500);
        return { status: 500, body: '{"ok":false,"code":"invalid","reason":"internal error"}' };
      }
    }
    const results = events.map((e, index) => {
      if (this.poison.get(e.event_id) === 'results202') return { ok: false, event_id: e.event_id, index, code: 'invalid', reason: 'payload is invalid' };
      this.accepted.push(e.event_id);
      return { ok: true, event_id: e.event_id, duplicate: false, received_at: 0 };
    });
    record(202);
    return { status: 202, body: JSON.stringify({ ok: true, results }) };
  };
}
