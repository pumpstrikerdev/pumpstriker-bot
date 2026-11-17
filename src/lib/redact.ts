/**
 * ╔═══════════════════════════════════════════════════╗
 * ║  Secret redaction for logs and chat error replies ║
 * ╚═══════════════════════════════════════════════════╝
 *
 * A-129 (b), finding #23 (R9-FIX1): redactSecrets is the synced shared body (`../shared/redact`, written by scripts/sync-shared.ps1 from R\shared\redact.ts,
 * the one definition the Engine uses too) APPLIED FIRST, then only the masks the shared module does not have. The hand-copied rules this file held before
 * had drifted from the shared ones (no A-98 Bearer value with a ":" in it, no mask for a 32-byte seed array, no UnclaimedSol key assignment); calling the
 * shared function makes every future change of the shared rules reach the bot at once.
 *
 * Several provider URLs carry their key inside the URL itself, Telegram puts the bot token in `api.telegram.org/bot<token>/`, HTTP clients echo headers
 * into error objects, and the bot handles wallet private keys. Wrap any such string with redactSecrets() before it reaches a log line, the dashboard SSE
 * stream or a chat error reply. logger.ts log() is the one redaction point for every log line.
 *
 * What the shared body masks (all of it applies here): Telegram bot tokens inside a `/bot<token>/` URL path and bare (8-10 digits, 35 characters); URL query
 * keys (`api-key=`, `key=`, `token=`, ...); Alchemy `/v2/<key>` and QuickNode `.quiknode.pro/<key>/` path keys; API-key header values (`X-API-KEY`, `x-token`,
 * `authorization`) in any serialisation; `Bearer <x>` (":" included); the UnclaimedSol key assignment; and byte-array secret keys (JSON arrays of 32 or more
 * integers, marked `[<redacted-bytes>]`).
 *
 * What this file adds on top, because the bot holds wallet keys and the shared body deliberately has no such rule:
 *   (a) a WIDER bare Telegram token: 6-12 digits, ":" and 30 or more characters (the shared bare rule is 8-10 digits and exactly 35);
 *   (b) `key=` / `api-key=` / `api_key=` / `apikey=` outside a query string (e.g. `lastError: api-key=SECRET`);
 *   (c) base58 Solana secret keys: 80-90 chars that decode to 64 bytes whose last 32 bytes are the ed25519 public key of the first 32. The check is
 *       exact, so addresses and transaction signatures (also base58, but they fail the keypair check) are never masked;
 *   (d) seed phrases, via secret-guard's containsSeedPhrase().
 *
 * The keypair check and the seed-phrase heuristic live in bot/secret-guard.ts (one definition for both the chat guard and the logs); secret-guard does not
 * import this module, so there is no cycle. looksLikePrivateKey is re-exported here as the §3.3.2 API.
 *
 * Never throws: non-strings are String()-ed, null/undefined become ''.
 */

import { containsSeedPhrase, looksLikePrivateKey } from '../bot/secret-guard';
import { redactSecrets as redactShared } from '../shared/redact';

export { looksLikePrivateKey };

// (a) bare Telegram tokens the shared rule's 8-10 digits / exactly 35 characters does not reach: 6-12 digits, ":" and 30+ characters.
const TG_TOKEN_BARE = /(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/g;

// (b) REBUILD-CHOSEN: also mask `api-key=` / `api_key=` / `apikey=` / `key=` when they appear outside a query string (e.g. `lastError: api-key=SECRET`).
//     The look-behind keeps names such as `sortKey=` / `x-api-key=` out (the shared header mask handles `x-api-key=`).
const BARE_KEY_PARAM = /((?<![A-Za-z0-9_.-])(?:api[-_]?key|apikey|key)=)[^&#\s"'<>]+/gi;

// (c) base58 runs of 80–90 chars that are not part of a longer base58 run.
const B58_CANDIDATE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{80,90}(?![1-9A-HJ-NP-Za-km-z])/g;

// (d) REBUILD-CHOSEN: a log line is not a whole chat message, so secret-guard's
//     containsSeedPhrase() (the WHOLE text is 12/15/18/21/24 whitespace-separated
//     lowercase a–z words of 3–8 letters) is applied to every FIELD of the
//     string, and to each line of a multi-line field. A field is a maximal
//     stretch of letters, digits, `_`, `-` and whitespace, so punctuation,
//     quotes, brackets, `:` and `=` delimit it. `bad input: <phrase>`,
//     `"text":"<phrase>"` and a phrase on its own line are masked; a field
//     holding any other word (a capital, a digit, a shorter/longer word, an
//     extra lowercase word) is left alone, so ordinary sentences are not flagged.
const SEED_FIELD = /[A-Za-z0-9_\s-]+/g;
// 24 words of ≤ 8 letters fit in ~215 chars; anything far longer cannot be a
// phrase, so skip the word split (keeps huge log payloads cheap).
const SEED_CHUNK_MAX = 2048;

/** Replace a seed-phrase-only chunk, keeping its surrounding whitespace. */
function maskSeedChunk(chunk: string): string {
  if (chunk.length > SEED_CHUNK_MAX || !containsSeedPhrase(chunk)) return chunk;
  const lead = chunk.match(/^\s*/)![0];
  const trail = chunk.match(/\s*$/)![0];
  return lead + '<seed-phrase>' + trail;
}

function maskSeedField(field: string): string {
  const whole = maskSeedChunk(field);
  if (whole !== field || !/[\r\n]/.test(field)) return whole;
  return field.split(/(\r?\n|\r)/).map(maskSeedChunk).join('');
}

/**
 * Strip secrets (RPC provider keys, API-key header values, Telegram bot tokens, Bearer/authorization values, the UnclaimedSol key, Solana private keys as
 * base58 or as a byte array, and seed phrases) from any value before it is logged or shown in chat. The shared rules run first, then the bot-only ones
 * above. Idempotent. Never throws.
 */
export function redactSecrets(input: unknown): string {
  try {
    let s = redactShared(input);
    s = s.replace(TG_TOKEN_BARE, '<tg-token>');
    s = s.replace(BARE_KEY_PARAM, '$1***');
    s = s.replace(B58_CANDIDATE, m => (looksLikePrivateKey(m) ? '<private-key>' : m));
    s = s.replace(SEED_FIELD, maskSeedField);
    return s;
  } catch {
    return '<redaction failed>';
  }
}
