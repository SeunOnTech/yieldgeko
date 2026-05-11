// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../contracts/YieldGekoRegistry.sol";

/**
 * @notice  Deploy YieldGekoRegistry to 0G Chain mainnet (chainId 16661).
 *
 * Usage:
 *   cd contracts
 *   PRIVATE_KEY=0x... forge script script/DeployRegistry.s.sol \
 *     --rpc-url https://evmrpc.0g.ai \
 *     --broadcast -vvvv
 *
 * After deploy, set ZG_REGISTRY_ADDRESS in packages/agent/.env
 */
contract DeployRegistry is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("Deployer:  ", deployer);
        console.log("Chain ID:  ", block.chainid);
        console.log("Balance:   ", deployer.balance / 1e18, "OG");

        vm.startBroadcast(deployerKey);

        YieldGekoRegistry registry = new YieldGekoRegistry();

        // Authorise the agent wallet if provided
        address agentWallet = vm.envOr("AGENT_WALLET", address(0));
        if (agentWallet != address(0) && agentWallet != deployer) {
            registry.setAgentAuthorised(agentWallet, true);
            console.log("Agent authorised:", agentWallet);
        }

        vm.stopBroadcast();

        console.log("\n======================================================");
        console.log("YieldGekoRegistry deployed:");
        console.log("  Address:  ", address(registry));
        console.log("  Explorer: https://chainscan.0g.ai/address/", address(registry));
        console.log("\nAdd to packages/agent/.env:");
        console.log("  ZG_REGISTRY_ADDRESS=", address(registry));
        console.log("======================================================\n");
    }
}
