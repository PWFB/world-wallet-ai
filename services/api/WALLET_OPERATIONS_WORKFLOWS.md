# World Wallet AI wallet operations workflows

This backend integration adapts useful PWFB Microfinance patterns without importing its NGN ledger or staff/customer financial model.

## Existing controls retained

- Each wallet remains owned by its authenticated World Wallet user.
- The 11-digit `wallet_number` remains the public wallet identifier; internal wallet IDs and auth user IDs are not rewritten.
- Address attachment remains network-scoped and ownership proof is still required where the current wallet rules require it.
- Transfers and withdrawals remain idempotent and reserve funds before external-wallet signing.
- Settlement remains read-only with respect to broadcasting: the API verifies a supplied transaction hash against the selected chain and never signs or broadcasts it.
- Mainnet, testnet, and devnet records remain segregated by the network field and chain-specific sources.

## Added workflow controls

- Every transaction row receives a stable `WWTX-...` reference, including transactions imported by chain synchronizers. Existing rows are backfilled during the backend's existing additive startup schema initialization.
- Initial wallet provisioning, legacy wallet repair, and later wallet actions create privacy-filtered `wallet_audit_events` in the same database transaction as the action they describe.
- `GET /api/v1/wallet/audit` returns the authenticated user's active-wallet audit trail.
- `GET /api/v1/admin/wallet-audit` is restricted to the configured World Wallet administrator.
- `GET /api/v1/wallet/reconciliation` performs read-only internal controls: reserved amount versus pending request amounts, confirmed/settled records missing chain hashes, transaction status counts, and chain-sync cursor timestamps.

## Reconciliation boundary

The reconciliation endpoint does not re-query RPC providers and does not claim current blockchain finality. It reports internal record consistency and last indexed cursor information only. The balance synchronizer and settlement verifier remain the authoritative chain-reading paths.

## Deployment and database boundary

During branch preparation, no manual Neon migration or SQL write, signing request, or blockchain transaction was executed. PR #228 was subsequently merged into `main` and the merged commit was deployed to both the Render backend and frontend on 9 November 2026.

The backend includes idempotent startup schema initialization for the transaction-reference column and wallet audit table. Render confirmed that the deployed backend application completed startup. This deployment record does not substitute for direct production database inspection or authenticated end-to-end user-flow testing; those checks must be recorded separately.

The settlement and reconciliation boundaries above remain in force after deployment. A successful application deployment does not prove that a wallet has funds, that a transaction has reached chain finality, or that an external wallet has signed or broadcast anything.
