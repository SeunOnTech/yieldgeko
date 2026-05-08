// Chain IDs
export const ZG_MAINNET_CHAIN_ID = 16661
export const ZG_GALILEO_CHAIN_ID = 16602
export const ARBITRUM_CHAIN_ID   = 42161

export const RPC_URL = 'https://evmrpc-testnet.0g.ai'

// Contract addresses — set via env after deployment
export const ADDRESSES = {
  VAULT:    (typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_VAULT_ADDRESS    ?? '' : '') as `0x${string}`,
  TREASURY: (typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_TREASURY_ADDRESS ?? '' : '') as `0x${string}`,
} as const

// EIP-712 Policy type — matches YieldGeko.sol POLICY_TYPEHASH
// "Policy(address user,uint256 managedUSD,uint256 minAPY,uint256 maxDrawdownBps,uint256 maxFeeBps,uint256 nonce,uint256 deadline)"
export const POLICY_TYPES = {
  Policy: [
    { name: 'user',           type: 'address' },
    { name: 'managedUSD',     type: 'uint256' },
    { name: 'minAPY',         type: 'uint256' },
    { name: 'maxDrawdownBps', type: 'uint256' },
    { name: 'maxFeeBps',      type: 'uint256' },
    { name: 'nonce',          type: 'uint256' },
    { name: 'deadline',       type: 'uint256' },
  ],
} as const

export type PolicyMessage = {
  user:           `0x${string}`
  managedUSD:     bigint // token units for the deposited asset; USDC onboarding uses 6 decimals
  minAPY:         bigint
  maxDrawdownBps: bigint
  maxFeeBps:      bigint
  nonce:          bigint
  deadline:       bigint
}

export * from './utils/encryption'
