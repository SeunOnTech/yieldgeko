import { IProtocolAdapter, AdapterContext, mkRisk, GAS_PCT } from './types';
import { RankedOpportunity, RawPool } from '../types/market';
import { IntelligencePolicy, TIER_RANK } from '../types/policy';

function calcTrend(now: number, d7: number | null, d30: number | null): 'rising' | 'falling' | 'stable' | 'unknown' {
  const ref = d7 ?? d30;
  if (!ref || ref === 0) return 'unknown';
  const delta = (now - ref) / ref;
  if (delta > 0.05) return 'rising';
  if (delta < -0.05) return 'falling';
  return 'stable';
}

export class MorphoAdapter implements IProtocolAdapter {
  id       = 'morpho';
  protocol = 'morpho';
  chain    = 'arbitrum';

  async build(policy: IntelligencePolicy, ctx: AdapterContext): Promise<RankedOpportunity[]> {
    const pools = ctx.llamaPools.filter(
      p => p.protocol.toLowerCase().includes('morpho') &&
           p.chain === 'arbitrum' &&
           p.metrics.tvlUSD >= 500_000,
    ).slice(0, 5);

    return pools.map((p, i): RankedOpportunity => {
      
      const live   = ctx.onChain?.morpho?.find(m => p.tokens.base.symbol.toUpperCase().includes(m.symbol));
      const apy    = live?.netAPY ?? p.metrics.totalAPY;
      const tvl    = live?.tvlUSD ?? p.metrics.tvlUSD;
      const costs  = { fundingAnnual: 0, executionPct: 0.03, gasAnnual: GAS_PCT, oiPenalty: 0 };
      const netAPY = Math.max(0, apy - costs.executionPct - costs.gasAnnual);

      return {
        id:           `morpho-${i}`,
        address:      live?.vaultAddress ?? p.address,
        chain:        'arbitrum',
        protocol:     'Morpho',
        strategyType: 'MORPHO_LENDING',
        tokens: { base: p.tokens.base },
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
