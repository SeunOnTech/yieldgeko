'use client'

import {
  useState, useCallback, useEffect, useRef,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import {
  useAccount, useReadContract, useSwitchChain, useChainId, usePublicClient,
  useConnect, useWalletClient,
} from 'wagmi'
import { useAppKit } from '@reown/appkit/react'
import { useLoginWithOAuth, useLoginWithEmail, useLoginWithTelegram } from '@privy-io/react-auth'
import {
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  parseAbi,
  parseAbiParameters,
  parseUnits,
  type Address,
  type Hex,
} from 'viem'
import { arbitrum } from '@reown/appkit/networks'
import {
  createCaveat,
  Implementation,
  ROOT_AUTHORITY,
  toMetaMaskSmartAccount,
  type MetaMaskSmartAccount,
} from '@metamask/smart-accounts-kit'
import {
  ENFORCER_ADDRESS,
  TREASURY_ADDRESS,
  USDC_ADDRESS,
} from '@/config'
import { createBundlerClient } from 'viem/account-abstraction'
import { http as viemHttp } from 'viem'
import { createPimlicoClient } from 'permissionless/clients/pimlico'

import s from './AgentFlow.module.css'

const ONBOARD_UI_MARK = 'yieldgeko-onboard-v3'
const POLICY_DURATION_SECONDS = 365 * 24 * 60 * 60
const PERMIT_WINDOW_SECONDS = 60 * 60
const POLICY_MAX_FEE_BPS = BigInt(1000)
const ZERO_SALT = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

const USDC_NONCE_ABI = parseAbi([
  'function balanceOf(address) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function nonces(address owner) external view returns (uint256)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external',
  'function transferFrom(address from, address to, uint256 amount) external returns (bool)',
  'function approve(address spender, uint256 amount) external returns (bool)',
])

const ENFORCER_ABI = parseAbi([
  'function authorizedAgents(address) external view returns (bool)',
])

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

const PRESETS = [
  { id: 'conservative', label: 'Conservative', t: 0, apy: 8, drawdown: 10 },
  { id: 'balanced', label: 'Balanced', t: 0.33, apy: 12, drawdown: 12 },
  { id: 'aggressive', label: 'Aggressive', t: 0.66, apy: 20, drawdown: 18 },
  { id: 'advanced', label: 'Advanced', t: 1, apy: 30, drawdown: 25 },
] as const

const PROTOCOLS = [
  { id: 'aave', name: 'Aave V3', kind: 'Lending' },
  { id: 'morpho', name: 'Morpho Blue', kind: 'Lending' },
  { id: 'uniswap', name: 'Uniswap V3', kind: 'LP' },
  { id: 'pendle', name: 'Pendle', kind: 'Yield trading' },
  { id: 'gmx', name: 'GMX V2', kind: 'Perps LP' },
]

function addMonths(date: Date, months: number) {
  const next = new Date(date)
  next.setMonth(next.getMonth() + months)
  return next
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0)
}

function formatDateInput(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseDateInput(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, (month || 1) - 1, day || 1)
}

function formatExpiryLabel(value: string) {
  return parseDateInput(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function getExpiryInDays(value: string) {
  const selected = parseDateInput(value)
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const startOfSelected = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate())
  const diffMs = startOfSelected.getTime() - startOfToday.getTime()
  return Math.max(0, Math.round(diffMs / (24 * 60 * 60 * 1000)))
}

function formatExpiryInLabel(value: string) {
  const days = getExpiryInDays(value)
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

function expiryDateToUnix(value: string) {
  const date = parseDateInput(value)
  date.setHours(23, 59, 59, 999)
  return Math.floor(date.getTime() / 1000)
}

function getPolicyExpiryBounds() {
  const today = new Date()
  return {
    min: formatDateInput(addMonths(today, 1)),
    max: formatDateInput(addMonths(today, 12)),
  }
}

function isSameDay(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

function isSameMonth(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
}

function buildCalendarDays(month: Date) {
  const monthStart = startOfMonth(month)
  const monthEnd = endOfMonth(month)
  const startWeekday = monthStart.getDay()
  const gridStart = new Date(monthStart)
  gridStart.setDate(monthStart.getDate() - startWeekday)

  const days: Date[] = []
  for (let i = 0; i < 42; i += 1) {
    const next = new Date(gridStart)
    next.setDate(gridStart.getDate() + i)
    days.push(next)
  }

  return { days, monthStart, monthEnd }
}

function riskTierFromT(tValue: number): 'conservative' | 'balanced' | 'aggressive' | 'advanced' {
  if (tValue < 0.165) return 'conservative'
  if (tValue < 0.495) return 'balanced'
  if (tValue < 0.83) return 'aggressive'
  return 'advanced'
}

function slugifyStrategyName(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
}

function createDraftStrategyId(name: string): string {
  const slug = slugifyStrategyName(name || 'strategy') || 'strategy'
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  return `0xgeko-${slug}-${suffix}`.toLowerCase()
}

const valuesAtT = (t: number) => {
  const apyStops = [8, 12, 20, 30]
  const ddStops = [10, 12, 18, 25]
  const segs = [0, 0.33, 0.66, 1]
  for (let i = 0; i < segs.length - 1; i++) {
    if (t >= segs[i] && t <= segs[i + 1]) {
      const u = (t - segs[i]) / (segs[i + 1] - segs[i])
      const apy = Math.round(apyStops[i] + u * (apyStops[i + 1] - apyStops[i]))
      const dd = Math.round(ddStops[i] + u * (ddStops[i + 1] - ddStops[i]))
      return { apy, drawdown: dd }
    }
  }
  return { apy: 30, drawdown: 25 }
}

const activeProtocolSet = (t: number) => {
  const set = new Set(['aave', 'morpho'])
  if (t > 0.16) set.add('uniswap')
  if (t > 0.49) set.add('pendle')
  if (t > 0.83) set.add('gmx')
  return set
}

const tToTheta = (t: number) => -120 + t * 240

const polar = (cx: number, cy: number, r: number, thetaDeg: number) => {
  const rad = (thetaDeg * Math.PI) / 180
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) }
}

const CHAIN_LOGOS: Record<string, string> = {
  arbitrum: 'https://icons.llamao.fi/icons/chains/rsz_arbitrum?w=48&h=48',
  '0g': 'https://icons.llamao.fi/icons/chains/rsz_0g?w=48&h=48',
  base: 'https://icons.llamao.fi/icons/protocols/base-app?w=48&h=48',
  ethereum: 'https://icons.llamao.fi/icons/chains/rsz_ethereum?w=48&h=48',
}

const PROTO_LOGOS: Record<string, string> = {
  aave: 'https://icons.llamao.fi/icons/protocols/aave?w=48&h=48',
  morpho: 'https://icons.llamao.fi/icons/protocols/morpho-blue?w=48&h=48',
  uniswap: 'https://icons.llamao.fi/icons/protocols/uniswap?w=48&h=48',
  pendle: 'https://icons.llamao.fi/icons/protocols/pendle?w=48&h=48',
  gmx: 'https://icons.llamao.fi/icons/protocols/gmx?w=48&h=48',
}

function LogoCircle({ src, alt, size }: { src: string; alt: string; size: number }) {
  return (
    <div style={{
      width: size, height: size,
      borderRadius: '50%',
      overflow: 'hidden',
      flexShrink: 0,
      background: 'var(--secondary, #F5F5F4)',
      border: '1px solid var(--border, #E7E5E4)',
    }}>
      
      <img src={src} alt={alt} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
    </div>
  )
}

function ChainMark({ id, size = 48 }: { id: string; size?: number }) {
  const src = CHAIN_LOGOS[id]
  if (src) return <LogoCircle src={src} alt={id} size={size} />
  return (
    <div className={s.mark} style={{ width: size, height: size, background: '#28A0F0', fontSize: size * 0.42 }}>
      {id[0].toUpperCase()}
    </div>
  )
}

function ProtocolMark({ id, size = 32 }: { id: string; size?: number }) {
  const src = PROTO_LOGOS[id]
  if (src) return <LogoCircle src={src} alt={id} size={size} />
  return (
    <div className={s.mark} style={{ width: size, height: size, background: '#78716C', fontSize: size * 0.5 }}>
      ?
    </div>
  )
}

function GekoMark({ size = 80, color = '#FFFFFF' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none" aria-label="YieldGeko">
      <circle cx="40" cy="40" r="36" stroke={color} strokeWidth="2" opacity="0.18" />
      <path d="M40 14c14 0 24 10 24 24a18 18 0 0 1-30 13c2 4 6 7 11 7v6c-12 0-22-9-22-22 0-15 7-28 17-28z" fill={color} />
      <circle cx="48" cy="32" r="3" fill="#0B0C0E" />
    </svg>
  )
}

const Icons = {
  MetaMask: () => (
    <svg width="40" height="40" viewBox="0 0 320 320" fill="none">
      <path d="M299.7 41L173.3 125.7L154.2 46.1L299.7 41Z" fill="#E17726" />
      <path d="M20.3 41L146.7 125.7L165.8 46.1L20.3 41Z" fill="#E17726" />
      <path d="M266.3 227.1L239.5 281.3L161.4 227.1L266.3 227.1Z" fill="#E17726" />
      <path d="M53.7 227.1L80.5 281.3L158.6 227.1L53.7 227.1Z" fill="#E17726" />
      <path d="M110.1 169.5L80.5 227.1L153.2 181.7L110.1 169.5Z" fill="#E17726" />
      <path d="M209.9 169.5L239.5 227.1L166.8 181.7L209.9 169.5Z" fill="#E17726" />
      <path d="M160 120.5L203.1 169.5L160 181.7L116.9 169.5L160 120.5Z" fill="#F6851B" />
      <path d="M153.2 181.7L160 216.5L166.8 181.7L160 181.7H153.2Z" fill="#F6851B" />
    </svg>
  ),
  Backpack: () => (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20V10a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v10" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      <circle cx="12" cy="13" r="2" />
    </svg>
  ),
  YieldGeko: () => (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
      <rect width="40" height="40" rx="10" fill="#EA580C" />
      <path d="M10 12H30V15L10 25V12Z" fill="white" />
      <path d="M10 28H30V25L10 15V28Z" fill="white" fillOpacity="0.6" />
    </svg>
  ),
  WalletConnect: () => (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="12" fill="#3396FF" fillOpacity="0.1" />
      <path d="M16.142 9.124c-2.288-2.288-6.002-2.288-8.29 0l-.41.41a.214.214 0 000 .302l.74.74a.214.214 0 00.301 0l.41-.41c1.455-1.455 3.82-1.455 5.275 0l.435.435a.214.214 0 00.302 0l.74-.74a.214.214 0 000-.301l-.435-.436h.032zm3.327 3.327l-.84.84a.214.214 0 000 .302l3.208 3.208a.214.214 0 00.302 0l.84-.84a.214.214 0 000-.302l-3.208-3.208a.214.214 0 00-.302 0zM4.53 12.451a.214.214 0 00-.302 0L1.021 15.66a.214.214 0 000 .302l.84.84a.214.214 0 00.302 0l.84.84zm7.47 1.838c-.763 0-1.481.297-2.02.836l-.382.382a.214.214 0 000 .302l.74.74a.214.214 0 00.302 0l.382-.382a.857.857 0 011.212 0l.407.407a.214.214 0 00.302 0l.74-.74a.214.214 0 000-.302l-.407-.407a2.855 2.855 0 00-1.276-.836z" fill="#3396FF" />
      <path d="M12 8c-2.21 0-4.21.89-5.66 2.34l-.41.41c-.08.08-.08.21 0 .29l.74.74c.08.08.21.08.29 0l.41-.41C8.65 10.1 10.22 9.5 12 9.5s3.35.6 4.63 1.87l.44.44c.08.08.21.08.29 0l.74-.74c.08-.08.08-.21 0-.29l-.44-.44C16.21 8.89 14.21 8 12 8z" fill="#3396FF" />
    </svg>
  ),
  Ledger: () => (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" />
      <path d="M9 4v16M15 4v16M4 10h16M4 14h16" stroke="currentColor" opacity="0.3" />
      <rect x="11" y="9" width="2" height="6" rx="1" fill="currentColor" />
    </svg>
  ),
  Google: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-1 .67-2.28 1.07-3.71 1.07-2.85 0-5.27-1.92-6.13-4.51H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.87 14.13c-.22-.67-.35-1.39-.35-2.13s.13-1.46.35-2.13V7.03H2.18C1.43 8.53 1 10.21 1 12s.43 3.47 1.18 4.97l3.69-2.84z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.03l3.69 2.84c.86-2.59 3.28-4.51 6.13-4.51z" fill="#EA4335" />
    </svg>
  ),
  Telegram: () => (
    <svg width="24" height="24" viewBox="0 0 240 240">
      <defs>
        <linearGradient id="tg-grad" x1="120" y1="0" x2="120" y2="240" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2AABEE" />
          <stop offset="1" stopColor="#229ED9" />
        </linearGradient>
      </defs>
      <circle cx="120" cy="120" r="120" fill="url(#tg-grad)" />
      <path d="M98 175c-3.9 0-3.2-1.5-4.6-5.2L82 132.2 174.6 78l5.4 2-4.5 28.8L98 175z" fill="#C8DAEA" />
      <path d="M98 175c3 0 4.3-1.4 6-3l16-15.6-20-12L98 175z" fill="#A9C9DD" />
      <path d="M100 144.4l48.4 35.7c5.5 3 9.5 1.5 10.9-5.1l19.7-92.8c2-8.1-3.1-11.7-8.4-9.3L60 117.5c-7.9 3.2-7.8 7.6-1.4 9.5l26.6 8.3 61.5-38.8c2.9-1.8 5.6-.8 3.4 1.1L100 144.4z" fill="#fff" />
    </svg>
  ),
  X: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  ),
  Discord: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037 19.736 19.736 0 0 0-4.885 1.515.069.069 0 0 0-.032.027C.533 9.048-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  )
}

function Dial({ value, onChange, size = 280 }: { value: number; onChange: (v: number) => void; size?: number }) {
  const cx = size / 2
  const cy = size / 2 + 20
  const r = size / 2 - 24
  const stroke = 8

  const trackStart = polar(cx, cy, r, -120)
  const trackEnd = polar(cx, cy, r, +120)

  const theta = tToTheta(value)
  const handle = polar(cx, cy, r, theta)

  const sweepDeg = theta - (-120)
  const largeArc = sweepDeg > 180 ? 1 : 0
  const activeD = `M ${trackStart.x} ${trackStart.y} A ${r} ${r} 0 ${largeArc} 1 ${handle.x} ${handle.y}`
  const trackD = `M ${trackStart.x} ${trackStart.y} A ${r} ${r} 0 1 1 ${trackEnd.x} ${trackEnd.y}`

  const svgRef = useRef<SVGSVGElement>(null)
  const draggingRef = useRef(false)

  const updateFromClient = useCallback((clientX: number, clientY: number) => {
    if (!svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const px = ((clientX - rect.left) / rect.width) * size
    const py = ((clientY - rect.top) / rect.height) * size
    const dx = px - cx
    const dy = py - cy
    let thetaDeg = (Math.atan2(dx, -dy) * 180) / Math.PI
    if (thetaDeg > 120) thetaDeg = 120
    if (thetaDeg < -120) thetaDeg = -120
    onChange(Math.max(0, Math.min(1, (thetaDeg + 120) / 240)))
  }, [cx, cy, size, onChange])

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    e.preventDefault()
    draggingRef.current = true
    svgRef.current?.setPointerCapture(e.pointerId)
    updateFromClient(e.clientX, e.clientY)
  }
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!draggingRef.current) return
    updateFromClient(e.clientX, e.clientY)
  }
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    draggingRef.current = false
    try { svgRef.current?.releasePointerCapture(e.pointerId) } catch { }
    const nearest = PRESETS.reduce((best, p) =>
      Math.abs(p.t - value) < Math.abs(best.t - value) ? p : best
    )
    if (Math.abs(nearest.t - value) < 0.05) onChange(nearest.t)
  }

  const { apy } = valuesAtT(value)

  return (
    <div className={s.dialWrap} style={{ width: size, position: 'relative' }}>
      <div className={s.dialGlow} style={{
        background: `radial-gradient(circle at 50% 55%,
          rgba(22,163,74, ${0.06 - value * 0.04}) 0%,
          rgba(234,88,12, ${value * 0.08}) 40%,
          transparent 70%)`,
      }} />

      <svg
        ref={svgRef}
        width={size} height={size}
        viewBox={`0 0 ${size} ${size}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ touchAction: 'none', cursor: 'grab', display: 'block' }}
      >
        <defs>
          <linearGradient id="dial-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#16A34A" />
            <stop offset="50%" stopColor="#EAB308" />
            <stop offset="100%" stopColor="#EA580C" />
          </linearGradient>
        </defs>

        <path d={trackD} stroke="var(--dial-track)" strokeWidth={stroke} fill="none" strokeLinecap="round" />
        <path d={activeD} stroke="url(#dial-grad)" strokeWidth={stroke} fill="none" strokeLinecap="round" />

        

        <circle cx={handle.x} cy={handle.y} r={14} fill="var(--surface)" stroke="var(--primary)" strokeWidth={2} />
        <circle cx={handle.x} cy={handle.y} r={4} fill="var(--primary)" />
      </svg>

      <div style={{
        position: 'absolute', top: cy - 30, left: 0, width: '100%',
        textAlign: 'center', pointerEvents: 'none',
      }}>
        <div className={s.dialReadoutApy}>{apy}%</div>
        <div className={s.dialReadoutLbl}>minimum</div>
      </div>

      
    </div>
  )
}

function ScreenStage({
  screen, direction, children, screenClassName,
}: {
  screen: number
  direction: number
  children: ReactNode
  screenClassName?: string
}) {
  return (
    <div key={screen} className={s.stage} style={{
      animation: `${direction === 1 ? 'slideInRight' : 'slideInLeft'} 280ms cubic-bezier(0.22,1,0.36,1)`,
    }}>
      <div className={[s.screen, screenClassName].filter(Boolean).join(' ')}>{children}</div>
    </div>
  )
}

type NetworkDef = {
  id: string
  name: string
  chainId: number
  shortLine: string
  description: string
  apy: string
  tvl: string
  risk: string
  recommended?: boolean
  protocols: { id: string; name: string; kind: string }[]
}

const NETWORKS: NetworkDef[] = [
  {
    id: 'arbitrum',
    name: 'Arbitrum',
    chainId: 42161,
    shortLine: 'Where YieldGeko is live today — depth, routing, and keeper economics that hold up.',
    recommended: true,
    description: 'The premier L2 for DeFi velocity. High liquidity and diverse protocol integrations.',
    apy: '52.4',
    tvl: '$3.2B',
    risk: 'Low–medium',
    protocols: [
      { id: 'aave', name: 'Aave V3', kind: 'Lending' },
      { id: 'morpho', name: 'Morpho Blue', kind: 'Lending' },
      { id: 'uniswap', name: 'Uniswap V3', kind: 'LP' },
      { id: 'pendle', name: 'Pendle', kind: 'Yield' },
      { id: 'gmx', name: 'GMX V2', kind: 'Perps' },
    ],
  },
  {
    id: '0g',
    name: '0G Network',
    chainId: 16661,
    shortLine: 'Storage and compute rails for proofs — paired with execution where liquidity exists.',
    description: 'Autonomous AI data layer. Earn native yield by powering decentralized AI infrastructure.',
    apy: '18.2',
    tvl: '$15.5M',
    risk: 'Medium',
    protocols: [{ id: 'uniswap', name: 'UniV3 on 0G', kind: 'LP' }],
  },
  {
    id: 'base',
    name: 'Base',
    chainId: 8453,
    shortLine: 'Coinbase-aligned L2 — fast settlement and familiar on-ramps for newer wallets.',
    description: 'Coinbase L2. Fast, secure, and integrated with the largest fiat on-ramps.',
    apy: '24.1',
    tvl: '$1.1B',
    risk: 'Low',
    protocols: [
      { id: 'aave', name: 'Aave V3', kind: 'Lending' },
      { id: 'uniswap', name: 'Uniswap V3', kind: 'LP' },
      { id: 'morpho', name: 'Morpho Blue', kind: 'Lending' },
    ],
  },
  {
    id: 'ethereum',
    name: 'Ethereum',
    chainId: 1,
    shortLine: 'Maximum security budget — higher fees, slower rotations; better for size than experimentation.',
    description: 'The secure backbone of DeFi. Best for long-term institutional-grade strategies.',
    apy: '12.5',
    tvl: '$42.8B',
    risk: 'Lowest volatility',
    protocols: [
      { id: 'aave', name: 'Aave V3', kind: 'Lending' },
      { id: 'uniswap', name: 'Uniswap V3', kind: 'LP' },
      { id: 'morpho', name: 'Morpho Blue', kind: 'Lending' },
      { id: 'pendle', name: 'Pendle', kind: 'Yield' },
    ],
  },
]

const CHAIN_PICK_ORDER = ['arbitrum', '0g', 'base', 'ethereum'] as const

function ChainPreviewFactsProtocols({ net }: { net: NetworkDef }) {
  return (
    <>
      <div className={s.chainPreviewFacts}>
        <div className={s.chainPreviewFact}>
          <span className={s.chainPreviewFactLabel}>Liquidity footprint</span>
          <span className={s.chainPreviewFactValue}>{net.tvl}</span>
        </div>
        <div className={s.chainPreviewFact}>
          <span className={s.chainPreviewFactLabel}>Risk posture</span>
          <span className={`${s.chainPreviewFactValue} ${s.chainPreviewFactMuted}`}>{net.risk}</span>
        </div>
        <div className={s.chainPreviewFact}>
          <span className={s.chainPreviewFactLabel}>Venues</span>
          <span className={s.chainPreviewFactValue}>{net.protocols.length}</span>
        </div>
      </div>
      <div>
        <p className={s.chainPreviewProtocolsLabel}>Protocols on this rail</p>
        <div className={s.chainPreviewChips}>
          {net.protocols.map(p => (
            <span key={p.id} className={s.chainPreviewChip}>
              <ProtocolMark id={p.id} size={18} />
              <span>{p.name}</span>
              <span className={s.chainPreviewChipKind}>{p.kind}</span>
            </span>
          ))}
        </div>
      </div>
    </>
  )
}

function ScreenConnect() {
  const { open } = useAppKit()
  const { connectors, connect } = useConnect()
  const [email, setEmail] = useState('')
  const { initOAuth } = useLoginWithOAuth()
  const { sendCode } = useLoginWithEmail()
  const { login: loginWithTelegram } = useLoginWithTelegram()

  const handleWalletClick = (walletName: string) => {
    if (walletName === 'WalletConnect') { open(); return }
    const connector = connectors.find(c => {
      const name = c.name.toLowerCase()
      const id = c.id.toLowerCase()
      if (walletName === 'MetaMask') return name.includes('metamask') || id.includes('metamask')
      if (walletName === 'Backpack') return name.includes('backpack') || id.includes('backpack')
      if (walletName === 'Ledger') return id.includes('ledger')
      return false
    })
    if (connector) connect({ connector })
    else open()
  }

  const wallets = [
    { name: 'MetaMask', icon: Icons.MetaMask },
    { name: 'Backpack', icon: Icons.Backpack },
    { name: 'YieldGeko Wallet', icon: Icons.YieldGeko },
    { name: 'WalletConnect', icon: Icons.WalletConnect },
    { name: 'Ledger', icon: Icons.Ledger },
  ]

  return (
    <div className={s.connectContainer}>
      <h1 className={s.connectTitle}>Connect to YieldGeko</h1>
      <div className={s.connectGrid}>
        {wallets.map((w) => {
          const connector = connectors.find(c => {
            const name = c.name.toLowerCase(), id = c.id.toLowerCase()
            if (w.name === 'MetaMask') return name.includes('metamask') || id.includes('metamask')
            if (w.name === 'Backpack') return name.includes('backpack') || id.includes('backpack')
            if (w.name === 'WalletConnect') return id.includes('walletconnect')
            if (w.name === 'Ledger') return id.includes('ledger') || id.includes('walletconnect')
            return false
          })
          return (
            <button key={w.name} className={s.walletOption} onClick={() => handleWalletClick(w.name)}>
              <div className={s.walletIcon}>
                {connector?.icon ? <img src={connector.icon} alt={w.name} width="40" height="40" /> : <w.icon />}
              </div>
              <span className={s.walletName}>{w.name}</span>
            </button>
          )
        })}
      </div>
      <div className={s.divider}>
        <div className={s.dividerLine} /><span className={s.dividerText}>Or connect with</span><div className={s.dividerLine} />
      </div>
      <div className={s.socialSection}>
        <div className={s.socialGrid}>
          <button className={s.socialBtn} onClick={() => initOAuth({ provider: 'google' })}><Icons.Google /><span>Google</span></button>
          <button className={s.socialBtn} onClick={() => loginWithTelegram()}><Icons.Telegram /><span>Telegram</span></button>
          <button className={s.socialBtn} onClick={() => initOAuth({ provider: 'twitter' })}><Icons.X /><span>X</span></button>
          <button className={s.socialBtn} onClick={() => initOAuth({ provider: 'discord' })}><Icons.Discord /><span>Discord</span></button>
        </div>
        <div className={s.emailGroup}>
          <input className={s.emailInput} placeholder="name@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className={s.emailSubmitBtn} onClick={() => email && sendCode({ email })}>Continue</button>
        </div>
      </div>
    </div>
  )
}

function ComingSoonPopup({ net, onClose }: { net: NetworkDef; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 2800)
    return () => clearTimeout(t)
  }, [onClose])

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9998, pointerEvents: 'none' }}>
      <style>{`
        @keyframes csIn { from { opacity:0; transform:scale(0.78) translateY(14px); } to { opacity:1; transform:scale(1) translateY(0); } }
        @keyframes csStar { 0%,100%{opacity:0;transform:scale(0) rotate(0deg);} 50%{opacity:1;transform:scale(1) rotate(20deg);} }
      `}</style>
      <div style={{ background:'var(--background)', border:'1.5px solid var(--border)', borderRadius:28, padding:'36px 44px', textAlign:'center', boxShadow:'0 32px 80px rgba(0,0,0,0.22)', animation:'csIn 380ms cubic-bezier(0.34,1.56,0.64,1) both', position:'relative', minWidth:300 }}>
        
        {[[-28,-20],[30,-16],[-22,28],[32,24]].map(([x,y], i) => (
          <svg key={i} width="14" height="14" viewBox="0 0 24 24" fill="#f59e0b" style={{ position:'absolute', top:`calc(50% + ${y}px)`, left:`calc(50% + ${x}px)`, animation:`csStar ${1.2+i*0.3}s ease-in-out ${i*0.2}s infinite`, opacity:0 }}>
            <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
          </svg>
        ))}
        <div style={{ marginBottom:16 }}><ChainMark id={net.id} size={60} /></div>
        <div style={{ fontSize:21, fontWeight:700, marginBottom:10, color:'var(--foreground)' }}>{net.name}</div>
        <div style={{ display:'inline-flex', alignItems:'center', gap:6, background:'linear-gradient(135deg,#f59e0b,#ea580c)', color:'#fff', padding:'7px 18px', borderRadius:20, fontSize:11, fontWeight:800, letterSpacing:'0.1em', textTransform:'uppercase', marginBottom:14 }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          Coming soon
        </div>
        <div style={{ fontSize:13, color:'var(--text-muted)', lineHeight:1.6 }}>
          We're building full support for {net.name}.<br />Sign up to be notified at launch.
        </div>
      </div>
    </div>,
    document.body
  )
}

function Screen0Chain({ chain, setChain, onContinue, agentHealth }: { chain: string; setChain: (c: string) => void; onContinue: () => void; agentHealth: 'idle' | 'ok' | 'down' }) {
  const ordered = CHAIN_PICK_ORDER.map(id => NETWORKS.find(n => n.id === id)).filter(Boolean) as NetworkDef[]
  const selectedNet = NETWORKS.find(n => n.id === chain) ?? NETWORKS[0]
  const [comingSoon, setComingSoon] = useState<NetworkDef | null>(null)

  const handleChainClick = (net: NetworkDef) => {
    if (net.id !== 'arbitrum') { setComingSoon(net); return }
    setChain(net.id)
  }

  return (
    <div className={s.chainStep}>
      <div className={s.chainStepGlow} aria-hidden />
      {comingSoon && <ComingSoonPopup net={comingSoon} onClose={() => setComingSoon(null)} />}
      <div className={s.chainStepInner}>
        {/* Agent health banner — only shown when server is unreachable */}
        {agentHealth === 'down' && (
          <div style={{ display:'flex', alignItems:'center', gap:10, background:'#fffbeb', border:'1px solid #fde68a', borderRadius:10, padding:'10px 16px', marginBottom:20, fontSize:13, color:'#92400e', fontWeight:500 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            Agent server is temporarily unreachable — you can still configure your strategy. Activation requires the agent to be online.
          </div>
        )}
        <header className={s.chainStepHeader}>
          <p className={s.chainStepKicker}>Execution network</p>
          <h1 className={s.chainStepTitle}>Choose where this agent settles</h1>
          <p className={s.chainStepLead}>
            Choose the execution rail. Your smart account and delegation will be prepared on the network you select.
          </p>
        </header>
        <div className={s.chainStepGrid}>
          <div>
            <ul className={s.chainPickList} role="listbox">
              {ordered.map(net => {
                const selected = chain === net.id
                const isLive = net.id === 'arbitrum'
                return (
                  <li key={net.id} className={`${s.chainPickItem} ${selected ? s.chainPickItemSelected : ''}`}>
                    <button type="button" className={`${s.chainOption} ${selected ? s.chainOptionSelected : ''}`} onClick={() => handleChainClick(net)} style={{ opacity: isLive ? 1 : 0.72 }}>
                      <ChainMark id={net.id} size={40} />
                      <div className={s.chainOptionBody}>
                        <div className={s.chainOptionTop}>
                          <span className={s.chainOptionName}>{net.name}</span>
                          {net.recommended ? <span className={`${s.chainOptionBadge} ${s.chainOptionBadgeLive}`}>Live · suggested</span> : <span className={s.chainOptionBadge}>Coming soon</span>}
                        </div>
                        <span className={s.chainOptionMeta}>{net.tvl} TVL · {net.risk}</span>
                      </div>
                      <span className={s.chainOptionRadio}><span className={s.chainOptionDot} /></span>
                    </button>
                    {selected && (
                      <div className={s.chainInlinePreview}>
                        <p className={s.chainPreviewDesc}>{net.description}</p>
                        <ChainPreviewFactsProtocols net={net} />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
          <div className={s.gridDivider} />
          <aside className={s.chainPreview}>
            <p className={s.chainPreviewEyebrow}>Preview</p>
            <div className={s.chainPreviewHead}>
              <ChainMark id={selectedNet.id} size={52} />
              <div className={s.chainPreviewTitleRow}>
                <h2 className={s.chainPreviewTitle}>{selectedNet.name}</h2>
                <span className={s.chainPreviewLive}><span className={s.chainPreviewLiveDot} />Routed · agent-ready</span>
              </div>
            </div>
            <p className={s.chainPreviewDesc}>{selectedNet.description}</p>
            <ChainPreviewFactsProtocols net={selectedNet} />
            <div className={s.chainPreviewDesktopCta}>
              <button type="button" className={`${s.btn} ${s.btnLg} ${s.chainDesktopContinue}`} onClick={onContinue}>Continue with {selectedNet.name}</button>
            </div>
          </aside>
        </div>
      </div>

      {/* Mobile CTA Bar */}
      <div className={s.chainCtaBarMobile}>
        <div className={s.chainCtaBarInner}>
          <button type="button" className={`${s.btn} ${s.btnLg} ${s.chainCtaContinue}`} onClick={onContinue}>
            Continue with {selectedNet.name}
          </button>
        </div>
      </div>
    </div>
  )
}

function ScreenSmartAccount({ chain, smartAccountAddress, smartAccountDeployed, loading, error, onContinue }: { chain: string; smartAccountAddress: string; smartAccountDeployed: boolean; loading: boolean; error: string; onContinue: () => void }) {
  const liveSupported = chain === 'arbitrum'
  const netName = NETWORKS.find(n => n.id === chain)?.name ?? chain

  return (
    <div className={s.screenInner}>
      <div className={s.splitContainer}>
        {/* Left Side: Value Prop & Timeline */}
        <div className={s.splitLeft}>
          <p className={s.policyStepBadge}>Onboarding</p>
          <h1 className={s.splitTitle}>
            The infrastructure of <br />
            <span className={s.splitTitleHighlight}>autonomous finance.</span>
          </h1>

          <div className={s.splitTimeline}>
            <div className={s.timelineItem}>
              <div className={s.timelineConnector} />
              <div className={`${s.timelineIcon} ${s.timelineIconDone}`}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              </div>
              <div className={s.timelineContent}>
                <h3 className={s.timelineTitle}>Network Selection</h3>
                <p className={s.timelineText}>You've selected {netName} as your execution rail for maximum yield velocity.</p>
              </div>
            </div>

            <div className={s.timelineItem}>
              <div className={s.timelineConnector} />
              <div className={`${s.timelineIcon} ${s.timelineIconActive}`}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
              <div className={s.timelineContent}>
                <h3 className={s.timelineTitle}>Smart Account Creation</h3>
                <p className={s.timelineText}>A dedicated ERC-4337 vault is being derived for your agent. Non-custodial, secure, and gas-abstracted.</p>
              </div>
            </div>

            <div className={s.timelineItem}>
              <div className={s.timelineConnector} />
              <div className={s.timelineIcon}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
              </div>
              <div className={s.timelineContent}>
                <h3 className={s.timelineTitle}>Strategy Deployment</h3>
                <p className={s.timelineText}>Once your account is ready, you'll configure your risk-adjusted yield strategy.</p>
              </div>
            </div>
          </div>
        </div>

        {/* Right Side: Smart Account Card */}
        <div className={s.splitRight}>
          <div className={s.smartCard}>
            <div className={s.smartCardHeader}>
              <div className={s.smartCardMarkWrap}>
                <GekoMark size={64} color="var(--primary)" />
              </div>
              <h2 className={s.smartCardTitle}>Your Smart Account</h2>
              <p className={s.smartCardSub}>This vault houses your capital and executes your agent's decisions.</p>
            </div>

            <div className={s.accountDetails}>
              <div className={s.detailRow}>
                <span className={s.detailLabel}>Network</span>
                <div className={s.detailValueGroup}>
                  <ChainMark id={chain} size={24} />
                  <span className={s.detailValue}>{netName}</span>
                </div>
              </div>

              <div className={s.detailRow}>
                <span className={s.detailLabel}>Status</span>
                <span className={`${s.statusBadge} ${loading ? s.statusDeriving : s.statusReady}`}>
                  {loading ? (
                    <>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spinSlow 2s linear infinite' }}>
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                      Deriving...
                    </>
                  ) : (
                    <>
                      <span className="live-dot" style={{ width: 6, height: 6 }} />
                      {smartAccountDeployed ? 'Deployed' : 'Ready to deploy'}
                    </>
                  )}
                </span>
              </div>

              <div className={`${s.detailRow} ${s.addressBox}`}>
                <div className={s.addressHeader}>
                  <span className={s.detailLabel}>Smart Account</span>
                  {smartAccountAddress && (
                    <button className={s.copyButton} onClick={() => navigator.clipboard.writeText(smartAccountAddress)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                      Copy
                    </button>
                  )}
                </div>
                <div className={s.addressValue}>
                  {smartAccountAddress || 'Generating secure vault...'}
                </div>
              </div>
            </div>

            {!liveSupported && (
              <div className={s.screen4Error} style={{ marginTop: 24, textAlign: 'center' }}>
                Live activation is currently enabled on Arbitrum.
              </div>
            )}

            {error && (
              <div className={s.screen4Error} style={{ marginTop: 24, textAlign: 'center' }}>
                {error}
              </div>
            )}

            <button
              className={`${s.btn} ${s.btnLg} ${s.btnBlock}`}
              style={{ marginTop: 32 }}
              disabled={!liveSupported || loading || !smartAccountAddress}
              onClick={onContinue}
            >
              Continue to Strategy
            </button>

            <div className={s.trustBadge}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <span>Secured by Pimlico & MetaMask Delegation</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function useDialSize() {
  const [size, setSize] = useState(280)
  useEffect(() => {
    const apply = () => {
      const narrow = window.innerWidth <= 768
      setSize(narrow ? Math.max(220, Math.min(268, window.innerWidth - 48)) : 280)
    }
    apply(); window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])
  return size
}

function ExpiryCalendarPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  const { min, max } = getPolicyExpiryBounds()
  const minDate = parseDateInput(min)
  const maxDate = parseDateInput(max)
  const selectedDate = parseDateInput(value)
  const [open, setOpen] = useState(false)
  const [visibleMonth, setVisibleMonth] = useState(startOfMonth(selectedDate))
  const [portalReady, setPortalReady] = useState(false)
  const [popoverStyle, setPopoverStyle] = useState<Record<string, string | number>>({})
  const [isMobile, setIsMobile] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setVisibleMonth(startOfMonth(selectedDate))
  }, [value])

  useEffect(() => {
    setPortalReady(true)
  }, [])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      const clickedTrigger = wrapRef.current?.contains(target)
      const clickedPopover = popoverRef.current?.contains(target)
      if (!clickedTrigger && !clickedPopover) setOpen(false)
    }

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onEscape)
    }
  }, [open])

  useEffect(() => {
    if (!open || !buttonRef.current) return

    const updatePosition = () => {
      if (!buttonRef.current) return
      const rect = buttonRef.current.getBoundingClientRect()
      const mobile = window.innerWidth <= 640
      setIsMobile(mobile)

      if (mobile) {
        setPopoverStyle({
          position: 'fixed',
          left: '16px',
          right: '16px',
          top: '50%',
          width: 'auto',
          maxWidth: '360px',
          transform: 'translateY(-50%)',
          margin: '0 auto',
        })
        return
      }

      const width = Math.max(320, rect.width)
      const viewportPadding = 16
      const popoverHeight = 420
      const spaceBelow = window.innerHeight - rect.bottom - viewportPadding
      const spaceAbove = rect.top - viewportPadding
      const shouldOpenAbove = spaceBelow < popoverHeight && spaceAbove > spaceBelow
      const left = Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - width - viewportPadding))
      const top = shouldOpenAbove
        ? Math.max(viewportPadding, rect.top - popoverHeight - 10)
        : Math.min(rect.bottom + 10, window.innerHeight - popoverHeight - viewportPadding)

      setPopoverStyle({
        position: 'fixed',
        top: `${top}px`,
        left: `${left}px`,
        width: `${width}px`,
        maxWidth: `calc(100vw - ${viewportPadding * 2}px)`,
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  const prevMonth = addMonths(visibleMonth, -1)
  const nextMonth = addMonths(visibleMonth, 1)
  const canGoPrev = startOfMonth(prevMonth) >= startOfMonth(minDate)
  const canGoNext = startOfMonth(nextMonth) <= startOfMonth(maxDate)
  const { days } = buildCalendarDays(visibleMonth)

  const selectDate = (date: Date) => {
    if (date < minDate || date > maxDate) return
    onChange(formatDateInput(date))
    setOpen(false)
  }

  const quickOptions = [
    { label: '1M', date: minDate },
    { label: '3M', date: addMonths(new Date(), 3) },
    { label: '6M', date: addMonths(new Date(), 6) },
    { label: '1Y', date: maxDate },
  ]

  return (
    <div className={s.calendarFieldWrap} ref={wrapRef}>
      <button
        type="button"
        ref={buttonRef}
        className={`${s.calendarFieldButton} ${open ? s.calendarFieldButtonOpen : ''}`}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className={s.calendarFieldValue}>{formatExpiryLabel(value)}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
      </button>

      {open && portalReady && createPortal(
        <>
          {isMobile && <button type="button" className={s.calendarBackdrop} aria-label="Close calendar" onClick={() => setOpen(false)} />}
          <div ref={popoverRef} className={`${s.calendarPopover} ${isMobile ? s.calendarPopoverMobile : s.calendarPopoverDesktop}`} style={popoverStyle} role="dialog" aria-label="Choose policy expiry date">
            <div className={s.calendarQuickRow}>
              {quickOptions.map((option) => {
                const optionValue = formatDateInput(option.date)
                const disabled = option.date < minDate || option.date > maxDate
                return (
                  <button
                    key={option.label}
                    type="button"
                    className={`${s.calendarQuickButton} ${value === optionValue ? s.calendarQuickButtonActive : ''}`}
                    onClick={() => !disabled && selectDate(option.date)}
                    disabled={disabled}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>

            <div className={s.calendarHeader}>
              <button type="button" className={s.calendarNavButton} onClick={() => canGoPrev && setVisibleMonth(prevMonth)} disabled={!canGoPrev} aria-label="Previous month">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              <div className={s.calendarMonthLabel}>
                {visibleMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
              </div>
              <button type="button" className={s.calendarNavButton} onClick={() => canGoNext && setVisibleMonth(nextMonth)} disabled={!canGoNext} aria-label="Next month">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            </div>

            <div className={s.calendarWeekdays}>
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                <span key={day} className={s.calendarWeekday}>{day}</span>
              ))}
            </div>

            <div className={s.calendarGrid}>
              {days.map((day) => {
                const inMonth = isSameMonth(day, visibleMonth)
                const disabled = day < minDate || day > maxDate
                const selected = isSameDay(day, selectedDate)
                return (
                  <button
                    key={day.toISOString()}
                    type="button"
                    className={[
                      s.calendarDay,
                      !inMonth ? s.calendarDayMuted : '',
                      disabled ? s.calendarDayDisabled : '',
                      selected ? s.calendarDaySelected : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => selectDate(day)}
                    disabled={disabled}
                  >
                    {day.getDate()}
                  </button>
                )
              })}
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}

const AGENT_ARCHETYPES = [
  {
    id: 'maxer',
    name: 'Yield Maxer',
    description: 'Leveraged growth via Pendle & GMX perps.',
    apy: '52.4',
    risk: 'Aggressive',
    t: 0.95,
    icon: '🚀',
  },
  {
    id: 'balanced',
    name: 'Delta Neutral',
    description: 'Hedged yield via Uniswap V3 & Aave.',
    apy: '22.1',
    risk: 'Balanced',
    t: 0.5,
    icon: '⚖️',
  },
  {
    id: 'safe',
    name: 'Stable Guard',
    description: 'Capital preservation via Aave & Morpho.',
    apy: '9.8',
    risk: 'Conservative',
    t: 0.1,
    icon: '🛡️',
  },
  {
    id: 'custom',
    name: 'Custom Architect',
    description: 'Design your own custom yield strategy.',
    apy: '--',
    risk: 'Custom',
    t: 0.35,
    icon: '🛠️',
  },
]

function ScreenBuildAgent({
  name, setName,
  tValue, setT,
  archetypeId, setArchetypeId,
  amount, setAmount,
  expiryDate, setExpiryDate,
  eoaBalance, smartBalance,
  preparing, error, onPrepare
}: {
  name: string; setName: (v: string) => void;
  tValue: number; setT: (v: number) => void;
  archetypeId: string | null; setArchetypeId: (v: string | null) => void;
  amount: number; setAmount: (v: number) => void;
  expiryDate: string; setExpiryDate: (v: string) => void;
  eoaBalance: number; smartBalance: number;
  preparing: boolean; error: string; onPrepare: () => void
}) {
  const dialSize = useDialSize()
  const { apy, drawdown } = valuesAtT(tValue)
  const active = activeProtocolSet(tValue)
  const { min, max } = getPolicyExpiryBounds()
  const identityInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const input = identityInputRef.current
    if (!input) return
    input.focus()
    const caretPosition = input.value.length
    input.setSelectionRange(caretPosition, caretPosition)
  }, [])

  const handleArchetypeSelect = (a: typeof AGENT_ARCHETYPES[0]) => {
    setArchetypeId(a.id)
    if (a.id !== 'custom') {
      setName(a.name)
      setT(a.t)
    }
  }

  const handleManualTChange = (v: number) => {
    setT(v)
    
    
  }

  return (
    <div className={s.screenInner} style={{ maxWidth: 1120, margin: '0 auto', paddingTop: 20 }}>
      <p className={s.screen2StepBadge}>Configure agent</p>

      <div className={s.archetypeGrid}>
        {AGENT_ARCHETYPES.map((a) => {
          const isSelected = archetypeId === a.id
          return (
            <button key={a.id} type="button" className={`${s.archetypeCard} ${isSelected ? s.archetypeCardSelected : ''}`} onClick={() => handleArchetypeSelect(a)}>
              <div className={s.archetypeIcon}>{a.icon}</div>
              <div className={s.archetypeBody}>
                <div className={s.archetypeHeader}>
                  <span className={s.archetypeName}>{a.name}</span>
                  <span className={`${s.archetypeRisk} ${s[`risk${a.risk}`]}`}>{a.risk}</span>
                </div>
                <p className={s.archetypeDesc}>{a.description}</p>
                <div className={s.archetypeFooter}>
                  <span className={s.archetypeApyLabel}>Est. APY</span>
                  <span className={s.archetypeApyValue}>{a.apy}%</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className={s.screen2Panels} style={{ marginTop: 32 }}>
        <section className={`${s.screen2Panel} ${s.screen2PanelDial}`}>
          <div className={s.screen4Lbl}>Agent identity</div>
          <input
            ref={identityInputRef}
            className={`${s.input} ${s.screen2IdentityInput}`}
            style={{ marginTop: 12, textAlign: 'left' }}
            placeholder="Yield Maxer"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />

          <div className={s.screen2DialSection}>
            <div className={s.screen4Lbl}>Fine-tune strategy</div>
            <div className={s.screen2DialWrap}>
              <Dial value={tValue} onChange={handleManualTChange} size={dialSize} />
            </div>
            <div className={s.screen2ChipRow}>
              <span className={s.statChip}><span className={s.statLbl}>Min APY</span> <span className={s.statVal}>{apy}%</span></span>
              <span className={s.statChip}><span className={s.statLbl}>Max drawdown</span> <span className={s.statVal}>{drawdown}%</span></span>
            </div>
          </div>
        </section>

        <section className={`${s.screen2Panel} ${s.screen2PanelVenues}`}>
          <div className={s.screen2FieldGrid}>
            <div className={s.screen2AmountBlock}>
              <div className={s.screen2AmountLabel}>Initial funding</div>
              <div className={s.screen2AmountField}>
                <span className={s.screen2AmountPrefix}>$</span>
                <input type="number" min={1} className={s.screen2AmountInput} value={amount} onChange={(e) => setAmount(Math.max(1, parseInt(e.target.value || '0', 10)))} />
                <button type="button" className={s.screen2AmountMax} onClick={() => setAmount(Math.max(1, Math.floor(eoaBalance)))}>MAX</button>
              </div>
            </div>

            <div className={s.screen2AmountBlock}>
              <div className={s.screen2AmountLabel}>Expires in {formatExpiryInLabel(expiryDate)}</div>
              <ExpiryCalendarPicker value={expiryDate} onChange={setExpiryDate} />
              <div className={s.screen2AmountHint}>Choose a date between {formatExpiryLabel(min)} and {formatExpiryLabel(max)}.</div>
            </div>
          </div>

          <div className={s.policyCard} style={{ marginTop: 24, width: '100%' }}>
            <div className={s.policyRow}><span className={s.policyRowLabel}>EOA Balance</span><span className={s.policyRowValue}>${eoaBalance.toLocaleString()} USDC</span></div>
            <div className={s.policyRow}><span className={s.policyRowLabel}>Smart account</span><span className={s.policyRowValue}>${smartBalance.toLocaleString()} USDC</span></div>
          </div>

          <p className={s.screen2ProtocolsHead} style={{ marginTop: 28 }}>The agent can route across</p>
          <div className={s.screen2ProtocolGrid}>
            {PROTOCOLS.map((p) => (
              <div key={p.id} className={`${s.protocolTile} ${active.has(p.id) ? s.protocolTileActive : s.protocolTileInactive}`}>
                <ProtocolMark id={p.id} size={24} />
                <div className={s.protocolBody}>
                  <span className={s.protocolTileName}>{p.name}</span>
                  <span className={s.protocolTileKind}>{p.kind}</span>
                </div>
              </div>
            ))}
          </div>
          
          {amount >= 1 && amount > eoaBalance + smartBalance && (
            <div style={{ display:'flex', alignItems:'center', gap:8, background:'rgba(239,68,68,0.06)', border:'1px solid rgba(239,68,68,0.18)', borderRadius:10, padding:'10px 14px', marginTop:14, fontSize:13, color:'#dc2626', fontWeight:500, width:'100%' }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              You need {(amount - eoaBalance - smartBalance).toFixed(2)} more USDC. Bridge or buy USDC on Arbitrum first.
            </div>
          )}
          {error && <div className={s.policyError} style={{ marginTop: 18, width: '100%' }}>{error}</div>}
          <button className={`${s.btn} ${s.btnLg}`} style={{ marginTop: 26, width: '100%' }} onClick={onPrepare} disabled={preparing || amount < 1 || amount > eoaBalance + smartBalance}>
            {preparing ? 'Preparing account…' : error ? 'Retry funding' : 'Fund & prepare agent'}
          </button>
        </section>
      </div>
    </div>
  )
}

function ScreenReviewV2({ name, amount, chain, tValue, expiryDate, smartAccountAddress, agentDelegateAddress, signing, error, onSignAndActivate }: { name: string; amount: number; chain: string; tValue: number; expiryDate: string; smartAccountAddress: string; agentDelegateAddress: string; signing: boolean; error: string; onSignAndActivate: () => void }) {
  const { apy, drawdown } = valuesAtT(tValue)
  return (
    <div className={s.screenInner} style={{ maxWidth: 760, margin: '0 auto', paddingTop: 24 }}>
      <p className={s.policyStepBadge}>Review and sign</p>
      <h1 className={s.policyTitle} style={{ textAlign: 'left' }}>Review and sign delegation</h1>
      <p className={s.policySubtitle} style={{ textAlign: 'left' }}>Your signature binds the agent to your policy terms.</p>
      <div className={s.policyCard} style={{ marginTop: 24 }}>
        <div className={s.policyRow}><span className={s.policyRowLabel}>Agent name</span><span className={s.policyRowValue}>{name || 'My agent'}</span></div>
        <div className={s.policyRow}><span className={s.policyRowLabel}>Network</span><span className={s.policyRowValue}>{NETWORKS.find(n => n.id === chain)?.name ?? chain}</span></div>
        <div className={s.policyRow}><span className={s.policyRowLabel}>Managed amount</span><span className={s.policyRowValue}>${amount.toLocaleString()} USDC</span></div>
        <div className={s.policyRow}><span className={s.policyRowLabel}>Minimum APY</span><span className={s.policyRowValue}>{apy}%</span></div>
        <div className={s.policyRow}><span className={s.policyRowLabel}>Max drawdown</span><span className={s.policyRowValue}>{drawdown}%</span></div>
        <div className={s.policyRow}><span className={s.policyRowLabel}>Expires in</span><span className={s.policyRowValue}>{formatExpiryInLabel(expiryDate)}</span></div>
        <div className={s.policyRow} style={{ alignItems: 'flex-start' }}><span className={s.policyRowLabel}>Smart account</span><span className={s.policyRowValue} style={{ maxWidth: 420, textAlign: 'right', wordBreak: 'break-all' }}>{smartAccountAddress}</span></div>
      </div>
      {error && <div className={s.policyError} style={{ marginTop: 18 }}>{error}</div>}
      <button className={`${s.btn} ${s.btnLg} ${s.btnDark}`} style={{ marginTop: 28, width: '100%' }} onClick={onSignAndActivate} disabled={signing}>
        {signing ? 'Signing…' : error ? 'Retry signing' : 'Sign & activate agent'}
      </button>
    </div>
  )
}

const TOKEN_LOGOS_ACT: Record<string, string> = {
  WETH:  'https://icons.llamao.fi/icons/tokens/ethereum?w=48&h=48',
  USDC:  'https://icons.llamao.fi/icons/tokens/usdc?w=48&h=48',
  ARB:   'https://icons.llamao.fi/icons/tokens/arbitrum?w=48&h=48',
  WBTC:  'https://icons.llamao.fi/icons/tokens/wrapped-bitcoin?w=48&h=48',
  PENDLE:'https://icons.llamao.fi/icons/protocols/pendle?w=48&h=48',
}

function TokenMarkAct({ symbol, size = 20 }: { symbol: string; size?: number }) {
  const src = TOKEN_LOGOS_ACT[symbol]
  if (src) return <LogoCircle src={src} alt={symbol} size={size} />
  return (
    <div style={{ width: size, height: size, background: '#ccc', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: size * 0.4 }}>
      {symbol[0]}
    </div>
  )
}

function GekoMarkAct({ size = 64, color = 'var(--primary)', variant = 'default' }: { size?: number; color?: string; variant?: 'default' | 'info' }) {
  const mainColor = variant === 'info' ? '#3b82f6' : color
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none" aria-label="YieldGeko">
      <circle cx="40" cy="40" r="36" stroke={mainColor} strokeWidth="2" opacity="0.18" />
      <path d="M40 14c14 0 24 10 24 24a18 18 0 0 1-30 13c2 4 6 7 11 7v6c-12 0-22-9-22-22 0-15 7-28 17-28z" fill={mainColor} />
      {variant === 'default' && <circle cx="48" cy="32" r="3" fill="#0B0C0E" />}
    </svg>
  )
}

const CHAIN_SCAN   = 'https://chainscan.0g.ai'
const STORAGE_SCAN = 'https://storagescan.0g.ai/submission'

type ProofRecord = {
  arbitrumTxHash: string | null   
  teeAttest:      string | null   
  chainTx:        string | null   
  chainExplorer:  string | null   
  storageCID:     string | null   
  receiptHash:    string | null   
}

function SpinnerDot() {
  return (
    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', border: '1.5px solid #ea580c', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
  )
}

function ProofModalAct({ isOpen, onClose, proofs }: { isOpen: boolean; onClose: () => void; proofs: ProofRecord }) {
  if (!isOpen) return null

  const arbHref    = proofs.arbitrumTxHash ? `https://arbiscan.io/tx/${proofs.arbitrumTxHash}` : null
  const chainHref  = proofs.chainExplorer ?? (proofs.chainTx ? `${CHAIN_SCAN}/tx/${proofs.chainTx}` : null)
  const traceHref  = proofs.storageCID   ? `${STORAGE_SCAN}/${proofs.storageCID}`  : null
  const attestHref = proofs.teeAttest    ? `${STORAGE_SCAN}/${proofs.teeAttest}`   : null
  const verifyHref = proofs.receiptHash
    ? `/verify/${proofs.receiptHash}${proofs.chainTx ? `?tx=${proofs.chainTx}` : ''}`
    : null

  const items = [
    {
      label: 'Arbitrum TX',
      value: proofs.arbitrumTxHash ? 'Confirmed on-chain' : 'Confirming…',
      desc:  'On-chain execution proof on Arbitrum.',
      id:    proofs.arbitrumTxHash ? `${proofs.arbitrumTxHash.slice(0, 10)}…${proofs.arbitrumTxHash.slice(-6)}` : '—',
      href:  arbHref,
      icon:  null,
      done:  !!proofs.arbitrumTxHash,
    },
    {
      label: 'TEE Attestation',
      value: proofs.teeAttest  ? 'NVIDIA H100 Verified' : 'Generating attestation…',
      desc:  'Secure computation isolated from host access.',
      id:    proofs.teeAttest  ? `${proofs.teeAttest.slice(0, 8)}…${proofs.teeAttest.slice(-6)}` : 'Awaiting attestation',
      href:  attestHref,
      icon:  null,
      done:  !!proofs.teeAttest,
    },
    {
      label: '0G Chain Anchor',
      value: proofs.chainTx    ? 'Anchored on-chain'    : 'Anchoring on 0G…',
      desc:  'Immutable registration record on 0G consensus.',
      id:    proofs.chainTx    ? `${proofs.chainTx.slice(0, 8)}…${proofs.chainTx.slice(-6)}` : '—',
      href:  chainHref,
      icon:  '0g',
      done:  !!proofs.chainTx,
    },
    {
      label: '0G Storage Hash',
      value: proofs.storageCID ? 'Log Persisted'        : 'Uploading to 0G…',
      desc:  'Decentralized state history verified by hash.',
      id:    proofs.storageCID ? `${proofs.storageCID.slice(0, 8)}…${proofs.storageCID.slice(-6)}` : '—',
      href:  traceHref,
      icon:  '0g',
      done:  !!proofs.storageCID,
    },
  ]

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }} onClick={onClose}>
      <div style={{ background: 'var(--background)', width: '100%', maxWidth: 480, borderRadius: 24, padding: 32, border: '1px solid var(--border)', boxShadow: '0 20px 50px rgba(0,0,0,0.1)', position: 'relative' }} onClick={e => e.stopPropagation()}>
        <button onClick={onClose} style={{ position: 'absolute', top: 20, right: 20, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ width: 56, height: 56, background: '#f0fdf4', color: '#16a34a', borderRadius: '50%', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid #dcfce7' }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></svg>
          </div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>Proof of Integrity</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9375rem', marginTop: 4 }}>Cryptographic provenance for your agent.</p>
        </div>

        <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((item, i) => (
            <div key={i} style={{ padding: 14, borderRadius: 14, background: 'var(--surface)', border: `1px solid ${item.done ? 'rgba(22,163,74,0.25)' : 'var(--border)'}`, transition: 'border-color 0.4s' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {item.icon === '0g' && <ChainMark id="0g" size={13} />}
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{item.label}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  {!item.done && <SpinnerDot />}
                  <span style={{ fontSize: 11, fontWeight: 600, color: item.done ? '#16a34a' : '#ea580c' }}>{item.value}</span>
                </div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 6 }}>{item.desc}</div>
              {item.href ? (
                <a href={item.href} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
                  <div style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', background: 'var(--background)', padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.id}
                  </div>
                  <span style={{ fontSize: 11, color: '#16a34a', flexShrink: 0 }}>↗</span>
                </a>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', background: 'var(--background)', padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border)' }}>
                  {item.id}
                </div>
              )}
            </div>
          ))}
        </div>

        
        {verifyHref && (
          <a href={verifyHref} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 16, padding: '10px 0', borderRadius: 10, background: 'var(--surface)', border: '1px solid var(--border)', textDecoration: 'none', color: 'var(--text-muted)', fontSize: 13, fontWeight: 600 }}>
            View full independent proof
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
          </a>
        )}

        <button className={s.btn} style={{ width: '100%', marginTop: 12, height: 50 }} onClick={onClose}>Got it</button>
      </div>
    </div>
  )
}

function toUiPhase(backendPhase: string): string {
  switch (backendPhase) {
    case 'INITIALIZING': return 'REGISTERING'
    case 'IDLE':         return 'EVALUATING'
    case 'MONITORING':   return 'EVALUATING'
    case 'ALLOCATED':    return 'EXECUTING'
    case 'REBALANCING':  return 'EXECUTING'
    default:             return 'REGISTERING'
  }
}

function toProtocolId(strategyType: string): string {
  switch (strategyType) {
    case 'AAVE_LENDING':    case 'LEVERAGED_LOOP': return 'aave'
    case 'MORPHO_LENDING':  return 'morpho'
    case 'PENDLE_LP':       case 'PENDLE_PT':      case 'PENDLE_YT': return 'pendle'
    case 'GMX_REAL_YIELD':  return 'gmx'
    default:                return 'uniswap'
  }
}

function toProtocolName(strategyType: string): string {
  switch (strategyType) {
    case 'AAVE_LENDING':    return 'Aave V3'
    case 'LEVERAGED_LOOP':  return 'Aave V3 (Looped)'
    case 'MORPHO_LENDING':  return 'Morpho Blue'
    case 'PENDLE_LP':       return 'Pendle Finance'
    case 'PENDLE_PT':       return 'Pendle PT'
    case 'PENDLE_YT':       return 'Pendle YT'
    case 'GMX_REAL_YIELD':  return 'GMX V2'
    default:                return 'Uniswap V3'
  }
}

function parsePairFromVenueName(venueName: string): { tokens: string[]; pair: string } {
  if (!venueName) return { tokens: [], pair: '—' }
  const m = venueName.match(/^([A-Z]+)[\/\-]([A-Z]+)/)
  if (m) return { tokens: [m[1], m[2]], pair: `${m[1]} / ${m[2]}` }
  return { tokens: [], pair: venueName }
}

const ACTIVATION_TIMEOUT_MS = 10 * 60 * 1000  

function ScreenActivationV2({ strategyId, onView }: { strategyId: string | null; onView: () => void }) {
  const [uiPhase, setUiPhase]       = useState('REGISTERING')
  const [ready, setReady]           = useState(false)
  const [timedOut, setTimedOut]     = useState(false)
  const [error, setError]           = useState('')
  const [subIdx, setSubIdx]         = useState(0)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [deployment, setDeployment] = useState<{
    protocol: string; protocolId: string; pair: string; tokens: string[]; apy: string; network: string
  }>({ protocol: 'Uniswap V3', protocolId: 'uniswap', pair: 'WETH / USDC', tokens: ['WETH', 'USDC'], apy: '—', network: 'Arbitrum' })
  const [proofs, setProofs] = useState<ProofRecord>({
    arbitrumTxHash: null, teeAttest: null, chainTx: null,
    chainExplorer: null, storageCID: null, receiptHash: null,
  })

  const agentBase = (process.env.NEXT_PUBLIC_AGENT_SSE_URL ?? 'http://localhost:3001/events').replace('/events', '')
  const sseBase   = process.env.NEXT_PUBLIC_AGENT_SSE_URL  ?? 'http://localhost:3001/events'

  
  useEffect(() => {
    if (!strategyId) return
    const es = new EventSource(`${sseBase}?userId=${encodeURIComponent(strategyId)}`)
    es.onmessage = (event) => {
      try {
        const evt = JSON.parse(event.data)

        
        if (evt.type === 'EXECUTION' && evt.payload?.record) {
          const rec = evt.payload.record
          const isDecision = ['GENESIS', 'MIGRATE', 'REBALANCE'].includes(rec.action ?? '')
          if (isDecision) {
            setProofs(prev => ({
              ...prev,
              arbitrumTxHash: rec.txHash      ?? prev.arbitrumTxHash,
              receiptHash:    rec.receiptHash  ?? prev.receiptHash,
              teeAttest:      rec.zgAttestCID  ?? prev.teeAttest,
              chainTx:        rec.zgChainTxHash ?? prev.chainTx,
              chainExplorer:  rec.zgChainExplorer ?? prev.chainExplorer,
              storageCID:     rec.zgTraceCID   ?? prev.storageCID,
            }))
            if (rec.txHash) setReady(true)
          }
        }

        
        if (evt.type === 'PROOF_UPDATE' && evt.payload?.userId === strategyId) {
          const snap = evt.payload.snapshot
          setProofs(prev => ({
            ...prev,
            arbitrumTxHash: snap.arbitrumTxHash  ?? prev.arbitrumTxHash,
            teeAttest:      snap.zgAttestCID      ?? prev.teeAttest,
            chainTx:        snap.zgChainTxHash    ?? prev.chainTx,
            chainExplorer:  snap.zgChainExplorer  ?? prev.chainExplorer,
            storageCID:     snap.zgTraceCID       ?? prev.storageCID,
          }))
        }
      } catch {  }
    }
    return () => es.close()
  }, [strategyId, sseBase])

  
  useEffect(() => {
    if (!strategyId) return
    let cancelled = false

    const poll = async () => {
      try {
        const res = await fetch(`${agentBase}/state/${strategyId}`)
        if (!res.ok || cancelled) return
        const data = await res.json()
        if (cancelled) return

        setUiPhase(toUiPhase(data.phase ?? ''))
        if (data.phase === 'PAUSED') setError('The agent is live but finalizing on-chain synchronization.')

        const pos = data.portfolio?.positions?.[0]
        if (pos) {
          const { tokens, pair } = parsePairFromVenueName(pos.venueName ?? '')
          setDeployment({
            protocol:   toProtocolName(pos.strategyType ?? ''),
            protocolId: toProtocolId(pos.strategyType ?? ''),
            pair:       pair || pos.venueName || 'WETH / USDC',
            tokens:     tokens.length ? tokens : ['WETH', 'USDC'],
            apy:        typeof pos.currentNetAPY === 'number' ? pos.currentNetAPY.toFixed(1) : '—',
            network:    'Arbitrum',
          })
        }

        
        const genesis = Array.isArray(data.executions)
          ? data.executions.find((e: any) => ['GENESIS', 'MIGRATE', 'REBALANCE'].includes(e?.action))
          : null
        if (genesis) {
          setProofs(prev => ({
            arbitrumTxHash: genesis.txHash           ?? prev.arbitrumTxHash,
            teeAttest:      genesis.zgAttestCID      ?? prev.teeAttest,
            chainTx:        genesis.zgChainTxHash    ?? prev.chainTx,
            chainExplorer:  genesis.zgChainExplorer  ?? prev.chainExplorer,
            storageCID:     genesis.zgTraceCID       ?? prev.storageCID,
            receiptHash:    genesis.receiptHash      ?? prev.receiptHash,
          }))
          if (genesis.txHash) { setReady(true); setError('') }
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      }
    }

    poll()
    const id  = setInterval(poll, 30_000)   
    const tid = setTimeout(() => { if (!cancelled) setTimedOut(true) }, ACTIVATION_TIMEOUT_MS)
    return () => { cancelled = true; clearInterval(id); clearTimeout(tid) }
  }, [strategyId, agentBase])

  
  useEffect(() => {
    const t = setInterval(() => setSubIdx(prev => (prev + 1) % 4), 2800)
    return () => clearInterval(t)
  }, [])

  const handleRetry = async () => {
    setError('')
    setUiPhase('REGISTERING')
    if (!strategyId) return
    try {
      const agentKey = process.env.NEXT_PUBLIC_AGENT_API_KEY ?? ''
      await fetch(`${agentBase}/api/resume-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(agentKey ? { Authorization: `Bearer ${agentKey}` } : {}) },
        body: JSON.stringify({ userId: strategyId }),
      })
    } catch {  }
  }

  const registryMessages  = ['Securing execution environment…', 'Establishing vault authority…', 'Preparing strategy rail…']
  const evaluationMessages = ['Scanning Uniswap V3 pools…', 'Checking Pendle yield markets…', 'Evaluating Aave lending rates…', 'Optimizing gas-efficient routes…']
  const executionMessages  = ['Provisioning position on-chain…', 'Opening strategy venue…', 'Depositing collateral…', 'Finalizing strategy entry…']
  const proofRibbon = [
    { label: 'TEE',       value: 'Verified by NVIDIA Attestation', icon: null },
    { label: '0G CHAIN',  value: 'Anchoring Registration…',        icon: '0g' },
    { label: '0G STORAGE',value: 'Persisting State History…',       icon: '0g' },
  ]

  const isInfoState = !!error
  const isSuccess   = ready && !error

  const getSubtext = () => {
    if (isInfoState) return 'Your funds are securely held in your smart account. The agent is being initialized with extra verification.'
    if (isSuccess)   return 'Strategy successfully engaged on-chain.'
    switch (uiPhase) {
      case 'REGISTERING': return registryMessages[subIdx % registryMessages.length]
      case 'EVALUATING':  return evaluationMessages[subIdx % evaluationMessages.length]
      case 'EXECUTING':   return executionMessages[subIdx % executionMessages.length]
      default:            return 'Initializing agent intelligence…'
    }
  }

  return (
    <div className={s.screenInner} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--foreground)', padding: '0 24px', position: 'relative' }}>
      <div style={{ position: 'relative', width: 100, height: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 40 }}>
        {!isSuccess && !isInfoState && <div className={s.spinSlow}><GekoMarkAct size={64} /></div>}
        {isSuccess && (
          <div className={s.fadeUp} style={{ animationDelay: '0ms' }}>
            <span className={s.pulseRing} style={{ position: 'absolute', inset: -8, borderRadius: '50%', border: '2.5px solid var(--earn)', display: 'block' }} />
            <GekoMarkAct size={64} color="var(--earn)" />
          </div>
        )}
        {isInfoState && (
          <div className={s.fadeUp} style={{ animationDelay: '0ms' }}>
            <GekoMarkAct size={64} variant="info" />
          </div>
        )}
      </div>

      <div style={{ textAlign: 'center', maxWidth: 640 }}>
        <div className={s.activationTitle} style={{ fontSize: '1.75rem', fontWeight: 600, letterSpacing: '-0.01em', marginBottom: 10, color: isInfoState ? '#3b82f6' : 'var(--foreground)' }}>
          {isInfoState ? 'Activation in Review' : isSuccess ? 'Strategy Engaged' : 'Provisioning Agent'}
        </div>

        <div key={getSubtext()} className={s.fadeUp} style={{ fontSize: '1.0625rem', color: 'var(--text-muted)', fontWeight: 450, lineHeight: 1.5, marginBottom: isSuccess || isInfoState ? 32 : 0 }}>
          {getSubtext()}
        </div>

        
        {timedOut && !ready && !error && (
          <div className={s.fadeUp} style={{ marginTop: 24, padding: '16px 20px', borderRadius: 14, background: 'rgba(245,158,11,0.06)', color: '#b45309', fontSize: '0.875rem', fontWeight: 500, border: '1px solid rgba(245,158,11,0.18)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span>Taking longer than expected — your strategy is being deployed on-chain.</span>
            </div>
            <button className={s.btn} style={{ height: 42, fontSize: '0.875rem', padding: '0 20px' }} onClick={onView}>
              View dashboard anyway →
            </button>
          </div>
        )}

        {(isSuccess || isInfoState) && (
          <div className={s.fadeUp} style={{ animationDelay: '400ms', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 20, padding: '24px', display: 'flex', flexDirection: 'column', gap: 16, boxShadow: '0 8px 32px rgba(0,0,0,0.06)', width: '100%', minWidth: 320, margin: '0 auto', position: 'relative' }}>
            
            <div style={{ position: 'absolute', top: -12, right: 24, display: 'flex', alignItems: 'center', gap: 0 }}>
              <div onClick={() => setIsModalOpen(true)} style={{ background: isInfoState ? '#3b82f6' : '#16a34a', color: '#fff', padding: '4px 10px', borderRadius: proofs.receiptHash ? '20px 0 0 20px' : 20, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', border: '2px solid var(--background)', borderRight: proofs.receiptHash ? 'none' : undefined, boxShadow: `0 4px 10px ${isInfoState ? 'rgba(59,130,246,0.2)' : 'rgba(22,163,74,0.2)'}` }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>
                {isInfoState ? 'SYSTEM SECURE' : 'VERIFIED PROOF'}
              </div>
              {proofs.receiptHash && (
                <a href={`/verify/${proofs.receiptHash}${proofs.chainTx ? `?tx=${proofs.chainTx}` : ''}`} target="_blank" rel="noopener noreferrer" style={{ background: isInfoState ? '#3b82f6' : '#16a34a', color: '#fff', padding: '4px 8px', borderRadius: '0 20px 20px 0', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', border: '2px solid var(--background)', borderLeft: '1px solid rgba(255,255,255,0.25)', textDecoration: 'none', boxShadow: `0 4px 10px ${isInfoState ? 'rgba(59,130,246,0.2)' : 'rgba(22,163,74,0.2)'}` }}>
                  ↗
                </a>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <ProtocolMark id={deployment.protocolId} size={36} />
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Target Venue</div>
                  <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--foreground)' }}>{deployment.protocol}</div>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Projected Yield</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
                  <span style={{ fontSize: 20, fontWeight: 800, color: isInfoState ? '#3b82f6' : 'var(--earn)' }}>{deployment.apy}%</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>APY</span>
                </div>
              </div>
            </div>

            <div style={{ height: 1, background: 'var(--border)', opacity: 0.6 }} />

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {deployment.tokens.length >= 2 && (
                  <div style={{ display: 'flex', marginRight: 4 }}>
                    <TokenMarkAct symbol={deployment.tokens[0]} size={24} />
                    <div style={{ marginLeft: -10 }}><TokenMarkAct symbol={deployment.tokens[1]} size={24} /></div>
                  </div>
                )}
                <span style={{ fontSize: 15, fontWeight: 650, color: 'var(--foreground)' }}>{deployment.pair}</span>
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--background)', padding: '4px 10px', borderRadius: 20, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <ChainMark id="arbitrum" size={14} />
                {deployment.network}
              </div>
            </div>

            
            <div style={{ marginTop: 4, padding: '8px 12px', background: 'rgba(0,0,0,0.02)', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, border: '1px dashed var(--border)' }}>
              <ChainMark id="0g" size={16} />
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.02em' }}>SECURED BY 0G NETWORK</span>
            </div>
          </div>
        )}

        {isInfoState && (
          <div className={s.fadeUp} style={{ marginTop: 24, padding: '16px 20px', borderRadius: 14, background: 'rgba(59, 130, 246, 0.04)', color: '#3b82f6', fontSize: '0.875rem', fontWeight: 500, border: '1px solid rgba(59, 130, 246, 0.12)', display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
            <span>The agent is live but finalizing on-chain synchronization.</span>
          </div>
        )}

        {(isSuccess || isInfoState) && (
          <button className={`${s.btn} ${s.fadeUp}`} style={{ animationDelay: '800ms', marginTop: 40, width: '100%', height: 54, fontSize: '1rem', fontWeight: 600 }} onClick={onView}>
            Enter Dashboard →
          </button>
        )}

        {isInfoState && (
          <button className={s.fadeUp} style={{ marginTop: 16, background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }} onClick={handleRetry}>
            Retry Synchronization
          </button>
        )}
      </div>

      
      {!isSuccess && !isInfoState && (
        <div style={{ position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 4px 15px rgba(0,0,0,0.05)', animation: 'fadeUp 400ms ease-out both' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, borderRight: '1px solid var(--border)', paddingRight: 12 }}>
            {proofRibbon[subIdx % proofRibbon.length].icon === '0g' && <ChainMark id="0g" size={14} />}
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{proofRibbon[subIdx % proofRibbon.length].label}</span>
          </div>
          <span key={proofRibbon[subIdx % proofRibbon.length].value} className={s.fadeUp} style={{ fontSize: 13, fontWeight: 550, color: 'var(--foreground)' }}>{proofRibbon[subIdx % proofRibbon.length].value}</span>
        </div>
      )}

      <ProofModalAct isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} proofs={proofs} />
    </div>
  )
}

export default function AgentFlow({ mode }: { mode: 'onboard' | 'create' }) {
  const router = useRouter(), { address } = useAccount(), chainId = useChainId(), { switchChain } = useSwitchChain(), { data: walletClient } = useWalletClient()
  const [screen, setScreen] = useState(mode === 'onboard' ? 0 : 1), [direction, setDirection] = useState(1), [isMounted, setIsMounted] = useState(false)
  const [chain, setChain] = useState('arbitrum'), [name, setName] = useState(''), [tValue, setT] = useState(0.35), [amount, setAmount] = useState(10), [expiryDate, setExpiryDate] = useState(() => getPolicyExpiryBounds().min), [error, setError] = useState('')
  const [archetypeId, setArchetypeId] = useState<string | null>(null)
  const [smartAccountAddress, setSmartAccountAddress] = useState(''), [smartAccountDeployed, setSmartAccountDeployed] = useState(false), [smartAccountLoading, setSmartAccountLoading] = useState(false), [smartAccountBalance, setSmartAccountBalance] = useState(0)
  const [agentDelegateAddress, setAgentDelegateAddress] = useState(''), [preparingStrategy, setPreparingStrategy] = useState(false), [signingStrategy, setSigningStrategy] = useState(false), [registeredId, setRegisteredId] = useState<string | null>(null), [draftId, setDraftId] = useState<string | null>(null)
  const [agentHealth, setAgentHealth] = useState<'idle' | 'ok' | 'down'>('idle')
  const [existingStrategies, setExistingStrategies] = useState<any[]>([])
  const [showResumeModal, setShowResumeModal] = useState(false)
  const smartAccountRef = useRef<MetaMaskSmartAccount<Implementation.Hybrid> | null>(null), hasCheckedRef = useRef(false), publicClient = usePublicClient({ chainId: arbitrum.id })

  useEffect(() => { setIsMounted(true) }, [])

  
  
  const hadAddressRef = useRef(false)
  useEffect(() => {
    if (address) { hadAddressRef.current = true; return }
    if (hadAddressRef.current && screen > 0 && screen < 5) {
      setDirection(-1); setScreen(0)
      setError('Your wallet disconnected. Please reconnect to continue.')
    }
  }, [address, screen])

  const { data: usdcNonce } = useReadContract({ address: USDC_ADDRESS, abi: USDC_NONCE_ABI, functionName: 'nonces', args: address ? [address] : undefined, query: { enabled: !!address } })
  const { data: usdcBalanceRaw } = useReadContract({ address: USDC_ADDRESS, abi: USDC_NONCE_ABI, functionName: 'balanceOf', args: address ? [address] : undefined, query: { enabled: !!address } })
  const usdcBalance = (!isMounted || !address) ? 0 : usdcBalanceRaw !== undefined ? parseFloat(formatUnits(usdcBalanceRaw as bigint, 6)) : 0

  useEffect(() => {
    if (mode === 'onboard' && address && screen === 0) {
      if (!hasCheckedRef.current) { setScreen(1); hasCheckedRef.current = true }
      else { const tid = setTimeout(() => { setDirection(1); setScreen(1) }, 600); return () => clearTimeout(tid) }
    }
  }, [screen, address, mode])

  const goTo = (next: number) => { setDirection(next > screen ? 1 : -1); setScreen(next) }
  const goBack = () => { if (screen > (mode === 'onboard' ? 0 : 1)) goTo(screen - 1) }

  const agentBase = (process.env.NEXT_PUBLIC_AGENT_SSE_URL ?? 'http://localhost:3001/events').replace('/events', '')

  
  useEffect(() => {
    if (screen !== 1 || agentHealth !== 'idle') return
    const check = async () => {
      try {
        const res = await fetch(`${agentBase}/health`, { signal: AbortSignal.timeout(4000) })
        const data = await res.json()
        setAgentHealth(data.ok ? 'ok' : 'down')
        if (data.agentDelegateAddress) setAgentDelegateAddress(data.agentDelegateAddress)
      } catch { setAgentHealth('down') }
    }
    check()
  }, [screen, agentHealth, agentBase])

  
  useEffect(() => {
    if (!address || !isMounted) return
    let cancelled = false
    const check = async () => {
      try {
        const res = await fetch(`${agentBase}/api/strategies/${address}`)
        if (!res.ok || cancelled) return
        const list = await res.json()
        if (cancelled) return
        const active = Array.isArray(list) ? list.filter((s: any) => s.phase !== 'WITHDRAWN') : []
        if (active.length > 0) { setExistingStrategies(active); setShowResumeModal(true) }
      } catch {  }
    }
    check()
    return () => { cancelled = true }
  }, [address, isMounted, agentBase])

  useEffect(() => {
    if (!address || !walletClient || !publicClient || chain !== 'arbitrum') return
    let cancelled = false
    const derive = async () => {
      try {
        setSmartAccountLoading(true)
        const sa = await toMetaMaskSmartAccount({ client: publicClient, implementation: Implementation.Hybrid, deployParams: [address, [], [], []], deploySalt: '0x', signer: { walletClient } })
        const bytecode = await publicClient.getBytecode({ address: sa.address })
        const bal = await publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_NONCE_ABI, functionName: 'balanceOf', args: [sa.address] }) as bigint
        if (cancelled) return
        smartAccountRef.current = sa; setSmartAccountAddress(sa.address); setSmartAccountDeployed(!!bytecode && bytecode !== '0x'); setSmartAccountBalance(Number(formatUnits(bal, 6)))
      } catch (err: any) { if (!cancelled) setError(err.message) }
      finally { if (!cancelled) setSmartAccountLoading(false) }
    }
    derive(); return () => { cancelled = true }
  }, [address, walletClient, publicClient, chain])

  const fetchDelegate = useCallback(async () => {
    if (agentDelegateAddress) return agentDelegateAddress
    try {
      const res = await fetch(`${agentBase}/health`, { signal: AbortSignal.timeout(6000) })
      if (!res.ok) throw new Error(`Agent returned ${res.status}`)
      const data = await res.json()
      if (!data.agentDelegateAddress) throw new Error('Agent did not return a delegate address.')
      setAgentDelegateAddress(data.agentDelegateAddress)
      setAgentHealth('ok')
      return data.agentDelegateAddress as string
    } catch (err: any) {
      setAgentHealth('down')
      throw new Error('Agent server is unreachable. Please try again in a moment or contact support.')
    }
  }, [agentDelegateAddress, agentBase])

  const handlePrepare = useCallback(async () => {
    if (!address || !walletClient || !publicClient || !smartAccountAddress) return
    setError('')
    if (chainId !== arbitrum.id) {
      switchChain({ chainId: arbitrum.id })
      setError('Please approve the network switch to Arbitrum in your wallet, then click Fund & prepare again.')
      return
    }
    setPreparingStrategy(true)
    try {
      const amountRaw = parseUnits(String(amount), 6), delegate = await fetchDelegate(), pimlicoKey = process.env.NEXT_PUBLIC_PIMLICO_API_KEY ?? ''
      const EXECUTOR = (process.env.NEXT_PUBLIC_EXECUTOR_ADDRESS ?? '0x94DE8790BEd6Be0395C6BE7f42FD677b7B8cBcFb') as Address, SWAPPER = (process.env.NEXT_PUBLIC_SWAPPER_ADDRESS ?? '0x4313539C4fF1b93891B6A66D6a2eb690153A1b33') as Address
      const [smartBal, eoaBal, authorized] = await Promise.all([
        publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_NONCE_ABI, functionName: 'balanceOf', args: [smartAccountAddress as Address] }) as Promise<bigint>,
        publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_NONCE_ABI, functionName: 'balanceOf', args: [address as Address] }) as Promise<bigint>,
        publicClient.readContract({ address: ENFORCER_ADDRESS, abi: ENFORCER_ABI, functionName: 'authorizedAgents', args: [delegate as Address] }) as Promise<boolean>,
      ])
      if (!authorized) throw new Error('Agent not authorized in enforcer.')
      const calls: any[] = []
      if (smartBal < amountRaw) {
        const needed = amountRaw - smartBal
        if (eoaBal < needed) throw new Error('Insufficient USDC.')
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
        const sig = await walletClient.signTypedData({ account: walletClient.account as any, domain: { name: 'USD Coin', version: '2', chainId: 42161, verifyingContract: USDC_ADDRESS }, types: PERMIT_TYPES, primaryType: 'Permit', message: { owner: address, spender: smartAccountAddress as Address, value: needed, nonce: usdcNonce as bigint, deadline } })
        const { v, r, s } = { v: Number('0x' + sig.slice(130, 132)), r: sig.slice(0, 66) as Hex, s: ('0x' + sig.slice(66, 130)) as Hex }
        calls.push({ to: USDC_ADDRESS, value: 0n, data: encodeFunctionData({ abi: USDC_NONCE_ABI, functionName: 'permit', args: [address as Address, smartAccountAddress as Address, needed, deadline, v, r, s] }) })
        calls.push({ to: USDC_ADDRESS, value: 0n, data: encodeFunctionData({ abi: USDC_NONCE_ABI, functionName: 'transferFrom', args: [address as Address, smartAccountAddress as Address, needed] }) })
      }
      calls.push({ to: USDC_ADDRESS, value: 0n, data: encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [EXECUTOR, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')] }) })
      calls.push({ to: USDC_ADDRESS, value: 0n, data: encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [SWAPPER, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')] }) })
      calls.push({ to: USDC_ADDRESS, value: 0n, data: encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [ENFORCER_ADDRESS, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')] }) })
      const pimlicoClient = createPimlicoClient({ transport: viemHttp(`https://api.pimlico.io/v2/42161/rpc?apikey=${pimlicoKey}`), entryPoint: { address: '0x0000000071727De22E5E9d8BAf0edAc6f37da032', version: '0.7' } })
      const bundler = createBundlerClient({ client: publicClient as any, transport: viemHttp(`https://api.pimlico.io/v2/42161/rpc?apikey=${pimlicoKey}`), paymaster: true, userOperation: { estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast } })
      await bundler.sendUserOperation({ account: smartAccountRef.current as any, calls })
      const finalBal = await publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_NONCE_ABI, functionName: 'balanceOf', args: [smartAccountAddress as Address] }) as bigint
      setSmartAccountBalance(Number(formatUnits(finalBal, 6))); if (!draftId) setDraftId(createDraftStrategyId(name))
      goTo(4)
    } catch (err: any) { setError(err.message) }
    finally { setPreparingStrategy(false) }
  }, [address, amount, chainId, draftId, fetchDelegate, name, publicClient, smartAccountAddress, switchChain, usdcNonce, walletClient])

  const handleActivate = useCallback(async () => {
    if (!address || !publicClient || !smartAccountRef.current || !smartAccountAddress) return
    setError(''); setSigningStrategy(true)
    try {
      const amountRaw = parseUnits(String(amount), 6), delegate = await fetchDelegate(), { apy, drawdown } = valuesAtT(tValue), expiresAt = BigInt(expiryDateToUnix(expiryDate))
      const policyTerms = encodeAbiParameters(parseAbiParameters('uint256, uint256, uint256, uint256, address, uint256, address'), [BigInt(Math.round(apy * 100)), BigInt(drawdown * 100), amountRaw, 1000n, TREASURY_ADDRESS, expiresAt, USDC_ADDRESS]) as Hex
      const delegation = { delegate: delegate as Hex, delegator: smartAccountAddress as Hex, authority: ROOT_AUTHORITY, caveats: [createCaveat(ENFORCER_ADDRESS, policyTerms, '0x')], salt: ZERO_SALT }
      const signature = await smartAccountRef.current.signDelegation({ delegation })
      
      if (!signature || typeof signature !== 'string' || !signature.startsWith('0x') || signature.length < 130) {
        throw new Error('Delegation signing failed or was rejected. Please try again.')
      }
      const strategyId = draftId ?? createDraftStrategyId(name), agentKey = process.env.NEXT_PUBLIC_AGENT_API_KEY ?? ''
      const res = await fetch(`${agentBase}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(agentKey ? { Authorization: `Bearer ${agentKey}` } : {}) }, body: JSON.stringify({ strategyId, displayName: name || 'My agent', riskTier: riskTierFromT(tValue), managedUSD: amount, minAPY: apy, maxSlippageBps: 50, maxDrawdownPct: drawdown, maxFeeBps: 1000, userAddress: address, chainId: arbitrum.id, smartAccountAddress, signedDelegation: { delegate, delegator: smartAccountAddress, authority: ROOT_AUTHORITY, caveats: delegation.caveats.map(c => ({ enforcer: c.enforcer, terms: c.terms, args: c.args || '0x' })), salt: delegation.salt, signature } }) })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `Server error (${res.status})` }))
        throw new Error(errData.error || `Registration failed (${res.status}). Please try again.`)
      }
      const data = await res.json()
      setRegisteredId(data.userId || strategyId); goTo(5)
    } catch (err: any) { setError(err.message) }
    finally { setSigningStrategy(false) }
  }, [address, amount, draftId, expiryDate, fetchDelegate, name, publicClient, smartAccountAddress, tValue])

  return (
    <div className={`${s.shell} ${screen === 5 ? s.shellDark : ''}`} data-yieldgeko-onboard={ONBOARD_UI_MARK}>
      
      {showResumeModal && existingStrategies.length > 0 && createPortal(
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', backdropFilter:'blur(6px)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999, padding:20 }} onClick={() => setShowResumeModal(false)}>
          <div style={{ background:'var(--background)', maxWidth:460, width:'100%', borderRadius:24, padding:32, border:'1px solid var(--border)', boxShadow:'0 24px 60px rgba(0,0,0,0.15)' }} onClick={e => e.stopPropagation()}>
            <div style={{ textAlign:'center', marginBottom:24 }}>
              <div style={{ width:52, height:52, background:'rgba(234,88,12,0.08)', borderRadius:'50%', margin:'0 auto 14px', display:'flex', alignItems:'center', justifyContent:'center', border:'1.5px solid rgba(234,88,12,0.2)' }}>
                <GekoMark size={32} color="var(--primary)" />
              </div>
              <h2 style={{ fontSize:'1.25rem', fontWeight:700, margin:0 }}>You have an active strategy</h2>
              <p style={{ color:'var(--text-muted)', fontSize:'0.9rem', marginTop:6 }}>Would you like to resume it, or create a new one?</p>
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {existingStrategies.slice(0, 3).map((strat: any) => (
                <button key={strat.userId} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 18px', borderRadius:14, background:'var(--surface)', border:'1px solid var(--border)', cursor:'pointer', textAlign:'left', width:'100%' }}
                  onClick={() => router.push(`/app/strategy/${strat.userId}`)}>
                  <div>
                    <div style={{ fontSize:14, fontWeight:650 }}>{strat.policy?.displayName || strat.userId}</div>
                    <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:2 }}>
                      {strat.phase} · ${strat.policy?.managedUSD?.toLocaleString() ?? '—'} managed
                    </div>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6"/></svg>
                </button>
              ))}
            </div>
            <div style={{ display:'flex', gap:10, marginTop:20 }}>
              <button className={s.btn} style={{ flex:1, height:46, fontSize:'0.9rem' }} onClick={() => { setShowResumeModal(false) }}>
                Create new strategy
              </button>
            </div>
            <button style={{ display:'block', margin:'12px auto 0', background:'none', border:'none', color:'var(--text-muted)', fontSize:'0.8125rem', cursor:'pointer' }} onClick={() => setShowResumeModal(false)}>
              Dismiss
            </button>
          </div>
        </div>,
        document.body
      )}
      {screen < 5 && (
        <nav className={s.onboardNavLeft}>
          <div className={s.onboardNavCluster}>
            {screen >= 0 && (
              <button type="button" className={s.backChevron} onClick={goBack} aria-label="Back">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
            )}
          </div>
        </nav>
      )}
      <div className={s.progressDots}>{[0, 1, 2, 3, 4, 5].map(i => <span key={i} className={`${s.dot} ${i === screen ? s.dotActive : i < screen ? s.dotDone : ''}`} />)}</div>
      <ScreenStage screen={screen} direction={direction}>
        {screen === 0 && <ScreenConnect />}
        {screen === 1 && <Screen0Chain chain={chain} setChain={setChain} onContinue={() => goTo(2)} agentHealth={agentHealth} />}
        {screen === 2 && <ScreenSmartAccount chain={chain} smartAccountAddress={smartAccountAddress} smartAccountDeployed={smartAccountDeployed} loading={smartAccountLoading} error={error} onContinue={() => goTo(3)} />}
        {screen === 3 && <ScreenBuildAgent name={name} setName={setName} tValue={tValue} setT={setT} archetypeId={archetypeId} setArchetypeId={setArchetypeId} amount={amount} setAmount={setAmount} expiryDate={expiryDate} setExpiryDate={setExpiryDate} eoaBalance={usdcBalance} smartBalance={smartAccountBalance} preparing={preparingStrategy} error={error} onPrepare={handlePrepare} />}
        {screen === 4 && <ScreenReviewV2 name={name} amount={amount} chain={chain} tValue={tValue} expiryDate={expiryDate} smartAccountAddress={smartAccountAddress} agentDelegateAddress={agentDelegateAddress} signing={signingStrategy} error={error} onSignAndActivate={handleActivate} />}
        {screen === 5 && <ScreenActivationV2 strategyId={registeredId} onView={() => router.push(registeredId ? `/app/strategy/${registeredId}` : '/app')} />}
      </ScreenStage>
    </div>
  )
}
