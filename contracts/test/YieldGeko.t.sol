// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "forge-std/Test.sol";
import "../contracts/YieldGekoRouter.sol";
import "../contracts/StrategyRegistry.sol";
import "../contracts/test/MockToken.sol";
import "../contracts/test/MockStrategyAdapter.sol";

contract YieldGekoTest is Test {
    uint64 internal constant ARBITRUM_CHAIN_ID = 42161;

    YieldGekoRouter public router;
    StrategyRegistry public registry;
    MockToken public token;
    MockStrategyAdapter public adapter;

    address public owner = address(1);
    address public agent = address(2);
    address public user = address(3);
    address public treasury = address(4);

    uint256 public userPrivateKey = 0x123;

    function setUp() public {
        user = vm.addr(userPrivateKey);

        vm.startPrank(owner);
        registry = new StrategyRegistry();
        router = new YieldGekoRouter(address(registry), agent, treasury);
        token = new MockToken("Stablecoin", "USDC");
        adapter = new MockStrategyAdapter();
        vm.stopPrank();

        token.mint(user, 1000 ether);
    }

    function test_DepositAndWithdraw() public {
        vm.startPrank(user);
        token.approve(address(router), 100 ether);
        router.deposit(address(token), 100 ether);

        assertEq(router.userBalances(user, address(token)), 100 ether);

        router.withdraw(address(token), 40 ether);
        assertEq(router.userBalances(user, address(token)), 60 ether);
        assertEq(token.balanceOf(user), 940 ether);
        vm.stopPrank();
    }

    function test_StrategyManagement() public {
        address strat = address(0x55);
        address strategyAdapter = address(adapter);

        vm.startPrank(owner);
        registry.addStrategy(strat, strategyAdapter, "Pendle", ARBITRUM_CHAIN_ID, 0, true);
        assertTrue(registry.isStrategyApproved(strat));

        address[] memory active = registry.getActiveStrategies();
        assertEq(active.length, 1);
        assertEq(active[0], strat);
        StrategyRegistry.StrategyInfo memory info = registry.getStrategyInfo(strat);
        assertEq(info.chainId, ARBITRUM_CHAIN_ID);

        registry.removeStrategy(strat);
        assertFalse(registry.isStrategyApproved(strat));
        assertEq(registry.getActiveStrategies().length, 0);
        vm.stopPrank();
    }

    function test_MigrationWithIntent() public {
        // Setup
        vm.startPrank(user);
        token.approve(address(router), 500 ether);
        router.deposit(address(token), 500 ether);
        vm.stopPrank();

        address targetStrat = address(0x77);
        vm.prank(owner);
        registry.addStrategy(targetStrat, address(adapter), "Target", ARBITRUM_CHAIN_ID, 0, true);

        // Prepare Intent
        YieldGekoRouter.Intent memory intent = YieldGekoRouter.Intent({
            user: user,
            asset: address(token),
            fromStrategy: address(0),
            toStrategy: targetStrat,
            amount: 200 ether,
            minAPY: 1500, // 15%
            expectedAPY: 1800, // 18% signed by the user for this route
            maxSlippage: 100, // 1%
            maxFee: 1 ether,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        // Sign EIP-712 Intent
        bytes32 domainSeparator = router.domainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                router.INTENT_TYPEHASH(),
                intent.user,
                intent.asset,
                intent.fromStrategy,
                intent.toStrategy,
                intent.amount,
                intent.minAPY,
                intent.expectedAPY,
                intent.maxSlippage,
                intent.maxFee,
                intent.nonce,
                intent.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPrivateKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        // Execute as Agent
        uint256 actualSlippage = 50; // 0.5%
        uint256 gasFee = 100;

        vm.prank(agent);
        router.executeMigration(intent, signature, actualSlippage, bytes32(0), gasFee);

        uint256 expectedMigrationFee = (intent.amount * router.MIGRATION_FEE_BPS()) / 10000;
        uint256 expectedSuccessFee =
            (intent.amount * (intent.expectedAPY - intent.minAPY) * router.SUCCESS_FEE_BPS()) / 100000000;
        uint256 expectedNetAmount = intent.amount - expectedMigrationFee - expectedSuccessFee - gasFee;

        // Idle balance reduced by the migrated principal.
        assertEq(router.userBalances(user, address(token)), 300 ether);
        // Strategy position is now recorded and backed by the adapter.
        assertEq(router.strategyPositions(user, address(token), targetStrat), expectedNetAmount);
        assertEq(adapter.totalManagedByAsset(address(token)), expectedNetAmount);
        assertEq(token.balanceOf(treasury), expectedMigrationFee + expectedSuccessFee + gasFee);
    }

    function test_RevertUnauthorizedAgent() public {
        YieldGekoRouter.Intent memory intent;
        vm.prank(user); // Non-agent
        vm.expectRevert("Caller not authorized");
        router.executeMigration(intent, "", 0, bytes32(0), 0);
    }

    function test_RevertBoundsExceeded() public {
        vm.startPrank(user);
        token.approve(address(router), 500 ether);
        router.deposit(address(token), 500 ether);
        vm.stopPrank();

        address targetStrat = address(0x77);
        vm.prank(owner);
        registry.addStrategy(targetStrat, address(adapter), "Target", ARBITRUM_CHAIN_ID, 0, true);

        YieldGekoRouter.Intent memory intent = YieldGekoRouter.Intent({
            user: user,
            asset: address(token),
            fromStrategy: address(0),
            toStrategy: targetStrat,
            amount: 200 ether,
            minAPY: 1500,
            expectedAPY: 1800,
            maxSlippage: 100,
            maxFee: 1 ether,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        bytes32 domainSeparator = router.domainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                router.INTENT_TYPEHASH(),
                intent.user,
                intent.asset,
                intent.fromStrategy,
                intent.toStrategy,
                intent.amount,
                intent.minAPY,
                intent.expectedAPY,
                intent.maxSlippage,
                intent.maxFee,
                intent.nonce,
                intent.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPrivateKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.prank(agent);
        vm.expectRevert("Slippage exceeds bound");
        router.executeMigration(intent, signature, 101, bytes32(0), 0);
    }

    function test_MigrateFromStrategyToStrategyTracksRealPositions() public {
        vm.startPrank(user);
        token.approve(address(router), 500 ether);
        router.deposit(address(token), 500 ether);
        vm.stopPrank();

        address strategyA = address(0x77);
        address strategyB = address(0x88);
        MockStrategyAdapter adapterB = new MockStrategyAdapter();

        vm.startPrank(owner);
        registry.addStrategy(strategyA, address(adapter), "StrategyA", ARBITRUM_CHAIN_ID, 0, true);
        registry.addStrategy(strategyB, address(adapterB), "StrategyB", ARBITRUM_CHAIN_ID, 0, true);
        vm.stopPrank();

        YieldGekoRouter.Intent memory intoA = YieldGekoRouter.Intent({
            user: user,
            asset: address(token),
            fromStrategy: address(0),
            toStrategy: strategyA,
            amount: 200 ether,
            minAPY: 1500,
            expectedAPY: 1800,
            maxSlippage: 100,
            maxFee: 1 ether,
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        bytes memory sigA = _signIntent(intoA);
        vm.prank(agent);
        router.executeMigration(intoA, sigA, 50, bytes32(0), 100);

        uint256 positionA = router.strategyPositions(user, address(token), strategyA);

        YieldGekoRouter.Intent memory intoB = YieldGekoRouter.Intent({
            user: user,
            asset: address(token),
            fromStrategy: strategyA,
            toStrategy: strategyB,
            amount: positionA,
            minAPY: 1500,
            expectedAPY: 1850,
            maxSlippage: 100,
            maxFee: 1 ether,
            nonce: 1,
            deadline: block.timestamp + 1 hours
        });

        bytes memory sigB = _signIntent(intoB);
        vm.prank(agent);
        router.executeMigration(intoB, sigB, 40, bytes32(0), 100);

        assertEq(router.strategyPositions(user, address(token), strategyA), 0);
        assertGt(router.strategyPositions(user, address(token), strategyB), 0);
        assertEq(adapter.totalManagedByAsset(address(token)), 0);
        assertEq(
            adapterB.totalManagedByAsset(address(token)), router.strategyPositions(user, address(token), strategyB)
        );
    }

    function _signIntent(YieldGekoRouter.Intent memory intent) internal view returns (bytes memory) {
        bytes32 domainSeparator = router.domainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                router.INTENT_TYPEHASH(),
                intent.user,
                intent.asset,
                intent.fromStrategy,
                intent.toStrategy,
                intent.amount,
                intent.minAPY,
                intent.expectedAPY,
                intent.maxSlippage,
                intent.maxFee,
                intent.nonce,
                intent.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPrivateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
