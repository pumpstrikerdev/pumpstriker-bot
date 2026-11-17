/**
 * Unit tests for the secret guard (2026-09-29, security track B, threat T2d).
 * Every key here is generated at test time and thrown away; nothing is logged.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'crypto';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import {
  containsPrivateKey,
  containsSeedPhrase,
  shouldDeleteForSecrets,
  looksLikePrivateKey,
  isKeypairSecretBytes,
  isImportPrompt,
  isRoutedImportCommand,
  SECRET_GUARD_REPLY,
  SECRET_GUARD_LOG,
} from './secret-guard';

const kp = Keypair.generate();
const secretB58 = bs58.encode(kp.secretKey);
const secretJson = JSON.stringify(Array.from(kp.secretKey));             // solana-keygen id.json format
const secretJsonSpaced = '[\n  ' + Array.from(kp.secretKey).join(',\n  ') + '\n]';

/** A base58 string of the wanted length, built by `make` (lengths vary by leading bytes). */
function withLength(len: number, make: () => string): string {
  for (let i = 0; i < 200; i++) { const s = make(); if (s.length === len) return s; }
  throw new Error(`could not build a ${len}-char sample`);
}

const address44 = withLength(44, () => Keypair.generate().publicKey.toBase58());
const txSig88 = withLength(88, () => {
  const seed = randomBytes(32);
  return bs58.encode(ed25519.sign(randomBytes(48), seed));             // a real 64-byte ed25519 signature
});

// BIP39 test-vector words (public, all 3–8 lowercase letters).
const WORDS = ('abandon ability able about above absent absorb abstract absurd abuse access accident ' +
  'account accuse achieve acid acoustic acquire across act action actor actress actual').split(' ');
const phrase = (n: number) => WORDS.slice(0, n).join(' ');

describe('containsPrivateKey', () => {
  it('detects a generated keypair secret in base58', () => {
    expect(secretB58.length).toBeGreaterThanOrEqual(80);
    expect(secretB58.length).toBeLessThanOrEqual(90);
    expect(containsPrivateKey(secretB58)).toBe(true);
  });

  it('detects the base58 secret inside surrounding text and across lines', () => {
    expect(containsPrivateKey(`here is my key: ${secretB58} pls import`)).toBe(true);
    expect(containsPrivateKey(`\n${secretB58}\n`)).toBe(true);
    expect(containsPrivateKey(`${address44}\n${secretB58}`)).toBe(true);
  });

  it('detects a generated keypair secret as a JSON byte array (compact and pretty-printed)', () => {
    expect(containsPrivateKey(secretJson)).toBe(true);
    expect(containsPrivateKey(secretJsonSpaced)).toBe(true);
    expect(containsPrivateKey(`my id.json: ${secretJson}`)).toBe(true);
  });

  it('does not flag a 44-char address', () => {
    expect(containsPrivateKey(address44)).toBe(false);
  });

  it('does not flag an 88-char transaction signature (64 bytes, fails the keypair check)', () => {
    expect(containsPrivateKey(txSig88)).toBe(false);
    expect(containsPrivateKey(`https://solscan.io/tx/${txSig88}`)).toBe(false);
  });

  it('does not flag 64 random bytes in base58 or a keypair with one byte flipped', () => {
    expect(containsPrivateKey(bs58.encode(randomBytes(64)))).toBe(false);
    const bad = Uint8Array.from(kp.secretKey);
    bad[63] ^= 0x01;
    expect(containsPrivateKey(bs58.encode(bad))).toBe(false);
  });

  it('does not flag a base58 run longer than 90 chars as one candidate', () => {
    expect(containsPrivateKey(secretB58 + 'abc')).toBe(false);
  });

  it('JSON arrays must have exactly 64 entries of 0–255', () => {
    const arr = Array.from(kp.secretKey);
    expect(containsPrivateKey(JSON.stringify(arr.slice(0, 63)))).toBe(false);
    expect(containsPrivateKey(JSON.stringify(arr.slice(0, 32)))).toBe(false);
    expect(containsPrivateKey(JSON.stringify([...arr, 1]))).toBe(false);
    const over = [...arr]; over[10] = 256;
    expect(containsPrivateKey(JSON.stringify(over))).toBe(false);
  });

  it('never throws on non-strings or empty input', () => {
    for (const v of [undefined, null, 42, {}, [], ''] as any[]) {
      expect(() => containsPrivateKey(v)).not.toThrow();
      expect(containsPrivateKey(v)).toBe(false);
    }
  });
});

describe('looksLikePrivateKey / isKeypairSecretBytes', () => {
  it('is an exact check on one string', () => {
    expect(looksLikePrivateKey(secretB58)).toBe(true);
    expect(looksLikePrivateKey(` ${secretB58}`)).toBe(false);
    expect(looksLikePrivateKey(address44)).toBe(false);
    expect(looksLikePrivateKey(txSig88)).toBe(false);
    expect(looksLikePrivateKey(undefined as any)).toBe(false);
  });

  it('checks the ed25519 relation of the 64 bytes', () => {
    expect(isKeypairSecretBytes(kp.secretKey)).toBe(true);
    expect(isKeypairSecretBytes(kp.secretKey.subarray(0, 32))).toBe(false);
    expect(isKeypairSecretBytes(randomBytes(64))).toBe(false);
    expect(isKeypairSecretBytes(null as any)).toBe(false);
  });
});

describe('containsSeedPhrase', () => {
  it('detects 12- and 24-word phrases', () => {
    expect(containsSeedPhrase(phrase(12))).toBe(true);
    expect(containsSeedPhrase(phrase(24))).toBe(true);
  });

  it('detects 15/18/21 words, extra whitespace and one word per line', () => {
    expect(containsSeedPhrase(phrase(15))).toBe(true);
    expect(containsSeedPhrase(phrase(18))).toBe(true);
    expect(containsSeedPhrase(phrase(21))).toBe(true);
    expect(containsSeedPhrase(`  ${WORDS.slice(0, 12).join('   ')}  `)).toBe(true);
    expect(containsSeedPhrase(WORDS.slice(0, 12).join('\n'))).toBe(true);
  });

  it('does not flag other word counts', () => {
    for (const n of [1, 11, 13, 14, 16, 23]) expect(containsSeedPhrase(phrase(n))).toBe(false);
    expect(containsSeedPhrase(`${phrase(24)} abandon`)).toBe(false);              // 25 words
  });

  it('does not flag a normal 12-word English sentence with punctuation or capitals', () => {
    expect(containsSeedPhrase('Hey, can you check this token for me before I buy it?')).toBe(false);
    expect(containsSeedPhrase('please check this token before buying, looks like another rug pull again.')).toBe(false);
    expect(containsSeedPhrase('Please check this token before buying looks like another rug pull again')).toBe(false);
  });

  it('does not flag lowercase sentences with short words, digits or long words', () => {
    expect(containsSeedPhrase('is it a good time to buy this one or should we wait')).toBe(false);
    expect(containsSeedPhrase(phrase(11) + ' 1234')).toBe(false);
    expect(containsSeedPhrase(phrase(11) + ' extraordinary')).toBe(false);
  });

  it('does not flag a phrase embedded in a longer message (whole-message rule)', () => {
    expect(containsSeedPhrase(`my seed is ${phrase(12)}`)).toBe(false);
  });

  it('never throws on non-strings or empty input', () => {
    for (const v of [undefined, null, 42, {}, '', '   '] as any[]) {
      expect(() => containsSeedPhrase(v)).not.toThrow();
      expect(containsSeedPhrase(v)).toBe(false);
    }
  });
});

describe('shouldDeleteForSecrets', () => {
  it('is true for a key, a JSON key or a seed phrase', () => {
    expect(shouldDeleteForSecrets(secretB58)).toBe(true);
    expect(shouldDeleteForSecrets(secretJson)).toBe(true);
    expect(shouldDeleteForSecrets(phrase(12))).toBe(true);
  });

  it('is false for everyday bot input', () => {
    for (const t of [address44, txSig88, '/start', '0.5', 'Wallet 2', '25', 'menu',
      'Hey, can you check this token for me before I buy it?', '']) {
      expect(shouldDeleteForSecrets(t)).toBe(false);
    }
  });

  it('never throws on non-strings', () => {
    expect(() => shouldDeleteForSecrets(undefined as any)).not.toThrow();
    expect(shouldDeleteForSecrets(null as any)).toBe(false);
  });
});

describe('wiring helpers', () => {
  it('isImportPrompt matches only the /import key prompt', () => {
    expect(isImportPrompt('w:import:_')).toBe(true);
    expect(isImportPrompt('w:rename:abc')).toBe(false);
    expect(isImportPrompt('w:import')).toBe(false);
    expect(isImportPrompt(null)).toBe(false);
    expect(isImportPrompt(undefined)).toBe(false);
  });

  // The guard exempts a message only when this is true; when it is false and
  // shouldDeleteForSecrets() is true, the guard deletes it (SECRET_GUARD_REPLY).
  it('isRoutedImportCommand mirrors Telegraf routing: lowercase /import, no suffix or @<this bot>', () => {
    expect(isRoutedImportCommand(`/import ${secretB58}`, 'MyBot')).toBe(true);
    expect(isRoutedImportCommand(`/import@mybot ${secretB58}`, 'MyBot')).toBe(true);
    expect(isRoutedImportCommand('/import', 'MyBot')).toBe(true);
    expect(isRoutedImportCommand(`/IMPORT ${secretB58}`, 'MyBot')).toBe(false);
    expect(isRoutedImportCommand(`/Import ${secretB58}`, 'MyBot')).toBe(false);
    expect(isRoutedImportCommand(`/import@other_bot ${secretB58}`, 'MyBot')).toBe(false);
    expect(isRoutedImportCommand('/import@x', '')).toBe(false);
    expect(isRoutedImportCommand('/import@x', undefined)).toBe(false);
    expect(isRoutedImportCommand(`/importx ${secretB58}`, 'MyBot')).toBe(false);
    expect(isRoutedImportCommand(undefined, 'MyBot')).toBe(false);
  });

  it('an unrouted /import form carrying a key is deleted by the guard', () => {
    expect(isRoutedImportCommand('/IMPORT ' + secretB58, 'MyBot')).toBe(false);
    expect(shouldDeleteForSecrets('/IMPORT ' + secretB58)).toBe(true);
    expect(shouldDeleteForSecrets(`/import@other_bot ${secretB58}`)).toBe(true);
  });

  it('uses the CHOSEN reply text and a log line without message text', () => {
    expect(SECRET_GUARD_REPLY).toBe('🔐 That looked like a private key or seed phrase — I deleted it. Use /import to add a wallet.');
    expect(SECRET_GUARD_LOG).toBe('[secret-guard] deleted a secret-looking message');
  });
});
