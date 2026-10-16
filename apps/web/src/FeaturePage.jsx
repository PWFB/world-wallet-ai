import { useEffect, useRef, useState } from "react";
import { EthereumProvider } from "@walletconnect/ethereum-provider";
import WalletVault from "./WalletVault.jsx";
import ContractTools from "./ContractTools.jsx";
import { getNeonAccessToken } from "./auth-client.js";
import { isUsableNeonAccessToken } from "./neon-token.js";

const WALLETCONNECT_PROJECT_ID = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "97c5ce3ec72a9236f613ee0b340a5000").trim();
const WALLETCONNECT_CHAINS = [1, 11155111, 56];

const money = value => `$${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const number = value => Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });

async function walletAuthHeaders(accessToken, extra = {}) {
  const freshToken = await getNeonAccessToken({ forceRefresh: true });
  const token = freshToken || (isUsableNeonAccessToken(accessToken) ? accessToken : "");
  return { ...extra, ...(token ? { Authorization: "Bearer " + token } : {}) };
}

function transactionExplorerUrl(transaction) {
  const hash = String(transaction?.tx_hash || transaction?.transaction_hash || "").trim();
  if (!hash) return "";
  const network = String(transaction?.network || "").toLowerCase();
  const asset = String(transaction?.asset || transaction?.symbol || "").toUpperCase();
  if (network === "bitcoin" || asset === "BTC") return `https://blockstream.info/tx/${encodeURIComponent(hash)}`;
  if (network === "bnb" || asset === "BNB") return `https://bscscan.com/tx/${encodeURIComponent(hash)}`;
  if (network === "sepolia" || asset === "BALMZ-SEP") return `https://sepolia.etherscan.io/tx/${encodeURIComponent(hash)}`;
  if (network === "ethereum" || ["ETH","USDT","USDC","BALMZ"].includes(asset)) return `https://etherscan.io/tx/${encodeURIComponent(hash)}`;
  if (asset === "USDT-BNB") return `https://bscscan.com/tx/${encodeURIComponent(hash)}`;
  if (asset === "SOL") return `https://solscan.io/tx/${encodeURIComponent(hash)}`;
  if (asset === "XRP") return `https://xrpscan.com/tx/${encodeURIComponent(hash)}`;
  if (asset === "ADA") return `https://cardanoscan.io/transaction/${encodeURIComponent(hash)}`;
  if (asset === "LTC") return `https://blockchair.com/litecoin/transaction/${encodeURIComponent(hash)}`;
  if (asset === "DOGE") return `https://blockchair.com/dogecoin/transaction/${encodeURIComponent(hash)}`;
  return "";
}

function tokenExplorerUrl(transaction) {
  const asset = String(transaction?.asset || transaction?.symbol || "").toUpperCase();
  const network = String(transaction?.network || "").toLowerCase();
  const contract = String(transaction?.token_contract_address || transaction?.contract_address || "").trim();
  if (contract && /^0x[a-fA-F0-9]{40}$/.test(contract)) {
    return network === "sepolia" || asset === "BALMZ-SEP" ? `https://sepolia.etherscan.io/token/${contract}`
      : network === "bnb" ? `https://bscscan.com/token/${contract}` : `https://etherscan.io/token/${contract}`;
  }
  if (asset === "BALMZ-SEP") return "https://sepolia.etherscan.io/";
  if (asset === "BALMZ") return "https://etherscan.io/tokens";
  return "";
}

const RECEIVE_ASSET_OPTIONS = [
  { symbol: "BTC", name: "Bitcoin" },
  { symbol: "ETH", name: "Ethereum" },
  { symbol: "BNB", name: "BNB" },
  { symbol: "USDT", name: "Tether USD" },
  { symbol: "USDC", name: "USD Coin" },
  { symbol: "USDT-BNB", name: "Tether USD (BNB Chain)" },
  { symbol: "BALMZ", name: "BALMZ" },
  { symbol: "BALMZ-SEP", name: "BALMZ (Sepolia testnet)" },
];

const networksForAsset = symbol => ({
  BTC: [{ value: "bitcoin", label: "Bitcoin" }],
  ETH: [{ value: "ethereum", label: "Ethereum Mainnet" }],
  BNB: [{ value: "bnb", label: "BNB Chain" }],
  USDT: [{ value: "ethereum", label: "Ethereum Mainnet" }, { value: "bnb", label: "BNB Chain" }],
  USDC: [{ value: "ethereum", label: "Ethereum Mainnet" }, { value: "bnb", label: "BNB Chain" }],
  "USDT-BNB": [{ value: "bnb", label: "BNB Chain" }],
  BALMZ: [{ value: "ethereum", label: "Ethereum Mainnet" }],
  "BALMZ-SEP": [{ value: "sepolia", label: "Ethereum Sepolia (testnet)" }],
}[symbol] || []);

function getLocalExternalReceiveAddress() {
  try {
    const connection = JSON.parse(localStorage.getItem("world_wallet_external_connection_v1") || "null");
    if (!connection?.address || !/^0x[a-fA-F0-9]{40}$/.test(connection.address)) return [];
    const rawChainId = connection.chainId;
    const chainId = typeof rawChainId === "string" && /^0x[0-9a-f]+$/i.test(rawChainId)
      ? Number.parseInt(rawChainId, 16) : Number(rawChainId);
    const network = ({ 1: "ethereum", 11155111: "sepolia", 56: "bnb" })[chainId];
    if (!network) return [];
    return [{ network, address: connection.address, label: "Connected external wallet", local: true }];
  } catch {
    return [];
  }
}

function WalletManager({ accessToken, apiBaseUrl, setActive, onTransactionsUpdated, onWalletUpdated }) {
  const [wallets, setWallets] = useState([]);
  const [walletName, setWalletName] = useState("");
  const [walletId, setWalletId] = useState("");
  const [walletAddresses, setWalletAddresses] = useState([]);
  const [addressesLoadedForWallet, setAddressesLoadedForWallet] = useState("");
  const externalAttachRef = useRef(new Set());
  const [network, setNetwork] = useState("ethereum");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("primary");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [addressBalances, setAddressBalances] = useState({});
  const balanceRequestGeneration = useRef(0);
  const [showAddressForm, setShowAddressForm] = useState(false);
  const [localEntries, setLocalEntries] = useState(() => { try { const v = JSON.parse(localStorage.getItem("world_wallet_encrypted_vault_v1") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } });

  useEffect(() => { const refreshLocal = () => { try { const v = JSON.parse(localStorage.getItem("world_wallet_encrypted_vault_v1") || "[]"); setLocalEntries(Array.isArray(v) ? v : []); } catch { setLocalEntries([]); } }; window.addEventListener("world-wallet-local-vault-updated", refreshLocal); window.addEventListener("storage", refreshLocal); return () => { window.removeEventListener("world-wallet-local-vault-updated", refreshLocal); window.removeEventListener("storage", refreshLocal); }; }, []);

  const loadAddresses = async id => {
    if (!id) return;
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/wallets/" + id + "/addresses", { headers: await walletAuthHeaders(accessToken) });
      const data = await response.json();
      setWalletAddresses(response.ok ? (data.addresses || []) : []);
      setAddressesLoadedForWallet(response.ok ? id : "");
    } catch { setWalletAddresses([]); setAddressesLoadedForWallet(""); }
  };

  const loadWallets = async () => {
    setBusy(true);
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/wallets", { headers: await walletAuthHeaders(accessToken) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Unable to load wallets.");
      setWallets(data.wallets || []);
      const activeId = data.active_wallet_id || data.wallets?.find(w => w.active)?.id || "";
      setWalletId(activeId);
      if (activeId) await loadAddresses(activeId);
    } catch (error) {
      setMessage(error.message || "Unable to load wallets.");
    } finally { setBusy(false); }
  };

  useEffect(() => { loadWallets(); }, [accessToken]);

  // When a user has connected an external EVM wallet, attach its public address
  // to the active server wallet when the Wallets screen loads. Private keys never
  // enter this flow. Unsupported chains are left unmodified rather than mislabeled.
  useEffect(() => {
    if (!walletId || addressesLoadedForWallet !== walletId) return;
    let connection;
    try { connection = JSON.parse(localStorage.getItem("world_wallet_external_connection_v1") || "null"); } catch { return; }
    if (!connection?.address || !/^0x[a-fA-F0-9]{40}$/.test(connection.address)) return;
    const rawChainId = connection.chainId;
    const chainId = typeof rawChainId === "string" && /^0x[0-9a-f]+$/i.test(rawChainId)
      ? Number.parseInt(rawChainId, 16) : Number(rawChainId);
    const networkByChain = { 1: "ethereum", 11155111: "sepolia", 56: "bnb" };
    const externalNetwork = networkByChain[chainId];
    if (!externalNetwork) return;
    if (walletAddresses.some(item => item.network === externalNetwork && String(item.address || "").toLowerCase() === connection.address.toLowerCase())) return;
    const attachKey = walletId + ":" + externalNetwork + ":" + connection.address.toLowerCase();
    if (externalAttachRef.current.has(attachKey)) return;
    externalAttachRef.current.add(attachKey);
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(walletId) + "/addresses", {
          method: "POST",
          headers: await walletAuthHeaders(accessToken, { "Content-Type": "application/json" }),
          body: JSON.stringify({ network: externalNetwork, address: connection.address, label: "external wallet" }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "External wallet connected, but its address could not be attached.");
        if (cancelled) return;
        await loadAddresses(walletId);
        const refreshedResponse = await fetch(apiBaseUrl + "/api/v1/wallet/refresh", { method: "POST", headers: await walletAuthHeaders(accessToken) });
        const refreshed = await refreshedResponse.json();
        if (refreshedResponse.ok) {
          onWalletUpdated?.({ wallet: refreshed.wallet, assets: refreshed.assets || [] });
          onTransactionsUpdated?.(refreshed.transactions || []);
          setMessage("External wallet address attached to the active wallet. Live data refreshed; verify the network and source warnings.");
        } else {
          setMessage("External wallet address attached. Wallet refresh needs a retry: " + (refreshed.detail || "refresh unavailable."));
        }
      } catch (error) {
        externalAttachRef.current.delete(attachKey);
        if (!cancelled) setMessage(error?.message || "Could not attach the connected external wallet address.");
      }
    })();
    return () => { cancelled = true; };
  }, [walletId, addressesLoadedForWallet, walletAddresses, accessToken, apiBaseUrl]);

  const refreshActiveWallet = async () => {
    const response = await fetch(apiBaseUrl + "/api/v1/wallet/refresh", { method: "POST", headers: await walletAuthHeaders(accessToken) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Wallet refresh failed.");
    onWalletUpdated?.({ wallet: data.wallet, assets: data.assets || [] });
    onTransactionsUpdated?.(data.transactions || []);
  };

  const createWallet = async () => {
    const name = walletName.trim();
    if (!name) return setMessage("Enter a wallet name.");
    setBusy(true); setMessage("");
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/wallets", {
        method: "POST",
        headers: await walletAuthHeaders(accessToken, { "Content-Type": "application/json" }),
        body: JSON.stringify({ name }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Unable to create wallet.");
      setWalletName("");
      await loadWallets();
      await refreshActiveWallet();
      setMessage("Wallet created. Add its public blockchain addresses to connect live data.");
    } catch (error) { setMessage(error.message || "Unable to create wallet."); }
    finally { setBusy(false); }
  };

  const switchWallet = async id => {
    if (!id) return;
    // Address balance results are scoped to the wallet being viewed. Clear them
    // immediately so a repeated address in another wallet cannot show stale UI.
    balanceRequestGeneration.current += 1;
    setAddressBalances({});
    setBusy(true); setMessage("");
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/wallets/active", {
        method: "POST",
        headers: await walletAuthHeaders(accessToken, { "Content-Type": "application/json" }),
        body: JSON.stringify({ wallet_id: id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Unable to switch wallet.");
      // Refresh the canonical wallet list after activation; loadWallets also loads
      // the active wallet's addresses, so avoid a duplicate address request here.
      await refreshActiveWallet();
      await loadWallets();
      setMessage("Wallet switched. Live balances now belong to the selected wallet.");
    } catch (error) { setMessage(error.message || "Unable to switch wallet."); }
    finally { setBusy(false); }
  };

  const addAddress = async () => {
    const value = address.trim();
    if (!value) return setMessage("Enter a public wallet address.");
    if (!walletId) return setMessage("Select a wallet first.");
    setBusy(true); setMessage("");
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/wallets/" + walletId + "/addresses", {
        method: "POST",
        headers: await walletAuthHeaders(accessToken, { "Content-Type": "application/json" }),
        body: JSON.stringify({ network, address: value, label: label.trim() || "primary" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Unable to connect address.");
      setAddress("");
      await loadAddresses(walletId);
      // Attaching an address is only the first step; refresh the active wallet so
      // configured chain sources can update balances and import verifiable activity.
      const refreshResponse = await fetch(apiBaseUrl + "/api/v1/wallet/refresh", {
        method: "POST",
        headers: await walletAuthHeaders(accessToken),
      });
      const refreshData = await refreshResponse.json();
      if (!refreshResponse.ok) {
        throw new Error(refreshData.detail || "Address was attached, but wallet refresh failed. Use Refresh to retry.");
      }
      onWalletUpdated?.({ wallet: refreshData.wallet, assets: refreshData.assets || [] });
      onTransactionsUpdated?.(refreshData.transactions || []);
      const warnings = Array.isArray(refreshData.warnings) ? refreshData.warnings : [];
      setMessage(warnings.length
        ? "Address attached. Wallet data refreshed with warnings: " + warnings.join(" • ")
        : "Address attached. Wallet refresh completed; verify the selected network and balance before relying on it.");
    } catch (error) { setMessage(error.message || "Unable to connect address."); }
    finally { setBusy(false); }
  };

  const checkAddressBalance = async item => {
    if (!walletId || item.local) return;
    const requestGeneration = balanceRequestGeneration.current;
    const requestedWalletId = walletId;
    const key = item.network + ":" + item.address;
    setAddressBalances(previous => ({ ...previous, [key]: { ...(previous[key] || {}), loading: true, error: "" } }));
    try {
      const query = new URLSearchParams({ network: item.network, address: item.address });
      const response = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(requestedWalletId) + "/addresses/balance?" + query.toString(), {
        headers: await walletAuthHeaders(accessToken),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Unable to check this address balance.");
      if (requestGeneration !== balanceRequestGeneration.current) return;
      setAddressBalances(previous => ({ ...previous, [key]: { loading: false, balance: Number(data.balance || 0), asset: data.asset || item.network, syncedAt: data.synced_at, error: "" } }));
    } catch (error) {
      if (requestGeneration !== balanceRequestGeneration.current) return;
      setAddressBalances(previous => ({ ...previous, [key]: { ...(previous[key] || {}), loading: false, error: error.message || "Balance check failed." } }));
    }
  };

  const selectedWallet = wallets.find(w => w.id === walletId);
  const visibleAddresses = [...walletAddresses, ...localEntries.filter(entry => entry.address && (!selectedWallet || entry.walletId === selectedWallet.id || entry.walletId === walletId || entry.walletId.startsWith("local-"))).map(entry => ({ network: entry.network || "ethereum", address: entry.address, label: entry.name || "Local signing wallet", local: true, walletId: entry.walletId }))].filter((item, index, all) => all.findIndex(other => other.network === item.network && other.address?.toLowerCase() === item.address?.toLowerCase()) === index);

  return <section className="content feature-content">
    <div className="page-heading">
      <div><p className="eyebrow">WALLET MANAGEMENT</p><h1>Wallets</h1><p className="muted">Create wallet profiles, connect public addresses, and switch the active wallet.</p></div>
      <button className="secondary" onClick={loadWallets} disabled={busy}>{busy ? "Working…" : "↻ Refresh"}</button>
    </div>
    {message && <div className={/unable|invalid|failed|enter|select/i.test(message) ? "feature-error" : "feature-success"}>{message}</div>}
    <WalletVault accessToken={accessToken} apiBaseUrl={apiBaseUrl} onWalletCreated={async () => { await loadWallets(); await refreshActiveWallet(); }} />
    <div className="feature-grid">
      <article className="panel action-panel">
        <p className="feature-kicker">CREATE WALLET PROFILE</p>
        <h2>New wallet</h2>
        <p className="muted">This creates a wallet record only. World Wallet AI does not generate or store a private key on the server.</p>
        <label>Wallet name<input value={walletName} onChange={e => setWalletName(e.target.value)} placeholder="Personal Wallet" maxLength="80"/></label>
        <button className="primary feature-submit" disabled={busy || !walletName.trim()} onClick={createWallet}>{busy ? "Creating…" : "Create wallet →"}</button>
        <div className="security-note">For a non-custodial wallet, create or import the signing account in a compatible wallet app and connect only its public address here.</div>
      </article>
      <article className="panel action-panel">
        <p className="feature-kicker">ACTIVE WALLET</p>
        <h2>{selectedWallet?.name || "No wallet selected"}</h2>
        <select value={walletId} onChange={e => switchWallet(e.target.value)} disabled={busy || !wallets.length}>
          {wallets.length ? wallets.map(w => <option key={w.id} value={w.id}>{w.name}{w.active ? " • Active" : ""}</option>) : <option value="">No wallets</option>}
        </select>
        <div className="tool-list">
          {visibleAddresses.length ? visibleAddresses.map(a => {
            const key = a.network + ":" + a.address;
            const balance = addressBalances[key];
            const networkLabel = ({ ethereum: "Ethereum Mainnet", sepolia: "Ethereum Sepolia (testnet)", bnb: "BNB Chain", bitcoin: "Bitcoin", solana_devnet: "Solana Devnet (testnet)" })[a.network] || a.network.toUpperCase();
            return <div className="tool-row" key={key}><div><b>{networkLabel}</b><small>{a.label}{a.local ? " • Local vault" : ""}</small>{balance?.balance !== undefined && <small>{Number(balance.balance).toLocaleString("en-US", { maximumFractionDigits: 8 })} {balance.asset}</small>}{balance?.error && <small className="feature-error">{balance.error}</small>}</div><code>{a.address}</code><div className="address-row-actions"><button className="secondary" onClick={() => navigator.clipboard?.writeText(a.address)}>Copy</button>{!a.local && <button className="secondary" disabled={Boolean(balance?.loading)} onClick={() => checkAddressBalance(a)}>{balance?.loading ? "Checking…" : "Check balance"}</button>}</div></div>;
          }) : <button type="button" className="live-chart-empty" onClick={() => { setShowAddressForm(true); document.getElementById("connect-public-address")?.scrollIntoView({ behavior: "smooth", block: "start" }); }} style={{ width: "100%", cursor: "pointer", textAlign: "left" }}>No public network addresses connected to this wallet. Tap here to add or connect an address →</button>}
        </div>
      </article>
    </div>
    <article className="panel action-panel" id="connect-public-address" style={showAddressForm ? { outline: "2px solid var(--accent, #f59e0b)" } : undefined}>
      <p className="feature-kicker">CONNECT PUBLIC ADDRESS</p>
      <h2>Attach a blockchain address</h2>
      {showAddressForm && <div className="feature-success">Enter a public address below. You can also select a locally generated wallet from the list above; its address is shown automatically.</div>}
      <div className="feature-grid">
        <label>Network<select value={network} onChange={e => setNetwork(e.target.value)}><option value="ethereum">Ethereum Mainnet</option><option value="sepolia">Ethereum Sepolia (testnet)</option><option value="solana_devnet">Solana Devnet (testnet)</option><option value="bnb">BNB Chain</option><option value="bitcoin">Bitcoin</option></select></label>
        <label>Public address<input value={address} onChange={e => setAddress(e.target.value)} placeholder={network === "bitcoin" ? "bc1… or 1… / 3…" : network === "solana_devnet" ? "Solana Base58 public address" : "0x…"}/></label>
      </div>
      <label>Label<input value={label} onChange={e => setLabel(e.target.value)} placeholder="primary"/></label>
      <button className="primary feature-submit" disabled={busy || !walletId || !address.trim()} onClick={addAddress}>{busy ? "Connecting…" : "Connect address →"}</button>
      <div className="security-note">Sepolia and Solana Devnet are test networks. You can attach public addresses without a private key. Solana Devnet balance checks require WORLD_WALLET_SOLANA_DEVNET_RPC_URL on the backend.</div>
      <div className="security-note">One Ethereum address can hold ETH plus many ERC-20 tokens. The token contract identifies the token; a separate wallet address is not required for each ERC-20 token.</div>
      <div className="security-note">BALMZ is currently contract-pending. Do not enter a made-up BALMZ contract address. Once the real contract is deployed, its real address can be registered and its on-chain metadata and balance can be read.</div>
    </article>
  </section>;
}

export default function FeaturePage({ selectedAsset, selectedCoin, setSelectedCoin, walletCoinCatalog, marketPrices = {}, marketPricesUpdatedAt, marketPricesError, marketPricesLoading = false, refreshMarketPrices, focusedTransaction, setFocusedTransaction, active, wallet, assets, activity, accessToken, apiBaseUrl, setActive, onTransactionsUpdated, onWalletUpdated }) {
  const [asset, setAsset] = useState(selectedAsset || assets[0]?.symbol || "BALMZ");
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [network, setNetwork] = useState(() => networksForAsset(assets[0]?.symbol || "BALMZ")[0]?.value || "ethereum");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [addresses, setAddresses] = useState(() => getLocalExternalReceiveAddress());
  const [receiveNetwork, setReceiveNetwork] = useState("all");
  const [swapFrom, setSwapFrom] = useState("ETH");
  const [swapTo, setSwapTo] = useState("USDT");
  const [swapAmount, setSwapAmount] = useState("");
  const [swapNotice, setSwapNotice] = useState("");
  const [addressMessage, setAddressMessage] = useState("");
  const [wcProvider, setWcProvider] = useState(null);
  const [wcProviderKind, setWcProviderKind] = useState("");
  const [wcAccount, setWcAccount] = useState("");
  const [wcChainId, setWcChainId] = useState(null);
  const [wcBusy, setWcBusy] = useState(false);
  const [wcError, setWcError] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [historyTransactions, setHistoryTransactions] = useState([]);
  const [historyPagination, setHistoryPagination] = useState({ limit: 50, offset: 0, total: 0, has_more: false, next_offset: null });
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [copiedAddress, setCopiedAddress] = useState("");
  const [toolItems, setToolItems] = useState([]);
  const [chainResult, setChainResult] = useState(null);
  const [proofData, setProofData] = useState(null);
  const [apiKeyBalance, setApiKeyBalance] = useState(null);
  const [apiKeyBalanceBusy, setApiKeyBalanceBusy] = useState(false);
  const [apiKeyBalanceMessage, setApiKeyBalanceMessage] = useState("");
  const [userApiKeys, setUserApiKeys] = useState([]);
  const [userApiKeyName, setUserApiKeyName] = useState("My API key");
  const [existingUserApiKey, setExistingUserApiKey] = useState("");
  const [createdUserApiKey, setCreatedUserApiKey] = useState("");
  const [userApiKeyMessage, setUserApiKeyMessage] = useState("");
  const [userApiKeysBusy, setUserApiKeysBusy] = useState(false);
  const [coingeckoKeys, setCoingeckoKeys] = useState([]);
  const [coingeckoKeyName, setCoingeckoKeyName] = useState("CoinGecko key");
  const [coingeckoKeyValue, setCoingeckoKeyValue] = useState("");
  const [coingeckoBaseUrl, setCoingeckoBaseUrl] = useState("https://api.coingecko.com/api/v3");
  const [coingeckoKeyBusy, setCoingeckoKeyBusy] = useState(false);
  const [coingeckoKeyMessage, setCoingeckoKeyMessage] = useState("");
  const [walletProfiles, setWalletProfiles] = useState([]);
  const [targetWalletId, setTargetWalletId] = useState("");
  const [toolBusy, setToolBusy] = useState(false);
  const requestKeyRef = useRef("");

  useEffect(() => {
    if (active !== "API Keys" || !accessToken) return;
    let cancelled = false;
    fetch(apiBaseUrl + "/api/v1/api-keys", { headers: { Authorization: "Bearer " + accessToken } })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Could not load API keys.");
        if (!cancelled) setUserApiKeys(data.keys || []);
      })
      .catch(error => { if (!cancelled) setUserApiKeyMessage(error.message || "Could not load API keys."); });
    return () => { cancelled = true; };
  }, [active, apiBaseUrl, accessToken]);

  useEffect(() => {
    if (active !== "API Keys" || !accessToken) return;
    let cancelled = false;
    fetch(apiBaseUrl + "/api/v1/coingecko-keys", { headers: { Authorization: "Bearer " + accessToken } })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "CoinGecko key manager is unavailable.");
        if (!cancelled) setCoingeckoKeys(data.keys || []);
      })
      .catch(error => { if (!cancelled) setCoingeckoKeyMessage(error.message || "CoinGecko key manager is unavailable."); });
    return () => { cancelled = true; };
  }, [active, apiBaseUrl, accessToken]);

  useEffect(() => {
    if (selectedAsset && selectedAsset !== asset) setAsset(selectedAsset);
  }, [selectedAsset]);

  useEffect(() => {
    const options = networksForAsset(asset);
    if (options.length && !options.some(item => item.value === network)) setNetwork(options[0].value);
  }, [asset]);

  useEffect(() => {
    const syncLocalExternalAddress = () => {
      const localAddresses = getLocalExternalReceiveAddress();
      setAddresses(previous => {
        const serverAddresses = previous.filter(item => !item.local);
        return [...serverAddresses, ...localAddresses].filter((item, index, all) =>
          item?.address && item?.network &&
          all.findIndex(other => other.network === item.network && String(other.address).toLowerCase() === String(item.address).toLowerCase()) === index
        );
      });
    };
    window.addEventListener("world-wallet-external-connection-updated", syncLocalExternalAddress);
    window.addEventListener("storage", syncLocalExternalAddress);
    return () => {
      window.removeEventListener("world-wallet-external-connection-updated", syncLocalExternalAddress);
      window.removeEventListener("storage", syncLocalExternalAddress);
    };
  }, []);

  useEffect(() => {
    if (active !== "Receive" && active !== "Deposit") return;
    let cancelled = false;
    fetch(apiBaseUrl + "/api/v1/wallet/addresses", { headers: { Authorization: "Bearer " + accessToken } })
      .then(async r => ({ ok: r.ok, data: await r.json() }))
      .then(({ ok, data }) => {
        if (cancelled) return;
        const serverAddresses = ok && Array.isArray(data.addresses) ? data.addresses : [];
        const localExternalAddresses = getLocalExternalReceiveAddress();
        const combined = [...serverAddresses, ...localExternalAddresses].filter((item, index, all) =>
          item?.address && item?.network &&
          all.findIndex(other => other.network === item.network && String(other.address).toLowerCase() === String(item.address).toLowerCase()) === index
        );
        setAddresses(combined);
        setAddressMessage(ok ? (data.message || "") : (data.detail || "Unable to load saved addresses. A connected external public address may still be shown locally."));
      })
      .catch(() => { if (!cancelled) { setAddresses([]); setAddressMessage("Unable to load wallet addresses."); } });
    return () => { cancelled = true; };
  }, [active, apiBaseUrl, accessToken]);
  function persistExternalConnection(connection) {
    try {
      if (connection) localStorage.setItem("world_wallet_external_connection_v1", JSON.stringify(connection));
      else localStorage.removeItem("world_wallet_external_connection_v1");
    } catch {}
    window.dispatchEvent(new CustomEvent("world-wallet-external-connection-updated", { detail: connection }));
  }

  function parseExternalChainId(value) {
    if (typeof value === "number") return value;
    const text = String(value || "");
    if (!text) return null;
    const parsed = text.startsWith("0x") ? Number.parseInt(text, 16) : Number.parseInt(text, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async function connectInjectedWallet(kind) {
    setWcBusy(true);
    setWcError("");
    try {
      const candidates = [
        ...(Array.isArray(window.ethereum?.providers) ? window.ethereum.providers : []),
        ...(window.ethereum ? [window.ethereum] : []),
        ...(window.coinbaseWalletExtension ? [window.coinbaseWalletExtension] : []),
      ].filter((provider, index, all) => provider && typeof provider.request === "function" && all.indexOf(provider) === index);
      const provider = kind === "coinbase"
        ? candidates.find(item => item.isCoinbaseWallet) || null
        : candidates.find(item => item.isMetaMask && !item.isCoinbaseWallet) || null;
      if (!provider) {
        throw new Error(kind === "coinbase"
          ? "Coinbase Wallet extension was not detected. Open World Wallet AI in Coinbase Wallet's browser, or use WalletConnect."
          : "MetaMask was not detected. Open World Wallet AI in MetaMask's browser, install the extension, or use WalletConnect.");
      }
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const address = Array.isArray(accounts) ? accounts[0] : "";
      if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("The wallet did not provide a valid EVM address.");
      const rawChain = await provider.request({ method: "eth_chainId" });
      const chainId = parseExternalChainId(rawChain);
      const connection = { address, chainId, provider: kind, connectedAt: new Date().toISOString() };
      setWcProvider(provider);
      setWcProviderKind(kind);
      setWcAccount(address);
      setWcChainId(chainId);
      persistExternalConnection(connection);
      if (typeof provider.on === "function") {
        provider.on("accountsChanged", accountsChanged => {
          const nextAddress = Array.isArray(accountsChanged) ? accountsChanged[0] || "" : "";
          setWcAccount(nextAddress);
          persistExternalConnection(nextAddress ? { address: nextAddress, chainId: parseExternalChainId(provider.chainId) || chainId, provider: kind, connectedAt: new Date().toISOString() } : null);
        });
        provider.on("chainChanged", nextChain => {
          const nextChainId = parseExternalChainId(nextChain);
          setWcChainId(nextChainId);
          try {
            const previous = JSON.parse(localStorage.getItem("world_wallet_external_connection_v1") || "null");
            if (previous?.address) persistExternalConnection({ ...previous, chainId: nextChainId });
          } catch {}
        });
        provider.on("disconnect", () => {
          setWcAccount("");
          setWcChainId(null);
          setWcProvider(null);
          setWcProviderKind("");
          persistExternalConnection(null);
        });
      }
    } catch (error) {
      setWcError(error?.message || "External wallet connection failed.");
    } finally {
      setWcBusy(false);
    }
  }

  async function connectWalletConnect() {
    setWcBusy(true);
    setWcError("");
    try {
      const provider = await EthereumProvider.init({
        projectId: WALLETCONNECT_PROJECT_ID,
        chains: [1],
        optionalChains: [11155111, 56],
        showQrModal: true,
        methods: ["eth_sendTransaction", "personal_sign", "eth_signTypedData", "eth_signTypedData_v4", "eth_accounts", "eth_requestAccounts", "wallet_switchEthereumChain", "wallet_addEthereumChain"],
        events: ["accountsChanged", "chainChanged", "disconnect"],
        metadata: {
          name: "World Wallet AI",
          description: "Connect an external wallet to World Wallet AI",
          url: window.location.origin,
          icons: [window.location.origin + "/favicon.ico"],
        },
      });
      provider.on("accountsChanged", accounts => {
        const address = accounts?.[0] || "";
        setWcAccount(address);
        const connection = address ? { address, chainId: parseExternalChainId(provider.chainId), connectedAt: new Date().toISOString() } : null;
        try { if (connection) localStorage.setItem("world_wallet_external_connection_v1", JSON.stringify(connection)); else localStorage.removeItem("world_wallet_external_connection_v1"); } catch {}
        window.dispatchEvent(new CustomEvent("world-wallet-external-connection-updated", { detail: connection }));
      });
      provider.on("chainChanged", chain => {
        setWcChainId(parseExternalChainId(chain));
        try {
          const previous = JSON.parse(localStorage.getItem("world_wallet_external_connection_v1") || "null");
          if (previous?.address) {
            const connection = { ...previous, chainId: parseExternalChainId(chain) };
            localStorage.setItem("world_wallet_external_connection_v1", JSON.stringify(connection));
            window.dispatchEvent(new CustomEvent("world-wallet-external-connection-updated", { detail: connection }));
          }
        } catch {}
      });
      provider.on("disconnect", () => {
        setWcAccount(""); setWcChainId(null); setWcProvider(null); setWcProviderKind("");
        try { localStorage.removeItem("world_wallet_external_connection_v1"); } catch {}
        window.dispatchEvent(new CustomEvent("world-wallet-external-connection-updated", { detail: null }));
      });
      await provider.connect();
      const accounts = await provider.request({ method: "eth_accounts" });
      setWcAccount(accounts?.[0] || "");
      setWcChainId(parseExternalChainId(provider.chainId));
      setWcProvider(provider);
      setWcProviderKind("walletconnect");
      if (accounts?.[0]) {
        const connection = { address: accounts[0], chainId: parseExternalChainId(provider.chainId), provider: "walletconnect", connectedAt: new Date().toISOString() };
        try { localStorage.setItem("world_wallet_external_connection_v1", JSON.stringify(connection)); } catch {}
        window.dispatchEvent(new CustomEvent("world-wallet-external-connection-updated", { detail: connection }));
      }
      if (!accounts?.[0]) setWcError("Wallet connected without exposing an account. Unlock your wallet and try again.");
    } catch (error) {
      setWcError(error?.message || "WalletConnect could not connect. Check the Project ID and try again.");
    } finally {
      setWcBusy(false);
    }
  }

  async function disconnectWalletConnect() {
    setWcBusy(true);
    setWcError("");
    try {
      if (wcProvider) {
        if (wcProviderKind === "walletconnect" && typeof wcProvider.disconnect === "function") await wcProvider.disconnect();
        if (typeof wcProvider.removeAllListeners === "function") wcProvider.removeAllListeners();
      }
    } catch (error) {
      setWcError(error?.message || "Could not disconnect the wallet session cleanly.");
    } finally {
      setWcProvider(null);
      setWcProviderKind("");
      setWcAccount("");
      setWcChainId(null);
      try { localStorage.removeItem("world_wallet_external_connection_v1"); } catch {}
      window.dispatchEvent(new CustomEvent("world-wallet-external-connection-updated", { detail: null }));
      setWcBusy(false);
    }
  }

  async function changeWalletConnect() {
    // Close the existing WalletConnect session before opening a fresh wallet picker.
    await disconnectWalletConnect();
    await connectWalletConnect();
  }

  async function loadTransactionHistory({ offset = 0, append = false } = {}) {
    if (!accessToken || historyBusy) return;
    setHistoryBusy(true);
    setHistoryError("");
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/transactions?limit=50&offset=" + offset, {
        headers: await walletAuthHeaders(accessToken),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Could not load transaction history.");
      const rows = Array.isArray(data.transactions) ? data.transactions.map(item => ({
        ...item,
        raw_amount: item.raw_amount ?? item.amount,
        time: item.time ? new Date(item.time).toLocaleString() : "Time unavailable",
      })) : [];
      setHistoryTransactions(previous => append ? [...previous, ...rows.filter(row => !previous.some(old => String(old.id) === String(row.id)))] : rows);
      setHistoryPagination(data.pagination || { limit: 50, offset: 0, total: rows.length, has_more: false, next_offset: null });
    } catch (error) {
      setHistoryError(error.message || "Could not load transaction history.");
    } finally {
      setHistoryBusy(false);
    }
  }

  useEffect(() => {
    if (active !== "Transactions" || !accessToken) return;
    setHistoryTransactions([]);
    setHistoryPagination({ limit: 50, offset: 0, total: 0, has_more: false, next_offset: null });
    loadTransactionHistory({ offset: 0, append: false });
  }, [active, accessToken, apiBaseUrl]);

  const selectedWalletAsset = assets.find(item => item.symbol === asset) || null;
  const selectedAssetAvailable = Math.max(0, Number(
    selectedWalletAsset?.available_balance ??
    selectedWalletAsset?.available ??
    selectedWalletAsset?.balance ??
    0
  ));
  const parsedAmountForGuard = Number(amount);
  const amountExceedsAvailable = Number.isFinite(parsedAmountForGuard) && parsedAmountForGuard > selectedAssetAvailable;
  const amountInvalid = amount !== "" && (!Number.isFinite(parsedAmountForGuard) || parsedAmountForGuard <= 0);

  function useMaxAvailable() {
    if (!selectedWalletAsset || selectedAssetAvailable <= 0) {
      setMessage("No available balance is currently available for this asset.");
      return;
    }
    setAmount(String(selectedAssetAvailable));
    setMessage("");
  }

  function decimalToUnits(value, decimals) {
    const raw = String(value).trim();
    if (!/^\\d+(\\.\\d+)?$/.test(raw)) throw new Error("Invalid amount.");
    const [whole, fraction = ""] = raw.split(".");
    if (fraction.length > decimals) throw new Error("Amount has too many decimal places for this asset.");
    return BigInt(whole + fraction.padEnd(decimals, "0"));
  }

  async function broadcastExternalBitcoin({ transactionId, amount, destination }) {
    if (!window.unisat) throw new Error("No compatible Bitcoin external wallet is available. Install or open a wallet that exposes the UniSat provider.");
    const configResponse = await fetch(apiBaseUrl + "/api/v1/wallet/signing-config", { headers: { Authorization: "Bearer " + accessToken } });
    const config = await configResponse.json();
    if (!configResponse.ok || !config.bitcoin?.wallet_address) throw new Error("Production Bitcoin signing is not configured.");
    const accounts = await window.unisat.requestAccounts();
    const signer = accounts?.[0];
    if (!signer || signer.toLowerCase() !== config.bitcoin.wallet_address.toLowerCase()) {
      throw new Error("Connect the configured production Bitcoin wallet address before signing this transaction.");
    }
    if (window.unisat.switchNetwork) await window.unisat.switchNetwork("livenet");
    const satoshis = Number(decimalToUnits(amount, 8));
    if (!Number.isSafeInteger(satoshis) || satoshis <= 0) throw new Error("Bitcoin amount is outside the external wallet's safe signing range.");
    const txHash = await window.unisat.sendBitcoin(destination, satoshis);
    if (!txHash) throw new Error("External Bitcoin wallet did not return a transaction hash.");
    const settleResponse = await fetch(apiBaseUrl + "/api/v1/transactions/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
      body: JSON.stringify({ transaction_id: transactionId, tx_hash: txHash }),
    });
    const settleData = await settleResponse.json();
    if (!settleResponse.ok) throw new Error(settleData.detail || "Bitcoin broadcast verification failed.");
    return settleData;
  }

  async function broadcastExternalEvm({ transactionId, endpoint, asset, amount, network, destination }) {
    if (!window.ethereum) throw new Error("No compatible external EVM wallet is available. Connect a browser wallet that supports EVM signing.");
    const configResponse = await fetch(apiBaseUrl + "/api/v1/wallet/signing-config", { headers: { Authorization: "Bearer " + accessToken } });
    const config = await configResponse.json();
    if (!configResponse.ok) throw new Error(config.detail || "External wallet signing is not configured.");
    const networkConfig = config.networks?.[network];
    if (!networkConfig?.wallet_address) throw new Error("Production " + network + " signing address is not configured.");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const signer = accounts?.[0];
    if (!signer || signer.toLowerCase() !== networkConfig.wallet_address.toLowerCase()) {
      throw new Error("Connect the configured production wallet address before signing this transaction.");
    }
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    if (chainId.toLowerCase() !== networkConfig.chain_id.toLowerCase()) {
      try {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: networkConfig.chain_id }] });
      } catch (error) {
        if (Number(error?.code) === 4001) throw error;
        throw new Error("Switch the external wallet to the " + (network === "ethereum" ? "Ethereum" : "BNB Chain") + " mainnet.");
      }
    }

    const tx = { from: signer, to: destination };
    if (asset === "ETH" || asset === "BNB") {
      tx.value = "0x" + decimalToUnits(amount, 18).toString(16);
    } else if (asset === "USDT" || asset === "BALMZ") {
      const contract = asset === "BALMZ" ? networkConfig.balmz_contract : networkConfig.usdt_contract;
      const configuredDecimals = asset === "BALMZ" ? networkConfig.balmz_decimals : networkConfig.usdt_decimals;
      if (!contract || configuredDecimals == null) throw new Error(asset + " external signing is not configured for this network.");
      const decimals = Number(configuredDecimals);
      const units = decimalToUnits(amount, decimals);
      const cleanDestination = destination.replace(/^0x/, "").toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(cleanDestination)) throw new Error("Invalid EVM destination address.");
      tx.to = contract;
      tx.data = "0xa9059cbb" + cleanDestination.padStart(64, "0") + units.toString(16).padStart(64, "0");
      tx.value = "0x0";
    } else {
      throw new Error("This asset is not available for live external EVM broadcast yet.");
    }

    const txHash = await window.ethereum.request({ method: "eth_sendTransaction", params: [tx] });
    if (!txHash) throw new Error("External wallet did not return a transaction hash.");

    const settleResponse = await fetch(apiBaseUrl + "/api/v1/transactions/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
      body: JSON.stringify({ transaction_id: transactionId, tx_hash: txHash }),
    });
    const settleData = await settleResponse.json();
    if (!settleResponse.ok) throw new Error(settleData.detail || "Broadcast was sent but verification failed.");
    return settleData;
  }

  function isUserRejectedError(error) {
    return Number(error?.code) === 4001 || /user rejected|user denied|rejected the request|denied the request/i.test(String(error?.message || ""));
  }

  async function cancelUnbroadcastTransaction(transactionId) {
    if (!transactionId) return false;
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/transactions/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
        body: JSON.stringify({ transaction_id: transactionId }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function submit(endpoint) {
    setBusy(true); setMessage("");
    let transactionId = "";
    try {
      const parsedAmount = Number(amount);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) throw new Error("Enter an amount greater than zero.");
      if (!destination.trim()) throw new Error("Enter a destination address.");
      const selectedAsset = assets.find(item => item.symbol === asset);
      if (!selectedAsset) throw new Error("Select a supported wallet asset.");
      const availableBalance = Math.max(0, Number(selectedAsset.available_balance ?? selectedAsset.available ?? selectedAsset.balance ?? 0));
      if (parsedAmount > availableBalance) throw new Error(`Amount exceeds the available ${asset} balance of ${number(availableBalance)}.`);

      const isLiveEvm = (network === "ethereum" || network === "bnb") && ["ETH", "BNB", "USDT", "BALMZ"].includes(asset);
      const isLiveBitcoin = network === "bitcoin" && asset === "BTC";
      if (isLiveEvm && !window.ethereum) throw new Error("Connect a compatible external EVM wallet to send live funds. No transaction will be recorded without a signer.");
      if (isLiveBitcoin && !window.unisat) throw new Error("Connect a compatible external Bitcoin wallet to send live BTC. No transaction will be recorded without a signer.");

      const requestKey = requestKeyRef.current || crypto.randomUUID();
      requestKeyRef.current = requestKey;
      const body = { idempotency_key: requestKey, asset, amount: parsedAmount, network, note: note || null };
      body[endpoint.includes("transfers") ? "recipient" : "destination"] = destination;
      const r = await fetch(apiBaseUrl + endpoint, { method:"POST", headers:{"Content-Type":"application/json", Authorization:"Bearer "+accessToken}, body:JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok || data.status === "rejected") throw new Error(data.detail || data.reason || "Request failed");

      transactionId = data.transfer?.id || data.withdrawal?.id;
      if (isLiveEvm && transactionId) {
        const settlement = await broadcastExternalEvm({ transactionId, endpoint, asset, amount: parsedAmount, network, destination: destination.trim() });
        setMessage(settlement.status === "broadcast_pending" ? "Live transaction broadcast. Waiting for blockchain confirmation." : "Live transaction verified and wallet accounting reconciled.");
      } else if (isLiveBitcoin && transactionId) {
        const settlement = await broadcastExternalBitcoin({ transactionId, amount: parsedAmount, destination: destination.trim() });
        setMessage(settlement.status === "broadcast_pending" ? "Live Bitcoin transaction broadcast. Waiting for confirmation." : "Live Bitcoin transaction verified and wallet accounting reconciled.");
      } else {
        setMessage("Request accepted: " + data.status.replace("_"," "));
      }
      setAmount(""); setDestination(""); setNote(""); requestKeyRef.current = "";
      if (onTransactionsUpdated) {
        const refresh = await fetch(apiBaseUrl + "/api/v1/wallet/refresh", { method:"POST", headers:{ Authorization:"Bearer "+accessToken } });
        const refreshed = await refresh.json();
        if (refresh.ok) {
          onTransactionsUpdated(refreshed.transactions || []);
          onWalletUpdated?.({ wallet: refreshed.wallet, assets: refreshed.assets || [] });
        } else {
          const transactionResponse = await fetch(apiBaseUrl + "/api/v1/transactions", { headers: { Authorization:"Bearer "+accessToken } });
          if (transactionResponse.ok) {
            const transactionData = await transactionResponse.json();
            onTransactionsUpdated(transactionData.transactions || []);
          }
        }
      }
    } catch (e) {
      const rejected = isUserRejectedError(e);
      if (rejected && transactionId) {
        const cancelled = await cancelUnbroadcastTransaction(transactionId);
        requestKeyRef.current = "";
        setMessage(cancelled
          ? "External wallet signing was cancelled. The pending reservation was released; no blockchain transaction was broadcast."
          : "External wallet signing was cancelled. The request could not be auto-cancelled; verify the pending request before retrying.");
      } else {
        setMessage(e.message || "Transaction request failed.");
      }
    } finally { setBusy(false); }
  }


  if (active === "Proof of Reserves") {
    const loadProof = async () => {
      setToolBusy(true); setMessage(""); setProofData(null);
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/wallet/proof-of-reserves", { headers: { Authorization: "Bearer " + accessToken } });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Unable to read on-chain reserves.");
        setProofData(data);
        setMessage(data.warnings?.length ? "Snapshot loaded with warnings; review unavailable networks." : "On-chain snapshot refreshed.");
      } catch (error) { setMessage(error.message || "Reserve snapshot unavailable."); }
      finally { setToolBusy(false); }
    };
    const createdContracts = (() => { try { const value = JSON.parse(localStorage.getItem("world_wallet_deployed_contracts_v1") || "[]"); return Array.isArray(value) ? value : []; } catch { return []; } })();
    return <section className="content feature-content">
      <div className="page-heading"><div><p className="eyebrow">TRANSPARENCY</p><h1>Proof of Reserves</h1><p className="muted">Read-only balances from public blockchain addresses connected to your wallet.</p></div><button className="secondary" onClick={loadProof} disabled={toolBusy}>{toolBusy ? "Checking chains…" : "↻ Refresh snapshot"}</button></div>
      {message && <div className={/unavailable|failed|unable|not configured/i.test(message) ? "feature-error" : "feature-success"}>{message}</div>}
      <article className="panel action-panel">
        <div className="tool-status"><span className="status-dot"></span><b>{proofData ? (proofData.status === "partial" ? "Partial on-chain snapshot" : "On-chain snapshot") : "Not yet checked"}</b></div>
        <p className="muted">{proofData?.scope || "Connected addresses only. Load a snapshot to read confirmed Bitcoin and latest EVM balances."}</p>
        {proofData?.as_of && <div className="security-note">Snapshot time: {new Date(proofData.as_of).toLocaleString()}</div>}
        {proofData?.reserves?.length ? <div className="tool-list">{proofData.reserves.map((item,index)=><div className="tool-row" key={item.network+item.address+item.asset+index}><div><b>{item.asset} · {item.network.toUpperCase()}</b><small>{item.block_number == null ? "Confirmed chain data" : "Block "+Number(item.block_number).toLocaleString()}</small><small>{item.source}</small></div><code>{item.address}</code><strong>{item.balance == null ? "Unavailable" : number(item.balance)+" "+item.asset}</strong></div>)}</div> : <div className="live-chart-empty">No snapshot loaded. Connect a public address under Wallets, then refresh.</div>}
        {proofData?.warnings?.map((warning,index)=><div className="security-note" key={index}>Warning: {warning}</div>)}
        <div className="panel action-panel">
          <p className="feature-kicker">DEPLOYED TOKEN CONTRACT REGISTER · READ ONLY</p>
          <h2>World Wallet AI created contracts</h2>
          <p className="muted">Read-only records saved in this browser. A listed contract is not itself proof of reserves or an audit.</p>
          {createdContracts.length ? <div className="tool-list">{createdContracts.map((item,index)=><div className="tool-row" key={item.address + item.network + index}>
            <div><b>{item.name} ({item.symbol})</b><small>{item.network === "sepolia" ? "Ethereum Sepolia" : item.network === "ethereum" ? "Ethereum Mainnet" : item.network} · {item.status || "local record"}</small><small>Supply: {item.supply} · Decimals: {item.decimals}</small><small>Transaction: {item.txHash || "Not recorded"}</small></div>
            <code>{item.address}</code>
            <strong><a href={item.explorerUrl} target="_blank" rel="noreferrer">View on explorer ↗</a></strong>
          </div>)}</div> : <div className="live-chart-empty">No locally recorded contracts. Create and deploy a contract from Contract Generator first.</div>}
        </div>
        <div className="security-note">Important: this is not an audited proof of reserves. It shows on-chain assets at connected addresses only; it does not verify ownership, platform-wide customer liabilities, off-chain assets, or solvency. Sepolia test funds are excluded.</div>
        {proofData && <button className="secondary" onClick={async()=>{try{if(!navigator.clipboard?.writeText)throw new Error("Clipboard unavailable");await navigator.clipboard.writeText(JSON.stringify(proofData,null,2));setMessage("Proof-of-reserves snapshot copied.");}catch{setMessage("Clipboard unavailable. You can review the snapshot values above.");}}}>Copy snapshot data</button>}
      </article>
    </section>;
  }

  if (active === "Sepolia Converter") {
    const inspectSepolia = async () => {
      if (!destination.trim()) { setMessage("Enter a public Sepolia address first."); return; }
      setToolBusy(true); setMessage(""); setChainResult(null);
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/tools/address-balance", {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
          body: JSON.stringify({ address: destination.trim(), network: "sepolia" }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Sepolia lookup failed.");
        setChainResult(data);
        setMessage("Sepolia balance loaded from the test network.");
      } catch (error) { setMessage(error.message || "Sepolia lookup failed."); }
      finally { setToolBusy(false); }
    };
    const testAmount = Number(amount);
    const hypotheticalUsd = chainResult?.mainnet_eth_usd_price != null && Number.isFinite(testAmount) && testAmount >= 0 ? testAmount * Number(chainResult.mainnet_eth_usd_price) : null;
    return <section className="content feature-content">
      <div className="page-heading"><div><p className="eyebrow">TESTNET TOOLS</p><h1>Sepolia Converter</h1><p className="muted">Inspect Sepolia ETH and calculate a hypothetical mainnet-price reference.</p></div><button className="secondary" onClick={()=>setActive("Wallets")}>Attach address →</button></div>
      <div className="security-note">Sepolia ETH is testnet-only. It cannot be converted into real ETH or cash by changing an address. Any USD figure is only a reference based on the ETH mainnet market price.</div>
      <article className="panel action-panel">
        <label>Sepolia public address<input value={destination} onChange={e=>{setDestination(e.target.value);setChainResult(null);setMessage("");}} placeholder="0x…"/></label>
        {message && <div className={/failed|unable|invalid|enter|check/i.test(message)?"feature-error":"feature-success"}>{message}</div>}
        <button className="primary feature-submit" disabled={toolBusy||!destination.trim()} onClick={inspectSepolia}>{toolBusy?"Reading Sepolia…":"Read Sepolia balance →"}</button>
        {chainResult && <div className="feature-summary">
          <span className="feature-kicker">LIVE TESTNET BALANCE</span>
          <div className="hero-balance">{number(chainResult.on_chain_balance)} <small>Sepolia ETH</small></div>
          <div className="security-note">Block {chainResult.block_number == null ? "unavailable" : Number(chainResult.block_number).toLocaleString()} · {chainResult.address}</div>
          {chainResult.mainnet_eth_usd_price != null && <div className="security-note">Mainnet ETH reference price: {money(chainResult.mainnet_eth_usd_price)} per ETH. This does not give testnet ETH real-world value.</div>}
          <label>Amount of Sepolia ETH to compare<input inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.5"/></label>
          <div className="hero-balance">{hypotheticalUsd == null ? "—" : money(hypotheticalUsd)} <small>hypothetical USD reference</small></div>
          <div className="security-note">No bridge, swap, or real-coin redemption is performed by this tool.</div>
        </div>}
      </article>
    </section>;
  }

  if (active === "API Keys") {
    const checkProviderKey = async () => {
      setApiKeyBalanceBusy(true); setApiKeyBalanceMessage("");
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/api-request/key-balance", { headers: { Authorization: "Bearer " + accessToken } });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "CoinGecko key status request failed.");
        setApiKeyBalance(data);
        setApiKeyBalanceMessage("CoinGecko key status loaded from the backend.");
      } catch (error) { setApiKeyBalance(null); setApiKeyBalanceMessage(error.message || "CoinGecko key status is unavailable."); }
      finally { setApiKeyBalanceBusy(false); }
    };
    return <section className="content feature-content">
      <div className="page-heading"><div><p className="eyebrow">PROVIDER CONFIGURATION</p><h1>CoinGecko API</h1><p className="muted">Market-price integration status and secure API-key setup.</p></div><button className="secondary" onClick={() => setActive("Dashboard")}>← Dashboard</button></div>
      <article className="panel action-panel ww-api-key-manager">
        <div className="panel-head"><div><h2>Your World Wallet API keys</h2><span>Create keys for your own API integrations</span></div><button className="secondary" disabled={userApiKeysBusy} onClick={async()=>{setUserApiKeysBusy(true);setUserApiKeyMessage("");try{const r=await fetch(apiBaseUrl+"/api/v1/api-keys",{headers:{Authorization:"Bearer "+accessToken}});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Unable to load keys.");setUserApiKeys(d.keys||[]);setUserApiKeyMessage("API key list refreshed.");}catch(e){setUserApiKeyMessage(e.message||"Unable to load keys.");}finally{setUserApiKeysBusy(false);}}}>↻ Refresh</button></div>
        <p className="muted">Keys are stored as one-way hashes on the server. A newly created key is shown only once; copy it immediately and keep it private.</p>
        <div className="ww-api-key-create"><label>Key name<input value={userApiKeyName} maxLength={80} onChange={e=>setUserApiKeyName(e.target.value)} placeholder="My integration"/></label><button className="primary" disabled={userApiKeysBusy||!userApiKeyName.trim()} onClick={async()=>{setUserApiKeysBusy(true);setUserApiKeyMessage("");setCreatedUserApiKey("");try{const r=await fetch(apiBaseUrl+"/api/v1/api-keys",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+accessToken},body:JSON.stringify({name:userApiKeyName.trim()})});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Could not create API key.");setCreatedUserApiKey(d.api_key||"");setUserApiKeyMessage("API key created. Copy it now; it will not be shown again.");const list=await fetch(apiBaseUrl+"/api/v1/api-keys",{headers:{Authorization:"Bearer "+accessToken}});const listData=await list.json();if(list.ok)setUserApiKeys(listData.keys||[]);}catch(e){setUserApiKeyMessage(e.message||"Could not create API key.");}finally{setUserApiKeysBusy(false);}}}>{userApiKeysBusy?"Working…":"＋ Create API key"}</button></div>
        <details className="ww-api-import"><summary>Add existing World Wallet API key</summary><p className="muted">Import an existing <code>wwai_…</code> key so it appears in this account's key list. Only its hash is stored.</p><label>Existing API key<input type="password" autoComplete="off" value={existingUserApiKey} onChange={e=>setExistingUserApiKey(e.target.value)} placeholder="wwai_…"/></label><button className="secondary" disabled={userApiKeysBusy||!existingUserApiKey.trim()} onClick={async()=>{setUserApiKeysBusy(true);setUserApiKeyMessage("");try{const r=await fetch(apiBaseUrl+"/api/v1/api-keys/import",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+accessToken},body:JSON.stringify({name:userApiKeyName.trim()||"Imported API key",api_key:existingUserApiKey.trim()})});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Could not import API key.");setExistingUserApiKey("");setUserApiKeyMessage(d.message||"Existing API key imported.");const list=await fetch(apiBaseUrl+"/api/v1/api-keys",{headers:{Authorization:"Bearer "+accessToken}});const listData=await list.json();if(list.ok)setUserApiKeys(listData.keys||[]);}catch(e){setUserApiKeyMessage(e.message||"Could not import API key.");}finally{setUserApiKeysBusy(false);}}}>Import existing key</button></details>
        {createdUserApiKey&&<div className="ww-api-key-once"><b>Copy your new key now</b><code>{createdUserApiKey}</code><button className="secondary" onClick={async()=>{try{await navigator.clipboard.writeText(createdUserApiKey);setUserApiKeyMessage("API key copied to clipboard.");}catch{setUserApiKeyMessage("Clipboard unavailable. Select and copy the key manually.");}}}>Copy key</button><small>For security, this raw key is held in the current page only and is not saved in browser storage.</small></div>}
        {userApiKeyMessage&&<div className={/could not|unable|failed|unavailable|requires/i.test(userApiKeyMessage)?"feature-error":"feature-success"} role="status">{userApiKeyMessage}</div>}
        <div className="ww-api-key-list">{userApiKeys.length?userApiKeys.map(key=><div className="ww-api-key-row" key={key.id}><div><b>{key.name}</b><small>{key.prefix}•••••• • Created {key.created_at?new Date(key.created_at).toLocaleDateString():"date unavailable"}</small><small>{key.revoked?"Revoked":key.last_used_at?"Last used "+new Date(key.last_used_at).toLocaleString():"Not used yet"}</small></div><span className={key.revoked?"ww-key-revoked":"ww-key-active"}>{key.revoked?"Revoked":"Active"}</span>{key.revoked?<button className="secondary" disabled={userApiKeysBusy} onClick={async()=>{setUserApiKeysBusy(true);try{const r=await fetch(apiBaseUrl+"/api/v1/api-keys/activate",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+accessToken},body:JSON.stringify({key_id:key.id})});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Unable to reactivate key.");setUserApiKeys(items=>items.map(item=>item.id===key.id?{...item,revoked:false}:item));setUserApiKeyMessage("API key reactivated.");}catch(e){setUserApiKeyMessage(e.message||"Unable to reactivate key.");}finally{setUserApiKeysBusy(false);}}}>Reactivate</button>:<button className="secondary" disabled={userApiKeysBusy} onClick={async()=>{if(!window.confirm("Revoke this API key? Any integration using it will stop authenticating."))return;setUserApiKeysBusy(true);try{const r=await fetch(apiBaseUrl+"/api/v1/api-keys/revoke",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+accessToken},body:JSON.stringify({key_id:key.id})});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Unable to revoke key.");setUserApiKeys(items=>items.map(item=>item.id===key.id?{...item,revoked:true}:item));setUserApiKeyMessage("API key revoked.");}catch(e){setUserApiKeyMessage(e.message||"Unable to revoke key.");}finally{setUserApiKeysBusy(false);}}}>Revoke</button>}</div>):<div className="live-chart-empty">No API keys created yet. Create one above to start.</div>}</div>
        <div className="security-note">These keys authenticate requests to World Wallet AI's API using the Bearer token header. Do not place keys in public repositories or frontend source code. Revoked keys stop working immediately.</div>
      </article>
      <article className="panel action-panel ww-api-key-manager">
        <div className="panel-head"><div><h2>CoinGecko provider keys</h2><span>Add multiple provider keys, then activate the one the wallet should use.</span></div></div>
        <p className="muted">Provider keys are encrypted on the backend. Only the configured administrator can manage them. Never paste a private key, wallet seed phrase, or World Wallet API token here.</p>
        <div className="feature-grid">
          <label>Key name<input value={coingeckoKeyName} maxLength={80} onChange={e=>setCoingeckoKeyName(e.target.value)} placeholder="CoinGecko Demo"/></label>
          <label>CoinGecko plan<select value={coingeckoBaseUrl} onChange={e=>setCoingeckoBaseUrl(e.target.value)}><option value="https://api.coingecko.com/api/v3">Demo API</option><option value="https://pro-api.coingecko.com/api/v3">Pro API</option></select></label>
        </div>
        <label>CoinGecko API key<input type="password" autoComplete="new-password" value={coingeckoKeyValue} onChange={e=>setCoingeckoKeyValue(e.target.value)} placeholder="Paste your CoinGecko API key" /></label>
        <button className="primary feature-submit" disabled={coingeckoKeyBusy||!coingeckoKeyName.trim()||!coingeckoKeyValue.trim()} onClick={async()=>{setCoingeckoKeyBusy(true);setCoingeckoKeyMessage("");try{const r=await fetch(apiBaseUrl+"/api/v1/coingecko-keys",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+accessToken},body:JSON.stringify({name:coingeckoKeyName.trim(),api_key:coingeckoKeyValue.trim(),base_url:coingeckoBaseUrl})});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Could not save CoinGecko key.");setCoingeckoKeyValue("");setCoingeckoKeyMessage(d.message||"CoinGecko key saved and activated.");const list=await fetch(apiBaseUrl+"/api/v1/coingecko-keys",{headers:{Authorization:"Bearer "+accessToken}});const ld=await list.json();if(list.ok)setCoingeckoKeys(ld.keys||[]);}catch(e){setCoingeckoKeyMessage(e.message||"Could not save CoinGecko key.");}finally{setCoingeckoKeyBusy(false);}}}>{coingeckoKeyBusy?"Saving securely…":"＋ Add and activate CoinGecko key"}</button>
        {coingeckoKeyMessage&&<div className={/failed|unable|not configured|only the configured|requires|set WORLD|unavailable|could not/i.test(coingeckoKeyMessage)?"feature-error":"feature-success"} role="status">{coingeckoKeyMessage}</div>}
        <div className="ww-api-key-list">{coingeckoKeys.length?coingeckoKeys.map(key=><div className="ww-api-key-row" key={key.id}><div><b>{key.name}</b><small>{key.prefix}•••• • {key.base_url.includes("pro-api")?"CoinGecko Pro":"CoinGecko Demo"}</small><small>{key.revoked?"Revoked":key.active?"Active for wallet":"Saved, not active"}{key.created_at?" • "+new Date(key.created_at).toLocaleDateString():""}</small></div><span className={key.revoked?"ww-key-revoked":key.active?"ww-key-active":"ww-key-revoked"}>{key.revoked?"Revoked":key.active?"Active":"Inactive"}</span>{(!key.active||key.revoked)&&<button className="secondary" disabled={coingeckoKeyBusy} onClick={async()=>{setCoingeckoKeyBusy(true);try{const r=await fetch(apiBaseUrl+"/api/v1/coingecko-keys/activate",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+accessToken},body:JSON.stringify({key_id:key.id})});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Unable to activate CoinGecko key.");const list=await fetch(apiBaseUrl+"/api/v1/coingecko-keys",{headers:{Authorization:"Bearer "+accessToken}});const ld=await list.json();if(list.ok)setCoingeckoKeys(ld.keys||[]);setCoingeckoKeyMessage("CoinGecko key activated.");}catch(e){setCoingeckoKeyMessage(e.message||"Unable to activate CoinGecko key.");}finally{setCoingeckoKeyBusy(false);}}}>Activate</button>}{!key.revoked&&<button className="secondary" disabled={coingeckoKeyBusy} onClick={async()=>{if(!window.confirm("Revoke this CoinGecko key? The wallet will stop using it."))return;setCoingeckoKeyBusy(true);try{const r=await fetch(apiBaseUrl+"/api/v1/coingecko-keys/revoke",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+accessToken},body:JSON.stringify({key_id:key.id})});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Unable to revoke CoinGecko key.");const list=await fetch(apiBaseUrl+"/api/v1/coingecko-keys",{headers:{Authorization:"Bearer "+accessToken}});const ld=await list.json();if(list.ok)setCoingeckoKeys(ld.keys||[]);setCoingeckoKeyMessage("CoinGecko key revoked.");}catch(e){setCoingeckoKeyMessage(e.message||"Unable to revoke CoinGecko key.");}finally{setCoingeckoKeyBusy(false);}}}>Revoke</button>}</div>):<div className="live-chart-empty">No CoinGecko provider keys saved yet.</div>}</div>
        <div className="security-note">Setup requirement: the backend must have WORLD_WALLET_SECRET_ENCRYPTION_KEY set, and WORLD_WALLET_COINGECKO_ADMIN_EMAIL set to your signed-in admin email (or use the existing configured Gemini/GitHub admin email). These settings are never shown in the wallet.</div>
      </article>
      <article className="panel action-panel"><h2>API connection status</h2><p>World Wallet AI fetches market prices through its backend. Wallet-managed CoinGecko keys are encrypted in the backend database and never returned to the browser after saving.</p>
        <div className="security-note">Required backend variable: <code>COINGECKO_API_KEY</code>. For a Demo key use <code>https://api.coingecko.com/api/v3</code>; for a Pro key set <code>COINGECKO_API_BASE_URL=https://pro-api.coingecko.com/api/v3</code>. The backend sends the key in the provider request header.</div>
        <div className="feature-grid"><div className="stat-card"><span>Market data endpoint</span><strong>/api/v1/prices/market</strong></div><div className="stat-card"><span>Refresh interval</span><strong>60 seconds</strong></div><div className="stat-card"><span>Secret storage</span><strong>Encrypted backend</strong></div></div>
        <button className="primary feature-submit" onClick={checkProviderKey} disabled={apiKeyBalanceBusy}>{apiKeyBalanceBusy ? "Checking provider…" : "Check configured CoinGecko key →"}</button>
        {apiKeyBalanceMessage && <div className={apiKeyBalance ? "feature-success" : "feature-error"}>{apiKeyBalanceMessage}</div>}
        {apiKeyBalance && <div className="feature-grid"><div className="stat-card"><span>Plan</span><strong>{apiKeyBalance.plan || "Not reported"}</strong></div><div className="stat-card"><span>Monthly calls used</span><strong>{apiKeyBalance.current_total_monthly_calls == null ? "Unavailable" : Number(apiKeyBalance.current_total_monthly_calls).toLocaleString()}</strong></div><div className="stat-card"><span>Monthly calls remaining</span><strong>{apiKeyBalance.current_remaining_monthly_calls == null ? "Unavailable" : Number(apiKeyBalance.current_remaining_monthly_calls).toLocaleString()}</strong></div><div className="stat-card"><span>Rate limit</span><strong>{apiKeyBalance.rate_limit_request_per_minute == null ? "Unavailable" : Number(apiKeyBalance.rate_limit_request_per_minute).toLocaleString() + " req/min"}</strong></div></div>}
        <div className="security-note">Use the CoinGecko provider keys card above to add, activate, or revoke keys from the wallet. If no wallet-managed key is active, the backend can still use the legacy <code>COINGECKO_API_KEY</code> and <code>COINGECKO_API_BASE_URL</code> Render environment settings. Never send your provider key in chat or commit it to source code.</div>
        <div className="ct-links"><a href="https://www.coingecko.com/en/api" target="_blank" rel="noreferrer">Get a CoinGecko API key ↗</a><a href="https://docs.coingecko.com/" target="_blank" rel="noreferrer">CoinGecko API documentation ↗</a></div>
      </article>
    </section>;
  }

  if (active === "API Request") {
    const checkApiKeyBalance = async () => {
      setApiKeyBalanceBusy(true);
      setApiKeyBalanceMessage("");
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/api-request/key-balance", {
          headers: { Authorization: "Bearer " + accessToken },
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Unable to check API key balance.");
        setApiKeyBalance(data);
        setApiKeyBalanceMessage("API key usage refreshed from the provider.");
      } catch (error) {
        setApiKeyBalance(null);
        setApiKeyBalanceMessage(error.message || "Unable to check API key balance.");
      } finally {
        setApiKeyBalanceBusy(false);
      }
    };

    const requestApiBalance = async () => {
      const evmAddress = destination.trim();
      if (!/^0x[a-fA-F0-9]{40}$/.test(evmAddress)) {
        setMessage("Enter a valid EVM address (0x followed by 40 hexadecimal characters).");
        setChainResult(null);
        return;
      }
      setToolBusy(true);
      setMessage("");
      setChainResult(null);
      const networksToCheck = [
        { network: "ethereum", label: "Ethereum", symbol: "ETH" },
        { network: "bnb", label: "BNB Chain", symbol: "BNB" },
        { network: "sepolia", label: "Sepolia testnet", symbol: "ETH" },
      ];
      try {
        const results = await Promise.all(networksToCheck.map(async item => {
          try {
            const response = await fetch(apiBaseUrl + "/api/v1/tools/address-balance", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
              body: JSON.stringify({ address: evmAddress, network: item.network }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.detail || item.label + " balance lookup failed.");
            return { ...item, ok: true, data };
          } catch (error) {
            return { ...item, ok: false, error: error.message || "Balance lookup unavailable." };
          }
        }));
        setChainResult({ apiBalanceResults: results, apiAddress: evmAddress, apiBalanceCheckedAt: new Date().toISOString() });
        const successes = results.filter(item => item.ok).length;
        setMessage(successes === results.length
          ? "API balance check completed for Ethereum, BNB Chain, and Sepolia."
          : successes
            ? "Balance results loaded where RPC access is available. Unavailable networks are marked below."
            : "No network balance was returned. Check the API/RPC configuration and try again.");
      } finally {
        setToolBusy(false);
      }
    };
    const apiBalanceResults = chainResult?.apiBalanceResults || [];
    return <section className="content feature-content">
      <div className="page-heading">
        <div><p className="eyebrow">DEVELOPER TOOLS</p><h1>API Request</h1><p className="muted">Request live EVM token and available-balance data using only a public EVM address.</p></div>
        <button className="secondary" onClick={() => setActive("API Keys")}>API Keys →</button>
      </div>
      <div className="security-note">Enter only a public 0x address. No private key, seed phrase, API secret, network selection, or transaction signing is needed. The API checks Ethereum, BNB Chain, and Sepolia independently; unavailable RPC networks are reported rather than guessed.</div>
      <article className="panel action-panel">
        <div className="panel-head"><div><p className="feature-kicker">API KEY BALANCE</p><h2>Provider API balance</h2><span>Check the server-configured CoinGecko key without exposing the secret in the browser.</span></div><button className="secondary" disabled={apiKeyBalanceBusy} onClick={checkApiKeyBalance}>{apiKeyBalanceBusy ? "Checking…" : "↻ Check API Balance"}</button></div>
        {apiKeyBalanceMessage && <div className={apiKeyBalance ? "feature-success" : "feature-error"}>{apiKeyBalanceMessage}</div>}
        {apiKeyBalance ? <div className="feature-grid">
          <div className="stat-card"><span>Monthly credits remaining</span><strong>{apiKeyBalance.current_remaining_monthly_calls == null ? "Unavailable" : Number(apiKeyBalance.current_remaining_monthly_calls).toLocaleString()}</strong></div>
          <div className="stat-card"><span>Monthly credits used</span><strong>{apiKeyBalance.current_total_monthly_calls == null ? "Unavailable" : Number(apiKeyBalance.current_total_monthly_calls).toLocaleString()}</strong></div>
          <div className="stat-card"><span>Monthly credit allowance</span><strong>{apiKeyBalance.monthly_call_credit == null ? "Unavailable" : Number(apiKeyBalance.monthly_call_credit).toLocaleString()}</strong></div>
          <div className="stat-card"><span>Rate limit</span><strong>{apiKeyBalance.rate_limit_request_per_minute == null ? "Unavailable" : Number(apiKeyBalance.rate_limit_request_per_minute).toLocaleString() + " req/min"}</strong></div>
          <div className="tool-row"><div><b>API plan</b><small>Provider-reported plan</small></div><strong>{apiKeyBalance.plan || "Not reported"}</strong></div>
        </div> : <div className="live-chart-empty">Tap “Check API Balance” to retrieve current API-key usage. This requires a valid CoinGecko API key configured on the backend.</div>}
        <div className="security-note">This is API-provider usage/remaining call credits, not a cryptocurrency wallet balance. The secret key stays on the server.</div>
      </article>

      <article className="panel action-panel">
        <p className="feature-kicker">ADDRESS-ONLY BALANCE REQUEST</p>
        <h2>Check API Balance</h2>
        <label>EVM public address<input value={destination} onChange={e => setDestination(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false}/></label>
        {message && <div className={/no network|invalid|failed|unavailable|enter a valid/i.test(message) ? "feature-error" : "feature-success"}>{message}</div>}
        <button className="primary feature-submit" disabled={toolBusy || !destination.trim()} onClick={requestApiBalance}>{toolBusy ? "Checking live balances…" : "Check API Balance →"}</button>
      </article>
      {apiBalanceResults.length > 0 && <article className="panel action-panel">
        <div className="panel-head"><div><p className="feature-kicker">API BALANCE</p><h2>Available balance results</h2><span>Address: <code>{chainResult.apiAddress}</code></span></div><small>{new Date(chainResult.apiBalanceCheckedAt).toLocaleString()}</small></div>
        {apiBalanceResults.map(result => <div className="api-balance-network" key={result.network}>
          <div className="panel-head"><div><b>{result.label}</b><small>{result.ok ? (result.data.block_number == null ? "Live API result" : "Block " + Number(result.data.block_number).toLocaleString()) : "Balance unavailable"}</small></div><strong className={result.ok ? "positive" : "negative"}>{result.ok ? number(result.data.available_balance ?? result.data.on_chain_balance) + " " + result.symbol : "Unavailable"}</strong></div>
          {result.ok ? <>
            <div className="tool-row"><div><b>Native available balance</b><small>{result.data.balance_basis}</small></div><strong>{number(result.data.available_balance ?? result.data.on_chain_balance)} {result.data.native_symbol || result.symbol}</strong></div>
            {result.data.tokens?.length ? result.data.tokens.map(token => <div className="tool-row" key={token.contract_address}><div><b>{token.symbol}</b><small>{token.name} · token balance</small></div><code>{token.contract_address}</code><strong>{token.available_balance == null ? "Unavailable" : number(token.available_balance) + " " + token.symbol}</strong></div>) : <div className="security-note">No configured ERC-20 token balances were returned for this network.</div>}
            {result.network === "sepolia" && <div className="security-note">Sepolia is a testnet. Test ETH and test tokens have no redeemable real-world value.</div>}
          </> : <div className="feature-error">{result.error}</div>}
        </div>)}
        <div className="security-note">These are read-only on-chain balances returned by the API, not an API-provider billing credit balance. Available balance is based on the current chain response; fees, locks, and protocol-specific restrictions may still apply.</div>
      </article>}
    </section>;
  }

  if (active === "Address Converter") {
    const inspectAddress = async () => {
      if (!destination.trim()) { setMessage("Enter the input address."); return; }
      setToolBusy(true); setMessage(""); setChainResult(null);
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/tools/address-balance", {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
          body: JSON.stringify({ address: destination.trim(), network, compare_address: note.trim() || null }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Address lookup failed.");
        setChainResult(data);
        setMessage("Live blockchain address lookup completed.");
      } catch (error) { setMessage(error.message || "Address lookup failed."); }
      finally { setToolBusy(false); }
    };
    const loadWalletProfiles = async () => {
      setToolBusy(true); setMessage("");
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/wallets", { headers: { Authorization: "Bearer " + accessToken } });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Unable to load wallet profiles.");
        setWalletProfiles(data.wallets || []);
        setTargetWalletId(data.active_wallet_id || data.wallets?.[0]?.id || "");
        setMessage("Wallet profiles loaded. Choose where to attach the public address.");
      } catch (error) { setMessage(error.message || "Unable to load wallet profiles."); }
      finally { setToolBusy(false); }
    };
    const attachAddress = async (value, label) => {
      if (!targetWalletId) { setMessage("Load wallet profiles and select a target wallet first."); return; }
      if (!value.trim()) { setMessage("Enter or inspect an address first."); return; }
      setToolBusy(true); setMessage("");
      try {
        const existingResponse = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(targetWalletId) + "/addresses", { headers: { Authorization: "Bearer " + accessToken } });
        const existingData = await existingResponse.json();
        if (!existingResponse.ok) throw new Error(existingData.detail || "Unable to inspect the selected wallet.");
        const existingAddress = (existingData.addresses || []).find(item => item.network === network);
        if (existingAddress && existingAddress.address.toLowerCase() === value.trim().toLowerCase()) {
          setMessage("This address is already attached to the selected wallet.");
          return;
        }
        if (existingAddress && !window.confirm("This wallet already has a " + network + " address. Replacing it will change which address is tracked for this network. Continue?")) {
          setMessage("Address attachment cancelled; existing wallet address was kept.");
          return;
        }
        const response = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(targetWalletId) + "/addresses", {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
          body: JSON.stringify({ network, address: value.trim(), label }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Unable to attach address.");
        setMessage("Public address attached to the selected wallet profile. This does not transfer funds or grant signing access.");
      } catch (error) { setMessage(error.message || "Unable to attach address."); }
      finally { setToolBusy(false); }
    };
    const renderAddress = (item,label) => <article className="panel action-panel" key={label}>
      <span className="feature-kicker">{label}</span><h2>{item.address}</h2>
      <div className="security-note">Input / tracked address: <code>{item.address}</code></div>
      <div className="feature-kicker">LIVE ON-CHAIN / AVAILABLE BALANCE</div>
      <div className="hero-balance">{number(item.on_chain_balance)} <small>{item.native_symbol}</small></div>
      <div className="security-note">Network: {item.network} · block {item.block_number == null ? "confirmed explorer data" : Number(item.block_number).toLocaleString()}</div>
      <div className="security-note">{item.balance_basis}</div>
      {item.tokens?.length ? <div className="tool-list">{item.tokens.map(token=><div className="tool-row" key={token.contract_address}><div><b>{token.symbol}</b><small>{token.name}</small></div><code>{token.contract_address}</code><strong>{token.on_chain_balance == null ? "Unavailable" : number(token.on_chain_balance)+" "+token.symbol}</strong></div>)}</div> : null}
    </article>;
    return <section className="content feature-content">
      <div className="page-heading"><div><p className="eyebrow">BLOCKCHAIN TOOLS</p><h1>Address Converter</h1><p className="muted">Compare real on-chain balances for two addresses on the same network.</p></div><button className="secondary" onClick={()=>setActive("Wallets")}>Wallet management →</button></div>
      <div className="security-note">This tool reads addresses; it does not move or duplicate assets. A balance shown for one address remains there until a real signed transaction transfers funds.</div>
      <article className="panel action-panel">
        <label>Network<select value={network} onChange={e=>setNetwork(e.target.value)}><option value="ethereum">Ethereum mainnet</option><option value="bnb">BNB Chain</option><option value="bitcoin">Bitcoin</option><option value="sepolia">Sepolia testnet</option></select></label>
        <label>Input address<input value={destination} onChange={e=>setDestination(e.target.value)} placeholder={network==="bitcoin"?"bc1…":"0x…"}/></label>
        <label>Compare with another address (optional)<input value={note} onChange={e=>setNote(e.target.value)} placeholder={network==="bitcoin"?"Second BTC address":"Second 0x address"}/></label>
        <div className="feature-grid">
          <label>Attach input address to wallet<select value={targetWalletId} onChange={e=>setTargetWalletId(e.target.value)}><option value="">Select wallet profile</option>{walletProfiles.map(item=><option key={item.id} value={item.id}>{item.name}{item.active?" • Active":""}</option>)}</select></label>
          <div className="page-actions"><button className="secondary" disabled={toolBusy} onClick={loadWalletProfiles}>Load wallet profiles</button><button className="secondary" disabled={toolBusy||!targetWalletId||!destination.trim()} onClick={()=>attachAddress(destination,"address converter")}>Attach input address</button></div>
        </div>
        {note.trim() && <button className="secondary" disabled={toolBusy||!targetWalletId} onClick={()=>attachAddress(note,"comparison address")}>Attach comparison address too</button>}
        {message && <div className={/failed|unable|invalid|enter|unsupported/i.test(message)?"feature-error":"feature-success"}>{message}</div>}
        <button className="primary feature-submit" disabled={toolBusy||!destination.trim()} onClick={inspectAddress}>{toolBusy?"Reading blockchain…":"Convert / compare addresses →"}</button>
      </article>
      {chainResult && <div className="feature-grid">{renderAddress(chainResult,"INPUT ADDRESS")}{chainResult.comparison ? renderAddress(chainResult.comparison,"COMPARISON ADDRESS") : <article className="panel action-panel"><h2>No comparison address</h2><p className="muted">Only the input address was checked. Enter a second address to compare its actual on-chain balance.</p></article>}</div>}
    </section>;
  }

  if (active === "Contract Converter") {
    const contractNetwork = ["ethereum", "bnb", "sepolia"].includes(network) ? network : "ethereum";
    const inspectContract = async () => {
      setToolBusy(true); setMessage(""); setChainResult(null);
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/contracts/inspect", {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
          body: JSON.stringify({ address: destination.trim(), network: contractNetwork }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Contract inspection failed.");
        setChainResult(data);
        setMessage(data.is_contract ? "Contract found; available metadata loaded." : "No deployed contract bytecode found at that address.");
      } catch (error) { setMessage(error.message || "Contract inspection failed."); }
      finally { setToolBusy(false); }
    };
    return <section className="content feature-content">
      <div className="page-heading"><div><p className="eyebrow">SMART CONTRACT TOOLS</p><h1>Contract Converter</h1><p className="muted">Inspect a contract address and resolve token metadata where supported.</p></div><button className="secondary" onClick={()=>setActive("Verify Contract")}>Verify bytecode →</button></div>
      <article className="panel action-panel">
        <label>Network<select value={contractNetwork} onChange={e=>{setContractNetwork(e.target.value);setChainResult(null);setMessage("");}}><option value="ethereum">Ethereum mainnet</option><option value="bnb">BNB Chain</option><option value="sepolia">Sepolia testnet</option></select></label>
        <label>Contract address<input value={destination} onChange={e=>setDestination(e.target.value)} placeholder="0x…"/></label>
        {message && <div className={/failed|unable|invalid|no deployed/i.test(message)?"feature-error":"feature-success"}>{message}</div>}
        <button className="primary feature-submit" disabled={toolBusy||destination.trim().length!==42} onClick={inspectContract}>{toolBusy?"Inspecting contract…":"Resolve contract →"}</button>
        {chainResult && <div className="feature-summary">
          <div className="tool-status"><span className="status-dot"></span><b>{chainResult.is_contract ? "Deployed contract" : "No contract bytecode"}</b></div>
          <div className="tool-row"><div><b>Network</b></div><strong>{chainResult.network}</strong></div>
          <div className="tool-row"><div><b>Contract address</b></div><code>{chainResult.address}</code><button className="secondary" onClick={async()=>{try{if(!navigator.clipboard?.writeText)throw new Error("Clipboard unavailable");await navigator.clipboard.writeText(chainResult.address);setMessage("Contract address copied.");}catch{setMessage("Clipboard unavailable. Select the contract address and copy it manually.");}}}>Copy</button></div>
          <div className="tool-row"><div><b>Token name</b></div><strong>{chainResult.name || "Not exposed"}</strong></div>
          <div className="tool-row"><div><b>Symbol</b></div><strong>{chainResult.symbol || "Not exposed"}</strong></div>
          <div className="tool-row"><div><b>Decimals</b></div><strong>{chainResult.decimals ?? "Not exposed"}</strong></div>
          <div className="security-note">{chainResult.note}</div>
          <div className="security-note">A contract address is not convertible into a normal wallet address. Metadata is optional and untrusted until independently reviewed.</div>
        </div>}
      </article>
    </section>;
  }

  if (active === "Contract Generator" || active === "Verify Contract") return <ContractTools active={active} setActive={setActive} />;

  if (active === "Wallets") return <WalletManager accessToken={accessToken} apiBaseUrl={apiBaseUrl} setActive={setActive} onTransactionsUpdated={onTransactionsUpdated} onWalletUpdated={onWalletUpdated} />;

  if (active === "Send" || active === "Withdraw") {
    const send = active === "Send";
    const networkOptions = networksForAsset(asset);
    const availableForAsset = selectedAssetAvailable;
    const selectedPrice = Number(selectedWalletAsset?.price_usd ?? (Number(selectedWalletAsset?.balance) > 0 ? Number(selectedWalletAsset?.value_usd || 0) / Number(selectedWalletAsset.balance) : 0));
    const amountUsd = selectedPrice > 0 && Number(amount) > 0 ? Number(amount) * selectedPrice : null;
    const destinationLooksValid = network === "bitcoin"
      ? /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{20,}$/i.test(destination.trim())
      : /^0x[a-fA-F0-9]{40}$/.test(destination.trim());
    return <section className="content feature-content wallet-action-page">
      <div className="page-heading">
        <div><p className="eyebrow">WALLET / TRANSFER</p><h1>{active === "Withdraw" ? "Withdraw assets" : "Send assets"}</h1><p className="muted">{send ? "Review the asset, network and recipient before your connected wallet signs." : "Prepare a withdrawal request and review its destination details."}</p></div>
        <button className="secondary" onClick={() => setActive("Dashboard")}>← Dashboard</button>
      </div>
      <div className="wallet-flow-steps" aria-label="Transfer steps">
        <div className="wallet-flow-step is-current"><span>1</span><div><b>Details</b><small>Asset and recipient</small></div></div>
        <div className="wallet-flow-connector"/>
        <div className="wallet-flow-step"><span>2</span><div><b>Review</b><small>Check the network</small></div></div>
        <div className="wallet-flow-connector"/>
        <div className="wallet-flow-step"><span>3</span><div><b>Confirm</b><small>Approve in wallet</small></div></div>
      </div>
      <div className="wallet-action-layout">
        <article className="panel wallet-form-card">
          <div className="wallet-card-heading"><span className="wallet-action-icon">{send ? "↗" : "⇥"}</span><div><h2>{send ? "Transfer details" : "Withdrawal details"}</h2><p>Fields marked below are required before continuing.</p></div></div>
          <label>Asset to {send ? "send" : "withdraw"}
            <select value={asset} onChange={e => { setAsset(e.target.value); setAmount(""); setMessage(""); }}>
              {assets.map(a => { const available = Math.max(0, Number(a.available_balance ?? a.available ?? a.balance ?? 0)); return <option key={a.symbol} value={a.symbol}>{a.symbol} · {number(available)} available</option>; })}
            </select>
          </label>
          <div className="wallet-amount-box">
            <div className="wallet-field-topline"><label htmlFor="wallet-send-amount">Amount</label><button type="button" className="amount-max" onClick={useMaxAvailable} disabled={availableForAsset <= 0 || busy}>Use MAX</button></div>
            <div className="wallet-amount-input-row"><input id="wallet-send-amount" type="number" min="0" max={availableForAsset > 0 ? availableForAsset : undefined} step="any" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" aria-invalid={amountExceedsAvailable || amountInvalid}/><strong>{asset}</strong></div>
            <div className={amountExceedsAvailable || amountInvalid ? "amount-availability amount-error" : "amount-availability"}><span>Available balance: {number(availableForAsset)} {asset}</span>{amountExceedsAvailable ? <b>Amount exceeds your available balance.</b> : amountInvalid ? <b>Enter an amount greater than zero.</b> : null}</div>
            {amountUsd != null && <div className="wallet-estimate">Indicative value: <b>{money(amountUsd)}</b></div>}
          </div>
          <label>{send ? "Recipient wallet address" : "Withdrawal destination"}
            <input value={destination} onChange={e => { setDestination(e.target.value); setMessage(""); }} placeholder={network === "bitcoin" ? "bc1… or 1… / 3…" : "0x…"} autoComplete="off" spellCheck="false"/>
          </label>
          <label>Network
            <select value={network} onChange={e => { setNetwork(e.target.value); setMessage(""); }} disabled={!networkOptions.length}>
              {networkOptions.length ? networkOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>) : <option value="">No supported network</option>}
            </select>
          </label>
          <div className={destination ? (destinationLooksValid ? "wallet-network-check is-valid" : "wallet-network-check is-warning") : "wallet-network-check"}>
            <span>{destination ? (destinationLooksValid ? "✓" : "!") : "i"}</span>
            <div><b>{destination ? (destinationLooksValid ? "Address format looks valid" : "Check the destination address") : "Network compatibility matters"}</b><small>Use an address for the selected network. A valid-looking address does not prove ownership or guarantee that the destination supports this asset.</small></div>
          </div>
          <label>Note <span className="wallet-optional">(optional)</span><textarea value={note} onChange={e => setNote(e.target.value)} maxLength="200" placeholder="Add a note for your records"/></label>
          {message && <div role="status" className={/accepted|broadcast|verified|reconciled/i.test(message) ? "feature-success" : "feature-error"}>{message}</div>}
          <button className="primary feature-submit wallet-submit" disabled={busy || !amount || amountInvalid || amountExceedsAvailable || availableForAsset <= 0 || !destination.trim() || !assets.some(item => item.symbol === asset) || !networkOptions.length || !network} onClick={() => submit(send ? "/api/v1/transfers" : "/api/v1/withdrawals")}>{busy ? "Processing securely…" : send ? "Continue to wallet confirmation →" : "Submit withdrawal request →"}</button>
          <p className="wallet-form-footnote">You will see a wallet approval prompt for supported live transfers. Never share a recovery phrase or private key with anyone.</p>
        </article>
        <aside className="wallet-review-column">
          <article className="panel wallet-review-card">
            <span className="feature-kicker">TRANSFER SUMMARY</span>
            <div className="wallet-summary-amount">{amount && Number(amount) > 0 ? number(amount) : "0.00"} <small>{asset}</small></div>
            <div className="wallet-summary-row"><span>From</span><b>Active World Wallet</b></div>
            <div className="wallet-summary-row"><span>Network</span><b>{networkOptions.find(n => n.value === network)?.label || "Not selected"}</b></div>
            <div className="wallet-summary-row"><span>To</span><code>{destination ? destination.slice(0, 9) + "…" + destination.slice(-6) : "Recipient not entered"}</code></div>
            <div className="wallet-summary-divider"/>
            <div className="wallet-summary-row"><span>Available USD balance</span><b>{money(wallet.available_balance_usd)}</b></div>
            <div className="wallet-summary-row"><span>Network fee</span><b className="wallet-fee-note">Shown by signer if available</b></div>
          </article>
          <article className="panel wallet-safety-card"><span className="wallet-safety-shield">✓</span><div><b>Self-custody stays yours</b><p>World Wallet AI does not ask for or store your external wallet's private key. Review the address and network in your wallet before signing.</p></div></article>
          <article className="panel wallet-safety-card"><span className="wallet-safety-shield">!</span><div><b>Transactions may be irreversible</b><p>Confirm the asset, chain, recipient and amount. Do not send testnet assets to a mainnet address expecting real value.</p></div></article>
        </aside>
      </div>
    </section>;
  }

  if (active === "Deposit") {
    const depositOptions = networksForAsset(asset);
    const compatibleAddresses = addresses.filter(item =>
      depositOptions.some(option => option.value === item.network) &&
      (receiveNetwork === "all" || receiveNetwork === item.network)
    );
    return <section className="content feature-content wallet-action-page">
      <div className="page-heading"><div><p className="eyebrow">WALLET / FUNDING</p><h1>Deposit to wallet</h1><p className="muted">Follow the funding steps for your selected asset and network.</p></div><button className="secondary" onClick={() => setActive("Dashboard")}>← Dashboard</button></div>
      <div className="wallet-receive-layout">
        <article className="panel wallet-form-card">
          <div className="wallet-card-heading"><span className="wallet-action-icon receive-icon">↓</span><div><h2>Prepare a deposit</h2><p>Select the exact asset and network before sending funds.</p></div></div>
          <label>Asset to deposit<select value={asset} onChange={e => { setAsset(e.target.value); setReceiveNetwork("all"); setAddressMessage(""); }}>{assets.map(item => <option key={item.symbol} value={item.symbol}>{item.symbol} · {item.name || item.symbol}</option>)}</select></label>
          <label>Deposit network<select value={receiveNetwork} onChange={e => setReceiveNetwork(e.target.value)}><option value="all">All compatible networks</option>{depositOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <div className="wallet-network-check is-warning"><span>!</span><div><b>Check the network before sending</b><small>Only send {asset} through a network shown for the destination address. Mainnet funds and testnet tokens are not interchangeable.</small></div></div>
          {addressMessage && <div role="status" className={/unable|failed|error/i.test(addressMessage) ? "feature-error" : "feature-success"}>{addressMessage}</div>}
          <h3>Step 1 · Choose a destination address</h3>
          <div className="wallet-address-list">
            {compatibleAddresses.length ? compatibleAddresses.map(item => <div className="wallet-address-card" key={item.network + ":" + item.address}>
              <div className="wallet-address-card-top"><div><span className="wallet-address-network-dot"/><b>{({ethereum:"Ethereum Mainnet",bnb:"BNB Chain",bitcoin:"Bitcoin",sepolia:"Ethereum Sepolia",solana_devnet:"Solana Devnet"})[item.network] || item.network}</b></div><span className="wallet-address-tag">{item.network === "sepolia" || item.network === "solana_devnet" ? "TESTNET" : "MAINNET"}</span></div>
              <code>{item.address}</code>
              <div className="wallet-address-card-bottom"><small>{item.label || "Connected wallet address"}</small><button className="secondary" onClick={async () => { try { await navigator.clipboard.writeText(item.address); setCopiedAddress(item.address); window.setTimeout(() => setCopiedAddress(""), 1800); } catch { setAddressMessage("Clipboard unavailable. Select the address and copy it manually."); } }}>{copiedAddress === item.address ? "✓ Copied" : "Copy deposit address"}</button></div>
            </div>) : <div className="wallet-empty-address"><span>⌁</span><b>No matching deposit address</b><p>Add or connect a public address for this network first. No address will be invented for you.</p><button className="primary" onClick={() => setActive("Wallets")}>Manage wallet addresses →</button></div>}
          </div>
          <h3>Step 2 · Send from the source wallet</h3>
          <p className="muted">Open the wallet or exchange holding your funds, choose the same asset and network, paste the copied address, and review the address and network carefully before confirming.</p>
          <h3>Step 3 · Verify the transaction</h3>
          <div className="wallet-network-check"><span>i</span><div><b>Deposit status is not yet independently tracked here</b><small>This screen does not mark a deposit as complete. Check the transaction hash on the correct network explorer and wait for confirmations.</small></div></div>
        </article>
        <aside className="wallet-review-column">
          <article className="panel wallet-review-card"><span className="feature-kicker">DEPOSIT CHECKLIST</span><div className="wallet-summary-row"><span>Asset</span><b>{asset}</b></div><div className="wallet-summary-row"><span>Addresses available</span><b>{compatibleAddresses.length}</b></div><div className="wallet-summary-divider"/><div className="wallet-summary-row"><span>Before sending</span><b>Verify network</b></div><div className="wallet-summary-row"><span>After sending</span><b>Verify on explorer</b></div></article>
          <article className="panel wallet-safety-card"><span className="wallet-safety-shield">✓</span><div><b>Never share your secret phrase</b><p>A deposit only needs the correct public receiving address. Never provide a seed phrase or private key to a sender.</p></div></article>
          <article className="panel wallet-safety-card"><span className="wallet-safety-shield">!</span><div><b>Testnet warning</b><p>Sepolia is for testing only. Do not send real mainnet funds to a Sepolia address.</p></div></article>
        </aside>
      </div>
    </section>;
  }

  if (active === "Receive") {
    const receiveOptions = networksForAsset(asset);
    const compatibleAddresses = addresses.filter(item =>
      receiveOptions.some(option => option.value === item.network) &&
      (receiveNetwork === "all" || receiveNetwork === item.network)
    );
    return <section className="content feature-content wallet-action-page">
      <div className="page-heading"><div><p className="eyebrow">WALLET / RECEIVE</p><h1>Receive assets</h1><p className="muted">Share your public receiving address with the sender. Use Deposit for funding instructions and verification steps.</p></div><button className="secondary" onClick={() => setActive("Dashboard")}>← Dashboard</button></div>
      <div className="wallet-receive-layout">
        <article className="panel wallet-form-card">
          <div className="wallet-card-heading"><span className="wallet-action-icon receive-icon">↙</span><div><h2>Receiving address</h2><p>Copy the public address to share with the person sending you funds.</p></div></div>
          <label>Asset to receive
            <select value={asset} onChange={e => { setAsset(e.target.value); setReceiveNetwork("all"); setAddressMessage(""); }}>
              {[...RECEIVE_ASSET_OPTIONS, ...assets].filter((item, index, all) =>
                item?.symbol && all.findIndex(other => other.symbol === item.symbol) === index
              ).map(item => <option key={item.symbol} value={item.symbol}>{item.symbol} · {item.name || item.symbol}</option>)}
            </select>
          </label>
          <label>Network filter
            <select value={receiveNetwork} onChange={e => setReceiveNetwork(e.target.value)}>
              <option value="all">All compatible networks</option>
              {receiveOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <div className="wallet-network-check"><span>i</span><div><b>Always match the sender's network</b><small>For example, USDT on Ethereum must be sent to your Ethereum-compatible address, not to a Bitcoin or Solana address.</small></div></div>
          {addressMessage && <div role="status" className={/unable|failed|error/i.test(addressMessage) ? "feature-error" : "feature-success"}>{addressMessage}</div>}
          <div className="wallet-address-list">
            {compatibleAddresses.length ? compatibleAddresses.map(item => <div className="wallet-address-card" key={item.network + ":" + item.address}>
              <div className="wallet-address-card-top"><div><span className="wallet-address-network-dot"/><b>{({ethereum:"Ethereum",bnb:"BNB Chain",bitcoin:"Bitcoin",sepolia:"Ethereum Sepolia",solana_devnet:"Solana Devnet"})[item.network] || item.network}</b></div><span className="wallet-address-tag">{item.network === "sepolia" || item.network === "solana_devnet" ? "TESTNET" : "MAINNET"}</span></div>
              <code>{item.address}</code>
              {item.local && <small className="muted">Shown from this browser's connected wallet. Server attachment and balance verification may still be pending.</small>}
              <div className="wallet-address-card-bottom"><small>{item.label || "Connected wallet address"}</small><button className="secondary" onClick={async () => { try { await navigator.clipboard.writeText(item.address); setCopiedAddress(item.address); window.setTimeout(() => setCopiedAddress(""), 1800); } catch { setAddressMessage("Clipboard unavailable. Select the address and copy it manually."); } }}>{copiedAddress === item.address ? "✓ Copied" : "Copy address"}</button></div>
            </div>) : <div className="wallet-empty-address"><span>⌁</span><b>No compatible address connected</b><p>{receiveOptions.length ? "Connect a public address for this asset's network in Wallets. This page will list it here after it is saved." : "This asset does not yet have a supported receiving network configured in this interface."}</p><button className="primary" onClick={() => setActive("Wallets")}>Connect an address →</button></div>}
          </div>
        </article>
        <aside className="wallet-review-column">
          <article className="panel wallet-review-card wallet-receive-sidecard"><span className="feature-kicker">RECEIVING ASSET</span><div className="wallet-receive-asset"><span>{asset === "BTC" ? "₿" : asset === "ETH" ? "Ξ" : asset === "BNB" ? "◆" : asset === "USDT" || asset === "USDC" ? "$" : asset.slice(0,1)}</span><div><b>{asset}</b><small>{assets.find(item => item.symbol === asset)?.name || asset}</small></div></div><div className="wallet-summary-divider"/><div className="wallet-summary-row"><span>Available balance</span><b>{number(selectedAssetAvailable)} {asset}</b></div><div className="wallet-summary-row"><span>USD value</span><b>{money(selectedWalletAsset?.value_usd)}</b></div><div className="wallet-summary-row"><span>Addresses shown</span><b>{compatibleAddresses.length}</b></div></article>
          <article className="panel wallet-safety-card"><span className="wallet-safety-shield">✓</span><div><b>Public address only</b><p>Receiving does not require sharing a private key. Only share the public address shown for the matching network.</p></div></article>
          <article className="panel wallet-safety-card"><span className="wallet-safety-shield">!</span><div><b>Testnet warning</b><p>Sepolia and Solana Devnet addresses are for testing. Test tokens are not mainnet funds.</p></div></article>
        </aside>
      </div>
    </section>;
  }

  if (active === "Swap") {
    const swapAssets = assets.filter(item => ["BALMZ", "ETH", "USDT", "BNB", "USDC", "BTC"].includes(item.symbol));
    const fromItem = assets.find(item => item.symbol === swapFrom);
    const toItem = assets.find(item => item.symbol === swapTo);
    const priceFor = item => {
      if (!item) return 0;
      const direct = Number(item.price_usd ?? item.current_price_usd ?? item.usd_price ?? 0);
      if (direct > 0) return direct;
      const balance = Number(item.balance ?? 0);
      const value = Number(item.value_usd ?? 0);
      return balance > 0 && value > 0 ? value / balance : 0;
    };
    const fromPrice = priceFor(fromItem);
    const toPrice = priceFor(toItem);
    const parsedSwapAmount = Number(swapAmount);
    const swapAmountValid = swapAmount !== "" && Number.isFinite(parsedSwapAmount) && parsedSwapAmount > 0;
    const swapAvailable = Math.max(0, Number(fromItem?.available_balance ?? fromItem?.available ?? fromItem?.balance ?? 0));
    const estimatedReceive = swapAmountValid && fromPrice > 0 && toPrice > 0 ? parsedSwapAmount * fromPrice / toPrice : null;
    return <section className="content feature-content wallet-action-page">
      <div className="page-heading"><div><p className="eyebrow">WALLET / CONVERT</p><h1>Swap assets</h1><p className="muted">Select the assets to convert and review an indicative value before using a supported swap provider.</p></div><button className="secondary" onClick={() => setActive("Dashboard")}>← Dashboard</button></div>
      <div className="wallet-swap-layout">
        <article className="panel wallet-form-card wallet-swap-card">
          <div className="wallet-card-heading"><span className="wallet-action-icon swap-icon">⇄</span><div><h2>Convert tokens</h2><p>Prices are indicative only; this screen does not execute a swap.</p></div></div>
          <div className="wallet-swap-token-box">
            <div className="wallet-field-topline"><label htmlFor="swap-amount">You pay</label><span>Available: {number(swapAvailable)} {swapFrom}</span></div>
            <div className="wallet-swap-input-row"><input id="swap-amount" type="number" min="0" step="any" value={swapAmount} onChange={e => { setSwapAmount(e.target.value); setSwapNotice(""); }} placeholder="0.00"/><select value={swapFrom} onChange={e => { const next = e.target.value; setSwapFrom(next); if (next === swapTo) setSwapTo(swapAssets.find(item => item.symbol !== next)?.symbol || next); setSwapNotice(""); }} aria-label="Asset to swap from">{swapAssets.map(item => <option key={item.symbol} value={item.symbol}>{item.symbol}</option>)}</select></div>
            <button type="button" className="amount-max" onClick={() => setSwapAmount(String(swapAvailable))} disabled={swapAvailable <= 0}>Use available balance</button>
          </div>
          <button type="button" className="wallet-swap-direction" aria-label="Switch swap assets" onClick={() => { setSwapFrom(swapTo); setSwapTo(swapFrom); setSwapNotice(""); }}>⇅</button>
          <div className="wallet-swap-token-box">
            <div className="wallet-field-topline"><label>Estimated receive</label><span>Indicative only</span></div>
            <div className="wallet-swap-input-row"><div className="wallet-swap-output">{estimatedReceive == null ? "—" : number(estimatedReceive)}</div><select value={swapTo} onChange={e => { setSwapTo(e.target.value); setSwapNotice(""); }} aria-label="Asset to swap to">{swapAssets.filter(item => item.symbol !== swapFrom).map(item => <option key={item.symbol} value={item.symbol}>{item.symbol}</option>)}</select></div>
            {estimatedReceive != null && <small className="wallet-swap-rate">Reference rate: 1 {swapFrom} ≈ {number(fromPrice / toPrice)} {swapTo}, before fees or slippage.</small>}
          </div>
          {swapNotice && <div role="status" className="feature-error">{swapNotice}</div>}
          <div className="wallet-network-check is-warning"><span>!</span><div><b>Live swap execution is not connected yet</b><small>No verified swap-quote or execution endpoint is available in the current app workflow. The estimate uses available market/holding values only and is not an executable offer.</small></div></div>
          <button type="button" className="primary feature-submit wallet-submit" disabled>Swap provider integration required</button>
          <p className="wallet-form-footnote">No funds are moved by this preview. Do not treat an indicative estimate as a guaranteed exchange rate.</p>
        </article>
        <aside className="wallet-review-column">
          <article className="panel wallet-review-card"><span className="feature-kicker">SWAP SUMMARY</span><div className="wallet-summary-row"><span>From</span><b>{swapFrom}</b></div><div className="wallet-summary-row"><span>To</span><b>{swapTo}</b></div><div className="wallet-summary-row"><span>Pay amount</span><b>{swapAmountValid ? number(parsedSwapAmount) + " " + swapFrom : "—"}</b></div><div className="wallet-summary-row"><span>Estimated output</span><b>{estimatedReceive == null ? "Price unavailable" : number(estimatedReceive) + " " + swapTo}</b></div><div className="wallet-summary-divider"/><div className="wallet-summary-row"><span>Available USD balance</span><b>{money(wallet.available_balance_usd)}</b></div></article>
          <article className="panel wallet-safety-card"><span className="wallet-safety-shield">✓</span><div><b>Preview only</b><p>The app does not request approval or submit a blockchain transaction from this screen.</p></div></article>
          <article className="panel wallet-safety-card"><span className="wallet-safety-shield">!</span><div><b>Fees and slippage</b><p>A real swap needs a provider quote, network fee, slippage protection and an explicit wallet confirmation.</p></div></article>
        </aside>
      </div>
    </section>;
  }

  if (active === "Transactions" && focusedTransaction) {
    const transaction = focusedTransaction;
    const explorerUrl = transactionExplorerUrl(transaction);
    const tokenUrl = tokenExplorerUrl(transaction);
    const symbol = transaction.asset || transaction.symbol || String(transaction.description || "").split(" • ")[0] || "Unknown asset";
    const network = String(transaction.network || "").toLowerCase();
    const explorerName = network === "bitcoin" || symbol === "BTC" ? "Blockstream" : network === "bnb" || symbol === "BNB" ? "BscScan" : network === "sepolia" || symbol === "BALMZ-SEP" ? "Sepolia Etherscan" : "Explorer";
    const balmzFallback = symbol === "BALMZ-SEP" || network === "sepolia" ? "https://sepolia.etherscan.io/" : network === "bnb" ? "https://bscscan.com/" : "https://etherscan.io/tokens";
    return <section className="content feature-content transaction-detail-view">
      <div className="page-heading"><div><button className="back-btn" onClick={() => setFocusedTransaction?.(null)}>← Back to transaction history</button><p className="eyebrow">TRANSACTION DETAILS</p><h1>{transaction.type || "Transfer"}</h1><p className="muted">{symbol} · {transaction.status || "Recorded"}</p></div>
        <div className="page-actions">{explorerUrl && <a className="primary explorer-button" href={explorerUrl} target="_blank" rel="noopener noreferrer">View on {explorerName} ↗</a>}</div>
      </div>
      <article className="panel transaction-detail-card">
        <div className="transaction-detail-amount"><small>AMOUNT</small><strong>{transaction.amount || "—"}</strong></div>
        <div className="transaction-detail-grid">
          <div><small>Asset</small><b>{symbol}</b></div><div><small>Status</small><b className={transaction.status === "confirmed" || transaction.status === "settled" ? "positive" : transaction.status === "failed" || transaction.status === "reorged" ? "negative" : "neutral"}>{transaction.status || "Recorded"}</b></div>
          <div><small>Network</small><b>{transaction.network || "Not supplied by transaction record"}</b></div><div><small>Time</small><b>{transaction.time || "—"}</b></div>
          <div><small>Confirmations</small><b>{transaction.confirmations == null ? "—" : Number(transaction.confirmations).toLocaleString()}</b></div><div><small>Block height</small><b>{transaction.block_height == null ? "—" : Number(transaction.block_height).toLocaleString()}</b></div>
          <div className="transaction-detail-wide"><small>Transaction hash</small>{transaction.tx_hash ? <code>{transaction.tx_hash}</code> : <span>Not available — this record may not have been broadcast to a blockchain.</span>}</div>
          <div className="transaction-detail-wide"><small>From address</small>{transaction.from_address || transaction.from ? <code>{transaction.from_address || transaction.from}</code> : <span>Not supplied</span>}</div>
          <div className="transaction-detail-wide"><small>To address</small>{transaction.to_address || transaction.to ? <code>{transaction.to_address || transaction.to}</code> : <span>Not supplied</span>}</div>
          {transaction.description && <div className="transaction-detail-wide"><small>Description</small><span>{transaction.description}</span></div>}
        </div>
        {explorerUrl ? <div className="security-note">Explorer lookup is read-only and opens this transaction on its recorded network. A missing transaction hash cannot be searched as a confirmed transfer.</div> : <div className="security-note">No compatible explorer link is available because the transaction hash or network is missing. Check the original record before assuming a blockchain transfer occurred.</div>}
        {String(symbol).toUpperCase().startsWith("BALMZ") && <div className="token-explorer-row"><div><b>BALMZ token explorer</b><small>{transaction.token_contract_address || transaction.contract_address ? "Open the recorded token contract on its network explorer." : "No token contract address was included in this record; open the network explorer to search for the verified BALMZ token."}</small></div><a href={tokenUrl || balmzFallback} target="_blank" rel="noopener noreferrer">Open token explorer ↗</a></div>}
      </article>
    </section>;
  }

  if (active === "Transactions") {
    async function settleTransaction(transaction) {
      const txHash = window.prompt("Enter the real blockchain transaction hash for this request:");
      if (!txHash) return;
      setSyncBusy(true);
      setSyncMessage("");
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/transactions/settle", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
          body: JSON.stringify({ transaction_id: transaction.id, tx_hash: txHash.trim() }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Settlement verification failed.");
        const refreshed = await fetch(apiBaseUrl + "/api/v1/wallet/refresh", {
          method: "POST",
          headers: { Authorization: "Bearer " + accessToken },
        });
        const refreshedData = await refreshed.json();
        if (refreshed.ok) {
          onTransactionsUpdated?.(refreshedData.transactions || []);
          onWalletUpdated?.({ wallet: refreshedData.wallet, assets: refreshedData.assets || [] });
        }
        setSyncMessage(data.status === "broadcast_pending"
          ? "Broadcast recorded. Waiting for blockchain confirmation."
          : "Blockchain settlement verified and wallet accounting reconciled.");
      } catch (error) {
        setSyncMessage(error.message || "Settlement verification failed.");
      } finally {
        setSyncBusy(false);
      }
    }

    async function syncTransactions() {
      setSyncBusy(true);
      setSyncMessage("");
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/transactions/sync", {
          method: "POST",
          headers: { Authorization: "Bearer " + accessToken },
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "live transaction sync failed.");
        onTransactionsUpdated?.(data.transactions || []);
        onWalletUpdated?.({ wallet: data.wallet, assets: data.assets || [] });
        const warnings = Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : [];
        const importedCount = Array.isArray(data.imported) ? data.imported.length : 0;
        const syncTime = data.last_transaction_sync_at
          ? new Date(data.last_transaction_sync_at).toLocaleString()
          : "";
        const syncSummary = importedCount
          ? `Imported ${importedCount} live blockchain transaction(s).`
          : "Sync completed; no new live wallet transactions were returned.";
        setSyncMessage([
          warnings.length ? "PARTIAL SYNC — " + warnings.join(" • ") : syncSummary,
          syncTime ? "Transaction sync time: " + syncTime : "A successful transaction-sync timestamp was not supplied; do not treat this as proof that every network synced."
        ].join(" "));
      } catch (error) {
        setSyncMessage(error.message || "live transaction sync failed.");
      } finally {
        setSyncBusy(false);
      }
    }

    return <section className="content feature-content">
      <div className="page-heading">
        <div><p className="eyebrow">WALLET HISTORY</p><h1>Transactions</h1><p className="muted">Track wallet activity with blockchain transaction details when available.</p></div>
        <div className="page-actions"><button className="secondary" onClick={syncTransactions} disabled={syncBusy}>{syncBusy ? "Syncing live wallet…" : "↻ Sync live wallet"}</button><button className="primary" onClick={()=>setActive("Send")}>+ Send funds</button></div>
      </div>
      {syncMessage && <div role="status" className={/failed|unavailable|warning|not configured|no live transaction source|rate limit|latest block unavailable/i.test(syncMessage) ? "feature-error" : "feature-success"}>{syncMessage}</div>}
      {historyError && <div role="status" className="feature-error">{historyError} <button className="secondary" onClick={() => loadTransactionHistory({ offset: 0, append: false })} disabled={historyBusy}>Retry</button></div>}
      <article className="panel transaction-panel">
        <div className="transaction-filter-bar"><span>Recorded wallet activity</span><small>{historyTransactions.length} of {historyPagination.total} transaction{historyPagination.total===1?"":"s"}</small></div>
        {historyBusy && historyTransactions.length === 0 ? <div className="live-chart-empty">Loading saved transaction history…</div> : historyTransactions.length ? historyTransactions.map((a,i) => <div role="button" tabIndex={0} className="transaction-row transaction-chain-row transaction-row-clickable" key={a.tx_hash || a.id || i} onClick={() => setFocusedTransaction?.(a)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setFocusedTransaction?.(a); } }} aria-label={"View transaction details for " + (a.type || "transaction")}>
          <span className="activity-icon">{a.type[0].toUpperCase()}</span>
          <div className="transaction-main"><b>{a.type}</b><small>{a.description}</small>{a.tx_hash && <code title={a.tx_hash}>{a.tx_hash}</code>}</div>
          <strong className={Number(a.raw_amount) >= 0 ? "positive" : "negative"}>{a.amount}</strong>
          <div className="transaction-meta">
            <span className={a.status === "confirmed" ? "positive" : a.status === "failed" || a.status === "reorged" ? "negative" : "neutral"}>{a.status || "recorded"}{a.confirmations ? ` • ${a.confirmations} confirmations` : ""}</span>
            {a.block_height ? <small>Block {a.block_height}</small> : null}
            {transactionExplorerUrl(a) ? <a href={transactionExplorerUrl(a)} target="_blank" rel="noopener noreferrer" onClick={event => event.stopPropagation()}>View on explorer ↗</a> : null}
            {a.status === "reorged" ? <small className="negative">Chain reorganization detected — waiting for a replacement confirmation.</small> : null}
            {a.status === "failed" ? <small className="negative">On-chain execution failed. This record is not a confirmed transfer.</small> : null}
            {["pending","pending_review","broadcast_pending"].includes(a.status) && a.id ? <button className="secondary" onClick={event => { event.stopPropagation(); settleTransaction(a); }} disabled={syncBusy}>{a.status === "broadcast_pending" ? "Verify confirmation" : "Verify settlement"}</button> : null}
            <small>{a.time}</small>
          </div>
        </div>) : <div className="live-chart-empty">{historyError ? "Transaction history could not be loaded." : "No real wallet transactions recorded yet."}</div>}
        {historyPagination.has_more && <div className="transaction-filter-bar"><span>More saved transactions are available.</span><button className="secondary" disabled={historyBusy} onClick={() => loadTransactionHistory({ offset: historyPagination.next_offset ?? historyTransactions.length, append: true })}>{historyBusy ? "Loading…" : "Load more transactions"}</button></div>}
      </article>
    </section>;
  }

  if (active === "Portfolio") return <section className="content feature-content portfolio-page">
    <div className="page-heading"><div><p className="eyebrow">ASSET MANAGEMENT / LIVE MARKET</p><h1>Portfolio</h1><p className="muted">Open any coin to view its individual trading card, quote, wallet balance and supported actions.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div>
    <div className="balance-grid feature-balance"><article className="hero-card"><div className="card-top"><span>AVAILABLE BALANCE</span></div><div className="hero-balance">{money(wallet.available_balance_usd)} <small>USD</small></div></article><article className="stat-card"><span>Portfolio performance</span><strong>Not calculated</strong><small className="neutral">Profit and 24h portfolio change are unavailable until reliable cost-basis and valuation history are connected.</small></article></div>
    <article className="panel market-prices-panel portfolio-market-panel"><div className="panel-head"><div><h2>Live market prices</h2><span>Live quotes for supported coins · refreshed automatically</span></div><button type="button" className="text-btn" onClick={refreshMarketPrices} disabled={marketPricesLoading}>{marketPricesLoading ? "Refreshing…" : "↻ Refresh prices"}</button></div>
      {marketPricesError && <div className="market-price-error" role="status">{marketPricesError}</div>}
      <div className="market-price-grid">{(walletCoinCatalog || []).map(c=>{const q=marketPrices?.[c.symbol]||{};const hasPrice=q.usd!=null&&Number.isFinite(Number(q.usd));const delta=q.usd_24h_change;return <button type="button" className="market-price-item portfolio-market-coin" key={c.symbol} onClick={()=>setSelectedCoin?.(c.symbol)}><span className={"asset-icon coin-icon coin-"+c.symbol.toLowerCase()}>{c.icon||"•"}</span><span className="market-price-name"><b>{c.symbol}</b><small>{c.name}</small></span><span className="market-price-value"><b>{hasPrice?money(Number(q.usd)):((c.symbol==="BALMZ"||c.symbol==="BALMZ-SEP")?"Not listed":"Unavailable")}</b><small className={delta==null?"neutral":Number(delta)>=0?"positive":"negative"}>{delta==null?((c.symbol==="BALMZ"||c.symbol==="BALMZ-SEP")?"No verified quote":"24h change unavailable"):(Number(delta)>=0?"+":"")+Number(delta).toFixed(2)+"% · 24h"}</small></span></button>})}</div>
      <p className="coin-catalog-note">{marketPricesUpdatedAt ? "Last updated " + new Date(marketPricesUpdatedAt).toLocaleTimeString() : "Waiting for the first successful market response."} · BALMZ remains unpriced until a verifiable market quote exists.</p>
    </article>
    <article className="panel assets-panel portfolio-assets-panel"><div className="panel-head"><div><h2>Coin trading cards</h2><span>{(walletCoinCatalog||[]).length} supported catalog entries · select a card to open its trading details</span></div></div>
      <div className="portfolio-coin-grid">{(walletCoinCatalog||[]).map(c=>{const held=assets.find(a=>a.symbol===c.symbol);const q=marketPrices?.[c.symbol]||{};const hasPrice=q.usd!=null&&Number.isFinite(Number(q.usd));const delta=q.usd_24h_change;return <button type="button" className="portfolio-coin-card" key={c.symbol} onClick={()=>setSelectedCoin?.(c.symbol)}><div className="portfolio-coin-top"><span className={"asset-icon coin-icon coin-"+c.symbol.toLowerCase()}>{c.icon||"•"}</span><span className="portfolio-coin-network">{c.status||"Supported asset"}</span></div><div className="portfolio-coin-title"><b>{c.name}</b><span>{c.symbol}</span></div><div className="portfolio-coin-price">{hasPrice?money(Number(q.usd)):c.symbol==="BALMZ"?"Not listed":"Price unavailable"}<small>{hasPrice?"USD spot price":"Verified quote not available"}</small></div><div className="portfolio-coin-meta"><span>Balance</span><b>{number(held?.balance||0)} {c.symbol}</b></div><div className="portfolio-coin-meta"><span>24h</span><b className={delta==null?"neutral":Number(delta)>=0?"positive":"negative"}>{delta==null?"—":(Number(delta)>=0?"+":"")+Number(delta).toFixed(2)+"%"}</b></div><span className="portfolio-open-card">Open trading card →</span></button>})}</div>
    </article>
  </section>;
  if (active === "Staking" || active === "NFTs") return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">ASSET MANAGEMENT</p><h1>{active}</h1><p className="muted">Manage your digital assets.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div><div className="balance-grid feature-balance"><article className="hero-card"><div className="card-top"><span>AVAILABLE BALANCE</span></div><div className="hero-balance">{money(wallet.available_balance_usd)} <small>USD</small></div></article><article className="stat-card"><span>Portfolio performance</span><strong>Not calculated</strong><small className="neutral">Profit and 24h portfolio change are unavailable until reliable cost-basis and valuation history are connected.</small></article></div><article className="panel assets-panel"><div className="panel-head"><div><h2>{active} assets</h2><span>Current wallet holdings</span></div></div><div className="asset-list">{assets.map(a=><div className="asset-row" key={a.symbol}><span className="asset-icon">{a.icon}</span><div className="asset-name"><b>{a.symbol}</b><small>{a.name}</small></div><div className="asset-balance"><b>{number(a.balance)}</b><small>{money(a.value_usd)}</small></div><small className="neutral">24h change unavailable</small></div>)}</div></article></section>;

  if (active === "Verify Contract") {
    const verify=async()=>{setToolBusy(true);setMessage("");try{const r=await fetch(apiBaseUrl+"/api/v1/contracts/verify",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+accessToken},body:JSON.stringify({address:destination.trim(),network})});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Contract check failed.");setMessage(d.contract?"Contract bytecode detected on "+d.network+". Source code verification: not checked.":"No contract bytecode detected on "+d.network+". "+(d.note||""));}catch(e){setMessage(e.message||"Contract check failed.");}finally{setToolBusy(false);}};
    return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">TOOLS</p><h1>Verify Contract</h1><p className="muted">Check deployed bytecode on Ethereum, BNB Chain, or Ethereum Sepolia testnet.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div><article className="panel action-panel"><label>Network<select value={network} onChange={e=>setNetwork(e.target.value)}><option value="ethereum">Ethereum Mainnet</option><option value="bnb">BNB Chain</option><option value="sepolia">Ethereum Sepolia (testnet)</option></select></label><label>Contract address<input value={destination} onChange={e=>setDestination(e.target.value)} placeholder="0x…"/></label>{message&&<div className={message.toLowerCase().includes("detected")&&!message.toLowerCase().includes("no contract")?"feature-success":"feature-error"} role="status">{message}</div>}<button className="primary feature-submit" disabled={toolBusy||!/^0x[0-9a-fA-F]{40}$/.test(destination.trim())} onClick={verify}>{toolBusy?"Checking…":"Check deployed bytecode →"}</button><div className="security-note">This checks whether bytecode exists at the address only. It does not verify source code, audit the contract, prove ownership, or certify safety. Sepolia is a test network.</div></article></section>;
  }

  if (active === "Address Book") {
    const loadBook=async()=>{setToolBusy(true);try{const r=await fetch(apiBaseUrl+"/api/v1/address-book",{headers:{Authorization:"Bearer "+accessToken}});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Unable to load address book.");setToolItems(d.entries||[]);}catch(e){setMessage(e.message);}finally{setToolBusy(false);}};
    const addBook=async()=>{setToolBusy(true);setMessage("");try{const r=await fetch(apiBaseUrl+"/api/v1/address-book",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+accessToken},body:JSON.stringify({label:note,address:destination,network,notes:""})});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Unable to save address.");setDestination("");setNote("");setMessage("Address saved.");await loadBook();}catch(e){setMessage(e.message);}finally{setToolBusy(false);}};
    const removeBook=async id=>{const entry=toolItems.find(item=>item.id===id);if(!window.confirm("Remove "+(entry?.label||"this saved address")+" from this wallet’s address book? This cannot be undone."))return;setToolBusy(true);try{const r=await fetch(apiBaseUrl+"/api/v1/address-book/delete",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+accessToken},body:JSON.stringify({id})});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Unable to remove address.");setMessage("Address removed.");await loadBook();}catch(e){setMessage(e.message);}finally{setToolBusy(false);}};
    return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">TOOLS</p><h1>Address Book</h1><p className="muted">Save trusted destination addresses for this wallet.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div>
      <div className="feature-grid"><article className="panel action-panel"><h2>Add address</h2><label>Network<select value={network} onChange={e=>setNetwork(e.target.value)}><option value="ethereum">Ethereum</option><option value="bnb">BNB Chain</option><option value="bitcoin">Bitcoin</option></select></label><label>Address<input value={destination} onChange={e=>setDestination(e.target.value)} placeholder="Wallet address"/></label><label>Label<input value={note} onChange={e=>setNote(e.target.value)} placeholder="My exchange"/></label>{message&&<div className="feature-success">{message}</div>}<button className="primary feature-submit" disabled={toolBusy||!destination.trim()||!note.trim()} onClick={addBook}>{toolBusy?"Saving…":"Save address →"}</button></article>
      <article className="panel tool-panel"><div className="panel-head"><div><h2>Saved addresses</h2><span>Private to this wallet</span></div><button className="secondary" onClick={loadBook}>↻ Refresh</button></div>{toolItems.length?toolItems.map(a=><div className="tool-row" key={a.id}><div><b>{a.label}</b><small>{a.network}</small></div><code>{a.address}</code><button className="secondary" onClick={()=>removeBook(a.id)}>Remove</button></div>):<div className="live-chart-empty">No saved addresses loaded.</div>}</article></div></section>;
  }

  if (active === "Request Center") {
    const loadRequests=async()=>{setToolBusy(true);try{const r=await fetch(apiBaseUrl+"/api/v1/request-center",{headers:{Authorization:"Bearer "+accessToken}});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Unable to load requests.");setToolItems(d.requests||[]);}catch(e){setMessage(e.message);}finally{setToolBusy(false);}};
    const createRequest=async()=>{setToolBusy(true);setMessage("");try{const r=await fetch(apiBaseUrl+"/api/v1/request-center",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+accessToken},body:JSON.stringify({kind:"support",title:destination,details:note})});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Unable to create request.");setDestination("");setNote("");setMessage("Request created.");await loadRequests();}catch(e){setMessage(e.message);}finally{setToolBusy(false);}};
    return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">TOOLS</p><h1>Request Center</h1><p className="muted">Create and track database-backed support requests.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div>
      <div className="feature-grid"><article className="panel action-panel"><h2>New request</h2><label>Title<input value={destination} onChange={e=>setDestination(e.target.value)} maxLength="120" placeholder="Request title"/></label><label>Details<textarea value={note} onChange={e=>setNote(e.target.value)} maxLength="1000" placeholder="Describe what you need"/></label>{message&&<div className="feature-success">{message}</div>}<button className="primary feature-submit" disabled={toolBusy||!destination.trim()} onClick={createRequest}>{toolBusy?"Saving…":"Create request →"}</button></article>
      <article className="panel tool-panel"><div className="panel-head"><div><h2>My requests</h2><span>Real records for this wallet</span></div><button className="secondary" onClick={loadRequests}>{toolBusy?"Loading…":"↻ Refresh"}</button></div>{toolItems.length?toolItems.map(r=><div className="tool-row" key={r.id}><div><b>{r.title}</b><small>{r.kind} • {r.status}</small></div><code>{r.id}</code></div>):<div className="live-chart-empty">No requests loaded. Tap Refresh.</div>}</article></div></section>;
  }

  if (active === "Wallet Connect") {
    const chainNames = { 1: "Ethereum Mainnet", 11155111: "Sepolia Testnet", 56: "BNB Smart Chain" };
    return <section className="content feature-content">
      <div className="security-note">Google sign-in connects your Google account to World Wallet AI, but Google Wallet is not itself a standard EVM Web3 wallet provider for signing Ethereum or BNB Chain transactions. For blockchain signing, use a WalletConnect-compatible crypto wallet. Never enter Google account credentials or wallet recovery phrases here.</div>
      <div className="page-heading"><div><p className="eyebrow">EXTERNAL WALLET</p><h1>Wallet Connect</h1><p className="muted">Connect MetaMask, Rainbow, Trust Wallet, and other WalletConnect-compatible wallets. Signing requests always require approval in your wallet.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div>
      <article className="panel tool-panel">
        <div className="tool-status"><span className="status-dot"></span><b>{wcAccount ? "External wallet connected" : "Choose an external wallet"}</b></div>
        <p className="muted">Connect an existing wallet. World Wallet AI receives the public address and asks the wallet itself to approve signatures and transactions; it never receives the private key.</p>
        {wcAccount ? <>
          <div className="tool-row"><div><b>Wallet address</b><small>{wcProviderKind === "walletconnect" ? "Connected through WalletConnect" : wcProviderKind === "coinbase" ? "Connected through Coinbase Wallet" : "Connected through MetaMask"}</small></div><code>{wcAccount}</code><button className="secondary" onClick={()=>navigator.clipboard?.writeText(wcAccount)}>Copy address</button></div>
          <a className="secondary" href={wcChainId === 11155111 ? "https://sepolia.etherscan.io/address/" + wcAccount : wcChainId === 56 ? "https://bscscan.com/address/" + wcAccount : wcChainId === 1 ? "https://etherscan.io/address/" + wcAccount : "https://etherscan.io/"} target="_blank" rel="noreferrer">View wallet address in Explorer ↗</a>
          <div className="tool-row"><div><b>Network</b><small>Detected from connected wallet</small></div><strong>{chainNames[wcChainId] || (wcChainId ? "Chain ID " + wcChainId : "Unknown network")}</strong></div>
          <div className="security-note">Use Explorer to inspect the public address. This connection screen does not display or request a private key or contract address.</div>
          <div className="wallet-connection-actions">
            <button className="primary" disabled={wcBusy} onClick={changeWalletConnect}>{wcBusy ? "Opening wallet picker…" : "⇄ Change wallet (WalletConnect)"}</button>
            <button className="secondary" disabled={wcBusy} onClick={disconnectWalletConnect}>Disconnect from World Wallet AI</button>
          </div>
        </> : <div className="wallet-connection-actions">
          <button className="primary feature-submit" disabled={wcBusy} onClick={()=>connectInjectedWallet("metamask")}>{wcBusy ? "Connecting…" : "Connect MetaMask"}</button>
          <button className="primary feature-submit" disabled={wcBusy} onClick={()=>connectInjectedWallet("coinbase")}>{wcBusy ? "Connecting…" : "Connect Coinbase Wallet"}</button>
          <button className="secondary" disabled={wcBusy} onClick={connectWalletConnect}>{wcBusy ? "Opening wallet picker…" : "Connect with WalletConnect"}</button>
        </div>}
        {wcError && <div className="feature-error" role="alert">{wcError}</div>}
        <div className="security-note">MetaMask and Coinbase direct connections require their provider or in-app browser to be available. WalletConnect offers a QR/mobile linking path for compatible wallets. If a provider is not installed or supported, the screen reports that instead of pretending the wallet connected.</div>
        <div className="security-note">Google sign-in is separate from crypto-wallet connection. Never enter a Google password, wallet private key, or recovery phrase into this site.</div>
      </article>
      <article className="panel tool-panel">
        <h2>Configured production addresses</h2>
        <p className="muted">These are backend-configured addresses, separate from the external wallet session above.</p>
        <button className="secondary" onClick={async()=>{setSyncBusy(true);try{const r=await fetch(apiBaseUrl+"/api/v1/wallet/connect",{headers:{Authorization:"Bearer "+accessToken}});const d=await r.json();setAddresses(d.addresses||[]);setAddressMessage(d.message||"");}catch{setAddressMessage("Unable to load connection status.");}finally{setSyncBusy(false)}}}>{syncBusy?"Checking…":"Check production addresses"}</button>
        {addresses.length?addresses.map(a=><div className="tool-row" key={a.network+a.address}><div><b>{a.network.toUpperCase()}</b><small>{a.label}</small></div><code>{a.address}</code><button className="secondary" onClick={()=>navigator.clipboard?.writeText(a.address)}>Copy</button></div>):<div className="live-chart-empty">{addressMessage||"No configured production address loaded."}</div>}
      </article>
    </section>;
  }

  if (active === "Help & Docs") {
    const docs = [
      ["Getting started","Create a wallet profile or attach a public address from Wallets. A profile is not the same as a generated on-chain wallet.","Wallets"],
      ["Balances and prices","Balances require a verified source. Market quotes can be stale while the price provider is rate-limiting requests.","Portfolio"],
      ["Receive and deposit","Verify the destination address and network before sending. A displayed address is not proof that funds arrived.","Receive"],
      ["Transactions","Use the transaction hash and matching blockchain explorer to verify on-chain activity.","Transactions"],
      ["Security","Never share a seed phrase, private key, password, one-time code, or API secret. Store API secrets in backend environment variables.","API Keys"]
    ];
    return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">WORLD WALLET AI / DOCUMENTATION</p><h1>Help &amp; Docs</h1><p className="muted">Guidance for using the wallet safely and checking live data.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div><div className="feature-grid">{docs.map(([title,body,target],i)=><article className="panel action-panel" key={title}><p className="feature-kicker">GUIDE {String(i+1).padStart(2,"0")}</p><h2>{title}</h2><p>{body}</p><button className="secondary" onClick={()=>setActive(target)}>Open {target} →</button></article>)}</div></section>;
  }
  if (active === "Support Center") {
    return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">WORLD WALLET AI / SUPPORT</p><h1>Support Center</h1><p className="muted">Choose a connected page to investigate an issue.</p></div><button className="secondary" onClick={()=>setActive("Help & Docs")}>Help &amp; Docs →</button></div><article className="panel action-panel"><h2>Troubleshooting</h2><p>These shortcuts open the relevant app pages. This screen does not submit a support ticket or claim that a service is healthy.</p>{[["Sign-in and account","Profile"],["Wallets and addresses","Wallets"],["Market prices and API keys","API Keys"],["Transaction history","Transactions"]].map(([label,target])=><div className="tool-row" key={target}><div><b>{label}</b></div><button className="secondary" onClick={()=>setActive(target)}>{target} →</button></div>)}<div className="security-note">Never provide support with a private key or seed phrase. A ticket submission channel is not configured on this page.</div></article></section>;
  }
  const moduleGuidance = {
    "Admin Editor":"Editing tools are not connected to a verified backend workflow yet.",
    "User Management":"Account changes require administrator-authorized server endpoints.",
    "System Settings":"System settings are not editable until an authorized, audited backend API is available.",
    "Logs & Activity":"A verified administrative audit-log endpoint is not connected yet. User transaction history is under Transactions.",
    "Role Management":"Role changes require server-side authorization and audit logging.",
    "Staking":"Staking is not enabled until supported contracts and transaction verification are configured.",
    "NFTs":"NFTs are not loaded from a verified wallet indexer. No sample NFTs are displayed."
  };
  const guidance = moduleGuidance[active];
  return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">WORLD WALLET AI</p><h1>{active}</h1><p className="muted">{guidance ? "Module readiness" : "Feature workspace"}</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div><article className="panel placeholder-panel"><div className="feature-icon">✦</div><h2>{active}</h2><p>{guidance || "This module does not yet have a dedicated verified workflow. Use the connected pages below rather than treating this page as an active service."}</p><div className="page-actions"><button className="secondary" onClick={()=>setActive("Wallets")}>Wallets</button><button className="secondary" onClick={()=>setActive("Transactions")}>Transactions</button><button className="secondary" onClick={()=>setActive("Help & Docs")}>Help &amp; Docs</button></div></article></section>;
}
