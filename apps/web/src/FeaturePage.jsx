import { useEffect, useState } from "react";

const money = value => `$${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const number = value => Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });

export default function FeaturePage({ active, wallet, assets, activity, accessToken, apiBaseUrl, setActive, onTransactionsUpdated, onWalletUpdated }) {
  const [asset, setAsset] = useState(assets[0]?.symbol || "BALMZ");
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [network, setNetwork] = useState("mainnet");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [addresses, setAddresses] = useState([]);
  const [addressMessage, setAddressMessage] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [copiedAddress, setCopiedAddress] = useState("");

  async function submit(endpoint) {
    setBusy(true); setMessage("");
    try {
      const parsedAmount = Number(amount);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) throw new Error("Enter an amount greater than zero.");
      if (!destination.trim()) throw new Error("Enter a destination address.");
      const selectedAsset = assets.find(item => item.symbol === asset);
      if (!selectedAsset) throw new Error("Select a supported wallet asset.");
      if (parsedAmount > Number(selectedAsset.balance || 0)) throw new Error("Amount exceeds the selected asset's available balance.");
      const body = { asset, amount: parsedAmount, network, note: note || null };
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
        <label>Asset<select value={asset} onChange={e=>setAsset(e.target.value)}>{assets.map(a=><option key={a.symbol} value={a.symbol}>{a.symbol} • {number(a.balance)} available</option>)}</select></label>
        <label>Amount<input type="number" min="0" step="any" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/></label>
        <label>{send ? "Recipient" : "Destination"}<input value={destination} onChange={e=>setDestination(e.target.value)} placeholder="Wallet address"/></label>
        <label>Network<select value={network} onChange={e=>setNetwork(e.target.value)}><option value="mainnet">Mainnet</option><option value="ethereum">Ethereum</option><option value="bnb">BNB Chain</option><option value="bitcoin">Bitcoin</option></select></label>
        <label>Note<textarea value={note} onChange={e=>setNote(e.target.value)} maxLength="200" placeholder="Optional note"/></label>
        {message && <div className={message.startsWith("Request accepted") ? "feature-success":"feature-error"}>{message}</div>}
        <button className="primary feature-submit" disabled={busy || !amount || !destination || !assets.some(item => item.symbol === asset)} onClick={()=>submit(send?"/api/v1/transfers":"/api/v1/withdrawals")}>{busy ? "Submitting…" : send ? "Review & send →" : "Request withdrawal →"}</button>
      </article><aside className="panel feature-summary"><span className="feature-kicker">AVAILABLE BALANCE</span><strong>{money(wallet.available_balance_usd)}</strong><small>Wallet funds available</small><div className="summary-divider"/><span>Selected asset</span><b>{asset}</b><div className="security-note">✓ Secure request workflow: this action records a wallet request; no blockchain transaction is broadcast by this API.</div></aside></div>
    </section>;
  }

  if (active === "Receive") {
    useEffect(() => {
      let cancelled = false;
      async function loadAddresses() {
        try {
          const r = await fetch(apiBaseUrl + "/api/v1/wallet/addresses", { headers: { Authorization: "Bearer " + accessToken } });
          const data = await r.json();
          if (cancelled) return;
          setAddresses(data.addresses || []);
          setAddressMessage(data.message || "");
        } catch {
          if (!cancelled) {
            setAddresses([]);
            setAddressMessage("Unable to load wallet addresses.");
          }
        }
      }
      loadAddresses();
      return () => { cancelled = true; };
    }, [apiBaseUrl, accessToken]);

    return <section className="content feature-content">
      <div className="page-heading"><div><p className="eyebrow">WALLET ACTION</p><h1>Receive</h1><p className="muted">Use a configured production blockchain address to receive assets.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div>
      <div className="feature-grid">
        <article className="panel receive-panel">
          <p className="feature-kicker">PRODUCTION DEPOSIT ADDRESSES</p>
          {addresses.length ? addresses.map(item => <div className="receive-address" key={item.network}><div><b>{item.network.toUpperCase()}</b><small>{item.label}</small></div><code>{item.address}</code><button className="secondary" onClick={async ()=>{try{await navigator.clipboard?.writeText(item.address);setCopiedAddress(item.address);setTimeout(()=>setCopiedAddress(""),1800)}catch{setAddressMessage("Copy is unavailable on this device.")}}}>{copiedAddress===item.address?"Copied":"Copy"}</button></div>) : <div className="live-chart-empty">{addressMessage || "No production wallet address configured."}</div>}
        </article>
        <article className="panel feature-summary">
          <span className="feature-kicker">SUPPORTED ASSETS</span>
          {assets.map(a=><div className="receive-asset" key={a.symbol}><span className="asset-icon">{a.icon}</span><div><b>{a.symbol}</b><small>{a.name}</small></div></div>)}
          <div className="security-note">✓ Addresses are read-only for receiving. No private key is stored by this API.</div>
        </article>
      </div>
    </section>;
  }

  if (active === "Transactions") {
    async function syncBitcoin() {
      setSyncBusy(true);
      setSyncMessage("");
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/transactions/sync", {
          method: "POST",
          headers: { Authorization: "Bearer " + accessToken },
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Bitcoin transaction sync failed.");
        onTransactionsUpdated?.(data.transactions || []);
        onWalletUpdated?.({ wallet: data.wallet, assets: data.assets || [] });
        setSyncMessage(data.warnings?.length ? data.warnings.join(" • ") : (data.imported?.length ? `Synced ${data.imported.length} Bitcoin transaction(s).` : "No new Bitcoin transactions found."));
      } catch (error) {
        setSyncMessage(error.message || "Bitcoin transaction sync failed.");
      } finally {
        setSyncBusy(false);
      }
    }

    return <section className="content feature-content">
      <div className="page-heading">
        <div><p className="eyebrow">WALLET HISTORY</p><h1>Transactions</h1><p className="muted">Track wallet activity with blockchain transaction details when available.</p></div>
        <div className="page-actions"><button className="secondary" onClick={syncBitcoin} disabled={syncBusy}>{syncBusy ? "Syncing Bitcoin…" : "↻ Sync Bitcoin"}</button><button className="primary" onClick={()=>setActive("Send")}>+ Send funds</button></div>
      </div>
      {syncMessage && <div className={syncMessage.includes("failed") ? "feature-error" : "feature-success"}>{syncMessage}</div>}
      <article className="panel transaction-panel">
        <div className="transaction-filter-bar"><span>Recorded wallet activity</span><small>{activity.length} transaction{activity.length===1?"":"s"}</small></div>
        {activity.length ? activity.map((a,i) => <div className="transaction-row transaction-chain-row" key={a.tx_hash || i}>
          <span className="activity-icon">{a.type[0].toUpperCase()}</span>
          <div className="transaction-main"><b>{a.type}</b><small>{a.description}</small>{a.tx_hash && <code title={a.tx_hash}>{a.tx_hash}</code>}</div>
          <strong className={Number(a.raw_amount) >= 0 ? "positive" : "negative"}>{a.amount}</strong>
          <div className="transaction-meta"><span className={a.status === "confirmed" ? "positive" : "neutral"}>{a.status || "recorded"}{a.confirmations ? ` • ${a.confirmations} confirmations` : ""}</span>{a.block_height ? <small>Block {a.block_height}</small> : null}{a.tx_hash ? <a href={`https://blockstream.info/tx/${a.tx_hash}`} target="_blank" rel="noreferrer">View on Blockstream ↗</a> : null}<small>{a.time}</small></div>
        </div>) : <div className="live-chart-empty">No real wallet transactions recorded yet.</div>}
      </article>
    </section>;
  }

  if (active === "Portfolio" || active === "Staking" || active === "NFTs") return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">ASSET MANAGEMENT</p><h1>{active}</h1><p className="muted">Manage your digital assets.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div><div className="balance-grid feature-balance"><article className="hero-card"><div className="card-top"><span>AVAILABLE BALANCE</span></div><div className="hero-balance">{money(wallet.available_balance_usd)} <small>USD</small></div></article><article className="stat-card"><span>Portfolio profit</span><strong>{money(wallet.profit_usd)}</strong><b className="positive">{Number(wallet.change_24h || 0).toFixed(2)}%</b></article></div><article className="panel assets-panel"><div className="panel-head"><div><h2>{active} assets</h2><span>Current wallet holdings</span></div></div><div className="asset-list">{assets.map(a=><div className="asset-row" key={a.symbol}><span className="asset-icon">{a.icon}</span><div className="asset-name"><b>{a.symbol}</b><small>{a.name}</small></div><div className="asset-balance"><b>{number(a.balance)}</b><small>{money(a.value_usd)}</small></div><b className={Number(a.change_24h)>=0?"positive":"negative"}>{Number(a.change_24h)>=0?"+":""}{Number(a.change_24h||0).toFixed(2)}%</b></div>)}</div></article></section>;

  if (active === "Wallet Connect") {
    return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">TOOLS</p><h1>Wallet Connect</h1><p className="muted">Inspect configured production wallet addresses.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div>
      <article className="panel tool-panel"><div className="tool-status"><span className="status-dot"></span><b>Read-only connection</b></div>
      <p className="muted">This view never creates a signing session or stores private keys.</p>
      <button className="secondary" onClick={async()=>{setSyncBusy(true);try{const r=await fetch(apiBaseUrl+"/api/v1/wallet/connect",{headers:{Authorization:"Bearer "+accessToken}});const d=await r.json();setAddresses(d.addresses||[]);setAddressMessage(d.message||"");}catch{setAddressMessage("Unable to load connection status.");}finally{setSyncBusy(false)}}}>{syncBusy?"Checking…":"Check connection"}</button>
      {addresses.length?addresses.map(a=><div className="tool-row" key={a.network+a.address}><div><b>{a.network.toUpperCase()}</b><small>{a.label}</small></div><code>{a.address}</code><button className="secondary" onClick={()=>navigator.clipboard?.writeText(a.address)}>Copy</button></div>):<div className="live-chart-empty">{addressMessage||"No configured production address."}</div>}</article>
    </section>;
  }

  return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">WORLD WALLET AI</p><h1>{active}</h1><p className="muted">Production tool workflows are being connected to live wallet data.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div><article className="panel placeholder-panel"><div className="feature-icon">✦</div><h2>{active}</h2><p>This module is connected to the main navigation and ready for its dedicated backend workflow.</p></article></section>;
}
