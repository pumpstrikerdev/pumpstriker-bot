/**
 * ╔═══════════════════════════════════════════════════╗
 * ║  PumpStriker — Structured Logger                    ║
 * ║  Console + SSE broadcast with levels               ║
 * ╚═══════════════════════════════════════════════════╝
 */

import { redactSecrets } from './lib/redact';

export type LogLevel = 'info' | 'ok' | 'warn' | 'err' | 'debug';

type BroadcastFn = (event: string, data: any) => void;

let _broadcast: BroadcastFn | null = null;

const LEVEL_PREFIX: Record<LogLevel, string> = {
  info:  '·',
  ok:    '✓',
  warn:  '⚠',
  err:   '✗',
  debug: '…',
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  info:  '\x1b[37m',  // white
  ok:    '\x1b[32m',  // green
  warn:  '\x1b[33m',  // yellow
  err:   '\x1b[31m',  // red
  debug: '\x1b[90m',  // gray
};

const RESET = '\x1b[0m';

export function setBroadcast(fn: BroadcastFn): void {
  _broadcast = fn;
}

/**
 * Emit an arbitrary SSE event to connected dashboards (2026-06-12).
 * Lets modules without direct broadcast wiring (e.g. the prepump sweep) push
 * real-time events — used so a TG-delivered signal appears on the dashboard
 * the same second instead of waiting for the next poll. No-op before the
 * server is up or when no dashboard is connected.
 */
export function emitEvent(event: string, data: any): void {
  try { if (_broadcast) _broadcast(event, data); } catch { /* never throws */ }
}

export function log(msg: string, level: LogLevel = 'info'): void {
  // 2026-09-29 (security T2b): the ONE redaction point — RPC/API keys, bot
  // tokens, Bearer secrets, wallet private keys and seed phrases are masked
  // before the line reaches the console or the SSE broadcast (lib/redact.ts).
  msg = redactSecrets(msg);
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = LEVEL_PREFIX[level];
  const color = LEVEL_COLOR[level];

  // Console output with color
  console.log(`${color}[${ts}] ${prefix} ${msg}${RESET}`);

  // Broadcast to SSE clients (dashboard)
  if (_broadcast) {
    _broadcast('log', { ts, msg, level });
  }
}

// Convenience shortcuts
export const logOk   = (msg: string) => log(msg, 'ok');
export const logWarn = (msg: string) => log(msg, 'warn');
export const logErr  = (msg: string) => log(msg, 'err');
export const logDbg  = (msg: string) => log(msg, 'debug');
