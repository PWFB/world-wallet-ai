import test from "node:test";
import assert from "node:assert/strict";
import {
  availableAssetBalance,
  getMainnetAssetNetwork,
  isSupportedEvmReturnAsset,
  normalizeEvmChainId,
  normalizeOkxBitcoinAccount,
  normalizeOkxEvmAccount,
  normalizeOkxSolanaAccount,
} from "./okx-return.js";

const ETH = "0x1111111111111111111111111111111111111111";
const BTC = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
const SOL = "8w2P8gXnq3aK4oZt5vYj7uH6mS1cR9dF3kL2nB4pQ6aA";

test("normalizes hexadecimal and decimal EVM chain IDs", () => {
  assert.equal(normalizeEvmChainId("0x1"), 1);
  assert.equal(normalizeEvmChainId("0x38"), 56);
  assert.equal(normalizeEvmChainId("11155111"), 11155111);
  assert.equal(normalizeEvmChainId("0x0"), null);
  assert.equal(normalizeEvmChainId("unknown"), null);
});

test("accepts only an Ethereum or BNB Mainnet address from the matching chain", () => {
  assert.deepEqual(normalizeOkxEvmAccount([ETH], "0x1"), { network: "ethereum", chainId: 1, address: ETH });
  assert.deepEqual(normalizeOkxEvmAccount([ETH], "0x38"), { network: "bnb", chainId: 56, address: ETH });
  assert.equal(normalizeOkxEvmAccount([ETH], "0xaa36a7"), null);
  assert.equal(normalizeOkxEvmAccount(["not-an-address"], "0x1"), null);
});

test("accepts Bitcoin Mainnet addresses and rejects testnet addresses", () => {
  assert.equal(normalizeOkxBitcoinAccount([BTC]), BTC);
  assert.equal(normalizeOkxBitcoinAccount(["tb1qtestaddress"]), null);
  assert.equal(normalizeOkxBitcoinAccount(["not-an-address"]), null);
});

test("normalizes OKX Solana public keys", () => {
  assert.equal(normalizeOkxSolanaAccount({ publicKey: { toString: () => SOL } }), SOL);
  assert.equal(normalizeOkxSolanaAccount("not-a-solana-key"), null);
});

test("separates Mainnet assets from Sepolia and Devnet", () => {
  assert.equal(getMainnetAssetNetwork({ symbol: "ETH", network: "ethereum" }), "ethereum");
  assert.equal(getMainnetAssetNetwork({ symbol: "USDT", network: "bnb" }), "bnb");
  assert.equal(getMainnetAssetNetwork({ symbol: "BALMZ-SEP", network: "sepolia" }), null);
  assert.equal(getMainnetAssetNetwork({ symbol: "BALMZ-SOL-DEVNET", network: "solana_devnet" }), null);
  assert.equal(getMainnetAssetNetwork({ symbol: "SOL" }), "solana_mainnet");
});

test("limits prepared token returns to the EVM assets supported by current signing and settlement", () => {
  assert.equal(isSupportedEvmReturnAsset("ETH", "ethereum"), true);
  assert.equal(isSupportedEvmReturnAsset("USDT", "bnb"), true);
  assert.equal(isSupportedEvmReturnAsset("BALMZ-BNB", "bnb"), true);
  assert.equal(isSupportedEvmReturnAsset("USDC", "ethereum"), false);
  assert.equal(isSupportedEvmReturnAsset("SOL", "solana_mainnet"), false);
  assert.equal(isSupportedEvmReturnAsset("BTC", "bitcoin"), false);
});

test("available balance is finite, positive and not replaced with an estimate", () => {
  assert.equal(availableAssetBalance({ available_balance: 4 }), 4);
  assert.equal(availableAssetBalance({ balance: 2 }), 2);
  assert.equal(availableAssetBalance({ available_balance: "invalid", balance: 5 }), 0);
  assert.equal(availableAssetBalance({ available_balance: -2 }), 0);
});
