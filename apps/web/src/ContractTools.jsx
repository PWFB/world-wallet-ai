import { useEffect, useMemo, useState } from "react";
import solc from "solc";
import { BrowserProvider, ContractFactory } from "ethers";

const DEPLOYED_CONTRACTS_KEY = "world_wallet_deployed_contracts_v1";
const readDeployedContracts = () => { try { const v = JSON.parse(localStorage.getItem(DEPLOYED_CONTRACTS_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };

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
  const [showCreateCard, setShowCreateCard] = useState(false);
  const [loadAddress, setLoadAddress] = useState("");
  const [deployBusy, setDeployBusy] = useState(false);
  const [deployedContracts, setDeployedContracts] = useState(() => readDeployedContracts());
  const [deployedAddress, setDeployedAddress] = useState("");
  useEffect(() => { setDeployedContracts(readDeployedContracts()); }, []);

  const source = useMemo(() => {
    const name = cleanSolidityString(tokenName.trim() || "My Token");
    const symbol = cleanSolidityString(tokenSymbol.trim() || "MTK");
    const wholeSupply = String(Math.floor(Number(supply) || 0));
    const tokenDecimals = String(Math.floor(Number(decimals) || 0));
    return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * World Wallet AI generated ERC-20.
 * Fixed initial supply, standard transfers and allowances, no owner mint.
 * Generated source is not an audit or guarantee of safety.
 */
contract ${symbol.replace(/[^A-Za-z0-9_]/g, "") || "MyToken"} {
    string public name = "${name}";
    string public symbol = "${symbol}";
    uint8 public immutable decimals = ${tokenDecimals};
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        uint256 initial = ${wholeSupply} * (10 ** uint256(decimals));
        totalSupply = initial;
        balanceOf[msg.sender] = initial;
        emit Transfer(address(0), msg.sender, initial);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(to != address(0), "zero recipient");
        require(balanceOf[msg.sender] >= value, "insufficient balance");
        unchecked { balanceOf[msg.sender] -= value; balanceOf[to] += value; }
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        require(to != address(0), "zero recipient");
        require(balanceOf[from] >= value, "insufficient balance");
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "allowance exceeded");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        unchecked { balanceOf[from] -= value; balanceOf[to] += value; }
        emit Transfer(from, to, value);
        return true;
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
    if (!name || name.length > 64) { setGeneratorMessage("Enter a token name of 1–64 characters."); return false; }
    if (!/^[A-Za-z][A-Za-z0-9]{1,10}$/.test(symbol)) { setGeneratorMessage("Token symbol must start with a letter and contain 2–11 letters or numbers."); return false; }
    if (!Number.isSafeInteger(numericSupply) || numericSupply < 1 || numericSupply > 1000000000000000) { setGeneratorMessage("Enter a whole-token supply from 1 to 1,000,000,000,000,000."); return false; }
    if (!Number.isInteger(numericDecimals) || numericDecimals < 0 || numericDecimals > 18) { setGeneratorMessage("Decimals must be a whole number from 0 to 18."); return false; }
    setGeneratorMessage("Source generated. Review it, compile and test it, then deploy only to a network you selected.");
    return true;
  }

  async function deployContract(targetNetwork = network) {
    if (!generateSource()) return;
    if (!window.ethereum) { setGeneratorMessage("No browser wallet detected. Open World Wallet AI in a browser with an injected EVM wallet such as MetaMask."); return; }
    const deploymentNetwork = targetNetwork;
    const deploymentConfig = NETWORKS[deploymentNetwork] || NETWORKS.sepolia;
    const expectedChainId = deploymentNetwork === "sepolia" ? 11155111n : deploymentNetwork === "ethereum" ? 1n : 56n;
    setDeployBusy(true); setGeneratorMessage(""); setDeployedAddress("");
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
      const currentChain = await window.ethereum.request({ method: "eth_chainId" });
      if (BigInt(currentChain) !== expectedChainId) {
        try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: deploymentConfig.chainId }] }); }
        catch (error) { if (Number(error?.code) === 4001) throw new Error("Network switch was cancelled in your wallet."); throw new Error("Switch your connected wallet to " + deploymentConfig.label + " and try again."); }
      }
      const provider = new BrowserProvider(window.ethereum);
      const chain = await provider.getNetwork();
      if (chain.chainId !== expectedChainId) throw new Error("Connected wallet network does not match " + deploymentConfig.label + ".");
      const compiled = JSON.parse(solc.compile(JSON.stringify({
        language: "Solidity",
        sources: { "GeneratedToken.sol": { content: source } },
        settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } }
      })));
      const errors = (compiled.errors || []).filter(item => item.severity === "error");
      if (errors.length) throw new Error("Solidity compile error: " + errors.map(item => item.formattedMessage).join("\n"));
      const contractName = tokenSymbol.trim().replace(/[^A-Za-z0-9_]/g, "") || "MyToken";
      const artifact = compiled.contracts?.["GeneratedToken.sol"]?.[contractName];
      if (!artifact?.evm?.bytecode?.object) throw new Error("Compiler did not produce deployable bytecode for " + contractName + ".");
      const signer = await provider.getSigner();
      const factory = new ContractFactory(artifact.abi, "0x" + artifact.evm.bytecode.object, signer);
      const contract = await factory.deploy();
      const tx = contract.deploymentTransaction();
      if (!tx) throw new Error("Wallet did not return a deployment transaction.");
      setGeneratorMessage("Deployment submitted: " + tx.hash + ". Waiting for on-chain confirmation…");
      const receipt = await tx.wait(1);
      const address = await contract.getAddress();
      if (!receipt || receipt.status !== 1 || !address) throw new Error("Deployment failed or returned no contract address.");
      const record = { name: tokenName.trim(), symbol: tokenSymbol.trim(), supply: String(supply), decimals: Number(decimals), address, network: deploymentNetwork, chainId: String(expectedChainId), txHash: tx.hash, deployer: await signer.getAddress(), explorerUrl: deploymentConfig.explorer + "/address/" + address, deployedAt: new Date().toISOString(), status: "confirmed" };
      const next = [record, ...readDeployedContracts().filter(item => !(item.address.toLowerCase() === address.toLowerCase() && item.network === deploymentNetwork))];
      localStorage.setItem(DEPLOYED_CONTRACTS_KEY, JSON.stringify(next));
      localStorage.setItem("world_wallet_pending_token_contract", JSON.stringify({ address, network: deploymentNetwork, symbol: record.symbol, name: record.name, decimals: record.decimals, txHash: record.txHash, deployedAt: record.deployedAt }));
      setDeployedContracts(next); setDeployedAddress(address); setLoadAddress(address);
      setGeneratorMessage("Contract deployed and confirmed on " + deploymentConfig.label + ". Address saved in this browser and ready to load into Wallets.");
    } catch (error) {
      setGeneratorMessage(error?.shortMessage || error?.message || "Contract deployment failed. No successful deployment is confirmed.");
    } finally { setDeployBusy(false); }
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

    {active === "Contract Generator" ? <><div className="ct-layout">
      <article className="ct-panel">
        <h2>ERC-20 token generator</h2>
        <p>Generate Solidity, preview the exact source, then compile and deploy directly from a connected wallet. Your wallet signs and pays network gas; the app never receives your private key.</p>
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
        <div className="ct-actions"><button className="ct-btn primary" onClick={() => { if (generateSource()) setShowCreateCard(true); }}>Create Contract →</button></div>
      </article>
    </div>
    {showCreateCard && active === "Contract Generator" && <article className="ct-panel">
      <h2>Create Contract · Deployment Options</h2>
      <p>Compile in the browser, then deploy from your connected wallet. A contract is recorded only after the selected blockchain confirms the transaction.</p>
      <label>Target network<select value={network} onChange={e => changeNetwork(e.target.value)}><option value="sepolia">Ethereum Sepolia — testnet (recommended first)</option><option value="ethereum">Ethereum Mainnet — real funds / gas fees</option></select></label>
      <div className="ct-status">Selected: <strong>{selectedNetwork.label}</strong> · Chain ID <code>{network === "sepolia" ? "11155111" : "1"}</code></div>
      <div className="ct-actions"><button className="ct-btn" onClick={copySource}>Copy contract source</button><button className="ct-btn" onClick={downloadSource}>Download .sol</button></div>
      <p className="ct-note">The same generated source can be deployed independently on both networks. Each deployment creates a separate contract address and separate token balances.</p>
      <div className="ct-actions"><button className="ct-btn primary" disabled={deployBusy} onClick={() => deployContract("sepolia")}>{deployBusy ? "Deploying…" : "Deploy to Sepolia"}</button><button className="ct-btn primary" disabled={deployBusy} onClick={() => deployContract("ethereum")}>{deployBusy ? "Deploying…" : "Deploy to Ethereum Mainnet"}</button></div>
      {deployedAddress && <div className="ct-status good"><strong>Deployment confirmed</strong><br/>Contract address: <code>{deployedAddress}</code><br/><a href={selectedNetwork.explorer + "/address/" + deployedAddress} target="_blank" rel="noreferrer">View deployed contract ↗</a></div>}
      {deployedContracts.length > 0 && <div className="ct-status"><strong>Contracts created in this browser</strong>{deployedContracts.slice(0,5).map((item,index)=><div key={item.address+item.network+index}>{item.name} ({item.symbol}) · {item.network} · <code>{item.address}</code> · <a href={item.explorerUrl} target="_blank" rel="noreferrer">Explorer</a></div>)}</div>}
      <label>Deployed token contract address (paste after deployment)<input value={loadAddress} onChange={e => setLoadAddress(e.target.value.trim())} spellCheck={false} placeholder="0x…"/></label>
      <div className="ct-actions"><button className="ct-btn primary" onClick={() => { if (!/^0x[a-fA-F0-9]{40}$/.test(loadAddress)) { setGeneratorMessage("Deploy a contract or paste a deployed contract address first."); return; } try { localStorage.setItem("world_wallet_pending_token_contract", JSON.stringify({address:loadAddress,network, symbol:tokenSymbol.trim(), name:tokenName.trim(), decimals:Number(decimals), loadedAt:new Date().toISOString()})); setGeneratorMessage("Contract address saved for BALMZ Token loading. Opening Wallet now."); setActive("Wallets"); } catch { setGeneratorMessage("Could not save contract details in this browser."); } }}>Load into Wallets / BALMZ Token →</button></div>
      <div className="ct-note">Mainnet deployment costs real ETH. Sepolia uses test ETH. Never enter a private key or seed phrase into this generator. Verify the contract address and selected network before loading it.</div>
      {generatorMessage && <div className="ct-status">{generatorMessage}</div>}
    </article>}</>
    : <div className="ct-layout">
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
