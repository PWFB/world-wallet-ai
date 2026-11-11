# BALMZ AI roadmap and implementation status

## Implemented in the current application

- BALMZ AI dashboard with token-market scanning and pair-level metrics.
- Gemini-backed assistant endpoint with backend-only API credentials.
- Explicit wallet-context opt-in and allow-listed verified balance context.
- Wallet-scoped free mining clock and pending-reward receipts.
- Local encrypted-vault personal-message signing and EOA signature verification.
- Local encrypted-vault EIP-712 typed-data signing and EOA recovery verification.
- Read-only EIP-1271 smart-wallet signature verification that checks chain ID, account code/delegation presence, and the required magic return value.
- In-app WalletCore native ETH/BNB and standard ERC-20 transfers from the existing EIP-7702 account when the encrypted local vault is unlocked with the exact same owner key; exact delegation code, preflight simulation/gas checks, explicit confirmation, local signing, and receipt/Transfer-event validation are required.
- Production Neon Auth Google provider registration.
- Email/password and email OTP routes, email verification, and one-time password-reset flow.
- Admin Gmail SMTP delivery for Super Admin PIN-recovery approvals.
- Read-only Solana Mainnet presale readiness check that compares the observed mint supply against the approved 10-billion Solana allocation.

## Confirmed policy

- Global BALMZ Mainnet maximum: 31,000,000,000.
- Solana Mainnet allocation: 10,000,000,000.
- Initial Solana presale tranche: 1,000,000,000, included within the Solana allocation.
- Remaining Solana allocation after the initial tranche: 9,000,000,000.
- Solana Devnet and Sepolia allocations are test-only and excluded from Mainnet totals.
- Presale payment acceptance, mining claims and withdrawals remain disabled until their respective controls are implemented and independently verified.

## Release blockers and next engineering work

1. **Live WalletCore validation:** Test the in-app read-only EIP-1271 verifier and a harmless transaction simulation against the user's live 0xbb account, once its owner key has been imported locally into the encrypted World Wallet AI vault. Confirm the exact deployed delegation designator, validator configuration, nonce and gas behavior. Never transmit the key to the backend or assume a different local key can sign for 0xbb.
2. **Transaction signing:** Add a typed, chain-aware transaction review/simulation, nonce and expiry controls, allowance/recipient checks, and clear explicit confirmation. No automatic signing or broadcast.
3. **Mining liability cap:** Add a global reward-pool allocation/cap with concurrency-safe accounting and a funded distribution/claim design before enabling claim or withdrawal controls.
4. **Presale settlement:** Build finalized Solana payment verification, recipient and amount checks, idempotency/replay protection, order allocation, failure/underpayment handling, refund reconciliation, and tests. Keep payment acceptance disabled until this is complete.
5. **Gmail customer sender:** A Termux helper now securely configures Neon Auth's standard SMTP provider with Gmail SMTP (`smtp.gmail.com:465`) using hidden prompts for the Neon API key and Google App Password. The user must run it locally, then send a test email and verify sign-up, OTP, and password-reset delivery. The connected app cannot safely supply the user's Gmail App Password. Until this happens, Neon Auth's shared sender remains active. The separate backend Gmail SMTP path sends only Super Admin PIN-recovery email.
6. **Production auth test:** Complete an interactive Google OAuth sign-in, email verification, password sign-in, password reset, session revocation and PIN-gate regression on the deployed frontend. Provider configuration alone is not an end-to-end pass.
7. **Independent verification:** Run backend focused tests, wallet signature tests, frontend build, wallet safety tests, contract tests and deployment checks on the feature branch. Review CI results before merge and obtain explicit release approval before production deployment.

## Status language

A feature being present in source code is not proof that production credentials, external providers, network availability or the live user journey have passed. Report those separately as configured, code-present, tested, blocked or unverified.
