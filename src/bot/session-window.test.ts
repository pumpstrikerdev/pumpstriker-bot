/**
 * Unit tests for the trading-session time window (2026-07-08).
 * The gate must be fail-OPEN: any malformed config lets signals through —
 * a typo in a timezone must never silently halt trading.
 */
import { describe, expect, it } from 'vitest';
import { parseHHMM, isValidTz, minutesNowInTz, isSessionOpen, SESSION_PRESETS } from './session-window';

// 2026-07-08T12:00:00Z — fixed instant so assertions are deterministic.
const NOON_UTC = new Date('2026-07-08T12:00:00Z');
const utcWindow = (start: string, end: string, enabled = true) =>
  ({ sessionEnabled: enabled, sessionStart: start, sessionEnd: end, sessionTz: 'UTC' });

describe('parseHHMM', () => {
  it('parses valid 24h times', () => {
    expect(parseHHMM('00:00')).toBe(0);
    expect(parseHHMM('08:00')).toBe(480);
    expect(parseHHMM('8:00')).toBe(480);   // single-digit hour allowed
    expect(parseHHMM('23:59')).toBe(1439);
    expect(parseHHMM(' 17:30 ')).toBe(1050); // tolerant of stray whitespace
  });

  it('rejects malformed input', () => {
    for (const bad of ['24:00', '12:60', '9', '9:5', 'noon', '', null, undefined, '12:00pm']) {
      expect(parseHHMM(bad)).toBeNull();
    }
  });
});

describe('isValidTz', () => {
  it('accepts the preset zones and common IANA names', () => {
    for (const p of Object.values(SESSION_PRESETS)) expect(isValidTz(p.tz)).toBe(true);
    expect(isValidTz('UTC')).toBe(true);
    expect(isValidTz('Europe/Paris')).toBe(true);
  });

  it('rejects garbage', () => {
    expect(isValidTz('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTz('')).toBe(false);
    expect(isValidTz(null)).toBe(false);
  });
});

describe('minutesNowInTz', () => {
  it('computes minutes since midnight in the given zone', () => {
    expect(minutesNowInTz('UTC', NOON_UTC)).toBe(720);
    expect(minutesNowInTz('Asia/Tokyo', NOON_UTC)).toBe(1260);       // UTC+9 → 21:00
    expect(minutesNowInTz('America/New_York', NOON_UTC)).toBe(480);  // EDT (UTC-4) → 08:00
  });

  it('returns null for an invalid zone', () => {
    expect(minutesNowInTz('Not/AZone', NOON_UTC)).toBeNull();
  });
});

describe('isSessionOpen', () => {
  it('is always open when the window is disabled or settings are missing', () => {
    expect(isSessionOpen(utcWindow('13:00', '14:00', false), NOON_UTC)).toBe(true);
    expect(isSessionOpen(undefined, NOON_UTC)).toBe(true);
    expect(isSessionOpen({}, NOON_UTC)).toBe(true);
  });

  it('opens inside and closes outside a normal (same-day) window', () => {
    expect(isSessionOpen(utcWindow('08:00', '17:00'), NOON_UTC)).toBe(true);   // 12:00 in window
    expect(isSessionOpen(utcWindow('13:00', '17:00'), NOON_UTC)).toBe(false);  // before start
    expect(isSessionOpen(utcWindow('08:00', '12:00'), NOON_UTC)).toBe(false);  // end is exclusive
    expect(isSessionOpen(utcWindow('12:00', '17:00'), NOON_UTC)).toBe(true);   // start is inclusive
  });

  it('wraps past midnight when stop is before start (overnight window)', () => {
    expect(isSessionOpen(utcWindow('22:00', '06:00'), NOON_UTC)).toBe(false);       // noon outside
    const threeAm = new Date('2026-07-08T03:00:00Z');
    expect(isSessionOpen(utcWindow('22:00', '06:00'), threeAm)).toBe(true);          // 03:00 inside
    const elevenPm = new Date('2026-07-08T23:00:00Z');
    expect(isSessionOpen(utcWindow('22:00', '06:00'), elevenPm)).toBe(true);         // 23:00 inside
  });

  it('respects the configured timezone, not the host clock', () => {
    // 12:00 UTC = 08:00 in New York (EDT) — an 08:00–17:00 NY window is open,
    // but the same window in Tokyo (21:00 local) is closed.
    const ny  = { sessionEnabled: true, sessionStart: '08:00', sessionEnd: '17:00', sessionTz: 'America/New_York' };
    const tyo = { sessionEnabled: true, sessionStart: '08:00', sessionEnd: '17:00', sessionTz: 'Asia/Tokyo' };
    expect(isSessionOpen(ny, NOON_UTC)).toBe(true);
    expect(isSessionOpen(tyo, NOON_UTC)).toBe(false);
  });

  it('fails OPEN on malformed config — never silently blocks trading', () => {
    expect(isSessionOpen({ sessionEnabled: true, sessionStart: 'bogus', sessionEnd: '17:00', sessionTz: 'UTC' }, NOON_UTC)).toBe(true);
    expect(isSessionOpen({ sessionEnabled: true, sessionStart: '08:00', sessionEnd: '17:00', sessionTz: 'Not/AZone' }, NOON_UTC)).toBe(true);
    expect(isSessionOpen(utcWindow('08:00', '08:00'), NOON_UTC)).toBe(true);   // zero-width window
  });
});
