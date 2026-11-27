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
- `WORLD_WALLET_BALMZ_PRESALE_REGRESSION_SUITE_VERIFIED`
- `WORLD_WALLET_BALMZ_PRESALE_DELIVERY_ENABLED`

Both payment endpoints now also fail closed unless the separate token-delivery gate is enabled; payment acceptance cannot open while the buyer delivery path is disabled. The delivery preview/approval/submit endpoints independently require all six release gates. Intent creation additionally checks the production mint, exact 10B supply, revoked mint/freeze authorities, Mainnet treasury account, and a fresh SOL/USD quote. The status endpoint reports payment acceptance enabled only when all required flags and the observable mint/treasury checks pass.

## Endpoints

- `POST /api/v1/balmz/presale/intents`: authenticated account, payer address, and BALMZ-SOL quantity. The server calculates the amount due.
- `POST /api/v1/balmz/presale/settle`: authenticated account, intent ID, and Solana transaction signature. A pending or non-finalized transaction does not settle.

## Important boundaries

- No Render environment variables are changed by this code change. The feature flags are not enabled.
- No payment instructions are exposed while gates are closed. Do not ask customers to send funds until release approval.
- The allocation ledger records a database entitlement only. The separate delivery workflow prepares an unsigned `TransferChecked` transaction, requires exact-message administrator approval, accepts a wallet-signed transaction, broadcasts once, and marks delivery only after finalized-chain verification.
- No refund, chargeback, overpayment credit, partial payment, or treasury reconciliation workflow is implemented. Non-exact transfers are rejected and require a separate manual support/refund process.
- A finalized transaction and a configured treasury balance do not independently prove legal ownership or authority. The treasury ownership flag requires separate wallet-native proof and project-owner review.
- A database ledger is not proof of reserves and is not a token custody system.
- The $7 USD presale quote is separate from the planned 1 BALMZ-SOL = 1 SOL launch target; that target is not a guaranteed market price or liquidity mechanism.

## Concurrency tests and operational reconciliation

The API CI job provisions a disposable PostgreSQL 16 service and runs `test_balmz_presale_postgres_concurrency.py` against an isolated schema. It exercises concurrent retries of one intent, replay of one transaction signature across two intents, and concurrent distinct settlements at the tranche cap. The test suite never uses production `DATABASE_URL` and mocks the chain verifier, so it is a database-atomicity test rather than a live Solana RPC test.

Refund and exception handling are operator-controlled procedures documented in [the BALMZ-SOL reconciliation and refund runbook](BALMZ-SOL-REFUND-RECONCILIATION-RUNBOOK.md). There is no automatic refund endpoint or token-delivery operation. Every refund requires a separate, approved outbound transaction and independent finality verification.

## Validation still required before release

Run and review the complete API test suite and PostgreSQL integration tests, production RPC integration tests, security review, legal/customer disclosure review, independent treasury ownership proof, and production deployment verification. The feature must remain disabled until those checks pass and the project owner explicitly approves the release.
