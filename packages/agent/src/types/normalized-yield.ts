export interface NormalizedYield {
  venue: string; 
  chainId: number; 
  contractAddress: string;
  apyBps: bigint; 
  liquidityUsd: bigint; 
  utilizationBps: bigint; 
  maturityTimestamp?: number; 
  riskScore: number; 
  lastUpdated: number; 
  source: 'aave-v3' | 'pendle' | 'erc4626';
}
