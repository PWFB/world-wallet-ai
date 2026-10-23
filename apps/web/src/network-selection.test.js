import test from "node:test";
import assert from "node:assert/strict";
import {
  cachedBalanceMatchesNetwork,
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
