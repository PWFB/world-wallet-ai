import { useEffect, useMemo, useState } from "react";
import "./App.css";
import FeaturePage from "./FeaturePage.jsx";
import { authClient, getNeonAccessToken } from "./auth-client.js";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const TOKEN_KEY = "world_wallet_access_token";

const fallbackAssets = [];
const fallbackWallet = { available_balance_usd: 0, actual_balance_usd: 0, reserved_balance_usd: 0, total_received_usd: 0, total_sent_usd: 0, profit_usd: 0, change_24h: 0 };
const fallbackActivity = [];
const walletCoinCatalog = [
  { symbol: "BALMZ", name: "BALMZ Token", icon: "B", status: "Wallet token" },
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



const money = value => `$${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const number = value => Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });

function authErrorMessage(error, fallback) {
  if (!error) return fallback;
  const message = error.message || error.error_description || error.code || fallback;
  const code = error.code && error.code !== message ? ` [${error.code}]` : "";
  return `${message}${code}`;
}

function App() {
  const [active, setActive] = useState("Dashboard");
  const [coinFilter, setCoinFilter] = useState("all");
  const [coinSearch, setCoinSearch] = useState("");
  const [selectedCoin, setSelectedCoin] = useState(null);
  const [showBalance, setShowBalance] = useState(true);
  const [wallet, setWallet] = useState(fallbackWallet);
  const [assets, setAssets] = useState(fallbackAssets);
  const [tokenRegistry, setTokenRegistry] = useState([]);
  const walletCoinCatalogWithRegistry = useMemo(() => walletCoinCatalog.map(coin => {
    const records = tokenRegistry.filter(t => t.symbol === coin.symbol);
    const liveRecord = records.find(t => t.wallet_network_connected);
    return { ...coin, registry: liveRecord || records[0] || null, connected: Boolean(liveRecord) };
  }), [tokenRegistry]);
  const [apiStatus, setApiStatus] = useState("loading");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [liveWallet, setLiveWallet] = useState({ status: "checking", mode: "read_only", addresses: [], networks: [], message: "" });
  const [networkStatus, setNetworkStatus] = useState({});
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [passwordMode, setPasswordMode] = useState(true);
  const [otpCode, setOtpCode] = useState("");
  const [otpRequested, setOtpRequested] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [authMethod, setAuthMethod] = useState("email");
  const [authBusy, setAuthBusy] = useState(false);
  const [activity, setActivity] = useState(fallbackActivity);
  const [performance, setPerformance] = useState({ points: [] });
  const sessionState = authClient.useSession();
  const authReady = !sessionState.isPending;
  const neonSessionUser = sessionState.data?.user || null;

  useEffect(() => {
    let cancelled = false;

    async function restoreSessionFromNeon() {
      if (sessionState.isPending) return;

      if (neonSessionUser) {
        // The Better Auth session cookie can become visible before the short-lived
        // Neon JWT endpoint is ready. Retry the token exchange instead of sending
        // the user back to the landing page.
        for (let attempt = 0; attempt < 10 && !cancelled; attempt += 1) {
          try {
            const token = await getNeonAccessToken();
            if (token) {
              sessionStorage.removeItem("world_wallet_google_return");
              setUser(neonSessionUser);
              setAccessToken(token);
              setActive("Dashboard");
              setShowLogin(false);
              if (window.location.search) {
                window.history.replaceState({}, document.title, window.location.pathname);
              }
              return;
            }
          } catch {
            // Keep retrying while Neon Auth finishes the JWT exchange.
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      if (!cancelled) {
        setAccessToken("");
        setUser(null);
        sessionStorage.removeItem("world_wallet_google_return");
        if (new URLSearchParams(window.location.search).get("auth_callback") === "google") {
          setShowLogin(true);
          setLoginError("Google authentication completed, but the wallet session token is not available yet. Please try Google again.");
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      }
    }

    restoreSessionFromNeon();
    return () => { cancelled = true; };
  }, [sessionState.isPending, neonSessionUser]);

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
      loadTokenRegistry(authHeaders);
      try {
        let response = await fetch(`${API_BASE_URL}/api/v1/wallet/refresh`, {
          method: "POST",
          headers: authHeaders,
        });
        if (response.status === 401) {
          const freshToken = await getNeonAccessToken();
          if (freshToken && freshToken !== accessToken && !cancelled) {
            setAccessToken(freshToken);
            return;
          }
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || `Wallet refresh returned ${response.status}`);
        if (cancelled) return;
        setUser(data.user || neonSessionUser || null);
        setWallet(data.wallet || fallbackWallet);
        setAssets((data.assets || fallbackAssets).map(asset => ({
          ...asset,
          icon: asset.symbol === "BALMZ" ? "B" : asset.symbol === "USDT" ? "$" : asset.symbol === "ETH" ? "Ξ" : asset.symbol === "BNB" ? "◆" : "•",
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
          network: tx.network,
          block_hash: tx.block_hash,
          log_index: tx.log_index,
        })));
        setApiStatus("online");
        setLastSyncedAt(data.refreshed_at ? new Date(data.refreshed_at) : new Date());
        setNetworkStatus(data.network_status || {});
        setSyncMessage(data.warnings?.length ? data.warnings.join(" • ") : "Wallet data refreshed.");
      try {
        const walletResponse = await fetch(API_BASE_URL + "/api/v1/wallet/connect", { headers: { Authorization: "Bearer " + accessToken } });
        const walletData = await walletResponse.json();
        setLiveWallet({ status: walletData.status || "not_configured", mode: walletData.mode || "read_only", addresses: walletData.addresses || [], networks: walletData.networks || [], message: walletData.message || "" });
      } catch {
        setLiveWallet({ status: "error", mode: "read_only", addresses: [], networks: [], message: "Live wallet connection status unavailable." });
      }
        try {
          const walletResponse = await fetch(API_BASE_URL + "/api/v1/wallet/connect", { headers: authHeaders });
          const walletData = await walletResponse.json();
          if (!cancelled) setLiveWallet({ status: walletData.status || "not_configured", mode: walletData.mode || "read_only", addresses: walletData.addresses || [], networks: walletData.networks || [], message: walletData.message || "" });
        } catch {
          if (!cancelled) setLiveWallet({ status: "error", mode: "read_only", addresses: [], networks: [], message: "Live wallet connection status unavailable." });
        }
      } catch (error) {
        if (!cancelled) { setApiStatus("error"); setWallet(fallbackWallet); setAssets([]); setActivity([]); setSyncMessage(error.message || "Wallet refresh failed."); }
      }
    }

    loadWallet();
    const walletRefreshTimer = window.setInterval(loadWallet, 60000);

    async function loadTransactions() {
      if (!accessToken) return;
      const authHeaders = { Authorization: `Bearer ${accessToken}` };
      try {
        let response = await fetch(`${API_BASE_URL}/api/v1/transactions`, { headers: authHeaders });
        if (response.status === 401) {
          const freshToken = await getNeonAccessToken();
          if (freshToken && freshToken !== accessToken && !cancelled) {
            setAccessToken(freshToken);
            return;
          }
        }
        if (!response.ok) throw new Error("Transactions API unavailable");
        const data = await response.json();
        if (cancelled) return;
        setActivity((data.transactions || []).map(tx => ({
          type: tx.type,
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
        if (!cancelled) setActivity([]);
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
          id: tx.id, type: tx.type,
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
    const liveTransactionTimer = window.setInterval(syncLiveTransactions, 60000);

    async function loadPerformance() {
      try {
        const response = await fetch(API_BASE_URL + "/api/v1/portfolio/performance", { headers: authHeaders });
        if (!response.ok) throw new Error("Performance API unavailable");
        const data = await response.json();
        if (!cancelled) setPerformance(data);
      } catch { if (!cancelled) setPerformance({ points: [] }); }
    }
    loadPerformance();
    return () => { cancelled = true; window.clearInterval(walletRefreshTimer); window.clearInterval(liveTransactionTimer); };
  }, [accessToken]);

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
        icon: asset.symbol === "BALMZ" ? "B" : asset.symbol === "USDT" ? "$" : asset.symbol === "ETH" ? "Ξ" : asset.symbol === "BNB" ? "◆" : "•",
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

  async function handlePasswordSignIn() {
    setLoginError("");
    setAuthBusy(true);
    try {
      const email = loginEmail.trim().toLowerCase();
      if (!email) throw new Error("Enter your email address.");
      if (!loginPassword) throw new Error("Enter your password.");

      const response = await fetch(API_BASE_URL + "/api/v1/auth/neon/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: loginPassword }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to sign in with password.");
      if (!data.access_token) throw new Error("Secure wallet token was not returned.");
      localStorage.setItem(TOKEN_KEY, data.access_token);
      setUser(data.user || null);
      setAccessToken(data.access_token);
      setLoginPassword("");
      setPasswordMode(false);
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

  async function handleGoogleSignIn() {
    setLoginError("");
    setAuthBusy(true);
    try {
      sessionStorage.setItem("world_wallet_google_return", "1");
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: `${window.location.origin}/?auth_callback=google`,
      });
      if (result?.error) throw new Error(authErrorMessage(result.error, "Google Sign-In failed."));
    } catch (error) {
      sessionStorage.removeItem("world_wallet_google_return");
      setLoginError(error.message || "Google Sign-In unavailable");
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
    Main: ["Dashboard", "Wallets", "Portfolio", "Send", "Receive", "Swap", "Staking", "NFTs", "Transactions"],
    Tools: ["Wallet Connect", "API Keys", "Withdraw", "Request Center", "Verify Contract", "Address Book"],
    Admin: ["Admin Editor", "User Management", "System Settings", "Logs & Activity", "Role Management"],
    Support: ["Support Center", "Help & Docs"],
  }), []);

  if (!authReady && !accessToken) {
    return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">W</div>
          <div><strong>WORLD WALLET</strong><span>AI</span></div>
        </div>

        <div className="network-pill"><i /> Mainnet <b>⌄</b></div>

        <nav>
          {Object.entries(nav).map(([group, items]) => (
            <div className="nav-group" key={group}>
              <small>{group}</small>
              {items.map(item => (
                <button key={item} className={active === item ? "nav-item active" : "nav-item"} onClick={() => setActive(item)}>
                  <span className="nav-icon">{item.slice(0, 1)}</span>{item}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="secure"><span>✓</span><div><b>{user ? "Authenticated wallet" : "Wallet session"}</b><small>{user?.email || "Demo authentication"}</small></div></div>
          <button className="profile" onClick={handleLogout}><span className="avatar">BA</span><div><b>{user?.name || "Wallet Owner"}</b><small>{user?.wallet_id || "Authenticated wallet"}</small></div><span>↪</span></button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="mobile-brand"><div className="brand-mark">W</div><b>WORLD WALLET <span>AI</span></b></div>
          <div className="top-actions"><button>⌕ <span>Search</span></button><button>◐</button><button>◔</button><button className="logout-button" onClick={handleLogout}>↪ <span>Log out</span></button><button className="top-avatar" title={user?.email || "Wallet account"}>{(user?.name || "BA").slice(0, 2).toUpperCase()}</button></div>
        </header>

        {selectedCoin ? (() => {
          const coin = walletCoinCatalog.find(c => c.symbol === selectedCoin);
          const live = assets.find(a => a.symbol === selectedCoin);
          const balance = live?.balance || 0;
          const value = live?.value_usd || 0;
          const price = live?.price_usd || 0;
          const change = live?.change_24h;
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
                <div className="card-top"><span>AVAILABLE BALANCE</span><span className={`asset-icon coin-icon coin-${selectedCoin.toLowerCase()}`}>{coin?.icon}</span></div>
                <div className="hero-balance">{number(balance)} <small>{selectedCoin}</small></div>
                <div className="balance-meta"><span>{money(value)} USD</span><b>{price ? `${money(price)} / coin` : "Live price unavailable"}</b></div>
              </article>
              <article className="panel coin-stats">
                <div><small>24h change</small><b>{change == null ? "—" : `${Number(change).toFixed(2)}%`}</b></div>
                <div><small>Wallet status</small><b>{live ? "Connected" : "Catalog only"}</b></div>
                <div><small>Network</small><b>{coin?.status || "—"}</b></div>
              </article>
            </div>
            <div className="coin-action-grid">
              <button onClick={() => { setActive("Receive"); setSelectedCoin(null); }}>Receive</button>
              <button onClick={() => { setActive("Send"); setSelectedCoin(null); }}>Send</button>
              <button onClick={() => { setActive("Swap"); setSelectedCoin(null); }}>Swap</button>
            </div>
            <article className="panel">
              <div className="panel-head"><div><h2>{selectedCoin} activity</h2><span>Authenticated wallet records only</span></div><button className="text-btn" onClick={() => { setActive("Transactions"); setSelectedCoin(null); }}>All transactions →</button></div>
              {rows.length ? rows.map((item,i) => <div className="activity-row" key={item.id || i}><div><b>{item.type || item.direction || "Transaction"}</b><small>{item.status || "Recorded"}</small></div><strong>{item.amount || "—"} {selectedCoin}</strong></div>) : <div className="empty-state">No real {selectedCoin} transactions recorded yet.</div>}
            </article>
            <div className="coin-detail-note">Only authenticated wallet data is displayed. Catalog entries never create balances, prices, or transaction history.</div>
          </section>;
        })() : active === "Dashboard" ? (
          <section className="content">
            <div className="page-heading">
              <div><p className="eyebrow">OVERVIEW</p><h1>{active}</h1><p className="muted">Your global digital wallet, intelligently managed.</p></div>
              <div className="page-actions"><button className="secondary" onClick={syncWallet} disabled={syncBusy}>{syncBusy ? "Syncing…" : "↻ Sync wallet"}</button><button className="primary" onClick={() => setActive("Send")}>+ Send funds</button></div>
            </div>

            <div className="balance-grid">
              <article className="hero-card">
                <div className="card-top"><span>AVAILABLE BALANCE</span><button onClick={() => setShowBalance(!showBalance)}>{showBalance ? "◉" : "◎"}</button></div>
                <div className="hero-balance">{showBalance ? money(wallet.available_balance_usd) : "••••••••"} <small>USD</small></div>
                <div className="balance-meta"><span>≈ {number(wallet.available_balance_usd)} USD available</span><b className={Number(wallet.change_24h) >= 0 ? "positive" : "negative"}>{Number(wallet.change_24h || 0).toFixed(2)}% <small>24h</small></b></div>
                {Number(wallet.reserved_balance_usd || 0) > 0 && <div className="reserved-note">Reserved for pending requests: {money(wallet.reserved_balance_usd)}</div>}
                <div className="card-actions"><button onClick={() => setActive("Send")}>↗ Send</button><button onClick={() => setActive("Receive")}>↙ Receive</button><button onClick={() => setActive("Swap")}>⇄ Swap</button></div>
              </article>
              <article className="stat-card"><span>Total received</span><strong>{money(wallet.total_received_usd)}</strong><b className="neutral">Live wallet data</b><div className="mini-bars"><i/><i/><i/><i/><i/><i/><i/></div></article>
              <article className="stat-card"><span>Total sent</span><strong>{money(wallet.total_sent_usd)}</strong><b className="neutral">{activity.length} transactions</b><div className="mini-line">╱╲╱╲╱╲╱</div></article>
              <article className="stat-card"><span>Portfolio profit</span><strong>{money(wallet.profit_usd)}</strong><b className={Number(wallet.change_24h) >= 0 ? "positive" : "negative"}>{Number(wallet.change_24h || 0).toFixed(2)}%</b><div className="profit-line">╱╱╲╱╱╲╱</div></article>
            </div>

            <div className="live-wallet-panel panel">
              <div className="live-wallet-main">
                <div>
                  <span className="feature-kicker">LIVE WALLET</span>
                  <h2>{liveWallet.status === "connected" ? "Production wallet connected" : liveWallet.status === "checking" ? "Checking production wallet…" : "Production wallet not configured"}</h2>
                  <p>{liveWallet.mode === "read_only" ? "Read-only blockchain connection • no private key or signing key is stored by the API." : "Wallet connection status"}</p>
                </div>
                <button className="secondary" onClick={syncWallet} disabled={syncBusy}>{syncBusy ? "Syncing…" : "Refresh live wallet"}</button>
              </div>
              {liveWallet.addresses.length ? (
                <div className="live-wallet-addresses">
                  {liveWallet.addresses.map(item => <div className="live-wallet-address" key={item.network + ":" + item.address}>
                    <b>{item.network === "bitcoin" ? "Bitcoin" : item.network === "bnb" ? "BNB Chain" : "Ethereum"}</b>
                    <code>{item.address}</code>
                  </div>)}
                </div>
              ) : (
                <div className="live-wallet-empty">{liveWallet.message || "Configure the production wallet address and chain RPC settings on the backend to enable live balances."}</div>
              )}
              <div className="network-sync-grid">
                {["bitcoin", "ethereum", "bnb"].map(network => {
                  const item = networkStatus[network] || {};
                  const label = network === "bitcoin" ? "Bitcoin" : network === "ethereum" ? "Ethereum" : "BNB Chain";
                  return <div className="network-sync-card" key={network}>
                    <div><b>{label}</b><span className={"sync-dot " + (item.status || "not_configured")} /> <small>{item.status === "healthy" ? "LIVE" : item.status === "warning" ? "WARNING" : item.configured ? "CHECKING" : "NOT CONFIGURED"}</small></div>
                    <span>{item.last_balance_sync_at ? "Balance synced " + new Date(item.last_balance_sync_at).toLocaleTimeString() : "No successful balance sync recorded."}</span>
                    <span>{item.chain_height != null ? "Chain height " + Number(item.chain_height).toLocaleString() : "Chain height unavailable."}</span>
                    {item.warning && <em>{item.warning}</em>}
                  </div>;
                })}
              </div>
              <div className="live-sync-meta">
                <span>Last wallet refresh: {lastSyncedAt ? lastSyncedAt.toLocaleString() : "Not yet"}</span>
                <span>Last transaction sync: {networkStatus.bitcoin?.last_transaction_sync_at || networkStatus.ethereum?.last_transaction_sync_at || networkStatus.bnb?.last_transaction_sync_at ? new Date(networkStatus.bitcoin?.last_transaction_sync_at || networkStatus.ethereum?.last_transaction_sync_at || networkStatus.bnb?.last_transaction_sync_at).toLocaleString() : "Not yet"}</span>
              </div>
            </div>

            <div className="dashboard-grid">
              <article className="panel chart-panel">
                <div className="panel-head"><div><h2>Portfolio performance</h2><span>Asset value over time</span></div><div className="ranges"><button>1D</button><button>1W</button><button className="selected">1M</button><button>1Y</button></div></div>
                <div className="chart">
                  {performance.points.length > 1 ? (
                    <div className="live-chart-note">Live performance history available.</div>
                  ) : (
                    <div className="live-chart-empty">No portfolio performance history recorded yet.</div>
                  )}
                </div>
                <div className="chart-foot"><span>Source: wallet database</span><span>{performance.points.length} recorded point{performance.points.length === 1 ? "" : "s"}</span></div>
              </article>

              <article className="panel ai-panel">
                <div className="ai-title"><div className="ai-orb">✦</div><div><h2>BALMZ AI</h2><span>Your intelligent wallet assistant</span></div><b>LIVE</b></div>
                <div className="ai-message">{assets.length === 0 ? "No wallet assets are available yet. Sync a configured production wallet to let BALMZ AI analyze live data." : Number(wallet.available_balance_usd || 0) > 0 ? <>Your current available balance is <strong>{money(wallet.available_balance_usd)}</strong>. BALMZ AI can analyze the live asset mix and recent activity.</> : "Your wallet is authenticated, but no funded asset balance is currently recorded."}</div>
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
                    const value = live ? live.value_usd : 0;
                    const price = live ? live.price_usd : 0;
                    const liveStatus = live ? (Number(live.actual_balance || live.balance || 0) > 0 ? "Live balance" : "Connected • 0 balance") : (c.registry?.status === "pending_contract" ? "Contract pending" : c.connected ? "Network connected • 0 balance" : "Catalog only • live wallet not connected");
                    return <button type="button" className="asset-row asset-row-button" key={c.symbol} onClick={() => setSelectedCoin(c.symbol)}>
                      <span className={`asset-icon coin-icon coin-${c.symbol.toLowerCase()}`}>{c.icon}</span>
                      <div className="asset-name"><b>{c.symbol}</b><small>{c.name} • {liveStatus}</small></div>
                      <div className="asset-balance"><b>{number(balance)} {c.symbol}</b><small>{price ? `Live price ${money(price)}/coin • ${money(value)} available value` : "Live price unavailable"}</small></div>
                      <small className="asset-network">{c.status}</small>
                    </button>;
                  })}
                </div>
                <div className="coin-catalog-note">Balances and prices are shown only when supplied by the authenticated wallet data source. Catalog entries never create a fake balance.</div>
              </article>

              <article className="panel activity-panel">
                <div className="panel-head"><div><h2>Recent activity</h2><span>Latest wallet events</span></div><button className="text-btn" onClick={() => setActive("Transactions")}>View all →</button></div>
                <div className="activity-list">{activity.map((a,i) => <div className="activity-row" key={i}><span className="activity-icon">{a.type[0].toUpperCase()}</span><div><b>{a.type}</b><small>{a.description}</small></div><div className="activity-value"><b className={a.amount.startsWith("+") ? "positive" : ""}>{a.amount}</b><small>{a.time}</small></div></div>)}</div>
              </article>
            </div>

            <div className="quick-grid">
              <button onClick={() => setActive("Wallet Connect")}><span>◈</span><div><b>Connect wallet</b><small>Manage connected accounts</small></div>→</button>
              <button onClick={() => setActive("Withdraw")}><span>↗</span><div><b>Direct withdrawal</b><small>Move funds securely</small></div>→</button>
              <button onClick={() => setActive("Request Center")}><span>◎</span><div><b>Request funds</b><small>Create a payment request</small></div>→</button>
              <button onClick={() => setActive("Verify Contract")}><span>✓</span><div><b>Verify contract</b><small>Check smart-contract status</small></div>→</button>
            </div>

            <div className="api-status">API: <strong>{apiStatus}</strong>{user ? <> • Signed in as <strong>{user.email}</strong></> : null}{syncMessage ? <> • {syncMessage}</> : null}{lastSyncedAt ? <> • Last sync {lastSyncedAt.toLocaleTimeString()}</> : null}</div>
                    </section>
        ) : (
          <FeaturePage selectedAsset={selectedCoin} active={active} wallet={wallet} assets={assets} activity={activity} accessToken={accessToken} apiBaseUrl={API_BASE_URL} setActive={setActive} onWalletUpdated={(data) => { if (data?.wallet) setWallet(data.wallet); if (data?.assets) setAssets((data.assets || []).map(asset => ({ ...asset, icon: asset.symbol === "BALMZ" ? "B" : asset.symbol === "USDT" ? "$" : asset.symbol === "ETH" ? "Ξ" : asset.symbol === "BNB" ? "◆" : "•" }))); }} onTransactionsUpdated={(transactions) => setActivity((transactions || []).map(tx => ({
            id: tx.id,
            type: tx.type,
            description: `${tx.asset} • ${tx.description}`,
            amount: `${Number(tx.amount) >= 0 ? "+" : ""}${Number(tx.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 })} ${tx.asset}`,
            raw_amount: Number(tx.amount),
            time: tx.time,
            status: tx.status,
            tx_hash: tx.tx_hash,
            confirmations: Number(tx.confirmations || 0),
            block_height: tx.block_height,
          }))) } />
        )}
      </main>
    </div>
  );
}

export default App;