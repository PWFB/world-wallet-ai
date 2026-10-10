import { useEffect, useState } from "react";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";

const VAULT_KEY = "world_wallet_encrypted_vault_v1";
const DEPLOYED_KEY = "world_wallet_deployed_contracts_v1";
const SEPOLIA_RPC = (import.meta.env.VITE_WORLD_WALLET_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com").trim();
const readArray = key => {
  try { const value = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(value) ? value : []; }
  catch { return []; }
};

export default function LocalVaultDeploy({ source, tokenName, tokenSymbol, supply, decimals, onDeployed }) {
  const [wallets, setWallets] = useState([]);
  const [walletId, setWalletId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [address, setAddress] = useState("");
  const [txHash, setTxHash] = useState("");

  useEffect(() => {
    const saved = readArray(VAULT_KEY);
    setWallets(saved.filter(item => item && item.encryptedJson && item.address && item.walletId));
    if (saved[0]?.walletId) setWalletId(saved[0].walletId);
  }, []);

  async function deploy() {
    const selected = wallets.find(item => item.walletId === walletId);
    if (!selected) { setStatus("Create a local World Wallet AI signing wallet first."); return; }
    if (!password) { setStatus("Enter the local vault password for this wallet. It is decrypted only in this browser."); return; }
    setBusy(true); setStatus(""); setAddress(""); setTxHash("");
    try {
      const signer = await Wallet.fromEncryptedJson(selected.encryptedJson, password);
      if (signer.address.toLowerCase() !== selected.address.toLowerCase()) throw new Error("Decrypted wallet address does not match the saved vault entry.");
      const provider = new JsonRpcProvider(SEPOLIA_RPC, 11155111);
      const chain = await provider.getNetwork();
      if (chain.chainId !== 11155111n) throw new Error("RPC endpoint did not confirm Ethereum Sepolia.");
      const balance = await provider.getBalance(signer.address);
      if (balance === 0n) throw new Error("This wallet has no Sepolia test ETH for deployment gas. Get free Sepolia test ETH first.");
      const solcModule = await import("solc");
      const solc = solcModule.default || solcModule;
      const compiled = JSON.parse(solc.compile(JSON.stringify({
        language: "Solidity",
        sources: { "GeneratedToken.sol": { content: source } },
        settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } }
      })));
      const errors = (compiled.errors || []).filter(item => item.severity === "error");
      if (errors.length) throw new Error("Solidity compile error: " + errors.map(item => item.formattedMessage).join("\n"));
      const contractName = tokenSymbol.trim().replace(/[^A-Za-z0-9_]/g, "") || "MyToken";
      const artifact = compiled.contracts?.["GeneratedToken.sol"]?.[contractName];
      if (!artifact?.evm?.bytecode?.object) throw new Error("Compiler did not produce deployable bytecode.");
      const connectedSigner = signer.connect(provider);
      const factory = new ContractFactory(artifact.abi, "0x" + artifact.evm.bytecode.object, connectedSigner);
      const contract = await factory.deploy();
      const tx = contract.deploymentTransaction();
      if (!tx) throw new Error("No deployment transaction was returned.");
      setTxHash(tx.hash);
      setStatus("Signed locally and submitted to Sepolia. Waiting for confirmation…");
      const receipt = await tx.wait(1);
      const deployedAddress = await contract.getAddress();
      if (!receipt || receipt.status !== 1 || !/^0x[a-fA-F0-9]{40}$/.test(deployedAddress)) throw new Error("Deployment was not confirmed successfully.");
      const record = {
        name: tokenName.trim(), symbol: tokenSymbol.trim(), supply: String(supply), decimals: Number(decimals),
        address: deployedAddress, network: "sepolia", chainId: "11155111", txHash: tx.hash,
        deployer: signer.address, explorerUrl: "https://sepolia.etherscan.io/address/" + deployedAddress,
        deployedAt: new Date().toISOString(), status: "confirmed", source: "world-wallet-ai-local-vault"
      };
      const saved = readArray(DEPLOYED_KEY);
      localStorage.setItem(DEPLOYED_KEY, JSON.stringify([record, ...saved.filter(item => !(item.address?.toLowerCase() === deployedAddress.toLowerCase() && item.network === "sepolia"))]));
      localStorage.setItem("world_wallet_pending_token_contract", JSON.stringify({
        address: deployedAddress, network: "sepolia", symbol: record.symbol, name: record.name,
        decimals: record.decimals, txHash: tx.hash, deployedAt: record.deployedAt
      }));
      setAddress(deployedAddress);
      setPassword("");
      setStatus("Contract deployment confirmed on Sepolia. The contract address has been saved in this browser and can be loaded into Wallets.");
      onDeployed?.(record);
    } catch (error) {
      setStatus(error?.shortMessage || error?.message || "Local wallet contract deployment failed.");
    } finally { setBusy(false); }
  }

  return <div className="ct-panel" style={{ marginTop: 14 }}>
    <h2>Deploy using your World Wallet AI local wallet</h2>
    <p>This deployment signs in your browser using the encrypted wallet saved in World Wallet AI. No injected MetaMask or external wallet is required for Sepolia. Your password and private key are not uploaded.</p>
    {!wallets.length ? <div className="ct-status bad">No encrypted local wallet found in this browser. Open Wallets → Generate a signing wallet, then return here.</div> : <>
      <label>World Wallet AI wallet<select value={walletId} onChange={event => setWalletId(event.target.value)}>{wallets.map(item => <option key={item.walletId} value={item.walletId}>{item.name || "Wallet"} · {item.address.slice(0, 8)}… · {item.network || "EVM"}</option>)}</select></label>
      <label>Local vault password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" placeholder="Password used when generating this wallet" /></label>
      <div className="ct-note">Network: Ethereum Sepolia · Chain ID 11155111. Deployment requires free Sepolia test ETH for gas. Never paste your private key or recovery phrase here.</div>
      <div className="ct-actions"><button className="ct-btn primary" disabled={busy || !walletId || !password} onClick={deploy}>{busy ? "Signing / deploying…" : "Sign and deploy with World Wallet AI →"}</button></div>
    </>}
    {status && <div className={"ct-status " + (/confirmed/.test(status) ? "good" : /failed|no Sepolia|no encrypted|does not|error|password/i.test(status) ? "bad" : "")}>{status}</div>}
    {txHash && <div className="ct-links"><a href={"https://sepolia.etherscan.io/tx/" + txHash} target="_blank" rel="noreferrer">View deployment transaction ↗</a></div>}
    {address && <div className="ct-status good"><strong>Contract address</strong><br/><code>{address}</code><br/><a href={"https://sepolia.etherscan.io/address/" + address} target="_blank" rel="noreferrer">View contract on Sepolia Etherscan ↗</a></div>}
  </div>;
}
