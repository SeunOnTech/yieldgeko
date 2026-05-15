import * as dotenv from 'dotenv';
import * as path   from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Force clear disk cache before importing engine
import * as fs from 'fs';
const cachePath = path.resolve(__dirname, '../data/universe.json');
if (fs.existsSync(cachePath)) { fs.unlinkSync(cachePath); console.log('[Test] Cleared disk cache — forcing fresh fetch'); }

import { IntelligenceEngine } from '../src/IntelligenceEngine';
import { invalidateLVRCache } from '../src/analysis/LVRScreener';

async function main() {
  invalidateLVRCache();
  const engine = IntelligenceEngine.getInstance();

  console.log('\nWarming engine with fresh data (LVR filter removed)...');
  await engine.warmUp();

  const all = engine.getOpportunities({ riskTier: 'advanced', managedUSD: 10_000, allowedChains: ['arbitrum'] });

  const byType: Record<string, typeof all> = {};
  for (const o of all) (byType[o.strategyType] ??= []).push(o);

  console.log('\n── Strategy distribution ────────────────────────────────');
  for (const [type, opps] of Object.entries(byType).sort((a,b) => b[1].length - a[1].length)) {
    console.log(`  ${type.padEnd(20)} ${opps.length} opportunities`);
    for (const o of opps.slice(0, 3)) {
      const lvrInfo = o.lvrRatio !== undefined ? `  lvrCoverage: ${o.lvrRatio.toFixed(2)}` : '';
      console.log(`    ${o.protocol.padEnd(30)} netAPY: ${o.netAPY.toFixed(1).padStart(6)}%  gecko: ${o.geckoScore.toFixed(1).padStart(5)}${lvrInfo}`);
    }
  }

  console.log('\n── Balanced tier top 10 ─────────────────────────────────');
  const balanced = engine.getOpportunities({ riskTier: 'balanced', managedUSD: 10_000, allowedChains: ['arbitrum'] });
  for (const o of balanced.slice(0, 10)) {
    const lvrInfo = o.lvrRatio !== undefined ? `  lvrCov: ${o.lvrRatio.toFixed(2)}` : '';
    console.log(`  ${o.strategyType.padEnd(18)} ${o.protocol.padEnd(28)} netAPY: ${o.netAPY.toFixed(1).padStart(6)}%  gecko: ${o.geckoScore.toFixed(1).padStart(5)}${lvrInfo}`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
