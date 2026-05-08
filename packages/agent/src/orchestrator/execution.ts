import { ethers }  from 'ethers';
import * as crypto from 'node:crypto';
import type { StrategyType } from './types';

// ── Vault ABI ─────────────────────────────────────────────────────────────────

// ── YieldGeko.sol ABI (single contract, deployed on every chain) ──────────────
const VAULT_ABI = [
  // Fund-moving — use these for protocol deposits/withdrawals (update balance tracking)
  'function executeDeposit(address user, address asset, uint256 amount, uint256 assertedAPY, address target, bytes calldata data, bytes32 receiptHash) external payable',
  'function executeWithdraw(address user, address asset, uint256 deployedAmount, address target, bytes calldata data, bytes32 receiptHash) external payable',
  'function executeWithdrawMulti(address user, address[] calldata assets, uint256[] calldata deployedAmounts, address target, bytes calldata data, bytes32 receiptHash) external payable returns (uint256[] memory)',
  'function executeBatch(address user, address asset, address[] calldata targets, bytes[] calldata dataArr, bytes32 receiptHash) external returns (bytes[] memory)',
  'function executeBatchMulti(address user, address[] calldata assets, address[] calldata targets, bytes[] calldata dataArr, bytes32 receiptHash) external returns (bytes[] memory)',
  // Generic — for non-fund-moving calls (harvest, collect, fee collection)
  // guardAsset: vault balance of this asset must not decrease post-call
  'function execute(address user, address target, bytes calldata data, bytes32 receiptHash, address guardAsset) external payable returns (bytes memory)',
  // Helpers
  'function approveToken(address asset, address spender, uint256 amount) external',
  'function collectFee(address asset, address user, uint256 grossAmount) external returns (uint256)',
  'function reportValue(address user, uint256 currentValueUSD) external',
  'function vaultSetup(address target, bytes calldata data) external',
  'function balances(address user, address asset) external view returns (uint256)',
  'function deployed(address user, address asset) external view returns (uint256)',
];

// ── 0G Router ABI ─────────────────────────────────────────────────────────────

const ROUTER_ABI = [
  'function recordExecution(address user, bytes32 receiptHash, uint256 chainId, string calldata action, uint256 amountUSD) external',
];

// ── Minimal read-only ABIs for on-chain state capture at deposit time ─────────

const AAVE_POOL_READ_ABI = [
  'function getReserveNormalizedIncome(address asset) view returns (uint256)',
];

// ERC20 Transfer event topic — used to parse minted share/LP amounts from receipt
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const ZERO_ADDRESS   = ethers.zeroPadValue('0x0000000000000000000000000000000000000000', 32);

/**
 * Parse the amount of tokens minted to `toAddress` in a tx receipt.
 * Looks for Transfer(address(0), toAddress, amount) events from `tokenAddress`.
 */
function parseMintedAmount(
  receipt:      ethers.TransactionReceipt,
  tokenAddress: string,
  toAddress:    string,
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

// ── Protocol addresses — Arbitrum mainnet ─────────────────────────────────────

export const ADDRESSES = {
  // Aave V3
  AAVE_POOL:               '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  // Pendle V2
  PENDLE_ROUTER:           '0x888888888889758F76e7103c6CbF23ABbF58F946',
  // GMX V2 — separate vaults for orders, deposits, and withdrawals
  GMX_EXCHANGE_ROUTER:     '0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41',
  GMX_ROUTER:              '0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6',
  GMX_ORDER_VAULT:         '0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5',
  GMX_DEPOSIT_VAULT:       '0xF89e77e8Dc11691C9e8757e84aaFbCD8A67d7A55',
  GMX_WITHDRAWAL_VAULT:    '0x0628D46b5D145f183AdB6Ef1f2c97eD1C4701C55',
  // Uniswap V3
  UNI_V3_POSITION_MGR:     '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  UNI_V3_FACTORY:          '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  // SwapRouter02 — no deadline field (uses block.timestamp internally)
  SWAP_ROUTER02:           '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  // Tokens
  USDC:                    '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  WETH:                    '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  WBTC:                    '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
  ARB:                     '0x912CE59144191C1204E64559FE8253a0e49E6548',
};

export const TOKEN_ADDRESSES: Record<string, string> = {
  USDC: ADDRESSES.USDC,
  WETH: ADDRESSES.WETH,
  WBTC: ADDRESSES.WBTC,
  ARB:  ADDRESSES.ARB,
};

// ── Uniswap V3 constants and helpers ─────────────────────────────────────────

const TICK_SPACINGS: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

// Tick offsets for ±10% price range — derived from: ticks = log(price) / log(1.0001)
// log₁.₀₀₀₁(0.9) = -1054 (down 10%)    log₁.₀₀₀₁(1.1) = +953 (up 10%)
// These are token-pair agnostic: UniV3 ticks encode price logarithmically for any pair.
const TICKS_10PCT_DOWN = -1054;
const TICKS_10PCT_UP   =  953;

// Token decimals for Arbitrum mainnet — used to adjust sqrtPriceX96 into human-readable price
const TOKEN_DECIMALS: Record<string, number> = {
  [ADDRESSES.USDC.toLowerCase()]: 6,
  [ADDRESSES.WETH.toLowerCase()]: 18,
  [ADDRESSES.WBTC.toLowerCase()]: 8,
  [ADDRESSES.ARB.toLowerCase()]:  18,
};

// Minimal ABI for reading UniV3 pool state
const UNIV3_POOL_READ_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
];

// Minimal ABI for reading a position's token0/token1 (used in fee normalizer)
const UNIV3_POS_READ_ABI = [
  `function positions(uint256 tokenId) view returns (
    uint96 nonce, address operator,
    address token0, address token1,
    uint24 fee, int24 tickLower, int24 tickUpper,
    uint128 liquidity,
    uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128,
    uint128 tokensOwed0, uint128 tokensOwed1
  )`,
];

/**
 * Read pool parameters from the Uniswap V3 pool contract.
 * Returns token0, token1 (sorted by address), fee tier, current tick,
 * and the amount of volatile tokens a given USDC input can buy.
 *
 * Invariant: on Arbitrum, USDC (0xaf...) is always token1 in any pool with
 * WETH (0x82...), WBTC (0x2f...), or ARB (0x91...) because USDC has the highest address.
 */
async function readPoolState(
  provider:    ethers.JsonRpcProvider,
  poolAddress: string,
): Promise<{
  token0:          string;
  token1:          string;
  fee:             number;
  spacing:         number;
  currentTick:     number;
  isUsdc0:         boolean;
  isUsdc1:         boolean;
  volatileToken:   string;
  decVolatile:     number;
  sqrtPriceX96:    bigint;
}> {
  const pool = new ethers.Contract(poolAddress, UNIV3_POOL_READ_ABI, provider);
  const [t0, t1, fee, slot0] = await Promise.all([
    pool.token0() as Promise<string>,
    pool.token1() as Promise<string>,
    pool.fee()    as Promise<bigint>,
    pool.slot0()  as Promise<{ sqrtPriceX96: bigint; tick: bigint }>,
  ]);

  const token0 = t0.toLowerCase();
  const token1 = t1.toLowerCase();
  const feeNum = Number(fee);
  const isUsdc0 = token0 === ADDRESSES.USDC.toLowerCase();
  const isUsdc1 = token1 === ADDRESSES.USDC.toLowerCase();

  // For non-USDC pairs (WETH-WBTC, WETH-ARB, etc.) volatileToken is set to token0 as a
  // sentinel — the deposit path handles both tokens symmetrically in that case.
  const volatileToken = isUsdc1 ? token0 : isUsdc0 ? token1 : token0;
  const decVolatile   = TOKEN_DECIMALS[volatileToken] ?? 18;
  const slot0Arr      = slot0 as unknown as bigint[];
  const currentTick   = Number(slot0Arr[1]);
  const sqrtPriceX96  = slot0Arr[0];

  return {
    token0, token1, fee: feeNum,
    spacing: TICK_SPACINGS[feeNum] ?? 60,
    currentTick, isUsdc0, isUsdc1,
    volatileToken, decVolatile,
    sqrtPriceX96,
  };
}

/**
 * Compute how many volatile tokens a USDC amount buys at the current pool price.
 * Uses the on-chain sqrtPriceX96 — exact for any token pair, no Chainlink dependency.
 *
 * Formula (USDC = token1 case, which covers all our supported pairs):
 *   price = (sqrtPriceX96 / 2^96)² × 10^(dec1 - dec0)  [USDC per volatile]
 *   volatile = usdcIn / price
 */
function estimateVolatileFromUSDC(
  usdcAmount: bigint,
  sqrtPriceX96: bigint,
  isUsdc1: boolean,
  decVolatile: number,
): { estimatedVolatile: bigint; minOut: bigint } {
  const Q96 = 2n ** 96n;
  const sqrtF = Number(sqrtPriceX96) / Number(Q96);
  const rawPrice = sqrtF * sqrtF;   // token1_raw / token0_raw

  let usdcPerVolatile: number;
  if (isUsdc1) {
    // token0 = volatile, token1 = USDC  → price = USDC_raw / volatile_raw
    // adjust for decimals: (USDC 6dec) / (volatile Ndec) → multiply by 10^(6 - N)
    usdcPerVolatile = rawPrice * Math.pow(10, 6 - decVolatile);
  } else {
    // token0 = USDC, token1 = volatile  → price = volatile_raw / USDC_raw
    // invert and adjust
    usdcPerVolatile = 1 / (rawPrice * Math.pow(10, decVolatile - 6));
  }

  // volatile = usdcIn_in_human / usdcPerVolatile_in_human  → in raw volatile units
  const estimatedVolatile = BigInt(
    Math.floor(Number(usdcAmount) / 1e6 / usdcPerVolatile * Math.pow(10, decVolatile))
  );
  const minOut = (estimatedVolatile * 995n) / 1000n;   // 0.5% slippage
  return { estimatedVolatile, minOut };
}

// Legacy helper kept for backward compatibility — new code uses readPoolState + TICKS constants
export function computeOptimalTickRange(
  _ethPriceUSD: number,
  feeTier: number = 3000,
): { tickLower: number; tickUpper: number } {
  // Callers should use currentTick from pool slot0 instead of deriving from price.
  // This overload keeps the signature compatible but the result is a placeholder;
  // _executeDeltaNeutralDeposit uses readPoolState for the authoritative tick.
  const spacing = TICK_SPACINGS[feeTier] ?? 60;
  return { tickLower: -Math.abs(TICKS_10PCT_DOWN) * spacing, tickUpper: TICKS_10PCT_UP * spacing };
}

// ── GMX execution fee (0.001 ETH — safely above minimum on Arbitrum) ──────────
const GMX_EXEC_FEE = BigInt(1e15);

// ── GMX perpetuals market addresses per base asset ───────────────────────────
// Delta-neutral: LP is on UniV3 (any pool), hedge short is on GMX perp market.
// These are different addresses — LP uses UniV3 pool, short uses GMX market.
const GMX_PERP_MARKETS: Record<string, string> = {
  WETH: '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336', // ETH/USD
  ETH:  '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336',
  WBTC: '0x47c031236e19d024b42f8AE6780E44A573170703', // BTC/USD
  BTC:  '0x47c031236e19d024b42f8AE6780E44A573170703',
  ARB:  '0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407', // ARB/USD
};

function getGMXHedgeMarket(assetOrPool: string): string {
  const upper = assetOrPool.toUpperCase();
  for (const [sym, addr] of Object.entries(GMX_PERP_MARKETS)) {
    if (upper.includes(sym)) return addr;
  }
  return GMX_PERP_MARKETS['WETH']; // default to ETH/USD
}

// ── Event topic hashes (used for receipt log parsing) ─────────────────────────
const TOPIC_INCREASE_LIQUIDITY = ethers.id('IncreaseLiquidity(uint256,uint128,uint256,uint256)');

// ── Protocol interfaces ───────────────────────────────────────────────────────

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

// SwapRouter02 — note: NO deadline field (uses block.timestamp internally, unlike V1)
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

  // Multi-hop swap — used when no direct USDC pool exists for the target token
  // path: abi.encodePacked(tokenIn, fee, tokenHop?, fee?, tokenOut)
  `function exactInput(
      tuple(
        bytes   path,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum
      ) params
   ) external payable returns (uint256 amountOut)`,
]);

/**
 * Encode a Uniswap V3 multi-hop path.
 * path = abi.encodePacked(token0, fee, token1 [, fee, token2 ...])
 * Each fee is uint24 (3 bytes), each address is 20 bytes.
 */
function encodeUniswapPath(tokens: string[], fees: number[]): string {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) {
    throw new Error('encodeUniswapPath: tokens.length must be fees.length + 1');
  }
  let packed = tokens[0].toLowerCase().replace('0x', '');
  for (let i = 0; i < fees.length; i++) {
    // fee as 3-byte hex (uint24)
    packed += fees[i].toString(16).padStart(6, '0');
    packed += tokens[i + 1].toLowerCase().replace('0x', '');
  }
  return '0x' + packed;
}

/**
 * Build the best single or multi-hop path to swap USDC into any token on Arbitrum.
 * For tokens with a direct USDC pool (WETH, WBTC, ARB): single-hop via that pool.
 * For other tokens: route through WETH as intermediary (USDC → WETH → token).
 */
// Fee tier for the best direct USDC pool for each known token
const DIRECT_USDC_FEES: Record<string, number> = {
  [ADDRESSES.WETH.toLowerCase()]: 500,   // WETH-USDC 0.05%
  [ADDRESSES.WBTC.toLowerCase()]: 3000,  // WBTC-USDC 0.3%
  [ADDRESSES.ARB.toLowerCase()]:  3000,  // ARB-USDC 0.3%
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
    return { path: null, singleHop: true };   // direct USDC pool exists — use exactInputSingle
  }

  // Route through WETH: USDC → (0.05%) → WETH → (preferredFee) → target
  const multihopPath = encodeUniswapPath(
    [ADDRESSES.USDC, ADDRESSES.WETH, targetToken],
    [500, preferredFee],
  );
  return { path: multihopPath, singleHop: false, intermediateFee: preferredFee };
}

/**
 * Estimate the amount of a token receivable for a given USDC input,
 * using Chainlink-based token prices. Used for amountOutMinimum with 0.5% slippage.
 */
function estimateTokenFromUSDC(
  usdcAmountRaw: bigint,
  targetToken:   string,
  tokenPrices:   Map<string, { priceUSD: number }>,
): bigint {
  const lower = targetToken.toLowerCase();
  const dec   = TOKEN_DECIMALS[lower] ?? 18;

  // Look up price from Chainlink PriceMap (keys are symbols like 'WETH', 'WBTC', 'ARB')
  const SYMBOL_MAP: Record<string, string[]> = {
    [ADDRESSES.WETH.toLowerCase()]: ['WETH', 'ETH'],
    [ADDRESSES.WBTC.toLowerCase()]: ['WBTC', 'BTC'],
    [ADDRESSES.ARB.toLowerCase()]:  ['ARB'],
  };
  const symbols    = SYMBOL_MAP[lower] ?? [];
  let   priceInUSD = 0;
  for (const sym of symbols) {
    const tp = tokenPrices.get(sym);
    if (tp) { priceInUSD = tp.priceUSD; break; }
  }
  if (priceInUSD <= 0) return 0n;   // unknown price — min-out = 0 (best-effort)

  const usdcAmount  = Number(usdcAmountRaw) / 1e6;
  const tokenAmount = usdcAmount / priceInUSD;
  return BigInt(Math.floor(tokenAmount * Math.pow(10, dec) * 0.995));   // 0.5% slippage
}

// ── Pendle V3 type aliases (for readability) ─────────────────────────────────
//  SwapData:       (uint8 swapType, address extRouter, bytes extCalldata, bool needScale)
//  TokenInput:     (address tokenIn, uint256 netTokenIn, address tokenMintSy, address pendleSwap, SwapData)
//  TokenOutput:    (address tokenOut, uint256 minTokenOut, address tokenRedeemSy, address pendleSwap, SwapData)
//  ApproxParams:   (uint256 guessMin, uint256 guessMax, uint256 guessOffchain, uint256 maxIteration, uint256 eps)
//  Order:          (uint256 salt, uint256 expiry, uint256 nonce, uint8 orderType, address token,
//                   address YT, address maker, address receiver, uint256 makingAmount,
//                   uint256 lnImpliedRate, uint256 failSafeRate, bytes permit)
//  FillOrderParams: (Order order, bytes signature, uint256 makingAmount)
//  LimitOrderData: (address limitRouter, uint256 epsSkipMarket, FillOrderParams[] normalFills,
//                   FillOrderParams[] flashFills, bytes optData)
//
//  Router: 0x888888888889758F76e7103c6CbF23ABbF58F946 (PendleRouter V3, Arbitrum)
//  Verified selector: swapExactTokenForPt = 0xc81f847a (with correct LimitOrderData)

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
  // Pre-maturity exits: sell PT/YT on Pendle AMM at market price
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

  // ── Single-token liquidity (correct approach for USDC-only deposits) ─────────
  // Pendle Router V3 handles USDC → SY → (SY + PT) → LP internally.
  // addLiquidityDualTokenAndPt requires pre-existing PT tokens — do NOT use for USDC-only vaults.
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
  // Nested struct layout from IDepositUtils.sol (updated GMX V2 interface)
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

// ── Pendle helpers ────────────────────────────────────────────────────────────

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

// ── Fix 1: Parse UniV3 tokenId from transaction receipt logs ──────────────────
//
//  The IncreaseLiquidity event is emitted by NonfungiblePositionManager on mint:
//  IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
//
//  Parsing from receipt logs is more reliable than decoding raw return bytes
//  because it doesn't depend on ethers.js call vs transaction semantics.

export function parseUniV3MintFromReceipt(
  receipt: ethers.TransactionReceipt,
): { tokenId: bigint; liquidity: bigint } | null {
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === ADDRESSES.UNI_V3_POSITION_MGR.toLowerCase() &&
      log.topics[0] === TOPIC_INCREASE_LIQUIDITY
    ) {
      const tokenId   = BigInt(log.topics[1]);
      const liquidity = BigInt('0x' + log.data.slice(2, 66));
      return { tokenId, liquidity };
    }
  }
  return null;
}

// ── Fix 2: Build GMX close-short calldata ─────────────────────────────────────
//
//  MarketDecrease (orderType 4) with isLong=false closes the short position.
//  sizeDeltaUsd = full hedge size, initialCollateralDeltaAmount = 0 (return all).
//  acceptablePrice = 0 means accept any price (worst-case market close).

function buildGMXCloseShortMulticall(
  vaultAddr:     string,
  marketAddress: string,
  hedgeSizeUSD:  number,
): string {
  const sizeDelta = BigInt(Math.round(hedgeSizeUSD)) * BigInt(1e30);

  const sendWntData     = GMX_EXCHANGE_IFACE.encodeFunctionData('sendWnt', [ADDRESSES.GMX_ORDER_VAULT, GMX_EXEC_FEE]);
  const createOrderData = GMX_EXCHANGE_IFACE.encodeFunctionData('createOrder', [{
    addresses: {
      receiver:               vaultAddr,
      cancellationReceiver:   vaultAddr,
      callbackContract:       ethers.ZeroAddress,
      uiFeeReceiver:          ethers.ZeroAddress,
      market:                 marketAddress,
      initialCollateralToken: ADDRESSES.USDC,
      swapPath:               [],
    },
    numbers: {
      sizeDeltaUsd:                sizeDelta,
      initialCollateralDeltaAmount: 0n,    // return all collateral
      triggerPrice:                0n,
      acceptablePrice:             0n,     // accept any price for market close
      executionFee:                GMX_EXEC_FEE,
      callbackGasLimit:            0n,
      minOutputAmount:             0n,
      validFromTime:               0n,
    },
    orderType:                 4,     // MarketDecrease
    decreasePositionSwapType:  0,
    isLong:                    false, // was a short
    shouldUnwrapNativeToken:   false,
    autoCancel:                false,
    referralCode:              ethers.ZeroHash,
    dataList:                  [],
  }]);

  return GMX_EXCHANGE_IFACE.encodeFunctionData('multicall', [[sendWntData, createOrderData]]);
}

// ── GMX open-short multicall (Fix 4: use correct OrderVault for orders) ────────

function buildGMXOpenShortMulticall(
  vaultAddr:     string,
  marketAddress: string,
  collateral:    bigint,
  hedgeSizeUSD:  number,
  currentPrice:  number,
): string {
  const sizeDelta      = BigInt(Math.round(hedgeSizeUSD)) * BigInt(1e30);
  // GMX price precision is 1e30 but acceptablePrice for perps uses 1e12 (USD per token)
  const acceptablePrice = BigInt(Math.round(currentPrice * 1.005 * 1e12));

  const sendWntData     = GMX_EXCHANGE_IFACE.encodeFunctionData('sendWnt',    [ADDRESSES.GMX_ORDER_VAULT, GMX_EXEC_FEE]);
  const sendTokensData  = GMX_EXCHANGE_IFACE.encodeFunctionData('sendTokens', [ADDRESSES.USDC, ADDRESSES.GMX_ORDER_VAULT, collateral]);
  const createOrderData = GMX_EXCHANGE_IFACE.encodeFunctionData('createOrder', [{
    addresses: {
      receiver:               vaultAddr,
      cancellationReceiver:   vaultAddr,
      callbackContract:       ethers.ZeroAddress,
      uiFeeReceiver:          ethers.ZeroAddress,
      market:                 marketAddress,
      initialCollateralToken: ADDRESSES.USDC,
      swapPath:               [],
    },
    numbers: {
      sizeDeltaUsd:                sizeDelta,
      initialCollateralDeltaAmount: collateral,
      triggerPrice:                0n,
      acceptablePrice,
      executionFee:                GMX_EXEC_FEE,
      callbackGasLimit:            0n,
      minOutputAmount:             0n,
      validFromTime:               0n,
    },
    orderType:                 2,     // MarketIncrease
    decreasePositionSwapType:  0,
    isLong:                    false, // short
    shouldUnwrapNativeToken:   false,
    autoCancel:                false,
    referralCode:              ethers.ZeroHash,
    dataList:                  [],
  }]);

  return GMX_EXCHANGE_IFACE.encodeFunctionData('multicall', [[sendWntData, sendTokensData, createOrderData]]);
}

// ── Fix 4: GMX deposit/withdrawal use separate vaults ─────────────────────────

function buildGMXDepositMulticall(vaultAddr: string, marketAddress: string, amount: bigint): string {
  const sendWntData    = GMX_EXCHANGE_IFACE.encodeFunctionData('sendWnt',    [ADDRESSES.GMX_DEPOSIT_VAULT, GMX_EXEC_FEE]);
  const sendTokensData = GMX_EXCHANGE_IFACE.encodeFunctionData('sendTokens', [ADDRESSES.USDC, ADDRESSES.GMX_DEPOSIT_VAULT, amount]);
  // Updated struct: nested addresses + dataList field (IDepositUtils.sol v2)
  const depositData    = GMX_EXCHANGE_IFACE.encodeFunctionData('createDeposit', [{
    addresses: {
      receiver: vaultAddr, callbackContract: ethers.ZeroAddress,
      uiFeeReceiver: ethers.ZeroAddress, market: marketAddress,
      initialLongToken: ethers.ZeroAddress, initialShortToken: ADDRESSES.USDC,
      longTokenSwapPath: [], shortTokenSwapPath: [],
    },
    minMarketTokens:        0n,
    shouldUnwrapNativeToken: false,
    executionFee:           GMX_EXEC_FEE,
    callbackGasLimit:       0n,
    dataList:               [],
  }]);
  return GMX_EXCHANGE_IFACE.encodeFunctionData('multicall', [[sendWntData, sendTokensData, depositData]]);
}

function buildGMXWithdrawMulticall(vaultAddr: string, marketAddress: string, amount: bigint): string {
  const sendWntData      = GMX_EXCHANGE_IFACE.encodeFunctionData('sendWnt',    [ADDRESSES.GMX_WITHDRAWAL_VAULT, GMX_EXEC_FEE]);
  const sendTokensData   = GMX_EXCHANGE_IFACE.encodeFunctionData('sendTokens', [marketAddress, ADDRESSES.GMX_WITHDRAWAL_VAULT, amount]);
  const withdrawData     = GMX_EXCHANGE_IFACE.encodeFunctionData('createWithdrawal', [{
    receiver: vaultAddr, callbackContract: ethers.ZeroAddress,
    uiFeeReceiver: ethers.ZeroAddress, market: marketAddress,
    longTokenSwapPath: [], shortTokenSwapPath: [],
    minLongTokenAmount: 0n, minShortTokenAmount: 0n,
    shouldUnwrapNativeToken: false, executionFee: GMX_EXEC_FEE, callbackGasLimit: 0n,
  }]);
  return GMX_EXCHANGE_IFACE.encodeFunctionData('multicall', [[sendWntData, sendTokensData, withdrawData]]);
}

// ── Leveraged loop batch builder ──────────────────────────────────────────────

function buildLeveragedLoopBatch(
  asset:     string,
  amount:    bigint,
  vaultAddr: string,
  loops:     number = 3,
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

// ── Calldata builders ─────────────────────────────────────────────────────────

function buildDepositCalldata(
  input:        ExecutionInput,
  vaultAddress: string,
): { target: string; calldata: string; value: bigint } {
  const { strategyType, asset, amount, marketAddress, tickLower, tickUpper } = input;

  switch (strategyType) {
    case 'AAVE_LENDING':
      return { target: ADDRESSES.AAVE_POOL, value: 0n,
               calldata: AAVE_IFACE.encodeFunctionData('supply', [asset, amount, vaultAddress, 0]) };

    case 'MORPHO_LENDING':
      if (!marketAddress) throw new Error('MORPHO_LENDING requires marketAddress (vault address)');
      return { target: marketAddress, value: 0n,
               calldata: ERC4626_IFACE.encodeFunctionData('deposit', [amount, vaultAddress]) };

    case 'PENDLE_PT':
      if (!marketAddress) throw new Error('PENDLE_PT requires marketAddress');
      return { target: ADDRESSES.PENDLE_ROUTER, value: 0n,
               calldata: PENDLE_IFACE.encodeFunctionData('swapExactTokenForPt', [
                 vaultAddress, marketAddress, (amount * 95n) / 100n,
                 pendleApproxParams(), pendleTokenInput(asset, amount, asset), pendleEmptyLimit(),
               ]) };

    case 'PENDLE_LP':
      if (!marketAddress) throw new Error('PENDLE_LP requires marketAddress');
      // Single-token deposit: USDC → SY → (SY + PT) → LP, all handled by Pendle Router V3.
      // addLiquidityDualTokenAndPt requires pre-existing PT tokens which this vault never holds.
      return { target: ADDRESSES.PENDLE_ROUTER, value: 0n,
               calldata: PENDLE_IFACE.encodeFunctionData('addLiquiditySingleToken', [
                 vaultAddress, marketAddress,
                 0n,                          // minLpOut — 0 for now; add slippage guard post-audit
                 pendleApproxParams(),
                 pendleTokenInput(asset, amount, asset),
                 pendleEmptyLimit(),
               ]) };

    case 'PENDLE_YT':
      if (!marketAddress) throw new Error('PENDLE_YT requires marketAddress');
      return { target: ADDRESSES.PENDLE_ROUTER, value: 0n,
               calldata: PENDLE_IFACE.encodeFunctionData('swapExactTokenForYt', [
                 vaultAddress, marketAddress, (amount * 90n) / 100n,
                 pendleApproxParams(), pendleTokenInput(asset, amount, asset), pendleEmptyLimit(),
               ]) };

    // Fix 4: GMX_REAL_YIELD uses DepositVault via multicall.
    // Before calling, caller must have called approvePlugin(exchangeRouter) on GMX Router.
    // The approvePlugin step is handled once during vault initialisation (see AgentExecutor.initGMX).
    case 'GMX_REAL_YIELD':
      if (!marketAddress) throw new Error('GMX_REAL_YIELD requires marketAddress');
      return { target: ADDRESSES.GMX_EXCHANGE_ROUTER, value: GMX_EXEC_FEE,
               calldata: buildGMXDepositMulticall(vaultAddress, marketAddress, amount) };

    case 'DELTA_NEUTRAL':
      // DELTA_NEUTRAL requires a two-step swap+mint — handled by _executeDeltaNeutralDeposit,
      // not through buildDepositCalldata. This path is never reached.
      throw new Error('DELTA_NEUTRAL deposits must go through _executeDeltaNeutralDeposit');

    case 'LEVERAGED_LOOP':
      // Handled entirely via executeBatch — this path is not reached
      return { target: ADDRESSES.AAVE_POOL, value: 0n,
               calldata: AAVE_IFACE.encodeFunctionData('supply', [asset, amount, vaultAddress, 0]) };

    default:
      throw new Error(`No deposit builder for ${strategyType}`);
  }
}

function buildWithdrawCalldata(
  input:        ExecutionInput,
  vaultAddress: string,
): { target: string; calldata: string; value: bigint } {
  const { strategyType, asset, amount, marketAddress, tokenId, liquidity } = input;

  switch (strategyType) {
    case 'AAVE_LENDING':
    case 'LEVERAGED_LOOP':
      return { target: ADDRESSES.AAVE_POOL, value: 0n,
               calldata: AAVE_IFACE.encodeFunctionData('withdraw', [asset, amount, vaultAddress]) };

    case 'MORPHO_LENDING':
      if (!marketAddress) throw new Error('MORPHO_LENDING requires marketAddress');
      return { target: marketAddress, value: 0n,
               calldata: ERC4626_IFACE.encodeFunctionData('withdraw', [amount, vaultAddress, vaultAddress]) };

    case 'PENDLE_PT': {
      if (!marketAddress) throw new Error('PENDLE_PT requires marketAddress');
      const nowSec = Math.floor(Date.now() / 1000);
      const matured = input.maturityDate ? nowSec >= input.maturityDate : false;
      if (matured) {
        // At/after maturity: redeem PT 1:1 for underlying — needs YT address
        const ytAddr = input.ytAddress ?? marketAddress;
        return { target: ADDRESSES.PENDLE_ROUTER, value: 0n,
                 calldata: PENDLE_IFACE.encodeFunctionData('redeemPyToToken', [
                   vaultAddress, ytAddr, amount, pendleTokenOutput(asset, asset),
                 ]) };
      } else {
        // Before maturity: sell PT on Pendle AMM at market price (small discount)
        return { target: ADDRESSES.PENDLE_ROUTER, value: 0n,
                 calldata: PENDLE_IFACE.encodeFunctionData('swapExactPtForToken', [
                   vaultAddress, marketAddress, amount, pendleTokenOutput(asset, asset), pendleEmptyLimit(),
                 ]) };
      }
    }

    case 'PENDLE_LP':
      if (!marketAddress) throw new Error('PENDLE_LP requires marketAddress');
      // Single-token removal: LP → SY → USDC, inverse of addLiquiditySingleToken.
      return { target: ADDRESSES.PENDLE_ROUTER, value: 0n,
               calldata: PENDLE_IFACE.encodeFunctionData('removeLiquiditySingleToken', [
                 vaultAddress, marketAddress, amount,
                 pendleTokenOutput(asset, asset),
                 pendleEmptyLimit(),
               ]) };

    case 'PENDLE_YT': {
      if (!marketAddress) throw new Error('PENDLE_YT requires marketAddress');
      const nowSec = Math.floor(Date.now() / 1000);
      const matured = input.maturityDate ? nowSec >= input.maturityDate : false;
      if (matured) {
        const ytAddr = input.ytAddress ?? marketAddress;
        return { target: ADDRESSES.PENDLE_ROUTER, value: 0n,
                 calldata: PENDLE_IFACE.encodeFunctionData('redeemPyToToken', [
                   vaultAddress, ytAddr, amount, pendleTokenOutput(asset, asset),
                 ]) };
      } else {
        // Before maturity: sell YT on Pendle AMM
        return { target: ADDRESSES.PENDLE_ROUTER, value: 0n,
                 calldata: PENDLE_IFACE.encodeFunctionData('swapExactYtForToken', [
                   vaultAddress, marketAddress, amount, pendleTokenOutput(asset, asset), pendleEmptyLimit(),
                 ]) };
      }
    }

    // Fix 4: GMX_REAL_YIELD withdrawal uses WithdrawalVault
    case 'GMX_REAL_YIELD':
      if (!marketAddress) throw new Error('GMX_REAL_YIELD requires marketAddress');
      return { target: ADDRESSES.GMX_EXCHANGE_ROUTER, value: GMX_EXEC_FEE,
               calldata: buildGMXWithdrawMulticall(vaultAddress, marketAddress, amount) };

    case 'DELTA_NEUTRAL': {
      if (!tokenId)   throw new Error('DELTA_NEUTRAL withdraw requires tokenId');
      if (!liquidity) throw new Error('DELTA_NEUTRAL withdraw requires liquidity');
      return { target: ADDRESSES.UNI_V3_POSITION_MGR, value: 0n,
               calldata: UNIV3_POSITION_IFACE.encodeFunctionData('decreaseLiquidity', [{
                 tokenId, liquidity, amount0Min: 0n, amount1Min: 0n,
                 deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
               }]) };
    }

    default:
      throw new Error(`No withdraw builder for ${strategyType}`);
  }
}

// ── Execution params & result ─────────────────────────────────────────────────

export interface ExecutionInput {
  strategyType:  StrategyType;
  asset:         string;
  amount:        bigint;
  amountUSD:     number;
  userAddress:   string;
  marketAddress: string;
  assertedAPY?:  number;   // in bps (800 = 8%) — enforced by contract against policy.minAPY
  currentPrice?: number;   // ETH price in USD (legacy — prefer tokenPrices)
  tokenPrices?:  Map<string, { priceUSD: number }>;  // Chainlink prices keyed by symbol ('WETH', 'WBTC', 'ARB')
  tickLower?:    number;
  tickUpper?:    number;
  tokenId?:      bigint;
  liquidity?:    bigint;
  hedgeSizeUSD?: number;
  maturityDate?: number;
  ytAddress?:    string;
}

export interface OnChainExecutionResult {
  txHash:          string;
  receiptHash:     string;
  gasUsed:         bigint;
  success:         boolean;
  simulated:       false;
  uniV3TokenId?:   bigint;
  uniV3Liquidity?: bigint;
  gmxOrderKey?:    string;
  // ── On-chain state captured at deposit time (used by position-reader.ts) ──
  entryLiquidityIndex?: bigint;   // Aave: liquidityIndex at deposit (1e27 ray)
  morphoShares?:        bigint;   // Morpho ERC-4626: share tokens minted
  pendleLpAmount?:      bigint;   // Pendle LP: LP tokens minted
}

// ── Agent executor ────────────────────────────────────────────────────────────

export class AgentExecutor {
  private wallet:          ethers.Wallet;
  private vault:           ethers.Contract;
  private router:          ethers.Contract | null = null;
  private vaultAddress:    string;
  private gmxInitialized = false; // tracks one-time approvePlugin setup

  constructor(
    privateKey:       string,
    vaultAddress:     string,
    arbRpcUrl:        string,
    zgRouterAddress?: string,
    zgRpcUrl?:        string,
  ) {
    const provider    = new ethers.JsonRpcProvider(arbRpcUrl, 42161, { staticNetwork: true });
    this.wallet       = new ethers.Wallet(privateKey, provider);
    this.vault        = new ethers.Contract(vaultAddress, VAULT_ABI, this.wallet);
    this.vaultAddress = vaultAddress;

    if (zgRouterAddress && zgRpcUrl) {
      const zgProvider = new ethers.JsonRpcProvider(zgRpcUrl, 16661, { staticNetwork: true });
      this.router = new ethers.Contract(zgRouterAddress, ROUTER_ABI, new ethers.Wallet(privateKey, zgProvider));
    }
  }

  // ── Deposit ─────────────────────────────────────────────────────────────────

  async deposit(input: ExecutionInput): Promise<OnChainExecutionResult> {
    if (input.strategyType === 'LEVERAGED_LOOP') {
      return this._executeLeveragedLoop(input);
    }

    // DELTA_NEUTRAL: two-step atomic batch (USDC→WETH swap + LP mint)
    if (input.strategyType === 'DELTA_NEUTRAL') {
      if (!this.gmxInitialized) await this.initGMX();
      return this._executeDeltaNeutralDeposit(input);
    }

    // Auto-init GMX on first GMX operation — registers ExchangeRouter as vault plugin
    if (input.strategyType === 'GMX_REAL_YIELD' && !this.gmxInitialized) {
      await this.initGMX();
    }

    const { target, calldata, value } = buildDepositCalldata(input, this.vaultAddress);
    const approveTarget = value > 0n ? ADDRESSES.GMX_ROUTER : target;
    await this._approveIfNeeded(input.asset, approveTarget, input.amount);

    // Use executeDeposit for fund-moving deposits — atomically deducts idle balance
    // and enforces assertedAPY ≥ policy.minAPY on-chain.
    const assertedAPY = BigInt(input.assertedAPY ?? 0);
    const result = await this._fundedDeposit(target, calldata, value, assertedAPY, 'GENESIS', input);

    // ── Capture on-chain state for accurate position tracking ─────────────────
    // These fields are stored in the PortfolioPosition and read each tick by
    // position-reader.ts to compute 100% accurate current value (not formula).
    if (result.success && result._receipt) {
      try {
        switch (input.strategyType) {

          case 'AAVE_LENDING': {
            // Read liquidityIndex right after deposit settles — this is the entry index.
            // currentValue = entryUSD × (currentIndex / entryIndex) each tick.
            // (LEVERAGED_LOOP exits deposit() early via _executeLeveragedLoop — captured there)
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
            // Parse ERC-4626 share tokens minted to vault from receipt Transfer events.
            // currentValue = vault.convertToAssets(morphoShares) each tick.
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
            // Parse Pendle market LP tokens minted to vault (market address IS the LP token).
            // currentValue = pendleLpAmount × oracle.getLpToAssetRate(market, 900) each tick.
            if (input.marketAddress) {
              result.pendleLpAmount = parseMintedAmount(
                result._receipt,
                input.marketAddress,
                this.vaultAddress,
              );
            }
            break;
          }

          // PENDLE_PT: PT tokens are parsed by the existing ytAddress tracking.
          // GMX_REAL_YIELD: deposit is async (order queue) — gmTokenAmount is polled
          //   by position-reader.ts on subsequent ticks once balance appears.
          // DELTA_NEUTRAL: uniV3TokenId already captured above.
        }
      } catch (err: any) {
        console.warn('[Executor] On-chain state capture failed (non-fatal):', err.message);
      }
    }

    return result;
  }

  // ── Withdraw ────────────────────────────────────────────────────────────────

  async withdraw(input: ExecutionInput): Promise<OnChainExecutionResult> {
    // Leveraged loop: must repay all debt BEFORE withdrawing collateral.
    // Simple withdraw would revert — health factor drops below 1 instantly.
    if (input.strategyType === 'LEVERAGED_LOOP') {
      return this._executeLeveragedUnwind(input);
    }

    // Delta-neutral: close GMX short before withdrawing LP
    if (input.strategyType === 'DELTA_NEUTRAL' && input.hedgeSizeUSD && input.hedgeSizeUSD > 0) {
      try {
        await this.closeGMXShort(input.marketAddress, input.hedgeSizeUSD, input.userAddress, input.amountUSD);
      } catch (err: any) {
        console.warn('[Executor] GMX short close failed:', err.message);
      }
    }
    const { target, calldata, value } = buildWithdrawCalldata(input, this.vaultAddress);
    // executeWithdraw measures actual returned tokens via balance delta — trustless
    return this._fundedWithdraw(target, calldata, value, 'WITHDRAW', input);
  }

  // ── Leveraged loop unwind ───────────────────────────────────────────────────
  //
  //  Atomically: repay all variable debt → withdraw all collateral.
  //  The vault must hold enough liquid asset to cover the debt before calling.
  //  (Debt = ~1.7x initial for a 3-loop USDC cycle at 75% LTV.)
  //  Vault accumulates repayment capital via yield spread over the hold period.

  private async _executeLeveragedUnwind(input: ExecutionInput): Promise<OnChainExecutionResult> {
    await this._approveIfNeeded(input.asset, ADDRESSES.AAVE_POOL, ethers.MaxUint256);

    const targets = [ADDRESSES.AAVE_POOL, ADDRESSES.AAVE_POOL];
    const dataArr  = [
      AAVE_IFACE.encodeFunctionData('repay',    [input.asset, ethers.MaxUint256, 2, this.vaultAddress]),
      AAVE_IFACE.encodeFunctionData('withdraw', [input.asset, ethers.MaxUint256, this.vaultAddress]),
    ];

    const receiptHash = this._buildReceiptHash(input, 'WITHDRAW');
    // New signature: executeBatch(user, asset, targets, dataArr, receiptHash)
    // Contract measures net USDC balance change automatically
    const tx      = await (this.vault as any).executeBatch(
      input.userAddress, input.asset, targets, dataArr, receiptHash
    );
    const receipt = await tx.wait(1);

    this._recordOnZG(input.userAddress, receiptHash, 'WITHDRAW', input.amountUSD);
    return { txHash: tx.hash, receiptHash, gasUsed: receipt.gasUsed, success: receipt.status === 1, simulated: false };
  }

  // ── Migrate ─────────────────────────────────────────────────────────────────

  async migrate(from: ExecutionInput, to: ExecutionInput): Promise<OnChainExecutionResult> {
    await this.withdraw(from);
    return this.deposit(to);
  }

  // ── Fix 2: Close GMX short (called on MIGRATE and SAFETY_EXIT from DELTA_NEUTRAL)

  async closeGMXShort(
    assetOrMarket: string,  // asset symbol or pool address — GMX market derived from this
    hedgeSizeUSD:  number,
    userAddress:   string,
    amountUSD:     number,
  ): Promise<OnChainExecutionResult> {
    const gmxHedgeMarket = getGMXHedgeMarket(assetOrMarket);
    const closeData = buildGMXCloseShortMulticall(this.vaultAddress, gmxHedgeMarket, hedgeSizeUSD);
    const input: ExecutionInput = {
      strategyType: 'DELTA_NEUTRAL', asset: ADDRESSES.USDC,
      amount: 0n, amountUSD, userAddress, marketAddress: gmxHedgeMarket,
    };
    return this._genericCall(ADDRESSES.GMX_EXCHANGE_ROUTER, closeData, GMX_EXEC_FEE, 'MIGRATE', input);
  }

  // ── Collect UniV3 fees + normalise WETH back to USDC ────────────────────────
  //
  //  UniV3 WETH-USDC LP fees accrue as BOTH WETH (token0) and USDC (token1).
  //  After collect(), the vault holds WETH that is invisible to vault.balances[user][USDC].
  //
  //  We solve this in a single atomic executeBatch:
  //    Step 1: collect(tokenId) → vault receives WETH + USDC
  //    Step 2: exactInputSingle(WETH → USDC) → swap all received WETH to USDC
  //
  //  Post-batch: vault.balances[user][USDC] increases by total USDC fee income.
  //  The user sees pure USDC yield regardless of pool composition. Token-agnostic.
  //
  //  ethPriceUSD: used to compute minAmountOut with 0.5% slippage guard.
  //  If WETH balance is below $1 equivalent (dust threshold), skip the swap
  //  to avoid burning more gas than the swap is worth.

  async collectUniV3Fees(
    tokenId:      bigint,
    userAddress:  string,
    amountUSD:    number,
    ethPriceUSD:  number = 3000,
  ): Promise<OnChainExecutionResult> {
    const provider = this.wallet.provider as ethers.JsonRpcProvider;

    // Read the position's actual token0 and token1 from the NFT manager.
    // This makes the normalizer token-agnostic: WBTC-USDC, ARB-USDC, WETH-USDC — all work.
    const posMgr    = new ethers.Contract(ADDRESSES.UNI_V3_POSITION_MGR, UNIV3_POS_READ_ABI, provider);
    const posData   = await posMgr.positions(tokenId);
    const posToken0 = (posData.token0 ?? posData[2] as string).toLowerCase();
    const posToken1 = (posData.token1 ?? posData[3] as string).toLowerCase();
    const posFee    = Number(posData.fee ?? posData[4]);

    // Determine which token is non-USDC (the volatile token that needs to be normalised)
    const isUsdc0   = posToken0 === ADDRESSES.USDC.toLowerCase();
    const isUsdc1   = posToken1 === ADDRESSES.USDC.toLowerCase();

    if (!isUsdc0 && !isUsdc1) {
      // Neither token is USDC — collect only, no normalisation possible
      const inputObj: ExecutionInput = {
        strategyType: 'DELTA_NEUTRAL', asset: ADDRESSES.USDC,
        amount: 0n, amountUSD, userAddress, marketAddress: ADDRESSES.UNI_V3_POSITION_MGR,
      };
      const collectOnlyCalldata = UNIV3_POSITION_IFACE.encodeFunctionData('collect', [{
        tokenId, recipient: this.vaultAddress,
        amount0Max: ethers.MaxUint256, amount1Max: ethers.MaxUint256,
      }]);
      return this._genericCall(ADDRESSES.UNI_V3_POSITION_MGR, collectOnlyCalldata, 0n, 'HARVEST', inputObj, ADDRESSES.USDC);
    }

    const volatileAddr = ethers.getAddress(isUsdc1 ? posToken0 : posToken1);
    const decVolatile  = TOKEN_DECIMALS[volatileAddr.toLowerCase()] ?? 18;

    // Read current vault balance of volatile token before collect
    const volatileERC20   = new ethers.Contract(volatileAddr, ['function balanceOf(address) view returns (uint256)'], provider);
    const volBefore       = await volatileERC20.balanceOf(this.vaultAddress) as bigint;

    // Estimate how much volatile token we'll receive (≈50% of total fees by value)
    const estimatedVolFees = BigInt(
      Math.floor((amountUSD / 2) / ethPriceUSD * Math.pow(10, decVolatile))
    );
    const dustThreshold = BigInt(Math.floor(1 / ethPriceUSD * Math.pow(10, decVolatile)));  // $1 equivalent
    const willHaveVol   = estimatedVolFees > dustThreshold || volBefore > dustThreshold;

    // Step 1 calldata: collect all pending fees
    const collectCalldata = UNIV3_POSITION_IFACE.encodeFunctionData('collect', [{
      tokenId, recipient: this.vaultAddress,
      amount0Max: ethers.MaxUint256, amount1Max: ethers.MaxUint256,
    }]);

    if (!willHaveVol) {
      // Dust only — simple collect, skip the swap to avoid wasting gas
      const inputObj: ExecutionInput = {
        strategyType: 'DELTA_NEUTRAL', asset: ADDRESSES.USDC,
        amount: 0n, amountUSD, userAddress, marketAddress: ADDRESSES.UNI_V3_POSITION_MGR,
      };
      return this._genericCall(ADDRESSES.UNI_V3_POSITION_MGR, collectCalldata, 0n, 'HARVEST', inputObj, ADDRESSES.USDC);
    }

    // Pre-approve volatile → SwapRouter02 (MaxUint — exact balance unknown before collect executes)
    await this._approveIfNeeded(volatileAddr, ADDRESSES.SWAP_ROUTER02, ethers.MaxUint256);

    // Step 2: swap volatile → USDC using pool price for min-out
    const totalVol   = volBefore + estimatedVolFees;  // conservative upper bound
    const minUSDCOut = BigInt(Math.floor(
      Number(totalVol) / Math.pow(10, decVolatile) * ethPriceUSD * 0.995 * 1e6
    ));

    const swapCalldata = SWAP_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [{
      tokenIn:           volatileAddr,
      tokenOut:          ADDRESSES.USDC,
      fee:               posFee,
      recipient:         this.vaultAddress,
      amountIn:          totalVol,
      amountOutMinimum:  minUSDCOut,
      sqrtPriceLimitX96: 0n,
    }]);

    // executeBatch: collect + swap in one atomic call.
    // USDC accounting: vault measures USDC_after - USDC_before = total fee income in USDC.
    const receiptHash = this._buildReceiptHash(
      { strategyType: 'DELTA_NEUTRAL', asset: ADDRESSES.USDC, amount: 0n, amountUSD, userAddress, marketAddress: ADDRESSES.UNI_V3_POSITION_MGR },
      'HARVEST',
    );
    const tx = await (this.vault as any).executeBatch(
      userAddress,
      ADDRESSES.USDC,
      [ADDRESSES.UNI_V3_POSITION_MGR, ADDRESSES.SWAP_ROUTER02],
      [collectCalldata, swapCalldata],
      receiptHash,
    );
    const receipt = await tx.wait(1) as ethers.TransactionReceipt;
    this._recordOnZG(userAddress, receiptHash, 'HARVEST', amountUSD);
    return { txHash: tx.hash, receiptHash, gasUsed: receipt.gasUsed, success: receipt.status === 1, simulated: false };
  }

  // Called once before any GMX operation. Registers ExchangeRouter as a plugin
  // in the GMX Router so sendTokens() can pull tokens from the vault via pluginTransfer.
  // Uses vaultSetup() — owner-only call that bypasses user policy check (setup, not user action).
  async initGMX(): Promise<void> {
    if (this.gmxInitialized) return;
    // approvePlugin(address) selector = 0x38c74dd9
    const calldata = '0x38c74dd9' + ADDRESSES.GMX_EXCHANGE_ROUTER.slice(2).padStart(64, '0');
    const tx = await (this.vault as any).vaultSetup(ADDRESSES.GMX_ROUTER, calldata);
    await tx.wait(1);
    this.gmxInitialized = true;
    console.log('[Executor] GMX plugin approved');
  }

  static supportsOnChain(_strategyType: StrategyType): boolean { return true; }

  // ── Internal ────────────────────────────────────────────────────────────────

  // ── DELTA_NEUTRAL: USDC→WETH swap + UniV3 LP mint ────────────────────────────
  //
  //  In WETH-USDC pool: WETH = token0 (0x82... < 0xaf...), USDC = token1.
  //  A single-call mint with amount1Desired=0 would deposit only USDC and create
  //  an almost-empty position (no WETH = liquidity ≈ 0 at any in-range tick).
  //
  //  Correct approach:
  //    1. Swap half the USDC to WETH via SwapRouter02 exactInputSingle
  //    2. Mint LP with both WETH and USDC in a single executeBatch
  //
  //  Tick range is computed to ±10% around the current ETH price, aligned to
  //  the 0.3% pool's tick spacing of 60.

  private async _executeDeltaNeutralDeposit(
    input: ExecutionInput,
  ): Promise<OnChainExecutionResult & { _receipt?: ethers.TransactionReceipt }> {
    const poolAddress = input.marketAddress;
    const provider    = this.wallet.provider as ethers.JsonRpcProvider;

    // Read actual pool tokens, fee, and current tick from the pool contract.
    // This makes the deposit token-agnostic: WETH-USDC, WBTC-USDC, ARB-USDC — all work.
    const poolState = await readPoolState(provider, poolAddress);
    const { token0, token1, fee, spacing, currentTick,
            isUsdc0, isUsdc1, volatileToken, decVolatile, sqrtPriceX96 } = poolState;

    // ±10% tick range centred at current pool tick — valid for any token pair.
    const tickLower = Math.floor((currentTick + TICKS_10PCT_DOWN) / spacing) * spacing;
    const tickUpper = Math.ceil((currentTick + TICKS_10PCT_UP)   / spacing) * spacing;

    const prices      = input.tokenPrices ?? new Map<string, { priceUSD: number }>();
    const halfAmount  = input.amount / 2n;

    // ── Build swap calldata(s) ───────────────────────────────────────────────
    // Case A: USDC-paired pool (one of the tokens is USDC) → one swap
    // Case B: Non-USDC pool (WETH-WBTC, WETH-ARB, etc.)   → two swaps, one per token
    const batchTargets:  string[] = [];
    const batchCalldata: string[] = [];

    let amount0ForMint: bigint;
    let amount1ForMint: bigint;

    if (isUsdc0 || isUsdc1) {
      // ── Case A: one swap (USDC → volatile) ──────────────────────────────
      const usdcForLP    = input.amount - halfAmount;
      const volatileAddr = ethers.getAddress(volatileToken);

      // Use pool's own sqrtPriceX96 for pricing — no external dependency
      const { estimatedVolatile, minOut } = estimateVolatileFromUSDC(
        halfAmount, sqrtPriceX96, isUsdc1, decVolatile,
      );
      const volatileForMint = (estimatedVolatile * 99n) / 100n;

      await this._approveIfNeeded(ADDRESSES.USDC, ADDRESSES.SWAP_ROUTER02, halfAmount);
      await this._approveIfNeeded(volatileAddr,   ADDRESSES.UNI_V3_POSITION_MGR, ethers.MaxUint256);
      await this._approveIfNeeded(ADDRESSES.USDC, ADDRESSES.UNI_V3_POSITION_MGR, usdcForLP);

      const { singleHop } = bestSwapPathFromUSDC(volatileToken, fee);
      batchTargets.push(ADDRESSES.SWAP_ROUTER02);
      batchCalldata.push(singleHop
        ? SWAP_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [{
            tokenIn: ADDRESSES.USDC, tokenOut: volatileAddr, fee,
            recipient: this.vaultAddress, amountIn: halfAmount,
            amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
          }])
        : SWAP_ROUTER02_IFACE.encodeFunctionData('exactInput', [{
            path:             bestSwapPathFromUSDC(volatileToken, fee).path!,
            recipient:        this.vaultAddress,
            amountIn:         halfAmount,
            amountOutMinimum: minOut,
          }]),
      );

      [amount0ForMint, amount1ForMint] = isUsdc1
        ? [volatileForMint, usdcForLP]
        : [usdcForLP,       volatileForMint];

    } else {
      // ── Case B: two swaps (USDC → token0, USDC → token1) ────────────────
      // Non-USDC pair: e.g. WETH-WBTC, WETH-ARB.
      // Each token leg uses Chainlink prices for min-out estimation.
      const token0Addr = ethers.getAddress(token0);
      const token1Addr = ethers.getAddress(token1);

      const minOut0 = estimateTokenFromUSDC(halfAmount, token0, prices);
      const minOut1 = estimateTokenFromUSDC(halfAmount, token1, prices);

      await this._approveIfNeeded(ADDRESSES.USDC, ADDRESSES.SWAP_ROUTER02, input.amount);
      await this._approveIfNeeded(token0Addr, ADDRESSES.UNI_V3_POSITION_MGR, ethers.MaxUint256);
      await this._approveIfNeeded(token1Addr, ADDRESSES.UNI_V3_POSITION_MGR, ethers.MaxUint256);

      // Swap 1: USDC → token0 (single-hop if direct pool exists, else via WETH)
      const route0 = bestSwapPathFromUSDC(token0, fee);
      batchTargets.push(ADDRESSES.SWAP_ROUTER02);
      batchCalldata.push(route0.singleHop
        ? SWAP_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [{
            tokenIn: ADDRESSES.USDC, tokenOut: token0Addr,
            fee: DIRECT_FEE_FOR(token0), recipient: this.vaultAddress,
            amountIn: halfAmount, amountOutMinimum: minOut0, sqrtPriceLimitX96: 0n,
          }])
        : SWAP_ROUTER02_IFACE.encodeFunctionData('exactInput', [{
            path: route0.path!, recipient: this.vaultAddress,
            amountIn: halfAmount, amountOutMinimum: minOut0,
          }]),
      );

      // Swap 2: USDC → token1
      const route1 = bestSwapPathFromUSDC(token1, fee);
      batchTargets.push(ADDRESSES.SWAP_ROUTER02);
      batchCalldata.push(route1.singleHop
        ? SWAP_ROUTER02_IFACE.encodeFunctionData('exactInputSingle', [{
            tokenIn: ADDRESSES.USDC, tokenOut: token1Addr,
            fee: DIRECT_FEE_FOR(token1), recipient: this.vaultAddress,
            amountIn: halfAmount, amountOutMinimum: minOut1, sqrtPriceLimitX96: 0n,
          }])
        : SWAP_ROUTER02_IFACE.encodeFunctionData('exactInput', [{
            path: route1.path!, recipient: this.vaultAddress,
            amountIn: halfAmount, amountOutMinimum: minOut1,
          }]),
      );

      amount0ForMint = (minOut0 * 99n) / 100n;
      amount1ForMint = (minOut1 * 99n) / 100n;
    }

    // ── Mint LP (always last step in batch) ─────────────────────────────────
    const [t0cs, t1cs] = [ethers.getAddress(token0), ethers.getAddress(token1)];
    batchTargets.push(ADDRESSES.UNI_V3_POSITION_MGR);
    batchCalldata.push(UNIV3_POSITION_IFACE.encodeFunctionData('mint', [{
      token0: t0cs, token1: t1cs, fee,
      tickLower, tickUpper,
      amount0Desired: amount0ForMint,
      amount1Desired: amount1ForMint,
      amount0Min: 0n, amount1Min: 0n,
      recipient: this.vaultAddress,
      deadline:  BigInt(Math.floor(Date.now() / 1000) + 600),
    }]));

    const receiptHash = this._buildReceiptHash(input, 'GENESIS');
    const tx = await (this.vault as any).executeBatch(
      input.userAddress, ADDRESSES.USDC,
      batchTargets, batchCalldata, receiptHash,
    );
    const receipt = await tx.wait(1) as ethers.TransactionReceipt;
    this._recordOnZG(input.userAddress, receiptHash, 'GENESIS', input.amountUSD);

    const result: OnChainExecutionResult & { _receipt?: ethers.TransactionReceipt } = {
      txHash: tx.hash, receiptHash,
      gasUsed: receipt.gasUsed, success: receipt.status === 1, simulated: false, _receipt: receipt,
    };

    if (result.success) {
      const parsed = parseUniV3MintFromReceipt(receipt);
      if (parsed) {
        result.uniV3TokenId   = parsed.tokenId;
        result.uniV3Liquidity = parsed.liquidity;

        // Hedge the primary volatile leg with a GMX perp short
        // For non-USDC pairs, hedge the token with the larger Chainlink price feed (token0)
        const hedgeTokenAddr = (isUsdc0 || isUsdc1) ? volatileToken : token0;
        try {
          const hedgeSizeUSD    = (input.amountUSD / 2) * 0.65;
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

    return result;
  }

  private async _executeLeveragedLoop(input: ExecutionInput): Promise<OnChainExecutionResult> {
    const { targets, dataArr } = buildLeveragedLoopBatch(input.asset, input.amount, this.vaultAddress, 3);
    await this._approveIfNeeded(input.asset, ADDRESSES.AAVE_POOL, input.amount * 4n);
    const receiptHash = this._buildReceiptHash(input, 'GENESIS');
    const tx      = await (this.vault as any).executeBatch(
      input.userAddress, input.asset, targets, dataArr, receiptHash
    );
    const receipt = await tx.wait(1) as ethers.TransactionReceipt;
    this._recordOnZG(input.userAddress, receiptHash, 'GENESIS', input.amountUSD);

    // Capture Aave liquidityIndex at entry for real position tracking
    let entryLiquidityIndex: bigint | undefined;
    try {
      const aavePool = new ethers.Contract(ADDRESSES.AAVE_POOL, AAVE_POOL_READ_ABI, this.wallet.provider as ethers.JsonRpcProvider);
      entryLiquidityIndex = await aavePool.getReserveNormalizedIncome(ADDRESSES.USDC) as bigint;
    } catch { /* non-fatal */ }

    return {
      txHash: tx.hash, receiptHash,
      gasUsed: receipt.gasUsed,
      success: receipt.status === 1,
      simulated: false,
      entryLiquidityIndex,
    };
  }

  private async _openGMXShort(
    input:         ExecutionInput,
    hedgeSizeUSD:  number,
    collateral:    bigint,
  ): Promise<OnChainExecutionResult> {
    await this._approveIfNeeded(ADDRESSES.USDC, ADDRESSES.GMX_ROUTER, collateral);
    // Delta-neutral: LP is on UniV3 (input.marketAddress = pool address),
    // hedge short must target the GMX perpetuals market for the same asset.
    const gmxHedgeMarket = getGMXHedgeMarket(input.asset + input.marketAddress);
    const multicallData  = buildGMXOpenShortMulticall(
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

  // ── Performance fee collection ────────────────────────────────────────────────
  // Called after a successful harvest or migration to collect YieldGeko's cut.
  // yieldUSD: the yield earned in this action (USD, e.g. 18.4).
  // Converts to USDC token units (6 decimals) and calls collectFee on the vault.

  async takePerformanceFee(userAddress: string, yieldUSD: number): Promise<void> {
    if (yieldUSD <= 0) return;
    const grossAmount = BigInt(Math.round(yieldUSD * 1e6)); // USDC 6 decimals
    try {
      const tx = await (this.vault as any).collectFee(ADDRESSES.USDC, userAddress, grossAmount);
      await tx.wait(1);
    } catch (err: any) {
      // Non-blocking: log but don't break the agent tick on fee collection failure
      console.warn(`[Executor] collectFee failed for ${userAddress}: ${err.message}`);
    }
  }

  // ── Report portfolio value on-chain (triggers drawdown enforcement) ──────────

  async reportValueOnChain(userAddress: string, currentValueUSD: number): Promise<void> {
    // Onboarding currently registers USDC policies, so report values in USDC units.
    const valueScaled = BigInt(Math.round(currentValueUSD * 1e6));
    const tx = await (this.vault as any).reportValue(userAddress, valueScaled);
    await tx.wait(1);
  }

  private async _approveIfNeeded(asset: string, spender: string, amount: bigint): Promise<void> {
    const tx = await (this.vault as any).approveToken(asset, spender, amount);
    await tx.wait(1);
  }

  // ── Fund-moving deposit: uses executeDeposit() — atomically deducts idle balance
  //    and enforces assertedAPY ≥ policy.minAPY on-chain.

  private async _fundedDeposit(
    target:      string,
    calldata:    string,
    value:       bigint,
    assertedAPY: bigint,
    action:      string,
    input:       ExecutionInput,
  ): Promise<OnChainExecutionResult & { _receipt?: ethers.TransactionReceipt }> {
    const receiptHash = this._buildReceiptHash(input, action);
    const tx = await (this.vault as any).executeDeposit(
      input.userAddress, input.asset, input.amount, assertedAPY,
      target, calldata, receiptHash,
      { value },
    );
    const receipt = await tx.wait(1) as ethers.TransactionReceipt;
    this._recordOnZG(input.userAddress, receiptHash, action, input.amountUSD);
    return { txHash: tx.hash, receiptHash, gasUsed: receipt.gasUsed, success: receipt.status === 1, simulated: false, _receipt: receipt };
  }

  // ── Fund-moving withdrawal: uses executeWithdraw() — measures actual token return.

  private async _fundedWithdraw(
    target:   string,
    calldata: string,
    value:    bigint,
    action:   string,
    input:    ExecutionInput,
  ): Promise<OnChainExecutionResult & { _receipt?: ethers.TransactionReceipt }> {
    const receiptHash    = this._buildReceiptHash(input, action);
    // deployedAmount passed for accounting deduction; actual return is measured by contract
    const deployedAmount = input.amount;
    const tx = await (this.vault as any).executeWithdraw(
      input.userAddress, input.asset, deployedAmount,
      target, calldata, receiptHash,
      { value },
    );
    const receipt = await tx.wait(1) as ethers.TransactionReceipt;
    this._recordOnZG(input.userAddress, receiptHash, action, input.amountUSD);
    return { txHash: tx.hash, receiptHash, gasUsed: receipt.gasUsed, success: receipt.status === 1, simulated: false, _receipt: receipt };
  }

  // ── Generic non-fund-moving call: uses execute(user, target, data, receiptHash).
  //    For: harvest, fee collection, UniV3 collect.
  //    Does NOT update balance accounting.

  private async _genericCall(
    target:     string,
    calldata:   string,
    value:      bigint,
    action:     string,
    input:      ExecutionInput,
    guardAsset: string = input.asset,
  ): Promise<OnChainExecutionResult & { _receipt?: ethers.TransactionReceipt }> {
    const receiptHash = this._buildReceiptHash(input, action);
    const tx = await (this.vault as any).execute(
      input.userAddress, target, calldata, receiptHash, guardAsset,
      { value },
    );
    const receipt = await tx.wait(1) as ethers.TransactionReceipt;
    this._recordOnZG(input.userAddress, receiptHash, action, input.amountUSD);
    return { txHash: tx.hash, receiptHash, gasUsed: receipt.gasUsed, success: receipt.status === 1, simulated: false, _receipt: receipt };
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

// ── Singleton ─────────────────────────────────────────────────────────────────

let _executor: AgentExecutor | null = null;

export function getExecutor(): AgentExecutor | null {
  if (_executor) return _executor;
  const key   = process.env.AGENT_PRIVATE_KEY;
  const vault = process.env.VAULT_ADDRESS;
  const rpc   = process.env.ARB_RPC_URL;
  if (!key || !vault || !rpc) return null;
  _executor = new AgentExecutor(key, vault, rpc, process.env.ZG_ROUTER_ADDRESS, 'https://evmrpc.0g.ai');
  return _executor;
}
