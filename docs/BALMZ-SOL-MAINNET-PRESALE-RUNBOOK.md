# BALMZ-SOL Mainnet presale treasury runbook

This runbook covers **read-only readiness checks** for the World Wallet AI BALMZ-SOL presale. It does not deploy a token, sign a transaction, move SOL, or enable payment acceptance.

## Current launch policy

- Presale target: **$7 USD per BALMZ-SOL token**.
- Launch target: **1 BALMZ-SOL = 1 SOL**. This is a target, not a guaranteed market price; it requires a disclosed liquidity/pricing mechanism.
- Planned supply: **1,000,000,000 tokens with 9 decimals**. This is not a production fact until the Mainnet mint is verified and the authority policy is enforced.
- Existing mint `HBSuf6Dm9r2ebkwLUoaY8ScR2rq5L2CPTJpCbqMbtndF` is **Solana Devnet only** and must never be used as the production presale mint.
- Real payments remain disabled until production mint, receiving address, settlement verification, duplicate/replay protection, and operational checks are complete.

## 1. Verify a candidate receiving address from Termux

Use a public address that you control. A positive SOL balance by itself does **not** prove ownership. Never paste a seed phrase, private key, keystore, or wallet export into Termux commands, GitHub, logs, or ChatGPT.

Set the candidate address in your local Termux session (replace the placeholder locally; do not commit the address):

```sh
pkg install curl jq
export CANDIDATE_SOLANA_ADDRESS='PASTE_YOUR_PUBLIC_MAINNET_ADDRESS_HERE'
export SOLANA_RPC_URL='https://api.mainnet-beta.solana.com'
```

Confirm the RPC is Solana Mainnet:

```sh
curl -sS "$SOLANA_RPC_URL" \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' | jq
```

The expected Mainnet genesis hash is:

```text
5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d
```

Read the balance and account information:

```sh
curl -sS "$SOLANA_RPC_URL" \
  -H 'Content-Type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"getBalance\",\"params\":[\"$CANDIDATE_SOLANA_ADDRESS\",{\"commitment\":\"finalized\"}]}" | jq

curl -sS "$SOLANA_RPC_URL" \
  -H 'Content-Type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"getAccountInfo\",\"params\":[\"$CANDIDATE_SOLANA_ADDRESS\",{\"encoding\":\"base64\",\"commitment\":\"finalized\"}]}" | jq
```

Interpret the results carefully:

- A valid Mainnet genesis hash confirms the RPC cluster, not the address owner's identity.
- `getBalance.value` is in lamports; divide by 1,000,000,000 to get SOL.
- `getAccountInfo.value: null` means the address has no on-chain account at that moment. Do **not** treat that as a verified, funded treasury. Confirm the exact public address in the wallet that controls it and recheck after a normal, owner-initiated on-chain activity if appropriate.
- Do not send a test payment just to check an address unless you have independently confirmed ownership and accept the network fee and risk.

## 2. Configure Render only after verifying ownership

The backend reads these server-side environment variables:

- `WORLD_WALLET_SOLANA_MAINNET_RPC_URL` — optional Mainnet RPC URL. The backend has a public Mainnet RPC default.
- `WORLD_WALLET_BALMZ_SOLANA_MAINNET_MINT` — the **production Mainnet mint**, only after deployment and independent verification.
- `WORLD_WALLET_BALMZ_PRESALE_RECEIVING_ADDRESS` — the receiving public address you control.

Configure them in the **World Wallet AI backend service** in Render's environment settings, never in frontend `VITE_*` variables or committed source. Redeploy the backend after changing environment settings, then open the signed-in **BALMZ Presale** page and select **Refresh checks**.

The backend's `/api/v1/balmz/presale/status` endpoint is read-only. It checks the configured mint and treasury against Solana Mainnet and reports warnings. It must not be treated as payment settlement.

## 3. Launch blockers that must stay closed

The presale must remain unavailable until all of these are independently confirmed:

1. Production mint exists on Solana Mainnet, is owned by the expected SPL Token program, has 9 decimals, and the observed supply matches the documented supply policy.
2. Mint/freeze authority choices are documented and verified. If the supply is fixed, mint authority must be revoked after the intended supply is minted.
3. Treasury address is controlled by the founder/authorized entity, exists on Mainnet, and is suitable for business treasury use. Balance alone is not proof of ownership.
4. Payment settlement verifies finalized Mainnet transactions, correct recipient, asset, amount, and order; rejects duplicate/replayed signatures; and handles underpayments, overpayments, failed transactions, and refunds.
5. CI, backend tests, frontend build, monitoring, security review, legal disclosures, and customer support/refund processes are complete.
6. The launch target of 1 BALMZ-SOL = 1 SOL is backed by a clearly disclosed mechanism. UI reference pricing alone cannot guarantee market price or liquidity.

## 4. Transaction scope and reserves

- Devnet transaction history is test evidence only. It must not settle real presale orders or count toward production balances/reserves.
- Mainnet transaction history proves activity only; it does not by itself prove reserves, ownership, or token value.
- Never reuse an address solely because it appears to have a balance. Verify network, exact address, wallet control, and intended role first.
- The backend currently keeps presale payment acceptance disabled. Do not change this to enabled until the settlement path is implemented and tested end-to-end.
