'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import styles from './page.module.css'
import { ThemeToggle } from './components/ThemeToggle'
import { useAccount } from 'wagmi'
import { useAppKit } from '@reown/appkit/react'
import { IntelligentFlow } from './components/IntelligentFlow'

function ArrowNE({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
    >
      
      <line x1="7" y1="17" x2="17" y2="7" />
      
      <polyline points="7 7 17 7 17 17" />
    </svg>
  );
}

export default function Landing() {

  const router = useRouter()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [bannerVisible, setBannerVisible] = useState(true)

  const { isConnected } = useAccount()
  const { open } = useAppKit()
  const [pendingOnboard, setPendingOnboard] = useState(false)

  
  useEffect(() => {
    if (isConnected && pendingOnboard) {
      setPendingOnboard(false)
      router.push('/app')
    }
  }, [isConnected, pendingOnboard, router])

  const handleStartEarning = () => {
    if (isConnected) {
      router.push('/app')
    } else {
      setPendingOnboard(true)
      open()
    }
  }
  return (
    <div className={styles.landingWrapper}>

      
      {bannerVisible && (
        <div className={styles['promo-banner']}>
          <div className={`${styles.container} ${styles['banner-content']}`}>
            <a href="#" className={styles['banner-link']}>
              YieldGeko is live on Arbitrum and 0G. Your autonomous agent earns yield 24/7 — cryptographically bound by rules only you sign.
              <span className={styles.arrow}>&rarr;</span>
            </a>
            <button
              className={styles['close-banner']}
              aria-label="Close banner"
              onClick={() => setBannerVisible(false)}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M1 1L13 13M1 13L13 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
      )}

      
      <header className={styles.header}>
        <div className={`${styles.container} ${styles['header-container']}`}>

          
          <div className={styles.logo}>
            <Image src="/logo.svg" alt="YieldGeko" width={36} height={36} style={{ borderRadius: 8 }} />
            <span className={styles['logo-text']}>YieldGeko</span>
          </div>

          
          <nav className={styles.nav}>
            <ul className={styles['nav-list']}>
              <li><a href="#features" className={styles['nav-link']}>How it works</a></li>
              <li><a href="#protocols" className={styles['nav-link']}>Protocols</a></li>
            </ul>
          </nav>

          
          <div className={styles['header-actions']}>
            <ThemeToggle />
            <button
              onClick={handleStartEarning}
              className={`${styles.btn} ${styles['btn-primary']} ${styles['nav-cta']}`}
            >
                  Deploy Agent <ArrowNE />
            </button>

            
            <button
              className={`${styles['mobile-menu-toggle']} ${mobileMenuOpen ? styles.active : ''}`}
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label="Toggle menu"
            >
              <span className={styles['hamburger-line']} />
              <span className={styles['hamburger-line']} />
              <span className={styles['hamburger-line']} />
            </button>
          </div>
        </div>

        
        <div className={`${styles['mobile-menu']} ${mobileMenuOpen ? styles.active : ''}`}>
          <ul className={styles['mobile-nav-list']}>
            <li><a href="#features" className={styles['mobile-nav-link']} onClick={() => setMobileMenuOpen(false)}>How it works</a></li>
            <li><a href="#protocols" className={styles['mobile-nav-link']} onClick={() => setMobileMenuOpen(false)}>Protocols</a></li>
          </ul>
          <button onClick={handleStartEarning} className={`${styles.btn} ${styles['btn-primary']} ${styles['btn-full']}`}>
            Deploy Agent <ArrowNE />
          </button>
        </div>
      </header>

      <main>

        
        <section className={styles.hero}>

          
          <div className={styles['grid-background']}>
            {Array.from({ length: 100 }, (_, i) => {
              const tinted      = [1, 10, 15, 23, 34, 47, 52, 68, 75, 82, 91, 99]
              const tintedFull  = [5, 42, 88]
              let cls = styles['grid-cell']
              if (tinted.includes(i))     cls += ` ${styles.tinted}`
              if (tintedFull.includes(i)) cls += ` ${styles['tinted-full']}`
              return <div key={i} className={cls} />
            })}
          </div>

          <div className={`${styles.container} ${styles['hero-container']}`}>

            
            <div className={styles['hero-label']}>
              <span className={styles['chain-logos-stack']}>
                
                <img src="https://assets.coingecko.com/coins/images/16547/standard/arb.jpg?1721358242" alt="Arbitrum" title="Arbitrum" />
                
                <img src="https://assets.coingecko.com/asset_platforms/images/184/standard/0g.png" alt="0G Network" title="0G Network" />
              </span>
              Arbitrum · 0G Network
            </div>

            <h1 className={styles['hero-title']}>
              Autonomous wealth.<br />Cryptographically bound.
            </h1>

            <p className={styles['hero-subtitle']}>
              Deploy agents that grow your assets within the strict limits of your intent. Secure, verifiable, and entirely yours.
            </p>

            <div className={styles['hero-actions']}>
              <button onClick={handleStartEarning} className={`${styles.btn} ${styles['btn-primary']} ${styles['btn-large']}`}>
                    Deploy Agent <ArrowNE />
              </button>
            </div>

            
            <div className={styles['hero-visual-container']}>
              <IntelligentFlow />
            </div>
          </div>
        </section>

        
        <section className={styles.features} id="features">
          <div className={styles.container}>

            <div className={styles['features-header']}>
              <h2 className={styles['features-title']}>Yield, handled.</h2>
              <p className={styles['features-subtitle']}>
                From policy signing to on-chain proof — every step is automatic, bounded, and verifiable.
              </p>
            </div>

            
            <div className={`${styles['feature-card']} ${styles['main-feature']}`}>
              <div className={styles['feature-glow']} />

              <h3 className={styles['card-title']}>Autonomous Yield Routing</h3>
              <p className={styles['card-desc']}>
                Your capital flows to the highest-yielding protocol automatically. Your agent scans
                live on-chain rates across Aave, Morpho, Pendle, GMX, and UniV3 every 60 seconds —
                only moving when a better opportunity meets your signed floor.
              </p>

              <div className={styles['multisig-visual']}>
                
                <div className={styles['signer-nodes']}>
                  <div className={`${styles['signer-node']} ${styles.active}`}>
                    <div className={styles.spinner} />
                    Scanning rates…
                  </div>
                  
                  <div className={styles['signer-node']}>
                    <img src="https://assets.coingecko.com/coins/images/12645/standard/aave-token-round.png?1720472354" alt="Aave" className={styles.protoLogo} />
                    Aave V3
                    <img src="https://assets.coingecko.com/coins/images/16547/standard/arb.jpg?1721358242" alt="Arbitrum" className={styles.chainBadge} />
                    <span style={{ marginLeft: 'auto', color: '#4ADE80', fontWeight: 700, fontSize: '12px' }}>8.4%</span>
                  </div>
                  
                  <div className={styles['signer-node']}>
                    <img src="https://assets.coingecko.com/coins/images/28500/standard/pendle-logo.png" alt="Pendle" className={styles.protoLogo} />
                    Pendle YT
                    <img src="https://assets.coingecko.com/coins/images/16547/standard/arb.jpg?1721358242" alt="Arbitrum" className={styles.chainBadge} />
                    <span style={{ marginLeft: 'auto', color: '#4ADE80', fontWeight: 700, fontSize: '12px' }}>24.2%</span>
                  </div>
                </div>

                
                <div className={styles['connector-group']}>
                  <svg className={styles['connector-lines']} width="120" height="120" viewBox="0 0 120 120">
                    <path d="M 0 38 C 50 38, 70 60, 120 60" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" />
                    <path d="M 0 60 L 120 60"              fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" />
                    <path d="M 0 82 C 50 82, 70 60, 120 60" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" />
                    <path d="M 0 38 C 50 38, 70 60, 120 60" fill="none" stroke="#EA580C" strokeWidth="1.5" strokeDasharray="4" className={styles['path-active']} />
                  </svg>
                  <div className={styles['hub-node']}>
                    <div className={styles['hub-pulse']} />
                    <div className={styles['hub-inner']}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                        <path d="M12 2L2 7l10 5 10-5-10-5z"  stroke="#EA580C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M2 17l10 5 10-5"             stroke="#EA580C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M2 12l10 5 10-5"             stroke="#EA580C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                  </div>
                </div>

                <div className={styles['receiver-node']}>Earning</div>
              </div>
            </div>

            
            <div className={styles['features-grid']}>

              
              <div className={styles['feature-card']}>
                <h3 className={styles['card-title']}>Policy-Bounded Execution</h3>
                <p className={styles['card-desc']}>
                  You define the floor. The agent never acts below it. EIP-712 signed —
                  not a preference, a cryptographic commitment that cannot be overridden.
                </p>
                <div className={styles['card-visual']}>
                  <div className={styles['limits-ui']}>
                    <div className={styles['limit-selector']}>Your signed policy</div>
                    <div className={styles['limit-row']}>
                      <div className={styles['user-avatar']}>
                        <img src="https://assets.coingecko.com/coins/images/6319/standard/USDC.png?1769615602" alt="USDC" className={styles.logoFill} />
                      </div>
                      <div className={styles.rowContent}>
                        <div style={{ fontSize: '13px', color: '#fff', fontWeight: 500 }}>Min APY floor</div>
                        <div style={{ fontSize: '11px', color: '#94969A' }}>EIP-712 · non-revocable</div>
                      </div>
                      <span style={{ flexShrink: 0, fontSize: '13px', color: '#EA580C', fontWeight: 700 }}>≥ 8.0%</span>
                    </div>
                    <div className={styles['limit-row']}>
                      <div className={styles['user-avatar']}>
                        <img src="https://assets.coingecko.com/coins/images/6319/standard/USDC.png?1769615602" alt="USDC" className={styles.logoFill} />
                      </div>
                      <div className={styles.rowContent}>
                        <div style={{ fontSize: '13px', color: '#fff', fontWeight: 500 }}>Max drawdown</div>
                        <div style={{ fontSize: '11px', color: '#94969A' }}>Auto-pause on breach</div>
                      </div>
                      <span style={{ flexShrink: 0, fontSize: '13px', color: '#EA580C', fontWeight: 700 }}>≤ 10%</span>
                    </div>
                  </div>
                </div>
              </div>

              
              <div className={styles['feature-card']}>
                <h3 className={styles['card-title']}>On-Chain Proof Every Action</h3>
                <p className={styles['card-desc']}>
                  Every move anchors a cryptographic receipt to 0G Storage. Verifiable by
                  anyone, forever. Not a promise — a proof you can open in a browser.
                </p>
                <div className={styles['card-visual']}>
                  <div className={styles['simulation-ui']}>
                    <div className={styles['sim-header']}>Latest verified action</div>
                    <div className={styles['sim-row']}>
                      <div className={styles['sim-token-icon']}>
                        <img src="https://assets.coingecko.com/coins/images/28500/standard/pendle-logo.png" alt="Pendle" className={styles.logoFill} />
                      </div>
                      <div className={styles.rowContent}>
                        <div style={{ fontSize: '13px', color: '#fff', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}>
                          Pendle YT
                          <img src="https://assets.coingecko.com/coins/images/16547/standard/arb.jpg?1721358242" alt="Arbitrum" className={styles.chainBadge} />
                        </div>
                        <div style={{ fontSize: '11px', color: '#94969A' }}>2 min ago · 0xdfa1…e59e</div>
                      </div>
                      <span className={`${styles['sim-status']} ${styles.success}`}>Verified ✓</span>
                    </div>
                  </div>
                </div>
              </div>

              
              <div className={styles['feature-card']}>
                <h3 className={styles['card-title']}>Multiple Strategies, One App</h3>
                <p className={styles['card-desc']}>
                  Run a conservative Arbitrum strategy alongside an aggressive 0G position.
                  Each has its own rules, its own agent, and its own proof trail.
                </p>
                <div className={styles['card-visual']}>
                  <div className={styles['multichain-ui']}>
                    <div className={styles['org-selector']}>
                      <span style={{ fontSize: '14px', color: '#fff', fontWeight: 500 }}>Your strategies</span>
                      <span style={{ marginLeft: 'auto', fontSize: '14px', color: '#4ADE80', fontWeight: 600 }}>+$124.40</span>
                    </div>
                    <div className={styles['members-list']}>
                      <img src="https://assets.coingecko.com/coins/images/16547/standard/arb.jpg?1721358242" alt="Arbitrum" className={styles.chainCircle} />
                      <img src="https://assets.coingecko.com/asset_platforms/images/184/standard/0g.png" alt="0G Network" className={styles.chainCircle} />
                      <span className={styles['plus-more']}>2 running</span>
                    </div>
                  </div>
                </div>
              </div>

              
              <div className={styles['feature-card']}>
                <h3 className={styles['card-title']}>Always-On Monitoring</h3>
                <p className={styles['card-desc']}>
                  Your agent tracks every rate change across 5+ protocols, 24/7.
                  Safety nets trigger automatically. No dashboards to babysit.
                </p>
                <div className={styles['card-visual']}>
                  <div className={styles['builder-ui']}>
                    <div className={styles['batch-item']}>
                      <img src="https://assets.coingecko.com/coins/images/12645/standard/aave-token-round.png?1720472354" alt="Aave" className={styles.batchIcon} />
                      Aave V3 · 8.4% ✓
                    </div>
                    <div className={styles['batch-item']}>
                      <img src="https://assets.coingecko.com/coins/images/29837/standard/morpho.png" alt="Morpho" className={styles.batchIcon} />
                      Morpho Blue · 9.1% ↑
                    </div>
                    <div className={styles['batch-item']}>
                      <img src="https://assets.coingecko.com/coins/images/28500/standard/pendle-logo.png" alt="Pendle" className={styles.batchIcon} />
                      Pendle YT · 24.2% ★
                    </div>
                  </div>
                </div>
              </div>

            </div>
          </div>
        </section>

        
        <section className={styles.ecosystem} id="protocols">
          <div className={styles['ecosystem-container']}>

            
            <div className={styles['floating-icons']}>
              <div className={`${styles['icon-floating']} ${styles['icon-1']}`}>
                
                <img src="https://assets.coingecko.com/coins/images/12645/standard/aave-token-round.png?1720472354" alt="Aave" />
              </div>
              <div className={`${styles['icon-floating']} ${styles['icon-2']}`}>
                
                <img src="https://assets.coingecko.com/coins/images/29837/standard/morpho.png" alt="Morpho" />
              </div>
              <div className={`${styles['icon-floating']} ${styles['icon-3']}`}>
                
                <img src="https://assets.coingecko.com/coins/images/28500/standard/pendle-logo.png" alt="Pendle" />
              </div>
              <div className={`${styles['icon-floating']} ${styles['icon-4']}`}>
                
                <img src="https://assets.coingecko.com/coins/images/18323/standard/arbit.png" alt="GMX" />
              </div>
              <div className={`${styles['icon-floating']} ${styles['icon-5']}`}>
                
                <img src="https://assets.coingecko.com/coins/images/12504/standard/uniswap-logo.png" alt="Uniswap" />
              </div>
              <div className={`${styles['icon-floating']} ${styles['icon-6']}`}>
                
                <img src="https://assets.coingecko.com/coins/images/16547/standard/arb.jpg?1721358242" alt="Arbitrum" />
              </div>
              <div className={`${styles['icon-floating']} ${styles['icon-7']}`}>
                
                <img src="https://assets.coingecko.com/coins/images/6319/standard/USDC.png?1769615602" alt="USDC" />
              </div>
              <div className={`${styles['icon-floating']} ${styles['icon-8']}`} style={{ background: '#E0E0E0' }}>
                
                <img src="https://assets.coingecko.com/asset_platforms/images/184/standard/0g.png" alt="0G Network" />
              </div>
            </div>

            <div className={styles['ecosystem-content']}>
              <h2 className={styles['ecosystem-title']}>
                Every top protocol.<br />One agent.
              </h2>
              <p className={styles['ecosystem-subtitle']}>
                Earn across Aave, Morpho, Pendle, GMX, Uniswap V3, and more — all tracked live,
                all executed within your signed policy on Arbitrum and 0G.
              </p>
              <div className={styles['ecosystem-actions']}>
                <button className={`${styles.btn} ${styles['btn-primary']}`} onClick={handleStartEarning}>
                      Deploy Agent <ArrowNE />
                </button>
              </div>
            </div>

          </div>
        </section>

      </main>

      
      <footer className={styles['main-footer']}>
        <div className={`${styles.container} ${styles['footer-container']}`}>
          <div className={styles['footer-grid']}>

            
            <div className={styles['footer-brand']}>
              <div className={styles.logo}>
                <Image src="/logo.svg" alt="YieldGeko" width={32} height={32} style={{ borderRadius: 7 }} />
                <span className={styles['logo-text']}>YieldGeko</span>
              </div>
              <p style={{ color: '#636669', fontSize: '14px', marginTop: '16px', lineHeight: 1.65, maxWidth: '220px' }}>
                Autonomous yield optimization. Bounded by rules only you sign.
              </p>
            </div>

            
            <div className={styles['footer-links']}>
              <div className={styles['footer-col']}>
                <h4>Product</h4>
                <ul>
                  <li><a href="#features">How it works</a></li>
                  <li><a href="#protocols">Protocols</a></li>
                  <li><a href="/app/onboard">Launch App</a></li>
                </ul>
              </div>
              <div className={styles['footer-col']}>
                <h4>Protocols</h4>
                <ul>
                  <li><a href="#protocols">Aave V3</a></li>
                  <li><a href="#protocols">Morpho Blue</a></li>
                  <li><a href="#protocols">Pendle Finance</a></li>
                  <li><a href="#protocols">GMX V2</a></li>
                  <li><a href="#protocols">Uniswap V3</a></li>
                </ul>
              </div>
              <div className={styles['footer-col']}>
                <h4>Company</h4>
                <ul>
                  <li><a href="/about">About</a></li>
                  <li><a href="/blog">Blog</a></li>
                  <li><a href="/docs">Docs</a></li>
                </ul>
              </div>
              <div className={styles['footer-col']}>
                <h4>Legal</h4>
                <ul>
                  <li><a href="/terms">Terms of Service</a></li>
                  <li><a href="/privacy">Privacy Policy</a></li>
                </ul>
              </div>
            </div>

          </div>

          
          <div className={styles['footer-bottom']}>
            <div className={styles['social-icons']}>
              <a href="https://x.com/yieldgeko" target="_blank" rel="noopener noreferrer" className={styles['social-icon']} aria-label="X">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </a>
              <a href="https://github.com/yieldgeko" target="_blank" rel="noopener noreferrer" className={styles['social-icon']} aria-label="GitHub">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                </svg>
              </a>
            </div>
            <p className={styles.copyright}>&copy; {new Date().getFullYear()} YieldGeko. All rights reserved.</p>
          </div>
        </div>
      </footer>

    </div>
  )
}
