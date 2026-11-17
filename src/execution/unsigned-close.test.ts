/**
 * R7-W5 unsigned-close.ts and the close profile of ext-verify.ts (design 5.4, 7.4 C1-C6): CloseAccount [9] to the owner under each account's own
 * program, nothing else. A scripted chain (the owner's token accounts as getTokenAccountsByOwner returns them, simulateTransaction with post
 * states); no signing; addresses derive at test time (A-20).
 */
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { buildCloseAccountInstruction } from './close-ix';
import { computeBudgetFeeLamports } from './compute-budget';
import { verifyCloseTx, type CloseExpectation, type CloseTarget } from './ext-verify';
import * as pumpfunIx from './pumpfun-ix';
import { selectCloseTargets, buildUnsignedClose, WALLET_CLOSE_BATCH_DEFAULT, WALLET_CLOSE_BATCH_HARD_MAX } from './unsigned-close';
import { compileWalletTx } from './unsigned-swap';
import { deriveAtaAddress, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, type OwnedTokenAccount } from './wallet-reads';
import type { WalletRpcPort } from './wallet-rpc';
import type { WalletCloseQuoteOk, WalletCloseQuoteRequest } from '../shared/contract/wallet-link';
import { validateWalletCloseQuoteResponse } from '../shared/contract/wallet-validate';

const fixtureKey = (i: number): string => bs58.encode(createHash('sha256').update('ps-fixture-' + i).digest());
const pk = (s: string): PublicKey => new PublicKey(s);
const OWNER = fixtureKey(1);
const OTHER = fixtureKey(79);
const SYSTEM = SystemProgram.programId.toBase58();
const SOL = 1_000_000_000n;
const RENT = 2_039_280n;
const RENT_22 = 2_074_080n;
const WSOL_ATA = deriveAtaAddress(OWNER, WSOL_MINT, TOKEN_PROGRAM_ID);

interface Rec {
  account: string; mint: string; program: string; amount: string; lamports: bigint; state?: string; closeAuthority?: string; withheld?: number; delegate?: string; native?: boolean;
}
const empty = (i: number, program = TOKEN_PROGRAM_ID, over: Partial<Rec> = {}): Rec => ({ account: fixtureKey(200 + i), mint: fixtureKey(300 + i), program, amount: '0', lamports: program === TOKEN_PROGRAM_ID ? RENT : RENT_22, ...over });
const parsed = (r: Rec): unknown => ({
  pubkey: r.account,
  account: {
    lamports: Number(r.lamports), owner: r.program, executable: false, rentEpoch: 0, space: 165,
    data: { program: 'spl-token', space: 165, parsed: { type: 'account', info: {
      mint: r.mint, owner: OWNER, state: r.state ?? 'initialized', isNative: r.native ?? false, tokenAmount: { amount: r.amount, decimals: 6, uiAmount: 0, uiAmountString: '0' },
      ...(r.closeAuthority ? { closeAuthority: r.closeAuthority } : {}), ...(r.delegate ? { delegate: r.delegate } : {}),
      ...(r.withheld !== undefined ? { extensions: [{ extension: 'transferFeeAmount', state: { withheldAmount: r.withheld } }] } : {}),
    } } },
  },
});
const rawAccount = (r: Rec): unknown => {
  const d = Buffer.alloc(165);
  Buffer.from(bs58.decode(r.mint)).copy(d, 0); Buffer.from(bs58.decode(OWNER)).copy(d, 32); d.writeBigUInt64LE(BigInt(r.amount), 64); d[108] = r.state === 'frozen' ? 2 : 1;
  return { lamports: Number(r.lamports), owner: r.program, data: [d.toString('base64'), 'base64'], executable: false, rentEpoch: 0, space: 165 };
};

class CloseChain implements WalletRpcPort {
  records: Rec[] = [];
  balance = SOL;
  priority: number | Error = 60_000;
  units = 20_000;
  /** the error of the simulation with accounts, or a hook to change a post state */
  err: unknown = null;
  measureErr: unknown = null;
  tamper?: (addr: string, post: unknown) => unknown;
  ownerDeltaOverride: bigint | null = null;
  calls: Array<{ method: string; params: any[] }> = [];
  sims: Array<{ tx: VersionedTransaction; withAccounts: boolean }> = [];
  async call(method: string, params: unknown[]): Promise<any> {
    const p = params as any[];
    this.calls.push({ method, params: p });
    switch (method) {
      case 'getBalance': return { context: { slot: 100 }, value: Number(this.balance) };
      case 'getTokenAccountsByOwner': return { context: { slot: 99 }, value: this.records.filter((r) => r.program === p[1].programId).map(parsed) };
      case 'getLatestBlockhash': return { context: { slot: 100 }, value: { blockhash: fixtureKey(90), lastValidBlockHeight: 5 } };
      case 'getPriorityFeeEstimate': if (this.priority instanceof Error) throw this.priority; return { priorityFeeEstimate: this.priority };
      case 'getMultipleAccounts': return { context: { slot: 100 }, value: (p[0] as string[]).map((k) => (k === OWNER ? { lamports: Number(this.balance), owner: SYSTEM, data: ['', 'base64'], executable: false, rentEpoch: 0, space: 0 } : (() => { const r = this.records.find((x) => x.account === k); return r ? rawAccount(r) : null; })())) };
      case 'simulateTransaction': {
        const tx = VersionedTransaction.deserialize(Buffer.from(p[0], 'base64'));
        const addresses: string[] | undefined = p[1].accounts?.addresses;
        this.sims.push({ tx, withAccounts: addresses !== undefined });
        const err = addresses === undefined ? this.measureErr : this.err;
        if (addresses === undefined || err) return { context: { slot: 101 }, value: { err, logs: [], accounts: null, unitsConsumed: this.units } };
        const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
        const closing = new Set(this.records.filter((r) => keys.includes(r.account)).map((r) => r.account));
        const fee = computeBudgetFeeLamports(tx);
        const ownerDelta = this.ownerDeltaOverride ?? (this.records.filter((r) => closing.has(r.account)).reduce((s, r) => s + r.lamports, 0n) - 5_000n - (fee.ok ? fee.lamports : 0n));
        const accounts = addresses.map((a) => {
          let post: unknown;
          if (a === OWNER) post = { lamports: Number(this.balance + ownerDelta), owner: SYSTEM, data: ['', 'base64'], executable: false, rentEpoch: 0, space: 0 };
          else if (closing.has(a)) post = null;
          else { const r = this.records.find((x) => x.account === a); post = r ? rawAccount(r) : null; }
          return this.tamper ? this.tamper(a, post) : post;
        });
        return { context: { slot: 101 }, value: { err: null, logs: [], accounts, unitsConsumed: this.units } };
      }
      default: throw new Error(`unexpected ${method}`);
    }
  }
}
const deps = (chain: CloseChain, over: Record<string, unknown> = {}) => { let t = 9_000; return { rpc: chain, clock: { now: () => (t += 1) }, ...over }; };
const closeReq = (over: Partial<WalletCloseQuoteRequest> = {}): WalletCloseQuoteRequest => ({ owner: OWNER, kind: 'empty', excluded: [], ...over });
const okQuote = (r: unknown): WalletCloseQuoteOk['quote'] => {
  const x = r as WalletCloseQuoteOk;
  expect(x, JSON.stringify(r)).toMatchObject({ ok: true });
  const v = validateWalletCloseQuoteResponse(x, { maxTxBytes: 1100 });
  expect(v.ok && v.value.ok, JSON.stringify(v)).toBe(true);        // the Engine-side validator accepts it as well
  return x.quote;
};
const refusal = (r: unknown): { code: string; reason: string } => { const x = r as { ok: boolean }; expect(x.ok, JSON.stringify(r)).toBe(false); return r as never; };
const txOf = (q: { txBase64: string }): VersionedTransaction => VersionedTransaction.deserialize(Buffer.from(q.txBase64, 'base64'));
const instructionsOf = (tx: VersionedTransaction) => tx.message.compiledInstructions.map((ix) => ({
  program: tx.message.staticAccountKeys[ix.programIdIndex].toBase58(), data: Array.from(ix.data), accounts: ix.accountKeyIndexes.map((i) => tx.message.staticAccountKeys[i].toBase58()),
}));

describe('unsigned close', () => {
  it('WTX-T09 closes empty accounts with CloseAccount [9] to the owner under the right program; skips non-zero, frozen, withheld, foreign close authority, fresh-buy and excluded accounts; a full batch fits under the size cap; a close to a foreign destination and a close mixed with a trade are refused', async () => {
    const chain = new CloseChain();
    const classic = empty(1);
    const token22 = empty(2, TOKEN_2022_PROGRAM_ID);
    chain.records = [
      classic, token22,
      empty(3, TOKEN_PROGRAM_ID, { amount: '5' }),                                  // a balance
      empty(4, TOKEN_PROGRAM_ID, { state: 'frozen' }),                              // frozen
      empty(5, TOKEN_2022_PROGRAM_ID, { withheld: 12 }),                            // Token-2022 withheld transfer fees
      empty(6, TOKEN_PROGRAM_ID, { closeAuthority: OTHER }),                        // a close authority that is not the owner
      empty(7, TOKEN_PROGRAM_ID),                                                   // bought a moment ago
      empty(8, TOKEN_PROGRAM_ID),                                                   // on the Engine's excluded list
      empty(9, TOKEN_PROGRAM_ID, { closeAuthority: OWNER }),                        // the owner as close authority is fine
    ];
    const fresh = chain.records[6].mint;
    const q = okQuote(await buildUnsignedClose(deps(chain, { freshBuy: (m: string) => m === fresh }), closeReq({ excluded: [chain.records[7].account] })));

    // the accounts, in the order the wallet read them (Token accounts, then Token-2022), each with its own program and the lamports a close returns
    expect(q.kind).toBe('empty');
    expect(q.accounts).toEqual([
      { account: classic.account, mint: classic.mint, program: 'token', rentLamports: RENT.toString() },
      { account: chain.records[8].account, mint: chain.records[8].mint, program: 'token', rentLamports: RENT.toString() },
      { account: token22.account, mint: token22.mint, program: 'token-2022', rentLamports: RENT_22.toString() },
    ]);
    expect(q.returnedLamports).toBe((RENT + RENT_22 + RENT).toString());
    expect(q.wsolAmount).toBeNull();
    expect(q.remainingAccounts).toBe(0);
    // what was skipped and why (a non-empty account is not listed in discovery: it is simply not a candidate)
    expect(q.excluded).toEqual([
      { account: chain.records[3].account, reason: 'frozen' },
      { account: chain.records[5].account, reason: 'close-authority' },
      { account: chain.records[6].account, reason: 'recent-buy' },
      { account: chain.records[7].account, reason: 'engine-excluded' },
      { account: chain.records[4].account, reason: 'withheld-fees' },
    ]);
    // the bytes: the compute-budget pair and one CloseAccount [9] per account, destination and authority the owner, under that account's own program
    const tx = txOf(q);
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(tx.message.staticAccountKeys[0].toBase58()).toBe(OWNER);
    expect(tx.signatures[0].every((b) => b === 0)).toBe(true);
    const ixs = instructionsOf(tx);
    const cb = ComputeBudgetProgram.programId.toBase58();
    expect(ixs.map((i) => i.program)).toEqual([cb, cb, TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);
    expect(ixs.slice(2).map((i) => i.data)).toEqual([[9], [9], [9]]);
    expect(ixs.slice(2).map((i) => i.accounts)).toEqual([[classic.account, OWNER, OWNER], [chain.records[8].account, OWNER, OWNER], [token22.account, OWNER, OWNER]]);
    expect(q.programs).toEqual([cb, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);
    // fees: network + the priority fee (limit = ceil(units x 1.2), price clamped), nothing else leaves the wallet
    expect(q.priorityFee).toEqual({ cuLimit: 24_000, cuPriceMicrolamports: 60_000, lamports: '1440' });
    expect(q.networkFeeLamports).toBe('5000');
    expect(q.maxOutflowLamports).toBe('6440');
    expect(q.simulatedDeltas.sol).toEqual({ baseUnits: (RENT + RENT_22 + RENT - 6_440n).toString(), decimals: 9, asset: 'SOL' });
    expect(chain.sims.map((s) => s.withAccounts)).toEqual([false, true]);
    // the reads are at confirmed
    expect(chain.calls.filter((c) => c.method === 'getTokenAccountsByOwner').map((c) => c.params[2].commitment)).toEqual(['confirmed', 'confirmed']);

    // a request lists the accounts it wants: every answer is explicit (not found, balance, ...)
    const picked = okQuote(await buildUnsignedClose(deps(chain), closeReq({ accounts: [classic.account, chain.records[2].account, fixtureKey(999)] })));
    expect(picked.accounts.map((a) => a.account)).toEqual([classic.account]);
    expect(picked.excluded).toEqual([{ account: chain.records[2].account, reason: 'has-balance' }, { account: fixtureKey(999), reason: 'not-found' }]);

    // the batch: the tested maximum is 10, ten closes plus the compute-budget pair serialize far below WALLET_TX_MAX_BYTES (1100)
    expect(WALLET_CLOSE_BATCH_DEFAULT).toBe(10);
    expect(WALLET_CLOSE_BATCH_HARD_MAX).toBe(10);
    const big = new CloseChain();
    big.records = Array.from({ length: 13 }, (_, i) => empty(20 + i, i % 2 === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID));
    const full = okQuote(await buildUnsignedClose(deps(big), closeReq()));
    expect(full.accounts.length).toBe(10);
    expect(full.remainingAccounts).toBe(3);
    expect(full.txBytes).toBeLessThanOrEqual(1100);
    expect(full.txBytes).toBe(Buffer.from(full.txBase64, 'base64').length);
    // a smaller batch is configurable, never a bigger one
    expect(okQuote(await buildUnsignedClose(deps(big, { batchMax: 4 }), closeReq())).accounts.length).toBe(4);
    expect(okQuote(await buildUnsignedClose(deps(big, { batchMax: 99 }), closeReq())).accounts.length).toBe(10);
    expect(refusal(await buildUnsignedClose(deps(big), closeReq({ accounts: Array.from({ length: 11 }, (_, i) => fixtureKey(220 + i)) }))).code).toBe('bad-request');
    // the batch asked for by account is under the cap; a size cap lower than the transaction is tx-too-large
    expect(refusal(await buildUnsignedClose(deps(big, { maxTxBytes: 200 }), closeReq())).code).toBe('tx-too-large');

    // nothing to close
    const none = new CloseChain();
    none.records = [empty(40, TOKEN_PROGRAM_ID, { amount: '1' })];
    expect(refusal(await buildUnsignedClose(deps(none), closeReq())).code).toBe('nothing-to-close');
    expect(refusal(await buildUnsignedClose(deps(new CloseChain()), closeReq({ kind: 'unwrap' }))).code).toBe('nothing-to-close');

    // C1-C6 over the bytes: a close to a foreign destination, a close mixed with a trade instruction, and the rest of the profile
    const target = (r: Rec, over: Partial<CloseTarget> = {}): CloseTarget => ({
      account: r.account, mint: r.mint, program: r.program, tokenOwner: OWNER, amountRaw: BigInt(r.amount), lamports: r.lamports, frozen: false, closeAuthority: null, withheldFee: 0n, ...over,
    });
    const make = (): { chain: CloseChain; ixs: TransactionInstruction[]; exp: CloseExpectation } => {
      const c = new CloseChain();
      c.records = [empty(60), empty(61, TOKEN_2022_PROGRAM_ID)];
      const closeIxs = c.records.map((r) => buildCloseAccountInstruction(r.program, r.account, pk(OWNER)));
      return {
        chain: c, ixs: closeIxs,
        exp: {
          kind: 'empty', owner: OWNER, accounts: c.records.map((r) => target(r)), excluded: new Set(), cuLimit: 24_000, cuPriceMicrolamports: 60_000, priorityFeeLamports: 1_440n,
          networkFeeLamports: 5_000n, maxOutflowLamports: 6_440n, balanceLamports: SOL,
        },
      };
    };
    const verify = async (k: ReturnType<typeof make>, edit?: (ixs: TransactionInstruction[]) => void): Promise<any> => {
      if (edit) edit(k.ixs);
      const bytes = compileWalletTx(pk(OWNER), fixtureKey(90), k.ixs, 24_000, 60_000).serialize();
      return verifyCloseTx({ rpc: k.chain, priorityRange: { minPrice: 10_000, maxPrice: 1_000_000 }, maxTxBytes: 1100 }, bytes, k.exp);
    };
    const reason = async (k: ReturnType<typeof make>, edit?: (ixs: TransactionInstruction[]) => void): Promise<string> => {
      const r = await verify(k, edit);
      expect(r.ok, 'must be refused').toBe(false);
      return `${r.code}: ${r.reason}`;
    };
    const control = make();
    expect(await verify(control)).toMatchObject({ ok: true, value: { returnedLamports: RENT + RENT_22 } });
    const closeTo = (r: Rec, dest: string, authority = OWNER): TransactionInstruction => new TransactionInstruction({
      programId: pk(r.program), data: Buffer.from([9]),
      keys: [{ pubkey: pk(r.account), isSigner: false, isWritable: true }, { pubkey: pk(dest), isSigner: false, isWritable: true }, { pubkey: pk(authority), isSigner: authority === OWNER, isWritable: false }],
    });
    // a foreign destination
    let k = make();
    expect(await reason(k, (ixs) => { ixs[0] = closeTo(k.chain.records[0], OTHER); })).toMatch(/destination or authority is not the owner/);
    // a foreign authority is a second signer, refused before anything else
    k = make();
    expect(await reason(k, (ixs) => { ixs[0] = closeTo(k.chain.records[0], OWNER, OTHER); })).toMatch(/extra signer|destination or authority/);
    // a close mixed with a trade instruction, a transfer, an Approve, a system instruction
    k = make();
    expect(await reason(k, (ixs) => { ixs.push(pumpfunIx.buildSellInstruction(pk(OWNER), pk(fixtureKey(31)), pk(fixtureKey(3)), 1n, 1n, false, pk(TOKEN_PROGRAM_ID), pumpfunIx.pickPumpFeeAccounts(false, () => 0))); })).toMatch(/program not allowed in a close/);
    k = make();
    expect(await reason(k, (ixs) => { ixs.push(SystemProgram.transfer({ fromPubkey: pk(OWNER), toPubkey: pk(OTHER), lamports: 1n })); })).toMatch(/program not allowed in a close: 1111/);
    k = make();
    expect(await reason(k, (ixs) => { ixs.push(new TransactionInstruction({ programId: pk(TOKEN_PROGRAM_ID), data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]), keys: [{ pubkey: pk(k.chain.records[0].account), isSigner: false, isWritable: true }, { pubkey: pk(OTHER), isSigner: false, isWritable: true }, { pubkey: pk(OWNER), isSigner: true, isWritable: false }] })); })).toMatch(/token instruction not allowed in a close: Transfer/);
    k = make();
    expect(await reason(k, (ixs) => { ixs.push(new TransactionInstruction({ programId: pk(TOKEN_PROGRAM_ID), data: Buffer.from([4, 1, 0, 0, 0, 0, 0, 0, 0]), keys: [{ pubkey: pk(k.chain.records[0].account), isSigner: false, isWritable: true }, { pubkey: pk(OTHER), isSigner: false, isWritable: false }, { pubkey: pk(OWNER), isSigner: true, isWritable: false }] })); })).toMatch(/token instruction not allowed in a close: Approve/);
    // an account that is not in the requested list, the same account twice, a missing one, the wrong program
    k = make();
    const stranger = empty(62);
    k.chain.records.push(stranger);
    expect(await reason(k, (ixs) => { ixs.push(buildCloseAccountInstruction(stranger.program, stranger.account, pk(OWNER))); })).toMatch(/not in the requested list/);
    k = make();
    expect(await reason(k, (ixs) => { ixs.push(ixs[0]); })).toMatch(/closed twice/);
    k = make();
    expect(await reason(k, (ixs) => { ixs.pop(); })).toMatch(/does not close exactly the requested accounts/);
    k = make();
    expect(await reason(k, (ixs) => { ixs[1] = buildCloseAccountInstruction(TOKEN_PROGRAM_ID, k.chain.records[1].account, pk(OWNER)); })).toMatch(/under a program other than the account own/);
    // C3: the build's own read of each account
    for (const [name, over, why] of [
      ['not owned by the owner', { tokenOwner: OTHER }, /not owned by the owner/], ['not empty', { amountRaw: 1n }, /not empty/], ['frozen', { frozen: true }, /frozen/],
      ['foreign close authority', { closeAuthority: OTHER }, /close authority other than the owner/], ['withheld fees', { withheldFee: 1n }, /withheld transfer fees/],
    ] as const) {
      k = make();
      k.exp.accounts = [target(k.chain.records[0], over), target(k.chain.records[1])];
      expect(await reason(k), name).toMatch(why);
    }
    k = make();
    k.exp.excluded = new Set([k.chain.records[0].account]);
    expect(await reason(k)).toMatch(/excluded list/);
    // C5: the simulation shows exactly the returned lamports minus the fees, and nothing else changes
    k = make();
    k.chain.ownerDeltaOverride = RENT + RENT_22 - 6_440n + 1n;
    expect(await reason(k)).toMatch(/simulated change of the wallet/);
    k = make();
    k.chain.ownerDeltaOverride = RENT + RENT_22 - 6_440n - 1n;
    expect(await reason(k)).toMatch(/simulated change of the wallet/);
    k = make();
    k.chain.tamper = (a, post) => (a === k.chain.records[0].account ? rawAccount(k.chain.records[0]) : post);       // the account is still open after the simulation
    expect(await reason(k)).toMatch(/still open/);
    // an account being closed that changed between the read and the simulation
    k = make();
    k.chain.records[0].lamports += 1n;
    expect(await reason(k)).toMatch(/changed between the read and the simulation|simulated change/);
    // C6: the balance for the fees, the size cap, the bytes' fee line
    k = make();
    k.exp.balanceLamports = 6_439n;
    expect(await reason(k)).toMatch(/insufficient-sol/);
    k = make();
    k.exp.priorityFeeLamports = 1_441n;
    expect(await reason(k)).toMatch(/differs from the disclosed priority-fee line/);
    k = make();
    k.exp.maxOutflowLamports = 6_441n;
    expect(await reason(k)).toMatch(/disclosed outflow lines differ/);

    // unwrap: the owner's wrapped-SOL account, the wrapped amount returned with its rent
    const wrap = new CloseChain();
    wrap.records = [{ account: WSOL_ATA, mint: WSOL_MINT, program: TOKEN_PROGRAM_ID, amount: '250000000', lamports: 250_000_000n + RENT, native: true }, empty(70)];
    const u = okQuote(await buildUnsignedClose(deps(wrap), closeReq({ kind: 'unwrap' })));
    expect(u.kind).toBe('unwrap');
    expect(u.accounts).toEqual([{ account: WSOL_ATA, mint: WSOL_MINT, program: 'token', rentLamports: (250_000_000n + RENT).toString() }]);
    expect(u.wsolAmount).toBe('250000000');
    expect(u.returnedLamports).toBe((250_000_000n + RENT).toString());
    expect(instructionsOf(txOf(u)).slice(2)).toEqual([{ program: TOKEN_PROGRAM_ID, data: [9], accounts: [WSOL_ATA, OWNER, OWNER] }]);
    // an unwrap takes no account list, and a protected wSOL account is not unwrapped
    expect(refusal(await buildUnsignedClose(deps(wrap), closeReq({ kind: 'unwrap', accounts: [WSOL_ATA] }))).code).toBe('bad-request');
    expect(refusal(await buildUnsignedClose(deps(wrap), closeReq({ kind: 'unwrap', excluded: [WSOL_ATA] }))).code).toBe('nothing-to-close');
    // an unwrap closes only the wrapped-SOL account
    k = make();
    k.exp.kind = 'unwrap';
    expect(await reason(k)).toMatch(/unwrap closes the owner wrapped-SOL account and nothing else/);

    // failures: a simulation that fails, a balance below the fees, an unreadable balance
    const failing = new CloseChain();
    failing.records = [empty(80)];
    failing.err = { InstructionError: [2, { Custom: 3 }] };
    expect(refusal(await buildUnsignedClose(deps(failing), closeReq())).code).toBe('simulation-failed');
    const poor = new CloseChain();
    poor.records = [empty(81)];
    poor.balance = 100n;
    poor.measureErr = 'InsufficientFundsForFee';
    expect(refusal(await buildUnsignedClose(deps(poor), closeReq()))).toMatchObject({ code: 'insufficient-sol', haveLamports: '100' });
    const sound = new CloseChain();
    sound.records = [empty(82)];
    sound.balance = 6_000n;
    expect(refusal(await buildUnsignedClose(deps(sound), closeReq()))).toMatchObject({ code: 'insufficient-sol', needLamports: '6440', haveLamports: '6000' });
    const blind = new CloseChain();
    blind.call = async () => { throw new Error('rpc down'); };
    expect(refusal(await buildUnsignedClose(deps(blind), closeReq())).code).toBe('build-failed');
    // bad requests
    for (const bad of [{ owner: 'nope' }, { kind: 'burn' as never }, { excluded: ['nope'] }, { accounts: [] }, { accounts: [WSOL_ATA, WSOL_ATA] }]) {
      expect(refusal(await buildUnsignedClose(deps(new CloseChain()), closeReq(bad))).code, JSON.stringify(bad)).toBe('bad-request');
    }
  });

  it('selects targets by the build\'s own read, in the wallet\'s order, and never lists a non-empty account in discovery', () => {
    const owned: OwnedTokenAccount[] = [
      { account: 'a', mint: 'm1', program: 'token', amountRaw: '0', decimals: 6, lamports: '1', state: 'initialized', frozen: false, closeAuthority: null, delegate: null, isNative: false, withheldFee: '0' },
      { account: 'b', mint: 'm2', program: 'token', amountRaw: '4', decimals: 6, lamports: '1', state: 'initialized', frozen: false, closeAuthority: null, delegate: null, isNative: false, withheldFee: '0' },
      { account: 'c', mint: 'm3', program: 'token', amountRaw: '0', decimals: 6, lamports: '1', state: 'uninitialized', frozen: null, closeAuthority: null, delegate: null, isNative: false, withheldFee: '0' },
    ];
    const s = selectCloseTargets('empty', OWNER, owned, undefined, new Set(), 10, () => false);
    expect(s.batch.map((x) => x.account)).toEqual(['a']);
    expect(s.excluded).toEqual([{ account: 'c', reason: 'frozen' }]);          // a state that is not 'initialized' is never closed
    expect(s.remaining).toBe(0);
    const s2 = selectCloseTargets('empty', OWNER, owned, ['b', 'a'], new Set(), 1, () => false);
    expect(s2.batch.map((x) => x.account)).toEqual(['a']);
    expect(s2.excluded).toEqual([{ account: 'b', reason: 'has-balance' }]);
  });
});
