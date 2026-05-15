'use client'

import { useState, useEffect } from 'react'
import s from './SovereignMesh.module.css'

const PROTOCOLS = [
  { id: 'aave', name: 'Aave', logo: 'https://icons.llamao.fi/icons/protocols/aave?w=48&h=48', pos: s.pos1, apy: '8.4', proof: '0x9a...c12d' },
  { id: 'uniswap', name: 'Uni V3', logo: 'https://icons.llamao.fi/icons/protocols/uniswap?w=48&h=48', pos: s.pos2, apy: '54.2', proof: '0xdf...e59e' },
  { id: 'morpho', name: 'Morpho', logo: 'https://icons.llamao.fi/icons/protocols/morpho-blue?w=48&h=48', pos: s.pos3, apy: '12.1', proof: '0x3c...f9a1' },
  { id: 'pendle', name: 'Pendle', logo: 'https://icons.llamao.fi/icons/protocols/pendle?w=48&h=48', pos: s.pos4, apy: '24.8', proof: '0x88...a4b2' },
]

export function SovereignMesh() {
  const [activeId, setActiveId] = useState('uniswap')

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveId(prev => {
        const idx = PROTOCOLS.findIndex(p => p.id === prev)
        return PROTOCOLS[(idx + 1) % PROTOCOLS.length].id
      })
    }, 4000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className={s.meshContainer}>
      
      <svg className={s.svgMesh} viewBox="0 0 1200 500">
        
        <path d="M 600 250 L 240 50" className={s.meshLine} />
        <path d="M 600 250 L 900 75" className={s.meshLine} />
        <path d="M 600 250 L 180 400" className={s.meshLine} />
        <path d="M 600 250 L 960 450" className={s.meshLine} />

        
        <path d="M 600 250 L 240 50" className={`${s.pulseLine}`} style={{ animationDelay: '0s' }} />
        <path d="M 600 250 L 900 75" className={`${s.pulseLine}`} style={{ animationDelay: '1s' }} />
        <path d="M 600 250 L 180 400" className={`${s.pulseLine}`} style={{ animationDelay: '2s' }} />
        <path d="M 600 250 L 960 450" className={`${s.pulseLine}`} style={{ animationDelay: '3s' }} />
      </svg>

      
      {PROTOCOLS.map((p) => (
        <div key={p.id} className={`${s.node} ${p.pos}`}>
          <div className={s.nodeIcon} style={{ borderColor: activeId === p.id ? '#EA580C' : 'rgba(255,255,255,0.1)' }}>
            <img src={p.logo} alt={p.name} />
          </div>
          <div style={{ textAlign: 'center' }}>
            <div className={s.dataValue}>
              <span className={s.apyGreen}>{p.apy}%</span>
              <span style={{ fontSize: 10, color: '#94969A', marginLeft: 4 }}>APY</span>
            </div>
            <div className={s.proofTag}>{p.proof}</div>
          </div>
        </div>
      ))}

      
      <div className={s.centerBrain}>
        <div className={s.brainCore}>
          <div className={s.brainPulse} />
          <svg width="40" height="40" viewBox="0 0 80 80" fill="none">
             <path d="M40 14c14 0 24 10 24 24a18 18 0 0 1-30 13c2 4 6 7 11 7v6c-12 0-22-9-22-22 0-15 7-28 17-28z" fill="#EA580C" />
          </svg>
        </div>
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <div className={s.dataLabel}>YieldGeko Intelligence</div>
          <div style={{ fontSize: 11, color: '#FFFFFF', fontWeight: 600, fontFamily: 'monospace' }}>TEE-ACTIVE</div>
        </div>
      </div>
    </div>
  )
}
