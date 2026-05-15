pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2 as console} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract MockUSDC {
    string public name = "Mock USDC";
    string public symbol = "mUSDC";
    uint8 public decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
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

contract MockYieldProtocol {
    address public token;
    mapping(address => uint256) public deposits;

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    constructor(address _token) {
        token = _token;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(asset == token, "wrong token");
        MockUSDC(token).transferFrom(msg.sender, address(this), amount);
        deposits[onBehalfOf] += amount;
        emit Deposited(onBehalfOf, amount);
    }

    function withdraw(address, uint256 amount, address to) external returns (uint256) {
        require(deposits[msg.sender] >= amount, "insufficient deposit");
        deposits[msg.sender] -= amount;
        MockUSDC(token).transfer(to, amount);
        emit Withdrawn(msg.sender, amount);
        return amount;
    }

    function getDeposit(address user) external view returns (uint256) {
        return deposits[user];
    }
}

address constant HYBRID_DELEGATOR_IMPL = 0x48dBe696A4D990079e039489bA2053B36E8FFEC4;
address constant SIMPLE_FACTORY = 0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c;
address constant EXECUTOR_ADDRESS = 0xA689ed7b137B2268504Bc3eC6F2aCd37eC3a3CeB;

interface ISimpleFactory {
    function deploy(bytes memory bytecode, bytes32 salt) external returns (address);
    function computeAddress(bytes32 bytecodeHash, bytes32 salt) external view returns (address);
}

interface IExecutor {
    function addProtocol(address protocol, string calldata name) external;
    function setAuthorizedCaller(address caller, bool authorized) external;
}

contract DeployMocks is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployerEOA = vm.addr(deployerKey);

        console.log("======================================================");
        console.log("YieldGeko V2 - Deploy Mocks + Smart Account (Sepolia)");
        console.log("======================================================");
        console.log("Deployer: %s", deployerEOA);

        vm.startBroadcast(deployerKey);

        MockUSDC mockUSDC = new MockUSDC();
        console.log("\n  [OK] MockUSDC:           %s", address(mockUSDC));

        MockYieldProtocol mockProtocol = new MockYieldProtocol(address(mockUSDC));
        console.log("  [OK] MockYieldProtocol:  %s", address(mockProtocol));

        IExecutor(EXECUTOR_ADDRESS).addProtocol(address(mockProtocol), "MockYieldProtocol");
        console.log("  [OK] MockYieldProtocol added to YieldGekoExecutor");

        bytes memory initData = abi.encodeWithSignature(
            "initialize(address,string[],uint256[],uint256[])",
            deployerEOA,
            new string[](0),
            new uint256[](0),
            new uint256[](0)
        );
        bytes memory proxyCrtCode =
            abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(HYBRID_DELEGATOR_IMPL, initData));
        bytes32 salt = keccak256(abi.encodePacked("yieldgeko-v2-sepolia-e2e", deployerEOA));

        address predicted = ISimpleFactory(SIMPLE_FACTORY).computeAddress(keccak256(proxyCrtCode), salt);

        address smartAccount;
        if (predicted.code.length > 0) {
            smartAccount = predicted;
            console.log("  [OK] Smart account (existing): %s", smartAccount);
        } else {
            smartAccount = ISimpleFactory(SIMPLE_FACTORY).deploy(proxyCrtCode, salt);
            console.log("  [OK] Smart account (new):      %s", smartAccount);
        }

        IExecutor(EXECUTOR_ADDRESS).setAuthorizedCaller(smartAccount, true);
        console.log("  [OK] Smart account authorized in executor");

        mockUSDC.mint(smartAccount, 2000e6);
        console.log("  [OK] Minted 2,000 mUSDC to smart account");

        vm.stopBroadcast();

        console.log("\n======================================================");
        console.log("Copy these into your .env for the TS test:");
        console.log("======================================================");
        console.log("MOCK_USDC_ADDRESS=%s", address(mockUSDC));
        console.log("MOCK_PROTOCOL_ADDRESS=%s", address(mockProtocol));
        console.log("USER_SMART_ACCOUNT=%s", smartAccount);
    }
}
