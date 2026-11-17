/**
 * Markdown-injection-safe names (2026-09-29, security hardening track B, threat T3).
 *
 * Token names and tickers come from outside the bot (the Engine's signal
 * events and token snapshots, the owner's wallet-rename text). Interpolated
 * raw into a `parse_mode: 'Markdown'` message, a name such as "*MOON*",
 * "base_token" or "[V2]" makes Telegram try to match entities and reject the
 * whole message with `400: Bad Request: can't parse entities` — the alert is
 * lost. Two defences:
 *
 *   1. mdSafe() cleans names/tickers when they ENTER the bot and again
 *      wherever they are interpolated into Markdown. It strips the legacy
 *      Markdown entity characters instead of escaping them, so the stored
 *      value is safe in plain text and in Markdown alike.
 *      Visible effect: names containing `*`, `_`, a backtick or square
 *      brackets show without those characters.
 *   2. isEntityParseError() lets notify() spot the remaining failures and
 *      resend the same text with no parse_mode.
 *
 * Pure: no imports, never throws.
 */

/**
 * Legacy-Markdown entity characters: * _ ` [ ] — plus the backslash.
 * REBUILD-CHOSEN: the backslash is also stripped. Outside an entity Telegram
 * treats `\*`, `\_`, `` \` `` and `\[` as escapes, so a name ending in `\`
 * would escape the template's next entity marker (e.g. `${name} *score*`)
 * and leave that entity unclosed → "can't parse entities".
 */
const MD_CHARS = /[*_`[\]\\]/g;

/** Line-breaking controls become a space so "foo\nbar" reads "foo bar", not "foobar". */
const BREAKING_WS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;

/** Every other C0/C1 control character and DEL is removed. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * REBUILD-CHOSEN: Unicode Bidi_Control characters (ALM, LRM, RLM, LRE/RLE/PDF/
 * LRO/RLO, LRI/RLI/FSI/PDI) are removed too — an RLO in a token name can
 * visually reverse the text that follows it in the card. ZWJ (U+200D) is kept
 * because emoji sequences rely on it.
 */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** REBUILD-CHOSEN: lone UTF-16 surrogates are removed (Telegram rejects text that is not valid UTF-8). */
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const DEFAULT_MAX_LEN = 64;

/** Telegram's "can't parse entities" family (Markdown / MarkdownV2 / HTML parse failures). */
const ENTITY_PARSE_RE = /can't parse entities/i;

function toText(s: unknown): string {
  if (typeof s === 'string') return s;
  // REBUILD-CHOSEN: only primitives are stringified; objects/arrays/functions/
  // symbols are garbage for a name and become '' instead of "[object Object]".
  if (typeof s === 'number' || typeof s === 'bigint' || typeof s === 'boolean') return String(s);
  return '';
}

/**
 * Clean a token name / ticker / wallet name for Telegram Markdown:
 * removes `* _ \` [ ]` (and `\`), control characters and bidi controls,
 * collapses whitespace runs to one space, trims, and caps the length at
 * `maxLen` code points (never splitting an emoji's surrogate pair).
 * null/undefined/non-primitive input → ''. Idempotent. Never throws.
 */
export function mdSafe(s: unknown, maxLen = DEFAULT_MAX_LEN): string {
  try {
    // REBUILD-CHOSEN: NaN / negative maxLen fall back to the default; fractions floor.
    const cap = typeof maxLen === 'number' && maxLen >= 0 ? Math.floor(maxLen) : DEFAULT_MAX_LEN;
    const cleaned = toText(s)
      .replace(BREAKING_WS, ' ')
      .replace(CONTROL_CHARS, '')
      .replace(BIDI_CONTROLS, '')
      .replace(LONE_SURROGATES, '')
      .replace(MD_CHARS, '')
      .replace(/\s+/g, ' ')
      .trim();
    const points = Array.from(cleaned);
    return points.length <= cap ? cleaned : points.slice(0, cap).join('').trimEnd();
  } catch {
    return '';
  }
}

/**
 * True when Telegram refused a message because its entities could not be
 * parsed (`400: Bad Request: can't parse entities: …`). Accepts a telegraf
 * TelegramError (message / description / response.description), a plain
 * Error, or a string. Never throws.
 */
export function isEntityParseError(e: unknown): boolean {
  try {
    if (typeof e === 'string') return ENTITY_PARSE_RE.test(e);
    if (!e || typeof e !== 'object') return false;
    const err = e as { message?: unknown; description?: unknown; response?: { description?: unknown } };
    for (const v of [err.message, err.description, err.response?.description]) {
      if (typeof v === 'string' && ENTITY_PARSE_RE.test(v)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
