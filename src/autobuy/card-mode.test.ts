/**
 * A-115 (review P1): the auto-buy line of a signal card must say what a buy from this card really does. The persisted mode alone is not
 * that: BOT_DRY_RUN (on unless an explicit off word), a live state without its confirmation and a pause all change the real path
 * (decide.ts step 1 and step 9, api.ts `const dry = d.forceDryRun || !liveStateComplete(...) || deps.dryRun()`).
 */
import { describe, expect, it } from 'vitest';
import { autoBuyText } from '../shared/card/playbook';
import type { Heartbeat } from '../shared/contract/v1';
import { cardAutoBuy } from './card-mode';
import { dryRunFromEnv } from './guards';
import { makeHarness } from './autobuy-testkit';

type Hb = Heartbeat['autobuy'];
const LIVE: Hb = { enabled: true, mode: 'live', arm: 'B1', report_id: 'report-b1-0001', confirmed_at: 1_790_000_000_000, dry_run: false, paused: null };

describe('cardAutoBuy (the card auto-buy line from the heartbeat)', () => {
  it('CARD-T16 mode live with BOT_DRY_RUN unset is a DRY RUN on the card, never LIVE; LIVE only when the live state is complete and BOT_DRY_RUN is off', () => {
    expect(dryRunFromEnv({})).toBe(true);                                  // the default the owner runs with
    const unset = cardAutoBuy({ ...LIVE, dry_run: dryRunFromEnv({}) }, 0.5);
    expect(unset).toMatchObject({ mode: 'dry_run', arm: 'B1', buySol: 0.5 });
    expect(autoBuyText(unset)).toBe('Auto-buy: DRY RUN on arm B1 (BOT_DRY_RUN on: nothing is sent) · size 0.5 SOL');
    expect(autoBuyText(cardAutoBuy({ ...LIVE, dry_run: dryRunFromEnv({ BOT_DRY_RUN: '0' }) }, 0.5))).toBe('Auto-buy: LIVE on arm B1 · size 0.5 SOL');
  });

  it('CARD-T16b a live state without its confirmation buys nothing (decide step 1): the card says OFF with the reason', () => {
    for (const hole of [{ arm: null }, { report_id: null }, { confirmed_at: null }] as Array<Partial<Hb>>) {
      for (const dry of [true, false]) {
        const a = cardAutoBuy({ ...LIVE, ...hole, dry_run: dry }, 0.5);
        expect(a.mode).toBe('off');
        expect(autoBuyText(a)).toBe('Auto-buy: OFF (live not confirmed: nothing is bought) · size 0.5 SOL');
      }
    }
  });

  it('CARD-T16c a pause holds every auto-buy, live or dry run: the card says PAUSED with the reason, never LIVE', () => {
    expect(autoBuyText(cardAutoBuy({ ...LIVE, paused: 'paused_fails' }, 0.5)))
      .toBe('Auto-buy: PAUSED (paused_fails) · no buy until /autobuy resume · set: LIVE on arm B1 · size 0.5 SOL');
    expect(autoBuyText(cardAutoBuy({ ...LIVE, dry_run: true, paused: 'paused_breaker' }, null)))
      .toBe('Auto-buy: PAUSED (paused_breaker) · no buy until /autobuy resume · set: DRY RUN on arm B1 (BOT_DRY_RUN on: nothing is sent)');
    expect(autoBuyText(cardAutoBuy({ ...LIVE, mode: 'dry_run', arm: 'BS', report_id: null, confirmed_at: null, paused: 'paused_rolling' }, null)))
      .toBe('Auto-buy: PAUSED (paused_rolling) · no buy until /autobuy resume · set: DRY RUN on arm BS');
    expect(autoBuyText(cardAutoBuy({ ...LIVE, mode: 'off', enabled: false, arm: null, report_id: null, confirmed_at: null, paused: 'paused_fails' }, null)))
      .toBe('Auto-buy: OFF');
  });

  it('CARD-T16d mode dry_run is a DRY RUN whatever BOT_DRY_RUN says; a dry run without an arm is OFF; a bad size is left out', () => {
    const dr: Hb = { enabled: true, mode: 'dry_run', arm: 'BS', report_id: null, confirmed_at: null, dry_run: false, paused: null };
    expect(autoBuyText(cardAutoBuy(dr, 0.01))).toBe('Auto-buy: DRY RUN on arm BS · size 0.01 SOL');
    expect(autoBuyText(cardAutoBuy({ ...dr, arm: null }, 0.01))).toBe('Auto-buy: OFF (no dry-run arm) · size 0.01 SOL');
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null]) expect(cardAutoBuy(dr, bad).buySol).toBeNull();
  });

  it('CARD-T16e from the real service: armed live with BOT_DRY_RUN unset, the heartbeat still says mode live and the card says DRY RUN', async () => {
    const h = makeHarness({ env: {} });
    h.flags.dryRun = dryRunFromEnv({});                                    // the app wires dryRun: () => dryRunFromEnv(env)
    await h.goLive();
    const ab = h.svc.heartbeat().autobuy;
    expect(ab.mode).toBe('live');
    expect(ab.dry_run).toBe(true);
    const text = autoBuyText(cardAutoBuy(ab, 0.01));
    expect(text).toMatch(/^Auto-buy: DRY RUN on arm \w+ \(BOT_DRY_RUN on: nothing is sent\)/);
    expect(text).not.toContain('LIVE');
  });
});
