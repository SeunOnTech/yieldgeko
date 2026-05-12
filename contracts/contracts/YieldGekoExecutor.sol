// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title YieldGekoExecutor
 * @notice Universal DeFi protocol router for YieldGeko V2.
 *
 * @dev Execution flow (ERC-7710 delegation path):
 *      Agent → DelegationManager.redeemDelegations() → User SmartAccount
 *        → YieldGekoExecutor (one of the functions below)
 *        → Protocol (Aave, UniV3, Morpho, Pendle, etc.)
 *
 * @dev Token flow for delta-neutral LP:
 *      Swapper sends volatile tokens directly to THIS executor (not smart account).
 *      executeFromBalance / executePullAndFromBalance use those tokens + optionally
 *      pull a second token from the smart account, call mint, then sweep dust to treasury.
 *      Executor balance is always zero after each call.
 */
contract YieldGekoExecutor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Protocols this executor is allowed to interact with
    mapping(address => bool) public approvedProtocols;
    mapping(address => string) public protocolNames;
    address[] public protocolList;

    /// @dev Callers authorized to call execute() / executeBatch() / approveToken()
    mapping(address => bool) public authorizedCallers;

    /// @dev Treasury receives dust swept after LP mints and can receive rescueToken payouts
    address public treasury;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event ProtocolAdded(address indexed protocol, string name);
    event ProtocolRemoved(address indexed protocol);
    event CallerAuthorized(address indexed caller, bool authorized);
    event TreasurySet(address indexed treasury);
    event ProtocolExecuted(address indexed protocol, address indexed caller, bytes4 indexed selector, uint256 value);
    event BatchExecuted(address indexed caller, uint256 callCount);
    event DustSwept(address indexed token, address indexed treasury, uint256 amount);
    event TokenRescued(address indexed token, address indexed treasury, uint256 amount);

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error UnauthorizedCaller(address caller);
    error UnapprovedProtocol(address protocol);
    error ExecutionFailed(address protocol, bytes returnData);
    error BatchLengthMismatch();
    error ZeroAddress();
    error EmptyCalldata();

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

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
        emit TreasurySet(_treasury);
    }

    function addProtocol(address _protocol, string calldata _name) external onlyOwner {
        if (_protocol == address(0)) revert ZeroAddress();
        if (!approvedProtocols[_protocol]) {
            approvedProtocols[_protocol] = true;
            protocolNames[_protocol] = _name;
            protocolList.push(_protocol);
            emit ProtocolAdded(_protocol, _name);
        }
    }

    function removeProtocol(address _protocol) external onlyOwner {
        approvedProtocols[_protocol] = false;
        emit ProtocolRemoved(_protocol);
    }

    /// @notice Sweep any accidentally stranded token balance to treasury.
    function rescueToken(address _token) external onlyOwner {
        if (treasury == address(0)) revert ZeroAddress();
        uint256 bal = IERC20(_token).balanceOf(address(this));
        if (bal > 0) {
            IERC20(_token).safeTransfer(treasury, bal);
            emit TokenRescued(_token, treasury, bal);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Gated execution (agent-only)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Generic single call — gated, no token pull.
    function execute(address _protocol, bytes calldata _calldata, uint256 _value)
        external
        payable
        nonReentrant
        onlyAuthorized
        returns (bytes memory returnData)
    {
        if (!approvedProtocols[_protocol]) revert UnapprovedProtocol(_protocol);
        if (_calldata.length < 4) revert EmptyCalldata();
        bytes4 selector = bytes4(_calldata[:4]);
        bool success;
        (success, returnData) = _protocol.call{value: _value}(_calldata);
        if (!success) revert ExecutionFailed(_protocol, returnData);
        emit ProtocolExecuted(_protocol, msg.sender, selector, _value);
    }

    /// @notice Batch execution — gated.
    function executeBatch(address[] calldata _protocols, bytes[] calldata _calldatas, uint256[] calldata _values)
        external
        payable
        nonReentrant
        onlyAuthorized
        returns (bytes[] memory results)
    {
        uint256 len = _protocols.length;
        if (len != _calldatas.length || len != _values.length) revert BatchLengthMismatch();
        results = new bytes[](len);
        for (uint256 i = 0; i < len; ++i) {
            if (!approvedProtocols[_protocols[i]]) revert UnapprovedProtocol(_protocols[i]);
            if (_calldatas[i].length < 4) revert EmptyCalldata();
            bytes4 selector = bytes4(_calldatas[i][:4]);
            bool success;
            (success, results[i]) = _protocols[i].call{value: _values[i]}(_calldatas[i]);
            if (!success) revert ExecutionFailed(_protocols[i], results[i]);
            emit ProtocolExecuted(_protocols[i], msg.sender, selector, _values[i]);
        }
        emit BatchExecuted(msg.sender, len);
    }

    /// @notice Approve a token for a protocol — gated.
    function approveToken(address _token, address _protocol, uint256 _amount) external onlyAuthorized {
        if (!approvedProtocols[_protocol]) revert UnapprovedProtocol(_protocol);
        IERC20(_token).forceApprove(_protocol, _amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Ungated pull execution (V2 delegation path)
    // Safe to be permissionless — only spends msg.sender's pre-approved tokens.
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Pull one token from caller, approve protocol, execute.
     *         Used for single-token deposits: Aave supply, Morpho deposit, Pendle PT swap.
     *         Permissionless — executor can only spend what caller approved.
     */
    function executeWithPull(
        address _token,
        uint256 _amount,
        address _protocol,
        bytes calldata _calldata,
        uint256 _value
    ) external payable nonReentrant returns (bytes memory returnData) {
        if (!approvedProtocols[_protocol]) revert UnapprovedProtocol(_protocol);
        if (_calldata.length < 4) revert EmptyCalldata();
        if (_token != address(0) && _amount > 0) {
            IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);
            IERC20(_token).forceApprove(_protocol, _amount);
        }
        bytes4 selector = bytes4(_calldata[:4]);
        bool success;
        (success, returnData) = _protocol.call{value: _value}(_calldata);
        if (!success) revert ExecutionFailed(_protocol, returnData);
        emit ProtocolExecuted(_protocol, msg.sender, selector, _value);
    }

    /**
     * @notice Pull two tokens from caller, approve both, execute, clear approvals.
     *         Legacy path — still used for withdraw/collect flows.
     *         Permissionless — executor can only spend what caller approved.
     */
    function executeWithPullTwo(
        address _token0,
        uint256 _amount0,
        address _token1,
        uint256 _amount1,
        address _protocol,
        bytes calldata _calldata,
        uint256 _value
    ) external payable nonReentrant returns (bytes memory returnData) {
        if (!approvedProtocols[_protocol]) revert UnapprovedProtocol(_protocol);
        if (_calldata.length < 4) revert EmptyCalldata();
        if (_token0 != address(0) && _amount0 > 0) {
            IERC20(_token0).safeTransferFrom(msg.sender, address(this), _amount0);
            IERC20(_token0).forceApprove(_protocol, _amount0);
        }
        if (_token1 != address(0) && _amount1 > 0) {
            IERC20(_token1).safeTransferFrom(msg.sender, address(this), _amount1);
            IERC20(_token1).forceApprove(_protocol, _amount1);
        }
        bytes4 selector = bytes4(_calldata[:4]);
        bool success;
        (success, returnData) = _protocol.call{value: _value}(_calldata);
        if (!success) revert ExecutionFailed(_protocol, returnData);
        if (_token0 != address(0) && _amount0 > 0) IERC20(_token0).forceApprove(_protocol, 0);
        if (_token1 != address(0) && _amount1 > 0) IERC20(_token1).forceApprove(_protocol, 0);
        emit ProtocolExecuted(_protocol, msg.sender, selector, _value);
    }

    /**
     * @notice Use tokens ALREADY IN executor (sent by Swapper), approve protocol, execute,
     *         then sweep any remaining dust to treasury.
     *
     *         Non-USDC delta-neutral path (e.g. WBTC-USDT):
     *           Swapper sends WBTC → executor, Swapper sends USDT → executor
     *           executeFromBalance(WBTC, USDT, UniV3PM, mintCalldata)
     *           → UniV3 pulls exact amounts from executor
     *           → dust WBTC + dust USDT → treasury
     *
     *         Executor balance guaranteed zero after this call.
     */
    function executeFromBalance(
        address _token0,
        address _token1,
        address _protocol,
        bytes calldata _calldata,
        uint256 _value
    ) external payable nonReentrant returns (bytes memory returnData) {
        if (!approvedProtocols[_protocol]) revert UnapprovedProtocol(_protocol);
        if (_calldata.length < 4) revert EmptyCalldata();

        uint256 bal0 = _token0 != address(0) ? IERC20(_token0).balanceOf(address(this)) : 0;
        uint256 bal1 = _token1 != address(0) ? IERC20(_token1).balanceOf(address(this)) : 0;
        if (bal0 > 0) IERC20(_token0).forceApprove(_protocol, bal0);
        if (bal1 > 0) IERC20(_token1).forceApprove(_protocol, bal1);

        bytes4 selector = bytes4(_calldata[:4]);
        bool success;
        (success, returnData) = _protocol.call{value: _value}(_calldata);
        if (!success) revert ExecutionFailed(_protocol, returnData);

        if (bal0 > 0) IERC20(_token0).forceApprove(_protocol, 0);
        if (bal1 > 0) IERC20(_token1).forceApprove(_protocol, 0);

        // Sweep dust to treasury — executor always ends at zero
        _sweepDust(_token0);
        _sweepDust(_token1);

        emit ProtocolExecuted(_protocol, msg.sender, selector, _value);
    }

    /**
     * @notice Pull one token from caller (USDC for LP leg) AND use a second token
     *         already in executor (volatile from Swapper), approve both, execute,
     *         then sweep dust to treasury.
     *
     *         USDC-paired delta-neutral path (e.g. WETH-USDC):
     *           Swapper sends WETH → executor
     *           executePullAndFromBalance(USDC, usdcAmount, WETH, UniV3PM, mintCalldata)
     *           → pulls USDC from smart account
     *           → UniV3 pulls exact amounts from executor
     *           → dust WETH + dust USDC → treasury
     *
     *         Executor balance guaranteed zero after this call.
     */
    function executePullAndFromBalance(
        address _pullToken,
        uint256 _pullAmount,
        address _balanceToken,
        address _protocol,
        bytes calldata _calldata,
        uint256 _value
    ) external payable nonReentrant returns (bytes memory returnData) {
        if (!approvedProtocols[_protocol]) revert UnapprovedProtocol(_protocol);
        if (_calldata.length < 4) revert EmptyCalldata();

        // Pull token from caller (smart account)
        if (_pullToken != address(0) && _pullAmount > 0) {
            IERC20(_pullToken).safeTransferFrom(msg.sender, address(this), _pullAmount);
        }

        // Approve both tokens for full balance
        uint256 balPull = _pullToken != address(0) ? IERC20(_pullToken).balanceOf(address(this)) : 0;
        uint256 balBalance = _balanceToken != address(0) ? IERC20(_balanceToken).balanceOf(address(this)) : 0;
        if (balPull > 0) IERC20(_pullToken).forceApprove(_protocol, balPull);
        if (balBalance > 0) IERC20(_balanceToken).forceApprove(_protocol, balBalance);

        bytes4 selector = bytes4(_calldata[:4]);
        bool success;
        (success, returnData) = _protocol.call{value: _value}(_calldata);
        if (!success) revert ExecutionFailed(_protocol, returnData);

        if (balPull > 0) IERC20(_pullToken).forceApprove(_protocol, 0);
        if (balBalance > 0) IERC20(_balanceToken).forceApprove(_protocol, 0);

        // Sweep dust to treasury — executor always ends at zero
        _sweepDust(_pullToken);
        _sweepDust(_balanceToken);

        emit ProtocolExecuted(_protocol, msg.sender, selector, _value);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    function _sweepDust(address _token) internal {
        if (_token == address(0) || treasury == address(0)) return;
        uint256 dust = IERC20(_token).balanceOf(address(this));
        if (dust > 0) {
            IERC20(_token).safeTransfer(treasury, dust);
            emit DustSwept(_token, treasury, dust);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View helpers
    // ─────────────────────────────────────────────────────────────────────────

    function getProtocolCount() external view returns (uint256) {
        return protocolList.length;
    }

    function getActiveProtocols() external view returns (address[] memory active, string[] memory names) {
        uint256 total = protocolList.length;
        uint256 count = 0;
        for (uint256 i = 0; i < total; ++i) {
            if (approvedProtocols[protocolList[i]]) ++count;
        }
        active = new address[](count);
        names = new string[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < total; ++i) {
            if (approvedProtocols[protocolList[i]]) {
                active[idx] = protocolList[i];
                names[idx] = protocolNames[protocolList[i]];
                ++idx;
            }
        }
    }

    receive() external payable {}
}
