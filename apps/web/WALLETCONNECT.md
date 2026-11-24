# WalletConnect web connection

World Wallet AI's web **Wallets** page provides WalletConnect QR connection and compatible mobile wallet hand-off through the pinned `@walletconnect/ethereum-provider@2.21.1` SDK.

## Frontend setup

1. Create or select a WalletConnect/Reown project and copy its project ID.
2. Add `VITE_WALLETCONNECT_PROJECT_ID` to the **world-wallet-ai-frontend** Render static-site environment.
3. Allow the production web origin in the project configuration, where required by the provider dashboard.
4. Rebuild the frontend after setting the value. The project ID is a public client identifier, not a wallet secret.

When the user selects **Connect WalletConnect (QR)**, the QR modal opens on desktop and the SDK can hand off to supported wallet apps on mobile. Only EVM accounts approved in the session are read. Supported networks are Ethereum Mainnet (1), BNB Chain Mainnet (56), and Sepolia (11155111).

All approved session addresses are saved separately under the currently selected World Wallet profile. Existing saved addresses from other providers or networks are retained. Disconnecting WalletConnect does not delete previously attached public receiving addresses. The existing Wallets sync attaches public addresses to the backend; the user must separately complete the ownership challenge before an address becomes verified.

Connection does not sign a transaction, broadcast, transfer funds, or request a private key, recovery phrase, or wallet PIN.

## Package licensing

The exact pinned `@walletconnect/ethereum-provider@2.21.1` npm package metadata declares **Apache-2.0**. Its published package contents do not include a separate license text file, so the build writes a package-metadata notice under `public/licenses/` instead of claiming to copy a license file that is not present.

The SDK is deprecated in npm in favour of later reliability/performance updates. This project pins the historical v2 version to restore the earlier integration; do not upgrade it without reviewing the replacement's license and compatibility.

This is not a complete third-party license clearance. The provider has a transitive dependency tree (including Reown packages); generate and review a complete SBOM/license report before production distribution. The package metadata identifier and the dependency tree are distinct checks. The current Community License terms and thresholds for newer SDK releases must not be assumed to apply to this pinned package without checking each exact package version.

References:
- https://app.unpkg.com/@walletconnect/ethereum-provider@2.21.1/files/package.json
- https://www.apache.org/licenses/LICENSE-2.0
- https://docs.walletconnect.com/

## Verification gate

Before production use, configure the project ID, complete a transitive dependency license/SBOM review, pass CI, and test QR/mobile hand-off with actual Binance and OKX mobile wallets. Complete ownership verification separately. A displayed QR alone does not prove a successful wallet connection.
