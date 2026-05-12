'use client'

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useReadContract, useWriteContract } from 'wagmi'
import { formatUnits } from 'viem'
import { VAULT_ADDRESS, USDC_ADDRESS } from '@/config'
import { yieldGekoAbi } from '@/src/generated'
import { StatusPill, ChainChip, ProtocolMark } from '../../../components/ui'
import { useHeader } from '../../../components/HeaderContext'
import { AppHeader } from '../../../components/AppHeader'

// ── Agent state ───────────────────────────────────────────────────────────────

const AGENT_BASE = (process.env.NEXT_PUBLIC_AGENT_SSE_URL ?? 'http://localhost:3001/events').replace('/events', '')
const AGENT_KEY = process.env.NEXT_PUBLIC_AGENT_API_KEY ?? ''
const authHdr: Record<string, string> = AGENT_KEY ? { Authorization: `Bearer ${AGENT_KEY}` } : {}

function BrainIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      {/* Brain Cloud Outline */}
      <path d="M12 4c-3.5 0-4.5 2-4.5 2s-2.5-1-4 1-1 4.5 0 5c-1 1-1 3 0 4.5 0 0 .5 3.5 4.5 3.5.5 2.5 2.5 2 2.5 2s1.5-1 2.5-1 1 1 2.5 1 2-1 2.5-2c4 0 4.5-3.5 4.5-3.5 1-1.5 1-3.5 0-4.5 1-.5 1.5-3 0-5-1.5-2-4-1-4-1s-1-2-4.5-2Z" />
      {/* Internal Nodes (Circles) */}
      <circle cx="9" cy="9" r="1" fill="currentColor" />
      <circle cx="15" cy="8" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="16" cy="14" r="1" fill="currentColor" />
      <circle cx="8" cy="15" r="1" fill="currentColor" />
      {/* Circuit lines connecting nodes */}
      <path d="M4.5 11.5l2-1h2.5" />
      <path d="M11.5 4.5v2l1 2.5" />
      <path d="M19.5 10.5l-2.5 1-2 3.5" />
      <path d="M13.5 18.5l-1.5-2-4-1.5" />
    </svg>
  )
}

type AmbiguousStrategyChoice = {
  userId: string;
  displayName: string;
  phase?: string;
};

type StrategyLookupResult =
  | Record<string, any>
  | { __ambiguousStrategies: AmbiguousStrategyChoice[] };

async function fetchAgentUser(idOrAddress: string): Promise<any | null> {
  try {
    // Address (0x + 40 hex chars) → fetch all strategies for that wallet, return first active
    const isAddress = /^0x[a-fA-F0-9]{40}$/.test(idOrAddress)
    if (isAddress) {
      const res = await fetch(`${AGENT_BASE}/api/strategies/${idOrAddress}`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) return null
      const strategies = await res.json() as any[]
      if (!Array.isArray(strategies) || strategies.length === 0) return null
      if (strategies.length === 1) return strategies[0]
      return {
        __ambiguousStrategies: strategies.map((strategy) => ({
          userId: strategy.userId,
          displayName: strategy.policy?.displayName ?? strategy.userId,
          phase: strategy.phase,
        })),
      }
    }
    // userId (e.g. 0xgeko-apex-alpha) → fetch directly
    const res = await fetch(`${AGENT_BASE}/state/${idOrAddress}`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

async function agentPost(path: string, body: object): Promise<any> {
  const res = await fetch(`${AGENT_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHdr },
    body: JSON.stringify(body),
  })
  return res.json()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  const d = (Date.now() - ts) / 1000
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  return `${Math.floor(d / 86400)}d ago`
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function actionColor(a: string) {
  if (a === 'GENESIS') return '#22C55E'
  if (a === 'WITHDRAW') return '#EF4444'
  if (a === 'MIGRATE') return '#3B82F6'
  if (a?.includes('REBALANCE')) return '#8B5CF6'
  if (a === 'SAFETY_EXIT') return '#EF4444'
  return '#EA580C'
}

function actionLabel(a: string) {
  if (a === 'GENESIS') return 'Deployed'
  if (a === 'WITHDRAW') return 'Withdrew'
  if (a === 'MIGRATE') return 'Migrated'
  if (a === 'SAFETY_EXIT') return 'Safety exit'
  if (a?.includes('REBALANCE')) return 'Rebalanced'
  if (a === 'HARVEST') return 'Harvested'
  return a
}

function actionEmoji(a: string) {
  if (a === 'GENESIS') return '🌱'
  if (a === 'WITHDRAW') return '📤'
  if (a === 'MIGRATE') return '🔄'
  if (a === 'SAFETY_EXIT') return '🛡️'
  if (a?.includes('REBALANCE')) return '⚖️'
  if (a === 'HARVEST') return '🌾'
  return '⚡'
}

function parseTokenPair(raw: string): [string, string] | null {
  const normalized = raw.replace(/USD[₮Ꞇ]0?/g, 'USDT')
  const m = normalized.match(/\b([A-Z]{2,6})-([A-Z]{2,6})\b/)
  return m ? [m[1], m[2]] : null
}

function cleanVenueName(raw: string): string {
  return raw
    .replace(/\(LVR-screened\)/gi, '')
    .replace(/USD[₮Ꞇ]0?/g, 'USDT')   // USD₮0, USD₮ → USDT
    .replace(/\s+/g, ' ')
    .trim()
}

function strategyTag(ex: any): string {
  const label = (raw: string | null) => {
    if (!raw) return ''
    const pair = parseTokenPair(raw)
    if (pair) return `${pair[0]}/${pair[1]}`
    return cleanVenueName(raw).split(' ').slice(0, 3).join(' ')
  }
  const to = label(ex.to); const from = label(ex.from)
  if (from && to && from !== to) return `${from} → ${to}`
  return to || from
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skel({ h = 16, w = '100%', r = 6 }: { h?: number; w?: string | number; r?: number }) {
  return <div className="skel" style={{ height: h, width: w, borderRadius: r }} />
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
      setVal(from + (target - from) * (1 - Math.pow(1 - t, 3)))
      if (t < 1) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, [target, duration])
  return val
}

// ── Mini chart ────────────────────────────────────────────────────────────────

function MiniChart({ data, height = 180 }: { data: number[]; height?: number }) {
  if (data.length < 2) return null
  const W = 600; const H = height; const PAD = 8
  const min = Math.min(...data); const max = Math.max(...data); const range = (max - min) || 1
  const pts = data.map((v, i) => [
    PAD + (i / (data.length - 1)) * (W - PAD * 2),
    H - PAD - ((v - min) / range) * (H - PAD * 2),
  ])
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const fill = `${line} L${W - PAD} ${H - PAD} L${PAD} ${H - PAD} Z`
  const isUp = (data[data.length - 1] ?? 0) >= (data[0] ?? 0)
  const c = isUp ? '#22C55E' : '#EF4444'
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={c} stopOpacity="0.18" />
          <stop offset="100%" stopColor={c} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fill} fill="url(#sg)" />
      <path d={line} fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {pts.length > 0 && (
        <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]}
          r="4" fill={c} style={{ filter: `drop-shadow(0 0 5px ${c})` }} />
      )}
    </svg>
  )
}

// ── OrbitalSpinner ────────────────────────────────────────────────────────────

function OrbitalSpinner({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '32px 0' }}>
      <div style={{ position: 'relative', width: 56, height: 56 }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.08)' }} />
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '2px solid transparent', borderTopColor: 'var(--orange)', animation: 'spin 1.1s linear infinite' }} />
        <div style={{ position: 'absolute', inset: 10, borderRadius: '50%', background: 'var(--orange)', opacity: 0.15, animation: 'pulse 1.1s ease-in-out infinite' }} />
        <div style={{ position: 'absolute', inset: '50%', transform: 'translate(-50%,-50%)', width: 6, height: 6, borderRadius: '50%', background: 'var(--orange)' }} />
      </div>
      <span style={{ fontSize: 13, color: 'var(--text-muted)', letterSpacing: '0.04em' }}>{label}</span>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{0%,100%{opacity:.08}50%{opacity:.28}}`}</style>
    </div>
  )
}

// ── Agent Intelligence Feed (real data) ──────────────────────────────────────

type FeedEntry =
  | { id: string; type: 'log'; level: string; message: string; detail?: string; ts: number }
  | { id: string; type: 'exec'; data: any; ts: number }

function levelColor(level: string) {
  if (level === 'SUCCESS') return '#22C55E'
  if (level === 'WARN') return '#F59E0B'
  if (level === 'ERROR') return '#EF4444'
  return 'var(--text-muted)'
}

function levelIcon(level: string) {
  if (level === 'SUCCESS') return '✓'
  if (level === 'WARN') return '⚠'
  if (level === 'ERROR') return '✗'
  return '🧠'
}

function phaseStatus(phase: string) {
  if (phase === 'SCANNING') return 'Scanning for yield opportunities…'
  if (phase === 'MIGRATING') return 'Executing position migration…'
  if (phase === 'WITHDRAWING') return 'Unwinding position…'
  if (phase === 'PAUSED') return 'Agent paused — position held open'
  if (phase === 'IDLE') return 'Idle — awaiting deployment'
  if (phase === 'SAFETY_EXIT') return 'Safety exit triggered'
  return 'Actively monitoring position…'
}

function LiveAgentFeed({ agentUser, executions, phase }: {
  agentUser: any;
  executions: any[];
  phase: string;
}) {
  const [feed, setFeed] = useState<FeedEntry[]>([])
  const userId = agentUser?.userId as string | undefined

  // Build feed from polled agentUser state (refreshes every 30s)
  useEffect(() => {
    const logs: FeedEntry[] = (agentUser?.log ?? []).slice(0, 25).map((l: any) => ({
      id: l.id,
      type: 'log' as const,
      level: l.level ?? 'INFO',
      message: l.message,
      detail: l.detail,
      ts: l.timestamp,
    }))
    const execs: FeedEntry[] = executions.slice(0, 5).map((e: any) => ({
      id: `exec-${e.receiptHash ?? e.timestamp}`,
      type: 'exec' as const,
      data: e,
      ts: e.timestamp,
    }))
    setFeed([...logs, ...execs].sort((a, b) => b.ts - a.ts).slice(0, 30))
  }, [agentUser?.log, executions])

  // SSE for real-time additions — new entries appear instantly on each tick
  useEffect(() => {
    if (!userId) return
    const sseUrl = process.env.NEXT_PUBLIC_AGENT_SSE_URL ?? 'http://localhost:3001/events'
    const es = new EventSource(sseUrl)

    es.onmessage = (event) => {
      try {
        const evt = JSON.parse(event.data)
        if (!evt) return

        if (evt.type === 'LOG' && evt.payload?.userId === userId) {
          const entry = evt.payload?.entry
          if (!entry) return
          const newLog: FeedEntry = {
            id: entry.id ?? `log-${Date.now()}`,
            type: 'log',
            level: entry.level ?? 'INFO',
            message: entry.message,
            detail: entry.detail,
            ts: entry.timestamp ?? Date.now(),
          }
          setFeed(prev => [newLog, ...prev].slice(0, 30))
        }

        if (evt.type === 'EXECUTION' && evt.payload?.userId === userId) {
          const ex = evt.payload
          const newExec: FeedEntry = {
            id: `exec-${ex.receiptHash ?? Date.now()}`,
            type: 'exec',
            data: ex,
            ts: ex.timestamp ?? Date.now(),
          }
          setFeed(prev => [newExec, ...prev].slice(0, 30))
        }
      } catch { /* ignore malformed events */ }
    }

    return () => es.close()
  }, [userId])

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Real phase status */}
      <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 10, background: 'rgba(234,88,12,0.05)', border: '1px solid rgba(234,88,12,0.1)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ position: 'relative', width: 20, height: 20, flexShrink: 0 }}>
          <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '2px solid rgba(234,88,12,0.2)' }} />
          <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '2px solid transparent', borderTopColor: '#EA580C', animation: 'spin 1s linear infinite' }} />
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 500 }}>{phaseStatus(phase)}</span>
      </div>

      {/* Feed */}
      {feed.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '24px 0' }}>
          Waiting for agent activity…
        </div>
      ) : feed.map((entry, i) => (
        <div key={entry.id} style={{ animation: i === 0 ? 'fadeInSlide 0.35s ease-out both' : undefined }}>
          {entry.type === 'exec' ? (
            <ExecRow ex={entry.data} compact />
          ) : (
            <div style={{ display: 'flex', gap: 10, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
              <div style={{ width: 28, height: 28, borderRadius: 7, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 11, color: levelColor(entry.level), fontWeight: 700 }}>
                {levelIcon(entry.level)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: entry.level === 'INFO' ? 'var(--text-muted)' : levelColor(entry.level), lineHeight: 1.45, fontFamily: 'monospace', wordBreak: 'break-word' }}>
                  {entry.message}
                </div>
                {entry.detail && (
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1, opacity: 0.55, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.detail}
                  </div>
                )}
                <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2, opacity: 0.4 }}>
                  {new Date(entry.ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
      <style>{`@keyframes fadeInSlide{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:translateY(0)}}`}</style>
    </div>
  )
}

// ── ConfirmModal ──────────────────────────────────────────────────────────────

function ConfirmModal({ title, body, confirmLabel, confirmStyle = 'danger', onConfirm, onCancel, icon }: {
  title: string; body: React.ReactNode; confirmLabel: string
  confirmStyle?: 'danger' | 'warn'; onConfirm: () => void; onCancel: () => void; icon?: string
}) {
  const accent = confirmStyle === 'danger' ? '#ef4444' : '#f59e0b'
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 999, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(12px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, animation: 'backdropFade 0.3s ease-out' }} onClick={onCancel}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 24, padding: '32px 28px', width: 400, maxWidth: '100%', boxShadow: '0 20px 40px rgba(0,0,0,0.4)', textAlign: 'center', animation: 'modalPop 0.4s cubic-bezier(0.16, 1, 0.3, 1)' }} onClick={e => e.stopPropagation()}>
        {icon && (
          <div style={{ width: 64, height: 64, borderRadius: 20, background: `${accent}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, margin: '0 auto 20px', border: `1px solid ${accent}25` }}>
            {icon}
          </div>
        )}
        <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--text-primary)', marginBottom: 12, letterSpacing: '-0.02em' }}>{title}</div>
        <div style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 32 }}>{body}</div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="btn-ghost" style={{ flex: 1, height: 48, borderRadius: 12, fontWeight: 600 }} onClick={onCancel}>Cancel</button>
          <button style={{ flex: 1, height: 48, borderRadius: 12, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 14, background: accent, color: '#fff', boxShadow: `0 4px 12px ${accent}40` }} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── WithdrawModal ─────────────────────────────────────────────────────────────

type WithdrawPhase = 'confirm' | 'agent-closing' | 'ready-to-sign' | 'signing-tx' | 'done' | 'error'

function WithdrawModal({
  userId,
  userAddress,
  onClose,
  onDone,
}: {
  userId: string;
  userAddress: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<WithdrawPhase>('confirm')
  const [idleRaw, setIdleRaw] = useState<bigint>(BigInt(0))
  const [isSmartAccount, setIsSmartAccount] = useState(false)
  const [errMsg, setErrMsg] = useState('')
  const { writeContract } = useWriteContract()
  const idleUSDC = Number(idleRaw) / 1e6

  useEffect(() => {
    if (phase !== 'agent-closing') return
    const setGlobal = (window as any).setGlobalLoading
    if (setGlobal) setGlobal(true)
    let cancelled = false
    agentPost('/api/withdraw', { userId, userAddress }).then((res: any) => {
      if (cancelled) return
      if (res.ok || res.status === 'IDLE_ONLY') {
        setIdleRaw(BigInt(res.idleUSDCRaw ?? '0'))
        setIsSmartAccount(!!(res.isSmartAccount))
        setPhase('ready-to-sign')
      } else { setErrMsg(res.error ?? 'Agent could not unwind the position.'); setPhase('error') }
    }).catch((e: any) => { if (!cancelled) { setErrMsg(e.message); setPhase('error') } })
      .finally(() => { if (!cancelled && setGlobal) setGlobal(false) })
    return () => { cancelled = true; if (setGlobal) setGlobal(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, userAddress, userId])

  function signWithdraw() {
    if (!VAULT_ADDRESS || idleRaw === BigInt(0)) return
    const setGlobal = (window as any).setGlobalLoading
    if (setGlobal) setGlobal(true)
    setPhase('signing-tx')
    writeContract({ address: VAULT_ADDRESS, abi: yieldGekoAbi, functionName: 'withdraw', args: [USDC_ADDRESS, idleRaw] }, {
      onSuccess: () => { setPhase('done'); if (setGlobal) setGlobal(false) },
      onError: (e: any) => { setErrMsg(e.shortMessage ?? e.message); setPhase('error'); if (setGlobal) setGlobal(false) },
    })
  }

  if (phase === 'confirm') return <ConfirmModal icon="📤" title="Withdraw everything?" body={<>This will immediately close your active position and convert all LP tokens to USDC. You'll then sign a final transaction to receive funds.<br /><br /><span style={{ color: '#ef4444', fontWeight: 600 }}>This stops the agent from earning.</span></>} confirmLabel="Yes, withdraw" confirmStyle="danger" onConfirm={() => setPhase('agent-closing')} onCancel={onClose} />

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 999, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(12px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, animation: 'backdropFade 0.3s ease-out' }} onClick={phase === 'agent-closing' ? undefined : onClose}>
      <div key={phase} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 24, padding: '32px 28px', width: 420, maxWidth: '100%', boxShadow: '0 20px 40px rgba(0,0,0,0.4)', animation: 'modalPop 0.4s cubic-bezier(0.16, 1, 0.3, 1)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
          <span style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}>Withdraw funds</span>
          {phase !== 'agent-closing' && <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.05)', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>}
        </div>

        {phase === 'agent-closing' && (
          <div style={{ textAlign: 'center', padding: '10px 0' }}>
            <OrbitalSpinner label="Agent closing position on-chain…" />
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 12, padding: 16, marginTop: 20, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                The agent is unwinding LP positions and swapping for USDC. This typically takes 30–90 seconds.
              </div>
            </div>
          </div>
        )}

        {phase === 'ready-to-sign' && (
          <>
            <div style={{ textAlign: 'center', marginBottom: 32, padding: '24px 0', background: 'rgba(34,197,94,0.05)', borderRadius: 20, border: '1px dotted rgba(34,197,94,0.3)' }}>
              <div style={{ fontSize: 36, fontWeight: 800, color: '#22C55E', letterSpacing: '-0.03em' }}>{idleUSDC.toFixed(4)} <span style={{ fontSize: 18, opacity: 0.8 }}>USDC</span></div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>{isSmartAccount ? 'Sent to your wallet' : 'Available in vault'}</div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 32 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#22C55E', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#fff' }}>✓</div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Position closed &amp; converted to USDC</div>
              </div>
              {!isSmartAccount && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 24, height: 24, borderRadius: '50%', border: '2px solid #EA580C', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#EA580C' }}>2</div>
                  <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>Sign wallet transfer</div>
                </div>
              )}
            </div>

            {isSmartAccount ? (
              <button className="btn-primary" style={{ width: '100%', height: 52, borderRadius: 14, fontWeight: 700, fontSize: 15 }} onClick={() => { onDone(); onClose() }}>
                Done
              </button>
            ) : (
              <button className="btn-primary" style={{ width: '100%', height: 52, borderRadius: 14, fontWeight: 700, fontSize: 15 }} onClick={signWithdraw}>
                Sign to receive funds
              </button>
            )}
          </>
        )}

        {phase === 'signing-tx' && <OrbitalSpinner label="Check your wallet to sign…" />}

        {phase === 'done' && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'rgba(34,197,94,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 40, margin: '0 auto 24px' }}>🎉</div>
            <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 8 }}>Withdrawal complete</div>
            <div style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 32 }}>Your funds are now in your wallet.</div>
            <button className="btn-primary" style={{ width: '100%', height: 48, borderRadius: 12 }} onClick={() => { onDone(); onClose() }}>Done</button>
          </div>
        )}

        {phase === 'error' && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 14, color: '#ef4444', background: 'rgba(239,68,68,0.08)', borderRadius: 12, padding: '20px', marginBottom: 24, border: '1px solid rgba(239,68,68,0.2)' }}>
              {errMsg || 'An unexpected error occurred.'}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn-primary" style={{ flex: 1, height: 48, borderRadius: 12 }} onClick={() => { setErrMsg(''); setPhase('confirm') }}>Try again</button>
              <button className="btn-ghost" style={{ flex: 1, height: 48, borderRadius: 12 }} onClick={onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Guardrail bar ─────────────────────────────────────────────────────────────

// ── Autonomous Radar HUD ──────────────────────────────────────────────────────

function PolicyHUD({ minAPY, maxDD, currentAPY, totalValue, earned }: { minAPY: number; maxDD: number; currentAPY: number; totalValue: number; earned: number }) {
  // We use a 3-axis radar: Performance (APY), Safety (Drawdown), and Stability
  // Normalized to 0-100 for the SVG
  const apyPct = Math.min(100, (currentAPY / (minAPY || 1)) * 50)
  const safetyPct = Math.min(100, (1 - (maxDD / 50)) * 100)
  const stability = 85

  const size = 180; const center = size / 2; const radius = (size / 2) - 20
  const getPoint = (pct: number, angleDeg: number) => {
    const r = (pct / 100) * radius
    const angleRad = (angleDeg - 90) * (Math.PI / 180)
    return { x: center + r * Math.cos(angleRad), y: center + r * Math.sin(angleRad) }
  }
  const p1 = getPoint(apyPct, 0); const p2 = getPoint(safetyPct, 120); const p3 = getPoint(stability, 240)
  const polygon = `${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`
  const a1 = getPoint(100, 0); const a2 = getPoint(100, 120); const a3 = getPoint(100, 240)

  return (
    <div className="strategy-hub-content" style={{ display: 'flex', alignItems: 'center', gap: 32, padding: '10px 0' }}>
      {/* Radar Section */}
      <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ filter: 'drop-shadow(0 0 8px rgba(234,88,12,0.15))' }}>
          <circle cx={center} cy={center} r={radius} fill="none" stroke="var(--border)" strokeWidth="1" strokeDasharray="4 4" opacity="0.5" />
          <circle cx={center} cy={center} r={radius * 0.66} fill="none" stroke="var(--border)" strokeWidth="1" strokeDasharray="4 4" opacity="0.3" />
          <line x1={center} y1={center} x2={a1.x} y2={a1.y} stroke="var(--border)" strokeWidth="1" opacity="0.4" />
          <line x1={center} y1={center} x2={a2.x} y2={a2.y} stroke="var(--border)" strokeWidth="1" opacity="0.4" />
          <line x1={center} y1={center} x2={a3.x} y2={a3.y} stroke="var(--border)" strokeWidth="1" opacity="0.4" />
          <polygon points={polygon} fill="rgba(234,88,12,0.12)" stroke="#EA580C" strokeWidth="2" strokeLinejoin="round" />
          <circle cx={p1.x} cy={p1.y} r="3" fill="#EA580C" />
          <circle cx={p2.x} cy={p2.y} r="3" fill="#EA580C" />
          <circle cx={p3.x} cy={p3.y} r="3" fill="#EA580C" />
        </svg>
        <div style={{ position: 'absolute', top: center - 4, left: center - 4, width: 8, height: 8, borderRadius: '50%', background: '#EA580C', boxShadow: '0 0 10px #EA580C', animation: 'pulse 2s infinite' }} />
      </div>

      {/* Metrics Section */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Main Balance Row */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Total Strategy Value</div>
          <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums' }}>
            ${totalValue.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}
          </div>
        </div>

        {/* Secondary Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>Yield Earned</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: earned > 0 ? '#22C55E' : 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {earned > 0 ? `+$${earned.toFixed(6)}` : '—'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>Current APY</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#EA580C', fontVariantNumeric: 'tabular-nums' }}>
              {currentAPY.toFixed(1)}%
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>APY Floor</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{minAPY.toFixed(1)}%</div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>Risk Buffer</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: maxDD > 15 ? '#F59E0B' : '#22C55E' }}>{(50 - maxDD).toFixed(1)}% left</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', background: 'var(--background)', borderRadius: 10, border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 12, color: '#3B82F6', fontWeight: 700 }}>✓ 0G PROOF</div>
          <div style={{ width: 1, height: 12, background: 'var(--border)' }} />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>Policy strictly enforced by TEE environment.</div>
        </div>
      </div>
    </div>
  )
}

// ── 0G Proof badges ───────────────────────────────────────────────────────────

function ProofBadges({ ex }: { ex: any }) {
  const hasChain = Boolean(ex.zgChainExplorer)
  const hasTrace = Boolean(ex.zgTraceCID)
  const hasAttest = Boolean(ex.zgAttestCID)
  if (!hasChain && !hasTrace && !hasAttest) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
      {hasChain && (
        <a href={ex.zgChainExplorer} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: 'rgba(34,197,94,0.10)', color: '#22C55E', textDecoration: 'none', border: '1px solid rgba(34,197,94,0.2)' }}>
          ✓ 0G Chain
        </a>
      )}
      {hasTrace && (
        <a href={`https://storagescan.0g.ai/submission/${ex.zgTraceCID}`} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: 'rgba(59,130,246,0.10)', color: '#3B82F6', textDecoration: 'none', border: '1px solid rgba(59,130,246,0.2)' }}>
          ✓ Trace
        </a>
      )}
      {hasAttest && (
        <a href={`https://storagescan.0g.ai/submission/${ex.zgAttestCID}`} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: 'rgba(139,92,246,0.10)', color: '#8B5CF6', textDecoration: 'none', border: '1px solid rgba(139,92,246,0.2)' }}>
          🔒 TEE
        </a>
      )}
    </div>
  )
}

// ── Execution row ─────────────────────────────────────────────────────────────

function ExecRow({ ex, compact = false }: { ex: any; compact?: boolean }) {
  const color = actionColor(ex.action)
  const tag = strategyTag(ex)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: compact ? '9px 0' : '14px 0', borderBottom: '1px solid var(--border)' }}>
      {/* Icon */}
      <div style={{ width: compact ? 32 : 38, height: compact ? 32 : 38, borderRadius: compact ? 8 : 10, flexShrink: 0, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: compact ? 14 : 17 }}>
        {actionEmoji(ex.action)}
      </div>
      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: compact ? 13 : 14, fontWeight: 600, color: 'var(--text-primary)' }}>{actionLabel(ex.action)}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{ex.timestamp ? relativeTime(ex.timestamp) : ''}</span>
        </div>
        {/* Strategy tag + amount */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
          {tag && (
            <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: `${color}18`, color, flexShrink: 0 }}>
              {tag}
            </span>
          )}
          {ex.amountUSD != null && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>${Number(ex.amountUSD).toFixed(2)}</span>
          )}
        </div>
        {/* 0G proof badges */}
        <ProofBadges ex={ex} />
        {/* View full proof CTA — only when receiptHash exists */}
        {ex.receiptHash && ex.receiptHash !== '0x' && (
          <div style={{ marginTop: 5 }}>
            <a
              href={`/verify/${ex.receiptHash}${ex.zgChainTxHash ? `?tx=${ex.zgChainTxHash}` : ''}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 10, color: '#EA580C', fontWeight: 600, textDecoration: 'none', opacity: 0.85 }}
            >
              View full proof →
            </a>
          </div>
        )}
        {/* Tx hash */}
        {!compact && ex.txHash && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'monospace' }}>
            {ex.txHash.slice(0, 22)}…
          </div>
        )}
      </div>
      {/* Amount right */}
      {ex.amountUSD != null && (
        <span style={{ fontSize: compact ? 12 : 13, fontWeight: 700, flexShrink: 0, color: ex.action === 'WITHDRAW' ? '#EF4444' : '#22C55E', fontVariantNumeric: 'tabular-nums' }}>
          {ex.action === 'WITHDRAW' ? '-' : '+'}${Number(ex.amountUSD).toFixed(2)}
        </span>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

const ACTION_FILTERS = ['All', 'GENESIS', 'REBALANCE', 'MIGRATE', 'WITHDRAW']

export default function StrategyPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter()
  const { id: idOrAddress } = React.use(params)
  const header = useMemo(() => <AppHeader />, [])
  useHeader(header)

  const [agentUser, setAgentUser] = useState<any>(null)
  const [agentReady, setAgentReady] = useState(false)
  const [tab, setTab] = useState<'overview' | 'executions' | 'position'>('overview')
  const [range, setRange] = useState('1M')
  const [execFilter, setExecFilter] = useState('All')
  const [showWithdraw, setShowWithdraw] = useState(false)
  const [showPauseConfirm, setShowPauseConfirm] = useState(false)
  const [pauseLoading, setPauseLoading] = useState(false)

  const ambiguousStrategies = agentUser && '__ambiguousStrategies' in (agentUser as Record<string, unknown>)
    ? (agentUser as { __ambiguousStrategies: AmbiguousStrategyChoice[] }).__ambiguousStrategies
    : null
  const strategyId = agentUser?.userId || (!idOrAddress.startsWith('0x') ? idOrAddress : undefined)
  const contractTarget = agentUser?.policy?.userAddress || (idOrAddress.startsWith('0x') ? idOrAddress : undefined)

  const { data: availableRaw } = useReadContract({
    address: VAULT_ADDRESS || undefined, abi: yieldGekoAbi, functionName: 'balances',
    args: contractTarget && VAULT_ADDRESS ? [contractTarget as `0x${string}`, USDC_ADDRESS] : undefined,
    query: { enabled: Boolean(contractTarget && VAULT_ADDRESS), refetchInterval: 30_000 },
  })
  const { data: workingRaw } = useReadContract({
    address: VAULT_ADDRESS || undefined, abi: yieldGekoAbi, functionName: 'deployed',
    args: contractTarget && VAULT_ADDRESS ? [contractTarget as `0x${string}`, USDC_ADDRESS] : undefined,
    query: { enabled: Boolean(contractTarget && VAULT_ADDRESS), refetchInterval: 30_000 },
  })
  const { data: policyRaw } = useReadContract({
    address: VAULT_ADDRESS || undefined, abi: yieldGekoAbi, functionName: 'policies',
    args: contractTarget && VAULT_ADDRESS ? [contractTarget as `0x${string}`] : undefined,
    query: { enabled: Boolean(contractTarget && VAULT_ADDRESS), refetchInterval: 60_000 },
  })

  const available = availableRaw !== undefined ? Number(formatUnits(availableRaw as bigint, 6)) : null
  const working = workingRaw !== undefined ? Number(formatUnits(workingRaw as bigint, 6)) : null
  const readsLoaded = available !== null && working !== null
  const vaultTotal = (available ?? 0) + (working ?? 0)

  const policy = policyRaw as any
  const policyActive = policy ? (policy.active ?? policy[0]) : undefined
  const minAPY = policy ? Number((policy.minAPY ?? policy[2]) ?? BigInt(0)) / 100 : null
  const maxDD = policy ? Number((policy.maxDrawdownBps ?? policy[3]) ?? BigInt(0)) / 100 : null
  const paused = policyActive === false

  useEffect(() => {
    if (!idOrAddress) return
    fetchAgentUser(idOrAddress).then(u => { setAgentUser(u); setAgentReady(true) })
    const id = setInterval(() => fetchAgentUser(idOrAddress).then(setAgentUser), 30_000)
    return () => clearInterval(id)
  }, [idOrAddress])

  const executePauseResume = useCallback(async () => {
    if (!strategyId || pauseLoading) return
    const setGlobal = (window as any).setGlobalLoading
    if (setGlobal) setGlobal(true)
    setShowPauseConfirm(false); setPauseLoading(true)
    try {
      await agentPost(paused ? '/api/resume-user' : '/api/pause-user', { userId: strategyId })
      const updated = await fetchAgentUser(idOrAddress)
      if (updated) setAgentUser(updated)
    } finally {
      setPauseLoading(false)
      if (setGlobal) setGlobal(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyId, paused, pauseLoading, idOrAddress])

  const handlePauseResume = useCallback(() => {
    if (!strategyId || pauseLoading) return
    paused ? executePauseResume() : setShowPauseConfirm(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyId, paused, pauseLoading, executePauseResume])

  const metrics = agentUser?.portfolio?.metrics
  const currentAPY = (metrics?.weightedNetAPY as number | undefined) ?? 0
  const earned = (metrics?.incomeEarnedUSD as number | undefined) ?? 0
  const positions: any[] = agentUser?.portfolio?.positions ?? []
  const executions: any[] = agentUser?.executions ?? []
  const pnlHistory: any[] = agentUser?.pnlHistory ?? []
  const phase = (agentUser?.phase as string | undefined) ?? 'INITIALIZING'
  const displayName = agentUser?.policy?.displayName?.split('—')[0]?.trim() ?? 'My Strategy'
  const isRunning = ['ALLOCATED', 'MONITORING', 'SCANNING', 'MIGRATING'].includes(phase)
  const sessionStart = (agentUser?.activeSessionStartedAt as number | undefined) ?? 0

  // Agent NAV takes priority. When totalValueUSD is 0 but strategy is running,
  // fall back to totalEntryUSD (the deployed capital) so the UI shows a meaningful
  // value while the NAV reader is healing / restarting.
  const agentTotal = (metrics?.totalValueUSD as number | undefined) ?? null
  const entryUSD = (metrics?.totalEntryUSD as number | undefined) ?? vaultTotal
  const displayTotal = (agentTotal !== null && agentTotal > 0)
    ? agentTotal
    : (isRunning && entryUSD > 0 ? entryUSD : (vaultTotal || 0))
  // trueTotal = principal + fees (fees tracked separately from principal in agent state)
  const trueTotal = displayTotal + earned
  const pnlUSD = trueTotal > 0 ? trueTotal - entryUSD : 0
  const pnlPct = entryUSD > 0 ? (pnlUSD / entryUSD) * 100 : 0

  const animTotal = useCountUp(trueTotal)

  const chartData = useMemo(() => {
    const lengths: Record<string, number> = { '1W': 7, '1M': 30, '3M': 90 }
    const n = lengths[range] ?? 30
    const hist = sessionStart > 0 ? pnlHistory.filter((p: any) => p.ts >= sessionStart) : pnlHistory
    if (hist.length >= 2 && hist.some((p: any) => (p.totalUSD ?? 0) > 0)) {
      const step = Math.max(1, Math.floor(hist.length / n))
      return hist.filter((_: any, i: number) => i % step === 0).slice(-n).map((p: any) => p.totalUSD ?? 0)
    }
    if (displayTotal > 0) return Array(7).fill(displayTotal)
    return []
  }, [range, pnlHistory, displayTotal, sessionStart])

  // Filtered executions for Executions tab
  const filteredExecs = useMemo(() => {
    if (execFilter === 'All') return executions
    return executions.filter((e: any) =>
      execFilter === 'REBALANCE' ? e.action?.includes('REBALANCE') : e.action === execFilter
    )
  }, [executions, execFilter])

  // Group by date for Executions tab
  const groupedExecs = useMemo(() => {
    const groups: Record<string, any[]> = {}
    filteredExecs.forEach((e: any) => {
      const day = e.timestamp ? formatDate(e.timestamp) : 'Unknown'
      if (!groups[day]) groups[day] = []
      groups[day].push(e)
    })
    return Object.entries(groups)
  }, [filteredExecs])

  if (agentReady && ambiguousStrategies && ambiguousStrategies.length > 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: 60, textAlign: 'center', animation: 'contentSlide 600ms cubic-bezier(0.16, 1, 0.3, 1)'
      }}>
        <h1 style={{ fontSize: 32, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 16, letterSpacing: '-0.03em' }}>
          Choose a strategy
        </h1>
        <p style={{ fontSize: 17, color: 'var(--text-muted)', maxWidth: 560, lineHeight: 1.6, marginBottom: 36, fontWeight: 400 }}>
          This wallet has multiple strategies under one account. Open the exact strategy you want to inspect or control.
        </p>

        <div style={{ width: '100%', maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {ambiguousStrategies.map((strategy) => (
            <button
              key={strategy.userId}
              onClick={() => router.push(`/app/strategy/${strategy.userId}`)}
              style={{
                width: '100%',
                padding: '16px 18px',
                borderRadius: 16,
                background: 'var(--surface)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
                cursor: 'pointer',
                textAlign: 'left',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
              }}
            >
              <div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{strategy.displayName}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  {strategy.userId}
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                {(strategy.phase ?? 'INITIALIZING').toLowerCase().replace(/_/g, ' ')} →
              </div>
            </button>
          ))}
        </div>

        <button
          onClick={() => router.push('/app')}
          style={{
            marginTop: 20,
            padding: '14px 28px',
            borderRadius: 14,
            background: 'transparent',
            color: 'var(--text-primary)',
            fontSize: 14,
            fontWeight: 600,
            border: '1px solid var(--border)',
            cursor: 'pointer',
          }}
        >
          Return to Dashboard
        </button>
      </div>
    )
  }

  // ── Strategy Not Found (Empty State) ──
  if (agentReady && !agentUser) {
    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: 60, textAlign: 'center', animation: 'contentSlide 600ms cubic-bezier(0.16, 1, 0.3, 1)'
      }}>
        {/* Abstract "Searching" Visual */}
        <div style={{ position: 'relative', width: 220, height: 220, marginBottom: 48, animation: 'float 6s ease-in-out infinite' }}>
          {/* Outer Ring */}
          <div style={{
            position: 'absolute', inset: 0, borderRadius: '50%', border: '1px dashed rgba(128,128,128,0.12)',
            animation: 'spin 40s linear infinite'
          }}>
            {/* Node on Outer Ring */}
            <div style={{ position: 'absolute', top: -4, left: '50%', width: 8, height: 8, borderRadius: '50%', background: 'rgba(128,128,128,0.4)', border: '1px solid var(--border)' }} />
          </div>

          {/* Middle Ring with Nodes */}
          <div style={{
            position: 'absolute', inset: 40, borderRadius: '50%', border: '1px solid rgba(128,128,128,0.08)',
            animation: 'spin 25s linear infinite reverse'
          }}>
            <div style={{ position: 'absolute', top: -3, left: '20%', width: 6, height: 6, borderRadius: '50%', background: 'var(--orange)', opacity: 0.6 }} />
            <div style={{ position: 'absolute', bottom: -3, right: '20%', width: 5, height: 5, borderRadius: '50%', background: 'rgba(128,128,128,0.3)' }} />
          </div>

          {/* Inner Ring with Nodes */}
          <div style={{
            position: 'absolute', inset: 80, borderRadius: '50%', border: '1px solid rgba(234,88,12,0.1)',
            animation: 'pulseRing 4s ease-in-out infinite'
          }}>
            <div style={{ position: 'absolute', right: -3, top: '50%', width: 4, height: 4, borderRadius: '50%', background: 'var(--orange)' }} />
          </div>

          {/* Connecting "Search" Line */}
          <div style={{
            position: 'absolute', top: '50%', left: '50%', width: 1, height: 80,
            background: 'linear-gradient(to top, var(--orange), transparent)',
            transformOrigin: 'top', transform: 'rotate(45deg)', opacity: 0.3,
            animation: 'spin 8s cubic-bezier(0.4, 0, 0.2, 1) infinite'
          }} />

          {/* Central Core */}
          <div style={{
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            width: 10, height: 10, borderRadius: '50%', background: 'var(--orange)',
            boxShadow: '0 0 30px var(--orange), 0 0 60px rgba(234,88,12,0.4)',
            animation: 'heartbeat 2s ease-in-out infinite'
          }} />

          <style>{`
            @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            @keyframes float { 
              0%, 100% { transform: translateY(0); }
              50% { transform: translateY(-15px); }
            }
            @keyframes heartbeat {
              0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
              50% { transform: translate(-50%, -50%) scale(1.4); opacity: 0.8; }
            }
            @keyframes pulseRing {
              0%, 100% { transform: scale(1); opacity: 0.3; }
              50% { transform: scale(1.1); opacity: 0.6; }
            }
          `}</style>
        </div>

        <h1 style={{ fontSize: 32, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 16, letterSpacing: '-0.03em' }}>
          Awaiting Genesis
        </h1>
        <p style={{ fontSize: 17, color: 'var(--text-muted)', maxWidth: 460, lineHeight: 1.6, marginBottom: 48, fontWeight: 400 }}>
          The coordinates <code style={{ color: 'var(--orange)', fontWeight: 600, fontSize: 14 }}>{idOrAddress.slice(0, 12)}...</code> lead to uncharted space. This strategy hasn’t been initialized on the agent network yet.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: '100%', maxWidth: 300 }}>
          <button
            onClick={() => router.push('/app/onboard')}
            style={{
              padding: '16px 28px', borderRadius: 14, background: 'var(--orange)', color: '#000',
              fontSize: 15, fontWeight: 700, border: 'none', cursor: 'pointer', transition: 'all 300ms cubic-bezier(0.16, 1, 0.3, 1)',
              boxShadow: '0 8px 24px rgba(234,88,12,0.25)'
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.02) translateY(-2px)'; e.currentTarget.style.boxShadow = '0 12px 32px rgba(234,88,12,0.35)' }}
            onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(234,88,12,0.25)' }}
          >
            Launch this Strategy
          </button>
          <button
            onClick={() => router.push('/app')}
            style={{
              padding: '14px 28px', borderRadius: 14, background: 'transparent', color: 'var(--text-primary)',
              fontSize: 14, fontWeight: 600, border: '1px solid var(--border)', cursor: 'pointer', transition: 'all 200ms'
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            Return to Dashboard
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      {showWithdraw && contractTarget && strategyId && (
        <WithdrawModal userId={strategyId} userAddress={contractTarget} onClose={() => setShowWithdraw(false)} onDone={() => fetchAgentUser(idOrAddress).then(u => u && setAgentUser(u))} />
      )}
      {showPauseConfirm && (
        <ConfirmModal icon="⏸" title="Pause the agent?" body={<>The agent will stop managing your position. Your funds stay in the vault and your LP position remains open — no swaps will happen.<br /><br />You can resume at any time.</>} confirmLabel="Yes, pause agent" confirmStyle="warn" onConfirm={executePauseResume} onCancel={() => setShowPauseConfirm(false)} />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {/* Responsive overrides */}
        <style>{`
          @media (max-width: 1024px) {
            .strategy-header { flex-direction: column !important; align-items: stretch !important; gap: 24px !important; }
            .strategy-header-left { gap: 16px !important; }
            .strategy-actions { width: 100% !important; margin-top: 16px !important; gap: 10px !important; }
            .strategy-actions button { flex: 1 !important; height: 44px !important; }
            
            .strategy-grid { grid-template-columns: 1fr !important; }
            .strategy-left-col { padding: 24px 0 !important; border-right: none !important; }
            .strategy-right-col { width: 100% !important; padding: 24px 0 !important; }
            
            .stats-grid { grid-template-columns: 1fr !important; }
            .metrics-grid { grid-template-columns: repeat(2, 1fr) !important; }
            .strategy-tabs-scroll { gap: 16px !important; padding: 0 !important; width: 100% !important; max-width: 100% !important; }
            .tab-content-wrap { max-width: 100% !important; }
            .strategy-hub-content { flex-direction: column !important; align-items: stretch !important; gap: 24px !important; }
            
            /* Modal Animations */
            @keyframes backdropFade { from { opacity: 0; } to { opacity: 1; } }
            @keyframes modalPop { from { opacity: 0; transform: scale(0.96) translateY(10px); } to { opacity: 1; transform: scale(1) translateY(0); } }
            @keyframes contentSlide { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
          }
          
          /* Global animations available outside media query too */
          @keyframes backdropFade { from { opacity: 0; } to { opacity: 1; } }
          @keyframes modalPop { from { opacity: 0; transform: scale(0.96) translateY(10px); } to { opacity: 1; transform: scale(1) translateY(0); } }
          @keyframes contentSlide { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        `}</style>

        {/* ── Paused banner ── */}
        {paused && (
          <div className="paused-banner">
            <div className="paused-banner-left">
              <span style={{ fontSize: 18 }}>⚠</span>
              <div>
                <div style={{ fontWeight: 600 }}>Agent paused — drawdown limit reached.</div>
                <div style={{ fontSize: 13, opacity: 0.8 }}>Your capital is secured in the vault.</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-sm btn-warn-sm" onClick={handlePauseResume} disabled={pauseLoading}>{pauseLoading ? 'Resuming…' : 'Resume agent'}</button>
              <button className="btn-sm btn-ghost-sm" onClick={() => setShowWithdraw(true)}>Withdraw all</button>
            </div>
          </div>
        )}

        {/* ── Profile header ── */}
        <div style={{ padding: '32px 0 0', borderBottom: '1px solid var(--border)', width: '100%' }}>
          <div className="strategy-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 20 }}>

            {/* Left: back + value */}
            <div className="strategy-header-left" style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
              <button onClick={() => router.push('/app')} style={{ marginTop: 6, background: 'none', border: 'none', padding: 0, fontSize: 18, color: 'var(--text-muted)', cursor: 'pointer', lineHeight: 1 }}>←</button>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, color: 'var(--text-muted)', fontWeight: 500 }}>{displayName}</span>
                  <StatusPill state={paused ? 'paused' : 'running'} />
                  <ChainChip chain="arbitrum" />
                </div>
                <div style={{ fontSize: 34, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-.03em', lineHeight: 1.2, fontVariantNumeric: 'tabular-nums', margin: '4px 0' }}>
                  {readsLoaded || agentReady
                    ? `$${animTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : <Skel h={40} w={180} r={8} />}
                </div>
                {displayTotal > 0 && entryUSD > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: pnlPct >= 0 ? '#22C55E' : '#EF4444' }}>
                      {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}% (${Math.abs(pnlUSD).toFixed(4)})
                    </span>
                    <div style={{ padding: '2px 6px', borderRadius: 6, background: 'var(--surface)', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, border: '1px solid var(--border)' }}>PnL</div>
                    {currentAPY > 0 && (
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#EA580C', background: 'rgba(234,88,12,0.10)', borderRadius: 999, padding: '2px 10px', border: '1px solid rgba(234,88,12,0.2)' }}>
                        {currentAPY.toFixed(1)}% APY
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Right: action buttons */}
            <div className="strategy-actions" style={{ display: 'flex', gap: 8, flexShrink: 0, marginTop: 4, flexWrap: 'wrap' }}>
              <button onClick={() => router.push('/app/create')} style={{
                height: 36, padding: '0 16px', borderRadius: 10, border: 'none',
                background: '#EA580C', color: '#fff',
                fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                display: 'flex', alignItems: 'center', gap: 8,
                boxShadow: '0 4px 12px rgba(234,88,12,0.2)'
              }}>
                <BrainIcon size={16} />
                Create agent
              </button>
              <button onClick={handlePauseResume} disabled={pauseLoading} style={{ height: 36, padding: '0 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', opacity: pauseLoading ? 0.6 : 1 }}>
                {pauseLoading ? (paused ? 'Resuming…' : 'Pausing…') : (paused ? 'Resume agent' : 'Pause agent')}
              </button>
              <button onClick={() => setShowWithdraw(true)} style={{ height: 36, padding: '0 14px', borderRadius: 10, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)', color: '#EF4444', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}>
                Withdraw
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="strategy-tabs-scroll" style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '0 4px', overflowX: 'auto' }}>
            {(['overview', 'executions', 'position'] as const).map(t => (
              <div key={t} onClick={() => setTab(t)} style={{ paddingBottom: 12, borderBottom: tab === t ? '2px solid #EA580C' : '2px solid transparent', fontSize: 14, fontWeight: 600, color: tab === t ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap', textTransform: 'capitalize' }}>
                {t === 'executions' ? `Executions${executions.length > 0 ? ` (${executions.length})` : ''}` : t.charAt(0).toUpperCase() + t.slice(1)}
              </div>
            ))}
          </div>
        </div>

        {/* ── Tab: Overview ── */}
        {tab === 'overview' && (
          <div className="strategy-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 340px', flex: 1, minHeight: 0 }}>

            {/* Left — chart + stat cards */}
            <div className="strategy-left-col" style={{ padding: '24px 24px 48px 0', borderRight: '1px solid var(--border)', overflowY: 'auto' }}>

              {/* Performance */}
              <div style={{ marginBottom: 28 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Performance</span>
                    {isRunning && <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22C55E', display: 'inline-block', boxShadow: '0 0 6px #22C55E' }} />}
                  </div>
                  <div style={{ display: 'flex', gap: 2 }}>
                    {(['1W', '1M', '3M'] as const).map(r => (
                      <button key={r} onClick={() => setRange(r)} style={{ padding: '4px 10px', borderRadius: 8, cursor: 'pointer', background: range === r ? 'var(--surface)' : 'transparent', color: range === r ? 'var(--text-primary)' : 'var(--text-muted)', fontSize: 12, fontWeight: range === r ? 600 : 400, border: range === r ? '1px solid var(--border)' : '1px solid transparent', fontFamily: 'inherit' }}>
                        {r}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Chart card */}
                <div style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', padding: '20px 20px 14px', marginBottom: 16 }}>
                  {chartData.length >= 2 ? (
                    <>
                      <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums', marginBottom: 2 }}>
                        ${(chartData[chartData.length - 1] ?? 0).toFixed(4)}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
                        {range === '1W' ? 'Last 7 days' : range === '1M' ? 'Last 30 days' : 'Last 3 months'}
                      </div>
                      <MiniChart data={chartData} height={140} />
                    </>
                  ) : (
                    <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 6 }}>
                      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{agentReady ? 'Performance history builds up over time' : <Skel h={13} />}</div>
                      {agentReady && <div style={{ fontSize: 12, color: 'var(--text-muted)', opacity: 0.6 }}>Check back after the agent takes its first actions</div>}
                    </div>
                  )}
                </div>
              </div>

              {/* Guardrails HUD */}
              {(minAPY !== null || maxDD !== null) && (
                <div style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', padding: '16px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Strategy Intelligence Hub</span>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 }}>Active Enforcement</span>
                  </div>
                  <PolicyHUD
                    minAPY={minAPY ?? 0}
                    maxDD={maxDD ?? 0}
                    currentAPY={currentAPY}
                    totalValue={displayTotal}
                    earned={earned}
                  />
                </div>
              )}
            </div>

            {/* Right — Neural Agent Feed */}
            <div className="strategy-right-col" style={{ width: 340, padding: '24px 0 24px 24px', overflowY: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Agent Intelligence</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', borderRadius: 4, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)' }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#22C55E', animation: 'pulse 1.5s infinite' }} />
                    <span style={{ fontSize: 9, fontWeight: 800, color: '#22C55E', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Live</span>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>v1.0.4-aura</div>
              </div>

              <LiveAgentFeed agentUser={agentUser} executions={executions} phase={phase} />
            </div>
          </div>
        )}

        {/* ── Tab: Executions — Zerion History style ── */}
        {tab === 'executions' && (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {/* Filter bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 0', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
              {ACTION_FILTERS.map(f => (
                <button key={f} onClick={() => setExecFilter(f)} style={{ height: 30, padding: '0 12px', borderRadius: 20, border: `1px solid ${execFilter === f ? 'var(--text-muted)' : 'var(--border)'}`, background: execFilter === f ? 'var(--surface)' : 'transparent', color: execFilter === f ? 'var(--text-primary)' : 'var(--text-muted)', fontSize: 12, fontWeight: execFilter === f ? 600 : 400, cursor: 'pointer', fontFamily: 'inherit' }}>
                  {f === 'All' ? 'All actions' : f === 'GENESIS' ? 'Deployed' : f === 'REBALANCE' ? 'Rebalanced' : f === 'MIGRATE' ? 'Migrated' : 'Withdrew'}
                </button>
              ))}
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
                {filteredExecs.length} action{filteredExecs.length !== 1 ? 's' : ''}
              </span>
            </div>

            {/* Grouped by date */}
            {filteredExecs.length === 0 ? (
              <div style={{ padding: '48px 0', textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
                No executions matching this filter.
              </div>
            ) : (
              <div className="tab-content-wrap" style={{ maxWidth: 680 }}>
                {groupedExecs.map(([day, exs]) => (
                  <div key={day}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', padding: '20px 0 8px', textTransform: 'uppercase', letterSpacing: '.06em' }}>{day}</div>
                    {exs.map((ex: any, i: number) => <ExecRow key={i} ex={ex} />)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Tab: Position ── */}
        {tab === 'position' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px 0' }}>
            <div className="tab-content-wrap" style={{ maxWidth: 720 }}>
              {positions.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '48px 0', fontSize: 13, color: 'var(--text-muted)' }}>
                  {agentReady ? 'Agent is deploying your capital — check back shortly.' : <><Skel h={14} /><div style={{ height: 10 }} /><Skel h={14} w="60%" /></>}
                </div>
              ) : positions.map((pos: any, i: number) => {
                const protocol = (pos.protocol as string ?? '').toLowerCase()
                const protoId = protocol.includes('aave') ? 'aave' : protocol.includes('morpho') ? 'morpho' : protocol.includes('pendle') ? 'pendle' : protocol.includes('gmx') ? 'gmx' : 'uniswap'
                const apy = (pos.currentNetAPY as number ?? 0)
                const posUSDBase = ((pos.currentUSD as number > 0 ? pos.currentUSD : null) ?? pos.allocationUSD ?? pos.entryUSD ?? 0) as number
                const usd = posUSDBase + (pos.incomeEarnedUSD as number ?? 0)
                const feesEarned = (pos.feesEarnedUSD as number ?? 0)
                const pendingFees = ((pos.uniV3PendingFees0USD ?? 0) + (pos.uniV3PendingFees1USD ?? 0)) as number
                const ilUSD = Math.abs(pos.ilUSD as number ?? 0)
                const totalReturn = (pos.totalReturnUSD as number ?? 0)
                const drawdown = (pos.drawdownPct as number ?? 0)
                const daysHeld = (pos.daysHeld as number ?? 0)
                const entryUSDPos = (pos.entryUSD as number ?? 0)
                const venueName = pos.venueName ?? pos.protocol ?? 'Strategy'
                const venueNameClean = cleanVenueName(venueName)
                const pair = parseTokenPair(venueNameClean)

                return (
                  <div key={i} style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', marginBottom: 16, overflow: 'hidden' }}>
                    {/* Position header */}
                    <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <ProtocolMark id={protoId} size={38} />
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                            {pair ? `${pair[0]} / ${pair[1]}` : venueNameClean}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                            {pos.strategyType?.replace(/_/g, ' ')} · Arbitrum
                            {daysHeld > 0 && ` · ${daysHeld < 1 ? `${Math.round(daysHeld * 24)}h` : `${daysHeld.toFixed(1)}d`} held`}
                          </div>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                          ${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                        <div style={{ fontSize: 12, color: '#22C55E', fontWeight: 600, marginTop: 2 }}>
                          {apy.toFixed(1)}% APY
                        </div>
                      </div>
                    </div>

                    {/* Metrics grid */}
                    <div className="metrics-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1, background: 'var(--border)' }}>
                      {[
                        { label: 'Entry', val: `$${entryUSDPos.toFixed(2)}`, color: 'var(--text-muted)' },
                        { label: 'Fees earned', val: feesEarned > 0 ? `+$${feesEarned.toFixed(6)}` : '—', color: '#22C55E' },
                        { label: 'Pending fees', val: pendingFees > 0.000001 ? `$${pendingFees.toFixed(6)}` : '—', color: '#EA580C' },
                        { label: 'IL impact', val: ilUSD > 0.000001 ? `-$${ilUSD.toFixed(6)}` : '—', color: ilUSD > 0.01 ? '#F59E0B' : 'var(--text-muted)' },
                        { label: 'Total return', val: `${totalReturn >= 0 ? '+' : ''}$${totalReturn.toFixed(6)}`, color: totalReturn >= 0 ? '#22C55E' : '#EF4444' },
                        { label: 'Drawdown', val: drawdown > 0 ? `-${drawdown.toFixed(2)}%` : '0%', color: drawdown > 5 ? '#F59E0B' : 'var(--text-muted)' },
                        { label: 'Current APY', val: `${apy.toFixed(1)}%`, color: '#EA580C' },
                        { label: 'Entry APY', val: `${(pos.entryAPY as number ?? 0).toFixed(1)}%`, color: 'var(--text-muted)' },
                      ].map(({ label, val, color }) => (
                        <div key={label} style={{ background: 'var(--background)', padding: '10px 14px' }}>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 600 }}>{label}</div>
                          <div style={{ fontSize: 13, color, fontWeight: 600, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{val}</div>
                        </div>
                      ))}
                    </div>

                    {/* UniV3 specifics */}
                    {pos.uniV3TokenId && (
                      <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                        <div><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Token ID </span><span style={{ fontSize: 11, fontWeight: 600, fontFamily: 'monospace' }}>#{pos.uniV3TokenId}</span></div>
                        {pos.uniV3RangePct && <div><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Range </span><span style={{ fontSize: 11, fontWeight: 600 }}>±{pos.uniV3RangePct}%</span></div>}
                        {pos.uniV3Rebalances != null && <div><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Rebalances </span><span style={{ fontSize: 11, fontWeight: 600 }}>{pos.uniV3Rebalances}</span></div>}
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Idle USDC */}
              {available !== null && available > 0 && (
                <div style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Idle USDC</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Not deployed — awaiting agent allocation</div>
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#F59E0B', fontVariantNumeric: 'tabular-nums' }}>
                    ${available.toFixed(4)}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
