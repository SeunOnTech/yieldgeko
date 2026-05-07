import { Contract, Interface, JsonRpcProvider } from 'ethers';
import type { PriceMap } from './chainlink';
import { getPrice, getPriceByAddress } from './chainlink';

// ── GMX V2 on Arbitrum ────────────────────────────────────────────────────────
//
//  GM token price methodology:
//    poolValueUSD = longToken.balanceOf(gmToken) × longPrice
//                + shortToken.balanceOf(gmToken) × shortPrice
//    gmPriceUSD   = poolValueUSD / gmToken.totalSupply()
//
//  This is an approximation — the exact price includes pending trader PnL
//  which requires the Reader contract. For monitoring, the approximation is
//  within 0.1–0.5% of the true value under normal market conditions.
//  For pre-execution, use this + ±1% tolerance buffer.
//
//  OI balance: read from the GMX subgraph (long/short open interest).
//  Falls back to neutral (0.5) if subgraph is unreachable.
// ─────────────────────────────────────────────────────────────────────────────

const MULTICALL3  = '0xcA11bde05977b3631167028862bE2a173976CA11';
const GMX_GRAPHQL = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';

export const GMX_MARKETS: Record<string, {
  gmToken:    string;
  longToken:  string;
  shortToken: string;
  longSym:    string;
  shortSym:   string;
}> = {
  'ETH/USDC': {
    gmToken:   '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336',
    longToken: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    shortToken:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    longSym:   'WETH', shortSym: 'USDC',
  },
  'BTC/USDC': {
    gmToken:   '0x47c031236e19d024b42f8AE6780E44A573170703',
    longToken: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    shortToken:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    longSym:   'WBTC', shortSym: 'USDC',
  },
  'ARB/USDC': {
    gmToken:   '0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407',
    longToken: '0x912CE59144191C1204E64559FE8253a0e49E6548',
    shortToken:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    longSym:   'ARB',  shortSym: 'USDC',
  },
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GMXMarket {
  name:          string;
  gmToken:       string;
  gmPriceUSD:    number;         // current GM token price
  poolValueUSD:  number;         // total pool USD value
  gmTotalSupply: bigint;
  longBalRaw:    bigint;         // long token balance in GMX pool
  shortBalRaw:   bigint;         // short token balance
  longOI:        number;         // USD open interest long
  shortOI:       number;
  oiBalance:     number;         // long / (long + short), 0.5 = neutral
  oiRiskFlag:    boolean;        // true if skew > 40%
  feeAPY:        number;         // estimated from subgraph (0 if unavailable)
  updatedAt:     number;
}

export interface GMXUserPosition {
  market:        string;
  gmToken:       string;
  gmBalance:     bigint;
  positionUSD:   number;         // gmBalance × gmPriceUSD
  entryPriceUSD: number;         // stored at entry — needed for realized PnL
  oiBalance:     number;
}

// ── ABIs ──────────────────────────────────────────────────────────────────────

const MC3_ABI   = ['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)'];
const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
];

// ── OI data from GMX subgraph ─────────────────────────────────────────────────

async function fetchOIFromSubgraph(): Promise<Map<string, { longOI: number; shortOI: number; feeAPY: number }>> {
  const result = new Map<string, { longOI: number; shortOI: number; feeAPY: number }>();

  const query = `{
    marketInfos(first: 20) {
      marketToken
      longInterestUsd
      shortInterestUsd
      totalBorrowingFees
      poolValueMax
    }
  }`;

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    const res   = await fetch(GMX_GRAPHQL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query }),
      signal:  ctrl.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return result;
    const data = await res.json() as { data: { marketInfos: any[] } };

    for (const info of (data.data?.marketInfos ?? [])) {
      const addr   = (info.marketToken ?? '').toLowerCase();
      const entry  = Object.entries(GMX_MARKETS).find(
        ([, m]) => m.gmToken.toLowerCase() === addr
      );
      if (!entry) continue;

      const [name] = entry;
      const longOI  = Number(info.longInterestUsd  ?? 0) / 1e30;
      const shortOI = Number(info.shortInterestUsd ?? 0) / 1e30;
      const fees    = Number(info.totalBorrowingFees ?? 0) / 1e30;
      const pool    = Number(info.poolValueMax ?? 0) / 1e30;
      const feeAPY  = pool > 0 ? (fees / pool) * 365 * 100 : 0;

      result.set(name, { longOI, shortOI, feeAPY });
    }
  } catch { /* subgraph unavailable — caller uses neutral fallback */ }

  return result;
}

// ── Fetch all GMX markets ─────────────────────────────────────────────────────

export async function fetchGMXMarkets(
  provider: JsonRpcProvider,
  prices:   PriceMap,
): Promise<GMXMarket[]> {
  const mc    = new Contract(MULTICALL3, MC3_ABI, provider);
  const iface = new Interface(ERC20_ABI);
  const names = Object.keys(GMX_MARKETS);

  // Build batched calls:
  //   For each market: [longToken.balanceOf(gmToken), shortToken.balanceOf(gmToken), gmToken.totalSupply()]
  const calls: { target: string; allowFailure: boolean; callData: string }[] = [];
  for (const name of names) {
    const m = GMX_MARKETS[name];
    calls.push(
      { target: m.longToken,  allowFailure: true, callData: iface.encodeFunctionData('balanceOf',   [m.gmToken]) },
      { target: m.shortToken, allowFailure: true, callData: iface.encodeFunctionData('balanceOf',   [m.gmToken]) },
      { target: m.gmToken,    allowFailure: true, callData: iface.encodeFunctionData('totalSupply', []) },
    );
  }

  // Fetch OI concurrently with the on-chain call
  const [raw, oi] = await Promise.all([
    mc.aggregate3(calls).catch(() => [] as { success: boolean; returnData: string }[]),
    fetchOIFromSubgraph(),
  ]) as [{ success: boolean; returnData: string }[], Map<string, any>];

  const markets: GMXMarket[] = [];

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const m    = GMX_MARKETS[name];
    const base = i * 3;

    try {
      const longBalRaw  = decodeUint256(iface, raw[base],     'balanceOf');
      const shortBalRaw = decodeUint256(iface, raw[base + 1], 'balanceOf');
      const totalSupply = decodeUint256(iface, raw[base + 2], 'totalSupply');

      if (totalSupply === 0n) continue;

      const longDec  = m.longSym  === 'WBTC' ? 8  : 18;
      const shortDec = m.shortSym === 'USDC' || m.shortSym === 'USDT' ? 6 : 18;

      const longPrice  = getPrice(prices, m.longSym);
      const shortPrice = getPrice(prices, m.shortSym);

      const poolValueUSD = (Number(longBalRaw)  / 10 ** longDec  * longPrice)
                         + (Number(shortBalRaw) / 10 ** shortDec * shortPrice);

      const gmPriceUSD = poolValueUSD / (Number(totalSupply) / 1e18);

      // OI from subgraph or neutral fallback
      const oiData  = oi.get(name);
      const longOI  = oiData?.longOI  ?? 0;
      const shortOI = oiData?.shortOI ?? 0;
      const total   = longOI + shortOI;
      const oiBal   = total > 0 ? longOI / total : 0.5;
      const oiSkew  = Math.abs(oiBal - 0.5) * 2;

      markets.push({
        name, gmToken: m.gmToken,
        gmPriceUSD, poolValueUSD,
        gmTotalSupply: totalSupply,
        longBalRaw, shortBalRaw,
        longOI, shortOI,
        oiBalance:  oiBal,
        oiRiskFlag: oiSkew > 0.40,
        feeAPY:     oiData?.feeAPY ?? 0,
        updatedAt:  Date.now(),
      });
    } catch { /* skip this market */ }
  }

  return markets;
}

// ── Fetch user GMX positions ──────────────────────────────────────────────────

export async function fetchGMXUserPositions(
  userAddress: string,
  markets:     GMXMarket[],
  provider:    JsonRpcProvider,
): Promise<GMXUserPosition[]> {
  if (markets.length === 0) return [];

  const mc    = new Contract(MULTICALL3, MC3_ABI, provider);
  const iface = new Interface(ERC20_ABI);

  const calls = markets.map(m => ({
    target:       m.gmToken,
    allowFailure: true,
    callData:     iface.encodeFunctionData('balanceOf', [userAddress]),
  }));

  const positions: GMXUserPosition[] = [];

  try {
    const raw: { success: boolean; returnData: string }[] = await mc.aggregate3(calls);
    for (let i = 0; i < markets.length; i++) {
      const bal = decodeUint256(iface, raw[i], 'balanceOf');
      if (bal === 0n) continue;
      const market = markets[i];
      positions.push({
        market:        market.name,
        gmToken:       market.gmToken,
        gmBalance:     bal,
        positionUSD:   Number(bal) / 1e18 * market.gmPriceUSD,
        entryPriceUSD: market.gmPriceUSD,   // updated by caller at entry
        oiBalance:     market.oiBalance,
      });
    }
  } catch { /* multicall failed */ }

  return positions;
}

// ── Pre-execution verification ────────────────────────────────────────────────

export async function verifyGMXMarket(
  marketName:     string,
  expectedAPY:    number,
  provider:       JsonRpcProvider,
  prices:         PriceMap,
): Promise<{ ok: boolean; market: GMXMarket | null; error: string | null }> {
  const markets = await fetchGMXMarkets(provider, prices);
  const market  = markets.find(m => m.name === marketName);

  if (!market) return { ok: false, market: null, error: `GMX market ${marketName} not found` };
  if (market.poolValueUSD < 100_000) return { ok: false, market, error: 'Pool value too low — liquidity risk' };
  if (market.oiRiskFlag) return { ok: false, market, error: `OI heavily skewed: ${(market.oiBalance * 100).toFixed(1)}% long` };

  return { ok: true, market, error: null };
}

// ── Helper ────────────────────────────────────────────────────────────────────

function decodeUint256(
  iface: Interface,
  raw:   { success: boolean; returnData: string } | undefined,
  fn:    string,
): bigint {
  if (!raw?.success || !raw.returnData || raw.returnData === '0x') return 0n;
  try {
    return BigInt((iface.decodeFunctionResult(fn, raw.returnData)[0] as bigint).toString());
  } catch { return 0n; }
}
