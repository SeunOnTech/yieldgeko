pragma solidity ^0.8.34;

import "forge-std/Test.sol";
import "../contracts/YieldGeko.sol";

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external;
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

interface IERC20Fork {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IERC4626Fork {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function balanceOf(address) external view returns (uint256);
    function totalAssets() external view returns (uint256);
    function asset() external view returns (address);
}

interface IUniV3Pool {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

interface IUniV3PositionMgr {
    function balanceOf(address) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract YieldGekoForkTest is Test {
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address constant USDCE = 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8;
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address constant USDAI = 0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF;

    address constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;

    address constant MORPHO_VAULT = 0xf56932d6bd0b99aadD8B77117e08374A14520dbE;

    address constant PENDLE_ROUTER = 0x888888888889758F76e7103c6CbF23ABbF58F946;
    address constant PENDLE_MARKET = 0x8A8A557b90eC79496a18a1f9C9DA8Bbd7DB86Fd3;
    address constant PENDLE_PT = 0x1cdDE40e29dA213f42A7fA109CcADCA372d9Ee1B;
    address constant PENDLE_YT = 0x5De2065F3C709b24f31c736Ef28c1CbB27cEedfc;
    address constant PENDLE_SY = 0x5edCBC20Cac67AdC2e724d4348Ff85132B085b82;
    uint256 constant PENDLE_EXPIRY = 1781740800;

    address constant GMX_EXCHANGE_ROUTER = 0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41;
    address constant GMX_ROUTER = 0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6;
    address constant GMX_ORDER_VAULT = 0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5;
    address constant GMX_DEPOSIT_VAULT = 0xF89e77e8Dc11691C9e8757e84aaFbCD8A67d7A55;
    address constant GMX_WITHDRAWAL_VAULT = 0x0628D46b5D145f183AdB6Ef1f2c97eD1C4701C55;
    address constant GMX_ETH_USD_MARKET = 0x70d95587d40A2caf56bd97485aB3Eec10Bee6336;

    address constant UNI_V3_POSITION_MGR = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
    address constant UNI_USDC_WETH_POOL = 0x17c14D2c404D167802b16C450d3c99F88F2c4F4d;

    address constant OWNER = address(0x1001);
    address constant AGENT = address(0x1002);
    address constant TREASURY = address(0x1003);
    uint256 constant USER_KEY = 0xF04C7E571234;
    address USER;

    YieldGeko vault;

    function setUp() public {
        string memory rpc = vm.envOr("ARB_RPC_URL", string("https://arbitrum-one-rpc.publicnode.com"));
        vm.createSelectFork(rpc);

        USER = vm.addr(USER_KEY);

        vm.startPrank(OWNER);
        vault = new YieldGeko(AGENT, TREASURY, 10);

        vault.approveTarget(block.chainid, AAVE_POOL);
        vault.approveTarget(block.chainid, MORPHO_VAULT);
        vault.approveTarget(block.chainid, PENDLE_ROUTER);
        vault.approveTarget(block.chainid, GMX_EXCHANGE_ROUTER);
        vault.approveTarget(block.chainid, GMX_ROUTER);
        vault.approveTarget(block.chainid, UNI_V3_POSITION_MGR);
        vm.stopPrank();

        _registerTestPolicy();

        deal(USDC, USER, 100_000e6);
        deal(USDCE, USER, 100_000e6);
        deal(AGENT, 1 ether);
    }

    function _registerTestPolicy() internal {
        YieldGeko.Policy memory p = YieldGeko.Policy({
            user: USER,
            managedUSD: type(uint256).max / 1e18,
            minAPY: 0,
            maxDrawdownBps: 5_000,
            maxFeeBps: 200,
            nonce: 0,
            deadline: block.timestamp + 365 days
        });
        bytes32 structHash = keccak256(
            abi.encode(
                vault.POLICY_TYPEHASH(),
                p.user,
                p.managedUSD,
                p.minAPY,
                p.maxDrawdownBps,
                p.maxFeeBps,
                p.nonce,
                p.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_KEY, digest);
        vm.prank(AGENT);
        vault.registerPolicy(p, abi.encodePacked(r, s, v));
    }

    function test_Fork_VaultDepositWithdraw() public {
        vm.startPrank(USER);
        IERC20Fork(USDC).approve(address(vault), 1_000e6);
        vault.deposit(USDC, 1_000e6);
        vm.stopPrank();

        assertEq(vault.balances(USER, USDC), 1_000e6);

        vm.prank(USER);
        vault.withdraw(USDC, 500e6);

        assertEq(vault.balances(USER, USDC), 500e6);
    }

    function test_Fork_OnlyAgentCanExecute() public {
        vm.prank(USER);
        vm.expectRevert(YieldGeko.NotAgent.selector);
        vault.execute(USER, AAVE_POOL, "", keccak256("r"), USDC);
    }

    function test_Fork_PauseBlocksAll() public {
        vm.prank(OWNER);
        vault.pause();
        vm.prank(AGENT);
        vm.expectRevert();
        vault.execute(USER, AAVE_POOL, "", keccak256("r"), USDC);
    }

    function test_Fork_Aave_Supply() public {
        _depositToVault(USDC, 1_000e6);

        vm.startPrank(AGENT);
        vault.approveToken(USDC, AAVE_POOL, 1_000e6);
        vault.executeDeposit(
            USER,
            USDC,
            1_000e6,
            0,
            AAVE_POOL,
            abi.encodeWithSignature("supply(address,uint256,address,uint16)", USDC, 1_000e6, address(vault), 0),
            keccak256("aave-supply")
        );
        vm.stopPrank();

        (uint256 col,,,,,) = IAavePool(AAVE_POOL).getUserAccountData(address(vault));
        assertGt(col, 0, "No collateral in Aave");
        assertEq(IERC20Fork(USDC).balanceOf(address(vault)), 0, "USDC should be in Aave");
    }

    function test_Fork_Aave_SupplyAndWithdraw() public {
        _depositToVault(USDC, 1_000e6);

        vm.startPrank(AGENT);
        vault.approveToken(USDC, AAVE_POOL, 1_000e6);
        vault.executeDeposit(
            USER,
            USDC,
            1_000e6,
            0,
            AAVE_POOL,
            abi.encodeWithSignature("supply(address,uint256,address,uint16)", USDC, 1_000e6, address(vault), 0),
            keccak256("supply")
        );
        vault.executeWithdraw(
            USER,
            USDC,
            1_000e6,
            AAVE_POOL,
            abi.encodeWithSignature("withdraw(address,uint256,address)", USDC, type(uint256).max, address(vault)),
            keccak256("withdraw")
        );
        vm.stopPrank();

        assertGe(IERC20Fork(USDC).balanceOf(address(vault)), 1_000e6 - 10, "Should recover principal");
    }

    function test_Fork_Aave_BatchSupply() public {
        _depositToVault(USDC, 2_000e6);

        address[] memory targets = new address[](2);
        bytes[] memory data = new bytes[](2);
        targets[0] = AAVE_POOL;
        data[0] = abi.encodeWithSignature("supply(address,uint256,address,uint16)", USDC, 1_000e6, address(vault), 0);
        targets[1] = AAVE_POOL;
        data[1] = abi.encodeWithSignature("supply(address,uint256,address,uint16)", USDC, 1_000e6, address(vault), 0);

        vm.startPrank(AGENT);
        vault.approveToken(USDC, AAVE_POOL, 2_000e6);
        vault.executeBatch(USER, USDC, targets, data, keccak256("batch-supply"));
        vm.stopPrank();

        assertEq(IERC20Fork(USDC).balanceOf(address(vault)), 0, "All USDC should be in Aave");
        (uint256 col,,,,,) = IAavePool(AAVE_POOL).getUserAccountData(address(vault));
        assertGt(col, 0, "No Aave collateral after batch");
    }

    function test_Fork_Aave_BatchReverts_Atomically() public {
        _depositToVault(USDC, 1_000e6);

        address[] memory targets = new address[](2);
        bytes[] memory data = new bytes[](2);
        targets[0] = AAVE_POOL;
        data[0] = abi.encodeWithSignature("supply(address,uint256,address,uint16)", USDC, 1_000e6, address(vault), 0);
        targets[1] = AAVE_POOL;
        data[1] = abi.encodeWithSignature(
            "borrow(address,uint256,uint256,uint16,address)", USDC, 999_000e6, 2, 0, address(vault)
        );

        vm.startPrank(AGENT);
        vault.approveToken(USDC, AAVE_POOL, 1_000e6);
        vm.expectRevert("Batch step failed");
        vault.executeBatch(USER, USDC, targets, data, keccak256("bad-batch"));
        vm.stopPrank();

        (uint256 col,,,,,) = IAavePool(AAVE_POOL).getUserAccountData(address(vault));
        assertEq(col, 0, "Batch should have fully reverted");
    }

    function test_Fork_Morpho_DepositAndWithdraw() public {
        assertEq(IERC4626Fork(MORPHO_VAULT).asset(), USDC, "Vault asset mismatch");

        _depositToVault(USDC, 1_000e6);

        vm.startPrank(AGENT);
        vault.approveToken(USDC, MORPHO_VAULT, 1_000e6);
        vault.executeDeposit(
            USER,
            USDC,
            1_000e6,
            0,
            MORPHO_VAULT,
            abi.encodeWithSignature("deposit(uint256,address)", 1_000e6, address(vault)),
            keccak256("morpho-deposit")
        );
        vm.stopPrank();

        uint256 shares = IERC4626Fork(MORPHO_VAULT).balanceOf(address(vault));
        assertGt(shares, 0, "No Morpho shares received");
        assertEq(IERC20Fork(USDC).balanceOf(address(vault)), 0, "USDC should be in Morpho");

        vm.startPrank(AGENT);
        vault.executeWithdraw(
            USER,
            USDC,
            1_000e6,
            MORPHO_VAULT,
            abi.encodeWithSignature("withdraw(uint256,address,address)", 1_000e6 - 1, address(vault), address(vault)),
            keccak256("morpho-withdraw")
        );
        vm.stopPrank();

        assertGt(IERC20Fork(USDC).balanceOf(address(vault)), 0, "No USDC returned from Morpho");
    }

    function test_Fork_Pendle_SwapForPT() public {
        uint256 amount = 1_000e18;
        _depositToVault(USDAI, amount);

        PendleCalldataBuilder builder = new PendleCalldataBuilder();
        bytes memory callData =
            builder.buildSwapForPt(address(vault), PENDLE_MARKET, (amount * 90) / 100, USDAI, amount);

        vm.startPrank(AGENT);
        vault.approveToken(USDAI, PENDLE_ROUTER, amount);
        vault.executeDeposit(USER, USDAI, amount, 0, PENDLE_ROUTER, callData, keccak256("pendle-pt"));
        vm.stopPrank();

        uint256 ptBalance = IERC20Fork(PENDLE_PT).balanceOf(address(vault));
        assertGt(ptBalance, 0, "No PT received from Pendle");
    }

    function test_Fork_UniV3_MintLP() public {
        (, int24 currentTick,,,,,) = IUniV3Pool(UNI_USDC_WETH_POOL).slot0();

        int24 tickSpacing = 60;
        int24 currentFloor = currentTick >= 0
            ? (currentTick / tickSpacing) * tickSpacing
            : ((currentTick - tickSpacing + 1) / tickSpacing) * tickSpacing;

        int24 tickLower = currentFloor - tickSpacing * 5;
        int24 tickUpper = currentFloor + tickSpacing * 5;

        uint256 wethAmount = 0.1 ether;
        uint256 usdceAmount = 300e6;
        _depositToVault(WETH, wethAmount);
        _depositToVault(USDCE, usdceAmount);

        bytes memory callData = abi.encodeWithSelector(
            bytes4(
                keccak256("mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))")
            ),
            WETH,
            USDCE,
            uint24(3000),
            tickLower,
            tickUpper,
            wethAmount,
            usdceAmount,
            uint256(0),
            uint256(0),
            address(vault),
            block.timestamp + 600
        );

        vm.startPrank(AGENT);
        vault.approveToken(WETH, UNI_V3_POSITION_MGR, wethAmount);
        vault.approveToken(USDCE, UNI_V3_POSITION_MGR, usdceAmount);
        address[] memory assets = new address[](2);
        assets[0] = WETH;
        assets[1] = USDCE;
        address[] memory targets = new address[](1);
        targets[0] = UNI_V3_POSITION_MGR;
        bytes[] memory data = new bytes[](1);
        data[0] = callData;
        vault.executeBatchMulti(USER, assets, targets, data, keccak256("univ3-mint"));
        vm.stopPrank();

        uint256 nftBalance = IUniV3PositionMgr(UNI_V3_POSITION_MGR).balanceOf(address(vault));
        assertGt(nftBalance, 0, "No UniV3 NFT received");
    }

    function test_Fork_GMX_CreateDeposit() public {
        uint256 usdcAmount = 1_000e6;
        uint256 execFee = 1e15;
        _depositToVault(USDC, usdcAmount);
        deal(AGENT, 1 ether);

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSignature("sendWnt(address,uint256)", GMX_DEPOSIT_VAULT, execFee);
        calls[1] = abi.encodeWithSignature("sendTokens(address,address,uint256)", USDC, GMX_DEPOSIT_VAULT, usdcAmount);
        bytes memory multicallData = abi.encodeWithSignature("multicall(bytes[])", calls);

        uint256 balanceBefore = IERC20Fork(USDC).balanceOf(GMX_DEPOSIT_VAULT);

        vm.startPrank(AGENT);
        vault.approveToken(USDC, GMX_ROUTER, usdcAmount);
        vault.executeDeposit{value: execFee}(
            USER, USDC, usdcAmount, 0, GMX_EXCHANGE_ROUTER, multicallData, keccak256("gmx-tokens")
        );
        vm.stopPrank();

        assertEq(IERC20Fork(USDC).balanceOf(address(vault)), 0, "USDC should have left vault");
        assertEq(IERC20Fork(USDC).balanceOf(GMX_DEPOSIT_VAULT), balanceBefore + usdcAmount, "USDC in GMX DepositVault");
    }

    function test_Fork_GMX_FullDeposit() public {
        uint256 usdcAmount = 1_000e6;
        uint256 execFee = 1e15;
        _depositToVault(USDC, usdcAmount);
        deal(AGENT, 1 ether);

        bytes[] memory tokenCalls = new bytes[](2);
        tokenCalls[0] = abi.encodeWithSignature("sendWnt(address,uint256)", GMX_DEPOSIT_VAULT, execFee);
        tokenCalls[1] =
            abi.encodeWithSignature("sendTokens(address,address,uint256)", USDC, GMX_DEPOSIT_VAULT, usdcAmount);
        bytes memory tokenFlowData = abi.encodeWithSignature("multicall(bytes[])", tokenCalls);

        uint256 depositVaultBefore = IERC20Fork(USDC).balanceOf(GMX_DEPOSIT_VAULT);

        vm.startPrank(AGENT);
        vault.approveToken(USDC, GMX_ROUTER, usdcAmount);
        vault.executeDeposit{value: execFee}(
            USER, USDC, usdcAmount, 0, GMX_EXCHANGE_ROUTER, tokenFlowData, keccak256("gmx-tokens-new")
        );
        vm.stopPrank();

        assertEq(IERC20Fork(USDC).balanceOf(address(vault)), 0, "USDC left vault");
        assertEq(IERC20Fork(USDC).balanceOf(GMX_DEPOSIT_VAULT), depositVaultBefore + usdcAmount, "USDC in DepositVault");

        GMXCalldataBuilder gmxBuilder = new GMXCalldataBuilder();
        bytes memory fullMulticall = gmxBuilder.buildDepositMulticall(
            GMX_DEPOSIT_VAULT, USDC, usdcAmount, GMX_ETH_USD_MARKET, address(vault), execFee
        );

        assertGt(fullMulticall.length, 0, "Multicall data built correctly");
    }

    function test_Fork_Pendle_AddRemoveLiquidity() public {
        uint256 tokenAmount = 500e18;
        uint256 ptAmount = 400e18;
        _depositToVault(USDAI, tokenAmount);
        _depositToVault(PENDLE_PT, ptAmount);

        PendleCalldataBuilder builder = new PendleCalldataBuilder();

        bytes memory addData = builder.buildAddLiquidity(address(vault), PENDLE_MARKET, USDAI, tokenAmount, ptAmount);
        vm.startPrank(AGENT);
        vault.approveToken(USDAI, PENDLE_ROUTER, tokenAmount);
        vault.approveToken(PENDLE_PT, PENDLE_ROUTER, ptAmount);
        address[] memory addAssets = new address[](2);
        addAssets[0] = USDAI;
        addAssets[1] = PENDLE_PT;
        address[] memory addTargets = new address[](1);
        addTargets[0] = PENDLE_ROUTER;
        bytes[] memory addDataArr = new bytes[](1);
        addDataArr[0] = addData;
        vault.executeBatchMulti(USER, addAssets, addTargets, addDataArr, keccak256("pendle-lp-add"));
        vm.stopPrank();

        address lpToken = PENDLE_SY;

        assertLt(IERC20Fork(USDAI).balanceOf(address(vault)), tokenAmount, "USDai should have entered LP");
        assertLt(IERC20Fork(PENDLE_PT).balanceOf(address(vault)), ptAmount, "PT should have entered LP");

        uint256 lpBalance = IERC20Fork(PENDLE_MARKET).balanceOf(address(vault));
        assertGt(lpBalance, 0, "No LP tokens received");

        bytes memory removeData = builder.buildRemoveLiquidity(address(vault), PENDLE_MARKET, USDAI, lpBalance);
        vm.startPrank(AGENT);
        vault.approveToken(PENDLE_MARKET, PENDLE_ROUTER, lpBalance);
        address[] memory returnAssets = new address[](2);
        returnAssets[0] = USDAI;
        returnAssets[1] = PENDLE_PT;
        uint256[] memory deployedAmounts = new uint256[](2);
        deployedAmounts[0] = vault.deployed(USER, USDAI);
        deployedAmounts[1] = vault.deployed(USER, PENDLE_PT);
        vault.executeWithdrawMulti(
            USER, returnAssets, deployedAmounts, PENDLE_ROUTER, removeData, keccak256("pendle-lp-remove")
        );
        vm.stopPrank();

        assertGt(IERC20Fork(USDAI).balanceOf(address(vault)), 0, "No USDai returned");
        assertGt(IERC20Fork(PENDLE_PT).balanceOf(address(vault)), 0, "No PT returned");
    }

    function test_Fork_Pendle_YT_BuyAndRedeem() public {
        uint256 amount = 1_000e18;
        _depositToVault(USDAI, amount * 2);

        PendleCalldataBuilder builder = new PendleCalldataBuilder();

        bytes memory ytData = builder.buildSwapForYt(address(vault), PENDLE_MARKET, (amount * 90) / 100, USDAI, amount);
        vm.startPrank(AGENT);
        vault.approveToken(USDAI, PENDLE_ROUTER, amount);
        vault.executeDeposit(USER, USDAI, amount, 0, PENDLE_ROUTER, ytData, keccak256("pendle-yt-buy"));
        vm.stopPrank();

        uint256 ytBalance = IERC20Fork(PENDLE_YT).balanceOf(address(vault));
        assertGt(ytBalance, 0, "No YT tokens received");

        uint256 ptAmount = ytBalance;
        deal(PENDLE_PT, address(vault), ptAmount);

        vm.warp(PENDLE_EXPIRY + 1);

        bytes memory redeemData = builder.buildRedeemPyToToken(address(vault), PENDLE_YT, ptAmount, USDAI);
        vm.startPrank(AGENT);
        vault.approveToken(PENDLE_PT, PENDLE_ROUTER, ptAmount);
        vault.approveToken(PENDLE_YT, PENDLE_ROUTER, ytBalance);
        vault.executeWithdraw(
            USER, USDAI, vault.deployed(USER, USDAI), PENDLE_ROUTER, redeemData, keccak256("pendle-yt-redeem")
        );
        vm.stopPrank();

        assertGt(IERC20Fork(USDAI).balanceOf(address(vault)), 0, "No USDai returned on redeem");
    }

    function test_Fork_Pendle_PT_PreMaturityExit() public {
        uint256 amount = 1_000e18;
        _depositToVault(USDAI, amount);

        PendleCalldataBuilder builder = new PendleCalldataBuilder();

        bytes memory buyData = builder.buildSwapForPt(address(vault), PENDLE_MARKET, (amount * 90) / 100, USDAI, amount);
        vm.startPrank(AGENT);
        vault.approveToken(USDAI, PENDLE_ROUTER, amount);
        vault.executeDeposit(USER, USDAI, amount, 0, PENDLE_ROUTER, buyData, keccak256("pt-buy"));
        vm.stopPrank();

        uint256 ptBalance = IERC20Fork(PENDLE_PT).balanceOf(address(vault));
        assertGt(ptBalance, 0, "No PT received");

        bytes memory sellData = builder.buildSwapPtForToken(address(vault), PENDLE_MARKET, USDAI, ptBalance);
        vm.startPrank(AGENT);
        vault.approveToken(PENDLE_PT, PENDLE_ROUTER, ptBalance);
        vault.executeWithdraw(
            USER, USDAI, vault.deployed(USER, USDAI), PENDLE_ROUTER, sellData, keccak256("pt-sell-premat")
        );
        vm.stopPrank();

        uint256 usdaiBack = IERC20Fork(USDAI).balanceOf(address(vault));
        assertGt(usdaiBack, 0, "No USDai returned pre-maturity");
        assertLt(usdaiBack, amount, "Got more than deposited - impossible");
        assertGt(usdaiBack, amount * 80 / 100, "Discount > 20% - price impact too high");
        assertEq(IERC20Fork(PENDLE_PT).balanceOf(address(vault)), 0, "PT not fully sold");
    }

    function test_Fork_Pendle_YT_PreMaturityExit() public {
        uint256 amount = 500e18;
        _depositToVault(USDAI, amount);

        PendleCalldataBuilder builder = new PendleCalldataBuilder();

        bytes memory buyData = builder.buildSwapForYt(address(vault), PENDLE_MARKET, (amount * 80) / 100, USDAI, amount);
        vm.startPrank(AGENT);
        vault.approveToken(USDAI, PENDLE_ROUTER, amount);
        vault.executeDeposit(USER, USDAI, amount, 0, PENDLE_ROUTER, buyData, keccak256("yt-buy"));
        vm.stopPrank();

        uint256 ytBalance = IERC20Fork(PENDLE_YT).balanceOf(address(vault));
        assertGt(ytBalance, 0, "No YT received");

        bytes memory sellData = builder.buildSwapYtForToken(address(vault), PENDLE_MARKET, USDAI, ytBalance);
        vm.startPrank(AGENT);
        vault.approveToken(PENDLE_YT, PENDLE_ROUTER, ytBalance);
        vault.executeWithdraw(
            USER, USDAI, vault.deployed(USER, USDAI), PENDLE_ROUTER, sellData, keccak256("yt-sell-premat")
        );
        vm.stopPrank();

        uint256 usdaiBack = IERC20Fork(USDAI).balanceOf(address(vault));
        assertGt(usdaiBack, 0, "No USDai returned from YT pre-maturity sell");
        assertEq(IERC20Fork(PENDLE_YT).balanceOf(address(vault)), 0, "YT not fully sold");
    }

    function test_Fork_Pendle_PT_RedeemAtMaturity() public {
        uint256 amount = 1_000e18;
        _depositToVault(USDAI, amount);
        PendleCalldataBuilder builder = new PendleCalldataBuilder();
        bytes memory buyData = builder.buildSwapForPt(address(vault), PENDLE_MARKET, (amount * 90) / 100, USDAI, amount);
        vm.startPrank(AGENT);
        vault.approveToken(USDAI, PENDLE_ROUTER, amount);
        vault.executeDeposit(USER, USDAI, amount, 0, PENDLE_ROUTER, buyData, keccak256("pt-buy-maturity"));
        vm.stopPrank();

        uint256 ptBalance = IERC20Fork(PENDLE_PT).balanceOf(address(vault));
        assertGt(ptBalance, 0, "No PT received");

        deal(PENDLE_YT, address(vault), amount);

        vm.warp(PENDLE_EXPIRY + 1);

        bytes memory redeemData = builder.buildRedeemPyToToken(address(vault), PENDLE_YT, ptBalance, USDAI);

        vm.startPrank(AGENT);
        vault.approveToken(PENDLE_PT, PENDLE_ROUTER, ptBalance);
        vault.approveToken(PENDLE_YT, PENDLE_ROUTER, amount);
        vault.executeWithdraw(
            USER, USDAI, vault.deployed(USER, USDAI), PENDLE_ROUTER, redeemData, keccak256("pendle-pt-redeem")
        );
        vm.stopPrank();

        assertGt(IERC20Fork(USDAI).balanceOf(address(vault)), 0, "No USDai returned");
        assertEq(IERC20Fork(PENDLE_PT).balanceOf(address(vault)), 0, "PT not fully burned");
    }

    function test_Fork_UniV3_FullCycle() public {
        (, int24 currentTick,,,,,) = IUniV3Pool(UNI_USDC_WETH_POOL).slot0();
        int24 tickSpacing = 60;
        int24 currentFloor = currentTick >= 0
            ? (currentTick / tickSpacing) * tickSpacing
            : ((currentTick - tickSpacing + 1) / tickSpacing) * tickSpacing;
        int24 tickLower = currentFloor - tickSpacing * 5;
        int24 tickUpper = currentFloor + tickSpacing * 5;

        uint256 wethAmount = 0.1 ether;
        uint256 usdceAmount = 300e6;
        _depositToVault(WETH, wethAmount);
        _depositToVault(USDCE, usdceAmount);

        bytes memory mintData = abi.encodeWithSelector(
            bytes4(
                keccak256("mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))")
            ),
            WETH,
            USDCE,
            uint24(3000),
            tickLower,
            tickUpper,
            wethAmount,
            usdceAmount,
            uint256(0),
            uint256(0),
            address(vault),
            block.timestamp + 600
        );

        vm.startPrank(AGENT);
        vault.approveToken(WETH, UNI_V3_POSITION_MGR, wethAmount);
        vault.approveToken(USDCE, UNI_V3_POSITION_MGR, usdceAmount);
        address[] memory mintAssets = new address[](2);
        mintAssets[0] = WETH;
        mintAssets[1] = USDCE;
        address[] memory mintTargets = new address[](1);
        mintTargets[0] = UNI_V3_POSITION_MGR;
        bytes[] memory mintDataArr = new bytes[](1);
        mintDataArr[0] = mintData;
        vault.executeBatchMulti(USER, mintAssets, mintTargets, mintDataArr, keccak256("univ3-mint"));
        vm.stopPrank();

        uint256 nftBalance = IUniV3PositionMgr(UNI_V3_POSITION_MGR).balanceOf(address(vault));
        assertEq(nftBalance, 1, "Should have 1 UniV3 NFT");

        uint256 tokenId = _getUniV3TokenId(address(vault));

        bytes memory collectData = abi.encodeWithSelector(
            bytes4(keccak256("collect((uint256,address,uint128,uint128))")),
            tokenId,
            address(vault),
            type(uint128).max,
            type(uint128).max
        );
        vm.prank(AGENT);
        vault.execute(USER, UNI_V3_POSITION_MGR, collectData, keccak256("univ3-collect"), WETH);

        (,,,,,,, uint128 liquidity,,,,) = _getUniV3Position(tokenId);
        assertGt(liquidity, 0, "Position has no liquidity");

        bytes memory decreaseData = abi.encodeWithSelector(
            bytes4(keccak256("decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))")),
            tokenId,
            liquidity,
            uint256(0),
            uint256(0),
            block.timestamp + 600
        );
        vm.prank(AGENT);
        vault.execute(USER, UNI_V3_POSITION_MGR, decreaseData, keccak256("univ3-decrease"), WETH);

        address[] memory returnAssets = new address[](2);
        returnAssets[0] = WETH;
        returnAssets[1] = USDCE;
        uint256[] memory deployedAmounts = new uint256[](2);
        deployedAmounts[0] = vault.deployed(USER, WETH);
        deployedAmounts[1] = vault.deployed(USER, USDCE);
        vm.prank(AGENT);
        vault.executeWithdrawMulti(
            USER, returnAssets, deployedAmounts, UNI_V3_POSITION_MGR, collectData, keccak256("univ3-collect-final")
        );

        uint256 wethBack = IERC20Fork(WETH).balanceOf(address(vault));
        uint256 usdceBack = IERC20Fork(USDCE).balanceOf(address(vault));
        assertGt(wethBack + usdceBack, 0, "No tokens returned on position close");
    }

    function test_Fork_LeveragedLoop_FullCycle() public {
        _depositToVault(USDC, 1_000e6);

        address[] memory targets = new address[](7);
        bytes[] memory data = new bytes[](7);
        uint256 amount = 1_000e6;
        uint256 ltv = 70;

        targets[0] = AAVE_POOL;
        data[0] = abi.encodeWithSignature("supply(address,uint256,address,uint16)", USDC, amount, address(vault), 0);

        uint256 available = amount;
        for (uint256 i = 0; i < 3; i++) {
            uint256 borrow = (available * ltv) / 100;
            targets[1 + i * 2] = AAVE_POOL;
            data[1 + i * 2] = abi.encodeWithSignature(
                "borrow(address,uint256,uint256,uint16,address)", USDC, borrow, 2, 0, address(vault)
            );
            targets[2 + i * 2] = AAVE_POOL;
            data[2 + i * 2] =
                abi.encodeWithSignature("supply(address,uint256,address,uint16)", USDC, borrow, address(vault), 0);
            available = borrow;
        }

        vm.startPrank(AGENT);
        vault.approveToken(USDC, AAVE_POOL, amount * 4);
        vault.executeBatch(USER, USDC, targets, data, keccak256("loop-open"));
        vm.stopPrank();

        (, uint256 totalDebt,,,, uint256 healthFactor) = IAavePool(AAVE_POOL).getUserAccountData(address(vault));
        assertGt(totalDebt, 0, "No debt created");
        assertGt(healthFactor, 1e18, "Health factor below 1");

        uint256 repayAmount = (totalDebt / 1e2) + 10e6;
        _depositToVault(USDC, repayAmount);

        vm.startPrank(AGENT);
        vault.approveToken(USDC, AAVE_POOL, type(uint256).max);
        address[] memory unwindTargets = new address[](2);
        bytes[] memory unwindData = new bytes[](2);
        unwindTargets[0] = AAVE_POOL;
        unwindData[0] = abi.encodeWithSignature(
            "repay(address,uint256,uint256,address)", USDC, type(uint256).max, 2, address(vault)
        );
        unwindTargets[1] = AAVE_POOL;
        unwindData[1] =
            abi.encodeWithSignature("withdraw(address,uint256,address)", USDC, type(uint256).max, address(vault));
        vault.executeBatch(USER, USDC, unwindTargets, unwindData, keccak256("loop-unwind"));
        vm.stopPrank();

        (, uint256 debtAfter,,,,) = IAavePool(AAVE_POOL).getUserAccountData(address(vault));
        assertEq(debtAfter, 0, "Debt not fully repaid");
        assertGt(IERC20Fork(USDC).balanceOf(address(vault)), 0, "No USDC recovered");
    }

    function test_Fork_ExecuteWithValue_ForwardsETH() public {
        deal(AGENT, 0.01 ether);
        MockPayable mockTarget = new MockPayable();

        vm.prank(OWNER);
        vault.approveTarget(block.chainid, address(mockTarget));

        vm.prank(AGENT);
        vault.execute{value: 0.001 ether}(
            USER, address(mockTarget), abi.encodeWithSignature("receiveETH()"), keccak256("eth-forward"), USDC
        );

        assertEq(address(mockTarget).balance, 0.001 ether, "ETH not forwarded");
    }

    function _mintWethUsdcePosition()
        internal
        returns (uint256 tokenId, uint128 liquidity, uint256 wethUsed, uint256 usdceUsed)
    {
        (, int24 currentTick,,,,,) = IUniV3Pool(UNI_USDC_WETH_POOL).slot0();
        int24 tickSpacing = 60;
        int24 currentFloor = currentTick >= 0
            ? (currentTick / tickSpacing) * tickSpacing
            : ((currentTick - tickSpacing + 1) / tickSpacing) * tickSpacing;
        int24 tickLower = currentFloor - tickSpacing * 5;
        int24 tickUpper = currentFloor + tickSpacing * 5;

        uint256 wethAmt = 0.05 ether;
        uint256 usdceAmt = 150e6;
        _depositToVault(WETH, wethAmt);
        _depositToVault(USDCE, usdceAmt);

        bytes memory mintData = abi.encodeWithSelector(
            bytes4(
                keccak256("mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))")
            ),
            WETH,
            USDCE,
            uint24(3000),
            tickLower,
            tickUpper,
            wethAmt,
            usdceAmt,
            uint256(0),
            uint256(0),
            address(vault),
            block.timestamp + 600
        );

        vm.startPrank(AGENT);
        vault.approveToken(WETH, UNI_V3_POSITION_MGR, wethAmt);
        vault.approveToken(USDCE, UNI_V3_POSITION_MGR, usdceAmt);
        address[] memory assets = new address[](2);
        assets[0] = WETH;
        assets[1] = USDCE;
        address[] memory targets = new address[](1);
        targets[0] = UNI_V3_POSITION_MGR;
        bytes[] memory data = new bytes[](1);
        data[0] = mintData;
        vault.executeBatchMulti(USER, assets, targets, data, keccak256("mint"));
        vm.stopPrank();

        tokenId = _getUniV3TokenId(address(vault));
        (,,,,,,, liquidity,,,,) = _getUniV3Position(tokenId);
        assertGt(liquidity, 0, "Mint produced no liquidity");

        wethUsed = wethAmt - vault.balances(USER, WETH);
        usdceUsed = usdceAmt - vault.balances(USER, USDCE);
    }

    function _buildCloseMulticall(uint256 tokenId, uint128 liquidity)
        internal
        view
        returns (bytes memory multicallData)
    {
        bytes memory decreaseData = abi.encodeWithSelector(
            bytes4(keccak256("decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))")),
            tokenId,
            liquidity,
            uint256(0),
            uint256(0),
            block.timestamp + 600
        );
        bytes memory collectData = abi.encodeWithSelector(
            bytes4(keccak256("collect((uint256,address,uint128,uint128))")),
            tokenId,
            address(vault),
            type(uint128).max,
            type(uint128).max
        );
        bytes[] memory inner = new bytes[](2);
        inner[0] = decreaseData;
        inner[1] = collectData;
        multicallData = abi.encodeWithSignature("multicall(bytes[])", inner);
    }

    function test_Fork_DeltaNeutral_CloseWithZeroDeployed() public {
        (uint256 tokenId, uint128 liquidity,,) = _mintWethUsdcePosition();

        bytes memory mcData = _buildCloseMulticall(tokenId, liquidity);

        address[] memory assets = new address[](2);
        assets[0] = WETH;
        assets[1] = USDCE;
        uint256[] memory deployedAmts = new uint256[](2);

        deployedAmts[0] = 0;
        deployedAmts[1] = 0;

        uint256 wethBefore = vault.balances(USER, WETH);
        uint256 usdceBefore = vault.balances(USER, USDCE);

        vm.prank(AGENT);
        vault.executeWithdrawMulti(USER, assets, deployedAmts, UNI_V3_POSITION_MGR, mcData, keccak256("close-zero"));

        uint256 wethAfter = vault.balances(USER, WETH);
        uint256 usdceAfter = vault.balances(USER, USDCE);
        assertGt(wethAfter + usdceAfter, wethBefore + usdceBefore, "No tokens credited after close");

        (,,,,,,, uint128 liqAfter,,,,) = _getUniV3Position(tokenId);
        assertEq(liqAfter, 0, "Liquidity should be 0 after close");
    }

    function test_Fork_DeltaNeutral_CloseWhilePaused() public {
        (uint256 tokenId, uint128 liquidity,,) = _mintWethUsdcePosition();

        vm.startPrank(AGENT);
        vault.reportValue(USER, 1_000e6);
        vault.reportValue(USER, 1);
        vm.stopPrank();

        assertTrue(vault.userPaused(USER), "User should be paused after drawdown");

        bytes memory mcData = _buildCloseMulticall(tokenId, liquidity);
        address[] memory assets = new address[](2);
        assets[0] = WETH;
        assets[1] = USDCE;
        uint256[] memory deployedAmts = new uint256[](2);
        deployedAmts[0] = 0;
        deployedAmts[1] = 0;

        vm.prank(AGENT);
        vault.executeWithdrawMulti(USER, assets, deployedAmts, UNI_V3_POSITION_MGR, mcData, keccak256("close-paused"));

        uint256 wethAfter = vault.balances(USER, WETH);
        uint256 usdceAfter = vault.balances(USER, USDCE);
        assertGt(wethAfter + usdceAfter, 0, "Tokens not returned while user paused");
    }

    function test_Fork_DeltaNeutral_RebalanceCycle() public {
        (uint256 tokenId, uint128 liquidity,,) = _mintWethUsdcePosition();

        bytes memory mcData = _buildCloseMulticall(tokenId, liquidity);
        address[] memory assets = new address[](2);
        assets[0] = WETH;
        assets[1] = USDCE;
        uint256[] memory deployedAmts = new uint256[](2);

        vm.prank(AGENT);
        vault.executeWithdrawMulti(USER, assets, deployedAmts, UNI_V3_POSITION_MGR, mcData, keccak256("rebal-close"));

        uint256 wethIdle = vault.balances(USER, WETH);
        uint256 usdceIdle = vault.balances(USER, USDCE);
        assertGt(wethIdle + usdceIdle, 0, "No idle balance after close");

        (, int24 currentTick,,,,,) = IUniV3Pool(UNI_USDC_WETH_POOL).slot0();
        int24 tickSpacing = 60;
        int24 currentFloor = currentTick >= 0
            ? (currentTick / tickSpacing) * tickSpacing
            : ((currentTick - tickSpacing + 1) / tickSpacing) * tickSpacing;
        int24 newTickLower = currentFloor - tickSpacing * 10;
        int24 newTickUpper = currentFloor + tickSpacing * 10;

        bytes memory remintData = abi.encodeWithSelector(
            bytes4(
                keccak256("mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))")
            ),
            WETH,
            USDCE,
            uint24(3000),
            newTickLower,
            newTickUpper,
            wethIdle,
            usdceIdle,
            uint256(0),
            uint256(0),
            address(vault),
            block.timestamp + 600
        );

        vm.startPrank(AGENT);
        vault.approveToken(WETH, UNI_V3_POSITION_MGR, wethIdle);
        vault.approveToken(USDCE, UNI_V3_POSITION_MGR, usdceIdle);
        address[] memory remintTargets = new address[](1);
        remintTargets[0] = UNI_V3_POSITION_MGR;
        bytes[] memory remintData_ = new bytes[](1);
        remintData_[0] = remintData;
        vault.executeBatchMulti(USER, assets, remintTargets, remintData_, keccak256("rebal-remint"));
        vm.stopPrank();

        uint256 nftCount = IUniV3PositionMgr(UNI_V3_POSITION_MGR).balanceOf(address(vault));
        assertEq(nftCount, 2, "Should have 2 NFTs after rebalance (old empty + new)");

        (bool ok2, bytes memory ret2) = UNI_V3_POSITION_MGR.staticcall(
            abi.encodeWithSignature("tokenOfOwnerByIndex(address,uint256)", address(vault), 1)
        );
        require(ok2, "tokenOfOwnerByIndex(1) failed");
        uint256 newTokenId = abi.decode(ret2, (uint256));

        assertFalse(newTokenId == tokenId, "Should have a new tokenId after rebalance");
        (,,,,,,, uint128 newLiquidity,,,,) = _getUniV3Position(newTokenId);
        assertGt(newLiquidity, 0, "New position has no liquidity after remint");
    }

    function _depositToVault(address token, uint256 amount) internal {
        deal(token, USER, amount);
        vm.startPrank(USER);
        IERC20Fork(token).approve(address(vault), amount);
        vault.deposit(token, amount);
        vm.stopPrank();
    }

    function _getUniV3TokenId(address owner) internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            UNI_V3_POSITION_MGR.staticcall(abi.encodeWithSignature("tokenOfOwnerByIndex(address,uint256)", owner, 0));
        require(ok, "tokenOfOwnerByIndex failed");
        return abi.decode(ret, (uint256));
    }

    function _getUniV3Position(uint256 tokenId)
        internal
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0,
            uint256 feeGrowthInside1,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        (bool ok, bytes memory ret) = UNI_V3_POSITION_MGR.staticcall(
            abi.encodeWithSignature("positions(uint256)", tokenId)
        );
        require(ok, "positions() failed");
        return abi.decode(
            ret, (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)
        );
    }
}

contract MockPayable {
    function receiveETH() external payable {}
}

interface IPendleRouter {
    struct ApproxParams {
        uint256 guessMin;
        uint256 guessMax;
        uint256 guessOffchain;
        uint256 maxIteration;
        uint256 eps;
    }

    struct SwapData {
        uint8 swapType;
        address extRouter;
        bytes extCalldata;
        bool needScale;
    }

    struct TokenInput {
        address tokenIn;
        uint256 netTokenIn;
        address tokenMintSy;
        address pendleSwap;
        SwapData swapData;
    }

    struct Order {
        uint256 salt;
        uint256 expiry;
        uint256 nonce;
        uint8 orderType;
        address token;
        address YT;
        address maker;
        address receiver;
        uint256 makingAmount;
        uint256 lnImpliedRate;
        uint256 failSafeRate;
        bytes permit;
    }

    struct FillOrderParams {
        Order order;
        bytes signature;
        uint256 makingAmount;
    }

    struct LimitOrderData {
        address limitRouter;
        uint256 epsSkipMarket;
        FillOrderParams[] normalFills;
        FillOrderParams[] flashFills;
        bytes optData;
    }

    struct TokenOutput {
        address tokenOut;
        uint256 minTokenOut;
        address tokenRedeemSy;
        address pendleSwap;
        SwapData swapData;
    }
    function swapExactTokenForPt(
        address receiver,
        address market,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) external payable returns (uint256, uint256, uint256);
    function swapExactTokenForYt(
        address receiver,
        address market,
        uint256 minYtOut,
        ApproxParams calldata guessYtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) external payable returns (uint256, uint256, uint256);
    function addLiquidityDualTokenAndPt(
        address receiver,
        address market,
        TokenInput calldata input,
        uint256 netPtIn,
        uint256 minLpOut
    ) external returns (uint256 netLpOut, uint256 netSyFee, uint256 netSyInterm);
    function removeLiquidityDualTokenAndPt(
        address receiver,
        address market,
        uint256 netLpIn,
        TokenOutput calldata output,
        uint256 minPtOut
    ) external returns (uint256 netTokenOut, uint256 netPtOut, uint256 netSyFee, uint256 netSyInterm);
    function redeemPyToToken(address receiver, address yt, uint256 netPyIn, TokenOutput calldata output)
        external
        returns (uint256 netTokenOut, uint256 netSyFee);
    function swapExactPtForToken(
        address receiver,
        address market,
        uint256 exactPtIn,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    ) external returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm);
    function swapExactYtForToken(
        address receiver,
        address market,
        uint256 exactYtIn,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    ) external returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm);
}

interface IGMXExchangeRouter {
    struct CreateDepositParamsAddresses {
        address receiver;
        address callbackContract;
        address uiFeeReceiver;
        address market;
        address initialLongToken;
        address initialShortToken;
        address[] longTokenSwapPath;
        address[] shortTokenSwapPath;
    }

    struct CreateDepositParams {
        CreateDepositParamsAddresses addresses;
        uint256 minMarketTokens;
        bool shouldUnwrapNativeToken;
        uint256 executionFee;
        uint256 callbackGasLimit;
        bytes32[] dataList;
    }
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory);
    function sendWnt(address receiver, uint256 amount) external payable;
    function sendTokens(address token, address receiver, uint256 amount) external payable;
    function createDeposit(CreateDepositParams calldata params) external payable returns (bytes32);
}

contract GMXCalldataBuilder {
    function buildDepositMulticall(
        address depositVault,
        address token,
        uint256 amount,
        address market,
        address receiver,
        uint256 execFee
    ) external pure returns (bytes memory) {
        bytes memory sendWntData = abi.encodeCall(IGMXExchangeRouter.sendWnt, (depositVault, execFee));
        bytes memory sendTokensData = abi.encodeCall(IGMXExchangeRouter.sendTokens, (token, depositVault, amount));

        IGMXExchangeRouter.CreateDepositParams memory params = IGMXExchangeRouter.CreateDepositParams({
            addresses: IGMXExchangeRouter.CreateDepositParamsAddresses({
                receiver: receiver,
                callbackContract: address(0),
                uiFeeReceiver: address(0),
                market: market,
                initialLongToken: address(0),
                initialShortToken: token,
                longTokenSwapPath: new address[](0),
                shortTokenSwapPath: new address[](0)
            }),
            minMarketTokens: 0,
            shouldUnwrapNativeToken: false,
            executionFee: execFee,
            callbackGasLimit: 0,
            dataList: new bytes32[](0)
        });
        bytes memory createDepositData = abi.encodeCall(IGMXExchangeRouter.createDeposit, (params));

        bytes[] memory calls = new bytes[](3);
        calls[0] = sendWntData;
        calls[1] = sendTokensData;
        calls[2] = createDepositData;
        return abi.encodeCall(IGMXExchangeRouter.multicall, (calls));
    }
}

contract PendleCalldataBuilder {
    function _approx() internal pure returns (IPendleRouter.ApproxParams memory) {
        return IPendleRouter.ApproxParams({
            guessMin: 0, guessMax: type(uint256).max, guessOffchain: 0, maxIteration: 256, eps: 1e14
        });
    }

    function _input(address tokenIn, uint256 amount) internal pure returns (IPendleRouter.TokenInput memory) {
        return IPendleRouter.TokenInput({
            tokenIn: tokenIn,
            netTokenIn: amount,
            tokenMintSy: tokenIn,
            pendleSwap: address(0),
            swapData: IPendleRouter.SwapData({swapType: 0, extRouter: address(0), extCalldata: "", needScale: false})
        });
    }

    function _output(address tokenOut) internal pure returns (IPendleRouter.TokenOutput memory) {
        return IPendleRouter.TokenOutput({
            tokenOut: tokenOut,
            minTokenOut: 0,
            tokenRedeemSy: tokenOut,
            pendleSwap: address(0),
            swapData: IPendleRouter.SwapData({swapType: 0, extRouter: address(0), extCalldata: "", needScale: false})
        });
    }

    function _limit() internal pure returns (IPendleRouter.LimitOrderData memory) {
        return IPendleRouter.LimitOrderData({
            limitRouter: address(0),
            epsSkipMarket: 0,
            normalFills: new IPendleRouter.FillOrderParams[](0),
            flashFills: new IPendleRouter.FillOrderParams[](0),
            optData: ""
        });
    }

    function buildSwapForPt(address receiver, address market, uint256 minPtOut, address tokenIn, uint256 amount)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(
            IPendleRouter.swapExactTokenForPt,
            (receiver, market, minPtOut, _approx(), _input(tokenIn, amount), _limit())
        );
    }

    function buildSwapForYt(address receiver, address market, uint256 minYtOut, address tokenIn, uint256 amount)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(
            IPendleRouter.swapExactTokenForYt,
            (receiver, market, minYtOut, _approx(), _input(tokenIn, amount), _limit())
        );
    }

    function buildAddLiquidity(address receiver, address market, address tokenIn, uint256 tokenAmount, uint256 netPtIn)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(
            IPendleRouter.addLiquidityDualTokenAndPt, (receiver, market, _input(tokenIn, tokenAmount), netPtIn, 0)
        );
    }

    function buildRemoveLiquidity(address receiver, address market, address tokenOut, uint256 lpAmount)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(
            IPendleRouter.removeLiquidityDualTokenAndPt, (receiver, market, lpAmount, _output(tokenOut), 0)
        );
    }

    function buildRedeemPyToToken(address receiver, address yt, uint256 netPyIn, address tokenOut)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(IPendleRouter.redeemPyToToken, (receiver, yt, netPyIn, _output(tokenOut)));
    }

    function buildSwapPtForToken(address receiver, address market, address tokenOut, uint256 exactPtIn)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(
            IPendleRouter.swapExactPtForToken, (receiver, market, exactPtIn, _output(tokenOut), _limit())
        );
    }

    function buildSwapYtForToken(address receiver, address market, address tokenOut, uint256 exactYtIn)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(
            IPendleRouter.swapExactYtForToken, (receiver, market, exactYtIn, _output(tokenOut), _limit())
        );
    }
}
