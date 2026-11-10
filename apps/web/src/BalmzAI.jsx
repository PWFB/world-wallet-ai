import { useCallback, useEffect, useMemo, useState } from "react";
import "./BalmzAI.css";

const ETH_RPC = "https://ethereum-rpc.publicnode.com";
const BSC_RPC = "https://bsc-dataseed.binance.org/";
const SOL_RPC = "https://api.mainnet-beta.solana.com";
const fmt = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toLocaleString("en-US", { maximumFractionDigits: digits }) : "Unavailable";
const usd = (value) => value == null || !Number.isFinite(Number(value)) ? "Unavailable" : "$" + fmt(value, 6);
const short = (value) => value ? value.slice(0, 6) + "…" + value.slice(-5) : "—";

async function readJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error("Data provider returned HTTP " + response.status);
  return response.json();
}

export default function BalmzAI({ wallet = null, assets = [], activity = [], accessToken = "", apiBaseUrl = "", setActive }) {
  const [chain, setChain] = useState("ethereum");
  const [tab, setTab] = useState("Overview");
  const [address, setAddress] = useState("");
  const [token, setToken] = useState(null);
  const [pairs, setPairs] = useState([]);
  const [market, setMarket] = useState(null);
  const [connectedAddress, setConnectedAddress] = useState("");
  const [walletBalance, setWalletBalance] = useState(null);
  const [loading, setLoading] = useState(false);
  const [walletLoading, setWalletLoading] = useState(false);
  const [error, setError] = useState("");
  const [walletError, setWalletError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(null);
  const [question, setQuestion] = useState("");
  const [report, setReport] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [includeWalletContext, setIncludeWalletContext] = useState(false);

  const scanToken = useCallback(async (target = address, network = chain) => {
    const clean = target.trim();
    if (!clean) { setError("Enter a token mint or contract address."); return; }
    setLoading(true); setError("");
    try {
      const result = await readJson("https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(clean));
      const chainId = network === "solana" ? "solana" : network === "bsc" ? "bsc" : "ethereum";
      const found = (result.pairs || []).filter(pair => pair.chainId === chainId);
      if (!found.length) {
        setToken(null); setPairs([]);
        throw new Error("No matching " + (network === "solana" ? "Solana" : "BNB Smart Chain") + " market data was returned for this address. Confirm the network and address.");
      }
      found.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
      const best = found[0];
      const base = [best.baseToken, best.quoteToken].find(item => item?.address?.toLowerCase() === clean.toLowerCase()) || best.baseToken;
      setToken({ address: clean, name: base?.name || best.baseToken?.name || "Unknown token", symbol: base?.symbol || best.baseToken?.symbol || "—", chain: network, pairAddress: best.pairAddress, dex: best.dexId, url: best.url });
      setPairs(found.slice(0, 8));
      setMarket(best);
      setUpdatedAt(new Date().toISOString());
    } catch (e) {
      setError(e?.message || "Unable to retrieve token data.");
    } finally { setLoading(false); }
  }, [address, chain]);

  useEffect(() => {
    if (!token) return undefined;
    const id = setInterval(() => scanToken(token.address, token.chain), 30000);
    return () => clearInterval(id);
  }, [token?.address, token?.chain, scanToken]);

  const connectWallet = async () => {
    setWalletError(""); setWalletBalance(null); setWalletLoading(true);
    try {
      if (chain === "solana") {
        const provider = window.okxwallet?.solana || window.solana;
        if (!provider?.connect) throw new Error("An OKX or Solana wallet provider is not available in this browser.");
        const result = await provider.connect();
        const pubkey = result?.publicKey?.toString?.() || provider.publicKey?.toString?.();
        if (!pubkey) throw new Error("Wallet did not return a public address.");
        setConnectedAddress(pubkey);
        const rpc = await readJson(SOL_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [pubkey, { commitment: "finalized" }] }) });
        if (rpc.error) throw new Error(rpc.error.message || "Solana RPC balance lookup failed.");
        setWalletBalance({ amount: Number(rpc.result.value) / 1e9, asset: "SOL", source: "Solana Mainnet finalized RPC" });
      } else {
        const provider = window.okxwallet || window.ethereum;
        if (!provider?.request) throw new Error("An OKX or injected EVM wallet provider is not available in this browser.");
        const expectedChain = chain === "bsc" ? "0x38" : "0x1";
        const rpcUrl = chain === "bsc" ? BSC_RPC : ETH_RPC;
        const label = chain === "bsc" ? "BNB Chain" : "Ethereum";
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: expectedChain }] });
        const accounts = await provider.request({ method: "eth_requestAccounts" });
        if (!accounts?.[0]) throw new Error("Wallet did not return a public address.");
        setConnectedAddress(accounts[0]);
        const raw = await readJson(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [accounts[0], "latest"] }) });
        if (raw.error) throw new Error(raw.error.message || label + " RPC balance lookup failed.");
        setWalletBalance({ amount: Number(BigInt(raw.result)) / 1e18, asset: chain === "bsc" ? "BNB" : "ETH", source: label + " Mainnet RPC" });
      }
    } catch (e) {
      setWalletError(e?.message || "Wallet connection failed.");
    } finally { setWalletLoading(false); }
  };

  const metrics = useMemo(() => {
    const change = market?.priceChange?.h24;
    return [
      { label: "Token price", value: usd(market?.priceUsd), note: "Live DEX quote" },
      { label: "24h volume", value: market?.volume?.h24 == null ? "Unavailable" : usd(market.volume.h24), note: "Reported by market pair" },
      { label: "Liquidity", value: market?.liquidity?.usd == null ? "Unavailable" : usd(market.liquidity.usd), note: "Selected pair" },
      { label: "24h change", value: change == null ? "Unavailable" : (Number(change) > 0 ? "+" : "") + fmt(change) + "%", note: "Selected pair" }
    ];
  }, [market]);

  async function makeReport() {
    const prompt = question.trim() || (token ? "Summarize the current " + token.symbol + " market metrics, liquidity and important limitations." : "Explain how World Wallet AI verifies balances, reserves and transaction evidence.");
    if (!accessToken || !apiBaseUrl) { setReport("Sign in to use the BALMZ AI assistant."); return; }
    setAiLoading(true);
    setReport("");
    const marketContext = token && market ? {
      token_name: token.name,
      token_symbol: token.symbol,
      network: token.chain === "solana" ? "Solana Mainnet" : token.chain === "bsc" ? "BNB Chain Mainnet" : "Ethereum Mainnet",
      price_usd: market.priceUsd ?? null,
      volume_24h_usd: market.volume?.h24 ?? null,
      liquidity_usd: market.liquidity?.usd ?? null,
      change_24h_percent: market.priceChange?.h24 ?? null,
    } : null;
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/balmz-ai/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
        body: JSON.stringify({ question: prompt, include_wallet_context: includeWalletContext, market_context: marketContext }),
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "BALMZ AI could not generate a response.");
      setReport(data.answer || "BALMZ AI returned an empty response.");
    } catch (cause) {
      setReport(cause?.message || "BALMZ AI request failed. Check backend Gemini configuration and try again.");
    } finally {
      setAiLoading(false);
    }
  }

  return <section className="balmz-ai-page">
    <header className="balmz-ai-heading">
      <div><p className="balmz-ai-eyebrow">WORLD WALLET AI · INTELLIGENCE</p><h1><span>BALMZ</span> AI</h1><p>Live token market scans plus evidence-based wallet and transaction helpers.</p></div>
      <div className="balmz-ai-live"><i /> Live market source <small>{updatedAt ? "Updated " + new Date(updatedAt).toLocaleTimeString() : "Waiting for data"}</small></div>
    </header>

    <div className="balmz-ai-columns">
      <article className="panel balmz-ai-wallet-panel">
        <div className="balmz-ai-panel-title"><div><span className="balmz-ai-icon">✦</span><div><h2>WizzU Helper</h2><p>Check live balances, reserve coverage and reconciliation issues for the active wallet.</p></div></div></div>
        <button className="balmz-ai-primary" type="button" onClick={() => setActive?.("WizzU Helper")}>Open WizzU Helper →</button>
      </article>
      <article className="panel balmz-ai-activity-panel">
        <div className="balmz-ai-panel-title"><div><span className="balmz-ai-icon">↔</span><div><h2>Transaction Tracing Helper</h2><p>Search saved transactions, receipt states, hashes and wallet audit activities.</p></div></div></div>
        <button className="balmz-ai-primary" type="button" onClick={() => setActive?.("Activity Trace")}>Trace all wallet activity →</button>
      </article>
    </div>

    <nav className="balmz-ai-tabs" aria-label="BALMZ AI modules">
      {["Overview", "Token Scanner", "Portfolio", "Security", "AI Reports"].map(item => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}
    </nav>

    <div className="balmz-ai-chainbar">
      <div><span className="balmz-ai-status-dot" /> Network</div>
      <div className="balmz-ai-chain-select">
        <button className={chain === "ethereum" ? "active" : ""} onClick={() => { setChain("ethereum"); setAddress(""); setToken(null); setPairs([]); setMarket(null); setConnectedAddress(""); setWalletBalance(null); setWalletError(""); }}>Ethereum Mainnet</button>
        <button className={chain === "bsc" ? "active" : ""} onClick={() => { setChain("bsc"); setAddress(""); setToken(null); setPairs([]); setMarket(null); setConnectedAddress(""); setWalletBalance(null); setWalletError(""); }}>BNB Chain Mainnet</button>
        <button className={chain === "solana" ? "active" : ""} onClick={() => { setChain("solana"); setAddress(""); setToken(null); setPairs([]); setMarket(null); setConnectedAddress(""); setWalletBalance(null); setWalletError(""); }}>Solana Mainnet</button>
      </div>
      <span className="balmz-ai-chain-note">Read-only public data · No trading permissions</span>
    </div>

    {(tab === "Overview" || tab === "Token Scanner") && <div className="balmz-ai-scan panel">
      <div className="balmz-ai-panel-title"><div><span className="balmz-ai-icon">⌕</span><div><h2>Token scanner</h2><p>Enter a verified mint or token contract address to query live decentralized-exchange market data. No unrelated sample token is preloaded.</p></div></div><span className="balmz-ai-source">SOURCE · DEXSCREENER</span></div>
      <form className="balmz-ai-search" onSubmit={e => { e.preventDefault(); scanToken(); }}>
        <input aria-label="Token mint or contract address" value={address} onChange={e => setAddress(e.target.value)} placeholder={chain === "solana" ? "Verified Solana token mint address" : "Verified " + (chain === "bsc" ? "BNB Chain" : "Ethereum") + " token contract address"} />
        <button type="submit" disabled={loading}>{loading ? "Scanning…" : "Scan token"}</button>
      </form>
      {error && <p className="balmz-ai-error" role="alert">{error}</p>}
      {token && <div className="balmz-ai-token-summary"><div className="balmz-ai-token-mark">{token.symbol.slice(0, 1).toUpperCase()}</div><div className="balmz-ai-token-name"><h3>{token.name} <span>{token.symbol}</span></h3><p>{short(token.address)} · {token.chain === "solana" ? "Solana" : "BNB Smart Chain"} · {market?.dexId || "DEX market"}</p></div><a href={market?.url} target="_blank" rel="noreferrer">Open pair ↗</a></div>}
      <div className="balmz-ai-metrics">{metrics.map(m => <article key={m.label}><small>{m.label}</small><strong>{m.value}</strong><span>{m.note}</span></article>)}</div>
      <div className="balmz-ai-data-foot">Market values reflect the selected pair and may differ across exchanges. Missing data is shown as unavailable.</div>
    </div>}

    {(tab === "Overview" || tab === "Portfolio") && <section className="panel balmz-ai-wallet-panel">
      <div className="balmz-ai-panel-title"><div><span className="balmz-ai-icon">▥</span><div><h2>Active World Wallet snapshot</h2><p>Live application snapshot. Independent on-chain checks are available in Wallet Wizard and Proof of Reserves.</p></div></div><span className="balmz-ai-source">{wallet?.wallet_number || wallet?.wallet_id || "ACTIVE WALLET"}</span></div>
      <div className="balmz-ai-metrics">
        <article><small>Asset rows</small><strong>{Array.isArray(assets) ? assets.length : 0}</strong><span>From authenticated wallet snapshot</span></article>
        <article><small>Non-zero balances</small><strong>{(assets || []).filter(item => Number(item.balance || 0) > 0).length}</strong><span>Saved balance records</span></article>
        <article><small>Saved activities</small><strong>{Array.isArray(activity) ? activity.length : 0}</strong><span>Current dashboard activity cache</span></article>
        <article><small>USD valuation</small><strong>{wallet?.valuation_complete === true ? "Complete" : "Incomplete"}</strong><span>Unpriced assets stay excluded from totals</span></article>
      </div>
      {assets?.length ? <div className="balmz-ai-pairs">{assets.slice(0,12).map((item,index)=><div key={(item.symbol || "asset")+":"+(item.network || "")+":"+index}><span><b>{item.symbol || "Asset"}</b><small>{item.network_label || item.network || "Network not recorded"}</small></span><strong>{fmt(item.available_balance ?? item.balance,8)} {item.symbol || ""}</strong></div>)}</div> : <div className="balmz-ai-empty">No saved wallet asset rows are available. Open Wallets and refresh your balances.</div>}
      <div className="balmz-ai-data-foot">This panel does not independently prove ownership or reserve backing. Use the verification tools before making a transfer or recovery decision.</div>
    </section>}

    {(tab === "Overview" || tab === "Portfolio") && <div className="balmz-ai-columns">
      <section className="panel balmz-ai-wallet-panel"><div className="balmz-ai-panel-title"><div><span className="balmz-ai-icon">◈</span><div><h2>Wallet portfolio</h2><p>Connect an external wallet to inspect its native Mainnet coin balance.</p></div></div><span className="balmz-ai-source">ON-CHAIN RPC</span></div>
        {!connectedAddress ? <div className="balmz-ai-connect"><div className="balmz-ai-wallet-art">◎</div><h3>Connect your {chain === "solana" ? "Solana" : "EVM"} wallet</h3><p>Only your public address and native coin balance are read. No private key is requested.</p><button onClick={connectWallet} disabled={walletLoading}>{walletLoading ? "Connecting…" : "Connect wallet"}</button></div> : <div className="balmz-ai-wallet-result"><small>CONNECTED ADDRESS</small><strong>{short(connectedAddress)}</strong><small>NATIVE BALANCE · {walletBalance?.source || "Loading"}</small><strong>{walletBalance ? fmt(walletBalance.amount, 8) + " " + walletBalance.asset : "Unavailable"}</strong><button className="balmz-ai-text-button" onClick={() => { setConnectedAddress(""); setWalletBalance(null); }}>Disconnect view</button></div>}
        {walletError && <p className="balmz-ai-error" role="alert">{walletError}</p>}
      </section>
      <section className="panel balmz-ai-activity-panel"><div className="balmz-ai-panel-title"><div><span className="balmz-ai-icon">↗</span><div><h2>Market pairs</h2><p>Highest-liquidity matching pairs returned by the data source.</p></div></div></div>
        {pairs.length ? <div className="balmz-ai-pairs">{pairs.slice(0, 5).map(pair => <a key={pair.pairAddress} href={pair.url} target="_blank" rel="noreferrer"><span><b>{pair.baseToken?.symbol || "Token"}/{pair.quoteToken?.symbol || "Quote"}</b><small>{pair.dexId || "DEX"} · {pair.pairAddress ? short(pair.pairAddress) : "Pair address unavailable"}</small></span><strong>{usd(pair.priceUsd)}</strong></a>)}</div> : <div className="balmz-ai-empty">Scan a token to load its available market pairs.</div>}
      </section>
    </div>}

    {tab === "Security" && <section className="panel balmz-ai-security"><div className="balmz-ai-panel-title"><div><span className="balmz-ai-icon">⌑</span><div><h2>Security review</h2><p>Separate observable facts from checks that still need on-chain verification.</p></div></div></div><div className="balmz-ai-security-grid"><article><span className="balmz-ai-check">01</span><h3>Market availability</h3><p>{token ? "Market pair found by Dexscreener. This does not establish legitimacy." : "Scan a token to check whether market pairs are returned."}</p></article><article><span className="balmz-ai-check">02</span><h3>Liquidity & price</h3><p>{market ? "Selected pair liquidity: " + usd(market.liquidity?.usd) + ". Thin liquidity can increase slippage." : "No verified pair metrics loaded."}</p></article><article><span className="balmz-ai-check">03</span><h3>Authority & holder checks</h3><p>Not yet verified by this module. Solana mint/freeze authorities, holder concentration, BSC ownership, proxy status and sell restrictions require chain-specific analysis.</p></article></div><p className="balmz-ai-disclaimer">A market listing is not a safety guarantee. Do not treat this panel as a complete audit.</p></section>}

    {tab === "AI Reports" && <section className="panel balmz-ai-report-panel"><div className="balmz-ai-panel-title"><div><span className="balmz-ai-icon">✳</span><div><h2>BALMZ AI market report</h2><p>Generate a transparent summary from the currently sourced market metrics.</p></div></div></div><label htmlFor="balmz-report-question">Question or focus (optional)</label><textarea id="balmz-report-question" value={question} onChange={e => setQuestion(e.target.value)} placeholder="e.g. Explain the liquidity and 24-hour price movement…" rows={3}/><button onClick={makeReport} disabled={!market}>Generate sourced report</button>{report && <div className="balmz-ai-report-output"><strong>Metrics-based report</strong><p>{report}</p>{question.trim() && <p><b>Your focus:</b> {question.trim()} — this initial module summarizes verified metrics; it does not claim to run an external LLM or predict future prices.</p>}</div>}</section>}

    <footer className="balmz-ai-footer"><span>Data source: Dexscreener public API{walletBalance ? " · " + walletBalance.source : ""}</span><span>Refresh: 30 seconds when a token is loaded · No fabricated prices or balances</span></footer>
  </section>;
}
