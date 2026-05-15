

import * as fs   from 'node:fs';
import * as path from 'node:path';
import { RankedOpportunity } from './types/market';

const DISK_PATH = path.join(__dirname, '..', 'data', 'universe.json');

interface PersistedUniverse {
  opportunities: RankedOpportunity[];
  savedAt:       number;
}

export class UniverseCache {
  private _opps:      RankedOpportunity[] = [];
  private _savedAt    = 0;
  private _refreshedAt = 0;

  readonly MAX_AGE_MS: number;

  constructor(maxAgeMs = 10 * 60_000) {
    this.MAX_AGE_MS = maxAgeMs;
    this.loadFromDisk();
  }

  get opportunities(): RankedOpportunity[] { return this._opps; }
  get lastRefreshed(): number              { return this._refreshedAt; }
  get isStale(): boolean                   { return Date.now() - this._refreshedAt > this.MAX_AGE_MS; }
  get isEmpty(): boolean                   { return this._opps.length === 0; }

  update(opps: RankedOpportunity[]): void {
    this._opps        = opps;
    this._refreshedAt = Date.now();
    this.saveToDisk();
    console.log(`[UniverseCache] Updated: ${opps.length} opportunities`);
  }

  

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(DISK_PATH)) return;
      const raw  = fs.readFileSync(DISK_PATH, 'utf-8');
      const data = JSON.parse(raw) as PersistedUniverse;
      this._opps      = data.opportunities ?? [];
      this._savedAt   = data.savedAt        ?? 0;
      this._refreshedAt = this._savedAt;
      console.log(`[UniverseCache] Loaded ${this._opps.length} opportunities from disk (saved ${Math.round((Date.now() - this._savedAt) / 60_000)}m ago)`);
    } catch (e: any) {
      console.warn('[UniverseCache] Failed to load from disk:', e.message?.slice(0, 80));
    }
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(DISK_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data: PersistedUniverse = { opportunities: this._opps, savedAt: Date.now() };
      fs.writeFileSync(DISK_PATH, JSON.stringify(data), 'utf-8');
    } catch (e: any) {
      console.warn('[UniverseCache] Failed to save to disk:', e.message?.slice(0, 80));
    }
  }
}
