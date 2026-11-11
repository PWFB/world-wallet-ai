import test from "node:test";
import assert from "node:assert/strict";
import { isValidTonAddress, tonFriendlyAddress, tonNetworkFromChainId, tonToNano } from "./ton-address.js";

const RAW = "-1:e56754f83426f69b09267bd876ac97c44821345b7e266bd956a7bfbfb98df35c";
const FRIENDLY = "Ef_lZ1T4NCb2mwkme9h2rJfESCE0W34ma9lWp7-_uY3zXDvq";

test("validates TON raw and checksummed friendly addresses", () => {
  assert.equal(isValidTonAddress(RAW), true);
  assert.equal(isValidTonAddress(FRIENDLY), true);
  assert.equal(isValidTonAddress(FRIENDLY.slice(0, -1) + "A"), false);
  assert.equal(isValidTonAddress("not-a-ton-address"), false);
});

test("converts raw TON addresses to checksummed mainnet and test-only friendly forms", () => {
  const mainnet = tonFriendlyAddress(RAW, false);
  const testnet = tonFriendlyAddress(RAW, true);
  assert.equal(isValidTonAddress(mainnet), true);
  assert.equal(isValidTonAddress(testnet), true);
  assert.notEqual(mainnet, testnet);
});

test("maps TonConnect chain IDs to separate TON networks", () => {
  assert.equal(tonNetworkFromChainId("-239"), "ton_mainnet");
  assert.equal(tonNetworkFromChainId("-3"), "ton_testnet");
  assert.equal(tonNetworkFromChainId("1"), "");
});

test("converts TON amounts to nanoTON without floating point", () => {
  assert.equal(tonToNano("1"), "1000000000");
  assert.equal(tonToNano("0.000000001"), "1");
  assert.equal(tonToNano("12.340000001"), "12340000001");
  assert.throws(() => tonToNano("0"));
  assert.throws(() => tonToNano("0.0000000001"));
});
