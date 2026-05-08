import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { cookieStorage, createStorage } from 'wagmi'
import { arbitrum } from 'viem/chains'
import { defineChain } from 'viem'

// 0G Mainnet
export const zeroGMainnet = defineChain({
  id: 16661,
  name: '0G Mainnet',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://evmrpc.0g.ai'] },
  },
  blockExplorers: {
    default: { name: '0G ChainScan', url: 'https://chainscan.0g.ai' },
  },
})

// 0G Galileo Testnet (kept for dev)
export const zeroGGalileo = defineChain({
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

export const projectId = process.env.NEXT_PUBLIC_PROJECT_ID || 'b5113d5069f21d4590ba1f2ed0375a31'

if (!projectId) {
  throw new Error('Project ID is not defined')
}

export const networks = [arbitrum, zeroGMainnet, zeroGGalileo] as [typeof arbitrum, typeof zeroGMainnet, typeof zeroGGalileo]

export const wagmiAdapter = new WagmiAdapter({
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  projectId,
  networks,
})

export const config = wagmiAdapter.wagmiConfig

// Contract addresses — set via env after deployment
export const VAULT_ADDRESS = (process.env.NEXT_PUBLIC_VAULT_ADDRESS ?? '') as `0x${string}`
export const USDC_ADDRESS  = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as `0x${string}`
