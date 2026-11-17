// R1-B1 (B10 section 3 rule 3): the Telegram send queue, the only writer of signal / cancel / alert / ops cards.
//
//   - Cards are rendered through cards.ts (C03). A BotCard is rendered again at the moment of the real send, so the LATE banner and the ages
//     in the card are measured at send time even when the queue held the card back; `late` is the same rule (send start - decision > TG_LATE_MS).
//   - Pacing: at most TG_PACE_MAX_PER_10MIN (8) signal cards in any 10 minutes. The rest WAIT; nothing is ever dropped. Cancel and alert
//     cards are not paced, and kind 'ops' (the owner's private chat: Engine alarms, dead-man notices, the one-line "auto-bought, not in your
//     feed" notice) bypasses the pacing and the tgMinGrade filter (the filter itself lives in intake). Order: ops, cancel, alert, signal;
//     first come first served inside a kind.
//   - Telegram 429: the queue honours retry_after (reports retrying_429 once per card) and pauses; the bot's buys never wait for it because
//     enqueue() returns at once and nothing in the buy path awaits the queue.
//   - Result: delivery.tg { status: sent (message_id) | failed (Telegram's reason, redacted, <= 200 chars) | retrying_429,
//     latency_ms_from_decision, late } appended to the Engine outbox. A failure other than 429 is reported once.
//   - A-93f: kind 'ops' and 'cancel' (one-shot owner alerts, the guaranteed CANCEL card) treat a TRANSIENT error (HTTP >= 500, a FetchError,
//     ECONNRESET / ETIMEDOUT / socket hang up ...) like a 429 of their own: the card stays queued and is retried with a backoff (2 s doubling
//     to 60 s) for up to TRANSIENT_RETRY_TTL_MS, then reported failed. A definitive 4xx fails at once; signal and alert cards keep the rule
//     above.
import type { BotOutbox, TgQueue } from '../bot-contracts';
import type { Clock, TimerHandle } from '../link/clock';
import { buildEnvelope, defaultLog, errMessage, isRecord, type LinkLog } from '../link/common';
import { redactSecrets } from '../lib/redact';
import type { DeliveryTg } from '../shared/contract/v1';
import { mdSafe } from '../shared/contract/validate';
import type { CardText } from '../shared/common/card-types';
import { isLate, noticeCard, TG_LATE_MS, type BotCard } from './cards';

export const TG_PACE_MAX_PER_10MIN = 8;
export const TG_PACE_WINDOW_MS = 600_000;
const DEFAULT_RETRY_AFTER_S = 5;
/** A-93f: the retry window and the backoff of a transient failure of an ops or cancel card. */
export const TRANSIENT_RETRY_TTL_MS = 3_600_000;
export const TRANSIENT_BACKOFF_MIN_MS = 2_000;
export const TRANSIENT_BACKOFF_MAX_MS = 60_000;
const TRANSIENT_RE = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EPIPE|socket hang up|network timeout|fetcherror/i;
const KIND_ORDER = ['ops', 'cancel', 'alert', 'signal'] as const;

export type TgMeta = Parameters<TgQueue['enqueue']>[1];

/** The one method of Telegraf's `bot.telegram` the queue needs; tests supply a fake. */
export interface TelegramSendExtra {
  parse_mode: 'HTML';
  link_preview_options: { is_disabled: boolean };
  reply_parameters?: { message_id: number; allow_sending_without_reply: boolean };
  /** A-115: the inline keyboard of a card (BotCard.buttons). */
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}
export interface TelegramApi {
  sendMessage(chatId: string | number, text: string, extra: TelegramSendExtra): Promise<{ message_id: number }>;
}

export interface SendQueueDeps {
  clock: Clock;
  telegram: TelegramApi;
  /** TG_CHAT_ID: signal, cancel and alert cards. */
  chatId: string | number;
  /** The owner's private chat for kind 'ops'; defaults to chatId. */
  ownerChatId?: string | number;
  outbox: BotOutbox;
  /** A fresh ULID per call (createUlidFactory). */
  newEventId: () => string;
  paceMaxPer10Min?: number;
  paceWindowMs?: number;
  lateMs?: number;
  log?: LinkLog;
}

export interface SendQueue extends TgQueue {
  /** Cards waiting or being sent. */
  pending(): number;
  /** A one-line message to the owner through the ops lane. */
  notifyOwner(text: string): void;
}

/** What a thrown Telegram error means for the queue: a 429 with its retry_after (seconds), or a plain failure with a short message. */
export function classifyTelegramError(e: unknown): { retryAfterS: number | null; message: string; transient: boolean } {
  const o = isRecord(e) ? e : {};
  const resp = isRecord(o.response) ? o.response : {};
  const params = isRecord(o.parameters) ? o.parameters : isRecord(resp.parameters) ? resp.parameters : {};
  const code = [o.code, resp.error_code, o.error_code].find(c => typeof c === 'number');
  const description = typeof resp.description === 'string' ? resp.description : errMessage(e);
  const raw = params.retry_after;
  if (typeof raw === 'number' && Number.isFinite(raw)) return { retryAfterS: Math.max(1, Math.ceil(raw)), message: description, transient: true };
  if (code === 429) {
    const m = /retry after (\d+)/i.exec(description);
    return { retryAfterS: m !== null ? Math.max(1, Number(m[1])) : DEFAULT_RETRY_AFTER_S, message: description, transient: true };
  }
  // A-93f: a 5xx or a network-level failure says nothing about the card; a 4xx (bad request, blocked, not found) is definitive
  const name = typeof o.name === 'string' ? o.name : e instanceof Error ? e.name : '';
  const errno = typeof o.code === 'string' ? o.code : '';
  const transient = (typeof code === 'number' && code >= 500) || (typeof code !== 'number' && TRANSIENT_RE.test(`${name} ${errno} ${description}`));
  return { retryAfterS: null, message: description, transient };
}

interface Item {
  card: BotCard; meta: TgMeta; inFlight: boolean; reported429: boolean;
  /** A-93f: an ops or cancel card waiting out a transient failure is not sent before this time; its first failure; failures so far. */
  retryAt: number; firstFailAt: number | null; fails: number;
}

export function createSendQueue(deps: SendQueueDeps): SendQueue {
  const { clock } = deps;
  const log = deps.log ?? defaultLog;
  const paceMax = deps.paceMaxPer10Min ?? TG_PACE_MAX_PER_10MIN;
  const paceWindow = deps.paceWindowMs ?? TG_PACE_WINDOW_MS;
  const lateMs = deps.lateMs ?? TG_LATE_MS;

  const items: Item[] = [];
  const signalSentAt: number[] = [];       // send start times of the signal cards sent inside the pacing window
  let pausedUntil = 0;                      // Telegram's retry_after, as a clock time
  let pumping = false;
  let wake: { handle: TimerHandle; at: number } | null = null;

  function prunePace(now: number): void {
    while (signalSentAt.length > 0 && now - signalSentAt[0] >= paceWindow) signalSentAt.shift();
  }

  function paceAllows(now: number): boolean {
    prunePace(now);
    return signalSentAt.length < paceMax;
  }

  function pick(now: number): Item | null {
    for (const kind of KIND_ORDER) {
      if (kind === 'signal' && !paceAllows(now)) continue;
      const hit = items.find(i => !i.inFlight && i.meta.kind === kind && i.retryAt <= now);
      if (hit !== undefined) return hit;
    }
    return null;
  }

  function armWake(at: number): void {
    if (wake !== null) {
      if (wake.at <= at) return;
      clock.clearTimeout(wake.handle);
      wake = null;
    }
    const handle = clock.setTimeout(() => { wake = null; void pump(); }, Math.max(0, at - clock.now()));
    wake = { handle, at };
  }

  function report(item: Item, status: DeliveryTg['status'], o: { messageId?: number | null; error?: string | null; late?: boolean }): void {
    const now = clock.now();
    const m = item.meta;
    // Telegram's reason, redacted, at most 200 chars (the Engine outbox does the same again before it writes the line)
    const error = o.error === undefined || o.error === null ? null : (mdSafe(redactSecrets(o.error), 200) || null);
    const payload: DeliveryTg = {
      status, message_id: o.messageId ?? null, error, at: now,
      latency_ms_from_decision: m.decidedAt === null ? null : Math.max(0, now - m.decidedAt),
      late: o.late === true, kind: m.kind, leg: m.leg,
    };
    try {
      deps.outbox.append(buildEnvelope('delivery.tg', payload, {
        eventId: deps.newEventId(), signalId: m.kind === 'ops' ? null : m.signalId, ca: m.ca, now,
      }));
    } catch (e) {
      log(`send-queue: could not record the delivery (${errMessage(e)})`, 'err');
    }
  }

  async function sendOne(item: Item): Promise<void> {
    item.inFlight = true;
    const sentAt = clock.now();                                  // the stamp of the banner, of `late` and of pacing
    let card: CardText = item.card;
    try {
      if (item.card.rerender !== undefined) card = item.card.rerender(sentAt);
    } catch (e) {
      log(`send-queue: could not render the card again (${errMessage(e)}); sending it as first rendered`, 'warn');
    }
    const extra: TelegramSendExtra = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
    if (item.meta.replyTo !== null) extra.reply_parameters = { message_id: item.meta.replyTo, allow_sending_without_reply: true };
    if (item.card.buttons !== undefined && item.card.buttons.length > 0) extra.reply_markup = { inline_keyboard: item.card.buttons.map(r => r.map(b => ({ text: b.text, callback_data: b.callback_data }))) };
    const chat = item.meta.kind === 'ops' ? (deps.ownerChatId ?? deps.chatId) : deps.chatId;
    try {
      const msg = await deps.telegram.sendMessage(chat, card.text, extra);
      items.splice(items.indexOf(item), 1);
      if (item.meta.kind === 'signal') signalSentAt.push(sentAt);
      report(item, 'sent', { messageId: typeof msg?.message_id === 'number' ? msg.message_id : null, late: isLate(item.meta.decidedAt, sentAt, lateMs) });
    } catch (e) {
      const c = classifyTelegramError(e);
      if (c.retryAfterS !== null) {
        pausedUntil = clock.now() + c.retryAfterS * 1000;
        item.inFlight = false;                                   // the card stays in the queue and goes again after the pause
        if (!item.reported429) {
          item.reported429 = true;
          report(item, 'retrying_429', { error: `Telegram asked to wait ${c.retryAfterS} s` });
        }
        log(`send-queue: Telegram rate limit, retrying in ${c.retryAfterS} s`, 'warn');
      } else if (c.transient && (item.meta.kind === 'ops' || item.meta.kind === 'cancel')
        && (item.firstFailAt === null || clock.now() - item.firstFailAt < TRANSIENT_RETRY_TTL_MS)) {
        // A-93f: one-shot owner alerts and the guaranteed CANCEL card are kept and tried again after a backoff
        const now = clock.now();
        if (item.firstFailAt === null) item.firstFailAt = now;
        item.fails += 1;
        const wait = Math.min(TRANSIENT_BACKOFF_MAX_MS, TRANSIENT_BACKOFF_MIN_MS * 2 ** Math.min(item.fails - 1, 10));
        item.retryAt = now + wait;
        item.inFlight = false;
        log(`send-queue: ${item.meta.kind} card not sent (${c.message.slice(0, 120)}); retrying in ${Math.round(wait / 1000)} s`, 'warn');
      } else {
        items.splice(items.indexOf(item), 1);
        log(`send-queue: send failed (${c.message.slice(0, 120)})`, 'warn');
        report(item, 'failed', { error: c.message });
      }
    }
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const now = clock.now();
        if (now < pausedUntil) { armWake(pausedUntil); return; }
        const next = pick(now);
        if (next === null) {
          const waiting = items.some(i => !i.inFlight && i.meta.kind === 'signal');
          if (waiting && signalSentAt.length > 0) armWake(signalSentAt[0] + paceWindow);
          const backoffs = items.filter(i => !i.inFlight && i.retryAt > now).map(i => i.retryAt);
          if (backoffs.length > 0) armWake(Math.min(...backoffs));
          return;
        }
        await sendOne(next);
      }
    } catch (e) {
      log(`send-queue: pump failed (${errMessage(e)})`, 'err');
    } finally {
      pumping = false;
    }
  }

  const queue: SendQueue = {
    enqueue(card, meta): void {
      items.push({ card: card as BotCard, meta, inFlight: false, reported429: false, retryAt: 0, firstFailAt: null, fails: 0 });
      queueMicrotask(() => { void pump(); });
    },
    pending: () => items.length,
    notifyOwner(text: string): void {
      queue.enqueue(noticeCard(text), { kind: 'ops', signalId: null, ca: null, decidedAt: null, leg: null, grade: null, replyTo: null });
    },
  };
  return queue;
}
