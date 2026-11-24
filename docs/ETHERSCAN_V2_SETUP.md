# Etherscan API V2 integration

World Wallet AI can use an Etherscan API V2 key for read-only EVM explorer lookups and contract source-verification status.

## Backend configuration

Set the Render backend environment variable:

- `ETHERSCAN_API_KEY` — secret Etherscan API key. Keep it backend-only. Do not add it to a `VITE_*` variable, frontend bundle, repository, wallet backup, or client request.
- `WORLD_WALLET_POLYGON_RPC_URL` — optional Polygon PoS RPC URL; defaults to `https://polygon-rpc.com` and is chain-ID checked as `137`. This RPC is used for bytecode reads; Etherscan V2 supplies explorer source metadata.

Etherscan API V2 uses the unified endpoint `https://api.etherscan.io/v2/api` and passes the chain ID per request:

| World Wallet AI network | Chain ID |
| --- | ---: |
| Ethereum Mainnet | 1 |
| BNB Smart Chain Mainnet | 56 |
| Ethereum Sepolia | 11155111 |
| Polygon PoS Mainnet | 137 |

The same Etherscan V2 key is used across supported chains. The backend adds the API key to provider requests and never returns it in API responses.

## Verify the configured provider

Sign in to the World Wallet AI owner account and open **Admin → System Settings**.

The configuration list reports only whether the Etherscan key is present. Use **Test Etherscan API** to run read-only account-balance probes on Ethereum Mainnet, BNB Smart Chain, Sepolia and Polygon PoS against a fixed public address. The response reports each chain's result without returning the key or customer wallet data.

## Read-only address data endpoint

Authenticated users can request indexed address activity from the backend:

- `POST /api/v1/explorer/address`
- JSON body: `{"network":"polygon","address":"0x...","page":1,"offset":25}`
- Supported networks: `ethereum` (1), `bnb` (56), and `polygon` (137).
- Returns the native balance in base units plus paginated normal transactions, ERC-20 transfers, and internal transactions.

The endpoint validates the EVM address, caps page size at 100, and keeps the API key on the backend. It does not sign, send, or modify transactions. Provider plan limits and rate limits apply; the balance is a live latest-state read while activity is returned from the explorer's indexed history.

## Contract checks

**Tools → Verify Contract** first checks deployed bytecode using the network's configured RPC endpoint. When `ETHERSCAN_API_KEY` is configured, it separately asks Etherscan whether source code is verified and returns limited metadata such as contract name and compiler version.

A positive source-verification result means the explorer has a published source listing. It is not a security audit, ownership proof, reserve attestation, or recommendation to interact with the contract.

## Permissions and limits

This integration performs read-only HTTP GET requests only. It does not request wallet signatures, send transactions, deploy contracts, pay gas, or change token balances. Provider rate limits and network support apply.
