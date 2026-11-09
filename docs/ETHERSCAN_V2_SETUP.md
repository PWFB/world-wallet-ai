# Etherscan API V2 integration

World Wallet AI can use an Etherscan API V2 key for read-only EVM explorer lookups and contract source-verification status.

## Backend configuration

Set the Render backend environment variable:

- `ETHERSCAN_API_KEY` — secret Etherscan API key. Keep it backend-only. Do not add it to a `VITE_*` variable, frontend bundle, repository, wallet backup, or client request.

Etherscan API V2 uses the unified endpoint `https://api.etherscan.io/v2/api` and passes the chain ID per request:

| World Wallet AI network | Chain ID |
| --- | ---: |
| Ethereum Mainnet | 1 |
| BNB Smart Chain Mainnet | 56 |
| Ethereum Sepolia | 11155111 |

The same Etherscan V2 key is used across supported chains. The backend adds the API key to provider requests and never returns it in API responses.

## Verify the configured provider

Sign in to the World Wallet AI owner account and open **Admin → System Settings**.

The configuration list reports only whether the Etherscan key is present. Use **Test Etherscan API** to run read-only account-balance probes on Ethereum Mainnet, BNB Smart Chain and Sepolia against a fixed public address. The response reports each chain's result without returning the key or customer wallet data.

## Contract checks

**Tools → Verify Contract** first checks deployed bytecode using the network's configured RPC endpoint. When `ETHERSCAN_API_KEY` is configured, it separately asks Etherscan whether source code is verified and returns limited metadata such as contract name and compiler version.

A positive source-verification result means the explorer has a published source listing. It is not a security audit, ownership proof, reserve attestation, or recommendation to interact with the contract.

## Permissions and limits

This integration performs read-only HTTP GET requests only. It does not request wallet signatures, send transactions, deploy contracts, pay gas, or change token balances. Provider rate limits and network support apply.
