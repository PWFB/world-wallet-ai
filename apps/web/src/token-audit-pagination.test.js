import test from "node:test";
import assert from "node:assert/strict";
import { mergeAuditPages, tokenTransferIdentity } from "./token-audit-pagination.js";

const owner = "0x" + "1".repeat(40);
const txHash = "0x" + "a".repeat(64);

function response(page, address) {
  return {
    page,
    networks: [{
      network: "ethereum",
      chain_id: 1,
      addresses: [address],
    }],
  };
}

test("pagination preserves distinct ERC-20 Transfer logs sharing one transaction hash", () => {
  const previous = response(1, {
    address: owner,
    token_transfers: [
      { tx_hash: txHash, log_index: "0", amount_raw: "100" },
      { tx_hash: txHash, log_index: "1", amount_raw: "200" },
    ],
    approvals: [],
    current_allowance_checks: [],
    warnings: [],
  });
  const next = response(2, {
    address: owner,
    token_transfers: [
      { tx_hash: txHash, log_index: "1", amount_raw: "200" },
      { tx_hash: txHash, log_index: "2", amount_raw: "300" },
    ],
    approvals: [],
    current_allowance_checks: [],
    warnings: [],
  });

  const merged = mergeAuditPages(previous, next);
  const transfers = merged.networks[0].addresses[0].token_transfers;
  assert.deepEqual(transfers.map(item => item.log_index), ["0", "1", "2"]);
  assert.deepEqual(transfers.map(item => item.amount_raw), ["100", "200", "300"]);
});

test("transfer row identity is unique per log and stable across pages", () => {
  const first = { tx_hash: txHash, log_index: "0", amount_raw: "100" };
  const second = { tx_hash: txHash, log_index: "1", amount_raw: "200" };
  assert.notEqual(tokenTransferIdentity(first), tokenTransferIdentity(second));
  assert.equal(tokenTransferIdentity(first), tokenTransferIdentity({ ...first }));
});

test("transfer fallback identity does not collapse different records when log index is absent", () => {
  const first = { tx_hash: txHash, amount_raw: "100" };
  const second = { tx_hash: txHash, amount_raw: "200" };
  assert.notEqual(tokenTransferIdentity(first), tokenTransferIdentity(second));
});

test("page two retains prior allowance checks when it has no new approval events", () => {
  const previous = response(1, {
    address: owner,
    token_transfers: [],
    approvals: [],
    current_allowance_checks: [{
      token_contract_address: "0x" + "2".repeat(40),
      spender_address: "0x" + "3".repeat(40),
      current_allowance_raw: "0",
      status: "verified_zero",
    }],
    warnings: ["approval history partial"],
  });
  const next = response(2, {
    address: owner,
    token_transfers: [],
    approvals: [],
    current_allowance_checks: [],
    warnings: [],
  });

  const merged = mergeAuditPages(previous, next);
  const address = merged.networks[0].addresses[0];
  assert.equal(address.current_allowance_checks.length, 1);
  assert.equal(address.current_allowance_checks[0].status, "verified_zero");
  assert.deepEqual(address.warnings, ["approval history partial"]);
});

test("newer current allowance evidence wins when the same token and spender recur", () => {
  const pair = {
    token_contract_address: "0x" + "2".repeat(40),
    spender_address: "0x" + "3".repeat(40),
  };
  const previous = response(1, {
    address: owner, token_transfers: [], approvals: [],
    current_allowance_checks: [{ ...pair, current_allowance_raw: "10", status: "verified_nonzero" }],
    warnings: [],
  });
  const next = response(2, {
    address: owner, token_transfers: [], approvals: [],
    current_allowance_checks: [{ ...pair, current_allowance_raw: "0", status: "verified_zero" }],
    warnings: [],
  });

  const merged = mergeAuditPages(previous, next);
  const checks = merged.networks[0].addresses[0].current_allowance_checks;
  assert.equal(checks.length, 1);
  assert.equal(checks[0].current_allowance_raw, "0");
  assert.equal(checks[0].status, "verified_zero");
});
