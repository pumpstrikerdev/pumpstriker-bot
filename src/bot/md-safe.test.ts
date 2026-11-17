/**
 * Unit tests for Markdown-injection-safe names (2026-09-29, threat T3).
 * mdSafe must strip `* _ \` [ ]`, control characters and over-long input so a
 * token name can never break a parse_mode: 'Markdown' card; isEntityParseError
 * must recognise Telegram's "can't parse entities" refusal so notify() can
 * fall back to plain text.
 */
import { describe, expect, it } from 'vitest';
import { TelegramError } from 'telegraf';
import { mdSafe, isEntityParseError } from './md-safe';

const UNSAFE = /[*_`[\]\\\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

describe('mdSafe — Markdown entity characters', () => {
  it('strips * _ backtick [ ]', () => {
    expect(mdSafe('*MOON*')).toBe('MOON');
    expect(mdSafe('base_token')).toBe('basetoken');
    expect(mdSafe('[V2] Pepe')).toBe('V2 Pepe');
    expect(mdSafe('`rm -rf`')).toBe('rm -rf');
    expect(mdSafe('*_`[]*_`[]')).toBe('');
  });

  it('strips a link-injection attempt down to plain text', () => {
    expect(mdSafe('[Claim airdrop](https://evil.example)')).toBe('Claim airdrop(https://evil.example)');
  });

  it('strips the backslash (a trailing one would escape the next entity marker)', () => {
    expect(mdSafe('foo\\')).toBe('foo');
    expect(mdSafe('a\\*b')).toBe('ab');
  });

  it('keeps ordinary punctuation, emoji and non-Latin text', () => {
    expect(mdSafe("Dog's Hat-Coin (SOL) $WIF 100%")).toBe("Dog's Hat-Coin (SOL) $WIF 100%");
    expect(mdSafe('🚀 Rocket 🐸')).toBe('🚀 Rocket 🐸');
    expect(mdSafe('ペペ 狗币')).toBe('ペペ 狗币');
    expect(mdSafe('👨‍👩‍👧 Family')).toBe('👨‍👩‍👧 Family'); // ZWJ sequence intact
  });
});

describe('mdSafe — control characters and whitespace', () => {
  it('removes C0/C1 control characters and DEL', () => {
    expect(mdSafe('A\u0000B\u0007C\u001BD\u007FE\u009BF')).toBe('ABCDEF');
  });

  it('turns line breaks and tabs into single spaces', () => {
    expect(mdSafe('foo\nbar\tbaz\r\nqux')).toBe('foo bar baz qux');
    expect(mdSafe('line\u2028sep\u2029para\u0085nel')).toBe('line sep para nel');
  });

  it('removes bidi controls (RLO spoofing)', () => {
    expect(mdSafe('abc\u202Egpj.exe')).toBe('abcgpj.exe');
    expect(mdSafe('\u2066x\u2069\u200Ey\u200F')).toBe('xy');
  });

  it('removes lone surrogates but keeps valid pairs', () => {
    expect(mdSafe('a\uD83Db')).toBe('ab');
    expect(mdSafe('a\uDE80b')).toBe('ab');
    expect(mdSafe('a🚀b')).toBe('a🚀b');
  });

  it('collapses whitespace runs and trims', () => {
    expect(mdSafe('   a    b   ')).toBe('a b');
    expect(mdSafe('a _ b')).toBe('a b'); // removal must not leave a double space
    expect(mdSafe('\u00A0 x \u3000')).toBe('x');
    expect(mdSafe('   ')).toBe('');
  });
});

describe('mdSafe — length cap', () => {
  it('caps at 64 by default', () => {
    expect(mdSafe('x'.repeat(200))).toBe('x'.repeat(64));
    expect(mdSafe('y'.repeat(64))).toBe('y'.repeat(64));
  });

  it('honours a custom maxLen (wallet rename uses 20)', () => {
    expect(mdSafe('My Very Long Wallet Name Here', 20)).toBe('My Very Long Wallet');
    expect(mdSafe('abcdefghijklmnopqrstuvwxyz', 20)).toHaveLength(20);
  });

  it('counts code points, never splitting an emoji', () => {
    const out = mdSafe('🚀'.repeat(30), 5);
    expect(out).toBe('🚀🚀🚀🚀🚀');
    expect(Array.from(out)).toHaveLength(5);
  });

  it('applies the cap after cleaning and trims a trailing space', () => {
    expect(mdSafe('**ab**cd', 4)).toBe('abcd');
    expect(mdSafe('abcd efgh', 5)).toBe('abcd');
  });

  it('maxLen 0 gives an empty string; NaN / negative fall back to the default', () => {
    expect(mdSafe('abc', 0)).toBe('');
    expect(mdSafe('z'.repeat(100), Number.NaN)).toHaveLength(64);
    expect(mdSafe('z'.repeat(100), -5)).toHaveLength(64);
    expect(mdSafe('z'.repeat(100), 10.9)).toHaveLength(10);
  });
});

describe('mdSafe — input types', () => {
  it('null / undefined → empty string', () => {
    expect(mdSafe(null)).toBe('');
    expect(mdSafe(undefined)).toBe('');
  });

  it('stringifies primitives', () => {
    expect(mdSafe(42)).toBe('42');
    expect(mdSafe(10n)).toBe('10');
    expect(mdSafe(true)).toBe('true');
  });

  it('non-primitives become empty and never throw', () => {
    const hostile = { toString() { throw new Error('boom'); } };
    expect(mdSafe({})).toBe('');
    expect(mdSafe(['*a*'])).toBe('');
    expect(mdSafe(hostile)).toBe('');
    expect(mdSafe(Symbol('x'))).toBe('');
    expect(mdSafe(() => 'x')).toBe('');
  });
});

describe('mdSafe — properties', () => {
  // Deterministic PRNG so the run is reproducible.
  let seed = 0x5eed;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ALPHABET = ['a', 'Z', '9', ' ', '*', '_', '`', '[', ']', '\\', '\n', '\t', '\u0000', '\u007F',
    '\u202E', '\uD83D', '\uDE80', '🚀', 'ペ', '(', ')', '$', "'", '\u00A0'];
  const randomName = () => {
    const n = Math.floor(rnd() * 90);
    let s = '';
    for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
    return s;
  };
  const samples = Array.from({ length: 300 }, randomName);

  it('output never contains an entity character, control character or bidi control', () => {
    for (const s of samples) expect(mdSafe(s)).not.toMatch(UNSAFE);
  });

  it('output is trimmed, has no double spaces and respects the cap', () => {
    for (const s of samples) {
      const out = mdSafe(s, 20);
      expect(out).toBe(out.trim());
      expect(out).not.toMatch(/\s{2}/);
      expect(Array.from(out).length).toBeLessThanOrEqual(20);
    }
  });

  it('is idempotent', () => {
    for (const s of samples) {
      const once = mdSafe(s);
      expect(mdSafe(once)).toBe(once);
    }
  });

  it('a cleaned name interpolated into a Markdown template adds no entity markers', () => {
    const tpl = (name: string) => `🪙 *${name}* — \`CA\` [chart](https://dexscreener.com)`;
    const markers = (t: string) => (t.match(/[*_`[\]]/g) ?? []).length;
    for (const s of samples) expect(markers(tpl(mdSafe(s)))).toBe(markers(tpl('')));
  });
});

describe('isEntityParseError', () => {
  const PARSE_DESC = "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 12";

  it('recognises a telegraf TelegramError', () => {
    const e = new TelegramError({ error_code: 400, description: PARSE_DESC });
    expect(isEntityParseError(e)).toBe(true);
  });

  it('recognises message, description or response.description alone', () => {
    expect(isEntityParseError(new Error(`400: ${PARSE_DESC}`))).toBe(true);
    expect(isEntityParseError({ description: PARSE_DESC })).toBe(true);
    expect(isEntityParseError({ response: { description: PARSE_DESC } })).toBe(true);
  });

  it('accepts a plain string, case-insensitively', () => {
    expect(isEntityParseError("Bad Request: can't parse entities")).toBe(true);
    expect(isEntityParseError("CAN'T PARSE ENTITIES")).toBe(true);
  });

  it('rejects other Telegram errors', () => {
    expect(isEntityParseError(new TelegramError({ error_code: 400, description: 'Bad Request: message is too long' }))).toBe(false);
    expect(isEntityParseError(new TelegramError({ error_code: 403, description: 'Forbidden: bot was blocked by the user' }))).toBe(false);
    expect(isEntityParseError(new TelegramError({ error_code: 429, description: 'Too Many Requests: retry after 5' }))).toBe(false);
    expect(isEntityParseError(new Error('fetch failed'))).toBe(false);
  });

  it('rejects non-errors and never throws', () => {
    const hostile = Object.defineProperty({}, 'message', { get() { throw new Error('boom'); } });
    for (const v of [null, undefined, 0, 42, true, {}, [], '', Symbol('x'), hostile]) {
      expect(isEntityParseError(v)).toBe(false);
    }
  });
});
