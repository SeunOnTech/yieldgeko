// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "forge-std/Test.sol";
import "../contracts/YieldGeko.sol";
import "../contracts/test/MockToken.sol";

/**
 * @notice Comprehensive unit tests for YieldGeko.sol (security-hardened version)
 *
 * Coverage:
 *  ✓ Constructor validation
 *  ✓ deposit / withdraw (CEI, idle tracking)
 *  ✓ emergencyWithdraw (mode gate)
 *  ✓ registerPolicy (EIP-712, nonce, expiry, caps)
 *  ✓ revokePolicy
 *  ✓ reportValue + auto-pause on drawdown breach
 *  ✓ executeDeposit (minAPY enforced, managedUSD cap, atomic balance deduction)
 *  ✓ executeWithdraw (actual-return measured, open during emergency)
 *  ✓ execute (generic, paused during emergency)
 *  ✓ executeBatch (atomic, net-flow accounting)
 *  ✓ approveToken (whitelisted spender, blocked during pause)
 *  ✓ collectFee (user maxFeeBps cap enforced, blocked during pause)
 *  ✓ recordExecution (audit trail)
 *  ✓ Target whitelist enforcement across all execute paths
 *  ✓ Policy enforcement (active, expiry, drawdown pause) in all execute paths
 *  ✓ Emergency mode lifecycle (blocks agent, enables self-rescue)
 *  ✓ Admin: setAgent, setTreasury, setDefaultFeeBps, approveTarget, revokeTarget
 *  ✓ Two-step ownership (Ownable2Step)
 */
contract YieldGekoTest is Test {
    // ── Actors ────────────────────────────────────────────────────────────────
    address constant OWNER = address(0x1001);
    address constant AGENT = address(0x1002);
    address constant TREASURY = address(0x1003);
    address constant USER = address(0x1004);
    address constant ATTACKER = address(0x1005);

    uint256 constant USER_KEY = 0xA11CE;

    // ── Contracts ─────────────────────────────────────────────────────────────
    YieldGeko core;
    MockToken token;
    MockToken tokenB;
    MockTarget mockTarget;

    uint256 CHAIN_ID; // set from block.chainid in setUp — correct for both unit + fork

    // ─────────────────────────────────────────────────────────────────────────

    function setUp() public {
        CHAIN_ID = block.chainid;

        vm.startPrank(OWNER);
        core = new YieldGeko(AGENT, TREASURY, 10); // 0.10% default fee
        token = new MockToken("USD Coin", "USDC");
        tokenB = new MockToken("Wrapped Ether", "WETH");
        mockTarget = new MockTarget();
        core.approveTarget(CHAIN_ID, address(mockTarget));
        vm.stopPrank();

        address user = vm.addr(USER_KEY);
        token.mint(user, 100_000e18);
        token.mint(USER, 100_000e18);
        tokenB.mint(user, 100_000e18);
        tokenB.mint(USER, 100_000e18);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _buildPolicy(address user, uint256 nonce) internal view returns (YieldGeko.Policy memory) {
        return YieldGeko.Policy({
            user: user,
            managedUSD: 100_000e18,
            minAPY: 800,
            maxDrawdownBps: 1_000,
            maxFeeBps: 50,
            nonce: nonce,
            deadline: block.timestamp + 1 hours
        });
    }

    function _signPolicy(YieldGeko.Policy memory p) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                core.POLICY_TYPEHASH(),
                p.user,
                p.managedUSD,
                p.minAPY,
                p.maxDrawdownBps,
                p.maxFeeBps,
                p.nonce,
                p.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", core.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _registerUserPolicy() internal returns (address user) {
        user = vm.addr(USER_KEY);
        YieldGeko.Policy memory p = _buildPolicy(user, 0);
        vm.prank(AGENT);
        core.registerPolicy(p, _signPolicy(p));
    }

    function _depositFor(address user, uint256 amount) internal {
        vm.startPrank(user);
        token.approve(address(core), amount);
        core.deposit(address(token), amount);
        vm.stopPrank();
    }

    function _depositTokenBFor(address user, uint256 amount) internal {
        vm.startPrank(user);
        tokenB.approve(address(core), amount);
        core.deposit(address(tokenB), amount);
        vm.stopPrank();
    }

    function _depositAndDeploy(address user, uint256 amount) internal {
        _depositFor(user, amount);
        vm.prank(AGENT);
        bytes memory data = abi.encodeWithSignature("absorb(address,uint256)", address(token), amount);
        // approveToken so mock can pull
        core.approveToken(address(token), address(mockTarget), amount);
        core.executeDeposit(user, address(token), amount, 1000, address(mockTarget), data, bytes32(0));
    }

    // =========================================================================
    // DEPLOYMENT
    // =========================================================================

    function test_Constructor_SetsState() public view {
        assertEq(core.authorizedAgent(), AGENT);
        assertEq(core.treasury(), TREASURY);
        assertEq(core.defaultFeeBps(), 10);
        assertFalse(core.emergencyMode());
    }

    function test_Constructor_Reverts_ZeroAgent() public {
        vm.prank(OWNER);
        vm.expectRevert(YieldGeko.ZeroAddress.selector);
        new YieldGeko(address(0), TREASURY, 10);
    }

    function test_Constructor_Reverts_ZeroTreasury() public {
        vm.prank(OWNER);
        vm.expectRevert(YieldGeko.ZeroAddress.selector);
        new YieldGeko(AGENT, address(0), 10);
    }

    function test_Constructor_Reverts_FeeTooHigh() public {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(YieldGeko.FeeTooHigh.selector, 2001, 2000));
        new YieldGeko(AGENT, TREASURY, 2001);
    }

    // =========================================================================
    // DEPOSIT / WITHDRAW
    // =========================================================================

    function test_Deposit_Credits() public {
        _depositFor(USER, 1_000e18);
        assertEq(core.balances(USER, address(token)), 1_000e18);
    }

    function test_Deposit_Reverts_ZeroAmount() public {
        vm.prank(USER);
        vm.expectRevert(YieldGeko.ZeroAmount.selector);
        core.deposit(address(token), 0);
    }

    function test_Deposit_Reverts_ZeroAsset() public {
        vm.prank(USER);
        vm.expectRevert(YieldGeko.ZeroAddress.selector);
        core.deposit(address(0), 1e18);
    }

    function test_Withdraw_DecreasesBalance() public {
        _depositFor(USER, 1_000e18);
        vm.prank(USER);
        core.withdraw(address(token), 400e18);
        assertEq(core.balances(USER, address(token)), 600e18);
    }

    function test_Withdraw_Reverts_Insufficient() public {
        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(YieldGeko.InsufficientBalance.selector, 0, 1e18));
        core.withdraw(address(token), 1e18);
    }

    // =========================================================================
    // EMERGENCY WITHDRAW
    // =========================================================================

    function test_EmergencyWithdraw_Reverts_WhenModeOff() public {
        _depositFor(USER, 1_000e18);
        vm.prank(USER);
        vm.expectRevert(YieldGeko.EmergencyModeOff.selector);
        core.emergencyWithdraw(address(token));
    }

    function test_EmergencyWithdraw_DrainIdle() public {
        _depositFor(USER, 1_000e18);
        vm.prank(OWNER);
        core.setEmergencyMode(true);
        vm.prank(USER);
        core.emergencyWithdraw(address(token));
        assertEq(core.balances(USER, address(token)), 0);
    }

    function test_EmergencyMode_BlocksAgent_Execute() public {
        address user = _registerUserPolicy();
        vm.prank(OWNER);
        core.setEmergencyMode(true);
        vm.prank(AGENT);
        vm.expectRevert(); // Pausable: paused
        core.execute(user, address(mockTarget), "", bytes32(0), address(token));
    }

    function test_EmergencyMode_BlocksAgent_Deposit() public {
        address user = _registerUserPolicy();
        vm.prank(OWNER);
        core.setEmergencyMode(true);
        vm.prank(AGENT);
        vm.expectRevert();
        core.executeDeposit(user, address(token), 100e18, 1000, address(mockTarget), "", bytes32(0));
    }

    function test_EmergencyMode_BlocksAgent_ApproveToken() public {
        vm.prank(OWNER);
        core.setEmergencyMode(true);
        vm.prank(AGENT);
        vm.expectRevert();
        core.approveToken(address(token), address(mockTarget), 1e18);
    }

    function test_EmergencyMode_BlocksAgent_CollectFee() public {
        address user = _registerUserPolicy();
        _depositFor(user, 1_000e18);
        vm.prank(OWNER);
        core.setEmergencyMode(true);
        vm.prank(AGENT);
        vm.expectRevert();
        core.collectFee(address(token), user, 1_000e18);
    }

    function test_EmergencyMode_AllowsAgent_ExecuteWithdraw() public {
        address user = _registerUserPolicy();
        _depositFor(user, 1_000e18);
        vm.prank(OWNER);
        core.setEmergencyMode(true);
        // executeWithdraw should NOT revert — recovery path stays open
        vm.prank(AGENT);
        bytes memory pingData = abi.encodeWithSignature("ping()");
        core.executeWithdraw(user, address(token), 0, address(mockTarget), pingData, bytes32(0));
    }

    function test_EmergencyMode_CannotUnpauseWhileActive() public {
        vm.prank(OWNER);
        core.setEmergencyMode(true);
        vm.prank(OWNER);
        vm.expectRevert(YieldGeko.EmergencyModeOff.selector);
        core.unpause();
    }

    // =========================================================================
    // POLICY
    // =========================================================================

    function test_RegisterPolicy_Stores() public {
        address user = _registerUserPolicy();
        (bool active, uint256 managedUSD, uint256 minAPY,,,,) = core.policies(user);
        assertTrue(active);
        assertEq(managedUSD, 100_000e18);
        assertEq(minAPY, 800);
        assertEq(core.nonces(user), 1);
    }

    function test_RegisterPolicy_AnyoneCanSubmitValidSig() public {
        address user = vm.addr(USER_KEY);
        YieldGeko.Policy memory p = _buildPolicy(user, 0);
        vm.prank(address(0xBEEF));
        core.registerPolicy(p, _signPolicy(p));
        (bool active,,,,,,) = core.policies(user);
        assertTrue(active);
    }

    function test_RegisterPolicy_Reverts_Expired() public {
        address user = vm.addr(USER_KEY);
        YieldGeko.Policy memory p = _buildPolicy(user, 0);
        p.deadline = block.timestamp - 1;
        bytes memory sig = _signPolicy(p); // compute BEFORE expectRevert — _signPolicy calls core
        vm.expectRevert(YieldGeko.PolicyExpired.selector);
        core.registerPolicy(p, sig);
    }

    function test_RegisterPolicy_Reverts_InvalidSig() public {
        address user = vm.addr(USER_KEY);
        YieldGeko.Policy memory p = _buildPolicy(user, 0);
        bytes memory sig = _signPolicy(p);
        p.managedUSD = 999; // tamper
        vm.expectRevert(YieldGeko.InvalidSignature.selector);
        core.registerPolicy(p, sig);
    }

    function test_RegisterPolicy_Reverts_WrongNonce() public {
        address user = vm.addr(USER_KEY);
        YieldGeko.Policy memory p = _buildPolicy(user, 5);
        bytes memory sig = _signPolicy(p); // compute BEFORE expectRevert
        vm.expectRevert(YieldGeko.InvalidSignature.selector);
        core.registerPolicy(p, sig);
    }

    function test_RegisterPolicy_Reverts_DrawdownTooHigh() public {
        address user = vm.addr(USER_KEY);
        YieldGeko.Policy memory p = _buildPolicy(user, 0);
        p.maxDrawdownBps = 6_000;
        bytes memory sig = _signPolicy(p); // compute BEFORE expectRevert
        vm.expectRevert(abi.encodeWithSelector(YieldGeko.DrawdownTooHigh.selector, 6_000, 5_000));
        core.registerPolicy(p, sig);
    }

    function test_RevokePolicy() public {
        address user = _registerUserPolicy();
        vm.prank(user);
        core.revokePolicy();
        (bool active,,,,,,) = core.policies(user);
        assertFalse(active);
    }

    // =========================================================================
    // DRAWDOWN + AUTO-PAUSE
    // =========================================================================

    function test_ReportValue_UpdatesPeak() public {
        address user = _registerUserPolicy();
        vm.prank(AGENT);
        core.reportValue(user, 10_000e18);
        assertEq(core.peakValues(user), 10_000e18);
        vm.prank(AGENT);
        core.reportValue(user, 12_000e18);
        assertEq(core.peakValues(user), 12_000e18);
    }

    function test_ReportValue_AutoPausesOnDrawdownBreach() public {
        address user = _registerUserPolicy(); // maxDrawdownBps = 1000 (10%)
        vm.prank(AGENT); // set peak
        core.reportValue(user, 10_000e18);
        vm.prank(AGENT); // 20% drop — exceeds 10% threshold
        core.reportValue(user, 8_000e18);
        assertTrue(core.userPaused(user));
    }

    function test_ReportValue_DoesNotPauseBelowThreshold() public {
        address user = _registerUserPolicy();
        vm.prank(AGENT);
        core.reportValue(user, 10_000e18);
        vm.prank(AGENT); // 5% drop — below 10% threshold
        core.reportValue(user, 9_500e18);
        assertFalse(core.userPaused(user));
    }

    function test_ExecuteDeposit_Reverts_UserPaused() public {
        address user = _registerUserPolicy();
        vm.prank(AGENT);
        core.reportValue(user, 10_000e18);
        vm.prank(AGENT); // auto-pause
        core.reportValue(user, 8_000e18);
        _depositFor(user, 1_000e18);
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(YieldGeko.UserPausedByDrawdown.selector, user));
        core.executeDeposit(user, address(token), 100e18, 1000, address(mockTarget), "", bytes32(0));
    }

    function test_ResumeUser_ClearsDrawdownPause() public {
        address user = _registerUserPolicy();
        vm.prank(AGENT);
        core.reportValue(user, 10_000e18);
        vm.prank(AGENT);
        core.reportValue(user, 8_000e18);
        assertTrue(core.userPaused(user));
        vm.prank(OWNER);
        core.resumeUser(user);
        assertFalse(core.userPaused(user));
    }

    // =========================================================================
    // EXECUTE DEPOSIT — minAPY + managedUSD enforcement
    // =========================================================================

    function test_ExecuteDeposit_Reverts_APYTooLow() public {
        address user = _registerUserPolicy(); // minAPY = 800
        _depositFor(user, 1_000e18);
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(YieldGeko.APYTooLow.selector, 700, 800));
        core.executeDeposit(user, address(token), 500e18, 700, address(mockTarget), "", bytes32(0));
    }

    function test_ExecuteDeposit_Reverts_ExceedsManaged() public {
        address user = _registerUserPolicy(); // managedUSD = 100_000e18
        // deposit more than managed cap
        token.mint(user, 200_000e18);
        _depositFor(user, 100_001e18);
        vm.prank(AGENT);
        vm.expectRevert(); // ExceedsManagedCapacity
        core.executeDeposit(user, address(token), 100_001e18, 1000, address(mockTarget), "", bytes32(0));
    }

    function test_ExecuteDeposit_AtomicBalanceDeduction() public {
        address user = _registerUserPolicy();
        _depositFor(user, 1_000e18);
        vm.startPrank(AGENT);
        core.approveToken(address(token), address(mockTarget), 500e18);
        bytes memory data = abi.encodeWithSignature("absorb(address,uint256)", address(token), 500e18);
        core.executeDeposit(user, address(token), 500e18, 1000, address(mockTarget), data, keccak256("r1"));
        vm.stopPrank();
        assertEq(core.balances(user, address(token)), 500e18);
        assertEq(core.deployed(user, address(token)), 500e18);
        assertEq(core.totalFunds(user, address(token)), 1_000e18);
    }

    function test_ExecuteDeposit_AccountsMeasuredSpend_NotDeclaredAmount() public {
        address user = _registerUserPolicy();
        _depositFor(user, 1_000e18);

        vm.startPrank(AGENT);
        core.approveToken(address(token), address(mockTarget), 500e18);
        bytes memory data = abi.encodeWithSignature("absorb(address,uint256)", address(token), 400e18);
        core.executeDeposit(user, address(token), 500e18, 1000, address(mockTarget), data, keccak256("partial"));
        vm.stopPrank();

        assertEq(core.balances(user, address(token)), 600e18);
        assertEq(core.deployed(user, address(token)), 400e18);
        assertEq(token.balanceOf(address(core)), 600e18);
    }

    function test_ExecuteDeposit_Reverts_IfProtocolSpendsMoreThanDeclared() public {
        address user = _registerUserPolicy();
        _depositFor(user, 1_000e18);

        vm.startPrank(AGENT);
        core.approveToken(address(token), address(mockTarget), 700e18);
        bytes memory data = abi.encodeWithSignature("absorb(address,uint256)", address(token), 700e18);
        vm.expectRevert(abi.encodeWithSelector(YieldGeko.InsufficientBalance.selector, 500e18, 700e18));
        core.executeDeposit(user, address(token), 500e18, 1000, address(mockTarget), data, keccak256("overspend"));
        vm.stopPrank();

        assertEq(core.balances(user, address(token)), 1_000e18);
        assertEq(core.deployed(user, address(token)), 0);
        assertEq(token.balanceOf(address(core)), 1_000e18);
    }

    function test_ExecuteDeposit_Reverts_IfProtocolSpendsNothing() public {
        address user = _registerUserPolicy();
        _depositFor(user, 1_000e18);

        vm.prank(AGENT);
        vm.expectRevert(YieldGeko.ZeroAmount.selector);
        core.executeDeposit(
            user,
            address(token),
            500e18,
            1000,
            address(mockTarget),
            abi.encodeWithSignature("ping()"),
            keccak256("noop")
        );
    }

    function test_ExecuteDeposit_EmitsActionExecuted() public {
        address user = _registerUserPolicy();
        _depositFor(user, 1_000e18);
        vm.startPrank(AGENT);
        core.approveToken(address(token), address(mockTarget), 500e18);
        bytes memory data = abi.encodeWithSignature("absorb(address,uint256)", address(token), 500e18);
        vm.expectEmit(true, true, false, false);
        emit YieldGeko.ActionExecuted(user, address(mockTarget), keccak256("r1"), block.timestamp);
        core.executeDeposit(user, address(token), 500e18, 1000, address(mockTarget), data, keccak256("r1"));
        vm.stopPrank();
    }

    // =========================================================================
    // EXECUTE WITHDRAW — actual return measured
    // =========================================================================

    function test_ExecuteWithdraw_MeasuresActualReturn() public {
        address user = _registerUserPolicy();
        _depositFor(user, 1_000e18);
        vm.startPrank(AGENT);
        core.approveToken(address(token), address(mockTarget), 1_000e18);
        bytes memory depData = abi.encodeWithSignature("absorb(address,uint256)", address(token), 1_000e18);
        core.executeDeposit(user, address(token), 1_000e18, 1000, address(mockTarget), depData, bytes32(0));

        token.mint(address(mockTarget), 50e18); // simulate 5% yield
        bytes memory wdData = abi.encodeWithSignature("release(address,uint256)", address(token), 1_050e18);
        core.executeWithdraw(user, address(token), 1_000e18, address(mockTarget), wdData, keccak256("r2"));
        vm.stopPrank();

        // surplus = 1050 - 1000 = 50, feeBps = 10, fee = 50e18 * 10 / 10_000 = 5e16
        uint256 fee = (50e18 * 10) / 10_000;
        assertEq(core.balances(user, address(token)), 1_050e18 - fee);
        assertEq(core.deployed(user, address(token)), 0);
        assertEq(token.balanceOf(TREASURY), fee);
    }

    function test_ExecuteWithdraw_NoFeeOnIL() public {
        address user = _registerUserPolicy();
        _depositFor(user, 1_000e18);
        vm.startPrank(AGENT);
        core.approveToken(address(token), address(mockTarget), 1_000e18);
        core.executeDeposit(
            user,
            address(token),
            1_000e18,
            1000,
            address(mockTarget),
            abi.encodeWithSignature("absorb(address,uint256)", address(token), 1_000e18),
            bytes32(0)
        );

        // Protocol only returns 900 (10% IL) — no fee charged, full return credited
        bytes memory wdData = abi.encodeWithSignature("release(address,uint256)", address(token), 900e18);
        core.executeWithdraw(user, address(token), 1_000e18, address(mockTarget), wdData, keccak256("il"));
        vm.stopPrank();

        assertEq(core.balances(user, address(token)), 900e18);
        assertEq(core.deployed(user, address(token)), 0);
        assertEq(token.balanceOf(TREASURY), 0);
    }

    function test_ExecuteWithdraw_OpenDuringEmergency() public {
        address user = _registerUserPolicy();
        vm.prank(OWNER);
        core.setEmergencyMode(true);
        // Should not revert
        vm.prank(AGENT);
        bytes memory pingData = abi.encodeWithSignature("ping()");
        core.executeWithdraw(user, address(token), 0, address(mockTarget), pingData, keccak256("r"));
    }

    // =========================================================================
    // EXECUTE (generic)
    // =========================================================================

    function test_Execute_CallsTarget() public {
        address user = _registerUserPolicy();
        vm.prank(AGENT);
        core.execute(user, address(mockTarget), abi.encodeWithSignature("ping()"), bytes32(0), address(token));
        assertEq(mockTarget.callCount(), 1);
    }

    function test_Execute_Reverts_NoPolicy() public {
        vm.prank(AGENT);
        vm.expectRevert(YieldGeko.PolicyNotActive.selector);
        core.execute(USER, address(mockTarget), "", bytes32(0), address(token));
    }

    function test_Execute_Reverts_PolicyExpired() public {
        address user = _registerUserPolicy();
        vm.warp(block.timestamp + 366 days);
        vm.prank(AGENT);
        vm.expectRevert(YieldGeko.PolicyExpired.selector);
        core.execute(user, address(mockTarget), "", bytes32(0), address(token));
    }

    function test_Execute_Reverts_NotAgent() public {
        address user = _registerUserPolicy();
        vm.prank(ATTACKER);
        vm.expectRevert(YieldGeko.NotAgent.selector);
        core.execute(user, address(mockTarget), "", bytes32(0), address(token));
    }

    function test_Execute_Reverts_UnwhitelistedTarget() public {
        address user = _registerUserPolicy();
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(YieldGeko.TargetNotApproved.selector, address(0xBAD)));
        core.execute(user, address(0xBAD), "", bytes32(0), address(token));
    }

    function test_Execute_Reverts_UnguardedGenericCall() public {
        address user = _registerUserPolicy();
        vm.prank(AGENT);
        vm.expectRevert(YieldGeko.UnsafeGenericExecution.selector);
        core.execute(user, address(mockTarget), abi.encodeWithSignature("ping()"), bytes32(0), address(0));
    }

    function test_Execute_Reverts_IfApprovedAssetBalanceDecreases() public {
        address user = _registerUserPolicy();
        _depositFor(user, 1_000e18);

        vm.startPrank(AGENT);
        core.approveToken(address(token), address(mockTarget), 500e18);
        bytes memory data = abi.encodeWithSignature("absorb(address,uint256)", address(token), 500e18);
        vm.expectRevert();
        core.execute(user, address(mockTarget), data, keccak256("guarded-drain"), address(token));
        vm.stopPrank();

        assertEq(core.balances(user, address(token)), 1_000e18);
        assertEq(core.deployed(user, address(token)), 0);
        assertEq(token.balanceOf(address(core)), 1_000e18);
    }

    // =========================================================================
    // EXECUTE BATCH
    // =========================================================================

    function test_ExecuteBatch_MeasuresNetFlow() public {
        address user = _registerUserPolicy();
        _depositFor(user, 2_000e18);

        address[] memory targets = new address[](2);
        bytes[] memory data = new bytes[](2);
        targets[0] = address(mockTarget);
        data[0] = abi.encodeWithSignature("absorb(address,uint256)", address(token), 2_000e18);
        targets[1] = address(mockTarget);
        data[1] = abi.encodeWithSignature("ping()");

        vm.startPrank(AGENT);
        core.approveToken(address(token), address(mockTarget), 2_000e18);
        core.executeBatch(user, address(token), targets, data, keccak256("batch"));
        vm.stopPrank();

        assertEq(core.balances(user, address(token)), 0);
        assertEq(core.deployed(user, address(token)), 2_000e18);
    }

    function test_ExecuteBatch_RevertsAtomically() public {
        address user = _registerUserPolicy();
        address[] memory targets = new address[](2);
        bytes[] memory data = new bytes[](2);
        targets[0] = address(mockTarget);
        data[0] = abi.encodeWithSignature("ping()");
        targets[1] = address(mockTarget);
        data[1] = abi.encodeWithSignature("fail()");

        vm.prank(AGENT);
        vm.expectRevert("Batch step failed");
        core.executeBatch(user, address(token), targets, data, bytes32(0));
        assertEq(mockTarget.callCount(), 0);
    }

    function test_ExecuteBatch_Reverts_LengthMismatch() public {
        address user = _registerUserPolicy();
        vm.prank(AGENT);
        vm.expectRevert(YieldGeko.LengthMismatch.selector);
        core.executeBatch(user, address(token), new address[](2), new bytes[](1), bytes32(0));
    }

    function test_ExecuteBatch_Reverts_IfUndeclaredProtectedAssetDecreases() public {
        address user = _registerUserPolicy();
        _depositFor(user, 1_000e18);
        _depositTokenBFor(user, 500e18);

        address[] memory targets = new address[](1);
        bytes[] memory data = new bytes[](1);
        targets[0] = address(mockTarget);
        data[0] = abi.encodeWithSignature("absorb(address,uint256)", address(tokenB), 100e18);

        vm.startPrank(AGENT);
        core.approveToken(address(tokenB), address(mockTarget), 100e18);
        vm.expectRevert();
        core.executeBatch(user, address(token), targets, data, keccak256("undeclared-asset"));
        vm.stopPrank();

        assertEq(core.balances(user, address(token)), 1_000e18);
        assertEq(core.balances(user, address(tokenB)), 500e18);
        assertEq(core.deployed(user, address(tokenB)), 0);
    }

    function test_ExecuteBatchMulti_AccountsMultipleAssets() public {
        address user = _registerUserPolicy();
        _depositFor(user, 1_000e18);
        _depositTokenBFor(user, 2e18);

        address[] memory assets = new address[](2);
        assets[0] = address(token);
        assets[1] = address(tokenB);

        address[] memory targets = new address[](2);
        bytes[] memory data = new bytes[](2);
        targets[0] = address(mockTarget);
        data[0] = abi.encodeWithSignature("absorb(address,uint256)", address(token), 1_000e18);
        targets[1] = address(mockTarget);
        data[1] = abi.encodeWithSignature("absorb(address,uint256)", address(tokenB), 2e18);

        vm.startPrank(AGENT);
        core.approveToken(address(token), address(mockTarget), 1_000e18);
        core.approveToken(address(tokenB), address(mockTarget), 2e18);
        core.executeBatchMulti(user, assets, targets, data, keccak256("multi"));
        vm.stopPrank();

        assertEq(core.balances(user, address(token)), 0);
        assertEq(core.balances(user, address(tokenB)), 0);
        assertEq(core.deployed(user, address(token)), 1_000e18);
        assertEq(core.deployed(user, address(tokenB)), 2e18);
    }

    function test_ExecuteBatchMulti_Reverts_DuplicateAsset() public {
        address user = _registerUserPolicy();

        address[] memory assets = new address[](2);
        assets[0] = address(token);
        assets[1] = address(token);

        vm.prank(AGENT);
        vm.expectRevert(YieldGeko.LengthMismatch.selector);
        core.executeBatchMulti(user, assets, new address[](0), new bytes[](0), bytes32(0));
    }

    function test_ExecuteWithdrawMulti_AccountsMultipleReturnedAssets() public {
        address user = _registerUserPolicy();
        _depositFor(user, 1_000e18);
        _depositTokenBFor(user, 2e18);

        address[] memory assets = new address[](2);
        assets[0] = address(token);
        assets[1] = address(tokenB);

        address[] memory targets = new address[](2);
        bytes[] memory data = new bytes[](2);
        targets[0] = address(mockTarget);
        data[0] = abi.encodeWithSignature("absorb(address,uint256)", address(token), 1_000e18);
        targets[1] = address(mockTarget);
        data[1] = abi.encodeWithSignature("absorb(address,uint256)", address(tokenB), 2e18);

        vm.startPrank(AGENT);
        core.approveToken(address(token), address(mockTarget), 1_000e18);
        core.approveToken(address(tokenB), address(mockTarget), 2e18);
        core.executeBatchMulti(user, assets, targets, data, keccak256("multi-deploy"));

        token.mint(address(mockTarget), 100e18);
        tokenB.mint(address(mockTarget), 1e18);
        bytes memory wdData = abi.encodeWithSignature(
            "releaseTwo(address,uint256,address,uint256)", address(token), 1_100e18, address(tokenB), 3e18
        );
        uint256[] memory deployedAmounts = new uint256[](2);
        deployedAmounts[0] = 1_000e18;
        deployedAmounts[1] = 2e18;
        core.executeWithdrawMulti(
            user, assets, deployedAmounts, address(mockTarget), wdData, keccak256("multi-withdraw")
        );
        vm.stopPrank();

        assertEq(core.deployed(user, address(token)), 0);
        assertEq(core.deployed(user, address(tokenB)), 0);
        // token: surplus=100e18, feeBps=10 → fee=1e16
        // tokenB: surplus=1e18, feeBps=10 → fee=1e14
        uint256 feeToken = (100e18 * 10) / 10_000;
        uint256 feeTokenB = (1e18 * 10) / 10_000;
        assertEq(core.balances(user, address(token)), 1_100e18 - feeToken);
        assertEq(core.balances(user, address(tokenB)), 3e18 - feeTokenB);
    }

    function test_ExecuteWithdrawMulti_Reverts_DuplicateAsset() public {
        address user = _registerUserPolicy();
        address[] memory assets = new address[](2);
        assets[0] = address(token);
        assets[1] = address(token);
        uint256[] memory deployedAmounts = new uint256[](2);

        vm.prank(AGENT);
        vm.expectRevert(YieldGeko.LengthMismatch.selector);
        core.executeWithdrawMulti(user, assets, deployedAmounts, address(mockTarget), "", bytes32(0));
    }

    // =========================================================================
    // APPROVE TOKEN
    // =========================================================================

    function test_ApproveToken_SetsAllowance() public {
        vm.prank(AGENT);
        core.approveToken(address(token), address(mockTarget), 500e18);
        assertEq(token.allowance(address(core), address(mockTarget)), 500e18);
    }

    function test_ApproveToken_Reverts_UnwhitelistedSpender() public {
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(YieldGeko.TargetNotApproved.selector, address(0xBAD)));
        core.approveToken(address(token), address(0xBAD), 1e18);
    }

    // =========================================================================
    // FEE COLLECTION
    // =========================================================================

    function test_CollectFee_UsesMinOfDefaultAndMax() public {
        address user = _registerUserPolicy(); // maxFeeBps = 50
        _depositFor(user, 1_000e18);
        // defaultFeeBps = 10 < maxFeeBps = 50 → charge 10 (0.10%)
        vm.prank(AGENT);
        uint256 net = core.collectFee(address(token), user, 1_000e18);
        uint256 fee = (1_000e18 * 10) / 10_000;
        assertEq(net, 1_000e18 - fee);
        assertEq(token.balanceOf(TREASURY), fee);
    }

    function test_CollectFee_CappedAtUserMaxFeeBps() public {
        vm.prank(OWNER); // raise to 1%
        core.setDefaultFeeBps(100);
        address user = _registerUserPolicy(); // maxFeeBps = 50 (0.5%)
        _depositFor(user, 1_000e18);
        vm.prank(AGENT);
        uint256 net = core.collectFee(address(token), user, 1_000e18);
        // Must use 50 bps, NOT 100 bps
        uint256 expectedFee = (1_000e18 * 50) / 10_000;
        assertEq(net, 1_000e18 - expectedFee);
    }

    function test_CollectFee_BlockedDuringEmergency() public {
        address user = _registerUserPolicy();
        _depositFor(user, 1_000e18);
        vm.prank(OWNER);
        core.setEmergencyMode(true);
        vm.prank(AGENT);
        vm.expectRevert();
        core.collectFee(address(token), user, 1_000e18);
    }

    // =========================================================================
    // AUDIT TRAIL
    // =========================================================================

    function test_RecordExecution_StoresEntry() public {
        address user = _registerUserPolicy();
        vm.prank(AGENT);
        core.recordExecution(user, keccak256("r"), 42161, "GENESIS", 10_000e18);
        assertEq(core.getExecutionCount(user), 1);
        YieldGeko.ExecutionRecord[] memory execs = core.getExecutions(user);
        assertEq(execs[0].chainId, 42161);
        assertEq(execs[0].amountUSD, 10_000e18);
    }

    function test_RecordExecution_Reverts_NoPolicy() public {
        vm.prank(AGENT);
        vm.expectRevert(YieldGeko.PolicyNotActive.selector);
        core.recordExecution(USER, bytes32(0), 42161, "GENESIS", 0);
    }

    // =========================================================================
    // ADMIN
    // =========================================================================

    function test_ApproveTarget_Whitelist() public {
        vm.prank(OWNER);
        core.approveTarget(42161, address(0xABC));
        assertTrue(core.approvedTargets(42161, address(0xABC)));
    }

    function test_RevokeTarget() public {
        vm.prank(OWNER);
        core.revokeTarget(CHAIN_ID, address(mockTarget));
        assertFalse(core.approvedTargets(CHAIN_ID, address(mockTarget)));
    }

    function test_SetAgent_Updates() public {
        vm.prank(OWNER);
        core.setAgent(address(0xA9E47));
        assertEq(core.authorizedAgent(), address(0xA9E47));
    }

    function test_SetAgent_Reverts_Zero() public {
        vm.prank(OWNER);
        vm.expectRevert(YieldGeko.ZeroAddress.selector);
        core.setAgent(address(0));
    }

    function test_SetDefaultFeeBps_Reverts_TooHigh() public {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(YieldGeko.FeeTooHigh.selector, 2001, 2000));
        core.setDefaultFeeBps(2001);
    }

    function test_OnlyOwner_CanApproveTarget() public {
        vm.prank(ATTACKER);
        vm.expectRevert();
        core.approveTarget(42161, address(0xABC));
    }

    // =========================================================================
    // TWO-STEP OWNERSHIP
    // =========================================================================

    function test_Ownership_TwoStep() public {
        vm.prank(OWNER);
        core.transferOwnership(ATTACKER);
        assertEq(core.owner(), OWNER); // not transferred yet
        assertEq(core.pendingOwner(), ATTACKER);
        vm.prank(ATTACKER);
        core.acceptOwnership();
        assertEq(core.owner(), ATTACKER);
    }

    function test_Ownership_CannotAcceptIfNotPending() public {
        vm.prank(ATTACKER);
        vm.expectRevert();
        core.acceptOwnership();
    }

    // =========================================================================
    // SECURITY — audit findings (regression suite)
    // =========================================================================

    /// Finding 1: understated deployedAmount must not leave deployed overstated.
    /// Agent returns 1_000 but claims only 1 was deployed.
    /// deployed should reach 0 (not 999) because max(1, 1000) is used.
    function test_ExecuteWithdraw_UnderstatedDeployedAmount_CannotCorruptAccounting() public {
        address user = _registerUserPolicy();
        _depositFor(user, 1_000e18);
        vm.startPrank(AGENT);
        core.approveToken(address(token), address(mockTarget), 1_000e18);
        core.executeDeposit(
            user,
            address(token),
            1_000e18,
            1000,
            address(mockTarget),
            abi.encodeWithSignature("absorb(address,uint256)", address(token), 1_000e18),
            bytes32(0)
        );

        // Agent understates deployedAmount by 999 — claims only 1 was deployed.
        // The protocol still returns all 1_000 tokens.
        bytes memory wdData = abi.encodeWithSignature("release(address,uint256)", address(token), 1_000e18);
        core.executeWithdraw(user, address(token), 1, address(mockTarget), wdData, keccak256("r_understate"));
        vm.stopPrank();

        // Ghost deployed must be zero — max(deployedAmount=1, returned=1000) was used.
        assertEq(core.deployed(user, address(token)), 0, "ghost deployed balance");
        // surplus ≈ 1000e18, feeBps=10 → fee ≈ 1e18 (exact: (1000e18-1)*10/10000)
        uint256 returned_ = 1_000e18;
        uint256 fee = ((returned_ - 1) * 10) / 10_000;
        assertEq(core.balances(user, address(token)), 1_000e18 - fee, "idle balance after fee");
    }

    /// Finding 2: drawdown pause must block execute() as well, not only fund-moving paths.
    function test_Execute_Reverts_WhenUserPaused() public {
        address user = _registerUserPolicy();
        _depositFor(user, 10_000e18);

        // Trigger drawdown auto-pause via reportValue
        vm.startPrank(AGENT);
        core.reportValue(user, 10_000e18); // establish peak
        core.reportValue(user, 8_000e18); // -20% drawdown — exceeds 10% maxDrawdownBps policy
        vm.stopPrank();

        assertTrue(core.userPaused(user), "user should be paused");

        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(YieldGeko.UserPausedByDrawdown.selector, user));
        core.execute(user, address(mockTarget), abi.encodeWithSignature("ping()"), bytes32(0), address(token));
    }

    /// Finding 3: executeWithdraw must work even when the user's policy is expired,
    /// so deployed funds can always be unwound and users can self-rescue.
    function test_ExecuteWithdraw_WorksAfterPolicyExpiry() public {
        address user = _registerUserPolicy();
        _depositFor(user, 1_000e18);
        vm.startPrank(AGENT);
        core.approveToken(address(token), address(mockTarget), 1_000e18);
        core.executeDeposit(
            user,
            address(token),
            1_000e18,
            1000,
            address(mockTarget),
            abi.encodeWithSignature("absorb(address,uint256)", address(token), 1_000e18),
            bytes32(0)
        );
        vm.stopPrank();

        // Policy expires
        vm.warp(block.timestamp + 366 days);

        // executeWithdraw must still succeed — recovery path stays open
        bytes memory wdData = abi.encodeWithSignature("release(address,uint256)", address(token), 1_000e18);
        vm.prank(AGENT);
        core.executeWithdraw(user, address(token), 1_000e18, address(mockTarget), wdData, keccak256("r_expiry"));

        assertEq(core.deployed(user, address(token)), 0);
        assertEq(core.balances(user, address(token)), 1_000e18);
    }

    /// Finding 4: re-registering a policy must clear any prior drawdown pause.
    function test_RegisterPolicy_ClearsDrawdownPause() public {
        address user = _registerUserPolicy();
        _depositFor(user, 10_000e18);

        // Pause via drawdown
        vm.startPrank(AGENT);
        core.reportValue(user, 10_000e18);
        core.reportValue(user, 8_000e18);
        vm.stopPrank();
        assertTrue(core.userPaused(user));

        // Warp so the old nonce can be reused in a fresh policy
        vm.warp(block.timestamp + 1);

        // Register a new policy with incremented nonce — should clear pause
        uint256 newNonce = core.nonces(user);
        YieldGeko.Policy memory p = YieldGeko.Policy({
            user: user,
            managedUSD: 100_000e18,
            minAPY: 0,
            maxDrawdownBps: 1000,
            maxFeeBps: 50,
            nonce: newNonce,
            deadline: block.timestamp + 1 days
        });
        bytes memory sig = _signPolicy(p);
        vm.prank(user);
        core.registerPolicy(p, sig);

        assertFalse(core.userPaused(user), "pause should be cleared by new policy");
    }

    /// Finding 5 (regression): collectFee must be blocked after policy is revoked.
    function test_CollectFee_Reverts_AfterPolicyRevoked() public {
        address user = _registerUserPolicy();
        _depositFor(user, 1_000e18);

        vm.prank(user);
        core.revokePolicy();

        vm.prank(AGENT);
        vm.expectRevert(YieldGeko.PolicyNotActive.selector);
        core.collectFee(address(token), user, 1_000e18);
    }

    // =========================================================================
    // EXECUTE HARVEST — auto-fee on harvested yield
    // =========================================================================

    function test_ExecuteHarvest_AutoFeeOnHarvested() public {
        address user = _registerUserPolicy();
        // Fund mock to simulate reward collection (e.g. UniV3 fee income)
        token.mint(address(mockTarget), 100e18);

        address[] memory targets = new address[](1);
        bytes[] memory data = new bytes[](1);
        targets[0] = address(mockTarget);
        data[0] = abi.encodeWithSignature("release(address,uint256)", address(token), 100e18);

        vm.prank(AGENT);
        core.executeHarvest(user, address(token), targets, data, keccak256("harvest1"));

        // harvested=100e18, feeBps=10 → fee=1e16
        uint256 fee = (100e18 * 10) / 10_000;
        assertEq(core.balances(user, address(token)), 100e18 - fee);
        assertEq(token.balanceOf(TREASURY), fee);
    }

    function test_ExecuteHarvest_NoFeeWhenZeroHarvested() public {
        address user = _registerUserPolicy();

        address[] memory targets = new address[](1);
        bytes[] memory data = new bytes[](1);
        targets[0] = address(mockTarget);
        data[0] = abi.encodeWithSignature("ping()"); // no token movement

        vm.prank(AGENT);
        core.executeHarvest(user, address(token), targets, data, keccak256("harvest-noop"));

        assertEq(core.balances(user, address(token)), 0);
        assertEq(token.balanceOf(TREASURY), 0);
    }

    function test_ExecuteHarvest_BlockedDuringEmergency() public {
        address user = _registerUserPolicy();
        vm.prank(OWNER);
        core.setEmergencyMode(true);

        address[] memory targets = new address[](1);
        bytes[] memory data = new bytes[](1);
        targets[0] = address(mockTarget);
        data[0] = abi.encodeWithSignature("ping()");

        vm.prank(AGENT);
        vm.expectRevert();
        core.executeHarvest(user, address(token), targets, data, bytes32(0));
    }

    function test_ExecuteHarvest_Reverts_UnapprovedTarget() public {
        address user = _registerUserPolicy();

        address[] memory targets = new address[](1);
        bytes[] memory data = new bytes[](1);
        targets[0] = address(0xBAD);
        data[0] = abi.encodeWithSignature("ping()");

        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(YieldGeko.TargetNotApproved.selector, address(0xBAD)));
        core.executeHarvest(user, address(token), targets, data, bytes32(0));
    }

    function test_ExecuteHarvest_Reverts_NoPolicy() public {
        address[] memory targets = new address[](1);
        bytes[] memory data = new bytes[](1);
        targets[0] = address(mockTarget);
        data[0] = abi.encodeWithSignature("ping()");

        vm.prank(AGENT);
        vm.expectRevert(YieldGeko.PolicyNotActive.selector);
        core.executeHarvest(USER, address(token), targets, data, bytes32(0));
    }

    function test_ExecuteHarvest_MultiStep_AtomicCollectAndSwap() public {
        address user = _registerUserPolicy();
        // Simulate: step1 absorbs tokenB (volatile), step2 releases token (USDC normalised)
        tokenB.mint(address(core), 1e18); // vault "receives" volatile from collect
        token.mint(address(mockTarget), 3_000e6); // mock "returns" USDC after swap

        address[] memory targets = new address[](2);
        bytes[] memory data = new bytes[](2);
        targets[0] = address(mockTarget);
        data[0] = abi.encodeWithSignature("absorb(address,uint256)", address(tokenB), 1e18); // consume volatile
        targets[1] = address(mockTarget);
        data[1] = abi.encodeWithSignature("release(address,uint256)", address(token), 3_000e6); // emit USDC
        vm.startPrank(AGENT);
        core.approveToken(address(tokenB), address(mockTarget), 1e18);
        core.executeHarvest(user, address(token), targets, data, keccak256("harvest-swap"));
        vm.stopPrank();

        uint256 fee = (3_000e6 * 10) / 10_000;
        assertEq(core.balances(user, address(token)), 3_000e6 - fee);
        assertEq(token.balanceOf(TREASURY), fee);
    }
}

// ── Mock contracts ────────────────────────────────────────────────────────────

contract MockTarget {
    uint256 public callCount;

    function ping() external {
        callCount++;
    }

    function fail() external pure {
        revert("mock revert");
    }

    function returnValue() external pure returns (uint256) {
        return 42;
    }

    function receiveETH() external payable {}

    /// @dev Pulls `amount` of `token` from caller — simulates protocol deposit.
    function absorb(address token_, uint256 amount) external {
        callCount++;
        IERC20Like(token_).transferFrom(msg.sender, address(this), amount);
    }

    /// @dev Sends `amount` of `token` to caller — simulates protocol withdrawal.
    function release(address token_, uint256 amount) external {
        IERC20Like(token_).transfer(msg.sender, amount);
    }

    function releaseTwo(address tokenA, uint256 amountA, address tokenB, uint256 amountB) external {
        IERC20Like(tokenA).transfer(msg.sender, amountA);
        IERC20Like(tokenB).transfer(msg.sender, amountB);
    }
}

interface IERC20Like {
    function transferFrom(address, address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}
