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
  const [conversation, setConversation] = useState([]);
  const [assistantError, setAssistantError] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [includeWalletContext, setIncludeWalletContext] = useState(false);
  const [bankInstitutions, setBankInstitutions] = useState([]);
  const [bankSearch, setBankSearch] = useState("");
  const [selectedBankId, setSelectedBankId] = useState("");
  const [selectedBankAuthMethod, setSelectedBankAuthMethod] = useState("");
  const [bankDirectoryLoading, setBankDirectoryLoading] = useState(false);
  const [bankLinkBusy, setBankLinkBusy] = useState(false);
  const [bankError, setBankError] = useState("");
  const [bankMessage, setBankMessage] = useState("");
  const [bankLinkReference, setBankLinkReference] = useState("");
  const [bankLinkStatus, setBankLinkStatus] = useState("");

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
        const networkLabel = network === "solana" ? "Solana" : network === "bsc" ? "BNB Smart Chain" : "Ethereum";
        throw new Error("No matching " + networkLabel + " market data was returned for this address. Confirm the network and address.");
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


  const bankAuthHeaders = { Authorization: "Bearer " + accessToken, Accept: "application/json" };

  async function loadBankDirectory() {
    if (!accessToken || !apiBaseUrl) { setBankError("Sign in to connect a bank account."); return; }
    setBankDirectoryLoading(true); setBankError(""); setBankMessage("");
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/mono-bankconnect/institutions", {
        headers: bankAuthHeaders,
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "The supported bank directory could not be loaded.");
      const items = Array.isArray(data.institutions) ? data.institutions : [];
      setBankInstitutions(items);
      setSelectedBankId(current => items.some(item => item.id === current) ? current : (items[0]?.id || ""));
      setSelectedBankAuthMethod(current => {
        const selected = items.find(item => item.id === selectedBankId) || items[0];
        return selected?.auth_methods?.includes(current) ? current : (selected?.auth_methods?.[0] || "");
      });
      setBankMessage(items.length
        ? "Loaded " + items.length.toLocaleString() + " Nigerian institutions from Mono's live directory."
        : "Mono returned no Nigerian institutions for the configured product and account.");
    } catch (cause) {
      setBankError(cause?.message || "Unable to load the supported bank list.");
      setBankInstitutions([]);
    } finally { setBankDirectoryLoading(false); }
  }

  async function refreshBankLinkStatus(reference = bankLinkReference) {
    if (!reference || !accessToken || !apiBaseUrl) return;
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/mono-bankconnect/link-status/" + encodeURIComponent(reference), {
        headers: bankAuthHeaders,
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Bank connection status is unavailable.");
      setBankLinkStatus(data.status || "pending_provider_auth");
      if (data.status === "connected" || data.status === "data_available") {
        setBankMessage(data.institution_name + " authentication was confirmed by Mono.");
      } else if (data.status === "pending_provider_auth") {
        setBankMessage("Returned from Mono. Waiting for the signed provider confirmation; the bank login is not marked complete until that arrives.");
      } else if (data.status === "failed") {
        setBankError("Mono reported that the selected bank connection could not be completed.");
      }
    } catch (cause) {
      setBankError(cause?.message || "Could not confirm the selected bank connection.");
    }
  }

  async function startBankAuthentication() {
    const selected = bankInstitutions.find(item => item.id === selectedBankId);
    if (!selected) { setBankError("Choose a bank from the live directory first."); return; }
    if (!selectedBankAuthMethod || !selected.auth_methods?.includes(selectedBankAuthMethod)) {
      setBankError("Choose an authentication method offered for this bank.");
      return;
    }
    setBankLinkBusy(true); setBankError(""); setBankMessage("");
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/mono-bankconnect/initiate", {
        method: "POST",
        headers: { ...bankAuthHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ institution_id: selected.id, auth_method: selectedBankAuthMethod }),
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Could not start secure bank authentication.");
      const destination = String(data.redirect_url || "");
      if (!destination.startsWith("https://link.mono.co/")) throw new Error("Mono did not return an approved hosted authentication link.");
      setBankLinkReference(data.reference || "");
      setBankMessage(data.message || "Opening Mono's hosted bank authentication.");
      window.location.assign(destination);
    } catch (cause) {
      setBankError(cause?.message || "Could not start secure bank authentication.");
      setBankLinkBusy(false);
    }
  }

  useEffect(() => {
    if (tab !== "Banking") return undefined;
    let active = true;
    loadBankDirectory().then(() => {});
    return () => { active = false; };
  }, [tab, accessToken, apiBaseUrl]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("balmz_bank_return") !== "1") return;
    const reference = params.get("bank_ref") || "";
    if (!reference) return;
    setTab("Banking");
    setBankLinkReference(reference);
    setBankMessage("Bank provider returned you to BALMZ AI. Checking the signed connection result.");
    window.history.replaceState({}, document.title, window.location.pathname);
    refreshBankLinkStatus(reference);
  }, [accessToken, apiBaseUrl]);

  const filteredBankInstitutions = useMemo(() => {
    const query = bankSearch.trim().toLocaleLowerCase();
    if (!query) return bankInstitutions;
    return bankInstitutions.filter(item => item.name.toLocaleLowerCase().includes(query));
  }, [bankInstitutions, bankSearch]);

  const selectedBank = bankInstitutions.find(item => item.id === selectedBankId) || null;

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
    if (!accessToken || !apiBaseUrl) { setAssistantError("Sign in to use the BALMZ AI assistant."); return; }
    const history = conversation.slice(-20).map(message => ({ role: message.role, content: message.text }));
    setAiLoading(true);
    setAssistantError("");
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
        body: JSON.stringify({
          question: prompt,
          conversation_history: history,
          include_wallet_context: includeWalletContext,
          market_context: marketContext,
        }),
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "BALMZ AI could not generate a response.");
      const answer = typeof data.answer === "string" ? data.answer.trim() : "";
      if (!answer) throw new Error("BALMZ AI returned an empty response.");
      setConversation(current => [...current, { role: "user", text: prompt }, { role: "model", text: answer }].slice(-20));
      setQuestion(current => current === prompt ? "" : current);
    } catch (cause) {
      setAssistantError(cause?.message || "BALMZ AI request failed. Check backend Gemini configuration and try again.");
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
      {["Overview", "Token Scanner", "Portfolio", "Banking", "Security", "AI Reports"].map(item => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}
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
      {token && <div className="balmz-ai-token-summary"><div className="balmz-ai-token-mark">{token.symbol.slice(0, 1).toUpperCase()}</div><div className="balmz-ai-token-name"><h3>{token.name} <span>{token.symbol}</span></h3><p>{short(token.address)} · {token.chain === "solana" ? "Solana" : token.chain === "bsc" ? "BNB Smart Chain" : "Ethereum"} · {market?.dexId || "DEX market"}</p></div><a href={market?.url} target="_blank" rel="noreferrer">Open pair ↗</a></div>}
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


    {tab === "Banking" && <section className="panel balmz-ai-banking">
      <div className="balmz-ai-panel-title">
        <div><span className="balmz-ai-icon">▤</span><div><h2>Connect your bank</h2><p>Select an institution from Mono's live Nigeria directory. The next step opens Mono's hosted authentication.</p></div></div>
        <span className="balmz-ai-source">MONO · NIGERIA</span>
      </div>
      <div className="balmz-ai-bank-security-note">
        <strong>Bank login stays with your bank and Mono.</strong>
        <span>BALMZ AI does not ask for, receive, or store your bank password or bank-issued OTP. The selected bank/provider verifies those credentials in its hosted flow.</span>
      </div>
      <div className="balmz-ai-bank-toolbar">
        <input type="search" value={bankSearch} onChange={event => setBankSearch(event.target.value)} placeholder="Search supported banks" aria-label="Search supported banks" />
        <button type="button" onClick={loadBankDirectory} disabled={bankDirectoryLoading}>{bankDirectoryLoading ? "Loading…" : "Refresh bank list"}</button>
      </div>
      {bankDirectoryLoading && <div className="balmz-ai-empty" role="status">Loading the live bank directory…</div>}
      {!bankDirectoryLoading && filteredBankInstitutions.length > 0 && <div className="balmz-ai-bank-list" role="listbox" aria-label="Supported Nigerian banks">
        {filteredBankInstitutions.map(item => <button
          type="button"
          role="option"
          aria-selected={selectedBankId === item.id}
          key={item.id}
          className={"balmz-ai-bank-option" + (selectedBankId === item.id ? " selected" : "")}
          onClick={() => {
            setSelectedBankId(item.id);
            setSelectedBankAuthMethod(item.auth_methods?.[0] || "");
            setBankError("");
          }}
        >
          <span className="balmz-ai-bank-icon">{item.icon ? <img src={item.icon} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = "none"; }} /> : <b>{item.name.slice(0, 1).toUpperCase()}</b>}</span>
          <span className="balmz-ai-bank-details"><strong>{item.name}</strong><small>{item.type || "Financial institution"}</small></span>
          <span className="balmz-ai-bank-check">{selectedBankId === item.id ? "✓" : "›"}</span>
        </button>)}
      </div>}
      {!bankDirectoryLoading && bankSearch.trim() && filteredBankInstitutions.length === 0 && <div className="balmz-ai-empty">No supported bank matches that search. Refresh the provider directory or check the bank name.</div>}
      {!bankDirectoryLoading && bankInstitutions.length === 0 && !bankError && <div className="balmz-ai-empty">The bank directory will appear when the Mono provider key is configured on the backend.</div>}
      {selectedBank && <div className="balmz-ai-bank-selected">
        <div><small>SELECTED BANK</small><strong>{selectedBank.name}</strong></div>
        <label>Available authentication method
          <select value={selectedBankAuthMethod} onChange={event => setSelectedBankAuthMethod(event.target.value)}>
            {(selectedBank.auth_methods || []).map(method => <option key={method} value={method}>{method.replace(/_/g, " ")}</option>)}
          </select>
        </label>
        <button type="button" className="balmz-ai-primary" disabled={bankLinkBusy || !selectedBankAuthMethod} onClick={startBankAuthentication}>{bankLinkBusy ? "Opening secure bank login…" : "Continue securely to " + selectedBank.name + " →"}</button>
      </div>}
      {bankMessage && <p className="balmz-ai-bank-message" role="status">{bankMessage}</p>}
      {bankError && <p className="balmz-ai-error" role="alert">{bankError}</p>}
      {bankLinkReference && <button type="button" className="balmz-ai-text-button" onClick={() => refreshBankLinkStatus()} disabled={bankLinkStatus === "connected" || bankLinkStatus === "data_available"}>Check provider connection status</button>}
      <p className="balmz-ai-data-foot">The bank list is supplied by Mono and may vary by institution, supported authentication method, provider coverage and environment. An institution is not marked connected until Mono confirms it through the signed webhook.</p>
    </section>}

    {tab === "Security" && <section className="panel balmz-ai-security"><div className="balmz-ai-panel-title"><div><span className="balmz-ai-icon">⌑</span><div><h2>Security review</h2><p>Separate observable facts from checks that still need on-chain verification.</p></div></div></div><div className="balmz-ai-security-grid"><article><span className="balmz-ai-check">01</span><h3>Market availability</h3><p>{token ? "Market pair found by Dexscreener. This does not establish legitimacy." : "Scan a token to check whether market pairs are returned."}</p></article><article><span className="balmz-ai-check">02</span><h3>Liquidity & price</h3><p>{market ? "Selected pair liquidity: " + usd(market.liquidity?.usd) + ". Thin liquidity can increase slippage." : "No verified pair metrics loaded."}</p></article><article><span className="balmz-ai-check">03</span><h3>Authority & holder checks</h3><p>Not yet verified by this module. Solana mint/freeze authorities, holder concentration, BSC ownership, proxy status and sell restrictions require chain-specific analysis.</p></article></div><p className="balmz-ai-disclaimer">A market listing is not a safety guarantee. Do not treat this panel as a complete audit.</p></section>}

    {tab === "AI Reports" && <section className="panel balmz-ai-report-panel"><div className="balmz-ai-panel-title"><div><span className="balmz-ai-icon">✳</span><div><h2>Ask BALMZ AI</h2><p>Continue a conversation with the same secured BALMZ AI service used by the Android APT.</p></div></div><button type="button" className="balmz-ai-chat-reset" onClick={() => { setConversation([]); setAssistantError(""); }} disabled={aiLoading || conversation.length === 0}>New conversation</button></div><div className="balmz-ai-chat-transcript" role="log" aria-label="BALMZ AI conversation" aria-live="polite">{conversation.length === 0 ? <p className="balmz-ai-empty">Ask a question about your wallet, token markets, security or supported features. Follow-up questions will use this conversation.</p> : conversation.map((message, index) => <article key={index} className={"balmz-ai-chat-message " + (message.role === "user" ? "is-user" : "is-assistant")}><strong>{message.role === "user" ? "YOU" : "BALMZ AI"}</strong><p>{message.text}</p></article>)}{aiLoading && <p className="balmz-ai-chat-pending">BALMZ AI is responding…</p>}</div><label htmlFor="balmz-report-question">Your message</label><textarea id="balmz-report-question" value={question} onChange={e => setQuestion(e.target.value)} placeholder="Ask a question or continue the conversation…" rows={3}/><label className="balmz-ai-context-consent"><input type="checkbox" checked={includeWalletContext} onChange={e => setIncludeWalletContext(e.target.checked)} /> Include my verified Mainnet balance snapshot in this request</label><p className="balmz-ai-data-foot">When checked, verified balance amounts are sent to Google Gemini for this answer. Wallet addresses, transaction hashes, PINs, recovery phrases and private keys are never included. Leave unchecked for a general question.</p><button onClick={makeReport} disabled={aiLoading || !accessToken}>{aiLoading ? "BALMZ AI is thinking…" : "Send message"}</button>{assistantError && <p className="balmz-ai-error" role="alert">{assistantError}</p>}</section>}

    <footer className="balmz-ai-footer"><span>Data source: Dexscreener public API{walletBalance ? " · " + walletBalance.source : ""}</span><span>Refresh: 30 seconds when a token is loaded · No fabricated prices or balances</span></footer>
  </section>;
}
