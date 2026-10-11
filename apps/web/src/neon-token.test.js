import test from "node:test";
import assert from "node:assert/strict";
import { getNeonTokenExpiry, isUsableNeonAccessToken } from "./neon-token.js";

function token(payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return encode({ alg: "none" }) + "." + encode(payload) + ".signature";
}

test("accepts a well-formed token with sufficient remaining lifetime", () => {
  assert.equal(isUsableNeonAccessToken(token({ exp: 2000 }), 1000), true);
});

test("rejects an expired token", () => {
  assert.equal(isUsableNeonAccessToken(token({ exp: 900 }), 1000), false);
});

test("rejects tokens inside the clock-skew margin", () => {
  assert.equal(isUsableNeonAccessToken(token({ exp: 1020 }), 1000), false);
});

test("reads expiry from well-formed JWT payloads", () => {
  assert.equal(getNeonTokenExpiry(token({ exp: 2000 })), 2000);
  assert.equal(getNeonTokenExpiry("not-a-jwt"), null);
  assert.equal(getNeonTokenExpiry(token({ sub: "user" })), null);
});

test("accepts valid UTF-8 claims with Unicode names", () => {
  assert.equal(isUsableNeonAccessToken(token({ exp: 2000, name: "Alábá 🌍" }), 1000), true);
});

test("rejects missing expiry, malformed JWTs, and non-strings", () => {
  assert.equal(isUsableNeonAccessToken(token({ sub: "user" }), 1000), false);
  assert.equal(isUsableNeonAccessToken("not-a-jwt", 1000), false);
  assert.equal(isUsableNeonAccessToken(null, 1000), false);
});
