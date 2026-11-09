export const WALLETCONNECT_EVM_CHAIN_IDS = Object.freeze([1, 56, 11155111]);

const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

function normalizeChainId(value) {
  if (Number.isInteger(value) && value > 0) return value;
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = /^0x[0-9a-f]+$/i.test(text)
    ? Number.parseInt(text, 16)
    : /^\d+$/.test(text)
      ? Number.parseInt(text, 10)
      : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Returns every approved EVM address in a WalletConnect session, not only the
 * accounts exposed for the currently selected chain. The active-chain account
 * list is merged as a fallback so accountChanged events are not lost when a
 * provider has not yet refreshed its session namespace.
 */
export function getWalletConnectSessionConnections(session, fallbackChainId, fallbackAccounts = []) {
  const supported = new Set(WALLETCONNECT_EVM_CHAIN_IDS);
  const connections = [];
  const add = (chainValue, addressValue) => {
    const chainId = normalizeChainId(chainValue);
    const address = String(addressValue || "").trim();
    if (!supported.has(chainId) || !EVM_ADDRESS_PATTERN.test(address)) return;
    if (connections.some(item => item.chainId === chainId && item.address.toLowerCase() === address.toLowerCase())) return;
    connections.push({ chainId, address });
  };

  const sessionAccounts = session?.namespaces?.eip155?.accounts;
  if (Array.isArray(sessionAccounts)) {
    for (const account of sessionAccounts) {
      const parts = String(account || "").split(":");
      if (parts.length !== 3 || parts[0].toLowerCase() !== "eip155") continue;
      add(parts[1], parts[2]);
    }
  }

  const activeChainId = normalizeChainId(fallbackChainId);
  if (activeChainId && Array.isArray(fallbackAccounts)) {
    for (const address of fallbackAccounts) add(activeChainId, address);
  }

  return connections;
}
