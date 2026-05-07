import { useSignTypedData, useAccount } from 'wagmi';
import { EIP712_DOMAIN, INTENT_TYPES } from '@yieldgeko/core';

export function useSignIntent() {
  const { signTypedDataAsync } = useSignTypedData();
  const { address } = useAccount();

  const signIntent = async (
    asset: `0x${string}`,
    fromStrategy: `0x${string}`,
    toStrategy: `0x${string}`,
    amount: bigint,
    minAPY: number, 
    expectedAPY: number,
    maxSlippage: number, 
    maxFee: bigint,
    nonce: number, 
    deadline: number
  ) => {
    if (!address) throw new Error("Wallet not connected");

    const message = {
      user: address as `0x${string}`,
      asset,
      fromStrategy,
      toStrategy,
      amount,
      minAPY: BigInt(minAPY),
      expectedAPY: BigInt(expectedAPY),
      maxSlippage: BigInt(maxSlippage),
      maxFee,
      nonce: BigInt(nonce),
      deadline: BigInt(deadline)
    };

    const signature = await signTypedDataAsync({
      domain: EIP712_DOMAIN,
      types: INTENT_TYPES,
      primaryType: 'Intent',
      message
    });

    return { signature, message };
  };

  return { signIntent };
}
