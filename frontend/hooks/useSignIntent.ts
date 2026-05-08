import { useSignTypedData, useAccount, useChainId } from 'wagmi'
import { VAULT_ADDRESS } from '../config'
import { useReadYieldGekoNonces } from '../src/generated'

// EIP-712 Policy type — matches YieldGeko.sol POLICY_TYPEHASH
const POLICY_TYPES = {
  Policy: [
    { name: 'user',          type: 'address' },
    { name: 'managedUSD',    type: 'uint256' },
    { name: 'minAPY',        type: 'uint256' },
    { name: 'maxDrawdownBps',type: 'uint256' },
    { name: 'maxFeeBps',     type: 'uint256' },
    { name: 'nonce',         type: 'uint256' },
    { name: 'deadline',      type: 'uint256' },
  ],
} as const

export type PolicyParams = {
  managedUSD:     bigint   // token units for the deposited asset; USDC onboarding uses 6 decimals
  minAPY:         bigint   // bps, e.g. 800 = 8%
  maxDrawdownBps: bigint   // e.g. 1000 = 10%
  maxFeeBps:      bigint   // e.g. 50 = 0.5%
  deadline:       bigint
}

export function useSignPolicy() {
  const { signTypedDataAsync } = useSignTypedData()
  const { address } = useAccount()
  const chainId = useChainId()

  const { data: currentNonce, refetch: refetchNonce } = useReadYieldGekoNonces({
    address: VAULT_ADDRESS,
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && VAULT_ADDRESS) },
  })

  const signPolicy = async (params: PolicyParams) => {
    if (!address) throw new Error('Wallet not connected')

    const nonce = currentNonce ?? BigInt(0)

    const message = {
      user:          address as `0x${string}`,
      managedUSD:    params.managedUSD,
      minAPY:        params.minAPY,
      maxDrawdownBps:params.maxDrawdownBps,
      maxFeeBps:     params.maxFeeBps,
      nonce,
      deadline:      params.deadline,
    }

    const domain = {
      name: 'YieldGeko',
      version: '1',
      chainId,
      verifyingContract: VAULT_ADDRESS,
    } as const

    const signature = await signTypedDataAsync({
      domain,
      types: POLICY_TYPES,
      primaryType: 'Policy',
      message,
    })

    return { signature, message, nonce }
  }

  return { signPolicy, currentNonce, refetchNonce }
}

// Legacy export alias so any file still importing useSignIntent doesn't break
export const useSignIntent = useSignPolicy
