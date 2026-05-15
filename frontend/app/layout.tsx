import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'

import './globals.css'
import './app-pages.css'
import AppKitProvider from '@/context'
import PrivyClientProvider from '@/context/PrivyProvider'
import { LoadingBar } from './components/LoadingBar'
import { ThemeProvider } from './components/ThemeProvider'

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
  
}

export const viewport: Viewport = {
  viewportFit: 'cover',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={aeonik.variable} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}if(t==='dark'){document.documentElement.classList.add('dark');}}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <ThemeProvider>
          <AppKitProvider>
            <PrivyClientProvider>
              <LoadingBar />
              {children}
            </PrivyClientProvider>
          </AppKitProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
