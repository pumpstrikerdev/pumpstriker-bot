// R1-B1 (B10): ULID generator for the events the bot sends to the Engine (event_id is a ULID, stable across retries; C02 section 2).
// 48-bit timestamp + 80 random bits in Crockford base32, 26 characters, monotonic within one millisecond. Ids are generated at runtime
// (planner amendment A-20: no id-shaped literal in fixtures).
import crypto from 'crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_BITS = 80n;
const RANDOM_MASK = (1n << RANDOM_BITS) - 1n;

/** The ULID shape the contract validator accepts. */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function encodeTime(ms: number): string {
  let t = Math.max(0, Math.floor(ms));
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(r: bigint): string {
  let out = '';
  let v = r;
  for (let i = 0; i < 16; i++) {
    out = ALPHABET[Number(v & 31n)] + out;
    v >>= 5n;
  }
  return out;
}

function freshRandom(): bigint {
  return BigInt('0x' + crypto.randomBytes(10).toString('hex'));
}

/** A ULID factory over a time source (the injected Clock's now). Two ids made in the same millisecond still sort in creation order. */
export function createUlidFactory(now: () => number): () => string {
  let lastMs = -1;
  let lastRandom = 0n;
  return () => {
    const ms = Math.max(Math.floor(now()), lastMs);
    if (ms === lastMs) {
      lastRandom = (lastRandom + 1n) & RANDOM_MASK;
      if (lastRandom === 0n) lastRandom = freshRandom();   // 2^80 ids in one millisecond: start over rather than repeat
    } else {
      lastMs = ms;
      lastRandom = freshRandom();
    }
    return encodeTime(ms) + encodeRandom(lastRandom);
  };
}
