import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { Wallet } from 'ethers';

type ProviderEnvironment = 'development' | 'production';

type ProviderConfig = {
  environment: ProviderEnvironment;
  host: string;
  port: number;
  publicBaseUrl: string;
  modelId: string;
  displayName: string;
  signingPrivateKey: `0x${string}`;
};

type ChatCompletionRequest = {
  messages?: Array<{ role?: string; content?: string }>;
  model?: string;
};

type RoutePlanRequest = {
  userId?: string;
  strategy?: string;
  riskTier?: string;
  opportunities?: unknown[];
  currentPosition?: unknown;
};

function loadEnv(): void {
  const packageRoot = path.resolve(__dirname, '..');
  dotenv.config({ path: path.join(packageRoot, '.env') });
  dotenv.config({ path: path.join(packageRoot, '.env.local'), override: true });
}

function requireNonEmpty(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function requireHex(name: string): `0x${string}` {
  const value = requireNonEmpty(name);
  if (!/^0x[0-9a-fA-F]{64,}$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed hex string of at least 64 hex chars`);
  }
  return value as `0x${string}`;
}

function parseEnvironment(value: string | undefined): ProviderEnvironment {
  if (!value || value === 'production') return 'production';
  if (value === 'development') return 'development';
  throw new Error('PROVIDER_ENVIRONMENT must be development or production');
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('PROVIDER_PORT must be a valid TCP port');
  }
  return port;
}

function loadConfig(): ProviderConfig {
  loadEnv();
  return {
    environment: parseEnvironment(process.env.PROVIDER_ENVIRONMENT),
    host: requireNonEmpty('PROVIDER_HOST'),
    port: parsePort(requireNonEmpty('PROVIDER_PORT')),
    publicBaseUrl: requireNonEmpty('PROVIDER_PUBLIC_BASE_URL').replace(/\/$/, ''),
    modelId: requireNonEmpty('PROVIDER_MODEL_ID'),
    displayName: process.env.PROVIDER_DISPLAY_NAME?.trim() || 'YieldGeko Provider',
    signingPrivateKey: requireHex('PROVIDER_SIGNING_PRIVATE_KEY'),
  };
}

function json(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function notFound(res: ServerResponse): void {
  json(res, 404, { error: 'Not found' });
}

function methodNotAllowed(res: ServerResponse): void {
  json(res, 405, { error: 'Method not allowed' });
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function buildRecommendationText(input: string): string {
  const lowered = input.toLowerCase();

  if (lowered.includes('stable')) {
    return JSON.stringify({
      recommendation: 'allocate_to_safe_fallback_then_reassess',
      rationale: 'Stable-oriented prompt detected; preserve principal and only chase uplift above configured threshold.',
      class: 'capital_preservation',
    });
  }

  if (lowered.includes('pendle') || lowered.includes('structured')) {
    return JSON.stringify({
      recommendation: 'structured_yield_rotation',
      rationale: 'Structured-yield opportunity requested; prioritize liquid Pendle-style markets with bounded execution checks.',
      class: 'structured_yield',
    });
  }

  return JSON.stringify({
    recommendation: 'hold_and_compare_live_opportunities',
    rationale: 'No explicit strategy class detected; compare current position against verified live opportunities before migrating.',
    class: 'balanced',
  });
}

function buildRoutePlan(plan: RoutePlanRequest) {
  return {
    providerModel: config.modelId,
    generatedAt: new Date().toISOString(),
    userId: plan.userId ?? 'unknown',
    strategy: plan.strategy ?? 'unspecified',
    riskTier: plan.riskTier ?? 'balanced',
    recommendation:
      Array.isArray(plan.opportunities) && plan.opportunities.length > 0
        ? 'evaluate_top_ranked_opportunity_after_policy_checks'
        : 'no_live_opportunities_provided',
    nextAction:
      Array.isArray(plan.opportunities) && plan.opportunities.length > 0
        ? 'run pre-verification gate before route execution'
        : 'fetch live opportunities before execution',
  };
}

const config = loadConfig();
const wallet = new Wallet(config.signingPrivateKey);

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', config.publicBaseUrl);

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      service: 'yieldgeko-provider',
      environment: config.environment,
      model: config.modelId,
      displayName: config.displayName,
      publicBaseUrl: config.publicBaseUrl,
      providerSigner: wallet.address,
      verifiability: 'TeeTLS',
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = await readJsonBody<ChatCompletionRequest>(req);
    const content = Array.isArray(body.messages)
      ? body.messages.map((m) => m.content ?? '').join('\n')
      : '';
    const answer = buildRecommendationText(content);
    const signature = await wallet.signMessage(answer);

    json(res, 200, {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: config.modelId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: answer },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: estimateTokens(content),
        completion_tokens: estimateTokens(answer),
        total_tokens: estimateTokens(content) + estimateTokens(answer),
      },
      provider_signature: signature,
      provider_signer: wallet.address,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/route-plan') {
    const body = await readJsonBody<RoutePlanRequest>(req);
    const plan = buildRoutePlan(body);
    const signature = await wallet.signMessage(JSON.stringify(plan));
    json(res, 200, {
      plan,
      signature,
      signingAddress: wallet.address,
    });
    return;
  }

  if (url.pathname === '/') {
    if (req.method !== 'GET') {
      methodNotAllowed(res);
      return;
    }
    json(res, 200, {
      service: 'yieldgeko-provider',
      verifiability: 'TeeTLS',
      docs: {
        health: '/health',
        chatCompletions: '/v1/chat/completions',
        routePlan: '/v1/route-plan',
      },
    });
    return;
  }

  notFound(res);
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    json(res, 500, { error: message });
  });
});

server.listen(config.port, config.host, () => {
  console.log(`[Provider] YieldGeko provider listening on ${config.host}:${config.port}`);
  console.log(`[Provider] Public base URL: ${config.publicBaseUrl}`);
  console.log(`[Provider] Signer: ${wallet.address}`);
  console.log(`[Provider] Model: ${config.modelId}`);
  console.log(`[Provider] Verifiability: TeeTLS`);
});
