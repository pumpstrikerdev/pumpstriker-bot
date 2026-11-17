// R1-B1 (B10 section 3 rule 6; plan grind #60): the dead-man alert for an unsupervised or crash-looping Engine.
//
// GET {ENGINE_URL}/health every 30 s (timeout 1.5 s; the liveness route carries no data and needs no bearer). After 3 minutes without a
// 200 the owner gets "Engine unreachable since HH:MM UTC" once, through the send queue's ops lane. When the Engine answers again the owner
// gets "Engine back at HH:MM UTC (down N min)" once; when the /health runId changed meanwhile (a restart) the same message says so, so a
// kill-and-restart is exactly two messages. A runId change without a reported outage (a quick restart) gets one restart notice.
// HH:MM is UTC and says so (owner 2026-11-06, A-137), like the ENGINE cards. The first probe only learns the runId.
import type { TgQueue } from '../bot-contracts';
import { noticeCard } from '../tg/cards';
import type { Clock, TimerHandle } from './clock';
import { defaultHttp, defaultLog, errMessage, hhmm, isRecord, parseJson, trimBase, type HttpFn, type LinkLog } from './common';

export const WATCH_INTERVAL_MS = 30_000;
export const WATCH_TIMEOUT_MS = 1_500;
export const WATCH_DOWN_AFTER_MS = 180_000;

export interface EngineWatchDeps {
  clock: Clock;
  /** ENGINE_URL */
  engineUrl: string;
  /** The send queue (kind 'ops' lane: the owner's chat, outside the signal pacing and the grade filter). */
  tg: TgQueue;
  http?: HttpFn;
  intervalMs?: number;
  timeoutMs?: number;
  downAfterMs?: number;
  log?: LinkLog;
  /** A-93f: called when the Engine answers again after a failed probe, or with a new runId (a restart): the caller re-reads state. */
  onBack?: () => void;
}

export interface EngineWatch {
  start(): void;
  stop(): Promise<void>;
  /** One probe and its consequences (the timer calls this; tests call it directly). */
  probeOnce(): Promise<void>;
  state(): { up: boolean; downSince: number | null; reported: boolean; runId: string | null };
}

export function createEngineWatch(deps: EngineWatchDeps): EngineWatch {
  const { clock } = deps;
  const log = deps.log ?? defaultLog;
  const http = deps.http ?? defaultHttp;
  const url = `${trimBase(deps.engineUrl)}/health`;
  const intervalMs = deps.intervalMs ?? WATCH_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? WATCH_TIMEOUT_MS;
  const downAfterMs = deps.downAfterMs ?? WATCH_DOWN_AFTER_MS;

  let startedAt: number | null = null;       // when the watch began: the outage clock of an Engine that never answered
  let lastOkAt: number | null = null;
  let downSince: number | null = null;       // the first failed probe after the last 200 (or the start)
  let reported = false;                      // "unreachable" has been sent for the current outage
  let runId: string | null = null;
  let up = true;
  let timer: TimerHandle | null = null;
  let running = false;
  let probing: Promise<void> | null = null;

  function say(text: string): void {
    deps.tg.enqueue(noticeCard(text), { kind: 'ops', signalId: null, ca: null, decidedAt: null, leg: null, grade: null, replyTo: null });
  }

  async function probe(): Promise<void> {
    const now = clock.now();
    if (startedAt === null) startedAt = now;
    let okRunId: string | null | undefined;     // undefined = the probe failed
    try {
      const res = await http({ method: 'GET', url, headers: {}, timeoutMs });
      if (res.status === 200) {
        const json = parseJson(res.body);
        okRunId = isRecord(json) && typeof json.runId === 'string' && json.runId !== '' ? json.runId.slice(0, 64) : null;
      }
    } catch (e) {
      log(`engine-watch: /health did not answer (${errMessage(e).slice(0, 80)})`, 'debug');
    }
    const t = clock.now();

    if (okRunId === undefined) {
      up = false;
      if (downSince === null) downSince = t;     // the first probe that failed after the last 200 (or after the start)
      const reference = lastOkAt ?? startedAt;   // three minutes are counted from the last 200 (or from the start)
      if (!reported && t - reference >= downAfterMs) {
        reported = true;
        say(`Engine unreachable since ${hhmm(downSince)} UTC`);
        log(`engine-watch: Engine unreachable since ${hhmm(downSince)} UTC`, 'warn');
      }
      return;
    }

    // the Engine answered with a 200
    const restarted = okRunId !== null && runId !== null && okRunId !== runId;
    const wasDown = !up;
    if (reported) {
      const downMin = Math.max(0, Math.round((t - (downSince ?? t)) / 60_000));
      say(`Engine back at ${hhmm(t)} UTC (down ${downMin} min${restarted ? ', restarted' : ''})`);
      log(`engine-watch: Engine back after ${downMin} min`, 'ok');
    } else if (restarted) {
      say(`Engine restarted at ${hhmm(t)} UTC`);
      log('engine-watch: the Engine restarted (runId changed)', 'info');
    }
    if (okRunId !== null) runId = okRunId;
    lastOkAt = t;
    downSince = null;
    reported = false;
    up = true;
    if ((wasDown || restarted) && deps.onBack) {
      try { deps.onBack(); } catch (e) { log(`engine-watch: the back hook failed (${errMessage(e)})`, 'warn'); }
    }
  }

  function probeOnce(): Promise<void> {
    if (probing !== null) return probing;
    const p = probe().catch((e: unknown) => { log(`engine-watch: probe failed (${errMessage(e)})`, 'err'); }).finally(() => { probing = null; });
    probing = p;
    return p;
  }

  function arm(ms: number): void {
    if (!running) return;
    timer = clock.setTimeout(() => {
      timer = null;
      void probeOnce().then(() => { arm(intervalMs); });
    }, ms);
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      startedAt = clock.now();
      arm(0);
    },
    async stop(): Promise<void> {
      running = false;
      if (timer !== null) { clock.clearTimeout(timer); timer = null; }
      if (probing !== null) await probing;
    },
    probeOnce,
    state: () => ({ up, downSince, reported, runId }),
  };
}
