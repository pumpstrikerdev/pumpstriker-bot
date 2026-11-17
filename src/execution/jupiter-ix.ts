/**
 * JUPITER IX — the /swap/v2/build request for a taker, its answer, and the single-attempt wallet fetch (R7-W5, A-104).
 *
 * What moved here from jupiter.ts, unchanged: the answer types (`ApiAccount`, `ApiInstruction`, `BuildResponse`), `toIx`, and the
 * request query (`jupBuildQuery`, the exact parameter order the server path has always sent). jupiter.ts imports them and KEEPS its own
 * HTTP calls, key alternation and retries, so the server bytes do not change (byte-identity goldens pin them).
 *
 * New, for an external payer: `parseBuildResponse` (a strict, fail-closed reading of the answer) and `jupBuildOnce`: ONE attempt with
 * the first key and a 6 s timeout, no retry, no second key, no second tier, so the 12 s budget of the quote route holds. Jupiter's
 * compute-budget instructions and its tip are NOT read into the result (the bot sets its own limit and price, design 7.5); the only
 * instructions that come out are the setup, swap and cleanup ones, and the lookup-table map as Jupiter CLAIMS it (the wallet builder
 * never compiles against it: it reads the tables from the chain and compares).
 *
 * Reads CONFIG.JUPITER_API_KEY and jupUrls() from ../config, and nothing else from the bot. No Ultra/RFQ (`/order` + `/execute` need a
 * second signer), no signing, no sending.
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { CONFIG, jupUrls } from '../config';
import { fetch as httpFetch } from '../lib/http-client';
import { redactSecrets } from '../lib/redact';

// ── answer types (moved from jupiter.ts) ─────────────────────────────────────────────────────
export interface ApiAccount  { pubkey: string; isSigner: boolean; isWritable: boolean }
export interface ApiInstruction { programId: string; accounts: ApiAccount[]; data: string /* base64 */ }
export interface BuildResponse {
  computeBudgetInstructions: ApiInstruction[];
  setupInstructions:         ApiInstruction[];
  swapInstruction:           ApiInstruction;
  cleanupInstruction:        ApiInstruction | null;
  otherInstructions:         ApiInstruction[];
  tipInstruction:            ApiInstruction | null;          // Jupiter's own tip — we ignore it
  addressesByLookupTableAddress: Record<string, string[]> | null;
  blockhashWithMetadata: { blockhash: number[]; lastValidBlockHeight: number };
  // FIX-BUY2 item 2: the quote of the route the answer builds (Jupiter documents these on /swap/v2/build). The server path books the
  // expected output from outAmount and caps the price impact on priceImpactPct (a decimal ratio, "0.001" = 0.1 %). Optional: an answer
  // without them gives no expected output, and no impact (refused when a cap is set).
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  /** The minimum output after slippage. */
  otherAmountThreshold?: string;
  swapMode?: string;
  slippageBps?: number;
  priceImpactPct?: string | number;
}

export function toIx(ix: ApiInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map(a => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

// ── the request ──────────────────────────────────────────────────────────────────────────────
export interface JupBuildRequest {
  /** The user signing the transaction (Jupiter v2 calls it `taker`; v1 called it `userPublicKey`). */
  taker: string;
  inputMint: string;
  outputMint: string;
  /** Input amount in base units: an integer number or a canonical integer string. */
  amount: number | string;
  slippageBps: number;
  /** false skips Jupiter's own wrap/unwrap (the caller then pre-funds the wSOL account). Default true: Jupiter wraps and unwraps. */
  wrapAndUnwrapSol?: boolean;
}

/** The query string of /swap/v2/build, in the order the server path has always sent it. */
export function jupBuildQuery(req: JupBuildRequest): URLSearchParams {
  const qs = new URLSearchParams({
    inputMint: req.inputMint, outputMint: req.outputMint,
    amount: String(req.amount),
    slippageBps: String(req.slippageBps),
    taker: req.taker,
  });
  // Skip Jupiter's auto wrap/unwrap when caller pre-funds wSOL ATA — saves
  // ~10% tx size + ~30-40% compute units. Caller must ensure wSOL balance.
  if (req.wrapAndUnwrapSol === false) qs.set('wrapAndUnwrapSol', 'false');
  return qs;
}

// ── the wallet-side answer ───────────────────────────────────────────────────────────────────
/** What the wallet builder takes from a /swap/v2/build answer. Compute-budget instructions, the tip and any other instruction are dropped. */
export interface WalletBuild {
  setupInstructions: ApiInstruction[];
  swapInstruction: ApiInstruction;
  cleanupInstruction: ApiInstruction | null;
  /** Jupiter's claim of the lookup-table contents; only ever compared with the chain, never compiled against. null = none claimed. */
  addressesByLookupTableAddress: Record<string, string[]> | null;
  /** The quote fields of the answer when it carries them (informational; the disclosed bound is DECODED from the swap instruction). */
  priceImpactPct: string | number | null;
  /** How many instructions the bot dropped from the answer. */
  dropped: { computeBudget: number; other: number; tip: boolean };
}

export type JupBuildErrorKind = 'no-key' | 'http' | 'timeout' | 'network' | 'parse';
export class JupBuildError extends Error {
  readonly kind: JupBuildErrorKind;
  readonly status: number | null;
  constructor(kind: JupBuildErrorKind, message: string, status: number | null = null) {
    super(redactSecrets(message).slice(0, 200));
    this.name = 'JupBuildError';
    this.kind = kind;
    this.status = status;
  }
}

const MAX_IX_ACCOUNTS = 256;
const MAX_IX_DATA_BYTES = 1232;
const MAX_INSTRUCTIONS = 24;
const MAX_TABLES = 16;
const MAX_TABLE_ADDRESSES = 256;
const MAX_ANSWER_CHARS = 1_000_000;

type Obj = Record<string, unknown>;
function bad(what: string): never { throw new JupBuildError('parse', `Jupiter build answer: ${what}`); }
function isObj(x: unknown): x is Obj { return typeof x === 'object' && x !== null && !Array.isArray(x); }
function pubkeyOk(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try { new PublicKey(s); return true; } catch { return false; }
}
function ixOf(x: unknown, what: string): ApiInstruction {
  if (!isObj(x)) return bad(`${what} is not an object`);
  if (!pubkeyOk(x.programId)) return bad(`${what}.programId is not a public key`);
  if (!Array.isArray(x.accounts) || x.accounts.length > MAX_IX_ACCOUNTS) return bad(`${what}.accounts is not a list of at most ${MAX_IX_ACCOUNTS}`);
  const accounts: ApiAccount[] = x.accounts.map((a: unknown, i: number) => {
    if (!isObj(a) || !pubkeyOk(a.pubkey) || typeof a.isSigner !== 'boolean' || typeof a.isWritable !== 'boolean') return bad(`${what}.accounts[${i}] is malformed`);
    return { pubkey: a.pubkey, isSigner: a.isSigner, isWritable: a.isWritable };
  });
  if (typeof x.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(x.data) || x.data.length % 4 !== 0) return bad(`${what}.data is not base64`);
  if (Buffer.from(x.data, 'base64').length > MAX_IX_DATA_BYTES) return bad(`${what}.data is too long`);
  return { programId: x.programId, accounts, data: x.data };
}
function ixListOf(x: unknown, what: string): ApiInstruction[] {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x) || x.length > MAX_INSTRUCTIONS) return bad(`${what} is not a list of at most ${MAX_INSTRUCTIONS}`);
  return x.map((v, i) => ixOf(v, `${what}[${i}]`));
}

/**
 * Fail-closed reading of a /swap/v2/build answer for an external payer. A missing or malformed swap instruction, a malformed
 * instruction anywhere in the setup or cleanup parts, or a malformed table map is a JupBuildError('parse'); nothing is repaired.
 */
export function parseBuildResponse(json: unknown): WalletBuild {
  if (!isObj(json)) return bad('is not an object');
  if (json.swapInstruction === undefined || json.swapInstruction === null) return bad('has no swapInstruction');
  const swapInstruction = ixOf(json.swapInstruction, 'swapInstruction');
  const setupInstructions = ixListOf(json.setupInstructions, 'setupInstructions');
  const cleanupInstruction = json.cleanupInstruction === undefined || json.cleanupInstruction === null ? null : ixOf(json.cleanupInstruction, 'cleanupInstruction');
  let tables: Record<string, string[]> | null = null;
  const t = json.addressesByLookupTableAddress;
  if (t !== undefined && t !== null) {
    if (!isObj(t)) return bad('addressesByLookupTableAddress is not an object');
    const keys = Object.keys(t);
    if (keys.length > MAX_TABLES) return bad('addressesByLookupTableAddress lists too many tables');
    tables = {};
    for (const k of keys) {
      const list = t[k];
      if (!pubkeyOk(k) || !Array.isArray(list) || list.length > MAX_TABLE_ADDRESSES || !list.every(pubkeyOk)) return bad('addressesByLookupTableAddress is malformed');
      tables[k] = list as string[];
    }
  }
  const impact = json.priceImpactPct;
  return {
    setupInstructions, swapInstruction, cleanupInstruction, addressesByLookupTableAddress: tables,
    priceImpactPct: typeof impact === 'string' || typeof impact === 'number' ? impact : null,
    dropped: {
      computeBudget: Array.isArray(json.computeBudgetInstructions) ? json.computeBudgetInstructions.length : 0,
      other: Array.isArray(json.otherInstructions) ? json.otherInstructions.length : 0,
      tip: json.tipInstruction !== undefined && json.tipInstruction !== null,
    },
  };
}

/**
 * The route's own price impact in PERCENT from a `priceImpactPct` field, which Jupiter reports as a fraction ("0.0123" = 1.23 %), so it
 * is multiplied by 100. Absent, empty or unparseable is null; the sign is dropped. (The same rule as jupiter.ts jupiterImpactPct, whose
 * unit jupiter.test.ts pins; a test keeps the two equal.)
 */
export function jupiterBuildImpactPct(b: Pick<WalletBuild, 'priceImpactPct'> | null | undefined): number | null {
  const raw = b?.priceImpactPct;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n) * 100;
}

/** One build attempt: 6 s, no retry (design 7.3). */
export const JUP_BUILD_TIMEOUT_MS = 6_000;

export interface JupBuildOnceOpts {
  /** The HTTP client (default: the process-wide undici client of lib/http-client). Tests pass a local one. */
  fetch?: (url: string, init: { method: 'GET'; headers: Record<string, string>; timeout: number }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  /** Default CONFIG.JUPITER_API_KEY: the FIRST key only; the fallback key is never used here. */
  apiKey?: string;
  /** Default jupUrls().build. */
  buildUrl?: string;
  timeoutMs?: number;
}

/**
 * ONE GET of /swap/v2/build with the first key and a 6 s timeout. No retry, no second key, no second tier, no Ultra. Throws a
 * JupBuildError ('no-key' | 'http' with the status | 'timeout' | 'network' | 'parse'); the message is redacted and at most 200 characters.
 */
export async function jupBuildOnce(req: JupBuildRequest, opts: JupBuildOnceOpts = {}): Promise<WalletBuild> {
  const apiKey = opts.apiKey ?? CONFIG.JUPITER_API_KEY;
  if (!apiKey) throw new JupBuildError('no-key', 'JUPITER_API_KEY missing: required for /swap/v2/build');
  const url = `${opts.buildUrl ?? jupUrls().build}?${jupBuildQuery(req).toString()}`;
  const doFetch = opts.fetch ?? httpFetch;
  const timeout = opts.timeoutMs ?? JUP_BUILD_TIMEOUT_MS;
  let text: string;
  try {
    const r = await doFetch(url, { method: 'GET', headers: { 'x-api-key': apiKey, 'Accept': 'application/json' }, timeout });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new JupBuildError('http', `Jupiter /build ${r.status}: ${body.slice(0, 120)}`, r.status);
    }
    text = await r.text();
  } catch (e) {
    if (e instanceof JupBuildError) throw e;
    const name = (e as { name?: unknown } | null)?.name;
    const msg = String((e as { message?: unknown } | null)?.message ?? e);
    throw new JupBuildError(name === 'TimeoutError' || name === 'AbortError' || /timeout|timed out|aborted/i.test(msg) ? 'timeout' : 'network', `Jupiter /build ${msg}`);
  }
  if (text.length > MAX_ANSWER_CHARS) throw new JupBuildError('parse', 'Jupiter build answer: too large');
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new JupBuildError('parse', 'Jupiter build answer: not JSON'); }
  return parseBuildResponse(json);
}
