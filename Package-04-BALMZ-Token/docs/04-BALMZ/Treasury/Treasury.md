# BALMZ Treasury and Reserve Policy

## Ethereum reserve defined in source

The EVM contract source defines:
- reserve allocation: 1,000,000,000 BALMZ;
- beneficiary: the immutable `RESERVE_RECIPIENT` constant in `BalmzToken.sol`;
- holding contract: a separate `BalmzReserveVesting` deployed during Ethereum token construction;
- schedule: 365-day cliff, then 1,095 days of linear vesting;
- no owner, administrator, revocation, alternate recipient, or arbitrary withdrawal function.

The reserve is part of Ethereum's 11B supply and the global 31B allocation. It is not a second mint or extra allocation.

This source configuration is not evidence that the beneficiary address is under the user's control, that a deployment has occurred, or that a vesting contract is live. Before any Mainnet transaction, independently confirm the exact beneficiary address and deployment signer in the wallet UI and in the approved release record.

## BNB Chain and Solana

The source allocates 10B BALMZ to BNB Chain distribution. It does not define an additional BNB reserve-vesting contract.

The 10B Solana allocation is a planned SPL mint allocation with 9 decimals. Its Mainnet mint and treasury/authority configuration remain pending verification. Do not publish or configure a treasury address until the project has proven control and documented the custody model.

## Treasury operating controls

Before any treasury or liquidity movement:
- use an approved multisig or a documented separation of duties where practical;
- record purpose, amount, asset, chain, destination, approver and transaction hash;
- test recipient and chain values with read-only checks before signing;
- use independent transaction review and clear user-readable wallet prompts;
- reconcile on-chain balances after finality;
- prohibit private keys, recovery phrases and wallet exports from source control, CI logs, chat, and analytics;
- maintain an incident response and lost-key process.

Never call a wallet "project treasury" solely because it has a positive balance or appears in an explorer. Balance does not establish ownership or authorization.
