// R1-B1 (B10 section 3 rule 1): what the bot remembers about the events it has received.
//   1. The seen event_ids (48 h), persisted to <data>/inbox-seen.json atomically, so a duplicate is answered 202 duplicate:true with no side
//      effect even across a restart (the Engine retries an event until it gets a 202; its event_id never changes).
//   2. The per-CA signal registry: the CAs the bot has already received a signal.new for (a second signal.new for the same CA is a contract
//      violation), with the grade and symbol the later cancel and exit-alert cards need. Persisted to <data>/signalled-cas.json. It is a
//      separate file because it is bigger than the seen set and changes only on signal.new, while the seen set changes on every event.
// A-96 (round 6, R6-PP9): a SignalledInfo also remembers why a CA gets no Telegram card of any kind (`suppressed`: the owner's pre-pump rule launch-run, set from the
// signal.new labels). It is persisted with the entry, so the suppression survives a restart for SIGNALLED_TTL_MS; an entry written before A-96 has no such member and reads as null.
// Both files are rewritten as a whole by a group commit: marks made in the same tick share one write, and persisted() resolves when every
// mark made before the call is on disk. A write failure is logged and never fails the event (the in-memory state stays authoritative).
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Grade } from '../shared/common/ids';
import { writeFileAtomic } from './atomic-file';
import type { Clock } from './clock';
import { defaultLog, errMessage, isRecord, type LinkLog } from './common';

export const SEEN_TTL_MS = 48 * 3_600_000;
/** The Engine sends a cancel for up to 48 h; a CA is remembered well beyond that so a late duplicate signal is still caught. */
export const SIGNALLED_TTL_MS = 30 * 86_400_000;
export const INBOX_SEEN_FILE = 'inbox-seen.json';
export const SIGNALLED_FILE = 'signalled-cas.json';

/** The only suppression there is: the owner's pre-pump rule (label launch-run true on the signal.new). It is also the `error` of a filtered delivery.tg (A-96). */
export const LAUNCH_RUN_SUPPRESSION = 'launch-run' as const;
export type Suppression = typeof LAUNCH_RUN_SUPPRESSION;
/** `suppressed` is optional only so that a registry stub written before A-96 still compiles; the inbox always sets it, and a missing member means null. */
export interface SignalledInfo {
  signal_id: string; at: number; grade: Grade; symbol: string | null; suppressed?: Suppression | null;
  /** A-115: the owner filters this signal failed (its later alert and cancel cards follow them); absent or null = none. */
  owner_filtered?: string[] | null;
}

/** The per-CA registry the intake handlers use (a view of Inbox). */
export interface SignalRegistry {
  signalled(ca: string): SignalledInfo | null;
  markSignalled(ca: string, info: SignalledInfo): void;
}

export interface Inbox extends SignalRegistry {
  /** Marks `eventId` as seen now and says whether it was new. Synchronous: two concurrent posts of one event cannot both be 'new'. */
  checkAndMark(eventId: string): 'new' | 'duplicate';
  seen(eventId: string): boolean;
  /** Resolves when every mark made before this call is on disk. Never rejects. */
  persisted(): Promise<void>;
  sizes(): { seen: number; signalled: number };
}

export interface InboxDeps { dir: string; clock: Clock; seenTtlMs?: number; signalledTtlMs?: number; log?: LinkLog }

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

const GRADES: readonly string[] = ['A', 'B', 'C'];

export function createInbox(deps: InboxDeps): Inbox {
  const { clock } = deps;
  const log = deps.log ?? defaultLog;
  const seenTtl = deps.seenTtlMs ?? SEEN_TTL_MS;
  const signalledTtl = deps.signalledTtlMs ?? SIGNALLED_TTL_MS;
  const seenFile = path.join(deps.dir, INBOX_SEEN_FILE);
  const signalledFile = path.join(deps.dir, SIGNALLED_FILE);

  const seenMap = new Map<string, number>();
  const signalledMap = new Map<string, SignalledInfo>();

  const t0 = clock.now();
  const seenDoc = readJsonFile(seenFile);
  if (isRecord(seenDoc) && isRecord(seenDoc.seen)) {
    for (const [id, at] of Object.entries(seenDoc.seen)) {
      if (typeof at === 'number' && Number.isFinite(at) && t0 - at <= seenTtl) seenMap.set(id, at);
    }
  }
  const sigDoc = readJsonFile(signalledFile);
  if (isRecord(sigDoc) && isRecord(sigDoc.cas)) {
    for (const [ca, v] of Object.entries(sigDoc.cas)) {
      if (!isRecord(v) || typeof v.signal_id !== 'string' || typeof v.at !== 'number' || !Number.isFinite(v.at)) continue;
      if (typeof v.grade !== 'string' || !GRADES.includes(v.grade)) continue;
      if (t0 - v.at > signalledTtl) continue;
      signalledMap.set(ca, {
        signal_id: v.signal_id, at: v.at, grade: v.grade as Grade, symbol: typeof v.symbol === 'string' ? v.symbol : null,
        suppressed: v.suppressed === LAUNCH_RUN_SUPPRESSION ? LAUNCH_RUN_SUPPRESSION : null,   // an entry without the member (or with an unknown one) is not suppressed
        ...(Array.isArray(v.owner_filtered) && v.owner_filtered.length > 0
          ? { owner_filtered: v.owner_filtered.filter((x): x is string => typeof x === 'string').slice(0, 8).map(x => x.slice(0, 32)) } : {}),
      });
    }
  }

  let dirtySeen = false;
  let dirtySignalled = false;
  let flushing: Promise<void> | null = null;

  async function writeOut(): Promise<void> {
    // let marks made in the same tick join this write
    await Promise.resolve();
    try {
      while (dirtySeen || dirtySignalled) {
        const doSeen = dirtySeen;
        const doSignalled = dirtySignalled;
        dirtySeen = false;
        dirtySignalled = false;
        const now = clock.now();
        try {
          if (doSeen) {
            for (const [id, at] of seenMap) if (now - at > seenTtl) seenMap.delete(id);
            await writeFileAtomic(seenFile, JSON.stringify({ v: 1, seen: Object.fromEntries(seenMap) }));
          }
          if (doSignalled) {
            for (const [ca, v] of signalledMap) if (now - v.at > signalledTtl) signalledMap.delete(ca);
            await writeFileAtomic(signalledFile, JSON.stringify({ v: 1, cas: Object.fromEntries(signalledMap) }));
          }
        } catch (e) {
          log(`inbox: could not persist (${errMessage(e)}); the in-memory state stays authoritative`, 'warn');
        }
      }
    } finally {
      flushing = null;   // runs in the same synchronous step as the loop test above, so no mark can slip in between
    }
  }

  function schedule(): void {
    if (flushing === null) flushing = writeOut();
  }

  return {
    checkAndMark(eventId: string): 'new' | 'duplicate' {
      if (seenMap.has(eventId)) return 'duplicate';
      seenMap.set(eventId, clock.now());
      dirtySeen = true;
      schedule();
      return 'new';
    },
    seen(eventId: string): boolean { return seenMap.has(eventId); },
    persisted(): Promise<void> { return flushing ?? Promise.resolve(); },
    signalled(ca: string): SignalledInfo | null { return signalledMap.get(ca) ?? null; },
    markSignalled(ca: string, info: SignalledInfo): void {
      signalledMap.set(ca, info);
      dirtySignalled = true;
      schedule();
    },
    sizes(): { seen: number; signalled: number } { return { seen: seenMap.size, signalled: signalledMap.size }; },
  };
}
