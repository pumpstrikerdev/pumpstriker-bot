/**
 * Vitest setup file for the TG Bot (plan grind #69, C00 section 3). The Engine has the same file with the
 * same rules. It runs before every test file, in this order:
 *   (a) refuse to run in a tree that holds live secrets (a `.env` file or `data/wallets.json`);
 *   (b) wipe the process environment down to the standard OS keys, then set NODE_ENV=test;
 *   (c) chdir into a fresh temp directory, so dotenv and every cwd-relative read see an empty tree
 *       (tests resolve fixtures through __dirname, never through process.cwd());
 *   (d) block every socket that is not loopback (net.Socket.prototype.connect) and put a
 *       deny-by-default undici MockAgent in front of the global fetch dispatcher.
 * The pure helpers are exported so test-setup.test.ts can exercise them without re-running the side effects.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';

export const REFUSAL_MESSAGE = 'refusing to run tests in a tree that holds live secrets';

/** Keys that survive the wipe (compared case-insensitively: Windows reports `Path`, `SystemRoot`, ...).
 *  The first group is the list in C00 section 3(b); the rest are OS keys that carry no secret and that
 *  child tools (git, powershell) need to start. `NODE_*` and `VITEST*` are kept by prefix. */
const KEEP_ENV_KEYS: ReadonlySet<string> = new Set([
  'PATH', 'TEMP', 'TMP', 'SYSTEMROOT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
  'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'OS', 'HOMEDRIVE', 'HOMEPATH',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'ALLUSERSPROFILE', 'PUBLIC',
  'USERNAME', 'COMPUTERNAME', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
]);

export function isKeptEnvKey(key: string): boolean {
  const up = key.toUpperCase();
  return KEEP_ENV_KEYS.has(up) || up.startsWith('NODE_') || up.startsWith('VITEST');
}

/** Delete every non-standard key from `env` (mutates) and return the deleted key names. */
export function wipeEnv(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    if (isKeptEnvKey(key)) continue;
    delete env[key];
    removed.push(key);
  }
  return removed;
}

export function isLiveEnvFileName(name: string): boolean {
  return name === '.env' || (name.startsWith('.env.') && name !== '.env.example');
}

/** Live-secret files directly inside any of `dirs`: `.env`, `.env.*` (not `.env.example`) and `data/wallets.json`. */
export function findLiveSecretFiles(dirs: readonly string[]): string[] {
  const hits: string[] = [];
  for (const dir of new Set(dirs.map((d) => path.resolve(d)))) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) if (isLiveEnvFileName(name)) hits.push(path.join(dir, name));
    const wallets = path.join(dir, 'data', 'wallets.json');
    if (fs.existsSync(wallets)) hits.push(wallets);
  }
  return hits;
}

export function assertNoLiveSecrets(startCwd: string, packageRoot: string): void {
  const hits = findLiveSecretFiles([startCwd, packageRoot]);
  if (hits.length > 0) {
    throw new Error(`${REFUSAL_MESSAGE} (found: ${hits.map((h) => path.basename(h)).join(', ')} in ${path.dirname(hits[0])})`);
  }
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return LOOPBACK_HOSTS.has(h);
}

/** Where a `net.Socket#connect(...)` call goes, or null for an IPC path (unix socket / named pipe: not network egress). */
export function describeConnectTarget(args: readonly unknown[]): { host: string; port: string } | null {
  let a: readonly unknown[] = args;
  if (Array.isArray(a[0])) a = a[0] as unknown[]; // net's internal normalized form: [options, cb]
  const first = a[0];
  if (first !== null && typeof first === 'object') {
    const o = first as { host?: unknown; port?: unknown; path?: unknown };
    if (typeof o.path === 'string' && o.path.length > 0) return null;
    return { host: o.host === undefined || o.host === null ? 'localhost' : String(o.host), port: String(o.port ?? '') };
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return null; // connect(path)
  return { host: typeof a[1] === 'string' ? a[1] : 'localhost', port: String(first) };
}

function egressError(host: string, port: string, detail?: string): Error {
  const err = new Error(`EGRESS_BLOCKED ${host}:${port}${detail ? ` (${detail})` : ''}`);
  (err as Error & { code?: string }).code = 'EGRESS_BLOCKED';
  return err;
}

function originHostPort(origin: unknown): { host: string; port: string } {
  try {
    const u = new URL(String(origin));
    return { host: u.hostname, port: u.port || (u.protocol === 'https:' ? '443' : '80') };
  } catch {
    return { host: String(origin), port: '' };
  }
}

function blockEgress(): void {
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: unknown[]) {
    const target = describeConnectTarget(args);
    if (target !== null && !isLoopbackHost(target.host)) throw egressError(target.host, target.port);
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect(/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/);
  const rawDispatch = agent.dispatch.bind(agent);
  // The stock MockAgent error is "MockNotMatchedError"; the suite's one egress signal is EGRESS_BLOCKED. undici reports the
  // error either by throwing from dispatch (older releases) or through the handler's onError / onResponseError (7.x).
  const convert = (err: unknown, origin: unknown): unknown => {
    if (err instanceof Error && err.name === 'MockNotMatchedError') {
      const { host, port } = originHostPort(origin);
      const wrapped = egressError(host, port, err.message);
      (wrapped as Error & { cause?: unknown }).cause = err;
      return wrapped;
    }
    return err;
  };
  agent.dispatch = ((opts: { origin?: unknown }, handler: object) => {
    const wrapHandler = new Proxy(handler, {
      get(target, prop): unknown {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== 'function') return value;
        const fn = value as (...a: unknown[]) => unknown;
        if (prop === 'onError') return (err: unknown, ...rest: unknown[]) => fn.call(target, convert(err, opts.origin), ...rest);
        if (prop === 'onResponseError') return (controller: unknown, err: unknown, ...rest: unknown[]) => fn.call(target, controller, convert(err, opts.origin), ...rest);
        return fn.bind(target);
      },
    });
    try {
      return (rawDispatch as (o: unknown, h: unknown) => boolean)(opts, wrapHandler);
    } catch (err) {
      throw convert(err, opts.origin);
    }
  }) as typeof agent.dispatch;
  setGlobalDispatcher(agent);
}

function applySetup(): void {
  const startCwd = process.cwd();
  const packageRoot = path.resolve(__dirname, '..');
  assertNoLiveSecrets(startCwd, packageRoot); // (a)
  wipeEnv(process.env); // (b)
  process.env.NODE_ENV = 'test';
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-test-')); // (c)
  process.chdir(tempCwd);
  process.on('exit', () => {
    try {
      process.chdir(os.tmpdir());
      fs.rmSync(tempCwd, { recursive: true, force: true });
    } catch {
      /* best effort: the OS temp cleaner takes what is left */
    }
  });
  blockEgress(); // (d)
}

const flag = globalThis as { __PS_TEST_SETUP_DONE__?: boolean };
if (!flag.__PS_TEST_SETUP_DONE__) {
  flag.__PS_TEST_SETUP_DONE__ = true;
  applySetup();
}
