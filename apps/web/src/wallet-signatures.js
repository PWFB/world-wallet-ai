import { getAddress, isAddress, verifyMessage, verifyTypedData } from "ethers";

function validateEvmSignature(signature) {
  return typeof signature === "string" && /^0x[0-9a-fA-F]{130}$/.test(signature.trim());
}

/**
 * Verify a standard EVM personal-message signature by recovering its EOA signer.
 * This is an off-chain signature check, not proof that a transaction was mined.
 */
export function verifyEvmMessageSignature(message, signature, expectedAddress) {
  if (typeof message !== "string" || !message.length) {
    throw new Error("Enter the exact original signed message.");
  }
  if (!isAddress(String(expectedAddress || "").trim())) {
    throw new Error("Enter a valid expected EVM address.");
  }
  if (!validateEvmSignature(signature)) {
    throw new Error("A 65-byte EVM signature is required.");
  }
  const recoveredAddress = getAddress(verifyMessage(message, signature.trim()));
  const normalizedExpected = getAddress(expectedAddress.trim());
  return {
    valid: recoveredAddress.toLowerCase() === normalizedExpected.toLowerCase(),
    recoveredAddress,
    expectedAddress: normalizedExpected,
    signatureType: "personal_sign",
  };
}

/**
 * Verify EIP-712 typed data by recovering the signing EOA.
 * EIP-1271 contract-wallet validation is intentionally separate and not inferred here.
 */
export function verifyEvmTypedDataSignature(domain, types, value, signature, expectedAddress) {
  if (!domain || typeof domain !== "object" || Array.isArray(domain)) {
    throw new Error("Typed-data domain must be a JSON object.");
  }
  if (!types || typeof types !== "object" || Array.isArray(types) || !Object.keys(types).length) {
    throw new Error("Typed-data types must be a non-empty JSON object.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Typed-data message must be a JSON object.");
  }
  if (!isAddress(String(expectedAddress || "").trim())) {
    throw new Error("Enter a valid expected EVM address.");
  }
  if (!validateEvmSignature(signature)) {
    throw new Error("A 65-byte EVM typed-data signature is required.");
  }
  const recoveredAddress = getAddress(verifyTypedData(domain, types, value, signature.trim()));
  const normalizedExpected = getAddress(expectedAddress.trim());
  return {
    valid: recoveredAddress.toLowerCase() === normalizedExpected.toLowerCase(),
    recoveredAddress,
    expectedAddress: normalizedExpected,
    signatureType: "eip712",
  };
}
