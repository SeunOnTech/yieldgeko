import type { AlphaOpportunity, OpportunityEvaluation } from '../types';
import type { ProtocolStrategyModel } from './types';
import { clamp, logLiquidityScore, numberFromExtra } from './common';

export class MorphoModel implements ProtocolStrategyModel {
  readonly key = 'morpho' as const;

  supports(opportunity: AlphaOpportunity): boolean {
    return opportunity.protocolKey === this.key;
  }

  evaluate(opportunity: AlphaOpportunity): OpportunityEvaluation {
    const liquidityScore = logLiquidityScore(opportunity.liquidityUSD);
    const trailing = numberFromExtra(opportunity, 'apyMean30d') ?? numberFromExtra(opportunity, 'apyBase7d') ?? opportunity.grossAPY;
    const consistency = clamp(trailing > 0 ? opportunity.grossAPY / trailing : 1, 0.6, 1.15);
    const managementCost = opportunity.grossAPY * 0.03;
    const riskDrag = opportunity.grossAPY * (opportunity.metadata.verified ? 0.04 : 0.08);
    const expectedNetApy = Math.max(0, opportunity.grossAPY * consistency - riskDrag - managementCost);
    const confidence = clamp(0.6 * liquidityScore + 0.4 * consistency, 0.2, 1) * (opportunity.metadata.verified ? 1 : 0.92);

    return {
      model: this.key,
      score: Math.round(expectedNetApy * (0.75 + confidence)),
      expectedNetApy: Number(expectedNetApy.toFixed(4)),
      expectedRiskDrag: Number(riskDrag.toFixed(4)),
      expectedManagementCost: Number(managementCost.toFixed(4)),
      confidence: Number((confidence * 100).toFixed(2)),
      notes: [
        `consistency=${consistency.toFixed(2)}`,
      ],
    };
  }
}
