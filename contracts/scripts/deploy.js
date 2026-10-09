const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer configured. Set DEPLOYER_PRIVATE_KEY locally; never commit it.");
  }

  console.log("Deploying BALMZ from:", deployer.address);
  const factory = await hre.ethers.getContractFactory("BalmzToken");
  const token = await factory.deploy();
  await token.waitForDeployment();

  const address = await token.getAddress();
  const supply = await token.totalSupply();
  const balance = await token.balanceOf(deployer.address);

  console.log("BALMZ contract:", address);
  console.log("Total supply:", hre.ethers.formatUnits(supply, 18), "BALMZ");
  console.log("Deployer balance:", hre.ethers.formatUnits(balance, 18), "BALMZ");
  const network = await hre.ethers.provider.getNetwork();
  const contractEnv = network.chainId === 11155111n
    ? "WORLD_WALLET_BALMZ_SEPOLIA_CONTRACT"
    : "WORLD_WALLET_BALMZ_ETH_CONTRACT";
  console.log("Network:", network.name, "chainId:", network.chainId.toString());
  console.log("Set " + contractEnv + " to:", address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
