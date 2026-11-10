// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * Immutable BALMZ reserve vesting.
 * 365-day cliff, followed by 1,095 days of linear vesting.
 * No owner, administrator, revocation, or alternate withdrawal.
 */
contract BalmzReserveVesting {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public immutable beneficiary;

    uint256 public immutable startTimestamp;
    uint256 public immutable cliffTimestamp;
    uint256 public immutable vestingEndTimestamp;
    uint256 public immutable totalAllocation;

    uint256 public released;

    constructor(
        address token_,
        address beneficiary_,
        uint256 startTimestamp_,
        uint256 cliffDuration_,
        uint256 vestingDuration_,
        uint256 allocation_
    ) {
        require(token_ != address(0), "Invalid token");
        require(beneficiary_ != address(0), "Invalid beneficiary");
        require(startTimestamp_ != 0, "Invalid start");
        require(cliffDuration_ != 0, "Invalid cliff");
        require(vestingDuration_ != 0, "Invalid duration");
        require(allocation_ != 0, "Invalid allocation");

        token = IERC20(token_);
        beneficiary = beneficiary_;
        startTimestamp = startTimestamp_;
        cliffTimestamp = startTimestamp_ + cliffDuration_;
        vestingEndTimestamp = cliffTimestamp + vestingDuration_;
        totalAllocation = allocation_;
    }

    function vestedAmount(uint256 timestamp)
        public
        view
        returns (uint256)
    {
        if (timestamp < cliffTimestamp) {
            return 0;
        }

        if (timestamp >= vestingEndTimestamp) {
            return totalAllocation;
        }

        return
            (totalAllocation * (timestamp - cliffTimestamp)) /
            (vestingEndTimestamp - cliffTimestamp);
    }

    function releasable() public view returns (uint256) {
        return vestedAmount(block.timestamp) - released;
    }

    // Anyone may trigger release; the recipient can never be changed.
    function release() external {
        uint256 amount = releasable();
        require(amount > 0, "Nothing releasable");

        released += amount;
        token.safeTransfer(beneficiary, amount);
    }
}
