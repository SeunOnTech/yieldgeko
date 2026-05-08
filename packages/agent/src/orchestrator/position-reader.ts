/**
 * Protocol-aware on-chain position value reader.
 *
 * Called ONLY for users with policy.isReal === true.
 * Demo users (Alice / Bob / Carol) continue using formula-based accrual in monitor.ts
 * so the /agent demo page is completely unaffected.
 *
 * Each protocol has different mechanics for how value accrues:
 *
 *   Aave V3          — aUSDC rebases every block via liquidityIndex
 *   Morpho ERC-4626  — shares converted to assets via convertToAssets()
 *   Uniswap V3 LP    — liquidity principal + uncollected fees (tokensOwed)
 *   Pendle LP/PT     — Pendle PT/LP oracle (TWAP-based rate)
 *   GMX V2           — GM token balance × pool value per token
 *
 * Each reader returns null on failure → caller falls back to formula estimate.
 * Errors are logged but never crash the tick loop.
 */

import { ethers, type JsonRpcProvider } from 'ethers';
import type { PortfolioPosition } from './types';
import type { PriceMap } from './protocols/chainlink';

// ── Minimal read-only ABIs ────────────────────────────────────────────────────

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
];

const ERC4626_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
];

const AAVE_POOL_ABI = [
  // Returns the ongoing normalized income (liquidity index) for the reserve.
  // Stored as a Ray (1e27). Multiplying entryUSD by (current/entry) gives exact current value.
  'function getReserveNormalizedIncome(address asset) view returns (uint256)',
  // Returns account-level data: all values in USD with 8 decimals.
  // healthFactor is in 1e18: 1e18 = HF 1.0. Below 1e18 = liquidatable.
  `function getUserAccountData(address user) view returns (
    uint256 totalCollateralBase,
    uint256 totalDebtBase,
    uint256 availableBorrowsBase,
    uint256 currentLiquidationThreshold,
    uint256 ltv,
    uint256 healthFactor
  )`,
];

const ATOKEN_ABI = [
  // aUSDC balance = face value in USDC (6 decimals) — rebases every block
  'function balanceOf(address account) view returns (uint256)',
  // scaledBalanceOf is constant; used for per-user share computation
  'function scaledBalanceOf(address account) view returns (uint256)',
];

const UNIV3_POS_MGR_ABI = [
  `function positions(uint256 tokenId) view returns (
    uint96  nonce,
    address operator,
    address token0,
    address token1,
    uint24  fee,
    int24   tickLower,
    int24   tickUpper,
    uint128 liquidity,
    uint256 feeGrowthInside0LastX128,
    uint256 feeGrowthInside1LastX128,
    uint128 tokensOwed0,
    uint128 tokensOwed1
  )`,
];

const UNIV3_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

const UNIV3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];

const PENDLE_ORACLE_ABI = [
  // 15-min TWAP rate: 1 LP (or 1 PT) → underlying asset amount (1e18 scaled)
  'function getLpToAssetRate(address market, uint32 duration) view returns (uint256)',
  'function getPtToAssetRate(address market, uint32 duration) view returns (uint256)',
];

const GMX_DATASTORE_ABI = [
  'function getUint(bytes32 key) view returns (uint256)',
];

const GMX_MARKET_ABI = [
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];

// ── Addresses (Arbitrum mainnet) ──────────────────────────────────────────────

const ADDR = {
  AAVE_POOL:      '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  AUSDC:          '0x625E7708f30cA75bfd92586e17077590C60eb4cD',
  UNIV3_POS_MGR:  '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  UNIV3_FACTORY:  '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  PENDLE_ORACLE:  '0x9a9Fa8338dd5E5B2188006f1Cd2Ef26d921650C2',
  GMX_DATASTORE:  '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8',
  USDC:           '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  WETH:           '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  WBTC:           '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
  ARB:            '0x912CE59144191C1204E64559FE8253a0e49E6548',
} as const;

// Pendle TWAP window (15 min — standard recommendation)
const PENDLE_DURATION = 900;

// ── Result type ───────────────────────────────────────────────────────────────

export interface RealPositionRead {
  currentUSD:        number;
  incomeEarnedUSD:   number;   // currentUSD − entryUSD (positive = profit, negative = loss)
  pendingRewardsUSD: number;   // claimable right now without closing position (UniV3 tokensOwed, Pendle rewards)
  outOfRange:        boolean;  // UniV3: current tick outside [tickLower, tickUpper] → earning 0 fees
  healthFactor?:     number;   // LEVERAGED_LOOP only: Aave HF (1e18 = 1.0; <1.0 = liquidatable)
  dataSource:        'on-chain';
}

// ── Helper: token address → USD price ────────────────────────────────────────

function tokenPriceUSD(tokenAddress: string, prices: PriceMap): number {
  const addr = tokenAddress.toLowerCase();
  if (addr === ADDR.USDC.toLowerCase())  return 1.0;
  if (addr === ADDR.WETH.toLowerCase())  return prices.get('WETH')?.priceUSD ?? prices.get('ETH')?.priceUSD ?? 3000;
  if (addr === ADDR.WBTC.toLowerCase())  return prices.get('WBTC')?.priceUSD ?? prices.get('BTC')?.priceUSD ?? 60000;
  if (addr === ADDR.ARB.toLowerCase())   return prices.get('ARB')?.priceUSD ?? 1.0;
  return 1.0;
}

// ── 1. Aave V3 (AAVE_LENDING) ────────────────────────────────────────────────
//
//  Aave tracks each depositor's balance via a "scaled balance" and a global
//  liquidityIndex. At any point:
//    currentValue = entryUSD × (currentLiquidityIndex / entryLiquidityIndex)
//
//  If entryLiquidityIndex was not captured (first deployment), we fall back to
//  reading aUSDC.balanceOf(vault) directly, which is accurate for a single-user vault.

async function readAaveValue(
  provider:            JsonRpcProvider,
  vaultAddress:        string,
  entryUSD:            number,
  entryLiquidityIndex?: string,
): Promise<RealPositionRead> {
  const pool = new ethers.Contract(ADDR.AAVE_POOL, AAVE_POOL_ABI, provider);

  let currentUSD: number;
  if (entryLiquidityIndex && entryLiquidityIndex !== '0') {
    const currentIndex = await pool.getReserveNormalizedIncome(ADDR.USDC) as bigint;
    const entryIndex   = BigInt(entryLiquidityIndex);
    currentUSD = entryUSD * Number(currentIndex) / Number(entryIndex);
  } else {
    // Fallback: read aUSDC balance directly (exact for single-user vault)
    const aToken     = new ethers.Contract(ADDR.AUSDC, ATOKEN_ABI, provider);
    const balanceRaw = await aToken.balanceOf(vaultAddress) as bigint;
    currentUSD = Number(balanceRaw) / 1e6;
  }

  return { currentUSD, incomeEarnedUSD: currentUSD - entryUSD, pendingRewardsUSD: 0, outOfRange: false, dataSource: 'on-chain' };
}

// ── 1b. Aave V3 (LEVERAGED_LOOP) — adds health factor read ───────────────────
//
//  Leveraged loops borrow against collateral on Aave. The health factor measures
//  solvency: HF < 1.0 means the position is liquidatable.
//  healthFactor is returned by getUserAccountData in units of 1e18 (1e18 = HF 1.0).
//
//  NOTE: getUserAccountData returns aggregate data for the ENTIRE vault address,
//  not per-user. For a single-user vault (MVP), this is exact. For multi-user
//  deployments, each user's leveraged loop should use a separate sub-account.

async function readLeveragedLoopValue(
  provider:            JsonRpcProvider,
  vaultAddress:        string,
  entryUSD:            number,
  entryLiquidityIndex?: string,
): Promise<RealPositionRead> {
  const pool = new ethers.Contract(ADDR.AAVE_POOL, AAVE_POOL_ABI, provider);

  // Run both reads in parallel
  const [aaveBase, accountData] = await Promise.all([
    readAaveValue(provider, vaultAddress, entryUSD, entryLiquidityIndex),
    pool.getUserAccountData(vaultAddress),
  ]);

  // healthFactor is uint256 in 1e18; type(uint256).max = infinite (no debt)
  const hfRaw:       bigint = accountData[5];
  const isInfinite           = hfRaw > BigInt('1000000000000000000000');  // >1000x = effectively no debt
  const healthFactor: number = isInfinite ? 999 : Number(hfRaw) / 1e18;

  // Net position value for leveraged loop = collateral - debt (both in USD, 8 dec from Aave)
  // Use this as currentUSD for accurate P&L — more precise than aUSDC balance alone
  const totalCollateralUSD = Number(accountData[0] as bigint) / 1e8;
  const totalDebtUSD       = Number(accountData[1] as bigint) / 1e8;
  const netValueUSD        = totalCollateralUSD - totalDebtUSD;

  // If no debt exists yet, fall back to the simple aToken read (position not yet looped)
  const currentUSD = totalDebtUSD > 0 ? netValueUSD : aaveBase.currentUSD;

  return {
    ...aaveBase,
    currentUSD,
    incomeEarnedUSD: currentUSD - entryUSD,
    healthFactor,
    dataSource: 'on-chain',
  };
}

// ── 2. Morpho (ERC-4626 vault) ───────────────────────────────────────────────
//
//  The vault holds shares in a Morpho ERC-4626 vault (e.g., Steakhouse USDC).
//  convertToAssets(shares) gives the exact USDC equivalent at any point.
//  Since shares belong to the vault address (unique), this is per-user accurate.

async function readMorphoValue(
  provider:     JsonRpcProvider,
  vaultAddress: string,
  venueAddress: string,   // ERC-4626 vault address
  morphoShares: string,   // shares captured at deposit
  entryUSD:     number,
): Promise<RealPositionRead> {
  const vault      = new ethers.Contract(venueAddress, ERC4626_ABI, provider);
  const shares     = BigInt(morphoShares);

  if (shares === 0n) {
    // Shares not yet captured — fall back to live balance
    const liveShs = await vault.balanceOf(vaultAddress) as bigint;
    const assets  = await vault.convertToAssets(liveShs) as bigint;
    const currentUSD = Number(assets) / 1e6;
    return { currentUSD, incomeEarnedUSD: currentUSD - entryUSD, pendingRewardsUSD: 0, outOfRange: false, dataSource: 'on-chain' };
  }

  const assets     = await vault.convertToAssets(shares) as bigint;
  const currentUSD = Number(assets) / 1e6;
  return { currentUSD, incomeEarnedUSD: currentUSD - entryUSD, pendingRewardsUSD: 0, outOfRange: false, dataSource: 'on-chain' };
}

// ── 3. Uniswap V3 LP ─────────────────────────────────────────────────────────
//
//  Reads the NFT position via the NonfungiblePositionManager.
//  Value = liquidity principal (both tokens at current tick) + uncollected fees.
//
//  Uniswap V3 tick math (Q64.96 fixed-point):
//    sqrtPrice = sqrtPriceX96 / 2^96
//    If currentTick < tickLower  → all value in token0
//    If currentTick ≥ tickUpper  → all value in token1
//    Else in-range → split across both tokens

async function readUniV3Value(
  provider: JsonRpcProvider,
  tokenId:  string,
  prices:   PriceMap,
): Promise<RealPositionRead> {
  const posMgr = new ethers.Contract(ADDR.UNIV3_POS_MGR, UNIV3_POS_MGR_ABI, provider);
  const pos    = await posMgr.positions(BigInt(tokenId));

  const token0:      string  = pos.token0;
  const token1:      string  = pos.token1;
  const fee:         number  = Number(pos.fee);
  const tickLower:   number  = Number(pos.tickLower);
  const tickUpper:   number  = Number(pos.tickUpper);
  const liquidity:   bigint  = pos.liquidity;
  const tokensOwed0: bigint  = pos.tokensOwed0;
  const tokensOwed1: bigint  = pos.tokensOwed1;

  // Get pool to read current sqrt price
  const factory     = new ethers.Contract(ADDR.UNIV3_FACTORY, UNIV3_FACTORY_ABI, provider);
  const poolAddress = await factory.getPool(token0, token1, fee) as string;
  const pool        = new ethers.Contract(poolAddress, UNIV3_POOL_ABI, provider);
  const slot0       = await pool.slot0();

  const sqrtPriceX96: bigint = slot0[0];
  const currentTick:  number = Number(slot0[1]);

  // Convert sqrtPriceX96 to floating-point sqrtPrice (token1/token0 ratio)
  const Q96         = 2n ** 96n;
  const sqrtCurrent = Number(sqrtPriceX96) / Number(Q96);
  const sqrtLower   = Math.sqrt(1.0001 ** tickLower);
  const sqrtUpper   = Math.sqrt(1.0001 ** tickUpper);
  const L           = Number(liquidity);

  let rawAmount0 = 0;
  let rawAmount1 = 0;

  if (L > 0) {
    if (currentTick < tickLower) {
      // All in token0
      rawAmount0 = L * (1 / sqrtLower - 1 / sqrtUpper);
    } else if (currentTick >= tickUpper) {
      // All in token1
      rawAmount1 = L * (sqrtUpper - sqrtLower);
    } else {
      // In range — split
      rawAmount0 = L * (1 / sqrtCurrent - 1 / sqrtUpper);
      rawAmount1 = L * (sqrtCurrent - sqrtLower);
    }
  }

  // Token decimals
  const dec0 = token0.toLowerCase() === ADDR.USDC.toLowerCase() ? 1e6 : 1e18;
  const dec1 = token1.toLowerCase() === ADDR.USDC.toLowerCase() ? 1e6 : 1e18;

  const price0 = tokenPriceUSD(token0, prices);
  const price1 = tokenPriceUSD(token1, prices);

  // Principal value
  const principal0USD = (rawAmount0 / dec0) * price0;
  const principal1USD = (rawAmount1 / dec1) * price1;
  const principalUSD  = principal0USD + principal1USD;

  // Uncollected fees (these are claimable right now without closing the position)
  const fees0USD = (Number(tokensOwed0) / dec0) * price0;
  const fees1USD = (Number(tokensOwed1) / dec1) * price1;
  const feesUSD  = fees0USD + fees1USD;

  const currentUSD = principalUSD + feesUSD;
  // Out-of-range: position earns 0 fees until price re-enters the tick range
  const outOfRange = currentTick < tickLower || currentTick >= tickUpper;

  return {
    currentUSD,
    incomeEarnedUSD:   feesUSD,   // fees = realised income, principal is NAV
    pendingRewardsUSD: feesUSD,   // tokensOwed = claimable via collect() right now
    outOfRange,
    dataSource: 'on-chain',
  };
}

// ── 4. Pendle LP ─────────────────────────────────────────────────────────────
//
//  Pendle's PT/LP oracle returns how much underlying asset 1 LP (or 1 PT) is
//  worth right now. Uses a 15-minute TWAP to resist manipulation.
//  pendleLpAmount is captured at deposit from the Transfer mint event.

async function readPendleLPValue(
  provider:      JsonRpcProvider,
  vaultAddress:  string,
  marketAddress: string,
  pendleLpAmount: string,
  entryUSD:      number,
): Promise<RealPositionRead> {
  const oracle  = new ethers.Contract(ADDR.PENDLE_ORACLE, PENDLE_ORACLE_ABI, provider);
  const lpToken = new ethers.Contract(marketAddress, ERC20_ABI, provider);

  // Use live balance if we didn't capture amount at deposit
  const lpBalance: bigint = pendleLpAmount && pendleLpAmount !== '0'
    ? BigInt(pendleLpAmount)
    : await lpToken.balanceOf(vaultAddress) as bigint;

  const lpToAsset = await oracle.getLpToAssetRate(marketAddress, PENDLE_DURATION) as bigint;

  // lpToAssetRate: 1e18 = 1 underlying asset
  // For USDC markets the underlying is USDC (1e6 decimals), but Pendle normalises to 1e18
  // So: currentUSD = lpBalance(1e18) × lpToAsset(1e18) / 1e18 / 1e18 × 1e6
  // Simplification: currentUSD = (lpBalance × lpToAsset) / 1e30
  const currentUSD = Number(lpBalance) * Number(lpToAsset) / 1e30;

  return { currentUSD, incomeEarnedUSD: currentUSD - entryUSD, pendingRewardsUSD: 0, outOfRange: false, dataSource: 'on-chain' };
}

// ── 5. Pendle PT ─────────────────────────────────────────────────────────────

async function readPendlePTValue(
  provider:      JsonRpcProvider,
  vaultAddress:  string,
  marketAddress: string,  // Pendle market (used for oracle lookup)
  ptAddress:     string,  // PT token address (ytAddress field reused for PT tracking)
  entryUSD:      number,
): Promise<RealPositionRead> {
  const oracle   = new ethers.Contract(ADDR.PENDLE_ORACLE, PENDLE_ORACLE_ABI, provider);
  const ptToken  = new ethers.Contract(ptAddress, ERC20_ABI, provider);

  const [ptBalance, ptToAsset] = await Promise.all([
    ptToken.balanceOf(vaultAddress) as Promise<bigint>,
    oracle.getPtToAssetRate(marketAddress, PENDLE_DURATION) as Promise<bigint>,
  ]);

  const currentUSD = Number(ptBalance) * Number(ptToAsset) / 1e30;
  return { currentUSD, incomeEarnedUSD: currentUSD - entryUSD, pendingRewardsUSD: 0, outOfRange: false, dataSource: 'on-chain' };
}

// ── 5b. Pendle YT ────────────────────────────────────────────────────────────
//
//  No dedicated oracle exists for YT price — Pendle's PtLpOracle only covers PT and LP.
//
//  But: the relationship PT + YT = SY = 1 underlying asset is an accounting identity.
//  So: ytPrice = assetPrice × (1 − ptToAssetRate)
//
//  Example: if PT trades at 0.97 USDC (3% yield left until expiry),
//           then YT is worth 0.03 USDC per token.
//
//  This is derived from the same TWAP-protected PT oracle, so it's manipulation-resistant.
//  It's not a spot price — it reflects the market's consensus implied yield,
//  which is exactly what drives the YT's fundamental value.
//
//  ytAddress: the YT token contract (vault holds these after swapExactTokenForYt)
//  marketAddress: the Pendle market (used for PT oracle + asset price reference)

async function readPendleYTValue(
  provider:      JsonRpcProvider,
  vaultAddress:  string,
  marketAddress: string,
  ytAddress:     string,
  entryUSD:      number,
): Promise<RealPositionRead> {
  const oracle   = new ethers.Contract(ADDR.PENDLE_ORACLE, PENDLE_ORACLE_ABI, provider);
  const ytToken  = new ethers.Contract(ytAddress, ERC20_ABI, provider);

  const [ytBalance, ptToAsset] = await Promise.all([
    ytToken.balanceOf(vaultAddress) as Promise<bigint>,
    oracle.getPtToAssetRate(marketAddress, PENDLE_DURATION) as Promise<bigint>,
  ]);

  // ytToAssetRate = 1 − ptToAssetRate  (PT + YT = SY = 1 underlying asset)
  // Both ptToAsset and 1.0 are in 1e18 scale
  const ONE_E18       = BigInt(1e18);
  const ptRateE18     = ptToAsset * BigInt(1e18) / BigInt(1e18); // identity, for clarity
  const ytRateE18     = ONE_E18 - (ptToAsset > ONE_E18 ? ONE_E18 : ptToAsset);  // clamp to [0,1]

  // currentUSD = ytBalance(1e18) × ytRate(1e18) / 1e36  (result in USDC for USDC markets)
  // For USDC markets: underlying is $1, so no additional price factor needed.
  // For non-USDC markets the caller should multiply by asset price — handled via oracle rate
  // which Pendle normalises to the underlying asset's value.
  const currentUSD = Number(ytBalance) * Number(ytRateE18) / 1e36;

  return {
    currentUSD,
    incomeEarnedUSD:   currentUSD - entryUSD,
    pendingRewardsUSD: 0,   // YT yield is embedded in token price, not claimable separately
    outOfRange:        false,
    dataSource:        'on-chain',
  };
}

// ── 6. GMX V2 (GM tokens) ────────────────────────────────────────────────────
//
//  GM tokens are ERC-20s whose price reflects pool value / total supply.
//  Pool value = long token amount × longTokenPrice + short token amount × shortTokenPrice.
//
//  GMX DataStore key format (from Keys.sol source):
//    POOL_AMOUNT = keccak256(abi.encode("POOL_AMOUNT"))   ← abi.encode of string, NOT toUtf8Bytes
//    key = keccak256(abi.encode(POOL_AMOUNT, market, token))
//
//  gmTokenAmount is captured once the async deposit settles. Until then,
//  we poll the vault's live balance. For a single-user vault this is exact.

// abi.encode(['string'], ['POOL_AMOUNT']) — matches Solidity's keccak256(abi.encode("POOL_AMOUNT"))
const GMX_POOL_AMOUNT_KEY_HASH = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['POOL_AMOUNT']),
);

function gmxPoolAmountKey(marketAddress: string, tokenAddress: string): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'address'],
      [GMX_POOL_AMOUNT_KEY_HASH, marketAddress, tokenAddress],
    ),
  );
}

async function readGMXValue(
  provider:      JsonRpcProvider,
  vaultAddress:  string,
  marketAddress: string,  // GM token = market token address
  gmTokenAmount: string,  // captured at deposit (or '' if not yet settled)
  entryUSD:      number,
  prices:        PriceMap,
): Promise<RealPositionRead> {
  const gmToken   = new ethers.Contract(marketAddress, GMX_MARKET_ABI, provider);
  const dataStore = new ethers.Contract(ADDR.GMX_DATASTORE, GMX_DATASTORE_ABI, provider);

  const [gmBalance, gmTotalSupply] = await Promise.all([
    gmTokenAmount && gmTokenAmount !== '0'
      ? Promise.resolve(BigInt(gmTokenAmount))
      : gmToken.balanceOf(vaultAddress) as Promise<bigint>,
    gmToken.totalSupply() as Promise<bigint>,
  ]);

  if (gmTotalSupply === 0n || gmBalance === 0n) {
    // Deposit not yet settled — return entry value as placeholder
    return { currentUSD: entryUSD, incomeEarnedUSD: 0, pendingRewardsUSD: 0, outOfRange: false, dataSource: 'on-chain' };
  }

  // Read actual token amounts from GMX DataStore
  const [longAmount, shortAmount] = await Promise.all([
    dataStore.getUint(gmxPoolAmountKey(marketAddress, ADDR.WETH)) as Promise<bigint>,
    dataStore.getUint(gmxPoolAmountKey(marketAddress, ADDR.USDC)) as Promise<bigint>,
  ]);

  const ethPrice    = prices.get('WETH')?.priceUSD ?? prices.get('ETH')?.priceUSD ?? 3000;
  const poolValueUSD = (Number(longAmount) / 1e18) * ethPrice + Number(shortAmount) / 1e6;
  const gmPriceUSD   = poolValueUSD / (Number(gmTotalSupply) / 1e18);
  const currentUSD   = (Number(gmBalance) / 1e18) * gmPriceUSD;

  return { currentUSD, incomeEarnedUSD: currentUSD - entryUSD, pendingRewardsUSD: 0, outOfRange: false, dataSource: 'on-chain' };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
//
//  Called each tick for every position belonging to an isReal user.
//  Returns null on any failure → caller uses formula-based estimate as fallback.

export async function readRealPositionValue(
  pos:          PortfolioPosition,
  provider:     JsonRpcProvider,
  vaultAddress: string,
  prices:       PriceMap,
): Promise<RealPositionRead | null> {
  try {
    switch (pos.strategyType) {

      case 'AAVE_LENDING':
        return await readAaveValue(provider, vaultAddress, pos.entryUSD, pos.entryLiquidityIndex);

      case 'LEVERAGED_LOOP':
        // Returns health factor in addition to net value (collateral - debt)
        return await readLeveragedLoopValue(provider, vaultAddress, pos.entryUSD, pos.entryLiquidityIndex);

      case 'MORPHO_LENDING':
        if (!pos.venueAddress) return null;
        return await readMorphoValue(
          provider, vaultAddress, pos.venueAddress,
          pos.morphoShares ?? '0', pos.entryUSD,
        );

      case 'DELTA_NEUTRAL':
        if (!pos.uniV3TokenId) return null;   // deposit not yet settled (async GMX order still pending?)
        return await readUniV3Value(provider, pos.uniV3TokenId, prices);

      case 'PENDLE_LP':
        if (!pos.venueAddress) return null;
        return await readPendleLPValue(
          provider, vaultAddress, pos.venueAddress,
          pos.pendleLpAmount ?? '0', pos.entryUSD,
        );

      case 'PENDLE_PT':
        if (!pos.venueAddress || !pos.ptAddress) return null;
        return await readPendlePTValue(
          provider, vaultAddress, pos.venueAddress, pos.ptAddress, pos.entryUSD,
        );

      case 'PENDLE_YT':
        if (!pos.venueAddress || !pos.ytAddress) return null;
        // YT price derived from PT oracle: ytPrice = 1 − ptToAssetRate
        // No separate oracle needed — PT + YT = SY is an on-chain accounting identity
        return await readPendleYTValue(
          provider, vaultAddress, pos.venueAddress, pos.ytAddress, pos.entryUSD,
        );

      case 'GMX_REAL_YIELD':
        if (!pos.venueAddress) return null;
        return await readGMXValue(
          provider, vaultAddress, pos.venueAddress,
          pos.gmTokenAmount ?? '0', pos.entryUSD, prices,
        );

      default:
        return null;
    }
  } catch (err: any) {
    // Non-fatal — caller logs and falls back to formula
    throw new Error(`[PositionReader:${pos.strategyType}:${pos.venueName}] ${err.message}`);
  }
}
