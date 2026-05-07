import * as dotenv from 'dotenv';
import * as path from 'path';

export type AgentEnvironment = 'development' | 'production';

export interface AgentRuntimeConfig {
  environment: AgentEnvironment;
  rpcUrl: string;
  arbitrumRpcUrl: string;
  indexerUrl: string;
  privateKey: `0x${string}`;
  userId: string;
  managedAmount: bigint;
  stateEncryptionKeyBase64: string;
  queueEncryptionKeyBase64: string;
  stateCidPath: string;
  queueCidPath: string;
  allowUnattestedAgent: boolean;
  teeAttestation?: {
    mrenclave: `0x${string}`;
    raReport: string;
  };
}

let envLoaded = false;

function requireNonEmpty(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }

  return value.trim();
}

function parseAgentEnvironment(value: string | undefined): AgentEnvironment {
  if (!value || value.trim().length === 0) {
    return 'production';
  }

  if (value === 'development' || value === 'production') {
    return value;
  }

  throw new Error(`AGENT_ENVIRONMENT must be either "development" or "production"`);
}

function requireHex32(name: string): `0x${string}` {
  const value = requireNonEmpty(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte hex string`);
  }

  return value as `0x${string}`;
}

function requireBigIntEnv(name: string): bigint {
  const value = requireNonEmpty(name);

  try {
    return BigInt(value);
  } catch {
    throw new Error(`${name} must be a valid integer string`);
  }
}

function requireBase64Key(name: string): string {
  const value = requireNonEmpty(name);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32) {
    throw new Error(`${name} must decode to exactly 32 bytes`);
  }

  return value;
}

export function getConfiguredPrivateKey(): `0x${string}` {
  loadAgentEnv();
  return requireHex32('PRIVATE_KEY');
}

export function loadAgentEnv(): void {
  if (envLoaded) {
    return;
  }

  if (process.env.AGENT_SKIP_DOTENV === 'true') {
    envLoaded = true;
    return;
  }

  const packageRoot = path.resolve(__dirname, '../..');
  dotenv.config({ path: path.join(packageRoot, '.env') });
  dotenv.config({ path: path.join(packageRoot, '.env.local'), override: true });
  envLoaded = true;
}

export function resetAgentEnvForTests(): void {
  envLoaded = false;
}

export function getAgentRuntimeConfig(): AgentRuntimeConfig {
  loadAgentEnv();

  const environment = parseAgentEnvironment(process.env.AGENT_ENVIRONMENT);
  const allowUnattestedAgent = process.env.ALLOW_UNATTESTED_AGENT === 'true';

  if (allowUnattestedAgent && environment !== 'development') {
    throw new Error(
      'ALLOW_UNATTESTED_AGENT can only be enabled when AGENT_ENVIRONMENT=development'
    );
  }

  const config: AgentRuntimeConfig = {
    environment,
    rpcUrl: requireNonEmpty('RPC_URL'),
    arbitrumRpcUrl: requireNonEmpty('ZERO_G_RPC'),
    indexerUrl: requireNonEmpty('INDEXER_URL'),
    privateKey: getConfiguredPrivateKey(),
    userId: requireNonEmpty('AGENT_USER_ID'),
    managedAmount: requireBigIntEnv('AGENT_MANAGED_AMOUNT'),
    stateEncryptionKeyBase64: requireBase64Key('AGENT_STATE_ENCRYPTION_KEY_B64'),
    queueEncryptionKeyBase64: requireBase64Key('AGENT_QUEUE_ENCRYPTION_KEY_B64'),
    stateCidPath:
      process.env.AGENT_STATE_CID_PATH || path.resolve(process.cwd(), '.state/agent-state.cid'),
    queueCidPath:
      process.env.AGENT_QUEUE_CID_PATH || path.resolve(process.cwd(), '.state/agent-queue.cid'),
    allowUnattestedAgent,
  };

  if (!allowUnattestedAgent) {
    config.teeAttestation = {
      mrenclave: requireHex32('ZERO_G_TEE_MRENCLAVE'),
      raReport: requireNonEmpty('ZERO_G_TEE_RA_REPORT'),
    };
  }

  return config;
}
