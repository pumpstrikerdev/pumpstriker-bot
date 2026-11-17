/**
 * Unit tests for wallet secret storage (2026-09-29, T5): scrypt + AES-256-GCM,
 * legacy sha256 format still readable with BOTH secrets, verified upgrade
 * with backup, atomic owner-only writes, derived-key cache.
 * All secrets below are fake test values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SCRYPT, encryptSecret, decryptSecret, isLegacy, upgradeWallets, upgradeWalletsFile,
  writeFileAtomic, walletPassphrases, undecryptableWarning, clearKeyCache,
  type EncLegacy, type EncV2,
} from './wallet-crypto';

const ENC_KEY   = 'test-wallet-enc-key-not-a-real-secret';
const BOT_TOKEN = 'test-bot-token-not-a-real-secret';
const OLD_TOKEN = 'test-old-bot-token-not-a-real-secret';
const PLAIN     = 'plain-secret-' + crypto.randomBytes(16).toString('hex');

/** The July / Sep 25 bot.ts encrypt(): key = sha256(secret), hex fields. */
function legacyEncrypt(text: string, secret: string): EncLegacy {
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv  = crypto.randomBytes(12);
  const aes = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([aes.update(text, 'utf8'), aes.final()]);
  return { iv: iv.toString('hex'), enc: enc.toString('hex'), tag: aes.getAuthTag().toString('hex') };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-crypto-test-'));
}

beforeEach(() => clearKeyCache());

describe('encryptSecret / decryptSecret (v2)', () => {
  it('round-trips and writes the versioned scrypt format', () => {
    const e = encryptSecret(PLAIN, ENC_KEY);
    expect(e.v).toBe(2);
    expect(e.kdf).toBe('scrypt');
    expect([e.N, e.r, e.p]).toEqual([SCRYPT.N, SCRYPT.r, SCRYPT.p]);
    expect(SCRYPT).toMatchObject({ N: 32768, r: 8, p: 1, keyLen: 32 });
    expect(e.salt).toMatch(/^[0-9a-f]{32}$/);   // 16-byte salt
    expect(e.iv).toMatch(/^[0-9a-f]{24}$/);     // 12-byte GCM iv
    expect(e.tag).toMatch(/^[0-9a-f]{32}$/);    // 16-byte tag
    expect(JSON.stringify(e)).not.toContain(PLAIN);
    expect(decryptSecret(e, [ENC_KEY])).toBe(PLAIN);
  });

  it('uses a fresh salt and iv on every call', () => {
    const a = encryptSecret(PLAIN, ENC_KEY);
    const b = encryptSecret(PLAIN, ENC_KEY);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.enc).not.toBe(b.enc);
    expect(decryptSecret(a, [ENC_KEY])).toBe(PLAIN);
    expect(decryptSecret(b, [ENC_KEY])).toBe(PLAIN);
  });

  it('tries each passphrase in turn and skips empty ones', () => {
    const e = encryptSecret(PLAIN, BOT_TOKEN);
    expect(decryptSecret(e, ['', ENC_KEY, BOT_TOKEN])).toBe(PLAIN);
  });

  it('throws when no passphrase works, without leaking secrets in the error', () => {
    const e = encryptSecret(PLAIN, ENC_KEY);
    let msg = '';
    try { decryptSecret(e, [BOT_TOKEN, OLD_TOKEN]); } catch (err: any) { msg = String(err?.message); }
    expect(msg).toMatch(/could not decrypt/);
    for (const s of [PLAIN, ENC_KEY, BOT_TOKEN, OLD_TOKEN]) expect(msg).not.toContain(s);
    expect(() => decryptSecret(e, [])).toThrow(/no decryption passphrase/);
  });

  it('refuses an empty encryption passphrase', () => {
    expect(() => encryptSecret(PLAIN, '')).toThrow(/no encryption passphrase/);
  });

  it('rejects tampered ciphertext, tag, and truncated tags', () => {
    const e = encryptSecret(PLAIN, ENC_KEY);
    const flip = (hex: string) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);
    expect(() => decryptSecret({ ...e, enc: flip(e.enc) }, [ENC_KEY])).toThrow();
    expect(() => decryptSecret({ ...e, tag: flip(e.tag) }, [ENC_KEY])).toThrow();
    expect(() => decryptSecret({ ...e, tag: e.tag.slice(0, 8) }, [ENC_KEY])).toThrow();
    const leg = legacyEncrypt(PLAIN, BOT_TOKEN);
    expect(() => decryptSecret({ ...leg, tag: leg.tag.slice(0, 8) }, [BOT_TOKEN])).toThrow();
  });

  it('refuses absurd or invalid scrypt params from disk instead of hanging', () => {
    const e = encryptSecret(PLAIN, ENC_KEY);
    expect(() => decryptSecret({ ...e, N: 2 ** 30 } as EncV2, [ENC_KEY])).toThrow(/unsupported scrypt/);
    expect(() => decryptSecret({ ...e, N: 30000 } as EncV2, [ENC_KEY])).toThrow(/unsupported scrypt/);
    expect(() => decryptSecret({ ...e, p: 0 } as EncV2, [ENC_KEY])).toThrow(/unsupported scrypt/);
  });

  it('throws on an unknown entry format', () => {
    expect(() => decryptSecret({ foo: 1 } as any, [ENC_KEY])).toThrow(/unknown encrypted entry/);
  });
});

describe('legacy format (sha256(WALLET_ENC_KEY || TG_BOT_TOKEN))', () => {
  it('a July-style entry (sha256(token)) decrypts with the token when WALLET_ENC_KEY is unset', () => {
    const leg = legacyEncrypt(PLAIN, BOT_TOKEN);
    const { passphrases } = walletPassphrases({ WALLET_ENC_KEY: '', TG_BOT_TOKEN: BOT_TOKEN });
    expect(decryptSecret(leg, passphrases)).toBe(PLAIN);
  });

  it('a July-style entry still decrypts after WALLET_ENC_KEY is set (token is tried second)', () => {
    const leg = legacyEncrypt(PLAIN, BOT_TOKEN);
    const { passphrases } = walletPassphrases({ WALLET_ENC_KEY: ENC_KEY, TG_BOT_TOKEN: BOT_TOKEN });
    expect(decryptSecret(leg, passphrases)).toBe(PLAIN);
  });

  it('an entry written with WALLET_ENC_KEY as the legacy key decrypts with WALLET_ENC_KEY (token rotated)', () => {
    // Rotation procedure: WALLET_ENC_KEY = the OLD token, then a new TG_BOT_TOKEN.
    const leg = legacyEncrypt(PLAIN, OLD_TOKEN);
    const { passphrases } = walletPassphrases({ WALLET_ENC_KEY: OLD_TOKEN, TG_BOT_TOKEN: BOT_TOKEN });
    expect(decryptSecret(leg, passphrases)).toBe(PLAIN);
    const leg2 = legacyEncrypt(PLAIN, ENC_KEY);
    expect(decryptSecret(leg2, [ENC_KEY, BOT_TOKEN])).toBe(PLAIN);
  });

  it('isLegacy tells the two formats apart', () => {
    expect(isLegacy(legacyEncrypt(PLAIN, BOT_TOKEN))).toBe(true);
    expect(isLegacy(encryptSecret(PLAIN, ENC_KEY))).toBe(false);
    expect(isLegacy(null)).toBe(false);
    expect(isLegacy('abc')).toBe(false);
    expect(isLegacy({ iv: 'aa', enc: 'bb' })).toBe(false);
  });
});

describe('walletPassphrases', () => {
  it('primary = WALLET_ENC_KEY || TG_BOT_TOKEN; both tried, deduplicated', () => {
    expect(walletPassphrases({ WALLET_ENC_KEY: ENC_KEY, TG_BOT_TOKEN: BOT_TOKEN }))
      .toEqual({ passphrases: [ENC_KEY, BOT_TOKEN], primary: ENC_KEY });
    expect(walletPassphrases({ WALLET_ENC_KEY: '', TG_BOT_TOKEN: BOT_TOKEN }))
      .toEqual({ passphrases: [BOT_TOKEN], primary: BOT_TOKEN });
    expect(walletPassphrases({ WALLET_ENC_KEY: BOT_TOKEN, TG_BOT_TOKEN: BOT_TOKEN }))
      .toEqual({ passphrases: [BOT_TOKEN], primary: BOT_TOKEN });
    expect(walletPassphrases({})).toEqual({ passphrases: [], primary: '' });
  });
});

describe('upgradeWallets', () => {
  it('re-encrypts legacy entries, verifies, and keeps undecryptable entries untouched', () => {
    const { passphrases, primary } = walletPassphrases({ WALLET_ENC_KEY: ENC_KEY, TG_BOT_TOKEN: BOT_TOKEN });
    const v2Primary = { id: 'w3', name: 'Wallet 3', isDefault: false, enc: encryptSecret(PLAIN + '3', ENC_KEY) };
    const input = [
      { id: 'w1', name: 'Wallet 1', isDefault: true, manualEnabled: true, enc: legacyEncrypt(PLAIN + '1', BOT_TOKEN) },
      { id: 'w2', name: 'Wallet 2', isDefault: false, enc: legacyEncrypt(PLAIN + '2', 'some-unknown-old-token') },
      v2Primary,
      { id: 'w4', name: 'Wallet 4', isDefault: false },                                    // no enc at all
      { id: 'w5', name: 'Wallet 5', isDefault: false, enc: encryptSecret(PLAIN + '5', BOT_TOKEN) },  // v2 under the token
    ];
    const snapshot = JSON.parse(JSON.stringify(input));

    const res = upgradeWallets(input, passphrases, primary);

    expect(res.upgraded).toBe(2);                         // w1 (legacy) + w5 (re-keyed)
    expect(res.undecryptable).toEqual(['w2', 'w4']);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);   // input not mutated
    // upgraded entries: v2, open with the primary ONLY, other fields kept
    expect(isLegacy(res.wallets[0].enc)).toBe(false);
    expect(res.wallets[0].enc.v).toBe(2);
    expect(decryptSecret(res.wallets[0].enc, [primary])).toBe(PLAIN + '1');
    expect(res.wallets[0]).toMatchObject({ id: 'w1', name: 'Wallet 1', isDefault: true, manualEnabled: true });
    expect(decryptSecret(res.wallets[4].enc, [primary])).toBe(PLAIN + '5');
    // undecryptable entries are byte-identical, never dropped
    expect(res.wallets[1]).toEqual(snapshot[1]);
    expect(res.wallets[3]).toEqual(snapshot[3]);
    // v2 already under the primary is left as is
    expect(res.wallets[2]).toBe(v2Primary);
    expect(res.wallets).toHaveLength(5);
  });

  it('with WALLET_ENC_KEY unset, legacy entries are upgraded under the bot token', () => {
    const { passphrases, primary } = walletPassphrases({ TG_BOT_TOKEN: BOT_TOKEN });
    const res = upgradeWallets([{ id: 'a', enc: legacyEncrypt(PLAIN, BOT_TOKEN) }], passphrases, primary);
    expect(res.upgraded).toBe(1);
    expect(decryptSecret(res.wallets[0].enc, [BOT_TOKEN])).toBe(PLAIN);
  });

  it('labels entries without id/name by position', () => {
    const res = upgradeWallets([{ enc: legacyEncrypt(PLAIN, 'nope') }], [BOT_TOKEN], BOT_TOKEN);
    expect(res.undecryptable).toEqual(['#1']);
    expect(res.upgraded).toBe(0);
  });
});

describe('writeFileAtomic', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes, overwrites, creates the parent dir and leaves no .tmp behind', () => {
    const file = path.join(dir, 'sub', 'wallets.json');
    writeFileAtomic(file, '[1]');
    expect(fs.readFileSync(file, 'utf8')).toBe('[1]');
    writeFileAtomic(file, '[2]');
    expect(fs.readFileSync(file, 'utf8')).toBe('[2]');
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp'))).toEqual([]);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['wallets.json']);
  });

  it('sets owner-only permissions where the OS supports it', () => {
    const file = path.join(dir, 'wallets.json');
    writeFileAtomic(file, '[]');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('upgradeWalletsFile (startup upgrade)', () => {
  let dir: string;
  let file: string;
  const NOW = new Date('2026-09-29T12:00:00.000Z');
  beforeEach(() => { dir = tmpDir(); file = path.join(dir, 'wallets.json'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('backs up, rewrites legacy entries as v2, and leaves no .tmp', () => {
    const original = JSON.stringify([{ id: 'w1', name: 'Wallet 1', enc: legacyEncrypt(PLAIN, BOT_TOKEN) }], null, 2);
    fs.writeFileSync(file, original);

    const res = upgradeWalletsFile(file, [ENC_KEY, BOT_TOKEN], ENC_KEY, NOW);

    expect(res.upgraded).toBe(1);
    expect(res.undecryptable).toEqual([]);
    expect(res.error).toBeUndefined();
    expect(res.backupFile).toBe(`${file}.bak-2026-09-29T12-00-00-000Z`);
    expect(fs.readFileSync(res.backupFile!, 'utf8')).toBe(original);   // backup = exact old bytes
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk[0].enc.v).toBe(2);
    expect(decryptSecret(onDisk[0].enc, [ENC_KEY])).toBe(PLAIN);
    expect(res.wallets).toEqual(onDisk);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);

    // second boot: nothing to do, no new backup
    const again = upgradeWalletsFile(file, [ENC_KEY, BOT_TOKEN], ENC_KEY, new Date('2026-09-29T13:00:00.000Z'));
    expect(again.upgraded).toBe(0);
    expect(again.backupFile).toBeUndefined();
    expect(fs.readdirSync(dir).filter((f) => f.includes('.bak-'))).toHaveLength(1);
  });

  it('does not overwrite an existing backup with the same stamp', () => {
    fs.writeFileSync(file, JSON.stringify([{ id: 'w1', enc: legacyEncrypt(PLAIN, BOT_TOKEN) }]));
    fs.writeFileSync(`${file}.bak-2026-09-29T12-00-00-000Z`, 'older backup');
    const res = upgradeWalletsFile(file, [BOT_TOKEN], BOT_TOKEN, NOW);
    expect(res.upgraded).toBe(1);
    expect(res.backupFile).toBe(`${file}.bak-2026-09-29T12-00-00-000Z-1`);
    expect(fs.readFileSync(`${file}.bak-2026-09-29T12-00-00-000Z`, 'utf8')).toBe('older backup');
  });

  it('only undecryptable entries: reports them, no backup, file untouched', () => {
    const original = JSON.stringify([{ id: 'lost', enc: legacyEncrypt(PLAIN, 'some-unknown-old-token') }]);
    fs.writeFileSync(file, original);
    const res = upgradeWalletsFile(file, [ENC_KEY, BOT_TOKEN], ENC_KEY, NOW);
    expect(res.upgraded).toBe(0);
    expect(res.undecryptable).toEqual(['lost']);
    expect(res.backupFile).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readdirSync(dir)).toEqual(['wallets.json']);
    expect(undecryptableWarning(res.undecryptable.length))
      .toBe('⚠️ 1 wallet(s) could not be decrypted — check WALLET_ENC_KEY / old bot token');
  });

  it('missing file: nothing to do and nothing created', () => {
    const res = upgradeWalletsFile(file, [BOT_TOKEN], BOT_TOKEN, NOW);
    expect(res).toEqual({ wallets: [], upgraded: 0, undecryptable: [] });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('unparsable file: flagged and left untouched', () => {
    fs.writeFileSync(file, '{not json');
    const res = upgradeWalletsFile(file, [BOT_TOKEN], BOT_TOKEN, NOW);
    expect(res.unreadable).toBe(true);
    expect(res.upgraded).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('{not json');
    expect(fs.readdirSync(dir)).toEqual(['wallets.json']);
  });
});

describe('derived-key cache', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('a cache hit avoids a second scrypt', () => {
    const spy = vi.spyOn(crypto, 'scryptSync');
    const e = encryptSecret(PLAIN, ENC_KEY);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(decryptSecret(e, [ENC_KEY])).toBe(PLAIN);        // key cached by encrypt
    expect(decryptSecret(e, [ENC_KEY])).toBe(PLAIN);
    expect(spy).toHaveBeenCalledTimes(1);

    clearKeyCache();
    expect(decryptSecret(e, [ENC_KEY])).toBe(PLAIN);        // cold: one scrypt
    expect(decryptSecret(e, [ENC_KEY])).toBe(PLAIN);        // warm: none
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('legacy entries never run scrypt', () => {
    const spy = vi.spyOn(crypto, 'scryptSync');
    expect(decryptSecret(legacyEncrypt(PLAIN, BOT_TOKEN), [ENC_KEY, BOT_TOKEN])).toBe(PLAIN);
    expect(spy).not.toHaveBeenCalled();
  });
});
