/**
 * Final bot guards (C00 section 1; ledger: R0-TOOL skeleton -> R4-B6 -> R7-W2, B6-T02).
 * G-S13, G-S1, G-S17 and G-S19 over the bot tree with an EMPTY exemption map. R4-B6 scrubbed or deleted every legacy file of
 * src/guards/legacy-allowlist.ts, so the block runs (it was skipped until round 4) and must stay green.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOT_GUARD_IDS, GUARD_RULES, ScanContext, formatViolations, runAllGuards, runGuard, violationsOfRule } from './guard-lib';

const BOT_ROOT = path.resolve(__dirname, '..', '..');
const NO_EXEMPTIONS = {} as const;

describe('final bot guards: every guard with an EMPTY exemption map', () => {
  const ctx = new ScanContext(BOT_ROOT);
  for (const id of BOT_GUARD_IDS) {
    for (const rule of GUARD_RULES[id]) {
      it(`${id} ${rule.title} (empty map)`, () => {
        const res = runGuard(id, { root: BOT_ROOT, exemptions: NO_EXEMPTIONS, ctx });
        const found = violationsOfRule(res, rule.id);
        expect(found, formatViolations(found)).toEqual([]);
      });
    }
  }

  it('B6-T02 the final bot guard passes with no exemptions: all four guards, every rule, the whole bot tree (G-S19 scans a file only once src/wallet-link exists)', () => {
    const all = runAllGuards({ root: BOT_ROOT, exemptions: NO_EXEMPTIONS, ctx });
    const violations = BOT_GUARD_IDS.flatMap(id => all[id].violations);
    expect(violations, formatViolations(violations)).toEqual([]);
    // the scan really looked at the tree (a guard that scanned nothing would pass for the wrong reason)
    // A-100: G-S19 starts at src/wallet-link/**, so its assertion applies exactly when that folder exists (R7-W6's gate turns it live);
    // without the folder it has no entry file and scans nothing (WGD-T10)
    const walletLinkExists = fs.existsSync(path.join(BOT_ROOT, 'src', 'wallet-link'));
    for (const id of BOT_GUARD_IDS) {
      if (id === 'G-S19') continue;
      expect(all[id].scanned, `${id} scanned no file`).toBeGreaterThan(0);
    }
    if (walletLinkExists) expect(all['G-S19'].scanned, 'G-S19 scanned no file although src/wallet-link exists').toBeGreaterThan(0);
    else expect(all['G-S19'].scanned, 'G-S19 scanned a file although src/wallet-link does not exist').toBe(0);
  });
});
