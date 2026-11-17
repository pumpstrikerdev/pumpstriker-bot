/**
 * Trading-session time window (2026-07-08).
 *
 * The operator picks a market session (USA / Europe / Asia preset) or custom
 * start/stop times in an IANA timezone; while the window is CLOSED the bot's
 * /signal endpoint declines AUTO-BUY only — signal pings keep arriving 24/7,
 * and RUG alerts + auto-exit are never gated. Overnight windows (start > end,
 * e.g. 22:00–06:00) wrap past midnight.
 */

export interface SessionPreset { label: string; tz: string; start: string; end: string }

export const SESSION_PRESETS: Record<string, SessionPreset> = {
  usa:    { label: '🇺🇸 USA',    tz: 'America/New_York', start: '08:00', end: '17:00' },
  europe: { label: '🇪🇺 Europe', tz: 'Europe/London',    start: '08:00', end: '17:00' },
  asia:   { label: '🌏 Asia',    tz: 'Asia/Tokyo',       start: '09:00', end: '18:00' },
};

/** "HH:MM" (24h) → minutes since midnight, or null when malformed. */
export function parseHHMM(v: any): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? '').trim());
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

export function isValidTz(tz: any): boolean {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }); return true; } catch { return false; }
}

/** Current minutes-since-midnight in tz, or null when tz is invalid. */
export function minutesNowInTz(tz: string, at: Date = new Date()): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(at);
    const h = Number(parts.find(p => p.type === 'hour')?.value);
    const m = Number(parts.find(p => p.type === 'minute')?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return (h % 24) * 60 + m; // Intl can render midnight as "24"
  } catch { return null; }
}

/** "HH:MM" clock string in tz right now — display only. */
export function timeNowInTz(tz: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(at);
  } catch { return '??:??'; }
}

/**
 * True when signals may fire right now. Fail-OPEN: malformed times, an
 * invalid timezone, or start === end never silently block trading — the
 * window is an operator preference, not a safety gate.
 */
export function isSessionOpen(sig: any, at: Date = new Date()): boolean {
  if (!sig?.sessionEnabled) return true;
  const start = parseHHMM(sig.sessionStart);
  const end   = parseHHMM(sig.sessionEnd);
  const now   = minutesNowInTz(String(sig.sessionTz || 'UTC'), at);
  if (start === null || end === null || now === null || start === end) return true;
  return start < end ? (now >= start && now < end) : (now >= start || now < end);
}
