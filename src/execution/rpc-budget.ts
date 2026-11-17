/**
 * RPC BUDGET — the bot's own limit on wallet RPC traffic (R7-W5, A-104 rule 11, design 6.5).
 *
 * Three limits, for WALLET calls only:
 *   - a daily call cap (default 3000), counted per UTC day;
 *   - a per-owner cap per minute (default 60), sliding;
 *   - a GLOBAL token bucket of `maxPerSec` calls per second (default 4) for all wallet traffic together. This one DELAYS a call (it
 *     waits for a token) instead of refusing it, up to `maxWaitMs`; past that the call is refused.
 * Over a cap or past the wait limit, `acquire` throws RpcBudgetError ('rpc-budget'); the caller turns that into the `rpc-budget`
 * refusal and the view shows the reason.
 *
 * The budget wraps only the port the wallet builders receive (`withRpcBudget`). A server-path call (auto-buy, exits, fills of the bot's
 * own positions) never goes through it, so it can never be delayed by wallet traffic (WBL-T08 proves auto-buy timing unchanged). The
 * clock is injected: `now()` for the windows and `sleep(ms)` for the bucket wait.
 */
import { systemWalletSleepClock, type WalletRpcCallOpts, type WalletRpcPort, type WalletSleepClock } from './wallet-rpc';

export const DEFAULT_WALLET_RPC_DAILY_CALL_CAP = 3000;
export const DEFAULT_WALLET_RPC_PER_OWNER_PER_MIN = 60;
export const DEFAULT_WALLET_RPC_MAX_PER_SEC = 4;
export const DEFAULT_WALLET_RPC_MAX_WAIT_MS = 10_000;

export interface RpcBudgetConfig {
  dailyCallCap: number;
  perOwnerPerMin: number;
  /** Calls per second for all wallet traffic together (also the bucket size: a burst of at most this many). */
  maxPerSec: number;
  /** The longest a call may wait for a bucket token before it is refused. */
  maxWaitMs: number;
}
export const DEFAULT_RPC_BUDGET: Readonly<RpcBudgetConfig> = {
  dailyCallCap: DEFAULT_WALLET_RPC_DAILY_CALL_CAP,
  perOwnerPerMin: DEFAULT_WALLET_RPC_PER_OWNER_PER_MIN,
  maxPerSec: DEFAULT_WALLET_RPC_MAX_PER_SEC,
  maxWaitMs: DEFAULT_WALLET_RPC_MAX_WAIT_MS,
};

export type BudgetClock = WalletSleepClock;
export const systemBudgetClock: BudgetClock = systemWalletSleepClock;

export type RpcBudgetLimit = 'daily' | 'owner-minute' | 'wait';
export class RpcBudgetError extends Error {
  readonly code = 'rpc-budget' as const;
  readonly limit: RpcBudgetLimit;
  constructor(limit: RpcBudgetLimit) {
    super(limit === 'daily' ? 'wallet RPC daily call cap reached'
      : limit === 'owner-minute' ? 'wallet RPC per-owner minute cap reached'
        : 'wallet RPC is busy: the per-second budget would delay this call too long');
    this.name = 'RpcBudgetError';
    this.limit = limit;
  }
}

export interface RpcBudget {
  /** Admit one call for `owner`, waiting for a bucket token when needed; throws RpcBudgetError when a cap is reached. */
  acquire(owner: string): Promise<void>;
  snapshot(): { utcDay: string; callsToday: number; bucketTokens: number };
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function createRpcBudget(cfg: Partial<RpcBudgetConfig> = {}, clock: BudgetClock = systemBudgetClock): RpcBudget {
  const c: RpcBudgetConfig = { ...DEFAULT_RPC_BUDGET, ...cfg };
  let day = utcDay(clock.now());
  let callsToday = 0;
  const perOwner = new Map<string, number[]>();
  let tokens = c.maxPerSec;
  let lastRefill = clock.now();
  // Calls are admitted one at a time, in arrival order, so concurrent callers share the bucket fairly.
  let tail: Promise<void> = Promise.resolve();

  const refill = (): void => {
    const now = clock.now();
    if (now > lastRefill) tokens = Math.min(c.maxPerSec, tokens + ((now - lastRefill) * c.maxPerSec) / 1000);
    lastRefill = now;
  };

  async function admit(owner: string): Promise<void> {
    const t0 = clock.now();
    if (utcDay(t0) !== day) { day = utcDay(t0); callsToday = 0; }
    if (callsToday >= c.dailyCallCap) throw new RpcBudgetError('daily');
    const stamps = (perOwner.get(owner) ?? []).filter((s) => t0 - s < 60_000);
    perOwner.set(owner, stamps);
    if (stamps.length >= c.perOwnerPerMin) throw new RpcBudgetError('owner-minute');
    let waited = 0;
    for (;;) {
      refill();
      if (tokens >= 1) break;
      const wait = Math.max(1, Math.ceil(((1 - tokens) * 1000) / c.maxPerSec));
      if (waited + wait > c.maxWaitMs) throw new RpcBudgetError('wait');
      await clock.sleep(wait);
      waited += wait;
    }
    tokens -= 1;
    callsToday += 1;
    stamps.push(clock.now());
  }

  return {
    acquire(owner: string): Promise<void> {
      const run = tail.then(() => admit(owner));
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
    snapshot() {
      refill();
      return { utcDay: day, callsToday, bucketTokens: tokens };
    },
  };
}

/** The port the wallet builders receive for one owner: every call is admitted by the budget first. */
export function withRpcBudget(port: WalletRpcPort, budget: RpcBudget, owner: string): WalletRpcPort {
  return {
    async call(method: string, params: unknown[], opts?: WalletRpcCallOpts): Promise<any> {
      await budget.acquire(owner);
      return port.call(method, params, opts);
    },
  };
}
