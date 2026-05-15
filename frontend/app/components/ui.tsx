'use client'

import Image from 'next/image'
import Link from 'next/link'
import type { ReactNode } from 'react'

export const CHAIN_LOGOS: Record<string, string> = {
  arbitrum: 'https://assets.coingecko.com/coins/images/16547/standard/arb.jpg?1721358242',
  '0g':     'https://assets.coingecko.com/asset_platforms/images/184/standard/0g.png',
}

export const PROTO_LOGOS: Record<string, string> = {
  aave:    'https://assets.coingecko.com/coins/images/12645/standard/aave-token-round.png?1720472354',
  morpho:  'https://assets.coingecko.com/coins/images/29837/standard/morpho.png',
  uniswap: 'https://assets.coingecko.com/coins/images/12504/standard/uniswap-logo.png',
  pendle:  'https://assets.coingecko.com/coins/images/28500/standard/pendle-logo.png',
  gmx:     'https://assets.coingecko.com/coins/images/18323/standard/arbit.png',
}

function LogoCircle({ src, alt, size }: { src: string; alt: string; size: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden', flexShrink: 0, background: '#F5F5F4' }}>
      
      <img src={src} alt={alt} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
    </div>
  )
}

export function ChainMark({ id, size = 20 }: { id: string; size?: number }) {
  const src = CHAIN_LOGOS[id]
  if (src) return <LogoCircle src={src} alt={id} size={size} />
  return <div style={{ width: size, height: size, borderRadius: '50%', background: '#28A0F0', flexShrink: 0 }} />
}

export function ProtocolMark({ id, size = 32 }: { id: string; size?: number }) {
  const src = PROTO_LOGOS[id]
  if (src) return <LogoCircle src={src} alt={id} size={size} />
  return <div style={{ width: size, height: size, borderRadius: '50%', background: '#78716C', flexShrink: 0 }} />
}

export function GekoMark({ size = 80, color = '#EA580C' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none" aria-label="YieldGeko">
      <path d="M40 14c14 0 24 10 24 24a18 18 0 0 1-30 13c2 4 6 7 11 7v6c-12 0-22-9-22-22 0-15 7-28 17-28z" fill={color} />
      <circle cx="48" cy="32" r="3" fill="white" />
    </svg>
  )
}

export function AppNav() {
  return (
    <header className="appnav">
      <Link href="/app" className="appnav-brand">
        <Image src="/logo.svg" alt="YieldGeko" width={32} height={32} style={{ borderRadius: 8 }} />
        <span className="appnav-wordmark">YieldGeko</span>
      </Link>
      <div className="appnav-right">
        
        <appkit-button size="md" balance="hide" />
      </div>
    </header>
  )
}

type Status = 'running' | 'paused' | 'error'

export function StatusPill({ state }: { state: Status }) {
  const labels: Record<Status, string> = { running: 'Running', paused: 'Paused', error: 'Attention' }
  return (
    <span className="status-pill" data-state={state}>
      <span className="sdot" />
      {labels[state]}
    </span>
  )
}

export function ChainChip({ chain }: { chain: string }) {
  const labels: Record<string, string> = { arbitrum: 'Arbitrum', '0g': '0G Network' }
  return (
    <span className="chain-chip" data-chain={chain}>
      <ChainMark id={chain} size={12} />
      {labels[chain] ?? chain}
    </span>
  )
}

export function Sparkline({ data, color = '#16A34A', height = 48 }: { data: number[]; color?: string; height?: number }) {
  const w = 100, h = height
  const min = Math.min(...data), max = Math.max(...data)
  const range = max - min || 1
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - ((v - min) / range) * (h - 6) - 3
    return [x, y]
  })
  const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ')
  const fillD = `${d} L ${w} ${h} L 0 ${h} Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }}>
      <path d={fillD} fill={color} opacity="0.06" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
