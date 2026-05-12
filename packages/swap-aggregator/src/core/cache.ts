import { SwapRoute } from './types';

interface CachedRoute {
  route: SwapRoute | null;
  timestamp: number;
}

export class SwapCache {
  private cache: Map<string, CachedRoute> = new Map();
  private readonly ttl: number;

  constructor(ttlMs: number = 5000) {
    this.ttl = ttlMs;
  }

  private generateKey(chainId: number, tokenIn: string, tokenOut: string, amountIn: bigint): string {
    return `${chainId}:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}:${amountIn.toString()}`;
  }

  public get(chainId: number, tokenIn: string, tokenOut: string, amountIn: bigint): SwapRoute | null | undefined {
    const key = this.generateKey(chainId, tokenIn, tokenOut, amountIn);
    const entry = this.cache.get(key);

    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.route;
  }

  public set(chainId: number, tokenIn: string, tokenOut: string, amountIn: bigint, route: SwapRoute | null): void {
    const key = this.generateKey(chainId, tokenIn, tokenOut, amountIn);
    this.cache.set(key, {
      route,
      timestamp: Date.now()
    });

    // Simple cleanup: if cache gets too big, clear oldest entries
    if (this.cache.size > 1000) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
  }
}
