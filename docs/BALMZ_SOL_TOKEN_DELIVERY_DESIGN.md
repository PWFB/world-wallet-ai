# BALMZ-SOL token delivery design

## Status and scope

This document records the delivery security model for settled BALMZ-SOL allocations. A fail-closed API implementation now exists in `services/api/balmz_delivery.py` and `services/api/main.py`; this design remains the security contract, not authorization to distribute tokens.

The settlement flow verifies finalized native-SOL payment and records a database allocation. The delivery API can prepare and submit a separately wallet-signed transfer only when all release gates are approved. Every allocation remains **allocated — token delivery pending** until finalized transfer evidence is verified.

This design does not authorize minting, treasury movements, authority changes, payment acceptance, or changes to any of the six release gates.

## Required invariants

1. **One settled allocation, at most one successful delivery.** Enforce a unique delivery record per allocation-ledger ID and a unique transaction signature. Database uniqueness is necessary but not sufficient; every ambiguous submission must be reconciled against finalized Mainnet chain state before retry.
2. **No inferred recipient.** The recipient is an explicit Solana Mainnet public address proven by a fresh wallet message-signature challenge. Do not silently use the SOL payer address unless the buyer explicitly selects it and proves control. A payer may nominate a different recipient only after that recipient signs the required challenge.
3. **Exact asset identity.** Bind every delivery to the independently verified production mint address, SPL Token Program owner, 9 decimals, and approved token allocation. Never use the Devnet mint or a symbol-only lookup.
4. **Exact base units.** Persist and compare integer base units (token amount multiplied by 10^9) using integer arithmetic. Reject fractional base units, non-finite values, overflow, negative amounts, and mismatches with the settled allocation.
5. **No private signer in the web/API process.** Transaction signing must occur in a separately controlled signer boundary (preferably hardware-backed or managed KMS/HSM with policy controls). No seed phrase, private key, or raw signing secret may enter source control, browser code, logs, database rows, or chat.
6. **Explicit authorization before broadcast.** A prepared transaction is not an approved transaction. Require a human approval record bound to the exact mint, recipient, amount in base units, fee payer, recent blockhash/last-valid height, and unsigned transaction digest. Any change invalidates approval.
7. **Finalized-chain evidence.** Mark delivery successful only after the exact transaction signature is observed at finalized commitment and its transaction metadata proves the intended mint, source token account, recipient token account, and exact base-unit transfer.
8. **No silent retries.** Retry only after checking the prior signature and transaction state. If the network result is ambiguous, retain an **unknown/reconciliation_required** state and stop automatic resubmission.
9. **No implicit refunds.** A failed or delayed token delivery does not authorize a SOL refund. Refunds remain a separate, reviewed outbound SOL workflow with separate explicit approval.
10. **Allocation cap remains authoritative.** Delivery does not increase or decrease the presale allocation ledger. Reconcile delivery totals to settled allocations; never treat pending delivery as unallocated supply.

## Proposed delivery lifecycle

| State | Meaning | Permitted next action |
|---|---|---|
| **pending_recipient** | Payment allocation is settled, but no verified recipient is attached | Buyer submits a public address and proves control |
| **ready_for_review** | Recipient proof is current; mint and allocation metadata match | Generate a read-only delivery preview |
| **prepared** | Unsigned transaction has been built and independently checked | Request exact-payload approval |
| **approved** | Authorized reviewer approved the exact transaction digest and fields | Submit once through the isolated signer |
| **submitted** | A transaction signature was returned | Poll that signature; do not create a replacement |
| **finalized** | Finalized chain evidence confirms the exact transfer | Close delivery as complete |
| **failed** | Chain definitively rejected/failed the transaction | Human review; a new attempt requires a new approval |
| **reconciliation_required** | Submission outcome is ambiguous or evidence conflicts | Stop; reconcile signature and account state before any action |

A recipient proof should expire after a short, documented period and must be invalidated if the destination address changes. The delivery process must retain the exact proof timestamp and verified address.

## Transaction preparation and review

Before approval, the backend must construct a deterministic transfer plan from authoritative database and Mainnet evidence:

- settled allocation ledger ID and originating payment-intent ID;
- originating finalized SOL payment signature and slot;
- verified recipient public key and proof record;
- configured Mainnet mint address and verified token program;
- source token account and recipient associated token account (ATA);
- exact integer token base units and decimals;
- fee payer, transaction message digest, recent blockhash, and last-valid block height;
- current source-account spendable balance and rent/fee requirements.

ATA creation, if required, must be shown as a separate instruction in the review preview. The review must show the exact account that pays rent and fees. Do not create accounts or send transactions during a read-only preview.

Approval must bind the complete serialized message (or a collision-resistant digest of its canonical bytes) and all human-readable fields above. Rebuilding the transaction with a new blockhash or any changed instruction requires a new approval.

## Isolated signing and broadcast

The signing boundary must enforce an allowlist for the verified mint and token program, a maximum per-transaction amount, a daily aggregate limit, a fee ceiling, and an approved destination. It must reject arbitrary programs, extra instructions, delegate changes, authority changes, and transfers to a destination other than the approved recipient.

The signer must return the signed transaction and signature without exposing key material. The broadcaster records the signature before polling. A timeout after broadcast is not proof of failure: query the same signature until its state is known or escalate to **reconciliation_required**.

Do not store signed transaction bytes longer than operationally necessary. Never log full signed payloads or signer credentials.

## Implemented delivery-attempt ledger

The `balmz_presale_delivery_attempts` Postgres table records the allocation/owner, explicit recipient, mint/program, source and destination token accounts, authority, exact base units and decimals, finalized account-observation slots, fee estimate, blockhash expiry, unsigned transaction bytes, message digest, approval actor/time/expiry, transaction signature, finality slot, and sanitized failure state.

- immutable allocation-ledger foreign key, unique across successful deliveries;
- recipient address and recipient-proof reference;
- mint, token program, source token account, destination ATA;
- integer base units, decimals, and canonical transaction-message digest;
- state, attempt number, unique transaction signature (nullable until submission);
- approval actor, approval timestamp, approval digest, and expiry;
- submitted/finalized slots, confirmation timestamps, and sanitized failure code;
- created/updated timestamps and an append-only audit trail.

Use row locks or compare-and-swap state transitions to prevent two workers from preparing or broadcasting the same allocation concurrently. Add database constraints for allowed states, positive base units, 9 decimals, and unique allocation/signature. A failed attempt must remain in history; never overwrite it with a later attempt.

## Required regression and adversarial tests

- Reject an unverified recipient, stale proof, changed recipient, or payer/recipient mismatch without explicit recipient proof.
- Reject Devnet genesis, wrong mint, wrong token program, wrong decimals, wrong ATA, and unexpected instructions.
- Reject zero, negative, fractional-base-unit, non-finite, overflowing, or allocation-mismatched amounts.
- Prove concurrent workers cannot create two active submissions for one allocation.
- Prove duplicate requests return the existing delivery state and never broadcast a second transaction.
- Simulate timeout after broadcast; verify the worker polls the original signature and does not send again.
- Reject a transaction whose finalized metadata has the wrong mint, source, recipient, amount, or token program.
- Do not mark success for processed/confirmed-but-not-finalized transactions.
- Verify changed blockhash or message digest invalidates the previous approval.
- Verify signer policy rejects arbitrary programs, extra instructions, destination substitution, excessive fees, and limit overruns.
- Verify a failed delivery does not alter the settled allocation or trigger a refund.
- Reconcile successful delivery base units against settled allocation base units and report missing, duplicate, and excess deliveries.

## Operational and buyer-facing requirements

Before activation, publish delivery timing expectations, recipient-address correction policy, network-fee responsibility, support escalation, and what happens when delivery is delayed or permanently fails. Explain that a database allocation is not an on-chain token balance. Show the buyer the verified recipient address and exact amount before approval.

The production release review must include independent review of the mint and authorities, treasury ownership, global 31B supply ledger, 10B Solana allocation and included 1B tranche, signer controls, delivery regression evidence, monitoring/alerting, incident runbooks, and legal/customer disclosures.

## Explicit non-goals

This specification does not deploy the Mainnet mint, mint tokens, revoke mint/freeze authorities, create or fund token accounts, sign or broadcast transactions, enable presale payment acceptance, repair allocation records, or authorize refunds. The five WORLD_WALLET_BALMZ_PRESALE_* release flags must remain unchanged and disabled until all evidence is independently reviewed and the project owner explicitly approves release.


## Recipient proof freshness gate

The read-only delivery-readiness endpoint may list a buyer's Solana Mainnet address as a candidate only when the address is attached to a wallet owned by that buyer, the address is marked ownership-verified, and a successfully consumed wallet-address signature challenge for that exact wallet, owner, network, and address is no older than 30 days. Missing, expired, future-dated, or timezone-naive proof timestamps fail closed. A stale proof must be renewed through the existing wallet-address challenge and verification flow before the address can be considered for delivery. This freshness filter does not select a recipient or authorize a transaction; the buyer must still explicitly select and confirm the exact recipient for the allocation.
