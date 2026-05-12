import { createPublicClient, http, PublicClient } from 'viem';
import { arbitrum } from 'viem/chains';
import { ISwapProvider, QuoteParams, SwapRoute, ContractCall } from './types';
import { PriceService } from './prices';
import { SwapCache } from './cache';

export class SwapAggregator {
  private priceService: PriceService;
  private cache:        SwapCache;
  private client:       PublicClient;

  constructor(private providers: ISwapProvider[] = [], rpcUrl?: string) {
    this.priceService = new PriceService(rpcUrl);
    this.cache        = new SwapCache(5000); // 5s TTL
    this.client       = createPublicClient({
      chain:     arbitrum,
      transport: http(rpcUrl),
    });
  }

  public async findBestRoute(params: QuoteParams, gasPrice?: bigint): Promise<SwapRoute | null> {
    if (params.chainId !== 42161) {
      throw new Error(`SwapAggregator: unsupported chainId ${params.chainId} (only Arbitrum 42161 supported)`);
    }

    // 1. Cache check
    const cached = this.cache.get(params.chainId, params.tokenIn, params.tokenOut, params.amountIn);
    if (cached !== undefined) return cached;

    const TIMEOUT_MS = 10_000;
    const timeout = <T>(p: Promise<T>): Promise<T | null> =>
      Promise.race([p, new Promise<null>(res => setTimeout(() => res(null), TIMEOUT_MS))]);

    // 2. Split providers: batchable (on-chain multicall) vs API (REST)
    const batchable  = this.providers.filter(p => p.getQuoteCalls && p.processQuoteResults);
    const apiProviders = this.providers.filter(p => !p.getQuoteCalls);

    // 3. Build multicall
    const allCalls: ContractCall[] = [];
    const ranges: { provider: ISwapProvider; start: number; count: number }[] = [];

    for (const p of batchable) {
      const calls = p.getQuoteCalls!(params);
      ranges.push({ provider: p, start: allCalls.length, count: calls.length });
      allCalls.push(...calls);
    }

    // Append Chainlink price calls if gas normalisation requested
    let ethPriceIdx    = -1;
    let outTokenPriceIdx = -1;
    if (gasPrice) {
      const ethCall = this.priceService.getPriceCall('WETH');
      if (ethCall) { ethPriceIdx = allCalls.length; allCalls.push(ethCall); }

      const outCall = this.priceService.getPriceCallByAddress(params.tokenOut);
      if (outCall) { outTokenPriceIdx = allCalls.length; allCalls.push(outCall); }
    }

    // 4. Run API providers and multicall in parallel
    const apiPromises = apiProviders.map(p => timeout(p.getQuote(params)));

    const batchPromise = (async (): Promise<SwapRoute[]> => {
      if (allCalls.length === 0) return [];
      try {
        const results = await this.client.multicall({
          contracts:    allCalls.map(c => ({ address: c.address, abi: c.abi, functionName: c.functionName, args: c.args })),
          allowFailure: true,
        });

        // Parse prices for gas normalisation
        let ethPrice      = 0;
        let outTokenPrice = 0;
        if (ethPriceIdx !== -1 && results[ethPriceIdx]?.status === 'success') {
          ethPrice = this.priceService.parsePriceResult(results[ethPriceIdx].result);
        }
        if (outTokenPriceIdx !== -1 && results[outTokenPriceIdx]?.status === 'success') {
          outTokenPrice = this.priceService.parsePriceResult(results[outTokenPriceIdx].result);
        }

        const outDecimals = this.priceService.getDecimalsByAddress(params.tokenOut);

        const routes: SwapRoute[] = [];
        for (const range of ranges) {
          const slice  = results.slice(range.start, range.start + range.count).map(r => r.result);
          const route  = range.provider.processQuoteResults!(params, slice);
          if (!route) continue;

          // Gas-normalise: subtract estimated gas cost from amountOut
          // Must scale gasCostInToken to the same decimals as amountOut
          if (gasPrice && route.gasEstimate && ethPrice > 0 && outTokenPrice > 0) {
            const gasCostEth      = Number(route.gasEstimate * gasPrice) / 1e18;
            const gasCostHuman    = (gasCostEth * ethPrice) / outTokenPrice;
            const gasCostInToken  = BigInt(Math.floor(gasCostHuman * (10 ** outDecimals)));
            route.netOutput       = route.amountOut > gasCostInToken
              ? route.amountOut - gasCostInToken
              : 0n;
          } else {
            route.netOutput = route.amountOut;
          }

          console.log(`[Aggregator] Quote from ${route.provider}: ${route.amountOut.toString()}`);
          routes.push(route);
        }
        return routes;
      } catch (err) {
        console.error('[Aggregator] Multicall failed:', err);
        return [];
      }
    })();

    const settled = await Promise.allSettled([...apiPromises, batchPromise]);

    let best: SwapRoute | null = null;

    for (const result of settled) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      const routes = Array.isArray(result.value) ? result.value : [result.value];

      for (const route of routes) {
        if (!route) continue;
        console.log(`[Aggregator] Quote from ${route.provider}: ${route.amountOut.toString()}`);
        const score   = route.netOutput ?? route.amountOut;
        const bestScr = best ? (best.netOutput ?? best.amountOut) : 0n;
        if (score > bestScr) best = route;
      }
    }

    // 5. Cache result (including null — "no route found")
    this.cache.set(params.chainId, params.tokenIn, params.tokenOut, params.amountIn, best);
    return best;
  }
}
