# FastAPI Backend

Main API service for World Wallet AI.

## Setup

```bash
cd services/api
pip install -r requirements.txt
python main.py
```

## Live CoinGecko market prices

The public `GET /api/v1/prices/market` endpoint supplies USD prices and 24-hour changes for BTC, ETH, USDT, BNB, USDC, SOL, XRP, ADA, LTC and DOGE. BALMZ and BALMZ-SEP deliberately return an unavailable/unlisted price until a verifiable market quote exists.

Configure these variables in the backend deployment environment (for example, Render), not in the browser:

- `COINGECKO_API_KEY`: optional CoinGecko Demo or Pro API key. Keep it private.
- `COINGECKO_API_BASE_URL`: optional; defaults to `https://api.coingecko.com/api/v3`. For a Pro key, use `https://pro-api.coingecko.com/api/v3`.

The backend sends the Demo or Pro key in the appropriate request header. The frontend calls the World Wallet API, so the API key is never bundled into the web app.

## Google, Gmail, email and password authentication

World Wallet AI uses Neon Auth (Better Auth) for customer account authentication. The production branch has the Google OAuth provider registered, email/password sign-in enabled, and the frontend starts Google OAuth with `authClient.signIn.social({ provider: "google" })`.

Production auth settings currently use:
- Email/password sign-in and new sign-ups enabled.
- Email verification required, with OTP verification.
- Verification emails enabled at sign-up and for unverified sign-ins.
- Automatic sign-in after successful email verification.
- Sessions revoked after a successful password reset.
- Google OAuth provider registered in Neon Auth; its client secret remains in provider configuration and is never committed to this repository.

The frontend `VITE_NEON_AUTH_URL` must point to the same Neon Auth base URL as the backend's `NEON_AUTH_BASE_URL`. For the currently linked production Neon Auth branch, the base URL is the one returned by Neon Auth configuration for the `World wallet Ai` project. Keep the Render frontend and backend pointed to that same Auth branch. The registered production trusted origin is `https://world-wallet-ai-frontend.onrender.com`. Keep the exact OAuth callback URL registered with Google/Neon Auth; do not add wildcard redirects.

The password lifecycle is handled by Neon Auth:
- Sign-up requires a verified email and the app's configured registration checks.
- Email OTP sign-in sends a one-time code through the configured Neon Auth mail provider.
- Password sign-in posts credentials to the backend Neon Auth relay; plaintext passwords are forwarded only to the Auth provider over TLS and are not stored in World Wallet AI application tables.
- Forgot-password requests use Neon Auth's one-time reset flow. The API returns a generic response to avoid exposing whether an email has an account.
- Password reset requires the email-issued token and a new password of at least eight characters. Neon Auth revokes the user's sessions after reset; the app then requires sign-in and the World Wallet AI security PIN gate again.

### Gmail delivery boundary

The current Neon Auth email provider is the shared Neon sender (`auth@mail.myneon.app`, provider sender name **Neon Auth**). The Neon Auth application name has been set to **World Wallet AI**, but the shared provider still reports its sender name as Neon Auth. This provider sends account verification, OTP and password-reset mail. It is not a Gmail sender.

The backend separately uses Gmail SMTP over TLS for Super Admin PIN-recovery approval messages. Configure these values only in the backend service environment:
- `WORLD_WALLET_ADMIN_EMAIL` — the administrator Gmail mailbox.
- `WORLD_WALLET_ADMIN_GMAIL_APP_PASSWORD` — a Google App Password for that mailbox (not the user's normal Google password).

That backend SMTP channel remains restricted to Super Admin PIN recovery. It is separate from customer auth email delivery.

### Configure Gmail for customer verification and password-reset mail

Neon Auth supports a custom standard SMTP provider. The repository includes `tools/configure_neon_auth_gmail_smtp.py` for Termux/Android. It prompts for the Neon API key and a Gmail App Password using hidden input, then sends the SMTP configuration directly to the Neon Management API. The script does not write credentials into Git, a .env file, or its output.

Run it from a checked-out repository:

```sh
python tools/configure_neon_auth_gmail_smtp.py
```

Use a Google App Password created for the sender Gmail account with 2-Step Verification enabled; never use the account's normal password. The intended SMTP settings are `smtp.gmail.com:465` (SSL), sender username and sender address equal to the Gmail mailbox, sender name **World Wallet AI**. The script targets the production Neon Auth project/branch already connected to World Wallet AI.

After the script reports success, send a test to a mailbox you control:

```sh
neon neon-auth config email-provider test --project-id hidden-recipe-66704507 --branch br-shy-butterfly-b4858jqu --recipient-email YOUR_TEST_MAILBOX
```

Do not enable a real customer rollout until that test arrives and you verify sign-up email OTP, unverified sign-in verification, and password-reset delivery. Neon Auth's saved SMTP secret is write-only and is not returned by read-only configuration queries.

Google OAuth secrets belong only in Neon Auth provider configuration. Never store a Google account password in World Wallet AI or ask users for it; the user signs in through Google's OAuth consent flow.

## Secret Room wallet unlock — verified receiver Gmail

The Wallets page requires a separate email factor before unlocking a saved local wallet:

1. The user signs in through the existing World Wallet AI account login and completes the existing wallet security PIN gate. The Secret Room never asks for a Google account password or resubmits the account password.
2. The user registers a separate Gmail receiver address and verifies it with a server-generated six-digit code.
3. Before each local wallet unlock, the backend sends a fresh code only to that already-verified receiver Gmail. The user enters this code and the local vault password.
4. The backend issues a five-minute, single-use authorization. The browser consumes it before decrypting the local encrypted wallet. The vault password, private key and recovery phrase are never uploaded.

A verified receiver address cannot be changed from the normal login or wallet-unlock screen. Replacing it requires a separately authenticated account-recovery procedure; this endpoint intentionally does not provide a self-service change operation. Codes are hashed with the existing `WORLD_WALLET_SECRET_ENCRYPTION_KEY`, expire after five minutes, allow at most five incorrect attempts, and are rate-limited to three requests per purpose per 15 minutes. No code is returned to the frontend or written to logs.

The backend reuses the dedicated sender configuration already used for BankConnect email delivery:

- `BANKCONNECT_SMTP_HOST` (defaults to `smtp.gmail.com`)
- `BANKCONNECT_SMTP_PORT` (defaults to `465`)
- `BANKCONNECT_SMTP_USERNAME`
- `BANKCONNECT_SMTP_APP_PASSWORD`
- `BANKCONNECT_SMTP_FROM_EMAIL`
- `BANKCONNECT_SMTP_FROM_NAME` (optional)

Do not use a customer's Gmail password as SMTP credentials. Use a server-side Gmail App Password for the sender mailbox. Secret Room routes require a `wwpin_` wallet-PIN session; service credentials and API keys cannot enroll a receiver or request an unlock grant.

Routes:

- `GET /api/v1/vault-security/email/status`
- `POST /api/v1/vault-security/email/enroll`
- `POST /api/v1/vault-security/email/verify`
- `POST /api/v1/vault-security/access/request`
- `POST /api/v1/vault-security/access/verify`
- `POST /api/v1/vault-security/access/consume`

This is an app-level step-up gate. Local self-custody means a person with full control of the browser and its encrypted backup can still decrypt their own data outside the application; this feature does not make a compromised device safe. After a wallet is unlocked in the browser, existing local session controls apply until it is locked or the page session ends.

## Sepolia wallet

Sepolia uses the same EVM public address as Ethereum for a given wallet. The API exposes a separate `sepolia` address record and network status when a valid EVM address is configured. Set `WORLD_WALLET_EVM_ADDRESS` to the user's public address and `WORLD_WALLET_SEPOLIA_RPC_URL` to a Sepolia RPC endpoint. Do not invent an address or put private keys in the API.

## Development

Use real chain responses for balances and transaction status. Never fabricate token balances, settlement confirmations, or market prices.


## BALMZ APT private Bank & Crypto services

The APT's **More → Open private services** screen keeps crypto purchases and US bank payouts separate from the self-custody wallet navigation.

### Coinbase Onramp — crypto purchase

Endpoints (wallet-PIN authenticated):

- `GET /api/v1/bankconnect/crypto/status` — reports whether Coinbase Onramp is configured and enabled without exposing credentials.
- `POST /api/v1/bankconnect/crypto/buy-session` — validates the requested asset/network, validates that the destination address belongs to the authenticated user's active wallet and has `ownership_verified=TRUE`, then creates a short-lived, single-use Coinbase Onramp session and returns a Coinbase-hosted checkout URL.

Current asset/network pairs:

- BTC → Bitcoin Mainnet (`bitcoin`)
- ETH → Ethereum Mainnet (`ethereum`)
- USDC → Ethereum Mainnet (`ethereum`)
- SOL → Solana Mainnet (`solana` on Coinbase)

The backend creates a per-request ES256 CDP JWT and calls `POST https://api.developer.coinbase.com/onramp/v1/token`. The JWT, API key name and EC private-key secret are never returned to the client or logged. The returned session token is single-use and is only passed to the Coinbase-hosted checkout URL.

Render environment variables (backend only):

- `COINBASE_CDP_API_KEY_NAME` — CDP API key name/ID.
- `COINBASE_CDP_API_KEY_SECRET` — CDP EC private-key PEM.
- `COINBASE_ONRAMP_ENV` — `sandbox` or `production`; defaults to `sandbox`.
- `COINBASE_ONRAMP_ENABLED` — defaults to `false`; must be explicitly enabled after CDP access and credentials have been verified.

Coinbase controls available payment methods, region checks, user KYC and payment settlement. Users who want to pay with a US bank account must use an eligible payment method offered in their Coinbase checkout/account; BALMZ does not collect bank login credentials or bank-issued OTPs. The backend does not record checkout opening as a purchase confirmation.

### Nium — US bank payout readiness

- `GET /api/v1/bankconnect/transfers/status` — explicitly reports the US payout feature as disabled and provides the provider-onboarding reason.
- Real payouts are not initiated by this release.

Nium's hosted payout form requires a provider-onboarded customer, approved beneficiary management, a funded Nium wallet and a server-issued PKCE authorization code. US payouts from a Nium non-US entity are processed as International ACH Transactions (IAT). The exact BALMZ entity, customer type, source-of-funds flow, funding instruments and P2P/B2P use case require written Nium approval before implementing or enabling payout initiation.

Do not collect bank passwords, bank OTPs or unverified account details in BALMZ. Do not enable a transfer action based only on API credentials; provider permission, KYC/KYB, verified beneficiaries, funded balance, idempotency, webhooks/status polling and ACH return/reversal handling are required.

### Plaid — legacy read-only BankConnect

The existing FastAPI backend retains wallet-scoped Plaid Link and account-history routes for compatibility with previously linked bank accounts. Plaid is **read-only** in this integration: it does not initiate bank transfers or fund crypto purchases.

Configure these values only on the World Wallet AI backend service in Render:

- `PLAID_CLIENT_ID` — Plaid team Client ID.
- `PLAID_SECRET` — the secret copied from the same Plaid environment as the Client ID.
- `PLAID_ENV` — `sandbox` or `production`; defaults to `sandbox`.
- `WORLD_WALLET_SECRET_ENCRYPTION_KEY` — existing backend encryption key used to encrypt saved Plaid access tokens.
- `WORLD_WALLET_ADMIN_EMAIL` — existing configured administrator email allowed to run the credential check.

The administrator-only `POST /api/v1/bankconnect/admin/test-credentials` endpoint calls Plaid `/institutions/get` with the configured environment and product filter. It does not create an Item, link a customer's bank, or return credentials. A credential rejection means the Client ID and Secret must be checked against the same environment in the Plaid Dashboard. The response includes the configured environment and Plaid request ID for support.

Existing user-authenticated routes:

- `POST /api/v1/bankconnect/link-token` — creates a short-lived Plaid Link token after the BALMZ email verification gate.
- `POST /api/v1/bankconnect/exchange` — exchanges a public token and stores the resulting access token encrypted in PostgreSQL.
- `GET /api/v1/bankconnect/accounts` and `GET /api/v1/bankconnect/transactions` — retrieve read-only account and transaction data for the signed-in user's active wallet.
- `DELETE /api/v1/bankconnect/connections/{connection_id}` — removes that user's bank connection.

The Android APT no longer ships Plaid Link or calls these legacy routes for its current Private Services flows. The web frontend also does not currently expose a Plaid Link screen. These routes are not part of crypto purchase or US bank payout processing. Never collect bank login credentials or bank-issued OTPs in BALMZ.
