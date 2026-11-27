# BALMZ-SOL token delivery: implementation and release controls

## Status

The backend delivery lifecycle is now implemented as a non-custodial, fail-closed workflow. It is **not enabled in production by default**. It does not create a mint, mint additional tokens, revoke authorities, accept presale payments, or move funds merely by preparing a delivery.

The API never imports a private key, seed phrase, hardware-wallet secret, or HSM credential. It builds an unsigned legacy Solana transaction containing exactly one SPL Token `TransferChecked` instruction. The configured token-account owner/fee-payer wallet must sign that exact message outside the API process. The API verifies the signed transaction against the persisted message digest before broadcasting it once.

## Required backend configuration

These variables belong only on the World Wallet AI backend service. Never expose them in frontend build variables or source control.

- `WORLD_WALLET_BALMZ_SOLANA_MAINNET_MINT`: independently deployed and verified production mint.
- `WORLD_WALLET_BALMZ_SOLANA_DELIVERY_SOURCE_TOKEN_ACCOUNT`: existing initialized SPL Token account holding distributable BALMZ-SOL.
- `WORLD_WALLET_BALMZ_SOLANA_DELIVERY_AUTHORITY`: public key that owns the source token account and pays transaction fees. Its wallet must be available for user-controlled signing.
- `WORLD_WALLET_BALMZ_DELIVERY_MAX_PER_TX_BASE_UNITS`: positive maximum per-transfer integer base units (9 decimals).
- `WORLD_WALLET_BALMZ_DELIVERY_DAILY_LIMIT_BASE_UNITS`: positive rolling 24-hour delivery cap in integer base units.
- `WORLD_WALLET_BALMZ_PRESALE_DELIVERY_ENABLED`: separate delivery release flag; defaults to false.

The five existing presale flags still default to false. Delivery requires all five plus the separate delivery flag. Payment-intent creation and settlement are also held closed until delivery is enabled. No flag is changed by code deployment.

The source token account must be owned by the configured authority, use the verified production mint and classic SPL Token Program, be initialized and unfrozen, and hold at least the allocation amount. The buyer must already have an initialized associated token account for the same mint. This implementation deliberately does not create a destination ATA or spend rent during preview; missing destination accounts fail closed and must be created separately by the buyer.

## Endpoints

1. Buyer: `POST /api/v1/balmz/presale/delivery/prepare` with a settled `allocation_id` and an explicit `recipient_address`. The address must belong to the buyer and have a fresh wallet-ownership proof for the exact Solana Mainnet address.
2. Administrator: `POST /api/v1/admin/balmz/presale/delivery/{delivery_id}/approve`. This requires all six server-side release flags and a live global-supply reconciliation across Ethereum, BNB, Solana, and the Ethereum reserve. Approval is bound to the exact SHA-256 transaction-message digest and expires after two minutes.
3. Administrator wallet: sign the returned unsigned transaction in the wallet that controls the configured source token account. Submit only the resulting signed transaction bytes to `POST /api/v1/admin/balmz/presale/delivery/{delivery_id}/submit`.
4. Buyer or administrator: `GET /api/v1/balmz/presale/delivery/{delivery_id}` to reconcile the submitted signature against finalized transaction metadata.

The signing step happens in the connected wallet application. The backend checks the required fee-payer/authority signature and byte-for-byte equality with the stored unsigned message. It sends the signed transaction once. The API does not automatically retry. A timeout or inconsistent signature is marked `reconciliation_required`; the same signature must be inspected before any new attempt.

## Persisted delivery evidence

The Postgres attempt ledger retains the allocation, owner, explicit recipient, mint, token program, source and destination token accounts, authority, exact integer base units, decimals, finalized observation slots, recent blockhash, last-valid block height, unsigned transaction, message digest, approval actor/time/expiry, signature, final slot, and sanitized failure status.

A partial unique index allows at most one active attempt per allocation. Successful delivery is recorded only after `getTransaction` returns finalized evidence containing the expected signature and exactly one parsed `TransferChecked` instruction with the expected mint, source, destination, authority, base-unit amount, and decimals. A settled database allocation is never reported as on-chain delivery.

## Explicit remaining limitations

- This is a wallet-controlled signing boundary, not a deployed remote KMS/HSM signer service. A separate hardware-backed signer would require separate provisioning and review.
- Frontend wallet-signing UX must be wired to the prepare/approval/submit endpoints before buyers can complete delivery inside the app.
- Buyer destination ATAs must exist before preparation. No rent funding or account creation is included.
- Production source account, authority address, mint address, and limits are not supplied by this code change. They require owner-verified backend configuration.
- The global supply endpoint remains read-only and still needs actual Ethereum/BNB contract addresses, the Solana Mainnet mint, and the Ethereum reserve vesting configuration.
- No independent third-party audit or legal/customer disclosure review is represented by CI success.

## Prohibited until separately approved

Do not enable any presale or delivery flag, mint tokens, change mint/freeze authorities, move treasury funds, or activate payment acceptance merely because this code is merged. All live actions require independent on-chain evidence, owner review, and the applicable wallet signature.
