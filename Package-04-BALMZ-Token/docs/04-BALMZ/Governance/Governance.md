# BALMZ Governance

## Current status

**No on-chain DAO or token-voting contract is documented as deployed.** BALMZ must not be represented as granting voting rights, protocol control, or governance participation unless a separate governance mechanism is implemented and its rules are published.

The EVM token contract is a fixed-supply ERC-20 implementation. It does not include governance, delegation, proposal, quorum, or vote-counting functions.

## Interim project decisions

Until a formal governance system is adopted:
- project and release decisions must be made by the project owners under documented internal controls;
- treasury movements, contract deployments, liquidity actions and listing submissions require explicit authorized approval;
- material changes to supply policy, treasury policy, token utility or contract addresses must be publicly documented before implementation;
- no administrator should imply that token holders have governance rights that the deployed contracts do not provide.

## Requirements before introducing on-chain governance

A governance proposal must define:
1. decision scope and actions permitted;
2. token/voting-power snapshot rules and resistance to flash-loan or borrowed voting power;
3. proposal threshold, quorum, voting period and approval threshold;
4. timelock, execution controls and emergency protections;
5. conflict-of-interest, treasury, signer and delegation disclosures;
6. contract audit, deployment addresses, and migration/upgrade limitations.

Do not add governance to the fixed-supply token contract by proxy or upgrade. Any future governance system should be a separately reviewed component and must not create an unapproved mint or supply expansion route.
