import { useMemo, useState } from "react";

const NETWORKS = {
  sepolia: {
    label: "Ethereum Sepolia (testnet)",
    chainId: "0xaa36a7",
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
    verify: "https://sepolia.etherscan.io/verifyContract",
  },
  ethereum: {
    label: "Ethereum Mainnet",
    chainId: "0x1",
    rpc: "https://ethereum-rpc.publicnode.com",
    explorer: "https://etherscan.io",
    verify: "https://etherscan.io/verifyContract",
  },
  bnb: {
    label: "BNB Smart Chain",
    chainId: "0x38",
    rpc: "https://bsc-rpc.publicnode.com",
    explorer: "https://bscscan.com",
    verify: "https://bscscan.com/verifyContract",
  },
};

const cleanSolidityString = value =>
  String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, " ");

const styles = `
.contract-tools{display:grid;gap:16px}
.contract-tools .ct-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.contract-tools .ct-tab{background:#0d172b;border:1px solid #1a2a46;color:#8da0bb;border-radius:8px;padding:10px 14px;font-size:11px}
.contract-tools .ct-tab.active{border-color:#00bde8;background:#10233d;color:#fff}
.contract-tools .ct-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}
.contract-tools .ct-panel{border:1px solid #192943;background:linear-gradient(145deg,#0d192e,#0a1427);border-radius:12px;padding:18px;min-width:0}
.contract-tools h2{font-size:14px;margin:0 0 8px}.contract-tools p{font-size:11px;color:#8293ad;line-height:1.65}
.contract-tools label{display:grid;gap:7px;color:#8da0bb;font-size:10px;margin:13px 0}
.contract-tools input,.contract-tools select{width:100%;min-width:0;background:#071124;border:1px solid #263b59;color:#fff;border-radius:7px;padding:11px;font:inherit;font-size:11px}
.contract-tools .ct-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.contract-tools .ct-btn{background:#10233d;border:1px solid #284364;border-radius:7px;padding:10px 13px;font-size:10px;color:#d9e7f8}
.contract-tools .ct-btn.primary{background:linear-gradient(135deg,#00bde8,#008cc9);color:#fff;border:0}
.contract-tools .ct-code{white-space:pre;overflow:auto;max-height:510px;background:#050b17;border:1px solid #172740;border-radius:8px;padding:14px;font:10px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:#b8d7ef}
.contract-tools .ct-status{padding:12px;border-radius:8px;border:1px solid #244360;background:#0a1b2e;color:#b8d7ef;font-size:11px;line-height:1.6;overflow-wrap:anywhere;margin:12px 0}
.contract-tools .ct-status.good{border-color:#1e6249;color:#9ce8c0;background:#092319}
.contract-tools .ct-status.bad{border-color:#73364a;color:#ffb8c5;background:#2a101a}
.contract-tools .ct-links{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
.contract-tools a{color:#00d4ff;font-size:11px;text-decoration:none}.contract-tools a:hover{text-decoration:underline}
.contract-tools .ct-note{font-size:10px;color:#71839d;border-left:2px solid #d4af37;padding:9px 11px;background:#0b1424;border-radius:0 6px 6px 0}
@media(max-width:800px){.contract-tools .ct-layout{grid-template-columns:1fr}.contract-tools .ct-panel{padding:14px}}
`;

export default function ContractTools({ active, setActive }) {
  const [tokenName, setTokenName] = useState("My Token");
  const [tokenSymbol, setTokenSymbol] = useState("MTK");
  const [supply, setSupply] = useState("1000000");
  const [decimals, setDecimals] = useState("18");
  const [generatorMessage, setGeneratorMessage] = useState("");
  const [network, setNetwork] = useState("sepolia");
  const [rpcUrl, setRpcUrl] = useState(NETWORKS.sepolia.rpc);
  const [address, setAddress] = useState("");
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkResult, setCheckResult] = useState(null);

  const source = useMemo(() => {
    const name = cleanSolidityString(tokenName.trim() || "My Token");
    const symbol = cleanSolidityString(tokenSymbol.trim() || "MTK");
    const wholeSupply = String(Math.floor(Number(supply) || 0));
    const tokenDecimals = String(Math.floor(Number(decimals) || 0));
    return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * Generated ERC-20 starter contract.
 * Fixed initial supply; no owner-only mint function.
 * Review and test the source before deploying.
 */
contract ${symbol.replace(/[^A-Za-z0-9_]/g, "") || "MyToken"} is ERC20 {
    uint256 public constant INITIAL_SUPPLY = ${wholeSupply} * 10 ** ${tokenDecimals};

    constructor() ERC20("${name}", "${symbol}") {
        _mint(msg.sender, INITIAL_SUPPLY);
    }
}
`;
  }, [tokenName, tokenSymbol, supply, decimals]);

  const selectedNetwork = NETWORKS[network] || NETWORKS.sepolia;

  function generateSource() {
    const name = tokenName.trim();
    const symbol = tokenSymbol.trim();
    const numericSupply = Number(supply);
    const numericDecimals = Number(decimals);
    if (!name || name.length > 64) return setGeneratorMessage("Enter a token name of 1–64 characters.");
    if (!/^[A-Za-z][A-Za-z0-9]{1,10}$/.test(symbol)) return setGeneratorMessage("Token symbol must start with a letter and contain 2–11 letters or numbers.");
    if (!Number.isSafeInteger(numericSupply) || numericSupply < 1 || numericSupply > 1000000000000000) return setGeneratorMessage("Enter a whole-token supply from 1 to 1,000,000,000,000,000.");
    if (!Number.isInteger(numericDecimals) || numericDecimals < 0 || numericDecimals > 18) return setGeneratorMessage("Decimals must be a whole number from 0 to 18.");
    setGeneratorMessage("Source generated. Review it, compile and test it, then deploy only to a network you selected.");
  }

  async function copySource() {
    try {
      await navigator.clipboard.writeText(source);
      setGeneratorMessage("Solidity source copied to clipboard.");
    } catch {
      setGeneratorMessage("Clipboard access is unavailable. Select and copy the source from the preview.");
    }
  }

  function downloadSource() {
    const contractName = tokenSymbol.trim().replace(/[^A-Za-z0-9_]/g, "") || "MyToken";
    const blob = new Blob([source], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = contractName + ".sol";
    link.click();
    URL.revokeObjectURL(url);
    setGeneratorMessage("Solidity source download prepared. Compile and test before deploying.");
  }

  async function inspectContract() {
    setCheckBusy(true);
    setCheckResult(null);
    try {
      const cleanAddress = address.trim();
      if (!/^0x[a-fA-F0-9]{40}$/.test(cleanAddress)) throw new Error("Enter a valid 0x contract address (42 characters).");
      let parsedRpc;
      try { parsedRpc = new URL(rpcUrl.trim()); } catch { throw new Error("Enter a valid HTTPS RPC URL."); }
      if (parsedRpc.protocol !== "https:") throw new Error("Use an HTTPS RPC endpoint for this check.");
      const call = async (method, params) => {
        const response = await fetch(rpcUrl.trim(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error?.message || "RPC request failed (" + response.status + ").");
        return data.result;
      };
      const chainId = await call("eth_chainId", []);
      if (String(chainId).toLowerCase() !== selectedNetwork.chainId) {
        throw new Error("RPC chain ID mismatch. Expected " + selectedNetwork.chainId + " but endpoint returned " + chainId + ".");
      }
      const bytecode = await call("eth_getCode", [cleanAddress, "latest"]);
      if (!bytecode || bytecode === "0x" || bytecode === "0x0") {
        setCheckResult({ kind: "bad", title: "No contract bytecode found", detail: "This address has no deployed contract code on " + selectedNetwork.label + ". Confirm the network and address." });
      } else {
        setCheckResult({ kind: "good", title: "Contract bytecode found", detail: "Deployed bytecode was returned by the selected chain RPC. This does not prove the source code is verified, safe, or audited." });
      }
    } catch (error) {
      setCheckResult({ kind: "bad", title: "Contract check failed", detail: error.message || "Unable to query the selected RPC endpoint." });
    } finally {
      setCheckBusy(false);
    }
  }

  function changeNetwork(value) {
    setNetwork(value);
    setRpcUrl(NETWORKS[value].rpc);
    setCheckResult(null);
  }

  return <section className="content feature-content contract-tools">
    <style>{styles}</style>
    <div className="page-heading">
      <div><p className="eyebrow">SMART CONTRACT WORKSPACE</p><h1>{active}</h1><p className="muted">Generate ERC-20 starter source and inspect deployed bytecode on supported EVM networks.</p></div>
      <button className="secondary" onClick={() => setActive("Dashboard")}>← Dashboard</button>
    </div>
    <div className="ct-tabs">
      <button className={"ct-tab " + (active === "Contract Generator" ? "active" : "")} onClick={() => setActive("Contract Generator")}>Contract Generator</button>
      <button className={"ct-tab " + (active === "Verify Contract" ? "active" : "")} onClick={() => setActive("Verify Contract")}>Verify Contract</button>
    </div>

    {active === "Contract Generator" ? <div className="ct-layout">
      <article className="ct-panel">
        <h2>ERC-20 token generator</h2>
        <p>Create a fixed-initial-supply Solidity starter contract. It does not deploy anything or create a token address until you compile and deploy it on-chain.</p>
        <label>Token name<input value={tokenName} maxLength={64} onChange={e => setTokenName(e.target.value)} placeholder="My Token"/></label>
        <label>Token symbol<input value={tokenSymbol} maxLength={11} onChange={e => setTokenSymbol(e.target.value)} placeholder="MTK"/></label>
        <label>Initial supply (whole tokens)<input type="number" min="1" max="1000000000000000" step="1" value={supply} onChange={e => setSupply(e.target.value)}/></label>
        <label>Decimals<select value={decimals} onChange={e => setDecimals(e.target.value)}>{Array.from({length:19},(_,i)=><option key={i} value={String(i)}>{i}{i===18?" (standard ERC-20)":""}</option>)}</select></label>
        <div className="ct-actions"><button className="ct-btn primary" onClick={generateSource}>Validate &amp; generate</button><button className="ct-btn" onClick={copySource}>Copy source</button><button className="ct-btn" onClick={downloadSource}>Download .sol</button></div>
        {generatorMessage && <div className="ct-status">{generatorMessage}</div>}
        <div className="ct-note">Security: source generation happens in this browser. Never paste a private key, seed phrase, API secret or wallet password here. Have the contract reviewed and test it on Sepolia before any mainnet deployment.</div>
      </article>
      <article className="ct-panel">
        <h2>Solidity preview</h2>
        <p>OpenZeppelin ERC-20 implementation • Solidity 0.8.24 • fixed initial supply</p>
        <pre className="ct-code"><code>{source}</code></pre>
        <div className="ct-links"><a href="https://remix.ethereum.org/" target="_blank" rel="noreferrer">Open Remix IDE ↗</a><a href="https://docs.openzeppelin.com/contracts/5.x/erc20" target="_blank" rel="noreferrer">OpenZeppelin ERC-20 docs ↗</a></div>
      </article>
    </div> : <div className="ct-layout">
      <article className="ct-panel">
        <h2>Inspect deployed contract</h2>
        <p>Check the selected RPC chain and whether bytecode exists at the address. Source-code verification must be completed through the explorer.</p>
        <label>Network<select value={network} onChange={e => changeNetwork(e.target.value)}>{Object.entries(NETWORKS).map(([key,item])=><option key={key} value={key}>{item.label}</option>)}</select></label>
        <label>RPC URL<input value={rpcUrl} onChange={e => {setRpcUrl(e.target.value);setCheckResult(null)}} spellCheck={false} placeholder="https://…"/></label>
        <label>Contract address<input value={address} onChange={e => {setAddress(e.target.value);setCheckResult(null)}} spellCheck={false} placeholder="0x…"/></label>
        <div className="ct-actions"><button className="ct-btn primary" onClick={inspectContract} disabled={checkBusy}>{checkBusy ? "Checking chain…" : "Check deployed bytecode"}</button><a className="ct-btn" href={selectedNetwork.explorer + "/address/" + encodeURIComponent(address.trim())} target="_blank" rel="noreferrer">Open address on explorer ↗</a></div>
        {checkResult && <div className={"ct-status " + checkResult.kind}><strong>{checkResult.title}</strong><br/>{checkResult.detail}</div>}
        <div className="ct-note">This check does not submit a verification transaction and does not claim that source code is verified. It only queries public chain data. Use an explorer to publish matching source and compiler settings.</div>
      </article>
      <article className="ct-panel">
        <h2>Verify &amp; publish source</h2>
        <p>After compiling the exact source with matching compiler version, optimizer settings and constructor arguments, submit it to the explorer's verification form.</p>
        <div className="ct-status">Selected network: <strong>{selectedNetwork.label}</strong><br/>RPC chain ID: <code>{selectedNetwork.chainId}</code></div>
        <div className="ct-actions"><a className="ct-btn primary" href={selectedNetwork.verify + (address.trim() ? "?a=" + encodeURIComponent(address.trim()) : "")} target="_blank" rel="noreferrer">Open source verification ↗</a><a className="ct-btn" href="https://remix.ethereum.org/" target="_blank" rel="noreferrer">Compile in Remix ↗</a></div>
        <div className="ct-links"><a href={selectedNetwork.explorer} target="_blank" rel="noreferrer">Open {selectedNetwork.label} explorer ↗</a>{network === "sepolia" && <a href="https://sepoliafaucet.com/" target="_blank" rel="noreferrer">Sepolia faucet ↗</a>}</div>
      </article>
    </div>}
  </section>;
}
