const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const RESERVE_RECIPIENT = "0xbbdb482ae0895e496676ec84501d2945a404ff2c";
const ETHER = 10n ** 18n;

async function deploymentSigner(chainId) {
  if (chainId === 1 || chainId === 56) {
    await network.provider.send("hardhat_setBalance", [
      RESERVE_RECIPIENT,
      "0x3635c9adc5dea00000",
    ]);
    await network.provider.send("hardhat_impersonateAccount", [RESERVE_RECIPIENT]);
    return ethers.getSigner(RESERVE_RECIPIENT);
  }
  const [signer] = await ethers.getSigners();
  return signer;
}

describe("BalmzToken fixed-supply deployment", function () {
  async function deployToken() {
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deployer = await deploymentSigner(chainId);
    const factory = await ethers.getContractFactory("BalmzToken", deployer);
    const token = await factory.deploy();
    await token.waitForDeployment();
    return { chainId, deployer, token };
  }

  afterEach(async function () {
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    if (chainId === 1 || chainId === 56) {
      await network.provider.send("hardhat_stopImpersonatingAccount", [RESERVE_RECIPIENT]);
    }
  });

  it("mints only the approved supply for the selected chain", async function () {
    const { chainId, deployer, token } = await deployToken();
    const reserveRecipient = await token.RESERVE_RECIPIENT();
    const ethereumDistribution = 10_000_000_000n * ETHER;
    const bnbDistribution = 10_000_000_000n * ETHER;
    const solanaAllocation = 10_000_000_000n * ETHER;
    const reserveAllocation = 1_000_000_000n * ETHER;
    const sepoliaTestSupply = 1_000_000_000n * ETHER;

    let expectedSupply;
    let expectedDeployerBalance;
    let expectedReserveBalance;
    let expectedReserveMinted;

    if (chainId === 1) {
      expectedSupply = ethereumDistribution + reserveAllocation;
      expectedDeployerBalance = expectedSupply;
      expectedReserveBalance = expectedSupply;
      expectedReserveMinted = reserveAllocation;
      expect(deployer.address.toLowerCase()).to.equal(RESERVE_RECIPIENT);
    } else if (chainId === 56) {
      expectedSupply = bnbDistribution;
      expectedDeployerBalance = bnbDistribution;
      expectedReserveBalance = bnbDistribution;
      expectedReserveMinted = 0n;
      expect(deployer.address.toLowerCase()).to.equal(RESERVE_RECIPIENT);
    } else if (chainId === 11155111) {
      expectedSupply = sepoliaTestSupply;
      expectedDeployerBalance = sepoliaTestSupply;
      expectedReserveBalance = 0n;
      expectedReserveMinted = 0n;
    } else {
      expect(chainId).to.equal(31337);
      expectedSupply = ethereumDistribution + reserveAllocation;
      expectedDeployerBalance = ethereumDistribution;
      expectedReserveBalance = reserveAllocation;
      expectedReserveMinted = reserveAllocation;
    }

    expect(await token.name()).to.equal("BALMZ Token");
    expect(await token.symbol()).to.equal("BALMZ");
    expect(await token.decimals()).to.equal(18n);
    expect(await token.totalSupply()).to.equal(expectedSupply);
    expect(await token.INITIAL_SUPPLY()).to.equal(expectedSupply);
    expect(await token.balanceOf(deployer.address)).to.equal(expectedDeployerBalance);
    expect(await token.balanceOf(reserveRecipient)).to.equal(expectedReserveBalance);
    expect(await token.RESERVE_MINTED_SUPPLY()).to.equal(expectedReserveMinted);
    expect(reserveRecipient.toLowerCase()).to.equal(RESERVE_RECIPIENT);
  });

  it("defines one global 31-billion allocation without minting 31 billion on a single EVM chain", async function () {
    const { token } = await deployToken();
    const globalTarget = 31_000_000_000n * ETHER;

    expect(await token.GLOBAL_SUPPLY_TARGET()).to.equal(globalTarget);
    expect(
      await token.ETHEREUM_DISTRIBUTION_SUPPLY() +
      await token.BNB_DISTRIBUTION_SUPPLY() +
      await token.SOLANA_MAINNET_ALLOCATION() +
      await token.RESERVE_SUPPLY()
    ).to.equal(globalTarget);
    expect(await token.totalSupply()).to.not.equal(globalTarget);
  });

  it("does not expose a public mint or owner-controlled supply function", async function () {
    const { token } = await deployToken();
    const functionNames = new Set(
      token.interface.fragments
        .filter((fragment) => fragment.type === "function")
        .map((fragment) => fragment.name)
    );

    expect(functionNames.has("mint")).to.equal(false);
    expect(functionNames.has("owner")).to.equal(false);
    expect(functionNames.has("pause")).to.equal(false);
    expect(functionNames.has("upgradeTo")).to.equal(false);
  });
});
