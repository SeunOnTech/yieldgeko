import * as http from 'node:http';
import type { AgentEvent, AgentState } from './types';
import { getExecutor, resolveAgentAddress } from './execution';
import { getJournal } from './journal';


// ── SSE Server ────────────────────────────────────────────────────────────────
//
//  Runs on port 3001 within the agent process.
//  Frontend connects to http://localhost:3001/events
//
//  Endpoints:
//    GET /events  — SSE stream (text/event-stream)
//    GET /state   — Full state snapshot as JSON (for initial load)
//    GET /state/:id-or-address — Single user snapshot as JSON
//    GET /health  — {ok, clients, uptime}
// ── Utilities ─────────────────────────────────────────────────────────────────

function jsonStringify(obj: any): string {
  return JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
}

function slugify(text: string): string {
  return text
    .toString()
    .toLowerCase()
    .replace(/\s+/g, '-')           // Replace spaces with -
    .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
    .replace(/\-\-+/g, '-')         // Replace multiple - with single -
    .replace(/^-+/, '')             // Trim - from start of text
    .replace(/-+$/, '');            // Trim - from end of text
}

function randomChars(length: number): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

import type { UserPolicy } from './types';

type RegisterPayload = {
  displayName:           string;
  riskTier:              string;
  managedUSD:            number;
  minAPY:                number;
  maxSlippageBps?:       number;
  maxDrawdownPct:        number;
  maxFeeBps?:            number;
  migrationThresholdPct?: number;
  userAddress:           string;
  chainId?:              number;
  strategyId?:           string;
  smartAccountAddress?:  string;
  signedDelegation?:     {
    delegate:    string;
    delegator:   string;
    authority:   string;
    caveats:     { enforcer: string; terms: string; args: string }[];
    salt:        string;
    signature:   string;
  };
};

type PrepareV2Payload = {
  userAddress: string;
  smartAccountAddress: string;
  amount: string;
  permitSig?: string;
  permitDeadline?: string;
};

function isValidRequestedStrategyId(value: string): boolean {
  return /^0xgeko-[a-z0-9-]{3,120}$/.test(value);
}

function strategyIdOwnedByAddress(strategyId: string, userAddress: string): boolean {
  const users = latestState?.users as Record<string, UserState> | undefined;
  const existing = users?.[strategyId];
  if (!existing) return false;
  return existing.policy?.userAddress?.toLowerCase() === userAddress.toLowerCase();
}

function resolveStrategyId(payload: RegisterPayload): string {
  const requestedId = payload.strategyId?.trim().toLowerCase();
  if (requestedId) {
    if (!isValidRequestedStrategyId(requestedId)) {
      throw new Error('Invalid strategyId format');
    }
    if (isIdTakenCallback?.(requestedId) && !strategyIdOwnedByAddress(requestedId, payload.userAddress)) {
      throw new Error(`strategyId already exists: ${requestedId}`);
    }
    return requestedId;
  }

  const requestedName = payload.displayName?.split('—')[0]?.trim() || 'QUANT-PULSE';
  let baseId = `0xgeko-${slugify(requestedName)}`;
  if (!baseId.startsWith('0xgeko-')) baseId = `0xgeko-${baseId}`;

  let finalId = baseId;
  if (isIdTakenCallback && isIdTakenCallback(finalId) && !strategyIdOwnedByAddress(finalId, payload.userAddress)) {
    finalId = `${baseId}-${randomChars(5)}`;
  }
  return finalId;
}

function buildUserPolicy(payload: RegisterPayload): UserPolicy {
  const strategyId = resolveStrategyId(payload);
  const requestedName = payload.displayName?.split('—')[0]?.trim() || 'QUANT-PULSE';

  return {
    id:                    strategyId,
    displayName:           payload.displayName || `${requestedName} — ${payload.userAddress.slice(0, 8)}`,
    riskTier:              (payload.riskTier as any) || 'balanced',
    managedUSD:            payload.managedUSD,
    minAPY:                payload.minAPY ?? 8,
    maxSlippageBps:        payload.maxSlippageBps ?? 50,
    maxDrawdownPct:        payload.maxDrawdownPct ?? 10,
    maxFeeBps:             payload.maxFeeBps ?? 100,
    migrationThresholdPct: payload.migrationThresholdPct ?? 3,
    createdAt:             Date.now(),
    expiresAt:             Date.now() + 30 * 24 * 60 * 60 * 1_000,
    isReal:                true,
    userAddress:           payload.userAddress,
    chainId:               payload.chainId ?? 42161,
    ...(payload.smartAccountAddress && {
      smartAccountAddress: payload.smartAccountAddress,
      signedDelegation:    payload.signedDelegation as any,
    }),
  };
}

let SSE_PORT = Number(process.env.SSE_PORT ?? 3001);

const clients = new Set<http.ServerResponse>();
let   latestState: AgentState | null = null;
const startedAt = Date.now();

// ── Real user registration callback ──────────────────────────────────────────
//  Set by the orchestrator after UserRegistry is ready.
//  Called when POST /api/register receives a valid signed policy.

type RegisterFn = (policy: UserPolicy) => Promise<UserState>;
let registerCallback: RegisterFn | null = null;

type IsIdTakenFn = (id: string) => boolean;
let isIdTakenCallback: IsIdTakenFn | null = null;

type ResetFn = (userId: string) => Promise<boolean>;
let resetCallback: ResetFn | null = null;


import type { UserState } from './types';

type StrategyTarget = { userId?: string; userAddress?: string };

type WithdrawFn = (input: StrategyTarget) => Promise<Record<string, unknown>>;
let withdrawCallback: WithdrawFn | null = null;

type PauseFn = (target: StrategyTarget) => boolean;
let pauseCallback:  PauseFn | null = null;
let resumeCallback: PauseFn | null = null;

type ForceMigrateFn = (userId: string, targetPoolAddress: string) => Promise<boolean>;
let forceMigrateCallback: ForceMigrateFn | null = null;

type PatchPolicyFn = (userId: string, patch: { migrationThresholdPct?: number }) => boolean;
let patchPolicyCallback: PatchPolicyFn | null = null;

export function setRegisterCallback(fn: RegisterFn): void {
  registerCallback = fn;
}

export function setIsIdTakenCallback(fn: IsIdTakenFn): void {
  isIdTakenCallback = fn;
}

export function setResetCallback(fn: ResetFn): void {
  resetCallback = fn;
}

export function setWithdrawCallback(fn: WithdrawFn): void {
  withdrawCallback = fn;
}

export function setPauseCallback(fn: PauseFn): void {
  pauseCallback = fn;
}

export function setResumeCallback(fn: PauseFn): void {
  resumeCallback = fn;
}


export function setForceMigrateCallback(fn: ForceMigrateFn): void {
  forceMigrateCallback = fn;
}

export function setPatchPolicyCallback(fn: PatchPolicyFn): void {
  patchPolicyCallback = fn;
}

// ── API key auth helper ───────────────────────────────────────────────────────
//
// Fix G-5: protect sensitive endpoints with Bearer token auth.
// If AGENT_API_KEY is set, require `Authorization: Bearer <key>` on protected routes.
// If AGENT_API_KEY is not set, allow through (dev mode — no auth required).

function checkApiAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const apiKey = process.env.AGENT_API_KEY;
  if (!apiKey) return true;  // dev mode — no key configured, allow all

  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${apiKey}`) {
    const body = jsonStringify({ error: 'Unauthorized — missing or invalid Authorization: Bearer <key>' });
    res.writeHead(401, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return false;
  }
  return true;
}

// ── CORS headers ──────────────────────────────────────────────────────────────

function setCORS(res: http.ServerResponse): void {
  const origin = process.env.FRONTEND_ORIGIN ?? '*';
  res.setHeader('Access-Control-Allow-Origin',  origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cache-Control, Authorization');
  if (origin !== '*') res.setHeader('Vary', 'Origin');
}

// ── Broadcast one event to all connected clients ─────────────────────────────

export function broadcast(event: AgentEvent): void {
  const line = `data: ${jsonStringify(event)}\n\n`;
  for (const client of clients) {
    try {
      client.write(line);
    } catch {
      clients.delete(client);
    }
  }
}

// ── Store state for late-joiners ──────────────────────────────────────────────

export function setLatestState(state: AgentState): void {
  latestState = state;
}

function getUserFromState(idOrAddress: string): UserState | null {
  if (!latestState?.users) return null;
  const decoded = decodeURIComponent(idOrAddress).toLowerCase();
  const users = latestState.users as Record<string, UserState>;

  // Check the direct key (which is the userId/strategyId)
  if (users[idOrAddress]) return users[idOrAddress];
  if (users[decoded]) return users[decoded];

  return null;
}

function shouldIncludeHistory(reqUrl: string | undefined): boolean {
  if (!reqUrl) return false;
  try {
    const url = new URL(reqUrl, `http://localhost:${SSE_PORT}`);
    return url.searchParams.get('includeHistory') === 'true'
      || url.searchParams.get('history') === 'all';
  } catch {
    return false;
  }
}

function currentSessionOnly(user: UserState): UserState {
  const startedAt = user.activeSessionStartedAt ?? 0;
  const sessionId = user.activeSessionId;
  const inCurrentSession = (item: { sessionId?: string; timestamp: number }) =>
    (sessionId && item.sessionId === sessionId)
    || (!item.sessionId && item.timestamp >= startedAt);

  return {
    ...user,
    log: ((user as any).log || []).filter(inCurrentSession),
    executions: ((user as any).executions || []).filter(inCurrentSession),
  } as any;
}


function publicUserState(user: UserState, includeHistory: boolean): UserState {
  return includeHistory ? user : currentSessionOnly(user);
}

function publicAgentState(state: AgentState | null, includeHistory: boolean): AgentState | Record<string, never> {
  if (!state) return {};
  if (includeHistory) return state;

  const users = Object.fromEntries(
    Object.entries(state.users).map(([id, user]) => [id, currentSessionOnly(user)]),
  );
  return { ...state, users };
}

function choosePrimaryStrategy(strategies: UserState[]): UserState {
  return strategies.find(s => (s.portfolio?.positions?.length ?? 0) > 0)
    ?? strategies[0];
}

function chooseWalletPhase(strategies: UserState[]): UserState['phase'] {
  const phases = strategies.map(s => s.phase);
  const priority: UserState['phase'][] = [
    'WITHDRAWING',
    'MIGRATING',
    'SAFETY_EXIT',
    'MONITORING',
    'ALLOCATED',
    'SCANNING',
    'PAUSED',
    'IDLE',
    'INITIALIZING',
    'WITHDRAWN',
  ];

  for (const phase of priority) {
    if (phases.includes(phase)) return phase;
  }
  return strategies[0]?.phase ?? 'INITIALIZING';
}

function aggregatePnLHistory(strategies: UserState[]): Array<{
  ts: number;
  totalUSD: number;
  navUSD: number;
  incomeUSD: number;
  ilUSD: number;
  netUSD: number;
}> {
  if (strategies.length === 0) return [];
  if (strategies.length === 1) return (strategies[0] as any).pnlHistory ?? [];

  // 1. Collect all unique timestamps
  const allTs = new Set<number>();
  for (const s of strategies) {
    for (const p of (s as any).pnlHistory ?? []) {
      allTs.add(p.ts);
    }
  }
  const sortedTs = [...allTs].sort((a, b) => a - b);
  
  // 2. Map each strategy to its points for O(1) lookup
  const strategyPoints = strategies.map(s => {
    const map = new Map<number, any>();
    for (const p of (s as any).pnlHistory ?? []) {
      map.set(p.ts, p);
    }
    return map;
  });

  // 3. Track last known state for each strategy to carry forward
  const lastState = strategies.map(() => ({
    totalUSD: 0, navUSD: 0, incomeUSD: 0, ilUSD: 0, netUSD: 0
  }));

  const result: any[] = [];

  for (const ts of sortedTs) {
    let aggTotal = 0, aggNav = 0, aggIncome = 0, aggIl = 0, aggNet = 0;
    
    for (let i = 0; i < strategies.length; i++) {
      const p = strategyPoints[i].get(ts);
      if (p) {
        lastState[i] = {
          totalUSD: p.totalUSD ?? 0,
          navUSD: p.navUSD ?? 0,
          incomeUSD: p.incomeUSD ?? 0,
          ilUSD: p.ilUSD ?? 0,
          netUSD: p.netUSD ?? 0
        };
      }
      aggTotal += lastState[i].totalUSD;
      aggNav += lastState[i].navUSD;
      aggIncome += lastState[i].incomeUSD;
      aggIl += lastState[i].ilUSD;
      aggNet += lastState[i].netUSD;
    }

    result.push({
      ts,
      totalUSD: aggTotal,
      navUSD: aggNav,
      incomeUSD: aggIncome,
      ilUSD: aggIl,
      netUSD: aggNet
    });
  }

  return result;
}


function buildWalletDashboardProjection(strategies: UserState[], includeHistory: boolean): Record<string, unknown> | null {
  if (strategies.length === 0) return null;

  const publicStrategies = strategies.map((strategy) => publicUserState(strategy, includeHistory));
  const primary = choosePrimaryStrategy(publicStrategies);
  const totalManagedUSD = publicStrategies.reduce((sum, strategy) => sum + (strategy.policy?.managedUSD ?? 0), 0);
  const totalValueUSD = publicStrategies.reduce((sum, strategy) => sum + (strategy.portfolio?.metrics?.totalValueUSD ?? 0), 0);
  const totalEntryUSD = publicStrategies.reduce((sum, strategy) => sum + (strategy.portfolio?.metrics?.totalEntryUSD ?? 0), 0);
  const incomeEarnedUSD = publicStrategies.reduce((sum, strategy) => sum + (strategy.portfolio?.metrics?.incomeEarnedUSD ?? 0), 0);
  const totalReturnUSD = publicStrategies.reduce((sum, strategy) => sum + (strategy.portfolio?.metrics?.totalReturnUSD ?? 0), 0);
  const totalILUSD = publicStrategies.reduce((sum, strategy) => sum + (strategy.portfolio?.metrics?.totalILUSD ?? 0), 0);
  const weightedNetAPY = totalEntryUSD > 0
    ? publicStrategies.reduce((sum, strategy) => (
      sum + (strategy.portfolio?.metrics?.weightedNetAPY ?? 0) * ((strategy.portfolio?.metrics?.totalEntryUSD ?? 0) / totalEntryUSD)
    ), 0)
    : (primary.portfolio?.metrics?.weightedNetAPY ?? 0);
  const realYieldAPY = totalEntryUSD > 0
    ? publicStrategies.reduce((sum, strategy) => (
      sum + (strategy.portfolio?.metrics?.realYieldAPY ?? 0) * ((strategy.portfolio?.metrics?.totalEntryUSD ?? 0) / totalEntryUSD)
    ), 0)
    : (primary.portfolio?.metrics?.realYieldAPY ?? 0);
  const minAPY = totalManagedUSD > 0
    ? publicStrategies.reduce((sum, strategy) => sum + (strategy.policy?.minAPY ?? 0) * ((strategy.policy?.managedUSD ?? 0) / totalManagedUSD), 0)
    : (primary.policy?.minAPY ?? 0);
  const maxDrawdownPct = publicStrategies.reduce((max, strategy) => Math.max(max, strategy.policy?.maxDrawdownPct ?? 0), 0);
  const positions = publicStrategies.flatMap((strategy) => (strategy.portfolio?.positions ?? []).map((position) => ({
    ...position,
    userId: strategy.userId,
  })));
  
  const journal = getJournal();
  const executions = publicStrategies
    .flatMap((strategy) => (journal.getExecutions(strategy.userId, 20)).map((execution) => ({
      ...execution,
      userId: strategy.userId,
    })))
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .slice(0, 50);

  // For the dashboard, we take the last 200 points from the journal for each strategy
  const pnlHistory = aggregatePnLHistory(publicStrategies.map(s => ({
    ...s,
    pnlHistory: journal.getPnLHistory(s.userId, 200).reverse()
  })));

  const activeSessionStartedAt = publicStrategies.reduce((min, strategy) => (
    min === 0 ? (strategy.activeSessionStartedAt ?? 0) : Math.min(min, strategy.activeSessionStartedAt ?? min)
  ), 0);
  const smartAccounts = [...new Set(publicStrategies.map(strategy => strategy.policy?.smartAccountAddress).filter(Boolean))];

  return {
    ...primary,
    userId: primary.userId,
    phase: chooseWalletPhase(publicStrategies),
    strategyCount: publicStrategies.length,
    strategyIds: publicStrategies.map(strategy => strategy.userId),
    strategies: publicStrategies.map(strategy => ({
      userId: strategy.userId,
      displayName: strategy.policy?.displayName,
      phase: strategy.phase,
      managedUSD: strategy.policy?.managedUSD,
      metrics: strategy.portfolio?.metrics ?? null,
    })),
    activeSessionStartedAt,
    pnlHistory,
    portfolio: {
      positions,
      metrics: {
        totalValueUSD,
        totalEntryUSD,
        totalReturnUSD,
        totalReturnPct: totalEntryUSD > 0 ? (totalReturnUSD / totalEntryUSD) * 100 : 0,
        incomeEarnedUSD,
        totalILUSD,
        weightedNetAPY,
        realYieldAPY,
        peakValueUSD: publicStrategies.reduce((max, strategy) => Math.max(max, strategy.portfolio?.metrics?.peakValueUSD ?? 0), 0),
        drawdownPct: publicStrategies.reduce((max, strategy) => Math.max(max, strategy.portfolio?.metrics?.drawdownPct ?? 0), 0),
        diversificationScore: primary.portfolio?.metrics?.diversificationScore ?? 0,
        ilCoveredByFees: incomeEarnedUSD + totalILUSD >= 0,
      },
      lastRebalanceAt: Math.max(...publicStrategies.map(strategy => strategy.portfolio?.lastRebalanceAt ?? 0)),
      updatedAt: Math.max(...publicStrategies.map(strategy => strategy.portfolio?.updatedAt ?? 0)),
    },
    executions,
    policy: {
      ...primary.policy,
      displayName: publicStrategies.length > 1 ? 'Portfolio Overview' : primary.policy.displayName,
      minAPY,
      maxDrawdownPct,
      smartAccountAddress: smartAccounts.length === 1 ? smartAccounts[0] : primary.policy?.smartAccountAddress,
    },
  };
}

// ── Start server ──────────────────────────────────────────────────────────────

export function startSSEServer(): void {
  const server = http.createServer(async (req, res) => {
    setCORS(res);

    // Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Historical Logs (Infinity Architecture) ──────────────────────────────
    //  GET /api/v2/strategies/:id/logs?limit=100
    if (req.url?.startsWith('/api/v2/strategies/') && req.url.includes('/logs') && req.method === 'GET') {
      const parts = req.url.split('/');
      const strategyId = decodeURIComponent(parts[4].split('?')[0]);
      const url = new URL(req.url, `http://localhost:${SSE_PORT}`);
      const limit = Number(url.searchParams.get('limit') ?? 100);

      const logs = getJournal().getHotLogs(strategyId, limit);
      const body = jsonStringify(logs);
      res.writeHead(200, { 
        'Content-Type': 'application/json', 
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*' 
      });
      res.end(body);
      return;
    }


    // ── SSE stream ──────────────────────────────────────────────────────────
    if (req.url === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection':    'keep-alive',
        'X-Accel-Buffering': 'no',  // disable nginx buffering
      });

      // Flush immediately (important for some proxies)
      res.write(': connected\n\n');

      // Send full state immediately so the frontend renders without waiting
      if (latestState) {
        const snap: AgentEvent = { type: 'STATE_SNAPSHOT', ts: Date.now(), payload: latestState };
        res.write(`data: ${jsonStringify(snap)}\n\n`);
      }

      clients.add(res);

      // Heartbeat every 25 s to keep connection alive through proxies
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); }
        catch { clearInterval(heartbeat); clients.delete(res); }
      }, 25_000);

      req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });

      return;
    }

    // ── Full state as JSON ──────────────────────────────────────────────────
    if (req.url?.startsWith('/state') && !req.url.startsWith('/state/') && req.method === 'GET') {
      const body = jsonStringify(publicAgentState(latestState, shouldIncludeHistory(req.url)));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    // ── All strategies for a wallet address ───────────────────────────────────
    //  GET /api/strategies/:address
    //  Returns an array of all UserState entries whose policy.userAddress matches.
    //  Used by the frontend instead of fetching the full /state dump.
    if (req.url?.startsWith('/api/strategies/') && req.method === 'GET') {
      const address = decodeURIComponent(req.url.slice('/api/strategies/'.length).split('?')[0]).toLowerCase();
      if (!latestState?.users) {
        const body = jsonStringify([]);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      const users = Object.values(latestState.users as Record<string, UserState>);
      const matching = users
        .filter(u => u.policy?.userAddress?.toLowerCase() === address)
        .map(u => publicUserState(u, shouldIncludeHistory(req.url)));
      const body = jsonStringify(matching);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    // ── Wallet dashboard projection ─────────────────────────────────────────
    //  GET /api/dashboard/:address
    //  Returns a wallet-level aggregated dashboard view for all strategies
    //  owned by this EOA. Server-side projection keeps aggregation logic out
    //  of the client and gives us one stable place to evolve the view model.
    if (req.url?.startsWith('/api/dashboard/') && req.method === 'GET') {
      const address = decodeURIComponent(req.url.slice('/api/dashboard/'.length).split('?')[0]).toLowerCase();
      if (!latestState?.users) {
        const body = jsonStringify(null);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      const users = Object.values(latestState.users as Record<string, UserState>);
      const matching = users.filter(u => u.policy?.userAddress?.toLowerCase() === address);
      const projection = buildWalletDashboardProjection(matching, shouldIncludeHistory(req.url));
      const body = jsonStringify(projection);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    // ── Single user state as JSON ───────────────────────────────────────────
    if (req.url?.startsWith('/state/') && req.method === 'GET') {
      const idOrAddress = req.url.slice('/state/'.length).split('?')[0];
      const user = getUserFromState(idOrAddress);

      if (!user) {
        const body = JSON.stringify({ error: 'User not found', idOrAddress });
        res.writeHead(404, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }

      const body = jsonStringify(publicUserState(user, shouldIncludeHistory(req.url)));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    // ── Health ──────────────────────────────────────────────────────────────
    if (req.url === '/health' && req.method === 'GET') {
      let agentDelegateAddress: string | null = null;
      try {
        agentDelegateAddress = await resolveAgentAddress();
      } catch {}
      const body = jsonStringify({
        ok:      true,
        clients: clients.size,
        uptime:  Math.floor((Date.now() - startedAt) / 1000),
        port:    SSE_PORT,
        agentDelegateAddress,
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    // ── Real user registration ──────────────────────────────────────────────
    //  Called by the frontend after user signs EIP-712 policy and deposits.
    //  Demo users (Alice/Bob/Carol) keep running unchanged.
    if (req.url === '/api/register' && req.method === 'POST') {
      if (!checkApiAuth(req, res)) return;
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body) as RegisterPayload;

          if (!registerCallback) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(jsonStringify({ error: 'Agent not ready' }));
            return;
          }

          // ── Validate required fields ──────────────────────────────────────
          if (!payload.userAddress || !/^0x[a-fA-F0-9]{40}$/.test(payload.userAddress)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(jsonStringify({ error: 'Invalid or missing userAddress' }));
            return;
          }
          if (!payload.managedUSD || payload.managedUSD <= 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(jsonStringify({ error: 'managedUSD must be a positive number' }));
            return;
          }

          // ── Validate V2 delegation fields if provided ─────────────────────
          if (payload.smartAccountAddress) {
            if (!/^0x[a-fA-F0-9]{40}$/.test(payload.smartAccountAddress)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(jsonStringify({ error: 'Invalid smartAccountAddress' }));
              return;
            }
            if (!payload.signedDelegation) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(jsonStringify({ error: 'signedDelegation is required when smartAccountAddress is provided' }));
              return;
            }
            if (!payload.signedDelegation.signature || payload.signedDelegation.signature.length < 10) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(jsonStringify({ error: 'signedDelegation.signature is missing or invalid' }));
              return;
            }
          }

          const policy = buildUserPolicy(payload);

          await registerCallback(policy);

          const isV2 = !!payload.smartAccountAddress;
          const respBody = jsonStringify({
            ok:                  true,
            userId:              policy.id,
            mode:                isV2 ? 'v2-delegation' : 'v1-vault',
            smartAccountAddress: payload.smartAccountAddress ?? null,
          });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(respBody) });
          res.end(respBody);
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(jsonStringify({ error: err.message }));
        }
      });
      return;
    }

    // ── V2 smart-account preparation ───────────────────────────────────────
    //  Backend-owned sponsorship path:
    //   - optional permit + transferFrom into the smart account
    //   - executor/swapper approvals from the smart account
    //   - enforcer authorized-agent validation
    if (req.url === '/api/v2/prepare-strategy' && req.method === 'POST') {
      if (!checkApiAuth(req, res)) return;
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body) as PrepareV2Payload;
          if (!payload.userAddress || !/^0x[a-fA-F0-9]{40}$/.test(payload.userAddress)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(jsonStringify({ error: 'Invalid or missing userAddress' }));
            return;
          }
          if (!payload.smartAccountAddress || !/^0x[a-fA-F0-9]{40}$/.test(payload.smartAccountAddress)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(jsonStringify({ error: 'Invalid or missing smartAccountAddress' }));
            return;
          }
          if (!payload.amount) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(jsonStringify({ error: 'amount is required' }));
            return;
          }

          const executor = getExecutor();
          if (!executor) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(jsonStringify({ error: 'Agent executor not ready — check AGENT_PRIVATE_KEY and PIMLICO_API_KEY' }));
            return;
          }

          const result = await executor.sponsorV2Preparation({
            userAddress: payload.userAddress,
            smartAccountAddress: payload.smartAccountAddress,
            amount: BigInt(payload.amount),
            permitSig: payload.permitSig,
            permitDeadline: payload.permitDeadline ? BigInt(payload.permitDeadline) : undefined,
          });

          const respBody = jsonStringify({ ok: true, ...result });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(respBody) });
          res.end(respBody);
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(jsonStringify({ error: err.message }));
        }
      });
      return;
    }

    // ── Sponsored onboarding ────────────────────────────────────────────────────
    //  Agent submits registerPolicy + USDC.permit on behalf of user (Pimlico pays gas).
    //  Frontend then waits for the user's vault.deposit() tx to confirm before
    //  registering the strategy in the live agent.
    if (req.url === '/api/onboard' && req.method === 'POST') {
      if (!checkApiAuth(req, res)) return;
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const p = JSON.parse(body) as {
            userAddress:    string;
            displayName?:   string;
            riskTier?:      string;
            chainId?:       number;
            strategyId?:    string;
            registerWithAgent?: boolean;
            policy:         { user: string; managedUSD: string; minAPY: string; maxDrawdownBps: string; maxFeeBps: string; nonce: string; deadline: string };
            policySig:      string;
            permitSig:      string;
            permitAmount:   string;
            permitDeadline: string;
          };

          if (!p.userAddress || !/^0x[a-fA-F0-9]{40}$/.test(p.userAddress)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(jsonStringify({ error: 'Invalid or missing userAddress' }));
            return;
          }
          if (p.policy.user.toLowerCase() !== p.userAddress.toLowerCase()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(jsonStringify({ error: 'policy.user must match userAddress' }));
            return;
          }

          const executor = getExecutor();
          if (!executor) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(jsonStringify({ error: 'Agent executor not ready — check VAULT_ADDRESS and AGENT_PRIVATE_KEY' }));
            return;
          }

          const onChainPolicy = {
            user:           p.policy.user,
            managedUSD:     BigInt(p.policy.managedUSD),
            minAPY:         BigInt(p.policy.minAPY),
            maxDrawdownBps: BigInt(p.policy.maxDrawdownBps),
            maxFeeBps:      BigInt(p.policy.maxFeeBps),
            nonce:          BigInt(p.policy.nonce),
            deadline:       BigInt(p.policy.deadline),
          };

          const result = await executor.sponsorOnboarding(
            p.userAddress, onChainPolicy, p.policySig,
            p.permitSig, BigInt(p.permitAmount), BigInt(p.permitDeadline),
          );

          let registeredUserId: string | null = null;
          if (p.registerWithAgent) {
            if (!registerCallback) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(jsonStringify({ error: 'Agent not ready' }));
              return;
            }
            const agentPolicy = buildUserPolicy({
              strategyId:           p.strategyId,
              displayName:          p.displayName || `User ${p.userAddress.slice(0, 8)}`,
              riskTier:             p.riskTier || 'balanced',
              managedUSD:           Number(onChainPolicy.managedUSD) / 1e6,
              minAPY:               Number(onChainPolicy.minAPY) / 100,
              maxDrawdownPct:       Number(onChainPolicy.maxDrawdownBps) / 100,
              maxFeeBps:            Number(onChainPolicy.maxFeeBps),
              userAddress:          p.userAddress,
              chainId:              p.chainId ?? 42161,
              maxSlippageBps:       50,
              migrationThresholdPct: 3,
            });
            await registerCallback(agentPolicy);
            registeredUserId = agentPolicy.id;
          }

          const respBody = jsonStringify({
            ok: true,
            ...result,
            readyForDeposit: true,
            userId: registeredUserId,
          });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(respBody) });
          res.end(respBody);
        } catch (err: any) {
          console.error('[SSE] /api/onboard error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(jsonStringify({ error: err.message }));
        }
      });
      return;
    }

    // ── Force-reset user to IDLE (clears stale portfolio / burned positions) ──
    if (req.url?.startsWith('/api/reset-user') && req.method === 'POST') {
      if (!checkApiAuth(req, res)) return;
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const { userId } = JSON.parse(body) as { userId: string };
          if (!resetCallback) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(jsonStringify({ error: 'Agent not ready' }));
            return;
          }
          const ok = await resetCallback(userId);
          const respBody = jsonStringify({ ok, userId });
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(respBody);
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(jsonStringify({ error: err.message }));
        }
      });
      return;
    }

    // ── Force migrate to a specific pool (testing / manual override) ─────────
    if (req.url?.startsWith('/api/force-migrate') && req.method === 'POST') {
      if (!checkApiAuth(req, res)) return;
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', async () => {
        try {
          const { userId, targetPoolAddress } = JSON.parse(body) as { userId: string; targetPoolAddress: string };
          if (!forceMigrateCallback) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(jsonStringify({ error: 'Agent not ready' }));
            return;
          }
          const ok = await forceMigrateCallback(userId, targetPoolAddress);
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(jsonStringify({ ok, userId, targetPoolAddress }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(jsonStringify({ error: err.message }));
        }
      });
      return;
    }

    // ── Patch user policy fields (testing only) ───────────────────────────────
    if (req.url?.startsWith('/api/patch-policy') && req.method === 'POST') {
      if (!checkApiAuth(req, res)) return;
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        try {
          const { userId, ...patch } = JSON.parse(body) as { userId: string; migrationThresholdPct?: number };
          if (!patchPolicyCallback) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(jsonStringify({ error: 'Agent not ready' }));
            return;
          }
          const ok = patchPolicyCallback(userId, patch);
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(jsonStringify({ ok, userId, patch }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(jsonStringify({ error: err.message }));
        }
      });
      return;
    }

    // ── Prepare user withdrawal ─────────────────────────────────────────────
    //  Agent unwinds active strategy positions and normalises returned assets
    //  back to idle vault USDC. The final wallet transfer remains user-signed:
    //  user calls vault.withdraw(USDC, idleAmount).
    if (req.url?.startsWith('/api/withdraw') && req.method === 'POST') {
      if (!checkApiAuth(req, res)) return;
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          if (!withdrawCallback) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(jsonStringify({ error: 'Agent not ready' }));
            return;
          }

          const payload = body.trim() ? JSON.parse(body) as StrategyTarget : {};
          const result = await withdrawCallback(payload);
          const respBody = jsonStringify({ ok: true, ...result });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(respBody) });
          res.end(respBody);
        } catch (err: any) {
          const respBody = jsonStringify({ ok: false, error: err.message });
          res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(respBody) });
          res.end(respBody);
        }
      });
      return;
    }

    // ── Pause agent for a user (keeps position open, stops re-deployment) ──────
    if (req.url?.startsWith('/api/pause-user') && req.method === 'POST') {
      if (!checkApiAuth(req, res)) return;
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const target = JSON.parse(body) as StrategyTarget;
          const ok = pauseCallback ? pauseCallback(target) : false;
          const respBody = jsonStringify({ ok });
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(respBody);
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(jsonStringify({ error: err.message }));
        }
      });
      return;
    }

    // ── Resume agent for a user ──────────────────────────────────────────────
    if (req.url?.startsWith('/api/resume-user') && req.method === 'POST') {
      if (!checkApiAuth(req, res)) return;
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const target = JSON.parse(body) as StrategyTarget;
          const ok = resumeCallback ? resumeCallback(target) : false;
          const respBody = jsonStringify({ ok });
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(respBody);
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(jsonStringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(SSE_PORT, '0.0.0.0', () => {
    console.log(`[SSE] Server listening on http://localhost:${SSE_PORT}`);
    console.log(`[SSE] Events:  http://localhost:${SSE_PORT}/events`);
    console.log(`[SSE] Health:  http://localhost:${SSE_PORT}/health`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      const next = SSE_PORT + 1;
      console.warn(`[SSE] Port ${SSE_PORT} in use — retrying on ${next}`);
      (SSE_PORT as any) = next;
      server.listen(next, '0.0.0.0');
      return;
    }
    throw err;
  });
}
