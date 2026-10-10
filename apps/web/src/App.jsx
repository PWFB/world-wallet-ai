import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import "./App.css";
const FeaturePage = lazy(() => import("./FeaturePage.jsx"));
import { authClient, getNeonAccessToken } from "./auth-client.js";
import BrowserPage from "./BrowserPage.jsx";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const TOKEN_KEY = "world_wallet_access_token";

const fallbackAssets = [];
const fallbackWallet = { available_balance_usd: 0, actual_balance_usd: 0, reserved_balance_usd: 0, total_received_usd: 0, total_sent_usd: 0, profit_usd: 0, change_24h: 0 };
const fallbackActivity = [];
const walletCoinCatalog = [
  { symbol: "BALMZ", name: "BALMZ Token", icon: "B", status: "Wallet token" },
  { symbol: "BALMZ-SEP", name: "BALMZ Token (Sepolia)", icon: "B", status: "Sepolia testnet only" },
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
  const [wallet, setWallet] = useState(fallbackWallet);
  const [assets, setAssets] = useState(fallbackAssets);
  const [marketPrices, setMarketPrices] = useState({});
  const [marketPricesUpdatedAt, setMarketPricesUpdatedAt] = useState(null);
  const [tokenRegistry, setTokenRegistry] = useState([]);
  const walletCoinCatalogWithRegistry = useMemo(() => walletCoinCatalog.map(coin => {
    const records = tokenRegistry.filter(t => t.symbol === coin.symbol);
    const liveRecord = records.find(t => t.wallet_network_connected);
    const quote = marketPrices[coin.symbol] || {};
    return {
      ...coin,
      registry: liveRecord || records[0] || null,
      connected: Boolean(liveRecord),
      price_usd: quote.usd == null ? null : Number(quote.usd),
      price_24h_change: quote.usd_24h_change == null ? null : Number(quote.usd_24h_change),
      price_listed: quote.listed === true,
      price_source: quote.usd == null ? null : "CoinGecko",
    };
  }), [tokenRegistry, marketPrices]);
  const [apiStatus, setApiStatus] = useState("loading");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
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
  const sessionState = authClient.useSession();
  const neonSessionUser = sessionState.data?.user || null;

  useEffect(() => {
    let cancelled = false;
    async function loadMarketPrices() {
      try {
        const response = await fetch(API_BASE_URL + "/api/v1/prices/market");
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Market prices unavailable");
        if (!cancelled) {
          setMarketPrices(data.prices || {});
          setMarketPricesUpdatedAt(data.updated_at ? new Date(data.updated_at) : new Date());
        }
      } catch {
        // Keep the last successful quote set if the market service is temporarily unavailable.
      }
    }
    loadMarketPrices();
    const timer = window.setInterval(loadMarketPrices, 60000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function restoreSessionFromNeon() {
      let persistedToken = "";
      let socialReturn = "";
      try {
        persistedToken = localStorage.getItem(TOKEN_KEY) || "";
        const callbackProvider = new URLSearchParams(window.location.search).get("auth_callback") || "";
        const storedProvider = sessionStorage.getItem("world_wallet_social_return") || "";
        socialReturn = ["google", "github"].includes(callbackProvider)
          ? callbackProvider
          : (["google", "github"].includes(storedProvider)
            ? storedProvider
            : (sessionStorage.getItem("world_wallet_google_return") === "1" ? "google" : ""));
      } catch {
        // Storage can be unavailable in restricted browser modes.
      }

      if (persistedToken) {
        if (!accessToken && !cancelled) setAccessToken(persistedToken);
        if (!cancelled) setAuthRestoring(false);
        return;
      }

      if (!socialReturn) {
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
        setLoginError((socialReturn === "github" ? "GitHub" : "Google") + " session could not be restored. Please sign in again.");
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
      loadTokenRegistry(authHeaders);
      try {
        let response = await fetch(`${API_BASE_URL}/api/v1/wallet/refresh`, {
          method: "POST",
          headers: authHeaders,
        });
        if (response.status === 401) {
          const freshToken = await getNeonAccessToken();
          if (freshToken && freshToken !== accessToken && !cancelled) {
            try { localStorage.setItem(TOKEN_KEY, freshToken); } catch {}
            setAccessToken(freshToken);
            return;
          }
          // A single wallet API 401 must not forcibly redirect a user who still
          // has a Neon Auth session. Keep the dashboard visible and surface the
          // API authentication failure so it can be diagnosed without a login loop.
          if (!cancelled) {
            setApiStatus("error");
            setSyncMessage("Wallet API rejected the current session token. Your sign-in was kept; please retry after the session token is refreshed.");
          }
          return;
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || `Wallet refresh returned ${response.status}`);
        if (cancelled) return;
        setUser(data.user || neonSessionUser || null);
        setWallet(data.wallet || fallbackWallet);
        setAssets((data.assets || fallbackAssets).map(asset => ({
          ...asset,
          icon: asset.symbol.startsWith("BALMZ") ? "B" : asset.symbol === "USDT" ? "$" : asset.symbol === "ETH" ? "Ξ" : asset.symbol === "BNB" ? "◆" : "•",
        })));
        setActivity((data.transactions || []).map(tx => ({
          id: tx.id,
          type: tx.type,
          asset: tx.asset || tx.symbol || "", symbol: tx.asset || tx.symbol || "",
          from_address: tx.from_address || tx.from || null, to_address: tx.to_address || tx.to || null,
          network: tx.network, token_contract_address: tx.token_contract_address || tx.contract_address || null,
          description: (tx.asset || "") + " • " + (tx.description || "Wallet transaction"),
          amount: (Number(tx.amount) >= 0 ? "+" : "") + Number(tx.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 }) + " " + (tx.asset || ""),
          raw_amount: Number(tx.amount),
          time: tx.time,
          status: tx.status,
          tx_hash: tx.tx_hash,
          confirmations: Number(tx.confirmations || 0),
          block_height: tx.block_height,
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
    const walletRefreshTimer = refreshInterval === "off"
      ? null
      : window.setInterval(loadWallet, Number(refreshInterval));

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

    async function loadPerformance() {
      try {
        const response = await fetch(API_BASE_URL + "/api/v1/portfolio/performance", { headers: authHeaders });
        if (!response.ok) throw new Error("Performance API unavailable");
        const data = await response.json();
        if (!cancelled) setPerformance(data);
      } catch { if (!cancelled) setPerformance({ points: [] }); }
    }
    loadPerformance();
    return () => {
      cancelled = true;
      if (walletRefreshTimer) window.clearInterval(walletRefreshTimer);
      if (liveTransactionTimer) window.clearInterval(liveTransactionTimer);
    };
  }, [accessToken, refreshInterval]);

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

  async function handleSocialSignIn(provider) {
    const providerName = provider === "github" ? "GitHub" : "Google";
    setLoginError("");
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
    Main: ["Dashboard", "Wallets", "Portfolio", "Send", "Receive", "Swap", "Staking", "NFTs", "Transactions"],
    Tools: ["Browser", "Wallet Connect", "Proof of Reserves", "Sepolia Converter", "Address Converter", "Contract Converter", "API Request", "API Keys", "Withdraw", "Request Center", "Contract Generator", "Verify Contract", "Address Book"],
    Admin: ["Admin Editor", "User Management", "System Settings", "Logs & Activity", "Role Management"],
    Support: ["Support Center", "Help & Docs"],
  }), []);

  if (!accessToken && !showLogin) {
    return (
      <div className="ww-public-shell">
        <header className="ww-public-nav">
          <button className="ww-public-brand" type="button" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} aria-label="World Wallet AI home">
            <span className="ww-globe">◎</span>
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

  if (!accessToken && showLogin) {
    return (<div className="ww-auth-shell"><div className="ww-auth-glow ww-auth-glow-a"/><div className="ww-auth-glow ww-auth-glow-b"/>
      <header className="ww-auth-top ww-auth-top-compact"><div className="ww-auth-brand"><span className="ww-globe">◎</span><b>WORLD WALLET <em>AI</em></b></div><button className="ww-auth-home" type="button" onClick={() => { setShowLogin(false); setLoginError(""); setAuthMessage(""); }}>← Back to home</button></header>
      <section className="ww-auth-layout"><div className="ww-auth-copy"><span className="ww-live-badge"><i/> THE INTELLIGENT DIGITAL WALLET</span><h1>Your Crypto.<br/><em>Your Freedom.</em></h1><p>Securely manage your available balance, digital assets and wallet activity from one intelligent dashboard, powered by BALMZ AI.</p><div className="ww-auth-points"><div><b>◈</b><span><strong>Multi-Chain Support</strong><small>Supported assets and networks in one workspace.</small></span></div><div><b>◇</b><span><strong>Secure &amp; Private</strong><small>Authenticated access with non-custodial wallet architecture.</small></span></div><div><b>✦</b><span><strong>AI-Powered Insights</strong><small>BALMZ AI helps interpret live wallet information.</small></span></div></div><div className="ww-auth-status"><i/> World Wallet AI • Production authentication</div></div>
      <form className="ww-auth-card" onSubmit={e => {e.preventDefault();if(registerMode)handleRegister();else if(passwordMode)handlePasswordSignIn();else requestEmailOtp()}}><div className="ww-auth-card-head"><div className="ww-auth-card-icon">◎</div><div><small>{registerMode?"CREATE ACCOUNT":recoveryMode?"ACCOUNT RECOVERY":"SECURE ACCESS"}</small><h2>{registerMode?"Create your account":recoveryMode?"Recover access":"Welcome Back"}</h2><p>{registerMode?"Register for your World Wallet AI wallet.":recoveryMode?"Use a one-time code sent to your email.":"Sign in to your World Wallet AI account."}</p></div></div>
      {!registerMode&&!recoveryMode&&<div className="ww-auth-switch"><button type="button" className={passwordMode?"active":""} onClick={() => {setPasswordMode(true);setAuthMethod("email");setOtpRequested(false);setLoginError("");setAuthMessage("")}}>Password</button><button type="button" className={!passwordMode&&authMethod==="email"?"active":""} onClick={() => {setPasswordMode(false);setAuthMethod("email");setOtpRequested(false);setOtpCode("");setLoginError("");setAuthMessage("")}}>Email OTP</button><button type="button" className={authMethod==="google"?"active google-tab":""} onClick={() => {setAuthMethod("google");setPasswordMode(false);setLoginError("")}}>G&nbsp;&nbsp;Google</button><button type="button" className={authMethod==="github"?"active google-tab":""} onClick={() => {setAuthMethod("github");setPasswordMode(false);setLoginError("")}}>GitHub</button></div>}
      {registerMode?<div className="ww-auth-form"><label><span>Your name</span><div className="ww-field"><i>◉</i><input value={registerName} onChange={e=>setRegisterName(e.target.value)} placeholder="Full name" autoComplete="name" maxLength={100} required/></div></label><label><span>Phone number</span><div className="ww-field"><i>☎</i><input type="tel" value={registerPhone} onChange={e=>setRegisterPhone(e.target.value)} placeholder="+2348012345678" autoComplete="tel" inputMode="tel" maxLength={20} required/></div><small className="ww-phone-hint">Include your country code, e.g. +234 for Nigeria.</small></label><div className="ww-phone-verify-row"><button className="ww-text-link ww-phone-send-code" type="button" onClick={requestRegisterPhoneOtp} disabled={authBusy}>{authBusy?"Requesting code…":registerPhoneOtpSent?"Resend SMS code":"Send SMS verification code"}</button></div>{registerPhoneOtpSent&&<label><span>SMS verification code</span><div className="ww-field"><i>⌗</i><input type="text" value={registerPhoneOtp} onChange={e=>setRegisterPhoneOtp(e.target.value.replace(/\D/g,"").slice(0,10))} placeholder="Enter code from SMS" inputMode="numeric" autoComplete="one-time-code" maxLength={10} required/></div><small className="ww-phone-hint">Your account is created only after the server verifies this code.</small></label>}<label><span>Email address</span><div className="ww-field"><i>✉</i><input type="email" value={loginEmail} onChange={e=>setLoginEmail(e.target.value)} placeholder="Email address" autoComplete="email" required/></div></label><label><span>Password (at least 8 characters)</span><div className="ww-field ww-password-field"><i>⌑</i><input type={showPassword?"text":"password"} value={loginPassword} onChange={e=>setLoginPassword(e.target.value)} placeholder="Create a password" autoComplete="new-password" minLength={8} required/><button type="button" className="ww-password-toggle" onClick={()=>setShowPassword(v=>!v)} aria-label={showPassword?"Hide password":"Show password"}>{showPassword?"◉":"◌"}</button></div></label>{authMessage&&<div className="ww-auth-message">{authMessage}</div>}{loginError&&<div className="ww-auth-error"><b>!</b><span><strong>Registration failed</strong><small>{loginError}</small></span></div>}<button className="ww-auth-submit" type="submit" disabled={authBusy}>{authBusy?"Creating account…":"Create account"} <b>→</b></button><button className="ww-text-link" type="button" onClick={()=>{setRegisterMode(false);setLoginError("");setAuthMessage("");setPasswordMode(true)}}>Already have an account? Sign in</button></div>:!recoveryMode&&(authMethod==="google"||authMethod==="github")?<div className="ww-auth-form"><button className="ww-auth-submit ww-google-button" type="button" onClick={() => handleSocialSignIn(authMethod)} disabled={authBusy}>{authBusy?"Connecting…":authMethod==="github"?"Continue with GitHub":"G  Continue with Google"}</button><p className="ww-auth-note"><span>✓</span> {authMethod==="github"?"GitHub authentication is handled by Neon Auth. Enable the GitHub provider in Neon Auth first.":"Google authentication is handled by Neon Auth."}</p></div>:
      <div className="ww-auth-form"><label><span>Email address</span><div className="ww-field"><i>✉</i><input type="email" value={loginEmail} onChange={e=>setLoginEmail(e.target.value)} placeholder="Email address" autoComplete="email" required/></div></label>
      {recoveryMode?(otpRequested?<><label><span>6-digit code</span><div className="ww-field"><i>⌗</i><input inputMode="numeric" pattern="[0-9]{6}" maxLength="6" value={otpCode} onChange={e=>setOtpCode(e.target.value)} placeholder="000000" autoComplete="one-time-code" required/></div></label><button className="ww-auth-submit" type="button" onClick={verifyEmailOtp} disabled={authBusy||otpCode.length!==6}>Verify code &amp; sign in <b>→</b></button></>:<button className="ww-auth-submit" type="button" onClick={requestEmailOtp} disabled={authBusy}>Send recovery code <b>→</b></button>):
      passwordMode?<><label><span>Password</span><div className="ww-field ww-password-field"><i>⌑</i><input type={showPassword ? "text" : "password"} value={loginPassword} onChange={e=>setLoginPassword(e.target.value)} placeholder="Password" autoComplete="current-password" required/><button type="button" className="ww-password-toggle" onClick={() => setShowPassword(v => !v)} aria-label={showPassword ? "Hide password" : "Show password"} title={showPassword ? "Hide password" : "Show password"}>{showPassword ? "◉" : "◌"}</button></div></label><div className="ww-auth-options"><span>☑ Remember me</span><button type="button" onClick={() => {setRecoveryMode(true);setOtpRequested(false);setOtpCode("");setLoginError("")}}>Forgot password?</button></div><button className="ww-auth-submit" type="submit" disabled={authBusy}>{authBusy?"Signing in…":"Sign In"} <b>→</b></button><button className="ww-text-link" type="button" onClick={() => {setPasswordMode(false);setOtpRequested(false);setLoginError("")}}>Use email OTP instead</button></>:
      otpRequested?<><label><span>6-digit code</span><div className="ww-field"><i>⌗</i><input inputMode="numeric" pattern="[0-9]{6}" maxLength="6" value={otpCode} onChange={e=>setOtpCode(e.target.value)} placeholder="000000" autoComplete="one-time-code" required/></div></label><button className="ww-auth-submit" type="button" onClick={verifyEmailOtp} disabled={authBusy||otpCode.length!==6}>Verify &amp; enter wallet <b>→</b></button><button className="ww-text-link" type="button" onClick={requestEmailOtp} disabled={authBusy}>Send a new code</button></>:<><button className="ww-auth-submit" type="button" onClick={requestEmailOtp} disabled={authBusy}>Send secure code <b>→</b></button><button className="ww-text-link" type="button" onClick={() => setPasswordMode(true)}>Use email &amp; password</button></>}
      {recoveryMode&&<button className="ww-text-link" type="button" onClick={() => {setRecoveryMode(false);setOtpRequested(false);setOtpCode("");setLoginError("")}}>← Back to sign in</button>}
      {authMessage&&<div className="ww-auth-message">{authMessage}</div>}{loginError&&<div className="ww-auth-error"><b>!</b><span><strong>{registerMode?"Registration failed":recoveryMode?"Recovery failed":"Sign-in failed"}</strong><small>{loginError}</small></span></div>}<p className="ww-auth-note"><span>✓</span> Session verification is handled by Neon Auth and the World Wallet API.</p></div>}{!recoveryMode&&!registerMode&&<p className="ww-register-prompt">Don't have an account? <button type="button" onClick={()=>{setRegisterMode(true);setPasswordMode(true);setAuthMethod("email");setLoginError("");setAuthMessage("")}}>Register</button></p>}{!recoveryMode&&registerMode&&<p className="ww-register-prompt">Keep your password private and never share your recovery credentials.</p>}</form></section>
    </div>);
  }

  return (
    <div className={"app-shell" + (active === "Dashboard" && !selectedCoin ? " dashboard-shortcuts-active" : "")}>
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
          const price = Number(live?.price_usd || marketPrices[selectedCoin]?.usd || 0);
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
              {rows.length ? rows.map((item,i) => <button type="button" className="activity-row coin-history-clickable" key={item.id || item.tx_hash || i} onClick={() => { setFocusedTransaction(item); setSelectedCoin(null); setActive("Transactions"); }}><div><b>{item.type || item.direction || "Transaction"}</b><small>{item.status || "Recorded"} · View details ↗</small></div><strong>{item.amount || "—"} {selectedCoin}</strong></button>) : <div className="empty-state">No real {selectedCoin} transactions recorded yet.</div>}
            </article>
            <div className="coin-detail-note">Only authenticated wallet data is displayed. Catalog entries never create balances, prices, or transaction history.</div>
          </section>;
        })() : active === "Dashboard" ? (
          <section className="content">
            <div className="page-heading">
              <div><p className="eyebrow">OVERVIEW</p><h1>{active}</h1><p className="muted">Your global digital wallet, intelligently managed.</p></div>
              <div className="page-actions">
                <div className="refresh-dropdown">
                  <button className="secondary refresh-menu-trigger" type="button" onClick={() => setShowRefreshMenu(value => !value)} aria-haspopup="menu" aria-expanded={showRefreshMenu} disabled={syncBusy}>
                    {syncBusy ? "Refreshing…" : "↻ Refresh"} <span aria-hidden="true">▾</span>
                  </button>
                  {showRefreshMenu && <div className="refresh-menu" role="menu" aria-label="Dashboard refresh options">
                    <button type="button" role="menuitem" onClick={() => { setShowRefreshMenu(false); syncWallet(); }}>Refresh wallet now</button>
                    <div className="refresh-menu-label">Automatic refresh</div>
                    {[["off", "Off"], ["60000", "Every 1 minute"], ["300000", "Every 5 minutes"]].map(([value, label]) => <button type="button" role="menuitemradio" aria-checked={refreshInterval === value} className={refreshInterval === value ? "selected" : ""} key={value} onClick={() => { setRefreshInterval(value); setShowRefreshMenu(false); }}>{refreshInterval === value ? "✓ " : ""}{label}</button>)}
                  </div>}
                </div>
                <button className="primary" onClick={() => setActive("Send")}>+ Send funds</button>
              </div>
            </div>

            <div className="balance-grid">
              <article className="hero-card">
                <div className="card-top"><span>AVAILABLE BALANCE</span><button onClick={() => setShowBalance(!showBalance)}>{showBalance ? "◉" : "◎"}</button></div>
                <div className="hero-balance">{showBalance ? money(wallet.available_balance_usd) : "••••••••"} <small>USD</small></div>
                <div className="balance-meta"><span>≈ {number(wallet.available_balance_usd)} USD available</span><b className={Number(wallet.change_24h) >= 0 ? "positive" : "negative"}>{Number(wallet.change_24h || 0).toFixed(2)}% <small>24h</small></b></div>
                {Number(wallet.reserved_balance_usd || 0) > 0 && <div className="reserved-note">Reserved for pending requests: {money(wallet.reserved_balance_usd)}</div>}
                <div className="card-actions"><button onClick={() => setActive("Send")}>↗ Send</button><button onClick={() => setActive("Receive")}>↙ Receive</button><button onClick={() => setActive("Swap")}>⇄ Swap</button></div>
              </article>
              <article className="stat-card"><span>Total received</span><strong>{money(wallet.total_received_usd)}</strong><b className="neutral">Live wallet data</b><div className="stat-source">Live value from authenticated wallet</div></article>
              <article className="stat-card"><span>Total sent</span><strong>{money(wallet.total_sent_usd)}</strong><b className="neutral">{activity.length} transactions</b><div className="stat-source">Verified wallet transaction records</div></article>
              <article className="stat-card"><span>Portfolio profit</span><strong>{money(wallet.profit_usd)}</strong><b className={Number(wallet.change_24h) >= 0 ? "positive" : "negative"}>{Number(wallet.change_24h || 0).toFixed(2)}%</b><div className="stat-source">Calculated from recorded live holdings</div></article>
            </div>

            <div className="live-wallet-panel panel">
              <div className="live-wallet-main">
                <div>
                  <span className="feature-kicker">LIVE WALLET</span>
                  <h2>{liveWallet.status === "connected" ? "Production wallet connected" : liveWallet.status === "checking" ? "Checking production wallet…" : "Production wallet not configured"}</h2>
                  <p>{liveWallet.mode === "read_only" ? "Read-only blockchain connection • no private key or signing key is stored by the API." : "Wallet connection status"}</p>
                </div>
                
              </div>
              {liveWallet.addresses.length ? (
                <div className="live-wallet-addresses">
                  {liveWallet.addresses.map(item => <div className="live-wallet-address" key={item.network + ":" + item.address}>
                    <b>{item.network === "bitcoin" ? "Bitcoin" : item.network === "bnb" ? "BNB Chain" : item.network === "sepolia" ? "Ethereum Sepolia (testnet)" : "Ethereum"}</b>
                    <code>{item.address}</code>
                  </div>)}
                </div>
              ) : (
                <div className="live-wallet-empty">{liveWallet.message || "Configure the production wallet address and chain RPC settings on the backend to enable live balances."}</div>
              )}
              <div className="network-sync-grid">
                {["bitcoin", "ethereum", "bnb", "sepolia"].map(network => {
                  const item = networkStatus[network] || {};
                  const label = network === "bitcoin" ? "Bitcoin" : network === "ethereum" ? "Ethereum" : network === "bnb" ? "BNB Chain" : "Ethereum Sepolia (testnet)";
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
                    const price = Number(live?.price_usd || c.price_usd || marketPrices[c.symbol]?.usd || 0);
                    const hasMarketPrice = price > 0;
                    const liveStatus = c.registry?.status === "pending_contract" ? "Contract pending" : live ? (Number(live.actual_balance || live.balance || 0) > 0 ? "Live balance" : "Connected • 0 balance") : c.connected ? "Network connected • 0 balance" : "Catalog only • live wallet not connected";
                    return <button type="button" className="asset-row asset-row-button" key={c.symbol} onClick={() => setSelectedCoin(c.symbol)}>
                      <span className={`asset-icon coin-icon coin-${c.symbol.toLowerCase()}`}>{c.icon}</span>
                      <div className="asset-name"><b>{c.symbol}</b><small>{c.name} • {liveStatus}</small></div>
                      <div className="asset-balance"><b>{number(balance)} {c.symbol}</b><small>{hasMarketPrice ? `Price: ${money(price)}/coin${c.price_24h_change == null ? "" : ` • 24h ${Number(c.price_24h_change) >= 0 ? "+" : ""}${Number(c.price_24h_change).toFixed(2)}%`} • Wallet value: ${live ? money(value) : "—"}` : c.symbol.startsWith("BALMZ") ? "Price: Not listed • Wallet value: —" : "Price: Unavailable • Wallet value: —"}</small></div>
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

            <div className="quick-grid">
              <button onClick={() => setActive("Wallet Connect")}><span>◈</span><div><b>Connect wallet</b><small>Manage connected accounts</small></div>→</button>
              <button onClick={() => setActive("Withdraw")}><span>↗</span><div><b>Direct withdrawal</b><small>Move funds securely</small></div>→</button>
              <button onClick={() => setActive("Request Center")}><span>◎</span><div><b>Request funds</b><small>Create a payment request</small></div>→</button>
              <button onClick={() => setActive("Verify Contract")}><span>✓</span><div><b>Verify contract</b><small>Check smart-contract status</small></div>→</button>
            </div>

            <div className="api-status">API: <strong>{apiStatus}</strong>{user ? <> • Signed in as <strong>{user.email}</strong></> : null}{syncMessage ? <> • {syncMessage}</> : null}{lastSyncedAt ? <> • Last sync {lastSyncedAt.toLocaleTimeString()}</> : null}</div>
                    </section>
        ) : (
          active === "Browser" ? <BrowserPage onNavigateLogin={() => setShowLogin(true)} /> : <Suspense fallback={<div className="feature-loading" role="status">Loading wallet tools…</div>}>
          <FeaturePage selectedAsset={selectedCoin} focusedTransaction={focusedTransaction} setFocusedTransaction={setFocusedTransaction} active={active} wallet={wallet} assets={assets} activity={activity} accessToken={accessToken} apiBaseUrl={API_BASE_URL} setActive={setActive} onWalletUpdated={(data) => { if (data?.wallet) setWallet(data.wallet); if (data?.assets) setAssets((data.assets || []).map(asset => ({ ...asset, icon: asset.symbol.startsWith("BALMZ") ? "B" : asset.symbol === "USDT" ? "$" : asset.symbol === "ETH" ? "Ξ" : asset.symbol === "BNB" ? "◆" : "•" }))); }} onTransactionsUpdated={(transactions) => setActivity((transactions || []).map(tx => ({
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
              <button type="button" className="dashboard-tab" onClick={() => { setActive("Receive"); setShowDashboardMore(false); }}>
                <span className="dashboard-tab-icon">↓</span><small>Deposit</small>
              </button>
              <button type="button" className="dashboard-tab" onClick={() => { setActive("Withdraw"); setShowDashboardMore(false); }}>
                <span className="dashboard-tab-icon">↑</span><small>Withdrawal</small>
              </button>
              <button type="button" className="dashboard-tab" onClick={() => { setActive("Swap"); setShowDashboardMore(false); }}>
                <span className="dashboard-tab-icon">⇄</span><small>Convert</small>
              </button>
              <button type="button" className="dashboard-tab" onClick={() => { setActive("Wallets"); setShowDashboardMore(false); }}>
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