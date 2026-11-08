# BALMZ network-qualified token metadata registry

World Wallet AI uses the existing PostgreSQL token_registry table and the authenticated
GET /api/v1/tokens endpoint as its token catalog. This document records the BALMZ
network identities and the evidence required before a contract or mint is treated as live.

## Registry entries

| Display symbol | Network | Identifier | Decimal policy | Initial state |
|---|---|---|---|---|
| **BALMZ** | Ethereum Mainnet | EVM chain ID 1 | 18 decimals in the checked-in Solidity source; deployment still needs on-chain verification | pending_contract until WORLD_WALLET_BALMZ_ETH_CONTRACT is configured |
| **BALMZ-BNB** | BNB Chain Mainnet | EVM chain ID 56 | Read from the BNB RPC after a contract is configured; never assume decimals from the symbol | pending_contract |
| **BALMZ-SOL** | Solana Mainnet | Mainnet cluster | Read from the mint account; no decimals are assumed until verified | pending_contract |
| **BALMZ-SEP** | Ethereum Sepolia | EVM chain ID 11155111 | Testnet metadata only | Separate testnet record |
| **BALMZ-SOL-DEVNET** | Solana Devnet | Devnet cluster | Existing Devnet-only mint metadata | Testnet/catalog-only record |

The existing Devnet mint HBSuf6Dm9r2ebkwLUoaY8ScR2rq5L2CPTJpCbqMbtndF is **not** a
Solana Mainnet mint and is never copied into the Mainnet row.

## Backend configuration

Set only public deployment identifiers in the World Wallet AI API service environment:

- WORLD_WALLET_BALMZ_ETH_CONTRACT — deployed Ethereum Mainnet ERC-20 address.
- WORLD_WALLET_BALMZ_BNB_CONTRACT — deployed BNB Chain Mainnet BEP-20 address.
- WORLD_WALLET_BALMZ_SOLANA_MAINNET_MINT — deployed Solana Mainnet SPL mint.

The BNB and Solana Mainnet values are checked for address format before being added to
the registry. A valid format changes the state to configured_unverified; it does not
mean that the address is an authentic BALMZ contract or mint. Invalid values are withheld
from the public token response and marked invalid_configuration. Missing values remain
pending_contract.

The registry deliberately leaves BNB and Solana Mainnet decimals unset until the
network-specific on-chain metadata check succeeds. No private key, seed phrase, RPC
credential, API key, or signing material belongs in token metadata.

## Verification gates

Before an entry is treated as active or used for balance accounting:

1. Confirm the RPC cluster (Ethereum chain ID 1, BNB chain ID 56, or Solana Mainnet genesis hash).
2. Confirm the configured address contains the expected contract or mint account.
3. Read and compare the on-chain symbol, name, decimals, and total supply with the approved token specification.
4. Record the explorer URL and deployment transaction / signature for audit.
5. Keep testnet entries isolated from production balances, prices, and settlement.

The checked-in contracts/BalmzToken.sol source declares an 18-decimal ERC-20 with an
initial supply of 1,000,000,000 BALMZ and no public mint function. Source code alone is
not evidence that a corresponding Ethereum or BNB contract has been deployed. The
repository does not establish a production BNB contract address or Solana Mainnet mint.

A multi-chain deployment does not automatically preserve a single 1,000,000,000-token
global supply. Do not deploy independent full-supply contracts on multiple networks and
claim a shared cap. A reviewed burn/mint bridge or other enforceable cross-chain issuance
model is required before making that claim.

## Runtime behavior

The existing authenticated GET /api/v1/tokens endpoint exposes the network-qualified
records. The frontend displays BNB and Solana Mainnet as pending or configured-but-
unverified. It does not treat a configured-but-unverified BALMZ record as a verified
balance source. BALMZ prices remain unlisted until a genuine market quote is available.
