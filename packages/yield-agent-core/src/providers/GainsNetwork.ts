

const URL   = 'https://backend-arbitrum.gains.trade/trading-variables';
const CACHE_TTL = 60 * 60_000;

let _rates: Map<string, number> = new Map([
  ['WETH', 6.5], ['WBTC', 7.0], ['ARB', 9.0],
]);
let _fetchedAt = 0;

export async function getFundingRates(): Promise<Map<string, number>> {
  if (Date.now() - _fetchedAt < CACHE_TTL) return _rates;

  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return _rates;
    const data = await res.json() as any;

    const fresh = new Map<string, number>();
    for (const pair of (data?.pairs ?? [])) {
      const from   = (pair.from ?? '').toUpperCase();
      const annual = (Number(pair.fundingFee ?? 0) / 1e10) * 4 * 3600 * 24 * 365 * 100;
      if (from === 'ETH') fresh.set('WETH', annual);
      if (from === 'BTC') fresh.set('WBTC', annual);
      if (from === 'ARB') fresh.set('ARB', annual);
    }

    if (fresh.size > 0) {
      _rates = fresh;
      _fetchedAt = Date.now();
    }
  } catch {
    
  }

  return _rates;
}
