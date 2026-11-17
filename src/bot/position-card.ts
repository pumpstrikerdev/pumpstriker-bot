/**
 * POSITION CARD — pure renderer (B50 section 2, R3-B5). Given live data, builds the message text +
 * inline keyboard. No I/O, no state, no clock.
 *
 * Every number the card shows comes with its source and age, and a number nobody knows is printed as an em dash, never
 * as 0 and never as a made-up value:
 *   - the worth of the bag is the executable value of `exits/valuation.ts` (source: on-chain curve, Jupiter quote or the
 *     Engine's GMGN price) with the age of that quote;
 *   - market cap and liquidity are the Engine's GMGN fields (`EngineClient.token`), each with its own as_of age.
 * The links point at GMGN and Solscan only.
 *
 * Layout (text body):
 *   🪙 Ticker · Name                      Position N/M
 *   🚀 On the bonding curve   ── or ──   💧 Graduated (PumpSwap)      (omitted when the Engine does not know)
 *   🔖 origin and dry-run tags
 *   CA: full
 *
 *   💰 Market cap · Liquidity (with ages)
 *   📊 Holding (tokens)
 *      Avg cost · worth in SOL (with source and age)
 *   💸 Initial buy · Fees paid
 *   📈 Net PnL (SOL + %) emoji
 *
 *   🛡️ TSL section (only if winning + active TSL)
 *
 *   🔗 GMGN · Solscan · Buy Tx
 *   📌 Refreshed Xs ago
 *
 * Keyboard:
 *   [← Prev] [🔄] [Next →]
 *   [💸 Sell Initials] [💣 Sell All]
 *   [25%] [50%] [75%] [100%]
 *   [Sell X%] [Sell X SOL] [Sell X Tokens]
 *   [⚙️ Slippage X%] [💎 Tip X SOL]
 *   [🛡️ Anti-MEV: ON/OFF] [⏰ Sell Limits (counts)]
 *   [← Back]
 */
import { Markup } from 'telegraf';

/** A reading that may be unknown: `value` null = unknown, `ageSec` null = the age is unknown. */
export interface Aged {
  value: number | null;
  ageSec: number | null;
}

export interface PositionCardInput {
  // Identity (null = the Engine did not say)
  ca: string;
  ticker: string | null;
  name: string | null;
  origin: 'signal' | 'manual';
  /** A virtual position (BOT_DRY_RUN or a dry-run arm): nothing real is held. */
  dryRun: boolean;
  /** From the Engine's `migrated` field: 'curve' = still on the pump.fun bonding curve, 'graduated' = trades on a pool, null = unknown. */
  venue: 'curve' | 'graduated' | null;

  // Position data (aggregated across wallets)
  /** Token amount in UI units, null when the decimals are unknown. */
  tokenAmount: number | null;
  /** Executable value of the whole bag, with the source of the quote (e.g. 'onchain') and its age. */
  worth: Aged & { src: string | null };
  avgCostSolPerToken: number | null;
  /** SOL spent on the entry, null when the fill was never verified. */
  initialBuySol: number | null;
  feesPaidSol: number | null;

  // Market (Engine GMGN fields)
  mcUsd: Aged;
  liqUsd: Aged;

  // PnL (in SOL), null when the worth or the entry is unknown
  netPnlSol: number | null;
  netPnlPct: number | null;

  // TSL state (null if no active TSL)
  tsl: null | {
    triggerPct: number;             // negative for "below peak", e.g. -10
    highestMultiplier: number;      // 1.0 = entry, 2.0 = +100%
    securedPct: number;             // computed: (highest - 1) * 100 + triggerPct
    movedRecently: boolean;         // peak bumped within last 10s
    movedAgoSec: number;
  };

  // UI state
  positionIndex: number;            // 1-based
  positionTotal: number;
  refreshedAgoSec: number;

  // Per-token overrides (display labels for the buttons)
  slippageBps: number;
  tipSol: number;
  antiMev: boolean;

  // Limit-order summary for the Sell Limits button
  limits: { tp: number; sl: number; tsl: number; buy: number };

  /** A-115: the exit plan of the position ("plan: grade B preset rev 2 (current rev 3)" / "plan: policy EA" / "plan: your orders"). */
  plan?: string | null;
  /** A-115: the position runs a grade plan (the ♻️ Apply / ✋ own-orders buttons are shown). */
  planButtons?: { apply: boolean; own: boolean };

  // Buy-tx signature (oldest) for the Solscan link
  firstBuyTxSig: string | null;
}

const DASH = '—';

// ── HTML escape (Telegraf parse_mode = HTML) ──
function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtSol(n: number | null, dp = 4): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  return n.toFixed(dp);
}

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n < 0) return DASH;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtAgo(secs: number): string {
  if (secs < 60) return `${Math.max(0, Math.floor(secs))}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

/** "12s", "3m", "2h" (no "ago": the callers add their own wording). */
function ageWord(secs: number): string {
  const s = Math.max(0, secs);
  if (s < 120) return `${Math.floor(s)}s`;
  if (s < 7200) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** "$12.30K (4s old)"; "$12.30K (age unknown)" when the age is not known; an em dash when the value is unknown. */
function agedUsd(a: Aged): string {
  const v = fmtUsd(a.value);
  if (v === DASH) return DASH;
  return a.ageSec === null || !Number.isFinite(a.ageSec) ? `${v} (age unknown)` : `${v} (${ageWord(a.ageSec)} old)`;
}

function formatTokens(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n < 0) return DASH;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(0);
}

/**
 * Auto-tiered "% locked in pocket" message based on current secured%.
 * Escalates flavor as the position becomes more decisive.
 */
export function securedLine(securedPct: number): string {
  if (securedPct < 0)   return `🌱 ${fmtPct(securedPct)} floor — TSL set, riding it out`;
  if (securedPct < 25)  return `🌱 ${fmtPct(securedPct)} locked in — green floor`;
  if (securedPct < 75)  return `🦅 ${fmtPct(securedPct)} saved — TSL got your back`;
  if (securedPct < 200) return `💰 ${fmtPct(securedPct)} in the bag — pure house money from here`;
  return                       `🔥 ${fmtPct(securedPct)} locked, you're playing on profits — let it ride or take chips off`;
}

// ── Links (GMGN and Solscan only; links are not data) ──
function linksLine(ca: string, firstBuyTxSig: string | null): string {
  const buyTxPart = firstBuyTxSig
    ? `<a href="https://solscan.io/tx/${esc(firstBuyTxSig)}">🧾 Buy Tx</a>`
    : `🧾 Buy Tx`;
  return [
    `<a href="https://gmgn.ai/sol/token/${esc(ca)}">🔗 GMGN</a>`,
    `<a href="https://solscan.io/token/${esc(ca)}">🔎 Solscan</a>`,
    buyTxPart,
  ].join(' · ');
}

// ── Main renderer ──
export function renderPositionCard(c: PositionCardInput): { text: string; keyboard: any } {
  const pnlKnown = c.netPnlSol !== null && Number.isFinite(c.netPnlSol);
  const winning = pnlKnown && (c.netPnlSol as number) >= 0;
  const pnlEmoji = !pnlKnown ? '' : winning ? ' 🟢' : ' 🔴';

  // Venue line: only what the Engine knows
  const venueLine =
    c.venue === 'graduated' ? '💧 PumpSwap / pool (graduated)\n'
    : c.venue === 'curve' ? '🚀 Pump.fun bonding curve\n'
    : '';

  // Origin tags
  const tags = [c.origin === 'manual' ? '✋ manual position' : '🤖 signal position', ...(c.dryRun ? ['🧪 DRY RUN (virtual)'] : [])];

  // Header line — ticker + name on left, position counter on right
  const titleLine = `🪙 <b>${c.ticker ? esc(c.ticker) : DASH}</b> · ${c.name ? esc(c.name) : DASH}`
    + (c.positionTotal > 1 ? `   <i>Position ${c.positionIndex}/${c.positionTotal}</i>` : '');

  // Market (each field with its own age)
  const marketLine = `💰 Market cap: <b>${agedUsd(c.mcUsd)}</b>  |  Liquidity: <b>${agedUsd(c.liqUsd)}</b>`;

  // Holdings + avg cost + worth with the quote source and age
  const holdingsLine = `📊 You hold ${formatTokens(c.tokenAmount)} tokens`;
  const avg = c.avgCostSolPerToken !== null && Number.isFinite(c.avgCostSolPerToken) ? c.avgCostSolPerToken.toExponential(2) : DASH;
  const worthSuffix = c.worth.value === null
    ? ''
    : ` (${c.worth.src ?? 'source unknown'}${c.worth.ageSec === null ? ', age unknown' : `, ${ageWord(c.worth.ageSec)} old`})`;
  const costLine = `   Avg cost: ${avg} SOL/tok · worth <b>${c.worth.value === null ? DASH : `${fmtSol(c.worth.value)} SOL`}</b>${worthSuffix}`;

  // PnL
  const pnlLine = pnlKnown
    ? `📈 Net PnL: <b>${(c.netPnlSol as number) >= 0 ? '+' : ''}${fmtSol(c.netPnlSol)} SOL (${fmtPct(c.netPnlPct)})</b>${pnlEmoji}`
    : `📈 Net PnL: <b>${DASH}</b>${c.initialBuySol === null ? ' (entry not verified)' : ''}`;

  // TSL block — only if winning AND TSL exists
  let tslBlock = '';
  if (winning && c.tsl) {
    const moveTag = c.tsl.movedRecently ? ` ✨ moved ${Math.max(1, Math.floor(c.tsl.movedAgoSec))}s ago` : '';
    tslBlock =
      `\n🛡️ TSL @ ${fmtPct(c.tsl.triggerPct)} from peak${moveTag}\n` +
      securedLine(c.tsl.securedPct) + `\n`;
  }

  // CA is rendered FULL inside <code> so Telegram tap-to-copy gives the complete address.
  const text =
    `${titleLine}\n` +
    venueLine +
    `${tags.join(' · ')}\n` +
    (c.plan ? `📋 ${esc(c.plan)}\n` : '') +
    `CA: <code>${esc(c.ca)}</code>\n` +
    `\n` +
    `${marketLine}\n` +
    `${holdingsLine}\n` +
    `${costLine}\n` +
    `💸 Initial buy: ${fmtSol(c.initialBuySol)} SOL  ·  Fees paid: ${fmtSol(c.feesPaidSol, 5)} SOL\n` +
    `${pnlLine}\n` +
    tslBlock +
    `\n${linksLine(c.ca, c.firstBuyTxSig)}\n` +
    `📌 Refreshed ${fmtAgo(c.refreshedAgoSec)}`;

  // ── Keyboard ──
  const slipLabel = `⚙️ Slippage ${(c.slippageBps / 100).toFixed(1)}%`;
  const tipLabel  = `💎 Tip ${c.tipSol.toFixed(4)} SOL`;
  const mevLabel  = c.antiMev ? '🛡️ Anti-MEV: ON' : '⚠️ Anti-MEV: OFF';
  const limitsCount = c.limits.tp + c.limits.sl + c.limits.tsl + c.limits.buy;
  const limitsLabel = limitsCount === 0
    ? `⏰ Sell Limits (none)`
    : `⏰ Sell Limits (${c.limits.tp} TP · ${c.limits.sl} SL · ${c.limits.tsl} TSL${c.limits.buy ? ` · ${c.limits.buy} B` : ''})`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('← Prev',  `pm:nav:prev`),
      Markup.button.callback('🔄',       `pm:refresh`),
      Markup.button.callback('Next →',  `pm:nav:next`),
    ],
    [
      Markup.button.callback('💸 Sell Initials', `pm:sell:init:${c.ca}`),
      Markup.button.callback('💣 Sell All',      `pm:sell:all:${c.ca}`),
    ],
    [
      Markup.button.callback('25%',  `pm:sell:pct:${c.ca}:25`),
      Markup.button.callback('50%',  `pm:sell:pct:${c.ca}:50`),
      Markup.button.callback('75%',  `pm:sell:pct:${c.ca}:75`),
      Markup.button.callback('100%', `pm:sell:pct:${c.ca}:100`),
    ],
    [
      Markup.button.callback('Sell X%',      `pm:sell:xpct:${c.ca}`),
      Markup.button.callback('Sell X SOL',   `pm:sell:xsol:${c.ca}`),
      Markup.button.callback('Sell X Tokens',`pm:sell:xtok:${c.ca}`),
    ],
    [
      Markup.button.callback(slipLabel, `pm:cfg:slip:${c.ca}`),
      Markup.button.callback(tipLabel,  `pm:cfg:tip:${c.ca}`),
    ],
    [
      Markup.button.callback(mevLabel,    `pm:cfg:mev:${c.ca}`),
      Markup.button.callback(limitsLabel, `pm:limits:${c.ca}`),
    ],
    // A-115: re-apply the current grade preset (confirm) or move a card-buy position to the owner's own orders (confirm)
    ...(c.planButtons && (c.planButtons.apply || c.planButtons.own) ? [[
      ...(c.planButtons.apply ? [Markup.button.callback('♻️ Apply current preset', `pp:apply:${c.ca}`)] : []),
      ...(c.planButtons.own ? [Markup.button.callback('✋ Switch to my own orders', `pp:own:${c.ca}`)] : []),
    ]] : []),
    [Markup.button.callback('← Back', `pm:close`)],
  ]);

  return { text, keyboard };
}
