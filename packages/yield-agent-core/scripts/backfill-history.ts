import { MarketIntelligence } from '../src/MarketIntelligence';
import { PriceProvider } from '../src/providers/price';
import { HistoricalRegistry } from '../src/utils/historical-registry';

async function backfill() {
  const intel = new MarketIntelligence();
  const priceProvider = new PriceProvider();
  const registry = new HistoricalRegistry();

  console.log('--- YIELDGEKO HISTORY BACKFILL ---');
  
  // 1. Get Top Candidates across all users to identify relevant tokens
  const chains = ['arbitrum'];
  const universe = await (intel as any).aggregator.aggregate(chains);
  
  // 2. Identify unique tokens in the top pools (TVL + APY)
  const topByTVL = universe
    .sort((a: any, b: any) => b.metrics.tvlUSD - a.metrics.tvlUSD)
    .slice(0, 250);

  const topByAPY = universe
    .filter((p: any) => p.metrics.tvlUSD > 20000) // Lower floor to $20k to catch "Gems"
    .sort((a: any, b: any) => b.metrics.totalAPY - a.metrics.totalAPY)
    .slice(0, 250);

  const eliteSet = [...new Set([...topByTVL, ...topByAPY])];
  const tokensToFetch = new Map<string, { chain: string; address: string; symbol: string }>();
  
  for (const pool of eliteSet) {
    if (pool.tokens.base.address !== '0x0') {
      const key = `${pool.chain}:${pool.tokens.base.address.toLowerCase()}`;
      tokensToFetch.set(key, { chain: pool.chain, address: pool.tokens.base.address, symbol: pool.tokens.base.symbol });
    }
    if (pool.tokens.quote.address !== '0x0') {
      const key = `${pool.chain}:${pool.tokens.quote.address.toLowerCase()}`;
      tokensToFetch.set(key, { chain: pool.chain, address: pool.tokens.quote.address, symbol: pool.tokens.quote.symbol });
    }
  }

  console.log(`Identified ${tokensToFetch.size} unique tokens for backfill.`);

  // 3. Methodically fetch history
  let count = 0;
  for (const [key, token] of tokensToFetch) {
    count++;
    
    // Skip if already in registry
    if (registry.get(token.chain, token.address)) {
      console.log(`[${count}/${tokensToFetch.size}] Skipping ${token.symbol} (Already cached)`);
      continue;
    }

    console.log(`[${count}/${tokensToFetch.size}] Fetching ${token.symbol} on ${token.chain}...`);
    try {
      const prices = await priceProvider.getHistoricalPrices(token.chain, token.address);
      if (prices.length > 0) {
        console.log(`   ✅ Success: ${prices.length} data points.`);
        // Save immediately to disk after every success
        registry.saveChain(token.chain);
      } else {
        console.warn(`   ❌ Failed: No data returned from API.`);
        // If we get zero data, it might be a rate limit or a missing coin
        // Let's wait a bit longer just in case
        await new Promise(r => setTimeout(r, 10000));
      }
      
      // Standard wait (5 seconds)
      await new Promise(r => setTimeout(r, 5000));
    } catch (err) {
      console.error(`   ❌ Error: ${err.message}`);
      if (err.message.includes('429')) {
        console.log('   ⚠️ Rate limited! Cooling down for 60 seconds...');
        await new Promise(r => setTimeout(r, 60000));
      }
    }
  }

  console.log('\n--- BACKFILL COMPLETE ---');
  process.exit(0);
}

backfill();
