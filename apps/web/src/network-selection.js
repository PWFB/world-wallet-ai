export const SELECTED_NETWORK_STORAGE_KEY = "world_wallet_selected_network_v1";

export const SUPPORTED_NETWORKS = Object.freeze([
  "ethereum",
  "sepolia",
  "bnb",
  "bitcoin",
  "solana_devnet",
]);

// Normalize only explicit network identifiers. Generic "mainnet" is ambiguous
// and must never silently become Ethereum Mainnet.
export function normalizeNetworkId(value) {
  const network = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["solana", "devnet", "solana_devnet"].includes(network)) return "solana_devnet";
  if (["eth", "ethereum_mainnet"].includes(network)) return "ethereum";
  if (["ethereum_sepolia"].includes(network)) return "sepolia";
  if (["bsc", "binance_smart_chain"].includes(network)) return "bnb";
  return network;
}

export function readSelectedNetwork(savedValue) {
  const network = normalizeNetworkId(savedValue);
  return SUPPORTED_NETWORKS.includes(network) ? network : "ethereum";
}

export function cachedBalanceMatchesNetwork(cachedBalance, selectedNetwork) {
  if (!cachedBalance || typeof cachedBalance !== "object") return false;
  const balance = Number(cachedBalance.balance);
  if (!Number.isFinite(balance) || balance < 0) return false;
  return normalizeNetworkId(cachedBalance.network) === normalizeNetworkId(selectedNetwork);
}
