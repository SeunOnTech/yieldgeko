import type { AlphaOpportunity } from '../types';
import type { ProtocolStrategyModel } from './types';
import { MorphoModel } from './morphoModel';
import { PendleModel } from './pendleModel';
import { UniswapV3Model } from './uniswapV3Model';

const MODELS: ProtocolStrategyModel[] = [
  new UniswapV3Model(),
  new PendleModel(),
  new MorphoModel(),
];

export function evaluateOpportunity(opportunity: AlphaOpportunity): AlphaOpportunity {
  const model = MODELS.find(candidate => candidate.supports(opportunity));
  if (!model) return opportunity;

  const evaluation = model.evaluate(opportunity);
  return {
    ...opportunity,
    selectionScore: evaluation.score,
    evaluation,
  };
}

export function evaluateOpportunities(opportunities: AlphaOpportunity[]): AlphaOpportunity[] {
  return opportunities.map(evaluateOpportunity);
}
