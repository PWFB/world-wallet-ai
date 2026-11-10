import { useState } from "react";
import { getWalletConnectSessionConnections } from "./walletconnect-accounts.js";
import {
  availableAssetBalance,
  getMainnetAssetNetwork,
  isSupportedEvmReturnAsset,
  normalizeOkxBitcoinAccount,
  normalizeOkxEvmAccount,
  normalizeOkxSolanaAccount,
} from "./okx-return.js";

const NETWORKS = [
  { key: "ethereum", label: "Ethereum Mainnet", chainId: 1 },
  { key: "bnb", label: "BNB Chain Mainnet", chainId: 56 },
  { key: "bitcoin", label: "Bitcoin Mainnet" },
  { key: "solana_mainnet", label: "Solana Mainnet" },
];

const MAINNET_LABELS = Object.fromEntries(NETWORKS.map(item => [item.key, item.label]));

function formatAmount(value) {
  return Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function shorten(value) {
  return value ? value.slice(0, 10) + "…" + value.slice(-8) : "Not connected";
}

export default function MainnetReturnCenter({
  assets = [],
  sourceAddresses = [],
  wallet = null,
  externalProvider = null,
  onConnectWalletConnect,
  onEvmProviderConnected,
  onPrepareTransfer,
  setActive,
}) {
  const [destinations, setDestinations] = useState({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function connectEvm(network) {
    setBusy(network);
    setError("");
    setMessage("");
    try {
      let provider = window.okxwallet && typeof window.okxwallet.request === "function"
        ? window.okxwallet
        : null;
      let isWalletConnectOkx = false;
      if (!provider && externalProvider && typeof externalProvider.request === "function") {
        const peerName = String(externalProvider?.session?.peer?.metadata?.name || "");
        if (/okx/i.test(peerName)) {
          provider = externalProvider;
          isWalletConnectOkx = true;
        }
      }
      if (!provider) {
        throw new Error("OKX provider was not detected. Open this page in the OKX Wallet DApp browser/extension, or connect OKX from WalletConnect first.");
      }

      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const chainId = await provider.request({ method: "eth_chainId" });
      let connections = [];
      if (isWalletConnectOkx) {
        connections = getWalletConnectSessionConnections(provider.session, chainId, accounts)
          .map(item => ({ ...item, network: item.chainId === 1 ? "ethereum" : item.chainId === 56 ? "bnb" : "" }))
          .filter(item => item.network === "ethereum" || item.network === "bnb");
      }
      const selected = connections.find(item => item.network === network)
        || normalizeOkxEvmAccount(accounts, chainId);

      if (!selected) {
        const actual = Number.parseInt(String(chainId), String(chainId).startsWith("0x") ? 16 : 10);
        throw new Error(actual === 1 || actual === 56
          ? "OKX did not return a valid EVM address."
          : "Switch OKX Wallet to " + MAINNET_LABELS[network] + " and connect again. No network was switched automatically.");
      }
      if (selected.network !== network) {
        throw new Error("OKX is currently connected to " + MAINNET_LABELS[selected.network] + ". Switch to " + MAINNET_LABELS[network] + " in OKX and reconnect.");
      }

      const discovered = connections.length ? connections : [selected];
      setDestinations(current => ({
        ...current,
        ...Object.fromEntries(discovered.map(item => [item.network, item.address])),
      }));
      discovered.forEach(connection => onEvmProviderConnected?.(provider, connection));
      setMessage(discovered.length > 1
        ? "Ethereum and BNB Mainnet receiving addresses read from the OKX Wallet session."
        : MAINNET_LABELS[network] + " receiving address read from OKX Wallet.");
    } catch (cause) {
      setError(cause?.message || "Could not read the OKX EVM address.");
    } finally {
      setBusy("");
    }
  }

  async function connectBitcoin() {
    setBusy("bitcoin");
    setError("");
    setMessage("");
    try {
      const provider = window.okxwallet?.bitcoin;
      if (!provider) throw new Error("OKX Bitcoin provider was not detected. Open this page in the OKX Wallet DApp browser or supported extension.");
      let result;
      if (typeof provider.getAccounts === "function") {
        try { result = await provider.getAccounts(); } catch {}
      }
      if (!normalizeOkxBitcoinAccount(result)) {
        if (typeof provider.requestAccounts === "function") result = await provider.requestAccounts();
        else if (typeof provider.connect === "function") result = await provider.connect();
      }
      const address = normalizeOkxBitcoinAccount(result);
      if (!address) throw new Error("OKX did not return a valid Bitcoin Mainnet receiving address.");
      setDestinations(current => ({ ...current, bitcoin: address }));
      setMessage("Bitcoin Mainnet receiving address read from OKX Wallet.");
    } catch (cause) {
      setError(cause?.message || "Could not read the OKX Bitcoin address.");
    } finally {
      setBusy("");
    }
  }

  async function connectSolana() {
    setBusy("solana_mainnet");
    setError("");
    setMessage("");
    try {
      const provider = window.okxwallet?.solana;
      if (!provider || typeof provider.connect !== "function") {
        throw new Error("OKX Solana provider was not detected. Open this page in the OKX Wallet DApp browser or supported extension.");
      }
      const result = await provider.connect();
      const address = normalizeOkxSolanaAccount(result);
      if (!address) throw new Error("OKX did not return a valid Solana Mainnet public key.");
      setDestinations(current => ({ ...current, solana_mainnet: address }));
      setMessage("Solana Mainnet receiving address read from OKX Wallet.");
    } catch (cause) {
      setError(cause?.message || "Could not read the OKX Solana address.");
    } finally {
      setBusy("");
    }
  }

  const rows = (Array.isArray(assets) ? assets : []).map(asset => ({
    asset,
    network: getMainnetAssetNetwork(asset),
    balance: availableAssetBalance(asset),
  })).filter(row => row.network && row.network !== "sepolia" && row.network !== "solana_devnet");

  const sourceCountByNetwork = Object.fromEntries(NETWORKS.map(network => [
    network.key,
    sourceAddresses.filter(item => item.network === network.key).length,
  ]));

  function prepare(asset, network, destination) {
    const source = sourceAddresses.find(item =>
      item.network === network &&
      item.ownership_verified === true &&
      String(item.address || "").toLowerCase() !== String(destination || "").toLowerCase()
    );
    if (!source) {
      setError("No different, ownership-verified source address is attached for " + MAINNET_LABELS[network] + ". Verify the source wallet before preparing a transfer.");
      return;
    }
    onPrepareTransfer?.({
      asset: asset.symbol,
      network,
      destination,
      sourceAddress: source.address,
    });
  }

  const panel = { marginBottom: 16 };
  return <section className="content feature-content">
    <div className="page-heading">
      <div>
        <p className="eyebrow">WORLD WALLET AI · SELF-CUSTODY</p>
        <h1>Mainnet Return to OKX</h1>
        <p className="muted">Read each OKX receiving address on its own network, then prepare owner-approved returns.</p>
      </div>
      <button type="button" className="secondary" onClick={() => setActive("Dashboard")}>← Dashboard</button>
    </div>

    <article className="panel action-panel" style={panel}>
      <div className="panel-head">
        <div><h2>Connect network-specific OKX addresses</h2><span>Every receiving address is read separately; Ethereum, BNB, Bitcoin and Solana addresses are never assumed to match.</span></div>
      </div>
      <div className="security-note">Connecting only reads public account addresses. It does not transfer tokens, request a recovery phrase, or grant World Wallet AI custody of your private keys.</div>
      {!window.okxwallet && onConnectWalletConnect && <div style={{ marginTop: 14 }}>
        <button type="button" className="secondary" disabled={Boolean(busy)} onClick={async () => {
          setError("");
          setMessage("Opening WalletConnect. Select OKX Wallet, approve the session, then read the network addresses.");
          try { await onConnectWalletConnect(); }
          catch (cause) { setError(cause?.message || "WalletConnect could not open."); }
        }}>Connect OKX via WalletConnect</button>
      </div>}
      <div className="feature-grid">
        {NETWORKS.map(item => <div className="panel action-panel" key={item.key} style={{ padding: 14 }}>
          <small>{item.label}</small>
          <p><code>{shorten(destinations[item.key])}</code></p>
          <button
            type="button"
            className="secondary"
            disabled={Boolean(busy)}
            onClick={item.key === "ethereum" || item.key === "bnb"
              ? () => connectEvm(item.key)
              : item.key === "bitcoin" ? connectBitcoin : connectSolana}
          >
            {busy === item.key ? "Connecting…" : destinations[item.key] ? "Refresh address" : "Connect OKX"}
          </button>
        </div>)}
      </div>
      {message && <div role="status" className="feature-success">{message}</div>}
      {error && <div role="alert" className="feature-error">{error}</div>}
    </article>

    <article className="panel action-panel" style={panel}>
      <div className="panel-head">
        <div><h2>Available Mainnet assets</h2><span>Available balances supplied by the active World Wallet snapshot; no estimated prices or synthetic balances are used.</span></div>
        <span className="presale-status-pill">{rows.length} asset entries</span>
      </div>
      {sourceAddresses.length === 0 && <div className="security-note">No addresses are attached to this wallet yet. Create or attach the source wallet first.</div>}
      {NETWORKS.filter(item => sourceCountByNetwork[item.key] > 1).map(item => <div className="security-note" key={item.key}>Multiple {item.label} addresses are attached. The current backend balance synchronizer selects only one address per network, so the displayed portfolio may not include every attached address.</div>)}
      {rows.length ? <div className="tool-list">
        {rows.map(({ asset, network, balance }, index) => {
          const symbol = String(asset.symbol || asset.asset || "").toUpperCase();
          const destination = destinations[network] || "";
          const source = sourceAddresses.find(item =>
            item.network === network &&
            item.ownership_verified === true &&
            String(item.address || "").toLowerCase() !== destination.toLowerCase()
          );
          const canPrepare = balance > 0 &&
            Boolean(destination) &&
            Boolean(source) &&
            isSupportedEvmReturnAsset(symbol, network);
          const sameAddress = sourceAddresses.some(item =>
            item.network === network &&
            String(item.address || "").toLowerCase() === destination.toLowerCase()
          );
          const reason = network === "solana_mainnet"
            ? "Solana Mainnet transfer and receipt settlement are not integrated yet."
            : network === "bitcoin"
              ? "Bitcoin source-signing for this return flow needs a separate verified OKX/Bitcoin settlement integration."
              : !isSupportedEvmReturnAsset(symbol, network)
                ? "This asset is not enabled for the current verified EVM return adapter."
                : balance <= 0
                  ? "No available balance in the current snapshot."
                  : !destination
                    ? "Connect the OKX receiving address for this network."
                    : sameAddress
                      ? "Source and destination are the same address; no return transfer is needed."
                      : !source
                        ? "Attach and ownership-verify a different source address for this network."
                        : "";
          return <div className="tool-row" key={network + ":" + symbol + ":" + index}>
            <div style={{ minWidth: 0 }}>
              <b>{symbol} · {MAINNET_LABELS[network]}</b>
              <small>Available: {formatAmount(balance)} {symbol}</small>
              <small>To: <code>{shorten(destination)}</code></small>
              {reason && <small>{reason}</small>}
            </div>
            <button type="button" className="secondary" disabled={!canPrepare} onClick={() => prepare(asset, network, destination)}>Prepare return</button>
          </div>;
        })}
      </div> : <div className="feature-empty">No Mainnet asset rows are available in the current wallet snapshot. Refresh the wallet before preparing a return.</div>}
    </article>

    <article className="panel action-panel" style={panel}>
      <h2>Signing and settlement controls</h2>
      <p className="muted">A supported EVM return opens the existing Send review with the selected source, network and OKX destination filled in. You still enter the amount, inspect the destination and approve the transaction in OKX. World Wallet AI verifies the returned transaction hash before reconciling wallet accounting.</p>
      <div className="security-note">This is not an automatic sweep. A wallet owner must approve each transfer. Leave enough native ETH or BNB for gas. A transfer is not complete merely because it was prepared or submitted.</div>
      <div className="security-note">Bitcoin and Solana receiving addresses can be displayed, but their source signing and backend receipt-settlement paths are not enabled in this return workflow. Unsupported assets remain blocked. Sepolia and Devnet are excluded.</div>
      <div className="security-note">Active wallet: {wallet?.wallet_number || wallet?.wallet_id || wallet?.id || "Unavailable"} · Mainnet only.</div>
    </article>
  </section>;
}
