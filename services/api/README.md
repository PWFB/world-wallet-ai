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

## Sepolia wallet

Sepolia uses the same EVM public address as Ethereum for a given wallet. The API exposes a separate `sepolia` address record and network status when a valid EVM address is configured. Set `WORLD_WALLET_EVM_ADDRESS` to the user's public address and `WORLD_WALLET_SEPOLIA_RPC_URL` to a Sepolia RPC endpoint. Do not invent an address or put private keys in the API.

## Development

Use real chain responses for balances and transaction status. Never fabricate token balances, settlement confirmations, or market prices.


## BALMZ APT BankConnect (US read-only account access)

BankConnect uses the official Plaid API and Plaid Link Android SDK. The bank/customer completes authentication and any bank-required MFA/OTP inside the provider's secure Link flow. World Wallet AI never receives or stores bank login credentials or bank-issued OTPs.

Backend-only Render environment variables:

- `PLAID_CLIENT_ID` — Plaid client ID.
- `PLAID_SECRET` — Plaid secret for the selected environment.
- `PLAID_ENV` — `sandbox`, `development`, or `production`; defaults to `sandbox`.
- `WORLD_WALLET_SECRET_ENCRYPTION_KEY` — existing server-side encryption key used to encrypt Plaid access tokens at rest and protect the BALMZ OTP hash.
- `BANKCONNECT_SMTP_HOST` — SMTP server; defaults to `smtp.gmail.com`.
- `BANKCONNECT_SMTP_PORT` — SMTP port; defaults to `465` (SSL). Port `587` uses STARTTLS.
- `BANKCONNECT_SMTP_USERNAME` — dedicated sender Gmail address.
- `BANKCONNECT_SMTP_APP_PASSWORD` — dedicated Google App Password for that sender (not the normal Gmail password).
- `BANKCONNECT_SMTP_FROM_EMAIL` — verified sender address; defaults to the SMTP username.
- `BANKCONNECT_SMTP_FROM_NAME` — optional sender label; defaults to `BALMZ AI APT`.

Do not reuse `WORLD_WALLET_ADMIN_GMAIL_APP_PASSWORD`: that existing credential remains restricted to Super Admin recovery. Do not add Plaid or SMTP credentials to Android build configuration, frontend variables, Git, or chat. BankConnect creates Link tokens on the backend, exchanges one-time public tokens on the backend, encrypts long-lived access tokens with AES-GCM, scopes records to the authenticated user's active wallet, and exposes only sanitized account and transaction data. Disconnect calls Plaid `/item/remove` before deleting the stored connection.

Endpoints (all require the authenticated wallet-PIN session):

- `GET /api/v1/bankconnect/status`
- `GET /api/v1/bankconnect/email/settings`
- `POST /api/v1/bankconnect/email/request-code` — sends a BALMZ-generated 6-digit code to the user-selected code-delivery email; 10-minute expiry, one use, maximum 5 attempts and 5 sends per 15 minutes.
- `POST /api/v1/bankconnect/email/verify-code`
- `POST /api/v1/bankconnect/link-token`
- `POST /api/v1/bankconnect/exchange`
- `GET /api/v1/bankconnect/accounts`
- `GET /api/v1/bankconnect/transactions` (last 30 days)
- `DELETE /api/v1/bankconnect/connections/{connection_id}`

BankConnect displays the owner Gmail from the signed-in, email-verified BALMZ AI APT identity as a read-only field. The user supplies a separate or same Gmail to receive BALMZ's own email-verification code. The backend rejects an owner Gmail that does not match the signed-in account email. The code confirms the BALMZ notification destination only; it is not a bank-issued OTP, cannot be forwarded to a bank's registered contact, and does not prove bank-account ownership. The bank and Plaid Link independently authenticate the account holder and decide where bank MFA is delivered. Changing the code-delivery email clears the previous BALMZ email verification and requires a fresh code. This extra email check must be configured with the dedicated `BANKCONNECT_SMTP_*` variables above.

The Android package `com.balmz.aptido` must be registered in Plaid Dashboard under Build → API → Allowed Android package names. Register `com.balmz.aptido.debug` separately only if testing the debug build with real Plaid Link sessions.

Start with Plaid Sandbox and test institutions. Live access to Chase and other real US banks requires a Plaid account with approved production access and the relevant product permissions; a successful APK build does not prove those external approvals. This release is read-only: it does not initiate transfers, payments, withdrawals, or account changes. Account balances may be delayed according to provider/bank refresh behavior.
