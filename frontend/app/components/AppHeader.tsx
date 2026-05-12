'use client'

import React from 'react'

export const AppHeader = () => {
  return (
    <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 24 }}>
      {/* Search Bar */}
      <div style={{ 
        flex: 1, 
        position: 'relative',
        display: 'flex',
        alignItems: 'center'
      }}>
        <input 
          type="text" 
          placeholder="Asset, wallet, domain or identity"
          style={{
            width: '100%',
            height: 38,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '0 40px 0 16px',
            fontSize: 14,
            color: 'var(--text-primary)',
            outline: 'none',
            fontFamily: 'inherit'
          }}
        />
        <div style={{
          position: 'absolute',
          right: 12,
          width: 20,
          height: 20,
          background: 'rgba(128,128,128,0.08)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          fontWeight: 700,
          color: 'var(--text-muted)'
        }}>
          F
        </div>
      </div>

      {/* Right Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {/* Star */}
        <button style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-muted)' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </button>

        {/* Gas */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 22L17 22"/><path d="M4 9L16 9"/><path d="M14 22L14 11"/><path d="M20 22L20 7"/><path d="M9 22L9 4"/><path d="M20 7C20 4.23858 17.7614 2 15 2C12.2386 2 10 4.23858 10 7V22"/></svg>
          2
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </div>

        {/* Currency */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 }}>
          USD
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </div>

        {/* Help */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: 'var(--text-primary)' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          <div style={{ 
            position: 'absolute', 
            top: -2, 
            right: 12, 
            width: 8, 
            height: 8, 
            borderRadius: '50%', 
            background: '#3B82F6',
            border: '2px solid var(--background)'
          }} />
        </div>

        {/* Privacy Eye */}
        <button style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-primary)' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
    </div>
  )
}
