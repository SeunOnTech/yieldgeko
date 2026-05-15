import { IProtocolAdapter, AdapterContext, mkRisk, GAS_PCT } from './types';
import { RankedOpportunity } from '../types/market';
import { IntelligencePolicy, TIER_RANK } from '../types/policy';

function calcTrend(now: number, d7: number | null, d30: number | null): 'rising' | 'falling' | 'stable' | 'unknown' {
  const ref = d7 ?? d30;
  if (!ref || ref === 0) return 'unknown';
  const delta = (now - ref) / ref;
  if (delta > 0.05) return 'rising';
  if (delta < -0.05) return 'falling';
  return 'stable';
}

export class AaveAdapter implements IProtocolAdapter {
  id       = 'aave-v3';
  protocol = 'aave-v3';
  chain    = 'arbitrum';

  async build(policy: IntelligencePolicy, ctx: AdapterContext): Promise<RankedOpportunity[]> {
    const pools = ctx.llamaPools.filter(
      p => p.protocol.toLowerCase().includes('aave') &&
           p.chain === 'arbitrum' &&
           p.metrics.tvlUSD >= 1_000_000,
    ).slice(0, 4);

    return pools.map((p, i): RankedOpportunity => {
      const sym    = p.tokens.base.symbol.toUpperCase();
      const live   = ctx.onChain?.aave?.find(m => sym.includes(m.symbol));
      const apy    = live?.supplyAPY ?? p.metrics.totalAPY;
      const tvl    = live?.liquidityUSD ?? p.metrics.tvlUSD;
      const costs  = { fundingAnnual: 0, executionPct: 0.05, gasAnnual: GAS_PCT, oiPenalty: 0 };
      const netAPY = Math.max(0, apy - costs.executionPct - costs.gasAnnual);

      return {
        id:           `aave-${i}`,
        address:      live?.aTokenAddress ?? p.address,
        chain:        'arbitrum',
        protocol:     'Aave V3',
        strategyType: 'AAVE_LENDING',
        tokens: { base: { ...p.tokens.base, symbol: sym } },
        metrics: { ...p.metrics, tvlUSD: tvl, totalAPY: apy },
        verifiedOnChain: live !== undefined,
        updatedAt:    Date.now(),
        llamaPoolId:  p.id,
        grossAPY:     apy,
        realYieldAPY: apy,
        emissionFraction: 0,
        netAPY,
        geckoScore:   0,
        costs,
        risk: mkRisk({ counterpartyRisk: 'none' }),
        history: {
          apy7d:  p.metrics.apy7d,
          apy30d: p.metrics.apy30d,
          trend:  calcTrend(apy, p.metrics.apy7d, p.metrics.apy30d),
          sigma:  p.metrics.sigma,
        },
        minTier: 'conservative',
      };
    });
  }
}
