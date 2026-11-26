# BALMZ-SOL presale: Solana Mainnet setup and verification

## Current release state

- BALMZ presale price target: **$7 USD per token**.
- Launch target: **1 BALMZ-SOL = 1 SOL**, a target that requires a separately disclosed market/liquidity mechanism and is not guaranteed by token metadata.
- The existing BALMZ mint `HBSuf6Dm9r2ebkwLUoaY8ScR2rq5L2CPTJpCbqMbtndF` is **Solana Devnet only**. It is for testing and must not be used to accept real presale payments.
- Presale payment acceptance remains disabled until the production mint, receiver ownership, supply policy, finalized-payment verification, replay protection, token allocation, and launch/liquidity controls are reviewed.
- Approved supply policy: **31,000,000,000 BALMZ global maximum**; **10,000,000,000 BALMZ Solana Mainnet allocation**; **1,000,000,000 BALMZ initial presale tranche included within that Solana allocation**; the remaining **9,000,000,000 BALMZ** remains allocated to Solana but outside the initial tranche. Do not add the 1-billion tranche on top of the 10-billion allocation.

## Read-only allocation reconciliation

The administrator-only `GET /api/v1/admin/balmz/presale/allocation-reconciliation` endpoint compares allocation-state counters with settled allocation-ledger entries and currently unexpired pending payment intents. It reports drift, reservation mismatches, invalid numeric metadata, and cap overruns. This is a consistency report only: it does not repair database values, settle payments, distribute tokens, or change any presale release gate.

## Administrator-bound treasury ownership proof

The ownership status is time-bounded: a successful message-signature proof is treated as current for 30 days only. After expiry, the administrator must request and sign a new challenge for the exact configured treasury address. Future-dated or timezone-naive proof timestamps are rejected. This freshness check is evidence hygiene only; it does not change any presale release flag or authorize payments.

The backend provides a separate, read-only ownership proof for the exact configured
`WORLD_WALLET_BALMZ_PRESALE_RECEIVING_ADDRESS`. It is separate from ordinary wallet
attachment verification and is restricted to the account matching
`WORLD_WALLET_ADMIN_EMAIL`.

1. Authenticate as the configured World Wallet AI administrator.
2. Call `POST /api/v1/admin/balmz/treasury-ownership/challenge`. The response contains
   the exact treasury address, a one-time message, and a 10-minute expiry.
3. In the wallet that controls that exact Solana address, sign the returned message
   using the wallet's **message-signing** function. Do not approve a transaction.
4. Base64-encode the raw 64-byte Ed25519 signature and submit it with the returned
   `challenge_id` to `POST /api/v1/admin/balmz/treasury-ownership/verify`.
5. Read `GET /api/v1/admin/balmz/treasury-ownership/status` to confirm the stored
   proof is bound to the currently configured treasury and administrator.

The server verifies the signature against the public key encoded by the exact treasury
address, consumes the challenge once, stores only a SHA-256 digest of the signature,
and records an administrator audit event. A changed treasury address requires a new
proof. Never send a private key, seed phrase, or wallet PIN to the API or chat.

This proof does **not** send a transaction, deploy a mint, revoke authorities, or
change any of the five presale release environment flags. It is evidence for
independent review; it does not itself authorize presale launch.

## Reuse an existing Mainnet address

Reuse a Mainnet address only if the founder controls it, can sign from the wallet that owns it, and understands that its balance is public. A positive SOL balance can pay network fees; it does **not** prove the address is controlled by the project or safe to use as a treasury.

The address `BHtNACeUmNwSJG5LwCmgKyfpC4RQoQpNHw7ugffx5Hv1` was reported in the explorer as “Account does not exist” with no transactions. Do not configure it as the presale receiver unless a fresh Mainnet check confirms the correct address and its intended ownership. Never send funds to a guessed or unverified address.

## One-command read-only check from the repository

After cloning the repository in Termux, run this with a public address you control:

```sh
pkg install curl jq
bash tools/balmz-solana-mainnet-check.sh YOUR_PUBLIC_SOLANA_ADDRESS
```

The script verifies the RPC genesis hash before reading finalized balance and account information. It never signs or sends a transaction and does not prove ownership. The BALMZ Presale page can refresh backend Mainnet readiness; payment acceptance remains disabled.


## Verify a public address from Termux

Install the read-only tools if needed:

```sh
pkg update
pkg install curl jq
```

Set the **public address you already control**. This is only a public address, not a private key or recovery phrase:

```sh
read -r -p "Solana Mainnet public address: " BALMZ_RECEIVER
test -n "$BALMZ_RECEIVER" || { echo "STOP: address is empty"; exit 1; }
RPC="https://api.mainnet-beta.solana.com"
```

Confirm the RPC is actually Solana Mainnet:

```sh
curl -fsS "$RPC" -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' | jq
```

Read the account and finalized SOL balance:

```sh
curl -fsS "$RPC" -H 'Content-Type: application/json' \
  --data "$(jq -nc --arg address "$BALMZ_RECEIVER" \
    '{jsonrpc:"2.0",id:1,method:"getAccountInfo",params:[$address,{encoding:"base64",commitment:"finalized"}]}')" \
  | jq '{account_exists: (.result.value != null), owner: .result.value.owner, lamports: .result.value.lamports}'

curl -fsS "$RPC" -H 'Content-Type: application/json' \
  --data "$(jq -nc --arg address "$BALMZ_RECEIVER" \
    '{jsonrpc:"2.0",id:1,method:"getBalance",params:[$address,{commitment:"finalized"}]}')" \
  | jq '{lamports: .result.value, sol: ((.result.value // 0) / 1000000000)}'
```

If `account_exists` is false or the balance is zero, stop and review the address; do not treat it as a funded treasury. An account's balance alone does not establish ownership. Verify control by signing a harmless challenge with the wallet application or through an independently reviewed ownership-verification flow. Never reveal the private key or recovery phrase.

## Backend configuration

The API reads these **server-side Render environment variables**:

- `WORLD_WALLET_BALMZ_SOLANA_MAINNET_MINT`: production SPL mint address (not the Devnet mint).
- `WORLD_WALLET_BALMZ_PRESALE_RECEIVING_ADDRESS`: the verified public Mainnet treasury address.
- `WORLD_WALLET_SOLANA_MAINNET_RPC_URL`: optional Mainnet RPC override.

Set them only after checking the address and production mint. Do not put these values or any secret keys in frontend variables, source control, or chat. The current backend endpoint is read-only: it reports readiness and observed balance but does not move funds or enable payments.

## Release gate and implementation status

The backend now contains read-only Mainnet readiness checks, finalized native-SOL payment verification, short-lived server-priced payment intents, replay protection, and an atomic database allocation ledger. These are implemented software controls, **not evidence that a production mint or treasury has been deployed or that presale payments are safe to accept**.

Important limits:

- Settlement verifies the finalized payment and records a database allocation. It does **not** transfer BALMZ-SOL to a buyer's wallet.
- A recorded allocation is not token delivery, and there is no automatic refund transaction. Any refund requires a separately reviewed and explicitly approved outbound SOL transaction.
- The configured treasury must be independently proven to be controlled by the authorized project owner. A positive balance, System Program ownership, or an ordinary user's verified wallet address is not proof of founder/treasury control.
- The generic wallet-address message-signing challenge is scoped to an account's attached wallet. Do not treat that flag as treasury-owner approval unless a separate, audited control binds the exact configured treasury address to the designated project administrator.
- The current five server-side release flags must remain false until the evidence below is complete:
  - `WORLD_WALLET_BALMZ_PRESALE_INTENTS_ENABLED`
  - `WORLD_WALLET_BALMZ_PRESALE_SETTLEMENT_ENABLED`
  - `WORLD_WALLET_BALMZ_PRESALE_RELEASE_APPROVED`
  - `WORLD_WALLET_BALMZ_PRESALE_TREASURY_OWNERSHIP_VERIFIED`
  - `WORLD_WALLET_BALMZ_PRESALE_REGRESSION_SUITE_VERIFIED`

Do not change these flags as part of routine deployment or testing. The API fails closed while required flags or readiness checks are false.

### Remaining production evidence before launch

1. Deploy a dedicated Solana Mainnet mint; never reuse the Devnet mint. Independently verify the mint address, SPL Token Program owner, initialized state, 9 decimals, exact 10,000,000,000-token supply, and both authority states.
2. Confirm the configured treasury address on Solana Mainnet and complete an independently reviewed, harmless signed-message ownership proof that explicitly binds that exact address to the authorized project administrator. Do not send a test payment or transaction as an ownership test.
3. Verify the 31-billion global allocation ledger and confirm the 1-billion initial presale tranche is included within the 10-billion Solana allocation.
4. Run the full regression suite against the release candidate, including finalized payment, exact receiver/amount, duplicate signature, concurrent allocation, expiry, malformed RPC response, and failure handling.
5. Complete a separately reviewed token-delivery design and tested delivery/reconciliation process. Settlement currently records allocations only.
6. Publish clear buyer disclosures for the $7 USD target, the non-guaranteed 1 BALMZ-SOL = 1 SOL launch target, liquidity/market risks, settlement timing, and the refund/support process.
7. Obtain explicit project-owner release approval only after independent review of the evidence. Keep presale payment acceptance disabled until then.

Never paste private keys, seed phrases, wallet PINs, or OTPs into chat or source control. No readiness check or documentation change authorizes minting, authority revocation, transfers, or presale activation.

## Approved freeze-authority policy

The approved BALMZ-SOL policy is a fixed-supply token: after the intended 10,000,000,000-token Solana Mainnet allocation has been minted and independently verified, the freeze authority is intended to be permanently revoked. This decision does not authorize an immediate on-chain transaction. Before revocation, verify the exact production mint, token program, decimals, total supply, mint authority state, and the authorized wallet in a wallet-native transaction review. The revocation transaction must be explicitly approved by the project owner, confirmed at finalized Solana Mainnet commitment, and its signature retained in the release evidence. Never revoke the authority on the Devnet test mint or on an unverified mint. If the freeze authority cannot be safely revoked after independent review, stop the launch and disclose the retained authority rather than silently changing policy.
