/**
 * REBATE SETTINGS — runtime-readable Helius backrun rebate configuration.
 *
 * 2026-05-16 — Lives in its own module so jupiter.ts (the send path) can read
 * the current rebate config without circular-importing bot.ts. We can't reuse
 * bot.ts's loadSettings() helper because that pulls in the entire Telegram
 * stack; we just need a tiny file reader.
 *
 * Source of truth: `settings.json` in the bot data folder (botDataDir(): BOT_DATA_DIR, default
 * `<cwd>/data`, the folder bot.ts writes it to) → `rebates: { enabled, address }`.
 *
 * Hot-path safety: cached by mtime so the read is effectively free on every
 * `sendTransaction` call. Only re-parses the JSON when the file changes on
 * disk (i.e., when the user toggles via TG and saveSettings() rewrites the
 * file). Bumped to a 200ms stat-cache to bound fs.statSync overhead under
 * burst sends.
 *
 * Env-var fallback: if settings.json has no `rebates` section, we honour the
 * legacy `CONFIG.ENABLE_BACKRUN_REBATES` + `CONFIG.HELIUS_MARKETING_WALLET`
 * for back-compat with deployments that wired this through .env before the
 * TG UX existed. TG always wins once the user saves.
 */
import * as fs from 'fs';
import * as path from 'path';
import { botDataDir } from '../config';

export interface RebatesConfig {
  enabled: boolean;
  address: string;
}

/**
 * Tri-state disk read result:
 *  - hasSection=true  → user has touched the /rebates menu at least once,
 *                       and the saved values are authoritative (TG wins).
 *                       Toggle-OFF MUST be respected.
 *  - hasSection=false → first-boot, settings.json has no `rebates` key yet.
 *                       Env fallback applies (back-compat for legacy
 *                       .env-based deployments only).
 */
interface DiskRead {
  cfg: RebatesConfig;
  hasSection: boolean;
  mtimeMs: number;
}

// PUB-2: the same file bot.ts saves the /rebates menu into (its DATA_DIR = botDataDir(), taken at import like here), so a
// BOT_DATA_DIR outside <cwd>/data no longer leaves the send path on the env fallback.
const SETTINGS_PATH = path.join(botDataDir(), 'settings.json');
const STAT_CACHE_MS = 200;   // bound fs.statSync rate under burst sends

interface InternalCache {
  read: DiskRead;
  statTs:  number;
}

let _cache: InternalCache | null = null;

function readRebatesFromDisk(): DiskRead | null {
  try {
    const stat = fs.statSync(SETTINGS_PATH);
    const raw  = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const j    = JSON.parse(raw);
    const r    = j?.rebates;
    if (r && typeof r === 'object') {
      return {
        cfg: {
          enabled: !!r.enabled,
          address: typeof r.address === 'string' ? r.address.trim() : '',
        },
        hasSection: true,
        mtimeMs: stat.mtimeMs,
      };
    }
    // settings.json exists but has no `rebates` section → not authoritative,
    // fall back to env defaults at the resolve step.
    return {
      cfg: { enabled: false, address: '' },
      hasSection: false,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

/**
 * Read current rebate config. ~free on hot path (mtime-cached).
 * Returns ONLY what's on disk. To get the effective config with env
 * fallback, use `resolveEffectiveRebates()`.
 */
export function getRebatesConfig(): RebatesConfig {
  return _readWithCache().cfg;
}

/** Returns true iff `settings.json` (in the bot data folder) contains a `rebates` object. */
export function hasRebatesSection(): boolean {
  return _readWithCache().hasSection;
}

function _readWithCache(): DiskRead {
  const now = Date.now();
  if (_cache && (now - _cache.statTs) < STAT_CACHE_MS) {
    return _cache.read;
  }
  let mtimeMs = 0;
  try {
    const stat = fs.statSync(SETTINGS_PATH);
    mtimeMs = stat.mtimeMs;
  } catch {
    // file missing → fall through; we'll return env-fallback
  }
  // If file unchanged since last successful read, just refresh the stat-cache
  if (_cache && mtimeMs && mtimeMs === _cache.read.mtimeMs) {
    _cache.statTs = now;
    return _cache.read;
  }
  // File changed (or first read) → re-parse
  const fresh = readRebatesFromDisk();
  const read: DiskRead = fresh ?? {
    cfg: { enabled: false, address: '' },
    hasSection: false,
    mtimeMs: 0,
  };
  _cache = { read, statTs: now };
  return read;
}

/**
 * Invalidate the in-memory cache. Call this after writing settings.json
 * elsewhere if you need an immediate re-read (mtime-based invalidation also
 * works but adds up to STAT_CACHE_MS latency).
 */
export function invalidateRebatesCache(): void {
  _cache = null;
}

/**
 * Merge env defaults under the disk config.
 *
 * 2026-05-16 FIX (audit catch): TG settings are AUTHORITATIVE the moment the
 * user touches the /rebates menu — toggle OFF must mean OFF even if the env
 * defaults say ON. We only fall back to env when settings.json has NO
 * `rebates` section at all (true first-boot / back-compat with legacy
 * env-only deployments).
 */
export function resolveEffectiveRebates(
  envEnabled: boolean, envAddress: string,
): RebatesConfig {
  const read = _readWithCache();
  if (read.hasSection) {
    // Disk config is authoritative. enabled requires both flag + address.
    return {
      enabled: !!read.cfg.enabled && !!read.cfg.address,
      address: read.cfg.address,
    };
  }
  // First-boot — no TG interaction yet. Env back-compat: only honor when
  // BOTH env flag is set AND env wallet is non-empty.
  return {
    enabled: !!envEnabled && !!envAddress,
    address: envAddress || '',
  };
}
