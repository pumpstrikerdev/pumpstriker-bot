// A-115 (CARD-MENU spec section 2.5): the PLAYBOOK of a signal card = the REAL exit plan a position from this card gets, as text built
// from the exit legs themselves (never a constant). Canonical source: R\shared\card\playbook.ts; byte-identical copies live in
// Engine\src\shared\ and TG Bot\src\shared\ (R\scripts\sync-shared.ps1).
//
// Pure: no clock, no I/O, no Node API. It imports TYPES only from the exit policy module (erased), so the dashboard rule "no Node crypto"
// holds. The lines are plain text; the card renderer escapes them for HTML and the bot's Markdown menus print them as they are (they hold
// no Markdown character apart from what an id could carry, which the caller cleans).
import type { ArmId, Grade } from '../common/ids';
import type { LegSpec } from '../exit-policy/exit-policy';

/** The plan a buy from a card would get now: the owner's grade preset, or the active exit policy. */
export interface PlaybookV1 {
  source: 'policy' | 'preset';
  grade: Grade;
  /** The policy id the position is stamped with (EA, or PRESET-<grade>). */
  policyId: string;
  version: string;
  /** The preset revision (preset source), null for the policy. */
  rev: number | null;
  legs: LegSpec[];
  /** Policy source only: why the grade preset does not apply. 'follows' = the preset is the default and follows the policy. */
  presetState?: 'follows' | 'auto-sell-off' | 'preset-off';
}

/** The auto-buy line of the PLAYBOOK (bot only). `mode` is what a buy from the card REALLY does (the bot works it out from the
 *  heartbeat the way the buy path decides: BOT_DRY_RUN, an unconfirmed live state), not only the mode the owner set. */
export interface PlaybookAutoBuy {
  mode: 'off' | 'dry_run' | 'live'; arm: ArmId | null; buySol: number | null;
  /** A-115 (review P1): the pause that holds every auto-buy now (absent or null = none); ignored when mode is off. */
  paused?: string | null;
  /** A-115 (review P1): why `mode` is not the mode the owner set, e.g. 'BOT_DRY_RUN on: nothing is sent' (absent or null = none). */
  note?: string | null;
}

/** A copy of the plan; the legs are copied so a later edit of the source never changes a built card. */
export function playbookFromLegs(a: PlaybookV1): PlaybookV1 {
  const out: PlaybookV1 = { source: a.source, grade: a.grade, policyId: a.policyId, version: a.version, rev: a.rev, legs: a.legs.map(l => ({ ...l })) };
  if (a.presetState !== undefined) out.presetState = a.presetState;
  return out;
}

function trimZeros(s: string): string {
  return s.indexOf('.') === -1 ? s : s.replace(/0+$/, '').replace(/\.$/, '');
}

/** A percentage or a multiple for the plan text: at most two decimals, float noise removed (38.00000000000001 -> 38). */
export function planNum(x: number): string {
  if (!Number.isFinite(x)) return '—';
  return trimZeros((Math.round(x * 100) / 100).toFixed(2));
}

const NO_LIMIT = 1e9;
const EPS = 1e-9;

function hardRugPart(legs: readonly LegSpec[]): string {
  const r0 = legs.find(l => l.kind === 'hard_rug');
  if (r0 === undefined || r0.dropPct === undefined || r0.maxGapS === undefined) return '';
  return ` · hard-rug exit at −${planNum(r0.dropPct)}% within ${planNum(r0.maxGapS)}s`;
}

/** The stop line: from the rug_stop leg, or NONE. */
export function stopText(p: Pick<PlaybookV1, 'source' | 'legs'>): string {
  const s = p.legs.find(l => l.kind === 'rug_stop');
  const rug = hardRugPart(p.legs);
  if (s === undefined || s.atMultiple === undefined) {
    return p.source === 'preset' ? `Stop: NONE (you confirmed no stop)${rug}` : `Stop: none in this policy${rug}`;
  }
  const wpb = s.whilePeakBelow;
  const cond = wpb !== undefined && Number.isFinite(wpb) && wpb < NO_LIMIT ? ` while the peak is below +${planNum((wpb - 1) * 100)}%` : '';
  return `Stop: −${planNum((1 - s.atMultiple) * 100)}%${cond}${rug}`;
}

/** The take-profit ladder and what happens to the rest. */
export function ladderText(legs: readonly LegSpec[]): string {
  const tps = legs.filter(l => l.kind === 'take_profit' && l.atMultiple !== undefined && l.sellFractionOfOriginal !== undefined)
    .sort((a, b) => (a.atMultiple as number) - (b.atMultiple as number));
  const parts = tps.map((t, i) => `${i === 0 ? 'sell ' : ''}${planNum((t.sellFractionOfOriginal as number) * 100)}% at +${planNum(((t.atMultiple as number) - 1) * 100)}%`);
  const sum = tps.reduce((a, t) => a + (t.sellFractionOfOriginal as number), 0);
  const trail = legs.find(l => l.kind === 'trail');
  let rest: string | null = null;
  if (trail !== undefined && trail.armPeakMultiple !== undefined && trail.exitAtPeakFraction !== undefined) {
    const width = planNum((1 - trail.exitAtPeakFraction) * 100);
    rest = trail.armPeakMultiple <= 1 + EPS
      ? `trail the rest (sell all at −${width}% from the peak, from the first quote)`
      : `trail the rest (sell all at −${width}% from the peak once the peak is +${planNum((trail.armPeakMultiple - 1) * 100)}%)`;
  } else if (sum < 1 - EPS) {
    rest = 'the rest waits for the stop or the max hold';
  }
  const items = parts.length > 0 ? parts : ['none'];
  if (rest !== null) items.push(rest);
  return `Ladder: ${items.join(' · ')}`;
}

export function maxHoldText(legs: readonly LegSpec[]): string {
  const h = legs.find(l => l.kind === 'max_hold');
  if (h === undefined || h.afterMs === undefined) return 'Max hold: none';
  return `Max hold: ${planNum(h.afterMs / 3_600_000)}h`;
}

function noIgnitionText(legs: readonly LegSpec[]): string | null {
  const c = legs.find(l => l.kind === 'no_ignition');
  if (c === undefined || c.afterMs === undefined || c.whilePeakBelow === undefined || c.belowMultiple === undefined) return null;
  const below = (c.belowMultiple - 1) * 100;
  return `No ignition: sell all after ${planNum(c.afterMs / 60_000)} min while the peak stayed below +${planNum((c.whilePeakBelow - 1) * 100)}% and the price is below ${below >= 0 ? '+' : '−'}${planNum(Math.abs(below))}%`;
}

export function playbookHead(p: PlaybookV1): string {
  if (p.source === 'preset') return `Your grade-${p.grade} preset (rev ${p.rev === null ? '—' : String(p.rev)}) · positions keep the plan they opened with`;
  const why = p.presetState === 'follows' ? ` (your grade-${p.grade} preset follows it until you edit it)`
    : p.presetState === 'auto-sell-off' ? ' (Auto-Sell by Grade is OFF)'
    : p.presetState === 'preset-off' ? ` (your grade-${p.grade} preset is switched off)`
    : '';
  return `Exit policy ${p.policyId}${why}`;
}

/** A pause reason or a note as plain words: no markup, no line break, at most 60 characters ('' when nothing is left). */
function plainTag(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/[^A-Za-z0-9_ .:=-]/g, '').replace(/ {2,}/g, ' ').trim().slice(0, 60).trim();
}

/** The auto-buy state without the "Auto-buy: " prefix and the size (the bot's menus print it too). */
export function autoBuyModeText(a: PlaybookAutoBuy): string {
  const arm = a.arm === null ? '—' : a.arm;
  const base = a.mode === 'off' ? 'OFF' : a.mode === 'dry_run' ? `DRY RUN on arm ${arm}` : `LIVE on arm ${arm}`;
  const note = a.note === undefined || a.note === null ? '' : plainTag(a.note);
  const set = note === '' ? base : `${base} (${note})`;
  if (a.mode === 'off' || a.paused === undefined || a.paused === null) return set;
  const why = plainTag(a.paused);
  return `PAUSED (${why === '' ? 'unknown' : why}) · no buy until /autobuy resume · set: ${set}`;
}

export function autoBuyText(a: PlaybookAutoBuy): string {
  const size = a.buySol !== null && Number.isFinite(a.buySol) && a.buySol > 0 ? ` · size ${trimZeros(a.buySol.toFixed(9))} SOL` : '';
  return `Auto-buy: ${autoBuyModeText(a)}${size}`;
}

/** The PLAYBOOK lines (head, stop, ladder, [no ignition], max hold, [auto-buy]). Plain text. */
export function playbookLines(p: PlaybookV1, autoBuy?: PlaybookAutoBuy | null): string[] {
  const lines = [playbookHead(p), stopText(p), ladderText(p.legs)];
  const c1 = noIgnitionText(p.legs);
  if (c1 !== null) lines.push(c1);
  lines.push(maxHoldText(p.legs));
  if (autoBuy !== undefined && autoBuy !== null) lines.push(autoBuyText(autoBuy));
  return lines;
}
