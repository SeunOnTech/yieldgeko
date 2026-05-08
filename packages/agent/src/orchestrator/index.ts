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
import { broadcast, setLatestState, startSSEServer, setRegisterCallback } from './sse';
import { OnChainProvider }                                   from './protocols';
import { PersistenceStore }                                  from './persistence';
import { UserRegistry, DEMO_POLICIES }                       from './users';
import { openPortfolio, planAllocation, buildPnLPoint }      from './portfolio';
import { evaluatePortfolioHarvests }                         from './compounder';
import { getExecutor, TOKEN_ADDRESSES }                       from './execution';
import type { ExecutionInput, OnChainExecutionResult }        from './execution';

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
  const e = mkEntry(level, message, detail);
  agentState.globalLog = [e, ...agentState.globalLog].slice(0, MAX_LOG);
  broadcast({ type: 'LOG', ts: Date.now(), payload: { userId: '__global__', entry: e } });
}

function userLog(userId: string, level: LogEntry['level'], message: string, detail?: string): void {
  const e    = mkEntry(level, message, detail);
  const user = registry.get(userId);
  if (user) registry.update(userId, { log: [e, ...user.log].slice(0, MAX_LOG) });
  broadcast({ type: 'LOG', ts: Date.now(), payload: { userId, entry: e } });
}

function pushState(): void {
  agentState.users = registry.toRecord();
  setLatestState({ ...agentState });
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
      // Funded with USDC as short token. Market address must be known from on-chain snapshot.
      return isEvmAddress(opp.address);

    case 'DELTA_NEUTRAL':
      // Token-agnostic deposit: reads pool token0/token1 at execution time.
      // Universe filter already guarantees USDC-paired pool (sym.includes('USDC')).
      // Pool address must be a valid EVM address from DeFiLlama.
      return isEvmAddress(opp.address) && symbol.includes('USDC');

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
  opportunity: Opportunity,
  policy:      UserState['policy'],
  currentPrice?: number,
): ExecutionInput {
  if (!policy.userAddress) throw new Error('Real execution requires userAddress');
  if (!resolvesToLiveUSDCExecution(opportunity)) {
    throw new Error(`${opportunity.strategyType} ${opportunity.pool} is not enabled for live USDC execution`);
  }

  return {
    strategyType:  opportunity.strategyType,
    asset:         TOKEN_ADDRESSES.USDC,
    amount:        BigInt(Math.round(policy.managedUSD * 1e6)),
    amountUSD:     policy.managedUSD,
    userAddress:   policy.userAddress,
    marketAddress: opportunity.address,
    currentPrice,
    tokenPrices:   onChain.getPrices(),   // full Chainlink price map for any token pair
    assertedAPY:   Math.round((opportunity.netAPY ?? 0) * 100),
  };
}

function patchFromExecutionResult(result: OnChainExecutionResult): Partial<PortfolioPosition> {
  const patch: Partial<PortfolioPosition> = { simulated: false };
  if (result.uniV3TokenId)        patch.uniV3TokenId        = result.uniV3TokenId.toString();
  if (result.uniV3Liquidity)      patch.uniV3Liquidity      = result.uniV3Liquidity.toString();
  if (result.gmxOrderKey)         patch.gmxOrderKey         = result.gmxOrderKey;
  // On-chain state for position-reader.ts — stored as decimal strings to survive JSON serialisation
  if (result.entryLiquidityIndex) patch.entryLiquidityIndex = result.entryLiquidityIndex.toString();
  if (result.morphoShares)        patch.morphoShares        = result.morphoShares.toString();
  if (result.pendleLpAmount)      patch.pendleLpAmount      = result.pendleLpAmount.toString();
  return patch;
}

// ── Per-user tick ─────────────────────────────────────────────────────────────

async function tickUser(user: UserState, elapsed: number, ocSnapshot: any): Promise<void> {
  const { userId, policy } = user;

  // ── Universe engine ──────────────────────────────────────────────────────
  let opportunities: Opportunity[] = agentState.opportunities;
  try {
    const result  = await fetchUniverse(provider, policy.riskTier, ocSnapshot);
    opportunities = result.opportunities;
    agentState.opportunities = opportunities;

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
    const updatedPortfolio = (policy.isReal && policy.userAddress && VAULT_ADDRESS)
      ? await updatePortfolioPositionsReal(
          currentUser.portfolio, opportunities, elapsed, prices, provider, VAULT_ADDRESS,
        )
      : updatePortfolioPositions(
          currentUser.portfolio, opportunities, elapsed, prices,
        );

    registry.update(userId, {
      portfolio:  updatedPortfolio,
      pnlHistory: [...currentUser.pnlHistory, buildPnLPoint(updatedPortfolio)].slice(-MAX_PNL),
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

        const shouldReport = pctChange >= 0.005      // >0.5% value change
          || ticksSinceLast >= 30                     // every 30 ticks (~30 min)
          || lastReported === 0;                      // first report ever

        if (shouldReport) {
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

  // ── Circuit breakers ─────────────────────────────────────────────────────
  const latestUser = registry.get(userId)!;
  const breakers: CircuitBreaker[] = checkCircuitBreakers(latestUser.portfolio, opportunities, policy);
  registry.update(userId, { breakers });
  broadcast({ type: 'BREAKERS', ts: Date.now(), payload: { userId, breakers } });

  const redFlag = hasRedBreaker(breakers);
  if (redFlag) userLog(userId, 'WARN', `⚠ Circuit breaker RED — ${breakers.find(b => b.status === 'RED')?.name}`);

  // ── Allocation decision ──────────────────────────────────────────────────
  const freshUser = registry.get(userId)!;
  const decisionOpportunities = policy.isReal
    ? filterLiveExecutableOpportunities(opportunities, userId)
    : opportunities;
  const decision = decideAllocation(decisionOpportunities, policy, freshUser.portfolio, redFlag);
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

      if (!safety.passed) {
        userLog(userId, 'WARN', `Safety gate FAILED — ${safety.abortReason}`);
        registry.setPhase(userId, freshUser.portfolio ? 'MONITORING' : 'IDLE');
      } else {
        userLog(userId, 'SUCCESS', 'Safety gate PASSED — executing');

        const prevUser   = registry.get(userId)!;
        const prevPortVal = prevUser.portfolio?.metrics.totalValueUSD ?? 0;
        const fromDesc   = prevUser.portfolio
          ? prevUser.portfolio.positions.map(p => p.venueName).join(' + ')
          : null;

        const record = buildExecutionRecord(decision.action, fromDesc, `${target.protocol} ${target.pool}`, policy.managedUSD, prevPortVal);

        // ── Real on-chain execution (real users only) ──────────────────────
        // Stores on-chain return data (UniV3 tokenId, GMX order key) back
        // into the position so future collect/withdraw calls work correctly.
        let onChainPositionPatch: Partial<import('./types').PortfolioPosition> = {};
        let realExecutionSucceeded = !policy.isReal;

        if (policy.isReal && policy.userAddress) {
          const executor = getExecutor();
          if (executor) {
            try {
              const currentPrice = onChain.getPrices().get('WETH')?.priceUSD;
              const toInput = buildLiveExecutionInput(target, policy, currentPrice);

              const fromPos  = prevUser.portfolio?.positions[0];
              const result = ((decision.action === 'MIGRATE' || decision.action === 'SAFETY_EXIT') && prevUser.portfolio && fromPos)
                ? await executor.migrate(
                    {
                      strategyType:  fromPos.strategyType,
                      asset:         TOKEN_ADDRESSES.USDC,
                      amount:        BigInt(Math.round(policy.managedUSD * 1e6)),
                      amountUSD:     policy.managedUSD,
                      userAddress:   policy.userAddress,
                      marketAddress: fromPos.venueAddress ?? fromPos.venueId,
                      tokenId:       fromPos.uniV3TokenId   ? BigInt(fromPos.uniV3TokenId)   : undefined,
                      liquidity:     fromPos.uniV3Liquidity ? BigInt(fromPos.uniV3Liquidity) : undefined,
                      hedgeSizeUSD:  fromPos.hedgeSizeUSD,
                      maturityDate:  fromPos.maturityDate,   // Pendle: determines pre/post maturity exit path
                      ytAddress:     fromPos.ytAddress,
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
              // NOTE: No fee collected here — funds just deployed, yield not yet accrued.
              // Fees are collected after executeWithdraw (when yield lands as idle balance).
            } catch (err: any) {
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
          // Demo mode can show the full multi-position plan. Real USDC users are
          // opened as a single live position matching the exact successful tx above.
          const validOpps = policy.isReal
            ? [target]
            : opportunities.filter(o => o.netAPY >= policy.minAPY * 0.8);
          const plan = policy.isReal
            ? {
                allocations: [{ opportunity: target, allocationPct: 100, allocationUSD: policy.managedUSD }],
                totalPct:    100,
                warnings:    [],
              }
            : planAllocation(validOpps, policy);
          newPortfolio = openPortfolio(plan, policy);

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

          registry.update(userId, {
            portfolio:  newPortfolio,
            executions: [record, ...prevUser.executions].slice(0, MAX_EXEC),
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
      userLog(userId, 'SUCCESS', `HARVEST: ${h.reason}`);
      const record = buildExecutionRecord('HARVEST', freshUser.portfolio.positions[0]?.venueName ?? null, 'compound', h.pendingRewardsUSD);

      // Fix 3: Real UniV3 fee collection for DELTA_NEUTRAL positions
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

      registry.update(userId, {
        executions: [record, ...freshUser.executions].slice(0, MAX_EXEC),
      });
      broadcast({ type: 'HARVEST', ts: Date.now(), payload: { userId, harvest: h } });
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
  } catch (err: any) {
    globalLog('WARN', 'On-chain snapshot failed — using last known state', err.message);
  }

  // Process each user in parallel with full isolation
  await Promise.allSettled(
    registry.all().map(async user => {
      const u = registry.get(user.userId)!;
      if (u.tickErrors >= MAX_ERRORS) {
        userLog(user.userId, 'WARN', `Quarantined after ${u.tickErrors} consecutive errors — skipping`);
        return;
      }

      const result = await withTimeout(tickUser(user, elapsed, ocSnapshot), TICK_TIMEOUT);
      if (result === null) {
        const errs = registry.incrementErrors(user.userId);
        userLog(user.userId, 'ERROR', `Tick timeout after ${TICK_TIMEOUT / 1_000}s (${errs}/${MAX_ERRORS})`);
      } else {
        registry.resetErrors(user.userId);
      }
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
    `  Users:    ${DEMO_POLICIES.length} demo users`,
    '',
  ].join('\n'));

  startSSEServer();

  provider = new JsonRpcProvider(RPC_URL, 42161, { staticNetwork: true, batchMaxCount: 50 });
  onChain  = new OnChainProvider(provider);
  store    = new PersistenceStore();
  registry = new UserRegistry();

  // Wire real-user registration — called by POST /api/register from the frontend.
  // Demo users (Alice/Bob/Carol) keep running alongside any real users who sign in.
  setRegisterCallback((policy) => {
    const state = registry.registerReal(policy);
    globalLog('SUCCESS', `Real user registered: ${policy.displayName} (${policy.userAddress})`);
    store.save(policy.id, state);   // persist immediately
    pushState();                     // broadcast to frontend
    return state;
  });

  try {
    agentState.block = await provider.getBlockNumber();
    console.log(`  ✅  Arbitrum — block #${agentState.block.toLocaleString()}\n`);
    globalLog('SUCCESS', `Arbitrum connected — block #${agentState.block.toLocaleString()}`);
  } catch {
    console.log('  ⚠️   RPC unavailable\n');
    globalLog('WARN', 'RPC unavailable — on-chain verification disabled');
  }

  console.log('  Restoring persisted user states...');
  const persisted = await store.loadAll(DEMO_POLICIES.map(p => p.id));

  for (const policy of DEMO_POLICIES) {
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
