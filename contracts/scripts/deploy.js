const hre = require("hardhat");

const RESERVE_RECIPIENT = "0xbbdb482ae0895e496676ec84501d2945a404ff2c";
const BILLION = hre.ethers.parseEther("1000000000");
const TEN_BILLION = hre.ethers.parseEther("10000000000");
const CLIFF = 365n * 24n * 60n * 60n;
const LINEAR = 1095n * 24n * 60n * 60n;

const EXPECTED = {
  "1": { supply: TEN_BILLION + BILLION, deployer: TEN_BILLION, reserve: BILLION },
  "31337": { supply: TEN_BILLION + BILLION, deployer: TEN_BILLION, reserve: BILLION },
  "56": { supply: TEN_BILLION, deployer: TEN_BILLION, reserve: 0n },
  "11155111": { supply: BILLION, deployer: BILLION, reserve: 0n },
};

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer configured.");

  const network = await hre.ethers.provider.getNetwork();
  const chainId = network.chainId.toString();
  const expected = EXPECTED[chainId];

  if (!expected) throw new Error("Unsupported BALMZ chain: " + chainId);

  if ((chainId === "1" || chainId === "56") &&
      deployer.address.toLowerCase() !== RESERVE_RECIPIENT) {
    throw new Error("Wrong mainnet signer: " + deployer.address);
  }

  console.log("Signer:", deployer.address);
  console.log("Network:", network.name, "chainId:", chainId);

  const factory = await hre.ethers.getContractFactory("BalmzToken");
  const token = await factory.deploy();
  await token.waitForDeployment();

  const tokenAddress = await token.getAddress();
  const supply = await token.totalSupply();
  const deployerBalance = await token.balanceOf(deployer.address);
  const reserveAddress = await token.RESERVE_VESTING_WALLET();
  const reserveMinted = await token.RESERVE_MINTED_SUPPLY();

  if (supply !== expected.supply) throw new Error("Total supply mismatch.");
  if (deployerBalance !== expected.deployer) throw new Error("Deployer balance mismatch.");
  if (reserveMinted !== expected.reserve) throw new Error("Reserve allocation mismatch.");

  if (chainId === "1" || chainId === "31337") {
    if (reserveAddress === hre.ethers.ZeroAddress) {
      throw new Error("Ethereum reserve vesting wallet is missing.");
    }

    const vesting = await hre.ethers.getContractAt(
      "BalmzReserveVesting",
      reserveAddress
    );

    if ((await vesting.token()).toLowerCase() !== tokenAddress.toLowerCase()) {
      throw new Error("Vesting token address mismatch.");
    }
    if ((await vesting.beneficiary()).toLowerCase() !== RESERVE_RECIPIENT) {
      throw new Error("Vesting beneficiary mismatch.");
    }
    if ((await vesting.totalAllocation()) !== BILLION) {
      throw new Error("Vesting allocation mismatch.");
    }
    if ((await vesting.released()) !== 0n) {
      throw new Error("Unexpected reserve release at deployment.");
    }
    if ((await vesting.cliffTimestamp()) - (await vesting.startTimestamp()) !== CLIFF) {
      throw new Error("Vesting cliff mismatch.");
    }
    if ((await vesting.vestingEndTimestamp()) - (await vesting.cliffTimestamp()) !== LINEAR) {
      throw new Error("Linear vesting duration mismatch.");
    }
    if ((await token.balanceOf(reserveAddress)) !== BILLION) {
      throw new Error("Vesting contract reserve balance mismatch.");
    }

    console.log("Reserve vesting contract:", reserveAddress);
    console.log("Vesting cliff:", new Date(Number(await vesting.cliffTimestamp()) * 1000).toISOString());
    console.log("Vesting end:", new Date(Number(await vesting.vestingEndTimestamp()) * 1000).toISOString());
    console.log("Vesting allocation: 1,000,000,000 BALMZ");
    console.log("Record the vesting contract address separately from the token address.");
  } else if (reserveAddress !== hre.ethers.ZeroAddress) {
    throw new Error("Unexpected vesting wallet on this chain.");
  }

  console.log("BALMZ token:", tokenAddress);
  console.log("Total supply:", hre.ethers.formatEther(supply));
  console.log("Deployer balance:", hre.ethers.formatEther(deployerBalance));
  console.log("Reserve minted:", hre.ethers.formatEther(reserveMinted));
  console.log("Deployment transaction:", token.deploymentTransaction()?.hash || "unavailable");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
