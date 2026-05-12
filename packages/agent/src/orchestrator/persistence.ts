import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dns from 'node:dns';
import { Wallet, JsonRpcProvider, NonceManager } from 'ethers';
import PQueue from 'p-queue';
import type { UserState } from './types';
import { getJournal } from './journal';


// 0G Storage nodes use IPv4 — force Node.js to prefer IPv4 over IPv6
dns.setDefaultResultOrder('ipv4first');

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
const SCHEMA = 'yieldgeko.orchestrator.user-state.v1';

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
  indexerUrl: string;
  evmRpcUrl: string;
  signer: NonceManager;   // NonceManager prevents concurrent nonce collisions
  encryptionKeyB64: string;
}

// Background queue: sequential uploads, no nonce conflicts, non-blocking for callers
const uploadQueue = new PQueue({ concurrency: 1 });

async function upload0G(userId: string, state: UserState, cfg: ZeroGConfig): Promise<void> {
  const { persistEncryptedJsonArtifact } = await import('../storage/persist');

  // Suppress 0G SDK verbose logs during upload
  const origLog = console.log;
  const origInfo = console.info;
  console.log = () => { };
  console.info = () => { };

  try {
    const payload = JSON.parse(serialise(state));   // bigints → serialisable form
    const artifact = await persistEncryptedJsonArtifact(
      SCHEMA,
      payload,
      cfg.encryptionKeyB64,
      {
        indexerUrl: cfg.indexerUrl,
        evmRpcUrl: cfg.evmRpcUrl,
        signer: cfg.signer,
      },
    );

    ensureStateDir();
    fs.writeFileSync(cidPath(userId), artifact.cid, 'utf8');
    console.log = origLog;
    console.info = origInfo;
    origLog(`[Persist] ✅ 0G saved: ${userId}`);
    origLog(`[Persist]    CID (rootHash): ${artifact.cid}`);
    origLog(`[Persist]    TX (0G Chain):  ${artifact.txHash}`);
    origLog(`[Persist]    🔗 StorageScan: https://storagescan.0g.ai/submission/${artifact.txSeq}`);
    origLog(`[Persist]    🔗 ChainScan:   https://chainscan.0g.ai/tx/${artifact.txHash}`);
  } catch (err: any) {
    console.log = origLog;
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
//
// SINGLETON: one NonceManager for the entire process lifetime.
// Every 0G Storage write (state save, trace upload, attest upload) shares it,
// so concurrent operations never collide on the same nonce.

let _0gConfigCache: ZeroGConfig | null | undefined = undefined;

export function detect0GConfig(): ZeroGConfig | null {
  if (_0gConfigCache !== undefined) return _0gConfigCache;

  const indexerUrl = process.env.INDEXER_URL;
  const evmRpcUrl = process.env.RPC_URL;
  const privateKey = process.env.PRIVATE_KEY;
  const encryptionKeyB64 = process.env.AGENT_STATE_ENCRYPTION_KEY_B64;

  if (!indexerUrl || !evmRpcUrl || !privateKey || !encryptionKeyB64) {
    _0gConfigCache = null;
    return null;
  }

  try {
    const provider = new JsonRpcProvider(evmRpcUrl);
    const wallet = new Wallet(privateKey, provider);
    const signer = new NonceManager(wallet);
    _0gConfigCache = { indexerUrl, evmRpcUrl, signer, encryptionKeyB64 };
    return _0gConfigCache;
  } catch {
    _0gConfigCache = null;
    return null;
  }
}

// ── Real-user index ───────────────────────────────────────────────────────────
// A newline-delimited file listing every real-user ID ever registered.
// Written synchronously on registration so it survives crashes immediately.
// On boot: read this file → restore all real users alongside demo users.

const LEGACY_INDEX_PATH = path.join(STATE_DIR, 'users.index');
const ACTIVE_INDEX_PATH = path.join(STATE_DIR, 'active-users.index');
const ARCHIVED_INDEX_PATH = path.join(STATE_DIR, 'archived-users.index');

function readIndex(indexPath: string): string[] {
  try {
    if (!fs.existsSync(indexPath)) return [];
    return fs.readFileSync(indexPath, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
  } catch { return []; }
}

function writeIndex(indexPath: string, userIds: string[]): void {
  fs.writeFileSync(indexPath, userIds.join('\n') + (userIds.length > 0 ? '\n' : ''), 'utf8');
}

function appendToIndex(indexPath: string, userId: string): void {
  try {
    ensureStateDir();
    const existing = readIndex(indexPath);
    if (existing.includes(userId)) return;   // idempotent
    fs.appendFileSync(indexPath, userId + '\n', 'utf8');
  } catch (err: any) {
    console.warn(`[Persist] Index append failed (${userId}):`, err.message);
  }
}

function removeFromIndex(indexPath: string, userId: string): void {
  try {
    ensureStateDir();
    if (!fs.existsSync(indexPath)) return;
    const next = readIndex(indexPath).filter(id => id !== userId);
    writeIndex(indexPath, next);
  } catch (err: any) {
    console.warn(`[Persist] Index remove failed (${userId}):`, err.message);
  }
}

// ── 0G Storage: execution trace upload ───────────────────────────────────────
//
// Uploads a plain-JSON execution trace to 0G Storage and returns the CID.
// Not encrypted (traces are public audit records by design).
// Non-fatal — returns null and warns on failure.

export async function uploadExecutionTrace(trace: {
  action: string;
  userId: string;
  userAddress: string;
  receiptHash: string;
  arbitrumTxHash: string;
  timestamp: number;
  screenerTop5?: unknown[];
  teeDecision?: unknown;
  poolAddress?: string;
  amountUSD?: number;
}): Promise<string | null> {
  const cfg = detect0GConfig();
  if (!cfg) return null;

  try {
    const { persistJsonArtifact } = await import('../storage/persist');
    const artifact = await persistJsonArtifact(trace, {
      indexerUrl: cfg.indexerUrl,
      evmRpcUrl: cfg.evmRpcUrl,
      signer: cfg.signer,
    });
    console.log(`[Persist] ✅ Trace stored on 0G (${trace.action})`);
    console.log(`[Persist]    CID (rootHash): ${artifact.cid}`);
    console.log(`[Persist]    🔗 StorageScan: https://storagescan.0g.ai/submission/${artifact.txSeq}`);
    console.log(`[Persist]    🔗 ChainScan:   https://chainscan.0g.ai/tx/${artifact.txHash}`);
    return artifact.cid;
  } catch (err: any) {
    console.warn(`[Persist] Trace upload failed: ${err.message?.slice(0, 120)}`);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export class PersistenceStore {
  private cfg: ZeroGConfig | null;
  readonly mode: '0g' | 'local';

  constructor() {
    this.cfg = detect0GConfig();
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
      // Pro-Grade: Sync journal to 0G every few saves or major events
      // For now, we'll trigger it on every save (since saves are infrequent anyway)
      uploadQueue.add(() => this.syncJournalTo0G(userId));
      // Also save to local immediately as instant hot backup
      saveLocal(userId, state);
    } else {
      saveLocal(userId, state);
    }
  }

  // Segmented Journal Sync: reads SQLite → uploads chunk to 0G → returns new CID
  async syncJournalTo0G(userId: string): Promise<string | null> {
    if (!this.cfg) return null;

    const journal = getJournal();
    const data = journal.getUnsyncedData(userId);
    
    if (data.logs.length === 0 && data.executions.length === 0 && data.pnl.length === 0) {
      return null;
    }

    try {
      const { persistJsonArtifact } = await import('../storage/persist');
      const segment = {
        userId,
        timestamp: Date.now(),
        ...data
      };

      const artifact = await persistJsonArtifact(segment, {
        indexerUrl: this.cfg.indexerUrl,
        evmRpcUrl: this.cfg.evmRpcUrl,
        signer: this.cfg.signer,
      });

      // Update SQLite checkpoint so we don't upload these again
      journal.updateCheckpoint(userId, {
        last_log_ts: data.logs.length > 0 ? Math.max(...data.logs.map(l => l.timestamp)) : undefined,
        last_exec_ts: data.executions.length > 0 ? Math.max(...data.executions.map(e => e.timestamp)) : undefined,
        last_pnl_ts: data.pnl.length > 0 ? Math.max(...data.pnl.map(p => p.ts)) : undefined,
      });

      console.log(`[Persist] ✅ Journal segment synced to 0G for ${userId} (CID: ${artifact.cid})`);
      return artifact.cid;
    } catch (err: any) {
      console.warn(`[Persist] Journal sync failed for ${userId}:`, err.message);
      return null;
    }
  }


  // Register a real user as active/runnable.
  // Removes the user from the archived set so re-registration is clean.
  registerActiveUser(userId: string): void {
    appendToIndex(ACTIVE_INDEX_PATH, userId);
    removeFromIndex(ARCHIVED_INDEX_PATH, userId);
  }

  // Backwards-compatible alias while callers migrate.
  registerInIndex(userId: string): void {
    this.registerActiveUser(userId);
  }

  // Mark a user as archived/non-runnable after withdrawal.
  // We keep their state artifacts for audit/history, but remove restore pointers.
  markUserArchived(userId: string): void {
    removeFromIndex(ACTIVE_INDEX_PATH, userId);
    removeFromIndex(LEGACY_INDEX_PATH, userId);
    appendToIndex(ARCHIVED_INDEX_PATH, userId);
  }

  // Return only runnable real-user IDs for boot restore.
  // If the new active index is not present yet, fall back to the legacy index.
  getActiveUserIds(): string[] {
    const activeExists = fs.existsSync(ACTIVE_INDEX_PATH);
    if (activeExists) return readIndex(ACTIVE_INDEX_PATH);

    const archived = new Set(readIndex(ARCHIVED_INDEX_PATH));
    return readIndex(LEGACY_INDEX_PATH).filter(id => !archived.has(id));
  }

  getArchivedUserIds(): string[] {
    return readIndex(ARCHIVED_INDEX_PATH);
  }

  // Blocking restore — called once at boot
  async load(userId: string): Promise<UserState | null> {
    console.log(`[Persist] Loading ${userId}...`);
    if (this.cfg) {
      try {
        const g0 = await restore0G(userId, this.cfg);
        if (g0) {
          console.log(`[Persist] ✅ ${userId} restored from 0G`);
          return g0;
        }
      } catch (err: any) {
        console.warn(`[Persist] 0G restore error for ${userId}:`, err.message);
      }
      console.log(`[Persist] 0G missing/failed for ${userId}, trying local...`);
    }
    const local = loadLocal(userId);
    if (local) console.log(`[Persist] ✅ ${userId} restored from local`);
    else console.warn(`[Persist] ❌ ${userId} not found locally or failed to load`);
    return local;
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
