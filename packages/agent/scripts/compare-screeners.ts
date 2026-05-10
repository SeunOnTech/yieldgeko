#!/usr/bin/env npx ts-node
/**
 * YieldGeko — Screener V1 vs V2 Comparison
 *
 * Runs both screeners against live Arbitrum pool data and produces a side-by-side
 * report showing: ranking changes, pools V2 finds that V1 missed, volatility
 * differences, and netAPY deltas.
 *
 * Usage:
 *   cd packages/agent && npx ts-node scripts/compare-screeners.ts
 *
 * Output: console table + summary statistics
 */

import { ethers }   from 'ethers';
import * as dotenv  from 'dotenv';
import * as path    from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { getTopScreenedPools }   from '../src/orchestrator/protocols/uniV3Screener';
import { getTopScreenedPoolsV2 } from '../src/orchestrator/protocols/uniV3ScreenerV2';

const ARB_RPC = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const N       = 15; // compare top N pools from each screener

const dim   = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red   = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold  = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan  = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yell  = (s: string) => `\x1b[33m${s}\x1b[0m`;

function pct(n: number, dp = 1) { return `${n.toFixed(dp)}%`; }
function usd(n: number) { return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`; }
function fmt(n: number, dp = 2) { return n.toFixed(dp); }

async function main() {
  console.log('\n' + bold('═══════════════════════════════════════════════════════════'));
  console.log(bold('  YieldGeko — Screener V1 vs V2 Comparison'));
  console.log(bold('═══════════════════════════════════════════════════════════'));
  console.log(dim(`  Fetching live data from DeFiLlama + CoinGecko fallback...`));
  console.log(dim(`  This takes 30–90 seconds (parallel price fetches)\n`));

  const provider = new ethers.JsonRpcProvider(ARB_RPC, 42161, { staticNetwork: true });

  // Run both screeners in parallel
  const [v1Pools, v2Pools] = await Promise.all([
    getTopScreenedPools(N, provider),
    getTopScreenedPoolsV2(N, provider),
  ]);

  console.log(bold(`\n── V1 Results (top ${v1Pools.length} pools) ──────────────────────────────`));
  console.log(dim('  Rank  Pool                        Fee    NetAPY  σDaily  LVR    EpochRatio'));
  for (const [i, p] of v1Pools.entries()) {
    const marker = i === 0 ? green('★') : ' ';
    console.log(
      ` ${marker}${String(i + 1).padStart(3)}  ${p.symbol.padEnd(26)} `
      + `${String(p.feeTierBps / 100).padStart(5)}%  `
      + `${pct(p.netAPY).padStart(7)}  `
      + `${pct(p.sigmaRatioDaily).padStart(6)}  `
      + `${fmt(p.lvrRatio).padStart(5)}×  `
      + `${fmt(p.epochRatio).padStart(5)}×`,
    );
  }

  console.log(bold(`\n── V2 Results (top ${v2Pools.length} pools) ──────────────────────────────`));
  console.log(dim('  Rank  Pool                        Fee    NetAPY  RawAPY  30dMean  σDaily  LVR    PriceSource'));
  for (const [i, p] of v2Pools.entries()) {
    const marker = i === 0 ? green('★') : ' ';
    const spikeFlag = p.dllamaAPY > p.apyMean30d * 1.5 ? yell(' ⚠spike') : '';
    console.log(
      ` ${marker}${String(i + 1).padStart(3)}  ${p.symbol.padEnd(26)} `
      + `${String(p.feeTierBps / 100).padStart(5)}%  `
      + `${pct(p.netAPY).padStart(7)}  `
      + `${pct(p.dllamaAPY).padStart(7)}  `
      + `${pct(p.apyMean30d).padStart(8)}  `
      + `${pct(p.sigmaRatioDaily).padStart(6)}  `
      + `${fmt(p.lvrRatio).padStart(5)}×  `
      + dim(p.priceSource) + spikeFlag,
    );
  }

  // ── Cross-comparison ────────────────────────────────────────────────────────

  const v1Keys = new Set(v1Pools.map(p => p.address.toLowerCase()));
  const v2Keys = new Set(v2Pools.map(p => p.address.toLowerCase()));

  const onlyInV1 = v1Pools.filter(p => !v2Keys.has(p.address.toLowerCase()));
  const onlyInV2 = v2Pools.filter(p => !v1Keys.has(p.address.toLowerCase()));
  const inBoth   = v1Pools.filter(p =>  v2Keys.has(p.address.toLowerCase()));

  console.log(bold('\n── Ranking Differences ───────────────────────────────────'));

  if (inBoth.length > 0) {
    console.log(cyan('\n  Pools in both — rank & netAPY changes:'));
    console.log(dim('  Pool                        V1Rank → V2Rank  V1 NetAPY  V2 NetAPY  Δ NetAPY  σ Δ'));
    for (const p of inBoth) {
      const v1i = v1Pools.findIndex(x => x.address.toLowerCase() === p.address.toLowerCase());
      const v2p = v2Pools.find(x => x.address.toLowerCase() === p.address.toLowerCase())!;
      const v2i = v2Pools.findIndex(x => x.address.toLowerCase() === p.address.toLowerCase());
      const rankChange = v2i - v1i;
      const apyDelta   = v2p.netAPY - p.netAPY;
      const sigmaDelta = v2p.sigmaRatioDaily - p.sigmaRatioDaily;
      const rankStr = rankChange < 0 ? green(`↑${Math.abs(rankChange)}`) : rankChange > 0 ? red(`↓${rankChange}`) : dim('  =');
      const apyStr  = apyDelta   > 1  ? green(`+${pct(apyDelta)}`) : apyDelta < -1  ? red(`${pct(apyDelta)}`) : dim(pct(apyDelta));
      const sigStr  = sigmaDelta > 0.5 ? yell(`+${pct(sigmaDelta)}`) : sigmaDelta < -0.5 ? green(`${pct(sigmaDelta)}`) : dim(pct(sigmaDelta));
      console.log(
        `  ${p.symbol.padEnd(26)} ${String(v1i + 1).padStart(2)} → ${String(v2i + 1).padEnd(5)} `
        + ` ${pct(p.netAPY).padStart(10)}  ${pct(v2p.netAPY).padStart(10)}  ${apyStr.padStart(10)}  ${sigStr}`,
      );
    }
  }

  if (onlyInV1.length > 0) {
    console.log(red(`\n  Pools ONLY in V1 (V2 filtered these out — potentially overvalued in V1):`));
    for (const p of onlyInV1) {
      console.log(`  ${red('✗')} ${p.symbol.padEnd(30)} netAPY=${pct(p.netAPY)} σ=${pct(p.sigmaRatioDaily)} LVR=${fmt(p.lvrRatio)}×`);
    }
  }

  if (onlyInV2.length > 0) {
    console.log(green(`\n  Pools ONLY in V2 (V1 missed these — vol estimation improvement):`));
    for (const p of onlyInV2) {
      const src = p.priceSource === 'coingecko' ? yell(' [CoinGecko fallback]') : '';
      console.log(`  ${green('✓')} ${p.symbol.padEnd(30)} netAPY=${pct(p.netAPY)} σ=${pct(p.sigmaRatioDaily)} LVR=${fmt(p.lvrRatio)}×${src}`);
    }
  }

  // ── Statistical summary ──────────────────────────────────────────────────────

  console.log(bold('\n── Statistical Summary ────────────────────────────────────'));

  const v1AvgAPY   = v1Pools.reduce((s, p) => s + p.netAPY,          0) / v1Pools.length;
  const v2AvgAPY   = v2Pools.reduce((s, p) => s + p.netAPY,          0) / v2Pools.length;
  const v1AvgSigma = v1Pools.reduce((s, p) => s + p.sigmaRatioDaily, 0) / v1Pools.length;
  const v2AvgSigma = v2Pools.reduce((s, p) => s + p.sigmaRatioDaily, 0) / v2Pools.length;
  const v1AvgLVR   = v1Pools.reduce((s, p) => s + Math.min(p.lvrRatio, 100), 0) / v1Pools.length;
  const v2AvgLVR   = v2Pools.reduce((s, p) => s + Math.min(p.lvrRatio, 100), 0) / v2Pools.length;

  const coingeckoCount = v2Pools.filter(p => p.priceSource === 'coingecko').length;

  console.log(`  Pools returned:      V1=${v1Pools.length.toString().padStart(3)}   V2=${v2Pools.length.toString().padStart(3)}`);
  console.log(`  Avg netAPY:          V1=${pct(v1AvgAPY).padStart(8)}  V2=${pct(v2AvgAPY).padStart(8)}  Δ=${(v2AvgAPY > v1AvgAPY ? green : red)(pct(v2AvgAPY - v1AvgAPY))}`);
  console.log(`  Avg σ daily:         V1=${pct(v1AvgSigma).padStart(8)}  V2=${pct(v2AvgSigma).padStart(8)}  ${dim('(lower = less volatile pick)')}`);
  console.log(`  Avg LVR ratio:       V1=${fmt(v1AvgLVR, 1).padStart(7)}×  V2=${fmt(v2AvgLVR, 1).padStart(7)}×`);
  console.log(`  Only in V1:          ${red(String(onlyInV1.length))} pools (V2 filtered as over-risky or vol-inflated)`);
  console.log(`  Only in V2:          ${green(String(onlyInV2.length))} pools (V2 found via better vol or CoinGecko fallback)`);
  console.log(`  In both:             ${String(inBoth.length)} pools`);
  console.log(`  CoinGecko fallback:  ${coingeckoCount > 0 ? yell(String(coingeckoCount)) : '0'} pools used CoinGecko prices`);

  // ── Top pick comparison ──────────────────────────────────────────────────────

  const v1Top = v1Pools[0];
  const v2Top = v2Pools[0];

  console.log(bold('\n── Top Pick Comparison ───────────────────────────────────'));
  if (v1Top && v2Top) {
    const same = v1Top.address.toLowerCase() === v2Top.address.toLowerCase();
    if (same) {
      console.log(green(`  ✓ Both screeners agree on top pick: ${v1Top.symbol}`));
      console.log(`    V1 netAPY: ${pct(v1Top.netAPY)}  V2 netAPY: ${pct(v2Top.netAPY)}  Δ: ${pct(v2Top.netAPY - v1Top.netAPY)}`);
    } else {
      console.log(yell(`  ⚠ Screeners disagree on top pick!`));
      console.log(`    V1 top: ${v1Top.symbol.padEnd(30)} netAPY=${pct(v1Top.netAPY)} σ=${pct(v1Top.sigmaRatioDaily)}`);
      console.log(`    V2 top: ${v2Top.symbol.padEnd(30)} netAPY=${pct(v2Top.netAPY)} σ=${pct(v2Top.sigmaRatioDaily)}`);
      const v2RanksV1Top = v2Pools.findIndex(p => p.address.toLowerCase() === v1Top?.address.toLowerCase());
      const v1RanksV2Top = v1Pools.findIndex(p => p.address.toLowerCase() === v2Top?.address.toLowerCase());
      if (v2RanksV1Top >= 0) console.log(dim(`    V1's pick ranks #${v2RanksV1Top + 1} in V2`));
      if (v1RanksV2Top >= 0) console.log(dim(`    V2's pick ranks #${v1RanksV2Top + 1} in V1`));
      if (v2RanksV1Top < 0)  console.log(red(`    V1's pick was FILTERED OUT by V2`));
      if (v1RanksV2Top < 0)  console.log(green(`    V2's pick was MISSED by V1`));
    }
  }

  // ── Verdict ──────────────────────────────────────────────────────────────────

  console.log(bold('\n── Verdict ───────────────────────────────────────────────'));
  console.log(dim('  V2 improvements active:'));
  console.log(`  ${green('✓')} 60-day EWMA-only vol (was 30-day max of 4 windows)`);
  console.log(`  ${green('✓')} 7-day volume average for cAvg (was 24h — noisy)`);
  console.log(`  ${green('✓')} CoinGecko fallback with price divergence guard`);
  console.log(`  ${green('✓')} Per-user gas friction (not hardcoded $10k)`);
  console.log(`  ${green('✓')} apyMean30d for cAvg base (smoother than raw APY)`);
  console.log(dim('\n  See gecko-scorer-v2.ts for GeckoScore improvements (run after integrating screener).'));
  console.log('\n' + bold('═══════════════════════════════════════════════════════════') + '\n');
}

main().catch(e => { console.error('\n' + red(`Fatal: ${e.message}`)); process.exit(1); });
