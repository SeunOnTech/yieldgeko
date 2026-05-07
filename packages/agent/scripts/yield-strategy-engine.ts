/**
 * ============================================================
 *  YIELDGEKO STRATEGY INTELLIGENCE ENGINE  v1.0
 * ============================================================
 *  Three strategy archetypes:
 *
 *    AAVE_LENDING    Conservative | 3–15%  | Stablecoin/ETH lending
 *    GMX_REAL_YIELD  Balanced     | 15–40% | Earn from trader activity
 *    DELTA_NEUTRAL   Balanced+    | 10–25% | LP fees + perp hedge
 *
 *  Data architecture:
 *    Discovery  → DeFiLlama Yields API  (primary, full protocol coverage)
 *    OI data    → GMX GraphQL           (open interest balance per market)
 *    Funding    → Gains Network API     (hedge cost for delta-neutral)
 *    Verify     → Multicall3 on-chain   (live Aave rate confirmation)
 *    Monitor    → Direct contract calls (live position tracking per type)
 *    Score      → Risk-adjusted APY    (gross → net → risk-discounted)
 *
 *  Usage:
 *    pnpm --dir packages/agent exec ts-node scripts/yield-strategy-engine.ts
 *
 *  Env vars (all optional):
 *    ARB_RPC_URL        Arbitrum RPC (default: publicnode)
 *    RISK_TIER          conservative | balanced | aggressive | advanced
 *    MANAGED_USD        Position size USD (default: 10000)
 *    MIN_TVL_USD        Min pool TVL (default: 1000000)
 *    USER_ADDRESS       0x... wallet to monitor live positions
 *    UNI_V3_TOKEN_ID    NFT token ID for delta-neutral position monitoring
 *    REFRESH_MS         Refresh interval ms (default: 60000)
 *    JSON_OUTPUT        1 = print JSON after table
 * ============================================================
 */

import { Contract, Interface, JsonRpcProvider } from "ethers";

// ── CONFIG ────────────────────────────────────────────────────────────────────

const CFG = {
  rpc:          process.env.ARB_RPC_URL      ?? "https://arbitrum-one-rpc.publicnode.com",
  riskTier:     (process.env.RISK_TIER       ?? "balanced") as RiskTier,
  managedUSD:   Number(process.env.MANAGED_USD    ?? 10_000),
  minTvl:       Number(process.env.MIN_TVL_USD    ?? 1_000_000),
  refreshMs:    Number(process.env.REFRESH_MS     ?? 60_000),
  timeoutMs:    15_000,
  userAddr:     process.env.USER_ADDRESS     ?? null,
  uniTokenId:   process.env.UNI_V3_TOKEN_ID ? BigInt(process.env.UNI_V3_TOKEN_ID) : null,
  jsonOutput:   process.env.JSON_OUTPUT === "1",
} as const;

// ── ADDRESSES ─────────────────────────────────────────────────────────────────

const ADDR = {
  MULTICALL3:    "0xcA11bde05977b3631167028862bE2a173976CA11",
  AAVE_POOL:     "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  AAVE_DP:       "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654",
  UNI_V3_PM:     "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  UNI_V3_FACTORY:"0x1F98431c8aD98523631AE4a59f267346ea31F984",

  // Tokens
  USDC:  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  USDT:  "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  WETH:  "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  WBTC:  "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
  ARB:   "0x912CE59144191C1204E64559FE8253a0e49E6548",
  DAI:   "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
} as const;

// GMX V2 GM markets on Arbitrum
const GMX_MARKETS: Record<string, { gm: string; longToken: string; shortToken: string }> = {
  "ETH/USDC": { gm: "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336", longToken: ADDR.WETH,  shortToken: ADDR.USDC },
  "BTC/USDC": { gm: "0x47c031236e19d024b42f8AE6780E44A573170703", longToken: ADDR.WBTC,  shortToken: ADDR.USDC },
  "ARB/USDC": { gm: "0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407", longToken: ADDR.ARB,   shortToken: ADDR.USDC },
};

// Tokens with metadata (for position monitoring)
const TOKENS: Record<string, { address: string; decimals: number }> = {
  USDC: { address: ADDR.USDC, decimals: 6  },
  USDT: { address: ADDR.USDT, decimals: 6  },
  WETH: { address: ADDR.WETH, decimals: 18 },
  WBTC: { address: ADDR.WBTC, decimals: 8  },
  ARB:  { address: ADDR.ARB,  decimals: 18 },
  DAI:  { address: ADDR.DAI,  decimals: 18 },
};

// Hedge asset per volatile token symbol (for delta-neutral)
const HEDGE_ASSET: Record<string, string> = {
  ETH: "WETH", WETH: "WETH",
  BTC: "WBTC", WBTC: "WBTC",
  ARB: "ARB",
};

// ── TYPES ─────────────────────────────────────────────────────────────────────

type RiskTier     = "conservative" | "balanced" | "aggressive" | "advanced";
type StrategyType = "AAVE_LENDING" | "GMX_REAL_YIELD" | "DELTA_NEUTRAL";
type Trend        = "rising" | "falling" | "stable" | "unknown";
type OIRisk       = "none" | "low" | "medium" | "high";

interface CostBreakdown {
  fundingCostAnnual: number; // delta-neutral: perp short funding %/yr
  executionCostPct:  number; // entry+exit slippage estimate %
  gasCostAnnual:     number; // annualized gas as % of managed position
  oiPenalty:         number; // GMX: OI-imbalance discount %
}

interface RiskProfile {
  ilRisk:           boolean;
  counterpartyRisk: OIRisk;
  liquidationRisk:  boolean;
  rebalanceNeeded:  boolean;
  oiBalance:        number | null; // GMX: long/(long+short), 0.5 = balanced
  oiRiskFlag:       boolean;
}

interface Opportunity {
  id:              string;
  strategyType:    StrategyType;
  protocol:        string;
  pool:            string;
  asset:           string;
  tvlUSD:          number;
  grossAPY:        number;
  costs:           CostBreakdown;
  netAPY:          number;   // grossAPY - all costs
  riskAdjAPY:      number;   // netAPY × (1 - riskDiscount)
  risk:            RiskProfile;
  history: {
    apy7d:    number | null;
    apy30d:   number | null;
    trend:    Trend;
    sigma:    number | null;
  };
  minTier:         RiskTier;
  score:           number;
  verifiedOnChain: boolean;
  llamaPoolId:     string;
  address:         string;
}

// Position types per strategy
interface AavePosition {
  asset:          string;
  aTokenAddress:  string;
  balanceUSD:     number;
  currentAPY:     number;
  utilization:    number;
  healthFactor:   number;
}

interface GMXPosition {
  market:       string;
  gmToken:      string;
  gmBalance:    bigint;
  oiBalance:    number;
  oiRiskFlag:   boolean;
}

interface UniV3Position {
  tokenId:       bigint;
  poolAddress:   string;
  token0:        string;
  token1:        string;
  feeTier:       number;
  tickLower:     number;
  tickUpper:     number;
  currentTick:   number;
  inRange:       boolean;
  liquidity:     bigint;
  fee0USD:       number;
  fee1USD:       number;
}

interface LivePositions {
  aave:         AavePosition[];
  gmx:          GMXPosition[];
  deltaNeutral: UniV3Position | null;
}

// ── HTTP HELPERS ──────────────────────────────────────────────────────────────

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T | null> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CFG.timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function retry<T>(fn: () => Promise<T | null>, attempts = 3): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    const r = await fn();
    if (r !== null) return r;
    if (i < attempts - 1) await new Promise(r2 => setTimeout(r2, 600 * (i + 1)));
  }
  return null;
}

// ── DEFILLAMA ─────────────────────────────────────────────────────────────────

interface LlamaPool {
  chain: string; project: string; symbol: string; tvlUsd: number;
  apyBase: number | null; apyReward: number | null; apy: number;
  rewardTokens: string[] | null; pool: string;
  apyBase7d: number | null; apyMean30d: number | null;
  volumeUsd7d: number | null; il7d: number | null;
  underlyingTokens: string[] | null; poolMeta: string | null;
  stablecoin: boolean; ilRisk: string | null;
  mu: number | null; sigma: number | null;
}

async function fetchLlamaPools(): Promise<LlamaPool[]> {
  const data = await retry(() =>
    fetchJSON<{ data: LlamaPool[] }>("https://yields.llama.fi/pools")
  );
  return data?.data?.filter(p => p.chain === "Arbitrum" && p.apy > 0 && p.apy < 10_000) ?? [];
}

// ── GMX GRAPHQL — OI + FEE DATA ───────────────────────────────────────────────

interface GMXMarketStat {
  market:       string;
  longOI:       number;  // USD
  shortOI:      number;
  oiBalance:    number;  // long/(long+short), 0.5 = neutral
  vol24hUSD:    number;
  fees24hUSD:   number;
  aprFromFees:  number;  // annualized fee APY based on 24h fees / pool TVL
}

async function fetchGMXStats(): Promise<Map<string, GMXMarketStat>> {
  const result = new Map<string, GMXMarketStat>();

  // Try GMX subgraph for OI data
  const query = `{
    marketInfos(first: 20) {
      marketToken
      longTokenAmount
      shortTokenAmount
      longInterestUsd
      shortInterestUsd
      totalBorrowingFees
      poolValueMax
    }
  }`;

  const raw = await fetchJSON<{ data: { marketInfos: any[] } }>(
    "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) }
  );

  const infos = raw?.data?.marketInfos ?? [];

  for (const [name, mkt] of Object.entries(GMX_MARKETS)) {
    const info = infos.find((m: any) =>
      (m.marketToken ?? "").toLowerCase() === mkt.gm.toLowerCase()
    );

    const longOI  = info ? Number(info.longInterestUsd  ?? 0) / 1e30 : 0;
    const shortOI = info ? Number(info.shortInterestUsd ?? 0) / 1e30 : 0;
    const totalOI = longOI + shortOI;
    const poolVal = info ? Number(info.poolValueMax ?? 0) / 1e30 : 0;
    const fees    = info ? Number(info.totalBorrowingFees ?? 0) / 1e30 : 0;

    result.set(name, {
      market:      name,
      longOI,
      shortOI,
      oiBalance:   totalOI > 0 ? longOI / totalOI : 0.5,
      vol24hUSD:   0,
      fees24hUSD:  fees,
      aprFromFees: poolVal > 0 ? (fees / poolVal) * 365 * 100 : 0,
    });
  }

  // If subgraph returned nothing, set neutral defaults
  for (const name of Object.keys(GMX_MARKETS)) {
    if (!result.has(name)) {
      result.set(name, { market: name, longOI: 0, shortOI: 0, oiBalance: 0.5, vol24hUSD: 0, fees24hUSD: 0, aprFromFees: 0 });
    }
  }

  return result;
}

// ── GAINS NETWORK — FUNDING RATES ─────────────────────────────────────────────

async function fetchFundingRates(): Promise<Map<string, number>> {
  const rates = new Map<string, number>();

  const data = await fetchJSON<any>("https://backend-arbitrum.gains.trade/trading-variables");

  if (data?.pairs && Array.isArray(data.pairs)) {
    for (const pair of data.pairs) {
      const from: string = (pair.from ?? "").toUpperCase();
      // fundingFee is per block; Arbitrum ~4 blocks/sec, annualize
      const perBlock = Number(pair.fundingFee ?? 0) / 1e10;
      const annual   = perBlock * 4 * 3600 * 24 * 365 * 100;
      if (from === "ETH")  rates.set("WETH", annual);
      if (from === "BTC")  rates.set("WBTC", annual);
      if (from === "ARB")  rates.set("ARB",  annual);
    }
  }

  // Fallback to historical averages
  if (!rates.has("WETH")) rates.set("WETH", 6.5);
  if (!rates.has("WBTC")) rates.set("WBTC", 7.0);
  if (!rates.has("ARB"))  rates.set("ARB",  9.0);

  return rates;
}

// ── MULTICALL3 HELPERS ────────────────────────────────────────────────────────

const MC3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)",
];

// ── AAVE ON-CHAIN VERIFIER ────────────────────────────────────────────────────

const AAVE_ABI = [
  "function getReserveData(address asset) view returns (uint256, uint128, uint128 currentLiquidityRate, uint128, uint128, uint128, uint40, uint16, address aTokenAddress, address, address, address, uint128, uint128 totalAToken, uint128, uint128 totalVariableDebt)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrows, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
];

interface AaveOnChain {
  sym:           string;
  liquidityRate: bigint;
  apy:           number;
  aTokenAddress: string;
  totalAToken:   bigint;
  totalDebt:     bigint;
  utilization:   number;
}

async function verifyAaveOnChain(provider: JsonRpcProvider): Promise<Map<string, AaveOnChain>> {
  const out   = new Map<string, AaveOnChain>();
  const mc    = new Contract(ADDR.MULTICALL3, MC3_ABI, provider);
  const iface = new Interface(AAVE_ABI);
  const syms  = Object.keys(TOKENS);

  const calls = syms.map(sym => ({
    target:       ADDR.AAVE_POOL,
    allowFailure: true,
    callData:     iface.encodeFunctionData("getReserveData", [TOKENS[sym].address]),
  }));

  try {
    const raw: { success: boolean; returnData: string }[] = await mc.aggregate3(calls);
    for (let i = 0; i < syms.length; i++) {
      const { success, returnData } = raw[i];
      if (!success) continue;
      try {
        const d             = iface.decodeFunctionResult("getReserveData", returnData);
        const liquidityRate = BigInt(d[2].toString());
        const rps           = Number(liquidityRate) / 1e27 / (365 * 24 * 3600);
        const apy           = ((1 + rps) ** (365 * 24 * 3600) - 1) * 100;
        const totalAToken   = BigInt(d[13].toString());
        const totalDebt     = BigInt(d[15].toString());
        const util          = totalAToken > 0n
          ? Number(totalDebt * 10_000n / (totalAToken + totalDebt)) / 100
          : 0;

        out.set(syms[i], {
          sym:           syms[i],
          liquidityRate, apy,
          aTokenAddress: d[8] as string,
          totalAToken,   totalDebt,
          utilization:   util,
        });
      } catch { /* skip asset */ }
    }
  } catch { /* multicall failed */ }

  return out;
}

// ── STRATEGY BUILDERS ─────────────────────────────────────────────────────────

// Annualized gas cost as % of managed position
// Assume 4 management txs/month × $0.15 gas each on Arbitrum
const GAS_PCT = (4 * 12 * 0.15 / CFG.managedUSD) * 100;

function calcTrend(now: number, d7: number | null, d30: number | null): Trend {
  const ref = d7 ?? d30;
  if (!ref || ref === 0) return "unknown";
  const d = (now - ref) / ref;
  if (d > 0.05) return "rising";
  if (d < -0.05) return "falling";
  return "stable";
}

// ── AAVE LENDING ──────────────────────────────────────────────────────────────

function buildAaveOpps(pools: LlamaPool[], oc: Map<string, AaveOnChain>): Opportunity[] {
  return pools
    .filter(p => p.project.toLowerCase().includes("aave") && p.tvlUsd >= CFG.minTvl)
    .slice(0, 10)
    .map((p, i): Opportunity => {
      const sym  = p.symbol.toUpperCase();
      const live = [...oc.entries()].find(([k]) => sym.includes(k))?.[1];
      const apy  = live?.apy ?? p.apy;

      const costs: CostBreakdown = {
        fundingCostAnnual: 0,
        executionCostPct:  0.05,
        gasCostAnnual:     GAS_PCT,
        oiPenalty:         0,
      };
      const netAPY    = Math.max(0, apy - costs.executionCostPct - costs.gasCostAnnual);
      const riskAdj   = netAPY * 0.97; // 3% smart-contract risk discount

      return {
        id:            `aave-${i}`,
        strategyType:  "AAVE_LENDING",
        protocol:      "Aave V3",
        pool:          p.symbol,
        asset:         sym,
        tvlUSD:        p.tvlUsd,
        grossAPY:      apy,
        costs,
        netAPY,
        riskAdjAPY:    riskAdj,
        risk: {
          ilRisk: false, counterpartyRisk: "low",
          liquidationRisk: false, rebalanceNeeded: false,
          oiBalance: null, oiRiskFlag: false,
        },
        history: { apy7d: p.apyBase7d, apy30d: p.apyMean30d, trend: calcTrend(apy, p.apyBase7d, p.apyMean30d), sigma: p.sigma },
        minTier:       "conservative",
        score:         riskAdj,
        verifiedOnChain: live !== undefined,
        llamaPoolId:   p.pool,
        address:       ADDR.AAVE_POOL,
      };
    });
}

// ── GMX REAL YIELD ────────────────────────────────────────────────────────────

function buildGMXOpps(pools: LlamaPool[], gmxStats: Map<string, GMXMarketStat>): Opportunity[] {
  return pools
    .filter(p => p.project.toLowerCase().includes("gmx") && p.tvlUsd >= CFG.minTvl)
    .slice(0, 8)
    .map((p, i): Opportunity => {
      const sym        = p.symbol.toUpperCase();
      const marketKey  = Object.keys(GMX_MARKETS).find(k => sym.includes(k.split("/")[0]));
      const stats      = marketKey ? gmxStats.get(marketKey) : null;
      const oiBal      = stats?.oiBalance ?? 0.5;
      const oiSkew     = Math.abs(oiBal - 0.5) * 2; // 0 = balanced, 1 = fully one-sided
      const oiRiskFlag = oiSkew > 0.40;

      const costs: CostBreakdown = {
        fundingCostAnnual: 0,
        executionCostPct:  0.10, // GMX mint/burn fee
        gasCostAnnual:     GAS_PCT,
        oiPenalty:         oiSkew * 6, // up to 6% discount when fully one-sided
      };
      const totalCost = costs.executionCostPct + costs.gasCostAnnual + costs.oiPenalty;
      const netAPY    = Math.max(0, p.apy - totalCost);
      const riskDisc  = 0.05 + oiSkew * 0.10; // base 5%, grows with OI skew
      const riskAdj   = netAPY * (1 - riskDisc);

      return {
        id:            `gmx-${i}`,
        strategyType:  "GMX_REAL_YIELD",
        protocol:      "GMX V2",
        pool:          p.symbol,
        asset:         marketKey ?? sym,
        tvlUSD:        p.tvlUsd,
        grossAPY:      p.apy,
        costs,
        netAPY,
        riskAdjAPY:    riskAdj,
        risk: {
          ilRisk: false,
          counterpartyRisk: oiRiskFlag ? "medium" : "low",
          liquidationRisk: false,
          rebalanceNeeded: oiRiskFlag,
          oiBalance: oiBal,
          oiRiskFlag,
        },
        history: { apy7d: p.apyBase7d, apy30d: p.apyMean30d, trend: calcTrend(p.apy, p.apyBase7d, p.apyMean30d), sigma: p.sigma },
        minTier:       "balanced",
        score:         riskAdj,
        verifiedOnChain: (stats?.fees24hUSD ?? 0) > 0,
        llamaPoolId:   p.pool,
        address:       GMX_MARKETS[marketKey ?? "ETH/USDC"]?.gm ?? "",
      };
    });
}

// ── DELTA-NEUTRAL LP ──────────────────────────────────────────────────────────

function buildDeltaNeutralOpps(pools: LlamaPool[], fundingRates: Map<string, number>): Opportunity[] {
  // Only hedgeable volatile/stable pairs with real volume data
  const hedgeable = pools.filter(p => {
    const sym = p.symbol.toUpperCase();
    const isHedgeable = Object.keys(HEDGE_ASSET).some(k => sym.includes(k));
    const hasStable   = sym.includes("USDC") || sym.includes("USDT") || sym.includes("DAI");
    const hasVolume   = (p.volumeUsd7d ?? 0) > 0;
    const isAMM       = p.project.toLowerCase().includes("uniswap") || p.project.toLowerCase().includes("camelot");
    return isAMM && isHedgeable && hasStable && hasVolume && p.tvlUsd >= CFG.minTvl;
  });

  return hedgeable.slice(0, 8).map((p, i): Opportunity => {
    const sym        = p.symbol.toUpperCase();
    const hedgeKey   = Object.keys(HEDGE_ASSET).find(k => sym.includes(k)) ?? "WETH";
    const hedgeAsset = HEDGE_ASSET[hedgeKey];
    const funding    = fundingRates.get(hedgeAsset) ?? 6.5;

    // Rebalance cost: concentrated LP drifts out of range ~twice/month
    const rebalanceCost = 2.0;

    const costs: CostBreakdown = {
      fundingCostAnnual: funding,
      executionCostPct:  0.20, // LP entry + perp open
      gasCostAnnual:     GAS_PCT + rebalanceCost,
      oiPenalty:         0,
    };
    const totalCost = costs.fundingCostAnnual + costs.executionCostPct + costs.gasCostAnnual;
    const netAPY    = Math.max(0, p.apy - totalCost);
    // 15% risk discount: execution risk, hedge basis, rebalance timing
    const riskAdj   = netAPY * 0.85;

    return {
      id:            `dn-${i}`,
      strategyType:  "DELTA_NEUTRAL",
      protocol:      `${p.project.replace(/-/g, " ")} + Perp Hedge`,
      pool:          p.symbol,
      asset:         sym,
      tvlUSD:        p.tvlUsd,
      grossAPY:      p.apy,
      costs,
      netAPY,
      riskAdjAPY:    riskAdj,
      risk: {
        ilRisk: false, // hedged
        counterpartyRisk: "medium", // perp exchange risk
        liquidationRisk: true,  // perp position can be liquidated
        rebalanceNeeded: true,
        oiBalance: null,
        oiRiskFlag: false,
      },
      history: { apy7d: p.apyBase7d, apy30d: p.apyMean30d, trend: calcTrend(p.apy, p.apyBase7d, p.apyMean30d), sigma: p.sigma },
      minTier:       "balanced",
      score:         riskAdj,
      verifiedOnChain: false,
      llamaPoolId:   p.pool,
      address:       "",
    };
  });
}

// ── RISK SCORING ENGINE ───────────────────────────────────────────────────────

const TIER_RANK: Record<RiskTier, number> = {
  conservative: 0, balanced: 1, aggressive: 2, advanced: 3,
};

function score(opp: Opportunity, tier: RiskTier): number {
  let s = opp.riskAdjAPY;

  // Reward APY stability: penalise high sigma
  if (opp.history.sigma != null) {
    const stabFactor = Math.max(0.5, 1 - opp.history.sigma / 50);
    s *= stabFactor;
  }

  // Reward when 30d mean supports current APY
  if (opp.history.apy30d && opp.history.apy30d > 0) {
    const consistency = 1 - Math.min(0.5, Math.abs(opp.grossAPY - opp.history.apy30d) / opp.history.apy30d);
    s *= (0.7 + 0.3 * consistency);
  }

  // Conservative users: give lending a priority boost
  if (tier === "conservative" && opp.strategyType === "AAVE_LENDING") s *= 1.2;

  // Penalise OI risk for GMX
  if (opp.risk.oiRiskFlag) s *= 0.80;

  return Math.max(0, s);
}

function rankForTier(opps: Opportunity[], tier: RiskTier): Opportunity[] {
  return opps
    .filter(o => TIER_RANK[o.minTier] <= TIER_RANK[tier])
    .map(o => ({ ...o, score: score(o, tier) }))
    .sort((a, b) => b.score - a.score);
}

// ── POSITION MONITOR ──────────────────────────────────────────────────────────

const ERC20_ABI_FRAG = ["function balanceOf(address) view returns (uint256)"];

const UNI_V3_PM_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];

const UNI_V3_POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

const UNI_V3_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
];

async function monitorAave(
  userAddr: string,
  oc: Map<string, AaveOnChain>,
  provider: JsonRpcProvider,
): Promise<AavePosition[]> {
  const result: AavePosition[] = [];
  const mc    = new Contract(ADDR.MULTICALL3, MC3_ABI, provider);
  const iface = new Interface(ERC20_ABI_FRAG);

  const entries = [...oc.entries()].filter(([, d]) =>
    d.aTokenAddress !== "0x0000000000000000000000000000000000000000"
  );
  if (entries.length === 0) return result;

  const calls = entries.map(([, d]) => ({
    target: d.aTokenAddress, allowFailure: true,
    callData: iface.encodeFunctionData("balanceOf", [userAddr]),
  }));

  try {
    const raw: { success: boolean; returnData: string }[] = await mc.aggregate3(calls);
    for (let i = 0; i < entries.length; i++) {
      const [sym, data] = entries[i];
      const { success, returnData } = raw[i];
      if (!success) continue;
      try {
        const bal  = iface.decodeFunctionResult("balanceOf", returnData)[0] as bigint;
        const dec  = TOKENS[sym]?.decimals ?? 18;
        const usd  = Number(bal) / 10 ** dec; // stablecoins ≈ USD
        if (usd < 1) continue;
        result.push({
          asset: sym, aTokenAddress: data.aTokenAddress,
          balanceUSD: usd, currentAPY: data.apy,
          utilization: data.utilization, healthFactor: 100,
        });
      } catch { /* skip */ }
    }
  } catch { /* multicall failed */ }

  return result;
}

async function monitorGMX(
  userAddr: string,
  gmxStats: Map<string, GMXMarketStat>,
  provider: JsonRpcProvider,
): Promise<GMXPosition[]> {
  const result: GMXPosition[] = [];
  const mc    = new Contract(ADDR.MULTICALL3, MC3_ABI, provider);
  const iface = new Interface(ERC20_ABI_FRAG);
  const mkts  = Object.entries(GMX_MARKETS);

  const calls = mkts.map(([, m]) => ({
    target: m.gm, allowFailure: true,
    callData: iface.encodeFunctionData("balanceOf", [userAddr]),
  }));

  try {
    const raw: { success: boolean; returnData: string }[] = await mc.aggregate3(calls);
    for (let i = 0; i < mkts.length; i++) {
      const [name, mkt] = mkts[i];
      const { success, returnData } = raw[i];
      if (!success) continue;
      try {
        const bal = iface.decodeFunctionResult("balanceOf", returnData)[0] as bigint;
        if (bal === 0n) continue;
        const stats = gmxStats.get(name);
        const oiBal = stats?.oiBalance ?? 0.5;
        result.push({
          market: name, gmToken: mkt.gm,
          gmBalance: bal,
          oiBalance: oiBal,
          oiRiskFlag: Math.abs(oiBal - 0.5) > 0.2,
        });
      } catch { /* skip */ }
    }
  } catch { /* multicall failed */ }

  return result;
}

async function monitorUniV3(
  tokenId: bigint,
  provider: JsonRpcProvider,
): Promise<UniV3Position | null> {
  try {
    const pm  = new Contract(ADDR.UNI_V3_PM, UNI_V3_PM_ABI, provider);
    const pos = await pm.positions(tokenId);

    const token0    = pos[2] as string;
    const token1    = pos[3] as string;
    const feeTier   = Number(pos[4]);
    const tickLower = Number(pos[5]);
    const tickUpper = Number(pos[6]);
    const liquidity = BigInt(pos[7].toString());
    const owed0     = BigInt(pos[10].toString()); // accumulated uncollected fees
    const owed1     = BigInt(pos[11].toString());

    const factory  = new Contract(ADDR.UNI_V3_FACTORY, UNI_V3_FACTORY_ABI, provider);
    const poolAddr = await factory.getPool(token0, token1, feeTier);
    const pool     = new Contract(poolAddr, UNI_V3_POOL_ABI, provider);
    const slot0    = await pool.slot0();
    const currentTick = Number(slot0[1]);
    const inRange     = currentTick >= tickLower && currentTick < tickUpper;

    const sym0 = Object.entries(TOKENS).find(([, t]) => t.address.toLowerCase() === token0.toLowerCase())?.[0] ?? "TK0";
    const sym1 = Object.entries(TOKENS).find(([, t]) => t.address.toLowerCase() === token1.toLowerCase())?.[0] ?? "TK1";
    const dec0 = TOKENS[sym0]?.decimals ?? 18;
    const dec1 = TOKENS[sym1]?.decimals ?? 18;

    // tokensOwed are accumulated protocol fees — approximate USD
    const fee0USD = Number(owed0) / 10 ** dec0;
    const fee1USD = Number(owed1) / 10 ** dec1;

    return {
      tokenId, poolAddress: poolAddr,
      token0: sym0, token1: sym1, feeTier,
      tickLower, tickUpper, currentTick, inRange, liquidity,
      fee0USD, fee1USD,
    };
  } catch { return null; }
}

// ── DISPLAY ───────────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", orange: "\x1b[38;5;208m",
  red: "\x1b[31m", cyan: "\x1b[36m", blue: "\x1b[34m",
  gray: "\x1b[90m", magenta: "\x1b[35m", white: "\x1b[97m",
} as const;

const STRAT_LABEL: Record<StrategyType, string> = {
  AAVE_LENDING:   `${C.blue}LEND${C.reset}`,
  GMX_REAL_YIELD: `${C.orange}PERP${C.reset}`,
  DELTA_NEUTRAL:  `${C.magenta}ΔNEU${C.reset}`,
};

const TIER_COL: Record<RiskTier, string> = {
  conservative: C.green, balanced: C.yellow, aggressive: C.orange, advanced: C.red,
};

function fAPY(n: number | null | undefined, plain = false): string {
  if (n == null || n < 0) return "    —   ";
  const s = n >= 1000 ? `${n.toFixed(0)}%` : n >= 100 ? `${n.toFixed(1)}%` : `${n.toFixed(2)}%`;
  if (plain) return s.padStart(8);
  const col = n >= 50 ? C.red : n >= 20 ? C.orange : n >= 10 ? C.yellow : C.green;
  return col + s.padStart(8) + C.reset;
}

function fUSD(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${(n / 1e3).toFixed(1)}K`;
}

const W   = 130;
const SEP = "═".repeat(W);
const DIV = "─".repeat(W);
const TREND = { rising: `${C.green}↑${C.reset}`, falling: `${C.red}↓${C.reset}`, stable: `${C.yellow}→${C.reset}`, unknown: " " };

function printMain(ranked: Opportunity[], ms: number, block: number): void {
  const now = new Date();
  console.log("\n" + SEP);
  console.log(
    C.bold + "  YIELDGEKO STRATEGY ENGINE  v1.0".padEnd(58) +
    now.toUTCString().padStart(W - 60) + C.reset
  );
  console.log(C.dim +
    `  Arbitrum · DeFiLlama + Multicall3 · block #${block.toLocaleString()} · ${ms}ms` +
    `  tier: ${TIER_COL[CFG.riskTier]}${CFG.riskTier}${C.reset}${C.dim}` +
    `  size: $${CFG.managedUSD.toLocaleString()}` + C.reset
  );
  console.log(SEP);

  // Column headers
  const hdr = [
    " # ", "Type", " Protocol                  ", " Pool                     ",
    "    TVL   ", " Gross APY", " Net APY ", " RAdj APY",
    " Fund% ", " 30d Mean", " Tr", " OI  ", "⛓",
  ].join("│");
  console.log("│" + hdr + "│");
  console.log("├" + DIV + "┤");

  ranked.forEach((o, i) => {
    const rank    = String(i + 1).padStart(3);
    const type    = STRAT_LABEL[o.strategyType];
    const proto   = o.protocol.slice(0, 26).padEnd(27);
    const pool    = o.pool.slice(0, 25).padEnd(26);
    const tvl     = fUSD(o.tvlUSD).padStart(9);
    const gross   = fAPY(o.grossAPY);
    const net     = fAPY(o.netAPY);
    const radj    = fAPY(o.riskAdjAPY);
    const funding = o.costs.fundingCostAnnual > 0
      ? `${C.dim}-${o.costs.fundingCostAnnual.toFixed(1)}%${C.reset}`.padEnd(8)
      : `${C.dim}  —  ${C.reset}  `;
    const mean30  = fAPY(o.history.apy30d);
    const tr      = TREND[o.history.trend];
    const oi      = o.risk.oiBalance != null
      ? (o.risk.oiRiskFlag ? C.red : C.green) + `${(o.risk.oiBalance * 100).toFixed(0)}%L` + C.reset
      : C.dim + "  — " + C.reset;
    const verify  = o.verifiedOnChain ? `${C.green}✓${C.reset}` : `${C.gray}·${C.reset}`;

    console.log(`│${rank}│${type}│${proto}│${pool}│${tvl} │${gross} │${net} │${radj} │${funding}│${mean30} │${tr} │${oi} │${verify}│`);
  });

  console.log(SEP);
}

function printCostTable(ranked: Opportunity[]): void {
  console.log("\n" + C.bold + "  FULL COST & RISK BREAKDOWN  (top 10)" + C.reset);
  console.log("  " + DIV.slice(0, 108));
  const h = `  ${"#".padEnd(3)} ${"Pool".padEnd(30)} ${"Gross".padStart(9)} ${"Funding".padStart(9)} ${"Exec".padStart(7)} ${"Gas+Reb".padStart(9)} ${"OI Pen".padStart(8)} ${"Net APY".padStart(9)} ${"RAdj".padStart(9)} ${"Counterparty".padStart(14)}`;
  console.log(C.dim + h + C.reset);

  ranked.slice(0, 10).forEach((o, i) => {
    const oiPen = o.costs.oiPenalty > 0 ? `-${o.costs.oiPenalty.toFixed(1)}%` : "   — ";
    const cpRisk = { none: `${C.green}none${C.reset}`, low: `${C.green}low${C.reset}`, medium: `${C.yellow}medium${C.reset}`, high: `${C.red}high${C.reset}` }[o.risk.counterpartyRisk];
    console.log(
      `  ${String(i + 1).padEnd(3)} ${o.pool.slice(0, 29).padEnd(30)}` +
      ` ${fAPY(o.grossAPY, true)}` +
      ` ${o.costs.fundingCostAnnual > 0 ? `-${o.costs.fundingCostAnnual.toFixed(1)}%`.padStart(9) : "      — "}` +
      ` ${`-${o.costs.executionCostPct.toFixed(2)}%`.padStart(7)}` +
      ` ${`-${o.costs.gasCostAnnual.toFixed(2)}%`.padStart(9)}` +
      ` ${oiPen.padStart(8)}` +
      ` ${fAPY(o.netAPY, true)}` +
      ` ${fAPY(o.riskAdjAPY, true)}` +
      `  ${cpRisk}`
    );
  });
}

function printPositions(pos: LivePositions): void {
  const hasAny = pos.aave.length > 0 || pos.gmx.length > 0 || pos.deltaNeutral;
  if (!hasAny) {
    console.log(C.dim + `\n  No positions found for ${CFG.userAddr}` + C.reset);
    return;
  }

  console.log("\n" + C.bold + `  LIVE POSITIONS  —  ${CFG.userAddr}` + C.reset);
  console.log("  " + DIV.slice(0, 80));

  if (pos.aave.length > 0) {
    console.log(`  ${C.blue}${C.bold}■ AAVE LENDING${C.reset}`);
    for (const p of pos.aave) {
      console.log(
        `    ${p.asset.padEnd(6)}  balance: ${C.bold}$${p.balanceUSD.toFixed(2)}${C.reset}` +
        `  APY: ${C.green}${p.currentAPY.toFixed(2)}%${C.reset}` +
        `  utilization: ${p.utilization.toFixed(1)}%`
      );
    }
  }

  if (pos.gmx.length > 0) {
    console.log(`  ${C.orange}${C.bold}■ GMX REAL YIELD${C.reset}`);
    for (const p of pos.gmx) {
      const oiCol = p.oiRiskFlag ? C.red : C.green;
      console.log(
        `    ${p.market.padEnd(10)}  ${p.gmBalance.toString()} GM tokens` +
        `  OI: ${oiCol}${(p.oiBalance * 100).toFixed(1)}% long${C.reset}` +
        `  ${p.oiRiskFlag ? C.red + "⚠ OI SKEWED" + C.reset : C.green + "balanced" + C.reset}`
      );
    }
  }

  if (pos.deltaNeutral) {
    const dn = pos.deltaNeutral;
    const rangeStr = dn.inRange ? C.green + "IN RANGE ✓" + C.reset : C.red + "OUT OF RANGE ✗" + C.reset;
    console.log(`  ${C.magenta}${C.bold}■ DELTA-NEUTRAL LP${C.reset}`);
    console.log(`    NFT #${dn.tokenId}  ${dn.token0}/${dn.token1}  fee: ${dn.feeTier / 10000}%`);
    console.log(`    Ticks: [${dn.tickLower}, ${dn.tickUpper}]  current: ${dn.currentTick}  ${rangeStr}`);
    console.log(
      `    Uncollected fees: ${C.green}$${(dn.fee0USD + dn.fee1USD).toFixed(4)}${C.reset}` +
      `  (${dn.token0}: $${dn.fee0USD.toFixed(4)}  ${dn.token1}: $${dn.fee1USD.toFixed(6)})`
    );
    if (!dn.inRange) {
      console.log(`    ${C.red}⚠  Position out of range — fees paused, consider rebalancing${C.reset}`);
    }
  }
}

function printLegend(ranked: Opportunity[]): void {
  const verified = ranked.filter(o => o.verifiedOnChain).length;
  const byType   = (t: StrategyType) => ranked.filter(o => o.strategyType === t).length;
  console.log(C.dim + [
    ``,
    `  Strategy types: ${C.blue}LEND${C.reset}${C.dim} Aave lending · ${C.orange}PERP${C.reset}${C.dim} GMX real yield · ${C.magenta}ΔNEU${C.reset}${C.dim} Delta-neutral LP`,
    `  Opportunities: ${byType("AAVE_LENDING")} lending · ${byType("GMX_REAL_YIELD")} GMX · ${byType("DELTA_NEUTRAL")} delta-neutral  |  ${verified}/${ranked.length} on-chain verified`,
    `  Gross APY: raw DeFiLlama  ·  Net APY: minus all costs  ·  RAdj APY: risk-discounted`,
    `  Fund%: annual funding cost for short hedge  ·  OI: % long open interest (50% = neutral)`,
    `  Trend: ${C.green}↑${C.reset}${C.dim}rising vs 7d  ${C.red}↓${C.reset}${C.dim}falling  ${C.yellow}→${C.reset}${C.dim}stable  ·  ⛓ ${C.green}✓${C.reset}${C.dim}on-chain verified`,
    ``,
  ].join("\n") + C.reset);
}

function printJSON(ranked: Opportunity[]): void {
  console.log(C.dim + "── JSON ──" + C.reset);
  console.log(JSON.stringify(ranked.map(o => ({
    id: o.id, strategyType: o.strategyType, protocol: o.protocol,
    pool: o.pool, tvlUSD: Math.round(o.tvlUSD),
    grossAPY: +o.grossAPY.toFixed(4), netAPY: +o.netAPY.toFixed(4), riskAdjAPY: +o.riskAdjAPY.toFixed(4),
    costs: { fundingCostAnnual: o.costs.fundingCostAnnual, executionCostPct: o.costs.executionCostPct, gasCostAnnual: o.costs.gasCostAnnual, oiPenalty: o.costs.oiPenalty },
    risk: { counterpartyRisk: o.risk.counterpartyRisk, ilRisk: o.risk.ilRisk, liquidationRisk: o.risk.liquidationRisk, oiBalance: o.risk.oiBalance, oiRiskFlag: o.risk.oiRiskFlag },
    history: o.history, minTier: o.minTier, score: +o.score.toFixed(4),
    verifiedOnChain: o.verifiedOnChain, llamaPoolId: o.llamaPoolId,
  })), null, 2));
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function run(provider: JsonRpcProvider, block: number): Promise<void> {
  const t0 = Date.now();
  process.stdout.write(`\r🔄  [${new Date().toISOString()}]  Fetching all data sources...     `);

  const [llamaPools, gmxStats, fundingRates, aaveOC] = await Promise.all([
    fetchLlamaPools(),
    fetchGMXStats(),
    fetchFundingRates(),
    verifyAaveOnChain(provider),
  ]);

  process.stdout.write(`\r🔄  Building opportunities...                                        `);

  const allOpps  = [
    ...buildAaveOpps(llamaPools, aaveOC),
    ...buildGMXOpps(llamaPools, gmxStats),
    ...buildDeltaNeutralOpps(llamaPools, fundingRates),
  ];
  const ranked = rankForTier(allOpps, CFG.riskTier);

  // Position monitoring
  const positions: LivePositions = { aave: [], gmx: [], deltaNeutral: null };
  if (CFG.userAddr) {
    process.stdout.write(`\r🔄  Monitoring positions for ${CFG.userAddr}...          `);
    const [aave, gmx] = await Promise.all([
      monitorAave(CFG.userAddr, aaveOC, provider),
      monitorGMX(CFG.userAddr, gmxStats, provider),
    ]);
    positions.aave = aave;
    positions.gmx  = gmx;
    if (CFG.uniTokenId) {
      positions.deltaNeutral = await monitorUniV3(CFG.uniTokenId, provider);
    }
  }

  process.stdout.write("\r" + " ".repeat(70) + "\r");

  printMain(ranked, Date.now() - t0, block);
  printCostTable(ranked);
  printLegend(ranked);
  if (CFG.userAddr) printPositions(positions);
  if (CFG.jsonOutput) printJSON(ranked);
}

async function main(): Promise<void> {
  console.log(C.bold + C.cyan + [
    "\n╔══════════════════════════════════════════════════════════════╗",
    "║  YIELDGEKO STRATEGY ENGINE  v1.0  ·  Arbitrum               ║",
    "║  Aave Lending  ·  GMX Real Yield  ·  Delta-Neutral LP       ║",
    "╚══════════════════════════════════════════════════════════════╝",
  ].join("\n") + C.reset);

  console.log(C.dim + [
    ``, `  RPC:      ${CFG.rpc}`,
    `  Tier:     ${TIER_COL[CFG.riskTier]}${CFG.riskTier}${C.reset}`,
    `  Size:     $${CFG.managedUSD.toLocaleString()} USD`,
    `  Min TVL:  ${fUSD(CFG.minTvl)}`,
    `  User:     ${CFG.userAddr ?? "(not set — position monitoring disabled)"}`,
    `  Refresh:  every ${CFG.refreshMs / 1000}s`, ``,
  ].join("\n") + C.reset);

  const provider = new JsonRpcProvider(CFG.rpc, 42161, {
    staticNetwork: true,
    batchMaxCount: 50,
  });

  let block = 0;
  try {
    block = await provider.getBlockNumber();
    console.log(`  ✅  Arbitrum block #${block.toLocaleString()}\n`);
  } catch {
    console.log(`  ⚠️   RPC unavailable — on-chain verification disabled\n`);
  }

  await run(provider, block);
  setInterval(async () => {
    try { block = await provider.getBlockNumber(); } catch { /* keep last */ }
    await run(provider, block).catch(console.error);
  }, CFG.refreshMs);
}

main().catch(console.error);
