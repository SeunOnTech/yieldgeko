/**
 * ERC-4337 Account Abstraction layer for YieldGeko agent.
 *
 * Uses Pimlico's Verifying Paymaster (sponsorship model):
 *   - YieldGeko sponsors all gas — users never touch ETH
 *   - Agent wallet never needs an ETH float for Aave/Morpho/Pendle/UniV3
 *   - GMX keeper fee (0.001 ETH) is the only ETH the smart account needs to hold
 *   - Pimlico bills YieldGeko's account balance (top up at dashboard.pimlico.io)
 *
 * Architecture:
 *   Agent EOA private key  → signs UserOperations (same key, different signing context)
 *   Simple Smart Account   → the on-chain sender (deterministic address from key + salt)
 *   Pimlico bundler        → packages UserOps into regular txns, pays gas
 *   Pimlico paymaster      → sponsors the gas cost, Pimlico bills YieldGeko's account
 *
 * Fallback: if Pimlico is unreachable (network error, API down), every call automatically
 * falls back to direct EOA submission so the agent never stalls.
 *
 * Simple Account factory (v0.7 EntryPoint): 0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985
 * EntryPoint v0.7:                          0x0000000071727De22E5E9d8BAf0edAc6f37da032
 */

import {
  createPublicClient,
  http,
  type Hash,
} from 'viem';
import { createPaymasterClient } from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import { toSimpleSmartAccount } from 'permissionless/accounts';
import { createSmartAccountClient, type SmartAccountClient } from 'permissionless';
import { createPimlicoClient } from 'permissionless/clients/pimlico';

// ── Constants ─────────────────────────────────────────────────────────────────

const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const;

function pimlicoRpcUrl(apiKey: string, chain: string = 'arbitrum'): string {
  return `https://api.pimlico.io/v2/${chain}/rpc?apikey=${apiKey}`;
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface PimlicoLayer {
  /**
   * Submit a sponsored vault call via ERC-4337 UserOperation.
   * Pimlico pays the ETH gas; YieldGeko's Pimlico account is debited.
   * Returns the bundle transaction hash (regular Ethereum tx hash).
   */
  sendVaultCall(
    vaultAddress: string,
    calldata:     string,
    value:        bigint,
  ): Promise<string>;

  /**
   * Submit a sponsored call to ANY contract (e.g. USDC.permit on behalf of agent).
   * Same sponsorship model as sendVaultCall.
   */
  sendCall(
    to:       string,
    calldata: string,
    value:    bigint,
  ): Promise<string>;

  /** Deterministic smart account address (set this as vault.authorizedAgent at deploy time) */
  readonly smartAccountAddress: string;
}

// ── Implementation ────────────────────────────────────────────────────────────

class PimlicoLayerImpl implements PimlicoLayer {
  private readonly client: SmartAccountClient;
  readonly smartAccountAddress: string;

  constructor(client: SmartAccountClient, address: string) {
    this.client             = client;
    this.smartAccountAddress = address;
  }

  async sendVaultCall(
    vaultAddress: string,
    calldata:     string,
    value:        bigint,
  ): Promise<string> {
    // sendTransaction on the SmartAccountClient:
    //   1. Builds a UserOperation wrapping this call
    //   2. Fetches gas limits from Pimlico's bundler
    //   3. Gets sponsorship data from Pimlico's verifying paymaster
    //   4. Signs the UserOperation with the owner EOA
    //   5. Submits to Pimlico's bundler (eth_sendUserOperation)
    //   6. Waits for the bundle tx to be confirmed
    //   7. Returns the confirmed bundle tx hash
    const txHash = await (this.client as any).sendTransaction({
      to:    vaultAddress as `0x${string}`,
      data:  calldata     as `0x${string}`,
      value,
    }) as Hash;

    return txHash;
  }

  async sendCall(to: string, calldata: string, value: bigint): Promise<string> {
    const txHash = await (this.client as any).sendTransaction({
      to:   to       as `0x${string}`,
      data: calldata as `0x${string}`,
      value,
    }) as Hash;
    return txHash;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Initialise the Pimlico layer.
 * Called once at agent startup — async because it derives the smart account address
 * from the chain (counterfactual deployment lookup).
 */
export async function initPimlicoLayer(
  ownerPrivateKey: string,
  pimlicoApiKey:   string,
  arbRpcUrl:       string,
): Promise<PimlicoLayer> {
  const rpcUrl = pimlicoRpcUrl(pimlicoApiKey);

  // Public client for Arbitrum RPC reads (nonce, block, etc.)
  const publicClient = createPublicClient({
    chain:     arbitrum,
    transport: http(arbRpcUrl),
  });

  // Pimlico client — bundler + paymaster actions on the same endpoint
  const pimlicoClient = createPimlicoClient({
    transport: http(rpcUrl),
    entryPoint: {
      address: ENTRY_POINT_V07,
      version: '0.7',
    },
  });

  // Paymaster client — calls pm_getPaymasterData / pm_getPaymasterStubData
  // Using createPaymasterClient from viem (Pimlico's endpoint implements this)
  const paymasterClient = createPaymasterClient({
    transport: http(rpcUrl),
  });

  // Owner: same private key as the agent EOA, now used as smart account owner
  const owner = privateKeyToAccount(ownerPrivateKey as `0x${string}`);

  // Simple Smart Account — counterfactual address, deployed on first UserOp
  const account = await toSimpleSmartAccount({
    owner,
    client:     publicClient,
    entryPoint: {
      address: ENTRY_POINT_V07,
      version: '0.7',
    },
  });

  // Smart account client — wires account + bundler + paymaster together
  const smartAccountClient = createSmartAccountClient({
    account,
    chain:            arbitrum,
    bundlerTransport: http(rpcUrl),
    paymaster:        paymasterClient,   // Pimlico verifying paymaster sponsors all gas
    userOperation: {
      estimateFeesPerGas: async () => {
        // Use Pimlico's real-time gas price oracle for accurate fee estimates
        const price = await pimlicoClient.getUserOperationGasPrice();
        return price.fast;
      },
    },
  });

  return new PimlicoLayerImpl(smartAccountClient, account.address);
}

/**
 * Initialise Pimlico if PIMLICO_API_KEY is set, otherwise return null.
 * Errors are logged but never thrown — agent continues with EOA fallback.
 */
export async function initPimlicoIfConfigured(
  ownerPrivateKey: string,
  arbRpcUrl:       string,
): Promise<PimlicoLayer | null> {
  const apiKey = process.env.PIMLICO_API_KEY;
  if (!apiKey) return null;

  try {
    const layer = await initPimlicoLayer(ownerPrivateKey, apiKey, arbRpcUrl);
    console.log(
      `[ERC-4337] Pimlico sponsorship active.\n` +
      `           Smart account: ${layer.smartAccountAddress}\n` +
      `           ↳ Use this address as AGENT in vault constructor (not the EOA)\n` +
      `           ↳ Fund with ~0.05 ETH for GMX keeper fees`,
    );
    return layer;
  } catch (err: any) {
    console.warn('[ERC-4337] Pimlico init failed — falling back to EOA gas:', err.message);
    return null;
  }
}
