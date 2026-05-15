'use client'

import { AppKitProvider as ReownAppKitProvider } from '@reown/appkit/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactNode } from 'react'
import { config, networks, projectId, wagmiAdapter } from '@/config'
import { WagmiProvider } from 'wagmi'

const queryClient = new QueryClient()

export default function AppKitProvider({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ReownAppKitProvider
          adapters={[wagmiAdapter]}
          networks={networks}
          projectId={projectId}
          themeMode="light"
          themeVariables={{
            '--w3m-accent': '#EA580C',
            '--w3m-border-radius-master': '3px',
            '--w3m-font-family': 'var(--font-aeonik), -apple-system, BlinkMacSystemFont, sans-serif',
          }}
          features={{
            analytics: false,
            email: true,
            socials: ['google', 'apple', 'x', 'discord'],
          }}
        >
          {children}
        </ReownAppKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
