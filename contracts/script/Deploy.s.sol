// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "forge-std/Script.sol";
import "../contracts/YieldGeko.sol";

/**
 * @title Deploy
 * @notice Deploys YieldGeko.sol and whitelists all supported protocol targets.
 *
 * Usage — Arbitrum:
 *   PRIVATE_KEY=0x... AGENT=0x... TREASURY=0x... \
 *   forge script script/Deploy.s.sol --rpc-url https://arb1.arbitrum.io/rpc \
 *     --broadcast --verify --etherscan-api-key $ARBISCAN_API_KEY -vvvv
 *
 * Usage — 0G Mainnet:
 *   PRIVATE_KEY=0x... AGENT=0x... TREASURY=0x... \
 *   forge script script/Deploy.s.sol --rpc-url https://evmrpc.0g.ai \
 *     --broadcast -vvvv
 */
contract Deploy is Script {
    // ── Arbitrum protocol addresses ───────────────────────────────────────────
    // These are the addresses the agent is authorised to call.
    // On 0G Mainnet (only UniV3 deployed), only add addresses that exist.

    // Aave V3
    address constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;

    // Morpho Blue
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    // Morpho MetaMorpho vaults
    address constant MORPHO_USDC = 0xd63070114470f685b75B74D60EEc7c1113d33a3D; // Gauntlet USDC
    address constant MORPHO_USDT = 0x2c25f6c25770ffEF5B59d4C8787B21e2E2b4B345; // Gauntlet USDT
    address constant MORPHO_WETH = 0xBd5b3e4dcE14D1B390C332F36E25e3d3dA47b0b1; // Steakhouse WETH

    // Uniswap V3
    // SwapRouter02 is used by the agent for DELTA_NEUTRAL USDC→token swaps (not V1 router)
    address constant UNI_V3_SWAP_ROUTER02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address constant UNI_V3_POSITION_MGR = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;

    // Pendle
    address constant PENDLE_ROUTER = 0x888888888889758F76e7103c6CbF23ABbF58F946;

    // GMX V2
    address constant GMX_EXCHANGE_ROUTER = 0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41;
    address constant GMX_DEPOSIT_VAULT = 0xF89e77e8Dc11691C9e8757e84aaFbCD8A67d7A55;
    address constant GMX_WITHDRAWAL_VAULT = 0x0628D46b5D145f183AdB6Ef1f2c97eD1C4701C55;
    address constant GMX_ORDER_VAULT = 0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5;
    address constant GMX_ROUTER = 0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6;

    // USDC (for approveToken)
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address constant USDT = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;

    function run() external {
        address agent = vm.envAddress("AGENT");
        address treasury = vm.envAddress("TREASURY");
        uint256 feeBps = vm.envOr("DEFAULT_FEE_BPS", uint256(10)); // 0.10%

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));

        YieldGeko vault = new YieldGeko(agent, treasury, feeBps);
        console.log("YieldGeko deployed:", address(vault));
        console.log("  agent:    ", agent);
        console.log("  treasury: ", treasury);
        console.log("  feeBps:   ", feeBps);

        uint256 chainId = block.chainid;
        console.log("  chainId:  ", chainId);

        // ── Whitelist protocol targets ─────────────────────────────────────
        // Only whitelist addresses that are live on this chain.
        // 0G Mainnet (16661) only has UniV3; Arbitrum has all protocols.

        // UniV3: both SwapRouter02 (for DELTA_NEUTRAL swaps) and NonfungiblePositionManager (for LP minting)
        // SwapRouter02 replaces V1 router — agent uses it for exactInputSingle token swaps
        vault.approveTarget(chainId, UNI_V3_SWAP_ROUTER02);
        vault.approveTarget(chainId, UNI_V3_POSITION_MGR);
        console.log("  UniV3 targets approved (SwapRouter02 + PositionManager)");

        if (chainId == 42161) {
            // Arbitrum only
            vault.approveTarget(chainId, AAVE_POOL);
            vault.approveTarget(chainId, MORPHO);
            vault.approveTarget(chainId, MORPHO_USDC);
            vault.approveTarget(chainId, MORPHO_USDT);
            vault.approveTarget(chainId, MORPHO_WETH);
            vault.approveTarget(chainId, PENDLE_ROUTER);
            vault.approveTarget(chainId, GMX_EXCHANGE_ROUTER);
            vault.approveTarget(chainId, GMX_DEPOSIT_VAULT);
            vault.approveTarget(chainId, GMX_WITHDRAWAL_VAULT);
            vault.approveTarget(chainId, GMX_ORDER_VAULT);
            vault.approveTarget(chainId, GMX_ROUTER);
            console.log("  Arbitrum-specific targets approved (Aave, Morpho, Pendle, GMX)");
        }

        vm.stopBroadcast();

        // Print env vars to copy into .env files
        console.log("\n=== Copy these into your .env files ===");
        console.log("VAULT_ADDRESS=", vm.toString(address(vault)));
        console.log("NEXT_PUBLIC_VAULT_ADDRESS=", vm.toString(address(vault)));
    }
}
