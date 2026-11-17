/**
 * B50 section 2 (R3-B5): the position card renderer. Pure, so no fakes: an unknown value is an em dash (never 0), every known
 * market number and the worth of the bag carry their age, and the links go to GMGN and Solscan only.
 */
import { describe, expect, it } from 'vitest';
import { renderPositionCard, securedLine, type PositionCardInput } from './position-card';

const CA = '8LmvqLQhC53pqTyChaGLUCYJgMrcAGiKN8FGEm8Gpump';

function card(over: Partial<PositionCardInput> = {}): PositionCardInput {
  return {
    ca: CA, ticker: 'CATE', name: 'Catemas', origin: 'signal', dryRun: false, venue: 'curve',
    tokenAmount: 1_234_567, worth: { value: 0.0521, src: 'onchain', ageSec: 3 }, avgCostSolPerToken: 4.05e-8, initialBuySol: 0.05, feesPaidSol: 0.00005,
    mcUsd: { value: 12_300, ageSec: 4 }, liqUsd: { value: 5_200, ageSec: 9 },
    netPnlSol: 0.0021, netPnlPct: 4.2, tsl: null,
    positionIndex: 1, positionTotal: 1, refreshedAgoSec: 5,
    slippageBps: 300, tipSol: 0.0002, antiMev: false, limits: { tp: 0, sl: 0, tsl: 0, buy: 0 }, firstBuyTxSig: 'buyTxSig1',
    ...over,
  };
}

const callbacks = (kb: any): string[] => (kb.reply_markup.inline_keyboard as any[][]).flat().map((b: any) => b.callback_data);

describe('renderPositionCard', () => {
  it('shows the worth with its source and age, the market numbers with their ages, and the PnL', () => {
    const { text } = renderPositionCard(card());
    expect(text).toContain('Market cap: <b>$12.30K (4s old)</b>');
    expect(text).toContain('Liquidity: <b>$5.20K (9s old)</b>');
    expect(text).toContain('worth <b>0.0521 SOL</b> (onchain, 3s old)');
    expect(text).toContain('You hold 1.23M tokens');
    expect(text).toContain('Avg cost: 4.05e-8 SOL/tok');
    expect(text).toContain('Net PnL: <b>+0.0021 SOL (+4.2%)</b> 🟢');
    expect(text).toContain('Initial buy: 0.0500 SOL');
    expect(text).toContain('🚀 Pump.fun bonding curve');
    expect(text).toContain('🤖 signal position');
    expect(text).toContain('Refreshed 5s ago');
    expect(text).toContain(`CA: <code>${CA}</code>`);
  });

  it('every unknown value is an em dash, never 0 or $0', () => {
    const { text } = renderPositionCard(card({
      ticker: null, name: null, venue: null, tokenAmount: null, worth: { value: null, src: null, ageSec: null },
      avgCostSolPerToken: null, initialBuySol: null, feesPaidSol: null, mcUsd: { value: null, ageSec: null }, liqUsd: { value: null, ageSec: null },
      netPnlSol: null, netPnlPct: null,
    }));
    expect(text).toContain('🪙 <b>—</b> · —');
    expect(text).toContain('Market cap: <b>—</b>  |  Liquidity: <b>—</b>');
    expect(text).toContain('You hold — tokens');
    expect(text).toContain('Avg cost: — SOL/tok · worth <b>—</b>');
    expect(text).toContain('Initial buy: — SOL  ·  Fees paid: — SOL');
    expect(text).toContain('Net PnL: <b>—</b> (entry not verified)');
    expect(text).not.toMatch(/\$0|\b0\.0000 SOL|NaN|undefined|null/);
    expect(text).not.toContain('Pump.fun bonding curve');                // the Engine did not say: no venue line
  });

  it('a known value whose age is unknown says so; an unknown source says so', () => {
    const { text } = renderPositionCard(card({ mcUsd: { value: 9_000, ageSec: null }, worth: { value: 0.04, src: null, ageSec: null } }));
    expect(text).toContain('Market cap: <b>$9.00K (age unknown)</b>');
    expect(text).toContain('worth <b>0.0400 SOL</b> (source unknown, age unknown)');
  });

  it('ages above a minute print in minutes and hours', () => {
    const { text } = renderPositionCard(card({ mcUsd: { value: 1_500_000, ageSec: 300 }, worth: { value: 1, src: 'jupiter', ageSec: 7_500 } }));
    expect(text).toContain('Market cap: <b>$1.50M (5m old)</b>');
    expect(text).toContain('(jupiter, 2h old)');
  });

  it('links go to GMGN and Solscan only: no DexScreener, no RugCheck', () => {
    const { text } = renderPositionCard(card());
    expect(text).toContain(`https://gmgn.ai/sol/token/${CA}`);
    expect(text).toContain(`https://solscan.io/token/${CA}`);
    expect(text).toContain('https://solscan.io/tx/buyTxSig1');
    expect(text).not.toMatch(/dexscreener|rugcheck/i);
    expect(renderPositionCard(card({ firstBuyTxSig: null })).text).toContain('🧾 Buy Tx');
  });

  it('origin and dry-run tags; a manual position is not called a signal position', () => {
    expect(renderPositionCard(card({ origin: 'manual' })).text).toContain('✋ manual position');
    const dry = renderPositionCard(card({ dryRun: true })).text;
    expect(dry).toContain('🧪 DRY RUN (virtual)');
    expect(renderPositionCard(card()).text).not.toContain('DRY RUN');
    expect(renderPositionCard(card({ venue: 'graduated' })).text).toContain('💧 PumpSwap / pool (graduated)');
  });

  it('names are HTML-escaped; the carousel counter shows only with several positions', () => {
    const t = renderPositionCard(card({ ticker: '<b>X</b>', name: 'A&B', positionTotal: 3, positionIndex: 2 })).text;
    expect(t).toContain('&lt;b&gt;X&lt;/b&gt;');
    expect(t).toContain('A&amp;B');
    expect(t).toContain('Position 2/3');
    expect(renderPositionCard(card()).text).not.toContain('Position 1/1');
  });

  it('the TSL block shows for a winning position with an active TSL, with the moved marker; not for a losing one', () => {
    const tsl = { triggerPct: -10, highestMultiplier: 1.5, securedPct: 40, movedRecently: true, movedAgoSec: 4 };
    const win = renderPositionCard(card({ tsl })).text;
    expect(win).toContain('🛡️ TSL @ -10.0% from peak ✨ moved 4s ago');
    expect(win).toContain(securedLine(40));
    expect(renderPositionCard(card({ tsl, netPnlSol: -0.01, netPnlPct: -20 })).text).not.toContain('TSL @');
    expect(renderPositionCard(card({ tsl, netPnlSol: null, netPnlPct: null })).text).not.toContain('TSL @');
  });

  it('securedLine escalates with the secured percentage', () => {
    expect(securedLine(-5)).toContain('floor');
    expect(securedLine(10)).toContain('green floor');
    expect(securedLine(50)).toContain('TSL got your back');
    expect(securedLine(100)).toContain('house money');
    expect(securedLine(300)).toContain('let it ride');
  });

  it('the keyboard keeps every callback the bot.ts handlers read', () => {
    const { keyboard } = renderPositionCard(card({ limits: { tp: 1, sl: 1, tsl: 0, buy: 0 }, antiMev: true }));
    expect(callbacks(keyboard)).toEqual([
      'pm:nav:prev', 'pm:refresh', 'pm:nav:next',
      `pm:sell:init:${CA}`, `pm:sell:all:${CA}`,
      `pm:sell:pct:${CA}:25`, `pm:sell:pct:${CA}:50`, `pm:sell:pct:${CA}:75`, `pm:sell:pct:${CA}:100`,
      `pm:sell:xpct:${CA}`, `pm:sell:xsol:${CA}`, `pm:sell:xtok:${CA}`,
      `pm:cfg:slip:${CA}`, `pm:cfg:tip:${CA}`,
      `pm:cfg:mev:${CA}`, `pm:limits:${CA}`,
      'pm:close',
    ]);
    const labels = (keyboard.reply_markup.inline_keyboard as any[][]).flat().map((b: any) => b.text);
    expect(labels).toContain('⚙️ Slippage 3.0%');
    expect(labels).toContain('💎 Tip 0.0002 SOL');
    expect(labels).toContain('🛡️ Anti-MEV: ON');
    expect(labels).toContain('⏰ Sell Limits (1 TP · 1 SL · 0 TSL)');
    expect(renderPositionCard(card()).keyboard.reply_markup.inline_keyboard.flat().map((b: any) => b.text)).toContain('⏰ Sell Limits (none)');
  });
});
