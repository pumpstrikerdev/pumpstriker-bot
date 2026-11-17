// R1-B1 (B10 section 3 rule 3): the bot's card builders. A thin layer over the shared C03 renderer (src/shared/card/render-signal.ts): it
// fixes the render options (lateMs = TG_LATE_MS 30000, maxChars 4096) and returns a CardText that can be RENDERED AGAIN at the moment the
// send queue really sends it, so the LATE banner and the ages in the card are measured at send time, not at enqueue time (the queue may
// hold a card back for pacing or a 429). The TgQueue contract takes a plain CardText; BotCard is a CardText with one extra function, so
// every producer can hand it over without changing the frozen interface.
import { renderAlert, renderCancel, renderOps, renderSignal, type SignalCardExtras } from '../shared/card/render-signal';
import type { CardText, RenderOpts } from '../shared/common/card-types';
import type { ExitAlert, OpsAlert, SignalCancel, SignalNew } from '../shared/contract/v1';

/** TG_LATE_MS: a signal card sent later than this after the decision carries the LATE banner and is reported late:true. */
export const TG_LATE_MS = 30_000;
/** Telegram's message limit. */
export const CARD_MAX_CHARS = 4096;

/** One inline keyboard button (Telegram's callback_data is at most 64 bytes; buttons that would exceed it are never built). */
export interface InlineButton { text: string; callback_data: string }
export type InlineRow = InlineButton[];

export interface BotCard extends CardText {
  /** The same card rendered for a send that starts at `sentAt` (epoch ms). */
  rerender?: (sentAt: number) => CardText;
  /** A-115: the inline keyboard sent with the card (the signal card's buy row and skills row). The queue forwards it as reply_markup. */
  buttons?: InlineRow[];
}

export function cardOpts(lateMs: number = TG_LATE_MS): RenderOpts {
  return { lateMs, maxChars: CARD_MAX_CHARS };
}

/** True when a card whose decision was at `decidedAt` is sent at `sentAt` more than `lateMs` after it (the same rule as the LATE banner). */
export function isLate(decidedAt: number | null, sentAt: number, lateMs: number = TG_LATE_MS): boolean {
  return decidedAt !== null && sentAt - decidedAt > lateMs;
}

function lazy(render: (sentAt: number) => CardText, now: number): BotCard {
  const first = render(now);
  return { text: first.text, parseMode: first.parseMode, rerender: render };
}

/** The signal card (C03 renderSignal, A-115 layout). `now` is the enqueue time; the queue re-renders at the real send time. `extras` (the
 *  playbook, the links, the auto-buy line) are computed ONCE at enqueue and passed unchanged to every re-render, so a preset edited while
 *  the card waits in the queue never changes what the card says; the buttons are fixed at enqueue too. */
export function signalCard(sig: SignalNew, ca: string, now: number, lateMs: number = TG_LATE_MS, extras?: SignalCardExtras, buttons?: InlineRow[]): BotCard {
  const opts = cardOpts(lateMs);
  const card = lazy(sentAt => renderSignal(sig, ca, sentAt, opts, extras), now);
  const rows = (buttons ?? []).map(r => r.filter(b => Buffer.byteLength(b.callback_data, 'utf8') <= 64 && b.text !== '')).filter(r => r.length > 0);
  return rows.length > 0 ? { ...card, buttons: rows } : card;
}

export function cancelCard(c: SignalCancel, ca: string, symbol: string | null, now: number, lateMs: number = TG_LATE_MS): BotCard {
  const opts = cardOpts(lateMs);
  return lazy(sentAt => renderCancel(c, ca, symbol, sentAt, opts), now);
}

export function alertCard(a: ExitAlert, ca: string, symbol: string | null, now: number, lateMs: number = TG_LATE_MS): BotCard {
  const opts = cardOpts(lateMs);
  return lazy(sentAt => renderAlert(a, ca, symbol, sentAt, opts), now);
}

/** The Engine health alarm for the owner's phone (C03 renderOps; plan grind #60). */
export function opsCard(a: OpsAlert, now: number, lateMs: number = TG_LATE_MS): BotCard {
  const opts = cardOpts(lateMs);
  return lazy(sentAt => renderOps(a, sentAt, opts), now);
}

/** Escape the four HTML characters Telegram's HTML parse mode cares about. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A one-line owner notice (auto-buy of a card that is not in the feed, Engine unreachable / back / restarted, a dead-lettered event). The
 *  text is plain; it is escaped here and cut to one message. */
export function noticeCard(text: string): BotCard {
  const safe = escapeHtml(text.replace(/\s+/g, ' ').trim());
  const cut = safe.length > CARD_MAX_CHARS ? safe.slice(0, CARD_MAX_CHARS - 1).replace(/&[#A-Za-z0-9]*$/, '') + '…' : safe;
  return { text: cut, parseMode: 'HTML' };
}
