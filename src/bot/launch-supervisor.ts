/**
 * launch-supervisor.ts (A-93f): keeps Telegram long polling alive.
 *
 * Telegraf's `bot.launch()` awaits getMe and deleteWebhook and then the polling loop; it rejects on a network error at boot and whenever
 * the loop ends on an error it does not retry itself (401, 409 Conflict, any other non-429, non-5xx error), and it resolves when polling
 * ends. Before this module the bot launched once and only logged a failure, so commands and buttons stayed dead until a manual restart
 * while the send queue still posted cards. Now every end of a launch that is not a shutdown is followed by another `launch()` after a
 * backoff (5 s doubling to 60 s, back to 5 s after a run that lasted HEALTHY_AFTER_MS), forever. The owner is told once per outage through
 * the send queue (which does not need polling), and a 401 (the token was revoked) gets its own alert. Time comes from the bot Clock.
 */
import type { Clock, TimerHandle } from '../link/clock';

export const LAUNCH_RETRY_MIN_MS = 5_000;
export const LAUNCH_RETRY_MAX_MS = 60_000;
/** A launch that ran this long before it ended counts as a healthy run: the backoff and the outage alert start over. */
export const LAUNCH_HEALTHY_AFTER_MS = 300_000;

export interface LaunchSupervisorDeps {
  /** `() => bot.launch({...})`: a new Polling each call; botInfo is cached by Telegraf after the first success. */
  launch(): Promise<void>;
  clock: Pick<Clock, 'now' | 'setTimeout' | 'clearTimeout'>;
  notifyOwner(text: string): void;
  /** True while the process shuts down: an ended launch is then not restarted. */
  stopping(): boolean;
  log?: (msg: string, level?: 'info' | 'warn' | 'err') => void;
  minDelayMs?: number;
  maxDelayMs?: number;
  healthyAfterMs?: number;
}

export interface LaunchSupervisor {
  /** Stops relaunching (a pending retry timer is cleared). */
  stop(): void;
  /** Resolves when the supervisor has stopped. */
  readonly done: Promise<void>;
}

function codeOf(e: unknown): number | null {
  const o = (typeof e === 'object' && e !== null ? e : {}) as { code?: unknown; error_code?: unknown; response?: { error_code?: unknown } };
  for (const c of [o.code, o.error_code, o.response?.error_code]) if (typeof c === 'number') return c;
  return null;
}

function shortReason(e: unknown): string {
  if (e === null || e === undefined) return 'polling ended';
  const m = (e as { message?: unknown }).message;
  // never repeat a URL: a FetchError message embeds the api.telegram.org/bot<token>/ path
  return String(m ?? e).replace(/https?:\/\/\S+/g, '<url>').slice(0, 120);
}

export function superviseLaunch(d: LaunchSupervisorDeps): LaunchSupervisor {
  const min = d.minDelayMs ?? LAUNCH_RETRY_MIN_MS;
  const max = d.maxDelayMs ?? LAUNCH_RETRY_MAX_MS;
  const healthyAfter = d.healthyAfterMs ?? LAUNCH_HEALTHY_AFTER_MS;
  const log = d.log ?? (() => undefined);
  let stopped = false;
  let timer: TimerHandle | null = null;
  let wake: (() => void) | null = null;

  const halted = (): boolean => stopped || d.stopping();
  const notify = (text: string): void => { try { d.notifyOwner(text); } catch { /* the queue is best effort here */ } };
  const sleep = (ms: number): Promise<void> => new Promise<void>(resolve => {
    wake = resolve;
    timer = d.clock.setTimeout(() => { timer = null; wake = null; resolve(); }, ms);
  });

  async function run(): Promise<void> {
    let delay = min;
    let alerted = false;
    let alerted401 = false;
    while (!halted()) {
      const started = d.clock.now();
      let err: unknown = null;
      try { await d.launch(); } catch (e) { err = e; }
      if (halted()) return;
      if (d.clock.now() - started >= healthyAfter) { delay = min; alerted = false; alerted401 = false; }
      const code = codeOf(err);
      const why = code !== null ? `Telegram ${code}: ${shortReason(err)}` : shortReason(err);
      log(`[bot] Telegram polling stopped (${why}); relaunching in ${Math.round(delay / 1000)} s`, 'err');
      if (code === 401) {
        if (!alerted401) {
          alerted401 = true;
          notify('🚨 Telegram rejected the bot token (401 Unauthorized): commands and buttons do not work. Check TG_BOT_TOKEN (was it revoked?) and restart the bot. The bot keeps retrying.');
        }
      } else if (!alerted) {
        alerted = true;
        notify(`⚠️ Telegram polling stopped (${why}): commands and buttons do not work right now. The bot relaunches it in ${Math.round(delay / 1000)} s and keeps retrying.${code === 409 ? ' A 409 means another process polls with the same bot token: stop the other bot.' : ''}`);
      }
      await sleep(delay);
      delay = Math.min(max, delay * 2);
    }
  }

  const done = run().catch(e => { log(`[bot] the launch supervisor failed: ${shortReason(e)}`, 'err'); });
  return {
    stop(): void {
      stopped = true;
      if (timer !== null) { d.clock.clearTimeout(timer); timer = null; }
      const w = wake;
      wake = null;
      if (w) w();
    },
    done,
  };
}
