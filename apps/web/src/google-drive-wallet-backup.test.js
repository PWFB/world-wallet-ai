import test from "node:test";
import assert from "node:assert/strict";
import { createWalletBackupPayload, isWalletBackupFile, parseWalletBackupContent } from "./google-drive-wallet-backup.js";

const encryptedWallet = {
  name: "Test wallet",
  address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  addresses: { ethereum: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", bnb: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
  network: "ethereum",
  encryptedJson: JSON.stringify({ crypto: { cipher: "aes-128-ctr" } }),
  encryptedMnemonic: JSON.stringify({ version: 1, kdf: "PBKDF2-SHA256", cipher: "AES-256-GCM" }),
  createdAt: "2026-01-01T00:00:00.000Z",
};

test("filters backup-like files without treating arbitrary Drive files as wallet backups", () => {
  assert.equal(isWalletBackupFile({ name: "wallet-backup.json", mimeType: "application/json" }), true);
  assert.equal(isWalletBackupFile({ name: "family-photo.jpg", mimeType: "image/jpeg" }), false);
});

test("parses a plain 12-word phrase locally", () => {
  const parsed = parseWalletBackupContent("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
  assert.equal(parsed.kind, "mnemonic");
  assert.equal(parsed.phrase.split(" ").length, 12);
});

test("parses a phrase from a supported JSON field", () => {
  const parsed = parseWalletBackupContent(JSON.stringify({ recovery_phrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" }));
  assert.equal(parsed.kind, "mnemonic");
});

test("round-trips the encrypted World Wallet AI backup format", () => {
  const payload = createWalletBackupPayload(encryptedWallet);
  const parsed = parseWalletBackupContent(JSON.stringify(payload));
  assert.equal(parsed.kind, "encrypted");
  assert.equal(parsed.wallet.address, encryptedWallet.address);
  assert.equal(parsed.wallet.encryptedMnemonic, encryptedWallet.encryptedMnemonic);
});

test("rejects unsupported or incomplete backup content", () => {
  assert.throws(() => parseWalletBackupContent("hello world"), /Unsupported backup/);
  assert.throws(() => parseWalletBackupContent(JSON.stringify({
    format: "world-wallet-ai-encrypted-backup-v1", version: 1,
    wallet: { encryptedJson: "{}", encryptedMnemonic: "{}", address: "bad" }
  })), /valid Ethereum public address/);
});
