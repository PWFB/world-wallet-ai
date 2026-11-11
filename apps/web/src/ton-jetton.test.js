import test from "node:test";
import assert from "node:assert/strict";
import { Address, Cell } from "@ton/core";
import { buildJettonTransferPayload, jettonAmountToUnits } from "./ton-jetton.js";

const SENDER = "0:" + "1".repeat(64);
const RECIPIENT = "0:" + "2".repeat(64);

test("converts Jetton amounts using metadata decimals without float rounding", () => {
  assert.equal(jettonAmountToUnits("1", 9), "1000000000");
  assert.equal(jettonAmountToUnits("1.234567", 6), "1234567");
  assert.equal(jettonAmountToUnits("0.00000001", 8), "1");
  assert.throws(() => jettonAmountToUnits("1.0000001", 6));
  assert.throws(() => jettonAmountToUnits("1", null));
  assert.throws(() => jettonAmountToUnits("1", undefined));
  assert.throws(() => jettonAmountToUnits("1", ""));
  assert.throws(() => jettonAmountToUnits("0", 9));
});

test("builds a TEP-74 transfer body with exact recipient and response destination", () => {
  const payload = buildJettonTransferPayload({
    amount: "12.345",
    decimals: 3,
    destination: RECIPIENT,
    responseDestination: SENDER,
  });
  const cell = Cell.fromBoc(Buffer.from(payload, "base64"))[0];
  const slice = cell.beginParse();
  assert.equal(slice.loadUint(32), 0x0f8a7ea5);
  assert.equal(slice.loadUintBig(64), 0n);
  assert.equal(slice.loadCoins(), 12345n);
  assert.equal(slice.loadAddress().toRawString(), Address.parse(RECIPIENT).toRawString());
  assert.equal(slice.loadAddress().toRawString(), Address.parse(SENDER).toRawString());
  assert.equal(slice.loadBit(), false);
  assert.equal(slice.loadCoins(), 1n);
  assert.equal(slice.loadBit(), false);
  assert.equal(slice.remainingBits, 0);
});
