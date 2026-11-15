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

Wise Platform offers partner and enterprise APIs, but those require a separate Wise relationship. Wise's standard business-account API documentation also limits API-funded transfers to selected business-account countries, and Wise's help documentation lists Nigeria among locations that cannot receive USD account details. These distinctions mean Wise should not be assumed to provide this exact US bank-to-US bank product for a Nigeria-based entity. See:
- https://docs.wise.com/guides/product/send-money/use-cases/payouts-smbs
- https://docs.wise.com/guides/product/partner/business-account-support
- https://wise.com/help/articles/2810318/can-i-get-usd-account-details/

## Activation gate

Do not enable the send action until the selected provider has confirmed in writing that it supports BALMZ's legal entity, US domestic ACH collection and payout, and the proposed sender-to-recipient funds flow. Store provider credentials only as backend environment variables; never in the Android app, browser bundle, or source control.
