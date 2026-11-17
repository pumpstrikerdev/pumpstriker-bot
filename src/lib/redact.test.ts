/**
 * Tests for the TG Bot redaction helper (WI-F §3.3.2 / §6.3): each mask class,
 * idempotence, and never throwing on non-strings.
 * All secrets below are fake and built at runtime (keypairs from fixed seeds
 * or freshly generated, invented seed words), so no key-shaped literal
 * appears in this file. No network access.
 *
 * R9-FIX1 (A-129 b, finding #23): redactSecrets is the synced shared
 * body first, then the bot-only masks. The byte-array cases below therefore
 * carry the shared marker `[<redacted-bytes>]` and the shared 32-entry rule.
 */
import { describe, it, expect } from 'vitest';
import { inspect } from 'util';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { redactSecrets, looksLikePrivateKey } from './redact';
import { redactSecrets as redactShared } from '../shared/redact';

const FAKE = 'FAKEsecretVALUE0123456789abcdefXYZ'; // 34 chars, never a real key
const tgToken = () => '7' + '1'.repeat(8) + ':' + 'A'.repeat(17) + '_' + 'b'.repeat(17); // 9 digits : 35 chars

/** A Solana-style 64-byte secret key (seed ‖ ed25519 pubkey) from a fixed seed. */
function fakeSecretKey(salt = 3): Uint8Array {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + salt) & 255);
  const pub = ed25519.getPublicKey(seed);
  const sk = new Uint8Array(64);
  sk.set(seed, 0);
  sk.set(pub, 32);
  return sk;
}
const fakeSecretB58 = (salt = 3) => bs58.encode(fakeSecretKey(salt));
const fakeAddress = (salt = 3) => bs58.encode(fakeSecretKey(salt).subarray(32));
/** 64 bytes that are NOT seed ‖ pubkey — the shape of a transaction signature. */
const fakeSignature = () => bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 255));

// Invented lowercase words (3–8 letters, deliberately not a real wallet phrase).
const WORDS = ['zorbu', 'quaxi', 'mivren', 'tolpa', 'drusk', 'yembo', 'faluk', 'grint',
  'vopsa', 'kelmir', 'nubra', 'sefto', 'wixel', 'pandro', 'lurvi', 'cosmah',
  'jibbet', 'ruvek', 'hostel', 'ombrix', 'tazel', 'blenko', 'fimra', 'quorv'];
const phrase = (n: number) => WORDS.slice(0, n).join(' ');

describe('redactSecrets: (3) Telegram bot tokens', () => {
  it('masks a token inside a /bot<token>/ API URL', () => {
    const out = redactSecrets(`POST https://api.telegram.org/bot${tgToken()}/sendMessage failed`);
    expect(out).toBe('POST https://api.telegram.org/bot<redacted>/sendMessage failed');
  });

  it('masks a bare token (6–12 digits : 30+ chars)', () => {
    const out = redactSecrets(`TG_BOT_TOKEN ${tgToken()} rejected`);
    expect(out).toBe('TG_BOT_TOKEN <tg-token> rejected');
    const short = '123456:' + 'x'.repeat(30);
    expect(redactSecrets(`t=${short}`)).not.toContain(short);
  });

  it('does not touch times or ratios', () => {
    const line = 'at 22:12:53 ratio 3:1 slot 312345678:ok';
    expect(redactSecrets(line)).toBe(line);
  });
});

describe('redactSecrets: (1) URL query keys', () => {
  it('masks api-key / api_key / apikey / key query parameters', () => {
    for (const name of [['api', 'key'].join('-'), ['api', 'key'].join('_'), 'apikey', 'key', 'access_token']) {
      const out = redactSecrets(`FetchError: request to https://mainnet.helius-rpc.com/?${name}=${FAKE}&commitment=confirmed failed`);
      expect(out).toContain(`?${name}=***&commitment=confirmed`);
      expect(out).not.toContain(FAKE);
    }
  });

  it('masks Helius WSS / Sender and RugCheck URLs', () => {
    const k = ['api', 'key'].join('-');
    expect(redactSecrets(`wss://mainnet.helius-rpc.com/?${k}=${FAKE}`)).toBe(`wss://mainnet.helius-rpc.com/?${k}=***`);
    expect(redactSecrets(`http://sg-sender.helius-rpc.com/fast?${k}=${FAKE}`)).toBe(`http://sg-sender.helius-rpc.com/fast?${k}=***`);
    expect(redactSecrets(`https://api.rugcheck.xyz/v1/tokens/x/report?key=${FAKE}`)).not.toContain(FAKE);
  });

  it('masks a key parameter outside a query string, but not look-alike names', () => {
    const k = ['api', 'key'].join('-');
    expect(redactSecrets(`lastError: ${k}=${FAKE}`)).toBe(`lastError: ${k}=***`);
    expect(redactSecrets(`key=${FAKE}`)).toBe('key=***');
    expect(redactSecrets('sortKey=desc monkey=banana')).toBe('sortKey=desc monkey=banana');
  });
});

describe('redactSecrets: (2) path-embedded RPC keys', () => {
  it('masks Alchemy /v2/<key> on https and wss', () => {
    const out = redactSecrets(`https://solana-mainnet.g.alchemy.com/v2/${FAKE} and wss://solana-mainnet.g.alchemy.com/v2/${FAKE}`);
    expect(out).toBe('https://solana-mainnet.g.alchemy.com/v2/*** and wss://solana-mainnet.g.alchemy.com/v2/***');
  });

  it('masks a QuickNode path token', () => {
    const out = redactSecrets(`request to https://example-name.solana-mainnet.quiknode.pro/${FAKE}/ failed`);
    expect(out).toBe('request to https://example-name.solana-mainnet.quiknode.pro/***/ failed');
  });
});

describe('redactSecrets: (4) Bearer and (5) X-API-KEY headers', () => {
  it('masks Authorization: Bearer <x> and a bare Bearer <x>', () => {
    expect(redactSecrets(`Authorization: Bearer ${FAKE}`)).toBe('Authorization: ***');
    expect(redactSecrets(`sent Bearer ${FAKE} upstream`)).toBe('sent Bearer *** upstream');
    expect(redactSecrets(`{"authorization":"Bearer ${FAKE}"}`)).not.toContain(FAKE);
  });

  it('masks X-API-KEY / X-APIKEY values in any serialisation', () => {
    const cases = [
      `X-APIKEY: ${FAKE}`,
      `x-api-key: ${FAKE}`,
      `{'X-API-KEY':'${FAKE}'}`,
      `{"X-APIKEY":"${FAKE}"}`,
      `"X-APIKEY" => ${FAKE}`,
      `x-api-key=${FAKE}`,
      `x-token=${FAKE}`,
      inspect({ headers: { 'X-APIKEY': FAKE } }),
    ];
    for (const c of cases) {
      const out = redactSecrets(c);
      expect(out, c).not.toContain(FAKE);
      expect(out, c).toContain('***');
    }
  });
});

describe('redactSecrets: (6) base58 private keys (exact keypair check)', () => {
  it('masks a base58 secret key built from a fixed seed', () => {
    const sk = fakeSecretB58();
    expect(sk.length).toBeGreaterThanOrEqual(80);
    expect(sk.length).toBeLessThanOrEqual(90);
    expect(redactSecrets(`import failed for ${sk}.`)).toBe('import failed for <private-key>.');
    expect(redactSecrets(sk)).toBe('<private-key>');
    expect(redactSecrets(`"${sk}"`)).toBe('"<private-key>"');
  });

  it('masks a freshly generated @solana/web3.js Keypair secret', () => {
    const kp = Keypair.generate();
    const sk = bs58.encode(kp.secretKey);
    const out = redactSecrets(`wallet ${kp.publicKey.toBase58()} key=${sk} end`);
    expect(out).not.toContain(sk);
    expect(out).toContain(kp.publicKey.toBase58()); // the address stays visible
  });

  it('masks the key even when no key= label precedes it', () => {
    const sk = fakeSecretB58(9);
    expect(redactSecrets(`pasted: ${sk}\nnext line`)).toBe('pasted: <private-key>\nnext line');
  });

  it('never masks addresses, mints or transaction signatures', () => {
    const program = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';   // public pump.fun program id
    const mint = 'Fake' + '2'.repeat(36) + 'pump';                    // 44-char base58-looking mint
    const sig = fakeSignature();                                      // 64 bytes, not a keypair
    expect(sig.length).toBeGreaterThanOrEqual(80);
    const sigShape = '5'.repeat(44) + 'K'.repeat(44);                 // 88-char signature shape
    const line = `fired ${mint} via ${program} by ${fakeAddress()} tx=${sig} alt=${sigShape} mcap=$12.3K`;
    expect(redactSecrets(line)).toBe(line);
  });

  it('does not mask 64 bytes whose second half is the wrong public key', () => {
    const sk = fakeSecretKey();
    sk.set(fakeSecretKey(4).subarray(32), 32); // seed of #3, pubkey of #4
    const s = bs58.encode(sk);
    expect(redactSecrets(`x ${s} y`)).toBe(`x ${s} y`);
  });
});

describe('looksLikePrivateKey', () => {
  it('is true only for a real seed‖pubkey keypair', () => {
    expect(looksLikePrivateKey(fakeSecretB58())).toBe(true);
    expect(looksLikePrivateKey(bs58.encode(Keypair.generate().secretKey))).toBe(true);
    expect(looksLikePrivateKey(fakeAddress())).toBe(false);
    expect(looksLikePrivateKey(fakeSignature())).toBe(false);
    expect(looksLikePrivateKey(`x${fakeSecretB58()}`)).toBe(false);        // not exact
    expect(looksLikePrivateKey(fakeSecretB58().replace(/./, '0'))).toBe(false); // non-base58 char
    expect(looksLikePrivateKey('')).toBe(false);
    expect(looksLikePrivateKey(undefined as unknown as string)).toBe(false);
    expect(looksLikePrivateKey(42 as unknown as string)).toBe(false);
  });
});

describe('redactSecrets: (7) byte-array secret keys (the shared rule: 32 or more entries)', () => {
  it('masks a JSON byte array (solana-keygen id.json shape)', () => {
    const json = JSON.stringify(Array.from(fakeSecretKey()));
    expect(redactSecrets(`WALLET_KEY=${json}`)).toBe('WALLET_KEY=[<redacted-bytes>]');
    expect(redactSecrets(json)).toBe('[<redacted-bytes>]');
  });

  it('masks a spaced / multi-line util.inspect Uint8Array dump', () => {
    const dump = inspect(Keypair.generate().secretKey);
    const out = redactSecrets(`keypair ${dump}`);
    expect(out).toContain('[<redacted-bytes>]');
    expect(out).not.toMatch(/\d{1,3},\s*\d{1,3},\s*\d{1,3}/);
  });

  it('masks a 32-entry seed array (the bot used to leak it) and leaves shorter arrays alone', () => {
    const a32 = JSON.stringify(Array.from(fakeSecretKey().subarray(0, 32)));
    expect(redactSecrets(a32)).toBe('[<redacted-bytes>]');
    expect(redactSecrets(`seed ${a32} rejected`)).toBe('seed [<redacted-bytes>] rejected');
    const a31 = JSON.stringify(Array.from(fakeSecretKey().subarray(0, 31)));
    expect(redactSecrets(a31)).toBe(a31);
    expect(redactSecrets('[1,2,3]')).toBe('[1,2,3]');
    // the shared rule masks by entry count, not by value range: 64 numbers with one non-byte are masked too (the safe side)
    const big = JSON.stringify([...Array.from({ length: 63 }, () => 1), 999]);
    expect(redactSecrets(big)).toBe('[<redacted-bytes>]');
  });
});

describe('redactSecrets: (8) seed phrases', () => {
  it('masks a 12- or 24-word phrase on its own', () => {
    expect(redactSecrets(phrase(12))).toBe('<seed-phrase>');
    expect(redactSecrets(`  ${phrase(24)}  `)).toBe('  <seed-phrase>  ');
    expect(redactSecrets(WORDS.slice(0, 15).join('\n'))).toBe('<seed-phrase>');
  });

  it('masks a phrase embedded in a log line or a serialized message', () => {
    expect(redactSecrets(`[import] bad input: ${phrase(12)}`)).toBe('[import] bad input: <seed-phrase>');
    expect(redactSecrets(`{"text":"${phrase(18)}","chat":1}`)).toBe('{"text":"<seed-phrase>","chat":1}');
    const dumped = redactSecrets(inspect({ text: phrase(21) }));
    expect(dumped).toContain("text: '<seed-phrase>'");
    expect(dumped).not.toContain(WORDS[0]);
  });

  it('masks a phrase on its own line of a multi-line message', () => {
    expect(redactSecrets(`Invalid mnemonic\n${phrase(12)}\nretry`)).toBe('Invalid mnemonic\n<seed-phrase>\nretry');
    expect(redactSecrets(`Invalid mnemonic\r\n${phrase(24)}`)).toBe('Invalid mnemonic\r\n<seed-phrase>');
  });

  it('does not flag ordinary sentences, capitals, punctuation or other word counts', () => {
    const lines = [
      'The bot could not find the token in the list of recent pairs from the scanner.',
      'Quote failed because route returned empty response from upstream server after three retries',
      'quote failed because route returned empty response from upstream server after three retries',
      '[jupiter] Route failed because quote returned empty response from upstream server after three retries',
      "route returned nothing because jupiter wasn't reachable from this machine after three retries today",
      `Seed ${phrase(12)}`,
      `${phrase(12)} 7`,
      WORDS.slice(0, 11).join(' '),
      WORDS.slice(0, 13).join(' '),
      phrase(12).replace('zorbu', 'Zorbu'),
      phrase(12).replace('mivren', 'mivren,'),
    ];
    for (const l of lines) expect(redactSecrets(l), l).toBe(l);
  });
});

describe('redactSecrets: (8) uses the secret-guard word rules', () => {
  it('masks exactly the 12/15/18/21/24-word fields of 3–8 letter lowercase words', () => {
    for (const n of [12, 15, 18, 21, 24]) expect(redactSecrets(`in: ${phrase(n)}`), String(n)).toBe('in: <seed-phrase>');
    for (const n of [11, 13, 20, 23]) expect(redactSecrets(`in: ${phrase(n)}`), String(n)).toBe(`in: ${phrase(n)}`);
    for (const swap of ['qu', 'quaxiquaxi', 'Quaxi', 'qu4xi']) {      // 2 letters, 10 letters, capital, digit
      const p = phrase(12).replace('quaxi', swap);
      expect(redactSecrets(`in: ${p}`), swap).toBe(`in: ${p}`);
    }
  });
});

describe('redactSecrets: idempotence and robustness', () => {
  const k = ['api', 'key'].join('-');
  const everything = [
    `https://api.telegram.org/bot${tgToken()}/getMe`,
    `bare ${tgToken()}`,
    `https://mainnet.helius-rpc.com/?${k}=${FAKE}`,
    `${k}=${FAKE}`,
    `https://x.g.alchemy.com/v2/${FAKE}`,
    `https://n.quiknode.pro/${FAKE}/`,
    `Authorization: Bearer ${FAKE}`,
    `Bearer ${FAKE}`,
    `{'X-API-KEY':'${FAKE}'}`,
    `sk=${fakeSecretB58()} raw ${fakeSecretB58(5)}`,
    JSON.stringify(Array.from(fakeSecretKey())),
    `phrase: ${phrase(12)}`,
  ].join(' | ');

  it('masks every class in one line and nothing secret survives', () => {
    const out = redactSecrets(everything);
    expect(out).not.toContain(FAKE);
    expect(out).not.toContain(tgToken());
    expect(out).not.toContain(fakeSecretB58());
    expect(out).not.toContain(fakeSecretB58(5));
    expect(out).not.toContain(phrase(12));
    expect(out).toContain('<private-key>');
    expect(out).toContain('[<redacted-bytes>]');
    expect(out).toContain('<seed-phrase>');
  });

  it('is idempotent', () => {
    const once = redactSecrets(everything);
    expect(redactSecrets(once)).toBe(once);
    for (const part of everything.split(' | ')) {
      const o = redactSecrets(part);
      expect(redactSecrets(o), part).toBe(o);
    }
  });

  it('leaves ordinary log lines unchanged', () => {
    const line = '[12:00:01] ✓ BUY 0.05 SOL → Fake' + '2'.repeat(36) + 'pump @ $12.3K (slippage 15%, fee 100000)';
    expect(redactSecrets(line)).toBe(line);
  });

  it('accepts non-strings and never throws', () => {
    expect(redactSecrets(null)).toBe('');
    expect(redactSecrets(undefined)).toBe('');
    expect(redactSecrets(42)).toBe('42');
    expect(redactSecrets(false)).toBe('false');
    expect(redactSecrets(Symbol('s'))).toBe('Symbol(s)');
    expect(redactSecrets(new Error(`boom https://x.alchemy.com/v2/${FAKE}`))).toBe('Error: boom https://x.alchemy.com/v2/***');
    expect(redactSecrets({ a: 1 })).toBe('[object Object]');
    const hostile = { toString() { throw new Error('nope'); } };
    expect(() => redactSecrets(hostile)).not.toThrow();
    expect(redactSecrets(hostile)).toBe('<redaction failed>');
  });

  it('handles a large input quickly', () => {
    const big = (`${phrase(11)}, ` + fakeSignature() + ' ').repeat(2000);
    const t0 = Date.now();
    expect(redactSecrets(big)).toBe(big);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

// ─── A-129 (b), finding #23: the shared rules first, then the bot-only ones (R9-FIX1) ─────────────────────────────────────────────────
describe('redactSecrets: shared rules first, then the bot-only masks', () => {
  const apiKey = ['api', 'key'].join('-');
  const ucsKey = ['UNCLAIMEDSOL', 'API', 'KEY'].join('_');
  const a32 = JSON.stringify(Array.from(fakeSecretKey().subarray(0, 32)));

  /** One input for every mask of the shared module (none holds a bot-only secret class). */
  const sharedCases = (): string[] => [
    `POST https://api.telegram.org/bot${tgToken()}/sendMessage failed`,
    `TG_BOT_TOKEN ${tgToken()} rejected`,
    `FetchError: request to https://mainnet.helius-rpc.com/?${apiKey}=${FAKE}&commitment=confirmed failed`,
    `wss://mainnet.helius-rpc.com/?${apiKey}=${FAKE}`,
    `https://solana-mainnet.g.alchemy.com/v2/${FAKE}`,
    `request to https://example-name.solana-mainnet.quiknode.pro/${FAKE}/ failed`,
    `Authorization: Bearer ${FAKE}`,
    `sent Bearer ${FAKE} upstream`,
    `{'X-API-KEY':'${FAKE}'}`,
    `x-token=${FAKE}`,
    `${ucsKey}=${FAKE}`,
    `{"${ucsKey}":"${FAKE}"}`,
    ['Bearer abcdefgh', 'SECRETPART'].join(':'),
    JSON.stringify(Array.from(fakeSecretKey())),
    a32,
    inspect(Keypair.generate().secretKey),
  ];

  it('R9FX-T04 every shared case is masked exactly as the shared module masks it, the drifted cases are closed, and every bot-only class is still masked', () => {
    // 1. shared first: on everything the shared module knows, the bot answers what the shared module answers, and no secret is left
    for (const c of sharedCases()) {
      const out = redactSecrets(c);
      expect(out, c).toBe(redactShared(c));
      expect(out, c).not.toContain(FAKE);
      expect(out, c).not.toContain('SECRETPART');
    }
    // 2. the three drifted cases of finding #23
    expect(redactSecrets(['Bearer abcdefgh', 'SECRETPART'].join(':'))).toBe('Bearer ***');            // A-98: a ":" inside the Bearer value
    expect(redactSecrets(a32)).toBe('[<redacted-bytes>]');                                              // a 32-byte seed printed as an array
    expect(redactSecrets(`${ucsKey}=${FAKE}`)).toBe(`${ucsKey}=***`);                                   // the UnclaimedSol key assignment
    // 3. the old bot-only classes the shared module lacks are all still masked
    expect(redactSecrets(`import failed for ${fakeSecretB58()}.`)).toBe('import failed for <private-key>.');
    expect(redactSecrets(`bad input: ${phrase(12)}`)).toBe('bad input: <seed-phrase>');
    expect(redactSecrets(`lastError: ${apiKey}=${FAKE}`)).toBe(`lastError: ${apiKey}=***`);              // key= outside a query string
    expect(redactSecrets(`key=${FAKE}`)).toBe('key=***');
    expect(redactSecrets('sortKey=desc monkey=banana')).toBe('sortKey=desc monkey=banana');
    // the wider bare Telegram token: 6 digits / 30 characters, and a token longer than the shared rule's exactly-35
    const short = '123456:' + 'x'.repeat(30);
    const long = '123456789:' + 'A'.repeat(45);
    expect(redactSecrets(`t=${short}`)).toBe('t=<tg-token>');
    expect(redactSecrets(`token ${long} rejected`)).toBe('token <tg-token> rejected');
    expect(redactShared(`token ${long} rejected`)).toContain(long);                                    // (the shared rule alone would have left it)
    // 4. the old bot cases and the shared cases together, idempotent, and ordinary text untouched
    const mixed = [...sharedCases(), `sk=${fakeSecretB58()}`, `phrase: ${phrase(12)}`, `lastError: ${apiKey}=${FAKE}`, short, long].join(' | ');
    const once = redactSecrets(mixed);
    expect(redactSecrets(once)).toBe(once);
    for (const secret of [FAKE, 'SECRETPART', fakeSecretB58(), phrase(12), short, long]) expect(once).not.toContain(secret);
    const ordinary = '[12:00:01] ✓ BUY 0.05 SOL → Fake' + '2'.repeat(36) + 'pump @ $12.3K (slippage 15%, fee 100000) at 22:12:53 ratio 3:1 [1,2,3]';
    expect(redactSecrets(ordinary)).toBe(ordinary);
  });

  it('a hostile value still gives "<redaction failed>" and the shared marker for bytes is the only one the bot writes', () => {
    const hostile = { toString() { throw new Error('nope'); } };
    expect(redactSecrets(hostile)).toBe('<redaction failed>');
    expect(redactSecrets(null)).toBe('');
    expect(redactSecrets(JSON.stringify(Array.from(fakeSecretKey())))).not.toContain('secret-key-bytes');
  });
});
