import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dns from 'node:dns';
import { Wallet, JsonRpcProvider, NonceManager } from 'ethers';
import PQueue from 'p-queue';
import type { UserState } from './types';
import { getJournal } from './journal';

dns.setDefaultResultOrder('ipv4first');

const STATE_DIR = path.resolve(process.cwd(), '.state');
const SCHEMA = 'yieldgeko.orchestrator.user-state.v1';

function ensureStateDir(): void {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

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

function safeId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9-_]/g, '_');
}

function localPath(userId: string): string {
  return path.join(STATE_DIR, `${safeId(userId)}.json`);
}

function cidPath(userId: string): string {
  return path.join(STATE_DIR, `${safeId(userId)}.cid`);
}

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

interface ZeroGConfig {
  indexerUrl: string;
  evmRpcUrl: string;
  signer: NonceManager;   
  encryptionKeyB64: string;
}

interface UploadShard {
  cfg:   ZeroGConfig;
  queue: PQueue;
}

let _uploadShards: UploadShard[] | null | undefined;

function fnv1a32Upload(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h;
}

function buildUploadShards(base: ZeroGConfig): UploadShard[] {
  const count = Number(process.env.UPLOAD_KEY_COUNT ?? 1);
  const shards: UploadShard[] = [];

  for (let i = 0; i < count; i++) {
    const keyEnv = i === 0 ? 'PRIVATE_KEY' : `PRIVATE_KEY_${i}`;
    const key = process.env[keyEnv];
    if (!key) break;

    const provider = new JsonRpcProvider(base.evmRpcUrl);
    const signer   = new NonceManager(new Wallet(key, provider));
    shards.push({ cfg: { ...base, signer }, queue: new PQueue({ concurrency: 1 }) });
  }

  
  if (shards.length === 0) {
    shards.push({ cfg: base, queue: new PQueue({ concurrency: 1 }) });
  }

  return shards;
}

function getUploadShard(userId: string): UploadShard | null {
  if (!_uploadShards) return null;
  if (_uploadShards.length === 1) return _uploadShards[0];
  return _uploadShards[fnv1a32Upload(userId) % _uploadShards.length];
}

async function upload0G(userId: string, stateBlob: string, cfg: ZeroGConfig): Promise<void> {
  const { persistEncryptedJsonArtifact } = await import('../storage/persist');

  
  const origLog = console.log;
  const origInfo = console.info;
  console.log = () => { };
  console.info = () => { };

  try {
    const state = deserialise(stateBlob);
    const payload = JSON.parse(serialise(state));   
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
    origLog(`[Persist] ✅ 0G saved: ${userId} | CID: ${artifact.cid.slice(0, 12)}…`);
  } catch (err: any) {
    console.log = origLog;
    console.info = origInfo;
    origLog(`[Persist] ⚠  0G upload failed (${userId}): ${err.message}`);
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
    
    _uploadShards = buildUploadShards(_0gConfigCache);
    const n = _uploadShards.length;
    console.log(`[Persist] Upload shards: ${n} key${n > 1 ? 's' : ''} (set UPLOAD_KEY_COUNT + PRIVATE_KEY_N for more)`);
    return _0gConfigCache;
  } catch {
    _0gConfigCache = null;
    _uploadShards  = null;
    return null;
  }
}

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
    if (existing.includes(userId)) return;   
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
  triggerSnapshot?: unknown;
  proofRecoveredFromHistory?: boolean;
  proofRecoveredAt?: number;
  proofRecoverySource?: string;
  recoveredUniV3TokenId?: string;
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

export async function recoverFromCID(userId: string, cid: string): Promise<UserState | null> {
  const cfg = detect0GConfig();
  if (!cfg) throw new Error('0G Storage not configured — set INDEXER_URL, RPC_URL, PRIVATE_KEY, AGENT_STATE_ENCRYPTION_KEY_B64');

  try {
    const { restoreEncryptedJsonArtifact } = await import('../storage/persist');
    const raw = await restoreEncryptedJsonArtifact<Record<string, unknown>>(
      cid, SCHEMA, cfg.encryptionKeyB64, { indexerUrl: cfg.indexerUrl },
    );
    const state = deserialise(JSON.stringify(raw));
    ensureStateDir();
    fs.writeFileSync(cidPath(userId), cid, 'utf8');
    fs.writeFileSync(localPath(userId), serialise(state), 'utf8');
    console.log(`[Persist] ✅ Recovered ${userId} from 0G CID: ${cid.slice(0, 16)}…`);
    return state;
  } catch (err: any) {
    console.warn(`[Persist] Recovery failed for ${userId} from CID ${cid}: ${err.message}`);
    return null;
  }
}

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

  
  get pendingUploads(): number {
    if (!_uploadShards) return 0;
    return _uploadShards.reduce((sum, s) => sum + s.queue.size, 0);
  }

  
  enqueueZg(task: () => Promise<void>): void {
    if (!_uploadShards || _uploadShards.length === 0) {
      
      task().catch(e => console.warn('[Persist] enqueueZg task failed:', e.message));
      return;
    }
    
    _uploadShards[0].queue.add(task);
  }

  
  save(userId: string, state: UserState, force: boolean = false): void {
    if (!force && state.isDirty === false) {
      return;
    }

    
    
    state.isDirty = false;
    state.lastPersistedAt = Date.now();
    const stateBlob = serialise(state);

    if (this.cfg) {
      const shard = getUploadShard(userId);
      if (shard) {
        shard.queue.add(() => upload0G(userId, stateBlob, shard.cfg));
        shard.queue.add(() => this.syncJournalTo0G(userId, shard.cfg));
      }
      
      ensureStateDir();
      fs.writeFileSync(localPath(userId), stateBlob, 'utf8');
    } else {
      ensureStateDir();
      fs.writeFileSync(localPath(userId), stateBlob, 'utf8');
    }
  }

  
  async syncJournalTo0G(userId: string, cfg?: ZeroGConfig): Promise<string | null> {
    const activeCfg = cfg ?? this.cfg;
    if (!activeCfg) return null;

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
        indexerUrl: activeCfg.indexerUrl,
        evmRpcUrl:  activeCfg.evmRpcUrl,
        signer:     activeCfg.signer,
      });

      
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

  
  
  registerActiveUser(userId: string): void {
    appendToIndex(ACTIVE_INDEX_PATH, userId);
    removeFromIndex(ARCHIVED_INDEX_PATH, userId);
  }

  
  registerInIndex(userId: string): void {
    this.registerActiveUser(userId);
  }

  
  
  markUserArchived(userId: string): void {
    removeFromIndex(ACTIVE_INDEX_PATH, userId);
    removeFromIndex(LEGACY_INDEX_PATH, userId);
    appendToIndex(ARCHIVED_INDEX_PATH, userId);
  }

  
  
  getActiveUserIds(): string[] {
    const activeExists = fs.existsSync(ACTIVE_INDEX_PATH);
    if (activeExists) return readIndex(ACTIVE_INDEX_PATH);

    const archived = new Set(readIndex(ARCHIVED_INDEX_PATH));
    return readIndex(LEGACY_INDEX_PATH).filter(id => !archived.has(id));
  }

  getArchivedUserIds(): string[] {
    return readIndex(ARCHIVED_INDEX_PATH);
  }

  
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

  
  async drain(): Promise<void> {
    if (_uploadShards) {
      await Promise.all(_uploadShards.map(s => s.queue.onIdle()));
    }
  }
}
