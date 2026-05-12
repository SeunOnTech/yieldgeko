// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title YieldGekoSwapper
 * @notice Universal DEX aggregator with on-chain slippage enforcement.
 *         The ERC-7710 AllowedTargets delegation only ever needs to whitelist THIS
 *         address — new DEXes are added without requiring users to re-sign.
 *
 * @dev Slippage is enforced on-chain via balance delta checks, not by trusting
 *      the calldata minAmountOut parameter of the DEX itself. The agent specifies
 *      _minAmountOut and this contract verifies it was satisfied post-execution.
 *
 * @dev Swap flow:
 *      Agent → DelegationManager.redeemDelegations() → User SmartAccount
 *        → YieldGekoSwapper.swap(dex, calldata, tokenIn, tokenOut, amountIn, minOut)
 *        → DEX router (Uniswap, 1inch, etc.)
 */
contract YieldGekoSwapper is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    mapping(address => bool) public approvedDEXes;
    mapping(address => string) public dexNames;
    address[] public dexList;

    mapping(address => bool) public authorizedCallers;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event DEXAdded(address indexed dex, string name);
    event DEXRemoved(address indexed dex);
    event CallerAuthorized(address indexed caller, bool authorized);
    event SwapExecuted(
        address indexed dex,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error UnauthorizedCaller(address caller);
    error UnapprovedDEX(address dex);
    error SlippageExceeded(uint256 received, uint256 minRequired);
    error SwapFailed(address dex, bytes returnData);
    error ZeroAddress();
    error ZeroAmountIn();
    error EthTransferFailed();

    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    address public constant ETH = address(0);

    // ─────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyAuthorized() {
        if (!authorizedCallers[msg.sender]) revert UnauthorizedCaller(msg.sender);
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    constructor(address _owner) Ownable(_owner) {}

    // ─────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────

    function setAuthorizedCaller(address _caller, bool _authorized) external onlyOwner {
        if (_caller == address(0)) revert ZeroAddress();
        authorizedCallers[_caller] = _authorized;
        emit CallerAuthorized(_caller, _authorized);
    }

    /**
     * @notice Add a new DEX router. Existing user delegations automatically
     *         gain access without re-signing.
     */
    function addDEX(address _dex, string calldata _name) external onlyOwner {
        if (_dex == address(0)) revert ZeroAddress();
        if (!approvedDEXes[_dex]) {
            approvedDEXes[_dex] = true;
            dexNames[_dex] = _name;
            dexList.push(_dex);
            emit DEXAdded(_dex, _name);
        }
    }

    function removeDEX(address _dex) external onlyOwner {
        approvedDEXes[_dex] = false;
        emit DEXRemoved(_dex);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Swap
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Execute a token swap via an approved DEX with slippage enforced on-chain.
     *
     * @param _dex          Approved DEX router address
     * @param _calldata     Encoded swap calldata built by the agent (e.g. Uniswap exactInput)
     * @param _tokenIn      Input token (address(0) for native ETH)
     * @param _tokenOut     Output token (address(0) for native ETH)
     * @param _amountIn     Exact amount of tokenIn to swap
     * @param _minAmountOut Minimum tokenOut required — enforced on-chain via balance delta
     * @param _recipient    Address to receive the output tokens
     *
     * @return amountOut    Actual amount of tokenOut received
     */
    /**
     * @notice Permissionless — swap only spends msg.sender's pre-approved tokenIn.
     *         _recipient receives tokenOut (set to executor for delta-neutral LP flow).
     */
    function swap(
        address _dex,
        bytes calldata _calldata,
        address _tokenIn,
        address _tokenOut,
        uint256 _amountIn,
        uint256 _minAmountOut,
        address _recipient
    ) external payable nonReentrant returns (uint256 amountOut) {
        if (!approvedDEXes[_dex]) revert UnapprovedDEX(_dex);
        if (_amountIn == 0) revert ZeroAmountIn();

        // Snapshot output balance before swap
        uint256 balanceBefore =
            _tokenOut == ETH ? address(this).balance - msg.value : IERC20(_tokenOut).balanceOf(address(this));

        // Pull ERC-20 input from caller and approve DEX
        if (_tokenIn != ETH) {
            IERC20(_tokenIn).safeTransferFrom(msg.sender, address(this), _amountIn);
            IERC20(_tokenIn).forceApprove(_dex, _amountIn);
        }

        // Execute the swap
        uint256 ethValue = _tokenIn == ETH ? _amountIn : 0;
        (bool success, bytes memory returnData) = _dex.call{value: ethValue}(_calldata);
        if (!success) revert SwapFailed(_dex, returnData);

        // Measure actual output via balance delta — cannot be gamed
        uint256 balanceAfter = _tokenOut == ETH ? address(this).balance : IERC20(_tokenOut).balanceOf(address(this));

        amountOut = balanceAfter - balanceBefore;

        // Enforce slippage on-chain
        if (amountOut < _minAmountOut) revert SlippageExceeded(amountOut, _minAmountOut);

        // Clear any residual approval after swap
        if (_tokenIn != ETH) {
            IERC20(_tokenIn).forceApprove(_dex, 0);
        }

        // Forward output to recipient
        if (_tokenOut != ETH) {
            IERC20(_tokenOut).safeTransfer(_recipient, amountOut);
        } else {
            (bool sent,) = _recipient.call{value: amountOut}("");
            if (!sent) revert EthTransferFailed();
        }

        emit SwapExecuted(_dex, _tokenIn, _tokenOut, _amountIn, amountOut, _recipient);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View helpers
    // ─────────────────────────────────────────────────────────────────────────

    function getDEXCount() external view returns (uint256) {
        return dexList.length;
    }

    /**
     * @notice Returns all currently active (not removed) approved DEXes with names.
     */
    function getActiveDEXes() external view returns (address[] memory active, string[] memory names) {
        uint256 total = dexList.length;
        uint256 count = 0;

        for (uint256 i = 0; i < total; ++i) {
            if (approvedDEXes[dexList[i]]) ++count;
        }

        active = new address[](count);
        names = new string[](count);
        uint256 idx = 0;

        for (uint256 i = 0; i < total; ++i) {
            if (approvedDEXes[dexList[i]]) {
                active[idx] = dexList[i];
                names[idx] = dexNames[dexList[i]];
                ++idx;
            }
        }
    }

    receive() external payable {}
}
