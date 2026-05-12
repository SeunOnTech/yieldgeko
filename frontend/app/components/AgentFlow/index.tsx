'use client'

import {
  useState, useCallback, useEffect, useRef,
  type ReactNode,
} from 'react'
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

// ─── Key Constants ────────────────────────────────────────────────────────────

const ONBOARD_UI_MARK = 'yieldgeko-onboard-v3'
const POLICY_DURATION_SECONDS = 365 * 24 * 60 * 60
const PERMIT_WINDOW_SECONDS = 60 * 60
const POLICY_MAX_FEE_BPS = BigInt(1000)
const ZERO_SALT = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

// ─── ABIs ────────────────────────────────────────────────────────────────────

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

// ─── Helper Functions ─────────────────────────────────────────────────────────

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

// ─── Internal Components ──────────────────────────────────────────────────────

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
      {/* eslint-disable-next-line @next/next/no-img-element */}
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

        <path d={trackD} stroke="var(--border)" strokeWidth={stroke} fill="none" strokeLinecap="round" />
        <path d={activeD} stroke="url(#dial-grad)" strokeWidth={stroke} fill="none" strokeLinecap="round" />

        {PRESETS.map((p) => {
          const tk = polar(cx, cy, r, tToTheta(p.t))
          const inner = polar(cx, cy, r - 14, tToTheta(p.t))
          const isActive = Math.abs(p.t - value) < 0.04
          return (
            <line key={p.id}
              x1={inner.x} y1={inner.y} x2={tk.x} y2={tk.y}
              stroke={isActive ? 'var(--text-primary)' : 'var(--text-muted)'}
              strokeWidth={isActive ? 2 : 1}
              strokeLinecap="round"
              opacity={isActive ? 1 : 0.6}
            />
          )
        })}

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

      <div className={s.dialPresetRow} style={{ top: cy + r + 4 }}>
        {PRESETS.map((p) => {
          const isActive = Math.abs(p.t - value) < 0.04
          return (
            <div
              key={p.id}
              className={`${s.dialPresetLbl} ${isActive ? s.dialPresetLblActive : s.dialPresetLblIdle}`}
            >
              {p.label}
            </div>
          )
        })}
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

// ─── Network Data ────────────────────────────────────────────────────────────

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

// ─── Screen Components ────────────────────────────────────────────────────────

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

function Screen0Chain({ chain, setChain, onContinue }: { chain: string; setChain: (c: string) => void; onContinue: () => void }) {
  const ordered = CHAIN_PICK_ORDER.map(id => NETWORKS.find(n => n.id === id)).filter(Boolean) as NetworkDef[]
  const selectedNet = NETWORKS.find(n => n.id === chain) ?? NETWORKS[0]
  return (
    <div className={s.chainStep}>
      <div className={s.chainStepGlow} aria-hidden />
      <div className={s.chainStepInner}>
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
                return (
                  <li key={net.id} className={`${s.chainPickItem} ${selected ? s.chainPickItemSelected : ''}`}>
                    <button type="button" className={`${s.chainOption} ${selected ? s.chainOptionSelected : ''}`} onClick={() => setChain(net.id)}>
                      <ChainMark id={net.id} size={40} />
                      <div className={s.chainOptionBody}>
                        <div className={s.chainOptionTop}>
                          <span className={s.chainOptionName}>{net.name}</span>
                          {net.recommended ? <span className={`${s.chainOptionBadge} ${s.chainOptionBadgeLive}`}>Live · suggested</span> : <span className={s.chainOptionBadge}>Selectable</span>}
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
    </div>
  )
}

function ScreenSmartAccount({ chain, smartAccountAddress, smartAccountDeployed, loading, error, onContinue }: { chain: string; smartAccountAddress: string; smartAccountDeployed: boolean; loading: boolean; error: string; onContinue: () => void }) {
  const liveSupported = chain === 'arbitrum'
  return (
    <div className={s.screenInner} style={{ maxWidth: 760, margin: '0 auto', paddingTop: 32 }}>
      <p className={s.policyStepBadge}>Step 2 · Your smart account</p>
      <h1 className={s.screen1Title} style={{ textAlign: 'left' }}>Your agent runs from a dedicated smart account</h1>
      <p className={s.screen4Lead} style={{ textAlign: 'left', marginTop: 16 }}>
        This account is where your USDC lives and where each agent is executed under delegation.
      </p>
      <div className={s.policyCard} style={{ marginTop: 28 }}>
        <div className={s.policyRow}><span className={s.policyRowLabel}>Selected rail</span><span className={s.policyRowValue}>{NETWORKS.find(n => n.id === chain)?.name ?? chain}</span></div>
        <div className={s.policyRow}><span className={s.policyRowLabel}>Account status</span><span className={s.policyRowValue}>{loading ? 'Deriving…' : smartAccountDeployed ? 'Deployed' : 'Ready to deploy'}</span></div>
        <div className={s.policyRow} style={{ alignItems: 'flex-start' }}><span className={s.policyRowLabel}>Smart account</span><span className={s.policyRowValue} style={{ maxWidth: 420, textAlign: 'right', wordBreak: 'break-all' }}>{smartAccountAddress || 'Waiting for wallet…'}</span></div>
      </div>
      {!liveSupported && <div className={s.policyError} style={{ marginTop: 18 }}>Live activation is enabled on Arbitrum first.</div>}
      {error && <div className={s.policyError} style={{ marginTop: 18 }}>{error}</div>}
      <button className={`${s.btn} ${s.btnLg} ${s.btnBlock}`} style={{ marginTop: 36 }} disabled={!liveSupported || loading || !smartAccountAddress} onClick={onContinue}>Continue</button>
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

function ScreenBuildAgent({ name, setName, tValue, setT, amount, setAmount, eoaBalance, smartBalance, preparing, error, onPrepare }: { name: string; setName: (v: string) => void; tValue: number; setT: (v: number) => void; amount: number; setAmount: (v: number) => void; eoaBalance: number; smartBalance: number; preparing: boolean; error: string; onPrepare: () => void }) {
  const dialSize = useDialSize()
  const { apy, drawdown } = valuesAtT(tValue)
  const active = activeProtocolSet(tValue)
  return (
    <div className={s.screenInner} style={{ maxWidth: 1120, margin: '0 auto', paddingTop: 20 }}>
      <p className={s.screen2StepBadge}>Step 3 · Configure agent</p>
      <div className={s.screen2Panels} style={{ marginTop: 18 }}>
        <section className={`${s.screen2Panel} ${s.screen2PanelDial}`}>
          <div className={s.screen4Lbl}>Agent name</div>
          <input className={s.input} style={{ marginTop: 12, textAlign: 'left' }} placeholder="Yield Maxer" value={name} onChange={(e) => setName(e.target.value)} />
          <div style={{ marginTop: 28, width: '100%' }}>
            <div className={s.screen4Lbl}>Choose a preset</div>
            <div className={s.screen2ChipRow} style={{ marginTop: 14, justifyContent: 'flex-start', flexWrap: 'wrap' }}>
              {PRESETS.map((preset) => (
                <button key={preset.id} type="button" className={s.statChip} onClick={() => setT(preset.t)} style={{ borderColor: Math.abs(preset.t - tValue) < 0.04 ? 'var(--primary)' : undefined, background: Math.abs(preset.t - tValue) < 0.04 ? 'rgba(234, 88, 12, 0.08)' : undefined, cursor: 'pointer' }}>
                  <span className={s.statLbl}>{preset.label}</span><span className={s.statVal}>{preset.apy}%</span>
                </button>
              ))}
            </div>
          </div>
          <div className={s.screen2DialWrap} style={{ marginTop: 18 }}><Dial value={tValue} onChange={setT} size={dialSize} /></div>
          <div className={s.screen2ChipRow}>
            <span className={s.statChip}><span className={s.statLbl}>Min APY</span> <span className={s.statVal}>{apy}%</span></span>
            <span className={s.statChip}><span className={s.statLbl}>Max drawdown</span> <span className={s.statVal}>{drawdown}%</span></span>
          </div>
        </section>
        <section className={`${s.screen2Panel} ${s.screen2PanelVenues}`}>
          <div className={s.screen2AmountBlock} style={{ width: '100%', marginTop: 0 }}>
            <div className={s.screen2AmountLabel}>Fund amount</div>
            <div className={s.screen2AmountField}>
              <span className={s.screen2AmountPrefix}>$</span>
              <input type="number" min={1} className={s.screen2AmountInput} value={amount} onChange={(e) => setAmount(Math.max(1, parseInt(e.target.value || '0', 10)))} />
              <button type="button" className={s.screen2AmountMax} onClick={() => setAmount(Math.max(1, Math.floor(eoaBalance)))}>MAX</button>
            </div>
          </div>
          <div className={s.policyCard} style={{ marginTop: 24, width: '100%' }}>
            <div className={s.policyRow}><span className={s.policyRowLabel}>EOA Balance</span><span className={s.policyRowValue}>${eoaBalance.toLocaleString()} USDC</span></div>
            <div className={s.policyRow}><span className={s.policyRowLabel}>Smart account</span><span className={s.policyRowValue}>${smartBalance.toLocaleString()} USDC</span></div>
          </div>
          <p className={s.screen2ProtocolsHead} style={{ marginTop: 24 }}>The agent can route across</p>
          <div className={s.screen2ProtocolGrid}>
            {PROTOCOLS.map((p) => (
              <div key={p.id} className={`${s.protocolTile} ${active.has(p.id) ? s.protocolTileActive : s.protocolTileInactive}`}>
                <ProtocolMark id={p.id} size={32} /><div className={s.protocolTileName}>{p.name}</div><div className={s.protocolTileKind}>{p.kind}</div>
              </div>
            ))}
          </div>
          {error && <div className={s.policyError} style={{ marginTop: 18, width: '100%' }}>{error}</div>}
          <button className={`${s.btn} ${s.btnLg}`} style={{ marginTop: 26, width: '100%' }} onClick={onPrepare} disabled={preparing || amount < 1}>{preparing ? 'Preparing account…' : 'Fund & prepare agent'}</button>
        </section>
      </div>
    </div>
  )
}

function ScreenReviewV2({ name, amount, chain, tValue, smartAccountAddress, agentDelegateAddress, signing, error, onSignAndActivate }: { name: string; amount: number; chain: string; tValue: number; smartAccountAddress: string; agentDelegateAddress: string; signing: boolean; error: string; onSignAndActivate: () => void }) {
  const { apy, drawdown } = valuesAtT(tValue)
  return (
    <div className={s.screenInner} style={{ maxWidth: 760, margin: '0 auto', paddingTop: 24 }}>
      <p className={s.policyStepBadge}>Step 4 · Review and sign</p>
      <h1 className={s.policyTitle} style={{ textAlign: 'left' }}>Review and sign delegation</h1>
      <p className={s.policySubtitle} style={{ textAlign: 'left' }}>Your signature binds the agent to your policy terms.</p>
      <div className={s.policyCard} style={{ marginTop: 24 }}>
        <div className={s.policyRow}><span className={s.policyRowLabel}>Agent name</span><span className={s.policyRowValue}>{name || 'My agent'}</span></div>
        <div className={s.policyRow}><span className={s.policyRowLabel}>Network</span><span className={s.policyRowValue}>{NETWORKS.find(n => n.id === chain)?.name ?? chain}</span></div>
        <div className={s.policyRow}><span className={s.policyRowLabel}>Managed amount</span><span className={s.policyRowValue}>${amount.toLocaleString()} USDC</span></div>
        <div className={s.policyRow}><span className={s.policyRowLabel}>Minimum APY</span><span className={s.policyRowValue}>{apy}%</span></div>
        <div className={s.policyRow}><span className={s.policyRowLabel}>Max drawdown</span><span className={s.policyRowValue}>{drawdown}%</span></div>
        <div className={s.policyRow} style={{ alignItems: 'flex-start' }}><span className={s.policyRowLabel}>Smart account</span><span className={s.policyRowValue} style={{ maxWidth: 420, textAlign: 'right', wordBreak: 'break-all' }}>{smartAccountAddress}</span></div>
      </div>
      {error && <div className={s.policyError} style={{ marginTop: 18 }}>{error}</div>}
      <button className={`${s.btn} ${s.btnLg} ${s.btnDark}`} style={{ marginTop: 28, width: '100%' }} onClick={onSignAndActivate} disabled={signing}>{signing ? 'Signing…' : 'Sign & activate agent'}</button>
    </div>
  )
}

function ScreenActivationV2({ strategyId, onView }: { strategyId: string | null; onView: () => void }) {
  const [phase, setPhase] = useState('REGISTERING'), [count, setCount] = useState(0), [ready, setReady] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    if (!strategyId) return
    let cancelled = false; const agentBase = (process.env.NEXT_PUBLIC_AGENT_SSE_URL ?? 'http://localhost:3001/events').replace('/events', '')
    const poll = async () => {
      try {
        const res = await fetch(`${agentBase}/state/${strategyId}`)
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        setPhase(data.phase || 'REGISTERING'); setCount(Array.isArray(data.executions) ? data.executions.length : 0)
        if (data.phase === 'ERROR') setError('Agent activation error. Check logs.')
        if (Array.isArray(data.executions) && data.executions.some((e: any) => e?.action === 'GENESIS')) setReady(true)
      } catch (err: any) { if (!cancelled) setError(err.message) }
    }
    poll(); const id = setInterval(poll, 6000); return () => { cancelled = true; clearInterval(id) }
  }, [strategyId])
  return (
    <div className={s.screenInner} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 168px)', color: '#fff' }}>
      <div style={{ position: 'relative', width: 120, height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {!ready && <div className={s.spinSlow}><GekoMark size={80} /></div>}
        {ready && <><span className={s.pulseRing} style={{ position: 'absolute', inset: 16, borderRadius: '50%', border: '2px solid var(--earn)', display: 'block' }} /><GekoMark size={80} /></>}
      </div>
      <div style={{ marginTop: 30, textAlign: 'center', maxWidth: 560 }}>
        <div className={s.activationTitle} style={{ fontSize: 32, fontWeight: 600 }}>{ready ? 'Agent is running.' : 'Activating agent…'}</div>
        <div className={s.activationSub} style={{ fontSize: 16, marginTop: 12 }}>{ready ? 'Genesis completed. Strategy is now active.' : `Phase: ${phase}. Evaluation in progress…`}</div>
        {error && <div className={s.policyError} style={{ marginTop: 18 }}>{error}</div>}
        {ready && <button className={s.btn} style={{ marginTop: 40, width: 240 }} onClick={onView}>View your agent →</button>}
      </div>
    </div>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function AgentFlow({ mode }: { mode: 'onboard' | 'create' }) {
  const router = useRouter(), { address } = useAccount(), chainId = useChainId(), { switchChain } = useSwitchChain(), { data: walletClient } = useWalletClient()
  const [screen, setScreen] = useState(mode === 'onboard' ? 0 : 1), [direction, setDirection] = useState(1), [isMounted, setIsMounted] = useState(false)
  const [chain, setChain] = useState('arbitrum'), [name, setName] = useState(''), [tValue, setT] = useState(0.33), [amount, setAmount] = useState(10), [error, setError] = useState('')
  const [smartAccountAddress, setSmartAccountAddress] = useState(''), [smartAccountDeployed, setSmartAccountDeployed] = useState(false), [smartAccountLoading, setSmartAccountLoading] = useState(false), [smartAccountBalance, setSmartAccountBalance] = useState(0)
  const [agentDelegateAddress, setAgentDelegateAddress] = useState(''), [preparingStrategy, setPreparingStrategy] = useState(false), [signingStrategy, setSigningStrategy] = useState(false), [registeredId, setRegisteredId] = useState<string | null>(null), [draftId, setDraftId] = useState<string | null>(null)
  const smartAccountRef = useRef<MetaMaskSmartAccount<Implementation.Hybrid> | null>(null), hasCheckedRef = useRef(false), publicClient = usePublicClient({ chainId: arbitrum.id })

  useEffect(() => { setIsMounted(true) }, [])

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
    const agentUrl = (process.env.NEXT_PUBLIC_AGENT_SSE_URL ?? 'http://localhost:3001/events').replace('/events', '')
    const res = await fetch(`${agentUrl}/health`)
    const data = await res.json()
    setAgentDelegateAddress(data.agentDelegateAddress); return data.agentDelegateAddress
  }, [agentDelegateAddress])

  const handlePrepare = useCallback(async () => {
    if (!address || !walletClient || !publicClient || !smartAccountAddress) return
    setError('')
    if (chainId !== arbitrum.id) { switchChain({ chainId: arbitrum.id }); return }
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
      calls.push({ to: USDC_ADDRESS, value: 0n, data: encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [SWAPPER,  BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')] }) })
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
      const amountRaw = parseUnits(String(amount), 6), delegate = await fetchDelegate(), { apy, drawdown } = valuesAtT(tValue), expiresAt = BigInt(Math.floor(Date.now() / 1000) + 31536000)
      const policyTerms = encodeAbiParameters(parseAbiParameters('uint256, uint256, uint256, uint256, address, uint256, address'), [BigInt(Math.round(apy * 100)), BigInt(drawdown * 100), amountRaw, 1000n, TREASURY_ADDRESS, expiresAt, USDC_ADDRESS]) as Hex
      const delegation = { delegate: delegate as Hex, delegator: smartAccountAddress as Hex, authority: ROOT_AUTHORITY, caveats: [createCaveat(ENFORCER_ADDRESS, policyTerms, '0x')], salt: ZERO_SALT }
      const signature = await smartAccountRef.current.signDelegation({ delegation })
      const strategyId = draftId ?? createDraftStrategyId(name), agentUrl = (process.env.NEXT_PUBLIC_AGENT_SSE_URL ?? 'http://localhost:3001/events').replace('/events', ''), agentKey = process.env.NEXT_PUBLIC_AGENT_API_KEY ?? ''
      const res = await fetch(`${agentUrl}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(agentKey ? { Authorization: `Bearer ${agentKey}` } : {}) }, body: JSON.stringify({ strategyId, displayName: name || 'My agent', riskTier: riskTierFromT(tValue), managedUSD: amount, minAPY: apy, maxSlippageBps: 50, maxDrawdownPct: drawdown, maxFeeBps: 1000, userAddress: address, chainId: arbitrum.id, smartAccountAddress, signedDelegation: { delegate, delegator: smartAccountAddress, authority: ROOT_AUTHORITY, caveats: delegation.caveats.map(c => ({ enforcer: c.enforcer, terms: c.terms, args: c.args || '0x' })), salt: delegation.salt, signature } }) })
      const data = await res.json()
      setRegisteredId(data.userId || strategyId); goTo(5)
    } catch (err: any) { setError(err.message) }
    finally { setSigningStrategy(false) }
  }, [address, amount, draftId, fetchDelegate, name, publicClient, smartAccountAddress, tValue])

  return (
    <div className={`${s.shell} ${screen === 5 ? s.shellDark : ''}`} data-yieldgeko-onboard={ONBOARD_UI_MARK}>
      {screen < 5 && (
        <nav className={s.onboardNavLeft}>
          <div className={s.onboardNavCluster}>
            {screen > (mode === 'onboard' ? 0 : 1) && <button type="button" className={s.backChevron} onClick={goBack}><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" /></svg></button>}
            <button type="button" className={s.exitSetup} onClick={() => router.push('/app')}>{screen <= 1 ? 'Exit setup' : 'Exit'}</button>
          </div>
        </nav>
      )}
      <div className={s.progressDots}>{[0, 1, 2, 3, 4, 5].map(i => <span key={i} className={`${s.dot} ${i === screen ? s.dotActive : i < screen ? s.dotDone : ''}`} />)}</div>
      <ScreenStage screen={screen} direction={direction}>
        {screen === 0 && <ScreenConnect />}
        {screen === 1 && <Screen0Chain chain={chain} setChain={setChain} onContinue={() => goTo(2)} />}
        {screen === 2 && <ScreenSmartAccount chain={chain} smartAccountAddress={smartAccountAddress} smartAccountDeployed={smartAccountDeployed} loading={smartAccountLoading} error={error} onContinue={() => goTo(3)} />}
        {screen === 3 && <ScreenBuildAgent name={name} setName={setName} tValue={tValue} setT={setT} amount={amount} setAmount={setAmount} eoaBalance={usdcBalance} smartBalance={smartAccountBalance} preparing={preparingStrategy} error={error} onPrepare={handlePrepare} />}
        {screen === 4 && <ScreenReviewV2 name={name} amount={amount} chain={chain} tValue={tValue} smartAccountAddress={smartAccountAddress} agentDelegateAddress={agentDelegateAddress} signing={signingStrategy} error={error} onSignAndActivate={handleActivate} />}
        {screen === 5 && <ScreenActivationV2 strategyId={registeredId} onView={() => router.push(registeredId ? `/app/strategy/${registeredId}` : '/app')} />}
      </ScreenStage>
    </div>
  )
}
