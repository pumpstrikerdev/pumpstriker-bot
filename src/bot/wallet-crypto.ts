/**
 * Wallet secret storage — scrypt (per-wallet salt) + AES-256-GCM. (2026-09-29, T5)
 *
 * Before this module, bot.ts encrypted every wallet with
 *   key = sha256(WALLET_ENC_KEY || TG_BOT_TOKEN)
 * — no salt and no KDF, so a leaked wallets.json could be brute-forced at
 * sha256 speed. New entries are a versioned object (`v: 2`) whose key is
 * scrypt(passphrase, fresh 16-byte salt); the 12-byte GCM IV is also fresh
 * per call, so no (key, iv) pair is ever reused.
 *
 * Backward compatibility:
 *   - the old format `{ iv, enc, tag }` (sha256 key) is still readable;
 *   - BOTH secrets are tried (WALLET_ENC_KEY, then the bot token), so a
 *     wallets.json written before WALLET_ENC_KEY existed — or before the token
 *     was rotated with WALLET_ENC_KEY set to the old token — still opens;
 *   - `upgradeWalletsFile` re-encrypts old entries at startup, verifies each
 *     new copy before it replaces the old one, keeps a backup, and never
 *     changes or drops an entry it cannot decrypt.
 *
 * Derived keys are cached in memory (scrypt at N=2^15 costs ~50–100 ms), so
 * the 15 s stop-loss loop calling getKeypair() never stalls on the KDF.
 *
 * Pure module: no CONFIG import and no logging. Nothing here ever puts a
 * passphrase, a plaintext secret or ciphertext into an error message.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface EncLegacy { iv: string; enc: string; tag: string }                       // sha256(passphrase) key
export interface EncV2 { v: 2; kdf: 'scrypt'; N: number; r: number; p: number; salt: string; iv: string; enc: string; tag: string }
export const SCRYPT = { N: 1 << 15, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 };   // CHOSEN params

const SALT_BYTES = 16;
const IV_BYTES   = 12;
const TAG_BYTES  = 16;
// REBUILD-CHOSEN: ceilings for scrypt params read back from disk. decryptSecret
// honours the N/r/p stored in each entry (so a future param bump stays
// readable), but a tampered file must not be able to make one getKeypair()
// call allocate gigabytes or spin for minutes. 256 MiB = 8x the CHOSEN cost.
const MAX_SCRYPT_MEM = 256 * 1024 * 1024;
const MAX_SCRYPT_P   = 16;
// REBUILD-CHOSEN: derived-key cache bound. Live entries are at most
// MAX_WALLETS(3) x 2 passphrases; every encryptSecret adds one more (fresh
// salt), so FIFO-evict to keep a long-running bot from growing it forever.
const KEY_CACHE_MAX = 64;

// ── Derived-key cache ─────────────────────────────────────────
// Map<sha256(passphrase) + salt (+ params), key>. The passphrase itself is
// never used as a map key.
const _keyCache = new Map<string, Buffer>();

/** Test hook: drop every cached derived key. */
export function clearKeyCache(): void { _keyCache.clear(); }

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function cachePut(k: string, key: Buffer): void {
  if (_keyCache.size >= KEY_CACHE_MAX) {
    const oldest = _keyCache.keys().next().value;
    if (oldest !== undefined) _keyCache.delete(oldest);
  }
  _keyCache.set(k, key);
}

function scryptParamsOk(N: unknown, r: unknown, p: unknown): boolean {
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const n = N as number, rr = r as number, pp = p as number;
  if (n < 2 || (n & (n - 1)) !== 0) return false;          // power of two > 1
  if (rr < 1 || pp < 1 || pp > MAX_SCRYPT_P) return false;
  return 128 * n * rr <= MAX_SCRYPT_MEM;
}

function deriveScryptKey(passphrase: string, saltHex: string, N: number, r: number, p: number): Buffer {
  const cacheKey = `${sha256Hex(passphrase)}:${saltHex}:${N}:${r}:${p}`;
  const hit = _keyCache.get(cacheKey);
  if (hit) return hit;
  // scrypt needs ~128*N*r bytes; Node's default maxmem (32 MiB) is too tight
  // for N=2^15,r=8, hence SCRYPT.maxmem. Raised (within MAX_SCRYPT_MEM) only
  // for entries written with larger params.
  const maxmem = Math.max(SCRYPT.maxmem, 2 * 128 * N * r);
  const key = crypto.scryptSync(passphrase, Buffer.from(saltHex, 'hex'), SCRYPT.keyLen, { N, r, p, maxmem });
  cachePut(cacheKey, key);
  return key;
}

function legacyKey(passphrase: string): Buffer {
  return crypto.createHash('sha256').update(passphrase).digest();
}

// ── Format helpers ────────────────────────────────────────────
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;
function isHex(s: unknown, bytes?: number): s is string {
  if (typeof s !== 'string' || !HEX_RE.test(s)) return false;
  return bytes === undefined || s.length === bytes * 2;
}

export function isLegacy(obj: any): obj is EncLegacy {
  return !!obj && typeof obj === 'object' && obj.v === undefined
    && typeof obj.iv === 'string' && typeof obj.enc === 'string' && typeof obj.tag === 'string';
}

function isV2(obj: any): obj is EncV2 {
  return !!obj && typeof obj === 'object' && obj.v === 2 && obj.kdf === 'scrypt'
    && typeof obj.salt === 'string' && typeof obj.iv === 'string'
    && typeof obj.enc === 'string' && typeof obj.tag === 'string';
}

function gcmOpen(key: Buffer, ivHex: string, encHex: string, tagHex: string): string {
  // REBUILD-CHOSEN: insist on a full 16-byte tag (what the old encrypt() and
  // encryptSecret both write). setAuthTag would otherwise accept a truncated
  // 4-byte tag, which weakens the integrity check on a tampered file.
  if (!isHex(ivHex, IV_BYTES) || !isHex(tagHex, TAG_BYTES) || !isHex(encHex)) {
    throw new Error('wallet-crypto: malformed encrypted entry');
  }
  const aes = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'), { authTagLength: TAG_BYTES });
  aes.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([aes.update(Buffer.from(encHex, 'hex')), aes.final()]).toString('utf8');
}

// ── Public API ────────────────────────────────────────────────

/** Encrypt with a fresh 16-byte salt + 12-byte IV per call. Hex fields, like the old format. */
export function encryptSecret(plain: string, passphrase: string): EncV2 {
  if (typeof passphrase !== 'string' || !passphrase) throw new Error('wallet-crypto: no encryption passphrase configured');
  if (typeof plain !== 'string') throw new Error('wallet-crypto: plaintext must be a string');
  const { N, r, p } = SCRYPT;
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const key  = deriveScryptKey(passphrase, salt, N, r, p);
  const iv   = crypto.randomBytes(IV_BYTES);
  const aes  = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  const enc  = Buffer.concat([aes.update(plain, 'utf8'), aes.final()]);
  return {
    v: 2, kdf: 'scrypt', N, r, p, salt,
    iv: iv.toString('hex'), enc: enc.toString('hex'), tag: aes.getAuthTag().toString('hex'),
  };
}

/**
 * Decrypt a legacy or v2 entry, trying each passphrase in order (empty ones
 * are skipped). Throws if none works — the error never names a passphrase.
 */
export function decryptSecret(obj: EncLegacy | EncV2, passphrases: string[]): string {
  const list = (passphrases || []).filter((s) => typeof s === 'string' && s.length > 0);
  if (!list.length) throw new Error('wallet-crypto: no decryption passphrase configured');
  if (isV2(obj)) {
    if (!scryptParamsOk(obj.N, obj.r, obj.p) || !isHex(obj.salt) || obj.salt.length < 2 * 8) {
      throw new Error('wallet-crypto: unsupported scrypt parameters');
    }
    for (const pw of list) {
      try { return gcmOpen(deriveScryptKey(pw, obj.salt, obj.N, obj.r, obj.p), obj.iv, obj.enc, obj.tag); }
      catch { /* wrong passphrase → GCM auth failure; try the next */ }
    }
    throw new Error('wallet-crypto: could not decrypt wallet (no passphrase matched)');
  }
  if (isLegacy(obj)) {
    for (const pw of list) {
      try { return gcmOpen(legacyKey(pw), obj.iv, obj.enc, obj.tag); }
      catch { /* try the next */ }
    }
    throw new Error('wallet-crypto: could not decrypt wallet (no passphrase matched)');
  }
  throw new Error('wallet-crypto: unknown encrypted entry format');
}

/**
 * Passphrases to try, and the primary used for new encryption.
 *   passphrases = [WALLET_ENC_KEY, TG_BOT_TOKEN].filter(Boolean)  (deduplicated)
 *   primary     = WALLET_ENC_KEY || TG_BOT_TOKEN   (the Sep 25 behaviour)
 */
export function walletPassphrases(cfg: { WALLET_ENC_KEY?: string; TG_BOT_TOKEN?: string }): { passphrases: string[]; primary: string } {
  const passphrases = [...new Set([cfg.WALLET_ENC_KEY, cfg.TG_BOT_TOKEN].filter((s): s is string => typeof s === 'string' && s.length > 0))];
  return { passphrases, primary: cfg.WALLET_ENC_KEY || cfg.TG_BOT_TOKEN || '' };
}

function walletLabel(w: any, i: number): string {
  const id = w && typeof w === 'object' ? (w.id ?? w.name) : undefined;
  return id !== undefined && id !== null && String(id) ? String(id) : `#${i + 1}`;
}

/**
 * Re-encrypt wallets as v2 under `primary`. Pure: returns a new array and
 * never mutates the input.
 *
 * - Legacy entries are re-encrypted, and the new copy must decrypt back to the
 *   same plaintext before it replaces the old one.
 * - REBUILD-CHOSEN: a v2 entry that only opens with a NON-primary passphrase
 *   (e.g. written under the bot token before WALLET_ENC_KEY was set) is
 *   re-keyed to the primary the same way, so setting WALLET_ENC_KEY actually
 *   decouples the wallets from the token. v2 entries already under the
 *   primary are left byte-identical.
 * - Anything that cannot be decrypted (or has no `enc`) is left unchanged and
 *   reported by id/name in `undecryptable` — never dropped.
 */
export function upgradeWallets(wallets: any[], passphrases: string[], primary: string): { wallets: any[]; upgraded: number; undecryptable: string[] } {
  const out: any[] = [];
  const undecryptable: string[] = [];
  let upgraded = 0;
  const others = (passphrases || []).filter((s) => s && s !== primary);
  for (let i = 0; i < (wallets || []).length; i++) {
    const w = wallets[i];
    const enc = w && typeof w === 'object' ? w.enc : undefined;
    if (!isLegacy(enc) && !isV2(enc)) { undecryptable.push(walletLabel(w, i)); out.push(w); continue; }

    let plain: string | null = null;
    let needsRewrite = isLegacy(enc);
    if (isV2(enc)) {
      try { plain = primary ? decryptSecret(enc, [primary]) : null; } catch { plain = null; }
      if (plain === null) {
        try { plain = decryptSecret(enc, others); needsRewrite = true; } catch { plain = null; }
      }
    } else {
      try { plain = decryptSecret(enc, passphrases); } catch { plain = null; }
    }

    if (plain === null) { undecryptable.push(walletLabel(w, i)); out.push(w); continue; }
    if (!needsRewrite || !primary) { out.push(w); continue; }

    try {
      const next = encryptSecret(plain, primary);
      if (decryptSecret(next, [primary]) !== plain) throw new Error('verify mismatch');
      out.push({ ...w, enc: next });
      upgraded++;
    } catch {
      out.push(w);   // verification failed — keep the original, it still decrypts
    }
  }
  return { wallets: out, upgraded, undecryptable };
}

/** Synchronous sleep for the rename retry (Windows AV / OneDrive locks). */
function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best effort */ }
}

/**
 * Atomic write: unique tmp file (mode 0600) + rename, then chmod 0600 (best
 * effort — Windows ignores POSIX modes). REBUILD-CHOSEN: unlike bot.ts
 * writeJson there is NO direct-write fallback — a non-atomic write that dies
 * halfway would truncate the only copy of the keys. A rename that keeps
 * failing after 3 tries removes the tmp file and throws.
 */
export function writeFileAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { fs.renameSync(tmp, file); lastErr = undefined; break; }
      catch (e: any) {
        lastErr = e;
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) break;
        sleepSync(50 * (attempt + 1));
      }
    }
    if (lastErr) throw lastErr;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

/** Telegram/log text for undecryptable wallets (CHOSEN wording). */
export function undecryptableWarning(n: number): string {
  return `⚠️ ${n} wallet(s) could not be decrypted — check WALLET_ENC_KEY / old bot token`;
}

export interface UpgradeFileResult {
  /** The wallets now on disk (upgraded copy, or the original when nothing changed). */
  wallets: any[];
  upgraded: number;
  undecryptable: string[];
  /** Backup written before the rewrite, if any. */
  backupFile?: string;
  /** Set when the file exists but is not a JSON array — it is left untouched. */
  unreadable?: boolean;
  /** Set when the backup or the write failed — the file is left untouched. */
  error?: string;
}

/**
 * Startup upgrade of data/wallets.json (call once at boot, before bot.launch):
 *   1. read the file (missing = nothing to do; not a JSON array = untouched);
 *   2. upgradeWallets in memory (verify each new copy);
 *   3. only if something changed: back up to `wallets.json.bak-<stamp>`, then
 *      writeFileAtomic. REBUILD-CHOSEN: the backup is taken whenever the file
 *      is about to be rewritten (spec: "if it holds any legacy entries") — an
 *      undecryptable legacy entry alone does not trigger a rewrite, so it does
 *      not pile up a new backup on every boot. If the backup fails, the file
 *      is not rewritten.
 * The caller logs and notify()s `undecryptableWarning(undecryptable.length)`.
 */
export function upgradeWalletsFile(file: string, passphrases: string[], primary: string, now: Date = new Date()): UpgradeFileResult {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e: any) {
    if (e?.code === 'ENOENT') return { wallets: [], upgraded: 0, undecryptable: [] };
    return { wallets: [], upgraded: 0, undecryptable: [], unreadable: true, error: `read failed (${e?.code || 'error'})` };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  if (!Array.isArray(parsed)) return { wallets: [], upgraded: 0, undecryptable: [], unreadable: true };

  const res = upgradeWallets(parsed, passphrases, primary);
  if (res.upgraded === 0) return { wallets: parsed, upgraded: 0, undecryptable: res.undecryptable };

  const stamp = now.toISOString().replace(/[:.]/g, '-');   // Windows-safe
  let backupFile = `${file}.bak-${stamp}`;
  try {
    for (let n = 1; fs.existsSync(backupFile); n++) backupFile = `${file}.bak-${stamp}-${n}`;
    fs.copyFileSync(file, backupFile, fs.constants.COPYFILE_EXCL);
    try { fs.chmodSync(backupFile, 0o600); } catch { /* best effort */ }
  } catch (e: any) {
    return { wallets: parsed, upgraded: 0, undecryptable: res.undecryptable, error: `backup failed (${e?.code || 'error'})` };
  }
  try {
    writeFileAtomic(file, JSON.stringify(res.wallets, null, 2));
  } catch (e: any) {
    return { wallets: parsed, upgraded: 0, undecryptable: res.undecryptable, backupFile, error: `write failed (${e?.code || 'error'})` };
  }
  return { wallets: res.wallets, upgraded: res.upgraded, undecryptable: res.undecryptable, backupFile };
}
