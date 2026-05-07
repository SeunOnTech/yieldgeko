import { encodeFunctionData, Hex, parseAbi } from 'viem';

/**
 * Route Builder for YieldGeko
 * Translates TEE decisions into safe, deterministic EVM calldata.
 */
export class RouteBuilder {
  private static readonly ROUTER_ABI = parseAbi([
    'function executeMigration((address user, address asset, address fromStrategy, address toStrategy, uint256 amount, uint256 minAPY, uint256 expectedAPY, uint256 maxSlippage, uint256 maxFee, uint256 nonce, uint256 deadline) intent, bytes signature, uint256 actualSlippageBps, bytes32 receiptHash, uint256 gasFeeInAsset) external'
  ]);

  /**
   * Generates calldata for executeMigration
   */
  public static generateMigrationCalldata(params: {
    intent: {
      user: string;
      asset: string;
      fromStrategy: string;
      toStrategy: string;
      amount: bigint;
      minAPY: bigint;
      expectedAPY: bigint;
      maxSlippage: bigint;
      maxFee: bigint;
      nonce: bigint;
      deadline: bigint;
    };
    signature: string;
    actualSlippageBps: bigint;
    receiptHash: string;
    gasFeeInAsset: bigint;
  }): string {
    return encodeFunctionData({
      abi: this.ROUTER_ABI,
      functionName: 'executeMigration',
      args: [
        {
          user: params.intent.user as Hex,
          asset: params.intent.asset as Hex,
          fromStrategy: params.intent.fromStrategy as Hex,
          toStrategy: params.intent.toStrategy as Hex,
          amount: params.intent.amount,
          minAPY: params.intent.minAPY,
          expectedAPY: params.intent.expectedAPY,
          maxSlippage: params.intent.maxSlippage,
          maxFee: params.intent.maxFee,
          nonce: params.intent.nonce,
          deadline: params.intent.deadline,
        },
        params.signature as Hex,
        params.actualSlippageBps,
        params.receiptHash as Hex,
        params.gasFeeInAsset
      ]
    });
  }

  /**
   * Calculates dynamic slippage buffer (Demo: fixed 50 BPS for stables)
   */
  public static calculateSlippageBuffer(asset: string): bigint {
    // In production, this would look up historical volatility
    return 50n; // 0.50%
  }

  /**
   * Estimates gas with a 20% safety margin
   */
  public static applyGasBuffer(estimate: bigint): bigint {
    return (estimate * 120n) / 100n;
  }
}
