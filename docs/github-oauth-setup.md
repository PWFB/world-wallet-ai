# GitHub OAuth setup for World Wallet AI

The GitHub Integration page is available under **Admin → GitHub Integration**. The API intentionally grants public repository metadata access by default; it does not request the broad `repo` scope for private repositories.

## Required backend environment variables

Configure these on the **backend service only** (Render environment settings), never as `VITE_*` frontend variables:

- `WORLD_WALLET_GITHUB_CLIENT_ID`: GitHub OAuth App client ID.
- `WORLD_WALLET_GITHUB_CLIENT_SECRET`: GitHub OAuth App client secret.
- `WORLD_WALLET_GITHUB_REDIRECT_URI`: exact callback URL, for example `https://YOUR-API-HOST/api/v1/integrations/github/oauth/callback`.
- `WORLD_WALLET_GITHUB_ADMIN_EMAIL`: exact email of the World Wallet AI administrator allowed to connect and manage this integration.
- `WORLD_WALLET_GITHUB_TOKEN_ENCRYPTION_KEY`: Fernet key used to encrypt stored access tokens.
- `WORLD_WALLET_GITHUB_FRONTEND_URL`: deployed frontend origin, without a trailing slash (for example `https://YOUR-FRONTEND-HOST`).

Generate a Fernet key locally in a trusted environment with Python:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Save the output directly as a backend environment secret. Do not commit it, paste it into source code, or send it in chat.

## GitHub OAuth App

Create an OAuth App in GitHub Developer Settings. Set its **Authorization callback URL** to exactly the value configured in `WORLD_WALLET_GITHUB_REDIRECT_URI`. Keep the client secret in backend environment settings.

Default requested scopes: `read:user,public_repo`. This provides the connected GitHub account identity and public repository metadata. Do not add the broad `repo` scope unless private repository access is deliberately approved.

## Behavior and safeguards

- OAuth state is random, expires after 10 minutes, is single-use, and is tied to the initiating admin account.
- Only the configured administrator email can use the integration endpoints.
- The access token is encrypted in PostgreSQL and never returned to the browser or written to application logs.
- Repository metadata is read from GitHub's API, paginated up to 1,000 repositories per refresh.
- Disconnect attempts to revoke the GitHub OAuth grant and deletes the locally stored credential only after successful revocation (or if GitHub says the grant is already absent).
- The integration is not active until all required environment variables are configured and a GitHub OAuth authorization completes successfully.


## Google Gemini integration

The **Admin → Gemini Integration** page checks the backend configuration and makes a real, minimal Gemini API request from the backend.

Set these environment variables on the **World Wallet AI backend service only** in Render:

- `GEMINI_API_KEY`: your Google Gemini API key, stored as a secret.
- `WORLD_WALLET_GEMINI_ADMIN_EMAIL`: the exact administrator email allowed to check and test Gemini. If omitted, the backend uses `WORLD_WALLET_GITHUB_ADMIN_EMAIL`.
- `WORLD_WALLET_GEMINI_MODEL` (optional): model name; defaults to `gemini-2.5-flash`.

Never add the key to frontend variables, source code, logs, or chat. After saving the Render variables, redeploy/restart the backend, sign in with the configured administrator account, open **Admin → Gemini Integration**, and select **Test Gemini connection**. The page reports a successful live request or a safe error message. A configured key alone does not prove the API works.


## Live wallet transaction history (Alchemy Ethereum Mainnet)

To enable Ethereum transaction syncing, configure the World Wallet AI backend service in Render with either:

- `ALCHEMY_API_KEY`: your Alchemy API key, stored as a backend secret. If `WORLD_WALLET_ETH_RPC_URL` is not set, the API constructs the Ethereum Mainnet RPC endpoint from this key.
- `WORLD_WALLET_ETH_RPC_URL` (optional alternative): the full Ethereum Mainnet RPC URL from your provider. This takes precedence over `ALCHEMY_API_KEY`.

Then sign in to World Wallet AI, open **Wallets**, and add the public Ethereum address to the active wallet. A public address is required to discover transactions; a wallet private key or seed phrase is not required for read-only history. The current sync scans a limited recent block window for native ETH transfers and registered token contracts, so it is not a full historical indexer. Keep provider credentials server-side only; never use a `VITE_` variable or commit the key.
