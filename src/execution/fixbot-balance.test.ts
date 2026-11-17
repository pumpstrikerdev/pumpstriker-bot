/**
 * A-93f FIXBOT-T14: the balance reads that size full exits, feed the landed-check and close positions on a zero read ask for the
 * 'confirmed' commitment (the RPC default is 'finalized', about 13 s behind the fills and statuses the bot reads at 'confirmed').
 * Only the HTTP client is mocked: no socket, no RPC node.
 */
import { Keypair } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ http: vi.fn() }));
vi.mock('../lib/http-client', () => ({ fetch: h.http }));
vi.mock('./blockhash-cache', () => ({ getCachedBlockhash: () => null }));
vi.mock('./pumpfun-info', () => ({ getCachedPumpFunInfo: () => undefined, fetchPumpFunInfo: async () => ({ hasData: false }) }));
vi.mock('../logger', () => ({ log: vi.fn(), logOk: vi.fn(), logWarn: vi.fn(), logErr: vi.fn(), logDbg: vi.fn(), setBroadcast: vi.fn(), emitEvent: vi.fn() }));

import { getSolBalance, getSplTokenBalance, getWsolBalance } from './jupiter';

const OWNER = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey.toBase58();
const MINT = Keypair.fromSeed(new Uint8Array(32).fill(12)).publicKey.toBase58();

type Rpc = { method: string; params: unknown[] };
const calls: Rpc[] = [];

beforeEach(() => {
  calls.length = 0;
  h.http.mockReset();
  h.http.mockImplementation(async (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body) as Rpc;
    calls.push(req);
    const result = req.method === 'getBalance' ? { value: 5_000 } : { value: { amount: '42', uiAmount: 0.000042, decimals: 6 } };
    return { status: 200, ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  });
});

describe('A-93f balance commitment', () => {
  it('FIXBOT-T14 getSplTokenBalance, getWsolBalance and getSolBalance read at the confirmed commitment', async () => {
    expect(await getSplTokenBalance(OWNER, MINT)).toMatchObject({ rawAtoms: 42 });
    await getWsolBalance(OWNER);
    expect(await getSolBalance(OWNER)).toBe(5_000);
    const reads = calls.filter(c => c.method === 'getTokenAccountBalance' || c.method === 'getBalance');
    expect(reads.length).toBeGreaterThanOrEqual(3);
    for (const c of reads) expect(c.params[1], `${c.method} commitment`).toEqual({ commitment: 'confirmed' });
  });
});
