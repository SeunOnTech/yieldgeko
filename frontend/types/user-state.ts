export interface YieldIntent {
  minAPY: number; // in basis points (e.g., 500 = 5.00%)
  maxSlippage: number; // in basis points (e.g., 200 = 2.00%)
  riskTier: 'conservative' | 'balanced' | 'aggressive';
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
