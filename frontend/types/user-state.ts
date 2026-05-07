export interface YieldIntent {
  asset: string;
  fromStrategy: string;
  toStrategy: string;
  amount: string;
  minAPY: number; // in basis points (e.g., 500 = 5.00%)
  expectedAPY: number; // signed expected APY for this route, in basis points
  maxSlippage: number; // in basis points (e.g., 200 = 2.00%)
  maxFee: string;
  riskTier: 'conservative' | 'balanced' | 'aggressive';
  strategyLabel: string;
}

export interface EncryptedUserState {
  intent: YieldIntent;
  metadata: {
    createdAt: number;
    walletAddress: string;
    version: string;
  };
}

export interface LocalPersistedState {
  cid: string;
  key: string;
  iv: string;
  lastSync: number;
}
