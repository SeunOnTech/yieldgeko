

import * as dotenv from 'dotenv';
import * as path   from 'node:path';
import * as crypto from 'node:crypto';
import { ethers, JsonRpcProvider } from 'ethers';
import PQueue from 'p-queue';

import type {
  AgentState, UserState, Opportunity, Portfolio, PortfolioPosition,
  CircuitBreaker, ExecutionRecord, LogEntry, WithdrawalEvent,
} from './types';

import { fetchUniverse }                                      from './universe';
import { decideAllocation, runSafetyGate }                   from './allocation';
import { updatePortfolioPositions, updatePortfolioPositionsReal, checkCircuitBreakers, hasRedBreaker, buildExecutionRecord } from './monitor';
import { broadcast, broadcastToUser, setLatestState, startSSEServer, setRegisterCallback, setIsIdTakenCallback, setResetCallback, setWithdrawCallback, setPauseCallback, setResumeCallback, setForceMigrateCallback, setPatchPolicyCallback } from './sse';
import { OnChainProvider }                                   from './protocols';
import { PersistenceStore }                                  from './persistence';
import { getJournal }                                        from './journal';
import { anchorExecutionProof }                              from './zgChain';
import { proofService }                                      from './proof-service';
import { UserRegistry, DEMO_POLICIES, loadAllFromRedis }      from './users';
import { openPortfolio, planAllocation, buildPnLPoint }      from './portfolio';
import { evaluatePortfolioHarvests }                         from './compounder';
import { getExecutor, resolveAgentAddress, TOKEN_ADDRESSES } from './execution';
import type { ExecutionInput, OnChainExecutionResult }        from './execution';
import { assessAllDrifts }                                    from './driftMonitor';
import type { DriftResult }                                   from './driftMonitor';
import { adjustPoolForCapital, MIN_DELTA_NEUTRAL_USD }        from './protocols/uniV3Screener';
import { findUniV3MintProvenance, reconcileUniV3Position }   from './univ3-reconcile';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env.local'), override: true });

const RPC_URL         = process.env.ARB_RPC_URL    ?? 'https://arbitrum-one-rpc.publicnode.com';
const TICK_MS         = Number(process.env.TICK_MS              ?? 60_000);
const TICK_TIMEOUT    = Number(process.env.TICK_TIMEOUT_MS      ?? 90_000);
const MAX_ERRORS      = Number(process.env.MAX_TICK_ERRORS      ?? 3);
const UNIVERSE_MS     = Number(process.env.UNIVERSE_REFRESH_MS  ?? 300_000); 
const TICK_CONCURRENCY = Number(process.env.TICK_CONCURRENCY   ?? 50);       
const SHARD_COUNT      = Number(process.env.AGENT_SHARD_COUNT  ?? 1);        
const SHARD_INDEX      = Number(process.env.AGENT_SHARD_INDEX  ?? 0);        
const MAX_LOG          = 80;
const MAX_PNL          = 1_440;
const MAX_EXEC         = 50;

function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

function isMyUser(userId: string): boolean {
  if (SHARD_COUNT <= 1) return true;
  return fnv1a32(userId) % SHARD_COUNT === SHARD_INDEX;
}

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[Orchestrator] ${signal} — draining ${store?.pendingUploads ?? 0} pending 0G uploads...`);
  globalLog('WARN', `Shutdown: ${signal}`);
  const forceExit = setTimeout(() => {
    console.warn('[Orchestrator] Drain timeout (30s) — forcing exit');
    process.exit(1);
  }, 30_000);
  forceExit.unref();
  try {
    if (store) await store.drain();
  } catch (e: any) {
    console.warn('[Orchestrator] Drain error on shutdown:', e.message?.slice(0, 80));
  }
  clearTimeout(forceExit);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err: Error) => {
  console.error('[FATAL] Uncaught exception — agent continues:', err.message);
  globalLog('ERROR', `Uncaught: ${err.message}`, err.stack?.split('\n')[1]?.trim());
  pushState();
});

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[FATAL] Unhandled rejection — agent continues:', msg);
  globalLog('ERROR', `Rejection: ${msg}`);
  pushState();
});

let provider:  JsonRpcProvider;
let onChain:   OnChainProvider;
let store:     PersistenceStore;
let registry:  UserRegistry;

let tickRunning = false;

let agentState: AgentState = {
  users: {}, opportunities: [], globalLog: [],
  lastTickAt: 0, nextTickAt: Date.now() + TICK_MS, block: 0, tickCount: 0,
};

function mkEntry(level: LogEntry['level'], message: string, detail?: string): LogEntry {
  return { id: crypto.randomUUID(), timestamp: Date.now(), level, message, detail };
}

function globalLog(level: LogEntry['level'], message: string, detail?: string): void {
  const e = getJournal().addLog('__global__', level, message, detail);
  
  agentState.globalLog = [e, ...agentState.globalLog].slice(0, MAX_LOG);
  broadcast({ type: 'LOG', ts: Date.now(), payload: { userId: '__global__', entry: e } });
}

function userLog(userId: string, level: LogEntry['level'], message: string, detail?: string): void {
  const user = registry.get(userId);
  const e = getJournal().addLog(userId, level, message, detail, user?.activeSessionId);
  broadcastToUser(userId, { type: 'LOG', ts: Date.now(), payload: { userId, entry: e } });
}

function pushState(): void {
  agentState.users = registry.toRecord();
  
  for (const userId in agentState.users) {
    const journal = getJournal();
    (agentState.users[userId] as any).log = journal.getHotLogs(userId, 40);
    (agentState.users[userId] as any).executions = journal.getExecutions(userId, 10);
    (agentState.users[userId] as any).pnlHistory = journal.getPnLHistory(userId, 200).reverse();
  }
  setLatestState({ ...agentState });
}

async function runStartupUniV3ReconciliationSweep(): Promise<void> {
  const realUsers = registry.all().filter(user => user.policy.isReal && user.policy.smartAccountAddress && user.portfolio);
  if (realUsers.length === 0) return;

  console.log('  Running startup UniV3 reconciliation sweep...');

  let scannedStrategies = 0;
  let reconciledPositions = 0;
  let unresolvedPositions = 0;
  let ambiguousPositions = 0;

  for (const user of realUsers) {
    const portfolio = user.portfolio;
    if (!portfolio) continue;

    let changed = false;
    let nextPositions = portfolio.positions;
    const executions = getJournal().getExecutions(user.userId);

    for (const pos of portfolio.positions) {
      if (pos.strategyType !== 'DELTA_NEUTRAL') continue;
      scannedStrategies += 1;

      try {
        const reconciled = await reconcileUniV3Position({
          provider,
          strategyId: user.userId,
          smartAccountAddress: user.policy.smartAccountAddress,
          position: pos,
          executions,
        });

        if (reconciled.status === 'reconciled' && reconciled.positionPatch) {
          const tokenChanged = reconciled.tokenId !== pos.uniV3TokenId;
          const liquidityChanged = reconciled.liquidity !== pos.uniV3Liquidity;

          if (tokenChanged || liquidityChanged) {
            nextPositions = nextPositions.map(existing =>
              existing.id === pos.id
                ? { ...existing, ...reconciled.positionPatch, simulated: false }
                : existing,
            );
            reconciledPositions += 1;
            changed = true;
            userLog(
              user.userId,
              'SUCCESS',
              `Startup reconciliation repaired ${pos.venueName}`,
              `${reconciled.detail}${reconciled.matchedTxHash ? ` | tx:${reconciled.matchedTxHash.slice(0, 10)}…` : ''}`,
            );
          }
        } else if (reconciled.status === 'ambiguous') {
          ambiguousPositions += 1;
          userLog(user.userId, 'WARN', `Startup reconciliation found ambiguous UniV3 ownership for ${pos.venueName}`, reconciled.detail);
        } else {
          unresolvedPositions += 1;
          userLog(user.userId, 'WARN', `Startup reconciliation could not resolve ${pos.venueName}`, reconciled.detail);
        }
      } catch (err: any) {
        unresolvedPositions += 1;
        userLog(user.userId, 'WARN', `Startup reconciliation errored for ${pos.venueName}`, err.message);
      }
    }

    if (changed) {
      registry.update(user.userId, {
        portfolio: {
          ...portfolio,
          positions: nextPositions,
          updatedAt: Date.now(),
        },
      });
      store.save(user.userId, registry.get(user.userId)!, true);
    }
  }

  console.log(`  🔧  UniV3 sweep scanned ${scannedStrategies} strategy position(s)`);
  console.log(`  ✅  Repaired:    ${reconciledPositions}`);
  console.log(`  ⚠️   Ambiguous:  ${ambiguousPositions}`);
  console.log(`  ⚠️   Unresolved: ${unresolvedPositions}`);
  console.log('');
}

async function runStartupExecutionProofBackfillSweep(): Promise<void> {
  const realUsers = registry.all().filter(user => user.policy.isReal && user.policy.userAddress && user.policy.smartAccountAddress && user.portfolio);
  if (realUsers.length === 0) return;

  console.log('  Running startup execution proof backfill sweep...');

  let scannedExecutions = 0;
  let recoveredExecutions = 0;
  let anchoredExecutions = 0;
  let unresolvedExecutions = 0;

  for (const user of realUsers) {
    const positions = user.portfolio?.positions ?? [];
    const deltaNeutralPositions = positions.filter(pos => pos.strategyType === 'DELTA_NEUTRAL' && pos.uniV3TokenId);
    const executions = getJournal().getExecutions(user.userId, 50);

    for (const execution of executions) {
      if (execution.action !== 'REBALANCE_UNIV3') continue;

      const missingProof = !execution.zgChainExplorer && !execution.zgTraceCID && !execution.zgAttestCID;
      const needsExecutionRecovery = !execution.txHash || execution.simulated || execution.status === 'planned';
      if (!missingProof && !needsExecutionRecovery) continue;

      scannedExecutions += 1;

      const targetPosition = execution.positionId
        ? positions.find(pos => pos.id === execution.positionId)
        : deltaNeutralPositions.length === 1
          ? deltaNeutralPositions[0]
          : undefined;

      if (!targetPosition?.uniV3TokenId || !targetPosition.venueAddress) {
        unresolvedExecutions += 1;
        continue;
      }

      try {
        const mintProvenance = await findUniV3MintProvenance({
          provider: provider as JsonRpcProvider,
          smartAccountAddress: user.policy.smartAccountAddress!,
          tokenId: execution.uniV3TokenId ?? targetPosition.uniV3TokenId,
        });
        if (!mintProvenance) {
          unresolvedExecutions += 1;
          continue;
        }

        const recoveredPatch: Partial<ExecutionRecord> = {
          txHash: execution.txHash ?? mintProvenance.txHash,
          simulated: false,
          status: execution.status === 'failed' ? 'failed' : 'reconciled',
          uniV3TokenId: execution.uniV3TokenId ?? targetPosition.uniV3TokenId,
          positionId: execution.positionId ?? targetPosition.id,
          replacedPositionId: execution.replacedPositionId ?? targetPosition.id,
          proofBackfilledAt: Date.now(),
          proofBackfillSource: 'recovered-mint-tx',
        };
        getJournal().updateExecution(user.userId, execution.receiptHash, recoveredPatch);
        recoveredExecutions += 1;

        if (missingProof) {
          proofService.submit({
            userId:         user.userId,
            userAddress:    user.policy.userAddress!,
            receiptHash:    execution.receiptHash,
            arbitrumTxHash: recoveredPatch.txHash ?? mintProvenance.txHash,
            action:         'REBALANCE',
            timestamp:      execution.timestamp,
            poolAddress:    targetPosition.venueAddress,
            amountUSD:      execution.amountUSD,
          });
          anchoredExecutions += 1;
          userLog(
            user.userId, 'SUCCESS',
            `Queued proof recovery for ${targetPosition.venueName} rebalance`,
            `mint tx:${mintProvenance.txHash.slice(0, 10)}…`,
          );
        }
      } catch (err: any) {
        unresolvedExecutions += 1;
        userLog(user.userId, 'WARN', 'Startup rebalance-proof recovery failed', err.message);
      }
    }

    store.save(user.userId, registry.get(user.userId)!, true);
  }

  pushState();
  console.log(`  🔧  Proof sweep scanned ${scannedExecutions} execution(s)`);
  console.log(`  ✅  Recovered:   ${recoveredExecutions}`);
  console.log(`  ✅  Anchored:    ${anchoredExecutions}`);
  console.log(`  ⚠️   Unresolved: ${unresolvedExecutions}`);
  console.log('');
}

function requireUniqueStrategyTarget(input: { userId?: string; userAddress?: string }): UserState {
  if (input.userId) {
    const byId = registry.get(input.userId);
    if (!byId) throw new Error(`Strategy not found: ${input.userId}`);
    return byId;
  }

  const wanted = input.userAddress?.toLowerCase();
  if (!wanted) throw new Error('Strategy target missing: provide userId');

  const matches = registry.all().filter(u => u.policy.userAddress?.toLowerCase() === wanted);
  if (matches.length === 0) {
    throw new Error(`Strategy not found for wallet ${input.userAddress}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous wallet target ${input.userAddress}: ${matches.length} strategies found. ` +
      `Provide userId to target a specific strategy.`,
    );
  }
  return matches[0];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<null>(r => { timer = setTimeout(() => r(null), ms); }),
  ]).then(v => { clearTimeout(timer); return v as T | null; });
}

function isEvmAddress(value: string | undefined): value is string {
  return Boolean(value && /^0x[a-fA-F0-9]{40}$/.test(value));
}

function resolvesToLiveUSDCExecution(opp: Opportunity): boolean {
  const symbol = `${opp.asset} ${opp.pool}`.toUpperCase();

  switch (opp.strategyType) {
    case 'AAVE_LENDING':
    case 'MORPHO_LENDING':
    case 'LEVERAGED_LOOP':
      return symbol.includes('USDC');

    case 'GMX_REAL_YIELD':
      
      return process.env.GMX_ENABLED === 'true' && isEvmAddress(opp.address);

    case 'DELTA_NEUTRAL':
      
      
      
      return isEvmAddress(opp.address);

    case 'PENDLE_PT':
      
      
      return isEvmAddress(opp.address) && Boolean(opp.ptAddress);

    case 'PENDLE_LP':
      
      return isEvmAddress(opp.address);

    case 'PENDLE_YT':
      
      
      return isEvmAddress(opp.address);

    default:
      return false;
  }
}

function filterLiveExecutableOpportunities(opportunities: Opportunity[], userId: string): Opportunity[] {
  const live    = opportunities.filter(resolvesToLiveUSDCExecution);
  const skipped = opportunities.length - live.length;
  if (skipped > 0) {
    userLog(userId, 'INFO',
      `Live execution filter: ${live.length}/${opportunities.length} opportunities executable`,
      skipped > 0 ? `${skipped} filtered (missing address, non-USDC pair, or missing PT address)` : undefined,
    );
  }
  return live;
}

function buildLiveExecutionInput(
  opportunity:    Opportunity,
  policy:         UserState['policy'],
  currentPrice?:  number,
  portfolioValueUSD?: number,
): ExecutionInput {
  if (!policy.userAddress) throw new Error('Real execution requires userAddress');
  if (!resolvesToLiveUSDCExecution(opportunity)) {
    throw new Error(`${opportunity.strategyType} ${opportunity.pool} is not enabled for live USDC execution`);
  }

  
  
  
  
  let rangePct: number | undefined = opportunity.lvrOptimalRangePct;
  if (opportunity.strategyType === 'DELTA_NEUTRAL') {
    if (MIN_DELTA_NEUTRAL_USD > 0 && policy.managedUSD < MIN_DELTA_NEUTRAL_USD) {
      throw new Error(
        `Capital $${policy.managedUSD} below minimum $${MIN_DELTA_NEUTRAL_USD} for DELTA_NEUTRAL — route to passive yield`,
      );
    }
    
    
    const forceOptimal = process.env.FORCE_OPTIMAL_RANGE === 'true';
    if (!forceOptimal && opportunity.lvrSigmaDaily !== undefined) {
      const adj = adjustPoolForCapital(
        {
          dllamaAPY:       opportunity.grossAPY,
          cAvg:            opportunity.lvrCAvg ?? 3.5,
          sigmaRatioDaily: opportunity.lvrSigmaDaily,
        } as any,
        policy.managedUSD,
      );
      if (!adj) {
        throw new Error(
          `No viable range for $${policy.managedUSD} in ${opportunity.pool} — gas overhead too high, route to passive yield`,
        );
      }
      rangePct = adj.rangePct;
    }
  }

  return {
    strategyType:  opportunity.strategyType,
    asset:         TOKEN_ADDRESSES.USDC,
    amount:        BigInt(Math.round(policy.managedUSD * 1e6)),
    amountUSD:     policy.managedUSD,
    userAddress:   policy.userAddress,
    marketAddress: opportunity.address,
    currentPrice,
    tokenPrices:   onChain.getPrices(),
    assertedAPY:   Math.round((opportunity.netAPY ?? 0) * 100),
    rangePct,
    
    userId:            policy.id,
    portfolioValueUSD: portfolioValueUSD ?? policy.managedUSD,
    
    recipientAddress:  policy.smartAccountAddress,
  };
}

function patchFromExecutionResult(result: OnChainExecutionResult): Partial<PortfolioPosition> {
  const patch: Partial<PortfolioPosition> = { simulated: false };
  if (result.uniV3TokenId)        patch.uniV3TokenId        = result.uniV3TokenId.toString();
  if (result.uniV3Liquidity)      patch.uniV3Liquidity      = result.uniV3Liquidity.toString();
  if (result.gmxOrderKey)         patch.gmxOrderKey         = result.gmxOrderKey;
  
  if (result.uniV3TickLower  !== undefined) patch.uniV3TickLower  = result.uniV3TickLower;
  if (result.uniV3TickUpper  !== undefined) patch.uniV3TickUpper  = result.uniV3TickUpper;
  if (result.uniV3CenterTick !== undefined) patch.uniV3CenterTick = result.uniV3CenterTick;
  if (result.uniV3RangePct   !== undefined) patch.uniV3RangePct   = result.uniV3RangePct;
  if (result.uniV3EntryPool)                patch.uniV3EntryPool  = result.uniV3EntryPool;
  
  if (result.entryLiquidityIndex) patch.entryLiquidityIndex = result.entryLiquidityIndex.toString();
  if (result.morphoShares)        patch.morphoShares        = result.morphoShares.toString();
  if (result.pendleLpAmount)      patch.pendleLpAmount      = result.pendleLpAmount.toString();
  return patch;
}

function buildRealExecutionRecord(
  base: ExecutionRecord,
  patch: Partial<ExecutionRecord>,
): ExecutionRecord {
  return {
    ...base,
    ...patch,
  };
}

function strategyScopeHash(strategyId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(strategyId));
}

const DRIFT_TRIGGER = process.env.DRIFT_TRIGGER ? parseFloat(process.env.DRIFT_TRIGGER) : 0.70;

async function tickUser(
  user:           UserState,
  elapsed:        number,
  ocSnapshot:     any,
  driftMap:       Map<string, DriftResult>,
  batchPositions: import('./protocols').UserOnChainPositions | null,
): Promise<void> {
  const { userId, policy } = user;

  if (user.phase === 'WITHDRAWING' || user.phase === 'WITHDRAWN') {
    return;
  }

  
  
  
  if (user.phase === 'PAUSED') {
    const vaultAddr = process.env.VAULT_ADDRESS ?? '';
    
    
    if (policy.signedDelegation) {
      registry.setPhase(userId, 'MONITORING');
      userLog(userId, 'SUCCESS', 'V2 user auto-resumed — no vault pause, enforcer handles policy on-chain');
      store.save(userId, registry.get(userId)!);
      pushState();
    } else if (policy.isReal && policy.userAddress && vaultAddr) {
      try {
        const vaultCheck = new (await import('ethers')).ethers.Contract(
          vaultAddr,
          ['function userPaused(address) view returns (bool)'],
          provider,
        );
        const stillPaused: boolean = await vaultCheck.userPaused(policy.userAddress);
        if (!stillPaused) {
          registry.setPhase(userId, 'MONITORING');
          userLog(userId, 'SUCCESS', 'On-chain pause cleared — agent resuming management');
          store.save(userId, registry.get(userId)!);
          pushState();
          
        } else {
          if (agentState.tickCount % 30 === 0) {
            userLog(userId, 'WARN',
              'User paused on-chain by vault drawdown protection — agent suspended until operator calls resumeUser()',
            );
          }
          return;
        }
      } catch {
        return; 
      }
    } else {
      return;
    }
  }

  
  const opportunities: Opportunity[] = agentState.opportunities;

  
  const currentUser = registry.get(userId)!;
  const prices      = onChain.getPrices();

  if (currentUser.portfolio) {
    
    
    const VAULT_ADDRESS = process.env.VAULT_ADDRESS ?? '';
    
    const effectiveUserAddr = policy.smartAccountAddress ?? policy.userAddress;
    const canReadOnChain    = policy.isReal && policy.userAddress
      && (VAULT_ADDRESS || !!policy.smartAccountAddress);
    const updatedPortfolio = canReadOnChain
      ? await updatePortfolioPositionsReal(
          currentUser.portfolio, opportunities, elapsed, prices, provider, VAULT_ADDRESS, effectiveUserAddr, batchPositions || undefined,
        )
      : updatePortfolioPositions(
          currentUser.portfolio, opportunities, elapsed, prices,
        );

    const pnlPoint = buildPnLPoint(updatedPortfolio);
    getJournal().addPnL(userId, pnlPoint);
    registry.update(userId, {
      portfolio:  updatedPortfolio,
    });

    broadcastToUser(userId, { type: 'PORTFOLIO', ts: Date.now(), payload: { userId, portfolio: updatedPortfolio } });

    
    
    
    
    
    
    
    
    
    
    if (policy.isReal && policy.userAddress) {
      const executor = getExecutor();
      if (executor) {
        const lastReported = (currentUser as any)._lastReportedUSD ?? 0;
        const lastReportTick = (currentUser as any)._lastReportTick ?? 0;
        const currentUSD = updatedPortfolio.metrics.totalValueUSD;
        const pctChange  = lastReported > 0 ? Math.abs(currentUSD - lastReported) / lastReported : 1;
        const ticksSinceLast = agentState.tickCount - lastReportTick;

        
        
        
        
        const inRebalanceTransition = updatedPortfolio.positions.some(p => {
          if (p.strategyType !== 'DELTA_NEUTRAL' || !p.id) return false;
          const drift = driftMap.get(p.id);
          return drift !== undefined && drift.liquidity === 0n;
        });

        const skipUntilTick = (currentUser as any)._skipReportValueUntilTick ?? 0;
        const shouldReport = !inRebalanceTransition
          && agentState.tickCount > skipUntilTick
          && (
            pctChange >= 0.005      
            || ticksSinceLast >= 30  
            || lastReported === 0    
          );

        if (shouldReport) {
          
          executor.updateDelegationPreValue(userId, currentUSD);

          
          if (!policy.signedDelegation) {
            executor.reportValueOnChain(policy.userAddress, currentUSD)
              .then(() => {
                registry.update(userId, {
                  _lastReportedUSD:  currentUSD,
                  _lastReportTick:   agentState.tickCount,
                } as any);
              })
              .catch((err: Error) => userLog(userId, 'WARN', `reportValue failed: ${err.message}`));
          }
        }
      }
    }
  }

  
  
  
  if (policy.isReal && policy.userAddress) {
    const executor = getExecutor();
    let portfolioNow = registry.get(userId)?.portfolio;

    if (executor && portfolioNow) {
      
      
      
      const burnedIds = portfolioNow.positions
        .filter(p => p.strategyType === 'DELTA_NEUTRAL' && (p as any).nftBurned === true)
        .map(p => p.id);
      if (burnedIds.length > 0) {
        const cleanPositions = portfolioNow.positions.filter(p => !burnedIds.includes(p.id));
        registry.update(userId, {
          phase: cleanPositions.length === 0 ? 'IDLE' : undefined,
          portfolio: { ...portfolioNow, positions: cleanPositions, metrics: { ...portfolioNow.metrics, totalValueUSD: 0, peakValueUSD: 0 } },
        } as any);
        userLog(userId, 'WARN', `Burned NFT detected — cleared ${burnedIds.length} position(s), resetting to IDLE for re-deployment`);
        return; 
      }

      
      
      
      
      const journalExecutions = getJournal().getExecutions(currentUser.userId);
      const reconciledThisTick = new Set<string>();
      for (const pos of portfolioNow.positions) {
        const needsReconciliation =
          pos.strategyType === 'DELTA_NEUTRAL' &&
          policy.smartAccountAddress &&
          (!pos.uniV3TokenId || pos.uniV3Liquidity === '0' || pos.uniV3Liquidity === null);

        if (!needsReconciliation) continue;

        try {
          const reconciled = await reconcileUniV3Position({
            provider: provider as JsonRpcProvider,
            strategyId: userId,
            smartAccountAddress: policy.smartAccountAddress,
            position: pos,
            executions: journalExecutions,
          });

          if (reconciled.status === 'reconciled' && reconciled.positionPatch) {
            const tokenChanged = reconciled.tokenId !== pos.uniV3TokenId;
            const liquidityChanged = reconciled.liquidity !== pos.uniV3Liquidity;
            if (!tokenChanged && !liquidityChanged) continue;

            userLog(
              userId,
              'SUCCESS',
              `Reconciled UniV3 position ${pos.id} to tokenId=${reconciled.tokenId}`,
              `${reconciled.detail}${reconciled.matchedTxHash ? ` | tx:${reconciled.matchedTxHash.slice(0, 10)}…` : ''}`,
            );
            const patched = portfolioNow.positions.map(p =>
              p.id === pos.id
                ? { ...p, ...reconciled.positionPatch, simulated: false }
                : p,
            );
            registry.update(userId, { portfolio: { ...portfolioNow, positions: patched } });
            store.save(userId, registry.get(userId)!, true);
            portfolioNow = registry.get(userId)?.portfolio ?? portfolioNow;
            reconciledThisTick.add(pos.id);
          }
        } catch {  }
      }

      for (const pos of portfolioNow.positions) {
        if (pos.strategyType !== 'DELTA_NEUTRAL' || !pos.uniV3TokenId) continue;
        if (reconciledThisTick.has(pos.id)) continue;

        const drift = driftMap.get(pos.id);
        if (!drift) continue;

        
        const updatedPositions = portfolioNow.positions.map(p =>
          p.id === pos.id ? { ...p, uniV3LastDriftPct: drift.driftPct, uniV3OutOfRangeTicks: drift.inRange ? 0 : (p.uniV3OutOfRangeTicks ?? 0) + 1 } : p,
        );
        registry.update(userId, { portfolio: { ...portfolioNow, positions: updatedPositions } });

        if (drift.driftPct < DRIFT_TRIGGER) continue;

        userLog(userId, 'WARN',
          `UniV3 rebalance triggered: ${pos.venueName} drift ${(drift.driftPct * 100).toFixed(0)}% ≥ ${(DRIFT_TRIGGER * 100).toFixed(0)}%`,
          `tokenId:${pos.uniV3TokenId} pool:${drift.poolAddress.slice(0, 10)}… range:±${pos.uniV3RangePct ?? 10}%`,
        );

        try {
          const rangePct   = pos.uniV3RangePct ?? 10;
          const assertedAPY = BigInt(Math.round((pos.currentNetAPY ?? pos.entryAPY) * 100));
          const triggerSnapshot: ExecutionRecord['triggerSnapshot'] = {
            kind: 'univ3-drift',
            poolAddress: drift.poolAddress,
            tokenId: pos.uniV3TokenId,
            driftPct: drift.driftPct,
            currentTick: drift.currentTick,
            centerTick: drift.centerTick,
            tickLower: drift.tickLower,
            tickUpper: drift.tickUpper,
            inRange: drift.inRange,
            triggerThresholdPct: DRIFT_TRIGGER,
          };
          const rebalResult = await executor.rebalanceUniV3Position({
            tokenId:          BigInt(pos.uniV3TokenId),
            userAddress:      policy.userAddress,
            poolAddress:      drift.poolAddress,
            rangePct,
            liquidity:        drift.liquidity,
            feesPendingUSD:   pos.pendingRewardsUSD ?? 0,
            amountUSD:        pos.allocationUSD,
            assertedAPY:      Number(assertedAPY),
            tokenPrices:      onChain.getPrices(),
            userId:           policy.signedDelegation ? policy.id : undefined,
            recipientAddress: policy.signedDelegation ? policy.smartAccountAddress : undefined,
          });

          if (rebalResult.success) {
            const rebalanceRecordBase = buildExecutionRecord('REBALANCE_UNIV3' as any, pos.venueName, pos.venueName, pos.allocationUSD);
            const rebalanceRecord = buildRealExecutionRecord(rebalanceRecordBase, {
              sessionId: user.activeSessionId,
              simulated: false,
              status: 'confirmed',
              txHash: rebalResult.txHash,
              receiptHash: rebalResult.receiptHash,
              positionId: pos.id,
              replacedPositionId: pos.id,
              replacedUniV3TokenId: pos.uniV3TokenId,
              portfolioValueBefore: registry.get(userId)?.portfolio?.metrics.totalValueUSD ?? pos.allocationUSD,
              triggerSnapshot,
            });
            const reconciled = await reconcileUniV3Position({
              provider: provider as JsonRpcProvider,
              strategyId: userId,
              smartAccountAddress: policy.smartAccountAddress,
              position: pos,
              executions: journalExecutions,
              candidateTxHash: rebalResult.txHash,
              candidateTokenId: rebalResult.uniV3TokenId,
            });

            if (reconciled.status !== 'reconciled' || !reconciled.positionPatch) {
              rebalanceRecord.status = 'failed';
              rebalanceRecord.errorDetail = reconciled.detail;
              getJournal().addExecution(userId, rebalanceRecord);
              registry.update(userId, { phase: 'PAUSED' });
              store.save(userId, registry.get(userId)!, true);
              userLog(userId, 'ERROR',
                `Rebalance confirmed on-chain but reconciliation failed for ${pos.venueName}`,
                reconciled.detail,
              );
              return;
            }

            rebalanceRecord.status = 'reconciled';
            rebalanceRecord.uniV3TokenId = reconciled.tokenId;
            rebalanceRecord.portfolioValueAfter = pos.allocationUSD;

            const rangePatch = {
              ...patchFromExecutionResult(rebalResult),
              ...reconciled.positionPatch,
            };
            const rebaledPositions = registry.get(userId)!.portfolio!.positions.map(p =>
              p.id === pos.id ? {
                ...p, ...rangePatch,
                uniV3Rebalances: (p.uniV3Rebalances ?? 0) + 1,
                uniV3LastDriftPct: 0,
              } : p,
            );
            
            
            
            
            
            
            const portfolioAfterRebal = registry.get(userId)!.portfolio!;
            const metricsAfterRebal = portfolioAfterRebal.metrics ?? {};
            const resetPeak = pos.allocationUSD > 0 ? pos.allocationUSD : (metricsAfterRebal.peakValueUSD ?? 0);
            getJournal().addExecution(userId, rebalanceRecord);
            registry.update(userId, {
              portfolio: {
                ...portfolioAfterRebal,
                positions: rebaledPositions,
                metrics: { ...metricsAfterRebal, peakValueUSD: resetPeak },
              },
              
              
              _skipReportValueUntilTick: agentState.tickCount + 2,
            } as any);
            store.save(userId, registry.get(userId)!, true);

            userLog(userId, 'SUCCESS',
              `Rebalanced ${pos.venueName}: new tokenId ${reconciled.tokenId ?? rebalResult.uniV3TokenId?.toString() ?? '?'} tx:${rebalResult.txHash.slice(0, 10)}…`,
            );

            
            if (policy.userAddress && rebalResult.receiptHash) {
              const rebalDecision = {
                action:             'REBALANCE' as const,
                targetOpportunity:  opportunities.find(o => o.id === pos.venueId) ?? opportunities[0] ?? null,
                currentOpportunity: opportunities.find(o => o.id === pos.venueId) ?? null,
                reason:             `Price drift ${((drift?.driftPct ?? 0) * 100).toFixed(0)}% ≥ ${(DRIFT_TRIGGER * 100).toFixed(0)}% threshold`,
                upliftPct:          0,
              };
              proofService.submit({
                userId,
                userAddress:    policy.userAddress,
                receiptHash:    rebalResult.receiptHash,
                arbitrumTxHash: rebalResult.txHash,
                action:         'REBALANCE',
                timestamp:      Date.now(),
                poolAddress:    pos.venueAddress,
                amountUSD:      pos.allocationUSD,
                screenerTop5:   opportunities.slice(0, 5),
                teeDecision:    rebalDecision,
              });
            }
          }
        } catch (err: any) {
          
          if (err.message?.includes('0xe12b3530') || err.message?.includes('UserPausedByDrawdown')) {
            userLog(userId, 'WARN',
              'User paused on-chain by vault drawdown protection — agent suspended until operator calls resumeUser()',
            );
            registry.setPhase(userId, 'PAUSED');
            pushState();
            return;
          }
          
          if (err.message?.includes('All vault balances are 0 after close')) {
            userLog(userId, 'WARN', `Position ${pos.venueName} is empty after close — removing from portfolio`);
            const portfolioNow2 = registry.get(userId)?.portfolio;
            if (portfolioNow2) {
              const remainingPositions = portfolioNow2.positions.filter(p => p.id !== pos.id);
              registry.update(userId, {
                portfolio: remainingPositions.length > 0
                  ? { ...portfolioNow2, positions: remainingPositions }
                  : undefined,
                phase: remainingPositions.length === 0 ? 'IDLE' : undefined,
              } as any);
              store.save(userId, registry.get(userId)!);
            }
            continue;
          }
          userLog(userId, 'ERROR', `Rebalance failed for ${pos.venueName}: ${err.message}`);
        }
      }
    }
  }

  
  const latestUser = registry.get(userId)!;

  
  const inRebalanceTransitionNow = latestUser.portfolio?.positions.some(p => {
    if (p.strategyType !== 'DELTA_NEUTRAL' || !p.id) return false;
    const drift = driftMap.get(p.id);
    return drift !== undefined && drift.liquidity === 0n;
  }) ?? false;

  
  
  
  let breakers: CircuitBreaker[] = checkCircuitBreakers(latestUser.portfolio, opportunities, policy);
  if (inRebalanceTransitionNow) {
    breakers = breakers.map(b =>
      b.id === 'portfolio-drawdown' ? { ...b, status: 'GREEN' as const, value: '0% (rebalance in progress)' } : b,
    );
  }
  
  
  if (ocSnapshot.pricesHealthy === false) {
    const stalePriceBreaker: CircuitBreaker = {
      id:          'stale-prices',
      name:        'Chainlink Price Feed',
      status:      'YELLOW',
      value:       'STALE',
      threshold:   'fresh',
      description: 'Chainlink price feeds are stale — NAV and IL readings may be inaccurate. No action taken.',
    };
    breakers = [...breakers.filter(b => b.id !== 'stale-prices'), stalePriceBreaker];
  }
  registry.update(userId, { breakers });
  broadcastToUser(userId, { type: 'BREAKERS', ts: Date.now(), payload: { userId, breakers } });

  const redFlag = hasRedBreaker(breakers);
  if (redFlag) userLog(userId, 'WARN', `⚠ Circuit breaker RED — ${breakers.find(b => b.status === 'RED')?.name}`);

  
  const freshUser = registry.get(userId)!;
  if (policy.isReal) {
    console.log(`[Tick:${userId}] phase=${freshUser.phase} positions=${freshUser.portfolio?.positions?.length ?? 0} redFlag=${redFlag}`);
    if (freshUser.portfolio?.positions?.length) {
      const p = freshUser.portfolio.positions[0];
      console.log(`[Tick:${userId}] position: tokenId=${p.uniV3TokenId} strategy=${p.strategyType} currentUSD=${p.currentUSD?.toFixed(4)}`);
    }
  }
  const decisionOpportunities = policy.isReal
    ? filterLiveExecutableOpportunities(opportunities, userId)
    : opportunities;
  const decision = decideAllocation(decisionOpportunities, policy, freshUser.portfolio, redFlag);
  if (policy.forceMigrateTargetId && decision.action === 'MIGRATE') {
    registry.update(userId, { policy: { ...policy, forceMigrateTargetId: undefined } });
  }
  broadcastToUser(userId, { type: 'ALLOCATION', ts: Date.now(), payload: { userId, decision } });

  userLog(userId, decision.action === 'HOLD' ? 'INFO' : 'WARN',
    `Decision: ${decision.action}`, decision.reason,
  );

  
  if (decision.action !== 'HOLD' && decision.action !== 'HARVEST') {
    const target = decision.targetOpportunity;
    if (!target) {
      userLog(userId, 'WARN', 'No target opportunity — holding');
    } else {
      registry.setPhase(userId, 'MIGRATING');
      const safety = runSafetyGate(target, policy);
      broadcastToUser(userId, { type: 'SAFETY', ts: Date.now(), payload: { userId, safety } });

      
      
      const isSafeHaven = decision.reason?.includes('safe haven');
      const safetyPassed = isSafeHaven
        ? safety.checks.every(c => c.name !== 'Net APY floor' ? c.passed : true)  
        : safety.passed;

      if (!safetyPassed) {
        userLog(userId, 'WARN', `Safety gate FAILED — ${safety.abortReason}`);
        registry.setPhase(userId, freshUser.portfolio ? 'MONITORING' : 'IDLE');
      } else {
        userLog(userId, 'SUCCESS', isSafeHaven ? 'Aave safe haven — executing (APY floor bypassed, TVL check still required)' : 'Safety gate PASSED — executing');

        const prevUser   = registry.get(userId)!;
        const prevPortVal = prevUser.portfolio?.metrics.totalValueUSD ?? 0;
        const fromDesc   = prevUser.portfolio
          ? prevUser.portfolio.positions.map(p => p.venueName).join(' + ')
          : null;

        const record = buildExecutionRecord(decision.action, fromDesc, `${target.protocol} ${target.pool}`, policy.managedUSD, prevPortVal);
        record.sessionId = prevUser.activeSessionId;

        
        
        
        let onChainPositionPatch: Partial<import('./types').PortfolioPosition> = {};
        let realExecutionSucceeded = !policy.isReal;

        if (policy.isReal && policy.userAddress) {
          const executor = getExecutor();
          if (executor) {
            try {
              const currentPrice    = onChain.getPrices().get('WETH')?.priceUSD;
              const portfolioValueUSD = currentUser.portfolio?.metrics.totalValueUSD ?? policy.managedUSD;
              const toInput = buildLiveExecutionInput(target, policy, currentPrice, portfolioValueUSD);
              
              if (target.lvrOptimalRangePct) toInput.rangePct = target.lvrOptimalRangePct;

              
              
              
              
              if (decision.action === 'GENESIS' && target.strategyType === 'DELTA_NEUTRAL' && policy.managedUSD >= 5_000) {
                const hasSecondPool = decisionOpportunities.some(
                  o => o.strategyType === 'DELTA_NEUTRAL' && o.address !== target.address,
                );
                if (hasSecondPool) {
                  const firstAllocationUSD = policy.managedUSD * 0.60;
                  toInput.amount    = BigInt(Math.round(firstAllocationUSD * 1e6));
                  toInput.amountUSD = firstAllocationUSD;
                }
              }

              
              
              const fromPos = (() => {
                const positions = prevUser.portfolio?.positions ?? [];
                if (decision.action === 'MIGRATE') {
                  
                  
                  const currentOppId = decision.currentOpportunity?.id;
                  const byVenueId = currentOppId ? positions.find(p => p.venueId === currentOppId) : undefined;
                  if (byVenueId) return byVenueId;
                  const byStrategy = positions.find(p => p.strategyType === target.strategyType);
                  if (byStrategy) return byStrategy;
                }
                
                return positions.length > 0
                  ? [...positions].sort((a, b) => b.allocationUSD - a.allocationUSD)[0]
                  : undefined;
              })();
              let exitAmountRaw = BigInt(Math.round(policy.managedUSD * 1e6));
              let exitAmountUSD = policy.managedUSD;
              if ((decision.action === 'MIGRATE' || decision.action === 'SAFETY_EXIT') && fromPos) {
                
                
                
                if (policy.smartAccountAddress) {
                  
                  
                  
                  
                  const knownValueUSD = fromPos?.currentUSD > 0
                    ? fromPos.currentUSD
                    : (policy.managedUSD ?? 1);
                  exitAmountUSD = knownValueUSD;
                  exitAmountRaw = BigInt(Math.round(knownValueUSD * 1e6));
                  toInput.amount    = exitAmountRaw;
                  toInput.amountUSD = exitAmountUSD;
                } else {
                  const deployedRaw = await executor.deployedBalance(policy.userAddress, TOKEN_ADDRESSES.USDC);
                  if (deployedRaw > 0n) {
                    exitAmountRaw = deployedRaw;
                    exitAmountUSD = Number(deployedRaw) / 1e6;
                    toInput.amount    = deployedRaw;
                    toInput.amountUSD = exitAmountUSD;
                  }
                }
              }
              
              
              
              
              const liveDrift = fromPos?.id ? driftMap.get(fromPos.id) : undefined;
              const liveLiquidity = liveDrift ? liveDrift.liquidity
                : (fromPos?.uniV3Liquidity ? BigInt(fromPos.uniV3Liquidity) : undefined);

              if (policy.isReal) {
                console.log(`[Execute:${userId}] action=${decision.action} fromPos=${fromPos?.uniV3TokenId ?? 'none'} liveLiquidity=${liveLiquidity?.toString() ?? 'none'}`);
                console.log(`[Execute:${userId}] will migrate=${!!((decision.action === 'MIGRATE' || decision.action === 'SAFETY_EXIT') && prevUser.portfolio && fromPos)}`);
              }
              
              
              
              
              if (decision.action === 'GENESIS') {
                const rawBalance = policy.smartAccountAddress
                  ? await executor.smartAccountBalance(policy.smartAccountAddress, TOKEN_ADDRESSES.USDC)
                  : await executor.idleBalance(policy.userAddress, TOKEN_ADDRESSES.USDC);

                
                const reservedByOtherIdle = policy.smartAccountAddress
                  ? registry.all()
                      .filter(u =>
                        u.userId !== userId &&
                        u.policy.smartAccountAddress === policy.smartAccountAddress &&
                        u.phase === 'IDLE'
                      )
                      .reduce((sum, u) => sum + u.policy.managedUSD, 0)
                  : 0;

                const reservedRaw        = BigInt(Math.round(reservedByOtherIdle * 1e6));
                const effectiveBalance   = rawBalance > reservedRaw ? rawBalance - reservedRaw : 0n;

                if (effectiveBalance < toInput.amount) {
                  userLog(userId, 'ERROR',
                    `GENESIS skipped — ` +
                    `${policy.smartAccountAddress ? 'smart account' : 'vault'} has ` +
                    `$${(Number(rawBalance) / 1e6).toFixed(2)} USDC, ` +
                    `$${reservedByOtherIdle.toFixed(2)} reserved by other strategies, ` +
                    `$${(Number(effectiveBalance) / 1e6).toFixed(2)} unallocated < ` +
                    `$${(Number(toInput.amount) / 1e6).toFixed(2)} needed.`,
                  );
                  registry.setPhase(userId, 'IDLE');
                  pushState();
                  return;
                }
              }

              const result = ((decision.action === 'MIGRATE' || decision.action === 'SAFETY_EXIT') && prevUser.portfolio && fromPos)
                ? await executor.migrate(
                    {
                      strategyType:     fromPos.strategyType,
                      asset:            TOKEN_ADDRESSES.USDC,
                      amount:           exitAmountRaw,
                      amountUSD:        exitAmountUSD,
                      userAddress:      policy.userAddress,
                      marketAddress:    fromPos.venueAddress ?? fromPos.venueId,
                      tokenId:          fromPos.uniV3TokenId ? BigInt(fromPos.uniV3TokenId) : undefined,
                      liquidity:        liveLiquidity,
                      hedgeSizeUSD:     fromPos.hedgeSizeUSD,
                      maturityDate:     fromPos.maturityDate,
                      ytAddress:        fromPos.ytAddress,
                      
                      userId:           policy.signedDelegation ? policy.id : undefined,
                      recipientAddress: policy.signedDelegation ? policy.smartAccountAddress : undefined,
                      portfolioValueUSD: exitAmountUSD,
                    },
                    toInput,
                  )
                : await executor.deposit(toInput);

              record.receiptHash = result.receiptHash;
              record.txHash      = result.txHash;
              record.simulated   = false;
              realExecutionSucceeded = true;

              
              onChainPositionPatch = patchFromExecutionResult(result);

              userLog(userId, 'SUCCESS', `On-chain tx confirmed: ${result.txHash.slice(0, 10)}…`, `Gas: ${result.gasUsed}`);

              
              if (policy.userAddress && result.receiptHash) {
                proofService.submit({
                  userId,
                  userAddress:    policy.userAddress,
                  receiptHash:    result.receiptHash,
                  arbitrumTxHash: result.txHash,
                  action:         decision.action as 'GENESIS' | 'MIGRATE' | 'REBALANCE',
                  timestamp:      Date.now(),
                  poolAddress:    toInput.marketAddress,
                  amountUSD:      toInput.amountUSD,
                  screenerTop5:   decisionOpportunities.slice(0, 5),
                  teeDecision:    decision,
                });
              }
              
              
            } catch (err: any) {
              
              if (err.message?.includes('0xe12b3530') || err.message?.includes('UserPausedByDrawdown')) {
                userLog(userId, 'WARN',
                  'User paused on-chain by vault drawdown protection — agent suspended until operator calls resumeUser()',
                );
                registry.setPhase(userId, 'PAUSED');
                pushState();
                return;
              }
              userLog(userId, 'ERROR', `On-chain execution failed — real portfolio not opened: ${err.message}`);
            }
          } else {
            userLog(userId, 'ERROR', 'On-chain execution disabled — AGENT_PRIVATE_KEY and VAULT_ADDRESS are required for real users');
          }
        }
        

        if (policy.isReal && !realExecutionSucceeded) {
          registry.setPhase(userId, prevUser.portfolio ? 'MONITORING' : 'IDLE');
          pushState();
          return;
        }

        let newPortfolio: Portfolio | null = null;

        if (decision.action === 'GENESIS') {
          
          
          
          let realAllocations: { opportunity: typeof target; allocationPct: number; allocationUSD: number }[] = [];

          if (policy.isReal && target.strategyType === 'DELTA_NEUTRAL' && policy.managedUSD >= 5_000) {
            const dnOpps = decisionOpportunities
              .filter(o => o.strategyType === 'DELTA_NEUTRAL' && o.address !== target.address)
              .slice(0, 1);

            if (dnOpps.length > 0) {
              
              realAllocations = [
                { opportunity: target,    allocationPct: 60, allocationUSD: policy.managedUSD * 0.60 },
                { opportunity: dnOpps[0], allocationPct: 40, allocationUSD: policy.managedUSD * 0.40 },
              ];
            }
          }

          if (realAllocations.length === 0) {
            realAllocations = [{ opportunity: target, allocationPct: 100, allocationUSD: policy.managedUSD }];
          }

          const validOpps = policy.isReal
            ? realAllocations.map(a => a.opportunity)
            : opportunities.filter(o => o.netAPY >= policy.minAPY * 0.8);
          const plan = policy.isReal
            ? { allocations: realAllocations, totalPct: 100, warnings: [] }
            : planAllocation(validOpps, policy);
          newPortfolio = openPortfolio(plan, policy);

          
          
          if (policy.isReal && policy.userAddress && realAllocations.length > 1) {
            const executor2 = getExecutor();
            for (let ai = 1; ai < realAllocations.length; ai++) {
              const alloc = realAllocations[ai];
              if (!executor2) break;
              try {
                const addInput = buildLiveExecutionInput(
                  alloc.opportunity,
                  { ...policy, managedUSD: alloc.allocationUSD },
                  onChain.getPrices().get('WETH')?.priceUSD,
                );
                addInput.rangePct = alloc.opportunity.lvrOptimalRangePct;
                const addResult = await executor2.deposit(addInput);
                if (addResult.success && newPortfolio) {
                  
                  const addPatch = patchFromExecutionResult(addResult);
                  newPortfolio = {
                    ...newPortfolio,
                    positions: newPortfolio.positions.map((p, pi) =>
                      pi === ai ? { ...p, ...addPatch } : p,
                    ),
                  };
                  userLog(userId, 'SUCCESS',
                    `Position ${ai + 1} opened: ${alloc.opportunity.pool} tx:${addResult.txHash.slice(0, 10)}…`,
                  );
                }
              } catch (err: any) {
                userLog(userId, 'WARN', `Position ${ai + 1} open failed (continuing with ${ai} position(s)): ${err.message}`);
              }
            }
          }

          
          newPortfolio.positions = newPortfolio.positions.map(pos => {
            const opp = opportunities.find(o => o.id === pos.venueId);
            const sym = pos.venueName.toUpperCase();
            let entryPriceUSD = 0;
            for (const [priceSym, tp] of prices.entries()) {
              if (sym.includes(priceSym.toUpperCase()) && priceSym !== 'USDC' && priceSym !== 'USDT') {
                entryPriceUSD = tp.priceUSD;
                break;
              }
            }
            return {
              ...pos,
              entryPriceUSD,
              maturityDate: opp?.maturityDate,  
              ytAddress:    opp?.ytAddress,      
              ptAddress:    opp?.ptAddress,      
            };
          });

          userLog(userId, 'SUCCESS',
            `Portfolio opened: ${newPortfolio.positions.length} positions`,
            newPortfolio.positions.map(p => `${p.strategyType} ${p.allocationPct.toFixed(0)}%`).join(' · '),
          );

        } else if (decision.action === 'MIGRATE' && prevUser.portfolio) {
          
          const positions = [...prevUser.portfolio.positions];
          const toMigrate = positions.find(p => p.strategyType === target.strategyType)
            ?? positions.sort((a, b) => a.geckoScore - b.geckoScore)[0];

          if (toMigrate) {
            const idx     = positions.indexOf(toMigrate);
            const newPos: PortfolioPosition = {
              ...toMigrate,
              id:              crypto.randomUUID(),
              venueId:         target.id,
              venueAddress:    target.address,
              venueName:       `${target.protocol} ${target.pool}`,
              protocol:        target.protocol,
              strategyType:    target.strategyType,
              asset:           target.asset,
              entryAPY:        target.grossAPY,
              entryUSD:        toMigrate.currentUSD,
              entryTime:       Date.now(),
              currentAPY:      target.grossAPY,
              currentNetAPY:   target.netAPY,
              geckoScore:      target.geckoScore,
              ilPct:           0, ilUSD: 0, ilCategory: 'none',
              feesEarnedUSD:   0, netAfterILUSD: 0, isILProfitable: true, ilUnprofTicks: 0,
              lastHarvestAt:   Date.now(), pendingRewardsUSD: 0,
            };
            positions[idx] = newPos;
            newPortfolio   = { ...prevUser.portfolio, positions };
          }

        } else if (decision.action === 'SAFETY_EXIT' && prevUser.portfolio) {
          
          const safeHaven  = target;
          const totalValue = prevUser.portfolio.metrics.totalValueUSD;
          const safePos: PortfolioPosition = {
            id: crypto.randomUUID(), venueId: safeHaven.id,
            venueAddress: safeHaven.address,
            venueName: `${safeHaven.protocol} ${safeHaven.pool}`,
            protocol: safeHaven.protocol, strategyType: safeHaven.strategyType,
            asset: safeHaven.asset,
            allocationPct: 100, allocationUSD: totalValue, geckoScore: safeHaven.geckoScore,
            entryAPY: safeHaven.grossAPY, entryUSD: totalValue, entryTime: Date.now(), entryPriceUSD: 0,
            currentAPY: safeHaven.grossAPY, currentNetAPY: safeHaven.netAPY,
            currentUSD: totalValue, incomeEarnedUSD: 0, totalReturnUSD: 0, totalReturnPct: 0,
            effectiveAPY: safeHaven.netAPY, ilPct: 0, ilUSD: 0, ilCategory: 'none',
            feesEarnedUSD: 0, netAfterILUSD: 0, isILProfitable: true, ilUnprofTicks: 0,
            pendingRewardsUSD: 0, lastHarvestAt: Date.now(),
            peakUSD: totalValue, drawdownPct: 0, daysHeld: 0, simulated: true,
          };
          newPortfolio = {
            positions: [safePos],
            metrics: prevUser.portfolio.metrics,
            lastRebalanceAt: Date.now(),
            updatedAt: Date.now(),
          };
        }

        if (newPortfolio) {
          
          
          if (Object.keys(onChainPositionPatch).length > 0 && newPortfolio.positions.length > 0) {
            const lastIdx = newPortfolio.positions.length - 1;
            newPortfolio  = {
              ...newPortfolio,
              positions: newPortfolio.positions.map((p, i) =>
                i === lastIdx ? { ...p, ...onChainPositionPatch } : p,
              ),
            };
          }

          getJournal().addExecution(userId, record);
          registry.update(userId, {
            portfolio:  newPortfolio,
            phase:      'ALLOCATED',
          });

          broadcastToUser(userId, { type: 'EXECUTION', ts: Date.now(), payload: { userId, record } });
          broadcastToUser(userId, { type: 'PORTFOLIO', ts: Date.now(), payload: { userId, portfolio: newPortfolio } });
        }
      }
    }

  } else if (decision.action === 'HARVEST' && freshUser.portfolio) {
    const harvests = evaluatePortfolioHarvests(freshUser.portfolio.positions);
    if (harvests.length > 0) {
      const h = harvests[0];

      
      
      
      userLog(userId, 'SUCCESS', `HARVEST: ${h.reason}`);
      const record = buildExecutionRecord('HARVEST', freshUser.portfolio.positions[0]?.venueName ?? null, 'compound', h.pendingRewardsUSD);
      record.sessionId = freshUser.activeSessionId;

      
      
      if (policy.isReal && policy.userAddress) {
        const executor = getExecutor();
        if (executor) {
          
          const dnPos = freshUser.portfolio.positions.find(
            p => p.strategyType === 'DELTA_NEUTRAL' && p.uniV3TokenId,
          );
          if (dnPos?.uniV3TokenId) {
            try {
              const ethPrice = onChain.getPrices().get('WETH')?.priceUSD ?? 3000;
              const result = await executor.collectUniV3Fees(
                BigInt(dnPos.uniV3TokenId), policy.userAddress, h.pendingRewardsUSD, ethPrice,
                policy.signedDelegation ? policy.id : undefined,
                policy.signedDelegation ? policy.smartAccountAddress : undefined,
                policy.signedDelegation ? (freshUser.portfolio?.metrics.totalValueUSD ?? policy.managedUSD) : undefined,
                policy.signedDelegation ? policy.maxFeeBps : undefined,
              );
              record.txHash      = result.txHash;
              record.receiptHash = result.receiptHash;
              record.simulated   = false;
              userLog(userId, 'SUCCESS', `UniV3 fees collected: ${result.txHash.slice(0, 10)}…`);
            } catch (err: any) {
              userLog(userId, 'WARN', `UniV3 collect failed — staying simulated: ${err.message}`);
            }
          }

          
          
          
          const lendingPos = freshUser.portfolio.positions.find(
            p => p.strategyType === 'AAVE_LENDING' || p.strategyType === 'MORPHO_LENDING',
          );
          if (lendingPos && h.pendingRewardsUSD > 0.01 && process.env.TREASURY_ADDRESS) {
            try {
              const result = await executor.collectLendingFee({
                strategyType:  lendingPos.strategyType as 'AAVE_LENDING' | 'MORPHO_LENDING',
                userAddress:   policy.userAddress,
                marketAddress: lendingPos.venueAddress ?? lendingPos.venueId,
                yieldUSD:      h.pendingRewardsUSD,
                maxFeeBps:     policy.maxFeeBps,
                treasury:      process.env.TREASURY_ADDRESS,
                asset:         TOKEN_ADDRESSES.USDC,
                assetDecimals: 6,
              });
              if (result) {
                record.txHash      = result.txHash;
                record.receiptHash = result.receiptHash;
                record.simulated   = false;
                userLog(userId, 'SUCCESS', `Lending fee collected: ${result.txHash.slice(0, 10)}…`);
              }
            } catch (err: any) {
              userLog(userId, 'WARN', `Lending fee collect failed — staying simulated: ${err.message}`);
            }
          }
        }
      }

      getJournal().addExecution(userId, record);

      broadcastToUser(userId, { type: 'HARVEST', ts: Date.now(), payload: { userId, harvest: h } });
    }
  } else {
    registry.setPhase(userId, freshUser.portfolio ? 'MONITORING' : 'IDLE');
  }

  
  const finalUser = registry.get(userId)!;
  store.save(userId, finalUser);
}

async function refreshUniverse(ocSnapshot: any): Promise<void> {
  try {
    const result = await fetchUniverse(provider, 'aggressive', ocSnapshot);
    if (result.opportunities.length > 0) {
      agentState.opportunities = result.opportunities;
      const verified = result.opportunities.filter(o => o.verifiedOnChain).length;
      broadcast({ type: 'OPPORTUNITIES', ts: Date.now(), payload: { opportunities: result.opportunities, count: result.opportunities.length } });
      globalLog('INFO',
        `Universe refresh: ${result.opportunities.length} opps (${verified} on-chain verified)`,
        `Top: ${result.opportunities[0]?.protocol} ${result.opportunities[0]?.pool} — GeckoScore ${result.opportunities[0]?.geckoScore?.toFixed(1)} @ ${result.opportunities[0]?.netAPY?.toFixed(2)}% net`,
      );
    }
  } catch (err: any) {
    globalLog('WARN', 'Universe refresh failed — using cached snapshot', err.message);
  }
}

let lastTickTime = Date.now();

async function tick(): Promise<void> {
  const tickStart = Date.now();
  const elapsed   = (tickStart - lastTickTime) / 1_000;
  lastTickTime    = tickStart;

  agentState.tickCount++;
  agentState.lastTickAt = tickStart;
  agentState.nextTickAt = tickStart + TICK_MS;

  broadcast({ type: 'TICK_START', ts: tickStart, payload: { tick: agentState.tickCount, block: agentState.block } });
  globalLog('INFO', `Tick #${agentState.tickCount} — ${registry.size()} user(s)`);

  
  let ocSnapshot: any = {};
  try {
    ocSnapshot = await onChain.fetchSnapshot();
    globalLog('INFO',
      `On-chain: ${ocSnapshot.prices.size} prices · ${ocSnapshot.aaveMarkets.length} Aave · ${ocSnapshot.gmxMarkets.length} GMX`,
      `Chainlink: ${ocSnapshot.pricesHealthy ? 'fresh' : 'STALE'} · ${ocSnapshot.fetchDurationMs}ms`,
    );
    
    
    if (!ocSnapshot.pricesHealthy) {
      globalLog('WARN',
        'Chainlink prices STALE — on-chain price feeds may be delayed. NAV and IL readings may be inaccurate. No action taken.',
      );
    }
  } catch (err: any) {
    globalLog('WARN', 'On-chain snapshot failed — using last known state', err.message);
  }

  
  
  const allUserStates = registry.all().map(u => registry.get(u.userId)!);
  const driftResults  = await assessAllDrifts(provider, allUserStates).catch((err: Error) => {
    globalLog('WARN', `Drift assessment failed: ${err.message}`);
    return [] as DriftResult[];
  });
  const driftMap = new Map<string, DriftResult>(driftResults.map(d => [d.positionId, d]));
  if (driftResults.length > 0) {
    const drifting = driftResults.filter(d => d.driftPct >= DRIFT_TRIGGER).length;
    globalLog('INFO',
      `Drift monitor: ${driftResults.length} positions assessed, ${drifting} triggering rebalance`,
    );
  }

  
  
  const batchMap = await onChain.fetchBatchPositions(allUserStates, ocSnapshot, driftMap).catch(err => {
    globalLog('WARN', `Batch position fetch failed: ${err.message}`);
    return new Map<string, import('./protocols').UserOnChainPositions>();
  });

  
  
  const saGroups = new Map<string, UserState[]>();
  for (const user of registry.all()) {
    if (!isMyUser(user.userId)) continue;
    const key = user.policy.smartAccountAddress ?? `__v1__${user.userId}`;
    if (!saGroups.has(key)) saGroups.set(key, []);
    saGroups.get(key)!.push(registry.get(user.userId)!);
  }

  const runUser = async (user: UserState) => {
    const u = registry.get(user.userId)!;
    if (u.tickErrors >= MAX_ERRORS) {
      userLog(user.userId, 'WARN', `Quarantined after ${u.tickErrors} consecutive errors — skipping`);
      return;
    }
      const userBatch = batchMap.get(user.policy.smartAccountAddress || user.userAddress) || null;
      const result = await withTimeout(tickUser(user, elapsed, ocSnapshot, driftMap, userBatch), TICK_TIMEOUT);
    if (result === null) {
      const errs = registry.incrementErrors(user.userId);
      userLog(user.userId, 'ERROR', `Tick timeout after ${TICK_TIMEOUT / 1_000}s (${errs}/${MAX_ERRORS})`);
    } else {
      registry.resetErrors(user.userId);
    }
  };

  
  
  
  const tickQueue = new PQueue({ concurrency: TICK_CONCURRENCY });
  await Promise.allSettled(
    Array.from(saGroups.values()).map(group =>
      tickQueue.add(async () => { for (const user of group) await runUser(user); })
    )
  );

  
  pushState();

  const durMs = Date.now() - tickStart;
  const pending = store?.pendingUploads ?? 0;
  broadcast({
    type: 'TICK_END', ts: Date.now(),
    payload: {
      tick: agentState.tickCount, durationMs: durMs,
      users: registry.all().map(u => {
        const s = registry.get(u.userId)!;
        return {
          userId: u.userId, displayName: s.policy.displayName, phase: s.phase,
          weightedAPY:  s.portfolio?.metrics.weightedNetAPY ?? null,
          totalReturn:  s.portfolio?.metrics.totalReturnPct ?? null,
          positionCount: s.portfolio?.positions.length ?? 0,
        };
      }),
    },
  });

  globalLog('INFO',
    `Tick #${agentState.tickCount} done in ${durMs}ms — next in ${TICK_MS / 1_000}s`,
    pending > 0 ? `0G uploads queued: ${pending}` : undefined,
  );
}

async function main(): Promise<void> {
  console.log([
    '',
    '╔══════════════════════════════════════════════════════════════╗',
    '║  YIELDGEKO AGENT ORCHESTRATOR  v3.0                         ║',
    '║  GeckoScore · Portfolio · IL Engine · Compounder            ║',
    '║  Pendle · Morpho · GMX · Delta-neutral · Aave               ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
    `  RPC:      ${RPC_URL}`,
    `  Tick:     every ${TICK_MS / 1_000}s  (timeout: ${TICK_TIMEOUT / 1_000}s)`,
    `  Mode:     ${process.env.AGENT_ENVIRONMENT === 'production' ? 'PRODUCTION (real users only)' : `dev (${DEMO_POLICIES.length} demo users)`}`,
    '',
  ].join('\n'));

  startSSEServer();

  provider = new JsonRpcProvider(RPC_URL, 42161, { staticNetwork: true, batchMaxCount: 50 });
  onChain  = new OnChainProvider(provider);
  store    = new PersistenceStore();
  registry = new UserRegistry();

  setIsIdTakenCallback((id) => !!registry.get(id));

  
  
  setRegisterCallback(async (policy) => {
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    if (policy.smartAccountAddress && policy.managedUSD > 0) {
      const exec = getExecutor();
      if (exec) {
        const [usdcRaw] = await Promise.all([
          exec.smartAccountBalance(policy.smartAccountAddress, TOKEN_ADDRESSES.USDC),
        ]);
        const usdcAvailable = Number(usdcRaw) / 1e6;

        
        
        const reservedByIdleStrategies = registry.all()
          .filter(u =>
            u.policy.smartAccountAddress === policy.smartAccountAddress &&
            u.phase === 'IDLE'
          )
          .reduce((sum, u) => sum + u.policy.managedUSD, 0);

        const unallocated = usdcAvailable - reservedByIdleStrategies;

        if (unallocated < policy.managedUSD) {
          throw new Error(
            `Insufficient unallocated capital. ` +
            `Smart account has $${usdcAvailable.toFixed(2)} USDC — ` +
            `$${reservedByIdleStrategies.toFixed(2)} reserved by ${
              registry.all().filter(u =>
                u.policy.smartAccountAddress === policy.smartAccountAddress &&
                u.phase === 'IDLE'
              ).length
            } pending strategy(s) — ` +
            `$${unallocated.toFixed(2)} unallocated. ` +
            `Need $${policy.managedUSD.toFixed(2)}. ` +
            `Deposit more USDC to your smart account or reduce the strategy amount.`
          );
        }

        globalLog('INFO',
          `Capital check passed for ${policy.displayName}: ` +
          `$${usdcAvailable.toFixed(2)} available, ` +
          `$${reservedByIdleStrategies.toFixed(2)} reserved, ` +
          `$${unallocated.toFixed(2)} unallocated ≥ $${policy.managedUSD.toFixed(2)} needed`
        );
      }
    }

    let state: ReturnType<typeof registry.registerReal>;

    
    if (policy.signedDelegation && policy.smartAccountAddress) {
      state = registry.registerV2(policy, policy.smartAccountAddress, policy.signedDelegation);
      
      const exec = getExecutor();
      if (exec) {
        exec.setUserDelegation(policy.id, policy.signedDelegation);
        globalLog('SUCCESS',
          `V2 user registered: ${policy.displayName} | smartAccount: ${policy.smartAccountAddress}`);
      }

      
      
      
      const delegationSig = policy.signedDelegation.signature;
      const registrationHash = '0x' + crypto
        .createHash('sha256')
        .update(`REGISTER:${policy.userAddress}:${policy.smartAccountAddress}:${delegationSig.slice(0, 32)}`)
        .digest('hex');
      
      
      
      
      setTimeout(() => {
        anchorExecutionProof({
          receiptHash: registrationHash,
          userAddress: policy.userAddress!,
          strategyId: strategyScopeHash(policy.id),
          action:      'REGISTER',
          traceCID:    '',   
          attestCID:   '',
        }).then(anchor => {
          if (anchor) {
            console.log(`[0GChain] ✅ Registration anchored for ${policy.displayName} → ${anchor.explorerUrl}`);
          }
        }).catch((e: any) => {
          console.warn('[0G] Registration anchor failed (non-fatal):', e.message?.slice(0, 80));
        });
      }, 8_000); 
    } else {
      state = registry.registerReal(policy, policy.userAddress || '0x0000000000000000000000000000000000000000');

      globalLog('SUCCESS', `Real user registered: ${policy.displayName} (${policy.userAddress})`);
    }

    store.registerActiveUser(policy.id);
    store.save(policy.id, state);
    pushState();
    return state;
  });

  
  
  setResetCallback(async (userId: string) => {
    const existing = registry.get(userId);
    if (!existing) return false;
    
    
    
    const tombstone = { ...existing, phase: 'WITHDRAWN' as const, portfolio: null, breakers: [] };
    store.save(userId, tombstone);   
    store.markUserArchived(userId);
    registry.deregister(userId);
    globalLog('WARN', `User ${userId} deregistered — WITHDRAWN written to disk (0G syncs in background)`);
    pushState();
    
    store.drain().catch((e: any) => console.warn('[Reset] 0G drain failed:', e.message));
    return true;
  });

  setWithdrawCallback(async (input) => {
    const user = requireUniqueStrategyTarget(input);
    if (!user.policy.isReal || !user.policy.userAddress) {
      throw new Error('Withdrawal is only available for real registered users');
    }
    if (user.phase === 'WITHDRAWING') {
      throw new Error('Withdrawal already in progress for this user');
    }
    if (!user.portfolio || user.portfolio.positions.length === 0) {
      const executor = getExecutor();
      const idleUSDC = executor
        ? await executor.idleBalance(user.policy.userAddress, TOKEN_ADDRESSES.USDC)
        : 0n;
      return {
        userId:      user.userId,
        status:      'IDLE_ONLY',
        message:     'No active portfolio to unwind. User may withdraw idle USDC from the vault.',
        idleUSDCRaw: idleUSDC.toString(),
        idleUSDC:    Number(idleUSDC) / 1e6,
      };
    }

    const executor = getExecutor();
    if (!executor) throw new Error('Agent executor not ready — check VAULT_ADDRESS and AGENT_PRIVATE_KEY');

    
    const snapshotPortfolio = user.portfolio;
    registry.update(user.userId, { phase: 'WITHDRAWING' });
    userLog(user.userId, 'WARN', 'Withdrawal requested — unwinding active portfolio');
    pushState();

    const pushWithdrawal = (evt: WithdrawalEvent) =>
      broadcastToUser(user.userId, { type: 'WITHDRAWAL', ts: Date.now(), payload: evt });

    
    ;(async () => {
      const txs: Array<{ positionId: string; closeTxHash: string; normalizeTxHash?: string }> = [];
      try {
        
        const PRE_WITHDRAW_HARVEST_MIN_USD = 2.0;
        for (const pos of snapshotPortfolio.positions) {
          const shouldHarvest = pos.strategyType === 'DELTA_NEUTRAL'
            && pos.uniV3TokenId
            && pos.pendingRewardsUSD >= (user.policy.signedDelegation ? PRE_WITHDRAW_HARVEST_MIN_USD : 0.01);
          if (shouldHarvest) {
            pushWithdrawal({ phase: 'COLLECTING_FEES', userId: user.userId, message: `Collecting $${pos.pendingRewardsUSD.toFixed(2)} in accrued fees` });
            try {
              const ethPrice = onChain.getPrices().get('WETH')?.priceUSD ?? 3000;
              await executor.collectUniV3Fees(
                BigInt(pos.uniV3TokenId!),
                user.policy.userAddress!,
                pos.pendingRewardsUSD,
                ethPrice,
                user.userId,
                user.policy.smartAccountAddress,
                pos.currentUSD,
                user.policy.maxFeeBps,
              );
              userLog(user.userId, 'SUCCESS', `Pre-withdrawal fee collection: $${pos.pendingRewardsUSD.toFixed(4)} harvested`);
            } catch (err: any) {
              userLog(user.userId, 'WARN', `Pre-withdrawal harvest skipped (non-fatal): ${err.message?.slice(0, 80)}`);
            }
          }
        }

        
        pushWithdrawal({ phase: 'CLOSING_POSITION', userId: user.userId, message: 'Closing LP position and returning tokens' });

        for (const pos of snapshotPortfolio.positions) {
          if (pos.strategyType === 'DELTA_NEUTRAL' && !pos.uniV3TokenId) {
            throw new Error(`Position ${pos.id} is DELTA_NEUTRAL but missing uniV3TokenId`);
          }

          let resolvedMarket = pos.venueAddress ?? pos.uniV3EntryPool ?? pos.venueId;
          if (!resolvedMarket && pos.strategyType === 'DELTA_NEUTRAL' && pos.uniV3TokenId) {
            try {
              const { ethers: _ethers } = await import('ethers');
              const posMgr  = new _ethers.Contract('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', [
                'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
              ], provider);
              const factory = new _ethers.Contract('0x1F98431c8aD98523631AE4a59f267346ea31F984', [
                'function getPool(address,address,uint24) view returns (address)',
              ], provider);
              const nftPos = await posMgr.positions(BigInt(pos.uniV3TokenId));
              resolvedMarket = await factory.getPool(nftPos[2], nftPos[3], nftPos[4]);
              userLog(user.userId, 'INFO', `Resolved pool from NFT ${pos.uniV3TokenId}: ${resolvedMarket}`);
            } catch (lookupErr: any) {
              console.warn(`[Withdraw] Pool lookup from NFT failed: ${lookupErr.message}`);
            }
          }

          const amountRaw = BigInt(Math.max(0, Math.round((pos.currentUSD || pos.allocationUSD || user.policy.managedUSD) * 1e6)));
          const prepared = await executor.prepareWithdrawal({
            strategyType:      pos.strategyType,
            asset:             TOKEN_ADDRESSES.USDC,
            amount:            amountRaw,
            amountUSD:         pos.currentUSD || pos.allocationUSD || user.policy.managedUSD,
            userAddress:       user.policy.userAddress!,
            marketAddress:     resolvedMarket,
            tokenId:           pos.uniV3TokenId ? BigInt(pos.uniV3TokenId) : undefined,
            liquidity:         pos.uniV3Liquidity ? BigInt(pos.uniV3Liquidity) : undefined,
            hedgeSizeUSD:      pos.hedgeSizeUSD,
            maturityDate:      pos.maturityDate,
            ytAddress:         pos.ytAddress,
            userId:            user.policy.smartAccountAddress ? user.userId : undefined,
            recipientAddress:  user.policy.smartAccountAddress,
            portfolioValueUSD: pos.currentUSD || pos.allocationUSD || user.policy.managedUSD,
            managedUSD:        user.policy.managedUSD,
          });

          if (prepared.normalize) {
            pushWithdrawal({ phase: 'SWAPPING_TOKENS', userId: user.userId, message: 'Converting tokens to USDC' });
          }

          txs.push({
            positionId:      pos.id,
            closeTxHash:     prepared.close.txHash,
            normalizeTxHash: prepared.normalize?.txHash,
          });
        }

        
        const isV2User = !!(user.policy.smartAccountAddress);
        const idleUSDC = isV2User
          ? await executor.smartAccountBalance(user.policy.userAddress!, TOKEN_ADDRESSES.USDC)
          : await executor.idleBalance(user.policy.userAddress!, TOKEN_ADDRESSES.USDC);

        const record = buildExecutionRecord(
          'WITHDRAW',
          snapshotPortfolio.positions.map(p => p.venueName).join(' + '),
          isV2User ? 'Smart account USDC' : 'Vault idle USDC',
          Number(idleUSDC) / 1e6,
          snapshotPortfolio.metrics.totalValueUSD,
        );
        record.sessionId = user.activeSessionId;
        record.simulated = false;
        record.txHash    = txs.at(-1)?.normalizeTxHash ?? txs.at(-1)?.closeTxHash;

        getJournal().addExecution(user.userId, record);
        registry.update(user.userId, { phase: 'WITHDRAWN', portfolio: null, breakers: [] });
        userLog(
          user.userId, 'SUCCESS',
          isV2User ? 'Withdrawal complete — USDC is in your EOA wallet' : 'Withdrawal prepared — funds are idle USDC in vault',
          isV2User
            ? `${Number(idleUSDC) / 1e6} USDC sent to EOA ${user.policy.userAddress}`
            : `User must call vault.withdraw(USDC, ${idleUSDC.toString()}) to receive wallet funds`,
        );

        store.save(user.userId, registry.get(user.userId)!);
        store.markUserArchived(user.userId);
        pushState();

        pushWithdrawal({
          phase:    'COMPLETE',
          userId:   user.userId,
          message:  isV2User ? `${Number(idleUSDC) / 1e6} USDC is now in your wallet` : 'Funds ready — call vault.withdraw() to receive USDC',
          idleUSDC: Number(idleUSDC) / 1e6,
          txHash:   record.txHash,
        });

        
        if (record.receiptHash && record.txHash) {
          proofService.submit({
            userId:         user.userId,
            userAddress:    user.policy.userAddress!,
            receiptHash:    record.receiptHash,
            arbitrumTxHash: record.txHash,
            action:         'WITHDRAW',
            timestamp:      Date.now(),
            amountUSD:      Number(idleUSDC) / 1e6,
          });
        }

      } catch (err: any) {
        registry.update(user.userId, { phase: snapshotPortfolio ? 'MONITORING' : 'IDLE' });
        userLog(user.userId, 'ERROR', `Withdrawal failed: ${err.message}`);
        pushState();
        pushWithdrawal({ phase: 'FAILED', userId: user.userId, message: 'Withdrawal failed', error: err.message });
      }
    })();

    
    return {
      userId:  user.userId,
      status:  'WITHDRAWAL_STARTED',
      message: 'Withdrawal initiated — follow progress via SSE',
    };
  });

  
  setPauseCallback((target) => {
    const user = requireUniqueStrategyTarget(target);
    registry.update(user.userId, { phase: 'PAUSED' });
    userLog(user.userId, 'WARN', 'Agent paused by user request — position held open, no new actions');
    pushState();
    store.save(user.userId, registry.get(user.userId)!);
    return true;
  });

  
  setResumeCallback((target) => {
    const user = requireUniqueStrategyTarget(target);
    const nextPhase = user.portfolio && user.portfolio.positions.length > 0 ? 'MONITORING' : 'IDLE';
    registry.update(user.userId, { phase: nextPhase });
    userLog(user.userId, 'SUCCESS', `Agent resumed by user request — phase=${nextPhase}`);
    pushState();
    store.save(user.userId, registry.get(user.userId)!);
    return true;
  });

  
  setForceMigrateCallback(async (userId: string, targetPoolAddress: string) => {
    const user = registry.get(userId);
    if (!user) return false;
    
    const opp = agentState.opportunities.find(
      o => o.address?.toLowerCase() === targetPoolAddress.toLowerCase(),
    );
    if (!opp) {
      userLog(userId, 'WARN', `force-migrate: pool ${targetPoolAddress} not in opportunity list`);
      return false;
    }
    
    registry.update(userId, {
      policy: { ...user.policy, forceMigrateTargetId: opp.id },
    });
    userLog(userId, 'INFO', `force-migrate: targeted ${opp.pool} → will execute on next tick`);
    pushState();
    return true;
  });

  
  setPatchPolicyCallback((userId: string, patch: { migrationThresholdPct?: number }) => {
    const user = registry.get(userId);
    if (!user) return false;
    registry.update(userId, { policy: { ...user.policy, ...patch } });
    userLog(userId, 'INFO', `patch-policy: ${JSON.stringify(patch)}`);
    pushState();
    return true;
  });

  
  
  
  
  if (process.env.AGENT_PRIVATE_KEY) {
    resolveAgentAddress()
      .then(addr => {
        const mode = process.env.PIMLICO_API_KEY ? 'ERC-4337 smart account (Pimlico sponsored)' : 'EOA (direct gas)';
        console.log(`  🔑  Agent address : ${addr}`);
        console.log(`  ⛽  Gas mode      : ${mode}`);
        console.log(`  ↳  Set this address as AGENT in vault constructor (or call setAgent after deploy)\n`);
        globalLog('INFO', `Agent address: ${addr} | Gas mode: ${mode}`);
      })
      .catch(err => console.warn('  ⚠️  Could not resolve agent address:', err.message));
  }

  try {
    agentState.block = await provider.getBlockNumber();
    console.log(`  ✅  Arbitrum — block #${agentState.block.toLocaleString()}\n`);
    globalLog('SUCCESS', `Arbitrum connected — block #${agentState.block.toLocaleString()}`);
  } catch {
    console.log('  ⚠️   RPC unavailable\n');
    globalLog('WARN', 'RPC unavailable — on-chain verification disabled');
  }

  console.log('  Restoring persisted user states...');

  
  const isProduction = process.env.AGENT_ENVIRONMENT === 'production';
  const demoPoliciesToLoad = isProduction ? [] : DEMO_POLICIES;

  const activeRealUserIds = store.getActiveUserIds();
  console.log(`  🔍  Found ${activeRealUserIds.length} active real user IDs in index:`, activeRealUserIds);
  const allIds = [...demoPoliciesToLoad.map(p => p.id), ...activeRealUserIds];

  
  
  
  const redisCache      = await loadAllFromRedis();
  const idsNotInRedis   = allIds.filter(id => !redisCache.has(id));
  const fallback        = idsNotInRedis.length > 0
    ? await store.loadAll(idsNotInRedis)
    : new Map<string, import('./types').UserState>();
  
  const persisted = new Map([...fallback, ...redisCache]);

  if (redisCache.size > 0) {
    console.log(`  ⚡  Redis cache: ${redisCache.size} states loaded instantly (${idsNotInRedis.length} fetched from 0G/local)`);
  }
  console.log(`  📦  Loaded ${persisted.size} states from persistence. Keys:`, [...persisted.keys()]);

  for (const policy of demoPoliciesToLoad) {
    const saved = persisted.get(policy.id);
    if (saved) {
      registry.restore(saved);
      console.log(`  ✅  Restored: ${policy.displayName}${saved.portfolio ? ` (${saved.portfolio.positions.length}-position portfolio)` : ''}`);
      globalLog('SUCCESS', `Restored ${policy.displayName}`, saved.portfolio ? `${saved.portfolio.positions.length} positions, ${saved.portfolio.metrics.weightedNetAPY?.toFixed(2)}% APY` : 'no portfolio');
    } else {
      registry.register(policy);
      console.log(`  🆕  Fresh:    ${policy.displayName}`);
      globalLog('INFO', `Fresh start: ${policy.displayName}`);
    }
  }

  
  
  let restoredReal = 0;
  for (const userId of activeRealUserIds) {
    const saved = persisted.get(userId);
    if (saved) {
      if (saved.phase === 'WITHDRAWN') {
        store.markUserArchived(userId);
        console.log(`  ⏭️  Skipped (WITHDRAWN): ${saved.policy.displayName}`);
        continue;
      }
      store.registerActiveUser(userId);
      registry.restore(saved);
      restoredReal++;
      console.log(`  ✅  Real user: ${saved.policy.displayName} (${saved.policy.userAddress?.slice(0, 10)}…)${saved.portfolio ? ` — ${saved.portfolio.positions.length} position(s)` : ''}`);
      globalLog('SUCCESS', `Restored real user: ${saved.policy.displayName}`, saved.portfolio ? `${saved.portfolio.positions.length} positions` : 'no portfolio');

      
      if (saved.policy.signedDelegation) {
        const exec = getExecutor();
        exec?.setUserDelegation(userId, saved.policy.signedDelegation);
        console.log(`  🔗  V2 delegation re-wired: ${saved.policy.displayName} → ${saved.policy.smartAccountAddress?.slice(0, 10)}…`);
      }
    }
  }
  if (activeRealUserIds.length > 0) {
    console.log(`  ✅  ${restoredReal}/${activeRealUserIds.length} real users restored from persistence\n`);
  }

  await runStartupUniV3ReconciliationSweep();
  await runStartupExecutionProofBackfillSweep();

  console.log('');
  pushState();

  await tick().catch((err: Error) => {
    globalLog('ERROR', `First tick failed: ${err.message}`);
    console.error('[Orchestrator] First tick error:', err);
  });

  setInterval(async () => {
    if (tickRunning) {
      globalLog('WARN', `Tick #${agentState.tickCount + 1} skipped — previous tick still running`);
      return;
    }
    tickRunning = true;
    try {
      try { agentState.block = await provider.getBlockNumber(); } catch {  }
      await tick();
    } catch (err: any) {
      globalLog('ERROR', `Tick failed: ${err.message}`);
    } finally {
      tickRunning = false;
    }
  }, TICK_MS);

  
  
  let lastOcSnapshot: any = {};
  const runUniverseRefresh = async () => {
    try { lastOcSnapshot = await onChain.fetchSnapshot(); } catch {  }
    await refreshUniverse(lastOcSnapshot);
  };
  runUniverseRefresh();
  setInterval(runUniverseRefresh, UNIVERSE_MS);
}

main().catch(err => {
  console.error('[Orchestrator] Fatal boot error:', err);
  process.exit(1);
});
