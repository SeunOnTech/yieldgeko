import { fetchAaveUSDCSupplyAPY } from './parsers/aave-v3';
import { fetchPendleMarketYield } from './parsers/pendle';
import { IntentProcessor } from './tee/intent-processor';
import { TEERuntime } from './tee/runtime';

async function main() {
  console.log("🦎 YieldGeko Agent: Day 4 Sealed Inference Validation...");

  try {
    // 1. Initialize TEE
    await TEERuntime.initialize();

    // 2. Fetch Live State (Senses)
    console.log("[1/4] Fetching Live State from Arbitrum...");
    const aaveData = await fetchAaveUSDCSupplyAPY();
    const pendleData = await fetchPendleMarketYield();

    const venues = [
      {
        venue: "aave-v3-arbitrum-usdc",
        chainId: 42161,
        contractAddress: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
        apyBps: aaveData.apyBps,
        liquidityUsd: aaveData.liquidity, // Use actual liquidity
        utilizationBps: aaveData.utilization,
        riskScore: 95,
        lastUpdated: Date.now(),
        source: 'aave-v3'
      },
      {
        venue: "pendle-market-weeth",
        chainId: 42161,
        contractAddress: "0x46d62a8dede1bf2d0de04f2ed863245cbba5e538",
        apyBps: pendleData.impliedApyBps,
        liquidityUsd: pendleData.liquidity,
        utilizationBps: 0n,
        riskScore: 82,
        lastUpdated: Date.now(),
        source: 'pendle'
      }
    ];

    console.log(` - Aave USDC APY: ${(Number(aaveData.apyBps) / 100).toFixed(2)}%`);
    console.log(` - Pendle Implied APY: ${(Number(pendleData.impliedApyBps) / 100).toFixed(2)}%`);

    // 3. Mock User Intent
    const mockIntent = {
      minApyBps: 200n, // 2% floor
      maxSlippageBps: 100n,
      riskTier: 'balanced',
      excludedVenues: []
    };
    
    console.log("[2/4] Processing TEE Intent (Decryption & Bounds Filtering)...");
    
    // 4. Scoring & Ranking (Brain)
    console.log("[3/4] Applying Deterministic Scoring inside Enclave...");
    const ranked = await IntentProcessor.processIntent(
      { iv: 'mock', encrypted: 'mock' }, 
      'mock-key', 
      venues as any
    );

    console.log(` - Best Rank: ${ranked[0].venue} (GeckoScore: ${ranked[0].geckoScore})`);

    // 5. Sealed Output & Wipe
    console.log("[4/4] Generating Sealed Output & Wiping Memory...");
    const signature = await TEERuntime.signOutput(ranked);
    const wipeProof = await TEERuntime.wipeMemory([mockIntent, ranked, venues]);

    console.log("\n✅ Day 4 Validation Complete:");
    console.log(` - Signature: ${signature.slice(0, 20)}...`);
    console.log(` - Wipe Proof: ${wipeProof}`);
    console.log(` - Verifiable Decision: ${ranked[0].venue} is the optimal yield.`);

  } catch (error) {
    console.error("❌ Agent Execution Failed:", error);
  }
}

main();
