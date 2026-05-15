

import * as fs   from 'node:fs';
import * as path from 'node:path';

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'history');

interface DiskPoint { timestamp: number; close: number; }
type DiskFile = Record<string, DiskPoint[]>;

const _diskCache = new Map<string, number[]>();
let _loaded      = false;

export function loadDiskPriceHistory(chain = 'arbitrum'): void {
  if (_loaded) return;
  _loaded = true;

  const filePath = path.join(DATA_DIR, `${chain}.json`);
  if (!fs.existsSync(filePath)) {
    console.log(`[DiskPriceHistory] No disk history for ${chain} — run python/backfill_history.py`);
    return;
  }

  try {
    const raw:  DiskFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    let count = 0;
    for (const [addr, points] of Object.entries(raw)) {
      if (Array.isArray(points) && points.length > 0) {
        _diskCache.set(addr.toLowerCase(), points.map(p => p.close));
        count++;
      }
    }
    console.log(`[DiskPriceHistory] Loaded ${count} token histories from disk (${chain}.json)`);
  } catch (e: any) {
    console.warn('[DiskPriceHistory] Failed to load:', e.message?.slice(0, 60));
  }
}

export function getDiskPrices(address: string): number[] {
  return _diskCache.get(address.toLowerCase()) ?? [];
}

export function getDiskAddresses(): string[] {
  return [..._diskCache.keys()];
}
