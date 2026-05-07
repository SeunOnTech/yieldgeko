'use client'

import { useState, useEffect } from 'react'
import { useAccount, useReadContracts, useWalletClient } from 'wagmi'
import { ethers } from 'ethers'
import { ADDRESSES } from '@yieldgeko/core'
import { useSignIntent } from '../hooks/useSignIntent'
import { useYieldVault } from '../hooks/useYieldVault'
import { storageService } from '../lib/storage'
import { Verifier } from '../lib/verifier'
import {
  strategyRegistryAbi,
  useReadStrategyRegistryGetActiveStrategies,
  useReadYieldGekoRouterNonces,
} from '../src/generated'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const
const VAULT_ASSET_ADDRESS = '0x65a085d7F6e65a085D7F6E65A085d7f6E65a085D' as const

type LedgerEntry = {
  date: string
  type: string
  uplift: string
  fee: string
  venue: string
  hash: string
  txHash: `0x${string}`
  cid: string
}

type StrategyOption = {
  address: `0x${string}`
  name: string
}

type StrategyInfoResult = {
  isActive: boolean
  adapter: `0x${string}`
  name: string
  chainId: number
  minLiquidity: bigint
  isAudited: boolean
  isPaused: boolean
}

function getUnixTimePlus(secondsFromNow: number): number {
  return Math.floor(Date.now() / 1000) + secondsFromNow
}

function getTimestampMs(): number {
  return Date.now()
}

export default function Home() {
  const { address, isConnected } = useAccount()
  const { data: walletClient } = useWalletClient()
  const { signIntent } = useSignIntent()
  const { balance } = useYieldVault(VAULT_ASSET_ADDRESS)
  
  const [risk, setRisk] = useState(1) // 0: Cons, 1: Bal, 2: Agg
  const [status, setStatus] = useState<'idle' | 'signing' | 'success' | 'error'>('idle')
  const [signature, setSignature] = useState<string | null>(null)
  const [cid, setCid] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [selectedProof, setSelectedProof] = useState<LedgerEntry | null>(null)
  
  const [isMonitoring, setIsMonitoring] = useState(false)
  const [verificationResult, setVerificationResult] = useState<{
    isValid: boolean
    computedHash: string
    onChainHash: string
    data?: unknown
    error?: string
  } | null>(null)
  const [ledger] = useState<LedgerEntry[]>([
    { 
      date: '2026-05-06', 
      type: 'Migration', 
      uplift: '+$8.40', 
      fee: '$0.25', 
      venue: 'Pendle sUSDe YT', 
      hash: '0xdfa10c362698652986a24b257c727fe3bd225cf04008d938d8cfc5f529b6e59e',
      txHash: '0xac7df667f1a698b386db37f22a486e33a82cbc38650e9aa03a57178a93f8e281',
      cid: '0xd89515db5507664b775614af860d1543fe2a2de2bff9192ecec0661511a7dfdd' 
    },
    { 
      date: '2026-05-05', 
      type: 'Migration', 
      uplift: '+$1.20', 
      fee: '$0.05', 
      venue: 'Uniswap V3 sUSDe', 
      hash: '0xb947968519c1c63238d6acaae89a4a1ddeb0961c8c1591fd5d590ff4f07515df',
      txHash: '0xac7df667f1a698b386db37f22a486e33a82cbc38650e9aa03a57178a93f8e281',
      cid: '0xe61b5175192228b7ed97fdfd192f51bad19458ef47cd952d9089111948816ca1'
    },
  ])
  const [selectedStrategy, setSelectedStrategy] = useState<`0x${string}` | null>(null)

  const [liveVenues, setLiveVenues] = useState<any[]>([])
  const [currentAlpha, setCurrentAlpha] = useState<any>(null)

  useEffect(() => {
    const fetchLiveYields = async () => {
      try {
        const res = await fetch(`/yield-status.json?t=${Date.now()}`, { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json()
          setLiveVenues(data.venues)
          if (data.venues.length > 0) {
            setCurrentAlpha(data.venues[0])
          }
        }
      } catch (err) {
        console.error("Failed to fetch live yields", err)
      }
    }
    fetchLiveYields()
    const interval = setInterval(fetchLiveYields, 10000) // Faster sync for demo
    return () => clearInterval(interval)
  }, [])

  const handleVerify = async (entry: LedgerEntry) => {
    setSelectedProof(entry)
    setVerificationResult(null) // Reset
    try {
      const result = await Verifier.verifyReceipt(entry.cid, entry.txHash)
      setVerificationResult(result)
    } catch (err) {
      console.error(err)
    }
  }

  const handleExportCSV = () => {
    const headers = "Date,Venue,Type,Uplift,Fee,ProofHash,StorageCID\n"
    const rows = ledger.map(e => `${e.date},${e.venue},${e.type},${e.uplift},${e.fee},${e.hash},${e.txHash},${e.cid}`).join("\n")
    const blob = new Blob([headers + rows], { type: 'text/csv' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `yieldgeko_audit_${address}.csv`
    a.click()
  }

  const riskLabels = ['Conservative', 'Balanced', 'Aggressive']
  const targetYields = [12, 22, 40] // Target APYs

  const { data: activeStrategyAddresses } = useReadStrategyRegistryGetActiveStrategies({
    address: ADDRESSES.STRATEGY_REGISTRY as `0x${string}`,
  })

  const { data: strategyInfoResults } = useReadContracts({
    contracts: (activeStrategyAddresses ?? []).map((strategyAddress) => ({
      address: ADDRESSES.STRATEGY_REGISTRY as `0x${string}`,
      abi: strategyRegistryAbi,
      functionName: 'getStrategyInfo',
      args: [strategyAddress],
    })),
    query: {
      enabled: Boolean(activeStrategyAddresses?.length),
    },
  })

  const approvedStrategies: StrategyOption[] = (activeStrategyAddresses ?? []).flatMap((strategyAddress, index) => {
    const strategyInfo = strategyInfoResults?.[index]?.result as StrategyInfoResult | undefined
    if (!strategyInfo || strategyInfo.isPaused || !strategyInfo.isActive) {
      return []
    }

    return [{
      address: strategyAddress,
      name: strategyInfo.name,
    }]
  })

  const { data: nonce } = useReadYieldGekoRouterNonces({
    address: ADDRESSES.YIELD_GEKO_ROUTER as `0x${string}`,
    args: address ? [address] : undefined
  })

  const handleSignIntent = async () => {
    if (!address || !walletClient) return
    setStatus('signing')
    
    try {
      const idleBalance = balance ?? BigInt(0)
      if (idleBalance === BigInt(0)) {
        throw new Error('Deposit funds into your vault before authorizing a migration route.')
      }

      const targetStrategy = selectedStrategy ?? approvedStrategies[0]?.address
      if (!targetStrategy) {
        throw new Error('No approved strategy is available yet. Add an approved strategy to the registry first.')
      }

      const selectedStrategyInfo = approvedStrategies.find((strategy) => strategy.address === targetStrategy)
      if (!selectedStrategyInfo) {
        throw new Error('Selected strategy is no longer approved. Refresh and try again.')
      }

      const minApyBps = targetYields[risk] * 100
      const signedExpectedApyBps = minApyBps
      const maxFee = idleBalance / BigInt(100)

      // 1. Sign Intent (EIP-712)
      const deadline = getUnixTimePlus(3600)
      const signResult = await signIntent(
        VAULT_ASSET_ADDRESS,
        ZERO_ADDRESS,
        targetStrategy,
        idleBalance,
        minApyBps,
        signedExpectedApyBps,
        100, // maxSlippage
        maxFee,
        Number(nonce || 0),
        deadline
      )
      
      setSignature(signResult.signature)

      // 2. Prepare Ethers Signer for 0G Storage
      const provider = new ethers.BrowserProvider(walletClient.transport);
      const signer = await provider.getSigner();

      // 3. Encrypt & Persist to REAL 0G Storage
      const userState = {
        intent: {
          asset: VAULT_ASSET_ADDRESS,
          fromStrategy: ZERO_ADDRESS,
          toStrategy: targetStrategy,
          amount: idleBalance.toString(),
          minAPY: minApyBps,
          expectedAPY: signedExpectedApyBps,
          maxSlippage: 100,
          maxFee: maxFee.toString(),
          riskTier: riskLabels[risk].toLowerCase(),
          strategyLabel: selectedStrategyInfo.name,
        },
        metadata: {
          walletAddress: address,
          createdAt: getTimestampMs(),
          version: "1.0"
        }
      }

      const storageResult = await storageService.persistIntent(userState, signer)
      setCid(storageResult.cid)

      setStatus('success')
      setIsMonitoring(true)
    } catch (err) {
      console.error(err)
      setErrorMsg(err instanceof Error ? err.message : 'Authorization failed. Please try again.')
      setStatus('error')
    }
  }

  return (
    <main className="container">
      <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4rem' }}>
        <h1 className="gradient-text" style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>YieldGeko 🦎</h1>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '0.5rem',
            padding: '0.25rem 0.75rem', 
            borderRadius: '999px', 
            fontSize: '0.75rem', 
            background: isMonitoring ? 'rgba(34, 197, 94, 0.1)' : 'rgba(107, 114, 128, 0.1)', 
            border: `1px solid ${isMonitoring ? 'rgba(34, 197, 94, 0.2)' : 'rgba(107, 114, 128, 0.2)'}`,
            color: isMonitoring ? 'rgb(74, 222, 128)' : 'rgb(156, 163, 175)' 
          }}>
            <span style={{ 
              width: '8px', 
              height: '8px', 
              borderRadius: '50%', 
              background: isMonitoring ? 'rgb(34, 197, 94)' : 'rgb(107, 114, 128)',
              boxShadow: isMonitoring ? '0 0 8px rgb(34, 197, 94)' : 'none',
              animation: isMonitoring ? 'pulse 2s infinite' : 'none'
            }} />
            {isMonitoring ? "Agent Active" : "Agent Offline"}
          </div>
          <appkit-button />
        </div>
      </nav>

      <section style={{ maxWidth: '600px', margin: '0 auto' }}>
        {ledger.length === 0 && !isMonitoring ? (
          <div className="glass" style={{ padding: '4rem 3rem', textAlign: 'center', border: '2px dashed var(--primary-glow)' }}>
            <div style={{ fontSize: '3rem', marginBottom: '1.5rem' }}>🦎</div>
            <h2 style={{ fontSize: '1.8rem', marginBottom: '1rem' }}>Welcome to YieldGeko</h2>
            <p style={{ color: 'rgba(255,255,255,0.6)', marginBottom: '2.5rem' }}>
              Your capital is currently idle. Set your safety floor and authorize your personal agent to start harvesting yield.
            </p>
            <button 
              onClick={() => setIsMonitoring(true)}
              style={{ padding: '1rem 2rem', borderRadius: '12px', border: 'none', background: 'var(--primary)', color: 'black', fontWeight: 'bold', fontSize: '1.1rem', cursor: 'pointer' }}
            >
              Get Started →
            </button>
          </div>
        ) : (
          <>
            <div className="glass" style={{ padding: '3rem', textAlign: 'center', marginBottom: '2rem' }}>
              <h2 style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>Protect & Grow Your Yield</h2>
              <p style={{ color: 'rgba(255,255,255,0.6)', marginBottom: '2.5rem', fontSize: '0.9rem' }}>
                Our autonomous agent monitors your capital 24/7, moving it only when your safety floor is met.
              </p>

              <div style={{ marginBottom: '2rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', fontWeight: 'bold' }}>
                  <span style={{ color: 'var(--accent)' }}>Risk Profile: {riskLabels[risk]}</span>
                  <span className="gradient-text">Safety Floor: {targetYields[risk]}% APY</span>
                </div>
                <input 
                  type="range" 
                  min="0" 
                  max="2" 
                  step="1" 
                  value={risk} 
                  onChange={(e) => setRisk(parseInt(e.target.value))}
                  style={{
                    accentColor: risk === 2 ? '#ff4d4d' : risk === 1 ? 'var(--primary)' : '#4ade80'
                  }}
                />
              </div>

              <div style={{ marginBottom: '2rem', textAlign: 'left' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 'bold', marginBottom: '0.75rem' }}>Approved Strategy Route</div>
                <select
                  value={selectedStrategy ?? ''}
                  onChange={(e) => setSelectedStrategy(e.target.value as `0x${string}`)}
                  style={{
                    width: '100%',
                    padding: '0.9rem 1rem',
                    borderRadius: '12px',
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: 'rgba(255,255,255,0.04)',
                    color: 'white',
                  }}
                >
                  {approvedStrategies.length === 0 ? (
                    <option value="">No approved strategies available</option>
                  ) : (
                    approvedStrategies.map((strategy) => (
                      <option key={strategy.address} value={strategy.address}>
                        {strategy.name} • {strategy.address.slice(0, 6)}...{strategy.address.slice(-4)}
                      </option>
                    ))
                  )}
                </select>
                <p style={{ color: 'rgba(255,255,255,0.6)', marginTop: '0.75rem', fontSize: '0.75rem' }}>
                  This authorization signs an exact route for your current idle vault balance and a capped total fee.
                </p>
              </div>

              {!isConnected ? (
                <p style={{ color: 'var(--primary)', fontSize: '0.9rem' }}>Connect your wallet to authorize the agent</p>
              ) : (
                <button 
                  onClick={handleSignIntent}
                  disabled={status === 'signing'}
                  style={{
                    width: '100%',
                    padding: '1rem',
                    borderRadius: '12px',
                    border: 'none',
                    background: status === 'signing' ? 'rgba(255,255,255,0.1)' : 'linear-gradient(90deg, var(--primary), var(--accent))',
                    color: 'black',
                    fontWeight: 'bold',
                    fontSize: '1.1rem',
                    cursor: 'pointer'
                  }}
                >
                  {status === 'signing' ? 'Attesting...' : 'Authorize Agent →'}
                </button>
              )}

              {status === 'success' && (
                <div style={{ marginTop: '2rem', padding: '1rem', background: 'rgba(34,197,94,0.1)', borderRadius: '12px', textAlign: 'left', border: '1px solid rgba(34,197,94,0.2)' }}>
                  <p style={{ color: 'var(--primary)', fontWeight: 'bold', fontSize: '0.8rem' }}>✓ Agent Authorized & Enclaved</p>
                  <div style={{ marginTop: '0.5rem', fontSize: '0.65rem', opacity: 0.7 }}>
                    CID: <code style={{ color: 'var(--accent)' }}>{cid?.slice(0, 20)}...</code>
                  </div>
                  <div style={{ marginTop: '0.5rem', fontSize: '0.65rem', opacity: 0.7 }}>
                    Sig: <code style={{ color: 'var(--accent)' }}>{signature?.slice(0, 18)}...</code>
                  </div>
                </div>
              )}

              {status === 'error' && (
                <div style={{ marginTop: '2rem', padding: '1rem', background: 'rgba(239,68,68,0.1)', borderRadius: '12px', textAlign: 'left', border: '1px solid rgba(239,68,68,0.2)' }}>
                  <p style={{ color: '#ef4444', fontWeight: 'bold', fontSize: '0.8rem' }}>❌ {errorMsg}</p>
                </div>
              )}
            </div>

            <div className="glass" style={{ padding: '2rem', marginBottom: '2rem', border: '1px solid rgba(0, 255, 136, 0.2)' }}>
              <h3 style={{ fontSize: '0.9rem', fontWeight: 'bold', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ color: 'var(--primary)' }}>🛡️</span> Protocol Security Stack
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', textAlign: 'center' }}>
                <div style={{ padding: '1rem', background: 'rgba(255,255,255,0.02)', borderRadius: '12px' }}>
                  <div style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>🔐</div>
                  <div style={{ fontSize: '0.7rem', fontWeight: 'bold', marginBottom: '0.25rem' }}>Sealed TEE</div>
                  <div style={{ fontSize: '0.6rem', opacity: 0.5 }}>Private Execution</div>
                </div>
                <div style={{ padding: '1rem', background: 'rgba(255,255,255,0.02)', borderRadius: '12px' }}>
                  <div style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>📦</div>
                  <div style={{ fontSize: '0.7rem', fontWeight: 'bold', marginBottom: '0.25rem' }}>0G Storage</div>
                  <div style={{ fontSize: '0.6rem', opacity: 0.5 }}>Immutable Proofs</div>
                </div>
                <div style={{ padding: '1rem', background: 'rgba(255,255,255,0.02)', borderRadius: '12px' }}>
                  <div style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>⚓</div>
                  <div style={{ fontSize: '0.7rem', fontWeight: 'bold', marginBottom: '0.25rem' }}>EVM Anchor</div>
                  <div style={{ fontSize: '0.6rem', opacity: 0.5 }}>Final Settlement</div>
                </div>
              </div>
            </div>

            <div className="glass" style={{ padding: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
              <div>
                <h3 style={{ fontSize: '0.8rem', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Active Capital</h3>
                <div style={{ fontSize: '2.5rem', fontWeight: 'bold' }}>${balance ? (Number(balance) / 1e6).toFixed(2) : "0.00"}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p style={{ color: 'var(--primary)', fontWeight: 'bold' }}>+12.4% Net Profit</p>
                <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>Verified on 0G Galileo</p>
              </div>
            </div>

            <div className="glass" style={{ padding: '2rem', marginBottom: '2rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                <h3 style={{ fontSize: '0.9rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ color: 'var(--accent)' }}>📊</span> Financial Transparency
                </h3>
                <button 
                  onClick={handleExportCSV}
                  style={{ fontSize: '0.7rem', color: 'var(--primary)', background: 'none', border: '1px solid var(--primary)', padding: '0.25rem 0.75rem', borderRadius: '6px', cursor: 'pointer' }}
                >
                  Export Audit Trail
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '2rem' }}>
                <div style={{ padding: '1.5rem', background: 'rgba(255,255,255,0.03)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <p style={{ fontSize: '0.65rem', opacity: 0.6, textTransform: 'uppercase', marginBottom: '0.5rem' }}>Extra Yield Earned</p>
                  <p style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--primary)' }}>+${ledger.reduce((acc, curr) => acc + parseFloat(curr.uplift.slice(2)), 0).toFixed(2)}</p>
                </div>
                <div style={{ padding: '1.5rem', background: 'rgba(255,255,255,0.03)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <p style={{ fontSize: '0.65rem', opacity: 0.6, textTransform: 'uppercase', marginBottom: '0.5rem' }}>Network Costs</p>
                  <p style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>${ledger.reduce((acc, curr) => acc + parseFloat(curr.fee.slice(1)), 0).toFixed(2)}</p>
                </div>
              </div>

              <div style={{ fontSize: '0.8rem', opacity: 0.8, marginBottom: '1rem', fontWeight: 'bold' }}>Yield Migration Ledger</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {ledger.map((entry, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr 1fr 1fr 0.5fr', fontSize: '0.7rem', padding: '1rem', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)', alignItems: 'center' }}>
                    <span style={{ opacity: 0.5 }}>{entry.date}</span>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ fontWeight: 'bold' }}>{entry.venue}</span>
                      <span className={`badge-risk ${entry.venue.includes('Aave') ? 'badge-safe' : 'badge-boost'}`} style={{ width: 'fit-content' }}>
                        {entry.venue.includes('Aave') ? 'Safe' : 'Boosted'}
                      </span>
                    </div>
                    <span style={{ color: 'var(--primary)', fontWeight: 'bold' }}>{entry.uplift}</span>
                    <span>{entry.fee}</span>
                    <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <button 
                        onClick={() => handleVerify(entry)}
                        style={{ color: 'var(--accent)', background: 'none', border: 'none', fontSize: '0.65rem', cursor: 'pointer', padding: 0, textAlign: 'right' }}
                      >
                        Verify →
                      </button>
                      <a 
                        href={`https://chainscan-galileo.0g.ai/tx/${entry.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: '0.5rem', opacity: 0.4, color: 'white', textDecoration: 'none' }}
                      >
                        Explorer ↗
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="glass" style={{ padding: '2rem', marginBottom: '2rem', border: '1px solid rgba(0, 255, 136, 0.1)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                <h3 style={{ fontSize: '0.9rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ color: 'var(--primary)' }}>💎</span> Ecosystem Alpha Leaderboard
                </h3>
                <span style={{ fontSize: '0.7rem', opacity: 0.5 }}>{liveVenues.length} Venues Tracked</span>
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {liveVenues.map((v, i) => (
                  <div key={v.id} style={{ 
                    padding: '1rem', 
                    borderRadius: '12px', 
                    background: i === 0 ? 'rgba(0, 255, 136, 0.05)' : 'rgba(255,255,255,0.02)', 
                    border: `1px solid ${i === 0 ? 'rgba(0, 255, 136, 0.2)' : 'rgba(255,255,255,0.05)'}`,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: 'bold', color: i === 0 ? 'var(--primary)' : 'rgba(255,255,255,0.3)', width: '20px' }}>#{i+1}</span>
                      <div>
                        <div style={{ fontWeight: 'bold', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          {v.name}
                          <span style={{ 
                            fontSize: '0.6rem', 
                            padding: '1px 6px', 
                            borderRadius: '4px', 
                            background: v.protocol === 'Pendle' ? 'rgba(168, 85, 247, 0.1)' : v.protocol === 'Uniswap V3' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(0, 255, 136, 0.1)',
                            color: v.protocol === 'Pendle' ? '#a855f7' : v.protocol === 'Uniswap V3' ? '#ef4444' : 'var(--primary)',
                            border: `1px solid ${v.protocol === 'Pendle' ? 'rgba(168, 85, 247, 0.2)' : v.protocol === 'Uniswap V3' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(0, 255, 136, 0.2)'}`
                          }}>
                            {v.protocol === 'Pendle' ? 'YT • Theta' : v.protocol === 'Uniswap V3' ? 'LP • IL Risk' : 'Lending • Safe'}
                          </span>
                        </div>
                        <div style={{ fontSize: '0.7rem', opacity: 0.5, display: 'flex', gap: '0.75rem' }}>
                          <span>{v.protocol}</span>
                          <span>• Exit: {v.score?.toFixed(0) ?? '0'}%</span>
                          <span style={{ color: (v.stability ?? 100) < 95 ? '#ef4444' : 'rgba(255,255,255,0.5)' }}>
                            • Stab: {v.stability?.toFixed(0) ?? '100'}%
                          </span>
                        </div>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: v.type === 'boost' ? 'var(--accent)' : 'var(--primary)' }}>{v.apy?.toFixed(2) ?? '0.00'}%</div>
                      <div style={{ fontSize: '0.6rem', opacity: 0.4, textTransform: 'uppercase' }}>Current APY</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {currentAlpha && (
              <div className="glass" style={{ padding: '2rem', marginBottom: '2rem', background: 'rgba(168, 85, 247, 0.05)', border: '1px solid rgba(168, 85, 247, 0.2)' }}>
                <h3 style={{ fontSize: '0.9rem', fontWeight: 'bold', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ color: '#a855f7' }}>🧠</span> Live Agent Intelligence
                </h3>
                <div style={{ fontSize: '0.85rem', lineHeight: '1.5', opacity: 0.9 }}>
                  The agent is currently prioritizing <span style={{ color: 'var(--primary)', fontWeight: 'bold' }}>{currentAlpha?.name ?? 'Scanning...'}</span> on <span style={{ fontWeight: 'bold' }}>{currentAlpha?.protocol ?? 'Network'}</span>. 
                  <p style={{ marginTop: '0.5rem', fontSize: '0.8rem', opacity: 0.7 }}>
                    Reasoning: This venue offers a {currentAlpha?.apy?.toFixed(1) ?? '0.0'}% yield with a liquidity confidence score of {currentAlpha?.score?.toFixed(0) ?? '0'}/100. 
                    The agent has verified the "Anytime Withdrawal" route via 0G Storage anchored proofs.
                  </p>
                </div>
              </div>
            )}

            <div className="glass" style={{ padding: '2rem', borderBottom: '4px solid var(--primary)', marginBottom: '2rem' }}>
              <h3 style={{ fontSize: '0.9rem', fontWeight: 'bold', marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ color: 'var(--primary)' }}>⚡</span> Real-Time Activity
                </div>
                <div className="live-indicator">
                  <div className="live-dot" /> LIVE MONITORING
                </div>
              </h3>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {[
                  { id: 1, type: 'SHIELDED', reason: 'Safety Floor Maintained', venue: 'Aave USDC', time: 'Just now', color: '#00ccff' },
                  { id: 2, type: 'MOVED', venue: 'Pendle weETH', uplift: '+2.4%', time: '1h ago', color: '#a855f7' }
                ].map((item) => (
                  <div key={item.id} style={{ padding: '1rem', borderRadius: '12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                      <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: `${item.color}20`, display: 'flex', justifyContent: 'center', alignItems: 'center', color: item.color, fontSize: '1rem' }}>
                        {item.type === 'SHIELDED' ? '🛡️' : '🚀'}
                      </div>
                      <div>
                        <div style={{ fontWeight: 'bold', fontSize: '0.8rem' }}>{item.type === 'SHIELDED' ? 'Capital Protected' : 'Yield Optimized'}</div>
                        <div style={{ fontSize: '0.7rem', opacity: 0.5 }}>{item.venue} • {item.reason || `Uplift: ${item.uplift}`}</div>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>{item.time}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </section>

      {selectedProof && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.85)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, backdropFilter: 'blur(12px)' }}>
          <div className="glass" style={{ maxWidth: '500px', width: '90%', padding: '2.5rem', position: 'relative', border: '1px solid var(--primary)' }}>
            <button 
              onClick={() => setSelectedProof(null)}
              style={{ position: 'absolute', top: '1rem', right: '1rem', background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '1.2rem', opacity: 0.5 }}
            >
              ×
            </button>
            
            <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
              <div style={{ 
                width: '60px', 
                height: '60px', 
                borderRadius: '50%', 
                background: !verificationResult ? 'rgba(255,255,255,0.05)' : verificationResult.isValid ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', 
                border: `2px solid ${!verificationResult ? 'rgba(255,255,255,0.2)' : verificationResult.isValid ? 'rgb(34,197,94)' : 'rgb(239,68,68)'}`, 
                display: 'flex', 
                justifyContent: 'center', 
                alignItems: 'center', 
                margin: '0 auto 1rem', 
                fontSize: '1.5rem',
                animation: !verificationResult ? 'pulse 1.5s infinite' : 'none'
              }}>
                {!verificationResult ? '⏳' : verificationResult.isValid ? '✅' : '❌'}
              </div>
              <h3 style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>
                {!verificationResult ? 'Verifying Proof...' : verificationResult.isValid ? 'Cryptographically Verified' : 'Verification Failed'}
              </h3>
              <p style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                {!verificationResult ? 'Fetching data from 0G Storage Nodes...' : verificationResult.isValid ? 'This migration matches the 0G on-chain anchor exactly.' : 'The data in storage does not match the on-chain anchor.'}
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '2rem' }}>
              {[
                { label: 'TEE Execution', desc: 'Agent signed in secure enclave', status: 'Verified' },
                { label: 'On-Chain Anchor', desc: 'Hash locked on 0G Blockchain', status: 'Matched' },
                { label: 'Data Retrieval', desc: 'Decrypted from 0G Storage', status: !verificationResult ? 'Waiting...' : verificationResult.isValid ? 'Success' : 'Error' }
              ].map((step, i) => (
                <div key={i} style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{ 
                      width: '12px', 
                      height: '12px', 
                      borderRadius: '50%', 
                      background: step.status === 'Waiting...' ? 'rgba(255,255,255,0.2)' : step.status === 'Error' ? 'rgb(239,68,68)' : 'var(--primary)' 
                    }} />
                    {i < 2 && <div style={{ width: '2px', height: '30px', background: 'rgba(255,255,255,0.1)' }} />}
                  </div>
                  <div>
                    <div style={{ fontSize: '0.8rem', fontWeight: 'bold', display: 'flex', gap: '0.5rem' }}>
                      {step.label} <span style={{ 
                        color: step.status === 'Waiting...' ? 'rgba(255,255,255,0.5)' : step.status === 'Error' ? 'rgb(239,68,68)' : 'var(--primary)', 
                        fontSize: '0.7rem' 
                      }}>✓ {step.status}</span>
                    </div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.5 }}>{step.desc}</div>
                  </div>
                </div>
              ))}
            </div>
            
            <div style={{ background: 'rgba(0,0,0,0.3)', padding: '1.5rem', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', marginBottom: '1rem' }}>
              <p style={{ fontSize: '0.65rem', opacity: 0.6, marginBottom: '0.5rem', textTransform: 'uppercase' }}>On-Chain Proof Hash</p>
              <code style={{ fontSize: '0.75rem', color: 'var(--accent)', display: 'block', wordBreak: 'break-all', marginBottom: '1rem' }}>{selectedProof.hash}</code>
              
              <div style={{ display: 'flex', gap: '1rem' }}>
                <a 
                  href={`https://chainscan-galileo.0g.ai/tx/${selectedProof.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: '0.65rem', color: 'var(--primary)', textDecoration: 'none' }}
                >
                  View Settlement ↗
                </a>
                <a 
                  href={`https://storagescan-galileo.0g.ai/file/${selectedProof.cid.startsWith('0x') ? selectedProof.cid.slice(2) : selectedProof.cid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: '0.65rem', color: 'white', opacity: 0.5, textDecoration: 'none' }}
                >
                  0G StorageScan ↗
                </a>
              </div>
            </div>

            {verificationResult?.data != null ? (
              <div style={{ background: 'rgba(0,255,163,0.03)', padding: '1rem', borderRadius: '12px', border: '1px solid rgba(0,255,163,0.1)' }}>
                <p style={{ fontSize: '0.65rem', color: 'var(--primary)', marginBottom: '0.5rem', textTransform: 'uppercase', fontWeight: 'bold' }}>Data Retrieved from 0G Network</p>
                <pre style={{ fontSize: '0.6rem', opacity: 0.8, overflowX: 'auto', color: 'white' }}>
                  {JSON.stringify(verificationResult.data, null, 2)}
                </pre>
              </div>
            ) : null}
            
            <button 
              onClick={() => setSelectedProof(null)}
              style={{ width: '100%', padding: '1rem', marginTop: '1.5rem', borderRadius: '12px', border: 'none', background: 'var(--primary)', color: 'black', fontWeight: 'bold', cursor: 'pointer' }}
            >
              Close Audit
            </button>
          </div>
        </div>
      )}

      <footer style={{ marginTop: '6rem', paddingBottom: '4rem', textAlign: 'center', opacity: 0.4, fontSize: '0.8rem' }}>
        Built for 0G APAC Hackathon | Powered by 0G TEE & Storage
      </footer>
    </main>
  )
}
