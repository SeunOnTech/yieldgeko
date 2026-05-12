import { describe, it, expect } from 'vitest';
import { SwapAggregator } from '../src/core/aggregator';
import { OdosProvider } from '../src/chains/arbitrum/providers/Odos';
import { UniswapV3Provider } from '../src/chains/arbitrum/providers/UniswapV3';
import { Address, parseUnits } from 'viem';

// Real Arbitrum tokens
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const RPC_URL = 'https://arb1.arbitrum.io/rpc';

describe('SwapAggregator Integration (Arbitrum)', () => {
  it('should fetch real quotes from Odos and Uniswap V3', async () => {
    const odos = new OdosProvider();
    const univ3 = new UniswapV3Provider(RPC_URL);
    const aggregator = new SwapAggregator([odos, univ3]);

    const params = {
      tokenIn: USDC as Address,
      tokenOut: WETH as Address,
      amountIn: parseUnits('100', 6), // 100 USDC
      slippageBps: 50, // 0.5%
      recipient: '0x092106703adE19BF7a638AD371f8f6c25831F349' as Address,
      chainId: 42161,
    };

    console.log('--- Fetching Best Route for 100 USDC -> WETH ---');
    const bestRoute = await aggregator.findBestRoute(params);

    if (bestRoute) {
      console.log(`WINNER: ${bestRoute.provider}`);
      console.log(`Amount Out: ${bestRoute.amountOut.toString()}`);
      console.log(`DEX Router: ${bestRoute.dex}`);
      console.log(`Calldata Length: ${bestRoute.calldata.length}`);
      
      expect(bestRoute.amountOut).toBeGreaterThan(0n);
      expect(bestRoute.calldata.startsWith('0x')).toBe(true);
    } else {
      throw new Error('No route found');
    }
  }, 30000); // 30s timeout for real API calls
});
