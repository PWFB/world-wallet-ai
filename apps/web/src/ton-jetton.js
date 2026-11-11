import { Address, beginCell } from "@ton/core";

export function jettonAmountToUnits(amount, decimals) {
  const scale = Number(decimals);
  if (!Number.isInteger(scale) || scale < 0 || scale > 30) {
    throw new Error("Jetton decimals are missing or invalid; transfer is disabled.");
  }
  const input = String(amount ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(input)) {
    throw new Error("Enter a valid Jetton amount.");
  }
  const [whole, fraction = ""] = input.split(".");
  if (fraction.length > scale) {
    throw new Error("This Jetton supports at most " + scale + " decimal places.");
  }
  const units = BigInt(whole) * (10n ** BigInt(scale)) + BigInt((fraction + "0".repeat(scale)).slice(0, scale) || "0");
  if (units <= 0n) throw new Error("Jetton amount must be greater than zero.");
  return units.toString();
}

export function buildJettonTransferPayload({
  amount,
  decimals,
  destination,
  responseDestination,
  queryId = "0",
  forwardTonAmount = "1",
}) {
  const amountUnits = jettonAmountToUnits(amount, decimals);
  let query;
  let forward;
  try {
    query = BigInt(queryId);
    forward = BigInt(forwardTonAmount);
  } catch {
    throw new Error("Invalid Jetton transfer query or forward amount.");
  }
  if (query < 0n || query > 0xffffffffffffffffn || forward < 0n) {
    throw new Error("Jetton transfer query or forward amount is out of range.");
  }
  let recipient;
  let response;
  try {
    recipient = Address.parse(String(destination || "").trim());
    response = Address.parse(String(responseDestination || "").trim());
  } catch {
    throw new Error("Enter valid TON destination and response addresses.");
  }
  // TEP-74 transfer#0f8a7ea5. The connected wallet signs the outer TON
  // message; this body is sent to the sender's Jetton wallet contract.
  return beginCell()
    .storeUint(0x0f8a7ea5, 32)
    .storeUint(query, 64)
    .storeCoins(BigInt(amountUnits))
    .storeAddress(recipient)
    .storeAddress(response)
    .storeBit(0) // no custom_payload
    .storeCoins(forward)
    .storeBit(0) // empty forward_payload
    .endCell()
    .toBoc()
    .toString("base64");
}
