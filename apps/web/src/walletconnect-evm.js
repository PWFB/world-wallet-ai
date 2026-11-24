import { networkForEvmChain, normalizeEvmChainId } from "./eip6963-wallets.js";
const EVM_ADDRESS = /^0x[a-f0-9]{40}$/i;
export function parseWalletConnectAccount(value) {
  const parts = String(value || "").split(":");
  if (parts.length !== 3 || parts[0] !== "eip155") return null;
  // CAIP-10 EIP-155 references are decimal chain IDs, not hex RPC IDs.
  if (!/^\d+$/.test(parts[1])) return null;
  const chainId = normalizeEvmChainId(parts[1]);
  const network = networkForEvmChain(chainId);
  const address = parts[2];
  if (!network || !EVM_ADDRESS.test(address)) return null;
  return { chainId, network, address };
}
export function collectWalletConnectAccounts(session, activeChainId, activeAccounts = []) {
  const rawAccounts = Array.isArray(session?.namespaces?.eip155?.accounts)
    ? [...session.namespaces.eip155.accounts] : [];
  const chainId = normalizeEvmChainId(activeChainId);
  if (networkForEvmChain(chainId) && Array.isArray(activeAccounts)) {
    for (const address of activeAccounts) rawAccounts.push("eip155:" + chainId + ":" + String(address || ""));
  }
  const unique = new Map();
  for (const raw of rawAccounts) {
    const parsed = parseWalletConnectAccount(raw);
    if (parsed) unique.set(parsed.chainId + ":" + parsed.address.toLowerCase(), parsed);
  }
  return [...unique.values()];
}
export function mergeWalletConnectConnections(existing, incoming) {
  const current = Array.isArray(existing) ? existing : [];
  const added = Array.isArray(incoming) ? incoming : [];
  let result = current.slice();
  for (const item of added) {
    const key = [String(item.walletId || ""), "walletconnect", Number(item.chainId), String(item.address || "").toLowerCase()].join(":");
    result = result.filter(other => [
      String(other.walletId || ""),
      String(other.providerId || other.provider || "").toLowerCase(),
      Number(other.chainId),
      String(other.address || "").toLowerCase(),
    ].join(":") !== key);
    result.push(item);
  }
  return result;
}
