import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import {
  verifyEvmMessageSignature,
  verifyEvmTypedDataSignature,
} from "./wallet-signatures.js";

test("personal-message signature verifies against its recovered EOA", async () => {
  const wallet = Wallet.createRandom();
  const message = "World Wallet AI signature verification test";
  const signature = await wallet.signMessage(message);
  const result = verifyEvmMessageSignature(message, signature, wallet.address);
  assert.equal(result.valid, true);
  assert.equal(result.recoveredAddress, wallet.address);
  assert.equal(result.signatureType, "personal_sign");
});

test("personal-message signature rejects a different expected address", async () => {
  const wallet = Wallet.createRandom();
  const other = Wallet.createRandom();
  const signature = await wallet.signMessage("same message");
  assert.equal(verifyEvmMessageSignature("same message", signature, other.address).valid, false);
});

test("personal-message signature rejects altered content", async () => {
  const wallet = Wallet.createRandom();
  const signature = await wallet.signMessage("original");
  assert.equal(verifyEvmMessageSignature("altered", signature, wallet.address).valid, false);
});

test("EIP-712 typed-data signature verifies and detects wrong signer", async () => {
  const wallet = Wallet.createRandom();
  const other = Wallet.createRandom();
  const domain = { name: "World Wallet AI", version: "1", chainId: 1 };
  const types = {
    WalletVerification: [
      { name: "wallet", type: "address" },
      { name: "nonce", type: "string" },
    ],
  };
  const value = { wallet: wallet.address, nonce: "test-nonce-001" };
  const signature = await wallet.signTypedData(domain, types, value);
  assert.equal(verifyEvmTypedDataSignature(domain, types, value, signature, wallet.address).valid, true);
  assert.equal(verifyEvmTypedDataSignature(domain, types, value, signature, other.address).valid, false);
});

test("verification rejects malformed signature and address", () => {
  assert.throws(() => verifyEvmMessageSignature("message", "0x1234", "bad-address"), /valid expected EVM address/);
  assert.throws(() => verifyEvmMessageSignature("message", "0x1234", "0x1111111111111111111111111111111111111111"), /65-byte EVM signature/);
});
