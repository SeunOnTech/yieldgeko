export type OpportunityStrategy = 'LENDING' | 'LP' | 'DERIVATIVE' | 'DELTA_NEUTRAL';
export type ProtocolKey = 'uniswap-v3' | 'pendle' | 'morpho' | 'unknown';

export type HistoryProvider =
  | { kind: 'none' }
  | { kind: 'defillama-pool'; poolId: string }
  | { kind: 'pendle-market'; chainId: number; marketAddress: string };

export interface OpportunityMetadata {
  chainId: number;
  network: string;
  source: 'defillama' | 'pendle-api' | 'uniswap-v3-factory';
  verified: boolean;
  address?: string;
  discoveryAddress?: string;
  feeTier?: number;
  token0?: string;
  token1?: string;
  token0Symbol?: string;
  token1Symbol?: string;
  token0Decimals?: number;
  token1Decimals?: number;
  quoteAsset?: string;
  baseAsset?: string;
  factoryAddress?: string;
  warnings?: string[];
  historyProvider?: HistoryProvider;
  extra?: Record<string, unknown>;
}

export interface AlphaOpportunity {
  id: string;
  protocolKey: ProtocolKey;
  protocol: string;
  pool: string;
  asset: string;
  grossAPY: number;
  liquidityUSD: number;
  strategyType: OpportunityStrategy;
  metadata: OpportunityMetadata;
  riskScore: number;
  selectionScore: number;
  evaluation?: OpportunityEvaluation;
  price?: number;
}

export interface OpportunityEvaluation {
  model: ProtocolKey;
  score: number;
  expectedNetApy: number;
  expectedRiskDrag: number;
  expectedManagementCost: number;
  confidence: number;
  notes: string[];
}

export type TapeSource = 'scan' | 'backfill';

export interface TapeEntry {
  timestamp: number;
  opportunityId: string;
  protocol: string;
  pool: string;
  grossAPY: number;
  confidence: number;
  verdict: 'APPROVED' | 'REJECTED' | 'UNKNOWN';
  price?: number;
  source: TapeSource;
  runId?: string;
  provenance?: {
    provider: 'defillama' | 'pendle-core';
    providerId: string;
    quality: 'indexed' | 'protocol-native';
    fetchedAt: number;
    sampling?: 'raw' | 'downsampled';
  };
  simulation?: {
    expectedAPY: number;
    trueVolatility: number;
    sortinoRatio: number;
    momentumFactor: number;
    confidence: number;
    status: 'APPROVED' | 'REJECTED';
    seed: number;
  };
}

export interface TapeFile {
  version: 1;
  entries: TapeEntry[];
}

export interface ChaosSimulationInput {
  id: string;
  protocol: string;
  pool: string;
  asset: string;
  grossAPY: number;
  liquidityUSD: number;
  riskScore: number;
  strategyType: OpportunityStrategy;
  verified: boolean;
  selectionScore: number;
  price?: number;
  lpContext?: {
    pairType: 'stable-stable' | 'stable-volatile' | 'volatile-volatile';
    ilRiskFlag: boolean;
    feeTierBps?: number;
    volumeToTvlRatio?: number;
  };
  history: Array<Pick<TapeEntry, 'timestamp' | 'grossAPY' | 'price' | 'confidence' | 'verdict' | 'source'>>;
  seed: number;
}

export interface ChaosSimulationResult {
  id: string;
  expected_apy: number;
  net_expected_apy?: number;
  estimated_il_drag?: number;
  true_volatility: number;
  sortino_ratio: number;
  momentum_factor: number;
  chaos_confidence: number;
  status: 'APPROVED' | 'REJECTED';
  simulation_seed: number;
}
