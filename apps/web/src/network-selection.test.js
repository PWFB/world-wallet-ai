import test from "node:test";
import assert from "node:assert/strict";
import {
  cachedBalanceMatchesNetwork,
  isTestnetNetwork,
  normalizeNetworkId,
  readSelectedNetwork,
} from "./network-selection.js";

test("keeps Solana Devnet selected after browser reload", () => {
  const persisted = "solana_devnet";
  assert.equal(readSelectedNetwork(persisted), "solana_devnet");
});

test("normalizes legacy Devnet labels without matching letter fragments", () => {
  assert.equal(normalizeNetworkId("Solana Devnet"), "solana_devnet");
  assert.equal(normalizeNetworkId("solana-devnet"), "solana_devnet");
  assert.equal(normalizeNetworkId("devnet"), "solana_devnet");
});

test("does not infer a chain from the ambiguous generic mainnet label", () => {
  assert.equal(normalizeNetworkId("mainnet"), "mainnet");
  assert.equal(readSelectedNetwork("unknown-network"), "ethereum");
});

test("restores a cached balance only for the selected network", () => {
  const cached = { network: "solana_devnet", balance: 12.5 };
  assert.equal(cachedBalanceMatchesNetwork(cached, "solana_devnet"), true);
  assert.equal(cachedBalanceMatchesNetwork(cached, "ethereum"), false);
  assert.equal(cachedBalanceMatchesNetwork({ network: "solana_devnet", balance: -1 }, "solana_devnet"), false);
  assert.equal(cachedBalanceMatchesNetwork({ network: "solana_devnet", balance: "unknown" }, "solana_devnet"), false);
});

test("keeps Sepolia and production Ethereum balances isolated", () => {
  assert.equal(cachedBalanceMatchesNetwork({ network: "sepolia", balance: 0.5 }, "ethereum"), false);
  assert.equal(cachedBalanceMatchesNetwork({ network: "ethereum", balance: 0.5 }, "sepolia"), false);
});

test("restores each supported canonical network without changing its identity", () => {
  for (const network of ["ethereum", "sepolia", "bnb", "bitcoin", "solana_devnet"]) {
    assert.equal(readSelectedNetwork(network), network);
  }
});

test("does not reuse a cached balance across production and test networks", () => {
  const balance = { balance: 1, network: "ethereum" };
  const devnetBalance = { balance: 1, network: "solana_devnet" };
  const sepoliaBalance = { balance: 1, network: "sepolia" };
  assert.equal(cachedBalanceMatchesNetwork(balance, "sepolia"), false);
  assert.equal(cachedBalanceMatchesNetwork(balance, "solana_devnet"), false);
  assert.equal(cachedBalanceMatchesNetwork(devnetBalance, "ethereum"), false);
  assert.equal(cachedBalanceMatchesNetwork(devnetBalance, "sepolia"), false);
  assert.equal(cachedBalanceMatchesNetwork(sepoliaBalance, "ethereum"), false);
  assert.equal(cachedBalanceMatchesNetwork(sepoliaBalance, "solana_devnet"), false);
});

test("identifies Sepolia and Solana Devnet as testnet evidence", () => {
  assert.equal(isTestnetNetwork("sepolia", "ETH"), true);
  assert.equal(isTestnetNetwork("Ethereum Sepolia", "ETH"), true);
  assert.equal(isTestnetNetwork("solana_devnet", "BALMZ-SOL-DEVNET"), true);
  assert.equal(isTestnetNetwork("Solana Devnet", "BALMZ-SOL-DEVNET"), true);
});

test("testnet-qualified BALMZ assets stay testnet evidence even if the row network is missing or stale", () => {
  assert.equal(isTestnetNetwork("", "BALMZ-SEP"), true);
  assert.equal(isTestnetNetwork("ethereum", "BALMZ-SEP"), true);
  assert.equal(isTestnetNetwork("", "BALMZ-SOL-DEVNET"), true);
  assert.equal(isTestnetNetwork("ethereum", "BALMZ-SOL-DEVNET"), true);
});

test("does not misclassify production BALMZ as testnet evidence", () => {
  assert.equal(isTestnetNetwork("ethereum", "BALMZ"), false);
  assert.equal(isTestnetNetwork("bnb", "USDT-BNB"), false);
  assert.equal(isTestnetNetwork("bitcoin", "BTC"), false);
});
