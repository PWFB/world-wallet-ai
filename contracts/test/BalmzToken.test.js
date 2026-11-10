const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const RESERVE_RECIPIENT = "0xbbdb482ae0895e496676ec84501d2945a404ff2c";
const ETHER = 10n ** 18n;
const BILLION = 1_000_000_000n * ETHER;
const TEN_BILLION = 10_000_000_000n * ETHER;
const CLIFF = 365n * 24n * 60n * 60n;
const LINEAR_DURATION = 1095n * 24n * 60n * 60n;
let reserveAccountImpersonated = false;

async function deploymentSigner(chainId) {
  if (chainId === 1 || chainId === 56) {
    await network.provider.send("hardhat_setBalance", [
      RESERVE_RECIPIENT,
      "0x3635c9adc5dea00000",
    ]);
    await network.provider.send("hardhat_impersonateAccount", [
      RESERVE_RECIPIENT,
    ]);
    reserveAccountImpersonated = true;
    return ethers.getSigner(RESERVE_RECIPIENT);
  }

  const [signer] = await ethers.getSigners();
  return signer;
}

async function mineAt(timestamp) {
  await network.provider.send("evm_setNextBlockTimestamp", [
    Number(timestamp),
  ]);
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

    if (reserveAccountImpersonated && (chainId === 1 || chainId === 56)) {
      await network.provider.send("hardhat_stopImpersonatingAccount", [
        RESERVE_RECIPIENT,
      ]);
      reserveAccountImpersonated = false;
    }
  });

  it("rejects deployment from an unauthorized signer on Ethereum and BNB", async function () {
    const chainId = Number((await ethers.provider.getNetwork()).chainId);

    if (chainId !== 1 && chainId !== 56) {
      this.skip();
    }

    const [unauthorized] = await ethers.getSigners();
    expect(unauthorized.address.toLowerCase()).to.not.equal(
      RESERVE_RECIPIENT
    );

    const factory = await ethers.getContractFactory(
      "BalmzToken",
      unauthorized
    );

    await expect(factory.deploy()).to.be.revertedWith(
      "Deploy with the approved OKX reserve EOA"
    );
  });

  it("rejects deployment on unsupported chain IDs", async function () {
    const chainId = Number((await ethers.provider.getNetwork()).chainId);

    if (chainId !== 999) {
      this.skip();
    }

    const [signer] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("BalmzToken", signer);

    await expect(factory.deploy()).to.be.revertedWith(
      "Unsupported BALMZ deployment chain"
    );
  });

  beforeEach(async function () {
    const chainId = Number((await ethers.provider.getNetwork()).chainId);

    if (
      chainId === 999 &&
      this.currentTest.title !==
        "rejects deployment on unsupported chain IDs"
    ) {
      this.skip();
    }
  });

  it("mints only the approved supply for the selected chain", async function () {
    const { chainId, deployer, token } = await deployToken();
    const reserveWallet = await token.RESERVE_VESTING_WALLET();
    const reserveRecipient = await token.RESERVE_RECIPIENT();

    expect(reserveRecipient.toLowerCase()).to.equal(RESERVE_RECIPIENT);

    let expectedSupply;
    let expectedDeployerBalance;
    let expectedVestingBalance;
    let expectedBeneficiaryBalance;
    let expectedReserveMinted;

    if (chainId === 1) {
      expectedSupply = TEN_BILLION + BILLION;
      expectedDeployerBalance = TEN_BILLION;
      expectedVestingBalance = BILLION;
      expectedBeneficiaryBalance = TEN_BILLION;
      expectedReserveMinted = BILLION;
      expect(deployer.address.toLowerCase()).to.equal(RESERVE_RECIPIENT);
    } else if (chainId === 56) {
      expectedSupply = TEN_BILLION;
      expectedDeployerBalance = TEN_BILLION;
      expectedVestingBalance = 0n;
      expectedBeneficiaryBalance = TEN_BILLION;
      expectedReserveMinted = 0n;
      expect(deployer.address.toLowerCase()).to.equal(RESERVE_RECIPIENT);
    } else if (chainId === 11155111) {
      expectedSupply = BILLION;
      expectedDeployerBalance = BILLION;
      expectedVestingBalance = 0n;
      expectedBeneficiaryBalance = 0n;
      expectedReserveMinted = 0n;
    } else {
      expect(chainId).to.equal(31337);
      expectedSupply = TEN_BILLION + BILLION;
      expectedDeployerBalance = TEN_BILLION;
      expectedVestingBalance = BILLION;
      expectedBeneficiaryBalance = 0n;
      expectedReserveMinted = BILLION;
    }

    expect(await token.name()).to.equal("BALMZ Token");
    expect(await token.symbol()).to.equal("BALMZ");
    expect(await token.decimals()).to.equal(18n);
    expect(await token.totalSupply()).to.equal(expectedSupply);
    expect(await token.INITIAL_SUPPLY()).to.equal(expectedSupply);
    expect(await token.balanceOf(deployer.address)).to.equal(
      expectedDeployerBalance
    );
    expect(await token.RESERVE_MINTED_SUPPLY()).to.equal(
      expectedReserveMinted
    );
    expect(await token.balanceOf(reserveRecipient)).to.equal(
      expectedBeneficiaryBalance
    );

    if (expectedVestingBalance > 0n) {
      expect(reserveWallet).to.not.equal(ethers.ZeroAddress);
      expect(await token.balanceOf(reserveWallet)).to.equal(
        expectedVestingBalance
      );
    } else {
      expect(reserveWallet).to.equal(ethers.ZeroAddress);
    }
  });

  it("defines the global 31-billion allocation without minting it on one EVM chain", async function () {
    const { token } = await deployToken();
    const globalTarget = 31_000_000_000n * ETHER;

    expect(await token.GLOBAL_SUPPLY_TARGET()).to.equal(globalTarget);

    expect(
      (await token.ETHEREUM_DISTRIBUTION_SUPPLY()) +
        (await token.BNB_DISTRIBUTION_SUPPLY()) +
        (await token.SOLANA_MAINNET_ALLOCATION()) +
        (await token.RESERVE_SUPPLY())
    ).to.equal(globalTarget);

    expect(await token.totalSupply()).to.not.equal(globalTarget);
  });

  it("creates an immutable vesting wallet with the approved schedule", async function () {
    const { chainId, token } = await deployToken();

    if (chainId !== 1 && chainId !== 31337) {
      this.skip();
    }

    const vestingAddress = await token.RESERVE_VESTING_WALLET();
    const vesting = await ethers.getContractAt(
      "BalmzReserveVesting",
      vestingAddress
    );

    expect(await vesting.token()).to.equal(await token.getAddress());
    expect((await vesting.beneficiary()).toLowerCase()).to.equal(
      RESERVE_RECIPIENT
    );
    expect(await vesting.totalAllocation()).to.equal(BILLION);
    expect(await vesting.released()).to.equal(0n);

    const start = await vesting.startTimestamp();
    const cliff = await vesting.cliffTimestamp();
    const end = await vesting.vestingEndTimestamp();

    expect(cliff - start).to.equal(CLIFF);
    expect(end - cliff).to.equal(LINEAR_DURATION);
    expect(await vesting.vestedAmount(cliff - 1n)).to.equal(0n);
    expect(await vesting.vestedAmount(cliff)).to.equal(0n);
    expect(await vesting.vestedAmount(end)).to.equal(BILLION);
  });

  it("does not release reserve tokens before or at the cliff", async function () {
    const { chainId, token } = await deployToken();

    if (chainId !== 1 && chainId !== 31337) {
      this.skip();
    }

    const vesting = await ethers.getContractAt(
      "BalmzReserveVesting",
      await token.RESERVE_VESTING_WALLET()
    );

    const cliff = await vesting.cliffTimestamp();

    await mineAt(cliff - 1n);
    await expect(vesting.release()).to.be.revertedWith(
      "Nothing releasable"
    );

    await mineAt(cliff);
    await expect(vesting.release()).to.be.revertedWith(
      "Nothing releasable"
    );

    expect(await vesting.released()).to.equal(0n);
  });

  it("allows anyone to trigger release only to the fixed beneficiary", async function () {
    const { chainId, token } = await deployToken();

    if (chainId !== 1 && chainId !== 31337) {
      this.skip();
    }

    const vesting = await ethers.getContractAt(
      "BalmzReserveVesting",
      await token.RESERVE_VESTING_WALLET()
    );

    const beneficiary = await vesting.beneficiary();
    const signers = await ethers.getSigners();
    const releaser = signers.find(
      (signer) =>
        signer.address.toLowerCase() !== beneficiary.toLowerCase()
    );

    expect(releaser).to.not.equal(undefined);

    const releaserBefore = await token.balanceOf(releaser.address);
    const beneficiaryBefore = await token.balanceOf(beneficiary);
    const cliff = await vesting.cliffTimestamp();

    await mineAt(cliff + 1n);
    await vesting.connect(releaser).release();

    const releaserAfter = await token.balanceOf(releaser.address);
    const beneficiaryAfter = await token.balanceOf(beneficiary);

    expect(releaserAfter).to.equal(releaserBefore);
    expect(beneficiaryAfter).to.be.gt(beneficiaryBefore);
    expect(await vesting.released()).to.equal(
      beneficiaryAfter - beneficiaryBefore
    );
  });

  it("vests linearly after the cliff and releases the full reserve at the end", async function () {
    const { chainId, token } = await deployToken();

    if (chainId !== 1 && chainId !== 31337) {
      this.skip();
    }

    const vesting = await ethers.getContractAt(
      "BalmzReserveVesting",
      await token.RESERVE_VESTING_WALLET()
    );

    const beneficiary = await vesting.beneficiary();
    const startBalance = await token.balanceOf(beneficiary);
    const cliff = await vesting.cliffTimestamp();
    const end = await vesting.vestingEndTimestamp();
    const midpoint = cliff + LINEAR_DURATION / 2n;

    const expectedMidpoint =
      (BILLION * (midpoint - cliff)) / LINEAR_DURATION;

    expect(await vesting.vestedAmount(midpoint)).to.equal(
      expectedMidpoint
    );

    await mineAt(midpoint);
    await vesting.release();

    expect(await vesting.released()).to.equal(expectedMidpoint);

    await mineAt(end);
    await vesting.release();

    expect(await vesting.released()).to.equal(BILLION);
    expect(await token.balanceOf(await vesting.getAddress())).to.equal(0n);
    expect(await token.balanceOf(beneficiary)).to.equal(
      startBalance + BILLION
    );
  });

  it("exposes no owner, revocation, alternate beneficiary, or mint controls", async function () {
    const { chainId, token } = await deployToken();

    const tokenFunctions = new Set(
      token.interface.fragments
        .filter((fragment) => fragment.type === "function")
        .map((fragment) => fragment.name)
    );

    for (const forbidden of [
      "mint",
      "owner",
      "pause",
      "upgradeTo",
      "setBeneficiary",
      "revoke",
    ]) {
      expect(tokenFunctions.has(forbidden)).to.equal(false);
    }

    if (chainId === 1 || chainId === 31337) {
      const vesting = await ethers.getContractAt(
        "BalmzReserveVesting",
        await token.RESERVE_VESTING_WALLET()
      );

      const vestingFunctions = new Set(
        vesting.interface.fragments
          .filter((fragment) => fragment.type === "function")
          .map((fragment) => fragment.name)
      );

      for (const forbidden of [
        "owner",
        "revoke",
        "withdraw",
        "setBeneficiary",
        "setToken",
        "mint",
      ]) {
        expect(vestingFunctions.has(forbidden)).to.equal(false);
      }
    }
  });
});
