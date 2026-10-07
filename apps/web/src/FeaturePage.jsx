import { useState } from "react";

const money = value => `$${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const number = value => Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });

export default function FeaturePage({ active, wallet, assets, activity, accessToken, apiBaseUrl, setActive }) {
  const [asset, setAsset] = useState(assets[0]?.symbol || "BALMZ");
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [network, setNetwork] = useState("mainnet");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(endpoint) {
    setBusy(true); setMessage("");
    try {
      const body = { asset, amount: Number(amount), network, note: note || null };
      body[endpoint.includes("transfers") ? "recipient" : "destination"] = destination;
      const r = await fetch(apiBaseUrl + endpoint, { method:"POST", headers:{"Content-Type":"application/json", Authorization:"Bearer "+accessToken}, body:JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok || data.status === "rejected") throw new Error(data.detail || data.reason || "Request failed");
      setMessage("Request accepted: " + data.status.replace("_"," "));
      setAmount(""); setDestination(""); setNote("");
    } catch (e) { setMessage(e.message); } finally { setBusy(false); }
  }

  if (active === "Send" || active === "Withdraw") {
    const send = active === "Send";
    return <section className="content feature-content">
      <div className="page-heading"><div><p className="eyebrow">WALLET ACTION</p><h1>{active}</h1><p className="muted">{send ? "Send assets to an external wallet." : "Request a secure withdrawal."}</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div>
      <div className="feature-grid"><article className="panel action-panel">
        <div className="feature-icon">{send ? "↗" : "⇥"}</div><h2>{send ? "Send funds" : "Direct withdrawal"}</h2>
        <label>Asset<select value={asset} onChange={e=>setAsset(e.target.value)}>{assets.map(a=><option key={a.symbol}>{a.symbol} • {number(a.balance)} available</option>)}</select></label>
        <label>Amount<input type="number" min="0" step="any" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/></label>
        <label>{send ? "Recipient" : "Destination"}<input value={destination} onChange={e=>setDestination(e.target.value)} placeholder="Wallet address"/></label>
        <label>Network<select value={network} onChange={e=>setNetwork(e.target.value)}><option value="mainnet">Mainnet</option><option value="ethereum">Ethereum</option><option value="bnb">BNB Chain</option></select></label>
        <label>Note<textarea value={note} onChange={e=>setNote(e.target.value)} maxLength="200" placeholder="Optional note"/></label>
        {message && <div className={message.startsWith("Request accepted") ? "feature-success":"feature-error"}>{message}</div>}
        <button className="primary feature-submit" disabled={busy || !amount || !destination} onClick={()=>submit(send?"/api/v1/transfers":"/api/v1/withdrawals")}>{busy ? "Submitting…" : send ? "Review & send →" : "Request withdrawal →"}</button>
      </article><aside className="panel feature-summary"><span className="feature-kicker">AVAILABLE BALANCE</span><strong>{money(wallet.available_balance_usd)}</strong><small>Wallet funds available</small><div className="summary-divider"/><span>Selected asset</span><b>{asset}</b><div className="security-note">✓ Demo workflow: no blockchain transaction is broadcast.</div></aside></div>
    </section>;
  }

  if (active === "Receive") return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">WALLET ACTION</p><h1>Receive</h1><p className="muted">Receive assets into your World Wallet.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div><div className="feature-grid"><article className="panel receive-panel"><div className="receive-qr">WW</div><p className="feature-kicker">WALLET ID</p><h2>wallet_demo_001</h2><p className="muted">Network-specific deposit addresses will be enabled with live custody integration.</p><button className="primary" onClick={()=>navigator.clipboard?.writeText("wallet_demo_001")}>Copy wallet ID</button></article><article className="panel feature-summary"><span className="feature-kicker">SUPPORTED ASSETS</span>{assets.map(a=><div className="receive-asset" key={a.symbol}><span className="asset-icon">{a.icon}</span><div><b>{a.symbol}</b><small>{a.name}</small></div></div>)}</article></div></section>;

  if (active === "Transactions") return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">WALLET HISTORY</p><h1>Transactions</h1><p className="muted">Track recent wallet activity.</p></div><button className="primary" onClick={()=>setActive("Send")}>+ Send funds</button></div><article className="panel transaction-panel">{activity.map((a,i)=><div className="transaction-row" key={i}><span className="activity-icon">{a.type[0].toUpperCase()}</span><div><b>{a.type}</b><small>{a.description}</small></div><strong className={a.amount.startsWith("+")?"positive":""}>{a.amount}</strong><small>{a.time}</small></div>)}</article></section>;

  if (active === "Portfolio" || active === "Staking" || active === "NFTs") return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">ASSET MANAGEMENT</p><h1>{active}</h1><p className="muted">Manage your digital assets.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div><div className="balance-grid feature-balance"><article className="hero-card"><div className="card-top"><span>AVAILABLE BALANCE</span></div><div className="hero-balance">{money(wallet.available_balance_usd)} <small>USD</small></div></article><article className="stat-card"><span>Portfolio profit</span><strong>{money(wallet.profit_usd)}</strong><b className="positive">+28.46%</b></article></div><article className="panel assets-panel"><div className="panel-head"><div><h2>{active} assets</h2><span>Current wallet holdings</span></div></div><div className="asset-list">{assets.map(a=><div className="asset-row" key={a.symbol}><span className="asset-icon">{a.icon}</span><div className="asset-name"><b>{a.symbol}</b><small>{a.name}</small></div><div className="asset-balance"><b>{number(a.balance)}</b><small>{money(a.value_usd)}</small></div><b className={Number(a.change_24h)>=0?"positive":"negative"}>{Number(a.change_24h)>=0?"+":""}{Number(a.change_24h||0).toFixed(2)}%</b></div>)}</div></article></section>;

  return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">WORLD WALLET AI</p><h1>{active}</h1><p className="muted">Dedicated workspace ready for the next integration layer.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div><article className="panel placeholder-panel"><div className="feature-icon">✦</div><h2>{active}</h2><p>This module is connected to the main navigation and ready for its dedicated backend workflow.</p></article></section>;
}
