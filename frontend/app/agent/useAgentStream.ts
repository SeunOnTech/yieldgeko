'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ── Types (mirrors packages/agent/src/orchestrator/types.ts) ──────────────────

export type RiskTier     = 'conservative' | 'balanced' | 'aggressive' | 'advanced';
export type StrategyType =
  | 'GMX_REAL_YIELD' | 'DELTA_NEUTRAL' | 'AAVE_LENDING'
  | 'MORPHO_LENDING' | 'PENDLE_PT' | 'PENDLE_LP' | 'PENDLE_YT' | 'LEVERAGED_LOOP';
export type Trend        = 'rising' | 'falling' | 'stable' | 'unknown';
export type Phase        = 'INITIALIZING' | 'SCANNING' | 'ALLOCATED' | 'MONITORING' | 'MIGRATING' | 'SAFETY_EXIT' | 'IDLE';
export type CBStatus     = 'GREEN' | 'YELLOW' | 'RED';
export type LogLevel     = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';
export type ActionType   = 'HOLD' | 'GENESIS' | 'MIGRATE' | 'SAFETY_EXIT' | 'HARVEST' | 'REBALANCE';
export type ILCategory   = 'none' | 'low' | 'medium' | 'high';
export type EventType    =
  | 'STATE_SNAPSHOT' | 'TICK_START' | 'OPPORTUNITIES' | 'ALLOCATION'
  | 'SAFETY' | 'EXECUTION' | 'PORTFOLIO' | 'BREAKERS' | 'HARVEST' | 'LOG' | 'TICK_END';

export interface UserPolicy {
  id: string; displayName: string; riskTier: RiskTier;
  managedUSD: number; minAPY: number; maxSlippageBps: number;
  maxDrawdownPct: number; maxFeeBps: number; migrationThresholdPct: number;
  createdAt: number; expiresAt: number;
}

export interface OpportunityRisk {
  counterpartyRisk: 'none' | 'low' | 'medium' | 'high';
  ilRisk: boolean; liquidationRisk: boolean; rebalanceNeeded: boolean;
  oiBalance: number | null; oiRiskFlag: boolean;
}

export interface Opportunity {
  id: string; strategyType: StrategyType; protocol: string; pool: string;
  asset: string; tvlUSD: number; grossAPY: number; realYieldAPY: number;
  emissionFraction: number; netAPY: number; geckoScore: number;
  costs: { fundingAnnual: number; executionPct: number; gasAnnual: number; oiPenalty: number };
  risk: OpportunityRisk;
  history: { apy7d: number | null; apy30d: number | null; trend: Trend; sigma: number | null };
  minTier: RiskTier; verifiedOnChain: boolean;
  llamaPoolId: string; address: string; updatedAt: number;
}

export interface PortfolioPosition {
  id: string; venueId: string; venueName: string; protocol: string;
  strategyType: StrategyType;
  allocationPct: number; allocationUSD: number; geckoScore: number;
  entryAPY: number; entryUSD: number; entryTime: number; entryPriceUSD: number;
  currentAPY: number; currentNetAPY: number; currentUSD: number;
  incomeEarnedUSD: number; totalReturnUSD: number; totalReturnPct: number;
  effectiveAPY: number;
  ilPct: number; ilUSD: number; ilCategory: ILCategory;
  feesEarnedUSD: number; netAfterILUSD: number; isILProfitable: boolean; ilUnprofTicks: number;
  pendingRewardsUSD: number; lastHarvestAt: number;
  peakUSD: number; drawdownPct: number; daysHeld: number; simulated: true;
}

export interface PortfolioMetrics {
  totalValueUSD: number; totalEntryUSD: number; totalReturnUSD: number;
  totalReturnPct: number; incomeEarnedUSD: number; totalILUSD: number;
  weightedNetAPY: number; realYieldAPY: number;
  peakValueUSD: number; drawdownPct: number;
  diversificationScore: number; ilCoveredByFees: boolean;
}

export interface Portfolio {
  positions: PortfolioPosition[];
  metrics: PortfolioMetrics;
  lastRebalanceAt: number; updatedAt: number;
}

export interface CircuitBreaker {
  id: string; name: string; status: CBStatus;
  value: string; threshold: string; description: string; positionId?: string;
}

export interface LogEntry {
  id: string; timestamp: number; level: LogLevel; message: string; detail?: string;
}

export interface PnLPoint {
  ts: number; totalUSD: number; navUSD: number; incomeUSD: number;
  ilUSD: number; netUSD: number;
}

export interface ExecutionRecord {
  action: ActionType; from: string | null; to: string;
  amountUSD: number; simulated: true; receiptHash: string; timestamp: number;
  portfolioValueBefore?: number;
}

export interface UserState {
  userId:     string;
  policy:     UserPolicy;
  phase:      Phase;
  portfolio:  Portfolio | null;
  breakers:   CircuitBreaker[];
  pnlHistory: PnLPoint[];
  executions: ExecutionRecord[];
  log:        LogEntry[];
  updatedAt:  number;
  tickErrors: number;
}

export interface AgentState {
  users:         Record<string, UserState>;
  opportunities: Opportunity[];
  globalLog:     LogEntry[];
  lastTickAt:    number;
  nextTickAt:    number;
  block:         number;
  tickCount:     number;
}

export interface AllocationDecision {
  action: ActionType; targetOpportunity: Opportunity | null;
  currentOpportunity: Opportunity | null; reason: string; upliftPct: number;
}

// ── Stream state ──────────────────────────────────────────────────────────────

export interface StreamState {
  agent:       AgentState | null;
  connected:   boolean;
  lastEvent:   EventType | null;
  allocation:  AllocationDecision | null;
  safetyCheck: { passed: boolean; checks: { name: string; passed: boolean; value: string; required: string }[]; abortReason: string | null } | null;
}

const DEFAULT: StreamState = { agent: null, connected: false, lastEvent: null, allocation: null, safetyCheck: null };

const SSE_URL = process.env.NEXT_PUBLIC_AGENT_SSE_URL ?? 'http://localhost:3001/events';

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAgentStream(): StreamState {
  const [stream, setStream] = useState<StreamState>(DEFAULT);
  const esRef    = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    esRef.current?.close();
    const es = new EventSource(SSE_URL);
    esRef.current = es;

    es.onopen  = () => setStream(s => ({ ...s, connected: true }));
    es.onerror = () => {
      setStream(s => ({ ...s, connected: false }));
      es.close();
      retryRef.current = setTimeout(connect, 3_000);
    };

    es.onmessage = (evt) => {
      try {
        const { type, payload } = JSON.parse(evt.data) as { type: EventType; payload: unknown };
        setStream(prev => applyEvent(prev, type, payload));
      } catch { /* ignore parse errors */ }
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [connect]);

  return stream;
}

// ── Event reducer ─────────────────────────────────────────────────────────────

function applyEvent(prev: StreamState, type: EventType, payload: unknown): StreamState {
  const next = { ...prev, lastEvent: type };

  switch (type) {
    case 'STATE_SNAPSHOT':
      return { ...next, agent: payload as AgentState };

    case 'OPPORTUNITIES':
      if (!next.agent) return next;
      return { ...next, agent: { ...next.agent, opportunities: (payload as any).opportunities ?? [] } };

    case 'PORTFOLIO': {
      if (!next.agent) return next;
      const { userId: uid, portfolio } = payload as any;
      if (!uid || !next.agent.users[uid]) return next;
      return { ...next, agent: { ...next.agent, users: { ...next.agent.users, [uid]: { ...next.agent.users[uid], portfolio } } } };
    }

    case 'BREAKERS': {
      if (!next.agent) return next;
      const { userId: uid, breakers } = payload as any;
      if (!uid || !next.agent.users[uid]) return next;
      return { ...next, agent: { ...next.agent, users: { ...next.agent.users, [uid]: { ...next.agent.users[uid], breakers } } } };
    }

    case 'ALLOCATION': {
      const d = payload as any;
      return { ...next, allocation: (d.decision ?? d) as AllocationDecision };
    }

    case 'SAFETY':
      return { ...next, safetyCheck: (payload as any).safety ?? payload as any };

    case 'EXECUTION': {
      if (!next.agent) return next;
      const { userId: uid, record } = payload as any;
      if (!uid || !next.agent.users[uid]) return next;
      const u = next.agent.users[uid];
      return { ...next, agent: { ...next.agent, users: { ...next.agent.users, [uid]: { ...u, executions: [record as ExecutionRecord, ...u.executions].slice(0, 50) } } } };
    }

    case 'LOG': {
      if (!next.agent) return next;
      const { userId: uid, entry } = payload as any;
      const logEntry = entry as LogEntry;
      if (uid === '__global__') {
        return { ...next, agent: { ...next.agent, globalLog: [logEntry, ...next.agent.globalLog].slice(0, 80) } };
      }
      if (!next.agent.users[uid]) return next;
      const u = next.agent.users[uid];
      return { ...next, agent: { ...next.agent, users: { ...next.agent.users, [uid]: { ...u, log: [logEntry, ...u.log].slice(0, 80) } } } };
    }

    case 'TICK_END': {
      const { tick, users: tickUsers } = payload as any;
      if (!next.agent) return next;
      const updatedUsers = { ...next.agent.users };
      if (Array.isArray(tickUsers)) {
        for (const tu of tickUsers) {
          if (updatedUsers[tu.userId]) {
            updatedUsers[tu.userId] = { ...updatedUsers[tu.userId], phase: tu.phase };
          }
        }
      }
      return {
        ...next,
        agent: { ...next.agent, users: updatedUsers, tickCount: tick ?? next.agent.tickCount, lastTickAt: Date.now(), nextTickAt: Date.now() + 60_000 },
      };
    }

    default:
      return next;
  }
}
