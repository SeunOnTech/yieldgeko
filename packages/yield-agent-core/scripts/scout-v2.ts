import { MarketIntelligence } from '../src/MarketIntelligence';
import { UserPolicy } from '../src/types/policy';

async function main() {
  // 1. Access the Global Singleton Intelligence Service
  const intel = MarketIntelligence.getInstance();

  // 2. Start the Master Global Sync Worker (Pre-warms the Global Universe)
  // This worker fetches the entire world (All Chains) once.
  intel.startGlobalSync();

  const demoPolicies: UserPolicy[] = [
    {
      id: 'alice-001',
      userId: 'alice',
      displayName: 'Alice (Balanced)',
      managedUSD: 10000,
      riskTier: 'balanced',
      minAPY: 8,
      minNetAPY: 5,
      maxSlippageBps: 50,
      maxDrawdownPct: 10,
      allowedChains: ['arbitrum'],
      stablecoinOnly: false,
      migrationThresholdPct: 3,
      rebalanceThresholdBps: 100,
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    },
    {
      id: 'bob-001',
      userId: 'bob',
      displayName: 'Bob (Conservative)',
      managedUSD: 50000,
      riskTier: 'conservative',
      minAPY: 4,
      minNetAPY: 3,
      maxSlippageBps: 20,
      maxDrawdownPct: 5,
      allowedChains: ['arbitrum'],
      stablecoinOnly: true,
      migrationThresholdPct: 1,
      rebalanceThresholdBps: 50,
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    }
  ];

  console.log('--- YIELDGEKO UNIVERSAL MASTER INTELLIGENCE ---');
  console.log('[System] Master Sync Worker started. Fetching Global Universe...\n');
  
  // Wait for the Master Sync to finish the first Global Fetch
  // Since it's fetching the WHOLE WORLD, we give it 20 seconds.
  await new Promise(r => setTimeout(r, 20000));

  for (const policy of demoPolicies) {
    console.log(`\nAGENT WAKE-UP: ${policy.displayName} is slicing the Global Universe...`);
    
    const startTime = Date.now();
    // Agent filters the GLOBAL in-memory list instantly
    const groupedMatches = await intel.getGroupedOpportunities(policy);
    const duration = Date.now() - startTime;

    console.log(`Discovery complete for ${policy.userId} (Latency: ${duration}ms)`);

    for (const [chain, matches] of Object.entries(groupedMatches)) {
      console.log(`>>> CHAIN: ${chain.toUpperCase()} (${matches.length} pools matched from Global Pool)`);
      
      for (const match of matches.slice(0, 3)) {
        console.log(`  [Score: ${match.analysis.score.toFixed(1)}] ${match.protocol.toUpperCase()} ${match.tokens.base.symbol}/${match.tokens.quote.symbol}`);
        console.log(`    > Stats: NET APY: ${match.analysis.netAPY.toFixed(2)}% | IL Risk: ${(match.analysis.predictedIL * 100).toFixed(2)}% | Corr: ${match.analysis.correlation.toFixed(3)}`);
        console.log('    --------------------------------------------');
      }
    }
    console.log('================================================');
  }

  // Graceful shutdown
  console.log('\n[System] Simulation complete. Stopping Master Sync Worker.');
  // We'll let the process exit
  process.exit(0);
}

main().catch(console.error);
