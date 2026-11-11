# TON Connect integration

## Supported wallet flow

- The React app mounts `TonConnectUIProvider` and serves `/tonconnect-manifest.json` from the frontend origin.
- Wallet discovery and connection are delegated to TON Connect. This supports wallets that are present in the TON Connect wallet registry, including Tonkeeper, Wallet in Telegram modes that expose TON Connect, and other compatible wallets.
- Connecting or switching TON wallets saves another address against the currently selected World Wallet AI wallet. A previously attached address is not replaced.
- TON Connect chain IDs are mapped explicitly: `-239` is TON Mainnet and `-3` is TON Testnet.
- Manual public-address attachment accepts TON raw and checksummed user-friendly addresses.

## Backend configuration

Optional Render API environment variables:

| Variable | Purpose |
| --- | --- |
| `WORLD_WALLET_TONAPI_API_KEY` | Recommended TonAPI bearer token; keep this on the API service only |
| `WORLD_WALLET_TONAPI_MAINNET_BASE_URL` | Defaults to `https://tonapi.io/v2` |
| `WORLD_WALLET_TONAPI_TESTNET_BASE_URL` | Defaults to `https://testnet.tonapi.io/v2` |

`TONAPI_API_KEY` is also accepted as a compatibility alias. No API secret is exposed in the browser. The public TonAPI endpoints have strict unauthenticated request limits; configure a key before production traffic.

## Balance and Jetton handling

- The read-only address endpoint fetches the native account balance and the account Jetton list from the network-specific TonAPI host.
- Jetton metadata is returned by TonAPI's indexed Jetton metadata service (TEP-64 metadata). TonAPI resolves the on-chain, off-chain and semi-chain metadata layout, including Snake/chunked values, and returns the parsed fields. The master contract address is preserved for each token. This initial integration delegates metadata decoding to TonAPI; it does not include a second in-app TON cell decoder.
- Amounts are calculated from the raw integer balance only when metadata supplies a valid integer decimal count from 0 to 30. There is no implicit 9-decimal fallback. When decimals are missing or invalid, the raw integer amount is retained and the UI says that decimals were not supplied.
- A temporary Jetton-index failure does not turn token balances into zero. The native TON balance can still be returned with an explicit Jetton-index warning.
- TON Testnet always uses the testnet TonAPI base URL, independently of TON Mainnet.
- The indexed response's sender Jetton wallet address is used for the transfer destination. There is no separate in-app TEP-89 getter implementation or fallback if the indexer does not return that address.

## Signing and ownership boundaries

- Native TON transfers are sent through the connected wallet's TON Connect `sendTransaction` method. Users approve the transaction in their wallet.
- Jetton transfers use the TEP-74 `transfer#0f8a7ea5` message body built from the metadata decimal count and indexed sender Jetton wallet address. The connected wallet signs and broadcasts the outer TON message. The current fee attachment is 0.05 TON and is visible for review in the wallet.
- The app never asks for TON recovery phrases or private keys.
- Jetton balances, indexed metadata and wallet-approved TEP-74 Jetton transfers are supported. Missing or invalid decimals, or a missing sender Jetton wallet address, disables the transfer instead of guessing.
- The current TON address attachment is not a `ton_proof` ownership attestation. Public TON/Jetton balance reads remain read-only and `ownership_verified=false`; do not treat these addresses as verified deposit/withdrawal settlement evidence.
- Jetton transfer signing is wallet-approved, but automated deposit/withdrawal settlement reconciliation is not part of this integration.

## Deployment notes

- Deploy the frontend so `https://world-wallet-ai-frontend.onrender.com/tonconnect-manifest.json` is publicly available with a successful JSON response.
- Deploy the API branch only after review and approval; no live deployment or Render configuration change was made as part of this branch.
- The wallet-address table accepts network-qualified addresses; this feature does not require a schema migration.
