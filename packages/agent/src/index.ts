import { ethers } from 'ethers';
import { LedgerLogger } from './storage/ledger-logger';
import { TEERuntime } from './tee/runtime';
import { AgentIDManager } from './tee/agent-id';
import { TEESigner } from './tee/signer';
import { getAddress } from 'viem';
import * as dotenv from 'dotenv';
import { fetchPendleMarketYield } from './parsers/pendle';
import { fetchAaveUSDCSupplyAPY } from './parsers/aave-v3';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

async function main() {
  console.log("🦎 YieldGeko Agent: Production Full-Lifecycle Manager...");

  // 1. Initialize Enclave & Signer
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  
  await TEERuntime.initialize();
  await AgentIDManager.initializeAgentID();

  let userPosition: { venueId: string; apy: number } | null = null;
  const userId = 'User_Alpha';
  const amount = 5000n * 10n**6n; // $5,000 USDC

  // 1. Live Yield Sync Logic
  const fetchYields = async () => {
    const [pendle, aave] = await Promise.all([
      fetchPendleMarketYield(),
      fetchAaveUSDCSupplyAPY()
    ]);
    return {
      pendle: { id: 'pendle', name: 'Pendle weETH', apy: Number(pendle.impliedApyBps) / 100 },
      aave: { id: 'aave', name: 'Aave USDC', apy: Number(aave.apyBps) / 100 }
    };
  };

  const syncDashboard = (yields: any) => {
    const status = {
      updatedAt: Date.now(),
      venues: [
        { ...yields.pendle, type: 'boost' },
        { ...yields.aave, type: 'safe' }
      ]
    };
    const publicPath = path.resolve(process.cwd(), '../../frontend/public/yield-status.json');
    fs.writeFileSync(publicPath, JSON.stringify(status, null, 2));
  };

  // 2. The Autonomous Management Loop
  const tick = async () => {
    console.log(`\n[Manager] 🦎 Checking state for ${userId}...`);
    try {
      const yields = await fetchYields();
      syncDashboard(yields);

      // A. GENESIS: Initial Deployment (If unallocated)
      if (!userPosition) {
        console.log(`[Genesis] 🚀 Unallocated funds detected ($5,000). Deploying to best safe venue...`);
        
        // Select best venue (preferring Aave for initial safety in this demo logic)
        const target = yields.aave; 
        
        const { cid } = await LedgerLogger.logAction(
          'GENESIS',
          { id: userId },
          target,
          null, // No previous venue
          amount,
          { migration: 0n, success: 0n, gas: 150000n },
          signer,
          process.env.INDEXER_URL!,
          process.env.RPC_URL!
        );

        userPosition = { venueId: target.id, apy: target.apy };
        console.log(`[Genesis] ✅ Initial Allocation Complete. CID: ${cid}`);
        return;
      }

      // B. MONITORING: Check for Spikes
      console.log(`[Monitor] Currently in ${userPosition.venueId} @ ${userPosition.apy}%. Scanning for uplift...`);
      
      const target = yields.pendle; // In our demo, Pendle is the boost target
      const uplift = target.apy - userPosition.apy;

      // Production Threshold: 2% uplift required to justify gas/risk
      if (uplift > 2.0) {
        console.log(`[Migration] 🔥 Yield Spike Detected! Pendle offers +${uplift.toFixed(2)}% uplift. Triggering migration...`);
        
        const { cid } = await LedgerLogger.logAction(
          'MIGRATION',
          { id: userId },
          target,
          { id: userPosition.venueId, apy: userPosition.apy },
          amount,
          { migration: (amount * 10n) / 10000n, success: (amount * 25n) / 10000n, gas: 150000n },
          signer,
          process.env.INDEXER_URL!,
          process.env.RPC_URL!
        );

        userPosition = { venueId: target.id, apy: target.apy };
        console.log(`[Migration] ✅ Swarm Migration Complete. CID: ${cid}`);
      } else {
        console.log(`[Monitor] Holding position. Uplift (${uplift.toFixed(2)}%) below threshold.`);
      }

    } catch (err: any) {
      console.error("[Manager] ❌ Tick failed:", err.message || err);
    }
  };

  // Run the loop
  tick();
  setInterval(tick, 60000); // Check every 60s
}

main();
