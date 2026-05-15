'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import styles from '../../page.module.css'

function ArrowNE({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}>
      <line x1="7" y1="17" x2="17" y2="7" />
      <polyline points="7 7 17 7 17 17" />
    </svg>
  )
}

function useTicker(base: number, tickEveryMs = 7000, deltaRange = 0.08): number {
  const [val, setVal] = useState(base)
  useEffect(() => {
    const t = setInterval(() => {
      setVal(v => +(v + (Math.random() - 0.3) * deltaRange).toFixed(2))
    }, tickEveryMs)
    return () => clearInterval(t)
  }, [tickEveryMs, deltaRange])
  return val
}

function useTypewriter(lines: string[], holdMs = 2200, typeMs = 28, eraseMs = 14): string {
  const [display, setDisplay] = useState('')
  const idx = useRef(0)
  const charIdx = useRef(0)
  const erasing = useRef(false)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const tick = () => {
      const target = lines[idx.current]
      if (!erasing.current) {
        if (charIdx.current <= target.length) {
          setDisplay(target.slice(0, charIdx.current))
          charIdx.current++
          holdTimer.current = setTimeout(tick, typeMs)
        } else {
          holdTimer.current = setTimeout(() => { erasing.current = true; tick() }, holdMs)
        }
      } else {
        if (charIdx.current > 0) {
          charIdx.current--
          setDisplay(target.slice(0, charIdx.current))
          holdTimer.current = setTimeout(tick, eraseMs)
        } else {
          erasing.current = false
          idx.current = (idx.current + 1) % lines.length
          holdTimer.current = setTimeout(tick, 200)
        }
      }
    }
    holdTimer.current = setTimeout(tick, 600)
    return () => { if (holdTimer.current) clearTimeout(holdTimer.current) }
  }, [lines, holdMs, typeMs, eraseMs])

  return display
}

function ParticleCanvas({ width, height }: { width: number; height: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = width
    canvas.height = height

    
    const particles = Array.from({ length: 38 }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: Math.random() * 1.2 + 0.3,
      speed: Math.random() * 0.4 + 0.1,
      alpha: Math.random() * 0.35 + 0.05,
      drift: (Math.random() - 0.5) * 0.2,
    }))

    
    const nodes: Array<{ x: number; y: number; phase: number }> = []
    for (let i = 0; i < 6; i++) {
      nodes.push({ x: 80 + Math.random() * (width - 160), y: 60 + Math.random() * (height - 120), phase: Math.random() * Math.PI * 2 })
    }

    let t = 0

    const draw = () => {
      ctx.clearRect(0, 0, width, height)

      
      ctx.strokeStyle = 'rgba(255,255,255,0.022)'
      ctx.lineWidth = 0.5
      const gSize = 60
      for (let x = 0; x < width; x += gSize) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke() }
      for (let y = 0; y < height; y += gSize) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke() }

      
      const cx = width * 0.42, cy = height * 0.5
      const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, 260)
      grd.addColorStop(0, 'rgba(234,88,12,0.10)')
      grd.addColorStop(0.4, 'rgba(234,88,12,0.04)')
      grd.addColorStop(1, 'transparent')
      ctx.fillStyle = grd
      ctx.fillRect(0, 0, width, height)

      
      for (let ring = 0; ring < 3; ring++) {
        const age = ((t * 0.004 + ring * 0.33) % 1)
        const r = age * 220
        const alpha = (1 - age) * 0.18
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(234,88,12,${alpha})`
        ctx.lineWidth = 1
        ctx.stroke()
      }

      
      nodes.forEach((n, i) => {
        const pulse = 0.5 + 0.5 * Math.sin(t * 0.006 + n.phase)
        ctx.beginPath()
        ctx.arc(n.x, n.y, 1.5 + pulse * 1.5, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(234,88,12,${0.15 + pulse * 0.25})`
        ctx.fill()

        
        const next = nodes[(i + 1) % nodes.length]
        const dist = Math.hypot(next.x - n.x, next.y - n.y)
        if (dist < 250) {
          ctx.beginPath()
          ctx.moveTo(n.x, n.y); ctx.lineTo(next.x, next.y)
          ctx.strokeStyle = `rgba(234,88,12,${0.04 + pulse * 0.04})`
          ctx.lineWidth = 0.5
          ctx.stroke()
        }
      })

      
      particles.forEach(p => {
        p.y -= p.speed
        p.x += p.drift
        if (p.y < -4) { p.y = height + 4; p.x = Math.random() * width }
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(234,88,12,${p.alpha})`
        ctx.fill()
      })

      t++
      rafRef.current = requestAnimationFrame(draw)
    }

    draw()
    return () => cancelAnimationFrame(rafRef.current)
  }, [width, height])

  return (
    <canvas ref={canvasRef} style={{
      position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none',
    }} />
  )
}

const AGENT_MESSAGES = [
  'Executing autonomous harvest…',
  'Rebalancing to Uniswap V3…',
  'Scanning yield venues…',
  'Securing verifiable intent…',
  'Compounding LP fees…',
]

const DECISIONS = [
  { icon: '→', text: 'Rebalancing', sub: 'WETH/USDC · Uniswap V3', color: '#EA580C' },
  { icon: '⚡', text: 'Harvesting fees', sub: 'Net gain: +$4.82', color: '#4ADE80' },
  { icon: '↑', text: 'Migrating position', sub: 'Pendle YT · 24.8% APY', color: '#38BDF8' },
  { icon: '✓', text: 'Position healthy', sub: 'IL < fees · monitoring', color: '#4ADE80' },
]

export default function TestHeroPage() {
  const router = useRouter()

  
  const totalValue = useTicker(12847.33, 8000, 0.14)
  const earned = useTicker(312.14, 11000, 0.06)
  const apy = useTicker(22.1, 15000, 0.12)
  const morphoApy = useTicker(12.1, 13000, 0.08)

  
  const [decisionIdx, setDecisionIdx] = useState(0)
  const [proofFlash, setProofFlash] = useState(false)
  const [harvestFlash, setHarvestFlash] = useState(false)
  const [cardActive, setCardActive] = useState(-1)

  const msg = useTypewriter(AGENT_MESSAGES, 2400)

  useEffect(() => {
    const t = setInterval(() => {
      setDecisionIdx(i => (i + 1) % DECISIONS.length)
      setCardActive(Math.floor(Math.random() * 4))
      setTimeout(() => setCardActive(-1), 1800)
      if (Math.random() > 0.5) { setProofFlash(true); setTimeout(() => setProofFlash(false), 2000) }
      if (Math.random() > 0.4) { setHarvestFlash(true); setTimeout(() => setHarvestFlash(false), 2200) }
    }, 4000)
    return () => clearInterval(t)
  }, [])

  const d = DECISIONS[decisionIdx]
  const pnlPct = ((earned / (totalValue - earned)) * 100).toFixed(2)

  return (
    <div style={{ minHeight: '100vh', background: '#0B0C0E', color: '#fff', fontFamily: 'inherit' }}>

      
      <header className={styles.header} style={{ background: 'transparent', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div className={`${styles.container} ${styles['header-container']}`}>
          <div className={styles.logo}>
            <Image src="/logo.svg" alt="YieldGeko" width={36} height={36} style={{ borderRadius: 8 }} />
            <span className={styles['logo-text']}>YieldGeko</span>
          </div>
          <nav className={styles.nav}>
            <ul className={styles['nav-list']}>
              <li><a href="#" className={styles['nav-link']}>How it works</a></li>
              <li><a href="#" className={styles['nav-link']}>Protocols</a></li>
              <li><a href="/agent" className={styles['nav-link']}>Demo</a></li>
            </ul>
          </nav>
          <div className={styles['header-actions']}>
            <button onClick={() => router.push('/agent')} className={`${styles.btn} ${styles['btn-outline']} ${styles['nav-cta']}`}>Try Demo</button>
            <button onClick={() => router.push('/app/onboard')} className={`${styles.btn} ${styles['btn-primary']} ${styles['nav-cta']}`}>Deploy Agent <ArrowNE /></button>
          </div>
        </div>
      </header>

      
      <section style={{ position: 'relative', padding: '80px 0 0', overflow: 'hidden', minHeight: 'calc(100vh - 64px)' }}>

        
        <div className={styles['grid-background']}>
          {Array.from({ length: 100 }, (_, i) => {
            const tinted     = [1,10,15,23,34,47,52,68,75,82,91,99]
            const tintedFull = [5,42,88]
            let cls = styles['grid-cell']
            if (tinted.includes(i))     cls += ` ${styles.tinted}`
            if (tintedFull.includes(i)) cls += ` ${styles['tinted-full']}`
            return <div key={i} className={cls} />
          })}
        </div>

        <div className={`${styles.container}`} style={{ position: 'relative', zIndex: 10 }}>

          
          <div style={{ textAlign: 'center', maxWidth: 720, margin: '0 auto', paddingBottom: 60 }}>
            <div className={styles['hero-label']}>
              <span className={styles['chain-logos-stack']}>
                
                <img src="https://assets.coingecko.com/coins/images/16547/standard/arb.jpg?1721358242" alt="Arbitrum" />
                
                <img src="https://assets.coingecko.com/asset_platforms/images/184/standard/0g.png" alt="0G" />
              </span>
              Arbitrum · 0G Network
            </div>
            <h1 className={styles['hero-title']}>
              Autonomous wealth.<br />Cryptographically bound.
            </h1>
            <p className={styles['hero-subtitle']}>
              Deploy agents that grow your assets within the strict limits of your intent. Secure, verifiable, and entirely yours.
            </p>
            <div className={styles['hero-actions']}>
              <button onClick={() => router.push('/app/onboard')} className={`${styles.btn} ${styles['btn-primary']} ${styles['btn-large']}`}>Deploy Agent <ArrowNE /></button>
              <button onClick={() => router.push('/agent')} className={`${styles.btn} ${styles['btn-outline']} ${styles['btn-large']}`}>Try Demo</button>
            </div>
          </div>

          
          <div style={{
            position: 'relative', width: '100%', maxWidth: 1060,
            margin: '0 auto', height: 540,
            overflow: 'hidden',
          }}>
            <ParticleCanvas width={1060} height={540} />

            
            <div style={{
              position: 'absolute', top: 26, left: '50%', transform: 'translateX(-50%)',
              width: 300,
              background: 'rgba(18,18,20,0.95)',
              border: `1px solid ${cardActive === 0 ? 'rgba(234,88,12,0.5)' : 'rgba(255,255,255,0.07)'}`,
              borderRadius: 18,
              padding: '18px 20px',
              zIndex: 15,
              boxShadow: cardActive === 0 ? '0 0 16px rgba(234,88,12,0.12)' : '0 2px 8px rgba(0,0,0,0.15)',
              transition: 'border-color 0.4s, box-shadow 0.4s',
            }}>
              
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  
                  <img src="https://icons.llamao.fi/icons/protocols/uniswap?w=48&h=48"
                    alt="Uniswap" style={{ width: 22, height: 22, borderRadius: 6 }} />
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', fontWeight: 600 }}>apex-v2 strategy</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'rgba(74,222,128,0.10)', borderRadius: 20, padding: '3px 9px', border: '1px solid rgba(74,222,128,0.2)' }}>
                  <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#4ADE80', animation: 'pulse 1.5s ease-in-out infinite' }} />
                  <span style={{ fontSize: 10, color: '#4ADE80', fontWeight: 700 }}>ALLOCATED</span>
                </div>
              </div>

              
              <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-0.03em', color: '#fff', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
                ${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#4ADE80' }}>+{pnlPct}%</span>
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.28)' }}>+${earned.toFixed(2)} earned</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#EA580C', background: 'rgba(234,88,12,0.1)', borderRadius: 999, padding: '2px 8px', border: '1px solid rgba(234,88,12,0.2)' }}>
                  {apy.toFixed(1)}% APY
                </span>
              </div>

              
              <MiniSparkline />

              
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ display: 'flex', gap: -4 }}>
                    
                    <img src="https://icons.llamao.fi/icons/tokens/ethereum?w=24&h=24" alt="WETH" style={{ width: 16, height: 16, borderRadius: '50%', border: '1px solid #1a1a1a' }} />
                    
                    <img src="https://icons.llamao.fi/icons/tokens/usdc?w=24&h=24" alt="USDC" style={{ width: 16, height: 16, borderRadius: '50%', marginLeft: -5, border: '1px solid #1a1a1a' }} />
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>WETH / USDC</span>
                </div>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', fontWeight: 500 }}>Uniswap V3 · 0.05%</span>
              </div>
            </div>

            
            <div style={{
              position: 'absolute', top: 26, right: 48,
              width: 218,
              background: 'rgba(18,18,20,0.95)',
              border: `1px solid ${cardActive === 1 ? `${d.color}55` : 'rgba(255,255,255,0.07)'}`,
              borderRadius: 16,
              padding: '14px 16px',
              zIndex: 15,
              boxShadow: cardActive === 1 ? `0 0 14px ${d.color}18` : '0 2px 8px rgba(0,0,0,0.15)',
              transition: 'all 0.5s cubic-bezier(0.16,1,0.3,1)',
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.28)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                🧠 Agent Decision
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 18, lineHeight: 1 }}>{d.icon}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: d.color }}>{d.text}</div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>{d.sub}</div>
                </div>
              </div>
              
              <div style={{ marginTop: 12, height: 2, borderRadius: 2, background: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', background: d.color, borderRadius: 2,
                  animation: 'scanLine 4s linear infinite',
                }} />
              </div>
            </div>

            
            <div style={{
              position: 'absolute', top: 26, left: 48,
              width: 200,
              background: 'rgba(18,18,20,0.95)',
              border: `1px solid ${cardActive === 2 ? 'rgba(56,189,248,0.4)' : 'rgba(255,255,255,0.07)'}`,
              borderRadius: 16,
              padding: '14px 16px',
              zIndex: 15,
              boxShadow: cardActive === 2 ? '0 0 14px rgba(56,189,248,0.08)' : '0 2px 8px rgba(0,0,0,0.15)',
              transition: 'all 0.5s',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                
                <img src="https://icons.llamao.fi/icons/protocols/morpho-blue?w=48&h=48" alt="Morpho" style={{ width: 28, height: 28, borderRadius: 8 }} />
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>Morpho Blue</div>
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>Lending</div>
                </div>
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#4ADE80', fontVariantNumeric: 'tabular-nums' }}>
                {morphoApy.toFixed(1)}%
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', fontWeight: 500, marginLeft: 4 }}>APY</span>
              </div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', marginTop: 4 }}>$3,200 deployed</div>
            </div>

            
            <div style={{
              position: 'absolute', bottom: 90, left: 48,
              width: 208,
              background: harvestFlash ? 'rgba(74,222,128,0.06)' : 'rgba(18,18,20,0.95)',
              border: `1px solid ${harvestFlash ? 'rgba(74,222,128,0.4)' : 'rgba(255,255,255,0.07)'}`,
              borderRadius: 16,
              padding: '14px 16px',
              zIndex: 15,
              boxShadow: harvestFlash ? '0 0 28px rgba(74,222,128,0.12)' : '0 8px 24px rgba(0,0,0,0.35)',
              transition: 'all 0.5s',
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.28)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
                ⚡ Harvest
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: harvestFlash ? '#4ADE80' : 'rgba(255,255,255,0.7)' }}>
                {harvestFlash ? 'Collecting LP fees…' : 'Monitoring rewards…'}
              </div>
              <div style={{ marginTop: 6, fontSize: 18, fontWeight: 800, color: '#4ADE80', fontVariantNumeric: 'tabular-nums' }}>
                {harvestFlash ? '+$4.82' : '+$0.00'}
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', fontWeight: 500, marginLeft: 4 }}>net</span>
              </div>
            </div>

            
            <div style={{
              position: 'absolute', bottom: 90, right: 48,
              width: 218,
              background: proofFlash ? 'rgba(74,222,128,0.05)' : 'rgba(18,18,20,0.95)',
              border: `1px solid ${proofFlash ? 'rgba(74,222,128,0.35)' : 'rgba(255,255,255,0.07)'}`,
              borderRadius: 16,
              padding: '14px 16px',
              zIndex: 15,
              boxShadow: proofFlash ? '0 0 24px rgba(74,222,128,0.10)' : '0 8px 24px rgba(0,0,0,0.35)',
              transition: 'all 0.5s',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.28)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  0G Proof
                </div>
                {proofFlash && (
                  <div style={{ fontSize: 9, fontWeight: 700, color: '#4ADE80', background: 'rgba(74,222,128,0.12)', borderRadius: 4, padding: '2px 6px', border: '1px solid rgba(74,222,128,0.2)' }}>
                    ANCHORED
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: proofFlash ? '#4ADE80' : '#EA580C', animation: 'pulse 1.5s ease-in-out infinite', flexShrink: 0 }} />
                <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'rgba(255,255,255,0.45)' }}>
                  {proofFlash ? '0x4fa…b2c ✓' : 'Awaiting anchor…'}
                </span>
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
                {['TEE', '0G Chain', 'Arbitrum'].map(label => (
                  <div key={label} style={{ fontSize: 9, fontWeight: 600, color: proofFlash ? '#4ADE80' : 'rgba(255,255,255,0.22)', background: proofFlash ? 'rgba(74,222,128,0.08)' : 'rgba(255,255,255,0.04)', borderRadius: 4, padding: '2px 6px', transition: 'all 0.5s' }}>
                    {label}
                  </div>
                ))}
              </div>
            </div>

            
            <div style={{
              position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
              display: 'flex', alignItems: 'center', gap: 20,
              zIndex: 20,
            }}>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(0,0,0,0.5)', borderRadius: 20, padding: '6px 16px', border: '1px solid rgba(234,88,12,0.2)', backdropFilter: 'blur(8px)' }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#EA580C', animation: 'pulse 1.2s ease-in-out infinite', flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: '#fff', fontWeight: 600, letterSpacing: '0.01em', minWidth: 200 }}>{msg}<span style={{ opacity: 0.5, animation: 'blink 1s step-end infinite' }}>|</span></span>
              </div>
              
              {[
                { label: 'VERIFIED BY TEE', color: '#EA580C' },
                { label: 'ANCHORED ON 0G', color: '#38BDF8' },
                { label: 'SECURED BY ARBITRUM', color: '#8B5CF6' },
              ].map(b => (
                <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.06em' }}>
                  <div style={{ width: 4, height: 4, borderRadius: '50%', background: b.color, opacity: 0.8 }} />
                  {b.label}
                </div>
              ))}
            </div>

            
            <style>{`
              @keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.4} }
              @keyframes blink { 0%,100%{opacity:0.5}50%{opacity:0} }
              @keyframes scanLine { 0%{width:0%}100%{width:100%} }
            `}</style>
          </div>
        </div>
      </section>
    </div>
  )
}

function MiniSparkline() {
  const points = useRef<number[]>([])
  const [, forceRender] = useState(0)

  useEffect(() => {
    
    let v = 12500
    points.current = Array.from({ length: 28 }, () => {
      v += (Math.random() - 0.35) * 40
      return Math.max(12200, v)
    })
    forceRender(1)

    const t = setInterval(() => {
      const last = points.current[points.current.length - 1]
      const next = Math.max(12200, last + (Math.random() - 0.32) * 35)
      points.current = [...points.current.slice(1), next]
      forceRender(n => n + 1)
    }, 3000)
    return () => clearInterval(t)
  }, [])

  const data = points.current
  if (data.length < 2) return <div style={{ height: 48 }} />

  const W = 260, H = 48, PAD = 2
  const min = Math.min(...data), max = Math.max(...data), range = (max - min) || 1
  const pts = data.map((v, i) => [
    PAD + (i / (data.length - 1)) * (W - PAD * 2),
    H - PAD - ((v - min) / range) * (H - PAD * 2),
  ])
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const fill = `${line} L${W - PAD} ${H} L${PAD} ${H} Z`

  return (
    <div style={{ marginTop: 14 }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 48 }} preserveAspectRatio="none">
        <defs>
          <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4ADE80" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#4ADE80" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={fill} fill="url(#chartFill)" />
        <path d={line} fill="none" stroke="#4ADE80" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        {pts.length > 0 && (
          <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="3" fill="#4ADE80"
            style={{ filter: 'drop-shadow(0 0 4px #4ADE80)' }} />
        )}
      </svg>
    </div>
  )
}
