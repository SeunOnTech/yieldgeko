// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title  YieldGeko
 * @notice Yield optimisation vault. Deploy identical bytecode on any EVM chain.
 *         Each deployment is self-contained: policy, funds, enforcement, and audit
 *         trail live in one address per chain.
 *
 * What this contract enforces on-chain
 * ─────────────────────────────────────
 *  ✓ Policy active + not expired                     (_enforcePolicy)
 *  ✓ minAPY: agent must assert APY ≥ policy.minAPY   (executeDeposit)
 *  ✓ maxDrawdownBps: auto-pause user when exceeded   (reportValue → userPaused)
 *  ✓ Fee cap: actual fee = min(default, maxFeeBps)   (collectFee)
 *  ✓ Target whitelist: only owner-approved addresses (execute*)
 *  ✓ Immutable action log: every execute emits       (ActionExecuted event)
 *
 * What requires off-chain enforcement (noted honestly)
 * ────────────────────────────────────────────────────
 *  ✗ managedUSD vs token amount: checked in token units only
 *    (accurate USD enforcement requires a price oracle — not included)
 *  ✗ Fee timing: bounded by maxFeeBps but not tied to realised P&L
 *  ✗ reportValue accuracy: on-chain drawdown logic is correct,
 *    input values are agent-reported (off-chain trust)
 *
 * Balance accounting
 * ──────────────────
 *  executeDeposit : atomically deducts idle balance + calls protocol
 *  executeWithdraw: measures ACTUAL token return via balance delta
 *  executeWithdrawMulti: same as executeWithdraw, for multi-asset unwinds
 *  executeBatch   : measures NET token flow via before/after balance
 *  executeBatchMulti: same as executeBatch, for multi-asset strategies
 *  All three remove the manual deployFunds()/receiveFunds() calls
 *  that were trust-based in earlier versions.
 *
 * Emergency mode
 * ──────────────
 *  setEmergencyMode(true) pauses the contract. ALL agent write functions
 *  except executeWithdraw() are blocked. executeWithdraw() is kept open
 *  so the agent can return funds to idle balances even during emergency,
 *  allowing users to self-rescue via emergencyWithdraw().
 */
contract YieldGeko is EIP712, Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // ERRORS
    // ─────────────────────────────────────────────────────────────────────────

    error NotAgent();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidSignature();
    error PolicyExpired();
    error PolicyNotActive();
    error UserPausedByDrawdown(address user);
    error DrawdownTooHigh(uint256 bps, uint256 maxBps);
    error FeeTooHigh(uint256 bps, uint256 maxBps);
    error APYTooLow(uint256 asserted, uint256 required);
    error ExceedsManagedCapacity(uint256 total, uint256 cap);
    error InsufficientBalance(uint256 have, uint256 need);
    error TargetNotApproved(address target);
    error LengthMismatch();
    error EmergencyModeOff();
    error UnsafeGenericExecution();

    // ─────────────────────────────────────────────────────────────────────────
    // TYPES
    // ─────────────────────────────────────────────────────────────────────────

    struct Policy {
        address user;
        uint256 managedUSD; // capital cap (compared to token units — see note above)
        uint256 minAPY; // minimum acceptable APY in bps (800 = 8 %)
        uint256 maxDrawdownBps; // drawdown threshold for auto-pause (1000 = 10 %)
        uint256 maxFeeBps; // maximum fee per action (50 = 0.5 %)
        uint256 nonce;
        uint256 deadline; // signature window, not policy expiry
    }

    struct StoredPolicy {
        bool active;
        uint256 managedUSD;
        uint256 minAPY;
        uint256 maxDrawdownBps;
        uint256 maxFeeBps;
        uint256 registeredAt;
        uint256 expiresAt; // registeredAt + MAX_POLICY_DURATION
    }

    struct ExecutionRecord {
        bytes32 receiptHash; // SHA-256 of execution JSON in 0G Storage
        uint256 chainId;
        string action; // "GENESIS"|"MIGRATE"|"HARVEST"|"SAFETY_EXIT"
        uint256 amountUSD;
        uint256 timestamp;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CONSTANTS
    // ─────────────────────────────────────────────────────────────────────────

    bytes32 public constant POLICY_TYPEHASH = keccak256(
        "Policy(address user,uint256 managedUSD,uint256 minAPY,"
        "uint256 maxDrawdownBps,uint256 maxFeeBps,uint256 nonce,uint256 deadline)"
    );

    uint256 public constant MAX_FEE_BPS = 2000; // 20 %
    uint256 public constant MAX_POLICY_DURATION = 365 days;
    uint256 public constant MAX_DRAWDOWN_BPS = 5_000; // 50 %

    // ─────────────────────────────────────────────────────────────────────────
    // STATE
    // ─────────────────────────────────────────────────────────────────────────

    address public authorizedAgent;
    address public treasury;
    uint256 public defaultFeeBps;
    bool public emergencyMode;

    // user → asset → idle (deposited, not yet deployed)
    mapping(address => mapping(address => uint256)) public balances;

    // user → asset → deployed to DeFi protocols
    mapping(address => mapping(address => uint256)) public deployed;

    // user → policy
    mapping(address => StoredPolicy) public policies;

    // user → EIP-712 nonce
    mapping(address => uint256) public nonces;

    // user → peak portfolio value in USD (agent-reported via reportValue)
    mapping(address => uint256) public peakValues;

    // user → auto-paused by drawdown breach
    mapping(address => bool) public userPaused;

    // chainId → target address → approved for execute()
    mapping(uint256 => mapping(address => bool)) public approvedTargets;

    // spender → asset → tracked. Public audit surface for approvals created by the agent.
    mapping(address => mapping(address => bool)) public trackedSpenderAsset;

    // Assets ever deposited or approved by the vault. Generic execute() must not
    // reduce any of these balances, regardless of which target is called.
    mapping(address => bool) public protectedAsset;
    address[] private _protectedAssets;

    // user → execution history
    mapping(address => ExecutionRecord[]) private _executions;

    // ─────────────────────────────────────────────────────────────────────────
    // EVENTS
    // ─────────────────────────────────────────────────────────────────────────

    event Deposited(address indexed user, address indexed asset, uint256 amount);
    event Withdrawn(address indexed user, address indexed asset, uint256 amount);
    event PolicyRegistered(address indexed user, uint256 managedUSD, uint256 maxDrawdownBps, uint256 expiresAt);
    event PolicyRevoked(address indexed user);
    event UserAutoPaused(address indexed user, uint256 drawdownBps, uint256 maxBps);
    event UserResumed(address indexed user);
    event ValueReported(address indexed user, uint256 currentValueUSD, uint256 peakValueUSD);

    /// @dev Emitted on EVERY execute path — provides an immutable base audit trail
    ///      even if recordExecution() is not called subsequently.
    event ActionExecuted(address indexed user, address indexed target, bytes32 receiptHash, uint256 timestamp);

    event BatchExecuted(address indexed user, uint256 steps, bytes32 receiptHash);
    event FundsDeployed(address indexed user, address indexed asset, uint256 amount);
    event FundsReturned(address indexed user, address indexed asset, uint256 actual);
    event FeeCollected(address indexed user, address indexed asset, uint256 fee);
    event ExecutionRecorded(address indexed user, bytes32 receiptHash, string action, uint256 amountUSD);
    event TargetApproved(uint256 indexed chainId, address indexed target);
    event TargetRevoked(uint256 indexed chainId, address indexed target);
    event AgentUpdated(address indexed agent);
    event TreasuryUpdated(address indexed treasury);
    event EmergencyModeSet(bool enabled);

    // ─────────────────────────────────────────────────────────────────────────
    // MODIFIERS
    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyAgent() {
        if (msg.sender != authorizedAgent) revert NotAgent();
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CONSTRUCTOR
    // ─────────────────────────────────────────────────────────────────────────

    constructor(address _agent, address _treasury, uint256 _defaultFeeBps)
        EIP712("YieldGeko", "1")
        Ownable(msg.sender)
    {
        if (_agent == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_defaultFeeBps > MAX_FEE_BPS) revert FeeTooHigh(_defaultFeeBps, MAX_FEE_BPS);
        authorizedAgent = _agent;
        treasury = _treasury;
        defaultFeeBps = _defaultFeeBps;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 1 — USER FUNDS
    // ─────────────────────────────────────────────────────────────────────────

    function deposit(address asset, uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (asset == address(0)) revert ZeroAddress();
        _trackProtectedAsset(asset);
        balances[msg.sender][asset] += amount; // CEI: state first
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, asset, amount);
    }

    /// @notice Withdraw idle (undeployed) funds. Deployed funds must be unwound first.
    function withdraw(address asset, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 idle = balances[msg.sender][asset];
        if (idle < amount) revert InsufficientBalance(idle, amount);
        balances[msg.sender][asset] = idle - amount; // CEI: state first
        IERC20(asset).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, asset, amount);
    }

    /// @notice Self-rescue idle funds when emergencyMode is active.
    function emergencyWithdraw(address asset) external nonReentrant {
        if (!emergencyMode) revert EmergencyModeOff();
        uint256 idle = balances[msg.sender][asset];
        if (idle == 0) revert ZeroAmount();
        balances[msg.sender][asset] = 0;
        IERC20(asset).safeTransfer(msg.sender, idle);
        emit Withdrawn(msg.sender, asset, idle);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 2 — POLICY
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Register a user policy signed off-chain by the user (EIP-712).
     * @dev    Anyone with a valid signature may submit — the signature proves consent.
     *         Agent typically submits it and pays gas; user never needs chain tokens.
     */
    function registerPolicy(Policy calldata _p, bytes calldata _sig) external whenNotPaused {
        if (block.timestamp > _p.deadline) revert PolicyExpired();
        if (_p.nonce != nonces[_p.user]) revert InvalidSignature();
        if (_p.user == address(0)) revert ZeroAddress();
        if (_p.managedUSD == 0) revert ZeroAmount();
        if (_p.maxDrawdownBps > MAX_DRAWDOWN_BPS) revert DrawdownTooHigh(_p.maxDrawdownBps, MAX_DRAWDOWN_BPS);
        if (_p.maxFeeBps > MAX_FEE_BPS) revert FeeTooHigh(_p.maxFeeBps, MAX_FEE_BPS);

        bytes32 structHash = keccak256(
            abi.encode(
                POLICY_TYPEHASH,
                _p.user,
                _p.managedUSD,
                _p.minAPY,
                _p.maxDrawdownBps,
                _p.maxFeeBps,
                _p.nonce,
                _p.deadline
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), _sig);
        if (signer != _p.user) revert InvalidSignature();

        uint256 expiresAt = block.timestamp + MAX_POLICY_DURATION;
        policies[_p.user] = StoredPolicy({
            active: true,
            managedUSD: _p.managedUSD,
            minAPY: _p.minAPY,
            maxDrawdownBps: _p.maxDrawdownBps,
            maxFeeBps: _p.maxFeeBps,
            registeredAt: block.timestamp,
            expiresAt: expiresAt
        });
        // A new policy registration is an explicit fresh-start consent from the user.
        // Clear any prior drawdown pause so the agent can act immediately.
        userPaused[_p.user] = false;
        unchecked {
            nonces[_p.user]++;
        }
        emit PolicyRegistered(_p.user, _p.managedUSD, _p.maxDrawdownBps, expiresAt);
    }

    function revokePolicy() external {
        if (!policies[msg.sender].active) revert PolicyNotActive();
        policies[msg.sender].active = false;
        emit PolicyRevoked(msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 3 — DRAWDOWN TRACKING
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Agent reports current portfolio USD value each tick.
     * @dev    If drawdown from peak exceeds policy.maxDrawdownBps, the user is
     *         auto-paused: no further deployments until the owner calls resumeUser()
     *         or the user re-registers a new policy (registerPolicy resets the flag).
     *         Values are agent-reported (off-chain trust); logic enforcement is on-chain.
     */
    function reportValue(address user, uint256 currentValueUSD) external onlyAgent {
        // Silently skip users with no policy record (agent may call this for all tracked users).
        if (policies[user].registeredAt == 0) return;

        if (currentValueUSD > peakValues[user]) {
            peakValues[user] = currentValueUSD;
        }
        emit ValueReported(user, currentValueUSD, peakValues[user]);

        // Only apply drawdown pause when the policy is currently active and non-expired.
        // Prevents pausing users whose policy has lapsed without explicit revocation.
        StoredPolicy storage p = policies[user];
        if (!p.active || block.timestamp > p.expiresAt) return;

        uint256 peak = peakValues[user];
        if (peak > 0 && currentValueUSD < peak) {
            unchecked {
                uint256 drawdownBps = (peak - currentValueUSD) * 10_000 / peak;
                if (drawdownBps >= p.maxDrawdownBps && !userPaused[user]) {
                    userPaused[user] = true;
                    emit UserAutoPaused(user, drawdownBps, p.maxDrawdownBps);
                }
            }
        }
    }

    /// @notice Owner can manually resume a user after a drawdown pause.
    function resumeUser(address user) external onlyOwner {
        userPaused[user] = false;
        emit UserResumed(user);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 4 — AGENT EXECUTION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Deploy user funds to a DeFi protocol atomically.
     * @param assertedAPY  Agent asserts this APY for the target opportunity.
     *                     Enforced: must be ≥ policy.minAPY.
     *                     Note: contract cannot verify on-chain; agent assertion
     *                     creates a signed on-chain commitment — false assertion
     *                     is cryptographically provable fraud.
     * @param amount       Token units being deployed. Checked against policy.managedUSD
     *                     in token units (accurate USD check requires oracle — not included).
     */
    function executeDeposit(
        address user,
        address asset,
        uint256 amount,
        uint256 assertedAPY,
        address target,
        bytes calldata data,
        bytes32 receiptHash
    ) external payable onlyAgent whenNotPaused nonReentrant {
        _enforcePolicy(user);
        _assertNotUserPaused(user);
        _assertTarget(target);
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _trackProtectedAsset(asset);

        StoredPolicy storage p = policies[user];

        // Enforce minAPY: agent must assert APY ≥ policy floor
        if (assertedAPY < p.minAPY) revert APYTooLow(assertedAPY, p.minAPY);

        // Enforce managedUSD as token-unit cap (approximate; see docs for oracle caveat).
        // balances[user][asset] still contains `amount` at this point (deducted below),
        // so balances + deployed = total capital in vault = correct bound to check against.
        uint256 total = balances[user][asset] + deployed[user][asset];
        if (total > p.managedUSD) revert ExceedsManagedCapacity(total, p.managedUSD);

        uint256 balBefore = IERC20(asset).balanceOf(address(this));

        // The external call must spend no more than the user-authorised amount.
        // Accounting is updated from the measured token delta, not agent input.
        uint256 idle = balances[user][asset];
        if (idle < amount) revert InsufficientBalance(idle, amount);

        (bool ok,) = target.call{value: msg.value}(data);
        require(ok, "Execution failed");

        uint256 balAfter = IERC20(asset).balanceOf(address(this));
        if (balAfter >= balBefore) revert ZeroAmount();
        uint256 actualSpent = balBefore - balAfter;
        if (actualSpent > amount) revert InsufficientBalance(amount, actualSpent);

        unchecked {
            balances[user][asset] = idle - actualSpent;
            deployed[user][asset] += actualSpent;
        }

        // Immutable base audit — fires even if recordExecution() is skipped
        emit ActionExecuted(user, target, receiptHash, block.timestamp);
        emit FundsDeployed(user, asset, actualSpent);
    }

    /**
     * @notice Unwind a DeFi position back to the vault.
     * @dev    NOT gated by whenNotPaused — agent must be able to unwind positions
     *         during emergency so users can then call emergencyWithdraw().
     *         Measures ACTUAL token return via before/after balance delta.
     *         No agent-reported return amount — accounting is trustless.
     */
    function executeWithdraw(
        address user,
        address asset,
        uint256 deployedAmount, // recorded deployment to deduct
        address target,
        bytes calldata data,
        bytes32 receiptHash
    ) external payable onlyAgent nonReentrant {
        // Note: no whenNotPaused — intentionally open during emergency.
        // Policy active/expiry checks are intentionally skipped here: if a user's
        // policy has expired or been revoked while funds are deployed, the agent
        // must still be able to unwind positions so users can self-rescue via
        // emergencyWithdraw(). Only require that a policy was ever registered.
        if (policies[user].registeredAt == 0) revert PolicyNotActive();
        _assertTarget(target);

        uint256 balBefore = IERC20(asset).balanceOf(address(this));

        (bool ok,) = target.call{value: msg.value}(data);
        require(ok, "Execution failed");

        // Measure actual returned amount — not agent-reported
        uint256 balAfter = IERC20(asset).balanceOf(address(this));
        uint256 returned = balAfter > balBefore ? balAfter - balBefore : 0;

        // Deduct max(deployedAmount, returned) from deployed, capped at current dep.
        uint256 dep = deployed[user][asset];
        if (deployedAmount > dep) revert InsufficientBalance(dep, deployedAmount);
        uint256 toDeduct = returned > deployedAmount ? returned : deployedAmount;
        if (toDeduct > dep) toDeduct = dep;

        // Auto-fee on realized yield — only when returned > declared deployment cost.
        // IL-safe: fee = 0 whenever returned <= deployedAmount (no gain, no charge).
        uint256 surplus = returned > deployedAmount ? returned - deployedAmount : 0;
        uint256 fee = (surplus * _effectiveFeeBps(user)) / 10_000;

        unchecked {
            deployed[user][asset] = dep - toDeduct;
            balances[user][asset] += returned - fee;
        }
        if (fee > 0 && treasury != address(0)) {
            IERC20(asset).safeTransfer(treasury, fee);
            emit FeeCollected(user, asset, fee);
        }

        emit ActionExecuted(user, target, receiptHash, block.timestamp);
        emit FundsReturned(user, asset, returned);
    }

    /**
     * @notice Unwind a position that can return multiple principal assets.
     * @dev    Recovery path, so intentionally not gated by whenNotPaused and only
     *         requires that the user registered a policy at least once.
     */
    function executeWithdrawMulti(
        address user,
        address[] calldata assets,
        uint256[] calldata deployedAmounts,
        address target,
        bytes calldata data,
        bytes32 receiptHash
    ) external payable onlyAgent nonReentrant returns (uint256[] memory returnedAmounts) {
        if (assets.length != deployedAmounts.length) revert LengthMismatch();
        if (assets.length == 0) revert ZeroAmount();
        if (policies[user].registeredAt == 0) revert PolicyNotActive();
        _assertTarget(target);

        uint256 len = assets.length;
        uint256[] memory beforeBalances = new uint256[](len);
        for (uint256 i; i < len;) {
            address asset = assets[i];
            if (asset == address(0)) revert ZeroAddress();
            for (uint256 j; j < i;) {
                if (assets[j] == asset) revert LengthMismatch();
                unchecked {
                    ++j;
                }
            }
            _trackProtectedAsset(asset);
            beforeBalances[i] = IERC20(asset).balanceOf(address(this));
            unchecked {
                ++i;
            }
        }

        (bool ok,) = target.call{value: msg.value}(data);
        require(ok, "Execution failed");

        returnedAmounts = new uint256[](len);
        for (uint256 i; i < len;) {
            address asset = assets[i];
            uint256 balAfter = IERC20(asset).balanceOf(address(this));
            uint256 returned = balAfter > beforeBalances[i] ? balAfter - beforeBalances[i] : 0;
            uint256 declared = deployedAmounts[i];

            uint256 dep = deployed[user][asset];
            if (declared > dep) revert InsufficientBalance(dep, declared);
            uint256 toDeduct = returned > declared ? returned : declared;
            if (toDeduct > dep) toDeduct = dep;

            uint256 surplus = returned > declared ? returned - declared : 0;
            uint256 fee = (surplus * _effectiveFeeBps(user)) / 10_000;

            unchecked {
                deployed[user][asset] = dep - toDeduct;
                balances[user][asset] += returned - fee;
            }
            if (fee > 0 && treasury != address(0)) {
                IERC20(asset).safeTransfer(treasury, fee);
                emit FeeCollected(user, asset, fee);
            }

            returnedAmounts[i] = returned;
            emit FundsReturned(user, asset, returned);
            unchecked {
                ++i;
            }
        }

        emit ActionExecuted(user, target, receiptHash, block.timestamp);
    }

    /**
     * @notice Generic protocol call — for non-fund-moving operations (harvest,
     *         collect fees, claim rewards, approve tokens, etc.).
     * @dev    Does not update balance accounting — use executeDeposit/executeWithdraw
     *         for fund-moving operations.
     * @param  guardAsset  ERC-20 whose vault balance must not decrease. The contract
     *                     also checks every asset ever deposited or approved, closing
     *                     target/spender mismatch drains in router-style protocols.
     */
    function execute(address user, address target, bytes calldata data, bytes32 receiptHash, address guardAsset)
        external
        payable
        onlyAgent
        whenNotPaused
        nonReentrant
        returns (bytes memory)
    {
        _enforcePolicy(user);
        _assertNotUserPaused(user);
        _assertTarget(target);
        if (guardAsset == address(0)) revert UnsafeGenericExecution();

        address[] storage trackedAssets = _protectedAssets;
        uint256 len = trackedAssets.length;
        uint256[] memory beforeBalances = new uint256[](len);
        for (uint256 i; i < len;) {
            beforeBalances[i] = IERC20(trackedAssets[i]).balanceOf(address(this));
            unchecked {
                ++i;
            }
        }
        uint256 guardBefore = IERC20(guardAsset).balanceOf(address(this));

        (bool ok, bytes memory result) = target.call{value: msg.value}(data);
        require(ok, "Execution failed");

        _assertProtectedAssetsDidNotDecrease(trackedAssets, beforeBalances, address(0));
        uint256 guardAfter = IERC20(guardAsset).balanceOf(address(this));
        if (guardAfter < guardBefore) revert InsufficientBalance(guardAfter, guardBefore);

        emit ActionExecuted(user, target, receiptHash, block.timestamp);
        return result;
    }

    /**
     * @notice Atomic multi-step execution for strategies requiring sequential calls
     *         (e.g. Aave leveraged loop: supply → borrow → supply → borrow ...).
     * @param  asset   The ERC-20 whose net balance change is measured for accounting.
     *                 Pass address(0) to skip balance accounting for a non-fund-moving
     *                 batch. Any protected vault asset is still prevented from decreasing.
     * @dev    Measures NET token flow via before/after balance delta for a SINGLE asset.
     *         Use executeBatchMulti() for LPs, concentrated-liquidity mints, or any
     *         strategy where more than one principal token can move.
     *         All steps must succeed or the entire batch reverts.
     */
    function executeBatch(
        address user,
        address asset,
        address[] calldata targets,
        bytes[] calldata dataArr,
        bytes32 receiptHash
    ) external onlyAgent whenNotPaused nonReentrant returns (bytes[] memory results) {
        if (targets.length != dataArr.length) revert LengthMismatch();
        _enforcePolicy(user);
        _assertNotUserPaused(user);

        uint256 balBefore;
        if (asset != address(0)) {
            _trackProtectedAsset(asset);
            balBefore = IERC20(asset).balanceOf(address(this));
        }
        address[] storage trackedAssets = _protectedAssets;
        uint256 protectedLen = trackedAssets.length;
        uint256[] memory protectedBefore = new uint256[](protectedLen);
        for (uint256 i; i < protectedLen;) {
            protectedBefore[i] = IERC20(trackedAssets[i]).balanceOf(address(this));
            unchecked {
                ++i;
            }
        }

        results = new bytes[](targets.length);
        for (uint256 i; i < targets.length;) {
            _assertTarget(targets[i]);
            (bool ok, bytes memory result) = targets[i].call(dataArr[i]);
            require(ok, "Batch step failed");
            results[i] = result;
            unchecked {
                ++i;
            }
        }

        // Measure actual net token flow — no agent-reported amounts.
        if (asset != address(0)) {
            uint256 balAfter = IERC20(asset).balanceOf(address(this));
            if (balBefore > balAfter) {
                uint256 netOut = balBefore - balAfter;
                uint256 idle = balances[user][asset];
                if (idle < netOut) revert InsufficientBalance(idle, netOut);
                unchecked {
                    balances[user][asset] = idle - netOut;
                    deployed[user][asset] += netOut;
                }
                emit FundsDeployed(user, asset, netOut);
            } else if (balAfter > balBefore) {
                uint256 netIn = balAfter - balBefore;
                uint256 dep = deployed[user][asset];
                unchecked {
                    deployed[user][asset] = dep >= netIn ? dep - netIn : 0;
                    balances[user][asset] += netIn;
                }
                emit FundsReturned(user, asset, netIn);
            }
        }

        // No protected vault asset may decrease unless it was explicitly declared
        // as the single accounted asset. Multi-asset movements must use executeBatchMulti().
        _assertProtectedAssetsDidNotDecrease(trackedAssets, protectedBefore, asset);

        emit BatchExecuted(user, targets.length, receiptHash);
    }

    /**
     * @notice Atomic batch execution with trustless accounting for multiple principal assets.
     * @dev    Use for LPs, dual-token mints, Pendle add/remove liquidity, and any
     *         strategy where several user assets can leave or return in one transaction.
     */
    function executeBatchMulti(
        address user,
        address[] calldata assets,
        address[] calldata targets,
        bytes[] calldata dataArr,
        bytes32 receiptHash
    ) external onlyAgent whenNotPaused nonReentrant returns (bytes[] memory results) {
        if (targets.length != dataArr.length) revert LengthMismatch();
        if (assets.length == 0) revert ZeroAmount();
        _enforcePolicy(user);
        _assertNotUserPaused(user);

        uint256 assetLen = assets.length;
        uint256[] memory beforeBalances = new uint256[](assetLen);
        for (uint256 i; i < assetLen;) {
            address asset = assets[i];
            if (asset == address(0)) revert ZeroAddress();
            for (uint256 j; j < i;) {
                if (assets[j] == asset) revert LengthMismatch();
                unchecked {
                    ++j;
                }
            }
            _trackProtectedAsset(asset);
            beforeBalances[i] = IERC20(asset).balanceOf(address(this));
            unchecked {
                ++i;
            }
        }

        address[] storage trackedAssets = _protectedAssets;
        uint256 protectedLen = trackedAssets.length;
        uint256[] memory protectedBefore = new uint256[](protectedLen);
        for (uint256 i; i < protectedLen;) {
            protectedBefore[i] = IERC20(trackedAssets[i]).balanceOf(address(this));
            unchecked {
                ++i;
            }
        }

        results = new bytes[](targets.length);
        for (uint256 i; i < targets.length;) {
            _assertTarget(targets[i]);
            (bool ok, bytes memory result) = targets[i].call(dataArr[i]);
            require(ok, "Batch step failed");
            results[i] = result;
            unchecked {
                ++i;
            }
        }

        for (uint256 i; i < assetLen;) {
            address asset = assets[i];
            uint256 balAfter = IERC20(asset).balanceOf(address(this));
            if (beforeBalances[i] > balAfter) {
                uint256 netOut = beforeBalances[i] - balAfter;
                uint256 idle = balances[user][asset];
                if (idle < netOut) revert InsufficientBalance(idle, netOut);
                unchecked {
                    balances[user][asset] = idle - netOut;
                    deployed[user][asset] += netOut;
                }
                emit FundsDeployed(user, asset, netOut);
            } else if (balAfter > beforeBalances[i]) {
                uint256 netIn = balAfter - beforeBalances[i];
                uint256 dep = deployed[user][asset];
                unchecked {
                    deployed[user][asset] = dep >= netIn ? dep - netIn : 0;
                    balances[user][asset] += netIn;
                }
                emit FundsReturned(user, asset, netIn);
            }
            unchecked {
                ++i;
            }
        }

        _assertProtectedAssetsDidNotDecreaseExcept(trackedAssets, protectedBefore, assets);

        emit BatchExecuted(user, targets.length, receiptHash);
    }

    /**
     * @notice Harvest yield from deployed positions — auto-collects performance fee on net income.
     * @dev    Measures yieldAsset balance before/after the harvest calls.
     *         The positive delta (harvested) is split: (1 - feeBps) credited to user, feeBps to treasury.
     *         If harvested == 0, the function is a no-op (no revert, no fee).
     *         Used for: UniV3 fee collect+normalise, Pendle reward redemption, any claim→swap flow.
     */
    function executeHarvest(
        address user,
        address yieldAsset,
        address[] calldata targets,
        bytes[] calldata dataArr,
        bytes32 receiptHash
    ) external onlyAgent whenNotPaused nonReentrant {
        if (targets.length != dataArr.length) revert LengthMismatch();
        if (targets.length == 0) revert ZeroAmount();
        _enforcePolicy(user);
        _assertNotUserPaused(user);

        uint256 balBefore = IERC20(yieldAsset).balanceOf(address(this));

        for (uint256 i; i < targets.length;) {
            _assertTarget(targets[i]);
            (bool ok,) = targets[i].call(dataArr[i]);
            require(ok, "Harvest step failed");
            unchecked {
                ++i;
            }
        }

        uint256 balAfter = IERC20(yieldAsset).balanceOf(address(this));
        uint256 harvested = balAfter > balBefore ? balAfter - balBefore : 0;

        if (harvested > 0) {
            uint256 fee = (harvested * _effectiveFeeBps(user)) / 10_000;
            unchecked {
                balances[user][yieldAsset] += harvested - fee;
            }
            if (fee > 0 && treasury != address(0)) {
                IERC20(yieldAsset).safeTransfer(treasury, fee);
                emit FeeCollected(user, yieldAsset, fee);
            }
            emit ActionExecuted(user, targets[0], receiptHash, block.timestamp);
        }
    }

    /**
     * @notice Set token allowance for a whitelisted protocol.
     * @dev    Blocked during pause/emergency — agent cannot create new approvals
     *         that could be exploited while the contract is paused.
     */
    function approveToken(address asset, address spender, uint256 amount) external onlyAgent whenNotPaused {
        _assertTarget(spender);
        if (!trackedSpenderAsset[spender][asset]) {
            trackedSpenderAsset[spender][asset] = true;
        }
        _trackProtectedAsset(asset);
        IERC20(asset).forceApprove(spender, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 5 — FEE + AUDIT TRAIL
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Collect protocol fee from user's idle balance.
     * @dev    Blocked during pause/emergency.
     *         Actual fee = min(defaultFeeBps, policy.maxFeeBps) — always bounded
     *         by the user's cryptographically signed policy cap.
     *         Limitation: not tied to a specific realised P&L event (see docs).
     */
    function collectFee(address asset, address user, uint256 grossAmount)
        external
        onlyAgent
        whenNotPaused
        returns (uint256 netAmount)
    {
        // Require an active, non-expired policy for fee collection.
        // Fees may only be charged while the agent is actively authorised.
        // Post-revoke or post-expiry fee deduction would violate user expectations.
        _enforcePolicy(user);
        StoredPolicy storage p = policies[user];
        uint256 feeBps = defaultFeeBps <= p.maxFeeBps ? defaultFeeBps : p.maxFeeBps;
        uint256 fee = (grossAmount * feeBps) / 10_000;

        if (fee > 0 && treasury != address(0)) {
            uint256 idle = balances[user][asset];
            if (idle < fee) revert InsufficientBalance(idle, fee);
            unchecked {
                balances[user][asset] = idle - fee;
            }
            IERC20(asset).safeTransfer(treasury, fee);
            emit FeeCollected(user, asset, fee);
        }
        netAmount = grossAmount - fee;
    }

    /**
     * @notice Record enriched metadata for an agent action.
     * @dev    Supplementary to the ActionExecuted event (which fires in every execute
     *         path). recordExecution provides richer metadata: action type, USD amount,
     *         and cross-chain chainId. The base audit trail (receiptHash + timestamp)
     *         is always available in ActionExecuted events without this call.
     */
    function recordExecution(
        address user,
        bytes32 receiptHash,
        uint256 chainId,
        string calldata action,
        uint256 amountUSD
    ) external onlyAgent {
        _enforcePolicy(user); // requires active AND non-expired policy
        _executions[user].push(
            ExecutionRecord({
                receiptHash: receiptHash,
                chainId: chainId,
                action: action,
                amountUSD: amountUSD,
                timestamp: block.timestamp
            })
        );
        emit ExecutionRecorded(user, receiptHash, action, amountUSD);
    }

    function getExecutions(address user) external view returns (ExecutionRecord[] memory) {
        return _executions[user];
    }

    function getExecutionCount(address user) external view returns (uint256) {
        return _executions[user].length;
    }

    function totalFunds(address user, address asset) external view returns (uint256) {
        return balances[user][asset] + deployed[user][asset];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 6 — ADMIN
    // ─────────────────────────────────────────────────────────────────────────

    function approveTarget(uint256 chainId, address target) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        approvedTargets[chainId][target] = true;
        emit TargetApproved(chainId, target);
    }

    function revokeTarget(uint256 chainId, address target) external onlyOwner {
        approvedTargets[chainId][target] = false;
        emit TargetRevoked(chainId, target);
    }

    function setAgent(address _agent) external onlyOwner {
        if (_agent == address(0)) revert ZeroAddress();
        authorizedAgent = _agent;
        emit AgentUpdated(_agent);
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    function setDefaultFeeBps(uint256 _feeBps) external onlyOwner {
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh(_feeBps, MAX_FEE_BPS);
        defaultFeeBps = _feeBps;
    }

    /**
     * @notice Enable emergency mode.
     *         Pauses the contract — ALL agent write functions except
     *         executeWithdraw() are blocked. Users may call emergencyWithdraw()
     *         to recover idle funds after the agent has unwound positions.
     */
    function setEmergencyMode(bool enabled) external onlyOwner {
        emergencyMode = enabled;
        if (enabled) _pause();
        else _unpause();
        emit EmergencyModeSet(enabled);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        if (emergencyMode) revert EmergencyModeOff();
        _unpause();
    }

    /**
     * @notice One-time vault setup calls (e.g. GMX approvePlugin, initial approvals).
     * @dev    Owner-only. No user policy required — for vault initialisation only.
     *         Target must still be in the whitelist.
     */
    function vaultSetup(address target, bytes calldata data) external onlyOwner {
        _assertTarget(target);
        (bool ok,) = target.call(data);
        require(ok, "Setup call failed");
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    receive() external payable {}

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 7 — INTERNAL
    // ─────────────────────────────────────────────────────────────────────────

    function _effectiveFeeBps(address user) internal view returns (uint256) {
        StoredPolicy storage p = policies[user];
        return defaultFeeBps <= p.maxFeeBps ? defaultFeeBps : p.maxFeeBps;
    }

    function _enforcePolicy(address user) internal view {
        StoredPolicy storage p = policies[user];
        if (!p.active) revert PolicyNotActive();
        if (block.timestamp > p.expiresAt) revert PolicyExpired();
    }

    function _assertNotUserPaused(address user) internal view {
        if (userPaused[user]) revert UserPausedByDrawdown(user);
    }

    function _assertTarget(address target) internal view {
        if (!approvedTargets[block.chainid][target]) revert TargetNotApproved(target);
    }

    function _trackProtectedAsset(address asset) internal {
        if (asset == address(0)) revert ZeroAddress();
        if (!protectedAsset[asset]) {
            protectedAsset[asset] = true;
            _protectedAssets.push(asset);
        }
    }

    function _assertProtectedAssetsDidNotDecrease(
        address[] storage trackedAssets,
        uint256[] memory beforeBalances,
        address exemptAsset
    ) internal view {
        uint256 len = trackedAssets.length;
        for (uint256 i; i < len;) {
            address trackedAsset = trackedAssets[i];
            if (trackedAsset == exemptAsset) {
                unchecked {
                    ++i;
                }
                continue;
            }
            uint256 afterBalance = IERC20(trackedAsset).balanceOf(address(this));
            if (afterBalance < beforeBalances[i]) {
                revert InsufficientBalance(afterBalance, beforeBalances[i]);
            }
            unchecked {
                ++i;
            }
        }
    }

    function _assertProtectedAssetsDidNotDecreaseExcept(
        address[] storage trackedAssets,
        uint256[] memory beforeBalances,
        address[] calldata exemptAssets
    ) internal view {
        uint256 len = trackedAssets.length;
        for (uint256 i; i < len;) {
            address trackedAsset = trackedAssets[i];
            bool exempt;
            for (uint256 j; j < exemptAssets.length;) {
                if (trackedAsset == exemptAssets[j]) {
                    exempt = true;
                    break;
                }
                unchecked {
                    ++j;
                }
            }
            if (!exempt) {
                uint256 afterBalance = IERC20(trackedAsset).balanceOf(address(this));
                if (afterBalance < beforeBalances[i]) {
                    revert InsufficientBalance(afterBalance, beforeBalances[i]);
                }
            }
            unchecked {
                ++i;
            }
        }
    }
}
