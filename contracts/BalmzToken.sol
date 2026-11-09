// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * BALMZ fixed-supply EVM token.
 *
 * Production allocations are part of one global 31,000,000,000 BALMZ plan:
 * - Ethereum Mainnet: 10,000,000,000 distribution + 1,000,000,000 reserve.
 * - BNB Chain Mainnet: 10,000,000,000 distribution.
 * - Solana Mainnet: 10,000,000,000 SPL allocation (separate mint/program).
 *
 * Sepolia is a separate 1,000,000,000-token test deployment and is excluded
 * from global Mainnet supply. Solana Devnet tokens are also test assets.
 *
 * The reserve is deliberately assigned to the user's existing OKX EOA.
 * No public mint, owner, pause, or upgrade function exists.
 */
contract BalmzToken is ERC20 {
    uint256 public constant GLOBAL_SUPPLY_TARGET = 31_000_000_000 ether;
    uint256 public constant ETHEREUM_DISTRIBUTION_SUPPLY = 10_000_000_000 ether;
    uint256 public constant BNB_DISTRIBUTION_SUPPLY = 10_000_000_000 ether;
    uint256 public constant SOLANA_MAINNET_ALLOCATION = 10_000_000_000 ether;
    uint256 public constant RESERVE_SUPPLY = 1_000_000_000 ether;
    uint256 public constant SEPOLIA_TEST_SUPPLY = 1_000_000_000 ether;

    // Existing OKX EOA approved as the BALMZ reserve recipient.
    address public constant RESERVE_RECIPIENT =
        0xbbdb482ae0895e496676ec84501d2945a404ff2c;

    // Chain-specific immutable supply minted once during construction.
    uint256 public immutable INITIAL_SUPPLY;

    constructor() ERC20("BALMZ Token", "BALMZ") {
        if (block.chainid == 1 || block.chainid == 31337) {
            // 31337 is only the local Hardhat test chain.
            if (block.chainid == 1) {
                require(
                    msg.sender == RESERVE_RECIPIENT,
                    "Deploy with the approved OKX reserve EOA"
                );
            }

            INITIAL_SUPPLY = ETHEREUM_DISTRIBUTION_SUPPLY + RESERVE_SUPPLY;
            _mint(msg.sender, ETHEREUM_DISTRIBUTION_SUPPLY);
            _mint(RESERVE_RECIPIENT, RESERVE_SUPPLY);
        } else if (block.chainid == 56) {
            require(
                msg.sender == RESERVE_RECIPIENT,
                "Deploy with the approved OKX reserve EOA"
            );
            INITIAL_SUPPLY = BNB_DISTRIBUTION_SUPPLY;
            _mint(msg.sender, BNB_DISTRIBUTION_SUPPLY);
        } else if (block.chainid == 11155111) {
            // Sepolia test tokens never count toward the Mainnet allocation.
            INITIAL_SUPPLY = SEPOLIA_TEST_SUPPLY;
            _mint(msg.sender, SEPOLIA_TEST_SUPPLY);
        } else {
            revert("Unsupported BALMZ deployment chain");
        }
    }
}
