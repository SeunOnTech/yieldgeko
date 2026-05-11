'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useReadContract } from 'wagmi'
import { formatUnits } from 'viem'
import { VAULT_ADDRESS, USDC_ADDRESS } from '@/config'
import { yieldGekoAbi } from '@/src/generated'
import { WalletAvatar } from '../components/WalletAvatar'

// ── Agent fetch ───────────────────────────────────────────────────────────────

const AGENT_BASE = (process.env.NEXT_PUBLIC_AGENT_SSE_URL ?? 'http://localhost:3001/events').replace('/events', '')

async function fetchAgentUser(address: string): Promise<any | null> {
  try {
    const res = await fetch(`${AGENT_BASE}/state`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const state = await res.json()
    const users = Object.values(state.users ?? {}) as any[]
    return users.find(u => u.policy?.userAddress?.toLowerCase() === address.toLowerCase()) ?? null
  } catch { return null }
}

// ── Animated counter ──────────────────────────────────────────────────────────

function useCountUp(target: number, duration = 800): number {
  const [val, setVal] = useState(target)
  const prev = useRef(target)
  useEffect(() => {
    const from = prev.current; prev.current = target
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

function MiniChart({ data, height = 100 }: { data: number[]; height?: number }) {
  if (data.length < 2) return null
  const W = 400; const H = height; const PAD = 2
  const min = Math.min(...data); const max = Math.max(...data); const range = (max - min) || 1
  const pts = data.map((v, i) => [
    PAD + (i / (data.length - 1)) * (W - PAD * 2),
    H - PAD - ((v - min) / range) * (H - PAD * 2),
  ])
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const fill = `${line} L${W - PAD} ${H - PAD} L${PAD} ${H - PAD} Z`
  const c = (data[data.length - 1] ?? 0) >= (data[0] ?? 0) ? '#22C55E' : '#EF4444'
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={c} stopOpacity="0.16" />
          <stop offset="100%" stopColor={c} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fill} fill="url(#cg)" />
      <path d={line} fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── Util ──────────────────────────────────────────────────────────────────────

function actionLabel(a: string) {
  return a === 'GENESIS' ? 'Deployed' : a === 'WITHDRAW' ? 'Withdrew' : a === 'MIGRATE' ? 'Migrated' : a?.includes('REBALANCE') ? 'Rebalanced' : a === 'HARVEST' ? 'Harvested' : a
}
function actionColor(a: string) {
  return a === 'GENESIS' ? '#22C55E' : a === 'WITHDRAW' ? '#EF4444' : a === 'MIGRATE' ? '#3B82F6' : a?.includes('REBALANCE') ? '#8B5CF6' : '#EA580C'
}
function actionEmoji(a: string) {
  return a === 'GENESIS' ? '🌱' : a === 'WITHDRAW' ? '📤' : a === 'MIGRATE' ? '🔄' : a?.includes('REBALANCE') ? '⚖️' : a === 'HARVEST' ? '🌾' : '⚡'
}
function timeAgo(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ── Logo helpers ──────────────────────────────────────────────────────────────

const PROTOCOL_LOGOS: Record<string, string> = {
  // UNI token logo = Uniswap protocol logo (verified 200)
  uniswap:  'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984/logo.png',
  // AAVE token on Ethereum (verified 200)
  aave:     'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9/logo.png',
  // Morpho GitHub avatar (no token logo available)
  morpho:   'https://avatars.githubusercontent.com/u/97085409?s=64&v=4',
  // PENDLE token on Arbitrum (verified 200)
  pendle:   'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/assets/0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8/logo.png',
  // GMX token on Arbitrum (verified 200)
  gmx:      'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/assets/0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a/logo.png',
}

const TOKEN_LOGOS: Record<string, string> = {
  WETH:  'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png',
  USDC:  'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png',
  USDT:  'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png',
  WBTC:  'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png',
  ARB:   'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/assets/0x912CE59144191C1204E64559FE8253a0e49E6548/logo.png',
  DAI:   'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png',
  PENDLE:'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/assets/0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8/logo.png',
}

const CHAIN_LOGO_ARB = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/info/logo.png'

function getProtocolLogo(venueName: string, protocol: string): string | null {
  const s = `${venueName} ${protocol}`.toLowerCase()
  for (const [key, url] of Object.entries(PROTOCOL_LOGOS)) {
    if (s.includes(key)) return url
  }
  return null
}

function parseTokenPair(venueName: string): [string, string] | null {
  const m = venueName.match(/\b([A-Z]{2,6})-([A-Z]{2,6})\b/)
  return m ? [m[1], m[2]] : null
}

function cleanStrategyName(venueName: string): string {
  return venueName.replace(/\(LVR-screened\)/gi, '').replace(/\s+/g, ' ').trim()
}

function strategyTag(ex: any): string {
  const label = (raw: string | null) => {
    if (!raw) return ''
    const clean = cleanStrategyName(raw)
    const pair  = parseTokenPair(clean)
    // Extract short protocol name (first meaningful word, skip "V3/V2" suffixes)
    const proto = clean.split(' ').find(w => w.length > 2 && !['V2','V3','LP','PT','YT'].includes(w)) ?? ''
    if (pair) return proto ? `${proto} · ${pair[0]}/${pair[1]}` : `${pair[0]}/${pair[1]}`
    return clean.split(' ').slice(0, 3).join(' ')
  }
  const to   = label(ex.to)
  const from = label(ex.from)
  if (from && to && from !== to) return `${from} → ${to}`
  return to || from
}

// ── Bot icon ──────────────────────────────────────────────────────────────────

const IcoBot = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <rect x="2" y="5" width="12" height="8" rx="2" fillOpacity=".12" stroke="currentColor" strokeWidth="1.2" fill="none"/>
    <circle cx="5.5" cy="9" r="1.2"/><circle cx="10.5" cy="9" r="1.2"/>
    <path d="M8 2v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    <circle cx="8" cy="2" r="1"/>
  </svg>
)

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AppPage() {
  const router = useRouter()
  const { address } = useAccount()
  const [agentUser, setAgentUser] = useState<any>(null)
  const [tab, setTab] = useState<'portfolio' | 'activity'>('portfolio')
  const [chartRange, setChartRange] = useState<'1W' | '1M' | 'All'>('1M')

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

  const available  = availableRaw !== undefined ? Number(formatUnits(availableRaw as bigint, 6)) : 0
  const working    = workingRaw   !== undefined ? Number(formatUnits(workingRaw as bigint, 6))   : 0
  const totalValue = available + working

  const policy  = policyRaw as { active: boolean; minAPY: bigint; maxDrawdownBps: bigint } | undefined
  const minAPY  = policy?.minAPY ? Number(policy.minAPY) / 100 : 0
  const maxDD   = policy?.maxDrawdownBps ? Number(policy.maxDrawdownBps) / 100 : 0

  useEffect(() => {
    if (!address) return
    fetchAgentUser(address).then(setAgentUser)
    const id = setInterval(() => fetchAgentUser(address).then(setAgentUser), 30_000)
    return () => clearInterval(id)
  }, [address])

  const metrics    = agentUser?.portfolio?.metrics
  const earned     = (metrics?.incomeEarnedUSD as number | undefined) ?? 0
  const currentAPY = (metrics?.weightedNetAPY as number | undefined) ?? null
  const phase      = (agentUser?.phase as string | undefined) ?? 'IDLE'
  const executions: any[] = agentUser?.executions ?? []
  const positions: any[]  = agentUser?.portfolio?.positions ?? []
  const pnlHistory: any[] = agentUser?.pnlHistory ?? []

  // Prefer agent's portfolio NAV (sum of all positions, accurate for multi-strategy)
  // Fall back to vault contract read (USDC only) when agent state not loaded yet
  const agentTotalUSD = (metrics?.totalValueUSD as number | undefined) ?? null
  const displayTotal  = agentTotalUSD !== null ? agentTotalUSD : (available + working)

  const isRunning = ['ALLOCATED', 'MONITORING', 'SCANNING', 'MIGRATING'].includes(phase)
  const entryUSD  = metrics?.totalEntryUSD ?? displayTotal
  // True total return = unrealized capital change + all fees/yield earned
  const pnlUSD    = displayTotal > 0 ? (displayTotal - entryUSD) + earned : 0
  const pnlPct    = entryUSD > 0 ? (pnlUSD / entryUSD) * 100 : 0

  const animTotal = useCountUp(address ? displayTotal : 0)
  const shortAddr = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : ''

  const chartData = useMemo(() => {
    const lens: Record<string, number> = { '1W': 7, '1M': 30, 'All': 999 }
    const hist = pnlHistory.slice(-lens[chartRange])
    if (hist.length >= 2) return hist.map((p: any) => p.totalUSD ?? 0)
    if (displayTotal > 0) return Array(8).fill(displayTotal)
    return []
  }, [chartRange, pnlHistory, displayTotal])

  // ── JSX ────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>

      {/* Desktop top bar — sticky context strip */}
      <div style={{
        height: 64, borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        position: 'sticky', top: 0, zIndex: 40,
        background: 'var(--background)', backdropFilter: 'blur(12px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            height: 26, padding: '0 10px', borderRadius: 999,
            background: 'var(--arbitrum-bg)', border: '1px solid rgba(40,160,240,0.2)',
            display: 'inline-flex', alignItems: 'center', gap: 5,
            fontSize: 12, fontWeight: 500, color: 'var(--arbitrum)',
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--arbitrum)', display: 'inline-block' }} />
            Arbitrum
          </span>
          {agentUser && (
            <span style={{
              height: 26, padding: '0 10px', borderRadius: 999,
              background: isRunning ? 'rgba(34,197,94,0.08)' : 'rgba(245,158,11,0.08)',
              border: `1px solid ${isRunning ? 'rgba(34,197,94,0.2)' : 'rgba(245,158,11,0.2)'}`,
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 12, fontWeight: 500, color: isRunning ? '#22C55E' : '#F59E0B',
            }}>
              <IcoBot />
              Agent {phase.toLowerCase().replace(/_/g, ' ')}
            </span>
          )}
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      </div>

      {/* Responsive overrides */}
      <style>{`
        @media (max-width: 1024px) {
          .profile-header-main { flex-direction: column !important; align-items: stretch !important; gap: 24px !important; }
          .profile-value-block { gap: 18px !important; }
          .profile-avatar-wrap { width: 64px !important; height: 64px !important; }
          .profile-balance-text { font-size: 32px !important; }
          .profile-actions-row { display: flex !important; gap: 10px !important; margin-top: 16px !important; }
          .profile-action-btn { flex: 1 !important; height: 44px !important; border-radius: 12px !important; background: var(--surface) !important; border: 1px solid var(--border) !important; display: flex !important; align-items: center; justify-content: center; color: var(--text-primary) !important; }
          .profile-add-wallet-btn { width: 100% !important; margin-top: 12px !important; height: 44px !important; background: var(--surface) !important; border: 1px solid var(--border) !important; border-radius: 12px !important; color: var(--text-primary) !important; font-weight: 600 !important; cursor: pointer; }
          .desktop-only-actions { display: none !important; }
          .profile-tabs-scroll { gap: 16px !important; padding: 0 !important; width: 100% !important; max-width: 100% !important; }
          .connect-wallet-section { padding: 40px 16px !important; }
          
          /* Main Layout Responsiveness */
          .dashboard-grid { grid-template-columns: 1fr !important; width: 100% !important; overflow-x: hidden; }
          .dashboard-left-col { padding: 24px 0 !important; border-right: none !important; width: 100% !important; overflow-x: hidden; }
          .dashboard-right-col { width: 100% !important; padding: 24px 0 !important; overflow-x: hidden; }
          .stats-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {/* Profile header */}
      <div style={{ padding: '32px 0 0', borderBottom: '1px solid var(--border)', width: '100%', maxWidth: '100%' }}>
        <div className="profile-header-main" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 20 }}>

          {/* Value block */}
          <div className="profile-value-block" style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
            <div className="profile-avatar-wrap" style={{ width: 52, height: 52, flexShrink: 0 }}>
              {address
                ? <WalletAvatar address={address} size={52} />
                : <div style={{ width: '100%', height: '100%', borderRadius: '50%', background: 'var(--surface)' }} />
              }
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <div style={{ fontSize: 14, color: 'var(--text-muted)', fontWeight: 500 }}>{address ? shortAddr : 'Not connected'}</div>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}><path d="m6 9 6 6 6-6"/></svg>
              </div>
              <div className="profile-balance-text" style={{ fontSize: 34, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-.03em', lineHeight: 1.2, fontVariantNumeric: 'tabular-nums', margin: '2px 0' }}>
                ${animTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              {displayTotal > 0 && entryUSD > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: pnlPct >= 0 ? '#22C55E' : '#EF4444' }}>
                    {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}% (${Math.abs(pnlUSD).toFixed(4)})
                  </span>
                  <div style={{ padding: '2px 6px', borderRadius: 6, background: 'var(--surface)', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, border: '1px solid var(--border)' }}>PnL</div>
                </div>
              )}
            </div>
          </div>

          {/* Mobile Actions */}
          <div className="profile-actions-row" style={{ display: 'none' }}>
             <button className="profile-action-btn"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg></button>
             <button className="profile-action-btn"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
             <button className="profile-add-wallet-btn" style={{ flex: 3 }}>Add wallet</button>
          </div>

          {/* Desktop Action buttons */}
          {address && (
            <div className="desktop-only-actions" style={{ display: 'flex', gap: 8, flexShrink: 0, marginTop: 4, flexWrap: 'wrap' }}>
              <button onClick={() => router.push('/onboard')} style={{
                height: 36, padding: '0 16px', borderRadius: 10, border: 'none',
                background: '#EA580C', color: '#fff',
                fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              }}>
                + Add funds
              </button>
              {positions.length > 0 && (
                <button onClick={() => router.push(`/app/strategy/${address}`)} style={{
                  height: 36, padding: '0 14px', borderRadius: 10, border: '1px solid var(--border)',
                  background: 'var(--surface)', color: 'var(--text-primary)',
                  fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
                }}>
                  {positions.length === 1 ? 'Strategy →' : `Strategies (${positions.length}) →`}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="profile-tabs-scroll" style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '0 4px', overflowX: 'auto' }}>
          {(['portfolio', 'activity'] as const).map(t => (
            <div key={t} onClick={() => setTab(t)} style={{
              paddingBottom: 12, borderBottom: tab === t ? '2px solid #EA580C' : '2px solid transparent',
              fontSize: 14, fontWeight: 600, color: tab === t ? 'var(--text-primary)' : 'var(--text-muted)',
              cursor: 'pointer', whiteSpace: 'nowrap', textTransform: 'capitalize'
            }}>
              {t}
            </div>
          ))}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 12, fontSize: 13, color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>
             <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#3B82F6' }}><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
             All Networks
             <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}><path d="m6 9 6 6 6-6"/></svg>
          </div>
        </div>
      </div>

      {/* ── No wallet ─────────────────────────────────────────────────────── */}
      {!address ? (
        <div className="connect-wallet-section" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 40, width: '100%' }}>
          <div style={{ fontSize: 44 }}>🔐</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>Connect your wallet</div>
          <div style={{ fontSize: 14, color: 'var(--text-muted)', textAlign: 'center', maxWidth: 340 }}>
            Connect to view your yield strategies and live portfolio performance.
          </div>
          {/* @ts-ignore */}
          <appkit-button size="md" />
        </div>

      /* ── Portfolio tab ─────────────────────────────────────────────────── */
      ) : tab === 'portfolio' ? (
        <div className="dashboard-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 340px', flex: 1, minHeight: 0 }}>

          {/* Left column */}
          <div className="dashboard-left-col" style={{ padding: '24px 24px 48px 0', borderRight: '1px solid var(--border)', overflowY: 'auto' }}>

            {/* Performance */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Performance</span>
                <div style={{ display: 'flex', gap: 2 }}>
                  {(['1W', '1M', 'All'] as const).map(r => (
                    <button key={r} onClick={() => setChartRange(r)} style={{
                      padding: '4px 10px', borderRadius: 8, cursor: 'pointer',
                      background: chartRange === r ? 'var(--surface)' : 'transparent',
                      color: chartRange === r ? 'var(--text-primary)' : 'var(--text-muted)',
                      fontSize: 12, fontWeight: chartRange === r ? 600 : 400,
                      border: chartRange === r ? '1px solid var(--border)' : '1px solid transparent',
                      fontFamily: 'inherit', transition: 'all 100ms',
                    }}>
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
                      {chartRange === '1W' ? 'Last 7 days' : chartRange === '1M' ? 'Last 30 days' : 'All time'}
                    </div>
                    <MiniChart data={chartData} height={110} />
                  </>
                ) : (
                  <div style={{ height: 130, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 6 }}>
                    <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Performance history builds up over time</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', opacity: 0.6 }}>Check back after the agent takes its first actions</div>
                  </div>
                )}
              </div>

              {/* Stat cards */}
              <div className="stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                {[
                  { label: 'Total value',  val: `$${displayTotal.toFixed(4)}`,                  sub: positions.length > 1 ? 'all strategies' : 'USDC', color: 'var(--text-primary)' },
                  { label: 'Yield earned', val: earned > 0 ? `+$${earned.toFixed(6)}` : '—',  sub: positions.length > 1 ? 'all strategies · since start' : 'since start', color: earned > 0 ? '#22C55E' : 'var(--text-muted)' },
                  { label: 'Current APY', val: currentAPY != null ? `${currentAPY.toFixed(1)}%` : '—', sub: positions.length > 1 ? 'weighted avg · net of IL' : 'net of IL', color: '#EA580C' },
                ].map(s => (
                  <div key={s.label} style={{ background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--border)', padding: '12px 14px' }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.05em' }}>{s.label}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: s.color, fontVariantNumeric: 'tabular-nums' }}>{s.val}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{s.sub}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Active Strategies */}
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>
                Active Strategies
                {positions.length > 0 && (
                  <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 500, color: 'var(--text-muted)' }}>
                    {positions.length} running
                  </span>
                )}
              </div>
              <div style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', overflow: 'hidden' }}>

                {/* Table header */}
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', padding: '9px 16px', borderBottom: '1px solid var(--border)' }}>
                  {['Strategy', 'Value', 'Status'].map(h => (
                    <div key={h} style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 500 }}>{h}</div>
                  ))}
                </div>

                {/* One row per position — supports multiple strategies */}
                {positions.map((pos: any, i: number) => {
                  const isLast = i === positions.length - 1 && available === 0
                  const venueName   = pos.venueName ?? ''
                  const protocolLogo = getProtocolLogo(venueName, pos.protocol ?? '')
                  const tokenPair   = parseTokenPair(venueName)
                  const displayName = tokenPair ? tokenPair.join(' / ') : cleanStrategyName(venueName)
                  const strategyType = pos.strategyType?.replace(/_/g, ' ').toLowerCase() ?? 'LP position'
                  const cleanProto  = (pos.protocol ?? venueName.split(' ')[0] ?? 'Protocol')
                    .replace(/\(LVR-screened\)/gi, '').trim()
                  return (
                    <div
                      key={pos.id ?? i}
                      onClick={() => router.push(`/app/strategy/${address}`)}
                      style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', padding: '13px 16px', borderBottom: isLast ? 'none' : '1px solid var(--border)', cursor: 'pointer', transition: 'background 100ms' }}
                      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(128,128,128,0.04)'}
                      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>

                        {/* Protocol icon + Arbitrum chain badge */}
                        <div style={{ position: 'relative', width: 32, height: 32, flexShrink: 0 }}>
                          {protocolLogo ? (
                            <img
                              src={protocolLogo} alt={cleanProto}
                              style={{ width: 32, height: 32, borderRadius: 8, objectFit: 'cover', background: 'rgba(40,160,240,0.12)' }}
                              onError={e => { (e.currentTarget as HTMLImageElement).replaceWith(Object.assign(document.createElement('div'), { textContent: '⬡', style: 'width:32px;height:32px;border-radius:8px;background:rgba(40,160,240,0.12);display:flex;align-items:center;justify-content:center;font-size:14px' })) }}
                            />
                          ) : (
                            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(40,160,240,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>⬡</div>
                          )}
                          {/* Arbitrum chain badge */}
                          <img
                            src={CHAIN_LOGO_ARB} alt="Arbitrum"
                            style={{ position: 'absolute', bottom: -3, right: -3, width: 14, height: 14, borderRadius: '50%', border: '1.5px solid var(--background)', objectFit: 'cover' }}
                          />
                        </div>

                        <div>
                          {/* Token pair logos + name */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            {tokenPair && (
                              <div style={{ position: 'relative', width: 26, height: 18, flexShrink: 0 }}>
                                {TOKEN_LOGOS[tokenPair[0]] && (
                                  <img src={TOKEN_LOGOS[tokenPair[0]]} alt={tokenPair[0]}
                                    style={{ width: 18, height: 18, borderRadius: '50%', position: 'absolute', left: 0, top: 0, border: '1.5px solid var(--background)', objectFit: 'cover' }}
                                  />
                                )}
                                {TOKEN_LOGOS[tokenPair[1]] && (
                                  <img src={TOKEN_LOGOS[tokenPair[1]]} alt={tokenPair[1]}
                                    style={{ width: 18, height: 18, borderRadius: '50%', position: 'absolute', left: 8, top: 0, border: '1.5px solid var(--background)', objectFit: 'cover' }}
                                  />
                                )}
                              </div>
                            )}
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{displayName}</span>
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                            {cleanProto} · {strategyType}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                        ${(pos.currentUSD ?? 0).toFixed(4)}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: '#22C55E', background: 'rgba(34,197,94,0.10)', borderRadius: 999, padding: '3px 8px' }}>Active</span>
                      </div>
                    </div>
                  )
                })}

                {/* Fallback: vault says capital is deployed but agent state not loaded yet */}
                {positions.length === 0 && working > 0 && (
                  <div
                    onClick={() => router.push(`/app/strategy/${address}`)}
                    style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', padding: '13px 16px', borderBottom: available > 0 ? '1px solid var(--border)' : 'none', cursor: 'pointer', transition: 'background 100ms' }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(128,128,128,0.04)'}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(40,160,240,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>⬡</div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Strategy</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>Arbitrum · loading…</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                      ${working.toFixed(4)}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#22C55E', background: 'rgba(34,197,94,0.10)', borderRadius: 999, padding: '3px 8px' }}>Active</span>
                    </div>
                  </div>
                )}

                {available > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', padding: '13px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(234,88,12,0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>◎</div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>USDC</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>Idle · ready to deploy</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                      ${available.toFixed(4)}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#F59E0B', background: 'rgba(245,158,11,0.10)', borderRadius: 999, padding: '3px 8px' }}>Idle</span>
                    </div>
                  </div>
                )}

                {positions.length === 0 && working === 0 && available === 0 && (
                  <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                    No strategies running.{' '}
                    <button onClick={() => router.push('/onboard')} style={{ color: '#EA580C', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit', fontSize: 13 }}>
                      Start a strategy →
                    </button>
                  </div>
                )}
              </div>

              {/* Policy guardrails */}
              {(minAPY > 0 || maxDD > 0) && (
                <div style={{ marginTop: 14, background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', padding: '14px 16px' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>Policy guardrails</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {[
                      { label: 'APY floor', val: `${minAPY.toFixed(1)}%`, pct: Math.min(100, (minAPY / 30) * 100), color: '#22C55E' },
                      { label: 'Max drawdown', val: `${maxDD.toFixed(1)}%`, pct: Math.min(100, (maxDD / 50) * 100), color: '#EF4444' },
                    ].map(g => (
                      <div key={g.label}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                          <span style={{ color: 'var(--text-muted)' }}>{g.label}</span>
                          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{g.val}</span>
                        </div>
                        <div style={{ height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${g.pct}%`, background: g.color, borderRadius: 2 }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right column — activity feed */}
          <div className="dashboard-right-col" style={{ width: 340, padding: '24px 0 24px 24px', overflowY: 'auto' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14 }}>Activity</div>
            {executions.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: '40px 0' }}>No agent actions yet</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {executions.slice(0, 20).map((ex: any, i: number) => {
                  const tag = agentUser?.policy?.displayName
                    ? agentUser.policy.displayName
                    : strategyTag(ex)
                  return (
                  <div key={i}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 10, cursor: 'pointer', transition: 'background 100ms' }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--surface)'}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                  >
                    <div style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, background: `${actionColor(ex.action)}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>
                      {actionEmoji(ex.action)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{actionLabel(ex.action)}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{ex.timestamp ? timeAgo(ex.timestamp) : ''}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3, flexWrap: 'wrap' }}>
                        {tag && (
                          <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: `${actionColor(ex.action)}18`, color: actionColor(ex.action), flexShrink: 0 }}>
                            {tag}
                          </span>
                        )}
                        {ex.amountUSD != null && (
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            ${Number(ex.amountUSD).toFixed(2)}
                          </span>
                        )}
                      </div>
                    </div>
                    {ex.amountUSD != null && (
                      <span style={{ fontSize: 12, fontWeight: 600, flexShrink: 0, color: ex.action === 'WITHDRAW' ? '#EF4444' : '#22C55E' }}>
                        {ex.action === 'WITHDRAW' ? '-' : '+'}${Number(ex.amountUSD).toFixed(2)}
                      </span>
                    )}
                  </div>
                  )
                })}
                <button
                  onClick={() => router.push(`/app/strategy/${address}`)}
                  style={{ marginTop: 8, width: '100%', padding: '9px', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  View all in {positions.length > 1 ? 'strategies' : 'strategy'} →
                </button>
              </div>
            )}
          </div>
        </div>

      /* ── Activity tab ─────────────────────────────────────────────────── */
      ) : (
        <div style={{ padding: '24px', maxWidth: 680 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14 }}>All agent actions</div>
          <div style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', overflow: 'hidden' }}>
            {executions.length === 0 ? (
              <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                No agent actions yet. Actions appear here after your strategy is deployed.
              </div>
            ) : executions.map((ex: any, i: number) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderBottom: i < executions.length - 1 ? '1px solid var(--border)' : 'none' }}>
                <div style={{ width: 38, height: 38, borderRadius: 10, flexShrink: 0, background: `${actionColor(ex.action)}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>
                  {actionEmoji(ex.action)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{actionLabel(ex.action)}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>{ex.timestamp ? timeAgo(ex.timestamp) : ''}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                    {strategyTag(ex) && (
                      <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 5, background: `${actionColor(ex.action)}18`, color: actionColor(ex.action) }}>
                        {strategyTag(ex)}
                      </span>
                    )}
                    {ex.amountUSD != null && (
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>${Number(ex.amountUSD).toFixed(2)}</span>
                    )}
                  </div>
                  {ex.txHash && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, fontFamily: 'monospace' }}>{ex.txHash.slice(0, 20)}…</div>
                  )}
                </div>
                {ex.amountUSD != null && (
                  <span style={{ fontSize: 14, fontWeight: 700, flexShrink: 0, color: ex.action === 'WITHDRAW' ? '#EF4444' : '#22C55E', fontVariantNumeric: 'tabular-nums' }}>
                    {ex.action === 'WITHDRAW' ? '-' : '+'}${Number(ex.amountUSD).toFixed(2)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
