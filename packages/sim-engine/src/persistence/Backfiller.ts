import type { AlphaOpportunity, TapeEntry } from '../types';
import { YieldTape } from './YieldTape';

const MIN_HISTORY_POINTS = 14;
const MAX_BACKFILL_POINTS = 180;

interface DefiLlamaChartPoint {
  timestamp?: number | string;
  time?: number;
  apy?: number;
  apyBase?: number;
}

interface PendleHistoricalPoint {
  timestamp?: string;
  impliedApy?: number;
  baseApy?: number;
  maxApy?: number;
  tvl?: number;
}

function toTimestampMs(value: number | string | undefined): number | null {
  if (value === undefined || value === null) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value > 1_000_000_000_000 ? value : value * 1_000;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1_000;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export class Backfiller {
  constructor(private readonly tape: YieldTape) {}

  async backfill(opportunity: AlphaOpportunity): Promise<TapeEntry[]> {
    console.log(`[Backfiller] Checking history for ${opportunity.protocol} ${opportunity.pool}...`);

    const existing = await this.tape.getHistory(opportunity.id, { sources: ['scan', 'backfill'] });
    if (existing.length >= MIN_HISTORY_POINTS) {
      console.log(`  > History already present (${existing.length} points).`);
      return existing;
    }

    const provider = opportunity.metadata.historyProvider;
    if (!provider || provider.kind === 'none') {
      console.log('  > No historical provider configured. Using observed tape only.');
      return existing;
    }

    let backfilled: TapeEntry[] = [];
    if (provider.kind === 'defillama-pool') {
      backfilled = await this.fetchDefiLlamaHistory(opportunity, provider.poolId);
    } else if (provider.kind === 'pendle-market') {
      backfilled = await this.fetchPendleHistory(opportunity, provider.chainId, provider.marketAddress);
    } else {
      console.log('  > Unsupported history provider.');
      return existing;
    }
    if (backfilled.length === 0) {
      console.log('  > No historical backfill available from source.');
      return existing;
    }

    const seenTimestamps = new Set(existing.map(entry => entry.timestamp));
    const uniqueBackfill = backfilled.filter(entry => !seenTimestamps.has(entry.timestamp));

    if (uniqueBackfill.length === 0) {
      console.log('  > Historical source returned only already-known points.');
      return existing;
    }

    await this.tape.recordMany(uniqueBackfill);
    const provenance = uniqueBackfill[0]?.provenance;
    const provenanceLabel = provenance ? `${provenance.provider} / ${provenance.quality}` : 'external source';
    console.log(`  > Backfilled ${uniqueBackfill.length} real historical points from ${provenanceLabel}.`);

    return this.tape.getHistory(opportunity.id, { sources: ['scan', 'backfill'] });
  }

  private downsample(entries: TapeEntry[], maxPoints: number): TapeEntry[] {
    if (entries.length <= maxPoints) return entries;

    const sampled: TapeEntry[] = [];
    const step = (entries.length - 1) / (maxPoints - 1);
    for (let index = 0; index < maxPoints; index += 1) {
      const sourceIndex = Math.round(index * step);
      sampled.push({
        ...entries[sourceIndex],
        provenance: entries[sourceIndex].provenance
          ? { ...entries[sourceIndex].provenance, sampling: 'downsampled' }
          : undefined,
      });
    }
    return sampled;
  }

  private async fetchDefiLlamaHistory(opportunity: AlphaOpportunity, poolId: string): Promise<TapeEntry[]> {
    try {
      const fetchedAt = Date.now();
      const res = await fetch(`https://yields.llama.fi/chart/${poolId}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return [];

      const data = await res.json() as { data?: DefiLlamaChartPoint[] } | DefiLlamaChartPoint[];
      const rawPoints = Array.isArray(data) ? data : (data.data ?? []);

      const entries = rawPoints
        .map((point): TapeEntry | null => {
          const timestampMs = toTimestampMs(point.timestamp ?? point.time);
          const grossAPY = point.apy ?? point.apyBase;
          if (!timestampMs || grossAPY === undefined || grossAPY === null) return null;

          return {
            timestamp: timestampMs,
            opportunityId: opportunity.id,
            protocol: opportunity.protocol,
            pool: opportunity.pool,
            grossAPY: Number(grossAPY),
            confidence: 0,
            verdict: 'UNKNOWN' as const,
            price: undefined,
            source: 'backfill' as const,
            provenance: {
              provider: 'defillama',
              providerId: poolId,
              quality: 'indexed',
              fetchedAt,
              sampling: 'raw',
            },
          };
        })
        .filter((entry): entry is TapeEntry => entry !== null);

      return this.downsample(entries.sort((a, b) => a.timestamp - b.timestamp), MAX_BACKFILL_POINTS);
    } catch {
      return [];
    }
  }

  private async fetchPendleHistory(opportunity: AlphaOpportunity, chainId: number, marketAddress: string): Promise<TapeEntry[]> {
    try {
      const fetchedAt = Date.now();
      const res = await fetch(`https://api-v2.pendle.finance/core/v3/${chainId}/markets/${marketAddress}/historical-data`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return [];

      const data = await res.json() as { results?: PendleHistoricalPoint[] };
      const entries = (data.results ?? [])
        .map((point): TapeEntry | null => {
          const timestampMs = toTimestampMs(point.timestamp);
          const grossApyRaw = point.impliedApy ?? point.baseApy ?? point.maxApy;
          if (!timestampMs || grossApyRaw === undefined || grossApyRaw === null) return null;

          return {
            timestamp: timestampMs,
            opportunityId: opportunity.id,
            protocol: opportunity.protocol,
            pool: opportunity.pool,
            grossAPY: Number(grossApyRaw) * 100,
            confidence: 0,
            verdict: 'UNKNOWN' as const,
            price: undefined,
            source: 'backfill' as const,
            provenance: {
              provider: 'pendle-core',
              providerId: marketAddress,
              quality: 'protocol-native',
              fetchedAt,
              sampling: 'raw',
            },
          };
        })
        .filter((entry): entry is TapeEntry => entry !== null);

      return this.downsample(entries.sort((a, b) => a.timestamp - b.timestamp), MAX_BACKFILL_POINTS);
    } catch {
      return [];
    }
  }
}
