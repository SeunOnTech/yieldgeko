import { JsonRpcProvider } from 'ethers';
import { fetchPrices, pricesAreHealthy, type PriceMap, type TokenPrice } from './chainlink';
import { fetchAaveMarkets, fetchAaveUserPositions, verifyAaveRate, type AaveMarket, type AaveUserPosition } from './aave-v3';
import { fetchGMXMarkets, fetchGMXUserPositions, verifyGMXMarket, type GMXMarket, type GMXUserPosition } from './gmx-v2';
import { fetchUniV3Position, createPositionSnapshot, verifyUniV3Pool, type UniV3Position, type PositionSnapshot } from './uniswap-v3';

export * from './chainlink';
export * from './aave-v3';
export * from './gmx-v2';
export * from './uniswap-v3';

// ── OnChainSnapshot ───────────────────────────────────────────────────────────
//
//  Single object holding the complete on-chain state fetched in one round.
//  The universe engine and monitor both read from this snapshot — one
//  snapshot per tick means every module shares the same consistent state.
// ─────────────────────────────────────────────────────────────────────────────

export interface OnChainSnapshot {
  prices:           PriceMap;
  pricesHealthy:    boolean;
  aaveMarkets:      AaveMarket[];
  gmxMarkets:       GMXMarket[];
  fetchedAt:        number;
  fetchDurationMs:  number;
}

export interface UserOnChainPositions {
  aave:             AaveUserPosition[];
  gmx:              GMXUserPosition[];
  uniV3:            UniV3Position | null;
}

// ── Main provider class ───────────────────────────────────────────────────────

export class OnChainProvider {
  private provider:     JsonRpcProvider;
  private lastSnapshot: OnChainSnapshot | null = null;
  private snapshots:    Map<string, PositionSnapshot> = new Map();

  constructor(provider: JsonRpcProvider) {
    this.provider = provider;
  }

  // ── Fetch full market snapshot (called once per tick) ──────────────────────

  async fetchSnapshot(): Promise<OnChainSnapshot> {
    const t0 = Date.now();

    // Prices first — everything else depends on them
    const prices = await fetchPrices(this.provider);
    const healthy = pricesAreHealthy(prices);

    // Aave and GMX markets in parallel
    const [aaveMarkets, gmxMarkets] = await Promise.all([
      fetchAaveMarkets(this.provider, prices).catch(() => [] as AaveMarket[]),
      fetchGMXMarkets(this.provider, prices).catch(() => [] as GMXMarket[]),
    ]);

    const snapshot: OnChainSnapshot = {
      prices,
      pricesHealthy:   healthy,
      aaveMarkets,
      gmxMarkets,
      fetchedAt:       Date.now(),
      fetchDurationMs: Date.now() - t0,
    };

    this.lastSnapshot = snapshot;
    return snapshot;
  }

  // ── Fetch user positions (called when user address is known) ───────────────

  async fetchUserPositions(
    userAddress: string,
    uniV3TokenId: bigint | null,
    snapshot:    OnChainSnapshot,
  ): Promise<UserOnChainPositions> {
    const [aave, gmx] = await Promise.all([
      fetchAaveUserPositions(userAddress, snapshot.aaveMarkets, this.provider, snapshot.prices)
        .catch(() => [] as AaveUserPosition[]),
      fetchGMXUserPositions(userAddress, snapshot.gmxMarkets, this.provider)
        .catch(() => [] as GMXUserPosition[]),
    ]);

    let uniV3: UniV3Position | null = null;
    if (uniV3TokenId) {
      const entry = this.snapshots.get(uniV3TokenId.toString()) ?? null;
      uniV3 = await fetchUniV3Position(uniV3TokenId, this.provider, snapshot.prices, entry)
        .catch(() => null);
    }

    return { aave, gmx, uniV3 };
  }

  // ── Pre-execution verification gateway ─────────────────────────────────────
  //
  //  Call this immediately before executing any fund movement.
  //  Returns all checks in one call so the safety gate has everything it needs.

  async verifyBeforeExecution(params: {
    strategyType:   'AAVE_LENDING' | 'GMX_REAL_YIELD' | 'DELTA_NEUTRAL';
    assetSymbol?:   string;   // AAVE: e.g. 'USDC'
    gmxMarket?:     string;   // GMX: e.g. 'ETH/USDC'
    poolAddress?:   string;   // Uni V3: pool address
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

    // ── Price health check (always) ──────────────────────────────────────────
    checks.push({
      name:     'Chainlink prices',
      passed:   snapshot.pricesHealthy,
      value:    snapshot.pricesHealthy ? 'Fresh' : 'Stale/missing',
      required: 'All key feeds fresh (< 1h)',
    });
    if (!snapshot.pricesHealthy) { ok = false; error = 'Price oracle stale'; }

    // ── Protocol-specific checks ─────────────────────────────────────────────
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

  // ── Create entry snapshot for a new Uni V3 position ──────────────────────

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
