import { JsonRpcProvider } from 'ethers';
import { fetchPrices, pricesAreHealthy, type PriceMap, type TokenPrice } from './chainlink';
import { fetchAaveMarkets, fetchAaveBatchPositions, verifyAaveRate, type AaveMarket, type AaveUserPosition } from './aave-v3';
import { fetchGMXMarkets, fetchGMXBatchPositions, verifyGMXMarket, type GMXMarket, type GMXUserPosition } from './gmx-v2';
import { fetchUniV3Position, createPositionSnapshot, verifyUniV3Pool, type UniV3Position, type PositionSnapshot } from './uniswap-v3';

export * from './chainlink';
export * from './aave-v3';
export * from './gmx-v2';
export * from './uniswap-v3';

export interface OnChainSnapshot {
  prices:           PriceMap;
  pricesHealthy:    boolean;
  aaveMarkets:      AaveMarket[];
  gmxMarkets:       GMXMarket[];
  morphoVaults:     import('./morpho').MorphoVault[];
  pendleMarkets:    import('./pendle').PendleMarket[];
  fetchedAt:        number;
  fetchDurationMs:  number;
}

export interface UserOnChainPositions {
  aave:             AaveUserPosition[];
  gmx:              GMXUserPosition[];
  morpho:           import('./morpho').MorphoUserPosition[];
  pendle:           import('./pendle').PendleUserPosition[];
  uniV3:            import('../driftMonitor').DriftResult | null;
}

export class OnChainProvider {
  private provider:     JsonRpcProvider;
  private lastSnapshot: OnChainSnapshot | null = null;
  private snapshots:    Map<string, PositionSnapshot> = new Map();

  constructor(provider: JsonRpcProvider) {
    this.provider = provider;
  }

  

  async fetchSnapshot(): Promise<OnChainSnapshot> {
    const t0 = Date.now();

    
    const prices = await fetchPrices(this.provider);
    const healthy = pricesAreHealthy(prices);

    
    const [aaveMarkets, gmxMarkets, morphoVaults, pendleMarkets] = await Promise.all([
      fetchAaveMarkets(this.provider, prices).catch(() => [] as AaveMarket[]),
      fetchGMXMarkets(this.provider, prices).catch(() => [] as GMXMarket[]),
      import('./morpho').then(m => m.fetchMorphoVaults(this.provider, prices)).catch(() => []),
      import('./pendle').then(m => m.fetchPendleMarkets(this.provider, prices)).catch(() => []),
    ]);

    const snapshot: OnChainSnapshot = {
      prices,
      pricesHealthy:   healthy,
      aaveMarkets,
      gmxMarkets,
      morphoVaults,
      pendleMarkets,
      fetchedAt:       Date.now(),
      fetchDurationMs: Date.now() - t0,
    };

    this.lastSnapshot = snapshot;
    return snapshot;
  }

  

  async fetchUserPositions(
    _userAddress: string,
    _uniV3TokenId: bigint | null,
    _snapshot:    OnChainSnapshot,
  ): Promise<UserOnChainPositions> {
    
    
    return { aave: [], gmx: [], morpho: [], pendle: [], uniV3: null };
  }

  

  async fetchBatchPositions(
    userStates: import('../types').UserState[],
    snapshot:   OnChainSnapshot,
    driftMap:   Map<string, import('../driftMonitor').DriftResult>,
  ): Promise<Map<string, UserOnChainPositions>> {
    const userAddresses = [...new Set(userStates.map(u => u.userAddress))];
    
    
    const [aaveBatch, gmxBatch, morphoBatch, pendleBatch] = await Promise.all([
      fetchAaveBatchPositions(userAddresses, snapshot.aaveMarkets, this.provider, snapshot.prices),
      fetchGMXBatchPositions(userAddresses, snapshot.gmxMarkets, this.provider),
      import('./morpho').then(m => m.fetchMorphoBatchPositions(userAddresses, snapshot.morphoVaults, this.provider, snapshot.prices)),
      import('./pendle').then(m => m.fetchPendleBatchPositions(userAddresses, snapshot.pendleMarkets, this.provider, snapshot.prices)),
    ]);

    const results = new Map<string, UserOnChainPositions>();

    for (const user of userStates) {
      const aave   = aaveBatch.get(user.userAddress) ?? [];
      const gmx    = gmxBatch.get(user.userAddress) ?? [];
      const morpho = morphoBatch.get(user.userAddress) ?? [];
      const pendle = pendleBatch.get(user.userAddress) ?? [];
      
      const uniV3Pos = user.portfolio?.positions.find(p => p.strategyType === 'DELTA_NEUTRAL');
      const uniV3    = driftMap.get(uniV3Pos?.id ?? '') || null;
      
      results.set(user.userId, { aave, gmx, morpho, pendle, uniV3 });
    }

    return results;
  }

  
  
  
  

  async verifyBeforeExecution(params: {
    strategyType:   'AAVE_LENDING' | 'GMX_REAL_YIELD' | 'DELTA_NEUTRAL';
    assetSymbol?:   string;   
    gmxMarket?:     string;   
    poolAddress?:   string;   
    expectedAPY:    number;
    managedUSD:     number;
    snapshot:       OnChainSnapshot;
  }): Promise<{
    ok:        boolean;
    liveAPY:   number | null;
    checks:    { name: string; passed: boolean; value: string; required: string }[];
    error:     string | null;
  }> {
    const { strategyType, assetSymbol, gmxMarket, poolAddress, expectedAPY, managedUSD, snapshot } = params;
    const checks: { name: string; passed: boolean; value: string; required: string }[] = [];
    let ok = true;
    let liveAPY: number | null = null;
    let error: string | null = null;

    
    checks.push({
      name:     'Chainlink prices',
      passed:   snapshot.pricesHealthy,
      value:    snapshot.pricesHealthy ? 'Fresh' : 'Stale/missing',
      required: 'All key feeds fresh (< 1h)',
    });
    if (!snapshot.pricesHealthy) { ok = false; error = 'Price oracle stale'; }

    
    if (strategyType === 'AAVE_LENDING' && assetSymbol) {
      const result = await verifyAaveRate(assetSymbol, expectedAPY, 20, this.provider, snapshot.prices);
      liveAPY = result.liveAPY;
      checks.push({
        name:     `Aave ${assetSymbol} live APY`,
        passed:   result.ok,
        value:    `${result.liveAPY.toFixed(2)}%`,
        required: `Within 20% of ${expectedAPY.toFixed(2)}%`,
      });
      if (!result.ok) { ok = false; error = result.error; }
    }

    if (strategyType === 'GMX_REAL_YIELD' && gmxMarket) {
      const result = await verifyGMXMarket(gmxMarket, expectedAPY, this.provider, snapshot.prices);
      liveAPY = result.market?.feeAPY ?? null;
      const oiOk  = result.market ? !result.market.oiRiskFlag : false;
      const tvlOk = result.market ? result.market.poolValueUSD >= managedUSD * 50 : false;
      checks.push(
        { name: 'GMX market exists',  passed: result.ok || result.market !== null, value: result.market ? 'Found' : 'Not found', required: 'Market must be live' },
        { name: 'GMX OI balance',     passed: oiOk,   value: result.market ? `${(result.market.oiBalance * 100).toFixed(1)}% long` : '?', required: '30–70% long' },
        { name: 'GMX pool liquidity', passed: tvlOk,  value: result.market ? `$${(result.market.poolValueUSD / 1e6).toFixed(2)}M` : '?',  required: `≥ $${(managedUSD * 50 / 1e6).toFixed(2)}M` },
      );
      if (!result.ok || !oiOk || !tvlOk) { ok = false; error = result.error ?? 'GMX checks failed'; }
    }

    if (strategyType === 'DELTA_NEUTRAL' && poolAddress) {
      const result = await verifyUniV3Pool(poolAddress, managedUSD * 50, this.provider, snapshot.prices);
      liveAPY = null;
      checks.push({
        name:     'Uniswap V3 pool',
        passed:   result.ok,
        value:    result.pool ? `$${(result.pool.tvlUSD / 1e6).toFixed(2)}M TVL` : 'Not found',
        required: `≥ $${(managedUSD * 50 / 1e6).toFixed(2)}M TVL`,
      });
      if (!result.ok) { ok = false; error = result.error; }
    }

    return { ok, liveAPY, checks, error };
  }

  

  async recordPositionEntry(tokenId: bigint, snapshot: OnChainSnapshot): Promise<void> {
    const snap = await createPositionSnapshot(tokenId, this.provider, snapshot.prices);
    if (snap) this.snapshots.set(tokenId.toString(), snap);
  }

  get lastFetchedAt(): number {
    return this.lastSnapshot?.fetchedAt ?? 0;
  }

  getPrices(): PriceMap {
    return this.lastSnapshot?.prices ?? new Map();
  }

  getAaveMarket(symbol: string): AaveMarket | undefined {
    return this.lastSnapshot?.aaveMarkets.find(m => m.symbol === symbol);
  }

  getGMXMarket(name: string): GMXMarket | undefined {
    return this.lastSnapshot?.gmxMarkets.find(m => m.name === name);
  }
}
