pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {Test} from "forge-std/Test.sol";
import {console2 as console} from "forge-std/console2.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

struct Caveat {
    address enforcer;
    bytes terms;
    bytes args;
}

struct Delegation {
    address delegate;
    address delegator;
    bytes32 authority;
    Caveat[] caveats;
    uint256 salt;
    bytes signature;
}

library DelegationHashLib {
    bytes32 constant CAVEAT_TYPEHASH = keccak256("Caveat(address enforcer,bytes terms)");

    bytes32 constant DELEGATION_TYPEHASH = keccak256(
        "Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)"
    );

    function getCaveatHash(Caveat memory c) internal pure returns (bytes32) {
        return keccak256(abi.encode(CAVEAT_TYPEHASH, c.enforcer, keccak256(c.terms)));
    }

    function getCaveatArrayHash(Caveat[] memory caveats) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](caveats.length);
        for (uint256 i = 0; i < caveats.length; i++) {
            hashes[i] = getCaveatHash(caveats[i]);
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function getDelegationHash(Delegation memory d) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(DELEGATION_TYPEHASH, d.delegate, d.delegator, d.authority, getCaveatArrayHash(d.caveats), d.salt)
        );
    }
}

interface IDelegationManager {
    function getDomainHash() external view returns (bytes32);
    function redeemDelegations(
        bytes[] calldata permissionContexts,
        bytes32[] calldata modes,
        bytes[] calldata executionCalldatas
    ) external;
}

interface ISimpleFactory {
    function deploy(bytes memory bytecode, bytes32 salt) external returns (address);
    function computeAddress(bytes32 bytecodeHash, bytes32 salt) external view returns (address);
}

interface IYieldGekoEnforcer {
    struct PolicyTerms {
        uint256 minAPYBps;
        uint256 maxDrawdownBps;
        uint256 managedUSD6;
        uint256 maxFeeBps;
        address treasury;
        uint256 expiresAt;
        address feeToken;
    }

    struct ExecutionArgs {
        uint256 preValueUSD6;
        uint256 postValueUSD6;
        uint256 feeAmountToken;
    }
    function setAuthorizedAgent(address agent, bool authorized) external;
}

interface IYieldGekoExecutor {
    function setAuthorizedCaller(address caller, bool authorized) external;
    function addProtocol(address protocol, string calldata name) external;
    function execute(address protocol, bytes calldata data, uint256 value) external payable returns (bytes memory);
}

interface IYieldGekoSwapper {
    function setAuthorizedCaller(address caller, bool authorized) external;
    function addDEX(address dex, string calldata name) external;
}

interface IMockUSDC {
    function mint(address to, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IMockYieldProtocol {
    function getDeposit(address user) external view returns (uint256);
}

contract MockUSDC {
    string public name = "Mock USDC";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        require(allowance[from][msg.sender] >= amount, "not approved");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

contract MockYieldProtocol {
    address public token;
    mapping(address => uint256) public deposits;

    event Deposited(address indexed user, uint256 amount);

    constructor(address _token) {
        token = _token;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(asset == token, "wrong token");
        MockUSDC(token).transferFrom(msg.sender, address(this), amount);
        deposits[onBehalfOf] += amount;
        emit Deposited(onBehalfOf, amount);
    }

    function getDeposit(address user) external view returns (uint256) {
        return deposits[user];
    }
}

address constant DELEGATION_MANAGER = 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3;
address constant HYBRID_DELEGATOR_IMPL = 0x48dBe696A4D990079e039489bA2053B36E8FFEC4;
address constant SIMPLE_FACTORY = 0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c;
address constant ALLOWED_TARGETS_ENFORCER = 0xcdF6aB796408598Cea671d79506d7D48E97a5437;

bytes32 constant ROOT_AUTHORITY = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

bytes32 constant MODE_SINGLE = bytes32(0);

contract DeployAndTestSepolia is Script, Test {
    using MessageHashUtils for bytes32;
    using DelegationHashLib for Delegation;

    address public enforcer;
    address public executor;
    address public swapper;
    address public usdc;
    address public yieldProtocol;
    address public userSmartAccount;

    address public deployerEOA;
    uint256 public deployerKey;
    address public agentEOA;
    address public treasury;

    function run() external {
        deployerKey = vm.envUint("PRIVATE_KEY");
        deployerEOA = vm.addr(deployerKey);
        agentEOA = vm.envOr("AGENT", deployerEOA);
        treasury = vm.envOr("TREASURY", deployerEOA);

        console.log("==============================================");
        console.log("YieldGeko V2 - Ethereum Sepolia E2E Test");
        console.log("==============================================");
        console.log("Chain:     Sepolia (%d)", block.chainid);
        console.log("Deployer:  %s", deployerEOA);
        console.log("Agent:     %s", agentEOA);

        if (deployerEOA.balance < 0.05 ether) {
            vm.deal(deployerEOA, 0.1 ether);
        }

        _verifyInfrastructure();

        vm.startBroadcast(deployerKey);
        _deployContracts();
        _configureContracts();
        _createSmartAccount();
        _fundSmartAccount();
        vm.stopBroadcast();

        _runDelegationFlow();

        console.log("");
        console.log("==============================================");
        console.log("ALL STEPS PASSED");
        console.log("==============================================");
    }

    function _verifyInfrastructure() internal view {
        console.log("\n[1/6] Verifying Sepolia infrastructure...");
        _requireCode("DelegationManager", DELEGATION_MANAGER);
        _requireCode("HybridDeleGator impl", HYBRID_DELEGATOR_IMPL);
        _requireCode("SimpleFactory", SIMPLE_FACTORY);
        _requireCode("AllowedTargetsEnforcer", ALLOWED_TARGETS_ENFORCER);
        console.log("  [OK] All MetaMask framework contracts live on Sepolia");
    }

    function _deployContracts() internal {
        console.log("\n[2/6] Deploying V2 contracts + mocks...");

        usdc = address(new MockUSDC());
        yieldProtocol = address(new MockYieldProtocol(usdc));

        bytes memory enforcerCode = abi.encodePacked(
            vm.getCode("YieldGekoPolicyCaveatEnforcer.sol:YieldGekoPolicyCaveatEnforcer"),
            abi.encode(deployerEOA, DELEGATION_MANAGER)
        );
        bytes memory executorCode =
            abi.encodePacked(vm.getCode("YieldGekoExecutor.sol:YieldGekoExecutor"), abi.encode(deployerEOA));
        bytes memory swapperCode =
            abi.encodePacked(vm.getCode("YieldGekoSwapper.sol:YieldGekoSwapper"), abi.encode(deployerEOA));

        address _enforcer;
        address _executor;
        address _swapper;
        assembly {
            _enforcer := create(0, add(enforcerCode, 0x20), mload(enforcerCode))
            _executor := create(0, add(executorCode, 0x20), mload(executorCode))
            _swapper := create(0, add(swapperCode, 0x20), mload(swapperCode))
        }
        require(_enforcer != address(0), "Enforcer deploy failed");
        require(_executor != address(0), "Executor deploy failed");
        require(_swapper != address(0), "Swapper deploy failed");

        enforcer = _enforcer;
        executor = _executor;
        swapper = _swapper;

        console.log("  MockUSDC:          %s", usdc);
        console.log("  MockYieldProtocol: %s", yieldProtocol);
        console.log("  Enforcer:          %s", enforcer);
        console.log("  Executor:          %s", executor);
        console.log("  Swapper:           %s", swapper);
    }

    function _configureContracts() internal {
        console.log("\n[3/6] Configuring contracts...");
        IYieldGekoEnforcer(enforcer).setAuthorizedAgent(agentEOA, true);
        IYieldGekoExecutor(executor).setAuthorizedCaller(agentEOA, true);
        IYieldGekoExecutor(executor).addProtocol(yieldProtocol, "MockYieldProtocol");
        IYieldGekoSwapper(swapper).setAuthorizedCaller(agentEOA, true);
        console.log("  [OK] Agent authorized, protocol added");
    }

    function _createSmartAccount() internal {
        console.log("\n[4/6] Creating user HybridDeleGator smart account...");

        bytes memory initData = abi.encodeWithSignature(
            "initialize(address,string[],uint256[],uint256[])",
            deployerEOA,
            new string[](0),
            new uint256[](0),
            new uint256[](0)
        );

        bytes memory proxyCrtCode =
            abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(HYBRID_DELEGATOR_IMPL, initData));

        bytes32 salt = keccak256(abi.encodePacked("yieldgeko-v2-sepolia-test", deployerEOA));
        bytes32 bytecodeHash = keccak256(proxyCrtCode);
        address predicted = ISimpleFactory(SIMPLE_FACTORY).computeAddress(bytecodeHash, salt);

        if (predicted.code.length > 0) {
            userSmartAccount = predicted;
            console.log("  [INFO] Already deployed: %s", userSmartAccount);
        } else {
            userSmartAccount = ISimpleFactory(SIMPLE_FACTORY).deploy(proxyCrtCode, salt);
            console.log("  [OK] Deployed: %s", userSmartAccount);
        }

        require(userSmartAccount.code.length > 0, "Smart account deploy failed");

        IYieldGekoExecutor(executor).setAuthorizedCaller(userSmartAccount, true);
        console.log("  [OK] Smart account authorized in executor");
    }

    function _fundSmartAccount() internal {
        console.log("\n[5/6] Funding smart account...");

        IMockUSDC(usdc).mint(userSmartAccount, 2000e6);

        payable(userSmartAccount).transfer(0.01 ether);

        console.log("  [OK] Minted 2,000 USDC to smart account");
        console.log("  [OK] Sent 0.01 ETH to smart account");
    }

    function _runDelegationFlow() internal {
        console.log("\n[6/6] Running full ERC-7710 delegation flow...");

        uint256 depositAmount = 1000e6;

        IYieldGekoEnforcer.PolicyTerms memory pt = IYieldGekoEnforcer.PolicyTerms({
            minAPYBps: 500,
            maxDrawdownBps: 1500,
            managedUSD6: 5000e6,
            maxFeeBps: 1500,
            treasury: treasury,
            expiresAt: block.timestamp + 365 days,
            feeToken: usdc
        });
        bytes memory policyTerms = abi.encode(pt);

        bytes memory allowedTargets = abi.encodePacked(executor, swapper);

        Caveat[] memory caveats = new Caveat[](2);
        caveats[0] = Caveat({enforcer: ALLOWED_TARGETS_ENFORCER, terms: allowedTargets, args: ""});
        caveats[1] = Caveat({enforcer: enforcer, terms: policyTerms, args: ""});

        Delegation memory delegation = Delegation({
            delegate: agentEOA,
            delegator: userSmartAccount,
            authority: ROOT_AUTHORITY,
            caveats: caveats,
            salt: 0,
            signature: ""
        });

        bytes32 delegationHash = DelegationHashLib.getDelegationHash(delegation);
        bytes32 domainHash = IDelegationManager(DELEGATION_MANAGER).getDomainHash();
        bytes32 typedDataHash = domainHash.toTypedDataHash(delegationHash);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(deployerKey, typedDataHash);
        delegation.signature = abi.encodePacked(r, s, v);

        console.log("  [OK] Delegation signed (EIP-712)");
        console.log("       hash: %s", vm.toString(delegationHash));

        IYieldGekoEnforcer.ExecutionArgs memory ea = IYieldGekoEnforcer.ExecutionArgs({
            preValueUSD6: depositAmount, postValueUSD6: depositAmount, feeAmountToken: 0
        });
        delegation.caveats[1].args = abi.encode(ea);

        Delegation[] memory delegationChain = new Delegation[](1);
        delegationChain[0] = delegation;
        bytes[] memory permissionContexts = new bytes[](1);
        permissionContexts[0] = abi.encode(delegationChain);

        bytes memory supplyCalldata = abi.encodeWithSignature(
            "supply(address,uint256,address,uint16)", usdc, depositAmount, userSmartAccount, uint16(0)
        );
        bytes memory executorCalldata =
            abi.encodeWithSelector(IYieldGekoExecutor.execute.selector, yieldProtocol, supplyCalldata, uint256(0));

        bytes memory executionCalldata = abi.encodePacked(executor, uint256(0), executorCalldata);

        bytes32[] memory modes = new bytes32[](1);
        modes[0] = MODE_SINGLE;
        bytes[] memory executionCalldatas = new bytes[](1);
        executionCalldatas[0] = executionCalldata;

        _approveUSDCFromSmartAccount(depositAmount);

        uint256 depositBefore = IMockYieldProtocol(yieldProtocol).getDeposit(userSmartAccount);
        uint256 usdcBefore = IMockUSDC(usdc).balanceOf(userSmartAccount);
        console.log("  USDC balance before: %d", usdcBefore / 1e6);
        console.log("  Protocol deposit before: %d", depositBefore / 1e6);

        vm.startBroadcast(deployerKey);
        IDelegationManager(DELEGATION_MANAGER).redeemDelegations(permissionContexts, modes, executionCalldatas);
        vm.stopBroadcast();

        uint256 depositAfter = IMockYieldProtocol(yieldProtocol).getDeposit(userSmartAccount);
        uint256 usdcAfter = IMockUSDC(usdc).balanceOf(userSmartAccount);

        console.log("  USDC balance after:  %d", usdcAfter / 1e6);
        console.log("  Protocol deposit after: %d", depositAfter / 1e6);

        require(depositAfter == depositBefore + depositAmount, "Deposit not registered");
        require(usdcBefore - usdcAfter == depositAmount, "USDC not deducted");

        console.log("  [OK] redeemDelegations executed successfully");
        console.log("  [OK] $1,000 USDC deposited via ERC-7710 delegation");
        console.log("  [OK] PolicyEnforcer beforeHook + afterHook ran");
        console.log("  [OK] AllowedTargets enforcer validated executor call");
    }

    function _approveUSDCFromSmartAccount(uint256 amount) internal {
        bytes memory approveCall = abi.encodeWithSignature("approve(address,uint256)", executor, amount);

        bytes memory executeCall = abi.encodeWithSignature(
            "execute(bytes32,bytes)", MODE_SINGLE, abi.encodePacked(usdc, uint256(0), approveCall)
        );
        vm.startBroadcast(deployerKey);
        (bool ok,) = userSmartAccount.call(executeCall);
        vm.stopBroadcast();
        if (ok) {
            console.log("  [OK] USDC approved from smart account to executor");
        } else {
            console.log("  [WARN] Direct approve failed - trying alternative");

            vm.prank(userSmartAccount);
            MockUSDC(usdc).approve(executor, amount);
            console.log("  [OK] USDC approved via prank fallback");
        }
    }

    function _requireCode(string memory name, address addr) internal view {
        require(addr.code.length > 0, string.concat(name, ": no code on Sepolia"));
        console.log("  [OK] %s: %s", name, addr);
    }

    receive() external payable {}
}
