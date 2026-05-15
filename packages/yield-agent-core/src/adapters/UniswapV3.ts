import { IProtocolAdapter, AdapterContext, mkRisk, GAS_PCT } from './types';
import { RankedOpportunity } from '../types/market';
import { IntelligencePolicy, TIER_RANK } from '../types/policy';
import { getTopLVRPools } from '../analysis/LVRScreener';

export class UniswapV3Adapter implements IProtocolAdapter {
  id       = 'uniswap-v3';
  protocol = 'uniswap-v3';
  chain    = 'arbitrum';

  async build(policy: IntelligencePolicy, _ctx: AdapterContext): Promise<RankedOpportunity[]> {
    const pools = await getTopLVRPools(10);
    if (pools.length === 0) return [];

    return pools.map((sp, i): RankedOpportunity => {
      const costs = {
        fundingAnnual: 0, executionPct: 0.10,
        gasAnnual: GAS_PCT + 1.0, oiPenalty: 0,
      };
      return {
        id:              `dn-lvr-${i}`,
        address:         sp.address,
        chain:           'arbitrum',
        protocol:        'Uniswap V3 (LVR-screened)',
        strategyType:    'DELTA_NEUTRAL',
        tokens: {
          base:  { address: sp.token0, symbol: sp.symbol.split('/')[0] ?? 'TOKEN', decimals: 18, chainId: 'arbitrum' },
          quote: { address: sp.token1, symbol: sp.symbol.split('/')[1] ?? 'USDC',  decimals: 6,  chainId: 'arbitrum' },
        },
        metrics: {
          apyBase: sp.dllamaAPY, apyReward: 0,
          totalAPY: sp.dllamaAPY, tvlUSD: sp.tvlUSD,
          volume24hUSD: sp.volume24hUSD, sigma: sp.sigmaRatioDaily,
          apy7d: null, apy30d: null,
        },
        verifiedOnChain: true,
        updatedAt:       Date.now(),
        llamaPoolId:     sp.address,
        grossAPY:        sp.adjFeeAPY,
        realYieldAPY:    sp.adjFeeAPY,
        emissionFraction: 0,
        netAPY:          sp.netAPY,
        geckoScore:      0,
        costs,
        risk:  mkRisk({ counterpartyRisk: 'low', ilRisk: true, rebalanceNeeded: true }),
        history: { apy7d: null, apy30d: null, trend: 'stable', sigma: sp.sigmaRatioDaily },
        minTier: 'balanced',
        
        lvrOptimalRangePct: sp.optimalRangePct,
        lvrConcentrationC:  sp.concentrationC,
        lvrCAvg:            sp.cAvg,
        lvrAdjFeeAPY:       sp.adjFeeAPY,
        lvrNetAPY:          sp.netAPY,
        lvrSigmaDaily:      sp.sigmaRatioDaily,
        lvrEpochRatio:      sp.epochRatio,
        lvrScoredAt:        sp.scoredAt,
        lvrRatio:           sp.lvrRatio,   
      };
    });
  }
}
