'use client'

import { useState, useEffect } from 'react'
import s from './CinematicSequence.module.css'

const PROTOCOLS = [
  { id: 'uniswap', name: 'UNISWAP V3', logo: 'https://icons.llamao.fi/icons/protocols/uniswap?w=48&h=48', apy: '54.2' },
  { id: 'aave', name: 'AAVE V3', logo: 'https://icons.llamao.fi/icons/protocols/aave?w=48&h=48', apy: '8.4' },
  { id: 'morpho', name: 'MORPHO BLUE', logo: 'https://icons.llamao.fi/icons/protocols/morpho-blue?w=48&h=48', apy: '12.1' },
  { id: 'pendle', name: 'PENDLE YT', logo: 'https://icons.llamao.fi/icons/protocols/pendle?w=48&h=48', apy: '24.8' },
]

export function CinematicSequence() {
  const [index, setIndex] = useState(0)
  const [logs, setLogs] = useState<string[]>([])

  useEffect(() => {
    const interval = setInterval(() => {
      setIndex(prev => (prev + 1) % PROTOCOLS.length)
    }, 8000)

    const logInterval = setInterval(() => {
      const msgs = [
        `SCANNING_VENUES...`,
        `YIELD_OPTIMAL_FOUND`,
        `TEE_ATTESTATION_INIT`,
        `0G_PERSISTENCE_LOCKED`,
        `EXECUTING_INTENT...`
      ]
      setLogs(prev => [...prev.slice(-4), msgs[Math.floor(Math.random() * msgs.length)]])
    }, 2000)

    return () => {
      clearInterval(interval)
      clearInterval(logInterval)
    }
  }, [])

  const current = PROTOCOLS[index]

  return (
    <div className={s.viewport}>
      <div className={s.scanline} />
      
      
      <div className={s.dataStream} style={{ top: '10%' }}>
        0xdfa1e59e... QM_X3Z1W9... VERIFIED_BY_TEE... ARBITRUM_MAINNET... 0G_STORAGE_LOCKED...
      </div>
      <div className={s.dataStream} style={{ top: '80%', animationDirection: 'reverse' }}>
        YIELD_HARVEST_ACTIVE... SCANNING_MORPHEUS... INTENT_BOUND_SIGNED... SECURE_ENCLAVE_READY...
      </div>

      
      <div className={s.reticle}>
        <div style={{ textAlign: 'center' }}>
          <div className={s.label}>AGENT_THOUGHTS</div>
          <div className={s.glitchText} style={{ fontSize: 10 }}>Evaluating Yield</div>
        </div>
      </div>

      
      <div key={current.id} className={s.protocolNode} style={{ top: '35%', left: '42%' }}>
        <div className={s.nodeIcon}>
          <img src={current.logo} alt={current.name} />
        </div>
        <div className={s.glitchText}>{current.name}</div>
        <div className={s.apyTicker}>{current.apy}%</div>
      </div>

      
      <div className={s.hudElement + ' ' + s['hud-top-right']}>
        <div className={s.label}>TEE_STATUS</div>
        <div className={s.val}>ENCLAVE_ISOLATED</div>
        <div style={{ fontSize: 9, color: '#4ADE80', marginTop: 4 }}>ID: NVIDIA_H100_v1.2</div>
      </div>

      <div className={s.hudElement + ' ' + s['hud-bottom-right']}>
        <div className={s.label}>0G_NETWORK</div>
        <div className={s.val}>PERSISTENCE_LOCKED</div>
        <div style={{ fontSize: 9, color: '#EA580C', marginTop: 4 }}>TX: 0x4a...b2c</div>
      </div>

      
      <div className={s.logFeed}>
        {logs.map((log, i) => (
          <div key={i} style={{ opacity: (i + 1) / logs.length }}>{`> ${log}`}</div>
        ))}
      </div>

      
      <div style={{
        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        width: 400, height: 400, background: 'radial-gradient(circle, rgba(234, 88, 12, 0.08) 0%, transparent 70%)',
        pointerEvents: 'none', zIndex: 0
      }} />
    </div>
  )
}
