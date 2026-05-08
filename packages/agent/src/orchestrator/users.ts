import type { UserPolicy, UserState, Phase } from './types';

// ── Demo user policies (replace with real EIP-712 signed intents in prod) ─────

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

// ── Fresh user state factory ───────────────────────────────────────────────────

export function createUserState(policy: UserPolicy): UserState {
  return {
    userId:     policy.id,
    policy,
    phase:      'INITIALIZING',
    portfolio:  null,
    breakers:   [],
    pnlHistory: [],
    executions: [],
    log:        [],
    updatedAt:  Date.now(),
    tickErrors: 0,
  };
}

// ── UserRegistry ──────────────────────────────────────────────────────────────
//
//  Manages all active user states in memory.
//  In production, users are added dynamically when they sign an intent.
//  In dev, DEMO_POLICIES are loaded on boot.
//
//  Provides a merge helper to preserve in-memory ephemeral fields
//  (like recent logs) when restoring from persisted state.
// ─────────────────────────────────────────────────────────────────────────────

export class UserRegistry {
  private users = new Map<string, UserState>();

  // Register a demo or pre-configured user
  register(policy: UserPolicy): UserState {
    const state = createUserState(policy);
    this.users.set(policy.id, state);
    return state;
  }

  // Register a real user who has signed an EIP-712 policy on the frontend.
  // Marks isReal=true so the orchestrator uses on-chain execution, not simulation.
  // Demo users (Alice/Bob/Carol) keep running — this only adds new real users.
  registerReal(policy: UserPolicy): UserState {
    if (this.users.has(policy.id)) {
      return this.users.get(policy.id)!;  // already registered — idempotent
    }
    const realPolicy: UserPolicy = { ...policy, isReal: true };
    const state = createUserState(realPolicy);
    this.users.set(realPolicy.id, state);
    return state;
  }

  // Restore from persisted state (called on boot)
  restore(persisted: UserState): void {
    // Merge: keep restored fields but reset ephemeral runtime state
    const merged: UserState = {
      ...persisted,
      // Fresh runtime fields — these are rebuilt each session
      log:        persisted.log.slice(0, 20),   // keep last 20 log entries
      tickErrors: 0,
      updatedAt:  Date.now(),
    };
    this.users.set(persisted.userId, merged);
  }

  get(userId: string): UserState | undefined {
    return this.users.get(userId);
  }

  getOrCreate(policy: UserPolicy): UserState {
    return this.users.get(policy.id) ?? this.register(policy);
  }

  update(userId: string, patch: Partial<UserState>): UserState | null {
    const existing = this.users.get(userId);
    if (!existing) return null;
    const next = { ...existing, ...patch, updatedAt: Date.now() };
    this.users.set(userId, next);
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

  size(): number {
    return this.users.size;
  }
}
