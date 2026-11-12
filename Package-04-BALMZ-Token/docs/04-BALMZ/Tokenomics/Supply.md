# BALMZ Token Supply and Allocation

## Approved global production allocation

The repository's approved supply target is **31,000,000,000 BALMZ** across Ethereum Mainnet, BNB Chain Mainnet, and Solana Mainnet.

| Network / purpose | Allocation | Share of global target |
|---|---:|---:|
| Ethereum liquid distribution | 10,000,000,000 | 32.2581% |
| Ethereum reserve vesting | 1,000,000,000 | 3.2258% |
| BNB Chain distribution | 10,000,000,000 | 32.2581% |
| Solana Mainnet allocation | 10,000,000,000 | 32.2581% |
| **Global total** | **31,000,000,000** | **100%** |

The 1B Ethereum reserve is included in Ethereum's 11B chain supply. The Solana initial presale tranche of 1B is included within the Solana 10B allocation. Neither is additional supply.

## Per-network supply

| Chain | Planned production supply | Decimals | State |
|---|---:|---:|---|
| Ethereum Mainnet | 11,000,000,000 | 18 | Defined in Solidity source; deployment evidence not recorded here |
| BNB Chain Mainnet | 10,000,000,000 | 18 | Defined in Solidity source; deployment evidence not recorded here |
| Solana Mainnet | 10,000,000,000 | 9 | Allocation approved in docs; production mint implementation/proof pending |

The EVM constructor selects the supply based on chain ID and rejects unsupported chain IDs. Ethereum requires the fixed approved deploying EOA and creates a 1B reserve vesting contract. BNB Chain requires the same configured EOA and mints 10B. The EVM contract contains no post-deployment mint function.

## Test supply is separate

- Sepolia: 1,000,000,000 BALMZ test tokens, chain ID 11155111.
- Local Hardhat: a local test mirror of the Ethereum allocation, chain ID 31337.
- Solana Devnet mint `HBSuf6Dm9r2ebkwLUoaY8ScR2rq5L2CPTJpCbqMbtndF`: Devnet only. Never display or submit this as a production Mainnet mint.

Testnet tokens are not part of the production global allocation, are not redeemable for Mainnet tokens, and must not be counted as circulating supply or reserves.

## Mint and authority policy

### EVM

The Solidity source uses construction-time minting only. It has no external `mint`, `owner`, `pause`, `upgradeTo`, or mutable supply controls. Actual chain supply must still be read from the deployed address and compared with this specification.

### Solana

The 10B allocation and 9 decimals are the intended policy. No Solana Mainnet mint should be announced until its implementation and authority configuration are reviewed. If the supply is fixed, mint the approved supply once and revoke mint authority after verifying the exact amount. Decide the freeze authority deliberately, disclose the choice, and verify the resulting authority fields on-chain. Do not infer authority state from a wallet display or Devnet transaction.

## Circulating supply

A chain allocation is not the same as circulating supply. The Ethereum 1B vesting allocation remains held by its vesting contract until releasable under the published schedule. Report it separately from liquid balances. For BNB Chain and Solana, report locked, treasury, presale, and distributed portions separately only when the actual on-chain accounts and controls are evidenced.

Do not add balances from multiple chains without accounting for any bridge or wrapped representation. The current reviewed design does not include an automatic bridge.

## No market-price promise

The supply schedule does not establish a market price. Do not report a target, a wallet valuation, or a proposed pool ratio as guaranteed value. Publish prices only from a genuine, timestamped, independently verifiable market source, with the source and market pair named.
