// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {YieldGekoPolicyCaveatEnforcer} from "../contracts/YieldGekoPolicyCaveatEnforcer.sol";
import {YieldGekoExecutor} from "../contracts/YieldGekoExecutor.sol";
import {YieldGekoSwapper} from "../contracts/YieldGekoSwapper.sol";

import {ModeCode} from "delegation-framework/utils/Types.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Mock contracts
// ─────────────────────────────────────────────────────────────────────────────

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        require(allowance[from][msg.sender] >= amount, "not approved");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}

/// @dev Simulates a DeFi protocol (e.g. Aave deposit)
contract MockProtocol {
    event Called(bytes4 selector, uint256 value);

    bool public shouldFail;
    bytes public returnData;

    function setShouldFail(bool _fail) external {
        shouldFail = _fail;
    }

    function setReturnData(bytes memory _data) external {
        returnData = _data;
    }

    fallback() external payable {
        emit Called(msg.sig, msg.value);
        if (shouldFail) revert("MockProtocol: forced failure");
    }

    receive() external payable {}
}

/// @dev Simulates a DEX router (e.g. Uniswap)
contract MockDEX {
    MockERC20 public tokenOut;
    uint256 public outputAmount;
    bool public shouldFail;

    constructor(address _tokenOut, uint256 _outputAmount) {
        tokenOut = MockERC20(_tokenOut);
        outputAmount = _outputAmount;
    }

    function setShouldFail(bool _fail) external {
        shouldFail = _fail;
    }

    function setOutputAmount(uint256 _amount) external {
        outputAmount = _amount;
    }

    fallback() external payable {
        if (shouldFail) revert("MockDEX: forced failure");
        // Simulate outputting tokens to msg.sender (the swapper contract)
        tokenOut.mint(msg.sender, outputAmount);
    }

    receive() external payable {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Base test setup
// ─────────────────────────────────────────────────────────────────────────────

abstract contract YieldGekoV2TestBase is Test {
    YieldGekoPolicyCaveatEnforcer internal enforcer;
    YieldGekoExecutor internal executor;
    YieldGekoSwapper internal swapper;
    MockERC20 internal usdc;
    MockERC20 internal weth;
    MockProtocol internal mockProtocol;
    MockDEX internal mockDex;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal user = makeAddr("user"); // delegator (smart account)
    address internal treasury = makeAddr("treasury");
    address internal attacker = makeAddr("attacker");
    address internal delegationManager = makeAddr("delegationManager");

    ModeCode internal defaultMode = ModeCode.wrap(bytes32(0));

    function setUp() public virtual {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        mockProtocol = new MockProtocol();
        mockDex = new MockDEX(address(usdc), 99e6); // outputs 99 USDC for a swap

        vm.startPrank(owner);
        enforcer = new YieldGekoPolicyCaveatEnforcer(owner, delegationManager);
        executor = new YieldGekoExecutor(owner);
        swapper = new YieldGekoSwapper(owner);
        vm.stopPrank();
    }

    function _makeTerms(
        uint256 minAPYBps,
        uint256 maxDrawdownBps,
        uint256 managedUSD6,
        uint256 maxFeeBps,
        address feeTokenAddr,
        uint256 expiresAt
    ) internal view returns (bytes memory) {
        return abi.encode(
            YieldGekoPolicyCaveatEnforcer.PolicyTerms({
                minAPYBps: minAPYBps,
                maxDrawdownBps: maxDrawdownBps,
                managedUSD6: managedUSD6,
                maxFeeBps: maxFeeBps,
                treasury: treasury,
                expiresAt: expiresAt,
                feeToken: feeTokenAddr
            })
        );
    }

    function _makeArgs(uint256 preValueUSD6, uint256 postValueUSD6, uint256 feeAmountToken)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            YieldGekoPolicyCaveatEnforcer.ExecutionArgs({
                preValueUSD6: preValueUSD6, postValueUSD6: postValueUSD6, feeAmountToken: feeAmountToken
            })
        );
    }

    function _setupAuthorizedAgent() internal {
        vm.prank(owner);
        enforcer.setAuthorizedAgent(agent, true);
    }

    /// @dev Calls beforeHook as the DelegationManager (the only valid caller)
    function _beforeHook(bytes memory terms, bytes memory args, bytes32 delegationHash) internal {
        vm.prank(delegationManager);
        enforcer.beforeHook(terms, args, defaultMode, "", delegationHash, user, agent);
    }

    /// @dev Calls afterHook as the DelegationManager (the only valid caller)
    function _afterHook(bytes memory terms, bytes memory args, bytes32 delegationHash) internal {
        vm.prank(delegationManager);
        enforcer.afterHook(terms, args, defaultMode, "", delegationHash, user, agent);
    }

    function _setupExecutorWithProtocol() internal {
        vm.startPrank(owner);
        executor.setAuthorizedCaller(agent, true);
        executor.addProtocol(address(mockProtocol), "MockProtocol");
        vm.stopPrank();
    }

    function _setupSwapperWithDEX() internal {
        vm.startPrank(owner);
        swapper.setAuthorizedCaller(agent, true);
        swapper.addDEX(address(mockDex), "MockDEX");
        vm.stopPrank();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// YieldGekoPolicyCaveatEnforcer Tests
// ─────────────────────────────────────────────────────────────────────────────

contract PolicyCaveatEnforcer_AdminTests is YieldGekoV2TestBase {
    function test_ownerCanAuthorizeAgent() public {
        vm.prank(owner);
        enforcer.setAuthorizedAgent(agent, true);
        assertTrue(enforcer.authorizedAgents(agent));
    }

    function test_ownerCanRevokeAgent() public {
        vm.prank(owner);
        enforcer.setAuthorizedAgent(agent, true);

        vm.prank(owner);
        enforcer.setAuthorizedAgent(agent, false);
        assertFalse(enforcer.authorizedAgents(agent));
    }

    function test_nonOwnerCannotAuthorizeAgent() public {
        vm.expectRevert();
        vm.prank(attacker);
        enforcer.setAuthorizedAgent(agent, true);
    }

    function test_ownershipTransfer() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        enforcer.transferOwnership(newOwner);
        assertEq(enforcer.owner(), newOwner);
    }

    function test_encodeDecodeTermsRoundtrip() public {
        bytes memory terms = _makeTerms(800, 1000, 10_000e6, 1500, address(usdc), block.timestamp + 365 days);
        YieldGekoPolicyCaveatEnforcer.PolicyTerms memory decoded = enforcer.decodePolicyTerms(terms);

        assertEq(decoded.minAPYBps, 800);
        assertEq(decoded.maxDrawdownBps, 1000);
        assertEq(decoded.managedUSD6, 10_000e6);
        assertEq(decoded.maxFeeBps, 1500);
        assertEq(decoded.treasury, treasury);
        assertEq(decoded.feeToken, address(usdc));
    }

    function test_encodeDecodeArgsRoundtrip() public {
        bytes memory args = _makeArgs(1000e6, 1050e6, 7_500e3);
        YieldGekoPolicyCaveatEnforcer.ExecutionArgs memory decoded = enforcer.decodeExecutionArgs(args);

        assertEq(decoded.preValueUSD6, 1000e6);
        assertEq(decoded.postValueUSD6, 1050e6);
        assertEq(decoded.feeAmountToken, 7_500e3);
    }
}

contract PolicyCaveatEnforcer_BeforeHookTests is YieldGekoV2TestBase {
    function setUp() public override {
        super.setUp();
        _setupAuthorizedAgent();
    }

    function test_beforeHook_validCallSucceeds() public {
        bytes memory terms = _makeTerms(800, 1000, 10_000e6, 1500, address(usdc), block.timestamp + 365 days);
        bytes32 delegationHash = keccak256("delegation1");

        _beforeHook(terms, _makeArgs(1000e6, 0, 0), delegationHash);

        assertTrue(enforcer.peakInitialized(delegationHash));
        assertEq(enforcer.peakValueUSD6(delegationHash), 1000e6);
    }

    function test_beforeHook_revertsForDirectCallerNotDelegationManager() public {
        bytes memory terms = _makeTerms(800, 1000, 10_000e6, 1500, address(usdc), block.timestamp + 365 days);

        vm.expectRevert(
            abi.encodeWithSelector(YieldGekoPolicyCaveatEnforcer.CallerNotDelegationManager.selector, attacker)
        );
        vm.prank(attacker);
        enforcer.beforeHook(terms, _makeArgs(1000e6, 0, 0), defaultMode, "", keccak256("d"), user, agent);
    }

    function test_beforeHook_revertsForUnauthorizedAgent() public {
        bytes memory terms = _makeTerms(800, 1000, 10_000e6, 1500, address(usdc), block.timestamp + 365 days);
        bytes32 delegationHash = keccak256("delegation1");

        // DelegationManager calls correctly but passes an unauthorized redeemer
        vm.expectRevert(abi.encodeWithSelector(YieldGekoPolicyCaveatEnforcer.UnauthorizedAgent.selector, attacker));
        vm.prank(delegationManager);
        enforcer.beforeHook(terms, _makeArgs(1000e6, 0, 0), defaultMode, "", delegationHash, user, attacker);
    }

    function test_beforeHook_revertsWhenExpired() public {
        uint256 expiry = block.timestamp - 1;
        bytes memory terms = _makeTerms(800, 1000, 10_000e6, 1500, address(usdc), expiry);

        vm.expectRevert(
            abi.encodeWithSelector(YieldGekoPolicyCaveatEnforcer.DelegationExpired.selector, expiry, block.timestamp)
        );
        vm.prank(delegationManager);
        enforcer.beforeHook(terms, _makeArgs(1000e6, 0, 0), defaultMode, "", keccak256("d"), user, agent);
    }

    function test_beforeHook_revertsWhenCapitalExceeded() public {
        uint256 managedLimit = 5000e6;
        bytes memory terms = _makeTerms(800, 1000, managedLimit, 1500, address(usdc), block.timestamp + 365 days);

        vm.expectRevert(
            abi.encodeWithSelector(YieldGekoPolicyCaveatEnforcer.ManagedCapitalExceeded.selector, 6000e6, managedLimit)
        );
        _beforeHook(terms, _makeArgs(6000e6, 0, 0), keccak256("delegation1"));
    }

    function test_beforeHook_initializesPeakOnFirstCall() public {
        bytes memory terms = _makeTerms(800, 1000, 10_000e6, 1500, address(usdc), block.timestamp + 365 days);
        bytes32 delegationHash = keccak256("delegation1");

        assertFalse(enforcer.peakInitialized(delegationHash));
        _beforeHook(terms, _makeArgs(1234e6, 0, 0), delegationHash);
        assertTrue(enforcer.peakInitialized(delegationHash));
        assertEq(enforcer.peakValueUSD6(delegationHash), 1234e6);
    }

    function test_beforeHook_doesNotResetPeakOnSubsequentCalls() public {
        bytes memory terms = _makeTerms(800, 1000, 10_000e6, 1500, address(usdc), block.timestamp + 365 days);
        bytes32 delegationHash = keccak256("delegation1");

        _beforeHook(terms, _makeArgs(2000e6, 0, 0), delegationHash);
        _beforeHook(terms, _makeArgs(1800e6, 0, 0), delegationHash);

        assertEq(enforcer.peakValueUSD6(delegationHash), 2000e6);
    }

    function test_beforeHook_fuzzManagedCapital(uint256 managedUSD6, uint256 preValue) public {
        vm.assume(managedUSD6 > 0 && managedUSD6 < 1e15);
        vm.assume(preValue > 0 && preValue < 1e15);

        bytes memory terms = _makeTerms(800, 1000, managedUSD6, 1500, address(usdc), block.timestamp + 365 days);

        vm.prank(delegationManager);
        if (preValue > managedUSD6) {
            vm.expectRevert();
        }
        enforcer.beforeHook(
            terms, _makeArgs(preValue, 0, 0), defaultMode, "", keccak256(abi.encode(managedUSD6, preValue)), user, agent
        );
    }
}

contract PolicyCaveatEnforcer_AfterHookTests is YieldGekoV2TestBase {
    function setUp() public override {
        super.setUp();
        _setupAuthorizedAgent();

        // Pre-initialize peak for most tests
        bytes memory terms = _makeTerms(800, 1000, 10_000e6, 1500, address(usdc), block.timestamp + 365 days);
        _beforeHook(terms, _makeArgs(1000e6, 0, 0), keccak256("delegation1"));
    }

    function test_afterHook_revertsForDirectCallerNotDelegationManager() public {
        bytes memory terms = _makeTerms(800, 1000, 10_000e6, 1500, address(usdc), block.timestamp + 365 days);
        vm.expectRevert(
            abi.encodeWithSelector(YieldGekoPolicyCaveatEnforcer.CallerNotDelegationManager.selector, attacker)
        );
        vm.prank(attacker);
        enforcer.afterHook(terms, _makeArgs(1000e6, 1000e6, 0), defaultMode, "", keccak256("d"), user, agent);
    }

    function test_afterHook_noYieldNoFee() public {
        bytes memory terms = _makeTerms(800, 1000, 10_000e6, 1500, address(usdc), block.timestamp + 365 days);
        _afterHook(terms, _makeArgs(1000e6, 1000e6, 0), keccak256("delegation1"));
        assertEq(enforcer.peakValueUSD6(keccak256("delegation1")), 1000e6);
    }

    function test_afterHook_updatesPeakOnYield() public {
        bytes memory terms = _makeTerms(800, 1000, 10_000e6, 1500, address(usdc), block.timestamp + 365 days);
        bytes32 delegationHash = keccak256("delegation1");
        _afterHook(terms, _makeArgs(1000e6, 1100e6, 0), delegationHash);
        assertEq(enforcer.peakValueUSD6(delegationHash), 1100e6);
    }

    function test_afterHook_revertsOnDrawdownExceeded() public {
        bytes memory terms = _makeTerms(800, 1000, 10_000e6, 1500, address(usdc), block.timestamp + 365 days);
        bytes32 delegationHash = keccak256("delegation1");

        vm.expectRevert(abi.encodeWithSelector(YieldGekoPolicyCaveatEnforcer.DrawdownExceeded.selector, 1500, 1000));
        _afterHook(terms, _makeArgs(1000e6, 850e6, 0), delegationHash);
    }

    function test_afterHook_allowsDrawdownWithinLimit() public {
        bytes memory terms = _makeTerms(800, 1000, 10_000e6, 1500, address(usdc), block.timestamp + 365 days);
        _afterHook(terms, _makeArgs(1000e6, 950e6, 0), keccak256("delegation1"));
    }

    function test_afterHook_collectsPerformanceFee() public {
        bytes memory terms = _makeTerms(800, 1000, 10_000e6, 1500, address(usdc), block.timestamp + 365 days);
        bytes32 delegationHash = keccak256("delegation1");

        usdc.mint(user, 100e6);
        vm.prank(user);
        usdc.approve(address(enforcer), 100e6);

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        _afterHook(terms, _makeArgs(1000e6, 1100e6, 15e6), delegationHash);

        assertEq(usdc.balanceOf(treasury) - treasuryBefore, 15e6);
        assertEq(usdc.balanceOf(user), 100e6 - 15e6);
    }

    function test_afterHook_revertsOnExcessiveFee() public {
        bytes memory terms = _makeTerms(800, 1000, 10_000e6, 1500, address(usdc), block.timestamp + 365 days);
        bytes32 delegationHash = keccak256("delegation1");

        usdc.mint(user, 100e6);
        vm.prank(user);
        usdc.approve(address(enforcer), 100e6);

        vm.expectRevert();
        _afterHook(terms, _makeArgs(1000e6, 1100e6, 20e6), delegationHash); // 20% fee > 15% max
    }

    function test_afterHook_zeroFeeWhenNoYield() public {
        bytes memory terms = _makeTerms(800, 1000, 10_000e6, 1500, address(usdc), block.timestamp + 365 days);
        bytes32 delegationHash = keccak256("delegation1");

        usdc.mint(user, 100e6);
        vm.prank(user);
        usdc.approve(address(enforcer), 100e6);

        _afterHook(terms, _makeArgs(1000e6, 1000e6, 5e6), delegationHash);
        assertEq(usdc.balanceOf(treasury), 5e6);
    }

    function test_afterHook_currentDrawdownBpsView() public {
        bytes32 delegationHash = keccak256("delegation1");
        assertEq(enforcer.currentDrawdownBps(delegationHash, 900e6), 1000);
        assertEq(enforcer.currentDrawdownBps(delegationHash, 1000e6), 0);
        assertEq(enforcer.currentDrawdownBps(delegationHash, 1100e6), 0);
    }

    function test_afterHook_fuzzDrawdown(uint256 postValue) public {
        vm.assume(postValue > 0 && postValue <= 10_000e6);
        bytes32 delegationHash = keccak256("delegation2");
        bytes memory terms = _makeTerms(800, 1000, 10_000e6, 1500, address(usdc), block.timestamp + 365 days);

        _beforeHook(terms, _makeArgs(1000e6, 0, 0), delegationHash);

        if (postValue < 1000e6) {
            uint256 drawdownBps = ((1000e6 - postValue) * 10_000) / 1000e6;
            if (drawdownBps > 1000) vm.expectRevert();
        }

        _afterHook(terms, _makeArgs(1000e6, postValue, 0), delegationHash);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// YieldGekoExecutor Tests
// ─────────────────────────────────────────────────────────────────────────────

contract ExecutorTests is YieldGekoV2TestBase {
    function setUp() public override {
        super.setUp();
        _setupExecutorWithProtocol();
    }

    function test_addProtocol() public {
        address newProtocol = makeAddr("newProtocol");
        vm.prank(owner);
        executor.addProtocol(newProtocol, "NewProtocol");

        assertTrue(executor.approvedProtocols(newProtocol));
        assertEq(executor.protocolNames(newProtocol), "NewProtocol");
        assertEq(executor.getProtocolCount(), 2); // mockProtocol + newProtocol
    }

    function test_addProtocol_noDuplicates() public {
        uint256 countBefore = executor.getProtocolCount();
        vm.prank(owner);
        executor.addProtocol(address(mockProtocol), "DuplicateName");

        assertEq(executor.getProtocolCount(), countBefore); // no new entry added
    }

    function test_removeProtocol() public {
        vm.prank(owner);
        executor.removeProtocol(address(mockProtocol));

        assertFalse(executor.approvedProtocols(address(mockProtocol)));
    }

    function test_nonOwnerCannotAddProtocol() public {
        vm.expectRevert();
        vm.prank(attacker);
        executor.addProtocol(makeAddr("someProtocol"), "Attacker Protocol");
    }

    function test_setAuthorizedCaller() public {
        address newAgent = makeAddr("newAgent");
        vm.prank(owner);
        executor.setAuthorizedCaller(newAgent, true);

        assertTrue(executor.authorizedCallers(newAgent));
    }

    function test_execute_successPath() public {
        bytes memory callData = abi.encodeWithSignature("deposit(uint256)", 100e6);

        vm.prank(agent);
        executor.execute(address(mockProtocol), callData, 0);
        // Should not revert
    }

    function test_execute_revertsForUnauthorizedCaller() public {
        bytes memory callData = abi.encodeWithSignature("deposit(uint256)", 100e6);

        vm.expectRevert(abi.encodeWithSelector(YieldGekoExecutor.UnauthorizedCaller.selector, attacker));
        vm.prank(attacker);
        executor.execute(address(mockProtocol), callData, 0);
    }

    function test_execute_revertsForUnapprovedProtocol() public {
        address randomProtocol = makeAddr("randomProtocol");
        bytes memory callData = abi.encodeWithSignature("deposit(uint256)", 100e6);

        vm.expectRevert(abi.encodeWithSelector(YieldGekoExecutor.UnapprovedProtocol.selector, randomProtocol));
        vm.prank(agent);
        executor.execute(randomProtocol, callData, 0);
    }

    function test_execute_revertsOnProtocolFailure() public {
        mockProtocol.setShouldFail(true);
        bytes memory callData = abi.encodeWithSignature("deposit(uint256)", 100e6);

        vm.expectRevert();
        vm.prank(agent);
        executor.execute(address(mockProtocol), callData, 0);
    }

    function test_execute_revertsOnEmptyCalldata() public {
        vm.expectRevert(YieldGekoExecutor.EmptyCalldata.selector);
        vm.prank(agent);
        executor.execute(address(mockProtocol), "", 0);
    }

    function test_executeBatch_allSucceed() public {
        address[] memory protocols = new address[](3);
        bytes[] memory calldatas = new bytes[](3);
        uint256[] memory values = new uint256[](3);

        for (uint256 i = 0; i < 3; i++) {
            protocols[i] = address(mockProtocol);
            calldatas[i] = abi.encodeWithSignature("action(uint256)", i);
            values[i] = 0;
        }

        vm.prank(agent);
        executor.executeBatch(protocols, calldatas, values);
    }

    function test_executeBatch_revertsOnLengthMismatch() public {
        address[] memory protocols = new address[](2);
        bytes[] memory calldatas = new bytes[](3);
        uint256[] memory values = new uint256[](2);

        protocols[0] = address(mockProtocol);
        protocols[1] = address(mockProtocol);
        calldatas[0] = abi.encodeWithSignature("a()");
        calldatas[1] = abi.encodeWithSignature("b()");
        calldatas[2] = abi.encodeWithSignature("c()");
        values[0] = 0;
        values[1] = 0;

        vm.expectRevert(YieldGekoExecutor.BatchLengthMismatch.selector);
        vm.prank(agent);
        executor.executeBatch(protocols, calldatas, values);
    }

    function test_executeBatch_revertsIfAnyFails() public {
        mockProtocol.setShouldFail(true);
        address[] memory protocols = new address[](1);
        bytes[] memory calldatas = new bytes[](1);
        uint256[] memory values = new uint256[](1);

        protocols[0] = address(mockProtocol);
        calldatas[0] = abi.encodeWithSignature("deposit(uint256)", 100e6);
        values[0] = 0;

        vm.expectRevert();
        vm.prank(agent);
        executor.executeBatch(protocols, calldatas, values);
    }

    function test_approveToken() public {
        usdc.mint(address(executor), 1000e6);

        vm.prank(agent);
        executor.approveToken(address(usdc), address(mockProtocol), 500e6);

        assertEq(usdc.allowance(address(executor), address(mockProtocol)), 500e6);
    }

    function test_setTreasury() public {
        vm.prank(owner);
        executor.setTreasury(treasury);
        assertEq(executor.treasury(), treasury);
    }

    function test_setTreasury_revertsZeroAddress() public {
        vm.expectRevert(YieldGekoExecutor.ZeroAddress.selector);
        vm.prank(owner);
        executor.setTreasury(address(0));
    }

    function test_setTreasury_nonOwnerReverts() public {
        vm.expectRevert();
        vm.prank(attacker);
        executor.setTreasury(treasury);
    }

    function test_rescueToken() public {
        vm.prank(owner);
        executor.setTreasury(treasury);

        usdc.mint(address(executor), 500e6);
        vm.prank(owner);
        executor.rescueToken(address(usdc));

        assertEq(usdc.balanceOf(treasury), 500e6);
        assertEq(usdc.balanceOf(address(executor)), 0);
    }

    function test_rescueToken_noopWhenEmpty() public {
        vm.prank(owner);
        executor.setTreasury(treasury);
        // Should not revert even with 0 balance
        vm.prank(owner);
        executor.rescueToken(address(usdc));
    }

    function test_getActiveProtocols() public {
        (address[] memory active, string[] memory names) = executor.getActiveProtocols();
        assertEq(active.length, 1);
        assertEq(active[0], address(mockProtocol));
        assertEq(names[0], "MockProtocol");

        // Remove and check
        vm.prank(owner);
        executor.removeProtocol(address(mockProtocol));

        (active, names) = executor.getActiveProtocols();
        assertEq(active.length, 0);
    }

    function test_cannotAddZeroAddress() public {
        vm.expectRevert(YieldGekoExecutor.ZeroAddress.selector);
        vm.prank(owner);
        executor.addProtocol(address(0), "Zero");
    }

    function test_receivesEth() public {
        (bool sent,) = address(executor).call{value: 1 ether}("");
        assertTrue(sent);
        assertEq(address(executor).balance, 1 ether);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// YieldGekoSwapper Tests
// ─────────────────────────────────────────────────────────────────────────────

contract SwapperTests is YieldGekoV2TestBase {
    function setUp() public override {
        super.setUp();
        _setupSwapperWithDEX();
    }

    function test_addDEX() public {
        address newDex = makeAddr("newDex");
        vm.prank(owner);
        swapper.addDEX(newDex, "NewDEX");

        assertTrue(swapper.approvedDEXes(newDex));
        assertEq(swapper.dexNames(newDex), "NewDEX");
        assertEq(swapper.getDEXCount(), 2);
    }

    function test_removeDEX() public {
        vm.prank(owner);
        swapper.removeDEX(address(mockDex));

        assertFalse(swapper.approvedDEXes(address(mockDex)));
    }

    function test_swap_erc20ToErc20_success() public {
        // Agent has WETH, wants to swap for USDC
        // mockDex outputs 99e6 USDC for any swap
        weth.mint(agent, 1 ether);
        vm.prank(agent);
        weth.approve(address(swapper), 1 ether);

        bytes memory swapCalldata = abi.encodeWithSignature("exactInput(address,uint256)", address(weth), 1 ether);

        vm.prank(agent);
        uint256 amountOut = swapper.swap(
            address(mockDex),
            swapCalldata,
            address(weth),
            address(usdc),
            1 ether,
            90e6, // min 90 USDC
            agent
        );

        assertEq(amountOut, 99e6);
        assertEq(usdc.balanceOf(agent), 99e6);
        assertEq(weth.balanceOf(agent), 0); // WETH spent
    }

    function test_swap_revertsOnSlippage() public {
        weth.mint(agent, 1 ether);
        vm.prank(agent);
        weth.approve(address(swapper), 1 ether);

        // DEX only outputs 99 USDC but we demand 110
        bytes memory swapCalldata = abi.encodeWithSignature("swap(address,uint256)", address(weth), 1 ether);

        vm.expectRevert(abi.encodeWithSelector(YieldGekoSwapper.SlippageExceeded.selector, 99e6, 110e6));
        vm.prank(agent);
        swapper.swap(
            address(mockDex),
            swapCalldata,
            address(weth),
            address(usdc),
            1 ether,
            110e6, // min 110 USDC — not achievable
            agent
        );
    }

    function test_swap_permissionless_anyCallerCanSwap() public {
        // swap() is permissionless — any caller with approved tokens can swap
        weth.mint(attacker, 1 ether);
        vm.prank(attacker);
        weth.approve(address(swapper), 1 ether);

        bytes memory swapCalldata = abi.encodeWithSignature("swap()");
        vm.prank(attacker);
        uint256 amountOut =
            swapper.swap(address(mockDex), swapCalldata, address(weth), address(usdc), 1 ether, 0, attacker);
        assertEq(amountOut, 99e6);
    }

    function test_swap_revertsForUnapprovedDEX() public {
        address randomDex = makeAddr("randomDex");
        bytes memory swapCalldata = abi.encodeWithSignature("swap()");

        vm.expectRevert(abi.encodeWithSelector(YieldGekoSwapper.UnapprovedDEX.selector, randomDex));
        vm.prank(agent);
        swapper.swap(randomDex, swapCalldata, address(weth), address(usdc), 1 ether, 0, agent);
    }

    function test_swap_revertsOnZeroAmountIn() public {
        bytes memory swapCalldata = abi.encodeWithSignature("swap()");

        vm.expectRevert(YieldGekoSwapper.ZeroAmountIn.selector);
        vm.prank(agent);
        swapper.swap(address(mockDex), swapCalldata, address(weth), address(usdc), 0, 0, agent);
    }

    function test_swap_revertsOnDexFailure() public {
        mockDex.setShouldFail(true);
        weth.mint(agent, 1 ether);
        vm.prank(agent);
        weth.approve(address(swapper), 1 ether);

        bytes memory swapCalldata = abi.encodeWithSignature("swap()");

        vm.expectRevert();
        vm.prank(agent);
        swapper.swap(address(mockDex), swapCalldata, address(weth), address(usdc), 1 ether, 0, agent);
    }

    function test_swap_clearsApprovalAfterSwap() public {
        weth.mint(agent, 1 ether);
        vm.prank(agent);
        weth.approve(address(swapper), 1 ether);

        bytes memory swapCalldata = abi.encodeWithSignature("swap()");
        vm.prank(agent);
        swapper.swap(address(mockDex), swapCalldata, address(weth), address(usdc), 1 ether, 0, agent);

        // Approval to DEX should be 0 after swap
        assertEq(weth.allowance(address(swapper), address(mockDex)), 0);
    }

    function test_swap_toCustomRecipient() public {
        address recipient = makeAddr("recipient");
        weth.mint(agent, 1 ether);
        vm.prank(agent);
        weth.approve(address(swapper), 1 ether);

        bytes memory swapCalldata = abi.encodeWithSignature("swap()");
        vm.prank(agent);
        swapper.swap(address(mockDex), swapCalldata, address(weth), address(usdc), 1 ether, 0, recipient);

        assertEq(usdc.balanceOf(recipient), 99e6); // output sent to recipient
        assertEq(usdc.balanceOf(agent), 0);
    }

    function test_getActiveDEXes() public {
        (address[] memory active, string[] memory names) = swapper.getActiveDEXes();
        assertEq(active.length, 1);
        assertEq(active[0], address(mockDex));
        assertEq(names[0], "MockDEX");
    }

    function test_cannotAddZeroAddressDEX() public {
        vm.expectRevert(YieldGekoSwapper.ZeroAddress.selector);
        vm.prank(owner);
        swapper.addDEX(address(0), "Zero");
    }

    function test_dexNoDuplicates() public {
        uint256 before = swapper.getDEXCount();
        vm.prank(owner);
        swapper.addDEX(address(mockDex), "Duplicate");
        assertEq(swapper.getDEXCount(), before); // no new entry
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// YieldGekoExecutor V2 Pull / Balance Tests
// ─────────────────────────────────────────────────────────────────────────────

contract ExecutorV2PullTests is YieldGekoV2TestBase {
    function setUp() public override {
        super.setUp();
        vm.startPrank(owner);
        executor.setTreasury(treasury);
        executor.addProtocol(address(mockProtocol), "MockProtocol");
        vm.stopPrank();
    }

    // ── executeWithPull ───────────────────────────────────────────────────────

    function test_executeWithPull_pullsAndExecutes() public {
        usdc.mint(user, 1000e6);
        vm.prank(user);
        usdc.approve(address(executor), 1000e6);

        bytes memory callData = abi.encodeWithSignature("supply(address,uint256)", address(usdc), 1000e6);
        vm.prank(user);
        executor.executeWithPull(address(usdc), 1000e6, address(mockProtocol), callData, 0);

        assertEq(usdc.balanceOf(address(executor)), 1000e6); // executor received USDC from user
    }

    function test_executeWithPull_permissionless_anyCallerWithApproval() public {
        // Not gated — attacker can call if they have the tokens and allowance
        usdc.mint(attacker, 500e6);
        vm.prank(attacker);
        usdc.approve(address(executor), 500e6);

        bytes memory callData = abi.encodeWithSignature("supply(uint256)", 500e6);
        vm.prank(attacker);
        executor.executeWithPull(address(usdc), 500e6, address(mockProtocol), callData, 0);
    }

    function test_executeWithPull_revertsUnapprovedProtocol() public {
        address rando = makeAddr("rando");
        bytes memory callData = abi.encodeWithSignature("deposit()");

        vm.expectRevert(abi.encodeWithSelector(YieldGekoExecutor.UnapprovedProtocol.selector, rando));
        vm.prank(user);
        executor.executeWithPull(address(usdc), 100e6, rando, callData, 0);
    }

    function test_executeWithPull_revertsOnProtocolFailure() public {
        mockProtocol.setShouldFail(true);
        usdc.mint(user, 100e6);
        vm.prank(user);
        usdc.approve(address(executor), 100e6);

        bytes memory callData = abi.encodeWithSignature("deposit()");
        vm.expectRevert();
        vm.prank(user);
        executor.executeWithPull(address(usdc), 100e6, address(mockProtocol), callData, 0);
    }

    // ── executeFromBalance ────────────────────────────────────────────────────

    function test_executeFromBalance_usesExistingTokens() public {
        // Simulate Swapper sending tokens directly to executor
        usdc.mint(address(executor), 500e6);
        weth.mint(address(executor), 1 ether);

        bytes memory callData = abi.encodeWithSignature(
            "mint(address,address,uint256,uint256)", address(usdc), address(weth), 500e6, 1 ether
        );
        vm.prank(user);
        executor.executeFromBalance(address(usdc), address(weth), address(mockProtocol), callData, 0);

        // Protocol received the call
        // Dust swept to treasury (mockProtocol doesn't consume, so all dust swept)
        assertEq(usdc.balanceOf(address(executor)), 0);
        assertEq(weth.balanceOf(address(executor)), 0);
    }

    function test_executeFromBalance_sweepsDustToTreasury() public {
        // Executor has tokens; protocol uses none (mock doesn't consume)
        usdc.mint(address(executor), 100e6);
        weth.mint(address(executor), 0.5 ether);

        bytes memory callData = abi.encodeWithSignature("mint()");
        vm.prank(user);
        executor.executeFromBalance(address(usdc), address(weth), address(mockProtocol), callData, 0);

        // All tokens swept to treasury as dust
        assertEq(usdc.balanceOf(treasury), 100e6);
        assertEq(weth.balanceOf(treasury), 0.5 ether);
        assertEq(usdc.balanceOf(address(executor)), 0);
        assertEq(weth.balanceOf(address(executor)), 0);
    }

    function test_executeFromBalance_executorAlwaysEndsAtZero() public {
        usdc.mint(address(executor), 999e6);
        weth.mint(address(executor), 2 ether);

        bytes memory callData = abi.encodeWithSignature("doSomething()");
        vm.prank(user);
        executor.executeFromBalance(address(usdc), address(weth), address(mockProtocol), callData, 0);

        assertEq(usdc.balanceOf(address(executor)), 0, "executor must end at zero");
        assertEq(weth.balanceOf(address(executor)), 0, "executor must end at zero");
    }

    function test_executeFromBalance_revertsUnapprovedProtocol() public {
        address rando = makeAddr("rando");
        bytes memory callData = abi.encodeWithSignature("mint()");

        vm.expectRevert(abi.encodeWithSelector(YieldGekoExecutor.UnapprovedProtocol.selector, rando));
        vm.prank(user);
        executor.executeFromBalance(address(usdc), address(weth), rando, callData, 0);
    }

    function test_executeFromBalance_revertsOnProtocolFailure() public {
        mockProtocol.setShouldFail(true);
        usdc.mint(address(executor), 100e6);
        bytes memory callData = abi.encodeWithSignature("mint()");

        vm.expectRevert();
        vm.prank(user);
        executor.executeFromBalance(address(usdc), address(weth), address(mockProtocol), callData, 0);
    }

    // ── executePullAndFromBalance ─────────────────────────────────────────────

    function test_executePullAndFromBalance_pullsOneUsesOther() public {
        // Executor already has WETH (from swap), user has USDC to pull
        weth.mint(address(executor), 1 ether);
        usdc.mint(user, 500e6);
        vm.prank(user);
        usdc.approve(address(executor), 500e6);

        bytes memory callData = abi.encodeWithSignature(
            "mint(address,address,uint256,uint256)", address(usdc), address(weth), 500e6, 1 ether
        );
        vm.prank(user);
        executor.executePullAndFromBalance(address(usdc), 500e6, address(weth), address(mockProtocol), callData, 0);

        // Executor ends at zero — dust swept to treasury
        assertEq(usdc.balanceOf(address(executor)), 0);
        assertEq(weth.balanceOf(address(executor)), 0);
    }

    function test_executePullAndFromBalance_sweepsDustToTreasury() public {
        weth.mint(address(executor), 1 ether);
        usdc.mint(user, 500e6);
        vm.prank(user);
        usdc.approve(address(executor), 500e6);

        bytes memory callData = abi.encodeWithSignature("noop()");
        vm.prank(user);
        executor.executePullAndFromBalance(address(usdc), 500e6, address(weth), address(mockProtocol), callData, 0);

        // All goes to treasury
        assertEq(usdc.balanceOf(treasury), 500e6);
        assertEq(weth.balanceOf(treasury), 1 ether);
    }

    function test_executePullAndFromBalance_revertsUnapprovedProtocol() public {
        address rando = makeAddr("rando");
        usdc.mint(user, 100e6);
        vm.prank(user);
        usdc.approve(address(executor), 100e6);

        bytes memory callData = abi.encodeWithSignature("mint()");
        vm.expectRevert(abi.encodeWithSelector(YieldGekoExecutor.UnapprovedProtocol.selector, rando));
        vm.prank(user);
        executor.executePullAndFromBalance(address(usdc), 100e6, address(weth), rando, callData, 0);
    }

    function test_executePullAndFromBalance_revertsOnProtocolFailure() public {
        mockProtocol.setShouldFail(true);
        weth.mint(address(executor), 0.5 ether);
        usdc.mint(user, 200e6);
        vm.prank(user);
        usdc.approve(address(executor), 200e6);

        bytes memory callData = abi.encodeWithSignature("mint()");
        vm.expectRevert();
        vm.prank(user);
        executor.executePullAndFromBalance(address(usdc), 200e6, address(weth), address(mockProtocol), callData, 0);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Integration: Enforcer + Executor working together
// ─────────────────────────────────────────────────────────────────────────────

contract IntegrationTests is YieldGekoV2TestBase {
    function setUp() public override {
        super.setUp();
        _setupAuthorizedAgent();
        _setupExecutorWithProtocol();
        _setupSwapperWithDEX();
    }

    function test_fullStrategyExecution_depositWithFeeCollection() public {
        bytes32 delegationHash = keccak256("strategyDelegation");
        bytes memory terms = _makeTerms(800, 1000, 50_000e6, 1500, address(usdc), block.timestamp + 365 days);

        // Step 1: beforeHook (policy check, pre-execution)
        _beforeHook(terms, _makeArgs(10_000e6, 0, 0), delegationHash);

        // Step 2: Execute DeFi protocol call (e.g. Aave deposit)
        bytes memory depositCalldata =
            abi.encodeWithSignature("supply(address,uint256,address,uint16)", address(usdc), 10_000e6, user, 0);
        vm.prank(agent);
        executor.execute(address(mockProtocol), depositCalldata, 0);

        // Step 3: afterHook (drawdown check, fee collection)
        usdc.mint(user, 150e6);
        vm.prank(user);
        usdc.approve(address(enforcer), 150e6);

        _afterHook(terms, _makeArgs(10_000e6, 11_000e6, 150e6), delegationHash);

        // Fee collected
        assertEq(usdc.balanceOf(treasury), 150e6);
        // Peak updated
        assertEq(enforcer.peakValueUSD6(delegationHash), 11_000e6);
    }

    function test_fullStrategyExecution_drawdownStopsExecution() public {
        bytes32 delegationHash = keccak256("drawdownStrategy");
        bytes memory terms = _makeTerms(800, 500, 50_000e6, 1500, address(usdc), block.timestamp + 365 days);
        // maxDrawdown = 5%

        _beforeHook(terms, _makeArgs(10_000e6, 0, 0), delegationHash);

        vm.expectRevert();
        _afterHook(terms, _makeArgs(10_000e6, 9_400e6, 0), delegationHash);
    }

    function test_multiDelegation_separatePeakTracking() public {
        bytes memory terms = _makeTerms(800, 1000, 50_000e6, 1500, address(usdc), block.timestamp + 365 days);
        bytes32 delegation1 = keccak256("strategy1");
        bytes32 delegation2 = keccak256("strategy2");

        _beforeHook(terms, _makeArgs(10_000e6, 0, 0), delegation1);
        _beforeHook(terms, _makeArgs(5_000e6, 0, 0), delegation2);

        assertEq(enforcer.peakValueUSD6(delegation1), 10_000e6);
        assertEq(enforcer.peakValueUSD6(delegation2), 5_000e6);

        _afterHook(terms, _makeArgs(10_000e6, 9_200e6, 0), delegation1); // 8% drop — within limit

        vm.expectRevert();
        _afterHook(terms, _makeArgs(5_000e6, 4_400e6, 0), delegation2); // 12% drop — exceeds limit
    }

    function test_newProtocolAddedWithoutReSigning() public {
        address aavePool = makeAddr("aavePool");

        // Initially not approved
        assertFalse(executor.approvedProtocols(aavePool));

        // Owner adds new protocol (no user action required)
        vm.prank(owner);
        executor.addProtocol(aavePool, "Aave V3");

        // Agent can now execute against Aave
        assertTrue(executor.approvedProtocols(aavePool));

        // Create a mock at the aavePool address
        MockProtocol aaveMock = new MockProtocol();
        vm.etch(aavePool, address(aaveMock).code);

        bytes memory depositCalldata =
            abi.encodeWithSignature("supply(address,uint256,address,uint16)", address(usdc), 1000e6, user, 0);
        vm.prank(agent);
        executor.execute(aavePool, depositCalldata, 0);
    }

    function test_newDEXAddedWithoutReSigning() public {
        // Deploy a new DEX (e.g. 1inch) not initially known
        MockDEX newMockDex = new MockDEX(address(usdc), 95e6);
        address newDex = address(newMockDex);

        // Initially not approved
        assertFalse(swapper.approvedDEXes(newDex));

        // Owner adds new DEX — no user re-signing required
        vm.prank(owner);
        swapper.addDEX(newDex, "1inch v6");

        assertTrue(swapper.approvedDEXes(newDex));
        assertEq(swapper.dexNames(newDex), "1inch v6");

        // Agent immediately swaps via the new DEX with existing delegation
        weth.mint(agent, 1 ether);
        vm.prank(agent);
        weth.approve(address(swapper), 1 ether);

        bytes memory swapCalldata = abi.encodeWithSignature("swap()");
        vm.prank(agent);
        uint256 amountOut = swapper.swap(newDex, swapCalldata, address(weth), address(usdc), 1 ether, 0, agent);

        assertEq(amountOut, 95e6); // new DEX outputs 95 USDC
        assertEq(usdc.balanceOf(agent), 95e6);
    }
}
