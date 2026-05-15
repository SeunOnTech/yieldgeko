import { IProtocolAdapter, AdapterContext, mkRisk, GAS_PCT } from './types';
import { RankedOpportunity } from '../types/market';
import { IntelligencePolicy } from '../types/policy';

function calcTrend(now: number, d7: number | null, d30: number | null): 'rising' | 'falling' | 'stable' | 'unknown' {
  const ref = d7 ?? d30;
  if (!ref || ref === 0) return 'unknown';
  const d = (now - ref) / ref;
  if (d > 0.05) return 'rising';
  if (d < -0.05) return 'falling';
  return 'stable';
}

export class GMXAdapter implements IProtocolAdapter {
  id       = 'gmx-v2';
  protocol = 'gmx-v2';
  chain    = 'arbitrum';

  async build(policy: IntelligencePolicy, ctx: AdapterContext): Promise<RankedOpportunity[]> {
    const pools = ctx.llamaPools.filter(
      p => p.protocol.toLowerCase().includes('gmx') &&
           p.chain === 'arbitrum' &&
           p.metrics.tvlUSD >= 500_000,
    ).slice(0, 8);

    return pools.map((p, i): RankedOpportunity => {
      const sym    = p.tokens.base.symbol.toUpperCase();
      const live   = ctx.onChain?.gmx?.find(m => sym.includes(m.name.split('/')[0] ?? ''));
      const apy    = live?.feeAPY && live.feeAPY > 0 ? live.feeAPY : p.metrics.totalAPY;
      const tvl    = live?.poolValueUSD ?? p.metrics.tvlUSD;
      const oiBal  = live?.oiBalance ?? 0.5;
      const oiSkew = Math.abs(oiBal - 0.5) * 2;
      const oiFlag = oiSkew > 0.40;

      const costs = {
        fundingAnnual: 0, executionPct: 0.10, gasAnnual: GAS_PCT, oiPenalty: oiSkew * 6,
      };
      const netAPY = Math.max(0, apy - costs.executionPct - costs.gasAnnual - costs.oiPenalty);

      return {
        id:           `gmx-${i}`,
        address:      live?.gmToken ?? p.address,
        chain:        'arbitrum',
        protocol:     'GMX V2',
        strategyType: 'GMX_REAL_YIELD',
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
        risk: mkRisk({ counterpartyRisk: oiFlag ? 'medium' : 'low', oiBalance: oiBal, oiRiskFlag: oiFlag }),
        history: {
          apy7d:  p.metrics.apy7d,
          apy30d: p.metrics.apy30d,
          trend:  calcTrend(apy, p.metrics.apy7d, p.metrics.apy30d),
          sigma:  p.metrics.sigma,
        },
        minTier: 'balanced',
      };
    });
  }
}
