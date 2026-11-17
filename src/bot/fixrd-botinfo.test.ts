/**
 * A-113b FIXRD-T02: the composed bot hands Telegraf's botInfo to boot(). app.ts reads the heartbeat's bot_username only through
 * `deps.botInfo` (A-110, R8-RDB1), so a boot() call without it reports null forever: the Engine's /health.delivery.bot.username stays
 * `not-reported` and every TokenCard shows "TG Buy: bot offline". RDB-T01 injects botInfo itself, so only the composition can catch it.
 * A static scan of bot.ts (the bot is never started in a test).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BOT_TS = fs.readFileSync(path.join(__dirname, 'bot.ts'), 'utf8');

/** The source text of the object literal passed to the first `await boot(` call, braces balanced. */
function bootArgument(src: string): string | null {
  const at = src.indexOf('await boot(');
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

describe('A-113b bot.ts composition', () => {
  it('FIXRD-T02 the boot() call of bot.ts passes botInfo as a lazy getter of the Telegraf instance, so the heartbeat can carry bot_username', () => {
    expect(BOT_TS.split('await boot(').length - 1, 'bot.ts boots the app exactly once').toBe(1);
    const arg = bootArgument(BOT_TS);
    expect(arg, 'the boot() call takes an object literal').not.toBeNull();
    // a getter, read at every heartbeat: Telegraf fills bot.botInfo only after launch() has fetched getMe
    expect(arg ?? '').toMatch(/\bbotInfo\s*:\s*\(\)\s*=>\s*bot\.botInfo\b/);
    // `bot` there is the Telegraf client created before boot()
    const created = BOT_TS.indexOf('bot = new Telegraf(');
    expect(created, 'bot.ts creates the Telegraf client').toBeGreaterThan(-1);
    expect(created).toBeLessThan(BOT_TS.indexOf('await boot('));
  });
});
