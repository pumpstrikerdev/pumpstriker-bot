// R1-B1 (B10): the injected clock of the link, intake and Telegram modules. Same shape as Engine\src\lib\clock.ts (the bot cannot import the
// Engine's file: separate package, rootDir ./src). Every B10 module takes a Clock through its factory and never reads the wall clock itself;
// this file holds the only Date.now() call of the package. FakeClock drives the tests (one fake clock per test, never mixed with real timers).

export interface TimerHandle { readonly id: number }
export interface Clock {
  now(): number;                                         // epoch ms
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(h: TimerHandle): void;
  sleep(ms: number): Promise<void>;
}

const systemTimers = new Map<number, ReturnType<typeof setTimeout>>();
let nextSystemTimerId = 1;

/** Wraps the system time and the global timers (looked up at call time). */
export const systemClock: Clock = {
  now(): number { return Date.now(); },
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = nextSystemTimerId++;
    const t = setTimeout(() => { systemTimers.delete(id); fn(); }, ms);
    systemTimers.set(id, t);
    return { id };
  },
  clearTimeout(h: TimerHandle): void {
    const t = systemTimers.get(h.id);
    if (t !== undefined) { clearTimeout(t); systemTimers.delete(h.id); }
  },
  sleep(ms: number): Promise<void> {
    return new Promise<void>(resolve => { systemClock.setTimeout(resolve, ms); });
  },
};

// The real setImmediate, captured at import so a test that installs fake timers later cannot stall FakeClock.advance.
const realSetImmediate: typeof setImmediate = setImmediate;
const MAX_TIMERS_PER_ADVANCE = 1_000_000;

interface FakeTimer { id: number; dueAt: number; fn: () => void }

/** Deterministic clock for tests. advance(ms) moves time forward and runs due timers in (dueAt, id) order, awaiting a macrotask between
 *  timers so in-flight promises settle. */
export class FakeClock implements Clock {
  private nowMs: number;
  private nextId = 1;
  private readonly timers = new Map<number, FakeTimer>();

  constructor(startMs: number) {
    if (!Number.isFinite(startMs)) throw new RangeError('FakeClock: startMs must be a finite number');
    this.nowMs = startMs;
  }

  now(): number { return this.nowMs; }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
    const id = this.nextId++;
    this.timers.set(id, { id, dueAt: this.nowMs + delay, fn });
    return { id };
  }

  clearTimeout(h: TimerHandle): void { this.timers.delete(h.id); }

  sleep(ms: number): Promise<void> {
    return new Promise<void>(resolve => { this.setTimeout(resolve, ms); });
  }

  pendingTimers(): number { return this.timers.size; }

  /** Moves time forward by ms. Before each timer (and once more after the last) a macrotask is awaited, so promise continuations that
   *  register new timers run first; a timer that registers another due inside the window runs in the same call. */
  async advance(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('FakeClock.advance: ms must be a finite number >= 0');
    const target = this.nowMs + ms;
    for (let ran = 0; ; ran++) {
      await new Promise<void>(resolve => { realSetImmediate(resolve); });
      const next = this.earliestDue(target);
      if (next === undefined) break;
      if (ran >= MAX_TIMERS_PER_ADVANCE) throw new Error('FakeClock.advance: timer storm (a timer keeps re-arming itself inside the window)');
      this.timers.delete(next.id);
      if (next.dueAt > this.nowMs) this.nowMs = next.dueAt;
      next.fn();
    }
    this.nowMs = target;
  }

  /** Lets queued promise continuations and I/O callbacks run without moving time. */
  async settle(rounds = 3): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise<void>(resolve => { realSetImmediate(resolve); });
  }

  private earliestDue(target: number): FakeTimer | undefined {
    let best: FakeTimer | undefined;
    for (const t of this.timers.values()) {
      if (t.dueAt > target) continue;
      if (best === undefined || t.dueAt < best.dueAt || (t.dueAt === best.dueAt && t.id < best.id)) best = t;
    }
    return best;
  }
}
