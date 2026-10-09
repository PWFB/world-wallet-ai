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

## Google sign-in

The web app starts Google OAuth through Neon Auth (`authClient.signIn.social({ provider: "google" })`). Enable the Google provider in the Neon Auth configuration used by this deployment and register the exact callback/redirect URI shown by Neon Auth. The frontend's `VITE_NEON_AUTH_URL` must point to that same Neon Auth instance. OAuth client secrets belong only in the provider configuration, never in GitHub or frontend environment variables.

The legacy backend `GOOGLE_CLIENT_ID` setting is used only by the separate `/api/v1/auth/google` credential-verification endpoint; it does not replace configuring the Neon Auth Google provider.

## Sepolia wallet

Sepolia uses the same EVM public address as Ethereum for a given wallet. The API exposes a separate `sepolia` address record and network status when a valid EVM address is configured. Set `WORLD_WALLET_EVM_ADDRESS` to the user's public address and `WORLD_WALLET_SEPOLIA_RPC_URL` to a Sepolia RPC endpoint. Do not invent an address or put private keys in the API.

## Development

Use real chain responses for balances and transaction status. Never fabricate token balances, settlement confirmations, or market prices.
