import { describe, it, expect, vi } from 'vitest';
import { SwapAggregator } from '../src/core/aggregator';
import { ISwapProvider, QuoteParams, SwapRoute } from '../src/core/types';
import { Address } from 'viem';

const MOCK_PARAMS: QuoteParams = {
  tokenIn: '0x123' as Address,
  tokenOut: '0x456' as Address,
  amountIn: 1000n,
  slippageBps: 50,
  recipient: '0x789' as Address,
  chainId: 42161,
};

describe('SwapAggregator Engine', () => {
  it('should pick the route with the highest amountOut when no netOutput is present', async () => {
    const provider1: ISwapProvider = {
      name: 'Provider1',
      getQuote: async () => ({
        provider: 'Provider1',
        amountOut: 100n,
        dex: '0x0' as Address,
        approvalTarget: '0x0' as Address,
      } as SwapRoute),
    };

    const provider2: ISwapProvider = {
      name: 'Provider2',
      getQuote: async () => ({
        provider: 'Provider2',
        amountOut: 120n,
        dex: '0x0' as Address,
        approvalTarget: '0x0' as Address,
      } as SwapRoute),
    };

    const aggregator = new SwapAggregator([provider1, provider2]);
    const best = await aggregator.findBestRoute(MOCK_PARAMS);

    expect(best?.provider).toBe('Provider2');
    expect(best?.amountOut).toBe(120n);
  });

  it('should pick the route with the highest netOutput', async () => {
    const provider1: ISwapProvider = {
      name: 'Cheap Gas',
      getQuote: async () => ({
        provider: 'Cheap Gas',
        amountOut: 100n,
        netOutput: 95n,
        dex: '0x0' as Address,
        approvalTarget: '0x0' as Address,
      } as SwapRoute),
    };

    const provider2: ISwapProvider = {
      name: 'Expensive Gas',
      getQuote: async () => ({
        provider: 'Expensive Gas',
        amountOut: 110n,
        netOutput: 90n,
        dex: '0x0' as Address,
        approvalTarget: '0x0' as Address,
      } as SwapRoute),
    };

    const aggregator = new SwapAggregator([provider1, provider2]);
    const best = await aggregator.findBestRoute(MOCK_PARAMS);

    expect(best?.provider).toBe('Cheap Gas');
    expect(best?.netOutput).toBe(95n);
  });

  it('should handle failing providers gracefully', async () => {
    const provider1: ISwapProvider = {
      name: 'Failing',
      getQuote: async () => { throw new Error('API Down'); },
    };

    const provider2: ISwapProvider = {
      name: 'Success',
      getQuote: async () => ({
        provider: 'Success',
        amountOut: 100n,
        dex: '0x0' as Address,
        approvalTarget: '0x0' as Address,
      } as SwapRoute),
    };

    const aggregator = new SwapAggregator([provider1, provider2]);
    const best = await aggregator.findBestRoute(MOCK_PARAMS);

    expect(best?.provider).toBe('Success');
  });
});
