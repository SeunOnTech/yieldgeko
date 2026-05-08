'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useReadContract } from 'wagmi'
import { formatUnits } from 'viem'
import { VAULT_ADDRESS, USDC_ADDRESS } from '@/config'
import { yieldGekoAbi } from '@/src/generated'
import { AppNav, StatusPill, ChainChip, Sparkline, GekoMark } from '../components/ui'

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

// ─── Strategy card ────────────────────────────────────────────────────────────

function StrategyCard({
  address,
  available,
  working,
  minAPY,
  agentUser,
  onClick,
}: {
  address: string
  available: number
  working: number
  minAPY: number
  agentUser: any
  onClick: () => void
}) {
  const totalValue = available + working
  const metrics    = agentUser?.portfolio?.metrics
  const currentAPY = metrics?.weightedNetAPY as number | undefined
  const earned     = (metrics?.incomeEarnedUSD as number | undefined) ?? 0
  const phase      = (agentUser?.phase as string | undefined) ?? 'ACTIVATING'

  const spark: number[] = (agentUser?.pnlHistory ?? [])
    .slice(-7)
    .map((p: any) => p.valueUSD as number)

  const isRunning  = ['ALLOCATED', 'MONITORING', 'SCANNING', 'MIGRATING'].includes(phase)
  const status     = isRunning ? 'running' : 'paused'
  const accentColor = isRunning ? '#16A34A' : '#D97706'
  const apyPct     = currentAPY ? Math.min(100, ((currentAPY - 8) / (30 - 8)) * 100) : 0

  const displayName: string =
    agentUser?.policy?.displayName?.split('—')[0]?.trim() ?? 'My strategy'

  return (
    <div
      className="strat-card"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick() }}
    >
      <span className="strat-card-accent" style={{ background: accentColor }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#1C1917', letterSpacing: '-0.005em' }}>
            {displayName}
          </div>
          <div style={{ marginTop: 8 }}>
            <ChainChip chain="arbitrum" />
          </div>
        </div>
        <StatusPill state={status} />
      </div>

      <div style={{ marginTop: 22 }}>
        <div style={{ fontSize: 36, fontWeight: 700, color: '#1C1917', letterSpacing: '-0.02em', lineHeight: 1 }}>
          ${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        {earned > 0 && (
          <div style={{ fontSize: 14, marginTop: 6 }}>
            <span style={{ color: '#16A34A', fontWeight: 600 }}>+${earned.toFixed(2)}</span>
            {'  '}<span style={{ color: '#A8A29E' }}>earned</span>
          </div>
        )}
      </div>

      <div style={{ marginTop: 18, fontSize: 13 }}>
        <span style={{ color: '#78716C' }}>Working </span>
        <span style={{ color: '#1C1917', fontWeight: 600 }}>
          ${working.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
        <span style={{ color: '#D6D3D1', margin: '0 10px' }}>·</span>
        <span style={{ color: '#78716C' }}>Available </span>
        <span style={{ color: '#1C1917', fontWeight: 500 }}>
          ${available.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </div>

      {spark.length >= 2 && (
        <div style={{ marginTop: 20 }}>
          <Sparkline data={spark} color="#16A34A" />
        </div>
      )}

      <div style={{ marginTop: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 13 }}>
          {currentAPY != null ? (
            <>
              <span style={{ color: '#78716C' }}>Earning at </span>
              <span style={{ color: '#1C1917', fontWeight: 600, fontSize: 14 }}>{currentAPY.toFixed(1)}% APY</span>
            </>
          ) : (
            <span style={{ color: '#A8A29E' }}>Agent starting up…</span>
          )}
        </div>
        {minAPY > 0 && (
          <div style={{ fontSize: 13, color: '#A8A29E' }}>Floor: {minAPY.toFixed(1)}%</div>
        )}
      </div>

      {currentAPY != null && (
        <div style={{ height: 4, borderRadius: 999, background: '#E7E5E4', marginTop: 10, overflow: 'hidden' }}>
          <div style={{ width: `${apyPct}%`, height: '100%', background: '#16A34A', borderRadius: 999 }} />
        </div>
      )}
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div style={{
      border: '2px dashed #E7E5E4', borderRadius: 20,
      padding: '64px 40px', textAlign: 'center', background: '#FAFAF9',
    }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20, opacity: 0.4 }}>
        <GekoMark size={64} color="#EA580C" />
      </div>
      <div style={{ fontSize: 20, fontWeight: 600, color: '#1C1917', letterSpacing: '-0.01em' }}>
        You don&apos;t have any strategies yet.
      </div>
      <div style={{ fontSize: 16, color: '#78716C', marginTop: 8, lineHeight: 1.6 }}>
        Your agent is waiting for its first assignment.
      </div>
      <button
        onClick={onNew}
        style={{
          marginTop: 28, height: 52, padding: '0 28px', borderRadius: 12,
          background: '#EA580C', border: 'none', color: '#fff',
          fontSize: 16, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        Start your first strategy →
      </button>
    </div>
  )
}

// ─── No wallet state ──────────────────────────────────────────────────────────

function NoWallet() {
  return (
    <div style={{
      border: '2px dashed #E7E5E4', borderRadius: 20,
      padding: '64px 40px', textAlign: 'center', background: '#FAFAF9',
    }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20, opacity: 0.4 }}>
        <GekoMark size={64} color="#EA580C" />
      </div>
      <div style={{ fontSize: 20, fontWeight: 600, color: '#1C1917' }}>
        Connect your wallet
      </div>
      <div style={{ fontSize: 16, color: '#78716C', marginTop: 8, lineHeight: 1.6 }}>
        Connect to view your strategies and portfolio.
      </div>
      <div style={{ marginTop: 28, display: 'flex', justifyContent: 'center' }}>
        {/* eslint-disable-next-line @typescript-eslint/ban-ts-comment */}
        {/* @ts-ignore */}
        <appkit-button size="md" />
      </div>
    </div>
  )
}

// ─── Quick stat ───────────────────────────────────────────────────────────────

function QStat({ label, val, sub }: { label: string; val: string; sub: string }) {
  return (
    <div className="qstat">
      <div className="qstat-lbl">{label}</div>
      <div className="qstat-val">{val}</div>
      <div className="qstat-sub">{sub}</div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter()
  const { address } = useAccount()

  const [agentUser, setAgentUser] = useState<any>(null)

  // On-chain: available (idle) USDC in vault
  const { data: availableRaw } = useReadContract({
    address: VAULT_ADDRESS || undefined,
    abi: yieldGekoAbi,
    functionName: 'balances',
    args: address && VAULT_ADDRESS ? [address, USDC_ADDRESS] : undefined,
    query: { enabled: Boolean(address && VAULT_ADDRESS), refetchInterval: 30_000 },
  })

  // On-chain: deployed (working) USDC in vault
  const { data: workingRaw } = useReadContract({
    address: VAULT_ADDRESS || undefined,
    abi: yieldGekoAbi,
    functionName: 'deployed',
    args: address && VAULT_ADDRESS ? [address, USDC_ADDRESS] : undefined,
    query: { enabled: Boolean(address && VAULT_ADDRESS), refetchInterval: 30_000 },
  })

  // On-chain: policy (active flag + minAPY)
  const { data: policyRaw } = useReadContract({
    address: VAULT_ADDRESS || undefined,
    abi: yieldGekoAbi,
    functionName: 'policies',
    args: address && VAULT_ADDRESS ? [address] : undefined,
    query: { enabled: Boolean(address && VAULT_ADDRESS), refetchInterval: 60_000 },
  })

  const available = availableRaw ? Number(formatUnits(availableRaw as bigint, 6)) : 0
  const working   = workingRaw   ? Number(formatUnits(workingRaw as bigint, 6))   : 0
  const totalValue = available + working

  // policyRaw is a named tuple: { active, managedUSD, minAPY, maxDrawdownBps, ... }
  const policy = policyRaw as { active: boolean; minAPY: bigint } | undefined
  const policyActive = policy?.active ?? false
  const minAPY = policy?.minAPY ? Number(policy.minAPY) / 100 : 0

  // Agent state — poll every 30s
  useEffect(() => {
    if (!address) return
    fetchAgentUser(address).then(setAgentUser)
    const id = setInterval(() => fetchAgentUser(address).then(setAgentUser), 30_000)
    return () => clearInterval(id)
  }, [address])

  const metrics        = agentUser?.portfolio?.metrics
  const earned         = (metrics?.incomeEarnedUSD as number | undefined) ?? 0
  const verifiedCount  = (agentUser?.executions as any[] | undefined)?.length ?? 0
  const currentAPY     = metrics?.weightedNetAPY as number | undefined

  // Strategy exists if policy is active on-chain OR they have any funds in vault
  const hasStrategy = policyActive || totalValue > 0

  return (
    <>
      <AppNav />
      <div className="app-page" style={{ paddingBottom: 96 }}>

        {/* Portfolio header */}
        <div style={{ padding: '48px 0 40px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 16 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 500, color: '#78716C' }}>Good morning</div>
              <div style={{ fontSize: 56, fontWeight: 700, color: '#1C1917', letterSpacing: '-0.025em', lineHeight: 1, marginTop: 4 }}>
                {address ? `$${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '$0.00'}
              </div>
              <div style={{ fontSize: 14, color: '#78716C', marginTop: 8 }}>
                {!address
                  ? 'Connect your wallet to view your portfolio.'
                  : !hasStrategy
                  ? 'Start your first strategy below.'
                  : 'Total across your strategies'}
              </div>
              {earned > 0 && (
                <div style={{ marginTop: 10, fontSize: 16 }}>
                  <span style={{ color: '#16A34A', fontWeight: 600 }}>+${earned.toFixed(2)}</span>
                  <span style={{ color: '#78716C' }}> earned</span>
                  {currentAPY != null && (
                    <>
                      <span style={{ color: '#D6D3D1', margin: '0 6px' }}>·</span>
                      <span style={{ color: '#16A34A', fontWeight: 600 }}>{currentAPY.toFixed(1)}% APY</span>
                    </>
                  )}
                </div>
              )}
            </div>
            {address && (
              <button
                className="btn-sm btn-primary-sm"
                style={{ height: 44, padding: '0 20px' }}
                onClick={() => router.push('/onboard')}
              >
                + New strategy
              </button>
            )}
          </div>
        </div>

        {!address ? (
          <NoWallet />
        ) : !hasStrategy ? (
          <EmptyState onNew={() => router.push('/onboard')} />
        ) : (
          <>
            <div className="dash-grid">
              <StrategyCard
                address={address}
                available={available}
                working={working}
                minAPY={minAPY}
                agentUser={agentUser}
                onClick={() => router.push(`/strategy/${address}`)}
              />
            </div>

            {(earned > 0 || verifiedCount > 0 || currentAPY != null) && (
              <div className="qstat-grid">
                <QStat
                  label="Total earned"
                  val={earned > 0 ? `$${earned.toFixed(2)}` : '—'}
                  sub="since joining"
                />
                <QStat
                  label="Actions"
                  val={verifiedCount > 0 ? String(verifiedCount) : '—'}
                  sub="verified on-chain"
                />
                {currentAPY != null && (
                  <QStat label="Current APY" val={`${currentAPY.toFixed(1)}%`} sub="weighted net" />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
