import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { AlphaOpportunity, ChaosSimulationInput, ChaosSimulationResult, TapeEntry } from '../types';

const DEFAULT_TIMEOUT_MS = 20_000;

export class ChaosBridge {
  private readonly scriptPath: string;
  private readonly pythonBin: string;

  constructor() {
    this.scriptPath = path.resolve(__dirname, '../../python/chaos_engine/ChaosEngine.py');
    this.pythonBin = process.env.SIM_ENGINE_PYTHON_BIN ?? 'python3';
  }

  buildInput(opportunity: AlphaOpportunity, history: TapeEntry[]): ChaosSimulationInput {
    const token0Symbol = String(opportunity.metadata.token0Symbol ?? '');
    const token1Symbol = String(opportunity.metadata.token1Symbol ?? '');
    const stableSymbols = new Set(['USDC', 'USDT', 'DAI', 'USDE', 'USDC.E', 'USDBC', 'USDCE', 'MIM', 'USDS', 'USD0']);
    const stable0 = stableSymbols.has(token0Symbol.toUpperCase());
    const stable1 = stableSymbols.has(token1Symbol.toUpperCase());
    const pairType = stable0 && stable1
      ? 'stable-stable'
      : stable0 || stable1
        ? 'stable-volatile'
        : 'volatile-volatile';
    const volumeUsd7d = Number((opportunity.metadata.extra as Record<string, unknown> | undefined)?.volumeUsd7d ?? 0);

    const seedMaterial = JSON.stringify({
      id: opportunity.id,
      grossAPY: opportunity.grossAPY,
      liquidityUSD: opportunity.liquidityUSD,
      selectionScore: opportunity.selectionScore,
      price: opportunity.price ?? null,
      lastHistoryTimestamp: history[history.length - 1]?.timestamp ?? null,
      historyPoints: history.length,
    });

    const seed = Number.parseInt(
      createHash('sha256').update(seedMaterial).digest('hex').slice(0, 8),
      16,
    );

    return {
      id: opportunity.id,
      protocol: opportunity.protocol,
      pool: opportunity.pool,
      asset: opportunity.asset,
      grossAPY: opportunity.grossAPY,
      liquidityUSD: opportunity.liquidityUSD,
      riskScore: opportunity.riskScore,
      strategyType: opportunity.strategyType,
      verified: opportunity.metadata.verified,
      selectionScore: opportunity.selectionScore,
      price: opportunity.price,
      lpContext: opportunity.strategyType === 'LP'
        ? {
            pairType,
            ilRiskFlag: String((opportunity.metadata.extra as Record<string, unknown> | undefined)?.ilRisk ?? '').toLowerCase() === 'yes',
            feeTierBps: opportunity.metadata.feeTier,
            volumeToTvlRatio: volumeUsd7d > 0 && opportunity.liquidityUSD > 0 ? volumeUsd7d / opportunity.liquidityUSD : undefined,
          }
        : undefined,
      history: history.map(point => ({
        timestamp: point.timestamp,
        grossAPY: point.grossAPY,
        price: point.price,
        confidence: point.confidence,
        verdict: point.verdict,
        source: point.source,
      })),
      seed,
    };
  }

  async run(input: ChaosSimulationInput): Promise<ChaosSimulationResult> {
    const payload = JSON.stringify(input);

    return new Promise<ChaosSimulationResult>((resolve, reject) => {
      const child = spawn(this.pythonBin, [this.scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Chaos engine timed out after ${DEFAULT_TIMEOUT_MS}ms`));
      }, DEFAULT_TIMEOUT_MS);

      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });

      child.on('error', error => {
        clearTimeout(timeout);
        reject(error);
      });

      child.on('close', code => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Chaos engine exited with code ${code}`));
          return;
        }

        try {
          const parsed = JSON.parse(stdout.trim()) as ChaosSimulationResult;
          resolve(parsed);
        } catch (error) {
          reject(new Error(`Failed to parse chaos output: ${(error as Error).message}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`));
        }
      });

      child.stdin.write(payload);
      child.stdin.end();
    });
  }
}
