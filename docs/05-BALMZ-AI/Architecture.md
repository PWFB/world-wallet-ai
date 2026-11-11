# BALMZ AI architecture

## Product boundary

BALMZ AI is the intelligence layer inside World Wallet AI. It explains verified wallet state and retrieved market information; it is not a custodian, exchange, price oracle, signer, presale settlement engine, or token issuer.

## Runtime components

- React web app — BALMZ AI dashboard, market scanner, wallet connection context, and user prompt interface.
- FastAPI service — POST /api/v1/balmz-ai/ask authenticates the signed-in account and calls the configured Google Gemini model.
- Google Gemini — API key is read only from the backend environment. It is never included in Vite variables or returned to the browser.
- Market data — scanner reads token pair data from DexScreener. A returned pair is a market-data observation, not a verified token audit or a guaranteed price.
- Wallet context — passed to the AI only when the user explicitly enables wallet context. The backend includes only allow-listed asset/network names and balance fields from the ownership-verified wallet snapshot. Addresses, signatures, private keys, recovery material and transaction credentials are excluded.

## Evidence and safety rules

- Do not invent balances, prices, liquidity, contract verification or transaction status.
- Show unavailable values as unavailable, not as zero.
- Distinguish chain balances, internal ledger balances, pending mining allocations, testnet values and market quotes.
- Testnet balances and activity are excluded from Mainnet reporting and proof of reserves.
- AI output is explanatory text. It cannot authorize a wallet action or attest to a transaction.
- Do not prompt users for passwords, private keys, seed phrases or PINs.

## BALMZ supply policy

The approved global maximum is 31,000,000,000 BALMZ:
- Ethereum Mainnet distribution: 10,000,000,000.
- BNB Chain Mainnet distribution: 10,000,000,000.
- Solana Mainnet allocation: 10,000,000,000.
- Approved Ethereum reserve/vesting allocation: 1,000,000,000.

The initial Solana presale tranche is 1,000,000,000 BALMZ included inside the 10-billion Solana allocation. It is not an additional supply. The remaining 9 billion stays within the Solana allocation and is not part of the initial tranche. Sepolia and Solana Devnet token supplies are test-only and excluded from the global Mainnet total.

The API's Solana Mainnet readiness check compares finalized mint supply against the full 10-billion Solana allocation (9 decimals). A mint/treasury readiness result is read-only and does not enable presale payment acceptance. The presale stays disabled until the production mint, treasury ownership, finalized payment verification, replay protection, allocation handling, refund path, liquidity disclosures and regression checks are complete.

## Mining model

Free BALMZ Mining is an off-chain session and pending-reward ledger. The current implementation records eligible three-hour cycles at 0.5 BALMZ per cycle with a four-BALMZ daily cap. These are pending launch allocations only. No BALMZ is minted, transferred, claimable or spendable, and the system is not performing proof-of-work or blockchain mining. A global funded reward-pool cap and audited claim/settlement contract are release blockers before rewards can become transferable.

## Signing and verification model

The Wallets page supports signing a personal message and EIP-712 typed data with a wallet unlocked from the encrypted World Wallet AI local vault. The local signer never uploads its private key; the app immediately verifies the EOA signer recovered from its message/typed-data signature.

The verifier checks 65-byte EOA message and EIP-712 signatures with ECDSA recovery. It also supports read-only EIP-1271 verification by calling isValidSignature(bytes32,bytes) on the selected EVM network and requiring the 0x1626ba7e magic value. The verified ABI published for the user's OKX WalletCore implementation at 0x80296FF8D1ED46f8e3C7992664D13B833504c2Bb includes this method; a real valid signature still must be supplied to prove the account returns the acceptance value in its current storage/validator state. This verifies a signature already supplied to World Wallet AI; it does not create signatures for an external wallet. The existing external OKX smart wallet remains external-key controlled. World Wallet AI must not import its seed phrase or private key. A signing request for that external wallet still requires an authorized key/validator path; an EIP-1271 verification call cannot bypass wallet authorization. A local vault key cannot sign as the external 0xbb address. Live verification against the user's deployed 0xbb delegation remains a separate test; generic EIP-1271 helper tests do not establish that deployment-specific signature compatibility.

## Authentication and email

Neon Auth manages Google OAuth, email/password, email OTP and password-reset tokens. The production Auth branch has Google OAuth registered, email verification required, OTP mail enabled and session revocation on password reset. The shared Neon Auth email sender handles customer verification, OTP and password-reset email.

Gmail SMTP is a separate backend channel used for Super Admin PIN-recovery approval messages. Its credentials remain server-side. Customer Gmail-branded auth mail requires a custom SMTP provider for Neon Auth and a successful delivery test; do not confuse the admin recovery sender with the customer auth sender.
