/**
 * YieldGeko Verification Engine
 *
 * Verifies that an off-chain receipt stored in 0G Storage matches
 * the receiptHash anchored on-chain via the ActionExecuted event.
 *
 * Chain selection: receipts from Arbitrum executions use the Arbitrum client;
 * receipts from 0G Mainnet executions use the 0G client. The caller passes
 * the chainId alongside the txHash so verification always hits the right chain.
 */

import { storageService } from './storage'
import { createPublicClient, decodeEventLog, defineChain, http, type Hex } from 'viem'
import { VAULT_ADDRESS } from '../config'
import { yieldGekoAbi } from '../src/generated'

export interface VerificationResult {
  isValid: boolean
  computedHash: string
  onChainHash: string
  data?: unknown
  error?: string
}

// ── Chain definitions ─────────────────────────────────────────────────────────

const arbitrumChain = defineChain({
  id: 42161,
  name: 'Arbitrum One',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://arb1.arbitrum.io/rpc'] } },
  blockExplorers: { default: { name: 'Arbiscan', url: 'https://arbiscan.io' } },
})

const zeroGMainnetChain = defineChain({
  id: 16661,
  name: '0G Mainnet',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_0G_RPC_URL ?? 'https://evmrpc.0g.ai'] },
  },
  blockExplorers: {
    default: { name: '0G Explorer', url: process.env.NEXT_PUBLIC_0G_EXPLORER ?? 'https://chainscan.0g.ai' },
  },
})

function clientForChain(chainId: number) {
  if (chainId === 16661) {
    return createPublicClient({ chain: zeroGMainnetChain, transport: http() })
  }
  // Default: Arbitrum (where DeFi executions happen)
  return createPublicClient({ chain: arbitrumChain, transport: http() })
}

// ── Verifier ──────────────────────────────────────────────────────────────────

export class Verifier {
  public static async computeHash(data: Record<string, unknown>): Promise<string> {
    const sortedKeys = Object.keys(data).sort()
    const canonical = JSON.stringify(data, sortedKeys)
    const msgUint8 = new TextEncoder().encode(canonical)
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return '0x' + hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  private static async getOnChainReceiptHash(txHash: Hex, chainId: number): Promise<string> {
    const client = clientForChain(chainId)
    const receipt = await client.getTransactionReceipt({ hash: txHash })

    for (const log of receipt.logs) {
      // Filter to only logs from the vault contract if we have a known address
      if (VAULT_ADDRESS && log.address.toLowerCase() !== VAULT_ADDRESS.toLowerCase()) {
        continue
      }

      try {
        const decoded = decodeEventLog({
          abi: yieldGekoAbi,
          data: log.data,
          topics: log.topics,
        })

        if (decoded.eventName === 'ActionExecuted') {
          return (decoded.args as { receiptHash: Hex }).receiptHash
        }
      } catch {
        // Ignore unrelated logs
      }
    }

    throw new Error(`No ActionExecuted event found in transaction ${txHash} on chain ${chainId}`)
  }

  /**
   * @param cid     Root hash from 0G Storage upload
   * @param txHash  On-chain settlement tx that emitted ActionExecuted
   * @param chainId Chain where the tx was confirmed (default: 42161 Arbitrum)
   */
  public static async verifyReceipt(
    cid: string,
    txHash: Hex,
    chainId: number = 42161,
  ): Promise<VerificationResult> {
    try {
      const data = await storageService.retrieveData<Record<string, unknown>>(cid)
      const computedHash = await this.computeHash(data)
      const onChainHash = await this.getOnChainReceiptHash(txHash, chainId)
      const isValid = computedHash.toLowerCase() === onChainHash.toLowerCase()

      return { isValid, computedHash, onChainHash, data }
    } catch (error) {
      return {
        isValid: false,
        computedHash: '',
        onChainHash: '',
        error: error instanceof Error ? error.message : `Verification failed: ${String(error)}`,
      }
    }
  }
}
