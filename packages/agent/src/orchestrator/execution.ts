import { ethers } from 'ethers';
import * as crypto from 'node:crypto';
import type { StrategyType } from './types';
import { initPimlicoIfConfigured, type PimlicoLayer } from './erc4337';
import { resolveSwapRoute, quoteSwapFromUSDC, quoteSwapToUSDC, reverseUniswapPath, type SwapRoute } from './protocols/swapRouter';
import {
  DelegationClient,
  depositArgs, withdrawArgs, rebalanceArgs,
  type StoredDelegation,
} from './delegation-client';

const VAULT_ABI = [
  
  'function executeDeposit(address user, address asset, uint256 amount, uint256 assertedAPY, address target, bytes calldata data, bytes32 receiptHash) external payable',
  'function executeWithdraw(address user, address asset, uint256 deployedAmount, address target, bytes calldata data, bytes32 receiptHash) external payable',
  'function executeWithdrawMulti(address user, address[] calldata assets, uint256[] calldata deployedAmounts, address target, bytes calldata data, bytes32 receiptHash) external payable returns (uint256[] memory)',
  'function executeBatch(address user, address asset, address[] calldata targets, bytes[] calldata dataArr, bytes32 receiptHash) external returns (bytes[] memory)',
  'function executeBatchMulti(address user, address[] calldata assets, address[] calldata targets, bytes[] calldata dataArr, bytes32 receiptHash) external returns (bytes[] memory)',
  
  
  'function execute(address user, address target, bytes calldata data, bytes32 receiptHash, address guardAsset) external payable returns (bytes memory)',
  
  'function executeHarvest(address user, address yieldAsset, address[] calldata targets, bytes[] calldata dataArr, bytes32 receiptHash) external',
  
  'function approveToken(address asset, address spender, uint256 amount) external',
  'function collectFee(address asset, address user, uint256 grossAmount) external returns (uint256)',
  'function reportValue(address user, uint256 currentValueUSD) external',
  'function vaultSetup(address target, bytes calldata data) external',
  'function balances(address user, address asset) external view returns (uint256)',
  'function deployed(address user, address asset) external view returns (uint256)',
  'function registerPolicy(tuple(address user,uint256 managedUSD,uint256 minAPY,uint256 maxDrawdownBps,uint256 maxFeeBps,uint256 nonce,uint256 deadline) _p, bytes _sig) external',
  'function nonces(address user) external view returns (uint256)',
];

const ROUTER_ABI = [
  'function recordExecution(address user, bytes32 receiptHash, uint256 chainId, string calldata action, uint256 amountUSD) external',
];

const AAVE_POOL_READ_ABI = [
  'function getReserveNormalizedIncome(address asset) view returns (uint256)',
];

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const ZERO_ADDRESS = ethers.zeroPadValue('0x0000000000000000000000000000000000000000', 32);

function parseMintedAmount(
  receipt: ethers.TransactionReceipt,
  tokenAddress: string,
  toAddress: string,
): bigint {
  const toTopic = ethers.zeroPadValue(toAddress.toLowerCase(), 32);
  let total = 0n;
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === tokenAddress.toLowerCase() &&
      log.topics[0] === TRANSFER_TOPIC &&
      log.topics[1] === ZERO_ADDRESS &&
      log.topics[2]?.toLowerCase() === toTopic.toLowerCase()
    ) {
      total += ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], log.data)[0] as bigint;
    }
  }
  return total;
}

export const ADDRESSES = {
  
  AAVE_POOL: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  
  PENDLE_ROUTER: '0x888888888889758F76e7103c6CbF23ABbF58F946',
  
  GMX_EXCHANGE_ROUTER: '0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41',
  GMX_ROUTER: '0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6',
  GMX_ORDER_VAULT: '0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5',
  GMX_DEPOSIT_VAULT: '0xF89e77e8Dc11691C9e8757e84aaFbCD8A67d7A55',
  GMX_WITHDRAWAL_VAULT: '0x0628D46b5D145f183AdB6Ef1f2c97eD1C4701C55',
  
  UNI_V3_POSITION_MGR: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  UNI_V3_FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  
  SWAP_ROUTER02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  
  USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
  USDC_E: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
  WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
  ARB: '0x912CE59144191C1204E64559FE8253a0e49E6548',

  
  DELEGATION_MANAGER: '0xdb9b1e94b5b69df7e401ddbede43491141047db3',
  POLICY_ENFORCER: '0x21b25E099CA7AF1BEa3a4558E437C56680B4b925',
  SWAPPER: '0xC6962004f452bE9203591991D15f6b388e09E8D0',
};

const DM_IFACE = new ethers.Interface([
  'function redeemDelegations(bytes[] calldata permissionContexts, bytes32[] calldata modes, bytes[] calldata executionCalldatas) external',
]);

const VAULT_IFACE = new ethers.Interface(VAULT_ABI);

function debugUniV3(message: string, detail?: Record<string, unknown>): void {
  const serialised = detail
    ? JSON.stringify(detail, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
    : '';
  console.log(`[UniV3Debug] ${message}${serialised ? ` ${serialised}` : ''}`);
}

const USDC_PERMIT_IFACE = new ethers.Interface([
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function nonces(address owner) view returns (uint256)',
]);

export const TOKEN_ADDRESSES: Record<string, string> = {
  USDC: ADDRESSES.USDC,
  USDT: ADDRESSES.USDT,
  DAI: ADDRESSES.DAI,
  WETH: ADDRESSES.WETH,
  WBTC: ADDRESSES.WBTC,
  ARB: ADDRESSES.ARB,
};

const TICK_SPACINGS: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

const TICKS_10PCT_DOWN = -1054;
const TICKS_10PCT_UP = 953;

const TOKEN_DECIMALS: Record<string, number> = {
  [ADDRESSES.USDC.toLowerCase()]: 6,
  [ADDRESSES.USDT.toLowerCase()]: 6,
  [ADDRESSES.DAI.toLowerCase()]: 18,
  [ADDRESSES.USDC_E.toLowerCase()]: 6,
  [ADDRESSES.WETH.toLowerCase()]: 18,
  [ADDRESSES.WBTC.toLowerCase()]: 8,
  [ADDRESSES.ARB.toLowerCase()]: 18,
};

const UNIV3_POOL_READ_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
];

const UNIV3_POS_READ_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  `function positions(uint256 tokenId) view returns (
    uint96 nonce, address operator,
    address token0, address token1,
    uint24 fee, int24 tickLower, int24 tickUpper,
    uint128 liquidity,
    uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128,
    uint128 tokensOwed0, uint128 tokensOwed1
  )`,
];

async function readPoolState(
  provider: ethers.JsonRpcProvider,
  poolAddress: string,
): Promise<{
  token0: string;
  token1: string;
  fee: number;
  spacing: number;
  currentTick: number;
  isUsdc0: boolean;
  isUsdc1: boolean;
  volatileToken: string;
  decVolatile: number;
  sqrtPriceX96: bigint;
}> {
  const pool = new ethers.Contract(poolAddress, UNIV3_POOL_READ_ABI, provider);
  const [t0, t1, fee, slot0] = await Promise.all([
    pool.token0() as Promise<string>,
    pool.token1() as Promise<string>,
    pool.fee() as Promise<bigint>,
    pool.slot0() as Promise<{ sqrtPriceX96: bigint; tick: bigint }>,
  ]);

  const token0 = t0.toLowerCase();
  const token1 = t1.toLowerCase();
  const feeNum = Number(fee);
  const isUsdc0 = token0 === ADDRESSES.USDC.toLowerCase();
  const isUsdc1 = token1 === ADDRESSES.USDC.toLowerCase();

  
  
  const volatileToken = isUsdc1 ? token0 : isUsdc0 ? token1 : token0;
  const decVolatile = TOKEN_DECIMALS[volatileToken] ?? 18;
  const slot0Arr = slot0 as unknown as bigint[];
  const currentTick = Number(slot0Arr[1]);
  const sqrtPriceX96 = slot0Arr[0];

  return {
    token0, token1, fee: feeNum,
    spacing: TICK_SPACINGS[feeNum] ?? 60,
    currentTick, isUsdc0, isUsdc1,
    volatileToken, decVolatile,
    sqrtPriceX96,
  };
}

function estimateVolatileFromUSDC(
  usdcAmount: bigint,
  sqrtPriceX96: bigint,
  isUsdc1: boolean,
  decVolatile: number,
): { estimatedVolatile: bigint; minOut: bigint } {
  const Q96 = 2n ** 96n;
  const sqrtF = Number(sqrtPriceX96) / Number(Q96);
  const rawPrice = sqrtF * sqrtF;   

  let usdcPerVolatile: number;
  if (isUsdc1) {
    
    
    usdcPerVolatile = rawPrice * Math.pow(10, decVolatile - 6);
  } else {
    
    
    usdcPerVolatile = 1 / (rawPrice * Math.pow(10, 6 - decVolatile));
  }

  
  const estimatedVolatile = BigInt(
    Math.floor(Number(usdcAmount) / 1e6 / usdcPerVolatile * Math.pow(10, decVolatile))
  );
  const minOut = (estimatedVolatile * 995n) / 1000n;   
  return { estimatedVolatile, minOut };
}

export function rangePctToTicks(
  currentTick: number,
  rangePct: number,
  spacing: number,
): { tickLower: number; tickUpper: number } {
  const r = rangePct / 100;
  const halfTicks = Math.round(Math.log(1 + r) / Math.log(1.0001));
  return {
    tickLower: Math.floor((currentTick - halfTicks) / spacing) * spacing,
    tickUpper: Math.ceil((currentTick + halfTicks) / spacing) * spacing,
  };
}

const MAX_UINT128 = (2n ** 128n) - 1n;

export function computeOptimalTickRange(
  _ethPriceUSD: number,
  feeTier: number = 3000,
): { tickLower: number; tickUpper: number } {
  const spacing = TICK_SPACINGS[feeTier] ?? 60;
  return { tickLower: -Math.abs(TICKS_10PCT_DOWN) * spacing, tickUpper: TICKS_10PCT_UP * spacing };
}

const GMX_EXEC_FEE = BigInt(1e15);

const GMX_PERP_MARKETS: Record<string, string> = {
  WETH: '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336', 
  ETH: '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336',
  WBTC: '0x47c031236e19d024b42f8AE6780E44A573170703', 
  BTC: '0x47c031236e19d024b42f8AE6780E44A573170703',
  ARB: '0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407', 
};

function getGMXHedgeMarket(assetOrPool: string): string {
  const upper = assetOrPool.toUpperCase();
  for (const [sym, addr] of Object.entries(GMX_PERP_MARKETS)) {
    if (upper.includes(sym)) return addr;
  }
  return GMX_PERP_MARKETS['WETH']; 
}

const TOPIC_INCREASE_LIQUIDITY = ethers.id('IncreaseLiquidity(uint256,uint128,uint256,uint256)');

const AAVE_IFACE = new ethers.Interface([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function repay(address asset, uint256 amount, uint256 rateMode, address onBehalfOf) returns (uint256)',
  'function setUserUseReserveAsCollateral(address asset, bool useAsCollateral)',
]);

const ERC4626_IFACE = new ethers.Interface([
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)',
]);

const SWAP_ROUTER02_IFACE = new ethers.Interface([
  `function exactInputSingle(
      tuple(
        address tokenIn,
        address tokenOut,
        uint24  fee,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint160 sqrtPriceLimitX96
      ) params
   ) external payable returns (uint256 amountOut)`,

  
  
  `function exactInput(
      tuple(
        bytes   path,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum
      ) params
   ) external payable returns (uint256 amountOut)`,
]);

function encodeUniswapPath(tokens: string[], fees: number[]): string {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) {
    throw new Error('encodeUniswapPath: tokens.length must be fees.length + 1');
  }
  let packed = tokens[0].toLowerCase().replace('0x', '');
  for (let i = 0; i < fees.length; i++) {
    
    packed += fees[i].toString(16).padStart(6, '0');
    packed += tokens[i + 1].toLowerCase().replace('0x', '');
  }
  return '0x' + packed;
}

function buildSwapToUSDC(
  fromToken: string,
  poolFee: number,
  amountIn: bigint,
  vaultAddress: string,
): string {
  const lower = fromToken.toLowerCase();
  if (lower === ADDRESSES.USDC.toLowerCase()) return ''; 

  const directFee = DIRECT_USDC_FEES[lower];
  if (directFee !== undefined) {
    
    return SWAP_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [{
      tokenIn: ethers.getAddress(fromToken),
      tokenOut: ADDRESSES.USDC,
      fee: directFee,
      recipient: vaultAddress,
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    }]);
  }
  
  const path = encodeUniswapPath(
    [fromToken, ADDRESSES.WETH, ADDRESSES.USDC],
    [poolFee, 500],
  );
  return SWAP_ROUTER02_IFACE.encodeFunctionData('exactInput', [{
    path,
    recipient: vaultAddress,
    amountIn,
    amountOutMinimum: 0n,
  }]);
}

const DIRECT_USDC_FEES: Record<string, number> = {
  [ADDRESSES.WETH.toLowerCase()]: 500,   
  [ADDRESSES.WBTC.toLowerCase()]: 3000,  
  [ADDRESSES.ARB.toLowerCase()]: 3000,  
  [ADDRESSES.USDT.toLowerCase()]: 100,   
  [ADDRESSES.DAI.toLowerCase()]: 100,   
  [ADDRESSES.USDC_E.toLowerCase()]: 100, 
};

function DIRECT_FEE_FOR(tokenAddr: string): number {
  return DIRECT_USDC_FEES[tokenAddr.toLowerCase()] ?? 3000;
}

function bestSwapPathFromUSDC(
  targetToken: string,
  preferredFee: number = 3000,
): { path: string | null; singleHop: boolean; intermediateFee?: number } {
  const lower = targetToken.toLowerCase();

  if (DIRECT_USDC_FEES[lower] !== undefined) {
    return { path: null, singleHop: true };   
  }

  
  const multihopPath = encodeUniswapPath(
    [ADDRESSES.USDC, ADDRESSES.WETH, targetToken],
    [500, preferredFee],
  );
  return { path: multihopPath, singleHop: false, intermediateFee: preferredFee };
}

function estimateTokenFromUSDC(
  usdcAmountRaw: bigint,
  targetToken: string,
  tokenPrices: Map<string, { priceUSD: number }>,
): bigint {
  const lower = targetToken.toLowerCase();
  const dec = TOKEN_DECIMALS[lower] ?? 18;

  
  const STABLECOINS = new Set([
    ADDRESSES.USDT.toLowerCase(),
    ADDRESSES.DAI.toLowerCase(),
    ADDRESSES.USDC_E.toLowerCase(),
    ADDRESSES.USDC.toLowerCase(),
  ]);
  if (STABLECOINS.has(lower)) {
    
    const usdcAmount = Number(usdcAmountRaw) / 1e6;
    const tokenAmount = usdcAmount; 
    return BigInt(Math.floor(tokenAmount * Math.pow(10, dec) * 0.99));
  }

  
  const SYMBOL_MAP: Record<string, string[]> = {
    [ADDRESSES.WETH.toLowerCase()]: ['WETH', 'ETH'],
    [ADDRESSES.WBTC.toLowerCase()]: ['WBTC', 'BTC', 'WBTC/USD'],
    [ADDRESSES.ARB.toLowerCase()]: ['ARB'],
  };
  const symbols = SYMBOL_MAP[lower] ?? [];
  let priceInUSD = 0;
  for (const sym of symbols) {
    const tp = tokenPrices.get(sym);
    if (tp) { priceInUSD = tp.priceUSD; break; }
  }
  if (priceInUSD <= 0) return 0n;   

  const usdcAmount = Number(usdcAmountRaw) / 1e6;
  const tokenAmount = usdcAmount / priceInUSD;

  
  
  
  return BigInt(Math.floor(tokenAmount * Math.pow(10, dec) * 0.98));
}

async function safeQuoteOrFallback(
  route: SwapRoute,
  amountIn: bigint,
  provider: ethers.JsonRpcProvider,
  tokenPrices: Map<string, { priceUSD: number }>,
): Promise<bigint> {
  const quoted = await quoteSwapFromUSDC(route, amountIn, provider);
  if (quoted > 0n) return quoted;

  
  const fallback = estimateTokenFromUSDC(amountIn, route.tokenOut, tokenPrices);
  if (fallback > 0n) {
    console.warn(`[SwapRouter] Using Chainlink fallback for ${route.tokenOut}: ${fallback}`);
    return fallback;
  }

  throw new Error(
    `Cannot estimate swap output for ${route.tokenOut}: Quoter V2 failed AND no Chainlink/stablecoin price available. ` +
    `Pool should have been excluded by screener. Aborting deposit to avoid zero-liquidity mint.`,
  );
}

const PENDLE_IFACE = new ethers.Interface([
  `function swapExactTokenForPt(
      address receiver, address market, uint256 minPtOut,
      tuple(uint256 guessMin, uint256 guessMax, uint256 guessOffchain, uint256 maxIteration, uint256 eps) guessPtOut,
      tuple(address tokenIn, uint256 netTokenIn, address tokenMintSy, address pendleSwap,
            tuple(uint8 swapType, address extRouter, bytes extCalldata, bool needScale) swapData) input,
      tuple(address limitRouter, uint256 epsSkipMarket,
            tuple(tuple(uint256 salt, uint256 expiry, uint256 nonce, uint8 orderType, address token, address YT,
                        address maker, address receiver, uint256 makingAmount, uint256 lnImpliedRate,
                        uint256 failSafeRate, bytes permit) order, bytes signature, uint256 makingAmount)[] normalFills,
            tuple(tuple(uint256 salt, uint256 expiry, uint256 nonce, uint8 orderType, address token, address YT,
                        address maker, address receiver, uint256 makingAmount, uint256 lnImpliedRate,
                        uint256 failSafeRate, bytes permit) order, bytes signature, uint256 makingAmount)[] flashFills,
            bytes optData) limit
   ) external payable returns (uint256 netPtOut, uint256 netSyFee, uint256 netSyInterm)`,
  `function swapExactTokenForYt(
      address receiver, address market, uint256 minYtOut,
      tuple(uint256 guessMin, uint256 guessMax, uint256 guessOffchain, uint256 maxIteration, uint256 eps) guessYtOut,
      tuple(address tokenIn, uint256 netTokenIn, address tokenMintSy, address pendleSwap,
            tuple(uint8 swapType, address extRouter, bytes extCalldata, bool needScale) swapData) input,
      tuple(address limitRouter, uint256 epsSkipMarket,
            tuple(tuple(uint256 salt, uint256 expiry, uint256 nonce, uint8 orderType, address token, address YT,
                        address maker, address receiver, uint256 makingAmount, uint256 lnImpliedRate,
                        uint256 failSafeRate, bytes permit) order, bytes signature, uint256 makingAmount)[] normalFills,
            tuple(tuple(uint256 salt, uint256 expiry, uint256 nonce, uint8 orderType, address token, address YT,
                        address maker, address receiver, uint256 makingAmount, uint256 lnImpliedRate,
                        uint256 failSafeRate, bytes permit) order, bytes signature, uint256 makingAmount)[] flashFills,
            bytes optData) limit
   ) external payable returns (uint256 netYtOut, uint256 netSyFee, uint256 netSyInterm)`,
  `function addLiquidityDualTokenAndPt(
      address receiver, address market,
      tuple(address tokenIn, uint256 netTokenIn, address tokenMintSy, address pendleSwap,
            tuple(uint8 swapType, address extRouter, bytes extCalldata, bool needScale) swapData) input,
      uint256 netPtIn, uint256 minLpOut
   ) external returns (uint256 netLpOut, uint256 netSyFee, uint256 netSyInterm)`,
  `function removeLiquidityDualTokenAndPt(
      address receiver, address market, uint256 netLpIn,
      tuple(address tokenOut, uint256 minTokenOut, address tokenRedeemSy, address pendleSwap,
            tuple(uint8 swapType, address extRouter, bytes extCalldata, bool needScale) swapData) output,
      uint256 minPtOut
   ) external returns (uint256 netTokenOut, uint256 netPtOut, uint256 netSyFee, uint256 netSyInterm)`,
  `function redeemPyToToken(
      address receiver, address yt, uint256 netPyIn,
      tuple(address tokenOut, uint256 minTokenOut, address tokenRedeemSy, address pendleSwap,
            tuple(uint8 swapType, address extRouter, bytes extCalldata, bool needScale) swapData) output
   ) external returns (uint256 netTokenOut, uint256 netSyFee)`,
  
  `function swapExactPtForToken(
      address receiver, address market, uint256 exactPtIn,
      tuple(address tokenOut, uint256 minTokenOut, address tokenRedeemSy, address pendleSwap,
            tuple(uint8 swapType, address extRouter, bytes extCalldata, bool needScale) swapData) output,
      tuple(address limitRouter, uint256 epsSkipMarket,
            tuple(tuple(uint256 salt, uint256 expiry, uint256 nonce, uint8 orderType, address token, address YT,
                        address maker, address receiver, uint256 makingAmount, uint256 lnImpliedRate,
                        uint256 failSafeRate, bytes permit) order, bytes signature, uint256 makingAmount)[] normalFills,
            tuple(tuple(uint256 salt, uint256 expiry, uint256 nonce, uint8 orderType, address token, address YT,
                        address maker, address receiver, uint256 makingAmount, uint256 lnImpliedRate,
                        uint256 failSafeRate, bytes permit) order, bytes signature, uint256 makingAmount)[] flashFills,
            bytes optData) limit
   ) external returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm)`,
  `function swapExactYtForToken(
      address receiver, address market, uint256 exactYtIn,
      tuple(address tokenOut, uint256 minTokenOut, address tokenRedeemSy, address pendleSwap,
            tuple(uint8 swapType, address extRouter, bytes extCalldata, bool needScale) swapData) output,
      tuple(address limitRouter, uint256 epsSkipMarket,
            tuple(tuple(uint256 salt, uint256 expiry, uint256 nonce, uint8 orderType, address token, address YT,
                        address maker, address receiver, uint256 makingAmount, uint256 lnImpliedRate,
                        uint256 failSafeRate, bytes permit) order, bytes signature, uint256 makingAmount)[] normalFills,
            tuple(tuple(uint256 salt, uint256 expiry, uint256 nonce, uint8 orderType, address token, address YT,
                        address maker, address receiver, uint256 makingAmount, uint256 lnImpliedRate,
                        uint256 failSafeRate, bytes permit) order, bytes signature, uint256 makingAmount)[] flashFills,
            bytes optData) limit
   ) external returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm)`,

  
  
  
  `function addLiquiditySingleToken(
      address receiver, address market, uint256 minLpOut,
      tuple(uint256 guessMin, uint256 guessMax, uint256 guessOffchain, uint256 maxIteration, uint256 eps) guessPtReceivedFromSy,
      tuple(address tokenIn, uint256 netTokenIn, address tokenMintSy, address pendleSwap,
            tuple(uint8 swapType, address extRouter, bytes extCalldata, bool needScale) swapData) input,
      tuple(address limitRouter, uint256 epsSkipMarket,
            tuple(tuple(uint256 salt, uint256 expiry, uint256 nonce, uint8 orderType, address token, address YT,
                        address maker, address receiver, uint256 makingAmount, uint256 lnImpliedRate,
                        uint256 failSafeRate, bytes permit) order, bytes signature, uint256 makingAmount)[] normalFills,
            tuple(tuple(uint256 salt, uint256 expiry, uint256 nonce, uint8 orderType, address token, address YT,
                        address maker, address receiver, uint256 makingAmount, uint256 lnImpliedRate,
                        uint256 failSafeRate, bytes permit) order, bytes signature, uint256 makingAmount)[] flashFills,
            bytes optData) limit
   ) external payable returns (uint256 netLpOut, uint256 netSyFee, uint256 netSyInterm)`,

  `function removeLiquiditySingleToken(
      address receiver, address market, uint256 netLpToRemove,
      tuple(address tokenOut, uint256 minTokenOut, address tokenRedeemSy, address pendleSwap,
            tuple(uint8 swapType, address extRouter, bytes extCalldata, bool needScale) swapData) output,
      tuple(address limitRouter, uint256 epsSkipMarket,
            tuple(tuple(uint256 salt, uint256 expiry, uint256 nonce, uint8 orderType, address token, address YT,
                        address maker, address receiver, uint256 makingAmount, uint256 lnImpliedRate,
                        uint256 failSafeRate, bytes permit) order, bytes signature, uint256 makingAmount)[] normalFills,
            tuple(tuple(uint256 salt, uint256 expiry, uint256 nonce, uint8 orderType, address token, address YT,
                        address maker, address receiver, uint256 makingAmount, uint256 lnImpliedRate,
                        uint256 failSafeRate, bytes permit) order, bytes signature, uint256 makingAmount)[] flashFills,
            bytes optData) limit
   ) external returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm)`,
]);

const GMX_EXCHANGE_IFACE = new ethers.Interface([
  'function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)',
  'function sendWnt(address receiver, uint256 amount) external payable',
  'function sendTokens(address token, address receiver, uint256 amount) external payable',
  `function createOrder(
      tuple(
        tuple(address receiver, address cancellationReceiver, address callbackContract,
              address uiFeeReceiver, address market, address initialCollateralToken,
              address[] swapPath) addresses,
        tuple(uint256 sizeDeltaUsd, uint256 initialCollateralDeltaAmount, uint256 triggerPrice,
              uint256 acceptablePrice, uint256 executionFee, uint256 callbackGasLimit,
              uint256 minOutputAmount, uint256 validFromTime) numbers,
        uint8 orderType,
        uint8 decreasePositionSwapType,
        bool isLong,
        bool shouldUnwrapNativeToken,
        bool autoCancel,
        bytes32 referralCode,
        bytes32[] dataList
      ) params
   ) external payable returns (bytes32)`,
  
  `function createDeposit(
      tuple(
        tuple(
          address receiver, address callbackContract, address uiFeeReceiver,
          address market, address initialLongToken, address initialShortToken,
          address[] longTokenSwapPath, address[] shortTokenSwapPath
        ) addresses,
        uint256 minMarketTokens,
        bool shouldUnwrapNativeToken,
        uint256 executionFee,
        uint256 callbackGasLimit,
        bytes32[] dataList
      ) params
   ) external payable returns (bytes32)`,
  `function createWithdrawal(
      tuple(
        address receiver, address callbackContract, address uiFeeReceiver,
        address market, address[] longTokenSwapPath, address[] shortTokenSwapPath,
        uint256 minLongTokenAmount, uint256 minShortTokenAmount,
        bool shouldUnwrapNativeToken, uint256 executionFee, uint256 callbackGasLimit
      ) params
   ) external payable returns (bytes32)`,
]);

const UNIV3_PM_MULTICALL_IFACE = new ethers.Interface([
  'function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)',
]);

const UNIV3_POSITION_IFACE = new ethers.Interface([
  `function mint(
      tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper,
            uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min,
            address recipient, uint256 deadline) params
   ) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)`,
  `function collect(
      tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params
   ) external payable returns (uint256 amount0, uint256 amount1)`,
  `function decreaseLiquidity(
      tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params
   ) external payable returns (uint256 amount0, uint256 amount1)`,
  `function increaseLiquidity(
      tuple(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired,
            uint256 amount0Min, uint256 amount1Min, uint256 deadline) params
   ) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)`,
]);

const pendleEmptySwap = () =>
  ({ swapType: 0, extRouter: ethers.ZeroAddress, extCalldata: '0x', needScale: false });

const pendleTokenInput = (tokenIn: string, amount: bigint, tokenMintSy: string) =>
  ({ tokenIn, netTokenIn: amount, tokenMintSy, pendleSwap: ethers.ZeroAddress, swapData: pendleEmptySwap() });

const pendleApproxParams = () =>
  ({ guessMin: 0n, guessMax: ethers.MaxUint256, guessOffchain: 0n, maxIteration: 256n, eps: BigInt(1e14) });

const pendleEmptyLimit = () =>
  ({ limitRouter: ethers.ZeroAddress, epsSkipMarket: 0n, normalFills: [] as any[], flashFills: [] as any[], optData: '0x' });

const pendleTokenOutput = (tokenOut: string, tokenRedeemSy: string) =>
  ({ tokenOut, minTokenOut: 0n, tokenRedeemSy, pendleSwap: ethers.ZeroAddress, swapData: pendleEmptySwap() });

export function parseUniV3MintFromReceipt(
  receipt: ethers.TransactionReceipt,
): { tokenId: bigint; liquidity: bigint } | null {
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === ADDRESSES.UNI_V3_POSITION_MGR.toLowerCase() &&
      log.topics[0] === TOPIC_INCREASE_LIQUIDITY
    ) {
      const tokenId = BigInt(log.topics[1]);
      const liquidity = BigInt('0x' + log.data.slice(2, 66));
      return { tokenId, liquidity };
    }
  }
  return null;
}

function buildGMXCloseShortMulticall(
  vaultAddr: string,
  marketAddress: string,
  hedgeSizeUSD: number,
): string {
  const sizeDelta = BigInt(Math.round(hedgeSizeUSD)) * BigInt(1e30);

  const sendWntData = GMX_EXCHANGE_IFACE.encodeFunctionData('sendWnt', [ADDRESSES.GMX_ORDER_VAULT, GMX_EXEC_FEE]);
  const createOrderData = GMX_EXCHANGE_IFACE.encodeFunctionData('createOrder', [{
    addresses: {
      receiver: vaultAddr,
      cancellationReceiver: vaultAddr,
      callbackContract: ethers.ZeroAddress,
      uiFeeReceiver: ethers.ZeroAddress,
      market: marketAddress,
      initialCollateralToken: ADDRESSES.USDC,
      swapPath: [],
    },
    numbers: {
      sizeDeltaUsd: sizeDelta,
      initialCollateralDeltaAmount: 0n,    
      triggerPrice: 0n,
      acceptablePrice: 0n,     
      executionFee: GMX_EXEC_FEE,
      callbackGasLimit: 0n,
      minOutputAmount: 0n,
      validFromTime: 0n,
    },
    orderType: 4,     
    decreasePositionSwapType: 0,
    isLong: false, 
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: ethers.ZeroHash,
    dataList: [],
  }]);

  return GMX_EXCHANGE_IFACE.encodeFunctionData('multicall', [[sendWntData, createOrderData]]);
}

function buildGMXOpenShortMulticall(
  vaultAddr: string,
  marketAddress: string,
  collateral: bigint,
  hedgeSizeUSD: number,
  currentPrice: number,
): string {
  const sizeDelta = BigInt(Math.round(hedgeSizeUSD)) * BigInt(1e30);
  
  const acceptablePrice = BigInt(Math.round(currentPrice * 1.005 * 1e12));

  const sendWntData = GMX_EXCHANGE_IFACE.encodeFunctionData('sendWnt', [ADDRESSES.GMX_ORDER_VAULT, GMX_EXEC_FEE]);
  const sendTokensData = GMX_EXCHANGE_IFACE.encodeFunctionData('sendTokens', [ADDRESSES.USDC, ADDRESSES.GMX_ORDER_VAULT, collateral]);
  const createOrderData = GMX_EXCHANGE_IFACE.encodeFunctionData('createOrder', [{
    addresses: {
      receiver: vaultAddr,
      cancellationReceiver: vaultAddr,
      callbackContract: ethers.ZeroAddress,
      uiFeeReceiver: ethers.ZeroAddress,
      market: marketAddress,
      initialCollateralToken: ADDRESSES.USDC,
      swapPath: [],
    },
    numbers: {
      sizeDeltaUsd: sizeDelta,
      initialCollateralDeltaAmount: collateral,
      triggerPrice: 0n,
      acceptablePrice,
      executionFee: GMX_EXEC_FEE,
      callbackGasLimit: 0n,
      minOutputAmount: 0n,
      validFromTime: 0n,
    },
    orderType: 2,     
    decreasePositionSwapType: 0,
    isLong: false, 
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: ethers.ZeroHash,
    dataList: [],
  }]);

  return GMX_EXCHANGE_IFACE.encodeFunctionData('multicall', [[sendWntData, sendTokensData, createOrderData]]);
}

function buildGMXDepositMulticall(vaultAddr: string, marketAddress: string, amount: bigint): string {
  const sendWntData = GMX_EXCHANGE_IFACE.encodeFunctionData('sendWnt', [ADDRESSES.GMX_DEPOSIT_VAULT, GMX_EXEC_FEE]);
  const sendTokensData = GMX_EXCHANGE_IFACE.encodeFunctionData('sendTokens', [ADDRESSES.USDC, ADDRESSES.GMX_DEPOSIT_VAULT, amount]);
  
  const depositData = GMX_EXCHANGE_IFACE.encodeFunctionData('createDeposit', [{
    addresses: {
      receiver: vaultAddr, callbackContract: ethers.ZeroAddress,
      uiFeeReceiver: ethers.ZeroAddress, market: marketAddress,
      initialLongToken: ethers.ZeroAddress, initialShortToken: ADDRESSES.USDC,
      longTokenSwapPath: [], shortTokenSwapPath: [],
    },
    minMarketTokens: 0n,
    shouldUnwrapNativeToken: false,
    executionFee: GMX_EXEC_FEE,
    callbackGasLimit: 0n,
    dataList: [],
  }]);
  return GMX_EXCHANGE_IFACE.encodeFunctionData('multicall', [[sendWntData, sendTokensData, depositData]]);
}

function buildGMXWithdrawMulticall(vaultAddr: string, marketAddress: string, amount: bigint): string {
  const sendWntData = GMX_EXCHANGE_IFACE.encodeFunctionData('sendWnt', [ADDRESSES.GMX_WITHDRAWAL_VAULT, GMX_EXEC_FEE]);
  const sendTokensData = GMX_EXCHANGE_IFACE.encodeFunctionData('sendTokens', [marketAddress, ADDRESSES.GMX_WITHDRAWAL_VAULT, amount]);
  const withdrawData = GMX_EXCHANGE_IFACE.encodeFunctionData('createWithdrawal', [{
    receiver: vaultAddr, callbackContract: ethers.ZeroAddress,
    uiFeeReceiver: ethers.ZeroAddress, market: marketAddress,
    longTokenSwapPath: [], shortTokenSwapPath: [],
    minLongTokenAmount: 0n, minShortTokenAmount: 0n,
    shouldUnwrapNativeToken: false, executionFee: GMX_EXEC_FEE, callbackGasLimit: 0n,
  }]);
  return GMX_EXCHANGE_IFACE.encodeFunctionData('multicall', [[sendWntData, sendTokensData, withdrawData]]);
}

function buildLeveragedLoopBatch(
  asset: string,
  amount: bigint,
  vaultAddr: string,
  loops: number = 3,
): { targets: string[]; dataArr: string[] } {
  const targets: string[] = [];
  const dataArr: string[] = [];
  const LTV = 75n;

  targets.push(ADDRESSES.AAVE_POOL);
  dataArr.push(AAVE_IFACE.encodeFunctionData('supply', [asset, amount, vaultAddr, 0]));

  targets.push(ADDRESSES.AAVE_POOL);
  dataArr.push(AAVE_IFACE.encodeFunctionData('setUserUseReserveAsCollateral', [asset, true]));

  let available = amount;
  for (let i = 0; i < loops; i++) {
    const borrow = (available * LTV) / 100n;
    targets.push(ADDRESSES.AAVE_POOL);
    dataArr.push(AAVE_IFACE.encodeFunctionData('borrow', [asset, borrow, 2, 0, vaultAddr]));
    targets.push(ADDRESSES.AAVE_POOL);
    dataArr.push(AAVE_IFACE.encodeFunctionData('supply', [asset, borrow, vaultAddr, 0]));
    available = borrow;
  }
  return { targets, dataArr };
}

function buildDepositCalldata(
  input: ExecutionInput,
  vaultAddress: string,
): { target: string; calldata: string; value: bigint } {
  const { strategyType, asset, amount, marketAddress, tickLower, tickUpper } = input;
  
  
  const recipient = input.recipientAddress ?? vaultAddress;

  switch (strategyType) {
    case 'AAVE_LENDING':
      return {
        target: ADDRESSES.AAVE_POOL, value: 0n,
        calldata: AAVE_IFACE.encodeFunctionData('supply', [asset, amount, recipient, 0])
      };

    case 'MORPHO_LENDING':
      if (!marketAddress) throw new Error('MORPHO_LENDING requires marketAddress (vault address)');
      return {
        target: marketAddress, value: 0n,
        calldata: ERC4626_IFACE.encodeFunctionData('deposit', [amount, recipient])
      };

    case 'PENDLE_PT':
      if (!marketAddress) throw new Error('PENDLE_PT requires marketAddress');
      return {
        target: ADDRESSES.PENDLE_ROUTER, value: 0n,
        calldata: PENDLE_IFACE.encodeFunctionData('swapExactTokenForPt', [
          recipient, marketAddress, 0n,
          pendleApproxParams(), pendleTokenInput(asset, amount, asset), pendleEmptyLimit(),
        ])
      };

    case 'PENDLE_LP':
      if (!marketAddress) throw new Error('PENDLE_LP requires marketAddress');
      return {
        target: ADDRESSES.PENDLE_ROUTER, value: 0n,
        calldata: PENDLE_IFACE.encodeFunctionData('addLiquiditySingleToken', [
          recipient, marketAddress,
          0n,
          pendleApproxParams(),
          pendleTokenInput(asset, amount, asset),
          pendleEmptyLimit(),
        ])
      };

    case 'PENDLE_YT':
      if (!marketAddress) throw new Error('PENDLE_YT requires marketAddress');
      return {
        target: ADDRESSES.PENDLE_ROUTER, value: 0n,
        calldata: PENDLE_IFACE.encodeFunctionData('swapExactTokenForYt', [
          recipient, marketAddress, (amount * 90n) / 100n,
          pendleApproxParams(), pendleTokenInput(asset, amount, asset), pendleEmptyLimit(),
        ])
      };

    
    
    
    case 'GMX_REAL_YIELD':
      if (!marketAddress) throw new Error('GMX_REAL_YIELD requires marketAddress');
      return {
        target: ADDRESSES.GMX_EXCHANGE_ROUTER, value: GMX_EXEC_FEE,
        calldata: buildGMXDepositMulticall(vaultAddress, marketAddress, amount)
      };

    case 'DELTA_NEUTRAL':
      
      
      throw new Error('DELTA_NEUTRAL deposits must go through _executeDeltaNeutralDeposit');

    case 'LEVERAGED_LOOP':
      
      return {
        target: ADDRESSES.AAVE_POOL, value: 0n,
        calldata: AAVE_IFACE.encodeFunctionData('supply', [asset, amount, vaultAddress, 0])
      };

    default:
      throw new Error(`No deposit builder for ${strategyType}`);
  }
}

function buildWithdrawCalldata(
  input: ExecutionInput,
  vaultAddress: string,
): { target: string; calldata: string; value: bigint } {
  const { strategyType, asset, amount, marketAddress, tokenId, liquidity } = input;

  switch (strategyType) {
    case 'AAVE_LENDING':
    case 'LEVERAGED_LOOP':
      return {
        target: ADDRESSES.AAVE_POOL, value: 0n,
        calldata: AAVE_IFACE.encodeFunctionData('withdraw', [asset, amount, vaultAddress])
      };

    case 'MORPHO_LENDING':
      if (!marketAddress) throw new Error('MORPHO_LENDING requires marketAddress');
      return {
        target: marketAddress, value: 0n,
        calldata: ERC4626_IFACE.encodeFunctionData('withdraw', [amount, vaultAddress, vaultAddress])
      };

    case 'PENDLE_PT': {
      if (!marketAddress) throw new Error('PENDLE_PT requires marketAddress');
      const nowSec = Math.floor(Date.now() / 1000);
      const matured = input.maturityDate ? nowSec >= input.maturityDate : false;
      if (matured) {
        
        const ytAddr = input.ytAddress ?? marketAddress;
        return {
          target: ADDRESSES.PENDLE_ROUTER, value: 0n,
          calldata: PENDLE_IFACE.encodeFunctionData('redeemPyToToken', [
            vaultAddress, ytAddr, amount, pendleTokenOutput(asset, asset),
          ])
        };
      } else {
        
        return {
          target: ADDRESSES.PENDLE_ROUTER, value: 0n,
          calldata: PENDLE_IFACE.encodeFunctionData('swapExactPtForToken', [
            vaultAddress, marketAddress, amount, pendleTokenOutput(asset, asset), pendleEmptyLimit(),
          ])
        };
      }
    }

    case 'PENDLE_LP':
      if (!marketAddress) throw new Error('PENDLE_LP requires marketAddress');
      
      return {
        target: ADDRESSES.PENDLE_ROUTER, value: 0n,
        calldata: PENDLE_IFACE.encodeFunctionData('removeLiquiditySingleToken', [
          vaultAddress, marketAddress, amount,
          pendleTokenOutput(asset, asset),
          pendleEmptyLimit(),
        ])
      };

    case 'PENDLE_YT': {
      if (!marketAddress) throw new Error('PENDLE_YT requires marketAddress');
      const nowSec = Math.floor(Date.now() / 1000);
      const matured = input.maturityDate ? nowSec >= input.maturityDate : false;
      if (matured) {
        const ytAddr = input.ytAddress ?? marketAddress;
        return {
          target: ADDRESSES.PENDLE_ROUTER, value: 0n,
          calldata: PENDLE_IFACE.encodeFunctionData('redeemPyToToken', [
            vaultAddress, ytAddr, amount, pendleTokenOutput(asset, asset),
          ])
        };
      } else {
        
        return {
          target: ADDRESSES.PENDLE_ROUTER, value: 0n,
          calldata: PENDLE_IFACE.encodeFunctionData('swapExactYtForToken', [
            vaultAddress, marketAddress, amount, pendleTokenOutput(asset, asset), pendleEmptyLimit(),
          ])
        };
      }
    }

    
    case 'GMX_REAL_YIELD':
      if (!marketAddress) throw new Error('GMX_REAL_YIELD requires marketAddress');
      return {
        target: ADDRESSES.GMX_EXCHANGE_ROUTER, value: GMX_EXEC_FEE,
        calldata: buildGMXWithdrawMulticall(vaultAddress, marketAddress, amount)
      };

    case 'DELTA_NEUTRAL':
      
      
      throw new Error('DELTA_NEUTRAL withdraw must go through _executeDeltaNeutralClose');

    default:
      throw new Error(`No withdraw builder for ${strategyType}`);
  }
}

export interface ExecutionInput {
  strategyType: StrategyType;
  asset: string;
  amount: bigint;
  amountUSD: number;
  userAddress: string;
  marketAddress: string;
  assertedAPY?: number;   
  currentPrice?: number;   
  tokenPrices?: Map<string, { priceUSD: number }>;  
  rangePct?: number;   
  tickLower?: number;
  tickUpper?: number;
  tokenId?: bigint;
  liquidity?: bigint;
  hedgeSizeUSD?: number;
  maturityDate?: number;
  ytAddress?: string;
  
  userId?: string;
  
  portfolioValueUSD?: number;
  
  
  
  
  managedUSD?: number;
  
  
  recipientAddress?: string;
}

export interface OnChainExecutionResult {
  txHash: string;
  receiptHash: string;
  gasUsed: number;
  success: boolean;
  simulated: false;
  uniV3TokenId?: bigint;
  uniV3Liquidity?: bigint;
  gmxOrderKey?: string;
  
  uniV3TickLower?: number;
  uniV3TickUpper?: number;
  uniV3CenterTick?: number;
  uniV3RangePct?: number;
  uniV3EntryPool?: string;
  
  entryLiquidityIndex?: bigint;   
  morphoShares?: bigint;   
  pendleLpAmount?: bigint;   
  
  
  partialFailure?: boolean;
}

export interface PreparedWithdrawalResult {
  close: OnChainExecutionResult;
  normalize?: OnChainExecutionResult;
  idleUSDC: bigint;
  tokenBalances: Array<{
    asset: string;
    before: bigint;
    after: bigint;
    delta: bigint;
  }>;
}

export class AgentExecutor {
  private wallet: ethers.Wallet;
  private vault: ethers.Contract;           
  private router: ethers.Contract | null = null;
  private vaultAddress: string;
  private gmxInitialized = false;

  
  private pimlico: PimlicoLayer | null = null;
  private pimlicoInit: Promise<void>;             

  
  private delegClient: DelegationClient | null = null;

  constructor(
    privateKey: string,
    vaultAddress: string,
    arbRpcUrl: string,
    zgRouterAddress?: string,
    zgRpcUrl?: string,
  ) {
    const provider = new ethers.JsonRpcProvider(arbRpcUrl, 42161, { staticNetwork: true });
    this.wallet = new ethers.Wallet(privateKey, provider);
    this.vault = new ethers.Contract(vaultAddress, VAULT_ABI, this.wallet);
    this.vaultAddress = vaultAddress;

    if (zgRouterAddress && zgRpcUrl) {
      const zgProvider = new ethers.JsonRpcProvider(zgRpcUrl, 16661, { staticNetwork: true });
      this.router = new ethers.Contract(
        zgRouterAddress, ROUTER_ABI, new ethers.Wallet(privateKey, zgProvider),
      );
    }

    
    this.pimlicoInit = initPimlicoIfConfigured(privateKey, arbRpcUrl)
      .then(layer => { this.pimlico = layer; })
      .catch(err => { console.warn('[ERC-4337] Pimlico init error:', err.message); });

    
    const executorAddr = process.env.EXECUTOR_ADDRESS;
    const dmAddr = process.env.DELEGATION_MANAGER
      ?? '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3'; 
    if (executorAddr) {
      this.delegClient = new DelegationClient(executorAddr, dmAddr);
      console.log('[V2] DelegationClient ready. Executor:', executorAddr);
    }
  }

  

  
  setUserDelegation(userId: string, delegation: StoredDelegation): void {
    if (!this.delegClient) {
      console.warn('[V2] DelegationClient not init — EXECUTOR_ADDRESS missing in env');
      return;
    }
    this.delegClient.setDelegation(userId, delegation);
    console.log(`[V2] Delegation stored for user: ${userId} → smartAccount: ${delegation.delegator}`);
  }

  
  updateDelegationPreValue(userId: string, valueUSD: number): void {
    this.delegClient?.updatePreValue(userId, BigInt(Math.round(valueUSD * 1e6)));
  }

  
  hasV2Delegation(userId: string): boolean {
    return this.delegClient?.hasDelegation(userId) ?? false;
  }

  
  async sponsorV2Preparation(params: {
    userAddress: string;
    smartAccountAddress: string;
    amount: bigint;
    permitSig?: string;
    permitDeadline?: bigint;
  }): Promise<{ smartAccountBalance: string }> {
    
    
    
    
    
    
    
    
    
    const provider = this.wallet.provider as ethers.JsonRpcProvider;
    const erc20 = new ethers.Contract(ADDRESSES.USDC, ['function balanceOf(address) view returns (uint256)'], provider);
    const usdcBal = await erc20.balanceOf(params.smartAccountAddress) as bigint;
    return { smartAccountBalance: usdcBal.toString() };
  }

  
  async sponsorOnboarding(
    userAddress: string,
    policy: any,
    policySig: string,
    permitSig?: string,
    permitAmount?: bigint,
    permitDeadline?: bigint,
  ): Promise<{ txHash: string }> {
    let permitTxHash = '0x0000000000000000000000000000000000000000000000000000000000000000';
    if (permitSig && permitAmount) {
      const pSig = ethers.Signature.from(permitSig);
      const deadline = permitDeadline ?? BigInt(Math.floor(Date.now() / 1000) + 3600);
      const permitData = USDC_PERMIT_IFACE.encodeFunctionData('permit', [
        userAddress,
        this.vaultAddress, 
        permitAmount,
        deadline,
        pSig.v,
        pSig.r,
        pSig.s,
      ]);

      if (!this.pimlico) {
        await this.wallet.sendTransaction({ to: ADDRESSES.USDC, data: permitData });
      } else {
        permitTxHash = await this.pimlico.sendCall(ADDRESSES.USDC, permitData, 0n);
      }
    }

    const registerData = VAULT_IFACE.encodeFunctionData('registerPolicy', [policy, policySig]);

    if (!this.pimlico) {
      const tx = await this.wallet.sendTransaction({ to: this.vaultAddress, data: registerData });
      return { txHash: tx.hash };
    }

    const txHash = await this.pimlico.sendCall(this.vaultAddress, registerData, 0n);
    return { txHash };
  }

  

  async deposit(input: ExecutionInput): Promise<OnChainExecutionResult> {
    if (input.strategyType === 'LEVERAGED_LOOP') {
      return this._executeLeveragedLoop(input);
    }

    
    
    if (input.strategyType === 'DELTA_NEUTRAL') {
      return this._executeDeltaNeutralDeposit(input);
    }

    
    if (input.strategyType === 'GMX_REAL_YIELD' && !this.gmxInitialized) {
      await this.initGMX();
    }

    const { target, calldata, value } = buildDepositCalldata(input, this.vaultAddress);
    const approveTarget = value > 0n ? ADDRESSES.GMX_ROUTER : target;
    await this._approveIfNeeded(input.asset, approveTarget, input.amount);

    
    
    const assertedAPY = BigInt(input.assertedAPY ?? 0);
    const result = await this._fundedDeposit(target, calldata, value, assertedAPY, 'GENESIS', input);

    
    
    
    if (result.success && result._receipt) {
      try {
        switch (input.strategyType) {

          case 'AAVE_LENDING': {
            
            
            
            const aavePool = new ethers.Contract(
              ADDRESSES.AAVE_POOL,
              AAVE_POOL_READ_ABI,
              this.wallet.provider as ethers.JsonRpcProvider,
            );
            result.entryLiquidityIndex = await aavePool.getReserveNormalizedIncome(
              ADDRESSES.USDC,
            ) as bigint;
            break;
          }

          case 'MORPHO_LENDING': {
            
            
            if (input.marketAddress) {
              result.morphoShares = parseMintedAmount(
                result._receipt,
                input.marketAddress,
                this.vaultAddress,
              );
            }
            break;
          }

          case 'PENDLE_LP': {
            
            
            if (input.marketAddress) {
              result.pendleLpAmount = parseMintedAmount(
                result._receipt,
                input.marketAddress,
                this.vaultAddress,
              );
            }
            break;
          }

          
          
          
          
        }
      } catch (err: any) {
        console.warn('[Executor] On-chain state capture failed (non-fatal):', err.message);
      }
    }

    return result;
  }

  

  async withdraw(input: ExecutionInput): Promise<OnChainExecutionResult> {
    
    
    if (input.strategyType === 'LEVERAGED_LOOP') {
      return this._executeLeveragedUnwind(input);
    }

    
    if (input.strategyType === 'DELTA_NEUTRAL' && input.hedgeSizeUSD && input.hedgeSizeUSD > 0) {
      try {
        await this.closeGMXShort(input.marketAddress, input.hedgeSizeUSD, input.userAddress, input.amountUSD);
      } catch (err: any) {
        console.warn('[Executor] GMX short close failed:', err.message);
      }
    }

    
    
    
    if (input.strategyType === 'DELTA_NEUTRAL') {
      return this._executeDeltaNeutralClose(input);
    }

    const { target, calldata, value } = buildWithdrawCalldata(input, this.vaultAddress);
    
    return this._fundedWithdraw(target, calldata, value, 'WITHDRAW', input);
  }

  
  
  
  
  
  

  private async _executeLeveragedUnwind(input: ExecutionInput): Promise<OnChainExecutionResult> {
    await this._approveIfNeeded(input.asset, ADDRESSES.AAVE_POOL, ethers.MaxUint256);

    const targets = [ADDRESSES.AAVE_POOL, ADDRESSES.AAVE_POOL];
    const dataArr = [
      AAVE_IFACE.encodeFunctionData('repay', [input.asset, ethers.MaxUint256, 2, this.vaultAddress]),
      AAVE_IFACE.encodeFunctionData('withdraw', [input.asset, ethers.MaxUint256, this.vaultAddress]),
    ];

    const receiptHash = this._buildReceiptHash(input, 'WITHDRAW');
    const { txHash, receipt } = await this._submitVaultTx('executeBatch', [
      input.userAddress, input.asset, targets, dataArr, receiptHash,
    ]);
    this._recordOnZG(input.userAddress, receiptHash, 'WITHDRAW', input.amountUSD);
    return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false };
  }

  
  
  
  
  
  
  
  
  
  
  
  
  
  

  async migrate(from: ExecutionInput, to: ExecutionInput): Promise<OnChainExecutionResult> {
    if (from.strategyType === 'DELTA_NEUTRAL') {
      
      
      
      if (from.userId && this.delegClient?.hasDelegation(from.userId)) {
        if (!from.recipientAddress) throw new Error('[V2 Migrate] recipientAddress required');
        const provider2 = this.wallet.provider as ethers.JsonRpcProvider;
        const ps = await readPoolState(provider2, from.marketAddress);
        const usdcLower = ADDRESSES.USDC.toLowerCase();

        await this._executeDeltaNeutralClose(from);

        
        const erc20ABI = ['function balanceOf(address) view returns (uint256)'];
        const [t0Bal, t1Bal] = await Promise.all([
          (new ethers.Contract(ps.token0, erc20ABI, provider2).balanceOf(from.recipientAddress) as Promise<bigint>),
          (new ethers.Contract(ps.token1, erc20ABI, provider2).balanceOf(from.recipientAddress) as Promise<bigint>),
        ]);

        const tokensToNormalize = [];
        if (t0Bal > 0n && ps.token0.toLowerCase() !== usdcLower) {
          const route = await resolveSwapRoute(ps.token0, provider2);
          if (route) tokensToNormalize.push({ address: ps.token0, amount: t0Bal, route });
        }
        if (t1Bal > 0n && ps.token1.toLowerCase() !== usdcLower) {
          const route = await resolveSwapRoute(ps.token1, provider2);
          if (route) tokensToNormalize.push({ address: ps.token1, amount: t1Bal, route });
        }

        if (tokensToNormalize.length > 0) {
          const swapperAddr = process.env.SWAPPER_ADDRESS!;
          const normTokens = await Promise.all(tokensToNormalize.map(async (t) => {
            const quoted = await quoteSwapToUSDC(t.route, t.amount, provider2);
            const minOut = quoted > 0n ? (quoted * 98n) / 100n : 0n; 
            const dexCd = t.route.singleHop
              ? SWAP_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [{ tokenIn: ethers.getAddress(t.address), tokenOut: ADDRESSES.USDC, fee: t.route.fee, recipient: swapperAddr, amountIn: t.amount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }])
              : SWAP_ROUTER02_IFACE.encodeFunctionData('exactInput', [{ path: reverseUniswapPath(t.route.path!), recipient: swapperAddr, amountIn: t.amount, amountOutMinimum: minOut }]);
            return { address: ethers.getAddress(t.address), amount: t.amount, dexAddress: ADDRESSES.SWAP_ROUTER02, dexCalldata: dexCd, minOut };
          }));

          const normCd = this.delegClient.buildNormalizeCalldata({
            userId: from.userId, swapperAddress: swapperAddr,
            tokens: normTokens,
            usdcAddress: ADDRESSES.USDC, recipient: from.recipientAddress,
            executionArgs: rebalanceArgs(from.amountUSD),
          });
          await this._redeemDelegation(normCd);
        }

        
        
        
        
        const finalUSDC = await (new ethers.Contract(ADDRESSES.USDC, erc20ABI, provider2).balanceOf(from.recipientAddress) as Promise<bigint>);
        if (finalUSDC === 0n) {
          throw new Error('[V2 Migrate] No USDC balance remaining after close/normalize');
        }
        const allocationRaw = to.amount;  
        to.amount    = finalUSDC < allocationRaw ? finalUSDC : allocationRaw;
        to.amountUSD = Number(to.amount) / 1e6;

        return this.deposit(to);
      }

      
      const provider = this.wallet.provider as ethers.JsonRpcProvider;
      const poolState = await readPoolState(provider, from.marketAddress);
      const trackedAssets = [
        ethers.getAddress(poolState.token0),
        ethers.getAddress(poolState.token1),
      ];

      
      
      const before = await Promise.all(
        trackedAssets.map(a => this.idleBalance(from.userAddress, a)),
      );
      await this._executeDeltaNeutralClose(from);
      const afterClose = await Promise.all(
        trackedAssets.map(a => this.idleBalance(from.userAddress, a)),
      );
      const tokenBalances = trackedAssets.map((asset, i) => ({
        asset,
        before: before[i],
        after: afterClose[i],
        delta: afterClose[i] > before[i] ? afterClose[i] - before[i] : 0n,
      }));

      
      await this._executeDeltaNeutralNormalizeTracked(from, poolState, tokenBalances);

      
      return this.deposit(to);
    }

    
    
    
    const withdrawResult = await this.withdraw(from);
    try {
      return await this.deposit(to);
    } catch (depositErr: any) {
      console.warn(
        `[Migrate] Withdraw succeeded (tx: ${withdrawResult.txHash.slice(0, 10)}…) but deposit failed — funds remain idle in vault. Error: ${depositErr.message}`,
      );
      return {
        ...withdrawResult,
        success: false,
        partialFailure: true,
      };
    }
  }

  
  
  
  
  
  

  private async _executeDeltaNeutralClose(
    input: ExecutionInput,
  ): Promise<OnChainExecutionResult> {
    const provider = this.wallet.provider as ethers.JsonRpcProvider;
    let liveLiquidity = input.liquidity ?? 0n;

    
    
    if (input.tokenId) {
      const posMgr = new ethers.Contract(
        ADDRESSES.UNI_V3_POSITION_MGR,
        ['function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'],
        provider,
      );
      try {
        const pos = await posMgr.positions(input.tokenId);
        liveLiquidity = BigInt(pos.liquidity ?? pos[7] ?? liveLiquidity);
      } catch (err: any) {
        if (String(err?.reason ?? err?.message ?? '').includes('Invalid token ID')) {
          console.log(`[DeltaNeutralClose] NFT ${input.tokenId} already burned — skipping close`);
          const noopHash = this._buildReceiptHash(input, 'WITHDRAW');
          return { txHash: '0x0000000000000000000000000000000000000000000000000000000000000000', receiptHash: noopHash, gasUsed: 0, success: true, simulated: false };
        }
        throw err;
      }
    }

    const poolState = await readPoolState(provider, input.marketAddress);
    const { token0, token1 } = poolState;

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const receiptHash = this._buildReceiptHash(input, 'WITHDRAW');

    
    if (input.userId && this.delegClient?.hasDelegation(input.userId)) {
      const smartAcct = input.recipientAddress ?? input.userAddress;
      const v2Inner: string[] = [];
      if (liveLiquidity > 0n) {
        v2Inner.push(UNIV3_POSITION_IFACE.encodeFunctionData('decreaseLiquidity', [{
          tokenId: input.tokenId!, liquidity: liveLiquidity,
          amount0Min: 0n, amount1Min: 0n, deadline,
        }]));
      }
      v2Inner.push(UNIV3_POSITION_IFACE.encodeFunctionData('collect', [{
        tokenId: input.tokenId!, recipient: smartAcct,
        amount0Max: MAX_UINT128, amount1Max: MAX_UINT128,
      }]));
      const v2Multicall = UNIV3_PM_MULTICALL_IFACE.encodeFunctionData('multicall', [v2Inner]);
      
      
      const portfolioUSD = input.portfolioValueUSD ?? input.amountUSD;
      const redeemCd = this.delegClient.buildWithdrawCalldata({
        userId: input.userId,
        protocolAddress: ADDRESSES.UNI_V3_POSITION_MGR,
        protocolCalldata: v2Multicall,
        protocolValue: 0n,
        
        
        executionArgs: rebalanceArgs(portfolioUSD),
      });
      const { txHash, receipt } = await this._redeemDelegation(redeemCd);
      this._recordOnZG(input.userAddress, receiptHash, 'WITHDRAW', input.amountUSD);
      return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false };
    }

    
    const collectCalldata = UNIV3_POSITION_IFACE.encodeFunctionData('collect', [{
      tokenId: input.tokenId!, recipient: this.vaultAddress,
      amount0Max: MAX_UINT128, amount1Max: MAX_UINT128,
    }]);

    const innerCalls: string[] = [];
    if (liveLiquidity > 0n) {
      innerCalls.push(UNIV3_POSITION_IFACE.encodeFunctionData('decreaseLiquidity', [{
        tokenId: input.tokenId!,
        liquidity: liveLiquidity,
        amount0Min: 0n, amount1Min: 0n, deadline,
      }]));
    }
    innerCalls.push(collectCalldata);

    const multicallData = UNIV3_PM_MULTICALL_IFACE.encodeFunctionData('multicall', [innerCalls]);

    
    
    
    
    
    
    
    
    const usdcAddr = ethers.getAddress(ADDRESSES.USDC);
    const isUsdcInPair = [token0, token1].some(
      t => ethers.getAddress(t).toLowerCase() === usdcAddr.toLowerCase()
    );

    let closeAssets = [token0, token1];
    let closeDeployed = [0n, 0n];

    if (!isUsdcInPair) {
      const vaultRead = new ethers.Contract(
        this.vaultAddress,
        ['function deployed(address,address) view returns (uint256)'],
        provider,
      );
      const usdcDeployed = await vaultRead.deployed(input.userAddress, usdcAddr).catch(() => 0n) as bigint;
      
      closeAssets = [usdcAddr, token0, token1];
      closeDeployed = [usdcDeployed, 0n, 0n];
    }

    const { txHash, receipt } = await this._submitVaultTx('executeWithdrawMulti', [
      input.userAddress,
      closeAssets,
      closeDeployed,
      ADDRESSES.UNI_V3_POSITION_MGR,
      multicallData,
      receiptHash,
    ]);
    this._recordOnZG(input.userAddress, receiptHash, 'WITHDRAW', input.amountUSD);
    return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false };
  }

  private async _executeDeltaNeutralNormalizeTracked(
    input: ExecutionInput,
    poolState: Awaited<ReturnType<typeof readPoolState>>,
    trackedBalances: Array<{ asset: string; after: bigint; delta: bigint }>,
  ): Promise<OnChainExecutionResult | undefined> {
    const { fee } = poolState;
    const swaps: Array<{ asset: string; amount: bigint; calldata: string }> = [];

    for (const item of trackedBalances) {
      const asset = ethers.getAddress(item.asset);
      if (asset.toLowerCase() === ADDRESSES.USDC.toLowerCase()) continue;

      
      
      const amount = item.after;
      if (amount === 0n) continue;

      const calldata = buildSwapToUSDC(asset, fee, amount, this.vaultAddress);
      if (!calldata) continue;

      await this._approveIfNeeded(asset, ADDRESSES.SWAP_ROUTER02, amount);
      swaps.push({ asset, amount, calldata });
    }

    if (swaps.length === 0) return undefined;

    const assetsInvolved = [
      ...swaps.map(s => s.asset),
      ADDRESSES.USDC,
    ];
    const targets = swaps.map(() => ADDRESSES.SWAP_ROUTER02);
    const dataArr = swaps.map(s => s.calldata);
    const receiptHash = this._buildReceiptHash(input, 'WITHDRAW');

    const { txHash, receipt } = await this._submitVaultTx('executeBatchMulti', [
      input.userAddress,
      assetsInvolved,
      targets,
      dataArr,
      receiptHash,
    ]);
    this._recordOnZG(input.userAddress, receiptHash, 'WITHDRAW', input.amountUSD);
    return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false };
  }

  
  
  
  

  

  async closeGMXShort(
    assetOrMarket: string,  
    hedgeSizeUSD: number,
    userAddress: string,
    amountUSD: number,
  ): Promise<OnChainExecutionResult> {
    const gmxHedgeMarket = getGMXHedgeMarket(assetOrMarket);
    const closeData = buildGMXCloseShortMulticall(this.vaultAddress, gmxHedgeMarket, hedgeSizeUSD);
    const input: ExecutionInput = {
      strategyType: 'DELTA_NEUTRAL', asset: ADDRESSES.USDC,
      amount: 0n, amountUSD, userAddress, marketAddress: gmxHedgeMarket,
    };
    return this._genericCall(ADDRESSES.GMX_EXCHANGE_ROUTER, closeData, GMX_EXEC_FEE, 'MIGRATE', input);
  }

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  

  async collectUniV3Fees(
    tokenId: bigint,
    userAddress: string,
    amountUSD: number,
    ethPriceUSD: number = 3000,
    userId?: string,
    recipientAddress?: string,
    preValueUSD?: number,
    maxFeeBps?: number,
  ): Promise<OnChainExecutionResult> {
    const provider = this.wallet.provider as ethers.JsonRpcProvider;

    
    
    
    
    
    
    
    
    
    
    
    if (userId && this.delegClient?.hasDelegation(userId)) {
      const smartAcct = recipientAddress ?? userAddress;

      
      const posMgr = new ethers.Contract(ADDRESSES.UNI_V3_POSITION_MGR, [
        'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
      ], provider);
      const pos        = await posMgr.positions(tokenId);
      const token0     = ethers.getAddress(pos[2] as string);
      const token1     = ethers.getAddress(pos[3] as string);
      const tokensOwed0 = BigInt(pos[10] ?? 0n);
      const tokensOwed1 = BigInt(pos[11] ?? 0n);

      
      if (tokensOwed0 === 0n && tokensOwed1 === 0n) {
        const receiptHash = ethers.keccak256(ethers.toUtf8Bytes(`${userAddress}-HARVEST-${tokenId}-${Date.now()}`));
        return { txHash: '0x', receiptHash, gasUsed: 0, success: true, simulated: false };
      }

      
      
      const cd = this.delegClient.buildHarvestCompoundCalldata({
        userId,
        tokenId,
        token0,
        token1,
        tokensOwed0,
        tokensOwed1,
        maxFeeBps:           maxFeeBps ?? 0,
        treasury:            process.env.TREASURY_ADDRESS!,
        executorAddress:     process.env.EXECUTOR_ADDRESS!,
        pmAddress:           ADDRESSES.UNI_V3_POSITION_MGR,
        smartAccountAddress: smartAcct,
        executionArgs:       depositArgs(preValueUSD ?? amountUSD),
      });

      const receiptHash = ethers.keccak256(ethers.toUtf8Bytes(`${userAddress}-HARVEST-${tokenId}-${Date.now()}`));
      const { txHash, receipt } = await this._redeemDelegation(cd);
      return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false };
    }

    
    
    const posMgr = new ethers.Contract(ADDRESSES.UNI_V3_POSITION_MGR, UNIV3_POS_READ_ABI, provider);
    const posData = await posMgr.positions(tokenId);
    const posToken0 = (posData.token0 ?? posData[2] as string).toLowerCase();
    const posToken1 = (posData.token1 ?? posData[3] as string).toLowerCase();
    const posFee = Number(posData.fee ?? posData[4]);

    
    const isUsdc0 = posToken0 === ADDRESSES.USDC.toLowerCase();
    const isUsdc1 = posToken1 === ADDRESSES.USDC.toLowerCase();

    if (!isUsdc0 && !isUsdc1) {
      
      
      const token0Addr = ethers.getAddress(posToken0);
      const token1Addr = ethers.getAddress(posToken1);
      await this._approveIfNeeded(token0Addr, ADDRESSES.SWAP_ROUTER02, ethers.MaxUint256);
      await this._approveIfNeeded(token1Addr, ADDRESSES.SWAP_ROUTER02, ethers.MaxUint256);

      const collectCalldata0 = UNIV3_POSITION_IFACE.encodeFunctionData('collect', [{
        tokenId, recipient: this.vaultAddress,
        amount0Max: MAX_UINT128, amount1Max: MAX_UINT128,
      }]);
      const est0 = BigInt(Math.floor((amountUSD / 2) / ethPriceUSD * 1e18));
      const est1 = BigInt(Math.floor((amountUSD / 2) / ethPriceUSD * 1e18));
      const swap0 = SWAP_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [{
        tokenIn: token0Addr, tokenOut: ADDRESSES.USDC, fee: posFee,
        recipient: this.vaultAddress, amountIn: est0,
        amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
      }]);
      const swap1 = SWAP_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [{
        tokenIn: token1Addr, tokenOut: ADDRESSES.USDC, fee: posFee,
        recipient: this.vaultAddress, amountIn: est1,
        amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
      }]);

      const receiptHash = this._buildReceiptHash(
        { strategyType: 'DELTA_NEUTRAL', asset: ADDRESSES.USDC, amount: 0n, amountUSD, userAddress, marketAddress: ADDRESSES.UNI_V3_POSITION_MGR },
        'HARVEST',
      );
      const { txHash, receipt } = await this._submitVaultTx('executeHarvest', [
        userAddress, ADDRESSES.USDC,
        [ADDRESSES.UNI_V3_POSITION_MGR, ADDRESSES.SWAP_ROUTER02, ADDRESSES.SWAP_ROUTER02],
        [collectCalldata0, swap0, swap1],
        receiptHash,
      ]);
      this._recordOnZG(userAddress, receiptHash, 'HARVEST', amountUSD);
      return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false };
    }

    const volatileAddr = ethers.getAddress(isUsdc1 ? posToken0 : posToken1);
    const decVolatile = TOKEN_DECIMALS[volatileAddr.toLowerCase()] ?? 18;

    
    
    const vaultContract = new ethers.Contract(
      this.vaultAddress,
      ['function balances(address user, address asset) view returns (uint256)'],
      provider,
    );
    const volBefore = await vaultContract.balances(userAddress, volatileAddr).catch(() => 0n) as bigint;

    
    const estimatedVolFees = BigInt(
      Math.floor((amountUSD / 2) / ethPriceUSD * Math.pow(10, decVolatile))
    );
    const dustThreshold = BigInt(Math.floor(1 / ethPriceUSD * Math.pow(10, decVolatile)));  
    const willHaveVol = estimatedVolFees > dustThreshold;

    
    const collectCalldata = UNIV3_POSITION_IFACE.encodeFunctionData('collect', [{
      tokenId, recipient: this.vaultAddress,
      amount0Max: MAX_UINT128, amount1Max: MAX_UINT128,
    }]);

    if (!willHaveVol) {
      
      const receiptHash = this._buildReceiptHash(
        { strategyType: 'DELTA_NEUTRAL', asset: ADDRESSES.USDC, amount: 0n, amountUSD, userAddress, marketAddress: ADDRESSES.UNI_V3_POSITION_MGR },
        'HARVEST',
      );
      const { txHash, receipt } = await this._submitVaultTx('executeHarvest', [
        userAddress, ADDRESSES.USDC,
        [ADDRESSES.UNI_V3_POSITION_MGR], [collectCalldata], receiptHash,
      ]);
      this._recordOnZG(userAddress, receiptHash, 'HARVEST', amountUSD);
      return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false };
    }

    
    await this._approveIfNeeded(volatileAddr, ADDRESSES.SWAP_ROUTER02, ethers.MaxUint256);

    
    
    
    
    const swapAmountIn = estimatedVolFees;  
    const minUSDCOut = BigInt(Math.floor(
      Number(swapAmountIn) / Math.pow(10, decVolatile) * ethPriceUSD * 0.995 * 1e6
    ));

    
    if (swapAmountIn <= dustThreshold) {
      const receiptHash = this._buildReceiptHash(
        { strategyType: 'DELTA_NEUTRAL', asset: ADDRESSES.USDC, amount: 0n, amountUSD, userAddress, marketAddress: ADDRESSES.UNI_V3_POSITION_MGR },
        'HARVEST',
      );
      const { txHash, receipt } = await this._submitVaultTx('executeHarvest', [
        userAddress, ADDRESSES.USDC,
        [ADDRESSES.UNI_V3_POSITION_MGR], [collectCalldata], receiptHash,
      ]);
      this._recordOnZG(userAddress, receiptHash, 'HARVEST', amountUSD);
      return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false };
    }

    const swapCalldata = SWAP_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [{
      tokenIn: volatileAddr,
      tokenOut: ADDRESSES.USDC,
      fee: posFee,
      recipient: this.vaultAddress,
      amountIn: swapAmountIn,
      amountOutMinimum: minUSDCOut,
      sqrtPriceLimitX96: 0n,
    }]);

    
    
    const receiptHash = this._buildReceiptHash(
      { strategyType: 'DELTA_NEUTRAL', asset: ADDRESSES.USDC, amount: 0n, amountUSD, userAddress, marketAddress: ADDRESSES.UNI_V3_POSITION_MGR },
      'HARVEST',
    );
    const { txHash, receipt } = await this._submitVaultTx('executeHarvest', [
      userAddress, ADDRESSES.USDC,
      [ADDRESSES.UNI_V3_POSITION_MGR, ADDRESSES.SWAP_ROUTER02],
      [collectCalldata, swapCalldata],
      receiptHash,
    ]);
    this._recordOnZG(userAddress, receiptHash, 'HARVEST', amountUSD);
    return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false };
  }

  
  
  
  
  
  
  
  
  

  async collectLendingFee(params: {
    strategyType: 'AAVE_LENDING' | 'MORPHO_LENDING';
    userAddress:  string;
    marketAddress: string;   
    yieldUSD:     number;    
    maxFeeBps:    number;    
    treasury:     string;
    asset:        string;    
    assetDecimals: number;
  }): Promise<OnChainExecutionResult | null> {
    const { yieldUSD, maxFeeBps, treasury, asset, assetDecimals } = params;
    if (yieldUSD <= 0 || maxFeeBps <= 0) return null;

    const feeUSD       = yieldUSD * (maxFeeBps / 10_000) * 0.99;  
    const feeRaw       = BigInt(Math.floor(feeUSD * Math.pow(10, assetDecimals)));
    if (feeRaw === 0n) return null;

    const input: ExecutionInput = {
      strategyType: params.strategyType,
      asset,
      amount:       feeRaw,
      amountUSD:    feeUSD,
      userAddress:  params.userAddress,
      marketAddress: params.marketAddress,
    };
    const receiptHash = this._buildReceiptHash(input, 'HARVEST');

    if (params.strategyType === 'AAVE_LENDING') {
      const withdrawCalldata = AAVE_IFACE.encodeFunctionData('withdraw', [asset, feeRaw, treasury]);
      const { txHash, receipt } = await this._submitVaultTx('execute', [
        params.marketAddress, withdrawCalldata, 0n,
      ]);
      this._recordOnZG(params.userAddress, receiptHash, 'HARVEST', feeUSD);
      return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false };
    }

    if (params.strategyType === 'MORPHO_LENDING') {
      const MORPHO_IFACE = new ethers.Interface(['function withdraw(uint256 assets, address receiver, address owner) returns (uint256)']);
      const withdrawCalldata = MORPHO_IFACE.encodeFunctionData('withdraw', [feeRaw, treasury, this.vaultAddress]);
      const { txHash, receipt } = await this._submitVaultTx('execute', [
        params.marketAddress, withdrawCalldata, 0n,
      ]);
      this._recordOnZG(params.userAddress, receiptHash, 'HARVEST', feeUSD);
      return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false };
    }

    return null;
  }

  
  
  
  
  
  
  
  
  
  
  
  
  

  async rebalanceUniV3Position(params: {
    tokenId: bigint;
    userAddress: string;
    poolAddress: string;
    rangePct: number;
    liquidity: bigint;
    feesPendingUSD: number;
    amountUSD: number;
    assertedAPY: number;
    tokenPrices: Map<string, { priceUSD: number }>;
    userId?: string;
    recipientAddress?: string;
  }): Promise<OnChainExecutionResult & { _receipt?: ethers.TransactionReceipt }> {
    const { tokenId, userAddress, poolAddress, rangePct, liquidity, feesPendingUSD, amountUSD, assertedAPY, tokenPrices, userId, recipientAddress } = params;

    
    
    
    
    
    
    if (userId && this.delegClient?.hasDelegation(userId)) {
      if (!recipientAddress) throw new Error('[V2 Rebalance] recipientAddress (smart account) required');
      const provider2 = this.wallet.provider as ethers.JsonRpcProvider;

      
      const ps = await readPoolState(provider2, poolAddress);
      const usdcLower = ADDRESSES.USDC.toLowerCase();
      const isUsdcPair = ps.token0.toLowerCase() === usdcLower || ps.token1.toLowerCase() === usdcLower;

      const closeInput: ExecutionInput = {
        strategyType: 'DELTA_NEUTRAL', asset: ADDRESSES.USDC,
        amount: BigInt(Math.round(amountUSD * 1e6)), amountUSD,
        userAddress, marketAddress: poolAddress,
        tokenId, liquidity,
        userId, recipientAddress, portfolioValueUSD: amountUSD,
      };
      await this._executeDeltaNeutralClose(closeInput);

      
      
      
      
      const erc20ABI = ['function balanceOf(address) view returns (uint256)'];
      const [t0Bal, t1Bal] = await Promise.all([
        (new ethers.Contract(ps.token0, erc20ABI, provider2).balanceOf(recipientAddress) as Promise<bigint>),
        (new ethers.Contract(ps.token1, erc20ABI, provider2).balanceOf(recipientAddress) as Promise<bigint>),
      ]);

      const tokensToNormalize = [];
      if (t0Bal > 0n && ps.token0.toLowerCase() !== usdcLower) {
        const route = await resolveSwapRoute(ps.token0, provider2);
        if (route) tokensToNormalize.push({ address: ps.token0, amount: t0Bal, route });
      }
      if (t1Bal > 0n && ps.token1.toLowerCase() !== usdcLower) {
        const route = await resolveSwapRoute(ps.token1, provider2);
        if (route) tokensToNormalize.push({ address: ps.token1, amount: t1Bal, route });
      }

      if (tokensToNormalize.length > 0) {
        const swapperAddr = process.env.SWAPPER_ADDRESS!;
        const normTokens = await Promise.all(tokensToNormalize.map(async (t) => {
          const quoted = await quoteSwapToUSDC(t.route, t.amount, provider2);
          const minOut = quoted > 0n ? (quoted * 99n) / 100n : 0n; 
          const dexCd = t.route.singleHop
            ? SWAP_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [{
              tokenIn: ethers.getAddress(t.address), tokenOut: ADDRESSES.USDC, fee: t.route.fee,
              recipient: swapperAddr, amountIn: t.amount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
            }])
            : SWAP_ROUTER02_IFACE.encodeFunctionData('exactInput', [{
              path: reverseUniswapPath(t.route.path!), recipient: swapperAddr, amountIn: t.amount, amountOutMinimum: minOut,
            }]);
          return { address: ethers.getAddress(t.address), amount: t.amount, dexAddress: ADDRESSES.SWAP_ROUTER02, dexCalldata: dexCd, minOut };
        }));

        const normCd = this.delegClient.buildNormalizeCalldata({
          userId,
          swapperAddress: swapperAddr,
          tokens: normTokens,
          usdcAddress: ADDRESSES.USDC,
          recipient: recipientAddress,
          executionArgs: rebalanceArgs(amountUSD),
        });
        await this._redeemDelegation(normCd);
      }

      
      
      
      
      const erc20 = new ethers.Contract(ADDRESSES.USDC, ['function balanceOf(address) view returns (uint256)'], provider2);
      const usdcBal: bigint = await erc20.balanceOf(recipientAddress);
      if (usdcBal === 0n) throw new Error('[V2 Rebalance] No USDC in smart account after close — cannot re-enter');

      const allocatedBig = BigInt(Math.round(amountUSD * 1e6));
      const reenterAmount = usdcBal < allocatedBig ? usdcBal : allocatedBig;
      const reenterUSD = Number(reenterAmount) / 1e6;
      const reenterInput: ExecutionInput = {
        strategyType: 'DELTA_NEUTRAL', asset: ADDRESSES.USDC,
        amount: reenterAmount, amountUSD: reenterUSD,
        userAddress, marketAddress: poolAddress,
        rangePct, assertedAPY, tokenPrices,
        userId, recipientAddress, portfolioValueUSD: reenterUSD,
      };
      return this._executeDeltaNeutralDeposit(reenterInput);
    }

    const provider = this.wallet.provider as ethers.JsonRpcProvider;
    const poolState = await readPoolState(provider, poolAddress);
    const { token0, token1 } = poolState;
    const ethPrice = tokenPrices.get('WETH')?.priceUSD ?? 3000;

    
    
    

    const posMgr = new ethers.Contract(
      ADDRESSES.UNI_V3_POSITION_MGR,
      ['function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'],
      provider,
    );
    const vaultRead = new ethers.Contract(
      this.vaultAddress,
      ['function balances(address,address) view returns (uint256)'],
      provider,
    );
    const readVaultBal = (addr: string): Promise<bigint> =>
      vaultRead.balances(userAddress, addr).catch(() => 0n) as Promise<bigint>;

    
    let liveLiquidity = liquidity;
    try {
      const pos = await posMgr.positions(tokenId);
      liveLiquidity = BigInt(pos[7] ?? pos.liquidity ?? liquidity);
    } catch {  }

    
    if (liveLiquidity > 0n && feesPendingUSD > 1) {
      await this.collectUniV3Fees(tokenId, userAddress, feesPendingUSD, ethPrice, userId, recipientAddress).catch(e =>
        console.warn('[Rebalance] Fee collect skipped:', e.message),
      );
    }

    
    if (liveLiquidity > 0n) {
      const closeInput: ExecutionInput = {
        strategyType: 'DELTA_NEUTRAL', asset: ADDRESSES.USDC,
        amount: BigInt(Math.round(amountUSD * 1e6)), amountUSD,
        userAddress, marketAddress: poolAddress, tokenId, liquidity: liveLiquidity,
        userId, recipientAddress, portfolioValueUSD: amountUSD,
      };
      await this._executeDeltaNeutralClose(closeInput);
    }

    
    
    const [bal0, bal1, usdcBal] = await Promise.all([
      readVaultBal(token0),
      readVaultBal(token1),
      readVaultBal(ADDRESSES.USDC),
    ]);

    if (bal0 > 0n || bal1 > 0n) {
      
      return this._executeDeltaNeutralRemint({ userAddress, poolAddress, poolState, rangePct, assertedAPY, tokenPrices });
    }

    if (usdcBal > 0n) {
      
      
      console.log(`[Rebalance] USDC-only recovery: ${ethers.formatUnits(usdcBal, 6)} USDC idle → re-entering pool`);
      const depositInput: ExecutionInput = {
        strategyType: 'DELTA_NEUTRAL', asset: ADDRESSES.USDC,
        amount: usdcBal, amountUSD: Number(usdcBal) / 1e6,
        userAddress, marketAddress: poolAddress, assertedAPY, rangePct, tokenPrices,
      };
      return this._executeDeltaNeutralDeposit(depositInput);
    }

    
    
    throw new Error(
      '[Rebalance] All vault balances are 0 after close — position appears fully withdrawn. Re-deposit to re-enter.',
    );
  }

  
  
  
  
  

  private async _executeDeltaNeutralRemint(params: {
    userAddress: string;
    poolAddress: string;
    poolState: Awaited<ReturnType<typeof readPoolState>>;
    rangePct: number;
    assertedAPY: number;
    tokenPrices: Map<string, { priceUSD: number }>;
  }): Promise<OnChainExecutionResult & { _receipt?: ethers.TransactionReceipt }> {
    const { userAddress, poolAddress, poolState, rangePct, assertedAPY, tokenPrices } = params;
    const { token0, token1, fee, spacing, currentTick } = poolState;
    const provider = this.wallet.provider as ethers.JsonRpcProvider;

    const token0Addr = ethers.getAddress(token0);
    const token1Addr = ethers.getAddress(token1);

    
    
    
    const vaultRead = new ethers.Contract(this.vaultAddress, ['function balances(address user, address asset) view returns (uint256)'], provider);
    const readBal = async (addr: string): Promise<bigint> =>
      vaultRead.balances(userAddress, addr).catch(() => 0n) as Promise<bigint>;
    const [bal0, bal1] = await Promise.all([readBal(token0), readBal(token1)]);

    if (bal0 === 0n && bal1 === 0n) {
      
      
      throw new Error('[Remint] Both vault token balances are 0 — use rebalanceUniV3Position which handles all balance states');
    }

    
    await Promise.all([
      bal0 > 0n ? this._approveIfNeeded(token0Addr, ADDRESSES.UNI_V3_POSITION_MGR, bal0) : Promise.resolve(),
      bal1 > 0n ? this._approveIfNeeded(token1Addr, ADDRESSES.UNI_V3_POSITION_MGR, bal1) : Promise.resolve(),
    ]);

    
    const { tickLower, tickUpper } = rangePctToTicks(currentTick, rangePct, spacing);

    const mintCalldata = UNIV3_POSITION_IFACE.encodeFunctionData('mint', [{
      token0: token0Addr,
      token1: token1Addr,
      fee,
      tickLower, tickUpper,
      amount0Desired: bal0,
      amount1Desired: bal1,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: this.vaultAddress,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    }]);

    const fakeInput: ExecutionInput = {
      strategyType: 'DELTA_NEUTRAL', asset: ADDRESSES.USDC,
      amount: 0n, amountUSD: Number(bal0 + bal1) / 1e6,
      userAddress, marketAddress: poolAddress,
      assertedAPY, rangePct, tokenPrices,
    };
    const receiptHash = this._buildReceiptHash(fakeInput, 'REBALANCE');

    
    
    const { txHash, receipt } = await this._submitVaultTx('executeBatchMulti', [
      userAddress,
      [token0Addr, token1Addr],
      [ADDRESSES.UNI_V3_POSITION_MGR],
      [mintCalldata],
      receiptHash,
    ]);
    this._recordOnZG(userAddress, receiptHash, 'REBALANCE', fakeInput.amountUSD);

    const result: OnChainExecutionResult & { _receipt?: ethers.TransactionReceipt } = {
      txHash, receiptHash, gasUsed: Number(receipt.gasUsed),
      success: receipt.status === 1, simulated: false, _receipt: receipt,
    };

    if (result.success) {
      const parsed = parseUniV3MintFromReceipt(receipt);
      if (parsed) {
        result.uniV3TokenId = parsed.tokenId;
        result.uniV3Liquidity = parsed.liquidity;
        result.uniV3TickLower = tickLower;
        result.uniV3TickUpper = tickUpper;
        result.uniV3CenterTick = Math.floor((tickLower + tickUpper) / 2);
        result.uniV3RangePct = rangePct;
        result.uniV3EntryPool = poolAddress;
      }
    }
    return result;
  }

  
  
  async initGMX(): Promise<void> {
    if (this.gmxInitialized) return;
    const calldata = '0x38c74dd9' + ADDRESSES.GMX_EXCHANGE_ROUTER.slice(2).padStart(64, '0');
    await this._submitVaultTx('vaultSetup', [ADDRESSES.GMX_ROUTER, calldata]);
    this.gmxInitialized = true;
    console.log('[Executor] GMX plugin approved');
  }

  static supportsOnChain(_strategyType: StrategyType): boolean { return true; }

  async deployedBalance(userAddress: string, asset: string): Promise<bigint> {
    return await this.vault.deployed(userAddress, asset) as bigint;
  }

  async idleBalance(userAddress: string, asset: string): Promise<bigint> {
    return await this.vault.balances(userAddress, asset) as bigint;
  }

  
  async smartAccountBalance(smartAccountAddress: string, asset: string): Promise<bigint> {
    const erc20 = new ethers.Contract(
      asset,
      ['function balanceOf(address) view returns (uint256)'],
      (this.wallet as ethers.Wallet).provider!,
    );
    return erc20.balanceOf(smartAccountAddress) as Promise<bigint>;
  }

  
  async findV2TokenId(smartAccountAddress: string, poolAddress: string): Promise<bigint | undefined> {
    const provider = this.wallet.provider as ethers.JsonRpcProvider;
    const pm = new ethers.Contract(ADDRESSES.UNI_V3_POSITION_MGR, UNIV3_POS_READ_ABI, provider);
    try {
      const poolState = await readPoolState(provider, poolAddress);
      const t0 = ethers.getAddress(poolState.token0).toLowerCase();
      const t1 = ethers.getAddress(poolState.token1).toLowerCase();
      const fee = poolState.fee;
      const balance = Number(await pm.balanceOf(smartAccountAddress));

      
      
      const matches: Array<{ tokenId: bigint; liquidity: bigint }> = [];
      for (let i = 0; i < balance; i++) {
        const tokenId: bigint = await pm.tokenOfOwnerByIndex(smartAccountAddress, i);
        const pos = await pm.positions(tokenId);
        const pToken0 = (pos.token0 ?? pos[2] as string).toLowerCase();
        const pToken1 = (pos.token1 ?? pos[3] as string).toLowerCase();
        const pFee = Number(pos.fee ?? pos[4]);
        if (pToken0 === t0 && pToken1 === t1 && pFee === fee) {
          matches.push({ tokenId, liquidity: BigInt(pos.liquidity ?? pos[7] ?? 0n) });
        }
      }

      if (matches.length === 0) return undefined;
      
      matches.sort((a, b) => {
        if (a.liquidity > 0n && b.liquidity === 0n) return -1;
        if (b.liquidity > 0n && a.liquidity === 0n) return 1;
        return a.tokenId > b.tokenId ? -1 : 1; 
      });
      return matches[0].tokenId;
    } catch {  }
    return undefined;
  }

  async prepareWithdrawal(input: ExecutionInput): Promise<PreparedWithdrawalResult> {
    if (input.strategyType !== 'DELTA_NEUTRAL') {
      const close = await this.withdraw(input);
      return {
        close,
        idleUSDC: await this.idleBalance(input.userAddress, ADDRESSES.USDC),
        tokenBalances: [],
      };
    }

    const provider = this.wallet.provider as ethers.JsonRpcProvider;
    const poolState = await readPoolState(provider, input.marketAddress);

    const close = await this._executeDeltaNeutralClose(input);

    
    if (input.userId && this.delegClient?.hasDelegation(input.userId) && input.recipientAddress) {
      const erc20ABI = ['function balanceOf(address) view returns (uint256)'];
      const usdcLower = ADDRESSES.USDC.toLowerCase();
      
      
      const [t0Bal, t1Bal, usdcFromClose] = await Promise.all([
        (new ethers.Contract(poolState.token0, erc20ABI, provider).balanceOf(input.recipientAddress) as Promise<bigint>),
        (new ethers.Contract(poolState.token1, erc20ABI, provider).balanceOf(input.recipientAddress) as Promise<bigint>),
        (new ethers.Contract(ADDRESSES.USDC, erc20ABI, provider).balanceOf(input.recipientAddress) as Promise<bigint>),
      ]);

      const tokensToNormalize = [];
      if (t0Bal > 0n && poolState.token0.toLowerCase() !== usdcLower) {
        const route = await resolveSwapRoute(poolState.token0, provider);
        if (route) tokensToNormalize.push({ address: poolState.token0, amount: t0Bal, route });
      }
      if (t1Bal > 0n && poolState.token1.toLowerCase() !== usdcLower) {
        const route = await resolveSwapRoute(poolState.token1, provider);
        if (route) tokensToNormalize.push({ address: poolState.token1, amount: t1Bal, route });
      }

      let normalize: OnChainExecutionResult | undefined;
      
      
      const hasUsdcFromClose = usdcFromClose > 0n;
      if (tokensToNormalize.length > 0 || hasUsdcFromClose) {
        const swapperAddr = process.env.SWAPPER_ADDRESS!;
        const portfolioUSD = input.portfolioValueUSD ?? input.amountUSD;
        const normTokens = await Promise.all(tokensToNormalize.map(async (t) => {
          const route = t.route;
          const quoted = await quoteSwapToUSDC(route, t.amount, provider);
          const minOut = quoted > 0n ? (quoted * 98n) / 100n : 0n;
          const dexCd = route.singleHop
            ? SWAP_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [{ tokenIn: ethers.getAddress(t.address), tokenOut: ADDRESSES.USDC, fee: route.fee, recipient: swapperAddr, amountIn: t.amount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }])
            : SWAP_ROUTER02_IFACE.encodeFunctionData('exactInput', [{ path: reverseUniswapPath(route.path!), recipient: swapperAddr, amountIn: t.amount, amountOutMinimum: minOut }]);
          return { address: ethers.getAddress(t.address), amount: t.amount, dexAddress: ADDRESSES.SWAP_ROUTER02, dexCalldata: dexCd, minOut };
        }));

        
        
        
        const normCd = this.delegClient.buildNormalizeCalldata({
          userId: input.userId,
          swapperAddress: swapperAddr,
          tokens: normTokens,
          usdcAddress: ADDRESSES.USDC,
          recipient: input.userAddress,
          executionArgs: rebalanceArgs(portfolioUSD),
          usdcSweepAmount: hasUsdcFromClose ? usdcFromClose : undefined,
        });
        const receiptHash = this._buildReceiptHash(input, 'WITHDRAW');

        
        
        const normResult = await this._redeemDelegation(normCd);
        normalize = { txHash: normResult.txHash, receiptHash, gasUsed: Number(normResult.receipt.gasUsed), success: normResult.receipt.status === 1, simulated: false };
      }

      
      const usdcBal = await (new ethers.Contract(ADDRESSES.USDC, erc20ABI, provider).balanceOf(input.userAddress) as Promise<bigint>);
      return {
        close,
        normalize,
        idleUSDC: usdcBal,
        tokenBalances: [],
      };
    }

    
    const trackedAssets = [ethers.getAddress(poolState.token0), ethers.getAddress(poolState.token1)];

    const before = await Promise.all(
      trackedAssets.map(asset => this.idleBalance(input.userAddress, asset)),
    );
    const afterClose = await Promise.all(
      trackedAssets.map(asset => this.idleBalance(input.userAddress, asset)),
    );
    const tokenBalances = trackedAssets.map((asset, i) => ({
      asset,
      before: before[i],
      after: afterClose[i],
      delta: afterClose[i] > before[i] ? afterClose[i] - before[i] : 0n,
    }));

    const normalize = await this._executeDeltaNeutralNormalizeTracked(input, poolState, tokenBalances);

    return {
      close,
      normalize,
      idleUSDC: await this.idleBalance(input.userAddress, ADDRESSES.USDC),
      tokenBalances,
    };
  }

  

  
  
  
  
  
  
  
  
  
  
  
  

  private async _executeDeltaNeutralDeposit(
    input: ExecutionInput,
  ): Promise<OnChainExecutionResult & { _receipt?: ethers.TransactionReceipt }> {
    const poolAddress = input.marketAddress;
    const provider = this.wallet.provider as ethers.JsonRpcProvider;

    
    
    const poolState = await readPoolState(provider, poolAddress);
    const { token0, token1, fee, spacing, currentTick,
      isUsdc0, isUsdc1, volatileToken, decVolatile, sqrtPriceX96 } = poolState;

    
    const { tickLower, tickUpper } = rangePctToTicks(currentTick, input.rangePct ?? 10, spacing);

    const prices = input.tokenPrices ?? new Map<string, { priceUSD: number }>();
    const halfAmount = input.amount / 2n;

    debugUniV3('deposit:start', {
      user: input.userAddress,
      poolAddress,
      amountUSDC: ethers.formatUnits(input.amount, 6),
      amountRaw: input.amount,
      rangePct: input.rangePct ?? 10,
      token0,
      token1,
      fee,
      spacing,
      currentTick,
      tickLower,
      tickUpper,
      isUsdc0,
      isUsdc1,
      volatileToken,
      decVolatile,
      sqrtPriceX96,
    });

    
    
    
    
    
    
    
    
    const batchTargets: string[] = [];
    const batchCalldata: string[] = [];

    let amount0ForMint: bigint;
    let amount1ForMint: bigint;

    if (isUsdc0 || isUsdc1) {
      
      const usdcForLP = input.amount - halfAmount;
      const volatileAddr = ethers.getAddress(volatileToken);

      
      
      const swapRoute = await resolveSwapRoute(volatileToken, provider);
      if (!swapRoute) {
        throw new Error(
          `No swap route from USDC to volatile token ${volatileToken} in pool ${poolAddress}. ` +
          `This pool should have been excluded by the screener.`,
        );
      }

      
      const quotedVolatile = await safeQuoteOrFallback(swapRoute, halfAmount, provider, prices);
      const minOut = quotedVolatile > 0n ? (quotedVolatile * 99n) / 100n : 0n;
      const volatileForMint = minOut;

      debugUniV3('deposit:usdc-pair-amounts', {
        usdcForSwap: ethers.formatUnits(halfAmount, 6),
        usdcForLP: ethers.formatUnits(usdcForLP, 6),
        volatileAddr,
        quotedVolatile: quotedVolatile.toString(),
        minOut: minOut.toString(),
        volatileForMint: volatileForMint.toString(),
        route: { singleHop: swapRoute.singleHop, fee: swapRoute.fee },
      });

      
      if (input.userId && this.delegClient?.hasDelegation(input.userId)) {
        const swapperAddr = process.env.SWAPPER_ADDRESS!;
        const smartAcct = input.recipientAddress!;
        
        const dexCd = swapRoute.singleHop
          ? SWAP_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [{
            tokenIn: ADDRESSES.USDC, tokenOut: volatileAddr, fee: swapRoute.fee,
            recipient: swapperAddr, amountIn: halfAmount,
            amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
          }])
          : SWAP_ROUTER02_IFACE.encodeFunctionData('exactInput', [{
            path: swapRoute.path!, recipient: swapperAddr,
            amountIn: halfAmount, amountOutMinimum: minOut,
          }]);
        
        const [a0Desired, a1Desired] = isUsdc1
          ? [volatileForMint, usdcForLP]
          : [usdcForLP, volatileForMint];
        const mintCd = UNIV3_POSITION_IFACE.encodeFunctionData('mint', [{
          token0: ethers.getAddress(token0), token1: ethers.getAddress(token1), fee,
          tickLower, tickUpper,
          amount0Desired: a0Desired, amount1Desired: a1Desired,
          amount0Min: 0n, amount1Min: 0n,
          recipient: smartAcct,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
        }]);
        const receiptHash = this._buildReceiptHash(input, 'GENESIS');
        const redeemCd = this.delegClient.buildDeltaNeutralUsdcPairCalldata({
          userId: input.userId,
          swapperAddress: swapperAddr,
          dex: ADDRESSES.SWAP_ROUTER02,
          swapCalldata: dexCd,
          token0: volatileAddr,
          token0MinOut: minOut,
          usdcAddress: ADDRESSES.USDC,
          usdcAmount: usdcForLP,
          usdcSwapIn: halfAmount,
          protocolAddress: ADDRESSES.UNI_V3_POSITION_MGR,
          mintCalldata: mintCd,
          executionArgs: depositArgs(input.portfolioValueUSD ?? input.amountUSD),
        });
        const { txHash, receipt } = await this._redeemDelegation(redeemCd);
        this._recordOnZG(input.userAddress, receiptHash, 'GENESIS', input.amountUSD);
        const v2UsdcResult: OnChainExecutionResult & { _receipt?: ethers.TransactionReceipt } = {
          txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false, _receipt: receipt,
        };
        if (v2UsdcResult.success) {
          const parsed = parseUniV3MintFromReceipt(receipt);
          if (parsed) {
            v2UsdcResult.uniV3TokenId = parsed.tokenId;
            v2UsdcResult.uniV3Liquidity = parsed.liquidity;
            v2UsdcResult.uniV3TickLower = tickLower;
            v2UsdcResult.uniV3TickUpper = tickUpper;
            v2UsdcResult.uniV3CenterTick = Math.floor((tickLower + tickUpper) / 2);
            v2UsdcResult.uniV3RangePct = input.rangePct ?? 10;
            v2UsdcResult.uniV3EntryPool = poolAddress;
          }
        }
        return v2UsdcResult;
      }

      await this._approveIfNeeded(ADDRESSES.USDC, ADDRESSES.SWAP_ROUTER02, halfAmount);
      await this._approveIfNeeded(volatileAddr, ADDRESSES.UNI_V3_POSITION_MGR, ethers.MaxUint256);
      await this._approveIfNeeded(ADDRESSES.USDC, ADDRESSES.UNI_V3_POSITION_MGR, usdcForLP);

      batchTargets.push(ADDRESSES.SWAP_ROUTER02);
      batchCalldata.push(swapRoute.singleHop
        ? SWAP_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [{
          tokenIn: ADDRESSES.USDC, tokenOut: volatileAddr, fee: swapRoute.fee,
          recipient: this.vaultAddress, amountIn: halfAmount,
          amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
        }])
        : SWAP_ROUTER02_IFACE.encodeFunctionData('exactInput', [{
          path: swapRoute.path!,
          recipient: this.vaultAddress,
          amountIn: halfAmount,
          amountOutMinimum: minOut,
        }]),
      );

      [amount0ForMint, amount1ForMint] = isUsdc1
        ? [volatileForMint, usdcForLP]
        : [usdcForLP, volatileForMint];

    } else {
      
      
      const token0Addr = ethers.getAddress(token0);
      const token1Addr = ethers.getAddress(token1);

      
      const [swapRoute0, swapRoute1] = await Promise.all([
        resolveSwapRoute(token0, provider),
        resolveSwapRoute(token1, provider),
      ]);

      if (!swapRoute0) {
        throw new Error(
          `No swap route from USDC to token0=${token0} in pool ${poolAddress}. ` +
          `This pool should have been excluded by the screener.`,
        );
      }
      if (!swapRoute1) {
        throw new Error(
          `No swap route from USDC to token1=${token1} in pool ${poolAddress}. ` +
          `This pool should have been excluded by the screener.`,
        );
      }

      
      const [quoted0, quoted1] = await Promise.all([
        safeQuoteOrFallback(swapRoute0, halfAmount, provider, prices),
        safeQuoteOrFallback(swapRoute1, halfAmount, provider, prices),
      ]);
      const minOut0 = quoted0 > 0n ? (quoted0 * 99n) / 100n : 0n;
      const minOut1 = quoted1 > 0n ? (quoted1 * 99n) / 100n : 0n;

      debugUniV3('deposit:non-usdc-pair-amounts', {
        usdcPerLeg: ethers.formatUnits(halfAmount, 6),
        token0Addr,
        token1Addr,
        quoted0: quoted0.toString(),
        quoted1: quoted1.toString(),
        minOut0: minOut0.toString(),
        minOut1: minOut1.toString(),
        route0: { singleHop: swapRoute0.singleHop, fee: swapRoute0.fee },
        route1: { singleHop: swapRoute1.singleHop, fee: swapRoute1.fee },
      });

      
      if (input.userId && this.delegClient?.hasDelegation(input.userId)) {
        const swapperAddr = process.env.SWAPPER_ADDRESS!;
        const smartAcct = input.recipientAddress!;
        
        const dexCd0 = swapRoute0.singleHop
          ? SWAP_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [{
            tokenIn: ADDRESSES.USDC, tokenOut: token0Addr, fee: swapRoute0.fee,
            recipient: swapperAddr, amountIn: halfAmount,
            amountOutMinimum: minOut0, sqrtPriceLimitX96: 0n,
          }])
          : SWAP_ROUTER02_IFACE.encodeFunctionData('exactInput', [{
            path: swapRoute0.path!, recipient: swapperAddr,
            amountIn: halfAmount, amountOutMinimum: minOut0,
          }]);
        const dexCd1 = swapRoute1.singleHop
          ? SWAP_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [{
            tokenIn: ADDRESSES.USDC, tokenOut: token1Addr, fee: swapRoute1.fee,
            recipient: swapperAddr, amountIn: halfAmount,
            amountOutMinimum: minOut1, sqrtPriceLimitX96: 0n,
          }])
          : SWAP_ROUTER02_IFACE.encodeFunctionData('exactInput', [{
            path: swapRoute1.path!, recipient: swapperAddr,
            amountIn: halfAmount, amountOutMinimum: minOut1,
          }]);
        const amount0v2 = minOut0 > 0n ? (minOut0 * 99n) / 100n : 0n;
        const amount1v2 = minOut1 > 0n ? (minOut1 * 99n) / 100n : 0n;
        
        const mintCd = UNIV3_POSITION_IFACE.encodeFunctionData('mint', [{
          token0: token0Addr, token1: token1Addr, fee,
          tickLower, tickUpper,
          amount0Desired: amount0v2, amount1Desired: amount1v2,
          amount0Min: 0n, amount1Min: 0n,
          recipient: smartAcct,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
        }]);
        try {
          const receiptHash = this._buildReceiptHash(input, 'GENESIS');
          const redeemCd = this.delegClient.buildDeltaNeutralNonUsdcPairCalldata({
            userId: input.userId,
            swapperAddress: swapperAddr,
            dex0: ADDRESSES.SWAP_ROUTER02,
            swapCalldata0: dexCd0,
            token0: token0Addr,
            usdcForToken0: halfAmount,
            token0MinOut: minOut0,
            dex1: ADDRESSES.SWAP_ROUTER02,
            swapCalldata1: dexCd1,
            token1: token1Addr,
            usdcForToken1: halfAmount,
            token1MinOut: minOut1,
            usdcAddress: ADDRESSES.USDC,
            protocolAddress: ADDRESSES.UNI_V3_POSITION_MGR,
            mintCalldata: mintCd,
            executionArgs: depositArgs(input.portfolioValueUSD ?? input.amountUSD),
          });
          const { txHash, receipt } = await this._redeemDelegation(redeemCd);
          this._recordOnZG(input.userAddress, receiptHash, 'GENESIS', input.amountUSD);
          const v2NonUsdcResult: OnChainExecutionResult & { _receipt?: ethers.TransactionReceipt } = {
            txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false, _receipt: receipt,
          };
          if (v2NonUsdcResult.success) {
            const parsed = parseUniV3MintFromReceipt(receipt);
            if (parsed) {
              v2NonUsdcResult.uniV3TokenId = parsed.tokenId;
              v2NonUsdcResult.uniV3Liquidity = parsed.liquidity;
              v2NonUsdcResult.uniV3TickLower = tickLower;
              v2NonUsdcResult.uniV3TickUpper = tickUpper;
              v2NonUsdcResult.uniV3CenterTick = Math.floor((tickLower + tickUpper) / 2);
              v2NonUsdcResult.uniV3RangePct = input.rangePct ?? 10;
              v2NonUsdcResult.uniV3EntryPool = poolAddress;
            }
          }
          return v2NonUsdcResult;
        } catch (v2Err: any) {
          console.error('[V2] non-USDC FAILED:', v2Err?.message?.slice(0, 300));
          throw v2Err;
        }
      }

      await this._approveIfNeeded(ADDRESSES.USDC, ADDRESSES.SWAP_ROUTER02, input.amount);
      await this._approveIfNeeded(token0Addr, ADDRESSES.UNI_V3_POSITION_MGR, ethers.MaxUint256);
      await this._approveIfNeeded(token1Addr, ADDRESSES.UNI_V3_POSITION_MGR, ethers.MaxUint256);

      
      batchTargets.push(ADDRESSES.SWAP_ROUTER02);
      batchCalldata.push(swapRoute0.singleHop
        ? SWAP_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [{
          tokenIn: ADDRESSES.USDC, tokenOut: token0Addr, fee: swapRoute0.fee,
          recipient: this.vaultAddress, amountIn: halfAmount,
          amountOutMinimum: minOut0, sqrtPriceLimitX96: 0n,
        }])
        : SWAP_ROUTER02_IFACE.encodeFunctionData('exactInput', [{
          path: swapRoute0.path!, recipient: this.vaultAddress,
          amountIn: halfAmount, amountOutMinimum: minOut0,
        }]),
      );

      
      batchTargets.push(ADDRESSES.SWAP_ROUTER02);
      batchCalldata.push(swapRoute1.singleHop
        ? SWAP_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [{
          tokenIn: ADDRESSES.USDC, tokenOut: token1Addr, fee: swapRoute1.fee,
          recipient: this.vaultAddress, amountIn: halfAmount,
          amountOutMinimum: minOut1, sqrtPriceLimitX96: 0n,
        }])
        : SWAP_ROUTER02_IFACE.encodeFunctionData('exactInput', [{
          path: swapRoute1.path!, recipient: this.vaultAddress,
          amountIn: halfAmount, amountOutMinimum: minOut1,
        }]),
      );

      amount0ForMint = minOut0 > 0n ? (minOut0 * 99n) / 100n : 0n;
      amount1ForMint = minOut1 > 0n ? (minOut1 * 99n) / 100n : 0n;
    }

    
    const [t0cs, t1cs] = [ethers.getAddress(token0), ethers.getAddress(token1)];
    batchTargets.push(ADDRESSES.UNI_V3_POSITION_MGR);
    batchCalldata.push(UNIV3_POSITION_IFACE.encodeFunctionData('mint', [{
      token0: t0cs, token1: t1cs, fee,
      tickLower, tickUpper,
      amount0Desired: amount0ForMint,
      amount1Desired: amount1ForMint,
      amount0Min: 0n, amount1Min: 0n,
      recipient: this.vaultAddress,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    }]));
    debugUniV3('deposit:final-batch', {
      mint: {
        token0: t0cs,
        token1: t1cs,
        fee,
        tickLower,
        tickUpper,
        amount0ForMint,
        amount1ForMint,
      },
      batchTargets,
      batchCalldataSelectors: batchCalldata.map(data => data.slice(0, 10)),
    });

    const receiptHash = this._buildReceiptHash(input, 'GENESIS');
    let batchTxHash: string;
    let receipt: ethers.TransactionReceipt;
    try {
      ({ txHash: batchTxHash, receipt } = await this._submitVaultTx('executeBatch', [
        input.userAddress, ADDRESSES.USDC, batchTargets, batchCalldata, receiptHash,
      ]));
    } catch (err: any) {
      debugUniV3('deposit:executeBatch-failed', {
        message: err?.message,
        batchTargets,
        batchCalldataSelectors: batchCalldata.map(data => data.slice(0, 10)),
        amount0ForMint,
        amount1ForMint,
        inputAmount: input.amount,
        rangePct: input.rangePct ?? 10,
        tickLower,
        tickUpper,
      });
      throw err;
    }
    this._recordOnZG(input.userAddress, receiptHash, 'GENESIS', input.amountUSD);

    const result: OnChainExecutionResult & { _receipt?: ethers.TransactionReceipt } = {
      txHash: batchTxHash, receiptHash,
      gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false, _receipt: receipt,
    };

    if (result.success) {
      const parsed = parseUniV3MintFromReceipt(receipt);
      if (parsed) {
        result.uniV3TokenId = parsed.tokenId;
        result.uniV3Liquidity = parsed.liquidity;
        
        result.uniV3TickLower = tickLower;
        result.uniV3TickUpper = tickUpper;
        result.uniV3CenterTick = Math.floor((tickLower + tickUpper) / 2);
        result.uniV3RangePct = input.rangePct ?? 10;
        result.uniV3EntryPool = poolAddress;

        
        if (process.env.GMX_ENABLED === 'true') {
          const hedgeTokenAddr = (isUsdc0 || isUsdc1) ? volatileToken : token0;
          try {
            const hedgeSizeUSD = (input.amountUSD / 2) * 0.65;
            const hedgeCollateral = BigInt(Math.round(hedgeSizeUSD * 1e6));
            const hedgeResult = await this._openGMXShort(
              { ...input, marketAddress: ethers.getAddress(hedgeTokenAddr) },
              hedgeSizeUSD, hedgeCollateral,
            );
            result.gmxOrderKey = hedgeResult.txHash;
          } catch (err: any) {
            console.warn('[Executor] GMX hedge failed (position open, unhedged):', err.message);
          }
        }
      }
    }

    return result;
  }

  private async _executeLeveragedLoop(input: ExecutionInput): Promise<OnChainExecutionResult> {
    const { targets, dataArr } = buildLeveragedLoopBatch(input.asset, input.amount, this.vaultAddress, 3);
    await this._approveIfNeeded(input.asset, ADDRESSES.AAVE_POOL, input.amount * 4n);
    const receiptHash = this._buildReceiptHash(input, 'GENESIS');
    const { txHash, receipt } = await this._submitVaultTx('executeBatch', [
      input.userAddress, input.asset, targets, dataArr, receiptHash,
    ]);
    this._recordOnZG(input.userAddress, receiptHash, 'GENESIS', input.amountUSD);

    
    let entryLiquidityIndex: bigint | undefined;
    try {
      const aavePool = new ethers.Contract(ADDRESSES.AAVE_POOL, AAVE_POOL_READ_ABI, this.wallet.provider as ethers.JsonRpcProvider);
      entryLiquidityIndex = await aavePool.getReserveNormalizedIncome(ADDRESSES.USDC) as bigint;
    } catch {  }

    return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false, entryLiquidityIndex };
  }

  private async _openGMXShort(
    input: ExecutionInput,
    hedgeSizeUSD: number,
    collateral: bigint,
  ): Promise<OnChainExecutionResult> {
    await this._approveIfNeeded(ADDRESSES.USDC, ADDRESSES.GMX_ROUTER, collateral);
    
    
    const gmxHedgeMarket = getGMXHedgeMarket(input.asset + input.marketAddress);
    const multicallData = buildGMXOpenShortMulticall(
      this.vaultAddress, gmxHedgeMarket, collateral,
      hedgeSizeUSD, input.currentPrice ?? 3000,
    );
    const hedgeInput: ExecutionInput = {
      ...input,
      asset: ADDRESSES.USDC,
      amount: collateral,
      marketAddress: gmxHedgeMarket,
    };
    return this._fundedDeposit(ADDRESSES.GMX_EXCHANGE_ROUTER, multicallData, GMX_EXEC_FEE, 0n, 'REBALANCE', hedgeInput);
  }

  
  

  

  async reportValueOnChain(userAddress: string, currentValueUSD: number): Promise<void> {
    await this._submitVaultTx('reportValue', [
      userAddress, BigInt(Math.round(currentValueUSD * 1e6)),
    ]);
  }

  
  
  
  
  
  
  

  private async _submitVaultTx(
    functionName: string,
    args: readonly unknown[],
    value: bigint = 0n,
  ): Promise<{ txHash: string; receipt: ethers.TransactionReceipt }> {
    await this.pimlicoInit;

    const calldata = VAULT_IFACE.encodeFunctionData(functionName, args as any[]);

    
    if (this.pimlico) {
      const txHash = await this.pimlico.sendVaultCall(this.vaultAddress, calldata, value);
      const receipt = await this._awaitEthersReceipt(txHash);
      return { txHash, receipt };
    }

    
    const tx = await this.wallet.sendTransaction({ to: this.vaultAddress, data: calldata, value });
    const receipt = await tx.wait(1) as ethers.TransactionReceipt;
    return { txHash: tx.hash, receipt };
  }

  
  private async _awaitEthersReceipt(
    txHash: string,
    maxAttempts: number = 20,
  ): Promise<ethers.TransactionReceipt> {
    const provider = this.wallet.provider as ethers.JsonRpcProvider;

    
    
    try {
      const r = await provider.waitForTransaction(txHash, 1, 120_000); 
      if (r) return r as ethers.TransactionReceipt;
    } catch {
      
    }

    
    for (let i = 0; i < maxAttempts; i++) {
      const r = await provider.getTransactionReceipt(txHash);
      if (r) return r as ethers.TransactionReceipt;
      await new Promise(res => setTimeout(res, 3_000));  
    }
    throw new Error(`Receipt not found after ${maxAttempts} attempts: ${txHash}`);
  }

  private async _approveIfNeeded(asset: string, spender: string, amount: bigint): Promise<void> {
    await this._submitVaultTx('approveToken', [asset, spender, amount]);
  }

  
  
  
  

  private async _redeemDelegation(
    redeemCalldata: string,
  ): Promise<{ txHash: string; receipt: ethers.TransactionReceipt }> {
    await this.pimlicoInit;

    if (!this.delegClient) throw new Error('[V2] DelegationClient not initialised');

    const dmAddress = this.delegClient.dmAddress;

    
    try {
      const decoded = DM_IFACE.decodeFunctionData('redeemDelegations', redeemCalldata);
      const permCtx = decoded[0][0]; 
      const dTuple = ethers.AbiCoder.defaultAbiCoder().decode(['tuple(address,address,bytes32,tuple(address,bytes,bytes)[],uint256,bytes)[]'], permCtx)[0][0];
      const caveats = dTuple[3];
      const policyCaveat = caveats.find((c: any) => c[0].toLowerCase() === ADDRESSES.POLICY_ENFORCER.toLowerCase());
      if (policyCaveat && policyCaveat[2] !== '0x') {
        const args = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256', 'uint256'], policyCaveat[2]);
        console.log(`[DelegationDebug] 🛡️  Policy Check: pre=$${Number(args[0]) / 1e6} post=$${Number(args[1]) / 1e6} fee=$${Number(args[2]) / 1e6}`);
      }
    } catch (e) {  }

    
    if (this.pimlico) {
      const txHash = await this.pimlico.sendCall(dmAddress, redeemCalldata, 0n);
      const receipt = await this._awaitEthersReceipt(txHash);
      return { txHash, receipt };
    }

    
    const tx = await this.wallet.sendTransaction({ to: dmAddress, data: redeemCalldata });
    const receipt = await tx.wait(1) as ethers.TransactionReceipt;
    return { txHash: tx.hash, receipt };
  }

  

  private async _fundedDeposit(
    target: string,
    calldata: string,
    value: bigint,
    assertedAPY: bigint,
    action: string,
    input: ExecutionInput,
  ): Promise<OnChainExecutionResult & { _receipt?: ethers.TransactionReceipt }> {
    const receiptHash = this._buildReceiptHash(input, action);

    
    if (input.userId && this.delegClient?.hasDelegation(input.userId)) {
      const portfolioUSD = input.portfolioValueUSD ?? input.amountUSD;
      const redeemCd = this.delegClient.buildDepositCalldata({
        userId: input.userId,
        token: input.asset,
        tokenAmount: input.amount,
        protocolAddress: target,
        protocolCalldata: calldata,
        protocolValue: value,
        executionArgs: depositArgs(portfolioUSD),
      });
      const { txHash, receipt } = await this._redeemDelegation(redeemCd);
      this._recordOnZG(input.userAddress, receiptHash, action, input.amountUSD);
      return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false, _receipt: receipt };
    }

    
    const { txHash, receipt } = await this._submitVaultTx('executeDeposit', [
      input.userAddress, input.asset, input.amount, assertedAPY,
      target, calldata, receiptHash,
    ], value);
    this._recordOnZG(input.userAddress, receiptHash, action, input.amountUSD);
    return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false, _receipt: receipt };
  }

  

  private async _fundedWithdraw(
    target: string,
    calldata: string,
    value: bigint,
    action: string,
    input: ExecutionInput,
  ): Promise<OnChainExecutionResult & { _receipt?: ethers.TransactionReceipt }> {
    const receiptHash = this._buildReceiptHash(input, action);

    
    if (input.userId && this.delegClient?.hasDelegation(input.userId)) {
      const portfolioUSD = input.portfolioValueUSD ?? input.amountUSD;
      const redeemCd = this.delegClient.buildWithdrawCalldata({
        userId: input.userId,
        protocolAddress: target,
        protocolCalldata: calldata,
        protocolValue: value,
        
        
        executionArgs: rebalanceArgs(portfolioUSD),
      });
      const { txHash, receipt } = await this._redeemDelegation(redeemCd);
      this._recordOnZG(input.userAddress, receiptHash, action, input.amountUSD);
      return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false, _receipt: receipt };
    }

    
    const { txHash, receipt } = await this._submitVaultTx('executeWithdraw', [
      input.userAddress, input.asset, input.amount,
      target, calldata, receiptHash,
    ], value);
    this._recordOnZG(input.userAddress, receiptHash, action, input.amountUSD);
    return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false, _receipt: receipt };
  }

  

  private async _genericCall(
    target: string,
    calldata: string,
    value: bigint,
    action: string,
    input: ExecutionInput,
    guardAsset: string = input.asset,
  ): Promise<OnChainExecutionResult & { _receipt?: ethers.TransactionReceipt }> {
    const receiptHash = this._buildReceiptHash(input, action);

    
    if (input.userId && this.delegClient?.hasDelegation(input.userId)) {
      const portfolioUSD = input.portfolioValueUSD ?? input.amountUSD;
      const redeemCd = this.delegClient.buildGenericCalldata({
        userId: input.userId,
        protocolAddress: target,
        protocolCalldata: calldata,
        protocolValue: value,
        executionArgs: rebalanceArgs(portfolioUSD),
      });
      const { txHash, receipt } = await this._redeemDelegation(redeemCd);
      this._recordOnZG(input.userAddress, receiptHash, action, input.amountUSD);
      return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false, _receipt: receipt };
    }

    
    const { txHash, receipt } = await this._submitVaultTx('execute', [
      input.userAddress, target, calldata, receiptHash, guardAsset,
    ], value);
    this._recordOnZG(input.userAddress, receiptHash, action, input.amountUSD);
    return { txHash, receiptHash, gasUsed: Number(receipt.gasUsed), success: receipt.status === 1, simulated: false, _receipt: receipt };
  }

  private _buildReceiptHash(input: ExecutionInput, action: string): string {
    const meta = JSON.stringify({
      strategyType: input.strategyType, asset: input.asset,
      amount: input.amount.toString(), userAddress: input.userAddress, action, ts: Date.now(),
    });
    return '0x' + crypto.createHash('sha256').update(meta).digest('hex');
  }

  private _recordOnZG(user: string, receiptHash: string, action: string, amountUSD: number): void {
    if (!this.router) return;
    this.router.recordExecution(user, receiptHash, 42161n, action, BigInt(Math.round(amountUSD)))
      .catch((err: Error) => console.warn('[Executor] 0G audit:', err.message));
  }
}

let _executor: AgentExecutor | null = null;

export function getExecutor(): AgentExecutor | null {
  if (_executor) return _executor;
  const key = process.env.AGENT_PRIVATE_KEY;
  const rpc = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
  if (!key) return null;
  
  const vault = process.env.VAULT_ADDRESS ?? '0x0000000000000000000000000000000000000000';
  _executor = new AgentExecutor(key, vault, rpc, process.env.ZG_ROUTER_ADDRESS, 'https://evmrpc.0g.ai');
  return _executor;
}

export async function resolveAgentAddress(): Promise<string> {
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) throw new Error('AGENT_PRIVATE_KEY not set');

  if (process.env.PIMLICO_API_KEY) {
    const { initPimlicoIfConfigured: init } = await import('./erc4337');
    const rpc = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
    const layer = await init(key, rpc);
    if (layer) return layer.smartAccountAddress;
  }

  
  const wallet = new ethers.Wallet(key);
  return wallet.address;
}
