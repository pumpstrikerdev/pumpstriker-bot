// R1-B1: the ULID generator behind the bot-to-Engine event ids.
import { describe, expect, it } from 'vitest';
import { validateBotBatch } from '../shared/contract/validate';
import { createUlidFactory, ULID_RE } from './ulid';
import { fixture, FIXTURE_NOW } from './link-testkit';

describe('ulid', () => {
  it('makes 26-character Crockford ids that the contract validator accepts', () => {
    const next = createUlidFactory(() => FIXTURE_NOW);
    const id = next();
    expect(id).toMatch(ULID_RE);
    const ev = fixture('delivery.buy');
    ev.event_id = id;
    const verdict = validateBotBatch({ events: [ev] }, FIXTURE_NOW + 1_000);
    expect(verdict.ok && verdict.events[0].result.ok).toBe(true);
  });

  it('sorts by time, stays unique and increasing inside one millisecond, and never goes backwards when the clock does', () => {
    let t = FIXTURE_NOW;
    const next = createUlidFactory(() => t);
    const same = Array.from({ length: 1000 }, () => next());
    expect(new Set(same).size).toBe(1000);
    expect([...same].sort()).toEqual(same);
    t += 1;
    const later = next();
    expect(later > same[same.length - 1]).toBe(true);
    t -= 5_000;                                                      // the wall clock stepped back
    const after = next();
    expect(after > later).toBe(true);
    expect(after.slice(0, 10)).toBe(later.slice(0, 10));
  });

  it('encodes the millisecond time in the first 10 characters', () => {
    const a = createUlidFactory(() => 0)();
    expect(a.slice(0, 10)).toBe('0000000000');
    const b = createUlidFactory(() => 32)();
    expect(b.slice(0, 10)).toBe('0000000010');
    expect(createUlidFactory(() => FIXTURE_NOW)().slice(0, 10)).toMatch(/^[0-7][0-9A-Z]{9}$/);
  });
});
