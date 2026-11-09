# BALMZ Token Contract

BALMZ is a fixed-supply ERC-20 implementation using OpenZeppelin 5.4.0. The contract has no owner mint, pause, proxy, or upgrade function.

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

- Ethereum Mainnet (chain ID 1): total supply **11,000,000,000**. It mints 10 billion to the deploying OKX EOA and 1 billion to the fixed reserve recipient.
- BNB Chain Mainnet (chain ID 56): total supply **10,000,000,000** to the same approved OKX EOA.
- Sepolia (chain ID 11155111): separate **1,000,000,000** test supply. It is not part of Mainnet supply.
- Local Hardhat (chain ID 31337): mirrors the Ethereum allocation for tests only.
- Other chain IDs revert during construction.

The fixed reserve recipient is the existing OKX EOA:

    0xBbDb482aE0895e496676eC84501d2945a404FF2C

On Ethereum Mainnet, the contract requires the deploying signer to match this address. The Ethereum deployment therefore needs to be signed by that OKX account. Because the distribution and reserve are intentionally assigned to the same EOA, its ERC-20 balance will be 11 billion immediately after deployment (recorded through two mint Transfer events).

The Solana 10-billion allocation is a separate SPL mint/program and is **not deployed by this Solidity contract**. The 31-billion global target must not be reported as fully deployed until the Solana Mainnet mint is independently created and verified. Solana Devnet and Sepolia test tokens are excluded from production totals. Devnet tokens cannot be transferred across to Mainnet; a future migration would need an explicit snapshot/claim design.

## Wallet-signed Ethereum deployment using OKX

Use the existing OKX EOA. Do not export a private key, seed phrase, or recovery phrase.

1. Open Remix at https://remix.ethereum.org in a browser with the OKX wallet provider available.
2. Create or open `BalmzToken.sol` and paste the exact source from this repository: https://github.com/PWFB/world-wallet-ai/blob/main/contracts/BalmzToken.sol
3. Install/resolve the pinned OpenZeppelin dependency `@openzeppelin/contracts@5.4.0` in Remix.
4. Compile with Solidity **0.8.24**, optimizer disabled, and the exact source/imports from this repository.
5. In Deploy & Run, select **Injected Provider - OKX Wallet**. Confirm the network is Ethereum Mainnet (chain ID 1) and the active account is exactly the reserve recipient above.
6. Deploy `BalmzToken` with **no constructor arguments**. Review the deployment transaction and gas fee in OKX, then sign it yourself.
7. Wait for a successful transaction receipt. Read the deployed contract values and check:
   - `name()` = `BALMZ Token`
   - `symbol()` = `BALMZ`
   - `decimals()` = 18
   - `totalSupply()` = 11,000,000,000 BALMZ
   - `INITIAL_SUPPLY()` = 11,000,000,000 BALMZ
   - `RESERVE_RECIPIENT()` = the OKX address above
   - `RESERVE_MINTED_SUPPLY()` = 1,000,000,000 BALMZ
   - `balanceOf(OKX address)` = 11,000,000,000 BALMZ

Do not sign if the selected chain, account, contract source, or expected supply differs.

## Source verification and application registration

After deployment:

1. Open the contract on Etherscan and use **Verify and Publish** with the same Solidity version (0.8.24), optimizer setting (disabled), OpenZeppelin 5.4.0 imports, and exact source. Use Standard JSON Input where possible.
2. Wait until Etherscan explicitly displays **Contract Source Code Verified**. A successful deployment receipt alone is not source verification.
3. Record the contract address, transaction hash, block number, chain ID, verified source link, and observed total supply.
4. Set the Render backend environment variable `WORLD_WALLET_BALMZ_ETH_CONTRACT` to the verified Ethereum address. Do not set a placeholder.
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

The optional Hardhat deployment helper supports the Ethereum, BNB, and Sepolia networks. It requires a locally configured `DEPLOYER_PRIVATE_KEY`; never commit that value. For Mainnet, the helper checks that the signer equals the approved OKX reserve EOA and checks the chain-specific supply. The wallet-signed Remix flow above is the recommended path when the owner wants to review and sign directly in OKX.

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

- `totalSupply` is read from the chain.
- `balanceOf(wallet)` is read from the chain.
- Transfers use the ERC-20 `transfer(address,uint256)` method.
- Transaction settlement is accepted only after the chain receipt and `Transfer` event are verified.
- The application database is a cache/accounting view, not the token ledger.
- BALMZ market price remains unavailable until a genuine, independently verifiable market source exists.
