import { useEffect, useMemo, useState } from "react";
import "./App.css";
import FeaturePage from "./FeaturePage.jsx";
import { authClient, getNeonAccessToken } from "./auth-client.js";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const TOKEN_KEY = "world_wallet_access_token";

const fallbackAssets = [];
const fallbackWallet = { available_balance_usd: 0, total_received_usd: 0, total_sent_usd: 0, profit_usd: 0, change_24h: 0 };
const fallbackActivity = [];

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
  const [showBalance, setShowBalance] = useState(true);
  const [wallet, setWallet] = useState(fallbackWallet);
  const [assets, setAssets] = useState(fallbackAssets);
  const [apiStatus, setApiStatus] = useState("loading");
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [passwordMode, setPasswordMode] = useState(false);
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

    async function loadWallet() {
      if (!accessToken) return;
      const authHeaders = { Authorization: `Bearer ${accessToken}` };
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/wallet`, { headers: authHeaders });
        if (!response.ok) throw new Error(`Wallet API returned ${response.status}`);
        let data = await response.json();

        // Refresh supported market prices before rendering balances.
        try {
          const priceResponse = await fetch(`${API_BASE_URL}/api/v1/prices/refresh`, {
            method: "POST",
            headers: authHeaders,
          });
          if (priceResponse.ok) {
            const priced = await priceResponse.json();
            data = { ...data, wallet: { ...data.wallet, ...(priced.wallet || {}) }, assets: priced.assets || data.assets };
          }
        } catch {
          // Keep authenticated wallet data if the public price service is temporarily unavailable.
        }
        if (cancelled) return;
        setUser(data.user || null);
        setWallet(data.wallet || fallbackWallet);
        setAssets((data.assets || fallbackAssets).map(asset => ({
          ...asset,
          icon: asset.symbol === "BALMZ" ? "B" : asset.symbol === "USDT" ? "$" : asset.symbol === "ETH" ? "Ξ" : asset.symbol === "BNB" ? "◆" : "•",
        })));
        setApiStatus("online");
      } catch {
        if (!cancelled) { setApiStatus("error"); setWallet(fallbackWallet); setAssets([]); }
      }
    }

    loadWallet();

    async function loadTransactions() {
      if (!accessToken) return;
      const authHeaders = { Authorization: `Bearer ${accessToken}` };
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/transactions`, { headers: authHeaders });
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

    loadTransactions();
    async function loadPerformance() {
      try {
        const response = await fetch(API_BASE_URL + "/api/v1/portfolio/performance", { headers: authHeaders });
        if (!response.ok) throw new Error("Performance API unavailable");
        const data = await response.json();
        if (!cancelled) setPerformance(data);
      } catch { if (!cancelled) setPerformance({ points: [] }); }
    }
    loadPerformance();
    return () => { cancelled = true; };
  }, [accessToken]);

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

      const result = await authClient.signIn.email({
        email,
        password: loginPassword,
      });

      if (result?.error) {
        throw new Error(authErrorMessage(result.error, "Invalid email or password."));
      }

      const token = await getWalletTokenWithRetry();
      if (!token) throw new Error("Password sign-in succeeded, but the secure wallet token could not be created. Please try again.");

      setUser(result?.data?.user || null);
      setAccessToken(token);
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
      const result = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "sign-in",
      });
      if (result?.error) throw new Error(authErrorMessage(result.error, "Unable to send the sign-in code."));
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
      const result = await authClient.signIn.emailOtp({
        email,
        otp: otpCode.trim(),
      });
      if (result?.error) throw new Error(authErrorMessage(result.error, "Invalid or expired code."));
      const token = await getWalletTokenWithRetry();
      if (!token) throw new Error("Email verification succeeded, but the secure wallet token could not be created. Please try again.");
      setUser(result?.data?.user || null);
      setAccessToken(token);
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
    Main: ["Dashboard", "Portfolio", "Send", "Receive", "Swap", "Staking", "NFTs", "Transactions"],
    Tools: ["Wallet Connect", "API Keys", "Withdraw", "Request Center", "Verify Contract", "Address Book"],
    Admin: ["Admin Editor", "User Management", "System Settings", "Logs & Activity", "Role Management"],
    Support: ["Support Center", "Help & Docs"],
  }), []);

  if (!authReady && !accessToken) {
    return (
      <div className="login-shell">
        <section className="login-layout" style={{ minHeight: "100vh", alignItems: "center", justifyContent: "center" }}>
          <div className="login-card" style={{ maxWidth: 460, width: "100%" }}>
            <div className="login-card-header"><div className="login-card-icon">W</div><div><p className="eyebrow">SECURE ACCESS</p><h2>Restoring wallet session</h2></div></div>
            <p className="login-subtitle">Finishing secure authentication. Please wait while World Wallet AI restores your signed-in session.</p>
          </div>
        </section>
      </div>
    );
  }

  if (!accessToken && !showLogin) {
    return (
      <div className="landing-shell">
        <header className="landing-nav">
          <button className="landing-brand" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
            <span className="brand-mark">W</span>
            <span><b>WORLD WALLET</b><em>AI</em></span>
          </button>
          <nav className="landing-links">
            <a href="#features">Features</a>
            <a href="#security">Security</a>
            <a href="#ai">BALMZ AI</a>
          </nav>
          <button className="landing-login" onClick={() => setShowLogin(true)}>Sign in <span>→</span></button>
        </header>

        <main>
          <section className="landing-hero">
            <div className="landing-orbit landing-orbit-one" />
            <div className="landing-orbit landing-orbit-two" />
            <div className="landing-hero-copy">
              <div className="landing-badge"><span /> INTELLIGENT DIGITAL WALLET</div>
              <h1>Your wallet.<br /><em>Beyond borders.</em></h1>
              <p>Manage your digital assets, available balance and wallet activity from one secure global workspace, enhanced by BALMZ AI.</p>
              <div className="landing-cta">
                <button className="landing-primary" onClick={() => setShowLogin(true)}>Enter World Wallet AI <span>→</span></button>
                <a className="landing-secondary" href="#features">Explore features</a>
              </div>
              <div className="landing-trust"><span>✓</span> Real wallet data &nbsp;•&nbsp; Secure authentication &nbsp;•&nbsp; Mainnet ready</div>
            </div>
            <div className="landing-wallet-card">
              <div className="landing-card-glow" />
              <div className="landing-card-top"><span>WORLD WALLET AI</span><b>LIVE</b></div>
              <div className="landing-card-chip">W</div>
              <div className="landing-card-balance"><small>AVAILABLE BALANCE</small><strong>Securely connected</strong><span>USD • Digital Assets</span></div>
              <div className="landing-card-line" />
              <div className="landing-card-assets"><span><b>BALMZ</b><small>AI ecosystem</small></span><span><b>BTC</b><small>Bitcoin</small></span><span><b>ETH</b><small>Ethereum</small></span></div>
            </div>
          </section>

          <section id="features" className="landing-section">
            <div className="landing-section-heading"><span>01</span><div><p className="eyebrow">ONE GLOBAL WORKSPACE</p><h2>Everything your wallet needs.</h2></div></div>
            <div className="landing-feature-grid">
              <article><i>◈</i><h3>Available balance</h3><p>See the value available in your wallet from authenticated, live wallet data.</p></article>
              <article><i>↗</i><h3>Move assets</h3><p>Send, receive and manage supported digital assets from one focused interface.</p></article>
              <article><i>◎</i><h3>Portfolio intelligence</h3><p>Understand wallet activity and portfolio performance without fabricated numbers.</p></article>
              <article id="ai"><i>✦</i><h3>BALMZ AI</h3><p>An intelligent layer designed to help you understand your digital wallet and assets.</p></article>
            </div>
          </section>

          <section id="security" className="landing-security">
            <div><p className="eyebrow">02 • SECURITY FIRST</p><h2>Your wallet access stays protected.</h2><p>World Wallet AI uses authenticated sessions and Neon Auth. Email OTP gives you passwordless access and account recovery without asking you to store a wallet password in the app.</p></div>
            <div className="security-points"><div><b>01</b><span>Authenticated sessions</span></div><div><b>02</b><span>Email OTP access & recovery</span></div><div><b>03</b><span>Live wallet data only</span></div></div>
          </section>
        </main>

        <footer className="landing-footer"><span>© 2026 WORLD WALLET AI</span><span>BALMZ AI • GLOBAL DIGITAL WALLET</span></footer>
      </div>
    );
  }

  if (!accessToken) {
    return (
      <div className="login-shell">
        <div className="login-background login-background-one" />
        <div className="login-background login-background-two" />

        <section className="login-layout">
          <div className="login-brand-panel">
            <div className="login-brand-row">
              <div className="brand-mark login-mark">W</div>
              <div><strong>WORLD WALLET</strong><span>AI</span></div>
            </div>
            <div className="login-copy">
              <p className="eyebrow">THE INTELLIGENT DIGITAL WALLET</p>
              <h1>One wallet.<br /><em>Global control.</em></h1>
              <p>Securely manage your available balance, digital assets and wallet activity from one intelligent dashboard.</p>
            </div>
            <div className="login-feature-list">
              <div><span>✓</span><div><b>Available balance</b><small>See your spendable wallet value at a glance.</small></div></div>
              <div><span>✓</span><div><b>AI-powered insights</b><small>Use BALMZ AI to understand your portfolio.</small></div></div>
              <div><span>✓</span><div><b>Secure wallet access</b><small>Authenticated access to your wallet workspace.</small></div></div>
            </div>
            <div className="login-network"><span /> World Wallet AI • Mainnet ready</div>
          </div>

          <form className="login-card" onSubmit={event => event.preventDefault()}>
            <button type="button" className="login-home" onClick={() => { setShowLogin(false); setRecoveryMode(false); setOtpRequested(false); setOtpCode(""); setLoginError(""); }}>← World Wallet AI</button>
            <div className="login-card-header">
              <div className="login-card-icon">W</div>
              <div><p className="eyebrow">{recoveryMode ? "ACCOUNT RECOVERY" : "SECURE ACCESS"}</p><h2>{recoveryMode ? "Recover wallet access" : "Welcome back"}</h2></div>
            </div>
            <p className="login-subtitle">
              {recoveryMode
                ? "Use the one-time code sent to your email to recover wallet access."
                : passwordMode
                  ? "Sign in with your Neon Auth password."
                  : "Use a one-time email code for secure passwordless access."}
            </p>

            {!recoveryMode && (
              <div className="auth-methods" role="tablist" aria-label="Sign-in methods">
                <button type="button" className={authMethod === "email" && !passwordMode ? "auth-method active" : "auth-method"} onClick={() => { setAuthMethod("email"); setPasswordMode(false); setLoginPassword(""); setLoginError(""); }}><span>✉</span><b>Email OTP</b></button>
                <button type="button" className={authMethod === "email" && passwordMode ? "auth-method active" : "auth-method"} onClick={() => { setAuthMethod("email"); setPasswordMode(true); setOtpRequested(false); setOtpCode(""); setLoginError(""); }}><span>⌘</span><b>Password</b></button>
                <button type="button" className={authMethod === "google" ? "auth-method active" : "auth-method"} onClick={() => { setAuthMethod("google"); setPasswordMode(false); setLoginError(""); }}><span>G</span><b>Google</b></button>
              </div>
            )}

            {(authMethod === "email" || recoveryMode) && (
              <div className="auth-method-form">
                <label className="login-field">
                  <span>Email address</span>
                  <div className="login-input-wrap"><span>✉</span><input type="email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required /></div>
                </label>
                {!otpRequested && passwordMode && !recoveryMode ? (
                  <>
                    <label className="login-field">
                      <span>Enter password</span>
                      <div className="login-input-wrap"><span>⌘</span><input type="password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} placeholder="Enter your password" autoComplete="current-password" required /></div>
                    </label>
                    <button className="login-submit" type="button" onClick={handlePasswordSignIn} disabled={authBusy}>Sign in with password <span>→</span></button>
                    <button className="forgot" type="button" onClick={() => { setPasswordMode(false); setLoginPassword(""); setLoginError(""); }}>Use email OTP instead</button>
                  </>
                ) : !otpRequested ? (
                  <>
                    <button className="login-submit" type="button" onClick={requestEmailOtp} disabled={authBusy}>{recoveryMode ? "Send recovery code" : "Send secure code"} <span>→</span></button>
                    {!recoveryMode && <button className="forgot" type="button" onClick={() => { setPasswordMode(true); setLoginError(""); }}>Enter password instead</button>}
                  </>
                ) : (
                  <>
                    <label className="login-field">
                      <span>6-digit code</span>
                      <div className="login-input-wrap"><span>⌗</span><input inputMode="numeric" pattern="[0-9]{6}" maxLength="6" value={otpCode} onChange={e => setOtpCode(e.target.value)} placeholder="000000" autoComplete="one-time-code" required /></div>
                    </label>
                    <button className="login-submit" type="button" onClick={verifyEmailOtp} disabled={authBusy || otpCode.length !== 6}>{recoveryMode ? "Verify code & sign in" : "Verify & enter wallet"} <span>→</span></button>
                    <button className="forgot" type="button" onClick={requestEmailOtp} disabled={authBusy}>Send a new code</button>
                  </>
                )}
                {recoveryMode && (
                  <button className="forgot recovery-back" type="button" onClick={() => { setRecoveryMode(false); setOtpRequested(false); setOtpCode(""); setLoginError(""); }}>← Back to sign in</button>
                )}
                <p className="login-security"><span>✓</span> No password is stored in World Wallet AI. The recovery code verifies your email and signs you into your wallet.</p>
              </div>
            )}

            {authMethod === "google" && (
              <div className="auth-method-form">
                <button className="login-submit google-submit" type="button" onClick={handleGoogleSignIn} disabled={authBusy}>Continue with Google <span>G</span></button>
                <p className="login-security"><span>✓</span> Google authentication is handled by Neon Auth.</p>
              </div>
            )}

            {authMethod === "biometric" && (
              <div className="auth-method-form">
                <button className="login-submit biometric-submit" type="button" onClick={handleBiometricSignIn} disabled={authBusy}>Use fingerprint / Face Unlock <span>◉</span></button>
              </div>
            )}

            {!recoveryMode && authMethod === "email" && !passwordMode && (
              <button className="forgot recovery-link" type="button" onClick={() => { setRecoveryMode(true); setAuthMethod("email"); setOtpRequested(false); setOtpCode(""); setLoginError(""); }}>Forgot password? Recover with email OTP</button>
            )}

            {loginError && (
              <div className="login-error"><span>!</span><div><b>{recoveryMode ? "Recovery failed" : "Sign-in failed"}</b><small>{loginError}</small></div></div>
            )}

            <div className="login-divider"><span>WORLD WALLET AI</span></div>
            <p className="login-security"><span>✓</span> Session verification is handled by Neon Auth and the World Wallet API.</p>
          </form>
        </section>
      </div>
    );
  }

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
          <button className="profile" onClick={handleLogout}><span className="avatar">BA</span><div><b>{user?.name || "Wallet Owner"}</b><small>{user?.wallet_id || "wallet_demo_001"}</small></div><span>↪</span></button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="mobile-brand"><div className="brand-mark">W</div><b>WORLD WALLET <span>AI</span></b></div>
          <div className="top-actions"><button>⌕ <span>Search</span></button><button>◐</button><button>◔</button><button className="logout-button" onClick={handleLogout}>↪ <span>Log out</span></button><button className="top-avatar" title={user?.email || "Wallet account"}>{(user?.name || "BA").slice(0, 2).toUpperCase()}</button></div>
        </header>

        {active === "Dashboard" ? (
          <section className="content">
            <div className="page-heading">
              <div><p className="eyebrow">OVERVIEW</p><h1>{active}</h1><p className="muted">Your global digital wallet, intelligently managed.</p></div>
              <button className="primary" onClick={() => setActive("Send")}>+ Send funds</button>
            </div>

            <div className="balance-grid">
              <article className="hero-card">
                <div className="card-top"><span>AVAILABLE BALANCE</span><button onClick={() => setShowBalance(!showBalance)}>{showBalance ? "◉" : "◎"}</button></div>
                <div className="hero-balance">{showBalance ? money(wallet.available_balance_usd) : "••••••••"} <small>USD</small></div>
                <div className="balance-meta"><span>≈ {number(wallet.available_balance_usd)} USD</span><b className={Number(wallet.change_24h) >= 0 ? "positive" : "negative"}>{Number(wallet.change_24h || 0).toFixed(2)}% <small>24h</small></b></div>
                <div className="card-actions"><button onClick={() => setActive("Send")}>↗ Send</button><button onClick={() => setActive("Receive")}>↙ Receive</button><button onClick={() => setActive("Swap")}>⇄ Swap</button></div>
              </article>
              <article className="stat-card"><span>Total received</span><strong>{money(wallet.total_received_usd)}</strong><b className="neutral">Live wallet data</b><div className="mini-bars"><i/><i/><i/><i/><i/><i/><i/></div></article>
              <article className="stat-card"><span>Total sent</span><strong>{money(wallet.total_sent_usd)}</strong><b className="neutral">{activity.length} transactions</b><div className="mini-line">╱╲╱╲╱╲╱</div></article>
              <article className="stat-card"><span>Portfolio profit</span><strong>{money(wallet.profit_usd)}</strong><b className={Number(wallet.change_24h) >= 0 ? "positive" : "negative"}>{Number(wallet.change_24h || 0).toFixed(2)}%</b><div className="profit-line">╱╱╲╱╱╲╱</div></article>
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
                <div className="ai-message">Your portfolio is up <strong>{Number(wallet.change_24h || 0).toFixed(2)}%</strong> today. BALMZ has the strongest momentum. Would you like a quick risk and opportunity scan?</div>
                <div className="ai-actions"><button>Run portfolio scan</button><button>Ask BALMZ AI</button></div>
                <div className="ai-input">Ask anything about your wallet... <span>↗</span></div>
              </article>

              <article className="panel assets-panel">
                <div className="panel-head"><div><h2>Your assets</h2><span>{assets.length} assets • {money(wallet.available_balance_usd)} total</span></div><button className="text-btn">View portfolio →</button></div>
                <div className="asset-list">{assets.map(a => <div className="asset-row" key={a.symbol}><span className="asset-icon">{a.icon}</span><div className="asset-name"><b>{a.symbol}</b><small>{a.name}</small></div><div className="asset-balance"><b>{number(a.balance)}</b><small>{money(a.value_usd)}</small></div><b className={Number(a.change_24h) >= 0 ? "positive" : "negative"}>{Number(a.change_24h) >= 0 ? "+" : ""}{Number(a.change_24h || 0).toFixed(2)}%</b></div>)}</div>
              </article>

              <article className="panel activity-panel">
                <div className="panel-head"><div><h2>Recent activity</h2><span>Latest wallet events</span></div><button className="text-btn">View all →</button></div>
                <div className="activity-list">{activity.map((a,i) => <div className="activity-row" key={i}><span className="activity-icon">{a.type[0].toUpperCase()}</span><div><b>{a.type}</b><small>{a.description}</small></div><div className="activity-value"><b className={a.amount.startsWith("+") ? "positive" : ""}>{a.amount}</b><small>{a.time}</small></div></div>)}</div>
              </article>
            </div>

            <div className="quick-grid">
              <button onClick={() => setActive("Wallet Connect")}><span>◈</span><div><b>Connect wallet</b><small>Manage connected accounts</small></div>→</button>
              <button onClick={() => setActive("Withdraw")}><span>↗</span><div><b>Direct withdrawal</b><small>Move funds securely</small></div>→</button>
              <button onClick={() => setActive("Request Center")}><span>◎</span><div><b>Request funds</b><small>Create a payment request</small></div>→</button>
              <button onClick={() => setActive("Verify Contract")}><span>✓</span><div><b>Verify contract</b><small>Check smart-contract status</small></div>→</button>
            </div>

            <div className="api-status">API: <strong>{apiStatus}</strong>{user ? <> • Signed in as <strong>{user.email}</strong></> : null}</div>
                    </section>
        ) : (
          <FeaturePage active={active} wallet={wallet} assets={assets} activity={activity} accessToken={accessToken} apiBaseUrl={API_BASE_URL} setActive={setActive} onWalletUpdated={(data) => { if (data?.wallet) setWallet(data.wallet); if (data?.assets) setAssets((data.assets || []).map(asset => ({ ...asset, icon: asset.symbol === "BALMZ" ? "B" : asset.symbol === "USDT" ? "$" : asset.symbol === "ETH" ? "Ξ" : asset.symbol === "BNB" ? "◆" : "•" }))); }} onTransactionsUpdated={(transactions) => setActivity((transactions || []).map(tx => ({
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
