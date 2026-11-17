/**
 * B50 section 2 (R3-B5): the position monitor reads positions from the positions store (positions-v2.json), the worth of the bag
 * from exits/valuation.ts and market data from the Engine's token snapshot. Everything is injected: a real store over a temp
 * folder, stub valuation / Engine / RPC helpers, one FakeClock (A-10). No socket, no price API, no pump.fun scanner.
 *
 * The purge guard check lives here as well: the bot guards over the purged files, with an EMPTY exemption map (A-34).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { PositionV2 } from '../bot-contracts';
import type { TokenProxyResponse } from '../shared/contract/v1';
import { createPositionsStore, type PositionsStoreV2 } from '../exits/positions-store';
import { FakeClock } from '../link/clock';
import { BOT_GUARD_IDS, ScanContext, formatViolations, runAllGuards } from '../guards/guard-lib';

vi.mock('../logger', () => ({
  log: () => {}, logOk: () => {}, logDbg: () => {}, logErr: () => {}, logWarn: () => {}, emitEvent: () => {}, setBroadcast: () => {},
}));

import {
  configurePositionMonitor, getCurrentCaForCallback, handlePmCallback, listActiveMonitorCards, resetPositionMonitor, startPositionMonitor,
  stopAllForChat, stopMonitorCard,
} from './position-monitor';

const T0 = 1_800_000_000_000;
const CA1 = Keypair.fromSeed(new Uint8Array(32).fill(41)).publicKey.toBase58();
const CA2 = Keypair.fromSeed(new Uint8Array(32).fill(42)).publicKey.toBase58();

let dir: string;
let clock: FakeClock;
let writer: PositionsStoreV2;

const mkStore = (): PositionsStoreV2 => createPositionsStore({ dir, clock, policy: { id: 'EA', version: 'test' } });

function pos(over: Partial<PositionV2> & { position_id: string }): PositionV2 {
  return {
    signal_id: 'sig1', origin: 'signal', dry_run: false, ca: CA1, wallet_id: 'w1', policy_id: 'EA', policy_version: 'test', arm: 'B1',
    entry: { tx: 'buyTxSigA', opened_at: T0 - 600_000, sol_spent_lamports: '50000000', tokens_raw: '1000000000', fill_source: 'tx_meta' },
    original_tokens: '1000000000', tokens: '1000000000', basis_sol_per_token: null, peak_multiple: 1, legs_done: [], leg_attempts: {},
    last_quote: null, lockouts: [], ata: null, ...over,
  };
}

const known = (value: number | string | boolean, ageMs: number) => ({ value, src: 'gmgn.token_info' as const, as_of: T0 - ageMs });
function snapshot(ca = CA1, over: Partial<TokenProxyResponse['fields']> = {}): TokenProxyResponse {
  return {
    ok: true, ca, asOf: T0,
    fields: { symbol: known('CATE', 60_000), name: known('Catemas', 60_000), mcap_usd: known(12_300, 4_000), liq_usd: known(5_200, 9_000), migrated: known(false, 5_000), launchpad_status: known(0, 5_000), ...over },
  };
}

interface Rig {
  valuation: { quote: Mock<any[], any> };
  engine: { token: Mock<any[], any> };
  decimals: Mock<any[], any>;
  feeSol: Mock<any[], any>;
}
let rig: Rig;

function fakeCtx(chatId = 7, messageId = 11) {
  const edits: string[] = [];
  const ctx: any = {
    chat: { id: chatId },
    reply: vi.fn(async () => ({ message_id: messageId })),
    deleteMessage: vi.fn(async () => true),
    callbackQuery: { message: { chat: { id: chatId }, message_id: messageId } },
    telegram: {
      editMessageText: vi.fn(async (_c: any, _m: any, _i: any, text: string) => { edits.push(text); return true; }),
    },
  };
  return { ctx, edits };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-posmon-'));
  clock = new FakeClock(T0);
  writer = mkStore();
  rig = {
    valuation: { quote: vi.fn(async (_p: PositionV2, _protective: boolean) => ({ sol: 0.0521, src: 'onchain' as const, at: T0 - 3_000 })) },
    engine: { token: vi.fn(async (ca: string) => snapshot(ca)) },
    decimals: vi.fn(async () => 6),
    feeSol: vi.fn(async () => 0.000012),
  };
  configurePositionMonitor({ clock, store: mkStore, valuation: rig.valuation as any, engine: rig.engine as any, decimals: rig.decimals as any, feeSol: rig.feeSol as any, dataDir: () => dir });
});
afterEach(() => {
  resetPositionMonitor();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('position monitor card', () => {
  it('no open position → "No open positions."', async () => {
    const { ctx } = fakeCtx();
    await startPositionMonitor(ctx);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(String(ctx.reply.mock.calls[0][0])).toContain('No open positions.');
    expect(listActiveMonitorCards()).toEqual([]);
  });

  it('paints the card from the store, the valuation and the Engine snapshot, each number with its age', async () => {
    writer.put(pos({ position_id: 'p1' }));
    const { ctx, edits } = fakeCtx();
    await startPositionMonitor(ctx);
    expect(edits).toHaveLength(1);
    const text = edits[0];
    expect(text).toContain('<b>CATE</b> · Catemas');
    expect(text).toContain('Market cap: <b>$12.30K (4s old)</b>');
    expect(text).toContain('Liquidity: <b>$5.20K (9s old)</b>');
    expect(text).toContain('You hold 1.00K tokens');                          // 1e9 atoms at 6 decimals
    expect(text).toContain('worth <b>0.0521 SOL</b> (onchain, 3s old)');
    expect(text).toContain('Initial buy: 0.0500 SOL  ·  Fees paid: 0.00001 SOL');
    expect(text).toContain('Net PnL: <b>+0.0021 SOL (+4.2%)</b> 🟢');
    expect(text).toContain('🚀 Pump.fun bonding curve');
    expect(text).toContain('https://solscan.io/tx/buyTxSigA');
    expect(text).not.toMatch(/dexscreener|rugcheck/i);
    // the sources: a quote of the whole bag, protective-capable; the Engine snapshot of this token; the decimals; the fee of the first buy
    expect(rig.valuation.quote).toHaveBeenCalledTimes(1);
    expect(rig.valuation.quote.mock.calls[0][0]).toMatchObject({ ca: CA1, tokens: '1000000000' });
    expect(rig.valuation.quote.mock.calls[0][1]).toBe(true);
    expect(rig.engine.token).toHaveBeenCalledWith(CA1);
    expect(rig.feeSol).toHaveBeenCalledWith('buyTxSigA');
    expect(ctx.telegram.editMessageText.mock.calls[0][4]).toMatchObject({ parse_mode: 'HTML' });
  });

  it('unknown data is an em dash: the Engine offline, no quote, unverified entry', async () => {
    writer.put(pos({ position_id: 'p1', entry: { tx: null, opened_at: T0 - 600_000, sol_spent_lamports: null, tokens_raw: null, fill_source: 'unverified' } }));
    rig.engine.token.mockResolvedValue({ error: 'engine_offline' });
    rig.valuation.quote.mockResolvedValue(null);
    rig.decimals.mockResolvedValue(null);
    const { ctx, edits } = fakeCtx();
    await startPositionMonitor(ctx);
    const text = edits[0];
    expect(text).toContain('🪙 <b>—</b> · —');
    expect(text).toContain('Market cap: <b>—</b>  |  Liquidity: <b>—</b>');
    expect(text).toContain('You hold — tokens');
    expect(text).toContain('worth <b>—</b>');
    expect(text).toContain('Net PnL: <b>—</b> (entry not verified)');
    expect(rig.feeSol).not.toHaveBeenCalled();                                 // no entry transaction to look at
  });

  it('a valuation or Engine call that throws is "unknown", never an error on the card', async () => {
    writer.put(pos({ position_id: 'p1' }));
    rig.valuation.quote.mockRejectedValue(new Error('rpc down'));
    rig.engine.token.mockRejectedValue(new Error('offline'));
    rig.feeSol.mockRejectedValue(new Error('rpc down'));
    const { ctx, edits } = fakeCtx();
    await startPositionMonitor(ctx);
    expect(edits[0]).toContain('worth <b>—</b>');
    expect(edits[0]).toContain('Market cap: <b>—</b>');
  });

  it('wallets of one token are one card: tokens and entry SOL are summed, the quote is for the whole bag', async () => {
    writer.put(pos({ position_id: 'p1', wallet_id: 'w1' }));
    writer.put(pos({ position_id: 'p2', wallet_id: 'w2', tokens: '3000000000', original_tokens: '3000000000',
      entry: { tx: 'buyTxSigB', opened_at: T0 - 300_000, sol_spent_lamports: '150000000', tokens_raw: '3000000000', fill_source: 'tx_meta' } }));
    const { ctx, edits } = fakeCtx();
    await startPositionMonitor(ctx);
    expect(rig.valuation.quote.mock.calls[0][0]).toMatchObject({ tokens: '4000000000' });
    expect(edits[0]).toContain('You hold 4.00K tokens');
    expect(edits[0]).toContain('Initial buy: 0.2000 SOL');
    expect(edits[0]).toContain('https://solscan.io/tx/buyTxSigA');             // the oldest entry transaction
    expect(edits[0]).not.toContain('Position 1/');                             // one token: no carousel counter
  });

  it('one wallet without a verified entry makes the entry SOL (and so the PnL) unknown instead of a partial sum', async () => {
    writer.put(pos({ position_id: 'p1', wallet_id: 'w1' }));
    writer.put(pos({ position_id: 'p2', wallet_id: 'w2', entry: { tx: null, opened_at: T0 - 300_000, sol_spent_lamports: null, tokens_raw: null, fill_source: 'unverified' } }));
    const { ctx, edits } = fakeCtx();
    await startPositionMonitor(ctx);
    expect(edits[0]).toContain('Initial buy: — SOL');
    expect(edits[0]).toContain('Net PnL: <b>—</b>');
  });

  it('a quote the exit engine stored a moment ago for the same bag is reused; an old one is asked again', async () => {
    writer.put(pos({ position_id: 'p1', last_quote: { sol: 0.06, src: 'jupiter', at: T0 - 2_000 }, last_quote_tokens: '1000000000' } as any));
    const { ctx, edits } = fakeCtx();
    await startPositionMonitor(ctx);
    expect(rig.valuation.quote).not.toHaveBeenCalled();
    expect(edits[0]).toContain('worth <b>0.0600 SOL</b> (jupiter, 2s old)');

    writer.update('p1', { last_quote: { sol: 0.06, src: 'jupiter', at: T0 - 30_000 }, last_quote_tokens: '1000000000' });
    await handlePmCallback(ctx, 'pm:refresh');
    expect(rig.valuation.quote).toHaveBeenCalledTimes(1);

    writer.update('p1', { last_quote: { sol: 0.06, src: 'jupiter', at: T0 - 1_000 }, last_quote_tokens: '999' });
    await handlePmCallback(ctx, 'pm:refresh');
    expect(rig.valuation.quote).toHaveBeenCalledTimes(2);                      // other bag size: not reusable
  });

  it('a dry-run position is shown with a DRY RUN tag; a manual order TSL shows its secured line', async () => {
    writer.put(pos({ position_id: 'p1', origin: 'manual', dry_run: true, signal_id: null }));
    writer.putOrder({ order_id: 'o1', position_id: 'p1', ca: CA1, wallet_id: 'w1', type: 'tsl', trigger_pct: -10, baseline_multi: 1, peak_rel: 1.5,
      expires_at: null, active: true, attempts: 0, created_at: T0 - 1000, source: 'ui' });
    writer.putOrder({ order_id: 'o2', position_id: 'p1', ca: CA1, wallet_id: 'w1', type: 'tp', trigger_pct: 100, baseline_multi: 1, peak_rel: null,
      expires_at: null, active: true, attempts: 0, created_at: T0 - 1000, source: 'ui' });
    writer.putOrder({ order_id: 'o3', position_id: 'p1', ca: CA1, wallet_id: 'w1', type: 'sl', trigger_pct: -30, baseline_multi: 1, peak_rel: null,
      expires_at: null, active: false, attempts: 0, created_at: T0 - 1000, source: 'ui' });
    const { ctx, edits } = fakeCtx();
    await startPositionMonitor(ctx);
    expect(edits[0]).toContain('✋ manual position · 🧪 DRY RUN (virtual)');
    expect(edits[0]).toContain('🛡️ TSL @ -10.0% from peak');
    expect(edits[0]).toContain('+40.0% saved');                                // (1.5 - 1) * 100 + (-10)
    const labels = JSON.stringify(ctx.telegram.editMessageText.mock.calls[0][4]);
    expect(labels).toContain('Sell Limits (1 TP · 0 SL · 1 TSL)');             // only the active orders
  });

  it('the card refreshes every 5 s on the injected clock; a closed position stops it with "Position closed"', async () => {
    writer.put(pos({ position_id: 'p1' }));
    const { ctx, edits } = fakeCtx();
    await startPositionMonitor(ctx);
    expect(edits).toHaveLength(1);
    expect(clock.pendingTimers()).toBe(1);
    await clock.advance(5_000);
    expect(edits).toHaveLength(2);
    expect(edits[1]).toContain('Refreshed 5s ago');
    await clock.advance(10_000);
    expect(edits).toHaveLength(4);

    writer.close('p1', { closed_at: T0 + 20_000, reason: 'manual', realized_sol_net_lamports: null, rent_reclaimed_lamports: null, close_account_status: 'skipped', close_account_tx: null });
    await clock.advance(5_000);
    expect(edits.at(-1)).toContain('Position closed');
    expect(listActiveMonitorCards()).toEqual([]);
    expect(clock.pendingTimers()).toBe(0);
    await clock.advance(30_000);
    expect(edits.at(-1)).toContain('Position closed');
    expect(edits.filter(e => e.includes('Position closed'))).toHaveLength(1);
  });

  it('30 minutes without a tap pauses the refresh; 🔄 resumes it', async () => {
    writer.put(pos({ position_id: 'p1' }));
    const { ctx, edits } = fakeCtx();
    await startPositionMonitor(ctx);
    await clock.advance(30 * 60_000);
    const before = edits.length;
    await clock.advance(10_000);                                               // past the idle limit: the next tick pauses the card
    const paused = edits.length;
    await clock.advance(60_000);
    expect(edits.length).toBe(paused);
    expect(paused).toBeLessThanOrEqual(before + 1);
    expect(clock.pendingTimers()).toBe(0);

    await handlePmCallback(ctx, 'pm:refresh');
    expect(edits.length).toBe(paused + 1);
    await clock.advance(5_000);
    expect(edits.length).toBe(paused + 2);                                     // running again
  });

  it('navigation walks the tokens with open positions and wraps around; pm:close deletes the message and stops the card', async () => {
    writer.put(pos({ position_id: 'p1', ca: CA1 }));
    writer.put(pos({ position_id: 'p2', ca: CA2, entry: { tx: 'buyTxSigC', opened_at: T0 - 100_000, sol_spent_lamports: '10000000', tokens_raw: '1', fill_source: 'tx_meta' } }));
    const { ctx, edits } = fakeCtx();
    await startPositionMonitor(ctx);
    expect(getCurrentCaForCallback(ctx)).toBe(CA1);
    expect(edits[0]).toContain('Position 1/2');
    await handlePmCallback(ctx, 'pm:nav:next');
    expect(getCurrentCaForCallback(ctx)).toBe(CA2);
    expect(edits.at(-1)).toContain('Position 2/2');
    await handlePmCallback(ctx, 'pm:nav:next');
    expect(getCurrentCaForCallback(ctx)).toBe(CA1);
    await handlePmCallback(ctx, 'pm:nav:prev');
    expect(getCurrentCaForCallback(ctx)).toBe(CA2);

    expect(await handlePmCallback(ctx, 'pm:close')).toBe(true);
    expect(ctx.deleteMessage).toHaveBeenCalledTimes(1);
    expect(listActiveMonitorCards()).toEqual([]);
    expect(clock.pendingTimers()).toBe(0);
    expect(await handlePmCallback(ctx, 'pm:refresh')).toBe(false);             // not a monitored message any more
  });

  it('listActiveMonitorCards / stopMonitorCard / stopAllForChat', async () => {
    writer.put(pos({ position_id: 'p1' }));
    const a = fakeCtx(7, 11);
    const b = fakeCtx(8, 12);
    await startPositionMonitor(a.ctx);
    await startPositionMonitor(b.ctx);
    expect(listActiveMonitorCards()).toEqual([{ chatId: 7, messageId: 11, ca: CA1 }, { chatId: 8, messageId: 12, ca: CA1 }]);
    stopMonitorCard(7, 11);
    expect(listActiveMonitorCards()).toEqual([{ chatId: 8, messageId: 12, ca: CA1 }]);
    stopMonitorCard(7, 11);                                                    // idempotent
    stopAllForChat(8);
    expect(listActiveMonitorCards()).toEqual([]);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('the anti-MEV toggle flips the label and writes only position-prefs.json; the legacy positions.json is never touched', async () => {
    writer.put(pos({ position_id: 'p1' }));
    const legacyText = JSON.stringify({ [CA1]: { slippageBps: 450, tipSol: 0.001, wallets: {} } });
    fs.writeFileSync(path.join(dir, 'positions.json'), legacyText);
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ global: { slippageBps: 300, antiMev: false } }));
    const { ctx, edits } = fakeCtx();
    await startPositionMonitor(ctx);
    const kb = () => JSON.stringify(ctx.telegram.editMessageText.mock.calls.at(-1)![4]);
    expect(kb()).toContain('Anti-MEV: OFF');
    expect(kb()).toContain('Slippage 4.5%');                                   // no prefs row yet: the legacy per-token entry is the read fallback
    expect(kb()).toContain('Tip 0.0010 SOL');

    await handlePmCallback(ctx, `pm:cfg:mev:${CA1}`);
    expect(kb()).toContain('Anti-MEV: ON');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'position-prefs.json'), 'utf8'))[CA1]).toEqual({ antiMev: true });
    expect(fs.readFileSync(path.join(dir, 'positions.json'), 'utf8')).toBe(legacyText);
    await handlePmCallback(ctx, `pm:cfg:mev:${CA1}`);
    expect(kb()).toContain('Anti-MEV: OFF');
    expect(edits.length).toBeGreaterThanOrEqual(3);
  });

  it('A-80 the per-token slippage, tip and anti-MEV on the card come from position-prefs.json; the legacy positions.json entry only fills a field the prefs row lacks', async () => {
    writer.put(pos({ position_id: 'p1' }));
    const put = (file: string, body: unknown) => fs.writeFileSync(path.join(dir, file), JSON.stringify(body));
    put('settings.json', { global: { slippageBps: 300, antiMev: false } });
    put('positions.json', { [CA1]: { slippageBps: 450, tipSol: 0.001, antiMev: false, wallets: {} } });
    put('position-prefs.json', { [CA1]: { slippageBps: 800, tipSol: 0.0005, antiMev: true } });
    const { ctx } = fakeCtx();
    await startPositionMonitor(ctx);
    const kb = () => JSON.stringify(ctx.telegram.editMessageText.mock.calls.at(-1)![4]);
    // the per-token value is on the card, the legacy entry (4.5%, 0.0010, OFF) is not
    expect(kb()).toContain('Slippage 8.0%');
    expect(kb()).toContain('Tip 0.0005 SOL');
    expect(kb()).toContain('Anti-MEV: ON');
    expect(kb()).not.toContain('Slippage 4.5%');
    expect(kb()).not.toContain('Tip 0.0010 SOL');

    // a prefs row with only the slippage: the tip (and the anti-MEV choice) fall back to the legacy entry
    put('position-prefs.json', { [CA1]: { slippageBps: 800 } });
    await handlePmCallback(ctx, 'pm:refresh');
    expect(kb()).toContain('Slippage 8.0%');
    expect(kb()).toContain('Tip 0.0010 SOL');
    expect(kb()).toContain('Anti-MEV: OFF');

    // a tip of 0 in the prefs row is a real choice, not a missing value
    put('position-prefs.json', { [CA1]: { tipSol: 0 } });
    await handlePmCallback(ctx, 'pm:refresh');
    expect(kb()).toContain('Tip 0.0000 SOL');
    expect(kb()).toContain('Slippage 4.5%');

    // a prefs row of another token does not leak into this card; no legacy entry either: settings.json global, then the defaults
    put('position-prefs.json', { [CA2]: { slippageBps: 900, tipSol: 0.002, antiMev: true } });
    put('positions.json', {});
    await handlePmCallback(ctx, 'pm:refresh');
    expect(kb()).toContain('Slippage 3.0%');
    expect(kb()).toContain('Tip 0.0002 SOL');
    expect(kb()).toContain('Anti-MEV: OFF');
  });

  it('a positions file that cannot be read is said so and nothing is changed', async () => {
    fs.writeFileSync(path.join(dir, 'positions-v2.json'), '{ not json');
    const { ctx } = fakeCtx();
    await startPositionMonitor(ctx);
    expect(String(ctx.reply.mock.calls[0][0])).toContain('cannot be read');
    expect(fs.readFileSync(path.join(dir, 'positions-v2.json'), 'utf8')).toBe('{ not json');
  });

  it('the module imports no scanner, no price API client and reads no positions.json for amounts (A-39)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'position-monitor.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]\.\.\/scanners\//);
    expect(src).not.toMatch(/node-fetch|undici|dexscreener|jupiter-price|pumpfun-direct/i);
    expect(src).toMatch(/from '\.\.\/exits\/positions-store'/);                // positions come from the store ...
    expect(src).toMatch(/from '\.\.\/exits\/valuation'/);                      // ... the worth from the valuation module
  });
});

describe('B5 bot guards over the purged files', () => {
  const BOT_ROOT = path.resolve(__dirname, '..', '..');
  const purged = [
    'src/bot/position-monitor.ts', 'src/bot/position-card.ts', 'src/bot/position-cleanup.ts', 'src/bot/skill-commands.ts', 'src/bot/md-safe.ts',
    'src/lib/http-client.ts', 'src/lib/redact.ts',
  ];
  const ownTests = [
    'src/bot/position-monitor.test.ts', 'src/bot/position-card.test.ts', 'src/bot/position-cleanup.test.ts', 'src/bot/skill-commands.test.ts',
    'src/config.test.ts', 'src/execution/jupiter.test.ts', 'src/execution/pumpfun-swap.test.ts',
    'src/execution/pumpfun-info.test.ts',
  ];

  it('B5-T01 guards G-S1, G-S13 and G-S17 pass over the purged files and the new tests with no exemption', () => {
    const res = runAllGuards({ root: BOT_ROOT, exemptions: {}, ctx: new ScanContext(BOT_ROOT) });
    expect(Object.keys(res).sort()).toEqual([...BOT_GUARD_IDS].sort());
    const mine = (id: (typeof BOT_GUARD_IDS)[number], files: string[]) => res[id].violations.filter(v => files.includes(v.file));
    expect(mine('G-S13', purged), formatViolations(mine('G-S13', purged))).toEqual([]);
    expect(mine('G-S1', purged), formatViolations(mine('G-S1', purged))).toEqual([]);
    expect(mine('G-S17', ownTests), formatViolations(mine('G-S17', ownTests))).toEqual([]);
    // the files exist (a typo in the list would make the check vacuous)
    for (const f of purged) expect(fs.existsSync(path.join(BOT_ROOT, ...f.split('/'))), f).toBe(true);
  });
});
