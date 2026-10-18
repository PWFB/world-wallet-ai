// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * BALMZ Token
 *
 * Fixed-supply ERC-20.
 * - No owner-only mint function.
 * - No hidden balance mapping.
 * - Standard transfer/approve/transferFrom semantics.
 * - The complete initial supply is assigned to the deployer.
 */
contract BalmzToken is ERC20 {
    uint256 public constant INITIAL_SUPPLY = 1_000_000_000 ether;

    constructor() ERC20("BALMZ Token", "BALMZ") {
        _mint(msg.sender, INITIAL_SUPPLY);
    }
}
