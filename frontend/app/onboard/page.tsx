'use client'

/** Bumped when onboarding UI changes materially — inspect on `<div className="shell">` */
export const ONBOARD_UI_MARK = 'yieldgeko-onboard-v3'

import {
  useState, useCallback, useEffect, useRef,
  type CSSProperties, type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
import {
  useAccount, useSignTypedData, useWriteContract,
  useReadContract, useSwitchChain, useChainId,
} from 'wagmi'
import { parseUnits, formatUnits, type Hex } from 'viem'
import { arbitrum } from '@reown/appkit/networks'
import { VAULT_ADDRESS, USDC_ADDRESS } from '@/config'
import { useReadYieldGekoNonces } from '@/src/generated'
import s from './onboard.module.css'

// ─── ABIs ────────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

const VAULT_ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  {
    name: 'registerPolicy', type: 'function', stateMutability: 'nonpayable',
    inputs: [{
      name: '_p', type: 'tuple',
      components: [
        { name: 'user', type: 'address' },
        { name: 'managedUSD', type: 'uint256' },
        { name: 'minAPY', type: 'uint256' },
        { name: 'maxDrawdownBps', type: 'uint256' },
        { name: 'maxFeeBps', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    }, { name: '_sig', type: 'bytes' }],
    outputs: [],
  },
] as const

const POLICY_TYPES = {
  Policy: [
    { name: 'user', type: 'address' },
    { name: 'managedUSD', type: 'uint256' },
    { name: 'minAPY', type: 'uint256' },
    { name: 'maxDrawdownBps', type: 'uint256' },
    { name: 'maxFeeBps', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

type PolicyMessage = {
  user: Hex; managedUSD: bigint; minAPY: bigint
  maxDrawdownBps: bigint; maxFeeBps: bigint; nonce: bigint; deadline: bigint
}

// EIP-2612 permit types — used to sponsor USDC approval (no user gas)
const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

// ─── Dial math ───────────────────────────────────────────────────────────────

const PRESETS = [
  { id: 'conservative', label: 'Conservative', t: 0, apy: 8, drawdown: 10 },
  { id: 'balanced', label: 'Balanced', t: 0.33, apy: 12, drawdown: 12 },
  { id: 'aggressive', label: 'Aggressive', t: 0.66, apy: 20, drawdown: 18 },
  { id: 'advanced', label: 'Advanced', t: 1, apy: 30, drawdown: 25 },
] as const

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

// ─── Real logo URLs ───────────────────────────────────────────────────────────

const CHAIN_LOGOS: Record<string, string> = {
  arbitrum: 'https://assets.coingecko.com/coins/images/16547/standard/arb.jpg?1721358242',
  '0g': 'https://assets.coingecko.com/asset_platforms/images/184/standard/0g.png',
}

const PROTO_LOGOS: Record<string, string> = {
  aave: 'https://assets.coingecko.com/coins/images/12645/standard/aave-token-round.png?1720472354',
  morpho: 'https://assets.coingecko.com/coins/images/29837/standard/morpho.png',
  uniswap: 'https://assets.coingecko.com/coins/images/12504/standard/uniswap-logo.png',
  pendle: 'https://assets.coingecko.com/coins/images/28500/standard/pendle-logo.png',
  gmx: 'https://assets.coingecko.com/coins/images/18323/standard/arbit.png',
}

// Shared logo circle wrapper — clips image to circle, consistent sizing
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
  // Fallback
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

function ProtocolPill({ id, name }: { id: string; name: string }) {
  return (
    <span className={s.pill}>
      <ProtocolMark id={id} size={16} />
      <span>{name}</span>
    </span>
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

// ─── Dial component ───────────────────────────────────────────────────────────

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

      {/* Center readout */}
      <div style={{
        position: 'absolute', top: cy - 30, left: 0, width: '100%',
        textAlign: 'center', pointerEvents: 'none',
      }}>
        <div className={s.dialReadoutApy}>{apy}%</div>
        <div className={s.dialReadoutLbl}>minimum</div>
      </div>

      {/* Preset labels */}
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

// ─── Screen stage (slide transition) ─────────────────────────────────────────

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

/** Shared preview body for desktop aside + mobile inline panel under selection */
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

// ─── Screen 0: Choose chain ─────────────────────────────────────────────────

function Screen0Chain({
  chain, setChain, onContinue,
}: { chain: string; setChain: (c: string) => void; onContinue: () => void }) {
  const ordered = CHAIN_PICK_ORDER.map(id => NETWORKS.find(n => n.id === id)).filter(Boolean) as NetworkDef[]
  const selectedNet = NETWORKS.find(n => n.id === chain) ?? NETWORKS[0]

  return (
    <div className={s.chainStep}>
      <div className={s.chainStepGlow} aria-hidden />

      <div className={s.chainStepInner}>
        <header className={s.chainStepHeader}>
          <p className={s.chainStepKicker}>Execution network</p>
          <h1 className={s.chainStepTitle}>Choose where this strategy settles</h1>
          <p className={s.chainStepLead}>
            The vault runs against contracts on one chain at a time. Pick the environment that matches how you move size —
            you can still revise later before you fund.
          </p>
        </header>

        <div className={s.chainStepGrid}>
          <div>
            <ul className={s.chainPickList} role="listbox" aria-label="Networks">
              {ordered.map(net => {
                const selected = chain === net.id
                return (
                  <li
                    key={net.id}
                    className={`${s.chainPickItem} ${selected ? s.chainPickItemSelected : ''}`}
                  >
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      aria-expanded={selected}
                      className={`${s.chainOption} ${selected ? s.chainOptionSelected : ''}`}
                      onClick={() => setChain(net.id)}
                    >
                      <ChainMark id={net.id} size={40} />
                      <div className={s.chainOptionBody}>
                        <div className={s.chainOptionTop}>
                          <span className={s.chainOptionName}>{net.name}</span>
                          {net.recommended ? (
                            <span className={`${s.chainOptionBadge} ${s.chainOptionBadgeLive}`}>Live · suggested</span>
                          ) : (
                            <span className={s.chainOptionBadge}>Selectable</span>
                          )}
                        </div>
                        <span className={s.chainOptionMeta}>{net.tvl} TVL · {net.risk}</span>
                        <span className={s.chainOptionHint}>{net.shortLine}</span>
                      </div>
                      <span className={s.chainOptionRadio} aria-hidden>
                        <span className={s.chainOptionDot} />
                      </span>
                    </button>

                    {/* Mobile: preview opens directly under the selected row */}
                    {selected && (
                      <div className={s.chainInlinePreview} id={`chain-preview-${net.id}`}>
                        <p className={s.chainInlineKicker}>At a glance</p>
                        <p className={s.chainPreviewDesc}>{net.description}</p>
                        <ChainPreviewFactsProtocols net={net} />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>

          <aside className={s.chainPreview} aria-live="polite">
            <p className={s.chainPreviewEyebrow}>Preview</p>
            <div className={s.chainPreviewHead}>
              <ChainMark id={selectedNet.id} size={52} />
              <div className={s.chainPreviewTitleRow}>
                <h2 className={s.chainPreviewTitle}>{selectedNet.name}</h2>
                <span className={s.chainPreviewLive}>
                  <span className={s.chainPreviewLiveDot} />
                  Routed · agent-ready
                </span>
              </div>
            </div>

            <p className={s.chainPreviewDesc}>{selectedNet.description}</p>
            <ChainPreviewFactsProtocols net={selectedNet} />

            <div className={s.chainPreviewDesktopCta}>
              <button type="button" className={`${s.btn} ${s.btnLg} ${s.chainDesktopContinue}`} onClick={onContinue}>
                Continue with {selectedNet.name}
              </button>
            </div>
          </aside>
        </div>

        <div className={s.chainStepFooter}>
          <p className={s.chainStepFooterHint}>Funding still happens in USDC on the vault chain you configure next.</p>
        </div>
      </div>

      <div className={s.chainCtaBarMobile}>
        <div className={s.chainCtaBarInner}>
          <button type="button" className={`${s.btn} ${s.btnLg} ${s.chainCtaContinue}`} onClick={onContinue}>
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}


// ─── Screen 1: Name it ────────────────────────────────────────────────────────

function Screen1Name({ name, setName, onContinue }: { name: string; setName: (n: string) => void; onContinue: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  return (
    <div className={`${s.screenInner} ${s.screen1Wrap}`}>
      <h1 className={s.screen1Title}>What do you want to call this?</h1>

      <input
        ref={inputRef}
        className={s.input}
        style={{ marginTop: 32, textAlign: 'left' }}
        placeholder="My first strategy"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onContinue() }}
      />

      <p className={s.screen1Hint}>You can run multiple strategies at the same time.</p>

      <button type="button" className={`${s.btn} ${s.btnLg} ${s.btnBlock}`} style={{ marginTop: 40 }} onClick={onContinue}>
        Continue <span style={{ opacity: 0.8 }}>→</span>
      </button>

      <button type="button" className={s.linkish} style={{ marginTop: 16 }} onClick={() => { setName('My strategy'); onContinue() }}>
        Skip and auto-name
      </button>
    </div>
  )
}

// ─── Screen 2: The Dial ───────────────────────────────────────────────────────

const PROTOCOLS = [
  { id: 'aave', name: 'Aave V3', kind: 'Lending' },
  { id: 'morpho', name: 'Morpho Blue', kind: 'Lending' },
  { id: 'uniswap', name: 'Uniswap V3', kind: 'LP' },
  { id: 'pendle', name: 'Pendle', kind: 'Yield trading' },
  { id: 'gmx', name: 'GMX V2', kind: 'Perps LP' },
]

function useDialSize() {
  const [size, setSize] = useState(280)
  useEffect(() => {
    const apply = () => {
      const narrow = window.innerWidth <= 768
      setSize(narrow ? Math.max(220, Math.min(268, window.innerWidth - 48)) : 280)
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])
  return size
}

function Screen2Dial({
  tValue, setT, amount, setAmount, balance, onContinue,
}: {
  tValue: number; setT: (t: number) => void
  amount: number; setAmount: (a: number) => void
  balance: number; onContinue: () => void
}) {
  const dialSize = useDialSize()
  const { apy, drawdown } = valuesAtT(tValue)
  const active = activeProtocolSet(tValue)
  const valid = amount >= 1 && amount <= balance

  const primaryCta = (
    <button
      type="button"
      className={`${s.btn} ${s.btnLg}`}
      onClick={onContinue}
      disabled={!valid}
    >
      Set my limits <span style={{ opacity: 0.8 }}>→</span>
    </button>
  )

  return (
    <>
      <div className={`${s.screenInner} ${s.screen2Shell}`}>
        <div className={s.screen2HeroBand}>
          <p className={s.screen2StepBadge}>Step 3 · Limits & venues</p>
          <header className={s.screen2Intro}>
            <p className={s.screen2Kicker}>Risk & deposit</p>
            <h1 className={s.screen2Title}>Tune how hard your agent can push</h1>
            <p className={s.screen2Lead}>
              One dial sets your minimum APY appetite and drawdown guardrail. Deposit size is independent — you&apos;ll confirm it again before funding.
            </p>
          </header>
        </div>

        <div className={s.screen2Panels}>
          <section className={`${s.screen2Panel} ${s.screen2PanelDial}`}>
            <div className={s.screen2DialWrap}>
              <Dial value={tValue} onChange={setT} size={dialSize} />
            </div>

            <div className={s.screen2ChipRow}>
              <span className={s.statChip}><span className={s.statLbl}>Min APY</span> <span className={s.statVal}>{apy}%</span></span>
              <span className={s.statChip}><span className={s.statLbl}>Safety net</span> <span className={s.statVal}>{drawdown}%</span></span>
              <span className={s.statChip}><span className={s.statLbl}>Fee cap</span> <span className={s.statVal}>0.5%</span></span>
            </div>

            <div className={s.screen2AmountBlock}>
              <div className={s.screen2AmountLabel}>How much USDC?</div>
              <div className={s.screen2AmountField}>
                <span className={s.screen2AmountPrefix}>$</span>
                <input
                  type="number"
                  min={1}
                  className={s.screen2AmountInput}
                  value={amount}
                  onChange={(e) => setAmount(parseInt(e.target.value || '0', 10))}
                  aria-label="USDC amount"
                />
                <button type="button" className={s.screen2AmountMax} onClick={() => setAmount(balance)}>
                  MAX
                </button>
              </div>
              <p className={s.screen2BalanceHint}>Balance: ${balance.toLocaleString()} USDC</p>
            </div>
          </section>

          <section className={`${s.screen2Panel} ${s.screen2PanelVenues}`}>
            <p className={s.screen2ProtocolsHead}>What your agent will use</p>
            <div className={s.screen2ProtocolGrid}>
              {PROTOCOLS.map((p) => {
                const isActive = active.has(p.id)
                return (
                  <div
                    key={p.id}
                    className={`${s.protocolTile} ${isActive ? s.protocolTileActive : s.protocolTileInactive}`}
                  >
                    <ProtocolMark id={p.id} size={32} />
                    <div className={s.protocolTileName}>{p.name}</div>
                    <div className={s.protocolTileKind}>{p.kind}</div>
                    {isActive ? <span className={s.protocolTileDot} aria-hidden /> : null}
                  </div>
                )
              })}
            </div>

            <div className={s.screen2CtaDesktop}>
              {primaryCta}
              {!valid ? (
                <p className={s.screen2Help}>Minimum deposit is $1 USDC.</p>
              ) : null}
            </div>
          </section>
        </div>
      </div>

      <div className={s.screen2StickyFooter}>
        {primaryCta}
        {!valid ? <p className={s.screen2Help}>Minimum deposit is $1 USDC.</p> : null}
      </div>
    </>
  )
}

// ─── Screen 3: Policy ─────────────────────────────────────────────────────────

function SignedSeal() {
  return (
    <div className={s.policySealBlock}>
      <div className={`${s.sealAppear} ${s.policySealFlat}`}>
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
          <path d="M5 11.5L9 15.5L17 7" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <p className={s.policySealCaption}>Policy signed ✓</p>
    </div>
  )
}

function Screen3Policy({
  name, chain, amount, tValue, signed, onSign, error,
}: {
  name: string; chain: string; amount: number; tValue: number
  signed: boolean; onSign: () => void; error: string
}) {
  const { apy, drawdown } = valuesAtT(tValue)
  const chainName = NETWORKS.find(n => n.id === chain)?.name ?? 'Arbitrum'

  const signBtn = (
    <button
      type="button"
      className={`${s.btn} ${s.btnLg} ${s.btnDark}`}
      onClick={onSign}
    >
      Sign policy
    </button>
  )

  return (
    <>
      <div className={`${s.screenInner} ${s.policyPage}`}>
        <header className={s.policyIntro}>
          <p className={s.policyStepBadge}>Step 4 · EIP-712 policy</p>
          <h1 className={s.policyTitle}>Review your policy</h1>
          <p className={s.policySubtitle}>
            Sign once. Your agent runs within these limits — nothing more.
          </p>
        </header>

        <div className={`${s.policyCard} ${s.policyCardAccent}`}>
          <p className={s.policyCardEyebrow}>Yield policy</p>
          <div className={s.policyCardDivider} />

          <div className={s.policyRow}>
            <span className={s.policyRowLabel}>Strategy</span>
            <span className={s.policyRowValue}>{name || 'My strategy'}</span>
          </div>
          <div className={s.policyRow}>
            <span className={s.policyRowLabel}>Network</span>
            <span className={s.policyRowValue}>{chainName}</span>
          </div>
          <div className={s.policyRow}>
            <span className={s.policyRowLabel}>Amount</span>
            <span className={s.policyRowValue}>{`$${Number(amount).toLocaleString()} USDC`}</span>
          </div>
          <div className={s.policyRow}>
            <span className={s.policyRowLabel}>Minimum APY</span>
            <span className={s.policyRowValue} style={{ color: 'var(--earn)' }}>{`${apy.toFixed(1)}%`}</span>
          </div>
          <div className={s.policyRow}>
            <span className={s.policyRowLabel}>Safety net</span>
            <span className={s.policyRowValue}>{`${drawdown}% max drawdown`}</span>
          </div>
          <div className={s.policyRow}>
            <span className={s.policyRowLabel}>Fee cap</span>
            <span className={s.policyRowValue}>0.5%</span>
          </div>

          <div className={s.policyCardDivider} />
          <p className={s.policyDisclaimer}>
            Your agent may only act within these exact bounds. No exceptions.
            This policy is valid for 365 days.
          </p>

          {error ? <div className={s.policyError}>{error}</div> : null}

          {!signed ? (
            <div className={s.policyCtaDesktop}>{signBtn}</div>
          ) : (
            <SignedSeal />
          )}
        </div>
      </div>

      {!signed ? (
        <div className={s.policyStickyFooter}>{signBtn}</div>
      ) : null}
    </>
  )
}

// ─── Screen 4: Fund it ────────────────────────────────────────────────────────

function useCountUp(target: number) {
  const [v, setV] = useState(target)
  const startRef = useRef(target)
  useEffect(() => {
    const from = startRef.current
    const dur = 320
    const t0 = performance.now()
    let raf: number
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur)
      const eased = 1 - Math.pow(1 - k, 3)
      setV(from + (to - from) * eased)
      if (k < 1) raf = requestAnimationFrame(step)
      else startRef.current = to
    }
    const to = target
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])
  return v
}

function Dot({ state }: { state: 'done' | 'active' | 'pending' }) {
  if (state === 'done') {
    return (
      <div className={s.txDotDone}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path d="M2 5L4 7L8 3" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    )
  }
  if (state === 'active') {
    return (
      <div className={`${s.livePulse} ${s.txDotActive}`} />
    )
  }
  return <div className={s.txDotPending} />
}

function TxTrail({ step }: { step: number }) {
  const items = [
    { label: 'Register policy' },
    { label: 'Approve USDC' },
    { label: 'Deposit' },
  ]
  return (
    <div className={s.txTrailRow}>
      {items.map((it, i) => {
        const completed = step >= i + 2 || step === 3
        const isActive = step === i + 1 && step !== 3
        const dotState = completed ? 'done' : isActive ? 'active' : 'pending'
        const lbl =
          dotState === 'pending' ? s.txTrailLblPending
            : dotState === 'active' ? s.txTrailLblActive
              : s.txTrailLblDone
        return (
          <div key={i} className={s.txTrailSeg} style={{ flex: i < items.length - 1 ? 1 : undefined }}>
            <div className={s.txTrailLblWrap}>
              <Dot state={dotState} />
              <div className={`${s.txTrailLbl} ${lbl}`}>
                {it.label}
              </div>
            </div>
            {i < items.length - 1 && (
              <div className={`${s.txTrailLine} ${completed ? s.txTrailLineDone : ''}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function Screen4Fund({
  amount, setAmount, balance, tValue, txStep, onDeposit, error,
}: {
  amount: number; setAmount: (a: number) => void; balance: number
  tValue: number; txStep: number; onDeposit: () => void; error: string
}) {
  const { apy } = valuesAtT(tValue)
  const yearly = (amount * apy) / 100
  const monthly = yearly / 12
  const daily = yearly / 365

  const [editing, setEditing] = useState(false)
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const yearAnim = useCountUp(yearly)
  const monthAnim = useCountUp(monthly)
  const dayAnim = useCountUp(daily)

  const fillPct = Math.min(100, Math.max(0, (amount / balance) * 100))

  return (
    <div className={`${s.screenInner} ${s.screen4Wrap}`}>
      <div className={s.screen4Grid}>

        {/* LEFT */}
        <div>
          <h1 className={s.screen4Title}>Fund your strategy</h1>
          <p className={s.screen4Lead}>Deposit USDC to activate your agent.</p>

          <div style={{ marginTop: 36 }}>
            <div className={s.screen4Lbl}>Your balance</div>
            <div className={s.screen4Bar}>
              <div className={s.screen4BarFill} style={{ width: `${fillPct}%` }} />
            </div>
            <p className={s.screen4Muted}>
              Using ${amount.toLocaleString()} of ${balance.toLocaleString()}
            </p>
          </div>

          <div style={{ marginTop: 28 }}>
            {!editing ? (
              <>
                <div className={s.screen4Amount}>${amount.toLocaleString()}</div>
                <button type="button" className={`${s.linkish} ${s.screen4Link}`} style={{ marginTop: 8, textDecoration: 'underline', fontWeight: 500 }} onClick={() => setEditing(true)}>
                  Edit amount
                </button>
              </>
            ) : (
              <input
                type="number"
                autoFocus
                defaultValue={amount}
                className={s.screen4AmountInput}
                onBlur={(e) => {
                  setAmount(Math.max(1, Math.min(balance, parseInt(e.target.value || String(amount), 10))))
                  setEditing(false)
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
            )}
          </div>

          <div style={{ marginTop: 36 }}>
            <TxTrail step={txStep} />
          </div>

          {error ? <div className={s.screen4Error}>{error}</div> : null}

          <button
            type="button"
            className={`${s.btn} ${s.btnLg} ${s.btnBlock}`}
            style={{ marginTop: 28, height: 56, fontSize: 17 }}
            onClick={onDeposit}
            disabled={txStep > 0 && txStep < 3}
          >
            {txStep === 0 && <>Activate &amp; deposit ${amount.toLocaleString()} <span style={{ opacity: 0.8 }}>→</span></>}
            {txStep === 1 && 'Sign permit…'}
            {txStep === 2 && 'Setting up vault…'}
            {txStep === 3 && 'Funded ✓'}
          </button>

          <p className={s.screen4Foot}>
            2 signatures + 1 transaction.<br />
            YieldGeko sponsors setup gas — you only pay to deposit.
          </p>
        </div>

        <div>
          <div className={s.screen4Preview}>
            <div className={s.screen4PreviewLive}>
              <span className={`${s.livePulse} ${s.liveDotSm}`} />
              Live
            </div>

            <p className={s.screen4PreviewLead}>
              At {apy}% APY floor, ${amount.toLocaleString()} earns:
            </p>

            <div style={{ marginTop: 28 }}>
              <div className={s.screen4EarnXl}>${fmt(yearAnim)}</div>
              <div className={s.screen4PreviewMuted} style={{ marginTop: 4 }}>per year</div>
            </div>
            <div style={{ marginTop: 24 }}>
              <div className={s.screen4EarnLg}>${fmt(monthAnim)}</div>
              <div className={s.screen4PreviewMuted}>per month</div>
            </div>
            <div style={{ marginTop: 16 }}>
              <div className={s.screen4EarnMd}>${fmt(dayAnim)}</div>
              <div className={s.screen4PreviewMuted}>per day</div>
            </div>

            <div className={s.screen4PreviewDivider} />
            <p className={s.screen4PreviewFoot}>
              This is your floor.<br />
              Your agent will aim higher and report every action with proof.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Screen 5: Activation ─────────────────────────────────────────────────────

function Screen5Activation({ chain, onView }: { chain: string; onView: () => void }) {
  const [phase, setPhase] = useState<1 | 2>(1)
  const [scanIdx, setScanIdx] = useState(0)

  const protocolsToScan = [
    { id: 'aave', label: 'Scanning Aave V3…' },
    { id: 'morpho', label: 'Scanning Morpho Blue…' },
    { id: 'pendle', label: 'Scanning Pendle YT…' },
  ]

  useEffect(() => {
    const ids = [
      setTimeout(() => setScanIdx(1), 800),
      setTimeout(() => setScanIdx(2), 1600),
      setTimeout(() => setPhase(2), 2800),
    ]
    return () => ids.forEach(clearTimeout)
  }, [])

  const cur = protocolsToScan[scanIdx]

  return (
    <div className={s.screenInner} style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      minHeight: 'calc(100vh - 168px)', color: '#fff',
    }}>
      <div style={{ position: 'relative', width: 120, height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {phase === 2 && (
          <span className={s.pulseRing} style={{
            position: 'absolute', inset: 16,
            borderRadius: '50%', border: '2px solid var(--earn)',
            display: 'block',
          }} />
        )}
        <div className={phase === 1 ? s.spinSlow : undefined}>
          <GekoMark size={80} />
        </div>
      </div>

      {phase === 1 && (
        <div className={`${s.scanLine} ${s.activationScan}`} style={{
          marginTop: 32, height: 24,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          fontSize: 14,
        }}>
          <ProtocolMark id={cur.id} size={18} />
          <span key={scanIdx}>{cur.label}</span>
        </div>
      )}

      {phase === 2 && (
        <div className={s.fadeUp} style={{ marginTop: 32, textAlign: 'center' }}>
          <div className={s.activationTitle} style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.015em', lineHeight: 1.2 }}>
            Your agent is running.
          </div>
          <div className={s.activationSub} style={{ fontSize: 16, marginTop: 12, lineHeight: 1.6 }}>
            Scanning {chain === '0g' ? '0G Network' : '8 protocols across Arbitrum'} for better yield.<br />
            First action typically within the next 60 seconds.
          </div>
          <button
            className={`${s.btn} ${s.fadeUpDelay}`}
            style={{ marginTop: 40, width: 240, height: 52 }}
            onClick={onView}
          >
            View your strategy <span style={{ opacity: 0.8 }}>→</span>
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function OnboardPage() {
  const router = useRouter()
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain } = useSwitchChain()
  const onArbitrum = chainId === arbitrum.id

  // Onboarding state
  const [screen, setScreen] = useState(0)
  const [direction, setDirection] = useState(1)
  const [chain, setChain] = useState('arbitrum')
  const [name, setName] = useState('')
  const [tValue, setT] = useState(0.33)    // balanced by default
  const [amount, setAmount] = useState(1)
  const [signed, setSigned] = useState(false)
  const [txStep, setTxStep] = useState(0)
  const [error, setError] = useState('')

  // Contract state
  const [signature, setSignature] = useState<Hex | ''>('')
  const [policyMessage, setPolicyMessage] = useState<PolicyMessage | null>(null)

  const { data: currentNonce } = useReadYieldGekoNonces({
    address: VAULT_ADDRESS,
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && VAULT_ADDRESS) },
  })

  // USDC EIP-2612 permit nonce — needed to build the permit message
  const { data: usdcNonce } = useReadContract({
    address: USDC_ADDRESS,
    abi: [{ name: 'nonces', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const,
    functionName: 'nonces',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  })

  const { data: usdcBalanceRaw } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  })

  // When wallet is connected: show real balance (with decimals, no floor).
  // When wallet not connected: show 2400 as demo placeholder.
  // When connected but still loading: show 0 temporarily.
  const usdcBalance = !address
    ? 2400
    : usdcBalanceRaw !== undefined
      ? parseFloat(formatUnits(usdcBalanceRaw as bigint, 6))
      : 0

  const { signTypedData, isPending: isSigning } = useSignTypedData()
  const { writeContract } = useWriteContract()

  // Navigation helpers
  const goTo = (next: number) => {
    setDirection(next > screen ? 1 : -1)
    setScreen(next)
  }
  const goBack = () => { if (screen > 0) goTo(screen - 1) }

  // Reset transient state when leaving screens
  useEffect(() => { if (screen !== 3) setSigned(false) }, [screen])
  useEffect(() => { if (screen !== 4) setTxStep(0) }, [screen])
  useEffect(() => { if (screen !== 4) setError('') }, [screen])

  // Sign policy — with demo fallback when wallet not connected
  const handleSign = useCallback(() => {
    setError('')

    // Demo mode: no wallet connected or no vault — simulate signing
    if (!address || !VAULT_ADDRESS) {
      setSigned(true)
      setSignature('0xdemo')
      setPolicyMessage({
        user: '0x0000000000000000000000000000000000000000',
        managedUSD: parseUnits(amount.toString(), 6),
        minAPY: BigInt(Math.round(valuesAtT(tValue).apy * 100)),
        maxDrawdownBps: BigInt(Math.round(valuesAtT(tValue).drawdown * 100)),
        maxFeeBps: BigInt(1000), nonce: BigInt(0),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60),
      })
      setTimeout(() => goTo(4), 900)
      return
    }

    const nonce = currentNonce ?? BigInt(0)
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60)
    const { apy, drawdown } = valuesAtT(tValue)

    const message: PolicyMessage = {
      user: address as Hex,
      managedUSD: parseUnits(amount.toString(), 6),
      minAPY: BigInt(Math.round(apy * 100)),
      maxDrawdownBps: BigInt(Math.round(drawdown * 100)),
      maxFeeBps: BigInt(1000),
      nonce, deadline,
    }

    signTypedData(
      {
        domain: {
          name: 'YieldGeko', version: '1',
          chainId: BigInt(chainId),
          verifyingContract: VAULT_ADDRESS,
        },
        types: POLICY_TYPES,
        primaryType: 'Policy',
        message,
      },
      {
        onSuccess: (sig) => {
          setSignature(sig)
          setPolicyMessage(message)
          setSigned(true)
          setTimeout(() => goTo(4), 900)
        },
        onError: (err) => setError(err.message),
      },
    )
  }, [address, amount, tValue, chainId, currentNonce, signTypedData, goTo])

  // On-chain deposit — with demo fallback when vault not deployed
  const handleDeposit = useCallback(() => {
    // Demo mode: no vault deployed — simulate the flow
    if (!VAULT_ADDRESS || !address) {
      setError('')
      setTxStep(1)
      setTimeout(() => setTxStep(2), 1100)
      setTimeout(() => setTxStep(3), 2200)
      setTimeout(() => goTo(5), 2900)
      return
    }

    if (!signature || !policyMessage) return
    if (!onArbitrum) { switchChain({ chainId: arbitrum.id }); return }
    setError('')

    const agentUrl  = process.env.NEXT_PUBLIC_AGENT_SSE_URL?.replace('/events', '') ?? 'http://localhost:3001'
    const agentKey  = process.env.NEXT_PUBLIC_AGENT_API_KEY ?? ''
    const authHeader: Record<string, string> = agentKey ? { 'Authorization': `Bearer ${agentKey}` } : {}
    const amountWei = parseUnits(amount.toString(), 6)
    const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60)
    const permitNonce = usdcNonce ?? BigInt(0)

    // Step 1: sign USDC permit off-chain (no gas — wallet popup only)
    setTxStep(1)
    signTypedData(
      {
        domain: { name: 'USD Coin', version: '2', chainId: BigInt(chainId), verifyingContract: USDC_ADDRESS },
        types: PERMIT_TYPES,
        primaryType: 'Permit',
        message: { owner: address as Hex, spender: VAULT_ADDRESS, value: amountWei, nonce: permitNonce, deadline: permitDeadline },
      },
      {
        onSuccess: async (permitSig) => {
          // Step 2: agent sponsors registerPolicy + USDC.permit (no user gas)
          setTxStep(2)
          try {
            const onboardRes = await fetch(`${agentUrl}/api/onboard`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader },
              body: JSON.stringify({
                userAddress: address,
                policy: {
                  user: policyMessage.user,
                  managedUSD: policyMessage.managedUSD.toString(),
                  minAPY: policyMessage.minAPY.toString(),
                  maxDrawdownBps: policyMessage.maxDrawdownBps.toString(),
                  maxFeeBps: policyMessage.maxFeeBps.toString(),
                  nonce: policyMessage.nonce.toString(),
                  deadline: policyMessage.deadline.toString(),
                },
                policySig: signature,
                permitSig,
                permitAmount: amountWei.toString(),
                permitDeadline: permitDeadline.toString(),
              }),
            })
            if (!onboardRes.ok) {
              const err = await onboardRes.json().catch(() => ({}))
              throw new Error(err.error ?? 'Agent onboarding failed')
            }
          } catch (err: any) {
            setError(err.message)
            setTxStep(0)
            return
          }

          // Step 3: user calls vault.deposit (only tx user pays for, ~$0.03)
          writeContract(
            { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'deposit', args: [USDC_ADDRESS, amountWei] },
            {
              onSuccess: async () => {
                setTxStep(3)
                try {
                  const { apy, drawdown } = valuesAtT(tValue)
                  await fetch(`${agentUrl}/api/register`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader },
                    body: JSON.stringify({
                      userAddress: address, displayName: `${name || 'My strategy'} — ${address.slice(0, 8)}`,
                      riskTier: tValue < 0.165 ? 'conservative' : tValue < 0.495 ? 'balanced' : tValue < 0.83 ? 'aggressive' : 'advanced',
                      managedUSD: amount, minAPY: apy / 100,
                      maxSlippageBps: 50, maxDrawdownPct: drawdown / 100,
                      maxFeeBps: 1000, migrationThresholdPct: 3, chainId: 42161,
                    }),
                  })
                } catch { /* non-blocking */ }
                setTimeout(() => goTo(5), 700)
              },
              onError: (err) => { setError(err.message); setTxStep(0) },
            },
          )
        },
        onError: (err) => { setError(err.message); setTxStep(0) },
      },
    )
  }, [address, amount, tValue, name, signature, policyMessage, usdcNonce, chainId, onArbitrum, switchChain, writeContract, signTypedData, goTo])

  const isDark = screen === 5

  const stickyPadScreen = screen === 2 || screen === 3 || screen === 4

  return (
    <div
      className={`${s.shell} ${isDark ? s.shellDark : ''}`}
      data-yieldgeko-onboard={ONBOARD_UI_MARK}
    >

      {screen < 5 && (
        <nav className={s.onboardNavLeft} aria-label="Onboarding">
          <div className={s.onboardNavCluster}>
            {screen > 0 && (
              <button type="button" className={s.backChevron} onClick={goBack} aria-label="Back">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            <button type="button" className={s.exitSetup} onClick={() => router.push('/')}>
              {screen === 0 ? 'Exit setup' : 'Exit'}
            </button>
          </div>
        </nav>
      )}

      {/* Progress dots */}
      <div className={s.progressDots} aria-label="Progress">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={`${s.dot} ${i === screen ? s.dotActive : i < screen ? s.dotDone : ''}`} />
        ))}
      </div>

      {/* Screen stage */}
      <ScreenStage
        screen={screen}
        direction={direction}
        screenClassName={stickyPadScreen ? s.screenPadStickyMobile : undefined}
      >
        {screen === 0 && <Screen0Chain chain={chain} setChain={setChain} onContinue={() => goTo(1)} />}
        {screen === 1 && <Screen1Name name={name} setName={setName} onContinue={() => goTo(2)} />}
        {screen === 2 && (
          <Screen2Dial
            tValue={tValue} setT={setT}
            amount={amount} setAmount={setAmount}
            balance={usdcBalance}
            onContinue={() => goTo(3)}
          />
        )}
        {screen === 3 && (
          <Screen3Policy
            name={name} chain={chain} amount={amount} tValue={tValue}
            signed={signed} onSign={handleSign} error={error}
          />
        )}
        {screen === 4 && (
          <Screen4Fund
            amount={amount} setAmount={setAmount}
            balance={usdcBalance} tValue={tValue}
            txStep={txStep} onDeposit={handleDeposit} error={error}
          />
        )}
        {screen === 5 && (
          <Screen5Activation
            chain={chain}
            onView={() => router.push('/dashboard')}
          />
        )}
      </ScreenStage>
    </div>
  )
}
