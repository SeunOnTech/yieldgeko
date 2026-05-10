import * as http from 'node:http';
import type { AgentEvent, AgentState } from './types';
import { getExecutor } from './execution';

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
// ─────────────────────────────────────────────────────────────────────────────

import type { UserPolicy } from './types';

let SSE_PORT = Number(process.env.SSE_PORT ?? 3001);

const clients = new Set<http.ServerResponse>();
let   latestState: AgentState | null = null;
const startedAt = Date.now();

// ── Real user registration callback ──────────────────────────────────────────
//  Set by the orchestrator after UserRegistry is ready.
//  Called when POST /api/register receives a valid signed policy.

type RegisterFn = (policy: UserPolicy) => UserState;
let registerCallback: RegisterFn | null = null;

type ResetFn = (userId: string) => boolean;
let resetCallback: ResetFn | null = null;

import type { UserState } from './types';

type WithdrawFn = (input: { userId?: string; userAddress?: string }) => Promise<Record<string, unknown>>;
let withdrawCallback: WithdrawFn | null = null;

type PauseFn = (userAddress: string) => boolean;
let pauseCallback:  PauseFn | null = null;
let resumeCallback: PauseFn | null = null;

export function setRegisterCallback(fn: RegisterFn): void {
  registerCallback = fn;
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
    const body = JSON.stringify({ error: 'Unauthorized — missing or invalid Authorization: Bearer <key>' });
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
  const line = `data: ${JSON.stringify(event)}\n\n`;
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

  if (users[idOrAddress]) return users[idOrAddress];
  if (users[decoded]) return users[decoded];

  for (const [id, user] of Object.entries(users)) {
    const address = user.policy?.userAddress?.toLowerCase();
    if (id.toLowerCase() === decoded || address === decoded) return user;
  }

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
    log: user.log.filter(inCurrentSession),
    executions: user.executions.filter(inCurrentSession),
  };
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

// ── Start server ──────────────────────────────────────────────────────────────

export function startSSEServer(): void {
  const server = http.createServer((req, res) => {
    setCORS(res);

    // Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
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
        res.write(`data: ${JSON.stringify(snap)}\n\n`);
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
      const body = JSON.stringify(publicAgentState(latestState, shouldIncludeHistory(req.url)));
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

      const body = JSON.stringify(publicUserState(user, shouldIncludeHistory(req.url)));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    // ── Health ──────────────────────────────────────────────────────────────
    if (req.url === '/health' && req.method === 'GET') {
      const body = JSON.stringify({
        ok:      true,
        clients: clients.size,
        uptime:  Math.floor((Date.now() - startedAt) / 1000),
        port:    SSE_PORT,
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
      req.on('end', () => {
        try {
          const payload = JSON.parse(body) as {
            id:                    string;
            displayName:           string;
            riskTier:              string;
            managedUSD:            number;
            minAPY:                number;
            maxSlippageBps:        number;
            maxDrawdownPct:        number;
            maxFeeBps:             number;
            migrationThresholdPct: number;
            userAddress:           string;
            chainId?:              number;
          };

          if (!registerCallback) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Agent not ready' }));
            return;
          }

          // Validate required fields
          if (!payload.userAddress || !/^0x[a-fA-F0-9]{40}$/.test(payload.userAddress)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid or missing userAddress (must be a valid EVM address)' }));
            return;
          }
          if (!payload.managedUSD || payload.managedUSD <= 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'managedUSD must be a positive number' }));
            return;
          }

          const policy: UserPolicy = {
            id:                    payload.id || `user-${payload.userAddress.slice(2, 10).toLowerCase()}`,
            displayName:           payload.displayName || `User ${payload.userAddress.slice(0, 8)}`,
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
          };

          registerCallback(policy);

          const respBody = JSON.stringify({ ok: true, userId: policy.id });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(respBody) });
          res.end(respBody);
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ── Sponsored onboarding ────────────────────────────────────────────────────
    //  Agent submits registerPolicy + USDC.permit on behalf of user (Pimlico pays gas).
    //  User only needs to call vault.deposit() — 1 tx, ~$0.03.
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
            policy:         { user: string; managedUSD: string; minAPY: string; maxDrawdownBps: string; maxFeeBps: string; nonce: string; deadline: string };
            policySig:      string;
            permitSig:      string;
            permitAmount:   string;
            permitDeadline: string;
          };

          if (!p.userAddress || !/^0x[a-fA-F0-9]{40}$/.test(p.userAddress)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid or missing userAddress' }));
            return;
          }

          const executor = getExecutor();
          if (!executor) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Agent executor not ready — check VAULT_ADDRESS and AGENT_PRIVATE_KEY' }));
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

          // Auto-register the user in the agent so monitoring starts immediately
          // after the on-chain policy registration succeeds.
          if (registerCallback) {
            const managedUSD = Number(onChainPolicy.managedUSD) / 1e6;
            const agentPolicy: import('./types').UserPolicy = {
              id:                    `user-${p.userAddress.slice(2, 10).toLowerCase()}`,
              displayName:           p.displayName || `User ${p.userAddress.slice(0, 8)}`,
              riskTier:              (p.riskTier as any) || 'balanced',
              managedUSD,
              minAPY:                Number(onChainPolicy.minAPY) / 100,
              maxSlippageBps:        50,
              maxDrawdownPct:        Number(onChainPolicy.maxDrawdownBps) / 100,
              maxFeeBps:             Number(onChainPolicy.maxFeeBps),
              migrationThresholdPct: 3,
              createdAt:             Date.now(),
              expiresAt:             Number(onChainPolicy.deadline) * 1_000,
              isReal:                true,
              userAddress:           p.userAddress,
              chainId:               42161,
            };
            registerCallback(agentPolicy);
          }

          const respBody = JSON.stringify({ ok: true, ...result });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(respBody) });
          res.end(respBody);
        } catch (err: any) {
          console.error('[SSE] /api/onboard error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ── Force-reset user to IDLE (clears stale portfolio / burned positions) ──
    if (req.url?.startsWith('/api/reset-user') && req.method === 'POST') {
      if (!checkApiAuth(req, res)) return;
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { userId } = JSON.parse(body) as { userId: string };
          if (!resetCallback) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Agent not ready' }));
            return;
          }
          const ok = resetCallback(userId);
          const respBody = JSON.stringify({ ok, userId });
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(respBody);
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
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
            res.end(JSON.stringify({ error: 'Agent not ready' }));
            return;
          }

          const payload = body.trim() ? JSON.parse(body) as { userId?: string; userAddress?: string } : {};
          const result = await withdrawCallback(payload);
          const respBody = JSON.stringify({ ok: true, ...result });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(respBody) });
          res.end(respBody);
        } catch (err: any) {
          const respBody = JSON.stringify({ ok: false, error: err.message });
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
          const { userAddress } = JSON.parse(body) as { userAddress: string };
          const ok = pauseCallback ? pauseCallback(userAddress) : false;
          const respBody = JSON.stringify({ ok });
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(respBody);
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
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
          const { userAddress } = JSON.parse(body) as { userAddress: string };
          const ok = resumeCallback ? resumeCallback(userAddress) : false;
          const respBody = JSON.stringify({ ok });
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(respBody);
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
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
