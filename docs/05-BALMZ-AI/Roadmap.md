# BALMZ AI roadmap and implementation status

## Implemented in the current application

- BALMZ AI dashboard with token-market scanning and pair-level metrics.
- Gemini-backed assistant endpoint with backend-only API credentials.
- Explicit wallet-context opt-in and allow-listed verified balance context.
- Wallet-scoped free mining clock and pending-reward receipts.
- Local encrypted-vault personal-message signing and EOA signature verification.
- Local encrypted-vault EIP-712 typed-data signing and EOA recovery verification.
- Read-only EIP-1271 smart-wallet signature verification that checks chain ID, account code/delegation presence, and the required magic return value.
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

1. **External smart-wallet signing compatibility:** Test EIP-1271 verification against the existing OKX 0xbb account using a harmless signature the user supplies. Confirm the deployed implementation's signature envelope and hashing rules; do not assume a generic EOA signature is accepted. In-app signing as 0xbb still needs its authorized owner/validator signing route; a local vault signer must never impersonate the external wallet.
2. **Transaction signing:** Add a typed, chain-aware transaction review/simulation, nonce and expiry controls, allowance/recipient checks, and clear explicit confirmation. No automatic signing or broadcast.
3. **Mining liability cap:** Add a global reward-pool allocation/cap with concurrency-safe accounting and a funded distribution/claim design before enabling claim or withdrawal controls.
4. **Presale settlement:** Build finalized Solana payment verification, recipient and amount checks, idempotency/replay protection, order allocation, failure/underpayment handling, refund reconciliation, and tests. Keep payment acceptance disabled until this is complete.
5. **Gmail customer sender:** A Termux helper now securely configures Neon Auth's standard SMTP provider with Gmail SMTP (`smtp.gmail.com:465`) using hidden prompts for the Neon API key and Google App Password. The user must run it locally, then send a test email and verify sign-up, OTP, and password-reset delivery. The connected app cannot safely supply the user's Gmail App Password. Until this happens, Neon Auth's shared sender remains active. The separate backend Gmail SMTP path sends only Super Admin PIN-recovery email.
6. **Production auth test:** Complete an interactive Google OAuth sign-in, email verification, password sign-in, password reset, session revocation and PIN-gate regression on the deployed frontend. Provider configuration alone is not an end-to-end pass.
7. **Independent verification:** Run backend focused tests, wallet signature tests, frontend build, wallet safety tests, contract tests and deployment checks on the feature branch. Review CI results before merge and obtain explicit release approval before production deployment.

## Status language

A feature being present in source code is not proof that production credentials, external providers, network availability or the live user journey have passed. Report those separately as configured, code-present, tested, blocked or unverified.
