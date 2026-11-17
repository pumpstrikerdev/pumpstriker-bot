// TG Bot copy of Esrcshared-tests${note} (R0-SHIMPL, A-115): the same suite over the byte-identical copies of the shared files in src/shared.
// Derived from the Engine file: the property tests and the acceptance ids stay in the Engine file.
// Tests of the card renderer (C03 section 4; A-115 CARD-MENU spec section 2 and 8). Snapshots: E\test-fixtures\card\*.json (input plus the
// expected card, line by line); the signal payload of the other tests comes from E\test-fixtures\contract\valid\signal.new.json (an older
// Engine: no detail) and signal.new.detail.json (a SYMF-shaped signal with the A-115 detail). The TG Bot runs the same suite from
// B\src\shared-tests\card.test.ts through its byte-identical copy of the renderer.
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CARD_LABEL_TEXT, fmtSourced, renderAlert, renderCancel, renderOps, renderSignal, STALE_AT_SIGNAL_MS } from '../shared/card/render-signal';
import type { RenderOpts, SignalCardExtras } from '../shared/card/render-signal';
import { playbookLines, type PlaybookAutoBuy, type PlaybookV1 } from '../shared/card/playbook';
import { loadPolicies, type LegSpec } from '../shared/exit-policy/exit-policy';
import type { ExitAlert, OpsAlert, SignalCancel, SignalNew, Sourced } from '../shared/contract/v1';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const fixtureDir = (name: string): string => {
  for (const dir of [path.resolve(__dirname, '..', '..', 'test-fixtures', name), path.join(ROOT, 'Engine', 'test-fixtures', name)]) {
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(`fixtures not found: ${name}`);
};
/** PUB-3: a clone of the bot alone has neither fixture folder (they live in the private monorepo); every test that reads them then skips. */
const hasFixtures = (name: string): boolean => { try { fixtureDir(name); return true; } catch { return false; } };
const NO_FIXTURES = !hasFixtures('contract');
if (NO_FIXTURES) console.warn('card.test.ts: the tests that read test-fixtures/contract and test-fixtures/card are skipped: the fixtures are not in this checkout');
const readJson = (dir: string, rel: string): any => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
const POLICIES = loadPolicies(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'exit-policy', 'exit-policies.json'), 'utf8')));
const EA = POLICIES.EA;

const OPTS: RenderOpts = { lateMs: 30_000, maxChars: 4096 };
const CA = 'ttFbypXwcXGc3ybAM7id8fW3Bi4dgKaAxAf1MTmYpump';

const strip = (x: any): any => Array.isArray(x) ? x.map(strip)
  : (x !== null && typeof x === 'object') ? Object.fromEntries(Object.keys(x).filter(k => !k.startsWith('x_unknown')).map(k => [k, strip(x[k])])) : x;
/** The valid signal.new payload (no detail: an older Engine) without its unknown keys, deep-copied so a test can edit it. */
function basePayload(): SignalNew {
  return strip(readJson(fixtureDir('contract'), 'valid/signal.new.json').payload) as SignalNew;
}
/** The SYMF-shaped payload WITH the A-115 detail. */
function symfPayload(): SignalNew {
  return strip(readJson(fixtureDir('contract'), 'valid/signal.new.detail.json').payload) as SignalNew;
}
const DECIDED = NO_FIXTURES ? 0 : basePayload().decision.decided_at;
const nullSourced = (): Sourced<number> => ({ value: null, src: null, as_of: null });
const lines = (text: string): string[] => text.split('\n');
const plain = (text: string): string => text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const eaPlaybook = (grade: 'A' | 'B' | 'C' = 'B'): PlaybookV1 => ({ source: 'policy', grade, policyId: 'EA', version: EA.version, rev: null, legs: EA.legs, presetState: 'follows' });
const BOT_EXTRAS = (ca: string): SignalCardExtras => ({
  playbook: eaPlaybook(),
  links: [{ label: 'GMGN', url: `https://gmgn.ai/sol/token/${ca}` }, { label: 'JUP', url: `https://jup.ag/swap/SOL-${ca}` }],
  autoBuy: { mode: 'off', arm: null, buySol: 0.01 },
});
/** Every tag of a line is closed on the same line. */
function balanced(line: string): boolean {
  const stack: string[] = [];
  for (const m of line.matchAll(/<(\/?)(b|i|code|a)(?:\s[^>]*)?>/g)) {
    if (m[1] === '') stack.push(m[2]);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}
const INVENTED = /mined set|rug rate|standard|still quiet|sweet-spot|PRIME|\bHOT\b|COLD|GOLDEN|odds|hit in/;

describe.skipIf(NO_FIXTURES)('renderSignal (A-115 layout)', () => {
  it('a SYMF-shaped payload with detail renders the old layout line by line, grade B header, PLAYBOOK from EA', () => {
    const sig = symfPayload();
    const text = renderSignal(sig, CA, sig.decision.decided_at + 1000, OPTS, BOT_EXTRAS(CA)).text;
    expect(lines(plain(text))).toEqual([
      '🦈🔥 PUMPSTRIKER — GRADE B PRE-PUMP 🔥',
      '━━━━━━━━━━━━━━━━━━━━',
      'Smart-money cluster on the line. Arms BS · B0 · B1 pass; B2 does not (band-10-25k=false).',
      '',
      'SYMBaiEX Forum  ($SYMF)',
      'Confidence: 85/100 · STRONG · pump',
      CA,
      '',
      '📊 MARKET',
      'Entry $0.00004377 · MCap $43.6k (circ)',
      'Liq $14.4k · Pool $14.4k · Age 0m (pool) · token 52m',
      'Vol 5m $13.8k · 1h $42.1k · 24h $42.1k',
      'Δ 5m +16.4% · 1h +158.1%',
      'Holders 305 · Top10 20.6% · Creator 0.0%',
      '🛡 Safety: ✅ clean',
      '🎯 Entry zone: $25-60k band (B2 needs $10-25k)',
      '🎰 Arms: BS ✓ · B0 ✓ · B1 ✓ · B2 ✗ (band-10-25k=false)',
      '🕒 Data ≤ 1s old at signal · ⚠ Creator hold 35s',
      '',
      '🧠 ACCUMULATION SIGNALS',
      '🐋 Smart-money: 4 wallets · 👑 1 KOL · 38.5 SOL',
      '💧 Liq-velocity: 39 USD/trade (5m)',
      '⚖️ Order flow 5m: 210 buys / 145 sells',
      '🔥 Burst vol5m/1h: 0.33',
      '🤫 Quiet+aged gate: — (age 0m)',
      '',
      '🟢 WHY',
      '  🐋 4 smart-money wallets bought (cluster +15)',
      '  🚀 pump launchpad (+4)',
      '  🌐 pump ecosystem (+3)',
      '  👑 1 KOL wallet(s) in the cluster',
      '  📍 mcap in the $25-60k band',
      '  🐣 young pool (under 12.5 min)',
      '  🎓 migrated, pool under 20 min old',
      '  📅 token created before the Engine cutover',
      '  +1 more',
      '',
      '🎯 PLAYBOOK',
      'Exit policy EA (your grade-B preset follows it until you edit it)',
      'Stop: −38% while the peak is below +50% · hard-rug exit at −40% within 15s',
      'Ladder: sell 30% at +100% · 30% at +200% · 20% at +400% · trail the rest (sell all at −40% from the peak once the peak is +50%)',
      'Max hold: 6h',
      'Auto-buy: OFF · size 0.01 SOL',
      '',
      'GMGN · JUP',
      '',
      '━━━━━━━━━━━━━━━━━━━━',
      '⚠️ NFA · DYOR · PRE-PUMP = HIGH RISK',
      'Silent accumulation can still rug. Size for a 100% loss. This is the most brutal market on earth.',
      `ids: rules eb1fc694c3b3 · policy EA ${sig.policy.version}`,
    ]);
    expect(text).toContain(`<a href="https://jup.ag/swap/SOL-${CA}">JUP</a>`);
    expect(text).toContain(`<code>${CA}</code>`);
    for (const l of lines(text)) expect(balanced(l), l).toBe(true);
  });

  it('the three grade headers and the arms-derived blurbs (A all pass; B names B2\'s reason; C names B1\'s reason)', () => {
    const a = basePayload();
    a.grade = 'A';
    for (const arm of ['BS', 'B0', 'B1', 'B2'] as const) a.arms[arm] = { eligible: true, blocked_by: [], unknown_inputs: [] };
    const ta = lines(plain(renderSignal(a, CA, DECIDED, OPTS).text));
    expect(ta[0]).toBe('🦈🚀 PUMPSTRIKER — GRADE A PRE-PUMP 🚀🦈');
    expect(ta[2]).toBe('Smart-money cluster on the line. Every auto-buy arm passes (BS · B0 · B1 · B2).');
    const b = symfPayload();
    expect(lines(plain(renderSignal(b, CA, DECIDED, OPTS).text))[2]).toBe('Smart-money cluster on the line. Arms BS · B0 · B1 pass; B2 does not (band-10-25k=false).');
    const c = basePayload();
    c.grade = 'C';
    c.arms.B1 = { eligible: false, blocked_by: ['knife', 'spike5', 'thin-liquidity'], unknown_inputs: [] };
    const tc = lines(plain(renderSignal(c, CA, DECIDED, OPTS).text));
    expect(tc[0]).toBe('🦈👀 PUMPSTRIKER — GRADE C (watch)');
    expect(tc[2]).toBe('Smart-money cluster on the line. Arm B1 is blocked (knife, spike5 +1); see the arms line.');
    // a grade whose arms do not fit its standard sentence names exactly the arms that pass
    const odd = basePayload();   // grade A in the fixture, but B0 and B2 blocked
    expect(lines(plain(renderSignal(odd, CA, DECIDED, OPTS).text))[2]).toBe('Smart-money cluster on the line. Arms passing: BS · B1.');
  });

  it('a payload WITHOUT detail (older Engine): no ACCUMULATION, no 24h, no token age, never 0, $0, 0% or NaN for an unknown', () => {
    const sig = basePayload();
    expect(sig.detail).toBeUndefined();
    const text = plain(renderSignal(sig, CA, DECIDED + 1000, OPTS).text);
    expect(text).not.toContain('ACCUMULATION');
    expect(text).not.toContain('24h');
    expect(text).not.toContain('token ');
    expect(text).not.toContain('Liq-velocity');
    expect(text).not.toContain('NaN');
    expect(text).toContain('Exit plan: policy EA a1b2c3d4e5f60718');
    expect(text).toContain('Creator —');          // creator_hold_pct is null in the fixture
    expect(text).not.toMatch(/Creator 0\.0%/);
    const ls = lines(text);
    expect(ls).toContain('Liq $12.0k · Pool $11.0k · Age 10m (pool)');
    // only the GMGN link (no bot extras)
    expect(renderSignal(sig, CA, DECIDED, OPTS).text).toContain(`<a href="https://gmgn.ai/sol/token/${CA}">GMGN</a>`);
  });

  it('every Sourced null prints an em dash (or the part is left out) and never a fake zero; a measured 0 prints as measured', () => {
    const sig = symfPayload();
    for (const k of Object.keys(sig.market) as Array<keyof SignalNew['market']>) sig.market[k] = nullSourced();
    const d = sig.detail!;
    for (const k of ['vol_24h_usd', 'buys_5m', 'sells_5m', 'burst', 'liq_eff_usd', 'token_age_min'] as const) d[k] = nullSourced();
    d.cluster.sol = nullSourced();
    d.cluster.kol = 0;
    const ls = lines(plain(renderSignal(sig, CA, DECIDED + 1000, OPTS).text));
    expect(ls).toContain('Liq — · Pool — · Age — (pool)');
    expect(ls).toContain('Vol 5m — · 1h —');
    expect(ls).toContain('Δ 5m — · 1h —');
    expect(ls).toContain('Holders — · Top10 — · Creator —');
    expect(ls).toContain('🐋 Smart-money: 4 wallets');           // KOL 0 and the unknown SOL are left out
    expect(ls.some(l => l.startsWith('💧 Liq-velocity'))).toBe(false);
    expect(ls.some(l => l.startsWith('⚖️ Order flow'))).toBe(false);
    expect(ls.some(l => l.startsWith('🔥 Burst'))).toBe(false);
    expect(ls).toContain('🤫 Quiet+aged gate: — (age unknown)');
    const fake = /\$0\b|[^\d.]0%|\b0\.00x|NaN/;
    for (const l of ls.filter(x => !x.startsWith('Entry ') && !x.startsWith('Stop:') && !x.startsWith('Ladder:'))) expect(l, l).not.toMatch(fake);
    // a measured 0 (creator 0.0 %) prints as measured
    expect(lines(plain(renderSignal(symfPayload(), CA, DECIDED, OPTS).text))).toContain('Holders 305 · Top10 20.6% · Creator 0.0%');
  });

  it('sentAt = decided_at + 30001 puts the LATE banner first; + 30000 has no banner', () => {
    const sig = basePayload();
    const late = lines(renderSignal(sig, CA, DECIDED + 30_001, OPTS).text);
    expect(late[0]).toBe('⚠ LATE: sent 30 s after the decision');
    expect(late[1]).toContain('PUMPSTRIKER');
    const onTime = renderSignal(sig, CA, DECIDED + 30_000, OPTS).text;
    expect(onTime).not.toContain('LATE');
    expect(lines(onTime)[0]).toContain('PUMPSTRIKER');
    expect(lines(renderSignal(sig, CA, DECIDED + 95_400, OPTS, BOT_EXTRAS(CA)).text)[0]).toBe('⚠ LATE: sent 95 s after the decision');
    expect(renderSignal(sig, CA, DECIDED + 5_001, { ...OPTS, lateMs: 5_000 }).text).toContain('LATE');
    expect(renderSignal(sig, CA, DECIDED + 45_000, { ...OPTS, lateMs: 60_000 }).text).not.toContain('LATE');
  });

  it('name, symbol, launchpad, tier, label ids and blocked_by are escaped; an invalid CA prints escaped with no link', () => {
    const sig = symfPayload();
    sig.token.name = '<script>&';
    sig.token.symbol = 'A"B<';
    sig.token.launchpad = '<lp>';
    sig.decision.tier = '<t>';
    sig.labels = [{ id: '<b>x</b>', rule_version: '1', value: true, known: true, acting: true }];
    sig.safety = { status: 'pending', as_of: null, checked: [], missing: ['<i>sec&</i>'] };
    sig.arms.BS = { eligible: false, blocked_by: ['<blocked>'], unknown_inputs: [] };
    const text = renderSignal(sig, 'CA<&>', DECIDED + 100, OPTS, BOT_EXTRAS('CA<&>')).text;
    expect(text).toContain('&lt;script&gt;&amp;');
    expect(text).toContain('A&quot;B&lt;');
    expect(text).toContain('&lt;lp&gt;');
    expect(text).toContain('&lt;t&gt;');
    expect(text).toContain('• &lt;b&gt;x&lt;/b&gt;');
    expect(text).toContain('&lt;i&gt;sec&amp;&lt;/i&gt;');
    expect(text).toContain('&lt;blocked&gt;');
    expect(text).toContain('<code>CA&lt;&amp;&gt;</code>');
    expect(text).not.toContain('href');
    expect(text).not.toMatch(/<(script|blocked|lp|t)>/);
    const tagless = text.replace(/<\/?(b|i|code)>/g, '').replace(/<a href="[^"]*">|<\/a>/g, '');
    expect(tagless.replace(/&(amp|lt|gt|quot);/g, '')).not.toMatch(/[<>"&]/);
    // a link whose url is not a plain https url is never printed
    const bad = renderSignal(symfPayload(), CA, DECIDED, OPTS, { links: [{ label: 'X', url: 'javascript:alert(1)' }, { label: 'Y', url: 'https://x.io/"><b>' }] }).text;
    expect(bad).not.toContain('href');
    // the other cards escape too
    const cancel: SignalCancel = { reason: 'retro_kill', kills: ['<K4>'], detected_at: DECIDED, detail: 'x', action: 'sell_if_held' };
    expect(renderCancel(cancel, CA, '<sym>', DECIDED + 5000, OPTS).text).toContain('&lt;sym&gt;');
    const ops: OpsAlert = { alarm_id: 'a', severity: 'warn', text: 'a<b & "c"', since: DECIDED, cleared_at: null };
    expect(renderOps(ops, DECIDED, OPTS).text).toContain('a&lt;b &amp; &quot;c&quot;');
  });

  it('64 labels, max-length names and every detail field fit 4096; the overflow order holds; every line has balanced tags', () => {
    const sig = symfPayload();
    sig.token.name = 'N'.repeat(5000);
    sig.token.symbol = 'S'.repeat(500);
    sig.token.launchpad = 'L'.repeat(500);
    sig.labels = Array.from({ length: 64 }, (_, i) => ({ id: `label-${String(i).padStart(2, '0')}-${'x'.repeat(50)}`, rule_version: '1', value: true, known: true, acting: i < 40 }));
    sig.safety = { status: 'pending', as_of: null, checked: [], missing: Array.from({ length: 30 }, (_, i) => `field-${i}`) };
    const card = renderSignal(sig, CA, DECIDED + 60_000, OPTS, BOT_EXTRAS(CA));
    expect(card.text.length).toBeLessThanOrEqual(4096);
    const ls = lines(card.text);
    expect(ls[0].startsWith('⚠ LATE')).toBe(true);
    for (const l of ls) expect(balanced(l), l).toBe(true);
    expect(ls.some(l => l.startsWith('Entry $0.00004377'))).toBe(true);
    expect(ls.filter(l => l.startsWith('  ') && !l.startsWith('  +')).length).toBeLessThanOrEqual(8);   // WHY is capped at 8 lines
    expect(ls.some(l => /^ {2}\+\d+ more$/.test(l))).toBe(true);

    // the overflow order: WHY to 3, stale list short, holders, vol/chg, ACCUMULATION reduced, blurb, links, ids; never the mandatory lines
    const roomy = renderSignal(symfPayload(), CA, DECIDED + 60_000, OPTS, BOT_EXTRAS(CA)).text;
    const at = (n: number): string => renderSignal(symfPayload(), CA, DECIDED + 60_000, { ...OPTS, maxChars: n }, BOT_EXTRAS(CA)).text;
    const s1 = at(roomy.length - 1);
    expect(s1.length).toBeLessThan(roomy.length);
    expect(lines(s1).filter(l => /^ {2}\S/.test(l) && !/^ {2}\+/.test(l))).toHaveLength(3);
    expect(s1).toContain('Holders 305');
    const s2 = at(s1.length - 1);
    expect(s2).toContain('⚠ 1 stale');
    const s3 = at(s2.length - 1);
    expect(s3).not.toContain('Holders 305');
    expect(s3).toContain('Vol 5m');
    const s4 = at(s3.length - 1);
    expect(s4).not.toContain('Vol 5m');
    expect(s4).toContain('Order flow');
    const s5 = at(s4.length - 1);
    expect(s5).not.toContain('Order flow');
    expect(s5).toContain('Smart-money: <b>4</b>');
    expect(s5).toContain('Burst');
    const s6 = at(s5.length - 1);
    expect(s6).not.toContain('Smart-money cluster on the line');
    const s7 = at(s6.length - 1);
    expect(s7).not.toContain('href');
    const s8 = at(s7.length - 1);
    expect(s8).not.toContain('ids: rules');
    for (const t of [s1, s2, s3, s4, s5, s6, s7, s8]) {
      expect(t).toContain('LATE');
      expect(t).toContain('PUMPSTRIKER');
      expect(t).toContain('Entry $0.00004377');
      expect(t).toContain('PLAYBOOK');
      expect(t).toContain('NFA · DYOR');
    }
    // past every step: fit() cuts at a line boundary, the cut never splits a tag
    for (const maxChars of [900, 400, 250, 160, 40]) {
      const tiny = renderSignal(sig, CA, DECIDED + 60_000, { ...OPTS, maxChars }, BOT_EXTRAS(CA)).text;
      expect(tiny.length, `maxChars ${maxChars}`).toBeLessThanOrEqual(maxChars);
      for (const l of lines(tiny)) expect(balanced(l), `${maxChars}: ${l}`).toBe(true);
      if (maxChars >= 250) expect(tiny.endsWith('\n…')).toBe(true);
    }
  });

  it.skipIf(!hasFixtures('card'))('the stored snapshots: grade A clean, grade C safety pending, grade B LATE, grade B with detail and bot extras', () => {
    const dir = fixtureDir('card');
    const names = ['grade-a-clean', 'grade-c-safety-pending', 'grade-b-late', 'grade-b-detail-extras'];
    for (const name of names) {
      const fx = readJson(dir, `${name}.json`);
      const card = renderSignal(fx.signal as SignalNew, fx.ca, fx.sentAt, fx.opts, fx.extras);
      expect(card.parseMode).toBe('HTML');
      expect(lines(card.text), name).toEqual(fx.expected);
    }
    expect(readJson(dir, 'grade-a-clean.json').expected.join('\n')).not.toContain('LATE');
    expect(readJson(dir, 'grade-c-safety-pending.json').expected.join('\n')).toContain('🛡 Safety: ⏳ pending (missing: security, holders, creator_balance_rate)');
    expect(readJson(dir, 'grade-b-late.json').expected[0]).toContain('LATE');
  });

  it('the data-age line: the largest age, ⚠ past 30 s, the short form, a reading from the future counts as 0 s', () => {
    const sig = symfPayload();
    const D = sig.decision.decided_at;
    expect(STALE_AT_SIGNAL_MS).toBe(30_000);
    sig.market.holders = { value: 305, src: 'gmgn.token_info', as_of: D - 12_000 };
    sig.market.top10_pct = { value: 20.6, src: 'gmgn.token_info', as_of: D - 30_000 };       // exactly 30 s is not stale
    sig.market.vol_1h_usd = { value: 42_100, src: 'gmgn.token_info', as_of: D - 200_000 };
    const age = (s: SignalNew): string | undefined => lines(plain(renderSignal(s, CA, D, OPTS).text)).find(l => l.startsWith('🕒'));
    expect(age(sig)).toBe('🕒 Data ≤ 30s old at signal · ⚠ Vol 1h 3m · ⚠ Creator hold 35s');
    sig.market.liq_usd = { value: 1, src: 'gmgn.token_info', as_of: D - 31_000 };
    sig.market.pool_liq_usd = { value: 1, src: 'gmgn.pool_info', as_of: D - 40_000 };
    expect(age(sig)).toBe('🕒 Data ≤ 30s old at signal · ⚠ Liq 31s · ⚠ Pool 40s · ⚠ Vol 1h 3m +1');
    // a reading from the future counts as 0 s
    const fut = symfPayload();
    for (const k of Object.keys(fut.market) as Array<keyof SignalNew['market']>) fut.market[k] = { value: 1, src: 'gmgn.token_info', as_of: D + 5000 };
    for (const k of ['vol_24h_usd', 'buys_5m', 'sells_5m', 'token_age_min'] as const) fut.detail![k] = nullSourced();
    fut.detail!.cluster.sol = nullSourced();
    expect(age(fut)).toBe('🕒 Data ≤ 0s old at signal');
  });

  it('PLAYBOOK: EA exact; a custom preset; a no-stop preset; trail armed from the first quote; a full ladder; no extras -> the policy line', () => {
    expect(playbookLines(eaPlaybook('B'))).toEqual([
      'Exit policy EA (your grade-B preset follows it until you edit it)',
      'Stop: −38% while the peak is below +50% · hard-rug exit at −40% within 15s',
      'Ladder: sell 30% at +100% · 30% at +200% · 20% at +400% · trail the rest (sell all at −40% from the peak once the peak is +50%)',
      'Max hold: 6h',
    ]);
    const r0 = EA.legs.find(l => l.id === 'R0') as LegSpec;
    const custom: PlaybookV1 = { source: 'preset', grade: 'A', policyId: 'PRESET-A', version: '0123456789abcdef', rev: 3, legs: [
      r0, { id: 'S', kind: 'rug_stop', protective: true, atMultiple: 0.65, whilePeakBelow: Number.MAX_VALUE },
      { id: 'TP1', kind: 'take_profit', protective: false, atMultiple: 1.8, sellFractionOfOriginal: 0.25 },
      { id: 'TP2', kind: 'take_profit', protective: false, atMultiple: 5, sellFractionOfOriginal: 0.2625 },
      { id: 'T', kind: 'trail', protective: true, armPeakMultiple: 3, exitAtPeakFraction: 0.6 },
    ] };
    expect(playbookLines(custom, { mode: 'live', arm: 'B1', buySol: 0.5 })).toEqual([
      'Your grade-A preset (rev 3) · positions keep the plan they opened with',
      'Stop: −35% · hard-rug exit at −40% within 15s',
      'Ladder: sell 25% at +80% · 26.25% at +400% · trail the rest (sell all at −40% from the peak once the peak is +200%)',
      'Max hold: none',
      'Auto-buy: LIVE on arm B1 · size 0.5 SOL',
    ]);
    const noStop: PlaybookV1 = { ...custom, legs: [r0, { id: 'T', kind: 'trail', protective: true, armPeakMultiple: 1, exitAtPeakFraction: 0.7 }] };
    const ns = playbookLines(noStop);
    expect(ns[1]).toBe('Stop: NONE (you confirmed no stop) · hard-rug exit at −40% within 15s');
    expect(ns[2]).toBe('Ladder: none · trail the rest (sell all at −30% from the peak, from the first quote)');
    const full: PlaybookV1 = { ...custom, legs: [r0, { id: 'S', kind: 'rug_stop', protective: true, atMultiple: 0.7, whilePeakBelow: Number.MAX_VALUE },
      { id: 'TP1', kind: 'take_profit', protective: false, atMultiple: 2, sellFractionOfOriginal: 0.5 },
      { id: 'TP2', kind: 'take_profit', protective: false, atMultiple: 3, sellFractionOfOriginal: 0.5 }] };
    expect(playbookLines(full)[2]).toBe('Ladder: sell 50% at +100% · 50% at +200%');
    const partial: PlaybookV1 = { ...full, legs: full.legs.slice(0, 3) };
    expect(playbookLines(partial)[2]).toBe('Ladder: sell 50% at +100% · the rest waits for the stop or the max hold');
    expect(playbookLines({ ...eaPlaybook('C'), presetState: 'auto-sell-off' })[0]).toBe('Exit policy EA (Auto-Sell by Grade is OFF)');
    expect(playbookLines({ source: 'policy', grade: 'B', policyId: 'EA-C1', version: POLICIES['EA-C1'].version, rev: null, legs: POLICIES['EA-C1'].legs })[3])
      .toBe('No ignition: sell all after 30 min while the peak stayed below +50% and the price is below +0%');
    expect(playbookLines({ source: 'policy', grade: 'B', policyId: 'HOLD-1H', version: POLICIES['HOLD-1H'].version, rev: null, legs: POLICIES['HOLD-1H'].legs }).slice(1))
      .toEqual(['Stop: none in this policy', 'Ladder: none · the rest waits for the stop or the max hold', 'Max hold: 1h']);
    // in the card: the extras' plan, or the fallback line
    const sig = symfPayload();
    expect(plain(renderSignal(sig, CA, DECIDED, OPTS, { playbook: custom }).text)).toContain('Your grade-A preset (rev 3)');
    const fb = lines(plain(renderSignal(sig, CA, DECIDED, OPTS).text));
    expect(fb[fb.indexOf('🎯 PLAYBOOK') + 1]).toBe(`Exit plan: policy EA ${sig.policy.version}`);
  });

  it('CARD-T18 the auto-buy line says what a buy from this card really does: DRY RUN with its reason, PAUSED with its reason, OFF', () => {
    const pb = eaPlaybook('B');
    const last = (a: PlaybookAutoBuy): string => { const l = playbookLines(pb, a); return l[l.length - 1]; };
    expect(last({ mode: 'live', arm: 'B1', buySol: 0.5 })).toBe('Auto-buy: LIVE on arm B1 · size 0.5 SOL');
    expect(last({ mode: 'dry_run', arm: 'B1', buySol: 0.5, note: 'BOT_DRY_RUN on: nothing is sent' }))
      .toBe('Auto-buy: DRY RUN on arm B1 (BOT_DRY_RUN on: nothing is sent) · size 0.5 SOL');
    expect(last({ mode: 'live', arm: 'B1', buySol: null, paused: 'paused_fails' }))
      .toBe('Auto-buy: PAUSED (paused_fails) · no buy until /autobuy resume · set: LIVE on arm B1');
    expect(last({ mode: 'dry_run', arm: 'BS', buySol: 0.01, paused: 'paused_breaker', note: null }))
      .toBe('Auto-buy: PAUSED (paused_breaker) · no buy until /autobuy resume · set: DRY RUN on arm BS · size 0.01 SOL');
    expect(last({ mode: 'off', arm: null, buySol: 0.01, note: 'live not confirmed: nothing is bought' }))
      .toBe('Auto-buy: OFF (live not confirmed: nothing is bought) · size 0.01 SOL');
    expect(last({ mode: 'off', arm: null, buySol: null, paused: 'paused_fails' })).toBe('Auto-buy: OFF');   // a pause of an OFF auto-buy changes nothing
    // a reason never carries markup or a line break into the card; an empty one reads 'unknown'
    expect(last({ mode: 'dry_run', arm: 'BS', buySol: null, paused: '<b>x</b>\n*y*' }))
      .toBe('Auto-buy: PAUSED (bxb y) · no buy until /autobuy resume · set: DRY RUN on arm BS');
    expect(last({ mode: 'live', arm: 'B1', buySol: null, paused: '<>' })).toBe('Auto-buy: PAUSED (unknown) · no buy until /autobuy resume · set: LIVE on arm B1');
    // in the card
    const sig = symfPayload();
    const card = renderSignal(sig, CA, DECIDED, OPTS, { playbook: pb, autoBuy: { mode: 'dry_run', arm: 'B1', buySol: 0.5, note: 'BOT_DRY_RUN on: nothing is sent' } });
    expect(lines(plain(card.text))).toContain('Auto-buy: DRY RUN on arm B1 (BOT_DRY_RUN on: nothing is sent) · size 0.5 SOL');
    expect(plain(card.text)).not.toContain('LIVE on arm');
    expect(card.text.split('\n').every(balanced)).toBe(true);
  });

  it('only terms with points > 0 print; an unknown label id prints "• <id>"; risk unknown names the unknown inputs', () => {
    const sig = symfPayload();
    sig.detail!.score.terms = [{ term: 'cluster', points: 0 }, { term: 'quietAged', points: 12 }, { term: 'burstAged', points: -3 }];
    sig.labels = [
      { id: 'brand-new-label', rule_version: '1', value: true, known: true, acting: false },
      { id: 'knife', rule_version: '1', value: true, known: true, acting: true },
      { id: 'feed-gap', rule_version: '1', value: true, known: true, acting: false },
      { id: 'young', rule_version: '1', value: true, known: true, acting: false },
      { id: 'spike5', rule_version: '1', value: null, known: false, acting: true },
    ];
    sig.arms.B1 = { eligible: false, blocked_by: ['risk-unknown'], unknown_inputs: ['c5m'] };
    const ls = lines(plain(renderSignal(sig, CA, DECIDED, OPTS).text));
    const why = ls.slice(ls.indexOf('🟢 WHY') + 1, ls.indexOf('🎯 PLAYBOOK') - 1);
    expect(why).toEqual([
      '  🤫 quiet + aged: pool ≥ 165 min, vol 1h < $10k (+12)',
      '  👑 1 KOL wallet(s) in the cluster',
      '  🔪 knife: ≥ 30% under the 10-min high or −30% in 5m',
      '  🐣 young pool (under 12.5 min)',
      '  ⚠️ smart-money feed gap',
      '  • brand-new-label',
      '  ❓ risk unknown: c5m',
    ]);
    // a label that is false or unknown never prints its WHY text
    expect(ls.join('\n')).not.toContain('+100% or more in 5m');
  });

  it('the text never carries an invented stat, whatever the payload', () => {
    for (const s of [basePayload(), symfPayload()]) {
      for (const ex of [undefined, BOT_EXTRAS(CA)]) expect(renderSignal(s, CA, DECIDED + 40_000, OPTS, ex).text).not.toMatch(INVENTED);
    }
  });

  it('the renderer is pure: no clock, and neither the input nor the extras are changed', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      const sig = symfPayload();
      const ex = BOT_EXTRAS(CA);
      const before = JSON.stringify(sig);
      const exBefore = JSON.stringify(ex);
      const a = renderSignal(sig, CA, DECIDED + 100, OPTS, ex);
      const b = renderSignal(JSON.parse(before) as SignalNew, CA, DECIDED + 100, OPTS, JSON.parse(exBefore));
      expect(a).toEqual(b);
      expect(JSON.stringify(sig)).toBe(before);
      expect(JSON.stringify(ex)).toBe(exBefore);
      expect(now).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });
});

describe.skipIf(NO_FIXTURES)('renderAlert, renderCancel, renderOps', () => {
  const alert: ExitAlert = { leg: 'TP1', policy: { id: 'EA', version: 'a1b2c3d4e5f60718' }, multiple: 2.05, peak_multiple: 2.1, basis: 'signal_entry', price_usd: 0.0000615, priced_at: DECIDED, quote_age_s: 42 };

  it('renderAlert prints the leg, the multiples and the quote age: "42s old"', () => {
    const card = renderAlert(alert, CA, 'CREW', DECIDED + 42_000, OPTS);
    expect(card.parseMode).toBe('HTML');
    expect(card.text).toContain('42s old');
    expect(card.text).toBe('TP1 CREW: 2.05x (peak 2.10x) on the signal basis · quote 42s old · policy a1b2c3d4e5f60718');
    expect(renderAlert({ ...alert, leg: 'S', multiple: 0.61, peak_multiple: 1.1 }, CA, null, DECIDED, OPTS).text).toBe('S —: 0.61x (peak 1.10x) on the signal basis · quote 42s old · policy a1b2c3d4e5f60718');
    expect(renderAlert({ ...alert, multiple: 0.004 }, CA, 'X', DECIDED, OPTS).text).toContain('<0.01x');
  });

  it('renderOps prints the severity, the escaped text and the time labelled UTC: "since HH:MM UTC", or "since HH:MM, cleared HH:MM UTC" when it cleared', () => {
    const since = Date.UTC(2026, 9, 18, 13, 5, 30);
    const open: OpsAlert = { alarm_id: 'feed-dark', severity: 'red', text: 'feed <dark> & "late"', since, cleared_at: null };
    const a = renderOps(open, since + 60_000, OPTS);
    expect(a.parseMode).toBe('HTML');
    expect(a.text).toBe('⚠ ENGINE red: feed &lt;dark&gt; &amp; &quot;late&quot; (since 13:05 UTC)');
    expect(a.text).not.toContain('cleared');
    const closed = renderOps({ ...open, severity: 'warn', cleared_at: Date.UTC(2026, 9, 18, 13, 42, 0) }, since + 60_000, OPTS);
    expect(closed.text).toBe('⚠ ENGINE warn: feed &lt;dark&gt; &amp; &quot;late&quot; (since 13:05, cleared 13:42 UTC)');
    expect(renderOps({ ...open, text: 'x'.repeat(2000) }, since, { ...OPTS, maxChars: 200 }).text.length).toBeLessThanOrEqual(200);
  });

  it('renderCancel prints the symbol, the kills, the age and the action', () => {
    const cancel: SignalCancel = { reason: 'retro_kill', kills: ['K4', 'K9'], detected_at: DECIDED + 10_000, detail: 'creator balance jumped', action: 'sell_if_held' };
    const card = renderCancel(cancel, CA, 'CREW', DECIDED + 70_000, OPTS);
    expect(card.parseMode).toBe('HTML');
    expect(card.text).toBe('⛔ CANCEL CREW: retro-kill (K4, K9) detected 60s ago. Action: sell if held.');
    expect(renderCancel(cancel, CA, null, DECIDED + 10_000 + 400_000, OPTS).text).toBe('⛔ CANCEL —: retro-kill (K4, K9) detected 6m ago. Action: sell if held.');
  });
});

describe('fmtSourced and the number formats', () => {
  const at = 1_790_000_000_000;
  const s = (value: number | null, ageMs = 4000): Sourced<number> => value === null ? nullSourced() : { value, src: 'gmgn.token_info', as_of: at - ageMs };

  it('prints the value with its age, and an em dash for a null value', () => {
    expect(fmtSourced(s(12_345), 'usd', at)).toBe('$12.3k (4s old)');
    expect(fmtSourced(s(null), 'usd', at)).toBe('—');
    expect(fmtSourced(s(null), 'pct', at)).toBe('—');
    expect(fmtSourced(s(312, 130_000), 'count', at)).toBe('312 (2m old)');
    expect(fmtSourced(s(12_345, 8_000_000), 'count', at)).toBe('12,345 (2h old)');
    expect(fmtSourced(s(45), 'min', at)).toBe('45m (4s old)');
    expect(fmtSourced(s(150), 'min', at)).toBe('2.5h (4s old)');
    expect(fmtSourced(s(4000), 'min', at)).toBe('2.8d (4s old)');
    expect(fmtSourced({ value: 5, src: 'gmgn.token_info', as_of: at + 9000 }, 'count', at)).toBe('5 (0s old)');
    expect(fmtSourced({ value: 5, src: null, as_of: null }, 'count', at)).toBe('5 (age unknown)');
    expect(fmtSourced({ value: Number.NaN, src: 'gmgn.token_info', as_of: at }, 'usd', at)).toBe('—');
  });

  it('USD: up to 4 significant digits below 1, 12.3k, 1.2M; percentages with a sign and one decimal', () => {
    const usd = (n: number): string => fmtSourced(s(n, 0), 'usd', at).replace(' (0s old)', '');
    expect(usd(0.00003)).toBe('$0.00003');
    expect(usd(0.0000123456)).toBe('$0.00001235');
    expect(usd(0.5)).toBe('$0.5');
    expect(usd(0.1234567)).toBe('$0.1235');
    expect(usd(0.0000000123456)).toBe('$0.00000001235');
    expect(usd(1)).toBe('$1');
    expect(usd(12.5)).toBe('$12.5');
    expect(usd(999.99)).toBe('$999.99');
    expect(usd(999.996)).toBe('$1.0k');
    expect(usd(12_345)).toBe('$12.3k');
    expect(usd(999_950)).toBe('$1.0M');
    expect(usd(1_234_567)).toBe('$1.2M');
    expect(usd(2_500_000_000)).toBe('$2.5B');
    expect(usd(0)).toBe('$0');
    const pct = (n: number): string => fmtSourced(s(n, 0), 'pct', at).replace(' (0s old)', '');
    expect(pct(12.34)).toBe('+12.3%');
    expect(pct(-12.34)).toBe('-12.3%');
    expect(pct(0)).toBe('+0.0%');
    expect(pct(-0.04)).toBe('+0.0%');
    expect(pct(100)).toBe('+100.0%');
  });
});
