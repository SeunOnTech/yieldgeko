import { encodeFunctionData, parseAbi } from 'viem';

/**
 * Route Builder for YieldGeko
 * Translates TEE decisions into safe, deterministic EVM calldata.
 */
export class RouteBuilder {
  private static readonly ROUTER_ABI = parseAbi([
    'function executeMigration((address user, uint256 minAPY, uint256 maxSlippage, uint256 nonce, uint256 deadline) intent, bytes signature, address fromStrategy, address toStrategy, address asset, uint256 amount, uint256 actualSlippageBps, uint256 actualAPY) external'
  ]);

  /**
   * Generates calldata for executeMigration
   */
  public static generateMigrationCalldata(params: {
    intent: {
      user: string;
      minAPY: bigint;
      maxSlippage: bigint;
      nonce: bigint;
      deadline: bigint;
    };
    signature: string;
    fromStrategy: string;
    toStrategy: string;
    asset: string;
    amount: bigint;
    actualSlippageBps: bigint;
    actualAPY: bigint;
  }): string {
    return encodeFunctionData({
      abi: this.ROUTER_ABI,
      functionName: 'executeMigration',
      args: [
        { ...params.intent, user: params.intent.user as `0x${string}` },
        params.signature as `0x${string}`,
        params.fromStrategy as `0x${string}`,
        params.toStrategy as `0x${string}`,
        params.asset as `0x${string}`,
        params.amount,
        params.actualSlippageBps,
        params.actualAPY
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
