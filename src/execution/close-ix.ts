/**
 * CLOSE IX — the CloseAccount instruction as a pure "instruction for payer P" builder (R7-W5 extraction out of close-account.ts, A-104).
 *
 * The SPL Token and Token-2022 CloseAccount instruction: data [9], keys [account (writable), destination (writable), authority
 * (signer)]. The server path (close-account.ts) and the unsigned wallet builder (unsigned-close.ts) both call it, so the two always
 * build the same instruction; the server path's transaction bytes are pinned by byte-identity goldens. This file holds no Keypair and no
 * `.sign(`: it only names the owner's public key.
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';

/** CloseAccount instruction discriminator of the SPL Token and Token-2022 programs. */
export const CLOSE_ACCOUNT_IX_DATA: readonly number[] = [9];

/**
 * CloseAccount of `account` under `program` (the account's own owning token program, Token or Token-2022): the rent goes to `owner`,
 * who is also the authority and the signer. For an external payer the transaction's fee payer is that owner.
 */
export function buildCloseAccountInstruction(program: string | PublicKey, account: string | PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(program),
    keys: [
      { pubkey: new PublicKey(account), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },   // rent destination
      { pubkey: owner, isSigner: true, isWritable: false },   // owner authority
    ],
    data: Buffer.from(CLOSE_ACCOUNT_IX_DATA),
  });
}
