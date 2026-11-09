const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BalmzToken fixed-supply deployment", function () {
  async function deployToken() {
    const [deployer] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("BalmzToken");
    const token = await factory.deploy();
    await token.waitForDeployment();
    return { deployer, token };
  }

  it("mints the Ethereum allocation and reserve on the local Hardhat chain", async function () {
    const { deployer, token } = await deployToken();
    const distribution = ethers.parseEther("10000000000");
    const reserve = ethers.parseEther("1000000000");
    const expectedTotal = ethers.parseEther("11000000000");
    const reserveRecipient = await token.RESERVE_RECIPIENT();

    expect(await token.name()).to.equal("BALMZ Token");
    expect(await token.symbol()).to.equal("BALMZ");
    expect(await token.decimals()).to.equal(18n);
    expect(await token.totalSupply()).to.equal(expectedTotal);
    expect(await token.INITIAL_SUPPLY()).to.equal(expectedTotal);
    expect(await token.balanceOf(deployer.address)).to.equal(distribution);
    expect(await token.balanceOf(reserveRecipient)).to.equal(reserve);
    expect(await token.RESERVE_MINTED_SUPPLY()).to.equal(reserve);
  });

  it("defines the 31-billion cross-chain allocation without minting the global target on one EVM chain", async function () {
    const { token } = await deployToken();
    const globalTarget = ethers.parseEther("31000000000");

    expect(await token.GLOBAL_SUPPLY_TARGET()).to.equal(globalTarget);
    expect(
      await token.ETHEREUM_DISTRIBUTION_SUPPLY() +
      await token.BNB_DISTRIBUTION_SUPPLY() +
      await token.SOLANA_MAINNET_ALLOCATION() +
      await token.RESERVE_SUPPLY()
    ).to.equal(globalTarget);
    expect(await token.totalSupply()).to.equal(ethers.parseEther("11000000000"));
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

  it("keeps the reserve recipient pinned to the approved OKX EOA", async function () {
    const { token } = await deployToken();

    expect((await token.RESERVE_RECIPIENT()).toLowerCase()).to.equal(
      "0xbbdb482ae0895e496676ec84501d2945a404ff2c"
    );
  });
});
