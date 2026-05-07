/**
 * ============================================================
 *  EVM YIELD AGGREGATOR — ARBITRUM  v2.0
 * ============================================================
 *  Architecture:
 *    Primary   → DeFiLlama Yields API   (APY, TVL, coverage)
 *    History   → DeFiLlama Chart API    (full APY timeseries)
 *    Verify    → Multicall3 on-chain    (Aave live rate check)
 *
 *  Why this beats direct RPC scraping:
 *    · Zero getLogs / block-range limits
 *    · 2000+ pools auto-covered — no manual ABI maintenance
 *    · Historical data built-in (7d / 30d / full chart)
 *    · Multicall3 batches all on-chain reads into one call
 *    · Works on any public RPC indefinitely
 *
 *  Env vars (all optional):
 *    ARB_RPC_URL      Arbitrum RPC  (default: publicnode)
 *    MIN_TVL_USD      Min pool TVL  (default: 500000)
 *    TOP_N            Pools to show (default: 25)
 *    HISTORY_POOLS    Pools with full sparkline (default: 8)
 *    VERIFY_POOLS     Pools to spot-check on-chain (default: 10)
 *    REFRESH_MS       Refresh interval ms (default: 60000)
 *    JSON_OUTPUT      Set to "1" to print JSON after table
 *
 *  Usage:
 *    pnpm --dir packages/agent exec ts-node scripts/yield-aggregator.ts
 * ============================================================
 */

import { Contract, Interface, JsonRpcProvider } from "ethers";

// ── CONFIG ────────────────────────────────────────────────────────────────────

const CFG = {
  rpc:          process.env.ARB_RPC_URL      ?? "https://arbitrum-one-rpc.publicnode.com",
  minTvl:       Number(process.env.MIN_TVL_USD    ?? 500_000),
  topN:         Number(process.env.TOP_N          ?? 25),
  historyPools: Number(process.env.HISTORY_POOLS  ?? 8),
  verifyPools:  Number(process.env.VERIFY_POOLS   ?? 10),
  refreshMs:    Number(process.env.REFRESH_MS     ?? 60_000),
  jsonOutput:   process.env.JSON_OUTPUT === "1",
  timeoutMs:    15_000,
} as const;

// ── CONSTANTS ─────────────────────────────────────────────────────────────────

const CHAIN        = "Arbitrum";
const MULTICALL3   = "0xcA11bde05977b3631167028862bE2a173976CA11";
const AAVE_DP      = "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654";

const LLAMA_POOLS  = "https://yields.llama.fi/pools";
const LLAMA_CHART  = (id: string) => `https://yields.llama.fi/chart/${id}`;

// Well-known Arbitrum token addresses for Aave verification
const AAVE_ASSETS: Record<string, string> = {
  USDC:  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  USDT:  "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  WETH:  "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  WBTC:  "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
  ARB:   "0x912CE59144191C1204E64559FE8253a0e49E6548",
  DAI:   "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
};

// ── TYPES ─────────────────────────────────────────────────────────────────────

interface RawPool {
  chain:             string;
  project:           string;
  symbol:            string;
  tvlUsd:            number;
  apyBase:           number | null;
  apyReward:         number | null;
  apy:               number;
  rewardTokens:      string[] | null;
  pool:              string;         // DeFiLlama UUID — key for chart API
  apyBase7d:         number | null;
  apyMean30d:        number | null;
  volumeUsd1d:       number | null;
  volumeUsd7d:       number | null;
  il7d:              number | null;
  underlyingTokens:  string[] | null;
  poolMeta:          string | null;
  stablecoin:        boolean;
  ilRisk:            string | null;
  mu:                number | null;  // DeFiLlama mean APY estimate
  sigma:             number | null;  // DeFiLlama APY std-dev
}

interface HistoryPoint {
  timestamp: string;
  tvlUsd:    number;
  apy:       number;
  apyBase:   number | null;
}

type Trend      = "rising" | "falling" | "stable" | "unknown";
type Volatility = "low" | "medium" | "high" | "unknown";

interface Pool extends RawPool {
  rank:          number;
  history:       HistoryPoint[];
  trend:         Trend;
  volatility:    Volatility;
  onChainAPY:    number | null;
  onChainVerify: "pass" | "warn" | "fail" | "skip";
}

// ── HTTP HELPERS ──────────────────────────────────────────────────────────────

async function get<T>(url: string): Promise<T | null> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CFG.timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function retry<T>(fn: () => Promise<T | null>, attempts = 3): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    const r = await fn();
    if (r !== null) return r;
    if (i < attempts - 1) await sleep(600 * (i + 1));
  }
  return null;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── LAYER 1: DEFILLAMA POOLS (primary) ───────────────────────────────────────

async function fetchPools(): Promise<RawPool[]> {
  const data = await retry(() =>
    get<{ status: string; data: RawPool[] }>(LLAMA_POOLS)
  );

  if (!data?.data) return [];

  return data.data
    .filter(p => p.chain === CHAIN)
    .filter(p => p.tvlUsd  >= CFG.minTvl)
    .filter(p => p.apy     >  0)
    .filter(p => p.apy     <  10_000)          // drop impossible outliers
    .sort((a, b) => b.tvlUsd - a.tvlUsd)       // secondary sort: TVL
    .sort((a, b) => b.apy - a.apy)             // primary sort: APY
    .slice(0, CFG.topN * 3);                   // fetch 3× buffer, trim after enrich
}

// ── LAYER 2: DEFILLAMA CHART (historical) ─────────────────────────────────────

async function fetchHistory(poolId: string): Promise<HistoryPoint[]> {
  const data = await retry(() =>
    get<{ status: string; data: HistoryPoint[] }>(LLAMA_CHART(poolId))
  );
  // last 90 calendar days, filtered to days with data
  return (data?.data ?? [])
    .filter(p => p.apy > 0)
    .slice(-90);
}

// Concurrent history fetch with concurrency cap (avoid hammering API)
async function fetchHistories(pools: RawPool[]): Promise<HistoryPoint[][]> {
  const targets = pools.slice(0, CFG.historyPools);
  const results: HistoryPoint[][] = [];
  const concurrency = 4;

  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    const fetched = await Promise.all(batch.map(p => fetchHistory(p.pool)));
    results.push(...fetched);
  }

  // Pad the rest with empty arrays
  while (results.length < pools.length) results.push([]);
  return results;
}

// ── LAYER 3: MULTICALL3 ON-CHAIN VERIFY ──────────────────────────────────────

const MC3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)",
];

const AAVE_DP_ABI = [
  "function getReserveData(address asset) view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)",
];

// Converts Aave RAY-encoded liquidityRate to annual APY %
function rayToAPY(liquidityRate: bigint): number {
  const RAY = 1e27;
  const ratePerSecond = Number(liquidityRate) / RAY / (365 * 24 * 3600);
  return ((1 + ratePerSecond) ** (365 * 24 * 3600) - 1) * 100;
}

// Returns map: DeFiLlama pool UUID → live on-chain APY
async function onChainVerify(
  pools: Pool[],
  provider: JsonRpcProvider,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  const aavePools = pools
    .filter(p => p.project.toLowerCase().includes("aave"))
    .slice(0, CFG.verifyPools);

  if (aavePools.length === 0) return result;

  // Match each Aave pool to a known underlying asset
  type VerifyTarget = { pool: Pool; asset: string };
  const targets: VerifyTarget[] = [];

  for (const pool of aavePools) {
    const sym = pool.symbol.toUpperCase();
    for (const [token, addr] of Object.entries(AAVE_ASSETS)) {
      if (sym.includes(token)) {
        targets.push({ pool, asset: addr });
        break;
      }
    }
  }

  if (targets.length === 0) return result;

  const mc  = new Contract(MULTICALL3, MC3_ABI, provider);
  const iface = new Interface(AAVE_DP_ABI);

  const calls = targets.map(t => ({
    target:      AAVE_DP,
    allowFailure: true,
    callData:    iface.encodeFunctionData("getReserveData", [t.asset]),
  }));

  try {
    const raw: { success: boolean; returnData: string }[] = await mc.aggregate3(calls);
    for (let i = 0; i < targets.length; i++) {
      const { success, returnData } = raw[i];
      if (!success) continue;
      try {
        const decoded = iface.decodeFunctionResult("getReserveData", returnData);
        const apy = rayToAPY(BigInt(decoded[5].toString()));
        result.set(targets[i].pool.pool, apy);
      } catch { /* decode failed for this one */ }
    }
  } catch { /* multicall reverted — skip verification */ }

  return result;
}

// ── ENRICH ────────────────────────────────────────────────────────────────────

function calcTrend(current: number, ref: number | null | undefined): Trend {
  if (!ref || ref === 0) return "unknown";
  const delta = (current - ref) / ref;
  if (delta >  0.05) return "rising";
  if (delta < -0.05) return "falling";
  return "stable";
}

function calcVolatility(sigma: number | null): Volatility {
  if (sigma == null) return "unknown";
  if (sigma <  3)   return "low";
  if (sigma < 10)   return "medium";
  return "high";
}

async function enrich(raw: RawPool[], provider: JsonRpcProvider): Promise<Pool[]> {
  // Fetch all histories concurrently
  const histories = await fetchHistories(raw);

  // Build initial Pool objects
  const pools: Pool[] = raw.map((p, i): Pool => ({
    ...p,
    rank:          i + 1,
    history:       histories[i] ?? [],
    trend:         calcTrend(p.apy, p.apyBase7d ?? p.apyMean30d),
    volatility:    calcVolatility(p.sigma),
    onChainAPY:    null,
    onChainVerify: "skip",
  }));

  // On-chain spot-check (single Multicall3 call)
  const liveRates = await onChainVerify(pools, provider);

  for (const pool of pools) {
    const live = liveRates.get(pool.pool);
    if (live == null) continue;
    pool.onChainAPY = live;
    const delta = Math.abs(live - pool.apy) / (pool.apy || 1);
    pool.onChainVerify = delta < 0.20 ? "pass" : delta < 0.50 ? "warn" : "fail";
  }

  return pools.slice(0, CFG.topN);
}

// ── TERMINAL COLORS ───────────────────────────────────────────────────────────

const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  orange: "\x1b[38;5;208m",
  red:    "\x1b[31m",
  cyan:   "\x1b[36m",
  gray:   "\x1b[90m",
  white:  "\x1b[97m",
} as const;

// ── FORMAT HELPERS ────────────────────────────────────────────────────────────

function fAPY(n: number | null | undefined): string {
  if (n == null || n <= 0) return "    —    ";
  if (n >= 1000) return `${n.toFixed(0)}%`.padStart(9);
  if (n >= 100)  return `${n.toFixed(1)}%`.padStart(9);
  return `${n.toFixed(2)}%`.padStart(9);
}

function fTVL(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fVol(n: number | null): string {
  if (n == null) return "    —   ";
  return fTVL(n).padStart(8);
}

function fIL(n: number | null): string {
  if (n == null) return "  — ";
  return (n >= 0 ? `+${n.toFixed(1)}` : n.toFixed(1)).padStart(6) + "%";
}

function apyColor(apy: number): string {
  if (apy >= 50) return C.red;
  if (apy >= 20) return C.orange;
  if (apy >= 10) return C.yellow;
  return C.green;
}

const TREND_ICON: Record<Trend, string>      = { rising: "↑", falling: "↓", stable: "→", unknown: " " };
const VOL_ICON:   Record<Volatility, string> = { low: "▁", medium: "▄", high: "█", unknown: "·" };
const VERIFY_ICON: Record<Pool["onChainVerify"], string> = {
  pass: `${C.green}✓${C.reset}`,
  warn: `${C.yellow}~${C.reset}`,
  fail: `${C.red}✗${C.reset}`,
  skip: `${C.gray}·${C.reset}`,
};

// ── SPARKLINE ─────────────────────────────────────────────────────────────────

function sparkline(history: HistoryPoint[], width = 24): string {
  const apys = history.slice(-width).map(h => h.apy).filter(a => a > 0);
  if (apys.length < 2) return " ".repeat(width);

  const min = Math.min(...apys);
  const max = Math.max(...apys);
  const bars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

  return apys.map(a => {
    const ratio = max > min ? (a - min) / (max - min) : 0.5;
    return bars[Math.floor(ratio * (bars.length - 1))];
  }).join("").padStart(width);
}

// ── DISPLAY ───────────────────────────────────────────────────────────────────

const W   = 122;
const SEP = "═".repeat(W);
const DIV = "─".repeat(W);

function printTable(pools: Pool[], fetchMs: number, block: number): void {
  const now = new Date();

  // Header
  console.log("\n" + SEP);
  console.log(
    C.bold +
    "  ARBITRUM YIELD AGGREGATOR  v2.0".padEnd(55) +
    now.toUTCString().padStart(W - 57) +
    C.reset
  );
  console.log(
    C.dim +
    `  DeFiLlama · Multicall3 · ${pools.length} pools shown · block #${block.toLocaleString()} · ${fetchMs}ms` +
    C.reset
  );
  console.log(SEP);

  // Column headers
  const h = [
    " #  ",
    " Protocol          ",
    " Pool                        ",
    "     TVL    ",
    "  APY(now) ",
    " APY(7d)  ",
    " APY(30d) ",
    "  Vol(7d)  ",
    "  IL(7d) ",
    " Vol⛓",
  ].join("│");
  console.log("│" + h + "│");
  console.log("├" + DIV + "┤");

  for (const p of pools) {
    const rank     = String(p.rank).padStart(3);
    const proto    = p.project.replace(/-/g, " ").slice(0, 17).padEnd(18);
    const pool     = (p.symbol + (p.poolMeta ? ` ${p.poolMeta}` : "")).slice(0, 28).padEnd(29);
    const tvl      = fTVL(p.tvlUsd).padStart(11);
    const tIcon    = TREND_ICON[p.trend];
    const apyLive  = (tIcon + fAPY(p.apy)).padStart(10);
    const apy7d    = fAPY(p.apyBase7d ?? undefined).padStart(9);
    const apy30d   = fAPY(p.apyMean30d ?? undefined).padStart(9);
    const vol7d    = fVol(p.volumeUsd7d).padStart(10);
    const il       = fIL(p.il7d).padStart(8);
    const vIcon    = VOL_ICON[p.volatility];
    const verified = VERIFY_ICON[p.onChainVerify];

    const color = apyColor(p.apy);
    console.log(
      `│ ${rank} │${proto}│${pool}│${tvl} │${color}${apyLive}${C.reset} │${apy7d} │${apy30d} │${vol7d} │${il} │ ${vIcon}${verified} │`
    );
  }

  console.log(SEP);
}

function printLegend(pools: Pool[]): void {
  const verified = pools.filter(p => p.onChainVerify === "pass").length;
  console.log(
    C.dim +
    `  Trend: ↑rising ↓falling →stable  ·  Vol: ▁low ▄mid █high  ·  ` +
    `⛓ ${C.green}✓${C.reset}${C.dim}on-chain pass ${C.yellow}~${C.reset}${C.dim}warn ${C.red}✗${C.reset}${C.dim}fail` +
    `  ·  ${verified}/${pools.length} verified on-chain` +
    `  ·  Min TVL: ${fTVL(CFG.minTvl)}` +
    C.reset
  );
}

function printHistory(pools: Pool[]): void {
  const withHistory = pools.filter(p => p.history.length >= 14).slice(0, CFG.historyPools);
  if (withHistory.length === 0) return;

  console.log("\n" + C.bold + "  90-DAY APY HISTORY" + C.reset);
  console.log("  " + "─".repeat(100));

  for (const p of withHistory) {
    const h    = p.history.filter(x => x.apy > 0);
    if (h.length < 2) continue;

    const apys = h.map(x => x.apy);
    const mean = apys.reduce((a, b) => a + b, 0) / apys.length;
    const max  = Math.max(...apys);
    const min  = Math.min(...apys);
    const spark = sparkline(h, 30);

    const onChain = p.onChainVerify === "pass" && p.onChainAPY != null
      ? `  ${C.green}on-chain:${fAPY(p.onChainAPY)}${C.reset}`
      : "";

    console.log(
      `  ${C.bold}${p.project.slice(0, 14).padEnd(14)}${C.reset}` +
      `  ${p.symbol.slice(0, 22).padEnd(22)}` +
      `  ${C.cyan}${spark}${C.reset}` +
      `  now:${C.bold}${apyColor(p.apy)}${fAPY(p.apy)}${C.reset}` +
      `  mean:${fAPY(mean)}` +
      `  min:${C.green}${fAPY(min)}${C.reset}` +
      `  max:${C.red}${fAPY(max)}${C.reset}` +
      onChain
    );
  }
}

function printTopSummary(pools: Pool[]): void {
  const top3 = pools.slice(0, 3);
  console.log("\n" + C.bold + "  TOP 3 BREAKDOWN" + C.reset);
  for (const p of top3) {
    const base   = p.apyBase   ?? 0;
    const reward = p.apyReward ?? 0;
    const tokens = (p.rewardTokens ?? []).join("+") || "—";
    console.log(
      `  ${C.bold}#${p.rank}${C.reset}  ${p.project.padEnd(18)}  ${p.symbol.padEnd(22)}` +
      `  base:${C.green}${fAPY(base)}${C.reset}` +
      `  reward:${C.yellow}${fAPY(reward)}${C.reset}  [${tokens}]` +
      `  TVL: ${fTVL(p.tvlUsd)}`
    );
  }
}

function printJSON(pools: Pool[]): void {
  const out = pools.map(p => ({
    rank:            p.rank,
    protocol:        p.project,
    pool:            p.symbol,
    meta:            p.poolMeta,
    tvlUSD:          Math.round(p.tvlUsd),
    apy:             round(p.apy),
    apyBase:         round(p.apyBase),
    apyReward:       round(p.apyReward),
    apy7d:           round(p.apyBase7d),
    apy30dMean:      round(p.apyMean30d),
    volumeUSD1d:     p.volumeUsd1d,
    volumeUSD7d:     p.volumeUsd7d,
    il7d:            p.il7d,
    trend:           p.trend,
    volatility:      p.volatility,
    stablecoin:      p.stablecoin,
    ilRisk:          p.ilRisk,
    rewardTokens:    p.rewardTokens ?? [],
    underlyingTokens: p.underlyingTokens ?? [],
    onChainAPY:      round(p.onChainAPY),
    onChainVerify:   p.onChainVerify,
    llamaPoolId:     p.pool,
  }));

  console.log("\n" + C.dim + "── JSON ──────────────────────────────────" + C.reset);
  console.log(JSON.stringify(out, null, 2));
}

const round = (n: number | null | undefined): number | null =>
  n != null ? +n.toFixed(4) : null;

// ── MAIN LOOP ─────────────────────────────────────────────────────────────────

async function run(provider: JsonRpcProvider, block: number): Promise<void> {
  const t0 = Date.now();
  process.stdout.write(`\r🔄  [${new Date().toISOString()}]  Fetching DeFiLlama...   `);

  const raw = await fetchPools();

  if (raw.length === 0) {
    console.error("\n❌  No pools — check connectivity to yields.llama.fi");
    return;
  }

  process.stdout.write(`\r🔄  [${new Date().toISOString()}]  Enriching ${raw.length} pools...  `);
  const pools = await enrich(raw, provider);

  process.stdout.write("\r" + " ".repeat(60) + "\r");

  const fetchMs = Date.now() - t0;
  printTable(pools, fetchMs, block);
  printLegend(pools);
  printTopSummary(pools);
  printHistory(pools);

  if (CFG.jsonOutput) printJSON(pools);
}

async function main(): Promise<void> {
  console.log(
    C.bold + C.cyan +
    "\n╔══════════════════════════════════════════════════════════════╗\n" +
    "║   EVM YIELD AGGREGATOR  ·  Arbitrum  ·  v2.0                ║\n" +
    "║   DeFiLlama · Multicall3 · Historical sparklines            ║\n" +
    "╚══════════════════════════════════════════════════════════════╝" +
    C.reset
  );

  console.log(C.dim + [
    ``,
    `  RPC:      ${CFG.rpc}`,
    `  Min TVL:  ${fTVL(CFG.minTvl)}`,
    `  Show top: ${CFG.topN} pools`,
    `  History:  ${CFG.historyPools} pools with sparklines`,
    `  Refresh:  every ${CFG.refreshMs / 1_000}s`,
    ``,
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
    console.log(`  ⚠️   RPC unreachable — on-chain verification disabled\n`);
  }

  await run(provider, block);

  setInterval(async () => {
    try { block = await provider.getBlockNumber(); } catch { /* keep last */ }
    await run(provider, block).catch(console.error);
  }, CFG.refreshMs);
}

main().catch(console.error);
