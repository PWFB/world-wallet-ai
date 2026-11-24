const EVM_CHAIN_NETWORKS = Object.freeze({ 1: "ethereum", 56: "bnb", 11155111: "sepolia" });

export function normalizeEvmChainId(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value || "").trim();
  if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text, 16);
  return /^\d+$/.test(text) ? Number.parseInt(text, 10) : NaN;
}

export function networkForEvmChain(value) {
  return EVM_CHAIN_NETWORKS[normalizeEvmChainId(value)] || "";
}

export function withProviderTimeout(promise, timeoutMs = 60000, operation = "Wallet request") {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(operation + " timed out. Approve the request in your wallet, then retry.")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function discoverEip6963Providers(windowRef = window, timeoutMs = 350) {
  if (!windowRef?.addEventListener || !windowRef?.dispatchEvent) return [];
  const discovered = [];
  const seen = new Set();
  const add = (provider, info = {}) => {
    if (!provider || typeof provider.request !== "function" || seen.has(provider)) return;
    seen.add(provider);
    discovered.push({
      provider,
      name: String(info.name || provider.name || (provider.isMetaMask ? "MetaMask" : provider.isCoinbaseWallet ? "Coinbase Wallet" : "Injected EVM Wallet")),
      rdns: String(info.rdns || ""),
      uuid: String(info.uuid || ""),
      icon: String(info.icon || ""),
    });
  };
  const onAnnounce = event => add(event?.detail?.provider, event?.detail?.info || {});
  windowRef.addEventListener("eip6963:announceProvider", onAnnounce);
  try {
    windowRef.dispatchEvent(new Event("eip6963:requestProvider"));
    await new Promise(resolve => setTimeout(resolve, timeoutMs));
  } finally {
    windowRef.removeEventListener("eip6963:announceProvider", onAnnounce);
  }
  const injected = windowRef.ethereum;
  if (Array.isArray(injected?.providers)) injected.providers.forEach(provider => add(provider));
  add(injected);
  add(windowRef.binancew3w?.ethereum, { name: "Binance Web3 Wallet", rdns: "com.binance" });
  add(windowRef.okxwallet, { name: "OKX Wallet", rdns: "com.okex.wallet" });
  add(windowRef.coinbaseWalletExtension, { name: "Coinbase Wallet", rdns: "com.coinbase.wallet" });
  return discovered;
}
