'use client'

import { useState, useEffect } from 'react'
import s from './HeroCinematic.module.css'

const PROTOCOLS = [
  { id: 'aave', logo: 'https://icons.llamao.fi/icons/protocols/aave?w=48&h=48' },
  { id: 'uniswap', logo: 'https://icons.llamao.fi/icons/protocols/uniswap?w=48&h=48' },
  { id: 'morpho', logo: 'https://icons.llamao.fi/icons/protocols/morpho-blue?w=48&h=48' },
  { id: 'pendle', logo: 'https://icons.llamao.fi/icons/protocols/pendle?w=48&h=48' },
  { id: 'gmx', logo: 'https://icons.llamao.fi/icons/protocols/gmx?w=48&h=48' },
  { id: 'arbitrum', logo: 'https://icons.llamao.fi/icons/chains/rsz_arbitrum?w=48&h=48' },
]

export function HeroCinematic() {
  const [apy, setApy] = useState(54.2)
  const [time, setTime] = useState('')

  useEffect(() => {
    const interval = setInterval(() => {
      setApy(prev => parseFloat((prev + (Math.random() - 0.5) * 0.1).toFixed(1)))
      setTime(new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    }, 2000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className={s.scene}>
      
      <div className={`${s.fragment} ${s.fHeartbeat} ${s.floating}`}>
        <div className={s.apyLabel}>Autonomous Intelligence</div>
        <div className={s.apyValue}>{apy}%</div>
        <div className={s.apyTrend}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ marginRight: 4 }}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></svg>
          Yield Peak Identified
        </div>
      </div>

      
      <div className={`${s.fragment} ${s.fProof} ${s.floating}`} style={{ animationDelay: '-1s' }}>
        <div className={s.apyLabel} style={{ marginBottom: 16, fontSize: 10 }}>Verifiable Provenance</div>
        <div className={s.proofList}>
          {[
            { action: 'TEE Rotation', hash: '0x9a2f...c12d' },
            { action: '0G State Persistence', hash: 'QmX3...z1w9' },
            { action: 'Policy Verified', hash: '0x8821...a4b2' }
          ].map((item, i) => (
            <div key={i} className={s.proofItem}>
              <div className={s.proofHeader}>
                <span>{time}</span>
                <span style={{ color: '#4ADE80' }}>SECURED</span>
              </div>
              <div className={s.proofText}>
                {item.action}
              </div>
              <div className={s.hash}>{item.hash}</div>
            </div>
          ))}
        </div>
      </div>

      
      <div className={`${s.fragment} ${s.fProtocols} ${s.floating}`} style={{ animationDelay: '-2s' }}>
        <div className={s.apyLabel} style={{ marginBottom: 16, fontSize: 10 }}>Liquidity Venues</div>
        <div className={s.protocolGrid}>
          {PROTOCOLS.map((p) => (
            <div key={p.id} className={s.protoIcon}>
              <img src={p.logo} alt={p.id} />
            </div>
          ))}
        </div>
      </div>

      
      <div className={`${s.fragment} ${s.fSecurity} ${s.floating}`} style={{ animationDelay: '-3.5s' }}>
        <div className={s.securityInfo}>
          <div className={s.statusDot} />
          <span style={{ fontSize: 11, fontWeight: 700, color: '#FFFFFF', letterSpacing: '0.05em' }}>
            NVIDIA H100 TEE: <span style={{ color: '#4ADE80' }}>ACTIVE</span>
          </span>
        </div>
      </div>

      
      <div style={{
        position: 'absolute', width: 400, height: 400,
        background: 'radial-gradient(circle, rgba(234, 88, 12, 0.05) 0%, transparent 70%)',
        top: '20%', left: '30%', pointerEvents: 'none', zIndex: 1
      }} />
    </div>
  )
}
