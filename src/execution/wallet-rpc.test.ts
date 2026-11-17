/**
 * R7-W5 wallet-rpc.ts: the one JSON-RPC port of every wallet flow. Real loopback HTTP servers (127.0.0.1, port 0) stand in for the provider and
 * for "any other lane"; nothing leaves the machine.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatViolations, importClosure, runGuard, ScanContext } from '../guards/guard-lib';
import { createWalletRpc, resolveWalletRpcUrl, withConfirmedCommitment, WalletRpcError, WALLET_RPC_METHODS } from './wallet-rpc';

interface Seen { url: string; method: string; body: any }
interface Server { url: string; seen: Seen[]; close(): Promise<void> }

/** A JSON-RPC server on 127.0.0.1:0. `answer` decides the reply per request; return undefined to never answer (a hung provider). */
async function serve(answer: (body: any, req: http.IncomingMessage) => { status?: number; json?: unknown; text?: string } | undefined): Promise<Server> {
  const seen: Seen[] = [];
  const open = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body: any = null;
      try { body = JSON.parse(raw); } catch { /* keep null */ }
      seen.push({ url: req.url ?? '', method: req.method ?? '', body });
      const a = answer(body, req);
      if (a === undefined) return;
      res.writeHead(a.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(a.text ?? JSON.stringify(a.json ?? { jsonrpc: '2.0', id: body?.id ?? 1, result: { value: 1 } }));
    });
  });
  server.on('connection', (s) => { open.add(s); s.on('close', () => open.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`, seen,
    close: () => new Promise<void>((resolve) => { for (const s of open) s.destroy(); server.close(() => resolve()); }),
  };
}

const servers: Server[] = [];
const envSaved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in envSaved)) envSaved[k] = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const [k, v] of Object.entries(envSaved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const k of Object.keys(envSaved)) delete envSaved[k];
});
const start = async (...a: Parameters<typeof serve>): Promise<Server> => { const s = await serve(...a); servers.push(s); return s; };

describe('wallet RPC port', () => {
  it('WTX-T21 posts to one URL only (the A-68 override here), never a public lane, never a rebate parameter, never a send, and reads at confirmed', async () => {
    const mine = await start(() => ({ json: { jsonrpc: '2.0', id: 1, result: { value: 1 } } }));
    const decoy = await start(() => ({ json: { jsonrpc: '2.0', id: 1, result: { value: 'decoy' } } }));   // stands in for every other lane
    setEnv('RPC_URL', `${mine.url}/rpc`);
    setEnv('RPC_FALLBACKS', 'off');
    expect(resolveWalletRpcUrl()).toBe(`${mine.url}/rpc`);
    const rpc = createWalletRpc();                                                                         // default URL resolution: HELIUS_RPC_WALLET, or rpcOnlyUrl() under the override

    // every read method carries commitment confirmed, whatever the caller passed
    await rpc.call('getBalance', ['addr']);
    await rpc.call('getBalance', ['addr', { commitment: 'processed' }]);
    await rpc.call('getMultipleAccounts', [['a', 'b'], { encoding: 'base64', commitment: 'finalized' }]);
    await rpc.call('getAccountInfo', ['a', { encoding: 'base64' }]);
    await rpc.call('getTokenAccountsByOwner', ['o', { programId: 'p' }, { encoding: 'jsonParsed' }]);
    await rpc.call('getLatestBlockhash', []);
    await rpc.call('simulateTransaction', ['tx', { encoding: 'base64', sigVerify: false, commitment: 'processed' }]);
    await rpc.call('getMinimumBalanceForRentExemption', [300]);
    await rpc.call('getTransaction', ['sig', { maxSupportedTransactionVersion: 0, commitment: 'finalized' }]);
    await rpc.call('getSignaturesForAddress', ['addr', { limit: 10 }]);
    await rpc.call('getSignatureStatuses', [['sig'], { searchTransactionHistory: true }]);
    await rpc.call('getPriorityFeeEstimate', [{ accountKeys: ['a'], options: { priorityLevel: 'Medium' } }]);
    const commitmentOf = (m: string): unknown => {
      const req = mine.seen.filter((s) => s.body.method === m);
      return req.map((r) => (r.body.params as unknown[]).map((p) => (typeof p === 'object' && p !== null && !Array.isArray(p) ? (p as { commitment?: unknown }).commitment : undefined)).find((c) => c !== undefined));
    };
    expect(commitmentOf('getBalance')).toEqual(['confirmed', 'confirmed']);
    expect(commitmentOf('getMultipleAccounts')).toEqual(['confirmed']);
    expect(commitmentOf('getAccountInfo')).toEqual(['confirmed']);
    expect(commitmentOf('getTokenAccountsByOwner')).toEqual(['confirmed']);
    expect(commitmentOf('getLatestBlockhash')).toEqual(['confirmed']);
    expect(commitmentOf('simulateTransaction')).toEqual(['confirmed']);
    expect(commitmentOf('getMinimumBalanceForRentExemption')).toEqual(['confirmed']);
    expect(commitmentOf('getTransaction')).toEqual(['confirmed']);
    expect(commitmentOf('getSignaturesForAddress')).toEqual(['confirmed']);
    expect(mine.seen.find((s) => s.body.method === 'getTransaction')!.body.params[1]).toMatchObject({ maxSupportedTransactionVersion: 0 });   // the caller's other options survive
    expect(mine.seen.find((s) => s.body.method === 'getSignatureStatuses')!.body.params[1]).toEqual({ searchTransactionHistory: true });      // no commitment slot there
    expect(withConfirmedCommitment('getBalance', ['x'])).toEqual(['x', { commitment: 'confirmed' }]);
    const p: unknown[] = ['x', { commitment: 'processed' }];
    withConfirmedCommitment('getBalance', p);
    expect(p).toEqual(['x', { commitment: 'processed' }]);                                                  // the caller's params are copied, never mutated

    // one URL, exactly as configured: no rebate parameter, no extra query, JSON-RPC over POST
    expect(mine.seen.length).toBe(12);
    for (const s of mine.seen) {
      expect(s.url).toBe('/rpc');
      expect(s.method).toBe('POST');
      expect(s.url).not.toMatch(/rebate/i);
      expect(JSON.stringify(s.body)).not.toMatch(/rebate/i);
      expect(s.body).toMatchObject({ jsonrpc: '2.0' });
    }
    expect(decoy.seen).toEqual([]);

    // nothing that sends is on the allowlist, and a refused method never reaches the network
    const send = ['send', 'Transaction'].join('');
    for (const m of [send, ['send', 'RawTransaction'].join(''), 'requestAirdrop', 'getProgramAccounts', 'accountSubscribe']) {
      expect(WALLET_RPC_METHODS).not.toContain(m);
      await expect(rpc.call(m, [])).rejects.toMatchObject({ name: 'WalletRpcError', kind: 'method-refused' });
    }
    expect(mine.seen.length).toBe(12);

    // a failing provider is one request and one redacted error: no retry, no other lane
    const failing = await start(() => ({ status: 500, text: 'boom' }));
    const one = createWalletRpc({ url: failing.url });
    const e1 = await one.call('getBalance', ['x']).catch((e) => e);
    expect(e1).toBeInstanceOf(WalletRpcError);
    expect(e1).toMatchObject({ kind: 'http', httpStatus: 500 });
    expect(failing.seen.length).toBe(1);
    expect(decoy.seen).toEqual([]);

    // an error that carries a key in a URL is redacted, and any error is at most 200 characters
    const secret = 'ps-fixture-secret-key-0123456789abcdef';
    const leaky = await start(() => ({ json: { jsonrpc: '2.0', id: 1, error: { code: -32005, message: `rate limited at https://rpc.example/?api-key=${secret} ${'x'.repeat(400)}` } } }));
    const e2 = await createWalletRpc({ url: leaky.url }).call('getBalance', ['x']).catch((e) => e);
    expect(e2).toMatchObject({ kind: 'rpc', rpcCode: -32005 });
    expect(String(e2.message)).not.toContain(secret);
    expect(String(e2.message).length).toBeLessThanOrEqual(200);

    // a hung provider ends in a timeout error, not a hang
    const hung = await start(() => undefined);
    const e3 = await createWalletRpc({ url: hung.url, timeoutMs: 150 }).call('getBalance', ['x']).catch((e) => e);
    expect(e3).toMatchObject({ kind: 'timeout' });

    // no URL configured: a refusal to call, not a guess
    expect(resolveWalletRpcUrl({ HELIUS_RPC_WALLET: '' }, null)).toBeNull();
    await expect(createWalletRpc({ url: () => null }).call('getBalance', ['x'])).rejects.toMatchObject({ kind: 'no-url' });
    // the wallet lane when no override is set; the override wins when it is
    expect(resolveWalletRpcUrl({ HELIUS_RPC_WALLET: 'https://wallet-lane.invalid/' }, null)).toBe('https://wallet-lane.invalid/');
    expect(resolveWalletRpcUrl({ HELIUS_RPC_WALLET: 'https://wallet-lane.invalid/' }, 'http://127.0.0.1:9')).toBe('http://127.0.0.1:9');
    setEnv('RPC_FALLBACKS', undefined);                                                                    // RPC_URL set but fallbacks on: not the override
    expect(resolveWalletRpcUrl({ HELIUS_RPC_WALLET: 'https://wallet-lane.invalid/' })).toBe('https://wallet-lane.invalid/');
  });
});

describe('the wallet modules stay out of the signing code (G-S19 closure)', () => {
  it('the import closure of the new modules reaches none of the signing, journal, send or wallet-store files', () => {
    const root = path.resolve(__dirname, '..', '..');
    const ctx = new ScanContext(root);
    const names = ['unsigned-swap', 'unsigned-close', 'ext-verify', 'wallet-reads', 'wallet-rpc', 'wallet-find', 'rpc-budget', 'pumpfun-ix', 'pumpswap-ix', 'jupiter-ix', 'close-ix', 'compute-budget', 'tx-deltas', 'curve-parse'];
    const entries = names.map((n) => `src/execution/${n}.ts`);
    const closure = importClosure(ctx, entries);
    expect(closure.files).toEqual(expect.arrayContaining(entries));
    const forbidden = ['exec-common', 'fills', 'curve-state', 'tx-verify', 'send-context', 'router', 'jupiter', 'pumpfun-swap', 'pumpswap-swap', 'close-account', 'onchain-quote', 'pumpfun-info', 'blockhash-cache'];
    for (const f of forbidden) expect(closure.files, f).not.toContain(`src/execution/${f}.ts`);
    expect(closure.files.filter((f) => /^src\/data\//.test(f) || /wallets/.test(f))).toEqual([]);
    const res = runGuard('G-S19', { root, ctx, entries, exemptions: {} });
    expect(res.scanned).toBe(closure.files.length);
    expect(formatViolations(res.violations)).toBe('no violations');
  });
});
