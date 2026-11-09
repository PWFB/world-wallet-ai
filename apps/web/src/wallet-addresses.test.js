import test from "node:test";
import assert from "node:assert/strict";
import {
  createWalletNumber,
  deriveWalletAddresses,
  encryptMnemonic,
  decryptMnemonic,
  signSolanaMessage,
} from "./wallet-addresses.js";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";

test("wallet IDs are unique 11-digit numeric identifiers", () => {
  const first = createWalletNumber([]);
  const second = createWalletNumber([first]);
  assert.match(first, /^\d{11}$/);
  assert.match(second, /^\d{11}$/);
  assert.notEqual(second, first);
});

test("one mainnet wallet derives compatible Ethereum and BNB addresses", async () => {
  const addresses = await deriveWalletAddresses(TEST_MNEMONIC);
  assert.equal(addresses.ethereum, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  assert.equal(addresses.bnb, addresses.ethereum);
  assert.match(addresses.bitcoin, /^bc1q[0-9a-z]{20,}$/);
  assert.equal(base58DecodedLength(addresses.solana_mainnet), 32);
});

test("testnet and devnet addresses are distinct from the mainnet derivation", async () => {
  const addresses = await deriveWalletAddresses(TEST_MNEMONIC);
  assert.notEqual(addresses.sepolia, addresses.ethereum);
  assert.notEqual(addresses.solana_devnet, addresses.solana_mainnet);
  assert.equal(base58DecodedLength(addresses.solana_devnet), 32);
});

test("wallet address derivation is deterministic for the same recovery phrase", async () => {
  const first = await deriveWalletAddresses(TEST_MNEMONIC);
  const second = await deriveWalletAddresses(TEST_MNEMONIC);
  assert.deepEqual(second, first);
});

test("encrypted recovery material round-trips and rejects a wrong password", async () => {
  const encrypted = await encryptMnemonic(TEST_MNEMONIC, "a-strong-test-password");
  assert.equal(typeof encrypted, "string");
  assert.equal(encrypted.includes(TEST_MNEMONIC), false);
  assert.equal(await decryptMnemonic(encrypted, "a-strong-test-password"), TEST_MNEMONIC);
  await assert.rejects(() => decryptMnemonic(encrypted, "wrong-password"));
});

function base58DecodedLength(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    assert.notEqual(digit, -1, "Solana address must use the Base58 alphabet");
    number = number * 58n + BigInt(digit);
  }
  let length = 0;
  while (number > 0n) {
    length += 1;
    number >>= 8n;
  }
  for (const character of value) {
    if (character !== "1") break;
    length += 1;
  }
  return length;
}


test("Solana ownership signatures match the derived mainnet and devnet public keys", async t => {
  if (!globalThis.crypto?.subtle) {
    t.skip("WebCrypto is unavailable in this test runtime.");
    return;
  }
  const addresses = await deriveWalletAddresses(TEST_MNEMONIC);
  for (const [network, accountIndex] of [["solana_mainnet", 0], ["solana_devnet", 1]]) {
    const message = "World Wallet AI ownership challenge " + network;
    const signature = await signSolanaMessage(TEST_MNEMONIC, accountIndex, message);
    const publicBytes = base58Decode(addresses[network]);
    const publicKey = await crypto.subtle.importKey("raw", publicBytes, { name: "Ed25519" }, false, ["verify"]);
    const signatureBytes = Uint8Array.from(atob(signature), character => character.charCodeAt(0));
    assert.equal(await crypto.subtle.verify("Ed25519", publicKey, signatureBytes, new TextEncoder().encode(message)), true);
  }
});

function base58Decode(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    assert.notEqual(digit, -1);
    number = number * 58n + BigInt(digit);
  }
  let bytes = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 255n));
    number >>= 8n;
  }
  const leading = value.match(/^1*/)?.[0].length || 0;
  bytes = [...new Array(leading).fill(0), ...bytes];
  return Uint8Array.from(bytes);
}
