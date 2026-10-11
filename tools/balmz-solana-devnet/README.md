# BALMZ on Solana Devnet — guarded Termux workflow

This folder prepares a **test-only** classic SPL token with:

- Name in the app: BALMZ (classic SPL mint accounts do not themselves store a token name or symbol)
- Initial supply: 1,000,000,000 tokens
- Decimals: 9
- Network: Solana Devnet only
- Initial recipient: a public Solana address you provide, such as the address shown by Phantom while testing

**Nothing is created on-chain by installing dependencies, preparing keypairs, or running the default dry-run.** Token creation requires the explicit `--execute-devnet` flag and typing `CREATE BALMZ DEVNET TOKEN` interactively. The RPC endpoint is hard-pinned to Devnet; there is no mainnet mode in this script.

## Termux preparation

Run these commands in Termux after the repair-branch changes are available:

```bash
cd ~/world-wallet-ai || exit 1
git switch repair/neon-auth-wallet-safety
git pull --ff-only origin repair/neon-auth-wallet-safety
cd tools/balmz-solana-devnet || exit 1
npm install
npm run dry-run
```

The dry run prints the proposed settings and sends no transaction.

## Generate local Devnet keypairs

```bash
npm run prepare
```

This generates a payer keypair and a candidate mint keypair under `.local/`. It makes no network request and sends no transaction. The candidate mint public key is **not a live token address** until its mint account is created on-chain.

The keypair files are ignored by Git. Do not upload them, commit them, paste their contents into chat, or send them to anyone. Keep a secure backup of the payer keypair: it becomes the mint authority and is needed to mint more tokens or change mint authority later. Do not delete the local files until you have deliberately decided how to manage authority and backups.

## Fund the Devnet payer

Copy only the payer **public address** printed by the prepare command. Request test SOL from the official faucet:

https://faucet.solana.com/

Use Devnet only. This payer keypair is separate from your Phantom wallet. The script will not request an airdrop automatically.

## Choose the Phantom recipient

Use the public Solana address shown by Phantom. Ensure Phantom is configured for Solana Devnet/testnet for your testing. The address is public; never provide a recovery phrase or private key.

First, review the dry-run output with the recipient address:

```bash
node create-balmz-devnet.mjs --recipient YOUR_PHANTOM_PUBLIC_SOLANA_ADDRESS
```

This command is still a dry run and does not send a transaction.

## Actual Devnet creation — do not run until explicitly approved

The following command submits on-chain transactions to Devnet. It is documented here for later use only:

```bash
node create-balmz-devnet.mjs --execute-devnet --recipient YOUR_PHANTOM_PUBLIC_SOLANA_ADDRESS
```

The script then asks for the exact confirmation phrase `CREATE BALMZ DEVNET TOKEN`. If it is not entered exactly, it exits without sending transactions. The payer must already have at least 0.05 Devnet SOL.

The script creates the mint, creates the recipient's associated token account if needed, and mints the initial supply. It checks existing mint state and refuses to mint a second supply if it detects a previous successful run. A partially completed attempt can leave a mint on Devnet; reruns inspect existing state before proceeding.

## Important limitations before token creation

1. This creates a **classic SPL Token mint**, not a branded production token. Metaplex name, symbol, logo, and metadata URI are a separate decision and are not included in this initial script.
2. Mint authority remains with the local payer keypair. Supply is therefore not permanently fixed until authority is deliberately revoked; do not revoke it before deciding how the token will be administered.
3. Devnet BALMZ is a test token with no implied market value. It is separate from BALMZ on Ethereum and BALMZ-SEP on Sepolia.
4. World Wallet AI stores `solana-devnet` addresses separately from `solana` mainnet addresses. Devnet holdings are not added to production portfolio totals.
5. This workflow does not deploy World Wallet AI, modify production services, or use any existing Ethereum/Binance wallet private key.
