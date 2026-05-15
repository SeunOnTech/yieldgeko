

import { PricePoint } from '../types/market';

const BASE = 'https://deep-index.moralis.io/api/v2.2';
const API_KEY = () => process.env.MORALIS_API_KEY ?? '';

const STABLES = new Set([
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', 
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', 
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', 
]);

const historyCache  = new Map<string, { data: PricePoint[]; fetchedAt: number }>();
const spotCache     = new Map<string, { price: number; fetchedAt: number }>();
const HISTORY_TTL   = 60 * 60_000;   
const SPOT_TTL      = 5  * 60_000;   

function isoDate(ts: number): string {
  return new Date(ts).toISOString().split('T')[0]!;
}

async function moralisGet<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const key = API_KEY();
  if (!key) {
    console.warn('[MoralisPrice] MORALIS_API_KEY not set');
    return null;
  }
  const url = new URL(`${BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  try {
    const res = await fetch(url.toString(), {
      headers: { 'X-API-Key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      console.warn(`[MoralisPrice] ${path} → HTTP ${res.status}`);
      return null;
    }
    return await res.json() as T;
  } catch (err: any) {
    console.warn(`[MoralisPrice] ${path} failed:`, err.message?.slice(0, 60));
    return null;
  }
}

export async function getPriceHistory(
  address: string,
  chain   = 'arbitrum',
  days    = 30,
): Promise<PricePoint[]> {
  const addr = address.toLowerCase();

  if (STABLES.has(addr)) {
    const now = Date.now();
    return Array.from({ length: days }, (_, i) => ({
      timestamp: now - (days - i) * 86_400_000,
      close:     1.0,
    }));
  }

  const cached = historyCache.get(addr);
  if (cached && Date.now() - cached.fetchedAt < HISTORY_TTL) return cached.data;

  const toDate   = new Date();
  const fromDate = new Date(toDate.getTime() - days * 86_400_000);

  type OHLCVRow = { timestamp: string; open: string; high: string; low: string; close: string; volume: string };
  type Response = { result?: OHLCVRow[] };

  const json = await moralisGet<Response>('/erc20/ohlcv', {
    address:   addr,
    chain,
    from_date: isoDate(fromDate.getTime()),
    to_date:   isoDate(toDate.getTime()),
    timeframe: '1d',
  });

  if (!json?.result?.length) {
    historyCache.set(addr, { data: [], fetchedAt: Date.now() });
    return [];
  }

  const data: PricePoint[] = json.result.map(row => ({
    timestamp: new Date(row.timestamp).getTime(),
    close:     parseFloat(row.close),
  })).sort((a, b) => a.timestamp - b.timestamp);

  historyCache.set(addr, { data, fetchedAt: Date.now() });
  return data;
}

export async function getSpotPrice(address: string, chain = 'arbitrum'): Promise<number> {
  const addr = address.toLowerCase();

  if (STABLES.has(addr)) return 1.0;

  const cached = spotCache.get(addr);
  if (cached && Date.now() - cached.fetchedAt < SPOT_TTL) return cached.price;

  type SpotResp = { usdPrice?: number };
  const json = await moralisGet<SpotResp>(`/erc20/${addr}/price`, { chain });

  const price = json?.usdPrice ?? 0;
  spotCache.set(addr, { price, fetchedAt: Date.now() });
  return price;
}

export async function batchSpotPrices(
  addresses: string[],
  chain = 'arbitrum',
): Promise<Map<string, number>> {
  const results = await Promise.allSettled(
    addresses.map(async a => ({ a: a.toLowerCase(), p: await getSpotPrice(a, chain) })),
  );
  const map = new Map<string, number>();
  for (const r of results) {
    if (r.status === 'fulfilled') map.set(r.value.a, r.value.p);
  }
  return map;
}

export async function warmPriceCache(addresses: string[], chain = 'arbitrum'): Promise<void> {
  const toWarm = addresses.filter(a => !STABLES.has(a.toLowerCase()) && !historyCache.has(a.toLowerCase()));
  if (toWarm.length === 0) return;
  console.log(`[MoralisPrice] Warming history for ${toWarm.length} tokens...`);
  await Promise.allSettled(toWarm.map(a => getPriceHistory(a, chain)));
  console.log(`[MoralisPrice] Cache warm complete.`);
}
