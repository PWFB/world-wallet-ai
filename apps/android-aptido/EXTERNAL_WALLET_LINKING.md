# External wallet linking: provider-adapter decision

**Status:** Binance EVM proof-of-concept implemented in draft PR #255; live deployment and physical-device tests pending  
**Date:** 2026-11-15  
**Scope:** BALMZ AI APT Android external-wallet account linking

## Decision

Do not add Reown AppKit or another package that transitively introduces WalletConnect SDKs under the WalletConnect Community License.

Use a provider-adapter bridge instead. The Android app remains the owner of account selection and persistence. A small HTTPS bridge page is opened in the selected wallet's supported mobile browser / dApp browser. The first Binance EVM proof-of-concept now implements this flow for Ethereum Mainnet and BNB Chain Mainnet only: it obtains a public account and, only when requested, asks Binance Web3 Wallet to sign a short-lived ownership challenge. Android receives the public account and signature, then uses the existing authenticated World Wallet AI address attach and challenge/verify APIs. The implementation remains in draft PR #255 and is not active on the live backend until deployed.

This is a provider-specific connection flow, not a claim that all wallets implement one common protocol.

## Provider evidence and scope

### Binance Web3 Wallet

The Binance Web3 Connect documentation describes provider injection inside the Binance Web3 Wallet dApp browser:

- EVM: `window.binancew3w.ethereum`, with `eth_requestAccounts`, `accountsChanged` and `chainChanged` events.
- Bitcoin: `window.binancew3w.bitcoin`, including `requestAccounts()`, `getNetwork()` and `signMessage()`.
- Solana: Binance documents Wallet Standard support.

The page must be opened in Binance's dApp browser for these injected providers to exist. Do not assume they are available in an ordinary Chrome tab or in the BALMZ Android WebView.

Official references:
- https://developers.binance.com/en/docs/products/web3-connect/evm-compatible-provider
- https://developers.binance.com/en/docs/products/web3-connect/bitcoin-provider
- https://developers.binance.com/en/docs/products/web3-connect/solana-provider
- https://developers.binance.com/en/docs/products/web3-dapp/self-testing

### OKX Wallet

OKX publishes `@okxconnect/connect-kit` (npm lists version 1.6.7 as MIT-licensed). Its current package documentation describes mobile-browser / Telegram connection, EIP-6963 and Wallet Standard provider injection, and account providers for Ethereum/EVM, Bitcoin and Solana (with additional ecosystems listed).

A complete lockfile/SBOM license scan is still required before adding it; package-level MIT metadata alone is not a transitive-license clearance. Do not assume that a package-level license tells us the terms of every transitive dependency or its required network services.

This is an OKX-specific adapter, not a general Binance/OKX multi-wallet connector.

Official references:
- https://www.npmjs.com/package/@okxconnect/connect-kit
- https://web3.okx.com/onchainos/dev-docs/wallet/dapp-connect/okx-wallet-integration-introduction
- https://web3.okx.com/onchainos/dev-docs/wallet/dapp-connect/app-connect-preparation

## Android and backend flow

1. Android starts a provider-specific connect attempt with a cryptographically random, single-use correlation value. No access token, PIN, mnemonic or private key is passed to the bridge.
2. The bridge is opened through the provider's supported mobile deep-link / dApp-browser path. It requests account access and reads the selected network/chain from that provider.
3. The bridge returns only provider ID, namespace, chain/network ID, public address and correlation value to the Android app. The app checks the correlation value and validates the address/network pair.
4. Android attaches the public address to the active wallet profile using the authenticated `POST /api/v1/wallets/{wallet_id}/addresses` API.
5. Android requests the existing 10-minute ownership challenge from `POST /api/v1/wallets/{wallet_id}/addresses/challenge`.
6. The bridge is reopened for that wallet/provider/network and asks for a message signature only. It must not request transaction signing during account linking.
7. Android submits the returned signature to `POST /api/v1/wallets/{wallet_id}/addresses/verify`. Only a successful backend verification marks the address as ownership-verified.

Because the current challenge endpoint requires the address to be attached first, account discovery and proof-of-control are intentionally separate steps. Do not bypass that ownership check.

## Persistence and chain isolation

The Android-side external-account registry must key records independently by:

- active wallet profile ID;
- provider ID (for example, `binance` or `okx`);
- namespace (EVM, Bitcoin, Solana);
- exact chain/network ID;
- public address.

The current backend address API stores network, address, label and ownership status; it does not accept a structured provider ID or session ID. It can hold multiple distinct addresses for the same wallet/network, while the same network/address pair is treated as one address record. Therefore Android must retain provider associations locally; do not treat the backend label as a durable provider/session key. If two providers expose the same public address, keep both provider associations in the local registry while the backend can keep one ownership record for that network/address pair.

A chain change updates the selected chain for that provider session; it must not erase another chain's saved address or force the app's global network selector back to Ethereum. Preserve multiple provider/account records for one wallet profile. Never merge external accounts with the app's locally generated self-custody addresses.

Persist public account metadata only. Do not persist provider session secrets in ordinary preferences or send any recovery phrase/private key to the bridge or backend.

## Constraints and security gates

- The Binance injected APIs are available in Binance's dApp browser, not a generic native Kotlin provider. Test the actual Android app hand-off and return path on a physical device.
- OKX Connect Kit is browser-oriented. The native Android integration needs a narrowly-scoped browser/deep-link bridge and a verified return to the app.
- Before adopting the OKX package, generate and review a full dependency lockfile/SBOM; reject any unexpected Reown/WalletConnect Community License component.
- Allow only explicit chain IDs and namespaces needed by this app. Do not infer a chain from the address format alone.
- Bind each result to a one-time correlation value and the backend challenge. Ignore stale, mismatched or replayed callbacks.
- The current backend Bitcoin ownership verifier only supports native SegWit v0 (Bech32 witness-version 0) message-proof addresses; test this limitation before claiming general Bitcoin address support.
- Keep ownership verification distinct from wallet connection status. A verified address is proof of control at verification time, not a perpetual live session.
- The current Binance bridge only uses `eth_requestAccounts`, `eth_chainId`, `eth_accounts` and `personal_sign`; no `eth_sendTransaction`, token approvals, swaps or asset transfers are part of this linking phase.
- Connection and proof callbacks are tied to a random 256-bit nonce stored using Android Keystore-backed encrypted storage and expire after ten minutes.
- Do not expose the authenticated API token, wallet PIN, mnemonic or private keys to the bridge page.

## Out of scope for this PR phase

- Reown AppKit, WalletConnect SDKs, TrustConnect or WalletCast dependencies.
- A universal claim that every wallet or chain is supported.
- External-wallet transaction signing/broadcast, token approvals or swaps.
- Production deployment of a bridge host, migrations, PR merge or signed public APK.

## Acceptance tests before enabling the feature

- Connect Binance EVM on Ethereum and BNB Chain; save both chain records without changing or overwriting the other. This is the current PoC acceptance test and remains pending a deployed bridge and physical-device run.
- Connect OKX EVM and verify its provider/account association persists after returning to BALMZ AI and restarting the app; do not assume a live provider session survives process death unless the SDK confirms it.
- Verify `accountsChanged`, `chainChanged`, provider disconnect and app process death do not silently attach the wrong address; current PoC reads the active chain/account at connection and signature time and has not implemented a persistent live provider session.
- Test Solana and Bitcoin separately, only for networks/address formats supported by both provider and backend verifier.
- Confirm the backend marks an account verified only after a valid signature challenge; reject expired, reused, wrong-chain and wrong-address challenges.
- Confirm the bridge cannot read the app's auth token/PIN or local recovery material.
- Exercise rejected permission/signature requests, missing wallet apps, network loss and Android back/resume behavior.
