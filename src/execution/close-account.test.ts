/**
 * B40 close-account (separate CloseAccount transaction). Fake RPC, fake signer, fake sender: no transaction ever leaves the process. Signatures are
 * generated at runtime (A-20).
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import bs58 from 'bs58';
import { Keypair, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  ATA_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT,
  deriveAta, type ExecClock, type ExecRpc,
} from './exec-common';
import { buildCloseAccountTx, CLOSE_ACCOUNT_RETRIES, createCloseAccountApi } from './close-account';

const FIXTURES = path.resolve(__dirname, '..', '..', 'test-fixtures', 'execution');
const key = (n: number): string => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const signer = Keypair.fromSeed(new Uint8Array(32).fill(1));
const OWNER = signer.publicKey.toBase58();
const MINT = key(2);
const newSig = (): string => bs58.encode(randomBytes(64));
/** A secret-shaped value generated at runtime (A-20): the redaction assertions must not depend on a committed literal. */
const SECRET = `k${randomBytes(12).toString('hex')}`;

class FakeClock implements ExecClock {
  t = 9_000_000;
  now(): number { return this.t; }
  async sleep(ms: number): Promise<void> { this.t += ms; }
}

function closeMeta(ata: string): any {
  const vars: Record<string, string> = {
    OWNER, MINT, ATA: ata, COMPUTE_BUDGET: COMPUTE_BUDGET_PROGRAM_ID, TOKEN_PROGRAM: TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM: TOKEN_2022_PROGRAM_ID, SYSTEM: SystemProgram.programId.toBase58(), PUMP_PROGRAM: PUMP_PROGRAM_ID,
    AMM_PROGRAM: PUMPSWAP_PROGRAM_ID, ATA_PROGRAM: ATA_PROGRAM_ID, WSOL_MINT,
  };
  const raw = fs.readFileSync(path.join(FIXTURES, 'meta-close-account.json'), 'utf8');
  return JSON.parse(raw.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, k: string) => vars[k]));
}

interface AcctOpts { program: string; amount?: string; withheld?: number; state?: string; closeAuthority?: string }
/** jsonParsed getAccountInfo value of a token account. */
function parsedAta(o: AcctOpts): any {
  const info: any = {
    mint: MINT, owner: OWNER, state: o.state ?? 'initialized', isNative: false,
    tokenAmount: { amount: o.amount ?? '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
  };
  if (o.withheld !== undefined) info.extensions = [{ extension: 'immutableOwner' }, { extension: 'transferFeeAmount', state: { withheldAmount: o.withheld } }];
  if (o.closeAuthority) info.closeAuthority = o.closeAuthority;
  return { lamports: 2_039_280, owner: o.program, executable: false, data: { program: o.program === TOKEN_2022_PROGRAM_ID ? 'spl-token-2022' : 'spl-token', parsed: { type: 'account', info }, space: 165 } };
}

/** Fake chain: the account lives at the ATA derived under `program`; `closedAfterSends` makes it vanish after N sends. */
function fakeEnv(opts: { account?: AcctOpts | null; sendBehaviour?: (n: number) => 'ok' | Error; closeAfterSend?: number; rpcErrors?: boolean }) {
  const acct = opts.account === undefined ? null : opts.account;
  const ataAddr = acct ? deriveAta(OWNER, MINT, acct.program === TOKEN_2022_PROGRAM_ID ? 'token2022' : 'token') : deriveAta(OWNER, MINT, 'token');
  const sent: VersionedTransaction[] = [];
  const sigs: string[] = [];
  let accountGone = false;
  const rpc: ExecRpc = {
    async call(method: string, params: unknown[]): Promise<any> {
      if (opts.rpcErrors) throw new Error(`rpc down https://rpc.example.invalid/?api-key=${SECRET}`);
      if (method === 'getAccountInfo') {
        const addr = params[0] as string;
        if (acct && !accountGone && addr === ataAddr) return { context: { slot: 1 }, value: parsedAta(acct) };
        return { context: { slot: 1 }, value: null };
      }
      if (method === 'getTransaction') return closeMeta(ataAddr);
      throw new Error(`unexpected rpc ${method}`);
    },
  };
  const api = createCloseAccountApi({
    getSigner: (o) => (o === OWNER ? signer : null),
    rpc,
    clock: new FakeClock(),
    getBlockhash: async () => ({ blockhash: key(90), lastValidBlockHeight: 1 }),
    send: async (tx) => {
      sent.push(tx);
      const n = sent.length;
      const b = opts.sendBehaviour ? opts.sendBehaviour(n) : 'ok';
      if (opts.closeAfterSend !== undefined && n >= opts.closeAfterSend) accountGone = true;
      if (b !== 'ok') throw b;
      const sig = newSig();
      sigs.push(sig);
      accountGone = true;
      return sig;
    },
  });
  return { api, sent, sigs, ataAddr };
}

/** Program id, data and the (key, writable, signer) triples of the CloseAccount instruction (the last one) of a transaction. */
function closeIxOf(tx: VersionedTransaction) {
  const msg = tx.message;
  const ix = msg.compiledInstructions[msg.compiledInstructions.length - 1];
  const keys = msg.staticAccountKeys;
  return {
    program: keys[ix.programIdIndex].toBase58(),
    data: [...ix.data],
    accounts: ix.accountKeyIndexes.map((i) => ({ key: keys[i].toBase58(), writable: msg.isAccountWritable(i), signer: msg.isAccountSigner(i) })),
    firstPrograms: msg.compiledInstructions.slice(0, -1).map((c) => keys[c.programIdIndex].toBase58()),
    payer: keys[0].toBase58(),
  };
}

describe('close-account', () => {
  it('B4-T03 a full exit with a zero balance sends CloseAccount under the ATA program; a partial sell sends none; withheld fees skip', async () => {
    // classic Token: data [9], keys [ata (w), owner (w, rent destination), owner (signer)], program = Token
    const classic = fakeEnv({ account: { program: TOKEN_PROGRAM_ID, amount: '0' } });
    const r1 = await classic.api.closeIfEmpty(OWNER, MINT);
    expect(r1.status).toBe('closed');
    expect(r1.tx).toBe(classic.sigs[0]);
    expect(r1.rentLamports).toBe('2039280');   // from the transaction meta (the closed account's lamports)
    expect(r1.reason).toBeNull();
    expect(classic.sent).toHaveLength(1);
    const c1 = closeIxOf(classic.sent[0]);
    expect(c1.program).toBe(TOKEN_PROGRAM_ID);
    expect(c1.data).toEqual([9]);
    expect(c1.accounts).toEqual([
      { key: classic.ataAddr, writable: true, signer: false },
      { key: OWNER, writable: true, signer: true },     // rent destination (the same key is also the signing authority)
      { key: OWNER, writable: true, signer: true },
    ]);
    expect(c1.payer).toBe(OWNER);
    // low priority fee: only ComputeBudget instructions come before it
    expect(c1.firstPrograms.every((p) => p === COMPUTE_BUDGET_PROGRAM_ID)).toBe(true);

    // Token-2022 account: the same instruction under the Token-2022 program (read from getAccountInfo(ata).owner)
    const t22 = fakeEnv({ account: { program: TOKEN_2022_PROGRAM_ID, amount: '0', withheld: 0 } });
    const r2 = await t22.api.closeIfEmpty(OWNER, MINT);
    expect(r2.status).toBe('closed');
    expect(closeIxOf(t22.sent[0]).program).toBe(TOKEN_2022_PROGRAM_ID);
    expect(closeIxOf(t22.sent[0]).accounts[0].key).toBe(t22.ataAddr);
    expect(t22.ataAddr).not.toBe(classic.ataAddr);   // the program is part of the ATA derivation

    // partial sell: tokens left -> no transaction at all
    const partial = fakeEnv({ account: { program: TOKEN_PROGRAM_ID, amount: '2500000' } });
    const r3 = await partial.api.closeIfEmpty(OWNER, MINT);
    expect(r3).toMatchObject({ status: 'skipped', tx: null, rentLamports: null });
    expect(r3.reason).toMatch(/balance above zero/);
    expect(partial.sent).toHaveLength(0);

    // Token-2022 with withheld transfer fees: CloseAccount would fail, so skip with a reason
    const withheld = fakeEnv({ account: { program: TOKEN_2022_PROGRAM_ID, amount: '0', withheld: 42 } });
    const r4 = await withheld.api.closeIfEmpty(OWNER, MINT);
    expect(r4).toMatchObject({ status: 'skipped', tx: null });
    expect(r4.reason).toMatch(/withheld/);
    expect(withheld.sent).toHaveLength(0);

    // account missing -> skipped with a reason
    const missing = fakeEnv({ account: null });
    const r5 = await missing.api.closeIfEmpty(OWNER, MINT);
    expect(r5).toMatchObject({ status: 'skipped', tx: null });
    expect(r5.reason).toMatch(/missing/);
    expect(missing.sent).toHaveLength(0);
  });

  it('skips a frozen account and a foreign close authority, and fails (not skips) on RPC errors with a redacted reason', async () => {
    const frozen = fakeEnv({ account: { program: TOKEN_PROGRAM_ID, amount: '0', state: 'frozen' } });
    expect((await frozen.api.closeIfEmpty(OWNER, MINT)).reason).toMatch(/frozen/);
    const foreign = fakeEnv({ account: { program: TOKEN_PROGRAM_ID, amount: '0', closeAuthority: key(55) } });
    expect((await foreign.api.closeIfEmpty(OWNER, MINT)).reason).toMatch(/close authority/);
    expect(frozen.sent.length + foreign.sent.length).toBe(0);

    const down = fakeEnv({ account: { program: TOKEN_PROGRAM_ID, amount: '0' }, rpcErrors: true });
    const r = await down.api.closeIfEmpty(OWNER, MINT);
    expect(r.status).toBe('failed');
    expect(r.reason).not.toContain(SECRET);   // B40 rule 4: redactSecrets(...).slice(0, 200)
    expect((r.reason ?? '').length).toBeLessThanOrEqual(200);
    expect(down.sent).toHaveLength(0);

    const env = fakeEnv({ account: { program: TOKEN_PROGRAM_ID, amount: '0' } });
    expect((await env.api.closeIfEmpty('not-a-key', MINT)).status).toBe('failed');
    expect((await env.api.closeIfEmpty(key(77), MINT)).status).toBe('skipped');   // account of another owner does not exist
  });

  it('retries a failing send twice (three sends), then reports failed with a redacted, cut reason', async () => {
    const longTail = 'x'.repeat(400);
    const env = fakeEnv({
      account: { program: TOKEN_PROGRAM_ID, amount: '0' },
      sendBehaviour: () => new Error(`send failed https://rpc.example.invalid/?api-key=${SECRET} ${longTail}`),
    });
    const r = await env.api.closeIfEmpty(OWNER, MINT);
    expect(CLOSE_ACCOUNT_RETRIES).toBe(2);
    expect(env.sent).toHaveLength(3);
    expect(r).toMatchObject({ status: 'failed', tx: null, rentLamports: null });
    expect(r.reason).not.toContain(SECRET);
    expect((r.reason ?? '').length).toBeLessThanOrEqual(200);

    // second attempt lands
    const flaky = fakeEnv({ account: { program: TOKEN_PROGRAM_ID, amount: '0' }, sendBehaviour: (n) => (n === 1 ? new Error('blockhash expired') : 'ok') });
    const ok = await flaky.api.closeIfEmpty(OWNER, MINT);
    expect(ok.status).toBe('closed');
    expect(flaky.sent).toHaveLength(2);

    // the first attempt landed after its confirmation timed out: the retry finds the account gone and does not send again
    const late = fakeEnv({ account: { program: TOKEN_PROGRAM_ID, amount: '0' }, sendBehaviour: () => new Error('not confirmed within 60s'), closeAfterSend: 1 });
    const l = await late.api.closeIfEmpty(OWNER, MINT);
    expect(l).toMatchObject({ status: 'closed', tx: null });
    expect(late.sent).toHaveLength(1);

    // no signer for the owner
    const noSigner = createCloseAccountApi({
      getSigner: () => null,
      rpc: { call: async () => ({ value: parsedAta({ program: TOKEN_PROGRAM_ID, amount: '0' }) }) },
    });
    expect((await noSigner.closeIfEmpty(OWNER, MINT)).reason).toBe('no signer for this owner');
  });

  it('buildCloseAccountTx signs with the owner and carries exactly one non-ComputeBudget instruction', () => {
    const ata = deriveAta(OWNER, MINT, 'token');
    const tx = buildCloseAccountTx(signer, ata, TOKEN_PROGRAM_ID, key(90));
    expect(tx.signatures).toHaveLength(1);
    expect(tx.signatures[0].some((b) => b !== 0)).toBe(true);
    const c = closeIxOf(tx);
    expect(c.program).toBe(TOKEN_PROGRAM_ID);
    expect(c.firstPrograms).toHaveLength(2);
  });
});
