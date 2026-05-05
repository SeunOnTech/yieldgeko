import { fetchAaveUSDCSupplyAPY } from './parsers/aave-v3';
import { fetchPendleMarketYield } from './parsers/pendle';
import { IntentProcessor } from './tee/intent-processor';
import { TEERuntime } from './tee/runtime';
import { VerificationGate, SafetyStatus } from './engine/verification-gate';
import { RouteBuilder } from './engine/route-builder';
import { FailureLogger } from './storage/failure-logger';
import { getAddress } from 'viem';

async function main() {
  console.log("🦎 YieldGeko Agent: Day 5 Autonomous Safety Validation...");

  try {
    // 1. Initialize TEE
    await TEERuntime.initialize();

    // 2. Fetch Live State (Senses)
    console.log("[1/5] Fetching Live State from Arbitrum...");
    const aaveData = await fetchAaveUSDCSupplyAPY();
    const pendleData = await fetchPendleMarketYield();

    const venues = [
      {
        venue: "aave-v3-arbitrum-usdc",
        chainId: 42161,
        contractAddress: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
        apyBps: aaveData.apyBps,
        liquidityUsd: aaveData.liquidity,
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

    // 3. TEE Intelligence (Brain)
    console.log("[2/5] Sealed Intelligence: Scoring & Ranking...");
    const ranked = await IntentProcessor.processIntent(
      { iv: 'mock', encrypted: 'mock' }, 
      'mock-key', 
      venues as any
    );
    const topChoice = ranked[0];
    console.log(` - Top Recommendation: ${topChoice.venue} (${(Number(topChoice.apyBps)/100).toFixed(2)}% APY)`);

    // 4. Route Construction
    console.log("[3/5] Constructing Execution Route...");
    const calldata = RouteBuilder.generateMigrationCalldata({
      intent: { 
        user: getAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'), 
        minAPY: 200n, 
        maxSlippage: 100n, 
        nonce: 0n, 
        deadline: BigInt(Math.floor(Date.now()/1000) + 3600) 
      },
      signature: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      fromStrategy: getAddress('0x0000000000000000000000000000000000000000'),
      toStrategy: getAddress(topChoice.contractAddress),
      asset: getAddress('0xaf88d065e77c8cC2239327C5EDB3A432268e5831'), // USDC
      amount: 1000n * 10n**6n, // $1000
      actualSlippageBps: 50n,
      actualAPY: topChoice.apyBps
    });

    // 5. Pre-Verification Safety Gate (Crucial Day 5 step)
    console.log("[4/5] Pre-Execution Safety Verification...");
    
    // SIMULATION: We force an APY drift to test the abort logic
    const SIMULATE_DRIFT = true;
    const scoredApy = SIMULATE_DRIFT ? topChoice.apyBps + 100n : topChoice.apyBps; // Simulate that scored was 1% higher
    
    const verification = await VerificationGate.verifySafety(
      topChoice.venue,
      scoredApy,
      1000n * 10n**6n
    );

    if (verification.status !== SafetyStatus.VERIFIED) {
      console.log(`⚠️ HARD ABORT: ${verification.status} detected!`);
      const logCid = await FailureLogger.logAbort({
        userHash: '0x123',
        reason: verification.status,
        expectedApy: scoredApy,
        actualApy: verification.liveApyBps
      });
      console.log(` - Failure Logged to 0G Storage: ${logCid}`);
      console.log(" - Execution Halted. Capital Protected.");
    } else {
      console.log("✅ Safety Checks Passed. Proceeding to Signing...");
      const signature = await TEERuntime.signOutput({ calldata, verification });
      console.log(` - Route Signed: ${signature.slice(0, 20)}...`);
    }

    // 6. Cleanup
    await TEERuntime.wipeMemory([ranked, venues, calldata]);
    console.log("\n✅ Day 5 Validation Complete.");

  } catch (error) {
    console.error("❌ Day 5 Validation Failed:", error);
  }
}

main();
