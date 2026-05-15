/**
 * warm-intelligence.ts — smoke test for the IntelligenceEngine.
 * Run: npx ts-node --transpile-only scripts/warm-intelligence.ts
 */

import * as dotenv from 'dotenv';
import * as path   from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { IntelligenceEngine } from '../src/IntelligenceEngine';

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  YieldGeko Intelligence Engine — Smoke Test  ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  console.log('MORALIS_API_KEY set:', !!process.env.MORALIS_API_KEY);

  const engine = IntelligenceEngine.getInstance();

  console.log('\n[1/3] Warming engine (fetching DeFiLlama + LVR screen)...');
  await engine.warmUp();

  console.log('\n[2/3] Engine stats:');
  console.log(JSON.stringify(engine.stats, null, 2));

  console.log('\n[3/3] Scoring for balanced policy (Arbitrum, $10k)...');
  const opps = engine.getOpportunities({
    riskTier:     'balanced',
    managedUSD:   10_000,
    allowedChains: ['arbitrum'],
    minNetAPY:    2,
  });

  if (opps.length === 0) {
    console.log('⚠  No opportunities returned — DeFiLlama may still be loading.');
  } else {
    console.log(`\n✅  Top ${Math.min(opps.length, 5)} opportunities:\n`);
    for (const o of opps.slice(0, 5)) {
      console.log(
        `  ${o.strategyType.padEnd(18)} ${o.protocol.padEnd(25)}` +
        `  netAPY: ${o.netAPY.toFixed(1).padStart(6)}%` +
        `  gecko: ${o.geckoScore.toFixed(1).padStart(5)}` +
        `  TVL: $${(o.metrics.tvlUSD / 1e6).toFixed(1)}M`
      );
    }
  }

  console.log('\nDone.\n');
  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
// run with: npx ts-node --transpile-only scripts/debug-distribution.ts
