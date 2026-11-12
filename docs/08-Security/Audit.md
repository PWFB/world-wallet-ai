# BALMZ and Platform Security Review

## Review status

This document is a security review plan and evidence register, **not an independent audit certificate**. The repository contains Solidity unit tests and a GitHub Actions contract-check workflow, but no third-party audit report for the production deployment is recorded here.

## Contract review scope

Review the exact release commit and, after deployment, match it to the verified explorer source.

### EVM token invariants
- only approved chain IDs deploy;
- Ethereum and BNB Mainnet require the configured approved deployment signer;
- each chain mints only its specified initial supply;
- no public mint, owner, pause, proxy or upgrade function exists;
- total supply cannot increase after construction;
- Ethereum's vesting contract token and beneficiary are immutable.

### Vesting invariants
- no amount is vested before the 365-day cliff;
- vesting begins at zero exactly at the cliff and accrues linearly over the following 1,095 days;
- total release never exceeds the 1B allocation;
- all releases go only to the fixed beneficiary;
- third parties may trigger release but cannot redirect tokens.

### Solana release scope
The Solana Mainnet implementation is not present in the inspected source tree. Before adding it, specify the Token Program/Token-2022 choice, metadata program, 9 decimals, exact mint authority lifecycle, freeze authority policy, allocation controls, custody and recovery expectations. Review the final on-chain state after deployment. Do not assume the Devnet mint is the production mint.

## Application and operational threat model

The release review must include:
- wrong-network and wrong-token address substitution;
- decimals mismatch and unit conversion errors;
- misleading wallet labels and unverified token metadata;
- fake prices, stale RPC responses and unsupported market pairs;
- duplicate/replayed payment signatures;
- wrong recipient, wrong asset, underpayment, overpayment and failed/expired settlement;
- unauthorized signer, compromised wallet, unsafe recovery phrase storage and leaked API secrets;
- compromised dependency, build provenance and deployment pipeline;
- treasury concentration, liquidity withdrawal and privileged pool control.

## Automated checks

From `contracts/` run on the exact release commit:

```sh
npm ci
npm run compile
npm test
```

Capture the command output and GitHub Actions run URL. A passing test suite covers only its assertions; it does not prove that production deployment, external integrations, private key management, liquidity, metadata, or all threat scenarios are secure.

## Third-party audit requirements

Before public launch, obtain an independent review that records:
- auditor identity and relevant experience;
- scope, repositories, commit hash and deployed addresses;
- tools and methodology;
- findings with severity and reproducible details;
- remediation evidence and retest status;
- explicit residual risks and exclusions.

Do not use the words "audited", "certified", or "secure" as an absolute claim until the exact release has an independently verifiable report. Critical/high findings must be resolved or explicitly disclosed before launch.
