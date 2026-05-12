import { SwapAggregator } from '../../core/aggregator';
import { UniswapV3Provider } from './providers/UniswapV3';
import { CamelotV3Provider } from './providers/CamelotV3';
import { OdosProvider }      from './providers/Odos';
import { GMXV1Provider }     from './providers/GMXV1';

export { UniswapV3Provider } from './providers/UniswapV3';
export { CamelotV3Provider } from './providers/CamelotV3';
export { OdosProvider, ODOS_ROUTER_ADDRESS } from './providers/Odos';
export { GMXV1Provider }     from './providers/GMXV1';

/**
 * Creates a fully configured SwapAggregator for Arbitrum One.
 * Provider priority (all run in parallel, best net output wins):
 *   - Odos     — API aggregator, best for exotic pairs and large sizes
 *   - UniswapV3 — on-chain multicall, best for major pairs
 *   - CamelotV3 — on-chain multicall, Arbitrum-native liquidity
 *   - GMXV1    — on-chain async, whitelisted tokens only (fallback)
 */
export function createArbitrumAggregator(rpcUrl?: string): SwapAggregator {
  return new SwapAggregator(
    [
      new OdosProvider(),
      new UniswapV3Provider(rpcUrl),
      new CamelotV3Provider(rpcUrl),
      new GMXV1Provider(rpcUrl),
    ],
    rpcUrl,
  );
}
