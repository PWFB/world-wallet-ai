# US bank transfers in BALMZ AI APT

## Placement

The entry point is intentionally tucked inside **BankConnect**. It is collapsed by default and is not a main navigation item. It is separate from crypto-wallet connection and from the read-only bank-account history panel.

## Current state

The APT currently shows the transfer area as **not active**. This is intentional: the repository's existing BankConnect API is a read-only Plaid integration and does not originate ACH transfers. No balance, transfer, or provider approval is fabricated.

## Required provider contract

Before enabling a real US bank-to-bank transfer, the backend must have a payment provider that has approved BALMZ's legal entity and the exact funds flow. The integration must provide:

- A provider-hosted or provider SDK bank-linking flow. BALMZ must not collect bank passwords or bank-issued OTPs.
- Verified ownership of the sending bank account before any ACH debit.
- A verified/validated destination bank account and explicit recipient confirmation.
- Both ACH collection/debit and ACH payout/credit capabilities for the relevant platform accounts.
- A provider-side ledger/wallet or settlement model for funds in transit. The UI must not treat a provider's accepted request as a settled transfer.
- Idempotency keys, transfer-status polling/webhooks, ACH return/reversal handling, per-user account ownership checks, and an auditable confirmation step.

A bank-to-bank ACH flow is not a simple direct credential exchange. Depending on the provider, funds may pass through an intermediary account or wallet before payout.

## Provider eligibility is not assumed

Moov's published prohibited-business policy, updated October 29, 2026, lists businesses headquartered or primarily operating outside the United States as prohibited. Therefore, Moov must not be activated if BALMZ's contracting entity is headquartered/primarily operated in Nigeria or another non-US country. See: https://moov.io/legal/platform-agreement/prohibited-restricted-businesses/

Nium is a more relevant candidate to evaluate for US payouts from a non-US program: its documentation lists USD ACH payouts to all US ABA-network banks and says payouts from clients onboarded with a Nium non-US entity are processed as IAT. Its US direct-debit documentation, however, limits that funding flow to Nium clients in the United States and business customers. Therefore Nium's payout capability does not by itself prove that BALMZ can debit a consumer's existing US bank account from a Nigeria-based platform. Confirm the exact sender type, funds source, customer geography, and P2P/B2P use case with Nium before selecting it. See:
- https://docs.nium.com/docs/payouts/country-and-regional-guides/usd-payments-to-the-united-states-ach
- https://docs.nium.com/docs/payins/direct-debit/direct-debit-us
- https://info.nium.com/country/united-states

Wise Platform offers partner and enterprise APIs, but those require a separate Wise relationship. Wise's standard business-account API documentation also limits API-funded transfers to selected business-account countries, and Wise's help documentation lists Nigeria among locations that cannot receive USD account details. These distinctions mean Wise should not be assumed to provide this exact US bank-to-US bank product for a Nigeria-based entity. See:
- https://docs.wise.com/guides/product/send-money/use-cases/payouts-smbs
- https://docs.wise.com/guides/product/partner/business-account-support
- https://wise.com/help/articles/2810318/can-i-get-usd-account-details/

## Recommended architecture to evaluate: Nium-funded USD wallet, then US bank payout

This is the closest documented fit for a non-US-operated APT, subject to Nium's approval of BALMZ and the exact customer/use-case model:

1. Nium onboards the BALMZ program and each eligible sender using its KYB/KYC process.
2. Where approved and supported by the Nium client configuration, BALMZ requests a customer-specific USD Virtual Account Number (VAN)/payment ID.
3. The sender pushes USD from their own US bank to that assigned account using their bank's ACH service. Nium confirms the incoming credit (Inward Credit Confirmation) before the USD is treated as available in the Nium wallet.
4. The sender chooses a previously verified US beneficiary, reviews the bank/account, amount, fee and delivery method, then confirms the payout.
5. BALMZ submits the payout from the funded Nium USD wallet and tracks provider events through final status, including returns and RFIs.

This is **not** an instant debit from the user's bank account inside BALMZ and not a direct bank-to-bank rail: funds pass through a provider-managed USD wallet. The source bank's ACH credit into the VAN is initiated by the sender at their bank. The provider must confirm the USD VAN is available for BALMZ's client region and the individual/corporate sender model.

Nium's documentation says payouts from clients onboarded with a Nium non-US entity use International ACH Transactions (IAT) for US beneficiaries; its published guide describes next-business-day beneficiary credit for that route. Do not advertise same-day domestic ACH for a non-US client configuration. Nium's generic payout product documents P2P, B2P, B2B and P2B, but the exact BALMZ program and payment purpose still require approval.

Official implementation references:
- Payouts supports person-to-person and business payment types: https://docs.nium.com/docs/payouts
- Nium wallets and USD Virtual Accounts: https://docs.nium.com/docs/wallets and https://preview.docs.nium.com/docs/payins/fund-wallet
- US ACH/IAT payout corridor and return lifecycle: https://docs.nium.com/docs/payouts/country-and-regional-guides/usd-payments-to-the-united-states-ach
- Provider-hosted beneficiary onboarding form: https://docs.nium.com/docs/sdks/payouts/beneficiary-management
- Sandbox and production environments: https://preview.docs.nium.com/docs/developers/nium-api/nium-enviorments

Nium credentials are issued per environment. API calls use the x-api-key header and clientHashId path parameter. Some embedded components additionally require a server-generated PKCE authorization code and client secret; that secret must never reach the mobile app or web bundle. Nium also requires backend IP allowlisting. Render uses shared regional outbound ranges by default; dedicated outbound IPs are available on Pro workspaces and above for an additional monthly charge. Confirm the chosen Render egress/IP arrangement with Nium before production.

## Activation gate

Do not enable the send action until the selected provider has confirmed in writing that it supports BALMZ's legal entity, US domestic ACH collection and payout, and the proposed sender-to-recipient funds flow. Store provider credentials only as backend environment variables; never in the Android app, browser bundle, or source control.


## Crypto purchases (implemented separately from bank payouts)

The hidden APT section also supports Coinbase Onramp session creation for BTC, ETH, USDC and SOL. It accepts only destinations that are attached to the signed-in user's active BALMZ wallet and marked `ownership_verified=TRUE`. The backend creates the short-lived CDP JWT, obtains a single-use Coinbase session token and returns a hosted checkout URL. No Plaid credentials or WalletConnect session are used by this flow. The user completes Coinbase identity/payment checks and must use a payment method Coinbase offers for their account and region.

Required Render variables (backend only): `COINBASE_CDP_API_KEY_NAME`, `COINBASE_CDP_API_KEY_SECRET`, `COINBASE_ONRAMP_ENV=sandbox`, and `COINBASE_ONRAMP_ENABLED=false`. After credentials and provider access are verified, enable sandbox first; production must be a separate approval step.

API routes: `GET /api/v1/bankconnect/crypto/status` and `POST /api/v1/bankconnect/crypto/buy-session`.

## Current implementation boundary

Coinbase purchase-session creation is implemented; it is not a proof that a payment settled or that crypto has arrived. Confirm the resulting on-chain transaction before showing a completed purchase. Nium USD bank payouts are still **disabled** because provider onboarding, KYC/KYB, the funded USD wallet, approved user/source-of-funds model and production ACH/IAT permissions are not available in this repository context. The APT deliberately shows an unavailable status instead of a false Send button.
