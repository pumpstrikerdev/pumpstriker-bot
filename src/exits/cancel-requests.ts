/**
 * cancel-requests.ts (A-93f): a signal.cancel that arrives while the auto-buy of the same CA is still in the pending-buys journal finds no
 * position yet. ExitApi.cancel records it here (`<BOT_DATA_DIR>/cancel-requests.json`, written tmp + fsync + rename), and the positions
 * adapter applies it to the position the moment the buy opens one (`applyCancelRequest`: cancel_pending, due at once), so the guaranteed
 * CANCEL exit survives the race and a restart. A request is used once and is forgotten after CANCEL_REQUEST_TTL_MS.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Clock } from '../link/clock';
import { writeFileAtomicSync } from '../link/atomic-file';
import type { PositionsStoreV2 } from './positions-store';

export const CANCEL_REQUESTS_FILE = 'cancel-requests.json';
export const CANCEL_REQUEST_TTL_MS = 86_400_000;

export interface CancelRequest { ca: string; signal_id: string; at: number }

export interface CancelRequests {
  add(ca: string, signalId: string): void;
  /** The request for this CA (and forgets it), or null. */
  take(ca: string): CancelRequest | null;
  list(): CancelRequest[];
}

export function openCancelRequests(dir: string, clock: Pick<Clock, 'now'>): CancelRequests {
  const file = path.join(dir, CANCEL_REQUESTS_FILE);
  const byCa = new Map<string, CancelRequest>();
  try {
    if (fs.existsSync(file)) {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { v?: unknown; requests?: unknown };
      if (Array.isArray(doc?.requests)) {
        for (const r of doc.requests as Array<Record<string, unknown>>) {
          if (r && typeof r.ca === 'string' && r.ca.length > 0 && typeof r.signal_id === 'string' && typeof r.at === 'number' && Number.isFinite(r.at)) {
            byCa.set(r.ca, { ca: r.ca, signal_id: r.signal_id, at: r.at });
          }
        }
      }
    }
  } catch { /* an unreadable file holds no usable request; the next write replaces it */ }
  const prune = (): void => {
    const cut = clock.now() - CANCEL_REQUEST_TTL_MS;
    for (const [ca, r] of byCa) if (r.at < cut) byCa.delete(ca);
  };
  const persist = (): void => { writeFileAtomicSync(file, JSON.stringify({ v: 1, requests: [...byCa.values()] })); };
  return {
    add(ca, signalId) {
      byCa.set(ca, { ca, signal_id: signalId, at: clock.now() });
      prune();
      persist();
    },
    take(ca) {
      prune();
      const r = byCa.get(ca) ?? null;
      if (r !== null) {
        byCa.delete(ca);
        try { persist(); } catch { /* used in memory; a stale entry would only cancel a later position of the same CA within the TTL */ }
      }
      return r;
    },
    list: () => { prune(); return [...byCa.values()]; },
  };
}

/** Applies a recorded cancel to a freshly opened signal position: cancel_pending, due at once. True when one was applied. */
export function applyCancelRequest(store: Pick<PositionsStoreV2, 'get' | 'update'>, requests: CancelRequests, positionId: string): boolean {
  const pos = store.get(positionId);
  if (!pos || pos.origin !== 'signal' || pos.closed_at !== null) return false;
  const r = requests.take(pos.ca);
  if (r === null) return false;
  store.update(positionId, { cancel_pending: true, next_due_at: 0 });
  return true;
}
