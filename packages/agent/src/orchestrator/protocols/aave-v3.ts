import { Contract, Interface, JsonRpcProvider } from 'ethers';
import type { PriceMap } from './chainlink';
import { getPrice } from './chainlink';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const POOL       = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
const DATA_PROV  = '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654';
const RAY        = 10n ** 27n;

export const AAVE_ASSETS: Record<string, { address: string; decimals: number; symbol: string }> = {
  USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6,  symbol: 'USDC' },
  USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6,  symbol: 'USDT' },
  WETH: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18, symbol: 'WETH' },
  WBTC: { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8,  symbol: 'WBTC' },
  ARB:  { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18, symbol: 'ARB'  },
  DAI:  { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, symbol: 'DAI'  },
};

export interface AaveMarket {
  symbol:         string;
  asset:          string;        
  supplyAPY:      number;        
  borrowAPY:      number;
  utilizationPct: number;
  liquidityUSD:   number;        
  totalDebtUSD:   number;
  aTokenAddress:  string;
  updatedAt:      number;
}

export interface AaveUserPosition {
  symbol:          string;
  asset:           string;
  aTokenAddress:   string;
  balanceRaw:      bigint;       
  balanceUSD:      number;
  currentSupplyAPY: number;
  healthFactor:    number;       
  isDeposited:     boolean;
}

const MC3_ABI  = ['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)'];
const POOL_ABI = [
  'function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasuryScaled, uint128 totalAToken, uint128 totalStableDebt, uint128 totalVariableDebt)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
];
const ERC20_ABI = ['function balanceOf(address account) view returns (uint256)'];

function rayToAPY(rayRate: bigint): number {
  
  const ratePerSecond = Number(rayRate) / Number(RAY);
  return ((1 + ratePerSecond) ** (365 * 24 * 3600) - 1) * 100;
}

function rayToBorrowAPY(rayRate: bigint): number {
  const ratePerSecond = Number(rayRate) / Number(RAY);
  return ((1 + ratePerSecond) ** (365 * 24 * 3600) - 1) * 100;
}

export async function fetchAaveMarkets(
  provider: JsonRpcProvider,
  prices:   PriceMap,
): Promise<AaveMarket[]> {
  const mc    = new Contract(MULTICALL3, MC3_ABI, provider);
  const iface = new Interface(POOL_ABI);
  const syms  = Object.keys(AAVE_ASSETS);

  const calls = syms.map(sym => ({
    target:       POOL,
    allowFailure: true,
    callData:     iface.encodeFunctionData('getReserveData', [AAVE_ASSETS[sym].address]),
  }));

  const markets: AaveMarket[] = [];

  try {
    const raw: { success: boolean; returnData: string }[] = await mc.aggregate3(calls);

    for (let i = 0; i < syms.length; i++) {
      const sym = syms[i];
      const { success, returnData } = raw[i];
      if (!success || !returnData || returnData === '0x') continue;

      try {
        const d = iface.decodeFunctionResult('getReserveData', returnData);

        const liquidityRate  = BigInt(d[2].toString());
        const variableBorrow = BigInt(d[4].toString());
        const aTokenAddress  = d[8] as string;
        const totalAToken    = BigInt(d[13].toString());
        const totalStable    = BigInt(d[14].toString());
        const totalVariable  = BigInt(d[15].toString());

        const totalDebt  = totalStable + totalVariable;
        const totalBase  = totalAToken + totalDebt;
        const util       = totalBase > 0n ? Number(totalDebt * 10_000n / totalBase) / 100 : 0;

        const dec         = AAVE_ASSETS[sym].decimals;
        const price       = getPrice(prices, sym);
        const liquidityUSD = Number(totalAToken) / 10 ** dec * price;
        const debtUSD      = Number(totalDebt)   / 10 ** dec * price;

        markets.push({
          symbol:         sym,
          asset:          AAVE_ASSETS[sym].address,
          supplyAPY:      rayToAPY(liquidityRate),
          borrowAPY:      rayToBorrowAPY(variableBorrow),
          utilizationPct: util,
          liquidityUSD,
          totalDebtUSD:   debtUSD,
          aTokenAddress,
          updatedAt:      Date.now(),
        });
      } catch {  }
    }
  } catch {  }

  return markets;
}

export async function fetchAaveBatchPositions(
  userAddresses: string[],
  markets:       AaveMarket[],
  provider:      JsonRpcProvider,
  prices:        PriceMap,
): Promise<Map<string, AaveUserPosition[]>> {
  if (markets.length === 0 || userAddresses.length === 0) return new Map();

  const mc    = new Contract(MULTICALL3, MC3_ABI, provider);
  const erc20 = new Interface(ERC20_ABI);
  const pool  = new Interface(POOL_ABI);

  const calls: { target: string; allowFailure: boolean; callData: string }[] = [];

  for (const user of userAddresses) {
    
    for (const m of markets) {
      calls.push({
        target:       m.aTokenAddress,
        allowFailure: true,
        callData:     erc20.encodeFunctionData('balanceOf', [user]),
      });
    }
    
    calls.push({
      target:       POOL,
      allowFailure: true,
      callData:     pool.encodeFunctionData('getUserAccountData', [user]),
    });
  }

  const results = new Map<string, AaveUserPosition[]>();
  const stride  = markets.length + 1;

  try {
    const raw: { success: boolean; returnData: string }[] = await mc.aggregate3(calls);

    for (let u = 0; u < userAddresses.length; u++) {
      const user = userAddresses[u];
      const base = u * stride;
      
      
      let healthFactor = Infinity;
      const hfResult = raw[base + markets.length];
      if (hfResult?.success && hfResult.returnData && hfResult.returnData !== '0x') {
        try {
          const hfDecoded = pool.decodeFunctionResult('getUserAccountData', hfResult.returnData);
          healthFactor = Number(BigInt(hfDecoded[5].toString())) / 1e18;
        } catch {  }
      }

      const userPos: AaveUserPosition[] = [];
      for (let m = 0; m < markets.length; m++) {
        const market = markets[m];
        const res = raw[base + m];
        if (!res?.success || !res.returnData || res.returnData === '0x') continue;

        try {
          const bal = erc20.decodeFunctionResult('balanceOf', res.returnData)[0] as bigint;
          if (bal === 0n) continue;

          const price = getPrice(prices, market.symbol);
          const balUSD = Number(bal) / 10 ** (AAVE_ASSETS[market.symbol]?.decimals ?? 18) * price;

          userPos.push({
            symbol:           market.symbol,
            asset:            market.asset,
            aTokenAddress:    market.aTokenAddress,
            balanceRaw:       bal,
            balanceUSD:       balUSD,
            currentSupplyAPY: market.supplyAPY,
            healthFactor,
            isDeposited:      balUSD > 0.01,
          });
        } catch {  }
      }
      results.set(user, userPos);
    }
  } catch (err: any) {
    console.warn('[Aave] Batch fetch failed:', err.message);
  }

  return results;
}

export async function verifyAaveRate(
  assetSymbol:  string,
  expectedAPY:  number,
  driftLimitPct: number,
  provider:     JsonRpcProvider,
  prices:       PriceMap,
): Promise<{ ok: boolean; liveAPY: number; drift: number; error: string | null }> {
  const markets = await fetchAaveMarkets(provider, prices);
  const market  = markets.find(m => m.symbol === assetSymbol);

  if (!market) {
    return { ok: false, liveAPY: 0, drift: 100, error: `Aave market for ${assetSymbol} not found on-chain` };
  }

  const liveAPY = market.supplyAPY;
  const drift   = expectedAPY > 0 ? Math.abs(expectedAPY - liveAPY) / expectedAPY * 100 : 0;
  const ok      = drift <= driftLimitPct && liveAPY > 0;

  return {
    ok,
    liveAPY,
    drift,
    error: ok ? null : `APY drifted ${drift.toFixed(1)}% from expected ${expectedAPY.toFixed(2)}% (live: ${liveAPY.toFixed(2)}%)`,
  };
}
