# Token Interaction Audit

The Token Interaction Audit is a read-only discovery feature for EVM addresses attached to the signed-in user's active World Wallet.

## API

`GET /api/v1/wallet/token-interactions`

Query parameters:

- `networks`: comma-separated subset of `ethereum,bnb,sepolia`. Defaults to all three; the testnet remains identified separately.
- `page`: 1-based Etherscan ERC-20 transfer-history page (1–100).
- `offset`: transfer-history page size (1–1000).
- `approval_from_block`: starting block for Approval event logs (default 0).
- `approval_to_block`: ending block or `latest` (default `latest`).

The endpoint does not accept an arbitrary address. It loads addresses from the authenticated user's active wallet and queries only EVM addresses whose `ownership_verified` value is true. Unverified addresses are returned as skipped entries without being scanned.

## Data returned

For each verified wallet address, the endpoint returns:
- Etherscan-indexed ERC-20 transfer events, with raw integer amounts and exact decimal-string amounts where token precision is available.
- Historical ERC-20 `Approval(address,address,uint256)` logs, including owner, spender, token contract and the raw approved amount.
- Current allowance reads for up to 50 distinct token/spender pairs from a chain-identity-verified RPC. A historical Approval event is not evidence of the current allowance.
- A separate EIP-7702 delegation inspection, with chain ID verified against the configured RPC.

## Provider limits

- Etherscan's account `tokentx` endpoint documents a maximum of the last 10,000 transaction records for an address. Transfer pages beyond the provider's indexed range cannot establish older history.
- Etherscan's `logs/getLogs` endpoint documents a maximum of 1,000 returned logs per query. The UI exposes a block range so a capped result can be narrowed and rescanned. Approval logs do not use the token-transfer page cursor.
- Etherscan and RPC indexing is not a proof of complete history across every token standard, private transaction system, or chain indexer. NFT approvals, Permit signatures, native transfers and off-indexer records are outside this ERC-20 audit.

## Claim safety

The endpoint does not identify a token transfer or allowance as a claimable BALMZ allocation. Claim execution stays disabled unless each supported network has a verified claim contract, a trusted allocation source, an exact claim amount, replay protection and an audited wallet-signature/batch-execution path.

An EIP-7702 delegation, an ERC-20 allowance, a Gmail message, a GitHub event or a transfer record does not independently authorize a token claim or withdrawal.

The feature never requests a seed phrase or private key, changes token allowances, signs a transaction, broadcasts a transaction or credits the wallet ledger.
