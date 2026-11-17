/**
 * TX DELTAS — the exact balance changes of a confirmed transaction (pure; R7-W5 extraction out of fills.ts, A-104).
 *
 * `accountKeysOf`, `computeTxDeltas`, the delta types and the view types moved here from fills.ts, which re-exports them under the
 * same names (the FillReader and its tests are unchanged). Nothing in this file touches an RPC, a clock, a signing module or
 * exec-common.ts, so the wallet code can read fills without pulling the server path into its import closure (G-S19).
 *
 * New: `rentPaidLamports` (the lamports of owner token accounts this transaction created, so the cost of a trade excludes the
 * refundable rent, design 12.5) and `TxDeltas.decimals`. An amount that cannot be read is null or makes the whole read null,
 * never 0.
 */

/** BigInt from an RPC number-or-string field; null when absent or not an integer. (Same rule as exec-common.ts toBigInt.) */
function toBig(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : null;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return null;
}

/** The wrapped-SOL mint: a token account of it holds the wrapped amount ON TOP of its rent. */
const NATIVE_MINT = 'So11111111111111111111111111111111111111112';

/** The parts of a getTransaction result this module reads (json or jsonParsed encoding). */
export interface RpcTransactionView {
  blockTime?: number | null;
  slot?: number;
  meta?: {
    err?: unknown;
    fee?: number | string;
    preBalances?: Array<number | string>;
    postBalances?: Array<number | string>;
    preTokenBalances?: RpcTokenBalance[] | null;
    postTokenBalances?: RpcTokenBalance[] | null;
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
  } | null;
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey: string }>;
      header?: { numRequiredSignatures?: number };
      instructions?: Array<{ programIdIndex?: number }>;
    };
  };
}
export interface RpcTokenBalance {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
}

export interface TxDeltas {
  /** Native balance change of the owner (post - pre), fee included when the owner is the fee payer. */
  lamportsDelta: bigint;
  /** Token balance change of (owner, mint) summed over both token programs. */
  tokenDelta: bigint;
  /** meta.fee, attributed to the owner only when the owner is the fee payer (account key 0); else 0. */
  feeLamports: bigint;
  /** Block time in ms, or null when the node did not report one. */
  blockTimeMs: number | null;
  /** Balance change per account key index (post - pre), for callers that need another account (CloseAccount rent). */
  accountKeys: string[];
  balanceDeltas: bigint[];
  /** meta.fee as reported (whoever paid it). */
  metaFee: bigint;
  /** Lamports of the owner's token accounts that this transaction created (pre 0, post > 0), the wrapped amount of a wSOL account
   *  excluded; null when the data to tell cannot be read. Refundable rent, not trade cost. */
  rentPaidLamports: bigint | null;
  /** Decimals of the mint as the meta reports them for (owner, mint); null when the owner has no entry for the mint. */
  decimals: number | null;
}

/** Account keys in message order: static keys, then (json encoding) loaded writable, then loaded readonly addresses. */
export function accountKeysOf(tx: RpcTransactionView): string[] | null {
  const raw = tx.transaction?.message?.accountKeys;
  if (!Array.isArray(raw)) return null;
  const keys: string[] = [];
  let hadStrings = false;
  for (const k of raw) {
    if (typeof k === 'string') {
      keys.push(k);
      hadStrings = true;
    } else if (k && typeof k.pubkey === 'string') keys.push(k.pubkey);
    else return null;
  }
  // jsonParsed already lists the loaded addresses inside accountKeys; json does not.
  if (hadStrings) {
    const la = tx.meta?.loadedAddresses;
    if (la) for (const a of [...(la.writable ?? []), ...(la.readonly ?? [])]) keys.push(a);
  }
  return keys;
}

function sumTokenAmount(list: RpcTokenBalance[] | null | undefined, owner: string, mint: string): bigint | null {
  let total = 0n;
  for (const b of list ?? []) {
    if (b?.owner !== owner || b?.mint !== mint) continue;
    const amt = toBig(b.uiTokenAmount?.amount);
    if (amt === null) return null;
    total += amt;
  }
  return total;
}

function decimalsOf(meta: NonNullable<RpcTransactionView['meta']>, owner: string, mint: string): number | null {
  for (const list of [meta.postTokenBalances, meta.preTokenBalances]) {
    for (const b of list ?? []) {
      const d = b?.uiTokenAmount?.decimals;
      if (b?.owner === owner && b?.mint === mint && typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 18) return d;
    }
  }
  return null;
}

/**
 * Pure: the lamports of the owner's token accounts that this transaction created. An account counts when it appears in
 * postTokenBalances for the owner, did not appear in preTokenBalances and held 0 lamports before; its rent is its post lamports
 * minus the wrapped amount when it is a wSOL account. null when a balance or an amount cannot be read.
 */
export function rentPaidLamports(tx: RpcTransactionView | null | undefined, owner: string): bigint | null {
  const meta = tx?.meta;
  if (!meta || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances) || meta.preBalances.length !== meta.postBalances.length) return null;
  const existed = new Set<number>();
  for (const b of meta.preTokenBalances ?? []) if (b?.owner === owner && typeof b.accountIndex === 'number') existed.add(b.accountIndex);
  let total = 0n;
  for (const b of meta.postTokenBalances ?? []) {
    if (b?.owner !== owner) continue;
    const i = b.accountIndex;
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= meta.postBalances.length) return null;
    if (existed.has(i)) continue;
    const pre = toBig(meta.preBalances[i]);
    const post = toBig(meta.postBalances[i]);
    if (pre === null || post === null) return null;
    if (pre !== 0n || post <= 0n) continue;
    let rent = post;
    if (b.mint === NATIVE_MINT) {
      const wrapped = toBig(b.uiTokenAmount?.amount);
      if (wrapped === null) return null;
      rent = post - wrapped;
    }
    if (rent > 0n) total += rent;
  }
  return total;
}

/** Pure: lamport and token deltas of (owner, mint) in one transaction; null when the meta cannot be read. */
export function computeTxDeltas(tx: RpcTransactionView | null | undefined, owner: string, mint: string): TxDeltas | null {
  const meta = tx?.meta;
  if (!tx || !meta) return null;
  const keys = accountKeysOf(tx);
  if (!keys) return null;
  const idx = keys.indexOf(owner);
  const pre = meta.preBalances;
  const post = meta.postBalances;
  if (idx < 0 || !Array.isArray(pre) || !Array.isArray(post) || pre.length !== post.length || idx >= pre.length) return null;
  if (pre.length < keys.length) return null;
  const balanceDeltas: bigint[] = [];
  for (let i = 0; i < pre.length; i++) {
    const a = toBig(pre[i]);
    const b = toBig(post[i]);
    if (a === null || b === null) return null;
    balanceDeltas.push(b - a);
  }
  const metaFee = toBig(meta.fee);
  if (metaFee === null) return null;
  const preTok = sumTokenAmount(meta.preTokenBalances, owner, mint);
  const postTok = sumTokenAmount(meta.postTokenBalances, owner, mint);
  if (preTok === null || postTok === null) return null;
  const bt = tx.blockTime;
  return {
    lamportsDelta: balanceDeltas[idx],
    tokenDelta: postTok - preTok,
    feeLamports: idx === 0 ? metaFee : 0n,
    blockTimeMs: typeof bt === 'number' && Number.isFinite(bt) && bt > 0 ? bt * 1000 : null,
    accountKeys: keys,
    balanceDeltas,
    metaFee,
    rentPaidLamports: rentPaidLamports(tx, owner),
    decimals: decimalsOf(meta, owner, mint),
  };
}
