export interface NormalizedYield {
  venue: string; // "aave-v3-arbitrum-usdc"
  chainId: number; 
  contractAddress: string;
  apyBps: bigint; // 500 = 5.00%
  liquidityUsd: bigint; // In wei equivalent
  utilizationBps: bigint; 
  maturityTimestamp?: number; 
  riskScore: number; // 0-100
  lastUpdated: number; 
  source: 'aave-v3' | 'pendle' | 'erc4626';
}
