// R1-B1 (B10 section 3 rule 3): the card builders over the shared C03 renderer. The renderer itself is tested by the shared card suite.
import { describe, expect, it } from 'vitest';
import { renderAlert, renderCancel, renderOps, renderSignal } from '../shared/card/render-signal';
import type { ExitAlert, OpsAlert, SignalCancel, SignalNew } from '../shared/contract/v1';
import { fixture } from '../link/link-testkit';
import { alertCard, cancelCard, cardOpts, CARD_MAX_CHARS, escapeHtml, isLate, noticeCard, opsCard, signalCard, TG_LATE_MS } from './cards';

const SIG: SignalNew = fixture('signal.new').payload;
const CANCEL: SignalCancel = fixture('signal.cancel').payload;
const ALERT: ExitAlert = fixture('alert.exit').payload;
const OPS: OpsAlert = fixture('ops.alert').payload;
const CA = fixture<{ ca: string }>('signal.new').ca;
const DECIDED = SIG.decision.decided_at;

describe('bot cards', () => {
  it('uses the shared renderer with lateMs 30000 and maxChars 4096', () => {
    expect(cardOpts()).toEqual({ lateMs: 30_000, maxChars: 4096 });
    expect(TG_LATE_MS).toBe(30_000);
    expect(CARD_MAX_CHARS).toBe(4096);
    const now = DECIDED + 5_000;
    const c = signalCard(SIG, CA, now);
    expect(c.text).toBe(renderSignal(SIG, CA, now, cardOpts()).text);
    expect(c.parseMode).toBe('HTML');
    expect(cancelCard(CANCEL, CA, 'CREW', now).text).toBe(renderCancel(CANCEL, CA, 'CREW', now, cardOpts()).text);
    expect(alertCard(ALERT, CA, 'CREW', now).text).toBe(renderAlert(ALERT, CA, 'CREW', now, cardOpts()).text);
    expect(opsCard(OPS, now).text).toBe(renderOps(OPS, now, cardOpts()).text);
  });

  it('can be rendered again for the real send time: the banner and the ages follow the send, not the enqueue', () => {
    const c = signalCard(SIG, CA, DECIDED + 5_000);
    expect(c.text).not.toContain('LATE');
    expect(c.rerender?.(DECIDED + 30_000)?.text).not.toContain('LATE');
    expect(c.rerender?.(DECIDED + 30_001)?.text.split('\n')[0]).toBe('⚠ LATE: sent 30 s after the decision');
    expect(c.rerender?.(DECIDED + 90_000)?.text.split('\n')[0]).toBe('⚠ LATE: sent 90 s after the decision');
    const alert = alertCard(ALERT, CA, 'CREW', ALERT.priced_at + 1_000);
    expect(alert.rerender?.(ALERT.priced_at + 1_000)?.text).toBe(alert.text);
  });

  it('isLate is true only strictly above the limit and never for an unknown decision time', () => {
    expect(isLate(1_000, 31_000)).toBe(false);
    expect(isLate(1_000, 31_001)).toBe(true);
    expect(isLate(null, 10 ** 12)).toBe(false);
    expect(isLate(0, 10, 5)).toBe(true);
  });

  it('a notice is one escaped line, cut to one message', () => {
    expect(noticeCard('a <b> & "c"\n  d').text).toBe('a &lt;b&gt; &amp; &quot;c&quot; d');
    expect(noticeCard('x'.repeat(10_000)).text.length).toBeLessThanOrEqual(CARD_MAX_CHARS);
    expect(noticeCard('x'.repeat(10_000)).parseMode).toBe('HTML');
    expect(noticeCard('&'.repeat(5_000)).text).not.toMatch(/&(?!amp;)/);
    expect(escapeHtml('<&>"')).toBe('&lt;&amp;&gt;&quot;');
  });
});

// A-115 (CARD-MENU spec 2.6): the link line is built by the bot only, from fixed templates over a validated CA; without the guard decision
// D1 there is no DEX link (the bot guard G-S13 bans that host's name on every line of src/**).
describe('signal card extras (A-115)', () => {
  it('CARD-T12 the link templates: GMGN and JUP for a base58 CA, nothing for anything else; no other bot file builds them', async () => {
    const { cardLinks } = await import('./card-links');
    expect(cardLinks(CA)).toEqual([
      { label: 'GMGN', url: `https://gmgn.ai/sol/token/${CA}` },
      { label: 'JUP', url: `https://jup.ag/swap/SOL-${CA}` },
    ]);
    for (const bad of ['', 'CA<&>', `${CA}"`, '0OIl'.repeat(10), `${CA}/../x`]) expect(cardLinks(bad), bad).toEqual([]);
    expect(cardLinks(CA).map(l => l.label)).not.toContain('DEX');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'card-links.ts'), 'utf8');
    expect(src).not.toMatch(/\bimport\b[^\n]*\b(http|https|net|undici|node-fetch|axios)\b/);
    // the card carries the links, the buttons are fixed at enqueue, a button over 64 bytes is never built
    const long = { text: 'x', callback_data: 'y'.repeat(65) };
    const card = signalCard(SIG, CA, DECIDED + 1000, TG_LATE_MS, { links: cardLinks(CA) }, [[{ text: '🟢 Buy 0.1 SOL', callback_data: `sbuy:${CA}:0.1` }, long]]);
    expect(card.text).toContain(`<a href="https://gmgn.ai/sol/token/${CA}">GMGN</a> · <a href="https://jup.ag/swap/SOL-${CA}">JUP</a>`);
    expect(card.buttons).toEqual([[{ text: '🟢 Buy 0.1 SOL', callback_data: `sbuy:${CA}:0.1` }]]);
    expect(card.rerender?.(DECIDED + 40_000).text).toContain('JUP</a>');
    expect(card.rerender?.(DECIDED + 40_000).text.startsWith('⚠ LATE')).toBe(true);
    // no buttons at all: the card has no keyboard
    expect(signalCard(SIG, CA, DECIDED, TG_LATE_MS).buttons).toBeUndefined();
  });
});
