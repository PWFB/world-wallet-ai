# BALMZ Release Readiness

Last reviewed: 2026-11-12  
Repository baseline: `main` at `f96724f5a57546f8448d797d43e279adabcbc3bd`  
Status: **PRE-LAUNCH — DO NOT ANNOUNCE AS LIVE OR LISTED**

This is the release-control record for BALMZ. It distinguishes checked-in source and approved allocation policy from actions that require a wallet signature, real assets, external verification, or an independent auditor.

## Executive status

| Workstream | Current evidence | Status |
|---|---|---|
| 1. Token contracts | EVM Solidity token and immutable reserve vesting sources exist. No production deployment manifest was found in the repository tree. No Solana Mainnet mint program/deployment artifact was found in the inspected tree. | **PARTIAL** |
| 2. Supply and mint policy | The source defines a 31,000,000,000 BALMZ global allocation target. EVM supply is fixed per allowed chain. The Solana 10B allocation still needs an implemented and verified Mainnet mint with 9 decimals and final authority settings. | **POLICY DEFINED; IMPLEMENTATION PARTIAL** |
| 3. Explorer verification | No Ethereum, BNB Chain, or Solana Mainnet contract/mint address plus verified explorer evidence is recorded in the checked-in release registry. | **PENDING** |
| 4. Logo and metadata | Name, symbol, and intended decimals are specified in source/docs. An approved production logo, immutable image URL, canonical token metadata URI, and published metadata record are not evidenced. | **PARTIAL** |
| 5. Website and documentation | This documentation set describes the token, supply, contracts, reserve, governance limitations, staking status, roadmap, and release gates. A dedicated public BALMZ website and its ownership/canonical URL are not evidenced here. | **DOCS IN PROGRESS** |
| 6. Liquidity and trading | No verified pool address, pool reserves, LP ownership/lock evidence, or market is recorded. A target quote is not a guaranteed price. | **PENDING — NO LIQUIDITY CLAIM** |
| 7. Security | Solidity tests and a contract-check workflow exist. No independent third-party audit report or completed Mainnet security sign-off is recorded. | **PARTIAL — AUDIT REQUIRED** |

## 1. Contract readiness

### EVM contracts present

- `contracts/contracts/BalmzToken.sol`
- `contracts/contracts/BalmzReserveVesting.sol`
- Solidity compiler target: 0.8.24
- OpenZeppelin Contracts: 5.6.1, pinned in the contract package manifest/lockfile
- EVM deployment is restricted to chain IDs 1 (Ethereum), 56 (BNB Chain), 11155111 (Sepolia testnet), and 31337 (local Hardhat). Unsupported chain IDs revert.
- Ethereum and BNB Mainnet deployment require the configured fixed reserve recipient address. This must be reviewed in the wallet UI before any deployment signature.

### Missing/unchecked items

- No verified Ethereum or BNB Mainnet deployment addresses/receipts/source-verification URLs are recorded in this repository.
- No Solana Mainnet mint/program implementation or deployment proof was found in the inspected repository tree. The known Devnet mint is test-only and must not be reused on Mainnet.
- A source file is not proof that a contract was deployed, verified, audited, or that its supply is circulating.

**Release gate:** do not announce a chain as live until its exact chain ID, address, deployment transaction, observed decimals/supply, authority state, and explorer source/metadata verification have been recorded.

## 2. Approved production supply policy

| Allocation | Production allocation |
|---|---:|
| Ethereum Mainnet liquid distribution | 10,000,000,000 BALMZ |
| Ethereum reserve vesting | 1,000,000,000 BALMZ |
| BNB Chain Mainnet distribution | 10,000,000,000 BALMZ |
| Solana Mainnet allocation | 10,000,000,000 BALMZ |
| **Global target / maximum allocation** | **31,000,000,000 BALMZ** |

Decimals:
- Ethereum and BNB Chain ERC-20: 18
- Solana Mainnet SPL: 9 (must be implemented and verified before production release)

The Ethereum reserve is already included in the 31B total; it is not extra supply. The 1B initial Solana presale tranche described in the presale runbook is part of the 10B Solana allocation, not additional supply. Sepolia's 1B test deployment and local Hardhat test deployments are excluded from production totals.

The EVM contracts have no public mint, owner, pause, proxy, or upgrade entry point. The Solana Mainnet mint authority decision must be implemented and verified; if the production supply is fixed, mint authority must be revoked after the intended 10B has been minted. Freeze authority must be separately decided and publicly disclosed; do not revoke or retain it by assumption.

## 3. Explorer verification record

Record one row per production chain after deployment:

| Network | Chain ID / cluster | Token / mint address | Deployment signature | Observed supply | Decimals | Authority state | Explorer source/metadata link |
|---|---|---|---|---:|---:|---|---|
| Ethereum Mainnet | 1 | Not recorded | Not recorded | Not verified | 18 planned | Fixed-supply contract source; on-chain state pending | Pending |
| BNB Chain Mainnet | 56 | Not recorded | Not recorded | Not verified | 18 planned | Fixed-supply contract source; on-chain state pending | Pending |
| Solana Mainnet | Mainnet-beta | Not recorded | Not recorded | Not verified | 9 planned | Pending implementation/verification | Pending |

Do not substitute a Devnet mint, Sepolia contract, personal wallet, token account, or reserve/vesting address for a production token contract address.

## 4. Metadata publication checklist

Canonical token identity:
- Name: **BALMZ Token**
- Symbol: **BALMZ**
- EVM decimals: **18**
- Solana Mainnet decimals: **9**
- Description: **BALMZ is a fixed-supply, multi-chain digital token with separately accounted Ethereum, BNB Chain, and Solana allocations.**
- Market price: **Not established**
- Guaranteed return / APY: **None**
- Official website, logo image URL, and canonical metadata URI: **Not yet evidenced; must be supplied and published before wallet/listing submissions.**

Publish the same approved name/symbol/description and approved artwork everywhere. Keep chain-specific contract/mint addresses distinct. Never use a testnet mint in production metadata. After publication, fetch the hosted JSON and image back from a clean, unauthenticated session and record the content URL and content hash.

## 5. Website and documentation

The token documentation is being completed in `Package-04-BALMZ-Token/docs/04-BALMZ/`. A dedicated public project website still needs a canonical domain, project-controlled hosting, privacy/contact disclosures, risk statement, contract registry, and a public link to the security report. Do not treat the World Wallet AI application as a substitute for a dedicated token information page unless the project explicitly adopts that role.

Required public content before listing applications:
- project description and real utility (only functionality that exists);
- chain-by-chain contract registry;
- supply and vesting schedule;
- governance status (including the fact that no DAO/voting contract is presently documented);
- risk and volatility disclosure, no guaranteed returns;
- security review/audit report and contact channel;
- privacy policy and terms appropriate to the actual product and jurisdictions.

## 6. Liquidity and trading controls

No liquidity is established by this repository review. Before a public trading announcement, record:
- DEX and exact pool address on each supported chain;
- pool token pair and initial amounts funded;
- transaction hashes and observed reserves after finality;
- LP token/NFT owner and whether the position is locked, timelocked, or retained;
- any market-maker or treasury authority and the conflict-of-interest disclosure;
- a monitoring and incident response process.

Do not advertise a price, depth, exchange listing, or liquidity lock without independently checkable evidence. The previously documented target of 1 BALMZ-SOL = 1 SOL is a target only; it is not a guaranteed market price and needs a disclosed mechanism and sufficient funded liquidity. Do not create a pool, approve a router, or transfer treasury assets without explicit owner review and approval.

## 7. Security and launch sign-off

The existing Solidity unit tests and GitHub Actions contract workflow are useful automated checks, not an independent audit. Before launch:
- run `npm ci`, `npm run compile`, and `npm test` from `contracts/` on the exact release commit;
- retain the complete CI run link and compiler output;
- independently review constructor chain guards, fixed allocations, vesting math, and the absence of privileged mint/upgrade controls;
- verify deployment signer, chain ID, constructor outcome, supply and vesting recipient using a second read-only RPC/explorer;
- perform adversarial review for malicious tokens, replay/duplicate payments, wrong-chain payments, under/overpayment, failed settlement, decimals confusion, and UI price fabrication;
- complete an independent audit by a named, qualified third party and publish its scope, commit hash, report, and remediation status;
- perform a final owner-controlled wallet review before any Mainnet transaction.

Do not label the token "audited" until a report for the exact deployed source/commit exists and all critical/high findings are resolved or transparently disclosed.

## Release decision

**Current decision: NO-GO for public launch, liquidity opening, presale payment acceptance, or listing submission.**

This no-go is not a statement that the source code is unusable; it reflects missing production Solana implementation/proofs, missing chain deployment records, missing public metadata/website evidence, missing funded-liquidity evidence, and missing independent audit sign-off.

The release owner can move a gate to PASS only by adding reproducible evidence to this file and the chain registry. Never replace missing evidence with an estimate, screenshot of an unverified wallet, an off-chain balance, or a promotional claim.
