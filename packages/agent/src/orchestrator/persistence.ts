import * as fs   from 'node:fs';
import * as path from 'node:path';
import { Wallet, JsonRpcProvider, NonceManager } from 'ethers';
import PQueue from 'p-queue';
import type { UserState } from './types';

// ── Persistence layer ─────────────────────────────────────────────────────────
//
//  Two backends, selected automatically:
//
//    0G Storage (production)
//      Requires: INDEXER_URL, RPC_URL, PRIVATE_KEY, AGENT_STATE_ENCRYPTION_KEY_B64
//      State is encrypted and stored on 0G decentralised storage.
//      CID written to .state/{userId}.cid for next-boot restore.
//
//      Architecture:
//        · Saves are NON-BLOCKING — queued in a sequential background queue
//        · A single NonceManager signer handles all concurrent saves without
//          nonce collisions (identical to how LedgerLogger works)
//        · finalityRequired: false for speed — CID is written immediately,
//          data is available on the network within seconds
//        · On restore: reads CID from disk → fetches from 0G → decrypts
//
//    Local filesystem fallback (dev — when 0G env vars absent)
//        · Writes to .state/{userId}.json — no encryption
//        · Instant, synchronous, no external dependency
//
//  In BOTH modes: a failed save never throws or crashes the agent.
// ─────────────────────────────────────────────────────────────────────────────

const STATE_DIR = path.resolve(process.cwd(), '.state');
const SCHEMA    = 'yieldgeko.orchestrator.user-state.v1';

function ensureStateDir(): void {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

// ── Serialisation ─────────────────────────────────────────────────────────────

function serialise(state: UserState): string {
  return JSON.stringify(state, (_k, v) =>
    typeof v === 'bigint' ? { __bigint__: v.toString() } : v
  );
}

function deserialise(raw: string): UserState {
  return JSON.parse(raw, (_k, v) => {
    if (v && typeof v === 'object' && '__bigint__' in v) return BigInt(v.__bigint__);
    return v;
  }) as UserState;
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function safeId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9-_]/g, '_');
}

function localPath(userId: string): string {
  return path.join(STATE_DIR, `${safeId(userId)}.json`);
}

function cidPath(userId: string): string {
  return path.join(STATE_DIR, `${safeId(userId)}.cid`);
}

// ── Local FS backend ──────────────────────────────────────────────────────────

function saveLocal(userId: string, state: UserState): void {
  try {
    ensureStateDir();
    fs.writeFileSync(localPath(userId), serialise(state), 'utf8');
  } catch (err: any) {
    console.warn(`[Persist] Local save failed (${userId}):`, err.message);
  }
}

function loadLocal(userId: string): UserState | null {
  try {
    const p = localPath(userId);
    if (!fs.existsSync(p)) return null;
    return deserialise(fs.readFileSync(p, 'utf8'));
  } catch (err: any) {
    console.warn(`[Persist] Local load failed (${userId}):`, err.message);
    return null;
  }
}

// ── 0G Storage backend ────────────────────────────────────────────────────────

interface ZeroGConfig {
  indexerUrl:       string;
  evmRpcUrl:        string;
  signer:           NonceManager;   // NonceManager prevents concurrent nonce collisions
  encryptionKeyB64: string;
}

// Background queue: sequential uploads, no nonce conflicts, non-blocking for callers
const uploadQueue = new PQueue({ concurrency: 1 });

async function upload0G(userId: string, state: UserState, cfg: ZeroGConfig): Promise<void> {
  const { persistEncryptedJsonArtifact } = await import('../storage/persist');

  // Suppress 0G SDK verbose logs during upload
  const origLog   = console.log;
  const origInfo  = console.info;
  console.log  = () => {};
  console.info = () => {};

  try {
    const payload  = JSON.parse(serialise(state));   // bigints → serialisable form
    const artifact = await persistEncryptedJsonArtifact(
      SCHEMA,
      payload,
      cfg.encryptionKeyB64,
      {
        indexerUrl: cfg.indexerUrl,
        evmRpcUrl:  cfg.evmRpcUrl,
        signer:     cfg.signer,
      },
    );

    ensureStateDir();
    fs.writeFileSync(cidPath(userId), artifact.cid, 'utf8');
    console.log  = origLog;
    console.info = origInfo;
    origLog(`[Persist] ✅ 0G saved: ${userId} — CID ${artifact.cid.slice(0, 14)}...`);
  } catch (err: any) {
    console.log  = origLog;
    console.info = origInfo;
    origLog(`[Persist] ⚠  0G upload failed (${userId}), using local fallback: ${err.message}`);
    saveLocal(userId, state);
  }
}

async function restore0G(userId: string, cfg: ZeroGConfig): Promise<UserState | null> {
  const cidFile = cidPath(userId);
  if (!fs.existsSync(cidFile)) return null;

  const cid = fs.readFileSync(cidFile, 'utf8').trim();
  if (!cid) return null;

  try {
    const { restoreEncryptedJsonArtifact } = await import('../storage/persist');
    const raw = await restoreEncryptedJsonArtifact<Record<string, unknown>>(
      cid,
      SCHEMA,
      cfg.encryptionKeyB64,
      { indexerUrl: cfg.indexerUrl },
    );
    return deserialise(JSON.stringify(raw));
  } catch (err: any) {
    console.warn(`[Persist] 0G restore failed (${userId}): ${err.message} — trying local`);
    return loadLocal(userId);
  }
}

// ── Config detection ──────────────────────────────────────────────────────────

function detect0GConfig(): ZeroGConfig | null {
  const indexerUrl       = process.env.INDEXER_URL;
  const evmRpcUrl        = process.env.RPC_URL;
  const privateKey       = process.env.PRIVATE_KEY;
  const encryptionKeyB64 = process.env.AGENT_STATE_ENCRYPTION_KEY_B64;

  if (!indexerUrl || !evmRpcUrl || !privateKey || !encryptionKeyB64) return null;

  try {
    const provider = new JsonRpcProvider(evmRpcUrl);
    const wallet   = new Wallet(privateKey, provider);
    const signer   = new NonceManager(wallet);   // handles concurrent saves without nonce conflicts
    return { indexerUrl, evmRpcUrl, signer, encryptionKeyB64 };
  } catch { return null; }
}

// ── Public API ────────────────────────────────────────────────────────────────

export class PersistenceStore {
  private cfg:  ZeroGConfig | null;
  readonly mode: '0g' | 'local';

  constructor() {
    this.cfg  = detect0GConfig();
    this.mode = this.cfg ? '0g' : 'local';
    ensureStateDir();

    console.log(
      this.mode === '0g'
        ? '[Persist] Mode: 0G Storage (encrypted, background queue)'
        : '[Persist] Mode: local filesystem (.state/) — set INDEXER_URL + PRIVATE_KEY + AGENT_STATE_ENCRYPTION_KEY_B64 for 0G Storage'
    );
  }

  // Non-blocking save — queued into background upload queue
  save(userId: string, state: UserState): void {
    if (this.cfg) {
      const cfg = this.cfg;
      uploadQueue.add(() => upload0G(userId, state, cfg));
      // Also save to local immediately as instant hot backup
      saveLocal(userId, state);
    } else {
      saveLocal(userId, state);
    }
  }

  // Blocking restore — called once at boot
  async load(userId: string): Promise<UserState | null> {
    if (this.cfg) {
      return await restore0G(userId, this.cfg);
    }
    return loadLocal(userId);
  }

  async loadAll(userIds: string[]): Promise<Map<string, UserState>> {
    const results = new Map<string, UserState>();
    await Promise.all(
      userIds.map(async id => {
        const s = await this.load(id);
        if (s) results.set(id, s);
      })
    );
    return results;
  }

  // Drain pending uploads — call before graceful shutdown
  async drain(): Promise<void> {
    await uploadQueue.onIdle();
  }

  get pendingUploads(): number {
    return uploadQueue.size + uploadQueue.pending;
  }
}
