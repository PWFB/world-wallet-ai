import test from "node:test";
import assert from "node:assert/strict";
import { inspectEvmTransaction, normalizeChainId } from "./wallet-safety.js";

const sender = "0x52921fb05200ebfba6d33f5f023dc6e3e525fb83";
const recipient = "0x000000000000000000000000000000000000dead";

test("normalizes decimal and hexadecimal chain IDs", () => {
  assert.equal(normalizeChainId("0x1"), 1);
  assert.equal(normalizeChainId("11155111"), 11155111);
  assert.equal(normalizeChainId("bad"), null);
});

test("accepts a valid mainnet native transfer preview without enabling signing", () => {
  const result = inspectEvmTransaction({ from: sender, to: recipient, value: "0.01", data: "0x", expectedChainId: 1, actualChainId: "0x1" });
  assert.equal(result.valid, true);
  assert.equal(result.canSign, false);
  assert.equal(result.method, "Native ETH transfer");
  assert.equal(result.valueWei, "10000000000000000");
});

test("blocks a chain mismatch", () => {
  const result = inspectEvmTransaction({ from: sender, to: recipient, expectedChainId: 1, actualChainId: 11155111 });
  assert.equal(result.valid, false);
  assert.ok(result.findings.some(item => item.code === "chain_mismatch" && item.severity === "blocker"));
});

test("blocks malformed addresses and calldata", () => {
  const result = inspectEvmTransaction({ from: "bad", to: "0x1234", value: "0", data: "0x123", expectedChainId: 1, actualChainId: 1 });
  assert.equal(result.valid, false);
  assert.ok(result.findings.some(item => item.code === "invalid_sender"));
  assert.ok(result.findings.some(item => item.code === "invalid_recipient"));
  assert.ok(result.findings.some(item => item.code === "invalid_calldata"));
});

test("warns about ERC-20 approvals", () => {
  const result = inspectEvmTransaction({ from: sender, to: recipient, value: "0", data: "0x095ea7b3" + "0".repeat(128), expectedChainId: 1, actualChainId: 1 });
  assert.ok(result.findings.some(item => item.code === "token_approval" && item.severity === "warning"));
});
