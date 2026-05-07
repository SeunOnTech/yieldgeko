import { createPublicClient, getAddress, http, parseAbi, type Address } from 'viem';
import { arbitrum } from 'viem/chains';
import * as dotenv from 'dotenv';

dotenv.config();

const RPC_URL = process.env.ZERO_G_RPC || 'https://arb1.arbitrum.io/rpc';
const MORPHO_ARBITRUM = getAddress('0x6c247b1F6182318877311737BaC0844bAa518F5e');
const PENDLE_MARKETS_URL = 'https://api-v2.pendle.finance/core/v2/markets/all?chainId=42161&limit=100&skip=0';
const MORPHO_GRAPHQL_URL = 'https://blue-api.morpho.org/graphql';
const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
const HLP_VAULT_ADDRESS = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';

const AGGRESSIVE_MIN_APY = 20;
const OPPORTUNISTIC_MIN_APY = 40;
const TARGET_MAX_APY = 100;
const REAL_LIQUIDITY_FLOOR_USD = 500_000;
const MIN_DISCOVERY_LIQUIDITY_USD = 10_000;
const MAX_DISPLAY_ANOMALIES = 5;

const morphoAbi = parseAbi([
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)',
  'function idToMarketParams(bytes32 id) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)',
]);

type YieldBucket = 'aggressive' | 'opportunistic';
type StrategyClass = 'structured_yield' | 'borrow_carry' | 'market_making';
type SourceKind = 'official_api' | 'onchain_validated';

type Candidate = {
  bucket: YieldBucket;
  protocol: string;
  venue: string;
  strategyClass: StrategyClass;
  headlineApy: number;
  liquidityUsd: number;
  source: SourceKind[];
  yieldSource: string;
  executionVenue: string;
  liquidityReal: boolean;
  yieldSourceUnderstood: boolean;
  executionCheckPassed: boolean;
  policyRequired: true;
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

type VaultMonitor = {
  protocol: string;
  venue: string;
  vaultAddress: string;
  liquidityUsd: number;
  lockupDays: number;
  dayReturnPct: number;
  weekReturnPct: number;
  monthReturnPct: number;
  annualizedWeekPct: number;
  annualizedMonthPct: number;
  currentSignal: 'positive' | 'negative' | 'mixed';
  notes: string[];
};

type PendleApiResponse = {
  total: number;
  limit: number;
  skip: number;
  results: PendleMarket[];
};

type PendleMarket = {
  name: string;
  address: string;
  chainId: number;
  categoryIds?: string[];
  details?: {
    aggregatedApy?: number;
    liquidity?: number;
    totalTvl?: number;
    underlyingApy?: number;
    swapFeeApy?: number;
    pendleApy?: number;
    ytFloatingApy?: number;
    impliedApy?: number;
  };
  marketInfo?: {
    utilizedProtocols?: Array<{
      id?: string;
      name?: string;
      url?: string;
    }>;
    riskInvolved?: string;
    importantQuirks?: string;
  };
  points?: Array<{
    key?: string;
    type?: string;
    value?: number;
  }>;
};

type MorphoAsset = {
  address: string;
  symbol: string;
  decimals: number;
};

type MorphoMarketItem = {
  marketId: string;
  listed: boolean;
  state: {
    supplyAssetsUsd: number;
    utilization: number;
    supplyApy: number;
  };
  loanAsset: MorphoAsset;
  collateralAsset: MorphoAsset | null;
  oracle: { address: string } | null;
  irmAddress: string;
  lltv: string | number;
};

type MorphoGraphqlResponse = {
  data?: {
    markets?: {
      items?: MorphoMarketItem[];
    };
  };
  errors?: Array<{ message: string }>;
};

type HyperliquidVaultWindow = {
  accountValueHistory: Array<[number, string]>;
  pnlHistory: Array<[number, string]>;
  vlm: string;
};

type HyperliquidVaultDetailsResponse = {
  name: string;
  vaultAddress: string;
  leader: string;
  description: string;
  portfolio: Array<[string, HyperliquidVaultWindow]>;
};

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

function formatSourceKinds(source: SourceKind[]): string {
  return source
    .map((item) => {
      if (item === 'official_api') return 'official_api';
      return 'onchain_validated';
    })
    .join(', ');
}

function formatGate(label: string, value: boolean): string {
  return `${label}=${value ? 'yes' : 'no'}`;
}

function printSectionTitle(title: string, subtitle?: string) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
  if (subtitle) {
    console.log(subtitle);
  }
}

function classifyBucket(apy: number): YieldBucket {
  return apy >= OPPORTUNISTIC_MIN_APY ? 'opportunistic' : 'aggressive';
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

async function ensureCode(client: ReturnType<typeof createPublicClient>, address: Address): Promise<boolean> {
  const code = await client.getCode({ address });
  return !!code && code !== '0x';
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} from ${url}`);
  }
  return (await response.json()) as T;
}

async function fetchMorphoMarkets(where: Record<string, unknown>): Promise<MorphoMarketItem[]> {
  const query = `query Markets($first:Int!, $where: MarketFilters) {
    markets(first:$first, where:$where) {
      items {
        marketId
        listed
        state {
          supplyAssetsUsd
          utilization
          supplyApy
        }
        loanAsset {
          address
          symbol
          decimals
        }
        collateralAsset {
          address
          symbol
          decimals
        }
        oracle {
          address
        }
        irmAddress
        lltv
      }
    }
  }`;

  const payload = await fetchJson<MorphoGraphqlResponse>(MORPHO_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: {
        first: 100,
        where,
      },
    }),
  });

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((item) => item.message).join('; '));
  }

  return payload.data?.markets?.items || [];
}

async function collectPendleCandidates(
  client: ReturnType<typeof createPublicClient>,
): Promise<{ curated: Candidate[]; rejected: RejectedVenue[] }> {
  const payload = await fetchJson<PendleApiResponse>(PENDLE_MARKETS_URL);
  const curated: Candidate[] = [];
  const rejected: RejectedVenue[] = [];

  for (const market of payload.results) {
    if (market.chainId !== 42161) continue;

    const aggregatedApy = (market.details?.aggregatedApy || 0) * 100;
    if (aggregatedApy < OPPORTUNISTIC_MIN_APY) continue;

    const liquidityUsd = market.details?.liquidity ?? market.details?.totalTvl ?? 0;
    const marketAddress = getAddress(market.address);
    const codeExists = await ensureCode(client, marketAddress);
    const protocolNames = (market.marketInfo?.utilizedProtocols || [])
      .map((item) => item.name)
      .filter(Boolean) as string[];

    const notes = [
      `market=${marketAddress}`,
      `underlyingApy=${round((market.details?.underlyingApy || 0) * 100)}%`,
      `swapFeeApy=${round((market.details?.swapFeeApy || 0) * 100)}%`,
      `pendleApy=${round((market.details?.pendleApy || 0) * 100)}%`,
      `protocols=${protocolNames.join(', ') || 'unknown'}`,
    ];

    if (market.details?.ytFloatingApy) {
      notes.push(`ytFloatingApy=${round(market.details.ytFloatingApy * 100)}%`);
    }
    if (market.points?.length) {
      notes.push(`points=${market.points.map((item) => item.key).filter(Boolean).join(', ')}`);
    }

    const underlyingApy = (market.details?.underlyingApy || 0) * 100;
    const swapFeeApy = (market.details?.swapFeeApy || 0) * 100;
    const pendleApy = (market.details?.pendleApy || 0) * 100;
    const nonEmissionApy = underlyingApy + swapFeeApy;
    const emissionsDominant = pendleApy > nonEmissionApy;

    const rejectionReasons: string[] = [];
    if (!codeExists) rejectionReasons.push('market failed onchain code validation');
    if (liquidityUsd < REAL_LIQUIDITY_FLOOR_USD) rejectionReasons.push('real liquidity below floor');
    if (aggregatedApy > TARGET_MAX_APY) rejectionReasons.push(`headline APY above target ceiling ${TARGET_MAX_APY}%`);
    if (emissionsDominant) rejectionReasons.push('emissions-dominant APY profile');

    if (rejectionReasons.length > 0) {
      rejected.push({
        protocol: 'Pendle',
        venue: market.name,
        headlineApy: aggregatedApy,
        liquidityUsd,
        reason: rejectionReasons.join(', '),
        notes,
      });
      continue;
    }

    curated.push({
      bucket: classifyBucket(aggregatedApy),
      protocol: 'Pendle',
      venue: market.name,
      strategyClass: 'structured_yield',
      headlineApy: aggregatedApy,
      liquidityUsd,
      source: ['official_api', 'onchain_validated'],
      yieldSource: 'structured_yield + protocol_yield + swap_fees + incentives/points when present',
      executionVenue: 'Pendle market',
      liquidityReal: liquidityUsd >= REAL_LIQUIDITY_FLOOR_USD,
      yieldSourceUnderstood: true,
      executionCheckPassed: true,
      policyRequired: true,
      notes,
    });
  }

  return {
    curated: curated.sort((a, b) => b.headlineApy - a.headlineApy || b.liquidityUsd - a.liquidityUsd),
    rejected: rejected.sort((a, b) => b.headlineApy - a.headlineApy || b.liquidityUsd - a.liquidityUsd),
  };
}

async function collectMorphoAnomalies(
  client: ReturnType<typeof createPublicClient>,
): Promise<RejectedVenue[]> {
  const singletonCode = await ensureCode(client, MORPHO_ARBITRUM);
  if (!singletonCode) {
    return [{
      protocol: 'Morpho Blue',
      venue: 'singleton',
      headlineApy: 0,
      liquidityUsd: 0,
      reason: `no bytecode at ${MORPHO_ARBITRUM}`,
      notes: [],
    }];
  }

  const discovered = await fetchMorphoMarkets({ chainId_in: [42161] });
  const rejected: RejectedVenue[] = [];

  for (const market of discovered) {
    const apy = (market.state.supplyApy || 0) * 100;
    if (apy < OPPORTUNISTIC_MIN_APY) continue;

    const liquidityUsd = market.state.supplyAssetsUsd || 0;
    const onchainParams = await client.readContract({
      address: MORPHO_ARBITRUM,
      abi: morphoAbi,
      functionName: 'idToMarketParams',
      args: [market.marketId as `0x${string}`],
    });
    const onchainState = await client.readContract({
      address: MORPHO_ARBITRUM,
      abi: morphoAbi,
      functionName: 'market',
      args: [market.marketId as `0x${string}`],
    });

    const collateralSymbol = market.collateralAsset?.symbol || 'none';
    const venue = `${market.loanAsset.symbol}/${collateralSymbol} market`;
    const notes = [
      `marketId=${market.marketId}`,
      `loan=${getAddress(onchainParams[0])}`,
      `collateral=${getAddress(onchainParams[1])}`,
      `utilization=${round((market.state.utilization || 0) * 100)}%`,
      `lltv=${round(Number(market.lltv) / 1e16)}%`,
      `listed=${market.listed}`,
      `onchainSupplyRaw=${onchainState[0].toString()}`,
    ];

    const reasons: string[] = [];
    if (!market.listed) reasons.push('unlisted market');
    if (apy > 100) reasons.push('extreme APY outlier');
    if ((market.state.utilization || 0) >= 0.98) reasons.push('near-max utilization');
    if (collateralSymbol.startsWith('MUX3LP-')) reasons.push('wrapper collateral');
    if (liquidityUsd < REAL_LIQUIDITY_FLOOR_USD) reasons.push('sub-scale liquidity');

    if (apy > TARGET_MAX_APY) reasons.push(`headline APY above target ceiling ${TARGET_MAX_APY}%`);
    if (liquidityUsd < REAL_LIQUIDITY_FLOOR_USD) reasons.push('real liquidity below floor');

    if (reasons.length === 0) {
      continue;
    }

    rejected.push({
      protocol: 'Morpho Blue',
      venue,
      headlineApy: apy,
      liquidityUsd,
      reason: reasons.join(', '),
      notes,
    });
  }

  return rejected
    .sort((a, b) => b.headlineApy - a.headlineApy || b.liquidityUsd - a.liquidityUsd)
    .slice(0, MAX_DISPLAY_ANOMALIES);
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

  const currentSignal: VaultMonitor['currentSignal'] =
    dayReturnPct > 0 && weekReturnPct > 0 && monthReturnPct > 0
      ? 'positive'
      : dayReturnPct < 0 && weekReturnPct < 0 && monthReturnPct < 0
        ? 'negative'
        : 'mixed';

  return {
    protocol: 'Hyperliquid',
    venue: payload.name,
    vaultAddress: payload.vaultAddress,
    liquidityUsd: weekEnd,
    lockupDays: 4,
    dayReturnPct,
    weekReturnPct,
    monthReturnPct,
    annualizedWeekPct,
    annualizedMonthPct,
    currentSignal,
    notes: [
      `leader=${payload.leader}`,
      `description=${payload.description}`,
      `dayPnl=${day.pnlHistory[day.pnlHistory.length - 1]?.[1] || 'n/a'}`,
      `weekPnl=${week.pnlHistory[week.pnlHistory.length - 1]?.[1] || 'n/a'}`,
      `monthPnl=${month.pnlHistory[month.pnlHistory.length - 1]?.[1] || 'n/a'}`,
    ],
  };
}

function printCandidateSection(title: string, candidates: Candidate[]) {
  printSectionTitle(
    title,
    'Only candidates that passed source validation and basic execution realism checks are shown here.',
  );

  if (candidates.length === 0) {
    console.log('None found.');
    return;
  }

  console.log('RANK | PROTOCOL     | CLASS            | VENUE                          | APY      | LIQUIDITY  | SOURCES');
  console.log('------------------------------------------------------------------------------------------------------------------');

  candidates.forEach((item, index) => {
    const rank = String(index + 1).padEnd(4);
    const protocol = item.protocol.padEnd(12);
    const strategyClass = item.strategyClass.padEnd(16);
    const venue = item.venue.padEnd(30);
    const apy = formatPct(item.headlineApy, 8);
    const liquidity = formatUsdCompact(item.liquidityUsd, 10);
    const sources = formatSourceKinds(item.source);

    console.log(`${rank} | ${protocol} | ${strategyClass} | ${venue} | ${apy.padEnd(8)} | ${liquidity} | ${sources}`);
    console.log(
      `     | Gates: ${formatGate('real_liquidity', item.liquidityReal)} ${formatGate('yield_understood', item.yieldSourceUnderstood)} ${formatGate('execution', item.executionCheckPassed)} ${formatGate('explicit_opt_in', item.policyRequired)}`,
    );
    console.log(`     | Route: ${item.executionVenue}`);
    console.log(`     | Yield Source: ${item.yieldSource}`);
    console.log(`     | Notes: ${item.notes.join('; ')}`);
  });

  console.log('------------------------------------------------------------------------------------------------------------------');
}

function printVaultMonitor(vault: VaultMonitor) {
  printSectionTitle(
    'Advanced Vault Monitor',
    'These are not auto-curated yield routes. They are tracked because they can become relevant for advanced opt-in users.',
  );
  console.log('PROTOCOL     | VAULT                           | LIQUIDITY  | LOCKUP | 1D RET   | 7D RET   | 30D RET  | 7D ANN.    | 30D ANN.   | SIGNAL');
  console.log('----------------------------------------------------------------------------------------------------------------------------------------');
  console.log(
    `${vault.protocol.padEnd(12)} | ${vault.venue.padEnd(31)} | ${formatUsdCompact(vault.liquidityUsd, 9)} | ${String(vault.lockupDays).padStart(6)} | ${formatPct(vault.dayReturnPct, 8)} | ${formatPct(vault.weekReturnPct, 8)} | ${formatPct(vault.monthReturnPct, 8)} | ${formatPct(vault.annualizedWeekPct, 10)} | ${formatPct(vault.annualizedMonthPct, 10)} | ${vault.currentSignal}`,
  );
  console.log(`Notes: vault=${vault.vaultAddress}; ${vault.notes.join('; ')}`);
  console.log('----------------------------------------------------------------------------------------------------------------------------------------');
}

function printRejected(title: string, rejected: RejectedVenue[]) {
  printSectionTitle(
    title,
    'These are real high-yield readings from primary sources, but they are intentionally excluded from the curated 40%-100% advanced target set.',
  );

  if (rejected.length === 0) {
    console.log('None found.');
    return;
  }

  console.log('RANK | PROTOCOL     | VENUE                          | APY        | LIQUIDITY  | WHY IT IS REJECTED');
  console.log('--------------------------------------------------------------------------------------------------------------------');
  rejected.forEach((item, index) => {
    const rank = String(index + 1).padEnd(4);
    const protocol = item.protocol.padEnd(12);
    const venue = item.venue.padEnd(30);
    const apy = `${item.headlineApy.toFixed(2)}%`.padEnd(10);
    const liquidity = formatUsdCompact(item.liquidityUsd, 10);
    console.log(`${rank} | ${protocol} | ${venue} | ${apy} | ${liquidity} | ${item.reason}`);
    console.log(`     | Notes: ${item.notes.join('; ')}`);
  });
  console.log('--------------------------------------------------------------------------------------------------------------------');
}

function printSummary(curated: Candidate[], aggressive: Candidate[], opportunistic: Candidate[], rejectionCount: number) {
  printSectionTitle(
    'Summary',
    `Target band: curated advanced opportunities only in the ${OPPORTUNISTIC_MIN_APY}%–${TARGET_MAX_APY}% range. Real-liquidity floor: ${formatUsdCompact(REAL_LIQUIDITY_FLOOR_USD, 0)}.`,
  );
  console.log(`Curated candidates       : ${curated.length}`);
  console.log(`Aggressive candidates    : ${aggressive.length}`);
  console.log(`Opportunistic candidates : ${opportunistic.length}`);
  console.log('Advanced vault monitors  : 1');
  console.log(`Rejected venues shown    : ${rejectionCount}`);
}

async function main() {
  console.log('🦎 YieldGeko: Aggressive Yield Scout v2.2\n');
  console.log(`[Network] Connected to: ${RPC_URL}`);
  console.log(`[Targets] Curated advanced opportunities only: ${OPPORTUNISTIC_MIN_APY}% to ${TARGET_MAX_APY}%`);

  const client = createPublicClient({
    chain: arbitrum,
    transport: http(RPC_URL),
  });

  const chainId = await client.getChainId();
  console.log(`[Network] Verified Chain ID: ${chainId} (Expected 42161)`);
  if (chainId !== 42161) {
    throw new Error('Not connected to Arbitrum mainnet');
  }

  const [pendle, morphoRejected, hyperliquidVault] = await Promise.all([
    collectPendleCandidates(client),
    collectMorphoAnomalies(client),
    collectHyperliquidVaultMonitor(),
  ]);

  const curated = [...pendle.curated].sort((a, b) => b.headlineApy - a.headlineApy || b.liquidityUsd - a.liquidityUsd);
  const aggressive = curated.filter((item) => item.headlineApy >= AGGRESSIVE_MIN_APY && item.headlineApy < OPPORTUNISTIC_MIN_APY);
  const opportunistic = curated.filter((item) => item.headlineApy >= OPPORTUNISTIC_MIN_APY && item.headlineApy <= TARGET_MAX_APY);

  printCandidateSection('Curated 40%-100% Advanced Candidates', opportunistic);
  printVaultMonitor(hyperliquidVault);
  printRejected('Rejected Pendle High-Yield Markets', pendle.rejected);
  printRejected('Rejected Morpho High-APY Markets', morphoRejected);

  printSummary(curated, aggressive, opportunistic, pendle.rejected.length + morphoRejected.length);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
