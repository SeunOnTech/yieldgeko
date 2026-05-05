'use client'

import { useState } from 'react'
import { useAccount } from 'wagmi'
import { EIP712_DOMAIN, ADDRESSES } from '@yieldgeko/core'
import { useSignIntent } from '../hooks/useSignIntent'
import { useYieldVault } from '../hooks/useYieldVault'
import { storageService } from '../lib/storage'
import { useReadYieldGekoRouterNonces } from '../src/generated'

export default function Home() {
  const { address, isConnected } = useAccount()
  const { signIntent } = useSignIntent()
  const { balance } = useYieldVault("0x65a085d7F6e65a085D7F6E65A085d7f6E65a085D")
  
  const [risk, setRisk] = useState(1) // 0: Cons, 1: Bal, 2: Agg
  const [status, setStatus] = useState<'idle' | 'signing' | 'success' | 'error'>('idle')
  const [signature, setSignature] = useState<string | null>(null)
  const [cid, setCid] = useState<string | null>(null)
  
  // Day 1: Monitoring Status & Active Capital
  const [isMonitoring, setIsMonitoring] = useState(false)

  const riskLabels = ['Conservative', 'Balanced', 'Aggressive']
  const targetYields = [8, 18, 35] // Target APYs

  // Get live nonce from contract
  const { data: nonce } = useReadYieldGekoRouterNonces({
    address: ADDRESSES.YIELD_GEKO_ROUTER as `0x${string}`,
    args: address ? [address] : undefined
  })

  const handleSignIntent = async () => {
    if (!address) return
    setStatus('signing')
    
    try {
      // 1. Sign Intent (EIP-712)
      const deadline = Math.floor(Date.now() / 1000) + 3600
      const signResult = await signIntent(
        targetYields[risk] * 100, // minAPY
        100, // maxSlippage
        Number(nonce || 0),
        deadline
      )
      
      setSignature(signResult.signature)

      // 2. Encrypt & Persist to 0G Storage
      const userState = {
        intent: {
          minAPY: targetYields[risk] * 100,
          maxSlippage: 100,
          riskTier: riskLabels[risk].toLowerCase()
        },
        metadata: {
          walletAddress: address,
          createdAt: Date.now(),
          version: "1.0"
        }
      }

      const storageResult = await storageService.persistIntent(userState)
      setCid(storageResult.cid)
      
      // 3. Store decryption key locally
      localStorage.setItem(`geko_key_${address}`, storageResult.key)
      localStorage.setItem(`geko_iv_${address}`, storageResult.iv)

      setStatus('success')
      setIsMonitoring(true)
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
            <div style={{ marginTop: '2rem', padding: '1rem', background: 'rgba(0,255,0,0.1)', borderRadius: '12px', wordBreak: 'break-all', textAlign: 'left' }}>
              <p style={{ color: 'var(--primary)', fontWeight: 'bold', marginBottom: '0.5rem' }}>✓ Intent Signed Successfully</p>
              <code style={{ fontSize: '0.6rem', opacity: 0.7, display: 'block', marginBottom: '1rem' }}>{signature}</code>
              
              {cid && (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '1rem' }}>
                  <p style={{ fontSize: '0.7rem', color: 'var(--accent)', fontWeight: 'bold', textTransform: 'uppercase' }}>0G Storage CID</p>
                  <code style={{ fontSize: '0.7rem', opacity: 0.9 }}>{cid}</code>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Day 1: Active Capital Display */}
        <div className="glass" style={{ marginTop: '2rem', padding: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ fontSize: '0.8rem', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Active Capital</h3>
            <div style={{ fontSize: '2.5rem', fontWeight: 'bold' }}>${balance ? (Number(balance) / 1e6).toFixed(2) : "0.00"}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <p style={{ color: 'var(--primary)', fontWeight: 'bold' }}>+12.4% Uplift</p>
            <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>Verified on 0G Galileo</p>
          </div>
        </div>

        {/* Day 5: Verifiable Activity Feed */}
        <div className="glass" style={{ marginTop: '2rem', padding: '2rem' }}>
          <h3 style={{ fontSize: '0.9rem', fontWeight: 'bold', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: 'var(--primary)' }}>⚡</span> Verifiable Agent Activity
          </h3>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {[
              { id: 1, type: 'ABORT', reason: 'APY_DRIFT_EXCEEDED', venue: 'Pendle weETH', cid: '0g-abort-41424f52', time: 'Just now', color: 'rgb(239, 68, 68)' },
              { id: 2, type: 'EXECUTE', venue: 'Aave USDC', tx: '0x873f...88', time: '1h ago', color: 'rgb(34, 197, 94)' }
            ].map((item) => (
              <div key={item.id} style={{ padding: '1rem', borderRadius: '12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <span style={{ fontSize: '0.7rem', fontWeight: 'bold', color: item.color, background: `${item.color}20`, padding: '0.1rem 0.4rem', borderRadius: '4px' }}>
                      {item.type}
                    </span>
                    <span style={{ fontWeight: 'bold' }}>{item.venue}</span>
                  </div>
                  <div style={{ fontSize: '0.7rem', opacity: 0.5 }}>
                    {item.type === 'ABORT' ? `Reason: ${item.reason}` : `Proof: ${item.tx}`}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.8rem', opacity: 0.8 }}>{item.time}</div>
                  <a href={`#`} style={{ fontSize: '0.6rem', color: 'var(--primary)', textDecoration: 'none' }}>
                    View 0G Proof →
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer style={{ marginTop: '6rem', textAlign: 'center', opacity: 0.4, fontSize: '0.8rem' }}>
        Built for 0G APAC Hackathon | Powered by 0G TEE & Storage
      </footer>
    </main>
  )
}
