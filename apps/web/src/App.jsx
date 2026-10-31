import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
const FeaturePage = lazy(() => import("./FeaturePage.jsx"));
import { authClient, getNeonAccessToken } from "./auth-client.js";
import { isUsableNeonAccessToken } from "./neon-token.js";
import { cachedBalanceMatchesNetwork, defaultNetworkForEnvironment, networkEnvironment, normalizeNetworkId, readSelectedNetwork } from "./network-selection.js";
import BrowserPage from "./BrowserPage.jsx";
import DashboardWalletPanel from "./DashboardWalletPanel.jsx";
import BalmzAI from "./BalmzAI.jsx";

function WorldGlobeLogo({ compact = false }) {
  return <svg className={compact ? "ww-world-logo ww-world-logo-compact" : "ww-world-logo"} viewBox="0 0 64 64" role="img" aria-label="World Wallet AI globe logo">
    <defs><linearGradient id="wwGlobeBlue" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffb36b"/><stop offset="1" stopColor="#ff7a18"/></linearGradient><linearGradient id="wwGlobeGold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff1e5"/><stop offset="1" stopColor="#ff7a18"/></linearGradient></defs>
    <circle cx="32" cy="30" r="25" fill="#041a32" stroke="url(#wwGlobeBlue)" strokeWidth="3"/>
    <ellipse cx="32" cy="30" rx="11" ry="25" fill="none" stroke="#ff9b50" strokeWidth="1.8"/>
    <ellipse cx="32" cy="30" rx="24" ry="9" fill="none" stroke="#ff9b50" strokeWidth="1.8"/>
    <path d="M8 30H56M32 5V55M14 13Q32 22 50 13M14 47Q32 38 50 47" fill="none" stroke="#df6412" strokeWidth="1.5"/>
    <path d="M12 43A25 25 0 0 0 29 54L20 61L8 53Z" fill="url(#wwGlobeGold)"/><path d="M9 44L21 49L16 56L5 51Z" fill="#ff7a18"/>
    <path d="M20 6A25 25 0 0 1 51 15" fill="none" stroke="#fff1e5" strokeWidth="2.5" strokeLinecap="round"/>
  </svg>;
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "https://world-wallet-ai-backend.onrender.com").replace(/\/$/, "");
const TOKEN_KEY = "world_wallet_access_token";

const fallbackAssets = [];
const fallbackWallet = { available_balance_usd: null, actual_balance_usd: null, reserved_balance_usd: null, total_received_usd: null, total_sent_usd: null, profit_usd: null, change_24h: null, valuation_complete: false };
const fallbackActivity = [];
const walletCoinCatalog = [
  { symbol: "BALMZ", name: "BALMZ Token", icon: "B", status: "Wallet token" },
  { symbol: "BALMZ-SEP", name: "BALMZ Token (Sepolia)", icon: "B", status: "Sepolia testnet only" },
  { symbol: "BALMZ-SOL-DEVNET", name: "BALMZ Token (Solana Devnet)", icon: "B", status: "Solana Devnet • testnet only" },
  { symbol: "BTC", name: "Bitcoin", icon: "₿", status: "Bitcoin" },
  { symbol: "ETH", name: "Ethereum", icon: "Ξ", status: "Ethereum" },
  { symbol: "USDT", name: "Tether USD", icon: "$", status: "Ethereum / BNB Chain" },
  { symbol: "BNB", name: "BNB", icon: "◆", status: "BNB Chain" },
  { symbol: "USDC", name: "USD Coin", icon: "$", status: "Supported asset catalog" },
  { symbol: "SOL", name: "Solana", icon: "S", status: "Supported asset catalog" },
  { symbol: "XRP", name: "XRP", icon: "X", status: "Supported asset catalog" },
  { symbol: "ADA", name: "Cardano", icon: "A", status: "Supported asset catalog" },
  { symbol: "LTC", name: "Litecoin", icon: "Ł", status: "Supported asset catalog" },
  { symbol: "DOGE", name: "Dogecoin", icon: "Ð", status: "Supported asset catalog" },
];




const ASSET_LOGO_URLS = {
  BTC: "https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/btc.png",
  ETH: "https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/eth.png",
  BNB: "https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/bnb.png",
  USDT: "https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/usdt.png",
  USDC: "https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/usdc.png",
  SOL: "https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/sol.png",
  XRP: "https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/xrp.png",
  ADA: "https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/ada.png",
  LTC: "https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/ltc.png",
  DOGE: "https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/doge.png",
  // Network-qualified symbols use the same underlying token logo.
  "USDT-BNB": "https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/usdt.png",
};
const BALMZ_LOGO_URL = "https://raw.githubusercontent.com/PWFB/world-wallet-ai/assets/balmz-solana-devnet-logo/tools/balmz-solana-devnet/balmz-logo.png";

function AssetIcon({ symbol, fallback = "•" }) {
  const normalizedSymbol = String(symbol || "").trim().toUpperCase();
  const logoUrl = normalizedSymbol.startsWith("BALMZ")
    ? BALMZ_LOGO_URL
    : ASSET_LOGO_URLS[normalizedSymbol];
  return <span className={"asset-icon coin-icon coin-" + String(symbol || "").toLowerCase()}>
    {logoUrl ? <><img src={logoUrl} alt="" width="28" height="28" loading="lazy" style={{ objectFit: "contain", borderRadius: "50%" }} onError={event => { event.currentTarget.style.display = "none"; if (event.currentTarget.nextElementSibling) event.currentTarget.nextElementSibling.style.display = "grid"; }} /><span aria-hidden="true" style={{ display: "none" }}>{fallback}</span></> : fallback}
  </span>;
}

const money = value => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? "Unavailable" : `${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const number = value => Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });

function authErrorMessage(error, fallback) {
  if (!error) return fallback;
  const message = error.message || error.error_description || error.code || fallback;
  const code = error.code && error.code !== message ? ` [${error.code}]` : "";
  return `${message}${code}`;
}


function GitHubIntegration({ accessToken, apiBaseUrl }) {
  const [status, setStatus] = useState(null);
  const [repositories, setRepositories] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const authHeaders = { Authorization: "Bearer " + accessToken };
  const loadStatus = async () => {
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/integrations/github/status", { headers: authHeaders });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Unable to load GitHub connection status.");
      setStatus(data);
    } catch (err) { setError(err.message || "Unable to load GitHub connection status."); }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const callbackStatus = params.get("github_oauth");
    if (callbackStatus) {
      const messages = {
        connected: "GitHub connected successfully.",
        denied: "GitHub authorization was cancelled.",
        invalid: "The GitHub authorization state was invalid or expired. Please try again.",
        not_configured: "GitHub OAuth is not configured on the backend.",
        exchange_failed: "GitHub authorization could not be completed. Check the OAuth app settings and try again.",
        profile_failed: "GitHub did not return a valid account profile.",
        not_authorized: "The initiating account is no longer authorized as administrator."
      };
      setNotice(messages[callbackStatus] || "GitHub authorization returned an unknown status.");
      window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
    }
    loadStatus();
  }, [accessToken, apiBaseUrl]);

  const connect = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/integrations/github/oauth/start", { method: "POST", headers: authHeaders });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Unable to start GitHub authorization.");
      if (!data.authorize_url || !data.authorize_url.startsWith("https://github.com/login/oauth/authorize?")) throw new Error("The backend returned an invalid GitHub authorization URL.");
      window.location.assign(data.authorize_url);
    } catch (err) { setError(err.message || "Unable to connect GitHub."); setBusy(false); }
  };

  const loadRepositories = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/integrations/github/repositories", { headers: authHeaders });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Unable to load repository metadata.");
      setRepositories(data.repositories || []);
      setNotice("Loaded " + (data.count || 0) + " repositories from GitHub.");
    } catch (err) { setError(err.message || "Unable to load repository metadata."); }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect GitHub from World Wallet AI? Saved repository access will be removed.")) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/integrations/github", { method: "DELETE", headers: authHeaders });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Unable to disconnect GitHub.");
      setStatus(current => ({ ...(current || {}), connected: false, login: null, scopes: [] }));
      setRepositories([]);
      setNotice("GitHub disconnected. The stored credential has been removed.");
    } catch (err) { setError(err.message || "Unable to disconnect GitHub."); }
    finally { setBusy(false); }
  };

  const card = { background: "var(--panel, #111a2d)", border: "1px solid var(--border, #26334d)", borderRadius: 16, padding: 20 };
  const muted = { color: "var(--muted, #9aa8c2)", fontSize: 13 };
  return <section className="content">
    <div className="page-heading"><div><p className="eyebrow">ADMIN CONSOLE / INTEGRATIONS</p><h1>GitHub Integration</h1><p className="muted">Connect your GitHub account and inspect repository metadata securely.</p></div></div>
    <div style={{ ...card, marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div><p className="eyebrow">ACCOUNT CONNECTION</p><h2 style={{ margin: "8px 0" }}>{status?.connected ? "GitHub is connected" : "Connect GitHub"}</h2><p style={muted}>{status?.connected ? "Authorized account: " + (status.login || "GitHub user") : "OAuth credentials and encryption must be configured on the backend before connecting."}</p></div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {status?.connected ? <><button type="button" className="primary" disabled={busy} onClick={loadRepositories}>{busy ? "Loading…" : "Load repositories"}</button><button type="button" className="secondary" disabled={busy} onClick={disconnect}>Disconnect</button></> : <button type="button" className="primary" disabled={busy || status?.configured === false} onClick={connect}>{busy ? "Please wait…" : "Connect GitHub account ↗"}</button>}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginTop: 18 }}>
        <div><span style={muted}>Connection</span><div style={{ fontWeight: 700, marginTop: 5 }}>{status?.connected ? "Connected" : status?.configured === false ? "Needs configuration" : "Not connected"}</div></div>
        <div><span style={muted}>Granted scopes</span><div style={{ fontWeight: 700, marginTop: 5 }}>{status?.scopes?.length ? status.scopes.join(", ") : "Not authorized"}</div></div>
        <div><span style={muted}>Connected since</span><div style={{ fontWeight: 700, marginTop: 5 }}>{status?.connected_at ? new Date(status.connected_at).toLocaleString() : "—"}</div></div>
      </div>
      <p style={{ ...muted, marginTop: 16 }}>Default access requests public repository metadata only (read:user, public_repo). The OAuth token is encrypted at rest on the backend and is never sent to this page. Private repository access is not requested by default.</p>
      {error && <div role="alert" style={{ marginTop: 14, color: "#ff8585" }}>{error}</div>}
      {notice && <div role="status" style={{ marginTop: 14, color: "#7ee2ad" }}>{notice}</div>}
    </div>
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}><div><h2 style={{ margin: "0 0 6px" }}>Repository metadata</h2><p style={muted}>Name, visibility, default branch, language, last update and public activity metadata.</p></div><span style={muted}>{repositories.length} loaded</span></div>
      {!repositories.length ? <p style={{ ...muted, padding: "20px 0" }}>Connect GitHub and select “Load repositories” to display your accessible repositories.</p> : <div style={{ overflowX: "auto", marginTop: 12 }}><table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}><thead><tr>{["Repository","Visibility","Branch","Language","Last updated"].map(label => <th key={label} style={{ textAlign: "left", padding: "12px 10px", borderBottom: "1px solid var(--border, #26334d)" }}>{label}</th>)}</tr></thead><tbody>{repositories.map(repo => <tr key={repo.id}><td style={{ padding: "12px 10px", borderBottom: "1px solid var(--border, #26334d)" }}><a href={repo.html_url} target="_blank" rel="noreferrer" style={{ fontWeight: 700 }}>{repo.full_name || repo.name}</a>{repo.description && <div style={muted}>{repo.description}</div>}{repo.archived && <small>Archived</small>}</td><td style={{ padding: "12px 10px", borderBottom: "1px solid var(--border, #26334d)" }}>{repo.private ? "Private" : "Public"}{repo.fork ? " · Fork" : ""}</td><td style={{ padding: "12px 10px", borderBottom: "1px solid var(--border, #26334d)" }}>{repo.default_branch || "—"}</td><td style={{ padding: "12px 10px", borderBottom: "1px solid var(--border, #26334d)" }}>{repo.language || "—"}</td><td style={{ padding: "12px 10px", borderBottom: "1px solid var(--border, #26334d)" }}>{repo.updated_at ? new Date(repo.updated_at).toLocaleDateString() : "—"}</td></tr>)}</tbody></table></div>}
    </div>
  </section>;
}


function GeminiIntegration({ accessToken, apiBaseUrl }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const authHeaders = { Authorization: "Bearer " + accessToken };
  const loadStatus = async () => {
    setError("");
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/integrations/gemini/status", { headers: authHeaders });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Unable to load Gemini configuration status.");
      setStatus(data);
    } catch (err) { setError(err.message || "Unable to load Gemini configuration status."); }
  };

  useEffect(() => { loadStatus(); }, [accessToken, apiBaseUrl]);

  const runTest = async () => {
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/integrations/gemini/test", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Gemini connection test failed.");
      setResult(data);
      setStatus(current => ({ ...(current || {}), configured: true, key_present: true, model: data.model }));
    } catch (err) { setError(err.message || "Gemini connection test failed."); }
    finally { setBusy(false); }
  };

  const card = { background: "var(--panel, #111a2d)", border: "1px solid var(--border, #26334d)", borderRadius: 16, padding: 20 };
  const muted = { color: "var(--muted, #9aa8c2)", fontSize: 13 };
  return <section className="content">
    <div className="page-heading"><div><p className="eyebrow">ADMIN CONSOLE / AI PROVIDERS</p><h1>Gemini Integration</h1><p className="muted">Check World Wallet AI's private server-side Google Gemini connection.</p></div></div>
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div><p className="eyebrow">GOOGLE GEMINI API</p><h2 style={{ margin: "8px 0" }}>{status?.configured ? "Backend key configured" : status ? "Backend key missing" : "Checking configuration…"}</h2><p style={muted}>The API key is read only by the backend environment. It is never sent to the browser or returned by these endpoints.</p></div>
        <button type="button" className="primary" disabled={busy || !status?.configured} onClick={runTest}>{busy ? "Testing Gemini…" : "Test Gemini connection"}</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12, marginTop: 20 }}>
        <div><span style={muted}>Provider</span><div style={{ fontWeight: 700, marginTop: 5 }}>Google Gemini</div></div>
        <div><span style={muted}>API key</span><div style={{ fontWeight: 700, marginTop: 5 }}>{status?.configured ? "Present · hidden" : status ? "Not configured" : "Checking…"}</div></div>
        <div><span style={muted}>Model</span><div style={{ fontWeight: 700, marginTop: 5 }}>{status?.model || "gemini-2.5-flash"}</div></div>
        <div><span style={muted}>Connection test</span><div style={{ fontWeight: 700, marginTop: 5 }}>{result?.success ? "Passed" : "Not tested"}</div></div>
      </div>
      {error && <div role="alert" style={{ marginTop: 16, color: "#ff8585" }}>{error}</div>}
      {result && <div role="status" style={{ marginTop: 16, padding: 14, borderRadius: 10, border: "1px solid #277c59" }}><strong style={{ color: "#7ee2ad" }}>✓ {result.message}</strong><p style={{ ...muted, marginBottom: 4 }}>Model: {result.model} · Tested: {new Date(result.tested_at).toLocaleString()}</p><p style={{ marginBottom: 0, overflowWrap: "anywhere" }}>Gemini response: {result.response_preview}</p></div>}
      <p style={{ ...muted, marginTop: 18 }}>A successful test confirms the backend can authenticate and receive a response from Gemini at test time. It does not guarantee quota availability or uninterrupted future service.</p>
    </div>
  </section>;
}

function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("ww_sidebar_collapsed") === "true"; } catch { return false; }
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [active, setActive] = useState(() => {
    try {
      const saved = localStorage.getItem("ww_active_page");
      return saved || "Dashboard";
    } catch { return "Dashboard"; }
  });
  useEffect(() => {
    try {
      if (active) localStorage.setItem("ww_active_page", active);
    } catch {}
  }, [active]);

  const [showDashboardMore, setShowDashboardMore] = useState(false);
  const [coinFilter, setCoinFilter] = useState("all");
  const [coinSearch, setCoinSearch] = useState("");
  const [selectedCoin, setSelectedCoin] = useState(null);
  const [focusedTransaction, setFocusedTransaction] = useState(null);
  const [showBalance, setShowBalance] = useState(true);
  const [wallet, setWallet] = useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem("world_wallet_last_confirmed_portfolio_v1") || "null");
      return cached?.wallet && typeof cached.wallet === "object" ? cached.wallet : fallbackWallet;
    } catch { return fallbackWallet; }
  });
  const [assets, setAssets] = useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem("world_wallet_last_confirmed_portfolio_v1") || "null");
      return Array.isArray(cached?.assets) ? cached.assets : fallbackAssets;
    } catch { return fallbackAssets; }
  });
  useEffect(() => {
    if (!wallet || !Array.isArray(assets) || wallet === fallbackWallet) return;
    try {
      localStorage.setItem("world_wallet_last_confirmed_portfolio_v1", JSON.stringify({
        wallet,
        assets,
        savedAt: new Date().toISOString(),
      }));
    } catch {}
  }, [wallet, assets]);
  const [syncedBalanceAssets, setSyncedBalanceAssets] = useState([]);
  const [hasVerifiedMainnetBalance, setHasVerifiedMainnetBalance] = useState(false);
  const chainRefreshTokenRef = useRef("");
  const [marketPrices, setMarketPrices] = useState({});
  const [marketPricesUpdatedAt, setMarketPricesUpdatedAt] = useState(null);
  const [marketPricesError, setMarketPricesError] = useState("");
  const [marketPricesLoading, setMarketPricesLoading] = useState(false);
  const [coinPriceHistory, setCoinPriceHistory] = useState([]);
  const [coinPriceHistoryLoading, setCoinPriceHistoryLoading] = useState(false);
  const [coinPriceHistoryError, setCoinPriceHistoryError] = useState("");
  const [tokenRegistry, setTokenRegistry] = useState([]);
  const [localWalletEntries, setLocalWalletEntries] = useState(() => { try { const v = JSON.parse(localStorage.getItem("world_wallet_encrypted_vault_v1") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } });
  const [localContracts, setLocalContracts] = useState(() => { try { const v = JSON.parse(localStorage.getItem("world_wallet_deployed_contracts_v1") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } });
  const [externalWalletConnection, setExternalWalletConnection] = useState(() => { try { return JSON.parse(localStorage.getItem("world_wallet_external_connection_v1") || "null"); } catch { return null; } });
  const walletCoinCatalogWithRegistry = useMemo(() => {
    const catalog = walletCoinCatalog.map(coin => {
      const records = tokenRegistry.filter(t => t.symbol === coin.symbol);
      const liveRecord = records.find(t => t.wallet_network_connected);
      const mainnetContract = records.find(t => t.network === "ethereum" && t.contract_address && t.status === "active");
      const sepoliaContract = records.find(t => t.network === "sepolia" && t.contract_address && t.status === "active");
      const quote = marketPrices[coin.symbol] || {};
      return {
        ...coin,
        status: coin.symbol === "BALMZ"
          ? (mainnetContract ? "Ethereum Mainnet • contract registered" : "Ethereum Mainnet • deployment pending")
          : coin.symbol === "BALMZ-SEP"
            ? (sepoliaContract ? "Ethereum Sepolia • contract registered • testnet" : "Ethereum Sepolia • deployment pending • testnet")
            : coin.status,
        registry: liveRecord || mainnetContract || sepoliaContract || records[0] || null,
        connected: Boolean(liveRecord),
        price_usd: quote.usd == null ? null : Number(quote.usd),
        price_24h_change: quote.usd_24h_change == null ? null : Number(quote.usd_24h_change),
        price_listed: quote.listed === true,
        price_source: quote.usd == null ? null : "CoinGecko",
      };
    });
    const catalogSymbols = new Set(catalog.map(coin => coin.symbol));
    const additionalWalletAssets = assets
      .filter(asset => asset?.symbol && !catalogSymbols.has(asset.symbol))
      .map(asset => ({
        symbol: asset.symbol,
        name: asset.name || asset.symbol,
        icon: asset.symbol.startsWith("BALMZ") ? "B" : "•",
        status: asset.network_label || asset.network || "Network not classified",
        registry: null,
        connected: Boolean(asset.network),
        price_usd: asset.price_usd == null ? null : Number(asset.price_usd),
        price_24h_change: null,
        price_listed: asset.price_available === true,
        price_source: asset.price_available ? "Wallet snapshot" : null,
      }));
    return [...catalog, ...additionalWalletAssets];
  }, [walletCoinCatalog, tokenRegistry, marketPrices, assets]);
  const [apiStatus, setApiStatus] = useState("loading");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [dashboardAddresses, setDashboardAddresses] = useState([]);
  const [dashboardAddress, setDashboardAddress] = useState("");
  const [dashboardAddressLabel, setDashboardAddressLabel] = useState("Main Ethereum wallet");
  const [dashboardAddressBusy, setDashboardAddressBusy] = useState(false);
  const [dashboardAddressMessage, setDashboardAddressMessage] = useState("");
  const [selectedNetwork, setSelectedNetwork] = useState(() => {
    try {
      return readSelectedNetwork(localStorage.getItem("world_wallet_selected_network_v1"));
    } catch { return "ethereum"; }
  });
  const balanceRequestIdRef = useRef(0);
  const balanceWalletIdRef = useRef("");
  const [selectedNetworkAddress, setSelectedNetworkAddress] = useState("");
  const [selectedNetworkBalance, setSelectedNetworkBalance] = useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem("world_wallet_last_confirmed_network_balance_v1") || "null");
      const savedNetwork = readSelectedNetwork(localStorage.getItem("world_wallet_selected_network_v1"));
      return cachedBalanceMatchesNetwork(cached, savedNetwork) ? cached : null;
    } catch { return null; }
  });
  const [selectedNetworkBalanceMessage, setSelectedNetworkBalanceMessage] = useState("");
  useEffect(() => {
    if (!selectedNetworkBalance || !Number.isFinite(Number(selectedNetworkBalance.balance))) return;
    try { localStorage.setItem("world_wallet_last_confirmed_network_balance_v1", JSON.stringify(selectedNetworkBalance)); } catch {}
  }, [selectedNetworkBalance]);
  const [selectedNetworkBalanceBusy, setSelectedNetworkBalanceBusy] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [liveWallet, setLiveWallet] = useState({ status: "checking", mode: "read_only", addresses: [], networks: [], message: "" });
  const [networkStatus, setNetworkStatus] = useState({});
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState(() => {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
  });
  const [authRestoring, setAuthRestoring] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState("off");
  const [showRefreshMenu, setShowRefreshMenu] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [registerName, setRegisterName] = useState("");
  const [registerPhone, setRegisterPhone] = useState("");
  const [registerPhoneOtp, setRegisterPhoneOtp] = useState("");
  const [registerPhoneOtpSent, setRegisterPhoneOtpSent] = useState(false);
  const [registerMode, setRegisterMode] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [passwordMode, setPasswordMode] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [otpRequested, setOtpRequested] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [showLogin, setShowLogin] = useState(() => {
    try { return sessionStorage.getItem("world_wallet_show_login") === "1"; } catch { return false; }
  });
  const [loginError, setLoginError] = useState("");
  const [authMethod, setAuthMethod] = useState("email");
  const [authBusy, setAuthBusy] = useState(false);
  const [activity, setActivity] = useState(fallbackActivity);
  const [performance, setPerformance] = useState({ points: [] });
  const [performancePeriod, setPerformancePeriod] = useState("1M");
  const sessionState = authClient.useSession();
  const neonSessionUser = sessionState.data?.user || null;

  useEffect(() => {
    const refreshLocalWalletData = () => {
      try { const v = JSON.parse(localStorage.getItem("world_wallet_encrypted_vault_v1") || "[]"); setLocalWalletEntries(Array.isArray(v) ? v : []); } catch { setLocalWalletEntries([]); }
      try { const v = JSON.parse(localStorage.getItem("world_wallet_deployed_contracts_v1") || "[]"); setLocalContracts(Array.isArray(v) ? v : []); } catch { setLocalContracts([]); }
    };
    const refreshExternalConnection = event => {
      if (event && Object.prototype.hasOwnProperty.call(event, "detail")) {
        setExternalWalletConnection(event.detail || null);
        return;
      }
      try { setExternalWalletConnection(JSON.parse(localStorage.getItem("world_wallet_external_connection_v1") || "null")); } catch { setExternalWalletConnection(null); }
    };
    window.addEventListener("world-wallet-local-vault-updated", refreshLocalWalletData);
    window.addEventListener("world-wallet-contracts-updated", refreshLocalWalletData);
    window.addEventListener("world-wallet-external-connection-updated", refreshExternalConnection);
    window.addEventListener("storage", refreshLocalWalletData);
    window.addEventListener("storage", refreshExternalConnection);
    refreshLocalWalletData();
    refreshExternalConnection();
    return () => {
      window.removeEventListener("world-wallet-local-vault-updated", refreshLocalWalletData);
      window.removeEventListener("world-wallet-contracts-updated", refreshLocalWalletData);
      window.removeEventListener("world-wallet-external-connection-updated", refreshExternalConnection);
      window.removeEventListener("storage", refreshLocalWalletData);
      window.removeEventListener("storage", refreshExternalConnection);
    };
  }, []);

  async function refreshMarketPrices() {
    setMarketPricesLoading(true);
    setMarketPricesError("");
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(API_BASE_URL + "/api/v1/prices/market", { cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || ("Market service returned " + response.status));
        if (!data.prices || typeof data.prices !== "object") throw new Error("Market service returned no price data.");
        setMarketPrices(data.prices);
        setMarketPricesUpdatedAt(data.updated_at ? new Date(data.updated_at) : new Date());
        setMarketPricesError(data.stale ? "Showing the last verified market quotes because the price provider is temporarily unavailable." : "");
        setMarketPricesLoading(false);
        return;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise(resolve => window.setTimeout(resolve, 900));
      }
    }
    setMarketPricesError(lastError?.message || "Live market prices could not be loaded. Check the API connection and try again.");
    setMarketPricesLoading(false);
  }

  useEffect(() => {
    let cancelled = false;
    async function loadMarketPrices() {
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await fetch(API_BASE_URL + "/api/v1/prices/market", { cache: "no-store" });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.detail || "Market prices unavailable");
          if (!data.prices || typeof data.prices !== "object") throw new Error("Market service returned no price data.");
          if (!cancelled) {
            setMarketPrices(data.prices);
            setMarketPricesUpdatedAt(data.updated_at ? new Date(data.updated_at) : new Date());
            setMarketPricesError(data.stale ? "Showing the last verified market quotes because the price provider is temporarily unavailable." : "");
          }
          return;
        } catch (error) {
          lastError = error;
          if (attempt === 0) await new Promise(resolve => window.setTimeout(resolve, 900));
        }
      }
      if (!cancelled) setMarketPricesError(lastError?.message || "Market price service unavailable. Retrying automatically.");
    }
    loadMarketPrices();
    const timer = window.setInterval(loadMarketPrices, 60000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadCoinPriceHistory() {
      setCoinPriceHistory([]);
      setCoinPriceHistoryError("");
      // Devnet BALMZ has no verified token market. Show SOL history only as an
      // explicitly labelled reference chart, never as BALMZ price history.
      if (!selectedCoin || selectedCoin === "BALMZ" || selectedCoin === "BALMZ-SEP") {
        setCoinPriceHistoryLoading(false);
        return;
      }
      const historySymbol = selectedCoin === "BALMZ-SOL-DEVNET" ? "SOL" : selectedCoin.endsWith("-BNB") ? selectedCoin.slice(0, -4) : selectedCoin;
      setCoinPriceHistoryLoading(true);
      try {
        const response = await fetch(API_BASE_URL + "/api/v1/prices/history/" + encodeURIComponent(historySymbol) + "?days=1", { cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "Price history is currently unavailable.");
        if (!Array.isArray(data.points) || data.points.length < 2) throw new Error("Not enough verified market history is available yet.");
        if (!cancelled) setCoinPriceHistory(data.points);
      } catch (error) {
        if (!cancelled) setCoinPriceHistoryError(error.message || "Price history is currently unavailable.");
      } finally {
        if (!cancelled) setCoinPriceHistoryLoading(false);
      }
    }
    loadCoinPriceHistory();
    return () => { cancelled = true; };
  }, [selectedCoin]);

  useEffect(() => {
    let cancelled = false;

    async function restoreSessionFromNeon() {
      let persistedToken = "";
      let socialReturn = "";
      try {
        persistedToken = localStorage.getItem(TOKEN_KEY) || "";
        const callbackProvider = new URLSearchParams(window.location.search).get("auth_callback") || "";
        const storedProvider = sessionStorage.getItem("world_wallet_social_return") || "";
        socialReturn = ["google", "github", "twitter", "telegram"].includes(callbackProvider)
          ? callbackProvider
          : (["google", "github", "twitter", "telegram"].includes(storedProvider)
            ? storedProvider
            : (sessionStorage.getItem("world_wallet_google_return") === "1" ? "google" : ""));
      } catch {
        // Storage can be unavailable in restricted browser modes.
      }

      if (persistedToken && isUsableNeonAccessToken(persistedToken)) {
        if (!accessToken && !cancelled) setAccessToken(persistedToken);
        if (!cancelled) setAuthRestoring(false);
        return;
      }

      // Do not restore an expired cached JWT into the app state. That can
      // leave the dashboard signed in visually while every authenticated API
      // request is rejected by the backend. Try obtaining a fresh Neon token
      // whenever a Neon session exists, even without an OAuth callback marker.
      if (persistedToken) {
        try { localStorage.removeItem(TOKEN_KEY); } catch {}
      }

      if (!socialReturn && !neonSessionUser) {
        if (!cancelled) setAuthRestoring(false);
        return;
      }

      if (!cancelled) setAuthRestoring(true);

      // Neon Auth may need several seconds to restore its cross-origin session.
      // Wait for useSession() to settle instead of timing out and forcing the user
      // back to login while the dashboard is already mounting.
      if (sessionState.isPending) return;

      if (neonSessionUser) {
        for (let attempt = 0; attempt < 8 && !cancelled; attempt += 1) {
          try {
            const token = await getNeonAccessToken();
            if (token) {
              try { localStorage.setItem(TOKEN_KEY, token); } catch {}
              try { sessionStorage.removeItem("world_wallet_google_return"); } catch {}
              try { sessionStorage.removeItem("world_wallet_social_return"); } catch {}
              setUser(neonSessionUser);
              setAccessToken(token);
              setActive("Dashboard");
              setShowLogin(false);
              setAuthRestoring(false);
              if (window.location.search) {
                window.history.replaceState({}, document.title, window.location.pathname);
              }
              return;
            }
          } catch {
            // Keep retrying briefly while Neon Auth finishes the JWT exchange.
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      if (!cancelled) {
        setAuthRestoring(false);
        setShowLogin(true);
        setLoginError(({ github: "GitHub", twitter: "X", telegram: "Telegram", google: "Google" }[socialReturn] || "Social") + " session could not be restored. Please sign in again.");
        try { sessionStorage.removeItem("world_wallet_google_return"); } catch {}
            try { sessionStorage.removeItem("world_wallet_social_return"); } catch {}
        if (window.location.search) {
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      }
    }

    restoreSessionFromNeon();
    return () => {
      cancelled = true;
    };
  }, [sessionState.isPending, neonSessionUser, accessToken]);

  useEffect(() => {
    let cancelled = false;

    async function loadTokenRegistry(authHeaders) {
      try {
        const response = await fetch(API_BASE_URL + "/api/v1/tokens", { headers: authHeaders });
        const data = await response.json();
        if (response.ok) setTokenRegistry(data.tokens || []);
      } catch {
        setTokenRegistry([]);
      }
    }

    async function loadWallet() {
      if (!accessToken) return;
      const authHeaders = { Authorization: `Bearer ${accessToken}` };
      // Render the last confirmed snapshot first, then perform one authenticated
      // read-only chain-balance sync for this session. Transaction signing remains external.
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/wallet`, { headers: authHeaders, cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "Saved wallet snapshot unavailable.");
        if (cancelled) return;
        if (data.wallet) setWallet(data.wallet);
        if (Array.isArray(data.assets)) setAssets(data.assets.map(asset => ({
          ...asset,
          icon: asset.symbol.startsWith("BALMZ") ? "B" : asset.symbol === "USDT" ? "$" : asset.symbol === "ETH" ? "Ξ" : asset.symbol === "BNB" ? "◆" : "•",
        })));
        if (data.user) setUser(data.user);
        setApiStatus("online");

        // Fetch current on-chain balances once per authenticated session.
        // RPC validation on the backend keeps Mainnet and testnets isolated.
        if (chainRefreshTokenRef.current !== accessToken) {
          chainRefreshTokenRef.current = accessToken;
          setHasVerifiedMainnetBalance(false);
          try {
            const liveResponse = await fetch(API_BASE_URL + "/api/v1/wallet/refresh", {
              method: "POST",
              headers: authHeaders,
              cache: "no-store",
            });
            const live = await liveResponse.json().catch(() => ({}));
            if (liveResponse.ok && !cancelled) {
              if (live.wallet) setWallet(live.wallet);
              if (Array.isArray(live.assets)) setAssets(live.assets.map(asset => ({
                ...asset,
                icon: asset.symbol.startsWith("BALMZ") ? "B" : asset.symbol === "USDT" ? "$" : asset.symbol === "ETH" ? "Ξ" : asset.symbol === "BNB" ? "◆" : "•",
              })));
              if (Array.isArray(live.transactions)) setActivity(live.transactions.map(tx => ({
                id: tx.id, type: tx.type, asset: tx.asset || tx.symbol || "",
                symbol: tx.asset || tx.symbol || "", network: tx.network,
                description: (tx.asset || "") + " • " + (tx.description || "Wallet transaction"),
                amount: (Number(tx.amount) >= 0 ? "+" : "") + Number(tx.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 }) + " " + (tx.asset || ""),
                raw_amount: Number(tx.amount), time: tx.time, status: tx.status,
                tx_hash: tx.tx_hash, confirmations: tx.confirmations, block_height: tx.block_height,
              })));
              const verifiedMainnetRead = Array.isArray(live.updates) && live.updates.some(item => ["bitcoin", "ethereum", "bnb", "solana_mainnet"].includes(String(item?.network || "").toLowerCase()));
              if (Array.isArray(live.updates)) {
                setSyncedBalanceAssets([...new Set(live.updates.map(item => String(item?.asset || "").trim().toUpperCase()).filter(Boolean))]);
              }
              if (live.network_status) setNetworkStatus(live.network_status);
              if (live.last_balance_sync_at) setLastSyncedAt(live.last_balance_sync_at);
              // Update stored USD quotes after chain balances, so the portfolio
              // total is recalculated from live holdings and current provider prices.
              try {
                const priceResponse = await fetch(API_BASE_URL + "/api/v1/prices/refresh", {
                  method: "POST",
                  headers: authHeaders,
                });
                const priced = await priceResponse.json().catch(() => ({}));
                if (priceResponse.ok && !cancelled) {
                  if (priced.wallet) setWallet(priced.wallet);
                  if (Array.isArray(priced.assets)) setAssets(priced.assets.map(asset => ({
                    ...asset,
                    icon: asset.symbol.startsWith("BALMZ") ? "B" : asset.symbol === "USDT" ? "$" : asset.symbol === "ETH" ? "Ξ" : asset.symbol === "BNB" ? "◆" : "•",
                  })));
                  if (verifiedMainnetRead) setHasVerifiedMainnetBalance(true);
                }
              } catch {
                // Existing verified prices and balances remain visible if quotes fail.
              }
            }
          } catch {
            // Keep the last confirmed snapshot when any RPC is temporarily unavailable.
          }
        }
      } catch (error) {
        if (!cancelled) {
          setApiStatus("error");
          // Keep the last confirmed wallet and balance visible on transient errors.
        }
      }
      loadTokenRegistry(authHeaders);
      try {
        const walletResponse = await fetch(`${API_BASE_URL}/api/v1/wallet/connect`, { headers: authHeaders, cache: "no-store" });
        const walletData = await walletResponse.json().catch(() => ({}));
        if (!cancelled && walletResponse.ok) setLiveWallet({ status: walletData.status || "not_configured", mode: walletData.mode || "read_only", addresses: walletData.addresses || [], networks: walletData.networks || [], message: walletData.message || "" });
      } catch {
        if (!cancelled) setLiveWallet({ status: "error", mode: "read_only", addresses: [], networks: [], message: "Live wallet connection status unavailable." });
      }
    }

    loadWallet();
    const walletRefreshTimer = refreshInterval === "off"
      ? null
      : window.setInterval(loadWallet, Number(refreshInterval));

    async function loadTransactions() {
      if (!accessToken) return;
      const authHeaders = { Authorization: `Bearer ${accessToken}` };
      try {
        let response = await fetch(`${API_BASE_URL}/api/v1/transactions`, { headers: authHeaders });
        if (response.status === 401) {
          const freshToken = await getNeonAccessToken({ forceRefresh: true });
          if (freshToken && freshToken !== accessToken && !cancelled) {
            setAccessToken(freshToken);
            return;
          }
        }
        if (!response.ok) throw new Error("Transactions API unavailable");
        const data = await response.json();
        if (cancelled) return;
        setActivity((data.transactions || []).map(tx => ({
          id: tx.id,
          type: tx.type,
          asset: tx.asset || tx.symbol || "", symbol: tx.asset || tx.symbol || "",
          from_address: tx.from_address || tx.from || null, to_address: tx.to_address || tx.to || null,
          network: tx.network, token_contract_address: tx.token_contract_address || tx.contract_address || null,
          description: `${tx.asset} • ${tx.description}`,
          amount: `${Number(tx.amount) >= 0 ? "+" : ""}${Number(tx.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 })} ${tx.asset}`,
          raw_amount: Number(tx.amount),
          time: tx.time,
          status: tx.status,
          tx_hash: tx.tx_hash,
          confirmations: Number(tx.confirmations || 0),
          block_height: tx.block_height,
        })));
      } catch {
        // Keep the last confirmed activity rows visible during transient API failures.
      }
    }

    async function syncLiveTransactions() {
      if (!accessToken || cancelled) return;
      try {
        const syncResponse = await fetch(API_BASE_URL + "/api/v1/transactions/sync", {
          method: "POST",
          headers: { Authorization: "Bearer " + accessToken },
        });
        if (!syncResponse.ok) return;
        const syncData = await syncResponse.json();
        if (cancelled) return;
        setActivity((syncData.transactions || []).map(tx => ({
          id: tx.id, type: tx.type, asset: tx.asset || tx.symbol || "", symbol: tx.asset || tx.symbol || "",
          from_address: tx.from_address || tx.from || null, to_address: tx.to_address || tx.to || null,
          token_contract_address: tx.token_contract_address || tx.contract_address || null,
          description: tx.asset + " • " + tx.description,
          amount: (Number(tx.amount) >= 0 ? "+" : "") + Number(tx.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 }) + " " + tx.asset,
          raw_amount: Number(tx.amount), time: tx.time, status: tx.status, tx_hash: tx.tx_hash,
          confirmations: Number(tx.confirmations || 0), block_height: tx.block_height, network: tx.network,
          block_hash: tx.block_hash, log_index: tx.log_index,
        })));
      } catch {
        // Keep the last known real transaction state when a refresh is temporarily unavailable.
      }
    }

    loadTransactions();
    syncLiveTransactions();
    const liveTransactionTimer = refreshInterval === "off"
      ? null
      : window.setInterval(syncLiveTransactions, Number(refreshInterval));

    return () => {
      cancelled = true;
      if (walletRefreshTimer) window.clearInterval(walletRefreshTimer);
      if (liveTransactionTimer) window.clearInterval(liveTransactionTimer);
    };
  }, [accessToken, refreshInterval]);

  useEffect(() => {
    if (!accessToken) {
      setPerformance({ points: [], period: performancePeriod });
      return;
    }
    let cancelled = false;
    const authHeaders = { Authorization: "Bearer " + accessToken };
    async function loadPerformance(recordSnapshot = false) {
      try {
        if (recordSnapshot && hasVerifiedMainnetBalance) {
          // Never append a new production performance point until a Mainnet
          // chain balance has been read successfully in this session.
          await fetch(API_BASE_URL + "/api/v1/portfolio/performance/snapshot", {
            method: "POST",
            headers: authHeaders,
          });
        }
        const response = await fetch(
          API_BASE_URL + "/api/v1/portfolio/performance?period=" + encodeURIComponent(performancePeriod),
          { headers: authHeaders, cache: "no-store" },
        );
        if (!response.ok) throw new Error("Performance API unavailable");
        const data = await response.json();
        if (!cancelled) setPerformance(data);
      } catch {
        if (!cancelled) setPerformance({ points: [], period: performancePeriod, unavailable: true });
      }
    }
    loadPerformance(true);
    const timer = window.setInterval(() => loadPerformance(true), 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [accessToken, performancePeriod, hasVerifiedMainnetBalance]);

  async function loadDashboardAddresses() {
    if (!accessToken) return;
    try {
      const response = await fetch(API_BASE_URL + "/api/v1/wallet/addresses", {
        headers: { Authorization: "Bearer " + accessToken },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Unable to load wallet addresses.");
      setDashboardAddresses(data.addresses || []);
    } catch (error) {
      setDashboardAddressMessage(error.message || "Unable to load wallet addresses.");
    }
  }

  async function attachDashboardAddress() {
    const address = dashboardAddress.trim();
    const walletId = wallet?.wallet_id || user?.wallet_id;
    const network = selectedNetwork;
    if (!["ethereum", "sepolia", "bnb"].includes(network)) {
      setDashboardAddressMessage("This quick attach field supports Ethereum Mainnet, Ethereum Sepolia, and BNB Chain only. Use Wallets to manage Bitcoin or Solana Devnet addresses.");
      return;
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      setDashboardAddressMessage("Connect your existing EVM wallet or enter its public 0x address.");
      return;
    }
    if (!walletId) {
      setDashboardAddressMessage("The active wallet profile could not be identified. Open Wallets and select a wallet first.");
      return;
    }
    setDashboardAddressBusy(true);
    setDashboardAddressMessage("");
    try {
      const response = await fetch(API_BASE_URL + "/api/v1/wallets/" + encodeURIComponent(walletId) + "/addresses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
        body: JSON.stringify({ network, address, label: dashboardAddressLabel.trim() || (network === "sepolia" ? "Ethereum Sepolia address" : network === "bnb" ? "BNB Chain address" : "Ethereum address") }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Unable to attach this address.");
      setDashboardAddressMessage((network === "sepolia" ? "Ethereum Sepolia" : network === "bnb" ? "BNB Chain" : "Ethereum Mainnet") + " public address attached. Its read-only balance will load separately; portfolio balances are unchanged.");
      await loadDashboardAddresses();
    } catch (error) {
      setDashboardAddressMessage(error.message || "Unable to attach this address.");
    } finally {
      setDashboardAddressBusy(false);
    }
  }

  useEffect(() => {
    if (active === "Dashboard" && accessToken) loadDashboardAddresses();
  }, [active, accessToken]);

  useEffect(() => {
    try { localStorage.setItem("world_wallet_selected_network_v1", selectedNetwork); } catch {}
  }, [selectedNetwork]);
  
  // Never prefill an unrelated/old address. Use the currently connected external
  // wallet's public EVM address and chain, without ever requesting a private key.
  useEffect(() => {
    const address = String(externalWalletConnection?.address || "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return;
    setDashboardAddress(address);
    // A restored EVM connection is address metadata, not permission to change
    // the user's saved network. In particular, it must not replace Solana
    // Devnet with Ethereum Mainnet after a reload or pull-to-refresh.
  }, [externalWalletConnection]);

  function changeSelectedNetwork(nextNetwork) {
    const normalized = normalizeNetworkId(nextNetwork);
    if (normalized === normalizeNetworkId(selectedNetwork)) return;
    setSelectedNetwork(normalized);
    try { localStorage.setItem("world_wallet_selected_network_v1", normalized); } catch {}
    setSelectedNetworkAddress("");
    setSelectedNetworkBalance(null);
    setSelectedNetworkBalanceMessage("");
  }

  function changeNetworkEnvironment(environment) {
    // Entering either environment always selects its agreed safe default.
    changeSelectedNetwork(defaultNetworkForEnvironment(environment));
  }

  async function refreshSelectedNetworkBalance(forceAddressRefresh = false) {
    const requestId = ++balanceRequestIdRef.current;
    const requestedNetwork = normalizeNetworkId(selectedNetwork);
    if (!accessToken) {
      setSelectedNetworkBalanceBusy(false);
      setSelectedNetworkBalanceMessage("Sign in to check a wallet balance.");
      return;
    }
    setSelectedNetworkBalanceBusy(true);
    setSelectedNetworkBalanceMessage("");
    let token = accessToken;
    const normalizeNetwork = normalizeNetworkId;
    const authorizedFetch = async (url, options = {}) => {
      const makeRequest = currentToken => fetch(url, {
        ...options,
        headers: { ...(options.headers || {}), Authorization: "Bearer " + currentToken },
        cache: "no-store",
      });
      let response = await makeRequest(token);
      if (response.status === 401) {
        const refreshed = await getNeonAccessToken({ forceRefresh: true });
        if (refreshed && refreshed !== token) {
          token = refreshed;
          response = await makeRequest(token);
        }
      }
      return response;
    };
    try {
      const normalizedSelectedNetwork = requestedNetwork;
      let walletId = forceAddressRefresh ? "" : (balanceWalletIdRef.current || wallet?.wallet_id || wallet?.id || user?.wallet_id);
      let currentAddresses = dashboardAddresses;
      const hasCachedAddress = !forceAddressRefresh && currentAddresses.some(item => normalizeNetwork(item.network) === normalizedSelectedNetwork);
      if (!walletId || !hasCachedAddress) {
        if (!walletId) {
          const walletsResponse = await authorizedFetch(API_BASE_URL + "/api/v1/wallets");
          const walletsData = await walletsResponse.json().catch(() => ({}));
          if (!walletsResponse.ok) throw new Error(walletsData.detail || ("Unable to load active wallet (HTTP " + walletsResponse.status + ")."));
          walletId = walletsData.active_wallet_id || walletsData.wallets?.find(item => item.active)?.id;
          if (walletId) balanceWalletIdRef.current = walletId;
        }
        if (!walletId) throw new Error("No active wallet was returned by the server. Open Wallets and select your wallet, then refresh.");
        const addressResponse = await authorizedFetch(API_BASE_URL + "/api/v1/wallets/" + encodeURIComponent(walletId) + "/addresses");
        const addressData = await addressResponse.json().catch(() => ({}));
        if (!addressResponse.ok) throw new Error(addressData.detail || ("Unable to load attached addresses (HTTP " + addressResponse.status + ")."));
        currentAddresses = Array.isArray(addressData.addresses) ? addressData.addresses : [];
        setDashboardAddresses(currentAddresses);
      }
      if (!walletId) throw new Error("No active wallet was returned by the server. Open Wallets and select your wallet, then refresh.");
      const matches = currentAddresses.filter(item => normalizeNetwork(item.network) === normalizedSelectedNetwork);
      const chosen = matches.find(item => item.address === selectedNetworkAddress) || matches[0];
      if (!chosen) throw new Error("No address is attached for " + (({ ethereum: "Ethereum Mainnet", sepolia: "Ethereum Sepolia (Testnet)", bnb: "BNB Chain", bitcoin: "Bitcoin", solana_mainnet: "Solana Mainnet", solana_devnet: "Solana Devnet (Testnet)" })[selectedNetwork] || selectedNetwork) + ". Open Wallets to inspect its existing public address.");
      if (requestId !== balanceRequestIdRef.current || normalizeNetworkId(selectedNetwork) !== requestedNetwork) return;
      if (selectedNetworkAddress !== chosen.address) setSelectedNetworkAddress(chosen.address);
      const query = new URLSearchParams({ network: normalizedSelectedNetwork, address: chosen.address });
      const response = await authorizedFetch(API_BASE_URL + "/api/v1/wallets/" + encodeURIComponent(walletId) + "/addresses/balance?" + query.toString());
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || ("Balance request failed (HTTP " + response.status + ")."));
      const balance = Number(data.balance);
      if (!Number.isFinite(balance) || balance < 0) throw new Error("The API returned an invalid balance.");
      if (requestId !== balanceRequestIdRef.current || normalizeNetworkId(selectedNetwork) !== requestedNetwork) return;
      setSelectedNetworkBalance({ network: normalizedSelectedNetwork, balance, asset: data.asset || normalizedSelectedNetwork, address: chosen.address, syncedAt: data.synced_at });
      setSelectedNetworkBalanceMessage("Balance updated.");
    } catch (error) {
      // Keep the last confirmed balance visible if a refresh fails.
      if (requestId === balanceRequestIdRef.current && normalizeNetworkId(selectedNetwork) === requestedNetwork) setSelectedNetworkBalanceMessage(error.message || "Selected network balance is unavailable.");
    } finally {
      if (requestId === balanceRequestIdRef.current) {
        setSelectedNetworkBalanceBusy(false);
      }
    }
  }

  useEffect(() => {
    refreshSelectedNetworkBalance();
  }, [selectedNetwork, accessToken, wallet?.wallet_id, wallet?.id, user?.wallet_id]);
    async function syncWallet() {
    if (!accessToken || syncBusy) return;
    setSyncBusy(true);
    setSyncMessage("");
    try {
      const response = await fetch(API_BASE_URL + "/api/v1/wallet/refresh", {
        method: "POST",
        headers: { Authorization: "Bearer " + accessToken },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Wallet sync failed.");
      setWallet(data.wallet || fallbackWallet);
      setAssets((data.assets || fallbackAssets).map(asset => ({
        ...asset,
        icon: asset.symbol.startsWith("BALMZ") ? "B" : asset.symbol === "USDT" ? "$" : asset.symbol === "ETH" ? "Ξ" : asset.symbol === "BNB" ? "◆" : "•",
      })));
      setActivity((data.transactions || []).map(tx => ({
        type: tx.type,
        description: (tx.asset || "") + " • " + (tx.description || "Wallet transaction"),
        amount: (Number(tx.amount) >= 0 ? "+" : "") + Number(tx.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 }) + " " + (tx.asset || ""),
        raw_amount: Number(tx.amount),
        time: tx.time,
        status: tx.status,
        tx_hash: tx.tx_hash,
        confirmations: Number(tx.confirmations || 0),
        block_height: tx.block_height,
      })));
      setApiStatus("online");
      setLastSyncedAt(new Date());
      setLastSyncedAt(data.refreshed_at ? new Date(data.refreshed_at) : new Date());
      setSyncMessage(data.warnings?.length ? data.warnings.join(" • ") : "Wallet data refreshed.");
    } catch (error) {
      setSyncMessage(error.message || "Wallet sync failed.");
      setApiStatus("error");
    } finally {
      setSyncBusy(false);
    }
  }

  const dashboardTouchStartY = useRef(null);
  useEffect(() => {
    if (active !== "Dashboard") return undefined;
    const isAtTop = target => {
      let node = target instanceof Element ? target : null;
      while (node && node !== document.body) {
        if (node.scrollHeight > node.clientHeight + 4) return node.scrollTop <= 2;
        node = node.parentElement;
      }
      return window.scrollY <= 2;
    };
    const onTouchStart = event => {
      if (event.touches?.length === 1 && isAtTop(event.target)) dashboardTouchStartY.current = event.touches[0].clientY;
      else dashboardTouchStartY.current = null;
    };
    const onTouchEnd = event => {
      const startY = dashboardTouchStartY.current;
      dashboardTouchStartY.current = null;
      if (startY == null || !isAtTop(event.target) || !event.changedTouches?.length) return;
      const distance = event.changedTouches[0].clientY - startY;
      if (distance < 90 || syncBusy || !accessToken) return;
      void (async () => {
        await syncWallet();
        await refreshSelectedNetworkBalance(true);
      })();
    };
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
      dashboardTouchStartY.current = null;
    };
  }, [active, accessToken, syncBusy]);

  async function handleLogin(event) {
    event.preventDefault();
    setLoginError("");
    try {
      const response = await fetch(API_BASE_URL + "/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Login failed");
      localStorage.setItem(TOKEN_KEY, data.access_token);
      setAccessToken(data.access_token);
      setUser(data.user || null);
    } catch (error) {
      setLoginError(error.message || "Unable to sign in");
    }
  }

  async function getWalletTokenWithRetry(attempts = 8) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const token = await getNeonAccessToken();
      if (token) return token;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return "";
  }

  async function requestRegisterPhoneOtp() {
    setLoginError("");
    setAuthMessage("");
    setAuthBusy(true);
    try {
      const phone = registerPhone.trim().replace(/[\s()-]/g, "");
      if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error("Enter a valid phone number with country code, for example +2348012345678.");
      const response = await fetch(API_BASE_URL + "/api/v1/auth/phone/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_number: phone }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to request phone verification. SMS may not be configured yet.");
      setRegisterPhoneOtpSent(true);
      setRegisterPhoneOtp("");
      setAuthMessage(data.message || "If phone verification is configured, a code has been requested.");
    } catch (error) {
      setLoginError(error.message || "Unable to request phone verification.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleRegister() {
    setLoginError("");
    setAuthMessage("");
    setAuthBusy(true);
    try {
      const name = registerName.trim();
      const phone = registerPhone.trim().replace(/[\s()-]/g, "");
      const email = loginEmail.trim().toLowerCase();
      if (!name) throw new Error("Enter your name.");
      if (!phone) throw new Error("Enter your phone number, including country code.");
      if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error("Use international format, for example +2348012345678.");
      if (!email) throw new Error("Enter your email address.");
      if (!registerPhoneOtpSent) throw new Error("Request and enter the SMS verification code before creating your account.");
      if (!/^\d{4,10}$/.test(registerPhoneOtp.trim())) throw new Error("Enter the SMS verification code.");
      if (loginPassword.length < 8) throw new Error("Use a password with at least 8 characters.");
      const response = await fetch(API_BASE_URL + "/api/v1/auth/neon/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone_number: phone, phone_otp: registerPhoneOtp.trim(), password: loginPassword }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to create your account.");
      setLoginPassword("");
      if (data.access_token) {
        localStorage.setItem(TOKEN_KEY, data.access_token);
        setUser(data.user || null);
        setAccessToken(data.access_token);
        setRegisterMode(false);
      } else {
        setRegisterMode(false);
        setPasswordMode(true);
        setAuthMessage(data.message || "Registration submitted. Follow any email verification instructions, then sign in.");
      }
    } catch (error) {
      setLoginError(error.message || "Unable to create your account.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handlePasswordSignIn() {
    setLoginError("");
    setAuthMessage("");
    setAuthBusy(true);
    try {
      const email = loginEmail.trim().toLowerCase();
      if (!email) throw new Error("Enter your email address.");
      if (!loginPassword) throw new Error("Enter your password.");

      // Sign in directly through Neon Auth in the browser. The browser owns
      // the Neon Auth session cookie; a server-side relay cannot reliably
      // recreate that cross-origin cookie session for the /token exchange.
      const result = await authClient.signIn.email({
        email,
        password: loginPassword,
      });
      if (result?.error) {
        throw new Error(authErrorMessage(result.error, "Unable to sign in with password."));
      }

      // First use the browser's Neon Auth session. On native Capacitor builds,
      // the WebView origin can differ from the website origin and the cross-origin
      // /token cookie exchange may be blocked. If that happens, retry the same
      // password sign-in through the backend's existing Neon Auth relay, which
      // keeps the provider cookie exchange server-side. The API still verifies
      // the returned JWT signature, issuer, identity, and expiry on every request.
      let token = await getWalletTokenWithRetry();
      let signedInUser = result?.data?.user || result?.user || null;

      if (!token) {
        const relayResponse = await fetch(API_BASE_URL + "/api/v1/auth/neon/password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: loginPassword }),
          cache: "no-store",
        });
        const relayData = await relayResponse.json().catch(() => ({}));
        if (!relayResponse.ok) {
          throw new Error(relayData.detail || "Sign-in succeeded, but the secure wallet session could not be completed. Please retry.");
        }
        token = relayData.access_token || "";
        if (!isUsableNeonAccessToken(token)) {
          throw new Error("Neon Auth did not return a valid secure wallet session. Please retry.");
        }
        signedInUser = relayData.user || signedInUser;
      }

      if (!isUsableNeonAccessToken(token)) {
        throw new Error("Neon Auth did not return a valid secure wallet session. Please retry.");
      }

      localStorage.setItem(TOKEN_KEY, token);
      setUser(signedInUser);
      setAccessToken(token);
      setLoginPassword("");
      setPasswordMode(false);
      setShowLogin(false);
      setAuthMessage("");
    } catch (error) {
      setLoginError(error.message || "Unable to sign in with password");
    } finally {
      setAuthBusy(false);
    }
  }

  async function requestEmailOtp() {
    setLoginError("");
    setAuthBusy(true);
    try {
      const email = loginEmail.trim().toLowerCase();
      if (!email) throw new Error("Enter your email address.");
      const response = await fetch(API_BASE_URL + "/api/v1/auth/neon/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to send the sign-in code.");
      setOtpRequested(true);
    } catch (error) {
      setLoginError(error.message || "Unable to send the sign-in code");
    } finally {
      setAuthBusy(false);
    }
  }

  async function verifyEmailOtp() {
    setLoginError("");
    setAuthBusy(true);
    try {
      const email = loginEmail.trim().toLowerCase();
      const response = await fetch(API_BASE_URL + "/api/v1/auth/neon/otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, otp: otpCode.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Invalid or expired code.");
      if (!data.access_token) throw new Error("Secure wallet token was not returned.");
      localStorage.setItem(TOKEN_KEY, data.access_token);
      setUser(data.user || null);
      setAccessToken(data.access_token);
      setOtpCode("");
      setOtpRequested(false);
    } catch (error) {
      setLoginError(error.message || "Unable to verify the sign-in code");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSocialSignIn(provider) {
    const providerName = ({ github: "GitHub", twitter: "X", telegram: "Telegram", google: "Google" }[provider] || provider);
    setLoginError("");
    if (provider === "twitter" || provider === "telegram") {
      setLoginError(provider === "twitter"
        ? "X sign-in UI is ready, but authentication is not configured on the server yet. X OAuth 2.0 Client ID/Secret and a verified callback flow must be configured before this can sign you in."
        : "Telegram sign-in UI is ready, but authentication is not configured on the server yet. It requires a Telegram bot token, verified Telegram login data, and a secure server-side session exchange.");
      setAuthBusy(false);
      return;
    }
    setAuthBusy(true);
    try {
      sessionStorage.setItem("world_wallet_social_return", provider);
      if (provider === "google") sessionStorage.setItem("world_wallet_google_return", "1");
      const result = await authClient.signIn.social({
        provider,
        callbackURL: (["localhost", "127.0.0.1"].includes(window.location.hostname) ? window.location.origin : "https://world-wallet-ai-frontend.onrender.com") + "/?auth_callback=" + provider,
      });
      if (result?.error) throw new Error(authErrorMessage(result.error, providerName + " Sign-In failed."));
    } catch (error) {
      sessionStorage.removeItem("world_wallet_google_return");
      sessionStorage.removeItem("world_wallet_social_return");
      setLoginError(error.message || (providerName + " Sign-In unavailable. Check that the provider is enabled in Neon Auth."));
      setAuthBusy(false);
    }
  }

  async function handleBiometricSignIn() {
    setLoginError("");
    setAuthBusy(true);
    try {
      if (!window.PublicKeyCredential || !navigator.credentials) throw new Error("Fingerprint/Face Unlock is not available in this browser or device.");
      throw new Error("Fingerprint/Face Unlock is ready for WebAuthn; secure server challenge verification must be enabled before it can sign in.");
    } catch (error) {
      setLoginError(error.message || "Biometric sign-in unavailable");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    try {
      await authClient.signOut();
    } catch {
      // Clear the local application session even if the remote sign-out request fails.
    }
    localStorage.removeItem(TOKEN_KEY);
    setAccessToken("");
    setUser(null);
  }

  const nav = useMemo(() => ({
    Main: ["Dashboard", "BALMZ AI", "BALMZ Presale", "Wallets", "Portfolio", "Send", "Receive", "Deposit", "Swap", "Staking", "NFTs", "Transactions", "Profile"],
    Tools: ["Browser", "Wallet Connect", "Proof of Reserves", "Sepolia Converter", "Address Converter", "Contract Converter", "API Request", "API Keys", "Withdraw", "Request Center", "Contract Generator", "Verify Contract", "Address Book"],
    Admin: ["Admin Editor", "User Management", "System Settings", "Logs & Activity", "Role Management", "GitHub Integration", "Gemini Integration"],
    Support: ["Support Center", "Help & Docs"],
  }), []);

  if (!accessToken && !showLogin) {
    return (
      <div className="ww-public-shell">
        <header className="ww-public-nav">
          <button className="ww-public-brand" type="button" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} aria-label="World Wallet AI home">
            <img className="ww-shield-logo" src="/world-wallet-ai-logo.svg" alt="" />
            <span><b>WORLD WALLET <em>AI</em></b><small>YOUR INTELLIGENT DIGITAL WALLET</small></span>
          </button>
          <nav aria-label="Main navigation">
            <a href="#features">Features</a><a href="#security">Security</a><a href="#assets">Digital assets</a>
          </nav>
          <button className="ww-nav-login" type="button" onClick={() => setShowLogin(true)}>Sign in <span>↗</span></button>
        </header>

        <main>
          <section className="ww-landing-hero">
            <div className="ww-hero-copy">
              <span className="ww-live-badge"><i /> THE INTELLIGENT DIGITAL WALLET</span>
              <h1>Your Crypto.<br /><em>Your Freedom.</em></h1>
              <p>Manage your digital assets, monitor your available balance, and make smarter wallet decisions in one secure place — with BALMZ AI alongside you.</p>
              <div className="ww-hero-cta">
                <button className="ww-preview-submit" type="button" onClick={() => setShowLogin(true)}>Open your wallet <span>→</span></button>
                <a href="#features">Explore features <span>↓</span></a>
              </div>
              <div className="ww-hero-features">
                <div><b>◈</b><span><strong>Multi-chain</strong><small>Supported networks</small></span></div>
                <div><b>✦</b><span><strong>BALMZ AI</strong><small>Wallet intelligence</small></span></div>
                <div><b>↗</b><span><strong>Live wallet</strong><small>Connected data</small></span></div>
                <div><b>⌑</b><span><strong>Security first</strong><small>Protected access</small></span></div>
              </div>
              <div className="ww-market-strip" id="assets">
                <div><b>BALMZ</b><span>World Wallet token</span></div>
                <div><b>ETH · USDT</b><span>Ethereum ecosystem</span></div>
                <div><b>BNB</b><span>BNB Chain</span></div>
              </div>
              <div className="ww-trust-line"><span>●</span> Available balance and portfolio data load after secure sign-in.</div>
            </div>

            <div className="ww-login-preview" aria-label="Wallet dashboard preview">
              <div className="ww-orbit ww-orbit-a" /><div className="ww-orbit ww-orbit-b" />
              <div className="ww-login-card">
                <div className="ww-login-heading"><div className="ww-login-icon">◈</div><div><span>WORLD WALLET AI</span><h2>Your wallet at a glance</h2><p>A preview of your secure workspace</p></div></div>
                <div className="ww-preview-balance"><span>AVAILABLE BALANCE</span><b>••••••••</b><small>Private until you sign in</small></div>
                <div className="ww-preview-stats">
                  <div><span>Portfolio</span><b>Live asset data</b></div><div><span>Wallet network</span><b><i /> Connection status</b></div>
                </div>
                <div className="ww-preview-assets">
                  <div><span className="ww-preview-coin coin-balmz">B</span><span><b>BALMZ</b><small>Wallet token</small></span><strong>—</strong></div>
                  <div><span className="ww-preview-coin coin-eth">Ξ</span><span><b>ETH</b><small>Ethereum</small></span><strong>—</strong></div>
                  <div><span className="ww-preview-coin coin-usdt">$</span><span><b>USDT</b><small>Tether USD</small></span><strong>—</strong></div>
                  <div><span className="ww-preview-coin coin-bnb">◆</span><span><b>BNB</b><small>BNB Chain</small></span><strong>—</strong></div>
                </div>
                <button className="ww-preview-submit" type="button" onClick={() => setShowLogin(true)}>Sign in to view your wallet <span>→</span></button>
                <p className="ww-create">Your balances are not shown in this public preview.</p>
              </div>
            </div>
          </section>

          <section className="ww-feature-section" id="features">
            <div className="ww-section-title"><span>01 / FEATURES</span><div><small>BUILT AROUND YOUR WALLET</small><h2>One wallet. More clarity.</h2></div></div>
            <div className="ww-feature-grid">
              <article><b>◈</b><h3>Multi-chain wallet</h3><p>Review supported assets and network connections in one workspace.</p></article>
              <article><b>✦</b><h3>BALMZ AI insights</h3><p>Get wallet-aware assistance based on available, authenticated account data.</p></article>
              <article><b>↔</b><h3>Wallet activity</h3><p>Review transaction history and use wallet tools built around your account.</p></article>
              <article><b>▥</b><h3>Portfolio overview</h3><p>See connected asset balances and portfolio information when available.</p></article>
            </div>
          </section>

          <section className="ww-security-section" id="security">
            <div><small>02 / SECURITY & CONTROL</small><h2>Your wallet data stays yours.</h2><p>Sign in to access your account. Balances, transaction history, and wallet status are loaded from authenticated services rather than invented public demo figures.</p></div>
            <div className="ww-security-points">
              <div><b>01</b><span><strong>Secure sign-in</strong><br />Account access through the configured authentication provider.</span></div>
              <div><b>02</b><span><strong>Real account data</strong><br />Private wallet information is shown inside your signed-in workspace.</span></div>
              <div><b>03</b><span><strong>Network visibility</strong><br />See connection and synchronization status where configured.</span></div>
            </div>
          </section>
        </main>
        <footer className="ww-public-footer"><span>© WORLD WALLET AI</span><span>YOUR CRYPTO. YOUR FREEDOM.</span><button type="button" onClick={() => setShowLogin(true)}>Sign in ↗</button></footer>
      </div>
    );
  }

  const assetDerivedUnpriced = assets
    .filter(asset => (Number(asset.balance || 0) > 0 || Number(asset.reserved_balance || 0) > 0)
      && !(Number(asset.price_usd ?? asset.live_price_usd ?? 0) > 0))
    .map(asset => String(asset.symbol || "").trim())
    .filter(Boolean);
  const walletUnpricedAssets = [...new Set([
    ...(Array.isArray(wallet.unpriced_assets) ? wallet.unpriced_assets : []),
    ...assetDerivedUnpriced,
  ])];
  const walletHasCompleteValuation = wallet.valuation_complete !== false && wallet.available_balance_usd != null;
  const walletPartialValue = wallet.partial_available_balance_usd != null
    ? wallet.partial_available_balance_usd
    : assets.reduce((total, asset) => {
      if (asset.value_usd != null && Number.isFinite(Number(asset.value_usd))) return total + Number(asset.value_usd);
      const price = Number(asset.price_usd ?? asset.live_price_usd ?? 0);
      const balance = Number(asset.balance || 0);
      return price > 0 && Number.isFinite(price) && Number.isFinite(balance) ? total + price * balance : total;
    }, 0);
  const walletCanShowPartialValue = !walletHasCompleteValuation
    && walletPartialValue != null
    && Number.isFinite(Number(walletPartialValue))
    && (Number(walletPartialValue) > 0 || walletUnpricedAssets.length === 0);
  const walletBalanceText = walletHasCompleteValuation
    ? money(wallet.available_balance_usd)
    : walletCanShowPartialValue ? money(walletPartialValue) : "Valuation unavailable";
  const walletBalanceCaption = walletHasCompleteValuation
    ? "≈ " + number(wallet.available_balance_usd) + " USD available"
    : walletCanShowPartialValue
      ? "Partial value of priced assets" + (walletUnpricedAssets.length ? " · unpriced: " + walletUnpricedAssets.join(", ") : "")
      : walletUnpricedAssets.length
        ? "No verified USD quote for: " + walletUnpricedAssets.join(", ")
        : "Portfolio valuation unavailable";

  const walletUnpricedReceivedAssets = Array.isArray(wallet.unpriced_received_assets) ? wallet.unpriced_received_assets : [];
  const walletPartialReceived = wallet.partial_total_received_usd;
  const walletCanShowPartialReceived = wallet.total_received_usd == null
    && walletPartialReceived != null
    && Number.isFinite(Number(walletPartialReceived))
    && (Number(walletPartialReceived) > 0 || walletUnpricedReceivedAssets.length === 0);
  const noRecordedReceipts = wallet.received_transaction_count === 0;
  const walletReceivedText = wallet.total_received_usd != null
    ? money(wallet.total_received_usd)
    : noRecordedReceipts ? money(0) : walletCanShowPartialReceived ? money(walletPartialReceived) : "Valuation unavailable";
  const walletReceivedStatus = wallet.total_received_usd != null
    ? "Current quote valuation"
    : noRecordedReceipts ? "No recorded receipts" : walletCanShowPartialReceived ? "Partial valuation" : "Valuation incomplete";
  const walletReceivedSource = noRecordedReceipts
    ? "No received transactions recorded for this wallet"
    : walletUnpricedReceivedAssets.length
      ? "Excludes unpriced receipts: " + walletUnpricedReceivedAssets.join(", ")
      : "Current quotes applied to recorded wallet receipts";

  const walletUnpricedSentAssets = Array.isArray(wallet.unpriced_sent_assets) ? wallet.unpriced_sent_assets : [];
  const walletPartialSent = wallet.partial_total_sent_usd;
  const walletCanShowPartialSent = wallet.total_sent_usd == null
    && walletPartialSent != null
    && Number.isFinite(Number(walletPartialSent))
    && (Number(walletPartialSent) > 0 || walletUnpricedSentAssets.length === 0);
  const noRecordedSends = wallet.sent_transaction_count === 0;
  const walletSentText = wallet.total_sent_usd != null
    ? money(wallet.total_sent_usd)
    : noRecordedSends ? money(0) : walletCanShowPartialSent ? money(walletPartialSent) : "Valuation unavailable";
  const walletSentStatus = wallet.total_sent_usd != null
    ? "Current quote valuation"
    : noRecordedSends ? "No recorded sends" : walletCanShowPartialSent ? "Partial valuation" : "Valuation incomplete";
  const walletSentSource = noRecordedSends
    ? "No sent or withdrawal transactions recorded for this wallet"
    : walletUnpricedSentAssets.length
      ? "Excludes unpriced sends: " + walletUnpricedSentAssets.join(", ")
      : "Current quotes applied to recorded wallet sends";

  if (!accessToken && showLogin) {
    return (<div className="ww-auth-shell"><div className="ww-auth-glow ww-auth-glow-a"/><div className="ww-auth-glow ww-auth-glow-b"/>
      <header className="ww-auth-top ww-auth-top-compact"><div className="ww-auth-brand"><img className="ww-shield-logo" src="/world-wallet-ai-logo.svg" alt="" /><b>WORLD WALLET <em>AI</em></b></div><button className="ww-auth-home" type="button" onClick={() => { setShowLogin(false); setLoginError(""); setAuthMessage(""); }}>← Back to home</button></header>
      <section className="ww-auth-layout"><div className="ww-auth-copy"><span className="ww-live-badge"><i/> THE INTELLIGENT DIGITAL WALLET</span><h1>Your Crypto.<br/><em>Your Freedom.</em></h1><p>Securely manage your available balance, digital assets and wallet activity from one intelligent dashboard, powered by BALMZ AI.</p><div className="ww-auth-points"><div><b>◈</b><span><strong>Multi-Chain Support</strong><small>Supported assets and networks in one workspace.</small></span></div><div><b>◇</b><span><strong>Secure &amp; Private</strong><small>Authenticated access with non-custodial wallet architecture.</small></span></div><div><b>✦</b><span><strong>AI-Powered Insights</strong><small>BALMZ AI helps interpret live wallet information.</small></span></div></div><div className="ww-auth-status"><i/> World Wallet AI • Production authentication</div></div>
      <form className="ww-auth-card" onSubmit={e => {e.preventDefault();if(registerMode)handleRegister();else if(passwordMode)handlePasswordSignIn();else requestEmailOtp()}}><div className="ww-auth-card-head"><div className="ww-auth-card-icon"><img src="/world-wallet-ai-logo.svg" alt="" /></div><div><small>{registerMode?"CREATE ACCOUNT":recoveryMode?"ACCOUNT RECOVERY":"SECURE ACCESS"}</small><h2>{registerMode?"Create your account":recoveryMode?"Recover access":"Welcome Back"}</h2><p>{registerMode?"Register for your World Wallet AI wallet.":recoveryMode?"Use a one-time code sent to your email.":"Sign in to your World Wallet AI account."}</p></div></div>
      {!registerMode&&!recoveryMode&&<div className="ww-auth-switch"><button type="button" className={passwordMode?"active":""} onClick={() => {setPasswordMode(true);setAuthMethod("email");setOtpRequested(false);setLoginError("");setAuthMessage("")}}>Password</button><button type="button" className={!passwordMode&&authMethod==="email"?"active":""} onClick={() => {setPasswordMode(false);setAuthMethod("email");setOtpRequested(false);setOtpCode("");setLoginError("");setAuthMessage("")}}>Email OTP</button><button type="button" className={authMethod==="google"?"active google-tab":""} onClick={() => {setAuthMethod("google");setPasswordMode(false);setLoginError("")}}>G&nbsp;&nbsp;Google</button><button type="button" className={authMethod==="github"?"active google-tab":""} onClick={() => {setAuthMethod("github");setPasswordMode(false);setLoginError("")}}>GitHub</button><button type="button" className={authMethod==="twitter"?"active google-tab":""} onClick={() => {setAuthMethod("twitter");setPasswordMode(false);setLoginError("")}}>𝕏&nbsp; X</button><button type="button" className={authMethod==="telegram"?"active google-tab":""} onClick={() => {setAuthMethod("telegram");setPasswordMode(false);setLoginError("")}}>✈ Telegram</button></div>}
      {registerMode?<div className="ww-auth-form"><label><span>Your name</span><div className="ww-field"><i>◉</i><input value={registerName} onChange={e=>setRegisterName(e.target.value)} placeholder="Full name" autoComplete="name" maxLength={100} required/></div></label><label><span>Phone number</span><div className="ww-field"><i>☎</i><input type="tel" value={registerPhone} onChange={e=>setRegisterPhone(e.target.value)} placeholder="+2348012345678" autoComplete="tel" inputMode="tel" maxLength={20} required/></div><small className="ww-phone-hint">Include your country code, e.g. +234 for Nigeria.</small></label><div className="ww-phone-verify-row"><button className="ww-text-link ww-phone-send-code" type="button" onClick={requestRegisterPhoneOtp} disabled={authBusy}>{authBusy?"Requesting code…":registerPhoneOtpSent?"Resend SMS code":"Send SMS verification code"}</button></div>{registerPhoneOtpSent&&<label><span>SMS verification code</span><div className="ww-field"><i>⌗</i><input type="text" value={registerPhoneOtp} onChange={e=>setRegisterPhoneOtp(e.target.value.replace(/\D/g,"").slice(0,10))} placeholder="Enter code from SMS" inputMode="numeric" autoComplete="one-time-code" maxLength={10} required/></div><small className="ww-phone-hint">Your account is created only after the server verifies this code.</small></label>}<label><span>Email address</span><div className="ww-field"><i>✉</i><input type="email" value={loginEmail} onChange={e=>setLoginEmail(e.target.value)} placeholder="Email address" autoComplete="email" required/></div></label><label><span>Password (at least 8 characters)</span><div className="ww-field ww-password-field"><i>⌑</i><input type={showPassword?"text":"password"} value={loginPassword} onChange={e=>setLoginPassword(e.target.value)} placeholder="Create a password" autoComplete="new-password" minLength={8} required/><button type="button" className="ww-password-toggle" onClick={()=>setShowPassword(v=>!v)} aria-label={showPassword?"Hide password":"Show password"}>{showPassword?"◉":"◌"}</button></div></label>{authMessage&&<div className="ww-auth-message">{authMessage}</div>}{loginError&&<div className="ww-auth-error"><b>!</b><span><strong>Registration failed</strong><small>{loginError}</small></span></div>}<button className="ww-auth-submit" type="submit" disabled={authBusy}>{authBusy?"Creating account…":"Create account"} <b>→</b></button><div className="ww-register-social"><span>Or create your account with</span><button type="button" onClick={()=>handleSocialSignIn("twitter")} disabled={authBusy}>𝕏&nbsp; Continue with X</button><button type="button" onClick={()=>handleSocialSignIn("telegram")} disabled={authBusy}>✈ Continue with Telegram</button><button type="button" onClick={()=>handleSocialSignIn("google")} disabled={authBusy}>G&nbsp; Continue with Google</button></div><button className="ww-text-link" type="button" onClick={()=>{setRegisterMode(false);setLoginError("");setAuthMessage("");setPasswordMode(true)}}>Already have an account? Sign in</button></div>:!recoveryMode&&["google","github","twitter","telegram"].includes(authMethod)?<div className="ww-auth-form"><button className={"ww-auth-submit ww-google-button ww-social-"+authMethod} type="button" onClick={() => handleSocialSignIn(authMethod)} disabled={authBusy}>{authBusy?"Connecting…":({github:"Continue with GitHub",twitter:"Continue with X",telegram:"Continue with Telegram",google:"Continue with Google"}[authMethod])}</button><p className="ww-auth-note"><span>✓</span> {({github:"GitHub sign-in requires GitHub to be enabled in Neon Auth.",twitter:"X sign-in requires the Twitter/X OAuth provider and credentials to be enabled in Neon Auth.",telegram:"Telegram sign-in requires a configured Telegram authentication provider and verified bot/domain integration.",google:"Google authentication is handled by Neon Auth."}[authMethod])}</p></div>:
      <div className="ww-auth-form"><label><span>Email address</span><div className="ww-field"><i>✉</i><input type="email" value={loginEmail} onChange={e=>setLoginEmail(e.target.value)} placeholder="Email address" autoComplete="email" required/></div></label>
      {recoveryMode?(otpRequested?<><label><span>6-digit code</span><div className="ww-field"><i>⌗</i><input inputMode="numeric" pattern="[0-9]{6}" maxLength="6" value={otpCode} onChange={e=>setOtpCode(e.target.value)} placeholder="000000" autoComplete="one-time-code" required/></div></label><button className="ww-auth-submit" type="button" onClick={verifyEmailOtp} disabled={authBusy||otpCode.length!==6}>Verify code &amp; sign in <b>→</b></button></>:<button className="ww-auth-submit" type="button" onClick={requestEmailOtp} disabled={authBusy}>Send recovery code <b>→</b></button>):
      passwordMode?<><label><span>Password</span><div className="ww-field ww-password-field"><i>⌑</i><input type={showPassword ? "text" : "password"} value={loginPassword} onChange={e=>setLoginPassword(e.target.value)} placeholder="Password" autoComplete="current-password" required/><button type="button" className="ww-password-toggle" onClick={() => setShowPassword(v => !v)} aria-label={showPassword ? "Hide password" : "Show password"} title={showPassword ? "Hide password" : "Show password"}>{showPassword ? "◉" : "◌"}</button></div></label><div className="ww-auth-options"><span>☑ Remember me</span><button type="button" onClick={() => {setRecoveryMode(true);setOtpRequested(false);setOtpCode("");setLoginError("")}}>Forgot password?</button></div><button className="ww-auth-submit" type="submit" disabled={authBusy}>{authBusy?"Signing in…":"Sign In"} <b>→</b></button><button className="ww-text-link" type="button" onClick={() => {setPasswordMode(false);setOtpRequested(false);setLoginError("")}}>Use email OTP instead</button></>:
      otpRequested?<><label><span>6-digit code</span><div className="ww-field"><i>⌗</i><input inputMode="numeric" pattern="[0-9]{6}" maxLength="6" value={otpCode} onChange={e=>setOtpCode(e.target.value)} placeholder="000000" autoComplete="one-time-code" required/></div></label><button className="ww-auth-submit" type="button" onClick={verifyEmailOtp} disabled={authBusy||otpCode.length!==6}>Verify &amp; enter wallet <b>→</b></button><button className="ww-text-link" type="button" onClick={requestEmailOtp} disabled={authBusy}>Send a new code</button></>:<><button className="ww-auth-submit" type="button" onClick={requestEmailOtp} disabled={authBusy}>Send secure code <b>→</b></button><button className="ww-text-link" type="button" onClick={() => setPasswordMode(true)}>Use email &amp; password</button></>}
      {recoveryMode&&<button className="ww-text-link" type="button" onClick={() => {setRecoveryMode(false);setOtpRequested(false);setOtpCode("");setLoginError("")}}>← Back to sign in</button>}
      {authMessage&&<div className="ww-auth-message">{authMessage}</div>}{loginError&&<div className="ww-auth-error"><b>!</b><span><strong>{registerMode?"Registration failed":recoveryMode?"Recovery failed":"Sign-in failed"}</strong><small>{loginError}</small></span></div>}<p className="ww-auth-note"><span>✓</span> Session verification is handled by Neon Auth and the World Wallet API.</p></div>}{!recoveryMode&&!registerMode&&<p className="ww-register-prompt">Don't have an account? <button type="button" onClick={()=>{setRegisterMode(true);setPasswordMode(true);setAuthMethod("email");setLoginError("");setAuthMessage("")}}>Register</button></p>}{!recoveryMode&&registerMode&&<p className="ww-register-prompt">Keep your password private and never share your recovery credentials.</p>}</form></section>
    </div>);
  }

  return (
    <div className={"app-shell" + (active === "Dashboard" && !selectedCoin ? " dashboard-shortcuts-active" : "") + (sidebarCollapsed ? " sidebar-collapsed" : "") + (mobileMenuOpen ? " mobile-menu-open" : "")}>
      {mobileMenuOpen && <button type="button" className="mobile-menu-scrim" aria-label="Close wallet navigation" onClick={() => setMobileMenuOpen(false)} />}
      <aside className={"sidebar" + (sidebarCollapsed ? " sidebar-is-collapsed" : "")}>
        <div className="brand">
          <button type="button" className="brand-mark brand-home-button" aria-label="World Wallet AI home and wallet navigation" title="Open wallet navigation" onClick={() => { setActive("Dashboard"); setSelectedCoin(null); if (window.matchMedia("(max-width: 760px)").matches) setMobileMenuOpen(current => !current); else setSidebarCollapsed(current => { const next = !current; try { localStorage.setItem("ww_sidebar_collapsed", String(next)); } catch {} return next; }); }}><img className="brand-mark-image" src="/world-wallet-ai-logo.svg" alt="" /></button>
          <div className="brand-copy"><strong>WORLD WALLET</strong><span>AI</span></div>
          <button type="button" className="sidebar-toggle" onClick={() => setSidebarCollapsed(current => { const next = !current; try { localStorage.setItem("ww_sidebar_collapsed", String(next)); } catch {} return next; })} aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}><span aria-hidden="true">⋯</span></button>
        </div>



        <nav>
          {Object.entries(nav).map(([group, items]) => (
            <div className="nav-group" key={group}>
              <small>{group}</small>
              {items.map(item => (
                <button key={item} className={active === item ? "nav-item active" : "nav-item"} aria-current={active === item ? "page" : undefined} onClick={() => {
                  // A selected coin or transaction detail must not trap navigation on its detail screen.
                  setSelectedCoin(null);
                  if (item !== "Transactions") setFocusedTransaction(null);
                  setActive(item);
                  if (window.matchMedia("(max-width: 760px)").matches) setMobileMenuOpen(false);
                }}>
                  <span className="nav-icon">{item.slice(0, 1)}</span><span className="nav-label">{item}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="secure"><span>✓</span><div><b>{user ? "Authenticated wallet" : "Wallet session"}</b><small>{user?.email || "Demo authentication"}</small></div></div>
          <button className="profile" onClick={() => setActive("Profile")}><span className="avatar">BA</span><div><b>{user?.name || "Wallet Owner"}</b><small>{localWalletEntries[0]?.walletId || user?.wallet_id || "View wallet profile"}</small></div><span>›</span></button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button type="button" className="mobile-brand" aria-label={mobileMenuOpen ? "Close wallet navigation" : "Open wallet navigation"} aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen(current => !current)}><span className="mobile-menu-glyph" aria-hidden="true">{mobileMenuOpen ? "×" : "☰"}</span><span className="mobile-brand-logo"><img className="ww-shield-logo" src="/world-wallet-ai-logo.svg" alt="" /></span><b>WORLD WALLET <span>AI</span></b></button>
          <div className="top-actions">
            {(active !== "Dashboard" || selectedCoin) && <button type="button" className="global-back-button" onClick={() => { setSelectedCoin(null); setActive("Dashboard"); }} aria-label="Back to dashboard" title="Back to dashboard">← <span>Back</span></button>}
            <button type="button" onClick={() => setActive("Browser")} className="top-browser-button">⌕ <span>Browser</span></button><div className="top-network-switch"><select aria-label="Select wallet environment" value={networkEnvironment(selectedNetwork)} onChange={event => changeNetworkEnvironment(event.target.value)}><option value="mainnet">Mainnet</option><option value="devnet">Devnet</option></select><select aria-label="Select blockchain network" value={selectedNetwork} onChange={event => changeSelectedNetwork(event.target.value)}>{["sepolia", "solana_devnet"].includes(normalizeNetworkId(selectedNetwork)) ? <><option value="solana_devnet">Solana Devnet</option><option value="sepolia">Ethereum Sepolia</option></> : <><option value="ethereum">Ethereum Mainnet</option><option value="bnb">BNB Chain Mainnet</option><option value="solana_mainnet">Solana Mainnet</option><option value="bitcoin">Bitcoin Mainnet</option></>}</select><button type="button" className="top-network-refresh" aria-label="Check selected network balance" title={selectedNetworkBalance ? Number(selectedNetworkBalance.balance).toLocaleString("en-US", { maximumFractionDigits: 8 }) + " " + selectedNetworkBalance.asset : selectedNetworkBalanceMessage || "Check selected network balance"} onClick={refreshSelectedNetworkBalance} disabled={selectedNetworkBalanceBusy}>{selectedNetworkBalanceBusy ? "…" : "↻"}</button></div><button>◐</button><button>◔</button><button className="logout-button" onClick={handleLogout}>↪ <span>Log out</span></button><button className="top-avatar" title="Open profile" onClick={() => setActive("Profile")}>{(user?.name || "BA").slice(0, 2).toUpperCase()}</button>
          </div>
        </header>
        <div className="mobile-network-switch-row" aria-label="Blockchain network selector">
          <label htmlFor="mobile-environment-select">ENVIRONMENT</label>
          <select id="mobile-environment-select" aria-label="Select wallet environment on mobile" value={networkEnvironment(selectedNetwork)} onChange={event => changeNetworkEnvironment(event.target.value)}>
            <option value="mainnet">Mainnet</option>
            <option value="devnet">Devnet</option>
          </select>
          <label htmlFor="mobile-network-select">NETWORK</label>
          <select id="mobile-network-select" aria-label="Select blockchain network on mobile" value={selectedNetwork} onChange={event => changeSelectedNetwork(event.target.value)}>
            {["sepolia", "solana_devnet"].includes(normalizeNetworkId(selectedNetwork)) ? <><option value="solana_devnet">Solana Devnet</option><option value="sepolia">Ethereum Sepolia</option></> : <><option value="ethereum">Ethereum Mainnet</option><option value="bnb">BNB Chain Mainnet</option><option value="solana_mainnet">Solana Mainnet</option><option value="bitcoin">Bitcoin Mainnet</option></>}
          </select>
          <button type="button" className="mobile-network-refresh" aria-label="Check selected network balance" title={selectedNetworkBalance ? Number(selectedNetworkBalance.balance).toLocaleString("en-US", { maximumFractionDigits: 8 }) + " " + selectedNetworkBalance.asset : selectedNetworkBalanceMessage || "Check selected network balance"} onClick={refreshSelectedNetworkBalance} disabled={selectedNetworkBalanceBusy}>{selectedNetworkBalanceBusy ? "…" : "↻"}</button>
        </div>
        {(!selectedNetworkBalanceBusy && !selectedNetworkBalance && selectedNetworkBalanceMessage && selectedNetworkBalanceMessage !== "Balance updated.") && <div className="network-balance-feedback network-balance-error" role="status" aria-live="polite">{selectedNetworkBalanceMessage}</div>}

        {active === "Dashboard" && !selectedCoin && <div className="dashboard-performance-logo" aria-label="World Wallet AI dashboard performance branding"><span className="dashboard-performance-orbit"><WorldGlobeLogo compact /></span><span className="dashboard-performance-copy"><strong>WORLD WALLET <em>AI</em></strong><small>WALLET PERFORMANCE</small></span></div>}

        {active === "BALMZ AI" ? <BalmzAI /> : active === "Gemini Integration" ? <GeminiIntegration accessToken={accessToken} apiBaseUrl={API_BASE_URL} /> : active === "GitHub Integration" ? <GitHubIntegration accessToken={accessToken} apiBaseUrl={API_BASE_URL} /> : selectedCoin ? (() => {
          const coin = walletCoinCatalogWithRegistry.find(c => c.symbol === selectedCoin);
          const live = assets.find(a => a.symbol === selectedCoin);
          const contractBasedBalmz = selectedCoin === "BALMZ" || selectedCoin === "BALMZ-SEP";
          const balanceKnown = Boolean(live && (!contractBasedBalmz || coin?.registry?.contract_address));
          const balance = balanceKnown ? Number(live?.balance || 0) : null;
          const value = live?.value_usd;
          const price = Number(live?.price_usd || marketPrices[selectedCoin]?.usd || 0);
          const solReferencePrice = selectedCoin === "BALMZ-SOL-DEVNET" ? Number(marketPrices.SOL?.usd || 0) : 0;
          const isSolanaDevnetBalmz = selectedCoin === "BALMZ-SOL-DEVNET";
          const change = isSolanaDevnetBalmz
            ? marketPrices.SOL?.usd_24h_change
            : live?.change_24h ?? marketPrices[selectedCoin]?.usd_24h_change;
          const rows = activity.filter(item => item.asset === selectedCoin || item.symbol === selectedCoin);
          return <section className="content coin-detail-page">
            <div className="page-heading">
              <div>
                <button className="back-btn" onClick={() => setSelectedCoin(null)}>← Back to wallet</button>
                <p className="eyebrow">ASSET DETAIL</p>
                <h1>{coin?.name || selectedCoin}</h1>
                <p className="muted">{selectedCoin} • {coin?.status || "Wallet asset"}</p>
              </div>
              <div className="page-actions">
                <button className="secondary" onClick={() => { setActive("Receive"); setSelectedCoin(null); }}>Receive</button>
                <button className="primary" onClick={() => { setActive("Send"); setSelectedCoin(null); }}>Send</button>
              </div>
            </div>
            <div className="coin-detail-grid">
              <article className="hero-card coin-detail-card">
                <div className="card-top"><span>AVAILABLE BALANCE</span><AssetIcon symbol={selectedCoin} fallback={coin?.icon || "•"} /></div>
                <div className="hero-balance">{balanceKnown ? number(balance) : "Unavailable"} <small>{selectedCoin}</small></div>
                <div className="balance-meta"><span>{contractBasedBalmz && !coin?.registry?.contract_address ? "Contract deployment pending; balance not yet verifiable" : live?.price_available === false || value == null ? "Wallet valuation unavailable" : `${money(value)} USD`}</span><b>{price ? `${money(price)} / coin` : selectedCoin === "BALMZ-SOL-DEVNET" && solReferencePrice > 0 ? "$" + money(solReferencePrice) + " SOL reference" : "Live price unavailable"}</b></div>
              </article>
              <article className="panel coin-stats">
                <div><small>{isSolanaDevnetBalmz ? "SOL reference 24h change" : "24h change"}</small><b>{change == null ? "—" : `${Number(change).toFixed(2)}%`}</b></div>
                <div><small>Wallet status</small><b>{live ? "Connected" : "Catalog only"}</b></div>
                <div><small>Network</small><b>{coin?.status || "—"}</b></div>
              </article>
            </div>
            <div className="coin-action-grid">
              <button onClick={() => { setActive("Receive"); setSelectedCoin(null); }}>Receive</button>
              <button onClick={() => { setActive("Send"); setSelectedCoin(null); }}>Send</button>
              <button onClick={() => { setActive("Swap"); setSelectedCoin(null); }}>Swap</button>
            </div>
            <article className="panel coin-trading-panel">
              <div className="panel-head"><div><h2>{selectedCoin} trading card</h2><span>Asset-specific market and execution details</span></div><span className="coin-trading-status">{price > 0 ? "Quote available" : "Quote unavailable"}</span></div>
              <div className="coin-trading-metrics">
                <div><small>Spot price</small><b>{price > 0 ? money(price) : "Not listed"}</b><span>{price > 0 ? "USD per " + selectedCoin : "No verified market quote"}</span></div>
                {selectedCoin === "BALMZ-SOL-DEVNET" && <div><small>SOL reference price</small><b>{solReferencePrice > 0 ? "$" + money(solReferencePrice) : "Unavailable"}</b><span>Live SOL/USD benchmark only; not a BALMZ market quote</span></div>}
                <div><small>{isSolanaDevnetBalmz ? "SOL reference 24-hour movement" : "24-hour movement"}</small><b className={change == null ? "neutral" : Number(change) >= 0 ? "positive" : "negative"}>{change == null ? "—" : (Number(change) >= 0 ? "+" : "") + Number(change).toFixed(2) + "%"}</b><span>{isSolanaDevnetBalmz ? "SOL market movement only; not BALMZ movement" : "Market-data provider quote"}</span></div>
                <div><small>Available balance</small><b>{balanceKnown ? number(balance) + " " + selectedCoin : "Unavailable"}</b><span>{contractBasedBalmz && !coin?.registry?.contract_address ? "Contract deployment pending; no on-chain balance can be read yet" : live?.price_available === false || value == null ? "Wallet valuation unavailable" : `${money(value)} reported value`}</span></div>
                <div><small>Network / execution</small><b>{coin?.status || "Network not configured"}</b><span>Review network and fee before signing</span></div>
              </div>
              <div className="coin-history-chart-panel" aria-label={selectedCoin + " 24-hour price chart"}>
                <div className="coin-history-chart-heading"><div><h3>{isSolanaDevnetBalmz ? "SOL reference price movement" : "24-hour price movement"}</h3><p>{isSolanaDevnetBalmz ? "Verified SOL market history · USD · not a BALMZ quote" : "Verified market history · USD"}</p></div><span className={change == null ? "neutral" : Number(change) >= 0 ? "positive" : "negative"}>{change == null ? "No movement data" : (Number(change) >= 0 ? "▲ " : "▼ ") + Math.abs(Number(change)).toFixed(2) + "% over 24h"}</span></div>
                {coinPriceHistoryLoading ? <div className="coin-history-chart-empty">Loading verified price history…</div>
                  : coinPriceHistory.length > 1 && coinPriceHistory.every(point => Number.isFinite(Number(point.price)) && Number(point.price) > 0) ? (() => {
                    const values = coinPriceHistory.map(point => Number(point.price));
                    const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
                    const coords = values.map((value, index) => ({ x: 4 + index * 392 / Math.max(values.length - 1, 1), y: 112 - ((value - min) / span) * 96 }));
                    const path = coords.map((point, index) => (index ? "L" : "M") + point.x.toFixed(2) + " " + point.y.toFixed(2)).join(" ");
                    const first = values[0], last = values[values.length - 1], trendUp = last >= first;
                    return <><svg className={"coin-history-chart " + (trendUp ? "trend-up" : "trend-down")} viewBox="0 0 400 120" role="img" aria-label={selectedCoin + " price " + (trendUp ? "trending up" : "trending down") + " over 24 hours"}><line x1="4" y1="16" x2="396" y2="16"/><line x1="4" y1="64" x2="396" y2="64"/><line x1="4" y1="112" x2="396" y2="112"/><path d={path}/></svg><div className="coin-history-chart-footer"><span>24h low {money(min)}</span><b className={trendUp ? "positive" : "negative"}>{trendUp ? "▲" : "▼"} {first > 0 && Number.isFinite((last-first)/first*100) ? ((last-first)/first*100).toFixed(2) : "—"}{first > 0 ? "%" : ""}</b><span>24h high {money(max)}</span></div></>;
                  })()
                  : <div className="coin-history-chart-empty">{selectedCoin === "BALMZ" || selectedCoin === "BALMZ-SEP" ? "No verified market chart exists for this token yet. Sepolia is a test network and does not imply a USD market price." : isSolanaDevnetBalmz ? (coinPriceHistoryError || "Verified SOL reference history is currently unavailable; no BALMZ market history is implied.") : coinPriceHistoryError || "No verified price history is available right now."}</div>}
              </div>
              {selectedCoin === "BALMZ" && Number(marketPrices.ETH?.usd) > 0 && <div className="balmz-eth-reference"><b>ETH reference price: {money(Number(marketPrices.ETH.usd))}</b><span>This is the current ETH market price for reference only. It is not a BALMZ token price or valuation.</span></div>}
              <div className="coin-trading-actions">
                <button className="secondary" onClick={() => { setActive("Receive"); setSelectedCoin(null); }}>Receive {selectedCoin}</button>
                <button className="secondary" onClick={() => { setActive("Send"); setSelectedCoin(null); }}>Send {selectedCoin}</button>
                <button className="primary" onClick={() => { setActive("Swap"); setSelectedCoin(null); }}>Open swap desk</button>
              </div>
              <p className="coin-trading-disclaimer">Execution requires a supported connected wallet, correct network, sufficient gas, and explicit wallet approval. A price quote alone does not execute a trade.</p>
            </article>
            <article className="panel">
              <div className="panel-head"><div><h2>{selectedCoin} activity</h2><span>Authenticated wallet records only</span></div><button className="text-btn" onClick={() => { setActive("Transactions"); setSelectedCoin(null); }}>All transactions →</button></div>
              {rows.length ? rows.map((item,i) => <button type="button" className="activity-row coin-history-clickable" key={item.id || item.tx_hash || i} onClick={() => { setFocusedTransaction(item); setSelectedCoin(null); setActive("Transactions"); }}><div><b>{item.type || item.direction || "Transaction"}</b><small>{item.status || "Recorded"} · View details ↗</small></div><strong>{item.amount || "—"} {selectedCoin}</strong></button>) : <div className="empty-state">No real {selectedCoin} transactions recorded yet.</div>}
            </article>
            <div className="coin-detail-note">Only authenticated wallet data is displayed. Catalog entries never create balances, prices, or transaction history.</div>
          </section>;
        })() : active === "Dashboard" ? (
          <section className="content">
            <div className="page-heading">
              <div><p className="eyebrow">OVERVIEW</p><h1>{active}</h1><p className="muted">Your global digital wallet, intelligently managed.</p></div>
              <div className="page-actions">
                <button className="primary" onClick={() => setActive("Send")}>+ Send funds</button>
              </div>
            </div>

            
            <div className="balance-grid">
              <article className="hero-card">
                <div className="card-top"><span>{selectedNetworkBalance ? (selectedNetwork === "solana_devnet" ? "SOLANA DEVNET BALANCE" : selectedNetwork === "solana_mainnet" ? "SOLANA MAINNET BALANCE" : selectedNetwork === "sepolia" ? "SEPOLIA BALANCE" : selectedNetwork === "bnb" ? "BNB CHAIN BALANCE" : selectedNetwork === "bitcoin" ? "BITCOIN BALANCE" : "ETHEREUM MAINNET BALANCE") : "AVAILABLE BALANCE"}</span><div className="balance-card-tools"><DashboardWalletPanel accessToken={accessToken} apiBaseUrl={API_BASE_URL} onWalletSwitched={async () => { await syncWallet(); await refreshSelectedNetworkBalance(true); }} /><button onClick={() => setShowBalance(!showBalance)} aria-label={showBalance ? "Hide balance" : "Show balance"}>{showBalance ? "◉" : "◎"}</button></div></div>
                <div className="hero-balance">{showBalance ? (selectedNetworkBalance ? number(selectedNetworkBalance.balance) : walletBalanceText) : "••••••••"} <small>{selectedNetworkBalance ? selectedNetworkBalance.asset : selectedNetworkBalanceMessage ? "" : "USD"}</small></div>
                <div className="balance-meta"><span>{!showBalance ? "Balance hidden" : selectedNetworkBalance ? (selectedNetwork === "solana_devnet" || selectedNetwork === "sepolia" ? "On-chain testnet balance · not USD" : "Live on-chain balance · token value shown separately") : selectedNetworkBalanceMessage || walletBalanceCaption}</span><b className="neutral">{selectedNetworkBalance ? (selectedNetworkBalance.syncedAt ? "Synced " + new Date(selectedNetworkBalance.syncedAt).toLocaleTimeString() : "On-chain balance") : wallet.change_24h == null ? "24h change unavailable" : Number(wallet.change_24h).toFixed(2) + "% 24h"}</b></div>

                <div className="card-actions"><button onClick={() => setActive("Send")}>↗ Send</button><button onClick={() => setActive("Receive")}>↙ Receive</button><button onClick={() => setActive("Swap")}>⇄ Swap</button></div>
              </article>
              <article className="stat-card"><span>Total received</span><strong>{walletReceivedText}</strong><b className="neutral">{walletReceivedStatus}</b><div className="stat-source">{walletReceivedSource}</div></article>
              <article className="stat-card"><span>Total sent</span><strong>{walletSentText}</strong><b className="neutral">{walletSentStatus} · {activity.length} recent transactions</b><div className="stat-source">{walletSentSource}</div></article>
              <article className="stat-card balmz-balance-card"><span>BALMZ · Ethereum Mainnet</span><strong>{assets.some(asset => asset.symbol === "BALMZ") ? number(assets.find(asset => asset.symbol === "BALMZ")?.balance || 0) : "—"} <small>BALMZ</small></strong><b className="neutral">{apiStatus === "error" ? "Last confirmed Mainnet data retained" : assets.some(asset => asset.symbol === "BALMZ") ? "Mainnet token balance" : "Not yet verified on Mainnet"}</b><div className="stat-source">Ethereum Mainnet only · no Devnet or Sepolia test tokens included.</div></article>
              <article className="stat-card"><span>BALMZ · Ethereum Sepolia (testnet)</span><strong>{assets.some(asset => asset.symbol === "BALMZ-SEP") ? number(assets.find(asset => asset.symbol === "BALMZ-SEP")?.balance || 0) : "—"} <small>BALMZ-SEP</small></strong><b className="neutral">Sepolia testnet only · excluded from Mainnet valuation.</b></article>
              <article className="stat-card"><span>BALMZ · Solana Devnet (testnet)</span><strong>{assets.some(asset => asset.symbol === "BALMZ-SOL-DEVNET") ? number(assets.find(asset => asset.symbol === "BALMZ-SOL-DEVNET")?.balance || 0) : "—"} <small>BALMZ</small></strong><b className="neutral">Solana Devnet only · excluded from Mainnet valuation.</b></article>
              <article className="stat-card"><span>Solana Mainnet SOL</span><strong>{assets.some(asset => asset.symbol === "SOL" && asset.network === "solana_mainnet") ? number(assets.find(asset => asset.symbol === "SOL" && asset.network === "solana_mainnet")?.balance || 0) : "—"} <small>SOL</small></strong><b className="neutral">Solana Mainnet only · production balance.</b></article>
              <article className="stat-card solana-devnet-balance-card"><span>Solana Devnet SOL (testnet)</span><strong>{assets.some(asset => asset.symbol === "SOL-DEVNET") ? number(assets.find(asset => asset.symbol === "SOL-DEVNET")?.balance || 0) : "—"} <small>SOL</small></strong><b className="neutral">Solana Devnet test SOL only · not Mainnet SOL · no USD valuation.</b></article>
            </div>


            <article className="panel market-prices-panel">
              <div className="panel-head">
                <div><h2>Live market prices</h2><span>Spot quotes from CoinGecko · refreshed every 60 seconds</span></div>
                <button type="button" className="text-btn" onClick={refreshMarketPrices} disabled={marketPricesLoading}>{marketPricesLoading ? "Refreshing…" : "↻ Refresh prices"}</button>
              </div>
              {marketPricesError && <div className="market-price-error" role="status" aria-live="polite"><strong>Price data warning:</strong> {marketPricesError}{marketPricesUpdatedAt && <> Last successful quote: {marketPricesUpdatedAt.toLocaleString()}.</>}</div>}
              <div className="market-price-grid">
                {["BTC","ETH","BNB","USDT","USDC","SOL","XRP","ADA","LTC","DOGE","BALMZ"].map(symbol => {
                  const quote = marketPrices[symbol] || {};
                  const hasPrice = quote.usd != null && Number.isFinite(Number(quote.usd)) && Number(quote.usd) > 0;
                  const change = quote.usd_24h_change == null ? null : Number(quote.usd_24h_change);
                  const coin = walletCoinCatalog.find(item => item.symbol === symbol) || {};
                  return <div className="market-price-item" key={symbol}>
                    <AssetIcon symbol={symbol} fallback={coin.icon || "•"} />
                    <div className="market-price-name"><b>{symbol}</b><small>{symbol === "BALMZ" ? "World Wallet token" : coin.name || symbol}</small></div>
                    <div className="market-price-value"><b>{hasPrice ? money(Number(quote.usd)) : symbol === "BALMZ" ? "Not listed" : marketPricesLoading && !marketPricesUpdatedAt ? "Loading…" : "Unavailable"}</b><small className={change == null ? "neutral" : change >= 0 ? "positive" : "negative"}>{change == null ? (symbol === "BALMZ" ? "No verified quote" : "24h change unavailable") : (change >= 0 ? "+" : "") + change.toFixed(2) + "% · 24h"}</small></div>
                  </div>;
                })}
              </div>
              <div className="coin-catalog-note">{marketPricesUpdatedAt ? "Last updated " + marketPricesUpdatedAt.toLocaleTimeString() : "Waiting for the first successful market response."} · BALMZ is intentionally unpriced until a verified market quote exists.</div>
            </article>

            <div className="dashboard-grid">
              <article className="panel chart-panel">
                <div className="panel-head">
                  <div><h2>Portfolio performance</h2><span>Recorded portfolio value over time</span></div>
                  <div className="ranges" role="group" aria-label="Portfolio performance period">
                    {["1D", "1W", "1M", "1Y"].map(period => <button key={period} type="button" className={performancePeriod === period ? "selected" : ""} aria-pressed={performancePeriod === period} onClick={() => setPerformancePeriod(period)}>{period}</button>)}
                  </div>
                </div>
                <div className="chart">
                  {performance.unavailable ? (
                    <div className="live-chart-empty">Portfolio performance history could not be loaded. Try again shortly.</div>
                  ) : performance.points.length > 1 ? (() => {
                    const values = performance.points.map(point => Number(point.value_usd)).filter(Number.isFinite);
                    if (values.length < 2) return <div className="live-chart-empty">Not enough verified snapshots to draw this period yet.</div>;
                    if (values.every(value => value === 0)) return <div className="live-chart-empty">All {values.length} recorded snapshots show a verified portfolio value of $0.00 for this period. Portfolio performance cannot be calculated until a positive verified balance is recorded. Devnet test tokens are excluded from Mainnet portfolio valuation.</div>;
                    const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
                    const coords = values.map((value, index) => ({ x: 20 + index * 560 / Math.max(values.length - 1, 1), y: 148 - ((value - min) / span) * 112 }));
                    const path = coords.map((point, index) => (index ? "L" : "M") + point.x.toFixed(2) + " " + point.y.toFixed(2)).join(" ");
                    const first = values[0], last = values[values.length - 1];
                    const change = first > 0 ? ((last - first) / first) * 100 : null;
                    return <div className="portfolio-performance-plot">
                      <svg className="portfolio-performance-svg" viewBox="0 0 600 170" role="img" aria-label={"Verified portfolio value history for " + performancePeriod}>
                        <line x1="20" y1="36" x2="580" y2="36" />
                        <line x1="20" y1="92" x2="580" y2="92" />
                        <line x1="20" y1="148" x2="580" y2="148" />
                        <path d={path} />
                        {coords.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={index === coords.length - 1 ? 4 : 2} />)}
                      </svg>
                      <div className="portfolio-performance-summary">
                        <span>Start <b>{money(first)}</b></span>
                        <span>End <b>{money(last)}</b></span>
                        <b className={change == null ? "neutral" : change >= 0 ? "positive" : "negative"}>{change == null ? "—" : (change >= 0 ? "+" : "") + change.toFixed(2) + "%"}</b>
                      </div>
                    </div>;
                  })() : performance.points.length === 1 ? (
                    <div className="live-chart-empty">First verified snapshot recorded at {performance.points[0].label || "the latest check"}. More snapshots are collected at 5-minute intervals while the dashboard is open.</div>
                  ) : (
                    <div className="live-chart-empty">No complete verified USD valuation is available for this period yet. History starts when a full valuation can be verified.</div>
                  )}
                </div>
                <div className="chart-foot"><span>Source: timestamped wallet snapshots</span><span>{performance.points.length} recorded point{performance.points.length === 1 ? "" : "s"}</span></div>
              </article>

              <article className="panel ai-panel">
                <div className="ai-title"><div className="ai-orb">✦</div><div><h2>BALMZ AI</h2><span>Your intelligent wallet assistant</span></div><b>LIVE</b></div>
                <div className="ai-message">{apiStatus === "error" ? "Wallet data could not be loaded from the API. Check the connection and refresh before drawing conclusions about balances." : assets.length === 0 ? "No wallet assets are available yet. Sync a configured production wallet to let BALMZ AI analyze live data." : wallet.available_balance_usd == null || wallet.valuation_complete === false ? "Wallet valuation is unavailable until all held assets have verified live prices." : Number(wallet.available_balance_usd) > 0 ? <>Your current available balance is <strong>{money(wallet.available_balance_usd)}</strong>. BALMZ AI can analyze the live asset mix and recent activity.</> : "Your wallet is authenticated, but no funded asset balance is currently recorded."}</div>
                <div className="ai-actions"><button>Run portfolio scan</button><button>Ask BALMZ AI</button></div>
                <div className="ai-input">Ask anything about your wallet... <span>↗</span></div>
              </article>

              <article className="panel assets-panel">
                <div className="panel-head">
                  <div><h2>Wallet coins & tokens</h2><span>{walletCoinCatalogWithRegistry.length} assets in catalog • {walletCoinCatalogWithRegistry.filter(c => c.connected).length} network-ready • {assets.filter(a => Number(a.balance || 0) !== 0).length} with balance</span></div>
                  <button className="text-btn" onClick={() => setActive("Portfolio")}>View portfolio →</button>
                </div>
                <div className="coin-toolbar">
                  <input value={coinSearch} onChange={e => setCoinSearch(e.target.value)} placeholder="Search coin or token…" aria-label="Search coins and tokens" />
                  <div className="coin-tabs">
                    <button className={coinFilter === "all" ? "active" : ""} onClick={() => setCoinFilter("all")}>All</button>
                    <button className={coinFilter === "held" ? "active" : ""} onClick={() => setCoinFilter("held")}>Held</button>
                  </div>
                </div>
                <div className="asset-list">{walletCoinCatalogWithRegistry
                  .filter(c => !coinSearch.trim() || `${c.symbol} ${c.name}`.toLowerCase().includes(coinSearch.trim().toLowerCase()))
                  .filter(c => coinFilter === "all" || Number((assets.find(a => a.symbol === c.symbol) || {}).balance || 0) !== 0)
                  .map(c => {
                    const live = assets.find(a => a.symbol === c.symbol);
                    const balance = live ? live.balance : 0;
                    const value = live?.value_usd;
                    const price = Number(live?.price_usd || c.price_usd || marketPrices[c.symbol]?.usd || 0);
                    const hasMarketPrice = price > 0;
                    const liveStatus = c.registry?.status === "pending_contract" ? "Contract pending" : live ? (Number(live.actual_balance || live.balance || 0) > 0 ? "Live balance" : "Connected • 0 balance") : c.connected ? "Network connected • 0 balance" : "Catalog only • live wallet not connected";
                    return <button type="button" className="asset-row asset-row-button" key={c.symbol} onClick={() => setSelectedCoin(c.symbol)}>
                      <AssetIcon symbol={c.symbol} fallback={c.icon || "•"} />
                      <div className="asset-name"><b>{c.symbol}</b><small>{c.name} • {live?.network_label || c.status || liveStatus}</small></div>
                      <div className="asset-balance"><b>{number(balance)} {c.symbol}</b><small>{hasMarketPrice ? `Price: ${money(price)}/coin${c.price_24h_change == null ? "" : ` • 24h ${Number(c.price_24h_change) >= 0 ? "+" : ""}${Number(c.price_24h_change).toFixed(2)}%`} • Wallet value: ${live?.price_available === false || value == null ? "unavailable" : money(value)}` : c.symbol === "BALMZ-SOL-DEVNET" ? `BALMZ market: Not listed • SOL reference: ${Number(marketPrices.SOL?.usd) > 0 ? "$" + money(marketPrices.SOL.usd) : "Unavailable"} • Wallet value: —` : c.symbol.startsWith("BALMZ") ? "Price: Not listed • Wallet value: —" : "Price: Unavailable • Wallet value: —"}</small></div>
                      <small className="asset-network">{c.status}</small>
                    </button>;
                  })}
                </div>
                <div className="coin-catalog-note">Market prices are refreshed from CoinGecko{marketPricesUpdatedAt ? ` • Updated ${marketPricesUpdatedAt.toLocaleTimeString()}` : ""}. Wallet values require a real connected balance. BALMZ stays unpriced until a verified market quote exists.</div>
              </article>

              <article className="panel activity-panel">
                <div className="panel-head"><div><h2>Recent activity</h2><span>Latest wallet events</span></div><button className="text-btn" onClick={() => setActive("Transactions")}>View all →</button></div>
                <div className="activity-list">{activity.map((a,i) => <div className="activity-row" key={i}><span className="activity-icon">{a.type[0].toUpperCase()}</span><div><b>{a.type}</b><small>{a.description}</small></div><div className="activity-value"><b className={a.amount.startsWith("+") ? "positive" : ""}>{a.amount}</b><small>{a.time}</small></div></div>)}</div>
              </article>
            </div>

            <article className="panel action-panel dashboard-connected-wallet">
              <div className="panel-head">
                <div><p className="feature-kicker">EXTERNAL WALLET</p><h2>{externalWalletConnection?.address ? "Connected wallet" : "Connect a wallet"}</h2><span>{externalWalletConnection?.address ? "Your selected WalletConnect account" : "Connect or switch to another wallet from your dashboard."}</span></div>
                <button className="primary" onClick={() => setActive("Wallet Connect")}>{externalWalletConnection?.address ? "⇄ Change wallet" : "Connect wallet →"}</button>
              </div>
              {externalWalletConnection?.address ? <div className="tool-row"><div><b>Public address</b><small>Chain ID: {externalWalletConnection.chainId ?? "Unknown"}</small></div><code>{externalWalletConnection.address}</code><button className="secondary" onClick={() => navigator.clipboard?.writeText(externalWalletConnection.address)}>Copy</button></div> : <div className="live-chart-empty">No external wallet selected yet. Use Connect wallet to choose one.</div>}
            </article>



            <div className="quick-grid">
              <button onClick={() => setActive("Browser")}><span>⌕</span><div><b>Open Browser</b><small>Search web &amp; explore Etherscan</small></div>→</button>
              <button onClick={() => setActive("Wallet Connect")}><span>◈</span><div><b>Connect wallet</b><small>Manage connected accounts</small></div>→</button>
              <button onClick={() => setActive("Withdraw")}><span>↗</span><div><b>Direct withdrawal</b><small>Move funds securely</small></div>→</button>
              <button onClick={() => setActive("Request Center")}><span>◎</span><div><b>Request funds</b><small>Create a payment request</small></div>→</button>
            </div>

            <article className="panel wallet-functions-panel">
              <div className="panel-head"><div><h2>All wallet functions</h2><span>Quick access to wallet, security, explorer, and account tools</span></div><span className="wallet-function-count">20 tools</span></div>
              <div className="wallet-functions-grid">
                {[
                  ["Wallets","◈","Create and manage wallets"],
                  ["Portfolio","▥","Assets and holdings"],
                  ["Send","↗","Send crypto assets"],
                  ["Receive","↙","Share a receiving address"],
                  ["Deposit","↓","Fund wallet and check deposit steps"],
                  ["Swap","⇄","Convert supported assets"],
                  ["Staking","⌁","Staking tools"],
                  ["NFTs","◇","NFT workspace"],
                  ["Transactions","↔","Transaction history"],
                  ["Browser","⌕","Search websites and explorers"],
                  ["Wallet Connect","⌘","Connected wallet addresses"],
                  ["Proof of Reserves","✓","On-chain reserve snapshot"],
                  ["API Request","⌘","API request workspace"],
                  ["API Keys","⚿","Manage API credentials"],
                  ["Contract Generator","⌁","Generate contract drafts"],
                  ["Verify Contract","✓","Verify deployed contracts"],
                  ["Address Converter","⇄","Inspect and compare addresses"],
                  ["Sepolia Converter","◇","Sepolia testnet tools"],
                  ["Contract Converter","⌁","Inspect contract data"],
                  ["Address Book","▤","Saved trusted addresses"],
                  ["Request Center","◎","Requests and support"],
                ].map(([page, icon, description]) => (
                  <button type="button" key={page} className="wallet-function-card" onClick={() => setActive(page)}>
                    <span className="wallet-function-icon">{icon}</span>
                    <span className="wallet-function-copy"><b>{page}</b><small>{description}</small></span>
                    <span className="wallet-function-arrow">›</span>
                  </button>
                ))}
              </div>
              <p className="wallet-functions-note">Proof of Reserves is an on-chain snapshot only; it is not an audited solvency report and does not include all customer liabilities.</p>
            </article>

            <div className="api-status">API: <strong>{apiStatus}</strong>{user ? <> • Signed in as <strong>{user.email}</strong></> : null}{syncMessage ? <> • {syncMessage}</> : null}{lastSyncedAt ? <> • Last sync {lastSyncedAt.toLocaleTimeString()}</> : null}</div>
            <section className="feature-content" style={{ paddingTop: 0 }}>
              <article className="panel action-panel">
                <div className="panel-head"><div><p className="feature-kicker">LOCAL WALLET VAULT</p><h2>Your wallets</h2><span>Generated wallet IDs and public addresses are saved in this browser.</span></div><button className="secondary" onClick={() => setActive("Wallets")}>Manage wallets →</button></div>
                {localWalletEntries.length ? localWalletEntries.slice(0,3).map(entry => <div className="tool-row" key={entry.walletId}><div><b>{entry.name || "Wallet"}</b><small>Wallet ID: {entry.walletId}</small><small>{entry.network || "EVM"} · {entry.address}</small></div><button className="secondary" onClick={() => navigator.clipboard?.writeText(entry.address)}>Copy address</button></div>) : <div className="live-chart-empty">No local signing wallet yet. Create one from Wallets to show its address here automatically.</div>}
                {localContracts.length > 0 && <><p className="feature-kicker" style={{ marginTop: 18 }}>SAVED CONTRACTS</p>{localContracts.slice(0,3).map(contract => <div className="tool-row" key={contract.address + contract.network}><div><b>{contract.name || contract.symbol || "Contract"} ({contract.network})</b><small>{contract.address}</small><small>{contract.status || "Saved locally"} · {contract.txHash || ""}</small></div><a href={contract.explorerUrl || (contract.network === "sepolia" ? "https://sepolia.etherscan.io/address/" : "https://etherscan.io/address/") + contract.address} target="_blank" rel="noreferrer">Verify / inspect ↗</a></div>)}</>}
              </article>
            </section>
                    </section>
        ) : (
          active === "Profile" ? <section className="content feature-content ww-profile-page">
            <div className="page-heading"><div><p className="eyebrow">ACCOUNT CENTER</p><h1>My Profile</h1><p className="muted">Your World Wallet AI identity, connected sign-in methods and wallet records.</p></div><button className="secondary" onClick={() => setActive("Wallets")}>Manage wallets →</button></div>
            <article className="panel ww-profile-hero"><div className="ww-profile-avatar">{String(user?.name || user?.email || "W").trim().charAt(0).toUpperCase()}</div><div className="ww-profile-identity"><p className="eyebrow">WORLD WALLET AI ACCOUNT</p><h2>{user?.name || user?.displayName || "Wallet Owner"}</h2><p>{user?.email || "Email not provided by sign-in provider"}</p><small>Account ID: <code>{user?.id || user?.userId || "Available after account sync"}</code></small></div><span className="ww-profile-status">● Signed in</span></article>
            <div className="feature-grid ww-profile-grid">
              <article className="panel action-panel"><h2>Sign-in & linked accounts</h2><p className="muted">Use the provider you originally registered with to return to this account. Social providers must be enabled in Neon Auth before login can complete.</p><div className="ww-profile-provider"><b>Google</b><span>{user?.email ? "Account email available" : "Not confirmed"}</span></div><div className="ww-profile-provider"><div><b>X (Twitter)</b><span>OAuth 2.0 server setup required</span></div><button className="secondary" type="button" onClick={() => handleSocialSignIn("twitter")}>Connect X</button></div><div className="ww-profile-provider"><div><b>Telegram</b><span>Bot verification and server session setup required</span></div><button className="secondary" type="button" onClick={() => handleSocialSignIn("telegram")}>Connect Telegram</button></div>{loginError&&<div className="feature-error" role="status">{loginError}</div>}</article>
              <article className="panel action-panel"><h2>Wallet identity</h2><p className="muted">Wallets are separate from your social sign-in account.</p>{localWalletEntries.length ? localWalletEntries.map(entry => <div className="ww-profile-wallet" key={entry.walletId}><b>{entry.name || "Wallet"}</b><small>Wallet ID</small><code>{entry.walletId || "Not assigned"}</code><small>Public address</small><code>{entry.address || "Not connected"}</code><div className="ww-profile-actions"><button className="secondary" onClick={() => navigator.clipboard?.writeText(entry.walletId || "")}>Copy wallet ID</button><button className="secondary" onClick={() => navigator.clipboard?.writeText(entry.address || "")}>Copy address</button></div></div>) : <div className="live-chart-empty">No wallet profile yet. Create a wallet in Wallets and its ID will appear here automatically.</div>}<button className="primary feature-submit" onClick={() => setActive("Wallets")}>Create or manage wallet →</button></article>
              <article className="panel action-panel"><h2>Saved contract addresses</h2>{localContracts.length ? localContracts.map(contract => <div className="tool-row" key={contract.address + contract.network}><div><b>{contract.name || contract.symbol || "Contract"} · {contract.network}</b><small>Contract: <code>{contract.address}</code></small><small>Status: {contract.status || "Saved locally"} · Tx: {contract.txHash || "Not recorded"}</small></div><a href={contract.explorerUrl || (contract.network === "sepolia" ? "https://sepolia.etherscan.io/address/" : "https://etherscan.io/address/") + contract.address} target="_blank" rel="noreferrer">Inspect / verify ↗</a></div>) : <div className="live-chart-empty">No deployed contracts saved in this browser yet.</div>}<div className="ww-profile-actions"><button className="secondary" onClick={() => setActive("Contract Generator")}>Contract generator</button><button className="secondary" onClick={() => setActive("Verify Contract")}>Verify contract</button></div></article>
              <article className="panel action-panel"><h2>Security & session</h2><p className="security-note">Your sign-in session is handled by Neon Auth. Private keys and recovery phrases are never shown in this profile or uploaded to the server. Signing out ends the app session on this device.</p><button className="ww-profile-logout" type="button" onClick={handleLogout}>↪ Log out of World Wallet AI</button></article>
            </div>
          </section> : active === "Browser" ? <BrowserPage onNavigateLogin={() => setShowLogin(true)} /> : <Suspense fallback={<div className="feature-loading" role="status">Loading wallet tools…</div>}>
          <FeaturePage selectedAsset={selectedCoin} selectedCoin={selectedCoin} setSelectedCoin={setSelectedCoin} walletCoinCatalog={walletCoinCatalogWithRegistry} marketPrices={marketPrices} marketPricesUpdatedAt={marketPricesUpdatedAt} marketPricesError={marketPricesError} marketPricesLoading={marketPricesLoading} refreshMarketPrices={refreshMarketPrices} focusedTransaction={focusedTransaction} setFocusedTransaction={setFocusedTransaction} active={active} wallet={wallet} walletBalanceText={walletBalanceText} walletBalanceCaption={walletBalanceCaption} unpricedAssets={walletUnpricedAssets} walletRefreshMessage={syncMessage} syncedBalanceAssets={syncedBalanceAssets} assets={assets} activity={activity} accessToken={accessToken} apiBaseUrl={API_BASE_URL} setActive={setActive} onWalletUpdated={(data) => { if (data?.wallet) { const incomingWalletId = data.wallet.wallet_id || data.wallet.id; const activeWalletId = wallet?.wallet_id || wallet?.id; if (incomingWalletId && activeWalletId && incomingWalletId !== activeWalletId) setSyncedBalanceAssets([]); setWallet(data.wallet); } if (data?.assets) setAssets((data.assets || []).map(asset => ({ ...asset, icon: asset.symbol.startsWith("BALMZ") ? "B" : asset.symbol === "USDT" ? "$" : asset.symbol === "ETH" ? "Ξ" : asset.symbol === "BNB" ? "◆" : "•" }))); if (Array.isArray(data?.updates)) setSyncedBalanceAssets([...new Set(data.updates.map(item => String(item?.asset || "").trim().toUpperCase()).filter(Boolean))]); }} onTransactionsUpdated={(transactions) => setActivity((transactions || []).map(tx => ({
            id: tx.id,
            type: tx.type,
            asset: tx.asset || tx.symbol || "",
            symbol: tx.asset || tx.symbol || "",
            from_address: tx.from_address || tx.from || null,
            to_address: tx.to_address || tx.to || null,
            network: tx.network,
            token_contract_address: tx.token_contract_address || tx.contract_address || null,
            description: `${tx.asset} • ${tx.description}`,
            amount: `${Number(tx.amount) >= 0 ? "+" : ""}${Number(tx.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 })} ${tx.asset}`,
            raw_amount: Number(tx.amount),
            time: tx.time,
            status: tx.status,
            tx_hash: tx.tx_hash,
            confirmations: Number(tx.confirmations || 0),
            block_height: tx.block_height,
          }))) } />
          </Suspense>
        )}

        {active === "Dashboard" && !selectedCoin && (
          <>
            {showDashboardMore && (
              <div className="dashboard-more-backdrop" onClick={() => setShowDashboardMore(false)}>
                <section className="dashboard-more-sheet" aria-label="More wallet shortcuts" onClick={event => event.stopPropagation()}>
                  <div className="dashboard-more-heading"><div><small>WALLET SHORTCUTS</small><h2>More</h2></div><button type="button" aria-label="Close more shortcuts" onClick={() => setShowDashboardMore(false)}>×</button></div>
                  <div className="dashboard-more-grid">
                    {[
                      ["Wallets", "◈", "Manage wallets"],
                      ["Portfolio", "▥", "Assets and holdings"],
                      ["Transactions", "↔", "Transaction history"],
                      ["Proof of Reserves", "✓", "Reserve snapshot"],
                      ["Browser", "⌕", "Search websites and explorers"],
                      ["Wallet Connect", "⌘", "Connected addresses"],
                      ["Address Converter", "⇄", "Compare addresses"],
                      ["Sepolia Converter", "◇", "Sepolia testnet"],
                      ["Contract Converter", "⌁", "Inspect contract"],
                      ["Support Center", "?", "Help and support"],
                    ].map(([page, icon, description]) => (
                      <button type="button" key={page} onClick={() => { setActive(page); setShowDashboardMore(false); }}>
                        <span>{icon}</span><div><b>{page}</b><small>{description}</small></div><i>›</i>
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            )}
            <nav className="dashboard-bottom-nav" aria-label="Dashboard shortcuts">
              <button type="button" className="dashboard-tab active" aria-current="page" onClick={() => { setActive("Dashboard"); setShowDashboardMore(false); }}>
                <span className="dashboard-tab-icon">⌂</span><small>Home</small>
              </button>
              <button type="button" className="dashboard-tab" onClick={() => { setActive("Deposit"); setShowDashboardMore(false); }}>
                <span className="dashboard-tab-icon">↓</span><small>Deposit</small>
              </button>
              <button type="button" className="dashboard-tab" onClick={() => { setActive("Withdraw"); setShowDashboardMore(false); }}>
                <span className="dashboard-tab-icon">↑</span><small>Withdrawal</small>
              </button>
              <button type="button" className="dashboard-tab" onClick={() => { setActive("Swap"); setShowDashboardMore(false); }}>
                <span className="dashboard-tab-icon">⇄</span><small>Convert</small>
              </button>
              <button type="button" className="dashboard-tab" onClick={() => { setActive("Profile"); setShowDashboardMore(false); }}>
                <span className="dashboard-tab-icon">◎</span><small>Profile</small>
              </button>
              <button type="button" className={"dashboard-tab" + (showDashboardMore ? " selected" : "")} aria-expanded={showDashboardMore} onClick={() => setShowDashboardMore(value => !value)}>
                <span className="dashboard-tab-icon">•••</span><small>More</small>
              </button>
            </nav>
          </>
        )}
      </main>
    </div>
  );
}

export default App;