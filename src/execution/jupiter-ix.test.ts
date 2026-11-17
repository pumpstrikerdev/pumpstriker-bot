/**
 * R7-W5 (A-104) Jupiter /swap/v2/build pure pieces.
 *
 * The first block is the extraction guard of the SERVER path: jupSwap composes [CU limit, Jupiter's CU instructions, setup, swap, Sender tip,
 * cleanup] against Jupiter's own lookup-table map, and the message must serialize to the bytes recorded before the extraction.
 * Golden format and rules: pumpfun-ix.test.ts (base64 chunks of at most 60 characters plus the sha256; keys only as fixtureKey indices).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { ComputeBudgetProgram, Keypair, MessageV0, SystemProgram, VersionedMessage, VersionedTransaction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ http: vi.fn() }));
vi.mock('../lib/http-client', () => ({ fetch: h.http }));
vi.mock('./blockhash-cache', () => ({ getCachedBlockhash: () => null }));
vi.mock('../logger', () => ({ log: vi.fn(), logOk: vi.fn(), logWarn: vi.fn(), logErr: vi.fn(), logDbg: vi.fn(), setBroadcast: vi.fn(), emitEvent: vi.fn() }));

import { CONFIG } from '../config';
import { jupSwap, jupiterImpactPct } from './jupiter';
import { JUPITER_EXACT_IN_PINS, JUPITER_TAIL_BYTES, JUPITER_V6_PROGRAM_ID } from './ext-verify';
import { jupBuildOnce, jupBuildQuery, JupBuildError, jupiterBuildImpactPct, parseBuildResponse, JUP_BUILD_TIMEOUT_MS } from './jupiter-ix';

const b58 = (bytes: Uint8Array): string => bs58.encode(bytes);
const fixtureKey = (i: number): string => b58(createHash('sha256').update('ps-fixture-' + i).digest());
const signer = Keypair.fromSeed(createHash('sha256').update('ps-fixture-w5-signer').digest());
const OWNER = signer.publicKey.toBase58();

const GOLDEN_DIR = path.resolve(__dirname, '..', '..', 'test-fixtures', 'execution', 'wallet', 'goldens');
const WRITE = process.env.VITEST_WTX_WRITE_GOLDENS === '1';
const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const chunks = (b64: string, n = 60): string[] => { const out: string[] = []; for (let i = 0; i < b64.length; i += n) out.push(b64.slice(i, i + n)); return out; };
function checkGolden(name: string, inputs: Record<string, unknown>, message: Uint8Array): void {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  const b64 = Buffer.from(message).toString('base64');
  if (WRITE) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      _about: 'Server-path golden: the serialized message jupSwap signs on the /swap/v2/build path, recorded before the extraction into jupiter-ix.ts. Keys are fixtureKey(i) indices.',
      case: name, inputs, messageB64: chunks(b64), sha256: sha256Hex(message),
    }, null, 2) + '\n');
    return;
  }
  const g = JSON.parse(fs.readFileSync(file, 'utf8')) as { messageB64: string[]; sha256: string };
  expect(g.messageB64.every((c) => c.length <= 60), `${name}: chunks are at most 60 characters`).toBe(true);
  expect(g.messageB64.join(''), `${name}: message bytes`).toBe(b64);
  expect(g.sha256, `${name}: sha256`).toBe(sha256Hex(message));
}

// ── the /swap/v2/build answer (a stand-in with the real shape: wrap, swap, unwrap, a lookup table) ─────────────────────────────
interface ApiIx { programId: string; accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>; data: string }
const ixOf = (programId: string, accounts: Array<[string, boolean, boolean]>, data: Buffer): ApiIx => ({
  programId, accounts: accounts.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })), data: data.toString('base64'),
});
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const WSOL = 'So11111111111111111111111111111111111111112';
const SYSTEM = SystemProgram.programId.toBase58();
const BLOCKHASH_BYTES = createHash('sha256').update('ps-fixture-w5-blockhash').digest();

function buildAnswer(): Record<string, unknown> {
  const wsolAta = fixtureKey(40);
  const tokenAta = fixtureKey(41);
  const cuPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 });
  const transfer = SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: signer.publicKey, lamports: 50_000_000n });
  const transferData = Buffer.from(transfer.data);
  return {
    computeBudgetInstructions: [ixOf(cuPrice.programId.toBase58(), [], Buffer.from(cuPrice.data))],
    setupInstructions: [
      ixOf(ATA_PROGRAM, [[OWNER, true, true], [wsolAta, false, true], [OWNER, false, false], [WSOL, false, false], [SYSTEM, false, false], [TOKEN, false, false]], Buffer.from([1])),
      ixOf(SYSTEM, [[OWNER, true, true], [wsolAta, false, true]], transferData),
      ixOf(TOKEN, [[wsolAta, false, true]], Buffer.from([17])),
    ],
    swapInstruction: ixOf(fixtureKey(42), [[TOKEN, false, false], [OWNER, true, false], [wsolAta, false, true], [tokenAta, false, true], [fixtureKey(43), false, true], [fixtureKey(44), false, false]], Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9])),
    cleanupInstruction: ixOf(TOKEN, [[wsolAta, false, true], [OWNER, false, true], [OWNER, true, false]], Buffer.from([9])),
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress: { [fixtureKey(45)]: [fixtureKey(43), fixtureKey(44), fixtureKey(46)] },
    blockhashWithMetadata: { blockhash: Array.from(BLOCKHASH_BYTES), lastValidBlockHeight: 777_002 },
  };
}

const saved: Record<string, unknown> = {};
function setConfig(over: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(over)) {
    if (!(k in saved)) saved[k] = (CONFIG as any)[k];
    (CONFIG as any)[k] = v;
  }
}
const res = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
let sent: VersionedTransaction[] = [];
let builds = 0;
/** FIX-BUY: the units the simulation of the Sender transaction reports, and every simulateTransaction call. */
let simUnits = 150_000;
let sims: Array<{ tx: VersionedTransaction; cfg: unknown }> = [];

beforeEach(() => {
  sent = [];
  builds = 0;
  simUnits = 150_000;
  sims = [];
  vi.spyOn(Math, 'random').mockReturnValue(0);   // the Sender tip account is picked with Math.random: pin the first of the table
  h.http.mockReset();
  h.http.mockImplementation(async (url: string, init: { body?: string } = {}) => {
    if (String(url).includes('/swap/v2/build')) { builds++; return res(buildAnswer()); }
    const body = JSON.parse(String(init.body));
    if (body.method === 'simulateTransaction') {
      sims.push({ tx: VersionedTransaction.deserialize(Buffer.from(body.params[0], 'base64')), cfg: body.params[1] });
      return res({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: { err: null, logs: [], accounts: null, unitsConsumed: simUnits, returnData: null } } });
    }
    if (body.method === 'sendTransaction') {
      const tx = VersionedTransaction.deserialize(Buffer.from(body.params[0], 'base64'));
      sent.push(tx);
      return res({ jsonrpc: '2.0', id: body.id, result: b58(tx.signatures[0]) });
    }
    return res({ jsonrpc: '2.0', id: 1, result: { value: [{ confirmationStatus: 'confirmed', err: null }] } });
  });
  setConfig({ JUPITER_API_KEY: b58(createHash('sha256').update('ps-fixture-w5-jupiter-key').digest()), HELIUS_SENDER_URL: 'http://127.0.0.1:9/fast' });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) (CONFIG as any)[k] = v;
  for (const k of Object.keys(saved)) delete saved[k];
});

describe('the server path of /swap/v2/build is unchanged by the extraction', () => {
  it('jupSwap composes the recorded transaction (limit, Jupiter instructions, setup, swap, tip, cleanup, chain-claimed lookup table map)', async () => {
    const quote = { inputMint: WSOL, outputMint: fixtureKey(31), inAmount: '50000000', slippageBps: 300 };
    await jupSwap(signer, quote, true, 100_000, { awaitConfirm: false });
    expect(builds).toBe(1);
    expect(sent).toHaveLength(1);
    checkGolden('server-jupiter-build-tip', { signerSeed: 'sha256("ps-fixture-w5-signer")', blockhash: 'sha256("ps-fixture-w5-blockhash")', call: 'jupSwap(signer, quote {WSOL -> mint 31, 0.05 SOL, 300 bps}, antiMev true, 100000, awaitConfirm false), tip account = first of the table' }, sent[0].message.serialize());
  });

  // FIX-BUY: the limit of the Sender transaction is measured by a simulation; a light route keeps the recorded bytes exactly
  const recorded = (): Buffer => Buffer.from((JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, 'server-jupiter-build-tip.json'), 'utf8')) as { messageB64: string[] }).messageB64.join(''), 'base64');
  const quote = { inputMint: WSOL, outputMint: fixtureKey(31), inAmount: '50000000', slippageBps: 300 };

  it('FIXBUY-T05 a route measured at 150 000 units signs the recorded message byte for byte (limit 200 000, Jupiter\'s price 5 000); the measuring call is one unsigned simulation', async () => {
    simUnits = 150_000;
    await jupSwap(signer, quote, true, 100_000, { awaitConfirm: false });
    expect(sims).toHaveLength(1);
    expect(sims[0].cfg).toEqual({ encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
    expect(sims[0].tx.signatures.every((s) => s.every((b) => b === 0)), 'the simulated transaction is not signed').toBe(true);
    expect(Buffer.from(sent[0].message.serialize()).equals(recorded())).toBe(true);
  });

  it('FIXBUY-T05 a route measured at 400 000 units signs limit 480 000 and price 2 083: the message differs from the recorded one only in those 12 data bytes, at the same fee', async () => {
    simUnits = 400_000;
    await jupSwap(signer, quote, true, 100_000, { awaitConfirm: false });
    expect(sims).toHaveLength(1);
    const now = Buffer.from(sent[0].message.serialize());
    const gold = recorded();
    expect(now.length).toBe(gold.length);
    const diff = [...now].flatMap((b, i) => (b !== gold[i] ? [i] : []));
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.length).toBeLessThanOrEqual(12);
    // writing the new limit and price into the recorded message gives exactly the new bytes: nothing else moved
    const g = VersionedMessage.deserialize(gold) as MessageV0;
    const ixs = g.compiledInstructions.map((ix) => ({ ...ix }));
    expect([ixs[0].data[0], ixs[1].data[0]]).toEqual([2, 3]);
    ixs[0].data = ComputeBudgetProgram.setComputeUnitLimit({ units: 480_000 }).data;
    ixs[1].data = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_083 }).data;
    const patched = new MessageV0({ header: g.header, staticAccountKeys: g.staticAccountKeys, recentBlockhash: g.recentBlockhash, compiledInstructions: ixs, addressTableLookups: g.addressTableLookups });
    expect(Buffer.from(patched.serialize()).equals(now)).toBe(true);
    // the fee: ceil(480 000 x 2 083 / 1e6) = 1 000 lamports = ceil(200 000 x 5 000 / 1e6), the recorded fee
    expect(Math.ceil((480_000 * 2_083) / 1e6)).toBe(1_000);
    expect(Math.ceil((200_000 * 5_000) / 1e6)).toBe(1_000);
  });
});

// ── the pure pieces ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('jupiter-ix', () => {
  const taker = fixtureKey(1);
  const req = { taker, inputMint: WSOL, outputMint: fixtureKey(31), amount: 50_000_000, slippageBps: 300 };

  it('the build query is the one the server path has always sent: parameter order, wrap flag only when off', () => {
    expect(jupBuildQuery(req).toString()).toBe(`inputMint=${WSOL}&outputMint=${fixtureKey(31)}&amount=50000000&slippageBps=300&taker=${taker}`);
    expect(jupBuildQuery({ ...req, amount: '50000000', wrapAndUnwrapSol: true }).toString()).toBe(jupBuildQuery(req).toString());
    expect(jupBuildQuery({ ...req, wrapAndUnwrapSol: false }).toString()).toBe(`${jupBuildQuery(req).toString()}&wrapAndUnwrapSol=false`);
  });

  it('parseBuildResponse keeps setup, swap and cleanup, drops Jupiter compute-budget instructions, tip and others, and refuses anything malformed', () => {
    const answer = buildAnswer();
    const b = parseBuildResponse({ ...answer, priceImpactPct: '0.0123', otherInstructions: [answer.swapInstruction], tipInstruction: answer.swapInstruction });
    expect(b.setupInstructions.length).toBe(3);
    expect(b.swapInstruction.programId).toBe(fixtureKey(42));
    expect((b.cleanupInstruction as ApiIx).programId).toBe(TOKEN);
    expect(b.dropped).toEqual({ computeBudget: 1, other: 1, tip: true });
    expect(Object.keys(b)).not.toContain('computeBudgetInstructions');
    expect(b.addressesByLookupTableAddress).toEqual({ [fixtureKey(45)]: [fixtureKey(43), fixtureKey(44), fixtureKey(46)] });
    expect(jupiterBuildImpactPct(b)).toBeCloseTo(1.23, 10);
    // absent optional parts are empty, not invented
    const minimal = parseBuildResponse({ swapInstruction: answer.swapInstruction });
    expect(minimal).toMatchObject({ setupInstructions: [], cleanupInstruction: null, addressesByLookupTableAddress: null, priceImpactPct: null });
    const swap = answer.swapInstruction as ApiIx;
    const bads: unknown[] = [
      null, [], {}, { swapInstruction: null },
      { swapInstruction: { ...swap, programId: 'not-a-key' } },
      { swapInstruction: { ...swap, data: '***' } },
      { swapInstruction: { ...swap, data: 'AAA' } },                                           // not a multiple of 4
      { swapInstruction: { ...swap, accounts: [{ pubkey: fixtureKey(1), isSigner: 'yes', isWritable: true }] } },
      { swapInstruction: { ...swap, accounts: Array.from({ length: 257 }, () => ({ pubkey: fixtureKey(1), isSigner: false, isWritable: false })) } },
      { swapInstruction: swap, setupInstructions: 'x' },
      { swapInstruction: swap, setupInstructions: [{ programId: fixtureKey(1) }] },
      { swapInstruction: swap, cleanupInstruction: 5 },
      { swapInstruction: swap, addressesByLookupTableAddress: [] },
      { swapInstruction: swap, addressesByLookupTableAddress: { [fixtureKey(45)]: ['nope'] } },
      { swapInstruction: { ...swap, data: Buffer.alloc(1233).toString('base64') } },
    ];
    for (const x of bads) expect(() => parseBuildResponse(x), JSON.stringify(x)?.slice(0, 60)).toThrow(JupBuildError);
    // the impact unit is the server's: a fraction, multiplied by 100, sign dropped
    for (const v of ['0.0123', 0.02, '-0.005', '0', '', 'abc', undefined, null]) expect(jupiterBuildImpactPct({ priceImpactPct: v as never })).toBe(jupiterImpactPct({ priceImpactPct: v }));
  });

  it('jupBuildOnce is ONE attempt with the first key and a 6 s timeout: no retry, no second key, no second tier, no order or execute path', async () => {
    expect(JUP_BUILD_TIMEOUT_MS).toBe(6_000);
    setConfig({ JUPITER_API_KEY_FALLBACK: 'second-key-that-must-never-be-used' });
    const calls: Array<{ url: string; init: any }> = [];
    const fetchOnce = (status: number, body: unknown) => async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
    };
    const first = 'first-key-' + createHash('sha256').update('ps-fixture-w5-first-key').digest('hex').slice(0, 16);

    const ok = await jupBuildOnce(req, { fetch: fetchOnce(200, buildAnswer()), apiKey: first, buildUrl: 'http://127.0.0.1:9/swap/v2/build' });
    expect(ok.swapInstruction.programId).toBe(fixtureKey(42));
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`http://127.0.0.1:9/swap/v2/build?${jupBuildQuery(req).toString()}`);
    expect(calls[0].init).toMatchObject({ method: 'GET', timeout: 6_000, headers: { 'x-api-key': first } });
    expect(calls[0].url).not.toMatch(/\/(order|execute)\b/);

    // a hard error, a rate limit and a server error are each ONE request and one error: the caller falls to another route, not another attempt
    for (const status of [400, 429, 500, 503]) {
      calls.length = 0;
      const e = await jupBuildOnce(req, { fetch: fetchOnce(status, 'nope'), apiKey: first, buildUrl: 'http://127.0.0.1:9/swap/v2/build' }).catch((x) => x);
      expect(e).toBeInstanceOf(JupBuildError);
      expect(e).toMatchObject({ kind: 'http', status });
      expect(calls.length).toBe(1);
      expect(calls[0].init.headers['x-api-key']).toBe(first);
    }
    // no key: no request at all
    calls.length = 0;
    const nokey = await jupBuildOnce(req, { fetch: fetchOnce(200, buildAnswer()), apiKey: '', buildUrl: 'http://127.0.0.1:9/swap/v2/build' }).catch((x) => x);
    expect(nokey).toMatchObject({ kind: 'no-key' });
    expect(calls).toEqual([]);
    // the default key is CONFIG.JUPITER_API_KEY (the first key), the default URL jupUrls().build, the default client the shared one
    calls.length = 0;
    h.http.mockImplementation(async (url: string, init: any) => { calls.push({ url, init }); return res(buildAnswer()); });
    await jupBuildOnce(req);
    expect(calls.length).toBe(1);
    expect(calls[0].init.headers['x-api-key']).toBe(CONFIG.JUPITER_API_KEY);
    expect(calls[0].url.startsWith('https://api.jup.ag/swap/v2/build?')).toBe(true);
    // a timeout and a network error are classified, and a bad answer is a parse error
    const slow = await jupBuildOnce(req, { fetch: async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }, apiKey: first }).catch((x) => x);
    expect(slow).toMatchObject({ kind: 'timeout' });
    const down = await jupBuildOnce(req, { fetch: async () => { throw new Error('connect ECONNREFUSED'); }, apiKey: first }).catch((x) => x);
    expect(down).toMatchObject({ kind: 'network' });
    const junk = await jupBuildOnce(req, { fetch: fetchOnce(200, 'not json'), apiKey: first }).catch((x) => x);
    expect(junk).toMatchObject({ kind: 'parse' });
    // the error text is redacted and short
    const leaky = await jupBuildOnce(req, { fetch: async () => { throw new Error(`failed https://x.example/?api-key=${first} ${'y'.repeat(400)}`); }, apiKey: first }).catch((x) => x);
    expect(String(leaky.message)).not.toContain(first);
    expect(String(leaky.message).length).toBeLessThanOrEqual(200);
  });

  it('the pinned Jupiter layouts are the fixture: Anchor discriminators of exact-in routes only, a 19 byte tail', () => {
    const file = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'test-fixtures', 'execution', 'wallet', 'jupiter-ix-pin.json'), 'utf8')) as {
      program: string; tail: { bytes: number }; variants: Array<{ name: string; discriminator: number[]; minAccounts: number; positions: unknown }>; refusedDiscriminators: Array<{ name: string; discriminator: number[] }>;
    };
    expect(file.program).toBe('jupiter');                      // named in the fixture; the id is the code's constant
    expect(JUPITER_V6_PROGRAM_ID).toBe('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
    expect(file.tail.bytes).toBe(JUPITER_TAIL_BYTES);
    expect(JUPITER_EXACT_IN_PINS).toEqual(file.variants);
    const rule = (name: string): number[] => Array.from(createHash('sha256').update(`global:${name}`).digest().subarray(0, 8));
    for (const v of file.variants) expect(v.discriminator, v.name).toEqual(rule(v.name));
    for (const v of file.refusedDiscriminators) {
      expect(v.discriminator, v.name).toEqual(rule(v.name));
      expect(file.variants.map((x) => x.name)).not.toContain(v.name);
    }
    expect(file.variants.map((v) => v.name)).toEqual(['route', 'shared_accounts_route']);
  });
});
