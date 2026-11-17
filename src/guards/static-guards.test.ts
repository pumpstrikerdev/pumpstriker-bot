/**
 * Bot static guards (C00 section 5, last paragraph): G-S13 and G-S1 over `B\src`, G-S17 over the bot tests and (A-100, round 7)
 * G-S19 over the import closure of `src/wallet-link/**`, with the per-guard exemption map of legacy-allowlist.ts. The
 * planted-tree cases of the guard acceptance test that name bot paths run from the Engine's static-guards.test.ts (one test id, both
 * packages); the cases below keep this package's guard library honest on its own, and hold the G-S19 tests WGD-T06, T07 and T10 (round 7).
 * Scans resolve the bot root through __dirname, never through process.cwd().
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BOT_GUARD_IDS,
  GUARD_RULES,
  G_S19_DATA_TABLE_FILES,
  ScanContext,
  closureChain,
  extractImports,
  formatViolations,
  importClosure,
  isExecutionHost,
  isWalletStoreImport,
  resolveModuleFile,
  runGuard,
  violationsOfRule,
  type BotGuardId,
  type GuardResult,
} from './guard-lib';
import { LEGACY_EXEMPTIONS } from './legacy-allowlist';

const BOT_ROOT = path.resolve(__dirname, '..', '..');

const GUARD_TITLES: Readonly<Record<BotGuardId, string>> = {
  'G-S1': 'GMGN containment (bot)',
  'G-S13': 'No non-execution data source in the bot',
  'G-S17': 'Test port and env isolation (bot)',
  'G-S19': 'Unsigned-builder isolation (bot)',
};

const ctx = new ScanContext(BOT_ROOT);
const results = new Map<BotGuardId, GuardResult>();
function realResult(id: BotGuardId): GuardResult {
  let res = results.get(id);
  if (!res) {
    res = runGuard(id, { root: BOT_ROOT, exemptions: LEGACY_EXEMPTIONS, ctx });
    results.set(id, res);
  }
  return res;
}

for (const id of BOT_GUARD_IDS) {
  describe(`${id} ${GUARD_TITLES[id]}`, () => {
    for (const rule of GUARD_RULES[id]) {
      it(rule.title, () => {
        const found = violationsOfRule(realResult(id), rule.id);
        expect(found, formatViolations(found)).toEqual([]);
      });
    }
  });
}

describe('the bot exemption map', () => {
  it('names only guards of the bot library (an entry whose file is already gone is stale but harmless: later packages delete files without editing this map)', () => {
    for (const [glob, guards] of Object.entries(LEGACY_EXEMPTIONS)) {
      expect(glob.startsWith('src/'), `${glob} must be relative to the bot root`).toBe(true);
      for (const g of guards) expect((BOT_GUARD_IDS as readonly string[]).includes(g)).toBe(true);
    }
  });
});

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function plant(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-botguard-'));
  tempDirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

describe('planted bot trees', () => {
  const run = (id: BotGuardId, files: Record<string, string>, ex: Record<string, readonly string[]> = {}): GuardResult =>
    runGuard(id, { root: plant(files), exemptions: ex });

  it('fails on a Jupiter price endpoint behind a host constant, on api.jup.ag/price/v3, on a constant SOL price', () => {
    expect(run('G-S13', { 'src/exits/x.ts': "const HOST = 'https://lite-api.jup.ag';\nconst u = `${HOST}/price/v3?ids=${m}`;\n" }).violations.length).toBeGreaterThan(0);
    expect(run('G-S13', { 'src/bot/x.ts': "const u = 'https://api.jup.ag/price/v3';\n" }).violations.length).toBeGreaterThan(0);
    expect(run('G-S13', { 'src/bot/x.ts': 'const p = solUsd || 200;\n' }).violations.length).toBeGreaterThan(0);
  });

  it('passes the jup.ag swap display link, host literals in src/config.ts and src/execution, and the public gmgn.ai token link', () => {
    const res = run('G-S13', {
      'src/bot/bot.ts': 'const a = `https://jup.ag/swap/${ca}-SOL`;\nconst b = `https://gmgn.ai/sol/token/${ca}`;\n',
      'src/config.ts': "export const J = 'https://api.jup.ag/swap/v1';\n",
      'src/execution/x.ts': "const q = 'https://lite-api.jup.ag/swap/v1/quote';\n",
    });
    expect(res.violations, formatViolations(res.violations)).toEqual([]);
  });

  it('an exemption skips a file only for the guards listed for it', () => {
    const files = { 'src/bot/x.ts': "const u = 'https://openapi.gmgn.ai/x';\n" };
    expect(run('G-S1', files, { 'src/bot/x.ts': ['G-S1'] }).violations).toEqual([]);
    expect(run('G-S13', files, { 'src/bot/x.ts': ['G-S1'] }).violations.length).toBeGreaterThan(0);
  });

  it('isExecutionHost covers the hosts and their subdomains', () => {
    for (const h of ['jup.ag', 'api.jup.ag', 'lite-api.jup.ag', 'pumpportal.fun', 'pump.fun', 'frontend-api-v3.pump.fun']) expect(isExecutionHost(h)).toBe(true);
    for (const h of ['gmgn.ai', 'solscan.io', 'api.telegram.org', 'notpump.fun.example.com']) expect(isExecutionHost(h)).toBe(false);
  });

  it('G-S17: the literals 1002/3748 and a spawn without env fail outside config.test.ts', () => {
    expect(run('G-S17', { 'src/bot/x.test.ts': 'const p = 3748;\n' }).violations.length).toBeGreaterThan(0);
    expect(run('G-S17', { 'src/bot/x.test.ts': "spawn('node', ['a']);\n" }).violations.length).toBeGreaterThan(0);
    expect(run('G-S17', { 'src/config.test.ts': 'expect(c.port).toBe(3748);\n' }).violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Round 7 (A-100, C00 section 11, WALLET-DASHBOARD-DESIGN section 15 item 7 and rev 3 R3-5 g): G-S19 over the import closure of
// src/wallet-link/**. Every tree is planted under os.tmpdir() and scanned with an EMPTY exemption map, as the final guards are.
// Import statements are assembled at run time (the DEMO-T05 pattern of the Engine's static-guards.test.ts): no relative specifier
// appears literally in this file.
// ---------------------------------------------------------------------------------------------------------------

const KW_IMPORT = ['im', 'port'].join('');
const KW_EXPORT = ['ex', 'port'].join('');
const KW_FROM = ['fr', 'om'].join('');
const imp = (what: string, spec: string): string => `${KW_IMPORT} ${what} ${KW_FROM} '${spec}';\n`;
const side = (spec: string): string => `${KW_IMPORT} '${spec}';\n`;
const reexport = (what: string, spec: string): string => `${KW_EXPORT} ${what} ${KW_FROM} '${spec}';\n`;
const dyn = (spec: string): string => `${KW_IMPORT}('${spec}')`;

/** Plant `files` once; the runner applies G-S19 (empty exemption map) to that tree, optionally from explicit entry files. */
function g19(files: Record<string, string>): (entries?: readonly string[]) => GuardResult {
  const root = plant(files);
  const planted = new ScanContext(root);
  return (entries) => runGuard('G-S19', { root, exemptions: {}, ctx: planted, ...(entries ? { entries } : {}) });
}

/** The distinct files that carry at least one violation (of `rule` when given), sorted. */
const failingFiles = (res: GuardResult, rule?: string): string[] =>
  [...new Set((rule ? violationsOfRule(res, rule) : res.violations).map((x) => x.file))].sort();

const SIGNS = 'export const sig = (tx: Tx, kp: Kp) => tx.sign([kp]);\n';

describe('G-S19 unsigned-builder isolation over the wallet-link import closure (A-100)', () => {
  it('WGD-T06 a planted .sign(, wallet-store import or multiRpcSend in a covered file fails; a covered file that imports jupiter.ts (or any file that signs) fails through the import closure (rev 3 edge rule: a dynamic import and exec-common.ts included; an import type of router.ts passes)', () => {
    // direct violations in the covered folder itself
    const direct = g19({
      'src/wallet-link/sign.ts': SIGNS,
      'src/wallet-link/detached.ts': 'export const s = (m: M, k: K) => nacl.sign.detached(m, k);\n',
      'src/wallet-link/partial.ts': 'export const s = (t: T, k: K) => t.partialSign(k);\n',
      'src/wallet-link/store.ts': imp('{ w }', '../data/wallets') + 'export const x = w;\n',
      'src/wallet-link/vault.ts': imp('{ d }', '../bot/wallet-crypto') + 'export const x = d;\n',
      'src/wallet-link/sibling.ts': imp('{ d }', './wallets-store') + 'export const x = d;\n',
      'src/wallet-link/data-index.ts': imp('{ d }', '../data') + 'export const x = d;\n',
      'src/wallet-link/send.ts': 'export const x = multiRpcSend(tx);\n',
      'src/wallet-link/clean.ts': 'export const ok = (n: number) => n + 1;\n',
    })();
    expect(failingFiles(direct, 'signing')).toEqual(['src/wallet-link/detached.ts', 'src/wallet-link/partial.ts', 'src/wallet-link/sign.ts']);
    expect(failingFiles(direct, 'wallet-store-import')).toEqual(['src/wallet-link/data-index.ts', 'src/wallet-link/sibling.ts', 'src/wallet-link/store.ts', 'src/wallet-link/vault.ts']);
    expect(failingFiles(direct, 'send-and-tip')).toEqual(['src/wallet-link/send.ts']);
    expect(direct.violations.every((x) => x.guard === 'G-S19' && x.via === undefined)).toBe(true); // entry files carry no chain
    expect(direct.scanned).toBe(9);
    // only the matched text is reported, never the line
    expect(direct.violations.find((x) => x.file === 'src/wallet-link/send.ts')?.match).toBe('multiRpcSend');

    // a covered file importing jupiter.ts: the signing and the wallet-store import are reached through the closure
    const jupiter = [SIGNS, imp('{ rebate }', '../data/rebate-settings'), 'export const j = rebate;\n'].join('');
    const through = g19({
      'src/wallet-link/routes.ts': imp('{ j }', '../execution/jupiter') + 'export const r = j;\n',
      'src/execution/jupiter.ts': jupiter,
    })();
    expect(failingFiles(through, 'signing')).toEqual(['src/execution/jupiter.ts']);
    expect(failingFiles(through, 'wallet-store-import')).toEqual(['src/execution/jupiter.ts']);
    expect(through.violations.every((x) => x.via === 'src/wallet-link/routes.ts > src/execution/jupiter.ts')).toBe(true);
    expect(formatViolations(through.violations)).toContain('(via src/wallet-link/routes.ts > src/execution/jupiter.ts)');
    expect(through.scanned).toBe(2);

    // any file that signs, however deep the chain (several hops, an index.ts, a .js specifier, a re-export)
    const deep = g19({
      'src/wallet-link/a.ts': imp('{ b }', '../lib') + 'export const a = b;\n',
      'src/lib/index.ts': imp('{ c }', './mid.js') + reexport('*', './side') + 'export const b = c;\n',
      'src/lib/mid.ts': imp('{ d }', '../execution/deep/leaf') + 'export const c = d;\n',
      'src/lib/side.ts': 'export const s = 1;\n',
      'src/execution/deep/leaf.ts': SIGNS,
      'src/execution/unrelated.ts': SIGNS, // nobody covered imports it: out of the closure, so not reported
    })();
    expect(failingFiles(deep)).toEqual(['src/execution/deep/leaf.ts']);
    expect(deep.violations[0].via).toBe('src/wallet-link/a.ts > src/lib/index.ts > src/lib/mid.ts > src/execution/deep/leaf.ts');
    expect(deep.scanned).toBe(5);

    // the rev 3 edge rule (R3-5 g): a dynamic import of jupiter.ts and a static import of exec-common.ts each fail through the closure;
    // an `import type` of router.ts passes
    // the fact at 525ce81: exec-common.ts awaits a dynamic import of ./jupiter, and jupiter.ts imports data/rebate-settings.ts
    const execCommon = [
      'export async function defaultExecRpc() {\n',
      `  const { resilientRpcCall } = await ${dyn('./jupiter')};\n`,
      '  return resilientRpcCall;\n',
      '}\n',
    ].join('');
    const jupiterRpc = [imp('{ settings }', '../data/rebate-settings'), 'export const resilientRpcCall = settings;\n'].join('');
    const world = {
      'src/execution/exec-common.ts': execCommon,
      'src/execution/jupiter.ts': jupiterRpc,
      'src/execution/router.ts': SIGNS + imp('{ resilientRpcCall }', './jupiter') + 'export type Route = { id: string };\nexport const route = resilientRpcCall;\n',
    };
    // 1. a covered file with a literal dynamic import of ./jupiter
    const dynamic = g19({ ...world, 'src/wallet-link/lazy.ts': `export const load = () => ${dyn('../execution/jupiter')};\n` })();
    expect(failingFiles(dynamic, 'wallet-store-import')).toEqual(['src/execution/jupiter.ts']);
    expect(dynamic.violations[0].via).toBe('src/wallet-link/lazy.ts > src/execution/jupiter.ts');
    // 2. a covered file with a static import of exec-common.ts reaches jupiter.ts through exec-common's dynamic edge
    const viaExec = g19({ ...world, 'src/wallet-link/rpc.ts': imp('{ defaultExecRpc }', '../execution/exec-common') + 'export const rpc = defaultExecRpc;\n' })();
    expect(failingFiles(viaExec, 'wallet-store-import')).toEqual(['src/execution/jupiter.ts']);
    expect(viaExec.violations[0].via).toBe('src/wallet-link/rpc.ts > src/execution/exec-common.ts > src/execution/jupiter.ts');
    expect(viaExec.scanned).toBe(3);
    // 3. an `import type` of router.ts (which signs and reaches jupiter.ts) is erased at compile time: no edge, no violation
    for (const typeImport of [
      imp('type { Route }', '../execution/router'),
      imp('{ type Route }', '../execution/router'),
      imp('{ type Route, type Other }', '../execution/router'),
      reexport('type { Route }', '../execution/router'),
    ]) {
      const typed = g19({ ...world, 'src/wallet-link/types.ts': typeImport + 'export type R = Route;\n' })();
      expect(typed.violations, formatViolations(typed.violations)).toEqual([]);
      expect(typed.scanned).toBe(1);
    }
    // ... while a value import of router.ts, or a mixed clause, is an edge
    for (const valueImport of [
      imp('{ route }', '../execution/router'),
      imp('{ type Route, route }', '../execution/router'),
      imp('Router', '../execution/router'),
      imp('* as r', '../execution/router'),
      side('../execution/router'),
    ]) {
      const valued = g19({ ...world, 'src/wallet-link/value.ts': valueImport })();
      expect(failingFiles(valued, 'signing'), valueImport).toEqual(['src/execution/router.ts']);
    }
    // 4. test files are not entry files, and a specifier that names no file is no edge
    const tests = g19({
      ...world,
      'src/wallet-link/routes.test.ts': imp('{ resilientRpcCall }', '../execution/jupiter') + 'void resilientRpcCall;\n',
      'src/wallet-link/ok.ts': imp('{ x }', './missing') + 'export const y = x;\n',
    })();
    expect(tests.violations).toEqual([]);
    expect(tests.scanned).toBe(1);
  });

  it('G-S19 Keypair: a type-only import is allowed, every value use fails', () => {
    const run = g19({
      'src/wallet-link/value.ts': imp('{ Keypair }', '@solana/web3.js') + 'export const k = Keypair.generate();\n',
      'src/wallet-link/fresh.ts': 'export const k = new Keypair();\n',
      'src/wallet-link/annotated.ts': imp('{ Keypair }', '@solana/web3.js') + 'export const f = (k: Keypair) => k;\n', // a value import is a value import
      'src/wallet-link/type-import.ts': imp('type { Keypair }', '@solana/web3.js') + 'export type K = Keypair;\nexport const f = (k: Keypair): void => void k;\n',
      'src/wallet-link/inline-type.ts': imp('{ type Keypair, type PublicKey }', '@solana/web3.js') + 'export const f = (k: Keypair, p: PublicKey): void => void [k, p];\n',
      'src/wallet-link/aliased.ts': imp('type { Keypair as Kp }', '@solana/web3.js') + 'export type K = Kp;\n',
      'src/wallet-link/near.ts': 'export const a = KeypairLike;\nexport const b = fixtureKeypair;\n// a Keypair named in a comment signs nothing\n',
    })();
    expect(failingFiles(run, 'signing')).toEqual(['src/wallet-link/annotated.ts', 'src/wallet-link/fresh.ts', 'src/wallet-link/value.ts']);
  });

  it('WGD-T07 a planted rebate-address, HELIUS_TIP, heliusSmartSend, sendRawTransaction, sendTransaction, /order or /execute fails in a covered file and in its closure', () => {
    const bodies: Record<string, string> = {
      'rebate.ts': "export const q = '?rebate-address=' + a;\n",
      'rebate-camel.ts': 'export const q = { rebateAddress: a };\n',
      'tip.ts': 'export const t = HELIUS_TIP;\n',
      'tip-table.ts': 'export const t = CONFIG.HELIUS_TIP_ACCOUNTS;\n',
      'smart.ts': 'export const s = heliusSmartSend;\n',
      'raw.ts': 'export const s = (c: C, b: B) => c.sendRawTransaction(b);\n',
      'send.ts': 'export const s = (c: C, t: T) => c.sendTransaction(t);\n',
      'multi.ts': 'export const s = multiRpcSend;\n',
      'order.ts': "export const u = base + '/order';\n",
      'order-ultra.ts': "export const u = 'https://lite-api.jup.ag/ultra/v1/order';\n",
      'execute.ts': 'export const u = `${base}/swap/v2/execute`;\n',
    };
    const files: Record<string, string> = {};
    for (const [name, body] of Object.entries(bodies)) files[`src/wallet-link/${name}`] = body;
    const direct = g19(files)();
    expect(failingFiles(direct, 'send-and-tip')).toEqual(
      ['multi', 'raw', 'rebate-camel', 'rebate', 'send', 'smart', 'tip-table', 'tip'].map((n) => `src/wallet-link/${n}.ts`).sort(),
    );
    expect(failingFiles(direct, 'order-execute-path')).toEqual(['src/wallet-link/execute.ts', 'src/wallet-link/order-ultra.ts', 'src/wallet-link/order.ts']);
    // the same capabilities reached through one import fail in the file that holds them
    const through = g19({
      'src/wallet-link/routes.ts': imp('{ t }', '../lib/tipper') + 'export const r = t;\n',
      'src/lib/tipper.ts': 'export const t = HELIUS_TIP;\nexport const u = base + "/order";\n',
    })();
    expect(failingFiles(through, 'send-and-tip')).toEqual(['src/lib/tipper.ts']);
    expect(failingFiles(through, 'order-execute-path')).toEqual(['src/lib/tipper.ts']);
    // look-alikes are not those capabilities: another word, a longer path segment, a division, whole-line comments
    const near = g19({
      'src/wallet-link/near.ts': [
        '// never calls heliusSmartSend, multiRpcSend, sendRawTransaction, sendTransaction, HELIUS_TIP, rebate-address, /order or /execute',
        ' * a block comment: /order /execute .sign( Keypair',
        'export const a = orders + executed;',
        "export const b = '/orders' + '/executor';",
        'export const c = total / ordersCount;',
        'export const d = signature.verify(m);',
        'export const e = crypto.verify(null, m, k, s);',
        '',
      ].join('\n'),
    })();
    expect(near.violations, formatViolations(near.violations)).toEqual([]);
  });

  it('G-S19 config.ts is the constants table: it may DEFINE the order/execute URL templates and the tip table, but signs nothing and imports no wallet store; the same text anywhere else fails', () => {
    expect(G_S19_DATA_TABLE_FILES).toEqual(['src/config.ts']);
    // the shape of the real src/config.ts: Jupiter endpoint templates and a tip-account table (jupiter-ix.ts reads CONFIG from it)
    const config = [
      'export const jupUrls = (a: string) => ({',
      '  order: `${a}/swap/v2/order`,',
      '  execute: `${a}/swap/v2/execute`,',
      '});',
      'const HELIUS_TIP_ACCOUNTS: string[] = [];',
      'export const CONFIG = { HELIUS_TIP_ACCOUNTS, JUPITER_API_KEY: key };',
      '',
    ].join('\n');
    const reached = g19({
      'src/wallet-link/quote.ts': imp('{ CONFIG }', '../config') + 'export const k = CONFIG.JUPITER_API_KEY;\n',
      'src/config.ts': config,
    })();
    expect(reached.violations, formatViolations(reached.violations)).toEqual([]);
    expect(reached.scanned).toBe(2);
    // a wallet file that USES the names is caught in that file, not in config.ts
    const uses = g19({
      'src/wallet-link/quote.ts': imp('{ CONFIG }', '../config') + 'export const t = CONFIG.HELIUS_TIP_ACCOUNTS;\nexport const u = `${base}/order`;\n',
      'src/config.ts': config,
    })();
    expect(failingFiles(uses, 'send-and-tip')).toEqual(['src/wallet-link/quote.ts']);
    expect(failingFiles(uses, 'order-execute-path')).toEqual(['src/wallet-link/quote.ts']);
    // the table is exempt from those two rules only
    const signs = g19({
      'src/wallet-link/quote.ts': imp('{ CONFIG }', '../config') + 'export const k = CONFIG;\n',
      'src/config.ts': config + SIGNS + imp('{ w }', './data/wallets'),
    })();
    expect(failingFiles(signs, 'signing')).toEqual(['src/config.ts']);
    expect(failingFiles(signs, 'wallet-store-import')).toEqual(['src/config.ts']);
    expect(failingFiles(signs, 'send-and-tip')).toEqual([]);
    // and only that exact path: the same table elsewhere is not exempt
    const elsewhere = g19({
      'src/wallet-link/quote.ts': imp('{ CONFIG }', '../lib/config') + 'export const k = CONFIG;\n',
      'src/lib/config.ts': config,
    })();
    expect(failingFiles(elsewhere, 'send-and-tip')).toEqual(['src/lib/config.ts']);
    expect(failingFiles(elsewhere, 'order-execute-path')).toEqual(['src/lib/config.ts']);
  });

  it('WGD-T10 without a src/wallet-link folder G-S19 scans 0 files and passes, however much signing code the rest of the tree holds; the final guard asserts scanned > 0 exactly when the folder exists', () => {
    const noFolder = g19({
      'src/execution/jupiter.ts': SIGNS + 'export const m = multiRpcSend;\n',
      'src/execution/router.ts': imp('{ sig }', './jupiter') + 'export const r = sig;\n',
      'src/bot/x.ts': imp('{ w }', '../data/wallets') + 'export const x = w;\n',
    })();
    expect(noFolder.scanned).toBe(0);
    expect(noFolder.violations).toEqual([]);
    expect(g19({})().scanned).toBe(0);
    // the folder with a clean file: scanned counts the entry files and everything they reach; tests are not entries
    const withFolder = g19({
      'src/wallet-link/a.ts': imp('{ b }', '../lib/b') + 'export const a = b;\n',
      'src/lib/b.ts': 'export const b = 1;\n',
      'src/wallet-link/a.test.ts': 'void 0;\n',
    })();
    expect(withFolder.scanned).toBe(2);
    expect(withFolder.violations).toEqual([]);
    // a folder holding only tests has no entry file
    expect(g19({ 'src/wallet-link/a.test.ts': SIGNS })().scanned).toBe(0);
    // the real tree: the assertion that B6-T02 makes, with the same condition
    const real = runGuard('G-S19', { root: BOT_ROOT, exemptions: {}, ctx });
    expect(real.violations, formatViolations(real.violations)).toEqual([]);
    if (fs.existsSync(path.join(BOT_ROOT, 'src', 'wallet-link'))) expect(real.scanned).toBeGreaterThan(0);
    else expect(real.scanned).toBe(0);
  });

  it('entries: explicit entry files give the closure of those files (a package proves its own modules clean before src/wallet-link exists); missing entries are ignored; the exemption map is still honoured', () => {
    const run = g19({
      'src/execution/unsigned-swap.ts': imp('{ ix }', './pure-ix') + 'export const u = ix;\n',
      'src/execution/pure-ix.ts': 'export const ix = 1;\n',
      'src/execution/dirty-swap.ts': imp('{ sig }', './jupiter') + 'export const u = sig;\n',
      'src/execution/jupiter.ts': SIGNS,
    });
    const clean = run(['src/execution/unsigned-swap.ts']);
    expect(clean.violations).toEqual([]);
    expect(clean.scanned).toBe(2);
    const dirty = run(['src/execution/dirty-swap.ts', 'src/execution/does-not-exist.ts']);
    expect(failingFiles(dirty, 'signing')).toEqual(['src/execution/jupiter.ts']);
    expect(dirty.scanned).toBe(2);
    expect(run([]).scanned).toBe(0);
    // an exemption entry skips a file only for G-S19
    const root = plant({ 'src/wallet-link/a.ts': SIGNS });
    expect(runGuard('G-S19', { root, exemptions: { 'src/wallet-link/a.ts': ['G-S19'] } }).violations).toEqual([]);
    expect(runGuard('G-S19', { root, exemptions: { 'src/wallet-link/a.ts': ['G-S13'] } }).violations.length).toBeGreaterThan(0);
  });

  it('the closure helpers: edges are value imports only, specifiers resolve to .ts, .tsx and index files, chains name the path', () => {
    const root = plant({
      'src/wallet-link/entry.ts': [
        imp('{ a }', '../lib/a'),
        imp('type { T }', '../lib/type-only'),
        side('../lib/side'),
        reexport('{ r }', '../lib/reexported'),
        `export const lazy = () => ${dyn('../lib/lazy')};\n`,
        imp('{ x }', '../lib/folder'),
        imp('{ y }', '../lib/jsx.js'),
        imp('{ z }', 'node:fs'),
      ].join(''),
      'src/lib/a.ts': imp('{ deep }', './deep') + 'export const a = deep;\n',
      'src/lib/deep.ts': 'export const deep = 1;\n',
      'src/lib/type-only.ts': 'export type T = 1;\n',
      'src/lib/side.ts': 'export {};\n',
      'src/lib/reexported.ts': 'export const r = 1;\n',
      'src/lib/lazy.ts': 'export const l = 1;\n',
      'src/lib/folder/index.ts': 'export const x = 1;\n',
      'src/lib/jsx.tsx': 'export const y = 1;\n',
    });
    const planted = new ScanContext(root);
    const closure = importClosure(planted, ['src/wallet-link/entry.ts']);
    expect(closure.files).toEqual([
      'src/lib/a.ts', 'src/lib/deep.ts', 'src/lib/folder/index.ts', 'src/lib/jsx.tsx', 'src/lib/lazy.ts', 'src/lib/reexported.ts', 'src/lib/side.ts', 'src/wallet-link/entry.ts',
    ]);
    expect(closureChain(closure, 'src/lib/deep.ts')).toBe('src/wallet-link/entry.ts > src/lib/a.ts > src/lib/deep.ts');
    expect(closureChain(closure, 'src/wallet-link/entry.ts')).toBeNull();
    expect(resolveModuleFile('src/wallet-link/entry.ts', '../lib/folder', planted)).toBe('src/lib/folder/index.ts');
    expect(resolveModuleFile('src/wallet-link/entry.ts', '../lib/jsx.js', planted)).toBe('src/lib/jsx.tsx');
    expect(resolveModuleFile('src/wallet-link/entry.ts', 'node:fs', planted)).toBeNull();
    expect(resolveModuleFile('src/wallet-link/entry.ts', '../lib/nope', planted)).toBeNull();
    const refs = extractImports(planted.read('src/wallet-link/entry.ts'));
    expect(refs.find((r) => r.spec === '../lib/type-only')?.typeOnly).toBe(true);
    expect(refs.find((r) => r.spec === '../lib/a')?.typeOnly).toBe(false);
    expect(refs.find((r) => r.spec === '../lib/lazy')?.typeOnly).toBe(false);
  });

  it('isWalletStoreImport: src/data/**, wallets* and wallet-crypto/store/vault modules, by resolved path; the allowed wallet-* modules of round 7 are not wallet stores', () => {
    const from = 'src/wallet-link/x.ts';
    for (const spec of [
      '../data/rebate-settings', '../data', '../data/deep/x', '../bot/wallets', './wallets', '../bot/wallets-store', '../bot/wallet-crypto',
      '../bot/wallet-store', '../lib/wallet-vault', '../wallets/index', '../bot/wallets.json',
    ]) {
      expect(isWalletStoreImport(from, spec), spec).toBe(true);
    }
    for (const spec of [
      '../execution/wallet-reads', '../execution/wallet-rpc', '../execution/wallet-find', './routes', './handler', '../database', '../lib/redact', 'node:crypto',
      '@solana/web3.js', '../execution/data-parse',
    ]) {
      expect(isWalletStoreImport(from, spec), spec).toBe(false);
    }
    // a data folder below the covered folder is not src/data
    expect(isWalletStoreImport('src/wallet-link/x.ts', './data/x')).toBe(false);
  });
});
