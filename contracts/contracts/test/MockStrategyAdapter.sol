pragma solidity ^0.8.34;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockStrategyAdapter {
    using SafeERC20 for IERC20;

    mapping(address => uint256) public totalManagedByAsset;

    function deposit(address asset, uint256 amount) external returns (uint256 depositedAmount) {
        require(amount > 0, "Amount must be > 0");
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        totalManagedByAsset[asset] += amount;
        return amount;
    }

    function withdraw(address asset, uint256 amount, address recipient) external returns (uint256 withdrawnAmount) {
        require(recipient != address(0), "Invalid recipient");
        require(totalManagedByAsset[asset] >= amount, "Insufficient managed balance");
        totalManagedByAsset[asset] -= amount;
        IERC20(asset).safeTransfer(recipient, amount);
        return amount;
    }
}
