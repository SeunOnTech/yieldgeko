import type { AlphaOpportunity, OpportunityEvaluation } from '../types';
import type { ProtocolStrategyModel } from './types';
import { boolFromExtra, clamp, logLiquidityScore, numberFromExtra, ratioScore, stringFromExtra } from './common';

const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'USDT0', 'USD₮0', 'DAI', 'USDE', 'USDC.E', 'USDBC', 'USDCE', 'MIM', 'USDS', 'USD0']);

function isStable(symbol?: string): boolean {
  return !!symbol && STABLE_SYMBOLS.has(symbol.toUpperCase());
}

function pairType(opportunity: AlphaOpportunity): 'stable-stable' | 'stable-volatile' | 'volatile-volatile' {
  const stable0 = isStable(opportunity.metadata.token0Symbol);
  const stable1 = isStable(opportunity.metadata.token1Symbol);
  if (stable0 && stable1) return 'stable-stable';
  if (stable0 || stable1) return 'stable-volatile';
  return 'volatile-volatile';
}

function ilRiskMultiplier(opportunity: AlphaOpportunity): number {
  const type = pairType(opportunity);
  const sourceIlRisk = stringFromExtra(opportunity, 'ilRisk');
  let multiplier = type === 'stable-stable' ? 0.08 : type === 'stable-volatile' ? 0.18 : 0.28;
  if (String(sourceIlRisk ?? '').toLowerCase() === 'yes') {
    multiplier *= 1.04;
  }
  const feeTier = opportunity.metadata.feeTier ?? 3000;
  if (feeTier >= 10_000) multiplier *= 1.06;
  return multiplier;
}

function feeCoverageMultiplier(opportunity: AlphaOpportunity): number {
  const current = opportunity.grossAPY;
  const trailing = numberFromExtra(opportunity, 'apyMean30d') ?? numberFromExtra(opportunity, 'apyBase7d') ?? numberFromExtra(opportunity, 'apyBase');
  if (!trailing || trailing <= 0) return clamp(current / 18, 0.7, 1.5);
  const ratio = current / trailing;
  if (ratio < 0.8) return 0.82;
  if (ratio <= 1.2) return 1.0;
  if (ratio <= 2.0) return 1.15;
  if (ratio <= 3.0) return 1.06;
  return 0.94;
}

export class UniswapV3Model implements ProtocolStrategyModel {
  readonly key = 'uniswap-v3' as const;

  supports(opportunity: AlphaOpportunity): boolean {
    return opportunity.protocolKey === this.key;
  }

  evaluate(opportunity: AlphaOpportunity): OpportunityEvaluation {
    const liquidityScore = logLiquidityScore(opportunity.liquidityUSD);
    const rawVolumeToTvl = numberFromExtra(opportunity, 'volumeUsd7d') && opportunity.liquidityUSD > 0
      ? (numberFromExtra(opportunity, 'volumeUsd7d') ?? 0) / opportunity.liquidityUSD
      : undefined;
    const volumeToTvl = ratioScore(rawVolumeToTvl, 0.25, 8, 0.45);
    const historyScore = ratioScore(numberFromExtra(opportunity, 'historyCount'), 30, 365, 0.3);
    const outlierPenalty = boolFromExtra(opportunity, 'outlier') ? 0.88 : 1;
    const type = pairType(opportunity);

    const ilMultiplier = ilRiskMultiplier(opportunity);
    const exitabilityRelief = clamp(0.72 + volumeToTvl * 0.38, 0.72, 1.08);
    const liquidityRelief = clamp(0.82 + liquidityScore * 0.28, 0.82, 1.1);
    const estimatedRiskDrag = opportunity.grossAPY * ilMultiplier * (2 - exitabilityRelief) * (1.85 - liquidityRelief);
    const rebalanceBase = type === 'volatile-volatile' ? 0.045 : type === 'stable-volatile' ? 0.03 : 0.015;
    const rebalanceCost = opportunity.grossAPY * rebalanceBase * (1 - volumeToTvl * 0.25);
    const feeCoverage = feeCoverageMultiplier(opportunity);
    const expectedNetApy = Math.max(0, (opportunity.grossAPY * feeCoverage) - estimatedRiskDrag - rebalanceCost);

    const confidence = clamp(
      0.30 * liquidityScore +
      0.30 * volumeToTvl +
      0.15 * historyScore +
      0.25 * clamp(expectedNetApy / Math.max(opportunity.grossAPY, 1), 0, 1),
      0.1,
      1,
    ) * outlierPenalty;

    const score = Math.round(expectedNetApy * (0.95 + confidence));
    const notes = [
      `pair=${type}`,
      `feeCoverage=${feeCoverage.toFixed(2)}`,
      `turnoverScore=${volumeToTvl.toFixed(2)}`,
    ];

    return {
      model: this.key,
      score,
      expectedNetApy: Number(expectedNetApy.toFixed(4)),
      expectedRiskDrag: Number(estimatedRiskDrag.toFixed(4)),
      expectedManagementCost: Number(rebalanceCost.toFixed(4)),
      confidence: Number((confidence * 100).toFixed(2)),
      notes,
    };
  }
}
