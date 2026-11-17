/**
 * TG Bot configuration (B50 section 2, R3-B5): bot keys only (read-bot-interface 7.1).
 *
 * The bot holds no GMGN key, no risk-report key, no pump.fun login and none of the Engine scoring knobs: they are gone from the env
 * reading, and since R4-B6 (plan grind #42, A-34) the stand-in constants for the score floor, the GMGN key and the risk-report key are
 * gone too: nothing reads them any more.
 *
 * Two kinds of readers live here:
 *   - CONFIG, built once from process.env when the module loads (the values the bot and the execution layer read as constants);
 *   - accessor functions (botPort, botDataDir, jupUrls, pumpPortalTradeLocalUrl, pumpfunCoinInfoUrl, rpcOnlyUrl, ...) that read the
 *     environment WHEN CALLED. The test-override keys (JUP_API_BASE, PUMPPORTAL_BASE, PUMPFUN_API_BASE, RPC_URL,
 *     RPC_FALLBACKS) are accessors, so a test can point the execution layer at a loopback server without re-importing a module.
 *     With the key unset every accessor returns exactly the literal the code used before (A-68: nothing changes when unset).
 *
 * R7-W6 adds the seven WALLET_* keys of the wallet link routes (design 14, rev 3 R3-7). There is no PumpPortal wallet route and no key for one.
 *
 * CONFIG_ENV_KEYS lists every environment key this file reads; the .env.example parity test compares it with the template.
 */
import 'dotenv/config';
import * as path from 'node:path';

export type EnvRecord = Readonly<Record<string, string | undefined>>;

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Every environment key read in this file (config.test.ts compares the list with .env.example). */
export const CONFIG_ENV_KEYS = [
  // identity and links
  'TG_BOT_TOKEN', 'TG_CHAT_ID', 'WALLET_ENC_KEY', 'SIGNAL_SHARED_SECRET', 'ENGINE_URL', 'BOT_PORT', 'BOT_DATA_DIR', 'TG_API_ROOT',
  // RPC lanes
  'RPC_URL', 'RPC_FALLBACKS', 'HELIUS_KEY', 'HELIUS_KEY_BOT', 'HELIUS_KEY_WALLET', 'HELIUS_RPC_URL', 'HELIUS_RPC_URL_BOT',
  'HELIUS_RPC_URL_WALLET', 'HELIUS_SEND_URL', 'HELIUS_SEND_URL_BOT', 'HELIUS_SENDER_URL', 'ALCHEMY_API_KEY',
  // execution venues (the base keys are the test overrides)
  'JUPITER_API_KEY', 'JUPITER_API_KEY_FALLBACK', 'USE_JUPITER_V3', 'JUP_ORDER_FALLBACK', 'JUP_API_BASE', 'PUMPPORTAL_BASE', 'PUMPFUN_API_BASE',
  // fees, rebates, sender
  'ENABLE_BACKRUN_REBATES', 'HELIUS_MARKETING_WALLET', 'ENABLE_DYNAMIC_PRIORITY_FEE', 'PRIORITY_FEE_LEVEL_NORMAL', 'PRIORITY_FEE_LEVEL_SNIPE',
  'PRIORITY_FEE_CACHE_MS', 'PRIORITY_FEE_FLOOR_MICROLAMPORTS', 'PRIORITY_FEE_CEILING_MICROLAMPORTS', 'ENABLE_SENDER_KEEPALIVE', 'SENDER_KEEPALIVE_MS',
  // auto-buy and exits
  'BOT_DRY_RUN', 'AUTOBUY_STALE_MS', 'AUTO_BUY_MAX_PER_HOUR', 'AUTO_BUY_MAX_PER_DAY', 'AUTO_BUY_MAX_SOL_PER_DAY',
  'AUTO_BUY_MAX_OPEN_POSITIONS', 'AUTO_BUY_RESERVE_SOL', 'AUTOBUY_MAX_IMPACT_PCT', 'AUTOBUY_PAUSE_AFTER_FAILS', 'AUTOBUY_ROLLING_N',
  'AUTOBUY_ROLLING_MIN_NET', 'EXIT_POLICY_ID', 'EXIT_YOUNG_CADENCE_MS', 'EXIT_CADENCE_MS', 'EXIT_YOUNG_AGE_MS', 'EXIT_QUOTE_CONCURRENCY',
  'HARD_RUG_DROP_PCT',
  // the auto-buy PILOT (A-114, owner decision 2026-10-26): live auto-buy without a go-live PASS, tiny amounts only
  'AUTOBUY_PILOT', 'AUTOBUY_PILOT_MAX_SOL', 'AUTOBUY_PILOT_MAX_PER_DAY',
  // Telegram link
  'TG_REPLAY_MAX_AGE_MS', 'TG_LATE_MS', 'TG_PACE_MAX_PER_10MIN',
  // wallet link routes (R7-W6, A-99, A-104): the Engine's browser-wallet flows, unsigned builds only
  'WALLET_LINK_ROUTES', 'WALLET_RPC_DAILY_CALL_CAP', 'WALLET_RPC_MAX_PER_SEC', 'WALLET_FILL_POLL_MS', 'WALLET_TX_MAX_BYTES',
  'WALLET_PRIORITY_MIN_MICROLAMPORTS', 'WALLET_PRIORITY_MAX_MICROLAMPORTS',
] as const;
export type ConfigEnvKey = (typeof CONFIG_ENV_KEYS)[number];

// ---------------------------------------------------------------------------------------------------------------------------------
// small readers (a blank value is the same as an unset one)
// ---------------------------------------------------------------------------------------------------------------------------------

function raw(env: EnvRecord, key: ConfigEnvKey): string {
  const v = env[key];
  return typeof v === 'string' ? v.trim() : '';
}

function str(env: EnvRecord, key: ConfigEnvKey, dflt: string): string {
  const v = raw(env, key);
  return v === '' ? dflt : v;
}

/** `Number(value) || default`: a missing, blank, zero or non-numeric value gives the default. */
function numOr(env: EnvRecord, key: ConfigEnvKey, dflt: number): number {
  return Number(env[key]) || dflt;
}

/** A positive whole number, else the default. */
function posInt(env: EnvRecord, key: ConfigEnvKey, dflt: number): number {
  const v = raw(env, key);
  if (!/^\d+$/.test(v)) return dflt;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : dflt;
}

/** A whole number from `min` to `max` (inclusive), else the default: an out-of-range value is never clamped into a looser one. */
function intInRange(env: EnvRecord, key: ConfigEnvKey, dflt: number, min: number, max: number): number {
  const v = raw(env, key);
  if (!/^\d+$/.test(v)) return dflt;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : dflt;
}

/** A finite number (any sign), else the default. */
function finiteNum(env: EnvRecord, key: ConfigEnvKey, dflt: number): number {
  const v = raw(env, key);
  if (v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

const OFF_WORDS: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off']);

/** A flag that is on unless the value is an explicit off word. */
function onUnlessOff(env: EnvRecord, key: ConfigEnvKey): boolean {
  const v = raw(env, key).toLowerCase();
  return !OFF_WORDS.has(v);
}

/** A base URL: http(s) only, no trailing slash. Anything else (blank, a bare word, another scheme) gives the default. */
function baseUrl(env: EnvRecord, key: ConfigEnvKey, dflt: string): string {
  const v = raw(env, key);
  if (v === '') return dflt;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return dflt;
  } catch {
    return dflt;
  }
  return v.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// accessors that read the environment when they are called
// ---------------------------------------------------------------------------------------------------------------------------------

export const DEFAULT_BOT_PORT = 3748;
export const DEFAULT_ENGINE_URL = 'http://127.0.0.1:1002';
export const DEFAULT_TG_API_ROOT = 'https://api.telegram.org';

/** BOT_PORT. 0 (an OS-assigned port) is accepted only when NODE_ENV=test; a value outside 1..65535 gives the default. */
export function botPort(env: EnvRecord = process.env): number {
  const v = raw(env, 'BOT_PORT');
  if (v === '' || !/^\d+$/.test(v)) return DEFAULT_BOT_PORT;
  const n = Number(v);
  if (n === 0) return env.NODE_ENV === 'test' ? 0 : DEFAULT_BOT_PORT;
  return n >= 1 && n <= 65535 ? n : DEFAULT_BOT_PORT;
}

/** BOT_DATA_DIR: an absolute folder, default `<cwd>/data`. The cutover passes the absolute live folder. */
export function botDataDir(env: EnvRecord = process.env): string {
  const v = raw(env, 'BOT_DATA_DIR');
  return v === '' ? path.join(process.cwd(), 'data') : path.resolve(v);
}

/** ENGINE_URL without a trailing slash. */
export function engineUrl(env: EnvRecord = process.env): string {
  return str(env, 'ENGINE_URL', DEFAULT_ENGINE_URL).replace(/\/+$/, '');
}

/** TG_API_ROOT: the Telegram API root (the E2E harness points it at a local fake; R4-B6 passes it to telegraf's apiRoot). */
export function tgApiRoot(env: EnvRecord = process.env): string {
  return baseUrl(env, 'TG_API_ROOT', DEFAULT_TG_API_ROOT);
}

/** BOT_DRY_RUN: dry run unless the value is an explicit off word (same rule as autobuy/guards.ts dryRunFromEnv). */
export function botDryRun(env: EnvRecord = process.env): boolean {
  return onUnlessOff(env, 'BOT_DRY_RUN');
}

export const JUP_API_BASE_DEFAULT = 'https://api.jup.ag';
export const PUMPPORTAL_BASE_DEFAULT = 'https://pumpportal.fun';
export const PUMPFUN_API_BASE_DEFAULT = 'https://frontend-api-v3.pump.fun';

/** JUP_API_BASE (test override): the keyed Jupiter host every JUP_* URL derives from. */
export function jupApiBase(env: EnvRecord = process.env): string {
  return baseUrl(env, 'JUP_API_BASE', JUP_API_BASE_DEFAULT);
}

export interface JupUrls {
  build: string;
  quote: string;
  swap: string;
  order: string;
  execute: string;
}

/**
 * Every Jupiter endpoint the execution layer uses, all on the one keyed host JUP_API_BASE (unset: https://api.jup.ag). FIX-BUY2 item 1:
 * there is no keyless or lite-api.jup.ag tier any more (Jupiter is retiring that gateway with shrinking limits; a request without a key is
 * keyless at 0.5 requests/s, and a 400 is the same answer on every host), so the old JUP_FALLBACK_BASE override and its URLs are gone.
 */
export function jupUrls(env: EnvRecord = process.env): JupUrls {
  const a = jupApiBase(env);
  return {
    build: `${a}/swap/v2/build`,
    quote: `${a}/swap/v1/quote`,
    swap: `${a}/swap/v1/swap`,
    order: `${a}/swap/v2/order`,
    execute: `${a}/swap/v2/execute`,
  };
}

/** Which trades may try Jupiter /swap/v2/order + /execute after /swap/v2/build answered "No routes found" (FIX-BUY2 item 7). */
export type JupOrderFallback = 'off' | 'sell' | 'both';

/**
 * JUP_ORDER_FALLBACK: off (default) | sell | both. When on for the trade's side, a /swap/v2/build "No routes found" is followed by ONE
 * /swap/v2/order (Jupiter's meta-aggregator: OKX, Dflow or Metis may still route a market Metis dropped; JupiterZ RFQ is excluded) and
 * /execute. Off until the owner says yes: /order charges Jupiter's platform fee (0.5 % on tokens under 24 h, 0.1 % on older memecoins).
 * Any other value is off.
 */
export function jupOrderFallback(env: EnvRecord = process.env): JupOrderFallback {
  const v = raw(env, 'JUP_ORDER_FALLBACK').toLowerCase();
  return v === 'sell' || v === 'both' ? v : 'off';
}

/** PUMPPORTAL_BASE (test override). */
export function pumpPortalBase(env: EnvRecord = process.env): string {
  return baseUrl(env, 'PUMPPORTAL_BASE', PUMPPORTAL_BASE_DEFAULT);
}

/** The PumpPortal trade-local endpoint, derived from PUMPPORTAL_BASE. */
export function pumpPortalTradeLocalUrl(env: EnvRecord = process.env): string {
  return `${pumpPortalBase(env)}/api/trade-local`;
}

/** PUMPFUN_API_BASE (test override). */
export function pumpfunApiBase(env: EnvRecord = process.env): string {
  return baseUrl(env, 'PUMPFUN_API_BASE', PUMPFUN_API_BASE_DEFAULT);
}

/** The pump.fun coin-info endpoint of one mint, derived from PUMPFUN_API_BASE. */
export function pumpfunCoinInfoUrl(ca: string, env: EnvRecord = process.env): string {
  return `${pumpfunApiBase(env)}/coins-v2/${ca}`;
}

/** RPC_URL: one explicit RPC endpoint. Empty = not set. */
export function rpcUrlOverride(env: EnvRecord = process.env): string {
  return raw(env, 'RPC_URL');
}

/** RPC_FALLBACKS: on unless the value is an explicit off word. */
export function rpcFallbacksEnabled(env: EnvRecord = process.env): boolean {
  return onUnlessOff(env, 'RPC_FALLBACKS');
}

/**
 * The only RPC endpoint to use, or null for the normal pool. Set when RPC_URL is set AND RPC_FALLBACKS=off: then resilientRpcCall
 * and getTokenProgramForMint use this one URL and nothing else (no public RPCs, no mainnet-beta, no derived provider lanes).
 */
export function rpcOnlyUrl(env: EnvRecord = process.env): string | null {
  const url = rpcUrlOverride(env);
  return url !== '' && !rpcFallbacksEnabled(env) ? url : null;
}

/**
 * A-114: AUTOBUY_PILOT, AUTOBUY_PILOT_MAX_SOL, AUTOBUY_PILOT_MAX_PER_DAY with the rules of autobuy/pilot.ts pilotConfigFromEnv: on only
 * for exactly 1/true/on/yes (trimmed, any case); max SOL default 0.01, a value above 0.05 is clamped to 0.05; max per day default 3, a whole
 * number above 10 is clamped to 10; an unusable value (not a number, <= 0, a fractional or zero count) keeps the pilot OFF.
 */
function pilotFromEnv(env: EnvRecord): { on: boolean; maxSol: number; maxPerDay: number } {
  const requested = ['1', 'true', 'on', 'yes'].includes(raw(env, 'AUTOBUY_PILOT').toLowerCase());
  let ok = true;
  let maxSol = 0.01;
  const s = raw(env, 'AUTOBUY_PILOT_MAX_SOL');
  if (s !== '') {
    const n = /^(\d+(\.\d*)?|\.\d+)$/.test(s) ? Number(s) : NaN;
    if (!Number.isFinite(n) || !(n >= 1e-9)) ok = false;
    else maxSol = Math.min(n, 0.05);
  }
  let maxPerDay = 3;
  const d = raw(env, 'AUTOBUY_PILOT_MAX_PER_DAY');
  if (d !== '') {
    const n = /^\d+$/.test(d) ? Number(d) : NaN;
    if (!Number.isSafeInteger(n) || n < 1) ok = false;
    else maxPerDay = Math.min(n, 10);
  }
  return ok ? { on: requested, maxSol, maxPerDay } : { on: false, maxSol: 0.01, maxPerDay: 3 };
}

/** The non-secret keys the modules that take an env record read (auto-buy, exits, dry run, Telegram pacing). */
const SNAPSHOT_KEY_RE = /^(AUTOBUY_|AUTO_BUY_|EXIT_|HARD_RUG_|TG_REPLAY_|TG_LATE_|TG_PACE_|BOT_DRY_RUN$)/;

/** A copy of those keys of `env` for the modules that take an env record (autobuy/api.ts, trade-guards.ts). Never a secret, never another key. */
export function envSnapshot(env: EnvRecord = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of CONFIG_ENV_KEYS) if (SNAPSHOT_KEY_RE.test(k)) out[k] = env[k];
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// wallet link routes (R7-W6; design 14 and rev 3 R3-7): defaults and bounds
// ---------------------------------------------------------------------------------------------------------------------------------

/** The wallet RPC budget (design 6.5): calls per UTC day for all wallet traffic together. */
export const WALLET_RPC_DAILY_CALL_CAP_DEFAULT = 3000;
/** The global per-second bucket of all wallet RPC traffic (1-10): wallet work can never take the provider's per-second allowance from auto-buy and exits. */
export const WALLET_RPC_MAX_PER_SEC_DEFAULT = 4;
export const WALLET_RPC_MAX_PER_SEC_MAX = 10;
/** The fill poll interval; below the minimum a poll loop would burn the RPC budget. */
export const WALLET_FILL_POLL_MS_DEFAULT = 2000;
export const WALLET_FILL_POLL_MS_MIN = 1500;
/** The largest serialized wallet transaction: 1232 (the packet limit) minus 100 bytes of headroom for instructions a wallet adds. */
export const WALLET_TX_MAX_BYTES_DEFAULT = 1100;
export const WALLET_TX_MAX_BYTES_MAX = 1132;
/** The compute-unit price range a wallet transaction may carry, in micro-lamports per unit (the page constant caps it at 1 000 000). */
export const WALLET_PRIORITY_MIN_MICROLAMPORTS_DEFAULT = 10_000;
export const WALLET_PRIORITY_MAX_MICROLAMPORTS_DEFAULT = 1_000_000;
export const WALLET_PRIORITY_MAX_MICROLAMPORTS_CAP = 1_000_000;

/** The compute-unit price range: the default pair unless both values are valid and the minimum does not exceed the maximum. */
function walletPriorityRange(env: EnvRecord): { min: number; max: number } {
  const min = intInRange(env, 'WALLET_PRIORITY_MIN_MICROLAMPORTS', WALLET_PRIORITY_MIN_MICROLAMPORTS_DEFAULT, 1, WALLET_PRIORITY_MAX_MICROLAMPORTS_CAP);
  const max = intInRange(env, 'WALLET_PRIORITY_MAX_MICROLAMPORTS', WALLET_PRIORITY_MAX_MICROLAMPORTS_DEFAULT, 1, WALLET_PRIORITY_MAX_MICROLAMPORTS_CAP);
  return min <= max ? { min, max } : { min: WALLET_PRIORITY_MIN_MICROLAMPORTS_DEFAULT, max: WALLET_PRIORITY_MAX_MICROLAMPORTS_DEFAULT };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------------------------------------------------------------

const HELIUS_TIP_ACCOUNTS: string[] = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
];

export function buildConfig(env: EnvRecord = process.env) {
  // Helius lanes. A bot-lane key (separate trading key) and a wallet-lane key fall back to the main key, as before.
  const heliusKey = raw(env, 'HELIUS_KEY');
  const botKey = raw(env, 'HELIUS_KEY_BOT') || heliusKey;
  const walletKey = raw(env, 'HELIUS_KEY_WALLET') || heliusKey;
  const alchemyKey = raw(env, 'ALCHEMY_API_KEY');
  const rpcFor = (key: string): string => (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : '');
  const sendFor = (key: string): string => (key ? `https://sg-sender.helius-rpc.com/fast?api-key=${key}` : '');

  return {
    // --- identity and links ---
    TG_BOT_TOKEN: env.TG_BOT_TOKEN || '',
    TG_CHAT_ID: env.TG_CHAT_ID || '',
    /** Wallet encryption secret. Unset = derived from TG_BOT_TOKEN (wallet-crypto.ts). */
    WALLET_ENC_KEY: env.WALLET_ENC_KEY || '',
    /** Shared link secret, at least 32 characters in both .env files; shorter or unset = the link refuses everything (fail closed). */
    SIGNAL_SHARED_SECRET: env.SIGNAL_SHARED_SECRET || '',
    ENGINE_URL: engineUrl(env),
    BOT_PORT: botPort(env),
    TG_API_ROOT: tgApiRoot(env),

    // --- RPC lanes ---
    HELIUS_KEY: heliusKey,
    HELIUS_KEY_BOT: botKey,
    HELIUS_KEY_WALLET: walletKey,
    HELIUS_RPC: raw(env, 'HELIUS_RPC_URL') || rpcFor(heliusKey),
    HELIUS_RPC_BOT: raw(env, 'HELIUS_RPC_URL_BOT') || rpcFor(botKey),
    HELIUS_RPC_WALLET: raw(env, 'HELIUS_RPC_URL_WALLET') || rpcFor(walletKey),
    HELIUS_SEND_URL: raw(env, 'HELIUS_SEND_URL') || sendFor(heliusKey),
    HELIUS_SEND_URL_BOT: raw(env, 'HELIUS_SEND_URL_BOT') || sendFor(botKey),
    /** Helius Sender: keyless fast send (preferred over the gatekeeper URL). */
    HELIUS_SENDER_URL: raw(env, 'HELIUS_SENDER_URL') || 'https://sender.helius-rpc.com/fast',
    ALCHEMY_RPC: alchemyKey ? `https://solana-mainnet.g.alchemy.com/v2/${alchemyKey}` : '',

    // --- execution ---
    /** Jupiter server key (developer portal). FIX-BUY2: every Jupiter request carries it; without it the Jupiter route refuses
     *  ("JUPITER_API_KEY missing") instead of falling back to a keyless tier. */
    JUPITER_API_KEY: env.JUPITER_API_KEY || '',
    /** Tried once after a 401/403 of the first key, and after its 429/5xx backoffs. A 400 is never replayed on it. */
    JUPITER_API_KEY_FALLBACK: env.JUPITER_API_KEY_FALLBACK || '',
    /** Jupiter v3 order+execute flow. Off by default (the legacy quote + build path is the verified one). */
    USE_JUPITER_V3: env.USE_JUPITER_V3 === '1',
    /** FIX-BUY2 item 7: ONE /swap/v2/order + /execute after a /swap/v2/build no-route, for 'sell' or 'both' sides; default 'off'. */
    JUP_ORDER_FALLBACK: jupOrderFallback(env),
    SOL_MINT,
    HELIUS_TIP_ACCOUNTS,
    ENABLE_BACKRUN_REBATES: env.ENABLE_BACKRUN_REBATES !== '0',
    /** The user's own rebate wallet. No default (PUB-1): empty = rebates do nothing until a wallet is set here or with /rebates. */
    HELIUS_MARKETING_WALLET: env.HELIUS_MARKETING_WALLET || '',
    ENABLE_DYNAMIC_PRIORITY_FEE: env.ENABLE_DYNAMIC_PRIORITY_FEE !== '0',
    PRIORITY_FEE_LEVEL_NORMAL: env.PRIORITY_FEE_LEVEL_NORMAL || 'High',
    PRIORITY_FEE_LEVEL_SNIPE: env.PRIORITY_FEE_LEVEL_SNIPE || 'VeryHigh',
    PRIORITY_FEE_CACHE_MS: numOr(env, 'PRIORITY_FEE_CACHE_MS', 5_000),
    PRIORITY_FEE_FLOOR_MICROLAMPORTS: numOr(env, 'PRIORITY_FEE_FLOOR_MICROLAMPORTS', 50_000),
    PRIORITY_FEE_CEILING_MICROLAMPORTS: numOr(env, 'PRIORITY_FEE_CEILING_MICROLAMPORTS', 5_000_000),
    ENABLE_SENDER_KEEPALIVE: env.ENABLE_SENDER_KEEPALIVE !== '0',
    SENDER_KEEPALIVE_MS: numOr(env, 'SENDER_KEEPALIVE_MS', 45_000),

    // --- auto-buy and exits (defaults of B50 section 2; the modules also parse these from an env record) ---
    BOT_DRY_RUN: botDryRun(env),
    AUTOBUY_STALE_MS: posInt(env, 'AUTOBUY_STALE_MS', 5_000),
    AUTO_BUY_MAX_PER_HOUR: posInt(env, 'AUTO_BUY_MAX_PER_HOUR', 3),
    AUTO_BUY_MAX_PER_DAY: posInt(env, 'AUTO_BUY_MAX_PER_DAY', 20),
    /** null = 20 x the buy amount (derived where the buy amount is known). */
    AUTO_BUY_MAX_SOL_PER_DAY: ((): number | null => {
      const v = raw(env, 'AUTO_BUY_MAX_SOL_PER_DAY');
      const n = Number(v);
      return v !== '' && Number.isFinite(n) && n >= 0 ? n : null;
    })(),
    AUTO_BUY_MAX_OPEN_POSITIONS: posInt(env, 'AUTO_BUY_MAX_OPEN_POSITIONS', 5),
    AUTO_BUY_RESERVE_SOL: ((): number => {
      const v = raw(env, 'AUTO_BUY_RESERVE_SOL');
      const n = Number(v);
      return v !== '' && Number.isFinite(n) && n >= 0 ? n : 0.03;
    })(),
    AUTOBUY_MAX_IMPACT_PCT: finiteNum(env, 'AUTOBUY_MAX_IMPACT_PCT', 15),
    AUTOBUY_PAUSE_AFTER_FAILS: posInt(env, 'AUTOBUY_PAUSE_AFTER_FAILS', 3),
    AUTOBUY_ROLLING_N: posInt(env, 'AUTOBUY_ROLLING_N', 50),
    AUTOBUY_ROLLING_MIN_NET: finiteNum(env, 'AUTOBUY_ROLLING_MIN_NET', -0.15),
    EXIT_POLICY_ID: str(env, 'EXIT_POLICY_ID', 'EA'),
    EXIT_YOUNG_CADENCE_MS: posInt(env, 'EXIT_YOUNG_CADENCE_MS', 5_000),
    EXIT_CADENCE_MS: posInt(env, 'EXIT_CADENCE_MS', 15_000),
    EXIT_YOUNG_AGE_MS: posInt(env, 'EXIT_YOUNG_AGE_MS', 600_000),
    EXIT_QUOTE_CONCURRENCY: posInt(env, 'EXIT_QUOTE_CONCURRENCY', 4),
    HARD_RUG_DROP_PCT: ((): number => {
      const n = Number(raw(env, 'HARD_RUG_DROP_PCT') || NaN);
      return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 40;
    })(),
    // --- the auto-buy PILOT (A-114). autobuy/pilot.ts pilotConfigFromEnv is what auto-buy acts on (its env snapshot); these are the
    //     same rules for the config view (pilot.test.ts PILOT-T02b pins the two together). config.ts imports nothing of autobuy/. ---
    /** True only when AUTOBUY_PILOT is 1/true/on/yes AND both pilot limits are usable (an unusable limit refuses the pilot). */
    AUTOBUY_PILOT: pilotFromEnv(env).on,
    /** SOL per pilot buy at most (default 0.01; above 0.05 is clamped to 0.05; an unusable value refuses the pilot). */
    AUTOBUY_PILOT_MAX_SOL: pilotFromEnv(env).maxSol,
    /** Pilot buys per UTC day at most (default 3; whole number 1..10, above 10 is clamped to 10; an unusable value refuses the pilot). */
    AUTOBUY_PILOT_MAX_PER_DAY: pilotFromEnv(env).maxPerDay,

    // --- Telegram link (A-52) ---
    TG_REPLAY_MAX_AGE_MS: posInt(env, 'TG_REPLAY_MAX_AGE_MS', 600_000),
    TG_LATE_MS: posInt(env, 'TG_LATE_MS', 30_000),
    TG_PACE_MAX_PER_10MIN: posInt(env, 'TG_PACE_MAX_PER_10MIN', 8),

    // --- wallet link routes (R7-W6, A-99, A-104): on unless an explicit off word; off = the six /v1/wallet routes are not mounted (404) ---
    WALLET_LINK_ROUTES: onUnlessOff(env, 'WALLET_LINK_ROUTES'),
    WALLET_RPC_DAILY_CALL_CAP: posInt(env, 'WALLET_RPC_DAILY_CALL_CAP', WALLET_RPC_DAILY_CALL_CAP_DEFAULT),
    WALLET_RPC_MAX_PER_SEC: intInRange(env, 'WALLET_RPC_MAX_PER_SEC', WALLET_RPC_MAX_PER_SEC_DEFAULT, 1, WALLET_RPC_MAX_PER_SEC_MAX),
    /** An invalid value or one below the minimum gives the default (never a faster poll than the minimum). */
    WALLET_FILL_POLL_MS: intInRange(env, 'WALLET_FILL_POLL_MS', WALLET_FILL_POLL_MS_DEFAULT, WALLET_FILL_POLL_MS_MIN, 3_600_000),
    WALLET_TX_MAX_BYTES: intInRange(env, 'WALLET_TX_MAX_BYTES', WALLET_TX_MAX_BYTES_DEFAULT, 1, WALLET_TX_MAX_BYTES_MAX),
    WALLET_PRIORITY_MIN_MICROLAMPORTS: walletPriorityRange(env).min,
    WALLET_PRIORITY_MAX_MICROLAMPORTS: walletPriorityRange(env).max,
  };
}

export type BotConfig = ReturnType<typeof buildConfig>;

export const CONFIG: BotConfig = buildConfig(process.env);
