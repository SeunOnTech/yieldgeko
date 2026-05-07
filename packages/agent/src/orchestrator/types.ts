// ─── Shared types for the YieldGeko Agent Orchestrator ───────────────────────

export type RiskTier     = 'conservative' | 'balanced' | 'aggressive' | 'advanced';
export type StrategyType = 'GMX_REAL_YIELD' | 'DELTA_NEUTRAL' | 'AAVE_LENDING';
export type Trend        = 'rising' | 'falling' | 'stable' | 'unknown';
export type Phase        = 'INITIALIZING' | 'SCANNING' | 'ALLOCATED' | 'MONITORING' | 'MIGRATING' | 'SAFETY_EXIT' | 'IDLE';
export type CBStatus     = 'GREEN' | 'YELLOW' | 'RED';
export type LogLevel     = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';
export type ActionType   = 'HOLD' | 'GENESIS' | 'MIGRATE' | 'SAFETY_EXIT' | 'HARVEST';

// ── User Policy (replaces EIP-712 signed intent in dev) ───────────────────────

export interface UserPolicy {
  id:                    string;
  displayName:           string;
  riskTier:              RiskTier;
  managedUSD:            number;
  minAPY:                number;      // won't hold below this %
  maxSlippageBps:        number;
  maxDrawdownPct:        number;      // exit if USD value drops this much from peak
  maxFeeBps:             number;
  migrationThresholdPct: number;      // min APY uplift to justify a migration
  createdAt:             number;
  expiresAt:             number;
}

// ── Opportunities ─────────────────────────────────────────────────────────────

export interface OpportunityCosts {
  fundingAnnual:  number;   // perp hedge annual cost %
  executionPct:   number;   // entry/exit slippage estimate %
  gasAnnual:      number;   // annualized gas as % of position
  oiPenalty:      number;   // GMX OI-imbalance discount %
}

export interface OpportunityRisk {
  counterpartyRisk: 'none' | 'low' | 'medium' | 'high';
  ilRisk:           boolean;
  liquidationRisk:  boolean;
  oiBalance:        number | null;  // GMX: long/(long+short)
  oiRiskFlag:       boolean;
}

export interface Opportunity {
  id:              string;
  strategyType:    StrategyType;
  protocol:        string;
  pool:            string;
  asset:           string;
  tvlUSD:          number;
  grossAPY:        number;
  netAPY:          number;
  costs:           OpportunityCosts;
  risk:            OpportunityRisk;
  history: {
    apy7d:  number | null;
    apy30d: number | null;
    trend:  Trend;
    sigma:  number | null;
  };
  minTier:         RiskTier;
  score:           number;
  verifiedOnChain: boolean;
  llamaPoolId:     string;
  address:         string;
  updatedAt:       number;
}

// ── Position ──────────────────────────────────────────────────────────────────

export interface Position {
  id:              string;
  venueId:         string;
  venueName:       string;
  protocol:        string;
  strategyType:    StrategyType;
  entryAPY:        number;
  entryUSD:        number;
  entryTime:       number;
  currentAPY:      number;
  currentNetAPY:   number;
  currentUSD:      number;          // simulated NAV
  incomeEarnedUSD: number;          // accumulated yield income
  totalReturnUSD:  number;
  totalReturnPct:  number;
  effectiveAPY:    number;          // realized APY so far
  peakUSD:         number;
  drawdownPct:     number;
  daysHeld:        number;
  simulated:       true;
}

// ── Circuit Breakers ──────────────────────────────────────────────────────────

export interface CircuitBreaker {
  id:          string;
  name:        string;
  status:      CBStatus;
  value:       string;
  threshold:   string;
  description: string;
}

// ── Engines ───────────────────────────────────────────────────────────────────

export interface AllocationDecision {
  action:              ActionType;
  targetOpportunity:   Opportunity | null;
  currentOpportunity:  Opportunity | null;
  reason:              string;
  upliftPct:           number;
}

export interface SafetyCheckResult {
  passed:      boolean;
  abortReason: string | null;
  checks: {
    name:     string;
    passed:   boolean;
    value:    string;
    required: string;
  }[];
}

export interface ExecutionRecord {
  action:    ActionType;
  from:      string | null;
  to:        string;
  amountUSD: number;
  simulated: true;
  receiptHash: string;
  timestamp: number;
}

// ── Activity Log ──────────────────────────────────────────────────────────────

export interface LogEntry {
  id:        string;
  timestamp: number;
  level:     LogLevel;
  message:   string;
  detail?:   string;
}

// ── P&L History ──────────────────────────────────────────────────────────────

export interface PnLPoint {
  ts:        number;
  totalUSD:  number;   // NAV + harvested income
  navUSD:    number;
  incomeUSD: number;
}

// ── SSE Events ────────────────────────────────────────────────────────────────

export type EventType =
  | 'STATE_SNAPSHOT'
  | 'TICK_START'
  | 'OPPORTUNITIES'
  | 'ALLOCATION'
  | 'SAFETY'
  | 'EXECUTION'
  | 'POSITION'
  | 'BREAKERS'
  | 'LOG'
  | 'TICK_END';

export interface AgentEvent<T = unknown> {
  type:    EventType;
  ts:      number;
  payload: T;
}

// ── Per-user state (persisted to 0G Storage or local disk) ───────────────────

export interface UserState {
  userId:       string;
  policy:       UserPolicy;
  phase:        Phase;
  position:     Position | null;
  breakers:     CircuitBreaker[];
  pnlHistory:   PnLPoint[];
  executions:   ExecutionRecord[];
  log:          LogEntry[];
  updatedAt:    number;
  tickErrors:   number;          // consecutive tick failures for this user
}

// ── Global agent state (rebuilt each tick — not persisted directly) ───────────

export interface AgentState {
  users:         Record<string, UserState>;   // userId → per-user state
  opportunities: Opportunity[];               // shared market data (all users read same)
  globalLog:     LogEntry[];                  // agent-level events (not user-specific)
  lastTickAt:    number;
  nextTickAt:    number;
  block:         number;
  tickCount:     number;
}
