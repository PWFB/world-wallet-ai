import { getAddress, isAddress, parseEther } from "ethers";

export const ETHEREUM_NETWORKS = Object.freeze({
  ethereum: { label: "Ethereum Mainnet", chainId: 1, hexChainId: "0x1" },
  sepolia: { label: "Ethereum Sepolia (testnet)", chainId: 11155111, hexChainId: "0xaa36a7" },
});

export function normalizeChainId(value) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const parsed = /^0x[0-9a-f]+$/i.test(raw) ? Number.parseInt(raw, 16) : /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function inspectEvmTransaction({ from, to, value = "0", data = "0x", expectedChainId, actualChainId }) {
  const findings = [];
  const expected = normalizeChainId(expectedChainId);
  const actual = normalizeChainId(actualChainId);
  if (expected == null) findings.push({ severity: "blocker", code: "invalid_expected_chain", message: "Select a supported network." });
  if (actual == null) findings.push({ severity: "blocker", code: "unknown_actual_chain", message: "The connected wallet chain could not be identified." });
  else if (expected != null && actual !== expected) findings.push({ severity: "blocker", code: "chain_mismatch", message: "Connected wallet network does not match the selected network." });

  let normalizedFrom = "";
  let normalizedTo = "";
  if (!isAddress(String(from || ""))) findings.push({ severity: "blocker", code: "invalid_sender", message: "Sender is not a valid EVM address." });
  else normalizedFrom = getAddress(from);
  if (!isAddress(String(to || ""))) findings.push({ severity: "blocker", code: "invalid_recipient", message: "Recipient is not a valid EVM address." });
  else normalizedTo = getAddress(to);

  const calldata = String(data || "0x").trim();
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(calldata)) findings.push({ severity: "blocker", code: "invalid_calldata", message: "Transaction data must be 0x-prefixed, even-length hexadecimal." });

  let weiValue = null;
  try {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(String(value))) throw new Error("invalid");
    weiValue = parseEther(String(value));
  } catch {
    findings.push({ severity: "blocker", code: "invalid_value", message: "ETH value must be a non-negative decimal with at most 18 decimal places." });
  }

  const selector = calldata.length >= 10 ? calldata.slice(0, 10).toLowerCase() : null;
  const knownCalls = {
    "0xa9059cbb": "ERC-20 transfer(address,uint256)",
    "0x095ea7b3": "ERC-20 approve(address,uint256)",
    "0x23b872dd": "ERC-20 transferFrom(address,address,uint256)",
    "0x42842e0e": "ERC-721 safeTransferFrom(address,address,uint256)",
    "0xa22cb465": "ERC-721 setApprovalForAll(address,bool)",
  };
  if (selector && knownCalls[selector]) findings.push({ severity: selector === "0x095ea7b3" || selector === "0xa22cb465" ? "warning" : "info", code: "recognized_method", message: "Recognized method: " + knownCalls[selector] + "." });
  if (selector === "0x095ea7b3") findings.push({ severity: "warning", code: "token_approval", message: "This call may grant a spender permission to move tokens. Verify the token contract, spender, and allowance amount independently." });
  if (selector === "0xa22cb465") findings.push({ severity: "warning", code: "operator_approval", message: "This call may grant an operator control over all tokens in a collection. Verify the operator and collection." });
  if (calldata !== "0x" && !selector) findings.push({ severity: "warning", code: "unknown_method", message: "Unknown contract method. The effect cannot be determined by this basic inspector." });
  if (weiValue != null && weiValue > 0n && calldata !== "0x") findings.push({ severity: "warning", code: "value_with_calldata", message: "This transaction sends ETH and calls contract code. Confirm that both actions are intended." });
  if (normalizedTo && normalizedFrom && normalizedTo.toLowerCase() === normalizedFrom.toLowerCase()) findings.push({ severity: "warning", code: "self_destination", message: "Recipient is the connected sender address." });

  return { valid: !findings.some(item => item.severity === "blocker"), from: normalizedFrom, to: normalizedTo, valueWei: weiValue == null ? null : weiValue.toString(), valueEth: String(value), data: calldata, selector, method: selector ? knownCalls[selector] || "Unknown contract method" : "Native ETH transfer", expectedChainId: expected, actualChainId: actual, findings, canSign: false };
}
