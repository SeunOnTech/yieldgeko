import { createPublicClient, fallback, getAddress, http, parseAbi, type Address, type PublicClient } from 'viem';
import { arbitrum } from 'viem/chains';
import * as dotenv from 'dotenv';
import * as path from 'node:path';
import PQueue from 'p-queue';
import type { AlphaOpportunity, HistoryProvider } from '../types';
import { evaluateOpportunities } from '../models/registry';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env.local'), override: true });
dotenv.config({ path: path.resolve(__dirname, '../../../../.env'), override: false });

const RPC_URLS = (process.env.ARB_RPC_URLS ?? process.env.ARB_RPC_URL ?? [
  'https://arbitrum-one-rpc.publicnode.com',
  'https://arb1.arbitrum.io/rpc',
  'https://arbitrum.llamarpc.com',
].join(','))
  .split(',')
  .map(url => url.trim())
  .filter(Boolean);
const CHAIN_ID = 42161;
const NETWORK = 'Arbitrum';

const UNISWAP_V3_FACTORY = getAddress('0x1F98431c8aD98523631AE4a59f267346ea31F984');
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'USDT0', 'USD₮0', 'DAI', 'USDE', 'USDC.E', 'USDBC', 'USDCE', 'MIM', 'USDS', 'USD0']);
const MIN_UNISWAP_TVL_USD = 100_000;
const MIN_UNISWAP_HISTORY_POINTS = 30;

const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
]);

const POOL_ABI = parseAbi([
  'function factory() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
]);

const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
]);

interface LlamaYieldPool {
  chain: string;
  project: string;
  symbol: string;
  pool: string;
  poolMeta?: string | null;
  tvlUsd: number;
  apy: number;
  apyBase: number | null;
  apyBase7d: number | null;
  apyMean30d: number | null;
  rewardTokens: string[] | null;
  stablecoin?: boolean;
  ilRisk?: string | null;
  exposure?: string | null;
  underlyingTokens?: string[] | null;
  volumeUsd1d?: number | null;
  volumeUsd7d?: number | null;
  outlier?: boolean;
  count?: number;
}

interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

interface VerifiedPoolCandidate {
  address: Address;
  feeTier: number;
  token0: TokenInfo;
  token1: TokenInfo;
  liquidity: bigint;
  priceUSD?: number;
}

function lower(value: string): string {
  return value.toLowerCase();
}

function formatFeeTier(feeTier: number): string {
  return `${(feeTier / 10_000).toFixed(2)}%`;
}

function symbolPairKey(a: string, b: string): string {
  return [a.toUpperCase(), b.toUpperCase()].sort().join('/');
}

function historyProviderFromLlama(poolId: string | undefined): HistoryProvider {
  return poolId ? { kind: 'defillama-pool', poolId } : { kind: 'none' };
}

function computeRiskScore(grossAPY: number, liquidityUSD: number, verified: boolean): number {
  const liquidityComponent = Math.min(25, Math.log10(Math.max(liquidityUSD, 1)) * 4);
  const apyPenalty = Math.min(20, Math.max(0, grossAPY - 20) * 0.75);
  const verificationBonus = verified ? 15 : 0;
  return Math.max(0, Math.min(99, Math.round(60 + liquidityComponent + verificationBonus - apyPenalty)));
}

function passesUniswapHardFilters(pool: LlamaYieldPool, token0Symbol: string, token1Symbol: string): boolean {
  if (!Number.isFinite(pool.apy) || pool.apy <= 0) return false;
  if (!Number.isFinite(pool.tvlUsd) || pool.tvlUsd < MIN_UNISWAP_TVL_USD) return false;
  if ((pool.count ?? 0) < MIN_UNISWAP_HISTORY_POINTS) return false;
  if (!token0Symbol || !token1Symbol) return false;

  return true;
}

function parseFeeTier(poolMeta: string | null | undefined): number | null {
  if (!poolMeta) return null;
  const value = Number.parseFloat(poolMeta.replace('%', '').trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 10_000);
}

function isStableSymbol(symbol: string): boolean {
  return STABLE_SYMBOLS.has(symbol.toUpperCase());
}

function selectPrimaryAsset(token0: TokenInfo, token1: TokenInfo): TokenInfo {
  const token0Stable = isStableSymbol(token0.symbol);
  const token1Stable = isStableSymbol(token1.symbol);
  if (token0Stable && !token1Stable) return token1;
  if (token1Stable && !token0Stable) return token0;
  return token0;
}

function selectQuoteAsset(token0: TokenInfo, token1: TokenInfo): TokenInfo {
  const token0Stable = isStableSymbol(token0.symbol);
  const token1Stable = isStableSymbol(token1.symbol);
  if (token0Stable && !token1Stable) return token0;
  if (token1Stable && !token0Stable) return token1;
  return token1;
}

export class AlphaScout {
  private readonly client: PublicClient;
  private readonly tokenInfoCache = new Map<string, Promise<TokenInfo>>();
  private readonly uniswapVerifyQueue = new PQueue({ concurrency: 5 });

  constructor() {
    this.client = createPublicClient({
      chain: arbitrum,
      transport: fallback(
        RPC_URLS.map(url => http(url, { timeout: 8_000, retryCount: 1 })),
        { rank: false },
      ),
    });
  }

  private async fetchDefiLlamaPools(): Promise<LlamaYieldPool[]> {
    try {
      const res = await fetch('https://yields.llama.fi/pools', {
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return [];
      const json = await res.json() as { data?: LlamaYieldPool[] };
      return (json.data ?? []).filter(pool => pool.chain === NETWORK && Number.isFinite(pool.apy));
    } catch {
      return [];
    }
  }

  private async loadTokenInfo(address: Address): Promise<TokenInfo> {
    const key = lower(address);
    const existing = this.tokenInfoCache.get(key);
    if (existing) return existing;

    const pending = (async () => {
      const [symbol, decimals] = await Promise.all([
        this.client.readContract({ address, abi: ERC20_ABI, functionName: 'symbol' }),
        this.client.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }),
      ]);

      return {
        address,
        symbol: String(symbol),
        decimals: Number(decimals),
      };
    })();

    this.tokenInfoCache.set(key, pending);
    return pending;
  }

  private async withRetry<T>(label: string, task: () => Promise<T>, retries = 2): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await task();
      } catch (error) {
        lastError = error;
        if (attempt === retries) break;
        await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
    throw new Error(`${label} failed after ${retries + 1} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private computePriceFromSqrtPrice(
    sqrtPriceX96: bigint,
    token0: TokenInfo,
    token1: TokenInfo,
    quoteTokenAddress?: Address,
  ): number | null {
    if (!quoteTokenAddress) return null;
    const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
    const token1PerToken0 = ratio * 10 ** (token0.decimals - token1.decimals);

    if (!Number.isFinite(token1PerToken0) || token1PerToken0 <= 0) return null;

    if (lower(token1.address) === lower(quoteTokenAddress)) {
      return token1PerToken0;
    }
    if (lower(token0.address) === lower(quoteTokenAddress)) {
      return 1 / token1PerToken0;
    }
    return null;
  }

  private async verifyUniswapPool(
    poolAddress: Address,
    expectedTokenA: Address,
    expectedTokenB: Address,
    expectedFeeTier: number,
    quoteTokenAddress?: Address,
  ): Promise<VerifiedPoolCandidate | null> {
    const [factory, token0Address, token1Address, feeTier, slot0, liquidity] = await this.withRetry(
      `verify pool ${poolAddress}`,
      () => Promise.all([
        this.client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: 'factory' }),
        this.client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: 'token0' }),
        this.client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: 'token1' }),
        this.client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: 'fee' }),
        this.client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: 'slot0' }),
        this.client.readContract({ address: poolAddress, abi: POOL_ABI, functionName: 'liquidity' }),
      ]),
    );

    if (lower(String(factory)) !== lower(UNISWAP_V3_FACTORY)) return null;
    if (Number(feeTier) !== expectedFeeTier) return null;

    const expectedSet = [lower(expectedTokenA), lower(expectedTokenB)].sort().join(':');
    const actualSet = [lower(String(token0Address)), lower(String(token1Address))].sort().join(':');
    if (expectedSet !== actualSet) return null;

    const [token0, token1] = await Promise.all([
      this.loadTokenInfo(getAddress(String(token0Address))),
      this.loadTokenInfo(getAddress(String(token1Address))),
    ]);

    const priceUSD = this.computePriceFromSqrtPrice(BigInt(slot0[0]), token0, token1, quoteTokenAddress);
    if (BigInt(liquidity) === 0n) return null;

    return {
      address: poolAddress,
      feeTier: expectedFeeTier,
      token0,
      token1,
      liquidity: BigInt(liquidity),
      priceUSD: priceUSD && priceUSD > 0 ? priceUSD : undefined,
    };
  }

  private async probeUniswapV3(llamaPools: LlamaYieldPool[]): Promise<AlphaOpportunity[]> {
    const rawCandidates = llamaPools
      .filter(pool => pool.project.toLowerCase() === 'uniswap-v3')
      .filter(pool => Number.isFinite(pool.apy) && pool.apy > 0)
      .filter(pool => Number.isFinite(pool.tvlUsd) && pool.tvlUsd >= MIN_UNISWAP_TVL_USD)
      .filter(pool => Array.isArray(pool.underlyingTokens) && pool.underlyingTokens.length === 2)
      .map(pool => ({
        llama: pool,
        feeTier: parseFeeTier(pool.poolMeta),
      }))
      .filter((candidate): candidate is { llama: LlamaYieldPool; feeTier: number } => candidate.feeTier !== null);

    const verified = await Promise.all(rawCandidates.map(candidate =>
      this.uniswapVerifyQueue.add(async (): Promise<AlphaOpportunity | null> => {
        try {
          const tokenA = getAddress(String(candidate.llama.underlyingTokens?.[0]));
          const tokenB = getAddress(String(candidate.llama.underlyingTokens?.[1]));
          const [symbolA, symbolB] = String(candidate.llama.symbol).split('-').map(part => part.replace('.E', '').toUpperCase());
          const poolAddress = await this.withRetry(
            `resolve pool ${candidate.llama.symbol} ${formatFeeTier(candidate.feeTier)}`,
            () => this.client.readContract({
              address: UNISWAP_V3_FACTORY,
              abi: FACTORY_ABI,
              functionName: 'getPool',
              args: [tokenA, tokenB, candidate.feeTier],
            }),
          );

          const candidateAddress = getAddress(String(poolAddress));
          if (lower(candidateAddress) === lower(ZERO_ADDRESS)) return null;

          const quoteTokenAddress =
            isStableSymbol(symbolA ?? '') && !isStableSymbol(symbolB ?? '')
              ? tokenA
              : isStableSymbol(symbolB ?? '') && !isStableSymbol(symbolA ?? '')
                ? tokenB
                : undefined;

          const resolved = await this.verifyUniswapPool(
            candidateAddress,
            tokenA,
            tokenB,
            candidate.feeTier,
            quoteTokenAddress,
          );
          if (!resolved) return null;
          if (!passesUniswapHardFilters(candidate.llama, resolved.token0.symbol, resolved.token1.symbol)) return null;

          const primaryAsset = selectPrimaryAsset(resolved.token0, resolved.token1);
          const quoteAsset = selectQuoteAsset(resolved.token0, resolved.token1);

          return {
            id: `univ3:${CHAIN_ID}:${lower(resolved.address)}`,
            protocolKey: 'uniswap-v3' as const,
            protocol: 'Uniswap V3',
            pool: `${resolved.token0.symbol}/${resolved.token1.symbol} (${formatFeeTier(resolved.feeTier)})`,
            asset: primaryAsset.symbol,
            grossAPY: Number(candidate.llama.apy),
            liquidityUSD: Number(candidate.llama.tvlUsd),
            strategyType: 'LP',
            riskScore: computeRiskScore(Number(candidate.llama.apy), Number(candidate.llama.tvlUsd), true),
            selectionScore: 0,
            price: resolved.priceUSD,
            metadata: {
              chainId: CHAIN_ID,
              network: NETWORK,
              source: 'uniswap-v3-factory' as const,
              verified: true,
              address: resolved.address,
              discoveryAddress: resolved.address,
              feeTier: resolved.feeTier,
              token0: resolved.token0.address,
              token1: resolved.token1.address,
              token0Symbol: resolved.token0.symbol,
              token1Symbol: resolved.token1.symbol,
              token0Decimals: resolved.token0.decimals,
              token1Decimals: resolved.token1.decimals,
              quoteAsset: quoteAsset.symbol,
              baseAsset: primaryAsset.symbol,
              factoryAddress: UNISWAP_V3_FACTORY,
              warnings: [],
              historyProvider: historyProviderFromLlama(candidate.llama.pool),
              extra: {
                llamaPoolId: candidate.llama.pool,
                apyBase7d: candidate.llama.apyBase7d,
                apyMean30d: candidate.llama.apyMean30d,
                ilRisk: candidate.llama.ilRisk ?? null,
                exposure: candidate.llama.exposure ?? null,
                volumeUsd1d: candidate.llama.volumeUsd1d ?? null,
                volumeUsd7d: candidate.llama.volumeUsd7d ?? null,
                outlier: candidate.llama.outlier ?? false,
                historyCount: candidate.llama.count ?? 0,
                onchainLiquidity: resolved.liquidity.toString(),
              },
            },
          };
        } catch {
          return null;
        }
      }),
    ));

    const deduped = new Map<string, AlphaOpportunity>();
    for (const opportunity of verified) {
      if (!opportunity) continue;
      const current = deduped.get(opportunity.id);
      if (!current || opportunity.liquidityUSD > current.liquidityUSD) {
        deduped.set(opportunity.id, opportunity);
      }
    }

    return Array.from(deduped.values())
      .sort((a, b) => b.selectionScore - a.selectionScore || b.grossAPY - a.grossAPY || b.liquidityUSD - a.liquidityUSD);
  }

  private probeMorpho(llamaPools: LlamaYieldPool[]): AlphaOpportunity[] {
    return llamaPools
      .filter(pool =>
        pool.project.toLowerCase().includes('morpho') &&
        pool.tvlUsd >= 250_000 &&
        Number.isFinite(pool.apy) &&
        pool.apy > 0 &&
        pool.symbol.toUpperCase().includes('USDC'),
      )
      .sort((a, b) => b.apy - a.apy || b.tvlUsd - a.tvlUsd)
      .slice(0, 5)
      .map(pool => ({
        id: `morpho:${CHAIN_ID}:${pool.pool.toLowerCase()}`,
        protocolKey: 'morpho' as const,
        protocol: 'Morpho',
        pool: pool.symbol,
        asset: 'USDC',
        grossAPY: Number(pool.apy),
        liquidityUSD: Number(pool.tvlUsd),
        strategyType: 'LENDING' as const,
        riskScore: computeRiskScore(Number(pool.apy), Number(pool.tvlUsd), false),
        selectionScore: 0,
        metadata: {
          chainId: CHAIN_ID,
          network: NETWORK,
          source: 'defillama' as const,
          verified: false,
          address: undefined,
          warnings: ['APY sourced from indexed market data; direct on-chain vault verification not configured in sim-engine yet.'],
          historyProvider: historyProviderFromLlama(pool.pool),
          extra: {
            llamaPoolId: pool.pool,
            stablecoin: pool.stablecoin ?? false,
            apyBase: pool.apyBase,
            apyBase7d: pool.apyBase7d,
            apyMean30d: pool.apyMean30d,
            historyCount: pool.count ?? 0,
          },
        },
      }));
  }

  private async probePendle(): Promise<AlphaOpportunity[]> {
    try {
      const res = await fetch('https://api-v2.pendle.finance/core/v1/42161/markets?limit=25&is_active=true', {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];

      const data = await res.json() as { results?: Array<{
        address: string;
        expiry: string;
        impliedApy: number;
        liquidity: { usd: number };
        pt: { address: string; symbol: string };
        yt: { address: string; symbol: string };
        underlyingAsset: { symbol: string };
      }> };

      const now = Date.now();

      return (data.results ?? [])
        .filter(market => Number(market.liquidity?.usd) >= 250_000)
        .filter(market => new Date(market.expiry).getTime() - now > 7 * 24 * 60 * 60 * 1_000)
        .map(market => {
          const grossAPY = Number(market.impliedApy) * 100;
          const liquidityUSD = Number(market.liquidity.usd);
          const daysToExpiry = Math.max(1, (new Date(market.expiry).getTime() - now) / (24 * 60 * 60 * 1_000));
          return {
            id: `pendle:${CHAIN_ID}:${lower(market.address)}`,
            protocolKey: 'pendle' as const,
            protocol: 'Pendle',
            pool: `PT-${market.pt.symbol}`,
            asset: market.underlyingAsset.symbol,
            grossAPY,
            liquidityUSD,
            strategyType: 'DERIVATIVE' as const,
            riskScore: computeRiskScore(grossAPY, liquidityUSD, true),
            selectionScore: 0,
            metadata: {
              chainId: CHAIN_ID,
              network: NETWORK,
              source: 'pendle-api' as const,
              verified: true,
              address: getAddress(market.address),
              warnings: [],
              historyProvider: {
                kind: 'pendle-market' as const,
                chainId: CHAIN_ID,
                marketAddress: getAddress(market.address),
              },
              extra: {
                ptAddress: market.pt.address,
                ytAddress: market.yt.address,
                expiry: market.expiry,
                daysToExpiry,
              },
            },
          };
        })
        .sort((a, b) => b.selectionScore - a.selectionScore || b.grossAPY - a.grossAPY || b.liquidityUSD - a.liquidityUSD)
        .slice(0, 8);
    } catch {
      return [];
    }
  }

  async runDiscovery(): Promise<AlphaOpportunity[]> {
    console.log('[AlphaScout] Starting verified alpha discovery...');

    const llamaPools = await this.fetchDefiLlamaPools();

    const [morpho, pendle, uniswap] = await Promise.all([
      Promise.resolve(this.probeMorpho(llamaPools)),
      this.probePendle(),
      this.probeUniswapV3(llamaPools),
    ]);

    const opportunities = evaluateOpportunities([...morpho, ...pendle, ...uniswap])
      .filter(opportunity => Number.isFinite(opportunity.grossAPY) && opportunity.grossAPY > 0)
      .filter(opportunity => Number.isFinite(opportunity.liquidityUSD) && opportunity.liquidityUSD > 0)
      .sort((a, b) => b.selectionScore - a.selectionScore || b.grossAPY - a.grossAPY || b.liquidityUSD - a.liquidityUSD);

    console.log(`[AlphaScout] Discovered ${opportunities.length} vetted opportunities.`);
    for (const opportunity of opportunities) {
      const verifiedTag = opportunity.metadata.verified ? 'verified' : 'indexed';
      const priceStr = opportunity.price !== undefined ? ` | Price: $${opportunity.price.toFixed(4)}` : '';
      console.log(
        `  > ${opportunity.protocol} | ${opportunity.pool}${priceStr} | Score: ${opportunity.selectionScore} | APY: ${opportunity.grossAPY.toFixed(2)}% | Liq: $${(opportunity.liquidityUSD / 1e6).toFixed(2)}M | ${verifiedTag}`,
      );
      if (opportunity.evaluation) {
        console.log(
          `    model=${opportunity.evaluation.model} | net=${opportunity.evaluation.expectedNetApy.toFixed(2)}% | risk=${opportunity.evaluation.expectedRiskDrag.toFixed(2)}% | mgmt=${opportunity.evaluation.expectedManagementCost.toFixed(2)}% | conf=${opportunity.evaluation.confidence.toFixed(1)}%`,
        );
      }
    }

    return opportunities;
  }
}

if (require.main === module) {
  const scout = new AlphaScout();
  scout.runDiscovery().catch(error => {
    console.error('[AlphaScout] Fatal discovery error:', error);
    process.exitCode = 1;
  });
}
