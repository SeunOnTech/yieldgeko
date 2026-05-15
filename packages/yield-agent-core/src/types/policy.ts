export type RiskTier = 'conservative' | 'balanced' | 'aggressive' | 'advanced';

export interface IntelligencePolicy {
  riskTier:          RiskTier;
  managedUSD:        number;
  minNetAPY?:        number;
  allowedChains?:    string[];
  allowedProtocols?: string[];
  stablecoinOnly?:   boolean;
  maxVolatility?:    number;
  existingTypes?:    import('./market').StrategyType[];
}

export const TIER_RANK: Record<RiskTier, number> = {
  conservative: 0,
  balanced:     1,
  aggressive:   2,
  advanced:     3,
};
