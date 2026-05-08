'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { AppNav } from '../../components/ui'

// ─── Types ────────────────────────────────────────────────────────────────────

type NodeState = 'pending' | 'verifying' | 'verified' | 'failed'

const NODES = [
  { id: 'auth',    title: 'Your authorization',  metaA: 'Wallet: 0xABCD...1234',         metaB: 'Signature: 0x7a3f...c291'   },
  { id: 'exec',    title: 'Agent execution',      metaA: 'Signed inside 0G TEE',          metaB: 'Enclave: 0x2e1a...8f00'     },
  { id: 'anchor',  title: 'On-chain anchor',      metaA: 'Block 203,847,291 · Arbitrum',  metaB: 'ActionExecuted event',  metaC: '0xdfa1...e59e' },
  { id: 'storage', title: '0G Storage proof',     metaPending: 'Fetching from network…',  metaA: 'CID: 0xd895...dfdd'         },
] as const

function statusLabel(state: NodeState): string {
  switch (state) {
    case 'pending':   return 'Waiting…'
    case 'verifying': return 'Checking…'
    case 'verified':  return 'Verified ✓'
    case 'failed':    return 'Invalid'
  }
}

// ─── Verification node ────────────────────────────────────────────────────────

function VNode({
  node, state, lineFilled, last,
}: {
  node: typeof NODES[number]; state: NodeState; lineFilled: boolean; last: boolean
}) {
  return (
    <div className="vnode" data-state={state} data-linefilled={lineFilled ? 'true' : 'false'}>
      <div className="vnode-circle-col">
        <span className="vnode-circle">
          {state === 'verified' && (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2.5 6L5 8.5L9.5 3.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {state === 'failed' && (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 2L8 8M8 2L2 8" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          )}
        </span>
        {!last && <span className="vnode-line" />}
      </div>

      <div className="vnode-body">
        <div className="vnode-title">
          <span>{node.title}</span>
          <span className="vnode-status">{statusLabel(state)}</span>
        </div>
        <div className="vnode-meta">
          {node.id === 'storage' && (state === 'pending' || state === 'verifying') && (
            <div>{node.metaPending}</div>
          )}
          {!(node.id === 'storage' && (state === 'pending' || state === 'verifying')) && node.metaA && (
            <div>
              {node.metaA.includes(':')
                ? <><span>{node.metaA.split(':')[0]}: </span><span className="vnode-mono">{node.metaA.split(':').slice(1).join(':').trim()}</span></>
                : <span className="vnode-mono">{node.metaA}</span>
              }
            </div>
          )}
          {'metaB' in node && node.metaB && (
            <div>
              <span>{node.metaB.split(':')[0]}: </span>
              <span className="vnode-mono">{node.metaB.split(':').slice(1).join(':').trim()}</span>
            </div>
          )}
          {'metaC' in node && node.metaC && <div className="vnode-mono">{node.metaC}</div>}
        </div>
      </div>
    </div>
  )
}

// ─── Share row ────────────────────────────────────────────────────────────────

function ShareRow({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    try { navigator.clipboard.writeText(url) } catch {}
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <input readOnly value={url} style={{
        flex: 1, height: 40,
        fontFamily: "ui-monospace,'SF Mono',Menlo,monospace", fontSize: 13,
        background: '#F5F5F4', border: '1px solid #E7E5E4',
        borderRadius: 8, padding: '0 12px', color: '#44403C', outline: 'none',
      }} />
      <button onClick={onCopy} style={{
        height: 40, padding: '0 16px',
        background: copied ? '#F0FDF4' : '#FFF7ED',
        border: `1px solid ${copied ? '#BBF7D0' : '#FED7AA'}`,
        color: copied ? '#16A34A' : '#EA580C',
        borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
        transition: 'all 150ms ease', fontFamily: 'inherit',
      }}>
        {copied ? 'Copied ✓' : 'Copy link'}
      </button>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProofPage({ params }: { params: { hash: string } }) {
  const router = useRouter()
  const [states, setStates] = useState<NodeState[]>(['pending', 'pending', 'pending', 'pending'])

  useEffect(() => {
    const seq: [number, number, NodeState][] = [
      [200,  0, 'verifying'], [800,  0, 'verified'],
      [900,  1, 'verifying'], [1500, 1, 'verified'],
      [1600, 2, 'verifying'], [2200, 2, 'verified'],
      [2300, 3, 'verifying'], [3200, 3, 'verified'],
    ]
    const ids = seq.map(([t, idx, st]) => setTimeout(() =>
      setStates((prev) => prev.map((p, i) => i === idx ? st : p)), t))
    return () => ids.forEach(clearTimeout)
  }, [])

  const allVerified  = states.every((s) => s === 'verified')
  const anyFailed    = states.some((s) => s === 'failed')
  const stillRunning = !allVerified && !anyFailed

  return (
    <>
      <AppNav />
      <div style={{ minHeight: 'calc(100vh - 64px)', background: '#FAFAF9' }}>
        <div style={{ maxWidth: 520, margin: '0 auto', padding: '80px 20px 96px' }}>

          <button className="act-entry-verify" onClick={() => router.back()}
            style={{ fontSize: 14, color: '#A8A29E', marginBottom: 24 }}>
            ← Back
          </button>

          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#A8A29E', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Proof verification
            </div>
            <div style={{ fontSize: 14, color: '#78716C', marginTop: 12, maxWidth: 400, margin: '12px auto 0', lineHeight: 1.6 }}>
              This action is independently verifiable. No trust required.
            </div>
          </div>

          {/* Main card */}
          <div style={{
            marginTop: 32,
            background: '#FFFFFF', border: '1px solid #E7E5E4',
            borderRadius: 24, padding: 40,
            boxShadow: '0 8px 24px rgba(28,25,23,0.10)',
          }}>
            {/* Card header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 600, color: '#1C1917', letterSpacing: '-0.01em' }}>
                  MIGRATE → Pendle sUSDe YT
                </div>
                <div style={{ fontSize: 13, color: '#A8A29E', marginTop: 4 }}>
                  My first strategy · Arbitrum
                </div>
              </div>
              <div style={{ fontSize: 13, color: '#A8A29E', whiteSpace: 'nowrap' }}>2 hours ago</div>
            </div>

            {/* Verification chain */}
            <div className="vchain">
              {NODES.map((n, i) => (
                <VNode
                  key={n.id}
                  node={n}
                  state={states[i]}
                  lineFilled={states[i] === 'verified' && i < NODES.length - 1}
                  last={i === NODES.length - 1}
                />
              ))}
            </div>

            <div style={{ height: 1, background: '#E7E5E4', margin: '28px 0' }} />

            {allVerified && (
              <div style={{ animation: 'resultIn 320ms ease-out both' }}>
                <div style={{
                  background: '#F0FDF4', border: '1px solid #BBF7D0',
                  borderRadius: 12, padding: '20px 24px', textAlign: 'center',
                  color: '#15803D', fontSize: 16, fontWeight: 600,
                }}>
                  This action is tamper-proof.
                </div>
                <div style={{ fontSize: 14, color: '#78716C', lineHeight: 1.6, textAlign: 'center', marginTop: 16 }}>
                  Everything the agent did — the exact amount, the protocol, and the timing — is locked into two independent chains forever.
                </div>
              </div>
            )}

            {anyFailed && (
              <div style={{ animation: 'resultIn 320ms ease-out both' }}>
                <div style={{
                  background: '#FEF2F2', border: '1px solid #FECACA',
                  borderRadius: 12, padding: '20px 24px', textAlign: 'center',
                  color: '#B91C1C', fontSize: 16, fontWeight: 600,
                }}>
                  Verification failed. This proof does not match.
                </div>
              </div>
            )}

            {stillRunning && (
              <div style={{ fontSize: 13, color: '#A8A29E', textAlign: 'center' }}>Verifying…</div>
            )}

            <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
              <a href="#" style={{ fontSize: 13, fontWeight: 500, color: '#EA580C', textDecoration: 'none' }}>
                View on Arbiscan ↗
              </a>
              <a href="#" style={{ fontSize: 13, fontWeight: 500, color: '#78716C', textDecoration: 'none' }}>
                View on 0G ↗
              </a>
            </div>
          </div>

          {/* Share */}
          <div style={{ marginTop: 32 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: '#78716C', marginBottom: 10 }}>Share this proof</div>
            <ShareRow url={`https://yieldgeko.xyz/proof/${params.hash}`} />
          </div>
        </div>
      </div>
    </>
  )
}
