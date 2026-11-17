// TG Bot copy of E\src\shared-tests\contract.test.ts (R0-SHIMPL): the same suite over the byte-identical copies of the shared files in src/shared.
// Derived from the Engine file: the property tests and the acceptance ids stay in the Engine file.
// Tests of the contract v1 validators (C02 section 3 and section 7). Fixtures: E\test-fixtures\contract\** (one valid fixture per event type, one
// invalid fixture per invariant; an invalid fixture names a valid base, edits it and states the verdict). The TG Bot runs the same suite from
// B\src\shared-tests\contract.test.ts through its byte-identical copies of the shared files.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { mdSafe, parseSignalDetail, signalDetailDropped, validateBotBatch, validateEngineToBot, validateTokenProxyResponse } from '../shared/contract/validate';
import type { BatchValidation } from '../shared/contract/validate';
import { redactSecrets } from '../shared/redact';

// ---------------------------------------------------------------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------------------------------------------------------------

/** R\ (this file sits in <R>/Engine/src/shared-tests or <R>/TG Bot/src/shared-tests). */
const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_DIR = ((): string => {
  for (const dir of [path.resolve(__dirname, '..', '..', 'test-fixtures', 'contract'), path.join(ROOT, 'Engine', 'test-fixtures', 'contract')]) {
    if (fs.existsSync(path.join(dir, 'meta.json'))) return dir;
  }
  return '';
})();
/** PUB-3: a clone of the bot alone has neither fixture folder (they live in the private monorepo); every test that reads them then skips. */
const NO_FIXTURES = FIXTURE_DIR === '';
if (NO_FIXTURES) console.warn('contract.test.ts: the tests that read test-fixtures/contract are skipped: the fixtures are not in this checkout');

type Json = any;
const readJson = (rel: string): Json => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, ...rel.split('/')), 'utf8'));
const META: { now: number } = NO_FIXTURES ? { now: 0 } : readJson('meta.json');
const NOW = META.now;

interface Verdict { ok: boolean; status?: number; code?: string; reason?: string }
interface InvalidFixture {
  description: string; group: 'invariant' | 'clock' | 'ttl' | 'ops' | 'proxy'; direction: 'engine-to-bot' | 'bot-to-engine' | 'proxy'; base: string;
  set?: Array<{ path: string; value?: unknown; nowPlus?: number }>; delete?: string[]; nowOffset?: number; expect: { status: number; code: string };
}

/** The fixture without its unknown keys (every key starting with x_unknown). */
function stripUnknown(x: Json): Json {
  if (Array.isArray(x)) return x.map(stripUnknown);
  if (x !== null && typeof x === 'object') {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(x)) if (!k.startsWith('x_unknown')) out[k] = stripUnknown(x[k]);
    return out;
  }
  return x;
}

function walk(root: Json, dotted: string, create: boolean): { parent: Json; key: string } {
  const parts = dotted.split('.');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === undefined && create) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  return { parent: cur, key: parts[parts.length - 1] };
}

function applyEdit(base: Json, fx: InvalidFixture): Json {
  const ev = JSON.parse(JSON.stringify(base));
  for (const s of fx.set ?? []) {
    const { parent, key } = walk(ev, s.path, true);
    parent[key] = s.nowPlus !== undefined ? NOW + s.nowPlus : s.value;
  }
  for (const d of fx.delete ?? []) {
    const { parent, key } = walk(ev, d, false);
    delete parent[key];
  }
  return ev;
}

/** One event through the validator that fits its direction; a bot event goes through a batch of one. */
function verdictOf(direction: InvalidFixture['direction'], body: Json, now: number): Verdict {
  if (direction === 'engine-to-bot') {
    const r = validateEngineToBot(body, now);
    return r.ok ? { ok: true } : { ok: false, status: r.status, code: r.code, reason: r.reason };
  }
  if (direction === 'proxy') {
    const r = validateTokenProxyResponse(body);
    return r.ok ? { ok: true } : { ok: false, status: r.status, code: r.code, reason: r.reason };
  }
  const b = validateBotBatch({ events: [body] }, now);
  if (!b.ok) return { ok: false, status: b.status, code: b.code, reason: b.reason };
  const r = b.events[0].result;
  return r.ok ? { ok: true } : { ok: false, status: r.status, code: r.code, reason: r.reason };
}

const INVALID: Array<{ name: string; fx: InvalidFixture }> = NO_FIXTURES ? [] : fs.readdirSync(path.join(FIXTURE_DIR, 'invalid')).filter(f => f.endsWith('.json')).sort()
  .map(f => ({ name: f.replace(/\.json$/, ''), fx: readJson(`invalid/${f}`) as InvalidFixture }));

function runInvalid(group: InvalidFixture['group']): Array<{ name: string; fx: InvalidFixture; verdict: Verdict }> {
  return INVALID.filter(c => c.fx.group === group).map(c => {
    const body = applyEdit(readJson(c.fx.base), c.fx);
    return { ...c, verdict: verdictOf(c.fx.direction, body, NOW + (c.fx.nowOffset ?? 0)) };
  });
}

const ENGINE_VALID = ['signal.new', 'signal.new.detail', 'signal.cancel', 'alert.exit', 'arms.status', 'ops.alert'];
const BOT_VALID = ['delivery.tg', 'delivery.tg-ops', 'delivery.buy', 'position.opened', 'exit.leg', 'position.closed', 'bot.heartbeat', 'bot.contract_violation'];

const sha256File = (p: string): string => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ---------------------------------------------------------------------------------------------------------------------------------
// valid and invalid fixtures
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(NO_FIXTURES)('contract v1 validators: fixtures', () => {
  it('every valid fixture (one per event type) is ok and its unknown keys are dropped', () => {
    for (const name of ENGINE_VALID) {
      const fixture = readJson(`valid/${name}.json`);
      expect(JSON.stringify(fixture), `${name} must carry unknown keys`).toContain('x_unknown');
      const r = validateEngineToBot(fixture, NOW);
      expect(r.ok, `${name}: ${r.ok ? '' : r.reason}`).toBe(true);
      if (r.ok) {
        expect(JSON.stringify(r.value), `${name} keeps no unknown key`).not.toContain('x_unknown');
        expect(r.value, name).toEqual(stripUnknown(fixture));
      }
    }
    for (const name of BOT_VALID) {
      const fixture = readJson(`valid/${name}.json`);
      const batch = validateBotBatch({ events: [fixture] }, NOW);
      expect(batch.ok, name).toBe(true);
      if (batch.ok) {
        const r = batch.events[0].result;
        expect(r.ok, `${name}: ${r.ok ? '' : r.reason}`).toBe(true);
        if (r.ok) {
          expect(JSON.stringify(r.value), `${name} keeps no unknown key`).not.toContain('x_unknown');
          expect(r.value, name).toEqual(stripUnknown(fixture));
        }
      }
    }
    // the five Engine types and the seven bot types are all covered (delivery.tg has a second, ops, fixture; signal.new a second, A-115 detail, fixture)
    expect(ENGINE_VALID.length + BOT_VALID.length - 2).toBe(5 + 7);
  });

  it('each invariant violation fixture is refused with the stated status and code', () => {
    const cases = runInvalid('invariant');
    expect(cases.length, 'one invalid fixture per invariant').toBeGreaterThanOrEqual(60);
    for (const c of cases) {
      expect(c.verdict.ok, `${c.name} must be refused`).toBe(false);
      expect({ status: c.verdict.status, code: c.verdict.code }, `${c.name}: ${c.fx.description} (${c.verdict.reason})`).toEqual(c.fx.expect);
    }
    // the named invariants of the acceptance row are among them
    const names = new Set(cases.map(c => c.name));
    for (const n of ['sourced-value-null-as-of-set', 'priced-after-recorded', 'version-2', 'event-id-not-ulid', 'ca-null-on-signal-new', 'labels-65', 'line-80', 'price-zero', 'decided-minus-priced-30001']) {
      expect(names.has(n), n).toBe(true);
    }
  });

  it('emitted_at = now + 5001 is a 400 clock; now + 5000 is accepted', () => {
    const cases = runInvalid('clock');
    expect(cases.length).toBeGreaterThanOrEqual(2);
    for (const c of cases) expect({ ok: c.verdict.ok, status: c.verdict.status, code: c.verdict.code }, c.name).toEqual({ ok: false, status: 400, code: 'clock' });
    const signal = readJson('valid/signal.new.json');
    // the decision times of a signal.new must not be after emitted_at, so the boundary is tested on an event without payload time rules
    const alert = readJson('valid/alert.exit.json');
    alert.emitted_at = NOW + 5000;
    expect(validateEngineToBot(alert, NOW).ok).toBe(true);
    alert.emitted_at = NOW + 5001;
    const refused = validateEngineToBot(alert, NOW);
    expect(refused.ok === false && refused.code).toBe('clock');
    // a signal.new whose times all move with emitted_at stays valid at the boundary
    signal.emitted_at = NOW + 5000;
    expect(validateEngineToBot(signal, NOW).ok).toBe(true);
  });

  it('a signal.new replay older than 10 minutes is a 400 clock (and the other TTLs hold)', () => {
    const cases = runInvalid('ttl');
    expect(cases.map(c => c.name)).toEqual(expect.arrayContaining(['signal-new-replay-older-than-10-min', 'alert-exit-older-than-120-s']));
    for (const c of cases) expect({ ok: c.verdict.ok, status: c.verdict.status, code: c.verdict.code }, c.name).toEqual({ ok: false, status: 400, code: 'clock' });
    const signal = readJson('valid/signal.new.json');
    expect(validateEngineToBot(signal, signal.emitted_at + 600000).ok, 'exactly at the TTL').toBe(true);
    const late = validateEngineToBot(signal, signal.emitted_at + 600001);
    expect(late.ok === false && `${late.status} ${late.code}`).toBe('400 clock');
    const arms = readJson('valid/arms.status.json');
    expect(validateEngineToBot(arms, arms.emitted_at + 10 * 86_400_000).ok, 'arms.status has no TTL (latest wins)').toBe(true);
  });
});

describe('contract v1 validators: free text and secrets', () => {
  const uuid = ['0f8fad5b', 'd9cb', '469f', 'a165', '70867728950e'].join('-');                                  // a fake UUID, built at runtime for the secret scan
  const rpcError = `All RPCs failed for sendTransaction: https://mainnet.helius-rpc.com/?api-key=${uuid}: 429`;
  const tgToken = `123456789:${'ab_'.repeat(11)}xy`;                                                           // 9 digits : 35 chars, underscores included
  const byteArray = JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256));
  const sig88 = '5'.repeat(44) + 'K'.repeat(44);

  function botEvents(name: string, payloadPatch: Record<string, unknown>): Json {
    const ev = readJson(`valid/${name}.json`);
    Object.assign(ev.payload, payloadPatch);
    return ev;
  }
  function accepted(ev: Json): Json {
    const b = validateBotBatch({ events: [ev] }, NOW);
    expect(b.ok).toBe(true);
    const r = (b as Extract<BatchValidation, { ok: true }>).events[0].result;
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    return r.ok ? r.value : null;
  }

  it.skipIf(NO_FIXTURES)('planted secrets do not survive in the bot free-text fields; a transaction signature does', () => {
    const planted = `${rpcError} ${tgToken} ${byteArray}`;
    const fields: Array<[string, string]> = [
      ['delivery.buy', 'error'], ['exit.leg', 'error'], ['bot.contract_violation', 'detail'], ['delivery.tg', 'error'],
    ];
    for (const [type, field] of fields) {
      const out = accepted(botEvents(type, { [field]: planted }));
      const text = String(out.payload[field]);
      expect(text, `${type}.${field}`).not.toContain(uuid);
      expect(text, `${type}.${field}`).not.toContain(tgToken);
      expect(text, `${type}.${field}: the token with its underscores removed (redaction must run before mdSafe)`).not.toContain('ab'.repeat(11) + 'xy');
      expect(text, `${type}.${field}`).not.toContain('11,48,85,122');            // the first entries of the byte array
      expect(text, `${type}.${field}`).not.toMatch(/\d+,\d+,\d+,\d+,\d+,\d+/);
      expect(text, `${type}.${field}`).toContain('429');                         // the rest of the message is kept
    }
    // a transaction signature (88 base58 chars) is not a secret: it passes through unchanged
    for (const [type, field] of fields) {
      const message = `sendTransaction failed, signature ${sig88} not confirmed`;
      const out = accepted(botEvents(type, { [field]: message }));
      expect(out.payload[field], `${type}.${field}`).toBe(message);
    }
    // lengths: 200 for the three errors, 300 for the contract violation detail
    expect(String(accepted(botEvents('delivery.buy', { error: 'e'.repeat(500) })).payload.error)).toHaveLength(200);
    expect(String(accepted(botEvents('exit.leg', { error: 'e'.repeat(500) })).payload.error)).toHaveLength(200);
    expect(String(accepted(botEvents('delivery.tg', { error: 'e'.repeat(500) })).payload.error)).toHaveLength(200);
    expect(String(accepted(botEvents('bot.contract_violation', { detail: 'e'.repeat(500) })).payload.detail)).toHaveLength(300);
  });

  it.skipIf(NO_FIXTURES)('ops.alert: the valid fixture has a null ca and signal_id; the three invalid fixtures are refused', () => {
    const fixture = readJson('valid/ops.alert.json');
    expect(fixture.ca).toBeNull();
    expect(fixture.signal_id).toBeNull();
    const r = validateEngineToBot(fixture, NOW);
    expect(r.ok).toBe(true);
    const cases = runInvalid('ops');
    expect(cases.map(c => c.name)).toEqual(expect.arrayContaining(['ops-cleared-before-since', 'ops-text-301-chars', 'ops-severity-info']));
    for (const c of cases) expect({ ok: c.verdict.ok, status: c.verdict.status, code: c.verdict.code }, `${c.name}: ${c.verdict.reason}`).toEqual({ ok: false, status: 400, code: 'invalid' });
    // the text is cleaned with mdSafe: markdown characters go, 300 chars are fine
    const ev = readJson('valid/ops.alert.json');
    ev.payload.text = '*peer* gmgn_client [seen]';
    const cleaned = validateEngineToBot(ev, NOW);
    expect(cleaned.ok && (cleaned.value.payload as { text: string }).text).toBe('peer gmgnclient seen');
    ev.payload.text = 'a'.repeat(300);
    expect(validateEngineToBot(ev, NOW).ok).toBe(true);
    ev.payload.cleared_at = ev.payload.since;
    expect(validateEngineToBot(ev, NOW).ok, 'cleared_at equal to since is fine').toBe(true);
  });

  it('mdSafe strips markdown, control and bidi characters, collapses blanks and caps by code points', () => {
    expect(mdSafe('*MOON*_[V2]`', 64)).toBe('MOONV2');
    expect(mdSafe('a\nb\tc', 64)).toBe('a b c');
    expect(mdSafe('  spaced   out  ', 64)).toBe('spaced out');
    expect(mdSafe('N'.repeat(500), 64)).toHaveLength(64);
    expect(mdSafe('x' + String.fromCharCode(0x202e) + 'y' + String.fromCharCode(0x0007) + 'z', 64)).toBe('xyz');
    expect(mdSafe('ab' + String.fromCharCode(0xd83d) + 'cd', 64)).toBe('abcd');              // a lone surrogate goes
    const pair = String.fromCodePoint(0x1f680);
    expect(mdSafe(pair.repeat(5), 3)).toBe(pair.repeat(3));                                    // never splits a surrogate pair
    expect(mdSafe(null as unknown as string, 64)).toBe('');
    expect(mdSafe(42 as unknown as string, 64)).toBe('42');
    expect(mdSafe({} as unknown as string, 64)).toBe('');
  });

  it.skipIf(NO_FIXTURES)('name and symbol of a signal.new pass mdSafe (64 and 16 chars)', () => {
    const ev = readJson('valid/signal.new.json');
    ev.payload.token.name = '*Big* ' + 'N'.repeat(100);
    ev.payload.token.symbol = '[$S_Y_M]' + 'Y'.repeat(40);
    const r = validateEngineToBot(ev, NOW);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.type === 'signal.new') {
      expect(Array.from(r.value.payload.token.name ?? '')).toHaveLength(64);
      expect(r.value.payload.token.name?.startsWith('Big NNN')).toBe(true);
      expect(Array.from(r.value.payload.token.symbol ?? '')).toHaveLength(16);
      expect(r.value.payload.token.symbol?.startsWith('$SYMYYY')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// batch and token proxy
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(NO_FIXTURES)('contract v1 validators: bot batch and token proxy', () => {
  const botEvent = (name: string): Json => readJson(`valid/${name}.json`);

  it('a batch of 5 with an invalid event at index 3: the other four are ok; a non-array body is a whole-batch 400; v 2 is a whole-batch 409', () => {
    const bad = botEvent('exit.leg');
    bad.payload.fraction_of_original = 1.2;
    const events = [botEvent('delivery.tg'), botEvent('delivery.buy'), botEvent('position.opened'), bad, botEvent('position.closed')];
    const r = validateBotBatch({ events }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.events.map(e => e.index)).toEqual([0, 1, 2, 3, 4]);
      expect(r.events.map(e => e.result.ok)).toEqual([true, true, true, false, true]);
      const third = r.events[3].result;
      expect(third.ok === false && { status: third.status, code: third.code }).toEqual({ status: 400, code: 'invalid' });
    }
    for (const body of [null, undefined, 'x', 42, [], [botEvent('delivery.tg')], {}, { events: 'x' }, { events: {} }, { events: [] }]) {
      const w = validateBotBatch(body, NOW);
      expect(w.ok === false && { status: w.status, code: w.code }, JSON.stringify(body)).toEqual({ status: 400, code: 'invalid' });
    }
    const v2 = botEvent('position.closed');
    v2.v = 2;
    const wrongVersion = validateBotBatch({ events: [botEvent('delivery.tg'), v2] }, NOW);
    expect(wrongVersion.ok === false && { status: wrongVersion.status, code: wrongVersion.code }).toEqual({ status: 409, code: 'contract_version' });
    expect(wrongVersion.ok === false && wrongVersion.reason).toContain('supported:[1]');
    // 1 to 50 events: 50 are fine, 51 are not
    const fifty = Array.from({ length: 50 }, () => botEvent('delivery.tg'));
    expect(validateBotBatch({ events: fifty }, NOW).ok).toBe(true);
    expect(validateBotBatch({ events: [...fifty, botEvent('delivery.tg')] }, NOW).ok).toBe(false);
    // at most 262144 bytes
    const heavy = botEvent('bot.contract_violation');
    heavy.payload.x_unknown_blob = 'z'.repeat(270000);
    const tooBig = validateBotBatch({ events: [heavy] }, NOW);
    expect(tooBig.ok === false && tooBig.status).toBe(400);
    // an element that is not an object is reported per index, it does not reject the batch
    const mixed = validateBotBatch({ events: [botEvent('delivery.tg'), null, 'x'] }, NOW);
    expect(mixed.ok && mixed.events.map(e => e.result.ok)).toEqual([true, false, false]);
    // an Engine-to-bot type is not valid in the bot batch
    const wrongWay = validateBotBatch({ events: [readJson('valid/signal.new.json')] }, NOW);
    expect(wrongWay.ok && wrongWay.events[0].result.ok).toBe(false);
  });

  it('validateTokenProxyResponse: a valid fixture passes; a non-ProxyFieldKey field and a broken Sourced are 400', () => {
    const fixture = readJson('valid/token-proxy-response.json');
    const r = validateTokenProxyResponse(fixture);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (r.ok) expect(r.value).toEqual(stripUnknown(fixture));
    const cases = runInvalid('proxy');
    expect(cases.length).toBeGreaterThanOrEqual(5);
    for (const c of cases) expect({ ok: c.verdict.ok, status: c.verdict.status, code: c.verdict.code }, `${c.name}: ${c.verdict.reason}`).toEqual({ ok: false, status: 400, code: 'invalid' });
    const clean = JSON.parse(JSON.stringify(fixture));
    clean.fields.symbol.value = '*MOON*';
    const cleaned = validateTokenProxyResponse(clean);
    expect(cleaned.ok && cleaned.value.fields.symbol?.value).toBe('MOON');
  });

  it('the identity tests cover every file of this package: each has a byte-identical copy in the Engine and the TG Bot', () => {
    const files = ['contract/validate.ts', 'link-auth.ts', 'redact.ts', 'exit-policy/exit-policy.ts', 'exit-policy/exit-policies.json', 'card/render-signal.ts'];
    for (const rel of files) {
      const source = path.join(ROOT, 'shared', ...rel.split('/'));
      expect(fs.existsSync(source), `shared/${rel} exists`).toBe(true);
      const sha = sha256File(source);
      expect(sha256File(path.join(ROOT, 'Engine', 'src', 'shared', ...rel.split('/'))), `Engine copy of ${rel}`).toBe(sha);
      expect(sha256File(path.join(ROOT, 'TG Bot', 'src', 'shared', ...rel.split('/'))), `TG Bot copy of ${rel}`).toBe(sha);
    }
    // the shared redaction module names the providers it masks and none of the two strings the guards keep out of the shared files
    const redactText = fs.readFileSync(path.join(ROOT, 'shared', 'redact.ts'), 'utf8');
    expect(redactText).not.toContain(['X', 'APIKEY'].join('-'));
    expect(redactText).not.toContain(['openapi', 'gmgn', 'ai'].join('.'));
  });

  it('the validators never mutate their input and never let an own __proto__ key through', () => {
    const fixture = readJson('valid/signal.new.json');
    const copy = JSON.stringify(fixture);
    validateEngineToBot(fixture, NOW);
    expect(JSON.stringify(fixture)).toBe(copy);
    const hostile = JSON.parse(JSON.stringify(readJson('valid/bot.heartbeat.json')).replace('"policy_versions":{', '"policy_versions":{"__proto__":"x",'));
    const r = validateBotBatch({ events: [hostile] }, NOW);
    expect(r.ok && r.events[0].result.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// A-115: the optional signal.new detail
// ---------------------------------------------------------------------------------------------------------------------------------
describe.skipIf(NO_FIXTURES)('signal.new detail (A-115)', () => {
  it('CARD-T15 a payload with and without detail validates; an invalid detail is dropped and the signal kept; an older validator drops it', () => {
    const withDetail = readJson('valid/signal.new.detail.json');
    const r = validateEngineToBot(withDetail, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.type !== 'signal.new') return;
    expect(r.value.payload.detail).toEqual(stripUnknown(withDetail.payload.detail));
    expect(signalDetailDropped(withDetail, r.value.payload)).toBe(false);
    // an absent detail is valid (an older Engine), and nothing is reported
    const without = readJson('valid/signal.new.json');
    const r0 = validateEngineToBot(without, NOW);
    expect(r0.ok && r0.value.type === 'signal.new' && r0.value.payload.detail === undefined).toBe(true);
    if (r0.ok && r0.value.type === 'signal.new') expect(signalDetailDropped(without, r0.value.payload)).toBe(false);
    // every invalid detail is dropped; the signal itself stays valid and unchanged
    const bad: Array<(d: Json) => void> = [
      d => { d.cluster.kol = d.cluster.wallets + 1; },
      d => { d.cluster.wallets = -1; },
      d => { d.cluster.wallets = 1.5; },
      d => { d.score.terms = [{ term: 'model', points: 3 }]; },
      d => { d.score.terms = [{ term: 'cluster', points: 101 }]; },
      d => { d.score.terms = Array.from({ length: 9 }, () => ({ term: 'cluster', points: 1 })); },
      d => { d.score.data_gaps = ['x'.repeat(33)]; },
      d => { d.score.data_gaps = Array.from({ length: 17 }, () => 'g'); },
      d => { d.burst = { value: 0.3, src: null, as_of: 1 }; },
      d => { d.vol_24h_usd = { value: 'big', src: 'gmgn.token_info', as_of: 1 }; },
      d => { d.score.eligible = 'yes'; },
      d => { delete d.cluster; },
    ];
    const expectedRest = (() => { const x = JSON.parse(JSON.stringify(r.value.payload)); delete x.detail; return x; })();
    for (const [i, edit] of bad.entries()) {
      const ev = JSON.parse(JSON.stringify(withDetail));
      edit(ev.payload.detail);
      const rb = validateEngineToBot(ev, NOW);
      expect(rb.ok, `case ${i}`).toBe(true);
      if (!rb.ok || rb.value.type !== 'signal.new') continue;
      expect(rb.value.payload.detail, `case ${i}`).toBeUndefined();
      expect(rb.value.payload, `case ${i}`).toEqual(expectedRest);
      expect(signalDetailDropped(ev, rb.value.payload), `case ${i}`).toBe(true);
    }
    expect(parseSignalDetail('not an object')).toBeNull();
    // an older validator (no detail parse) keeps known keys only: the same event without the detail gives the same payload
    const older = JSON.parse(JSON.stringify(withDetail));
    delete older.payload.detail;
    const ro = validateEngineToBot(older, NOW);
    expect(ro.ok && ro.value.payload).toEqual(expectedRest);
  });
});
