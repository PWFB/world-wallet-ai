# BALMZ Global Supply Reconciliation — Implementation Specification

Status: design-only; no Mainnet addresses or RPC credentials are asserted by this document.

## Purpose

Define a read-only, independently reproducible way to compare BALMZ production token supply across Ethereum Mainnet, BNB Chain Mainnet, and Solana Mainnet against the approved 31,000,000,000 BALMZ global allocation. This closes an evidence gap between per-chain readiness checks and a defensible global supply statement.

This specification is not a deployment, mint, transfer, authority-revocation, or presale-activation instruction.

## Canonical production allocation

All values below are whole-token quantities, not additional allocations:

| Production network | Chain identifier | Expected token decimals | Approved allocation |
|---|---:|---:|---:|
| Ethereum Mainnet | EVM chain ID 1 | 18 | 11,000,000,000 |
| BNB Chain Mainnet | EVM chain ID 56 | 18 | 10,000,000,000 |
| Solana Mainnet | Mainnet-beta genesis identity | 9 | 10,000,000,000 |
| **Global maximum** | — | — | **31,000,000,000** |

The Ethereum 11B total comprises 10B liquid distribution plus 1B in the immutable reserve-vesting contract. The reserve is already included in Ethereum's 11B and must never be added again. The initial 1B Solana presale tranche is included in Solana's 10B, not additional supply. Sepolia, Devnet, and local test deployments are excluded from production totals.

## Required configuration and identity

Each production chain record must be configured explicitly with:
- network identity (EVM chain ID or Solana Mainnet genesis hash);
- verified token contract or mint address;
- expected token decimals;
- approved allocation in whole-token base units;
- trusted read-only RPC endpoint(s);
- explorer URL for human cross-checking.

The Ethereum and BNB contract addresses are not currently recorded as verified production evidence. The production Solana mint is also not recorded; the known Devnet mint is test-only and must be rejected. Missing or placeholder configuration means `NOT_CONFIGURED`, never zero supply and never a passing check.

Do not accept an address supplied only by a frontend, user-entered query, token symbol lookup, or explorer search result as authoritative configuration. Bind each address to a reviewed release record.

## Read-only chain observations

### Ethereum and BNB Chain

For each configured chain, query the configured RPC and independently verify:
1. RPC chain ID matches the expected chain ID.
2. Contract bytecode exists at the exact configured address.
3. The contract responds to `name()`, `symbol()`, `decimals()`, and `totalSupply()`.
4. Decimals equal 18.
5. The observed raw `totalSupply()` is an integer base-unit value and is exactly convertible to whole BALMZ without floating-point arithmetic.
6. Ethereum's configured vesting contract address is distinct from the token address; its token reference, immutable beneficiary, allocation, and current token balance are read and cross-checked.
7. Ethereum token balance accounting distinguishes liquid allocation from the 1B vesting reserve. Do not add the vesting balance to `totalSupply()`.
8. BNB's observed supply is checked against its 10B allocation.

A successful ABI call alone does not prove verified source code, immutable behavior, or project ownership. Record source-verification status separately and require the exact deployed bytecode/source match in the release evidence.

### Solana Mainnet

For the configured mint:
1. Confirm the RPC genesis hash is the known Solana Mainnet-beta genesis identity.
2. Read the exact mint account at finalized commitment.
3. Confirm account owner is the expected SPL Token Program (or the explicitly approved Token-2022 program if the release is changed and reviewed).
4. Confirm initialized mint state and 9 decimals.
5. Read raw mint supply and independently compare it with `getTokenSupply` raw amount.
6. Record mint authority and freeze authority exactly as observed; do not infer that either is revoked.
7. Reject Devnet addresses, missing accounts, malformed metadata, non-integer supply, and inconsistent RPC observations.

## Exact arithmetic and normalization

- Store and compare raw supply as integer base units (EVM uint256 / Solana integer amount).
- Convert to display units using decimal-string arithmetic only. Never use JavaScript/Python binary floating-point for authoritative totals.
- Reject negative, fractional-base-unit, exponential, NaN, infinity, boolean, missing, or malformed numeric values.
- Do not sum raw base units across chains with different decimals. Normalize each observation to an exact whole-token integer only after verifying that the raw amount is divisible by its chain's decimal scale.
- Preserve the raw base-unit value, decimals, and normalized whole-token string in the evidence record.

## Global reconciliation result

The report must distinguish:
- `NOT_CONFIGURED`: any required production address/network identity is missing.
- `RPC_UNAVAILABLE`: no trusted RPC observation can be obtained.
- `NETWORK_ID_MISMATCH`: RPC is not the expected production network.
- `CONTRACT_OR_MINT_INVALID`: bytecode/account/program/metadata checks fail.
- `SUPPLY_MISMATCH`: observed per-chain supply differs from its approved allocation.
- `GLOBAL_CAP_EXCEEDED`: sum of observed production supply exceeds 31B.
- `PARTIAL_DEPLOYMENT`: one or more chains have valid evidence but not all three are verified.
- `RECONCILED`: all three production chains are independently observed, each matches its approved allocation, and the exact global sum is 31B.

A missing chain must never be treated as zero to produce a green global result. A partially deployed token must be reported as partial, not as a fully reconciled 31B supply.

## Evidence and audit record

For every observation retain:
- UTC observation timestamp;
- network name and chain ID/genesis identity;
- configured contract/mint address and token decimals;
- raw base-unit supply and normalized whole-token supply;
- EVM block number and block hash, or Solana finalized slot and relevant context slot;
- RPC provider identifier (never credentials), response-validation result, and independent second-source comparison;
- explorer verification URL/status, when available;
- vesting contract address and observed reserve balance separately for Ethereum;
- mint/freeze authority state for Solana;
- software release commit and reconciliation implementation version.

Evidence is append-only or versioned; a later observation must not overwrite the historical record. Do not store RPC secrets, private keys, signatures unrelated to public transaction evidence, or wallet recovery material.

## Admin/API and UI requirements

If implemented, expose this as an authenticated administrator-only read endpoint. It must:
- be read-only and make no database repair or chain transaction;
- return per-chain statuses, evidence timestamps, raw supply, exact normalized supply, and explicit reasons for failure;
- show global status as `NOT_CONFIGURED` / `PARTIAL_DEPLOYMENT` until every required chain has verified evidence;
- show allocation policy separately from observed on-chain supply;
- never present allocation targets as balances or live supply;
- include `transaction_authorized: false`, `presale_release_gate_changed: false`, and `read_only: true` in its result;
- emit an administrator audit event for report access without storing sensitive credentials.

The buyer-facing wallet must continue to display only chain-specific values returned from the correct network. Do not display a 31B global total as a user's balance or as circulating supply.

## Regression and adversarial test matrix

Tests must cover:
- missing address on each chain; placeholder and Devnet address rejection;
- RPC returning wrong EVM chain ID or wrong Solana genesis hash;
- absent bytecode, wrong contract, wrong token program, uninitialized mint;
- decimals mismatch on each chain;
- malformed, missing, boolean, negative, fractional, exponential, overflow, or inconsistent raw supply;
- EVM vesting address equal to token address; vesting token/beneficiary/allocation mismatch;
- Ethereum liquid plus vesting accounting without double-counting reserve;
- Sepolia/Devnet/local supply excluded from production sum;
- exact 31B pass, partial deployment, per-chain shortfall, per-chain over-allocation, and global cap exceeded;
- two RPC sources disagreeing on block/slot or supply;
- stale evidence and RPC outage fail closed;
- all output flags remain read-only and false.

## Release boundary

This specification does not create or deploy any contract or mint, register production addresses, query private RPC credentials, change environment variables, enable presale intents or settlement, transfer tokens, revoke mint/freeze authority, or authorize refunds.

The five `WORLD_WALLET_BALMZ_PRESALE_*` release flags remain false. A passing software report is not a substitute for independent contract review, treasury ownership proof, third-party security audit, owner-controlled wallet review, and explicit release approval.
