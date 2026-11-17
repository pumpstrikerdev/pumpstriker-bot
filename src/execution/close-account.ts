/**
 * CLOSE ACCOUNT — reclaim the token-account rent after a full exit, in a SEPARATE transaction (B40 rule 3).
 *
 * Why separate: a CloseAccount inside the sell reverts the whole protective exit whenever it fails (dust left behind by
 * a route, a Token-2022 account with withheld fees). After a confirmed full exit and a token account that reads exactly
 * zero, this module sends one small transaction on its own:
 *   instruction data [9], keys [ata (writable), owner (writable, rent destination), owner (signer)], sent under the ATA's
 *   OWNING program (read from getAccountInfo(ata).owner: Token or Token-2022), low priority fee, 2 retries.
 *
 * Skipped with a reason (never an error): balance above zero (a partial sell never closes), account missing, a Token-2022
 * account with withheld transfer fees, a frozen account, or a close authority other than the owner.
 * `rentLamports` is read from the CloseAccount transaction's meta (the closed account's lamports); null if the meta stays
 * unreadable. Reasons are `redactSecrets(String(e?.message ?? e)).slice(0, 200)` (plan grind #64).
 */
import {
  ComputeBudgetProgram, Keypair, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import type { CloseAccountApi } from '../bot-contracts';
import { buildCloseAccountInstruction, CLOSE_ACCOUNT_IX_DATA } from './close-ix';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, defaultExecRpc, deriveAta, errorReason, isBase58Key, systemClock, toBigInt,
  type ExecClock, type ExecRpc,
} from './exec-common';
import { computeTxDeltas, waitForTransaction } from './fills';

// R7-W5 (A-104): the CloseAccount instruction builder moved, unchanged, into the pure close-ix.ts (the unsigned wallet closer shares it);
// CLOSE_ACCOUNT_IX_DATA is re-exported here under the same name.
export { CLOSE_ACCOUNT_IX_DATA };
/** Retries after the first attempt (B40 rule 3: "2 retries"), so at most 3 sends. */
export const CLOSE_ACCOUNT_RETRIES = 2;
/** Low priority: a tiny compute-unit price and a limit just above what CloseAccount needs. */
export const CLOSE_CU_LIMIT = 30_000;
export const CLOSE_CU_PRICE_MICROLAMPORTS = 10_000;
const RENT_META_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 1_000;

export interface CloseAccountDeps {
  /** Wallet signer for an owner address; null when the wallet is unknown. Required: B40 has no wallet store. */
  getSigner: (owner: string) => Keypair | null | Promise<Keypair | null>;
  rpc?: ExecRpc;
  /** Sign-and-send is split: this sends a SIGNED transaction and resolves with its signature once it is confirmed
   *  (throws on a revert or a confirmation timeout). Default: jupiter.ts multiRpcSend with awaitConfirm. */
  send?: (tx: VersionedTransaction) => Promise<string>;
  getBlockhash?: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  clock?: ExecClock;
  retries?: number;
  retryDelayMs?: number;
}

interface AtaView {
  address: string;
  program: string;
  amount: bigint | null;
  withheld: bigint;
  frozen: boolean;
  foreignCloseAuthority: boolean;
}

/** Decode a jsonParsed token account value. Returns null when the shape is not a token account. */
function viewAta(address: string, value: any, owner: string): AtaView | null {
  const program = value?.owner;
  if (program !== TOKEN_PROGRAM_ID && program !== TOKEN_2022_PROGRAM_ID) return null;
  const info = value?.data?.parsed?.info;
  if (!info) return { address, program, amount: null, withheld: 0n, frozen: false, foreignCloseAuthority: false };
  let withheld = 0n;
  const exts: any[] = Array.isArray(info.extensions) ? info.extensions : [];
  for (const x of exts) {
    if (x?.extension === 'transferFeeAmount') withheld += toBigInt(x?.state?.withheldAmount) ?? 0n;
  }
  const closeAuthority = typeof info.closeAuthority === 'string' ? info.closeAuthority : null;
  return {
    address,
    program,
    amount: toBigInt(info.tokenAmount?.amount),
    withheld,
    frozen: info.state === 'frozen',
    foreignCloseAuthority: closeAuthority !== null && closeAuthority !== owner,
  };
}

async function findAta(rpc: ExecRpc, owner: string, mint: string): Promise<{ ata: AtaView | null; error: string | null }> {
  const candidates = [deriveAta(owner, mint, 'token2022'), deriveAta(owner, mint, 'token')];
  const results = await Promise.allSettled(
    candidates.map((a) => rpc.call('getAccountInfo', [a, { encoding: 'jsonParsed', commitment: 'confirmed' }])),
  );
  let firstError: string | null = null;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      firstError ??= errorReason(r.reason);
      continue;
    }
    const value = r.value?.value;
    if (value) return { ata: viewAta(candidates[i], value, owner), error: null };
  }
  // No account found: only "missing" when every lookup answered; an RPC failure may hide an existing account.
  return { ata: null, error: firstError };
}

/** Rent reclaimed: the closed account's lamports (its balance change in the CloseAccount transaction). */
async function rentFromMeta(rpc: ExecRpc, clock: ExecClock, sig: string, owner: string, ata: string, mint: string): Promise<string | null> {
  const tx = await waitForTransaction(rpc, clock, sig, RENT_META_TIMEOUT_MS, 1_000).catch(() => null);
  const d = computeTxDeltas(tx, owner, mint);
  if (!d) return null;
  const i = d.accountKeys.indexOf(ata);
  if (i >= 0 && d.balanceDeltas[i] < 0n) return (-d.balanceDeltas[i]).toString();
  // fallback: the owner got the rent and paid the fee
  const net = d.lamportsDelta + d.feeLamports;
  return net > 0n ? net.toString() : null;
}

export function buildCloseAccountTx(
  owner: Keypair, ata: string, program: string, blockhash: string,
  opts: { cuLimit?: number; cuPriceMicroLamports?: number } = {},
): VersionedTransaction {
  const ownerPk = owner.publicKey;
  const ix = buildCloseAccountInstruction(program, ata, ownerPk);
  const msg = new TransactionMessage({
    payerKey: ownerPk,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cuLimit ?? CLOSE_CU_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.cuPriceMicroLamports ?? CLOSE_CU_PRICE_MICROLAMPORTS }),
      ix,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([owner]);
  return tx;
}

export function createCloseAccountApi(deps: CloseAccountDeps): CloseAccountApi {
  const rpc = deps.rpc ?? defaultExecRpc();
  const clock = deps.clock ?? systemClock;
  const retries = deps.retries ?? CLOSE_ACCOUNT_RETRIES;
  const retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
  const send = deps.send ?? (async (tx: VersionedTransaction): Promise<string> => {
    const { multiRpcSend } = await import('./jupiter');
    return multiRpcSend(tx, { awaitConfirm: true });
  });
  const getBlockhash = deps.getBlockhash ?? (async () => {
    const { getResilientBlockhash } = await import('./jupiter');
    return getResilientBlockhash();
  });

  return {
    async closeIfEmpty(owner: string, mint: string) {
      const skipped = (reason: string) => ({ status: 'skipped' as const, tx: null, rentLamports: null, reason });
      const failed = (reason: string, tx: string | null = null) => ({ status: 'failed' as const, tx, rentLamports: null, reason });
      if (!isBase58Key(owner) || !isBase58Key(mint)) return failed('invalid owner or mint address');

      let found: Awaited<ReturnType<typeof findAta>>;
      try {
        found = await findAta(rpc, owner, mint);
      } catch (e) {
        return failed(errorReason(e));
      }
      const ata = found.ata;
      if (!ata) return found.error ? failed(found.error) : skipped('token account missing');
      if (ata.amount === null) return failed('token account balance unreadable');
      if (ata.amount > 0n) return skipped(`balance above zero (${ata.amount.toString()} raw)`);
      if (ata.withheld > 0n) return skipped('Token-2022 account holds withheld transfer fees');
      if (ata.frozen) return skipped('token account is frozen');
      if (ata.foreignCloseAuthority) return skipped('close authority is not the owner');

      let signer: Keypair | null;
      try {
        signer = await deps.getSigner(owner);
      } catch (e) {
        return failed(errorReason(e));
      }
      if (!signer || signer.publicKey.toBase58() !== owner) return failed('no signer for this owner');

      let lastReason = 'close failed';
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
          await clock.sleep(retryDelayMs);
          // An earlier attempt may have landed after its confirmation timed out: look before sending again.
          try {
            const again = await findAta(rpc, owner, mint);
            if (!again.ata && !again.error) {
              return { status: 'closed' as const, tx: null, rentLamports: null, reason: 'closed by an earlier attempt' };
            }
          } catch {
            /* keep going with the retry */
          }
        }
        try {
          const { blockhash } = await getBlockhash();
          const tx = buildCloseAccountTx(signer, ata.address, ata.program, blockhash);
          const sig = await send(tx);
          const rent = await rentFromMeta(rpc, clock, sig, owner, ata.address, mint);
          return { status: 'closed' as const, tx: sig, rentLamports: rent, reason: null };
        } catch (e) {
          lastReason = errorReason(e);
        }
      }
      return failed(lastReason);
    },
  };
}
