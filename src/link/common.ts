// R1-B1 (B10): small pieces shared by the link, intake and Telegram modules: the HTTP seam (injectable, so tests never open a real socket
// except to a 127.0.0.1 server they started), the log seam, bot-to-Engine envelope construction and UTC time formatting.
import * as http from 'node:http';
import * as https from 'node:https';
import { log } from '../logger';
import type { BotToEngineEvent, BotToEngineType } from '../shared/contract/v1';

export type LinkLogLevel = 'info' | 'ok' | 'warn' | 'err' | 'debug';
export type LinkLog = (msg: string, level?: LinkLogLevel) => void;

/** The default log sink: the bot logger, which is the one redaction point for every log line (logger.ts). */
export const defaultLog: LinkLog = (msg, level) => { log(msg, level ?? 'info'); };

export interface HttpRequest { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body?: string; timeoutMs: number }
export interface HttpResponse { status: number; body: string }
/** One HTTP round trip. Resolves for ANY status; rejects (HttpError or any Error) on timeout and network failure. */
export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export class HttpError extends Error {
  constructor(readonly kind: 'timeout' | 'network', message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** True when a thrown value is a timeout (HttpError, or the AbortError/TimeoutError names of fetch). */
export function isTimeout(e: unknown): boolean {
  if (e instanceof HttpError) return e.kind === 'timeout';
  const name = typeof e === 'object' && e !== null ? String((e as { name?: unknown }).name ?? '') : '';
  return name === 'TimeoutError' || name === 'AbortError';
}

const MAX_RESPONSE_BYTES = 1_000_000;

/**
 * Production HTTP: node:http / node:https with a hard overall timeout, no keep-alive, no redirects. It is deliberately NOT the global fetch:
 * Node's fetch adds a `Sec-Fetch-Mode` header to every request, and the link auth (shared/link-auth.ts, rule 2) refuses any Sec-Fetch-* header
 * as a browser marker, so a fetch-based client would be answered 403 by the Engine.
 */
export const defaultHttp: HttpFn = (req) => new Promise<HttpResponse>((resolve, reject) => {
  let settled = false;
  const fail = (e: unknown): void => {
    if (settled) return;
    settled = true;
    reject(e instanceof HttpError ? e : isTimeout(e) ? new HttpError('timeout', 'request timed out') : new HttpError('network', errMessage(e)));
  };
  let url: URL;
  try { url = new URL(req.url); } catch (e) { fail(e); return; }
  const transport = url.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = { ...req.headers };
  if (req.body !== undefined) headers['content-length'] = String(Buffer.byteLength(req.body));
  const r = transport.request(url, { method: req.method, headers, agent: false, signal: AbortSignal.timeout(req.timeoutMs) }, res => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_RESPONSE_BYTES) chunks.push(c);
    });
    res.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
    });
    res.on('error', fail);
  });
  r.on('error', fail);
  if (req.body !== undefined) r.write(req.body);
  r.end();
});

/** A short, single-line message of any thrown value (never the stack). */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e) ?? String(e); } catch { return String(e); }
}

/** Parses JSON without throwing: undefined when the text is not JSON. */
export function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** HH:MM in UTC (same convention as the C03 card renderer, so every owner message reads the same clock). */
export function hhmm(ms: number): string {
  if (!Number.isFinite(ms)) return '--:--';
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** The envelope of a bot-to-Engine event: attempt 1, emitted at `now`. The event id is stable for the life of the event. */
export function buildEnvelope<T extends BotToEngineType>(
  type: T, payload: Extract<BotToEngineEvent, { type: T }>['payload'],
  o: { eventId: string; signalId: string | null; ca: string | null; now: number },
): Extract<BotToEngineEvent, { type: T }> {
  return { v: 1, type, event_id: o.eventId, signal_id: o.signalId, ca: o.ca, emitted_at: o.now, attempt: 1, payload } as Extract<BotToEngineEvent, { type: T }>;
}

/** Strips a trailing slash so `${base}/path` never doubles it. */
export function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}
