import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type { LogEntry, LogLevel, ExecutionRecord, PnLPoint } from './types';

const STATE_DIR = path.resolve(process.cwd(), '.state');
const DB_PATH = path.join(STATE_DIR, 'infinity_journal.sqlite');

export class JournalManager {
  private db: Database.Database;
  private dbPath: string;

  constructor() {

    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    this.dbPath = DB_PATH;
    this.db = new Database(this.dbPath);

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS strategy_logs (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        detail TEXT,
        session_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_logs_strategy_id ON strategy_logs(strategy_id);
      CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON strategy_logs(timestamp);

      CREATE TABLE IF NOT EXISTS strategy_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        action TEXT NOT NULL,
        tx_hash TEXT,
        receipt_hash TEXT,
        amount_usd REAL,
        simulated BOOLEAN,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_exec_strategy_id ON strategy_executions(strategy_id);

      CREATE TABLE IF NOT EXISTS strategy_pnl (
        strategy_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        total_usd REAL NOT NULL,
        nav_usd REAL NOT NULL,
        income_usd REAL NOT NULL,
        il_usd REAL NOT NULL,
        net_usd REAL NOT NULL,
        PRIMARY KEY (strategy_id, timestamp)
      );

      CREATE TABLE IF NOT EXISTS strategy_checkpoints (
        strategy_id TEXT PRIMARY KEY,
        last_log_ts INTEGER DEFAULT 0,
        last_exec_ts INTEGER DEFAULT 0,
        last_pnl_ts INTEGER DEFAULT 0
      );
    `);
    console.log(`[Journal] Infinity Journal initialized (WAL mode) at ${this.dbPath}`);
  }

  

  addLog(strategyId: string, level: LogLevel, message: string, detail?: string, sessionId?: string): LogEntry {
    const entry: LogEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      level,
      message,
      detail,
      sessionId,
    };

    const stmt = this.db.prepare(`
      INSERT INTO strategy_logs (id, strategy_id, timestamp, level, message, detail, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(entry.id, strategyId, entry.timestamp, entry.level, entry.message, entry.detail || null, entry.sessionId || null);
    return entry;
  }

  getHotLogs(strategyId: string, limit = 80): LogEntry[] {
    const stmt = this.db.prepare(`
      SELECT id, timestamp, level, message, detail, session_id as sessionId
      FROM strategy_logs
      WHERE strategy_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return (stmt.all(strategyId, limit) as any[]).map(r => ({
      ...r,
      detail: r.detail || undefined,
      sessionId: r.sessionId || undefined,
    }));
  }

  

  addExecution(strategyId: string, record: ExecutionRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO strategy_executions (strategy_id, timestamp, action, tx_hash, receipt_hash, amount_usd, simulated, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      strategyId,
      record.timestamp,
      record.action,
      record.txHash || null,
      record.receiptHash,
      record.amountUSD,
      record.simulated ? 1 : 0,
      JSON.stringify(record) 
    );
  }

  updateExecution(strategyId: string, receiptHash: string, patch: Partial<ExecutionRecord>): void {
    const stmtSelect = this.db.prepare(`
      SELECT detail FROM strategy_executions
      WHERE strategy_id = ? AND receipt_hash = ?
    `);

    const row = stmtSelect.get(strategyId, receiptHash) as any;
    if (!row) return;

    const existing = JSON.parse(row.detail);
    const updated = { ...existing, ...patch };

    const stmtUpdate = this.db.prepare(`
      UPDATE strategy_executions
      SET detail = ?, tx_hash = ?, amount_usd = ?, simulated = ?
      WHERE strategy_id = ? AND receipt_hash = ?
    `);

    stmtUpdate.run(
      JSON.stringify(updated),
      updated.txHash || null,
      updated.amountUSD || null,
      updated.simulated ? 1 : 0,
      strategyId,
      receiptHash
    );
  }

  getExecutions(strategyId: string, limit = 50): ExecutionRecord[] {

    const stmt = this.db.prepare(`
      SELECT detail FROM strategy_executions
      WHERE strategy_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return (stmt.all(strategyId, limit) as any[]).map(r => JSON.parse(r.detail));
  }

  

  addPnL(strategyId: string, point: PnLPoint): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO strategy_pnl (strategy_id, timestamp, total_usd, nav_usd, income_usd, il_usd, net_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      strategyId,
      point.ts,
      point.totalUSD,
      point.navUSD,
      point.incomeUSD,
      point.ilUSD,
      point.netUSD
    );
  }

  getPnLHistory(strategyId: string, limit = 1440): PnLPoint[] {
    const stmt = this.db.prepare(`
      SELECT timestamp as ts, total_usd as totalUSD, nav_usd as navUSD, income_usd as incomeUSD, il_usd as ilUSD, net_usd as netUSD
      FROM strategy_pnl
      WHERE strategy_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return (stmt.all(strategyId, limit) as any[]);
  }

  

  getUnsyncedData(strategyId: string): { logs: LogEntry[], executions: ExecutionRecord[], pnl: PnLPoint[] } {
    const checkpoint = this.db.prepare(`SELECT * FROM strategy_checkpoints WHERE strategy_id = ?`).get(strategyId) as any || { last_log_ts: 0, last_exec_ts: 0, last_pnl_ts: 0 };

    const logs = this.db.prepare(`SELECT id, timestamp, level, message, detail, session_id as sessionId FROM strategy_logs WHERE strategy_id = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT 100`).all(strategyId, checkpoint.last_log_ts) as any[];
    const execs = this.db.prepare(`SELECT detail FROM strategy_executions WHERE strategy_id = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT 50`).all(strategyId, checkpoint.last_exec_ts) as any[];
    const pnl = this.db.prepare(`SELECT timestamp as ts, total_usd as totalUSD, nav_usd as navUSD, income_usd as incomeUSD, il_usd as ilUSD, net_usd as netUSD FROM strategy_pnl WHERE strategy_id = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT 100`).all(strategyId, checkpoint.last_pnl_ts) as any[];

    return {
      logs: logs.map(l => ({ ...l, detail: l.detail || undefined, sessionId: l.sessionId || undefined })),
      executions: execs.map(e => JSON.parse(e.detail)),
      pnl
    };
  }

  updateCheckpoint(strategyId: string, updates: { last_log_ts?: number, last_exec_ts?: number, last_pnl_ts?: number }): void {
    const existing = this.db.prepare(`SELECT * FROM strategy_checkpoints WHERE strategy_id = ?`).get(strategyId);
    if (!existing) {
      this.db.prepare(`INSERT INTO strategy_checkpoints (strategy_id, last_log_ts, last_exec_ts, last_pnl_ts) VALUES (?, ?, ?, ?)`).run(
        strategyId, updates.last_log_ts || 0, updates.last_exec_ts || 0, updates.last_pnl_ts || 0
      );
    } else {
      if (updates.last_log_ts) this.db.prepare(`UPDATE strategy_checkpoints SET last_log_ts = ? WHERE strategy_id = ?`).run(updates.last_log_ts, strategyId);
      if (updates.last_exec_ts) this.db.prepare(`UPDATE strategy_checkpoints SET last_exec_ts = ? WHERE strategy_id = ?`).run(updates.last_exec_ts, strategyId);
      if (updates.last_pnl_ts) this.db.prepare(`UPDATE strategy_checkpoints SET last_pnl_ts = ? WHERE strategy_id = ?`).run(updates.last_pnl_ts, strategyId);
    }
  }

  

  close(): void {
    this.db.close();
  }
}

let _journal: JournalManager | null = null;
export function getJournal(): JournalManager {
  if (!_journal) _journal = new JournalManager();
  return _journal;
}
