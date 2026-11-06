import test from "node:test";
import assert from "node:assert/strict";
import { HDNodeWallet } from "ethers";
import { deriveWalletAddressBundle } from "./wallet-addresses.js";
import { getLocalVaultReceiveAddresses, ACTIVE_WALLET_STORAGE_KEY, VAULT_STORAGE_KEY } from "./receive-addresses.js";
import { generateWalletNumber } from "./wallet-number.js";
import { webcrypto } from "node:crypto";

const phraseA = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const phraseB = "legal winner thank year wave sausage worth useful legal winner thank yellow";

test("derives the standard EVM mainnet account and a separate Sepolia account", () => {
  const addresses = deriveWalletAddressBundle(phraseA);
  const byNetwork = Object.fromEntries(addresses.map(item => [item.network, item.address]));
  assert.equal(byNetwork.ethereum, HDNodeWallet.fromPhrase(phraseA, "", "m/44'/60'/0'/0/0").address);
  assert.equal(byNetwork.bnb, byNetwork.ethereum);
  assert.equal(byNetwork.sepolia, HDNodeWallet.fromPhrase(phraseA, "", "m/44'/60'/1'/0/0").address);
  assert.notEqual(byNetwork.sepolia, byNetwork.ethereum);
});

test("derives Bitcoin mainnet and separate Solana mainnet / Devnet addresses", () => {
  const addresses = deriveWalletAddressBundle(phraseA);
  const byNetwork = Object.fromEntries(addresses.map(item => [item.network, item.address]));
  assert.match(byNetwork.bitcoin, /^bc1q[0-9a-z]{30,}$/);
  assert.match(byNetwork.solana_mainnet, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.match(byNetwork.solana_devnet, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.notEqual(byNetwork.solana_devnet, byNetwork.solana_mainnet);
});

test("each new recovery phrase creates a separate multi-chain wallet", () => {
  const first = Object.fromEntries(deriveWalletAddressBundle(phraseA).map(item => [item.network, item.address]));
  const second = Object.fromEntries(deriveWalletAddressBundle(phraseB).map(item => [item.network, item.address]));
  for (const network of Object.keys(first)) assert.notEqual(first[network], second[network], network);
});

test("Receive reads only the active wallet's public address bundle", () => {
  const walletA = deriveWalletAddressBundle(phraseA);
  const walletB = deriveWalletAddressBundle(phraseB);
  const entries = [
    { walletId: "12345678901", name: "Wallet A", networkAddresses: walletA },
    { walletId: "23456789012", name: "Wallet B", networkAddresses: walletB },
  ];
  const values = new Map([
    [VAULT_STORAGE_KEY, JSON.stringify(entries)],
    [ACTIVE_WALLET_STORAGE_KEY, "23456789012"],
  ]);
  const storage = { getItem: key => values.get(key) || null };
  const shown = getLocalVaultReceiveAddresses(storage);
  assert.equal(shown.length, 6);
  assert.ok(shown.every(item => item.walletId === "23456789012"));
  assert.deepEqual(shown.map(item => item.network), ["ethereum", "bnb", "bitcoin", "solana_mainnet", "sepolia", "solana_devnet"]);
});

test("fails closed when no active wallet exists or vault data is invalid", () => {
  const storage = { getItem: key => key === VAULT_STORAGE_KEY ? "{" : null };
  assert.deepEqual(getLocalVaultReceiveAddresses(storage), []);
});

test("generates an 11-digit numeric wallet number and avoids local duplicates", () => {
  let call = 0;
  const cryptoProvider = {
    getRandomValues(bytes) {
      bytes[0] = 0;
      bytes[1] = call++;
      return bytes;
    },
  };
  const value = generateWalletNumber([{ walletId: "10000000000" }], cryptoProvider);
  assert.match(value, /^\\d{11}$/);
  assert.equal(value, "10000000001");
});

test("rejects wallet number generation without a secure random source", () => {
  assert.throws(() => generateWalletNumber([], null), /Secure random/);
});

test("recovery phrase encryption round-trips locally and rejects a wrong password", async () => {
  const { encryptRecoveryPhrase, decryptRecoveryPhrase } = await import("./wallet-addresses.js");
  const encrypted = await encryptRecoveryPhrase(phraseA, "correct horse battery");
  assert.equal(await decryptRecoveryPhrase(encrypted, "correct horse battery"), phraseA);
  await assert.rejects(() => decryptRecoveryPhrase(encrypted, "incorrect password"));
});
