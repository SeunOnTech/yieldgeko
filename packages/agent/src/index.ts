import { ethers } from 'ethers';
import { LedgerLogger } from './storage/ledger-logger';
import { TEERuntime } from './tee/runtime';
import { AgentIDManager } from './tee/agent-id';
import { ExecutionQueue, QueueTier } from './engine/queue';
import * as fs from 'fs';
import * as path from 'path';
import { AgentRuntimeState, AgentStateStore } from './storage/agent-state';
import { getAgentRuntimeConfig, loadAgentEnv } from './config/env';
import { OpportunityScout, ScannedVenue } from './discovery/opportunity-scout';

loadAgentEnv();

export interface YieldVenue {
  id: string;
  name: string;
  apy: number;
  protocol: string;
  score: number;
  stability: number;
}

function readOptionalCid(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const value = fs.readFileSync(filePath, 'utf8').trim();
  return value.length > 0 ? value : null;
}

function writeCid(filePath: string, cid: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, cid, 'utf8');
}

async function main() {
  console.log('🦎 YieldGeko Agent: Production Full-Lifecycle Manager...');

  const config = getAgentRuntimeConfig();

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const signer = new ethers.Wallet(config.privateKey, provider);

  await AgentIDManager.initializeAgentID();
  await TEERuntime.initialize();

  const queue = new ExecutionQueue();

  let runtimeState: AgentRuntimeState = {
    schemaVersion: 1,
    userId: config.userId,
    amount: config.managedAmount.toString(),
    currentPosition: null,
    updatedAt: Date.now(),
  };

  const savedQueueCid = readOptionalCid(config.queueCidPath);
  if (savedQueueCid) {
    try {
      await queue.restoreFromStorage(savedQueueCid, config.queueEncryptionKeyBase64, {
        indexerUrl: config.indexerUrl,
      });
      console.log(`[Bootstrap] Restored queue from ${savedQueueCid}`);
    } catch (error: any) {
      console.error(`[Bootstrap] Failed to restore queue: ${error.message || error}`);
    }
  }

  const savedStateCid = readOptionalCid(config.stateCidPath);
  if (savedStateCid) {
    try {
      runtimeState = await AgentStateStore.restoreState(
        savedStateCid,
        config.stateEncryptionKeyBase64,
        { indexerUrl: config.indexerUrl }
      );
      console.log(`[Bootstrap] Restored runtime state from ${savedStateCid}`);
    } catch (error: any) {
      console.error(`[Bootstrap] Failed to restore runtime state: ${error.message || error}`);
    }
  }

  const scout = new OpportunityScout(config.arbitrumRpcUrl, config.managedAmount);

  // 1. Live Yield Sync Logic
  const fetchYields = async (): Promise<YieldVenue[]> => {
    const leaderboard: ScannedVenue[] = await scout.getAlphaLeaderboard();
    return leaderboard.map((v, i) => ({
      id: `${v.venue.toLowerCase()}-${i}`,
      name: v.asset,
      apy: v.apy,
      protocol: v.venue,
      score: v.liquidityScore,
      stability: v.stabilityScore
    }));
  };

  const syncDashboard = (venues: YieldVenue[]) => {
    const status = {
      updatedAt: Date.now(),
      venues: venues.map(v => ({
        ...v,
        type: v.apy > 15 ? 'boost' : 'safe'
      }))
    };
    // Use absolute path relative to this file to be monorepo-safe
    const publicPath = path.resolve(__dirname, '../../../frontend/public/yield-status.json');
    fs.writeFileSync(publicPath, JSON.stringify(status, null, 2));
  };

  const persistRuntimeState = async () => {
    runtimeState.updatedAt = Date.now();
    const artifact = await AgentStateStore.persistState(runtimeState, config.stateEncryptionKeyBase64, {
      indexerUrl: config.indexerUrl,
      evmRpcUrl: config.rpcUrl,
      signer,
    });
    writeCid(config.stateCidPath, artifact.cid);
    console.log(`[State] Persisted runtime state CID: ${artifact.cid}`);
  };

  const persistQueue = async () => {
    const artifact = await queue.persistToStorage(config.queueEncryptionKeyBase64, {
      indexerUrl: config.indexerUrl,
      evmRpcUrl: config.rpcUrl,
      signer,
    });
    writeCid(config.queueCidPath, artifact.cid);
    console.log(`[Queue] Persisted queue CID: ${artifact.cid}`);
  };

  const processQueue = async () => {
    const nextItems = queue.getNextBatch(1);
    if (nextItems.length === 0) {
      return;
    }

    for (const item of nextItems) {
      const intent = item.intent as {
        type: 'GENESIS' | 'MIGRATION';
        target: YieldVenue;
        previousVenue?: { id: string; apy: number };
      };

      const operation = intent.type;
      const previousVenue = intent.previousVenue ? { id: intent.previousVenue.id, apy: intent.previousVenue.apy } : null;
      const fees =
        operation === 'GENESIS'
          ? { migration: 0n, success: 0n, gas: 150000n }
          : {
              migration: (config.managedAmount * 10n) / 10000n,
              success: (config.managedAmount * 25n) / 10000n,
              gas: 150000n,
            };

      const { cid } = await LedgerLogger.logAction(
        operation,
        { id: item.userId },
        intent.target,
        previousVenue,
        item.amount,
        fees,
        signer,
        config.indexerUrl,
        config.rpcUrl
      );

      runtimeState.currentPosition = {
        venueId: intent.target.id,
        venueName: intent.target.name,
        apy: intent.target.apy,
      };
      await persistRuntimeState();
      console.log(`[Queue] Processed ${operation} for ${item.userId}. Proof CID: ${cid}`);
    }

    await persistQueue();
  };

  // 2. The Autonomous Management Loop
  const tick = async () => {
    console.log(`\n[Manager] 🦎 Checking state for ${config.userId}...`);
    try {
      const venues = await fetchYields();
      syncDashboard(venues);

      // A. GENESIS: Initial Deployment (If unallocated)
      if (!runtimeState.currentPosition) {
        console.log(`[Genesis] 🚀 Unallocated funds detected ($${config.managedAmount}). Deploying to safest venue...`);

        const target = venues.find(v => v.protocol === 'Aave V3') || venues[venues.length - 1];
        queue.enqueue({
          userId: config.userId,
          intent: {
            type: 'GENESIS',
            target,
          },
          tier: QueueTier.YIELD_SEEK,
          amount: config.managedAmount,
          targetVenue: target.id,
          timestamp: Date.now(),
        });
        await persistQueue();
        await processQueue();
        return;
      }

      // B. MONITORING: Risk Analysis & Opportunity Scouting
      const currentPos = runtimeState.currentPosition;
      const currentVenue = venues.find(v => v.id === currentPos.venueId);
      
      console.log(
        `[Monitor] Currently in ${currentPos.venueName} @ ${currentPos.apy}%. Stability: ${currentVenue?.stability.toFixed(1) ?? '100'}%`
      );

      // --- SAFETY CHECK: CIRCUIT BREAKER ---
      // If current asset is depegging (< 95% stability), flee to Aave USDC
      if (currentVenue && currentVenue.stability < 95 && currentVenue.protocol !== 'Aave V3') {
        const safeHaven = venues.find(v => v.protocol === 'Aave V3') || venues[venues.length - 1];
        console.warn(`[CIRCUIT BREAKER] ⚠️ Stability alert on ${currentPos.venueName} (${currentVenue.stability.toFixed(1)}%). Fleeing to ${safeHaven.protocol}!`);
        
        queue.enqueue({
          userId: config.userId,
          intent: {
            type: 'MIGRATION',
            target: safeHaven,
            previousVenue: { id: currentPos.venueId, apy: currentPos.apy },
          },
          tier: QueueTier.SAFETY_EXIT,
          amount: config.managedAmount,
          targetVenue: safeHaven.id,
          timestamp: Date.now(),
        });
        await persistQueue();
        await processQueue();
        return;
      }

      // --- OPPORTUNITY ANALYSIS: FIND BEST VALID ALPHA ---
      // Find the highest yield venue that passes both Stability (> 95) and Liquidity (> 30)
      const target = venues.find(v => v.stability >= 95 && v.score >= 30);
      
      if (!target) {
          console.log(`[Monitor] No safe opportunities found on the leaderboard. Holding position.`);
          return;
      }

      const uplift = target.apy - currentPos.apy;

      // Production Threshold: 2% uplift required to justify gas/risk
      if (uplift > 2.0 && target.id !== currentPos.venueId) {
        console.log(`[Migration] 🔥 Yield Spike Detected! ${target.protocol} (${target.name}) offers +${uplift.toFixed(2)}% uplift. Triggering migration...`);

        queue.enqueue({
          userId: config.userId,
          intent: {
            type: 'MIGRATION',
            target,
            previousVenue: {
              id: runtimeState.currentPosition.venueId,
              apy: runtimeState.currentPosition.apy,
            },
          },
          tier: QueueTier.YIELD_SEEK,
          amount: config.managedAmount,
          targetVenue: target.id,
          timestamp: Date.now(),
        });
        await persistQueue();
        await processQueue();
      } else {
        console.log(`[Monitor] Holding position. Uplift (${uplift.toFixed(2)}%) below threshold.`);
      }

    } catch (err: any) {
      console.error("[Manager] ❌ Tick failed:", err.message || err);
    }
  };

  // Run the loop
  await tick();
  setInterval(tick, 60000); // Check every 60s
}

main();
