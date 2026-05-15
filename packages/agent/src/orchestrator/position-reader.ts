

import { ethers, type JsonRpcProvider } from 'ethers';
import type { PortfolioPosition } from './types';
import type { PriceMap } from './protocols/chainlink';

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
];

const ERC4626_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
];

const AAVE_POOL_ABI = [
  
  
  'function getReserveNormalizedIncome(address asset) view returns (uint256)',
  
  
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
  
  'function balanceOf(address account) view returns (uint256)',
  
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
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
];

const UNIV3_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
];

const UNIV3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];

const PENDLE_ORACLE_ABI = [
  
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

const ADDR = {
  AAVE_POOL:      '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  AUSDC:          '0x625E7708f30cA75bfd92586e17077590C60eb4cD',
  UNIV3_POS_MGR:  '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  UNIV3_FACTORY:  '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  PENDLE_ORACLE:  '0x9a9Fa8338dd5E5B2188006f1Cd2Ef26d921650C2',
  GMX_DATASTORE:  '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8',
  USDC:           '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  USDT:           '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  DAI:            '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
  USDC_E:         '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
  WETH:           '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  WBTC:           '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
  ARB:            '0x912CE59144191C1204E64559FE8253a0e49E6548',
} as const;

const TOKEN_DECIMALS: Record<string, number> = {
  [ADDR.USDC.toLowerCase()]:   6,
  [ADDR.USDT.toLowerCase()]:   6,
  [ADDR.USDC_E.toLowerCase()]: 6,
  [ADDR.DAI.toLowerCase()]:    18,
  [ADDR.WETH.toLowerCase()]:   18,
  [ADDR.WBTC.toLowerCase()]:   8,
  [ADDR.ARB.toLowerCase()]:    18,
};

const PENDLE_DURATION = 900;

export interface RealPositionRead {
  currentUSD:        number;
  incomeEarnedUSD:   number;   
  pendingRewardsUSD: number;   
  currentUSDExact?:        string;
  incomeEarnedUSDExact?:   string;
  pendingRewardsUSDExact?: string;
  outOfRange:        boolean;  
  healthFactor?:     number;   
  uniV3Fees?: {
    token0:          string;
    token1:          string;
    token0Decimals:  number;
    token1Decimals:  number;
    tokensOwed0Raw:  string;
    tokensOwed1Raw:  string;
    tokensOwed0:     string;
    tokensOwed1:     string;
    fees0USD:        number;
    fees1USD:        number;
    fees0USDExact:   string;
    fees1USDExact:   string;
    feesUSDExact:    string;
  };
  dataSource:        'on-chain';
}

function tokenPriceUSD(tokenAddress: string, prices: PriceMap): number {
  const addr = tokenAddress.toLowerCase();
  if (addr === ADDR.USDC.toLowerCase())  return 1.0;
  if (addr === ADDR.USDT.toLowerCase())  return 1.0;
  if (addr === ADDR.USDC_E.toLowerCase()) return 1.0;
  if (addr === ADDR.DAI.toLowerCase())   return 1.0;
  if (addr === ADDR.WETH.toLowerCase())  return prices.get('WETH')?.priceUSD ?? prices.get('ETH')?.priceUSD ?? 3000;
  if (addr === ADDR.WBTC.toLowerCase())  return prices.get('WBTC')?.priceUSD ?? prices.get('BTC')?.priceUSD ?? 60000;
  if (addr === ADDR.ARB.toLowerCase())   return prices.get('ARB')?.priceUSD ?? 1.0;
  return 1.0;
}

function tokenDecimals(tokenAddress: string): number {
  return TOKEN_DECIMALS[tokenAddress.toLowerCase()] ?? 18;
}

function isDollarLikeToken(tokenAddress: string): boolean {
  const addr = tokenAddress.toLowerCase();
  return addr === ADDR.USDC.toLowerCase()
    || addr === ADDR.USDT.toLowerCase()
    || addr === ADDR.USDC_E.toLowerCase()
    || addr === ADDR.DAI.toLowerCase();
}

function addDecimalStrings(a: string, b: string): string {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const scale = Math.max(af.length, bf.length);
  const av = BigInt(ai || '0') * (10n ** BigInt(scale)) + BigInt((af.padEnd(scale, '0') || '0'));
  const bv = BigInt(bi || '0') * (10n ** BigInt(scale)) + BigInt((bf.padEnd(scale, '0') || '0'));
  const sum = av + bv;
  const base = 10n ** BigInt(scale);
  const intPart = sum / base;
  const fracPart = (sum % base).toString().padStart(scale, '0').replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart.toString();
}

function feeUSDExactString(tokenAddress: string, amountRaw: bigint, decimals: number, numericUSD: number): string {
  if (amountRaw === 0n) return '0';
  if (isDollarLikeToken(tokenAddress)) return ethers.formatUnits(amountRaw, decimals);
  return Number.isFinite(numericUSD) ? numericUSD.toString() : '0';
}

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
    
    
    
    
    
    currentUSD = entryUSD;
  }

  return { currentUSD, incomeEarnedUSD: currentUSD - entryUSD, pendingRewardsUSD: 0, outOfRange: false, dataSource: 'on-chain' };
}

async function readLeveragedLoopValue(
  provider:            JsonRpcProvider,
  vaultAddress:        string,
  entryUSD:            number,
  entryLiquidityIndex?: string,
): Promise<RealPositionRead> {
  const pool = new ethers.Contract(ADDR.AAVE_POOL, AAVE_POOL_ABI, provider);

  
  
  
  const [aaveBase, accountData] = await Promise.all([
    readAaveValue(provider, vaultAddress, entryUSD, entryLiquidityIndex),
    pool.getUserAccountData(vaultAddress),
  ]);

  
  const hfRaw:       bigint = accountData[5];
  const isInfinite           = hfRaw > BigInt('1000000000000000000000');  
  const healthFactor: number = isInfinite ? 999 : Number(hfRaw) / 1e18;

  
  
  const totalCollateralBase: bigint = accountData[0] as bigint;
  const totalCollateralUSD = Number(totalCollateralBase) / 1e8;
  const totalDebtUSD       = Number(accountData[1] as bigint) / 1e8;
  const netValueUSD        = totalCollateralUSD - totalDebtUSD;

  
  
  if (totalCollateralBase === 0n) {
    return {
      ...aaveBase,
      currentUSD:      entryUSD,
      incomeEarnedUSD: 0,
      healthFactor,
      dataSource:      'on-chain',
    };
  }

  
  const currentUSD = totalDebtUSD > 0 ? netValueUSD : aaveBase.currentUSD;

  return {
    ...aaveBase,
    currentUSD,
    incomeEarnedUSD: currentUSD - entryUSD,
    healthFactor,
    dataSource: 'on-chain',
  };
}

async function readMorphoValue(
  provider:     JsonRpcProvider,
  vaultAddress: string,
  venueAddress: string,   
  morphoShares: string,   
  entryUSD:     number,
): Promise<RealPositionRead> {
  const vault      = new ethers.Contract(venueAddress, ERC4626_ABI, provider);
  const shares     = BigInt(morphoShares);

  if (shares === 0n) {
    
    
    
    
    return { currentUSD: entryUSD, incomeEarnedUSD: 0, pendingRewardsUSD: 0, outOfRange: false, dataSource: 'on-chain' };
  }

  const assets     = await vault.convertToAssets(shares) as bigint;
  const currentUSD = Number(assets) / 1e6;
  return { currentUSD, incomeEarnedUSD: currentUSD - entryUSD, pendingRewardsUSD: 0, outOfRange: false, dataSource: 'on-chain' };
}

async function readUniV3Value(
  provider:       JsonRpcProvider,
  tokenId:        string,
  prices:         PriceMap,
  userAddress?:   string,
  vaultAddress?:  string,
  prefetched?:    import('./driftMonitor').DriftResult,
): Promise<RealPositionRead> {
  const posMgr = new ethers.Contract(ADDR.UNIV3_POS_MGR, UNIV3_POS_MGR_ABI, provider);
  
  let token0: string = '', token1: string = '', fee: number = 0, tickLower: number = 0, tickUpper: number = 0;
  let liquidity: bigint = 0n, tokensOwed0: bigint = 0n, tokensOwed1: bigint = 0n, fg0Last: bigint = 0n, fg1Last: bigint = 0n;
  let sqrtPriceX96: bigint = 0n, currentTick: number = 0;
  let fg0Global: bigint = 0n, fg1Global: bigint = 0n, lowerTick: any = null, upperTick: any = null;
  let poolAddress: string = '';

  if (prefetched) {
    
    token0       = prefetched.token0;
    token1       = prefetched.token1;
    fee          = prefetched.fee;
    tickLower    = prefetched.tickLower;
    tickUpper    = prefetched.tickUpper;
    liquidity    = prefetched.liquidity;
    tokensOwed0  = prefetched.tokensOwed0;
    tokensOwed1  = prefetched.tokensOwed1;
    fg0Last      = prefetched.feeGrowthInside0LastX128;
    fg1Last      = prefetched.feeGrowthInside1LastX128;
    currentTick  = prefetched.currentTick;
    sqrtPriceX96 = prefetched.sqrtPriceX96;
    poolAddress  = prefetched.poolAddress;
  } else {
    
    let pos: any;
    try {
      pos = await posMgr.positions(BigInt(tokenId));
      token0      = pos.token0;
      token1      = pos.token1;
      fee         = Number(pos.fee);
      tickLower   = Number(pos.tickLower);
      tickUpper   = Number(pos.tickUpper);
      liquidity   = pos.liquidity;
      tokensOwed0 = pos.tokensOwed0;
      tokensOwed1 = pos.tokensOwed1;
      fg0Last     = pos.feeGrowthInside0LastX128;
      fg1Last     = pos.feeGrowthInside1LastX128;
    } catch (err: any) {
      if (err?.reason === 'Invalid token ID' || String(err?.message ?? '').includes('Invalid token ID')) {
        return { currentUSD: 0, incomeEarnedUSD: 0, pendingRewardsUSD: 0, outOfRange: false, dataSource: 'on-chain', nftBurned: true } as any;
      }
      throw err;
    }

    
    const factory     = new ethers.Contract(ADDR.UNIV3_FACTORY, UNIV3_FACTORY_ABI, provider);
    poolAddress = await factory.getPool(token0, token1, fee) as string;
  }

  const pool = new ethers.Contract(poolAddress, UNIV3_POOL_ABI, provider);

  
  
  const [slot0Res, fg0GlobalRes, fg1GlobalRes, lowerTickRes, upperTickRes] = await Promise.all([
    prefetched ? Promise.resolve([sqrtPriceX96, currentTick]) : pool.slot0(),
    pool.feeGrowthGlobal0X128() as Promise<bigint>,
    pool.feeGrowthGlobal1X128() as Promise<bigint>,
    pool.ticks(tickLower),
    pool.ticks(tickUpper),
  ]);

  fg0Global = fg0GlobalRes;
  fg1Global = fg1GlobalRes;
  lowerTick = lowerTickRes;
  upperTick = upperTickRes;

  if (!prefetched) {
    sqrtPriceX96 = slot0Res[0];
    currentTick  = Number(slot0Res[1]);
  }

  
  const Q96         = 2n ** 96n;
  const sqrtCurrent = Number(sqrtPriceX96) / Number(Q96);
  const sqrtLower   = Math.sqrt(1.0001 ** tickLower);
  const sqrtUpper   = Math.sqrt(1.0001 ** tickUpper);
  const L           = Number(liquidity);

  let rawAmount0 = 0;
  let rawAmount1 = 0;

  if (L > 0) {
    if (currentTick < tickLower) {
      
      rawAmount0 = L * (1 / sqrtLower - 1 / sqrtUpper);
    } else if (currentTick >= tickUpper) {
      
      rawAmount1 = L * (sqrtUpper - sqrtLower);
    } else {
      
      rawAmount0 = L * (1 / sqrtCurrent - 1 / sqrtUpper);
      rawAmount1 = L * (sqrtCurrent - sqrtLower);
    }
  }

  
  const token0Decimals = tokenDecimals(token0);
  const token1Decimals = tokenDecimals(token1);
  const dec0 = 10 ** token0Decimals;
  const dec1 = 10 ** token1Decimals;

  const price0 = tokenPriceUSD(token0, prices);
  const price1 = tokenPriceUSD(token1, prices);

  
  const principal0USD = (rawAmount0 / dec0) * price0;
  const principal1USD = (rawAmount1 / dec1) * price1;
  const principalUSD  = principal0USD + principal1USD;

  
  
  
  
  
  
  
  
  const hasPrincipal = liquidity > 0n;
  let fees0USD = 0;
  let fees1USD = 0;
  if (hasPrincipal) {
    try {
      const Q128  = 2n ** 128n;
      const Q256  = 2n ** 256n;
      const sub256 = (a: bigint, b: bigint): bigint => ((a - b) % Q256 + Q256) % Q256;

      const fgGlobal0 = BigInt(fg0Global);
      const fgGlobal1 = BigInt(fg1Global);
      const fg0OutLower = BigInt(lowerTick[2]);
      const fg1OutLower = BigInt(lowerTick[3]);
      const fg0OutUpper = BigInt(upperTick[2]);
      const fg1OutUpper = BigInt(upperTick[3]);

      const fg0Below = currentTick >= tickLower ? fg0OutLower : sub256(fgGlobal0, fg0OutLower);
      const fg1Below = currentTick >= tickLower ? fg1OutLower : sub256(fgGlobal1, fg1OutLower);
      const fg0Above = currentTick <  tickUpper ? fg0OutUpper : sub256(fgGlobal0, fg0OutUpper);
      const fg1Above = currentTick <  tickUpper ? fg1OutUpper : sub256(fgGlobal1, fg1OutUpper);

      const fg0Inside = sub256(sub256(fgGlobal0, fg0Below), fg0Above);
      const fg1Inside = sub256(sub256(fgGlobal1, fg1Below), fg1Above);

      const pending0 = sub256(fg0Inside, BigInt(fg0Last)) * liquidity / Q128 + tokensOwed0;
      const pending1 = sub256(fg1Inside, BigInt(fg1Last)) * liquidity / Q128 + tokensOwed1;

      fees0USD = (Number(pending0) / dec0) * price0;
      fees1USD = (Number(pending1) / dec1) * price1;
    } catch {
      
      fees0USD = (Number(tokensOwed0) / dec0) * price0;
      fees1USD = (Number(tokensOwed1) / dec1) * price1;
    }
  }
  const feesUSD  = fees0USD + fees1USD;
  const fees0USDExact = hasPrincipal ? feeUSDExactString(token0, tokensOwed0, token0Decimals, fees0USD) : '0';
  const fees1USDExact = hasPrincipal ? feeUSDExactString(token1, tokensOwed1, token1Decimals, fees1USD) : '0';
  const feesUSDExact = isDollarLikeToken(token0) && isDollarLikeToken(token1)
    ? addDecimalStrings(fees0USDExact, fees1USDExact)
    : feesUSD.toString();

  
  
  
  
  
  
  let idleNAV = 0;
  if (!hasPrincipal && userAddress) {
    try {
      let idle0 = 0n, idle1 = 0n;

      
      if (vaultAddress) {
        const vaultC = new ethers.Contract(vaultAddress, ['function balances(address,address) view returns (uint256)'], provider);
        [idle0, idle1] = await Promise.all([
          vaultC.balances(userAddress, token0).catch(() => 0n) as Promise<bigint>,
          vaultC.balances(userAddress, token1).catch(() => 0n) as Promise<bigint>,
        ]);
      }

      
      if (idle0 === 0n && idle1 === 0n) {
        const erc20ABI = ['function balanceOf(address) view returns (uint256)'];
        const [bal0, bal1] = await Promise.all([
          new ethers.Contract(token0, erc20ABI, provider).balanceOf(userAddress).catch(() => 0n) as Promise<bigint>,
          new ethers.Contract(token1, erc20ABI, provider).balanceOf(userAddress).catch(() => 0n) as Promise<bigint>,
        ]);
        idle0 = bal0; idle1 = bal1;
      }

      idleNAV = (Number(idle0) / dec0) * price0 + (Number(idle1) / dec1) * price1;

      
      if (idleNAV < 0.01 && userAddress) {
        const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
        if (token0.toLowerCase() !== USDC_ARB.toLowerCase() && token1.toLowerCase() !== USDC_ARB.toLowerCase()) {
          const usdcBal = await new ethers.Contract(USDC_ARB, ['function balanceOf(address) view returns (uint256)'], provider).balanceOf(userAddress).catch(() => 0n) as bigint;
          if (usdcBal > 0n) {
            idleNAV += Number(usdcBal) / 1_000_000;
          }
        }
      }
    } catch (err: any) {
      console.warn(`[Reader] Idle balance check failed: ${err.message}`);
    }
  }
  
  
  
  
  const currentUSD = hasPrincipal ? principalUSD : idleNAV;
  
  const outOfRange = currentTick < tickLower || currentTick >= tickUpper;

  return {
    currentUSD,
    incomeEarnedUSD:   feesUSD,   
    pendingRewardsUSD: feesUSD,   
    currentUSDExact:        currentUSD.toString(),
    incomeEarnedUSDExact:   feesUSDExact,
    pendingRewardsUSDExact: feesUSDExact,
    outOfRange,
    uniV3Fees: {
      token0,
      token1,
      token0Decimals,
      token1Decimals,
      tokensOwed0Raw: tokensOwed0.toString(),
      tokensOwed1Raw: tokensOwed1.toString(),
      tokensOwed0:    ethers.formatUnits(tokensOwed0, token0Decimals),
      tokensOwed1:    ethers.formatUnits(tokensOwed1, token1Decimals),
      fees0USD,
      fees1USD,
      fees0USDExact,
      fees1USDExact,
      feesUSDExact,
    },
    dataSource: 'on-chain',
  };
}

async function readPendleLPValue(
  provider:      JsonRpcProvider,
  vaultAddress:  string,
  marketAddress: string,
  pendleLpAmount: string,
  entryUSD:      number,
): Promise<RealPositionRead> {
  const oracle  = new ethers.Contract(ADDR.PENDLE_ORACLE, PENDLE_ORACLE_ABI, provider);
  const lpToken = new ethers.Contract(marketAddress, ERC20_ABI, provider);

  
  const lpBalance: bigint = pendleLpAmount && pendleLpAmount !== '0'
    ? BigInt(pendleLpAmount)
    : await lpToken.balanceOf(vaultAddress) as bigint;

  const lpToAsset = await oracle.getLpToAssetRate(marketAddress, PENDLE_DURATION) as bigint;

  
  
  
  
  const currentUSD = Number(lpBalance) * Number(lpToAsset) / 1e30;

  return { currentUSD, incomeEarnedUSD: currentUSD - entryUSD, pendingRewardsUSD: 0, outOfRange: false, dataSource: 'on-chain' };
}

async function readPendlePTValue(
  provider:      JsonRpcProvider,
  vaultAddress:  string,
  marketAddress: string,  
  ptAddress:     string,  
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

  
  
  const ONE_E18       = BigInt(1e18);
  const ptRateE18     = ptToAsset * BigInt(1e18) / BigInt(1e18); 
  const ytRateE18     = ONE_E18 - (ptToAsset > ONE_E18 ? ONE_E18 : ptToAsset);  

  
  
  
  
  const currentUSD = Number(ytBalance) * Number(ytRateE18) / 1e36;

  return {
    currentUSD,
    incomeEarnedUSD:   currentUSD - entryUSD,
    pendingRewardsUSD: 0,   
    outOfRange:        false,
    dataSource:        'on-chain',
  };
}

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
  marketAddress: string,  
  gmTokenAmount: string,  
  entryUSD:      number,
  prices:        PriceMap,
): Promise<RealPositionRead> {
  const gmToken   = new ethers.Contract(marketAddress, GMX_MARKET_ABI, provider);
  const dataStore = new ethers.Contract(ADDR.GMX_DATASTORE, GMX_DATASTORE_ABI, provider);

  
  
  
  
  const hasAmount = gmTokenAmount && gmTokenAmount !== '0';
  const [gmBalance, gmTotalSupply] = await Promise.all([
    hasAmount
      ? Promise.resolve(BigInt(gmTokenAmount))
      : Promise.resolve(0n),   
    gmToken.totalSupply() as Promise<bigint>,
  ]);

  if (gmTotalSupply === 0n || gmBalance === 0n) {
    
    return { currentUSD: entryUSD, incomeEarnedUSD: 0, pendingRewardsUSD: 0, outOfRange: false, dataSource: 'on-chain' };
  }

  
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

export async function readRealPositionValue(
  pos:            PortfolioPosition,
  provider:       JsonRpcProvider,
  vaultAddress:   string,
  prices:         PriceMap,
  userAddress?:   string,
  batchPositions?: import('./protocols').UserOnChainPositions,
): Promise<RealPositionRead | null> {
  try {
    
    if (batchPositions) {
      switch (pos.strategyType) {
        case 'AAVE_LENDING':
        case 'LEVERAGED_LOOP': {
          const aave = batchPositions.aave.find(a => a.aTokenAddress.toLowerCase() === pos.venueAddress?.toLowerCase() || a.symbol === pos.asset);
          if (aave) {
            return {
              currentUSD:        aave.balanceUSD,
              incomeEarnedUSD:   aave.balanceUSD - pos.entryUSD,
              pendingRewardsUSD: 0,
              outOfRange:        false,
              healthFactor:      aave.healthFactor,
              dataSource:        'on-chain',
            };
          }
          break;
        }
        case 'GMX_REAL_YIELD': {
          const gmx = batchPositions.gmx.find(g => g.gmToken.toLowerCase() === pos.venueAddress?.toLowerCase() || g.market === pos.venueName);
          if (gmx) {
            return {
              currentUSD:        gmx.positionUSD,
              incomeEarnedUSD:   gmx.positionUSD - pos.entryUSD,
              pendingRewardsUSD: 0,
              outOfRange:        false,
              dataSource:        'on-chain',
            };
          }
          break;
        }
        case 'MORPHO_LENDING': {
          const morpho = batchPositions.morpho.find(m => m.vault === pos.venueName);
          if (morpho) {
            return {
              currentUSD:        morpho.valueUSD,
              incomeEarnedUSD:   morpho.valueUSD - pos.entryUSD,
              pendingRewardsUSD: 0,
              outOfRange:        false,
              dataSource:        'on-chain',
            };
          }
          break;
        }
        case 'PENDLE_PT':
        case 'PENDLE_LP': {
          const pendle = batchPositions.pendle.find(p => p.market === pos.venueName);
          if (pendle) {
            const currentUSD = pos.strategyType === 'PENDLE_PT' ? pendle.ptValueUSD : pendle.lpValueUSD;
            return {
              currentUSD,
              incomeEarnedUSD:   currentUSD - pos.entryUSD,
              pendingRewardsUSD: 0,
              outOfRange:        false,
              dataSource:        'on-chain',
            };
          }
          break;
        }
        case 'DELTA_NEUTRAL': {
          const uni = batchPositions.uniV3;
          if (uni && uni.tokenId.toString() === pos.uniV3TokenId) {
             
             
             return await readUniV3Value(provider, pos.uniV3TokenId, prices, userAddress, vaultAddress, uni);
          }
          break;
        }
      }
    }

    
    switch (pos.strategyType) {
      case 'AAVE_LENDING':
        return await readAaveValue(provider, vaultAddress, pos.entryUSD, pos.entryLiquidityIndex);

      case 'LEVERAGED_LOOP':
        return await readLeveragedLoopValue(provider, vaultAddress, pos.entryUSD, pos.entryLiquidityIndex);

      case 'MORPHO_LENDING':
        if (!pos.venueAddress) return null;
        return await readMorphoValue(
          provider, vaultAddress, pos.venueAddress,
          pos.morphoShares ?? '0', pos.entryUSD,
        );

      case 'DELTA_NEUTRAL':
        if (!pos.uniV3TokenId) return null;
        return await readUniV3Value(provider, pos.uniV3TokenId, prices, userAddress, vaultAddress);

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
    
    throw new Error(`[PositionReader:${pos.strategyType}:${pos.venueName}] ${err.message}`);
  }
}
