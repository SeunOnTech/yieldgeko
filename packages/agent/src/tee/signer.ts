import { AgentIDManager } from './agent-id';
import { EIP712_DOMAIN } from '@yieldgeko/core';

/**
 * TEE Payload Signer
 * Generates hardware-verified signatures for on-chain execution.
 */
export class TEESigner {
  /**
   * Signs a migration payload with EIP-712
   */
  public static async signMigration(params: {
    intent: any;
    fromStrategy: string;
    toStrategy: string;
    asset: string;
    amount: bigint;
    actualSlippageBps: bigint;
    actualAPY: bigint;
  }): Promise<string> {
    console.log("[TEE] Signing Migration Payload with Agent ID...");
    
    const account = AgentIDManager.getAccount();
    
    // In production, this uses the TEE-protected secure sign function
    // For demo, we use viem's local account signing
    const signature = await account.signTypedData({
      domain: EIP712_DOMAIN as any,
      types: {
        Migration: [
          { name: 'user', type: 'address' },
          { name: 'fromStrategy', type: 'address' },
          { name: 'toStrategy', type: 'address' },
          { name: 'asset', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'actualSlippageBps', type: 'uint256' },
          { name: 'actualAPY', type: 'uint256' }
        ]
      },
      primaryType: 'Migration',
      message: {
        user: params.intent.user,
        fromStrategy: params.fromStrategy,
        toStrategy: params.toStrategy,
        asset: params.asset,
        amount: params.amount,
        actualSlippageBps: params.actualSlippageBps,
        actualAPY: params.actualAPY
      }
    });

    console.log(`[TEE] Migration Signed: ${signature.slice(0, 10)}...`);
    return signature;
  }
}
