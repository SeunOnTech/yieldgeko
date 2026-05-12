/**
 * teeIntelligence.ts — 0G Compute TEE Market Intelligence
 *
 * Queries DeepSeek V3 running inside an Intel TDX + NVIDIA H100 TEE enclave
 * on the 0G Compute Network. Every response is cryptographically signed by
 * the enclave hardware — proving the decision was made privately and before
 * any transaction was submitted (no front-running possible).
 *
 * Proof chain:
 *   0G Compute TEE  →  signs decision (chatID + signerRA + chatSig URLs)
 *         ↓
 *   0G Storage      →  attestation blob stored (public, immutable)
 *         ↓
 *   0G Chain        →  attestCID anchored in YieldGekoRegistry forever
 *
 * The attestation blob is retrievable by CID. Any party can:
 *   1. Fetch signerRaUrl  → download the Intel TDX hardware attestation report
 *   2. Fetch chatSigUrl   → download the enclave signature for this specific response
 *   3. Verify independently: `ethers.recoverAddress(hashMessage(responseText), sig) === signerAddress`
 *
 * Fallback: if 0G Compute is unavailable (not funded, provider down), falls back
 * to local EIP-191 signing. Blob is clearly marked `mode: 'local-signing'` so
 * verifiers know which path was taken. Arbitrum execution is never blocked.
 *
 * Env vars:
 *   ZG_COMPUTE_PROVIDER_ADDRESS — provider on 0G Compute Network
 *   ZG_COMPUTE_MODEL            — model name (default: deepseek-chat)
 *   PRIVATE_KEY                 — agent wallet (ledger must be pre-funded with OG)
 *   RPC_URL                     — 0G Chain RPC (default: https://evmrpc.0g.ai)
 */

import * as dns    from 'node:dns';
import * as crypto from 'node:crypto';
import { ethers } from 'ethers';
import type { Opportunity, AllocationDecision } from './types';
import { detect0GConfig } from './persistence';

dns.setDefaultResultOrder('ipv4first');

// ── Config ────────────────────────────────────────────────────────────────────

const ZG_CHAIN_RPC        = process.env.RPC_URL ?? 'https://evmrpc.0g.ai';
const ZG_CHAIN_ID         = 16661;
const ZG_COMPUTE_PROVIDER = process.env.ZG_COMPUTE_PROVIDER_ADDRESS ?? '';
const ZG_COMPUTE_MODEL    = process.env.ZG_COMPUTE_MODEL ?? 'deepseek-chat';
const AGENT_PRIVATE_KEY   = process.env.PRIVATE_KEY ?? '';
const SCHEMA              = 'yieldgeko.tee.decision.v1' as const;

// ── Singleton broker ───────────────────────────────────────────────────────────

type Broker = Awaited<ReturnType<typeof import('@0gfoundation/0g-compute-ts-sdk').createZGComputeNetworkBroker>>;

let _broker: Broker | null = null;
let _brokerEndpoint: string | null = null;
let _brokerModel: string | null = null;
let _brokerFailed = false;

async function getBroker(): Promise<{ broker: Broker; endpoint: string; model: string } | null> {
  if (_brokerFailed) return null;
  if (!ZG_COMPUTE_PROVIDER || !AGENT_PRIVATE_KEY) return null;

  if (_broker && _brokerEndpoint && _brokerModel) {
    return { broker: _broker, endpoint: _brokerEndpoint, model: _brokerModel };
  }

  try {
    const { createZGComputeNetworkBroker } = await import('@0gfoundation/0g-compute-ts-sdk');
    const provider = new ethers.JsonRpcProvider(ZG_CHAIN_RPC, ZG_CHAIN_ID, { staticNetwork: true });
    const wallet   = new ethers.Wallet(AGENT_PRIVATE_KEY, provider);

    _broker = await createZGComputeNetworkBroker(wallet);

    // Ensure ledger exists — one-time setup, creates with 0.5 OG if missing
    try {
      await _broker.ledger.getLedger();
    } catch {
      console.log('[TEE] Creating 0G Compute ledger (one-time, 0.5 OG)...');
      await _broker.ledger.addLedger(3);
    }

    // Acknowledge provider signer — one-time, idempotent
    const acked = await _broker.inference.acknowledged(ZG_COMPUTE_PROVIDER).catch(() => false);
    if (!acked) {
      console.log('[TEE] Acknowledging 0G Compute provider signer...');
      await _broker.inference.acknowledgeProviderSigner(ZG_COMPUTE_PROVIDER);
    }

    const meta = await _broker.inference.getServiceMetadata(ZG_COMPUTE_PROVIDER);
    _brokerEndpoint = meta.endpoint;
    _brokerModel    = meta.model || ZG_COMPUTE_MODEL;

    console.log('[TEE] ✅ 0G Compute broker ready');
    console.log(`[TEE]    Provider:  ${ZG_COMPUTE_PROVIDER}`);
    console.log(`[TEE]    Endpoint:  ${_brokerEndpoint}`);
    console.log(`[TEE]    Model:     ${_brokerModel}`);

    return { broker: _broker, endpoint: _brokerEndpoint, model: _brokerModel };
  } catch (err: any) {
    _brokerFailed = true;
    console.warn(`[TEE] 0G Compute broker init failed (will use local fallback): ${err.message?.slice(0, 100)}`);
    return null;
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(opportunities: Opportunity[], policy: { minAPY: number; maxDrawdownPct: number }): string {
  const top5 = opportunities.slice(0, 5).map((o, i) => ({
    rank:         i + 1,
    pool:         `${o.protocol} ${o.pool}`,
    strategyType: o.strategyType,
    netAPY:       `${o.netAPY.toFixed(2)}%`,
    geckoScore:   o.geckoScore.toFixed(1),
    tvlUSD:       `$${(o.tvlUSD / 1e6).toFixed(1)}M`,
    emissionFrac: `${(o.emissionFraction * 100).toFixed(0)}%`,
    ilRisk:       o.risk.ilRisk ? 'yes' : 'no',
    trend:        o.history.trend,
  }));

  return `You are a DeFi yield validator for an autonomous agent. Respond in valid JSON only.

SCREENER TOP-5 (LVR-ranked, higher geckoScore = better):
${JSON.stringify(top5, null, 2)}

USER POLICY:
- Minimum net APY: ${policy.minAPY}%
- Maximum drawdown tolerance: ${policy.maxDrawdownPct}%

TASK: Validate the rank-1 candidate or select a better one from the list.
Consider: APY sustainability (emission fraction), IL risk, trend direction, TVL depth.
Do NOT suggest a pool outside the list.

Respond with this exact JSON:
{
  "confirmedRank": 1,
  "confidence": 85,
  "rationale": "One concise sentence explaining the decision.",
  "riskFlags": []
}`;
}

// ── TEE inference call ────────────────────────────────────────────────────────

interface TEECallResult {
  confirmedRank:   number;
  confidence:      number;
  rationale:       string;
  riskFlags:       string[];
  chatID:          string;
  signerRaUrl:     string;
  chatSignatureUrl: string;
  verified:        boolean | null;
  providerAddress: string;
  model:           string;
}

async function callTEE(
  opportunities: Opportunity[],
  policy: { minAPY: number; maxDrawdownPct: number },
): Promise<TEECallResult | null> {
  const ctx = await getBroker();
  if (!ctx) return null;

  const { broker, endpoint, model } = ctx;
  const prompt = buildPrompt(opportunities, policy);

  try {
    // 1. Get billing headers (signed proof of request)
    const headers = await broker.inference.getRequestHeaders(ZG_COMPUTE_PROVIDER, prompt);

    // 2. Call TEE inference endpoint
    const res = await fetch(`${endpoint}/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...headers } as Record<string, string>,
      body:    JSON.stringify({
        model,
        messages:    [{ role: 'user', content: prompt }],
        max_tokens:  300,
        temperature: 0.1,
      }),
    });

    if (!res.ok) throw new Error(`TEE inference HTTP ${res.status}: ${await res.text()}`);

    const data = await res.json() as any;
    const responseText = (data.choices?.[0]?.message?.content ?? '') as string;
    const chatID       = (data.id ?? '') as string;

    // 3. Parse TEE response
    let parsed: any = { confirmedRank: 1, confidence: 80, rationale: 'LVR top pick confirmed', riskFlags: [] };
    try {
      parsed = JSON.parse(responseText.replace(/```json|```/g, '').trim());
    } catch { /* use defaults */ }

    const confirmedRank = Math.max(1, Math.min(5, Number(parsed.confirmedRank ?? 1)));

    console.log(`[TEE] ✅ 0G Compute inference complete`);
    console.log(`[TEE]    chatID:    ${chatID}`);
    console.log(`[TEE]    Decision:  rank=${confirmedRank} confidence=${parsed.confidence}%`);
    console.log(`[TEE]    Rationale: ${parsed.rationale}`);

    // 4. Process response — on-chain settlement + TEE signature verification
    // New SDK: processResponse(provider, chatID, content) — args order changed in 0.8.x
    const verified = await broker.inference.processResponse(
      ZG_COMPUTE_PROVIDER,
      chatID,
      responseText,
    ).catch((e: any) => {
      console.warn('[TEE] processResponse warning (non-fatal):', e.message?.slice(0, 60));
      return null;
    });

    console.log(`[TEE]    Verified:  ${verified}`);

    // 5. Get attestation download links for the blob
    const [signerRaUrl, chatSignatureUrl] = await Promise.all([
      broker.inference.getSignerRaDownloadLink(ZG_COMPUTE_PROVIDER).catch(() => ''),
      chatID ? broker.inference.getChatSignatureDownloadLink(ZG_COMPUTE_PROVIDER, chatID).catch(() => '') : Promise.resolve(''),
    ]);

    return {
      confirmedRank,
      confidence:       Number(parsed.confidence ?? 80),
      rationale:        String(parsed.rationale ?? 'LVR top pick confirmed'),
      riskFlags:        Array.isArray(parsed.riskFlags) ? parsed.riskFlags : [],
      chatID,
      signerRaUrl,
      chatSignatureUrl,
      verified,
      providerAddress:  ZG_COMPUTE_PROVIDER,
      model,
    };
  } catch (err: any) {
    console.warn(`[TEE] 0G Compute call failed (falling back to local signing): ${err.message?.slice(0, 100)}`);
    return null;
  }
}

// ── Local EIP-191 fallback ────────────────────────────────────────────────────

async function localSignFallback(
  opportunities: Opportunity[],
  decision: AllocationDecision,
  userId: string,
  userAddress: string,
  receiptHash: string,
): Promise<{ signature: string; agentAddress: string }> {
  const wallet = new ethers.Wallet(AGENT_PRIVATE_KEY);
  const payload = {
    schema:      SCHEMA,
    mode:        'local-signing',
    userId,
    userAddress,
    action:      decision.action,
    receiptHash,
    selectedPool: decision.targetOpportunity
      ? `${decision.targetOpportunity.protocol} ${decision.targetOpportunity.pool}`
      : null,
    reason:      decision.reason,
    timestamp:   Date.now(),
  };
  const signature = await wallet.signMessage(JSON.stringify(payload));
  return { signature, agentAddress: wallet.address };
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface TEEAttestParams {
  opportunities: Opportunity[];
  decision:      AllocationDecision;
  userId:        string;
  userAddress:   string;
  receiptHash:   string;
}

export interface TEEAttestResult {
  attestCID: string;
  mode:      'tee-compute' | 'local-signing';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a TEE-attested decision blob and store it on 0G Storage.
 *
 * Primary path:  0G Compute TEE → DeepSeek V3 in TDX+H100 enclave → signed blob
 * Fallback path: local EIP-191 signing with agent wallet (clearly marked in blob)
 *
 * Non-fatal — returns null on any upload failure. Never blocks Arbitrum execution.
 */
export async function generateTEEAttestation(
  params: TEEAttestParams,
): Promise<TEEAttestResult | null> {
  if (!AGENT_PRIVATE_KEY) {
    console.warn('[TEE] PRIVATE_KEY not set — skipping attestation');
    return null;
  }

  const indexerUrl = process.env.INDEXER_URL;
  const evmRpcUrl  = process.env.RPC_URL;
  if (!indexerUrl || !evmRpcUrl) {
    console.warn('[TEE] INDEXER_URL / RPC_URL not set — skipping 0G Storage upload');
    return null;
  }

  const userPolicy = {
    minAPY:         params.decision.targetOpportunity?.netAPY ?? 5,
    maxDrawdownPct: 20,
  };

  // Try real 0G Compute TEE call first
  const teeResult = await callTEE(params.opportunities, userPolicy);

  let blob: Record<string, unknown>;
  let mode: 'tee-compute' | 'local-signing';

  if (teeResult) {
    // Primary path — real TEE attestation
    mode = 'tee-compute';
    const confirmedPool = params.opportunities[teeResult.confirmedRank - 1] ?? params.opportunities[0];
    blob = {
      schema:           SCHEMA,
      mode,
      providerAddress:  teeResult.providerAddress,
      model:            teeResult.model,
      chatID:           teeResult.chatID,
      verified:         teeResult.verified,
      signerRaUrl:      teeResult.signerRaUrl,
      chatSignatureUrl: teeResult.chatSignatureUrl,
      userId:           params.userId,
      userAddress:      params.userAddress,
      action:           params.decision.action,
      receiptHash:      params.receiptHash,
      screenerTop5:     params.opportunities.slice(0, 5).map((o, i) => ({
        rank:         i + 1,
        pool:         `${o.protocol} ${o.pool}`,
        strategyType: o.strategyType,
        netAPY:       o.netAPY,
        geckoScore:   o.geckoScore,
        selected:     o.id === confirmedPool.id,
      })),
      decision: {
        confirmedRank: teeResult.confirmedRank,
        confirmedPool: `${confirmedPool.protocol} ${confirmedPool.pool}`,
        confidence:    teeResult.confidence,
        rationale:     teeResult.rationale,
        riskFlags:     teeResult.riskFlags,
      },
      timestamp: Date.now(),
    };
  } else {
    // Fallback path — local EIP-191 signing
    mode = 'local-signing';
    const { signature, agentAddress } = await localSignFallback(
      params.opportunities,
      params.decision,
      params.userId,
      params.userAddress,
      params.receiptHash,
    );
    blob = {
      schema:       SCHEMA,
      mode,
      agentAddress,
      signature,
      userId:       params.userId,
      userAddress:  params.userAddress,
      action:       params.decision.action,
      receiptHash:  params.receiptHash,
      screenerTop5: params.opportunities.slice(0, 5).map((o, i) => ({
        rank:         i + 1,
        pool:         `${o.protocol} ${o.pool}`,
        strategyType: o.strategyType,
        netAPY:       o.netAPY,
        geckoScore:   o.geckoScore,
        selected:     o.id === (params.decision.targetOpportunity?.id ?? ''),
      })),
      decision: {
        action:     params.decision.action,
        targetPool: params.decision.targetOpportunity
          ? `${params.decision.targetOpportunity.protocol} ${params.decision.targetOpportunity.pool}`
          : null,
        reason:    params.decision.reason,
        upliftPct: params.decision.upliftPct,
      },
      timestamp: Date.now(),
    };
    console.log('[TEE] Fallback: EIP-191 signed attestation (0G Compute unavailable)');
  }

  // Upload to 0G Storage using the shared singleton signer (avoids nonce conflicts
  // with concurrent state-save and trace-upload transactions from the same wallet)
  const cfg = detect0GConfig();
  if (!cfg) {
    console.warn('[TEE] 0G Storage not configured — skipping attestation upload');
    return null;
  }

  try {
    const { persistJsonArtifact } = await import('../storage/persist');
    const artifact = await persistJsonArtifact(blob, {
      indexerUrl: cfg.indexerUrl,
      evmRpcUrl:  cfg.evmRpcUrl,
      signer:     cfg.signer,
    });

    console.log(`[TEE] ✅ Attestation stored on 0G Storage (mode: ${mode})`);
    console.log(`[TEE]    CID:         ${artifact.cid}`);
    console.log(`[TEE]    🔗 StorageScan: https://storagescan.0g.ai/submission/${artifact.txSeq}`);
    console.log(`[TEE]    🔗 ChainScan:   https://chainscan.0g.ai/tx/${artifact.txHash}`);

    return { attestCID: artifact.cid, mode };
  } catch (err: any) {
    console.warn('[TEE] 0G Storage upload failed:', err.message?.slice(0, 120));
    return null;
  }
}
