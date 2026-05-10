#!/usr/bin/env npx ts-node
/**
 * Address Registry — Architecture Test v2
 *
 * Corrected architecture:
 *   DeFiLlama = discovery engine  (APY, TVL, underlyingTokens)
 *   Protocol resolvers = address verification layer  (canonical EVM addresses)
 *
 * Key properties:
 *   ✓ Fully dynamic token resolution — uses underlyingTokens from DeFiLlama
 *   ✓ No hardcoded token map required
 *   ✓ ALL APY entries kept — no discarding by TVL rank
 *   ✓ APY sanity applied per-entry (not per-symbol)
 *   ✓ Protocol-specific resolvers for canonical address lookup
 *   ✓ On-chain verification before any entry is accepted
 *
 * Usage:
 *   npx ts-node scripts/test-address-registry.ts
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path   from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const ARB_RPC  = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const provider = new ethers.JsonRpcProvider(ARB_RPC, 42161, { staticNetwork: true });

// ── Types ─────────────────────────────────────────────────────────────────────

interface LlamaPool {
  pool:              string;
  project:           string;
  symbol:            string;
  chain:             string;
  tvlUsd:            number;
  apy:               number;
  apyBase?:          number;
  apyBase7d?:        number;
  apyMean30d?:       number;
  underlyingTokens?: string[];  // actual EVM addresses — our resolution input
}

interface ResolvedOpportunity {
  protocol:        string;
  strategy:        string;    // AAVE_LENDING, MORPHO_LENDING, DELTA_NEUTRAL, GMX_REAL_YIELD, PENDLE_PT/LP
  symbol:          string;
  address:         string;    // canonical EVM contract address
  apy:             number;    // raw APY
  sanitisedApy:    number;    // after sanity layers
  tvlUSD:          number;
  verifiedOnChain: boolean;
  method:          string;
  sanityFlag:      string | null;
  extra:           string;    // fee tier, expiry, etc.
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function isEvmAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

async function hasCode(addr: string): Promise<boolean> {
  try {
    const code = await provider.getCode(addr);
    return code !== '0x' && code.length > 10;
  } catch { return false; }
}

function section(title: string) {
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(64));
}

// ── APY sanity — three layers ─────────────────────────────────────────────────
//
//  Layer 1 — Hard cap: >200% means emissions dominating base yield → discard
//  Layer 2 — TVL credibility: thin pool = unsustainable → cap APY
//  Layer 3 — Spot vs 7d consistency (production only, skipped here)

function apySanity(apy: number, tvlUSD: number, apy7d?: number | null): { sanitised: number; flag: string | null } {
  if (apy > 200) {
    return { sanitised: 0, flag: `hard-cap: ${apy.toFixed(0)}% → 0% (emissions-dominated)` };
  }
  const tvlCap = tvlUSD < 500_000 ? 15 : tvlUSD < 2_000_000 ? 25 : 200;
  if (apy > tvlCap) {
    return { sanitised: tvlCap, flag: `tvl-cap: ${apy.toFixed(1)}% → ${tvlCap}% (TVL $${(tvlUSD/1e6).toFixed(1)}M)` };
  }
  return { sanitised: apy, flag: null };
}

// ── Token symbol cache ────────────────────────────────────────────────────────

const symCache = new Map<string, string>();
async function tokenSymbol(addr: string): Promise<string> {
  const k = addr.toLowerCase();
  if (symCache.has(k)) return symCache.get(k)!;
  try {
    const c = new ethers.Contract(addr, ['function symbol() view returns (string)'], provider);
    const s = await c.symbol() as string;
    symCache.set(k, s);
    return s;
  } catch { return addr.slice(2, 8); }
}

// ── DeFiLlama fetch ───────────────────────────────────────────────────────────

const SUPPORTED_PROJECTS = ['uniswap-v3', 'gmx-v2-perps', 'morpho-blue', 'pendle', 'aave-v3'];
const MIN_TVL = 500_000;

async function fetchLlamaPools(): Promise<LlamaPool[]> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  const res   = await fetch('https://yields.llama.fi/pools', { signal: ctrl.signal });
  clearTimeout(timer);
  const json  = await res.json() as any;
  return (json.data as LlamaPool[]).filter(
    p => p.chain === 'Arbitrum' &&
         p.tvlUsd >= MIN_TVL &&
         SUPPORTED_PROJECTS.some(proj => p.project?.includes(proj))
  );
}

// ── UniV3 resolver — fully dynamic via underlyingTokens ──────────────────────
//
//  No hardcoded token map. DeFiLlama's underlyingTokens gives us the real
//  EVM addresses. We try all 4 fee tiers and pick the deepest pool.

const UNI_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const FEE_TIERS   = [100, 500, 3000, 10000];
const POOL_LIQ_ABI = ['function liquidity() view returns (uint128)'];

async function resolveUniV3Pool(
  tokenA: string,
  tokenB: string,
): Promise<{ address: string; fee: number; liquidity: bigint } | null> {
  const factory = new ethers.Contract(UNI_FACTORY,
    ['function getPool(address,address,uint24) view returns (address)'], provider);

  let best: { address: string; fee: number; liquidity: bigint } | null = null;
  for (const fee of FEE_TIERS) {
    try {
      const addr: string = await factory.getPool(tokenA, tokenB, fee);
      if (addr === ethers.ZeroAddress) continue;
      const poolContract = new ethers.Contract(addr, POOL_LIQ_ABI, provider);
      const liq = await poolContract.liquidity() as bigint;
      if (!best || liq > best.liquidity) best = { address: addr, fee, liquidity: liq };
    } catch { /* fee tier not deployed */ }
  }
  return best;
}

async function resolveUniV3Opportunities(pools: LlamaPool[]): Promise<ResolvedOpportunity[]> {
  section('RESOLVER: Uniswap V3 — dynamic via underlyingTokens + factory.getPool()');
  const v3pools = pools.filter(p => p.project?.includes('uniswap-v3'));
  console.log(`  ${v3pools.length} UniV3 pools from DeFiLlama (TVL ≥ $${MIN_TVL/1e3}K)`);

  const results: ResolvedOpportunity[] = [];

  // Process in batches to avoid RPC rate limits
  for (const p of v3pools) {
    const tokens = p.underlyingTokens?.filter(isEvmAddress) ?? [];
    if (tokens.length < 2) continue;

    try {
      const resolved = await resolveUniV3Pool(tokens[0], tokens[1]);
      if (!resolved) continue;

      const live = await hasCode(resolved.address);
      if (!live) continue;

      const [symA, symB] = await Promise.all([tokenSymbol(tokens[0]), tokenSymbol(tokens[1])]);
      const feePct = resolved.fee / 10_000;
      const { sanitised, flag } = apySanity(p.apy, p.tvlUsd, p.apyBase7d);

      console.log(`  ✅ ${symA}-${symB} (${feePct}%)  ${p.apy.toFixed(1)}%→${sanitised.toFixed(1)}%  $${(p.tvlUsd/1e6).toFixed(1)}M  ${resolved.address.slice(0,12)}…${flag ? ' ⚠️ '+flag : ''}`);
      results.push({
        protocol: 'Uniswap V3', strategy: 'DELTA_NEUTRAL',
        symbol: `${symA}-${symB}`, address: resolved.address,
        apy: p.apy, sanitisedApy: sanitised, tvlUSD: p.tvlUsd,
        verifiedOnChain: live, method: `factory.getPool(${symA}, ${symB}, ${resolved.fee})`,
        sanityFlag: flag, extra: `fee: ${feePct}%`,
      });
    } catch { /* skip */ }
  }

  console.log(`\n  Resolved: ${results.length} UniV3 pools`);
  return results;
}

// ── Morpho resolver — Morpho Blue API ────────────────────────────────────────

async function resolveMorphoOpportunities(): Promise<ResolvedOpportunity[]> {
  section('RESOLVER: Morpho Blue — blue-api.morpho.org/graphql');

  const query = `{
    vaults(where: { chainId_in: [42161] }, orderBy: TotalAssetsUsd, orderDirection: Desc, first: 20) {
      items {
        address name symbol
        asset { address symbol decimals }
        state { apy netApy totalAssetsUsd }
      }
    }
  }`;

  const results: ResolvedOpportunity[] = [];
  try {
    const res  = await fetch('https://blue-api.morpho.org/graphql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }), signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json() as any;
    const vaults = json?.data?.vaults?.items ?? [];

    for (const v of vaults) {
      if ((v.state?.totalAssetsUsd ?? 0) < MIN_TVL) continue;
      const addr  = v.address as string;
      const apy   = (v.state?.apy ?? 0) * 100;
      const tvl   = v.state?.totalAssetsUsd ?? 0;
      const live  = isEvmAddress(addr) && await hasCode(addr);
      if (!live) continue;
      const { sanitised, flag } = apySanity(apy, tvl);
      console.log(`  ✅ ${v.symbol} (${v.asset?.symbol})  ${apy.toFixed(1)}%→${sanitised.toFixed(1)}%  $${(tvl/1e6).toFixed(1)}M${flag ? ' ⚠️ '+flag : ''}`);
      results.push({
        protocol: 'Morpho', strategy: 'MORPHO_LENDING',
        symbol: v.symbol, address: addr,
        apy, sanitisedApy: sanitised, tvlUSD: tvl,
        verifiedOnChain: live, method: 'blue-api.morpho.org/graphql',
        sanityFlag: flag, extra: v.name,
      });
    }
  } catch (e: any) { console.log(`  ❌ Morpho API: ${e.message}`); }

  console.log(`\n  Resolved: ${results.length} Morpho vaults`);
  return results;
}

// ── Pendle resolver — Pendle API v2 ──────────────────────────────────────────

async function resolvePendleOpportunities(): Promise<ResolvedOpportunity[]> {
  section('RESOLVER: Pendle — api-v2.pendle.finance/core/v1/42161/markets');

  const results: ResolvedOpportunity[] = [];
  try {
    const res  = await fetch('https://api-v2.pendle.finance/core/v1/42161/markets?limit=20&is_active=true',
      { signal: AbortSignal.timeout(10_000) });
    const json = await res.json() as any;
    const markets = (json?.results ?? []) as any[];

    for (const m of markets) {
      const addr   = m.address as string;
      const apy    = (m.impliedApy ?? 0) * 100;
      const tvl    = m.liquidity?.usd ?? 0;
      const expiry = m.expiry ? new Date(m.expiry).toISOString().slice(0, 10) : '?';
      const pt     = m.pt?.address ?? '';
      const yt     = m.yt?.address ?? '';
      const under  = typeof m.underlyingAsset === 'object' ? m.underlyingAsset?.symbol : m.underlyingAsset ?? '?';
      if (tvl < MIN_TVL) continue;
      if (!isEvmAddress(addr) || !isEvmAddress(pt)) continue;
      const live = await hasCode(addr);
      if (!live) continue;
      const { sanitised, flag } = apySanity(apy, tvl);

      // Each Pendle market surfaces as PT (fixed yield), LP (fees), YT (leveraged)
      for (const [strategy, multiplier, label] of [
        ['PENDLE_PT', 1.0, 'PT'],
        ['PENDLE_LP', 0.3, 'LP'],
        ['PENDLE_YT', 3.0, 'YT'],
      ] as [string, number, string][]) {
        const stratApy = apy * multiplier;
        const { sanitised: s, flag: f } = apySanity(stratApy, tvl);
        console.log(`  ✅ ${under} ${label} exp:${expiry}  ${stratApy.toFixed(1)}%→${s.toFixed(1)}%  $${(tvl/1e6).toFixed(1)}M${f ? ' ⚠️ '+f : ''}`);
        results.push({
          protocol: 'Pendle', strategy,
          symbol: `${under}-${expiry}`, address: addr,
          apy: stratApy, sanitisedApy: s, tvlUSD: tvl,
          verifiedOnChain: live, method: 'api-v2.pendle.finance/core/v1/42161/markets',
          sanityFlag: f, extra: `PT:${pt.slice(0,10)}… YT:${yt.slice(0,10)}… exp:${expiry}`,
        });
      }
    }
  } catch (e: any) { console.log(`  ❌ Pendle API: ${e.message}`); }

  console.log(`\n  Resolved: ${results.length} Pendle opportunities (PT+LP+YT)`);
  return results;
}

// ── Aave resolver — PoolAddressesProvider ────────────────────────────────────

async function resolveAaveOpportunities(): Promise<ResolvedOpportunity[]> {
  section('RESOLVER: Aave V3 — PoolAddressesProvider.getPool()');

  const PROVIDER_ADDR = '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb';
  const provCtx = new ethers.Contract(PROVIDER_ADDR,
    ['function getPool() view returns (address)'], provider);
  const poolAddr: string = await provCtx.getPool();
  const pool = new ethers.Contract(poolAddr, [
    'function getReservesList() view returns (address[])',
    'function getReserveData(address) view returns (tuple(uint256,uint128,uint128 currentLiquidityRate,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))',
  ], provider);

  const reserves: string[] = await pool.getReservesList();
  console.log(`  Pool: ${poolAddr}  |  ${reserves.length} active reserves`);

  const results: ResolvedOpportunity[] = [];
  for (const token of reserves) {
    try {
      const data   = await pool.getReserveData(token);
      const rateRay = BigInt(data[2].toString());
      const apy    = Number(rateRay) / 1e27 * 100;
      if (apy < 0.01) continue; // skip near-zero APY reserves
      const sym    = await tokenSymbol(token);
      const { sanitised, flag } = apySanity(apy, 1e9); // Aave is large, no TVL cap
      console.log(`  ✅ Aave ${sym}  ${apy.toFixed(2)}%→${sanitised.toFixed(2)}%${flag ? ' ⚠️ '+flag : ''}`);
      results.push({
        protocol: 'Aave V3', strategy: 'AAVE_LENDING',
        symbol: sym, address: poolAddr,
        apy, sanitisedApy: sanitised, tvlUSD: 1e9,
        verifiedOnChain: true, method: 'PoolAddressesProvider.getPool()',
        sanityFlag: flag, extra: `reserve: ${token}`,
      });
    } catch { /* skip */ }
  }

  console.log(`\n  Resolved: ${results.length} Aave reserves`);
  return results;
}

// ── GMX resolver — DataStore EnumerableSet ───────────────────────────────────

async function resolveGMXOpportunities(llamaPools: LlamaPool[]): Promise<ResolvedOpportunity[]> {
  section('RESOLVER: GMX V2 — DataStore.getAddressValuesAt() + DeFiLlama APY');

  const DATASTORE = '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8';
  const READER    = '0x60a0fF4cDaF0f6D496d71e0bC0fFa86FE8E6B23c';
  const USDC      = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
  const abiCoder  = ethers.AbiCoder.defaultAbiCoder();
  const mktListKey = ethers.keccak256(abiCoder.encode(['string'], ['MARKET_LIST']));
  const POOL_AMOUNT_KEY = ethers.keccak256(abiCoder.encode(['string'], ['POOL_AMOUNT']));

  const datastore = new ethers.Contract(DATASTORE, [
    'function getAddressCount(bytes32 setKey) view returns (uint256)',
    'function getAddressValuesAt(bytes32 setKey, uint256 start, uint256 end) view returns (address[])',
    'function getUint(bytes32 key) view returns (uint256)',
  ], provider);
  const reader = new ethers.Contract(READER, [
    'function getMarket(address dataStore, address key) view returns (tuple(address marketToken, address indexToken, address longToken, address shortToken))',
  ], provider);

  // Build DeFiLlama APY lookup for GMX (by normalised symbol — no deduplication)
  const gmxLlama = llamaPools.filter(p => p.project?.includes('gmx-v2'));
  const llamaByKey = new Map<string, LlamaPool[]>();
  for (const p of gmxLlama) {
    const key = p.symbol.toUpperCase().replace('WBTC.B','WBTC').replace(/\s/g,'-');
    if (!llamaByKey.has(key)) llamaByKey.set(key, []);
    llamaByKey.get(key)!.push(p);
  }

  const results: ResolvedOpportunity[] = [];
  try {
    const count   = Number(await datastore.getAddressCount(mktListKey));
    const markets = await datastore.getAddressValuesAt(mktListKey, 0, Math.min(count, 50)) as string[];
    console.log(`  DataStore: ${count} total markets, checking first ${markets.length}`);

    for (const mktAddr of markets) {
      try {
        const mkt = await reader.getMarket(DATASTORE, mktAddr);
        if (mkt.shortToken.toLowerCase() !== USDC.toLowerCase()) continue;

        const poolKey = ethers.keccak256(abiCoder.encode(
          ['bytes32','address','address'], [POOL_AMOUNT_KEY, mktAddr, USDC],
        ));
        const poolAmt = await datastore.getUint(poolKey) as bigint;
        const poolUSD = Number(poolAmt) / 1e6;
        if (poolUSD < 1_000_000) continue; // skip inactive markets

        const verified = isEvmAddress(mktAddr) && await hasCode(mktAddr);
        const indexSym = await tokenSymbol(mkt.indexToken);
        const symKey   = `${indexSym.toUpperCase().replace('WBTC.B','WBTC')}-USDC`;

        // Get ALL DeFiLlama APY entries for this market — don't discard any
        const llamaEntries = llamaByKey.get(symKey)
          ?? (indexSym.toUpperCase().includes('ETH') ? llamaByKey.get('ETH-USDC') : undefined)
          ?? [];

        if (!llamaEntries || llamaEntries.length === 0) {
          // No DeFiLlama APY data — still include with n/a APY
          console.log(`  ✅ GMX ${indexSym}/USDC  APY:n/a  pool:$${(poolUSD/1e6).toFixed(0)}M`);
          results.push({
            protocol: 'GMX V2', strategy: 'GMX_REAL_YIELD',
            symbol: `${indexSym}/USDC`, address: mktAddr,
            apy: 0, sanitisedApy: 0, tvlUSD: poolUSD,
            verifiedOnChain: verified, method: 'DataStore.getAddressValuesAt(MARKET_LIST)',
            sanityFlag: null, extra: `index:${mkt.indexToken}`,
          });
        } else {
          // One entry per DeFiLlama pool — ALL APYs kept
          for (const lp of llamaEntries) {
            const { sanitised, flag } = apySanity(lp.apy, lp.tvlUsd, lp.apyBase7d);
            console.log(`  ✅ GMX ${indexSym}/USDC  ${lp.apy.toFixed(1)}%→${sanitised.toFixed(1)}%  pool:$${(poolUSD/1e6).toFixed(0)}M  llama-tvl:$${(lp.tvlUsd/1e6).toFixed(0)}M${flag ? ' ⚠️ '+flag : ''}`);
            results.push({
              protocol: 'GMX V2', strategy: 'GMX_REAL_YIELD',
              symbol: `${indexSym}/USDC`, address: mktAddr,
              apy: lp.apy, sanitisedApy: sanitised, tvlUSD: lp.tvlUsd,
              verifiedOnChain: verified, method: 'DataStore.getAddressValuesAt(MARKET_LIST)',
              sanityFlag: flag, extra: `index:${mkt.indexToken} pool:$${(poolUSD/1e6).toFixed(0)}M`,
            });
          }
        }
      } catch { /* skip */ }
    }
  } catch (e: any) { console.log(`  ❌ GMX DataStore: ${e.message}`); }

  console.log(`\n  Resolved: ${results.length} GMX opportunities`);
  return results;
}

// ── Final report ──────────────────────────────────────────────────────────────

function printReport(all: ResolvedOpportunity[]): void {
  section('FULL OPPORTUNITY REPORT — sorted by sanitised APY');

  const verified = all.filter(r => r.verifiedOnChain);
  const byProtocol: Record<string, number> = {};
  for (const r of verified) byProtocol[r.protocol] = (byProtocol[r.protocol] ?? 0) + 1;

  // Sort by sanitised APY descending
  const sorted = [...verified].sort((a, b) => b.sanitisedApy - a.sanitisedApy);

  console.log(`\n  ${'Protocol'.padEnd(12)} ${'Strategy'.padEnd(18)} ${'Symbol'.padEnd(24)} ${'APY→Sanit'.padEnd(16)} ${'TVL'.padEnd(10)} Address`);
  console.log('  ' + '─'.repeat(110));

  for (const r of sorted) {
    const apyStr  = r.sanitisedApy > 0 ? `${r.apy.toFixed(1)}%→${r.sanitisedApy.toFixed(1)}%` : 'n/a';
    const tvlStr  = `$${(r.tvlUSD/1e6).toFixed(0)}M`;
    const flag    = r.sanityFlag ? ' ⚠️' : '';
    console.log(`  ${r.protocol.padEnd(12)} ${r.strategy.padEnd(18)} ${r.symbol.slice(0,23).padEnd(24)} ${apyStr.padEnd(16)} ${tvlStr.padEnd(10)} ${r.address.slice(0,14)}…${flag}`);
  }

  console.log(`\n  Total opportunities: ${all.length}  |  On-chain verified: ${verified.length}  |  Failed: ${all.length - verified.length}`);
  console.log('\n  Coverage by protocol:');
  for (const [p, n] of Object.entries(byProtocol)) {
    console.log(`    ✅ ${p} — ${n} opportunities`);
  }

  section('APY SANITY SUMMARY');
  const flagged = verified.filter(r => r.sanityFlag);
  console.log(`  Clean:   ${verified.length - flagged.length}`);
  console.log(`  Flagged: ${flagged.length}`);
  for (const r of flagged) {
    console.log(`  ⚠️  ${r.protocol} ${r.symbol}: ${r.sanityFlag}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  YieldGeko — Address Registry Architecture Test v2          ║');
  console.log('║  Dynamic tokens · All APYs · Protocol-canonical addresses   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`\n  RPC: ${ARB_RPC}  |  Min TVL: $${MIN_TVL/1e3}K`);

  // Step 1: Fetch DeFiLlama discovery data (single fetch, used by all resolvers)
  console.log('\n  Fetching DeFiLlama pools…');
  const llamaPools = await fetchLlamaPools();
  console.log(`  ${llamaPools.length} pools on Arbitrum across ${SUPPORTED_PROJECTS.join(', ')}`);

  // Step 2: Run all resolvers (some in parallel where independent)
  const [aave, morpho, pendle] = await Promise.all([
    resolveAaveOpportunities(),
    resolveMorphoOpportunities(),
    resolvePendleOpportunities(),
  ]);

  // UniV3 and GMX sequential — UniV3 makes many RPC calls, don't overwhelm
  const univ3 = await resolveUniV3Opportunities(llamaPools);
  const gmx   = await resolveGMXOpportunities(llamaPools);

  // Step 3: Report
  printReport([...aave, ...morpho, ...pendle, ...univ3, ...gmx]);

  console.log('\n══════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\n❌ Fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
