

export { IntelligenceEngine }              from './IntelligenceEngine';
export { UniverseCache }                   from './UniverseCache';

export type { RankedOpportunity, RawPool, TokenMeta, StrategyType, ChainId, OpportunityCosts, OpportunityRisk, PricePoint, PriceHistory } from './types/market';
export type { IntelligencePolicy, RiskTier } from './types/policy';
export      { TIER_RANK }                  from './types/policy';

export { fetchLlamaPools, invalidateLlamaCache } from './providers/DefiLlama';
export { loadDiskPriceHistory, getDiskPrices, getDiskAddresses } from './providers/DiskPriceHistory';
export { getPriceHistory, getSpotPrice, batchSpotPrices, warmPriceCache } from './providers/MoralisPrice';
export { getFundingRates }                 from './providers/GainsNetwork';

export { calculateDivergenceStats, calculateCorrelation, calculateVolatility, spearmanCorrelation } from './analysis/QuantMath';
export { ILEngine }                        from './analysis/ILEngine';
export { getTopLVRPools, invalidateLVRCache } from './analysis/LVRScreener';
export type { LVRPool }                    from './analysis/LVRScreener';
export { computeGeckoScore, applyTierMultiplier, rankByGeckoScore } from './analysis/GeckoScorer';

export { applyPolicyFilter }               from './scoring/PolicyFilter';
export { scoreOpportunities, enrichTopN }  from './scoring/ScoringEngine';

export { UniswapV3Adapter }                from './adapters/UniswapV3';
export { MorphoAdapter }                   from './adapters/Morpho';
export { AaveAdapter }                     from './adapters/Aave';
export { PendleAdapter }                   from './adapters/Pendle';
export { GMXAdapter }                      from './adapters/GMX';
export type { IProtocolAdapter, AdapterContext, OnChainRates } from './adapters/types';
