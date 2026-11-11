import test from "node:test";
import assert from "node:assert/strict";
import { getVerifiedAvailableBalance, indexVerifiedBalances } from "./verified-balances.js";

test("keeps a verified on-chain zero distinct from an unavailable balance", () => {
  const report = {
    assets: [
      { asset: "ETH", network: "ethereum", verified: true, available_balance: 0 },
      { asset: "ADA", network: null, verified: false, available_balance: null, ledger_available_balance: 0 },
    ],
  };
  const index = indexVerifiedBalances(report);
  assert.equal(index.get("ETH").available_balance, 0);
  assert.equal(index.has("ADA"), false);
  assert.equal(getVerifiedAvailableBalance(report, "ETH"), 0);
  assert.equal(getVerifiedAvailableBalance(report, "ADA"), null);
});

test("does not promote ledger-only values or stale unverified zeroes", () => {
  const report = {
    assets: [
      { asset: "BTC", verified: false, available_balance: null, ledger_available_balance: 2 },
      { asset: "XRP", verified: false, available_balance: 0, ledger_available_balance: 0 },
      { asset: "LTC", verified: true, available_balance: null },
    ],
  };
  const index = indexVerifiedBalances(report);
  assert.equal(index.size, 0);
  assert.equal(getVerifiedAvailableBalance(report, "BTC"), null);
  assert.equal(getVerifiedAvailableBalance(report, "XRP"), null);
  assert.equal(getVerifiedAvailableBalance(report, "LTC"), null);
});

test("accepts only finite non-negative verified values and normalizes symbols", () => {
  const report = {
    assets: [
      { asset: "usdt-bnb", verified: true, available_balance: "3.75" },
      { asset: "DOGE", verified: true, available_balance: -1 },
      { asset: "ADA", verified: true, available_balance: "not-a-number" },
      { asset: " ", verified: true, available_balance: 5 },
    ],
  };
  const index = indexVerifiedBalances(report);
  assert.equal(index.get("USDT-BNB").available_balance, 3.75);
  assert.equal(index.has("DOGE"), false);
  assert.equal(index.has("ADA"), false);
  assert.equal(index.size, 1);
});
