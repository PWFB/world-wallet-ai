# Free BALMZ Mining Sessions

## Current release scope

The Token Mining page now records free participation sessions for the authenticated user's active World Wallet. There is no USDT deposit, purchase, activation fee, or paid mining tier.

API:
- `GET /api/v1/mining/balmz` — session history and status.
- `POST /api/v1/mining/balmz/start` — start one active session per wallet.
- `POST /api/v1/mining/balmz/stop` — complete the active session.

Sessions are account-scoped in PostgreSQL. A partial unique index prevents more than one active session for a wallet. The backend does not accept a caller-supplied wallet ID, reward amount, token mint, or destination.

## Reward and token safety

This release is a participation-session tracker, not proof-of-work. It does not mine, mint, transfer, or credit BALMZ. The API explicitly returns `claim_enabled=false`, `reward_amount=null`, and `disabled_pending_verified_funded_allocation`.

Do not describe session duration as token earnings or show it as a spendable balance. Mainnet, Sepolia, and Solana Devnet remain distinct. The existing 1-billion BALMZ Solana Devnet target is not a Mainnet reward pool.

## Requirements before real rewards can be enabled

1. Verify the canonical Mainnet BALMZ mint/contract and live total supply on-chain.
2. Identify and verify an issuer-controlled, funded reward allocation within the fixed 1-billion supply cap.
3. Publish deterministic eligibility, rate, cap, expiry, anti-abuse, and accounting rules.
4. Implement an auditable reward ledger with unique idempotency keys and immutable issuance/claim records.
5. Verify wallet ownership and use a replay-protected claim contract/program or controlled treasury payout.
6. Add tests for concurrent sessions, duplicate claims, allocation exhaustion, network separation, and withdrawal failures.
7. Have the implementation independently reviewed before enabling claims or deploying.

No migration, deployment, on-chain transaction, mint, or withdrawal is performed by this feature branch.
