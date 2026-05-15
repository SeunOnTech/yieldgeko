pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2 as console} from "forge-std/console2.sol";

contract DeployExecutorV2 is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address owner = vm.addr(key);

        vm.startBroadcast(key);

        bytes memory initcode =
            abi.encodePacked(vm.getCode("YieldGekoExecutor.sol:YieldGekoExecutor"), abi.encode(owner));

        address executor;
        assembly { executor := create(0, add(initcode, 0x20), mload(initcode)) }
        require(executor != address(0) && executor.code.length > 0, "deploy failed");

        vm.stopBroadcast();

        console.log("EXECUTOR_ADDRESS=%s", executor);
    }
}
