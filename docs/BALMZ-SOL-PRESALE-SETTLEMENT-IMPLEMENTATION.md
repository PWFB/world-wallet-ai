# BALMZ-SOL Mainnet presale: implementation and release gates

## Scope

This document is the implementation contract for the next BALMZ-SOL presale work in World Wallet AI. It is deliberately a pre-launch specification: it does not create a mint, sign transactions, move SOL, configure Render, or enable payment acceptance.

## Known project parameters

- Solana Mainnet allocation: 10,000,000,000 BALMZ-SOL.
- Token decimals: 9.
- Initial presale tranche: 1,000,000,000 BALMZ-SOL, included within the 10-billion Solana allocation (not additional supply).
- Global BALMZ maximum: 31,000,000,000 across the approved chain allocations.
- Existing Devnet mint is test-only and must never be accepted as a production mint.
- The displayed $7 USD reference and 1 BALMZ-SOL = 1 SOL launch target are planning assumptions, not guaranteed market prices or liquidity.

## Treasury candidate

The founder supplied a public Solana address and reported a 0.25 SOL deposit. Treat this as a candidate treasury and user-reported funding, not verified ownership or independently verified on-chain balance. Do not hardcode the address in source code, tests, frontend bundles, or public docs. Configure the public address only in the backend environment after independent verification and an explicit treasury-authorization decision.

A balance check is not ownership proof. Ownership should be established with a wallet-native signed challenge (or another reviewed proof-of-control flow) that does not request or expose private keys or recovery phrases.

## Implementation stages

### Stage A — Readiness and treasury controls

1. Keep all presale payment acceptance paths disabled by default.
2. Verify the RPC genesis hash equals Solana Mainnet before reading mint, receiver, or transaction data.
3. Validate public-key inputs before RPC requests.
4. Report receiver account existence, finalized SOL balance, and mint state as separate facts.
5. Never label an address as owner-verified merely because it exists or has a positive balance.
6. Keep the Devnet mint and Devnet transactions isolated from production readiness and settlement.

### Stage B — Payment-intent and quote model

Create a server-side payment intent before accepting a payment. Each intent must bind:
- authenticated account identifier;
- unique opaque order ID;
- exact production mint and network;
- exact treasury receiving address;
- accepted payment asset (initially SOL only unless separately approved);
- quoted amount, token allocation, fee treatment and rounding policy;
- quote creation and expiry timestamps;
- state transition history.

Use decimal/integer base units only. Do not use binary floating point for SOL lamports, token base units, or financial amounts. Expired quotes must not be silently repriced.

### Stage C — Finalized transaction settlement

A settlement verifier must:
1. Fetch the transaction from the configured Solana Mainnet RPC and require finalized commitment.
2. Reject missing, failed, unsupported-version, or non-Mainnet transactions.
3. Parse actual System Program SOL transfers (not explorer display labels).
4. Match the exact destination, source policy, asset, and amount to one unexpired payment intent.
5. Validate transaction slot/time against the quote's expiry policy.
6. Enforce database uniqueness for transaction signature and payment-intent settlement.
7. Perform settlement and token allocation in one database transaction, using idempotent state transitions.
8. Handle underpayment, overpayment, duplicate signature, quote expiry, and RPC/database failures without issuing duplicate token allocations.
9. Record immutable audit events sufficient for reconciliation and support.

Do not trust a client-submitted transaction signature as proof of payment. It is only a lookup key for server-side verification.

### Stage D — Token allocation

Before any token transfer, independently verify:
- production mint address and SPL Token program owner;
- 9 decimals;
- exact approved total supply and remaining presale tranche;
- treasury token account ownership and available token balance;
- mint/freeze authority policy and on-chain state.

The initial 1-billion tranche must be reserved from the 10-billion Solana allocation. No code path may mint beyond the approved allocation. If fixed supply is approved, revoke mint authority only after the complete intended supply has been minted and independently verified. Freeze authority must be an explicit governance/disclosure decision, not an implicit default.

### Stage E — Testing and operations

Required automated tests:
- wrong cluster/genesis hash;
- Devnet mint or Devnet transaction rejected;
- invalid/malformed signature;
- transaction not found or not finalized;
- failed transaction;
- wrong recipient;
- wrong asset/program;
- wrong amount and decimal/lamport precision boundaries;
- expired quote;
- underpayment and overpayment policy;
- duplicate signature and concurrent duplicate settlement;
- RPC timeout and malformed RPC response;
- database failure between verification and allocation;
- token account missing/insufficient balance;
- allocation cap and tranche exhaustion;
- replay after successful settlement;
- unauthenticated user cannot read or settle another user's intent.

Operational gates:
- CI tests and frontend/backend builds pass;
- security review of transaction parsing and database idempotency;
- monitoring and reconciliation alerts are in place;
- customer-facing pricing, liquidity, fees, refunds, risks and support disclosures are published;
- final production mint and treasury evidence is independently reviewed.

## Release decision

The presale must remain planning / payment acceptance disabled until Stages A–E are implemented, tested, reviewed, and production configuration is explicitly approved. A funded SOL address alone is not a deployed token or a working presale.

## Deployment boundary

This work may be merged as code after review, but production Render environment changes and deployment require separate explicit approval. No live mint creation, authority revocation, token transfer, treasury movement, or payment activation is authorized by this specification.