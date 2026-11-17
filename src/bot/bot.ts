/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║  Pumpstriker Bots — Telegram Bot                          ║
 * ║  Wallet Mgmt · Manual Trading · Settings · Skill Commands ║
 * ╚═══════════════════════════════════════════════════════════╝
 *
 * R4-B6 (B50 section 3): this file is the Telegram UI. The data-source purge and the wiring of the rebuilt modules live elsewhere:
 *   - src/app.ts            the factory (events server, intake, auto-buy, exit engine, outbox, send queue, manual trader)
 *   - src/autobuy/**        the auto-buy gate and its /autobuy commands (handled below in the text handler)
 *   - src/exits/**          the one exit engine (signal AND manual positions, the owner's SL / TP / TSL orders)
 * The old /signal route, the dedup file, the order and hard-stop lanes and every non-execution data source are gone. A-115 brought back the
 * owner's Signals controls in their old places (Active, Min Score, the MCap and liquidity bands, Auto-Sell by Grade and the per-grade exit
 * presets of the old tier menu), the old card look, and /importsettings for the settings an earlier update dropped. Every top-level side effect (Telegraf launch, the events server, the wallet upgrade) is behind main(),
 * which only runs when this file is started directly; tests never import it.
 */

import { Telegraf, Markup, Context } from 'telegraf';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Keypair, Connection, SystemProgram, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { CONFIG, botDataDir } from '../config';
import { log, logOk, logWarn, logErr } from '../logger';
import {
  getSolBalance, getResilientBlockhash, getWsolBalance, wrapSol as wrapSolTx, unwrapAllWsol, startSenderKeepalive,
} from '../execution/jupiter';
import { invalidateRebatesCache } from '../data/rebate-settings';
import { scanClaimableAccounts, summarizeClaim, notifyPartnerScan, ucsConnection, UCS_CLAIM_URL } from '../execution/unclaimedsol';
import { SESSION_PRESETS, parseHHMM, isValidTz, timeNowInTz, isSessionOpen } from './session-window';
import { startPositionMonitor, handlePmCallback, configurePositionMonitor } from './position-monitor';
import { startPositionCleanupSchedule, configurePositionCleanup } from './position-cleanup';
// 2026-09-29 security hardening (track B) — see each module's header.
import { redactSecrets } from '../lib/redact';
import { ALLOWED_UPDATES, isAllowedUpdate } from './access-control';
import { mdSafe, isEntityParseError } from './md-safe';
import { shouldDeleteForSecrets, isImportPrompt, isRoutedImportCommand, SECRET_GUARD_REPLY, SECRET_GUARD_LOG } from './secret-guard';
import {
  validateCa, parseSolAmount, parsePercent, parseSetting, parseNonNegative, sanitizeKb, isToggleAllowed,
} from './trade-guards';
import { encryptSecret, decryptSecret, writeFileAtomic, walletPassphrases, upgradeWalletsFile, undecryptableWarning } from './wallet-crypto';
// 2026-09-26 GMGN skill commands (/dd /pattern … /search + 🔬 button row) — skill-commands.ts.
import { registerSkillCommands, withSkillCommands, skillButtonsRow, reportReply } from './skill-commands';
import { migrateSettingsFile, isTgMinGrade, KEPT_SIGNAL_KEYS, SETTINGS_SCHEMA } from './settings-migrate';
import {
  readRestored, restoredDefaults, parseMinScore, parseUsdBound, boundPairError, parseTpTrigger, parseSellPct, parseStopPct, parseArmAfter,
  parseTrailPct, parseMaxHold, type BoundKey,
} from './signal-settings';
import { signalsMenuView, tierMenuView, triggerRows, sellPctRows, createNonceBook, cancelPrompt, startAction, type MenuRows } from './signals-menu';
import { autoBuyModeText } from '../shared/card/playbook';
import { cardAutoBuy } from '../autobuy/card-mode';
import {
  addRung, cardBuyPlan, clearAll, editPreset, hasNoStop, isCustom, planLine, removeItem, resolvePlan, setMaxHold, setNoStop, setStop,
  setTrail, toggleEnabled, type ExitPlanSnapshot, type GradePreset, type PresetSettings, type TriggerKind,
} from '../exits/presets';
import { applyCandidates, applyPlan, runsPlan, switchToOwnOrders } from '../exits/plan-apply';
import { importIntoSettingsFile, listImportCandidates, markNoticeSent, mergeImport, noticeToSend, readOldFormat, type ImportCandidate } from './settings-import';
import type { Grade } from '../shared/common/ids';
import { loadPolicies, type ResolvedPolicy } from '../shared/exit-policy/exit-policy';
import policiesJson from '../shared/exit-policy/exit-policies.json';
import type { InlineRow } from '../tg/cards';
import { sellPctOf, type StoredManualOrder } from '../exits/manual-orders';
import type { StoredPosition } from '../exits/positions-store';
import { boot, BRAND, type AppSettings, type AppWallet, type AppWallets, type RunningBotApp } from '../app';
import { superviseLaunch, type LaunchSupervisor } from './launch-supervisor';

const OWNER_ID  = CONFIG.TG_CHAT_ID;
const DATA_DIR  = botDataDir();
const MAX_WALLETS = 3;

// ── Wallet encryption: scrypt + AES-256-GCM (wallet-crypto.ts, 2026-09-29) ──
// New entries are v2 (scrypt, per-entry salt) under WALLET_ENC_KEY when set, else the bot token (the original behaviour). Old
// sha256(WALLET_ENC_KEY || TG_BOT_TOKEN) entries stay readable — BOTH secrets are tried — and are upgraded once at boot (backup
// first, each new copy verified). NEVER set WALLET_ENC_KEY to the old bot token (unsafe, removed advice); the CUTOVER.md wallet
// sequence says how to rotate the token: set a NEW random WALLET_ENC_KEY (≥ 32 chars) while the old token is still set, check the
// upgrade log, back up the keys offline, and only then rotate TG_BOT_TOKEN.
const { passphrases: WALLET_PASSPHRASES, primary: WALLET_PRIMARY } = walletPassphrases(CONFIG);
// REBUILD-CHOSEN: set at boot when data/wallets.json exists but is not a JSON array. readJson() then falls back to [] and the next
// save (import, generate, delete) would overwrite the only copy of the keys — so saving is refused until the owner fixes or moves
// the file.
let _walletsFileUnreadable = false;

// ── Storage helpers ───────────────────────────────────────────
function ensureDataDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function readJson(file: string, fallback: any = {}): any {
  ensureDataDir();
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch { return fallback; }
}
function writeJson(file: string, data: any) {
  ensureDataDir();
  // Atomic write (tmp + rename): a crash/power-loss during a plain writeFileSync leaves the file truncated, and readJson's silent
  // fallback would then reset EVERY setting to defaults on next boot with no warning. (2026-07-08)
  const target = path.join(DATA_DIR, file);
  const tmp    = target + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, target);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    // Last resort: direct write beats losing the update entirely.
    fs.writeFileSync(target, JSON.stringify(data, null, 2));
  }
}

// ── In-memory cache ───────────────────────────────────────────
const _cache: { wallets: any; settings: any } = { wallets: null, settings: null };

function loadWallets(): any[]    { return _cache.wallets   ?? (_cache.wallets   = readJson('wallets.json', [])); }
function saveWallets(w: any[])   {
  if (_walletsFileUnreadable) throw new Error('wallets.json is unreadable — nothing was written. Fix or move data/wallets.json, then restart the bot.');
  // Atomic + owner-only (0600, best effort on Windows). No direct-write fallback: a half-written wallets.json would lose keys.
  ensureDataDir();
  writeFileAtomic(path.join(DATA_DIR, 'wallets.json'), JSON.stringify(w, null, 2));
  _cache.wallets = w;
}
function getDefaultWallet(): any { const ws = loadWallets(); return ws.find((w: any) => w.isDefault) || ws[0] || null; }
function getKeypair(wallet: any): Keypair | null {
  if (!wallet) return null;
  try { return Keypair.fromSecretKey(bs58.decode(decryptSecret(wallet.enc, WALLET_PASSPHRASES))); } catch { return null; }
}

// ── Settings (schema 2: settings-migrate.ts) ──────────────────
const DEFAULT_SETTINGS: any = {
  global: {
    antiMev: false, degenMode: false, confirmManualBuy: false, confirmManualSell: false,
    autoPnlCard: true, duplicateBuy: false,
    buyKb: [0.1, 0.5, 1], sellKb: [25, 50, 75, 100],
    slippageBps: 300, priorityFee: 100000,
    priceImpactAlertBuy: 25, priceImpactAlertSell: 50,
    autoSellOnManualBuy: false, sellLimitPresets: [],
    retryOnSlippage: true, smartSlippageMax: 1500, retryMaxAttempts: 3,
  },
  signal: {
    // Telegram cards of grade ≥ tgMinGrade only (A, B or C); the Engine decides what is a signal at all.
    tgMinGrade: 'B',
    // SOL per auto-buy. Auto-buy itself is OFF until the owner arms it (/autobuy), and BOT_DRY_RUN=1 sends nothing.
    buyAmount: 0.01,
    slippageBps: null, degenMode: null,
    // Trading-session window: auto-buy only fires between sessionStart–sessionEnd in sessionTz (USA/Europe/Asia presets or custom).
    // OFF by default = 24/7.
    sessionEnabled: false, sessionPreset: 'usa',
    sessionStart: '08:00', sessionEnd: '17:00', sessionTz: 'America/New_York',
    // A-115 restored: Active, Min Score, the MCap / liquidity bands (USD, null = no limit), Auto-Sell by Grade, the grade presets
    // (every grade follows the active exit policy until the owner edits it), the one-time import notice and the legacy copy.
    ...restoredDefaults(),
  },
};

const _settingsWarned = new Set<string>();
function settingsWarn(m: string) {
  if (_settingsWarned.has(m)) return;
  _settingsWarned.add(m);
  logWarn(`[settings] ${m}`);
}

function loadSettings(): any {
  if (_cache.settings) return _cache.settings;
  const s = readJson('settings.json', {});
  // only the keys of schema 2 are taken from the file (settings-migrate.ts has already dropped the removed ones)
  const keptSignal: Record<string, unknown> = {};
  for (const k of [...KEPT_SIGNAL_KEYS, 'tgMinGrade']) if (s.signal && typeof s.signal === 'object' && k in s.signal) keptSignal[k] = s.signal[k];
  _cache.settings = {
    schema: SETTINGS_SCHEMA,
    global: { ...DEFAULT_SETTINGS.global, ...(s.global || {}) },
    // A-115: the restored keys are read with their checks (an invalid value falls back to its default, a set but unreadable filter bound stays closed)
    signal: { ...DEFAULT_SETTINGS.signal, ...keptSignal, ...readRestored(s.signal, settingsWarn) },
    // 2026-05-16 — Helius Backrun Rebates section. Source of truth for the `/rebates` TG menu. Default: OFF, no address.
    rebates: {
      enabled: typeof s?.rebates?.enabled === 'boolean' ? s.rebates.enabled : false,
      address: typeof s?.rebates?.address === 'string' ? s.rebates.address : '',
    },
  };
  if (!isTgMinGrade(_cache.settings.signal.tgMinGrade)) _cache.settings.signal.tgMinGrade = 'B';
  return _cache.settings;
}
function saveSettings(s: any) {
  _cache.settings = s;
  writeJson('settings.json', s);
  // Bust the read-side cache in jupiter.ts so the next send picks up changes immediately. (mtime-based invalidation also works but adds ~200ms.)
  try { invalidateRebatesCache(); } catch { /* module may not be loaded yet */ }
}

/** What the wiring (app.ts) reads, live, from the settings above. */
const settingsView: AppSettings = {
  buySol: () => Number(loadSettings().signal.buyAmount),
  autoBuySlippageBps: () => {
    const s = loadSettings();
    const n = Number(s.signal.slippageBps ?? s.global.slippageBps);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.global.slippageBps;
  },
  priorityFee: () => {
    const n = Number(loadSettings().global.priorityFee);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.global.priorityFee;
  },
  antiMev: () => !!loadSettings().global.antiMev,
  tgMinGrade: () => loadSettings().signal.tgMinGrade,
  sessionOk: (nowMs: number) => isSessionOpen(loadSettings().signal, new Date(nowMs)),
  slippage: () => {
    const g = loadSettings().global;
    const base = Number(g.slippageBps);
    const max = Number(g.smartSlippageMax);
    return {
      baseBps: Number.isFinite(base) && base > 0 ? base : DEFAULT_SETTINGS.global.slippageBps,
      smartMaxBps: Number.isFinite(max) && max > 0 ? max : DEFAULT_SETTINGS.global.smartSlippageMax,
    };
  },
  duplicateBuy: () => !!loadSettings().global.duplicateBuy,
  // A-115
  ownerFilter: () => {
    const g = loadSettings().signal;
    return { enabled: g.enabled !== false, minScore: g.minScore, minMcap: g.minMcap, maxMcap: g.maxMcap, minLiquidity: g.minLiquidity, maxLiquidity: g.maxLiquidity };
  },
  presets: () => presetSettingsOf(loadSettings()),
  cardButtons: (ca: string) => signalCardButtons(ca),
};

/** A-115: Auto-Sell by Grade and the grade presets as the exit side reads them. */
function presetSettingsOf(s: any): PresetSettings {
  return { autoSellOnSignal: s.signal.autoSellOnSignal !== false, gradePresets: s.signal.gradePresets };
}

/** A-115 (spec 5.3): the old buy row on a signal card (one 🟢 Buy per global.buyKb amount, sbuy: = the card's grade plan) and the skills row. */
function signalCardButtons(ca: string): InlineRow[] {
  const buys = buyKbFor(ca).map((a: number) => ({ text: `🟢 Buy ${a} SOL`, callback_data: `sbuy:${ca}:${a}` }));
  const skills = skillButtonsRow(ca).map((b: any) => ({ text: String(b.text), callback_data: String(b.callback_data) }));
  return [buys, ...(skills.length ? [skills] : [])];
}

/** The active exit policy before the app is booted (the settings migration) and after (the menus). */
function activePolicy(): ResolvedPolicy {
  if (app) return app.policy;
  const all = loadPolicies(policiesJson);
  return all[CONFIG.EXIT_POLICY_ID as ResolvedPolicy['id']] ?? all.EA;
}

function appWallet(w: any): AppWallet | null {
  const kp = getKeypair(w);
  return w && kp ? { walletId: String(w.id), owner: kp.publicKey.toString(), keypair: kp } : null;
}
const walletsView: AppWallets = {
  current: () => appWallet(getDefaultWallet()),
  get: (id: string) => appWallet(loadWallets().find((w: any) => w.id === id)),
  byOwner: (owner: string) => {
    for (const w of loadWallets()) { const a = appWallet(w); if (a && a.owner === owner) return a; }
    return null;
  },
};

// ── The running app (set by main) ─────────────────────────────
let bot!: Telegraf<Context>;
let app!: RunningBotApp;

// ── Session state ─────────────────────────────────────────────
const sess: { awaitingInput: string | null; pendingCA: string; pendingData: any; returnTo: string | null } = {
  awaitingInput: null, pendingCA: '', pendingData: {}, returnTo: null,
};

// A-115 (spec 5.1): EVERY input prompt goes through prompt(): it sets the awaited key, remembers the menu to go back to and attaches
// ✖ Cancel (in:cancel). A refused value goes through reprompt(): the reason, and the same prompt stays open. Nothing else in this file
// sets sess.awaitingInput to a value (the static test MENU-T05 checks it).
const cancelButton = () => Markup.button.callback('✖ Cancel', 'in:cancel');
function prompt(ctx: any, text: string, key: string, returnTo: string, extra: any = {}, rows: any[][] = []) {
  sess.awaitingInput = key;
  sess.returnTo = returnTo;
  return ctx.reply(text, { ...extra, ...Markup.inlineKeyboard([...rows, [cancelButton()]]) });
}
function reprompt(ctx: any, key: string, text: string, extra: any = {}) {
  sess.awaitingInput = key;
  return ctx.reply(text, { ...extra, ...Markup.inlineKeyboard([[cancelButton()]]) });
}
const toRows = (rows: MenuRows) => rows.map(r => r.map(x => Markup.button.callback(x.text, x.data)));
const NONCES = createNonceBook(() => crypto.randomBytes(6).toString('hex'));
const isGrade = (g: unknown): g is Grade => g === 'A' || g === 'B' || g === 'C';

// ── Per-token overrides (slippage / tip / anti-MEV of the position card) ──
const PREFS_FILE = 'position-prefs.json';
function tokenPref(ca: string): { slippageBps?: number; tipSol?: number; antiMev?: boolean } {
  const p = readJson(PREFS_FILE, {})?.[ca];
  return p && typeof p === 'object' ? p : {};
}
function setTokenPref(ca: string, patch: Record<string, unknown>) {
  const all = readJson(PREFS_FILE, {});
  all[ca] = { ...(all[ca] ?? {}), ...patch };
  writeJson(PREFS_FILE, all);
}

// ── Helpers ───────────────────────────────────────────────────
const uid = () => crypto.randomBytes(6).toString('hex');
const shortCA = (ca: string) => `${ca.slice(0, 6)}…${ca.slice(-4)}`;
const fmtSol  = (n: number) => n.toFixed(4);
const fmtPct  = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const fromLamps = (n: number) => n / 1e9;
const isSolCA = (t: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t);

// ── Security helpers (2026-09-29 hardening) ───────────────────
// Error text for chat replies / notify(): RPC URLs with keys, bot tokens, Bearer secrets and private keys are masked (T2 "chat errors").
const errText = (e: any, max = 200) => redactSecrets(String(e?.message || e || 'unknown error')).slice(0, max);
// Token / wallet names interpolated into Markdown (T3): md chars stripped.
const mdName = (s: any, fallback: string, maxLen = 64) => mdSafe(s, maxLen) || fallback;
// Buy keyboard rendered for one CA: ≤ 8 buttons, every callback_data ≤ 64 bytes (Telegram rejects the whole message otherwise). A
// stored list that cleans to nothing falls back to the defaults.
function buyKbFor(ca: string): number[] {
  const kb = sanitizeKb(loadSettings().global.buyKb, 'buy', ca);
  return kb.length ? kb : sanitizeKb(DEFAULT_SETTINGS.global.buyKb, 'buy', ca);
}
// REBUILD-CHOSEN: integer in [lo, hi] for the order wizards (balance %, duration h). Garbage → null (refused) — the old
// Math.min/max(parseInt(x)) clamp stored NaN for garbage, and a NaN balance broke the sell.
function parseIntInRange(v: unknown, lo: number, hi: number): number | null {
  const n = parseNonNegative(v);
  return n !== null && Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

/** Name and symbol of a token as the Engine's GMGN snapshot has them (best effort, Markdown-safe); {} when unknown. */
async function tokenMeta(ca: string): Promise<{ name?: string; ticker?: string }> {
  try {
    const t = await app.engineClient.token(ca);
    if ('error' in t) return {};
    const n = t.fields.name?.value;
    const s = t.fields.symbol?.value;
    return {
      name: typeof n === 'string' ? mdSafe(n) || undefined : undefined,
      ticker: typeof s === 'string' ? mdSafe(s) || undefined : undefined,
    };
  } catch { return {}; }
}

/** Open, non-virtual positions of (ca, wallet). */
function heldBy(ca: string, walletId?: string): StoredPosition[] {
  return app.store.listOpen().filter(p => p.ca === ca && !p.dry_run && (walletId === undefined || p.wallet_id === walletId) && /^\d+$/.test(p.tokens) && BigInt(p.tokens) > 0n);
}

// ── Menu builders ─────────────────────────────────────────────
// ── UnclaimedSol partnership (v4, 2026-07-21) ─────────────────
// Affiliate-link claiming (see src/execution/unclaimedsol.ts): the menu button scans the default wallet ON-CHAIN (read-only — real
// rent lamports, the same arithmetic the unclaimedsol.com dashboard shows) and links to the hosted claim flow. Claims through that
// link are the ONLY ones that credit the partner's 20% revenue share — SDK/on-chain claims earn nothing, which is why the in-TG
// signing flow was retired. The bot signs nothing for this feature. 'pump-striker' is the PUBLIC partner key (attribution only; no
// secrets here).

function mainMenu() {
  return {
    text: `🦅 *${BRAND}*\n\nSelect an option:`,
    kb: Markup.inlineKeyboard([
      [Markup.button.callback('👛 Wallets',        'menu:wallets'),
       Markup.button.callback('📡 Signals',        'menu:signals')],
      [Markup.button.callback('📊 Positions',      'menu:positions'),
       Markup.button.callback('🕔 Active Orders',  'menu:orders')],
      [Markup.button.callback('⚙️ Buy Settings',   'menu:buy'),
       Markup.button.callback('⚙️ Sell Settings',  'menu:sell')],
      [Markup.button.callback('🌐 Global Settings', 'menu:global'),
       Markup.button.callback('🦑 MEV Rebates',     'menu:rebates')],
      [Markup.button.callback('💰 Get Your UnclaimedSol', 'ucs:scan')],
    ]),
  };
}

// ── 2026-05-16: Helius Backrun Rebates UX ────────────────────────
// Flow: /rebates → status card + buttons → toggle / set-address / view-history
//
// We validate the user-supplied wallet address two ways before saving:
//   1. PublicKey decode must succeed (valid base58 + 32-byte length)
//   2. PublicKey.isOnCurve() must be TRUE — must be a real signable wallet pubkey, NOT a PDA. PDAs can't receive SOL transfers
//      without ATA handling and would silently break rebate payouts.
function _shortPubkey(addr: string): string {
  if (!addr) return '(not set)';
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}
function _escapeMd(s: string): string {
  // Telegram Markdown — escape the chars that break formatting.
  return s.replace(/([_*`\[\]])/g, '\\$1');
}
function isValidSolanaWalletPubkey(addr: string): { ok: boolean; reason?: string } {
  if (!addr || typeof addr !== 'string') return { ok: false, reason: 'empty' };
  const trimmed = addr.trim();
  if (trimmed.length < 32 || trimmed.length > 44) return { ok: false, reason: 'wrong length (must be 32-44 chars)' };
  // base58 alphabet rejects 0, O, I, l
  if (/[0OIl]/.test(trimmed)) return { ok: false, reason: 'invalid base58 char (0/O/I/l not allowed)' };
  try {
    const pk = new PublicKey(trimmed);
    // Disallow program-derived addresses — those can't reliably receive SOL.
    if (!PublicKey.isOnCurve(pk.toBuffer())) {
      return { ok: false, reason: 'not on curve — looks like a PDA, not a wallet' };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message?.slice(0, 60) || 'decode failed' };
  }
}

function rebatesMenu() {
  const s   = loadSettings();
  const reb = s.rebates || { enabled: false, address: '' };
  const on  = !!reb.enabled && !!reb.address;
  const statusLine = on
    ? `Status:   🟢 ON\nWallet:   \`${_escapeMd(_shortPubkey(reb.address))}\``
    : reb.address
      ? `Status:   🔴 OFF\nWallet:   \`${_escapeMd(_shortPubkey(reb.address))}\` (set, not active)`
      : `Status:   🔴 OFF\nWallet:   _not set_`;

  const text =
    `🦑 *MEV BACKRUN REBATES*\n\n${statusLine}\n\n` +
    `When ON, 50% of MEV captured from your trades pays\n` +
    `to your wallet — *same block* as the swap. Zero added\n` +
    `latency. Helius runs the auction in parallel to the\n` +
    `normal RPC path.\n\n` +
    `*How it works:*\n` +
    `• KYC'd searchers backrun your tx\n` +
    `• Your tx ALWAYS executes first (sandwich-safe)\n` +
    `• Helius keeps 50%, you get 50%\n` +
    `• Mainnet single-tx only`;

  const toggleLabel = on ? '🔴 Turn OFF' : '🟢 Turn ON';
  const addrLabel   = reb.address ? '✏️ Change Wallet Address' : '💼 Set Wallet Address';

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(toggleLabel, 'reb:toggle')],
    [Markup.button.callback(addrLabel,   'reb:setaddr')],
    [Markup.button.callback('📊 View Recent Rebates', 'reb:viewhist')],
    [Markup.button.callback('« Back', 'menu:main')],
  ]);

  return { text, kb };
}

function walletsMenu(wallets: any[]) {
  const rows = wallets.map((w: any) => [
    Markup.button.callback(`${w.isDefault ? '⭐' : '  '} ${w.name}${w.manualEnabled ? ' [M]' : ''}`, `w:view:${w.id}`)
  ]);
  if (wallets.length < MAX_WALLETS) {
    rows.push([Markup.button.callback('➕ Import Wallet', 'w:import'), Markup.button.callback('🎲 Generate New', 'w:generate')]);
  }
  rows.push([Markup.button.callback('« Back', 'menu:main')]);
  return Markup.inlineKeyboard(rows);
}

function walletDetailMenu(w: any) {
  const pwOn = !!w.usePreWrappedSol;
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh Balance', `w:refresh:${w.id}`)],
    [Markup.button.callback(w.isDefault ? '⭐ Default' : 'Set as Default', `w:default:${w.id}`),
     Markup.button.callback(w.manualEnabled ? '✅ Manual ON' : '❌ Manual OFF', `w:manual:${w.id}`)],
    [Markup.button.callback('✏️ Rename',   `w:rename:${w.id}`),
     Markup.button.callback('📤 Send SOL', `w:sendSol:${w.id}`)],
    // wSOL controls — pre-wrapped pool for faster sniping
    [Markup.button.callback(pwOn ? '💎 Use wSOL: ON' : '💎 Use wSOL: OFF', `w:togpw:${w.id}`)],
    [Markup.button.callback('🔄 Wrap → wSOL',   `w:wrap:${w.id}`),
     Markup.button.callback('💧 Unwrap All wSOL', `w:unwrap:${w.id}`)],
    [Markup.button.callback('🗑 Delete',   `w:delete:${w.id}`)],
    [Markup.button.callback('« Wallets',   'menu:wallets')],
  ]);
}

// ── Trading-session menu (2026-07-08) ─────────────────────────
// Pure window logic lives in ./session-window (tested); these two only render.
function sessionLabel(sig: any): string {
  const p = SESSION_PRESETS[String(sig?.sessionPreset || '')];
  return p ? p.label : '🌐 Custom';
}
// Render-time hardening: bot-entered values are validated (parseHHMM/isValidTz), but a hand-edited settings.json can carry Markdown
// chars that make Telegram reject the whole menu (silently — the edit error is swallowed). Times may sit inside *bold*, so escape
// them; the tz sits inside a `code` span where only a backtick can break out, so strip those.
const _sessTime = (v: any) => _escapeMd(String(v ?? ''));
const _sessTz   = (v: any) => String(v ?? 'UTC').replace(/`/g, "'");
function sessionStatusLine(sig: any): string {
  if (!sig?.sessionEnabled) return '⏰ Auto-Buy Session: OFF — buys 24/7';
  // Timezone rendered as a `code` span: IANA names contain '_' (America/New_York) which reads as an italic marker to Telegram
  // Markdown — inside backticks it's literal.
  return `⏰ Auto-Buy Session: ${sessionLabel(sig)} ${_sessTime(sig.sessionStart)}–${_sessTime(sig.sessionEnd)} (\`${_sessTz(sig.sessionTz)}\`) — ${isSessionOpen(sig) ? '🟢 OPEN' : '🔴 CLOSED'}`;
}

function sessionMenu(s: any) {
  const sig  = s.signal;
  const on   = !!sig.sessionEnabled;
  const open = isSessionOpen(sig);
  const mark = (k: string) => (on && sig.sessionPreset === k ? '✅ ' : '');
  return {
    text: `⏰ *Auto-Buy Trading Session*\n\n` +
      (on ? `Auto-buy only fires between *${_sessTime(sig.sessionStart)}* and *${_sessTime(sig.sessionEnd)}* (\`${_sessTz(sig.sessionTz)}\`).\n`
          : `Window is OFF — auto-buy runs 24/7.\n`) +
      `📡 Signal pings always arrive 24/7 — the window only gates auto-buy.\n` +
      `🚨 Rug exits stay on whatever the window says.\n\n` +
      `Status: ${on ? (open ? '🟢 OPEN now' : '🔴 CLOSED now') : '❌ OFF (24/7)'}\n` +
      `Session: *${sessionLabel(sig)}*\n` +
      `Start: *${_sessTime(sig.sessionStart)}*  ·  Stop: *${_sessTime(sig.sessionEnd)}*\n` +
      `Timezone: \`${_sessTz(sig.sessionTz)}\`\n` +
      `Time there now: *${timeNowInTz(String(sig.sessionTz || 'UTC'))}*`,
    kb: Markup.inlineKeyboard([
      [Markup.button.callback(on ? '🟢 Window ON — tap for 24/7' : '🔴 Window OFF (24/7) — tap to enable', 'stime:toggle')],
      [Markup.button.callback(`${mark('usa')}🇺🇸 USA 08–17 NY`,    'stime:preset:usa'),
       Markup.button.callback(`${mark('europe')}🇪🇺 EU 08–17 LDN`, 'stime:preset:europe'),
       Markup.button.callback(`${mark('asia')}🌏 Asia 09–18 TYO`,  'stime:preset:asia')],
      [Markup.button.callback('🕒 Start Time', 'stime:set:start'),
       Markup.button.callback('🕕 Stop Time',  'stime:set:end')],
      [Markup.button.callback('🌐 Timezone',   'stime:set:tz')],
      [Markup.button.callback('« Signals', 'menu:signals')],
    ]),
  };
}

const GRADE_CYCLE: Record<string, string> = { A: 'B', B: 'C', C: 'A' };

function signalsMenu(s: any) {
  const sig = s.signal;
  // A-115 (review P1): the same line as the card: what a buy really does (BOT_DRY_RUN, an unconfirmed live state, a pause)
  const abLine = autoBuyModeText(cardAutoBuy(app.autoBuy.heartbeat().autobuy, null));
  // A-115: the restored layout (signals-menu.ts builds it; spec section 5 order)
  const v = signalsMenuView({
    brand: BRAND, signal: sig, globalSlippageBps: Number(s.global.slippageBps), globalDegen: !!s.global.degenMode,
    sessionLine: sessionStatusLine(sig),
    sessionButton: sig.sessionEnabled ? `⏰ Auto-Buy Session: ${sessionLabel(sig)} ${sig.sessionStart}–${sig.sessionEnd} — edit` : '⏰ Auto-Buy Session: 24/7 — tap to set hours',
    autoBuyLine: abLine, active: activePolicy(),
  });
  return { text: v.text, kb: Markup.inlineKeyboard(toRows(v.rows)) };
}

// ── A-115: the per-grade exit presets (the old tier menu, now per grade) ──
function gradeOfPosition(p: StoredPosition): Grade | null {
  if (p.exit_plan) return p.exit_plan.grade;
  const g = app.inbox.signalled(p.ca)?.grade;
  return isGrade(g) ? g : null;
}
function gradeCandidates(g: Grade, only?: (p: StoredPosition) => boolean) {
  return applyCandidates(app.store, g, gradeOfPosition, app.exits.mutex, only);
}
function tierMenu(g: Grade, s: any) {
  const v = tierMenuView({ grade: g, preset: s.signal.gradePresets[g], active: activePolicy(), autoSellOnSignal: s.signal.autoSellOnSignal !== false,
    openCount: gradeCandidates(g).length, now: app.clock.now() });
  return { text: v.text, kb: Markup.inlineKeyboard(toRows(v.rows)) };
}
function savePreset(g: Grade, p: GradePreset) {
  const s = loadSettings();
  s.signal.gradePresets = { ...s.signal.gradePresets, [g]: p };
  saveSettings(s);
}
/** Applies one preset edit (a policy preset is copied first); replies the refusal or saves. Returns true when saved. */
async function editGrade(ctx: any, g: Grade, fn: Parameters<typeof editPreset>[3]): Promise<boolean> {
  const s = loadSettings();
  const r = editPreset(s.signal.gradePresets[g], activePolicy(), app.clock.now(), fn);
  if (!r.ok) { await ctx.reply(`❌ ${r.reason} Nothing was saved.`); return false; }
  savePreset(g, r.preset);
  return true;
}
async function replyTier(ctx: any, g: Grade) {
  const m = tierMenu(g, loadSettings());
  return ctx.reply(m.text, { parse_mode: 'Markdown', ...m.kb });
}
function noStopWarning(g: Grade, p: GradePreset): string {
  const extra = isCustom(p) ? [p.trail ? 'the trail' : '', p.maxHoldH !== null ? 'the max hold' : ''].filter(Boolean) : ['the trail', 'the max hold'];
  return `Positions from grade-${g} cards will have NO stop-loss. Only the hard-rug exit (−40% in 15 s)${extra.length ? `, ${extra.join(', ')}` : ''} remain.`;
}

/** Reopens the menu a prompt came from (✖ Cancel, a finished input). */
async function replyMenu(ctx: any, id: string | null) {
  const s = loadSettings();
  const show = (m: { text: string; kb: any }) => ctx.reply(m.text, { parse_mode: 'Markdown', ...m.kb });
  switch (id) {
    case 'menu:signals': return show(signalsMenu(s));
    case 'menu:buy': return show(buySettingsMenu(s));
    case 'menu:sell': return show(sellSettingsMenu(s));
    case 'menu:global': return show(globalSettingsMenu(s));
    case 'menu:rebates': return show(rebatesMenu());
    case 'stime:menu': return show(sessionMenu(s));
    case 'menu:wallets': return ctx.reply('👛 *Wallets*\n\nSelect a wallet to manage:', { parse_mode: 'Markdown', ...walletsMenu(loadWallets()) });
    case 'menu:positions': return startPositionMonitor(ctx);
    case 'menu:orders': { const { text, buttons } = buildOrdersText(); return ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }); }
    default: {
      const g = typeof id === 'string' && id.startsWith('tier:view:') ? id.slice('tier:view:'.length) : null;
      if (isGrade(g)) return replyTier(ctx, g);
      return show(mainMenu());
    }
  }
}

function buySettingsMenu(s: any) {
  const g = s.global;
  return {
    text: `⚙️ *Buy Settings*\n\n` +
      `Slippage: *${(g.slippageBps / 100).toFixed(1)}%*\n` +
      `Priority Fee: *${g.priorityFee} lamports*\n` +
      `Buy Keyboard: ${g.buyKb.map((v: number) => `${v} SOL`).join(' | ')}\n` +
      `Confirm Manual Buy: ${g.confirmManualBuy ? '✅' : '❌'}\n` +
      `Allow Duplicate Buy: ${g.duplicateBuy ? '✅' : '❌'}\n` +
      `Price Impact Alert: ${g.priceImpactAlertBuy}%\n` +
      `Auto-Sell on Manual Buy: ${g.autoSellOnManualBuy ? '✅' : '❌'}\n\n` +
      `⚡ *Smart Slippage Retry*\n` +
      `Retry on slippage error: ${g.retryOnSlippage ? '✅ ON' : '❌ OFF'}\n` +
      `Max slippage on retry: *${(g.smartSlippageMax / 100).toFixed(1)}%*\n` +
      `Max retry attempts: *${g.retryMaxAttempts}*`,
    kb: Markup.inlineKeyboard([
      [Markup.button.callback('🌊 Slippage',        'buy:set:slippageBps'),
       Markup.button.callback('⛽ Priority Fee',     'buy:set:priorityFee')],
      [Markup.button.callback('⌨️ Buy Keyboard',     'buy:set:buyKb'),
       Markup.button.callback('⚠️ Impact Alert %',   'buy:set:priceImpactAlertBuy')],
      [Markup.button.callback(g.confirmManualBuy ? '✅ Confirm Buy ON' : '❌ Confirm Buy OFF', 'buy:tog:confirmManualBuy'),
       Markup.button.callback(g.duplicateBuy ? '🔁 Dupe ON' : '🚫 Dupe OFF', 'buy:tog:duplicateBuy')],
      [Markup.button.callback(g.autoSellOnManualBuy ? '💸 Auto-Sell ON' : '💸 Auto-Sell OFF', 'buy:tog:autoSellOnManualBuy')],
      [Markup.button.callback(g.retryOnSlippage ? '⚡ Retry ON' : '⚡ Retry OFF', 'buy:tog:retryOnSlippage')],
      [Markup.button.callback('🔺 Max Retry Slip %', 'buy:set:smartSlippageMax'),
       Markup.button.callback('🔁 Max Attempts',     'buy:set:retryMaxAttempts')],
      [Markup.button.callback('« Back', 'menu:main')],
    ]),
  };
}

function sellSettingsMenu(s: any) {
  const g = s.global;
  return {
    text: `⚙️ *Sell Settings*\n\n` +
      `Slippage: *${(g.slippageBps / 100).toFixed(1)}%*\n` +
      `Sell Keyboard: ${g.sellKb.map((v: number) => `${v}%`).join(' | ')}\n` +
      `Confirm Manual Sell: ${g.confirmManualSell ? '✅' : '❌'}\n` +
      `Auto PnL Card: ${g.autoPnlCard ? '✅' : '❌'}\n` +
      `Price Impact Alert: ${g.priceImpactAlertSell}%`,
    kb: Markup.inlineKeyboard([
      [Markup.button.callback('🌊 Slippage',       'sell:set:slippageBps'),
       Markup.button.callback('⌨️ Sell Keyboard',   'sell:set:sellKb')],
      [Markup.button.callback('⚠️ Impact Alert %',  'sell:set:priceImpactAlertSell')],
      [Markup.button.callback(g.confirmManualSell ? '✅ Confirm Sell ON' : '❌ Confirm Sell OFF', 'sell:tog:confirmManualSell'),
       Markup.button.callback(g.autoPnlCard ? '📊 PnL Card ON' : '📊 PnL Card OFF', 'sell:tog:autoPnlCard')],
      [Markup.button.callback('« Back', 'menu:main')],
    ]),
  };
}

function globalSettingsMenu(s: any) {
  const g = s.global;
  return {
    text: `🌐 *Global Settings*\n\n` +
      `Anti-MEV (Helius SG): ${g.antiMev ? '🛡 ON' : 'OFF'}\n` +
      `Degen Mode: ${g.degenMode ? '😈 ON' : 'OFF'}`,
    kb: Markup.inlineKeyboard([
      [Markup.button.callback(g.antiMev ? '🛡 Anti-MEV ON' : '🛡 Anti-MEV OFF', 'glob:tog:antiMev'),
       Markup.button.callback(g.degenMode ? '😈 Degen ON' : '😇 Degen OFF',     'glob:tog:degenMode')],
      [Markup.button.callback('« Back', 'menu:main')],
    ]),
  };
}

// ── Manual trades (through the shared manual trader of app.ts) ─────────────
// The old executeBuy / executeSell are gone: a manual buy opens a PositionV2 that the ONE exit engine manages, and a manual sell
// reads its real fill from the chain. Everything the owner sees below comes from those results; an unknown value prints as unknown.

async function sendTradeClosedCard(ca: string, result: any) {
  if (!result?.closed) return;
  const meta   = await tokenMeta(ca);
  const name   = mdName(meta.name, shortCA(ca));
  const ticker = mdName(meta.ticker, '???');
  const known  = typeof result.solOut === 'number';
  const durationMin = result.entryTs ? Math.max(0, Math.floor((app.clock.now() - result.entryTs) / 60000)) : null;
  const durationStr = durationMin === null ? 'unknown' : durationMin >= 60 ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m` : `${durationMin}m`;
  const hasPnl = typeof result.pnl === 'number' && typeof result.pnlPct === 'number';
  const isWin = hasPnl && result.pnl >= 0;
  const em    = !hasPnl ? '⚪' : isWin ? '🟢' : '🔴';
  const arrow = isWin ? '▲' : '▼';
  const vibe  = !hasPnl ? '' : isWin
    ? `🔥 *Sheeeeesh You Killing it\\!*\n_Secure your profits — don't be greedy on the next trade_ 🦅`
    : `💀 *It is what it is\\.*\n_This is part of the game — Better luck next time_ 🦅`;

  await notify(
    `${em} *Trade Closed — ${name}* (${ticker})\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 Invested: *${result.entrySol !== null && result.entrySol !== undefined ? `${fmtSol(result.entrySol)} SOL` : 'unknown'}*\n` +
    `💸 Received: *${known ? `${fmtSol(result.solOut)} SOL` : 'not verified'}*\n` +
    `⏱ Duration: *${durationStr}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    (hasPnl
      ? `${em} P&L: *${arrow}${Math.abs(result.pnlPct).toFixed(2)}%*  (${result.pnl >= 0 ? '+' : ''}${fmtSol(result.pnl)} SOL)\n`
      : `${em} P&L: *unknown* (the fill or the entry could not be verified)\n`) +
    (result.sig ? `🔗 [View tx](https://solscan.io/tx/${result.sig})\n` : '') +
    (vibe ? `━━━━━━━━━━━━━━━━━━━━\n${vibe}` : '')
  );
}

async function runBuy(ctx: any, msgId: number, ca: string, sol: number, wallet: any, plan: ExitPlanSnapshot | null = null) {
  try {
    const result = await app.manual.buy({ walletId: wallet.id, ca, sol, ...(plan !== null ? { exitPlan: plan } : {}) });
    const meta = await tokenMeta(ca);
    // FIX-BUY: the buy returns once the transaction is SENT; the chain decides later. FIX-BUY2 (part-1 review P2): the fill check messages the
    // owner about a failed buy only through the position the quote opened, so the reply promises that only when a position was opened; with
    // none (no quote came back, or the position could not be saved) the chain fill opens it if the buy landed, and the reply says so.
    const opened = result.positionId !== null;
    const quoted = result.tokenAmt > 0 ? `${result.tokenAmt.toLocaleString()} tokens` : 'none';
    const after = opened
      ? '_You get a message if it fails on-chain._'
      : '_No position was opened yet: the bot opens it only if the chain shows the buy landed. Check /positions._';
    await ctx.telegram.editMessageText(ctx.chat.id, msgId, undefined,
      `📤 *Buy sent: ${mdName(meta.name, shortCA(ca))}*\n• Amount: ${sol} SOL\n• Quoted: ${quoted} (not confirmed yet)\n• [View tx](https://solscan.io/tx/${result.sig})\n${after}`,
      { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
  } catch (e: any) {
    await ctx.telegram.editMessageText(ctx.chat.id, msgId, undefined, `❌ Buy failed: ${errText(e)}`);
  }
}

async function runSellAndReport(ctx: any, msgId: number, ca: string, pct: number, wallet: any, compact: boolean) {
  try {
    const pref = tokenPref(ca);
    const result = await app.manual.sell({ walletId: wallet.id, ca, pct, slippageBps: pref.slippageBps, antiMev: pref.antiMev });
    const em = result.pnl === null ? '⚪' : result.pnl >= 0 ? '🟢' : '🔴';
    const got = result.solOut === null ? 'not verified' : `${fmtSol(result.solOut)} SOL`;
    const pnl = result.pnlPct === null ? 'unknown' : fmtPct(result.pnlPct);
    const txLink = result.sig ? `[View tx](https://solscan.io/tx/${result.sig})` : 'no transaction';
    await ctx.telegram.editMessageText(ctx.chat.id, msgId, undefined,
      compact
        ? `${em} Sold ${pct}% — ${got} · PnL ${pnl}\n${txLink}`
        : `${em} *Sold ${pct}%*\n• Got: ${got}\n• P&L: ${pnl}\n• ${txLink}`,
      { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
    await sendTradeClosedCard(ca, result);
  } catch (e: any) {
    await ctx.telegram.editMessageText(ctx.chat.id, msgId, undefined, `❌ Sell failed: ${errText(e)}`);
  }
}

// ── Orders helpers (ManualOrderV2 records of the shared positions store) ───
const ORDER_LABEL: Record<string, string> = { tp: '🎯 TP', sl: '🛑 SL', tsl: '📉 TSL' };

/** The manual positions an order for (ca, wallet) attaches to, or a reason why there is none. */
function manualTargets(ca: string, walletId: string | undefined): { positions: StoredPosition[]; why: string | null } {
  const held = heldBy(ca, walletId);
  const manual = held.filter(p => p.origin === 'manual' && !p.exit_plan);
  if (manual.length > 0) return { positions: manual, why: null };
  const planned = held.find(p => p.exit_plan);
  return {
    positions: [],
    why: planned
      ? `This position follows its grade-${planned.exit_plan!.grade} plan. ✋ Switch to my own orders first (on its Positions card).`
      : held.length > 0
        ? `This position follows the ${mdSafe(held[0].policy_id ?? 'EA', 16)} exit policy (signal position): limit orders apply to manual positions only.`
        : 'No open position for this token on this wallet.',
  };
}

function addManualOrders(ca: string, walletId: string, type: string, triggerPct: number, sellPct: number, durationH: number): { count: number; why: string | null } {
  const t = manualTargets(ca, walletId);
  if (t.positions.length === 0) return { count: 0, why: t.why };
  const now = app.clock.now();
  for (const p of t.positions) {
    const o: StoredManualOrder = {
      order_id: `ord_${uid()}`, position_id: p.position_id, ca, wallet_id: walletId, type: type as 'tp' | 'sl' | 'tsl', trigger_pct: triggerPct,
      baseline_multi: null, peak_rel: null, expires_at: now + durationH * 3_600_000, active: true, attempts: 0, created_at: now, source: 'ui',
      sell_pct: sellPct, arm_after_pct: null,
    };
    app.store.putOrder(o);
  }
  return { count: t.positions.length, why: null };
}

function activeOrdersOfCa(ca: string): StoredManualOrder[] {
  return app.store.listOpen().filter(p => p.ca === ca).flatMap(p => app.store.activeOrdersOf(p.position_id));
}

// ── Orders text ───────────────────────────────────────────────
function buildOrdersText(): { text: string; buttons: any[][] } {
  const lines: string[]  = [];
  const buttons: any[][] = [];
  const now = app.clock.now();
  for (const p of app.store.listOpen()) {
    for (const o of app.store.activeOrdersOf(p.position_id)) {
      if (o.expires_at !== null && now > o.expires_at) continue;
      const sign = o.trigger_pct >= 0 ? '+' : '';
      lines.push(`${ORDER_LABEL[o.type] || mdSafe(o.type, 8)} *${shortCA(p.ca)}* — ${sign}${o.trigger_pct}% → sell ${sellPctOf(o)}%`);
      buttons.push([Markup.button.callback(`❌ Cancel ${o.order_id.slice(4, 10)}`, `ord:del:${o.order_id}`)]);
    }
  }
  if (!lines.length) return { text: '🕔 *Active Orders*\n\nNo active orders.', buttons: [] };
  return { text: `🕔 *Active Orders*\n\n` + lines.join('\n'), buttons: [...buttons, [Markup.button.callback('« Back', 'menu:main')]] };
}

// ── Token report (paste CA) ───────────────────────────────────
// The numbers come from the Engine's GMGN snapshot (`EngineClient.token`), each with the age of its own reading; whatever the Engine
// does not know prints as "—". No price site, no risk-report site.
async function reportCard(ca: string): Promise<{ text: string; markdown: boolean }> {
  const rep = await reportReply(app.engineClient, ca, app.clock.now());
  const held = heldBy(ca).reduce((a, p) => a + (p.entry.sol_spent_lamports !== null ? Number(p.entry.sol_spent_lamports) / 1e9 : 0), 0);
  const heldLine = held > 0 ? `\n\n💼 You hold: ${fmtSol(held)} SOL entry` : '';
  return rep.ok ? { text: rep.text + heldLine, markdown: true } : { text: rep.text + heldLine, markdown: false };
}

function tokenKeyboard(ca: string) {
  const buyBtns = buyKbFor(ca).map((a: number) => Markup.button.callback(`🟢 Buy ${a} SOL`, `buy:${ca}:${a}`));
  const skRow = skillButtonsRow(ca);   // 🔬 skills row; [] for an invalid CA
  return Markup.inlineKeyboard([
    buyBtns,
    [Markup.button.callback('🔴 Sell 50%',  `sell:${ca}:50`),
     Markup.button.callback('🔴 Sell 100%', `sell:${ca}:100`)],
    [Markup.button.callback('🎯 Add TP', `ord:add:tp:${ca}`),
     Markup.button.callback('🛑 Add SL', `ord:add:sl:${ca}`),
     Markup.button.callback('📉 Add TSL', `ord:add:tsl:${ca}`)],
    ...(skRow.length ? [skRow] : []),
  ]);
}

async function handleTokenReport(ctx: any, ca: string) {
  const msg  = await ctx.reply(`⏳ Fetching token info…`);
  const card = await reportCard(ca);
  sess.pendingCA = ca;
  await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, card.text,
    { ...(card.markdown ? { parse_mode: 'Markdown' } : {}), link_preview_options: { is_disabled: true }, reply_markup: tokenKeyboard(ca).reply_markup });
}

// ── handleAwaitedInput ────────────────────────────────────────
async function handleAwaitedInput(ctx: any, key: string, value: string) {
  const s = loadSettings();

  // ── 2026-05-16 — Rebate-wallet entry ──────────────────────────
  if (key === 'reb:setaddr') {
    // Early-out on absurdly long pastes (Telegram caps at 4096 chars but we never need >100). Saves CPU on validator + keeps logs clean.
    if (typeof value !== 'string' || value.length > 100) {
      return reprompt(ctx, 'reb:setaddr', '❌ Input too long. Send a single 32–44 char base58 pubkey, or `cancel`.', { parse_mode: 'Markdown' });
    }
    const input = value.trim();
    if (input.toLowerCase() === 'cancel') {
      return ctx.reply('Cancelled. No change.');
    }
    const v = isValidSolanaWalletPubkey(input);
    if (!v.ok) {
      return reprompt(ctx, 'reb:setaddr', `❌ ${v.reason}. Send a valid base58 wallet pubkey, or \`cancel\`.`, { parse_mode: 'Markdown' });
    }
    s.rebates ||= { enabled: false, address: '' };
    s.rebates.address = input;
    saveSettings(s);
    const m = rebatesMenu();
    await ctx.reply(`✅ Saved. Rebates will pay to \`${_escapeMd(_shortPubkey(input))}\`. Toggle ON when ready.`, { parse_mode: 'Markdown' });
    return ctx.reply(m.text, { parse_mode: 'Markdown', ...m.kb });
  }

  // ── Position-monitor wizards ────────────────────────────────
  if (key.startsWith('pm:sellpct:')) {
    const ca  = key.split(':')[2];
    const pct = parseFloat(value);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return ctx.reply('❌ Enter a number 1–100.');
    const wallet = getDefaultWallet();
    if (!wallet) return ctx.reply('No wallet.');
    return runQuickSell(ctx, ca, Math.round(pct), wallet);
  }
  if (key.startsWith('pm:sellsol:')) {
    const ca  = key.split(':')[2];
    const sol = parseFloat(value);
    if (!Number.isFinite(sol) || sol <= 0) return ctx.reply('❌ Enter a positive number.');
    const wallet = getDefaultWallet();
    if (!wallet) return ctx.reply('No wallet.');
    const held = heldBy(ca, wallet.id);
    if (!held.length) return ctx.reply('❌ No position.');
    // Convert the desired SOL into % of the position with the current executable value of the whole bag
    const full = await bagValueSol(held);
    if (full === null || full <= 0) return ctx.reply('❌ Could not value the position right now — try again.');
    return runQuickSell(ctx, ca, Math.min(100, Math.ceil((sol / full) * 100)), wallet);
  }
  if (key.startsWith('pm:selltok:')) {
    const ca  = key.split(':')[2];
    const tok = parseFloat(value);
    if (!Number.isFinite(tok) || tok <= 0) return ctx.reply('❌ Enter a positive number.');
    const wallet = getDefaultWallet();
    if (!wallet) return ctx.reply('No wallet.');
    const held = heldBy(ca, wallet.id);
    if (!held.length) return ctx.reply('❌ No position.');
    const dec = await app.decimals(ca);
    if (dec === null) return ctx.reply('❌ Could not read the token decimals — try again.');
    const rawTotal = held.reduce((a, p) => a + Number(p.tokens), 0);
    const pct = Math.min(100, Math.ceil(((tok * Math.pow(10, dec)) / rawTotal) * 100));
    return runQuickSell(ctx, ca, pct, wallet);
  }
  if (key.startsWith('pm:slip:')) {
    const ca  = key.split(':')[2];
    const slipPct = parseFloat(value);
    if (!Number.isFinite(slipPct) || slipPct < 0.1 || slipPct > 50) {
      return ctx.reply('❌ Enter a number 0.1–50.');
    }
    if (!heldBy(ca).length) return ctx.reply('❌ No such position.');
    setTokenPref(ca, { slippageBps: Math.round(slipPct * 100) });
    await ctx.reply(`✅ Slippage for this token set to ${slipPct}%.`);
    return startPositionMonitor(ctx, ca);
  }
  if (key.startsWith('pm:tip:')) {
    const ca  = key.split(':')[2];
    const tip = parseFloat(value);
    if (!Number.isFinite(tip) || tip < 0 || tip > 0.1) {
      return ctx.reply('❌ Enter a number 0–0.1 SOL (Helius minimum is 0.0002).');
    }
    if (!heldBy(ca).length) return ctx.reply('❌ No such position.');
    setTokenPref(ca, { tipSol: tip });
    await ctx.reply(`✅ Helius tip for this token set to ${tip} SOL.`);
    return startPositionMonitor(ctx, ca);
  }
  if (key.startsWith('pm:limadd:')) {
    // pm:limadd:<ca>:<type>
    const parts = key.split(':');
    const ca   = parts[2];
    const type = parts[3] as 'tp' | 'sl' | 'tsl';
    const trig = parseFloat(value);
    if (!Number.isFinite(trig)) return ctx.reply('❌ Enter a number (e.g. 50 or -10).');
    if (type === 'tsl' && trig >= 0) return ctx.reply('❌ TSL trigger must be negative (e.g. -10 means trail 10% below peak).');
    const wallet = getDefaultWallet();
    if (!wallet) return ctx.reply('❌ No such position / wallet.');
    const r = addManualOrders(ca, wallet.id, type, trig, 100, type === 'tsl' ? 96 : 48);
    if (r.count === 0) return ctx.reply(`❌ ${r.why}`);
    await ctx.reply(`✅ ${type.toUpperCase()} added at ${trig >= 0 ? '+' : ''}${trig}%.`);
    return openLimitsSubmenu(ctx, ca);
  }

  // Wallet actions
  if (key.startsWith('w:import:')) {
    // 2026-09-29 (security T2c): delete the key message FIRST, whatever the outcome — the old code decoded first, so an invalid key
    // stayed in the chat and its error text was echoed. Fixed reply text, never e.message.
    await ctx.deleteMessage().catch(() => {});
    const secret = String(value || '').trim();
    let kp: Keypair;
    try { kp = Keypair.fromSecretKey(bs58.decode(secret)); }
    catch { return ctx.reply('❌ That is not a valid base58 private key.'); }
    const ws = loadWallets();
    if (ws.length >= MAX_WALLETS) return ctx.reply(`❌ Max ${MAX_WALLETS} wallets reached.`);
    ws.push({ id: uid(), name: `Wallet ${ws.length + 1}`, isDefault: ws.length === 0, manualEnabled: true, enc: encryptSecret(secret, WALLET_PRIMARY) });
    try { saveWallets(ws); }
    catch (e: any) { ws.pop(); return ctx.reply(`❌ Wallet not saved: ${errText(e)}`); }
    const bal = await getSolBalance(kp.publicKey.toString()).catch(() => 0);
    // Success: the PUBLIC key only.
    await ctx.reply(`✅ *Wallet imported*\n\`${kp.publicKey.toString()}\`\nBalance: *${fmtSol(fromLamps(bal))} SOL*\n\n⚠️ Message deleted for security.`, { parse_mode: 'Markdown' });
    return;
  }

  if (key.startsWith('w:rename:')) {
    const wid = key.split(':')[2];
    const ws  = loadWallets();
    const w   = ws.find((x: any) => x.id === wid);
    // 2026-09-29 (security T2/T3): store the Markdown-safe name and echo the SAVED name, never the raw input.
    const name = mdSafe(value, 20);
    if (!name) return ctx.reply('❌ That name is empty once formatting characters are removed.');
    if (!w) return ctx.reply('❌ Wallet not found.');
    w.name = name;
    saveWallets(ws);
    await ctx.reply(`✅ Renamed to: ${name}`);
    return;
  }

  // Wrap SOL → wSOL wizard
  if (key.startsWith('w:wrapAmt:')) {
    const wid = key.split(':')[2];
    const amt = parseFloat(value);
    if (!Number.isFinite(amt) || amt <= 0) return ctx.reply('❌ Enter a positive number.');
    if (amt > 100) return ctx.reply('❌ That seems large — wrap amounts > 100 SOL not allowed via this command.');
    const ws  = loadWallets();
    const w   = ws.find((x: any) => x.id === wid);
    if (!w) return ctx.reply('❌ Wallet not found.');
    const kp  = getKeypair(w);
    if (!kp) return ctx.reply('❌ Cannot decrypt keypair.');
    const msg = await ctx.reply(`⏳ Wrapping ${amt} SOL → wSOL…`);
    try {
      const sig = await wrapSolTx(kp, amt);
      // Auto-enable the preference on first wrap (UX nudge: if you wrapped, you probably want to use it)
      if (!w.usePreWrappedSol) { w.usePreWrappedSol = true; saveWallets(ws); }
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined,
        `✅ Wrapped ${amt} SOL → wSOL.\nPre-wrapped wSOL is now ON for this wallet.\n[View tx](https://solscan.io/tx/${sig})`,
        { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } } as any);
    } catch (e: any) {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined,
        `❌ Wrap failed: ${errText(e)}`).catch(() => {});
    }
    return;
  }

  if (key.startsWith('w:sendSol:')) {
    const wid = key.split(':')[2];
    // 2026-09-29 (security T6): parseSolAmount refuses NaN, Infinity, '0.5abc' (isNaN let Infinity through). Confirmation + cap =
    // open user decision #7.
    const amt = parseSolAmount(value);
    if (amt === null) return ctx.reply('❌ Invalid amount');
    sess.pendingData.sendSolAmt = amt;
    return prompt(ctx, 'Paste destination address:', `w:sendSolDest:${wid}`, 'menu:wallets');
  }

  if (key.startsWith('w:sendSolDest:')) {
    const wid  = key.split(':')[2];
    // validateCa also checks the address decodes to a 32-byte public key.
    const dest = validateCa(value);
    if (!dest || !isSolCA(dest)) return ctx.reply('❌ Invalid address');
    const ws  = loadWallets();
    const w   = ws.find((x: any) => x.id === wid);
    const kp  = getKeypair(w);
    const amt = parseSolAmount(sess.pendingData.sendSolAmt);
    if (amt === null) return ctx.reply('❌ Amount missing — start Send SOL again.');
    if (!kp) return ctx.reply('❌ Keypair error');
    try {
      // Bot-lane RPC key (separate from engine to avoid scan-burst contention).
      const _botKey = CONFIG.HELIUS_KEY_BOT || CONFIG.HELIUS_KEY;
      const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${_botKey}`;
      const conn   = new Connection(rpcUrl, 'confirmed');
      const { blockhash, lastValidBlockHeight } = await getResilientBlockhash();
      const tx = new (await import('@solana/web3.js')).Transaction({ blockhash, lastValidBlockHeight, feePayer: kp.publicKey });
      tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(dest), lamports: Math.floor(amt * LAMPORTS_PER_SOL) }));
      const sig = await conn.sendTransaction(tx, [kp]);
      await ctx.reply(`✅ Sent *${amt} SOL* → \`${shortCA(dest)}\`\n[View tx](https://solscan.io/tx/${sig})`, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
    } catch (e: any) { await ctx.reply(`❌ Send failed: ${errText(e)}`); }
    return;
  }

  // ── Trading-session inputs (2026-07-08) ─────────────────────
  // 'cancel' escape (same idiom as reb:setaddr): without it a wrong paste re-arms the prompt forever and swallows every following
  // message — including CA pastes that should open a token report.
  if (key.startsWith('stime:') && value.trim().toLowerCase() === 'cancel') {
    await ctx.reply('Cancelled. No change.');
    const m = sessionMenu(s);
    return ctx.reply(m.text, { parse_mode: 'Markdown', ...m.kb });
  }
  if (key === 'stime:start' || key === 'stime:end') {
    if (parseHHMM(value) === null) {
      return reprompt(ctx, key, '❌ Use 24h HH:MM format (e.g. 08:00 or 17:30). Nothing was saved.');
    }
    const hhmm = value.trim();
    if (key === 'stime:start') s.signal.sessionStart = hhmm; else s.signal.sessionEnd = hhmm;
    s.signal.sessionPreset = 'custom';   // manual time = no longer a stock preset
    saveSettings(s);
    await ctx.reply(`✅ Session ${key === 'stime:start' ? 'start' : 'stop'} time set to ${hhmm}.`);
    const m = sessionMenu(s);
    return ctx.reply(m.text, { parse_mode: 'Markdown', ...m.kb });
  }
  if (key === 'stime:tz') {
    const tz = value.trim();
    if (!isValidTz(tz)) {
      return reprompt(ctx, key, '❌ Unknown timezone. Use an IANA name like America/New_York, Europe/Paris or Asia/Tokyo. Nothing was saved.');
    }
    s.signal.sessionTz = tz;
    s.signal.sessionPreset = 'custom';
    saveSettings(s);
    await ctx.reply(`✅ Timezone set to ${tz} — time there now: ${timeNowInTz(tz)}.`);
    const m = sessionMenu(s);
    return ctx.reply(m.text, { parse_mode: 'Markdown', ...m.kb });
  }

  // Settings numeric inputs
  // 2026-09-29 (security T6): every input is range-checked (trade-guards.ts). A handler returns null when the value was saved, or the
  // refusal text — NaN, negatives and out-of-range values are REFUSED, never saved (the old parseFloat/parseInt handlers stored NaN
  // for garbage).
  const SLIP_HINT = 'Enter a slippage % from 0.1 to 50.';
  // A-115: Min Score and the four bounds (min <= max checked against the other bound)
  const boundSetter = (k: BoundKey) => (v: string): string | null => {
    const r = parseUsdBound(v);
    if (!r.ok) return r.error;
    const e = boundPairError(k, r.value, s.signal);
    if (e) return e;
    s.signal[k] = r.value;
    return null;
  };
  const settingMap: Record<string, (v: string) => string | null> = {
    'sig:buyAmount':            (v: string) => { const n = parseSolAmount(v); if (n === null) return 'Enter a positive SOL amount (e.g. 0.01).'; s.signal.buyAmount = n; return null; },
    'sig:slippageBps':          (v: string) => { const n = parseSetting('slippageBps', v); if (n === null) return SLIP_HINT; s.signal.slippageBps = n; return null; },
    'sig:minScore':             (v: string) => { const r = parseMinScore(v); if (!r.ok) return r.error; s.signal.minScore = r.value; return null; },
    'sig:minMcap':              boundSetter('minMcap'),
    'sig:maxMcap':              boundSetter('maxMcap'),
    'sig:minLiquidity':         boundSetter('minLiquidity'),
    'sig:maxLiquidity':         boundSetter('maxLiquidity'),
    'buy:slippageBps':          (v: string) => { const n = parseSetting('slippageBps', v); if (n === null) return SLIP_HINT; s.global.slippageBps = n; return null; },
    'buy:priorityFee':          (v: string) => { const n = parseSetting('priorityFee', v); if (n === null) return 'Enter a whole number of lamports from 0 to 5000000.'; s.global.priorityFee = n; return null; },
    'buy:priceImpactAlertBuy':  (v: string) => { const n = parseNonNegative(v); if (n === null) return 'Enter a percentage ≥ 0.'; s.global.priceImpactAlertBuy = n; return null; },
    'buy:buyKb':                (v: string) => { const kb = sanitizeKb(v.split(','), 'buy'); if (!kb.length) return 'Enter up to 8 positive SOL amounts separated by commas (e.g. 0.1,0.5,1).'; s.global.buyKb = kb; return null; },
    'buy:smartSlippageMax':     (v: string) => { const n = parseSetting('smartSlippageMax', v); if (n === null) return SLIP_HINT; s.global.smartSlippageMax = n; return null; },
    'buy:retryMaxAttempts':     (v: string) => { const n = parseSetting('retryMaxAttempts', v); if (n === null) return 'Enter a whole number from 1 to 5.'; s.global.retryMaxAttempts = n; return null; },
    'sell:slippageBps':         (v: string) => { const n = parseSetting('slippageBps', v); if (n === null) return SLIP_HINT; s.global.slippageBps = n; return null; },
    'sell:priceImpactAlertSell':(v: string) => { const n = parseNonNegative(v); if (n === null) return 'Enter a percentage ≥ 0.'; s.global.priceImpactAlertSell = n; return null; },
    'sell:sellKb':              (v: string) => { const kb = sanitizeKb(v.split(','), 'sell'); if (!kb.length) return 'Enter up to 8 whole percentages from 1 to 100 separated by commas (e.g. 25,50,75,100).'; s.global.sellKb = kb; return null; },
  };

  // ── A-115: the grade-preset inputs (tier:*) ──
  if (key.startsWith('tier:')) return handleTierInput(ctx, key, value);

  // Order flow: step 2 — typed %
  if (key === 'ord:pct') {
    const type    = sess.pendingData.orderType;
    const raw     = parseNonNegative(value) ?? NaN;   // finite only ('5abc' / Infinity refused)
    if (isNaN(raw) || raw <= 0) return ctx.reply('❌ Enter a positive number (e.g. 100 for 100%)');
    sess.pendingData.orderPct  = type === 'tp' ? raw : -Math.abs(raw);
    const typeLabel: any = { tp: '🎯 Take Profit', sl: '🛑 Stop Loss', tsl: '📉 Trailing Stop Loss' };
    const sign = type === 'tp' ? '+' : '−';
    return prompt(ctx,
      `${typeLabel[type]} · ${sign}${raw}%\n\nWhat % of your total holdings to sell when triggered?\n(e.g. 100 = sell everything, 50 = sell half; or type a whole number 1-100)`,
      'ord:balance:custom', 'menu:orders', {}, [
        [Markup.button.callback('25%', 'ord:bal:25'), Markup.button.callback('50%', 'ord:bal:50'),
         Markup.button.callback('75%', 'ord:bal:75'), Markup.button.callback('100%', 'ord:bal:100')],
        [Markup.button.callback('Custom amount', 'ord:bal:custom')],
      ]);
  }

  if (key === 'ord:balance:custom') {
    const bal = parsePercent(value);
    if (bal === null) return reprompt(ctx, 'ord:balance:custom', '❌ Enter a whole number from 1 to 100. Nothing was saved.');
    sess.pendingData.orderBalance = bal;
    return prompt(ctx, `Sell ${bal}% of holdings.\n\nActive for how many hours? (1–96)`, 'ord:duration', 'menu:orders', {}, [[
        Markup.button.callback('6h', 'ord:dur:6'),   Markup.button.callback('12h', 'ord:dur:12'),
        Markup.button.callback('24h', 'ord:dur:24'), Markup.button.callback('48h', 'ord:dur:48'),
        Markup.button.callback('96h', 'ord:dur:96'),
      ]]);
  }

  if (key === 'ord:duration') {
    const duration = parseIntInRange(value, 1, 96);
    if (duration === null) return reprompt(ctx, 'ord:duration', '❌ Enter a whole number of hours from 1 to 96 (or tap one of the hour buttons). Nothing was saved.');
    return finalizeOrder(ctx, duration);
  }

  if (Object.prototype.hasOwnProperty.call(settingMap, key)) {
    const refusal = settingMap[key](value);
    if (refusal) return reprompt(ctx, key, `❌ ${refusal} Nothing was saved.`);
    saveSettings(s);
    await ctx.reply(`✅ Updated.`);
    if (key.startsWith('sig:')) return replyMenu(ctx, 'menu:signals');
    return;
  }

  // Manual buy amount
  if (key === 'buy:manual:amount') {
    const ca  = validateCa(sess.pendingCA);
    if (!ca) return ctx.reply('❌ Invalid token address');
    const sol = parseSolAmount(value);
    if (sol === null) return ctx.reply('❌ Invalid amount');
    const wallet = getDefaultWallet();
    if (!wallet) return ctx.reply('❌ No wallet. Use /import first.');
    const msg = await ctx.reply(`⏳ Buying ${sol} SOL of ${shortCA(ca)}…`);
    await runBuy(ctx, msg.message_id, ca, sol, wallet);
  }
}

// ── Order helpers ─────────────────────────────────────────────
async function finalizeOrder(ctx: any, duration: number) {
  const ca        = sess.pendingCA;
  const type      = sess.pendingData.orderType;
  const pct       = sess.pendingData.orderPct;
  const balance   = sess.pendingData.orderBalance;
  const typeLabel: any = { tp: '🎯 Take Profit', sl: '🛑 Stop Loss', tsl: '📉 Trailing Stop Loss' };
  const sign      = pct >= 0 ? '+' : '';

  const wallet = getDefaultWallet();
  if (!wallet) return ctx.reply('❌ No wallet. Use /import first.');
  const r = addManualOrders(ca, wallet.id, type, pct, balance, duration);
  if (r.count === 0) return ctx.reply(`❌ ${r.why}`);
  await ctx.reply(
    `✅ *${typeLabel[type]} Added*\n\n📌 *${shortCA(ca)}*\n` +
    `• Trigger: ${sign}${pct}%\n• Sell: ${balance}% of holdings\n• Duration: ${duration}h\n\n` +
    `_Checked on every exit pass (every 5–15 seconds), measured from the first price it sees._`,
    { parse_mode: 'Markdown' }
  );
}

// ── Telegraf: handlers ────────────────────────────────────────
// Telegram throws on common edge cases (message deleted by user, message older than 48h, "message is not modified", chat blocked, etc.).
// Without these handlers a single 400 crashes the whole bot — exactly what happened with "Bad Request: message to edit not found" on a
// buy-failed status edit.
function isBenignTgError(msg: string): boolean {
  return msg.includes('message to edit not found')
      || msg.includes('message is not modified')
      || msg.includes('message to delete not found')
      || msg.includes('message to forward not found')
      || msg.includes('query is too old')                 // callback query expired
      || msg.includes('MESSAGE_ID_INVALID')
      || msg.includes('Bot was blocked by the user')
      || msg.includes('chat not found');
}
// 2026-09-29 (security T2a): error logs never carry the message TEXT (a key pasted into /import used to reach the log via
// `message.text.slice(0,60)`) nor the raw error object. Only: update type, the command name (first token, only when it looks like a
// command), the callback data, and the redacted error message. Everything goes through log() → redactSecrets as well.
const COMMAND_TOKEN_RE = /^\/[A-Za-z0-9_]{1,32}(?:@[A-Za-z0-9_]{1,64})?$/;
function updateWhere(ctx: any): string {
  const parts: string[] = [`type=${String(ctx?.updateType || 'unknown').slice(0, 32)}`];
  const text = ctx?.message?.text;
  if (typeof text === 'string' && text.startsWith('/')) {
    const first = text.trim().split(/\s+/)[0];
    parts.push(`command=${COMMAND_TOKEN_RE.test(first) ? first : '/?'}`);
  }
  const data = ctx?.update?.callback_query?.data;
  if (typeof data === 'string') parts.push(`callback=${data.slice(0, 64)}`);
  return redactSecrets(parts.join(' '));
}
// REBUILD-CHOSEN: keep the first stack frame (file:line only, redacted) so a handler crash is still locatable without logging the
// error object.
function errWhere(err: any): string {
  const frame = String(err?.stack || '').split('\n').find(l => /^\s+at\s/.test(l));
  return frame ? ` @ ${redactSecrets(frame.trim()).slice(0, 160)}` : '';
}

/** The current executable value (SOL) of the whole bag of these positions, from the shared valuation (null = no quote). */
async function bagValueSol(held: StoredPosition[]): Promise<number | null> {
  if (!held.length) return null;
  const total = held.reduce((a, p) => a + BigInt(p.tokens), 0n);
  const q = await app.valuation.quote({ ...held[0], tokens: total.toString() }, true).catch(() => null);
  return q && Number.isFinite(q.sol) ? q.sol : null;
}

// ── Position-monitor sell helpers ─────────────────────────────
//   Per-token MEV / slippage overrides live in position-prefs.json; the card auto-refreshes on completion.

async function runQuickSell(ctx: any, ca: string, pct: number, wallet: any) {
  if (!heldBy(ca, wallet.id).length) return ctx.reply('❌ No such position.');
  const msg = await ctx.reply(`⏳ Selling ${pct}% of ${shortCA(ca)}…`);
  await runSellAndReport(ctx, msg.message_id, ca, pct, wallet, true);
}

async function runSellInitials(ctx: any, ca: string, wallet: any) {
  // Compute the % needed to recoup the original entry SOL amount.
  const held = heldBy(ca, wallet.id);
  if (!held.length) return ctx.reply('❌ No position on this wallet.');
  const entry = held.every(p => p.entry.sol_spent_lamports !== null)
    ? held.reduce((a, p) => a + Number(p.entry.sol_spent_lamports) / 1e9, 0) : null;
  if (entry === null || !(entry > 0)) return ctx.reply('❌ The entry cost of this position is not known, so the initials cannot be computed.');
  const curSol = await bagValueSol(held);
  if (curSol === null) return ctx.reply('❌ Could not quote — try again in a moment.');

  if (curSol <= entry) {
    return ctx.reply(`⚠️ Position is at a loss — initials would require selling 100%. Use Sell All if that's what you want.`);
  }
  const pct = Math.min(100, Math.ceil((entry / curSol) * 100));
  return runQuickSell(ctx, ca, pct, wallet);
}

// Telegram caps callback_data at 64 bytes. CAs are 44 chars + prefix + orderId blows the budget. We track the active CA in a small
// in-memory registry keyed by orderId only. Callbacks become `pm:lim:del:<orderId>` — well under limit.
let _activeLimitMenuCa: string | null = null;       // most-recently-opened menu's CA (for back button)

async function openLimitsSubmenu(ctx: any, ca: string) {
  const list = activeOrdersOfCa(ca);
  _activeLimitMenuCa = ca;

  const lines = ['⏰ <b>Sell Limits</b> — ' + esc(shortCA(ca)), ''];
  if (!list.length) lines.push('<i>No active limit orders.</i>');
  else {
    for (const o of list) {
      const lbl = ({ tp: '🎯 TP', sl: '🛑 SL', tsl: '📉 TSL' } as Record<string, string>)[o.type] || '📌';
      const sign = o.trigger_pct >= 0 ? '+' : '';
      lines.push(`${lbl} ${sign}${o.trigger_pct}% → sell ${sellPctOf(o)}%`);
    }
  }

  const buttons: any[] = [];
  for (const o of list) {
    buttons.push([Markup.button.callback(
      `🗑 Cancel ${o.type.toUpperCase()} ${o.trigger_pct >= 0 ? '+' : ''}${o.trigger_pct}%`,
      `pm:lim:del:${o.order_id}`,
    )]);
  }
  // `add` and `back` carry no CA — they resolve from _activeLimitMenuCa.
  buttons.push([Markup.button.callback('➕ Add new limit', `pm:lim:add`)]);
  buttons.push([Markup.button.callback('← Back', `pm:lim:back`)]);

  try { await ctx.deleteMessage(); } catch { /* ignore */ }
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

async function openAddLimitWizard(ctx: any, ca: string) {
  // Type buttons don't carry the CA — handler reads from _activeLimitMenuCa.
  _activeLimitMenuCa = ca;
  return ctx.reply('Choose the order type:', Markup.inlineKeyboard([
    [
      Markup.button.callback('🎯 TP',  `pm:lim:addtype:tp`),
      Markup.button.callback('🛑 SL',  `pm:lim:addtype:sl`),
      Markup.button.callback('📉 TSL', `pm:lim:addtype:tsl`),
    ],
    [Markup.button.callback('← Back', `pm:lim:back`)],
  ]));
}

// HTML-safe escape for limits submenu (renderer already has its own copy)
function esc(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Notify helper ─────────────────────────────────────────────
async function notify(text: string, extra: any = {}) {
  try {
    await bot.telegram.sendMessage(OWNER_ID, text, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true }, ...extra });
  } catch (e: any) {
    // 2026-09-29 (security T3): a name/error with unbalanced Markdown used to make Telegram refuse the whole alert ("can't parse
    // entities") and the alert was LOST. Resend the same text with no parse_mode instead.
    if (isEntityParseError(e)) {
      const { parse_mode: _ignored, ...plainExtra } = extra || {};
      try {
        await bot.telegram.sendMessage(OWNER_ID, text, { link_preview_options: { is_disabled: true }, ...plainExtra });
        logWarn(`TG notify: Markdown refused (${errText(e, 120)}) — resent as plain text`);
        return;
      } catch (e2: any) { logErr(`TG notify failed (plain-text retry): ${errText(e2)}`); return; }
    }
    logErr(`TG notify failed: ${errText(e)}`);
  }
}

// ── A-115: grade-preset callbacks and inputs ──────────────────
async function handleTierCallback(ctx: any, data: string) {
  const parts = data.split(':');
  const now = app.clock.now();
  if (data.startsWith('tb:bal:')) {
    const t = sess.pendingData.tier;
    if (!t || t.kind !== 'tp' || typeof t.atPct !== 'number') return ctx.reply('Session expired. Open the grade preset again.');
    if (parts[2] === 'custom') return prompt(ctx, 'Sell how many % of the ORIGINAL position? (a whole number 1-100)', 'tier:tp:sell', `tier:view:${t.grade}`);
    sess.awaitingInput = null;
    return finishTp(ctx, t.grade, Number(parts[2]));
  }
  const action = parts[1];
  if (action === 'trig') {
    const t = sess.pendingData.tier;
    const trig = parts[2] as TriggerKind;
    if (!t || !['entryPrice', 'price', 'mcap'].includes(trig)) return ctx.reply('Session expired. Open the grade preset again.');
    t.trigger = trig;
    const back = `tier:view:${t.grade}`;
    const why = 'Entry Price %, Price % and Market Cap % all measure the move from your entry (market cap moves with price).';
    if (t.kind === 'tp') return prompt(ctx, `🎯 Take-profit, grade ${t.grade}: the rise in % from your entry (100 = 2×).\n${why}`, 'tier:tp:pct', back);
    if (t.kind === 'sl') return prompt(ctx, `🛑 Stop-loss, grade ${t.grade}: the loss in % from your entry (30 = sell all at −30%).\n${why}`, 'tier:sl:pct', back);
    return prompt(ctx, `📉 Trailing stop, grade ${t.grade}: arm after +% from your entry (0 = from the first quote).\n${why}`, 'tier:tsl:arm', back);
  }
  // tier:<view|tog|clear|nostop|reset|apply>:G · tier:del:G:i · tier:add:<kind>:G · tier:set:hold:G · tier:<nostop|reset|apply>:yes:G:<nonce>
  const g = parts[action === 'add' || action === 'set' || parts[2] === 'yes' ? 3 : 2] as string;
  if (!isGrade(g)) return ctx.reply('❌ Unknown grade.');
  const s = loadSettings();
  const cur: GradePreset = s.signal.gradePresets[g];
  const show = async () => { const m = tierMenu(g, loadSettings()); return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => replyTier(ctx, g)); };
  switch (action) {
    case 'view': return show();
    case 'tog': if (!isCustom(cur)) return show(); if (await editGrade(ctx, g, toggleEnabled)) return show(); return;
    case 'add': {
      const kind = parts[2];
      if (!['tp', 'sl', 'tsl'].includes(kind)) return ctx.reply('❌ Unknown order type');
      if (kind === 'tp' && isCustom(cur) && cur.ladder.length >= 3) return ctx.reply('❌ A preset holds at most 3 take-profits. Nothing was saved.');
      sess.pendingData.tier = { grade: g, kind };
      return ctx.reply(`${kind === 'tp' ? '➕ Take-profit' : kind === 'sl' ? '➕ Stop-loss' : '➕ Trailing stop'} for grade ${g}: what does the % measure?`, Markup.inlineKeyboard(toRows(triggerRows())));
    }
    case 'del': { if (await editGrade(ctx, g, removeItem(Number(parts[3])))) return show(); return; }
    case 'set': return prompt(ctx, `⏳ Max hold for grade ${g}: whole hours from 1 to 168 (0 = no max hold).`, `tier:hold:${g}`, `tier:view:${g}`);
    case 'clear': { if (await editGrade(ctx, g, clearAll)) return show(); return; }
    case 'nostop': {
      if (parts[2] === 'yes') {
        const gg = parts[3];
        if (!isGrade(gg) || !NONCES.consume(`nostop:${gg}`, parts[4] || '', now)) return ctx.reply('❌ This confirmation expired or was already used. Nothing was saved. Open the preset and try again.');
        if (await editGrade(ctx, gg, setNoStop(now))) { await ctx.reply(`⚠️ Grade-${gg} preset saved WITHOUT a stop-loss.`); return replyTier(ctx, gg); }
        return;
      }
      const nonce = NONCES.issue(`nostop:${g}`, now);
      return ctx.reply(`🚫 *No stop-loss for grade ${g}?*\n\n${noStopWarning(g, cur)}\n\nThis confirmation is valid for 5 minutes.`, { parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⚠️ Yes, no stop-loss', `tier:nostop:yes:${g}:${nonce}`)], [Markup.button.callback('✖ Cancel', `tier:view:${g}`)]]) });
    }
    case 'reset': {
      if (parts[2] === 'yes') {
        const gg = parts[3];
        if (!isGrade(gg) || !NONCES.consume(`reset:${gg}`, parts[4] || '', now)) return ctx.reply('❌ This confirmation expired or was already used. Nothing was saved.');
        savePreset(gg, { mode: 'policy' });
        await ctx.reply(`↩️ Grade ${gg} follows the exit policy ${activePolicy().id} again. Open positions keep the plan they opened with.`);
        return replyTier(ctx, gg);
      }
      const nonce = NONCES.issue(`reset:${g}`, now);
      return ctx.reply(`↩️ Reset the grade-${g} preset to the exit policy ${activePolicy().id}? Your orders of this grade are removed.`,
        Markup.inlineKeyboard([[Markup.button.callback('↩️ Yes, reset', `tier:reset:yes:${g}:${nonce}`)], [Markup.button.callback('✖ Cancel', `tier:view:${g}`)]]));
    }
    case 'apply': {
      const gg = parts[2] === 'yes' ? parts[3] : g;
      if (!isGrade(gg)) return ctx.reply('❌ Unknown grade.');
      const cands = gradeCandidates(gg);
      const settingsNow = loadSettings();
      const plan = resolvePlan(presetSettingsOf(settingsNow), gg, activePolicy(), m => logWarn(`[presets] ${m}`));
      const planText = plan.snapshot ? `your grade-${gg} preset rev ${plan.snapshot.rev}` : `the exit policy ${activePolicy().id}`;
      if (parts[2] === 'yes') {
        if (!NONCES.consume(`apply:${gg}`, parts[4] || '', now)) return ctx.reply('❌ This confirmation expired or was already used. Nothing was changed.');
        const r = applyPlan(app.store, cands, plan.snapshot, activePolicy(), gg, app.exits.mutex);
        const skipped = r.skipped.map(x => `• ${shortCA(x.ca)}: ${x.why}`).join('\n');
        return ctx.reply(`♻️ ${r.applied.length} position(s) now run ${planText}.${skipped ? `\nNot changed:\n${skipped}` : ''}`);
      }
      if (!cands.length) return ctx.reply(`No open real position of grade ${gg}.`);
      const lines = cands.map(c => `• ${shortCA(c.position.ca)}: ${planLine(c.position.exit_plan, c.position.policy_id, settingsNow.signal.gradePresets)}${c.skip ? ` (skipped: ${c.skip})` : ''}`).join('\n');
      const warn = plan.snapshot && !plan.snapshot.policy.legs.some(l => l.kind === 'rug_stop') ? `\n\n⚠️ ${noStopWarning(gg, settingsNow.signal.gradePresets[gg])}` : '';
      const nonce = NONCES.issue(`apply:${gg}`, now);
      return ctx.reply(`♻️ Put ${planText} on these open grade-${gg} positions? Basis, peak, take-profits already done and the sold part stay as they are.\n${lines}${warn}`,
        Markup.inlineKeyboard([[Markup.button.callback('♻️ Yes, apply', `tier:apply:yes:${gg}:${nonce}`)], [Markup.button.callback('✖ Cancel', `tier:view:${gg}`)]]));
    }
    default: return show();
  }
}

async function finishTp(ctx: any, g: Grade, sellPct: number): Promise<unknown> {
  const t = sess.pendingData.tier;
  const r = editPreset(loadSettings().signal.gradePresets[g], activePolicy(), app.clock.now(),
    addRung({ atPct: t.atPct, sellPctOfOriginal: sellPct, trigger: (t.trigger ?? 'entryPrice') as TriggerKind }));
  if (!r.ok) return reprompt(ctx, 'tier:tp:sell', `❌ ${r.reason} Nothing was saved. Enter a smaller sell %:`);
  savePreset(g, r.preset);
  sess.pendingData.tier = null;
  await ctx.reply(`✅ Grade ${g}: take-profit at +${t.atPct}% sells ${sellPct}% of the original position (preset rev ${r.preset.rev}).`);
  return replyTier(ctx, g);
}

async function handleTierInput(ctx: any, key: string, value: string): Promise<unknown> {
  const t = sess.pendingData.tier;
  if (key.startsWith('tier:hold:')) {
    const g = key.slice('tier:hold:'.length);
    if (!isGrade(g)) return ctx.reply('❌ Unknown grade.');
    const r = parseMaxHold(value);
    if (!r.ok) return reprompt(ctx, key, `❌ ${r.error} Nothing was saved.`);
    if (await editGrade(ctx, g, setMaxHold(r.value))) { await ctx.reply(`✅ Grade ${g}: max hold ${r.value === null ? 'none' : `${r.value}h`}.`); return replyTier(ctx, g); }
    return;
  }
  if (!t || !isGrade(t.grade)) return ctx.reply('Session expired. Open the grade preset again.');
  const g: Grade = t.grade;
  if (key === 'tier:tp:pct') {
    const r = parseTpTrigger(value);
    if (!r.ok) return reprompt(ctx, key, `❌ ${r.error} Nothing was saved.`);
    const cur = loadSettings().signal.gradePresets[g];
    if (isCustom(cur) && cur.ladder.some(x => Math.abs(x.atPct - r.value) < 1e-9)) return reprompt(ctx, key, `❌ There is already a take-profit at +${r.value}%. Nothing was saved. Enter another %:`);
    t.atPct = r.value;
    return prompt(ctx, `Sell how much of the ORIGINAL position at +${r.value}%? (tap, or type a whole number 1-100)`, 'tier:tp:sell', `tier:view:${g}`, {}, toRows([sellPctRows()[0]]));
  }
  if (key === 'tier:tp:sell') {
    const r = parseSellPct(value);
    if (!r.ok) return reprompt(ctx, key, `❌ ${r.error} Nothing was saved.`);
    return finishTp(ctx, g, r.value);
  }
  if (key === 'tier:sl:pct') {
    const r = parseStopPct(value);
    if (!r.ok) return reprompt(ctx, key, `❌ ${r.error} Nothing was saved.`);
    if (await editGrade(ctx, g, setStop(r.value))) { sess.pendingData.tier = null; await ctx.reply(`✅ Grade ${g}: stop-loss −${r.value}% (sells everything left).`); return replyTier(ctx, g); }
    return;
  }
  if (key === 'tier:tsl:arm') {
    const r = parseArmAfter(value);
    if (!r.ok) return reprompt(ctx, key, `❌ ${r.error} Nothing was saved.`);
    t.armAfterPct = r.value;
    return prompt(ctx, `📉 Trail: sell all how many % under the peak? (1-95; 40 = 40% under the peak)`, 'tier:tsl:trail', `tier:view:${g}`);
  }
  if (key === 'tier:tsl:trail') {
    const r = parseTrailPct(value);
    if (!r.ok) return reprompt(ctx, key, `❌ ${r.error} Nothing was saved.`);
    if (await editGrade(ctx, g, setTrail({ armAfterPct: t.armAfterPct ?? 0, trailPct: r.value, trigger: (t.trigger ?? 'entryPrice') as TriggerKind }))) {
      sess.pendingData.tier = null;
      await ctx.reply(`✅ Grade ${g}: trailing stop −${r.value}% from the peak${(t.armAfterPct ?? 0) > 0 ? ` once +${t.armAfterPct}%` : ' from the first quote'}.`);
      return replyTier(ctx, g);
    }
    return;
  }
  return ctx.reply('Session expired. Open the grade preset again.');
}

// ── A-115: /importsettings callbacks ──────────────────────────
let _importCandidates: ImportCandidate[] = [];
async function handleImportCallback(ctx: any, data: string) {
  const parts = data.split(':');
  const now = app.clock.now();
  if (parts[1] === 'no') return ctx.reply('Cancelled. Nothing was imported.');
  const n = Number(parts[2]);
  const cand = Number.isInteger(n) ? _importCandidates[n] : undefined;
  if (!cand) return ctx.reply('Session expired. Send /importsettings again.');
  const read = readOldFormat(DATA_DIR, cand.name);
  if (!read.ok) return ctx.reply(`❌ ${read.reason}. Nothing was imported.`);
  const abMode = autoBuyModeText(cardAutoBuy(app.autoBuy.heartbeat().autobuy, null));
  if (parts[1] === 'pick') {
    let current: any = {};
    try { current = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8')); } catch { current = { schema: 2 }; }
    const m = mergeImport(current, read.doc, cand.name, read.sha256, now, activePolicy(), abMode);
    if (m === 'already') return ctx.reply(`${cand.name} was already imported. Nothing to do.`);
    const nonce = NONCES.issue(`imp:${n}`, now);
    return ctx.reply(`Preview:\n\n${m.summary}`, Markup.inlineKeyboard([[Markup.button.callback('✅ Import', `imp:yes:${n}:${nonce}`)], [Markup.button.callback('✖ Cancel', 'imp:no')]]));
  }
  if (parts[1] === 'yes') {
    if (!NONCES.consume(`imp:${n}`, parts[3] || '', now)) return ctx.reply('❌ This confirmation expired or was already used. Nothing was imported.');
    const out = importIntoSettingsFile(DATA_DIR, { name: cand.name, doc: read.doc, sha256: read.sha256 }, now, activePolicy(), abMode);
    if (out.status !== 'imported') return ctx.reply(`${out.status === 'already' ? 'ℹ️' : '❌'} ${out.reason}`);
    _cache.settings = null;   // the file changed under the cache: read it again
    const s = loadSettings();
    s.signal = markNoticeSent(s.signal, now);   // the summary is sent right here, once
    saveSettings(s);
    logOk(`[settings] imported the restored keys from ${cand.name} (backup: ${path.basename(out.backupFile || '')})`);
    await ctx.reply(out.summary || '♻️ Imported.');
    return replyMenu(ctx, 'menu:signals');
  }
  return ctx.reply('Session expired. Send /importsettings again.');
}

// ── A-115: the plan of an open position (Positions card) ──────
async function handlePlanCallback(ctx: any, data: string) {
  const parts = data.split(':');
  const now = app.clock.now();
  const live = (ca: string) => app.store.listOpen().filter(p => p.ca === ca && !p.dry_run && runsPlan(p));
  if (parts[1] === 'apply' || parts[1] === 'own') {
    if (parts[2] === 'yes') {
      const ca = sess.pendingData.ppCa;
      if (!ca || !NONCES.consume(`pp:${parts[1]}:${ca}`, parts[3] || '', now)) return ctx.reply('❌ This confirmation expired or was already used. Nothing was changed.');
      if (parts[1] === 'own') {
        const res = live(ca).filter(p => p.origin === 'manual' && p.exit_plan).map(p => switchToOwnOrders(app.store, p.position_id, app.exits.mutex));
        const okN = res.filter(r => r.ok).length;
        const why = res.filter((r): r is { ok: false; why: string } => !r.ok).map(r => r.why).join('; ');
        return ctx.reply(`✋ ${okN} position(s) of ${shortCA(ca)} now run your own orders (add TP / SL / TSL from the token card).${why ? ` Not changed: ${why}.` : ''}`);
      }
      const out: string[] = [];
      for (const g of ['A', 'B', 'C'] as Grade[]) {
        const cands = gradeCandidates(g, p => p.ca === ca);
        if (!cands.length) continue;
        const plan = resolvePlan(presetSettingsOf(loadSettings()), g, activePolicy()).snapshot;
        const r = applyPlan(app.store, cands, plan, activePolicy(), g, app.exits.mutex);
        out.push(`grade ${g}: ${r.applied.length} applied${r.skipped.length ? `, ${r.skipped.length} not changed (${r.skipped.map(x => x.why).join('; ')})` : ''}`);
      }
      return ctx.reply(`♻️ ${shortCA(ca)}: ${out.join(' · ') || 'nothing to change'}`);
    }
    const ca = validateCa(parts[2]);
    if (!ca) return ctx.reply('❌ Invalid token address');
    const ps = live(ca);
    if (!ps.length) return ctx.reply('No open position of this token runs a plan.');
    sess.pendingData.ppCa = ca;
    const nonce = NONCES.issue(`pp:${parts[1]}:${ca}`, now);
    const cur = loadSettings().signal.gradePresets;
    const lines = ps.map(p => `• ${planLine(p.exit_plan, p.policy_id, cur)}`).join('\n');
    const q = parts[1] === 'apply'
      ? `♻️ Put the CURRENT grade plan on ${shortCA(ca)}? Basis, peak, take-profits already done and the sold part stay.\n${lines}`
      : `✋ Move ${shortCA(ca)} to your own orders? Its grade plan stops; your TP / SL / TSL orders, the −25% floor and the hard-rug exit apply from now on.\n${lines}`;
    return ctx.reply(q, Markup.inlineKeyboard([[Markup.button.callback(parts[1] === 'apply' ? '♻️ Yes, apply' : '✋ Yes, switch', `pp:${parts[1]}:yes:${nonce}`)], [Markup.button.callback('✖ Cancel', 'in:cancel')]]));
  }
  return ctx.reply('Unknown position action.');
}

/** Registers every Telegram handler on `b`. */
function registerHandlers(bot: Telegraf<Context>) {
  bot.catch((err: any, ctx: Context) => {
    const msg = redactSecrets(String(err?.message || err || '')).slice(0, 200);
    const where = updateWhere(ctx);
    if (isBenignTgError(msg)) {
      logWarn(`[bot] benign tg error (${where}): ${msg.slice(0, 140)}`);
      return;
    }
    logErr(`[bot] handler error (${where}): ${msg}${errWhere(err)}`);
  });

  // 2026-09-29 (security T4): owner-only AND private-chat-only on EVERY update (access-control.ts). Replaces the old from.id-only
  // check: the bot no longer answers in groups, and edited messages / channel posts / inline queries / forged or oversized callback
  // data never reach a handler. Must stay the FIRST middleware.
  bot.use((ctx, next) => isAllowedUpdate(ctx.update, OWNER_ID) ? next() : undefined);

  // 2026-09-29 (security T2d): a private key or seed phrase pasted anywhere is deleted on sight (secret-guard.ts), BEFORE any other
  // handling — except the /import flow, which deletes the message itself before decoding (T2c): the `/import <key>` command, and plain
  // text while the import prompt is open.
  // REBUILD-CHOSEN: wired as a middleware right after the access gate (the spec names bot.on('text')) so a key pasted as a command
  // argument (`/buy <key>`) or as a photo caption is caught too; seed phrases only match a message made of nothing else, so commands
  // never trip that check. The /import exemption only covers text Telegraf really routes to the import handler (lowercase, no
  // @suffix or @<this bot>) — isRoutedImportCommand().
  bot.use(async (ctx, next) => {
    const m: any = (ctx as any).message;
    const text: unknown = m?.text ?? m?.caption;
    if (typeof text !== 'string' || !text) return next();
    const isText    = typeof m?.text === 'string';           // captions are never exempt
    const isCommand = text.startsWith('/');
    if (isText && isRoutedImportCommand(text, (ctx as any).me)) return next();
    if (isText && !isCommand && isImportPrompt(sess.awaitingInput)) return next();
    if (!shouldDeleteForSecrets(text.trim())) return next();
    await ctx.deleteMessage().catch(() => {});
    log(SECRET_GUARD_LOG);                                  // never the text
    await ctx.reply(SECRET_GUARD_REPLY).catch(() => {});    // plain text, no parse_mode
  });

  // 2026-09-26: GMGN skill commands + the `sk:` button handler (skill-commands.ts). REBUILD-CHOSEN placement: right after BOTH
  // middlewares above (access gate, then secret guard), so every skill command and tap is owner-only / private-only and a key
  // pasted as an argument is deleted first; and BEFORE bot.command('wallet') (bare /wallet falls through to it) and
  // bot.on('callback_query') (sk: taps never reach the big handler).
  registerSkillCommands(bot, { onCommand: () => { sess.awaitingInput = null; } });

  // ── Commands ──────────────────────────────────────────────────
  // /start can carry a deep-link payload from the dashboard's Buy button: https://t.me/<bot>?start=<CA> → Telegram delivers
  // "/start <CA>". If the payload looks like a Solana address, render a token card (the same buttons) so the existing
  // `buy:${ca}:${amount}` callback handler picks it up. Otherwise fall through to the main menu.
  const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  bot.start(async ctx => {
    // A-115: /start, like /menu, opens the main menu AND clears any pending input prompt; /start <CA> keeps the deep-link token card
    sess.awaitingInput = null;
    sess.returnTo = null;
    const act = startAction(ctx.message?.text || '');

    if (act.kind === 'token' && SOLANA_ADDR_RE.test(act.ca) && validateCa(act.ca)) {
      const ca     = act.ca;
      const wallet = getDefaultWallet();
      if (!wallet) {
        return ctx.reply(`No wallet imported yet. Use /import first, then click Buy on the dashboard again.\n\n\`${ca}\``,
          { parse_mode: 'Markdown' });
      }

      const loading = await ctx.reply(`⏳ Loading ${shortCA(ca)}…`);
      const card = await reportCard(ca);
      sess.pendingCA = ca;
      const buyBtns = buyKbFor(ca).map((a: number) => Markup.button.callback(`🟢 Buy ${a} SOL`, `buy:${ca}:${a}`));
      const skRow = skillButtonsRow(ca);   // 🔬 skills row; [] for an invalid CA
      const kb = Markup.inlineKeyboard([
        buyBtns,
        [Markup.button.callback('🔴 Sell 50%',  `sell:${ca}:50`),
         Markup.button.callback('🔴 Sell 100%', `sell:${ca}:100`)],
        [Markup.button.callback('🎯 Add TP', `ord:add:tp:${ca}`),
         Markup.button.callback('🛑 Add SL', `ord:add:sl:${ca}`),
         Markup.button.callback('📉 Add TSL', `ord:add:tsl:${ca}`)],
        ...(skRow.length ? [skRow] : []),
        [Markup.button.callback('« Menu', 'menu:main')],
      ]);
      await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, undefined, `${card.text}\n\n${card.markdown ? '_From dashboard deep-link_' : 'From dashboard deep-link'}`, {
        ...(card.markdown ? { parse_mode: 'Markdown' as const } : {}),
        link_preview_options: { is_disabled: true },
        reply_markup: kb.reply_markup,
      });
      return;
    }

    const m = mainMenu();
    await ctx.reply(m.text, { parse_mode: 'Markdown', ...m.kb });
  });
  bot.command('menu', async ctx => {
    // Issuing a command always cancels any pending input prompt so the next text the user types isn't accidentally consumed by a stale
    // flow (e.g. abandoned "Set Rebate Wallet" prompt → CA paste interpreted as a wallet pubkey).
    sess.awaitingInput = null;
    const m = mainMenu();
    await ctx.reply(m.text, { parse_mode: 'Markdown', ...m.kb });
  });

  // A-115 (spec 7.4): bring back the settings an earlier update dropped, from an old-format file of the data folder (never a path from the chat)
  bot.command('importsettings', async ctx => {
    sess.awaitingInput = null;
    _importCandidates = listImportCandidates(DATA_DIR);
    if (!_importCandidates.length) {
      return ctx.reply('No old-format settings file in the bot data folder (settings.json.bak-<stamp> or settings.old-bot.json). Nothing to import.');
    }
    const rows = _importCandidates.slice(0, 8).map((c, i) => [Markup.button.callback(`📄 ${c.name}`, `imp:pick:${i}`)]);
    return ctx.reply('♻️ Import your old settings from which file?\nOnly the restored keys are written (Active, Min Score, the MCap and liquidity limits, Auto-Sell by Grade, the grade presets); a backup of settings.json comes first.',
      Markup.inlineKeyboard([...rows, [Markup.button.callback('✖ Cancel', 'imp:no')]]));
  });

  bot.command('rebates', async ctx => {
    sess.awaitingInput = null;
    const m = rebatesMenu();
    await ctx.reply(m.text, { parse_mode: 'Markdown', ...m.kb });
  });

  bot.command('wallet', async ctx => {
    const wallet = getDefaultWallet();
    if (!wallet) return ctx.reply('No wallets. Use /import first.');
    const kp  = getKeypair(wallet);
    const bal = kp ? await getSolBalance(kp.publicKey.toString()).catch(() => 0) : 0;
    ctx.reply(`👛 *${mdName(wallet.name, 'Wallet', 20)}* (Default)\n\`${kp?.publicKey.toString()}\`\nBalance: *${fmtSol(fromLamps(bal))} SOL*`, { parse_mode: 'Markdown' });
  });

  // ── /check <CA> — the token report from the Engine's GMGN snapshot (the old risk-report and price-site lookups are gone) ──
  bot.command('check', async ctx => {
    const arg = (ctx.message?.text || '').split(/\s+/)[1];
    if (!arg) return ctx.reply('Usage: `/check <CA>`  (name search: /search <query>)', { parse_mode: 'Markdown' });
    // 2026-09-29 (security T6): the address must be a real 32-byte base58 public key before any lookup.
    const ca = validateCa(arg.replace(/^\$/, ''));
    if (!ca) return ctx.reply('❌ Invalid token address. Ticker lookup is not available in this build: use /search <query> to find a token.');

    const msg = await ctx.reply(`🔍 Checking ${shortCA(ca)}...`);
    try {
      const card = await reportCard(ca);
      const skRow = skillButtonsRow(ca);   // 🔬 skills row; [] for an invalid CA
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, card.text, {
        ...(card.markdown ? { parse_mode: 'Markdown' as const } : {}),
        link_preview_options: { is_disabled: true },
        ...(skRow.length ? { reply_markup: Markup.inlineKeyboard([skRow]).reply_markup } : {}),
      });
    } catch (e: any) {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `❌ Check failed: ${errText(e)}`);
    }
  });

  bot.command('positions', async ctx => {
    await startPositionMonitor(ctx);
  });

  bot.command('orders', ctx => {
    const { text, buttons } = buildOrdersText();
    ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  });

  bot.command('import', async ctx => {
    // Split on any whitespace: with split(' ') a double space left the key in [2], the prompt branch ran, and the pasted key was
    // never deleted.
    const key = ctx.message.text.trim().split(/\s+/)[1];
    if (!key) return prompt(ctx, '🔐 Paste your base58 private key:\n\n⚠️ Message will be deleted immediately.', 'w:import:_', 'menu:wallets');
    sess.awaitingInput = null;
    await handleAwaitedInput(ctx, 'w:import:_', key);
  });

  bot.command('buy', async ctx => {
    // Any-whitespace split: with split(' ') a double space made the amount '' and the default was bought instead of the typed amount.
    const [, rawCa, solStr] = ctx.message.text.trim().split(/\s+/);
    if (!rawCa) return ctx.reply('Usage: /buy <CA> [SOL]');
    // 2026-09-29 (security T6): validated CA + amount. An EMPTY amount means the default; explicit garbage is refused (the old
    // `parseFloat(x) || default` silently bought the default on a typo). No max yet — user decision #5.
    const ca = validateCa(rawCa);
    if (!ca) return ctx.reply('❌ Invalid token address');
    const sol = (solStr === undefined || solStr.trim() === '')
      ? parseSolAmount(loadSettings().signal.buyAmount)
      : parseSolAmount(solStr);
    if (sol === null) return ctx.reply('❌ Invalid SOL amount. Usage: /buy <CA> [SOL]');
    const wallet = getDefaultWallet();
    if (!wallet) return ctx.reply('No wallet. Use /import first.');
    const msg = await ctx.reply(`⏳ Buying ${sol} SOL of ${shortCA(ca)}…`);
    await runBuy(ctx, msg.message_id, ca, sol, wallet);
  });

  bot.command('sell', async ctx => {
    const [, rawCa, pctStr] = ctx.message.text.trim().split(/\s+/);
    if (!rawCa) return ctx.reply('Usage: /sell <CA> [percent]');
    // 2026-09-29 (security T6): an EMPTY percent means 100; garbage is refused (the old `parseInt(x) || 100` turned a typo such as
    // '1OO' into a full exit).
    const ca = validateCa(rawCa);
    if (!ca) return ctx.reply('❌ Invalid token address');
    const pct = (pctStr === undefined || pctStr.trim() === '') ? 100 : parsePercent(pctStr);
    if (pct === null) return ctx.reply('❌ Invalid percent — use a whole number from 1 to 100. Usage: /sell <CA> [percent]');
    const wallet = getDefaultWallet();
    if (!wallet) return ctx.reply('No wallet.');
    const msg = await ctx.reply(`⏳ Selling ${pct}% of ${shortCA(ca)}…`);
    await runSellAndReport(ctx, msg.message_id, ca, pct, wallet, false);
  });

  // ── Text handler ──────────────────────────────────────────────
  // (The secret guard runs before this, as a middleware — see bot.use above.)
  bot.on('text', async ctx => {
    const text = ctx.message.text.trim();

    // The auto-buy gate: /autobuy status | dryrun <ARM> | on <ARM> | off | resume, and the CONFIRM <ARM> <report_id> reply. Plain text
    // replies; null = not an auto-buy message.
    const abReply = await app.autoBuy.commands.handle(text, { isOwner: true });
    if (abReply !== null) {
      sess.awaitingInput = null;
      await ctx.reply(abReply);
      return;
    }

    if (sess.awaitingInput) {
      const key = sess.awaitingInput;
      sess.awaitingInput = null;
      await handleAwaitedInput(ctx, key, text);
      return;
    }

    if (isSolCA(text)) {
      await handleTokenReport(ctx, text);
      return;
    }

    const m = mainMenu();
    await ctx.reply(m.text, { parse_mode: 'Markdown', ...m.kb });
  });

  // ── Callback handler ──────────────────────────────────────────
  bot.on('callback_query', async ctx => {
    const data = (ctx.callbackQuery as any).data as string | undefined;
    if (!data) return ctx.answerCbQuery();
    await ctx.answerCbQuery().catch(() => {});

    // ── MENUS ──
    if (data === 'menu:main') {
      const m = mainMenu();
      return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => {});
    }
    if (data === 'menu:wallets') {
      const ws = loadWallets();
      return ctx.editMessageText('👛 *Wallets*\n\nSelect a wallet to manage:', { parse_mode: 'Markdown', ...walletsMenu(ws) }).catch(() => {});
    }
    if (data === 'menu:signals') {
      const m = signalsMenu(loadSettings());
      return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => {});
    }
    if (data === 'menu:positions') {
      // Live position monitor — auto-refreshing card with carousel. Replaces the old static text list.
      try { await ctx.deleteMessage(); } catch { /* ignore — was a callback message */ }
      await startPositionMonitor(ctx);
      return;
    }
    if (data === 'menu:rebates') {
      const m = rebatesMenu();
      return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => {});
    }
    // ── REBATES (reb:*) ──
    if (data === 'reb:toggle') {
      const s = loadSettings();
      s.rebates ||= { enabled: false, address: '' };
      if (!s.rebates.address && !s.rebates.enabled) {
        // Can't turn ON without an address set — guide the user.
        await ctx.answerCbQuery('Set a wallet first ↓', { show_alert: false }).catch(() => {});
        return;
      }
      s.rebates.enabled = !s.rebates.enabled;
      saveSettings(s);
      const m = rebatesMenu();
      return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => {});
    }
    if (data === 'reb:setaddr') {
      return prompt(ctx,
        '💼 *Set Rebate Wallet*\n\n' +
        'Send me the Solana wallet pubkey that should receive MEV rebates ' +
        '(base58, 32–44 chars). It must be a real wallet — PDAs and program ' +
        'addresses are rejected.\n\n' +
        'Send `cancel` to abort.',
        'reb:setaddr', 'menu:rebates', { parse_mode: 'Markdown' },
      );
    }
    if (data === 'reb:viewhist') {
      const s = loadSettings();
      const addr = s.rebates?.address;
      if (!addr) {
        await ctx.answerCbQuery('No address set yet.', { show_alert: true }).catch(() => {});
        return;
      }
      return ctx.reply(
        `📊 *Recent Rebates*\n\n` +
        `Watch incoming SOL transfers to your rebate wallet:\n` +
        `[Solscan ↗](https://solscan.io/account/${addr})\n\n` +
        `Each winning trade with captured MEV deposits SOL in the same ` +
        `block as your swap.`,
        { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } },
      );
    }
    // ── POSITION MONITOR (pm:*) ──
    if (data.startsWith('pm:')) {
      // First, let the monitor handle its own actions (nav/refresh/close/mev)
      const handled = await handlePmCallback(ctx, data);
      if (handled) return;

      // Sell + slippage + tip + limits handlers (need the manual trader + sess)
      const parts = data.split(':');                 // pm:sell:pct:<ca>:<n>  etc.
      if (parts[1] === 'sell') {
        const sub = parts[2];                        // init|all|pct|xpct|xsol|xtok
        // 2026-09-29 (security T6): CA validated FIRST on every position button.
        const ca  = validateCa(parts[3]);
        if (!ca) return ctx.reply('❌ Invalid token address');
        const wallet = getDefaultWallet();
        if (!wallet) { return ctx.reply('No wallet. Use /import first.'); }

        if (sub === 'pct') {
          const pct = parsePercent(parts[4]);        // was parseInt(x) || 0
          if (pct === null) return ctx.reply('❌ Invalid sell percent');
          return runQuickSell(ctx, ca, pct, wallet);
        }
        if (sub === 'all')  return runQuickSell(ctx, ca, 100, wallet);
        if (sub === 'init') return runSellInitials(ctx, ca, wallet);
        if (sub === 'xpct') return prompt(ctx, 'How many percent to sell? (e.g. 35)', `pm:sellpct:${ca}`, 'menu:positions');
        if (sub === 'xsol') return prompt(ctx, 'How many SOL worth to sell? (e.g. 0.05)', `pm:sellsol:${ca}`, 'menu:positions');
        if (sub === 'xtok') return prompt(ctx, 'How many tokens to sell? (e.g. 1500000)', `pm:selltok:${ca}`, 'menu:positions');
      }

      if (parts[1] === 'cfg') {
        const sub = parts[2];                        // slip|tip
        const ca  = validateCa(parts[3]);
        if (!ca && (sub === 'slip' || sub === 'tip')) return ctx.reply('❌ Invalid token address');
        if (sub === 'slip') return prompt(ctx, 'New slippage % for this token (1-50, e.g. 15):', `pm:slip:${ca}`, 'menu:positions');
        if (sub === 'tip') return prompt(ctx, 'Helius tip in SOL for this token (e.g. 0.0002):', `pm:tip:${ca}`, 'menu:positions');
        // mev is handled inside handlePmCallback
      }

      if (parts[1] === 'limits') {
        // pm:limits:<ca>  — comes from the position card. CA fits within budget here (54 bytes total). Sub-actions below carry no
        // CA to stay safe.
        const ca = validateCa(parts[2]);
        if (!ca) return ctx.reply('❌ Invalid token address');
        return openLimitsSubmenu(ctx, ca);
      }
      if (parts[1] === 'lim') {
        // Compact callbacks (no CA in the URL — resolved via registry):
        //   pm:lim:del:<orderId>      → cancel that order
        //   pm:lim:add                → open type picker
        //   pm:lim:addtype:<tp|sl|tsl>→ ask for trigger %
        //   pm:lim:back               → reopen position card
        const action = parts[2];

        if (action === 'add') {
          if (!_activeLimitMenuCa) return ctx.reply('Session expired. Reopen Sell Limits from the position card.');
          return openAddLimitWizard(ctx, _activeLimitMenuCa);
        }
        if (action === 'addtype') {
          const t = parts[3];   // tp | sl | tsl
          if (!['tp', 'sl', 'tsl'].includes(t)) return ctx.reply('❌ Unknown order type');
          if (!_activeLimitMenuCa) return ctx.reply('Session expired. Reopen Sell Limits from the position card.');
          return prompt(ctx, `Enter trigger % for ${t.toUpperCase()} (e.g. 50 for +50%, -10 for -10%):`, `pm:limadd:${_activeLimitMenuCa}:${t}`, 'menu:positions');
        }
        if (action === 'del') {
          const orderId = parts[3];
          if (!orderId) return ctx.reply('❌ Missing order id.');
          const o = app.store.getOrder(orderId);
          if (!o) return ctx.reply('❌ Order not found (may already be cancelled).');
          app.store.updateOrder(orderId, { active: false, deactivated_reason: 'cancelled' });
          await ctx.reply('🗑 Order removed.');
          return openLimitsSubmenu(ctx, o.ca);
        }
        if (action === 'back') {
          const ca = _activeLimitMenuCa;
          if (!ca) return startPositionMonitor(ctx);
          return startPositionMonitor(ctx, ca);
        }
      }
    }
    if (data === 'menu:orders') {
      const { text, buttons } = buildOrdersText();
      return ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([...buttons, [Markup.button.callback('« Back', 'menu:main')]]) }).catch(() => {});
    }
    if (data === 'menu:buy') {
      const m = buySettingsMenu(loadSettings());
      return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => {});
    }
    if (data === 'menu:sell') {
      const m = sellSettingsMenu(loadSettings());
      return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => {});
    }
    if (data === 'menu:global') {
      const m = globalSettingsMenu(loadSettings());
      return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => {});
    }

    // ── WALLET ACTIONS ──
    if (data.startsWith('w:view:') || data.startsWith('w:refresh:')) {
      const wid = data.split(':')[2];
      const ws  = loadWallets();
      const w   = ws.find((x: any) => x.id === wid);
      if (!w) return ctx.answerCbQuery('Wallet not found').catch(() => {});
      const kp  = getKeypair(w);
      if (!kp) {
        logErr(`wallet ${w.name}: keypair decrypt FAILED`);
        return ctx.editMessageText(
          `👛 *${mdName(w.name, 'Wallet', 20)}*\n\n❌ Keypair could not be decrypted. Re-import the wallet.`,
          { parse_mode: 'Markdown', ...walletDetailMenu(w) }
        ).catch(() => {});
      }
      const addr = kp.publicKey.toString();
      let bal = 0;
      let balErr = '';
      try {
        bal = await getSolBalance(addr);
        log(`wallet ${w.name} (${addr.slice(0,6)}...) balance = ${bal} lamports = ${fromLamps(bal)} SOL`);
      } catch (e: any) {
        balErr = errText(e);
        logWarn(`wallet ${w.name} balance fetch error: ${balErr}`);
      }
      // wSOL balance — independent fetch, never blocks SOL display on failure
      let wsol = 0;
      try { wsol = await getWsolBalance(addr); } catch { /* 0 fallback */ }

      if (data.startsWith('w:refresh:')) {
        ctx.answerCbQuery(`SOL: ${fmtSol(fromLamps(bal))} · wSOL: ${fmtSol(wsol)}`).catch(() => {});
      }
      const balLine = balErr
        ? `Balance: *0 SOL* ⚠ (\`${balErr.slice(0, 50).replace(/`/g, "'")}\`)`
        : `Balance: *${fmtSol(fromLamps(bal))} SOL*  ·  wSOL: *${fmtSol(wsol)}*`;
      const pwLine = w.usePreWrappedSol
        ? `Pre-wrapped wSOL: 💎 *ON* — buys consume wSOL directly (faster)`
        : `Pre-wrapped wSOL: ⚪ OFF — Jupiter wraps each swap`;
      return ctx.editMessageText(
        `👛 *${mdName(w.name, 'Wallet', 20)}*\n\`${addr}\`\n\n${balLine}\nDefault: ${w.isDefault ? '⭐ Yes' : 'No'}\nManual: ${w.manualEnabled ? '✅' : '❌'}\n${pwLine}\n\n_Tap 🔄 Refresh to re-query._`,
        { parse_mode: 'Markdown', ...walletDetailMenu(w) }
      ).catch(() => {});
    }
    if (data.startsWith('w:default:')) {
      const wid = data.split(':')[2];
      const ws  = loadWallets();
      ws.forEach((w: any) => w.isDefault = w.id === wid);
      saveWallets(ws);
      return ctx.editMessageText('👛 *Wallets*', { parse_mode: 'Markdown', ...walletsMenu(ws) }).catch(() => {});
    }
    if (data.startsWith('w:manual:')) {
      const wid = data.split(':')[2];
      const ws  = loadWallets();
      const w   = ws.find((x: any) => x.id === wid);
      if (w) { w.manualEnabled = !w.manualEnabled; saveWallets(ws); }
      return ctx.editMessageText('👛 *Wallets*', { parse_mode: 'Markdown', ...walletsMenu(ws) }).catch(() => {});
    }
    if (data.startsWith('w:rename:')) {
      const wid = data.split(':')[2];
      return prompt(ctx, 'Enter new wallet name:', `w:rename:${wid}`, 'menu:wallets');
    }
    if (data.startsWith('w:sendSol:')) {
      const wid = data.split(':')[2];
      sess.pendingData.sendSolWid = wid;
      return prompt(ctx, 'Enter SOL amount to send:', `w:sendSol:${wid}`, 'menu:wallets');
    }
    if (data.startsWith('w:delete:')) {
      const wid = data.split(':')[2];
      let ws    = loadWallets().filter((x: any) => x.id !== wid);
      if (ws.length && !ws.find((w: any) => w.isDefault)) ws[0].isDefault = true;
      saveWallets(ws);
      return ctx.editMessageText('👛 *Wallets*\nWallet deleted.', { parse_mode: 'Markdown', ...walletsMenu(ws) }).catch(() => {});
    }
    // Toggle pre-wrapped wSOL preference
    if (data.startsWith('w:togpw:')) {
      const wid = data.split(':')[2];
      const ws  = loadWallets();
      const w   = ws.find((x: any) => x.id === wid);
      if (w) {
        w.usePreWrappedSol = !w.usePreWrappedSol;
        saveWallets(ws);
        ctx.answerCbQuery(`Pre-wrapped wSOL: ${w.usePreWrappedSol ? 'ON' : 'OFF'}`).catch(() => {});
      }
      // Re-render the wallet detail
      return ctx.telegram.sendMessage(
        ctx.chat!.id,
        `👛 ${mdName(w?.name, 'Wallet', 20)}: pre-wrapped wSOL is now ${w?.usePreWrappedSol ? '💎 ON' : '⚪ OFF'}\n\nTap Refresh on the wallet card to see updated balances.`
      ).catch(() => {});
    }
    // Wrap → wSOL wizard (asks how much SOL to wrap)
    if (data.startsWith('w:wrap:')) {
      const wid = data.split(':')[2];
      return prompt(ctx, '💎 How many SOL to wrap into wSOL? (e.g. 0.5)\n\nKeep at least ~0.05 SOL native for fees + Helius tips.', `w:wrapAmt:${wid}`, 'menu:wallets');
    }
    // Unwrap all wSOL → SOL (closes the wSOL ATA, refunds rent + balance)
    if (data.startsWith('w:unwrap:')) {
      const wid = data.split(':')[2];
      const ws  = loadWallets();
      const w   = ws.find((x: any) => x.id === wid);
      if (!w) return ctx.answerCbQuery('Wallet not found').catch(() => {});
      const kp  = getKeypair(w);
      if (!kp) return ctx.reply('❌ Cannot decrypt keypair.');
      const msg = await ctx.reply('⏳ Unwrapping all wSOL → SOL…');
      try {
        const sig = await unwrapAllWsol(kp);
        await ctx.telegram.editMessageText(ctx.chat!.id, msg.message_id, undefined,
          `✅ Unwrapped — wSOL ATA closed, balance + rent refunded.\n[View tx](https://solscan.io/tx/${sig})`,
          { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } } as any);
      } catch (e: any) {
        await ctx.telegram.editMessageText(ctx.chat!.id, msg.message_id, undefined,
          `❌ Unwrap failed: ${errText(e)}`).catch(() => {});
      }
      return;
    }
    if (data === 'w:import') {
      return prompt(ctx, '🔐 Paste your base58 private key:\n\n⚠️ Message will be deleted immediately.', 'w:import:_', 'menu:wallets');
    }
    if (data === 'w:generate') {
      const ws = loadWallets();
      if (ws.length >= MAX_WALLETS) return ctx.answerCbQuery(`Max ${MAX_WALLETS} wallets`).catch(() => {});
      const kp  = Keypair.generate();
      const raw = bs58.encode(kp.secretKey);
      ws.push({ id: uid(), name: `Wallet ${ws.length + 1}`, isDefault: ws.length === 0, manualEnabled: true, enc: encryptSecret(raw, WALLET_PRIMARY) });
      try { saveWallets(ws); }
      catch (e: any) { ws.pop(); return ctx.reply(`❌ Wallet not saved: ${errText(e)}`); }
      // Message below kept UNCHANGED: showing the raw key is open user decision #1.
      await ctx.reply(`🎲 *New wallet generated*\n\nAddress: \`${kp.publicKey.toString()}\`\n\n⚠️ *BACK UP YOUR PRIVATE KEY NOW:*\n\`${raw}\`\n\nStore this safely — it will NOT be shown again.`, { parse_mode: 'Markdown' });
      return ctx.editMessageText('👛 *Wallets*', { parse_mode: 'Markdown', ...walletsMenu(ws) }).catch(() => {});
    }

    // ── UNCLAIMEDSOL PARTNER (ucs:scan) — v4, 2026-07-21 ──
    // Affiliate-link claiming: only claims through the partner link credit the 20% revenue share and show on the partner dashboard,
    // so the bot links out instead of signing. The displayed amount still comes from the bot's own read-only on-chain scan — real
    // rent lamports, the same arithmetic the unclaimedsol.com dashboard shows (their Scan API just returns tokenCount × 0.002 and
    // never matches).
    // NOTE: the dispatcher already answered this callback query, so toast-style answerCbQuery calls are DEAD here — every outcome
    // must reply or edit.
    if (data === 'ucs:scan') {
      const wallet = getDefaultWallet();
      if (!wallet) return ctx.reply('❌ No wallet yet — use /import first, then tap 💰 Get Your UnclaimedSol again.');
      const kp = getKeypair(wallet);
      if (!kp) return ctx.reply('❌ Keypair error — re-import the wallet, then try again.');
      const msg = await ctx.reply(`🔍 Checking your wallet…\n\`${kp.publicKey.toString()}\``, { parse_mode: 'Markdown' });
      const edit = (text: string, extra: any = {}) =>
        ctx.telegram.editMessageText(ctx.chat!.id, msg.message_id, undefined, text, extra as any)
          .catch(() => ctx.reply(text, extra).catch(() => {}));
      const claimKb = { inline_keyboard: [[{ text: '💸 Claim on UnclaimedSol', url: UCS_CLAIM_URL }]] };
      try {
        const pairs = await scanClaimableAccounts(ucsConnection(), kp.publicKey, true);
        notifyPartnerScan(kp.publicKey.toString());   // fire-and-forget partner attribution
        if (!pairs.length) {
          return edit('✨ Wallet is clean — nothing to claim right now.');
        }
        const sum   = summarizeClaim(pairs);
        const total = sum.totalLamports / LAMPORTS_PER_SOL;
        const keep  = sum.keepLamports / LAMPORTS_PER_SOL;
        const dustN = pairs.filter((p: any) => p.dust).length;
        // The site's cleanup burns whatever the user selects there — warn when the bot holds live positions in this wallet.
        const posWarn = app.store.listOpen().some(p => !p.dry_run)
          ? `⚠️ The bot has OPEN positions in this wallet — on the site, do NOT close accounts of tokens you still hold.\n\n`
          : '';
        return edit(
          `💰 *You can claim back ~${total.toFixed(4)} SOL*\n\n` +
          `Wallet: \`${kp.publicKey.toString()}\`\n` +
          `Token accounts: *${pairs.length}* (${pairs.length - dustN} empty · ${dustN} with dust)\n` +
          `You receive ~${keep.toFixed(4)} SOL after the ${(sum.feeLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL cleanup fee.\n\n` +
          posWarn +
          `Tap below and connect this wallet on UnclaimedSol to claim.`,
          { parse_mode: 'Markdown', link_preview_options: { is_disabled: true }, reply_markup: claimKb });
      } catch (e: any) {
        // Scan failed — plain text (no parse_mode), still hand out the link.
        return edit(`⚠️ Scan failed: ${errText(e, 140)}\nYou can still claim directly on UnclaimedSol:`, { reply_markup: claimKb });
      }
    }
    if (data === 'ucs:cancel' || data === 'ucs:claim') {
      // Legacy buttons from the retired in-TG claim flow (pre-v4 cards).
      return ctx.editMessageText('ℹ️ Claiming now happens on unclaimedsol.com — tap 💰 Get Your UnclaimedSol for a fresh link.').catch(() => {});
    }

    // ── SIGNAL SETTINGS ──
    if (data === 'sig:cycle:tgGrade') {
      // Which grades get a Telegram card: A only, A+B, or A+B+C. The Engine decides what a signal is; this only filters the cards.
      const s = loadSettings();
      s.signal.tgMinGrade = GRADE_CYCLE[s.signal.tgMinGrade] ?? 'B';
      saveSettings(s);
      const m = signalsMenu(s); return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => {});
    }
    if (data === 'sig:toggle:degenMode') {
      const s = loadSettings(); s.signal.degenMode = !(s.signal.degenMode ?? s.global.degenMode); saveSettings(s);
      const m = signalsMenu(s); return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => {});
    }
    // A-115: the restored Signals switches
    if (data === 'sig:toggle') {
      const s = loadSettings(); s.signal.enabled = s.signal.enabled === false; saveSettings(s);
      const m = signalsMenu(s); return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => {});
    }
    if (data === 'sig:toggle:autoSell') {
      const s = loadSettings(); s.signal.autoSellOnSignal = s.signal.autoSellOnSignal === false; saveSettings(s);
      const m = signalsMenu(s); return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => {});
    }
    if (data.startsWith('sig:set:')) {
      const field = data.split(':')[2];
      const prompts: any = {
        buyAmount: 'Enter buy amount in SOL (e.g. 0.01):',
        slippageBps: 'Enter slippage % (e.g. 5 for 5%):',
        minScore: '🎯 Min Score: a whole number from 0 to 100, or "none" for no minimum.\nThe Engine\'s confidence: every card is ≥ 85 (85-89 STRONG, 90-99 ULTRA). Applies to the cards you get and to auto-buy.',
        minMcap: '📉 Min MCap in USD (e.g. 20000; 0 or "none" = no limit). Applies to the cards you get and to auto-buy:',
        maxMcap: '📈 Max MCap in USD (e.g. 150000; 0 or "none" = no limit). Applies to the cards you get and to auto-buy:',
        minLiquidity: '💧 Min liquidity in USD (e.g. 5000; 0 or "none" = no limit). An unknown liquidity fails a set limit:',
        maxLiquidity: '💧 Max liquidity in USD (e.g. 50000; 0 or "none" = no limit). An unknown liquidity fails a set limit:',
      };
      if (!Object.prototype.hasOwnProperty.call(prompts, field)) return;
      return prompt(ctx, prompts[field], `sig:${field}`, 'menu:signals');
    }

    // ── A-115: the grade presets (tier:*, tb:*) ──
    if (data.startsWith('tier:') || data.startsWith('tb:bal:')) return handleTierCallback(ctx, data);

    // ── A-115: a buy from a signal card (the card's grade plan) ──
    if (data.startsWith('sbuy:') && data.split(':').length === 3) {
      const [, rawCa, solStr] = data.split(':');
      const ca = validateCa(rawCa);
      if (!ca) return ctx.reply('❌ Invalid token address');
      const sol = parseSolAmount(solStr);
      if (sol === null) return ctx.reply('❌ Invalid buy amount');
      const wallet = getDefaultWallet();
      if (!wallet) return ctx.reply('❌ No wallet. Use /import first.');
      const grade = app.inbox.signalled(ca)?.grade;
      if (!isGrade(grade)) return ctx.reply('❌ The signal of this card is no longer known, so its grade plan cannot be used. Paste the CA for a plain manual buy.');
      const plan = cardBuyPlan(presetSettingsOf(loadSettings()), grade, activePolicy(), m => logWarn(`[sbuy] ${m}`));
      const planText = plan.source === 'preset' ? `your grade-${grade} preset rev ${plan.rev}` : `exit policy ${plan.policy.id}`;
      const msg = await ctx.reply(`⏳ Buying ${sol} SOL… (exits: ${planText})`);
      await runBuy(ctx, msg.message_id, ca, sol, wallet, plan);
      return;
    }

    // ── A-115: ✖ Cancel of every prompt ──
    if (data === 'in:cancel') {
      const to = cancelPrompt(sess);
      await ctx.reply('Cancelled. Nothing was saved.');
      return replyMenu(ctx, to);
    }

    // ── A-115: /importsettings ──
    if (data.startsWith('imp:')) return handleImportCallback(ctx, data);

    // ── A-115: the plan of an open position (Positions card) ──
    if (data.startsWith('pp:')) return handlePlanCallback(ctx, data);

    // ── TRADING SESSION (stime:*) — 2026-07-08 ──
    if (data === 'stime:menu') {
      const m = sessionMenu(loadSettings());
      return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => {});
    }
    if (data === 'stime:toggle') {
      const s = loadSettings(); s.signal.sessionEnabled = !s.signal.sessionEnabled; saveSettings(s);
      const m = sessionMenu(s); return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => {});
    }
    if (data.startsWith('stime:preset:')) {
      const presetKey = data.split(':')[2];
      const p = SESSION_PRESETS[presetKey];
      if (!p) return ctx.answerCbQuery('Unknown session').catch(() => {});
      const s = loadSettings();
      s.signal.sessionPreset  = presetKey;
      s.signal.sessionStart   = p.start;
      s.signal.sessionEnd     = p.end;
      s.signal.sessionTz      = p.tz;
      s.signal.sessionEnabled = true;   // picking a session means you want the window on
      saveSettings(s);
      const m = sessionMenu(s); return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => {});
    }
    if (data.startsWith('stime:set:')) {
      const field = data.split(':')[2]; // start | end | tz
      const prompts: any = {
        start: '🕒 Enter session START time as HH:MM, 24h clock (e.g. 08:00).\nSend cancel to abort.',
        end:   '🕕 Enter session STOP time as HH:MM, 24h clock (e.g. 17:00).\nA stop before the start wraps past midnight (e.g. 22:00–06:00).\nSend cancel to abort.',
        tz:    '🌐 Enter an IANA timezone, e.g. America/New_York, Europe/London, Europe/Paris, Asia/Tokyo, Asia/Dubai.\nSend cancel to abort.',
      };
      return prompt(ctx, prompts[field] || 'Enter value:', `stime:${field}`, 'stime:menu');
    }

    // ── BUY SETTINGS ──
    if (data.startsWith('buy:set:')) {
      const field = data.split(':')[2];
      const prompts: any = {
        slippageBps: 'Enter slippage % (e.g. 3 for 3%):',
        priorityFee: 'Enter priority fee in lamports (e.g. 100000):',
        priceImpactAlertBuy: 'Enter price impact alert % (e.g. 25):',
        buyKb: 'Enter buy amounts separated by commas (e.g. 0.1,0.5,1):',
        smartSlippageMax: 'Enter max slippage % allowed on retries (e.g. 15 for 15%):',
        retryMaxAttempts: 'Enter max retry attempts (1–5):',
      };
      return prompt(ctx, prompts[field] || 'Enter value:', `buy:${field}`, 'menu:buy');
    }
    if (data.startsWith('buy:tog:')) {
      const field = data.split(':')[2];
      // 2026-09-29 (security T6): whitelisted fields only — a forged button could previously write onto every object in the bot
      // (field=__proto__ …).
      if (!isToggleAllowed('buy', field)) return ctx.answerCbQuery('Unknown setting').catch(() => {});
      const s     = loadSettings();
      s.global[field] = !s.global[field]; saveSettings(s);
      const m = buySettingsMenu(s);
      return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => {});
    }

    // ── SELL SETTINGS ──
    if (data.startsWith('sell:set:')) {
      const field = data.split(':')[2];
      const prompts: any = {
        slippageBps: 'Enter slippage % (e.g. 5 for 5%):',
        priceImpactAlertSell: 'Enter price impact alert % (e.g. 50):',
        sellKb: 'Enter sell percentages separated by commas (e.g. 25,50,75,100):',
      };
      return prompt(ctx, prompts[field] || 'Enter value:', `sell:${field}`, 'menu:sell');
    }
    if (data.startsWith('sell:tog:')) {
      const field = data.split(':')[2];
      if (!isToggleAllowed('sell', field)) return ctx.answerCbQuery('Unknown setting').catch(() => {});
      const s     = loadSettings();
      s.global[field] = !s.global[field]; saveSettings(s);
      const m = sellSettingsMenu(s);
      return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => {});
    }

    // ── GLOBAL SETTINGS ──
    if (data.startsWith('glob:tog:')) {
      const field = data.split(':')[2];
      if (!isToggleAllowed('glob', field)) return ctx.answerCbQuery('Unknown setting').catch(() => {});
      const s     = loadSettings();
      s.global[field] = !s.global[field]; saveSettings(s);
      const m = globalSettingsMenu(s);
      return ctx.editMessageText(m.text, { parse_mode: 'Markdown', ...m.kb }).catch(() => {});
    }

    // ── BUY (inline) ──
    if (data.startsWith('buy:') && data.split(':').length === 3) {
      const [, rawCa, solStr] = data.split(':');
      // 2026-09-29 (security T6): CA first, then the amount — garbage refused.
      const ca  = validateCa(rawCa);
      if (!ca) return ctx.reply('❌ Invalid token address');
      const sol = parseSolAmount(solStr);
      if (sol === null) return ctx.reply('❌ Invalid buy amount');
      const wallet = getDefaultWallet();
      if (!wallet) return ctx.reply('❌ No wallet. Use /import first.');
      const msg = await ctx.reply(`⏳ Buying ${sol} SOL…`);
      await runBuy(ctx, msg.message_id, ca, sol, wallet);
      return;
    }

    // ── SELL (inline) ──
    if (data.startsWith('sell:') && data.split(':').length === 3) {
      const [, rawCa, pctStr] = data.split(':');
      const ca  = validateCa(rawCa);
      if (!ca) return ctx.reply('❌ Invalid token address');
      const pct = parsePercent(pctStr);
      if (pct === null) return ctx.reply('❌ Invalid sell percent');
      const wallet = getDefaultWallet();
      if (!wallet) return ctx.reply('❌ No wallet.');
      const msg = await ctx.reply(`⏳ Selling ${pct}%…`);
      await runSellAndReport(ctx, msg.message_id, ca, pct, wallet, false);
      return;
    }

    // ── SKIP ──
    if (data.startsWith('skip:')) {
      return ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    }

    // ── ORDER: ADD ──
    if (data.startsWith('ord:add:')) {
      const parts = data.split(':'); // ord:add:tp:CA
      const type  = parts[2];
      const ca    = validateCa(parts.slice(3).join(':'));
      if (!ca) return ctx.reply('❌ Invalid token address');
      const typeLabel: any = { tp: '🎯 Take Profit', sl: '🛑 Stop Loss', tsl: '📉 Trailing Stop Loss' };
      if (!Object.prototype.hasOwnProperty.call(typeLabel, type)) return ctx.reply('❌ Unknown order type');
      const wallet = getDefaultWallet();
      const t = manualTargets(ca, wallet?.id);
      if (t.positions.length === 0) return ctx.reply(`❌ ${t.why}`);
      sess.pendingCA = ca;
      sess.pendingData.orderType = type;
      const hint = type === 'tp' ? `Enter +% to trigger sell\n(e.g. 100 = triggers when the price doubles from the moment the order is first checked)` :
                   type === 'tsl' ? `Enter % drop from peak to trigger\n(e.g. 20 = sells if the price drops 20% from its highest since then)` :
                   `Enter % loss to trigger sell\n(e.g. 50 = triggers when the price drops 50% from the moment the order is first checked)`;
      return prompt(ctx, `${typeLabel[type]} · *${shortCA(ca)}*\n\n${hint}:`, 'ord:pct', 'menu:orders', { parse_mode: 'Markdown' });
    }
    if (data.startsWith('ord:bal:')) {
      const val = data.split(':')[2];
      if (val === 'custom') return prompt(ctx, 'Enter custom sell % (1–100):', 'ord:balance:custom', 'menu:orders');
      sess.pendingData.orderBalance = parseInt(val);
      return ctx.reply(
        `Sell ${val}% of holdings.\n\nActive for how many hours?`,
        Markup.inlineKeyboard([[
          Markup.button.callback('6h', 'ord:dur:6'),   Markup.button.callback('12h', 'ord:dur:12'),
          Markup.button.callback('24h', 'ord:dur:24'), Markup.button.callback('48h', 'ord:dur:48'),
          Markup.button.callback('96h', 'ord:dur:96'),
        ]])
      );
    }
    if (data.startsWith('ord:dur:')) {
      const duration = parseInt(data.split(':')[2]);
      return finalizeOrder(ctx, duration);
    }
    if (data.startsWith('ord:del:')) {
      const ordId = data.split(':')[2];
      const o = ordId ? app.store.getOrder(ordId) : undefined;
      if (o) app.store.updateOrder(ordId, { active: false, deactivated_reason: 'cancelled' });
      const { text, buttons } = buildOrdersText();
      return ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([...buttons, [Markup.button.callback('« Back', 'menu:main')]]) }).catch(() => {});
    }
  });
}

// ── Wallet storage upgrade (2026-09-29, security T5) — once, before launch ──
// Legacy sha256-key entries (and v2 entries written under the bot token when WALLET_ENC_KEY is now set) are re-encrypted as scrypt v2
// under the primary secret: backup first (wallets.json.bak-<stamp>), each new copy verified, atomic owner-only write. Undecryptable
// entries are left untouched, never dropped, and reported in the log + Telegram. Results carry ids/names only.
function upgradeWallets(): string[] {
  const warnings: string[] = [];
  const up = upgradeWalletsFile(path.join(DATA_DIR, 'wallets.json'), WALLET_PASSPHRASES, WALLET_PRIMARY);
  if (up.upgraded) {
    _cache.wallets = up.wallets;
  }
  // the line the CUTOVER.md wallet sequence checks: "[wallets] upgraded N wallet(s)" (N = 0 when there is nothing to upgrade)
  logOk(`[wallets] upgraded ${up.upgraded} wallet(s)${up.upgraded ? ` (backup: ${path.basename(up.backupFile || '')})` : ''}`);
  if (up.unreadable) {
    _walletsFileUnreadable = true;
    const m = '⚠️ data/wallets.json is not readable as a wallet list — left untouched, and wallet changes are refused until it is fixed or moved.';
    logWarn(`[wallets] ${m}`);
    warnings.push(m);
  }
  if (up.error && !up.unreadable) logWarn(`[wallets] upgrade skipped, file left untouched: ${up.error}`);
  if (up.undecryptable.length) {
    const m = undecryptableWarning(up.undecryptable.length);
    logWarn(`[wallets] ${m}`);
    warnings.push(m);
  }
  return warnings;
}

let _handlersInstalled = false;
function installProcessHandlers() {
  if (_handlersInstalled) return;
  _handlersInstalled = true;
  // Process-level safety net for anything that escapes bot.catch (e.g. setTimeout callbacks that throw, await without try/catch in
  // non-handler code paths).
  process.on('uncaughtException', (err: any) => {
    const msg = redactSecrets(String(err?.message || err || '')).slice(0, 200);
    if (isBenignTgError(msg)) {
      logWarn(`[bot] uncaught benign tg error: ${msg.slice(0, 140)}`);
      return;
    }
    logErr(`[bot] uncaughtException: ${msg}${errWhere(err)}`);
  });
  process.on('unhandledRejection', (err: any) => {
    const msg = redactSecrets(String(err?.message || err || '')).slice(0, 200);
    if (isBenignTgError(msg)) {
      logWarn(`[bot] unhandled rejection (benign tg): ${msg.slice(0, 140)}`);
      return;
    }
    logErr(`[bot] unhandledRejection: ${msg}${errWhere(err)}`);
  });
}

/** The entry point: everything with a side effect (files, sockets, timers, Telegram) starts here and nowhere else. */
export async function main(): Promise<void> {
  installProcessHandlers();
  ensureDataDir();

  // 1. wallet storage upgrade, before anything reads the wallets
  const bootWarnings = upgradeWallets();

  // 2. settings.json -> schema 2 (backup first; an unreadable file is never overwritten silently)
  const mig = migrateSettingsFile(DATA_DIR, () => Date.now(), activePolicy());
  if (mig.status === 'migrated') {
    logOk(`[settings] migrated to schema ${SETTINGS_SCHEMA} (backup: ${path.basename(mig.backupFile || '')}; dropped keys: ${mig.dropped.join(', ') || 'none'}`
      + `${mig.imported ? `; old settings imported, not applicable: ${mig.notApplicable.join(', ') || 'none'}` : ''}${mig.importCandidate ? `; /importsettings can restore from ${mig.importCandidate}` : ''})`);
  } else if (mig.status === 'unreadable') {
    const file = path.join(DATA_DIR, 'settings.json');
    const copy = `${file}.bak-unreadable-${Date.now()}`;
    try { fs.copyFileSync(file, copy); } catch { /* the file is left where it is */ }
    const m = `⚠️ data/settings.json cannot be read as JSON: defaults are in use and the next change replaces it. A copy was kept as ${path.basename(copy)}.`;
    logWarn(`[settings] ${m}`);
    bootWarnings.push(m);
  }

  // 3. Telegram client (the API root is overridden only by the end-to-end harness)
  bot = new Telegraf(CONFIG.TG_BOT_TOKEN, { telegram: { apiRoot: CONFIG.TG_API_ROOT } });
  registerHandlers(bot);

  // 4. the wiring: auto-buy recovery, exit engine, events server (127.0.0.1 only), Engine outbox, Engine watch
  try {
    // A-113b: botInfo is read at every heartbeat (Telegraf fills it once launch() has fetched getMe), so bot_username reaches the Engine.
    app = await boot({
      config: CONFIG, env: process.env, dataDir: DATA_DIR, telegram: bot.telegram, wallets: walletsView, settings: settingsView,
      botInfo: () => bot.botInfo,
    });
  } catch (e: any) {
    if (e?.code === 'EADDRINUSE') logErr(`Port ${CONFIG.BOT_PORT} in use`);
    else logErr(`[boot] failed: ${errText(e)}`);
    process.exit(1);
  }
  logOk(`Bot events endpoint: http://127.0.0.1:${app.port}/v1/events`);

  // 5. the position card and the cleanup job read the SAME store and valuation as the exit engine
  configurePositionMonitor({ clock: app.clock, store: () => app.store, valuation: app.valuation, engine: app.engineClient, dataDir: () => DATA_DIR,
    // A-115: each card shows its plan; card buys can switch to the owner's own orders, plan positions can take the current preset
    planOf: group => {
      const real = group.filter(p => !p.dry_run);
      const p0 = real.find(p => p.exit_plan) ?? real[0];
      if (!p0) return { line: null, apply: false, own: false };
      return { line: planLine(p0.exit_plan, p0.policy_id, loadSettings().signal.gradePresets), apply: real.some(runsPlan), own: real.some(p => p.origin === 'manual' && !!p.exit_plan) };
    },
  });
  configurePositionCleanup({
    clock: app.clock, store: () => app.cleanupStore, ownerOf: id => walletsView.get(id)?.owner ?? null, closeAccount: app.closeAccount, dataDir: () => DATA_DIR,
  });

  // allowedUpdates: Telegram only sends new messages + button presses (T4).
  // A-93f: polling is supervised: a failed or ended launch (getMe at boot before the network is up, a 409 Conflict, a 401 ...) is relaunched
  // with a backoff, forever, and the owner is told once per outage; nothing is relaunched while the bot shuts down.
  let shuttingDown = false;
  const polling: LaunchSupervisor = superviseLaunch({
    launch: () => bot.launch({ dropPendingUpdates: true, allowedUpdates: [...ALLOWED_UPDATES] }),
    clock: app.clock, stopping: () => shuttingDown, notifyOwner: t => app.queue.notifyOwner(t),
    log: (m, level) => (level === 'err' ? logErr(redactSecrets(m)) : logWarn(redactSecrets(m))),
  });

  // Position cleanup schedule (2026-05-09): runs once at boot then every 10 min against the wallet's real holdings.
  startPositionCleanupSchedule(bot);

  // 2026-05-16 — Sender keepalive: ping the Helius Sender endpoint every 45s so the TCP/TLS connection stays warm. Cuts ~30-80ms
  // cold-start latency off the first snipe after an idle gap. No-op if ENABLE_SENDER_KEEPALIVE=0.
  startSenderKeepalive();

  // withSkillCommands appends the GMGN skill commands (SKILL_BOT_COMMANDS) without duplicating /wallet (skill-commands.ts).
  bot.telegram.setMyCommands(withSkillCommands([
    { command: 'menu',      description: '🦅 Main menu' },
    { command: 'wallet',    description: '👛 Wallet & balance · /wallet <addr> = wallet dossier' },
    { command: 'positions', description: '📊 Open positions & P&L' },
    { command: 'orders',    description: '🕔 Active limit orders' },
    { command: 'buy',       description: '🟢 Buy token — /buy <CA> [SOL]' },
    { command: 'sell',      description: '🔴 Sell token — /sell <CA> [%]' },
    { command: 'autobuy',   description: '🤖 Auto-buy gate — /autobuy status|dryrun|on|off|resume' },
    { command: 'import',    description: '🔐 Import wallet private key' },
    { command: 'rebates',   description: '🦑 MEV backrun rebates settings' },
    { command: 'importsettings', description: '♻️ Bring back the old settings an update dropped' },
  ])).then(() => logOk('TG commands set ✓'))
    // Redacted: a network FetchError embeds the api.telegram.org/bot<token>/ URL.
    .catch((e: any) => logWarn(`TG setMyCommands failed: ${errText(e)}`));

  logOk(`🦅 ${BRAND} running`);

  // 2026-05-26 — Auto-resume position visibility on bot boot: a one-shot summary of the open positions, so a restart does not leave
  // the owner guessing what is being managed. /positions opens the live cards.
  void (async () => {
    try {
      await new Promise(r => setTimeout(r, 3000));   // small delay so launch finishes
      const live = app.store.listOpen().filter(p => !p.dry_run);
      if (live.length === 0) {
        await bot.telegram.sendMessage(OWNER_ID, `🦅 *${BRAND} online* — no open positions.`, { parse_mode: 'Markdown' });
        return;
      }
      const lines = live.map(p => `• ${p.origin === 'manual' ? '✋' : '🤖'} \`${p.ca.slice(0, 8)}…\``);
      await bot.telegram.sendMessage(OWNER_ID,
        `🦅 *${BRAND} online* — ${live.length} open position${live.length === 1 ? '' : 's'} being managed:\n\n${lines.join('\n')}\n\nTap /positions to open the live cards.`,
        { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } } as any);
      logOk(`[auto-resume] sent boot summary — ${live.length} open position(s)`);
    } catch (e: any) {
      logWarn(`[auto-resume] failed to send boot summary: ${errText(e)}`);
    }
  })();

  // Boot warnings that must reach the owner, sent ONCE after launch. Plain text: no Markdown to break.
  void (async () => {
    await new Promise(r => setTimeout(r, 4000));
    for (const m of bootWarnings) await notify(m, { parse_mode: undefined });
    // A-115 (spec 7.4): the one-time summary of imported settings (or the /importsettings hint); sentAt is persisted only after a send
    try {
      const text = noticeToSend(loadSettings().signal);
      if (text) {
        await bot.telegram.sendMessage(OWNER_ID, text, { link_preview_options: { is_disabled: true } });
        const s = loadSettings();
        s.signal = markNoticeSent(s.signal, Date.now());
        saveSettings(s);
      }
    } catch (e: any) { logWarn(`[settings] the import summary could not be sent: ${errText(e)}`); }
  })();

  // Shutdown: the Engine outbox is flushed first (flushNow, then stop), then Telegram polling stops.
  const shutdown = (sig: 'SIGINT' | 'SIGTERM') => {
    shuttingDown = true;
    polling.stop();
    void (async () => {
      try { await Promise.race([app.stop(), new Promise(r => setTimeout(r, 8000))]); } catch { /* going down anyway */ }
      try { bot.stop(sig); } catch { /* not launched */ }
    })();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((e: any) => {
    logErr(`[boot] failed: ${errText(e)}`);
    process.exit(1);
  });
}
