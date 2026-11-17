/**
 * PUB-2 (public release): the send path reads the /rebates setting from the folder the bot writes it to. bot.ts saves settings.json
 * into botDataDir() (BOT_DATA_DIR, default <cwd>/data); rebate-settings.ts must read that same file, or a /rebates choice made with
 * BOT_DATA_DIR set never reaches the send. The module takes its path at import, like bot.ts, so each case imports it fresh.
 * Wallets are made at run time.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

type RebateSettings = typeof import('./rebate-settings');

const made: string[] = [];
const cwdData = (): string => path.join(process.cwd(), 'data');
const wallet = (): string => Keypair.generate().publicKey.toBase58();

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-rebates-'));
  made.push(d);
  return d;
}
function writeSettings(dir: string, doc: object): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(doc));
}
async function freshModule(): Promise<RebateSettings> {
  vi.resetModules();
  return import('./rebate-settings');
}

afterEach(() => {
  delete process.env.BOT_DATA_DIR;
  for (const d of [...made.splice(0), cwdData()]) fs.rmSync(d, { recursive: true, force: true });
});

describe('PUB-2 the rebate setting is read from the bot data folder', () => {
  it('with BOT_DATA_DIR set, the /rebates section saved there is the one the send path sees; a settings.json in <cwd>/data is not read', async () => {
    const own = wallet();
    const other = wallet();
    const dataDir = tempDir();
    process.env.BOT_DATA_DIR = dataDir;
    writeSettings(dataDir, { schema: 2, rebates: { enabled: true, address: own } });
    writeSettings(cwdData(), { schema: 2, rebates: { enabled: true, address: other } });
    const reb = await freshModule();
    expect(reb.hasRebatesSection()).toBe(true);
    expect(reb.getRebatesConfig()).toEqual({ enabled: true, address: own });
    expect(reb.resolveEffectiveRebates(true, '')).toEqual({ enabled: true, address: own });

    // turned OFF in Telegram: OFF wins over a wallet in the env
    writeSettings(dataDir, { schema: 2, rebates: { enabled: false, address: own } });
    reb.invalidateRebatesCache();
    expect(reb.resolveEffectiveRebates(true, other)).toEqual({ enabled: false, address: own });
  });

  it('with BOT_DATA_DIR set but no settings.json there, the env pair applies (a settings.json in <cwd>/data still is not read)', async () => {
    const other = wallet();
    process.env.BOT_DATA_DIR = tempDir();
    writeSettings(cwdData(), { schema: 2, rebates: { enabled: false, address: other } });
    const reb = await freshModule();
    expect(reb.hasRebatesSection()).toBe(false);
    expect(reb.resolveEffectiveRebates(true, '')).toEqual({ enabled: false, address: '' });
    const own = wallet();
    expect(reb.resolveEffectiveRebates(true, own)).toEqual({ enabled: true, address: own });
  });

  it('without BOT_DATA_DIR the folder is <cwd>/data, as for the bot', async () => {
    const own = wallet();
    const reb = await freshModule();
    expect(reb.hasRebatesSection()).toBe(false);
    writeSettings(cwdData(), { schema: 2, rebates: { enabled: true, address: own } });
    reb.invalidateRebatesCache();
    expect(reb.hasRebatesSection()).toBe(true);
    expect(reb.resolveEffectiveRebates(true, '')).toEqual({ enabled: true, address: own });
  });
});
