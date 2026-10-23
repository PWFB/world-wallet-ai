#!/data/data/com.termux/files/usr/bin/bash
# Read-only Solana Mainnet treasury check. This script never signs or sends transactions.
set -eu

ADDRESS="${1:-}"
RPC_URL="${WORLD_WALLET_SOLANA_MAINNET_RPC_URL:-https://api.mainnet-beta.solana.com}"
EXPECTED_GENESIS="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"

if [ -z "$ADDRESS" ]; then
  echo "Usage: bash tools/balmz-solana-mainnet-check.sh YOUR_PUBLIC_SOLANA_ADDRESS"
  echo "Pass only a public address you control. Never pass a private key or recovery phrase."
  exit 2
fi

if ! printf '%s' "$ADDRESS" | grep -Eq '^[1-9A-HJ-NP-Za-km-z]{32,44}$'; then
  echo "STOP: The value does not look like a Solana public address."
  exit 2
fi

command -v curl >/dev/null 2>&1 || { echo "Missing curl. In Termux run: pkg install curl"; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "Missing jq. In Termux run: pkg install jq"; exit 2; }

rpc_call() {
  method="$1"
  params="$2"
  curl --fail --silent --show-error --max-time 20 \
    -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}" \
    "$RPC_URL"
}

echo "=== Verify RPC is Solana Mainnet ==="
GENESIS="$(rpc_call getGenesisHash '[]' | jq -er '.result')"
if [ "$GENESIS" != "$EXPECTED_GENESIS" ]; then
  echo "STOP: RPC genesis hash does not match Solana Mainnet."
  echo "Returned genesis hash: $GENESIS"
  exit 1
fi
echo "Network: Solana Mainnet (verified)"

echo
echo "=== Finalized SOL balance ==="
BALANCE_JSON="$(rpc_call getBalance "[\"$ADDRESS\",{\"commitment\":\"finalized\"}]")"
LAMPORTS="$(printf '%s' "$BALANCE_JSON" | jq -er '.result.value | numbers')"
SOL="$(jq -nr --arg lamports "$LAMPORTS" '($lamports|tonumber) / 1000000000')"
echo "Address: $ADDRESS"
echo "Finalized balance: $SOL SOL"

echo
echo "=== Account existence ==="
ACCOUNT_JSON="$(rpc_call getAccountInfo "[\"$ADDRESS\",{\"encoding\":\"base64\",\"commitment\":\"finalized\"}]")"
if printf '%s' "$ACCOUNT_JSON" | jq -e '.result.value != null' >/dev/null; then
  echo "Account: exists on Solana Mainnet"
  printf '%s' "$ACCOUNT_JSON" | jq -r '"Owner program: " + (.result.value.owner // "unknown")'
else
  echo "Account: not found on Solana Mainnet at finalized commitment"
fi

echo
echo "READ-ONLY CHECK COMPLETE."
echo "This does not prove wallet ownership, verify the BALMZ mint, enable the presale, or send funds."
echo "Do not configure the address as treasury until you independently confirm you control it."
