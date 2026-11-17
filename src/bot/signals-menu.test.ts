/**
 * A-115 (CARD-MENU spec sections 5 and 8): the restored Signals menu, the grade-preset view, the typed inputs, ✖ Cancel and /start
 * (MENU-T01 ... MENU-T07, MENU-T11). The menus are pure builders (signals-menu.ts); bot.ts is checked by a static scan of its source
 * (it is never imported by a test: importing it would start nothing, but it reads the config at load).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPolicies } from '../shared/exit-policy/exit-policy';
import policiesJson from '../shared/exit-policy/exit-policies.json';
import { defaultGradePresets, type CustomPreset } from '../exits/presets';
import {
  cancelPrompt, CANCEL_ROW, createNonceBook, NONCE_TTL_MS, sellPctRows, signalsMenuView, startAction, tierMenuView, triggerRows, type MenuRows, type SignalsMenuInput,
} from './signals-menu';
import {
  boundPairError, MIN_SCORE_ERROR, parseArmAfter, parseMaxHold, parseMinScore, parseSellPct, parseStopPct, parseTpTrigger, parseTrailPct, parseUsdBound,
  restoredDefaults, USD_ERROR,
} from './signal-settings';

const EA = loadPolicies(policiesJson).EA;
const BOT_SRC = fs.readFileSync(path.join(__dirname, 'bot.ts'), 'utf8');
const data = (rows: MenuRows): string[] => rows.flat().map(b => b.data);
const texts = (rows: MenuRows): string[] => rows.flat().map(b => b.text);

function menuInput(over: Partial<SignalsMenuInput['signal']> = {}): SignalsMenuInput {
  return {
    brand: 'Pumpstriker Bots',
    signal: { ...restoredDefaults(), tgMinGrade: 'B', buyAmount: 0.01, slippageBps: null, degenMode: null, sessionEnabled: false, ...over },
    globalSlippageBps: 300, globalDegen: false,
    sessionLine: '⏰ Auto-Buy Session: OFF — buys 24/7', sessionButton: '⏰ Auto-Buy Session: 24/7 — tap to set hours',
    autoBuyLine: 'OFF', active: EA,
  };
}
const imported: CustomPreset = {
  mode: 'custom', rev: 1, enabled: true, source: 'imported:tier5', updatedAt: 1, stop: { lossPct: 35, whilePeakBelowPct: null },
  ladder: [{ atPct: 80, sellPctOfOriginal: 25, trigger: 'entryPrice' }, { atPct: 400, sellPctOfOriginal: 26.25, trigger: 'entryPrice' }],
  trail: { armAfterPct: 200, trailPct: 40, trigger: 'entryPrice' }, maxHoldH: null,
};

/** Every Markdown entity is balanced and no data character can break it (legacy Markdown: * _ ` [ are the entity characters). */
function markdownSafe(text: string): boolean {
  const stars = (text.match(/\*/g) ?? []).length;
  return stars % 2 === 0 && !/[_`[\]]/.test(text.replace(/`[^`\n]*`/g, ''));
}

describe('the Signals menu', () => {
  it('MENU-T02 the rows, labels and callback data in the order of section 5; every callback is at most 64 bytes', () => {
    const v = signalsMenuView(menuInput());
    expect(v.rows.map(r => r.map(b => b.data))).toEqual([
      ['sig:toggle'],
      ['sig:set:minScore', 'sig:set:buyAmount'],
      ['sig:set:minMcap', 'sig:set:maxMcap'],
      ['sig:set:minLiquidity', 'sig:set:maxLiquidity'],
      ['sig:set:slippageBps', 'sig:toggle:degenMode'],
      ['sig:cycle:tgGrade'],
      ['stime:menu'],
      ['sig:toggle:autoSell'],
      ['tier:view:A'], ['tier:view:B'], ['tier:view:C'],
      ['menu:main'],
    ]);
    expect(texts(v.rows)).toEqual(expect.arrayContaining([
      '🟢 Active — Toggle OFF', '🎯 Min Score', '💰 Buy Amount', '📉 Min MCap', '📈 Max MCap', '💧 Min Liq', '💧 Max Liq', '🌊 Slippage %', '😇 Degen OFF',
      '💸 Auto-Sell by Grade: ON — Toggle OFF', '« Back',
    ]));
    expect(texts(v.rows).filter(t => t.includes('Grade A preset'))[0]).toMatch(/^🦈🚀 \[A\] Grade A preset: 7 leg\(s\) · exit policy EA$/);
    for (const d of data(v.rows)) expect(Buffer.byteLength(d, 'utf8'), d).toBeLessThanOrEqual(64);
    expect(v.text).toContain('Status: ✅ Active');
    expect(v.text).toContain('Min Score: *None*');
    expect(v.text).toContain('Min MCap: None · Max MCap: None');
    // the old values show as the old menu showed them, and an invalid bound says so
    const set = signalsMenuView(menuInput({ enabled: false, minScore: 90, maxMcap: 150_000, minLiquidity: 'invalid', autoSellOnSignal: false, gradePresets: { ...defaultGradePresets(), A: imported } }));
    expect(set.text).toContain('Status: ❌ Inactive');
    expect(set.text).toContain('Min Score: *90*');
    expect(set.text).toContain('Max MCap: $150,000');
    expect(set.text).toContain('Min Liq: ⚠ invalid');
    expect(texts(set.rows)).toContain('🔴 Inactive — Toggle ON');
    expect(texts(set.rows)).toContain('💸 Auto-Sell by Grade: OFF — Toggle ON');
    expect(texts(set.rows)).toContain('🦈🚀 [A] Grade A preset: 5 leg(s) · imported tier5 rev 1');
    expect(markdownSafe(v.text) && markdownSafe(set.text)).toBe(true);
  });

  it('MENU-T06 the grade view (old tier view): add TP / SL / TSL, one remove row per order (never for the stop), max hold, no stop, reset, apply, clear', () => {
    const v = tierMenuView({ grade: 'A', preset: imported, active: EA, autoSellOnSignal: true, openCount: 2, now: 1 });
    expect(v.rows.map(r => r.map(b => b.data))).toEqual([
      ['tier:tog:A'],
      ['tier:add:tp:A', 'tier:add:sl:A', 'tier:add:tsl:A'],
      ['tier:del:A:1'], ['tier:del:A:2'], ['tier:del:A:3'],
      ['tier:set:hold:A', 'tier:nostop:A'],
      ['tier:reset:A'],
      ['tier:apply:A'],
      ['tier:clear:A'],
      ['menu:signals'],
    ]);
    expect(texts(v.rows)).toContain('❌ Remove: 🎯 TP +80% → sell 25%');
    expect(texts(v.rows)).toContain('♻️ Apply to open positions (2)');
    expect(v.text).toContain('1. 🛑 SL −35%');
    expect(v.text).toContain('Stop: −35% · hard-rug exit at −40% within 15s');
    expect(v.text).toContain('Sell % = % of the ORIGINAL position');
    // a policy preset shows the policy's legs and has no toggle / reset; its first edit copies them
    const p = tierMenuView({ grade: 'B', preset: { mode: 'policy' }, active: EA, autoSellOnSignal: true, openCount: 0, now: 1 });
    expect(data(p.rows)).not.toContain('tier:tog:B');
    expect(data(p.rows)).not.toContain('tier:reset:B');
    expect(p.text).toContain('follows exit policy EA');
    expect(p.text).toContain('Stop: −38% while the peak is below +50%');
    for (const d of [...data(v.rows), ...data(p.rows)]) expect(Buffer.byteLength(d, 'utf8')).toBeLessThanOrEqual(64);
    // the trigger and sell-% steps (old tier:trig / tb:bal) carry ✖ Cancel
    expect(data(triggerRows())).toEqual(['tier:trig:entryPrice', 'tier:trig:price', 'tier:trig:mcap', 'in:cancel']);
    expect(data(sellPctRows())).toEqual(['tb:bal:25', 'tb:bal:50', 'tb:bal:75', 'tb:bal:100', 'tb:bal:custom', 'in:cancel']);
    // a no-stop preset warns in the view
    const ns = tierMenuView({ grade: 'C', preset: { ...imported, stop: { none: true, confirmedAt: 5 } }, active: EA, autoSellOnSignal: true, openCount: 0, now: 1 });
    expect(ns.text).toContain('NO stop-loss (you confirmed it)');
    expect(ns.text).toContain('Stop: NONE (you confirmed no stop)');
  });

  it('MENU-T11 menus render with hostile imported labels: the Markdown characters are stripped, the entities stay balanced', () => {
    const hostile: CustomPreset = { ...imported, source: 'imported:*t_[1]`' };
    const v = signalsMenuView(menuInput({ gradePresets: { A: hostile, B: hostile, C: { mode: 'policy' } }, tgMinGrade: 'B', buyAmount: '0.1*' as unknown as number }));
    expect(markdownSafe(v.text)).toBe(true);
    const t = tierMenuView({ grade: 'A', preset: hostile, active: EA, autoSellOnSignal: true, openCount: 0, now: 1 });
    expect(markdownSafe(t.text)).toBe(true);
    expect(t.text).toContain('imported from t1');
  });
});

describe('the typed inputs (spec 5.1)', () => {
  it('MENU-T03 Min Score: blank/none, 0, 90, 100 accepted; abc, 101, -1, 1e3, 90.5 refused with the text of 5.1', () => {
    expect(parseMinScore('none')).toEqual({ ok: true, value: null });
    expect(parseMinScore('  ')).toEqual({ ok: true, value: null });
    expect(parseMinScore('0')).toEqual({ ok: true, value: 0 });
    expect(parseMinScore('90')).toEqual({ ok: true, value: 90 });
    expect(parseMinScore('100')).toEqual({ ok: true, value: 100 });
    for (const bad of ['abc', '101', '-1', '1e3', '90.5']) expect(parseMinScore(bad), bad).toEqual({ ok: false, error: MIN_SCORE_ERROR });
    expect(MIN_SCORE_ERROR).toBe('Enter a whole number from 0 to 100 (blank = no minimum).');
  });

  it('MENU-T04 the bounds: 0 / blank -> no limit; min > max refused in both directions with the 5.1 texts', () => {
    expect(parseUsdBound('0')).toEqual({ ok: true, value: null });
    expect(parseUsdBound('none')).toEqual({ ok: true, value: null });
    expect(parseUsdBound('150000')).toEqual({ ok: true, value: 150_000 });
    expect(parseUsdBound('$150,000')).toEqual({ ok: true, value: 150_000 });
    expect(parseUsdBound('20k')).toEqual({ ok: true, value: 20_000 });
    for (const bad of ['-5', 'abc', '1e20', 'Infinity', '5 SOL']) expect(parseUsdBound(bad), bad).toEqual({ ok: false, error: USD_ERROR });
    const cur = { ...restoredDefaults(), maxMcap: 150_000, minLiquidity: 9_000 };
    expect(boundPairError('minMcap', 200_000, cur)).toBe('Min MCap $200,000 is above Max MCap $150,000. Lower it or raise Max MCap first.');
    expect(boundPairError('maxLiquidity', 1_000, cur)).toBe('Max Liq $1,000 is below Min Liq $9,000. Raise it or lower Min Liq first.');
    expect(boundPairError('minMcap', 100_000, cur)).toBeNull();
    expect(boundPairError('minMcap', null, cur)).toBeNull();
    // bot.ts saves settings.json atomically (a temp file renamed over it) and refuses with "Nothing was saved." while keeping the prompt
    expect(BOT_SRC).toMatch(/function writeJson[\s\S]{0,600}renameSync\(tmp, target\)/);
    expect(BOT_SRC).toContain("if (refusal) return reprompt(ctx, key, `❌ ${refusal} Nothing was saved.`);");
    expect(BOT_SRC).toContain("'sig:minMcap':              boundSetter('minMcap'),");
  });

  it('MENU-T06 the tier inputs: TP trigger, sell %, SL %, TSL arm and trail, max hold', () => {
    expect(parseTpTrigger('100')).toEqual({ ok: true, value: 100 });
    expect(parseTpTrigger('+50%')).toEqual({ ok: true, value: 50 });
    for (const bad of ['0', '-5', '100001', 'x']) expect(parseTpTrigger(bad).ok, bad).toBe(false);
    expect(parseSellPct('35')).toEqual({ ok: true, value: 35 });
    for (const bad of ['0', '101', '35.5', 'x']) expect(parseSellPct(bad).ok, bad).toBe(false);
    expect(parseStopPct('-30')).toEqual({ ok: true, value: 30 });
    for (const bad of ['0', '96', 'x']) expect(parseStopPct(bad).ok, bad).toBe(false);
    expect(parseArmAfter('0')).toEqual({ ok: true, value: 0 });
    expect(parseArmAfter('10001').ok).toBe(false);
    expect(parseTrailPct('40')).toEqual({ ok: true, value: 40 });
    expect(parseTrailPct('0').ok).toBe(false);
    expect(parseMaxHold('0')).toEqual({ ok: true, value: null });
    expect(parseMaxHold('6')).toEqual({ ok: true, value: 6 });
    for (const bad of ['169', '1.5', '-1']) expect(parseMaxHold(bad).ok, bad).toBe(false);
  });
});

describe('prompts, ✖ Cancel and /start', () => {
  it('MENU-T05 every prompt that sets awaitingInput carries ✖ Cancel: only prompt() and reprompt() set it, and both attach in:cancel', () => {
    const assigns = [...BOT_SRC.matchAll(/sess\.awaitingInput\s*=(?!=)(?!\s*null)/g)].map(m => m.index as number);
    const promptAt = BOT_SRC.indexOf('function prompt(ctx: any');
    const repromptAt = BOT_SRC.indexOf('function reprompt(ctx: any');
    expect(promptAt).toBeGreaterThan(0);
    expect(repromptAt).toBeGreaterThan(promptAt);
    expect(assigns).toHaveLength(2);
    expect(assigns[0]).toBeGreaterThan(promptAt);
    expect(assigns[0]).toBeLessThan(repromptAt);
    expect(assigns[1]).toBeGreaterThan(repromptAt);
    expect(assigns[1] - repromptAt).toBeLessThan(200);
    const helpers = BOT_SRC.slice(promptAt, repromptAt + 300);
    expect(helpers.match(/cancelButton\(\)/g)?.length).toBe(2);
    expect(BOT_SRC).toContain("const cancelButton = () => Markup.button.callback('✖ Cancel', 'in:cancel');");
    expect(BOT_SRC).toContain("if (data === 'in:cancel') {");
    expect(CANCEL_ROW).toEqual([{ text: '✖ Cancel', data: 'in:cancel' }]);
    // behaviour: ✖ Cancel clears the input and returns the menu to re-open
    const sess = { awaitingInput: 'sig:minScore' as string | null, returnTo: 'menu:signals' as string | null, pendingData: { tier: { grade: 'A' } } as Record<string, unknown> };
    expect(cancelPrompt(sess)).toBe('menu:signals');
    expect(sess).toEqual({ awaitingInput: null, returnTo: null, pendingData: { tier: null } });
    expect(cancelPrompt({ awaitingInput: 'x', returnTo: null })).toBe('menu:main');
  });

  it('MENU-T01 /start (no payload) and /menu open the main menu and clear a pending prompt; /start <CA> still opens the token card', () => {
    expect(startAction('/start')).toEqual({ kind: 'menu' });
    expect(startAction('/start hello')).toEqual({ kind: 'menu' });
    const ca = 'ttFbypXwcXGc3ybAM7id8fW3Bi4dgKaAxAf1MTmYpump';
    expect(startAction(`/start ${ca}`)).toEqual({ kind: 'token', ca });
    const start = BOT_SRC.slice(BOT_SRC.indexOf('bot.start(async ctx => {'), BOT_SRC.indexOf("bot.command('menu'"));
    expect(start.indexOf('sess.awaitingInput = null;')).toBeGreaterThan(0);
    expect(start.indexOf('sess.awaitingInput = null;')).toBeLessThan(start.indexOf('startAction('));
    expect(start).toContain('const m = mainMenu();');
    const menu = BOT_SRC.slice(BOT_SRC.indexOf("bot.command('menu'"), BOT_SRC.indexOf("bot.command('menu'") + 600);
    expect(menu).toContain('sess.awaitingInput = null;');
    expect(menu).toContain('mainMenu()');
  });

  it('MENU-T07 the "no stop" confirmation: a fresh nonce works once; a stale, reused or foreign nonce is refused', () => {
    let n = 0;
    const book = createNonceBook(() => `${(++n).toString(16).padStart(12, 'a')}`);
    const t = 1_000_000;
    const a = book.issue('nostop:B', t);
    expect(book.consume('nostop:A', a, t)).toBe(false);                 // another grade's confirm
    const b = book.issue('nostop:B', t);
    expect(book.consume('nostop:B', b, t + 1000)).toBe(true);
    expect(book.consume('nostop:B', b, t + 2000)).toBe(false);          // single use
    const c = book.issue('nostop:B', t);
    expect(book.consume('nostop:B', c, t + NONCE_TTL_MS)).toBe(false);  // stale
    expect(book.consume('nostop:B', 'deadbeef0000', t)).toBe(false);
    // bot.ts reaches a stop-less preset only through the confirm button with the nonce
    expect(BOT_SRC).toContain("NONCES.consume(`nostop:${gg}`, parts[4] || '', now)");
    expect(BOT_SRC.match(/setNoStop\(/g)?.length).toBe(1);
  });

  it('CARD-T12 / spec 5.3 the signal card buttons: one 🟢 Buy per buy amount (sbuy:), the skills row; the links come only from card-links.ts', () => {
    expect(BOT_SRC).toContain('callback_data: `sbuy:${ca}:${a}`');
    expect(BOT_SRC).toContain("if (data.startsWith('sbuy:') && data.split(':').length === 3) {");
    expect(BOT_SRC).toContain('cardBuyPlan(presetSettingsOf(loadSettings()), grade, activePolicy()');
  });
});
