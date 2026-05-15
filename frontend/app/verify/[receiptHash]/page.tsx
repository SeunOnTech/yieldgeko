'use client'

import React, { useState, useEffect } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { verifyMessage, recoverAddress, hashMessage } from 'viem'

const ZG_RPC        = 'https://evmrpc.0g.ai'
const REGISTRY_ADDR = '0xd7185a3Aa4b23EBE84e7bd60CF5e78B71dd21c8e'
const CHAIN_SCAN    = 'https://chainscan.0g.ai'
const STORAGE_SCAN  = 'https://storagescan.0g.ai/submission'

const PROOF_ANCHORED_TOPIC = '0x3e6bdef8f774b69375e8d3824eaf732c225c3f5ee9ac4484c6a155440e6d54ce'

async function fetchProof(receiptHash: string): Promise<ProofData | null> {
  
  const raw    = receiptHash.startsWith('0x') ? receiptHash.slice(2) : receiptHash
  const topic1 = '0x' + raw.padStart(64, '0')

  const res = await fetch(ZG_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
      params: [{
        address:   REGISTRY_ADDR,
        topics:    [PROOF_ANCHORED_TOPIC, topic1],
        fromBlock: '0x0',
        toBlock:   'latest',
      }],
    }),
  })
  const json = await res.json()
  const logs: any[] = json.result ?? []
  if (logs.length === 0) return null
  return decodeProofFromLog(logs[0], receiptHash)
}

function decodeProofFromLog(log: any, originalHash: string): ProofData | null {
  try {
    if (!log || !Array.isArray(log.topics) || log.topics.length < 3) return null
    if (typeof log.topics[2] !== 'string' || !log.topics[2].startsWith('0x')) return null
    if (typeof log.data !== 'string' || log.data.length < 4) return null

    const userAddress = '0x' + log.topics[2].slice(26)
    if (!/^0x[a-fA-F0-9]{40}$/.test(userAddress)) return null

    const data     = log.data.startsWith('0x') ? log.data.slice(2) : log.data
    if (data.length < 256) return null

    const readWord = (i: number) => data.slice(i * 64, i * 64 + 64)
    const readUint = (i: number) => {
      const w = readWord(i)
      if (!w || w.length < 64) return 0
      return parseInt(w, 16) || 0
    }
    const readStr  = (byteOffset: number) => {
      const c   = byteOffset * 2
      if (c + 64 > data.length) return ''
      const len = parseInt(data.slice(c, c + 64), 16) || 0
      if (len === 0 || len > 4096) return ''
      const hex = data.slice(c + 64, c + 64 + len * 2)
      if (hex.length < len * 2) return ''
      return Buffer.from(hex, 'hex').toString('utf8')
    }

    const actionOff    = readUint(0)
    const traceCIDOff  = readUint(1)
    const attestCIDOff = readUint(2)
    const anchoredAt   = readUint(3)

    const action    = readStr(actionOff)
    const traceCID  = readStr(traceCIDOff)
    const attestCID = readStr(attestCIDOff)

    if (!anchoredAt || !action) return null

    return {
      receiptHash: originalHash,
      userAddress,
      anchoredBy: userAddress,
      action,
      traceCID,
      attestCID,
      anchoredAt,
      txHash: typeof log.transactionHash === 'string' ? log.transactionHash : undefined,
    }
  } catch { return null }
}

interface ProofData {
  receiptHash: string
  userAddress:  string
  anchoredBy:   string
  action:       string
  traceCID:     string
  attestCID:    string
  anchoredAt:   number
  txHash?:      string
}

function actionColor(a: string) {
  if (a === 'GENESIS')            return '#22C55E'
  if (a === 'WITHDRAW')           return '#EF4444'
  if (a === 'MIGRATE')            return '#3B82F6'
  if (a?.includes('REBALANCE'))   return '#8B5CF6'
  return '#EA580C'
}

function short(s: string, n = 16) {
  return s ? `${s.slice(0, n)}…${s.slice(-6)}` : '—'
}

function CopyBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: copied ? '#22C55E' : 'var(--text-muted)', padding: '0 4px', fontFamily: 'inherit' }}
    >
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  )
}

function ProofLink({ label, href, color, icon }: { label: string; href: string; color: string; icon: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '14px 16px', borderRadius: 12,
        background: `${color}0d`, border: `1px solid ${color}30`,
        textDecoration: 'none', transition: 'all 120ms',
      }}
      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = `${color}18`}
      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = `${color}0d`}
    >
      <span style={{ fontSize: 18 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color }}>{label}</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {href}
        </div>
      </div>
      <span style={{ fontSize: 12, color, opacity: 0.7 }}>↗</span>
    </a>
  )
}

const AGENT_BASE = (process.env.NEXT_PUBLIC_AGENT_SSE_URL ?? 'http://localhost:3001/events').replace('/events', '')

type VerifyState = 'idle' | 'loading' | 'done' | 'error'

function TeeVerificationPanel({ attestCID }: { attestCID: string }) {
  const [state,  setState]  = useState<VerifyState>('idle')
  const [blob,   setBlob]   = useState<Record<string, any> | null>(null)
  const [result, setResult] = useState<{ ok: boolean; recovered: string } | null>(null)
  const [errMsg, setErrMsg] = useState('')

  async function run() {
    setState('loading')
    setErrMsg('')
    try {
      const res = await fetch(`${AGENT_BASE}/api/attest/${encodeURIComponent(attestCID)}`)
      if (!res.ok) throw new Error(`Agent returned ${res.status} — is the agent running?`)
      const data: Record<string, any> = await res.json()
      setBlob(data)

      if (data.mode === 'local-signing' && data.signature && data.signedPayload && data.agentAddress) {
        const recovered = recoverAddress({
          hash:      hashMessage(data.signedPayload),
          signature: data.signature as `0x${string}`,
        })
        const ok = (await recovered).toLowerCase() === (data.agentAddress as string).toLowerCase()
        setResult({ ok, recovered: await recovered })
      }

      setState('done')
    } catch (e: any) {
      setErrMsg(e.message ?? 'Unknown error')
      setState('error')
    }
  }

  const isTEE   = blob?.mode === 'tee-compute'
  const isLocal = blob?.mode === 'local-signing'

  return (
    <div style={{ background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--border)', padding: '20px', marginBottom: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>TEE Attestation Verification</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Downloads attestation blob from 0G Storage · verifies signature client-side</div>
        </div>
        {state === 'idle' && (
          <button onClick={run} style={{ height: 34, padding: '0 16px', borderRadius: 8, border: '1px solid #8B5CF6', background: 'rgba(139,92,246,0.08)', color: '#8B5CF6', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            Run verification →
          </button>
        )}
        {state === 'loading' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
            <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid var(--border)', borderTopColor: '#8B5CF6', animation: 'spin 0.8s linear infinite' }} />
            Fetching from 0G Storage…
          </div>
        )}
        {state === 'done' && result && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 8, background: result.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${result.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}` }}>
            <span style={{ fontSize: 13 }}>{result.ok ? '✓' : '✗'}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: result.ok ? '#22C55E' : '#EF4444' }}>{result.ok ? 'Signature valid' : 'Signature mismatch'}</span>
          </div>
        )}
        {state === 'done' && isTEE && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 8, background: blob?.verified ? 'rgba(34,197,94,0.1)' : 'rgba(245,158,11,0.1)', border: `1px solid ${blob?.verified ? 'rgba(34,197,94,0.3)' : 'rgba(245,158,11,0.3)'}` }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: blob?.verified ? '#22C55E' : '#D97706' }}>{blob?.verified ? '✓ TEE verified' : '⚠ Verification pending'}</span>
          </div>
        )}
        {state === 'error' && (
          <button onClick={run} style={{ fontSize: 11, color: '#EF4444', background: 'none', border: 'none', cursor: 'pointer' }}>Retry</button>
        )}
      </div>

      {state === 'error' && (
        <div style={{ fontSize: 12, color: '#EF4444', background: 'rgba(239,68,68,0.06)', borderRadius: 8, padding: '10px 12px' }}>{errMsg}</div>
      )}

      {state === 'done' && blob && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--background)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.04em' }}>Mode</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: isTEE ? '#8B5CF6' : '#3B82F6' }}>{isTEE ? '0G Compute TEE' : 'Local EIP-191 signing'}</div>
            </div>
            {isTEE && (
              <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--background)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.04em' }}>Model</div>
                <div style={{ fontSize: 12, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{blob.model ?? '—'}</div>
              </div>
            )}
            {isLocal && result && (
              <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--background)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.04em' }}>Recovered address</div>
                <div style={{ fontSize: 11, color: 'var(--text-primary)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>{result.recovered}</div>
              </div>
            )}
          </div>

          {isLocal && blob.agentAddress && (
            <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--background)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.04em' }}>Verification method</div>
              <code style={{ fontSize: 11, color: 'var(--text-primary)', fontFamily: 'monospace', display: 'block', lineHeight: 1.6 }}>
                recoverAddress(hashMessage(signedPayload), signature)<br />
                === {blob.agentAddress}
              </code>
            </div>
          )}

          {isTEE && (blob.signerRaUrl || blob.chatSignatureUrl) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {blob.signerRaUrl && (
                <a href={blob.signerRaUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.2)', textDecoration: 'none' }}>
                  <span style={{ fontSize: 12 }}>🔐</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#8B5CF6' }}>Intel TDX RA Report</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{blob.signerRaUrl}</div>
                  </div>
                  <span style={{ fontSize: 11, color: '#8B5CF6' }}>↗</span>
                </a>
              )}
              {blob.chatSignatureUrl && (
                <a href={blob.chatSignatureUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.2)', textDecoration: 'none' }}>
                  <span style={{ fontSize: 12 }}>✍️</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#8B5CF6' }}>Enclave signature for this decision</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{blob.chatSignatureUrl}</div>
                  </div>
                  <span style={{ fontSize: 11, color: '#8B5CF6' }}>↗</span>
                </a>
              )}
            </div>
          )}

          {blob.decision && (
            <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--background)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>Decision inside attestation</div>
              <div style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.6 }}>
                {isTEE ? (
                  <><strong>{blob.decision.confirmedPool}</strong> · confidence {blob.decision.confidence}%<br />{blob.decision.rationale}</>
                ) : (
                  <><strong>{blob.decision.targetPool ?? blob.decision.action}</strong> · {blob.decision.reason}</>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function VerifyPage({ params, searchParams }: { params: Promise<{ receiptHash: string }>; searchParams: Promise<{ tx?: string }> }) {
  const { receiptHash } = React.use(params)
  const { tx: chainTxHash } = React.use(searchParams)
  const [proof,   setProof]   = useState<ProofData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  useEffect(() => {
    if (!receiptHash) return
    setLoading(true)
    fetchProof(receiptHash)
      .then(p => {
        if (p) setProof(p)
        else setError('No proof found for this receipt hash. The action may not have been anchored yet.')
      })
      .catch(e => setError(`Failed to fetch proof: ${e.message}`))
      .finally(() => setLoading(false))
  }, [receiptHash])

  const accentColor = proof ? actionColor(proof.action) : '#EA580C'

  return (
    <div style={{ minHeight: '100vh', background: 'var(--background)', color: 'var(--text-primary)', fontFamily: 'inherit' }}>
      
      <div style={{ borderBottom: '1px solid var(--border)', padding: '16px 24px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Link href="/app" style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
          <Image src="/logo.svg" alt="YieldGeko" width={22} height={22} />
          <span style={{ fontSize: 16, fontWeight: 800, color: '#EA580C', letterSpacing: '-.02em' }}>yieldgeko</span>
        </Link>
        <span style={{ color: 'var(--border)', fontSize: 18 }}>/</span>
        <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 500 }}>Proof verification</span>
      </div>

      <div style={{ maxWidth: 680, margin: '0 auto', padding: '40px 24px 80px' }}>

        
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8 }}>
            Independent verification
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-.02em', margin: 0, lineHeight: 1.2 }}>
            Execution proof
          </h1>
          <p style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.6 }}>
            Every YieldGeko action is sealed in a 0G Compute TEE, stored on 0G Storage, and anchored on 0G Chain.
            Verify this proof independently — no trust in YieldGeko required.
          </p>
        </div>

        {!loading && proof && (
          <div style={{ marginBottom: 24, padding: '16px 18px', borderRadius: 14, background: 'linear-gradient(180deg, rgba(139,92,246,0.10), rgba(59,130,246,0.06))', border: '1px solid rgba(139,92,246,0.22)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#C4B5FD', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8 }}>
              Why this matters
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.65 }}>
              {proof.attestCID
                ? 'This proof trail shows more than a transaction hash. It links the execution to an attested decision artifact from YieldGeko’s 0G Compute path, where DeepSeek V3 is expected to run inside an Intel TDX + NVIDIA H100 trusted environment, then anchors that evidence on 0G Chain.'
                : 'This proof trail confirms the execution was anchored on 0G Chain and its trace was stored on 0G Storage. This record does not currently include a TEE attestation artifact.'}
            </div>
          </div>
        )}

        
        <div style={{ background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--border)', padding: '12px 16px', marginBottom: 24, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, flexShrink: 0 }}>RECEIPT HASH</span>
          <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {receiptHash}
          </span>
          <CopyBtn value={receiptHash} />
        </div>

        
        {loading && (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', border: '2px solid var(--border)', borderTopColor: '#EA580C', animation: 'spin 1s linear infinite', margin: '0 auto 16px' }} />
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Querying 0G Chain registry…</div>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        
        {!loading && error && (
          <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 12, padding: '20px 24px', color: '#EF4444', fontSize: 14 }}>
            {error}
          </div>
        )}

        
        {!loading && proof && (
          <>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
              <div style={{ padding: '6px 16px', borderRadius: 999, background: `${accentColor}18`, border: `1px solid ${accentColor}30`, fontSize: 13, fontWeight: 700, color: accentColor }}>
                {proof.action}
              </div>
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                {new Date(proof.anchoredAt * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: '#22C55E', fontWeight: 600, background: 'rgba(34,197,94,0.10)', borderRadius: 4, padding: '2px 8px', border: '1px solid rgba(34,197,94,0.2)' }}>
                ✓ Verified on-chain
              </span>
            </div>

            
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>Proof trail</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 32 }}>
              {chainTxHash && (
                <ProofLink
                  label="Anchored on 0G Chain"
                  href={`${CHAIN_SCAN}/tx/${chainTxHash}`}
                  color="#22C55E"
                  icon="⛓"
                />
              )}
              {proof.traceCID && (
                <ProofLink
                  label="Execution trace on 0G Storage"
                  href={`${STORAGE_SCAN}/${proof.traceCID}`}
                  color="#3B82F6"
                  icon="📄"
                />
              )}
              {proof.attestCID && (
                <ProofLink
                  label="TEE attestation on 0G Storage"
                  href={`${STORAGE_SCAN}/${proof.attestCID}`}
                  color="#8B5CF6"
                  icon="🔒"
                />
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 32 }}>
              <div style={{ padding: '14px 16px', borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#22C55E', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
                  0G Chain
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>
                  Public anchor proving this receipt hash and proof references were recorded onchain.
                </div>
              </div>
              <div style={{ padding: '14px 16px', borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#3B82F6', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
                  Trace
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>
                  Execution context stored on 0G Storage so anyone can inspect what the agent saw and did.
                </div>
              </div>
              <div style={{ padding: '14px 16px', borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: proof.attestCID ? '#8B5CF6' : 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
                  TEE
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>
                  {proof.attestCID
                    ? 'Decision artifact tied to the 0G Compute attestation flow for DeepSeek V3 in the trusted execution environment.'
                    : 'No TEE attestation artifact is attached to this execution record.'}
                </div>
              </div>
            </div>

            
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>Details</div>
            <div style={{ background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden', marginBottom: 32 }}>
              {[
                { label: 'User wallet', value: proof.userAddress, mono: true },
                { label: 'Anchored by', value: proof.anchoredBy, mono: true },
                { label: 'Action', value: proof.action, mono: false },
                { label: 'Anchored at', value: new Date(proof.anchoredAt * 1000).toISOString(), mono: true },
                ...(chainTxHash ? [{ label: '0G Chain tx', value: chainTxHash, mono: true }] : []),
                ...(proof.traceCID  ? [{ label: 'Trace CID', value: proof.traceCID,  mono: true }] : []),
                ...(proof.attestCID ? [{ label: 'Attest CID', value: proof.attestCID, mono: true }] : []),
                { label: 'Registry', value: REGISTRY_ADDR, mono: true },
                { label: 'Network', value: '0G Chain — Chain ID 16661', mono: false },
              ].map(({ label, value, mono }, i, arr) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 110, flexShrink: 0 }}>{label}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: mono ? 'monospace' : 'inherit' }}>
                    {value}
                  </span>
                  {mono && <CopyBtn value={value} />}
                </div>
              ))}
            </div>

            {proof.attestCID && <TeeVerificationPanel attestCID={proof.attestCID} />}


            <div style={{ background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--border)', padding: '20px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
                Verify independently
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                <p style={{ margin: '0 0 10px' }}>
                  <strong style={{ color: 'var(--text-primary)' }}>1. Query the registry directly</strong><br />
                  Call <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace' }}>getProof(receiptHash)</code> on
                  {' '}<a href={`${CHAIN_SCAN}/address/${REGISTRY_ADDR}`} target="_blank" rel="noopener noreferrer" style={{ color: '#22C55E' }}>YieldGekoRegistry</a>{' '}
                  using any Ethereum client connected to RPC <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace' }}>https://evmrpc.0g.ai</code>
                </p>
                <p style={{ margin: '0 0 10px' }}>
                  <strong style={{ color: 'var(--text-primary)' }}>2. Fetch the TEE attestation</strong><br />
                  Retrieve the attestation blob from 0G Storage using the <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace' }}>attestCID</code>.
                  The blob contains <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace' }}>signerRaUrl</code> (Intel TDX hardware attestation) and <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace' }}>chatSignatureUrl</code> (enclave signature for this specific decision), which is how YieldGeko links the execution to its DeepSeek V3 compute path.
                </p>
                <p style={{ margin: 0 }}>
                  <strong style={{ color: 'var(--text-primary)' }}>3. Verify the signature</strong><br />
                  <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace' }}>ethers.recoverAddress(hashMessage(responseText), signature) === signingAddress</code>.
                  The signing address comes from the provider's RA report — proving the response originated inside the TEE enclave.
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
