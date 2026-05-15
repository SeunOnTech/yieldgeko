

import * as dns from 'node:dns';
import { ethers } from 'ethers';
import type { Opportunity, AllocationDecision } from './types';
import { detect0GConfig } from './persistence';

dns.setDefaultResultOrder('ipv4first');

const ZG_CHAIN_ID         = 16661;
const SCHEMA              = 'yieldgeko.tee.decision.v1' as const;

function getZGChainRpc(): string {
  return process.env.RPC_URL ?? 'https://evmrpc.0g.ai';
}

function getComputeProviderAddress(): string {
  return process.env.ZG_COMPUTE_PROVIDER_ADDRESS ?? '';
}

function getComputeModel(): string {
  return process.env.ZG_COMPUTE_MODEL ?? 'deepseek-chat';
}

function getAgentPrivateKey(): string {
  return process.env.PRIVATE_KEY ?? '';
}

type Broker = Awaited<ReturnType<typeof import('@0gfoundation/0g-compute-ts-sdk').createZGComputeNetworkBroker>>;

let _broker: Broker | null = null;
let _brokerEndpoint: string | null = null;
let _brokerModel: string | null = null;
let _brokerFailedUntil = 0;   

export function resetBroker(): void {
  _broker         = null;
  _brokerEndpoint = null;
  _brokerModel    = null;
  _brokerFailedUntil = 0;
}

async function getBroker(): Promise<{ broker: Broker; endpoint: string; model: string } | null> {
  const computeProvider = getComputeProviderAddress();
  const agentPrivateKey = getAgentPrivateKey();
  if (Date.now() < _brokerFailedUntil) return null;
  if (!computeProvider || !agentPrivateKey) return null;

  if (_broker && _brokerEndpoint && _brokerModel) {
    return { broker: _broker, endpoint: _brokerEndpoint, model: _brokerModel };
  }

  try {
    const { createZGComputeNetworkBroker } = await import('@0gfoundation/0g-compute-ts-sdk');
    const provider = new ethers.JsonRpcProvider(getZGChainRpc(), ZG_CHAIN_ID, { staticNetwork: true });
    const wallet   = new ethers.Wallet(agentPrivateKey, provider);

    const balance = await provider.getBalance(wallet.address);
    const minBalance = ethers.parseEther('1');
    if (balance < minBalance) {
      throw new Error(`Insufficient 0G balance: need ≥1 OG, have ${ethers.formatEther(balance)} OG — fund ${wallet.address} on 0G Chain`);
    }

    _broker = await createZGComputeNetworkBroker(wallet);

    try {
      await _broker.ledger.getLedger();
    } catch {
      console.log('[TEE] Creating 0G Compute ledger (one-time setup)...');
      await _broker.ledger.addLedger(3);
    }

    
    const acked = await _broker.inference.acknowledged(computeProvider).catch(() => false);
    if (!acked) {
      console.log('[TEE] Acknowledging 0G Compute provider signer...');
      await _broker.inference.acknowledgeProviderSigner(computeProvider);
    }

    const meta = await _broker.inference.getServiceMetadata(computeProvider);
    _brokerEndpoint = meta.endpoint;
    _brokerModel    = meta.model || getComputeModel();

    console.log('[TEE] ✅ 0G Compute broker ready');
    console.log(`[TEE]    Provider:  ${computeProvider}`);
    console.log(`[TEE]    Endpoint:  ${_brokerEndpoint}`);
    console.log(`[TEE]    Model:     ${_brokerModel}`);

    return { broker: _broker, endpoint: _brokerEndpoint, model: _brokerModel };
  } catch (err: any) {
    _brokerFailedUntil = Date.now() + 5 * 60 * 1000;  
    console.warn(`[TEE] 0G Compute broker init failed (will retry in 5 min): ${err.message?.slice(0, 100)}`);
    return null;
  }
}

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
  const computeProvider = getComputeProviderAddress();
  const prompt = buildPrompt(opportunities, policy);

  try {
    
    const headers = await broker.inference.getRequestHeaders(computeProvider, prompt);

    
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
    const responseKeyHeader = res.headers.get('ZG-Res-Key') || res.headers.get('zg-res-key') || '';
    const chatID = (responseKeyHeader || data.id || '') as string;

    
    let parsed: any = { confirmedRank: 1, confidence: 80, rationale: 'LVR top pick confirmed', riskFlags: [] };
    try {
      parsed = JSON.parse(responseText.replace(/```json|```/g, '').trim());
    } catch {  }

    const confirmedRank = Math.max(1, Math.min(5, Number(parsed.confirmedRank ?? 1)));

    console.log(`[TEE] ✅ 0G Compute inference complete`);
    console.log(`[TEE]    chatID:    ${chatID}`);
    console.log(`[TEE]    Decision:  rank=${confirmedRank} confidence=${parsed.confidence}%`);
    console.log(`[TEE]    Rationale: ${parsed.rationale}`);

    
    
    const verified = await broker.inference.processResponse(
      computeProvider,
      chatID,
      responseText,
    ).catch((e: any) => {
      console.warn('[TEE] processResponse warning (non-fatal):', e.message?.slice(0, 60));
      return null;
    });

    console.log(`[TEE]    Verified:  ${verified}`);

    
    const [signerRaUrl, chatSignatureUrl] = await Promise.all([
      broker.inference.getSignerRaDownloadLink(computeProvider).catch(() => ''),
      chatID ? broker.inference.getChatSignatureDownloadLink(computeProvider, chatID).catch(() => '') : Promise.resolve(''),
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
      providerAddress:  computeProvider,
      model,
    };
  } catch (err: any) {
    console.warn(`[TEE] 0G Compute call failed (falling back to local signing): ${err.message?.slice(0, 100)}`);
    return null;
  }
}

async function localSignFallback(
  _opportunities: Opportunity[],
  decision: AllocationDecision,
  userId: string,
  userAddress: string,
  receiptHash: string,
): Promise<{ signature: string; agentAddress: string; signedPayload: string }> {
  const wallet = new ethers.Wallet(getAgentPrivateKey());
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
  const signedPayload = JSON.stringify(payload);
  const signature = await wallet.signMessage(signedPayload);
  return { signature, agentAddress: wallet.address, signedPayload };
}

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

export async function generateTEEAttestation(
  params: TEEAttestParams,
): Promise<TEEAttestResult | null> {
  if (!getAgentPrivateKey()) {
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

  
  const teeResult = await callTEE(params.opportunities, userPolicy);

  let blob: Record<string, unknown>;
  let mode: 'tee-compute' | 'local-signing';

  if (teeResult) {
    
    mode = 'tee-compute';
    const confirmedPool = params.opportunities[teeResult.confirmedRank - 1] ?? params.opportunities[0];
    const confirmedPoolLabel = confirmedPool
      ? `${confirmedPool.protocol} ${confirmedPool.pool}`
      : 'No opportunity list supplied';
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
        selected:     confirmedPool ? o.id === confirmedPool.id : false,
      })),
      decision: {
        confirmedRank: teeResult.confirmedRank,
        confirmedPool: confirmedPoolLabel,
        confidence:    teeResult.confidence,
        rationale:     teeResult.rationale,
        riskFlags:     teeResult.riskFlags,
      },
      timestamp: Date.now(),
    };
  } else {
    
    mode = 'local-signing';
    const { signature, agentAddress, signedPayload } = await localSignFallback(
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
      signedPayload,
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
