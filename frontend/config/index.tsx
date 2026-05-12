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

// Legacy vault address — kept for older screens/hooks while V2 onboarding migrates.
export const VAULT_ADDRESS = (process.env.NEXT_PUBLIC_VAULT_ADDRESS ?? '') as `0x${string}`

// V2 public execution config
export const USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as `0x${string}`
export const EXECUTOR_ADDRESS = (process.env.NEXT_PUBLIC_EXECUTOR_ADDRESS ?? '0x94DE8790BEd6Be0395C6BE7f42FD677b7B8cBcFb') as `0x${string}`
export const SWAPPER_ADDRESS = (process.env.NEXT_PUBLIC_SWAPPER_ADDRESS ?? '0x4313539C4fF1b93891B6A66D6a2eb690153A1b33') as `0x${string}`
export const ENFORCER_ADDRESS = (process.env.NEXT_PUBLIC_ENFORCER_ADDRESS ?? '0x21b25E099CA7AF1BEa3a4558E437C56680B4b925') as `0x${string}`
export const TREASURY_ADDRESS = (process.env.NEXT_PUBLIC_TREASURY_ADDRESS ?? '0xd61E4Bfb67514d8ad797495A584f70Cd0878fc5A') as `0x${string}`
