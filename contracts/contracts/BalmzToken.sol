// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "./BalmzReserveVesting.sol";

/**
 * BALMZ fixed-supply EVM token.
 *
 * Global production allocation:
 * Ethereum: 10B distribution + 1B locked reserve.
 * BNB Chain: 10B distribution.
 * Solana Mainnet: separate 10B SPL allocation.
 *
 * Sepolia is a separate 1B test deployment.
 */
contract BalmzToken is ERC20 {
    uint256 public constant GLOBAL_SUPPLY_TARGET = 31_000_000_000 ether;
    uint256 public constant ETHEREUM_DISTRIBUTION_SUPPLY = 10_000_000_000 ether;
    uint256 public constant BNB_DISTRIBUTION_SUPPLY = 10_000_000_000 ether;
    uint256 public constant SOLANA_MAINNET_ALLOCATION = 10_000_000_000 ether;
    uint256 public constant RESERVE_SUPPLY = 1_000_000_000 ether;
    uint256 public constant SEPOLIA_TEST_SUPPLY = 1_000_000_000 ether;

    uint256 public constant RESERVE_CLIFF_DURATION = 365 days;
    uint256 public constant RESERVE_VESTING_DURATION = 1095 days;

    address public constant RESERVE_RECIPIENT =
        address(uint160(0x00bbdb482ae0895e496676ec84501d2945a404ff2c));

    uint256 public immutable INITIAL_SUPPLY;
    uint256 public immutable RESERVE_MINTED_SUPPLY;
    address public immutable RESERVE_VESTING_WALLET;

    constructor() ERC20("BALMZ Token", "BALMZ") {
        if (block.chainid == 1 || block.chainid == 31337) {
            if (block.chainid == 1) {
                require(
                    msg.sender == RESERVE_RECIPIENT,
                    "Deploy with the approved OKX reserve EOA"
                );
            }

            INITIAL_SUPPLY = ETHEREUM_DISTRIBUTION_SUPPLY + RESERVE_SUPPLY;
            RESERVE_MINTED_SUPPLY = RESERVE_SUPPLY;

            BalmzReserveVesting vesting = new BalmzReserveVesting(
                address(this),
                RESERVE_RECIPIENT,
                block.timestamp,
                RESERVE_CLIFF_DURATION,
                RESERVE_VESTING_DURATION,
                RESERVE_SUPPLY
            );

            RESERVE_VESTING_WALLET = address(vesting);

            _mint(msg.sender, ETHEREUM_DISTRIBUTION_SUPPLY);
            _mint(address(vesting), RESERVE_SUPPLY);

        } else if (block.chainid == 56) {
            require(
                msg.sender == RESERVE_RECIPIENT,
                "Deploy with the approved OKX reserve EOA"
            );

            INITIAL_SUPPLY = BNB_DISTRIBUTION_SUPPLY;
            RESERVE_MINTED_SUPPLY = 0;
            RESERVE_VESTING_WALLET = address(0);

            _mint(msg.sender, BNB_DISTRIBUTION_SUPPLY);

        } else if (block.chainid == 11155111) {
            INITIAL_SUPPLY = SEPOLIA_TEST_SUPPLY;
            RESERVE_MINTED_SUPPLY = 0;
            RESERVE_VESTING_WALLET = address(0);

            _mint(msg.sender, SEPOLIA_TEST_SUPPLY);

        } else {
            revert("Unsupported BALMZ deployment chain");
        }
    }
}
