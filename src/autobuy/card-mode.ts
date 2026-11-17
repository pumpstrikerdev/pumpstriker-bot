// A-115 (review P1): the auto-buy line of a signal card (and of the bot's menus) from the heartbeat, worked out the way the buy path
// really decides, so the owner is never told "LIVE" while every buy runs as a dry run or does not run at all:
//   - decide.ts step 1: mode live without a complete live state (arm, report id, confirmed_at) is OFF: nothing is bought;
//   - api.ts execute: `const dry = d.forceDryRun || !liveStateComplete(...) || deps.dryRun()`: mode live with BOT_DRY_RUN on (the default,
//     guards.ts dryRunFromEnv) only builds and signs, never sends: a DRY RUN;
//   - decide.ts step 1: mode dry_run without a dry-run arm is OFF; mode dry_run never sends whatever BOT_DRY_RUN says;
//   - decide.ts step 9: a pause (paused_fails, paused_rolling, paused_breaker, ...) holds every auto-buy, live or dry run.
// Pure: no clock, no I/O.
import type { PlaybookAutoBuy } from '../shared/card/playbook';
import type { Heartbeat } from '../shared/contract/v1';
import { liveStateComplete } from './decide';

export const NOTE_BOT_DRY_RUN = 'BOT_DRY_RUN on: nothing is sent';
export const NOTE_LIVE_UNCONFIRMED = 'live not confirmed: nothing is bought';
export const NOTE_NO_DRY_ARM = 'no dry-run arm';

/** What a buy from a card would REALLY do now, from the heartbeat (Heartbeat.autobuy) and the buy size (null or a bad size = left out). */
export function cardAutoBuy(ab: Heartbeat['autobuy'], buySol: number | null): PlaybookAutoBuy {
  const size = buySol !== null && Number.isFinite(buySol) && buySol > 0 ? buySol : null;
  const out = (mode: PlaybookAutoBuy['mode'], arm: PlaybookAutoBuy['arm'], note: string | null): PlaybookAutoBuy => {
    const r: PlaybookAutoBuy = { mode, arm, buySol: size };
    if (note !== null) r.note = note;
    if (mode !== 'off' && ab.paused !== null && ab.paused !== undefined) r.paused = ab.paused;
    return r;
  };
  if (ab.mode === 'live') {
    if (!liveStateComplete({ mode: 'live', liveArm: ab.arm, liveReportId: ab.report_id, liveConfirmedAt: ab.confirmed_at })) {
      return out('off', null, NOTE_LIVE_UNCONFIRMED);
    }
    // a heartbeat that cannot say BOT_DRY_RUN is off is treated as on (the safe side)
    if (ab.dry_run !== false) return out('dry_run', ab.arm, NOTE_BOT_DRY_RUN);
    return out('live', ab.arm, null);
  }
  if (ab.mode === 'dry_run') return ab.arm === null ? out('off', null, NOTE_NO_DRY_ARM) : out('dry_run', ab.arm, null);
  return out('off', null, null);
}
