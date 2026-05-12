/**
 * ============================================================
 *  YIELDGEKO AGENT ORCHESTRATOR  v3.0
 * ============================================================
 *  Full production architecture:
 *    · GeckoScore multi-factor opportunity ranking
 *    · Multi-position portfolio per user
 *    · Real-time IL tracking and break-even monitoring
 *    · Gas-optimised auto-compounding
 *    · Pendle PT/LP + Morpho + GMX + Delta-neutral + Aave
 *    · Persistent state via 0G Storage
 *    · Multi-user isolated execution
 *    · Graceful error recovery (no crashes)
 *    · SSE streaming to frontend
 * ============================================================
 */

import * as dotenv from 'dotenv';
import * as path   from 'node:path';
import * as crypto from 'node:crypto';
import { JsonRpcProvider } from 'ethers';

import type {
  AgentState, UserState, Opportunity, Portfolio, PortfolioPosition,
  CircuitBreaker, LogEntry,
} from './types';

import { fetchUniverse }                                      from './universe';
import { decideAllocation, runSafetyGate }                   from './allocation';
import { updatePortfolioPositions, updatePortfolioPositionsReal, checkCircuitBreakers, hasRedBreaker, buildExecutionRecord } from './monitor';
import { broadcast, setLatestState, startSSEServer, setRegisterCallback, setIsIdTakenCallback, setResetCallback, setWithdrawCallback, setPauseCallback, setResumeCallback, setForceMigrateCallback, setPatchPolicyCallback } from './sse';
import { OnChainProvider }                                   from './protocols';
import { PersistenceStore, uploadExecutionTrace }            from './persistence';
import { getJournal }                                        from './journal';
import { anchorExecutionProof }                              from './zgChain';
import { generateTEEAttestation }                           from './teeIntelligence';
import { UserRegistry, DEMO_POLICIES }                       from './users';
import { openPortfolio, planAllocation, buildPnLPoint }      from './portfolio';
import { evaluatePortfolioHarvests }                         from './compounder';
import { getExecutor, resolveAgentAddress, TOKEN_ADDRESSES, parseUniV3MintFromReceipt } from './execution';
import type { ExecutionInput, OnChainExecutionResult }        from './execution';
import { assessAllDrifts }                                    from './driftMonitor';
import type { DriftResult }                                   from './driftMonitor';
import { adjustPoolForCapital, MIN_DELTA_NEUTRAL_USD }        from './protocols/uniV3Screener';

// ── Env ───────────────────────────────────────────────────────────────────────

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env.local'), override: true });

const RPC_URL      = process.env.ARB_RPC_URL    ?? 'https://arbitrum-one-rpc.publicnode.com';
const TICK_MS      = Number(process.env.TICK_MS         ?? 60_000);
const TICK_TIMEOUT = Number(process.env.TICK_TIMEOUT_MS ?? 90_000);
const MAX_ERRORS   = Number(process.env.MAX_TICK_ERRORS ?? 3);
const MAX_LOG      = 80;
const MAX_PNL      = 1_440;
const MAX_EXEC     = 50;

// ── Process-level safety ──────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[Orchestrator] ${signal} — draining ${store?.pendingUploads ?? 0} pending 0G uploads...`);
  globalLog('WARN', `Shutdown: ${signal}`);
  if (store) await store.drain();
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

// ── Singletons ────────────────────────────────────────────────────────────────

let provider:  JsonRpcProvider;
let onChain:   OnChainProvider;
let store:     PersistenceStore;
let registry:  UserRegistry;

// ── Global state ──────────────────────────────────────────────────────────────

let agentState: AgentState = {
  users: {}, opportunities: [], globalLog: [],
  lastTickAt: 0, nextTickAt: Date.now() + TICK_MS, block: 0, tickCount: 0,
};

// ── Logging ───────────────────────────────────────────────────────────────────

function mkEntry(level: LogEntry['level'], message: string, detail?: string): LogEntry {
  return { id: crypto.randomUUID(), timestamp: Date.now(), level, message, detail };
}

function globalLog(level: LogEntry['level'], message: string, detail?: string): void {
  const e = getJournal().addLog('__global__', level, message, detail);
  // Keep ephemeral globalLog in AgentState for immediate UI snapshot
  agentState.globalLog = [e, ...agentState.globalLog].slice(0, MAX_LOG);
  broadcast({ type: 'LOG', ts: Date.now(), payload: { userId: '__global__', entry: e } });
}

function userLog(userId: string, level: LogEntry['level'], message: string, detail?: string): void {
  const user = registry.get(userId);
  const e = getJournal().addLog(userId, level, message, detail, user?.activeSessionId);
  broadcast({ type: 'LOG', ts: Date.now(), payload: { userId, entry: e } });
}



function pushState(): void {
  agentState.users = registry.toRecord();
  // Inject hot history into the snapshot so the UI has immediate context on refresh
  for (const userId in agentState.users) {
    const journal = getJournal();
    (agentState.users[userId] as any).log = journal.getHotLogs(userId, 40);
    (agentState.users[userId] as any).executions = journal.getExecutions(userId, 10);
    (agentState.users[userId] as any).pnlHistory = journal.getPnLHistory(userId, 200).reverse();
  }
  setLatestState({ ...agentState });
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

// ── Timeout wrapper ───────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<null>(r => { timer = setTimeout(() => r(null), ms); }),
  ]).then(v => { clearTimeout(timer); return v as T | null; });
}

// ── Live execution guardrails ───────────────────────────────────────────────────
//
// The current onboarding path funds the vault with Arbitrum USDC only. The scanner
// can still rank many attractive markets, but production execution must not send
// real user funds unless the strategy builder can be funded from that exact asset.

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
      // Requires ETH in smart account for keeper fees — disabled until GMX_ENABLED=true
      return process.env.GMX_ENABLED === 'true' && isEvmAddress(opp.address);

    case 'DELTA_NEUTRAL':
      // Token-agnostic deposit: reads pool token0/token1 at execution time.
      // LVR screener validates the pool on-chain; execution handles both USDC-paired
      // (Case A: one swap) and non-USDC pairs like WETH-ARB (Case B: two swaps).
      return isEvmAddress(opp.address);

    case 'PENDLE_PT':
      // swapExactTokenForPt accepts USDC directly. Market address from Pendle API.
      // PT address required for position tracking — must be present.
      return isEvmAddress(opp.address) && Boolean(opp.ptAddress);

    case 'PENDLE_LP':
      // addLiquiditySingleToken accepts USDC directly. Market address from Pendle API.
      return isEvmAddress(opp.address);

    case 'PENDLE_YT':
      // swapExactTokenForYt accepts USDC directly.
      // YT is high-risk, restricted to advanced tier — allowed but tier-gated by allocation engine.
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

  // For DELTA_NEUTRAL: verify gas economics are viable at the user's actual capital,
  // not the screener's reference $10k. A $50 deposit at ±3% would lose 292% to gas.
  // adjustPoolForCapital re-runs the gas-friction check with the real capital and
  // returns the widest range where gas < 1% of net APY, or null if no range works.
  let rangePct: number | undefined = opportunity.lvrOptimalRangePct;
  if (opportunity.strategyType === 'DELTA_NEUTRAL') {
    if (MIN_DELTA_NEUTRAL_USD > 0 && policy.managedUSD < MIN_DELTA_NEUTRAL_USD) {
      throw new Error(
        `Capital $${policy.managedUSD} below minimum $${MIN_DELTA_NEUTRAL_USD} for DELTA_NEUTRAL — route to passive yield`,
      );
    }
    // FORCE_OPTIMAL_RANGE=true → everyone gets the screener's optimal range (testing mode).
    // Unset → capital-aware range protects platform Pimlico economics (production mode).
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
    // V2: thread userId + portfolio value for delegation lookup + ExecutionArgs
    userId:            policy.id,
    portfolioValueUSD: portfolioValueUSD ?? policy.managedUSD,
    // V2: yield must accrue to smart account, not vault or EOA
    recipientAddress:  policy.smartAccountAddress,
  };
}

function patchFromExecutionResult(result: OnChainExecutionResult): Partial<PortfolioPosition> {
  const patch: Partial<PortfolioPosition> = { simulated: false };
  if (result.uniV3TokenId)        patch.uniV3TokenId        = result.uniV3TokenId.toString();
  if (result.uniV3Liquidity)      patch.uniV3Liquidity      = result.uniV3Liquidity.toString();
  if (result.gmxOrderKey)         patch.gmxOrderKey         = result.gmxOrderKey;
  // UniV3 range tracking — stored for drift monitor each tick
  if (result.uniV3TickLower  !== undefined) patch.uniV3TickLower  = result.uniV3TickLower;
  if (result.uniV3TickUpper  !== undefined) patch.uniV3TickUpper  = result.uniV3TickUpper;
  if (result.uniV3CenterTick !== undefined) patch.uniV3CenterTick = result.uniV3CenterTick;
  if (result.uniV3RangePct   !== undefined) patch.uniV3RangePct   = result.uniV3RangePct;
  if (result.uniV3EntryPool)                patch.uniV3EntryPool  = result.uniV3EntryPool;
  // On-chain state for position-reader.ts — stored as decimal strings to survive JSON serialisation
  if (result.entryLiquidityIndex) patch.entryLiquidityIndex = result.entryLiquidityIndex.toString();
  if (result.morphoShares)        patch.morphoShares        = result.morphoShares.toString();
  if (result.pendleLpAmount)      patch.pendleLpAmount      = result.pendleLpAmount.toString();
  return patch;
}

// Drift threshold: rebalance UniV3 position when it has drifted 70% toward boundary
const DRIFT_TRIGGER = process.env.DRIFT_TRIGGER ? parseFloat(process.env.DRIFT_TRIGGER) : 0.70;

// ── Per-user tick ─────────────────────────────────────────────────────────────

async function tickUser(
  user:      UserState,
  elapsed:   number,
  ocSnapshot: any,
  driftMap:  Map<string, DriftResult>,   // positionId → DriftResult, pre-computed once per tick
): Promise<void> {
  const { userId, policy } = user;

  if (user.phase === 'WITHDRAWING' || user.phase === 'WITHDRAWN') {
    return;
  }

  // Fix E-4: Skip execution for users paused by on-chain drawdown protection.
  // Each tick, check if the vault has been resumed on-chain (operator called resumeUser).
  // If policy.active is true again, auto-clear the PAUSED phase and resume managing.
  if (user.phase === 'PAUSED') {
    const vaultAddr = process.env.VAULT_ADDRESS ?? '';
    // V2 users have no vault pause mechanism — their policy enforcer handles it on-chain.
    // Auto-resume V2 users so the agent can continue managing.
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
          // Fall through to normal tick execution
        } else {
          if (agentState.tickCount % 30 === 0) {
            userLog(userId, 'WARN',
              'User paused on-chain by vault drawdown protection — agent suspended until operator calls resumeUser()',
            );
          }
          return;
        }
      } catch {
        return; // RPC error — stay paused, retry next tick
      }
    } else {
      return;
    }
  }

  // ── Universe engine ──────────────────────────────────────────────────────
  let opportunities: Opportunity[] = agentState.opportunities;
  try {
    const result = await fetchUniverse(provider, policy.riskTier, ocSnapshot);
    // Only update the global cache when the result is non-empty.
    // An empty result typically means a DeFiLlama rate-limit on a back-to-back call
    // from another user's tick. Overwriting the cache with [] would cause every
    // subsequent user on this tick to get HOLD — so fall back to the last snapshot.
    if (result.opportunities.length > 0) {
      opportunities = result.opportunities;
      agentState.opportunities = opportunities;
    }

    const verified = opportunities.filter(o => o.verifiedOnChain).length;
    broadcast({ type: 'OPPORTUNITIES', ts: Date.now(), payload: { opportunities, count: opportunities.length } });
    userLog(userId, 'SUCCESS',
      `Universe: ${opportunities.length} opportunities ranked by GeckoScore (${verified} on-chain verified)`,
      `Top: ${opportunities[0]?.protocol} ${opportunities[0]?.pool} — GeckoScore ${opportunities[0]?.geckoScore?.toFixed(1)} @ ${opportunities[0]?.netAPY?.toFixed(2)}% net`,
    );
  } catch (err: any) {
    userLog(userId, 'WARN', 'Universe fetch partial — using last snapshot', err.message);
  }

  // ── Update portfolio NAV + IL ────────────────────────────────────────────
  const currentUser = registry.get(userId)!;
  const prices      = onChain.getPrices();

  if (currentUser.portfolio) {
    // Real users: read actual on-chain balances from each protocol.
    // Demo users (Alice/Bob/Carol): formula-based accrual — /agent page unchanged.
    const VAULT_ADDRESS = process.env.VAULT_ADDRESS ?? '';
    // V2: read protocol balances using smartAccountAddress; V1: use vault + EOA address
    const effectiveUserAddr = policy.smartAccountAddress ?? policy.userAddress;
    const canReadOnChain    = policy.isReal && policy.userAddress
      && (VAULT_ADDRESS || !!policy.smartAccountAddress);
    const updatedPortfolio = canReadOnChain
      ? await updatePortfolioPositionsReal(
          currentUser.portfolio, opportunities, elapsed, prices, provider, VAULT_ADDRESS, effectiveUserAddr,
        )
      : updatePortfolioPositions(
          currentUser.portfolio, opportunities, elapsed, prices,
        );

    const pnlPoint = buildPnLPoint(updatedPortfolio);
    getJournal().addPnL(userId, pnlPoint);
    registry.update(userId, {
      portfolio:  updatedPortfolio,
    });

    broadcast({ type: 'PORTFOLIO', ts: Date.now(), payload: { userId, portfolio: updatedPortfolio } });

    // Report current portfolio value on-chain for real users.
    // The contract uses this to auto-pause if drawdown exceeds policy.maxDrawdownBps.
    //
    // Frequency strategy — balance cost vs protection:
    //   - Agent software circuit breakers run every tick (real-time protection)
    //   - reportValue is the on-chain backstop if the agent itself fails
    //   - Call when: value moved > 0.5%, OR every 30 ticks (~30 min), OR on any execution
    //
    // This reduces reportValue from 1440×/day to ~48×/day per user (~97% gas reduction)
    // while maintaining on-chain safety within a 30-minute window.
    if (policy.isReal && policy.userAddress) {
      const executor = getExecutor();
      if (executor) {
        const lastReported = (currentUser as any)._lastReportedUSD ?? 0;
        const lastReportTick = (currentUser as any)._lastReportTick ?? 0;
        const currentUSD = updatedPortfolio.metrics.totalValueUSD;
        const pctChange  = lastReported > 0 ? Math.abs(currentUSD - lastReported) / lastReported : 1;
        const ticksSinceLast = agentState.tickCount - lastReportTick;

        // Skip reportValue when any DELTA_NEUTRAL position is in transitional state
        // (close completed, remint pending — live liquidity = 0 but funds are idle in vault).
        // Calling reportValue with the idle NAV would trigger a false drawdown pause on-chain
        // and block the executeBatchMulti remint call with UserPausedByDrawdown.
        const inRebalanceTransition = updatedPortfolio.positions.some(p => {
          if (p.strategyType !== 'DELTA_NEUTRAL' || !p.id) return false;
          const drift = driftMap.get(p.id);
          return drift !== undefined && drift.liquidity === 0n;
        });

        const skipUntilTick = (currentUser as any)._skipReportValueUntilTick ?? 0;
        const shouldReport = !inRebalanceTransition
          && agentState.tickCount > skipUntilTick
          && (
            pctChange >= 0.005      // >0.5% value change
            || ticksSinceLast >= 30  // every 30 ticks (~30 min)
            || lastReported === 0    // first report ever
          );

        if (shouldReport) {
          // V2: update delegation pre-value so ExecutionArgs are accurate next execution
          executor.updateDelegationPreValue(userId, currentUSD);

          // V1: report value on-chain (only for V1 vault users)
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

  // ── UniV3 drift monitoring + proactive rebalance ─────────────────────────
  // Drift results were pre-computed once for ALL users via Multicall3 before
  // this per-user tick. O(1) lookup here — no extra RPC calls per user.
  if (policy.isReal && policy.userAddress) {
    const executor = getExecutor();
    const portfolioNow = registry.get(userId)?.portfolio;

    if (executor && portfolioNow) {
      // Detect burned NFTs: if position-reader returned nftBurned=true, the NFT
      // no longer exists on-chain (was cleaned up after a failed migrate/recover).
      // Clear these positions and reset to IDLE so GENESIS re-deploys fresh.
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
        return; // let next tick handle GENESIS
      }

      // Backfill missing tokenId for V2 DELTA_NEUTRAL positions.
      // Uses the GENESIS txHash to re-parse the IncreaseLiquidity event — this is
      // the only approach that correctly handles multiple strategies in the same pool,
      // since the receipt is specific to THIS strategy's deployment transaction.
      for (const pos of portfolioNow.positions) {
        const needsBackfill =
          pos.strategyType === 'DELTA_NEUTRAL' &&
          policy.smartAccountAddress &&
          (!pos.uniV3TokenId || pos.uniV3Liquidity === '0' || pos.uniV3Liquidity === null);

        if (!needsBackfill) continue;

        // Find the GENESIS execution record for this position
        const genesisExec = getJournal().getExecutions(currentUser.userId).find(
          (e: any) => e.action === 'GENESIS' && e.txHash && e.txHash !== '0x',
        );

        if (!genesisExec?.txHash) continue;

        try {
          const receipt = await (provider as JsonRpcProvider).getTransactionReceipt(genesisExec.txHash);
          if (!receipt) continue;

          const parsed = parseUniV3MintFromReceipt(receipt);
          if (parsed && parsed.tokenId.toString() !== pos.uniV3TokenId) {
            userLog(userId, 'SUCCESS',
              `Backfilled tokenId=${parsed.tokenId} for position ${pos.id} (parsed from GENESIS tx ${genesisExec.txHash.slice(0, 10)}…)`,
            );
            const patched = portfolioNow.positions.map(p =>
              p.id === pos.id
                ? { ...p, uniV3TokenId: parsed.tokenId.toString(), uniV3Liquidity: parsed.liquidity.toString() }
                : p,
            );
            registry.update(userId, { portfolio: { ...portfolioNow, positions: patched } });
            store.save(userId, registry.get(userId)!);
          }
        } catch { /* non-fatal — will retry next tick */ }
      }

      for (const pos of portfolioNow.positions) {
        if (pos.strategyType !== 'DELTA_NEUTRAL' || !pos.uniV3TokenId) continue;

        const drift = driftMap.get(pos.id);
        if (!drift) continue;

        // Always update last-known drift pct in position state
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
            const rebalanceRecord = buildExecutionRecord('REBALANCE_UNIV3' as any, pos.venueName, pos.venueName, pos.allocationUSD);
            rebalanceRecord.sessionId = user.activeSessionId;
            const rangePatch = patchFromExecutionResult(rebalResult);
            const rebaledPositions = registry.get(userId)!.portfolio!.positions.map(p =>
              p.id === pos.id ? {
                ...p, ...rangePatch,
                uniV3Rebalances: (p.uniV3Rebalances ?? 0) + 1,
                uniV3LastDriftPct: 0,
              } : p,
            );
            // Reset peakValueUSD to current portfolio value after rebalance.
            // The new position starts at a lower value due to swap slippage — measuring
            // drawdown against the pre-rebalance peak would immediately fire the circuit
            // breaker and cause a SAFETY_EXIT on every rebalance.
            // Fix D-2: use pos.allocationUSD as the reset peak instead of totalValueUSD which
            // may be 0 or stale (position reader hasn't run yet on the new position).
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
              // Skip reportValue for 2 ticks after rebalance so the position reader
              // can settle on the new NAV before the on-chain drawdown check runs.
              _skipReportValueUntilTick: agentState.tickCount + 2,
            } as any);

            userLog(userId, 'SUCCESS',
              `Rebalanced ${pos.venueName}: new tokenId ${rebalResult.uniV3TokenId?.toString() ?? '?'} tx:${rebalResult.txHash.slice(0, 10)}…`,
            );

            // ── 0G Proof trail for REBALANCE (non-blocking, full TEE) ────────
            if (policy.userAddress && rebalResult.receiptHash) {
              const rebalReceiptHash  = rebalResult.receiptHash;
              const rebalOpportunities = opportunities;
              // Synthetic decision: TEE validates rebalance timing + range given current market
              const rebalDecision = {
                action:              'REBALANCE' as const,
                targetOpportunity:   opportunities.find(o => o.id === pos.venueId) ?? opportunities[0] ?? null,
                currentOpportunity:  opportunities.find(o => o.id === pos.venueId) ?? null,
                reason:              `Price drift ${((drift?.driftPct ?? 0) * 100).toFixed(0)}% ≥ ${(DRIFT_TRIGGER * 100).toFixed(0)}% threshold — TEE validates timing`,
                upliftPct:           0,
              };
              ;(async () => {
                try {
                  const traceCID = await uploadExecutionTrace({
                    action:         'REBALANCE',
                    userId,
                    userAddress:    policy.userAddress!,
                    receiptHash:    rebalReceiptHash,
                    arbitrumTxHash: rebalResult.txHash,
                    timestamp:      Date.now(),
                    poolAddress:    pos.venueAddress,
                    amountUSD:      pos.allocationUSD,
                    screenerTop5:   rebalOpportunities.slice(0, 5),
                    teeDecision:    { action: 'REBALANCE', reason: rebalDecision.reason, upliftPct: 0 },
                  });
                  const teeResult = await generateTEEAttestation({
                    opportunities: rebalOpportunities,
                    decision:      rebalDecision,
                    userId,
                    userAddress:   policy.userAddress!,
                    receiptHash:   rebalReceiptHash,
                  });
                  const anchor = await anchorExecutionProof({
                    receiptHash: rebalReceiptHash,
                    userAddress: policy.userAddress!,
                    action:      'REBALANCE',
                    traceCID:    traceCID ?? '',
                    attestCID:   teeResult?.attestCID ?? '',
                  });
                  if (anchor || traceCID || teeResult) {
                    rebalanceRecord.zgChainTxHash   = anchor?.txHash;
                    rebalanceRecord.zgChainExplorer = anchor?.explorerUrl;
                    rebalanceRecord.zgTraceCID      = traceCID ?? undefined;
                    rebalanceRecord.zgAttestCID     = teeResult?.attestCID ?? undefined;
                    const cur = registry.get(userId);
                    getJournal().updateExecution(userId, rebalReceiptHash, {
                      zgChainTxHash:   anchor?.txHash,
                      zgChainExplorer: anchor?.explorerUrl,
                      zgTraceCID:      traceCID ?? undefined,
                      zgAttestCID:     teeResult?.attestCID ?? undefined,
                    });
                    pushState();

                  }
                } catch (e: any) {
                  console.warn('[0G] Rebalance proof trail failed (non-fatal):', e.message?.slice(0, 80));
                }
              })();
            }
          }
        } catch (err: any) {
          // Fix E-4: detect vault drawdown pause in rebalance path
          if (err.message?.includes('0xe12b3530') || err.message?.includes('UserPausedByDrawdown')) {
            userLog(userId, 'WARN',
              'User paused on-chain by vault drawdown protection — agent suspended until operator calls resumeUser()',
            );
            registry.setPhase(userId, 'PAUSED');
            pushState();
            return;
          }
          // Fix H-3: detect empty position after rebalance close
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

  // ── Circuit breakers ─────────────────────────────────────────────────────
  const latestUser = registry.get(userId)!;

  // Check transitional state again with latest portfolio (rebalance may have run above)
  const inRebalanceTransitionNow = latestUser.portfolio?.positions.some(p => {
    if (p.strategyType !== 'DELTA_NEUTRAL' || !p.id) return false;
    const drift = driftMap.get(p.id);
    return drift !== undefined && drift.liquidity === 0n;
  }) ?? false;

  // During rebalance transition (close done, remint pending), suppress drawdown circuit breaker.
  // Funds are sitting idle in vault balances — not a real loss, just mid-rebalance.
  // All other circuit breakers (APY, IL, HF) still fire normally.
  let breakers: CircuitBreaker[] = checkCircuitBreakers(latestUser.portfolio, opportunities, policy);
  if (inRebalanceTransitionNow) {
    breakers = breakers.map(b =>
      b.id === 'portfolio-drawdown' ? { ...b, status: 'GREEN' as const, value: '0% (rebalance in progress)' } : b,
    );
  }
  // Fix B-3: add a WARN-level breaker when Chainlink prices are stale.
  // Does NOT trigger RED/SAFETY_EXIT — stale prices alone are not an emergency.
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
  broadcast({ type: 'BREAKERS', ts: Date.now(), payload: { userId, breakers } });

  const redFlag = hasRedBreaker(breakers);
  if (redFlag) userLog(userId, 'WARN', `⚠ Circuit breaker RED — ${breakers.find(b => b.status === 'RED')?.name}`);

  // ── Allocation decision ──────────────────────────────────────────────────
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
  broadcast({ type: 'ALLOCATION', ts: Date.now(), payload: { userId, decision } });

  userLog(userId, decision.action === 'HOLD' ? 'INFO' : 'WARN',
    `Decision: ${decision.action}`, decision.reason,
  );

  // ── Safety gate + execution ──────────────────────────────────────────────
  if (decision.action !== 'HOLD' && decision.action !== 'HARVEST') {
    const target = decision.targetOpportunity;
    if (!target) {
      userLog(userId, 'WARN', 'No target opportunity — holding');
    } else {
      registry.setPhase(userId, 'MIGRATING');
      const safety = runSafetyGate(target, policy);
      broadcast({ type: 'SAFETY', ts: Date.now(), payload: { userId, safety } });

      // Fix E-2: Safe haven bypasses ONLY the APY floor check — not TVL.
      // A safe haven with < $1M TVL is not actually safe, so TVL must still pass.
      const isSafeHaven = decision.reason?.includes('safe haven');
      const safetyPassed = isSafeHaven
        ? safety.checks.every(c => c.name !== 'Net APY floor' ? c.passed : true)  // TVL etc. must pass; APY floor exempt
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

        // ── Real on-chain execution (real users only) ──────────────────────
        // Stores on-chain return data (UniV3 tokenId, GMX order key) back
        // into the position so future collect/withdraw calls work correctly.
        let onChainPositionPatch: Partial<import('./types').PortfolioPosition> = {};
        let realExecutionSucceeded = !policy.isReal;

        if (policy.isReal && policy.userAddress) {
          const executor = getExecutor();
          if (executor) {
            try {
              const currentPrice    = onChain.getPrices().get('WETH')?.priceUSD;
              const portfolioValueUSD = currentUser.portfolio?.metrics.totalValueUSD ?? policy.managedUSD;
              const toInput = buildLiveExecutionInput(target, policy, currentPrice, portfolioValueUSD);
              // Pass screener's optimal range to execution so tick range is LVR-calibrated
              if (target.lvrOptimalRangePct) toInput.rangePct = target.lvrOptimalRangePct;

              // Fix A-4: For multi-position GENESIS (≥$5k DELTA_NEUTRAL), the first deposit
              // must use only 60% of capital — NOT 100%. Without this, the first deposit drains
              // the full vault balance and the second 40% deposit is guaranteed to revert.
              // Pre-compute whether a second pool is available BEFORE the first deposit.
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

              // Fix F-2: find the position that matches the migration target (by venueId or strategyType),
              // not always positions[0]. For SAFETY_EXIT, pick the largest position by allocationUSD.
              const fromPos = (() => {
                const positions = prevUser.portfolio?.positions ?? [];
                if (decision.action === 'MIGRATE') {
                  // Match the position being replaced: same venueId as currentOpportunity, or
                  // same strategyType as target (the one allocation.ts chose to migrate away from)
                  const currentOppId = decision.currentOpportunity?.id;
                  const byVenueId = currentOppId ? positions.find(p => p.venueId === currentOppId) : undefined;
                  if (byVenueId) return byVenueId;
                  const byStrategy = positions.find(p => p.strategyType === target.strategyType);
                  if (byStrategy) return byStrategy;
                }
                // SAFETY_EXIT or no match: use largest position (most at risk)
                return positions.length > 0
                  ? [...positions].sort((a, b) => b.allocationUSD - a.allocationUSD)[0]
                  : undefined;
              })();
              let exitAmountRaw = BigInt(Math.round(policy.managedUSD * 1e6));
              let exitAmountUSD = policy.managedUSD;
              if ((decision.action === 'MIGRATE' || decision.action === 'SAFETY_EXIT') && fromPos) {
                // V2: deployed funds sit in the smart account under the protocol, not the V1 vault.
                // For V2 users we read the protocol balance via smartAccountBalance;
                // for V1 users we use the vault's deployed() mapping.
                if (policy.smartAccountAddress) {
                  // V2: funds are in the LP NFT, not in liquid USDC.
                  // smartAccountBalance(USDC) ≈ 0 while position is open — using it as
                  // the portfolio value would cause a false DrawdownExceeded on the enforcer.
                  // Use the agent's known portfolio value (or policy.managedUSD as floor).
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
              // For UniV3 positions, use the live on-chain liquidity from the drift monitor
              // rather than the stale stored value. This handles the case where a previous
              // failed migrate already called decreaseLiquidity (setting liquidity to 0
              // on-chain) but the agent's stored uniV3Liquidity still has the old value.
              const liveDrift = fromPos?.id ? driftMap.get(fromPos.id) : undefined;
              const liveLiquidity = liveDrift ? liveDrift.liquidity
                : (fromPos?.uniV3Liquidity ? BigInt(fromPos.uniV3Liquidity) : undefined);

              if (policy.isReal) {
                console.log(`[Execute:${userId}] action=${decision.action} fromPos=${fromPos?.uniV3TokenId ?? 'none'} liveLiquidity=${liveLiquidity?.toString() ?? 'none'}`);
                console.log(`[Execute:${userId}] will migrate=${!!((decision.action === 'MIGRATE' || decision.action === 'SAFETY_EXIT') && prevUser.portfolio && fromPos)}`);
              }
              // Before GENESIS, verify enough UNALLOCATED USDC is available.
              // For V2 multi-strategy: subtract capital reserved by other IDLE
              // strategies on the same smart account — they haven't deployed yet
              // so their USDC is still in the smart account but already committed.
              if (decision.action === 'GENESIS') {
                const rawBalance = policy.smartAccountAddress
                  ? await executor.smartAccountBalance(policy.smartAccountAddress, TOKEN_ADDRESSES.USDC)
                  : await executor.idleBalance(policy.userAddress, TOKEN_ADDRESSES.USDC);

                // Capital reserved by OTHER idle strategies on the same smart account
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
                      // V2: thread userId + smart account so close path can use delegation
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

              // Persist protocol-specific return data into the position state
              onChainPositionPatch = patchFromExecutionResult(result);

              userLog(userId, 'SUCCESS', `On-chain tx confirmed: ${result.txHash.slice(0, 10)}…`, `Gas: ${result.gasUsed}`);

              // ── 0G Proof trail (non-blocking, non-fatal) ──────────────────
              // Three components run in background after Arbitrum TX confirms:
              //   1. 0G Storage  — upload execution trace JSON → traceCID
              //   2. 0G Compute  — TEE-sign screener+decision → attestCID
              //   3. 0G Chain    — anchor both CIDs in YieldGekoRegistry
              if (policy.userAddress && result.receiptHash) {
                (async () => {
                  try {
                    // Component 1: execution trace on 0G Storage
                    const traceCID = await uploadExecutionTrace({
                      action:         decision.action as string,
                      userId,
                      userAddress:    policy.userAddress!,
                      receiptHash:    result.receiptHash,
                      arbitrumTxHash: result.txHash,
                      timestamp:      Date.now(),
                      poolAddress:    toInput.marketAddress,
                      amountUSD:      toInput.amountUSD,
                      screenerTop5:   decisionOpportunities.slice(0, 5),
                      teeDecision:    { action: decision.action, reason: decision.reason, upliftPct: decision.upliftPct },
                    });

                    // Component 2: TEE-attested decision blob on 0G Storage
                    const teeResult = await generateTEEAttestation({
                      opportunities: decisionOpportunities,
                      decision,
                      userId,
                      userAddress:  policy.userAddress!,
                      receiptHash:  result.receiptHash,
                    });

                    // Component 3: anchor trace + attestation CIDs on 0G Chain
                    const anchor = await anchorExecutionProof({
                      receiptHash: result.receiptHash,
                      userAddress: policy.userAddress!,
                      action:      decision.action as 'GENESIS' | 'MIGRATE' | 'REBALANCE' | 'WITHDRAW',
                      traceCID:    traceCID ?? '',
                      attestCID:   teeResult?.attestCID ?? '',
                    });

                    if (anchor || traceCID || teeResult) {
                      record.zgChainTxHash   = anchor?.txHash;
                      record.zgChainExplorer = anchor?.explorerUrl;
                      record.zgTraceCID      = traceCID ?? undefined;
                      record.zgAttestCID     = teeResult?.attestCID ?? undefined;
                      // Patch the stored record with 0G links
                      getJournal().updateExecution(userId, result.receiptHash, {
                        zgChainTxHash:   anchor?.txHash,
                        zgChainExplorer: anchor?.explorerUrl,
                        zgTraceCID:      traceCID ?? undefined,
                        zgAttestCID:     teeResult?.attestCID ?? undefined,
                      });
                      pushState();

                    }
                  } catch (e: any) {
                    console.warn('[0G] Proof trail failed (non-fatal):', e.message?.slice(0, 80));
                  }
                })();
              }
              // NOTE: No fee collected here — funds just deployed, yield not yet accrued.
              // Fees are collected after executeWithdraw (when yield lands as idle balance).
            } catch (err: any) {
              // Fix E-4: Detect vault drawdown pause and suspend agent for this user
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
        // ──────────────────────────────────────────────────────────────────

        if (policy.isReal && !realExecutionSucceeded) {
          registry.setPhase(userId, prevUser.portfolio ? 'MONITORING' : 'IDLE');
          pushState();
          return;
        }

        let newPortfolio: Portfolio | null = null;

        if (decision.action === 'GENESIS') {
          // Multi-position DELTA_NEUTRAL for real users with ≥$5k capital:
          //   Open top 2 LVR-screened pools weighted by netAPY (60/40 split).
          //   Single position for everyone else (demo, Pendle, Aave, etc.)
          let realAllocations: { opportunity: typeof target; allocationPct: number; allocationUSD: number }[] = [];

          if (policy.isReal && target.strategyType === 'DELTA_NEUTRAL' && policy.managedUSD >= 5_000) {
            const dnOpps = decisionOpportunities
              .filter(o => o.strategyType === 'DELTA_NEUTRAL' && o.address !== target.address)
              .slice(0, 1);

            if (dnOpps.length > 0) {
              // Weighted split: top pool gets 60%, second gets 40%
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

          // Execute deposits for any additional positions beyond the first
          // (first position tx was already executed above as `result`)
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
                  // Patch the corresponding position with its on-chain data
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

          // Set entry prices and Pendle maturity data
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
              maturityDate: opp?.maturityDate,  // Pendle: determines pre/post maturity exit path
              ytAddress:    opp?.ytAddress,      // Pendle YT/PT: needed for redeemPyToToken
              ptAddress:    opp?.ptAddress,      // Pendle PT: needed for PT balance reads in position-reader
            };
          });

          userLog(userId, 'SUCCESS',
            `Portfolio opened: ${newPortfolio.positions.length} positions`,
            newPortfolio.positions.map(p => `${p.strategyType} ${p.allocationPct.toFixed(0)}%`).join(' · '),
          );

        } else if (decision.action === 'MIGRATE' && prevUser.portfolio) {
          // Find the position to migrate (matching strategy type or lowest GeckoScore)
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
          // Move all capital to safe haven
          const safeHaven  = target;
          const totalValue = prevUser.portfolio.metrics.totalValueUSD;
          const safePos: PortfolioPosition = {
            id: crypto.randomUUID(), venueId: safeHaven.id,
            venueAddress: safeHaven.address,
            venueName: `${safeHaven.protocol} ${safeHaven.pool}`,
            protocol: safeHaven.protocol, strategyType: safeHaven.strategyType,
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
          // Patch on-chain position data (tokenId, gmxOrderKey etc.) into the
          // relevant position — the last position in the portfolio is the one just opened.
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

          broadcast({ type: 'EXECUTION', ts: Date.now(), payload: { userId, record } });
          broadcast({ type: 'PORTFOLIO', ts: Date.now(), payload: { userId, portfolio: newPortfolio } });
        }
      }
    }

  } else if (decision.action === 'HARVEST' && freshUser.portfolio) {
    const harvests = evaluatePortfolioHarvests(freshUser.portfolio.positions);
    if (harvests.length > 0) {
      const h = harvests[0];

      // HWM soft gate: skip harvest if portfolio is below its high-water mark by >2%.
      // Harvesting during drawdown crystallises losses and charges fees on a declining account.
      // (Hard pause is handled on-chain via reportValue; this is a second agent-side guard.)
      const totalCurrentUSD = freshUser.portfolio.positions.reduce((s, p) => s + (p.currentUSD ?? 0), 0);
      const peakUSD         = freshUser.portfolio.positions.reduce((s, p) => s + (p.entryUSD ?? p.currentUSD ?? 0), 0);
      const belowHWM        = peakUSD > 0 && totalCurrentUSD < peakUSD * 0.98;
      if (belowHWM) {
        userLog(userId, 'INFO', `HARVEST deferred: portfolio ${(totalCurrentUSD / peakUSD * 100).toFixed(1)}% of HWM — waiting for recovery`);
      } else {

      userLog(userId, 'SUCCESS', `HARVEST: ${h.reason}`);
      const record = buildExecutionRecord('HARVEST', freshUser.portfolio.positions[0]?.venueName ?? null, 'compound', h.pendingRewardsUSD);
      record.sessionId = freshUser.activeSessionId;

      // Real UniV3 fee collection for DELTA_NEUTRAL positions — routed through executeHarvest
      // Contract auto-charges performance fee on net USDC income (trustless, IL-safe).
      if (policy.isReal && policy.userAddress) {
        const executor = getExecutor();
        if (executor) {
          const pos = freshUser.portfolio.positions.find(
            p => p.strategyType === 'DELTA_NEUTRAL' && p.uniV3TokenId,
          );
          if (pos?.uniV3TokenId) {
            try {
              const ethPrice = onChain.getPrices().get('WETH')?.priceUSD ?? 3000;
              const result = await executor.collectUniV3Fees(
                BigInt(pos.uniV3TokenId), policy.userAddress, h.pendingRewardsUSD, ethPrice,
                policy.signedDelegation ? policy.id : undefined,
                policy.signedDelegation ? policy.smartAccountAddress : undefined,
                policy.signedDelegation ? (freshUser.portfolio?.metrics.totalValueUSD ?? policy.managedUSD) : undefined,
                policy.signedDelegation ? policy.maxFeeBps : undefined,
              );
              record.txHash      = result.txHash;
              record.receiptHash = result.receiptHash;
              record.simulated   = false;
              userLog(userId, 'SUCCESS',
                `UniV3 fees collected + WETH normalised to USDC: ${result.txHash.slice(0, 10)}…`
              );
            } catch (err: any) {
              userLog(userId, 'WARN', `UniV3 collect failed — staying simulated: ${err.message}`);
            }
          }
        }
      }

      getJournal().addExecution(userId, record);

      broadcast({ type: 'HARVEST', ts: Date.now(), payload: { userId, harvest: h } });
      } // end else (HWM gate passed)
    }
  } else {
    registry.setPhase(userId, freshUser.portfolio ? 'MONITORING' : 'IDLE');
  }

  // ── Persist ──────────────────────────────────────────────────────────────
  const finalUser = registry.get(userId)!;
  store.save(userId, finalUser);
}

// ── Main tick ─────────────────────────────────────────────────────────────────

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

  // One on-chain snapshot shared across all users this tick
  let ocSnapshot: any = {};
  try {
    ocSnapshot = await onChain.fetchSnapshot();
    globalLog('INFO',
      `On-chain: ${ocSnapshot.prices.size} prices · ${ocSnapshot.aaveMarkets.length} Aave · ${ocSnapshot.gmxMarkets.length} GMX`,
      `Chainlink: ${ocSnapshot.pricesHealthy ? 'fresh' : 'STALE'} · ${ocSnapshot.fetchDurationMs}ms`,
    );
    // Fix B-3: log WARN on stale Chainlink prices but do NOT trigger SAFETY_EXIT.
    // Stale prices increase IL/NAV measurement error — alert operator without overreacting.
    if (!ocSnapshot.pricesHealthy) {
      globalLog('WARN',
        'Chainlink prices STALE — on-chain price feeds may be delayed. NAV and IL readings may be inaccurate. No action taken.',
      );
    }
  } catch (err: any) {
    globalLog('WARN', 'On-chain snapshot failed — using last known state', err.message);
  }

  // Batch-assess all UniV3 position drifts in 2 Multicall3 calls (O(1) RPC, O(N) compute).
  // Pre-computed once here; each tickUser() reads from this map — no per-user RPC calls.
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

  // Group users by smart account address so that multiple strategies sharing
  // the same smart account are processed sequentially — prevents GENESIS race
  // conditions where two strategies read the same USDC balance before either
  // executes and both believe they have sufficient capital.
  // Different smart accounts (or V1 vault users) still run in parallel.
  const saGroups = new Map<string, UserState[]>();
  for (const user of registry.all()) {
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
    const result = await withTimeout(tickUser(user, elapsed, ocSnapshot, driftMap), TICK_TIMEOUT);
    if (result === null) {
      const errs = registry.incrementErrors(user.userId);
      userLog(user.userId, 'ERROR', `Tick timeout after ${TICK_TIMEOUT / 1_000}s (${errs}/${MAX_ERRORS})`);
    } else {
      registry.resetErrors(user.userId);
    }
  };

  // Parallel across smart accounts, sequential within each smart account's strategies
  await Promise.allSettled(
    Array.from(saGroups.values()).map(async (group) => {
      for (const user of group) await runUser(user);
    })
  );

  // Broadcast full state
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

// ── Boot ──────────────────────────────────────────────────────────────────────

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

  // Wire real-user registration — called by POST /api/register from the frontend.
  // Demo users (Alice/Bob/Carol) keep running alongside any real users who sign in.
  setRegisterCallback(async (policy) => {
    // ── Capital commitment check (V2 smart account strategies only) ──────────
    //
    // Ensures the smart account holds enough UNALLOCATED USDC to cover this
    // strategy's managedUSD before accepting the registration.
    //
    //   unallocated = smartAccountUSDC − Σ managedUSD of all IDLE strategies
    //                                     on the same smart account
    //
    // IDLE strategies have registered but not yet deployed — their capital is
    // still sitting as USDC in the smart account (reserved, not available).
    // MONITORING strategies have already deployed so their capital is NOT in
    // the smart account — they don't reduce the available USDC.
    // WITHDRAWN strategies have sent capital to EOA — they also don't count.
    //
    // This prevents over-commitment where N strategies all register against
    // the same USDC and only the first one successfully deploys.
    if (policy.smartAccountAddress && policy.managedUSD > 0) {
      const exec = getExecutor();
      if (exec) {
        const [usdcRaw] = await Promise.all([
          exec.smartAccountBalance(policy.smartAccountAddress, TOKEN_ADDRESSES.USDC),
        ]);
        const usdcAvailable = Number(usdcRaw) / 1e6;

        // Sum managedUSD of all IDLE strategies on the same smart account.
        // These are registered but not yet deployed — their USDC is reserved.
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

    // V2: if the policy includes a signed delegation, use V2 registration path
    if (policy.signedDelegation && policy.smartAccountAddress) {
      state = registry.registerV2(policy, policy.smartAccountAddress, policy.signedDelegation);
      // Wire delegation into the executor singleton
      const exec = getExecutor();
      if (exec) {
        exec.setUserDelegation(policy.id, policy.signedDelegation);
        globalLog('SUCCESS',
          `V2 user registered: ${policy.displayName} | smartAccount: ${policy.smartAccountAddress}`);
      }

      // ── 0G: anchor registration on 0G Chain (non-blocking, non-fatal) ─────
      // Creates a permanent public record: "user X registered with YieldGeko,
      // signed delegation Y, at time Z" — verifiable by anyone on 0G Chain.
      const delegationSig = policy.signedDelegation.signature;
      const registrationHash = '0x' + crypto
        .createHash('sha256')
        .update(`REGISTER:${policy.userAddress}:${policy.smartAccountAddress}:${delegationSig.slice(0, 32)}`)
        .digest('hex');
      // Anchor registration on 0G Chain after a short delay so the concurrent
      // state save (store.save below) settles its 0G Storage tx first.
      // Skipping trace upload here — the state save already persists the full
      // user state (including delegation) to 0G Storage.
      setTimeout(() => {
        anchorExecutionProof({
          receiptHash: registrationHash,
          userAddress: policy.userAddress!,
          action:      'REGISTER',
          traceCID:    '',   // state save covers storage; no separate trace upload
          attestCID:   '',
        }).then(anchor => {
          if (anchor) {
            console.log(`[0GChain] ✅ Registration anchored for ${policy.displayName} → ${anchor.explorerUrl}`);
          }
        }).catch((e: any) => {
          console.warn('[0G] Registration anchor failed (non-fatal):', e.message?.slice(0, 80));
        });
      }, 8_000); // 8 s — let state save tx confirm first
    } else {
      state = registry.registerReal(policy, policy.userAddress || '0x0000000000000000000000000000000000000000');


      globalLog('SUCCESS', `Real user registered: ${policy.displayName} (${policy.userAddress})`);
    }

    store.registerActiveUser(policy.id);
    store.save(policy.id, state);
    pushState();
    return state;
  });

  // Force-reset a user to IDLE — clears stale portfolio/positions from memory.
  // Called by POST /api/reset-user. Safe to call while agent is running.
  setResetCallback(async (userId: string) => {
    const existing = registry.get(userId);
    if (!existing) return false;
    // Write WITHDRAWN to both local disk AND 0G Storage before deregistering.
    // Drain waits for the 0G upload to confirm — ensures the next agent restart
    // loads WITHDRAWN from 0G and skips this strategy permanently.
    const tombstone = { ...existing, phase: 'WITHDRAWN' as const, portfolio: null, breakers: [] };
    store.save(userId, tombstone);   // saves to local immediately
    store.markUserArchived(userId);
    registry.deregister(userId);
    globalLog('WARN', `User ${userId} deregistered — WITHDRAWN written to disk (0G syncs in background)`);
    pushState();
    // Drain 0G in background — don't block the API response
    store.drain().catch((e: any) => console.warn('[Reset] 0G drain failed:', e.message));
    return true;
  });

  setWithdrawCallback(async (input) => {
    const user = requireUniqueStrategyTarget(input);
    if (!user.policy.isReal || !user.policy.userAddress) {
      throw new Error('Withdrawal is only available for real registered users');
    }
    if (user.phase === 'WITHDRAWING') {
      throw new Error('Withdrawal already prepared or in progress for this user');
    }
    if (!user.portfolio || user.portfolio.positions.length === 0) {
      const executor = getExecutor();
      const idleUSDC = executor
        ? await executor.idleBalance(user.policy.userAddress, TOKEN_ADDRESSES.USDC)
        : 0n;
      return {
        userId: user.userId,
        status: 'IDLE_ONLY',
        message: 'No active portfolio to unwind. User may withdraw idle USDC from the vault.',
        idleUSDCRaw: idleUSDC.toString(),
        idleUSDC: Number(idleUSDC) / 1e6,
      };
    }

    const executor = getExecutor();
    if (!executor) throw new Error('Agent executor not ready — check VAULT_ADDRESS and AGENT_PRIVATE_KEY');

    registry.update(user.userId, { phase: 'WITHDRAWING' });
    userLog(user.userId, 'WARN', 'Withdrawal requested — unwinding active portfolio to idle USDC');
    pushState();

    const txs: Array<{ positionId: string; closeTxHash: string; normalizeTxHash?: string }> = [];

    try {
      for (const pos of user.portfolio.positions) {
        // DELTA_NEUTRAL requires uniV3TokenId; all other strategies go through
        // executor.prepareWithdrawal which routes to the correct unwind path.
        if (pos.strategyType === 'DELTA_NEUTRAL' && !pos.uniV3TokenId) {
          throw new Error(`Position ${pos.id} is DELTA_NEUTRAL but missing uniV3TokenId`);
        }

        // Resolve pool address — prefer stored venueAddress; fall back to on-chain
        // lookup via NFT positions() + factory.getPool() when venueAddress is absent
        // (can happen for positions created before venueAddress was written to state).
        let resolvedMarket = pos.venueAddress ?? pos.uniV3EntryPool;
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
        if (!resolvedMarket) resolvedMarket = pos.venueId;  // last resort (may still be wrong)

        const amountRaw = BigInt(Math.max(0, Math.round((pos.currentUSD || pos.allocationUSD || user.policy.managedUSD) * 1e6)));
        const prepared = await executor.prepareWithdrawal({
          strategyType:      pos.strategyType,
          asset:             TOKEN_ADDRESSES.USDC,
          amount:            amountRaw,
          amountUSD:         pos.currentUSD || pos.allocationUSD || user.policy.managedUSD,
          userAddress:       user.policy.userAddress,
          marketAddress:     resolvedMarket,
          tokenId:           pos.uniV3TokenId ? BigInt(pos.uniV3TokenId) : undefined,
          liquidity:         pos.uniV3Liquidity ? BigInt(pos.uniV3Liquidity) : undefined,
          hedgeSizeUSD:      pos.hedgeSizeUSD,
          maturityDate:      pos.maturityDate,
          ytAddress:         pos.ytAddress,
          // V2 delegation fields — required for smart-account positions
          userId:            user.policy.smartAccountAddress ? user.userId : undefined,
          recipientAddress:  user.policy.smartAccountAddress,
          portfolioValueUSD: pos.currentUSD || pos.allocationUSD || user.policy.managedUSD,
          managedUSD:        user.policy.managedUSD,
        });

        txs.push({
          positionId: pos.id,
          closeTxHash: prepared.close.txHash,
          normalizeTxHash: prepared.normalize?.txHash,
        });
      }

      // V2: USDC lands in user's EOA after normalize — read from EOA.
      // V1: USDC is credited to vault accounting — read idleBalance.
      const isV2 = !!(user.policy.smartAccountAddress);
      const idleUSDC = isV2
        ? await executor.smartAccountBalance(user.policy.userAddress, TOKEN_ADDRESSES.USDC)
        : await executor.idleBalance(user.policy.userAddress, TOKEN_ADDRESSES.USDC);
      const record = buildExecutionRecord(
        'WITHDRAW',
        user.portfolio.positions.map(p => p.venueName).join(' + '),
        isV2 ? 'Smart account USDC' : 'Vault idle USDC',
        Number(idleUSDC) / 1e6,
        user.portfolio.metrics.totalValueUSD,
      );
      record.sessionId = user.activeSessionId;
      record.simulated = false;
      record.txHash = txs.at(-1)?.normalizeTxHash ?? txs.at(-1)?.closeTxHash;

      // Phase → IDLE: position is closed, funds are idle in vault.
      // Agent stops managing this user until they re-register or re-deposit.
      getJournal().addExecution(user.userId, record);
      registry.update(user.userId, {
        phase: 'WITHDRAWN',
        portfolio: null,
        breakers: [],
      });

      const isV2User = !!(user.policy.smartAccountAddress);
      userLog(
        user.userId,
        'SUCCESS',
        isV2User
          ? 'Withdrawal complete — USDC is in your EOA wallet'
          : 'Withdrawal prepared — funds are idle USDC in vault',
        isV2User
          ? `${Number(idleUSDC) / 1e6} USDC sent to EOA ${user.policy.userAddress}`
          : `User must call vault.withdraw(USDC, ${idleUSDC.toString()}) to receive wallet funds`,
      );

      const updated = registry.get(user.userId)!;
      // Save to local immediately — respond to frontend without waiting for 0G.
      // 0G upload + anchor fire in background so the UI isn't blocked 30-60s.
      store.save(user.userId, updated);
      store.markUserArchived(user.userId);
      pushState();

      // Fire 0G proof trail in background — does NOT block the response
      ;(async () => {
        try {
          await store.drain();
          const traceCID = await uploadExecutionTrace({
            action:         'WITHDRAW',
            userId:         user.userId,
            userAddress:    user.policy.userAddress!,
            receiptHash:    record.receiptHash,
            arbitrumTxHash: record.txHash ?? '0x',
            timestamp:      Date.now(),
            amountUSD:      Number(idleUSDC) / 1e6,
          });
          const anchor = await anchorExecutionProof({
            receiptHash: record.receiptHash,
            userAddress: user.policy.userAddress!,
            action:      'WITHDRAW',
            traceCID:    traceCID ?? '',
            attestCID:   '',
          });
          if (anchor) {
            getJournal().updateExecution(user.userId, record.receiptHash, {
              zgTraceCID:      traceCID ?? undefined,
              zgChainTxHash:   anchor.txHash,
              zgChainExplorer: anchor.explorerUrl,
            });
            console.log(`[Withdraw] ✅ 0G proof anchored: ${anchor.explorerUrl}`);
          }
        } catch (e: any) {
          console.warn('[Withdraw] 0G proof trail failed (non-fatal):', e.message?.slice(0, 80));
        }
      })();

      return {
        userId:             user.userId,
        status:             'READY_FOR_USER_WITHDRAW',
        idleUSDCRaw:        idleUSDC.toString(),
        idleUSDC:           Number(idleUSDC) / 1e6,
        isSmartAccount:     isV2User,
        smartAccountAddress: user.policy.smartAccountAddress,
        vaultAddress:       process.env.VAULT_ADDRESS,
        asset:              TOKEN_ADDRESSES.USDC,
        userAddress:        user.policy.userAddress,
        nextStep:           isV2User
          ? `${Number(idleUSDC) / 1e6} USDC is now in your smart account ${user.policy.smartAccountAddress}`
          : `Call vault.withdraw(USDC, ${idleUSDC.toString()}) from your wallet to receive funds.`,
        txs,
      };
    } catch (err: any) {
      registry.update(user.userId, { phase: user.portfolio ? 'MONITORING' : 'IDLE' });
      userLog(user.userId, 'ERROR', `Withdrawal preparation failed: ${err.message}`);
      pushState();
      throw err;
    }
  });

  // Pause: freeze agent management for a user without closing their position.
  setPauseCallback((target) => {
    const user = requireUniqueStrategyTarget(target);
    registry.update(user.userId, { phase: 'PAUSED' });
    userLog(user.userId, 'WARN', 'Agent paused by user request — position held open, no new actions');
    pushState();
    store.save(user.userId, registry.get(user.userId)!);
    return true;
  });

  // Resume: re-enable management for a user who self-paused.
  setResumeCallback((target) => {
    const user = requireUniqueStrategyTarget(target);
    const nextPhase = user.portfolio && user.portfolio.positions.length > 0 ? 'MONITORING' : 'IDLE';
    registry.update(user.userId, { phase: nextPhase });
    userLog(user.userId, 'SUCCESS', `Agent resumed by user request — phase=${nextPhase}`);
    pushState();
    store.save(user.userId, registry.get(user.userId)!);
    return true;
  });

  // Force migrate to a specific pool — used by testV2Rebalance.ts
  setForceMigrateCallback(async (userId: string, targetPoolAddress: string) => {
    const user = registry.get(userId);
    if (!user) return false;
    // Find the target opportunity by address
    const opp = agentState.opportunities.find(
      o => o.address?.toLowerCase() === targetPoolAddress.toLowerCase(),
    );
    if (!opp) {
      userLog(userId, 'WARN', `force-migrate: pool ${targetPoolAddress} not in opportunity list`);
      return false;
    }
    // Set the forced target ID so the next tick triggers MIGRATE to this specific pool
    registry.update(userId, {
      policy: { ...user.policy, forceMigrateTargetId: opp.id },
    });
    userLog(userId, 'INFO', `force-migrate: targeted ${opp.pool} → will execute on next tick`);
    pushState();
    return true;
  });

  // Patch user policy fields — used by testV2Rebalance.ts
  setPatchPolicyCallback((userId: string, patch: { migrationThresholdPct?: number }) => {
    const user = registry.get(userId);
    if (!user) return false;
    registry.update(userId, { policy: { ...user.policy, ...patch } });
    userLog(userId, 'INFO', `patch-policy: ${JSON.stringify(patch)}`);
    pushState();
    return true;
  });

  // Resolve and print the agent address at startup.
  // With PIMLICO_API_KEY: prints the ERC-4337 smart account address.
  // Without: prints the EOA address of AGENT_PRIVATE_KEY.
  // CRITICAL: this address must match authorizedAgent in the vault contract.
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

  // In production, demo users (Alice/Bob/Carol) are skipped — only real users run.
  const isProduction = process.env.AGENT_ENVIRONMENT === 'production';
  const demoPoliciesToLoad = isProduction ? [] : DEMO_POLICIES;

  const activeRealUserIds = store.getActiveUserIds();
  console.log(`  🔍  Found ${activeRealUserIds.length} active real user IDs in index:`, activeRealUserIds);
  const allIds      = [...demoPoliciesToLoad.map(p => p.id), ...activeRealUserIds];
  const persisted   = await store.loadAll(allIds);
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

  // Restore real users — their full portfolio state (positions, tokenIds, PnL history) survives restart
  // Skip WITHDRAWN users — they have no active position and should not re-enter the tick loop.
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

      // V2: re-wire delegation into executor on boot (delegations stored in policy survive persistence)
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

  console.log('');
  pushState();

  await tick().catch((err: Error) => {
    globalLog('ERROR', `First tick failed: ${err.message}`);
    console.error('[Orchestrator] First tick error:', err);
  });

  setInterval(async () => {
    try { agentState.block = await provider.getBlockNumber(); } catch { /* keep last */ }
    await tick().catch((err: Error) => {
      globalLog('ERROR', `Tick failed: ${err.message}`);
    });
  }, TICK_MS);
}

main().catch(err => {
  console.error('[Orchestrator] Fatal boot error:', err);
  process.exit(1);
});
