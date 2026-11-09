# Ethereum Wallet Safety Layer

This module adds a read-only Ethereum transaction inspection page to World Wallet AI.

## Included

- Ethereum Mainnet (chain ID 1) and Sepolia (chain ID 11155111) network matching.
- EVM sender and recipient address validation and checksum normalization.
- ETH value parsing with 18-decimal precision checks.
- Calldata format validation and basic recognition of common ERC-20/ERC-721 methods.
- Warnings for token approvals, operator approvals, unknown selectors, and ETH value combined with contract calldata.
- Read-only contract bytecode lookup at the destination using the connected wallet's provider.
- Automated unit tests.

## Safety boundary

The page only requests wallet account access and performs read-only RPC calls: eth_accounts, eth_chainId, and eth_getCode. It does not call eth_sendTransaction, personal_sign, eth_sign, or any signing method. It does not create approvals, move funds, store keys, or guarantee transaction safety.

This is a first-pass inspector, not a full EVM simulator or audit. It does not decode arbitrary ABI calls, inspect proxy implementation logic, evaluate off-chain signatures, simulate state changes, or detect every malicious contract. Users must review the wallet's confirmation screen and independently verify important addresses and calldata.

## Local verification

From apps/web:

```bash
node --test src/wallet-safety.test.js
npm run build
```
