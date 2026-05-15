

import { RankedOpportunity } from './types/market';
import { IntelligencePolicy } from './types/policy';
import { UniverseCache }      from './UniverseCache';
import { fetchLlamaPools }    from './providers/DefiLlama';
import { getFundingRates }    from './providers/GainsNetwork';
import { warmPriceCache }     from './providers/MoralisPrice';
import { loadDiskPriceHistory } from './providers/DiskPriceHistory';
import { UniswapV3Adapter }   from './adapters/UniswapV3';
import { MorphoAdapter }      from './adapters/Morpho';
import { AaveAdapter }        from './adapters/Aave';
import { PendleAdapter }      from './adapters/Pendle';
import { GMXAdapter }         from './adapters/GMX';
import { IProtocolAdapter, AdapterContext, OnChainRates } from './adapters/types';
import { applyPolicyFilter }  from './scoring/PolicyFilter';
import { scoreOpportunities, enrichTopN } from './scoring/ScoringEngine';

const UNIVERSE_REFRESH_MS = 10 * 60_000;   
const QUANT_ENRICH_MS     = 60 * 60_000;   
const FUNDS_REFRESH_MS    = 60 * 60_000;   

export class IntelligenceEngine {
  private static _instance: IntelligenceEngine;

  private cache        = new UniverseCache(UNIVERSE_REFRESH_MS);
  private adapters:    IProtocolAdapter[] = [
    new UniswapV3Adapter(),
    new MorphoAdapter(),
    new AaveAdapter(),
    new PendleAdapter(),
    new GMXAdapter(),
  ];

  private fundingRates: Map<string, number> = new Map([
    ['WETH', 6.5], ['WBTC', 7.0], ['ARB', 9.0],
  ]);
  private onChain: OnChainRates = {};

  private refreshTimer:   NodeJS.Timeout | null = null;
  private enrichTimer:    NodeJS.Timeout | null = null;
  private fundsTimer:     NodeJS.Timeout | null = null;
  private refreshRunning: Promise<void> | null  = null;

  private constructor() {}

  static getInstance(): IntelligenceEngine {
    if (!IntelligenceEngine._instance) {
      IntelligenceEngine._instance = new IntelligenceEngine();
    }
    return IntelligenceEngine._instance;
  }

  

  
  async warmUp(onChainRates?: OnChainRates): Promise<void> {
    if (onChainRates) this.onChain = onChainRates;

    
    loadDiskPriceHistory('arbitrum');

    if (this.cache.isEmpty || this.cache.isStale) {
      await this.refreshUniverse();
    } else {
      console.log(`[IntelligenceEngine] Cache warm from disk — ${this.cache.opportunities.length} opportunities ready`);
    }
    
    const addresses = this.cache.opportunities
      .flatMap(o => [o.tokens.base.address, o.tokens.quote?.address].filter(Boolean) as string[])
      .slice(0, 50);
    warmPriceCache(addresses).catch(() => {});
  }

  
  startBackgroundWorkers(onChainRates?: OnChainRates): void {
    if (onChainRates) this.onChain = onChainRates;
    if (this.refreshTimer) return;   

    
    this.refreshTimer = setInterval(() => {
      this.refreshUniverse().catch(e => console.warn('[IntelligenceEngine] Universe refresh failed:', e.message?.slice(0, 80)));
    }, UNIVERSE_REFRESH_MS);

    
    this.fundsTimer = setInterval(() => {
      getFundingRates().then(r => { this.fundingRates = r; }).catch(() => {});
    }, FUNDS_REFRESH_MS);

    
    this.enrichTimer = setInterval(() => {
      const top = this.cache.opportunities.slice(0, 20);
      if (top.length === 0) return;
      enrichTopN(top, 20).then(enriched => {
        const rest = this.cache.opportunities.slice(20);
        this.cache.update([...enriched, ...rest]);
      }).catch(() => {});
    }, QUANT_ENRICH_MS);

    console.log('[IntelligenceEngine] Background workers started');
  }

  stopBackgroundWorkers(): void {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    if (this.fundsTimer)   { clearInterval(this.fundsTimer);   this.fundsTimer   = null; }
    if (this.enrichTimer)  { clearInterval(this.enrichTimer);  this.enrichTimer  = null; }
  }

  
  updateOnChainRates(rates: OnChainRates): void {
    this.onChain = rates;
  }

  

  
  getOpportunities(policy: IntelligencePolicy): RankedOpportunity[] {
    const all      = this.cache.opportunities;
    const filtered = applyPolicyFilter(all, policy);
    return scoreOpportunities(filtered, policy);
  }

  

  private async refreshUniverse(): Promise<void> {
    if (this.refreshRunning) return this.refreshRunning;

    this.refreshRunning = (async () => {
      try {
        console.log('[IntelligenceEngine] Refreshing universe...');
        const [llamaPools, fundingRates] = await Promise.all([
          fetchLlamaPools(['arbitrum']),
          getFundingRates(),
        ]);
        this.fundingRates = fundingRates;

        const ctx: AdapterContext = { llamaPools, fundingRates, onChain: this.onChain };

        
        const results = await Promise.allSettled(
          this.adapters.map(a => a.build({
            riskTier: 'advanced', managedUSD: 10_000,
            allowedChains: ['arbitrum'],
          }, ctx)),
        );

        const all: RankedOpportunity[] = [];
        for (const r of results) {
          if (r.status === 'fulfilled') all.push(...r.value);
          else console.warn('[IntelligenceEngine] Adapter failed:', (r.reason as any)?.message?.slice(0, 60));
        }

        this.cache.update(all);
        console.log(`[IntelligenceEngine] Universe refreshed: ${all.length} opportunities`);
      } catch (e: any) {
        console.error('[IntelligenceEngine] Refresh failed:', e.message?.slice(0, 100));
      }
    })();

    return this.refreshRunning.finally(() => { this.refreshRunning = null; });
  }

  

  get stats() {
    return {
      totalOpportunities: this.cache.opportunities.length,
      lastRefreshed:      this.cache.lastRefreshed,
      isStale:            this.cache.isStale,
      adapters:           this.adapters.map(a => a.id),
    };
  }
}
