// R0-SHIMPL (round 0b; C02 section 3 rule 6, plan grind #64). Dependency-free secret redaction, the one body shared by the Engine
// and the TG Bot. Canonical source: R\shared\redact.ts; byte-identical copies live in Engine\src\shared\ and TG Bot\src\shared\ and
// are written only by R\scripts\sync-shared.ps1. Engine\src\lib\redact.ts re-exports redactSecrets from here.
// Amended by A-98 (R7-W3, round 7a): the UnclaimedSol API key (sent as `Authorization: Bearer <key>`, configured as UNCLAIMEDSOL_API_KEY) is masked in
// every serialization of that header, whatever characters the key holds (a ":" included), and in an env-style assignment of the key.
//
// This module names the providers whose keys it masks (RPC query keys, Alchemy and QuickNode path keys, the Telegram bot token) so a
// reader can see exactly what is covered. It masks keys, it never connects anywhere (guards G-S2 and G-S13 skip it by file name).
//
// Several provider URLs carry their key inside the URL itself (an RPC provider's query key, a `/v2/<key>` path, a `/<token>/` path),
// Telegram puts the bot token in `api.telegram.org/bot<token>/...`, and HTTP clients echo headers into error objects. That covers
// URL keys, bot tokens, Bearer/authorization values and API-key headers. A wallet secret key printed as a byte array (a JSON array of
// 32 or more small integers) is masked too. Wrap any such string with redactSecrets() before it reaches a log line, the dashboard
// SSE stream, an API response or a free-text field of a contract event.
//
// There is deliberately NO generic base58-length mask: it would hide transaction signatures, which the owner needs to see.
//
// Behaviour: case-insensitive where it matters, global, applied in order, never throws.

// 1. Telegram bot tokens: inside a /bot<id>:<secret> URL path, then bare.
const TG_TOKEN_IN_URL = /bot\d{6,12}:[A-Za-z0-9_-]{30,}/gi;
const TG_TOKEN_BARE = /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g;

// 2. Secrets passed as URL query parameters (RPC provider HTTP / WSS URLs).
const URL_QUERY_SECRET = /([?&](?:api[-_]?key|apikey|key|token|access_token|auth|x-token)=)[^&#\s"'<>]+/gi;

// 3. Alchemy keeps the key in the path: https://… or wss://…alchemy.com/v2/<key>
const ALCHEMY_PATH_KEY = /(alchemy\.com\/v2\/)[A-Za-z0-9_-]+/gi;

// 4. QuickNode keeps a token in the path: https://<name>.quiknode.pro/<token>/
//    (an RPC lane can be the QuickNode one), a node-fetch FetchError embeds the full URL;
//    so the token has to go before the message is logged.
const QUICKNODE_PATH_TOKEN = /(\.quiknode\.pro\/)[A-Za-z0-9_-]+/gi;

// 5. Header values. The GMGN (or any) API-key header value, however it is
//    serialized in a log: `<name>: <v>`, `'<name>':'<v>'`, `"<name>" => <v>`, etc.
//    Also x-token and authorization (with or without a Bearer prefix).
const HEADER_VALUE = /(["']?(?:x-api-?key|x-token|authorization)["']?\s*(?::|=>|=)\s*["']?)(?:Bearer\s+)?[^"',\s}]+/gi;
const BEARER_VALUE = /(Bearer\s+)[A-Za-z0-9._~+/=:-]{8,}/gi;   // ":" is part of the run since A-98 (an UnclaimedSol key may hold one)

// 5b. The UnclaimedSol key as an environment-style assignment (`UNCLAIMEDSOL_API_KEY=<key>`, also quoted or as `name: value`), e.g. in a config error.
//     The header form (`Authorization: Bearer <key>`) is covered by rule 5.
const UCS_KEY_ASSIGN = /(\bUNCLAIMEDSOL_API_KEY["']?\s*(?::|=>|=)\s*["']?)[^"',\s}]+/gi;

// 6. A wallet secret key printed as a byte array: `[12,200,7, ...]` with at least 32 entries (a 32-byte seed or a 64-byte keypair).
//    Shorter arrays are ordinary data and stay.
const BYTE_ARRAY = /\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*,?\s*\]/g;

/**
 * Strip secrets (RPC provider URL keys, API-key headers, Telegram bot tokens, Bearer/authorization header values, the UnclaimedSol key and byte-array
 * secret keys) from any value before it is logged. Never throws. Non-strings are String()-ed; null/undefined become ''.
 * Public addresses and transaction signatures are left untouched.
 */
export function redactSecrets(input: unknown): string {
  try {
    let s = String(input ?? '');
    s = s.replace(TG_TOKEN_IN_URL, 'bot<redacted>');
    s = s.replace(TG_TOKEN_BARE, '<tg-token>');
    s = s.replace(URL_QUERY_SECRET, '$1***');
    s = s.replace(ALCHEMY_PATH_KEY, '$1***');
    s = s.replace(QUICKNODE_PATH_TOKEN, '$1***');
    s = s.replace(HEADER_VALUE, '$1***');
    s = s.replace(BEARER_VALUE, '$1***');
    s = s.replace(UCS_KEY_ASSIGN, '$1***');
    s = s.replace(BYTE_ARRAY, '[<redacted-bytes>]');
    return s;
  } catch {
    return '<redaction failed>';
  }
}
