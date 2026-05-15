

export type RiskTier = 'conservative' | 'balanced' | 'aggressive' | 'advanced';
export type StrategyType =
  | 'GMX_REAL_YIELD'    
  | 'DELTA_NEUTRAL'     
  | 'AAVE_LENDING'      
  | 'MORPHO_LENDING'    
  | 'PENDLE_PT'         
  | 'PENDLE_LP'         
  | 'PENDLE_YT'         
  | 'LEVERAGED_LOOP';   
export type Trend = 'rising' | 'falling' | 'stable' | 'unknown';
export type Phase = 'INITIALIZING' | 'SCANNING' | 'ALLOCATED' | 'MONITORING' | 'MIGRATING' | 'SAFETY_EXIT' | 'WITHDRAWING' | 'IDLE' | 'PAUSED' | 'WITHDRAWN';
export type CBStatus = 'GREEN' | 'YELLOW' | 'RED';
export type LogLevel = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';
export type ActionType = 'HOLD' | 'GENESIS' | 'MIGRATE' | 'SAFETY_EXIT' | 'HARVEST' | 'REBALANCE' | 'REBALANCE_UNIV3' | 'WITHDRAW';
export type ILCategory = 'none' | 'low' | 'medium' | 'high';

export interface UserPolicy {
  id: string;
  displayName: string;
  riskTier: RiskTier;
  managedUSD: number;
  minAPY: number;
  maxSlippageBps: number;
  maxDrawdownPct: number;
  maxFeeBps: number;
  migrationThresholdPct: number;
  createdAt: number;
  expiresAt: number;
  
  isReal?: boolean;   
  userAddress?: string;    
  chainId?: number;    

  
  smartAccountAddress?: string;   
  signedDelegation?: import('./delegation-client').StoredDelegation;
  forceMigrateTargetId?: string; 
}

export interface OpportunityCosts {
  fundingAnnual: number;
  executionPct: number;
  gasAnnual: number;
  oiPenalty: number;
}

export interface OpportunityRisk {
  counterpartyRisk: 'none' | 'low' | 'medium' | 'high';
  ilRisk: boolean;
  liquidationRisk: boolean;
  rebalanceNeeded: boolean;
  oiBalance: number | null;
  oiRiskFlag: boolean;
}

export interface Opportunity {
  id: string;
  strategyType: StrategyType;
  protocol: string;
  pool: string;
  asset: string;
  tvlUSD: number;
  grossAPY: number;
  realYieldAPY: number;        
  emissionFraction: number;       
  netAPY: number;
  geckoScore: number;        
  costs: OpportunityCosts;
  risk: OpportunityRisk;
  history: {
    apy7d: number | null;
    apy30d: number | null;
    trend: Trend;
    sigma: number | null;
  };
  minTier: RiskTier;
  verifiedOnChain: boolean;
  llamaPoolId: string;
  address: string;
  updatedAt: number;
  
  maturityDate?: number;        
  impliedAPY?: number;        
  ytAddress?: string;        
  ptAddress?: string;        
  
  borrowRateAPY?: number;
  healthFactor?: number;
  
  lvrOptimalRangePct?: number;    
  lvrConcentrationC?: number;    
  lvrCAvg?: number;    
  lvrAdjFeeAPY?: number;    
  lvrNetAPY?: number;    
  lvrSigmaDaily?: number;    
  lvrEpochRatio?: number;    
  lvrScoredAt?: number;    
}

export interface Position {
  id: string;
  venueId: string;        
  venueAddress?: string;        
  venueName: string;
  protocol: string;
  strategyType: StrategyType;
  asset?: string;

  
  entryAPY: number;
  entryUSD: number;
  entryTime: number;
  entryPriceUSD: number;        

  
  currentAPY: number;
  currentNetAPY: number;
  currentUSD: number;

  
  incomeEarnedUSD: number;        
  totalReturnUSD: number;        
  totalReturnPct: number;
  effectiveAPY: number;        

  
  ilPct: number;        
  ilUSD: number;        
  ilCategory: ILCategory;
  feesEarnedUSD: number;        
  netAfterILUSD: number;        
  isILProfitable: boolean;       
  ilUnprofTicks: number;        

  
  pendingRewardsUSD: number;      
  lastHarvestAt: number;

  
  
  currentUSDExact?: string;
  incomeEarnedUSDExact?: string;
  feesEarnedUSDExact?: string;
  pendingRewardsUSDExact?: string;

  
  peakUSD: number;
  drawdownPct: number;
  daysHeld: number;

  
  healthFactor?: number;        
  borrowedUSD?: number;        
  loopCount?: number;        

  
  maturityDate?: number;        
  ytAddress?: string;        
  ptAddress?: string;        

  
  uniV3TokenId?: string;
  uniV3Liquidity?: string;

  
  gmxOrderKey?: string;        
  hedgeSizeUSD?: number;        

  
  uniV3TickLower?: number;    
  uniV3TickUpper?: number;    
  uniV3CenterTick?: number;    
  uniV3RangePct?: number;    
  uniV3EntryPool?: string;    
  uniV3LastDriftPct?: number;    
  uniV3Rebalances?: number;    

  
  uniV3OutOfRangeTicks?: number;

  
  
  uniV3Token0?: string;
  uniV3Token1?: string;
  uniV3Token0Decimals?: number;
  uniV3Token1Decimals?: number;
  uniV3TokensOwed0Raw?: string;
  uniV3TokensOwed1Raw?: string;
  uniV3TokensOwed0?: string;
  uniV3TokensOwed1?: string;
  uniV3PendingFees0USD?: number;
  uniV3PendingFees1USD?: number;
  uniV3PendingFees0USDExact?: string;
  uniV3PendingFees1USDExact?: string;
  uniV3PendingFeesUSDExact?: string;

  
  
  

  
  
  entryLiquidityIndex?: string;

  
  
  morphoShares?: string;

  
  
  pendleLpAmount?: string;

  
  
  gmTokenAmount?: string;

  simulated: boolean;
}

export interface PortfolioPosition extends Position {
  allocationPct: number;        
  allocationUSD: number;        
  geckoScore: number;        
}

export interface PortfolioMetrics {
  totalValueUSD: number;
  totalEntryUSD: number;
  totalReturnUSD: number;
  totalReturnPct: number;
  incomeEarnedUSD: number;
  totalILUSD: number;        
  weightedNetAPY: number;        
  realYieldAPY: number;        
  peakValueUSD: number;
  drawdownPct: number;
  diversificationScore: number;   
  ilCoveredByFees: boolean;       
}

export interface Portfolio {
  positions: PortfolioPosition[];
  metrics: PortfolioMetrics;
  lastRebalanceAt: number;
  updatedAt: number;
}

export interface AllocationTarget {
  strategyType: StrategyType;
  minPct: number;
  maxPct: number;
  targetPct: number;
  priority: number;           
}

export interface CircuitBreaker {
  id: string;
  name: string;
  status: CBStatus;
  value: string;
  threshold: string;
  description: string;
  positionId?: string;            
}

export interface AllocationDecision {
  action: ActionType;
  targetOpportunity: Opportunity | null;
  currentOpportunity: Opportunity | null;
  reason: string;
  upliftPct: number;
  
  rebalanceTargets?: { positionId: string; newAllocationPct: number }[];
}

export interface SafetyCheckResult {
  passed: boolean;
  abortReason: string | null;
  checks: {
    name: string;
    passed: boolean;
    value: string;
    required: string;
  }[];
}

export interface HarvestRecommendation {
  shouldHarvest: boolean;
  positionId: string;
  pendingRewardsUSD: number;
  estimatedGasUSD: number;
  netGainUSD: number;
  reason: string;
}

export interface UniV3RebalanceTriggerSnapshot {
  kind: 'univ3-drift';
  poolAddress: string;
  tokenId: string;
  driftPct: number;
  currentTick: number;
  centerTick: number;
  tickLower: number;
  tickUpper: number;
  inRange: boolean;
  triggerThresholdPct: number;
}

export interface ExecutionRecord {
  action: ActionType;
  from: string | null;
  to: string;
  amountUSD: number;
  simulated: boolean;
  receiptHash: string;
  txHash?: string;    
  timestamp: number;
  status?: 'planned' | 'confirmed' | 'reconciled' | 'failed';
  positionId?: string;
  replacedPositionId?: string;
  uniV3TokenId?: string;
  replacedUniV3TokenId?: string;
  errorDetail?: string;
  portfolioValueBefore?: number;
  portfolioValueAfter?: number;
  sessionId?: string;
  triggerSnapshot?: UniV3RebalanceTriggerSnapshot;
  proofBackfilledAt?: number;
  proofBackfillSource?: 'recovered-mint-tx';
  
  zgTraceCID?: string;   
  zgAttestCID?: string;   
  zgChainTxHash?: string;   
  zgChainExplorer?: string;   
}

export interface LogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  message: string;
  detail?: string;
  sessionId?: string;
}

export interface PnLPoint {
  ts: number;
  totalUSD: number;
  navUSD: number;
  incomeUSD: number;
  ilUSD: number;             
  netUSD: number;             
}

export type EventType =
  | 'STATE_SNAPSHOT'
  | 'TICK_START'
  | 'OPPORTUNITIES'
  | 'ALLOCATION'
  | 'SAFETY'
  | 'EXECUTION'
  | 'PORTFOLIO'       
  | 'BREAKERS'
  | 'HARVEST'
  | 'WITHDRAWAL'
  | 'PROOF_UPDATE'
  | 'LOG'
  | 'TICK_END';

export type ProofStep = 'trace' | 'attest' | 'anchor';

export interface ProofUpdatePayload {
  userId:       string;
  receiptHash:  string;
  action:       string;
  step:         ProofStep;
  value:        string;
  explorerUrl?: string;
  
  snapshot: {
    arbitrumTxHash: string;
    zgTraceCID?:    string;
    zgAttestCID?:   string;
    zgChainTxHash?: string;
    zgChainExplorer?: string;
  };
}

export type WithdrawalPhase =
  | 'COLLECTING_FEES'
  | 'CLOSING_POSITION'
  | 'SWAPPING_TOKENS'
  | 'COMPLETE'
  | 'FAILED';

export interface WithdrawalEvent {
  phase:      WithdrawalPhase;
  userId:     string;
  message:    string;
  idleUSDC?:  number;
  txHash?:    string;
  error?:     string;
}

export interface AgentEvent<T = unknown> {
  type: EventType;
  ts: number;
  payload: T;
}

export interface UserState {
  userId: string;
  userAddress: string;     
  policy: UserPolicy;
  phase: Phase;
  portfolio: Portfolio | null;
  breakers: CircuitBreaker[];
  activeSessionId: string;
  activeSessionStartedAt: number;
  updatedAt: number;
  tickErrors: number;
  isDirty?: boolean;           
  lastPersistedAt?: number;
  latestJournalCID?: string;   
}

export interface AgentState {
  users: Record<string, UserState>;
  opportunities: Opportunity[];
  globalLog: LogEntry[];
  lastTickAt: number;
  nextTickAt: number;
  block: number;
  tickCount: number;
}
