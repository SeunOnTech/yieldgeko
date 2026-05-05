import { useSignTypedData, useAccount } from 'wagmi';
import { EIP712_DOMAIN, INTENT_TYPES } from '@yieldgeko/core';

export function useSignIntent() {
  const { signTypedDataAsync } = useSignTypedData();
  const { address } = useAccount();

  const signIntent = async (
    minAPY: number, 
    maxSlippage: number, 
    nonce: number, 
    deadline: number
  ) => {
    if (!address) throw new Error("Wallet not connected");

    const message = {
      user: address as `0x${string}`,
      minAPY: BigInt(minAPY),
      maxSlippage: BigInt(maxSlippage),
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
