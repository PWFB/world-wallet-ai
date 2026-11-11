import { Interface, isAddress, isHexString } from "ethers";

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
