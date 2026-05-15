'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { ChainChip } from '../../components/ui'
import { useHeader } from '../../components/HeaderContext'
import { AppHeader } from '../../components/AppHeader'

const TOKEN_LOGOS: Record<string, string> = {
  WETH:  'https://assets.coingecko.com/coins/images/2518/standard/weth.png',
  USDC:  'https://assets.coingecko.com/coins/images/6319/standard/usdc.png',
  ARB:   'https://assets.coingecko.com/coins/images/16547/standard/arb.jpg',
  WBTC:  'https://assets.coingecko.com/coins/images/7598/standard/wrapped_bitcoin_wbtc.png',
  USDT:  'https://assets.coingecko.com/coins/images/325/standard/Tether.png',
  eETH:  'https://assets.coingecko.com/coins/images/33033/standard/weETH.png',
  GLP:   'https://assets.coingecko.com/coins/images/26764/standard/GLP.png',
  wstETH:'https://assets.coingecko.com/coins/images/18834/standard/wstETH.png',
}

const PROTO_LOGOS: Record<string, string> = {
  'Uniswap V3': 'https://icons.llamao.fi/icons/protocols/uniswap?w=48&h=48',
  'Morpho':     'https://icons.llamao.fi/icons/protocols/morpho-blue?w=48&h=48',
  'Aave V3':    'https://icons.llamao.fi/icons/protocols/aave?w=48&h=48',
  'Pendle':     'https://icons.llamao.fi/icons/protocols/pendle?w=48&h=48',
  'GMX':        'https://icons.llamao.fi/icons/protocols/gmx?w=48&h=48',
  'Camelot':    'https://icons.llamao.fi/icons/protocols/camelot-dex?w=48&h=48',
  'Radiant V2': 'https://icons.llamao.fi/icons/protocols/radiant-v2?w=48&h=48',
  'Balancer':   'https://icons.llamao.fi/icons/protocols/balancer?w=48&h=48',
}

type StrategyType = 'DELTA_NEUTRAL' | 'MORPHO_LENDING' | 'AAVE_LENDING' | 'PENDLE_PT' | 'GMX_GLP'
type FilterTab = 'all' | 'lp' | 'lending' | 'fixed' | 'farm'
type SortKey = 'geckoScore' | 'realAPY' | 'tvlUSD' | 'ilCoverage'

interface Opp {
  id: string
  protocol: string
  pool: string
  tokens: string[]
  type: StrategyType
  geckoScore: number
  grossAPY: number
  realAPY: number
  emissionPct: number
  ilCoverage: number | null
  tvlUSD: number
  vol7d: number | null
  chain: string
  trend: 'up' | 'stable' | 'down'
  hist: number[]
  minTier: 'conservative' | 'balanced' | 'aggressive'
  agentActive?: boolean
}

const OPPS: Opp[] = [
  {
    id: '1', protocol: 'Uniswap V3', pool: 'WETH / USDC · 0.05%',
    tokens: ['WETH', 'USDC'], type: 'DELTA_NEUTRAL',
    geckoScore: 89.2, grossAPY: 61.4, realAPY: 54.2, emissionPct: 0,
    ilCoverage: 87, tvlUSD: 485_200_000, vol7d: 2_840_000_000,
    chain: 'arbitrum', trend: 'up', minTier: 'balanced', agentActive: true,
    hist: [42, 48, 51, 55, 53, 58, 54],
  },
  {
    id: '2', protocol: 'Morpho', pool: 'USDC Vault',
    tokens: ['USDC'], type: 'MORPHO_LENDING',
    geckoScore: 82.1, grossAPY: 11.8, realAPY: 11.8, emissionPct: 0,
    ilCoverage: null, tvlUSD: 892_400_000, vol7d: null,
    chain: 'arbitrum', trend: 'stable', minTier: 'conservative',
    hist: [10.2, 10.8, 11.1, 11.4, 11.6, 11.9, 11.8],
  },
  {
    id: '3', protocol: 'Aave V3', pool: 'WETH Supply',
    tokens: ['WETH'], type: 'AAVE_LENDING',
    geckoScore: 76.5, grossAPY: 8.9, realAPY: 8.4, emissionPct: 5.6,
    ilCoverage: null, tvlUSD: 1_240_000_000, vol7d: null,
    chain: 'arbitrum', trend: 'stable', minTier: 'conservative',
    hist: [7.8, 8.0, 8.2, 8.5, 8.3, 8.6, 8.4],
  },
  {
    id: '4', protocol: 'Pendle', pool: 'PT-eETH · Sep 2025',
    tokens: ['eETH'], type: 'PENDLE_PT',
    geckoScore: 71.3, grossAPY: 24.8, realAPY: 24.8, emissionPct: 0,
    ilCoverage: null, tvlUSD: 124_000_000, vol7d: null,
    chain: 'arbitrum', trend: 'down', minTier: 'balanced',
    hist: [26.2, 25.8, 25.4, 25.1, 24.9, 24.8, 24.8],
  },
  {
    id: '5', protocol: 'GMX', pool: 'GLP Pool',
    tokens: ['GLP'], type: 'GMX_GLP',
    geckoScore: 64.8, grossAPY: 22.4, realAPY: 18.7, emissionPct: 16.5,
    ilCoverage: 43, tvlUSD: 312_000_000, vol7d: 487_000_000,
    chain: 'arbitrum', trend: 'up', minTier: 'aggressive',
    hist: [14, 16, 17, 18, 19, 20, 18.7],
  },
  {
    id: '6', protocol: 'Camelot', pool: 'WETH / ARB',
    tokens: ['WETH', 'ARB'], type: 'DELTA_NEUTRAL',
    geckoScore: 61.2, grossAPY: 45.1, realAPY: 38.4, emissionPct: 14.8,
    ilCoverage: 62, tvlUSD: 48_200_000, vol7d: 134_000_000,
    chain: 'arbitrum', trend: 'up', minTier: 'aggressive',
    hist: [28, 33, 36, 38, 41, 44, 38.4],
  },
  {
    id: '7', protocol: 'Aave V3', pool: 'WBTC Supply',
    tokens: ['WBTC'], type: 'AAVE_LENDING',
    geckoScore: 59.4, grossAPY: 5.2, realAPY: 5.2, emissionPct: 0,
    ilCoverage: null, tvlUSD: 780_000_000, vol7d: null,
    chain: 'arbitrum', trend: 'stable', minTier: 'conservative',
    hist: [4.8, 4.9, 5.0, 5.1, 5.2, 5.2, 5.2],
  },
  {
    id: '8', protocol: 'Radiant V2', pool: 'USDC Lending',
    tokens: ['USDC'], type: 'AAVE_LENDING',
    geckoScore: 54.7, grossAPY: 12.4, realAPY: 7.8, emissionPct: 37.1,
    ilCoverage: null, tvlUSD: 156_000_000, vol7d: null,
    chain: 'arbitrum', trend: 'down', minTier: 'balanced',
    hist: [9.2, 8.8, 8.4, 8.1, 7.9, 7.8, 7.8],
  },
  {
    id: '9', protocol: 'Uniswap V3', pool: 'WBTC / USDC · 0.3%',
    tokens: ['WBTC', 'USDC'], type: 'DELTA_NEUTRAL',
    geckoScore: 52.3, grossAPY: 28.1, realAPY: 22.4, emissionPct: 0,
    ilCoverage: 58, tvlUSD: 89_000_000, vol7d: 210_000_000,
    chain: 'arbitrum', trend: 'stable', minTier: 'balanced',
    hist: [18, 20, 22, 23, 24, 23, 22.4],
  },
  {
    id: '10', protocol: 'Balancer', pool: 'wstETH / WETH',
    tokens: ['wstETH', 'WETH'], type: 'DELTA_NEUTRAL',
    geckoScore: 48.6, grossAPY: 14.3, realAPY: 12.8, emissionPct: 10.5,
    ilCoverage: 91, tvlUSD: 67_000_000, vol7d: 45_000_000,
    chain: 'arbitrum', trend: 'stable', minTier: 'balanced',
    hist: [12, 12.5, 13, 13.2, 13.4, 12.9, 12.8],
  },
]

function fmtTVL(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`
  return `$${(n / 1e3).toFixed(0)}K`
}

function fmtVol(n: number | null): string {
  if (!n) return '—'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  return `$${(n / 1e6).toFixed(0)}M`
}

function scoreColor(s: number): string {
  if (s >= 80) return '#16A34A'
  if (s >= 65) return '#EA580C'
  if (s >= 50) return '#D97706'
  return '#DC2626'
}

function Sparkline({ data, trend }: { data: number[]; trend: 'up' | 'stable' | 'down' }) {
  const w = 80, h = 32
  const min = Math.min(...data), max = Math.max(...data)
  const range = max - min || 1
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - ((v - min) / range) * (h - 6) - 3
    return [x, y]
  })
  const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const color = trend === 'up' ? '#16A34A' : trend === 'down' ? '#DC2626' : '#94A3B8'
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: 80, height: 32 }} preserveAspectRatio="none">
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function TokenStack({ tokens }: { tokens: string[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {tokens.map((t, i) => (
        <div key={t} style={{
          width: 24, height: 24, borderRadius: '50%', overflow: 'hidden',
          border: '2px solid var(--background)', marginLeft: i > 0 ? -8 : 0,
          background: '#F5F5F4', flexShrink: 0, zIndex: tokens.length - i,
        }}>
          <img src={TOKEN_LOGOS[t] ?? ''} alt={t} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
        </div>
      ))}
    </div>
  )
}

function StrategyBadge({ type }: { type: StrategyType }) {
  const map: Record<StrategyType, { label: string; color: string; bg: string }> = {
    DELTA_NEUTRAL:  { label: 'LP Pool',     color: '#EA580C', bg: 'rgba(234,88,12,0.1)' },
    MORPHO_LENDING: { label: 'Lending',     color: '#3B82F6', bg: 'rgba(59,130,246,0.1)' },
    AAVE_LENDING:   { label: 'Lending',     color: '#3B82F6', bg: 'rgba(59,130,246,0.1)' },
    PENDLE_PT:      { label: 'Fixed Yield', color: '#8B5CF6', bg: 'rgba(139,92,246,0.1)' },
    GMX_GLP:        { label: 'Yield Farm',  color: '#16A34A', bg: 'rgba(22,163,74,0.1)' },
  }
  const { label, color, bg } = map[type]
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color, background: bg, borderRadius: 6, padding: '2px 7px', whiteSpace: 'nowrap', letterSpacing: '.02em' }}>
      {label}
    </span>
  )
}

function ILBadge({ coverage }: { coverage: number | null }) {
  if (coverage === null) {
    return <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 7px' }}>No IL</span>
  }
  const color = coverage >= 80 ? '#16A34A' : coverage >= 60 ? '#D97706' : '#DC2626'
  const bg    = coverage >= 80 ? 'rgba(22,163,74,0.1)' : coverage >= 60 ? 'rgba(217,119,6,0.1)' : 'rgba(220,38,38,0.1)'
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color, background: bg, borderRadius: 6, padding: '2px 7px' }}>
      {coverage}% covered
    </span>
  )
}

function TierBadge({ tier }: { tier: string }) {
  const map: Record<string, { color: string }> = {
    conservative: { color: '#16A34A' },
    balanced:     { color: '#D97706' },
    aggressive:   { color: '#DC2626' },
  }
  return (
    <span style={{ fontSize: 10, color: map[tier]?.color ?? '#94A3B8', fontWeight: 600 }}>
      {tier.charAt(0).toUpperCase() + tier.slice(1)}
    </span>
  )
}

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'all',     label: 'All Strategies' },
  { key: 'lp',      label: 'LP Pools' },
  { key: 'lending', label: 'Lending' },
  { key: 'fixed',   label: 'Fixed Yield' },
  { key: 'farm',    label: 'Yield Farms' },
]

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'geckoScore', label: 'GeckoScore' },
  { key: 'realAPY',    label: 'Real APY' },
  { key: 'tvlUSD',     label: 'TVL' },
]

export default function ExplorePage() {
  const router = useRouter()
  const header = useMemo(() => <AppHeader />, [])
  useHeader(header)
  const [filter, setFilter] = useState<FilterTab>('all')
  const [sort, setSort]     = useState<SortKey>('geckoScore')
  const [search, setSearch] = useState('')

  const displayed = useMemo(() => {
    let list = OPPS
    if (filter === 'lp')      list = list.filter(o => o.type === 'DELTA_NEUTRAL')
    if (filter === 'lending')  list = list.filter(o => o.type === 'MORPHO_LENDING' || o.type === 'AAVE_LENDING')
    if (filter === 'fixed')    list = list.filter(o => o.type === 'PENDLE_PT')
    if (filter === 'farm')     list = list.filter(o => o.type === 'GMX_GLP')
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(o => o.protocol.toLowerCase().includes(q) || o.pool.toLowerCase().includes(q) || o.tokens.some(t => t.toLowerCase().includes(q)))
    }
    return [...list].sort((a, b) => {
      if (sort === 'geckoScore') return b.geckoScore - a.geckoScore
      if (sort === 'realAPY')    return b.realAPY - a.realAPY
      if (sort === 'tvlUSD')     return b.tvlUSD - a.tvlUSD
      if (sort === 'ilCoverage') return (b.ilCoverage ?? -1) - (a.ilCoverage ?? -1)
      return 0
    })
  }, [filter, sort, search])

  const totalTVL = OPPS.reduce((s, o) => s + o.tvlUSD, 0)
  const avgScore = (OPPS.reduce((s, o) => s + o.geckoScore, 0) / OPPS.length).toFixed(1)

  return (
    <div style={{ minHeight: '100vh', background: 'var(--background)', paddingBottom: 80 }}>

      <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', padding: '28px 28px 0' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>

          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 16 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-.02em' }}>Yield Intelligence Board</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#EA580C', background: 'rgba(234,88,12,0.1)', border: '1px solid rgba(234,88,12,0.2)', borderRadius: 20, padding: '2px 10px' }}>LIVE</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{OPPS.length}</span> opportunities scored
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{fmtTVL(totalTVL)}</span> TVL tracked
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  Avg GeckoScore <span style={{ fontWeight: 700, color: '#EA580C' }}>{avgScore}</span>
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#16A34A', display: 'inline-block', animation: 'pulse 2s infinite' }} />
                  Updated 3m ago · Arbitrum One
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ position: 'relative' }}>
                <input
                  value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search protocol or token…"
                  style={{
                    height: 38, borderRadius: 10, border: '1px solid var(--border)',
                    background: 'var(--background)', color: 'var(--text-primary)',
                    padding: '0 36px 0 14px', fontSize: 13, outline: 'none', width: 220,
                  }}
                />
                <svg style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', opacity: 0.4 }} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>
              </div>
              <select
                value={sort} onChange={e => setSort(e.target.value as SortKey)}
                style={{ height: 38, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--text-primary)', padding: '0 12px', fontSize: 13, cursor: 'pointer' }}
              >
                {SORT_OPTIONS.map(o => <option key={o.key} value={o.key}>Sort: {o.label}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 4 }}>
            {FILTER_TABS.map(tab => (
              <button key={tab.key} onClick={() => setFilter(tab.key)} style={{
                height: 36, padding: '0 16px', borderRadius: '10px 10px 0 0', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                background: filter === tab.key ? 'var(--background)' : 'transparent',
                color: filter === tab.key ? '#EA580C' : 'var(--text-secondary)',
                borderBottom: filter === tab.key ? '2px solid #EA580C' : '2px solid transparent',
                transition: 'all 120ms',
              }}>
                {tab.label}
                {tab.key !== 'all' && (
                  <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: 'var(--text-muted)' }}>
                    {tab.key === 'lp' ? OPPS.filter(o => o.type === 'DELTA_NEUTRAL').length
                     : tab.key === 'lending' ? OPPS.filter(o => o.type.includes('LENDING')).length
                     : tab.key === 'fixed' ? OPPS.filter(o => o.type === 'PENDLE_PT').length
                     : OPPS.filter(o => o.type === 'GMX_GLP').length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 28px' }}>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['#', 'Protocol / Pool', 'Tokens', 'Strategy', 'GeckoScore', 'Real APY', 'Gross APY', 'IL Coverage', 'TVL', '7d Vol', '7d Trend', ''].map((h, i) => (
                  <th key={i} style={{
                    padding: '14px 12px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)',
                    textAlign: i === 0 ? 'center' : i >= 10 ? 'right' : 'left',
                    whiteSpace: 'nowrap', letterSpacing: '.04em', textTransform: 'uppercase',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map((opp, idx) => (
                <tr key={opp.id} style={{
                  borderBottom: '1px solid var(--border)',
                  transition: 'background 100ms',
                  cursor: 'pointer',
                }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  onClick={() => router.push('/app/create')}
                >
                  <td style={{ padding: '16px 12px', textAlign: 'center', fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', width: 32 }}>{idx + 1}</td>

                  <td style={{ padding: '16px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 10, overflow: 'hidden', flexShrink: 0, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                        <img src={PROTO_LOGOS[opp.protocol]} alt={opp.protocol} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      </div>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{opp.protocol}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{opp.pool}</div>
                      </div>
                      {opp.agentActive && (
                        <span style={{ fontSize: 9, fontWeight: 800, color: '#16A34A', background: 'rgba(22,163,74,0.1)', borderRadius: 6, padding: '2px 6px', marginLeft: 2, letterSpacing: '.04em' }}>ACTIVE</span>
                      )}
                    </div>
                  </td>

                  <td style={{ padding: '16px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <TokenStack tokens={opp.tokens} />
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>{opp.tokens.join('/')}</span>
                    </div>
                  </td>

                  <td style={{ padding: '16px 12px' }}><StrategyBadge type={opp.type} /></td>

                  <td style={{ padding: '16px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 48, height: 5, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${opp.geckoScore}%`, background: scoreColor(opp.geckoScore), borderRadius: 3, transition: 'width 400ms' }} />
                      </div>
                      <span style={{ fontSize: 14, fontWeight: 800, color: scoreColor(opp.geckoScore) }}>{opp.geckoScore.toFixed(1)}</span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}><TierBadge tier={opp.minTier} /> min</div>
                  </td>

                  <td style={{ padding: '16px 12px' }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: '#16A34A' }}>{opp.realAPY.toFixed(1)}%</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>emission-free</div>
                  </td>

                  <td style={{ padding: '16px 12px' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{opp.grossAPY.toFixed(1)}%</div>
                    {opp.emissionPct > 0 && (
                      <div style={{ fontSize: 10, color: '#D97706' }}>{opp.emissionPct.toFixed(1)}% emissions</div>
                    )}
                  </td>

                  <td style={{ padding: '16px 12px' }}><ILBadge coverage={opp.ilCoverage} /></td>

                  <td style={{ padding: '16px 12px' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{fmtTVL(opp.tvlUSD)}</div>
                  </td>

                  <td style={{ padding: '16px 12px' }}>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{fmtVol(opp.vol7d)}</div>
                  </td>

                  <td style={{ padding: '16px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Sparkline data={opp.hist} trend={opp.trend} />
                      <span style={{ fontSize: 11, color: opp.trend === 'up' ? '#16A34A' : opp.trend === 'down' ? '#DC2626' : 'var(--text-muted)' }}>
                        {opp.trend === 'up' ? '↑' : opp.trend === 'down' ? '↓' : '→'}
                      </span>
                    </div>
                  </td>

                  <td style={{ padding: '16px 12px', textAlign: 'right' }}>
                    <button
                      onClick={e => { e.stopPropagation(); router.push('/app/create') }}
                      style={{
                        height: 32, padding: '0 14px', borderRadius: 8, border: '1px solid var(--border)',
                        background: opp.agentActive ? 'rgba(22,163,74,0.1)' : 'transparent',
                        color: opp.agentActive ? '#16A34A' : '#EA580C', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {opp.agentActive ? 'In Portfolio' : 'Deploy →'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {displayed.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🦎</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>No opportunities match your filter</div>
          </div>
        )}

        <div style={{
          marginTop: 24, padding: '16px 20px', borderRadius: 14,
          background: 'linear-gradient(135deg, rgba(234,88,12,0.06), rgba(234,88,12,0.02))',
          border: '1px solid rgba(234,88,12,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Ready to let the agent work for you?</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              Every allocation decision is made inside Intel TDX · TEE-verified · Proof anchored on 0G Chain
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}>
              <img src="https://assets.coingecko.com/asset_platforms/images/184/standard/0g.png" alt="0G" style={{ width: 14, height: 14, borderRadius: '50%' }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>0G Compute</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}>
              <img src="https://assets.coingecko.com/coins/images/16547/standard/arb.jpg" alt="Arbitrum" style={{ width: 14, height: 14, borderRadius: '50%' }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>Arbitrum One</span>
            </div>
            <button
              onClick={() => router.push('/app/create')}
              style={{ height: 36, padding: '0 20px', borderRadius: 10, border: 'none', background: '#EA580C', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
            >
              Create Agent →
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        tr:hover td { background: inherit; }
      `}</style>
    </div>
  )
}
