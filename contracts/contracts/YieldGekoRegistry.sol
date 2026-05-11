// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  YieldGekoRegistry
 * @notice Deployed on 0G Chain (chainId 16661).
 *
 * Every time the YieldGeko agent executes a yield action on Arbitrum
 * (GENESIS, MIGRATE, REBALANCE, WITHDRAW), it anchors an immutable proof
 * here. Any user, auditor, or judge can independently verify what the
 * agent did, for whom, and when — without trusting YieldGeko.
 *
 * Proof chain:
 *   receiptHash  → keccak256 of execution parameters (computed on Arbitrum)
 *   traceCID     → 0G Storage CID of full screener→decision→txHash log
 *   attestCID    → 0G Storage CID of 0G Compute TEE attestation blob
 *
 * Multi-strategy ready: strategyId scopes proofs per sub-account strategy.
 * Pass bytes32(0) for single-strategy wallets (backward compatible).
 *
 * Explorer: https://chainscan.0g.ai
 * Storage:  https://storagescan.0g.ai
 */
contract YieldGekoRegistry {
    // ── Constants ─────────────────────────────────────────────────────────────

    uint256 public constant MAX_ACTION_LEN = 32;
    uint256 public constant MAX_CID_LEN = 128;
    uint256 public constant MAX_LATEST_N = 100;

    // Valid action strings (enforced on-chain)
    bytes32 private constant _A_GENESIS = keccak256("GENESIS");
    bytes32 private constant _A_MIGRATE = keccak256("MIGRATE");
    bytes32 private constant _A_REBALANCE = keccak256("REBALANCE");
    bytes32 private constant _A_WITHDRAW = keccak256("WITHDRAW");

    // ── Types ─────────────────────────────────────────────────────────────────

    struct Proof {
        bytes32 receiptHash; // keccak256 fingerprint of the Arbitrum execution
        address userAddress; // yield strategy owner (Arbitrum wallet)
        address anchoredBy; // msg.sender — the YieldGeko agent wallet
        bytes32 strategyId; // sub-account strategy scope; bytes32(0) = default single strategy
        string action; // "GENESIS" | "MIGRATE" | "REBALANCE" | "WITHDRAW"
        string traceCID; // 0G Storage CID — full execution trace (max 128 chars)
        string attestCID; // 0G Storage CID — TEE attestation (max 128 chars, empty if fallback)
        uint256 anchoredAt; // block.timestamp
    }

    // ── Storage ───────────────────────────────────────────────────────────────

    /// receiptHash → Proof
    mapping(bytes32 => Proof) private _proofs;

    /// userAddress → ordered list of receiptHashes (newest last, all strategies)
    mapping(address => bytes32[]) private _userReceipts;

    /// (userAddress, strategyId) → ordered list of receiptHashes for that strategy
    mapping(address => mapping(bytes32 => bytes32[])) private _strategyReceipts;

    /// agent wallet → authorised
    mapping(address => bool) public authorisedAgents;

    address public owner;
    uint256 public totalAnchored;

    // ── Events ────────────────────────────────────────────────────────────────

    event ProofAnchored(
        bytes32 indexed receiptHash,
        address indexed userAddress,
        bytes32 indexed strategyId,
        string action,
        string traceCID,
        string attestCID,
        uint256 anchoredAt
    );

    event AgentAuthorised(address indexed agent, bool authorised);
    event OwnershipTransferred(address indexed previous, address indexed next);

    // ── Errors ────────────────────────────────────────────────────────────────

    error NotOwner();
    error NotAuthorised();
    error InvalidReceiptHash();
    error InvalidUserAddress();
    error InvalidAgentAddress();
    error AlreadyAnchored(bytes32 receiptHash);
    error InvalidAction();
    error ActionTooLong();
    error CIDTooLong();

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
        authorisedAgents[msg.sender] = true;

        // Emit both events so indexers capture initial state (fixes LOW-03)
        emit OwnershipTransferred(address(0), msg.sender);
        emit AgentAuthorised(msg.sender, true);
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (!authorisedAgents[msg.sender]) revert NotAuthorised();
        _;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _isValidAction(string calldata action) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(action));
        return h == _A_GENESIS || h == _A_MIGRATE || h == _A_REBALANCE || h == _A_WITHDRAW;
    }

    // ── Core: anchor a proof ──────────────────────────────────────────────────

    /**
     * @notice  Anchor an execution proof on 0G Chain.
     *          Called by the YieldGeko agent after every Arbitrum execution.
     *
     * @param receiptHash  keccak256 fingerprint of execution parameters
     * @param userAddress  The yield strategy owner on Arbitrum
     * @param strategyId   Sub-account strategy identifier; bytes32(0) for default
     * @param action       One of: GENESIS, MIGRATE, REBALANCE, WITHDRAW
     * @param traceCID     0G Storage CID of the full execution trace JSON (max 128 chars)
     * @param attestCID    0G Storage CID of the TEE attestation blob (max 128 chars, empty ok)
     */
    function anchor(
        bytes32 receiptHash,
        address userAddress,
        bytes32 strategyId,
        string calldata action,
        string calldata traceCID,
        string calldata attestCID
    ) external onlyAgent {
        if (receiptHash == bytes32(0)) revert InvalidReceiptHash();
        if (userAddress == address(0)) revert InvalidUserAddress();
        if (_proofs[receiptHash].anchoredAt != 0) revert AlreadyAnchored(receiptHash);

        // Action validation: known value + length guard (fixes LOW-01, MEDIUM-01)
        if (bytes(action).length > MAX_ACTION_LEN) revert ActionTooLong();
        if (!_isValidAction(action)) revert InvalidAction();

        // CID length guards (fixes MEDIUM-01)
        if (bytes(traceCID).length > MAX_CID_LEN) revert CIDTooLong();
        if (bytes(attestCID).length > MAX_CID_LEN) revert CIDTooLong();

        _proofs[receiptHash] = Proof({
            receiptHash: receiptHash,
            userAddress: userAddress,
            anchoredBy: msg.sender,
            strategyId: strategyId,
            action: action,
            traceCID: traceCID,
            attestCID: attestCID,
            anchoredAt: block.timestamp
        });

        _userReceipts[userAddress].push(receiptHash);
        _strategyReceipts[userAddress][strategyId].push(receiptHash);
        totalAnchored++;

        emit ProofAnchored(receiptHash, userAddress, strategyId, action, traceCID, attestCID, block.timestamp);
    }

    // ── Read: single proof ────────────────────────────────────────────────────

    function getProof(bytes32 receiptHash) external view returns (Proof memory) {
        return _proofs[receiptHash];
    }

    function exists(bytes32 receiptHash) external view returns (bool) {
        return _proofs[receiptHash].anchoredAt != 0;
    }

    // ── Read: user history (all strategies) ──────────────────────────────────

    function getUserReceiptCount(address userAddress) external view returns (uint256) {
        return _userReceipts[userAddress].length;
    }

    function getUserReceipts(address userAddress) external view returns (bytes32[] memory) {
        return _userReceipts[userAddress];
    }

    /**
     * @notice Paginated receipt lookup across all strategies for a user.
     * @param offset Start index (0 = oldest)
     * @param limit  Max receipts to return
     */
    function getUserReceiptsPaginated(address userAddress, uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory page, uint256 total)
    {
        bytes32[] storage receipts = _userReceipts[userAddress];
        total = receipts.length;
        if (offset >= total || limit == 0) return (new bytes32[](0), total);

        uint256 end = offset + limit > total ? total : offset + limit;
        page = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = receipts[i];
        }
    }

    /**
     * @notice Get the N most recent proofs for a user across all strategies (newest first).
     *         Capped at MAX_LATEST_N to prevent OOG (fixes LOW-02).
     */
    function getLatestProofs(address userAddress, uint256 n) external view returns (Proof[] memory proofs) {
        if (n > MAX_LATEST_N) n = MAX_LATEST_N;
        bytes32[] storage receipts = _userReceipts[userAddress];
        uint256 total = receipts.length;
        uint256 count = n < total ? n : total;
        proofs = new Proof[](count);
        for (uint256 i = 0; i < count; i++) {
            proofs[i] = _proofs[receipts[total - 1 - i]];
        }
    }

    // ── Read: per-strategy history (multi-strategy wallets) ──────────────────

    function getStrategyReceiptCount(address userAddress, bytes32 strategyId) external view returns (uint256) {
        return _strategyReceipts[userAddress][strategyId].length;
    }

    function getStrategyReceipts(address userAddress, bytes32 strategyId) external view returns (bytes32[] memory) {
        return _strategyReceipts[userAddress][strategyId];
    }

    /**
     * @notice Get the N most recent proofs for a specific strategy (newest first).
     *         Capped at MAX_LATEST_N.
     */
    function getLatestStrategyProofs(address userAddress, bytes32 strategyId, uint256 n)
        external
        view
        returns (Proof[] memory proofs)
    {
        if (n > MAX_LATEST_N) n = MAX_LATEST_N;
        bytes32[] storage receipts = _strategyReceipts[userAddress][strategyId];
        uint256 total = receipts.length;
        uint256 count = n < total ? n : total;
        proofs = new Proof[](count);
        for (uint256 i = 0; i < count; i++) {
            proofs[i] = _proofs[receipts[total - 1 - i]];
        }
    }

    // ── Owner: agent management ───────────────────────────────────────────────

    function setAgentAuthorised(address agent, bool authorised) external onlyOwner {
        if (agent == address(0)) revert InvalidAgentAddress(); // fixes LOW-04
        authorisedAgents[agent] = authorised;
        emit AgentAuthorised(agent, authorised);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
