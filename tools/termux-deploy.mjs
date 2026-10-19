#!/usr/bin/env node
/**
 * World Wallet AI — Termux smart-contract deploy helper.
 * Example (Sepolia): NETWORK_NAME=sepolia RPC_URL=https://... PRIVATE_KEY=<local env> node tools/termux-deploy.mjs contracts/BalmzToken.sol BalmzToken
 * Keep RPC_URL and PRIVATE_KEY local. Never commit secrets or paste them into chat.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import solcModule from "solc";
import { JsonRpcProvider, Wallet, ContractFactory, Contract, isAddress, formatEther } from "ethers";

const NETWORKS = {
  sepolia: { chainId: 11155111n, explorer: "https://sepolia.etherscan.io" },
  ethereum: { chainId: 1n, explorer: "https://etherscan.io" },
  bnb: { chainId: 56n, explorer: "https://bscscan.com" },
};
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)"
];
function fail(message) { console.error("\nERROR: " + message); process.exit(1); }

const sourcePath = path.resolve(process.argv[2] || "");
const contractName = process.argv[3];
const rpcUrl = (process.env.RPC_URL || process.env.SEPOLIA_RPC_URL || "").trim();
const privateKey = (process.env.PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || "").trim();
const networkName = (process.env.NETWORK_NAME || "sepolia").trim().toLowerCase();

if (!process.argv[2] || !contractName) fail("Usage: NETWORK_NAME=sepolia RPC_URL=https://... PRIVATE_KEY=<hidden local env> node tools/termux-deploy.mjs <contract.sol> <ContractName>");
if (!fs.existsSync(sourcePath)) fail("Solidity source file not found: " + sourcePath);
if (!rpcUrl) fail("Set RPC_URL (or SEPOLIA_RPC_URL) to an HTTPS RPC endpoint.");
let parsedRpc;
try { parsedRpc = new URL(rpcUrl); } catch { fail("RPC URL is not valid."); }
if (parsedRpc.protocol !== "https:") fail("Only HTTPS RPC URLs are accepted.");
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) fail("Set PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) in the local shell. Never paste it into chat or save it in a file.");
const network = NETWORKS[networkName];
if (!network) fail("NETWORK_NAME must be sepolia, ethereum, or bnb.");
if (networkName !== "sepolia") fail("This guarded helper is currently restricted to Sepolia for safety. Use a separately reviewed deployment process for mainnet.");

const source = fs.readFileSync(sourcePath, "utf8");
const sourceName = path.basename(sourcePath);
const sourceDir = path.dirname(sourcePath);
const solc = solcModule.default || solcModule;

function findImport(importPath) {
  const candidates = [
    path.resolve(sourceDir, importPath),
    path.resolve(sourceDir, "node_modules", importPath),
    path.resolve(process.cwd(), "node_modules", importPath),
    path.resolve(process.cwd(), "contracts", "node_modules", importPath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { contents: fs.readFileSync(candidate, "utf8") };
    }
  }
  return { error: "Import not found: " + importPath + ". Install required dependencies locally (e.g. npm install @openzeppelin/contracts) or correct the import path." };
}

console.log("Compiling " + sourceName + " with solc " + solc.version());
const compiled = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: { [sourceName]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
  }
}), { import: findImport }));
const errors = (compiled.errors || []).filter(item => item.severity === "error");
if (errors.length) fail("Solidity compilation failed:\n" + errors.map(item => item.formattedMessage).join("\n"));
const artifact = compiled.contracts?.[sourceName]?.[contractName];
if (!artifact?.abi || !artifact?.evm?.bytecode?.object) fail("Contract '" + contractName + "' not found in " + sourceName + ".");
if (!artifact.evm.bytecode.object.length) fail("Compiled bytecode is empty.");

const provider = new JsonRpcProvider(rpcUrl);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
try {
  const actualNetwork = await provider.getNetwork();
  if (actualNetwork.chainId !== network.chainId) fail("RPC chain ID mismatch. Expected Sepolia 11155111; received " + actualNetwork.chainId + ".");
  const wallet = new Wallet(privateKey, provider);
  const deployer = await wallet.getAddress();
  const balance = await provider.getBalance(deployer);
  const factory = new ContractFactory(artifact.abi, "0x" + artifact.evm.bytecode.object, wallet);
  const deployTx = await factory.getDeployTransaction();
  const feeData = await provider.getFeeData();
  const estimatedGas = await provider.estimateGas({ ...deployTx, from: deployer });
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!gasPrice) fail("RPC did not provide a gas price; cannot estimate deployment cost safely.");
  const estimatedCost = estimatedGas * gasPrice;
  console.log("\n=== DEPLOYMENT REVIEW (NO TRANSACTION SUBMITTED YET) ===");
  console.log("Network: Ethereum Sepolia (chain ID " + actualNetwork.chainId + ")");
  console.log("Contract: " + contractName);
  console.log("Deployer: " + deployer);
  console.log("Sepolia ETH balance: " + formatEther(balance) + " ETH");
  console.log("Estimated gas units: " + estimatedGas.toString());
  console.log("Estimated maximum fee: " + formatEther(estimatedCost) + " ETH (actual fee may differ)");
  if (balance < estimatedCost) fail("Insufficient Sepolia ETH for the estimated deployment fee. Obtain test ETH from a trusted Sepolia faucet.");
  const expected = contractName === "BalmzToken" ? "DEPLOY BALMZ TO SEPOLIA" : "DEPLOY CONTRACT TO SEPOLIA";
  const answer = (await rl.question("\nTo authorize broadcasting this testnet deployment, type exactly '" + expected + "': ")).trim();
  if (answer !== expected) {
    console.log("Cancelled. No deployment transaction was submitted.");
    process.exitCode = 0;
  } else {
    const contract = await factory.deploy();
    const tx = contract.deploymentTransaction();
    if (!tx) fail("No deployment transaction was returned.");
    console.log("Transaction submitted: " + tx.hash);
    console.log("Waiting for one confirmation…");
    const receipt = await tx.wait(1);
    const address = await contract.getAddress();
    if (!receipt || receipt.status !== 1 || !isAddress(address)) fail("Deployment was not confirmed successfully.");
    let tokenDetails = {};
    try {
      const token = new Contract(address, ERC20_ABI, provider);
      const [name, symbol, decimals, totalSupply, deployerBalance] = await Promise.all([
        token.name(), token.symbol(), token.decimals(), token.totalSupply(), token.balanceOf(deployer)
      ]);
      tokenDetails = {
        name,
        symbol,
        decimals: Number(decimals),
        totalSupply: totalSupply.toString(),
        totalSupplyFormatted: (Number(decimals) <= 18 ? (Number(totalSupply) / (10 ** Number(decimals))).toLocaleString("en-US", { maximumFractionDigits: Number(decimals) }) : totalSupply.toString()),
        deployerTokenBalance: deployerBalance.toString()
      };
      if (contractName === "BalmzToken" && (name !== "BALMZ Token" || symbol !== "BALMZ" || Number(decimals) !== 18 || totalSupply !== 1000000000n * 10n ** 18n || deployerBalance !== totalSupply)) {
        fail("Deployment exists but BALMZ verification did not match expected name/symbol/decimals/supply/deployer allocation. Inspect the contract on Sepolia Etherscan.");
      }
    } catch (error) {
      if (contractName === "BalmzToken") throw error;
      console.log("ERC-20 metadata verification skipped for non-ERC20 contract.");
    }
    const manifest = {
      app: "World Wallet AI",
      contract: contractName,
      name: tokenDetails.name || contractName,
      symbol: tokenDetails.symbol || contractName,
      ...(Object.keys(tokenDetails).length ? { token: tokenDetails } : {}),
      address,
      network: networkName,
      chainId: actualNetwork.chainId.toString(),
      txHash: tx.hash,
      deployer,
      explorerUrl: network.explorer + "/address/" + address,
      transactionUrl: network.explorer + "/tx/" + tx.hash,
      deployedAt: new Date().toISOString(),
      status: "confirmed"
    };
    const outputPath = path.resolve("world-wallet-deployment.json");
    fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log("\nDEPLOYMENT CONFIRMED AND TOKEN METADATA VERIFIED");
    console.log("Contract address: " + address);
    console.log("Token: " + (tokenDetails.name || contractName) + " (" + (tokenDetails.symbol || contractName) + ")");
    if (tokenDetails.totalSupplyFormatted) console.log("Total supply: " + tokenDetails.totalSupplyFormatted);
    console.log("Transaction: " + tx.hash);
    console.log("Explorer: " + manifest.explorerUrl);
    console.log("Manifest saved to: " + outputPath);
    console.log("Import the manifest in World Wallet AI → Contract Generator.");
  }
} catch (error) {
  console.error("\nDeployment failed: " + (error?.shortMessage || error?.message || String(error)));
  process.exitCode = 1;
} finally {
  rl.close();
  await provider.destroy();
}
