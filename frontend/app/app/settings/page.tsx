'use client'

import React, { useMemo, useState } from 'react'
import { useHeader } from '../../components/HeaderContext'
import { AppHeader } from '../../components/AppHeader'

const IcoChevronRight = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3 }}>
    <polyline points="9 18 15 12 9 6" />
  </svg>
)

const IcoDelegation = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
)

const IcoExport = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
)

const IcoImport = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
)

const IcoGlobe = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
)

const Toggle = ({ active, onToggle }: { active: boolean; onToggle: () => void }) => (
  <div 
    onClick={onToggle}
    style={{
      width: 44,
      height: 24,
      borderRadius: 12,
      background: active ? '#000000' : 'var(--border)',
      position: 'relative',
      cursor: 'pointer',
      transition: 'background 0.2s ease',
      flexShrink: 0
    }}
  >
    <div style={{
      width: 20,
      height: 20,
      borderRadius: '50%',
      background: '#FFFFFF',
      position: 'absolute',
      top: 2,
      left: active ? 22 : 2,
      transition: 'left 0.2s cubic-bezier(0.2, 0, 0, 1)',
      boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
    }} />
  </div>
)

const Select = ({ value, icon }: { value: string; icon?: React.ReactNode }) => (
  <div style={{
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderRadius: 8,
    background: 'var(--secondary)',
    border: '1px solid var(--border)',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
    minWidth: 120,
    justifyContent: 'space-between'
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {icon}
      {value}
    </div>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  </div>
)

const SettingRow = ({ label, children, description }: { label: string; children: React.ReactNode; description?: string }) => (
  <div style={{
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: '16px 0',
    gap: 24
  }}>
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 16, fontWeight: 500, color: 'var(--text-primary)' }}>{label}</div>
      {description && <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>{description}</div>}
    </div>
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {children}
    </div>
  </div>
)

export default function SettingsPage() {
  const header = useMemo(() => <AppHeader />, [])
  useHeader(header)

  const [theme, setTheme] = useState<'light' | 'system' | 'dark'>('light')
  const [minimalAnalytics, setMinimalAnalytics] = useState(true)
  const [usageAnalytics, setUsageAnalytics] = useState(true)
  const [strategyNotifications, setStrategyNotifications] = useState(true)

  return (
    <div style={{ 
      maxWidth: 800, 
      margin: '0 auto', 
      padding: '40px 0',
      fontFamily: 'inherit'
    }}>
      <h1 style={{ 
        fontSize: 40, 
        fontWeight: 700, 
        marginBottom: 48,
        letterSpacing: '-0.03em',
        color: 'var(--text-primary)'
      }}>
        Settings
      </h1>

      
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <SettingRow label="Theme">
          <div style={{
            display: 'flex',
            background: 'var(--secondary)',
            padding: 4,
            borderRadius: 12,
            border: '1px solid var(--border)'
          }}>
            {(['Light', 'System', 'Dark'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTheme(t.toLowerCase() as any)}
                style={{
                  padding: '6px 16px',
                  borderRadius: 8,
                  border: 'none',
                  background: theme === t.toLowerCase() ? 'var(--surface)' : 'transparent',
                  color: theme === t.toLowerCase() ? 'var(--text-primary)' : 'var(--text-muted)',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  boxShadow: theme === t.toLowerCase() ? '0 2px 8px rgba(0,0,0,0.08)' : 'none'
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </SettingRow>

        <SettingRow label="Network">
          <Select value="Arbitrum" icon={<IcoGlobe />} />
        </SettingRow>

        <SettingRow label="Display Currency">
          <Select
            value="USD"
            icon={<span style={{ fontSize: 14 }}>🇺🇸</span>}
          />
        </SettingRow>
      </div>

      
      <div style={{
        marginTop: 12,
        padding: '20px 24px',
        background: 'var(--background)',
        border: '1px solid var(--border)',
        borderRadius: 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        cursor: 'pointer',
        transition: 'background 0.2s ease'
      }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
      onMouseLeave={e => e.currentTarget.style.background = 'var(--background)'}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            background: 'var(--surface)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-primary)'
          }}>
            <IcoDelegation />
          </div>
          <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>Active Delegations</span>
        </div>
        <IcoChevronRight />
      </div>

      
      <div style={{ marginTop: 64 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 24, color: 'var(--text-primary)' }}>Privacy</h2>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          <SettingRow
            label="Minimal Analytics"
            description="Basic anonymous data helps us understand how the agent performs across strategies. Your wallet addresses, delegation signatures, and transaction hashes are never sent to analytics."
          >
            <Toggle active={minimalAnalytics} onToggle={() => setMinimalAnalytics(!minimalAnalytics)} />
          </SettingRow>

          <SettingRow
            label="Usage Analytics"
            description="Helps us improve pool selection, rebalance timing, and slippage estimates. All data is anonymous — your on-chain positions, yields, and strategy details are never shared."
          >
            <Toggle active={usageAnalytics} onToggle={() => setUsageAnalytics(!usageAnalytics)} />
          </SettingRow>

          <SettingRow
            label="Strategy Notifications"
            description="Receive in-app notifications when the agent executes an action on your behalf — GENESIS, MIGRATE, REBALANCE, or SAFETY_EXIT. Always includes the 0G proof link for independent verification."
          >
            <Toggle active={strategyNotifications} onToggle={() => setStrategyNotifications(!strategyNotifications)} />
          </SettingRow>
        </div>
      </div>

      
      <div style={{ marginTop: 64 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 12, color: 'var(--text-primary)' }}>Data Export</h2>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 24 }}>
          <div style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 24 }}>
            Export your strategy history, 0G proof trail, and yield performance as a JSON file. Useful for tax reporting or auditing agent activity.
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <button style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '12px 24px',
              borderRadius: 12,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--text-primary)',
              cursor: 'pointer',
              transition: 'background 0.2s ease'
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--background)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--surface)'}
            >
              <IcoExport />
              Export Strategy Data
            </button>
            <button style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '12px 24px',
              borderRadius: 12,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--text-primary)',
              cursor: 'pointer',
              transition: 'background 0.2s ease'
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--background)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--surface)'}
            >
              <IcoImport />
              Import Backup
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
