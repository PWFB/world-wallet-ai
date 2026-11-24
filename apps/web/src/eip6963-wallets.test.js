import test from "node:test";
import assert from "node:assert/strict";
import { discoverEip6963Providers, networkForEvmChain, normalizeEvmChainId, withProviderTimeout } from "./eip6963-wallets.js";

test("normalizes decimal and hexadecimal EVM chain IDs", () => {
  assert.equal(normalizeEvmChainId("0x38"), 56);
  assert.equal(normalizeEvmChainId("1"), 1);
  assert.equal(normalizeEvmChainId(11155111), 11155111);
  assert.ok(Number.isNaN(normalizeEvmChainId("not-a-chain")));
});

test("maps only the supported Ethereum, BNB and Sepolia networks", () => {
  assert.equal(networkForEvmChain("0x1"), "ethereum");
  assert.equal(networkForEvmChain(56), "bnb");
  assert.equal(networkForEvmChain("11155111"), "sepolia");
  assert.equal(networkForEvmChain(137), "");
});

test("discovers EIP-6963 providers and de-duplicates injected fallbacks", async () => {
  const target = new EventTarget();
  const provider = { request: async () => [] };
  target.ethereum = provider;
  target.dispatchEvent = event => {
    if (event.type === "eip6963:requestProvider") {
      const announced = new Event("eip6963:announceProvider");
      Object.defineProperty(announced, "detail", { value: { info: { name: "Example Wallet", rdns: "com.example", uuid: "wallet-1" }, provider } });
      EventTarget.prototype.dispatchEvent.call(target, announced);
    }
    return EventTarget.prototype.dispatchEvent.call(target, event);
  };
  const results = await discoverEip6963Providers(target, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "Example Wallet");
  assert.equal(results[0].rdns, "com.example");
  assert.equal(results[0].provider, provider);
});

test("discovers multiple providers from the injected providers array", async () => {
  const target = new EventTarget();
  const first = { request: async () => [] };
  const second = { request: async () => [] };
  target.ethereum = { request: first.request, providers: [first, second] };
  const results = await discoverEip6963Providers(target, 0);
  assert.equal(results.length, 3);
});

test("provider requests reject with a clear timeout message", async () => {
  await assert.rejects(
    withProviderTimeout(new Promise(() => {}), 2, "Wallet account request"),
    /Wallet account request timed out/
  );
});

test("provider request results pass through unchanged", async () => {
  assert.deepEqual(await withProviderTimeout(Promise.resolve(["0xabc"]), 100, "Wallet request"), ["0xabc"]);
});
