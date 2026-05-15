'use client'

import React, { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useConnect } from 'wagmi'
import { useAppKit } from '@reown/appkit/react'
import { useLoginWithOAuth, useLoginWithEmail, useLoginWithTelegram } from '@privy-io/react-auth'
import { useHeader } from '../../components/HeaderContext'
import { AppHeader } from '../../components/AppHeader'
import styles from './connect.module.css'

const Icons = {
  MetaMask: () => (
    <svg width="40" height="40" viewBox="0 0 320 320" fill="none">
      <path d="M299.7 41L173.3 125.7L154.2 46.1L299.7 41Z" fill="#E17726" />
      <path d="M20.3 41L146.7 125.7L165.8 46.1L20.3 41Z" fill="#E17726" />
      <path d="M266.3 227.1L239.5 281.3L161.4 227.1L266.3 227.1Z" fill="#E17726" />
      <path d="M53.7 227.1L80.5 281.3L158.6 227.1L53.7 227.1Z" fill="#E17726" />
      <path d="M110.1 169.5L80.5 227.1L153.2 181.7L110.1 169.5Z" fill="#E17726" />
      <path d="M209.9 169.5L239.5 227.1L166.8 181.7L209.9 169.5Z" fill="#E17726" />
      <path d="M160 120.5L203.1 169.5L160 181.7L116.9 169.5L160 120.5Z" fill="#F6851B" />
      <path d="M153.2 181.7L160 216.5L166.8 181.7L160 181.7H153.2Z" fill="#F6851B" />
    </svg>
  ),
  Backpack: () => (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20V10a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v10" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      <circle cx="12" cy="13" r="2" />
    </svg>
  ),
  YieldGeko: () => (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
      <rect width="40" height="40" rx="10" fill="#EA580C" />
      <path d="M10 12H30V15L10 25V12Z" fill="white" />
      <path d="M10 28H30V25L10 15V28Z" fill="white" fillOpacity="0.6" />
    </svg>
  ),
  WalletConnect: () => (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="12" fill="#3396FF" fillOpacity="0.1" />
      <path d="M16.142 9.124c-2.288-2.288-6.002-2.288-8.29 0l-.41.41a.214.214 0 000 .302l.74.74a.214.214 0 00.301 0l.41-.41c1.455-1.455 3.82-1.455 5.275 0l.435.435a.214.214 0 00.302 0l.74-.74a.214.214 0 000-.301l-.435-.436h.032zm3.327 3.327l-.84.84a.214.214 0 000 .302l3.208 3.208a.214.214 0 00.302 0l.84-.84a.214.214 0 000-.302l-3.208-3.208a.214.214 0 00-.302 0zM4.53 12.451a.214.214 0 00-.302 0L1.021 15.66a.214.214 0 000 .302l.84.84a.214.214 0 00.302 0l3.208-3.208a.214.214 0 000-.302l-.84-.84zm7.47 1.838c-.763 0-1.481.297-2.02.836l-.382.382a.214.214 0 000 .302l.74.74a.214.214 0 00.302 0l.382-.382a.857.857 0 011.212 0l.407.407a.214.214 0 00.302 0l.74-.74a.214.214 0 000-.302l-.407-.407a2.855 2.855 0 00-1.276-.836z" fill="#3396FF" />
      <path d="M12 8c-2.21 0-4.21.89-5.66 2.34l-.41.41c-.08.08-.08.21 0 .29l.74.74c.08.08.21.08.29 0l.41-.41C8.65 10.1 10.22 9.5 12 9.5s3.35.6 4.63 1.87l.44.44c.08.08.21.08.29 0l.74-.74c.08-.08.08-.21 0-.29l-.44-.44C16.21 8.89 14.21 8 12 8z" fill="#3396FF" />
    </svg>
  ),
  Ledger: () => (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" />
      <path d="M9 4v16M15 4v16M4 10h16M4 14h16" stroke="currentColor" opacity="0.3" />
      <rect x="11" y="9" width="2" height="6" rx="1" fill="currentColor" />
    </svg>
  ),
  Google: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-1 .67-2.28 1.07-3.71 1.07-2.85 0-5.27-1.92-6.13-4.51H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.87 14.13c-.22-.67-.35-1.39-.35-2.13s.13-1.46.35-2.13V7.03H2.18C1.43 8.53 1 10.21 1 12s.43 3.47 1.18 4.97l3.69-2.84z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.03l3.69 2.84c.86-2.59 3.28-4.51 6.13-4.51z" fill="#EA4335" />
    </svg>
  ),
  Telegram: () => (
    <svg width="24" height="24" viewBox="0 0 240 240">
      <defs>
        <linearGradient id="tg-grad" x1="120" y1="0" x2="120" y2="240" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2AABEE" />
          <stop offset="1" stopColor="#229ED9" />
        </linearGradient>
      </defs>
      <circle cx="120" cy="120" r="120" fill="url(#tg-grad)" />
      <path d="M98 175c-3.9 0-3.2-1.5-4.6-5.2L82 132.2 174.6 78l5.4 2-4.5 28.8L98 175z" fill="#C8DAEA" />
      <path d="M98 175c3 0 4.3-1.4 6-3l16-15.6-20-12L98 175z" fill="#A9C9DD" />
      <path d="M100 144.4l48.4 35.7c5.5 3 9.5 1.5 10.9-5.1l19.7-92.8c2-8.1-3.1-11.7-8.4-9.3L60 117.5c-7.9 3.2-7.8 7.6-1.4 9.5l26.6 8.3 61.5-38.8c2.9-1.8 5.6-.8 3.4 1.1L100 144.4z" fill="#fff" />
    </svg>
  ),
  X: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  ),
  Discord: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037 19.736 19.736 0 0 0-4.885 1.515.069.069 0 0 0-.032.027C.533 9.048-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  )
}

export default function ConnectPage() {
  const router = useRouter()
  const { address } = useAccount()
  const { open } = useAppKit()
  const { connectors, connect } = useConnect()
  const [trackAddress, setTrackAddress] = useState('')
  const { initOAuth } = useLoginWithOAuth()
  const { sendCode } = useLoginWithEmail()
  const { login: loginWithTelegram } = useLoginWithTelegram()

  useHeader(<AppHeader />)

  
  React.useEffect(() => {
    if (address) {
      router.push('/app')
    }
  }, [address, router])

  const handleWalletClick = (walletName: string) => {
    
    if (walletName === 'WalletConnect') {
      open()
      return
    }

    
    const connector = connectors.find(c => {
      const name = c.name.toLowerCase()
      const id = c.id.toLowerCase()
      
      if (walletName === 'MetaMask') return name.includes('metamask') || id.includes('metamask')
      if (walletName === 'Backpack') return name.includes('backpack') || id.includes('backpack')
      if (walletName === 'Ledger') return id.includes('ledger')
      return false
    })

    if (connector) {
      connect({ connector })
    } else {
      
      open()
    }
  }

  const wallets = [
    { name: 'MetaMask', icon: Icons.MetaMask, id: 'metamask' },
    { name: 'Backpack', icon: Icons.Backpack, id: 'backpack' },
    { name: 'YieldGeko Wallet', icon: Icons.YieldGeko, id: 'yieldgeko' },
    { name: 'WalletConnect', icon: Icons.WalletConnect, id: 'walletconnect' },
    { name: 'Ledger', icon: Icons.Ledger, id: 'ledger' },
  ]

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Connect to YieldGeko</h1>

      <div className={styles.grid}>
        {wallets.map((wallet) => {
          
          const connector = connectors.find(c => {
            const name = c.name.toLowerCase()
            const id = c.id.toLowerCase()
            if (wallet.name === 'MetaMask') return name.includes('metamask') || id.includes('metamask')
            if (wallet.name === 'Backpack') return name.includes('backpack') || id.includes('backpack')
            if (wallet.name === 'WalletConnect') return id.includes('walletconnect')
            if (wallet.name === 'Ledger') return id.includes('ledger') || id.includes('walletconnect')
            return false
          })

          return (
            <button 
              key={wallet.name} 
              className={styles.walletOption} 
              onClick={() => handleWalletClick(wallet.name)}
            >
              <div className={styles.walletIcon}>
                {connector?.icon ? (
                  <img src={connector.icon} alt={wallet.name} width="40" height="40" />
                ) : (
                  <wallet.icon />
                )}
              </div>
              <span className={styles.walletName}>{wallet.name}</span>
            </button>
          )
        })}
      </div>

      <div className={styles.promoBanner} style={{ display: 'none' }}>
        <div className={styles.promoIcon}>
          <Icons.YieldGeko />
        </div>
        <div className={styles.promoContent}>
          <div className={styles.promoTitle}>Get YieldGeko Wallet</div>
          <div className={styles.promoSub}>Available on Mobile & Browser</div>
        </div>
        <button className={styles.downloadBtn}>Download</button>
      </div>

      <div className={styles.divider}>
        <div className={styles.dividerLine} />
        <span className={styles.dividerText}>Or connect with</span>
        <div className={styles.dividerLine} />
      </div>

      <div className={styles.socialSection}>
        <div className={styles.socialGrid}>
          <button className={styles.socialBtn} onClick={() => initOAuth({ provider: 'google' })}>
            <Icons.Google />
            <span>Google</span>
          </button>
          <button className={styles.socialBtn} onClick={() => loginWithTelegram()}>
            <Icons.Telegram />
            <span>Telegram</span>
          </button>
          <button className={styles.socialBtn} onClick={() => initOAuth({ provider: 'twitter' })}>
            <Icons.X />
            <span>X</span>
          </button>
          <button className={styles.socialBtn} onClick={() => initOAuth({ provider: 'discord' })}>
            <Icons.Discord />
            <span>Discord</span>
          </button>
        </div>

        <div className={styles.emailGroup}>
          <input
            className={styles.emailInput}
            placeholder="name@email.com"
            value={trackAddress}
            onChange={(e) => setTrackAddress(e.target.value)}
          />
          <button className={styles.emailSubmitBtn} onClick={() => trackAddress && sendCode({ email: trackAddress })}>Continue</button>
        </div>
      </div>

      <div className={styles.footer}>
        <div className={styles.footerTitle}>Non-Custodial & Secure</div>
        <div className={styles.footerText}>
          You control your funds and private keys.<br />
          No cross-associating of wallet addresses.
        </div>
      </div>
    </div>
  )
}
