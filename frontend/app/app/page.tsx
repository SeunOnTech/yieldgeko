'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useReadContract } from 'wagmi'
import { useAppKit } from '@reown/appkit/react'
import { formatUnits, parseAbi } from 'viem'
import { VAULT_ADDRESS, USDC_ADDRESS } from '@/config'
import { yieldGekoAbi } from '@/src/generated'
import { WalletAvatar } from '../components/WalletAvatar'
import GlobalLoading from '../components/GlobalLoading'
import { useHeader } from '../components/HeaderContext'
import { AppHeader } from '../components/AppHeader'

const AGENT_BASE = (process.env.NEXT_PUBLIC_AGENT_SSE_URL ?? 'http://localhost:3001/events').replace('/events', '')

function BrainIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      
      <path d="M12 4c-3.5 0-4.5 2-4.5 2s-2.5-1-4 1-1 4.5 0 5c-1 1-1 3 0 4.5 0 0 .5 3.5 4.5 3.5.5 2.5 2.5 2 2.5 2s1.5-1 2.5-1 1 1 2.5 1 2-1 2.5-2c4 0 4.5-3.5 4.5-3.5 1-1.5 1-3.5 0-4.5 1-.5 1.5-3 0-5-1.5-2-4-1-4-1s-1-2-4.5-2Z" />
      
      <circle cx="9" cy="9" r="1" fill="currentColor" />
      <circle cx="15" cy="8" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="16" cy="14" r="1" fill="currentColor" />
      <circle cx="8" cy="15" r="1" fill="currentColor" />
      
      <path d="M4.5 11.5l2-1h2.5" />
      <path d="M11.5 4.5v2l1 2.5" />
      <path d="M19.5 10.5l-2.5 1-2 3.5" />
      <path d="M13.5 18.5l-1.5-2-4-1.5" />
    </svg>
  )
}

async function fetchDashboard(address: string): Promise<any | null> {
  try {
    const res = await fetch(`${AGENT_BASE}/api/dashboard/${address}`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

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

const PROTOCOL_LOGOS: Record<string, string> = {
  
  uniswap: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984/logo.png',
  
  aave: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9/logo.png',
  
  morpho: 'https://avatars.githubusercontent.com/u/97085409?s=64&v=4',
  
  pendle: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/assets/0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8/logo.png',
  
  gmx: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/assets/0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a/logo.png',
}

const TOKEN_LOGOS: Record<string, string> = {
  WETH: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png',
  USDC: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png',
  USDT: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png',
  WBTC: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png',
  ARB: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/assets/0x912CE59144191C1204E64559FE8253a0e49E6548/logo.png',
  DAI: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png',
  PENDLE: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/assets/0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8/logo.png',
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
  const normalized = venueName.replace(/USD[₮Ꞇ]0?/g, 'USDT')
  const m = normalized.match(/\b([A-Z]{2,6})-([A-Z]{2,6})\b/)
  return m ? [m[1], m[2]] : null
}

function cleanStrategyName(venueName: string): string {
  return venueName
    .replace(/\(LVR-screened\)/gi, '')
    .replace(/USD[₮Ꞇ]0?/g, 'USDT')   
    .replace(/\s+/g, ' ')
    .trim()
}

function strategyTag(ex: any): string {
  const label = (raw: string | null) => {
    if (!raw) return ''
    const clean = cleanStrategyName(raw)
    const pair = parseTokenPair(clean)
    
    const proto = clean.split(' ').find(w => w.length > 2 && !['V2', 'V3', 'LP', 'PT', 'YT'].includes(w)) ?? ''
    if (pair) return proto ? `${proto} · ${pair[0]}/${pair[1]}` : `${pair[0]}/${pair[1]}`
    return clean.split(' ').slice(0, 3).join(' ')
  }
  const to = label(ex.to)
  const from = label(ex.from)
  if (from && to && from !== to) return `${from} → ${to}`
  return to || from
}

const IcoBot = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <rect x="2" y="5" width="12" height="8" rx="2" fillOpacity=".12" stroke="currentColor" strokeWidth="1.2" fill="none" />
    <circle cx="5.5" cy="9" r="1.2" /><circle cx="10.5" cy="9" r="1.2" />
    <path d="M8 2v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <circle cx="8" cy="2" r="1" />
  </svg>
)

export default function AppPage() {
  const router = useRouter()
  const { address } = useAccount()
  const { open } = useAppKit()
  const [agentUser, setAgentUser] = useState<any>(null)
  const [tab, setTab] = useState<'portfolio' | 'activity'>('portfolio')
  const [chartRange, setChartRange] = useState<'1W' | '1M' | 'All'>('1M')
  const [isMounted, setIsMounted] = useState(false)

  useEffect(() => {
    setIsMounted(true)
  }, [])

  
  useEffect(() => {
    if (isMounted && !address) {
      router.push('/app/connect')
    }
  }, [isMounted, address, router])

  const smartAccountAddress = agentUser?.policy?.smartAccountAddress as `0x${string}` | undefined

  
  const { data: usdcBalanceRaw } = useReadContract({
    address: USDC_ADDRESS,
    abi: parseAbi(['function balanceOf(address) external view returns (uint256)']),
    functionName: 'balanceOf',
    args: [smartAccountAddress || address || '0x0000000000000000000000000000000000000000'],
    query: { enabled: Boolean(address), refetchInterval: 30_000 },
  })

  
  const available = usdcBalanceRaw !== undefined ? Number(formatUnits(usdcBalanceRaw as bigint, 6)) : 0
  
  
  const metrics = agentUser?.portfolio?.metrics
  const working = (metrics?.totalValueUSD as number | undefined) ?? 0
  
  const totalValue = available + working

  
  const minAPY = agentUser?.policy?.minAPY ?? 0
  const maxDD = agentUser?.policy?.maxDrawdownPct ?? (agentUser?.policy?.maxDrawdownBps ? agentUser.policy.maxDrawdownBps / 100 : 0)

  useEffect(() => {
    if (!address) return
    fetchDashboard(address).then(setAgentUser)
    const id = setInterval(() => fetchDashboard(address).then(setAgentUser), 30_000)
    return () => clearInterval(id)
  }, [address])

  const earned = (metrics?.incomeEarnedUSD as number | undefined) ?? 0
  const currentAPY = (metrics?.weightedNetAPY as number | undefined) ?? null
  const phase = (agentUser?.phase as string | undefined) ?? 'IDLE'
  const executions: any[] = agentUser?.executions ?? []
  const positions: any[] = agentUser?.portfolio?.positions ?? []
  const pnlHistory: any[] = agentUser?.pnlHistory ?? []

  const isRunning = ['ALLOCATED', 'MONITORING', 'SCANNING', 'MIGRATING'].includes(phase)

  
  
  
  const agentTotalUSD = (metrics?.totalValueUSD as number | undefined) ?? null
  const entryFallback = (isRunning && (metrics?.totalEntryUSD ?? 0) > 0)
    ? (metrics?.totalEntryUSD as number)
    : null
  
  
  const displayTotal = agentUser
    ? ((agentTotalUSD !== null && agentTotalUSD > 0)
        ? agentTotalUSD
        : (entryFallback ?? 0))
    : 0
  const entryUSD = metrics?.totalEntryUSD ?? displayTotal
  
  const pnlUSD = displayTotal > 0 ? (displayTotal - entryUSD) + earned : 0
  const pnlPct = entryUSD > 0 ? (pnlUSD / entryUSD) * 100 : 0

  const trueTotal = displayTotal + earned   
  const animTotal = useCountUp(address ? trueTotal : 0)
  const shortAddr = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : ''

  const chartData = useMemo(() => {
    const lens: Record<string, number> = { '1W': 7, '1M': 30, 'All': 999 }
    const hist = pnlHistory.slice(-lens[chartRange])
    
    if (hist.length >= 2 && hist.some((p: any) => (p.totalUSD ?? 0) > 0))
      return hist.map((p: any) => p.totalUSD ?? 0)
    if (displayTotal > 0) return Array(8).fill(displayTotal)
    return []
  }, [chartRange, pnlHistory, displayTotal])

  const header = useMemo(() => <AppHeader />, [])
  useHeader(header)

  
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <GlobalLoading show={false} />

      
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

      {(!isMounted || !address) ? (
        <div className="connect-wallet-hero" style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: 16, padding: 40, width: '100%',
          background: 'var(--background)'
        }}>
          <div style={{
            width: 88, height: 88, borderRadius: '50%', background: 'var(--primary-light)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)',
            marginBottom: 8
          }}>
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.03em', margin: 0 }}>Connect your wallet</h1>
          <p style={{ fontSize: 16, color: 'var(--text-secondary)', textAlign: 'center', maxWidth: 380, lineHeight: 1.5, margin: 0 }}>
            Connect to view your yield strategies and live portfolio performance.
          </p>

          <button
            onClick={() => open()}
            style={{
              marginTop: 12,
              padding: '12px 32px',
              background: 'var(--primary)',
              color: '#fff',
              border: 'none',
              borderRadius: 12,
              fontSize: 16,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
              boxShadow: '0 4px 12px var(--primary-glow)',
              transition: 'transform 150ms ease, opacity 150ms ease'
            }}
            onMouseEnter={e => { e.currentTarget.style.opacity = '0.9'; e.currentTarget.style.transform = 'translateY(-1px)' }}
            onMouseLeave={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.transform = 'translateY(0)' }}
          >
            Connect Wallet
          </button>
        </div>
      ) : (
        <>
          
          <div style={{ padding: '32px 0 0', borderBottom: '1px solid var(--border)', width: '100%' }}>
            <div className="profile-header-main" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 20 }}>
              
              
              <div className="profile-value-block" style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                <div className="profile-avatar-wrap" style={{ width: 52, height: 52, flexShrink: 0 }}>
                  <WalletAvatar address={address} size={52} />
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                    <div style={{ fontSize: 14, color: 'var(--text-muted)', fontWeight: 500 }}>{shortAddr}</div>
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

              
              <div className="desktop-only-actions" style={{ display: 'flex', gap: 8, flexShrink: 0, marginTop: 4, flexWrap: 'wrap' }}>
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
                {positions.length > 0 && (
                  <button onClick={() => {
                    if (positions.length === 1 && positions[0]?.userId) {
                      router.push(`/app/strategy/${positions[0].userId}`)
                      return
                    }
                    router.push('/app')
                  }} style={{
                    height: 36, padding: '0 14px', borderRadius: 10, border: '1px solid var(--border)',
                    background: 'var(--surface)', color: 'var(--text-primary)',
                    fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
                  }}>
                    {positions.length === 1 ? 'Agent →' : `Agents (${positions.length}) →`}
                  </button>
                )}
              </div>
            </div>

            
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

          {tab === 'portfolio' ? (
            <div className="dashboard-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 340px', flex: 1, minHeight: 0 }}>
              <div className="dashboard-left-col" style={{ padding: '24px 24px 48px 0', borderRight: '1px solid var(--border)', overflowY: 'auto' }}>
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

              
              <div className="stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                {[
                  { label: 'Total value', val: `$${(displayTotal + earned).toFixed(4)}`, sub: positions.length > 1 ? 'all agents' : 'USDC', color: 'var(--text-primary)' },
                  { label: 'Yield earned', val: earned > 0 ? `+$${earned.toFixed(6)}` : '—', sub: positions.length > 1 ? 'all agents · since start' : 'since start', color: earned > 0 ? '#22C55E' : 'var(--text-muted)' },
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

            
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>
                Active Agents
                {positions.length > 0 && (
                  <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 500, color: 'var(--text-muted)' }}>
                    {positions.length} running
                  </span>
                )}
              </div>
              <div style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', overflow: 'hidden' }}>

                
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', padding: '9px 16px', borderBottom: '1px solid var(--border)' }}>
                  {['Agent', 'Value', 'Status'].map(h => (
                    <div key={h} style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 500 }}>{h}</div>
                  ))}
                </div>

                
                {positions.map((pos: any, i: number) => {
                  const isLast = i === positions.length - 1
                  const venueName = pos.venueName ?? ''
                  const venueNameClean = cleanStrategyName(venueName)
                  const protocolLogo = getProtocolLogo(venueName, pos.protocol ?? '')
                  const tokenPair = parseTokenPair(venueNameClean)
                  const displayName = tokenPair ? tokenPair.join(' / ') : venueNameClean
                  const strategyType = pos.strategyType?.replace(/_/g, ' ').toLowerCase() ?? 'LP position'
                  const cleanProto = (pos.protocol ?? venueName.split(' ')[0] ?? 'Protocol')
                    .replace(/\(LVR-screened\)/gi, '').trim()
                  return (
                    <div
                      key={pos.id ?? i}
                      onClick={() => {
                        if (pos.userId) router.push(`/app/strategy/${pos.userId}`)
                      }}
                      style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', padding: '13px 16px', borderBottom: isLast ? 'none' : '1px solid var(--border)', cursor: 'pointer', transition: 'background 100ms' }}
                      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(128,128,128,0.04)'}
                      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>

                        
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
                          
                          <img
                            src={CHAIN_LOGO_ARB} alt="Arbitrum"
                            style={{ position: 'absolute', bottom: -3, right: -3, width: 14, height: 14, borderRadius: '50%', border: '1.5px solid var(--background)', objectFit: 'cover' }}
                          />
                        </div>

                        <div>
                          
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
                        ${(((pos.currentUSD > 0 ? pos.currentUSD : null) ?? pos.allocationUSD ?? pos.entryUSD ?? 0) + (pos.incomeEarnedUSD ?? 0)).toFixed(4)}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: '#22C55E', background: 'rgba(34,197,94,0.10)', borderRadius: 999, padding: '3px 8px' }}>Active</span>
                      </div>
                    </div>
                  )
                })}

                
                {positions.length === 0 && working > 0 && (
                  <div
                    onClick={() => {
                      if (agentUser?.userId) router.push(`/app/strategy/${agentUser.userId}`)
                    }}
                    style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', padding: '13px 16px', borderBottom: available > 0 ? '1px solid var(--border)' : 'none', cursor: 'pointer', transition: 'background 100ms' }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(128,128,128,0.04)'}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(40,160,240,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>⬡</div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Agent</div>
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

                {positions.length === 0 && working === 0 && (
                  <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                    No agents running.{' '}
                    <button onClick={() => router.push('/app/create')} style={{ color: '#EA580C', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit', fontSize: 13 }}>
                      Start an agent →
                    </button>
                  </div>
                )}
              </div>

              
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
                  onClick={() => {
                    if (positions.length > 1) {
                      router.push('/app')
                      return
                    }
                    const targetStrategyId = positions[0]?.userId || agentUser?.userId
                    if (targetStrategyId) router.push(`/app/strategy/${targetStrategyId}`)
                  }}
                  style={{ marginTop: 8, width: '100%', padding: '9px', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  View all in {positions.length > 1 ? 'strategies' : 'strategy'} →
                </button>
              </div>
            )}
          </div>
        </div>

        
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
    </>
  )}
</div>
  )
}
