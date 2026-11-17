/**
 * Update-level access control (2026-09-29, security hardening T4).
 *
 * The bot is a single-operator trading console: it must answer ONLY the owner
 * (TG_CHAT_ID), ONLY in the owner's private chat with the bot, and ONLY for
 * new messages and inline-button presses. Everything else — edited messages,
 * channel posts, inline queries, chat-member changes, group traffic, other
 * users — is dropped before any handler runs, so the bot stops answering in
 * groups and an edited or forged update can never reach a command/callback.
 *
 * Wiring (bot.ts):
 *   bot.use((ctx, next) => isAllowedUpdate(ctx.update, OWNER_ID) ? next() : undefined);
 *   bot.launch({ dropPendingUpdates: true, allowedUpdates: [...ALLOWED_UPDATES] });
 *
 * The gate fails CLOSED: an empty owner id, a missing sender/chat, or an update
 * whose shape can't be classified is refused.
 */

/** The only update types the bot asks Telegram for and the only ones the gate lets through. */
export const ALLOWED_UPDATES = ['message', 'callback_query'] as const;
export type AllowedUpdateType = typeof ALLOWED_UPDATES[number];

/**
 * REBUILD-CHOSEN: Telegram caps callback_data at 64 bytes, so a legitimate
 * button can never carry more. Anything longer, empty, or missing (game /
 * inline-mode callbacks, which this bot never creates) is treated as forged.
 */
export const MAX_CALLBACK_DATA_BYTES = 64;

/** Same comparison as the old `isOwner` (`String(ctx.from?.id) === OWNER_ID`), but a missing id never matches. */
function sameId(id: unknown, ownerId: string): boolean {
  if (typeof id !== 'number' && typeof id !== 'string') return false;
  if (id === '') return false;
  return String(id) === ownerId;
}

/**
 * The update's payload type, mirroring telegraf's `ctx.updateType` (the
 * object-valued key next to `update_id`). REBUILD-CHOSEN: stricter than
 * telegraf — exactly ONE payload key is required, so a malformed update that
 * carries e.g. both `message` and `edited_message` is refused, not guessed.
 */
function payloadType(update: any): string | null {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
  const keys = Object.keys(update).filter(k => update[k] !== null && typeof update[k] === 'object');
  return keys.length === 1 ? keys[0] : null;
}

/**
 * True when the raw Telegram update may reach the bot's handlers.
 *  - message:        private chat, sent by the owner, in the owner's own chat
 *  - callback_query: pressed by the owner on a message in a private chat
 *  - anything else (edited_message, channel_post, inline_query, my_chat_member, …): false
 */
export function isAllowedUpdate(update: any, ownerId: string): boolean {
  try {
    if (typeof ownerId !== 'string' || ownerId === '') return false;
    const type = payloadType(update);

    if (type === 'message') {
      const msg = update.message;
      return msg.chat?.type === 'private'
        && sameId(msg.from?.id, ownerId)
        && sameId(msg.chat?.id, ownerId);
    }

    if (type === 'callback_query') {
      const cq = update.callback_query;
      const chat = cq.message?.chat;   // absent for inline-mode buttons → refused
      if (!(sameId(cq.from?.id, ownerId) && chat?.type === 'private')) return false;
      // REBUILD-CHOSEN: defence in depth — in a private chat only its user can press a
      // button, so chat.id must also be the owner (also true for InaccessibleMessage).
      if (!sameId(chat.id, ownerId)) return false;
      const data = cq.data;
      return typeof data === 'string'
        && data.length > 0
        && Buffer.byteLength(data, 'utf8') <= MAX_CALLBACK_DATA_BYTES;
    }

    return false;
  } catch {
    return false;   // never let a weird update shape crash the middleware chain
  }
}

/**
 * True when a message was forwarded from somewhere else. Helper for user
 * decision #8 (refuse forwarded messages in the address / import prompts) —
 * NOT enforced by the gate: the owner forwarding a CA to the bot stays allowed.
 * Covers the current `forward_origin` and the legacy `forward_*` fields.
 */
export function isForwarded(msg: any): boolean {
  if (!msg || typeof msg !== 'object') return false;
  return msg.forward_origin != null
    || msg.forward_from != null
    || msg.forward_from_chat != null
    || msg.forward_sender_name != null
    || msg.forward_date != null;
}
