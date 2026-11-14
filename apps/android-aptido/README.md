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
| Phone OTP request | `POST /api/v1/auth/phone/send-otp` |
| Registration | `POST /api/v1/auth/neon/register` |
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
