# BALMZ AI APT for Android

<https://github.com/PWFB/world-wallet-ai/releases/latest> — public APK download page (available after the first signed release is published).

Native Android application for public distribution. The app talks to the existing World Wallet AI backend; it does not ship provider credentials or a private administrator token.

## App identity and device target

- Display name: **BALMZ AI APT**
- Android application ID: `com.balmz.aptido`
- Compile SDK: 37 (Android 17 platform 37.0)
- Target SDK: 36
- Minimum SDK: 26
- ABI: `arm64-v8a`
- UI: Kotlin + Jetpack Compose
- Network: HTTPS only
- API base: `https://world-wallet-ai-backend.onrender.com`

The debug build uses application ID `com.balmz.aptido.debug` so it can be installed beside a properly signed public release.

## Features in this first Android implementation

- Email/password sign-in through the existing Neon Auth relay.
- Account registration through the existing phone OTP + Neon Auth endpoint.
- Password-reset request through the backend.
- Six-digit wallet PIN enrollment and verification.
- Wallet dashboard and wallet asset records from the signed-in user's active wallet.
- Explicit live Mainnet balance verification; failed or unavailable reads are not converted into zero.
- BALMZ AI chat through `POST /api/v1/balmz-ai/ask`.
- Optional verified wallet context for AI requests; off by default.
- Per-account chat transcript saved locally on the device using AES-GCM with an Android Keystore key. The current backend records AI audit events but does not expose a cross-device conversation-history API, so transcript sync across devices is not claimed.
- Identity and wallet-PIN session tokens encrypted at rest with Android Keystore.

## Existing backend endpoints used

| Purpose | Endpoint |
|---|---|
| Password sign-in | `POST /api/v1/auth/neon/password` |
| Email/password registration | `POST /api/v1/auth/neon/register` |
| Password-reset request | `POST /api/v1/auth/neon/password/reset/request` |
| PIN status | `GET /api/v1/security/pin/status` |
| PIN enrollment | `POST /api/v1/security/pin/enroll` |
| PIN verification | `POST /api/v1/security/pin/verify` |
| Wallet summary | `GET /api/v1/wallet` |
| Live balance verification | `GET /api/v1/wallet/balance-verification` |
| AI chat | `POST /api/v1/balmz-ai/ask` |
| PIN session lock | `POST /api/v1/security/pin/lock` |

The Android client sends the account identity token only to the PIN setup/status endpoints. Wallet and AI requests use the second-factor wallet-PIN session token. The app never requests a seed phrase, private key, Google password or wallet PIN from the AI assistant.

## Backend prerequisites

The existing Render backend must have its normal production requirements configured:

- Neon Auth base URL and JWKS verification.
- Production PostgreSQL database.
- Gemini API key and an enabled model for BALMZ AI replies.
- Twilio Verify credentials and service SID for new phone-verified registrations.
- Existing wallet PIN configuration and live chain RPC settings for verified balance reads.

A green APK build does not prove these external providers are configured or that a user can complete a live sign-in. Each live provider flow must be checked against the production backend.

## Build locally

Install JDK 17, Android SDK Platform 37.0, Android SDK Build-Tools 37.0.0 and Gradle 9.6.0, then run:

```sh
gradle -p apps/android-aptido :app:assembleDebug
```

The installable debug APK is written to:

```
apps/android-aptido/app/build/outputs/apk/debug/app-debug.apk
```

## CI and public APK distribution

The GitHub Actions workflow `.github/workflows/balmz-ai-apt-android.yml` builds a debug APK and stores it as a short-lived workflow artifact for testing.

A public release is created by pushing a tag such as `apt-v1.0.0`. Public release APKs must be signed with one permanent Android release keystore. Configure these four GitHub repository Actions secrets before tagging a release:

- `APTIDO_KEYSTORE_BASE64` — Base64-encoded permanent JKS/PKCS12 keystore.
- `APTIDO_KEYSTORE_PASSWORD` — keystore password.
- `APTIDO_KEY_ALIAS` — signing key alias.
- `APTIDO_KEY_PASSWORD` — signing key password.

Keep a secure offline backup of the permanent keystore and passwords. Never commit the keystore or passwords to the repository. Losing the signing key prevents the same Android package from receiving normal in-place updates.

After a signed tag build succeeds, the workflow attaches `app-release.apk` to a GitHub Release. The public download page is:

https://github.com/PWFB/world-wallet-ai/releases

The first release must not be advertised as production-ready until the signed APK is installed and tested on a real ARM64 Android 16 device, authentication/PIN flows pass, AI replies work, and the download checksum and install/update path are verified.


## Trust Wallet Core self-custody wallet

The Android client integrates the Trust Wallet Core Android Maven artifact, version **4.9.3**, from the Trust Wallet GitHub Packages repository.

- Creates a 12-word BIP-39 recovery phrase on-device.
- Restores a wallet from a valid 12- or 24-word BIP-39 phrase on-device.
- Derives one Ethereum/BNB EVM mainnet address, plus Bitcoin and Solana mainnet addresses.
- Derives separate Ethereum Sepolia and Solana Devnet accounts using account index 1.
- Encrypts recovery material at rest using AES-GCM and an Android Keystore-held key.
- Requires the user to acknowledge an offline recovery backup before the app attaches public addresses to the backend.
- Sends public addresses only. The mnemonic and private keys are never included in API requests.
- Logout removes authentication/PIN session tokens but deliberately preserves encrypted local wallet recovery material.

### Package access

Builds access Trust Wallet Core through the existing repository Actions secret `TRUST_WALLET_PACKAGES_TOKEN` (GitHub Packages read access). The token is injected into Gradle at build time and is not stored in source files.

For local builds, set `GITHUB_USER` and `TRUST_WALLET_PACKAGES_TOKEN` in the shell environment. Never put the token in source code or chat.

### Security and current scope

The recovery phrase is encrypted at rest on this Android installation. Keep the offline backup: uninstalling the app, clearing app data, losing the device, or losing its Keystore key can make the local encrypted copy unavailable.

Newly attached addresses remain unverified until the backend's cryptographic signature challenge flow is completed. This change does not claim that external WalletConnect sessions or transaction signing/broadcast are complete. Do not use this as a production send/receive wallet until signature ownership verification, transaction preview, signing, broadcast, reconnect behavior and real-device recovery tests have passed.


## Private Bank & Crypto services

The BALMZ APT places **Private Services** under the **More** tab. The section is collapsed by default and is not shown as a main wallet action. WalletConnect and the external Bitcoin wallet-connection flow are not required.

### Buy Bitcoin and supported crypto

- Coinbase Onramp opens a Coinbase-hosted checkout using a short-lived, single-use session token created by the backend.
- Purchases are addressed only to a Bitcoin, Ethereum or Solana Mainnet address attached to the active BALMZ wallet and marked ownership-verified by the backend.
- Current app options: BTC to Bitcoin Mainnet; ETH and USDC to Ethereum Mainnet; SOL to Solana Mainnet.
- The user completes payment, identity checks and any bank-account linking inside Coinbase. Eligible payment methods depend on Coinbase account and regional availability. BALMZ never collects a bank password or bank-issued OTP.
- The backend validates the active wallet owner and verified address before requesting each session token. API credentials and JWTs remain server-side.

Backend-only Render variables:

- `COINBASE_CDP_API_KEY_NAME` — CDP API key name/ID.
- `COINBASE_CDP_API_KEY_SECRET` — CDP EC private-key PEM; keep the full PEM formatting.
- `COINBASE_ONRAMP_ENV` — `sandbox` for testing or `production` for approved live purchases.
- `COINBASE_ONRAMP_ENABLED` — leave `false` until CDP Onramp access and credentials are confirmed; set `true` only after that review.

The app does not show a successful purchase merely because the checkout opened. Coinbase controls checkout, payment authorization and settlement. Refresh the wallet and confirm the chain transaction before treating crypto as received.

### Send USD to another US bank

The same hidden section reserves a separate US bank payout area. It is **not enabled** yet. Nium is the provider candidate for approved US ACH/IAT payouts, but BALMZ must complete provider onboarding and receive written approval for its legal entity, user/customer model, source of funds, KYC/KYB, USD funding wallet and US payout permissions. Users must not enter their bank credentials into BALMZ. No transfer is represented as sent or settled until the provider's confirmed status and return handling are integrated.

Nium's documented hosted payout flow requires an approved Nium customer and funded provider wallet. For clients onboarded with a non-US Nium entity, US payouts are processed as IAT rather than domestic same-day ACH. See the backend `US_BANK_TRANSFERS.md` runbook before requesting production activation.

### No Plaid requirement for these flows

The APT no longer includes Plaid Link or depends on Plaid to open Private Services or create Coinbase crypto-purchase sessions. Existing legacy server-side Plaid endpoints are not used by this APT screen. No Plaid credentials are required for the new crypto-purchase flow.
