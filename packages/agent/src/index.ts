import { fetchAaveUSDCSupplyAPY } from './parsers/aave-v3';
import { fetchPendleMarketYield } from './parsers/pendle';
import { IntentProcessor } from './tee/intent-processor';
import { TEERuntime } from './tee/runtime';
import { VerificationGate, SafetyStatus } from './engine/verification-gate';
import { RouteBuilder } from './engine/route-builder';
import { FailureLogger } from './storage/failure-logger';
import { getAddress } from 'viem';

import { AgentIDManager } from './tee/agent-id';
import { TEESigner } from './tee/signer';
import { PrivateSubmitter } from './rpc/submitter';

async function main() {
  console.log("🦎 YieldGeko Agent: Day 6 Final Integration Validation...");

  try {
    // 1. Initialize TEE & Agent ID
    await TEERuntime.initialize();
    const agentAddress = await AgentIDManager.initializeAgentID();
    const attestation = await AgentIDManager.generateAttestationReport();
    console.log(`[TEE] Enclave Verified. Agent ID: ${agentAddress}`);

    // 2. Fetch Live State (Senses)
    console.log("[1/6] Fetching Live State from Arbitrum...");
    const aaveData = await fetchAaveUSDCSupplyAPY();
    const pendleData = await fetchPendleMarketYield();

    const venues = [
      {
        venue: "aave-v3-arbitrum-usdc",
        chainId: 42161,
        contractAddress: getAddress("0x794a61358D6845594F94dc1DB02A252b5b4814aD"),
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
        contractAddress: getAddress("0x46d62a8dede1bf2d0de04f2ed863245cbba5e538"),
        apyBps: pendleData.impliedApyBps,
        liquidityUsd: pendleData.liquidity,
        utilizationBps: 0n,
        riskScore: 82,
        lastUpdated: Date.now(),
        source: 'pendle'
      }
    ];

    // 3. TEE Intelligence (Brain)
    console.log("[2/6] Sealed Intelligence: Scoring & Ranking...");
    const ranked = await IntentProcessor.processIntent(
      { iv: 'mock', encrypted: 'mock' }, 
      'mock-key', 
      venues as any
    );
    const topChoice = ranked[0];
    console.log(` - Top Recommendation: ${topChoice.venue} (${(Number(topChoice.apyBps)/100).toFixed(2)}% APY)`);

    // 4. Pre-Verification Safety Gate
    console.log("[3/6] Pre-Execution Safety Verification...");
    const verification = await VerificationGate.verifySafety(
      topChoice.venue,
      topChoice.apyBps,
      1000n * 10n**6n
    );

    if (verification.status !== SafetyStatus.VERIFIED) {
      await FailureLogger.logAbort({
        userHash: '0x123',
        reason: verification.status,
        expectedApy: topChoice.apyBps,
        actualApy: verification.liveApyBps
      });
      return;
    }

    // 5. TEE Signing & Route Construction
    console.log("[4/6] Generating Hardware-Bound Signature...");
    const intent = { 
      user: getAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'), 
      minAPY: 200n, 
      maxSlippage: 100n, 
      nonce: 0n, 
      deadline: BigInt(Math.floor(Date.now()/1000) + 3600) 
    };

    const agentSignature = await TEESigner.signMigration({
      intent,
      fromStrategy: getAddress('0x0000000000000000000000000000000000000000'),
      toStrategy: getAddress(topChoice.contractAddress),
      asset: getAddress('0xaf88d065e77c8cC2239327C5EDB3A432268e5831'),
      amount: 1000n * 10n**6n,
      actualSlippageBps: 50n,
      actualAPY: topChoice.apyBps
    });

    const calldata = RouteBuilder.generateMigrationCalldata({
      intent,
      signature: agentSignature, // Hardware signature
      fromStrategy: getAddress('0x0000000000000000000000000000000000000000'),
      toStrategy: getAddress(topChoice.contractAddress),
      asset: getAddress('0xaf88d065e77c8cC2239327C5EDB3A432268e5831'),
      amount: 1000n * 10n**6n,
      actualSlippageBps: 50n,
      actualAPY: topChoice.apyBps
    });

    // 6. Private Submission
    console.log("[5/6] Submitting via Private 0G Compute RPC...");
    const txHash = await PrivateSubmitter.submitPrivately({
      to: getAddress('0x65a085d7F6e65a085D7F6E65A085d7f6E65a085D'), // Router Address
      data: calldata,
      gasLimit: 500000n
    });
    console.log(`✅ Migration Executed Successfully! TX: ${txHash}`);

    // 7. Cleanup & Wipe
    console.log("[6/6] Zeroizing Enclave Memory & Emitting Wipe Proof...");
    await TEERuntime.wipeMemory([ranked, venues, calldata, agentSignature]);
    
    console.log("\n🦎 Day 6 Final Integration COMPLETE.");

  } catch (error) {
    console.error("❌ Day 6 Validation Failed:", error);
  }
}

main();
