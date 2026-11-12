# BALMZ Token Overview

## Identity

- **Name:** BALMZ Token
- **Symbol:** BALMZ
- **Networks planned:** Ethereum Mainnet, BNB Chain Mainnet, and Solana Mainnet
- **Status:** Pre-launch. This document describes the approved design; it is not evidence that all three production deployments are live.
- **Global production allocation target:** 31,000,000,000 BALMZ.

BALMZ is a fixed-supply, multi-chain token project. Its production allocations are separated by network and must be accounted for as one global allocation. There is no automatic bridge or cross-chain transfer mechanism in the reviewed EVM contracts.

## Network design

| Network | Token standard | Planned decimals | Allocation |
|---|---|---:|---:|
| Ethereum Mainnet | ERC-20 | 18 | 10B liquid distribution + 1B vesting reserve |
| BNB Chain Mainnet | BEP-20-compatible ERC-20 | 18 | 10B distribution |
| Solana Mainnet | SPL Token | 9 | 10B allocation |

The 1B Ethereum reserve is included in the global 31B total. The initial 1B Solana presale tranche described in the presale runbook is a tranche within the 10B Solana allocation, not additional supply.

Sepolia's 1B test deployment and local Hardhat deployments are test environments and are excluded from production supply.

## Contract and authority principles

The EVM source uses fixed, chain-specific supply at construction and has no public mint, owner, pause, proxy, or upgrade method. Ethereum also creates an immutable reserve-vesting contract. BNB Chain does not receive that Ethereum vesting reserve.

The Solana Mainnet mint/program must be implemented and independently verified before that allocation can be treated as deployed. The intended 9 decimals and final mint/freeze authority settings must be confirmed on-chain.

## Utility, governance and value

This overview does not promise yield, staking rewards, guaranteed returns, redemption, or a fixed market price. Any utility, governance right, staking program, or commercial use must be documented only after it is implemented, reviewed, and available.

Market price is not set by token name, metadata, a wallet display, or an announced target. It is determined by actual market activity and available liquidity.

## Current release state

BALMZ is **not ready to be described as fully launched or listed**. The chain registry, explorer verification, approved logo/metadata publication, public token website, real liquidity evidence, and independent security audit remain release gates. See [BALMZ Release Readiness](../../../docs/BALMZ-RELEASE-READINESS.md).
