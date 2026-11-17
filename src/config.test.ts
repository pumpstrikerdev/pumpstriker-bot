/**
 * B50 section 2 (R3-B5): the bot configuration. The defaults of the table in the spec, the test-override accessors (unset = the
 * literals the code used before), the BOT_PORT rule, and the .env.example parity test. The literal bot port may appear
 * in this file (guard G-S17: config-default assertions).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  CONFIG, CONFIG_ENV_KEYS, DEFAULT_BOT_PORT, WALLET_FILL_POLL_MS_MIN, WALLET_PRIORITY_MAX_MICROLAMPORTS_CAP, WALLET_RPC_MAX_PER_SEC_MAX, WALLET_TX_MAX_BYTES_MAX,
  botDataDir, botDryRun, botPort, buildConfig, engineUrl, envSnapshot, jupApiBase, jupOrderFallback, jupUrls,
  pumpPortalBase, pumpPortalTradeLocalUrl, pumpfunApiBase, pumpfunCoinInfoUrl, rpcFallbacksEnabled, rpcOnlyUrl, rpcUrlOverride, tgApiRoot,
} from './config';
import { WALLET_TX_BYTES_HARD_MAX } from './shared/contract/wallet-validate';
import { AUTOBUY_STALE_MS } from './autobuy/decide';
import { AUTOBUY_MAX_IMPACT_PCT_DEFAULT, AUTOBUY_PAUSE_AFTER_FAILS_DEFAULT, AUTOBUY_ROLLING_MIN_NET_DEFAULT, AUTOBUY_ROLLING_N_DEFAULT } from './autobuy/guards';
import { AUTO_BUY_CODE_DEFAULTS } from './bot/trade-guards';
import { DEFAULT_EXIT_CONFIG } from './exits/exit-engine';
import { TG_REPLAY_MAX_AGE_MS } from './intake/handlers';
import { TG_LATE_MS } from './tg/cards';
import { TG_PACE_MAX_PER_10MIN } from './tg/send-queue';

const BOT_ROOT = path.resolve(__dirname, '..');
const SRC = __dirname;

/** Keys of .env.example: `KEY=value` lines, commented or not. */
function exampleKeys(): string[] {
  const keys = new Set<string>();
  for (const line of fs.readFileSync(path.join(BOT_ROOT, '.env.example'), 'utf8').split(/\r?\n/)) {
    const m = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m) keys.add(m[1]);
  }
  return [...keys];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('defaults (B50 section 2)', () => {
  const c = buildConfig({});

  it('the auto-buy, exit and Telegram defaults of the spec table', () => {
    expect(c).toMatchObject({
      BOT_DRY_RUN: true, AUTOBUY_STALE_MS: 5000, AUTO_BUY_MAX_PER_HOUR: 3, AUTO_BUY_MAX_PER_DAY: 20, AUTO_BUY_MAX_SOL_PER_DAY: null,
      AUTO_BUY_MAX_OPEN_POSITIONS: 5, AUTO_BUY_RESERVE_SOL: 0.03, AUTOBUY_MAX_IMPACT_PCT: 15, AUTOBUY_PAUSE_AFTER_FAILS: 3,
      AUTOBUY_ROLLING_N: 50, AUTOBUY_ROLLING_MIN_NET: -0.15, EXIT_POLICY_ID: 'EA', EXIT_YOUNG_CADENCE_MS: 5000, EXIT_CADENCE_MS: 15000,
      EXIT_YOUNG_AGE_MS: 600000, EXIT_QUOTE_CONCURRENCY: 4, HARD_RUG_DROP_PCT: 40,
      TG_REPLAY_MAX_AGE_MS: 600000, TG_LATE_MS: 30000, TG_PACE_MAX_PER_10MIN: 8,
      ENGINE_URL: 'http://127.0.0.1:1002', BOT_PORT: 3748, TG_API_ROOT: 'https://api.telegram.org', SIGNAL_SHARED_SECRET: '',
    });
  });

  it('the defaults equal the constants of the modules that use them (one number, two places)', () => {
    expect(c.AUTOBUY_STALE_MS).toBe(AUTOBUY_STALE_MS);
    expect(c.AUTOBUY_MAX_IMPACT_PCT).toBe(AUTOBUY_MAX_IMPACT_PCT_DEFAULT);
    expect(c.AUTOBUY_PAUSE_AFTER_FAILS).toBe(AUTOBUY_PAUSE_AFTER_FAILS_DEFAULT);
    expect(c.AUTOBUY_ROLLING_N).toBe(AUTOBUY_ROLLING_N_DEFAULT);
    expect(c.AUTOBUY_ROLLING_MIN_NET).toBe(AUTOBUY_ROLLING_MIN_NET_DEFAULT);
    expect(c.AUTO_BUY_MAX_PER_HOUR).toBe(AUTO_BUY_CODE_DEFAULTS.perHour);
    expect(c.AUTO_BUY_MAX_PER_DAY).toBe(AUTO_BUY_CODE_DEFAULTS.perDay);
    expect(c.AUTO_BUY_MAX_OPEN_POSITIONS).toBe(AUTO_BUY_CODE_DEFAULTS.maxOpen);
    expect(c.AUTO_BUY_RESERVE_SOL).toBe(AUTO_BUY_CODE_DEFAULTS.reserveSol);
    expect(c.EXIT_YOUNG_CADENCE_MS).toBe(DEFAULT_EXIT_CONFIG.youngCadenceMs);
    expect(c.EXIT_CADENCE_MS).toBe(DEFAULT_EXIT_CONFIG.cadenceMs);
    expect(c.EXIT_YOUNG_AGE_MS).toBe(DEFAULT_EXIT_CONFIG.youngAgeMs);
    expect(c.EXIT_QUOTE_CONCURRENCY).toBe(DEFAULT_EXIT_CONFIG.concurrency);
    expect(c.HARD_RUG_DROP_PCT).toBe(DEFAULT_EXIT_CONFIG.hardRugDropPct);
    expect(c.TG_REPLAY_MAX_AGE_MS).toBe(TG_REPLAY_MAX_AGE_MS);
    expect(c.TG_LATE_MS).toBe(TG_LATE_MS);
    expect(c.TG_PACE_MAX_PER_10MIN).toBe(TG_PACE_MAX_PER_10MIN);
  });

  it('A-52 keys are read, positive whole numbers only', () => {
    expect(buildConfig({ TG_REPLAY_MAX_AGE_MS: '120000', TG_LATE_MS: '15000', TG_PACE_MAX_PER_10MIN: '4' })).toMatchObject({
      TG_REPLAY_MAX_AGE_MS: 120000, TG_LATE_MS: 15000, TG_PACE_MAX_PER_10MIN: 4,
    });
    for (const bad of ['', '0', '-5', 'abc', '1.5', '1e3']) {
      expect(buildConfig({ TG_LATE_MS: bad }).TG_LATE_MS, bad).toBe(30000);
    }
  });

  it('BOT_DRY_RUN is on unless the value is an explicit off word', () => {
    expect(botDryRun({})).toBe(true);
    for (const v of ['1', 'on', 'yes', 'true', '', 'garbage']) expect(botDryRun({ BOT_DRY_RUN: v }), v).toBe(true);
    for (const v of ['0', 'false', 'no', 'off', ' OFF ']) expect(botDryRun({ BOT_DRY_RUN: v }), v).toBe(false);
  });

  it('the removed keys are not read from the environment and no deprecated stand-in constant is left (R4-B6, A-34)', () => {
    const c2 = buildConfig({ BOT_SCORE_FLOOR: '5', GMGN_API_KEY: 'g'.repeat(20), RUGCHECK_KEY: 'r'.repeat(20), PUMPFUN_JWT: 'j'.repeat(20), MIN_SIGNAL_SCORE: '1' }) as Record<string, unknown>;
    for (const k of ['BOT_SCORE_FLOOR', 'GMGN_API_KEY', 'RUGCHECK_KEY', 'PUMPFUN_JWT', 'PUMPFUN_LOGIN_PRIVKEY', 'INSIGHTX_KEY', 'GOPLUS_APPKEY', 'MIN_SIGNAL_SCORE', 'FIRE_SCORE', 'ENABLE_ULTRA_TIER']) {
      expect(k in c2, k).toBe(false);
    }
    expect(fs.readFileSync(path.join(SRC, 'config.ts'), 'utf8')).not.toMatch(/@deprecated/);
  });

  it('the Helius lanes keep their fallbacks (bot key and wallet key fall back to the main key)', () => {
    const k = buildConfig({ HELIUS_KEY: 'mainkey' });
    expect(k.HELIUS_RPC).toBe('https://mainnet.helius-rpc.com/?api-key=mainkey');
    expect(k.HELIUS_RPC_BOT).toBe(k.HELIUS_RPC);
    expect(k.HELIUS_KEY_BOT).toBe('mainkey');
    expect(k.HELIUS_SEND_URL_BOT).toBe('https://sg-sender.helius-rpc.com/fast?api-key=mainkey');
    expect(buildConfig({ HELIUS_KEY: 'mainkey', HELIUS_KEY_BOT: 'botkey' }).HELIUS_RPC_BOT).toBe('https://mainnet.helius-rpc.com/?api-key=botkey');
    expect(buildConfig({}).HELIUS_RPC).toBe('');
    expect(buildConfig({ ALCHEMY_API_KEY: 'ak' }).ALCHEMY_RPC).toBe('https://solana-mainnet.g.alchemy.com/v2/ak');
  });

  it('the test process config is the empty-env config', () => {
    expect(CONFIG.BOT_PORT).toBe(DEFAULT_BOT_PORT);
    expect(CONFIG.BOT_DRY_RUN).toBe(true);
  });

  it('PUB-1 there is no default payout wallet: HELIUS_MARKETING_WALLET is empty unless the env names one; the rebate switch keeps its default', () => {
    expect(c.HELIUS_MARKETING_WALLET).toBe('');
    expect(CONFIG.HELIUS_MARKETING_WALLET).toBe('');
    const own = Keypair.generate().publicKey.toBase58();   // a throwaway wallet, made at run time
    expect(buildConfig({ HELIUS_MARKETING_WALLET: own }).HELIUS_MARKETING_WALLET).toBe(own);
    expect(c.ENABLE_BACKRUN_REBATES).toBe(true);
    expect(buildConfig({ ENABLE_BACKRUN_REBATES: '0' }).ENABLE_BACKRUN_REBATES).toBe(false);
    // no fallback literal behind the env value in the source either
    expect(fs.readFileSync(path.join(SRC, 'config.ts'), 'utf8')).not.toMatch(/env\.HELIUS_MARKETING_WALLET\s*\|\|\s*'[^']+'/);
  });
});

describe('wallet link keys (R7-W6, design 14 and rev 3 R3-7)', () => {
  const WALLET_KEYS = [
    'WALLET_LINK_ROUTES', 'WALLET_RPC_DAILY_CALL_CAP', 'WALLET_RPC_MAX_PER_SEC', 'WALLET_FILL_POLL_MS', 'WALLET_TX_MAX_BYTES',
    'WALLET_PRIORITY_MIN_MICROLAMPORTS', 'WALLET_PRIORITY_MAX_MICROLAMPORTS',
  ] as const;

  it('WBL-T09 the seven bot wallet keys: defaults, bounds and .env.example parity; there is no PumpPortal wallet key and no SOL maximum', () => {
    // defaults (design 14)
    expect(buildConfig({})).toMatchObject({
      WALLET_LINK_ROUTES: true, WALLET_RPC_DAILY_CALL_CAP: 3000, WALLET_RPC_MAX_PER_SEC: 4, WALLET_FILL_POLL_MS: 2000, WALLET_TX_MAX_BYTES: 1100,
      WALLET_PRIORITY_MIN_MICROLAMPORTS: 10_000, WALLET_PRIORITY_MAX_MICROLAMPORTS: 1_000_000,
    });
    // valid values are read
    expect(buildConfig({
      WALLET_LINK_ROUTES: '0', WALLET_RPC_DAILY_CALL_CAP: '500', WALLET_RPC_MAX_PER_SEC: '10', WALLET_FILL_POLL_MS: '1500', WALLET_TX_MAX_BYTES: '1132',
      WALLET_PRIORITY_MIN_MICROLAMPORTS: '5000', WALLET_PRIORITY_MAX_MICROLAMPORTS: '200000',
    })).toMatchObject({
      WALLET_LINK_ROUTES: false, WALLET_RPC_DAILY_CALL_CAP: 500, WALLET_RPC_MAX_PER_SEC: 10, WALLET_FILL_POLL_MS: 1500, WALLET_TX_MAX_BYTES: 1132,
      WALLET_PRIORITY_MIN_MICROLAMPORTS: 5000, WALLET_PRIORITY_MAX_MICROLAMPORTS: 200_000,
    });
    // the routes are off only for an explicit off word
    for (const v of ['0', 'false', 'no', 'off', ' OFF ']) expect(buildConfig({ WALLET_LINK_ROUTES: v }).WALLET_LINK_ROUTES, v).toBe(false);
    for (const v of ['1', 'on', 'yes', '', 'garbage']) expect(buildConfig({ WALLET_LINK_ROUTES: v }).WALLET_LINK_ROUTES, v).toBe(true);
    // a value outside its bound is never clamped: the default stands
    for (const bad of ['', '0', '11', '-1', '2.5', 'abc', '1e1']) expect(buildConfig({ WALLET_RPC_MAX_PER_SEC: bad }).WALLET_RPC_MAX_PER_SEC, bad).toBe(4);
    expect(WALLET_RPC_MAX_PER_SEC_MAX).toBe(10);
    for (const bad of ['', '1499', '0', '-2000', 'fast', '2000.5']) expect(buildConfig({ WALLET_FILL_POLL_MS: bad }).WALLET_FILL_POLL_MS, bad).toBe(2000);
    expect(WALLET_FILL_POLL_MS_MIN).toBe(1500);
    for (const bad of ['', '0', '1133', '9999', '-1', 'big']) expect(buildConfig({ WALLET_TX_MAX_BYTES: bad }).WALLET_TX_MAX_BYTES, bad).toBe(1100);
    expect(WALLET_TX_MAX_BYTES_MAX).toBe(1132);
    expect(WALLET_TX_MAX_BYTES_MAX).toBe(WALLET_TX_BYTES_HARD_MAX);      // one number, two places (the validator's hard maximum)
    for (const bad of ['', '0', '-5', 'x', '1.5']) expect(buildConfig({ WALLET_RPC_DAILY_CALL_CAP: bad }).WALLET_RPC_DAILY_CALL_CAP, bad).toBe(3000);
    for (const bad of ['1000001', '0', '-1', 'x']) expect(buildConfig({ WALLET_PRIORITY_MAX_MICROLAMPORTS: bad }).WALLET_PRIORITY_MAX_MICROLAMPORTS, bad).toBe(1_000_000);
    expect(WALLET_PRIORITY_MAX_MICROLAMPORTS_CAP).toBe(1_000_000);
    // a minimum above the maximum is a configuration mistake: both go back to their defaults
    expect(buildConfig({ WALLET_PRIORITY_MIN_MICROLAMPORTS: '900000', WALLET_PRIORITY_MAX_MICROLAMPORTS: '500000' }))
      .toMatchObject({ WALLET_PRIORITY_MIN_MICROLAMPORTS: 10_000, WALLET_PRIORITY_MAX_MICROLAMPORTS: 1_000_000 });
    // parity: every key is read by config.ts, listed in .env.example (with its default), and the process config holds them
    const example = fs.readFileSync(path.join(BOT_ROOT, '.env.example'), 'utf8');
    for (const k of WALLET_KEYS) {
      expect((CONFIG_ENV_KEYS as readonly string[]).includes(k), `${k} is not read by config.ts`).toBe(true);
      expect(exampleKeys().includes(k), `${k} is missing from .env.example`).toBe(true);
      expect(k in CONFIG, `${k} is missing from CONFIG`).toBe(true);
    }
    expect(example).toMatch(/^#\s*WALLET_LINK_ROUTES=1\b/m);
    expect(example).toMatch(/^#\s*WALLET_RPC_DAILY_CALL_CAP=3000\b/m);
    expect(example).toMatch(/^#\s*WALLET_RPC_MAX_PER_SEC=4\b/m);
    expect(example).toMatch(/^#\s*WALLET_FILL_POLL_MS=2000\b/m);
    expect(example).toMatch(/^#\s*WALLET_TX_MAX_BYTES=1100\b/m);
    expect(example).toMatch(/^#\s*WALLET_PRIORITY_MIN_MICROLAMPORTS=10000\b/m);
    expect(example).toMatch(/^#\s*WALLET_PRIORITY_MAX_MICROLAMPORTS=1000000\b/m);
    // no PumpPortal wallet route and no key for one; no SOL maximum key in the bot (the owner types the amount in every dialog)
    for (const gone of ['WALLET_ALLOW_PUMPPORTAL_BUILD', 'WALLET_TRADE_MAX_SOL', 'WALLET_SLIPPAGE_DEFAULT_BPS', 'WALLET_SLIPPAGE_MAX_BPS']) {
      expect((CONFIG_ENV_KEYS as readonly string[]).includes(gone), `${gone} must not be a bot key`).toBe(false);
      expect(exampleKeys().includes(gone), `${gone} must not be in the bot .env.example`).toBe(false);
      expect(fs.readFileSync(path.join(SRC, 'config.ts'), 'utf8').includes(gone), `${gone} is named in config.ts`).toBe(false);
    }
  });
});

describe('BOT_PORT, BOT_DATA_DIR, ENGINE_URL, TG_API_ROOT', () => {
  it('BOT_PORT accepts 0 only when NODE_ENV=test; a value outside 1..65535 gives the default', () => {
    expect(DEFAULT_BOT_PORT).toBe(3748);
    expect(botPort({})).toBe(3748);
    expect(botPort({ BOT_PORT: '0' })).toBe(3748);
    expect(botPort({ BOT_PORT: '0', NODE_ENV: 'production' })).toBe(3748);
    expect(botPort({ BOT_PORT: '0', NODE_ENV: 'test' })).toBe(0);
    expect(botPort({ BOT_PORT: '4100' })).toBe(4100);
    for (const bad of ['-1', '65536', 'abc', '12.5', ' ']) expect(botPort({ BOT_PORT: bad, NODE_ENV: 'test' }), bad).toBe(3748);
  });

  it('BOT_DATA_DIR defaults to <cwd>/data and accepts an absolute folder', () => {
    expect(botDataDir({})).toBe(path.join(process.cwd(), 'data'));
    const abs = path.join(os.tmpdir(), 'ps-live-data');
    expect(botDataDir({ BOT_DATA_DIR: abs })).toBe(abs);
    expect(botDataDir({ BOT_DATA_DIR: '  ' })).toBe(path.join(process.cwd(), 'data'));
  });

  it('ENGINE_URL loses its trailing slash; TG_API_ROOT is an http(s) URL or the default', () => {
    expect(engineUrl({ ENGINE_URL: 'http://127.0.0.1:9999///' })).toBe('http://127.0.0.1:9999');
    expect(tgApiRoot({})).toBe('https://api.telegram.org');
    expect(tgApiRoot({ TG_API_ROOT: 'http://127.0.0.1:8081/' })).toBe('http://127.0.0.1:8081');
    expect(tgApiRoot({ TG_API_ROOT: 'ftp://example.test' })).toBe('https://api.telegram.org');
    expect(tgApiRoot({ TG_API_ROOT: 'not a url' })).toBe('https://api.telegram.org');
  });
});

describe('test-override accessors (A-68): unset = the literals used before', () => {
  it('the Jupiter URLs are byte-identical to the old keyed literals when JUP_API_BASE is unset, and every one is on api.jup.ag (FIX-BUY2: no lite-api tier)', () => {
    expect(jupApiBase({})).toBe('https://api.jup.ag');
    expect(jupUrls({})).toEqual({
      build: 'https://api.jup.ag/swap/v2/build',
      quote: 'https://api.jup.ag/swap/v1/quote',
      swap: 'https://api.jup.ag/swap/v1/swap',
      order: 'https://api.jup.ag/swap/v2/order',
      execute: 'https://api.jup.ag/swap/v2/execute',
    });
    for (const u of Object.values(jupUrls({}))) expect(u).not.toMatch(/lite-api/);
    // the old JUP_FALLBACK_BASE override is read by nothing: setting it changes no URL
    expect(jupUrls({ JUP_FALLBACK_BASE: 'http://127.0.0.1:7002' } as Record<string, string>)).toEqual(jupUrls({}));
    expect((CONFIG_ENV_KEYS as readonly string[]).includes('JUP_FALLBACK_BASE')).toBe(false);
    expect(fs.readFileSync(path.join(SRC, 'config.ts'), 'utf8')).not.toMatch(/https:\/\/lite-api/);
  });

  it('every JUP_* URL derives from JUP_API_BASE; the accessors read the environment when called', () => {
    const u = jupUrls({ JUP_API_BASE: 'http://127.0.0.1:7001/' });
    expect(u.build).toBe('http://127.0.0.1:7001/swap/v2/build');
    expect(u.quote).toBe('http://127.0.0.1:7001/swap/v1/quote');
    expect(u.swap).toBe('http://127.0.0.1:7001/swap/v1/swap');
    expect(u.order).toBe('http://127.0.0.1:7001/swap/v2/order');
    expect(u.execute).toBe('http://127.0.0.1:7001/swap/v2/execute');
    const saved = process.env.JUP_API_BASE;
    try {
      process.env.JUP_API_BASE = 'http://127.0.0.1:7003';
      expect(jupUrls().quote).toBe('http://127.0.0.1:7003/swap/v1/quote');
    } finally {
      if (saved === undefined) delete process.env.JUP_API_BASE; else process.env.JUP_API_BASE = saved;
    }
    expect(jupUrls().quote).toBe('https://api.jup.ag/swap/v1/quote');
  });

  it('FIXBUY2-T29 JUP_ORDER_FALLBACK is off by default (an owner decision); "sell" and "both" are the only other values (any case); anything else is off', () => {
    expect(jupOrderFallback({})).toBe('off');
    expect(buildConfig({}).JUP_ORDER_FALLBACK).toBe('off');
    expect(jupOrderFallback({ JUP_ORDER_FALLBACK: 'SELL' })).toBe('sell');
    expect(jupOrderFallback({ JUP_ORDER_FALLBACK: ' both ' })).toBe('both');
    for (const v of ['on', '1', 'true', 'buy', 'yes', 'off', '']) expect(jupOrderFallback({ JUP_ORDER_FALLBACK: v }), v).toBe('off');
    expect(fs.readFileSync(path.join(BOT_ROOT, '.env.example'), 'utf8')).toMatch(/^#\s*JUP_ORDER_FALLBACK=off$/m);
  });

  it('PumpPortal trade-local and the pump.fun coin-info URL', () => {
    expect(pumpPortalBase({})).toBe('https://pumpportal.fun');
    expect(pumpPortalTradeLocalUrl({})).toBe('https://pumpportal.fun/api/trade-local');
    expect(pumpPortalTradeLocalUrl({ PUMPPORTAL_BASE: 'http://127.0.0.1:7004/' })).toBe('http://127.0.0.1:7004/api/trade-local');
    expect(pumpfunApiBase({})).toBe('https://frontend-api-v3.pump.fun');
    expect(pumpfunCoinInfoUrl('MINT', {})).toBe('https://frontend-api-v3.pump.fun/coins-v2/MINT');
    expect(pumpfunCoinInfoUrl('MINT', { PUMPFUN_API_BASE: 'http://127.0.0.1:7005' })).toBe('http://127.0.0.1:7005/coins-v2/MINT');
    expect(pumpPortalBase({ PUMPPORTAL_BASE: 'javascript:alert(1)' })).toBe('https://pumpportal.fun');
  });

  it('RPC_FALLBACKS and RPC_URL: the single-endpoint rule needs both', () => {
    expect(rpcFallbacksEnabled({})).toBe(true);
    expect(rpcFallbacksEnabled({ RPC_FALLBACKS: 'off' })).toBe(false);
    expect(rpcFallbacksEnabled({ RPC_FALLBACKS: 'on' })).toBe(true);
    expect(rpcUrlOverride({})).toBe('');
    expect(rpcOnlyUrl({})).toBeNull();
    expect(rpcOnlyUrl({ RPC_URL: 'http://127.0.0.1:7006' })).toBeNull();                              // fallbacks stay on
    expect(rpcOnlyUrl({ RPC_FALLBACKS: 'off' })).toBeNull();                                           // no URL to use alone
    expect(rpcOnlyUrl({ RPC_URL: 'http://127.0.0.1:7006', RPC_FALLBACKS: 'off' })).toBe('http://127.0.0.1:7006');
  });

  it('envSnapshot carries the module keys and never a secret', () => {
    const snap = envSnapshot({ AUTOBUY_STALE_MS: '4000', BOT_DRY_RUN: '0', EXIT_CADENCE_MS: '9000', TG_BOT_TOKEN: 'secret', SIGNAL_SHARED_SECRET: 'secret', WALLET_ENC_KEY: 'secret', HELIUS_KEY: 'secret', TG_LATE_MS: '1000' });
    expect(snap).toMatchObject({ AUTOBUY_STALE_MS: '4000', BOT_DRY_RUN: '0', EXIT_CADENCE_MS: '9000', TG_LATE_MS: '1000' });
    for (const k of ['TG_BOT_TOKEN', 'SIGNAL_SHARED_SECRET', 'WALLET_ENC_KEY', 'HELIUS_KEY']) expect(k in snap, k).toBe(false);
  });
});

describe('.env.example parity', () => {
  it('B5-T04 .env.example lists every key config.ts reads (incl. the test-override keys) and nothing that nothing reads', () => {
    const listed = new Set(exampleKeys());

    // 1. the keys of the spec, by name (FIX-BUY2 item 1: JUP_FALLBACK_BASE is gone with the keyless lite-api tier it pointed at)
    for (const k of ['JUP_API_BASE', 'PUMPPORTAL_BASE', 'PUMPFUN_API_BASE', 'RPC_FALLBACKS', 'BOT_DATA_DIR']) {
      expect(listed.has(k), `${k} is missing from .env.example`).toBe(true);
    }
    expect(listed.has('JUP_FALLBACK_BASE'), 'JUP_FALLBACK_BASE must not be in .env.example').toBe(false);
    // 2. every key config.ts reads is listed
    const missing = CONFIG_ENV_KEYS.filter(k => !listed.has(k));
    expect(missing, `read by config.ts but missing from .env.example: ${missing.join(', ')}`).toEqual([]);
    // 3. every listed key is read by config.ts or by another module of the bot
    const readElsewhere = new Set<string>();
    for (const f of walk(SRC)) {
      if (path.basename(f) === 'config.ts') continue;
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) readElsewhere.add(m[1]);
    }
    const known = new Set<string>([...CONFIG_ENV_KEYS, ...readElsewhere]);
    const orphans = [...listed].filter(k => !known.has(k));
    expect(orphans, `listed in .env.example but read nowhere: ${orphans.join(', ')}`).toEqual([]);
    // 4. the keys the purge removed are gone from the template
    for (const k of ['BOT_SCORE_FLOOR', 'GMGN_API_KEY', 'RUGCHECK_KEY', 'RUGCHECK_SHIELD_KEY', 'PUMPFUN_JWT', 'PUMPFUN_LOGIN_PRIVKEY', 'INSIGHTX_KEY', 'GOPLUS_APPKEY', 'GOPLUS_SECRET', 'TELEMETRY_SILENCED_MIN_SCORE']) {
      expect(listed.has(k), `${k} must not be in .env.example`).toBe(false);
    }
    // 5. the safe default is spelled out
    expect(fs.readFileSync(path.join(BOT_ROOT, '.env.example'), 'utf8')).toMatch(/^BOT_DRY_RUN=1$/m);
  });

  it('config.ts reads no environment key that is not in CONFIG_ENV_KEYS', () => {
    const src = fs.readFileSync(path.join(SRC, 'config.ts'), 'utf8');
    const used = new Set<string>();
    for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) used.add(m[1]);
    for (const m of src.matchAll(/\b(?:raw|str|numOr|posInt|intInRange|finiteNum|onUnlessOff|baseUrl)\(env, '([A-Z][A-Z0-9_]*)'/g)) used.add(m[1]);
    used.delete('NODE_ENV');
    expect(used.size).toBeGreaterThan(40);
    const unlisted = [...used].filter(k => !(CONFIG_ENV_KEYS as readonly string[]).includes(k));
    expect(unlisted).toEqual([]);
    expect(new Set(CONFIG_ENV_KEYS).size).toBe(CONFIG_ENV_KEYS.length);
  });
});
