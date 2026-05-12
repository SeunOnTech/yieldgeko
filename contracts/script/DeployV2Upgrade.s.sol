// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Script} from "forge-std/Script.sol";
import {console2 as console} from "forge-std/console2.sol";
import {YieldGekoExecutor} from "../contracts/YieldGekoExecutor.sol";
import {YieldGekoSwapper} from "../contracts/YieldGekoSwapper.sol";

/**
 * @notice Deploy upgraded YieldGekoExecutor + YieldGekoSwapper, wire up
 *         protocols/DEXes and treasury in one broadcast.
 *
 * Changes vs previous deployment:
 *   Executor:
 *     - executeWithPull / executeWithPullTwo: onlyAuthorized removed
 *     - executeFromBalance: new (non-USDC delta-neutral, dust→treasury)
 *     - executePullAndFromBalance: new (USDC-pair delta-neutral, dust→treasury)
 *     - rescueToken, setTreasury: new admin helpers
 *   Swapper:
 *     - swap: onlyAuthorized removed (permissionless, spends caller's tokens only)
 *
 * Run:
 *   PRIVATE_KEY=0x... forge script script/DeployV2Upgrade.s.sol \
 *     --rpc-url https://arb1.arbitrum.io/rpc --broadcast -vvvv
 */
contract DeployV2Upgrade is Script {
    // ── Arbitrum mainnet addresses ─────────────────────────────────────────────

    address constant TREASURY = 0xd61E4Bfb67514d8ad797495A584f70Cd0878fc5A;
    address constant SWAP_ROUTER02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address constant MORPHO = 0x33333AEA097C193e912C8cC6d0Bc1C99a3B5D0b3; // Morpho Blue on Arbitrum
    address constant UNIV3_POS_MGR = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
    address constant PENDLE_ROUTER = 0x888888888889758F76e7103c6CbF23ABbF58F946;
    address constant ODOS_ROUTER = 0xa669e7A0d4b3e4Fa48af2dE86BD4CD7126Be4e13;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("Deployer:  %s", deployer);
        console.log("Treasury:  %s", TREASURY);

        vm.startBroadcast(deployerKey);

        // ── Deploy Executor ────────────────────────────────────────────────────
        YieldGekoExecutor executor = new YieldGekoExecutor(deployer);

        executor.setTreasury(TREASURY);

        executor.addProtocol(AAVE_POOL, "Aave V3");
        executor.addProtocol(MORPHO, "Morpho Blue");
        executor.addProtocol(UNIV3_POS_MGR, "UniV3 NonfungiblePositionManager");
        executor.addProtocol(PENDLE_ROUTER, "Pendle Router");

        // ── Deploy Swapper ────────────────────────────────────────────────────
        YieldGekoSwapper swapper = new YieldGekoSwapper(deployer);

        swapper.addDEX(SWAP_ROUTER02, "Uniswap SwapRouter02");
        swapper.addDEX(ODOS_ROUTER, "Odos V2");

        vm.stopBroadcast();

        console.log("");
        console.log("=== Deployment complete ===");
        console.log("EXECUTOR_ADDRESS=%s", address(executor));
        console.log("SWAPPER_ADDRESS=%s", address(swapper));
        console.log("");
        console.log("Next steps:");
        console.log("  1. Update addresses.json  executor + swapper for chain 42161");
        console.log("  2. Update .env            EXECUTOR_ADDRESS + SWAPPER_ADDRESS");
        console.log("  3. Run debugV2Execution.ts to verify contracts end-to-end");
    }
}
