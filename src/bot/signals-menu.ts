/**
 * signals-menu.ts (A-115, CARD-MENU spec section 5): the restored 📡 Signals menu and the per-grade preset view (the old bot's per-tier
 * view, now per grade A / B / C), as pure builders: text (legacy Markdown) plus rows of { text, data } buttons. bot.ts turns the rows into
 * Telegraf buttons; tests check rows, labels, the callback data (<= 64 bytes) and the text without starting Telegram.
 *
 * Every value printed here is a number, a fixed word, or a string cleaned by mdSafe (the Markdown entity characters are stripped), so a
 * hand-edited or imported label can never make Telegram refuse the menu.
 */
import type { Grade } from '../shared/common/ids';
import { mdSafe } from './md-safe';
import { playbookLines } from '../shared/card/playbook';
import {
  hasNoStop, isCustom, itemText, materialize, presetItems, presetToPolicy, type ActivePolicy, type CustomPreset, type GradePreset,
} from '../exits/presets';
import { boundText, type RestoredSignal } from './signal-settings';

export interface MenuButton { text: string; data: string }
export type MenuRows = MenuButton[][];
export interface MenuView { text: string; rows: MenuRows }

export const GRADE_EMOJI: Readonly<Record<Grade, string>> = { A: '🦈🚀', B: '🦈🔥', C: '🦈👀' };
const GRADES: readonly Grade[] = ['A', 'B', 'C'];
const b = (text: string, data: string): MenuButton => ({ text, data });
/** Markdown-safe text for the menus (Markdown entity characters, controls and bidi removed). */
const md = (s: unknown, max = 64): string => mdSafe(String(s ?? ''), max);

export interface SignalsMenuInput {
  brand: string;
  signal: RestoredSignal & {
    tgMinGrade: string; buyAmount: unknown; slippageBps: number | null; degenMode: boolean | null;
    sessionEnabled?: boolean;
  };
  globalSlippageBps: number;
  globalDegen: boolean;
  /** The session status line and the session button label (session-window.ts renders them; already Markdown-safe). */
  sessionLine: string;
  sessionButton: string;
  /** "OFF" / "DRY RUN on arm B1 …" (plain; cleaned here). */
  autoBuyLine: string;
  active: ActivePolicy;
}

function presetLabel(p: GradePreset, active: ActivePolicy): string {
  if (!isCustom(p)) return `${active.legs.length} leg(s) · exit policy ${md(active.id, 16)}`;
  const legs = presetItems(p).length + 1;   // + the hard-rug exit R0 that every plan keeps
  const src = p.source.startsWith('imported:') ? `imported ${md(p.source.slice('imported:'.length), 24)}` : 'your preset';
  return `${legs} leg(s) · ${src} rev ${p.rev}${p.enabled ? '' : ' · OFF'}${hasNoStop(p.stop) ? ' · NO stop' : ''}`;
}

/** The 📡 Signals menu (section 5 order). */
export function signalsMenuView(x: SignalsMenuInput): MenuView {
  const s = x.signal;
  const degen = (s.degenMode ?? x.globalDegen) === true;
  const slip = Number(s.slippageBps ?? x.globalSlippageBps);
  const minScore = s.minScore === null ? 'None' : s.minScore === 'invalid' ? '⚠ invalid' : String(s.minScore);
  const mcapWarn = typeof s.minMcap === 'number' && typeof s.maxMcap === 'number' && s.minMcap > s.maxMcap ? ' ⚠ min above max' : '';
  const liqWarn = typeof s.minLiquidity === 'number' && typeof s.maxLiquidity === 'number' && s.minLiquidity > s.maxLiquidity ? ' ⚠ min above max' : '';
  const tierLines = GRADES.map(g => `  ${GRADE_EMOJI[g]} Grade ${g}: ${presetLabel(s.gradePresets[g], x.active)}`).join('\n');
  const text =
    `📡 *${md(x.brand, 40)} Signals*\n\n` +
    `Status: ${s.enabled ? '✅ Active' : '❌ Inactive (no signal cards, no auto-buy)'}\n` +
    `Min Score: *${minScore}*\n` +
    `Buy Amount: *${md(s.buyAmount, 16)} SOL*\n` +
    `Slippage: *${Number.isFinite(slip) ? (slip / 100).toFixed(1) : '—'}%*\n` +
    `Degen Mode: ${degen ? '⚠️ ON' : 'OFF'}\n` +
    `Min MCap: ${boundText(s.minMcap)} · Max MCap: ${boundText(s.maxMcap)}${mcapWarn}\n` +
    `Min Liq: ${boundText(s.minLiquidity)} · Max Liq: ${boundText(s.maxLiquidity)}${liqWarn}\n` +
    `Cards in this chat: grade *${md(s.tgMinGrade, 1)}* and better\n` +
    `${x.sessionLine}\n` +
    `🤖 Auto-buy: *${md(x.autoBuyLine, 120)}*\n\n` +
    `💸 *Auto-Sell by Grade: ${s.autoSellOnSignal ? '✅ ON' : '❌ OFF'}* (your real positions; OFF = exit policy ${md(x.active.id, 16)})\n` +
    `${tierLines}\n\n` +
    `The Engine decides what is a signal and its grade; your filters only hide cards and skip auto-buys, they never add one. Arm auto-buy with /autobuy.`;
  const rows: MenuRows = [
    [b(s.enabled ? '🟢 Active — Toggle OFF' : '🔴 Inactive — Toggle ON', 'sig:toggle')],
    [b('🎯 Min Score', 'sig:set:minScore'), b('💰 Buy Amount', 'sig:set:buyAmount')],
    [b('📉 Min MCap', 'sig:set:minMcap'), b('📈 Max MCap', 'sig:set:maxMcap')],
    [b('💧 Min Liq', 'sig:set:minLiquidity'), b('💧 Max Liq', 'sig:set:maxLiquidity')],
    [b('🌊 Slippage %', 'sig:set:slippageBps'), b(degen ? '😈 Degen ON' : '😇 Degen OFF', 'sig:toggle:degenMode')],
    [b(`🅰️ Cards: grade ${md(s.tgMinGrade, 1)}+ — tap to cycle A/B/C`, 'sig:cycle:tgGrade')],
    [b(x.sessionButton, 'stime:menu')],
    [b(s.autoSellOnSignal ? '💸 Auto-Sell by Grade: ON — Toggle OFF' : '💸 Auto-Sell by Grade: OFF — Toggle ON', 'sig:toggle:autoSell')],
    ...GRADES.map(g => [b(`${GRADE_EMOJI[g]} [${g}] Grade ${g} preset: ${presetLabel(s.gradePresets[g], x.active)}`, `tier:view:${g}`)]),
    [b('« Back', 'menu:main')],
  ];
  return { text, rows };
}

export interface TierMenuInput {
  grade: Grade;
  preset: GradePreset;
  active: ActivePolicy;
  autoSellOnSignal: boolean;
  /** Real open positions of this grade that a plan applies to. */
  openCount: number;
  now: number;
}

/** The per-grade preset view (the old tierMenu shape). A `policy` preset shows the active policy's legs (its first edit copies them). */
export function tierMenuView(x: TierMenuInput): MenuView {
  const g = x.grade;
  const custom: CustomPreset = isCustom(x.preset) ? x.preset : materialize(x.active, x.now);
  const items = presetItems(custom);
  const head = isCustom(x.preset)
    ? `${x.preset.source.startsWith('imported:') ? `imported from ${md(x.preset.source.slice('imported:'.length), 24)}, ` : 'your preset, '}rev ${x.preset.rev}`
    : `follows exit policy ${md(x.active.id, 16)} (your first edit makes it your own preset)`;
  const status = !isCustom(x.preset) ? '✅ the exit policy applies'
    : x.preset.enabled ? (x.autoSellOnSignal ? '✅ ON' : '✅ ON, but Auto-Sell by Grade is OFF (the exit policy applies)') : '❌ OFF (the exit policy applies)';
  const orderLines = items.length > 0 ? items.map((it, i) => `  ${i + 1}. ${itemText(custom, it)}`).join('\n') : '  No orders: tap below to add';
  let preview: string[] = [];
  try {
    const plan = isCustom(x.preset) && x.preset.enabled && x.autoSellOnSignal
      ? (() => { const p = presetToPolicy(x.preset, x.active, g); return { source: 'preset' as const, grade: g, policyId: p.id, version: p.version, rev: x.preset.rev, legs: p.legs }; })()
      : { source: 'policy' as const, grade: g, policyId: x.active.id, version: x.active.version, rev: null, legs: x.active.legs };
    preview = playbookLines(plan).slice(1).map(l => `  ${md(l, 200)}`);
  } catch {
    preview = ['  ⚠ this preset cannot be used; the exit policy applies'];
  }
  const text =
    `${GRADE_EMOJI[g]} *Grade ${g} preset* — ${head}\n` +
    `Status: ${status}\n` +
    `${hasNoStop(custom.stop) ? '⚠️ NO stop-loss (you confirmed it). Only the hard-rug exit protects these positions.\n' : ''}\n` +
    `*Sell orders:*\n${orderLines}\n\n` +
    `*A buy from a grade-${g} card gets now:*\n${preview.join('\n')}\n\n` +
    `Open positions of this grade: ${x.openCount}\n` +
    `Sell % = % of the ORIGINAL position. Entry Price %, Price % and Market Cap % all measure the move from your entry. Positions keep the plan they opened with.`;
  const rows: MenuRows = [];
  if (isCustom(x.preset)) rows.push([b(x.preset.enabled ? '✅ Preset ON — tap to use the exit policy' : '❌ Preset OFF — tap to turn it ON', `tier:tog:${g}`)]);
  rows.push([b('➕ Add TP', `tier:add:tp:${g}`), b('➕ Add SL', `tier:add:sl:${g}`), b('➕ Add TSL', `tier:add:tsl:${g}`)]);
  items.forEach((it, i) => { if (it.kind !== 'sl') rows.push([b(`❌ Remove: ${itemText(custom, it)}`, `tier:del:${g}:${i}`)]); });
  rows.push([b(`⏳ Max hold: ${custom.maxHoldH === null ? 'none' : `${custom.maxHoldH}h`}`, `tier:set:hold:${g}`), b('🚫 No stop…', `tier:nostop:${g}`)]);
  if (isCustom(x.preset)) rows.push([b('↩️ Reset to exit policy', `tier:reset:${g}`)]);
  rows.push([b(`♻️ Apply to open positions (${x.openCount})`, `tier:apply:${g}`)]);
  rows.push([b('🗑 Clear All (the stop stays)', `tier:clear:${g}`)]);
  rows.push([b('« Signals', 'menu:signals')]);
  return { text, rows };
}

/** The "Trigger type" step of Add TP / SL / TSL (old 'tier:trig' buttons); every prompt has ✖ Cancel. */
export function triggerRows(): MenuRows {
  return [
    [b('🎯 Entry Price %', 'tier:trig:entryPrice'), b('💵 Price %', 'tier:trig:price'), b('🧢 Market Cap %', 'tier:trig:mcap')],
    [b('✖ Cancel', 'in:cancel')],
  ];
}
/** The sell-% step of Add TP (old 'tb:bal' buttons): % of the ORIGINAL position. */
export function sellPctRows(): MenuRows {
  return [
    [b('25%', 'tb:bal:25'), b('50%', 'tb:bal:50'), b('75%', 'tb:bal:75'), b('100%', 'tb:bal:100')],
    [b('Custom', 'tb:bal:custom'), b('✖ Cancel', 'in:cancel')],
  ];
}
export const CANCEL_ROW: MenuButton[] = [b('✖ Cancel', 'in:cancel')];

// ---------------------------------------------------------------------------------------------------------------------------------
// one-time confirmation nonces (No stop, Apply, Reset): single use, 5 minutes
// ---------------------------------------------------------------------------------------------------------------------------------

export const NONCE_TTL_MS = 5 * 60_000;
export interface NonceBook {
  issue(action: string, now: number): string;
  /** True once for a fresh nonce of this action; a stale, reused or foreign nonce is refused. */
  consume(action: string, nonce: string, now: number): boolean;
}
export function createNonceBook(random: () => string): NonceBook {
  const book = new Map<string, { action: string; expires: number }>();
  return {
    issue(action, now) {
      for (const [k, v] of book) if (v.expires <= now) book.delete(k);
      const nonce = random().replace(/[^0-9a-f]/gi, '').slice(0, 12) || String(now % 1e9);
      book.set(nonce, { action, expires: now + NONCE_TTL_MS });
      return nonce;
    },
    consume(action, nonce, now) {
      const e = book.get(nonce);
      if (e === undefined) return false;
      book.delete(nonce);
      return e.action === action && now < e.expires;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the prompt session (✖ Cancel) and /start
// ---------------------------------------------------------------------------------------------------------------------------------

/** ✖ Cancel: clears the awaited input and returns the menu to re-open (the main menu when none was remembered). */
export function cancelPrompt(s: { awaitingInput: string | null; returnTo: string | null; pendingData?: Record<string, unknown> }): string {
  const to = s.returnTo ?? 'menu:main';
  s.awaitingInput = null;
  s.returnTo = null;
  if (s.pendingData !== undefined) s.pendingData.tier = null;
  return to;
}

/** /start: a deep-link CA opens the token card; anything else (no payload, garbage) opens the main menu. */
export function startAction(text: string): { kind: 'menu' } | { kind: 'token'; ca: string } {
  const payload = (text || '').trim().split(/\s+/)[1] || '';
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payload) ? { kind: 'token', ca: payload } : { kind: 'menu' };
}
