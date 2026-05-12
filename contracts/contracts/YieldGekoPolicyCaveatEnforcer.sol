// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {CaveatEnforcer} from "delegation-framework/enforcers/CaveatEnforcer.sol";
import {ModeCode} from "delegation-framework/utils/Types.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title YieldGekoPolicyCaveatEnforcer
 * @notice Enforces YieldGeko yield strategy policies on ERC-7710 delegations.
 *         Validates agent authorization, expiry, capital limits, drawdown protection,
 *         and collects performance fees on yield generation.
 *
 * @dev Terms (signed by user at strategy setup, immutable):
 *      abi.encode(PolicyTerms)
 *
 * @dev Args (passed by agent at each redemption, can vary per call):
 *      abi.encode(ExecutionArgs)
 *
 * @dev Fee collection: agent includes a token.approve(enforcer, feeAmount) in the
 *      execution calldata so afterHook can pull the fee to treasury.
 */
contract YieldGekoPolicyCaveatEnforcer is CaveatEnforcer, Ownable {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────

    struct PolicyTerms {
        uint256 minAPYBps; // Minimum expected APY in bps (informational, not enforced on-chain)
        uint256 maxDrawdownBps; // Max allowed drawdown from all-time peak (e.g. 1000 = 10%)
        uint256 managedUSD6; // Max capital under management in USD with 6 decimals (1e6 = $1)
        uint256 maxFeeBps; // Max performance fee in bps (e.g. 1500 = 15%)
        address treasury; // YieldGeko treasury address for fee collection
        uint256 expiresAt; // Unix timestamp: delegation auto-expires after this
        address feeToken; // ERC-20 token fees are collected in (e.g. USDC on Arbitrum)
    }

    struct ExecutionArgs {
        uint256 preValueUSD6; // Portfolio USD value before execution (6 decimals)
        uint256 postValueUSD6; // Portfolio USD value after execution (6 decimals)
        uint256 feeAmountToken; // Fee amount in feeToken native decimals (0 if no fee this round)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @dev Per-delegation peak portfolio value for drawdown calculation
    mapping(bytes32 => uint256) public peakValueUSD6;

    /// @dev Whether a delegation has had its peak initialized
    mapping(bytes32 => bool) public peakInitialized;

    /// @dev Agents authorized to redeem delegations with this enforcer
    mapping(address => bool) public authorizedAgents;

    /// @dev Only the DelegationManager may call the hooks (prevents direct-call drain attacks)
    address public immutable DELEGATION_MANAGER;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event AgentAuthorized(address indexed agent, bool authorized);
    event PolicyValidated(bytes32 indexed delegationHash, address indexed delegator, uint256 preValueUSD6);
    event DrawdownChecked(bytes32 indexed delegationHash, uint256 postValueUSD6, uint256 peakUSD6, uint256 drawdownBps);
    event PeakUpdated(bytes32 indexed delegationHash, uint256 newPeakUSD6);
    event FeeCollected(bytes32 indexed delegationHash, address indexed treasury, address feeToken, uint256 amount);

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error UnauthorizedAgent(address agent);
    error DelegationExpired(uint256 expiresAt, uint256 blockTime);
    error ManagedCapitalExceeded(uint256 currentUSD6, uint256 limitUSD6);
    error DrawdownExceeded(uint256 drawdownBps, uint256 maxBps);
    error ExcessiveFee(uint256 feeBps, uint256 maxBps);
    error ZeroTreasury();
    error ZeroFeeToken();
    error CallerNotDelegationManager(address caller);

    // ─────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyDelegationManager() {
        if (msg.sender != DELEGATION_MANAGER) {
            revert CallerNotDelegationManager(msg.sender);
        }
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    constructor(address _owner, address _delegationManager) Ownable(_owner) {
        require(_delegationManager != address(0), "YieldGeko: zero delegation manager");
        DELEGATION_MANAGER = _delegationManager;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────

    function setAuthorizedAgent(address _agent, bool _authorized) external onlyOwner {
        authorizedAgents[_agent] = _authorized;
        emit AgentAuthorized(_agent, _authorized);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Caveat Hooks
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Called before the execution is performed.
     *         Validates: authorized agent, expiry, managed capital cap, initializes peak.
     */
    function beforeHook(
        bytes calldata _terms,
        bytes calldata _args,
        ModeCode _mode,
        bytes calldata, /* _executionCalldata */
        bytes32 _delegationHash,
        address _delegator,
        address _redeemer
    ) public override onlyDelegationManager {
        PolicyTerms memory terms = abi.decode(_terms, (PolicyTerms));
        ExecutionArgs memory args = abi.decode(_args, (ExecutionArgs));

        // 1. Verify redeemer is a YieldGeko authorized agent
        if (!authorizedAgents[_redeemer]) revert UnauthorizedAgent(_redeemer);

        // 2. Verify delegation has not expired
        if (block.timestamp > terms.expiresAt) {
            revert DelegationExpired(terms.expiresAt, block.timestamp);
        }

        // 3. Verify managed capital is within delegator-approved limit
        if (args.preValueUSD6 > terms.managedUSD6) {
            revert ManagedCapitalExceeded(args.preValueUSD6, terms.managedUSD6);
        }

        // 4. Initialize peak on first execution
        if (!peakInitialized[_delegationHash]) {
            peakValueUSD6[_delegationHash] = args.preValueUSD6;
            peakInitialized[_delegationHash] = true;
        }

        emit PolicyValidated(_delegationHash, _delegator, args.preValueUSD6);
    }

    /**
     * @notice Called after the execution is performed.
     *         Validates: drawdown within policy limits, collects performance fee.
     */
    function afterHook(
        bytes calldata _terms,
        bytes calldata _args,
        ModeCode _mode,
        bytes calldata, /* _executionCalldata */
        bytes32 _delegationHash,
        address _delegator,
        address _redeemer
    ) public override onlyDelegationManager {
        PolicyTerms memory terms = abi.decode(_terms, (PolicyTerms));
        ExecutionArgs memory args = abi.decode(_args, (ExecutionArgs));

        uint256 peak = peakValueUSD6[_delegationHash];

        // 1. Check drawdown from all-time peak
        if (peak > 0 && args.postValueUSD6 < peak) {
            uint256 loss = peak - args.postValueUSD6;
            uint256 drawdownBps = (loss * BPS_DENOMINATOR) / peak;

            emit DrawdownChecked(_delegationHash, args.postValueUSD6, peak, drawdownBps);

            if (drawdownBps > terms.maxDrawdownBps) {
                revert DrawdownExceeded(drawdownBps, terms.maxDrawdownBps);
            }
        }

        // 2. Update peak if portfolio grew
        if (args.postValueUSD6 > peak) {
            peakValueUSD6[_delegationHash] = args.postValueUSD6;
            emit PeakUpdated(_delegationHash, args.postValueUSD6);
        }

        // 3. Collect performance fee on yield
        if (args.feeAmountToken > 0) {
            if (terms.treasury == address(0)) revert ZeroTreasury();
            if (terms.feeToken == address(0)) revert ZeroFeeToken();

            // Validate fee does not exceed maxFeeBps of yield generated
            if (args.postValueUSD6 > args.preValueUSD6) {
                uint256 yieldUSD6 = args.postValueUSD6 - args.preValueUSD6;
                uint256 maxFeeUSD6 = (yieldUSD6 * terms.maxFeeBps) / BPS_DENOMINATOR;

                // Fee amount is in token decimals; assume fee token has 6 decimals (USDC)
                // If fee token has different decimals this validation is approximate
                if (args.feeAmountToken > maxFeeUSD6) {
                    uint256 feeBps = (args.feeAmountToken * BPS_DENOMINATOR) / yieldUSD6;
                    revert ExcessiveFee(feeBps, terms.maxFeeBps);
                }
            }

            // Pull fee from delegator's smart account (requires prior approval to this contract)
            IERC20(terms.feeToken).safeTransferFrom(_delegator, terms.treasury, args.feeAmountToken);
            emit FeeCollected(_delegationHash, terms.treasury, terms.feeToken, args.feeAmountToken);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View helpers (for frontend / agent)
    // ─────────────────────────────────────────────────────────────────────────

    function decodePolicyTerms(bytes calldata _terms) external pure returns (PolicyTerms memory) {
        return abi.decode(_terms, (PolicyTerms));
    }

    function decodeExecutionArgs(bytes calldata _args) external pure returns (ExecutionArgs memory) {
        return abi.decode(_args, (ExecutionArgs));
    }

    function encodePolicyTerms(PolicyTerms calldata _terms) external pure returns (bytes memory) {
        return abi.encode(_terms);
    }

    function encodeExecutionArgs(ExecutionArgs calldata _args) external pure returns (bytes memory) {
        return abi.encode(_args);
    }

    /**
     * @notice Returns the current drawdown percentage from peak for a delegation.
     */
    function currentDrawdownBps(bytes32 _delegationHash, uint256 _currentValueUSD6) external view returns (uint256) {
        uint256 peak = peakValueUSD6[_delegationHash];
        if (peak == 0 || _currentValueUSD6 >= peak) return 0;
        return ((peak - _currentValueUSD6) * BPS_DENOMINATOR) / peak;
    }
}
