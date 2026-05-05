import { fetchAaveUSDCSupplyAPY } from './parsers/aave-v3';
import { fetchPendleMarketYield, DEFAULT_PENDLE_MARKET } from './parsers/pendle';
import { normalizeAaveData, normalizePendleData, applyRiskAdjustment } from './engine/normalize';
import { persistNormalizedYield } from './storage/persist';
import { generateKey } from '@yieldgeko/core';

async function main() {
  console.log('🦎 YieldGeko Agent: Omni-Fetcher Starting (Live State)...');

  try {
    // 1. Fetch Live State from Arbitrum
    console.log('[1/4] Fetching Live State from Arbitrum...');
    const aaveRaw = await fetchAaveUSDCSupplyAPY();
    const pendleRaw = await fetchPendleMarketYield(DEFAULT_PENDLE_MARKET);

    console.log(` - Aave USDC APY: ${(Number(aaveRaw.apyBps) / 100).toFixed(2)}%`);
    console.log(` - Pendle Implied APY: ${(Number(pendleRaw.impliedApyBps) / 100).toFixed(2)}%`);

    // 2. Normalize Data
    console.log('[2/4] Normalizing & Scoring Opportunities...');
    const aaveNorm = normalizeAaveData(aaveRaw);
    const pendleNorm = normalizePendleData(pendleRaw, DEFAULT_PENDLE_MARKET);

    // 3. Apply Risk Adjustments (e.g., for a Balanced User)
    console.log('[3/4] Applying Risk-Adjusted Scoring (Balanced Profile)...');
    const balancedAave = applyRiskAdjustment(aaveNorm, 'balanced');
    const balancedPendle = applyRiskAdjustment(pendleNorm, 'balanced');

    console.log(` - Adjusted Aave APY: ${(Number(balancedAave.apyBps) / 100).toFixed(2)}%`);
    console.log(` - Adjusted Pendle APY: ${(Number(balancedPendle.apyBps) / 100).toFixed(2)}%`);

    // 4. Persist to 0G Storage (Sealed Proof)
    console.log('[4/4] Sealing Intelligence to 0G Storage...');
    // Generate a temporary key for the demo
    const mockKey = await generateKey(); 
    const result = await persistNormalizedYield(balancedPendle, '0xUSER_ADDRESS', mockKey);

    console.log('\n✅ Day 3 Validation Complete:');
    console.log(` - Best Opportunity: ${balancedPendle.venue}`);
    console.log(` - 0G Storage CID: ${result.cid}`);
    console.log(` - Proof Hash: ${result.proofHash}`);

  } catch (error) {
    console.error('❌ Agent Execution Failed:', error);
  }
}

main();
