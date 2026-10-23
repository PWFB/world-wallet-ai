export const SELECTED_NETWORK_STORAGE_KEY = "world_wallet_selected_network_v1";

export const SUPPORTED_NETWORKS = Object.freeze([
  "ethereum",
  "sepolia",
  "bnb",
  "bitcoin",
  "solana_mainnet",
  "solana_devnet",
]);

// Normalize only explicit network identifiers. Generic "mainnet" is ambiguous
// and must never silently become Ethereum Mainnet.
export function normalizeNetworkId(value) {
  const network = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  // A bare "solana" means Solana Mainnet. Devnet must be explicitly named;
  // mapping "solana" to Devnet would silently redirect production workflows.
  if (["solana", "solana_mainnet", "solana_mainnet_beta", "mainnet_beta"].includes(network)) return "solana_mainnet";
  if (["devnet", "solana_devnet"].includes(network)) return "solana_devnet";
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

// Testnets must remain visibly separate from production records. Prefer the
// explicit chain identifier, but also recognize network-qualified BALMZ assets
// so a missing or stale row network cannot accidentally mark test tokens as
// production evidence.
const TESTNET_NETWORKS = new Set(["sepolia", "solana_devnet"]);
const TESTNET_ASSETS = new Set(["BALMZ-SEP", "BALMZ-SOL-DEVNET"]);

export function isTestnetNetwork(networkValue, assetValue) {
  const network = normalizeNetworkId(networkValue);
  const asset = String(assetValue || "").trim().toUpperCase();
  return TESTNET_NETWORKS.has(network) || TESTNET_ASSETS.has(asset);
}
