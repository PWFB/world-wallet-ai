# BALMZ-SOL Mainnet payment evidence verifier

## Scope

The backend now contains a fail-closed verifier for a native SOL payment to the configured BALMZ-SOL Mainnet treasury. It checks the Solana Mainnet genesis hash, requests the transaction at `finalized` commitment, rejects failed transactions, requires the declared payer to be a transaction signer, and totals only parsed System Program transfers from that payer to the configured treasury. The amount is compared as an exact integer lamport value; no floating-point conversion is used.

The helper is exposed internally as `verify_balmz_presale_mainnet_payment`. It is not a public route and does not create payment intents, accept payments, consume transaction signatures, update wallet balances, or allocate BALMZ tokens.

## Deliberate launch gate

**Presale payment acceptance remains disabled.** This verifier is one component of settlement, not the settlement workflow. Before accepting payments, the backend still needs:

1. Server-created payment intents with a server-derived quote, immutable payer/treasury/amount/expiry, and ownership checks.
2. An atomic PostgreSQL settlement transaction with a unique Mainnet transaction-signature constraint and a unique intent allocation.
3. Idempotent handling of retries, underpayment, overpayment, expired intents, already-used signatures, and database/RPC failures.
4. A token allocation ledger that cannot exceed the 1,000,000,000 BALMZ initial tranche, which is included in the 10,000,000,000 BALMZ Solana allocation.
5. Refund/reconciliation handling, operational monitoring, security review, regression tests, and independent release approval.

A pending or merely confirmed signature is never accepted as payment. A transaction lookup that is unavailable is a service error, not a zero-value payment. The helper never signs or broadcasts transactions.

## Required production checks

Before creating real intents, independently verify the production mint, 9 decimals, exact total supply, mint and freeze authority policy, treasury ownership, Mainnet RPC health, and the approved price/quote mechanism. The approved fixed-supply policy is to revoke freeze authority only after the intended supply is minted and independently verified, with explicit owner approval and finalized transaction evidence.

The existing Devnet mint is test-only and must never be used for Mainnet payment verification.
