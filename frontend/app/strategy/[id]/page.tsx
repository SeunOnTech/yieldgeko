'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useReadContract } from 'wagmi'
import { formatUnits } from 'viem'
import { VAULT_ADDRESS, USDC_ADDRESS } from '@/config'
import { yieldGekoAbi } from '@/src/generated'
import { AppNav, StatusPill, ChainChip, ProtocolMark } from '../../components/ui'

// ─── Agent state fetch ────────────────────────────────────────────────────────

async function fetchAgentUser(address: string): Promise<any | null> {
  const base = (process.env.NEXT_PUBLIC_AGENT_SSE_URL ?? 'http://localhost:3001/events').replace('/events', '')
  try {
    const res = await fetch(`${base}/state`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const state = await res.json()
    const users = Object.values(state.users ?? {}) as any[]
    return users.find(u =>
      u.policy?.userAddress?.toLowerCase() === address.toLowerCase()
    ) ?? null
  } catch {
    return null
  }
}

// ─── Performance chart ────────────────────────────────────────────────────────

function PerfChart({ data, floorUSD, height = 180 }: { data: number[]; floorUSD?: number; height?: number }) {
  const w = 600, h = height, pad = 8
  const min = Math.min(...data) - 10
  const max = Math.max(...data) + 10
  const range = max - min || 1
  const pts = data.map((v, i) => [
    pad + (i / (data.length - 1)) * (w - pad * 2),
    h - pad - ((v - min) / range) * (h - pad * 2),
  ])
  const d    = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const fillD = `${d} L ${w - pad} ${h - pad} L ${pad} ${h - pad} Z`

  const refUSD = floorUSD ?? (data[0] ?? 0)
  const refY   = h - pad - ((refUSD - min) / range) * (h - pad * 2)

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }}>
      <defs>
        <linearGradient id="perf-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#EA580C" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#EA580C" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((p) => (
        <line key={p} x1={pad} x2={w - pad} y1={pad + p * (h - pad * 2)} y2={pad + p * (h - pad * 2)}
          stroke="#F5F5F4" strokeWidth="1" />
      ))}
      <line x1={pad} x2={w - pad} y1={refY} y2={refY} stroke="#D6D3D1" strokeDasharray="4 4" strokeWidth="1" />
      <path d={fillD} fill="url(#perf-fill)" />
      <path d={d} fill="none" stroke="#EA580C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// ─── Activity feed ────────────────────────────────────────────────────────────

type ExecRecord = {
  action:      string
  from:        string | null
  to:          string
  amountUSD:   number
  simulated:   boolean
  receiptHash: string
  txHash?:     string
  timestamp:   number
}

const ACTION_KIND: Record<string, 'migrate' | 'harvest' | 'hold' | 'safety'> = {
  MIGRATE:     'migrate',
  HARVEST:     'harvest',
  HOLD:        'hold',
  SAFETY_EXIT: 'safety',
  GENESIS:     'migrate',
  REBALANCE:   'migrate',
}

const KIND_LABEL: Record<string, string> = {
  migrate: 'MIGRATE',
  harvest: 'HARVEST',
  hold:    'HOLD',
  safety:  'SAFETY EXIT',
}

function relativeTime(ts: number): string {
  const diff = (Date.now() - ts) / 1000
  if (diff < 60)   return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`
  return `${Math.floor(diff / 86400)} days ago`
}

function ActivityFeed({
  executions,
  onVerify,
}: {
  executions: ExecRecord[]
  onVerify: (hash: string) => void
}) {
  if (executions.length === 0) {
    return (
      <div style={{ background: '#FFFFFF', border: '1px solid #E7E5E4', borderRadius: 20, padding: 28 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#1C1917', marginBottom: 16 }}>Agent activity</div>
        <div style={{ fontSize: 14, color: '#A8A29E', padding: '24px 0', textAlign: 'center' }}>
          No actions yet — your agent is scanning for opportunities.
        </div>
      </div>
    )
  }

  return (
    <div style={{ background: '#FFFFFF', border: '1px solid #E7E5E4', borderRadius: 20, padding: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#1C1917' }}>Agent activity</div>
        <span style={{ fontSize: 12, color: '#A8A29E' }}>{executions.length} actions</span>
      </div>

      <div style={{ marginTop: 8 }}>
        {executions.slice(0, 10).map((e, i) => {
          const kind = ACTION_KIND[e.action] ?? 'hold'
          return (
            <div key={i} className="act-entry" data-kind={kind}>
              <div className="act-entry-ts">
                <span className="act-entry-dot" />
                <span>{relativeTime(e.timestamp)}</span>
              </div>
              <div className="act-entry-kind">{KIND_LABEL[kind] ?? e.action}</div>
              <div className="act-entry-title">
                {e.from ? `${e.from} → ${e.to}` : e.to}
              </div>

              {e.amountUSD > 0 && (
                <div className="act-entry-row">
                  Amount: <span style={{ color: '#1C1917', fontWeight: 500 }}>
                    ${e.amountUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              )}

              {kind !== 'hold' && (
                <div className="act-entry-foot">
                  <button
                    className="act-entry-verify"
                    onClick={() => onVerify(e.receiptHash)}
                  >
                    Verify this action →
                  </button>
                  <span className="act-entry-anchor">
                    {e.txHash
                      ? <span style={{ color: '#16A34A' }}>✓ On-chain</span>
                      : e.simulated
                      ? <span style={{ color: '#A8A29E' }}>Simulated</span>
                      : <span style={{ color: '#A8A29E' }}>⟳ Anchoring…</span>
                    }
                  </span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── APY bar ──────────────────────────────────────────────────────────────────

function ApyBar({ apy, floor, max = 30 }: { apy: number; floor: number; max?: number }) {
  const fillPct  = Math.min(100, (apy / max) * 100)
  const floorPct = (floor / max) * 100
  return (
    <div style={{ marginTop: 8, position: 'relative', height: 24 }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 6, borderRadius: 999, background: '#E7E5E4', overflow: 'hidden' }}>
        <div style={{ width: `${fillPct}%`, height: '100%', background: 'linear-gradient(90deg, #16A34A, #4ADE80)', borderRadius: 999 }} />
      </div>
      <div style={{ position: 'absolute', top: -2, left: `${floorPct}%`, width: 1, height: 10, background: '#A8A29E' }} />
      <div style={{ position: 'absolute', top: 12, left: `calc(${floorPct}% - 8px)`, fontSize: 11, color: '#A8A29E' }}>
        {floor.toFixed(1)}%
      </div>
    </div>
  )
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function Skeleton({ width = '100%', height = 16, radius = 6 }: { width?: string | number; height?: number; radius?: number }) {
  return (
    <div style={{
      width, height, borderRadius: radius,
      background: 'linear-gradient(90deg, #F5F5F4 25%, #E7E5E4 50%, #F5F5F4 75%)',
      backgroundSize: '200% 100%',
      animation: 'shimmer 1.4s ease infinite',
    }} />
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function StrategyPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const userAddress = params.id   // wallet address passed from dashboard link

  const [agentUser, setAgentUser]   = useState<any>(null)
  const [agentReady, setAgentReady] = useState(false)
  const [range, setRange]           = useState('1M')

  // On-chain reads
  const { data: availableRaw } = useReadContract({
    address: VAULT_ADDRESS || undefined,
    abi: yieldGekoAbi,
    functionName: 'balances',
    args: userAddress && VAULT_ADDRESS ? [userAddress as `0x${string}`, USDC_ADDRESS] : undefined,
    query: { enabled: Boolean(userAddress && VAULT_ADDRESS), refetchInterval: 30_000 },
  })

  const { data: workingRaw } = useReadContract({
    address: VAULT_ADDRESS || undefined,
    abi: yieldGekoAbi,
    functionName: 'deployed',
    args: userAddress && VAULT_ADDRESS ? [userAddress as `0x${string}`, USDC_ADDRESS] : undefined,
    query: { enabled: Boolean(userAddress && VAULT_ADDRESS), refetchInterval: 30_000 },
  })

  const { data: policyRaw } = useReadContract({
    address: VAULT_ADDRESS || undefined,
    abi: yieldGekoAbi,
    functionName: 'policies',
    args: userAddress && VAULT_ADDRESS ? [userAddress as `0x${string}`] : undefined,
    query: { enabled: Boolean(userAddress && VAULT_ADDRESS), refetchInterval: 60_000 },
  })

  const available  = availableRaw ? Number(formatUnits(availableRaw as bigint, 6)) : 0
  const working    = workingRaw   ? Number(formatUnits(workingRaw as bigint, 6))   : 0
  const totalValue = available + working

  const policy    = policyRaw as { active: boolean; minAPY: bigint; maxDrawdownBps: bigint } | undefined
  const minAPY    = policy?.minAPY    ? Number(policy.minAPY) / 100 : 0
  const maxDD     = policy?.maxDrawdownBps ? Number(policy.maxDrawdownBps) / 100 : 0
  const paused    = policy ? !policy.active : false

  // Agent state
  useEffect(() => {
    if (!userAddress) return
    fetchAgentUser(userAddress).then(u => { setAgentUser(u); setAgentReady(true) })
    const id = setInterval(() => fetchAgentUser(userAddress).then(setAgentUser), 30_000)
    return () => clearInterval(id)
  }, [userAddress])

  const metrics    = agentUser?.portfolio?.metrics
  const currentAPY = (metrics?.weightedNetAPY  as number | undefined) ?? 0
  const earned     = (metrics?.incomeEarnedUSD as number | undefined) ?? 0
  const positions: any[] = agentUser?.portfolio?.positions ?? []
  const executions: ExecRecord[] = agentUser?.executions ?? []

  // PnL history for the chart
  const pnlHistory: { timestamp: number; valueUSD: number }[] = agentUser?.pnlHistory ?? []

  const chartData = useMemo(() => {
    const lengths: Record<string, number> = { '1W': 7, '1M': 30, '3M': 90 }
    const n = lengths[range] ?? 30

    if (pnlHistory.length >= 2) {
      // Use real history, sampled to n points
      const step = Math.max(1, Math.floor(pnlHistory.length / n))
      return pnlHistory.filter((_, i) => i % step === 0).slice(-n).map(p => p.valueUSD)
    }

    // Fallback: flat line at current total value (no history yet)
    return Array.from({ length: Math.min(n, 7) }, () => totalValue || 0)
  }, [range, pnlHistory, totalValue])

  const phase = (agentUser?.phase as string | undefined) ?? 'INITIALIZING'
  const displayName: string = agentUser?.policy?.displayName?.split('—')[0]?.trim() ?? 'My strategy'
  const updatedAgo = agentUser?.updatedAt
    ? relativeTime(agentUser.updatedAt)
    : null

  return (
    <>
      <AppNav />
      <div className="app-page" style={{ paddingBottom: 96 }}>

        {paused && (
          <div className="paused-banner">
            <div className="paused-banner-left">
              <span style={{ fontSize: 16 }}>⚠</span>
              <div>Agent paused — drawdown limit reached.<br />Your capital is secured. Resume when ready.</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-sm" style={{ background: '#D97706', color: '#fff', border: 'none' }}>
                Resume agent
              </button>
              <button className="btn-sm" style={{ background: 'transparent', color: '#D97706', border: '1px solid #D97706' }}>
                Withdraw all
              </button>
            </div>
          </div>
        )}

        {/* Back */}
        <div style={{ padding: '32px 0 8px' }}>
          <button
            className="act-entry-verify"
            onClick={() => router.push('/dashboard')}
            style={{ fontSize: 14, color: '#A8A29E' }}
          >
            ← Back to dashboard
          </button>
        </div>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
          <h1 style={{ fontSize: 40, fontWeight: 600, color: '#1C1917', letterSpacing: '-0.02em', margin: 0, lineHeight: 1.1 }}>
            {displayName}
          </h1>
          <StatusPill state={paused ? 'paused' : 'running'} />
          <ChainChip chain="arbitrum" />
        </div>

        {/* Value */}
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 56, fontWeight: 700, color: '#1C1917', letterSpacing: '-0.025em', lineHeight: 1 }}>
            ${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          {earned > 0 && (
            <div style={{ fontSize: 16, marginTop: 8 }}>
              <span style={{ color: '#16A34A', fontWeight: 600 }}>+${earned.toFixed(2)}</span>
              <span style={{ color: '#78716C' }}> earned</span>
            </div>
          )}
        </div>

        {/* APY bar */}
        {currentAPY > 0 && minAPY > 0 && (
          <div style={{ marginTop: 32, maxWidth: 720 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>
                <span style={{ color: '#78716C' }}>Earning at </span>
                <span style={{ color: '#1C1917', fontWeight: 600, fontSize: 14 }}>{currentAPY.toFixed(1)}% APY</span>
              </span>
              <span style={{ color: '#A8A29E' }}>Your floor: {minAPY.toFixed(1)}%</span>
            </div>
            <ApyBar apy={currentAPY} floor={minAPY} />
          </div>
        )}

        {/* Agent activating state */}
        {agentReady && currentAPY === 0 && (
          <div style={{ marginTop: 24, fontSize: 14, color: '#78716C', background: '#FFF7ED', borderRadius: 10, padding: '12px 16px', display: 'inline-block' }}>
            Agent is {phase.toLowerCase().replace('_', ' ')} — first action within the next 60 seconds.
          </div>
        )}

        {/* Action buttons */}
        <div style={{ marginTop: 24, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn-sm btn-ghost-sm">Withdraw</button>
          <button className="btn-sm btn-warn-sm">{paused ? 'Resume agent' : 'Pause agent'}</button>
          <button className="btn-sm btn-primary-sm" onClick={() => router.push('/onboard')}>
            Add funds
          </button>
        </div>

        {/* Two-column grid */}
        <div className="strat-grid">
          <div>
            {/* Allocation */}
            <div style={{ background: '#FAFAF9', border: '1px solid #E7E5E4', borderRadius: 20, padding: 28, marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: '#1C1917' }}>Where your money is</div>
                {updatedAgo && (
                  <div style={{ fontSize: 12, color: '#A8A29E' }}>Updated {updatedAgo}</div>
                )}
              </div>

              {positions.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
                  {positions.map((pos: any, i: number) => {
                    const protocol = (pos.protocol as string ?? '').toLowerCase()
                    const protoId = protocol.includes('aave') ? 'aave'
                      : protocol.includes('morpho') ? 'morpho'
                      : protocol.includes('pendle') ? 'pendle'
                      : protocol.includes('gmx')    ? 'gmx'
                      : protocol.includes('uni')     ? 'uniswap'
                      : 'aave'
                    return (
                      <div key={i} className="alloc-card">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                          <ProtocolMark id={protoId} size={36} />
                          <div>
                            <div style={{ fontSize: 15, fontWeight: 600, color: '#1C1917' }}>{pos.venueName ?? pos.protocol}</div>
                            <div style={{ fontSize: 13, color: '#A8A29E' }}>{pos.strategyType?.replace('_', ' ')} · Arbitrum</div>
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: 20, fontWeight: 700, color: '#1C1917', letterSpacing: '-0.01em' }}>
                            ${(pos.currentUSD as number ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                          <div style={{ fontSize: 13, color: '#A8A29E' }}>
                            {(pos.allocationPct as number ?? 0).toFixed(0)}%{' '}
                            <span style={{ color: '#16A34A', fontWeight: 600 }}>{(pos.currentNetAPY as number ?? 0).toFixed(1)}% APY</span>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 14, color: '#A8A29E', marginTop: 16, padding: '16px 0', textAlign: 'center' }}>
                  {agentReady ? 'Agent is deploying your capital…' : <Skeleton height={14} />}
                </div>
              )}

              <div style={{ height: 1, background: '#E7E5E4', margin: '20px 0 14px' }} />
              <div style={{ fontSize: 13, color: '#A8A29E' }}>
                Available (not working):{' '}
                <span style={{ color: '#1C1917', fontWeight: 500 }}>
                  ${available.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>

            {/* Performance */}
            <div style={{ background: '#FAFAF9', border: '1px solid #E7E5E4', borderRadius: 20, padding: 28 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: '#1C1917' }}>Performance</div>
                <div className="range-tabs">
                  {['1W', '1M', '3M'].map((r) => (
                    <button key={r} data-active={range === r} onClick={() => setRange(r)}>{r}</button>
                  ))}
                </div>
              </div>
              <div style={{ marginTop: 20 }}>
                {chartData.length >= 2 ? (
                  <>
                    <PerfChart data={chartData} floorUSD={totalValue * (1 - maxDD / 100)} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 12, color: '#A8A29E' }}>
                      <span>${Math.round(chartData[0]).toLocaleString()}</span>
                      <span>${Math.round(chartData[chartData.length - 1]).toLocaleString()}</span>
                    </div>
                  </>
                ) : (
                  <div style={{ textAlign: 'center', padding: '32px 0', fontSize: 14, color: '#A8A29E' }}>
                    Performance history will appear after the first agent tick.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Activity feed */}
          <ActivityFeed
            executions={executions}
            onVerify={(hash) => router.push(`/proof/${hash}`)}
          />
        </div>
      </div>
    </>
  )
}
