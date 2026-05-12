// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Deploy - YieldGeko V2
 * @notice Deploys the three V2 contracts to any EVM chain.
 *
 * Sepolia (test first):
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url https://ethereum-sepolia-rpc.publicnode.com \
 *     --broadcast --private-key $PRIVATE_KEY -vvv
 *
 * Arbitrum Mainnet (after Sepolia validates):
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url https://arb1.arbitrum.io/rpc \
 *     --broadcast --private-key $PRIVATE_KEY \
 *     --verify --etherscan-api-key $ARBISCAN_API_KEY -vvv
 */

import {Script} from "forge-std/Script.sol";
import {console2 as console} from "forge-std/console2.sol";

// DelegationManager is deployed at the same address on every chain via CREATE2
address constant DELEGATION_MANAGER = 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3;

contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployerEOA = vm.addr(deployerKey);
        address agentEOA = vm.envOr("AGENT", deployerEOA);
        address treasury = vm.envOr("TREASURY", deployerEOA);

        console.log("======================================================");
        console.log("YieldGeko V2 Deployment");
        console.log("======================================================");
        console.log("Chain ID:          %d", block.chainid);
        console.log("Deployer:          %s", deployerEOA);
        console.log("Agent:             %s", agentEOA);
        console.log("Treasury:          %s", treasury);
        console.log("DelegationManager: %s", DELEGATION_MANAGER);

        require(DELEGATION_MANAGER.code.length > 0, "DelegationManager not on this chain - check chain ID");

        vm.startBroadcast(deployerKey);

        // ── Deploy ────────────────────────────────────────────────────────────

        address enforcer = _create(
            "YieldGekoPolicyCaveatEnforcer.sol:YieldGekoPolicyCaveatEnforcer",
            abi.encode(deployerEOA, DELEGATION_MANAGER)
        );

        address executor = _create("YieldGekoExecutor.sol:YieldGekoExecutor", abi.encode(deployerEOA));

        address swapper = _create("YieldGekoSwapper.sol:YieldGekoSwapper", abi.encode(deployerEOA));

        // ── Wire: authorize agent in all contracts ────────────────────────────

        _call(enforcer, abi.encodeWithSignature("setAuthorizedAgent(address,bool)", agentEOA, true));
        _call(executor, abi.encodeWithSignature("setAuthorizedCaller(address,bool)", agentEOA, true));
        _call(swapper, abi.encodeWithSignature("setAuthorizedCaller(address,bool)", agentEOA, true));

        console.log("  [OK] Agent %s authorized in all contracts", agentEOA);

        vm.stopBroadcast();

        // ── Print addresses for .env ──────────────────────────────────────────

        console.log("");
        console.log("======================================================");
        console.log("SUCCESS - copy into contracts/.env and agent/.env:");
        console.log("======================================================");
        console.log("ENFORCER_ADDRESS=%s", enforcer);
        console.log("EXECUTOR_ADDRESS=%s", executor);
        console.log("SWAPPER_ADDRESS=%s", swapper);
        console.log("DELEGATION_MANAGER=%s", DELEGATION_MANAGER);
        console.log("CHAIN_ID=%d", block.chainid);
    }

    function _create(string memory artifact, bytes memory constructorArgs) internal returns (address addr) {
        bytes memory initcode = abi.encodePacked(vm.getCode(artifact), constructorArgs);
        assembly {
            addr := create(0, add(initcode, 0x20), mload(initcode))
        }
        string memory name = _contractName(artifact);
        require(addr != address(0) && addr.code.length > 0, string.concat(name, ": deployment failed"));
        console.log("  [OK] %s: %s", name, addr);
    }

    function _call(address target, bytes memory data) internal {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }

    // "Foo.sol:FooContract" -> "FooContract"
    function _contractName(string memory artifact) internal pure returns (string memory) {
        bytes memory b = bytes(artifact);
        for (uint256 i = b.length; i > 0; i--) {
            if (b[i - 1] == ":") {
                bytes memory name = new bytes(b.length - i);
                for (uint256 j = 0; j < name.length; j++) {
                    name[j] = b[i + j];
                }
                return string(name);
            }
        }
        return artifact;
    }
}
