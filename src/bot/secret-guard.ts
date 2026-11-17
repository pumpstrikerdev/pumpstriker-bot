/**
 * Secret guard (2026-09-29, security hardening track B, threat T2d).
 *
 * A Solana private key or a wallet seed phrase pasted into the bot chat
 * outside the /import flow used to stay in the chat history forever. The
 * text handler now runs shouldDeleteForSecrets() BEFORE any other handling
 * (except while `sess.awaitingInput` starts with `w:import:`, where the
 * import path deletes the message itself) and, on a hit:
 *   - deletes the message (`ctx.deleteMessage().catch(() => {})`);
 *   - replies SECRET_GUARD_REPLY;
 *   - logs only SECRET_GUARD_LOG — never the text.
 *
 * What counts as a secret:
 *   - containsPrivateKey(): a base58 64-byte keypair secret (Phantom /
 *     Solflare export) that passes the exact keypair check — the last 32
 *     bytes are the ed25519 public key of the first 32 — or a 64-entry JSON
 *     byte array (the `solana-keygen` id.json format).
 *     The keypair check is exact, so a 44-char address or an 88-char
 *     transaction signature (also base58, signatures are 64 bytes too) is
 *     never flagged.
 *   - containsSeedPhrase(): CHOSEN heuristic without a BIP39 wordlist
 *     dependency — the WHOLE message is 12/15/18/21/24 whitespace-separated
 *     lowercase a–z words of 3–8 letters each (every BIP39 English word fits).
 *     Ordinary sentences are not flagged: punctuation, capitals, digits or
 *     a 1–2 letter word ("a", "to", "is") all break the match.
 *
 * Pure (no I/O), never throws.
 */
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';

/** CHOSEN reply text (WI-F §3.3.3). */
export const SECRET_GUARD_REPLY =
  '🔐 That looked like a private key or seed phrase — I deleted it. Use /import to add a wallet.';

/** The only line ever logged for a deleted message (WI-F §3.3.3). */
export const SECRET_GUARD_LOG = '[secret-guard] deleted a secret-looking message';

/** Bitcoin/Solana base58 alphabet (no 0, O, I, l). */
const B58 = '1-9A-HJ-NP-Za-km-z';

/** A 64-byte value base58-encodes to ~87–88 chars; 80–90 is the window (same as redact.ts mask 6). */
const KEYPAIR_B58_MIN = 80;
const KEYPAIR_B58_MAX = 90;

const B58_EXACT = new RegExp(`^[${B58}]{${KEYPAIR_B58_MIN},${KEYPAIR_B58_MAX}}$`);

/** A maximal base58 run of 80–90 chars (not part of a longer base58 run). */
const B58_CANDIDATE = new RegExp(
  `(?<![${B58}])[${B58}]{${KEYPAIR_B58_MIN},${KEYPAIR_B58_MAX}}(?![${B58}])`, 'g');

/** `[n, n, …]` with exactly 64 integer entries (values range-checked separately). */
const JSON_BYTES_64 = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g;

const SEED_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);
const SEED_WORD = /^[a-z]{3,8}$/;

/** True when `bytes` is a 64-byte ed25519 keypair secret: last 32 = public key of the first 32. */
export function isKeypairSecretBytes(bytes: Uint8Array): boolean {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 64) return false;
    const pub = ed25519.getPublicKey(bytes.subarray(0, 32));
    if (pub.length !== 32) return false;
    for (let i = 0; i < 32; i++) if (pub[i] !== bytes[32 + i]) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Exact check on ONE string: base58, 80–90 chars, decodes to 64 bytes and
 * passes isKeypairSecretBytes(). Same contract as `looksLikePrivateKey` in
 * src/lib/redact.ts (WI-F §3.3.2 mask 6).
 * REBUILD-CHOSEN: implemented here (not imported from redact.ts) because
 * redact.ts mask 8 imports containsSeedPhrase from this module — importing
 * back would make a redact ↔ secret-guard cycle. redact.ts may re-export it.
 */
export function looksLikePrivateKey(s: string): boolean {
  try {
    if (typeof s !== 'string' || !B58_EXACT.test(s)) return false;
    return isKeypairSecretBytes(bs58.decode(s));
  } catch {
    return false;
  }
}

/** Base58 keypair secret anywhere in the text (exact check), or a 64-byte JSON array. */
export function containsPrivateKey(text: string): boolean {
  try {
    if (typeof text !== 'string' || text.length < 64) return false;

    for (const m of text.matchAll(B58_CANDIDATE)) {
      if (looksLikePrivateKey(m[0])) return true;
    }

    for (const m of text.matchAll(JSON_BYTES_64)) {
      const nums = m[0].match(/\d+/g) || [];
      if (nums.length === 64 && nums.every(n => Number(n) <= 255)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The whole message (trimmed) is 12/15/18/21/24 whitespace-separated
 * lowercase a–z words of 3–8 letters. A phrase embedded in a longer
 * sentence is deliberately NOT flagged (CHOSEN: never flag ordinary text).
 */
export function containsSeedPhrase(text: string): boolean {
  try {
    if (typeof text !== 'string') return false;
    const t = text.trim();
    if (!t) return false;
    const words = t.split(/\s+/);
    if (!SEED_WORD_COUNTS.has(words.length)) return false;
    return words.every(w => SEED_WORD.test(w));
  } catch {
    return false;
  }
}

/** The text handler's gate: delete the message when it holds a key or a seed phrase. */
export function shouldDeleteForSecrets(text: string): boolean {
  return containsPrivateKey(text) || containsSeedPhrase(text);
}

/**
 * REBUILD-CHOSEN helper for the bot.ts wiring: the guard is skipped while the
 * bot is waiting for the /import key (`sess.awaitingInput` = `w:import:…`),
 * because the import path deletes that message itself (T2c).
 */
export function isImportPrompt(awaitingInput: string | null | undefined): boolean {
  return typeof awaitingInput === 'string' && awaitingInput.startsWith('w:import:');
}

/**
 * REBUILD-CHOSEN (final review fixes): the guard's `/import <key>` exemption must
 * mirror Telegraf 4.16.3's routing exactly, or a key that Telegraf never routes to
 * the import handler (`/IMPORT <key>`, `/import@other_bot <key>`) would skip the
 * guard AND never be deleted by the import path. Telegraf string triggers are
 * case-sensitive; an `@suffix` must equal this bot's username (case-insensitive).
 */
/** `/import`, alone or followed by whitespace, optionally `@<bot>`. Lowercase only (Telegraf triggers are case-sensitive). */
const IMPORT_COMMAND_RE = /^\/import(?:@([A-Za-z0-9_]+))?(?:\s|$)/;
/** True only when Telegraf will route this text to bot.command('import'). */
export function isRoutedImportCommand(text: unknown, botUsername: unknown): boolean {
  if (typeof text !== 'string') return false;
  const m = IMPORT_COMMAND_RE.exec(text);
  if (!m) return false;
  return !m[1] || m[1].toLowerCase() === String(botUsername || '').toLowerCase();
}
