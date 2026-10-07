import { useEffect, useMemo, useState } from "react";
import "./App.css";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const TOKEN_KEY = "world_wallet_access_token";

const fallbackAssets = [
  { symbol: "BALMZ", name: "BALMZ Token", balance: 18420, value_usd: 18420, change_24h: 4.82, icon: "B" },
  { symbol: "USDT", name: "Tether USD", balance: 8250.4, value_usd: 8250.4, change_24h: 0.08, icon: "$" },
  { symbol: "ETH", name: "Ethereum", balance: 2.184, value_usd: 7842.6, change_24h: 2.14, icon: "Ξ" },
  { symbol: "BNB", name: "BNB", balance: 8.42, value_usd: 5914.2, change_24h: -0.61, icon: "B" },
];

const fallbackWallet = {
  available_balance_usd: 40427.2,
  total_received_usd: 92814.6,
  total_sent_usd: 51238.14,
  profit_usd: 8942.76,
  change_24h: 2.31,
};

const fallbackActivity = [
  { type: "received", description: "BALMZ • Wallet funding", amount: "+2,500.00 BALMZ", time: "2 min ago" },
  { type: "sent", description: "USDT • External wallet", amount: "-420.00 USDT", time: "1 hour ago" },
  { type: "swap", description: "ETH → USDT", amount: "+1,120.50 USDT", time: "Yesterday" },
  { type: "staking", description: "BALMZ staking reward", amount: "+86.40 BALMZ", time: "Yesterday" },
];

const money = value => `$${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const number = value => Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });

function App() {
  const [active, setActive] = useState("Dashboard");
  const [showBalance, setShowBalance] = useState(true);
  const [wallet, setWallet] = useState(fallbackWallet);
  const [assets, setAssets] = useState(fallbackAssets);
  const [apiStatus, setApiStatus] = useState("loading");
  const [user, setUser] = useState(null);
  const [activity, setActivity] = useState(fallbackActivity);

  useEffect(() => {
    let cancelled = false;

    async function loadWallet() {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/wallet`, { headers: authHeaders });
        if (!response.ok) throw new Error(`Wallet API returned ${response.status}`);
        const data = await response.json();
        if (cancelled) return;
        setUser(data.user || null);
        setWallet(data.wallet || fallbackWallet);
        setAssets((data.assets || fallbackAssets).map(asset => ({
          ...asset,
          icon: asset.symbol === "USDT" ? "$" : asset.symbol === "ETH" ? "Ξ" : "B",
        })));
        setApiStatus("online");
      } catch {
        if (!cancelled) setApiStatus("demo");
      }
    }

    loadWallet();

    async function loadTransactions() {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/transactions`, { headers: authHeaders });
        if (!response.ok) throw new Error("Transactions API unavailable");
        const data = await response.json();
        if (cancelled) return;
        setActivity((data.transactions || []).map(tx => ({
          type: tx.type,
          description: `${tx.asset} • ${tx.description}`,
          amount: `${Number(tx.amount) >= 0 ? "+" : ""}${Number(tx.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${tx.asset}`,
          time: tx.time,
        })));
      } catch {
        // Keep the local fallback activity when the API is unavailable.
      }
    }

    loadTransactions();
    return () => { cancelled = true; };
  }, []);

  const nav = useMemo(() => ({
    Main: ["Dashboard", "Portfolio", "Send", "Receive", "Swap", "Staking", "NFTs", "Transactions"],
    Tools: ["Wallet Connect", "API Keys", "Withdraw", "Request Center", "Verify Contract", "Address Book"],
    Admin: ["Admin Editor", "User Management", "System Settings", "Logs & Activity", "Role Management"],
    Support: ["Support Center", "Help & Docs"],
  }), []);

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
          <button className="profile"><span className="avatar">BA</span><div><b>{user?.name || "Wallet Owner"}</b><small>{user?.wallet_id || "wallet_demo_001"}</small></div><span>⋮</span></button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="mobile-brand"><div className="brand-mark">W</div><b>WORLD WALLET <span>AI</span></b></div>
          <div className="top-actions"><button>⌕ <span>Search</span></button><button>◐</button><button>◔</button><button className="top-avatar" title={user?.email || "Wallet account"}>{(user?.name || "BA").slice(0, 2).toUpperCase()}</button></div>
        </header>

        <section className="content">
          <div className="page-heading">
            <div><p className="eyebrow">OVERVIEW</p><h1>{active}</h1><p className="muted">Your global digital wallet, intelligently managed.</p></div>
            <button className="primary" onClick={() => setActive("Send")}>+ Send funds</button>
          </div>

          <div className="balance-grid">
            <article className="hero-card">
              <div className="card-top"><span>AVAILABLE BALANCE</span><button onClick={() => setShowBalance(!showBalance)}>{showBalance ? "◉" : "◎"}</button></div>
              <div className="hero-balance">{showBalance ? money(wallet.available_balance_usd) : "••••••••"} <small>USD</small></div>
              <div className="balance-meta"><span>≈ {number(wallet.available_balance_usd)} USDT</span><b>+3.84% <small>24h</small></b></div>
              <div className="card-actions"><button onClick={() => setActive("Send")}>↗ Send</button><button onClick={() => setActive("Receive")}>↙ Receive</button><button onClick={() => setActive("Swap")}>⇄ Swap</button></div>
            </article>
            <article className="stat-card"><span>Total received</span><strong>{money(wallet.total_received_usd)}</strong><b className="positive">+12.4%</b><div className="mini-bars"><i/><i/><i/><i/><i/><i/><i/></div></article>
            <article className="stat-card"><span>Total sent</span><strong>{money(wallet.total_sent_usd)}</strong><b className="neutral">24 transactions</b><div className="mini-line">╱╲╱╲╱╲╱</div></article>
            <article className="stat-card"><span>Portfolio profit</span><strong>{money(wallet.profit_usd)}</strong><b className="positive">+28.46%</b><div className="profit-line">╱╱╲╱╱╲╱</div></article>
          </div>

          <div className="dashboard-grid">
            <article className="panel chart-panel">
              <div className="panel-head"><div><h2>Portfolio performance</h2><span>Asset value over time</span></div><div className="ranges"><button>1D</button><button>1W</button><button className="selected">1M</button><button>1Y</button></div></div>
              <div className="chart"><div className="chart-labels"><span>$45k</span><span>$35k</span><span>$25k</span><span>$15k</span><span>$5k</span></div><svg viewBox="0 0 700 250" preserveAspectRatio="none" aria-label="Portfolio chart"><defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#00d4ff" stopOpacity=".30"/><stop offset="100%" stopColor="#00d4ff" stopOpacity="0"/></linearGradient></defs><path d="M0 195 C55 190 75 150 120 166 S175 125 220 142 S275 90 320 120 S375 105 420 125 S475 70 520 86 S575 58 620 78 S665 42 700 48 L700 250 L0 250Z" fill="url(#fill)"/><path d="M0 195 C55 190 75 150 120 166 S175 125 220 142 S275 90 320 120 S375 105 420 125 S475 70 520 86 S575 58 620 78 S665 42 700 48" fill="none" stroke="#00d4ff" strokeWidth="3"/></svg></div>
              <div className="chart-foot"><span>Sep 08</span><span>Sep 15</span><span>Sep 22</span><span>Sep 29</span><span>Oct 07</span></div>
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
      </main>
    </div>
  );
}

export default App;
