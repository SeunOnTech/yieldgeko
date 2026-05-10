// ─── Shared types for the YieldGeko Agent Orchestrator ───────────────────────

export type RiskTier     = 'conservative' | 'balanced' | 'aggressive' | 'advanced';
export type StrategyType =
  | 'GMX_REAL_YIELD'    // Counterparty to traders — real yield from trading fees
  | 'DELTA_NEUTRAL'     // LP + perp hedge — fee income, price-neutral
  | 'AAVE_LENDING'      // Passive lending — safe haven floor only
  | 'MORPHO_LENDING'    // Optimised lending — 50-150bps better than Aave
  | 'PENDLE_PT'         // Fixed yield bond — zero IL, predictable return
  | 'PENDLE_LP'         // Yield market LP — fees + PENDLE rewards, low IL
  | 'PENDLE_YT'         // Yield token speculation — advanced tier only
  | 'LEVERAGED_LOOP';   // Borrow-and-redeploy — amplified real yield
export type Trend     = 'rising' | 'falling' | 'stable' | 'unknown';
export type Phase     = 'INITIALIZING' | 'SCANNING' | 'ALLOCATED' | 'MONITORING' | 'MIGRATING' | 'SAFETY_EXIT' | 'WITHDRAWING' | 'IDLE' | 'PAUSED';
export type CBStatus  = 'GREEN' | 'YELLOW' | 'RED';
export type LogLevel  = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';
export type ActionType = 'HOLD' | 'GENESIS' | 'MIGRATE' | 'SAFETY_EXIT' | 'HARVEST' | 'REBALANCE' | 'REBALANCE_UNIV3' | 'WITHDRAW';
export type ILCategory = 'none' | 'low' | 'medium' | 'high';

// ── User Policy ───────────────────────────────────────────────────────────────

export interface UserPolicy {
  id:                    string;
  displayName:           string;
  riskTier:              RiskTier;
  managedUSD:            number;
  minAPY:                number;
  maxSlippageBps:        number;
  maxDrawdownPct:        number;
  maxFeeBps:             number;
  migrationThresholdPct: number;
  createdAt:             number;
  expiresAt:             number;
  // Real user fields — undefined for demo users (simulated path)
  isReal?:       boolean;   // true = real funds in vault, false = demo simulation
  userAddress?:  string;    // user's on-chain wallet address
  chainId?:      number;    // chain where vault is deployed (42161 = Arbitrum)
}

// ── Opportunities ─────────────────────────────────────────────────────────────

export interface OpportunityCosts {
  fundingAnnual:  number;
  executionPct:   number;
  gasAnnual:      number;
  oiPenalty:      number;
}

export interface OpportunityRisk {
  counterpartyRisk: 'none' | 'low' | 'medium' | 'high';
  ilRisk:           boolean;
  liquidationRisk:  boolean;
  rebalanceNeeded:  boolean;
  oiBalance:        number | null;
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
  realYieldAPY:    number;        // emission-adjusted: only real fee/interest income
  emissionFraction: number;       // 0-1, how much of APY is token emissions
  netAPY:          number;
  geckoScore:      number;        // proprietary multi-factor score
  costs:           OpportunityCosts;
  risk:            OpportunityRisk;
  history: {
    apy7d:    number | null;
    apy30d:   number | null;
    trend:    Trend;
    sigma:    number | null;
  };
  minTier:         RiskTier;
  verifiedOnChain: boolean;
  llamaPoolId:     string;
  address:         string;
  updatedAt:       number;
  // Pendle-specific
  maturityDate?:   number;        // unix timestamp — agent checks before deciding exit path
  impliedAPY?:     number;        // Pendle implied APY from market price
  ytAddress?:      string;        // YT token address (needed for redeemPyToToken)
  ptAddress?:      string;        // PT token address (needed for PT balance reads, distinct from market address)
  // For leveraged strategies
  borrowRateAPY?:  number;
  healthFactor?:   number;
  // LVR screener results — set for DELTA_NEUTRAL from uniV3Screener (not from DeFiLlama)
  lvrOptimalRangePct?: number;    // ±r% where net APY is maximised
  lvrConcentrationC?:  number;    // C factor at that range
  lvrCAvg?:            number;    // pool-average concentration (C_avg)
  lvrAdjFeeAPY?:       number;    // DeFiLlama APY × (C / C_avg) — what we actually earn
  lvrNetAPY?:          number;    // adjFeeAPY − lvrCost − gasFriction
  lvrSigmaDaily?:      number;    // daily ratio volatility (%)
  lvrEpochRatio?:      number;    // epoch fees / epoch IL — must be ≥ 1.2×
  lvrScoredAt?:        number;    // timestamp of last screener run
}

// ── Position (single venue, part of Portfolio) ────────────────────────────────

export interface Position {
  id:              string;
  venueId:         string;        // matches Opportunity.id
  venueAddress?:   string;        // protocol/market contract used for on-chain execution
  venueName:       string;
  protocol:        string;
  strategyType:    StrategyType;

  // Entry snapshot
  entryAPY:        number;
  entryUSD:        number;
  entryTime:       number;
  entryPriceUSD:   number;        // price of volatile asset at entry (0 for stable)

  // Live metrics
  currentAPY:      number;
  currentNetAPY:   number;
  currentUSD:      number;

  // Returns
  incomeEarnedUSD: number;        // accumulated yield/fee income
  totalReturnUSD:  number;        // currentUSD + incomeEarnedUSD - entryUSD
  totalReturnPct:  number;
  effectiveAPY:    number;        // realized APY since entry

  // IL tracking (per position, real-time)
  ilPct:           number;        // IL as fraction (0 for non-LP, ≤0 for LP)
  ilUSD:           number;        // IL in USD (0 or negative)
  ilCategory:      ILCategory;
  feesEarnedUSD:   number;        // accumulated fees ONLY (not counting NAV change)
  netAfterILUSD:   number;        // feesEarnedUSD + ilUSD (net position profit)
  isILProfitable:  boolean;       // fees outpacing IL?
  ilUnprofTicks:   number;        // consecutive ticks where IL > fees (exit signal)

  // Compounding
  pendingRewardsUSD: number;      // uncollected rewards ready to harvest
  lastHarvestAt:   number;

  // Non-rounded display/audit strings. Numeric USD fields above are kept for
  // calculations; these strings are for UI/API display when tiny values matter.
  currentUSDExact?:        string;
  incomeEarnedUSDExact?:   string;
  feesEarnedUSDExact?:     string;
  pendingRewardsUSDExact?: string;

  // Risk metrics
  peakUSD:         number;
  drawdownPct:     number;
  daysHeld:        number;

  // Aave leveraged loop
  healthFactor?:   number;        // Aave health factor (below 1.0 = liquidatable)
  borrowedUSD?:    number;        // total borrowed against collateral
  loopCount?:      number;        // number of borrow loops executed

  // Pendle PT/YT: maturity tracking
  maturityDate?:   number;        // unix timestamp — agent checks this before deciding how to exit
  ytAddress?:      string;        // YT token address (needed for redeemPyToToken at maturity)
  ptAddress?:      string;        // PT token address (needed for PT balance reads in position-reader)

  // Uniswap V3 / Delta-neutral LP position
  uniV3TokenId?:   string;
  uniV3Liquidity?: string;

  // Delta-neutral GMX hedge
  gmxOrderKey?:    string;        // bytes32 key of the GMX short order
  hedgeSizeUSD?:   number;        // USD value of the perp short

  // UniV3 active range tracking — set at mint, updated after every rebalance
  uniV3TickLower?:     number;    // current tickLower of the position
  uniV3TickUpper?:     number;    // current tickUpper of the position
  uniV3CenterTick?:    number;    // (tickLower + tickUpper) / 2 at last mint
  uniV3RangePct?:      number;    // ±r% used (from LVR screener optimal)
  uniV3EntryPool?:     string;    // pool address (for slot0 drift reads)
  uniV3LastDriftPct?:  number;    // last drift assessment (0–1, triggers rebalance at ≥0.70)
  uniV3Rebalances?:    number;    // total rebalances executed on this position

  // UniV3 out-of-range tracking (incremented each tick while price is outside tick range)
  uniV3OutOfRangeTicks?: number;

  // UniV3 exact fee accounting. The USD fields above stay numeric for
  // monitoring math; these strings preserve on-chain token-unit precision.
  uniV3Token0?:          string;
  uniV3Token1?:          string;
  uniV3Token0Decimals?:  number;
  uniV3Token1Decimals?:  number;
  uniV3TokensOwed0Raw?:  string;
  uniV3TokensOwed1Raw?:  string;
  uniV3TokensOwed0?:     string;
  uniV3TokensOwed1?:     string;
  uniV3PendingFees0USD?: number;
  uniV3PendingFees1USD?: number;
  uniV3PendingFees0USDExact?: string;
  uniV3PendingFees1USDExact?: string;
  uniV3PendingFeesUSDExact?:  string;

  // ── On-chain state for real-user accurate value reads ────────────────────
  // These are captured at deposit time and used by position-reader.ts each tick.
  // Only populated for isReal=true users; demo users stay formula-based.

  // Aave / LEVERAGED_LOOP: liquidityIndex at entry (1e27 ray, stored as decimal string)
  // currentValue = entryUSD × (currentIndex / entryIndex)
  entryLiquidityIndex?: string;

  // Morpho (ERC-4626 vault): share tokens received at deposit
  // currentValue = vault.convertToAssets(morphoShares)
  morphoShares?: string;

  // Pendle LP: LP tokens received at deposit
  // currentValue = pendleLpAmount × oracle.getLpToAssetRate(market, 900) / 1e18
  pendleLpAmount?: string;

  // GMX: GM tokens held (captured once async deposit settles)
  // currentValue = gmTokenAmount × (poolValueUSD / totalSupply)
  gmTokenAmount?: string;

  simulated:       boolean;
}

// ── Portfolio (multi-position, replaces single Position) ─────────────────────

export interface PortfolioPosition extends Position {
  allocationPct:   number;        // target % of total capital
  allocationUSD:   number;        // USD amount allocated
  geckoScore:      number;        // score at time of entry
}

export interface PortfolioMetrics {
  totalValueUSD:   number;
  totalEntryUSD:   number;
  totalReturnUSD:  number;
  totalReturnPct:  number;
  incomeEarnedUSD: number;
  totalILUSD:      number;        // sum of all IL (negative)
  weightedNetAPY:  number;        // capital-weighted average
  realYieldAPY:    number;        // real yield only
  peakValueUSD:    number;
  drawdownPct:     number;
  diversificationScore: number;   // 0-1 (1 = fully uncorrelated)
  ilCoveredByFees: boolean;       // are fees > IL across full portfolio?
}

export interface Portfolio {
  positions:       PortfolioPosition[];
  metrics:         PortfolioMetrics;
  lastRebalanceAt: number;
  updatedAt:       number;
}

// ── Allocation targets per tier ───────────────────────────────────────────────

export interface AllocationTarget {
  strategyType: StrategyType;
  minPct:       number;
  maxPct:       number;
  targetPct:    number;
  priority:     number;           // lower = filled first
}

// ── Circuit Breakers ──────────────────────────────────────────────────────────

export interface CircuitBreaker {
  id:          string;
  name:        string;
  status:      CBStatus;
  value:       string;
  threshold:   string;
  description: string;
  positionId?: string;            // per-position breaker if set
}

// ── Engines ───────────────────────────────────────────────────────────────────

export interface AllocationDecision {
  action:              ActionType;
  targetOpportunity:   Opportunity | null;
  currentOpportunity:  Opportunity | null;
  reason:              string;
  upliftPct:           number;
  // Portfolio-level decisions
  rebalanceTargets?:   { positionId: string; newAllocationPct: number }[];
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

export interface HarvestRecommendation {
  shouldHarvest:     boolean;
  positionId:        string;
  pendingRewardsUSD: number;
  estimatedGasUSD:   number;
  netGainUSD:        number;
  reason:            string;
}

export interface ExecutionRecord {
  action:      ActionType;
  from:        string | null;
  to:          string;
  amountUSD:   number;
  simulated:   boolean;
  receiptHash: string;
  txHash?:     string;    // on-chain tx hash (undefined for simulated)
  timestamp:   number;
  portfolioValueBefore?: number;
  portfolioValueAfter?:  number;
  sessionId?:  string;
}

// ── Activity Log ──────────────────────────────────────────────────────────────

export interface LogEntry {
  id:        string;
  timestamp: number;
  level:     LogLevel;
  message:   string;
  detail?:   string;
  sessionId?: string;
}

// ── P&L History ──────────────────────────────────────────────────────────────

export interface PnLPoint {
  ts:         number;
  totalUSD:   number;
  navUSD:     number;
  incomeUSD:  number;
  ilUSD:      number;             // IL component (negative)
  netUSD:     number;             // income + IL
}

// ── SSE Events ────────────────────────────────────────────────────────────────

export type EventType =
  | 'STATE_SNAPSHOT'
  | 'TICK_START'
  | 'OPPORTUNITIES'
  | 'ALLOCATION'
  | 'SAFETY'
  | 'EXECUTION'
  | 'PORTFOLIO'       // replaces POSITION
  | 'BREAKERS'
  | 'HARVEST'
  | 'LOG'
  | 'TICK_END';

export interface AgentEvent<T = unknown> {
  type:    EventType;
  ts:      number;
  payload: T;
}

// ── Per-user state (persisted) ────────────────────────────────────────────────

export interface UserState {
  userId:       string;
  policy:       UserPolicy;
  phase:        Phase;
  portfolio:    Portfolio | null;   // replaces position: Position | null
  breakers:     CircuitBreaker[];
  pnlHistory:   PnLPoint[];
  executions:   ExecutionRecord[];
  log:          LogEntry[];
  activeSessionId:        string;
  activeSessionStartedAt: number;
  updatedAt:    number;
  tickErrors:   number;
}

// ── Global agent state ────────────────────────────────────────────────────────

export interface AgentState {
  users:         Record<string, UserState>;
  opportunities: Opportunity[];
  globalLog:     LogEntry[];
  lastTickAt:    number;
  nextTickAt:    number;
  block:         number;
  tickCount:     number;
}
