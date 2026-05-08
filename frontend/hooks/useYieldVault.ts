import { useWriteContract, useAccount } from 'wagmi'
import { parseUnits } from 'viem'
import { VAULT_ADDRESS, USDC_ADDRESS } from '../config'
import {
  useReadYieldGekoBalances,
  useReadYieldGekoDeployed,
  yieldGekoAbi,
} from '../src/generated'

export function useYieldVault(assetAddress: `0x${string}` = USDC_ADDRESS) {
  const { writeContractAsync } = useWriteContract()
  const { address } = useAccount()

  const { data: idleBalance, refetch: refetchIdle } = useReadYieldGekoBalances({
    address: VAULT_ADDRESS,
    args: address ? [address, assetAddress] : undefined,
    query: { enabled: Boolean(address && VAULT_ADDRESS) },
  })

  const { data: deployedBalance, refetch: refetchDeployed } = useReadYieldGekoDeployed({
    address: VAULT_ADDRESS,
    args: address ? [address, assetAddress] : undefined,
    query: { enabled: Boolean(address && VAULT_ADDRESS) },
  })

  const deposit = async (amount: string) => {
    if (!address) throw new Error('Wallet not connected')
    const amountRaw = parseUnits(amount, 6)
    await writeContractAsync({
      address: VAULT_ADDRESS,
      abi: yieldGekoAbi,
      functionName: 'deposit',
      args: [assetAddress, amountRaw],
    })
    await refetchIdle()
  }

  const withdraw = async (amount: string) => {
    if (!address) throw new Error('Wallet not connected')
    const amountRaw = parseUnits(amount, 6)
    await writeContractAsync({
      address: VAULT_ADDRESS,
      abi: yieldGekoAbi,
      functionName: 'withdraw',
      args: [assetAddress, amountRaw],
    })
    await refetchIdle()
  }

  const refetch = async () => {
    await Promise.all([refetchIdle(), refetchDeployed()])
  }

  return {
    deposit,
    withdraw,
    balance: idleBalance,
    deployedBalance,
    refetch,
    refetchBalance: refetchIdle,
  }
}
