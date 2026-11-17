/**
 * Unit tests for update-level access control (2026-09-29, security T4).
 * The gate must fail CLOSED: only the owner, only in the private chat, only
 * new messages and button presses. Fixture ids are fake.
 */
import { describe, expect, it } from 'vitest';
import type { Telegraf } from 'telegraf';
import { ALLOWED_UPDATES, MAX_CALLBACK_DATA_BYTES, isAllowedUpdate, isForwarded } from './access-control';

const OWNER = '111111111';
const OWNER_N = 111111111;
const STRANGER_N = 222222222;
const GROUP_N = -1001234567890;

const privateChat = (id = OWNER_N) => ({ id, type: 'private', first_name: 'Op' });
const groupChat = (type = 'supergroup') => ({ id: GROUP_N, type, title: 'Some group' });
const user = (id = OWNER_N) => ({ id, is_bot: false, first_name: 'Op' });

const msgUpdate = (over: Record<string, any> = {}) => ({
  update_id: 1,
  message: { message_id: 10, date: 1_759_000_000, chat: privateChat(), from: user(), text: '/start', ...over },
});
const cbUpdate = (over: Record<string, any> = {}, msgOver: Record<string, any> = {}) => ({
  update_id: 2,
  callback_query: {
    id: '42', chat_instance: '-77', from: user(), data: 'menu:main',
    message: { message_id: 11, date: 1_759_000_000, chat: privateChat(), text: 'menu', ...msgOver },
    ...over,
  },
});

describe('ALLOWED_UPDATES', () => {
  it('asks Telegram only for new messages and button presses', () => {
    expect([...ALLOWED_UPDATES]).toEqual(['message', 'callback_query']);
  });

  it('fits telegraf launch options (bot.launch({ allowedUpdates: [...ALLOWED_UPDATES] }))', () => {
    const allowedUpdates: Telegraf.LaunchOptions['allowedUpdates'] = [...ALLOWED_UPDATES];
    expect(allowedUpdates).toHaveLength(2);
  });
});

describe('isAllowedUpdate — messages', () => {
  it('allows the owner in the private chat', () => {
    expect(isAllowedUpdate(msgUpdate(), OWNER)).toBe(true);
    expect(isAllowedUpdate(msgUpdate({ text: 'just a CA' }), OWNER)).toBe(true);
  });

  it('refuses the owner in a group, supergroup or channel', () => {
    expect(isAllowedUpdate(msgUpdate({ chat: groupChat('group') }), OWNER)).toBe(false);
    expect(isAllowedUpdate(msgUpdate({ chat: groupChat('supergroup') }), OWNER)).toBe(false);
    expect(isAllowedUpdate(msgUpdate({ chat: groupChat('channel') }), OWNER)).toBe(false);
  });

  it('refuses a non-owner, even in their own private chat with the bot', () => {
    expect(isAllowedUpdate(msgUpdate({ from: user(STRANGER_N), chat: privateChat(STRANGER_N) }), OWNER)).toBe(false);
    expect(isAllowedUpdate(msgUpdate({ from: user(STRANGER_N) }), OWNER)).toBe(false);
  });

  it('refuses a private chat whose id is not the owner (chat.id must match too)', () => {
    expect(isAllowedUpdate(msgUpdate({ chat: privateChat(STRANGER_N) }), OWNER)).toBe(false);
  });

  it('refuses a message with no sender or no chat', () => {
    expect(isAllowedUpdate(msgUpdate({ from: undefined }), OWNER)).toBe(false);
    expect(isAllowedUpdate(msgUpdate({ chat: undefined }), OWNER)).toBe(false);
  });

  it('accepts string ids like the old String(from.id) === OWNER_ID check', () => {
    expect(isAllowedUpdate(msgUpdate({ from: { id: OWNER }, chat: { id: OWNER, type: 'private' } }), OWNER)).toBe(true);
  });
});

describe('isAllowedUpdate — other update types', () => {
  const ownerPrivateMsg = msgUpdate().message;

  it('refuses edited_message, channel_post, inline_query and friends', () => {
    const refused: Record<string, any>[] = [
      { update_id: 3, edited_message: { ...ownerPrivateMsg, edit_date: 1_759_000_100 } },
      { update_id: 4, channel_post: { message_id: 1, date: 1, chat: groupChat('channel'), text: 'x' } },
      { update_id: 5, edited_channel_post: { message_id: 1, date: 1, chat: groupChat('channel'), text: 'x' } },
      { update_id: 6, inline_query: { id: '1', from: user(), query: 'abc', offset: '' } },
      { update_id: 7, chosen_inline_result: { result_id: '1', from: user(), query: 'abc' } },
      { update_id: 8, my_chat_member: { chat: groupChat(), from: user(), date: 1 } },
      { update_id: 9, chat_member: { chat: groupChat(), from: user(), date: 1 } },
      { update_id: 10, chat_join_request: { chat: groupChat(), from: user(), date: 1 } },
      { update_id: 11, business_message: { ...ownerPrivateMsg } },
      { update_id: 12, poll_answer: { poll_id: '1', user: user(), option_ids: [0] } },
      { update_id: 13, message_reaction: { chat: privateChat(), user: user(), date: 1 } },
    ];
    for (const u of refused) expect(isAllowedUpdate(u, OWNER)).toBe(false);
  });

  it('refuses an update carrying more than one payload (no guessing which one counts)', () => {
    const u = { update_id: 14, message: ownerPrivateMsg, edited_message: ownerPrivateMsg };
    expect(isAllowedUpdate(u, OWNER)).toBe(false);
  });
});

describe('isAllowedUpdate — button presses (callback_query)', () => {
  it('allows the owner pressing a button in the private chat', () => {
    expect(isAllowedUpdate(cbUpdate(), OWNER)).toBe(true);
  });

  it('refuses a button pressed in a group', () => {
    expect(isAllowedUpdate(cbUpdate({}, { chat: groupChat() }), OWNER)).toBe(false);
  });

  it('refuses a button pressed by a non-owner', () => {
    expect(isAllowedUpdate(cbUpdate({ from: user(STRANGER_N) }), OWNER)).toBe(false);
    expect(isAllowedUpdate(cbUpdate({ from: user(STRANGER_N) }, { chat: privateChat(STRANGER_N) }), OWNER)).toBe(false);
  });

  it('refuses inline-mode buttons (no message attached)', () => {
    expect(isAllowedUpdate(cbUpdate({ message: undefined, inline_message_id: 'abc' }), OWNER)).toBe(false);
  });

  it('still allows a button on an old (inaccessible) private message', () => {
    expect(isAllowedUpdate(cbUpdate({ message: { message_id: 11, date: 0, chat: privateChat() } }), OWNER)).toBe(true);
  });

  it('refuses forged buttons: missing, empty, non-string or oversized callback data', () => {
    expect(isAllowedUpdate(cbUpdate({ data: undefined, game_short_name: 'g' }), OWNER)).toBe(false);
    expect(isAllowedUpdate(cbUpdate({ data: '' }), OWNER)).toBe(false);
    expect(isAllowedUpdate(cbUpdate({ data: 123 }), OWNER)).toBe(false);
    expect(isAllowedUpdate(cbUpdate({ data: 'x'.repeat(MAX_CALLBACK_DATA_BYTES) }), OWNER)).toBe(true);
    expect(isAllowedUpdate(cbUpdate({ data: 'x'.repeat(MAX_CALLBACK_DATA_BYTES + 1) }), OWNER)).toBe(false);
    // the cap is in bytes, not characters: 22 × '€' = 66 bytes
    expect(isAllowedUpdate(cbUpdate({ data: '€'.repeat(22) }), OWNER)).toBe(false);
  });
});

describe('isAllowedUpdate — fails closed', () => {
  it('refuses everything when the owner id is empty or not a string', () => {
    expect(isAllowedUpdate(msgUpdate(), '')).toBe(false);
    expect(isAllowedUpdate(cbUpdate(), '')).toBe(false);
    expect(isAllowedUpdate(msgUpdate(), undefined as any)).toBe(false);
    expect(isAllowedUpdate(msgUpdate(), OWNER_N as any)).toBe(false);
  });

  it('a sender without an id never matches an "undefined" owner id', () => {
    expect(isAllowedUpdate(msgUpdate({ from: {}, chat: { type: 'private' } }), 'undefined')).toBe(false);
  });

  it('never throws on garbage', () => {
    const throwing = { update_id: 1, get message(): any { throw new Error('boom'); } };
    for (const g of [null, undefined, 0, 'message', [], {}, { update_id: 1 }, { message: null }, throwing]) {
      expect(() => isAllowedUpdate(g, OWNER)).not.toThrow();
      expect(isAllowedUpdate(g, OWNER)).toBe(false);
    }
  });
});

describe('isForwarded', () => {
  it('detects current and legacy forward fields', () => {
    expect(isForwarded({ text: 'x', forward_origin: { type: 'user', date: 1, sender_user: user(STRANGER_N) } })).toBe(true);
    expect(isForwarded({ text: 'x', forward_from: user(STRANGER_N), forward_date: 1 })).toBe(true);
    expect(isForwarded({ text: 'x', forward_from_chat: groupChat('channel'), forward_date: 1 })).toBe(true);
    expect(isForwarded({ text: 'x', forward_sender_name: 'Hidden', forward_date: 1 })).toBe(true);
    expect(isForwarded({ text: 'x', forward_date: 1 })).toBe(true);
  });

  it('is false for ordinary messages and garbage', () => {
    expect(isForwarded(msgUpdate().message)).toBe(false);
    for (const g of [null, undefined, '', 'forward_date', 42]) expect(isForwarded(g)).toBe(false);
  });

  it('is only a helper: the gate still lets the owner forward a message to the bot (decision #8)', () => {
    const fwd = msgUpdate({ forward_origin: { type: 'channel', date: 1 }, forward_date: 1 });
    expect(isForwarded(fwd.message)).toBe(true);
    expect(isAllowedUpdate(fwd, OWNER)).toBe(true);
  });
});
