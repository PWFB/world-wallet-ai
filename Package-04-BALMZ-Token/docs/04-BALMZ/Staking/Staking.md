# BALMZ Staking

## Current status

**No production BALMZ staking contract or live rewards program is documented.** The token must not be marketed as earning staking yield, fixed APY, guaranteed rewards, or passive income.

The fixed-supply EVM token has no staking, reward minting, or yield-distribution function. Testnet balances and mining-session points are not production staking rewards.

## Requirements before a staking launch

A separately reviewed staking system would need to define:
- whether rewards are funded from a disclosed preallocated reserve or another lawful source;
- reward rate, duration, reward cap, eligibility and end-of-program behavior;
- lock-up, unbonding, early-exit and slashing rules, if any;
- custody model, withdrawal rights and emergency controls;
- accounting for rounding, precision, paused networks and failed transactions;
- independent security review and public contract verification.

Do not add a staking contract that can mint unbounded BALMZ or silently exceed the 31B global allocation. Keep this feature disabled until tokenomics, legal review and audit are complete.
