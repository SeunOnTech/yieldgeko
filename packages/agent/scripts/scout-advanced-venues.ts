import { createPublicClient, getAddress, http, parseAbi, type Address } from 'viem';
import { arbitrum } from 'viem/chains';
import * as dotenv from 'dotenv';

dotenv.config();

const RPC_URL = process.env.ZERO_G_RPC || 'https://arb1.arbitrum.io/rpc';
const GMX_GRAPHQL_URL = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
const HLP_VAULT_ADDRESS = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';

const EXPLORATORY_MIN_APY = 20;
const CURATED_MIN_APY = 40;
const CURATED_MAX_APY = 100;
const REAL_LIQUIDITY_FLOOR_USD = 1_000_000;

const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
]);

type StrategyClass = 'perps_liquidity' | 'vault_strategy';

type VenueCandidate = {
  protocol: string;
  venue: string;
  strategyClass: StrategyClass;
  headlineApy: number;
  liquidityUsd: number;
  executionVenue: string;
  yieldSource: string;
  notes: string[];
};

type RejectedVenue = {
  protocol: string;
  venue: string;
  headlineApy: number;
  liquidityUsd: number;
  reason: string;
  notes: string[];
};

type CoverageIssue = {
  source: string;
  status: 'missing_config' | 'query_failed';
  reason: string;
};

type VaultMonitor = {
  protocol: string;
  venue: string;
  liquidityUsd: number;
  dayReturnPct: number;
  weekReturnPct: number;
  monthReturnPct: number;
  annualizedWeekPct: number;
  annualizedMonthPct: number;
  signal: 'positive' | 'negative' | 'mixed';
  notes: string[];
};

type GmxAprSnapshot = {
  address: string;
  aprByFee: string;
  aprByBorrowingFee: string;
  snapshotTimestamp: number;
  entityType: 'Market' | 'Glv';
};

type GmxMarketInfo = {
  marketTokenAddress: string;
  indexTokenAddress: string;
  longTokenAddress: string;
  shortTokenAddress: string;
  poolValue: string;
  isDisabled: boolean;
};

type GmxGlv = {
  glvTokenAddress: string;
  longTokenAddress: string;
  shortTokenAddress: string;
  poolValue: string;
};

type GmxGraphqlResponse = {
  data?: {
    aprSnapshots?: GmxAprSnapshot[];
    marketInfos?: GmxMarketInfo[];
    glvs?: GmxGlv[];
  };
  errors?: Array<{ message: string }>;
};

type GmxCollectedData = {
  aprSnapshots: GmxAprSnapshot[];
  marketInfos: GmxMarketInfo[];
  glvs: GmxGlv[];
};

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

type V3LikePool = {
  id: string;
  totalValueLockedUSD?: string;
  feeTier?: string;
  feesUSD?: string;
  token0?: { symbol?: string };
  token1?: { symbol?: string };
  poolDayData?: Array<{
    feesUSD?: string;
    tvlUSD?: string;
    volumeUSD?: string;
    date?: number;
  }>;
};

type V3LikePoolsResponse = {
  pools?: V3LikePool[];
};

type V2LikePair = {
  id: string;
  reserveUSD?: string;
  token0?: { symbol?: string };
  token1?: { symbol?: string };
  pairDayDatas?: Array<{
    dailyVolumeUSD?: string;
    reserveUSD?: string;
    date?: number;
  }>;
};

type V2LikePairsResponse = {
  pairs?: V2LikePair[];
};

type HyperliquidVaultWindow = {
  accountValueHistory: Array<[number, string]>;
  pnlHistory: Array<[number, string]>;
};

type HyperliquidVaultDetailsResponse = {
  name: string;
  vaultAddress: string;
  leader: string;
  description: string;
  portfolio: Array<[string, HyperliquidVaultWindow]>;
};

const symbolCache = new Map<string, string>();

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatPct(value: number, width = 8): string {
  return `${value.toFixed(2)}%`.padStart(width);
}

function formatUsdCompact(value: number, width = 10): string {
  if (!Number.isFinite(value)) return 'n/a'.padStart(width);
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}b`.padStart(width);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`.padStart(width);
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`.padStart(width);
  return `${value.toFixed(0)}`.padStart(width);
}

function truncate(value: string, max = 28): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function printSectionTitle(title: string, subtitle?: string) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
  if (subtitle) {
    console.log(subtitle);
  }
}

function parseScaledPercent(raw: string): number {
  return (Number(raw) / 1e30) * 100;
}

function parseScaledUsd(raw: string): number {
  return Number(raw) / 1e30;
}

function parseNumeric(value: string): number {
  return Number(value);
}

function computePeriodReturn(start: number, end: number): number {
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(end)) {
    return 0;
  }
  return ((end - start) / start) * 100;
}

function annualizeReturn(periodReturnPct: number, days: number): number {
  const periodFactor = 1 + periodReturnPct / 100;
  if (periodFactor <= 0) {
    return -100;
  }
  return (Math.pow(periodFactor, 365 / days) - 1) * 100;
}

async function readTokenSymbol(client: ReturnType<typeof createPublicClient>, address: string): Promise<string> {
  const normalized = getAddress(address).toLowerCase();
  const cached = symbolCache.get(normalized);
  if (cached) return cached;

  try {
    const symbol = await client.readContract({
      address: getAddress(address),
      abi: erc20Abi,
      functionName: 'symbol',
    });
    symbolCache.set(normalized, symbol);
    return symbol;
  } catch {
    const fallback = `${address.slice(0, 6)}...${address.slice(-4)}`;
    symbolCache.set(normalized, fallback);
    return fallback;
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} from ${url}`);
  }
  return (await response.json()) as T;
}

async function fetchGraphql<T>(url: string, query: string): Promise<T> {
  const payload = await fetchJson<GraphqlResponse<T>>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((item) => item.message).join('; '));
  }

  if (!payload.data) {
    throw new Error(`No data returned from ${url}`);
  }

  return payload.data;
}

async function fetchGmx<T>(query: string): Promise<T> {
  const payload = await fetchJson<GmxGraphqlResponse>(GMX_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((item) => item.message).join('; '));
  }

  return payload.data as T;
}

function classifyCandidate(
  protocol: string,
  venue: string,
  strategyClass: StrategyClass,
  headlineApy: number,
  liquidityUsd: number,
  executionVenue: string,
  yieldSource: string,
  notes: string[],
): { curated?: VenueCandidate; exploratory?: VenueCandidate; rejected?: RejectedVenue } {
  if (headlineApy < EXPLORATORY_MIN_APY) {
    return {};
  }

  if (liquidityUsd < REAL_LIQUIDITY_FLOOR_USD) {
    return {
      rejected: {
        protocol,
        venue,
        headlineApy,
        liquidityUsd,
        reason: 'real liquidity below floor',
        notes,
      },
    };
  }

  const candidate: VenueCandidate = {
    protocol,
    venue,
    strategyClass,
    headlineApy,
    liquidityUsd,
    executionVenue,
    yieldSource,
    notes,
  };

  if (headlineApy >= CURATED_MIN_APY && headlineApy <= CURATED_MAX_APY) {
    return { curated: candidate };
  }

  if (headlineApy >= EXPLORATORY_MIN_APY && headlineApy < CURATED_MIN_APY) {
    return { exploratory: candidate };
  }

  return {
    rejected: {
      protocol,
      venue,
      headlineApy,
      liquidityUsd,
      reason: `headline APY outside curated target band ${CURATED_MIN_APY}%–${CURATED_MAX_APY}%`,
      notes,
    },
  };
}

async function collectGmxVenues(
  client: ReturnType<typeof createPublicClient>,
): Promise<{ curated: VenueCandidate[]; exploratory: VenueCandidate[]; rejected: RejectedVenue[] }> {
  const raw = await fetchGmx<GmxCollectedData>(
    `query {
      aprSnapshots(limit: 250, orderBy: [snapshotTimestamp_DESC]) {
        address
        aprByFee
        aprByBorrowingFee
        snapshotTimestamp
        entityType
      }
      marketInfos(limit: 50, orderBy: [poolValue_DESC], where: { isDisabled_eq: false }) {
        marketTokenAddress
        indexTokenAddress
        longTokenAddress
        shortTokenAddress
        poolValue
        isDisabled
      }
      glvs(limit: 20, orderBy: [poolValue_DESC]) {
        glvTokenAddress
        longTokenAddress
        shortTokenAddress
        poolValue
      }
    }`,
  );
  const data: GmxCollectedData = {
    aprSnapshots: raw.aprSnapshots ?? [],
    marketInfos: raw.marketInfos ?? [],
    glvs: raw.glvs ?? [],
  };

  const latestByKey = new Map<string, GmxAprSnapshot>();
  for (const snapshot of data.aprSnapshots) {
    const key = `${snapshot.entityType}:${snapshot.address.toLowerCase()}`;
    if (!latestByKey.has(key)) {
      latestByKey.set(key, snapshot);
    }
  }

  const curated: VenueCandidate[] = [];
  const exploratory: VenueCandidate[] = [];
  const rejected: RejectedVenue[] = [];

  for (const market of data.marketInfos) {
    const snapshot = latestByKey.get(`Market:${market.marketTokenAddress.toLowerCase()}`);
    if (!snapshot) continue;

    const totalApy = parseScaledPercent(snapshot.aprByFee) + parseScaledPercent(snapshot.aprByBorrowingFee);
    const liquidityUsd = parseScaledUsd(market.poolValue);
    const [indexSymbol, longSymbol, shortSymbol] = await Promise.all([
      readTokenSymbol(client, market.indexTokenAddress),
      readTokenSymbol(client, market.longTokenAddress),
      readTokenSymbol(client, market.shortTokenAddress),
    ]);

    const venue = `GM ${indexSymbol}/${shortSymbol}`;
    const notes = [
      `marketToken=${market.marketTokenAddress}`,
      `index=${indexSymbol}`,
      `long=${longSymbol}`,
      `short=${shortSymbol}`,
      `aprByFee=${round(parseScaledPercent(snapshot.aprByFee))}%`,
      `aprByBorrowing=${round(parseScaledPercent(snapshot.aprByBorrowingFee))}%`,
    ];

    const classified = classifyCandidate(
      'GMX V2',
      venue,
      'perps_liquidity',
      totalApy,
      liquidityUsd,
      'GMX GM pool',
      'trading fees + borrowing fees from GM liquidity',
      notes,
    );

    if (classified.curated) curated.push(classified.curated);
    if (classified.exploratory) exploratory.push(classified.exploratory);
    if (classified.rejected) rejected.push(classified.rejected);
  }

  for (const glv of data.glvs) {
    const snapshot = latestByKey.get(`Glv:${glv.glvTokenAddress.toLowerCase()}`);
    if (!snapshot) continue;

    const totalApy = parseScaledPercent(snapshot.aprByFee) + parseScaledPercent(snapshot.aprByBorrowingFee);
    const liquidityUsd = parseScaledUsd(glv.poolValue);
    const [longSymbol, shortSymbol] = await Promise.all([
      readTokenSymbol(client, glv.longTokenAddress),
      readTokenSymbol(client, glv.shortTokenAddress),
    ]);

    const venue = `GLV ${longSymbol}/${shortSymbol}`;
    const notes = [
      `glvToken=${glv.glvTokenAddress}`,
      `long=${longSymbol}`,
      `short=${shortSymbol}`,
      `aprByFee=${round(parseScaledPercent(snapshot.aprByFee))}%`,
      `aprByBorrowing=${round(parseScaledPercent(snapshot.aprByBorrowingFee))}%`,
    ];

    const classified = classifyCandidate(
      'GMX V2',
      venue,
      'vault_strategy',
      totalApy,
      liquidityUsd,
      'GMX GLV pool',
      'GLV fee share + borrowing fee share across supported GM markets',
      notes,
    );

    if (classified.curated) curated.push(classified.curated);
    if (classified.exploratory) exploratory.push(classified.exploratory);
    if (classified.rejected) rejected.push(classified.rejected);
  }

  curated.sort((a, b) => b.headlineApy - a.headlineApy || b.liquidityUsd - a.liquidityUsd);
  exploratory.sort((a, b) => b.headlineApy - a.headlineApy || b.liquidityUsd - a.liquidityUsd);
  rejected.sort((a, b) => b.headlineApy - a.headlineApy || b.liquidityUsd - a.liquidityUsd);

  return { curated, exploratory, rejected };
}

async function collectHyperliquidVaultMonitor(): Promise<VaultMonitor> {
  const payload = await fetchJson<HyperliquidVaultDetailsResponse>(HYPERLIQUID_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'vaultDetails',
      vaultAddress: HLP_VAULT_ADDRESS,
    }),
  });

  const windowMap = new Map(payload.portfolio);
  const day = windowMap.get('day');
  const week = windowMap.get('week');
  const month = windowMap.get('month');

  if (!day || !week || !month) {
    throw new Error('Hyperliquid HLP response did not contain day/week/month windows');
  }

  const dayStart = parseNumeric(day.accountValueHistory[0][1]);
  const dayEnd = parseNumeric(day.accountValueHistory[day.accountValueHistory.length - 1][1]);
  const weekStart = parseNumeric(week.accountValueHistory[0][1]);
  const weekEnd = parseNumeric(week.accountValueHistory[week.accountValueHistory.length - 1][1]);
  const monthStart = parseNumeric(month.accountValueHistory[0][1]);
  const monthEnd = parseNumeric(month.accountValueHistory[month.accountValueHistory.length - 1][1]);

  const dayReturnPct = computePeriodReturn(dayStart, dayEnd);
  const weekReturnPct = computePeriodReturn(weekStart, weekEnd);
  const monthReturnPct = computePeriodReturn(monthStart, monthEnd);
  const annualizedWeekPct = annualizeReturn(weekReturnPct, 7);
  const annualizedMonthPct = annualizeReturn(monthReturnPct, 30);

  const signal: VaultMonitor['signal'] =
    dayReturnPct > 0 && weekReturnPct > 0 && monthReturnPct > 0
      ? 'positive'
      : dayReturnPct < 0 && weekReturnPct < 0 && monthReturnPct < 0
        ? 'negative'
        : 'mixed';

  return {
    protocol: 'Hyperliquid',
    venue: payload.name,
    liquidityUsd: weekEnd,
    dayReturnPct,
    weekReturnPct,
    monthReturnPct,
    annualizedWeekPct,
    annualizedMonthPct,
    signal,
    notes: [
      `vault=${payload.vaultAddress}`,
      `leader=${payload.leader}`,
      `description=${payload.description}`,
      `dayPnl=${day.pnlHistory[day.pnlHistory.length - 1]?.[1] || 'n/a'}`,
      `weekPnl=${week.pnlHistory[week.pnlHistory.length - 1]?.[1] || 'n/a'}`,
      `monthPnl=${month.pnlHistory[month.pnlHistory.length - 1]?.[1] || 'n/a'}`,
    ],
  };
}

async function collectConfiguredDexSources(): Promise<{
  curated: VenueCandidate[];
  exploratory: VenueCandidate[];
  rejected: RejectedVenue[];
  issues: CoverageIssue[];
}> {
  const curated: VenueCandidate[] = [];
  const exploratory: VenueCandidate[] = [];
  const rejected: RejectedVenue[] = [];
  const issues: CoverageIssue[] = [];

  const v3LikeSources = [
    { env: 'UNISWAP_V3_SUBGRAPH_URL', protocol: 'Uniswap V3' },
    { env: 'UNISWAP_V4_SUBGRAPH_URL', protocol: 'Uniswap V4' },
    { env: 'CAMELOT_V3_SUBGRAPH_URL', protocol: 'Camelot V3' },
  ] as const;

  for (const source of v3LikeSources) {
    const url = process.env[source.env];
    if (!url) {
      issues.push({
        source: source.protocol,
        status: 'missing_config',
        reason: `set ${source.env} to the official indexed endpoint URL`,
      });
      continue;
    }

    try {
      const data = await fetchGraphql<V3LikePoolsResponse>(
        url,
        `query {
          pools(first: 50, orderBy: totalValueLockedUSD, orderDirection: desc) {
            id
            totalValueLockedUSD
            feeTier
            feesUSD
            token0 { symbol }
            token1 { symbol }
            poolDayData(first: 1, orderBy: date, orderDirection: desc) {
              feesUSD
              tvlUSD
              volumeUSD
              date
            }
          }
        }`,
      );

      for (const pool of data.pools || []) {
        const latest = pool.poolDayData?.[0];
        if (!latest) continue;

        const tvlUsd = Number(latest.tvlUSD || pool.totalValueLockedUSD || 0);
        const dailyFeesUsd = Number(latest.feesUSD || 0);
        if (!Number.isFinite(tvlUsd) || tvlUsd <= 0 || !Number.isFinite(dailyFeesUsd) || dailyFeesUsd <= 0) {
          continue;
        }

        const headlineApy = (dailyFeesUsd * 365 / tvlUsd) * 100;
        const token0 = pool.token0?.symbol || 'token0';
        const token1 = pool.token1?.symbol || 'token1';
        const feeTierBps = pool.feeTier ? Number(pool.feeTier) / 10000 : null;
        const venue = `${token0}/${token1}${feeTierBps ? ` (${feeTierBps}%)` : ''}`;
        const notes = [
          `pool=${pool.id}`,
          `dailyFeesUsd=${round(dailyFeesUsd, 0)}`,
          `dailyVolumeUsd=${round(Number(latest.volumeUSD || 0), 0)}`,
          `tvlUsd=${round(tvlUsd, 0)}`,
        ];

        const classified = classifyCandidate(
          source.protocol,
          venue,
          'perps_liquidity',
          headlineApy,
          tvlUsd,
          'DEX LP position',
          'recent fee generation relative to TVL',
          notes,
        );

        if (classified.curated) curated.push(classified.curated);
        if (classified.exploratory) exploratory.push(classified.exploratory);
        if (classified.rejected) rejected.push(classified.rejected);
      }
    } catch (error) {
      issues.push({
        source: source.protocol,
        status: 'query_failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const camelotV2Url = process.env.CAMELOT_V2_SUBGRAPH_URL;
  const camelotV2FeeBps = process.env.CAMELOT_V2_FEE_RATE_BPS;
  if (!camelotV2Url) {
    issues.push({
      source: 'Camelot V2',
      status: 'missing_config',
      reason: 'set CAMELOT_V2_SUBGRAPH_URL to the official indexed endpoint URL',
    });
  } else if (!camelotV2FeeBps) {
    issues.push({
      source: 'Camelot V2',
      status: 'missing_config',
      reason: 'set CAMELOT_V2_FEE_RATE_BPS so APR can be computed from official daily volume safely',
    });
  } else {
    try {
      const feeRate = Number(camelotV2FeeBps) / 10_000;
      const data = await fetchGraphql<V2LikePairsResponse>(
        camelotV2Url,
        `query {
          pairs(first: 50, orderBy: reserveUSD, orderDirection: desc) {
            id
            reserveUSD
            token0 { symbol }
            token1 { symbol }
            pairDayDatas(first: 1, orderBy: date, orderDirection: desc) {
              dailyVolumeUSD
              reserveUSD
              date
            }
          }
        }`,
      );

      for (const pair of data.pairs || []) {
        const latest = pair.pairDayDatas?.[0];
        if (!latest) continue;

        const tvlUsd = Number(latest.reserveUSD || pair.reserveUSD || 0);
        const dailyVolumeUsd = Number(latest.dailyVolumeUSD || 0);
        if (!Number.isFinite(tvlUsd) || tvlUsd <= 0 || !Number.isFinite(dailyVolumeUsd) || dailyVolumeUsd <= 0) {
          continue;
        }

        const headlineApy = ((dailyVolumeUsd * feeRate) * 365 / tvlUsd) * 100;
        const token0 = pair.token0?.symbol || 'token0';
        const token1 = pair.token1?.symbol || 'token1';
        const venue = `${token0}/${token1}`;
        const notes = [
          `pair=${pair.id}`,
          `dailyVolumeUsd=${round(dailyVolumeUsd, 0)}`,
          `tvlUsd=${round(tvlUsd, 0)}`,
          `feeRate=${feeRate * 100}%`,
        ];

        const classified = classifyCandidate(
          'Camelot V2',
          venue,
          'perps_liquidity',
          headlineApy,
          tvlUsd,
          'DEX LP position',
          'recent fee generation estimated from official daily volume and configured fee rate',
          notes,
        );

        if (classified.curated) curated.push(classified.curated);
        if (classified.exploratory) exploratory.push(classified.exploratory);
        if (classified.rejected) rejected.push(classified.rejected);
      }
    } catch (error) {
      issues.push({
        source: 'Camelot V2',
        status: 'query_failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  curated.sort((a, b) => b.headlineApy - a.headlineApy || b.liquidityUsd - a.liquidityUsd);
  exploratory.sort((a, b) => b.headlineApy - a.headlineApy || b.liquidityUsd - a.liquidityUsd);
  rejected.sort((a, b) => b.headlineApy - a.headlineApy || b.liquidityUsd - a.liquidityUsd);

  return { curated, exploratory, rejected, issues };
}

function collectCoverageIssues(): CoverageIssue[] {
  const issues: CoverageIssue[] = [];

  return issues;
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

function printVenueSection(title: string, subtitle: string, candidates: VenueCandidate[]) {
  printSectionTitle(title, subtitle);
  if (candidates.length === 0) {
    console.log('None found.');
    return;
  }

  printTable(
    ['#', 'Protocol', 'Class', 'Venue', 'APY', 'TVL', 'Route', 'Yield Source'],
    candidates.map((item, index) => [
      String(index + 1),
      item.protocol,
      item.strategyClass,
      truncate(item.venue, 30),
      `${item.headlineApy.toFixed(2)}%`,
      formatUsdCompact(item.liquidityUsd, 0),
      truncate(item.executionVenue, 18),
      truncate(item.yieldSource, 34),
    ]),
  );
}

function printRejectedSection(rejected: RejectedVenue[]) {
  printSectionTitle(
    'Rejected High-Yield Reads',
    'These came from official sources, but they are outside the current curated band or fail liquidity realism.',
  );

  if (rejected.length === 0) {
    console.log('None found.');
    return;
  }

  printTable(
    ['#', 'Protocol', 'Venue', 'APY', 'TVL', 'Rejected Because'],
    rejected.slice(0, 10).map((item, index) => [
      String(index + 1),
      item.protocol,
      truncate(item.venue, 30),
      `${item.headlineApy.toFixed(2)}%`,
      formatUsdCompact(item.liquidityUsd, 0),
      truncate(item.reason, 54),
    ]),
  );
}

function printVaultMonitor(vault: VaultMonitor) {
  printSectionTitle(
    'Advanced Vault Monitor',
    'Tracked separately from APR venues because the realized return profile is path-dependent and not a simple pool APY.',
  );
  printTable(
    ['Protocol', 'Vault', 'TVL', '1D', '7D', '30D', '7D Ann.', '30D Ann.', 'Signal'],
    [[
      vault.protocol,
      truncate(vault.venue, 32),
      formatUsdCompact(vault.liquidityUsd, 0),
      `${vault.dayReturnPct.toFixed(2)}%`,
      `${vault.weekReturnPct.toFixed(2)}%`,
      `${vault.monthReturnPct.toFixed(2)}%`,
      `${vault.annualizedWeekPct.toFixed(2)}%`,
      `${vault.annualizedMonthPct.toFixed(2)}%`,
      vault.signal,
    ]],
  );
}

function printCoverageIssues(issues: CoverageIssue[]) {
  printSectionTitle(
    'Source Coverage Gaps',
    'These are the official-source gaps still blocking a fuller Uniswap/Camelot advanced venue view.',
  );

  if (issues.length === 0) {
    console.log('None.');
    return;
  }

  printTable(
    ['Source', 'Status', 'What Is Needed'],
    issues.map((issue) => [
      issue.source,
      issue.status,
      truncate(issue.reason, 72),
    ]),
  );
}

async function main() {
  console.log('🦎 YieldGeko: Advanced Venue Scout v1.0\n');
  console.log(`[Network] Connected to: ${RPC_URL}`);
  console.log(`[Targets] Curated advanced venues ${CURATED_MIN_APY}%–${CURATED_MAX_APY}% | exploratory band ${EXPLORATORY_MIN_APY}%–<${CURATED_MIN_APY}%`);

  const client = createPublicClient({
    chain: arbitrum,
    transport: http(RPC_URL),
  });

  const chainId = await client.getChainId();
  console.log(`[Network] Verified Chain ID: ${chainId} (Expected 42161)`);
  if (chainId !== 42161) {
    throw new Error('Not connected to Arbitrum mainnet');
  }

  const [gmx, dex, hlpVault] = await Promise.all([
    collectGmxVenues(client),
    collectConfiguredDexSources(),
    collectHyperliquidVaultMonitor(),
  ]);

  const coverageIssues = [...dex.issues, ...collectCoverageIssues()];
  const curated = [...gmx.curated, ...dex.curated].sort((a, b) => b.headlineApy - a.headlineApy || b.liquidityUsd - a.liquidityUsd);
  const exploratory = [...gmx.exploratory, ...dex.exploratory].sort((a, b) => b.headlineApy - a.headlineApy || b.liquidityUsd - a.liquidityUsd);
  const rejected = [...gmx.rejected, ...dex.rejected].sort((a, b) => b.headlineApy - a.headlineApy || b.liquidityUsd - a.liquidityUsd);

  printVenueSection(
    'Curated 40%-100% Advanced Venues',
    'These are higher-complexity opportunities from official sources that currently clear both the target APY band and the liquidity floor.',
    curated,
  );
  printVenueSection(
    'Exploratory 20%-40% Advanced Venues',
    'These do not hit the 40% target, but they are still material non-passive yield surfaces worth tracking.',
    exploratory,
  );
  printVaultMonitor(hlpVault);
  printRejectedSection(rejected);
  printCoverageIssues(coverageIssues);

  printSectionTitle(
    'Summary',
    `Real-liquidity floor: ${formatUsdCompact(REAL_LIQUIDITY_FLOOR_USD, 0)}. Curated band: ${CURATED_MIN_APY}%–${CURATED_MAX_APY}%.`,
  );
  console.log(`Curated venues     : ${curated.length}`);
  console.log(`Exploratory venues : ${exploratory.length}`);
  console.log(`Rejected reads     : ${rejected.length}`);
  console.log('Vault monitors     : 1');
  console.log(`Coverage gaps      : ${coverageIssues.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
