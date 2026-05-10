'use client'

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useReadContract, useWriteContract } from 'wagmi'
import { formatUnits, parseUnits } from 'viem'
import { VAULT_ADDRESS, USDC_ADDRESS } from '@/config'
import { yieldGekoAbi } from '@/src/generated'
import { AppNav, StatusPill, ChainChip, ProtocolMark } from '../../../components/ui'

// ── Agent state ───────────────────────────────────────────────────────────────

const AGENT_BASE = (process.env.NEXT_PUBLIC_AGENT_SSE_URL ?? 'http://localhost:3001/events').replace('/events', '')
const AGENT_KEY  = process.env.NEXT_PUBLIC_AGENT_API_KEY ?? ''
const authHdr: Record<string, string> = AGENT_KEY ? { Authorization: `Bearer ${AGENT_KEY}` } : {}

async function fetchAgentUser(address: string): Promise<any | null> {
  try {
    const res = await fetch(`${AGENT_BASE}/state`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const state = await res.json()
    const users = Object.values(state.users ?? {}) as any[]
    return users.find(u => u.policy?.userAddress?.toLowerCase() === address.toLowerCase()) ?? null
  } catch { return null }
}

async function agentPost(path: string, body: object): Promise<any> {
  const res = await fetch(`${AGENT_BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...authHdr },
    body:    JSON.stringify(body),
  })
  return res.json()
}

// ── Orbital loading spinner ───────────────────────────────────────────────────

function OrbitalSpinner({ label }: { label: string }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:16, padding:'32px 0' }}>
      <div style={{ position:'relative', width:56, height:56 }}>
        {/* outer ring */}
        <div style={{
          position:'absolute', inset:0, borderRadius:'50%',
          border:'2px solid rgba(255,255,255,0.08)',
        }} />
        {/* spinning arc */}
        <div style={{
          position:'absolute', inset:0, borderRadius:'50%',
          border:'2px solid transparent',
          borderTopColor:'var(--orange)',
          animation:'spin 1.1s linear infinite',
        }} />
        {/* inner pulse */}
        <div style={{
          position:'absolute', inset:10, borderRadius:'50%',
          background:'var(--orange)',
          opacity:0.15,
          animation:'pulse 1.1s ease-in-out infinite',
        }} />
        {/* center dot */}
        <div style={{
          position:'absolute', inset:'50%', transform:'translate(-50%,-50%)',
          width:6, height:6, borderRadius:'50%',
          background:'var(--orange)',
        }} />
      </div>
      <span style={{ fontSize:13, color:'var(--text-2)', letterSpacing:'0.04em' }}>{label}</span>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:.08; } 50% { opacity:.28; } }
      `}</style>
    </div>
  )
}

// ── Withdraw modal ────────────────────────────────────────────────────────────

// ── Shared confirm modal ──────────────────────────────────────────────────────

function ConfirmModal({
  title, body, confirmLabel, confirmStyle = 'danger',
  onConfirm, onCancel,
}: {
  title: string; body: React.ReactNode; confirmLabel: string
  confirmStyle?: 'danger' | 'warn'; onConfirm: () => void; onCancel: () => void
}) {
  return (
    <div style={{
      position:'fixed', inset:0, zIndex:999,
      background:'rgba(0,0,0,0.72)', backdropFilter:'blur(6px)',
      display:'flex', alignItems:'center', justifyContent:'center',
    }} onClick={onCancel}>
      <div style={{
        background:'var(--surface-1)', border:'1px solid var(--border)',
        borderRadius:16, padding:28, width:380, maxWidth:'calc(100vw - 48px)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight:600, fontSize:16, marginBottom:12 }}>{title}</div>
        <div style={{ fontSize:13, color:'var(--text-2)', lineHeight:1.6, marginBottom:24 }}>{body}</div>
        <div style={{ display:'flex', gap:10 }}>
          <button className="btn-ghost" style={{ flex:1 }} onClick={onCancel}>Cancel</button>
          <button
            style={{
              flex:1, padding:'10px 0', borderRadius:10, border:'none', cursor:'pointer',
              fontWeight:600, fontSize:14,
              background: confirmStyle === 'danger' ? 'var(--red, #ef4444)' : 'var(--amber, #f59e0b)',
              color: '#fff',
            }}
            onClick={onConfirm}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

// ── Withdraw modal ────────────────────────────────────────────────────────────

type WithdrawPhase = 'confirm' | 'agent-closing' | 'ready-to-sign' | 'signing-tx' | 'done' | 'error'

function WithdrawModal({
  userAddress, onClose, onDone,
}: { userAddress: string; onClose: () => void; onDone: () => void }) {
  const [phase,   setPhase]   = useState<WithdrawPhase>('confirm')
  const [idleRaw, setIdleRaw] = useState<bigint>(BigInt(0))
  const [errMsg,  setErrMsg]  = useState('')
  const { writeContract } = useWriteContract()

  const idleUSDC = Number(idleRaw) / 1e6

  function startWithdraw() {
    setPhase('agent-closing')
  }

  useEffect(() => {
    if (phase !== 'agent-closing') return
    let cancelled = false
    agentPost('/api/withdraw', { userAddress })
      .then((res: any) => {
        if (cancelled) return
        if (res.ok || res.status === 'IDLE_ONLY') {
          setIdleRaw(BigInt(res.idleUSDCRaw ?? '0'))
          setPhase('ready-to-sign')
        } else {
          setErrMsg(res.error ?? 'Agent could not unwind the position.')
          setPhase('error')
        }
      })
      .catch((e: any) => {
        if (!cancelled) { setErrMsg(e.message); setPhase('error') }
      })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  function signWithdraw() {
    if (!VAULT_ADDRESS || idleRaw === BigInt(0)) return
    setPhase('signing-tx')
    writeContract({
      address: VAULT_ADDRESS,
      abi:     yieldGekoAbi,
      functionName: 'withdraw',
      args:    [USDC_ADDRESS, idleRaw],
    }, {
      onSuccess: () => { setPhase('done') },
      onError:   (e: any) => { setErrMsg(e.shortMessage ?? e.message); setPhase('error') },
    })
  }

  if (phase === 'confirm') {
    return (
      <ConfirmModal
        title="Withdraw all funds?"
        body={
          <>
            This will close your active position and convert everything to USDC.
            You&apos;ll then sign a wallet transaction to receive the funds.
            <br /><br />
            <strong>This stops the agent from earning yield on your behalf.</strong>
          </>
        }
        confirmLabel="Yes, withdraw"
        confirmStyle="danger"
        onConfirm={startWithdraw}
        onCancel={onClose}
      />
    )
  }

  return (
    <div style={{
      position:'fixed', inset:0, zIndex:999,
      background:'rgba(0,0,0,0.7)', backdropFilter:'blur(6px)',
      display:'flex', alignItems:'center', justifyContent:'center',
    }}
      onClick={phase === 'agent-closing' ? undefined : onClose}
    >
      <div style={{
        background:'var(--surface-1)', border:'1px solid var(--border)',
        borderRadius:16, padding:32, width:400, maxWidth:'calc(100vw - 48px)',
      }}
        onClick={e => e.stopPropagation()}
      >
        {/* header */}
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
          <span style={{ fontWeight:600, fontSize:16 }}>Withdraw funds</span>
          {phase !== 'agent-closing' && (
            <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-2)', cursor:'pointer', fontSize:18 }}>✕</button>
          )}
        </div>

        {phase === 'agent-closing' && (
          <>
            <OrbitalSpinner label="Agent closing position on-chain…" />
            <p style={{ textAlign:'center', fontSize:12, color:'var(--text-2)', marginTop:8 }}>
              Unwinding UniV3 LP and converting to USDC. This takes 30–90 seconds.
            </p>
          </>
        )}

        {phase === 'ready-to-sign' && (
          <>
            <div style={{ textAlign:'center', marginBottom:24 }}>
              <div style={{ fontSize:32, fontWeight:700, color:'var(--green)' }}>
                {idleUSDC.toFixed(6)} USDC
              </div>
              <div style={{ fontSize:13, color:'var(--text-2)', marginTop:4 }}>
                ready in vault — sign to receive in your wallet
              </div>
            </div>
            {/* step indicator */}
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:24 }}>
              <div style={{ width:20, height:20, borderRadius:'50%', background:'var(--green)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700 }}>✓</div>
              <div style={{ fontSize:12, color:'var(--text-2)', flex:1 }}>Position closed by agent</div>
              <div style={{ width:20, height:20, borderRadius:'50%', border:'2px solid var(--orange)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700, color:'var(--orange)' }}>2</div>
              <div style={{ fontSize:12, color:'var(--text-1)', flex:1 }}>Sign wallet transfer</div>
            </div>
            <button className="btn-primary" style={{ width:'100%' }} onClick={signWithdraw}>
              Sign &amp; receive {idleUSDC.toFixed(4)} USDC
            </button>
          </>
        )}

        {phase === 'signing-tx' && (
          <OrbitalSpinner label="Waiting for wallet signature…" />
        )}

        {phase === 'done' && (
          <div style={{ textAlign:'center' }}>
            <div style={{ fontSize:40, marginBottom:12 }}>🎉</div>
            <div style={{ fontWeight:600, marginBottom:6 }}>Withdrawal complete</div>
            <div style={{ fontSize:13, color:'var(--text-2)', marginBottom:24 }}>
              {idleUSDC.toFixed(6)} USDC is now in your wallet.
            </div>
            <button className="btn-primary" style={{ width:'100%' }} onClick={() => { onDone(); onClose() }}>
              Done
            </button>
          </div>
        )}

        {phase === 'error' && (
          <div style={{ textAlign:'center' }}>
            <div style={{ fontSize:13, color:'var(--red)', background:'rgba(239,68,68,0.08)', borderRadius:8, padding:'12px 16px', marginBottom:20 }}>
              {errMsg || 'Something went wrong.'}
            </div>
            <button className="btn-ghost" style={{ width:'100%' }} onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Animated counter ──────────────────────────────────────────────────────────

function useCountUp(target: number, duration = 900): number {
  const [val, setVal] = useState(target)
  const prev = useRef(target)
  useEffect(() => {
    const from = prev.current
    prev.current = target
    if (Math.abs(from - target) < 0.001) { setVal(target); return }
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

// ── Animated SVG performance chart ───────────────────────────────────────────

function PerfChart({ data, floorUSD, height = 200 }: { data: number[]; floorUSD?: number; height?: number }) {
  const svgRef   = useRef<SVGSVGElement>(null)
  const pathRef  = useRef<SVGPathElement>(null)
  const [pathLen, setPathLen] = useState<number | null>(null)

  const W = 600, H = height, PAD = 12
  const min   = Math.min(...data)
  const max   = Math.max(...data)
  const range = (max - min) || 1
  const pts   = data.map((v, i) => [
    PAD + (i / (data.length - 1)) * (W - PAD * 2),
    H - PAD - ((v - min) / range) * (H - PAD * 2),
  ])

  const linePath = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const fillPath = `${linePath} L${W - PAD} ${H - PAD} L${PAD} ${H - PAD} Z`

  const refUSD = floorUSD ?? (data[0] ?? 0)
  const refY   = H - PAD - ((refUSD - min) / range) * (H - PAD * 2)

  // Compute total value change
  const startVal = data[0] ?? 0
  const endVal   = data[data.length - 1] ?? 0
  const isUp     = endVal >= startVal
  const lineColor = isUp ? '#22C55E' : '#EF4444'

  useEffect(() => {
    if (pathRef.current) setPathLen(pathRef.current.getTotalLength())
  }, [data])

  return (
    <div style={{ position:'relative' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width:'100%', height, display:'block' }}
      >
        <defs>
          <linearGradient id="fill-up"   x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#22C55E" stopOpacity="0.20" />
            <stop offset="100%" stopColor="#22C55E" stopOpacity="0.01" />
          </linearGradient>
          <linearGradient id="fill-down" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#EF4444" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#EF4444" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {/* Grid lines */}
        {[0.25, 0.5, 0.75].map(p => (
          <line key={p} x1={PAD} x2={W - PAD}
            y1={PAD + p * (H - PAD * 2)} y2={PAD + p * (H - PAD * 2)}
            stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
        ))}

        {/* Floor reference */}
        <line x1={PAD} x2={W - PAD} y1={refY} y2={refY}
          stroke="rgba(255,255,255,0.12)" strokeDasharray="4 4" strokeWidth="1" />

        {/* Fill area */}
        <path d={fillPath} fill={isUp ? 'url(#fill-up)' : 'url(#fill-down)'} />

        {/* Animated line */}
        <path
          ref={pathRef}
          d={linePath}
          fill="none"
          stroke={lineColor}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          style={pathLen != null ? {
            strokeDasharray: pathLen,
            strokeDashoffset: 0,
            animation: `chartIn 1.2s cubic-bezier(0.16,1,0.3,1) both`,
          } as React.CSSProperties : undefined}
        />

        {/* End dot */}
        {pts.length > 0 && (
          <circle
            cx={pts[pts.length - 1][0]}
            cy={pts[pts.length - 1][1]}
            r="4" fill={lineColor}
            style={{ filter:`drop-shadow(0 0 6px ${lineColor})`, animation:'fadeIn 600ms 1s both' }}
          />
        )}
      </svg>

      {/* Axis labels */}
      {data.length > 0 && (
        <div style={{ display:'flex', justifyContent:'space-between', marginTop:8 }}>
          <span className="chart-label">${Math.round(startVal).toLocaleString()}</span>
          <span className="chart-label">${Math.round(endVal).toLocaleString()}</span>
        </div>
      )}
    </div>
  )
}

// ── Activity types ────────────────────────────────────────────────────────────

type ExecRecord = {
  action: string; from: string | null; to: string
  amountUSD: number; simulated: boolean; receiptHash: string
  txHash?: string; timestamp: number
}

const KIND_MAP: Record<string, string> = {
  MIGRATE: 'migrate', HARVEST: 'harvest', HOLD: 'hold',
  SAFETY_EXIT: 'safety', GENESIS: 'migrate', REBALANCE: 'migrate', REBALANCE_UNIV3: 'migrate',
}
const KIND_LABELS: Record<string, string> = {
  migrate: 'DEPLOY', harvest: 'HARVEST', hold: 'HOLD', safety: 'SAFETY EXIT',
}

function relativeTime(ts: number): string {
  const d = (Date.now() - ts) / 1000
  if (d < 60)    return 'just now'
  if (d < 3600)  return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  return `${Math.floor(d / 86400)}d ago`
}

// ── Guardrail bar ─────────────────────────────────────────────────────────────

function Guardrail({
  label, value, displayVal, color, max = 100,
}: {
  label: string; value: number; displayVal: string; color: string; max?: number
}) {
  const pct = Math.min(100, (value / max) * 100)
  return (
    <div className="guardrail">
      <div className="guardrail-header">
        <span className="guardrail-label">{label}</span>
        <span className="guardrail-value">{displayVal}</span>
      </div>
      <div className="guardrail-track">
        <div className="guardrail-fill" style={{ width:`${pct}%`, background:color }} />
      </div>
    </div>
  )
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skel({ h = 16, w = '100%', r = 6 }: { h?: number; w?: string | number; r?: number }) {
  return <div className="skel" style={{ height:h, width:w, borderRadius:r }} />
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StrategyPage({ params }: { params: Promise<{ id: string }> }) {
  const router      = useRouter()
  const { id: userAddress } = React.use(params)

  const [agentUser, setAgentUser]   = useState<any>(null)
  const [agentReady, setAgentReady] = useState(false)
  const [range, setRange]           = useState('1M')

  const [showWithdraw, setShowWithdraw]       = useState(false)
  const [showPauseConfirm, setShowPauseConfirm] = useState(false)
  const [pauseLoading, setPauseLoading]         = useState(false)

  const { data: availableRaw } = useReadContract({
    address: VAULT_ADDRESS || undefined, abi: yieldGekoAbi, functionName: 'balances',
    args: userAddress && VAULT_ADDRESS ? [userAddress as `0x${string}`, USDC_ADDRESS] : undefined,
    query: { enabled: Boolean(userAddress && VAULT_ADDRESS), refetchInterval: 30_000 },
  })
  const { data: workingRaw } = useReadContract({
    address: VAULT_ADDRESS || undefined, abi: yieldGekoAbi, functionName: 'deployed',
    args: userAddress && VAULT_ADDRESS ? [userAddress as `0x${string}`, USDC_ADDRESS] : undefined,
    query: { enabled: Boolean(userAddress && VAULT_ADDRESS), refetchInterval: 30_000 },
  })
  const { data: policyRaw } = useReadContract({
    address: VAULT_ADDRESS || undefined, abi: yieldGekoAbi, functionName: 'policies',
    args: userAddress && VAULT_ADDRESS ? [userAddress as `0x${string}`] : undefined,
    query: { enabled: Boolean(userAddress && VAULT_ADDRESS), refetchInterval: 60_000 },
  })

  // Use !== undefined to handle 0n correctly (0n is falsy but means "read resolved with 0")
  const available  = availableRaw !== undefined ? Number(formatUnits(availableRaw as bigint, 6)) : null
  const working    = workingRaw   !== undefined ? Number(formatUnits(workingRaw as bigint, 6))   : null
  const readsLoaded = available !== null && working !== null
  const totalValue  = (available ?? 0) + (working ?? 0)

  // policyRaw may be returned as a named tuple or positional array depending on wagmi version.
  // Access both ways to avoid !undefined = true triggering a false paused banner.
  const policy  = policyRaw as { active: boolean; minAPY: bigint; maxDrawdownBps: bigint; 0: boolean; 2: bigint; 3: bigint } | undefined
  const policyActive = policy ? (policy.active ?? (policy as any)[0]) : undefined
  const minAPY  = policy ? Number((policy.minAPY ?? (policy as any)[2]) ?? BigInt(0)) / 100 : null
  const maxDD   = policy ? Number((policy.maxDrawdownBps ?? (policy as any)[3]) ?? BigInt(0)) / 100 : null
  const paused  = policyActive === false  // only true when explicitly false, not undefined

  useEffect(() => {
    if (!userAddress) return
    fetchAgentUser(userAddress).then(u => { setAgentUser(u); setAgentReady(true) })
    const id = setInterval(() => fetchAgentUser(userAddress).then(setAgentUser), 30_000)
    return () => clearInterval(id)
  }, [userAddress])

  const executePauseResume = useCallback(async () => {
    if (!userAddress || pauseLoading) return
    setShowPauseConfirm(false)
    setPauseLoading(true)
    try {
      const endpoint = paused ? '/api/resume-user' : '/api/pause-user'
      await agentPost(endpoint, { userAddress })
      const updated = await fetchAgentUser(userAddress)
      if (updated) setAgentUser(updated)
    } finally {
      setPauseLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userAddress, paused, pauseLoading])

  const handlePauseResume = useCallback(() => {
    if (!userAddress || pauseLoading) return
    if (paused) {
      // Resume: no confirmation needed — safe action
      executePauseResume()
    } else {
      // Pause: show confirmation first
      setShowPauseConfirm(true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userAddress, paused, pauseLoading, executePauseResume])

  const metrics    = agentUser?.portfolio?.metrics
  const currentAPY = (metrics?.weightedNetAPY as number | undefined) ?? 0
  const earned     = (metrics?.incomeEarnedUSD as number | undefined) ?? 0
  const positions: any[] = agentUser?.portfolio?.positions ?? []
  const executions: ExecRecord[] = agentUser?.executions ?? []
  const pnlHistory: { ts: number; totalUSD: number; navUSD: number }[] = agentUser?.pnlHistory ?? []

  const phase       = (agentUser?.phase as string | undefined) ?? 'INITIALIZING'
  const displayName = agentUser?.policy?.displayName?.split('—')[0]?.trim() ?? 'My Strategy'
  const updatedAgo  = agentUser?.updatedAt ? relativeTime(agentUser.updatedAt) : null
  const isRunning   = ['ALLOCATED','MONITORING','SCANNING','MIGRATING'].includes(phase)

  const animTotal = useCountUp(totalValue)
  const animEarned = useCountUp(earned)

  // Session start time — filter chart to current session only so testing
  // history from previous runs doesn't pollute the chart for real users.
  const sessionStart: number = (agentUser?.activeSessionStartedAt as number | undefined) ?? 0

  const chartData = useMemo(() => {
    const lengths: Record<string, number> = { '1W': 7, '1M': 30, '3M': 90 }
    const n = lengths[range] ?? 30
    // Only show history from the current active session
    const sessionHistory = sessionStart > 0
      ? pnlHistory.filter(p => p.ts >= sessionStart)
      : pnlHistory
    if (sessionHistory.length >= 2) {
      const step = Math.max(1, Math.floor(sessionHistory.length / n))
      return sessionHistory.filter((_, i) => i % step === 0).slice(-n)
        .map(p => p.totalUSD ?? 0)
    }
    // Flat line at current value while history builds up
    if (totalValue > 0) {
      return Array.from({ length: 7 }, () => totalValue)
    }
    return []
  }, [range, pnlHistory, totalValue, sessionStart])

  return (
    <>
      {showWithdraw && userAddress && (
        <WithdrawModal
          userAddress={userAddress}
          onClose={() => setShowWithdraw(false)}
          onDone={() => fetchAgentUser(userAddress).then(u => u && setAgentUser(u))}
        />
      )}
      {showPauseConfirm && (
        <ConfirmModal
          title="Pause the agent?"
          body={
            <>
              The agent will stop managing your position. Your funds stay in the vault and
              your LP position remains open — no swaps or closures happen.
              <br /><br />
              You can resume at any time.
            </>
          }
          confirmLabel="Yes, pause agent"
          confirmStyle="warn"
          onConfirm={executePauseResume}
          onCancel={() => setShowPauseConfirm(false)}
        />
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <AppNav />
      <div className="db-page">
        <div className="app-page">

          {/* Paused banner */}
          {paused && (
            <div className="paused-banner">
              <div className="paused-banner-left">
                <span style={{ fontSize:18 }}>⚠</span>
                <div>
                  <div style={{ fontWeight:600 }}>Agent paused — drawdown limit reached.</div>
                  <div style={{ fontSize:13, opacity:.8 }}>Your capital is secured in the vault.</div>
                </div>
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <button
                  className="btn-sm btn-warn-sm"
                  onClick={handlePauseResume}
                  disabled={pauseLoading}
                >
                  {pauseLoading ? 'Resuming…' : 'Resume agent'}
                </button>
                <button className="btn-sm btn-ghost-sm" onClick={() => setShowWithdraw(true)}>
                  Withdraw all
                </button>
              </div>
            </div>
          )}

          {/* Back nav */}
          <div style={{ padding:'32px 0 0' }}>
            <button
              onClick={() => router.push('/app')}
              style={{
                background:'none', border:'none', padding:0,
                fontSize:13, color:'var(--t3)', cursor:'pointer',
                display:'flex', alignItems:'center', gap:6,
                transition:'color 150ms', fontFamily:'inherit',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--t1)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--t3)')}
            >
              ← Dashboard
            </button>
          </div>

          {/* Header */}
          <div style={{ marginTop:20, animation:'fadeUp 500ms cubic-bezier(0.16,1,0.3,1) both' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
              <h1 style={{ fontSize:clamp(28, 36), fontWeight:800, color:'var(--t1)', letterSpacing:'-.025em', margin:0, lineHeight:1.1 }}>
                {displayName}
              </h1>
              <StatusPill state={paused ? 'paused' : 'running'} />
              <ChainChip chain="arbitrum" />
            </div>

            {/* Value row */}
            <div style={{ marginTop:20 }}>
              {!readsLoaded ? (
                <div style={{ marginTop:4 }}><Skel h={56} w={200} r={10} /></div>
              ) : (
              <div style={{ fontSize:clamp(40, 64), fontWeight:800, color:'var(--t1)', letterSpacing:'-.035em', lineHeight:1, fontVariantNumeric:'tabular-nums' }}>
                ${animTotal.toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 })}
              </div>
              )}
              <div style={{ display:'flex', alignItems:'center', gap:12, marginTop:12, flexWrap:'wrap' }}>
                {earned > 0 && (
                  <span style={{ fontSize:16, fontWeight:600, color:'var(--green)' }}>
                    +${animEarned.toFixed(4)} earned
                  </span>
                )}
                {currentAPY > 0 && (
                  <span style={{
                    fontSize:13, fontWeight:600, color:'var(--orange)',
                    background:'var(--orange-dim)', border:'1px solid rgba(234,88,12,.22)',
                    borderRadius:999, padding:'4px 12px',
                  }}>
                    {currentAPY.toFixed(1)}% APY
                  </span>
                )}
                {agentReady && currentAPY === 0 && (
                  <div className="phase-badge">
                    <span className="phase-badge-icon">⟳</span>
                    Agent {phase.toLowerCase().replace(/_/g,' ')} — first action within 60s
                  </div>
                )}
              </div>
            </div>

            {/* Action buttons */}
            <div style={{ display:'flex', gap:10, marginTop:24, flexWrap:'wrap' }}>
              <button
                className="btn-sm btn-ghost-sm"
                onClick={() => setShowWithdraw(true)}
              >
                Withdraw
              </button>
              <button
                className="btn-sm btn-warn-sm"
                onClick={handlePauseResume}
                disabled={pauseLoading}
                style={{ minWidth:120, position:'relative' }}
              >
                {pauseLoading ? (
                  <span style={{ display:'flex', alignItems:'center', gap:6 }}>
                    <span style={{
                      display:'inline-block', width:12, height:12, borderRadius:'50%',
                      border:'2px solid transparent', borderTopColor:'currentColor',
                      animation:'spin 0.8s linear infinite',
                    }} />
                    {paused ? 'Resuming…' : 'Pausing…'}
                  </span>
                ) : (paused ? 'Resume agent' : 'Pause agent')}
              </button>
              <button className="btn-sm btn-primary-sm" onClick={() => router.push('/onboard')}>
                Add funds
              </button>
            </div>
          </div>

          {/* Main grid */}
          <div className="strat-grid">

            {/* Left column */}
            <div style={{ display:'flex', flexDirection:'column', gap:20 }}>

              {/* Performance chart */}
              <div className="db-card db-card-p" style={{ animation:'fadeUp 500ms 60ms cubic-bezier(0.16,1,0.3,1) both' }}>
                <div className="sec-head">
                  <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
                    <span className="sec-title">Portfolio performance</span>
                    {updatedAgo && <span className="sec-meta">Updated {updatedAgo}</span>}
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    {isRunning && (
                      <span className="live-dot">
                        <span className="live-dot-ring" />
                        Live
                      </span>
                    )}
                    <div className="range-tabs">
                      {['1W', '1M', '3M'].map(r => (
                        <button key={r} data-active={range === r} onClick={() => setRange(r)}>{r}</button>
                      ))}
                    </div>
                  </div>
                </div>
                {chartData.length >= 2 ? (
                  <PerfChart data={chartData} floorUSD={totalValue * (1 - (maxDD ?? 0) / 100)} />
                ) : (
                  <div style={{ padding:'40px 0', textAlign:'center', fontSize:14, color:'var(--t3)' }}>
                    {agentReady ? 'Performance history appears after the first agent tick.' : <Skel h={160} />}
                  </div>
                )}
              </div>

              {/* Positions */}
              <div className="db-card db-card-p" style={{ animation:'fadeUp 500ms 120ms cubic-bezier(0.16,1,0.3,1) both' }}>
                <div className="sec-head">
                  <span className="sec-title">Where your capital is deployed</span>
                  {positions.length > 0 && (
                    <span className="sec-meta">{positions.length} position{positions.length > 1 ? 's' : ''}</span>
                  )}
                </div>

                {positions.length > 0 ? (
                  <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                    {positions.map((pos: any, i: number) => {
                      const protocol = (pos.protocol as string ?? '').toLowerCase()
                      const protoId  = protocol.includes('aave') ? 'aave'
                        : protocol.includes('morpho') ? 'morpho'
                        : protocol.includes('pendle') ? 'pendle'
                        : protocol.includes('gmx')    ? 'gmx'
                        : 'uniswap'
                      const apy          = (pos.currentNetAPY as number ?? 0)
                      const usd          = (pos.currentUSD as number ?? 0)
                      const feesEarned   = (pos.feesEarnedUSD as number ?? 0)
                      const pendingFees  = ((pos.uniV3PendingFees0USD ?? 0) + (pos.uniV3PendingFees1USD ?? 0)) as number
                      const ilUSD        = Math.abs(pos.ilUSD as number ?? 0)
                      const totalReturn  = (pos.totalReturnUSD as number ?? 0)
                      const drawdown     = (pos.drawdownPct as number ?? 0)
                      const daysHeld     = (pos.daysHeld as number ?? 0)
                      const entryUSD     = (pos.entryUSD as number ?? 0)

                      return (
                        <div key={i} style={{ animation:`fadeUp 400ms ${i * 60}ms cubic-bezier(0.16,1,0.3,1) both` }}>
                          <div className="alloc-card">
                            <div style={{ display:'flex', alignItems:'center', gap:14 }}>
                              <ProtocolMark id={protoId} size={40} />
                              <div>
                                <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)', letterSpacing:'-.005em' }}>
                                  {pos.venueName ?? pos.protocol}
                                </div>
                                <div style={{ fontSize:12, color:'var(--t3)', marginTop:2 }}>
                                  {pos.strategyType?.replace(/_/g,' ')} · Arbitrum
                                  {daysHeld > 0 && ` · ${daysHeld < 1 ? `${Math.round(daysHeld * 24)}h` : `${daysHeld.toFixed(1)}d`} held`}
                                </div>
                              </div>
                            </div>
                            <div style={{ textAlign:'right', flexShrink:0 }}>
                              <div style={{ fontSize:18, fontWeight:700, color:'var(--t1)', letterSpacing:'-.01em', fontVariantNumeric:'tabular-nums' }}>
                                ${usd.toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 })}
                              </div>
                              <div style={{ fontSize:12, marginTop:3 }}>
                                <span style={{ color:'var(--t3)' }}>{(pos.allocationPct ?? 0).toFixed(0)}%{' '}</span>
                                <span style={{ color:'var(--green)', fontWeight:600 }}>{apy.toFixed(1)}% APY</span>
                              </div>
                            </div>
                          </div>

                          {/* Position metrics breakdown */}
                          <div style={{
                            display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:1,
                            background:'var(--border)', borderRadius:12, overflow:'hidden', marginTop:8,
                          }}>
                            {[
                              { label:'Entry', val:`$${entryUSD.toFixed(2)}`, color:'var(--t2)' },
                              { label:'Fees earned', val: feesEarned > 0 ? `+$${feesEarned.toFixed(6)}` : '—', color:'var(--green)' },
                              { label:'Pending fees', val: pendingFees > 0.000001 ? `$${pendingFees.toFixed(6)}` : '—', color:'var(--orange)' },
                              { label:'IL impact', val: ilUSD > 0.000001 ? `-$${ilUSD.toFixed(6)}` : '—', color: ilUSD > 0.01 ? 'var(--amber)' : 'var(--t3)' },
                              { label:'Total return', val: `${totalReturn >= 0 ? '+' : ''}$${totalReturn.toFixed(6)}`, color: totalReturn >= 0 ? 'var(--green)' : 'var(--red)' },
                              { label:'Drawdown', val: drawdown > 0 ? `-${drawdown.toFixed(2)}%` : '0%', color: drawdown > 5 ? 'var(--amber)' : 'var(--t3)' },
                              { label:'Current APY', val:`${apy.toFixed(1)}%`, color:'var(--orange)' },
                              { label:'Entry APY', val:`${(pos.entryAPY as number ?? 0).toFixed(1)}%`, color:'var(--t2)' },
                            ].map(({ label, val, color }) => (
                              <div key={label} style={{ background:'var(--bg)', padding:'10px 14px' }}>
                                <div style={{ fontSize:10, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', fontWeight:600 }}>{label}</div>
                                <div style={{ fontSize:13, color, fontWeight:600, marginTop:4, fontVariantNumeric:'tabular-nums' }}>{val}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div style={{ padding:'24px 0', textAlign:'center', fontSize:14, color:'var(--t3)' }}>
                    {!agentReady
                      ? <><Skel h={14} /><div style={{height:10}}/><Skel h={14} w="60%" /></>
                      : 'Agent is deploying your capital — check back shortly.'}
                  </div>
                )}

                {/* Idle balance footer */}
                <div className="db-divider" />
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:13 }}>
                  <span style={{ color:'var(--t3)' }}>Idle (not working)</span>
                  {available === null
                    ? <Skel h={13} w={60} />
                    : <span style={{ color:'var(--t1)', fontWeight:600, fontVariantNumeric:'tabular-nums' }}>
                        ${available.toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 })}
                      </span>
                  }
                </div>
              </div>
            </div>

            {/* Right column */}
            <div style={{ display:'flex', flexDirection:'column', gap:20 }}>

              {/* Guardrails */}
              <div className="db-card db-card-p" style={{ animation:'fadeUp 500ms 80ms cubic-bezier(0.16,1,0.3,1) both' }}>
                <div className="sec-head" style={{ marginBottom:20 }}>
                  <span className="sec-title">Your guardrails</span>
                </div>
                {minAPY === null ? (
                  <><Skel h={14} /><div style={{height:12}}/><Skel h={5} /><div style={{height:16}}/><Skel h={14} /><div style={{height:12}}/><Skel h={5} /></>
                ) : (
                  <>
                    <Guardrail
                      label="APY floor"
                      value={minAPY}
                      displayVal={`${minAPY.toFixed(1)}%`}
                      color="linear-gradient(90deg, #16A34A, #22C55E)"
                      max={50}
                    />
                    <Guardrail
                      label="Max drawdown"
                      value={maxDD ?? 0}
                      displayVal={`${(maxDD ?? 0).toFixed(1)}%`}
                      color="linear-gradient(90deg, #F59E0B, #FBBF24)"
                      max={50}
                    />
                    {currentAPY > 0 && (
                      <Guardrail
                        label="Current APY"
                        value={currentAPY}
                        displayVal={`${currentAPY.toFixed(1)}%`}
                        color="linear-gradient(90deg, #EA580C, #FB923C)"
                        max={100}
                      />
                    )}
                  </>
                )}
              </div>

              {/* Activity feed */}
              <div className="db-card db-card-p" style={{ animation:'fadeUp 500ms 140ms cubic-bezier(0.16,1,0.3,1) both' }}>
                <div className="sec-head">
                  <span className="sec-title">Agent activity</span>
                  {executions.length > 0 && (
                    <span className="sec-meta">{executions.length} actions</span>
                  )}
                </div>

                {executions.length === 0 ? (
                  <div style={{ padding:'28px 0', textAlign:'center', fontSize:14, color:'var(--t3)' }}>
                    {agentReady
                      ? 'No actions yet — scanning for opportunities.'
                      : <><Skel h={14} /><div style={{height:12}}/><Skel h={14} w="70%" /></>}
                  </div>
                ) : (
                  <div>
                    {executions.slice(0, 8).map((e, i) => {
                      const kind = KIND_MAP[e.action] ?? 'hold'
                      return (
                        <div
                          key={i}
                          className="act-entry"
                          data-kind={kind}
                          style={{ animation:`fadeUp 350ms ${i * 40}ms cubic-bezier(0.16,1,0.3,1) both` }}
                        >
                          <div className="act-entry-ts">
                            <span className="act-entry-dot" />
                            <span>{relativeTime(e.timestamp)}</span>
                          </div>
                          <div className="act-entry-kind">{KIND_LABELS[kind] ?? e.action}</div>
                          <div className="act-entry-title">
                            {e.from ? `${e.from.split(' ')[0]} → ${e.to.split(' ')[0]}` : e.to}
                          </div>
                          {e.amountUSD > 0 && (
                            <div className="act-entry-row">
                              ${e.amountUSD.toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 })}
                            </div>
                          )}
                          {kind !== 'hold' && (
                            <div className="act-entry-foot">
                              <button
                                className="act-entry-verify"
                                onClick={() => router.push(`/proof/${e.receiptHash}`)}
                              >
                                Verify on-chain →
                              </button>
                              <span className="act-entry-anchor">
                                {e.txHash
                                  ? <span style={{ color:'var(--green)' }}>✓ Confirmed</span>
                                  : e.simulated
                                  ? <span style={{ color:'var(--t3)' }}>Simulated</span>
                                  : <span style={{ color:'var(--t3)' }}>⟳ Anchoring…</span>}
                              </span>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// Utility — CSS clamp fallback
function clamp(min: number, preferred: number): string {
  return `clamp(${min}px, ${preferred * 0.035}vw + ${min * 0.6}px, ${preferred}px)`
}
