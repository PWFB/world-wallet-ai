import { useCallback, useEffect, useMemo, useState } from "react";
import "./BalmzAI.css";

const DEFAULT_JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
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

export default function BalmzAI() {
  const [chain, setChain] = useState("solana");
  const [tab, setTab] = useState("Overview");
  const [address, setAddress] = useState(DEFAULT_JUP);
  const [token, setToken] = useState(null);
  const [pairs, setPairs] = useState([]);
  const [market, setMarket] = useState(null);
  const [wallet, setWallet] = useState("");
  const [walletBalance, setWalletBalance] = useState(null);
  const [loading, setLoading] = useState(false);
  const [walletLoading, setWalletLoading] = useState(false);
  const [error, setError] = useState("");
  const [walletError, setWalletError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(null);
  const [question, setQuestion] = useState("");
  const [report, setReport] = useState("");

  const scanToken = useCallback(async (target = address, network = chain) => {
    const clean = target.trim();
    if (!clean) { setError("Enter a token mint or contract address."); return; }
    setLoading(true); setError("");
    try {
      const result = await readJson("https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(clean));
      const chainId = network === "solana" ? "solana" : "bsc";
      const found = (result.pairs || []).filter(pair => pair.chainId === chainId);
      if (!found.length) {
        setToken(null); setPairs([]);
        throw new Error("No matching " + (network === "solana" ? "Solana" : "BNB Smart Chain") + " market data was returned for this address. Confirm the network and address.");
      }
      found.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
      const best = found[0];
      const base = best.baseToken?.address?.toLowerCase() === clean.toLowerCase() ? best.baseToken : best.baseToken;
      setToken({ address: clean, name: base?.name || best.baseToken?.name || "Unknown token", symbol: base?.symbol || best.baseToken?.symbol || "—", chain: network, pairAddress: best.pairAddress, dex: best.dexId, url: best.url });
      setPairs(found.slice(0, 8));
      setMarket(best);
      setUpdatedAt(new Date().toISOString());
    } catch (e) {
      setError(e?.message || "Unable to retrieve token data.");
    } finally { setLoading(false); }
  }, [address, chain]);

  useEffect(() => { scanToken(DEFAULT_JUP, "solana"); }, []); // Initial data is sourced live from Dexscreener.
  useEffect(() => {
    if (!token) return undefined;
    const id = setInterval(() => scanToken(token.address, token.chain), 30000);
    return () => clearInterval(id);
  }, [token?.address, token?.chain, scanToken]);

  const connectWallet = async () => {
    setWalletError(""); setWalletBalance(null); setWalletLoading(true);
    try {
      if (chain === "solana") {
        const provider = window.solana;
        if (!provider?.connect) throw new Error("A Solana wallet such as Phantom is not available in this browser.");
        const result = await provider.connect();
        const pubkey = result?.publicKey?.toString?.() || provider.publicKey?.toString?.();
        if (!pubkey) throw new Error("Wallet did not return a public address.");
        setWallet(pubkey);
        const rpc = await readJson(SOL_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [pubkey, { commitment: "confirmed" }] }) });
        if (rpc.error) throw new Error(rpc.error.message || "Solana RPC balance lookup failed.");
        setWalletBalance({ amount: Number(rpc.result.value) / 1e9, asset: "SOL", source: "Solana mainnet RPC" });
      } else {
        const provider = window.ethereum;
        if (!provider?.request) throw new Error("An EVM wallet such as MetaMask is not available in this browser.");
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x38" }] });
        const accounts = await provider.request({ method: "eth_requestAccounts" });
        if (!accounts?.[0]) throw new Error("Wallet did not return a public address.");
        setWallet(accounts[0]);
        const raw = await readJson(BSC_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [accounts[0], "latest"] }) });
        if (raw.error) throw new Error(raw.error.message || "BSC RPC balance lookup failed.");
        setWalletBalance({ amount: Number(BigInt(raw.result)) / 1e18, asset: "BNB", source: "BNB Smart Chain mainnet RPC" });
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

  function makeReport() {
    if (!market || !token) { setReport("Scan a token with available market data before generating a report."); return; }
    const change = market.priceChange?.h24;
    setReport(token.name + " (" + token.symbol + ") on " + (chain === "solana" ? "Solana" : "BNB Smart Chain") + ". Price: " + usd(market.priceUsd) + "; 24h volume: " + usd(market.volume?.h24) + "; pair liquidity: " + usd(market.liquidity?.usd) + "; 24h pair change: " + (change == null ? "unavailable" : fmt(change) + "%") + ". Source: Dexscreener. This is a metrics summary, not a security audit or investment recommendation. Holder concentration, mint/freeze authority and contract behavior require separate verified on-chain checks.");
  }

  return <section className="balmz-ai-page">
    <header className="balmz-ai-heading">
      <div><p className="balmz-ai-eyebrow">WORLD WALLET AI · INTELLIGENCE</p><h1><span>BALMZ</span> AI</h1><p>Multi-chain token intelligence, wallet insights and market monitoring.</p></div>
      <div className="balmz-ai-live"><i /> Live market source <small>{updatedAt ? "Updated " + new Date(updatedAt).toLocaleTimeString() : "Waiting for data"}</small></div>
    </header>

    <nav className="balmz-ai-tabs" aria-label="BALMZ AI modules">
      {["Overview", "Token Scanner", "Portfolio", "Security", "AI Reports"].map(item => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}
    </nav>

    <div className="balmz-ai-chainbar">
      <div><span className="balmz-ai-status-dot" /> Network</div>
      <div className="balmz-ai-chain-select">
        <button className={chain === "solana" ? "active" : ""} onClick={() => { setChain("solana"); setAddress(DEFAULT_JUP); setToken(null); setPairs([]); setMarket(null); }}>Solana Mainnet</button>
        <button className={chain === "bsc" ? "active" : ""} onClick={() => { setChain("bsc"); setAddress(""); setToken(null); setPairs([]); setMarket(null); }}>BNB Smart Chain</button>
      </div>
      <span className="balmz-ai-chain-note">Read-only public data · No trading permissions</span>
    </div>

    {(tab === "Overview" || tab === "Token Scanner") && <div className="balmz-ai-scan panel">
      <div className="balmz-ai-panel-title"><div><span className="balmz-ai-icon">⌕</span><div><h2>Token scanner</h2><p>Look up a mint or contract address using live decentralized-exchange market data.</p></div></div><span className="balmz-ai-source">SOURCE · DEXSCREENER</span></div>
      <form className="balmz-ai-search" onSubmit={e => { e.preventDefault(); scanToken(); }}>
        <input aria-label="Token mint or contract address" value={address} onChange={e => setAddress(e.target.value)} placeholder={chain === "solana" ? "Solana token mint address" : "BSC token contract address"} />
        <button type="submit" disabled={loading}>{loading ? "Scanning…" : "Scan token"}</button>
      </form>
      {error && <p className="balmz-ai-error" role="alert">{error}</p>}
      {token && <div className="balmz-ai-token-summary"><div className="balmz-ai-token-mark">{token.symbol.slice(0, 1).toUpperCase()}</div><div className="balmz-ai-token-name"><h3>{token.name} <span>{token.symbol}</span></h3><p>{short(token.address)} · {token.chain === "solana" ? "Solana" : "BNB Smart Chain"} · {market?.dexId || "DEX market"}</p></div><a href={market?.url} target="_blank" rel="noreferrer">Open pair ↗</a></div>}
      <div className="balmz-ai-metrics">{metrics.map(m => <article key={m.label}><small>{m.label}</small><strong>{m.value}</strong><span>{m.note}</span></article>)}</div>
      <div className="balmz-ai-data-foot">Market values reflect the selected pair and may differ across exchanges. Missing data is shown as unavailable.</div>
    </div>}

    {(tab === "Overview" || tab === "Portfolio") && <div className="balmz-ai-columns">
      <section className="panel balmz-ai-wallet-panel"><div className="balmz-ai-panel-title"><div><span className="balmz-ai-icon">◈</span><div><h2>Wallet portfolio</h2><p>Connect a wallet to query its native coin balance.</p></div></div><span className="balmz-ai-source">ON-CHAIN RPC</span></div>
        {!wallet ? <div className="balmz-ai-connect"><div className="balmz-ai-wallet-art">◎</div><h3>Connect your {chain === "solana" ? "Solana" : "EVM"} wallet</h3><p>Only your public address and native coin balance are read. No private key is requested.</p><button onClick={connectWallet} disabled={walletLoading}>{walletLoading ? "Connecting…" : "Connect wallet"}</button></div> : <div className="balmz-ai-wallet-result"><small>CONNECTED ADDRESS</small><strong>{short(wallet)}</strong><small>NATIVE BALANCE · {walletBalance?.source || "Loading"}</small><strong>{walletBalance ? fmt(walletBalance.amount, 8) + " " + walletBalance.asset : "Unavailable"}</strong><button className="balmz-ai-text-button" onClick={() => { setWallet(""); setWalletBalance(null); }}>Disconnect view</button></div>}
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
