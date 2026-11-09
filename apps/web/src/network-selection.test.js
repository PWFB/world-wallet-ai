import test from "node:test";
import assert from "node:assert/strict";
import {
  cachedBalanceMatchesNetwork,
  isTestnetNetwork,
  normalizeNetworkId,
  readSelectedNetwork,
  networkEnvironment,
  defaultNetworkForEnvironment,
} from "./network-selection.js";

test("keeps Solana Devnet selected after browser reload", () => {
  const persisted = "solana_devnet";
  assert.equal(readSelectedNetwork(persisted), "solana_devnet");
});

test("normalizes explicit Devnet labels without matching letter fragments", () => {
  assert.equal(normalizeNetworkId("Solana Devnet"), "solana_devnet");
  assert.equal(normalizeNetworkId("solana-devnet"), "solana_devnet");
  assert.equal(normalizeNetworkId("devnet"), "solana_devnet");
});

test("keeps Solana Mainnet distinct from Solana Devnet", () => {
  assert.equal(normalizeNetworkId("Solana"), "solana_mainnet");
  assert.equal(normalizeNetworkId("solana-mainnet"), "solana_mainnet");
  assert.equal(normalizeNetworkId("mainnet-beta"), "solana_mainnet");
  assert.equal(normalizeNetworkId("solana-devnet"), "solana_devnet");
  assert.equal(readSelectedNetwork("solana"), "solana_mainnet");
  assert.equal(readSelectedNetwork("solana_devnet"), "solana_devnet");
  assert.notEqual(normalizeNetworkId("solana"), normalizeNetworkId("solana_devnet"));
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
  for (const network of ["ethereum", "sepolia", "bnb", "bitcoin", "solana_mainnet", "solana_devnet"]) {
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

test("keeps cached Solana Mainnet balances separate from Devnet balances", () => {
  const mainnet = { network: "solana_mainnet", balance: 8.25 };
  const devnet = { network: "solana_devnet", balance: 100 };
  assert.equal(cachedBalanceMatchesNetwork(mainnet, "solana_mainnet"), true);
  assert.equal(cachedBalanceMatchesNetwork({ network: "solana", balance: 8.25 }, "solana_mainnet"), true);
  assert.equal(cachedBalanceMatchesNetwork(mainnet, "solana_devnet"), false);
  assert.equal(cachedBalanceMatchesNetwork(devnet, "solana_mainnet"), false);
});

test("Solana Mainnet is production while Devnet remains test-only", () => {
  assert.equal(isTestnetNetwork("solana", "SOL"), false);
  assert.equal(isTestnetNetwork("solana_mainnet", "BALMZ"), false);
  assert.equal(isTestnetNetwork("solana_devnet", "BALMZ-SOL-DEVNET"), true);
});

test("maps Mainnet and Devnet environments to isolated default networks", () => {
  assert.equal(defaultNetworkForEnvironment("mainnet"), "ethereum");
  assert.equal(defaultNetworkForEnvironment("devnet"), "solana_devnet");
  assert.equal(networkEnvironment("ethereum"), "mainnet");
  assert.equal(networkEnvironment("bnb"), "mainnet");
  assert.equal(networkEnvironment("bitcoin"), "mainnet");
  assert.equal(networkEnvironment("solana_mainnet"), "mainnet");
  assert.equal(networkEnvironment("sepolia"), "devnet");
  assert.equal(networkEnvironment("solana_devnet"), "devnet");
});
