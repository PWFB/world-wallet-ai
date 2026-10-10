#!/usr/bin/env node
/**
 * World Wallet AI — Termux smart-contract deploy helper.
 * Usage: RPC_URL=https://... NETWORK_NAME=sepolia PRIVATE_KEY=... node tools/termux-deploy.mjs ./MTK.sol MTK
 * Keep PRIVATE_KEY in a temporary environment variable; never commit it or paste it into the app.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import solcModule from "solc";
import { JsonRpcProvider, Wallet, ContractFactory, isAddress } from "ethers";

const NETWORKS = {
  sepolia: { chainId: 11155111n, explorer: "https://sepolia.etherscan.io" },
  ethereum: { chainId: 1n, explorer: "https://etherscan.io" },
  bnb: { chainId: 56n, explorer: "https://bscscan.com" },
};
function fail(message) { console.error("\nERROR: " + message); process.exit(1); }

const sourcePath = process.argv[2];
const contractName = process.argv[3];
const rpcUrl = (process.env.RPC_URL || "").trim();
const privateKey = (process.env.PRIVATE_KEY || "").trim();
const networkName = (process.env.NETWORK_NAME || "sepolia").trim().toLowerCase();
if (!sourcePath || !contractName) fail("Usage: node tools/termux-deploy.mjs <contract.sol> <ContractName>");
if (!fs.existsSync(sourcePath)) fail("Solidity source file not found: " + sourcePath);
if (!rpcUrl) fail("Set RPC_URL to the HTTPS RPC for your selected network.");
let parsedRpc;
try { parsedRpc = new URL(rpcUrl); } catch { fail("RPC_URL is not a valid URL."); }
if (parsedRpc.protocol !== "https:") fail("Only HTTPS RPC URLs are accepted by this helper.");
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) fail("Set PRIVATE_KEY in the temporary shell environment (0x + 64 hex characters).");
const network = NETWORKS[networkName];
if (!network) fail("NETWORK_NAME must be sepolia, ethereum, or bnb.");
const source = fs.readFileSync(sourcePath, "utf8");
const sourceName = path.basename(sourcePath);
const solc = solcModule.default || solcModule;
console.log("Compiling " + sourceName + " with solc " + solc.version());
const compiled = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: { [sourceName]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
  }
})));
const errors = (compiled.errors || []).filter(item => item.severity === "error");
if (errors.length) fail("Solidity compilation failed:\n" + errors.map(item => item.formattedMessage).join("\n"));
const artifact = compiled.contracts?.[sourceName]?.[contractName];
if (!artifact?.abi || !artifact?.evm?.bytecode?.object) {
  fail("Contract '" + contractName + "' not found in " + sourceName + ". Use the exact Solidity contract name.");
}
const provider = new JsonRpcProvider(rpcUrl);
try {
  const actualNetwork = await provider.getNetwork();
  if (actualNetwork.chainId !== network.chainId) {
    fail("RPC chain ID mismatch. NETWORK_NAME=" + networkName + " expects " + network.chainId + " but RPC returned " + actualNetwork.chainId + ".");
  }
  const wallet = new Wallet(privateKey, provider);
  const deployer = await wallet.getAddress();
  console.log("Network: " + networkName + " (chain ID " + actualNetwork.chainId + ")");
  console.log("Deployer: " + deployer);
  console.log("Submitting deployment transaction…");
  const factory = new ContractFactory(artifact.abi, "0x" + artifact.evm.bytecode.object, wallet);
  const contract = await factory.deploy();
  const tx = contract.deploymentTransaction();
  if (!tx) fail("No deployment transaction was returned.");
  console.log("Transaction: " + tx.hash);
  console.log("Waiting for one confirmation…");
  const receipt = await tx.wait(1);
  const address = await contract.getAddress();
  if (!receipt || receipt.status !== 1 || !isAddress(address)) fail("Deployment was not confirmed successfully.");
  const manifest = {
    app: "World Wallet AI",
    name: contractName,
    symbol: contractName,
    address,
    network: networkName,
    chainId: actualNetwork.chainId.toString(),
    txHash: tx.hash,
    deployer,
    explorerUrl: network.explorer + "/address/" + address,
    transactionUrl: network.explorer + "/tx/" + tx.hash,
    deployedAt: new Date().toISOString(),
    status: "confirmed",
  };
  const outputPath = path.resolve("world-wallet-deployment.json");
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  console.log("\nDEPLOYMENT CONFIRMED");
  console.log("Contract address: " + address);
  console.log("Transaction: " + tx.hash);
  console.log("Explorer: " + manifest.explorerUrl);
  console.log("Manifest saved to: " + outputPath);
  console.log("Import this JSON manifest in World Wallet AI → Contract Generator to save it in the app.");
} catch (error) {
  console.error("\nDeployment failed: " + (error?.shortMessage || error?.message || String(error)));
  process.exitCode = 1;
} finally {
  provider.destroy();
}
