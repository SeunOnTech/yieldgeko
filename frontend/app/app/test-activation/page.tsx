'use client'

import { useState, useEffect } from 'react'
import s from '../../components/AgentFlow/AgentFlow.module.css'

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

const TOKEN_LOGOS: Record<string, string> = {
  WETH: 'https://icons.llamao.fi/icons/tokens/ethereum?w=48&h=48',
  USDC: 'https://icons.llamao.fi/icons/tokens/usdc?w=48&h=48',
  ARB: 'https://icons.llamao.fi/icons/tokens/arbitrum?w=48&h=48'
}

function LogoCircle({ src, alt, size }: { src: string; alt: string; size: number }) {
  return (
    <div style={{
      width: size, height: size,
      borderRadius: '50%',
      overflow: 'hidden',
      flexShrink: 0,
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }}>
      <img src={src} alt={alt} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
    </div>
  )
}

function ProtocolMark({ id, size = 32 }: { id: string; size?: number }) {
  const src = PROTO_LOGOS[id]
  if (src) return <LogoCircle src={src} alt={id} size={size} />
  return <div style={{ width: size, height: size, background: '#78716C', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: size * 0.5 }}>?</div>
}

function ChainMark({ id, size = 32 }: { id: string; size?: number }) {
  const src = CHAIN_LOGOS[id]
  if (src) return <LogoCircle src={src} alt={id} size={size} />
  return <div style={{ width: size, height: size, background: '#28A0F0', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: size * 0.4 }}>{id[0].toUpperCase()}</div>
}

function TokenMark({ symbol, size = 20 }: { symbol: string; size?: number }) {
  const src = TOKEN_LOGOS[symbol]
  if (src) return <LogoCircle src={symbol} alt={symbol} size={size} />
  return <div style={{ width: size, height: size, background: '#ccc', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: size * 0.4 }}>{symbol[0]}</div>
}

function GekoMark({ size = 80, color = 'var(--primary)', variant = 'default' }: { size?: number; color?: string; variant?: 'default' | 'error' | 'info' }) {
  const mainColor = variant === 'error' ? '#ef4444' : variant === 'info' ? '#3b82f6' : color
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none" aria-label="YieldGeko">
      <circle cx="40" cy="40" r="36" stroke={mainColor} strokeWidth="2" opacity="0.18" />
      <path d="M40 14c14 0 24 10 24 24a18 18 0 0 1-30 13c2 4 6 7 11 7v6c-12 0-22-9-22-22 0-15 7-28 17-28z" fill={mainColor} />
      {variant === 'default' && <circle cx="48" cy="32" r="3" fill="#0B0C0E" />}
    </svg>
  )
}

function ProofModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  if (!isOpen) return null
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20
    }} onClick={onClose}>
      <div style={{
        background: 'var(--background)', width: '100%', maxWidth: 480, borderRadius: 24, padding: 32,
        border: '1px solid var(--border)', boxShadow: '0 20px 50px rgba(0,0,0,0.1)', position: 'relative'
      }} onClick={e => e.stopPropagation()}>
        <button onClick={onClose} style={{ position: 'absolute', top: 20, right: 20, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>

        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ 
            width: 56, height: 56, background: '#f0fdf4', color: '#16a34a', borderRadius: '50%', 
            margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '1.5px solid #dcfce7'
          }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></svg>
          </div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>Proof of Integrity</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9375rem', marginTop: 4 }}>Cryptographic provenance for your agent.</p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[
            { label: 'TEE Attestation', value: 'NVIDIA H100 Verified', desc: 'Secure computation isolated from host access.', id: 'TEE-8821', icon: null },
            { label: '0G Chain Anchor', value: 'Anchored on-chain', desc: 'Immutable registration record on 0G consensus.', id: '0x4a...b2c', icon: '0g' },
            { label: '0G Storage Hash', value: 'Log Persisted', desc: 'Decentralized state history verified by hash.', id: 'QmX3...z1w', icon: '0g' }
          ].map((item, i) => (
            <div key={i} style={{ 
              padding: 16, borderRadius: 16, background: 'var(--surface)', border: '1px solid var(--border)'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {item.icon === '0g' && <ChainMark id="0g" size={14} />}
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{item.label}</span>
                </div>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#16a34a' }}>{item.value}</span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 550 }}>{item.desc}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, fontFamily: 'monospace', background: 'var(--background)', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)' }}>
                ID: {item.id}
              </div>
            </div>
          ))}
        </div>

        <button className={s.btn} style={{ width: '100%', marginTop: 24, height: 50 }} onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  )
}

function ScreenActivationTest({
  ready,
  phase,
  error,
  onView,
  onReset
}: {
  ready: boolean;
  phase: string;
  error: string;
  onView: () => void;
  onReset: () => void;
}) {
  const [subIdx, setSubIdx] = useState(0)
  const [isModalOpen, setIsModalOpen] = useState(false)

  
  const registryMessages = ["Securing execution environment...", "Establishing vault authority...", "Preparing strategy rail..."]
  const evaluationMessages = ["Scanning Uniswap V3 pools...", "Checking Pendle yield markets...", "Evaluating Aave lending rates...", "Optimizing gas-efficient routes..."]
  const executionMessages = ["Provisioning WETH/USDC on Uniswap...", "Opening Pendle PT position...", "Depositing collateral to Morpho...", "Finalizing strategy entry..."]

  
  const proofs = [
    { label: 'TEE', value: 'Verified by NVIDIA Attestation', icon: null },
    { label: '0G CHAIN', value: 'Anchoring Registration...', icon: '0g' },
    { label: '0G STORAGE', value: 'Persisting State History...', icon: '0g' }
  ]

  
  const deployment = {
    protocol: 'Uniswap V3',
    protocolId: 'uniswap',
    pair: 'WETH / USDC',
    tokens: ['WETH', 'USDC'],
    apy: '57.2',
    network: 'Arbitrum'
  }

  useEffect(() => {
    const timer = setInterval(() => {
      setSubIdx(prev => (prev + 1) % 4)
    }, 2800)
    return () => clearInterval(timer)
  }, [])

  const isSuccess = ready && !error
  const isInfoState = !!error

  const getSubtext = () => {
    if (isInfoState) return "Your funds are securely held in your smart account. The agent is being initialized with extra verification."
    if (isSuccess) return "Strategy successfully engaged on-chain."
    
    switch (phase) {
      case 'REGISTERING': return registryMessages[subIdx % registryMessages.length]
      case 'EVALUATING': return evaluationMessages[subIdx % evaluationMessages.length]
      case 'EXECUTING': return executionMessages[subIdx % executionMessages.length]
      default: return "Initializing agent intelligence..."
    }
  }

  return (
    <div className={s.screenInner} style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      color: 'var(--foreground)',
      padding: '0 24px',
      position: 'relative'
    }}>
      <div style={{ position: 'relative', width: 100, height: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 40 }}>
        {!isSuccess && !isInfoState && <div className={s.spinSlow}><GekoMark size={64} /></div>}
        {isSuccess && (
          <div className={s.fadeUp} style={{ animationDelay: '0ms' }}>
            <span className={s.pulseRing} style={{
              position: 'absolute',
              inset: -8,
              borderRadius: '50%',
              border: '2.5px solid var(--earn)',
              display: 'block'
            }} />
            <GekoMark size={64} color="var(--earn)" />
          </div>
        )}
        {isInfoState && (
          <div className={s.fadeUp} style={{ animationDelay: '0ms' }}>
            <GekoMark size={64} variant="info" />
          </div>
        )}
      </div>
      
      <div style={{ textAlign: 'center', maxWidth: 640 }}>
        <div className={s.activationTitle} style={{ 
          fontSize: '1.75rem', 
          fontWeight: 600, 
          letterSpacing: '-0.01em',
          marginBottom: 10,
          color: isInfoState ? '#3b82f6' : 'var(--foreground)'
        }}>
          {isInfoState ? 'Activation in Review' : isSuccess ? 'Strategy Engaged' : 'Provisioning Agent'}
        </div>
        
        <div key={getSubtext()} className={s.fadeUp} style={{ 
          fontSize: '1.0625rem', 
          color: 'var(--text-muted)',
          fontWeight: 450,
          lineHeight: 1.5,
          marginBottom: isSuccess || isInfoState ? 32 : 0
        }}>
          {getSubtext()}
        </div>

        {(isSuccess || isInfoState) && (
          <div className={s.fadeUp} style={{ 
            animationDelay: '400ms',
            background: 'var(--surface)', 
            border: '1px solid var(--border)',
            borderRadius: 20,
            padding: '24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            boxShadow: '0 8px 32px rgba(0,0,0,0.06)',
            width: '100%',
            minWidth: 320,
            margin: '0 auto',
            position: 'relative'
          }}>
            
            <div onClick={() => setIsModalOpen(true)} style={{
              position: 'absolute', top: -12, right: 24, background: isInfoState ? '#3b82f6' : '#16a34a', color: '#fff',
              padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700, 
              display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
              border: '2px solid var(--background)', boxShadow: `0 4px 10px ${isInfoState ? 'rgba(59,130,246,0.2)' : 'rgba(22,163,74,0.2)'}`
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>
              {isInfoState ? 'SYSTEM SECURE' : 'VERIFIED PROOF'}
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
                <div style={{ display: 'flex', marginRight: 4 }}>
                  <TokenMark symbol={deployment.tokens[0]} size={24} />
                  <div style={{ marginLeft: -10 }}><TokenMark symbol={deployment.tokens[1]} size={24} /></div>
                </div>
                <span style={{ fontSize: 15, fontWeight: 650, color: 'var(--foreground)' }}>{deployment.pair}</span>
              </div>
              <div style={{ 
                fontSize: 12, 
                fontWeight: 600, 
                color: 'var(--text-muted)', 
                background: 'var(--background)',
                padding: '4px 10px',
                borderRadius: 20,
                border: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: 6
              }}>
                <ChainMark id="arbitrum" size={14} />
                {deployment.network}
              </div>
            </div>

            
            <div style={{ 
              marginTop: 4, padding: '8px 12px', background: 'rgba(0,0,0,0.02)', borderRadius: 12,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              border: '1px dashed var(--border)'
            }}>
              <ChainMark id="0g" size={16} />
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.02em' }}>SECURED BY 0G NETWORK</span>
            </div>
          </div>
        )}
        
        {isInfoState && (
          <div className={s.fadeUp} style={{ 
            marginTop: 24, 
            padding: '16px 20px', 
            borderRadius: 14, 
            background: 'rgba(59, 130, 246, 0.04)', 
            color: '#3b82f6', 
            fontSize: '0.875rem',
            fontWeight: 500,
            border: '1px solid rgba(59, 130, 246, 0.12)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            justifyContent: 'center'
          }}>
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
          <button className={`${s.fadeUp}`} style={{ 
            marginTop: 16, background: 'none', border: 'none', color: 'var(--text-muted)', 
            fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' 
          }} onClick={onReset}>
            Retry Synchronization
          </button>
        )}
      </div>

      
      {!isSuccess && !isInfoState && (
        <div style={{
          position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14,
          padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12,
          boxShadow: '0 4px 15px rgba(0,0,0,0.05)', animation: 'fadeUp 400ms ease-out both'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, borderRight: '1px solid var(--border)', paddingRight: 12 }}>
            {proofs[subIdx % proofs.length].icon === '0g' && <ChainMark id="0g" size={14} />}
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{proofs[subIdx % proofs.length].label}</span>
          </div>
          <span key={proofs[subIdx % proofs.length].value} className={s.fadeUp} style={{ fontSize: 13, fontWeight: 550, color: 'var(--foreground)' }}>{proofs[subIdx % proofs.length].value}</span>
        </div>
      )}

      <ProofModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </div>
  )
}

export default function TestActivationPage() {
  const [isReady, setIsReady] = useState(false)
  const [currentPhase, setCurrentPhase] = useState('REGISTERING')
  const [errorMessage, setErrorMessage] = useState('')

  const phases = ['REGISTERING', 'EVALUATING', 'EXECUTING', 'ERROR']

  const handleReset = () => {
    setErrorMessage('')
    setIsReady(false)
    setCurrentPhase('REGISTERING')
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--background)' }}>
      
      <div style={{
        position: 'fixed',
        top: 20,
        right: 20,
        background: 'var(--surface)',
        padding: 24,
        borderRadius: 16,
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        border: '1px solid var(--border)',
        boxShadow: '0 10px 30px rgba(0,0,0,0.08)',
        backdropFilter: 'blur(12px)'
      }}>
        <h3 style={{ color: 'var(--foreground)', margin: 0, fontSize: 15, fontWeight: 600 }}>Activation Debug</h3>

        <button
          onClick={() => setIsReady(!isReady)}
          style={{ padding: '10px 16px', cursor: 'pointer', borderRadius: 8, border: 'none', background: isReady ? 'var(--earn)' : 'var(--secondary)', color: isReady ? '#fff' : 'var(--foreground)', fontWeight: 600, transition: 'all 0.2s' }}
        >
          Toggle Ready: {isReady ? 'ON' : 'OFF'}
        </button>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 500 }}>Lifecycle Phase</label>
          <select
            value={currentPhase}
            onChange={(e) => setCurrentPhase(e.target.value)}
            style={{ padding: 8, borderRadius: 8, background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)', fontSize: 14 }}
          >
            {phases.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        <button
          onClick={() => setErrorMessage(errorMessage ? '' : 'On-chain synchronization delay')}
          style={{ padding: '10px 16px', cursor: 'pointer', borderRadius: 8, border: 'none', background: errorMessage ? '#3b82f6' : 'var(--secondary)', color: errorMessage ? '#fff' : 'var(--foreground)', fontWeight: 600, transition: 'all 0.2s' }}
        >
          {errorMessage ? 'Clear Delay' : 'Simulate Delay'}
        </button>
      </div>

      <ScreenActivationTest
        ready={isReady}
        phase={currentPhase}
        error={errorMessage}
        onView={() => alert('Entering Strategy Dashboard')}
        onReset={handleReset}
      />
    </div>
  )
}
