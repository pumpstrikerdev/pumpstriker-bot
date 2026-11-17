// R0-SHIMPL (round 0b; C02 section 4). The loopback bearer auth of the Engine <-> TG Bot link, used in BOTH directions: an Express middleware
// factory for the receiver and the outbound headers for the sender. Canonical source: R\shared\link-auth.ts; byte-identical copies live in
// Engine\src\shared\ and TG Bot\src\shared\ (R\scripts\sync-shared.ps1). Port of the verified TG Bot signal-auth checks.
//
// Every request must pass, in this order:
//   1. the shared secret is configured (at least 32 chars after trimming) -> otherwise 503 for EVERY request (fail closed);
//   2. no browser markers: an Origin header or any Sec-Fetch-* header -> 403;
//   3. a loopback Host (127.0.0.1, localhost or [::1]) on the receiver's own port -> else 403;
//   4. Authorization: Bearer <secret>, compared in constant time over sha256 -> else 401;
//   5. Content-Type: application/json (POST and other body-carrying methods; GET and HEAD skip it) -> else 415.
// Then a strict JSON parser (objects and arrays only) runs AFTER the checks, so an unauthenticated caller never gets its body read:
// a body above maxBodyBytes -> 413, invalid JSON -> 400. Every refusal is a JSON body { ok: false, code, reason } (the Nack shape of
// contract v1), so the sender's r.json() never throws.
//
// The secret and the Authorization header are never logged: this module does not log at all, and no reason text echoes a header value.
import crypto from 'crypto';
import express from 'express';
import type { RequestHandler, Response } from 'express';

export interface LinkAuthOptions { secret: () => string; receiverPort: number; maxBodyBytes?: number /* default 32768 */ }

export const LINK_BODY_LIMIT = 32 * 1024;
export const MIN_SECRET_LEN = 32;

type HeaderBag = Record<string, string | string[] | undefined>;
type NackCode = 'invalid' | 'auth' | 'too_large';
export type LinkCheck = { ok: true } | { ok: false; status: 401 | 403 | 415 | 503; code: 'auth' | 'invalid'; reason: string };

/** True when the secret is a string of at least MIN_SECRET_LEN chars after trimming. */
export function secretUsable(secret: string | undefined): boolean {
  return typeof secret === 'string' && secret.trim().length >= MIN_SECRET_LEN;
}

/** Constant-time string equality. Both sides are hashed with sha256 first, so the compared buffers always have the same length and
 *  neither the content nor the length of the expected value leaks through timing. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Case-insensitive header lookup (Node lowercases names; plain test objects may not). */
function headerValue(headers: HeaderBag, name: string): string | string[] | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  if (headers[name] !== undefined) return headers[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

/** Any Sec-Fetch-* header (Site, Mode, Dest, User) marks a browser request; node:http, node-fetch and undici.request never send one, but Node's global fetch (undici fetch) adds Sec-Fetch-Mode: cors and is refused here (403), so link clients must not use it. */
function hasSecFetchHeader(headers: HeaderBag): boolean {
  if (!headers || typeof headers !== 'object') return false;
  return Object.keys(headers).some(k => k.toLowerCase().startsWith('sec-fetch-') && headers[k] !== undefined);
}

/** The only Host values accepted: loopback names on the receiver's own port. */
function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

/** Pure check of one request's headers (no body); see the module header for the order. The secret is trimmed before use (a stray space or
 *  CRLF in a .env file must not turn every request into a 401). */
export function checkLinkRequest(
  req: { headers: HeaderBag; method?: string },
  opts: { secret?: string; receiverPort: number },
): LinkCheck {
  // 1. Fail closed when the secret is missing or too short.
  if (!secretUsable(opts.secret)) return { ok: false, status: 503, code: 'auth', reason: 'link secret not configured' };
  const secret = (opts.secret as string).trim();
  const headers: HeaderBag = (req && req.headers) || {};

  // 2. Browser markers -> CSRF attempt from a web page.
  if (headerValue(headers, 'origin') !== undefined) return { ok: false, status: 403, code: 'auth', reason: 'browser origin refused' };
  if (hasSecFetchHeader(headers)) return { ok: false, status: 403, code: 'auth', reason: 'browser request refused' };

  // 3. DNS rebinding: the Host must be a loopback name on the receiver's port.
  const host = headerValue(headers, 'host');
  if (typeof host !== 'string' || !allowedHosts(opts.receiverPort).has(host.trim().toLowerCase())) {
    return { ok: false, status: 403, code: 'auth', reason: 'host not allowed' };
  }

  // 4. Shared secret, constant time. The scheme name is case-insensitive (RFC 7235).
  const auth = headerValue(headers, 'authorization');
  const m = typeof auth === 'string' ? /^Bearer[ \t]+(.+)$/i.exec(auth.trim()) : null;
  if (!m || !timingSafeEqualStr(m[1].trim(), secret)) return { ok: false, status: 401, code: 'auth', reason: 'unauthorized' };

  // 5. JSON only (parameters such as `; charset=utf-8` are allowed). GET and HEAD carry no body and skip this check.
  const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'POST';
  if (method !== 'GET' && method !== 'HEAD') {
    const ct = headerValue(headers, 'content-type');
    const mediaType = typeof ct === 'string' ? ct.split(';')[0].trim().toLowerCase() : '';
    if (mediaType !== 'application/json') return { ok: false, status: 415, code: 'invalid', reason: 'content-type must be application/json' };
  }
  return { ok: true };
}

function refuse(res: Response, status: number, code: NackCode, reason: string): void {
  res.status(status).json({ ok: false, code, reason });
}

/** [authCheck, strictJsonParser]. Mount both in front of the routes of the link: app.use('/api/bot/v1', ...linkAuth({ ... })). */
export function linkAuth(opts: LinkAuthOptions): RequestHandler[] {
  const limit = opts.maxBodyBytes ?? LINK_BODY_LIMIT;
  const authCheck: RequestHandler = (req, res, next) => {
    const r = checkLinkRequest(req, { secret: opts.secret(), receiverPort: opts.receiverPort });
    if (!r.ok) {
      refuse(res, r.status, r.code, r.reason);
      return;
    }
    next();
  };
  const parse = express.json({ limit, strict: true, type: 'application/json' });
  const strictJsonParser: RequestHandler = (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') { next(); return; }
    parse(req, res, (err?: unknown) => {
      if (err === undefined || err === null) { next(); return; }
      // Never echo err.message: body-parser quotes the offending body in it.
      const e = err as { type?: unknown; status?: unknown; statusCode?: unknown };
      const type = typeof e.type === 'string' ? e.type : '';
      const status = Number(e.status ?? e.statusCode);
      if (type === 'entity.too.large' || status === 413) refuse(res, 413, 'too_large', 'body too large');
      else if (type === 'entity.parse.failed') refuse(res, 400, 'invalid', 'invalid JSON');
      else if (Number.isInteger(status) && status >= 400 && status < 500) refuse(res, status, 'invalid', 'bad request');
      else refuse(res, 500, 'invalid', 'internal error');
    });
  };
  return [authCheck, strictJsonParser];
}

/** Outbound headers for a request to the other side of the link; null when the secret is shorter than 32 chars (the caller records
 *  'link_off' / 'auth' and sends nothing). The secret is trimmed. Never logs the secret. */
export function linkHeaders(secret: string): Record<string, string> | null {
  if (!secretUsable(secret)) return null;
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${secret.trim()}` };
}
