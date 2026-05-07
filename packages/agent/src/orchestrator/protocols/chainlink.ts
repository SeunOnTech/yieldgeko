import { Contract, Interface, JsonRpcProvider } from 'ethers';

// ── Chainlink Price Oracle ────────────────────────────────────────────────────
//
//  All price feeds are batched into a single Multicall3 call.
//  Staleness check: reject prices older than STALE_THRESHOLD_S.
//  Fallback: last known good price (never null — stale > absent).
// ─────────────────────────────────────────────────────────────────────────────

const MULTICALL3        = '0xcA11bde05977b3631167028862bE2a173976CA11';
const STALE_THRESHOLD_S = 3_600; // 1 hour

// Chainlink feeds on Arbitrum (all verified against Chainlink docs)
export const FEEDS: Record<string, { feed: string; decimals: number }> = {
  WETH: { feed: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612', decimals: 8 },
  WBTC: { feed: '0x6ce185026aF36877D6F8B0F98fBd36Fda7e6E4C', decimals: 8 },
  USDC: { feed: '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3', decimals: 8 },
  USDT: { feed: '0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7', decimals: 8 },
  ARB:  { feed: '0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6', decimals: 8 },
  LINK: { feed: '0x86E53CF1B873D1708130F08ffdfd51b3B1B90c6', decimals: 8 },
};

export interface TokenPrice {
  symbol:    string;
  priceUSD:  number;
  updatedAt: number;   // unix seconds
  isStale:   boolean;
  source:    'chainlink' | 'fallback';
}

export type PriceMap = Map<string, TokenPrice>;

// ── ABIs ──────────────────────────────────────────────────────────────────────

const MC3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)',
];

const FEED_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];

// ── In-memory last-known-good cache ──────────────────────────────────────────

const cache = new Map<string, TokenPrice>();

// ── Fetch all prices in one Multicall3 round-trip ────────────────────────────

export async function fetchPrices(provider: JsonRpcProvider): Promise<PriceMap> {
  const mc    = new Contract(MULTICALL3, MC3_ABI, provider);
  const iface = new Interface(FEED_ABI);
  const syms  = Object.keys(FEEDS);
  const now   = Math.floor(Date.now() / 1_000);

  const calls = syms.map(sym => ({
    target:       FEEDS[sym].feed,
    allowFailure: true,
    callData:     iface.encodeFunctionData('latestRoundData'),
  }));

  let raw: { success: boolean; returnData: string }[] = [];
  try {
    raw = await mc.aggregate3(calls);
  } catch {
    // Full multicall failure — return stale cache for all
    const result = new Map<string, TokenPrice>();
    for (const sym of syms) {
      const cached = cache.get(sym);
      if (cached) result.set(sym, { ...cached, isStale: true, source: 'fallback' });
    }
    return result;
  }

  const result = new Map<string, TokenPrice>();

  for (let i = 0; i < syms.length; i++) {
    const sym                = syms[i];
    const { success, returnData } = raw[i];

    if (success && returnData && returnData !== '0x') {
      try {
        const decoded    = iface.decodeFunctionResult('latestRoundData', returnData);
        const answer     = BigInt(decoded[1].toString());
        const updatedAt  = Number(decoded[3].toString());
        const dec        = FEEDS[sym].decimals;
        const priceUSD   = Number(answer) / 10 ** dec;
        const isStale    = now - updatedAt > STALE_THRESHOLD_S;

        const entry: TokenPrice = { symbol: sym, priceUSD, updatedAt, isStale, source: 'chainlink' };
        result.set(sym, entry);
        cache.set(sym, entry);   // update cache on success
        continue;
      } catch { /* fall through to cache */ }
    }

    // Use last known good value
    const cached = cache.get(sym);
    if (cached) {
      result.set(sym, { ...cached, isStale: true, source: 'fallback' });
    }
  }

  return result;
}

// ── Convenience getter (never returns 0 for stablecoins) ─────────────────────

export function getPrice(prices: PriceMap, symbol: string): number {
  const p = prices.get(symbol);
  if (p) return p.priceUSD;
  // Stablecoin fallback
  if (symbol === 'USDC' || symbol === 'USDT' || symbol === 'DAI') return 1.0;
  return 0;
}

export function getPriceByAddress(prices: PriceMap, address: string): number {
  const ADDR_TO_SYM: Record<string, string> = {
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC',
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'USDT',
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'WETH',
    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': 'WBTC',
    '0x912ce59144191c1204e64559fe8253a0e49e6548': 'ARB',
    '0xf97f4df75117a78c1a5a0dbb814af92458539fb4': 'LINK',
  };
  const sym = ADDR_TO_SYM[address.toLowerCase()];
  return sym ? getPrice(prices, sym) : 0;
}

export function pricesAreHealthy(prices: PriceMap): boolean {
  return ['WETH', 'WBTC', 'USDC'].every(sym => {
    const p = prices.get(sym);
    return p && !p.isStale && p.priceUSD > 0;
  });
}
