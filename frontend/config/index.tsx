import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { cookieStorage, createStorage } from 'wagmi'
import { defineChain } from 'viem'

// Define 0G Galileo Testnet
export const zeroGGaleleo = defineChain({
  id: 16602,
  name: '0G Galileo',
  nativeCurrency: { name: 'A0G', symbol: 'A0G', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://evmrpc-testnet.0g.ai'] },
  },
  blockExplorers: {
    default: { name: '0G Explorer', url: 'https://chainscan-galileo.0g.ai' },
  },
  testnet: true,
})

export const projectId = process.env.NEXT_PUBLIC_PROJECT_ID || 'b5113d5069f21d4590ba1f2ed0375a31' // Placeholder for Dev

if (!projectId) {
  throw new Error('Project ID is not defined')
}

export const networks = [zeroGGaleleo]

export const wagmiAdapter = new WagmiAdapter({
  storage: createStorage({
    storage: cookieStorage
  }),
  ssr: true,
  projectId,
  networks: networks as any
})

export const config = wagmiAdapter.wagmiConfig
