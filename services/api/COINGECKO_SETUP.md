# CoinGecko market prices (backend only)

World Wallet AI's public market quote endpoint is `GET /api/v1/prices/market`. It requests USD prices and 24-hour percentage changes from CoinGecko and returns a normalized coin catalog. BALMZ prices intentionally remain unavailable until a verified market listing exists.

## Backend environment

Configure these variables on the **World Wallet AI API/backend service only**:

- `COINGECKO_API_BASE_URL=https://api.coingecko.com/api/v3` for CoinGecko Demo API.
- `COINGECKO_API_KEY=<your Demo API key>` for the Demo API key.

For CoinGecko Pro, use:

- `COINGECKO_API_BASE_URL=https://pro-api.coingecko.com/api/v3`
- `COINGECKO_API_KEY=<your Pro API key>`

The backend chooses the appropriate `x-cg-demo-api-key` or `x-cg-pro-api-key` request header from the configured host. The key is not returned by the market endpoint and must never be placed in a `VITE_*` frontend variable, committed to Git, or embedded in browser JavaScript.

The market endpoint caches successful quotes in-process for 45 seconds to reduce duplicate upstream requests. If CoinGecko is temporarily unavailable, it can return the last successful quote set with `stale: true` and the original `updated_at`; the UI should treat that timestamp as the quote time, not the current time. If no successful quote has been cached yet, the endpoint returns HTTP 503.

If the key is missing or rejected, inspect backend logs and CoinGecko plan/rate limits. Do not print the key in logs. This repository change does not alter hosted environment variables or deploy any service.

## Read-only address tracking

The Wallets screen offers an explicit **Use existing World Wallet AI address** shortcut. It fills the Ethereum address and a descriptive label in the form. Review the selected wallet profile, then press **Connect address** to save it to that profile. This uses the existing owner-checked address API and public on-chain reads; it does not import a private key, sign transactions, or change the separate Binance Web3 Wallet connection.

The address is not automatically attached to every user's profile. Do not add it as a global fallback or as `WORLD_WALLET_EVM_ADDRESS`; those settings must not be used to cross-propagate wallet addresses between accounts.
