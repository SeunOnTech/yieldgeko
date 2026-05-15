

import * as dns from 'node:dns';
import { ethers } from 'ethers';

dns.setDefaultResultOrder('ipv4first');

const ZG_CHAIN_RPC = process.env.RPC_URL ?? 'https://evmrpc.0g.ai';
const ZG_CHAIN_ID  = 16661;

function getRegistryAddress(): string { return process.env.ZG_REGISTRY_ADDRESS ?? ''; }
function getAgentPrivateKey(): string  { return process.env.PRIVATE_KEY ?? ''; }

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

let _contract: ethers.Contract | null = null;

function getContract(): ethers.Contract | null {
  const addr = getRegistryAddress();
  if (!addr) {
    console.warn('[0GChain] ZG_REGISTRY_ADDRESS not set — skipping anchor');
    return null;
  }
  if (_contract) return _contract;
  try {
    const pk = getAgentPrivateKey();
    if (!pk) { console.warn('[0GChain] PRIVATE_KEY not set — skipping anchor'); return null; }
    const provider = new ethers.JsonRpcProvider(ZG_CHAIN_RPC, ZG_CHAIN_ID, { staticNetwork: true });
    const signer   = new ethers.Wallet(pk, provider);
    _contract      = new ethers.Contract(addr, REGISTRY_ABI, signer);
    return _contract;
  } catch (err: any) {
    console.warn('[0GChain] Failed to initialise registry contract:', err.message);
    return null;
  }
}

export interface AnchorParams {
  receiptHash:  string;   
  userAddress:  string;   
  strategyId?:  string;   
  action:       'GENESIS' | 'MIGRATE' | 'REBALANCE' | 'WITHDRAW' | 'HARVEST' | 'REGISTER' | 'DEPOSIT';
  traceCID:     string;   
  attestCID?:   string;   
}

export interface AnchorResult {
  txHash:      string;
  explorerUrl: string;
}

export async function anchorExecutionProof(params: AnchorParams): Promise<AnchorResult | null> {
  const contract = getContract();
  if (!contract) return null;

  const strategyId = params.strategyId ?? ethers.ZeroHash;
  const attestCID  = params.attestCID  ?? '';

  
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
    
    if (err.message?.includes('AlreadyAnchored')) {
      console.log(`[0GChain] Already anchored: ${params.receiptHash.slice(0, 14)}… (idempotent, ok)`);
      return null;
    }
    console.warn(`[0GChain] Anchor failed (non-fatal): ${err.message?.slice(0, 120)}`);
    return null;
  }
}
