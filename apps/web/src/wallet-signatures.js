import { Interface, getAddress, isAddress, isHexString, verifyMessage, verifyTypedData } from "ethers";

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


const ERC1271_INTERFACE = new Interface([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
export const ERC1271_MAGIC_VALUE = "0x1626ba7e";

/**
 * Read-only ERC-1271 verification. The wallet decides whether the supplied
 * digest/signature is valid; this helper never signs or sends a transaction.
 */
export async function verifyEip1271Signature(provider, walletAddress, digest, signature, expectedChainId) {
  if (!provider || typeof provider.getNetwork !== "function" || typeof provider.call !== "function") {
    throw new Error("A read-only EVM provider is required.");
  }
  if (!isAddress(String(walletAddress || "").trim())) {
    throw new Error("Enter a valid smart-wallet address.");
  }
  if (!isHexString(digest, 32)) {
    throw new Error("The signature digest must be exactly 32 bytes.");
  }
  if (!isHexString(signature) || signature.length < 4) {
    throw new Error("Enter a valid hexadecimal signature.");
  }
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(expectedChainId)) {
    throw new Error("RPC chain ID does not match the selected network.");
  }
  const address = getAddress(walletAddress.trim());
  const code = await provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error("No contract or EIP-7702 delegation code was found at this address on the selected network.");
  }
  const data = ERC1271_INTERFACE.encodeFunctionData("isValidSignature", [digest, signature]);
  let response;
  try {
    response = await provider.call({ to: address, data });
  } catch {
    throw new Error("The wallet did not accept the ERC-1271 verification call on this network.");
  }
  let magicValue;
  try {
    [magicValue] = ERC1271_INTERFACE.decodeFunctionResult("isValidSignature", response);
  } catch {
    throw new Error("The wallet returned an invalid ERC-1271 response.");
  }
  return {
    valid: String(magicValue).toLowerCase() === ERC1271_MAGIC_VALUE,
    walletAddress: address,
    chainId: Number(network.chainId),
    magicValue,
    standard: "EIP-1271",
  };
}


export const OKX_WALLETCORE_IMPLEMENTATION = "0x80296FF8D1ED46f8e3C7992664D13B833504c2Bb";
export const OKX_EIP7702_CODE_PREFIX = "0xef0100";

const WALLETCORE_INTERFACE = new Interface([
  "function executeFromSelf((address target,uint256 value,bytes data)[] calls)",
]);

/**
 * EIP-7702 account code is a 23-byte delegation designator:
 * 0xef0100 || implementation address. Match the known, verified OKX WalletCore
 * target exactly; fail closed for any other implementation.
 */
export function isExpectedOkxWalletCoreDelegation(code) {
  const expected = OKX_EIP7702_CODE_PREFIX + OKX_WALLETCORE_IMPLEMENTATION.slice(2);
  return typeof code === "string" && code.toLowerCase() === expected.toLowerCase();
}

/**
 * Encode one or more wallet-self-execution calls for the existing OKX WalletCore.
 * This only builds calldata; it never signs, submits, or broadcasts a transaction.
 */
export function encodeOkxWalletCoreSelfExecution(calls) {
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new Error("At least one wallet execution call is required.");
  }
  const normalized = calls.map((call, index) => {
    if (!call || !isAddress(String(call.target || ""))) {
      throw new Error("Execution call " + (index + 1) + " has an invalid target address.");
    }
    let value;
    try { value = BigInt(call.value ?? 0); } catch {
      throw new Error("Execution call " + (index + 1) + " has an invalid value.");
    }
    if (value < 0n) throw new Error("Execution call values cannot be negative.");
    if (!isHexString(call.data ?? "0x")) {
      throw new Error("Execution call " + (index + 1) + " data must be hexadecimal.");
    }
    return { target: call.target, value, data: call.data ?? "0x" };
  });
  return WALLETCORE_INTERFACE.encodeFunctionData("executeFromSelf", [normalized]);
}
