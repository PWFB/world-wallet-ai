# BALMZ-SOL presale: Solana Mainnet setup and verification

## Current release state

- BALMZ presale price target: **$7 USD per token**.
- Launch target: **1 BALMZ-SOL = 1 SOL**, a target that requires a separately disclosed market/liquidity mechanism and is not guaranteed by token metadata.
- The existing BALMZ mint `HBSuf6Dm9r2ebkwLUoaY8ScR2rq5L2CPTJpCbqMbtndF` is **Solana Devnet only**. It is for testing and must not be used to accept real presale payments.
- Presale payment acceptance remains disabled until the production mint, receiver ownership, supply policy, finalized-payment verification, replay protection, token allocation, and launch/liquidity controls are reviewed.

## Reuse an existing Mainnet address

Reuse a Mainnet address only if the founder controls it, can sign from the wallet that owns it, and understands that its balance is public. A positive SOL balance can pay network fees; it does **not** prove the address is controlled by the project or safe to use as a treasury.

The address `BHtNACeUmNwSJG5LwCmgKyfpC4RQoQpNHw7ugffx5Hv1` was reported in the explorer as “Account does not exist” with no transactions. Do not configure it as the presale receiver unless a fresh Mainnet check confirms the correct address and its intended ownership. Never send funds to a guessed or unverified address.

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

## One-command read-only check from the repository

After cloning the repository in Termux, run this with a public address you control:

```sh
pkg install curl jq
bash tools/balmz-solana-mainnet-check.sh YOUR_PUBLIC_SOLANA_ADDRESS
```

The script verifies the RPC genesis hash before reading finalized balance and account information. It never signs or sends a transaction and does not prove ownership. The World Wallet AI presale UI has a **Refresh readiness** control that re-reads the backend's Mainnet status; the backend still keeps payment acceptance disabled.

## Backend configuration

The API reads these **server-side Render environment variables**:

- `WORLD_WALLET_BALMZ_SOLANA_MAINNET_MINT`: production SPL mint address (not the Devnet mint).
- `WORLD_WALLET_BALMZ_PRESALE_RECEIVING_ADDRESS`: the verified public Mainnet treasury address.
- `WORLD_WALLET_SOLANA_MAINNET_RPC_URL`: optional Mainnet RPC override.

Set them only after checking the address and production mint. Do not put these values or any secret keys in frontend variables, source control, or chat. The current backend endpoint is read-only: it reports readiness and observed balance but does not move funds or enable payments.

## Release gate

Before opening the presale, add and independently test settlement that verifies a finalized Mainnet payment, expected receiver, expected amount and supported asset, unique transaction signature/idempotency key, order allocation, and failure/refund handling. Confirm the deployed mint supply/decimals and revoke mint authority if the 1 billion supply is meant to be fixed. Keep Devnet activity separate from Mainnet history and Proof of Reserves.
