/// <reference types="node" />

type UserStrategyFit =
  | 'balanced_income'
  | 'aggressive_yield'
  | 'eth_beta'
  | 'advanced';

interface Opportunity {
  id: string;
  name: string;
  protocol: string;
  chain: string;
  strategyClass: 'structured_yield' | 'market_making';
  headlineApyPct: number;
  netApyPct: number | null;
  liquidityUsd: number | null;
  tvlUsd: number | null;
  assetClass: 'stable' | 'eth' | 'mixed' | 'unknown';
  lockupDays: number | null;
  maturityDate: string | null;
  requiresActiveManagement: boolean;
  userStrategyFit: UserStrategyFit[];
  riskFlags: string[];
  source: 'official_api';
  sourceDetail: string;
  raw: Record<string, unknown>;
}

interface PendleMarketResponse {
  total: number;
  limit: number;
  skip: number;
  results: PendleMarket[];
}

interface PendleMarket {
  name: string;
  address: string;
  expiry: string;
  chainId: number;
  categoryIds: string[];
  details: {
    liquidity: number;
    totalTvl: number;
    aggregatedApy: number;
    impliedApy: number;
    underlyingApy: number;
  };
}

interface HyperliquidVaultDetails {
  name: string;
  vaultAddress: string;
  portfolio: Array<[string, HyperliquidPortfolioWindow]>;
}

interface HyperliquidPortfolioWindow {
  accountValueHistory: Array<[number, string]>;
}

const PENDLE_MARKETS_URL = 'https://api-v2.pendle.finance/core/v2/markets/all';
const HYPERLIQUID_INFO_ENDPOINT = 'https://api.hyperliquid.xyz/info';
const HLP_VAULT_ADDRESS = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';
const ARBITRUM_CHAIN_ID = 42161;

const MIN_LIQUIDITY_USD = Number(process.env.SCOUT_MIN_LIQUIDITY_USD ?? 100_000);
const MIN_APY = Number(process.env.SCOUT_MIN_APY ?? 0.02);
const LIMIT = Number(process.env.SCOUT_LIMIT ?? 12);

function inferAssetClass(name: string, categories: string[] = []): Opportunity['assetClass'] {
  const lowered = name.toLowerCase();
  if (categories.includes('stables') || /(usd|usdc|usdt|usde|dai|susd)/.test(lowered)) return 'stable';
  if (categories.includes('eth') || /(eth|weeth|wsteth|reth|ezeth|unieth|rseth)/.test(lowered)) return 'eth';
  if (categories.length > 1) return 'mixed';
  return 'unknown';
}

function classifyPendleFit(name: string, categories: string[], headlineApy: number): UserStrategyFit[] {
  const fits = new Set<UserStrategyFit>(['aggressive_yield']);
  const assetClass = inferAssetClass(name, categories);
  if (assetClass === 'stable' && headlineApy >= 0.06) fits.add('balanced_income');
  if (assetClass === 'eth') fits.add('eth_beta');
  fits.add('advanced');
  return [...fits];
}

function classifyHyperliquidFit(headlineApy: number): UserStrategyFit[] {
  const fits = new Set<UserStrategyFit>(['advanced']);
  if (headlineApy >= 0.10) fits.add('aggressive_yield');
  return [...fits];
}

function annualizeWindowReturn(history: Array<[number, string]>, days: number): number | null {
  if (!Array.isArray(history) || history.length < 2) return null;
  const first = Number(history[0]?.[1] ?? 0);
  const last = Number(history[history.length - 1]?.[1] ?? 0);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0 || last <= 0) return null;
  return ((last - first) / first) * (365 / days);
}

function selectConservativeAnnualizedReturn(
  weeklyAnnualizedApy: number | null,
  monthlyAnnualizedApy: number | null
): number {
  if (weeklyAnnualizedApy == null && monthlyAnnualizedApy == null) return 0;
  if (weeklyAnnualizedApy == null) return monthlyAnnualizedApy ?? 0;
  if (monthlyAnnualizedApy == null) return weeklyAnnualizedApy;
  return Math.min(weeklyAnnualizedApy, monthlyAnnualizedApy);
}

function latestAccountValue(history: Array<[number, string]>): number | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  return Number(history[history.length - 1]?.[1] ?? 0);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} for ${url}`);
  }
  return (await response.json()) as T;
}

async function discoverPendleStructuredYield(): Promise<Opportunity[]> {
  const pageSize = 100;
  const firstPage = await fetchJson<PendleMarketResponse>(`${PENDLE_MARKETS_URL}?limit=${pageSize}&skip=0`);
  const pages = Math.ceil(firstPage.total / pageSize);
  const markets = [...firstPage.results];

  for (let page = 1; page < pages; page++) {
    const nextPage = await fetchJson<PendleMarketResponse>(
      `${PENDLE_MARKETS_URL}?limit=${pageSize}&skip=${page * pageSize}`
    );
    markets.push(...nextPage.results);
  }

  return markets
    .filter((market) => market.chainId === ARBITRUM_CHAIN_ID)
    .filter((market) => market.details.aggregatedApy >= MIN_APY)
    .filter((market) => market.details.liquidity >= MIN_LIQUIDITY_USD)
    .sort((left, right) => right.details.aggregatedApy - left.details.aggregatedApy)
    .slice(0, LIMIT)
    .map((market) => {
      const riskFlags = {
        maturityBound: true,
        pointsDriven: market.categoryIds.includes('points'),
        limitedLiquidity: market.details.liquidity < 500_000,
      };

      return {
        id: `pendle-${market.address.toLowerCase()}`,
        name: market.name,
        protocol: 'pendle',
        chain: 'arbitrum',
        strategyClass: 'structured_yield',
        headlineApyPct: Number((market.details.aggregatedApy * 100).toFixed(2)),
        netApyPct: null,
        liquidityUsd: market.details.liquidity,
        tvlUsd: market.details.totalTvl,
        assetClass: inferAssetClass(market.name, market.categoryIds),
        lockupDays: null,
        maturityDate: market.expiry,
        requiresActiveManagement: false,
        userStrategyFit: classifyPendleFit(market.name, market.categoryIds, market.details.aggregatedApy),
        riskFlags: Object.entries(riskFlags)
          .filter(([, enabled]) => enabled)
          .map(([flag]) => flag),
        source: 'official_api',
        sourceDetail: 'Pendle official market API',
        raw: {
          address: market.address,
          categories: market.categoryIds,
          impliedApy: market.details.impliedApy,
          underlyingApy: market.details.underlyingApy,
        },
      } satisfies Opportunity;
    });
}

async function discoverHyperliquidHlp(): Promise<Opportunity[]> {
  const details = await fetchJson<HyperliquidVaultDetails>(HYPERLIQUID_INFO_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'vaultDetails', vaultAddress: HLP_VAULT_ADDRESS }),
  });

  const weekWindow = details.portfolio.find(([label]) => label === 'week')?.[1];
  const monthWindow = details.portfolio.find(([label]) => label === 'month')?.[1];
  const weeklyAnnualizedApy = annualizeWindowReturn(weekWindow?.accountValueHistory ?? [], 7);
  const monthlyAnnualizedApy = annualizeWindowReturn(monthWindow?.accountValueHistory ?? [], 30);
  const headlineApy = selectConservativeAnnualizedReturn(weeklyAnnualizedApy, monthlyAnnualizedApy);
  const tvlUsd =
    latestAccountValue(weekWindow?.accountValueHistory ?? []) ??
    latestAccountValue(monthWindow?.accountValueHistory ?? []) ??
    null;

  return [
    {
      id: `hyperliquid-${details.vaultAddress.toLowerCase()}`,
      name: details.name,
      protocol: 'hyperliquid',
      chain: 'hyperliquid-l1',
      strategyClass: 'market_making',
      headlineApyPct: Number((headlineApy * 100).toFixed(2)),
      netApyPct: monthlyAnnualizedApy != null ? Number((monthlyAnnualizedApy * 100).toFixed(2)) : null,
      liquidityUsd: tvlUsd,
      tvlUsd,
      assetClass: 'stable',
      lockupDays: 4,
      maturityDate: null,
      requiresActiveManagement: false,
      userStrategyFit: classifyHyperliquidFit(headlineApy),
      riskFlags: ['lockup', 'pnlVolatility'],
      source: 'official_api',
      sourceDetail: 'Hyperliquid official info API (conservative annualized realized return)',
      raw: {
        vaultAddress: details.vaultAddress,
        weeklyAnnualizedApy,
        monthlyAnnualizedApy,
      },
    },
  ];
}

async function main(): Promise<void> {
  const [pendle, hyperliquid] = await Promise.all([
    discoverPendleStructuredYield(),
    discoverHyperliquidHlp(),
  ]);

  const opportunities = [...pendle, ...hyperliquid].sort((a, b) => b.headlineApyPct - a.headlineApyPct);

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        filters: {
          minLiquidityUsd: MIN_LIQUIDITY_USD,
          minHeadlineApy: MIN_APY,
          maxResults: LIMIT,
        },
        opportunities,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[opportunity-scout] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
