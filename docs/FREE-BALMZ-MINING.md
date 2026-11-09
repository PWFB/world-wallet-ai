# Free BALMZ Mining Sessions

## Current release scope

The Token Mining page records free participation sessions for the authenticated user's active World Wallet. There is no USDT deposit, purchase, activation fee, or paid mining tier.

API:
- `GET /api/v1/mining/balmz` — session history and status.
- `POST /api/v1/mining/balmz/start` — start one active session per wallet.
- `POST /api/v1/mining/balmz/stop` — complete the active session.

Sessions are account-scoped in PostgreSQL. A partial unique index prevents more than one active session for a wallet. The backend does not accept a caller-supplied wallet ID, reward amount, token mint, or destination.

## Reward rules and pending allocation ledger

- Rate: **0.5 BALMZ for each completed three-hour cycle**.
- Daily cap: **4 BALMZ per wallet per UTC calendar day** (8 cycles).
- Each cycle is identified by wallet, session, and cycle number. A database uniqueness constraint and wallet-row lock make recording idempotent under concurrent requests.
- The server calculates eligibility from persisted session timestamps; the browser countdown is informational only.
- `POST /api/v1/mining/balmz/record` records eligible cycles in an internal pending ledger. It does not mint, transfer, or create an on-chain balance.
- `GET /api/v1/mining/balmz` returns pending allocation totals and recent ledger entries. Pending entries are not spendable or withdrawable.
- Each cycle counts against the UTC date on which its three-hour checkpoint completes. Stopped sessions accrue only through their saved end time.

## Three-hour wallet clock

The frontend derives three-hour checkpoints from the server-persisted `active_session.started_at` timestamp. The start timestamp therefore survives refreshes and sign-ins, and each wallet's clock is independent. The UI displays elapsed three-hour checkpoints and the next checkpoint time. It does not reset the clock on refresh.

The server records completed checkpoints as pending internal allocations at the rates above. The frontend's elapsed-checkpoint display is informational; only the server endpoint determines ledger entries. Recording is not an on-chain claim.

## Reward and token safety

This release is a participation tracker with an internal pending-allocation ledger, not proof-of-work. It does not mine, mint, transfer, or credit on-chain BALMZ. The API keeps `claim_enabled=false` and `withdrawal_enabled=false`; pending allocations are not spendable.

Do not describe session duration or elapsed checkpoints as token earnings or show them as spendable/claimable balance. Mainnet, Sepolia, and Solana Devnet remain distinct. The existing 1-billion BALMZ Solana Devnet target is not a Mainnet reward pool.

## Requirements before real rewards can be enabled

1. Verify the canonical Mainnet BALMZ mint/contract and live total supply on-chain.
2. Identify and verify an issuer-controlled, funded reward allocation within the fixed 1-billion supply cap.
3. Publish deterministic eligibility, rate, cap, expiry, anti-abuse, and accounting rules.
4. Independently review the server-side three-hour cycle accounting, unique ledger keys, daily UTC cap, concurrency controls, and immutable audit requirements before launch.
5. Verify wallet ownership and use a replay-protected claim contract/program or controlled treasury payout.
6. Add tests for concurrent sessions, duplicate claims, allocation exhaustion, network separation, and withdrawal failures.
7. Have the implementation independently reviewed before enabling claims or deploying.

No migration, deployment, on-chain transaction, mint, or withdrawal is performed by this feature branch.
