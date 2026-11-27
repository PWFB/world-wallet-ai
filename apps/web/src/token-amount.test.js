import test from "node:test";
import assert from "node:assert/strict";
import { formatTokenAmountExact } from "./token-amount.js";

test("groups whole token amounts without numeric conversion", () => {
  assert.equal(formatTokenAmountExact("12345678901234567890"), "12,345,678,901,234,567,890");
});

test("preserves all meaningful fractional digits through nine decimals", () => {
  assert.equal(formatTokenAmountExact("1000000000.000000001"), "1,000,000,000.000000001");
  assert.equal(formatTokenAmountExact("0.123456789"), "0.123456789");
});

test("trims only insignificant trailing fractional zeroes", () => {
  assert.equal(formatTokenAmountExact("1234.560000000"), "1,234.56");
  assert.equal(formatTokenAmountExact("42.000000000"), "42");
  assert.equal(formatTokenAmountExact("42"), "42");
});

test("rejects malformed, signed, exponential, and over-precision values", () => {
  for (const value of ["", " ", null, undefined, "-1", "+1", "1e9", "1.1234567890", "1.2.3", "NaN", "Infinity", "1,000"]) {
    assert.equal(formatTokenAmountExact(value), "Unavailable", String(value));
  }
});
