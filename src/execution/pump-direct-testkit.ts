/**
 * TESTS ONLY (FIX-PUMP): a scripted chain for the PF-direct route. It answers the route's one build read (getMultipleAccounts at
 * 'processed'), the verifier's pre-state read and simulateTransaction, with account bytes in the layouts pump uses today (166-byte
 * bonding curve, classic or Token-2022 mint, token accounts). The simulation decodes the transaction it is given and applies the pump
 * trade with pump's own math (pump-program.ts), so a test sees the deltas the real program would produce. No network, no signing.
 */
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  ATA_PROGRAM, PUMP_CURVE_DISCRIMINATOR, PUMP_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, pumpBuyQuote, pumpSellQuote,
} from './pump-program';
import { computeBudgetFeeLamports } from './compute-budget';
import { deriveAta, deriveBondingCurve, deriveCreatorVault, deriveUserVolumeAccumulator } from './pumpfun-ix';

export interface PumpCurveSpec {
  creator: string;
  vSol?: bigint;
  vTok?: bigint;
  realTok?: bigint;
  realSol?: bigint;
  complete?: boolean;
  mayhem?: boolean;
  cashback?: boolean;
  holderReward?: boolean;
  /** null leaves the zero key (what pump writes for SOL). */
  quoteMint?: string | null;
  creatorFeeBps?: bigint;
  len?: number;
}

/** A BondingCurve account (166 bytes by default) at pump's offsets. */
export function pumpCurveBytes(o: PumpCurveSpec): Buffer {
  const b = Buffer.alloc(o.len ?? 166);
  Buffer.from(PUMP_CURVE_DISCRIMINATOR).copy(b, 0);
  b.writeBigUInt64LE(o.vTok ?? 1_073_000_000_000_000n, 8);
  b.writeBigUInt64LE(o.vSol ?? 30_000_000_000n, 16);
  b.writeBigUInt64LE(o.realTok ?? 793_100_000_000_000n, 24);
  b.writeBigUInt64LE(o.realSol ?? 5_000_000_000n, 32);
  b.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  b[48] = o.complete ? 1 : 0;
  Buffer.from(new PublicKey(o.creator).toBytes()).copy(b, 49);
  if (b.length >= 83) {
    b[81] = o.mayhem ? 1 : 0;
    b[82] = o.cashback ? 1 : 0;
  }
  if (b.length >= 115 && o.quoteMint) Buffer.from(new PublicKey(o.quoteMint).toBytes()).copy(b, 83);
  if (b.length >= 123) b.writeBigUInt64LE(o.creatorFeeBps ?? 0n, 115);
  if (b.length >= 125) b[124] = o.holderReward ? 1 : 0;
  return b;
}

/** A mint: 82 bytes (classic Token) or Token-2022 with MetadataPointer (18) and TokenMetadata (19), decimals 6, no authorities by default. */
export function pumpMintBytes(o: { program: 'token' | 'token2022'; decimals?: number; mintAuthority?: string; freezeAuthority?: string; extensions?: number[] } = { program: 'token2022' }): Buffer {
  const base = Buffer.alloc(82);
  if (o.mintAuthority) { base.writeUInt32LE(1, 0); Buffer.from(new PublicKey(o.mintAuthority).toBytes()).copy(base, 4); }
  base.writeBigUInt64LE(1_000_000_000_000_000n, 36);
  base[44] = o.decimals ?? 6;
  base[45] = 1;
  if (o.freezeAuthority) { base.writeUInt32LE(1, 46); Buffer.from(new PublicKey(o.freezeAuthority).toBytes()).copy(base, 50); }
  if (o.program === 'token') return base;
  const tlv: Buffer[] = [];
  for (const t of o.extensions ?? [18, 19]) {
    const value = Buffer.alloc(t === 18 ? 64 : 16);
    const head = Buffer.alloc(4);
    head.writeUInt16LE(t, 0);
    head.writeUInt16LE(value.length, 2);
    tlv.push(head, value);
  }
  return Buffer.concat([base, Buffer.alloc(165 - 82), Buffer.from([1]), ...tlv]);
}

/** A token account (165 bytes, 170 for Token-2022 with ImmutableOwner), initialized. */
export function tokenAccountBytes(mint: string, owner: string, amount: bigint, o: { token2022?: boolean; delegate?: string; frozen?: boolean } = {}): Buffer {
  const b = Buffer.alloc(165);
  Buffer.from(new PublicKey(mint).toBytes()).copy(b, 0);
  Buffer.from(new PublicKey(owner).toBytes()).copy(b, 32);
  b.writeBigUInt64LE(amount, 64);
  if (o.delegate) { b.writeUInt32LE(1, 72); Buffer.from(new PublicKey(o.delegate).toBytes()).copy(b, 76); b.writeBigUInt64LE(amount, 121); }
  b[108] = o.frozen ? 2 : 1;
  return o.token2022 ? Buffer.concat([b, Buffer.from([2, 7, 0, 0, 0])]) : b;
}

export interface FakeAccount { lamports: bigint; owner: string; data: Buffer<ArrayBufferLike> }
const view = (a: FakeAccount | null | undefined): unknown => (a ? { lamports: Number(a.lamports), owner: a.owner, data: [a.data.toString('base64'), 'base64'], executable: false, rentEpoch: 0, space: a.data.length } : null);

export interface PumpSimScript {
  /** value.err of the simulation (with `logs`). */
  err?: unknown;
  logs?: string[];
  unitsConsumed?: number;
  /** Change the computed post states (owner, owner ATA) before they are returned. */
  editPost?: (post: { owner: FakeAccount; ata: FakeAccount | null }) => void;
  /** Never answer the simulation (a timeout). */
  hang?: boolean;
}

export interface PumpDirectChain {
  accounts: Map<string, FakeAccount>;
  calls: Array<{ method: string; params: any[] }>;
  sim: PumpSimScript;
  /** Applied to the verifier's pre-state read (not to the route's build read), e.g. to change the curve between the reads. */
  editPreState?: (addresses: string[], values: Array<FakeAccount | null>) => void;
  call(method: string, params: any[]): Promise<any>;
  set(address: string, a: FakeAccount | null): PumpDirectChain;
}

export function createPumpDirectChain(): PumpDirectChain {
  const chain: PumpDirectChain = {
    accounts: new Map(), calls: [], sim: {},
    set(address, a) { if (a === null) chain.accounts.delete(address); else chain.accounts.set(address, a); return chain; },
    async call(method, params) {
      chain.calls.push({ method, params });
      if (method === 'getMultipleAccounts') {
        const addresses = params[0] as string[];
        const values = addresses.map((a) => chain.accounts.get(a) ?? null).map((a) => (a ? { ...a, data: Buffer.from(a.data) } : null));
        // the verifier's pre-state read is [owner, owner ATA, user_volume_accumulator, creator_vault, bonding_curve, mint]
        if (chain.editPreState && addresses.length === 6 && chain.accounts.get(addresses[4])?.owner === PUMP_PROGRAM) chain.editPreState(addresses, values);
        return { context: { slot: 1_000 }, value: values.map(view) };
      }
      if (method === 'getAccountInfo') return { context: { slot: 1_000 }, value: view(chain.accounts.get(params[0])) };
      if (method === 'simulateTransaction') {
        if (chain.sim.hang) return new Promise(() => {});
        const cfg = params[1] as { accounts?: { addresses?: string[] } };
        const addresses = cfg.accounts?.addresses ?? [];
        if (chain.sim.err !== undefined && chain.sim.err !== null) {
          return { context: { slot: 1_001 }, value: { err: chain.sim.err, logs: chain.sim.logs ?? [], accounts: null, unitsConsumed: chain.sim.unitsConsumed ?? 40_000 } };
        }
        const post = simulatePump(chain, VersionedTransaction.deserialize(Buffer.from(String(params[0]), 'base64')), addresses);
        chain.sim.editPost?.(post);
        return { context: { slot: 1_001 }, value: { err: null, logs: chain.sim.logs ?? [], accounts: [view(post.owner), view(post.ata)], unitsConsumed: chain.sim.unitsConsumed ?? 72_480 } };
      }
      if (method === 'getBlockHeight') return 9_000;
      throw new Error(`pump-direct-testkit: unexpected rpc ${method}`);
    },
  };
  return chain;
}

/** Applies the PF-direct transaction to the owner and the owner's ATA (addresses [owner, ownerAta]) with pump's math. */
function simulatePump(chain: PumpDirectChain, tx: VersionedTransaction, addresses: string[]): { owner: FakeAccount; ata: FakeAccount | null } {
  const [ownerAddr, ataAddr] = addresses;
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const ownerPre = chain.accounts.get(ownerAddr) ?? { lamports: 0n, owner: SYSTEM_PROGRAM, data: Buffer.alloc(0) };
  const ataPre = chain.accounts.get(ataAddr) ?? null;
  let lamports = ownerPre.lamports - 5_000n;
  const fee = computeBudgetFeeLamports(tx);
  if (fee.ok) lamports -= fee.lamports;
  let ata: FakeAccount | null = ataPre ? { ...ataPre, data: Buffer.from(ataPre.data) } : null;
  for (const ix of tx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    const acc = ix.accountKeyIndexes.map((i) => keys[i]);
    const d = Buffer.from(ix.data);
    if (program === SYSTEM_PROGRAM && d.length === 12 && d.readUInt32LE(0) === 2 && acc[0] === ownerAddr) lamports -= d.readBigUInt64LE(4);
    if (program === ATA_PROGRAM && ata === null && acc[1] === ataAddr) {
      const t22 = acc[5] === TOKEN_2022_PROGRAM;
      lamports -= t22 ? 1_513_840n : 1_488_440n;
      ata = { lamports: t22 ? 1_513_840n : 1_488_440n, owner: acc[5], data: tokenAccountBytes(acc[3], acc[2], 0n, { token2022: t22 }) };
    }
    if (program !== PUMP_PROGRAM) continue;
    const curve = chain.accounts.get(acc[3]);
    if (!curve) throw new Error('pump-direct-testkit: no curve');
    const vTok = curve.data.readBigUInt64LE(8);
    const vSol = curve.data.readBigUInt64LE(16);
    const a1 = d.readBigUInt64LE(8);
    if (d.length === 25) {                                            // buy_exact_sol_in
      const q = pumpBuyQuote(vSol, vTok, a1)!;
      lamports -= a1;
      if (!chain.accounts.get(acc[13])) lamports -= 1_346_200n;      // user_volume_accumulator created on the first buy
      if (ata === null) throw new Error('pump-direct-testkit: no owner ATA on a buy');
      ata.data.writeBigUInt64LE(ata.data.readBigUInt64LE(64) + q.tokensOut, 64);
    } else {                                                          // sell
      const q = pumpSellQuote(vSol, vTok, a1)!;
      lamports += q.net;
      if (ata === null) throw new Error('pump-direct-testkit: no owner ATA on a sell');
      ata.data.writeBigUInt64LE(ata.data.readBigUInt64LE(64) - a1, 64);
    }
  }
  return { owner: { ...ownerPre, lamports }, ata };
}

export interface PumpWorld {
  mint: string;
  owner: string;
  creator: string;
  program?: 'token' | 'token2022';
  curve?: Partial<PumpCurveSpec>;
  ownerLamports?: bigint;
  /** Tokens the owner holds (the ATA under the mint's program exists); undefined: no ATA. */
  held?: bigint;
  /** The owner's user_volume_accumulator exists. */
  uva?: boolean;
  /** Lamports of the creator vault (absent: 650 240). */
  creatorVaultLamports?: bigint;
}

/** Puts one coin on the chain: curve, mint, owner, the owner's ATA (when `held` is set), the user_volume_accumulator, the creator vault. */
export function addPumpWorld(chain: PumpDirectChain, w: PumpWorld): PumpDirectChain {
  const program = w.program === 'token' ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM;
  const mintPk = new PublicKey(w.mint);
  const ownerPk = new PublicKey(w.owner);
  chain.set(deriveBondingCurve(mintPk).toBase58(), { lamports: 2_000_000_000n, owner: PUMP_PROGRAM, data: pumpCurveBytes({ creator: w.creator, ...w.curve }) });
  chain.set(w.mint, { lamports: 2_700_000n, owner: program, data: pumpMintBytes({ program: w.program ?? 'token2022' }) });
  chain.set(w.owner, { lamports: w.ownerLamports ?? 10_000_000_000n, owner: SYSTEM_PROGRAM, data: Buffer.alloc(0) });
  if (w.held !== undefined) {
    chain.set(deriveAta(mintPk, ownerPk, new PublicKey(program)).toBase58(), {
      lamports: 2_039_280n, owner: program, data: tokenAccountBytes(w.mint, w.owner, w.held, { token2022: program === TOKEN_2022_PROGRAM }),
    });
  }
  if (w.uva) chain.set(deriveUserVolumeAccumulator(ownerPk).toBase58(), { lamports: 1_346_200n, owner: PUMP_PROGRAM, data: Buffer.alloc(137) });
  chain.set(deriveCreatorVault(new PublicKey(w.creator)).toBase58(), { lamports: w.creatorVaultLamports ?? 650_240n, owner: SYSTEM_PROGRAM, data: Buffer.alloc(0) });
  return chain;
}
