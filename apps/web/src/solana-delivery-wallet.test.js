import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  decodePreparedSolanaDelivery,
  discoverSolanaSigningProvider,
  signPreparedSolanaDelivery,
} from "./solana-delivery-wallet.js";

function prepared(authority, recipient) {
  const transaction = new Transaction({
    feePayer: authority.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
  }).add(SystemProgram.transfer({
    fromPubkey: authority.publicKey,
    toPubkey: recipient.publicKey,
    lamports: 1,
  }));
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

test("provider discovery accepts supported injected Solana wallets only", () => {
  const provider = { signTransaction() {} };
  assert.equal(discoverSolanaSigningProvider({ phantom: { solana: provider } }), provider);
  assert.equal(discoverSolanaSigningProvider({ solflare: { connect() {} } }), null);
});
