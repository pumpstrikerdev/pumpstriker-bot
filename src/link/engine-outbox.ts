// R1-B1 (B10 section 3 rule 4; plan grind #64, #66): the bot -> Engine channel.
//
// Every bot-to-Engine event is appended to <data>/engine-outbox.jsonl (fsync) BEFORE the side effect is reported locally. append() first
// redacts the free-text fields with the bot's full redactSecrets (keypair check, byte arrays, seed phrases) and then caps them the way the
// Engine's validator will, so what is on disk is what the Engine will see and a secret never reaches the disk (plan grind #64).
//
// A flusher posts batches every 500 ms to POST {ENGINE_URL}/api/bot/v1/events with the link headers. A batch holds at most 50 events AND at
// most 24 KB serialized. The offset file (<data>/engine-outbox.offset) records how far the Engine has acknowledged, so the outbox survives
// a restart; the Engine dedups on event_id, so a resend after a crash is harmless.
//
// Poison events (plan grind #66). One bad event must never block the channel:
//   202                  per-event results: an Ack advances past the event; a per-event reject (invalid / transition / unknown_signal)
//                        dead-letters it; an event without a result stays pending
//   400 / 409 + index    (the reason names the event) that event is dead-lettered and the rest of the batch is resent at once
//   400 without index    the batch is halved until the bad event is alone, then it is dead-lettered (409 without an index is a contract
//                        version problem of the whole link: backoff and one owner alert, never dead-lettering)
//   413                  the batch is halved and retried; a single event that is still too large is dead-lettered
//   500                  backoff 5 attempts, then the head event is dead-lettered
//   401/403/503/network  backoff 0.5 s doubling up to 30 s, forever, nothing is dead-lettered
// A dead-lettered event is appended (fsync) to <data>/engine-outbox.dead.jsonl with its code and reason, counted, and the owner gets ONE
// alert per code per hour.
//
// bot.heartbeat does NOT go through the outbox: a separate POST of one event every 15 s, no retry, no offset. It carries the outbox backlog
// and the dead-letter counters, and it keeps arriving while the outbox is blocked or backing off. A-110 (R8-RDB1): the optional bot_username, bot_wallet and
// rpc_provider come from the heartbeat source like the other fields; sanitizeHeartbeat sends one the Engine's validator would refuse as null.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BotOutbox } from '../bot-contracts';
import { redactSecrets } from '../lib/redact';
import type { BotToEngineEvent, Heartbeat } from '../shared/contract/v1';
import { mdSafe, validateBotBatch } from '../shared/contract/validate';
import { linkHeaders } from '../shared/link-auth';
import { appendDurable, writeFileAtomicSync } from './atomic-file';
import type { Clock, TimerHandle } from './clock';
import { buildEnvelope, defaultHttp, defaultLog, errMessage, isRecord, isTimeout, parseJson, trimBase, type HttpFn, type HttpResponse, type LinkLog } from './common';

export const OUTBOX_FILE = 'engine-outbox.jsonl';
export const OUTBOX_OFFSET_FILE = 'engine-outbox.offset';
export const OUTBOX_DEAD_FILE = 'engine-outbox.dead.jsonl';
export const FLUSH_TICK_MS = 500;
export const BATCH_MAX_EVENTS = 50;
export const BATCH_MAX_BYTES = 24 * 1024;
export const HEARTBEAT_MS = 15_000;
export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 30_000;
export const MAX_500_ATTEMPTS = 5;
export const OWNER_ALERT_PER_CODE_MS = 3_600_000;
const POST_TIMEOUT_MS = 3_000;
const BATCH_ENVELOPE_BYTES = 14;   // {"events":[]}

/** The heartbeat fields the outbox cannot know (auto-buy state, caps, positions, rpc); it adds at, contract_v, backlog and the dead-letter counters. */
export type HeartbeatFields = Omit<Heartbeat, 'at' | 'contract_v' | 'outbox_backlog' | 'dead_lettered' | 'dead_last_code'>;

export interface EngineOutboxDeps {
  /** B\data */
  dir: string;
  /** ENGINE_URL, e.g. http://127.0.0.1:<engine port> */
  engineUrl: string;
  secret: () => string;
  clock: Clock;
  /** A fresh ULID per call (createUlidFactory). Used for the heartbeat event ids. */
  newEventId: () => string;
  http?: HttpFn;
  /** Receives the one-line owner alerts (dead-lettered events, contract version problems). Wire it to the send queue's ops lane. */
  notifyOwner?: (text: string) => void;
  /** Source of the heartbeat fields; null/undefined = no heartbeat. */
  heartbeat?: () => HeartbeatFields | null;
  tickMs?: number;
  maxBatchEvents?: number;
  maxBatchBytes?: number;
  heartbeatMs?: number;
  postTimeoutMs?: number;
  log?: LinkLog;
}

export interface EngineOutbox extends BotOutbox {
  start(): void;
  stop(): Promise<void>;
  /** Runs flush cycles until nothing is pending or the Engine stops answering; returns the backlog left. For shutdown and tests. */
  flushNow(): Promise<number>;
  sendHeartbeat(): Promise<void>;
  setNotifier(fn: ((text: string) => void) | null): void;
}

interface Entry { ev: BotToEngineEvent; json: string; bytes: number; endOffset: number; done: boolean }

function cleanText(s: string | null | undefined, max: number): string | null {
  if (s === null || s === undefined) return null;
  const out = mdSafe(redactSecrets(s), max);   // redaction FIRST, then the cap (plan grind #64)
  return out === '' ? null : out;
}

/** A copy of the event whose free-text fields are redacted and capped (DeliveryTg.error, DeliveryBuy.error, ExitLegV1.error 200;
 *  ContractViolation.detail 300). Idempotent: the Engine's validator applies the same transform. */
export function sanitizeEvent<E extends BotToEngineEvent>(ev: E): E {
  switch (ev.type) {
    case 'delivery.tg':
    case 'delivery.buy':
    case 'exit.leg':
      return { ...ev, payload: { ...ev.payload, error: cleanText(ev.payload.error, 200) } } as E;
    case 'bot.contract_violation':
      return { ...ev, payload: { ...ev.payload, detail: cleanText(ev.payload.detail, 300) ?? '' } } as E;
    default:
      return ev;
  }
}

/**
 * A-110 (R8-RDB1): the three optional heartbeat keys (bot_username, bot_wallet, rpc_provider) are checked with the Engine's own validator before the
 * heartbeat leaves the bot. A value it would refuse (an rpc_provider that is a URL or holds key material, a bad address or lamports string, a bad
 * username) is sent as null, so a malformed or secret-shaped value never reaches the wire and the Engine never counts a contract violation for it.
 * A heartbeat the validator refuses for another reason, or one with nothing to null, is returned unchanged. Pure; never throws.
 */
export function sanitizeHeartbeat(hb: Heartbeat, eventId: string, now: number): { hb: Heartbeat; nulled: string[] } {
  try {
    const probe = validateBotBatch({ events: [buildEnvelope('bot.heartbeat', hb, { eventId, signalId: null, ca: null, now })] }, now);
    const result = probe.ok ? probe.events[0]?.result : undefined;
    if (result === undefined || !result.ok || result.warnings === undefined || result.warnings.length === 0) return { hb, nulled: [] };
    const out: Heartbeat = { ...hb };
    const nulled: string[] = [];
    for (const k of result.warnings) {
      if (k === 'bot_username' || k === 'bot_wallet' || k === 'rpc_provider') { out[k] = null; nulled.push(k); }
    }
    return { hb: out, nulled };
  } catch {
    return { hb, nulled: [] };
  }
}

/** The index of the offending event named in a 400/409 reason ("event 3: ...", "event #3", "events[3]", "index 3"), or null. A bare "[3]" is
 *  not an index: the Engine's own 409 text ends in "supported:[1]". */
export function indexFromReason(reason: unknown, batchSize: number): number | null {
  if (typeof reason !== 'string') return null;
  const m = /\bindex\s*[:=#]?\s*(\d{1,3})\b/i.exec(reason) ?? /\bevents?\s*[[#:=]?\s*(\d{1,3})\b/i.exec(reason);
  if (m === null) return null;
  const i = Number(m[1]);
  return Number.isInteger(i) && i >= 0 && i < batchSize ? i : null;
}

export function createEngineOutbox(deps: EngineOutboxDeps): EngineOutbox {
  const { clock } = deps;
  const log = deps.log ?? defaultLog;
  const http = deps.http ?? defaultHttp;
  const tickMs = deps.tickMs ?? FLUSH_TICK_MS;
  const maxEvents = deps.maxBatchEvents ?? BATCH_MAX_EVENTS;
  const maxBytes = deps.maxBatchBytes ?? BATCH_MAX_BYTES;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const postTimeoutMs = deps.postTimeoutMs ?? POST_TIMEOUT_MS;
  const url = `${trimBase(deps.engineUrl)}/api/bot/v1/events`;
  const outboxFile = path.join(deps.dir, OUTBOX_FILE);
  const offsetFile = path.join(deps.dir, OUTBOX_OFFSET_FILE);
  const deadFile = path.join(deps.dir, OUTBOX_DEAD_FILE);
  let notifier: ((text: string) => void) | null = deps.notifyOwner ?? null;

  const queue: Entry[] = [];
  let fileSize = 0;
  let ackOffset = 0;
  const dead: { count: number; lastCode: string | null } = { count: 0, lastCode: null };
  let failures = 0;                         // consecutive failed attempts (drives the backoff)
  let splitMax: number | null = null;       // a halved batch size while a poison or oversized event is being isolated
  let head500: { id: string | null; n: number } = { id: null, n: 0 };
  let loggedDown = false;
  const alertedAt = new Map<string, number>();

  // -------------------------------------------------------------------------------------------------------------------------------
  // files
  // -------------------------------------------------------------------------------------------------------------------------------

  function persistOffset(): void {
    try {
      writeFileAtomicSync(offsetFile, String(ackOffset));
    } catch (e) {
      log(`engine-outbox: could not write the offset file (${errMessage(e)}); events may be resent after a restart`, 'warn');
    }
  }

  function loadDeadCounters(): void {
    try {
      const text = fs.readFileSync(deadFile, 'utf8');
      const lines = text.split('\n').filter(l => l.trim() !== '');
      dead.count = lines.length;
      for (let i = lines.length - 1; i >= 0; i--) {
        const rec = parseJson(lines[i]);
        if (isRecord(rec) && typeof rec.code === 'string') { dead.lastCode = rec.code; break; }
      }
    } catch {
      /* no dead-letter file yet */
    }
  }

  function load(): void {
    fs.mkdirSync(deps.dir, { recursive: true });
    let size = 0;
    try { size = fs.statSync(outboxFile).size; } catch { size = 0; }
    let offset = 0;
    try {
      const n = Number(fs.readFileSync(offsetFile, 'utf8').trim());
      if (Number.isInteger(n) && n >= 0) offset = n;
    } catch {
      offset = 0;
    }
    let clamped = false;
    if (offset > size) { offset = size; clamped = true; }   // the file was truncated after the last offset write
    ackOffset = offset;
    fileSize = size;
    if (size > offset) {
      const buf = Buffer.alloc(size - offset);
      const fd = fs.openSync(outboxFile, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
      const lastNl = buf.lastIndexOf(0x0a);
      const complete = lastNl + 1;                          // bytes that end in a newline
      if (complete < buf.length) {                          // a torn write at the tail: drop it so the next append starts on a line
        try { fs.truncateSync(outboxFile, offset + complete); fileSize = offset + complete; } catch { /* the tail stays; it is skipped below */ }
      }
      let pos = 0;
      while (pos < complete) {
        const nl = buf.indexOf(0x0a, pos);
        const lineBytes = nl - pos + 1;
        const text = buf.subarray(pos, nl).toString('utf8');
        pos += lineBytes;
        const parsed = parseJson(text);
        if (isRecord(parsed) && typeof parsed.type === 'string' && typeof parsed.event_id === 'string') {
          queue.push({ ev: parsed as unknown as BotToEngineEvent, json: text, bytes: lineBytes - 1, endOffset: offset + pos, done: false });
        } else {
          writeDead({ at: clock.now(), code: 'corrupt', reason: 'unreadable line in the outbox file', raw: text.slice(0, 500) });
          if (queue.length === 0) ackOffset = offset + pos;   // only a leading corrupt line moves the acknowledged offset
        }
      }
    }
    loadDeadCounters();   // counts the dead-letter file, including any 'corrupt' lines written just above
    if (queue.length === 0 && fileSize > 0) {
      // nothing is pending: every byte of the file is acknowledged (or was an unreadable line), so start a fresh file
      try { fs.truncateSync(outboxFile, 0); fileSize = 0; ackOffset = 0; } catch { ackOffset = fileSize; }
      persistOffset();
    } else if (clamped) {
      persistOffset();
    }
  }

  function writeDead(rec: Record<string, unknown>): void {
    try {
      appendDurable(deadFile, JSON.stringify(rec) + '\n');
    } catch (e) {
      log(`engine-outbox: could not write the dead-letter file (${errMessage(e)})`, 'err');
    }
  }

  // -------------------------------------------------------------------------------------------------------------------------------
  // append / backlog
  // -------------------------------------------------------------------------------------------------------------------------------

  function backlog(): number {
    let n = 0;
    for (const e of queue) if (!e.done) n++;
    return n;
  }

  function append(ev: BotToEngineEvent): void {
    const safe = sanitizeEvent(ev);
    const json = JSON.stringify(safe);
    const line = json + '\n';
    let written = Buffer.byteLength(line);
    try {
      written = appendDurable(outboxFile, line);
    } catch (e) {
      // the event is still delivered from memory; only a crash before the next flush would lose it
      log(`engine-outbox: could not write the outbox file (${errMessage(e)})`, 'err');
      written = 0;
    }
    fileSize += written;
    queue.push({ ev: safe, json, bytes: Buffer.byteLength(json), endOffset: fileSize, done: false });
  }

  // -------------------------------------------------------------------------------------------------------------------------------
  // owner alerts and dead letters
  // -------------------------------------------------------------------------------------------------------------------------------

  function alertOwner(key: string, text: string): void {
    const now = clock.now();
    const last = alertedAt.get(key);
    if (last !== undefined && now - last < OWNER_ALERT_PER_CODE_MS) return;
    alertedAt.set(key, now);
    if (notifier === null) return;
    try { notifier(text); } catch (e) { log(`engine-outbox: owner alert failed (${errMessage(e)})`, 'warn'); }
  }

  function deadLetter(entry: Entry, code: string, reason: string): void {
    const why = cleanText(reason, 300) ?? '';
    writeDead({ at: clock.now(), code, reason: why, event: entry.ev });
    entry.done = true;
    dead.count++;
    dead.lastCode = code;
    log(`engine-outbox: dead-lettered ${entry.ev.type} ${entry.ev.event_id} (${code})`, 'warn');
    alertOwner(code, `Engine link: a ${entry.ev.type} event was refused by the Engine (${code}) and moved to the dead-letter file.${why !== '' ? ` ${why.slice(0, 120)}` : ''}`);
  }

  /** Drops the acknowledged prefix of the queue, advances the offset and, when nothing is left, truncates the file. */
  function settle(): void {
    let moved = false;
    while (queue.length > 0 && queue[0].done) {
      ackOffset = queue[0].endOffset;
      queue.shift();
      moved = true;
    }
    if (!moved) return;
    if (queue.length === 0 && fileSize > 0) {
      try {
        fs.truncateSync(outboxFile, 0);
        fileSize = 0;
        ackOffset = 0;
      } catch {
        ackOffset = fileSize;   // could not truncate: everything in the file is acknowledged
      }
    }
    persistOffset();
  }

  // -------------------------------------------------------------------------------------------------------------------------------
  // one flush attempt
  // -------------------------------------------------------------------------------------------------------------------------------

  function pickBatch(): Entry[] {
    const cap = Math.max(1, Math.min(maxEvents, splitMax ?? Number.POSITIVE_INFINITY));
    const out: Entry[] = [];
    let bytes = BATCH_ENVELOPE_BYTES;
    for (const e of queue) {
      if (e.done) continue;
      if (out.length >= cap) break;
      const add = e.bytes + (out.length > 0 ? 1 : 0);
      if (out.length > 0 && bytes + add > maxBytes) break;
      out.push(e);
      bytes += add;
    }
    return out;
  }

  function backoffDelay(n: number): number {
    return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, n - 1));
  }

  function fail(kind: string): number {
    failures++;
    if (!loggedDown) {
      loggedDown = true;
      log(`engine-outbox: the Engine did not take the events (${kind}); retrying with backoff, ${backlog()} pending`, 'warn');
    }
    return backoffDelay(failures);
  }

  function succeed(): void {
    failures = 0;
    head500 = { id: null, n: 0 };
    if (loggedDown) { loggedDown = false; log('engine-outbox: the Engine takes events again', 'ok'); }
  }

  function afterProgress(): number {
    return backlog() > 0 ? 0 : tickMs;
  }

  function handleAccepted(batch: Entry[], json: unknown): number {
    const results = isRecord(json) && Array.isArray(json.results) ? json.results : null;
    let progressed = 0;
    if (results === null) {
      for (const e of batch) { e.done = true; progressed++; }   // a plain 202: the Engine took the whole batch
    } else {
      const byId = new Map<string, Record<string, unknown>>();
      for (const r of results) if (isRecord(r) && typeof r.event_id === 'string') byId.set(r.event_id, r);
      batch.forEach((e, i) => {
        const r = byId.get(e.ev.event_id) ?? (isRecord(results[i]) && results[i].event_id === undefined ? (results[i] as Record<string, unknown>) : undefined);
        if (r === undefined) return;                             // no result for this event: it stays pending and is sent again
        if (r.ok === false) {
          deadLetter(e, typeof r.code === 'string' ? r.code : 'rejected', typeof r.reason === 'string' ? r.reason : 'refused by the Engine');
        } else {
          e.done = true;
        }
        progressed++;
      });
    }
    settle();
    splitMax = null;
    if (progressed === 0) return fail('202 without results');
    succeed();
    return afterProgress();
  }

  function handleRefused(batch: Entry[], res: HttpResponse, json: unknown): number {
    const status = res.status;
    const reason = isRecord(json) && typeof json.reason === 'string' ? json.reason : '';
    const code = isRecord(json) && typeof json.code === 'string' ? json.code : (status === 409 ? 'contract_version' : 'invalid');
    const idx = indexFromReason(reason, batch.length);
    if (idx !== null) {
      deadLetter(batch[idx], code, reason);
      settle();
      succeed();
      return 0;                                                  // resend the rest of the batch at once
    }
    if (status === 409) {
      alertOwner('contract_version', 'Engine link: the Engine refuses the bot events with a contract version conflict (409). Nothing is dropped; the bot keeps retrying.');
      return fail('409');
    }
    if (batch.length === 1) {
      deadLetter(batch[0], code, reason);
      settle();
      succeed();
      return 0;
    }
    splitMax = Math.ceil(batch.length / 2);                      // isolate the poison event by halving the batch
    return 0;
  }

  async function cycleOnce(): Promise<number> {
    const batch = pickBatch();
    if (batch.length === 0) return tickMs;
    const headers = linkHeaders(deps.secret());
    if (headers === null) return fail('link secret not configured');
    const body = `{"events":[${batch.map(e => e.json).join(',')}]}`;
    let res: HttpResponse;
    try {
      res = await http({ method: 'POST', url, headers, body, timeoutMs: postTimeoutMs });
    } catch (e) {
      return fail(isTimeout(e) ? 'timeout' : 'network');
    }
    const json = parseJson(res.body);
    if (res.status === 202 || res.status === 200) return handleAccepted(batch, json);
    if (res.status === 400 || res.status === 409) return handleRefused(batch, res, json);
    if (res.status === 413) {
      if (batch.length > 1) { splitMax = Math.ceil(batch.length / 2); return 0; }
      deadLetter(batch[0], 'too_large', 'the Engine refused a single event as too large');
      settle();
      succeed();
      return 0;
    }
    if (res.status === 500) {
      const head = batch[0];
      head500 = head500.id === head.ev.event_id ? { id: head.ev.event_id, n: head500.n + 1 } : { id: head.ev.event_id, n: 1 };
      if (head500.n >= MAX_500_ATTEMPTS) {
        deadLetter(head, 'engine_500', 'the Engine answered 500 five times for this event');
        head500 = { id: null, n: 0 };
        settle();
        return 0;
      }
      failures = head500.n - 1;                                  // fail() counts this attempt: 0.5 s after the first, doubling
      return fail('500');
    }
    return fail(`http ${res.status}`);                           // 401 / 403 / 503 / anything else: the link, not the event
  }

  // -------------------------------------------------------------------------------------------------------------------------------
  // loops
  // -------------------------------------------------------------------------------------------------------------------------------

  let started = false;
  let flushTimer: TimerHandle | null = null;
  let hbTimer: TimerHandle | null = null;
  let cycling: Promise<number> | null = null;
  let hbRunning: Promise<void> | null = null;

  function runCycle(): Promise<number> {
    if (cycling !== null) return cycling;
    const p = cycleOnce().catch((e: unknown) => {
      log(`engine-outbox: flush cycle failed (${errMessage(e)})`, 'err');
      return fail('internal');
    }).finally(() => { cycling = null; });
    cycling = p;
    return p;
  }

  function armFlush(ms: number): void {
    if (!started) return;
    flushTimer = clock.setTimeout(() => {
      flushTimer = null;
      void runCycle().then(next => { armFlush(next); });
    }, ms);
  }

  async function sendHeartbeat(): Promise<void> {
    const fields = deps.heartbeat?.() ?? null;
    if (fields === null) return;
    const headers = linkHeaders(deps.secret());
    if (headers === null) return;
    const now = clock.now();
    const eventId = deps.newEventId();
    const built: Heartbeat = { at: now, contract_v: 1, ...fields, outbox_backlog: backlog(), dead_lettered: dead.count, dead_last_code: dead.lastCode };
    const { hb, nulled } = sanitizeHeartbeat(built, eventId, now);   // A-110: no malformed or secret-shaped optional field leaves the bot
    if (nulled.length > 0) log(`engine-outbox: heartbeat field(s) refused by the contract and sent as null: ${nulled.join(', ')}`, 'debug');
    const env = buildEnvelope('bot.heartbeat', hb, { eventId, signalId: null, ca: null, now });
    try {
      await http({ method: 'POST', url, headers, body: JSON.stringify({ events: [env] }), timeoutMs: postTimeoutMs });   // no retry, no offset
    } catch (e) {
      log(`engine-outbox: heartbeat not delivered (${isTimeout(e) ? 'timeout' : 'network'})`, 'debug');
    }
  }

  function armHeartbeat(ms: number): void {
    if (!started) return;
    hbTimer = clock.setTimeout(() => {
      hbTimer = null;
      hbRunning = sendHeartbeat().catch(() => undefined).finally(() => { hbRunning = null; armHeartbeat(heartbeatMs); });
    }, ms);
  }

  load();

  return {
    append,
    backlog,
    deadLettered: () => ({ count: dead.count, lastCode: dead.lastCode }),
    setNotifier(fn: ((text: string) => void) | null): void { notifier = fn; },
    sendHeartbeat,
    start(): void {
      if (started) return;
      started = true;
      armFlush(tickMs);
      if (deps.heartbeat !== undefined) armHeartbeat(0);
    },
    async stop(): Promise<void> {
      started = false;
      if (flushTimer !== null) { clock.clearTimeout(flushTimer); flushTimer = null; }
      if (hbTimer !== null) { clock.clearTimeout(hbTimer); hbTimer = null; }
      if (cycling !== null) await cycling.catch(() => undefined);
      if (hbRunning !== null) await hbRunning;
    },
    async flushNow(): Promise<number> {
      for (let i = 0; i < 200 && backlog() > 0; i++) {
        const next = await runCycle();
        if (next > 0 && failures > 0) break;                     // the Engine is not answering: leave the rest for the backoff loop
      }
      return backlog();
    },
  };
}
