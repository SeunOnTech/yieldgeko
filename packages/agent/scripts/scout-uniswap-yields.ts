import * as dotenv from 'dotenv';

dotenv.config();

const UNISWAP_V3_SUBGRAPH_URL = process.env.UNISWAP_V3_SUBGRAPH_URL;
const DEFAULT_MIN_TVL_USD = Number(process.env.UNISWAP_MIN_TVL_USD || '100000');
const DEFAULT_MIN_APR = Number(process.env.UNISWAP_MIN_APR || '0');
const DEFAULT_LIMIT = Number(process.env.UNISWAP_LIMIT || '100');
const DEFAULT_FETCH_LIMIT = Number(process.env.UNISWAP_FETCH_LIMIT || '250');

const STABLE_QUOTES = new Set([
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
]);

const MAJOR_BASE_TOKENS = new Set([
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
  '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f',
  '0x912ce59144191c1204e64559fe8253a0e49e6548',
  '0x0c880f6761f1af8d9aa9c466984b80dab9a8c9e8',
  '0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a',
  '0x5979d7b546e38e414f7e9822514be443a4800529',
  '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34',
  '0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2',
]);

type UniswapToken = {
  id: string;
  symbol: string;
  decimals: string;
};

type PoolDayData = {
  date: string;
  volumeUSD: string;
  feesUSD: string;
  tvlUSD: string;
};

type V3Pool = {
  id: string;
  feeTier: string;
  totalValueLockedUSD: string;
  token0Price: string;
  token1Price: string;
  token0: UniswapToken;
  token1: UniswapToken;
  poolDayData: PoolDayData[];
};

type GraphResponse = {
  data?: {
    pools?: V3Pool[];
  };
  errors?: Array<{ message: string }>;
};

type RankedPool = {
  pair: string;
  feeTierPct: number;
  stableQuote: string;
  priceUsd: number;
  tvlUsd: number;
  dayVolumeUsd: number;
  weekVolumeUsd: number;
  dayFeeApr: number;
  weekFeeApr: number;
  pool: string;
};

function formatUsdCompact(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}b`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toFixed(0);
}

function printTable(headers: string[], rows: string[][]) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] || '').length)),
  );

  const render = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index])).join(' | ');
  console.log(render(headers));
  console.log(widths.map((width) => '-'.repeat(width)).join('-|-'));
  rows.forEach((row) => console.log(render(row)));
}

async function fetchPools(): Promise<V3Pool[]> {
  if (!UNISWAP_V3_SUBGRAPH_URL) {
    throw new Error('UNISWAP_V3_SUBGRAPH_URL is required. Set it to your official Uniswap V3 Arbitrum query URL from The Graph.');
  }

  const query = `query Pools($limit: Int!) {
    pools(
      first: $limit
      orderBy: totalValueLockedUSD
      orderDirection: desc
      where: { totalValueLockedUSD_gt: "10000" }
    ) {
      id
      feeTier
      totalValueLockedUSD
      token0Price
      token1Price
      token0 {
        id
        symbol
        decimals
      }
      token1 {
        id
        symbol
        decimals
      }
      poolDayData(first: 7, orderBy: date, orderDirection: desc) {
        date
        volumeUSD
        feesUSD
        tvlUSD
      }
    }
  }`;

  const response = await fetch(UNISWAP_V3_SUBGRAPH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: { limit: DEFAULT_FETCH_LIMIT },
    }),
  });

  if (!response.ok) {
    throw new Error(`Uniswap query failed with ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as GraphResponse;
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((item) => item.message).join('; '));
  }

  return payload.data?.pools || [];
}

function normalizePools(pools: V3Pool[]): RankedPool[] {
  const ranked: RankedPool[] = [];

  for (const pool of pools) {
    const token0 = pool.token0.id.toLowerCase();
    const token1 = pool.token1.id.toLowerCase();
    const token0Stable = STABLE_QUOTES.has(token0);
    const token1Stable = STABLE_QUOTES.has(token1);
    const token0Major = MAJOR_BASE_TOKENS.has(token0);
    const token1Major = MAJOR_BASE_TOKENS.has(token1);

    if (!((token0Stable && token1Major) || (token1Stable && token0Major))) {
      continue;
    }

    const stableIsToken0 = token0Stable;
    const stableQuote = stableIsToken0 ? pool.token0.symbol : pool.token1.symbol;
    const baseSymbol = stableIsToken0 ? pool.token1.symbol : pool.token0.symbol;
    const priceUsd = stableIsToken0 ? Number(pool.token0Price) : Number(pool.token1Price);
    const tvlUsd = Number(pool.totalValueLockedUSD);

    if (!Number.isFinite(tvlUsd) || tvlUsd < DEFAULT_MIN_TVL_USD) {
      continue;
    }

    const latestDay = pool.poolDayData[0];
    const dayVolumeUsd = latestDay ? Number(latestDay.volumeUSD) : 0;
    const dayFeesUsd = latestDay ? Number(latestDay.feesUSD) : 0;
    const weekVolumeUsd = pool.poolDayData.reduce((sum, item) => sum + Number(item.volumeUSD || 0), 0);
    const weekFeesUsd = pool.poolDayData.reduce((sum, item) => sum + Number(item.feesUSD || 0), 0);

    const dayFeeApr = tvlUsd > 0 ? (dayFeesUsd / tvlUsd) * 365 * 100 : 0;
    const weekFeeApr = tvlUsd > 0 ? (weekFeesUsd / tvlUsd) * (365 / 7) * 100 : 0;

    if (!Number.isFinite(weekFeeApr) || weekFeeApr < DEFAULT_MIN_APR) {
      continue;
    }

    ranked.push({
      pair: `${baseSymbol}/${stableQuote}`,
      feeTierPct: Number(pool.feeTier) / 10000,
      stableQuote,
      priceUsd,
      tvlUsd,
      dayVolumeUsd,
      weekVolumeUsd,
      dayFeeApr,
      weekFeeApr,
      pool: pool.id,
    });
  }

  return ranked.sort((a, b) => b.weekFeeApr - a.weekFeeApr || b.tvlUsd - a.tvlUsd);
}

async function main() {
  console.log('🦎 YieldGeko: Uniswap Yield Scout v2.0\n');
  console.log(`[Source] The Graph indexed query: ${UNISWAP_V3_SUBGRAPH_URL ? 'configured' : 'missing'}`);
  console.log('[Scope] Major Arbitrum Uniswap V3 pools quoted against USDC, USDT, or DAI');

  const pools = await fetchPools();
  const ranked = normalizePools(pools);
  const displayed = ranked.slice(0, DEFAULT_LIMIT);

  console.log('\nUniswap V3 Yield Table');
  console.log('----------------------');

  if (displayed.length === 0) {
    console.log('No pools passed the current filters.');
  } else {
    printTable(
      ['#', 'Pair', 'Fee', 'Price', 'TVL', '24H Vol', '7D Vol', '24H APR', '7D APR', 'Pool'],
      displayed.map((row, index) => [
        String(index + 1),
        row.pair,
        `${row.feeTierPct.toFixed(2)}%`,
        `$${row.priceUsd.toFixed(4)}`,
        formatUsdCompact(row.tvlUsd),
        formatUsdCompact(row.dayVolumeUsd),
        formatUsdCompact(row.weekVolumeUsd),
        `${row.dayFeeApr.toFixed(2)}%`,
        `${row.weekFeeApr.toFixed(2)}%`,
        `${row.pool.slice(0, 6)}...${row.pool.slice(-4)}`,
      ]),
    );
  }

  console.log('\nSummary');
  console.log('-------');
  console.log(`Fetched pools from subgraph    : ${pools.length}`);
  console.log(`Displayed pools                : ${displayed.length}`);
  console.log(`TVL floor filter               : $${DEFAULT_MIN_TVL_USD.toLocaleString()}`);
  console.log(`APR floor filter               : ${DEFAULT_MIN_APR}%`);
  console.log('Recent windows                 : latest 24h row and latest 7 daily rows');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
