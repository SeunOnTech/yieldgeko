import { useWriteContract, useAccount, useReadContract } from 'wagmi';
import { ADDRESSES } from '@yieldgeko/core';
import { parseUnits } from 'viem';
import { useReadYieldGekoRouterUserBalances } from '../src/generated';

export function useYieldVault(assetAddress: `0x${string}`) {
  const { writeContractAsync } = useWriteContract();
  const { address } = useAccount();

  // Read current balance from contract
  const { data: balance, refetch: refetchBalance } = useReadYieldGekoRouterUserBalances({
    address: ADDRESSES.YIELD_GEKO_ROUTER as `0x${string}`,
    args: address ? [address, assetAddress] : undefined
  });

  const deposit = async (amount: string) => {
    if (!address) throw new Error("Wallet not connected");
    
    // We assume 6 decimals for USDC-like assets on Galileo for this demo
    const amountRaw = parseUnits(amount, 6);

    await writeContractAsync({
      address: ADDRESSES.YIELD_GEKO_ROUTER as `0x${string}`,
      abi: [
        {
          name: 'deposit',
          type: 'function',
          stateMutability: 'nonpayable',
          inputs: [
            { name: '_asset', type: 'address' },
            { name: '_amount', type: 'uint256' }
          ]
        }
      ],
      functionName: 'deposit',
      args: [assetAddress, amountRaw]
    });

    await refetchBalance();
  };

  const withdraw = async (amount: string) => {
    if (!address) throw new Error("Wallet not connected");
    const amountRaw = parseUnits(amount, 6);

    await writeContractAsync({
      address: ADDRESSES.YIELD_GEKO_ROUTER as `0x${string}`,
      abi: [
        {
          name: 'withdraw',
          type: 'function',
          stateMutability: 'nonpayable',
          inputs: [
            { name: '_asset', type: 'address' },
            { name: '_amount', type: 'uint256' }
          ]
        }
      ],
      functionName: 'withdraw',
      args: [assetAddress, amountRaw]
    });

    await refetchBalance();
  };

  return { 
    deposit, 
    withdraw, 
    balance,
    refetchBalance
  };
}
