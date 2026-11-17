/**
 * R7-W5 wallet-reads.ts: exact-string chain reads for a connected wallet and the fill reads that book what the chain says happened to an
 * EXTERNAL owner. A scripted RPC port and a fake clock: no network, no real time. Addresses derive at test time, signatures are generated at
 * runtime (A-20).
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { RpcBudgetError } from './rpc-budget';
import type { RpcTransactionView } from './tx-deltas';
import {
  ACCOUNT_STATE_FROZEN, customInstructionError, isSlippageError, MINT_ACCOUNT_TYPE_MINT, MINT_ACCOUNT_TYPE_OFFSET, MINT_EXT_DEFAULT_ACCOUNT_STATE, MINT_EXT_NON_TRANSFERABLE,
  MINT_EXT_TRANSFER_HOOK, parseChainAccount, parseMintExtensions, parseSplMint, parseSplTokenAccount, readAccounts, readOwnedTokenAccounts, readSolBalance, readWalletBalances,
  readWalletCloseFill, readWalletFill, SLIPPAGE_ERROR_CODES, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WALLET_FILL_POLL_MS_MIN,
} from './wallet-reads';
import { WalletRpcError, type WalletRpcPort, type WalletSleepClock } from './wallet-rpc';

const fixtureKey = (i: number): string => bs58.encode(createHash('sha256').update('ps-fixture-' + i).digest());
const newSig = (): string => bs58.encode(randomBytes(64));
const OWNER = fixtureKey(1);
const MINT = fixtureKey(2);
const TRADE_ATA = fixtureKey(3);
const CURVE = fixtureKey(5);
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SYSTEM = '11111111111111111111111111111111';
const U64_MAX = '18446744073709551615';

class FakeClock implements WalletSleepClock {
  t = 1_000_000;
  sleeps: number[] = [];
  now(): number { return this.t; }
  async sleep(ms: number): Promise<void> { this.sleeps.push(ms); this.t += ms; }
}
type Handler = (params: any[]) => any;
function port(handlers: Record<string, Handler>, log: Array<{ method: string; params: any[] }> = []): WalletRpcPort {
  return {
    async call(method: string, params: unknown[]): Promise<any> {
      log.push({ method, params: params as any[] });
      const h = handlers[method];
      if (!h) throw new Error(`unexpected ${method}`);
      return h(params as any[]);
    },
  };
}
const deps = (p: WalletRpcPort, clock = new FakeClock(), extra: { pollMs?: number; timeoutMs?: number } = {}) => ({ rpc: p, clock, ...extra });

// ── token accounts as getTokenAccountsByOwner (jsonParsed) returns them ──────────────────────────────────────────────────────────────
interface ParsedOpts { mint?: string; owner?: string; amount?: string; decimals?: number; state?: string; lamports?: number; closeAuthority?: string; withheld?: number; isNative?: boolean }
const parsedAccount = (pubkey: string, program: string, o: ParsedOpts = {}) => ({
  pubkey,
  account: {
    lamports: o.lamports ?? 2_039_280, owner: program, executable: false, rentEpoch: 0, space: 165,
    data: {
      program: program === TOKEN_PROGRAM_ID ? 'spl-token' : 'spl-token-2022', space: 165,
      parsed: {
        type: 'account',
        info: {
          mint: o.mint ?? MINT, owner: o.owner ?? OWNER, state: o.state ?? 'initialized', isNative: o.isNative ?? false,
          tokenAmount: { amount: o.amount ?? '1000', decimals: o.decimals ?? 6, uiAmount: 0, uiAmountString: '0' },
          ...(o.closeAuthority ? { closeAuthority: o.closeAuthority } : {}),
          ...(o.withheld !== undefined ? { extensions: [{ extension: 'transferFeeAmount', state: { withheldAmount: o.withheld } }] } : {}),
        },
      },
    },
  },
});

// ── transactions as getTransaction returns them (json, version 0) ────────────────────────────────────────────────────────────────────
interface ViewOpts {
  payer?: string; err?: unknown; fee?: number; tokenPost?: string; tokenPre?: string; ownerPre?: number | string; ownerPost?: number | string; slot?: number;
  failingProgramIx?: { index: number; programIndex: number };
  created?: boolean;
}
function txView(o: ViewOpts = {}): RpcTransactionView {
  const created = o.created ?? true;
  return {
    slot: o.slot ?? 4242, blockTime: 1_760_000_000,
    transaction: {
      message: {
        accountKeys: [o.payer ?? OWNER, TRADE_ATA, CURVE, PUMP, SYSTEM],
        header: { numRequiredSignatures: 1 },
        instructions: [{ programIdIndex: 4 }, { programIdIndex: 4 }, { programIdIndex: o.failingProgramIx?.programIndex ?? 3 }],
      },
    },
    meta: {
      err: o.err ?? null, fee: o.fee ?? 5_000,
      preBalances: [o.ownerPre ?? 5_000_000_000, created ? 0 : 2_039_280, 30_000_000_000, 1, 1],
      postBalances: [o.ownerPost ?? 4_947_955_720, 2_039_280, 30_050_000_000, 1, 1],
      preTokenBalances: [{ accountIndex: 2, mint: MINT, owner: CURVE, uiTokenAmount: { amount: '800000000000', decimals: 6 } },
        ...(created ? [] : [{ accountIndex: 1, mint: MINT, owner: OWNER, uiTokenAmount: { amount: o.tokenPre ?? '0', decimals: 6 } }])],
      postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: OWNER, uiTokenAmount: { amount: o.tokenPost ?? '1700000000', decimals: 6 } },
        { accountIndex: 2, mint: MINT, owner: CURVE, uiTokenAmount: { amount: '799998300000', decimals: 6 } }],
    },
  };
}

const fillReq = (sig: string, over: Partial<{ side: 'buy' | 'sell'; final: boolean; owner: string }> = {}) => ({
  owner: over.owner ?? OWNER, signature: sig, side: over.side ?? ('buy' as const), mint: MINT, quoteRef: 'q-1', submittedAt: 1_000_000, final: over.final ?? false,
});

describe('decoders', () => {
  it('reads the SPL token-account and mint layouts, and refuses short data', () => {
    const acct = Buffer.alloc(165);
    Buffer.from(bs58.decode(MINT)).copy(acct, 0);
    Buffer.from(bs58.decode(OWNER)).copy(acct, 32);
    acct.writeBigUInt64LE(18_446_744_073_709_551_615n, 64);
    acct.writeUInt32LE(1, 72); Buffer.from(bs58.decode(fixtureKey(9))).copy(acct, 76);   // a delegate
    acct[108] = 2;                                                                       // frozen
    acct.writeUInt32LE(1, 129); Buffer.from(bs58.decode(fixtureKey(8))).copy(acct, 133); // a close authority
    expect(parseSplTokenAccount(acct)).toEqual({
      mint: MINT, owner: OWNER, amount: 18_446_744_073_709_551_615n, delegate: fixtureKey(9), delegatedAmount: 0n, state: 2, isNative: false, closeAuthority: fixtureKey(8),
    });
    expect(parseSplTokenAccount(acct.subarray(0, 164))).toBeNull();
    const mint = Buffer.alloc(82);
    mint.writeBigUInt64LE(1_000_000_000_000_000n, 36); mint[44] = 6; mint[45] = 1;
    mint.writeUInt32LE(1, 46); Buffer.from(bs58.decode(fixtureKey(7))).copy(mint, 50);
    expect(parseSplMint(mint)).toEqual({ mintAuthority: null, supply: 1_000_000_000_000_000n, decimals: 6, isInitialized: true, freezeAuthority: fixtureKey(7) });
    expect(parseSplMint(mint.subarray(0, 81))).toBeNull();
    // chain accounts: null is a missing account, anything unreadable is undefined
    expect(parseChainAccount(null)).toBeNull();
    expect(parseChainAccount({ lamports: 5, owner: SYSTEM, data: ['', 'base64'] })).toEqual({ lamports: 5n, owner: SYSTEM, data: Buffer.alloc(0) });
    expect(parseChainAccount({ lamports: -1, owner: SYSTEM, data: ['', 'base64'] })).toBeUndefined();
    expect(parseChainAccount({ lamports: 5, owner: SYSTEM, data: 'raw' })).toBeUndefined();
    expect(parseChainAccount({ lamports: 5, owner: SYSTEM, data: ['!!', 'base64'] })).toBeUndefined();
  });
});

// ── Token-2022 mint extensions (A-117 c) ───────────────────────────────────────────────────────────────────────────────────────

/** A mint account's data as the chain stores it: the 82-byte base mint padded to 165 bytes, the account-type byte, then TLV entries (type u16, length u16, value). */
function mintData(entries: Array<{ type: number; value: Buffer }>, o: { accountType?: number; trailingZeros?: number; baseOnly?: boolean } = {}): Buffer {
  const base = Buffer.alloc(o.baseOnly ? 82 : 166);
  base.writeBigUInt64LE(1_000_000_000_000_000n, 36); base[44] = 6; base[45] = 1;
  if (o.baseOnly) return base;
  base[165] = o.accountType ?? 1;
  const tlv = entries.map((e) => { const h = Buffer.alloc(4); h.writeUInt16LE(e.type, 0); h.writeUInt16LE(e.value.length, 2); return Buffer.concat([h, e.value]); });
  return Buffer.concat([base, ...tlv, Buffer.alloc(o.trailingZeros ?? 0)]);
}
const hook = (authority: Uint8Array, program: Uint8Array): Buffer => Buffer.concat([Buffer.from(authority), Buffer.from(program)]);
const zeros = (n: number): Buffer => Buffer.alloc(n);
const NONE = { types: [] as number[], nonTransferable: false, defaultAccountStateFrozen: false, transferHookProgram: null };

describe('Token-2022 mint extensions', () => {
  it('RDQ-T07 parseMintExtensions reads a classic mint, a Token-2022 mint with and without extensions (NonTransferable, DefaultAccountState Frozen, TransferHook with a program) and refuses truncated or malformed data as unreadable', () => {
    // the numbers are the pinned fixture, and the layout constants equal it
    const pin = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'test-fixtures', 'execution', 'wallet', 'mint-extensions-pin.json'), 'utf8')) as {
      layout: { baseMintBytes: number; accountTypeOffset: number; accountTypeMint: number; tlvStart: number };
      extensions: Array<{ name: string; type: number; valueBytes: number; frozenState?: number }>;
    };
    expect([pin.layout.accountTypeOffset, pin.layout.accountTypeMint, pin.layout.tlvStart, pin.layout.baseMintBytes]).toEqual([MINT_ACCOUNT_TYPE_OFFSET, MINT_ACCOUNT_TYPE_MINT, MINT_ACCOUNT_TYPE_OFFSET + 1, 82]);
    const byName = Object.fromEntries(pin.extensions.map((e) => [e.name, e]));
    expect([byName.DefaultAccountState.type, byName.NonTransferable.type, byName.TransferHook.type]).toEqual([MINT_EXT_DEFAULT_ACCOUNT_STATE, MINT_EXT_NON_TRANSFERABLE, MINT_EXT_TRANSFER_HOOK]);
    expect([MINT_EXT_DEFAULT_ACCOUNT_STATE, MINT_EXT_NON_TRANSFERABLE, MINT_EXT_TRANSFER_HOOK]).toEqual([6, 9, 14]);
    expect([byName.DefaultAccountState.valueBytes, byName.NonTransferable.valueBytes, byName.TransferHook.valueBytes]).toEqual([1, 0, 64]);
    expect(byName.DefaultAccountState.frozenState).toBe(ACCOUNT_STATE_FROZEN);
    expect(ACCOUNT_STATE_FROZEN).toBe(2);

    // a classic Token mint (exactly the 82-byte base mint) and a Token-2022 mint with no extension have none; so has one that only holds the account type
    expect(parseMintExtensions(mintData([], { baseOnly: true }))).toEqual(NONE);
    expect(parseMintExtensions(mintData([]))).toEqual(NONE);
    expect(parseMintExtensions(mintData([], { trailingZeros: 40 }))).toEqual(NONE);

    // NonTransferable (9, no value)
    expect(parseMintExtensions(mintData([{ type: MINT_EXT_NON_TRANSFERABLE, value: zeros(0) }]))).toEqual({ ...NONE, types: [9], nonTransferable: true });
    // DefaultAccountState (6, one byte): only Frozen (2) counts; Uninitialized (0) and Initialized (1) do not
    expect(parseMintExtensions(mintData([{ type: MINT_EXT_DEFAULT_ACCOUNT_STATE, value: Buffer.from([2]) }]))).toEqual({ ...NONE, types: [6], defaultAccountStateFrozen: true });
    expect(parseMintExtensions(mintData([{ type: MINT_EXT_DEFAULT_ACCOUNT_STATE, value: Buffer.from([1]) }]))).toEqual({ ...NONE, types: [6] });
    expect(parseMintExtensions(mintData([{ type: MINT_EXT_DEFAULT_ACCOUNT_STATE, value: Buffer.from([0]) }]))).toEqual({ ...NONE, types: [6] });
    // TransferHook (14, authority then program id): a non-zero program id is reported in base58; an all-zero id is "no hook", whoever the authority is
    const program = bs58.decode(fixtureKey(61));
    const authority = bs58.decode(fixtureKey(62));
    expect(parseMintExtensions(mintData([{ type: MINT_EXT_TRANSFER_HOOK, value: hook(authority, program) }]))).toEqual({ ...NONE, types: [14], transferHookProgram: fixtureKey(61) });
    expect(parseMintExtensions(mintData([{ type: MINT_EXT_TRANSFER_HOOK, value: hook(zeros(32), program) }]))?.transferHookProgram).toBe(fixtureKey(61));
    expect(parseMintExtensions(mintData([{ type: MINT_EXT_TRANSFER_HOOK, value: hook(authority, zeros(32)) }]))).toEqual({ ...NONE, types: [14] });
    expect(parseMintExtensions(mintData([{ type: MINT_EXT_TRANSFER_HOOK, value: zeros(64) }]))).toEqual({ ...NONE, types: [14] });
    // a hook program whose id starts with zero bytes is still non-zero
    const lowProgram = Buffer.alloc(32); lowProgram[31] = 1;
    expect(parseMintExtensions(mintData([{ type: MINT_EXT_TRANSFER_HOOK, value: hook(zeros(32), lowProgram) }]))?.transferHookProgram).toBe(bs58.encode(lowProgram));

    // several extensions in stored order, other extensions (types this check does not act on) are listed and change nothing, and zero padding ends the list
    const many = mintData([
      { type: 18, value: zeros(64) }, { type: MINT_EXT_NON_TRANSFERABLE, value: zeros(0) }, { type: 3, value: Buffer.alloc(32, 7) },
      { type: MINT_EXT_DEFAULT_ACCOUNT_STATE, value: Buffer.from([2]) }, { type: MINT_EXT_TRANSFER_HOOK, value: hook(authority, program) },
    ], { trailingZeros: 25 });
    expect(parseMintExtensions(many)).toEqual({ types: [18, 9, 3, 6, 14], nonTransferable: true, defaultAccountStateFrozen: true, transferHookProgram: fixtureKey(61) });
    const harmless = mintData([{ type: 18, value: Buffer.alloc(64, 1) }, { type: 3, value: Buffer.alloc(32, 7) }, { type: 1, value: Buffer.alloc(108, 2) }], { trailingZeros: 5 });
    expect(parseMintExtensions(harmless)).toEqual({ ...NONE, types: [18, 3, 1] });
    // entries after a zero type are padding, not entries
    const afterEnd = Buffer.concat([mintData([{ type: MINT_EXT_NON_TRANSFERABLE, value: zeros(0) }]), Buffer.alloc(4), Buffer.from([9, 0, 0, 0])]);
    expect(parseMintExtensions(afterEnd)).toEqual({ ...NONE, types: [9], nonTransferable: true });

    // the data may be a view into a larger buffer, and the input is never changed
    const inner = mintData([{ type: MINT_EXT_NON_TRANSFERABLE, value: zeros(0) }]);
    const framed = Buffer.concat([Buffer.alloc(7, 0xff), inner, Buffer.alloc(3, 0xff)]).subarray(7, 7 + inner.length);
    const copy = Buffer.from(framed);
    expect(parseMintExtensions(framed)?.nonTransferable).toBe(true);
    expect(framed.equals(copy)).toBe(true);
    expect(parseMintExtensions(new Uint8Array(inner))?.nonTransferable).toBe(true);

    // unreadable data is null, never "no extensions": shorter than a base mint, between the base mint and the account type, a type other than Mint,
    // a cut-off entry (one byte of a type, a type with part of a length, a value that runs past the end) and a known extension of the wrong size
    expect(parseMintExtensions(new Uint8Array(0))).toBeNull();
    expect(parseMintExtensions(mintData([], { baseOnly: true }).subarray(0, 81))).toBeNull();
    for (const n of [83, 100, 164, 165]) expect(parseMintExtensions(Buffer.alloc(n)), `length ${n}`).toBeNull();
    for (const t of [0, 2, 3, 255]) expect(parseMintExtensions(mintData([], { accountType: t })), `account type ${t}`).toBeNull();
    const good = mintData([{ type: MINT_EXT_NON_TRANSFERABLE, value: zeros(0) }, { type: 18, value: zeros(64) }]);
    for (const cut of [1, 2, 3, 4, 6, 20, 67]) expect(parseMintExtensions(good.subarray(0, good.length - cut)), `cut by ${cut}`).toBeNull();
    expect(parseMintExtensions(Buffer.concat([mintData([]), Buffer.from([9])]))).toBeNull();                                  // one byte: not a whole type
    expect(parseMintExtensions(Buffer.concat([mintData([]), Buffer.from([9, 0, 0])]))).toBeNull();                            // a type and half a length
    expect(parseMintExtensions(Buffer.concat([mintData([]), Buffer.from([18, 0, 64, 0]), zeros(10)]))).toBeNull();            // a 64-byte value with 10 bytes left
    expect(parseMintExtensions(mintData([{ type: MINT_EXT_NON_TRANSFERABLE, value: zeros(1) }]))).toBeNull();
    expect(parseMintExtensions(mintData([{ type: MINT_EXT_DEFAULT_ACCOUNT_STATE, value: zeros(0) }]))).toBeNull();
    expect(parseMintExtensions(mintData([{ type: MINT_EXT_DEFAULT_ACCOUNT_STATE, value: Buffer.from([2, 0]) }]))).toBeNull();
    expect(parseMintExtensions(mintData([{ type: MINT_EXT_TRANSFER_HOOK, value: zeros(32) }]))).toBeNull();
    expect(parseMintExtensions(mintData([{ type: MINT_EXT_TRANSFER_HOOK, value: zeros(65) }]))).toBeNull();
    // a bad entry after good ones makes the whole list unreadable (a refusal must not depend on the order)
    expect(parseMintExtensions(mintData([{ type: MINT_EXT_NON_TRANSFERABLE, value: zeros(0) }, { type: MINT_EXT_TRANSFER_HOOK, value: zeros(10) }]))).toBeNull();
  });
});

describe('balances and exact strings', () => {
  it('WTX-T10 returns exact strings and a refusal with a reason on failure, never 0', async () => {
    const log: Array<{ method: string; params: any[] }> = [];
    const clock = new FakeClock();
    const p = port({
      getBalance: () => ({ context: { slot: 500 }, value: 1_234_567_890 }),
      getTokenAccountsByOwner: (params) => (params[1].programId === TOKEN_PROGRAM_ID
        ? { context: { slot: 499 }, value: [parsedAccount(TRADE_ATA, TOKEN_PROGRAM_ID, { amount: U64_MAX, state: 'frozen' }), parsedAccount(CURVE, TOKEN_PROGRAM_ID, { amount: '0', mint: fixtureKey(40), decimals: 9, lamports: 2_039_280 })] }
        : { context: { slot: 501 }, value: [parsedAccount(fixtureKey(6), TOKEN_2022_PROGRAM_ID, { amount: '5', state: 'uninitialized' })] }),
    }, log);
    const ok = await readWalletBalances(deps(p, clock), { owner: OWNER });
    expect(ok).toEqual({
      ok: true,
      balances: {
        solLamports: '1234567890', readAt: clock.t, slot: 499,                                             // the lowest slot of the reads
        tokens: [
          { account: TRADE_ATA, mint: MINT, program: 'token', amountRaw: U64_MAX, decimals: 6, rentLamports: '2039280', frozen: true },
          { account: CURVE, mint: fixtureKey(40), program: 'token', amountRaw: '0', decimals: 9, rentLamports: '2039280', frozen: false },
          { account: fixtureKey(6), mint: MINT, program: 'token-2022', amountRaw: '5', decimals: 6, rentLamports: '2039280', frozen: null },
        ],
      },
    });
    // both token programs, at commitment confirmed (the port forces it; the calls also ask for it)
    expect(log.filter((l) => l.method === 'getTokenAccountsByOwner').map((l) => [l.params[1].programId, l.params[2].commitment, l.params[2].encoding])).toEqual([
      [TOKEN_PROGRAM_ID, 'confirmed', 'jsonParsed'], [TOKEN_2022_PROGRAM_ID, 'confirmed', 'jsonParsed'],
    ]);
    expect(log.find((l) => l.method === 'getBalance')!.params[1]).toEqual({ commitment: 'confirmed' });

    // a failed read is a refusal, never an answer that holds a 0 or an empty list
    const down = await readWalletBalances(deps(port({ getBalance: () => { throw new WalletRpcError('http', 'wallet RPC getBalance: HTTP 503'); }, getTokenAccountsByOwner: () => ({ context: { slot: 1 }, value: [] }) })), { owner: OWNER });
    expect(down).toMatchObject({ ok: false, code: 'build-failed', reason: expect.stringContaining('503') });
    expect(JSON.stringify(down)).not.toContain('"solLamports"');
    const malformed = [
      { context: { slot: 1 }, value: [parsedAccount(TRADE_ATA, TOKEN_PROGRAM_ID, { amount: '1.5' })] },        // not an integer string
      { context: { slot: 1 }, value: [parsedAccount(TRADE_ATA, TOKEN_PROGRAM_ID, { owner: fixtureKey(99) })] },  // another owner's account
      { context: { slot: 1 }, value: [parsedAccount(TRADE_ATA, TOKEN_PROGRAM_ID), parsedAccount(TRADE_ATA, TOKEN_PROGRAM_ID)] },   // listed twice
      { context: { slot: 1 }, value: [parsedAccount(TRADE_ATA, TOKEN_PROGRAM_ID, { decimals: 19 })] },
      { value: [] },                                                                                            // no slot
      { context: { slot: 1 } },                                                                                 // no list
    ];
    for (const m of malformed) {
      const r = await readWalletBalances(deps(port({ getBalance: () => ({ context: { slot: 5 }, value: 7 }), getTokenAccountsByOwner: (params) => (params[1].programId === TOKEN_PROGRAM_ID ? m : { context: { slot: 1 }, value: [] }) })), { owner: OWNER });
      expect(r).toMatchObject({ ok: false, code: 'build-failed' });
    }
    // the budget stops a read with its own code; a timeout is a timeout
    const budget = await readWalletBalances(deps(port({ getBalance: () => { throw new RpcBudgetError('daily'); }, getTokenAccountsByOwner: () => ({ context: { slot: 1 }, value: [] }) })), { owner: OWNER });
    expect(budget).toMatchObject({ ok: false, code: 'rpc-budget' });
    const slow = await readWalletBalances(deps(port({ getBalance: () => { throw new WalletRpcError('timeout', 'wallet RPC getBalance: timed out'); }, getTokenAccountsByOwner: () => ({ context: { slot: 1 }, value: [] }) })), { owner: OWNER });
    expect(slow).toMatchObject({ ok: false, code: 'build-timeout' });

    // the single reads throw instead of returning a zero
    await expect(readSolBalance(port({ getBalance: () => ({ value: 5 }) }), OWNER)).rejects.toThrow(/malformed/);
    await expect(readSolBalance(port({ getBalance: () => ({ context: { slot: 1 }, value: 'x' }) }), OWNER)).rejects.toThrow(/malformed/);
    await expect(readAccounts(port({ getMultipleAccounts: () => ({ context: { slot: 1 }, value: [null] }) }), [OWNER, MINT])).rejects.toThrow(/malformed/);
    await expect(readOwnedTokenAccounts(port({ getTokenAccountsByOwner: () => ({ value: [] }) }), OWNER)).rejects.toThrow(/malformed/);
    expect(await readAccounts(port({ getMultipleAccounts: () => ({ context: { slot: 9 }, value: [null, { lamports: 7, owner: SYSTEM, data: ['', 'base64'] }] }) }), [OWNER, MINT])).toEqual({ accounts: [null, { lamports: 7n, owner: SYSTEM, data: Buffer.alloc(0) }], slot: 9 });
  });
});

describe('fills for an external owner', () => {
  it('WTX-T12 payer other than the owner is rejected-not-owner; meta.err is failed with the fee (price-moved for a pinned code); unreadable is unverified; rent is split out; final with nothing is not-landed', async () => {
    const sig = newSig();
    const none = { solDeltaLamports: null, feeLamports: null, rentPaidLamports: null, tokenDeltaRaw: null, decimals: null, slot: null, blockTime: null };
    const viewPort = (v: RpcTransactionView | null, statuses?: unknown) => port({ getTransaction: () => v, getSignatureStatuses: () => ({ value: [statuses ?? null] }) });

    // confirmed: exact values from the meta only, the rent of the created account split out
    const ok = await readWalletFill(deps(viewPort(txView())), fillReq(sig));
    expect(ok).toEqual({ ok: true, fill: { status: 'confirmed', reason: null, solDeltaLamports: '-52044280', feeLamports: '5000', rentPaidLamports: '2039280', tokenDeltaRaw: '1700000000', decimals: 6, slot: 4242, blockTime: 1_760_000_000_000 } });

    // somebody else paid: nothing is booked, the row never counts for anything
    const notOwner = await readWalletFill(deps(viewPort(txView({ payer: fixtureKey(77) }))), fillReq(sig));
    expect(notOwner).toEqual({ ok: true, fill: { status: 'rejected-not-owner', reason: 'fee-payer-is-not-owner', ...none } });

    // meta.err: failed, the fee paid is booked; a pinned slippage error of the failing program says price-moved, any other the generic reason
    const priceMoved = await readWalletFill(deps(viewPort(txView({ err: { InstructionError: [2, { Custom: 6002 }] } }))), fillReq(sig));
    expect(priceMoved).toMatchObject({ ok: true, fill: { status: 'failed', reason: 'price-moved', feeLamports: '5000', tokenDeltaRaw: null, rentPaidLamports: null, slot: 4242 } });
    const jupiterMoved = await readWalletFill(deps(viewPort(txView({ err: { InstructionError: [2, { Custom: 6001 }] }, failingProgramIx: { index: 2, programIndex: 3 } }))), fillReq(sig));
    expect(jupiterMoved).toMatchObject({ fill: { status: 'failed', reason: 'failed-on-chain' } });                // 6001 is Jupiter's code, but instruction 2 ran the pump program: no match
    const unknownCode = await readWalletFill(deps(viewPort(txView({ err: { InstructionError: [2, { Custom: 6999 }] } }))), fillReq(sig));
    expect(unknownCode).toMatchObject({ fill: { status: 'failed', reason: 'failed-on-chain', feeLamports: '5000' } });
    const insufficient = await readWalletFill(deps(viewPort(txView({ err: 'InsufficientFundsForFee' }))), fillReq(sig));
    expect(insufficient).toMatchObject({ fill: { status: 'failed', reason: 'failed-on-chain' } });

    // unreadable within 60 s: unverified (the poll runs on the fake clock; the interval is never below 1500 ms)
    const clock = new FakeClock();
    const log: Array<{ method: string; params: any[] }> = [];
    const blind = await readWalletFill(deps(port({ getTransaction: () => null }, log), clock, { pollMs: 10 }), fillReq(sig));
    expect(blind).toEqual({ ok: true, fill: { status: 'unverified', reason: 'meta-unreadable', ...none } });
    expect(clock.t - 1_000_000).toBe(60_000);
    expect(Math.min(...clock.sleeps)).toBeGreaterThanOrEqual(WALLET_FILL_POLL_MS_MIN);
    expect(log.every((l) => l.method === 'getTransaction' && l.params[1].commitment === 'confirmed' && l.params[1].maxSupportedTransactionVersion === 0)).toBe(true);
    // a transaction that appears later is read on a later poll
    let n = 0;
    const late = await readWalletFill(deps(port({ getTransaction: () => (++n < 3 ? null : txView()) }), new FakeClock()), fillReq(sig));
    expect(late).toMatchObject({ fill: { status: 'confirmed' } });
    expect(n).toBe(3);
    // an RPC error counts as "not readable yet"; the budget's refusal stops the poll
    let m = 0;
    const flaky = await readWalletFill(deps(port({ getTransaction: () => { if (++m < 2) throw new WalletRpcError('http', 'HTTP 502'); return txView(); } }), new FakeClock()), fillReq(sig));
    expect(flaky).toMatchObject({ fill: { status: 'confirmed' } });
    const stopped = await readWalletFill(deps(port({ getTransaction: () => { throw new RpcBudgetError('daily'); } }), new FakeClock()), fillReq(sig));
    expect(stopped).toMatchObject({ ok: false, code: 'rpc-budget' });

    // final: one look, then the signature status decides
    const gone = await readWalletFill(deps(viewPort(null, null), new FakeClock()), fillReq(sig, { final: true }));
    expect(gone).toEqual({ ok: true, fill: { status: 'not-landed', reason: null, ...none } });
    const finalClock = new FakeClock();
    await readWalletFill(deps(viewPort(null, null), finalClock), fillReq(sig, { final: true }));
    expect(finalClock.sleeps).toEqual([]);                                                                          // no 60 s poll on a final look
    // a final look that FAILED (the node errors) says nothing about the transaction: unverified, never not-landed
    const brokenLook = await readWalletFill(deps(port({ getTransaction: () => { throw new WalletRpcError('http', 'HTTP 502'); }, getSignatureStatuses: () => ({ value: [null] }) }), new FakeClock()), fillReq(sig, { final: true }));
    expect(brokenLook).toMatchObject({ fill: { status: 'unverified', reason: 'meta-unreadable' } });
    const brokenStatus = await readWalletFill(deps(port({ getTransaction: () => null, getSignatureStatuses: () => { throw new WalletRpcError('http', 'HTTP 502'); } }), new FakeClock()), fillReq(sig, { final: true }));
    expect(brokenStatus).toMatchObject({ fill: { status: 'unverified', reason: 'meta-unreadable' } });
    const knownButNoMeta = await readWalletFill(deps(viewPort(null, { err: null, confirmationStatus: 'confirmed' }), new FakeClock()), fillReq(sig, { final: true }));
    expect(knownButNoMeta).toMatchObject({ fill: { status: 'unverified', reason: 'meta-unreadable' } });

    // the side must agree with the deltas
    const wrongSide = await readWalletFill(deps(viewPort(txView())), fillReq(sig, { side: 'sell' }));
    expect(wrongSide).toMatchObject({ fill: { status: 'unverified', reason: 'side-mismatch' } });
    const noTokens = await readWalletFill(deps(viewPort(txView({ tokenPost: '0' }))), fillReq(sig));
    expect(noTokens).toMatchObject({ fill: { status: 'unverified', reason: 'side-mismatch' } });
    // a sell: the token balance went down
    const sell = await readWalletFill(deps(viewPort(txView({ created: false, tokenPre: '1000', tokenPost: '0', ownerPre: 1_000_000_000, ownerPost: 1_080_000_000 }))), fillReq(sig, { side: 'sell' }));
    expect(sell).toMatchObject({ fill: { status: 'confirmed', solDeltaLamports: '80000000', tokenDeltaRaw: '-1000', rentPaidLamports: '0' } });

    // the close fill: the rent returned is the owner's change plus the fee
    const closeView: RpcTransactionView = {
      ...txView(), meta: { ...txView().meta!, preBalances: [1_000_000_000, 2_039_280, 1, 1, 1], postBalances: [1_002_034_280, 0, 1, 1, 1], preTokenBalances: [], postTokenBalances: [] },
    };
    const closed = await readWalletCloseFill(deps(viewPort(closeView)), { owner: OWNER, signature: sig, submittedAt: 1, final: false });
    expect(closed).toEqual({ ok: true, fill: { status: 'confirmed', reason: null, solDeltaLamports: '2034280', feeLamports: '5000', rentReturnedLamports: '2039280', slot: 4242, blockTime: 1_760_000_000_000 } });
    const closeNotOwner = await readWalletCloseFill(deps(viewPort(txView({ payer: fixtureKey(77) }))), { owner: OWNER, signature: sig, submittedAt: 1, final: false });
    expect(closeNotOwner).toMatchObject({ fill: { status: 'rejected-not-owner' } });
    const closeFailed = await readWalletCloseFill(deps(viewPort(txView({ err: { InstructionError: [2, { Custom: 3 }] } }))), { owner: OWNER, signature: sig, submittedAt: 1, final: false });
    expect(closeFailed).toMatchObject({ fill: { status: 'failed', feeLamports: '5000', rentReturnedLamports: null } });
    const closeGone = await readWalletCloseFill(deps(viewPort(null, null)), { owner: OWNER, signature: sig, submittedAt: 1, final: true });
    expect(closeGone).toMatchObject({ fill: { status: 'not-landed' } });
  });

  it('WTX-T07 deltas are exact strings above 2^53', async () => {
    const big = 9_007_199_254_740_993n;                      // 2^53 + 1
    const sig = newSig();
    const tokens = (big * 1_000n).toString();                // a u64 token amount far above 2^53
    const v = txView({ tokenPost: tokens, ownerPre: (big * 3n).toString(), ownerPost: (big * 2n).toString() });
    const r = await readWalletFill(deps(port({ getTransaction: () => v })), fillReq(sig));
    expect(r).toMatchObject({ ok: true, fill: { status: 'confirmed', tokenDeltaRaw: tokens, solDeltaLamports: (-big).toString() } });
    expect(Number(tokens) + 1).toBe(Number(tokens));         // the number form cannot tell two neighbours apart ...
    const sold = await readWalletFill(deps(port({ getTransaction: () => txView({ created: false, tokenPre: U64_MAX, tokenPost: '0' }) })), fillReq(sig, { side: 'sell' }));
    expect(sold).toMatchObject({ fill: { tokenDeltaRaw: `-${U64_MAX}` } });                                // ... the string stays exact, up to u64 max
    const bal = await readWalletBalances(deps(port({
      getBalance: () => ({ context: { slot: 1 }, value: 9_007_199_254_740_991 }),
      getTokenAccountsByOwner: (params) => ({ context: { slot: 1 }, value: params[1].programId === TOKEN_PROGRAM_ID ? [parsedAccount(TRADE_ATA, TOKEN_PROGRAM_ID, { amount: U64_MAX })] : [] }),
    })), { owner: OWNER });
    expect(bal).toMatchObject({ ok: true, balances: { solLamports: '9007199254740991', tokens: [{ amountRaw: U64_MAX }] } });
  });
});

describe('slippage error codes', () => {
  it('are the pinned fixture, matched by the failing program and custom code only', () => {
    const file = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'test-fixtures', 'execution', 'wallet', 'slippage-codes.json'), 'utf8')) as { programs: Array<{ name: string; program: string; codes: Array<{ code: number }> }> };
    const ids: Record<string, string> = { pump: PUMP, pumpswap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', jupiter: JUP };
    expect(file.programs.map((p) => p.program)).toEqual(['pump', 'pumpswap', 'jupiter']);          // the fixture names its programs; their ids are the code's constants
    const fromFile = Object.fromEntries(file.programs.map((p) => [ids[p.program], p.codes.map((c) => c.code)]));
    expect(SLIPPAGE_ERROR_CODES).toEqual(fromFile);
    expect(customInstructionError({ InstructionError: [3, { Custom: 6004 }] })).toEqual({ index: 3, code: 6004 });
    expect(customInstructionError({ InstructionError: [3, 'InvalidArgument'] })).toBeNull();
    expect(customInstructionError('InsufficientFundsForFee')).toBeNull();
    const programOf = (i: number): string | null => [SYSTEM, PUMP, JUP][i] ?? null;
    expect(isSlippageError({ InstructionError: [1, { Custom: 6002 }] }, programOf)).toBe(true);
    expect(isSlippageError({ InstructionError: [2, { Custom: 6001 }] }, programOf)).toBe(true);
    expect(isSlippageError({ InstructionError: [2, { Custom: 6002 }] }, programOf)).toBe(false);     // a pump code on the Jupiter program
    expect(isSlippageError({ InstructionError: [0, { Custom: 6002 }] }, programOf)).toBe(false);     // the System program has no pinned codes
    expect(isSlippageError({ InstructionError: [9, { Custom: 6002 }] }, programOf)).toBe(false);     // an index that names no instruction
  });
});
