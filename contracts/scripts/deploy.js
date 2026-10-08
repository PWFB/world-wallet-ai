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
  console.log("Set WORLD_WALLET_BALMZ_ETH_CONTRACT to:", address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
