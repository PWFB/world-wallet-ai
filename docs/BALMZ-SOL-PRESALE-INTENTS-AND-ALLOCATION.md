# BALMZ-SOL payment intents and allocation ledger

## Implemented in this change

- Server-priced payment intents use the configured USD presale target ($7 per token) and a fresh CoinGecko SOL/USD quote. The browser cannot submit expected lamports or override the price.
- SOL payment amounts are converted to integer lamports using round-up semantics; BALMZ-SOL quantities are represented at exactly 9 decimals.
- Quotes expire after 20 minutes and bind the authenticated account, payer public address, treasury address, token amount, USD price, SOL/USD quote, expected lamports, and quote timestamp.
- PostgreSQL reserves tokens when an intent is created. Expired pending intents release their reservations when the next intent is created or the expired intent is settled.
- Settlement re-verifies the submitted transaction at finalized Solana Mainnet commitment and checks the payer, treasury and exact lamport amount.
- The allocation state row is locked during reservation and settlement. Unique constraints on intent ID and transaction signature prevent replay across multiple orders. The database transaction records the allocation ledger row, increments allocated supply, releases the reservation, and marks the intent settled atomically.
- The allocation cap is 1,000,000,000 BALMZ-SOL, inside (not additional to) the 10,000,000,000 Solana allocation.

## Safety gates

All flags default to false and must remain unset until the release has been independently approved:

- `WORLD_WALLET_BALMZ_PRESALE_INTENTS_ENABLED`
- `WORLD_WALLET_BALMZ_PRESALE_SETTLEMENT_ENABLED`
- `WORLD_WALLET_BALMZ_PRESALE_RELEASE_APPROVED`
- `WORLD_WALLET_BALMZ_PRESALE_TREASURY_OWNERSHIP_VERIFIED`

Both endpoints fail closed unless their relevant feature flag, explicit release approval, and treasury ownership verification are true. Intent creation additionally checks the production mint, exact 10B supply, revoked mint/freeze authorities, Mainnet treasury account, and a fresh SOL/USD quote. The status endpoint reports payment acceptance enabled only when all required flags and the observable mint/treasury checks pass.

## Endpoints

- `POST /api/v1/balmz/presale/intents`: authenticated account, payer address, and BALMZ-SOL quantity. The server calculates the amount due.
- `POST /api/v1/balmz/presale/settle`: authenticated account, intent ID, and Solana transaction signature. A pending or non-finalized transaction does not settle.

## Important boundaries

- No Render environment variables are changed by this code change. The feature flags are not enabled.
- No payment instructions are exposed while gates are closed. Do not ask customers to send funds until release approval.
- The allocation ledger records a database entitlement only. It does not mint, transfer, or deliver BALMZ-SOL on-chain.
- No refund, chargeback, overpayment credit, partial payment, or treasury reconciliation workflow is implemented. Non-exact transfers are rejected and require a separate manual support/refund process.
- A finalized transaction and a configured treasury balance do not independently prove legal ownership or authority. The treasury ownership flag requires separate wallet-native proof and project-owner review.
- A database ledger is not proof of reserves and is not a token custody system.
- The $7 USD presale quote is separate from the planned 1 BALMZ-SOL = 1 SOL launch target; that target is not a guaranteed market price or liquidity mechanism.

## Validation still required before release

Run the complete API test suite, database-backed concurrency tests against PostgreSQL, production RPC integration tests, security review, and reconciliation/refund workflow review. The feature must remain disabled until those checks pass and the project owner approves the release.
