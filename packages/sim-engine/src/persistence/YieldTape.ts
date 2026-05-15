import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TapeEntry, TapeFile, TapeSource } from '../types';

const TAPE_VERSION = 1 as const;
const MAX_TAPE_ENTRIES = 10_000;

export interface HistoryQueryOptions {
  limit?: number;
  sources?: TapeSource[];
}

export class YieldTape {
  private readonly tapePath: string;

  constructor() {
    this.tapePath = path.resolve(__dirname, '../../data/yield_tape.json');
    this.ensureStorage();
  }

  private ensureStorage(): void {
    const dir = path.dirname(this.tapePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.tapePath)) {
      this.writeFile({ version: TAPE_VERSION, entries: [] });
    }
  }

  private loadFile(): TapeFile {
    const raw = fs.readFileSync(this.tapePath, 'utf8').trim();
    if (!raw) return { version: TAPE_VERSION, entries: [] };

    const parsed = JSON.parse(raw) as TapeFile | TapeEntry[];
    if (Array.isArray(parsed)) {
      return {
        version: TAPE_VERSION,
        entries: parsed
          .map(entry => this.normaliseEntry(entry))
          .filter((entry): entry is TapeEntry => entry !== null),
      };
    }

    return {
      version: TAPE_VERSION,
      entries: Array.isArray(parsed.entries)
        ? parsed.entries
            .map(entry => this.normaliseEntry(entry))
            .filter((entry): entry is TapeEntry => entry !== null)
        : [],
    };
  }

  private writeFile(data: TapeFile): void {
    const tmpPath = `${this.tapePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, this.tapePath);
  }

  private normalise(entries: TapeEntry[]): TapeEntry[] {
    const sorted = entries
      .map(entry => this.normaliseEntry(entry))
      .filter((entry): entry is TapeEntry => entry !== null)
      .sort((a, b) => a.timestamp - b.timestamp);
    return sorted.slice(-MAX_TAPE_ENTRIES);
  }

  private normaliseEntry(entry: Partial<TapeEntry> | null | undefined): TapeEntry | null {
    if (!entry?.opportunityId || !entry.protocol || !entry.pool) return null;

    const timestamp = Number(entry.timestamp);
    const grossAPY = Number(entry.grossAPY);
    const confidence = Number(entry.confidence ?? 0);

    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    if (!Number.isFinite(grossAPY)) return null;

    const verdict = entry.verdict === 'APPROVED' || entry.verdict === 'REJECTED' || entry.verdict === 'UNKNOWN'
      ? entry.verdict
      : 'UNKNOWN';
    const source = entry.source === 'backfill' ? 'backfill' : 'scan';
    const price = entry.price === undefined ? undefined : Number(entry.price);

    return {
      timestamp,
      opportunityId: entry.opportunityId,
      protocol: entry.protocol,
      pool: entry.pool,
      grossAPY,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      verdict,
      price: price !== undefined && Number.isFinite(price) ? price : undefined,
      source,
      runId: entry.runId,
      provenance: entry.provenance,
      simulation: entry.simulation,
    };
  }

  async record(entry: TapeEntry): Promise<void> {
    const file = this.loadFile();
    file.entries = this.normalise([...file.entries, entry]);
    this.writeFile(file);
  }

  async recordMany(entries: TapeEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const file = this.loadFile();
    file.entries = this.normalise([...file.entries, ...entries]);
    this.writeFile(file);
  }

  async getHistory(opportunityId: string, options: HistoryQueryOptions = {}): Promise<TapeEntry[]> {
    const file = this.loadFile();
    const sources = options.sources;
    let history = file.entries.filter(entry => entry.opportunityId === opportunityId);
    if (sources?.length) {
      history = history.filter(entry => sources.includes(entry.source));
    }
    history.sort((a, b) => a.timestamp - b.timestamp);
    if (options.limit && options.limit > 0) {
      return history.slice(-options.limit);
    }
    return history;
  }

  async getMomentum(opportunityId: string): Promise<number> {
    const history = await this.getHistory(opportunityId, { limit: 2 });
    if (history.length < 2) return 0;

    const last = history[history.length - 1].grossAPY;
    const prev = history[history.length - 2].grossAPY;
    return last - prev;
  }
}
