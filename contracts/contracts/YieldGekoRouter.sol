// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./StrategyRegistry.sol";

interface IStrategyAdapter {
    function deposit(address asset, uint256 amount) external returns (uint256 depositedAmount);
    function withdraw(address asset, uint256 amount, address recipient) external returns (uint256 withdrawnAmount);
}

/**
 * @title YieldGekoRouter
 * @dev Audited core settlement contract for YieldGeko.
 * Implements Agent authorization, Fee logic, and Bounds enforcement.
 */
contract YieldGekoRouter is EIP712, Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    struct Intent {
        address user;
        address asset;
        address fromStrategy;
        address toStrategy;
        uint256 amount;
        uint256 minAPY;
        uint256 expectedAPY;
        uint256 maxSlippage;
        uint256 maxFee;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "Intent(address user,address asset,address fromStrategy,address toStrategy,uint256 amount,uint256 minAPY,uint256 expectedAPY,uint256 maxSlippage,uint256 maxFee,uint256 nonce,uint256 deadline)"
    );

    uint256 public constant MIGRATION_FEE_BPS = 10; // 0.10%
    uint256 public constant SUCCESS_FEE_BPS = 25; // 0.25%

    StrategyRegistry public immutable registry;
    address public authorizedAgent; // Set to 0G Agent ID
    address public treasury;

    // Idle assets held directly by the router for a user.
    mapping(address => mapping(address => uint256)) public userBalances;
    // Strategy-managed asset balances per user.
    mapping(address => mapping(address => mapping(address => uint256))) public strategyPositions;
    mapping(address => uint256) public nonces;

    event Deposited(address indexed user, address indexed asset, uint256 amount);
    event Withdrawn(address indexed user, address indexed asset, uint256 amount);
    event MigrationExecuted(
        address indexed user, address indexed fromStrategy, address indexed toStrategy, uint256 amount, uint256 totalFee
    );
    event AgentUpdated(address indexed newAgent);
    event TreasuryUpdated(address indexed newTreasury);
    event StrategyPositionUpdated(
        address indexed user, address indexed asset, address indexed strategy, uint256 positionAmount
    );

    modifier onlyAuthorizedAgent() {
        require(msg.sender == authorizedAgent, "Caller not authorized");
        _;
    }

    constructor(address _registry, address _agent, address _treasury) EIP712("YieldGeko", "1") Ownable(msg.sender) {
        registry = StrategyRegistry(_registry);
        authorizedAgent = _agent;
        treasury = _treasury;
    }

    function domainSeparator() public view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function setAuthorizedAgent(address _agent) external onlyOwner {
        authorizedAgent = _agent;
        emit AgentUpdated(_agent);
    }

    function setTreasury(address _treasury) external onlyOwner {
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function deposit(address _asset, uint256 _amount) external whenNotPaused nonReentrant {
        require(_amount > 0, "Amount must be > 0");
        IERC20(_asset).safeTransferFrom(msg.sender, address(this), _amount);
        userBalances[msg.sender][_asset] += _amount;
        emit Deposited(msg.sender, _asset, _amount);
    }

    function withdraw(address _asset, uint256 _amount) external nonReentrant {
        require(userBalances[msg.sender][_asset] >= _amount, "Insufficient balance");
        userBalances[msg.sender][_asset] -= _amount;
        IERC20(_asset).safeTransfer(msg.sender, _amount);
        emit Withdrawn(msg.sender, _asset, _amount);
    }

    event FeeSettled(
        address indexed user, uint256 migrationFee, uint256 successFee, uint256 gasFee, bytes32 receiptHash
    );

    struct BatchMigrationParams {
        Intent intent;
        bytes signature;
        uint256 actualSlippageBps;
        bytes32 receiptHash; // SHA-256 of off-chain audit JSON
        uint256 gasFeeInAsset; // Realized gas recovery denominated in the vault asset
    }

    event MigrationFailed(address indexed user, string reason);

    function executeMigration(
        Intent calldata _intent,
        bytes calldata _signature,
        uint256 _actualSlippageBps,
        bytes32 _receiptHash,
        uint256 _gasFeeInAsset
    ) external onlyAuthorizedAgent whenNotPaused nonReentrant {
        _executeMigration(_intent, _signature, _actualSlippageBps, _receiptHash, _gasFeeInAsset);
    }

    function executeBatchMigration(BatchMigrationParams[] calldata _params)
        external
        onlyAuthorizedAgent
        whenNotPaused
        nonReentrant
    {
        for (uint256 i = 0; i < _params.length; i++) {
            try this.executeMigrationExternal(
                _params[i].intent,
                _params[i].signature,
                _params[i].actualSlippageBps,
                _params[i].receiptHash,
                _params[i].gasFeeInAsset
            ) {
            // Success
            }
            catch {
                emit MigrationFailed(_params[i].intent.user, "Batch migration failed");
            }
        }
    }

    // Helper to allow try-catch to work on internal logic
    function executeMigrationExternal(
        Intent calldata _intent,
        bytes calldata _signature,
        uint256 _actualSlippageBps,
        bytes32 _receiptHash,
        uint256 _gasFeeInAsset
    ) external {
        require(msg.sender == address(this), "Only internal batching");
        _executeMigration(_intent, _signature, _actualSlippageBps, _receiptHash, _gasFeeInAsset);
    }

    function _executeMigration(
        Intent calldata _intent,
        bytes calldata _signature,
        uint256 _actualSlippageBps,
        bytes32 _receiptHash,
        uint256 _gasFeeInAsset
    ) internal {
        require(block.timestamp <= _intent.deadline, "Intent expired");
        require(_intent.nonce == nonces[_intent.user], "Invalid nonce");
        require(_intent.user != address(0), "Invalid user");
        require(_intent.asset != address(0), "Invalid asset");
        require(_intent.amount > 0, "Amount must be > 0");
        require(_intent.expectedAPY >= _intent.minAPY, "Expected APY below floor");
        require(_intent.toStrategy != address(0), "Target strategy required");
        require(registry.isStrategyApproved(_intent.toStrategy), "Target not approved");

        // Bounds enforcement (contract-level safety net)
        require(_actualSlippageBps <= _intent.maxSlippage, "Slippage exceeds bound");

        // Verify EIP-712 Signature
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                _intent.user,
                _intent.asset,
                _intent.fromStrategy,
                _intent.toStrategy,
                _intent.amount,
                _intent.minAPY,
                _intent.expectedAPY,
                _intent.maxSlippage,
                _intent.maxFee,
                _intent.nonce,
                _intent.deadline
            )
        );
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(hash, _signature);
        require(signer == _intent.user, "Invalid signature");

        uint256 grossAmount = _pullFundsForMigration(_intent.user, _intent.asset, _intent.fromStrategy, _intent.amount);

        // --- FEE CALCULATION ---

        uint256 migrationFee = (grossAmount * MIGRATION_FEE_BPS) / 10000;

        uint256 upliftBps = _intent.expectedAPY - _intent.minAPY;
        uint256 successFee = (grossAmount * upliftBps * SUCCESS_FEE_BPS) / 100000000;

        uint256 gasFee = _gasFeeInAsset;

        uint256 totalFee = migrationFee + successFee + gasFee;
        require(totalFee <= _intent.maxFee, "Fee exceeds signed limit");
        require(grossAmount > totalFee, "Amount too small for fees");

        uint256 netAmount = grossAmount - totalFee;
        if (totalFee > 0) {
            IERC20(_intent.asset).safeTransfer(treasury, totalFee);
        }

        _pushFundsToStrategy(_intent.user, _intent.asset, _intent.toStrategy, netAmount);

        // Increment nonce AFTER successful execution
        nonces[_intent.user]++;

        emit MigrationExecuted(_intent.user, _intent.fromStrategy, _intent.toStrategy, netAmount, totalFee);
        emit FeeSettled(_intent.user, migrationFee, successFee, gasFee, _receiptHash);
    }

    function _pullFundsForMigration(address user, address asset, address fromStrategy, uint256 amount)
        internal
        returns (uint256)
    {
        if (fromStrategy == address(0)) {
            require(userBalances[user][asset] >= amount, "Insufficient idle balance");
            userBalances[user][asset] -= amount;
            return amount;
        }

        require(strategyPositions[user][asset][fromStrategy] >= amount, "Insufficient strategy balance");

        StrategyRegistry.StrategyInfo memory info = registry.getStrategyInfo(fromStrategy);
        require(info.adapter != address(0), "Strategy adapter missing");

        strategyPositions[user][asset][fromStrategy] -= amount;
        emit StrategyPositionUpdated(user, asset, fromStrategy, strategyPositions[user][asset][fromStrategy]);

        uint256 withdrawnAmount = IStrategyAdapter(info.adapter).withdraw(asset, amount, address(this));
        require(withdrawnAmount >= amount, "Adapter under-delivered");

        return withdrawnAmount;
    }

    function _pushFundsToStrategy(address user, address asset, address toStrategy, uint256 amount) internal {
        StrategyRegistry.StrategyInfo memory info = registry.getStrategyInfo(toStrategy);
        require(info.adapter != address(0), "Strategy adapter missing");

        IERC20(asset).forceApprove(info.adapter, 0);
        IERC20(asset).forceApprove(info.adapter, amount);

        uint256 depositedAmount = IStrategyAdapter(info.adapter).deposit(asset, amount);
        require(depositedAmount == amount, "Adapter deposit mismatch");

        strategyPositions[user][asset][toStrategy] += depositedAmount;
        emit StrategyPositionUpdated(user, asset, toStrategy, strategyPositions[user][asset][toStrategy]);
    }
}
