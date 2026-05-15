pragma solidity 0.8.23;

import {CaveatEnforcer} from "delegation-framework/enforcers/CaveatEnforcer.sol";
import {ModeCode} from "delegation-framework/utils/Types.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract YieldGekoPolicyCaveatEnforcer is CaveatEnforcer, Ownable {
    using SafeERC20 for IERC20;

    struct PolicyTerms {
        uint256 minAPYBps;
        uint256 maxDrawdownBps;
        uint256 managedUSD6;
        uint256 maxFeeBps;
        address treasury;
        uint256 expiresAt;
        address feeToken;
    }

    struct ExecutionArgs {
        uint256 preValueUSD6;
        uint256 postValueUSD6;
        uint256 feeAmountToken;
    }

    uint256 public constant BPS_DENOMINATOR = 10_000;

    mapping(bytes32 => uint256) public peakValueUSD6;

    mapping(bytes32 => bool) public peakInitialized;

    mapping(address => bool) public authorizedAgents;

    address public immutable DELEGATION_MANAGER;

    event AgentAuthorized(address indexed agent, bool authorized);
    event PolicyValidated(bytes32 indexed delegationHash, address indexed delegator, uint256 preValueUSD6);
    event DrawdownChecked(bytes32 indexed delegationHash, uint256 postValueUSD6, uint256 peakUSD6, uint256 drawdownBps);
    event PeakUpdated(bytes32 indexed delegationHash, uint256 newPeakUSD6);
    event FeeCollected(bytes32 indexed delegationHash, address indexed treasury, address feeToken, uint256 amount);

    error UnauthorizedAgent(address agent);
    error DelegationExpired(uint256 expiresAt, uint256 blockTime);
    error ManagedCapitalExceeded(uint256 currentUSD6, uint256 limitUSD6);
    error DrawdownExceeded(uint256 drawdownBps, uint256 maxBps);
    error ExcessiveFee(uint256 feeBps, uint256 maxBps);
    error ZeroTreasury();
    error ZeroFeeToken();
    error CallerNotDelegationManager(address caller);

    modifier onlyDelegationManager() {
        if (msg.sender != DELEGATION_MANAGER) {
            revert CallerNotDelegationManager(msg.sender);
        }
        _;
    }

    constructor(address _owner, address _delegationManager) Ownable(_owner) {
        require(_delegationManager != address(0), "YieldGeko: zero delegation manager");
        DELEGATION_MANAGER = _delegationManager;
    }

    function setAuthorizedAgent(address _agent, bool _authorized) external onlyOwner {
        authorizedAgents[_agent] = _authorized;
        emit AgentAuthorized(_agent, _authorized);
    }

    function beforeHook(
        bytes calldata _terms,
        bytes calldata _args,
        ModeCode _mode,
        bytes calldata,
        bytes32 _delegationHash,
        address _delegator,
        address _redeemer
    ) public override onlyDelegationManager {
        PolicyTerms memory terms = abi.decode(_terms, (PolicyTerms));
        ExecutionArgs memory args = abi.decode(_args, (ExecutionArgs));

        if (!authorizedAgents[_redeemer]) revert UnauthorizedAgent(_redeemer);

        if (block.timestamp > terms.expiresAt) {
            revert DelegationExpired(terms.expiresAt, block.timestamp);
        }

        if (!peakInitialized[_delegationHash] && args.preValueUSD6 > terms.managedUSD6) {
            revert ManagedCapitalExceeded(args.preValueUSD6, terms.managedUSD6);
        }

        if (!peakInitialized[_delegationHash]) {
            peakValueUSD6[_delegationHash] = args.preValueUSD6;
            peakInitialized[_delegationHash] = true;
        }

        emit PolicyValidated(_delegationHash, _delegator, args.preValueUSD6);
    }

    function afterHook(
        bytes calldata _terms,
        bytes calldata _args,
        ModeCode _mode,
        bytes calldata,
        bytes32 _delegationHash,
        address _delegator,
        address _redeemer
    ) public override onlyDelegationManager {
        PolicyTerms memory terms = abi.decode(_terms, (PolicyTerms));
        ExecutionArgs memory args = abi.decode(_args, (ExecutionArgs));

        uint256 peak = peakValueUSD6[_delegationHash];

        if (peak > 0 && args.postValueUSD6 < peak) {
            uint256 loss = peak - args.postValueUSD6;
            uint256 drawdownBps = (loss * BPS_DENOMINATOR) / peak;

            emit DrawdownChecked(_delegationHash, args.postValueUSD6, peak, drawdownBps);

            if (drawdownBps > terms.maxDrawdownBps) {
                revert DrawdownExceeded(drawdownBps, terms.maxDrawdownBps);
            }
        }

        if (args.postValueUSD6 > peak) {
            peakValueUSD6[_delegationHash] = args.postValueUSD6;
            emit PeakUpdated(_delegationHash, args.postValueUSD6);
        }

        if (args.feeAmountToken > 0) {
            if (terms.treasury == address(0)) revert ZeroTreasury();
            if (terms.feeToken == address(0)) revert ZeroFeeToken();

            uint256 yieldUSD6 = args.postValueUSD6 > args.preValueUSD6 ? args.postValueUSD6 - args.preValueUSD6 : 0;

            uint256 maxFeeUSD6 = (yieldUSD6 * terms.maxFeeBps) / BPS_DENOMINATOR;

            if (args.feeAmountToken > maxFeeUSD6) {
                uint256 feeBps = yieldUSD6 > 0 ? (args.feeAmountToken * BPS_DENOMINATOR) / yieldUSD6 : BPS_DENOMINATOR;
                revert ExcessiveFee(feeBps, terms.maxFeeBps);
            }

            IERC20(terms.feeToken).safeTransferFrom(_delegator, terms.treasury, args.feeAmountToken);
            emit FeeCollected(_delegationHash, terms.treasury, terms.feeToken, args.feeAmountToken);
        }
    }

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

    function currentDrawdownBps(bytes32 _delegationHash, uint256 _currentValueUSD6) external view returns (uint256) {
        uint256 peak = peakValueUSD6[_delegationHash];
        if (peak == 0 || _currentValueUSD6 >= peak) return 0;
        return ((peak - _currentValueUSD6) * BPS_DENOMINATOR) / peak;
    }
}
