import { RankedOpportunity } from '../types/market';
import { IntelligencePolicy } from '../types/policy';

export interface IProtocolAdapter {
  readonly id:       string;
  readonly protocol: string;
  readonly chain:    string;
  build(policy: IntelligencePolicy, context: AdapterContext): Promise<RankedOpportunity[]>;
}

export interface AdapterContext {
  llamaPools:   import('../types/market').RawPool[];
  fundingRates: Map<string, number>;
  
  onChain?:     OnChainRates;
}

export interface OnChainRates {
  aave?:   { symbol: string; supplyAPY: number; liquidityUSD: number; aTokenAddress: string }[];
  morpho?: { symbol: string; netAPY: number; tvlUSD: number; vaultAddress: string }[];
  gmx?:    { name: string; feeAPY: number; poolValueUSD: number; oiBalance: number; gmToken: string }[];
}

export function mkRisk(overrides: Partial<import('../types/market').OpportunityRisk> = {}): import('../types/market').OpportunityRisk {
  return {
    counterpartyRisk: 'low', ilRisk: false, liquidationRisk: false,
    rebalanceNeeded: false, oiBalance: null, oiRiskFlag: false,
    ...overrides,
  };
}

const GAS_PCT = (4 * 12 * 0.15 / 10_000) * 100;
export { GAS_PCT };
