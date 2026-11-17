/**
 * B40 shared plumbing: the error-reason rule, ATA derivation, the timeout helper and the raw-account readers.
 */
import { randomBytes } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  ATA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, accountBytes, deriveAta, errorReason, isBase58Key, systemClock, toBigInt,
  tokenAccountAmount, tokenProgramAddress, withTimeout,
} from './exec-common';

const key = (n: number): string => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
/** A secret-shaped value generated at runtime (A-20). */
const SECRET = `k${randomBytes(12).toString('hex')}`;

describe('exec-common', () => {
  it('errorReason redacts secrets and cuts to 200 characters (B40 rule 4, plan grind #64)', () => {
    const e = new Error(`fetch failed https://rpc.example.invalid/?api-key=${SECRET} ${'z'.repeat(500)}`);
    const r = errorReason(e);
    expect(r).not.toContain(SECRET);
    expect(r.length).toBe(200);
    expect(errorReason('plain string')).toBe('plain string');
    expect(errorReason(undefined)).toBe('undefined');
    expect(errorReason({ message: 'from an object' })).toBe('from an object');
  });

  it('deriveAta matches the associated-token derivation for both programs and rejects malformed keys', () => {
    const owner = key(1);
    const mint = key(2);
    for (const [kind, program] of [['token', TOKEN_PROGRAM_ID], ['token2022', TOKEN_2022_PROGRAM_ID]] as const) {
      const expected = PublicKey.findProgramAddressSync(
        [new PublicKey(owner).toBuffer(), new PublicKey(program).toBuffer(), new PublicKey(mint).toBuffer()], new PublicKey(ATA_PROGRAM_ID),
      )[0].toBase58();
      expect(deriveAta(owner, mint, kind)).toBe(expected);
      expect(deriveAta(owner, mint, program)).toBe(expected);
      expect(tokenProgramAddress(kind)).toBe(program);
    }
    expect(deriveAta(owner, mint, 'token')).not.toBe(deriveAta(owner, mint, 'token2022'));
    expect(() => deriveAta('nope', mint, 'token')).toThrow();
    expect(isBase58Key(owner)).toBe(true);
    expect(isBase58Key('nope')).toBe(false);
    expect(isBase58Key(42)).toBe(false);
  });

  it('withTimeout resolves with the value or null on a slow promise; the system clock is real time', async () => {
    expect(await withTimeout(Promise.resolve(7), 50)).toBe(7);
    expect(await withTimeout(new Promise<number>(() => undefined), 10)).toBeNull();
    const t0 = systemClock.now();
    await systemClock.sleep(5);
    expect(systemClock.now()).toBeGreaterThanOrEqual(t0);
  });

  it('reads token-account amounts and RPC integers without precision loss', () => {
    const acct = Buffer.alloc(165);
    acct.writeBigUInt64LE(18_446_744_073_709_551_615n, 64);
    expect(tokenAccountAmount(acct)).toBe(18_446_744_073_709_551_615n);
    expect(tokenAccountAmount(Buffer.alloc(10))).toBeNull();
    expect(tokenAccountAmount(null)).toBeNull();
    expect(accountBytes({ data: [acct.toString('base64'), 'base64'] })?.length).toBe(165);
    expect(accountBytes({ data: { parsed: {} } })).toBeNull();
    expect(toBigInt('9007199254740993')).toBe(9_007_199_254_740_993n);
    expect(toBigInt(12)).toBe(12n);
    expect(toBigInt(1.5)).toBeNull();
    expect(toBigInt(undefined)).toBeNull();
    expect(toBigInt('12abc')).toBeNull();
  });
});
