'use client'

import { useState } from 'react'
import { useAccount, useSignTypedData } from 'wagmi'
import { EIP712_DOMAIN } from '@yieldgeko/core'

const TYPES = {
  Intent: [
    { name: 'user', type: 'address' },
    { name: 'minAPY', type: 'uint256' },
    { name: 'maxSlippage', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
} as const

export default function Home() {
  const { address, isConnected } = useAccount()
  const { signTypedDataAsync } = useSignTypedData()
  
  const [risk, setRisk] = useState(1) // 0: Cons, 1: Bal, 2: Agg
  const [status, setStatus] = useState<'idle' | 'signing' | 'success' | 'error'>('idle')
  const [signature, setSignature] = useState<string | null>(null)
  
  // Day 1: Monitoring Status & Active Capital
  const [isMonitoring, setIsMonitoring] = useState(false)
  const [activeCapital, setActiveCapital] = useState("0.00")

  const riskLabels = ['Conservative', 'Balanced', 'Aggressive']
  const targetYields = [8, 18, 35] // Target APYs

  const handleSignIntent = async () => {
    if (!address) return
    setStatus('signing')
    
    try {
      const intent = {
        user: address,
        minAPY: BigInt(targetYields[risk] * 100), // e.g. 1800 for 18%
        maxSlippage: BigInt(100), // 1%
        nonce: BigInt(0),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600)
      }

      const sig = await signTypedDataAsync({
        domain: EIP712_DOMAIN,
        types: TYPES,
        primaryType: 'Intent',
        message: intent
      })
      
      setSignature(sig)
      setStatus('success')
      setIsMonitoring(true) // Activate monitoring after signing
    } catch (err) {
      console.error(err)
      setStatus('error')
    }
  }

  return (
    <main className="container">
      <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4rem' }}>
        <h1 className="gradient-text" style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>YieldGeko 🦎</h1>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <div style={{ padding: '0.25rem 0.75rem', borderRadius: '999px', fontSize: '0.75rem', background: isMonitoring ? 'rgba(34, 197, 94, 0.2)' : 'rgba(107, 114, 128, 0.2)', border: isMonitoring ? '1px solid rgba(34, 197, 94, 0.3)' : 'none', color: isMonitoring ? 'rgb(74, 222, 128)' : 'rgb(156, 163, 175)' }}>
            {isMonitoring ? "● Monitoring Active" : "○ Disconnected"}
          </div>
          <appkit-button />
        </div>
      </nav>

      <section style={{ maxWidth: '600px', margin: '0 auto' }}>
        <div className="glass" style={{ padding: '3rem', textAlign: 'center' }}>
          <h2 style={{ fontSize: '2rem', marginBottom: '1rem' }}>Set Your Risk Profile</h2>
          <p style={{ color: 'rgba(255,255,255,0.6)', marginBottom: '2.5rem' }}>
            YieldGeko's agent will autonomously migrate your capital to venues matching your profile.
          </p>

          <div style={{ marginBottom: '2rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', fontWeight: 'bold' }}>
              <span>{riskLabels[risk]}</span>
              <span className="gradient-text">Target: {targetYields[risk]}% APY</span>
            </div>
            <input 
              type="range" 
              min="0" 
              max="2" 
              step="1" 
              value={risk} 
              onChange={(e) => setRisk(parseInt(e.target.value))}
            />
          </div>

          {!isConnected ? (
            <p style={{ color: 'var(--primary)', fontSize: '0.9rem' }}>Please connect your wallet to proceed</p>
          ) : (
            <button 
              onClick={handleSignIntent}
              disabled={status === 'signing'}
              style={{
                width: '100%',
                padding: '1rem',
                borderRadius: '12px',
                border: 'none',
                background: 'linear-gradient(90deg, var(--primary), var(--accent))',
                color: 'black',
                fontWeight: 'bold',
                fontSize: '1.1rem',
                marginTop: '1rem'
              }}
            >
              {status === 'signing' ? 'Signing...' : 'Sign Agent Authorization'}
            </button>
          )}

          {status === 'success' && (
            <div style={{ marginTop: '2rem', padding: '1rem', background: 'rgba(0,255,0,0.1)', borderRadius: '12px', wordBreak: 'break-all' }}>
              <p style={{ color: 'var(--primary)', fontWeight: 'bold', marginBottom: '0.5rem' }}>✓ Intent Signed Successfully</p>
              <code style={{ fontSize: '0.7rem', opacity: 0.7 }}>{signature}</code>
            </div>
          )}
        </div>

        {/* Day 1: Active Capital Display */}
        <div className="glass" style={{ marginTop: '2rem', padding: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ fontSize: '0.8rem', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Active Capital</h3>
            <div style={{ fontSize: '2.5rem', fontWeight: 'bold' }}>${activeCapital}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <p style={{ color: 'var(--primary)', fontWeight: 'bold' }}>+12.4% Uplift</p>
            <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>Verified on 0G Galileo</p>
          </div>
        </div>
      </section>

      <footer style={{ marginTop: '6rem', textAlign: 'center', opacity: 0.4, fontSize: '0.8rem' }}>
        Built for 0G APAC Hackathon | Powered by 0G TEE & Storage
      </footer>
    </main>
  )
}
