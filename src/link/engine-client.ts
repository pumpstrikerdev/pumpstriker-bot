// R1-B1 (B10 section 3 rule 5): the bot's GETs to the Engine, all behind the link bearer (linkHeaders):
//   arms()        GET /api/bot/v1/arms          the evaluator's per-arm verdicts (ArmsStatusPayload)
//   token(ca)     GET /api/bot/v1/token/:ca     GMGN-only snapshot with a Sourced value per field (validated with validateTokenProxyResponse)
//   price(ca)     GET /api/bot/v1/price/:ca     the tracker's latest price with its as_of
// Timeout 1.5 s. The Engine offline, slow, refusing or answering nonsense gives a typed { error }; a default value is never made up
// (the bot holds no GMGN key and has no other price source for the protective legs, so "unknown" must stay "unknown").
import type { EngineClient } from '../bot-contracts';
import type { ArmId } from '../shared/common/ids';
import type { ArmsStatusPayload, ArmStatus } from '../shared/contract/v1';
import { validateTokenProxyResponse } from '../shared/contract/validate';
import { linkHeaders } from '../shared/link-auth';
import { defaultHttp, isRecord, isTimeout, parseJson, trimBase, type HttpFn, type HttpResponse } from './common';

export const ENGINE_CLIENT_TIMEOUT_MS = 1_500;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ARM_IDS: readonly ArmId[] = ['BS', 'B0', 'B1', 'B2'];
const VERDICTS: readonly string[] = ['INSUFFICIENT', 'PASS', 'FAIL', 'RETIRED', 'BIASED'];

export interface EngineClientDeps {
  /** ENGINE_URL */
  engineUrl: string;
  secret: () => string;
  http?: HttpFn;
  timeoutMs?: number;
}

type PriceAnswer = Exclude<Awaited<ReturnType<EngineClient['price']>>, { error: string }>;

const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isNumOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));

function parseArm(x: unknown): ArmStatus | null {
  if (!isRecord(x)) return null;
  if (typeof x.arm !== 'string' || !ARM_IDS.includes(x.arm as ArmId)) return null;
  if (typeof x.verdict !== 'string' || !VERDICTS.includes(x.verdict)) return null;
  if (!isMs(x.registered_at) || !isMs(x.evaluated_at)) return null;
  if (typeof x.registry_sha !== 'string' || typeof x.n_matured !== 'number' || typeof x.days !== 'number') return null;
  if (x.look !== 0 && x.look !== 1 && x.look !== 2 && x.look !== 3) return null;
  if (!isNumOrNull(x.lcb_token) || !isNumOrNull(x.lcb_day)) return null;
  if (x.report_id !== null && typeof x.report_id !== 'string') return null;
  return {
    arm: x.arm as ArmId, registered_at: x.registered_at, registry_sha: x.registry_sha, verdict: x.verdict as ArmStatus['verdict'],
    n_matured: x.n_matured, days: x.days, look: x.look, lcb_token: x.lcb_token, lcb_day: x.lcb_day, report_id: x.report_id, evaluated_at: x.evaluated_at,
  };
}

function parseArms(json: unknown): ArmsStatusPayload | null {
  if (!isRecord(json) || !Array.isArray(json.arms)) return null;
  const arms: ArmStatus[] = [];
  for (const a of json.arms) {
    const parsed = parseArm(a);
    if (parsed === null) return null;
    arms.push(parsed);
  }
  return { arms };
}

function parsePrice(json: unknown): PriceAnswer | null {
  if (!isRecord(json) || json.ok !== true || !isRecord(json.price)) return null;
  const p = json.price;
  const value = p.value === undefined ? null : p.value;
  const src = p.src === undefined ? null : p.src;
  const asOf = p.as_of === undefined ? null : p.as_of;
  if (value !== null && !(typeof value === 'number' && Number.isFinite(value))) return null;
  if (src !== null && typeof src !== 'string') return null;
  if (asOf !== null && !isMs(asOf)) return null;
  // the null <=> null <=> null invariant of every Sourced value
  if ((value === null) !== (src === null) || (value === null) !== (asOf === null)) return null;
  if (typeof json.frozen !== 'boolean' || typeof json.drained !== 'boolean') return null;
  return { price: { value, src, as_of: asOf }, frozen: json.frozen, drained: json.drained };
}

function errorOf(res: HttpResponse): { error: string } {
  const json = parseJson(res.body);
  const code = isRecord(json) && typeof json.code === 'string' ? json.code.slice(0, 40) : null;
  return { error: code !== null ? code : `http_${res.status}` };
}

export function createEngineClient(deps: EngineClientDeps): EngineClient {
  const http = deps.http ?? defaultHttp;
  const base = `${trimBase(deps.engineUrl)}/api/bot/v1`;
  const timeoutMs = deps.timeoutMs ?? ENGINE_CLIENT_TIMEOUT_MS;

  async function get(pathAndQuery: string): Promise<{ ok: true; json: unknown } | { error: string }> {
    const headers = linkHeaders(deps.secret());
    if (headers === null) return { error: 'link_off' };
    let res: HttpResponse;
    try {
      res = await http({ method: 'GET', url: `${base}${pathAndQuery}`, headers, timeoutMs });
    } catch (e) {
      return { error: isTimeout(e) ? 'timeout' : 'engine_offline' };
    }
    if (res.status !== 200) return errorOf(res);
    const json = parseJson(res.body);
    if (json === undefined) return { error: 'invalid_response' };
    return { ok: true, json };
  }

  return {
    async arms() {
      const r = await get('/arms');
      if ('error' in r) return r;
      return parseArms(r.json) ?? { error: 'invalid_response' };
    },
    async token(ca: string) {
      if (!BASE58_RE.test(ca)) return { error: 'invalid_ca' };
      const r = await get(`/token/${encodeURIComponent(ca)}`);
      if ('error' in r) return r;
      const v = validateTokenProxyResponse(r.json);
      return v.ok ? v.value : { error: 'invalid_response' };
    },
    async price(ca: string) {
      if (!BASE58_RE.test(ca)) return { error: 'invalid_ca' };
      const r = await get(`/price/${encodeURIComponent(ca)}`);
      if ('error' in r) return r;
      return parsePrice(r.json) ?? { error: 'invalid_response' };
    },
  };
}
