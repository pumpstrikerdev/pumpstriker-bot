/**
 * logger.ts — the one redaction point (WI-F §3.3.11, §6.3, threat T2b).
 *
 * log() must run every line through redactSecrets() BEFORE it reaches the
 * console or the SSE broadcast. Every secret below is built at runtime (fixed
 * seeds, invented values) — no real key, token or URL appears in this file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';
import { Keypair } from '@solana/web3.js';
import { log, logOk, logWarn, logErr, logDbg, setBroadcast } from './logger';

/** Deterministic 32-byte seed. */
const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 31 + n * 7 + 1) & 0xff);

/** Bot-token shape (`<id>:<35 chars>`), assembled at runtime. */
const FAKE_BOT_TOKEN = ['8', '1234567', '0', ':', 'AAF', 'x'.repeat(16), 'FAKE', 'y'.repeat(12)].join('');
/** Generated keypair secret (base58, 64 bytes = seed ‖ pubkey). */
const KEYPAIR_SECRET = bs58.encode(Keypair.fromSeed(seed(1)).secretKey);
/** A real ed25519 signature, base58 (a tx-signature shape) — must stay visible. */
function txSignature(): string {
  for (let n = 0; n < 64; n++) {
    const s = bs58.encode(ed25519.sign(Uint8Array.of(1, 2, 3, n), seed(n + 2)));
    if (s.length === 88) return s;
  }
  throw new Error('no 88-char signature found');
}
const TX_SIG = txSignature();
/** A 44-char wallet address — must stay visible. */
const ADDRESS = (() => {
  for (let n = 0; n < 64; n++) {
    const a = Keypair.fromSeed(seed(n + 100)).publicKey.toBase58();
    if (a.length === 44) return a;
  }
  throw new Error('no 44-char address found');
})();
const RPC_URL = 'https://rpc.example.invalid/?' + 'api' + '-key=' + 'FAKEKEY0123456789abcdef';
const BEARER  = 'Bearer ' + 'fake-shared-secret-' + 'z'.repeat(24);

describe('logger: one redaction point', () => {
  let out: string[];
  let spy: { mockRestore: () => void };
  let broadcast: Array<{ event: string; data: any }>;

  beforeEach(() => {
    out = [];
    broadcast = [];
    spy = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => { out.push(args.join(' ')); });
    setBroadcast((event, data) => { broadcast.push({ event, data }); });
  });
  afterEach(() => {
    spy.mockRestore();
    setBroadcast(() => {});
  });

  it('fixtures have the intended shapes', () => {
    expect(TX_SIG).toHaveLength(88);
    expect(ADDRESS).toHaveLength(44);
    expect(KEYPAIR_SECRET.length).toBeGreaterThanOrEqual(80);
    expect(/\d{8,10}:[A-Za-z0-9_-]{35}/.test(FAKE_BOT_TOKEN)).toBe(true);
  });

  it('masks a bot token, an api-key URL, a Bearer secret and a keypair secret on the console', () => {
    log(`tg ${FAKE_BOT_TOKEN} rpc ${RPC_URL} auth ${BEARER} key ${KEYPAIR_SECRET}`);
    expect(out).toHaveLength(1);
    const line = out[0];
    expect(line).not.toContain(FAKE_BOT_TOKEN);
    expect(line).not.toContain('FAKEKEY0123456789abcdef');
    expect(line).not.toContain('fake-shared-secret-');
    expect(line).not.toContain(KEYPAIR_SECRET);
    expect(line).toContain('***');
    expect(line).toContain('<private-key>');
  });

  it('masks the same secrets in the SSE broadcast payload', () => {
    logErr(`failed: request to https://api.telegram.org/bot${FAKE_BOT_TOKEN}/sendMessage, ${RPC_URL}, ${BEARER}, ${KEYPAIR_SECRET}`);
    expect(broadcast).toHaveLength(1);
    expect(broadcast[0].event).toBe('log');
    const msg: string = broadcast[0].data.msg;
    expect(broadcast[0].data.level).toBe('err');
    expect(msg).not.toContain(FAKE_BOT_TOKEN);
    expect(msg).not.toContain('FAKEKEY0123456789abcdef');
    expect(msg).not.toContain('fake-shared-secret-');
    expect(msg).not.toContain(KEYPAIR_SECRET);
    expect(out[0]).toContain(msg);   // console and broadcast carry the same redacted text
  });

  it('never masks a 44-char address or an 88-char transaction signature', () => {
    logOk(`bought ${ADDRESS} tx ${TX_SIG}`);
    expect(out[0]).toContain(ADDRESS);
    expect(out[0]).toContain(TX_SIG);
    expect(broadcast[0].data.msg).toBe(`bought ${ADDRESS} tx ${TX_SIG}`);
  });

  it('every level helper goes through the same redaction', () => {
    for (const fn of [logOk, logWarn, logErr, logDbg, (m: string) => log(m)]) fn(`x ${KEYPAIR_SECRET}`);
    expect(out).toHaveLength(5);
    for (const l of out) {
      expect(l).not.toContain(KEYPAIR_SECRET);
      expect(l).toContain('<private-key>');
    }
    expect(broadcast.map(b => b.data.level)).toEqual(['ok', 'warn', 'err', 'debug', 'info']);
  });

  it('leaves ordinary lines unchanged', () => {
    const plain = '[signal] PP-ULTRA 93 fired, mcap $33,231 (score 93/100)';
    log(plain);
    expect(broadcast[0].data.msg).toBe(plain);
    expect(out[0]).toContain(plain);
  });
});
