/**
 * Static-guard library for the TG Bot (C00 section 5, last paragraph): G-S13 (no non-execution data source,
 * no constant SOL price), G-S1 over `src` (the bot holds no GMGN key and never names the GMGN API), G-S17
 * (test port and env isolation) and, from round 7 (A-100, C00 section 11), G-S19 (unsigned-builder isolation over the
 * transitive import closure of `src/wallet-link/**`). Pure helpers; `static-guards.test.ts` runs them over the real tree with the
 * per-guard map of `legacy-allowlist.ts`, `final-guards.test.ts` (round 4) with an EMPTY map.
 *
 * Scanning rules: files are read with fs and scanned line by line (comments count); `node_modules`, `dist`,
 * `.git`, `src/guards/**` and `src/test-setup.ts` are never scanned; `*.test.ts` files are skipped except by
 * G-S17. A violation reports file, line, rule and the MATCHED text only, never the whole line.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type Exemptions = Readonly<Record<string, readonly string[]>>;

export interface Violation {
  guard: string;
  rule: string;
  file: string;
  line: number;
  match: string;
  /** G-S19 only, for a file the closure reached through imports: the import chain from the entry file ("a.ts > b.ts > file"). */
  via?: string;
}
export interface GuardResult {
  guard: string;
  violations: Violation[];
  scanned: number;
}
export interface GuardOptions {
  /** Bot root (the folder that holds `src/`). */
  root: string;
  exemptions: Exemptions;
  ctx?: ScanContext;
  /**
   * G-S19 only: the entry files (root-relative, e.g. `src/execution/unsigned-swap.ts`) whose import closure is checked. Default: every
   * non-test file under `src/wallet-link/`. Lets a package prove its own modules are closure-clean before `src/wallet-link/` exists.
   */
  entries?: readonly string[];
}

export const BOT_GUARD_IDS = ['G-S1', 'G-S13', 'G-S17', 'G-S19'] as const;
export type BotGuardId = (typeof BOT_GUARD_IDS)[number];

export const GUARD_RULES: Readonly<Record<BotGuardId, readonly { id: string; title: string }[]>> = {
  'G-S1': [
    { id: 'openapi-host', title: 'the GMGN API host appears nowhere in the bot' },
    { id: 'x-apikey', title: 'the X-APIKEY header name (case-sensitive) appears nowhere in the bot' },
  ],
  'G-S13': [
    { id: 'banned-endpoint', title: 'no DexScreener, RugCheck, GMGN API, pump.fun balances or Jupiter price/token endpoint' },
    { id: 'constant-sol-price', title: 'no constant SOL price fallback (|| 200)' },
    { id: 'host-literal', title: 'Jupiter and pump.fun host literals only in src/execution/**, src/config.ts and jup.ag/swap display links' },
  ],
  'G-S17': [
    { id: 'test-port-literal', title: 'the literals 1002 and 3748 appear only in config-default assertions' },
    { id: 'spawn-env', title: 'spawn/fork/execFile calls pass an explicit env object' },
  ],
  /** A-100 (round 7): every rule runs over every file of the import closure of src/wallet-link/**, not only over that folder. */
  'G-S19': [
    { id: 'signing', title: 'the wallet-link import closure has no .sign( call and no Keypair value use' },
    { id: 'wallet-store-import', title: 'the wallet-link import closure imports no wallets module and nothing under src/data/**' },
    { id: 'send-and-tip', title: 'the wallet-link import closure names no heliusSmartSend, multiRpcSend, sendRawTransaction, sendTransaction, HELIUS_TIP or rebate-address' },
    { id: 'order-execute-path', title: 'the wallet-link import closure names no /order or /execute path' },
  ],
};

// ---------------------------------------------------------------------------------------------------------------
// Patterns (exactly as C00 section 5)
// ---------------------------------------------------------------------------------------------------------------

export const GMGN_HOST_RE = /openapi\.gmgn\.ai/i;
export const X_APIKEY_RE = /X-APIKEY/; // case-sensitive
/** Planner amendment A-2: the redaction modules must name the hosts whose keys they mask, so G-S13 permanently skips them
 *  (masks keys, never connects). NOT part of the legacy map: the final guards run with an empty map and still skip these. */
export const G_S13_REDACTION_EXEMPT: readonly string[] = ['src/lib/redact.ts', 'src/shared/redact.ts'];
/** The public token link https://gmgn.ai/sol/token/<ca> (C03 rule 2(j)) is allowed: only the API-ish gmgn.ai paths match. */
export const G_S13_RE =
  /dexscreener|rugcheck|openapi\.gmgn\.ai|gmgn\.ai\/(defi|api|v1)\b|pumpfun-balances|frontend-api-v3\.pump\.fun\/balances|\/price\/v\d|price\?ids=|\/tokens\/v\d|datapi\.jup|price\.jup\.ag/i;
export const CONSTANT_SOL_PRICE_RE = /\|\|\s*200\b/;
export const URL_HOST_RE = /(https?|wss?):\/\/([a-z0-9][a-z0-9.-]*)/gi;
/** Hosts that only the execution layer (and the config constants that feed it) may spell out. */
export const EXECUTION_HOSTS: readonly string[] = ['jup.ag', 'api.jup.ag', 'lite-api.jup.ag', 'pumpportal.fun', 'pump.fun'];
export const EXECUTION_HOST_FILES: readonly string[] = ['src/execution/**', 'src/config.ts'];
export const JUP_DISPLAY_LINK_RE = /^https:\/\/jup\.ag\/swap\//;
export const TEST_PORT_RE = /(?<![\w.])(?:1002|3748)(?![\w]|\.\d)/;
const CONFIG_DEFAULT_TEST_FILES: readonly string[] = ['src/config.test.ts'];
export const SPAWN_CALL_RE = /(?<![\w$])(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(/g;

// ---------------------------------------------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------------------------------------------

const globCache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = globCache.get(glob);
  if (hit) return hit;
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      re += '(?:';
      depth++;
    } else if (c === '}' && depth > 0) {
      re += ')';
      depth--;
    } else if (c === ',' && depth > 0) re += '|';
    else re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  const out = new RegExp(`^${re}$`);
  globCache.set(glob, out);
  return out;
}

export function matchGlob(glob: string, rel: string): boolean {
  return globToRegExp(glob).test(rel);
}

export function matchAny(globs: readonly string[], rel: string): boolean {
  return globs.some((g) => matchGlob(g, rel));
}

export function isExempt(rel: string, guard: string, map: Exemptions): boolean {
  for (const [glob, guards] of Object.entries(map)) {
    if (guards.includes(guard) && matchGlob(glob, rel)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// File walk
// ---------------------------------------------------------------------------------------------------------------

const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', '.git']);
const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|eot|pdf|zip|gz|onnx|db|sqlite3?|wasm)$/i;
export const BOT_SUBTREES: readonly string[] = ['src'];

export function isTestFile(rel: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(rel);
}

export function isGloballySkipped(rel: string): boolean {
  return rel.startsWith('src/guards/') || rel === 'src/test-setup.ts';
}

function walkInto(absDir: string, relDir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkInto(path.join(absDir, e.name), `${relDir}/${e.name}`, out);
    } else if (e.isFile()) out.push(`${relDir}/${e.name}`);
  }
}

export interface ScanFile {
  rel: string;
  text: string;
  lines: string[];
}
export interface Scope {
  include: readonly string[];
  exclude?: readonly string[];
  tests?: boolean;
}

export class ScanContext {
  private listing: string[] | null = null;
  private readonly cache = new Map<string, ScanFile>();

  constructor(
    readonly root: string,
    private readonly subtrees: readonly string[] = BOT_SUBTREES,
  ) {}

  all(): string[] {
    if (this.listing) return this.listing;
    const out: string[] = [];
    for (const sub of this.subtrees) walkInto(path.join(this.root, ...sub.split('/')), sub, out);
    this.listing = out;
    return out;
  }

  private names: Set<string> | null = null;

  /** Is `rel` a file of the scanned subtrees? */
  has(rel: string): boolean {
    if (!this.names) this.names = new Set(this.all());
    return this.names.has(rel);
  }

  read(rel: string): ScanFile {
    const hit = this.cache.get(rel);
    if (hit) return hit;
    let text = '';
    try {
      text = fs.readFileSync(path.join(this.root, ...rel.split('/')), 'utf8');
    } catch {
      text = '';
    }
    const file: ScanFile = { rel, text, lines: text.split(/\r?\n/) };
    this.cache.set(rel, file);
    return file;
  }

  select(scope: Scope): ScanFile[] {
    const out: ScanFile[] = [];
    for (const rel of this.all()) {
      if (isGloballySkipped(rel) || BINARY_EXT.test(rel)) continue;
      if (!scope.tests && isTestFile(rel)) continue;
      if (!matchAny(scope.include, rel)) continue;
      if (scope.exclude && matchAny(scope.exclude, rel)) continue;
      out.push(this.read(rel));
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Source helpers
// ---------------------------------------------------------------------------------------------------------------

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** Text between the `(` at `openIndex` and its matching `)`, honouring quotes, template literals and nesting. */
export function callArguments(text: string, openIndex: number): string {
  let depth = 0;
  let i = openIndex;
  const n = text.length;
  const skipString = (quote: string): void => {
    i++;
    while (i < n) {
      const c = text[i];
      if (c === '\\') i += 2;
      else if (quote === '`' && c === '$' && text[i + 1] === '{') {
        let d = 1;
        i += 2;
        while (i < n && d > 0) {
          const e = text[i];
          if (e === '{') d++;
          else if (e === '}') d--;
          else if (e === '"' || e === "'" || e === '`') {
            skipString(e);
            continue;
          }
          i++;
        }
      } else if (c === quote) {
        i++;
        return;
      } else if (c === '\n' && quote !== '`') return;
      else i++;
    }
  };
  while (i < n) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return text.slice(openIndex + 1, i);
    } else if (c === '"' || c === "'" || c === '`') {
      skipString(c);
      continue;
    }
    i++;
  }
  return text.slice(openIndex + 1);
}

/** An explicit env: an `env` key (or shorthand) in the call, and no wholesale `process.env` (a member read such as
 *  `process.env.PATH` while building the object is fine). */
export function envArgIsExplicit(args: string): boolean {
  if (!/[{,\s]env\s*[:,}]/.test(args)) return false;
  const withoutMembers = args.replace(/process\.env\s*(?:\.\s*[A-Za-z_$][\w$]*|\[[^\]]*\])/g, '');
  return !/process\.env/.test(withoutMembers);
}

/** Spawn-family calls in a file whose argument text contains no explicit `env`. */
export function spawnCallsWithoutEnv(file: ScanFile): { line: number; match: string }[] {
  const out: { line: number; match: string }[] = [];
  for (const m of file.text.matchAll(SPAWN_CALL_RE)) {
    const idx = m.index ?? 0;
    const lineStart = file.text.lastIndexOf('\n', idx - 1) + 1;
    const lineEnd = file.text.indexOf('\n', idx);
    const lineText = file.text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    if (isCommentLine(lineText)) continue;
    const before = file.text.slice(lineStart, idx);
    if (/\b(?:function|import|from)\b\s*$/.test(before) || /\bfunction\s+$/.test(before)) continue;
    const open = idx + m[0].length - 1;
    const args = callArguments(file.text, open);
    if (!envArgIsExplicit(args)) out.push({ line: lineOf(file.text, idx), match: m[0].replace(/\s*\($/, '(') });
  }
  return out;
}

function firstMatch(line: string, re: RegExp): string | null {
  const m = re.exec(line);
  return m ? m[0] : null;
}

function scanLines(files: readonly ScanFile[], guard: string, rule: string, res: readonly RegExp[], out: Violation[], skip?: (rel: string) => boolean): void {
  for (const f of files) {
    if (skip && skip(f.rel)) continue;
    for (let i = 0; i < f.lines.length; i++) {
      for (const re of res) {
        const hit = firstMatch(f.lines[i], re);
        if (hit !== null) {
          out.push({ guard, rule, file: f.rel, line: i + 1, match: hit });
          break;
        }
      }
    }
  }
}

/** Is `host` one of the execution-only hosts (or a subdomain of one)? */
export function isExecutionHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, '');
  return EXECUTION_HOSTS.some((x) => h === x || h.endsWith(`.${x}`));
}

// ---------------------------------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------------------------------

function gS1(ctx: ScanContext, ex: Exemptions): GuardResult {
  const files = ctx.select({ include: ['src/**'] });
  const v: Violation[] = [];
  const skip = (rel: string): boolean => isExempt(rel, 'G-S1', ex);
  scanLines(files, 'G-S1', 'openapi-host', [GMGN_HOST_RE], v, skip);
  scanLines(files, 'G-S1', 'x-apikey', [X_APIKEY_RE], v, skip);
  return { guard: 'G-S1', violations: v, scanned: files.length };
}

function gS13(ctx: ScanContext, ex: Exemptions): GuardResult {
  const files = ctx.select({ include: ['src/**'] });
  const v: Violation[] = [];
  const skip = (rel: string): boolean => G_S13_REDACTION_EXEMPT.includes(rel) || isExempt(rel, 'G-S13', ex);
  scanLines(files, 'G-S13', 'banned-endpoint', [G_S13_RE], v, skip);
  scanLines(files, 'G-S13', 'constant-sol-price', [CONSTANT_SOL_PRICE_RE], v, skip);
  for (const f of files) {
    if (skip(f.rel) || matchAny(EXECUTION_HOST_FILES, f.rel)) continue;
    for (let i = 0; i < f.lines.length; i++) {
      const line = f.lines[i];
      for (const m of line.matchAll(URL_HOST_RE)) {
        if (!isExecutionHost(m[2])) continue;
        const url = line.slice(m.index ?? 0);
        if (JUP_DISPLAY_LINK_RE.test(url)) continue; // https://jup.ag/swap/<pair> display link
        v.push({ guard: 'G-S13', rule: 'host-literal', file: f.rel, line: i + 1, match: m[2] });
      }
    }
  }
  return { guard: 'G-S13', violations: v, scanned: files.length };
}

function gS17(ctx: ScanContext, ex: Exemptions): GuardResult {
  const files = ctx.select({ include: ['src/**/*.test.ts', 'src/**/*.e2e.ts', 'src/testkit/**'], tests: true });
  const v: Violation[] = [];
  for (const f of files) {
    if (isExempt(f.rel, 'G-S17', ex)) continue;
    if (!matchAny(CONFIG_DEFAULT_TEST_FILES, f.rel)) scanLines([f], 'G-S17', 'test-port-literal', [TEST_PORT_RE], v);
    for (const hit of spawnCallsWithoutEnv(f)) v.push({ guard: 'G-S17', rule: 'spawn-env', file: f.rel, line: hit.line, match: hit.match });
  }
  return { guard: 'G-S17', violations: v, scanned: files.length };
}

// ---------------------------------------------------------------------------------------------------------------
// G-S19: unsigned-builder isolation over the import closure (A-100, C00 section 11, WALLET-DASHBOARD-DESIGN section 15 item 7, rev 3 R3-5 g)
// ---------------------------------------------------------------------------------------------------------------

export interface ImportRef {
  spec: string;
  line: number;
  /** `import type`, `export type`, or a named clause made only of `type` members: erased at compile time, so never a closure edge. */
  typeOnly: boolean;
}

const NAMED_ALL_TYPE_RE = /^\{\s*(?:type\s+[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*,?\s*)+\}$/;

/**
 * Every module specifier a file imports: static `import`/`export ... from`, side-effect imports, literal `import('x')` and `require('x')`.
 * Whole-line comments are skipped. A dynamic import whose argument is not a string literal is not seen (it names no module).
 */
export function extractImports(file: ScanFile): ImportRef[] {
  const out: ImportRef[] = [];
  const text = file.text;
  const push = (spec: string, index: number, typeOnly: boolean): void => {
    const line = lineOf(text, index);
    if (isCommentLine(file.lines[line - 1] ?? '')) return;
    out.push({ spec, line, typeOnly });
  };
  // a lookbehind (not a consumed separator) keeps `m.index` on the keyword, so the reported line is the statement's line
  const staticRe = /(?<=^|[;\s}])(import|export)\s+(type\s+)?([^'"`;]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(staticRe)) {
    const clause = (m[3] ?? '').trim();
    push(m[4], m.index ?? 0, Boolean(m[2]) || NAMED_ALL_TYPE_RE.test(clause));
  }
  const sideRe = /(?<=^|[;\s}])import\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(sideRe)) push(m[1], m.index ?? 0, false);
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(dynRe)) push(m[1], m.index ?? 0, false);
  const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(reqRe)) push(m[1], m.index ?? 0, false);
  return out;
}

/** Resolve a relative specifier against the importing file; null for a package specifier. Root-relative, no extension. */
export function resolveImport(fromRel: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  return joined.replace(/\.(?:[cm]?[jt]s|tsx|json)$/, '');
}

/** The source file a relative specifier names: `./x` -> x.ts or x.tsx, else x/index.ts or x/index.tsx; an exact `./x.ts` too. Null otherwise. */
export function resolveModuleFile(fromRel: string, spec: string, ctx: ScanContext): string | null {
  const base = resolveImport(fromRel, spec);
  if (base === null) return null;
  for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (ctx.has(cand)) return cand;
  const exact = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  return /\.tsx?$/.test(exact) && ctx.has(exact) ? exact : null;
}

export interface ImportClosure {
  /** The entry files that exist plus every file reached by a value edge, sorted. */
  files: string[];
  /** For each file, the file that first reached it (null for an entry). */
  via: ReadonlyMap<string, string | null>;
}

/**
 * The transitive closure of relative imports from `entries`. Edges: static imports, `export ... from`, literal dynamic `import()` and
 * `require()`; NOT `import type` / `export type` (erased). A specifier that names no file of the scanned tree is not an edge.
 */
export function importClosure(ctx: ScanContext, entries: readonly string[]): ImportClosure {
  const via = new Map<string, string | null>();
  const queue: string[] = [];
  for (const e of [...entries].sort()) {
    if (ctx.has(e) && !via.has(e)) {
      via.set(e, null);
      queue.push(e);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const rel = queue[q];
    for (const imp of extractImports(ctx.read(rel))) {
      if (imp.typeOnly) continue;
      const target = resolveModuleFile(rel, imp.spec, ctx);
      if (target !== null && !via.has(target)) {
        via.set(target, rel);
        queue.push(target);
      }
    }
  }
  return { files: [...via.keys()].sort(), via };
}

/** "entry > ... > rel", or null when `rel` is an entry. */
export function closureChain(closure: ImportClosure, rel: string): string | null {
  const parts: string[] = [rel];
  for (let up = closure.via.get(rel) ?? null; up !== null; up = closure.via.get(up) ?? null) parts.unshift(up);
  return parts.length > 1 ? parts.join(' > ') : null;
}

export const WALLET_LINK_DIR = 'src/wallet-link';
/** `.sign(` and tweetnacl's `sign.detached(`, and the web3.js Transaction.partialSign( call. */
const G_S19_SIGN_RES: readonly RegExp[] = [/\.sign\s*(?:\(|\.detached\b)/, /\bpartialSign\s*\(/];
const G_S19_KEYPAIR_RE = /\bKeypair\b/;
/** A type-only binding of Keypair: `import type { Keypair }` or `import { type Keypair }`. Every other mention is then a type position. */
const G_S19_KEYPAIR_TYPE_IMPORT_RE = /\bimport\s+type\s*\{[^}]*\bKeypair\b[^}]*\}\s*from|\bimport\s*\{[^}]*\btype\s+Keypair\b[^}]*\}\s*from/;
/** `HELIUS_TIP` is a prefix on purpose: HELIUS_TIP_ACCOUNTS is a tip table. */
const G_S19_SEND_RES: readonly RegExp[] = [
  /\bheliusSmartSend\b/, /\bmultiRpcSend\b/, /\bsendRawTransaction\b/, /\bsendTransaction\b/, /\bHELIUS_TIP/, /rebate[-_]?address/i,
];
const G_S19_PATH_RE = /\/(?:order|execute)\b/;
/**
 * config.ts is the bot's constants table: the wallet builders read CONFIG.JUPITER_API_KEY and jupUrls() from it (rev 3 R3-5 g), and it
 * DEFINES the Jupiter order/execute URL templates and the Helius tip-account table the server path uses. Naming an endpoint or a tip
 * account as data calls nothing, and any wallet file that uses one must spell its name (HELIUS_TIP..., a /order literal), which the
 * rules still catch in that file. So the send-and-tip and order-execute-path rules skip these files; signing and wallet-store-import do not.
 */
export const G_S19_DATA_TABLE_FILES: readonly string[] = ['src/config.ts'];
/** A wallets module (wallets, wallets-x, wallets.json) or the wallet key vault (wallet-crypto, wallet-store, wallet-vault), as a path segment. */
const WALLET_STORE_SEGMENT_RE = /^(?:wallets(?:[-_.].*)?|wallet-(?:crypto|store|vault))$/i;

/** Does this import reach the wallet key store: anything under src/data/ or a wallets* / wallet-crypto module? Type-only imports count. */
export function isWalletStoreImport(fromRel: string, spec: string): boolean {
  const relative = spec.startsWith('.');
  const target = relative ? resolveImport(fromRel, spec) : spec.replace(/^node:/, '');
  if (target === null) return false;
  if (relative && /^src\/data(?:\/|$)/.test(target)) return true;
  return target.split('/').some((seg) => WALLET_STORE_SEGMENT_RE.test(seg.replace(/\.(?:[cm]?[jt]s|tsx|json)$/, '')));
}

/**
 * G-S19. Entry files: every non-test file under src/wallet-link/ (or `entries`). The import closure is taken from them with this
 * library's own relative-import resolution, and every file of the closure (entries included) is checked: no signing, no Keypair value use,
 * no import of a wallet-store module, no send or tip capability, no Jupiter order/execute path. Whole-line comments are skipped by the
 * text rules (a comment signs nothing). With no src/wallet-link/ folder there are no entries: 0 files scanned, no violation.
 */
function gS19(ctx: ScanContext, ex: Exemptions, entries?: readonly string[]): GuardResult {
  const roots = entries ?? ctx.select({ include: [`${WALLET_LINK_DIR}/**`] }).map((f) => f.rel).filter((rel) => /\.tsx?$/.test(rel));
  const closure = importClosure(ctx, roots);
  const v: Violation[] = [];
  for (const rel of closure.files) {
    if (isExempt(rel, 'G-S19', ex)) continue;
    const f = ctx.read(rel);
    const chain = closureChain(closure, rel);
    const add = (rule: string, line: number, match: string): void => {
      v.push({ guard: 'G-S19', rule, file: rel, line, match, ...(chain === null ? {} : { via: chain }) });
    };
    const keypairIsType = G_S19_KEYPAIR_TYPE_IMPORT_RE.test(f.text);
    const dataTable = matchAny(G_S19_DATA_TABLE_FILES, rel);
    for (let i = 0; i < f.lines.length; i++) {
      const line = f.lines[i];
      if (isCommentLine(line)) continue;
      for (const re of G_S19_SIGN_RES) {
        const hit = firstMatch(line, re);
        if (hit !== null) {
          add('signing', i + 1, hit.replace(/\s+/g, ''));
          break;
        }
      }
      if (!keypairIsType) {
        const hit = firstMatch(line, G_S19_KEYPAIR_RE);
        if (hit !== null) add('signing', i + 1, hit);
      }
      if (dataTable) continue;
      for (const re of G_S19_SEND_RES) {
        const hit = firstMatch(line, re);
        if (hit !== null) {
          add('send-and-tip', i + 1, hit);
          break;
        }
      }
      const pathHit = firstMatch(line, G_S19_PATH_RE);
      if (pathHit !== null) add('order-execute-path', i + 1, pathHit);
    }
    for (const imp of extractImports(f)) {
      if (isWalletStoreImport(rel, imp.spec)) add('wallet-store-import', imp.line, imp.spec);
    }
  }
  return { guard: 'G-S19', violations: v, scanned: closure.files.length };
}

// ---------------------------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------------------------

export function runGuard(id: BotGuardId, opts: GuardOptions): GuardResult {
  const ctx = opts.ctx ?? new ScanContext(opts.root);
  switch (id) {
    case 'G-S1': return gS1(ctx, opts.exemptions);
    case 'G-S13': return gS13(ctx, opts.exemptions);
    case 'G-S17': return gS17(ctx, opts.exemptions);
    case 'G-S19': return gS19(ctx, opts.exemptions, opts.entries);
  }
}

export function runAllGuards(opts: GuardOptions): Record<BotGuardId, GuardResult> {
  const ctx = opts.ctx ?? new ScanContext(opts.root);
  const out = {} as Record<BotGuardId, GuardResult>;
  for (const id of BOT_GUARD_IDS) out[id] = runGuard(id, { ...opts, ctx });
  return out;
}

export function violationsOfRule(res: GuardResult, rule: string): Violation[] {
  return res.violations.filter((x) => x.rule === rule);
}

export function formatViolations(vs: readonly Violation[], limit = 40): string {
  if (vs.length === 0) return 'no violations';
  const shown = vs.slice(0, limit).map((x) => `${x.file}:${x.line} [${x.guard}/${x.rule}] ${x.match}${x.via ? ` (via ${x.via})` : ''}`);
  if (vs.length > limit) shown.push(`... and ${vs.length - limit} more`);
  return shown.join('\n');
}
