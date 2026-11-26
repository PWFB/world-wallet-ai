# BALMZ-SOL payment reconciliation and refund runbook

## Status and scope

This runbook is an operator procedure, not an automated refund service. The application currently verifies exact finalized Mainnet payments and records one database allocation per intent/signature. It does not aggregate split payments, accept overpayments, send refunds, or deliver tokens on-chain.

**Never enable presale payment acceptance solely because this document exists or CI passes.** Keep every presale release flag false until independent treasury-control proof, production RPC validation, security review, legal/customer disclosures, and an explicit release decision are complete.

## Evidence to capture

Open one support/reconciliation case for each unexpected or disputed incoming transfer. Record:

- Case ID, authenticated customer account ID, support ticket reference, and UTC timestamps.
- Solana Mainnet transaction signature, finalized slot, and finalized transaction evidence from a trusted Mainnet RPC.
- Fee payer/signer, source address, destination address, exact lamports transferred, network fee, transaction error status, and any memo.
- The immutable payment-intent ID, expected payer, treasury, expected lamports, quote timestamp, expiry, and current database status, when an intent exists.
- Whether the transaction signature already appears in any settled intent or allocation-ledger row.
- Operator identity, reviewer identity, evidence references, decision, and customer communications.

Do not store seed phrases, private keys, wallet passwords, PINs, recovery codes, or authentication tokens in a case record. Do not treat a screenshot or an explorer display alone as sufficient evidence where finalized RPC transaction data is available.

## Reconciliation decision table

| Situation | Required handling |
| --- | --- |
| Exact amount, correct payer and treasury, finalized Mainnet transfer, unexpired pending intent, signature unused | Submit the normal settlement flow. Confirm the single allocation-ledger row and updated allocation counters after commit. |
| Pending, failed, or non-finalized transaction | Do not settle or allocate. Recheck finality using Mainnet RPC; keep the case open until finalized or definitively failed. |
| Underpayment or split payment | Do not prorate tokens or combine transfers automatically. The current intent verifier requires one exact transfer. Escalate for a documented manual decision; any refund is a separate outbound transaction. |
| Overpayment | Do not allocate additional tokens or create an overpayment credit automatically. Reconcile the full incoming amount and obtain separate approval for any return transfer. |
| Expired intent with a later incoming transfer | Do not revive the intent or allocate automatically. Verify the finalized transfer and open a manual case for a separately approved resolution. |
| Reused signature / duplicate submission | Preserve the existing settled allocation only. The same signature must never produce a second entitlement. Investigate any second incoming transfer as a separate transaction and case. |
| Wrong recipient or wrong network | Do not mark the intent settled. Verify whether the funds actually reached a wallet controlled by the project. If not, do not promise the project can refund them. |
| Payer mismatch or unclear source | Keep unsettled and escalate for ownership review. Do not redirect funds to an address supplied only in an unsolicited message. |
| Database/RPC outage or ambiguous evidence | Fail closed. Do not manually mark an intent as settled. Preserve evidence and retry only after the underlying issue is resolved. |

## Manual refund controls

A Solana transfer that has finalized cannot be reversed or cancelled. A refund, when approved, is a **new outbound SOL transaction** and is not part of the incoming-payment settlement endpoint.

1. Confirm the original incoming transfer is finalized on Solana Mainnet and identify the actual payer, recipient and lamports from RPC evidence.
2. Reconcile it against all intents and ledger rows. Check for duplicate signatures, prior refunds, other outbound movements and any existing customer entitlement.
3. Record the proposed refund amount in lamports, destination address, reason, fee estimate and remaining treasury balance. State explicitly whether the proposal is a full refund or a separately itemized excess return.
4. Require two-person approval: the case preparer must not be the final approver. The approver must review the original finalized evidence, destination ownership evidence, amount, fee and treasury impact.
5. Verify the refund destination with the customer through the authenticated support channel. Do not accept an address change solely from an email, chat message, or third party.
6. Have the authorized treasury controller review and sign the outbound transaction using the approved wallet process. Never place private keys or seed phrases in application configuration, support records, CI, or the backend.
7. Record the outbound transaction signature only after it has been broadcast, then independently verify finality and exact destination/lamports. A submitted signature is not proof of a completed refund.
8. Mark the case resolved only after the finalized outbound transaction (or documented no-refund decision) is independently confirmed and the customer is notified.

Never automatically refund from a webhook, a customer-provided signature, a support message, or a failed settlement request. Never use the incoming transaction signature as a refund reference. Never send a refund without an explicit approval and a separate, human-reviewed signing action.

## Daily treasury and ledger reconciliation

At least once per operating day while the presale is active:

- Re-query finalized Mainnet transactions for the configured treasury over the review window.
- Match every relevant incoming transfer to exactly one payment intent and its allocation-ledger row, or to an open reconciliation case.
- Confirm no signature is used by more than one intent or ledger row.
- Compare each settled intent's payer, treasury, paid lamports, token amount, base units and finalized slot with its evidence.
- Recompute allocated tokens from settled ledger rows and reserved tokens from still-pending, unexpired intents. Investigate any mismatch; do not repair counters by hand without a reviewed database transaction and audit record.
- Confirm allocated plus reserved tokens do not exceed 1,000,000,000 BALMZ-SOL and that the 1B initial tranche remains within the 10B Solana allocation.
- Reconcile treasury opening balance, finalized inflows, approved outbound refunds/fees, and closing balance. A balance alone is not proof of ownership or proof of reserves.

## Closure requirements

A case may close only when it has one of these documented outcomes: a verified exact payment settled once; a finalized refund verified; a documented no-refund decision approved; or a finding that the transfer was not received by the project treasury and therefore cannot be refunded by the project. Keep the evidence, approval trail, final signatures, and customer notification together.

## Explicit non-goals

This runbook does not authorize the presale to open, alter any production environment variable, approve treasury ownership, revoke token authorities, perform a refund, mint or transfer BALMZ-SOL, or certify legal compliance. The allocation ledger is a database entitlement record, not an on-chain token delivery or proof-of-reserves system.
