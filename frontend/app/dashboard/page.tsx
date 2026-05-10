'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useReadContract } from 'wagmi'
import { formatUnits } from 'viem'
import { VAULT_ADDRESS, USDC_ADDRESS } from '@/config'
import { yieldGekoAbi } from '@/src/generated'
import { AppNav, StatusPill, ChainChip, Sparkline, GekoMark } from '../components/ui'

// ── Agent state ───────────────────────────────────────────────────────────────

async function fetchAgentUser(address: string): Promise<any | null> {
  const base = (process.env.NEXT_PUBLIC_AGENT_SSE_URL ?? 'http://localhost:3001/events').replace('/events', '')
  try {
    const res = await fetch(`${base}/state`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const state = await res.json()
    const users = Object.values(state.users ?? {}) as any[]
    return users.find(u => u.policy?.userAddress?.toLowerCase() === address.toLowerCase()) ?? null
  } catch { return null }
}

// ── Animated counter ──────────────────────────────────────────────────────────

function useCountUp(target: number, duration = 900): number {
  const [val, setVal] = useState(target)
  const prev = useRef(target)
  useEffect(() => {
    const from = prev.current
    prev.current = target
    if (from === target) return
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const ease = 1 - Math.pow(1 - t, 3)
      setVal(from + (target - from) * ease)
      if (t < 1) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, [target, duration])
  return val
}

// ── Strategy card ─────────────────────────────────────────────────────────────

function StrategyCard({
  available, working, minAPY, agentUser, onClick,
}: {
  available: number; working: number; minAPY: number; agentUser: any; onClick: () => void
}) {
  const totalValue  = available + working
  const metrics     = agentUser?.portfolio?.metrics
  const currentAPY  = metrics?.weightedNetAPY as number | undefined
  const earned      = (metrics?.incomeEarnedUSD as number | undefined) ?? 0
  const phase       = (agentUser?.phase as string | undefined) ?? 'ACTIVATING'
  const displayName = agentUser?.policy?.displayName?.split('—')[0]?.trim() ?? 'My Strategy'
  const positions: any[] = agentUser?.portfolio?.positions ?? []

  const spark: number[] = (agentUser?.pnlHistory ?? []).slice(-14).map((p: any) => p.totalUSD ?? 0)
  const isRunning = ['ALLOCATED','MONITORING','SCANNING','MIGRATING'].includes(phase)
  const animVal   = useCountUp(totalValue)

  const protocolNames = positions.slice(0, 3).map((p: any) =>
    (p.venueName ?? p.protocol ?? '').split(' ')[0]
  ).filter(Boolean)

  return (
    <div
      className="strat-card"
      onClick={onClick}
      role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick() }}
      style={{ animationDelay: '120ms' }}
    >
      <div className="strat-card-glow" />
      <span className="strat-card-accent" style={{ background: isRunning ? '#22C55E' : '#F59E0B' }} />

      {/* Header row */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:12 }}>
        <div>
          <div style={{ fontSize:17, fontWeight:700, color:'var(--t1)', letterSpacing:'-.01em' }}>
            {displayName}
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:6 }}>
            <ChainChip chain="arbitrum" />
            {protocolNames.length > 0 && (
              <span style={{ fontSize:11, color:'var(--t3)', letterSpacing:'.03em' }}>
                {protocolNames.join(' · ')}
              </span>
            )}
          </div>
        </div>
        <StatusPill state={isRunning ? 'running' : 'paused'} />
      </div>

      {/* Value */}
      <div style={{ marginTop:24 }}>
        <div style={{ fontSize:42, fontWeight:800, color:'var(--t1)', letterSpacing:'-.03em', lineHeight:1, fontVariantNumeric:'tabular-nums' }}>
          ${animVal.toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 })}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginTop:10 }}>
          {earned > 0 && (
            <span style={{ fontSize:14, fontWeight:600, color:'var(--green)' }}>
              +${earned.toFixed(2)} earned
            </span>
          )}
          {currentAPY != null && (
            <span style={{
              fontSize:12, fontWeight:600, color:'var(--orange)',
              background:'var(--orange-dim)', border:'1px solid rgba(234,88,12,.2)',
              borderRadius:999, padding:'2px 10px',
            }}>
              {currentAPY.toFixed(1)}% APY
            </span>
          )}
        </div>
      </div>

      {/* Sparkline */}
      {spark.length >= 2 && (
        <div style={{ marginTop:20, height:52 }}>
          <Sparkline data={spark} color={isRunning ? '#22C55E' : '#F59E0B'} height={52} />
        </div>
      )}

      {/* Footer */}
      <div style={{ height:1, background:'var(--border)', margin:'18px 0 14px' }} />
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:13 }}>
        <div>
          <span style={{ color:'var(--t3)' }}>Working </span>
          <span style={{ color:'var(--t1)', fontWeight:600 }}>
            ${working.toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 })}
          </span>
          <span style={{ color:'var(--border)', margin:'0 10px' }}>·</span>
          <span style={{ color:'var(--t3)' }}>Idle </span>
          <span style={{ color:'var(--t1)', fontWeight:500 }}>
            ${available.toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 })}
          </span>
        </div>
        <span style={{ fontSize:12, color:'var(--orange)', fontWeight:600, letterSpacing:'.01em' }}>
          View details →
        </span>
      </div>
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="db-empty">
      <div className="db-empty-icon"><GekoMark size={56} color="#EA580C" /></div>
      <div className="db-empty-title">No strategies yet.</div>
      <div className="db-empty-sub">Your agent is ready and waiting for its first assignment.</div>
      <button
        onClick={onNew}
        style={{
          marginTop:28, height:52, padding:'0 32px', borderRadius:14,
          background:'#EA580C', border:'none', color:'#fff',
          fontSize:15, fontWeight:700, cursor:'pointer', fontFamily:'inherit',
          boxShadow:'0 0 24px rgba(234,88,12,.35)',
          transition:'all 180ms',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-2px)' }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)' }}
      >
        Start your first strategy →
      </button>
    </div>
  )
}

// ── No wallet ─────────────────────────────────────────────────────────────────

function NoWallet() {
  return (
    <div className="db-empty">
      <div className="db-empty-icon"><GekoMark size={56} color="#EA580C" /></div>
      <div className="db-empty-title">Connect your wallet</div>
      <div className="db-empty-sub">Connect to view your strategies and live portfolio performance.</div>
      <div style={{ marginTop:28, display:'flex', justifyContent:'center' }}>
        {/* @ts-ignore */}
        <appkit-button size="md" />
      </div>
    </div>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function Stat({ label, val, sub, tone, delay = 0 }: {
  label: string; val: string; sub: string; tone?: 'green' | 'orange'; delay?: number
}) {
  return (
    <div className="db-stat" style={{ animation: `fadeUp 600ms ${delay}ms cubic-bezier(0.16,1,0.3,1) both` }}>
      <div className="db-stat-label">{label}</div>
      <div className="db-stat-val" data-tone={tone}>{val}</div>
      <div className="db-stat-sub">{sub}</div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router      = useRouter()
  const { address } = useAccount()
  const [agentUser, setAgentUser] = useState<any>(null)

  const { data: availableRaw } = useReadContract({
    address: VAULT_ADDRESS || undefined, abi: yieldGekoAbi, functionName: 'balances',
    args: address && VAULT_ADDRESS ? [address, USDC_ADDRESS] : undefined,
    query: { enabled: Boolean(address && VAULT_ADDRESS), refetchInterval: 30_000 },
  })
  const { data: workingRaw } = useReadContract({
    address: VAULT_ADDRESS || undefined, abi: yieldGekoAbi, functionName: 'deployed',
    args: address && VAULT_ADDRESS ? [address, USDC_ADDRESS] : undefined,
    query: { enabled: Boolean(address && VAULT_ADDRESS), refetchInterval: 30_000 },
  })
  const { data: policyRaw } = useReadContract({
    address: VAULT_ADDRESS || undefined, abi: yieldGekoAbi, functionName: 'policies',
    args: address && VAULT_ADDRESS ? [address] : undefined,
    query: { enabled: Boolean(address && VAULT_ADDRESS), refetchInterval: 60_000 },
  })

  const available  = availableRaw ? Number(formatUnits(availableRaw as bigint, 6)) : 0
  const working    = workingRaw   ? Number(formatUnits(workingRaw as bigint, 6))   : 0
  const totalValue = available + working

  const policy      = policyRaw as { active: boolean; minAPY: bigint } | undefined
  const policyActive = policy?.active ?? false
  const minAPY      = policy?.minAPY ? Number(policy.minAPY) / 100 : 0

  useEffect(() => {
    if (!address) return
    fetchAgentUser(address).then(setAgentUser)
    const id = setInterval(() => fetchAgentUser(address).then(setAgentUser), 30_000)
    return () => clearInterval(id)
  }, [address])

  const metrics      = agentUser?.portfolio?.metrics
  const earned       = (metrics?.incomeEarnedUSD as number | undefined) ?? 0
  const currentAPY   = metrics?.weightedNetAPY as number | undefined
  const executions   = (agentUser?.executions as any[] | undefined) ?? []
  const hasStrategy  = policyActive || totalValue > 0

  const animTotal    = useCountUp(address ? totalValue : 0)

  // greeting based on time
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  return (
    <>
      <AppNav />
      <div className="db-page">
        <div className="app-page">

          {/* Hero */}
          <div className="db-hero">
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:16 }}>
              <div>
                <div className="db-hero-label">{greeting}</div>
                <div className="db-hero-value">
                  {address
                    ? `$${animTotal.toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 })}`
                    : '$0.00'}
                </div>

                {/* Earned + APY */}
                {address && hasStrategy && (
                  <div style={{ display:'flex', alignItems:'center', gap:12, marginTop:16, flexWrap:'wrap' }}>
                    {earned > 0 && (
                      <span style={{ fontSize:15, fontWeight:600, color:'var(--green)' }}>
                        +${earned.toFixed(4)} earned
                      </span>
                    )}
                    {currentAPY != null && (
                      <span style={{
                        fontSize:13, fontWeight:600, color:'var(--orange)',
                        background:'var(--orange-dim)', border:'1px solid rgba(234,88,12,.22)',
                        borderRadius:999, padding:'4px 12px',
                      }}>
                        {currentAPY.toFixed(1)}% APY live
                      </span>
                    )}
                    {!hasStrategy && (
                      <span className="db-hero-sub">Start your first strategy below.</span>
                    )}
                  </div>
                )}
                {!address && (
                  <div className="db-hero-sub" style={{ marginTop:12 }}>
                    Connect your wallet to view your portfolio.
                  </div>
                )}
              </div>

              {address && (
                <button className="btn-new" onClick={() => router.push('/onboard')}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                    <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                  New strategy
                </button>
              )}
            </div>
          </div>

          {/* Stats row */}
          {address && hasStrategy && (
            <div className="db-stats">
              <Stat
                label="Total earned"
                val={earned > 0 ? `$${earned.toFixed(4)}` : '—'}
                sub="since activation"
                tone={earned > 0 ? 'green' : undefined}
                delay={0}
              />
              <Stat
                label="On-chain actions"
                val={executions.length > 0 ? String(executions.length) : '—'}
                sub="verified proofs"
                delay={60}
              />
              <Stat
                label="Current APY"
                val={currentAPY != null ? `${currentAPY.toFixed(1)}%` : '—'}
                sub="weighted net"
                tone={currentAPY != null ? 'orange' : undefined}
                delay={120}
              />
            </div>
          )}

          {/* Content */}
          {!address ? (
            <NoWallet />
          ) : !hasStrategy ? (
            <EmptyState onNew={() => router.push('/onboard')} />
          ) : (
            <div className="dash-grid">
              <StrategyCard
                available={available}
                working={working}
                minAPY={minAPY}
                agentUser={agentUser}
                onClick={() => router.push(`/strategy/${address}`)}
              />

              {/* Quick info card */}
              <div
                className="db-card db-card-p"
                style={{
                  display:'flex', flexDirection:'column', gap:20,
                  animation:'fadeUp 600ms 200ms cubic-bezier(0.16,1,0.3,1) both',
                }}
              >
                <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>Your guardrails</div>

                <div>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, marginBottom:8 }}>
                    <span style={{ color:'var(--t2)' }}>APY floor</span>
                    <span style={{ color:'var(--t1)', fontWeight:600 }}>{minAPY.toFixed(1)}%</span>
                  </div>
                  <div className="apy-track">
                    <div className="apy-fill" style={{ width:`${Math.min(100, (minAPY / 30) * 100)}%` }} />
                  </div>
                </div>

                <div style={{ height:1, background:'var(--border)' }} />

                <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                  {[
                    { label:'Capital working', val:`$${working.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`, color:'var(--green)' },
                    { label:'Capital idle',    val:`$${available.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`, color:'var(--t1)' },
                  ].map(({ label, val, color }) => (
                    <div key={label} style={{ display:'flex', justifyContent:'space-between', fontSize:13 }}>
                      <span style={{ color:'var(--t2)' }}>{label}</span>
                      <span style={{ color, fontWeight:600, fontVariantNumeric:'tabular-nums' }}>{val}</span>
                    </div>
                  ))}
                </div>

                <div style={{ height:1, background:'var(--border)' }} />

                <button
                  className="btn-primary-sm btn-sm"
                  style={{ width:'100%', borderRadius:12, height:44, fontSize:14 }}
                  onClick={() => router.push(`/strategy/${address}`)}
                >
                  View full strategy →
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
