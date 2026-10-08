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

## Production configuration

Set this API environment variable to the deployed contract address:

    WORLD_WALLET_BALMZ_ETH_CONTRACT=0x...

The API will then register the contract, read the wallet balance with balanceOf, read decimals, sync BALMZ Transfer events, allow live EVM signing for BALMZ, and verify the exact BALMZ Transfer event before settling a send.

Until the address is configured, BALMZ remains explicitly pending_contract and the UI must show no fabricated balance.

## Supply policy

The contract has a fixed initial supply of 1,000,000,000 BALMZ and exposes no public mint function. The deployer receives the initial supply. Distribution after deployment happens through normal on-chain transfers.
