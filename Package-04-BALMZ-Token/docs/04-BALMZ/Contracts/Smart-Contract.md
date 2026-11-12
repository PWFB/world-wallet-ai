# BALMZ Smart Contracts

## EVM source

The EVM implementation is in:
- `contracts/contracts/BalmzToken.sol`
- `contracts/contracts/BalmzReserveVesting.sol`

Toolchain recorded in the contract package:
- Solidity compiler: 0.8.24
- OpenZeppelin Contracts: 5.6.1
- Hardhat: version constrained by `contracts/package.json` and `package-lock.json`

Use `npm ci` to install the exact lockfile dependency set before compiling or testing.

## Chain guards and initial supply

| Chain ID | Network | Supply minted at construction | Recipient / handling |
|---:|---|---:|---|
| 1 | Ethereum Mainnet | 11,000,000,000 | 10B to the approved deploying EOA; 1B to the immutable vesting contract |
| 56 | BNB Chain Mainnet | 10,000,000,000 | 10B to the approved deploying EOA |
| 11155111 | Sepolia testnet | 1,000,000,000 | Test deployer |
| 31337 | Local Hardhat | 11,000,000,000 | Local test deployer plus local vesting contract |
| Other | Unsupported | Deployment reverts | No supply minted |

Ethereum and BNB Mainnet deployments require the sender to equal the fixed `RESERVE_RECIPIENT` in the reviewed source. The deployer must independently compare the address shown in the wallet with the source constant and release approval before signing.

## Ethereum reserve vesting

The Ethereum constructor deploys `BalmzReserveVesting` and sends 1B BALMZ to it. The beneficiary is fixed in the vesting contract. Its schedule is a 365-day cliff followed by 1,095 days of linear vesting. The contract has no owner, revocation, alternate beneficiary, or arbitrary withdrawal method. The `release()` function can be called by anyone, but the tokens can only be transferred to the fixed beneficiary.

The 1B reserve is already included in Ethereum's 11B token supply and the 31B global allocation.

## Security properties in source

- Fixed chain-specific constructor supply.
- Unsupported EVM chain IDs revert.
- Mainnet deployment signer guard.
- No public mint method after construction.
- No owner, pause, proxy, or upgrade path in the token.
- Immutable reserve vesting token and beneficiary.
- Vesting release limited to the immutable beneficiary.

These are source-level properties, not a third-party audit or a guarantee that a deployment matches this source.

## Build and test

From `contracts/`:

```sh
npm ci
npm run compile
npm test
```

The GitHub Actions contract workflow runs the configured chain-ID matrix when its path filters are triggered. Review the actual workflow run for the exact release commit; do not treat the existence of the workflow as a pass.

## Deployment and verification

No production deployment address or verified explorer source link is recorded in this documentation set. After each authorized deployment:
1. record network, chain ID, token address and deployment transaction;
2. read `name()`, `symbol()`, `decimals()`, `totalSupply()`, and balances from a public read-only RPC;
3. verify source code and compiler settings on the relevant explorer;
4. for Ethereum, record and verify the separate vesting contract address, beneficiary, allocation, release schedule and current released amount;
5. compare the observed state to [Supply](../Tokenomics/Supply.md) and the [release registry](../../../../docs/BALMZ-RELEASE-READINESS.md).

Do not use the vesting contract address as the token address. Do not confuse Sepolia or local addresses with Mainnet.

## Solana

The Solana Mainnet allocation is a separate SPL mint and is not deployed by the Solidity contracts. The inspected repository tree contains no production Solana Mainnet mint implementation/deployment record. Keep the existing Devnet mint separate. The Mainnet mint must be implemented, reviewed, deployed by its authorized signer, and checked for mint authority, freeze authority, decimals and supply before production release.
