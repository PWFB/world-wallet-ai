import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  decodePreparedSolanaDelivery,
  discoverSolanaSigningProvider,
  signPreparedSolanaDelivery,
} from "./solana-delivery-wallet.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

function prepared(authority, recipient) {
  const mint = Keypair.generate();
  const source = Keypair.generate();
  const data = Buffer.alloc(10);
  data[0] = 12; // SPL Token TransferChecked
  data.writeBigUInt64LE(1n, 1);
  data[9] = 9;
  const instruction = new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source.publicKey, isSigner: false, isWritable: true },
      { pubkey: mint.publicKey, isSigner: false, isWritable: false },
      { pubkey: recipient.publicKey, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
  const transaction = new Transaction({
    feePayer: authority.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
  }).add(instruction);
  return Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
}

test("prepared delivery decoding requires the expected authority as fee payer and signer", () => {
  const authority = Keypair.generate();
  const recipient = Keypair.generate();
  const encoded = prepared(authority, recipient);
  const decoded = decodePreparedSolanaDelivery(encoded, authority.publicKey.toBase58());
  assert.equal(decoded.feePayer.toBase58(), authority.publicKey.toBase58());
  assert.throws(() => decodePreparedSolanaDelivery(encoded, recipient.publicKey.toBase58()), /configured delivery authority/);
});

test("wallet helper signs only the exact prepared message", async () => {
  const authority = Keypair.generate();
  const recipient = Keypair.generate();
  const encoded = prepared(authority, recipient);
  const provider = {
    publicKey: authority.publicKey,
    async signTransaction(transaction) {
      transaction.partialSign(authority);
      return transaction;
    },
  };
  const result = await signPreparedSolanaDelivery({
    unsignedTransactionBase64: encoded,
    expectedAuthority: authority.publicKey.toBase58(),
    provider,
  });
  assert.equal(result.signerAddress, authority.publicKey.toBase58());
  assert.equal(result.messageUnchanged, true);
  assert.ok(result.signedTransactionBase64.length > encoded.length);
});

test("wallet helper rejects the wrong connected signer before asking for a signature", async () => {
  const authority = Keypair.generate();
  const other = Keypair.generate();
  const recipient = Keypair.generate();
  const provider = {
    publicKey: other.publicKey,
    async signTransaction() {
      assert.fail("wallet should not be asked to sign");
    },
  };
  await assert.rejects(
    signPreparedSolanaDelivery({
      unsignedTransactionBase64: prepared(authority, recipient),
      expectedAuthority: authority.publicKey.toBase58(),
      provider,
    }),
    /controls the configured BALMZ distribution account/,
  );
});

test("prepared transaction rejects a non-token instruction even when it has one instruction", () => {
  const authority = Keypair.generate();
  const recipient = Keypair.generate();
  const transaction = new Transaction({
    feePayer: authority.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
  }).add(SystemProgram.transfer({
    fromPubkey: authority.publicKey,
    toPubkey: recipient.publicKey,
    lamports: 1,
  }));
  const encoded = Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
  assert.throws(() => decodePreparedSolanaDelivery(encoded, authority.publicKey.toBase58()), /classic SPL Token instruction/);
});

test("provider discovery accepts supported injected Solana wallets only", () => {
  const provider = { signTransaction() {} };
  assert.equal(discoverSolanaSigningProvider({ phantom: { solana: provider } }), provider);
  assert.equal(discoverSolanaSigningProvider({ solflare: { connect() {} } }), null);
});
