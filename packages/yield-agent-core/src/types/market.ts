

export type ChainId = 'arbitrum' | 'base' | 'ethereum' | 'optimism' | 'polygon';

export interface TokenMeta {
  address:  string;
  symbol:   string;
  decimals: number;
  chainId:  ChainId;
}

export type StrategyType =
  | 'DELTA_NEUTRAL'
  | 'GMX_REAL_YIELD'
  | 'MORPHO_LENDING'
  | 'AAVE_LENDING'
  | 'PENDLE_PT'
  | 'PENDLE_LP'
  | 'PENDLE_YT'
  | 'LEVERAGED_LOOP';

export interface RawPool {
  id:           string;          
  address:      string;
  chain:        ChainId;
  protocol:     string;
  strategyType: StrategyType;
  tokens:       { base: TokenMeta; quote?: TokenMeta };
  metrics: {
    apyBase:     number;
    apyReward:   number;
    totalAPY:    number;
    tvlUSD:      number;
    volume24hUSD: number;
    sigma:       number | null;  
    apy7d:       number | null;
    apy30d:      number | null;
  };
  rewardTokens?:    string[];
  verifiedOnChain:  boolean;
  updatedAt:        number;

  
  maturityDate?:       number;    
  ytAddress?:          string;    
  ptAddress?:          string;    
  underlyingAddress?:  string;    
  oiBalance?:          number;    
}

export interface OpportunityCosts {
  fundingAnnual: number;   
  executionPct:  number;   
  gasAnnual:     number;   
  oiPenalty:     number;   
}

export interface OpportunityRisk {
  counterpartyRisk: 'none' | 'low' | 'medium' | 'high';
  ilRisk:           boolean;
  liquidationRisk:  boolean;
  rebalanceNeeded:  boolean;
  oiBalance:        number | null;
  oiRiskFlag:       boolean;
}

export interface RankedOpportunity extends RawPool {
  
  grossAPY:          number;
  realYieldAPY:      number;
  emissionFraction:  number;
  netAPY:            number;
  geckoScore:        number;
  costs:             OpportunityCosts;
  risk:              OpportunityRisk;
  minTier:           import('./policy').RiskTier;
  llamaPoolId:       string;

  history: {
    apy7d:  number | null;
    apy30d: number | null;
    trend:  'rising' | 'falling' | 'stable' | 'unknown';
    sigma:  number | null;
  };

  
  lvrOptimalRangePct?: number;
  lvrConcentrationC?:  number;
  lvrCAvg?:            number;
  lvrAdjFeeAPY?:       number;
  lvrNetAPY?:          number;
  lvrSigmaDaily?:      number;
  lvrEpochRatio?:      number;
  lvrScoredAt?:        number;
  
  lvrRatio?:           number;

  
  quantStats?: {
    correlation:      number;
    volatility:       number;
    divergenceRisk:   number;
    priceRatioVar:    number;
    dataPoints:       number;
  };
}

export interface PricePoint {
  timestamp: number;
  close:     number;
}

export type PriceHistory = Record<string, PricePoint[]>;
