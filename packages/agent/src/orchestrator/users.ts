import type { UserPolicy, UserState, Phase } from './types';
import type { StoredDelegation } from './delegation-client';

const REDIS_KEY = 'ys:users';

let _redisClient: any        = undefined;   
let _redisAvailable: boolean = false;

async function getRedis(): Promise<any> {
  if (_redisClient !== undefined) return _redisAvailable ? _redisClient : null;

  const url = process.env.REDIS_URL;
  if (!url) { _redisClient = null; return null; }

  try {
    
    
    const mod = require('ioredis');
    const Redis = mod.default ?? mod;
    _redisClient = new Redis(url, {
      lazyConnect:        true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout:     2_000,
    });
    _redisClient.on('error', (err: any) =>
      console.warn('[Redis] Connection error (writes will be skipped):', err.message));
    await _redisClient.connect();
    _redisAvailable = true;
    console.log('[Redis] Connected — write-through cache active');
    return _redisClient;
  } catch (e: any) {
    _redisClient = null;
    console.warn('[Redis] Unavailable — in-memory only:', e.message,
      '\n         Install ioredis (pnpm add ioredis) and set REDIS_URL to enable.');
    return null;
  }
}

function redisSet(userId: string, state: UserState): void {
  getRedis().then(client => {
    if (!client) return;
    const json = JSON.stringify(state, (_k, v) =>
      typeof v === 'bigint' ? { __bigint__: v.toString() } : v);
    client.hset(REDIS_KEY, userId, json).catch(() => {  });
  }).catch(() => {  });
}

function redisDel(userId: string): void {
  getRedis().then(client => {
    if (!client) return;
    client.hdel(REDIS_KEY, userId).catch(() => {  });
  }).catch(() => {  });
}

export async function loadAllFromRedis(): Promise<Map<string, UserState>> {
  const result = new Map<string, UserState>();
  const client = await getRedis();
  if (!client) return result;
  try {
    const data: Record<string, string> = await client.hgetall(REDIS_KEY);
    if (!data) return result;
    for (const [userId, json] of Object.entries(data)) {
      try {
        const parsed = JSON.parse(json, (_k, v) => {
          if (v && typeof v === 'object' && '__bigint__' in v) return BigInt(v.__bigint__);
          return v;
        }) as UserState;
        result.set(userId, parsed);
      } catch {  }
    }
    if (result.size > 0) console.log(`[Redis] Loaded ${result.size} user states from cache`);
  } catch (e: any) {
    console.warn('[Redis] loadAllFromRedis failed:', e.message);
  }
  return result;
}

export const DEMO_POLICIES: UserPolicy[] = [
  {
    id:                    'dev-user-001',
    displayName:           'Alice — Balanced',
    riskTier:              'balanced',
    managedUSD:            10_000,
    minAPY:                8,
    maxSlippageBps:        50,
    maxDrawdownPct:        10,
    maxFeeBps:             100,
    migrationThresholdPct: 3,
    createdAt:             Date.now(),
    expiresAt:             Date.now() + 30 * 24 * 60 * 60 * 1_000,
  },
  {
    id:                    'dev-user-002',
    displayName:           'Bob — Conservative',
    riskTier:              'conservative',
    managedUSD:            5_000,
    minAPY:                5,
    maxSlippageBps:        25,
    maxDrawdownPct:        5,
    maxFeeBps:             50,
    migrationThresholdPct: 2,
    createdAt:             Date.now(),
    expiresAt:             Date.now() + 30 * 24 * 60 * 60 * 1_000,
  },
  {
    id:                    'dev-user-003',
    displayName:           'Carol — Aggressive',
    riskTier:              'aggressive',
    managedUSD:            25_000,
    minAPY:                12,
    maxSlippageBps:        100,
    maxDrawdownPct:        20,
    maxFeeBps:             200,
    migrationThresholdPct: 5,
    createdAt:             Date.now(),
    expiresAt:             Date.now() + 30 * 24 * 60 * 60 * 1_000,
  },
];

export function createUserState(policy: UserPolicy, userAddress: string): UserState {
  const now = Date.now();
  return {
    userId:     policy.id,
    userAddress,
    policy,
    phase:      'INITIALIZING',
    portfolio:  null,
    breakers:   [],
    activeSessionId:        `session-${now}`,
    activeSessionStartedAt: now,
    updatedAt:  now,
    tickErrors: 0,
    isDirty:    true,
    lastPersistedAt: now,
  };
}

export class UserRegistry {
  private users = new Map<string, UserState>();

  
  register(policy: UserPolicy, userAddress?: string): UserState {
    const addr = userAddress || policy.userAddress || '0x0000000000000000000000000000000000000000';
    const state = createUserState(policy, addr);
    this.users.set(policy.id, state);
    redisSet(policy.id, state);
    return state;
  }

  
  registerReal(policy: UserPolicy, userAddress: string): UserState {
    if (this.users.has(policy.id)) {
      return this.users.get(policy.id)!;
    }
    const realPolicy: UserPolicy = { ...policy, isReal: true, userAddress };
    const state = createUserState(realPolicy, userAddress);
    this.users.set(realPolicy.id, state);
    redisSet(realPolicy.id, state);
    return state;
  }

  
  registerV2(
    policy:           UserPolicy,
    smartAccountAddr: string,
    delegation:       StoredDelegation,
  ): UserState {
    if (this.users.has(policy.id)) {
      const updatedPolicy: UserPolicy = {
        ...policy,
        smartAccountAddress: smartAccountAddr,
        signedDelegation:    delegation,
        isReal:              true,
      };
      const updated = this.update(policy.id, { policy: updatedPolicy }) ?? this.users.get(policy.id)!;
      redisSet(policy.id, updated);
      return updated;
    }
    const v2Policy: UserPolicy = {
      ...policy,
      isReal:              true,
      smartAccountAddress: smartAccountAddr,
      signedDelegation:    delegation,
    };
    const state = createUserState(v2Policy, smartAccountAddr);
    this.users.set(v2Policy.id, state);
    redisSet(v2Policy.id, state);
    return state;
  }

  
  restore(persisted: UserState): void {
    const merged: UserState = {
      ...persisted,
      activeSessionId:        persisted.activeSessionId ?? `session-${Date.now()}`,
      activeSessionStartedAt: persisted.activeSessionStartedAt ?? Date.now(),
      tickErrors: 0,
      updatedAt:  Date.now(),
    };
    this.users.set(persisted.userId, merged);
    redisSet(persisted.userId, merged);
  }

  get(userId: string): UserState | undefined {
    return this.users.get(userId);
  }

  getOrCreate(policy: UserPolicy): UserState {
    return this.users.get(policy.id) ?? this.register(policy);
  }

  update(userId: string, patch: Partial<UserState>, forceDirty: boolean = false): UserState | null {
    const existing = this.users.get(userId);
    if (!existing) return null;

    
    
    let isDirty = existing.isDirty || forceDirty;
    
    if (!isDirty && patch.portfolio && existing.portfolio) {
      const oldVal = existing.portfolio.metrics.totalValueUSD;
      const newVal = patch.portfolio.metrics.totalValueUSD;
      const pctChange = oldVal > 0 ? Math.abs(newVal - oldVal) / oldVal : 1;
      if (pctChange >= 0.005) isDirty = true; 
    }

    if (!isDirty && patch.phase && patch.phase !== existing.phase) isDirty = true;
    if (!isDirty && patch.policy) isDirty = true;

    
    const hourMs = 60 * 60 * 1000;
    const lastSaved = existing.lastPersistedAt ?? 0;
    if (!isDirty && (Date.now() - lastSaved) > hourMs) isDirty = true;

    const next = { ...existing, ...patch, updatedAt: Date.now(), isDirty };
    this.users.set(userId, next);
    if (isDirty) redisSet(userId, next);   
    return next;
  }

  setPhase(userId: string, phase: Phase): void {
    this.update(userId, { phase });
  }

  incrementErrors(userId: string): number {
    const u = this.users.get(userId);
    if (!u) return 0;
    const errors = u.tickErrors + 1;
    this.update(userId, { tickErrors: errors });
    return errors;
  }

  resetErrors(userId: string): void {
    this.update(userId, { tickErrors: 0 });
  }

  all(): UserState[] {
    return [...this.users.values()];
  }

  ids(): string[] {
    return [...this.users.keys()];
  }

  toRecord(): Record<string, UserState> {
    const record: Record<string, UserState> = {};
    for (const [id, state] of this.users) record[id] = state;
    return record;
  }

  
  
  deregister(userId: string): boolean {
    redisDel(userId);
    return this.users.delete(userId);
  }

  size(): number {
    return this.users.size;
  }
}
