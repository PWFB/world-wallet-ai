const hre = require("hardhat");

const RESERVE_RECIPIENT = "0xbbdb482ae0895e496676ec84501d2945a404ff2c";
const EXPECTED_SUPPLY_BY_CHAIN = {
  "1":  "11000000000",
  "56": "10000000000",
  "11155111": "1000000000",
};

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer configured. For OKX signing, use the wallet flow documented in README.md; never export or commit a private key.");
  }

  const network = await hre.ethers.provider.getNetwork();
  const chainId = network.chainId.toString();
  const expectedSupply = EXPECTED_SUPPLY_BY_CHAIN[chainId];
  if (!expectedSupply) {
    throw new Error("Unsupported BALMZ deployment chain: " + chainId);
  }

  if ((chainId === "1" || chainId === "56") &&
      deployer.address.toLowerCase() !== RESERVE_RECIPIENT) {
    throw new Error("Mainnet deployment must be signed by the approved OKX reserve EOA: " + RESERVE_RECIPIENT);
  }

  console.log("Deploying BALMZ from:", deployer.address);
  console.log("Network:", network.name, "chainId:", chainId);
  const factory = await hre.ethers.getContractFactory("BalmzToken");
  const token = await factory.deploy();
  await token.waitForDeployment();

  const address = await token.getAddress();
  const supply = await token.totalSupply();
  const expectedSupplyRaw = hre.ethers.parseEther(expectedSupply);
  const formattedSupply = hre.ethers.formatUnits(supply, 18);
  if (supply !== expectedSupplyRaw) {
    throw new Error("Post-deployment supply mismatch: expected " + expectedSupply + ", received " + formattedSupply);
  }

  const balance = await token.balanceOf(deployer.address);
  const reserveRecipient = await token.RESERVE_RECIPIENT();
  console.log("BALMZ contract:", address);
  console.log("Total supply:", formattedSupply, "BALMZ");
  console.log("Deployer balance:", hre.ethers.formatUnits(balance, 18), "BALMZ");
  console.log("Reserve recipient:", reserveRecipient);
  console.log("Reserve allocation:", hre.ethers.formatUnits(await token.RESERVE_MINTED_SUPPLY(), 18), "BALMZ");

  const contractEnv = chainId === "1"
    ? "WORLD_WALLET_BALMZ_ETH_CONTRACT"
    : chainId === "56"
      ? "WORLD_WALLET_BALMZ_BNB_CONTRACT"
      : "WORLD_WALLET_BALMZ_SEPOLIA_CONTRACT";
  console.log("Set " + contractEnv + " to:", address);
  console.log("Deployment transaction:", token.deploymentTransaction()?.hash || "unavailable");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
