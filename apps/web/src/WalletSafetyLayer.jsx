import { useMemo, useState } from "react";
import { ETHEREUM_NETWORKS, inspectEvmTransaction, normalizeChainId } from "./wallet-safety.js";

const panelStyle = { background: "var(--panel, #111a2d)", border: "1px solid var(--border, #26334d)", borderRadius: 16, padding: 18 };
const mutedStyle = { color: "var(--muted, #9aa8c2)", fontSize: 13 };
const fieldStyle = { width: "100%", boxSizing: "border-box", marginTop: 7, padding: "11px 12px", borderRadius: 9, border: "1px solid var(--border, #34415b)", background: "var(--input, #0b1425)", color: "inherit" };

export default function WalletSafetyLayer() {
  const [network, setNetwork] = useState("ethereum");
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState(null);
  const [to, setTo] = useState("");
  const [value, setValue] = useState("0");
  const [data, setData] = useState("0x");
  const [inspection, setInspection] = useState(null);
  const [contractCode, setContractCode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const selectedNetwork = ETHEREUM_NETWORKS[network];
  const findings = inspection?.findings || [];
  const connectWallet = async () => {
    setMessage(""); setInspection(null);
    const provider = window.ethereum;
    if (!provider?.request) { setMessage("No injected EVM wallet was detected. Open this page in a browser with a compatible wallet."); return; }
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const currentChain = normalizeChainId(await provider.request({ method: "eth_chainId" }));
      setAccount(accounts?.[0] || "");
      setChainId(currentChain);
      setMessage(accounts?.[0] ? "Wallet connected for inspection only. No transaction was requested." : "Wallet returned no account.");
    } catch (error) {
      setMessage(error?.code === 4001 ? "Wallet connection was rejected." : (error?.message || "Wallet connection failed."));
    }
  };

  const inspect = async () => {
    setBusy(true); setMessage(""); setInspection(null); setContractCode(null);
    try {
      const provider = window.ethereum;
      if (!provider?.request) throw new Error("Connect an injected EVM wallet first.");
      const accounts = await provider.request({ method: "eth_accounts" });
      const activeChain = normalizeChainId(await provider.request({ method: "eth_chainId" }));
      const sender = accounts?.[0] || account;
      if (!sender) throw new Error("Connect your wallet before inspecting a transaction.");
      const result = inspectEvmTransaction({ from: sender, to, value, data, expectedChainId: selectedNetwork.chainId, actualChainId: activeChain });
      if (result.valid) {
        const code = await provider.request({ method: "eth_getCode", params: [result.to, "latest"] });
        const deployed = typeof code === "string" && code !== "0x" && !/^0x0*$/.test(code);
        setContractCode({ deployed, bytes: deployed ? Math.max(0, (code.length - 2) / 2) : 0 });
        if (data.trim() === "0x" && deployed) result.findings.push({ severity: "warning", code: "contract_recipient", message: "The destination has contract bytecode. A plain ETH transfer may invoke its receive/fallback behavior." });
        if (data.trim() !== "0x" && !deployed) result.findings.push({ severity: "blocker", code: "no_contract_code", message: "No contract bytecode was found at the destination on the connected network." });
        result.valid = !result.findings.some(item => item.severity === "blocker");
      }
      setAccount(sender); setChainId(activeChain); setInspection(result);
      setMessage(result.valid ? "Inspection completed. This is a preview, not a simulation or safety guarantee." : "Inspection found blocking issues. Do not proceed until they are resolved.");
    } catch (error) { setMessage(error?.message || "Transaction inspection failed."); }
    finally { setBusy(false); }
  };

  const blockerCount = useMemo(() => findings.filter(item => item.severity === "blocker").length, [findings]);
  return <section className="content feature-content">
    <div className="page-heading"><div><p className="eyebrow">ETHEREUM / SECURITY</p><h1>Wallet Safety Layer</h1><p className="muted">Inspect an Ethereum transaction before deciding whether to sign it.</p></div><button type="button" className="secondary" onClick={connectWallet}>Connect wallet</button></div>
    <div className="security-note"><b>Read-only safety boundary:</b> this tool never signs, broadcasts, transfers funds, requests approvals, or stores private keys. A clean inspection does not prove a transaction is safe.</div>
    <div className="feature-grid">
      <article className="panel action-panel" style={panelStyle}>
        <h2>Transaction preview</h2>
        <label>Expected network<select style={fieldStyle} value={network} onChange={event => { setNetwork(event.target.value); setInspection(null); setContractCode(null); }}><option value="ethereum">Ethereum Mainnet · chain ID 1</option><option value="sepolia">Ethereum Sepolia · chain ID 11155111 · testnet</option></select></label>
        <label style={{ display: "block", marginTop: 14 }}>Recipient / contract address<input style={fieldStyle} value={to} onChange={event => setTo(event.target.value)} placeholder="0x…" autoComplete="off" spellCheck="false"/></label>
        <label style={{ display: "block", marginTop: 14 }}>ETH value<input style={fieldStyle} value={value} onChange={event => setValue(event.target.value)} inputMode="decimal" placeholder="0"/></label>
        <label style={{ display: "block", marginTop: 14 }}>Transaction calldata (optional)<textarea style={{ ...fieldStyle, minHeight: 110, fontFamily: "monospace" }} value={data} onChange={event => setData(event.target.value)} placeholder="0x" spellCheck="false"/></label>
        <p style={mutedStyle}>For a native ETH transfer, leave calldata as <code>0x</code>. For contract calls, paste calldata from a trusted source and independently verify its meaning.</p>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}><button type="button" className="primary" disabled={busy || !account} onClick={inspect}>{busy ? "Inspecting…" : "Inspect transaction →"}</button><span style={mutedStyle}>{account ? "Connected: " + account.slice(0, 8) + "…" + account.slice(-6) : "Connect a wallet to inspect its current network."}</span></div>
        {message && <div role="status" className={blockerCount || /failed|rejected|not detected|blocking/i.test(message) ? "feature-error" : "feature-success"} style={{ marginTop: 14 }}>{message}</div>}
      </article>
      <aside className="panel action-panel" style={panelStyle}>
        <h2>Connection status</h2>
        <div className="tool-row"><span>Wallet account</span><strong>{account ? account.slice(0, 10) + "…" + account.slice(-8) : "Not connected"}</strong></div>
        <div className="tool-row"><span>Connected chain ID</span><strong>{chainId == null ? "Unknown" : chainId}</strong></div>
        <div className="tool-row"><span>Expected network</span><strong>{selectedNetwork.label}</strong></div>
        <div className="tool-row"><span>Network match</span><strong>{chainId == null ? "Not checked" : chainId === selectedNetwork.chainId ? "Matches" : "Mismatch"}</strong></div>
        {contractCode && <div className="tool-row"><span>Destination code</span><strong>{contractCode.deployed ? "Contract · " + contractCode.bytes + " bytes" : "No contract code"}</strong></div>}
        <div className="security-note">This check uses the connected wallet's current RPC provider and latest state. Provider responses can be incomplete or malicious; compare important details with a trusted block explorer.</div>
      </aside>
    </div>
    {inspection && <article className="panel action-panel" style={{ ...panelStyle, marginTop: 18 }}>
      <div className="panel-head"><div><h2>Inspection report</h2><span>{inspection.method} · {selectedNetwork.label}</span></div><span className={inspection.valid ? "presale-status-pill" : "presale-status-pill is-warning"}>{inspection.valid ? "No blocking issues" : "Blocked"}</span></div>
      <div className="feature-grid"><div><small>From</small><p><code>{inspection.from || "Invalid"}</code></p></div><div><small>To</small><p><code>{inspection.to || "Invalid"}</code></p></div><div><small>ETH value</small><p><b>{inspection.valueEth} ETH</b></p></div><div><small>Calldata selector</small><p><code>{inspection.selector || "None · native transfer"}</code></p></div></div>
      <div className="security-note">Signing is deliberately unavailable in this safety module. You must independently review the wallet's own confirmation screen before authorizing any transaction.</div>
      {findings.length ? <div className="tool-list">{findings.map((finding, index) => <div className="tool-row" key={finding.code + index}><div><b>{finding.severity.toUpperCase()} · {finding.code.replaceAll("_", " ")}</b><small>{finding.message}</small></div></div>)}</div> : <p className="feature-success">No known issue was detected by these basic checks. This is not an audit or guarantee.</p>}
    </article>}
  </section>;
}
