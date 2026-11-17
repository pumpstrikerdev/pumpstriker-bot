// R0-SHIMPL (round 0b; C03), signal card rewritten by A-115 (CARD-MENU spec section 2: "old look, new data"). One pure function family that
// turns the structured contract payload into the Telegram card text, so the bot never prints a fake 0 and marks late cards. Canonical
// source: R\shared\card\render-signal.ts; byte-identical copies live in Engine\src\shared\ and TG Bot\src\shared\ (R\scripts\sync-shared.ps1).
// The dashboard can show the same text.
//
// Pure: no clock, no I/O, no Node API. HTML parse mode: every interpolated string passes escapeHtml (clip first, escape second). The
// signal card uses the tags <b>, <i>, <code> and <a href>, and every tag opens and closes on the SAME line, so a cut at a line boundary
// never leaves an unclosed tag. Unknown values print an em dash or their line is left out, never 0, $0 or 0%. The old card's layout,
// emoji, sections and footer are kept; every figure on it is a value of this decision (the v1 payload and its optional `detail`), and the
// old unmeasured claims (hit rates, rug rates, sizing advice, "sweet-spot", HOT/COLD, model odds) are gone.
import type { ArmId, Ms } from '../common/ids';
import type { RenderOpts, CardText } from '../common/card-types';
import type { ExitAlert, OpsAlert, SignalCancel, SignalNew, Sourced } from '../contract/v1';
import { playbookLines, type PlaybookAutoBuy, type PlaybookV1 } from './playbook';

export type { RenderOpts, CardText };

const DASH = '—';
const DOT = ' · ';
const TICK = '✓';
const CROSS = '✗';
const ARM_ORDER: readonly ArmId[] = ['BS', 'B0', 'B1', 'B2'];
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LINK_URL_RE = /^https:\/\/[A-Za-z0-9.-]+\/[^\s"'<>]*$/;
/** A reading older than this at the decision (= DECISION_CONSTANTS.decisionPriceMaxAgeMs) is marked stale on the data-age line. */
export const STALE_AT_SIGNAL_MS = 30_000;
/** The burst at which the scorer's top band starts; the card adds "(ignition)" from here. */
export const IGNITION_BURST = 0.43;
const WHY_MAX_LINES = 8;
const WHY_SHORT_LINES = 3;
const RULE = '━━━━━━━━━━━━━━━━━━━━';

/** What the bot adds to a signal card at enqueue (A-115, section 2.1). Absent: the Engine / dashboard render. */
export interface SignalCardExtras {
  /** The real exit plan of a buy from this card; null/absent -> the one-line policy fallback. */
  playbook?: PlaybookV1 | null;
  /** Built by the bot only (fixed templates, CA validated); absent -> the GMGN link only. */
  links?: Array<{ label: string; url: string }>;
  /** The auto-buy line of the PLAYBOOK; absent -> the line is left out. */
  autoBuy?: PlaybookAutoBuy | null;
}

/** Escape the four HTML characters Telegram's HTML parse mode cares about. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Cut a string to `max` code points (a surrogate pair is never split) and end it with an ellipsis when it was cut. */
function clip(s: string, max: number): string {
  const points = Array.from(s);
  return points.length <= max ? s : points.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/** Clip first, escape second, so an entity such as &amp; is never cut in half. Unknown text prints an em dash. */
function esc(s: string | null | undefined, max: number): string {
  if (s === null || s === undefined || s === '') return DASH;
  return escapeHtml(clip(s, max));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// number formats (rule 3)
// ---------------------------------------------------------------------------------------------------------------------------------

function trimZeros(s: string): string {
  return s.indexOf('.') === -1 ? s : s.replace(/0+$/, '').replace(/\.$/, '');
}

/** USD: up to 4 significant digits below $1, up to 2 decimals below $1,000, then 12.3k / 1.2M / 1.2B. Never exponent notation. */
function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return DASH;
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a === 0) return '$0';
  if (a < 1) return `${sign}$${trimZeros(a.toFixed(Math.min(100, 3 - Math.floor(Math.log10(a)))))}`;
  if (a < 999.995) return `${sign}$${trimZeros(a.toFixed(2))}`;
  const steps: Array<[number, string]> = [[1e3, 'k'], [1e6, 'M'], [1e9, 'B']];
  let idx = 0;
  while (idx < steps.length - 1 && a >= steps[idx + 1][0]) idx++;
  let scaled = Number((a / steps[idx][0]).toFixed(1));
  if (scaled >= 1000 && idx < steps.length - 1) { idx++; scaled = Number((a / steps[idx][0]).toFixed(1)); }
  return `${sign}$${scaled.toFixed(1)}${steps[idx][1]}`;
}

/** Percentages with a sign and one decimal (changes). */
function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return DASH;
  const t = n.toFixed(1);
  if (Number(t) === 0) return '+0.0%';
  return n > 0 ? `+${t}%` : `${t}%`;
}

/** A share of the holdings: unsigned, one decimal. */
function fmtShare(n: number): string {
  if (!Number.isFinite(n)) return DASH;
  const t = n.toFixed(1);
  return `${Number(t) === 0 ? '0.0' : t}%`;
}

function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return DASH;
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Minutes of age: 45m, 2.5h, 3.1d. */
function fmtMin(n: number): string {
  if (!Number.isFinite(n) || n < 0) return DASH;
  if (n < 120) return `${Math.round(n)}m`;
  if (n < 2880) return `${trimZeros((n / 60).toFixed(1))}h`;
  return `${trimZeros((n / 1440).toFixed(1))}d`;
}

function fmtSol(n: number): string {
  if (!Number.isFinite(n)) return DASH;
  return n >= 100 ? fmtCount(n) : trimZeros(n.toFixed(1));
}

type Unit = 'usd' | 'pct' | 'count' | 'min' | 'share';

function fmtValue(n: number, unit: Unit): string {
  switch (unit) {
    case 'usd': return fmtUsd(n);
    case 'pct': return fmtPct(n);
    case 'count': return fmtCount(n);
    case 'min': return fmtMin(n);
    case 'share': return fmtShare(n);
  }
}

/** Age of a reading at reference time: 12s, 3m, 2h. A reading from the future counts as 0s. */
function fmtAge(ms: number): string {
  const a = Math.max(0, ms);
  if (a < 120_000) return `${Math.round(a / 1000)}s`;
  if (a < 7_200_000) return `${Math.floor(a / 60_000)}m`;
  return `${Math.floor(a / 3_600_000)}h`;
}

const known = (s: Sourced<number> | null | undefined): s is Sourced<number> & { value: number } =>
  s !== null && s !== undefined && s.value !== null && s.value !== undefined && Number.isFinite(s.value);

/** The value alone (the age goes on the one data-age line); an em dash when unknown. */
function val(s: Sourced<number> | null | undefined, unit: Unit): string {
  return known(s) ? fmtValue(s.value, unit) : DASH;
}

function sourcedText(s: Sourced<number>, unit: Unit, at: Ms, ageSuffix: string): string {
  if (!known(s)) return DASH;
  const v = fmtValue(s.value, unit);
  if (v === DASH) return DASH;
  if (s.as_of === null || s.as_of === undefined || !Number.isFinite(s.as_of)) return `${v} (age unknown)`;
  return `${v} (${fmtAge(at - s.as_of)}${ageSuffix})`;
}

/** One value with the age of its reading at time `at` ("$12.3k (4s old)"); an em dash when the value is null. */
export function fmtSourced(s: Sourced<number>, unit: 'usd' | 'pct' | 'count' | 'min', at: Ms): string {
  return sourcedText(s, unit, at, ' old');
}

/** HH:MM in UTC (pure arithmetic on the given epoch ms; no clock is read). */
function hhmm(ms: Ms): string {
  if (!Number.isFinite(ms)) return '--:--';
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function multiple(x: number): string {
  if (!Number.isFinite(x)) return DASH;
  const t = x.toFixed(2);
  return t === '0.00' && x > 0 ? '<0.01' : t;
}

/** The last guard of every card: the text never exceeds maxChars. A multi-line text is cut at the last whole line that fits (a tag never
 *  spans lines, so no tag is split); a single line too long is cut on its plain text, never inside an entity or a surrogate pair. */
function fit(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const ls = text.split('\n');
  let out = '';
  for (const l of ls) {
    const next = out === '' ? l : `${out}\n${l}`;
    if (next.length > maxChars - 2) break;
    out = next;
  }
  if (out !== '') return `${out}\n…`;
  const plain = ls[0].replace(/<[^>]*>/g, '');
  let cut = plain.slice(0, Math.max(0, maxChars - 1));
  cut = cut.replace(/&[#A-Za-z0-9]*$/, '').replace(/[\uD800-\uDBFF]$/, '');
  return cut + '…';
}

// ---------------------------------------------------------------------------------------------------------------------------------
// small cards
// ---------------------------------------------------------------------------------------------------------------------------------

/** "⚠ ENGINE <severity>: <text> (since HH:MM[, cleared HH:MM] UTC)" (both times in UTC, and the text says so). */
export function renderOps(a: OpsAlert, sentAt: Ms, opts: RenderOpts): CardText {
  const cleared = a.cleared_at !== null && a.cleared_at !== undefined ? `, cleared ${hhmm(a.cleared_at)}` : '';
  const text = `⚠ ENGINE ${esc(a.severity, 8)}: ${esc(a.text, 300)} (since ${hhmm(a.since)}${cleared} UTC)`;
  return { text: fit(text, opts.maxChars), parseMode: 'HTML' };
}

/** "⛔ CANCEL <symbol>: retro-kill (<kills>) detected <age> ago. Action: sell if held."
 *  C03 rule 5 words the age as "after the signal", but the signal time is not an input of this function; the age printed is the time from
 *  detected_at to sentAt. */
export function renderCancel(c: SignalCancel, ca: string, symbol: string | null, sentAt: Ms, opts: RenderOpts): CardText {
  const kills = c.kills.map(k => escapeHtml(clip(k, 64))).join(', ');
  const age = Number.isFinite(c.detected_at) ? fmtAge(sentAt - c.detected_at) : DASH;
  const text = `⛔ CANCEL ${esc(symbol, 16)}: retro-kill (${kills}) detected ${age} ago. Action: sell if held.`;
  return { text: fit(text, opts.maxChars), parseMode: 'HTML' };
}

/** "<leg> <symbol>: <multiple>x (peak <peak>x) on the signal basis · quote <quote_age_s>s old · policy <version>". */
export function renderAlert(a: ExitAlert, ca: string, symbol: string | null, sentAt: Ms, opts: RenderOpts): CardText {
  const age = Number.isFinite(a.quote_age_s) ? String(Math.round(a.quote_age_s)) : DASH;
  const text = `${esc(a.leg, 8)} ${esc(symbol, 16)}: ${multiple(a.multiple)}x (peak ${multiple(a.peak_multiple)}x) on the signal basis${DOT}quote ${age}s old${DOT}policy ${esc(a.policy.version, 64)}`;
  return { text: fit(text, opts.maxChars), parseMode: 'HTML' };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the signal card: WHY texts (section 2.4)
// ---------------------------------------------------------------------------------------------------------------------------------

type LabelRole = 'acting' | 'measured' | 'quality';
/** The WHY line of every Engine label id that can be true (in the Engine's LABEL_IDS order), with its role. risk-unknown is printed as the
 *  "risk unknown" line instead. A label id this table does not know prints "• <id>" (a new Engine label never breaks an older bot). */
export const CARD_LABEL_TEXT: Readonly<Record<string, { role: LabelRole; text: string }>> = {
  'safety-pending': { role: 'acting', text: '⏳ safety checks pending' },
  'line-unconfirmed': { role: 'acting', text: '⚠️ line not confirmed on the frozen input' },
  'liq-unknown': { role: 'acting', text: '⚠️ liquidity unknown' },
  'thin-liquidity': { role: 'acting', text: '⚠️ thin liquidity (liq under 2% of mcap)' },
  'pool-lt-1k': { role: 'acting', text: '⚠️ pool liquidity under $1k or drained' },
  'below-10k': { role: 'acting', text: '⚠️ mcap under $10k' },
  'knife': { role: 'acting', text: '🔪 knife: ≥ 30% under the 10-min high or −30% in 5m' },
  'spike5': { role: 'acting', text: '⚠️ +100% or more in 5m' },
  'young-pump': { role: 'acting', text: '⚠️ young pump: pool < 60 min, +50% 1h, burst ≥ 0.35' },
  'launch-run': { role: 'acting', text: '⚠️ already ≥ 3× its launch (token < 60 min)' },
  'band-10-25k': { role: 'acting', text: '🎯 mcap in the $10-25k band (arm B2)' },
  'band-25-60k': { role: 'measured', text: '📍 mcap in the $25-60k band' },
  'above-60k': { role: 'measured', text: '📍 mcap ≥ $60k' },
  'young': { role: 'measured', text: '🐣 young pool (under 12.5 min)' },
  'aged-93': { role: 'measured', text: '⏳ pool ≥ 93 min old' },
  'fast-curve': { role: 'measured', text: '🏎 fast bonding curve (≥ 10% per min)' },
  'mig-recent': { role: 'measured', text: '🎓 migrated, pool under 20 min old' },
  'mig-lowhold': { role: 'measured', text: '🎓 migrated with under 100 holders' },
  'chase-3x': { role: 'measured', text: '🏃 price ≥ 3× its first seen price' },
  'chase-1.5x': { role: 'measured', text: '🏃 price ≥ 1.5× its first seen price' },
  'copycat': { role: 'measured', text: '👯 same-keyword decision in the last 90 min' },
  'rug-ratio-60': { role: 'measured', text: '☠️ GMGN rug ratio above 60%' },
  'insider-30': { role: 'measured', text: '🕵️ insiders ≥ 30%' },
  'bundler-35': { role: 'measured', text: '📦 bundlers ≥ 35%' },
  'devteam-gt-25': { role: 'measured', text: '👨‍💻 dev team holds over 25%' },
  'top10x-ge-50': { role: 'measured', text: '🔟 top10x ≥ 50%' },
  'stack-k-g': { role: 'measured', text: '🧱 concentration: top10 ≥ 50% or creator over 25% or migrated with < 100 holders' },
  'late-cluster': { role: 'measured', text: '🕰 cluster first seen ≥ 15 min before' },
  'cluster-5plus': { role: 'measured', text: '🐋 cluster of 5+ wallets' },
  'kol-call': { role: 'measured', text: '📣 KOL call signal before the decision' },
  'kol-call-v2': { role: 'measured', text: '📣 KOL call signal before the decision (v2)' },
  'kol-buy': { role: 'measured', text: '👑 KOL buy signal before the decision' },
  'pool-lt-5k': { role: 'measured', text: '💧 pool liquidity under $5k' },
  'pre-cutover-token': { role: 'measured', text: '📅 token created before the Engine cutover' },
  'launch-run-2x': { role: 'measured', text: '🚀 ≥ 2× its launch (token < 60 min)' },
  'launch-run-5x': { role: 'measured', text: '🚀 ≥ 5× its launch (token < 60 min)' },
  'trigger-run-3x': { role: 'measured', text: '🚀 trigger buy ≥ 3× the launch price' },
  'mkt-incomplete': { role: 'quality', text: '⚠️ market data incomplete' },
  'repriced': { role: 'quality', text: '🔁 repriced (decision deferred)' },
  'price-src-info': { role: 'quality', text: 'ℹ️ price from token info' },
  'feed-gap': { role: 'quality', text: '⚠️ smart-money feed gap' },
  'feed-stale': { role: 'quality', text: '⚠️ smart-money feed stale' },
  'budget-degraded': { role: 'quality', text: '⚠️ data budget degraded at the decision (S2 or worse)' },
  'launch-src-pp': { role: 'quality', text: 'ℹ️ launch price from the PumpPortal curve' },
};
const ROLE_ORDER: readonly LabelRole[] = ['acting', 'measured', 'quality'];

const pts = (n: number): string => `+${trimZeros(n.toFixed(1))}`;

function termText(sig: SignalNew, term: string, points: number): string | null {
  const x = sig.detail;
  switch (term) {
    case 'cluster':
      return x !== undefined ? `🐋 ${fmtCount(x.cluster.wallets)} smart-money wallets bought (cluster ${pts(points)})` : `🐋 smart-money cluster (${pts(points)})`;
    case 'quietAged': return `🤫 quiet + aged: pool ≥ 165 min, vol 1h < $10k (${pts(points)})`;
    case 'burstAged': return `🔥 vol5m/vol1h burst ${x !== undefined && known(x.burst) ? x.burst.value.toFixed(2) : DASH} on a pool ≥ 60 min (${pts(points)})`;
    case 'launchpad': return `🚀 pump launchpad (${pts(points)})`;
    case 'ecosystem': return `🌐 pump ecosystem (${pts(points)})`;
    default: return null;
  }
}

/** Every WHY line (escaped), in the order of section 2.3 #27; the cap is applied by the caller. */
function whyItems(sig: SignalNew): string[] {
  const out: string[] = [];
  const x = sig.detail;
  if (x !== undefined) {
    for (const t of x.score.terms) {
      if (!(Number.isFinite(t.points) && t.points > 0)) continue;
      const line = termText(sig, t.term, t.points);
      if (line !== null) out.push(escapeHtml(line));
    }
    if (x.cluster.kol > 0) out.push(escapeHtml(`👑 ${fmtCount(x.cluster.kol)} KOL wallet(s) in the cluster`));
  }
  const trueIds = new Set(sig.labels.filter(l => l.known && l.value === true).map(l => l.id));
  for (const role of ROLE_ORDER) {
    for (const [id, spec] of Object.entries(CARD_LABEL_TEXT)) {
      if (spec.role === role && trueIds.has(id)) out.push(escapeHtml(spec.text));
    }
  }
  for (const l of sig.labels) {
    if (l.known && l.value === true && l.id !== 'risk-unknown' && !Object.prototype.hasOwnProperty.call(CARD_LABEL_TEXT, l.id)) out.push(`• ${escapeHtml(clip(l.id, 64))}`);
  }
  const unknownActing = sig.labels.filter(l => l.acting && (!l.known || l.value === null));
  if (unknownActing.length > 0) {
    const inputs: string[] = [];
    for (const arm of ARM_ORDER) for (const u of sig.arms?.[arm]?.unknown_inputs ?? []) if (!inputs.includes(u)) inputs.push(u);
    const names = inputs.length > 0 ? inputs : unknownActing.map(l => l.id);
    const shown = names.slice(0, 4).map(n => escapeHtml(clip(n, 32))).join(', ');
    out.push(`❓ risk unknown: ${shown}${names.length > 4 ? ` +${names.length - 4}` : ''}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the signal card: the other parts
// ---------------------------------------------------------------------------------------------------------------------------------

function armsText(sig: SignalNew): string {
  const parts = ARM_ORDER.map(arm => {
    const a = sig.arms === null || sig.arms === undefined ? undefined : sig.arms[arm];
    if (a === undefined || a === null) return `${arm} ${DASH}`;
    if (a.eligible) return `${arm} ${TICK}`;
    const why = a.blocked_by.slice(0, 2).map(r => escapeHtml(clip(r, 32))).join(', ');
    const more = a.blocked_by.length > 2 ? ` +${a.blocked_by.length - 2}` : '';
    return `${arm} ${CROSS}${why !== '' ? ` (${why}${more})` : ''}`;
  });
  return `🎰 Arms: ${parts.join(DOT)}`;
}

function blockedText(sig: SignalNew, arm: ArmId): string {
  const a = sig.arms?.[arm];
  if (a === undefined || a === null || a.blocked_by.length === 0) return '';
  const why = a.blocked_by.slice(0, 2).map(r => escapeHtml(clip(r, 32))).join(', ');
  return ` (${why}${a.blocked_by.length > 2 ? ` +${a.blocked_by.length - 2}` : ''})`;
}

function headerText(sig: SignalNew): string {
  switch (sig.grade) {
    case 'A': return '🦈🚀 <b>PUMPSTRIKER — GRADE A PRE-PUMP</b> 🚀🦈';
    case 'B': return '🦈🔥 <b>PUMPSTRIKER — GRADE B PRE-PUMP</b> 🔥';
    default: return '🦈👀 <b>PUMPSTRIKER — GRADE C (watch)</b>';
  }
}

/** The blurb, built ONLY from the arms ("on the line" is exact: every signal passed line-85). */
function blurbText(sig: SignalNew): string {
  const base = 'Smart-money cluster on the line.';
  const ok = (arm: ArmId): boolean => sig.arms?.[arm]?.eligible === true;
  const passing = ARM_ORDER.filter(ok);
  let tail: string;
  if (sig.grade === 'A' && passing.length === ARM_ORDER.length) tail = ' Every auto-buy arm passes (BS · B0 · B1 · B2).';
  else if (sig.grade === 'B' && ok('BS') && ok('B0') && ok('B1') && !ok('B2')) tail = ` Arms BS · B0 · B1 pass; B2 does not${blockedText(sig, 'B2')}.`;
  else if (sig.grade === 'C' && !ok('B1')) tail = ` Arm B1 is blocked${blockedText(sig, 'B1')}; see the arms line.`;
  else tail = passing.length > 0 ? ` Arms passing: ${passing.join(DOT)}.` : ' No auto-buy arm passes.';
  return `<i>${base}${tail}</i>`;
}

function safetyText(sig: SignalNew): string {
  if (sig.safety.status === 'clean') return '🛡 Safety: ✅ clean';
  const missing = sig.safety.missing.slice(0, 8).map(m => escapeHtml(clip(m, 32))).join(', ');
  const more = sig.safety.missing.length > 8 ? ` +${sig.safety.missing.length - 8}` : '';
  return missing === '' ? '🛡 Safety: ⏳ pending' : `🛡 Safety: ⏳ pending (missing: ${missing}${more})`;
}

function zoneText(sig: SignalNew): string | null {
  const on = (id: string): boolean => sig.labels.some(l => l.id === id && l.known && l.value === true);
  if (on('band-10-25k')) return '🎯 Entry zone: $10-25k band ✅ (arm B2)';
  if (on('band-25-60k')) return '🎯 Entry zone: $25-60k band (B2 needs $10-25k)';
  if (on('above-60k')) return '🎯 Entry zone: ≥ $60k (B2 needs $10-25k)';
  if (on('below-10k')) return '🎯 Entry zone: ⚠️ below $10k';
  return null;
}

function confText(n: number): string {
  return Number.isFinite(n) ? trimZeros(n.toFixed(1)) : DASH;
}

interface BuildOpts {
  whyMax: number; staleShort: boolean; dropHolders: boolean; dropVolChg: boolean; accReduced: boolean;
  dropBlurb: boolean; dropLinks: boolean; dropIds: boolean;
}

interface AgeItem { name: string; s: Sourced<number> }

function linkLine(ca: string, extras: SignalCardExtras | undefined): string | null {
  if (!BASE58_RE.test(ca)) return null;
  const links = extras?.links;
  if (links === undefined) return `<a href="https://gmgn.ai/sol/token/${ca}">GMGN</a>`;
  const ok = links.filter(l => typeof l.url === 'string' && LINK_URL_RE.test(l.url) && typeof l.label === 'string' && l.label !== '');
  if (ok.length === 0) return null;
  return ok.map(l => `<a href="${escapeHtml(l.url)}">${escapeHtml(clip(l.label, 16))}</a>`).join(DOT);
}

function buildSignal(sig: SignalNew, ca: string, sentAt: Ms, opts: RenderOpts, extras: SignalCardExtras | undefined, o: BuildOpts): string {
  const dAt = sig.decision.decided_at;
  const m = sig.market;
  const x = sig.detail;
  const out: string[] = [];
  const sinceDecision = sentAt - dAt;
  // 0. the LATE banner
  if (sinceDecision > opts.lateMs) out.push(`⚠ LATE: sent ${Math.round(sinceDecision / 1000)} s after the decision`);
  // 1-3. header, rule, blurb
  out.push(headerText(sig), RULE);
  if (!o.dropBlurb) out.push(blurbText(sig));
  out.push('');
  // 5-7. name, confidence, CA
  out.push(`<b>${esc(sig.token.name, 64)}</b>  ($${esc(sig.token.symbol, 16)})`);
  const lp = sig.token.launchpad !== null && sig.token.launchpad !== undefined && sig.token.launchpad !== '' ? `${DOT}${esc(sig.token.launchpad, 32)}` : '';
  out.push(`Confidence: ${confText(sig.decision.confidence)}/100${DOT}${esc(sig.decision.tier, 16)}${lp}`);
  out.push(`<code>${escapeHtml(clip(ca, 64))}</code>`);
  out.push('');
  // 9-18. MARKET
  const ages: AgeItem[] = [];
  const use = (name: string, s: Sourced<number> | undefined): void => { if (s !== undefined && known(s)) ages.push({ name, s }); };
  out.push('📊 <b>MARKET</b>');
  out.push(`Entry ${fmtUsd(sig.entry.price_usd)}${DOT}MCap ${fmtUsd(sig.entry.mcap_usd)} (${esc(sig.entry.mcap_basis, 8)})`);
  const tokenAge = x !== undefined && known(x.token_age_min) ? `${DOT}token ${fmtMin(x.token_age_min.value)}` : '';
  out.push(`Liq ${val(m.liq_usd, 'usd')}${DOT}Pool ${val(m.pool_liq_usd, 'usd')}${DOT}Age ${val(m.age_min, 'min')} (pool)${tokenAge}`);
  use('Liq', m.liq_usd); use('Pool', m.pool_liq_usd); use('Age', m.age_min);
  if (tokenAge !== '') use('Token age', x?.token_age_min);
  if (!o.dropVolChg) {
    const v24 = x !== undefined && known(x.vol_24h_usd) ? `${DOT}24h ${fmtUsd(x.vol_24h_usd.value)}` : '';
    out.push(`Vol 5m ${val(m.vol_5m_usd, 'usd')}${DOT}1h ${val(m.vol_1h_usd, 'usd')}${v24}`);
    out.push(`Δ 5m ${val(m.chg_5m_pct, 'pct')}${DOT}1h ${val(m.chg_1h_pct, 'pct')}`);
    use('Vol 5m', m.vol_5m_usd); use('Vol 1h', m.vol_1h_usd);
    if (v24 !== '') use('Vol 24h', x?.vol_24h_usd);
    use('Δ 5m', m.chg_5m_pct); use('Δ 1h', m.chg_1h_pct);
  }
  if (!o.dropHolders) {
    out.push(`Holders ${val(m.holders, 'count')}${DOT}Top10 ${val(m.top10_pct, 'share')}${DOT}Creator ${val(m.creator_hold_pct, 'share')}`);
    use('Holders', m.holders); use('Top10', m.top10_pct); use('Creator hold', m.creator_hold_pct);
  }
  out.push(safetyText(sig));
  const zone = zoneText(sig);
  if (zone !== null) out.push(zone);
  out.push(armsText(sig));
  const ageAt = out.length;   // the data-age line goes here once ACCUMULATION has added its readings
  out.push('');

  // 20-25. ACCUMULATION SIGNALS (needs the detail)
  const acc: string[] = [];
  if (x !== undefined) {
    const kol = x.cluster.kol > 0 ? `${DOT}👑 ${fmtCount(x.cluster.kol)} KOL` : '';
    const sol = known(x.cluster.sol) ? `${DOT}${x.cluster.sol_lower_bound ? '≥ ' : ''}${fmtSol(x.cluster.sol.value)} SOL` : '';
    acc.push(`🐋 Smart-money: <b>${fmtCount(x.cluster.wallets)}</b> wallets${kol}${sol}`);
    if (sol !== '') use('Cluster SOL', x.cluster.sol);
    const flowKnown = known(x.buys_5m) && known(x.sells_5m);
    if (!o.accReduced && flowKnown && known(m.vol_5m_usd)) {
      const trades = (x.buys_5m.value as number) + (x.sells_5m.value as number);
      if (trades > 0) acc.push(`💧 Liq-velocity: <b>${fmtCount(m.vol_5m_usd.value / trades)}</b> USD/trade (5m)`);
    }
    if (!o.accReduced && flowKnown) {
      acc.push(`⚖️ Order flow 5m: ${fmtCount(x.buys_5m.value as number)} buys / ${fmtCount(x.sells_5m.value as number)} sells`);
      use('Buys 5m', x.buys_5m); use('Sells 5m', x.sells_5m);
    }
    if (known(x.burst)) acc.push(`🔥 Burst vol5m/1h: <b>${x.burst.value.toFixed(2)}</b>${x.burst.value >= IGNITION_BURST ? ' (ignition)' : ''}`);
    if (!o.accReduced) {
      const age = known(m.age_min) ? `age ${fmtMin(m.age_min.value)}` : 'age unknown';
      acc.push(x.score.moonshot_gate ? `🤫 Quiet+aged gate: ✅ PASS (${age})` : `🤫 Quiet+aged gate: — (${age})`);
    }
  }
  if (acc.length > 0) out.push('🧠 <b>ACCUMULATION SIGNALS</b>', ...acc, '');

  // 18. the ONE data-age line
  const ageLine = dataAgeLine(sig, dAt, ages, o.staleShort);
  if (ageLine !== null) out.splice(ageAt, 0, ageLine);

  // 27. WHY
  const why = whyItems(sig);
  if (why.length > 0) {
    out.push('🟢 <b>WHY</b>');
    const shown = why.slice(0, o.whyMax);
    for (const w of shown) out.push(`  ${w}`);
    if (why.length > shown.length) out.push(`  +${why.length - shown.length} more`);
    out.push('');
  }

  // 29. PLAYBOOK
  out.push('🎯 <b>PLAYBOOK</b>');
  const pb = extras?.playbook;
  if (pb !== undefined && pb !== null) for (const l of playbookLines(pb, extras?.autoBuy ?? null)) out.push(escapeHtml(l));
  else {
    out.push(`Exit plan: policy ${esc(sig.policy.id, 8)} ${esc(sig.policy.version, 64)}`);
  }
  out.push('');

  // 31. links
  const links = o.dropLinks ? null : linkLine(ca, extras);
  if (links !== null) out.push(links, '');

  // 33-36. footer
  out.push(RULE, '⚠️ <b>NFA · DYOR · PRE-PUMP = HIGH RISK</b>',
    '<i>Silent accumulation can still rug. Size for a 100% loss. This is the most brutal market on earth.</i>');
  if (!o.dropIds) out.push(`ids: rules ${esc(sig.decision.rules_version, 64)}${DOT}policy ${esc(sig.policy.id, 8)} ${esc(sig.policy.version, 64)}`);
  return out.join('\n');
}

/** "🕒 Data ≤ Ns old at signal[ · ⚠ <field> <age> …]": the largest age of the printed readings that are not stale, then the stale ones. */
function dataAgeLine(sig: SignalNew, dAt: Ms, items: readonly AgeItem[], short: boolean): string | null {
  const stale: string[] = [];
  let max: number | null = null;
  const q = sig.entry.quote_age_s;
  if (Number.isFinite(q)) {
    const qa = Math.max(0, q * 1000);
    if (qa > STALE_AT_SIGNAL_MS) stale.push(`Quote ${fmtAge(qa)}`); else max = qa;
  }
  for (const it of items) {
    const at = it.s.as_of;
    if (at === null || at === undefined || !Number.isFinite(at)) { stale.push(`${it.name} age unknown`); continue; }
    const a = Math.max(0, dAt - at);
    if (a > STALE_AT_SIGNAL_MS) stale.push(`${it.name} ${fmtAge(a)}`);
    else max = max === null ? a : Math.max(max, a);
  }
  if (max === null && stale.length === 0) return null;
  const head = max === null ? '🕒 Data at signal' : `🕒 Data ≤ ${Math.round(max / 1000)}s old at signal`;
  if (stale.length === 0) return head;
  if (short) return `${head}${DOT}⚠ ${stale.length} stale`;
  const shown = stale.slice(0, 3).map(s => `⚠ ${s}`).join(DOT);
  return `${head}${DOT}${shown}${stale.length > 3 ? ` +${stale.length - 3}` : ''}`;
}

/** The signal card (A-115 layout, section 2.3). Over maxChars, in this order (each step re-measures): WHY to 3 lines, the stale list
 *  shortened, the holders line, the volume and change lines, ACCUMULATION reduced to the cluster and burst lines, the blurb, the links,
 *  the ids line; never the LATE banner, the header, the name, the confidence, the CA, the entry line, the PLAYBOOK or the disclaimer.
 *  fit() (a line-boundary cut) is the last guard. `extras` are fixed at enqueue (the bot passes the same object on every re-render). */
export function renderSignal(sig: SignalNew, ca: string, sentAt: Ms, opts: RenderOpts, extras?: SignalCardExtras): CardText {
  const max = opts.maxChars;
  let o: BuildOpts = { whyMax: WHY_MAX_LINES, staleShort: false, dropHolders: false, dropVolChg: false, accReduced: false, dropBlurb: false, dropLinks: false, dropIds: false };
  let text = buildSignal(sig, ca, sentAt, opts, extras, o);
  const steps: Array<Partial<BuildOpts>> = [
    { whyMax: WHY_SHORT_LINES }, { staleShort: true }, { dropHolders: true }, { dropVolChg: true }, { accReduced: true },
    { dropBlurb: true }, { dropLinks: true }, { dropIds: true },
  ];
  for (const s of steps) {
    if (text.length <= max) break;
    o = { ...o, ...s };
    text = buildSignal(sig, ca, sentAt, opts, extras, o);
  }
  return { text: fit(text, max), parseMode: 'HTML' };
}
