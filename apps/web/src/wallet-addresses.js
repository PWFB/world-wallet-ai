import { HDNodeWallet } from "ethers";
import { HDKey } from "@scure/bip32";
import { payments, networks as bitcoinNetworks, initEccLib } from "bitcoinjs-lib";
import * as secp256k1 from "tiny-secp256k1";
import { derivePath as deriveEd25519Path } from "ed25519-hd-key";
import { Keypair } from "@solana/web3.js";
import { Buffer } from "buffer";

initEccLib(secp256k1);

const EVM_MAINNET_PATH = "m/44'/60'/0'/0/0";
const EVM_TESTNET_PATH = "m/44'/60'/1'/0/0";
const BITCOIN_MAINNET_PATH = "m/84'/0'/0'/0/0";
const SOLANA_MAINNET_PATH = "m/44'/501'/0'/0'";
const SOLANA_DEVNET_PATH = "m/44'/501'/1'/0'";

function bytesToHex(value) {
  return Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");
}

function deriveBitcoinMainnetAddress(seed) {
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(BITCOIN_MAINNET_PATH);
  if (!child.publicKey) throw new Error("Bitcoin mainnet public key derivation failed.");
  const payment = payments.p2wpkh({
    pubkey: Buffer.from(child.publicKey),
    network: bitcoinNetworks.bitcoin,
  });
  if (!payment.address) throw new Error("Bitcoin mainnet address derivation failed.");
  return payment.address;
}

function deriveSolanaAddress(seedHex, derivationPath) {
  const child = deriveEd25519Path(derivationPath, seedHex);
  const keypair = Keypair.fromSeed(new Uint8Array(child.key));
  return keypair.publicKey.toBase58();
}

/**
 * Derive public receiving addresses for one BIP-39 wallet.
 *
 * Ethereum and BNB Chain intentionally use the same mainnet EVM account.
 * Sepolia uses a separate EVM account path. Solana Devnet uses a separate
 * hardened account path from Solana Mainnet. No private key is returned.
 */
export function deriveWalletAddressBundle(mnemonic) {
  const phrase = String(mnemonic || "").trim();
  if (!phrase) throw new Error("A valid recovery phrase is required.");

  const master = HDNodeWallet.fromPhrase(phrase);
  if (!master.mnemonic) throw new Error("The recovery phrase could not be loaded.");
  const seed = master.mnemonic.computeSeed();
  const seedHex = bytesToHex(seed);

  const ethereum = HDNodeWallet.fromPhrase(phrase, "", EVM_MAINNET_PATH);
  const sepolia = HDNodeWallet.fromPhrase(phrase, "", EVM_TESTNET_PATH);
  const bitcoin = deriveBitcoinMainnetAddress(seed);
  const solanaMainnet = deriveSolanaAddress(seedHex, SOLANA_MAINNET_PATH);
  const solanaDevnet = deriveSolanaAddress(seedHex, SOLANA_DEVNET_PATH);

  return [
    { network: "ethereum", address: ethereum.address, label: "Ethereum Mainnet", environment: "mainnet" },
    { network: "bnb", address: ethereum.address, label: "BNB Chain", environment: "mainnet" },
    { network: "bitcoin", address: bitcoin, label: "Bitcoin Mainnet", environment: "mainnet" },
    { network: "solana_mainnet", address: solanaMainnet, label: "Solana Mainnet", environment: "mainnet" },
    { network: "sepolia", address: sepolia.address, label: "Ethereum Sepolia", environment: "testnet" },
    { network: "solana_devnet", address: solanaDevnet, label: "Solana Devnet", environment: "devnet" },
  ];
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function deriveVaultEncryptionKey(password, salt, cryptoProvider) {
  const material = await cryptoProvider.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return cryptoProvider.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt the BIP-39 phrase locally so every network key can be restored.
 * The envelope is stored only in the browser vault and is never sent to API.
 */
export async function encryptRecoveryPhrase(mnemonic, password, cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.subtle || !cryptoProvider?.getRandomValues) {
    throw new Error("Secure browser cryptography is unavailable.");
  }
  if (typeof password !== "string" || password.length < 10) {
    throw new Error("Use a vault password of at least 10 characters.");
  }
  const phrase = String(mnemonic || "").trim();
  if (!phrase) throw new Error("A recovery phrase is required.");

  const salt = cryptoProvider.getRandomValues(new Uint8Array(16));
  const iv = cryptoProvider.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultEncryptionKey(password, salt, cryptoProvider);
  const ciphertext = await cryptoProvider.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textEncoder.encode(phrase),
  );

  return JSON.stringify({
    version: 1,
    algorithm: "PBKDF2-SHA256/AES-256-GCM",
    iterations: 310000,
    salt: encodeBase64(salt),
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  });
}

export async function decryptRecoveryPhrase(envelope, password, cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.subtle) throw new Error("Secure browser cryptography is unavailable.");
  const stored = typeof envelope === "string" ? JSON.parse(envelope) : envelope;
  if (!stored || stored.version !== 1 || stored.algorithm !== "PBKDF2-SHA256/AES-256-GCM" || stored.iterations !== 310000) {
    throw new Error("Unsupported encrypted recovery phrase.");
  }
  const salt = decodeBase64(stored.salt);
  const iv = decodeBase64(stored.iv);
  const ciphertext = decodeBase64(stored.ciphertext);
  const key = await deriveVaultEncryptionKey(password, salt, cryptoProvider);
  const plaintext = await cryptoProvider.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return textDecoder.decode(plaintext);
}
