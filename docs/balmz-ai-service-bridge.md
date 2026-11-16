# BALMZ AI standalone service bridge

The BALMZ AI web application and BALMZ AI APT use the standalone BALMZ AI service for chat through the existing World Wallet AI backend. The APT does not call the standalone service directly and does not receive a Better Auth cookie, provider key, or integration secret.

## Request path

1. The signed-in APT or World Wallet AI web client sends its question to `POST /api/v1/balmz-ai/ask` using its existing wallet-PIN session.
2. The World Wallet AI backend authenticates that session and creates a short-lived HS256 assertion containing the World Wallet AI user ID and verified account email.
3. The backend requests the standalone model catalogue, selects the first tested model, and sends the user turn to `POST /api/ai/chat`.
4. BALMZ AI verifies the service assertion, resolves the email to an existing email-verified Better Auth account, and applies that account's subscription, provider connections and `ai_messages` allowance.
5. The standalone chat route stores the turn in its existing owner-scoped conversation history and returns the assistant response through the World Wallet AI backend.

A deterministic conversation ID is derived from the World Wallet AI account subject, so the APT and World Wallet AI web chat use the same connected BALMZ AI conversation for that account. Every new user turn and request receives a fresh message/request ID.

## Render configuration

On the **BALMZ AI** Render service (`balmz-ai`), configure:

- `WORLD_WALLET_AI_INTEGRATION_SECRET` — a random secret of at least 32 characters.

On the **World Wallet AI backend** Render service, configure:

- `BALMZ_AI_SERVICE_URL=https://balmz-ai.onrender.com`
- `WORLD_WALLET_AI_INTEGRATION_SECRET` — the exact same secret value used by the BALMZ AI service.

Generate one random 64-character-or-longer value in a trusted password manager or secret generator and save it directly in both Render services. Never commit it, expose it as a frontend variable, place it in Android build configuration, or paste it into chat. Adding or rotating the secret requires both services to restart with the matching value.

## Account-linking rule

The email on the signed-in World Wallet AI account must match an existing, email-verified BALMZ AI account. If the account does not exist, the bridge returns an explicit account-linking error; it does not create a shadow account or bypass Better Auth verification. Sign in to BALMZ AI with the same verified email before retrying.

The standalone BALMZ AI account's subscription and provider allowance remain authoritative. A provider must be connected and tested in BALMZ AI → Super Admin → AI Connections. If no model is available or the account has no remaining `ai_messages` allowance, the API returns a clear error rather than a fabricated response.

## Security and privacy

- APT and World Wallet AI web continue to use their current wallet-PIN session tokens with the World Wallet AI backend.
- The integration assertion is HS256-signed, has an explicit issuer/audience, and expires after 60 seconds.
- The shared secret is only read by the two backend services.
- The bridge does not request or transmit passwords, wallet PINs, recovery phrases, private keys, or bank OTPs.
- Verified wallet amounts are forwarded only when the user opts in. Addresses and transaction hashes are not included.
- Chat usage is metered and conversation storage is scoped to the resolved BALMZ AI account.
- If the bridge is not configured, the World Wallet AI backend retains its existing Gemini compatibility path. If only one of the two bridge variables is set, the backend fails clearly instead of silently switching providers.
