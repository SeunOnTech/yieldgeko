import { randomUUID } from 'node:crypto';
import { AlphaScout } from './discovery/AlphaScout';
import { YieldTape } from './persistence/YieldTape';
import { Backfiller } from './persistence/Backfiller';
import { ChaosBridge } from './simulation/ChaosBridge';
import type { AlphaOpportunity } from './types';

class SIMOrchestrator {
  private readonly scout = new AlphaScout();
  private readonly tape = new YieldTape();
  private readonly backfiller = new Backfiller(this.tape);
  private readonly chaos = new ChaosBridge();
  private readonly runId = randomUUID();

  private async analyzeOpportunity(opportunity: AlphaOpportunity): Promise<void> {
    console.log(`\n--- Analyzing ${opportunity.protocol} ${opportunity.pool} ---`);

    await this.backfiller.backfill(opportunity);
    const history = await this.tape.getHistory(opportunity.id, { sources: ['scan', 'backfill'], limit: 90 });
    const backfillSources = Array.from(new Set(history.map(point => point.provenance?.provider).filter(Boolean)));

    const simulationInput = this.chaos.buildInput(opportunity, history);
    const chaosResult = await this.chaos.run(simulationInput);

    const status = chaosResult.status === 'APPROVED' ? 'APPROVED' : 'REJECTED';
    const verdictIcon = status === 'APPROVED' ? '✅' : '❌';

    console.log(`  > Verified: ${opportunity.metadata.verified ? 'yes' : 'no'}`);
    console.log(`  > Selection Score: ${opportunity.selectionScore}`);
    if (opportunity.evaluation) {
      console.log(`  > Model: ${opportunity.evaluation.model}`);
      console.log(`  > Expected Net APY: ${opportunity.evaluation.expectedNetApy.toFixed(2)}%`);
      console.log(`  > Expected Risk Drag: ${opportunity.evaluation.expectedRiskDrag.toFixed(2)}%`);
      console.log(`  > Expected Management Cost: ${opportunity.evaluation.expectedManagementCost.toFixed(2)}%`);
      console.log(`  > Model Confidence: ${opportunity.evaluation.confidence.toFixed(2)}%`);
    }
    console.log(`  > Gross APY: ${opportunity.grossAPY.toFixed(2)}%`);
    console.log(`  > Liquidity: $${opportunity.liquidityUSD.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    if (opportunity.price !== undefined) {
      console.log(`  > Price: $${opportunity.price.toFixed(4)}`);
    }
    console.log(`  > History points: ${history.length}${backfillSources.length ? ` | Sources: ${backfillSources.join(', ')}` : ''}`);
    console.log(`  > True Volatility: ${(chaosResult.true_volatility * 100).toFixed(2)}%`);
    if (chaosResult.estimated_il_drag !== undefined) {
      console.log(`  > Estimated IL Drag: ${chaosResult.estimated_il_drag.toFixed(2)}%`);
    }
    if (chaosResult.net_expected_apy !== undefined) {
      console.log(`  > Net Expected APY: ${chaosResult.net_expected_apy.toFixed(2)}%`);
    }
    console.log(`  > Momentum Factor: ${chaosResult.momentum_factor.toFixed(2)}x`);
    console.log(`  > Sortino Ratio: ${chaosResult.sortino_ratio.toFixed(2)}`);
    console.log(`  > Chaos Confidence: ${chaosResult.chaos_confidence.toFixed(2)}%`);
    console.log(`  > Verdict: ${verdictIcon} ${status}`);

    await this.tape.record({
      timestamp: Date.now(),
      opportunityId: opportunity.id,
      protocol: opportunity.protocol,
      pool: opportunity.pool,
      grossAPY: opportunity.grossAPY,
      confidence: chaosResult.chaos_confidence,
      verdict: status,
      price: opportunity.price,
      source: 'scan',
      runId: this.runId,
      simulation: {
        expectedAPY: chaosResult.expected_apy,
        trueVolatility: chaosResult.true_volatility,
        sortinoRatio: chaosResult.sortino_ratio,
        momentumFactor: chaosResult.momentum_factor,
        confidence: chaosResult.chaos_confidence,
        status,
        seed: chaosResult.simulation_seed,
      },
    });
  }

  async run(): Promise<void> {
    console.log('==============================================');
    console.log('   YIELDGEKO SIM ENGINE - VERIFIED START      ');
    console.log('==============================================');

    const opportunities = await this.scout.runDiscovery();
    if (opportunities.length === 0) {
      console.log('[SIM] No verified opportunities discovered.');
      return;
    }

    console.log('\n[SIM] Discovery complete. Running deterministic chaos analysis...');

    const selected = opportunities.slice(0, 5);
    for (const opportunity of selected) {
      await this.analyzeOpportunity(opportunity);
    }
  }
}

const orchestrator = new SIMOrchestrator();
orchestrator.run().catch(error => {
  console.error('[SIM] Fatal orchestrator error:', error);
  process.exitCode = 1;
});
