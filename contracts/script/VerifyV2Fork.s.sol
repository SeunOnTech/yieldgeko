// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @title VerifyV2Fork
 * @notice Fork verification script: deploys V2 contracts against a live Arbitrum mainnet fork,
 *         wires up real protocol addresses, and runs a full strategy lifecycle simulation.
 *
 * @dev Run with:
 *      forge script script/VerifyV2Fork.s.sol \
 *        --fork-url https://arb1.arbitrum.io/rpc \
 *        --fork-block-number latest \
 *        -vvv
 */

import {Script} from "forge-std/Script.sol";
import {Test} from "forge-std/Test.sol";
import {console2 as console} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {YieldGekoPolicyCaveatEnforcer} from "../contracts/YieldGekoPolicyCaveatEnforcer.sol";
import {YieldGekoExecutor} from "../contracts/YieldGekoExecutor.sol";
import {YieldGekoSwapper} from "../contracts/YieldGekoSwapper.sol";
import {ModeCode} from "delegation-framework/utils/Types.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Arbitrum One addresses (verified live)
// ─────────────────────────────────────────────────────────────────────────────

address constant USDC_ARB = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // native USDC
address constant WETH_ARB = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
address constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD; // Aave V3 Pool
address constant AAVE_AUSDC = 0x724dc807b04555b71ed48a6896b6F41593b8C637; // aUSDC (native) on Arb
address constant AAVE_AUSDC_E = 0x625E7708f30cA75bfd92586e17077590C60eb4cD; // aUSDC.e (bridged) on Arb
address constant AAVE_DATA_PROVIDER = 0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654; // Aave V3 data provider
address constant GMX_ROUTER = 0xaBBc5F99639c9B6bCb58544ddf04EFA6802F4064; // GMX Router
address constant UNI_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564; // Uniswap V3 SwapRouter
address constant CAMELOT_ROUTER = 0xc873fEcbd354f5A56E00E710B90EF4201db2448d; // Camelot DEX
address constant PENDLE_ROUTER = 0x00000000005BBB0EF59571E58418F9a4357b68A0; // Pendle Router V3

// MetaMask Delegation Framework on Arbitrum One (verified)
address constant DELEGATION_MANAGER = 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3;
address constant HYBRID_DELEGATOR = 0x48dBe696A4D990079e039489bA2053B36E8FFEC4;
address constant SIMPLE_FACTORY = 0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c;

// Aave V3 interface
interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

contract VerifyV2Fork is Script, Test {
    YieldGekoPolicyCaveatEnforcer public enforcer;
    YieldGekoExecutor public executor;
    YieldGekoSwapper public swapper;

    address public deployer;
    address public agentWallet;
    address public userSmartAccount;
    address public treasury;

    ModeCode defaultMode = ModeCode.wrap(bytes32(0));

    function run() external {
        deployer = makeAddr("deployer");
        agentWallet = makeAddr("agent");
        userSmartAccount = makeAddr("userSmartAccount");
        treasury = makeAddr("treasury");

        console.log("=================================================");
        console.log("YieldGeko V2 Fork Verification - Arbitrum One");
        console.log("=================================================");
        console.log("Block:", block.number);
        console.log("Chain ID:", block.chainid);

        _verifyArbitrumInfrastructure();
        _deployV2Contracts();
        _configureContracts();
        _verifyContractState();
        _simulateStrategyLifecycle();
        _verifyNoResignNeededForNewProtocol();

        console.log("");
        console.log("=================================================");
        console.log("ALL CHECKS PASSED - V2 Contracts Ready");
        console.log("=================================================");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Step 1: Verify Arbitrum infrastructure is live
    // ─────────────────────────────────────────────────────────────────────────

    function _verifyArbitrumInfrastructure() internal {
        console.log("");
        console.log("[1/5] Verifying Arbitrum infrastructure...");

        _checkContract("USDC (native)", USDC_ARB);
        _checkContract("WETH", WETH_ARB);
        _checkContract("Aave V3 Pool", AAVE_POOL);
        _checkContract("Uniswap V3 Router", UNI_V3_ROUTER);
        _checkContract("DelegationManager (MM)", DELEGATION_MANAGER);
        _checkContract("HybridDeleGator (MM)", HYBRID_DELEGATOR);
        _checkContract("SimpleFactory (MM)", SIMPLE_FACTORY);

        // Verify USDC has real supply
        uint256 usdcSupply = IERC20(USDC_ARB).totalSupply();
        require(usdcSupply > 0, "USDC has zero supply - wrong network?");
        console.log("  USDC total supply:", usdcSupply / 1e6, "USDC");

        // Verify Aave has TVL
        uint256 aUsdcSupply = IERC20(AAVE_AUSDC).totalSupply();
        require(aUsdcSupply > 0, "Aave aUSDC has zero supply");
        console.log("  Aave aUSDC supply:", aUsdcSupply / 1e6, "USDC");

        console.log("  [OK] All infrastructure contracts live");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Step 2: Deploy V2 contracts
    // ─────────────────────────────────────────────────────────────────────────

    function _deployV2Contracts() internal {
        console.log("");
        console.log("[2/5] Deploying V2 contracts...");

        vm.startPrank(deployer);
        enforcer = new YieldGekoPolicyCaveatEnforcer(deployer, DELEGATION_MANAGER);
        executor = new YieldGekoExecutor(deployer);
        swapper = new YieldGekoSwapper(deployer);
        vm.stopPrank();

        require(address(enforcer).code.length > 0, "Enforcer not deployed");
        require(address(executor).code.length > 0, "Executor not deployed");
        require(address(swapper).code.length > 0, "Swapper not deployed");

        console.log("  YieldGekoPolicyCaveatEnforcer:", address(enforcer));
        console.log("  YieldGekoExecutor:            ", address(executor));
        console.log("  YieldGekoSwapper:             ", address(swapper));
        console.log("  [OK] All V2 contracts deployed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Step 3: Configure contracts with real protocol addresses
    // ─────────────────────────────────────────────────────────────────────────

    function _configureContracts() internal {
        console.log("");
        console.log("[3/5] Configuring contracts with live protocol addresses...");

        vm.startPrank(deployer);

        // Authorize our agent
        enforcer.setAuthorizedAgent(agentWallet, true);
        executor.setAuthorizedCaller(agentWallet, true);
        swapper.setAuthorizedCaller(agentWallet, true);

        // Add DeFi protocols to executor (these are the only 2 addresses users ever need to approve)
        executor.addProtocol(AAVE_POOL, "Aave V3");
        executor.addProtocol(GMX_ROUTER, "GMX");
        executor.addProtocol(PENDLE_ROUTER, "Pendle Finance");

        // Add DEXes to swapper
        swapper.addDEX(UNI_V3_ROUTER, "Uniswap V3");
        swapper.addDEX(CAMELOT_ROUTER, "Camelot");

        vm.stopPrank();

        console.log("  Authorized agent:", agentWallet);
        console.log("  Protocols added: Aave V3, GMX, Pendle");
        console.log("  DEXes added: Uniswap V3, Camelot");
        console.log("  [OK] Configuration complete");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Step 4: Verify contract state is correct
    // ─────────────────────────────────────────────────────────────────────────

    function _verifyContractState() internal {
        console.log("");
        console.log("[4/5] Verifying contract state...");

        // Enforcer checks
        require(enforcer.authorizedAgents(agentWallet), "Agent not authorized in enforcer");
        require(enforcer.owner() == deployer, "Wrong enforcer owner");

        // Executor checks
        require(executor.approvedProtocols(AAVE_POOL), "Aave not approved in executor");
        require(executor.approvedProtocols(GMX_ROUTER), "GMX not approved in executor");
        require(executor.approvedProtocols(PENDLE_ROUTER), "Pendle not approved in executor");
        require(executor.authorizedCallers(agentWallet), "Agent not authorized in executor");
        require(executor.getProtocolCount() == 3, "Wrong protocol count");

        (address[] memory activeProtocols, string[] memory names) = executor.getActiveProtocols();
        require(activeProtocols.length == 3, "Wrong active protocol count");
        console.log("  Active protocols: %s | %s | %s", names[0], names[1], names[2]);

        // Swapper checks
        require(swapper.approvedDEXes(UNI_V3_ROUTER), "Uniswap not approved in swapper");
        require(swapper.approvedDEXes(CAMELOT_ROUTER), "Camelot not approved in swapper");
        require(swapper.getDEXCount() == 2, "Wrong DEX count");

        (address[] memory activeDEXes, string[] memory dexNameList) = swapper.getActiveDEXes();
        require(activeDEXes.length == 2, "Wrong active DEX count");
        console.log("  Active DEXes: %s | %s", dexNameList[0], dexNameList[1]);

        console.log("  [OK] All state checks passed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Step 5: Simulate full strategy lifecycle against real Aave
    // ─────────────────────────────────────────────────────────────────────────

    function _simulateStrategyLifecycle() internal {
        console.log("");
        console.log("[5/5] Simulating strategy lifecycle against live Aave V3...");

        uint256 depositAmount = 1000e6; // $1,000 USDC
        bytes32 delegationHash = keccak256("testDelegation");

        // Give the user smart account some USDC (fork impersonation)
        deal(USDC_ARB, userSmartAccount, depositAmount * 2);

        uint256 userUsdcBefore = IERC20(USDC_ARB).balanceOf(userSmartAccount);
        console.log("  User USDC before:", userUsdcBefore / 1e6, "USDC");

        // ── Build policy terms (what user signs once) ──
        bytes memory terms = abi.encode(
            YieldGekoPolicyCaveatEnforcer.PolicyTerms({
                minAPYBps: 800, // 8% min APY
                maxDrawdownBps: 1000, // 10% max drawdown
                managedUSD6: 5000e6, // $5,000 max managed
                maxFeeBps: 1500, // 15% performance fee
                treasury: treasury,
                expiresAt: block.timestamp + 365 days,
                feeToken: USDC_ARB
            })
        );

        // ── beforeHook: policy validation ──
        bytes memory args = abi.encode(
            YieldGekoPolicyCaveatEnforcer.ExecutionArgs({
                preValueUSD6: depositAmount,
                postValueUSD6: 0, // not known before execution
                feeAmountToken: 0
            })
        );

        vm.prank(DELEGATION_MANAGER); // DelegationManager is always msg.sender for hooks
        enforcer.beforeHook(terms, args, defaultMode, "", delegationHash, userSmartAccount, agentWallet);
        require(enforcer.peakInitialized(delegationHash), "Peak not initialized after beforeHook");
        require(enforcer.peakValueUSD6(delegationHash) == depositAmount, "Wrong peak value");
        console.log("  [OK] beforeHook: policy validated, peak set to", depositAmount / 1e6, "USD");

        // ── Executor: approve + deposit to Aave V3 ──
        // In real V2 flow, the agent calls executor through delegation redemption.
        // Here we simulate the executor being called directly by the agent.
        vm.startPrank(userSmartAccount);
        IERC20(USDC_ARB).approve(address(executor), depositAmount);
        vm.stopPrank();

        // Agent calls executor to move user's USDC to Aave
        // First, executor needs the USDC - pull from user then deposit to Aave
        vm.startPrank(agentWallet);

        // Pull user's USDC to executor first
        vm.stopPrank();
        vm.prank(userSmartAccount);
        IERC20(USDC_ARB).transfer(address(executor), depositAmount);

        // Executor approves Aave and deposits
        vm.prank(agentWallet);
        executor.approveToken(USDC_ARB, AAVE_POOL, depositAmount);

        bytes memory depositCalldata = abi.encodeWithSignature(
            "supply(address,uint256,address,uint16)",
            USDC_ARB,
            depositAmount,
            userSmartAccount, // aTokens go to user's smart account
            0
        );

        vm.prank(agentWallet);
        executor.execute(AAVE_POOL, depositCalldata, 0);

        // Verify Aave deposit happened via getUserAccountData (works regardless of aToken version)
        (uint256 totalCollateralBase,,,,,) = IAavePool(AAVE_POOL).getUserAccountData(userSmartAccount);
        require(totalCollateralBase > 0, "Aave deposit failed - no collateral registered");
        console.log("  [OK] Executor: Aave deposit successful, collateral (USD base):", totalCollateralBase / 1e8);

        // Also check native USDC aToken
        uint256 aUsdcBalance = IERC20(AAVE_AUSDC).balanceOf(userSmartAccount);
        if (aUsdcBalance == 0) {
            // Some Aave versions return collateral but use different aToken addresses
            // The deposit is verified via getUserAccountData above
            console.log("  [INFO] aUSDC balance 0 - checking via collateral base (verified above)");
        } else {
            console.log("  [OK] aUSDC (native) balance:", aUsdcBalance / 1e6);
        }

        // ── Simulate time passing + yield accrual ──
        vm.warp(block.timestamp + 30 days);
        vm.roll(block.number + 216000); // ~30 days of blocks at 0.3s per block

        (uint256 collateralAfter,,,,,) = IAavePool(AAVE_POOL).getUserAccountData(userSmartAccount);
        uint256 yieldEarned = collateralAfter > totalCollateralBase ? collateralAfter - totalCollateralBase : 0;
        console.log("  After 30 days - collateral (USD base):", collateralAfter / 1e8);
        console.log("  Yield accrued (collateral increase):", yieldEarned);

        // ── afterHook: drawdown check + fee collection ──
        uint256 postValue = depositAmount + yieldEarned;
        uint256 feeAmount = yieldEarned > 0 ? (yieldEarned * 1500) / 10_000 : 0; // 15% of yield

        // User approves enforcer for fee
        if (feeAmount > 0) {
            vm.prank(userSmartAccount);
            IERC20(USDC_ARB).approve(address(enforcer), feeAmount);
            deal(USDC_ARB, userSmartAccount, feeAmount); // ensure user has fee amount
        }

        bytes memory afterArgs = abi.encode(
            YieldGekoPolicyCaveatEnforcer.ExecutionArgs({
                preValueUSD6: depositAmount, postValueUSD6: postValue, feeAmountToken: feeAmount
            })
        );

        vm.prank(DELEGATION_MANAGER); // DelegationManager is always msg.sender for hooks
        enforcer.afterHook(terms, afterArgs, defaultMode, "", delegationHash, userSmartAccount, agentWallet);

        // Verify peak updated if yield
        if (postValue > depositAmount) {
            require(enforcer.peakValueUSD6(delegationHash) == postValue, "Peak not updated after yield");
            console.log("  [OK] afterHook: peak updated to", postValue / 1e6, "USD");
        }

        if (feeAmount > 0) {
            uint256 treasuryBalance = IERC20(USDC_ARB).balanceOf(treasury);
            require(treasuryBalance == feeAmount, "Treasury fee not collected");
            console.log("  [OK] afterHook: fee collected:", feeAmount / 1e3, "milli-USDC");
        } else {
            console.log("  [OK] afterHook: no fee (yield below measurement threshold)");
        }

        console.log("  [OK] Full strategy lifecycle completed successfully");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Bonus: Verify new protocol can be added without user re-signing
    // ─────────────────────────────────────────────────────────────────────────

    function _verifyNoResignNeededForNewProtocol() internal {
        console.log("");
        console.log("[BONUS] Verifying zero-re-signing protocol expansion...");

        // Current state: executor has 3 protocols
        uint256 protocolsBefore = executor.getProtocolCount();

        // Owner adds a completely new protocol (e.g. a new yield aggregator)
        address newProtocol = makeAddr("newYieldProtocol");
        vm.etch(newProtocol, hex"6080604052"); // minimal valid bytecode

        vm.prank(deployer);
        executor.addProtocol(newProtocol, "Future Protocol v1");

        require(executor.getProtocolCount() == protocolsBefore + 1, "Protocol count not incremented");
        require(executor.approvedProtocols(newProtocol), "New protocol not approved");

        // Agent can now call the new protocol - same delegation, no re-signing
        bytes memory calldata_ = abi.encodeWithSignature("deposit(uint256)", 100e6);
        // Note: call would fail at execution since it's stub bytecode, but the auth check passes
        bool protocolApproved = executor.approvedProtocols(newProtocol);
        bool agentAuthorized = executor.authorizedCallers(agentWallet);
        require(protocolApproved && agentAuthorized, "Auth state wrong for new protocol");

        console.log("  Protocol count before:", protocolsBefore);
        console.log("  Protocol count after:", executor.getProtocolCount());
        console.log("  [OK] New protocol accessible with existing delegation - ZERO re-signing required");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _checkContract(string memory name, address addr) internal {
        uint256 size;
        assembly { size := extcodesize(addr) }
        if (size > 0) {
            console.log("  [OK] %s", name);
            console.log("       addr: %s  codesize: %d", addr, size);
        } else {
            console.log("  [FAIL] %s - NO CODE AT ADDRESS", name);
            console.log("       addr: %s", addr);
        }
        require(size > 0, string.concat(name, " has no code - wrong address or network"));
    }
}
