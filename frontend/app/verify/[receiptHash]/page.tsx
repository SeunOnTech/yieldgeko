'use client'

import React, { useState, useEffect } from 'react'
import Image from 'next/image'
import Link from 'next/link'

// ── 0G Chain config ───────────────────────────────────────────────────────────

const ZG_RPC        = 'https://evmrpc.0g.ai'
const REGISTRY_ADDR = '0xd7185a3Aa4b23EBE84e7bd60CF5e78B71dd21c8e'
const CHAIN_SCAN    = 'https://chainscan.0g.ai'
const STORAGE_SCAN  = 'https://storagescan.0g.ai/submission'

// Minimal ABI-encoded call to getProof(bytes32)
// Function selector: keccak256("getProof(bytes32)")[0:4] = 0x9f90dee0
async function fetchProof(receiptHash: string): Promise<ProofData | null> {
  // Pad receiptHash to 32 bytes
  const hash = receiptHash.startsWith('0x') ? receiptHash.slice(2) : receiptHash
  const padded = hash.padStart(64, '0')
  const data = `0x9f90dee0${padded}`

  const res = await fetch(ZG_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: REGISTRY_ADDR, data }, 'latest'],
    }),
  })
  const json = await res.json()
  if (!json.result || json.result === '0x') return null

  // Decode ABI-encoded Proof struct
  // Layout: receiptHash(32) userAddress(32) anchoredBy(32) strategyId(32)
  //         action_offset(32) traceCID_offset(32) attestCID_offset(32) anchoredAt(32)
  //         then dynamic string data
  return decodeProof(json.result, receiptHash)
}

function decodeProof(hex: string, originalHash: string): ProofData | null {
  try {
    const data = hex.startsWith('0x') ? hex.slice(2) : hex
    const readWord = (offset: number) => data.slice(offset * 64, offset * 64 + 64)
    const readAddr  = (offset: number) => '0x' + readWord(offset).slice(24)
    const readUint  = (offset: number) => parseInt(readWord(offset), 16)
    const readStr   = (baseOffset: number, strOffset: number) => {
      const start = (strOffset / 32) * 64
      const len   = parseInt(data.slice(start, start + 64), 16)
      const bytes = data.slice(start + 64, start + 64 + len * 2)
      return Buffer.from(bytes, 'hex').toString('utf8')
    }

    const userAddress  = readAddr(1)
    const anchoredBy   = readAddr(2)
    const actionOff    = readUint(4)
    const traceCIDOff  = readUint(5)
    const attestCIDOff = readUint(6)
    const anchoredAt   = readUint(7)

    const action    = readStr(4, actionOff)
    const traceCID  = readStr(5, traceCIDOff)
    const attestCID = readStr(6, attestCIDOff)

    if (!anchoredAt) return null

    return { receiptHash: originalHash, userAddress, anchoredBy, action, traceCID, attestCID, anchoredAt }
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
}

// ── UI helpers ────────────────────────────────────────────────────────────────

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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function VerifyPage({ params }: { params: Promise<{ receiptHash: string }> }) {
  const { receiptHash } = React.use(params)
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
      {/* Header */}
      <div style={{ borderBottom: '1px solid var(--border)', padding: '16px 24px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Link href="/app" style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
          <Image src="/logo.svg" alt="YieldGeko" width={22} height={22} />
          <span style={{ fontSize: 16, fontWeight: 800, color: '#EA580C', letterSpacing: '-.02em' }}>yieldgeko</span>
        </Link>
        <span style={{ color: 'var(--border)', fontSize: 18 }}>/</span>
        <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 500 }}>Proof verification</span>
      </div>

      <div style={{ maxWidth: 680, margin: '0 auto', padding: '40px 24px 80px' }}>

        {/* Title */}
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

        {/* Receipt hash */}
        <div style={{ background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--border)', padding: '12px 16px', marginBottom: 24, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, flexShrink: 0 }}>RECEIPT HASH</span>
          <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {receiptHash}
          </span>
          <CopyBtn value={receiptHash} />
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', border: '2px solid var(--border)', borderTopColor: '#EA580C', animation: 'spin 1s linear infinite', margin: '0 auto 16px' }} />
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Querying 0G Chain registry…</div>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 12, padding: '20px 24px', color: '#EF4444', fontSize: 14 }}>
            {error}
          </div>
        )}

        {/* Proof data */}
        {!loading && proof && (
          <>
            {/* Action badge */}
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

            {/* Proof links */}
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>Proof trail</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 32 }}>
              <ProofLink
                label="Anchored on 0G Chain"
                href={`${CHAIN_SCAN}/tx/${proof.receiptHash}`}
                color="#22C55E"
                icon="⛓"
              />
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

            {/* Metadata */}
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>Details</div>
            <div style={{ background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden', marginBottom: 32 }}>
              {[
                { label: 'User wallet', value: proof.userAddress, mono: true },
                { label: 'Anchored by', value: proof.anchoredBy, mono: true },
                { label: 'Action', value: proof.action, mono: false },
                { label: 'Anchored at', value: new Date(proof.anchoredAt * 1000).toISOString(), mono: true },
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

            {/* Independent verification instructions */}
            <div style={{ background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--border)', padding: '20px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
                Verify independently
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                <p style={{ margin: '0 0 10px' }}>
                  <strong style={{ color: 'var(--text-primary)' }}>1. Query the registry directly</strong><br />
                  Call <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace' }}>getProof(receiptHash)</code> on
                  {' '}<a href={`${CHAIN_SCAN}/address/${REGISTRY_ADDR}`} target="_blank" rel="noopener noreferrer" style={{ color: '#22C55E' }}>YieldGekoRegistry</a>{' '}
                  using any Ethereum client connected to RPC <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace' }}>https://evmrpc.0g.ai</code>.
                </p>
                <p style={{ margin: '0 0 10px' }}>
                  <strong style={{ color: 'var(--text-primary)' }}>2. Fetch the TEE attestation</strong><br />
                  Retrieve the attestation blob from 0G Storage using the <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace' }}>attestCID</code>.
                  The blob contains <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace' }}>signerRaUrl</code> (Intel TDX hardware attestation) and <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace' }}>chatSignatureUrl</code> (enclave signature for this specific decision).
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
