# BALMZ Token Contract

BALMZ is implemented as a standard fixed-supply ERC-20 using OpenZeppelin.

## Real balance policy

The World Wallet application must never invent a BALMZ balance. After deployment:

- totalSupply is read from the blockchain.
- balanceOf(wallet) is read from the blockchain.
- transfers use the ERC-20 transfer(address,uint256) method.
- transaction settlement is accepted only after the blockchain receipt and Transfer event are verified.
- the application database is a cache/accounting view, not the token ledger.

## Deployment

Install OpenZeppelin contracts in the deployment project:

    npm install @openzeppelin/contracts

Compile and deploy contracts/BalmzToken.sol from the account that should receive the initial supply.

After deployment, record the network, contract address, deployer address, deployment transaction hash, verified source/explorer page, and total supply.

Never put a private key in this repository.

## Sepolia test deployment

Use the Sepolia testnet first. Add these values to a local `.env` file (never commit it):

    DEPLOYER_PRIVATE_KEY=0x...
    SEPOLIA_RPC_URL=https://your-sepolia-rpc-provider

Then run:

    npm install
    npm run compile
    npm run deploy:sepolia

The script prints the Sepolia contract address and the environment variable name `WORLD_WALLET_BALMZ_SEPOLIA_CONTRACT`. Sepolia ETH is testnet-only and has no mainnet monetary value. Use a faucet to obtain test ETH for deployment gas.

## Production configuration

For Ethereum mainnet, configure:

    WORLD_WALLET_BALMZ_ETH_CONTRACT=0x...

For the testnet, configure separately:

    WORLD_WALLET_BALMZ_SEPOLIA_CONTRACT=0x...
    WORLD_WALLET_SEPOLIA_RPC_URL=https://your-sepolia-rpc-provider

The API tracks the Sepolia token under the separate `BALMZ-SEP` display symbol so testnet balances are never added to the Ethereum-mainnet BALMZ balance. Its price is intentionally shown as unlisted / unavailable.

The wallet displays the same EVM public address on Ethereum and Sepolia; this does not create a new key or move funds between networks. Never send mainnet assets to a testnet address expecting them to appear on mainnet.

BALMZ market price remains unavailable / unlisted until a genuine, independently verifiable market source exists. The app must not fabricate a balance or price.

## Supply policy

The contract has a fixed initial supply of 1,000,000,000 BALMZ and exposes no public mint function. The deployer receives the initial supply. Distribution after deployment happens through normal on-chain transfers.
