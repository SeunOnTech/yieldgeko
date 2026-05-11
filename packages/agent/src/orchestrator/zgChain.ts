/**
 * zgChain.ts — 0G Chain registry anchor
 *
 * After every agent execution (GENESIS, MIGRATE, REBALANCE, WITHDRAW),
 * anchors the receipt hash + 0G Storage CIDs into YieldGekoRegistry
 * on 0G Chain (chainId 16661).
 *
 * This creates a permanent public record on chainscan.0g.ai that anyone
 * can query to verify what the agent did and retrieve the full proof trace.
 *
 * Contract:  0xd7185a3Aa4b23EBE84e7bd60CF5e78B71dd21c8e
 * Explorer:  https://chainscan.0g.ai
 * Chain ID:  16661
 */

import * as dns from 'node:dns';
import { ethers } from 'ethers';

// 0G Chain uses IPv4 storage nodes — force preference
dns.setDefaultResultOrder('ipv4first');

// ── Config ────────────────────────────────────────────────────────────────────

const ZG_CHAIN_RPC        = process.env.RPC_URL ?? 'https://evmrpc.0g.ai';
const ZG_CHAIN_ID         = 16661;
const REGISTRY_ADDRESS    = process.env.ZG_REGISTRY_ADDRESS ?? '';
const AGENT_PRIVATE_KEY   = process.env.PRIVATE_KEY!;  // same wallet that deployed + has OG

// ── ABI (minimal — only what we call) ────────────────────────────────────────

const REGISTRY_ABI = [
  `function anchor(
    bytes32         receiptHash,
    address         userAddress,
    bytes32         strategyId,
    string calldata action,
    string calldata traceCID,
    string calldata attestCID
  ) external`,
  `event ProofAnchored(
    bytes32 indexed receiptHash,
    address indexed userAddress,
    bytes32 indexed strategyId,
    string  action,
    string  traceCID,
    string  attestCID,
    uint256 anchoredAt
  )`,
];

// ── Singleton provider + contract ─────────────────────────────────────────────

let _contract: ethers.Contract | null = null;

function getContract(): ethers.Contract | null {
  if (!REGISTRY_ADDRESS) {
    console.warn('[0GChain] ZG_REGISTRY_ADDRESS not set — skipping anchor');
    return null;
  }
  if (_contract) return _contract;
  try {
    const provider = new ethers.JsonRpcProvider(ZG_CHAIN_RPC, ZG_CHAIN_ID, { staticNetwork: true });
    const signer   = new ethers.Wallet(AGENT_PRIVATE_KEY, provider);
    _contract      = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, signer);
    return _contract;
  } catch (err: any) {
    console.warn('[0GChain] Failed to initialise registry contract:', err.message);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface AnchorParams {
  receiptHash:  string;   // 0x-prefixed bytes32
  userAddress:  string;   // Arbitrum wallet of the user
  strategyId?:  string;   // bytes32 strategy scope (0x0 = default single strategy)
  action:       'GENESIS' | 'MIGRATE' | 'REBALANCE' | 'WITHDRAW';
  traceCID:     string;   // 0G Storage CID of execution trace
  attestCID?:   string;   // 0G Storage CID of TEE attestation (empty if not available)
}

export interface AnchorResult {
  txHash:      string;
  explorerUrl: string;
}

/**
 * Anchor an execution proof on 0G Chain.
 * Non-fatal — returns null and logs a warning on any failure.
 * The Arbitrum execution has already succeeded at this point; anchoring
 * is a proof layer, not a blocker.
 */
export async function anchorExecutionProof(params: AnchorParams): Promise<AnchorResult | null> {
  const contract = getContract();
  if (!contract) return null;

  const strategyId = params.strategyId ?? ethers.ZeroHash;
  const attestCID  = params.attestCID  ?? '';

  // Truncate CIDs to MAX_CID_LEN=128 if needed (contract enforces this)
  const traceCID  = params.traceCID.slice(0, 128);
  const attestCIDSafe = attestCID.slice(0, 128);

  try {
    const tx      = await contract.anchor(
      params.receiptHash,
      params.userAddress,
      strategyId,
      params.action,
      traceCID,
      attestCIDSafe,
    );
    const receipt     = await tx.wait(1);
    const txHash      = receipt.hash as string;
    const explorerUrl = `https://chainscan.0g.ai/tx/${txHash}`;

    console.log(`[0GChain] ✅ Anchored ${params.action} for ${params.userAddress.slice(0, 10)}… → ${explorerUrl}`);
    return { txHash, explorerUrl };
  } catch (err: any) {
    // AlreadyAnchored is expected on retry — not a real error
    if (err.message?.includes('AlreadyAnchored')) {
      console.log(`[0GChain] Already anchored: ${params.receiptHash.slice(0, 14)}… (idempotent, ok)`);
      return null;
    }
    console.warn(`[0GChain] Anchor failed (non-fatal): ${err.message?.slice(0, 120)}`);
    return null;
  }
}
