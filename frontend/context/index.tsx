'use client'

import { createAppKit } from '@reown/appkit/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactNode } from 'react'
import { config, projectId, networks, wagmiAdapter } from '@/config'
import { WagmiProvider } from 'wagmi'

const queryClient = new QueryClient()

if (!projectId) {
  throw new Error('Project ID is not defined')
}

// Create the modal
createAppKit({
  adapters: [wagmiAdapter],
  networks,
  projectId,
  themeMode: 'light',
  themeVariables: {
    '--w3m-accent':               '#EA580C',
    '--w3m-border-radius-master': '3px',
    '--w3m-font-family':          'var(--font-aeonik), -apple-system, BlinkMacSystemFont, sans-serif',
  },
  features: {
    analytics: false,
  },
})

export default function AppKitProvider({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  )
}
