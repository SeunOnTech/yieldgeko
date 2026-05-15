'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { ChainChip } from '../../components/ui'
import { useHeader } from '../../components/HeaderContext'
import { AppHeader } from '../../components/AppHeader'

const PROTO_LOGOS: Record<string, string> = {
  'Uniswap V3': 'https://icons.llamao.fi/icons/protocols/uniswap?w=48&h=48',
  'Morpho':     'https://icons.llamao.fi/icons/protocols/morpho-blue?w=48&h=48',
  'Aave V3':    'https://icons.llamao.fi/icons/protocols/aave?w=48&h=48',
  'Pendle':     'https://icons.llamao.fi/icons/protocols/pendle?w=48&h=48',
  'Camelot':    'https://icons.llamao.fi/icons/protocols/camelot-dex?w=48&h=48',
}

const TOKEN_LOGOS: Record<string, string> = {
  WETH:  'https://assets.coingecko.com/coins/images/2518/standard/weth.png',
  USDC:  'https://assets.coingecko.com/coins/images/6319/standard/usdc.png',
  ARB:   'https://assets.coingecko.com/coins/images/16547/standard/arb.jpg',
  eETH:  'https://assets.coingecko.com/coins/images/33033/standard/weETH.png',
}

interface HarvestRecord {
  id: string
  date: string
  ts: number
  protocol: string
  pool: string
  tokens: string[]
  amountUSD: number
  action: 'HARVEST' | 'REBALANCE' | 'GENESIS'
  txHash: string
  proofHash: string
  apyAtHarvest: number
}

const HARVESTS: HarvestRecord[] = [
  { id: 'h1',  date: 'May 14, 2025', ts: 1747180800, protocol: 'Uniswap V3', pool: 'WETH/USDC 0.05%', tokens: ['WETH','USDC'], amountUSD: 43.18,  action: 'HARVEST',   txHash: '0x4a2f...d93c', proofHash: '0x9a1b...c12d', apyAtHarvest: 54.2 },
  { id: 'h2',  date: 'May 12, 2025', ts: 1747008000, protocol: 'Uniswap V3', pool: 'WETH/USDC 0.05%', tokens: ['WETH','USDC'], amountUSD: 38.72,  action: 'HARVEST',   txHash: '0x7b1c...f44a', proofHash: '0xdf3e...e59e', apyAtHarvest: 52.8 },
  { id: 'h3',  date: 'May 10, 2025', ts: 1746835200, protocol: 'Morpho',     pool: 'USDC Vault',       tokens: ['USDC'],        amountUSD: 41.05,  action: 'REBALANCE', txHash: '0x2e8d...a01b', proofHash: '0x3c7f...f9a1', apyAtHarvest: 11.8 },
  { id: 'h4',  date: 'May 8, 2025',  ts: 1746662400, protocol: 'Uniswap V3', pool: 'WETH/USDC 0.05%', tokens: ['WETH','USDC'], amountUSD: 52.34,  action: 'HARVEST',   txHash: '0x9f3b...c82e', proofHash: '0x88c4...a4b2', apyAtHarvest: 61.4 },
  { id: 'h5',  date: 'May 5, 2025',  ts: 1746403200, protocol: 'Aave V3',    pool: 'WETH Supply',      tokens: ['WETH'],        amountUSD: 35.90,  action: 'HARVEST',   txHash: '0x1d4e...701c', proofHash: '0xb2d9...71e3', apyAtHarvest: 8.4  },
  { id: 'h6',  date: 'May 3, 2025',  ts: 1746230400, protocol: 'Uniswap V3', pool: 'WETH/USDC 0.05%', tokens: ['WETH','USDC'], amountUSD: 47.82,  action: 'HARVEST',   txHash: '0x8c2a...5f90', proofHash: '0x61f2...d7b8', apyAtHarvest: 58.1 },
  { id: 'h7',  date: 'Apr 30, 2025', ts: 1745971200, protocol: 'Pendle',     pool: 'PT-eETH Sep 2025', tokens: ['eETH'],        amountUSD: 44.18,  action: 'REBALANCE', txHash: '0x3a7f...9d12', proofHash: '0xf4a1...c3e9', apyAtHarvest: 24.8 },
  { id: 'h8',  date: 'Apr 28, 2025', ts: 1745798400, protocol: 'Uniswap V3', pool: 'WETH/USDC 0.05%', tokens: ['WETH','USDC'], amountUSD: 38.45,  action: 'HARVEST',   txHash: '0x6e9b...4c77', proofHash: '0x29b3...80f6', apyAtHarvest: 51.7 },
  { id: 'h9',  date: 'Apr 25, 2025', ts: 1745539200, protocol: 'Morpho',     pool: 'USDC Vault',       tokens: ['USDC'],        amountUSD: 36.22,  action: 'HARVEST',   txHash: '0x5d1c...e2b4', proofHash: '0xc8e5...12a7', apyAtHarvest: 11.6 },
  { id: 'h10', date: 'Apr 22, 2025', ts: 1745280000, protocol: 'Uniswap V3', pool: 'WETH/USDC 0.05%', tokens: ['WETH','USDC'], amountUSD: 52.80,  action: 'HARVEST',   txHash: '0x2b8e...f301', proofHash: '0x74d6...5c1b', apyAtHarvest: 62.3 },
  { id: 'h11', date: 'Apr 18, 2025', ts: 1744934400, protocol: 'Aave V3',    pool: 'WETH Supply',      tokens: ['WETH'],        amountUSD: 29.14,  action: 'HARVEST',   txHash: '0x9a3d...c04f', proofHash: '0x40b8...e92c', apyAtHarvest: 8.1  },
  { id: 'h12', date: 'Apr 14, 2025', ts: 1744588800, protocol: 'Uniswap V3', pool: 'WETH/USDC 0.05%', tokens: ['WETH','USDC'], amountUSD: 61.22,  action: 'HARVEST',   txHash: '0x7f2a...1b9d', proofHash: '0xd3c7...4e81', apyAtHarvest: 67.4 },
  { id: 'h13', date: 'Apr 10, 2025', ts: 1744243200, protocol: 'Pendle',     pool: 'PT-eETH Sep 2025', tokens: ['eETH'],        amountUSD: 31.80,  action: 'REBALANCE', txHash: '0x4c6b...8a23', proofHash: '0x92f4...7d50', apyAtHarvest: 25.3 },
  { id: 'h14', date: 'Apr 7, 2025',  ts: 1743984000, protocol: 'Uniswap V3', pool: 'WETH/USDC 0.05%', tokens: ['WETH','USDC'], amountUSD: 48.90,  action: 'HARVEST',   txHash: '0x1e5f...3c80', proofHash: '0x56a9...b31e', apyAtHarvest: 55.9 },
  { id: 'h15', date: 'Apr 3, 2025',  ts: 1743638400, protocol: 'Morpho',     pool: 'USDC Vault',       tokens: ['USDC'],        amountUSD: 22.18,  action: 'GENESIS',   txHash: '0x8b4d...7e12', proofHash: '0xe1b2...9f3a', apyAtHarvest: 10.9 },
]

const TOTAL_EARNED = HARVESTS.reduce((s, h) => s + h.amountUSD, 0)
const THIS_MONTH   = HARVESTS.filter(h => h.ts >= 1746057600).reduce((s, h) => s + h.amountUSD, 0)
const LAST_HARVEST = HARVESTS[0]

const PROTOCOL_BREAKDOWN = [
  { protocol: 'Uniswap V3', pct: 58, earned: 383.43, color: '#FF007A' },
  { protocol: 'Morpho',     pct: 16, earned: 99.45,  color: '#2470FF' },
  { protocol: 'Pendle',     pct: 14, earned: 75.98,  color: '#4AECB8' },
  { protocol: 'Aave V3',   pct: 12, earned: 65.04,  color: '#B6509E' },
]

const CHART_DATA = [2.1, 3.4, 2.8, 4.2, 3.9, 5.1, 4.8, 6.2, 5.4, 7.8, 6.1, 8.4, 7.2, 9.1, 8.3, 10.2, 9.8, 11.4, 10.1, 12.8, 11.2, 13.4, 12.1, 14.6, 13.8, 15.2, 14.4, 16.8, 15.4, 17.2]

function BarChart({ data }: { data: number[] }) {
  const max = Math.max(...data)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 80, paddingTop: 8 }}>
      {data.map((v, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
          <div style={{
            width: '100%', background: i === data.length - 1 ? '#EA580C' : 'rgba(234,88,12,0.3)',
            borderRadius: '3px 3px 0 0', height: `${(v / max) * 100}%`,
            transition: 'height 600ms cubic-bezier(0.34,1.56,0.64,1)',
          }} />
        </div>
      ))}
    </div>
  )
}

function ActionBadge({ action }: { action: HarvestRecord['action'] }) {
  const map = {
    HARVEST:   { label: 'Harvest',   color: '#16A34A', bg: 'rgba(22,163,74,0.1)' },
    REBALANCE: { label: 'Rebalance', color: '#EA580C', bg: 'rgba(234,88,12,0.1)' },
    GENESIS:   { label: 'Genesis',   color: '#8B5CF6', bg: 'rgba(139,92,246,0.1)' },
  }
  const { label, color, bg } = map[action]
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color, background: bg, borderRadius: 6, padding: '2px 8px' }}>{label}</span>
  )
}

function TokenPair({ tokens }: { tokens: string[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: -4 }}>
      {tokens.map((t, i) => (
        <div key={t} style={{ width: 18, height: 18, borderRadius: '50%', overflow: 'hidden', border: '1.5px solid var(--background)', marginLeft: i > 0 ? -6 : 0, zIndex: tokens.length - i }}>
          <img src={TOKEN_LOGOS[t] ?? ''} alt={t} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
        </div>
      ))}
    </div>
  )
}

export default function RewardsPage() {
  const router = useRouter()
  const header = useMemo(() => <AppHeader />, [])
  useHeader(header)
  const [countdown, setCountdown] = useState({ h: 17, m: 43, s: 22 })
  const [tab, setTab] = useState<'all' | 'harvests' | 'rebalances'>('all')

  useEffect(() => {
    const t = setInterval(() => {
      setCountdown(prev => {
        let { h, m, s } = prev
        s--
        if (s < 0) { s = 59; m-- }
        if (m < 0) { m = 59; h-- }
        if (h < 0) { h = 23; m = 59; s = 59 }
        return { h, m, s }
      })
    }, 1000)
    return () => clearInterval(t)
  }, [])

  const displayed = tab === 'all' ? HARVESTS
    : tab === 'harvests' ? HARVESTS.filter(h => h.action === 'HARVEST')
    : HARVESTS.filter(h => h.action === 'REBALANCE' || h.action === 'GENESIS')

  const pad = (n: number) => String(n).padStart(2, '0')

  return (
    <div style={{ minHeight: '100vh', background: 'var(--background)', paddingBottom: 80 }}>

      <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', padding: '28px 28px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-.02em' }}>Yield Rewards</span>
            <ChainChip chain="arbitrum" />
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
            All yield harvested by your agent · Verified on-chain · Proofs anchored on 0G
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginTop: 24 }}>
            <div style={{ background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 14, padding: '20px 22px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.05em' }}>Total Earned</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#16A34A', letterSpacing: '-.02em' }}>${TOTAL_EARNED.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Since Apr 3, 2025 · 43 days</div>
            </div>

            <div style={{ background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 14, padding: '20px 22px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.05em' }}>This Month</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-.02em' }}>${THIS_MONTH.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
              <div style={{ fontSize: 12, color: '#16A34A', marginTop: 4 }}>↑ 23.4% vs last month</div>
            </div>

            <div style={{ background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 14, padding: '20px 22px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.05em' }}>Last Harvest</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-.02em' }}>${LAST_HARVEST.amountUSD.toFixed(2)}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{LAST_HARVEST.date} · {LAST_HARVEST.protocol}</div>
            </div>

            <div style={{ background: 'linear-gradient(135deg, rgba(234,88,12,0.06), rgba(234,88,12,0.02))', border: '1px solid rgba(234,88,12,0.2)', borderRadius: 14, padding: '20px 22px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.05em' }}>Next Harvest</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#EA580C', letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums' }}>
                {pad(countdown.h)}:{pad(countdown.m)}:{pad(countdown.s)}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Est. yield ≈ $38 – $52</div>
            </div>

            <div style={{ background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 14, padding: '20px 22px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.05em' }}>Executions</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-.02em' }}>{HARVESTS.length}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>14 proofs on 0G Chain</div>
            </div>

            <div style={{ background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 14, padding: '20px 22px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.05em' }}>Annualised Rate</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#EA580C', letterSpacing: '-.02em' }}>705.9%</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Real yield · emission-free</div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '28px 28px 0' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 20, alignItems: 'start' }}>

          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: '22px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Cumulative Yield (30 days)</span>
              <span style={{ fontSize: 12, color: '#16A34A', fontWeight: 600 }}>+${(CHART_DATA[CHART_DATA.length - 1]).toFixed(1)} today</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>Daily yield accrual in USD</div>
            <BarChart data={CHART_DATA} />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Apr 15</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Apr 22</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Apr 29</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>May 6</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>May 14</span>
            </div>
          </div>

          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: '22px 24px' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 16 }}>Protocol Breakdown</div>
            {PROTOCOL_BREAKDOWN.map(p => (
              <div key={p.protocol} style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 28, height: 28, borderRadius: 8, overflow: 'hidden', background: 'var(--background)', border: '1px solid var(--border)', flexShrink: 0 }}>
                      <img src={PROTO_LOGOS[p.protocol]} alt={p.protocol} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>{p.protocol}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>${p.earned.toFixed(2)}</div>
                    </div>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>{p.pct}%</span>
                </div>
                <div style={{ height: 5, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${p.pct}%`, background: p.color, borderRadius: 3, transition: 'width 600ms' }} />
                </div>
              </div>
            ))}

            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>PROOF COVERAGE</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <img src="https://assets.coingecko.com/asset_platforms/images/184/standard/0g.png" alt="0G" style={{ width: 20, height: 20, borderRadius: '50%' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>14 / {HARVESTS.length} proofs anchored</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>YieldGekoRegistry · 0G Mainnet</div>
                </div>
                <button onClick={() => router.push('/verify/0x9a1bc12d')} style={{ fontSize: 10, fontWeight: 700, color: '#EA580C', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Verify →</button>
              </div>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 24, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden' }}>
          <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Execution History</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {[{ key: 'all', label: 'All' }, { key: 'harvests', label: 'Harvests' }, { key: 'rebalances', label: 'Rebalances' }].map(t => (
                <button key={t.key} onClick={() => setTab(t.key as typeof tab)} style={{
                  height: 30, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer',
                  fontSize: 12, fontWeight: 600,
                  background: tab === t.key ? '#EA580C' : 'var(--background)',
                  color: tab === t.key ? '#fff' : 'var(--text-secondary)',
                }}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--background)' }}>
                {['Date', 'Protocol / Pool', 'Tokens', 'Action', 'Yield Harvested', 'APY at Harvest', 'Proof', ''].map((h, i) => (
                  <th key={i} style={{ padding: '10px 16px', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textAlign: 'left', textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map((h, idx) => (
                <tr key={h.id} style={{ borderTop: '1px solid var(--border)', animation: `fadeUp 300ms ${idx * 30}ms both` }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--background)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '14px 16px', fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{h.date}</td>

                  <td style={{ padding: '14px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 28, height: 28, borderRadius: 8, overflow: 'hidden', background: 'var(--background)', border: '1px solid var(--border)', flexShrink: 0 }}>
                        <img src={PROTO_LOGOS[h.protocol]} alt={h.protocol} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      </div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{h.protocol}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{h.pool}</div>
                      </div>
                    </div>
                  </td>

                  <td style={{ padding: '14px 16px' }}><TokenPair tokens={h.tokens} /></td>

                  <td style={{ padding: '14px 16px' }}><ActionBadge action={h.action} /></td>

                  <td style={{ padding: '14px 16px' }}>
                    <span style={{ fontSize: 15, fontWeight: 800, color: '#16A34A' }}>+${h.amountUSD.toFixed(2)}</span>
                  </td>

                  <td style={{ padding: '14px 16px' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{h.apyAtHarvest.toFixed(1)}%</span>
                  </td>

                  <td style={{ padding: '14px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <img src="https://assets.coingecko.com/asset_platforms/images/184/standard/0g.png" alt="0G" style={{ width: 14, height: 14, borderRadius: '50%', opacity: 0.8 }} />
                      <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-muted)' }}>{h.proofHash}</span>
                    </div>
                  </td>

                  <td style={{ padding: '14px 16px', textAlign: 'right' }}>
                    <button
                      onClick={() => router.push(`/verify/${h.proofHash}`)}
                      style={{ fontSize: 11, fontWeight: 700, color: '#EA580C', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px' }}
                    >
                      Verify →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <style>{`
        @keyframes fadeUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
      `}</style>
    </div>
  )
}
