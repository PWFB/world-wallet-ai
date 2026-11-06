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
