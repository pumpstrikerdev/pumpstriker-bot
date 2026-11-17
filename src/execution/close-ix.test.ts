/**
 * R7-W5 close-ix.ts: the CloseAccount instruction as a pure builder for any payer (the server path and the wallet closer share it).
 * The server transaction bytes are pinned by the goldens recorded in pumpfun-ix.test.ts.
 */
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import * as closeAccount from './close-account';
import { buildCloseAccountInstruction, CLOSE_ACCOUNT_IX_DATA } from './close-ix';

const fixtureKey = (i: number): string => bs58.encode(createHash('sha256').update('ps-fixture-' + i).digest());
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

describe('close-ix', () => {
  it('closes an account under its own token program: data [9], the rent goes to the owner, who is also the authority and the only signer', () => {
    const owner = new PublicKey(fixtureKey(1));
    const ata = fixtureKey(2);
    for (const program of [TOKEN, TOKEN_2022]) {
      const ix = buildCloseAccountInstruction(program, ata, owner);
      expect(ix.programId.toBase58()).toBe(program);
      expect(Array.from(ix.data)).toEqual([9]);
      expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
        [ata, false, true],
        [owner.toBase58(), false, true],
        [owner.toBase58(), true, false],
      ]);
    }
    expect(CLOSE_ACCOUNT_IX_DATA).toEqual([9]);
    expect(closeAccount.CLOSE_ACCOUNT_IX_DATA).toBe(CLOSE_ACCOUNT_IX_DATA);
    // a PublicKey works as well as a string
    expect(buildCloseAccountInstruction(new PublicKey(TOKEN), new PublicKey(ata), owner).keys[0].pubkey.toBase58()).toBe(ata);
  });
});
