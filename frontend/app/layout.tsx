import type { Metadata } from 'next'
import localFont from 'next/font/local'
// Logo variants:
//   /logo.svg        — dark bg + white gecko (navbar, favicons, dark surfaces)
//   /logo-orange.svg — orange bg + white gecko (marketing, cards)
//   /logo-mark.svg   — transparent bg + orange gecko (inline, icon-only use)
import './globals.css'
import './app-pages.css'
import AppKitProvider from '@/context'
import { LoadingBar } from './components/LoadingBar'

const aeonik = localFont({
  src: [
    { path: '../public/fonts/Aeonik_Pro_Regular.woff2', weight: '400', style: 'normal' },
    { path: '../public/fonts/Aeonik_Pro_Medium.woff2',  weight: '500', style: 'normal' },
    { path: '../public/fonts/Aeonik_Pro_Bold.woff2',    weight: '700', style: 'normal' },
  ],
  variable: '--font-aeonik',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'YieldGeko | Autonomous Yield Optimizer',
  description: 'Autonomous yield optimization. Bounded by rules only you sign. Every action verifiable on-chain.',
  // icon.svg and apple-icon.svg in /app are auto-detected by Next.js
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={aeonik.variable}>
      <body>
        <AppKitProvider>
          <LoadingBar />
          {children}
        </AppKitProvider>
      </body>
    </html>
  )
}
