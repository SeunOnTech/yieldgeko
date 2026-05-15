import { NormalizedYield } from '../types/normalized-yield';
import { fetchAaveUSDCSupplyAPY } from '../parsers/aave-v3';
import { fetchPendleMarketYield } from '../parsers/pendle';

export function normalizeAaveData(raw: Awaited<ReturnType<typeof fetchAaveUSDCSupplyAPY>>): NormalizedYield {
  return {
    venue: 'aave-v3-arbitrum-usdc',
    chainId: 42161,
    contractAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    apyBps: raw.apyBps,
    liquidityUsd: raw.liquidity, 
    utilizationBps: raw.utilization,
    riskScore: 95, 
    lastUpdated: raw.timestamp,
    source: 'aave-v3',
  };
}

export function normalizePendleData(raw: Awaited<ReturnType<typeof fetchPendleMarketYield>>, market: string): NormalizedYield {
  return {
    venue: `pendle-market-${market.slice(0, 6)}`,
    chainId: 42161,
    contractAddress: market,
    apyBps: raw.impliedApyBps,
    liquidityUsd: raw.liquidity,
    utilizationBps: 0n,
    maturityTimestamp: raw.maturity,
    riskScore: 80, 
    lastUpdated: Math.floor(Date.now() / 1000),
    source: 'pendle',
  };
}

export function applyRiskAdjustment(yieldData: NormalizedYield, userRiskTier: 'conservative' | 'balanced' | 'aggressive'): NormalizedYield {
  const penalties: Record<string, number> = {
    conservative: 0.3,
    balanced: 0.15,
    aggressive: 0,
  };
  
  const penalty = penalties[userRiskTier] || 0;
  const adjustedApy = yieldData.apyBps * BigInt(Math.floor((1 - penalty) * 100)) / 100n;
  
  return { ...yieldData, apyBps: adjustedApy };
}
