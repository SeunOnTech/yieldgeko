'use client'

import { PrivyProvider } from '@privy-io/react-auth'
import { arbitrum } from 'viem/chains'
import { type ReactNode } from 'react'

export default function PrivyClientProvider({ children }: { children: ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID

  // If no valid Privy App ID is configured, render children without the provider
  // This allows the app to work without Privy during development
  // Privy App IDs follow the format: clxxxxxxxxxxxxxxxxxxxxxxxxx
  if (!appId || appId.length < 20 || appId.includes('your')) {
    return <>{children}</>
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        defaultChain: arbitrum,
        supportedChains: [arbitrum],
        embeddedWallets: {
          ethereum: {
            createOnLogin: 'users-without-wallets',
          },
        },
        appearance: {
          theme: 'dark',
          accentColor: '#EA580C',
        },
      }}
    >
      {children}
    </PrivyProvider>
  )
}
