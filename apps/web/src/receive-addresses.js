export const VAULT_STORAGE_KEY = "world_wallet_encrypted_vault_v1";
export const ACTIVE_WALLET_STORAGE_KEY = "world_wallet_active_vault_wallet_id_v1";

export function getActiveLocalWalletId(storage) {
  try {
    const store = storage || (typeof window !== "undefined" ? window.localStorage : null);
    return store?.getItem(ACTIVE_WALLET_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function setActiveLocalWalletId(walletId, storage) {
  try {
    const store = storage || (typeof window !== "undefined" ? window.localStorage : null);
    if (!store || !walletId) return false;
    store.setItem(ACTIVE_WALLET_STORAGE_KEY, String(walletId));
    if (typeof window !== "undefined" && store === window.localStorage) {
      window.dispatchEvent(new CustomEvent("world-wallet-wallet-selected", { detail: { walletId: String(walletId) } }));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Read only public address metadata from the currently active local wallet.
 * Wallet private keys and recovery phrases are intentionally not exposed here.
 */
export function getLocalVaultReceiveAddresses(storage) {
  try {
    const store = storage || (typeof window !== "undefined" ? window.localStorage : null);
    if (!store) return [];
    const entries = JSON.parse(store.getItem(VAULT_STORAGE_KEY) || "[]");
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const activeWalletId = getActiveLocalWalletId(store);
    const selected = entries.find(entry => String(entry?.walletId) === String(activeWalletId)) || entries[0];
    if (!selected || !Array.isArray(selected.networkAddresses)) return [];

    return selected.networkAddresses
      .filter(item => item && typeof item.network === "string" && typeof item.address === "string" && item.address.trim())
      .map(item => ({
        network: item.network,
        address: item.address,
        label: (selected.name || "Wallet") + " · " + (item.label || item.network),
        local: true,
        source: "local-vault",
        walletId: selected.walletId,
        environment: item.environment || (["sepolia", "solana_devnet"].includes(item.network) ? "testnet" : "mainnet"),
      }));
  } catch {
    return [];
  }
}
