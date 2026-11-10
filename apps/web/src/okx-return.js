export const OKX_EVM_MAINNETS = Object.freeze({
  ethereum: 1,
  bnb: 56,
});

export function normalizeEvmChainId(value) {
  if (Number.isInteger(value) && value > 0) return value;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = /^0x[0-9a-f]+$/i.test(raw)
    ? Number.parseInt(raw, 16)
    : /^\d+$/.test(raw)
      ? Number.parseInt(raw, 10)
      : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeOkxEvmAccount(accounts, chainId) {
  const normalizedChain = normalizeEvmChainId(chainId);
  const network = Object.entries(OKX_EVM_MAINNETS).find(([, id]) => id === normalizedChain)?.[0];
  const address = Array.isArray(accounts) ? String(accounts[0] || "").trim() : "";
  if (!network || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  return { network, chainId: normalizedChain, address };
}

export function normalizeOkxBitcoinAccount(result) {
  const candidates = Array.isArray(result)
    ? result
    : [result?.address, result?.[0], result].filter(Boolean);
  const address = candidates
    .map(value => typeof value === "string" ? value : "")
    .find(value => /^(?:bc1[ac-hj-np-z02-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/i.test(value));
  return address || null;
}

export function normalizeOkxSolanaAccount(result) {
  const publicKey = result?.publicKey ?? result?.address ?? result;
  let address = "";
  try {
    address = typeof publicKey === "string"
      ? publicKey.trim()
      : publicKey?.toBase58?.() || publicKey?.toString?.() || "";
  } catch {
    return null;
  }
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? address : null;
}

export function getMainnetAssetNetwork(asset) {
  const symbol = String(asset?.symbol || asset?.asset || "").trim().toUpperCase();
  const configured = String(asset?.network || "").trim().toLowerCase().replaceAll("-", "_");
  if (["sepolia", "ethereum_sepolia", "solana_devnet", "devnet"].includes(configured)) return null;
  if (configured === "ethereum" || configured === "bnb" || configured === "bitcoin" || configured === "solana_mainnet") return configured;
  if (["BNB", "USDT-BNB", "BALMZ-BNB"].includes(symbol)) return "bnb";
  if (symbol === "BTC") return "bitcoin";
  if (symbol === "SOL") return "solana_mainnet";
  if (["ETH", "USDT", "BALMZ"].includes(symbol)) return "ethereum";
  return null;
}

export function isSupportedEvmReturnAsset(symbol, network) {
  const value = String(symbol || "").trim().toUpperCase();
  if (network === "ethereum") return ["ETH", "USDT", "BALMZ"].includes(value);
  if (network === "bnb") return ["BNB", "USDT", "USDT-BNB", "BALMZ", "BALMZ-BNB"].includes(value);
  return false;
}

export function availableAssetBalance(asset) {
  const amount = Number(asset?.available_balance ?? asset?.available ?? asset?.balance ?? 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}
