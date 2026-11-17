/**
 * WALLET READS — exact-string chain reads for a connected wallet (R7-W5, A-104, design 7.6 and 13).
 *
 * What lives here: the account and token-account decoders the wallet builders share, the owner's balances (`/v1/wallet/balances`), and the
 * fill reads (`/v1/wallet/fill`, `/v1/wallet/close-fill`) that book what the CHAIN says happened to an external owner.
 *
 * Rules (rev 3 R3-5 e, design 13 items 2-3): commitment 'confirmed' on every read (the port forces it); a raw amount is the RPC's own
 * integer string and never a Number; a read that fails or cannot be decoded is a REFUSAL with a reason, never 0, never an empty list,
 * never a partial answer. `getSolBalance`, `getWsolBalance`, `getSplTokenBalance` and `getAllSplBalances` (jupiter.ts, they return
 * Numbers and 0 on failure) are not used. Nothing here signs, sends or reaches a provider except through the injected wallet RPC port.
 */
import { PublicKey } from '@solana/web3.js';
import { computeTxDeltas, accountKeysOf, type RpcTransactionView } from './tx-deltas';
import { refusalFromError, walletRefusal, type WalletRpcPort, type WalletSleepClock } from './wallet-rpc';
import type {
  UintString, WalletBalancesOk, WalletBalancesRequest, WalletCloseFillOk, WalletCloseFillRequest, WalletFillOk, WalletFillRequest, WalletLinkRefusal,
  WalletTokenBalance,
} from '../shared/contract/wallet-link';

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** The associated token account address of (owner, mint) under `programId` (Token or Token-2022): the program id is part of the seeds. */
export function deriveAtaAddress(owner: string, mint: string, programId: string): string {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(programId).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ATA_PROGRAM_ID),
  )[0].toBase58();
}

// ── decoders ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** An account as `getAccountInfo` / `getMultipleAccounts` (encoding base64) return it. */
export interface ChainAccount { lamports: bigint; owner: string; data: Buffer }

function toBig(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) return BigInt(v);
  return null;
}
const UINT64_MAX = 18446744073709551615n;

/** One RPC account value to a ChainAccount; null for a missing account (the RPC's `null`); undefined when the value cannot be read. */
export function parseChainAccount(value: unknown): ChainAccount | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || value === undefined) return undefined;
  const v = value as { lamports?: unknown; owner?: unknown; data?: unknown };
  const lamports = toBig(v.lamports);
  if (lamports === null || lamports > UINT64_MAX || typeof v.owner !== 'string') return undefined;
  const d = v.data;
  const b64 = Array.isArray(d) ? d[0] : undefined;
  if (typeof b64 !== 'string' || (Array.isArray(d) && d[1] !== 'base64')) return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return undefined;
  return { lamports, owner: v.owner, data: Buffer.from(b64, 'base64') };
}

export interface SplTokenAccount {
  mint: string; owner: string; amount: bigint;
  delegate: string | null; delegatedAmount: bigint;
  /** 0 uninitialized, 1 initialized, 2 frozen. */
  state: number;
  isNative: boolean;
  closeAuthority: string | null;
}
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** base58 of 32 bytes (public keys only); no dependency, so this file stays free of the web3.js surface. */
export function base58Of(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}
const keyAt = (buf: Buffer, off: number): string => base58Of(buf.subarray(off, off + 32));

/** The base SPL token-account layout (classic Token and Token-2022 share it for the first 165 bytes); null when the data is shorter. */
export function parseSplTokenAccount(data: Uint8Array): SplTokenAccount | null {
  if (data.length < 165) return null;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const delegateSet = buf.readUInt32LE(72) === 1;
  const nativeSet = buf.readUInt32LE(109) === 1;
  const closeSet = buf.readUInt32LE(129) === 1;
  return {
    mint: keyAt(buf, 0), owner: keyAt(buf, 32), amount: buf.readBigUInt64LE(64),
    delegate: delegateSet ? keyAt(buf, 76) : null, delegatedAmount: buf.readBigUInt64LE(121),
    state: buf[108], isNative: nativeSet,
    closeAuthority: closeSet ? keyAt(buf, 133) : null,
  };
}

export interface SplMint { decimals: number; supply: bigint; isInitialized: boolean; mintAuthority: string | null; freezeAuthority: string | null }
/** The base SPL mint layout (82 bytes; Token-2022 extensions follow); null when the data is shorter. */
export function parseSplMint(data: Uint8Array): SplMint | null {
  if (data.length < 82) return null;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return {
    mintAuthority: buf.readUInt32LE(0) === 1 ? keyAt(buf, 4) : null,
    supply: buf.readBigUInt64LE(36), decimals: buf[44], isInitialized: buf[45] === 1,
    freezeAuthority: buf.readUInt32LE(46) === 1 ? keyAt(buf, 50) : null,
  };
}

// ── Token-2022 mint extensions (A-117: the mint checks of a dashboard buy) ─────────────────────────────────────────────────────
//
// Layout (spl-token-2022): a mint with extensions is padded to the size of a base token account (165 bytes), byte 165 is the account type
// (1 = Mint), and from byte 166 on come the TLV entries: type u16 LE, length u16 LE, value. A type of 0 (Uninitialized) ends the list. The three
// extension numbers and the frozen state value are pinned in test-fixtures/execution/wallet/mint-extensions-pin.json (a test keeps them equal).

/** Offset of the account-type byte of a Token-2022 mint with extensions: the size of a base token account. */
export const MINT_ACCOUNT_TYPE_OFFSET = 165;
/** The AccountType::Mint value stored at MINT_ACCOUNT_TYPE_OFFSET. */
export const MINT_ACCOUNT_TYPE_MINT = 1;
/** ExtensionType numbers the wallet buy checks read. */
export const MINT_EXT_DEFAULT_ACCOUNT_STATE = 6;
export const MINT_EXT_NON_TRANSFERABLE = 9;
export const MINT_EXT_TRANSFER_HOOK = 14;
/** AccountState::Frozen, the value of a DefaultAccountState extension that makes every new token account of the mint start frozen. */
export const ACCOUNT_STATE_FROZEN = 2;

export interface MintExtensions {
  /** Every extension type number present, in stored order (the three below are the ones the buy checks act on). */
  types: number[];
  /** NonTransferable (9): the tokens can never be moved. */
  nonTransferable: boolean;
  /** DefaultAccountState (6) with state Frozen (2): the buyer's new token account would start frozen. */
  defaultAccountStateFrozen: boolean;
  /** TransferHook (14): the hook program id (base58) when it is set (non-zero), else null. */
  transferHookProgram: string | null;
}

/**
 * The extensions of a mint account's data. Pure. `null` when the data cannot be read: shorter than the 82-byte base mint, a length between the
 * base mint and an account-type byte, an account type other than Mint, a TLV entry that is cut off or runs past the end, or a known extension
 * whose length differs from its layout (NonTransferable 0, DefaultAccountState 1, TransferHook 64). A classic Token mint (exactly 82 bytes, and a
 * Token-2022 mint without extensions) has none. The caller treats `null` as "cannot be read" and refuses a BUY; it never reads it as "no extensions".
 */
export function parseMintExtensions(data: Uint8Array): MintExtensions | null {
  const out: MintExtensions = { types: [], nonTransferable: false, defaultAccountStateFrozen: false, transferHookProgram: null };
  if (data.length < 82) return null;
  if (data.length === 82) return out;
  if (data.length <= MINT_ACCOUNT_TYPE_OFFSET) return null;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf[MINT_ACCOUNT_TYPE_OFFSET] !== MINT_ACCOUNT_TYPE_MINT) return null;
  let cursor = MINT_ACCOUNT_TYPE_OFFSET + 1;
  while (cursor < buf.length) {
    if (buf.length < cursor + 2) return null;              // not even a whole type: cut off
    const type = buf.readUInt16LE(cursor);
    if (type === 0) break;                                  // Uninitialized: the end of the list, the rest is padding
    if (buf.length < cursor + 4) return null;              // no whole length: cut off
    const length = buf.readUInt16LE(cursor + 2);
    const start = cursor + 4;
    const end = start + length;
    if (end > buf.length) return null;                      // the value runs past the end of the account
    out.types.push(type);
    if (type === MINT_EXT_NON_TRANSFERABLE) {
      if (length !== 0) return null;
      out.nonTransferable = true;
    } else if (type === MINT_EXT_DEFAULT_ACCOUNT_STATE) {
      if (length !== 1) return null;
      if (buf[start] === ACCOUNT_STATE_FROZEN) out.defaultAccountStateFrozen = true;
    } else if (type === MINT_EXT_TRANSFER_HOOK) {
      if (length !== 64) return null;                       // authority (32) then program id (32); an all-zero id is "none"
      const program = buf.subarray(start + 32, end);
      if (program.some((b) => b !== 0)) out.transferHookProgram = base58Of(program);
    }
    cursor = end;
  }
  return out;
}

/** `getMultipleAccounts` (base64, confirmed) in the order asked; throws on a transport error or an answer that cannot be decoded. */
export async function readAccounts(rpc: WalletRpcPort, keys: readonly string[], opts: { timeoutMs?: number } = {}): Promise<{ accounts: Array<ChainAccount | null>; slot: number }> {
  if (keys.length === 0) return { accounts: [], slot: 0 };
  const res = await rpc.call('getMultipleAccounts', [[...keys], { encoding: 'base64', commitment: 'confirmed' }], opts);
  const list = res?.value;
  const slot = res?.context?.slot;
  if (!Array.isArray(list) || list.length !== keys.length || typeof slot !== 'number') throw new Error('getMultipleAccounts answer is malformed');
  const accounts = list.map((v: unknown, i: number) => {
    const a = parseChainAccount(v);
    if (a === undefined) throw new Error(`account ${i} could not be decoded`);
    return a;
  });
  return { accounts, slot };
}

// ── the owner's token accounts and balances ──────────────────────────────────────────────────────────────────────────────────

export interface OwnedTokenAccount {
  account: string; mint: string; program: 'token' | 'token-2022';
  amountRaw: UintString; decimals: number;
  /** The account's own lamports: rent, plus the wrapped amount for a wSOL account. */
  lamports: UintString;
  state: string;
  /** true frozen, false initialized, null any other state. */
  frozen: boolean | null;
  closeAuthority: string | null;
  delegate: string | null;
  isNative: boolean;
  /** Withheld Token-2022 transfer fees held in the account ('0' when it has none). */
  withheldFee: UintString;
}

function plainAmount(v: unknown): string | null {
  return typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) <= UINT64_MAX ? v : null;
}

function ownedAccountOf(entry: any, owner: string, programId: string): OwnedTokenAccount {
  const info = entry?.account?.data?.parsed?.info;
  const lamports = toBig(entry?.account?.lamports);
  const amount = plainAmount(info?.tokenAmount?.amount);
  const decimals = info?.tokenAmount?.decimals;
  if (typeof entry?.pubkey !== 'string' || entry?.account?.owner !== programId || entry?.account?.data?.parsed?.type !== 'account' || !info ||
      typeof info.mint !== 'string' || info.owner !== owner || amount === null || lamports === null || lamports > UINT64_MAX ||
      typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 18 || typeof info.state !== 'string') {
    throw new Error('a token account could not be decoded');
  }
  let withheld = 0n;
  for (const x of Array.isArray(info.extensions) ? info.extensions : []) {
    if (x?.extension === 'transferFeeAmount') {
      const w = toBig(x?.state?.withheldAmount);
      if (w === null) throw new Error('a token account fee extension could not be decoded');
      withheld += w;
    }
  }
  return {
    account: entry.pubkey, mint: info.mint, program: programId === TOKEN_2022_PROGRAM_ID ? 'token-2022' : 'token',
    amountRaw: amount, decimals, lamports: lamports.toString(), state: info.state,
    frozen: info.state === 'frozen' ? true : info.state === 'initialized' ? false : null,
    closeAuthority: typeof info.closeAuthority === 'string' ? info.closeAuthority : null,
    delegate: typeof info.delegate === 'string' ? info.delegate : null,
    isNative: info.isNative === true, withheldFee: withheld.toString(),
  };
}

/** Every token account of `owner` under both token programs (jsonParsed, confirmed). Throws when a call fails or an account cannot be decoded. */
export async function readOwnedTokenAccounts(rpc: WalletRpcPort, owner: string, opts: { timeoutMs?: number } = {}): Promise<{ accounts: OwnedTokenAccount[]; slot: number }> {
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  const answers = await Promise.all(programs.map((p) => rpc.call('getTokenAccountsByOwner', [owner, { programId: p }, { encoding: 'jsonParsed', commitment: 'confirmed' }], opts)));
  const accounts: OwnedTokenAccount[] = [];
  let slot = Number.MAX_SAFE_INTEGER;
  answers.forEach((r, i) => {
    const s = r?.context?.slot;
    if (!Array.isArray(r?.value) || typeof s !== 'number') throw new Error('getTokenAccountsByOwner answer is malformed');
    slot = Math.min(slot, s);
    for (const e of r.value) accounts.push(ownedAccountOf(e, owner, programs[i]));
  });
  const seen = new Set<string>();
  for (const a of accounts) { if (seen.has(a.account)) throw new Error('a token account was listed twice'); seen.add(a.account); }
  return { accounts, slot };
}

/** The owner's native balance (getBalance, confirmed) as the RPC's exact lamports, with the slot it was read at. Throws on failure. */
export async function readSolBalance(rpc: WalletRpcPort, owner: string, opts: { timeoutMs?: number } = {}): Promise<{ lamports: bigint; slot: number }> {
  const r = await rpc.call('getBalance', [owner, { commitment: 'confirmed' }], opts);
  const lamports = toBig(r?.value);
  const slot = r?.context?.slot;
  if (lamports === null || lamports > UINT64_MAX || typeof slot !== 'number') throw new Error('getBalance answer is malformed');
  return { lamports, slot };
}

export interface WalletReadDeps {
  rpc: WalletRpcPort;
  clock: WalletSleepClock;
}

/** `/v1/wallet/balances`: the SOL balance and every token account, exact strings, one slot (the lowest of the reads). */
export async function readWalletBalances(deps: WalletReadDeps, req: WalletBalancesRequest): Promise<WalletBalancesOk | WalletLinkRefusal> {
  try {
    const [sol, tokens] = await Promise.all([readSolBalance(deps.rpc, req.owner), readOwnedTokenAccounts(deps.rpc, req.owner)]);
    const list: WalletTokenBalance[] = tokens.accounts.map((a) => ({
      account: a.account, mint: a.mint, program: a.program, amountRaw: a.amountRaw, decimals: a.decimals, rentLamports: a.lamports, frozen: a.frozen,
    }));
    return { ok: true, balances: { solLamports: sol.lamports.toString(), tokens: list, readAt: deps.clock.now(), slot: Math.min(sol.slot, tokens.slot) } };
  } catch (e) {
    return refusalFromError(e);
  }
}

// ── slippage errors (design 7.6) ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The program errors that mean "the price moved beyond your slippage", one entry per program, recorded in
 * test-fixtures/execution/wallet/slippage-codes.json (a test keeps the two equal). An unknown code is NOT in this list and shows the
 * generic failure text. Program ids are the public ones.
 */
export const SLIPPAGE_ERROR_CODES: Readonly<Record<string, readonly number[]>> = {
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': [6002, 6003, 6042],   // pump: TooMuchSolRequired (buy), TooLittleSolReceived (sell), BuySlippageBelowMinTokensOut (buy_exact_sol_in; FIX-PUMP)
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': [6004],         // PumpSwap: ExceededSlippage
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': [6001],         // Jupiter v6: SlippageToleranceExceeded
};

/**
 * The `{InstructionError: [index, {Custom: code}]}` of a transaction error, when it is one: the failing top-level instruction's index and the custom
 * program error code. null for every other shape.
 */
export function customInstructionError(err: unknown): { index: number; code: number } | null {
  const ie = (err as { InstructionError?: unknown } | null)?.InstructionError;
  if (!Array.isArray(ie) || ie.length !== 2 || typeof ie[0] !== 'number') return null;
  const code = (ie[1] as { Custom?: unknown } | null)?.Custom;
  return typeof code === 'number' && Number.isInteger(code) ? { index: ie[0], code } : null;
}

/** True when `err` is a pinned slippage error of the program that ran top-level instruction `index`. */
export function isSlippageError(err: unknown, programOfInstruction: (index: number) => string | null): boolean {
  const c = customInstructionError(err);
  if (c === null) return false;
  const program = programOfInstruction(c.index);
  return program !== null && (SLIPPAGE_ERROR_CODES[program] ?? []).includes(c.code);
}

// ── fills ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const WALLET_FILL_TIMEOUT_MS = 60_000;
export const WALLET_FILL_POLL_MS_DEFAULT = 2_000;
export const WALLET_FILL_POLL_MS_MIN = 1_500;

export interface WalletFillDeps extends WalletReadDeps {
  /** The poll interval (WALLET_FILL_POLL_MS): at least 1500 ms. */
  pollMs?: number;
  timeoutMs?: number;
}

type PolledTx = { kind: 'tx'; tx: RpcTransactionView } | { kind: 'gone' } | { kind: 'late' };

/** getTransaction until the meta is readable. final: exactly one look, then the signature status decides between not-landed and unverified. */
async function pollTransaction(deps: WalletFillDeps, signature: string, final: boolean): Promise<PolledTx | WalletLinkRefusal> {
  const pollMs = Math.max(WALLET_FILL_POLL_MS_MIN, deps.pollMs ?? WALLET_FILL_POLL_MS_DEFAULT);
  const timeoutMs = deps.timeoutMs ?? WALLET_FILL_TIMEOUT_MS;
  const start = deps.clock.now();
  for (;;) {
    let readFailed = false;
    try {
      const tx = (await deps.rpc.call('getTransaction', [signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])) as RpcTransactionView | null;
      if (tx && tx.meta) return { kind: 'tx', tx };
    } catch (e) {
      const r = refusalFromError(e);
      if (r.code === 'rpc-budget') return r;      // the budget stops the poll; any other error counts as "not readable yet"
      readFailed = true;
    }
    if (final) {
      // a look that FAILED says nothing about whether the transaction landed: only two clean "nothing" answers make it not-landed
      if (readFailed) return { kind: 'late' };
      try {
        const st = await deps.rpc.call('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
        const v = Array.isArray(st?.value) ? st.value[0] : undefined;
        if (v === null) return { kind: 'gone' };         // no transaction and no status, from two answers that both worked
      } catch (e) {
        const r = refusalFromError(e);
        if (r.code === 'rpc-budget') return r;
      }
      return { kind: 'late' };
    }
    const left = timeoutMs - (deps.clock.now() - start);
    if (left <= 0) return { kind: 'late' };
    await deps.clock.sleep(Math.min(pollMs, left));
  }
}

const isRefusal = (x: unknown): x is WalletLinkRefusal => typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;
const UNVERIFIED_BASE = { solDeltaLamports: null, feeLamports: null, rentPaidLamports: null, tokenDeltaRaw: null, decimals: null, slot: null, blockTime: null } as const;

/** Design 7.6: the status of an external owner's transaction, from the transaction meta only. Never booked from a quote. */
function judge(tx: RpcTransactionView, owner: string): { payerOk: boolean; slot: number | null; failed: boolean; fee: bigint | null; program: (i: number) => string | null } {
  const keys = accountKeysOf(tx);
  const msg = tx.transaction?.message;
  const sigs = msg?.header?.numRequiredSignatures;
  const fee = toBig(tx.meta?.fee);
  return {
    payerOk: !!keys && keys[0] === owner && typeof sigs === 'number' && sigs >= 1,
    slot: typeof tx.slot === 'number' ? tx.slot : null,
    failed: tx.meta?.err !== null && tx.meta?.err !== undefined,
    fee,
    program: (i: number) => {
      const idx = msg?.instructions?.[i]?.programIdIndex;
      return keys && typeof idx === 'number' ? keys[idx] ?? null : null;
    },
  };
}

/**
 * `/v1/wallet/fill`. payer is not the owner -> rejected-not-owner (nothing booked); meta.err -> failed with the fee paid ('price-moved' for a
 * pinned slippage code of the failing program); success -> the exact deltas of (owner, mint) with the rent of created token accounts split
 * out; a side that contradicts the deltas, or a meta that cannot be read, -> unverified with a reason; `final` with no transaction and no
 * status -> not-landed.
 */
export async function readWalletFill(deps: WalletFillDeps, req: WalletFillRequest): Promise<WalletFillOk | WalletLinkRefusal> {
  const polled = await pollTransaction(deps, req.signature, req.final);
  if (isRefusal(polled)) return polled;
  if (polled.kind === 'gone') return { ok: true, fill: { status: 'not-landed', reason: null, ...UNVERIFIED_BASE } };
  if (polled.kind === 'late') return { ok: true, fill: { status: 'unverified', reason: 'meta-unreadable', ...UNVERIFIED_BASE } };
  const tx = polled.tx;
  const j = judge(tx, req.owner);
  const blockTime = typeof tx.blockTime === 'number' && tx.blockTime > 0 ? tx.blockTime * 1000 : null;
  if (!j.payerOk) return { ok: true, fill: { status: 'rejected-not-owner', reason: 'fee-payer-is-not-owner', ...UNVERIFIED_BASE } };
  const d = computeTxDeltas(tx, req.owner, req.mint);
  if (j.failed) {
    if (j.fee === null) return { ok: true, fill: { status: 'unverified', reason: 'meta-unreadable', ...UNVERIFIED_BASE } };
    const reason = isSlippageError(tx.meta?.err, j.program) ? 'price-moved' : 'failed-on-chain';
    return {
      ok: true,
      fill: { status: 'failed', reason, solDeltaLamports: d ? d.lamportsDelta.toString() : null, feeLamports: j.fee.toString(), rentPaidLamports: null, tokenDeltaRaw: null, decimals: null, slot: j.slot, blockTime },
    };
  }
  if (d === null || d.rentPaidLamports === null || d.decimals === null) return { ok: true, fill: { status: 'unverified', reason: 'meta-incomplete', ...UNVERIFIED_BASE } };
  if (j.slot === null) return { ok: true, fill: { status: 'unverified', reason: 'meta-incomplete', ...UNVERIFIED_BASE } };
  // side inconsistent with the deltas: a buy must add tokens, a sell must remove them
  if ((req.side === 'buy' && d.tokenDelta <= 0n) || (req.side === 'sell' && d.tokenDelta >= 0n)) {
    return { ok: true, fill: { status: 'unverified', reason: 'side-mismatch', ...UNVERIFIED_BASE } };
  }
  return {
    ok: true,
    fill: {
      status: 'confirmed', reason: null, solDeltaLamports: d.lamportsDelta.toString(), feeLamports: d.feeLamports.toString(), rentPaidLamports: d.rentPaidLamports.toString(),
      tokenDeltaRaw: d.tokenDelta.toString(), decimals: d.decimals, slot: j.slot, blockTime,
    },
  };
}

/** `/v1/wallet/close-fill`: the same reading for a CloseAccount transaction; the rent returned is the owner's lamport change plus the fee. */
export async function readWalletCloseFill(deps: WalletFillDeps, req: WalletCloseFillRequest): Promise<WalletCloseFillOk | WalletLinkRefusal> {
  const none = { solDeltaLamports: null, feeLamports: null, rentReturnedLamports: null, slot: null, blockTime: null } as const;
  const polled = await pollTransaction(deps, req.signature, req.final);
  if (isRefusal(polled)) return polled;
  if (polled.kind === 'gone') return { ok: true, fill: { status: 'not-landed', reason: null, ...none } };
  if (polled.kind === 'late') return { ok: true, fill: { status: 'unverified', reason: 'meta-unreadable', ...none } };
  const tx = polled.tx;
  const j = judge(tx, req.owner);
  const blockTime = typeof tx.blockTime === 'number' && tx.blockTime > 0 ? tx.blockTime * 1000 : null;
  if (!j.payerOk) return { ok: true, fill: { status: 'rejected-not-owner', reason: 'fee-payer-is-not-owner', ...none } };
  const d = computeTxDeltas(tx, req.owner, WSOL_MINT);
  if (j.failed) {
    if (j.fee === null) return { ok: true, fill: { status: 'unverified', reason: 'meta-unreadable', ...none } };
    return { ok: true, fill: { status: 'failed', reason: 'failed-on-chain', solDeltaLamports: d ? d.lamportsDelta.toString() : null, feeLamports: j.fee.toString(), rentReturnedLamports: null, slot: j.slot, blockTime } };
  }
  if (d === null || j.slot === null) return { ok: true, fill: { status: 'unverified', reason: 'meta-incomplete', ...none } };
  const returned = d.lamportsDelta + d.feeLamports;
  if (returned <= 0n) return { ok: true, fill: { status: 'unverified', reason: 'no-rent-returned', ...none } };
  return {
    ok: true,
    fill: { status: 'confirmed', reason: null, solDeltaLamports: d.lamportsDelta.toString(), feeLamports: d.feeLamports.toString(), rentReturnedLamports: returned.toString(), slot: j.slot, blockTime },
  };
}
