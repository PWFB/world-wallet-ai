# BALMZ Token Contract

BALMZ is a fixed-supply ERC-20 implementation using OpenZeppelin Contracts 5.6.1, pinned in package.json and package-lock.json. The contract has no owner mint, pause, proxy, or upgrade function.

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

- Ethereum Mainnet (chain ID 1): total supply **11,000,000,000**. It mints 10 billion to the deploying OKX EOA and 1 billion directly to a separate immutable vesting contract.
- BNB Chain Mainnet (chain ID 56): total supply **10,000,000,000** to the same approved OKX EOA.
- Sepolia (chain ID 11155111): separate **1,000,000,000** test supply. It is not part of Mainnet supply.
- Local Hardhat (chain ID 31337): mirrors the Ethereum allocation for tests only.
- Other chain IDs revert during construction.

The fixed reserve recipient is the existing OKX EOA:

    0xBbDb482aE0895e496676eC84501d2945a404FF2C

On Ethereum Mainnet, the contract requires the deploying signer to match this address. The Ethereum deployment therefore needs to be signed by that OKX account.

The 1-billion reserve is held by a separate `BalmzReserveVesting` contract. Its beneficiary is permanently fixed to the OKX EOA above. The schedule is a 365-day cliff followed by 1,095 days of linear vesting. Nothing is releasable before or at the cliff; after the cliff, vested tokens become releasable linearly until the full allocation is vested. Anyone may trigger a release, but tokens can only be sent to the immutable beneficiary. There is no owner, administrator, revocation, or alternate withdrawal function.

Immediately after Ethereum deployment:
- BALMZ total supply: **11,000,000,000**
- OKX EOA liquid balance: **10,000,000,000**
- Vesting contract balance: **1,000,000,000**
- OKX EOA does not receive the reserve immediately.

The Solana 10-billion allocation is a separate SPL mint/program and is **not deployed by this Solidity contract**. The 31-billion global target must not be reported as fully deployed until the Solana Mainnet mint is independently created and verified. Solana Devnet and Sepolia test tokens are excluded from production totals. Devnet tokens cannot be transferred across to Mainnet; a future migration would need an explicit snapshot/claim design.

## Wallet-signed Ethereum deployment using OKX

Use the existing OKX EOA. Do not export a private key, seed phrase, or recovery phrase.

1. Open Remix at https://remix.ethereum.org in a browser with the OKX wallet provider available.
2. Use the reviewed `BalmzToken.sol` and `BalmzReserveVesting.sol` source files from the same approved release/commit. The token imports and deploys the vesting contract during its constructor; do not compile an older token source or omit the vesting source.
3. Resolve the OpenZeppelin dependency using the exact version recorded in the approved `contracts/package-lock.json`. The package manifest currently allows `@openzeppelin/contracts` versions compatible with `^5.4.0`; do not assume that this means exactly 5.4.0.
4. Compile with Solidity **0.8.24**, optimizer disabled, and the exact source/imports from this repository.
5. In Deploy & Run, select **Injected Provider - OKX Wallet**. Confirm the network is Ethereum Mainnet (chain ID 1) and the active account is exactly the reserve recipient above.
6. Deploy `BalmzToken` with **no constructor arguments**. This deployment also creates the vesting contract from inside the token constructor, so review the full transaction and gas estimate in OKX before signing it yourself.
7. Wait for a successful transaction receipt. Read the deployed contract values and check:
   - `name()` = `BALMZ Token`
   - `symbol()` = `BALMZ`
   - `decimals()` = 18
   - `totalSupply()` = 11,000,000,000 BALMZ
   - `INITIAL_SUPPLY()` = 11,000,000,000 BALMZ
   - `RESERVE_RECIPIENT()` = the OKX address above
   - `RESERVE_MINTED_SUPPLY()` = 1,000,000,000 BALMZ
   - `RESERVE_VESTING_WALLET()` = a non-zero vesting contract address
   - `balanceOf(OKX address)` = 10,000,000,000 BALMZ
   - `balanceOf(RESERVE_VESTING_WALLET())` = 1,000,000,000 BALMZ
8. Open the vesting contract at `RESERVE_VESTING_WALLET()` and verify:
   - `token()` = the deployed BALMZ token address
   - `beneficiary()` = the OKX address above
   - `totalAllocation()` = 1,000,000,000 BALMZ
   - `released()` = 0
   - `cliffTimestamp() - startTimestamp()` = 365 days
   - `vestingEndTimestamp() - cliffTimestamp()` = 1,095 days
   - `releasable()` = 0 immediately after deployment

Do not sign if the selected chain, account, either Solidity source file, vesting beneficiary, allocation, schedule, or expected balances differ.

## Source verification and application registration

After deployment:

1. Verify the BALMZ token and the separately deployed vesting contract on Etherscan. Use Solidity 0.8.24, the reviewed compiler settings, the exact OpenZeppelin dependency version, and the complete source/import set from the approved release. Standard JSON Input is recommended.
2. Wait until Etherscan explicitly displays **Contract Source Code Verified**. A successful deployment receipt alone is not source verification.
3. Record the contract address, transaction hash, block number, chain ID, verified source link, and observed total supply.
4. Set the Render backend environment variable `WORLD_WALLET_BALMZ_ETH_CONTRACT` to the verified token address. Do not set a placeholder. Record the vesting address separately; do not configure it as the token contract address.
5. For the separate BNB deployment, use the same source on chain ID 56, sign from the same OKX EOA, verify the contract on BscScan, then set `WORLD_WALLET_BALMZ_BNB_CONTRACT` to its verified address.
6. Refresh World Wallet AI and confirm that live `totalSupply`, `balanceOf`, transaction history, and receipts are read from the correct chain. The application must not invent balances or market prices.

The backend reads live balances only after a real contract address is configured and chain-verified. Ethereum and BNB contracts are separate deployments and have separate addresses. There is no implicit bridge or transfer of supply between chains.

## Hardhat compile, test, and deployment helpers

Install dependencies:

    cd contracts
    npm install

Compile and run the fixed-supply tests:

    npm run compile
    npm test

The optional Hardhat deployment helper supports Ethereum, BNB, Sepolia, and local Hardhat chain 31337. It requires a locally configured `DEPLOYER_PRIVATE_KEY`; never commit that value. For Mainnet, the helper checks that the signer equals the approved OKX reserve EOA and checks the chain-specific supply. The wallet-signed Remix flow above is the recommended path when the owner wants to review and sign directly in OKX.

Configure RPC URLs locally (never commit secrets):

    ETH_RPC_URL=https://your-ethereum-mainnet-rpc
    BSC_RPC_URL=https://your-bnb-mainnet-rpc
    SEPOLIA_RPC_URL=https://your-sepolia-rpc

Run one network at a time:

    npm run deploy:ethereum
    npm run deploy:bnb
    npm run deploy:sepolia

Use Sepolia only for test transactions. Mainnet deployments cost real ETH or BNB and require explicit wallet review and signature.

## Real-balance and settlement policy

After deployment:

- Ethereum reserve balances must be displayed separately: liquid OKX balance and locked vesting-contract balance.
- The vesting contract is not an additional token supply; its 1 billion BALMZ is already included in Ethereum's 11-billion total.
- `totalSupply` is read from the chain.
- `balanceOf(wallet)` is read from the chain.
- Transfers use the ERC-20 `transfer(address,uint256)` method.
- Transaction settlement is accepted only after the chain receipt and `Transfer` event are verified.
- The application database is a cache/accounting view, not the token ledger.
- BALMZ market price remains unavailable until a genuine, independently verifiable market source exists.
