'use client'

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
  { name: 'approve',   type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view',       inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

const VAULT_ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  {
    name: 'registerPolicy', type: 'function', stateMutability: 'nonpayable',
    inputs: [{
      name: '_p', type: 'tuple',
      components: [
        { name: 'user',           type: 'address' },
        { name: 'managedUSD',     type: 'uint256' },
        { name: 'minAPY',         type: 'uint256' },
        { name: 'maxDrawdownBps', type: 'uint256' },
        { name: 'maxFeeBps',      type: 'uint256' },
        { name: 'nonce',          type: 'uint256' },
        { name: 'deadline',       type: 'uint256' },
      ],
    }, { name: '_sig', type: 'bytes' }],
    outputs: [],
  },
] as const

const POLICY_TYPES = {
  Policy: [
    { name: 'user',           type: 'address' },
    { name: 'managedUSD',     type: 'uint256' },
    { name: 'minAPY',         type: 'uint256' },
    { name: 'maxDrawdownBps', type: 'uint256' },
    { name: 'maxFeeBps',      type: 'uint256' },
    { name: 'nonce',          type: 'uint256' },
    { name: 'deadline',       type: 'uint256' },
  ],
} as const

type PolicyMessage = {
  user: Hex; managedUSD: bigint; minAPY: bigint
  maxDrawdownBps: bigint; maxFeeBps: bigint; nonce: bigint; deadline: bigint
}

// ─── Dial math ───────────────────────────────────────────────────────────────

const PRESETS = [
  { id: 'conservative', label: 'Conservative', t: 0,    apy: 8,  drawdown: 10 },
  { id: 'balanced',     label: 'Balanced',     t: 0.33, apy: 12, drawdown: 12 },
  { id: 'aggressive',   label: 'Aggressive',   t: 0.66, apy: 20, drawdown: 18 },
  { id: 'advanced',     label: 'Advanced',     t: 1,    apy: 30, drawdown: 25 },
] as const

const valuesAtT = (t: number) => {
  const apyStops  = [8, 12, 20, 30]
  const ddStops   = [10, 12, 18, 25]
  const segs      = [0, 0.33, 0.66, 1]
  for (let i = 0; i < segs.length - 1; i++) {
    if (t >= segs[i] && t <= segs[i + 1]) {
      const u   = (t - segs[i]) / (segs[i + 1] - segs[i])
      const apy = Math.round(apyStops[i] + u * (apyStops[i + 1] - apyStops[i]))
      const dd  = Math.round(ddStops[i]  + u * (ddStops[i + 1]  - ddStops[i]))
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
  '0g':     'https://assets.coingecko.com/asset_platforms/images/184/standard/0g.png',
}

const PROTO_LOGOS: Record<string, string> = {
  aave:    'https://assets.coingecko.com/coins/images/12645/standard/aave-token-round.png?1720472354',
  morpho:  'https://assets.coingecko.com/coins/images/29837/standard/morpho.png',
  uniswap: 'https://assets.coingecko.com/coins/images/12504/standard/uniswap-logo.png',
  pendle:  'https://assets.coingecko.com/coins/images/28500/standard/pendle-logo.png',
  gmx:     'https://assets.coingecko.com/coins/images/18323/standard/arbit.png',
}

// Shared logo circle wrapper — clips image to circle, consistent sizing
function LogoCircle({ src, alt, size }: { src: string; alt: string; size: number }) {
  return (
    <div style={{
      width: size, height: size,
      borderRadius: '50%',
      overflow: 'hidden',
      flexShrink: 0,
      background: '#F5F5F4',
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
  const r  = size / 2 - 24
  const stroke = 8

  const trackStart = polar(cx, cy, r, -120)
  const trackEnd   = polar(cx, cy, r, +120)

  const theta      = tToTheta(value)
  const handle     = polar(cx, cy, r, theta)

  const sweepDeg = theta - (-120)
  const largeArc = sweepDeg > 180 ? 1 : 0
  const activeD  = `M ${trackStart.x} ${trackStart.y} A ${r} ${r} 0 ${largeArc} 1 ${handle.x} ${handle.y}`
  const trackD   = `M ${trackStart.x} ${trackStart.y} A ${r} ${r} 0 1 1 ${trackEnd.x} ${trackEnd.y}`

  const svgRef      = useRef<SVGSVGElement>(null)
  const draggingRef = useRef(false)

  const updateFromClient = useCallback((clientX: number, clientY: number) => {
    if (!svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const px   = ((clientX - rect.left) / rect.width)  * size
    const py   = ((clientY - rect.top)  / rect.height) * size
    const dx   = px - cx
    const dy   = py - cy
    let thetaDeg = (Math.atan2(dx, -dy) * 180) / Math.PI
    if (thetaDeg > 120)  thetaDeg = 120
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
    try { svgRef.current?.releasePointerCapture(e.pointerId) } catch {}
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
            <stop offset="0%"   stopColor="#16A34A" />
            <stop offset="50%"  stopColor="#EAB308" />
            <stop offset="100%" stopColor="#EA580C" />
          </linearGradient>
        </defs>

        <path d={trackD} stroke="#E7E5E4" strokeWidth={stroke} fill="none" strokeLinecap="round" />
        <path d={activeD} stroke="url(#dial-grad)" strokeWidth={stroke} fill="none" strokeLinecap="round" />

        {PRESETS.map((p) => {
          const tk    = polar(cx, cy, r, tToTheta(p.t))
          const inner = polar(cx, cy, r - 14, tToTheta(p.t))
          const isActive = Math.abs(p.t - value) < 0.04
          return (
            <line key={p.id}
              x1={inner.x} y1={inner.y} x2={tk.x} y2={tk.y}
              stroke={isActive ? '#1C1917' : '#A8A29E'}
              strokeWidth={isActive ? 2 : 1}
              strokeLinecap="round"
              opacity={isActive ? 1 : 0.6}
            />
          )
        })}

        <circle cx={handle.x} cy={handle.y} r={14} fill="#FFFFFF" stroke="#EA580C" strokeWidth={2}
          style={{ filter: 'drop-shadow(0 4px 12px rgba(28,25,23,0.10))' }} />
        <circle cx={handle.x} cy={handle.y} r={4} fill="#EA580C" />
      </svg>

      {/* Center readout */}
      <div style={{
        position: 'absolute', top: cy - 30, left: 0, width: '100%',
        textAlign: 'center', pointerEvents: 'none',
      }}>
        <div style={{ fontSize: 48, fontWeight: 700, color: '#1C1917', letterSpacing: '-0.025em', lineHeight: 1 }}>
          {apy}%
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#78716C', textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 6 }}>
          minimum
        </div>
      </div>

      {/* Preset labels */}
      <div style={{
        position: 'absolute', left: 0, right: 0, top: cy + r + 4,
        display: 'flex', justifyContent: 'space-between',
        padding: '0 6px', fontSize: 11, pointerEvents: 'none',
      }}>
        {PRESETS.map((p) => {
          const isActive = Math.abs(p.t - value) < 0.04
          return (
            <div key={p.id} style={{
              textAlign: 'center',
              color: isActive ? '#1C1917' : '#A8A29E',
              fontWeight: isActive ? 600 : 500,
              transition: 'color 200ms ease',
            }}>
              {p.label}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Screen stage (slide transition) ─────────────────────────────────────────

function ScreenStage({ screen, direction, children }: { screen: number; direction: number; children: ReactNode }) {
  return (
    <div key={screen} className={s.stage} style={{
      animation: `${direction === 1 ? 'slideInRight' : 'slideInLeft'} 280ms cubic-bezier(0.22,1,0.36,1)`,
    }}>
      <div className={s.screen}>{children}</div>
    </div>
  )
}

// ─── Screen 0: Choose chain ───────────────────────────────────────────────────

function Screen0Chain({
  chain, setChain, onContinue,
}: { chain: string; setChain: (c: string) => void; onContinue: () => void }) {
  return (
    <div className={s.screenInner} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ fontSize: 12, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#A8A29E', marginBottom: 32 }}>
        Where should your strategy run?
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
        gap: 20,
        width: '100%',
        maxWidth: 900,
      }}>
        <ChainCard id="arbitrum" name="Arbitrum" description="8 protocols available"
          subline="Most opportunities" subline2="Best for diversified strategies"
          pills={[{ id: 'aave', name: 'Aave' }, { id: 'morpho', name: 'Morpho' }, { id: 'pendle', name: 'Pendle' }, { id: 'gmx', name: 'GMX' }, { id: 'uniswap', name: 'UniV3' }]}
          selected={chain === 'arbitrum'} onSelect={() => setChain('arbitrum')}
        />
        <ChainCard id="0g" name="0G Network" description="Native 0G yield"
          subline="$15.5M TVL live" subline2="Built for the 0G ecosystem"
          pills={[{ id: 'uniswap', name: 'UniV3 on 0G' }]}
          selected={chain === '0g'} onSelect={() => setChain('0g')}
        />
      </div>

      <button
        className={`${s.btn} ${s.btnLg}`}
        style={{
          marginTop: 32, width: '100%', maxWidth: 900,
          opacity: chain ? 1 : 0,
          transform: chain ? 'translateY(0)' : 'translateY(8px)',
          transition: 'opacity 200ms ease, transform 200ms ease',
          pointerEvents: chain ? 'auto' : 'none',
        }}
        onClick={onContinue}
      >
        Continue <span style={{ opacity: 0.8 }}>→</span>
      </button>
    </div>
  )
}

function ChainCard({ id, name, description, subline, subline2, pills, selected, onSelect }: {
  id: string; name: string; description: string; subline: string; subline2: string
  pills: { id: string; name: string }[]; selected: boolean; onSelect: () => void
}) {
  return (
    <button onClick={onSelect} style={{
      position: 'relative',
      background: selected ? '#FFFDF9' : '#FFFFFF',
      border: selected ? '2px solid #EA580C' : '1px solid #E7E5E4',
      borderRadius: 20,
      padding: selected ? 39 : 40,
      textAlign: 'left',
      cursor: 'pointer',
      boxShadow: '0 1px 3px rgba(28,25,23,0.06), 0 1px 2px rgba(28,25,23,0.04)',
      opacity: selected ? 1 : 0.78,
      transform: selected ? 'scale(1.005)' : 'scale(1)',
      transition: 'border-color 200ms ease, background 200ms ease, transform 150ms ease, opacity 200ms ease',
      minHeight: 320,
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'inherit',
    }}>
      <ChainMark id={id} size={48} />

      {selected && (
        <div style={{
          position: 'absolute', top: 20, right: 20,
          width: 24, height: 24, borderRadius: '50%',
          background: '#EA580C',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 2px 6px rgba(234,88,12,0.3)',
        }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 6L5 8.5L9.5 3.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 24, fontWeight: 600, color: '#1C1917', letterSpacing: '-0.01em' }}>{name}</div>
        <div style={{ fontSize: 14, color: '#78716C', marginTop: 6, marginBottom: 16 }}>{description}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {pills.map((p) => <ProtocolPill key={p.id} id={p.id} name={p.name} />)}
        </div>
      </div>

      <div style={{ marginTop: 'auto', paddingTop: 24 }}>
        <div style={{ fontSize: 14, color: '#78716C' }}>{subline}</div>
        <div style={{ fontSize: 14, color: '#A8A29E', marginTop: 4 }}>{subline2}</div>
      </div>
    </button>
  )
}

// ─── Screen 1: Name it ────────────────────────────────────────────────────────

function Screen1Name({ name, setName, onContinue }: { name: string; setName: (n: string) => void; onContinue: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  return (
    <div className={s.screenInner} style={{ maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
      <h1 style={{ fontSize: 40, fontWeight: 600, color: '#1C1917', letterSpacing: '-0.015em', lineHeight: 1.2, margin: 0 }}>
        What do you want to call this?
      </h1>

      <input
        ref={inputRef}
        className={s.input}
        style={{ marginTop: 32, textAlign: 'left' }}
        placeholder="My first strategy"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onContinue() }}
      />

      <div style={{ marginTop: 16, fontSize: 14, color: '#A8A29E' }}>
        You can run multiple strategies at the same time.
      </div>

      <button className={`${s.btn} ${s.btnLg} ${s.btnBlock}`} style={{ marginTop: 40 }} onClick={onContinue}>
        Continue <span style={{ opacity: 0.8 }}>→</span>
      </button>

      <button className={s.linkish} style={{ marginTop: 16 }} onClick={() => { setName('My strategy'); onContinue() }}>
        Skip and auto-name
      </button>
    </div>
  )
}

// ─── Screen 2: The Dial ───────────────────────────────────────────────────────

const PROTOCOLS = [
  { id: 'aave',    name: 'Aave V3',     kind: 'Lending' },
  { id: 'morpho',  name: 'Morpho Blue', kind: 'Lending' },
  { id: 'uniswap', name: 'Uniswap V3',  kind: 'LP' },
  { id: 'pendle',  name: 'Pendle',      kind: 'Yield trading' },
  { id: 'gmx',     name: 'GMX V2',      kind: 'Perps LP' },
]

function Screen2Dial({
  tValue, setT, amount, setAmount, balance, onContinue,
}: {
  tValue: number; setT: (t: number) => void
  amount: number; setAmount: (a: number) => void
  balance: number; onContinue: () => void
}) {
  const { apy, drawdown } = valuesAtT(tValue)
  const active = activeProtocolSet(tValue)
  const valid  = amount >= 100 && amount <= balance

  return (
    <div className={s.screenInner} style={{ maxWidth: 1080, margin: '0 auto' }}>
      <div className={s.screen2Grid}>

        {/* LEFT — dial + amount */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 12 }}>
            <Dial value={tValue} onChange={setT} />
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap', marginTop: 36 }}>
            <span className={s.statChip}><span className={s.statLbl}>Min APY</span> <span className={s.statVal}>{apy}%</span></span>
            <span className={s.statChip}><span className={s.statLbl}>Safety net</span> <span className={s.statVal}>{drawdown}%</span></span>
            <span className={s.statChip}><span className={s.statLbl}>Fee cap</span> <span className={s.statVal}>0.5%</span></span>
          </div>

          <div style={{ marginTop: 40 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: '#78716C', marginBottom: 8 }}>How much USDC?</div>
            <div style={{
              display: 'flex', alignItems: 'center',
              height: 52, padding: '0 18px',
              background: '#FFFFFF', border: '1px solid #E7E5E4', borderRadius: 10,
            }}>
              <span style={{ color: '#A8A29E', fontSize: 18, fontWeight: 500, marginRight: 4 }}>$</span>
              <input
                type="number" min={100}
                value={amount}
                onChange={(e) => setAmount(parseInt(e.target.value || '0', 10))}
                style={{
                  flex: 1, height: '100%',
                  border: 'none', outline: 'none',
                  background: 'transparent',
                  fontSize: 18, fontWeight: 500, color: '#1C1917',
                  fontFamily: 'inherit',
                }}
              />
              <button
                onClick={() => setAmount(balance)}
                style={{
                  background: '#FFF7ED', color: '#EA580C',
                  border: 'none', padding: '6px 10px', borderRadius: 6,
                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  letterSpacing: '0.04em', fontFamily: 'inherit',
                }}
              >MAX</button>
            </div>
            <div style={{ fontSize: 13, color: '#A8A29E', marginTop: 8 }}>
              Balance: ${balance.toLocaleString()} USDC
            </div>
          </div>
        </div>

        {/* RIGHT — protocol mix */}
        <div>
          <div style={{ fontSize: 14, fontWeight: 500, color: '#78716C', marginBottom: 20 }}>
            What your agent will use
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {PROTOCOLS.map((p) => {
              const isActive = active.has(p.id)
              return (
                <div key={p.id} style={{
                  background: isActive ? '#FFFDF9' : '#FFFFFF',
                  border: isActive ? '1px solid #EA580C' : '1px solid #E7E5E4',
                  borderRadius: 12, padding: 16,
                  opacity: isActive ? 1 : 0.35,
                  transform: isActive ? 'scale(1)' : 'scale(0.97)',
                  transition: 'opacity 300ms ease, transform 300ms cubic-bezier(0.22,1,0.36,1), border-color 200ms ease',
                  position: 'relative',
                }}>
                  <ProtocolMark id={p.id} size={32} />
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#1C1917', marginTop: 10 }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: '#A8A29E', marginTop: 2 }}>{p.kind}</div>
                  {isActive && (
                    <div style={{
                      position: 'absolute', bottom: 12, right: 12,
                      width: 6, height: 6, borderRadius: '50%',
                      background: '#EA580C',
                    }} />
                  )}
                </div>
              )
            })}
          </div>

          <button
            className={`${s.btn} ${s.btnLg} ${s.btnBlock}`}
            style={{ marginTop: 28 }}
            onClick={onContinue}
            disabled={!valid}
          >
            Set my limits <span style={{ opacity: 0.8 }}>→</span>
          </button>
          {!valid && (
            <div style={{ fontSize: 12, color: '#A8A29E', textAlign: 'center', marginTop: 10 }}>
              Minimum deposit is $100.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Screen 3: Policy ─────────────────────────────────────────────────────────

function PolicyRow({ label, value, valueColor, valueWeight, last = false }: {
  label: string; value: string; valueColor?: string; valueWeight?: number; last?: boolean
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '10px 0',
      borderBottom: last ? 'none' : '1px solid #F5F5F4',
    }}>
      <div style={{ fontSize: 14, color: '#78716C' }}>{label}</div>
      <div style={{ fontSize: 14, color: valueColor ?? '#1C1917', fontWeight: valueWeight ?? 500 }}>{value}</div>
    </div>
  )
}

function SignedSeal() {
  return (
    <div style={{ marginTop: 32, position: 'relative', height: 96 }}>
      <div className={s.sealAppear} style={{
        position: 'absolute', right: 0, top: 0,
        width: 56, height: 56, borderRadius: '50%',
        background: 'radial-gradient(circle at 30% 30%, #F97316, #C2410C)',
        boxShadow: '0 8px 24px rgba(234,88,12,0.32), inset 0 -4px 8px rgba(0,0,0,0.18)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <path d="M5 11.5L9 15.5L17 7" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className={s.sealText} style={{
        position: 'absolute', right: 0, top: 64,
        fontSize: 13, color: '#16A34A', fontWeight: 500,
      }}>
        Policy signed ✓
      </div>
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
  const chainName = chain === '0g' ? '0G Network' : 'Arbitrum'

  return (
    <div className={s.screenInner} style={{ maxWidth: 480, margin: '0 auto' }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: 32, fontWeight: 600, color: '#1C1917', letterSpacing: '-0.015em', margin: 0, lineHeight: 1.2 }}>
          Review your policy
        </h1>
        <div style={{ fontSize: 16, color: '#78716C', marginTop: 8, lineHeight: 1.5 }}>
          Sign once. Your agent runs within these limits — nothing more.
        </div>
      </div>

      <div style={{
        position: 'relative', marginTop: 32,
        background: '#FFFFFF', border: '1px solid #E7E5E4',
        borderRadius: 20, padding: 40,
        boxShadow: '0 4px 12px rgba(28,25,23,0.08)',
      }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#A8A29E', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
          Yield policy
        </div>
        <div style={{ height: 1, background: '#E7E5E4', margin: '20px 0' }} />

        <PolicyRow label="Strategy"    value={name || 'My strategy'} />
        <PolicyRow label="Network"     value={chainName} />
        <PolicyRow label="Amount"      value={`$${Number(amount).toLocaleString()} USDC`} />
        <PolicyRow label="Minimum APY" value={`${apy.toFixed(1)}%`} valueColor="#16A34A" valueWeight={600} />
        <PolicyRow label="Safety net"  value={`${drawdown}% max drawdown`} />
        <PolicyRow label="Fee cap"     value="0.5%" last />

        <div style={{ height: 1, background: '#E7E5E4', margin: '20px 0' }} />
        <div style={{ fontSize: 13, color: '#78716C', lineHeight: 1.6 }}>
          Your agent may only act within these exact bounds. No exceptions.
          This policy is valid for 365 days.
        </div>

        {error && (
          <div style={{ marginTop: 16, fontSize: 13, color: '#DC2626', background: '#FEF2F2', borderRadius: 8, padding: '10px 14px' }}>
            {error}
          </div>
        )}

        {!signed ? (
          <button
            className={`${s.btn} ${s.btnLg} ${s.btnBlock} ${s.btnDark}`}
            style={{ marginTop: 32, height: 56, fontSize: 17 }}
            onClick={onSign}
          >
            Sign policy
          </button>
        ) : (
          <SignedSeal />
        )}
      </div>
    </div>
  )
}

// ─── Screen 4: Fund it ────────────────────────────────────────────────────────

function useCountUp(target: number) {
  const [v, setV] = useState(target)
  const startRef  = useRef(target)
  useEffect(() => {
    const from = startRef.current
    const dur  = 320
    const t0   = performance.now()
    let raf: number
    const step = (t: number) => {
      const k     = Math.min(1, (t - t0) / dur)
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
      <div style={{
        width: 18, height: 18, borderRadius: '50%', background: '#16A34A',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 5L4 7L8 3" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    )
  }
  if (state === 'active') {
    return (
      <div className={s.livePulse} style={{
        width: 14, height: 14, borderRadius: '50%', background: '#EA580C',
        boxShadow: '0 0 0 4px rgba(234,88,12,0.18)',
      }} />
    )
  }
  return <div style={{ width: 12, height: 12, borderRadius: '50%', border: '1px solid #D6D3D1' }} />
}

function TxTrail({ step }: { step: number }) {
  const items = [
    { label: 'Register policy' },
    { label: 'Approve USDC' },
    { label: 'Deposit' },
  ]
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      {items.map((it, i) => {
        const completed = step >= i + 2 || step === 3
        const isActive  = step === i + 1 && step !== 3
        const dotState  = completed ? 'done' : isActive ? 'active' : 'pending'
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', flex: i < items.length - 1 ? 1 : undefined, gap: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <Dot state={dotState} />
              <div style={{
                fontSize: 13, fontWeight: 500,
                color: dotState === 'pending' ? '#A8A29E' : dotState === 'active' ? '#1C1917' : '#15803D',
              }}>
                {it.label}
              </div>
            </div>
            {i < items.length - 1 && (
              <div style={{
                flex: 1, height: 1, minWidth: 8,
                background: completed ? '#16A34A' : '#E7E5E4',
                transition: 'background 240ms ease',
                margin: '0 8px',
              }} />
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
  const yearly  = (amount * apy) / 100
  const monthly = yearly / 12
  const daily   = yearly / 365

  const [editing, setEditing] = useState(false)
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const yearAnim  = useCountUp(yearly)
  const monthAnim = useCountUp(monthly)
  const dayAnim   = useCountUp(daily)

  const fillPct = Math.min(100, Math.max(0, (amount / balance) * 100))

  return (
    <div className={s.screenInner} style={{ maxWidth: 1080 }}>
      <div className={s.screen4Grid}>

        {/* LEFT */}
        <div>
          <h1 style={{ fontSize: 32, fontWeight: 600, color: '#1C1917', letterSpacing: '-0.015em', margin: 0 }}>
            Fund your strategy
          </h1>
          <div style={{ fontSize: 16, color: '#78716C', marginTop: 8 }}>
            Deposit USDC to activate your agent.
          </div>

          {/* Balance bar */}
          <div style={{ marginTop: 36 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: '#78716C', marginBottom: 12 }}>Your balance</div>
            <div style={{ height: 8, borderRadius: 999, background: '#E7E5E4', overflow: 'hidden' }}>
              <div style={{
                width: `${fillPct}%`, height: '100%', background: '#EA580C',
                borderRadius: 999, transition: 'width 240ms cubic-bezier(0.22,1,0.36,1)',
              }} />
            </div>
            <div style={{ fontSize: 13, color: '#A8A29E', marginTop: 8 }}>
              Using ${amount.toLocaleString()} of ${balance.toLocaleString()}
            </div>
          </div>

          {/* Big amount */}
          <div style={{ marginTop: 28 }}>
            {!editing ? (
              <>
                <div style={{ fontSize: 56, fontWeight: 700, color: '#1C1917', letterSpacing: '-0.025em', lineHeight: 1 }}>
                  ${amount.toLocaleString()}
                </div>
                <button className={s.linkish}
                  style={{ color: '#EA580C', marginTop: 8, textDecoration: 'underline', fontWeight: 500 }}
                  onClick={() => setEditing(true)}
                >
                  Edit amount
                </button>
              </>
            ) : (
              <input
                type="number" autoFocus defaultValue={amount}
                onBlur={(e) => {
                  setAmount(Math.max(100, Math.min(balance, parseInt(e.target.value || String(amount), 10))))
                  setEditing(false)
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                style={{
                  fontSize: 56, fontWeight: 700, color: '#1C1917',
                  letterSpacing: '-0.025em', lineHeight: 1,
                  border: 'none', outline: 'none', background: 'transparent',
                  width: '100%', fontFamily: 'inherit',
                  borderBottom: '2px solid #EA580C', paddingBottom: 4,
                }}
              />
            )}
          </div>

          {/* Tx trail */}
          <div style={{ marginTop: 36 }}>
            <TxTrail step={txStep} />
          </div>

          {error && (
            <div style={{ marginTop: 12, fontSize: 13, color: '#DC2626', background: '#FEF2F2', borderRadius: 8, padding: '10px 14px' }}>
              {error}
            </div>
          )}

          <button
            className={`${s.btn} ${s.btnLg} ${s.btnBlock}`}
            style={{ marginTop: 28, height: 56, fontSize: 17 }}
            onClick={onDeposit}
            disabled={txStep > 0 && txStep < 3}
          >
            {txStep === 0 && <>Register policy &amp; deposit ${amount.toLocaleString()} <span style={{ opacity: 0.8 }}>→</span></>}
            {(txStep === 1 || txStep === 2) && 'Confirming…'}
            {txStep === 3 && 'Funded ✓'}
          </button>

          <div style={{ fontSize: 13, color: '#A8A29E', textAlign: 'center', marginTop: 12, lineHeight: 1.6 }}>
            3 transactions required.<br />
            Transaction fee paid in ETH on Arbitrum.
          </div>
        </div>

        {/* RIGHT — earning preview */}
        <div>
          <div style={{
            background: '#FAFAF9', border: '1px solid #E7E5E4',
            borderRadius: 16, padding: 32, position: 'relative',
          }}>
            <div style={{
              position: 'absolute', top: 20, right: 20,
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 10, fontWeight: 600, color: '#16A34A',
              textTransform: 'uppercase', letterSpacing: '0.12em',
            }}>
              <span className={s.livePulse} style={{ width: 6, height: 6, borderRadius: '50%', background: '#16A34A', display: 'block' }} />
              Live
            </div>

            <div style={{ fontSize: 14, fontWeight: 500, color: '#78716C' }}>
              At {apy}% APY floor, ${amount.toLocaleString()} earns:
            </div>

            <div style={{ marginTop: 28 }}>
              <div style={{ fontSize: 44, fontWeight: 700, color: '#16A34A', letterSpacing: '-0.02em', lineHeight: 1 }}>
                ${fmt(yearAnim)}
              </div>
              <div style={{ fontSize: 13, color: '#78716C', marginTop: 4 }}>per year</div>
            </div>
            <div style={{ marginTop: 24 }}>
              <div style={{ fontSize: 28, fontWeight: 600, color: '#1C1917', letterSpacing: '-0.015em' }}>
                ${fmt(monthAnim)}
              </div>
              <div style={{ fontSize: 13, color: '#78716C', marginTop: 2 }}>per month</div>
            </div>
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 20, fontWeight: 500, color: '#78716C', letterSpacing: '-0.01em' }}>
                ${fmt(dayAnim)}
              </div>
              <div style={{ fontSize: 13, color: '#78716C', marginTop: 2 }}>per day</div>
            </div>

            <div style={{ height: 1, background: '#E7E5E4', margin: '28px 0 20px' }} />
            <div style={{ fontSize: 13, color: '#A8A29E', lineHeight: 1.6 }}>
              This is your floor.<br />
              Your agent will aim higher and report every action with proof.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Screen 5: Activation ─────────────────────────────────────────────────────

function Screen5Activation({ chain, onView }: { chain: string; onView: () => void }) {
  const [phase,   setPhase]   = useState<1 | 2>(1)
  const [scanIdx, setScanIdx] = useState(0)

  const protocolsToScan = [
    { id: 'aave',   label: 'Scanning Aave V3…' },
    { id: 'morpho', label: 'Scanning Morpho Blue…' },
    { id: 'pendle', label: 'Scanning Pendle YT…' },
  ]

  useEffect(() => {
    const ids = [
      setTimeout(() => setScanIdx(1), 800),
      setTimeout(() => setScanIdx(2), 1600),
      setTimeout(() => setPhase(2),  2800),
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
            borderRadius: '50%', border: '2px solid #16A34A',
            display: 'block',
          }} />
        )}
        <div className={phase === 1 ? s.spinSlow : undefined}>
          <GekoMark size={80} />
        </div>
      </div>

      {phase === 1 && (
        <div className={s.scanLine} style={{
          marginTop: 32, height: 24,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          fontSize: 14, color: '#94969A',
        }}>
          <ProtocolMark id={cur.id} size={18} />
          <span key={scanIdx}>{cur.label}</span>
        </div>
      )}

      {phase === 2 && (
        <div className={s.fadeUp} style={{ marginTop: 32, textAlign: 'center' }}>
          <div style={{ fontSize: 32, fontWeight: 600, color: '#FFFFFF', letterSpacing: '-0.015em', lineHeight: 1.2 }}>
            Your agent is running.
          </div>
          <div style={{ fontSize: 16, color: '#94969A', marginTop: 12, lineHeight: 1.6 }}>
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
  const { address }   = useAccount()
  const chainId        = useChainId()
  const { switchChain } = useSwitchChain()
  const onArbitrum     = chainId === arbitrum.id

  // Onboarding state
  const [screen,    setScreen]    = useState(0)
  const [direction, setDirection] = useState(1)
  const [chain,     setChain]     = useState('arbitrum')
  const [name,      setName]      = useState('')
  const [tValue,    setT]         = useState(0.33)    // balanced by default
  const [amount,    setAmount]    = useState(1000)
  const [signed,    setSigned]    = useState(false)
  const [txStep,    setTxStep]    = useState(0)
  const [error,     setError]     = useState('')

  // Contract state
  const [signature,     setSignature]     = useState<Hex | ''>('')
  const [policyMessage, setPolicyMessage] = useState<PolicyMessage | null>(null)

  const { data: currentNonce } = useReadYieldGekoNonces({
    address: VAULT_ADDRESS,
    args:    address ? [address] : undefined,
    query:   { enabled: Boolean(address && VAULT_ADDRESS) },
  })

  const { data: usdcBalanceRaw } = useReadContract({
    address: USDC_ADDRESS,
    abi:     ERC20_ABI,
    functionName: 'balanceOf',
    args:    address ? [address] : undefined,
    query:   { enabled: Boolean(address) },
  })

  const usdcBalance = usdcBalanceRaw
    ? Math.floor(parseFloat(formatUnits(usdcBalanceRaw as bigint, 6)))
    : 2400 // demo fallback

  const { signTypedData, isPending: isSigning } = useSignTypedData()
  const { writeContract } = useWriteContract()

  // Navigation helpers
  const goTo = (next: number) => {
    setDirection(next > screen ? 1 : -1)
    setScreen(next)
  }
  const goBack = () => { if (screen > 0) goTo(screen - 1) }

  // Reset transient state when leaving screens
  useEffect(() => { if (screen !== 3) setSigned(false) },   [screen])
  useEffect(() => { if (screen !== 4) setTxStep(0) },       [screen])
  useEffect(() => { if (screen !== 4) setError('') },        [screen])

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
        minAPY:     BigInt(Math.round(valuesAtT(tValue).apy * 100)),
        maxDrawdownBps: BigInt(Math.round(valuesAtT(tValue).drawdown * 100)),
        maxFeeBps: BigInt(50), nonce: BigInt(0),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60),
      })
      setTimeout(() => goTo(4), 900)
      return
    }

    const nonce    = currentNonce ?? BigInt(0)
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60)
    const { apy, drawdown } = valuesAtT(tValue)

    const message: PolicyMessage = {
      user:           address as Hex,
      managedUSD:     parseUnits(amount.toString(), 6),
      minAPY:         BigInt(Math.round(apy * 100)),
      maxDrawdownBps: BigInt(Math.round(drawdown * 100)),
      maxFeeBps:      BigInt(50),
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
    // Demo mode: no vault deployed — simulate the 3-tx flow
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
    setTxStep(1)

    writeContract(
      { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'registerPolicy', args: [policyMessage, signature as Hex] },
      {
        onSuccess: () => {
          setTxStep(2)
          const amountWei = parseUnits(amount.toString(), 6)
          writeContract(
            { address: USDC_ADDRESS, abi: ERC20_ABI, functionName: 'approve', args: [VAULT_ADDRESS, amountWei] },
            {
              onSuccess: () => {
                writeContract(
                  { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: 'deposit', args: [USDC_ADDRESS, amountWei] },
                  {
                    onSuccess: async () => {
                      setTxStep(3)
                      try {
                        const { apy, drawdown } = valuesAtT(tValue)
                        const agentUrl = process.env.NEXT_PUBLIC_AGENT_SSE_URL?.replace('/events', '') ?? 'http://localhost:3001'
                        await fetch(`${agentUrl}/api/register`, {
                          method: 'POST', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            userAddress: address, displayName: `${name || 'My strategy'} — ${address.slice(0, 8)}`,
                            riskTier: tValue < 0.165 ? 'conservative' : tValue < 0.495 ? 'balanced' : tValue < 0.83 ? 'aggressive' : 'advanced',
                            managedUSD: amount, minAPY: apy / 100,
                            maxSlippageBps: 50, maxDrawdownPct: drawdown / 100,
                            maxFeeBps: 50, migrationThresholdPct: 3, chainId: 42161,
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
        },
        onError: (err) => { setError(err.message); setTxStep(0) },
      },
    )
  }, [address, amount, tValue, name, signature, policyMessage, onArbitrum, switchChain, writeContract, goTo])

  const isDark = screen === 5

  return (
    <div className={`${s.shell} ${isDark ? s.shellDark : ''}`}>

      {/* Back chevron */}
      <button
        className={`${s.backChevron} ${screen === 0 ? s.backChevronHidden : ''}`}
        onClick={goBack}
        aria-label="Back"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Progress dots */}
      <div className={s.progressDots} aria-label="Progress">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={`${s.dot} ${i === screen ? s.dotActive : i < screen ? s.dotDone : ''}`} />
        ))}
      </div>

      {/* Screen stage */}
      <ScreenStage screen={screen} direction={direction}>
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
