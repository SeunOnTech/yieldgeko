import * as http from 'node:http';
import type { AgentEvent, AgentState } from './types';

// ── SSE Server ────────────────────────────────────────────────────────────────
//
//  Runs on port 3001 within the agent process.
//  Frontend connects to http://localhost:3001/events
//
//  Endpoints:
//    GET /events  — SSE stream (text/event-stream)
//    GET /state   — Full state snapshot as JSON (for initial load)
//    GET /health  — {ok, clients, uptime}
// ─────────────────────────────────────────────────────────────────────────────

let SSE_PORT = Number(process.env.SSE_PORT ?? 3001);

const clients = new Set<http.ServerResponse>();
let   latestState: AgentState | null = null;
const startedAt = Date.now();

// ── CORS headers for cross-origin (frontend on :3000) ─────────────────────────

function setCORS(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cache-Control');
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
    if (req.url === '/state' && req.method === 'GET') {
      const body = JSON.stringify(latestState ?? {});
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
