'use client'

import Link from 'next/link'
import AgentFlow from '../../components/AgentFlow'

export default function OnboardPage() {
  return (
    <div style={{ position: 'relative' }}>
      <AgentFlow mode="onboard" />
      <div style={{
        position: 'fixed', bottom: 28, left: '50%', transform: 'translateX(-50%)',
        zIndex: 200, display: 'flex', alignItems: 'center', gap: 8,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 100, padding: '8px 18px 8px 14px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ opacity: 0.4 }}>
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Not ready to connect?</span>
        <Link href="/app/explore" style={{
          fontSize: 12, fontWeight: 700, color: '#EA580C', textDecoration: 'none',
          paddingLeft: 4,
        }}>
          Browse Explore →
        </Link>
      </div>
    </div>
  )
}
