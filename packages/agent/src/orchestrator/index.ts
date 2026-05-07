/**
 * ============================================================
 *  YIELDGEKO AGENT ORCHESTRATOR  v2.0
 * ============================================================
 *  Multi-user  · Persistent state · Error recovery
 *
 *  Per-user pipeline each tick:
 *    1. OnChainProvider  — Chainlink + Aave + GMX snapshot
 *    2. Universe engine  — DeFiLlama + on-chain ranked opportunities
 *    3. Position monitor — update NAV simulation
 *    4. Circuit breakers — live safety checks
 *    5. Allocation engine — decide action
 *    6. Safety gate      — pre-execution verification
 *    7. Execution engine — simulated tx + receipt
 *    8. Persistence      — save per-user state
 *
 *  Error recovery:
 *    · Each user's tick is isolated — one user failing doesn't affect others
 *    · Consecutive tick errors per user → quarantine after MAX_ERRORS
 *    · Process-level uncaughtException / unhandledRejection handlers
 *    · Tick timeout: abort after TICK_TIMEOUT_MS to prevent hangs
 *
 *  Persistence:
 *    · 0G Storage when INDEXER_URL + PRIVATE_KEY + encryption key present
 *    · Local .state/{userId}.json fallback for dev
 *    · State restored on boot, saved after each user tick
 * ============================================================
 */

import * as dotenv from 'dotenv';
import * as path   from 'node:path';
import * as crypto from 'node:crypto';
import { JsonRpcProvider } from 'ethers';

import type {
  AgentState, UserState, Opportunity, CircuitBreaker,
  LogEntry, PnLPoint, ExecutionRecord, Phase, EventType,
} from './types';

import { fetchUniverse }                                              from './universe';
import { decideAllocation, runSafetyGate }                          from './allocation';
import { updatePosition, checkCircuitBreakers, hasRedBreaker, buildExecutionRecord, openPosition } from './monitor';
import { broadcast, setLatestState, startSSEServer }                from './sse';
import { OnChainProvider }                                          from './protocols';
import { PersistenceStore }                                         from './persistence';
import { UserRegistry, DEMO_POLICIES }                              from './users';

// ── Env ───────────────────────────────────────────────────────────────────────

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env.local'), override: true });

const RPC_URL        = process.env.ARB_RPC_URL ?? 'https://arbitrum-one-rpc.publicnode.com';
const TICK_MS        = Number(process.env.TICK_MS        ?? 60_000);
const TICK_TIMEOUT   = Number(process.env.TICK_TIMEOUT_MS ?? 90_000);
const MAX_ERRORS     = Number(process.env.MAX_TICK_ERRORS ?? 3);
const MAX_LOG        = 80;
const MAX_PNL        = 1_440;
const MAX_EXEC       = 50;

// ── Process-level error recovery ─────────────────────────────────────────────

// Graceful shutdown — drain pending 0G uploads before exit
async function shutdown(signal: string): Promise<void> {
  console.log(`\n[Orchestrator] ${signal} received — draining ${store?.pendingUploads ?? 0} pending uploads...`);
  globalLog('WARN', `Shutdown signal: ${signal}`);
  if (store) await store.drain();
  console.log('[Orchestrator] All uploads complete. Exiting.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err: Error) => {
  console.error('[FATAL] Uncaught exception — agent continues:', err.message);
  globalLog('ERROR', `Uncaught exception: ${err.message}`, err.stack?.split('\n')[1]?.trim());
  pushGlobalLog();
});

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[FATAL] Unhandled rejection — agent continues:', msg);
  globalLog('ERROR', `Unhandled rejection: ${msg}`);
  pushGlobalLog();
});

// ── Core singletons ───────────────────────────────────────────────────────────

let provider:       JsonRpcProvider;
let onChain:        OnChainProvider;
let store:          PersistenceStore;
let registry:       UserRegistry;

// ── Global state ──────────────────────────────────────────────────────────────

let agentState: AgentState = {
  users:         {},
  opportunities: [],
  globalLog:     [],
  lastTickAt:    0,
  nextTickAt:    Date.now() + TICK_MS,
  block:         0,
  tickCount:     0,
};

// ── Global log helpers ────────────────────────────────────────────────────────

function globalLog(level: LogEntry['level'], message: string, detail?: string): void {
  const entry: LogEntry = { id: crypto.randomUUID(), timestamp: Date.now(), level, message, detail };
  agentState.globalLog = [entry, ...agentState.globalLog].slice(0, MAX_LOG);
  broadcast({ type: 'LOG', ts: Date.now(), payload: { userId: '__global__', entry } });
}

function pushGlobalLog(): void {
  setLatestState({ ...agentState });
}

// ── User log helpers ──────────────────────────────────────────────────────────

function userLog(
  userId:  string,
  level:   LogEntry['level'],
  message: string,
  detail?: string,
): void {
  const entry: LogEntry = { id: crypto.randomUUID(), timestamp: Date.now(), level, message, detail };
  const user = registry.get(userId);
  if (user) {
    registry.update(userId, {
      log: [entry, ...user.log].slice(0, MAX_LOG),
    });
  }
  broadcast({ type: 'LOG', ts: Date.now(), payload: { userId, entry } });
}

// ── Tick timeout wrapper ──────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).then(result => {
    clearTimeout(timer);
    return result as T | null;
  });
}

// ── Per-user tick ─────────────────────────────────────────────────────────────

async function tickUser(
  user:      UserState,
  elapsed:   number,
): Promise<void> {
  const { userId, policy } = user;

  // ── 1. Fetch universe (uses shared on-chain snapshot) ─────────────────────
  let opportunities: Opportunity[] = agentState.opportunities;  // start with last known

  try {
    const ocSnapshot = await onChain.fetchSnapshot();
    const result     = await fetchUniverse(provider, policy.riskTier, ocSnapshot);
    opportunities    = result.opportunities;

    // Update shared opportunities (all users share the same market scan)
    agentState.opportunities = opportunities;
    broadcast({ type: 'OPPORTUNITIES', ts: Date.now(), payload: { opportunities, count: opportunities.length } });

    const verified = opportunities.filter(o => o.verifiedOnChain).length;
    userLog(userId, 'SUCCESS',
      `Universe: ${opportunities.length} opportunities (${verified} on-chain verified)`,
      `Top: ${opportunities[0]?.protocol} ${opportunities[0]?.pool} @ ${opportunities[0]?.netAPY?.toFixed(2)}% net`,
    );
  } catch (err: any) {
    userLog(userId, 'WARN', 'Universe fetch partial — using last snapshot', err.message);
  }

  // ── 2. Update position NAV ────────────────────────────────────────────────
  const currentUser = registry.get(userId)!;

  if (currentUser.position) {
    const opp     = opportunities.find(o => o.id === currentUser.position!.venueId) ?? null;
    const newPos  = updatePosition(currentUser.position, opp, elapsed);
    const pnlPt: PnLPoint = {
      ts:        Date.now(),
      totalUSD:  newPos.currentUSD + newPos.incomeEarnedUSD,
      navUSD:    newPos.currentUSD,
      incomeUSD: newPos.incomeEarnedUSD,
    };
    registry.update(userId, {
      position:   newPos,
      pnlHistory: [...currentUser.pnlHistory, pnlPt].slice(-MAX_PNL),
    });
    broadcast({ type: 'POSITION', ts: Date.now(), payload: { userId, position: newPos } });
  }

  // ── 3. Circuit breakers ───────────────────────────────────────────────────
  const updatedUser = registry.get(userId)!;
  const currentOpp  = opportunities.find(o => o.id === updatedUser.position?.venueId) ?? null;
  const breakers: CircuitBreaker[] = checkCircuitBreakers(updatedUser.position, currentOpp, policy);
  registry.update(userId, { breakers });
  broadcast({ type: 'BREAKERS', ts: Date.now(), payload: { userId, breakers } });

  const redFlag = hasRedBreaker(breakers);
  if (redFlag && updatedUser.position) {
    userLog(userId, 'WARN', '⚠ Circuit breaker RED — evaluating safety exit');
  }

  // ── 4. Allocation engine ──────────────────────────────────────────────────
  const latestUser = registry.get(userId)!;
  const decision   = decideAllocation(opportunities, policy, latestUser.position, redFlag);
  broadcast({ type: 'ALLOCATION', ts: Date.now(), payload: { userId, decision } });

  userLog(
    userId,
    decision.action === 'HOLD' ? 'INFO' : 'WARN',
    `Allocation: ${decision.action}`,
    decision.reason,
  );

  // ── 5. Safety gate + execution ────────────────────────────────────────────
  if (decision.action !== 'HOLD' && decision.targetOpportunity) {
    registry.setPhase(userId, 'MIGRATING');
    const target = decision.targetOpportunity;
    const safety = runSafetyGate(target, policy);

    broadcast({ type: 'SAFETY', ts: Date.now(), payload: { userId, safety } });

    if (!safety.passed) {
      userLog(userId, 'WARN', `Safety gate FAILED — ${safety.abortReason}`, 'Holding current position');
      registry.setPhase(userId, latestUser.position ? 'MONITORING' : 'IDLE');
    } else {
      userLog(userId, 'SUCCESS', 'Safety gate PASSED — executing');

      const prevUser  = registry.get(userId)!;
      const fromVenue = prevUser.position
        ? `${prevUser.position.protocol} ${prevUser.position.venueName}`
        : null;

      const record: ExecutionRecord = buildExecutionRecord(
        decision.action,
        fromVenue,
        `${target.protocol} ${target.pool}`,
        policy.managedUSD,
      );

      // Open new position
      let newPos = openPosition(target, policy);
      if (prevUser.position && decision.action === 'MIGRATE') {
        newPos.incomeEarnedUSD = prevUser.position.incomeEarnedUSD;
        newPos.currentUSD      = prevUser.position.currentUSD;
        newPos.entryUSD        = prevUser.position.currentUSD;
      }

      registry.update(userId, {
        position:   newPos,
        executions: [record, ...prevUser.executions].slice(0, MAX_EXEC),
        phase:      'ALLOCATED',
      });

      broadcast({ type: 'EXECUTION', ts: Date.now(), payload: { userId, record } });
      broadcast({ type: 'POSITION',  ts: Date.now(), payload: { userId, position: newPos } });

      const label = {
        GENESIS: 'Deployed to', MIGRATE: 'Migrated to',
        SAFETY_EXIT: 'Safety exit to', HARVEST: 'Harvested', HOLD: 'Held',
      }[decision.action];

      userLog(userId, 'SUCCESS',
        `${label} ${target.protocol} ${target.pool} @ ${target.netAPY.toFixed(2)}% net APY`,
        `Receipt: ${record.receiptHash.slice(0, 18)}...`,
      );
    }
  } else {
    registry.setPhase(userId, latestUser.position ? 'MONITORING' : 'IDLE');
  }

  // ── 6. Persist user state (non-blocking — queued to background) ─────────
  const finalUser = registry.get(userId)!;
  store.save(userId, finalUser);   // fire-and-forget into PersistenceStore queue
}

// ── Main tick (all users) ─────────────────────────────────────────────────────

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

  const users = registry.all();

  // Process each user with isolation — one failure doesn't affect others
  await Promise.allSettled(
    users.map(async user => {
      const { userId } = user;

      // Skip quarantined users (too many consecutive errors)
      const currentUser = registry.get(userId)!;
      if (currentUser.tickErrors >= MAX_ERRORS) {
        userLog(userId, 'WARN',
          `User ${userId} quarantined after ${currentUser.tickErrors} errors — skipping tick`,
          `Restart the orchestrator to re-enable`,
        );
        return;
      }

      const tickWithTimeout = withTimeout(tickUser(user, elapsed), TICK_TIMEOUT);
      const result          = await tickWithTimeout;

      if (result === null) {
        // Timeout
        const errs = registry.incrementErrors(userId);
        userLog(userId, 'ERROR',
          `Tick timed out after ${TICK_TIMEOUT / 1_000}s (${errs}/${MAX_ERRORS})`,
          errs >= MAX_ERRORS ? 'User quarantined' : 'Will retry next tick',
        );
      } else {
        registry.resetErrors(userId);
      }
    })
  );

  // Update global state snapshot and broadcast
  agentState.users = registry.toRecord();
  setLatestState({ ...agentState });

  const durMs = Date.now() - tickStart;
  broadcast({
    type: 'TICK_END', ts: Date.now(),
    payload: {
      tick:       agentState.tickCount,
      durationMs: durMs,
      users:      users.map(u => {
        const s = registry.get(u.userId)!;
        return {
          userId:    u.userId,
          displayName: s.policy.displayName,
          phase:     s.phase,
          netAPY:    s.position?.currentNetAPY ?? null,
          returnPct: s.position?.totalReturnPct ?? null,
        };
      }),
    },
  });

  const pending = store?.pendingUploads ?? 0;
  globalLog('INFO',
    `Tick #${agentState.tickCount} complete in ${durMs}ms — next in ${TICK_MS / 1_000}s`,
    pending > 0 ? `0G uploads queued: ${pending}` : undefined,
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log([
    '',
    '╔══════════════════════════════════════════════════════════════╗',
    '║  YIELDGEKO AGENT ORCHESTRATOR  v2.0                         ║',
    '║  Multi-user · Persistent state · Error recovery             ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
    `  RPC:     ${RPC_URL}`,
    `  Tick:    every ${TICK_MS / 1_000}s  (timeout: ${TICK_TIMEOUT / 1_000}s)`,
    `  Users:   ${DEMO_POLICIES.length} demo users`,
    '',
  ].join('\n'));

  // Start SSE server first so frontend can connect
  startSSEServer();

  // Provider
  provider = new JsonRpcProvider(RPC_URL, 42161, { staticNetwork: true, batchMaxCount: 50 });
  onChain  = new OnChainProvider(provider);
  store    = new PersistenceStore();
  registry = new UserRegistry();

  // Connect to chain
  try {
    agentState.block = await provider.getBlockNumber();
    console.log(`  ✅  Arbitrum — block #${agentState.block.toLocaleString()}\n`);
    globalLog('SUCCESS', `Arbitrum connected at block #${agentState.block.toLocaleString()}`);
  } catch {
    console.log('  ⚠️   RPC unavailable — on-chain verification disabled\n');
    globalLog('WARN', 'RPC unavailable — on-chain verification disabled');
  }

  // Register demo users and restore persisted state
  console.log('  Restoring persisted user states...');
  const persisted = await store.loadAll(DEMO_POLICIES.map(p => p.id));

  for (const policy of DEMO_POLICIES) {
    const saved = persisted.get(policy.id);
    if (saved) {
      registry.restore(saved);
      globalLog('SUCCESS', `Restored state for ${policy.displayName}`,
        saved.position ? `Position: ${saved.position.venueName}` : 'No position',
      );
      console.log(`  ✅  Restored: ${policy.displayName}`);
    } else {
      registry.register(policy);
      globalLog('INFO', `Fresh start for ${policy.displayName}`);
      console.log(`  🆕  Fresh:    ${policy.displayName}`);
    }
  }

  console.log('');

  // Broadcast initial state
  agentState.users = registry.toRecord();
  setLatestState({ ...agentState });

  // First tick immediately
  await tick().catch((err: Error) => {
    globalLog('ERROR', `First tick failed: ${err.message}`);
    console.error('[Orchestrator] First tick error:', err);
  });

  // Recurring ticks
  setInterval(async () => {
    try { agentState.block = await provider.getBlockNumber(); } catch { /* keep last */ }
    await tick().catch((err: Error) => {
      globalLog('ERROR', `Tick failed: ${err.message}`);
      console.error('[Orchestrator] Tick error:', err);
    });
  }, TICK_MS);
}

main().catch(err => {
  console.error('[Orchestrator] Fatal boot error:', err);
  process.exit(1);
});
