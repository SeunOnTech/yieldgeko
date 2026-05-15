pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../contracts/YieldGekoRegistry.sol";

contract YieldGekoRegistryTest is Test {
    YieldGekoRegistry internal registry;

    address internal owner = address(this);
    address internal agent = makeAddr("agent");
    address internal agent2 = makeAddr("agent2");
    address internal user1 = makeAddr("user1");
    address internal user2 = makeAddr("user2");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant HASH_A = keccak256("execution-a");
    bytes32 internal constant HASH_B = keccak256("execution-b");
    bytes32 internal constant HASH_C = keccak256("execution-c");
    bytes32 internal constant HASH_D = keccak256("execution-d");

    bytes32 internal constant STRATEGY_0 = bytes32(0);
    bytes32 internal constant STRATEGY_1 = keccak256("strategy-conservative");
    bytes32 internal constant STRATEGY_2 = keccak256("strategy-aggressive");

    string internal constant CID_TRACE = "0xabc123trace456def789";
    string internal constant CID_ATTEST = "0xdef456attest789abc123";

    string internal constant CID_TOO_LONG = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1";

    function setUp() public {
        registry = new YieldGekoRegistry();
        registry.setAgentAuthorised(agent, true);
    }

    function test_Constructor_SetsOwner() public view {
        assertEq(registry.owner(), owner);
    }

    function test_Constructor_OwnerIsAuthorisedAgent() public view {
        assertTrue(registry.authorisedAgents(owner));
    }

    function test_Constructor_TotalZero() public view {
        assertEq(registry.totalAnchored(), 0);
    }

    function test_Constructor_EmitsOwnershipTransferredFromZero() public {
        vm.recordLogs();
        YieldGekoRegistry fresh = new YieldGekoRegistry();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool foundOwnership = false;
        bool foundAgent = false;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("OwnershipTransferred(address,address)")) {
                foundOwnership = true;
                address prev = address(uint160(uint256(logs[i].topics[1])));
                assertEq(prev, address(0), "previous owner should be zero");
            }
            if (logs[i].topics[0] == keccak256("AgentAuthorised(address,bool)")) {
                foundAgent = true;
            }
        }
        assertTrue(foundOwnership, "OwnershipTransferred not emitted in constructor");
        assertTrue(foundAgent, "AgentAuthorised not emitted in constructor");
        assertTrue(fresh.authorisedAgents(address(this)));
    }

    function test_Constants_Values() public view {
        assertEq(registry.MAX_ACTION_LEN(), 32);
        assertEq(registry.MAX_CID_LEN(), 128);
        assertEq(registry.MAX_LATEST_N(), 100);
    }

    function test_Anchor_SucceedsFromAgent() public {
        vm.prank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", CID_TRACE, CID_ATTEST);

        YieldGekoRegistry.Proof memory p = registry.getProof(HASH_A);
        assertEq(p.receiptHash, HASH_A);
        assertEq(p.userAddress, user1);
        assertEq(p.anchoredBy, agent);
        assertEq(p.strategyId, STRATEGY_0);
        assertEq(p.action, "GENESIS");
        assertEq(p.traceCID, CID_TRACE);
        assertEq(p.attestCID, CID_ATTEST);
        assertGt(p.anchoredAt, 0);
    }

    function test_Anchor_SucceedsFromOwner() public {
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", CID_TRACE, CID_ATTEST);
        assertTrue(registry.exists(HASH_A));
    }

    function test_Anchor_AllValidActions() public {
        string[4] memory actions = ["GENESIS", "MIGRATE", "REBALANCE", "WITHDRAW"];
        bytes32[4] memory hashes = [keccak256("h1"), keccak256("h2"), keccak256("h3"), keccak256("h4")];
        vm.startPrank(agent);
        for (uint256 i = 0; i < 4; i++) {
            registry.anchor(hashes[i], user1, STRATEGY_0, actions[i], CID_TRACE, CID_ATTEST);
        }
        vm.stopPrank();
        assertEq(registry.totalAnchored(), 4);
    }

    function test_Anchor_EmptyAttestCID_Allowed() public {
        vm.prank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", CID_TRACE, "");
        assertEq(registry.getProof(HASH_A).attestCID, "");
    }

    function test_Anchor_EmptyTraceCID_Allowed() public {
        vm.prank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", "", "");
        assertTrue(registry.exists(HASH_A));
    }

    function test_Anchor_IncrementsTotalAnchored() public {
        vm.startPrank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", CID_TRACE, "");
        registry.anchor(HASH_B, user1, STRATEGY_0, "REBALANCE", CID_TRACE, "");
        registry.anchor(HASH_C, user2, STRATEGY_0, "WITHDRAW", CID_TRACE, "");
        vm.stopPrank();
        assertEq(registry.totalAnchored(), 3);
    }

    function test_Anchor_EmitsProofAnchored() public {
        vm.expectEmit(true, true, true, true);
        emit YieldGekoRegistry.ProofAnchored(
            HASH_A, user1, STRATEGY_0, "GENESIS", CID_TRACE, CID_ATTEST, block.timestamp
        );
        vm.prank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", CID_TRACE, CID_ATTEST);
    }

    function test_Exists_FalseForUnknown() public view {
        assertFalse(registry.exists(HASH_A));
    }

    function test_Exists_TrueAfterAnchor() public {
        vm.prank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", CID_TRACE, "");
        assertTrue(registry.exists(HASH_A));
    }

    function test_Anchor_Reverts_ZeroReceiptHash() public {
        vm.prank(agent);
        vm.expectRevert(YieldGekoRegistry.InvalidReceiptHash.selector);
        registry.anchor(bytes32(0), user1, STRATEGY_0, "GENESIS", CID_TRACE, "");
    }

    function test_Anchor_Reverts_ZeroUserAddress() public {
        vm.prank(agent);
        vm.expectRevert(YieldGekoRegistry.InvalidUserAddress.selector);
        registry.anchor(HASH_A, address(0), STRATEGY_0, "GENESIS", CID_TRACE, "");
    }

    function test_Anchor_Reverts_Duplicate() public {
        vm.startPrank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", CID_TRACE, "");
        vm.expectRevert(abi.encodeWithSelector(YieldGekoRegistry.AlreadyAnchored.selector, HASH_A));
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", CID_TRACE, "");
        vm.stopPrank();
    }

    function test_Anchor_Reverts_UnauthorisedCaller() public {
        vm.prank(stranger);
        vm.expectRevert(YieldGekoRegistry.NotAuthorised.selector);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", CID_TRACE, "");
    }

    function test_Anchor_Reverts_InvalidAction_Junk() public {
        vm.prank(agent);
        vm.expectRevert(YieldGekoRegistry.InvalidAction.selector);
        registry.anchor(HASH_A, user1, STRATEGY_0, "RUGPULL", CID_TRACE, "");
    }

    function test_Anchor_Reverts_InvalidAction_LowerCase() public {
        vm.prank(agent);
        vm.expectRevert(YieldGekoRegistry.InvalidAction.selector);
        registry.anchor(HASH_A, user1, STRATEGY_0, "genesis", CID_TRACE, "");
    }

    function test_Anchor_Reverts_InvalidAction_Empty() public {
        vm.prank(agent);

        vm.expectRevert(YieldGekoRegistry.InvalidAction.selector);
        registry.anchor(HASH_A, user1, STRATEGY_0, "", CID_TRACE, "");
    }

    function test_Anchor_Reverts_ActionTooLong() public {
        string memory longAction = "GENESIS_EXTRA_CHARS_PADDING_HERE_X";
        vm.prank(agent);
        vm.expectRevert(YieldGekoRegistry.ActionTooLong.selector);
        registry.anchor(HASH_A, user1, STRATEGY_0, longAction, CID_TRACE, "");
    }

    function test_Anchor_Reverts_TraceCIDTooLong() public {
        vm.prank(agent);
        vm.expectRevert(YieldGekoRegistry.CIDTooLong.selector);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", CID_TOO_LONG, "");
    }

    function test_Anchor_Reverts_AttestCIDTooLong() public {
        vm.prank(agent);
        vm.expectRevert(YieldGekoRegistry.CIDTooLong.selector);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", "", CID_TOO_LONG);
    }

    function test_Anchor_Accepts_MaxLenCID() public {
        string memory maxCID =
            "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        assertEq(bytes(maxCID).length, 128);
        vm.prank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", maxCID, maxCID);
        assertTrue(registry.exists(HASH_A));
    }

    function test_GetLatestProofs_CapsAtMaxN() public {
        vm.startPrank(agent);
        for (uint256 i = 0; i < 5; i++) {
            bytes32 h = keccak256(abi.encodePacked("cap", i));
            registry.anchor(h, user1, STRATEGY_0, "GENESIS", "", "");
        }
        vm.stopPrank();

        YieldGekoRegistry.Proof[] memory latest = registry.getLatestProofs(user1, 200);
        assertLe(latest.length, registry.MAX_LATEST_N());
        assertEq(latest.length, 5);
    }

    function test_GetLatestProofs_ReturnsNewestFirst() public {
        vm.startPrank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", "", "");
        registry.anchor(HASH_B, user1, STRATEGY_0, "REBALANCE", "", "");
        registry.anchor(HASH_C, user1, STRATEGY_0, "WITHDRAW", "", "");
        vm.stopPrank();

        YieldGekoRegistry.Proof[] memory latest = registry.getLatestProofs(user1, 2);
        assertEq(latest.length, 2);
        assertEq(latest[0].receiptHash, HASH_C);
        assertEq(latest[1].receiptHash, HASH_B);
    }

    function test_GetLatestProofs_NoHistory_ReturnsEmpty() public view {
        assertEq(registry.getLatestProofs(user1, 5).length, 0);
    }

    function test_MultiStrategy_ReceiptsIsolatedByStrategyId() public {
        vm.startPrank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_1, "GENESIS", CID_TRACE, "");
        registry.anchor(HASH_B, user1, STRATEGY_2, "GENESIS", CID_TRACE, "");
        registry.anchor(HASH_C, user1, STRATEGY_1, "REBALANCE", CID_TRACE, "");
        vm.stopPrank();

        assertEq(registry.getStrategyReceiptCount(user1, STRATEGY_1), 2);
        assertEq(registry.getStrategyReceiptCount(user1, STRATEGY_2), 1);

        assertEq(registry.getUserReceiptCount(user1), 3);

        bytes32[] memory s1 = registry.getStrategyReceipts(user1, STRATEGY_1);
        assertEq(s1[0], HASH_A);
        assertEq(s1[1], HASH_C);

        bytes32[] memory s2 = registry.getStrategyReceipts(user1, STRATEGY_2);
        assertEq(s2[0], HASH_B);
    }

    function test_MultiStrategy_StrategyZeroIsDefault() public {
        vm.prank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", "", "");

        assertEq(registry.getStrategyReceiptCount(user1, STRATEGY_0), 1);
        assertEq(registry.getStrategyReceiptCount(user1, STRATEGY_1), 0);
    }

    function test_MultiStrategy_IsolatedBetweenUsers() public {
        vm.startPrank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_1, "GENESIS", "", "");
        registry.anchor(HASH_B, user2, STRATEGY_1, "GENESIS", "", "");
        vm.stopPrank();

        bytes32[] memory u1s1 = registry.getStrategyReceipts(user1, STRATEGY_1);
        bytes32[] memory u2s1 = registry.getStrategyReceipts(user2, STRATEGY_1);

        assertEq(u1s1.length, 1);
        assertEq(u2s1.length, 1);
        assertEq(u1s1[0], HASH_A);
        assertEq(u2s1[0], HASH_B);
    }

    function test_MultiStrategy_GetLatestStrategyProofs() public {
        vm.startPrank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_1, "GENESIS", "", "");
        registry.anchor(HASH_B, user1, STRATEGY_2, "GENESIS", "", "");
        registry.anchor(HASH_C, user1, STRATEGY_1, "REBALANCE", "", "");
        registry.anchor(HASH_D, user1, STRATEGY_1, "WITHDRAW", "", "");
        vm.stopPrank();

        YieldGekoRegistry.Proof[] memory s1 = registry.getLatestStrategyProofs(user1, STRATEGY_1, 2);
        assertEq(s1.length, 2);
        assertEq(s1[0].receiptHash, HASH_D);
        assertEq(s1[1].receiptHash, HASH_C);

        YieldGekoRegistry.Proof[] memory s2 = registry.getLatestStrategyProofs(user1, STRATEGY_2, 10);
        assertEq(s2.length, 1);
        assertEq(s2[0].receiptHash, HASH_B);
    }

    function test_MultiStrategy_ProofStoresCorrectStrategyId() public {
        vm.prank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_1, "GENESIS", CID_TRACE, CID_ATTEST);

        YieldGekoRegistry.Proof memory p = registry.getProof(HASH_A);
        assertEq(p.strategyId, STRATEGY_1);
    }

    function test_UserReceipts_StartsEmpty() public view {
        assertEq(registry.getUserReceiptCount(user1), 0);
        assertEq(registry.getUserReceipts(user1).length, 0);
    }

    function test_UserReceipts_TracksAcrossStrategies() public {
        vm.startPrank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_1, "GENESIS", "", "");
        registry.anchor(HASH_B, user1, STRATEGY_2, "GENESIS", "", "");
        registry.anchor(HASH_C, user2, STRATEGY_0, "GENESIS", "", "");
        vm.stopPrank();

        assertEq(registry.getUserReceiptCount(user1), 2);
        assertEq(registry.getUserReceiptCount(user2), 1);
    }

    function test_Pagination_CorrectPage() public {
        bytes32[5] memory hashes;
        for (uint256 i = 0; i < 5; i++) {
            hashes[i] = keccak256(abi.encodePacked("p", i));
        }
        vm.startPrank(agent);
        for (uint256 i = 0; i < 5; i++) {
            registry.anchor(hashes[i], user1, STRATEGY_0, "GENESIS", "", "");
        }
        vm.stopPrank();

        (bytes32[] memory page, uint256 total) = registry.getUserReceiptsPaginated(user1, 1, 2);
        assertEq(total, 5);
        assertEq(page.length, 2);
        assertEq(page[0], hashes[1]);
        assertEq(page[1], hashes[2]);
    }

    function test_Pagination_OffsetBeyondTotal() public {
        vm.prank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", "", "");
        (bytes32[] memory page, uint256 total) = registry.getUserReceiptsPaginated(user1, 10, 5);
        assertEq(total, 1);
        assertEq(page.length, 0);
    }

    function test_Pagination_ZeroLimit() public {
        vm.prank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", "", "");
        (bytes32[] memory page,) = registry.getUserReceiptsPaginated(user1, 0, 0);
        assertEq(page.length, 0);
    }

    function test_Pagination_LimitExceedsRemaining() public {
        vm.startPrank(agent);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", "", "");
        registry.anchor(HASH_B, user1, STRATEGY_0, "REBALANCE", "", "");
        vm.stopPrank();
        (bytes32[] memory page, uint256 total) = registry.getUserReceiptsPaginated(user1, 1, 100);
        assertEq(total, 2);
        assertEq(page.length, 1);
        assertEq(page[0], HASH_B);
    }

    function test_SetAgentAuthorised_Grants() public {
        registry.setAgentAuthorised(agent2, true);
        assertTrue(registry.authorisedAgents(agent2));

        vm.prank(agent2);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", "", "");
        assertTrue(registry.exists(HASH_A));
    }

    function test_SetAgentAuthorised_Revokes() public {
        registry.setAgentAuthorised(agent, false);
        vm.prank(agent);
        vm.expectRevert(YieldGekoRegistry.NotAuthorised.selector);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", "", "");
    }

    function test_SetAgentAuthorised_Reverts_Stranger() public {
        vm.prank(stranger);
        vm.expectRevert(YieldGekoRegistry.NotOwner.selector);
        registry.setAgentAuthorised(agent2, true);
    }

    function test_SetAgentAuthorised_Reverts_ZeroAddress() public {
        vm.expectRevert(YieldGekoRegistry.InvalidAgentAddress.selector);
        registry.setAgentAuthorised(address(0), true);
    }

    function test_SetAgentAuthorised_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit YieldGekoRegistry.AgentAuthorised(agent2, true);
        registry.setAgentAuthorised(agent2, true);
    }

    function test_TransferOwnership_Works() public {
        address newOwner = makeAddr("newOwner");
        registry.transferOwnership(newOwner);
        assertEq(registry.owner(), newOwner);
    }

    function test_TransferOwnership_Reverts_Stranger() public {
        vm.prank(stranger);
        vm.expectRevert(YieldGekoRegistry.NotOwner.selector);
        registry.transferOwnership(stranger);
    }

    function test_TransferOwnership_Reverts_ZeroAddress() public {
        vm.expectRevert("zero address");
        registry.transferOwnership(address(0));
    }

    function test_TransferOwnership_EmitsEvent() public {
        address newOwner = makeAddr("newOwner");
        vm.expectEmit(true, true, false, false);
        emit YieldGekoRegistry.OwnershipTransferred(owner, newOwner);
        registry.transferOwnership(newOwner);
    }

    function testFuzz_Anchor_StoresCorrectly(bytes32 receiptHash, address userAddress, bytes32 strategyId) public {
        vm.assume(receiptHash != bytes32(0));
        vm.assume(userAddress != address(0));

        vm.prank(agent);
        registry.anchor(receiptHash, userAddress, strategyId, "GENESIS", CID_TRACE, CID_ATTEST);

        YieldGekoRegistry.Proof memory p = registry.getProof(receiptHash);
        assertEq(p.receiptHash, receiptHash);
        assertEq(p.userAddress, userAddress);
        assertEq(p.strategyId, strategyId);
        assertEq(p.action, "GENESIS");
        assertTrue(registry.exists(receiptHash));
        assertEq(registry.getUserReceiptCount(userAddress), 1);
        assertEq(registry.getStrategyReceiptCount(userAddress, strategyId), 1);
    }

    function testFuzz_TotalAnchored_CountsCorrectly(uint8 n) public {
        vm.assume(n > 0 && n <= 50);
        vm.startPrank(agent);
        for (uint256 i = 0; i < n; i++) {
            bytes32 h = keccak256(abi.encodePacked("fuzz", i));
            registry.anchor(h, user1, STRATEGY_0, "GENESIS", "", "");
        }
        vm.stopPrank();
        assertEq(registry.totalAnchored(), n);
    }

    function test_CIDTooLong_Boundary_129Chars_Reverts() public {
        string memory cid129 =
            "12345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678X";
        assertEq(bytes(cid129).length, 129);
        vm.prank(agent);
        vm.expectRevert(YieldGekoRegistry.CIDTooLong.selector);
        registry.anchor(HASH_A, user1, STRATEGY_0, "GENESIS", cid129, "");
    }
}
