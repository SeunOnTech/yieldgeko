import { AgentIDManager } from './agent-id'
import { POLICY_TYPES, type PolicyMessage } from '@yieldgeko/core'
import { Hex } from 'viem'

export class TEESigner {
  static async signPolicy(
    domain: { name: string; version: string; chainId: bigint; verifyingContract: Hex },
    message: PolicyMessage
  ): Promise<Hex> {
    const account = AgentIDManager.getAccount()
    const signature = await account.signTypedData({
      domain,
      types: POLICY_TYPES,
      primaryType: 'Policy',
      message,
    })
    return signature
  }
}
