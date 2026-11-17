/**
 * The auto-buy service (B20 sections 2-4) end to end on stubs: decide, execute (live and dry run), the confirm loop, pauses, boot recovery.
 * The router stub sits on the real A-26 send gate, so `router.sends` is exactly the number of transactions a real sender would get.
 * Every test has its own temp folder and one FakeClock; no network, no wallet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createIntake } from '../intake/handlers';
import { createUlidFactory } from '../link/ulid';
import { cleanupTempDirs, newTestUlid, StubExits, tempDir } from '../link/link-testkit';
import { RouterSendError } from '../execution/router';
import type { TgQueue } from '../bot-contracts';
import type { SignalRegistry } from '../link/inbox';
import { validateBotBatch } from '../shared/contract/validate';
import type { ArmsStatusPayload } from '../shared/contract/v1';
import { AUTO_BUY_CAPS_FILENAME, AutoBuyCaps } from '../bot/trade-guards';
import { CONFIRM_FAST_WINDOW_MS, OPEN_RETRIES_MAX, type ClosedPositionInfo } from './api';
import { newSig, makeHarness, QUOTE_TOKENS, type Harness, WALLET_ID, OWNER_ADDR } from './autobuy-testkit';
import { LEDGER_FILE } from './guards';
import { PENDING_FILE } from './pending';
import { STATE_FILE } from './state';

afterAll(() => { cleanupTempDirs(); });

const types = (h: Harness): string[] => h.outbox.events.map(e => e.type);
const tx = (x: { tx: string | null } | null): string => {
  if (x === null || x.tx === null) throw new Error('no transaction');
  return x.tx;
};
/** Lets the confirm loop of one landed transaction run. */
async function land(h: Harness, sig: string): Promise<void> {
  h.rpc.land(sig);
  await h.advance(1_000);
}
const closed = (i: number, over: Partial<ClosedPositionInfo> = {}): ClosedPositionInfo => ({
  origin: 'signal', dryRun: false, entryTx: `entry-tx-${i}`, fillSource: 'tx_meta', realizedNetLamports: '-3000000', solSpentLamports: '10000000', closedAt: i, ...over,
});

describe('dry run', () => {
  it('B2-T08 a dry run sends no transaction, opens a virtual position and writes no journal entry', async () => {
    const h = makeHarness();
    await h.armDry('B1');
    const { env, d, x } = await h.run();
    expect(d).toEqual({ action: 'buy', reason: null, arm: 'B1', forceDryRun: true });
    expect(x).toMatchObject({ status: 'dry_run', tx: null, error: null, route: 'pf-direct', solInLamports: '10000000', quoteTokensOut: QUOTE_TOKENS.toString() });
    expect(x?.stamps.signedAt).not.toBeNull();
    expect(x?.stamps.submittedAt).toBeNull();

    // zero sends: the router was asked to build only, and its sender was never reached
    expect(h.router.sends).toEqual([]);
    expect(h.router.calls).toHaveLength(1);
    expect(h.router.calls[0].opts).toMatchObject({ buildOnly: true, singleSend: true, maxImpactPct: 15, slippageBps: 300, awaitFill: false });
    expect(h.router.calls[0].opts.onSigned).toBeUndefined();
    expect(h.rpc.calls).toEqual({ statuses: 0, height: 0, balance: 0 });

    // a virtual position, reported as a dry-run position
    expect(h.positions.real).toHaveLength(0);
    expect(h.positions.virtual).toHaveLength(1);
    expect(h.positions.virtual[0]).toMatchObject({ dry_run: true, ca: env.ca, wallet_id: WALLET_ID, arm: 'B1', entry: { tx: null, fill_source: 'quote_dry_run' } });
    const opened = h.outbox.of('position.opened');
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toMatchObject({ dry_run: true, fill_source: 'quote_dry_run', entry_tx: null, origin: 'signal', arm: 'B1' });
    expect(opened[0].signal_id).toBe(env.signal_id);

    // no journal, no ledger, no caps, no failure count
    expect(h.journal()).toEqual([]);
    expect(fs.existsSync(path.join(h.dir, PENDING_FILE))).toBe(false);
    expect(fs.existsSync(path.join(h.dir, LEDGER_FILE))).toBe(false);
    expect(h.caps.usage(h.clock.now())).toEqual({ lastHour: 0, lastDay: 0, solLastDay: 0 });
    expect(h.stateFile().consecutive_fails).toBe(0);
    await h.advance(120_000);                                  // and no confirm loop is waiting for a transaction that does not exist
    expect(h.rpc.calls).toEqual({ statuses: 0, height: 0, balance: 0 });
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it('B2-T12 dryrun B1 armed, BOT_DRY_RUN off and B1 PASS: the decision is buy with forceDryRun, execute is dry_run and nothing is sent', async () => {
    const h = makeHarness();
    h.svc.onArmsStatus(h.engine.set('B1', 'PASS'));
    await h.armDry('B1');
    h.flags.dryRun = false;                                    // BOT_DRY_RUN=0
    const { d, x } = await h.run();
    expect(d).toEqual({ action: 'buy', reason: null, arm: 'B1', forceDryRun: true });
    expect(x?.status).toBe('dry_run');
    expect(h.router.sends).toHaveLength(0);
    expect(h.router.calls.every(c => c.opts.buildOnly === true)).toBe(true);
    expect(h.positions.real).toHaveLength(0);
  });

  it('B2-T13 a decision that says live still cannot send once the state is dry_run, BOT_DRY_RUN is on, or the mode is off: zero sends', async () => {
    // (1) dry_run mode at execute time, BOT_DRY_RUN=0, and a decision (taken earlier, under live) that does not force a dry run
    const h = makeHarness();
    await h.goLive();
    const a = h.signal();
    h.registry.set(a.env.ca as string, a.env.signal_id as string);
    const live = h.svc.decide(a.sig, a.env, h.clock.now(), h.clock.now());
    expect(live).toEqual({ action: 'buy', reason: null, arm: 'B1', forceDryRun: false });
    await h.owner('/autobuy off');
    await h.armDry('B1');
    h.flags.dryRun = false;
    expect((await h.svc.execute(a.sig, a.env, live)).status).toBe('dry_run');
    expect(h.router.sends).toHaveLength(0);

    // (2) live mode and a live decision, then BOT_DRY_RUN is switched on before the send
    const h2 = makeHarness();
    await h2.goLive();
    const b = h2.signal();
    h2.registry.set(b.env.ca as string, b.env.signal_id as string);
    const live2 = h2.svc.decide(b.sig, b.env, h2.clock.now(), h2.clock.now());
    expect(live2.forceDryRun).toBe(false);
    h2.flags.dryRun = true;
    expect((await h2.svc.execute(b.sig, b.env, live2)).status).toBe('dry_run');
    expect(h2.router.sends).toHaveLength(0);
    expect(h2.router.calls[0].opts.buildOnly).toBe(true);

    // (3) the owner switches auto-buy off between the decision and the send
    const h3 = makeHarness();
    await h3.goLive();
    const c = h3.signal();
    h3.registry.set(c.env.ca as string, c.env.signal_id as string);
    const live3 = h3.svc.decide(c.sig, c.env, h3.clock.now(), h3.clock.now());
    await h3.owner('/autobuy off');
    const out = await h3.svc.execute(c.sig, c.env, live3);
    expect(out).toMatchObject({ status: 'failed', error: 'auto-buy is off' });
    expect(h3.router.calls).toHaveLength(0);
    expect(h3.router.sends).toHaveLength(0);
  });

  it('BOT_DRY_RUN on in live mode turns the decision into a forced dry run', async () => {
    const h = makeHarness();
    await h.goLive();
    h.flags.dryRun = true;
    const { d, x } = await h.run();
    expect(d.forceDryRun).toBe(true);
    expect(x?.status).toBe('dry_run');
    expect(h.router.sends).toHaveLength(0);
  });

  it('a dry-run failure is reported as failed, does not count toward the pause, and leaves the ledger and caps alone', async () => {
    const h = makeHarness();
    await h.armDry('B1');
    h.router.failBefore = new Error('could not build the swap');
    for (let i = 0; i < 4; i++) {
      const { x } = await h.run();
      expect(x).toMatchObject({ status: 'failed', error: 'could not build the swap' });
    }
    expect(h.stateFile()).toMatchObject({ pause: null, consecutive_fails: 0, mode: 'dry_run' });
    expect(h.positions.virtual).toHaveLength(0);
    h.router.impactPct = 40;
    h.router.failBefore = null;
    const refused = await h.run();
    expect(refused.x?.error).toMatch(/^impact_cap:/);
  });

  it('a router that reports a send during a dry run stops everything: auto-buy off and an owner notice', async () => {
    const h = makeHarness();
    await h.armDry('B1');
    h.router.reportSentOnBuildOnly = true;
    const { x } = await h.run();
    expect(x?.status).toBe('failed');
    expect(h.stateFile().mode).toBe('off');
    expect(h.notices.join('\n')).toMatch(/DRY RUN SAFETY STOP/);
    expect(h.positions.virtual).toHaveLength(0);
  });
});

describe('live buy', () => {
  it('journals before the send, resolves submitted right after it, then the confirm opens the position and reports in order', async () => {
    const h = makeHarness();
    await h.goLive();
    const startedAt = h.clock.now();
    const { env, d, x } = await h.run();
    expect(d).toEqual({ action: 'buy', reason: null, arm: 'B1', forceDryRun: false });
    expect(x).toMatchObject({ status: 'submitted', error: null, route: 'pf-direct', solInLamports: '10000000', quoteTokensOut: QUOTE_TOKENS.toString() });
    const sig = tx(x);
    expect(x?.stamps).toEqual({ decidedAt: startedAt, signedAt: startedAt, submittedAt: startedAt });

    // the router got exactly the A-26 options of the note
    expect(h.router.calls).toHaveLength(1);
    const opts = h.router.calls[0].opts;
    expect(opts).toMatchObject({ singleSend: true, maxImpactPct: 15, slippageBps: 300, awaitFill: false });
    expect(opts.buildOnly).toBeUndefined();
    expect(typeof opts.onSigned).toBe('function');
    expect(h.router.calls[0]).toMatchObject({ mint: env.ca, solIn: 0.01 });

    // exactly one send, and the journal and the ledger already held it when the sender was reached
    expect(h.router.sends).toHaveLength(1);
    expect(h.router.sends[0]).toMatchObject({ sig, journalHadSig: true, ledgerHadCa: true });
    expect(h.journal()).toHaveLength(1);
    expect(h.journal()[0]).toMatchObject({
      sig, signal_id: env.signal_id, ca: env.ca, wallet_id: WALLET_ID, owner: OWNER_ADDR, arm: 'B1', route: 'pf-direct',
      sol_in_lamports: '10000000', quote_tokens_out: QUOTE_TOKENS.toString(), last_valid_block_height: 1_150,
    });
    // nothing is a position yet; the in-flight buy already counts against the caps
    expect(h.positions.real).toHaveLength(0);
    expect(h.caps.usage(h.clock.now()).lastHour).toBe(1);
    expect(types(h)).toEqual([]);

    await land(h, sig);
    expect(h.positions.real).toHaveLength(1);
    expect(h.positions.real[0]).toMatchObject({ ca: env.ca, signal_id: env.signal_id, dry_run: false, entry: { tx: sig, fill_source: 'tx_meta', tokens_raw: '1666000000000' } });
    expect(h.journal()).toEqual([]);
    // position.opened, then delivery.buy confirmed (the journal entry is gone before the confirmation is reported)
    expect(types(h)).toEqual(['position.opened', 'delivery.buy']);
    expect(h.outbox.of('delivery.buy')[0]).toMatchObject({
      signal_id: env.signal_id, ca: env.ca,
      payload: {
        status: 'confirmed', reason: null, arm: 'B1', tx: sig, error: null, route: 'pf-direct', sol_in_lamports: '10000000',
        quote_tokens_out: QUOTE_TOKENS.toString(), stamps: { received_at: startedAt, decided_at: startedAt, signed_at: startedAt, submitted_at: startedAt, confirmed_at: h.clock.now() },
      },
    });
    expect(h.outbox.of('position.opened')[0].payload).toMatchObject({ dry_run: false, fill_source: 'tx_meta', entry_tx: sig, tokens_raw: '1666000000000', wallet_id: WALLET_ID });
    // the reservation became a recorded buy, persisted
    expect(new AutoBuyCaps(path.join(h.dir, AUTO_BUY_CAPS_FILENAME), { perHour: 3, perDay: 20, solPerDay: 1 }).usage(h.clock.now()).lastHour).toBe(1);
    expect(h.stateFile().consecutive_fails).toBe(0);
    expect(h.clock.pendingTimers()).toBe(0);
    // every event validates against the contract
    const batch = validateBotBatch({ events: h.outbox.events }, h.clock.now());
    expect(batch.ok).toBe(true);
    if (batch.ok) for (const e of batch.events) expect(e.result, e.index.toString()).toMatchObject({ ok: true });
  });

  it('B2-T03 one buy per CA across a restart: the same signal again is already_bought', async () => {
    const h = makeHarness();
    await h.goLive();
    const first = await h.run();
    expect(first.x?.status).toBe('submitted');
    await land(h, tx(first.x));
    expect(h.positions.real).toHaveLength(1);

    const h2 = h.restart();                                    // the process restarts; the ledger is on disk
    expect(await h2.svc.refreshArms()).toBe(true);             // boot: the arms are read again (the verdict cache starts empty)
    first.sig.entry.priced_at = h2.clock.now() - 1_000;        // the Engine redelivers the same signal
    const again = h2.svc.decide(first.sig, first.env, h2.clock.now(), h2.clock.now());
    expect(again).toMatchObject({ action: 'skip', reason: 'already_bought', arm: 'B1' });
    expect(h2.router.sends).toHaveLength(0);
    // and executing that decision anyway is refused by the ledger, still without a send
    const forced = await h2.svc.execute(first.sig, first.env, { action: 'buy', reason: null, arm: 'B1', forceDryRun: false });
    expect(forced).toMatchObject({ status: 'failed', error: 'already_bought' });
    expect(h2.router.sends).toHaveLength(0);
  });

  it('B2-T05 three failed buys set paused_fails, which holds until the owner command', async () => {
    const h = makeHarness();
    await h.goLive();
    h.router.failBefore = new Error('rpc exploded');
    for (let i = 1; i <= 3; i++) {
      const { x } = await h.run();
      expect(x).toMatchObject({ status: 'failed', error: 'rpc exploded', tx: null });
      expect(h.stateFile().consecutive_fails).toBe(i);
    }
    expect(h.stateFile()).toMatchObject({ pause: 'paused_fails', consecutive_fails: 3, mode: 'live' });
    expect(h.notices.some(n => /PAUSED \(paused_fails\) after 3 consecutive failed buys/.test(n))).toBe(true);
    expect(h.caps.usage(h.clock.now()).lastHour).toBe(0);      // every failed buy released its slot
    const callsBefore = h.router.calls.length;
    h.router.failBefore = null;
    for (let i = 0; i < 2; i++) {
      const held = await h.run();
      expect(held.d).toMatchObject({ action: 'skip', reason: 'paused_fails' });
      expect(held.x).toBeNull();
      await h.advance(60 * 60_000);                            // time alone does not clear it
    }
    expect(h.router.calls).toHaveLength(callsBefore);
    expect(h.svc.heartbeat().autobuy.paused).toBe('paused_fails');

    expect(await h.owner('/autobuy resume')).toContain('Cleared: paused_fails');
    const ok = await h.run();
    expect(ok.d.action).toBe('buy');
    expect(ok.x?.status).toBe('submitted');
    expect(h.stateFile()).toMatchObject({ pause: null, consecutive_fails: 0 });
  });

  it('a confirmed buy resets the failure count, so only consecutive failures pause', async () => {
    const h = makeHarness();
    await h.goLive();
    h.router.failBefore = new Error('boom');
    await h.run();
    await h.run();
    expect(h.stateFile().consecutive_fails).toBe(2);
    h.router.failBefore = null;
    const ok = await h.run();
    await land(h, tx(ok.x));
    expect(h.stateFile()).toMatchObject({ consecutive_fails: 0, pause: null });
  });

  it('a failed confirm cancels the reservation, counts the failure, reports delivery.buy failed and keeps the CA bought', async () => {
    const h = makeHarness();
    await h.goLive();
    const r = await h.run();
    const sig = tx(r.x);
    expect(h.caps.usage(h.clock.now()).lastHour).toBe(1);
    h.rpc.revert(sig);
    await h.advance(1_000);
    expect(h.positions.real).toHaveLength(0);
    expect(h.journal()).toEqual([]);
    expect(h.caps.usage(h.clock.now()).lastHour).toBe(0);      // the slot is released
    expect(h.stateFile().consecutive_fails).toBe(1);
    expect(types(h)).toEqual(['delivery.buy']);
    expect(h.outbox.of('delivery.buy')[0].payload).toMatchObject({ status: 'failed', reason: 'route_failed', tx: sig });
    expect(h.outbox.of('delivery.buy')[0].payload.error).toContain('InstructionError');
    // no second buy of that CA, ever
    r.sig.entry.priced_at = h.clock.now() - 1_000;
    expect(h.svc.decide(r.sig, r.env, h.clock.now(), h.clock.now()).reason).toBe('already_bought');
  });

  it('A-29: a confirmed fill with 0 tokens opens no position, reports failed and counts toward paused_fails', async () => {
    const h = makeHarness();
    await h.goLive();
    h.fills.next = { solSpentLamports: '5000', tokensRaw: '0', feeLamports: '5000', confirmedAt: h.clock.now() };
    for (let i = 1; i <= 3; i++) {
      const r = await h.run();
      await land(h, tx(r.x));
      expect(h.stateFile().consecutive_fails).toBe(i);
    }
    expect(h.positions.real).toHaveLength(0);
    expect(h.positions.openCalls).toHaveLength(0);
    expect(h.stateFile().pause).toBe('paused_fails');
    const failed = h.outbox.of('delivery.buy');
    expect(failed).toHaveLength(3);
    for (const e of failed) expect(e.payload).toMatchObject({ status: 'failed', reason: 'route_failed' });
    expect(failed[0].payload.error).toMatch(/0 tokens/);
    expect(h.outbox.of('position.opened')).toHaveLength(0);
    expect(h.caps.usage(h.clock.now()).lastHour).toBe(0);
  });

  it('an unverified fill (or a fill read that throws) opens the position from the quote with fill_source unverified and tells the owner', async () => {
    for (const next of ['unverified', new Error('rpc timeout')] as const) {
      const h = makeHarness();
      await h.goLive();
      h.fills.next = next;
      const r = await h.run();
      await land(h, tx(r.x));
      expect(h.positions.openCalls).toHaveLength(1);
      expect(h.positions.openCalls[0].fill).toBe('unverified');
      expect(h.positions.openCalls[0].p).toMatchObject({ sig: tx(r.x), quote_tokens_out: QUOTE_TOKENS.toString() });
      expect(h.positions.real[0].entry.fill_source).toBe('unverified');
      expect(h.outbox.of('position.opened')[0].payload).toMatchObject({ fill_source: 'unverified' });
      expect(h.outbox.of('delivery.buy')[0].payload.status).toBe('confirmed');
      expect(h.notices.join('\n')).toMatch(/could not be verified/);
      expect(h.journal()).toEqual([]);
    }
  });

  it('a route over the impact cap is refused before anything is sent: no journal, no ledger, no failure count', async () => {
    const h = makeHarness();
    await h.goLive();
    h.router.impactPct = 15.5;
    const r = await h.run();
    expect(r.x?.status).toBe('failed');
    expect(r.x?.error).toMatch(/^impact_cap: price impact above the 15% cap/);
    expect(h.router.sends).toHaveLength(0);
    expect(h.journal()).toEqual([]);
    expect(fs.existsSync(path.join(h.dir, LEDGER_FILE))).toBe(false);
    expect(h.caps.usage(h.clock.now()).lastHour).toBe(0);
    expect(h.stateFile().consecutive_fails).toBe(0);
    // an impact refusal can repeat without pausing, and a later signal still buys
    for (let i = 0; i < 4; i++) await h.run();
    expect(h.stateFile().pause).toBeNull();
    h.router.impactPct = 14.9;
    expect((await h.run()).x?.status).toBe('submitted');
  });

  it('AUTOBUY_MAX_IMPACT_PCT and the slippage setting reach the router', async () => {
    const h = makeHarness({ env: { AUTOBUY_MAX_IMPACT_PCT: '8' } });
    h.settings.slippageBps = 450;
    h.settings.priorityFee = 120_000;
    h.settings.antiMev = false;
    await h.goLive();
    await h.run();
    expect(h.router.calls[0].opts).toMatchObject({ maxImpactPct: 8, slippageBps: 450, priorityFee: 120_000, antiMev: false, singleSend: true });
  });

  it('a send that reports an error after it was counted still resolves submitted, and the confirm loop decides', async () => {
    const h = makeHarness();
    await h.goLive();
    h.router.failSend = new Error('timeout while sending');
    const r = await h.run();
    expect(r.x).toMatchObject({ status: 'submitted', error: null });
    expect(h.router.sends).toHaveLength(1);
    expect(h.stateFile().consecutive_fails).toBe(0);           // not a failed buy until the chain says so
    expect(h.journal()).toHaveLength(1);
    await land(h, tx(r.x));                                    // it reached a validator after all
    expect(h.positions.real).toHaveLength(1);
    expect(h.journal()).toEqual([]);
    expect(types(h)).toEqual(['position.opened', 'delivery.buy']);

    const h2 = makeHarness();
    await h2.goLive();
    h2.router.failSend = new Error('timeout while sending');
    const r2 = await h2.run();
    h2.rpc.height = 1_200;                                     // never landed and the blockhash is gone
    h2.rpc.balance = { rawAtoms: 0 };
    await h2.advance(CONFIRM_FAST_WINDOW_MS);
    expect(h2.positions.real).toHaveLength(0);
    expect(h2.journal()).toEqual([]);
    expect(h2.outbox.of('delivery.buy')[0].payload).toMatchObject({ status: 'failed', tx: tx(r2.x) });
    expect(h2.stateFile().consecutive_fails).toBe(1);
  });

  it('a journal that cannot be written aborts the send: zero sends, the slot released, the failure counted', async () => {
    const h = makeHarness();
    await h.goLive();
    fs.mkdirSync(path.join(h.dir, PENDING_FILE));              // a folder where the file must go: every write fails
    const r = await h.run();
    expect(r.x?.status).toBe('failed');
    expect(h.router.sends).toHaveLength(0);
    expect(h.caps.usage(h.clock.now()).lastHour).toBe(0);
    expect(h.stateFile().consecutive_fails).toBe(1);
    expect(fs.existsSync(path.join(h.dir, LEDGER_FILE))).toBe(false);
  }, 20_000);

  it('a ledger that cannot be written removes the journal entry again and aborts the send', async () => {
    const h = makeHarness();
    await h.goLive();
    fs.mkdirSync(path.join(h.dir, LEDGER_FILE));
    const r = await h.run();
    expect(r.x?.status).toBe('failed');
    expect(h.router.sends).toHaveLength(0);
    expect(h.journal()).toEqual([]);
    expect(h.caps.usage(h.clock.now()).lastHour).toBe(0);
  }, 20_000);

  it('a router that sent without calling onSigned still gets its transaction journalled and watched', async () => {
    const h = makeHarness();
    await h.goLive();
    const sig = newSig();
    h.router.failBefore = new RouterSendError('sent, then the router lost track', [sig]);
    h.rpc.height = 1_000;
    const r = await h.run();
    expect(r.x).toMatchObject({ status: 'submitted', tx: sig });
    expect(h.journal().map(e => e.sig)).toEqual([sig]);
    expect(h.journal()[0].last_valid_block_height).toBe(1_151);
    await land(h, sig);
    expect(h.positions.real).toHaveLength(1);
    expect(h.logs.some(l => /without an onSigned journal entry/.test(l))).toBe(true);
  });

  it('two executes for one CA at once send once', async () => {
    const h = makeHarness();
    await h.goLive();
    const { env, sig } = h.signal();
    h.registry.set(env.ca as string, env.signal_id as string);
    const d = h.svc.decide(sig, env, h.clock.now(), h.clock.now());
    const [a, b] = await Promise.all([h.svc.execute(sig, env, d), h.svc.execute(sig, env, d)]);
    expect([a.status, b.status].sort()).toEqual(['failed', 'submitted']);
    expect(h.router.sends).toHaveLength(1);
    expect([a, b].find(x => x.status === 'failed')?.error).toMatch(/already in progress/);
  });

  it('execute refuses what is not a buy, a signal without ids, a missing wallet and an unusable buy amount, all without a call to the router', async () => {
    const h = makeHarness();
    await h.goLive();
    const { env, sig } = h.signal();
    const buy = { action: 'buy', reason: null, arm: 'B1', forceDryRun: false } as const;
    expect(await h.svc.execute(sig, env, { action: 'skip', reason: 'off', arm: null, forceDryRun: false })).toMatchObject({ status: 'failed', error: 'not a buy decision' });
    expect(await h.svc.execute(sig, { ...env, ca: null }, buy)).toMatchObject({ status: 'failed', error: 'signal without ca or signal_id' });
    expect(await h.svc.execute(sig, { ...env, signal_id: null }, buy)).toMatchObject({ status: 'failed', error: 'signal without ca or signal_id' });
    h.flags.walletPresent = false;
    expect(await h.svc.execute(sig, env, buy)).toMatchObject({ status: 'failed', error: 'no wallet' });
    h.flags.walletPresent = true;
    h.settings.buySol = Number.NaN;
    expect(await h.svc.execute(sig, env, buy)).toMatchObject({ status: 'failed', error: 'buy amount is not a valid SOL amount' });
    expect(h.router.calls).toHaveLength(0);
  });

  it('works behind the real intake: the buy is decided and executed before the card, and a second signal for the CA buys nothing', async () => {
    const h = makeHarness();
    await h.goLive();
    const registry: SignalRegistry = {
      signalled: ca => (h.registry.has(ca) ? { signal_id: h.registry.get(ca) as string, at: 0, grade: 'A', symbol: 'CREW' } : null),
      markSignalled: (ca, info) => { h.registry.set(ca, info.signal_id); },
    };
    const order: string[] = [];
    const tg: TgQueue = { enqueue: (_card, meta) => { order.push(`card:${meta.kind}:sends=${h.router.sends.length}`); } };
    const intake = createIntake({
      clock: h.clock, autobuy: h.svc, exits: new StubExits(), outbox: h.outbox, tg, registry, tgMinGrade: () => 'B', newEventId: createUlidFactory(() => h.clock.now()),
    });
    const { env } = h.signal();
    await intake.handle(env, { receivedAt: h.clock.now(), ackedAt: h.clock.now() });
    const buys = h.outbox.of('delivery.buy');
    expect(buys).toHaveLength(1);
    expect(buys[0].payload).toMatchObject({ status: 'submitted', arm: 'B1', route: 'pf-direct', sol_in_lamports: '10000000' });
    expect(buys[0].payload.tx).toBe(h.router.sends[0].sig);
    expect(order).toEqual(['card:signal:sends=1']);            // the card went out after the transaction was sent

    const dup = { ...env, event_id: newTestUlid(), signal_id: 'dec_a-different-signal-id-000001' };
    await intake.handle(dup, { receivedAt: h.clock.now(), ackedAt: h.clock.now() });
    expect(h.router.sends).toHaveLength(1);
    expect(h.outbox.of('bot.contract_violation')).toHaveLength(1);
  });
});

describe('arms', () => {
  it('B2-T07 an arms.status FAIL for the live arm turns auto-buy off and tells the owner; other verdicts and other arms do the right thing', async () => {
    for (const verdict of ['FAIL', 'RETIRED', 'BIASED', 'INSUFFICIENT'] as const) {
      const h = makeHarness();
      await h.goLive();
      expect(h.svc.heartbeat().autobuy).toMatchObject({ enabled: true, mode: 'live', arm: 'B1' });
      h.svc.onArmsStatus(h.engine.set('B1', verdict));
      expect(h.stateFile().mode, verdict).toBe('off');
      expect(h.notices.some(n => n.includes('switched OFF') && n.includes(`B1 is ${verdict}`)), verdict).toBe(true);
      expect(h.svc.heartbeat().autobuy).toMatchObject({ enabled: false, mode: 'off', arm: null });
      const r = await h.run();
      expect(r.d, verdict).toMatchObject({ action: 'skip', reason: 'off' });
      expect(h.router.calls, verdict).toHaveLength(0);
    }
    // a verdict change of another arm, or a later PASS look of the live arm, leaves live mode alone
    const h = makeHarness();
    const reportId = await h.goLive();
    h.svc.onArmsStatus(h.engine.set('B0', 'FAIL'));
    h.svc.onArmsStatus(h.engine.set('BS', 'RETIRED'));
    expect(h.stateFile().mode).toBe('live');
    h.svc.onArmsStatus(h.engine.set('B1', 'PASS', 'report-b1-0042'));
    expect(h.stateFile()).toMatchObject({ mode: 'live', report_id: reportId });   // the confirmed report stays as the audit record
    expect(h.notices).toEqual([]);
    // a live arm that is missing from the status is not a PASS either
    const payload: ArmsStatusPayload = { arms: (h.engine.payload as ArmsStatusPayload).arms.filter(a => a.arm !== 'B1') };
    h.svc.onArmsStatus(payload);
    expect(h.stateFile().mode).toBe('off');
    expect(h.notices.join('\n')).toMatch(/B1 is missing from the arms status/);
    // dry_run mode is not touched by verdicts
    const d = makeHarness();
    await d.armDry('B1');
    d.svc.onArmsStatus(d.engine.set('B1', 'FAIL'));
    expect(d.stateFile().mode).toBe('dry_run');
  });

  it('B2-T15 live on B1, then INSUFFICIENT, then PASS again: stays off until a new CONFIRM', async () => {
    const h = makeHarness();
    await h.goLive();
    h.svc.onArmsStatus(h.engine.set('B1', 'INSUFFICIENT'));
    expect(h.stateFile().mode).toBe('off');
    h.svc.onArmsStatus(h.engine.set('B1', 'PASS'));            // a later PASS look
    expect(h.stateFile().mode).toBe('off');
    expect(h.svc.heartbeat().autobuy.enabled).toBe(false);
    const idle = await h.run();
    expect(idle.d).toMatchObject({ action: 'skip', reason: 'off' });
    expect(h.router.calls).toHaveLength(0);
    // only a new request plus the exact CONFIRM turns it on again
    const ask = await h.owner('/autobuy on B1');
    expect(ask).toContain('CONFIRM B1 report-b1-0001');
    expect(h.stateFile().mode).toBe('off');
    expect(await h.owner('CONFIRM B1 report-b1-0001')).toMatch(/^Auto-buy is LIVE/);
    expect(h.stateFile().mode).toBe('live');
    expect((await h.run()).x?.status).toBe('submitted');
  });

  it('after a restart in live mode the verdict cache starts empty (every signal is off) until the arms are read again', async () => {
    const h = makeHarness();
    await h.goLive();
    const h2 = h.restart();
    expect((await h2.run()).d).toMatchObject({ action: 'skip', reason: 'off' });
    expect(await h2.svc.refreshArms()).toBe(true);
    expect((await h2.run()).d.action).toBe('buy');
    // and a refresh that finds the arm no longer PASS switches off
    h2.engine.set('B1', 'FAIL');
    expect(await h2.svc.refreshArms()).toBe(true);
    expect(h2.stateFile().mode).toBe('off');
    h2.engine.payload = { error: 'timeout' };
    expect(await h2.svc.refreshArms()).toBe(false);
  });
});

describe('pauses', () => {
  it('B2-T17 paused_fails and paused_rolling survive a restart, the breaker pause does not, and a corrupt state file starts disabled', async () => {
    const env = { AUTO_BUY_MAX_PER_HOUR: '100', AUTO_BUY_MAX_PER_DAY: '100', AUTO_BUY_MAX_OPEN_POSITIONS: '100', AUTO_BUY_MAX_SOL_PER_DAY: '100' };
    let h = makeHarness({ env });
    await h.goLive();

    // 1. three failed buys, then a restart: still paused_fails with consecutive_fails restored
    h.router.failBefore = new Error('rpc exploded');
    for (let i = 0; i < 3; i++) await h.run();
    expect(h.svc.heartbeat().autobuy.paused).toBe('paused_fails');
    h = h.restart();
    await h.svc.refreshArms();
    expect(h.stateFile()).toMatchObject({ mode: 'live', pause: 'paused_fails', consecutive_fails: 3 });
    expect(h.svc.heartbeat().autobuy).toMatchObject({ mode: 'live', arm: 'B1', paused: 'paused_fails' });
    expect((await h.run()).d).toMatchObject({ action: 'skip', reason: 'paused_fails' });

    // 2. the rolling window: 50 verified closed real trades at -30% per SOL in set paused_rolling; it persists across a restart
    await h.owner('/autobuy resume');
    expect(h.stateFile()).toMatchObject({ pause: null, consecutive_fails: 0 });
    for (let i = 1; i <= 49; i++) h.svc.onPositionClosed(closed(i));
    expect(h.stateFile().pause).toBeNull();                    // the window is not full yet
    h.svc.onPositionClosed(closed(50));
    expect(h.svc.heartbeat().autobuy.paused).toBe('paused_rolling');
    expect(h.notices.some(n => /PAUSED \(paused_rolling\)/.test(n))).toBe(true);
    h = h.restart();
    await h.svc.refreshArms();
    expect(h.stateFile()).toMatchObject({ pause: 'paused_rolling' });
    expect(h.stateFile().rolling).toHaveLength(50);
    expect((await h.run()).d).toMatchObject({ action: 'skip', reason: 'paused_rolling' });

    // 3. the breaker: 10 buys landed and no sell for 31 minutes is paused_breaker, in memory only
    await h.owner('/autobuy resume');
    for (let i = 0; i < 10; i++) {
      const r = await h.run();
      expect(r.x?.status, `buy ${i}`).toBe('submitted');
      await land(h, tx(r.x));
    }
    expect(h.positions.real).toHaveLength(10);
    expect(h.svc.heartbeat().autobuy.paused).toBeNull();
    await h.advance(31 * 60_000);
    expect(h.svc.heartbeat().autobuy.paused).toBe('paused_breaker');
    expect((await h.run()).d).toMatchObject({ action: 'skip', reason: 'paused_breaker' });
    expect(h.stateFile().pause).toBeNull();                    // never persisted
    h = h.restart();
    await h.svc.refreshArms();
    expect(h.svc.heartbeat().autobuy.paused).toBeNull();
    expect((await h.run()).d.action).toBe('buy');

    // 4. a corrupt state file at boot: disabled
    fs.writeFileSync(path.join(h.dir, STATE_FILE), '{ this is not json');
    h = h.restart();
    expect(h.svc.heartbeat().autobuy).toMatchObject({ enabled: false, mode: 'off', arm: null, report_id: null, confirmed_at: null });
    expect((await h.run()).d).toMatchObject({ action: 'skip', reason: 'off' });
    expect(fs.readdirSync(h.dir).some(n => n.startsWith(`${STATE_FILE}.invalid-`))).toBe(true);
  }, 30_000);

  it('only verified, real, signal-origin closed trades enter the rolling window', async () => {
    const h = makeHarness();
    await h.goLive();
    h.svc.onPositionClosed(closed(1, { dryRun: true }));
    h.svc.onPositionClosed(closed(2, { origin: 'manual' }));
    h.svc.onPositionClosed(closed(3, { fillSource: 'unverified' }));
    h.svc.onPositionClosed(closed(4, { fillSource: 'quote_dry_run' }));
    h.svc.onPositionClosed(closed(5, { entryTx: null }));
    h.svc.onPositionClosed(closed(6, { realizedNetLamports: null }));
    h.svc.onPositionClosed(closed(7, { solSpentLamports: null }));
    expect(h.stateFile().rolling).toEqual([]);
    h.svc.onPositionClosed(closed(8));
    h.svc.onPositionClosed(closed(8));                         // the same entry tx twice counts once
    expect(h.stateFile().rolling).toEqual([{ tx: 'entry-tx-8', net_per_sol_in: -0.3, closed_at: 8 }]);
  });

  it('a successful sell resets the breaker count', async () => {
    const h = makeHarness({ env: { AUTO_BUY_MAX_PER_HOUR: '100', AUTO_BUY_MAX_PER_DAY: '100', AUTO_BUY_MAX_OPEN_POSITIONS: '100', AUTO_BUY_MAX_SOL_PER_DAY: '100' } });
    await h.goLive();
    for (let i = 0; i < 10; i++) {
      const r = await h.run();
      await land(h, tx(r.x));
    }
    await h.advance(20 * 60_000);
    h.svc.noteSellOk();
    await h.advance(20 * 60_000);
    expect(h.svc.heartbeat().autobuy.paused).toBeNull();       // 40 min since the first buy, but a sell succeeded 20 min ago
  });

  it('/autobuy resume also clears a tripped breaker', async () => {
    const h = makeHarness({ env: { AUTO_BUY_MAX_PER_HOUR: '100', AUTO_BUY_MAX_PER_DAY: '100', AUTO_BUY_MAX_OPEN_POSITIONS: '100', AUTO_BUY_MAX_SOL_PER_DAY: '100' } });
    await h.goLive();
    for (let i = 0; i < 10; i++) {
      const r = await h.run();
      await land(h, tx(r.x));
    }
    await h.advance(31 * 60_000);
    expect(h.svc.heartbeat().autobuy.paused).toBe('paused_breaker');
    expect(h.notices.filter(n => /paused_breaker/.test(n))).toHaveLength(1);   // the owner is told once
    expect(await h.owner('/autobuy resume')).toContain('paused_breaker');
    expect(h.svc.heartbeat().autobuy.paused).toBeNull();
  });
});

describe('boot recovery', () => {
  /** A live buy whose process dies right after the send (before any confirm). */
  async function crashedAfterSend() {
    const h = makeHarness();
    await h.goLive();
    const first = await h.run();
    const sig = tx(first.x);
    expect(h.router.sends).toHaveLength(1);
    expect(h.router.sends[0].journalHadSig).toBe(true);        // the journal was written before the send
    expect(h.journal().map(e => e.sig)).toEqual([sig]);
    return { h, first, sig };
  }

  it('B2-T18 a restart between the send and the confirm: (a) it landed, (b) it failed, (c) unknown with an expired blockhash and balance 0', async () => {
    // (a) the transaction landed: exactly one position, one position.opened, an empty journal
    {
      const { h, first, sig } = await crashedAfterSend();
      const h2 = h.restart();
      h2.rpc.land(sig);
      expect(await h2.svc.recover()).toEqual({ resolved: 1, waiting: 0 });
      expect(h2.positions.real).toHaveLength(1);
      expect(h2.positions.openCalls).toHaveLength(1);
      expect(h2.positions.openCalls[0].p).toMatchObject({ sig, ca: first.env.ca, signal_id: first.env.signal_id, last_valid_block_height: 1_150 });
      expect(Object.keys(h2.positions.openCalls[0].p)).not.toContain('received_at');   // only the frozen PendingBuy fields
      expect(h2.positions.openCalls[0].fill).toMatchObject({ tokensRaw: '1666000000000' });
      expect(h2.outbox.of('position.opened')).toHaveLength(1);
      expect(h2.outbox.of('position.opened')[0].payload).toMatchObject({ entry_tx: sig, fill_source: 'tx_meta', dry_run: false });
      expect(h2.outbox.of('delivery.buy').map(e => e.payload.status)).toEqual(['confirmed']);
      expect(h2.outbox.of('delivery.buy')[0].payload.stamps.received_at).toBe(h.clock.now());
      expect(h2.journal()).toEqual([]);
      expect(h2.router.sends).toHaveLength(0);                 // recovery never sends
      expect(h2.caps.usage(h2.clock.now()).lastHour).toBe(1);  // the landed buy is counted again after the restart
      expect(h2.clock.pendingTimers()).toBe(0);
    }
    // (b) the transaction failed: no position, the reservation is gone, no second buy
    {
      const { h, first, sig } = await crashedAfterSend();
      const h2 = h.restart();
      h2.rpc.revert(sig);
      expect(await h2.svc.recover()).toEqual({ resolved: 1, waiting: 0 });
      expect(h2.positions.real).toHaveLength(0);
      expect(h2.outbox.of('position.opened')).toHaveLength(0);
      expect(h2.outbox.of('delivery.buy').map(e => e.payload.status)).toEqual(['failed']);
      expect(h2.journal()).toEqual([]);
      expect(h2.caps.usage(h2.clock.now()).lastHour).toBe(0);
      expect(h2.stateFile().consecutive_fails).toBe(1);
      await h2.svc.refreshArms();
      first.sig.entry.priced_at = h2.clock.now() - 1_000;
      expect(h2.svc.decide(first.sig, first.env, h2.clock.now(), h2.clock.now()).reason).toBe('already_bought');
      expect(h2.router.sends).toHaveLength(0);
    }
    // (c) status unknown, blockhash expired, balance 0: failed, no position
    {
      const { h, sig } = await crashedAfterSend();
      const h2 = h.restart();
      h2.rpc.height = 1_151;                                   // last valid height of the journal entry is 1150
      h2.rpc.balance = { rawAtoms: 0 };
      expect(h2.rpc.statuses.has(sig)).toBe(false);
      expect(await h2.svc.recover()).toEqual({ resolved: 1, waiting: 0 });
      expect(h2.positions.real).toHaveLength(0);
      expect(h2.outbox.of('position.opened')).toHaveLength(0);
      expect(h2.outbox.of('delivery.buy')[0].payload).toMatchObject({ status: 'failed', tx: sig });
      expect(h2.journal()).toEqual([]);
      expect(h2.caps.usage(h2.clock.now()).lastHour).toBe(0);
    }
  });

  it('a buy that is still unknown while its blockhash is valid stays in the journal and is re-checked every 5 s', async () => {
    const { h, sig } = await crashedAfterSend();
    const h2 = h.restart();
    h2.rpc.height = 1_100;
    expect(await h2.svc.recover()).toEqual({ resolved: 0, waiting: 1 });
    expect(h2.journal().map(e => e.sig)).toEqual([sig]);
    const checks = h2.rpc.calls.statuses;
    await h2.advance(4_999);
    expect(h2.rpc.calls.statuses).toBe(checks);
    await h2.advance(1);
    expect(h2.rpc.calls.statuses).toBe(checks + 1);
    h2.rpc.land(sig);
    await h2.advance(5_000);
    expect(h2.positions.real).toHaveLength(1);
    expect(h2.journal()).toEqual([]);
    // a second recover() call does not double up
    expect(await h2.svc.recover()).toEqual({ resolved: 0, waiting: 0 });
  });

  it('a buy with an unknown status whose wallet holds the token is adopted as unverified and the owner is told', async () => {
    const { h, first, sig } = await crashedAfterSend();
    const h2 = h.restart();
    h2.rpc.height = 1_100;                                     // the blockhash is still valid
    h2.rpc.balance = { rawAtoms: 1_500_000 };
    expect(await h2.svc.recover()).toEqual({ resolved: 1, waiting: 0 });
    expect(h2.positions.openCalls).toHaveLength(1);
    expect(h2.positions.openCalls[0].fill).toBe('unverified');
    expect(h2.positions.openCalls[0].p).toMatchObject({ sig, ca: first.env.ca, quote_tokens_out: '1500000' });   // the balance, not the quote
    expect(h2.positions.real[0].entry.fill_source).toBe('unverified');
    expect(h2.outbox.of('position.opened')[0].payload).toMatchObject({ fill_source: 'unverified' });
    expect(h2.notices.join('\n')).toMatch(/could not be verified/);
    expect(h2.journal()).toEqual([]);
  });

  it('a landed buy whose position already exists is not opened twice', async () => {
    const { h, first, sig } = await crashedAfterSend();
    const h2 = h.restart();
    h2.positions.openFromBuy({
      sig, signal_id: first.env.signal_id as string, ca: first.env.ca as string, wallet_id: WALLET_ID, owner: OWNER_ADDR, arm: 'B1', route: 'pf-direct',
      sol_in_lamports: '10000000', quote_tokens_out: null, last_valid_block_height: 1_150, submitted_at: 1,
    }, 'unverified');                                          // the crash came after openFromBuy but before the journal entry was removed
    h2.positions.openCalls.length = 0;
    h2.rpc.land(sig);
    await h2.svc.recover();
    expect(h2.positions.openCalls).toHaveLength(0);
    expect(h2.positions.real).toHaveLength(1);
    expect(h2.journal()).toEqual([]);
  });

  it('openFromBuy failing keeps the entry in the journal, tells the owner once, retries, and recovers on the next boot', async () => {
    const h = makeHarness();
    await h.goLive();
    const r = await h.run();
    const sig = tx(r.x);
    h.positions.failOpen = new Error('disk full');
    h.rpc.land(sig);
    await h.advance(1_000);
    expect(h.positions.real).toHaveLength(0);
    expect(h.journal().map(e => e.sig)).toEqual([sig]);
    expect(h.notices.filter(n => /could not be saved/.test(n))).toHaveLength(1);
    await h.advance(5_000 * OPEN_RETRIES_MAX);
    expect(h.notices.filter(n => /could not be saved/.test(n))).toHaveLength(1);
    expect(h.notices.some(n => /could not be opened after/.test(n))).toBe(true);
    expect(h.journal()).toHaveLength(1);                       // never dropped
    expect(h.outbox.of('delivery.buy')).toHaveLength(0);
    // the disk is fine again after a restart
    h.positions.failOpen = null;
    const h2 = h.restart();
    h2.rpc.land(sig);
    expect(await h2.svc.recover()).toEqual({ resolved: 1, waiting: 0 });
    expect(h2.positions.real).toHaveLength(1);
    expect(h2.journal()).toEqual([]);
  });

  it('stop clears every timer', async () => {
    const h = makeHarness();
    await h.goLive();
    await h.run();
    expect(h.clock.pendingTimers()).toBe(1);
    h.svc.stop();
    expect(h.clock.pendingTimers()).toBe(0);
  });
});

describe('decide wiring', () => {
  it('a signal id the registry already holds for the CA is the same signal; a different one is a second signal.new', async () => {
    const h = makeHarness();
    await h.armDry('B1');
    const { env, sig } = h.signal();
    const now = h.clock.now();
    expect(h.svc.decide(sig, env, now, now).action).toBe('buy');                       // not registered yet
    h.registry.set(env.ca as string, env.signal_id as string);
    expect(h.svc.decide(sig, env, now, now).action).toBe('buy');                       // registered by this very signal (the intake does this first)
    h.registry.set(env.ca as string, 'dec_some-earlier-signal');
    expect(h.svc.decide(sig, env, now, now)).toMatchObject({ action: 'skip', reason: 'contract_violation' });
    expect(h.svc.decide(sig, { ...env, ca: null }, now, now)).toMatchObject({ action: 'skip', reason: 'contract_violation' });
  });

  it('the environment, the wallet, the session window and the positions feed the decision', async () => {
    const h = makeHarness();
    await h.armDry('B1');
    h.flags.walletPresent = false;
    expect((await h.run()).d.reason).toBe('no_wallet');
    h.flags.walletPresent = true;
    h.flags.sessionOk = false;
    expect((await h.run()).d.reason).toBe('outside_session');
    h.flags.sessionOk = true;
    h.flags.balanceSol = 0.03;
    expect((await h.run()).d.reason).toBe('reserve');
    h.flags.balanceSol = null;                                 // unknown balance does not block
    const ok = await h.run();
    expect(ok.d.action).toBe('buy');
    // the same CA again while its virtual position is open
    ok.sig.entry.priced_at = h.clock.now() - 500;
    expect(h.svc.decide(ok.sig, ok.env, h.clock.now(), h.clock.now()).reason).toBe('duplicate_position');
    // a signal for a policy the bot does not have
    const { env, sig } = h.signal();
    sig.policy = { id: 'EA', version: 'ffffffffffffffff' };
    expect(h.svc.decide(sig, env, h.clock.now(), h.clock.now()).reason).toBe('policy_mismatch');
  });

  it('with the env unset the caps are 3 per hour and 5 open positions, and the SOL budget is 20 x the buy size', async () => {
    const h = makeHarness();
    await h.goLive();
    for (let i = 0; i < 3; i++) {
      const r = await h.run();
      expect(r.x?.status, `buy ${i}`).toBe('submitted');
      await land(h, tx(r.x));
    }
    const fourth = await h.run();
    expect(fourth.d).toMatchObject({ action: 'skip', reason: 'cap_hour' });
    await h.advance(61 * 60_000);
    const later = await h.run();
    expect(later.x?.status).toBe('submitted');
    await land(h, tx(later.x));
    expect(h.positions.real).toHaveLength(4);
    await h.advance(61 * 60_000);
    for (let i = 0; i < 1; i++) {
      const r = await h.run();
      await land(h, tx(r.x));
    }
    expect(h.positions.real).toHaveLength(5);
    await h.advance(61 * 60_000);
    expect((await h.run()).d.reason).toBe('max_positions');
  });

  it('an env raise above a code default is logged as a deviation at start, an unusable value is named', () => {
    const h = makeHarness({ env: { AUTO_BUY_MAX_PER_HOUR: '10', AUTOBUY_STALE_MS: '9000', AUTO_BUY_MAX_PER_DAY: 'many', AUTOBUY_MAX_IMPACT_PCT: 'x' } });
    h.svc.start();
    const text = h.logs.join('\n');
    expect(text).toMatch(/AUTO_BUY_MAX_PER_HOUR=10 is above the code default 3/);
    expect(text).toMatch(/AUTOBUY_STALE_MS=9000 is looser than the code default 5000/);
    expect(text).toMatch(/AUTO_BUY_MAX_PER_DAY is not usable/);
    expect(text).toMatch(/AUTOBUY_MAX_IMPACT_PCT is not usable/);
  });
});

describe('heartbeat and boot line', () => {
  it('reports mode, arm, report id, confirmed_at, BOT_DRY_RUN, the pause and the caps used', async () => {
    const h = makeHarness();
    h.flags.dryRun = true;
    expect(h.svc.heartbeat()).toEqual({
      autobuy: { enabled: false, mode: 'off', arm: null, report_id: null, confirmed_at: null, dry_run: true, paused: null },
      caps_used: { hour: 0, day: 0, sol_day: 0 },
    });
    expect(h.svc.bootLine()).toBe('auto-buy: mode off, arm none, confirmed_at none, paused no, BOT_DRY_RUN on');
    await h.armDry('B2');
    expect(h.svc.heartbeat().autobuy).toEqual({ enabled: true, mode: 'dry_run', arm: 'B2', report_id: null, confirmed_at: null, dry_run: true, paused: null });
    await h.owner('/autobuy off');
    h.flags.dryRun = false;
    const reportId = await h.goLive('B1');
    const live = await h.run();
    expect(h.svc.heartbeat()).toEqual({
      autobuy: { enabled: true, mode: 'live', arm: 'B1', report_id: reportId, confirmed_at: h.clock.now(), dry_run: false, paused: null },
      caps_used: { hour: 1, day: 1, sol_day: 0.01 },
    });
    expect(live.x?.status).toBe('submitted');
    expect(h.svc.bootLine()).toMatch(/^auto-buy: mode live, arm B1, confirmed_at 2026-\d\d-\d\dT[\d:.]+Z, paused no, BOT_DRY_RUN off$/);
    h.svc.start();
    expect(h.logs.some(l => l.includes('auto-buy: mode live, arm B1'))).toBe(true);
  });

  it('start reports a corrupt ledger, journal and state file, which were moved aside', () => {
    const dir = tempDir('ps-b2a-');
    fs.writeFileSync(path.join(dir, LEDGER_FILE), 'x');
    fs.writeFileSync(path.join(dir, PENDING_FILE), 'x');
    fs.writeFileSync(path.join(dir, STATE_FILE), 'x');
    const h = makeHarness({ dir });
    h.svc.start();
    const text = h.logs.join('\n');
    expect(text).toMatch(/buy ledger could not be read/);
    expect(text).toMatch(/pending-buys journal could not be read/);
    expect(text).toMatch(/autobuy-state.json is not usable/);
  });
});
