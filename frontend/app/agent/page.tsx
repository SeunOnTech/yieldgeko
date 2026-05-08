'use client';

import { useState } from 'react';
import { useAgentStream } from './useAgentStream';
import type {
  Opportunity, UserState, Portfolio, PortfolioPosition, CircuitBreaker, LogEntry,
  PnLPoint, ExecutionRecord, Phase, CBStatus, StrategyType, ILCategory,
} from './useAgentStream';

// ── Formatting helpers ────────────────────────────────────────────────────────

function fAPY(n: number | null | undefined): string {
  if (n == null) return '—';
  return n >= 100 ? `${n.toFixed(1)}%` : `${n.toFixed(2)}%`;
}

function fUSD(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fDelta(n: number | null | undefined, suffix = '%'): string {
  if (n == null || !isFinite(n)) return '—';
  return n >= 0 ? `+${n.toFixed(2)}${suffix}` : `${n.toFixed(2)}${suffix}`;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function fTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

// ── Colours ───────────────────────────────────────────────────────────────────

const STRAT_COLOR: Record<StrategyType, string> = {
  GMX_REAL_YIELD:  '#f97316',
  DELTA_NEUTRAL:   '#a855f7',
  AAVE_LENDING:    '#3b82f6',
  MORPHO_LENDING:  '#06b6d4',
  PENDLE_PT:       '#22c55e',
  PENDLE_LP:       '#84cc16',
  PENDLE_YT:       '#eab308',
  LEVERAGED_LOOP:  '#ef4444',
};

const STRAT_LABEL: Record<StrategyType, string> = {
  GMX_REAL_YIELD:  'GMX',
  DELTA_NEUTRAL:   'ΔNEU',
  AAVE_LENDING:    'LEND',
  MORPHO_LENDING:  'MRPH',
  PENDLE_PT:       'PT',
  PENDLE_LP:       'PLP',
  PENDLE_YT:       'YT',
  LEVERAGED_LOOP:  'LEV',
};

const CB_COLOR: Record<CBStatus, string> = {
  GREEN:  '#22c55e',
  YELLOW: '#eab308',
  RED:    '#ef4444',
};

const LOG_COLOR: Record<string, string> = {
  INFO:    '#94a3b8',
  SUCCESS: '#22c55e',
  WARN:    '#eab308',
  ERROR:   '#ef4444',
};

const PHASE_COLOR: Record<Phase, string> = {
  INITIALIZING: '#94a3b8',
  SCANNING:     '#60a5fa',
  ALLOCATED:    '#22c55e',
  MONITORING:   '#22c55e',
  MIGRATING:    '#f97316',
  SAFETY_EXIT:  '#ef4444',
  IDLE:         '#64748b',
};

// ── SVG P&L Chart ─────────────────────────────────────────────────────────────

function PnLChart({ history, entryUSD }: { history: PnLPoint[]; entryUSD: number; }) {
  const W = 600; const H = 120; const PAD = 6;

  // With a single point, draw a flat baseline at entry value
  if (history.length < 2) {
    const flatY = H / 2;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H, display: 'block' }}>
        <line x1={PAD} y1={flatY} x2={W - PAD} y2={flatY}
          stroke="#334155" strokeWidth="1" strokeDasharray="4,3" />
        <circle cx={PAD} cy={flatY} r="4" fill="#22c55e" stroke="#0f172a" strokeWidth="2" />
        <text x={W / 2} y={H - 8} textAnchor="middle" fill="#334155" fontSize="11">
          Accumulating data — next update in ~60s
        </text>
      </svg>
    );
  }

  const vals   = history.map(p => p.totalUSD);
  const minVal = Math.min(entryUSD * 0.98, ...vals);
  const maxVal = Math.max(entryUSD * 1.02, ...vals);
  const range  = maxVal - minVal || 1;

  const toX = (i: number) => PAD + (i / (history.length - 1)) * (W - PAD * 2);
  const toY = (v: number) => H - PAD - ((v - minVal) / range) * (H - PAD * 2);

  const linePts  = history.map((p, i) => `${toX(i)},${toY(p.totalUSD)}`).join(' ');
  const entryY   = toY(entryUSD);
  const lastVal  = vals[vals.length - 1] ?? entryUSD;
  const isUp     = lastVal >= entryUSD;
  const lineColor = isUp ? '#22c55e' : '#ef4444';

  // Area fill path
  const areaPath = [
    `M ${toX(0)},${H - PAD}`,
    ...history.map((p, i) => `L ${toX(i)},${toY(p.totalUSD)}`),
    `L ${toX(history.length - 1)},${H - PAD}`,
    'Z',
  ].join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H, display: 'block' }}>
      <defs>
        <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={lineColor} stopOpacity="0.25" />
          <stop offset="100%" stopColor={lineColor} stopOpacity="0.00" />
        </linearGradient>
      </defs>

      {/* Entry baseline */}
      <line x1={PAD} y1={entryY} x2={W - PAD} y2={entryY}
        stroke="#334155" strokeWidth="1" strokeDasharray="4,3" />

      {/* Area fill */}
      <path d={areaPath} fill="url(#chartGrad)" />

      {/* P&L line */}
      <polyline fill="none" stroke={lineColor} strokeWidth="2"
        points={linePts} strokeLinejoin="round" strokeLinecap="round" />

      {/* Current dot */}
      <circle cx={toX(history.length - 1)} cy={toY(lastVal)}
        r="4" fill={lineColor} stroke="#0f172a" strokeWidth="2" />

      {/* Labels */}
      <text x={PAD} y={H - PAD - 2} fill="#475569" fontSize="10">{fUSD(minVal)}</text>
      <text x={PAD} y={PAD + 10}    fill="#475569" fontSize="10">{fUSD(maxVal)}</text>
    </svg>
  );
}

// ── Opportunity leaderboard row ────────────────────────────────────────────────

function OppRow({ opp, rank, isActive }: { opp: Opportunity; rank: number; isActive: boolean }) {
  const trendIcon  = { rising: '↑', falling: '↓', stable: '→', unknown: '·' }[opp.history.trend];
  const trendColor = { rising: '#22c55e', falling: '#ef4444', stable: '#eab308', unknown: '#475569' }[opp.history.trend];
  const apyColor   = opp.netAPY >= 20 ? '#f97316' : opp.netAPY >= 10 ? '#eab308' : '#22c55e';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 10px',
      background: isActive ? 'rgba(34,197,94,0.07)' : rank % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
      borderLeft: isActive ? '3px solid #22c55e' : '3px solid transparent',
      borderRadius: 4, fontSize: 13,
    }}>
      {/* Rank */}
      <span style={{ color: '#475569', fontWeight: 600, width: 20, flexShrink: 0, textAlign: 'right' }}>{rank}</span>

      {/* Strategy badge */}
      <span style={{
        background: STRAT_COLOR[opp.strategyType] + '22',
        color: STRAT_COLOR[opp.strategyType],
        borderRadius: 4, padding: '2px 5px', fontSize: 10, fontWeight: 700,
        flexShrink: 0, width: 36, textAlign: 'center',
      }}>
        {STRAT_LABEL[opp.strategyType]}
      </span>

      {/* Protocol + pool — takes remaining space */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: '#e2e8f0', fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {opp.protocol}
        </div>
        <div style={{ color: '#475569', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {opp.pool}
          {opp.risk.oiBalance !== null && (
            <span style={{ marginLeft: 6, color: opp.risk.oiRiskFlag ? '#ef4444' : '#64748b' }}>
              OI:{(opp.risk.oiBalance * 100).toFixed(0)}%
            </span>
          )}
        </div>
      </div>

      {/* Net APY — key number */}
      <div style={{ textAlign: 'right', flexShrink: 0, width: 68 }}>
        <div style={{ color: apyColor, fontWeight: 700, fontSize: 14 }}>{fAPY(opp.netAPY)}</div>
        <div style={{ color: '#334155', fontSize: 10 }}>net</div>
      </div>

      {/* 30d mean + trend */}
      <div style={{ textAlign: 'right', flexShrink: 0, width: 60 }}>
        <div style={{ color: trendColor, fontSize: 12 }}>{trendIcon} {fAPY(opp.history.apy30d)}</div>
        <div style={{ color: '#334155', fontSize: 10 }}>30d</div>
      </div>

      {/* GeckoScore */}
      <div style={{ textAlign: 'right', flexShrink: 0, width: 40 }}>
        <div style={{ color: (opp.geckoScore ?? 0) > 40 ? '#22c55e' : (opp.geckoScore ?? 0) > 20 ? '#eab308' : '#64748b', fontSize: 11, fontWeight: 700 }}>
          {(opp.geckoScore ?? 0).toFixed(0)}
        </div>
        <div style={{ color: '#334155', fontSize: 9 }}>gecko</div>
      </div>
    </div>
  );
}

// ── Circuit breaker pill ──────────────────────────────────────────────────────

function BreakerPill({ breaker }: { breaker: CircuitBreaker }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      padding: '10px 14px', borderRadius: 8,
      border: `1px solid ${CB_COLOR[breaker.status]}33`,
      background: `${CB_COLOR[breaker.status]}0d`,
      minWidth: 140,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: CB_COLOR[breaker.status], flexShrink: 0 }} />
        <span style={{ color: '#94a3b8', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {breaker.name}
        </span>
      </div>
      <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: 15 }}>{breaker.value}</div>
      <div style={{ color: '#475569', fontSize: 11 }}>{breaker.threshold}</div>
    </div>
  );
}

// ── Log entry ─────────────────────────────────────────────────────────────────

function LogLine({ entry }: { entry: LogEntry }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '5px 0', borderBottom: '1px solid #0f172a', alignItems: 'flex-start' }}>
      <span style={{ color: '#334155', fontSize: 11, flexShrink: 0, paddingTop: 1 }}>
        {fTime(entry.timestamp)}
      </span>
      <span style={{
        color: LOG_COLOR[entry.level] ?? '#94a3b8',
        fontSize: 11, fontWeight: 700, flexShrink: 0,
        width: 52, textAlign: 'right',
      }}>
        {entry.level}
      </span>
      <div>
        <div style={{ color: '#cbd5e1', fontSize: 12 }}>{entry.message}</div>
        {entry.detail && (
          <div style={{ color: '#475569', fontSize: 11, marginTop: 2 }}>{entry.detail}</div>
        )}
      </div>
    </div>
  );
}

// ── Execution history row ────────────────────────────────────────────────────

function ExecRow({ exec }: { exec: ExecutionRecord }) {
  const COLOR: Record<string, string> = {
    GENESIS: '#22c55e', MIGRATE: '#f97316', SAFETY_EXIT: '#ef4444', HARVEST: '#a855f7', HOLD: '#64748b',
  };
  return (
    <div style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: '1px solid #0f172a', fontSize: 12 }}>
      <span style={{ color: '#475569', flexShrink: 0 }}>{fTime(exec.timestamp)}</span>
      <span style={{ color: COLOR[exec.action] ?? '#94a3b8', fontWeight: 700, width: 80, flexShrink: 0 }}>
        {exec.action}
      </span>
      <span style={{ color: '#94a3b8', flexShrink: 0 }}>→ {exec.to}</span>
      <span style={{ color: '#475569', marginLeft: 'auto', flexShrink: 0 }}>{fUSD(exec.amountUSD)}</span>
    </div>
  );
}

// ── Section card wrapper ──────────────────────────────────────────────────────

function Card({ title, badge, children, style }: {
  title: string; badge?: React.ReactNode;
  children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <div style={{
      background: '#0f172a', border: '1px solid #1e293b',
      borderRadius: 12, overflow: 'hidden',
      display: 'flex', flexDirection: 'column', ...style,
    }}>
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid #1e293b',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ color: '#94a3b8', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {title}
        </span>
        {badge}
      </div>
      <div style={{ padding: 16, flex: 1, overflow: 'hidden' }}>{children}</div>
    </div>
  );
}

// ── Phase badge ───────────────────────────────────────────────────────────────

function PhaseBadge({ phase }: { phase: Phase }) {
  return (
    <span style={{
      background: `${PHASE_COLOR[phase]}22`, color: PHASE_COLOR[phase],
      border: `1px solid ${PHASE_COLOR[phase]}44`,
      borderRadius: 6, padding: '2px 10px', fontSize: 11, fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '0.06em',
    }}>
      {phase}
    </span>
  );
}

// ── User selector tab ─────────────────────────────────────────────────────────

function UserTab({
  user, isActive, onClick,
}: { user: UserState; isActive: boolean; onClick: () => void }) {
  const phaseColor = PHASE_COLOR[user.phase] ?? '#64748b';
  const ret        = user.portfolio?.metrics.totalReturnPct ?? null;
  return (
    <button onClick={onClick} style={{
      padding: '8px 16px', borderRadius: 8, cursor: 'pointer',
      background: isActive ? '#1e293b' : 'transparent',
      border: `1px solid ${isActive ? '#334155' : 'transparent'}`,
      display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: phaseColor }} />
        <span style={{ color: isActive ? '#f1f5f9' : '#64748b', fontSize: 13, fontWeight: 600 }}>
          {user.policy.displayName}
        </span>
      </div>
      <div style={{ fontSize: 11, color: '#475569', paddingLeft: 12 }}>
        {user.policy.riskTier} · {fUSD(user.policy.managedUSD)}
        {ret !== null && (
          <span style={{ marginLeft: 6, color: ret >= 0 ? '#22c55e' : '#ef4444' }}>
            {fDelta(ret)}
          </span>
        )}
      </div>
    </button>
  );
}

// ── Main dashboard ────────────────────────────────────────────────────────────

export default function AgentDashboard() {
  const { agent, connected, allocation, safetyCheck } = useAgentStream();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  // Resolve selected user — default to first user if none selected
  const userIds   = Object.keys(agent?.users ?? {});
  const activeId  = selectedUserId ?? userIds[0] ?? null;
  const activeUser: UserState | null = activeId && agent?.users[activeId] ? agent.users[activeId] : null;

  const portfolio = activeUser?.portfolio ?? null;
  const pos       = portfolio?.positions[0] ?? null;   // primary position for legacy displays
  const opps      = agent?.opportunities ?? [];
  const brks      = activeUser?.breakers ?? [];
  const logs      = activeUser?.log ?? [];
  const glog      = agent?.globalLog ?? [];
  const pnl       = activeUser?.pnlHistory ?? [];
  const execs     = activeUser?.executions ?? [];

  const activeOppId = pos?.venueId ?? null;
  const metrics     = portfolio?.metrics ?? null;

  const redCount    = brks.filter(b => b.status === 'RED').length;
  const yellowCount = brks.filter(b => b.status === 'YELLOW').length;

  // ── Connecting screen ────────────────────────────────────────────────────

  if (!agent && !connected) {
    return (
      <div style={{
        minHeight: '100vh', background: '#020817',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-geist-mono, monospace)',
      }}>
        <div style={{ textAlign: 'center', color: '#475569' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🦎</div>
          <div style={{ fontSize: 18, color: '#64748b', marginBottom: 8 }}>Connecting to agent...</div>
          <div style={{ fontSize: 13 }}>Make sure the orchestrator is running on port 3001</div>
          <div style={{ fontSize: 12, marginTop: 8, color: '#334155' }}>
            pnpm --dir packages/agent run orchestrator
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#020817',
      fontFamily: 'var(--font-geist-mono, monospace)',
      color: '#e2e8f0',
      padding: 20,
    }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #1e293b',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 28 }}>🦎</span>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#f1f5f9' }}>YieldGeko Agent</div>
            <div style={{ fontSize: 12, color: '#475569' }}>
              {userIds.length} user{userIds.length !== 1 ? 's' : ''} · block #{agent?.block.toLocaleString() ?? '—'} · tick #{agent?.tickCount ?? 0}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {activeUser && <PhaseBadge phase={activeUser.phase} />}

          {/* Connection status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: connected ? '#22c55e' : '#ef4444',
              boxShadow: connected ? '0 0 6px #22c55e88' : 'none',
            }} />
            <span style={{ fontSize: 12, color: connected ? '#22c55e' : '#ef4444' }}>
              {connected ? 'Live' : 'Disconnected'}
            </span>
          </div>

          {/* Persistence mode badge */}
          <span style={{ fontSize: 10, color: '#334155', border: '1px solid #1e293b', borderRadius: 4, padding: '2px 6px' }}>
            💾 {connected ? 'live' : 'offline'}
          </span>
        </div>
      </div>

      {/* ── User selector tabs ────────────────────────────────────────────── */}
      {userIds.length > 0 && (
        <div style={{
          display: 'flex', gap: 8, marginBottom: 16,
          borderBottom: '1px solid #1e293b', paddingBottom: 12,
          overflowX: 'auto',
        }}>
          {userIds.map(uid => (
            <UserTab
              key={uid}
              user={agent!.users[uid]}
              isActive={uid === activeId}
              onClick={() => setSelectedUserId(uid)}
            />
          ))}
        </div>
      )}

      {/* ── Top metrics strip ──────────────────────────────────────────────── */}
      {metrics && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: 10, marginBottom: 20,
        }}>
          {[
            { label: 'Portfolio USD',   value: fUSD(metrics.totalValueUSD),    color: metrics.totalReturnUSD >= 0 ? '#22c55e' : '#ef4444' },
            { label: 'Total Return',    value: fDelta(metrics.totalReturnPct),  color: metrics.totalReturnPct >= 0 ? '#22c55e' : '#ef4444' },
            { label: 'Income Earned',   value: fUSD(metrics.incomeEarnedUSD),   color: '#a855f7' },
            { label: 'IL Impact',       value: metrics.totalILUSD < -0.01 ? `-${fUSD(Math.abs(metrics.totalILUSD))}` : '~$0', color: metrics.totalILUSD < -10 ? '#ef4444' : '#22c55e' },
            { label: 'Weighted APY',    value: fAPY(metrics.weightedNetAPY),    color: '#f97316' },
            { label: 'Real Yield APY',  value: fAPY(metrics.realYieldAPY),      color: '#3b82f6' },
            { label: 'Drawdown',        value: `-${(metrics.drawdownPct ?? 0).toFixed(2)}%`, color: (metrics.drawdownPct ?? 0) > 5 ? '#ef4444' : '#475569' },
            { label: 'Diversification', value: `${((metrics.diversificationScore ?? 0) * 100).toFixed(0)}%`, color: '#64748b' },
          ].map(m => (
            <div key={m.label} style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ color: '#475569', fontSize: 10, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{m.label}</div>
              <div style={{ color: m.color, fontSize: 18, fontWeight: 700 }}>{m.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Portfolio positions breakdown ──────────────────────────────────── */}
      {portfolio && portfolio.positions.length > 1 && (
        <div style={{ marginBottom: 16 }}>
          <Card title="Portfolio Positions" badge={
            <span style={{ fontSize: 11, color: '#475569' }}>{portfolio.positions.length} active · diversification {((metrics?.diversificationScore ?? 0) * 100).toFixed(0)}%</span>
          }>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {portfolio.positions.map(p => (
                <div key={p.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 10px', borderRadius: 6,
                  background: p.isILProfitable ? 'rgba(34,197,94,0.05)' : 'rgba(239,68,68,0.05)',
                  border: `1px solid ${p.isILProfitable ? '#22c55e22' : '#ef444422'}`,
                }}>
                  <span style={{ background: STRAT_COLOR[p.strategyType] + '22', color: STRAT_COLOR[p.strategyType], borderRadius: 4, padding: '2px 5px', fontSize: 10, fontWeight: 700, flexShrink: 0, width: 36, textAlign: 'center' }}>
                    {STRAT_LABEL[p.strategyType]}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: '#e2e8f0', fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.protocol}</div>
                    <div style={{ color: '#475569', fontSize: 11 }}>{p.venueName} · {p.allocationPct.toFixed(0)}% · {fUSD(p.allocationUSD)}</div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ color: p.currentNetAPY >= 8 ? '#22c55e' : '#eab308', fontWeight: 700, fontSize: 13 }}>{fAPY(p.currentNetAPY)}</div>
                    <div style={{ fontSize: 10, color: '#475569' }}>net APY</div>
                  </div>
                  {p.ilCategory !== 'none' && (
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ color: p.isILProfitable ? '#22c55e' : '#ef4444', fontSize: 12 }}>
                        IL: {(p.ilPct * 100).toFixed(1)}%
                      </div>
                      <div style={{ fontSize: 10, color: '#475569' }}>{p.isILProfitable ? '✓ covered' : '⚠ uncovered'}</div>
                    </div>
                  )}
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ color: p.totalReturnPct >= 0 ? '#22c55e' : '#ef4444', fontWeight: 600, fontSize: 12 }}>
                      {fDelta(p.totalReturnPct)}
                    </div>
                    <div style={{ fontSize: 10, color: '#475569' }}>return</div>
                  </div>
                  <div style={{ fontSize: 10, color: '#334155', flexShrink: 0 }}>
                    {p.geckoScore?.toFixed(1) ?? '—'}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ── Grid layout ────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 16 }}>

        {/* ── Left column ────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>

          {/* P&L Chart */}
          <Card
            title="P&L Timeline"
            badge={pos ? (
              <span style={{ fontSize: 12, color: pos.totalReturnUSD >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                {fDelta(pos.totalReturnUSD, ' USD')}
              </span>
            ) : null}
          >
            {metrics ? (
              <>
                <PnLChart history={pnl} entryUSD={metrics.totalEntryUSD} />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 11, color: '#475569' }}>
                  <span>Entry: {fUSD(metrics.totalEntryUSD)}</span>
                  <span>{portfolio?.positions.length ?? 0} position{portfolio?.positions.length !== 1 ? 's' : ''}</span>
                  <span style={{ color: metrics.totalReturnUSD >= 0 ? '#22c55e' : '#ef4444' }}>
                    Now: {fUSD(metrics.totalValueUSD)} ({fDelta(metrics.totalReturnPct)})
                  </span>
                </div>
                {metrics.totalILUSD < -1 && (
                  <div style={{ marginTop: 6, fontSize: 11, color: metrics.ilCoveredByFees ? '#22c55e' : '#ef4444' }}>
                    IL: -{fUSD(Math.abs(metrics.totalILUSD))} · Fees: {fUSD(metrics.incomeEarnedUSD)} · {metrics.ilCoveredByFees ? '✓ fees covering IL' : '⚠ IL exceeds fees'}
                  </div>
                )}
              </>
            ) : (
              <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#334155', fontSize: 13 }}>
                No position yet — waiting for genesis
              </div>
            )}
          </Card>

          {/* Opportunity Leaderboard */}
          <Card
            title="Live Opportunity Leaderboard"
            badge={<span style={{ fontSize: 11, color: '#475569' }}>{opps.length} ranked</span>}
            style={{ flex: 1 }}
          >
            {/* Table header */}
            <div style={{
              display: 'flex', gap: 10, padding: '0 10px 8px 10px',
              borderBottom: '1px solid #1e293b', marginBottom: 4,
              fontSize: 10, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>
              <span style={{ width: 20, flexShrink: 0 }}>#</span>
              <span style={{ width: 36, flexShrink: 0 }}>Type</span>
              <span style={{ flex: 1 }}>Protocol / Pool</span>
              <span style={{ width: 68, textAlign: 'right', flexShrink: 0 }}>Net APY</span>
              <span style={{ width: 60, textAlign: 'right', flexShrink: 0 }}>30d Mean</span>
              <span style={{ width: 40, textAlign: 'right', flexShrink: 0 }}>Score</span>
            </div>

            <div style={{ maxHeight: 420, overflowY: 'auto' }}>
              {opps.length === 0 ? (
                <div style={{ color: '#334155', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
                  Scanning...
                </div>
              ) : (
                opps.slice(0, 20).map((opp, i) => (
                  <OppRow key={opp.id} opp={opp} rank={i + 1} isActive={opp.id === activeOppId} />
                ))
              )}
            </div>
          </Card>
        </div>

        {/* ── Right column ───────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>

          {/* Circuit Breakers */}
          <Card
            title="Circuit Breakers"
            badge={
              redCount > 0
                ? <span style={{ color: '#ef4444', fontSize: 12, fontWeight: 700 }}>🔴 {redCount} RED</span>
                : yellowCount > 0
                  ? <span style={{ color: '#eab308', fontSize: 12 }}>🟡 {yellowCount} WARN</span>
                  : <span style={{ color: '#22c55e', fontSize: 12 }}>✓ All clear</span>
            }
          >
            {brks.length === 0 ? (
              <div style={{ color: '#334155', fontSize: 13 }}>No position — breakers inactive</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {brks.map(b => <BreakerPill key={b.id} breaker={b} />)}
              </div>
            )}
          </Card>

          {/* Last Allocation Decision */}
          {allocation && (
            <Card title="Last Decision">
              <div style={{ fontSize: 13 }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
                  <span style={{
                    background: allocation.action === 'HOLD' ? '#1e293b' : allocation.action === 'GENESIS' ? '#22c55e22' : allocation.action === 'MIGRATE' ? '#f9731622' : '#ef444422',
                    color: allocation.action === 'HOLD' ? '#64748b' : allocation.action === 'GENESIS' ? '#22c55e' : allocation.action === 'MIGRATE' ? '#f97316' : '#ef4444',
                    padding: '3px 10px', borderRadius: 6, fontWeight: 700, fontSize: 12,
                  }}>
                    {allocation.action}
                  </span>
                  {allocation.upliftPct !== 0 && (
                    <span style={{ color: allocation.upliftPct > 0 ? '#22c55e' : '#ef4444', fontSize: 12 }}>
                      {fDelta(allocation.upliftPct)} APY
                    </span>
                  )}
                </div>
                <div style={{ color: '#94a3b8', lineHeight: 1.5 }}>{allocation.reason}</div>

                {allocation.targetOpportunity && (
                  <div style={{ marginTop: 10, padding: '8px 10px', background: '#1e293b', borderRadius: 6, fontSize: 12 }}>
                    <span style={{ color: STRAT_COLOR[allocation.targetOpportunity.strategyType], fontWeight: 700 }}>
                      {allocation.targetOpportunity.protocol}
                    </span>
                    <span style={{ color: '#64748b', marginLeft: 6 }}>{allocation.targetOpportunity.pool}</span>
                    <span style={{ float: 'right', color: '#22c55e', fontWeight: 700 }}>
                      {fAPY(allocation.targetOpportunity.netAPY)} net
                    </span>
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* Safety Gate */}
          {safetyCheck && (
            <Card title="Safety Gate" badge={
              <span style={{ color: safetyCheck.passed ? '#22c55e' : '#ef4444', fontSize: 12, fontWeight: 700 }}>
                {safetyCheck.passed ? '✓ PASSED' : '✗ FAILED'}
              </span>
            }>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {safetyCheck.checks.map(c => (
                  <div key={c.name} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '5px 8px', borderRadius: 6, fontSize: 12,
                    background: c.passed ? '#22c55e0d' : '#ef44440d',
                    border: `1px solid ${c.passed ? '#22c55e22' : '#ef444422'}`,
                  }}>
                    <span style={{ color: c.passed ? '#22c55e' : '#ef4444' }}>
                      {c.passed ? '✓' : '✗'} {c.name}
                    </span>
                    <span style={{ color: '#64748b', fontSize: 11 }}>{c.value}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Execution History */}
          <Card title="Executions" badge={
            <span style={{ fontSize: 11, color: '#475569' }}>simulated</span>
          }>
            {execs.length === 0 ? (
              <div style={{ color: '#334155', fontSize: 12 }}>No executions yet</div>
            ) : (
              <div style={{ maxHeight: 150, overflowY: 'auto' }}>
                {execs.slice(0, 10).map(e => <ExecRow key={e.receiptHash} exec={e} />)}
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* ── Activity Feed ─────────────────────────────────────────────────── */}
      <div style={{ marginTop: 16 }}>
        <Card title="Activity Feed" badge={
          <span style={{ fontSize: 11, color: '#334155' }}>
            user + global · {logs.length + glog.length} entries · live
          </span>
        }>
          <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            {logs.length === 0 && glog.length === 0 ? (
              <div style={{ color: '#334155', fontSize: 12 }}>Waiting for first tick...</div>
            ) : (
              // Merge user + global logs, sort by timestamp descending
              [...logs, ...glog]
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, 60)
                .map(entry => <LogLine key={entry.id} entry={entry} />)
            )}
          </div>
        </Card>
      </div>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #0f172a', display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#334155' }}>
        <span>YieldGeko Agent v2.0 · {agent ? `Last tick: ${timeAgo(agent.lastTickAt)}` : '—'}</span>
        <span style={{ color: '#1e293b' }}>SIMULATED — no real funds deployed · {userIds.length} user(s)</span>
        <span>SSE: {connected ? '🟢 connected' : '🔴 disconnected'}</span>
      </div>
    </div>
  );
}
