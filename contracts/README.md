# BALMZ Token Contract

BALMZ is a fixed-supply ERC-20 implementation using OpenZeppelin Contracts 5.6.1, pinned in package.json and package-lock.json. The contract has no owner mint, pause, proxy, or upgrade function.

> **Pre-launch status:** these are source/build instructions, not proof of Mainnet deployment or a security audit. No production deployment manifest with verified token/vesting addresses and explorer source links is recorded in the release-readiness register. See [BALMZ Release Readiness](../docs/BALMZ-RELEASE-READINESS.md).

## Global Mainnet supply plan

The global production allocation is **31,000,000,000 BALMZ**:

| Network / allocation | Fixed allocation |
|---|---:|
| Ethereum Mainnet distribution | 10,000,000,000 |
| BNB Chain Mainnet distribution | 10,000,000,000 |
| Solana Mainnet SPL allocation | 10,000,000,000 |
| Reserve on Ethereum | 1,000,000,000 |
| **Global target** | **31,000,000,000** |

The EVM contract is chain-aware and cannot be deployed on an unapproved chain:

- Ethereum Mainnet (chain ID 1): total supply **11,000,000,000**. It mints 10 billion to the deploying approved EOA and 1 billion directly to a separate immutable vesting contract.
- BNB Chain Mainnet (chain ID 56): total supply **10,000,000,000** to the same approved EOA.
- Sepolia (chain ID 11155111): separate **1,000,000,000** test supply. It is not part of Mainnet supply.
- Local Hardhat (chain ID 31337): mirrors the Ethereum allocation for tests only.
- Other chain IDs revert during construction.

The fixed reserve recipient in the current source is:

    0xBbDb482aE0895e496676eC84501d2945a404FF2C

On Ethereum Mainnet, the contract requires the deploying signer to match this address. This configuration is a release-critical decision: confirm the recipient and signer independently in the wallet UI and approved release record before deployment. Do not infer control/ownership from source code.

The 1-billion reserve is held by a separate `BalmzReserveVesting` contract. Its beneficiary is permanently fixed to the recipient above. The schedule is a 365-day cliff followed by 1,095 days of linear vesting. Nothing is releasable before or at the cliff; after the cliff, vested tokens become releasable linearly until the full allocation is vested. Anyone may trigger a release, but tokens can only be sent to the immutable beneficiary. There is no owner, administrator, revocation, or alternate withdrawal function.

Immediately after a successful Ethereum deployment:
- BALMZ total supply: **11,000,000,000**
- approved EOA liquid balance: **10,000,000,000**
- vesting contract balance: **1,000,000,000**
- approved EOA does not receive the reserve immediately.

The Solana 10-billion allocation is a separate SPL mint/program and is **not deployed by this Solidity contract**. The reviewed source tree does not contain a production Solana Mainnet mint deployment artifact. The 31-billion global target must not be reported as deployed until the Solana Mainnet mint is independently created and verified. Solana Devnet and Sepolia test tokens are excluded from production totals.

## Wallet-signed Ethereum deployment using OKX

Use the approved EOA's wallet application. Do not export or paste a private key, seed phrase, or recovery phrase.

1. Open Remix at https://remix.ethereum.org in a browser with the approved wallet provider available.
2. Use the reviewed `BalmzToken.sol` and `BalmzReserveVesting.sol` source files from the same approved release/commit.
3. Resolve OpenZeppelin from the approved lockfile. Both `contracts/package.json` and `contracts/package-lock.json` pin `@openzeppelin/contracts` to exactly **5.6.1**. In this Hardhat project, install with `npm ci`.
4. Compile with Solidity **0.8.24**, optimizer disabled, and the exact source/imports from the approved release.
5. In Deploy & Run, select **Injected Provider - OKX Wallet**. Confirm Ethereum Mainnet (chain ID 1) and the active account is exactly the configured reserve recipient.
6. Deploy `BalmzToken` with **no constructor arguments**. This deploys the vesting contract from inside the token constructor. Review the full transaction and gas estimate in the wallet before signing.
7. After a successful receipt, verify name, symbol, decimals, totalSupply, initial supply, reserve recipient, reserve allocation, vesting address and balances on-chain.
8. Verify the vesting contract's token, beneficiary, allocation, released amount, cliff and end timestamps.

Do not sign if the chain, account, source files, vesting beneficiary, allocation, schedule, or expected balances differ.

## Source verification and application registration

After deployment:

1. Verify both BALMZ token and vesting source on Etherscan using Solidity 0.8.24, the exact compiler settings, OpenZeppelin dependency and complete source/import set.
2. Wait until Etherscan explicitly displays **Contract Source Code Verified**.
3. Record token and vesting addresses, transaction hashes, block number, chain ID, source links, and observed supply in the release registry.
4. Set backend `WORLD_WALLET_BALMZ_ETH_CONTRACT` to the verified token address, never a placeholder or the vesting address.
5. For BNB Chain, deploy the approved source on chain ID 56, verify on BscScan, and set `WORLD_WALLET_BALMZ_BNB_CONTRACT` to the verified token address.
6. Refresh the application and confirm live supply, balances, transaction history and receipts are read from the correct chain.

## Hardhat compile, test, and deployment helpers

Install the exact locked dependencies:

    cd contracts
    npm ci

Compile and run fixed-supply tests:

    npm run compile
    npm test

The deployment helper supports Ethereum, BNB, Sepolia, and local Hardhat. It requires local `DEPLOYER_PRIVATE_KEY`; never commit that value. Mainnet helper checks the signer against the approved EOA and checks chain-specific supply.

Configure RPC URLs locally (never commit secrets):

    ETH_RPC_URL=https://your-ethereum-mainnet-rpc
    BSC_RPC_URL=https://your-bnb-mainnet-rpc
    SEPOLIA_RPC_URL=https://your-sepolia-rpc

Run one network at a time only after owner-controlled review:

    npm run deploy:ethereum
    npm run deploy:bnb
    npm run deploy:sepolia

Mainnet deployments cost real ETH or BNB and require explicit wallet review and signature. They are not performed by this documentation workflow.

## Real-balance and settlement policy

- Ethereum reserve balances must be displayed separately: liquid EOA balance and locked vesting-contract balance.
- The vesting contract reserve is already included in Ethereum's 11-billion total.
- `totalSupply` and `balanceOf(wallet)` must be read from the chain.
- Transfers are settled only after the chain receipt and `Transfer` event are verified.
- The application database is a cache/accounting view, not the token ledger.
- BALMZ market price remains unavailable until a genuine, independently verifiable market source exists.
