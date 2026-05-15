'use client'

import { useState, useEffect } from 'react'
import s from './AgentHeartbeat.module.css'

const PROTOCOLS = [
  { id: 'aave', name: 'Aave V3', logo: 'https://icons.llamao.fi/icons/protocols/aave?w=48&h=48' },
  { id: 'uniswap', name: 'Uniswap V3', logo: 'https://icons.llamao.fi/icons/protocols/uniswap?w=48&h=48' },
  { id: 'morpho', name: 'Morpho Blue', logo: 'https://icons.llamao.fi/icons/protocols/morpho-blue?w=48&h=48' },
  { id: 'pendle', name: 'Pendle YT', logo: 'https://icons.llamao.fi/icons/protocols/pendle?w=48&h=48' },
  { id: 'gmx', name: 'GMX V2', logo: 'https://icons.llamao.fi/icons/protocols/gmx?w=48&h=48' },
]

const MOCK_PROOFS = [
  { time: '12:44:01', action: 'Rate Optimized', target: 'Uniswap V3', hash: '0x9a2f...c12d', type: 'TEE' },
  { time: '12:44:05', action: 'State Persisted', target: '0G Storage', hash: 'QmX3...z1w9', type: '0G' },
  { time: '12:44:12', action: 'Vault Rebalanced', target: 'Aave V3', hash: '0xdfa1...e59e', type: 'TEE' },
  { time: '12:44:18', action: 'Policy Verified', target: 'EIP-712', hash: '0x8821...a4b2', type: '0G' },
  { time: '12:44:25', action: 'Yield Harvested', target: 'Morpho Blue', hash: '0x3c2e...f9a1', type: 'TEE' },
]

export function AgentHeartbeat() {
  const [apy, setApy] = useState(54.2)
  const [proofs, setProofs] = useState(MOCK_PROOFS)

  
  useEffect(() => {
    const interval = setInterval(() => {
      setApy(prev => {
        const delta = (Math.random() - 0.5) * 0.1
        return parseFloat((prev + delta).toFixed(1))
      })
    }, 3000)
    return () => clearInterval(interval)
  }, [])

  
  useEffect(() => {
    const interval = setInterval(() => {
      setProofs(prev => {
        const next = [...prev]
        const first = next.shift()
        if (first) next.push({
          ...first,
          time: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          hash: `0x${Math.random().toString(16).slice(2, 6)}...${Math.random().toString(16).slice(2, 6)}`
        })
        return next
      })
    }, 4500)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className={s.heartbeatCard}>
      
      <div className={s.cardHeader}>
        <div className={s.statusGroup}>
          <div className={s.statusDot} />
          <span className={s.statusText}>Autonomous Agent: Active</span>
        </div>
        <div className={s.teeBadge}>NVIDIA H100 TEE Verified</div>
      </div>

      <div className={s.cardBody}>
        
        <div className={s.mainView}>
          <div className={s.orbitContainer}>
            <div className={s.orbitPath} />
            {PROTOCOLS.map((p, i) => (
              <div 
                key={p.id} 
                className={s.orbitalIcon}
                style={{ animationDelay: `${i * -4}s` }}
              >
                <img src={p.logo} alt={p.name} title={p.name} />
              </div>
            ))}
          </div>

          <div className={s.apyDisplay}>
            <div className={s.apyLabel}>Current Strategy Yield</div>
            <div className={s.apyValue}>{apy}<span className={s.apyUnit}>%</span></div>
            <div style={{ fontSize: 11, color: '#4ADE80', fontWeight: 600 }}>Real-time optimization active</div>
          </div>
        </div>

        
        <div className={s.proofStream}>
          <div className={s.streamHeader}>Verifiable Proof Stream</div>
          <div className={s.streamList}>
            {proofs.slice().reverse().map((p, i) => (
              <div key={`${p.hash}-${i}`} className={s.proofItem}>
                <div className={s.proofTime}>{p.time}</div>
                <div className={s.proofAction}>
                  {p.action}
                  <span className={`${s.badge} ${p.type === 'TEE' ? s['badge-tee'] : s['badge-0g']}`}>
                    {p.type}
                  </span>
                </div>
                <div className={s.proofHash}>{p.hash} — {p.target}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      
      <div className={s.footerBar}>
        <div className={s.footerItem}>
          <img className={s.footerIcon} src="https://icons.llamao.fi/icons/chains/rsz_arbitrum?w=48&h=48" alt="Arbitrum" />
          Arbitrum One
        </div>
        <div className={s.footerItem}>
          <img className={s.footerIcon} src="https://icons.llamao.fi/icons/chains/rsz_0g?w=48&h=48" alt="0G Network" />
          0G Consensus
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 11, color: '#636669' }}>
          Updated 1s ago
        </div>
      </div>
    </div>
  )
}
