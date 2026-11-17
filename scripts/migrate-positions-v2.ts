/**
 * migrate-positions-v2.ts (B50 section 3, plan grind #46 + #62): the old bot's open positions and active limit orders become
 * `PositionV2` / `ManualOrderV2` records, so the B30 exit engine manages them after the cutover.
 *
 *   npm run cli ...  or  node ./node_modules/tsx/dist/cli.mjs scripts/migrate-positions-v2.ts --from <BOT_DATA_DIR> [selection] [--execute]
 *
 *   --from <abs>            REQUIRED. The bot data folder (the live one named by cutover-state.json, never a default).
 *   --state <file>          cutover-state.json: the positions the user chose "migrate" for (see parseCutoverState for the shapes read).
 *   --migrate <ca>:<wallet> a position to migrate (repeatable); --migrate-all selects every open position.
 *   --owner <wallet>=<addr> the wallet address of a wallet id when positions.json does not carry `ownerAddress` (repeatable).
 *   --execute               write. Without it the run is a DRY RUN: it reads the two legacy files and the chain, prints each source
 *                           record next to its target record, and writes nothing (not even the manifest).
 *
 * Exit codes: 0 = ok (a dry run included), 1 = refused (nothing was written), 2 = usage or environment error.
 *
 * WHAT IS MIGRATED. For every `positions.json[ca].wallets[walletId]` with a non-zero `tokenAmount` that was selected, and only after the
 * chain still shows the wallet holding that mint (RPC `getAllSplBalances`; an unreadable scan or a confirmed zero skips the record, with
 * the reason printed): a `PositionV2` with origin 'manual', signal_id null, policy_id 'MANUAL', policy_version/arm null, `entry.tx` = the
 * first tx signature of the record (else null), `entry.sol_spent_lamports` from `entryAmountSol`, fill_source 'unverified',
 * original_tokens = tokens = tokenAmount (when the chain holds LESS, the chain amount, with the entry cost scaled the same way, as the
 * old reconcile lane did), `basis_sol_per_token = entryAmountSol / tokenAmount` when both are known and > 0 (so every trigger stays
 * relative to the real entry; else null and the first quote becomes the basis), peak_multiple 1, legs_done [], and the ATA read from the
 * chain. For every `active` order of a migrated position: a `ManualOrderV2` copying type, triggerPct (trigger_pct), expiresAt
 * (expires_at) and baselineMulti (baseline_multi) UNCHANGED, plus the sell percentage (`balance`), the TSL activation level
 * (`armAfterPct`), the TSL peak (`highestMultiplier`, which lives in baseline-relative space like peak_rel) and the TP failure count.
 * Presets are never applied. An order of an unknown type (or with a number the exit engine cannot use) REFUSES the whole run and the
 * refusal names the order.
 *
 * IDEMPOTENT. A run that finds migrated records (`mig_` position ids) in positions-v2.json refuses to write (B6-T11). Orders are written
 * first and the positions last, so a crash in between leaves no migrated position and the run can simply be repeated. Both files are
 * written atomically (temp file + fsync + rename); a sha256 manifest of the two inputs and the two outputs is written next to them.
 * No key material is read or printed (positions.json holds public addresses only).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ManualOrderV2, PositionV2 } from '../src/bot-contracts';
import { systemClock } from '../src/link/clock';
import { writeFileAtomicSync } from '../src/link/atomic-file';
import { deriveAta } from '../src/execution/exec-common';
import { createPositionsStore, MANUAL_ORDERS_FILE, POSITIONS_FILE, PositionsStoreError } from '../src/exits/positions-store';
import type { StoredManualOrder } from '../src/exits/manual-orders';

export const LEGACY_POSITIONS_FILE = 'positions.json';
export const LEGACY_ORDERS_FILE = 'orders.json';
export const MANIFEST_FILE = 'migrate-positions-v2.manifest.json';
export const MIGRATED_PREFIX = 'mig_';
const ORDER_TYPES: readonly string[] = ['tp', 'sl', 'tsl'];

// ---------------------------------------------------------------------------------------------------------------------------------
// the choices of cutover-state.json
// ---------------------------------------------------------------------------------------------------------------------------------

export type Choice = 'sell' | 'migrate' | 'leave';
export interface ChoiceEntry { choice: Choice; ack: string | null }
export interface CutoverState {
  /** The bot data folder named by the state file, or null. */
  botDataDir: string | null;
  /** Keyed `<ca>:<walletId>`, or `<ca>:*` for every wallet of a CA. */
  choices: Map<string, ChoiceEntry>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function toChoice(v: unknown): Choice | null {
  const s = (str(v) ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (s === 'a' || s === 'sell' || s === 'sellfirst' || s === 'sellbefore') return 'sell';
  if (s === 'b' || s === 'migrate' || s === 'migrated') return 'migrate';
  if (s === 'c' || s === 'leave' || s === 'unmanaged' || s === 'leaveunmanaged') return 'leave';
  return null;
}

/**
 * Reads the per-position choices of cutover-state.json (plan grind #62: (a) sell before the cutover, (b) migrate it, (c) leave it
 * unmanaged with a written acknowledgement). The file is written by the cutover script (R5-CUT), whose exact layout is not frozen, so
 * this reader accepts the obvious shapes: `positions` (or `positionChoices`, `choices`) as an object keyed `<ca>:<walletId>` / `<ca>`,
 * or as an array of `{ ca, wallet_id|walletId|wallet, choice|decision, ack|acknowledgement|note }`; a value may be the choice word
 * alone. `botDataDir` (or `BOT_DATA_DIR`, `dataDir`) names the folder. Anything it cannot read is ignored, never guessed.
 */
export function parseCutoverState(json: unknown): CutoverState {
  const out: CutoverState = { botDataDir: null, choices: new Map() };
  if (!isObj(json)) return out;
  out.botDataDir = str(json.botDataDir) ?? str(json.BOT_DATA_DIR) ?? str(json.dataDir);
  const src = json.positions ?? json.positionChoices ?? json.choices;
  const put = (ca: string | null, wallet: string | null, v: unknown): void => {
    if (ca === null) return;
    let choice: Choice | null;
    let ack: string | null = null;
    if (isObj(v)) {
      choice = toChoice(v.choice ?? v.decision ?? v.action);
      ack = str(v.ack) ?? str(v.acknowledgement) ?? str(v.acknowledged) ?? str(v.note);
    } else {
      choice = toChoice(v);
    }
    if (choice !== null) out.choices.set(`${ca}:${wallet ?? '*'}`, { choice, ack });
  };
  if (Array.isArray(src)) {
    for (const e of src) if (isObj(e)) put(str(e.ca), str(e.wallet_id) ?? str(e.walletId) ?? str(e.wallet), e);
  } else if (isObj(src)) {
    for (const [k, v] of Object.entries(src)) {
      const i = k.indexOf(':');
      if (i > 0) put(k.slice(0, i), k.slice(i + 1) || null, v);
      else put(k, null, v);
    }
  }
  return out;
}

/** The choice recorded for (ca, wallet): the exact key first, then the CA-wide one. */
export function choiceFor(s: CutoverState | null, ca: string, walletId: string): ChoiceEntry | null {
  if (s === null) return null;
  return s.choices.get(`${ca}:${walletId}`) ?? s.choices.get(`${ca}:*`) ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// legacy records
// ---------------------------------------------------------------------------------------------------------------------------------

export interface LegacyOpen {
  ca: string;
  walletId: string;
  name: string | null;
  ticker: string | null;
  tokenAmount: number;
  entryAmountSol: number | null;
  entryTs: number | null;
  txSigs: string[];
  ownerAddress: string | null;
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Every (ca, wallet) of positions.json with a non-zero tokenAmount. A record that is not an object is skipped. */
export function readLegacyOpen(positions: unknown): LegacyOpen[] {
  const out: LegacyOpen[] = [];
  if (!isObj(positions)) return out;
  for (const [ca, p] of Object.entries(positions)) {
    if (!isObj(p) || !isObj(p.wallets)) continue;
    for (const [walletId, pw] of Object.entries(p.wallets)) {
      if (!isObj(pw)) continue;
      const tokens = finite(pw.tokenAmount);
      if (tokens === null || !(tokens > 0)) continue;
      const entry = finite(pw.entryAmountSol);
      out.push({
        ca, walletId, name: str(p.name), ticker: str(p.ticker), tokenAmount: Math.floor(tokens),
        entryAmountSol: entry !== null && entry > 0 ? entry : null,
        entryTs: finite(pw.entryTs),
        txSigs: Array.isArray(pw.txSigs) ? pw.txSigs.filter((s): s is string => typeof s === 'string' && s !== '') : [],
        ownerAddress: str(pw.ownerAddress),
      });
    }
  }
  return out;
}

export function migratedPositionId(ca: string, walletId: string): string {
  return MIGRATED_PREFIX + createHash('sha256').update(`migrated:${ca}:${walletId}`, 'utf8').digest('hex').slice(0, 24);
}

const lamportsOf = (sol: number): string => BigInt(Math.round(sol * 1e9)).toString();
const shortCa = (ca: string): string => (ca.length > 12 ? `${ca.slice(0, 6)}..${ca.slice(-4)}` : ca);

export interface OrderRefusal { orderId: string; ca: string; type: string; reason: string }

/** The active orders of (ca, wallet) as ManualOrderV2 records, or the refusals that name the orders that cannot be copied faithfully. */
export function convertOrders(
  orders: unknown, ca: string, walletId: string, positionId: string, now: number,
): { orders: StoredManualOrder[]; refusals: OrderRefusal[] } {
  const out: StoredManualOrder[] = [];
  const refusals: OrderRefusal[] = [];
  const list = isObj(orders) && Array.isArray(orders[ca]) ? (orders[ca] as unknown[]) : [];
  for (const raw of list) {
    if (!isObj(raw) || raw.active !== true || raw.walletId !== walletId) continue;
    const id = str(raw.id) ?? '(no id)';
    const type = typeof raw.type === 'string' ? raw.type : String(raw.type);
    const refuse = (reason: string): void => { refusals.push({ orderId: id, ca, type, reason }); };
    if (!ORDER_TYPES.includes(type)) { refuse(`unknown order type "${type.slice(0, 20)}"`); continue; }
    const trig = finite(raw.triggerPct);
    if (trig === null) { refuse('triggerPct is not a number'); continue; }
    if (raw.balance !== undefined && raw.balance !== null && !(finite(raw.balance) !== null && (raw.balance as number) > 0 && (raw.balance as number) <= 100)) {
      refuse('balance (the sell percentage) is not between 0 and 100'); continue;
    }
    if (raw.id === undefined || str(raw.id) === null) { refuse('the order has no id'); continue; }
    const baseline = finite(raw.baselineMulti);
    const expires = finite(raw.expiresAt);
    const arm = finite(raw.armAfterPct);
    const peak = type === 'tsl' ? finite(raw.highestMultiplier) : null;
    const failed = finite(raw.failedAttempts);
    const o: StoredManualOrder = {
      order_id: id, position_id: positionId, ca, wallet_id: walletId, type: type as 'tp' | 'sl' | 'tsl', trigger_pct: trig,
      baseline_multi: baseline !== null && baseline > 0 ? baseline : null,
      peak_rel: peak !== null && peak > 0 ? peak : null,
      expires_at: expires,
      active: true,
      attempts: failed !== null && failed > 0 ? Math.floor(failed) : 0,
      created_at: finite(raw.createdAt) ?? now,
      source: 'migrated',
    };
    if (raw.balance !== undefined && raw.balance !== null) o.sell_pct = raw.balance as number;
    if (arm !== null) o.arm_after_pct = arm;
    out.push(o);
  }
  return { orders: out, refusals };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------------------------------------------------------------

export interface RpcLike { call(method: string, params: unknown[]): Promise<any> }

export interface MigrateOptions {
  /** BOT_DATA_DIR. */
  from: string;
  execute: boolean;
  /** `all` selects every open position; otherwise the `<ca>:<walletId>` keys. */
  select: 'all' | ReadonlySet<string>;
  /** The state file's choices, used to select the positions the user chose "migrate" for. */
  state?: CutoverState | null;
  /** walletId -> address for records without `ownerAddress`. */
  owners?: Readonly<Record<string, string>>;
  now?: () => number;
  /** `getAllSplBalances`: held mints of an owner, null = the scan failed. Default: execution/jupiter.ts. */
  allBalances?: (owner: string) => Promise<Map<string, { rawAtoms: number; decimals: number }> | null>;
  /** JSON-RPC for the ATA lookup. Default: execution/jupiter.ts `resilientRpcCall`. */
  rpc?: RpcLike;
}

export interface PlanItem {
  ca: string;
  walletId: string;
  source: LegacyOpen;
  selected: boolean;
  /** Why this record is not migrated (not selected, wallet unknown, chain says zero ...). */
  skip: string | null;
  position: (PositionV2 & { next_due_at?: number }) | null;
  orders: StoredManualOrder[];
  note: string | null;
}

export interface MigrateResult {
  status: 'dry_run' | 'migrated' | 'refused';
  /** Why the run was refused (empty otherwise). */
  reasons: string[];
  refusals: OrderRefusal[];
  items: PlanItem[];
  /** Files written by this run. */
  written: string[];
}

function readJsonFile(file: string): { present: boolean; value: unknown; error: string | null; raw: Buffer | null } {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return { present: false, value: undefined, error: null, raw: null };
    return { present: true, value: undefined, error: `${path.basename(file)} cannot be read`, raw: null };
  }
  if (raw.toString('utf8').trim() === '') return { present: false, value: undefined, error: null, raw };   // an empty file holds nothing (the store reads it the same way)
  try {
    return { present: true, value: JSON.parse(raw.toString('utf8')), error: null, raw };
  } catch {
    return { present: true, value: undefined, error: `${path.basename(file)} is not valid JSON`, raw };
  }
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function defaultAllBalances(owner: string): ReturnType<NonNullable<MigrateOptions['allBalances']>> {
  const { getAllSplBalances } = await import('../src/execution/jupiter');
  return getAllSplBalances(owner);
}
async function defaultRpc(method: string, params: unknown[]): Promise<any> {
  const { resilientRpcCall } = await import('../src/execution/jupiter');
  return resilientRpcCall(method, params as any[]);
}

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** The ATA of (owner, mint) as the chain has it: the address under the program that owns the account. null = not found or unreadable. */
async function readAta(rpc: RpcLike, owner: string, mint: string): Promise<{ address: string; program: 'token' | 'token2022' } | null> {
  for (const program of ['token2022', 'token'] as const) {
    try {
      const address = deriveAta(owner, mint, program);
      const res = await rpc.call('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
      const v = res?.value;
      if (v && v.owner === (program === 'token' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID)) return { address, program };
    } catch { /* try the other program */ }
  }
  return null;
}

/** Builds the plan (reads the two legacy files and the chain, writes nothing) and, with `execute`, writes it. */
export async function migratePositions(opts: MigrateOptions): Promise<MigrateResult> {
  const now = (opts.now ?? (() => systemClock.now()))();
  const result: MigrateResult = { status: opts.execute ? 'migrated' : 'dry_run', reasons: [], refusals: [], items: [], written: [] };
  const refuse = (why: string): MigrateResult => { result.status = 'refused'; result.reasons.push(why); return result; };

  const posFile = readJsonFile(path.join(opts.from, LEGACY_POSITIONS_FILE));
  if (posFile.error !== null) return refuse(posFile.error);
  const ordFile = readJsonFile(path.join(opts.from, LEGACY_ORDERS_FILE));
  if (ordFile.error !== null) return refuse(ordFile.error);
  const open = readLegacyOpen(posFile.value);

  // idempotency: migrated records already in positions-v2.json
  const v2 = readJsonFile(path.join(opts.from, POSITIONS_FILE));
  if (v2.error !== null) return refuse(`${v2.error}; it was left untouched`);
  if (opts.execute && v2.present) {
    const list = Array.isArray(v2.value) ? v2.value : isObj(v2.value) && Array.isArray(v2.value.positions) ? v2.value.positions : [];
    const have = list.filter((p: unknown) => isObj(p) && typeof p.position_id === 'string' && p.position_id.startsWith(MIGRATED_PREFIX));
    if (have.length > 0) return refuse(`already migrated: ${POSITIONS_FILE} holds ${have.length} migrated record(s); nothing was written`);
  }

  const allBalances = opts.allBalances ?? defaultAllBalances;
  const rpc: RpcLike = opts.rpc ?? { call: defaultRpc };
  const balanceCache = new Map<string, Map<string, { rawAtoms: number; decimals: number }> | null>();
  const select = (ca: string, wid: string): boolean => {
    if (opts.select === 'all') return true;
    if (opts.select.has(`${ca}:${wid}`)) return true;
    const c = choiceFor(opts.state ?? null, ca, wid);
    return c !== null && c.choice === 'migrate';
  };

  for (const src of open) {
    const item: PlanItem = { ca: src.ca, walletId: src.walletId, source: src, selected: select(src.ca, src.walletId), skip: null, position: null, orders: [], note: null };
    result.items.push(item);
    if (!item.selected) { item.skip = 'not selected (stays in positions.json)'; continue; }
    const owner = src.ownerAddress ?? opts.owners?.[src.walletId] ?? null;
    if (owner === null) { item.skip = 'wallet address unknown (positions.json has no ownerAddress; pass --owner <walletId>=<address>)'; continue; }

    // the chain still shows the wallet holding the mint
    if (!balanceCache.has(owner)) {
      let b: Map<string, { rawAtoms: number; decimals: number }> | null = null;
      try { b = await allBalances(owner); } catch { b = null; }
      balanceCache.set(owner, b);
    }
    const held = balanceCache.get(owner) ?? null;
    if (held === null) { item.skip = 'the wallet scan failed (RPC), so the holding cannot be re-checked'; continue; }
    const chain = held.get(src.ca);
    if (!chain || !(chain.rawAtoms > 0)) { item.skip = 'the wallet holds none of it on the chain (sold outside the bot?)'; continue; }

    let tokens = src.tokenAmount;
    let sol = src.entryAmountSol;
    if (chain.rawAtoms < tokens) {
      const ratio = chain.rawAtoms / tokens;
      item.note = `the chain holds ${chain.rawAtoms} of the recorded ${tokens}; migrated at the chain amount`;
      tokens = Math.floor(chain.rawAtoms);
      if (sol !== null) sol *= ratio;
    }
    const positionId = migratedPositionId(src.ca, src.walletId);
    const ata = await readAta(rpc, owner, src.ca);
    const basis = sol !== null && tokens > 0 ? sol / tokens : null;
    item.position = {
      position_id: positionId, signal_id: null, origin: 'manual', dry_run: false, ca: src.ca, wallet_id: src.walletId,
      policy_id: 'MANUAL', policy_version: null, arm: null,
      entry: { tx: src.txSigs[0] ?? null, opened_at: src.entryTs ?? now, sol_spent_lamports: sol !== null ? lamportsOf(sol) : null, tokens_raw: null, fill_source: 'unverified' },
      original_tokens: BigInt(tokens).toString(), tokens: BigInt(tokens).toString(),
      basis_sol_per_token: basis !== null && Number.isFinite(basis) && basis > 0 ? basis : null,
      peak_multiple: 1, legs_done: [], leg_attempts: {}, last_quote: null, lockouts: [], ata,
      next_due_at: now,
    };
    const conv = convertOrders(ordFile.value, src.ca, src.walletId, positionId, now);
    item.orders = conv.orders;
    result.refusals.push(...conv.refusals);
  }

  if (result.refusals.length > 0) {
    result.status = 'refused';
    for (const r of result.refusals) result.reasons.push(`order ${r.orderId} (${r.type} on ${shortCa(r.ca)}) cannot be migrated: ${r.reason}`);
    return result;
  }
  if (!opts.execute) return result;

  const chosen = result.items.filter(i => i.position !== null);
  if (chosen.length === 0) return refuse('nothing to migrate: no selected position passed the chain check');

  // Write: the orders first, the positions last (see the header). The store loads whatever is already there and refuses a corrupt file.
  let store: ReturnType<typeof createPositionsStore>;
  try {
    store = createPositionsStore({ dir: opts.from, clock: { ...systemClock, now: () => now }, policy: { id: 'MANUAL', version: 'migrated' } });
  } catch (e) {
    return refuse(e instanceof PositionsStoreError ? e.message : 'the v2 files cannot be opened');
  }
  for (const it of chosen) for (const o of it.orders) store.putOrder(o);
  for (const it of chosen) store.put(it.position as PositionV2);
  result.written.push(path.join(opts.from, MANUAL_ORDERS_FILE), path.join(opts.from, POSITIONS_FILE));

  const manifest = {
    schema: 1,
    createdAt: now,
    inputs: [LEGACY_POSITIONS_FILE, LEGACY_ORDERS_FILE].map((f, i) => {
      const raw = (i === 0 ? posFile : ordFile).raw;
      return { file: f, present: raw !== null, bytes: raw?.length ?? 0, sha256: raw ? sha256(raw) : null };
    }),
    outputs: [POSITIONS_FILE, MANUAL_ORDERS_FILE].map(f => {
      const raw = fs.readFileSync(path.join(opts.from, f));
      return { file: f, bytes: raw.length, sha256: sha256(raw) };
    }),
    migrated: chosen.map(i => ({ position_id: (i.position as PositionV2).position_id, ca: i.ca, wallet_id: i.walletId, orders: i.orders.map(o => o.order_id) })),
  };
  writeFileAtomicSync(path.join(opts.from, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  result.written.push(path.join(opts.from, MANIFEST_FILE));
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// report and CLI
// ---------------------------------------------------------------------------------------------------------------------------------

/** Each source record next to its target record. Public addresses and signatures only; never key material. */
export function renderReport(r: MigrateResult): string[] {
  const lines: string[] = [];
  lines.push(`migrate-positions-v2: ${r.status}${r.status === 'dry_run' ? ' (nothing is written; pass --execute to write)' : ''}`);
  for (const why of r.reasons) lines.push(`  REFUSED: ${why}`);
  if (r.items.length === 0) lines.push('  no open position in positions.json');
  for (const it of r.items) {
    const s = it.source;
    lines.push(`- ${it.ca} wallet ${it.walletId}${s.ticker ? ` (${s.ticker})` : ''}`);
    lines.push(`    source: tokenAmount=${s.tokenAmount} entryAmountSol=${s.entryAmountSol ?? 'unknown'} entryTs=${s.entryTs ?? 'unknown'} tx=${s.txSigs[0] ?? 'none'} owner=${s.ownerAddress ? shortCa(s.ownerAddress) : 'unknown'}`);
    if (it.position === null) { lines.push(`    target: none - ${it.skip ?? 'not migrated'}`); continue; }
    const p = it.position;
    lines.push(`    target: ${p.position_id} origin=manual policy_id=MANUAL tokens=${p.tokens} basis_sol_per_token=${p.basis_sol_per_token ?? 'null (first quote)'} sol_spent_lamports=${p.entry.sol_spent_lamports ?? 'null'} fill_source=unverified ata=${p.ata ? `${shortCa(p.ata.address)} (${p.ata.program})` : 'not found'}`);
    if (it.note) lines.push(`    note: ${it.note}`);
    for (const o of it.orders) {
      lines.push(`    order ${o.order_id}: ${o.type} trigger_pct=${o.trigger_pct} sell_pct=${o.sell_pct ?? 100} baseline_multi=${o.baseline_multi ?? 'null'} peak_rel=${o.peak_rel ?? 'null'} expires_at=${o.expires_at ?? 'null'}`);
    }
  }
  for (const f of r.written) lines.push(`  wrote ${path.basename(f)}`);
  return lines;
}

interface Cli { from: string | null; state: string | null; migrate: string[]; all: boolean; owners: Record<string, string>; execute: boolean; bad: string | null }

export function parseArgs(argv: readonly string[]): Cli {
  const c: Cli = { from: null, state: null, migrate: [], all: false, owners: {}, execute: false, bad: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | null => (i + 1 < argv.length ? argv[++i] : null);
    if (a === '--from') c.from = next();
    else if (a === '--state') c.state = next();
    else if (a === '--migrate') { const v = next(); if (v) c.migrate.push(v); else c.bad = '--migrate needs <ca>:<walletId>'; }
    else if (a === '--migrate-all') c.all = true;
    else if (a === '--owner') {
      const v = next();
      const i2 = v ? v.indexOf('=') : -1;
      if (v && i2 > 0) c.owners[v.slice(0, i2)] = v.slice(i2 + 1); else c.bad = '--owner needs <walletId>=<address>';
    } else if (a === '--execute') c.execute = true;
    else c.bad = `unknown argument ${a}`;
  }
  return c;
}

export async function main(argv: readonly string[], out: (line: string) => void = console.log): Promise<number> {
  const c = parseArgs(argv);
  if (c.bad !== null) { out(`usage error: ${c.bad}`); return 2; }
  if (c.from === null || !path.isAbsolute(c.from)) { out('usage error: --from <absolute BOT_DATA_DIR> is required (the live data folder; there is no default)'); return 2; }
  if (!fs.existsSync(c.from)) { out(`usage error: ${c.from} does not exist`); return 2; }
  let state: CutoverState | null = null;
  if (c.state !== null) {
    try { state = parseCutoverState(JSON.parse(fs.readFileSync(c.state, 'utf8'))); } catch { out(`usage error: ${c.state} cannot be read as JSON`); return 2; }
  }
  const select: 'all' | Set<string> = c.all ? 'all' : new Set(c.migrate);
  if (c.execute && !c.all && c.migrate.length === 0 && (state === null || ![...state.choices.values()].some(v => v.choice === 'migrate'))) {
    out('REFUSED: --execute needs a selection (--state with positions chosen "migrate", --migrate <ca>:<walletId> or --migrate-all)');
    return 1;
  }
  const r = await migratePositions({ from: c.from, execute: c.execute, select, state, owners: c.owners });
  for (const line of renderReport(r)) out(line);
  return r.status === 'refused' ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error(`migrate-positions-v2 failed: ${(e as Error)?.message ?? e}`); process.exitCode = 2; });
}
