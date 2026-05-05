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

/**
 * @title YieldGekoRouter
 * @dev Audited core settlement contract for YieldGeko.
 * Implements Agent authorization, Fee logic, and Bounds enforcement.
 */
contract YieldGekoRouter is EIP712, Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    struct Intent {
        address user;
        uint256 minAPY;
        uint256 maxSlippage;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 public constant INTENT_TYPEHASH =
        keccak256("Intent(address user,uint256 minAPY,uint256 maxSlippage,uint256 nonce,uint256 deadline)");

    uint256 public constant MIGRATION_FEE_BPS = 10; // 0.10%
    uint256 public constant SUCCESS_FEE_BPS = 25; // 0.25%

    StrategyRegistry public immutable registry;
    address public authorizedAgent; // Set to 0G Agent ID
    address public treasury;

    mapping(address => mapping(address => uint256)) public userBalances;
    mapping(address => uint256) public nonces;

    event Deposited(address indexed user, address indexed asset, uint256 amount);
    event Withdrawn(address indexed user, address indexed asset, uint256 amount);
    event MigrationExecuted(
        address indexed user, address indexed fromStrategy, address indexed toStrategy, uint256 amount, uint256 totalFee
    );
    event AgentUpdated(address indexed newAgent);
    event TreasuryUpdated(address indexed newTreasury);

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
        address fromStrategy;
        address toStrategy;
        address asset;
        uint256 amount;
        uint256 actualSlippageBps;
        uint256 actualAPY;
        bytes32 receiptHash; // SHA-256 of off-chain audit JSON
        uint256 gasPriceInAsset; // TEE-verified conversion (e.g. 1 USDC per 1M gas)
    }

    event MigrationFailed(address indexed user, string reason);

    function executeMigration(
        Intent calldata _intent,
        bytes calldata _signature,
        address _fromStrategy,
        address _toStrategy,
        address _asset,
        uint256 _amount,
        uint256 _actualSlippageBps,
        uint256 _actualAPY,
        bytes32 _receiptHash,
        uint256 _gasPriceInAsset
    ) external onlyAuthorizedAgent whenNotPaused nonReentrant {
        _executeMigration(
            _intent,
            _signature,
            _fromStrategy,
            _toStrategy,
            _asset,
            _amount,
            _actualSlippageBps,
            _actualAPY,
            _receiptHash,
            _gasPriceInAsset
        );
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
                _params[i].fromStrategy,
                _params[i].toStrategy,
                _params[i].asset,
                _params[i].amount,
                _params[i].actualSlippageBps,
                _params[i].actualAPY,
                _params[i].receiptHash,
                _params[i].gasPriceInAsset
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
        address _fromStrategy,
        address _toStrategy,
        address _asset,
        uint256 _amount,
        uint256 _actualSlippageBps,
        uint256 _actualAPY,
        bytes32 _receiptHash,
        uint256 _gasPriceInAsset
    ) external {
        require(msg.sender == address(this), "Only internal batching");
        _executeMigration(
            _intent,
            _signature,
            _fromStrategy,
            _toStrategy,
            _asset,
            _amount,
            _actualSlippageBps,
            _actualAPY,
            _receiptHash,
            _gasPriceInAsset
        );
    }

    function _executeMigration(
        Intent calldata _intent,
        bytes calldata _signature,
        address _fromStrategy,
        address _toStrategy,
        address _asset,
        uint256 _amount,
        uint256 _actualSlippageBps,
        uint256 _actualAPY,
        bytes32 _receiptHash,
        uint256 _gasPriceInAsset
    ) internal {
        uint256 startGas = gasleft();

        require(block.timestamp <= _intent.deadline, "Intent expired");
        require(_intent.nonce == nonces[_intent.user], "Invalid nonce");
        require(registry.isStrategyApproved(_toStrategy), "Target not approved");
        require(userBalances[_intent.user][_asset] >= _amount, "Insufficient balance");

        // Bounds enforcement (contract-level safety net)
        require(_actualSlippageBps <= _intent.maxSlippage, "Slippage exceeds bound");
        require(_actualAPY >= _intent.minAPY, "APY below minimum");

        // Verify EIP-712 Signature
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH, _intent.user, _intent.minAPY, _intent.maxSlippage, _intent.nonce, _intent.deadline
            )
        );
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(hash, _signature);
        require(signer == _intent.user, "Invalid signature");

        // --- PRECISION FEE CALCULATION ---

        // 1. Migration Fee (10 BPS = 0.10%)
        uint256 migrationFee = (_amount * MIGRATION_FEE_BPS) / 10000;

        // 2. Success Fee (25 BPS on Uplift)
        uint256 upliftBps = _actualAPY > _intent.minAPY ? _actualAPY - _intent.minAPY : 0;
        uint256 successFee = (_amount * upliftBps * SUCCESS_FEE_BPS) / 100000000;

        // 3. Gas Recovery (Dynamic with TEE-verified conversion)
        uint256 gasUsed = startGas - gasleft() + 60000; // +60k for remaining steps
        uint256 gasFee = (gasUsed * _gasPriceInAsset) / 1000000;

        uint256 totalFee = migrationFee + successFee + gasFee;
        require(_amount > totalFee, "Amount too small for fees");

        // Deduct balance and route fees to Treasury
        userBalances[_intent.user][_asset] -= _amount;
        if (totalFee > 0) {
            IERC20(_asset).safeTransfer(treasury, totalFee);
        }

        // Increment nonce AFTER successful execution
        nonces[_intent.user]++;

        emit MigrationExecuted(_intent.user, _fromStrategy, _toStrategy, _amount - totalFee, totalFee);
        emit FeeSettled(_intent.user, migrationFee, successFee, gasFee, _receiptHash);
    }
}
