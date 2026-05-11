'use client'

import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAccount } from 'wagmi'
import { WalletAvatar } from '../components/WalletAvatar'
import Image from 'next/image'
import Link from 'next/link'
import { ThemeToggle } from '../components/ThemeToggle'
import GlobalLoading from '../components/GlobalLoading'

// ── Icons ─────────────────────────────────────────────────────────────────────

const IcoPortfolio = () => (
  <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="8" width="3" height="7" rx="1" />
    <rect x="6" y="5" width="3" height="10" rx="1" />
    <rect x="11" y="2" width="3" height="13" rx="1" />
  </svg>
)
const IcoActivity = () => (
  <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <polyline points="1,9 5,5 9,8 15,3" />
    <polyline points="11,3 15,3 15,7" />
  </svg>
)
const IcoStrategy = () => (
  <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="6" />
    <path d="M8 5v3l2 2" />
  </svg>
)
const IcoSettings = () => (
  <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <circle cx="8" cy="8" r="2.5" />
    <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.22 3.22l1.41 1.41M11.36 11.36l1.41 1.41M3.22 12.78l1.41-1.41M11.36 4.64l1.41-1.41" />
  </svg>
)
const IcoSend = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
)
const IcoSwap = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" /><polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" /><line x1="4" y1="4" x2="9" y2="9" />
  </svg>
)
const IcoBridge = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8h1a4 4 0 0 1 0 8h-1" /><path d="M6 8H5a4 4 0 0 0 0 8h1" /><line x1="2" y1="12" x2="22" y2="12" />
  </svg>
)
const IcoEarn = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2v20" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
  </svg>
)
const IcoFund = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" /><path d="M3 5v14a2 2 0 0 0 2 2h16v-5" /><path d="M18 11h4v4h-4z" />
  </svg>
)
const IcoAdd = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="6.5" y1="1" x2="6.5" y2="12" />
    <line x1="1" y1="6.5" x2="12" y2="6.5" />
  </svg>
)
const IcoMenu = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <line x1="3" y1="6" x2="17" y2="6" />
    <line x1="3" y1="10" x2="17" y2="10" />
    <line x1="3" y1="14" x2="17" y2="14" />
  </svg>
)
const IcoClose = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <line x1="3" y1="3" x2="15" y2="15" />
    <line x1="15" y1="3" x2="3" y2="15" />
  </svg>
)
const IcoWallet = () => (
  <svg width="19" height="19" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="5" width="16" height="12" rx="2" />
    <path d="M2 9h16" />
    <circle cx="14.5" cy="13.5" r="1" fill="currentColor" stroke="none" />
  </svg>
)

// ── Wallet avatar ─────────────────────────────────────────────────────────────

// ── Nav item ──────────────────────────────────────────────────────────────────

function NavItem({
  icon, label, active, onClick, mobile = false,
}: { icon: React.ReactNode; label: string; active?: boolean; onClick?: () => void; mobile?: boolean }) {
  if (mobile) {
    return (
      <button onClick={onClick} style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
        flex: 1, padding: '8px 0', border: 'none', background: 'transparent',
        color: active ? '#EA580C' : 'var(--text-muted)', cursor: 'pointer',
        fontFamily: 'inherit', fontSize: 10, fontWeight: active ? 600 : 400,
        transition: 'color 120ms',
      }}>
        <span style={{ opacity: active ? 1 : 0.55 }}>{icon}</span>
        {label}
      </button>
    )
  }
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 14, width: '100%',
      padding: '10px 16px', borderRadius: 12, border: 'none', cursor: 'pointer',
      background: 'transparent',
      color: active ? '#EA580C' : 'var(--text-secondary)',
      fontSize: 15, fontWeight: active ? 600 : 500, fontFamily: 'inherit',
      transition: 'all 120ms', textAlign: 'left',
    }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)' }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)' }}
    >
      <span style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 20, height: 20, opacity: active ? 1 : 0.6,
        color: active ? '#EA580C' : 'inherit'
      }}>
        {icon}
      </span>
      {label}
    </button>
  )
}

// ── Sidebar content (shared between desktop + mobile drawer) ──────────────────

function SidebarContent({
  address, pathname, router, onNav,
}: { address?: string; pathname: string; router: ReturnType<typeof useRouter>; onNav?: () => void }) {
  const shortAddr = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : ''
  const isPortfolio = pathname === '/app'
  const isStrategy = pathname.startsWith('/app/strategy')

  function go(path: string) { router.push(path); onNav?.() }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, padding: '0 8px' }}>

      {/* Logo Area */}
      <div style={{ padding: '24px 16px 20px' }}>
        <Link href="/app" onClick={onNav} style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
          <Image src="/logo.svg" alt="YieldGeko" width={28} height={28} />
          <span style={{ fontSize: 20, fontWeight: 800, color: '#EA580C', letterSpacing: '-.02em' }}>
            yieldgeko
          </span>
        </Link>
      </div>

      {/* Account / Connect State */}
      <div style={{ padding: '0 16px 24px' }}>
        {address ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
            <WalletAvatar address={address} size={40} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {shortAddr}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>$1,240.50</div>
            </div>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.4 }}>
              <path d="M3 4.5L6 7.5L9 4.5" />
            </svg>
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.2 }}>Welcome to YieldGeko</div>
            <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.4 }}>Your autonomous yield agent for everything onchain</div>
            <button
              onClick={() => go('/onboard')}
              style={{
                marginTop: 20, width: '100%', height: 44, borderRadius: 12,
                background: '#EA580C', border: 'none', color: '#fff',
                fontSize: 15, fontWeight: 700, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                fontFamily: 'inherit',
              }}
            >
              <IcoAdd /> Connect Wallet
            </button>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, padding: '0 4px' }}>
        <NavItem icon={<IcoPortfolio />} label="Overview" active={isPortfolio} onClick={() => go('/app')} />
        <NavItem icon={<IcoStrategy />} label="Explore" active={isStrategy} onClick={() => address ? go(`/app/strategy/${address}`) : go('/onboard')} />
        <NavItem icon={<IcoActivity />} label="Rewards" active={false} onClick={() => go('/app')} />
        <NavItem icon={<IcoSettings />} label="Favorites" onClick={() => go('/onboard')} />
        <div style={{ height: 1, background: 'var(--border)', margin: '12px 16px', opacity: 0.5 }} />
        <NavItem icon={<IcoSend />} label="Send" onClick={() => go('/onboard')} />
        <NavItem icon={<IcoSwap />} label="Swap" onClick={() => go('/onboard')} />
        <NavItem icon={<IcoBridge />} label="Bridge" onClick={() => go('/onboard')} />
        <NavItem icon={<IcoEarn />} label="Earn" onClick={() => go('/onboard')} />
        <NavItem icon={<IcoFund />} label="Fund" onClick={() => go('/onboard')} />
        <NavItem icon={<IcoSettings />} label="Settings" onClick={() => go('/onboard')} />
      </nav>

      {/* Bottom Widgets */}
      <div style={{ padding: '16px 12px 16px', marginTop: 'auto' }}>
        {/* Premium Banner */}
        <div style={{
          height: 48, borderRadius: 12, marginBottom: 12, cursor: 'pointer',
          background: 'linear-gradient(135deg, #EA580C, #EC4899)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          color: '#fff', fontSize: 14, fontWeight: 700, boxShadow: '0 4px 12px rgba(234,88,12,0.2)'
        }}>
          <span style={{ fontSize: 16 }}>💎</span> premium
        </div>

        {/* Download Widget */}
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 12, padding: '10px 16px', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', marginBottom: 12
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>Download</span>
          <div style={{ display: 'flex', gap: 10, opacity: 0.7 }}>
            <span></span>
            <span>▶</span>
            <span>🌐</span>
          </div>
        </div>

        <div style={{ textAlign: 'center' }}>
          <Link href="#" style={{ fontSize: 11, color: '#3B82F6', textDecoration: 'none', fontWeight: 600 }}>
            Build with YieldGeko API
          </Link>
        </div>
      </div>
    </div>
  )
}

// ── Layout ────────────────────────────────────────────────────────────────────

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const { address } = useAccount()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)

  // Expose a way to trigger loading globally for demo purposes
  useEffect(() => {
    (window as any).setGlobalLoading = setIsProcessing
  }, [])

  // Close drawer on route change
  useEffect(() => { setDrawerOpen(false) }, [pathname])

  // Lock body scroll when drawer open on mobile
  useEffect(() => {
    if (drawerOpen) { document.body.style.overflow = 'hidden' }
    else { document.body.style.overflow = '' }
    return () => { document.body.style.overflow = '' }
  }, [drawerOpen])

  const isPortfolio = pathname === '/app'
  const isStrategy = pathname.startsWith('/app/strategy')

  return (
    <>
      <GlobalLoading show={isProcessing} />
      {/* ── Responsive styles ─────────────────────────────────────────── */}
      <style>{`
        .app-layout-sidebar {
          width: 260px;
          height: 100vh;
          position: fixed;
          left: 0; top: 0;
          z-index: 100;
          background: var(--background);
          border-right: 1px solid var(--border);
          display: flex;
          flex-direction: column;
        }
        .app-layout-main {
          margin-left: 260px;
          flex: 1;
          min-height: 100vh;
          display: flex;
          flex-direction: column;
        }
        .app-content-wrapper {
          flex: 1;
          width: 100%;
          max-width: 1000px;
          margin: 0 auto;
          padding: 0 20px;
          display: flex;
          flex-direction: column;
        }
        .app-mobile-topbar { display: none; }
        .app-mobile-bottomnav { display: none; }
        .app-drawer-overlay { display: none; }

        @media (max-width: 1024px) {
          .app-layout-sidebar { display: none; }
          .app-layout-main { margin-left: 0; padding-right: 0; padding-bottom: 20px; }
          .app-content-wrapper { padding: 0 16px; max-width: 100%; }
          .app-mobile-topbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            height: 52px;
            padding: 0 16px;
            border-bottom: 1px solid var(--border);
            background: var(--background);
            position: sticky; top: 0; z-index: 110;
          }
          .app-mobile-bottomnav { display: none; }
          .app-drawer-overlay {
            display: block;
            position: fixed;
            inset: 0;
            z-index: 200;
            pointer-events: none;
          }
          .app-drawer-overlay.open { pointer-events: all; }
          .app-drawer-backdrop {
            position: absolute; inset: 0;
            background: rgba(0,0,0,0.55);
            opacity: 0;
            transition: opacity 240ms;
          }
          .app-drawer-overlay.open .app-drawer-backdrop { opacity: 1; }
          .app-drawer-panel {
            position: absolute;
            top: 0; left: 0; bottom: 0;
            width: 260px;
            background: var(--background);
            border-right: 1px solid var(--border);
            transform: translateX(-100%);
            transition: transform 240ms cubic-bezier(0.16,1,0.3,1);
            overflow-y: auto;
          }
          .app-drawer-overlay.open .app-drawer-panel { transform: translateX(0); }
        }
      `}</style>

      <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--background)' }}>

        {/* ── Desktop sidebar ──────────────────────────────────────────── */}
        <aside className="app-layout-sidebar">
          <SidebarContent address={address} pathname={pathname} router={router} />
        </aside>

        {/* ── Mobile drawer (overlay) ──────────────────────────────────── */}
        <div className={`app-drawer-overlay${drawerOpen ? ' open' : ''}`}>
          <div className="app-drawer-backdrop" onClick={() => setDrawerOpen(false)} />
          <div className="app-drawer-panel">
            {/* Close button inside drawer */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 14px 0' }}>
              <button
                onClick={() => setDrawerOpen(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}
              >
                <IcoClose />
              </button>
            </div>
            <SidebarContent address={address} pathname={pathname} router={router} onNav={() => setDrawerOpen(false)} />
          </div>
        </div>

        {/* ── Main area ────────────────────────────────────────────────── */}
        <div className="app-layout-main">

          {/* Mobile top bar */}
          <div className="app-mobile-topbar">
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <button
                onClick={() => setDrawerOpen(true)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', padding: 0, display: 'flex' }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></svg>
              </button>
              <Image src="/logo.svg" alt="YieldGeko" width={24} height={24} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
              <button style={{ background: 'none', border: 'none', color: 'var(--text-primary)', opacity: 0.7, padding: 0 }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg></button>
              <button style={{ background: 'none', border: 'none', color: 'var(--text-primary)', opacity: 0.7, padding: 0 }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg></button>
              {address ? (
                <WalletAvatar address={address} size={28} />
              ) : (
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--surface)' }} />
              )}
            </div>
          </div>

          {/* Page content */}
          <main className="app-content-wrapper">
            {children}
          </main>

          {/* Mobile bottom nav */}
          <nav className="app-mobile-bottomnav">
            {[
              { icon: <IcoPortfolio />, label: 'Portfolio', active: isPortfolio, onClick: () => router.push('/app') },
              { icon: <IcoStrategy />, label: 'Strategy', active: isStrategy, onClick: () => address ? router.push(`/app/strategy/${address}`) : router.push('/onboard') },
              { icon: <IcoWallet />, label: 'Wallet', active: false, onClick: () => router.push('/onboard') },
              { icon: <IcoSettings />, label: 'Settings', active: false, onClick: () => router.push('/onboard') },
            ].map(item => (
              <NavItem key={item.label} {...item} mobile />
            ))}
          </nav>
        </div>
      </div>
    </>
  )
}
