import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import "./Web3Dashboard.css";
import { NAVIGATION_ICONS, ROOT_SHORTCUTS, WALLET_NAVIGATION } from "./navigation.js";
const FeaturePage = lazy(() => import("./FeaturePage.jsx"));
import { authClient, getNeonAccessToken } from "./auth-client.js";
import { isUsableNeonAccessToken } from "./neon-token.js";
import { defaultNetworkForEnvironment, networkEnvironment, normalizeNetworkId, readSelectedNetwork } from "./network-selection.js";
import { indexVerifiedBalances } from "./verified-balances.js";
import BrowserPage from "./BrowserPage.jsx";
import DashboardWalletPanel from "./DashboardWalletPanel.jsx";
import BalmzAI from "./BalmzAI.jsx";

function WorldGlobeLogo({ compact = false }) {
  return <img className={compact ? "ww-world-logo ww-world-logo-compact" : "ww-world-logo"}
    src="/world-wallet-ai-logo.svg" alt="World Wallet AI gold W shield logo" />;
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "https://world-wallet-ai-backend.onrender.com").replace(/\/$/, "");
const TOKEN_KEY = "world_wallet_access_token";

const fallbackAssets = [];
const fallbackWallet = { available_balance_usd: null, actual_balance_usd: null, reserved_balance_usd: null, total_received_usd: null, total_sent_usd: null, profit_usd: null, change_24h: null, valuation_complete: false };
const fallbackActivity = [];
const walletCoinCatalog = [
  { symbol: "BALMZ", name: "BALMZ Token", icon: "B", status: "Ethereum Mainnet" },
  { symbol: "BALMZ-BNB", name: "BALMZ Token (BNB Chain)", icon: "B", status: "BNB Chain Mainnet" },
  { symbol: "BALMZ-SOL", name: "BALMZ Token (Solana Mainnet)", icon: "B", status: "Solana Mainnet" },
  { symbol: "BALMZ-SEP", name: "BALMZ Token (Sepolia)", icon: "B", status: "Sepolia testnet only" },
  { symbol: "BALMZ-SOL-DEVNET", name: "BALMZ Token (Solana Devnet)", icon: "B", status: "Solana Devnet • testnet only" },
  { symbol: "BTC", name: "Bitcoin", icon: "₿", status: "Bitcoin" },
  { symbol: "ETH", name: "Ethereum", icon: "Ξ", status: "Ethereum" },
  { symbol: "USDT", name: "Tether USD", icon: "$", status: "Ethereum Mainnet" },
  { symbol: "USDT-BNB", name: "Tether USD (BNB Chain)", icon: "$", status: "BNB Chain Mainnet" },
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

function AssetIcon({ symbol, fallback = "•", logoUrl: registryLogoUrl = "" }) {
  const normalizedSymbol = String(symbol || "").trim().toUpperCase();
  const safeRegistryLogoUrl = /^https:\/\//i.test(String(registryLogoUrl || "").trim())
    ? String(registryLogoUrl).trim()
    : "";
  const logoUrl = safeRegistryLogoUrl || (normalizedSymbol.startsWith("BALMZ")
    ? BALMZ_LOGO_URL
    : ASSET_LOGO_URLS[normalizedSymbol]);
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
        <div><span style={muted}>Model</span><div style={{ fontWeight: 700, marginTop: 5 }}>{status?.model || "gemini-3.8-flash"}</div></div>
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
  const [rootSearch, setRootSearch] = useState("");
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
      const bnbMainnetContract = records.find(t => t.network === "bnb" && t.contract_address && t.status === "active");
      const sepoliaContract = records.find(t => t.network === "sepolia" && t.contract_address && t.status === "active");
      const solanaMainnetContract = records.find(t => t.network === "solana_mainnet" && t.contract_address && t.status === "active");
      const quote = marketPrices[coin.symbol] || {};
      return {
        ...coin,
        status: coin.symbol === "BALMZ"
          ? (mainnetContract ? "Ethereum Mainnet • contract verified" : "Ethereum Mainnet • deployment pending")
          : coin.symbol === "BALMZ-BNB"
            ? (bnbMainnetContract ? "BNB Chain Mainnet • contract verified" : "BNB Chain Mainnet • deployment pending")
            : coin.symbol === "BALMZ-SEP"
              ? (sepoliaContract ? "Ethereum Sepolia • contract registered • testnet" : "Ethereum Sepolia • deployment pending • testnet")
              : coin.symbol === "BALMZ-SOL"
                ? (solanaMainnetContract ? "Solana Mainnet • mint verified" : "Solana Mainnet • mint pending verification")
                : coin.status,
        registry: liveRecord || mainnetContract || bnbMainnetContract || sepoliaContract || solanaMainnetContract || records[0] || null,
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
  const [tokenMetadata, setTokenMetadata] = useState(null);
  useEffect(() => {
    const selected = walletCoinCatalogWithRegistry.find(item => item.symbol === selectedCoin);
    const metadataUrl = String(selected?.registry?.metadata_url || "").trim();
    if (selectedCoin !== "BALMZ-SOL-DEVNET" || !metadataUrl) {
      setTokenMetadata(null);
      return undefined;
    }
    let cancelled = false;
    let safeUrl = "";
    try {
      const parsed = new URL(metadataUrl);
      if (parsed.protocol === "https:" && parsed.hostname === "raw.githubusercontent.com") safeUrl = parsed.toString();
    } catch {}
    if (!safeUrl) {
      setTokenMetadata(null);
      return undefined;
    }
    fetch(safeUrl, { cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("Metadata document unavailable");
        const data = await response.json();
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid token metadata document");
        const imageUrl = String(data.image || "").trim();
        let safeImage = "";
        try {
          const image = new URL(imageUrl);
          if (image.protocol === "https:" && image.hostname === "raw.githubusercontent.com") safeImage = image.toString();
        } catch {}
        if (!cancelled) setTokenMetadata({
          name: typeof data.name === "string" ? data.name.slice(0, 100) : "",
          symbol: typeof data.symbol === "string" ? data.symbol.slice(0, 24) : "",
          description: typeof data.description === "string" ? data.description.slice(0, 500) : "",
          image: safeImage,
        });
      })
      .catch(() => { if (!cancelled) setTokenMetadata(null); });
    return () => { cancelled = true; };
  }, [selectedCoin, walletCoinCatalogWithRegistry]);
  const [apiStatus, setApiStatus] = useState("loading");
  const [walletAnnouncement, setWalletAnnouncement] = useState(null);
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
  const [selectedNetworkBalance, setSelectedNetworkBalance] = useState(null);
  const [selectedNetworkBalanceMessage, setSelectedNetworkBalanceMessage] = useState("");
  useEffect(() => {
    if (!selectedNetworkBalance || !Number.isFinite(Number(selectedNetworkBalance.balance))) return;
    try { localStorage.setItem("world_wallet_last_confirmed_network_balance_v1", JSON.stringify(selectedNetworkBalance)); } catch {}
  }, [selectedNetworkBalance]);
  const [selectedNetworkBalanceBusy, setSelectedNetworkBalanceBusy] = useState(false);
  const [balanceVerificationReport, setBalanceVerificationReport] = useState(null);
  const [balanceVerificationError, setBalanceVerificationError] = useState("");
  const [balanceVerificationBusy, setBalanceVerificationBusy] = useState(false);
  const verifiedBalancesByAsset = useMemo(
    () => indexVerifiedBalances(balanceVerificationReport),
    [balanceVerificationReport],
  );
  const lastSyncedBalanceByAsset = useMemo(() => {
    const result = new Map();
    for (const item of balanceVerificationReport?.assets || []) {
      if (item?.verified === true && item.available_balance != null && Number.isFinite(Number(item.available_balance))) {
        result.set(String(item.asset || "").toUpperCase(), item);
      }
    }
    return result;
  }, [balanceVerificationReport]);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [liveWallet, setLiveWallet] = useState({ status: "checking", mode: "read_only", addresses: [], networks: [], message: "" });
  const [networkStatus, setNetworkStatus] = useState({});
  const [user, setUser] = useState(null);
  const accountUserId = String(user?.id || user?.userId || user?.user_id || user?.sub || "");
  const activeWalletServerId = String(wallet?.wallet_id || wallet?.id || "");
  const visibleLocalWalletEntries = accountUserId ? localWalletEntries.filter(entry => entry.ownerUserId
    ? String(entry.ownerUserId) === accountUserId
    : String(entry.serverWalletId || entry.walletId || "") === activeWalletServerId && Boolean(activeWalletServerId)) : [];
  const [accessToken, setAccessToken] = useState("");
  const [pinGateOpen, setPinGateOpen] = useState(false);
  const [pendingPinToken, setPendingPinToken] = useState("");
  const [pendingPinUser, setPendingPinUser] = useState(null);
  const [pinGateMode, setPinGateMode] = useState("verify");
  const [pinInput, setPinInput] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [pinRecoveryCode, setPinRecoveryCode] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinBusy, setPinBusy] = useState(false);
  useEffect(() => {
    if (!accessToken) { setWalletAnnouncement(null); return undefined; }
    let cancelled = false;
    fetch(API_BASE_URL + "/api/v1/announcement", { headers: { Authorization: "Bearer " + accessToken }, cache: "no-store" })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Announcement unavailable");
        if (!cancelled) setWalletAnnouncement(data.announcement || null);
      })
      .catch(() => { if (!cancelled) setWalletAnnouncement(null); });
    return () => { cancelled = true; };
  }, [accessToken]);
  const [authRestoring, setAuthRestoring] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState("off");
  const [showRefreshMenu, setShowRefreshMenu] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [registerName, setRegisterName] = useState("");
  const [registerMode, setRegisterMode] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [passwordMode, setPasswordMode] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [otpRequested, setOtpRequested] = useState(false);
  const [registrationVerificationPending, setRegistrationVerificationPending] = useState(false);
  const [passwordResetToken, setPasswordResetToken] = useState(() => new URLSearchParams(window.location.search).get("token") || "");
  const [resetPassword, setResetPassword] = useState("");
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(() => Boolean(new URLSearchParams(window.location.search).get("token")));
  async function beginSecurityPinGate(token, signedInUser = null) {
    if (typeof token !== "string" || !token.trim()) throw new Error("Secure account session is invalid.");
    const response = await fetch(API_BASE_URL + "/api/v1/security/pin/status", {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "Wallet PIN security could not be checked.");
    setPendingPinToken(token);
    setPendingPinUser(signedInUser);
    setPinGateMode(data.pin_configured ? "verify" : "setup");
    setPinInput("");
    setPinConfirm("");
    setPinRecoveryCode("");
    setPinError("");
    setPinGateOpen(true);
    setShowLogin(false);
    setAuthRestoring(false);
  }

  function completeSecurityPinGate(pinSessionToken) {
    if (typeof pinSessionToken !== "string" || !pinSessionToken.startsWith("wwpin_")) {
      setPinError("The backend did not issue a valid second-factor session. Please retry.");
      return;
    }
    try { localStorage.setItem(TOKEN_KEY, pinSessionToken); }
    catch { setPinError("Secure session storage is unavailable on this device."); return; }
    if (pendingPinUser) setUser(pendingPinUser);
    setAccessToken(pinSessionToken);
    setActive("Dashboard");
    setPinGateOpen(false);
    setPendingPinToken("");
    setPendingPinUser(null);
    setPinInput("");
    setPinConfirm("");
    setPinRecoveryCode("");
    setPinError("");
    setShowLogin(false);
  }

  async function submitSecurityPin() {
    setPinError("");
    setPinBusy(true);
    try {
      if (!/^\d{6}$/.test(pinInput)) throw new Error("Enter exactly six digits.");
      if (pinGateMode === "setup" && pinInput !== pinConfirm) throw new Error("The two PIN entries do not match.");
      if (pinGateMode === "recovery") {
        if (!/^\d{6}$/.test(pinRecoveryCode)) throw new Error("Enter the six-digit code from the Super Admin mailbox.");
        if (pinInput !== pinConfirm) throw new Error("The new PIN entries do not match.");
      }
      const endpoint = pinGateMode === "setup"
        ? "/api/v1/security/pin/enroll"
        : pinGateMode === "recovery"
          ? "/api/v1/security/pin/recovery/complete"
          : "/api/v1/security/pin/verify";
      const body = pinGateMode === "recovery"
        ? { code: pinRecoveryCode, new_pin: pinInput }
        : { pin: pinInput };
      const response = await fetch(API_BASE_URL + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + pendingPinToken },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Wallet PIN verification failed.");
      completeSecurityPinGate(data.access_token);
    } catch (error) {
      setPinError(error.message || "Wallet PIN verification failed.");
      setPinInput("");
      if (pinGateMode === "recovery") setPinRecoveryCode("");
    } finally {
      setPinBusy(false);
    }
  }

  async function requestSecurityPinRecovery() {
    setPinError("");
    setPinBusy(true);
    try {
      const response = await fetch(API_BASE_URL + "/api/v1/security/pin/recovery/request", {
        method: "POST",
        headers: { Authorization: "Bearer " + pendingPinToken },
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Could not request Super Admin recovery.");
      setPinGateMode("recovery");
      setPinInput("");
      setPinConfirm("");
      setPinRecoveryCode("");
      setPinError("A recovery code was sent only to the configured Super Admin Gmail. Ask the administrator to verify your identity and provide approval.");
    } catch (error) {
      setPinError(error.message || "Could not request Super Admin recovery.");
    } finally {
      setPinBusy(false);
    }
  }

  async function cancelSecurityPinGate() {
    try { await authClient.signOut(); } catch {}
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
    setPendingPinToken("");
    setPendingPinUser(null);
    setPinGateOpen(false);
    setPinInput("");
    setPinConfirm("");
    setPinRecoveryCode("");
    setPinError("");
    setShowLogin(true);
  }

  const [showLogin, setShowLogin] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("token") || params.has("password_reset") || params.has("error")) return true;
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

      if (pinGateOpen && pendingPinToken) {
        if (!cancelled) setAuthRestoring(false);
        return;
      }

      if (persistedToken.startsWith("wwpin_")) {
        try {
          const response = await fetch(API_BASE_URL + "/api/v1/security/pin/session", {
            headers: { Authorization: "Bearer " + persistedToken, Accept: "application/json" },
            cache: "no-store",
          });
          const data = await response.json().catch(() => ({}));
          if (response.ok && data.active) {
            if (!cancelled) {
              setAccessToken(persistedToken);
              if (data.user) setUser(data.user);
              setShowLogin(false);
              setAuthRestoring(false);
            }
            return;
          }
        } catch {}
        try { localStorage.removeItem(TOKEN_KEY); } catch {}
        persistedToken = "";
      }

      if (persistedToken && isUsableNeonAccessToken(persistedToken)) {
        if (accessToken === persistedToken) {
          if (!cancelled) setAuthRestoring(false);
          return;
        }
        if (!cancelled) {
          try {
            await beginSecurityPinGate(persistedToken, null);
          } catch (error) {
            localStorage.removeItem(TOKEN_KEY);
            setShowLogin(true);
            setLoginError(error.message || "Wallet PIN security could not be restored. Please sign in again.");
          }
          setAuthRestoring(false);
        }
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

      if (neonSessionUser || socialReturn) {
        for (let attempt = 0; attempt < 12 && !cancelled; attempt += 1) {
          try {
            // After Google's top-level OAuth redirect the SDK's React session
            // can be empty even while the Neon Auth cookie is valid. Exchange
            // that cookie directly for the backend JWT before deciding sign-in failed.
            const token = await getNeonAccessToken({ forceRefresh: true });
            if (token) {
              await beginSecurityPinGate(token, neonSessionUser);
              try { sessionStorage.removeItem("world_wallet_google_return"); } catch {}
              try { sessionStorage.removeItem("world_wallet_social_return"); } catch {}
              if (!cancelled) setAuthRestoring(false);
              if (window.location.search) {
                const params = new URLSearchParams(window.location.search);
                params.delete("auth_callback");
                params.delete("password_reset");
                const next = params.toString();
                window.history.replaceState({}, document.title, window.location.pathname + (next ? "?" + next : "") + window.location.hash);
              }
              return;
            }
          } catch (error) {
            if (attempt === 11 && !cancelled) setLoginError(error.message || "Google session could not be exchanged for a secure wallet session.");
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
  }, [sessionState.isPending, neonSessionUser, accessToken, pinGateOpen, pendingPinToken]);

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
                reference: tx.reference, tx_hash: tx.tx_hash, confirmations: tx.confirmations, block_height: tx.block_height,
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
        if (response.status === 401 && !accessToken.startsWith("wwpin_")) {
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
          reference: tx.reference,
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
          raw_amount: Number(tx.amount), time: tx.time, status: tx.status, reference: tx.reference, tx_hash: tx.tx_hash,
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
      setBalanceVerificationReport(null);
      setBalanceVerificationError("");
      setBalanceVerificationBusy(false);
      return undefined;
    }
    let cancelled = false;
    const activeWalletIdForReport = String(wallet?.wallet_id || wallet?.id || "");
    setBalanceVerificationReport(current =>
      current && String(current.wallet_id || "") === activeWalletIdForReport ? current : null
    );
    setBalanceVerificationBusy(true);
    setBalanceVerificationError("");
    fetch(API_BASE_URL + "/api/v1/wallet/balance-verification", {
      headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" },
      cache: "no-store",
    })
      .then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "Verified Mainnet balances could not be loaded.");
        if (!Array.isArray(data.assets)) throw new Error("Balance verification returned an invalid asset report.");
        if (!cancelled) setBalanceVerificationReport(data);
      })
      .catch(error => {
        if (!cancelled) {
          setBalanceVerificationReport(null);
          setBalanceVerificationError(error.message || "Verified balance service unavailable.");
        }
      })
      .finally(() => {
        if (!cancelled) setBalanceVerificationBusy(false);
      });
    return () => { cancelled = true; };
  }, [accessToken, wallet?.wallet_id, wallet?.id]);

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

  async function authorizedWalletFetch(url, options = {}) {
    let token = accessToken.startsWith("wwpin_") ? accessToken : "";
    if (!token) {
      try { token = await getNeonAccessToken({ forceRefresh: true }) || ""; } catch {}
    }
    token = token || accessToken || "";
    const request = currentToken => fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...(currentToken ? { Authorization: "Bearer " + currentToken } : {}),
      },
      cache: "no-store",
    });
    let response = await request(token);
    if (response.status === 401 && !token.startsWith("wwpin_")) {
      let refreshed = "";
      try { refreshed = await getNeonAccessToken({ forceRefresh: true }) || ""; } catch {}
      if (refreshed && refreshed !== token) {
        token = refreshed;
        response = await request(token);
      }
    }
    return response;
  }

  async function loadDashboardAddresses() {
    if (!accessToken) return;
    try {
      const response = await authorizedWalletFetch(API_BASE_URL + "/api/v1/wallet/addresses");
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
      const response = await authorizedWalletFetch(API_BASE_URL + "/api/v1/wallets/" + encodeURIComponent(walletId) + "/addresses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      if (response.status === 401 && !token.startsWith("wwpin_")) {
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
      const mainnetNativeSymbols = {
        ethereum: "ETH",
        bnb: "BNB",
        bitcoin: "BTC",
        solana_mainnet: "SOL",
      };
      const mainnetAsset = mainnetNativeSymbols[normalizedSelectedNetwork];
      if (mainnetAsset) {
        const activeWalletId = String(wallet?.wallet_id || wallet?.id || user?.wallet_id || "");
        let report = !forceAddressRefresh &&
          balanceVerificationReport &&
          String(balanceVerificationReport.wallet_id || "") === activeWalletId
          ? balanceVerificationReport
          : null;
        if (!report) {
          const verificationResponse = await authorizedFetch(API_BASE_URL + "/api/v1/wallet/balance-verification");
          const verificationData = await verificationResponse.json().catch(() => ({}));
          if (!verificationResponse.ok) throw new Error(verificationData.detail || "Verified Mainnet balance check failed.");
          report = verificationData;
          setBalanceVerificationReport(verificationData);
          setBalanceVerificationError("");
        }
        const observation = (report.assets || []).find(item =>
          String(item.asset || "").toUpperCase() === mainnetAsset &&
          normalizeNetworkId(item.network) === normalizedSelectedNetwork
        );
        if (!observation || observation.verified !== true || observation.available_balance == null) {
          throw new Error(observation?.note || "No ownership-verified Mainnet balance is available for this network.");
        }
        const aggregateBalance = Number(observation.available_balance);
        if (!Number.isFinite(aggregateBalance) || aggregateBalance < 0) {
          throw new Error("The verified balance service returned an invalid amount.");
        }
        if (requestId !== balanceRequestIdRef.current || normalizeNetworkId(selectedNetwork) !== requestedNetwork) return;
        const firstAddress = observation.address_balances?.[0]?.address || "";
        setSelectedNetworkAddress(firstAddress);
        setSelectedNetworkBalance({
          network: normalizedSelectedNetwork,
          balance: aggregateBalance,
          asset: mainnetAsset,
          address: firstAddress,
          addresses_checked: Number(observation.addresses_checked || 0),
          ownership_verified: true,
          verified: true,
          syncedAt: observation.observed_at,
        });
        setSelectedNetworkBalanceMessage("Verified aggregate balance across " + Number(observation.addresses_checked || 0) + " owned address(es).");
        return;
      }
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
      const matches = currentAddresses.filter(item =>
        normalizeNetwork(item.network) === normalizedSelectedNetwork &&
        item.ownership_verified === true
      );
      const chosen = matches.find(item => item.address === selectedNetworkAddress) || matches[0];
      if (!chosen) throw new Error("No ownership-verified address is attached for " + (({ ethereum: "Ethereum Mainnet", sepolia: "Ethereum Sepolia (Testnet)", bnb: "BNB Chain", bitcoin: "Bitcoin", solana_mainnet: "Solana Mainnet", solana_devnet: "Solana Devnet (Testnet)" })[selectedNetwork] || selectedNetwork) + ". Open Wallets, attach the correct public address and complete its signature verification.");
      if (requestId !== balanceRequestIdRef.current || normalizeNetworkId(selectedNetwork) !== requestedNetwork) return;
      if (selectedNetworkAddress !== chosen.address) setSelectedNetworkAddress(chosen.address);
      const query = new URLSearchParams({ network: normalizedSelectedNetwork, address: chosen.address });
      const response = await authorizedFetch(API_BASE_URL + "/api/v1/wallets/" + encodeURIComponent(walletId) + "/addresses/balance?" + query.toString());
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || ("Balance request failed (HTTP " + response.status + ")."));
      const balance = Number(data.balance);
      if (!Number.isFinite(balance) || balance < 0) throw new Error("The API returned an invalid balance.");
      if (requestId !== balanceRequestIdRef.current || normalizeNetworkId(selectedNetwork) !== requestedNetwork) return;
      setSelectedNetworkBalance({ network: normalizedSelectedNetwork, balance, asset: data.asset || normalizedSelectedNetwork, address: chosen.address, ownership_verified: true, verified: true, syncedAt: data.synced_at });
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
      const response = await authorizedWalletFetch(API_BASE_URL + "/api/v1/wallet/refresh", {
        method: "POST",
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
        reference: tx.reference,
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
      await beginSecurityPinGate(data.access_token, data.user || null);
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

  async function handleRegister() {
    setLoginError("");
    setAuthMessage("");
    setAuthBusy(true);
    try {
      const name = registerName.trim();
      const email = loginEmail.trim().toLowerCase();
      if (!name) throw new Error("Enter your name.");
      if (!email) throw new Error("Enter your email address.");
      if (loginPassword.length < 8) throw new Error("Use a password with at least 8 characters.");
      const response = await fetch(API_BASE_URL + "/api/v1/auth/neon/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password: loginPassword }),
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to create your account.");
      setLoginPassword("");
      if (data.access_token) {
        await beginSecurityPinGate(data.access_token, data.user || null);
        setRegisterMode(false);
      } else if (data.verification_required) {
        setRegistrationVerificationPending(true);
        setOtpCode("");
        setAuthMessage(data.message || "Enter the verification code sent to your email.");
      } else {
        setRegisterMode(false);
        setPasswordMode(true);
        setAuthMessage(data.message || "Registration submitted. Check your email to continue.");
      }
    } catch (error) {
      setLoginError(error.message || "Unable to create your account.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function verifyRegistrationEmail() {
    setLoginError("");
    setAuthBusy(true);
    try {
      const email = loginEmail.trim().toLowerCase();
      if (!email) throw new Error("Enter your email address.");
      if (!/^\d{4,12}$/.test(otpCode.trim())) throw new Error("Enter the verification code from your email.");
      const response = await fetch(API_BASE_URL + "/api/v1/auth/neon/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, otp: otpCode.trim() }),
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Email verification failed.");
      if (!data.access_token) throw new Error("Neon Auth did not return a secure wallet session after verification.");
      await beginSecurityPinGate(data.access_token, data.user || null);
      setRegistrationVerificationPending(false);
      setRegisterMode(false);
      setOtpCode("");
      setAuthMessage("");
    } catch (error) {
      setLoginError(error.message || "Unable to verify your email.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function resendRegistrationVerification() {
    setLoginError("");
    setAuthBusy(true);
    try {
      const email = loginEmail.trim().toLowerCase();
      if (!email) throw new Error("Enter your email address.");
      const response = await fetch(API_BASE_URL + "/api/v1/auth/neon/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to resend the verification code.");
      setAuthMessage(data.message || "A new verification code has been sent.");
    } catch (error) {
      setLoginError(error.message || "Unable to resend the verification code.");
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

      // Use one authenticated backend relay for both desktop and mobile. This
      // avoids a browser SDK cookie/JWT race and returns a JWT the API verifies.
      const relayResponse = await fetch(API_BASE_URL + "/api/v1/auth/neon/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: loginPassword }),
        cache: "no-store",
      });
      const relayData = await relayResponse.json().catch(() => ({}));
      if (!relayResponse.ok) throw new Error(relayData.detail || "Email or password was not accepted.");
      const token = relayData.access_token || "";
      if (!isUsableNeonAccessToken(token)) {
        throw new Error("Neon Auth did not return a valid secure wallet session. Please retry.");
      }

      await beginSecurityPinGate(token, relayData.user || null);
      setLoginPassword("");
      setPasswordMode(false);
      setAuthMessage("");
    } catch (error) {
      setLoginError(error.message || "Unable to sign in with password");
    } finally {
      setAuthBusy(false);
    }
  }

  async function requestPasswordReset() {
    setLoginError("");
    setAuthMessage("");
    setAuthBusy(true);
    try {
      const email = loginEmail.trim().toLowerCase();
      if (!email) throw new Error("Enter your Gmail address first.");
      const response = await fetch(API_BASE_URL + "/api/v1/auth/neon/password/reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Could not request the password setup link.");
      setAuthMessage(data.message || "If the account exists, a password setup link will be sent.");
    } catch (error) {
      setLoginError(error.message || "Unable to request a password setup link.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function completePasswordReset() {
    setLoginError("");
    setAuthMessage("");
    setAuthBusy(true);
    try {
      if (!passwordResetToken) throw new Error("The password setup link is missing or expired. Request a new one.");
      if (resetPassword.length < 8) throw new Error("Use a password with at least 8 characters.");
      if (resetPassword !== resetPasswordConfirm) throw new Error("The two password entries do not match.");
      const response = await fetch(API_BASE_URL + "/api/v1/auth/neon/password/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: passwordResetToken, new_password: resetPassword }),
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Password setup link is invalid or expired.");
      const email = loginEmail.trim().toLowerCase();
      if (!email) throw new Error("Password was updated. Enter your Gmail address to sign in.");
      const signInResponse = await fetch(API_BASE_URL + "/api/v1/auth/neon/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: resetPassword }),
        cache: "no-store",
      });
      const signedIn = await signInResponse.json().catch(() => ({}));
      if (!signInResponse.ok || !isUsableNeonAccessToken(signedIn.access_token || "")) {
        throw new Error("Password updated, but automatic sign-in did not complete. Sign in with the new password.");
      }
      await beginSecurityPinGate(signedIn.access_token, signedIn.user || null);
      setPasswordResetToken("");
      setResetPassword("");
      setResetPasswordConfirm("");
      const params = new URLSearchParams(window.location.search);
      params.delete("token");
      params.delete("password_reset");
      params.delete("error");
      const rest = params.toString();
      window.history.replaceState({}, document.title, window.location.pathname + (rest ? "?" + rest : "") + window.location.hash);
    } catch (error) {
      setLoginError(error.message || "Password setup failed.");
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
      await beginSecurityPinGate(data.access_token, data.user || null);
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
      // Production Neon Auth currently trusts the Render frontend origin.
      // Keep OAuth callbacks on that same origin so desktop browser returns do
      // not land on an untrusted domain; localhost remains available in dev.
      const callbackOrigin = ["localhost", "127.0.0.1"].includes(window.location.hostname)
        ? window.location.origin
        : "https://world-wallet-ai-frontend.onrender.com";
      const result = await authClient.signIn.social({
        provider,
        callbackURL: callbackOrigin + "/?auth_callback=" + encodeURIComponent(provider),
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
      if (accessToken) {
        await fetch(API_BASE_URL + "/api/v1/security/pin/lock", {
          method: "POST",
          headers: { Authorization: "Bearer " + accessToken },
          cache: "no-store",
        });
      }
    } catch {}
    try {
      await authClient.signOut();
    } catch {
      // Clear the local application session even if the remote sign-out request fails.
    }
    localStorage.removeItem(TOKEN_KEY);
    setAccessToken("");
    setUser(null);
  }

  const nav = WALLET_NAVIGATION;
  const filteredNav = useMemo(() => {
    const query = rootSearch.trim().toLocaleLowerCase();
    if (!query) return Object.entries(nav);
    return Object.entries(nav).map(([group, items]) => [
      group,
      items.filter(item => item.toLocaleLowerCase().includes(query) || group.toLocaleLowerCase().includes(query))
    ]).filter(([, items]) => items.length > 0);
  }, [nav, rootSearch]);

  function navigateFromRoot(page) {
    setSelectedCoin(null);
    if (page !== "Transactions") setFocusedTransaction(null);
    setActive(page);
    setRootSearch("");
    setMobileMenuOpen(false);
  }

  if (pinGateOpen) {
    return (
      <div className="ww-auth-shell">
        <div className="ww-auth-glow ww-auth-glow-a" /><div className="ww-auth-glow ww-auth-glow-b" />
        <header className="ww-auth-top ww-auth-top-compact">
          <div className="ww-auth-brand"><img className="ww-shield-logo" src="/world-wallet-ai-logo.svg" alt="" /><b>WORLD WALLET <em>AI</em></b></div>
          <button className="ww-auth-home" type="button" onClick={cancelSecurityPinGate}>Sign out</button>
        </header>
        <section className="ww-auth-layout">
          <div className="ww-auth-copy">
            <span className="ww-live-badge"><i /> WALLET SECURITY</span>
            <h1>Your wallet.<br /><em>Your PIN.</em></h1>
            <p>Your account password or approved sign-in is the first identity check. This six-digit PIN is the additional wallet unlock required before balances, reserves and transfers are available.</p>
            <div className="ww-auth-points">
              <div><b>01</b><span><strong>Six-digit PIN</strong><small>Stored as a salted server-side hash.</small></span></div>
              <div><b>02</b><span><strong>Attempt protection</strong><small>Five failed attempts trigger a 15-minute lock.</small></span></div>
              <div><b>03</b><span><strong>Admin-only recovery</strong><small>Recovery codes are delivered only to Super Admin Gmail.</small></span></div>
            </div>
          </div>
          <form className="ww-auth-card" onSubmit={event => { event.preventDefault(); void submitSecurityPin(); }}>
            <div className="ww-auth-card-head">
              <div className="ww-auth-card-icon"><img src="/world-wallet-ai-logo.svg" alt="" /></div>
              <div>
                <small>SECOND FACTOR</small>
                <h2>{pinGateMode === "setup" ? "Create login PIN" : pinGateMode === "recovery" ? "Recover wallet PIN" : "Unlock your wallet"}</h2>
                <p>{pinGateMode === "setup" ? "The first PIN you choose becomes this account’s six-digit wallet login PIN." : pinGateMode === "recovery" ? "Enter the one-time code approved by the Super Admin and choose a new PIN." : "Enter your six-digit PIN to unlock the authenticated wallet session."}</p>
              </div>
            </div>
            {pinGateMode === "recovery" && <label><span>Super Admin recovery code</span><div className="ww-field"><i>⌗</i><input type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={pinRecoveryCode} onChange={event => setPinRecoveryCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6-digit admin code" required /></div></label>}
            <label><span>{pinGateMode === "setup" ? "Create six-digit PIN" : pinGateMode === "recovery" ? "New six-digit PIN" : "Six-digit login PIN"}</span>
              <div className="ww-field"><i>⌑</i><input type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={pinInput} onChange={event => setPinInput(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="••••••" required /></div>
            </label>
            {(pinGateMode === "setup" || pinGateMode === "recovery") && <label><span>Confirm six-digit PIN</span>
              <div className="ww-field"><i>⌑</i><input type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={pinConfirm} onChange={event => setPinConfirm(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="Enter PIN again" required /></div>
            </label>}
            {pinError && <div className={/sent only|approval/i.test(pinError) ? "ww-auth-message" : "ww-auth-error"} role="status">{pinError}</div>}
            <button className="ww-auth-submit" type="submit" disabled={pinBusy || pinInput.length !== 6 || ((pinGateMode === "setup" || pinGateMode === "recovery") && pinConfirm.length !== 6) || (pinGateMode === "recovery" && pinRecoveryCode.length !== 6)}>
              {pinBusy ? "Checking security…" : pinGateMode === "setup" ? "Save login PIN" : pinGateMode === "recovery" ? "Reset PIN & unlock" : "Unlock World Wallet AI"} <b>→</b>
            </button>
            {pinGateMode === "verify" && <button className="ww-text-link" type="button" onClick={() => void requestSecurityPinRecovery()} disabled={pinBusy}>Forgot PIN? Request Super Admin recovery</button>}
            {pinGateMode === "recovery" && <button className="ww-text-link" type="button" onClick={() => { setPinGateMode("verify"); setPinInput(""); setPinConfirm(""); setPinRecoveryCode(""); setPinError(""); }}>← Back to PIN entry</button>}
            <p className="ww-auth-note"><span>✓</span> A recovery code is sent only to the configured Super Admin Gmail. The account email does not receive this PIN recovery code.</p>
          </form>
        </section>
      </div>
    );
  }

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
  const verifiedValuationRows = (balanceVerificationReport?.assets || []).filter(item =>
    item?.verified === true && item.available_balance != null && Number.isFinite(Number(item.available_balance))
  );
  const verifiedPricedRows = verifiedValuationRows.filter(item =>
    Number(marketPrices[String(item.asset || "").replace(/-BNB$/, "")]?.usd || 0) > 0
  );
  const verifiedValuationUnpricedRows = verifiedValuationRows.filter(item =>
    Number(item.available_balance) > 0 &&
    !(Number(marketPrices[String(item.asset || "").replace(/-BNB$/, "")]?.usd || 0) > 0)
  );
  const unverifiedLedgerHoldings = (balanceVerificationReport?.assets || []).filter(item =>
    item?.verified !== true && Number(item?.ledger_available_balance || 0) > 0
  );
  const walletPartialValue = verifiedPricedRows.reduce((total, item) => {
    const baseSymbol = String(item.asset || "").replace(/-BNB$/, "");
    const price = Number(marketPrices[baseSymbol]?.usd || 0);
    return total + Number(item.available_balance) * price;
  }, 0);
  const walletHasCompleteValuation = Boolean(balanceVerificationReport)
    && balanceVerificationReport.status === "verified"
    && wallet.valuation_complete !== false
    && verifiedValuationRows.length > 0
    && verifiedPricedRows.length === verifiedValuationRows.length
    && verifiedValuationUnpricedRows.length === 0
    && unverifiedLedgerHoldings.length === 0;
  const walletCanShowPartialValue = !walletHasCompleteValuation
    && verifiedPricedRows.length > 0
    && Number.isFinite(Number(walletPartialValue))
    && (walletPartialValue > 0 || verifiedPricedRows.every(item => Number(item.available_balance) === 0));
  const walletBalanceText = walletHasCompleteValuation || walletCanShowPartialValue
    ? money(walletPartialValue)
    : "Valuation unavailable";
  const walletBalanceCaption = walletHasCompleteValuation
    ? "≈ " + number(walletPartialValue) + " USD · chain-verified available balances"
    : walletCanShowPartialValue
      ? "Partial USD value of chain-verified, priced assets only · unsupported or unverified assets excluded"
      : balanceVerificationBusy ? "Checking verified Mainnet balances…"
        : balanceVerificationError || "Portfolio valuation unavailable until a chain balance and market quote can be verified";

  const traceAddressRows = dashboardAddresses.length
    ? dashboardAddresses
    : Object.entries(balanceVerificationReport?.attached_addresses_detail || {}).flatMap(([network, rows]) =>
      (rows || []).map(item => ({ ...item, network }))
    );
  const traceNetworkLabels = {
    ethereum: "Ethereum Mainnet",
    bnb: "BNB Chain Mainnet",
    bitcoin: "Bitcoin Mainnet",
    solana_mainnet: "Solana Mainnet",
    sepolia: "Ethereum Sepolia (testnet)",
    solana_devnet: "Solana Devnet (testnet)",
  };
  const traceReportedSymbols = new Set((balanceVerificationReport?.assets || []).map(item => String(item.asset || "").toUpperCase()));
  const traceAssetRows = [
    ...(balanceVerificationReport?.assets || []),
    ...walletCoinCatalogWithRegistry
      .filter(item => !traceReportedSymbols.has(String(item.symbol || "").toUpperCase()))
      .map(item => {
        const symbol = String(item.symbol || "").toUpperCase();
        const notes = {
          ADA: "Cardano CIP-30 address, ownership proof, balance and history adapter is not configured.",
          XRP: "XRP Ledger address, ownership proof, balance and history adapter is not configured.",
          LTC: "Litecoin address, ownership proof, balance and history adapter is not configured.",
          DOGE: "Dogecoin address, ownership proof, balance and history adapter is not configured.",
          USDC: "No active verified USDC token contract is configured for this wallet network.",
          "BALMZ-SOL": "Solana Mainnet BALMZ mint is not configured or could not be verified.",
          "BALMZ-SEP": "Sepolia is a testnet and is excluded from the Mainnet balance report.",
          "BALMZ-SOL-DEVNET": "Solana Devnet is a testnet and is excluded from the Mainnet balance report.",
          BALMZ: "Ethereum Mainnet BALMZ contract is not configured or could not be verified.",
          "BALMZ-BNB": "BNB Chain BALMZ contract is not configured or could not be verified.",
        };
        return {
          asset: symbol,
          name: item.name,
          network: null,
          network_label: item.status || "Network adapter unavailable",
          status: "unavailable_unverified",
          verified: false,
          available_balance: null,
          chain_balance: null,
          contract_address: item.registry?.contract_address || null,
          note: notes[symbol] || "No active contract/mint and ownership-verified chain reader is available for this asset.",
          source: null,
          addresses_checked: 0,
        };
      }),
  ];

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
      <form className="ww-auth-card" onSubmit={e => {e.preventDefault();if(registerMode)handleRegister();else if(passwordMode)handlePasswordSignIn();else requestEmailOtp()}}><div className="ww-auth-card-head"><div className="ww-auth-card-icon"><img src="/world-wallet-ai-logo.svg" alt="" /></div><div><small>{registerMode?"CREATE ACCOUNT":recoveryMode?"ACCOUNT RECOVERY":"SECURE ACCESS"}</small><h2>{registerMode?"Create your account":recoveryMode?"Recover access":"Welcome Back"}</h2><p>{registerMode?"Register for your World Wallet AI wallet.":recoveryMode?"Use the secure link sent to your registered Gmail account to set or reset your password.":"Sign in to your World Wallet AI account."}</p></div></div>
      {!registerMode&&!recoveryMode&&<div className="ww-auth-switch"><button type="button" className={passwordMode?"active":""} onClick={() => {setPasswordMode(true);setAuthMethod("email");setOtpRequested(false);setLoginError("");setAuthMessage("")}}>Password</button><button type="button" className={!passwordMode&&authMethod==="email"?"active":""} onClick={() => {setPasswordMode(false);setAuthMethod("email");setOtpRequested(false);setOtpCode("");setLoginError("");setAuthMessage("")}}>Email OTP</button><button type="button" className={authMethod==="google"?"active google-tab":""} onClick={() => {setAuthMethod("google");setPasswordMode(false);setLoginError("")}}>G&nbsp;&nbsp;Google</button><button type="button" className={authMethod==="github"?"active google-tab":""} onClick={() => {setAuthMethod("github");setPasswordMode(false);setLoginError("")}}>GitHub</button><button type="button" className={authMethod==="twitter"?"active google-tab":""} onClick={() => {setAuthMethod("twitter");setPasswordMode(false);setLoginError("")}}>𝕏&nbsp; X</button><button type="button" className={authMethod==="telegram"?"active google-tab":""} onClick={() => {setAuthMethod("telegram");setPasswordMode(false);setLoginError("")}}>✈ Telegram</button></div>}
      {registerMode?(registrationVerificationPending?<div className="ww-auth-form"><label><span>Email verification code</span><div className="ww-field"><i>⌗</i><input inputMode="numeric" maxLength="12" value={otpCode} onChange={e=>setOtpCode(e.target.value.replace(/\D/g,"").slice(0,12))} placeholder="Enter the code sent to your email" autoComplete="one-time-code" required/></div></label>{authMessage&&<div className="ww-auth-message">{authMessage}</div>}{loginError&&<div className="ww-auth-error"><b>!</b><span><strong>Verification failed</strong><small>{loginError}</small></span></div>}<button className="ww-auth-submit" type="button" onClick={verifyRegistrationEmail} disabled={authBusy||otpCode.trim().length<4}>{authBusy?"Verifying…":"Verify email & continue"} <b>→</b></button><button className="ww-text-link" type="button" onClick={resendRegistrationVerification} disabled={authBusy}>Resend verification code</button><button className="ww-text-link" type="button" onClick={()=>{setRegistrationVerificationPending(false);setOtpCode("");setLoginError("");setAuthMessage("")}}>Back to registration</button></div>:<div className="ww-auth-form"><label><span>Your name</span><div className="ww-field"><i>◉</i><input value={registerName} onChange={e=>setRegisterName(e.target.value)} placeholder="Full name" autoComplete="name" maxLength={100} required/></div></label><label><span>Email address</span><div className="ww-field"><i>✉</i><input type="email" value={loginEmail} onChange={e=>setLoginEmail(e.target.value)} placeholder="Email address" autoComplete="email" required/></div></label><label><span>Password (at least 8 characters)</span><div className="ww-field ww-password-field"><i>⌑</i><input type={showPassword?"text":"password"} value={loginPassword} onChange={e=>setLoginPassword(e.target.value)} placeholder="Create a password" autoComplete="new-password" minLength={8} required/><button type="button" className="ww-password-toggle" onClick={()=>setShowPassword(v=>!v)} aria-label={showPassword?"Hide password":"Show password"}>{showPassword?"◉":"◌"}</button></div></label>{authMessage&&<div className="ww-auth-message">{authMessage}</div>}{loginError&&<div className="ww-auth-error"><b>!</b><span><strong>Registration failed</strong><small>{loginError}</small></span></div>}<button className="ww-auth-submit" type="submit" disabled={authBusy}>{authBusy?"Creating account…":"Create account"} <b>→</b></button><button className="ww-text-link" type="button" onClick={()=>{setRegistrationVerificationPending(true);setOtpCode("");setAuthMessage("Enter the verification code already sent to your email, or resend a new one.");setLoginError("")}} disabled={!loginEmail.trim()}>Already signed up? Verify email</button><div className="ww-register-social"><span>Or create your account with</span><button type="button" onClick={()=>handleSocialSignIn("twitter")} disabled={authBusy}>𝕏&nbsp; Continue with X</button><button type="button" onClick={()=>handleSocialSignIn("telegram")} disabled={authBusy}>✈ Continue with Telegram</button><button type="button" onClick={()=>handleSocialSignIn("google")} disabled={authBusy}>G&nbsp; Continue with Google</button></div><button className="ww-text-link" type="button" onClick={()=>{setRegisterMode(false);setLoginError("");setAuthMessage("");setPasswordMode(true)}}>Already have an account? Sign in</button></div>):!recoveryMode&&["google","github","twitter","telegram"].includes(authMethod)?<div className="ww-auth-form"><button className={"ww-auth-submit ww-google-button ww-social-"+authMethod} type="button" onClick={() => handleSocialSignIn(authMethod)} disabled={authBusy}>{authBusy?"Connecting…":({github:"Continue with GitHub",twitter:"Continue with X",telegram:"Continue with Telegram",google:"Continue with Google"}[authMethod])}</button><p className="ww-auth-note"><span>✓</span> {({github:"GitHub sign-in requires GitHub to be enabled in Neon Auth.",twitter:"X sign-in requires the Twitter/X OAuth provider and credentials to be enabled in Neon Auth.",telegram:"Telegram sign-in requires a configured Telegram authentication provider and verified bot/domain integration.",google:"Google authentication is handled by Neon Auth."}[authMethod])}</p></div>:
      <div className="ww-auth-form"><label><span>Email address</span><div className="ww-field"><i>✉</i><input type="email" value={loginEmail} onChange={e=>setLoginEmail(e.target.value)} placeholder="Email address" autoComplete="email" required/></div></label>
      {recoveryMode?(passwordResetToken?<><label><span>New password</span><div className="ww-field ww-password-field"><i>⌑</i><input type={showPassword?"text":"password"} value={resetPassword} onChange={e=>setResetPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" minLength={8} required/></div></label><label><span>Confirm new password</span><div className="ww-field"><i>⌑</i><input type="password" value={resetPasswordConfirm} onChange={e=>setResetPasswordConfirm(e.target.value)} placeholder="Confirm new password" autoComplete="new-password" minLength={8} required/></div></label><button className="ww-auth-submit" type="button" onClick={completePasswordReset} disabled={authBusy}>{authBusy?"Updating password…":"Set password & enter wallet"} <b>→</b></button></>:<><p className="ww-auth-note">We will send a one-time password setup link to the Gmail address registered to this account. You must open that email to choose a new password.</p><button className="ww-auth-submit" type="button" onClick={requestPasswordReset} disabled={authBusy}>{authBusy?"Sending setup link…":"Send password setup / reset link"} <b>→</b></button></>):
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



        <section className="mobile-root-menu" aria-label="Root wallet and page hub">
          <div className="mobile-root-card">
            <span className="mobile-root-card-icon" aria-hidden="true">⌘</span>
            <div><small>WORLD WALLET AI</small><b>Root</b><span>All wallet pages and tools in one place</span></div>
            <span className="mobile-root-card-tag">HUB</span>
          </div>
          <label className="mobile-root-search">
            <span aria-hidden="true">⌕</span>
            <input type="search" value={rootSearch} onChange={event => setRootSearch(event.target.value)} placeholder="Search wallet pages and tools" aria-label="Search all wallet pages" />
            {rootSearch && <button type="button" onClick={() => setRootSearch("")} aria-label="Clear page search">×</button>}
          </label>
          {!rootSearch.trim() && <div className="mobile-root-shortcuts" aria-label="Root quick shortcuts">
            {ROOT_SHORTCUTS.map(page => <button type="button" key={page} onClick={() => navigateFromRoot(page)}>
              <span>{NAVIGATION_ICONS[page] || "•"}</span><small>{page === "Transactions" ? "Activity" : page}</small>
            </button>)}
          </div>}
        </section>
        <nav aria-label="Primary wallet navigation">
          {rootSearch.trim() && filteredNav.length === 0 && <p className="mobile-root-no-results">No wallet page matches “{rootSearch}”.</p>}
          {filteredNav.map(([group, items]) => (
            <div className="nav-group" key={group}>
              <small>{group}</small>
              {items.map(item => (
                <button key={item} className={active === item ? "nav-item active" : "nav-item"} aria-current={active === item ? "page" : undefined} onClick={() => {
                  // A selected coin or transaction detail must not trap navigation on its detail screen.
                  navigateFromRoot(item);
                }}>
                  <span className="nav-icon" aria-hidden="true">{NAVIGATION_ICONS[item] || "•"}</span><span className="nav-label">{item}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="secure"><span>✓</span><div><b>{user ? "Authenticated wallet" : "Wallet session"}</b><small>{user?.email || "Demo authentication"}</small></div></div>
          <button className="profile" onClick={() => setActive("Profile")}><span className="avatar">BA</span><div><b>{user?.name || "Wallet Owner"}</b><small>{visibleLocalWalletEntries[0]?.walletNumber || wallet?.wallet_number || "View wallet profile"}</small></div><span>›</span></button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button type="button" className="mobile-brand" aria-label={mobileMenuOpen ? "Close wallet navigation" : "Open wallet navigation"} aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen(current => !current)}><span className="mobile-menu-glyph" aria-hidden="true">{mobileMenuOpen ? "×" : "☰"}</span><span className="mobile-brand-logo"><img className="ww-shield-logo" src="/world-wallet-ai-logo.svg" alt="" /></span><b>WORLD WALLET <span>AI</span></b></button>
          <button type="button" className="mobile-root-trigger" aria-label="Open Root wallet hub" aria-expanded={mobileMenuOpen} onClick={() => { setRootSearch(""); setMobileMenuOpen(true); }}>
            <span className="mobile-root-trigger-icon" aria-hidden="true">⌘</span><span><b>Root</b><small>All pages</small></span><span className="mobile-root-trigger-arrow" aria-hidden="true">›</span>
          </button>
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

        {active === "BALMZ AI" ? <BalmzAI wallet={wallet} assets={assets} activity={activity} accessToken={accessToken} apiBaseUrl={API_BASE_URL} setActive={setActive} /> : active === "Gemini Integration" ? <GeminiIntegration accessToken={accessToken} apiBaseUrl={API_BASE_URL} /> : active === "GitHub Integration" ? <GitHubIntegration accessToken={accessToken} apiBaseUrl={API_BASE_URL} /> : selectedCoin ? (() => {
          const coin = walletCoinCatalogWithRegistry.find(c => c.symbol === selectedCoin);
          const live = assets.find(a => a.symbol === selectedCoin);
          const contractBasedBalmz = selectedCoin === "BALMZ" || selectedCoin === "BALMZ-BNB" || selectedCoin === "BALMZ-SEP" || selectedCoin === "BALMZ-SOL";
          const verifiedAsset = verifiedBalancesByAsset.get(String(selectedCoin || "").toUpperCase());
          const balanceKnown = Boolean(verifiedAsset);
          const balance = balanceKnown ? Number(verifiedAsset.available_balance) : null;
          const value = balanceKnown && Number(marketPrices[selectedCoin.replace(/-BNB$/, "")]?.usd || 0) > 0
            ? balance * Number(marketPrices[selectedCoin.replace(/-BNB$/, "")]?.usd)
            : null;
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
                <div className="card-top"><span>AVAILABLE BALANCE</span><AssetIcon symbol={selectedCoin} fallback={coin?.icon || "•"} logoUrl={tokenMetadata?.image || coin?.registry?.logo_url} /></div>
                <div className="hero-balance">{balanceKnown ? number(balance) : "Unavailable"} <small>{selectedCoin}</small></div>
                <div className="balance-meta"><span>{contractBasedBalmz && !coin?.registry?.contract_address ? "Contract deployment pending; balance not yet verifiable" : live?.price_available === false || value == null ? "Wallet valuation unavailable" : `${money(value)} USD`}</span><b>{price ? `${money(price)} / coin` : selectedCoin === "BALMZ-SOL-DEVNET" && solReferencePrice > 0 ? "$" + money(solReferencePrice) + " SOL reference" : "Live price unavailable"}</b></div>
              </article>
              <article className="panel coin-stats">
                <div><small>{isSolanaDevnetBalmz ? "SOL reference 24h change" : "24h change"}</small><b>{change == null ? "—" : `${Number(change).toFixed(2)}%`}</b></div>
                <div><small>Wallet status</small><b>{live ? "Connected" : "Catalog only"}</b></div>
                <div><small>Network</small><b>{coin?.status || "—"}</b></div>
              </article>
            </div>
            {isSolanaDevnetBalmz && coin?.registry && <article className="panel balmz-token-metadata-panel">
              <div className="panel-head">
                <div><h2>On-chain token metadata</h2><span>Metaplex metadata reference · Solana Devnet only</span></div>
                <span className="coin-trading-status">Devnet</span>
              </div>
              <div className="balmz-token-metadata-content">
                <AssetIcon symbol={selectedCoin} fallback="B" logoUrl={tokenMetadata?.image || coin.registry.logo_url} />
                <div className="balmz-token-metadata-fields">
                  <div><small>Name</small><b>{tokenMetadata?.name || "BALMZ"}</b></div>
                  <div><small>Symbol</small><b>{tokenMetadata?.symbol || "BALMZ"}</b></div>
                  <div><small>Decimals</small><b>{coin.registry.decimals == null ? "Unavailable" : coin.registry.decimals}</b></div>
                  <div><small>Mint address</small><code>{coin.registry.contract_address || "Not registered"}</code></div>
                </div>
              </div>
              {tokenMetadata?.description && <p className="balmz-token-metadata-description">{tokenMetadata.description}</p>}
              <div className="balmz-token-metadata-links">
                {coin.registry.metadata_url && <a href={coin.registry.metadata_url} target="_blank" rel="noreferrer">View metadata JSON ↗</a>}
                {coin.registry.contract_address && <a href={"https://explorer.solana.com/address/" + encodeURIComponent(coin.registry.contract_address) + "?cluster=devnet"} target="_blank" rel="noreferrer">Open mint in Solana Explorer ↗</a>}
                <a href="https://explorer.solana.com/address/7ZFtewYj5RJA7VgRyoQH2BfQuLxutxLikvgoRGBaPP3B?cluster=devnet" target="_blank" rel="noreferrer">Open Metaplex metadata account ↗</a>
              </div>
              <p className="coin-detail-note">This is token identity metadata, not a market listing or price. Devnet BALMZ remains a test token; no Mainnet supply or balance is implied.</p>
            </article>}
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
          <section className="content web3-dashboard">
            <div className="page-heading web3-dashboard-heading">
              <div><p className="eyebrow">MULTI-CHAIN SELF-CUSTODY</p><h1>Your Web3 wallet</h1><p className="muted">One wallet workspace for your on-chain assets, networks and activity.</p></div>
              <div className="page-actions">
                <button className="secondary" onClick={() => setActive("Receive")}>Receive</button>
                <button className="primary" onClick={() => setActive("Send")}>Send</button>
              </div>
            </div>
            {walletAnnouncement?.enabled && <article className="panel wallet-announcement" role="status">
              <div><span className="feature-kicker">WORLD WALLET AI ANNOUNCEMENT</span><h2>{walletAnnouncement.title}</h2><p>{walletAnnouncement.body}</p></div>
            </article>}

            

            <div className="balance-grid web3-balance-grid">
              <article className="hero-card">
                <div className="card-top"><span>{selectedNetworkBalance ? (selectedNetwork === "solana_devnet" ? "SOLANA DEVNET BALANCE" : selectedNetwork === "solana_mainnet" ? "SOLANA MAINNET BALANCE" : selectedNetwork === "sepolia" ? "SEPOLIA BALANCE" : selectedNetwork === "bnb" ? "BNB CHAIN BALANCE" : selectedNetwork === "bitcoin" ? "BITCOIN BALANCE" : "ETHEREUM MAINNET BALANCE") : "PORTFOLIO VALUE"}</span><div className="balance-card-tools"><DashboardWalletPanel accessToken={accessToken} apiBaseUrl={API_BASE_URL} onWalletSwitched={async () => { await syncWallet(); await refreshSelectedNetworkBalance(true); }} /><button onClick={() => setShowBalance(!showBalance)} aria-label={showBalance ? "Hide balance" : "Show balance"}>{showBalance ? "◉" : "◎"}</button></div></div>
                <div className="hero-balance">{showBalance ? (selectedNetworkBalance ? number(selectedNetworkBalance.balance) : walletBalanceText) : "••••••••"} <small>{selectedNetworkBalance ? selectedNetworkBalance.asset : selectedNetworkBalanceMessage ? "" : "USD"}</small></div>
                <div className="balance-meta"><span>{!showBalance ? "Balance hidden" : selectedNetworkBalance ? (selectedNetwork === "solana_devnet" || selectedNetwork === "sepolia" ? "On-chain testnet balance · not USD" : "Live on-chain balance · token value shown separately") : selectedNetworkBalanceMessage || walletBalanceCaption}</span><b className="neutral">{selectedNetworkBalance ? (selectedNetworkBalance.syncedAt ? "Synced " + new Date(selectedNetworkBalance.syncedAt).toLocaleTimeString() : "On-chain balance") : wallet.change_24h == null ? "24h change unavailable" : Number(wallet.change_24h).toFixed(2) + "% 24h"}</b></div>

                <div className="card-actions"><button onClick={() => setActive("Send")}>↗ Send</button><button onClick={() => setActive("Receive")}>↙ Receive</button><button onClick={() => setActive("Swap")}>⇄ Swap</button></div>
              </article>
              <article className="stat-card"><span>Total received</span><strong>{walletReceivedText}</strong><b className="neutral">{walletReceivedStatus}</b><div className="stat-source">{walletReceivedSource}</div></article>
              <article className="stat-card"><span>Total sent</span><strong>{walletSentText}</strong><b className="neutral">{walletSentStatus} · {activity.length} recent transactions</b><div className="stat-source">{walletSentSource}</div></article>
              <article className="stat-card balmz-balance-card"><span>BALMZ · Ethereum Mainnet</span><strong>{verifiedBalancesByAsset.has("BALMZ") ? number(verifiedBalancesByAsset.get("BALMZ").available_balance) : "Unavailable"} <small>BALMZ</small></strong><b className="neutral">{verifiedBalancesByAsset.get("BALMZ")?.status || "No verified Mainnet contract/address balance"}</b><div className="stat-source">Ethereum Mainnet only · based on the ownership-verified ERC-20 contract balance.</div></article>
              <article className="stat-card"><span>BALMZ · BNB Chain Mainnet</span><strong>{verifiedBalancesByAsset.has("BALMZ-BNB") ? number(verifiedBalancesByAsset.get("BALMZ-BNB").available_balance) : "Unavailable"} <small>BALMZ-BNB</small></strong><b className="neutral">{verifiedBalancesByAsset.get("BALMZ-BNB")?.status || "No verified BNB Mainnet contract/address balance"}</b></article>
              <article className="stat-card"><span>BALMZ · Solana Mainnet</span><strong>{verifiedBalancesByAsset.has("BALMZ-SOL") ? number(verifiedBalancesByAsset.get("BALMZ-SOL").available_balance) : "Unavailable"} <small>BALMZ-SOL</small></strong><b className="neutral">{verifiedBalancesByAsset.get("BALMZ-SOL")?.status || "Mainnet mint or address not verified"}</b></article>
              <article className="stat-card"><span>BALMZ · Ethereum Sepolia (testnet)</span><strong>Unavailable <small>BALMZ-SEP</small></strong><b className="neutral">Testnet balance is not included in this Mainnet verification report.</b></article>
              <article className="stat-card"><span>BALMZ · Solana Devnet (testnet)</span><strong>Unavailable <small>BALMZ-SOL-DEVNET</small></strong><b className="neutral">Testnet balance is separate and requires its own verified testnet read.</b></article>
              <article className="stat-card"><span>Solana Mainnet SOL</span><strong>{verifiedBalancesByAsset.has("SOL") ? number(verifiedBalancesByAsset.get("SOL").available_balance) : "Unavailable"} <small>SOL</small></strong><b className="neutral">{verifiedBalancesByAsset.get("SOL")?.status || "No verified Solana Mainnet address balance"}</b></article>
            </div>


            <article className="panel wallet-address-trace-panel">
              <div className="panel-head">
                <div><h2>Verified network addresses &amp; asset trace</h2><span>Public addresses and contract balances returned by the read-only chain verifier</span></div>
                <button type="button" className="text-btn" onClick={() => {
                  setBalanceVerificationBusy(true);
                  fetch(API_BASE_URL + "/api/v1/wallet/balance-verification", { headers: { Authorization: "Bearer " + accessToken }, cache: "no-store" })
                    .then(async response => { const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.detail || "Balance verification failed."); setBalanceVerificationReport(data); setBalanceVerificationError(""); })
                    .catch(error => setBalanceVerificationError(error.message || "Balance verification unavailable."))
                    .finally(() => setBalanceVerificationBusy(false));
                }} disabled={balanceVerificationBusy}>{balanceVerificationBusy ? "Checking…" : "↻ Refresh verified balances"}</button>
              </div>
              {balanceVerificationError && <div className="market-price-error" role="status">{balanceVerificationError}</div>}
              {!balanceVerificationReport ? <div className="live-chart-empty">No verified balance report is available yet. {balanceVerificationBusy ? "Checking configured Mainnet readers…" : "Check the authenticated wallet session and network RPC configuration."}</div> : <>
                <div className="coin-catalog-note">{balanceVerificationReport.notice}</div>
                {traceAddressRows.map(addressRow => {
                  const network = normalizeNetworkId(addressRow.network);
                  const observations = (balanceVerificationReport.assets || []).flatMap(asset =>
                    (asset.address_balances || [])
                      .filter(item => String(item.address).toLowerCase() === String(addressRow.address).toLowerCase())
                      .map(item => ({ asset, item }))
                  );
                  const selectedTestnetRead = ["sepolia", "solana_devnet"].includes(network)
                    && selectedNetworkBalance?.verified === true
                    && selectedNetworkBalance?.network === network
                    && String(selectedNetworkBalance?.address || "").toLowerCase() === String(addressRow.address).toLowerCase();
                  return <div className="tool-row" key={network + ":" + addressRow.address}>
                    <div><b>{traceNetworkLabels[network] || network}</b><small>{addressRow.ownership_verified === true ? "Ownership verified · public address" : "Attached · ownership proof required"}</small></div>
                    <code>{addressRow.address}</code>
                    <button type="button" className="secondary" onClick={() => navigator.clipboard?.writeText(addressRow.address)}>Copy</button>
                    <div className="address-balance-trace">
                      {addressRow.ownership_verified !== true
                        ? <span>Balance hidden until this address passes its wallet-signature ownership check.</span>
                        : observations.length
                          ? observations.map(({asset,item}) => <span key={asset.asset + (asset.contract_address || "")}><b>{asset.asset}</b> {number(item.chain_balance)} <small>{asset.contract_address ? "contract verified" : "native"}</small></span>)
                          : selectedTestnetRead
                            ? <span><b>{number(selectedNetworkBalance.balance)} {selectedNetworkBalance.asset}</b> <small>Live read from the selected testnet RPC · {selectedNetworkBalance.syncedAt ? new Date(selectedNetworkBalance.syncedAt).toLocaleString() : "verified read"}</small></span>
                            : <span>{["sepolia", "solana_devnet"].includes(network) ? "Testnet address verified; switch to this test network to request its balance." : "Address verified; no supported Mainnet asset balance observation returned."}</span>}
                    </div>
                  </div>;
                })}
                <div className="asset-list verified-asset-report-list">
                  {traceAssetRows.map((item,index) => <div className="asset-row" key={String(item.asset) + ":" + String(item.network) + ":" + String(item.contract_address || index)}>
                    <div className="asset-name"><b>{item.asset}</b><small>{item.network_label || item.network || "Network adapter not configured"} · {item.status}</small></div>
                    <div className="asset-balance"><b>{item.verified === true && item.available_balance != null ? number(item.available_balance) + " " + item.asset : "Unavailable"}</b><small>{item.verified === true ? (item.addresses_checked || 0) + " ownership-verified address(es) · " + (item.source || "chain read") : (item.note || "No verified chain result; no balance is displayed.")}</small></div>
                    {item.contract_address && <code>{item.contract_address}</code>}
                  </div>)}
                </div>
              </>}
            </article>

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
                  <div><h2>Your assets</h2><span>{walletCoinCatalogWithRegistry.length} catalog assets • {walletCoinCatalogWithRegistry.filter(c => c.connected).length} registry-ready • {verifiedBalancesByAsset.size} chain-verified balances</span></div>
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
                  .filter(c => coinFilter === "all" || (verifiedBalancesByAsset.has(String(c.symbol).toUpperCase()) && Number(verifiedBalancesByAsset.get(String(c.symbol).toUpperCase()).available_balance) !== 0))
                  .map(c => {
                    const live = assets.find(a => a.symbol === c.symbol);
                    const verified = verifiedBalancesByAsset.get(String(c.symbol).toUpperCase()) || null;
                    const balanceKnown = Boolean(verified);
                    const balance = balanceKnown ? Number(verified.available_balance) : null;
                    const price = Number(marketPrices[String(c.symbol).replace(/-BNB$/, "")]?.usd || live?.price_usd || c.price_usd || 0);
                    const hasMarketPrice = price > 0;
                    const value = balanceKnown && hasMarketPrice ? balance * price : null;
                    const liveStatus = verified
                      ? "Ownership-verified chain balance"
                      : (balanceVerificationReport?.assets || []).find(item => String(item.asset).toUpperCase() === String(c.symbol).toUpperCase())?.note
                        || (balanceVerificationBusy ? "Balance verification in progress" : "Balance unavailable · no verified chain result");
                    return <button type="button" className="asset-row asset-row-button" key={c.symbol} onClick={() => setSelectedCoin(c.symbol)}>
                      <AssetIcon symbol={c.symbol} fallback={c.icon || "•"} logoUrl={c.registry?.logo_url} />
                      <div className="asset-name"><b>{c.symbol}</b><small>{c.name} • {verified?.network_label || c.status || liveStatus}</small></div>
                      <div className="asset-balance"><b>{balanceKnown ? number(balance) + " " + c.symbol : "Unavailable"}</b><small>{balanceKnown ? (hasMarketPrice ? `Verified price: ${money(price)}/coin • Value: ${money(value)}` : "Chain-verified quantity · USD valuation unavailable") : liveStatus}</small></div>
                      <small className="asset-network">{verified?.status || c.status}</small>
                    </button>;
                  })}
                </div>
                <div className="coin-catalog-note">Market prices are refreshed from CoinGecko{marketPricesUpdatedAt ? ` • Updated ${marketPricesUpdatedAt.toLocaleTimeString()}` : ""}. Wallet values require a real connected balance. BALMZ stays unpriced until a verified market quote exists.</div>
              </article>

              <article className="panel activity-panel">
                <div className="panel-head"><div><h2>On-chain activity</h2><span>Latest saved wallet transactions</span></div><button className="text-btn" onClick={() => setActive("Transactions")}>View all →</button></div>
                <div className="activity-list">{activity.map((a,i) => <div className="activity-row" key={i}><span className="activity-icon">{a.type[0].toUpperCase()}</span><div><b>{a.type}</b><small>{a.description}</small>{a.reference && <small>Ref: {a.reference}</small>}</div><div className="activity-value"><b className={a.amount.startsWith("+") ? "positive" : ""}>{a.amount}</b><small>{a.time}</small></div></div>)}</div>
              </article>
            </div>

            <article className="panel action-panel dashboard-connected-wallet">
              <div className="panel-head">
                <div><p className="feature-kicker">EXTERNAL WALLET</p><h2>{externalWalletConnection?.address ? "Connected wallet" : "Connect a wallet"}</h2><span>{externalWalletConnection?.address ? "Your selected WalletConnect account" : "Connect or switch to another wallet from your dashboard."}</span></div>
                <button className="primary" onClick={() => setActive("Wallet Connect")}>{externalWalletConnection?.address ? "⇄ Change wallet" : "Connect wallet →"}</button>
              </div>
              {externalWalletConnection?.address ? <div className="tool-row"><div><b>Public address</b><small>Chain ID: {externalWalletConnection.chainId ?? "Unknown"}</small></div><code>{externalWalletConnection.address}</code><button className="secondary" onClick={() => navigator.clipboard?.writeText(externalWalletConnection.address)}>Copy</button></div> : <div className="live-chart-empty">No external wallet selected yet. Use Connect wallet to choose one.</div>}
            </article>



            <article className="panel dashboard-security-bridge">
              <div><p className="feature-kicker">SELF-CUSTODY CONTROLS</p><h2>Wallet tools &amp; support</h2><span>Manage connected signing apps, verify addresses and get help without leaving your wallet workspace.</span></div>
              <div className="dashboard-security-actions">
                <button className="secondary" onClick={() => setActive("Wallet Safety")}>Wallet safety</button>
                <button className="secondary" onClick={() => setActive("Wallet Connect")}>Connected apps</button>
                <button className="secondary" onClick={() => setActive("Help & Docs")}>Help &amp; Docs</button>
              </div>
              <p className="dashboard-security-note">Mainnet and testnet balances remain separate. World Wallet AI never needs your recovery phrase or private key.</p>
            </article>
          </section>) : active === "Browser" ? <BrowserPage onNavigateLogin={() => setShowLogin(true)} /> : <Suspense fallback={<div className="feature-loading" role="status">Loading wallet tools…</div>}>
          <FeaturePage accountUserId={accountUserId} accountName={user?.name || ""} accountEmail={user?.email || ""} selectedAsset={selectedCoin} selectedCoin={selectedCoin} setSelectedCoin={setSelectedCoin} walletCoinCatalog={walletCoinCatalogWithRegistry} marketPrices={marketPrices} marketPricesUpdatedAt={marketPricesUpdatedAt} marketPricesError={marketPricesError} marketPricesLoading={marketPricesLoading} refreshMarketPrices={refreshMarketPrices} focusedTransaction={focusedTransaction} setFocusedTransaction={setFocusedTransaction} active={active} wallet={wallet} walletBalanceText={walletBalanceText} walletBalanceCaption={walletBalanceCaption} unpricedAssets={walletUnpricedAssets} walletRefreshMessage={syncMessage} syncedBalanceAssets={syncedBalanceAssets} assets={assets} activity={activity} accessToken={accessToken} apiBaseUrl={API_BASE_URL} setActive={setActive} onWalletUpdated={(data) => { if (data?.wallet) { const incomingWalletId = data.wallet.wallet_id || data.wallet.id; const activeWalletId = wallet?.wallet_id || wallet?.id; if (incomingWalletId && activeWalletId && incomingWalletId !== activeWalletId) setSyncedBalanceAssets([]); setWallet(data.wallet); } if (data?.assets) setAssets((data.assets || []).map(asset => ({ ...asset, icon: asset.symbol.startsWith("BALMZ") ? "B" : asset.symbol === "USDT" ? "$" : asset.symbol === "ETH" ? "Ξ" : asset.symbol === "BNB" ? "◆" : "•" }))); if (Array.isArray(data?.updates)) setSyncedBalanceAssets([...new Set(data.updates.map(item => String(item?.asset || "").trim().toUpperCase()).filter(Boolean))]); }} onTransactionsUpdated={(transactions) => setActivity((transactions || []).map(tx => ({
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
            reference: tx.reference,
            tx_hash: tx.tx_hash,
            confirmations: Number(tx.confirmations || 0),
            block_height: tx.block_height,
          }))) } />
          </Suspense>
        }

        {active === "Dashboard" && !selectedCoin && (
          <nav className="dashboard-bottom-nav" aria-label="Dashboard shortcuts">
            <button type="button" className="dashboard-tab active" aria-current="page" onClick={() => setActive("Dashboard")}>
              <span className="dashboard-tab-icon">⌂</span><small>Home</small>
            </button>
            <button type="button" className="dashboard-tab" onClick={() => setActive("Wallets")}>
              <span className="dashboard-tab-icon">◈</span><small>Wallets</small>
            </button>
            <button type="button" className="dashboard-tab" onClick={() => setActive("Receive")}>
              <span className="dashboard-tab-icon">↙</span><small>Receive</small>
            </button>
            <button type="button" className="dashboard-tab" onClick={() => setActive("Send")}>
              <span className="dashboard-tab-icon">↗</span><small>Send</small>
            </button>
            <button type="button" className="dashboard-tab" onClick={() => setActive("Transactions")}>
              <span className="dashboard-tab-icon">↔</span><small>Activity</small>
            </button>
            <button type="button" className="dashboard-tab" aria-label="Open all wallet pages and tools" onClick={() => { setRootSearch(""); setMobileMenuOpen(true); }}>
              <span className="dashboard-tab-icon">•••</span><small>More</small>
            </button>
          </nav>
        )}
      </main>
    </div>
  );
}

export default App;