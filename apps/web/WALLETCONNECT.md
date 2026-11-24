# WalletConnect web connection

World Wallet AI's web **Wallets** page restores the WalletConnect QR connection flow through the pinned `@walletconnect/ethereum-provider` v2 integration.

## Frontend setup

1. Create or select a WalletConnect/Reown project and copy its project ID.
2. Add `VITE_WALLETCONNECT_PROJECT_ID` to the **world-wallet-ai-frontend** Render static-site environment.
3. Allow the production web origin in the project configuration, where required by the provider dashboard.
4. Rebuild the frontend after setting the value. The project ID is a public client identifier, not a wallet secret.

When the user selects **Connect WalletConnect (QR)**, the QR modal opens on desktop and WalletConnect handles supported wallet-app hand-off/deep-link behavior on mobile. Only EVM accounts approved in the session are read. Supported network IDs are Ethereum Mainnet (1), BNB Chain Mainnet (56), and Sepolia (11155111).

All approved session addresses are saved separately under the currently selected World Wallet profile. Existing saved addresses from other providers or networks are retained. Disconnecting WalletConnect does not delete previously attached public receiving addresses. The existing Wallets sync attaches public addresses to the backend; the user must separately complete the ownership challenge before an address becomes verified.

Connection does not sign a transaction, broadcast, transfer funds, or request a private key, recovery phrase, or wallet PIN.

## License and attribution

The SDK is provided under the **WalletConnect Community License**. Review the exact `LICENSE.md` shipped with the installed package in `node_modules/@walletconnect/ethereum-provider/`; the build copies that file to `/licenses/walletconnect-ethereum-provider-LICENSE.md`.

Required attribution for distributed builds:

> Portions © 2025 Reown, Inc. All Rights Reserved

The license describes usage limits of 2,500,000 monthly RPC calls and 500 monthly active users before a commercial license is required, and reserves the right to change thresholds. Review the current agreement and Reown terms before production use; this note is not legal advice. The SDK must use the Reown gateway/WalletConnect network as required by its license.

Official references:
- https://docs.walletconnect.com/license-update
- https://app.unpkg.com/@walletconnect/ethereum-provider@2.21.1/files/LICENSE.md
- https://reown.com/terms-of-service

## Verification gate

The connection code and regression tests can be reviewed in this branch, but production use still requires the project ID, current license/attribution review, successful CI, and real Binance/OKX/WalletConnect mobile-device tests. A build or QR display alone does not prove a successful wallet connection.
