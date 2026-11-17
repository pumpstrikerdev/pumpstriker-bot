/**
 * manual-buy-journal.ts (A-93f): the in-flight journal of MANUAL buys (the Telegram buy buttons and /buy), the twin of the auto-buy
 * journal (autobuy/pending.ts).
 *
 *   <BOT_DATA_DIR>/manual-buys.json  { v: 1, entries: ManualBuyRecord[] }  written tmp + fsync + rename (link/atomic-file.ts).
 *
 * An entry is appended in the router's onSigned callback, after signing and BEFORE the send (a failed append aborts the send), and
 * removed once the buy is resolved: its fill was read, the chain says it failed, or its blockhash expired with nothing on chain. So a
 * restart, a router error after the send or a fill meta that stays unreadable never leaves landed tokens without a position: the manual
 * trader resolves every entry (at boot too) and opens the position from the real fill or from the wallet balance. While an entry has no
 * position yet it is also the "a buy is still in flight" marker that refuses a second buy of the same token on the same wallet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomicSync } from '../link/atomic-file';
import { normalizeExitPlan, type ExitPlanSnapshot } from './presets';

export const MANUAL_BUYS_FILE = 'manual-buys.json';

export interface ManualBuyRecord {
  sig: string;
  ca: string;
  wallet_id: string;
  owner: string;
  /** SOL the owner asked to spend (UI units). */
  sol: number;
  /** The blockhash validity bound of the signed transaction (the router's value; MAX_SAFE_INTEGER when unknown). */
  last_valid_block_height: number;
  submitted_at: number;
  /** The route's quote in token atoms, when the router returned one (decimal string). */
  quote_tokens: string | null;
  /** A-115: a buy from a signal card carries the plan resolved at the tap (the grade preset or the active policy). */
  exit_plan?: ExitPlanSnapshot;
}

export interface ManualBuyJournal {
  list(): ManualBuyRecord[];
  get(sig: string): ManualBuyRecord | undefined;
  /** Appends and persists; throws when the file cannot be written (the caller then sends nothing). */
  add(rec: ManualBuyRecord): void;
  /** Best effort. */
  update(sig: string, patch: Partial<ManualBuyRecord>): void;
  /** Best effort (an entry that stays is resolved again on the next boot). */
  remove(sig: string): void;
  readonly loadError: string | null;
}

function valid(x: unknown): ManualBuyRecord | null {
  if (typeof x !== 'object' || x === null) return null;
  const r = x as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!str(r.sig) || !str(r.ca) || !str(r.wallet_id) || !str(r.owner) || !num(r.sol) || !num(r.last_valid_block_height) || !num(r.submitted_at)) return null;
  const q = typeof r.quote_tokens === 'string' && /^\d+$/.test(r.quote_tokens) ? r.quote_tokens : null;
  const out: ManualBuyRecord = { sig: r.sig, ca: r.ca, wallet_id: r.wallet_id, owner: r.owner, sol: r.sol, last_valid_block_height: r.last_valid_block_height, submitted_at: r.submitted_at, quote_tokens: q };
  const plan = r.exit_plan === undefined ? null : normalizeExitPlan(r.exit_plan);
  if (plan !== null) out.exit_plan = plan;
  return out;
}

export function openManualBuyJournal(dir: string): ManualBuyJournal {
  const file = path.join(dir, MANUAL_BUYS_FILE);
  const entries = new Map<string, ManualBuyRecord>();
  let loadError: string | null = null;
  if (fs.existsSync(file)) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { v?: unknown; entries?: unknown };
      if (doc === null || typeof doc !== 'object' || doc.v !== 1 || !Array.isArray(doc.entries)) throw new Error('unexpected format');
      for (const e of doc.entries) {
        const r = valid(e);
        if (r !== null) entries.set(r.sig, r);
      }
    } catch (e) {
      // never overwrite the only record of in-flight buys: keep a copy aside, then start empty
      loadError = String((e as { message?: unknown })?.message ?? e).slice(0, 200);
      try { fs.copyFileSync(file, `${file}.corrupt-${process.pid}`); } catch { /* best effort */ }
    }
  }
  const persist = (): void => { writeFileAtomicSync(file, JSON.stringify({ v: 1, entries: [...entries.values()] })); };
  return {
    list: () => [...entries.values()].map(r => ({ ...r })),
    get: sig => { const r = entries.get(sig); return r ? { ...r } : undefined; },
    add(rec) {
      if (entries.has(rec.sig)) return;
      entries.set(rec.sig, { ...rec });
      try { persist(); } catch (e) { entries.delete(rec.sig); throw e; }
    },
    update(sig, patch) {
      const cur = entries.get(sig);
      if (!cur) return;
      entries.set(sig, { ...cur, ...patch, sig });
      try { persist(); } catch { entries.set(sig, cur); }
    },
    remove(sig) {
      const cur = entries.get(sig);
      if (!cur) return;
      entries.delete(sig);
      try { persist(); } catch { entries.set(sig, cur); }
    },
    get loadError() { return loadError; },
  };
}
