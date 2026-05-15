

import { ethers }                    from 'ethers';
import type { Opportunity, AllocationDecision, ProofUpdatePayload } from './types';
import { uploadExecutionTrace }      from './persistence';
import { generateTEEAttestation, resetBroker } from './teeIntelligence';
import { anchorExecutionProof }      from './zgChain';
import { getJournal }                from './journal';
import { broadcastToUser }           from './sse';

const MAX_ATTEMPTS  = 15;
const BASE_DELAY_MS = 4_000;    
const MAX_DELAY_MS  = 5 * 60_000; 

function backoffMs(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
}

function strategyScope(userId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(userId));
}

export interface ProofTaskInput {
  userId:         string;
  userAddress:    string;
  receiptHash:    string;
  arbitrumTxHash: string;
  action:         'GENESIS' | 'MIGRATE' | 'REBALANCE' | 'WITHDRAW' | 'HARVEST';
  timestamp:      number;
  amountUSD?:     number;
  poolAddress?:   string;
  screenerTop5?:  Opportunity[];
  teeDecision?:   AllocationDecision;   
}

interface ProofTask extends ProofTaskInput {
  taskId:         string;
  attempts:       number;
  nextRetryAt:    number;
  done:           boolean;
  
  zgTraceCID?:    string;
  zgAttestCID?:   string;
  zgChainTxHash?: string;
  zgChainExplorer?: string;
}

class ProofService {
  private readonly queue: ProofTask[] = [];
  private tickTimer: ReturnType<typeof setTimeout> | null = null;

  

  submit(input: ProofTaskInput): void {
    const task: ProofTask = {
      ...input,
      taskId:      `${input.userId.slice(-8)}-${input.receiptHash.slice(2, 10)}-${Date.now()}`,
      attempts:    0,
      nextRetryAt: Date.now(),   
      done:        false,
    };
    this.queue.push(task);
    console.log(`[ProofService] ⬡ Queued ${task.action} proof for ${task.userId.slice(0, 14)}… (taskId: ${task.taskId})`);
    this.scheduleTick(50);
  }

  

  private scheduleTick(delayMs = 1000): void {
    if (this.tickTimer) return;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      this.processTick().catch(e => console.warn('[ProofService] tick error:', e.message));
    }, delayMs);
  }

  private async processTick(): Promise<void> {
    const now  = Date.now();
    const ready = this.queue.filter(t => !t.done && t.nextRetryAt <= now);

    await Promise.allSettled(ready.map(t => this.processTask(t)));

    
    const alive = this.queue.filter(t => !t.done);
    this.queue.length = 0;
    this.queue.push(...alive);

    if (alive.length > 0) {
      const nextWake = Math.max(500, Math.min(...alive.map(t => t.nextRetryAt)) - Date.now());
      this.scheduleTick(nextWake);
    }
  }

  

  private async processTask(task: ProofTask): Promise<void> {
    task.attempts++;
    console.log(`[ProofService] Attempt ${task.attempts}/${MAX_ATTEMPTS} — ${task.action} ${task.taskId}`);

    
    if (task.attempts > 1) resetBroker();

    try {
      
      const needsTrace  = !task.zgTraceCID;
      const needsAttest = !task.zgAttestCID
        && !!task.screenerTop5?.length
        && !!task.teeDecision;

      const [traceResult, attestResult] = await Promise.allSettled([
        needsTrace
          ? uploadExecutionTrace({
              action:         task.action,
              userId:         task.userId,
              userAddress:    task.userAddress,
              receiptHash:    task.receiptHash,
              arbitrumTxHash: task.arbitrumTxHash,
              timestamp:      task.timestamp,
              screenerTop5:   task.screenerTop5,
              teeDecision:    task.teeDecision as any,
              poolAddress:    task.poolAddress,
              amountUSD:      task.amountUSD,
            })
          : Promise.resolve(task.zgTraceCID!),

        needsAttest
          ? generateTEEAttestation({
              opportunities: task.screenerTop5!,
              decision:      task.teeDecision!,
              userId:        task.userId,
              userAddress:   task.userAddress,
              receiptHash:   task.receiptHash,
            }).then(r => r?.attestCID ?? null)
          : Promise.resolve(task.zgAttestCID ?? null),
      ]);

      
      if (traceResult.status === 'fulfilled' && traceResult.value && !task.zgTraceCID) {
        task.zgTraceCID = traceResult.value;
        this.pushUpdate(task, 'trace', task.zgTraceCID);
      } else if (traceResult.status === 'rejected') {
        console.warn(`[ProofService] trace upload failed: ${(traceResult as any).reason?.message?.slice(0, 80)}`);
      }

      if (attestResult.status === 'fulfilled' && attestResult.value && !task.zgAttestCID) {
        task.zgAttestCID = attestResult.value;
        this.pushUpdate(task, 'attest', task.zgAttestCID);
      } else if (attestResult.status === 'rejected') {
        console.warn(`[ProofService] TEE attest failed: ${(attestResult as any).reason?.message?.slice(0, 80)}`);
      }

      
      if (!task.zgChainTxHash && task.zgTraceCID) {
        const anchor = await anchorExecutionProof({
          receiptHash: task.receiptHash,
          userAddress: task.userAddress,
          strategyId:  strategyScope(task.userId),
          action:      task.action,
          traceCID:    task.zgTraceCID,
          attestCID:   task.zgAttestCID ?? '',
        });

        if (anchor) {
          task.zgChainTxHash   = anchor.txHash;
          task.zgChainExplorer = anchor.explorerUrl;
          this.pushUpdate(task, 'anchor', anchor.txHash, anchor.explorerUrl);
        } else {
          console.warn('[ProofService] anchor returned null — will retry');
        }
      }

      
      
      
      const needsAttestForAction = !!task.screenerTop5?.length && !!task.teeDecision;
      const traceOk   = !!task.zgTraceCID;
      const anchorOk  = !!task.zgChainTxHash;
      const attestOk  = !needsAttestForAction || !!task.zgAttestCID;

      if (traceOk && anchorOk && attestOk) {
        task.done = true;
        console.log(`[ProofService] ✅ All proofs complete for ${task.taskId}`);
        
        this.flushJournal(task);
        return;
      }

      
      if (task.attempts >= MAX_ATTEMPTS) {
        console.error(
          `[ProofService] ❌ ${task.taskId} exhausted ${MAX_ATTEMPTS} attempts — ` +
          `trace=${traceOk} anchor=${anchorOk} attest=${attestOk}. Giving up.`,
        );
        task.done = true;
        return;
      }

      task.nextRetryAt = Date.now() + backoffMs(task.attempts);
      console.log(`[ProofService] Retry scheduled in ${Math.round(backoffMs(task.attempts) / 1000)}s`);

    } catch (err: any) {
      console.warn(`[ProofService] Unexpected error on attempt ${task.attempts}: ${err.message?.slice(0, 100)}`);
      if (task.attempts >= MAX_ATTEMPTS) { task.done = true; return; }
      task.nextRetryAt = Date.now() + backoffMs(task.attempts);
    }
  }

  

  private snapshot(task: ProofTask): ProofUpdatePayload['snapshot'] {
    return {
      arbitrumTxHash:  task.arbitrumTxHash,
      zgTraceCID:      task.zgTraceCID,
      zgAttestCID:     task.zgAttestCID,
      zgChainTxHash:   task.zgChainTxHash,
      zgChainExplorer: task.zgChainExplorer,
    };
  }

  private pushUpdate(
    task:       ProofTask,
    step:       ProofUpdatePayload['step'],
    value:      string,
    explorerUrl?: string,
  ): void {
    
    this.flushJournal(task);

    
    const payload: ProofUpdatePayload = {
      userId:      task.userId,
      receiptHash: task.receiptHash,
      action:      task.action,
      step,
      value,
      explorerUrl,
      snapshot:    this.snapshot(task),
    };
    broadcastToUser(task.userId, { type: 'PROOF_UPDATE', ts: Date.now(), payload });
    console.log(`[ProofService] → PROOF_UPDATE(${step}) sent for ${task.userId.slice(0, 14)}…`);
  }

  private flushJournal(task: ProofTask): void {
    if (!task.zgTraceCID && !task.zgAttestCID && !task.zgChainTxHash) return;
    try {
      getJournal().updateExecution(task.userId, task.receiptHash, {
        zgTraceCID:      task.zgTraceCID,
        zgAttestCID:     task.zgAttestCID,
        zgChainTxHash:   task.zgChainTxHash,
        zgChainExplorer: task.zgChainExplorer,
      });
    } catch (e: any) {
      console.warn('[ProofService] journal flush failed:', e.message?.slice(0, 60));
    }
  }
}

export const proofService = new ProofService();
