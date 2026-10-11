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
