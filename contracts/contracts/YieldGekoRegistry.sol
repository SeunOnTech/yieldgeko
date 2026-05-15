pragma solidity ^0.8.20;

contract YieldGekoRegistry {
    uint256 public constant MAX_ACTION_LEN = 32;
    uint256 public constant MAX_CID_LEN = 128;
    uint256 public constant MAX_LATEST_N = 100;

    bytes32 private constant _A_GENESIS = keccak256("GENESIS");
    bytes32 private constant _A_MIGRATE = keccak256("MIGRATE");
    bytes32 private constant _A_REBALANCE = keccak256("REBALANCE");
    bytes32 private constant _A_WITHDRAW = keccak256("WITHDRAW");

    struct Proof {
        bytes32 receiptHash;
        address userAddress;
        address anchoredBy;
        bytes32 strategyId;
        string action;
        string traceCID;
        string attestCID;
        uint256 anchoredAt;
    }

    mapping(bytes32 => Proof) private _proofs;

    mapping(address => bytes32[]) private _userReceipts;

    mapping(address => mapping(bytes32 => bytes32[])) private _strategyReceipts;

    mapping(address => bool) public authorisedAgents;

    address public owner;
    uint256 public totalAnchored;

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

    error NotOwner();
    error NotAuthorised();
    error InvalidReceiptHash();
    error InvalidUserAddress();
    error InvalidAgentAddress();
    error AlreadyAnchored(bytes32 receiptHash);
    error InvalidAction();
    error ActionTooLong();
    error CIDTooLong();

    constructor() {
        owner = msg.sender;
        authorisedAgents[msg.sender] = true;

        emit OwnershipTransferred(address(0), msg.sender);
        emit AgentAuthorised(msg.sender, true);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (!authorisedAgents[msg.sender]) revert NotAuthorised();
        _;
    }

    function _isValidAction(string calldata action) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(action));
        return h == _A_GENESIS || h == _A_MIGRATE || h == _A_REBALANCE || h == _A_WITHDRAW;
    }

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

        if (bytes(action).length > MAX_ACTION_LEN) revert ActionTooLong();
        if (!_isValidAction(action)) revert InvalidAction();

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

    function getProof(bytes32 receiptHash) external view returns (Proof memory) {
        return _proofs[receiptHash];
    }

    function exists(bytes32 receiptHash) external view returns (bool) {
        return _proofs[receiptHash].anchoredAt != 0;
    }

    function getUserReceiptCount(address userAddress) external view returns (uint256) {
        return _userReceipts[userAddress].length;
    }

    function getUserReceipts(address userAddress) external view returns (bytes32[] memory) {
        return _userReceipts[userAddress];
    }

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

    function getStrategyReceiptCount(address userAddress, bytes32 strategyId) external view returns (uint256) {
        return _strategyReceipts[userAddress][strategyId].length;
    }

    function getStrategyReceipts(address userAddress, bytes32 strategyId) external view returns (bytes32[] memory) {
        return _strategyReceipts[userAddress][strategyId];
    }

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

    function setAgentAuthorised(address agent, bool authorised) external onlyOwner {
        if (agent == address(0)) revert InvalidAgentAddress();
        authorisedAgents[agent] = authorised;
        emit AgentAuthorised(agent, authorised);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
