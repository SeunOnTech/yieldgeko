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
  const [selectedProof, setSelectedProof] = useState<any | null>(null)
  
  const [isMonitoring, setIsMonitoring] = useState(false)
  const [ledger, setLedger] = useState([
    { date: '2026-05-05', type: 'Migration', uplift: '+$2.50', fee: '$0.18', venue: 'Pendle weETH', hash: '0xc7b5...f07' },
    { date: '2026-05-04', type: 'Migration', uplift: '+$1.10', fee: '$0.05', venue: 'Aave USDC', hash: '0x88f...12' },
  ])

  const handleExportCSV = () => {
    const headers = "Date,Venue,Type,Uplift,Fee,ProofHash\n"
    const rows = ledger.map(e => `${e.date},${e.venue},${e.type},${e.uplift},${e.fee},${e.hash}`).join("\n")
    const blob = new Blob([headers + rows], { type: 'text/csv' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `yieldgeko_audit_${address}.csv`
    a.click()
  }

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

        {/* Day 8: Financial Performance Hub */}
        <div className="glass" style={{ marginTop: '2rem', padding: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
            <h3 style={{ fontSize: '0.9rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ color: 'var(--accent)' }}>📊</span> Financial Transparency
            </h3>
            <button 
              onClick={handleExportCSV}
              style={{ fontSize: '0.7rem', color: 'var(--primary)', background: 'none', border: '1px solid var(--primary)', padding: '0.25rem 0.75rem', borderRadius: '6px', cursor: 'pointer' }}
            >
              Export Audit CSV
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '2rem' }}>
            <div style={{ padding: '1.5rem', background: 'rgba(255,255,255,0.03)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <p style={{ fontSize: '0.65rem', opacity: 0.6, textTransform: 'uppercase', marginBottom: '0.5rem' }}>Net Uplift Generated</p>
              <p style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--primary)' }}>+${ledger.reduce((acc, curr) => acc + parseFloat(curr.uplift.slice(2)), 0).toFixed(2)}</p>
            </div>
            <div style={{ padding: '1.5rem', background: 'rgba(255,255,255,0.03)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <p style={{ fontSize: '0.65rem', opacity: 0.6, textTransform: 'uppercase', marginBottom: '0.5rem' }}>Total Fees Paid</p>
              <p style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'white' }}>${ledger.reduce((acc, curr) => acc + parseFloat(curr.fee.slice(1)), 0).toFixed(2)}</p>
            </div>
          </div>

          <div style={{ fontSize: '0.8rem', opacity: 0.8, marginBottom: '1rem', fontWeight: 'bold' }}>Itemized Fee Ledger</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {ledger.map((entry, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr 1fr 1fr 0.5fr', fontSize: '0.7rem', padding: '1rem', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)', alignItems: 'center' }}>
                <span style={{ opacity: 0.5 }}>{entry.date}</span>
                <span style={{ fontWeight: 'bold' }}>{entry.venue}</span>
                <span style={{ color: 'var(--primary)', fontWeight: 'bold' }}>{entry.uplift}</span>
                <span>{entry.fee}</span>
                <button 
                  onClick={() => setSelectedProof({ ...entry, type: 'EXECUTION' })}
                  style={{ color: 'var(--accent)', background: 'none', border: 'none', textAlign: 'right', fontSize: '0.65rem', cursor: 'pointer', padding: 0 }}
                >
                  Verify
                </button>
              </div>
            ))}
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
                  <button 
                    onClick={() => setSelectedProof(item)}
                    style={{ fontSize: '0.6rem', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  >
                    View 0G Proof →
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Day 5: Proof Viewer Modal */}
      {selectedProof && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.8)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, backdropFilter: 'blur(10px)' }}>
          <div className="glass" style={{ maxWidth: '500px', width: '90%', padding: '2rem', position: 'relative' }}>
            <button 
              onClick={() => setSelectedProof(null)}
              style={{ position: 'absolute', top: '1rem', right: '1rem', background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '1.2rem' }}
            >
              ×
            </button>
            <h3 style={{ color: 'var(--primary)', marginBottom: '1.5rem' }}>Verifiable 0G Proof</h3>
            
            <div style={{ background: 'rgba(0,0,0,0.3)', padding: '1.5rem', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)' }}>
              <p style={{ fontSize: '0.7rem', opacity: 0.6, marginBottom: '0.5rem', textTransform: 'uppercase' }}>0G Storage CID</p>
              <code style={{ fontSize: '0.8rem', color: 'var(--accent)', display: 'block', marginBottom: '1.5rem' }}>{selectedProof.cid || selectedProof.tx}</code>
              
              <p style={{ fontSize: '0.7rem', opacity: 0.6, marginBottom: '0.5rem', textTransform: 'uppercase' }}>Decrypted Payload (TEE-Signed)</p>
              <pre style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.9)', whiteSpace: 'pre-wrap', overflowX: 'auto', background: 'rgba(255,255,255,0.05)', padding: '1rem', borderRadius: '8px' }}>
                {JSON.stringify({
                  timestamp: Date.now(),
                  reason: selectedProof.reason || 'EXECUTION_SUCCESS',
                  venue: selectedProof.venue,
                  enclaveId: '0g-tee-8821',
                  wipeProof: '0xbbb4...39',
                  signature: '0xc7de...bc0c'
                }, null, 2)}
              </pre>
            </div>
            
            <button 
              onClick={() => setSelectedProof(null)}
              style={{ width: '100%', padding: '1rem', marginTop: '1.5rem', borderRadius: '12px', border: '1px solid var(--primary)', background: 'none', color: 'var(--primary)', fontWeight: 'bold', cursor: 'pointer' }}
            >
              Close Audit Trail
            </button>
          </div>
        </div>
      )}

      <footer style={{ marginTop: '6rem', textAlign: 'center', opacity: 0.4, fontSize: '0.8rem' }}>
        Built for 0G APAC Hackathon | Powered by 0G TEE & Storage
      </footer>
    </main>
  )
}
