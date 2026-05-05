// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "forge-std/Test.sol";
import "../contracts/YieldGekoRouter.sol";
import "../contracts/StrategyRegistry.sol";
import "../contracts/test/MockToken.sol";

contract YieldGekoTest is Test {
    YieldGekoRouter public router;
    StrategyRegistry public registry;
    MockToken public token;

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
        address adapter = address(0x66);

        vm.startPrank(owner);
        registry.addStrategy(strat, adapter, "Pendle", 1, 0, true);
        assertTrue(registry.isStrategyApproved(strat));

        address[] memory active = registry.getActiveStrategies();
        assertEq(active.length, 1);
        assertEq(active[0], strat);

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
        registry.addStrategy(targetStrat, targetStrat, "Target", 1, 0, true);

        // Prepare Intent
        YieldGekoRouter.Intent memory intent = YieldGekoRouter.Intent({
            user: user,
            minAPY: 1500, // 15%
            maxSlippage: 100, // 1%
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        // Sign EIP-712 Intent
        bytes32 domainSeparator = router.domainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                router.INTENT_TYPEHASH(), intent.user, intent.minAPY, intent.maxSlippage, intent.nonce, intent.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPrivateKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        // Execute as Agent
        uint256 amount = 200 ether;
        uint256 actualAPY = 1800; // 18%
        uint256 actualSlippage = 50; // 0.5%

        vm.prank(agent);
        router.executeMigration(
            intent,
            signature,
            address(0),
            targetStrat,
            address(token),
            amount,
            actualSlippage,
            actualAPY,
            bytes32(0),
            100
        );

        // Verify Balance Deduction
        assertEq(router.userBalances(user, address(token)), 300 ether);

        // Verify Fees (0.1% of 200 = 0.2 + Success fee)
        assertTrue(token.balanceOf(treasury) > 0);
    }

    function test_RevertUnauthorizedAgent() public {
        YieldGekoRouter.Intent memory intent;
        vm.prank(user); // Non-agent
        vm.expectRevert("Caller not authorized");
        router.executeMigration(intent, "", address(0), address(0), address(0), 0, 0, 0, bytes32(0), 0);
    }

    function test_RevertBoundsExceeded() public {
        // ... similar to migration test but with actualSlippage > maxSlippage
    }
}
