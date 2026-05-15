import type { AlphaOpportunity, OpportunityEvaluation } from '../types';
import type { ProtocolStrategyModel } from './types';
import { clamp, logLiquidityScore, numberFromExtra } from './common';

export class PendleModel implements ProtocolStrategyModel {
  readonly key = 'pendle' as const;

  supports(opportunity: AlphaOpportunity): boolean {
    return opportunity.protocolKey === this.key;
  }

  evaluate(opportunity: AlphaOpportunity): OpportunityEvaluation {
    const liquidityScore = logLiquidityScore(opportunity.liquidityUSD);
    const daysToExpiry = numberFromExtra(opportunity, 'daysToExpiry') ?? 30;
    const maturityScore = clamp(daysToExpiry / 180, 0.3, 1);
    const managementCost = opportunity.grossAPY * clamp(20 / Math.max(daysToExpiry, 20), 0.04, 0.16);
    const riskDrag = opportunity.grossAPY * clamp((120 - Math.min(daysToExpiry, 120)) / 800, 0.03, 0.12);
    const expectedNetApy = Math.max(0, opportunity.grossAPY - riskDrag - managementCost);
    const confidence = clamp(0.5 * liquidityScore + 0.5 * maturityScore, 0.2, 1);

    return {
      model: this.key,
      score: Math.round(expectedNetApy * (0.7 + confidence)),
      expectedNetApy: Number(expectedNetApy.toFixed(4)),
      expectedRiskDrag: Number(riskDrag.toFixed(4)),
      expectedManagementCost: Number(managementCost.toFixed(4)),
      confidence: Number((confidence * 100).toFixed(2)),
      notes: [
        `daysToExpiry=${daysToExpiry.toFixed(1)}`,
      ],
    };
  }
}
