import { createWalletClient, getAddress, Hex, http } from 'viem';
import { AgentIDManager } from '../tee/agent-id';
import { zeroGTestnet } from '../transport/rpc-config';

export class PrivateSubmitter {
  public static resolveRpcEndpoint(): { url: string; mode: 'private' | 'public' } {
    const privateRpc = process.env.ZERO_G_PRIVATE_RPC;
    if (privateRpc) {
      return { url: privateRpc, mode: 'private' };
    }

    const publicRpc = process.env.ZERO_G_RPC || 'https://evmrpc-testnet.0g.ai';
    return { url: publicRpc, mode: 'public' };
  }

  
  public static async submitPrivately(params: {
    to: string;
    data: string;
    gasLimit: bigint;
  }): Promise<string> {
    const account = AgentIDManager.getAccount();
    const endpoint = this.resolveRpcEndpoint();

    console.log(
      `[RPC] Submitting transaction via ${endpoint.mode === 'private' ? 'private compute' : 'standard'} RPC...`
    );

    const client = createWalletClient({
      account,
      chain: zeroGTestnet,
      transport: http(endpoint.url),
    });

    const txHash = await client.sendTransaction({
      account,
      chain: zeroGTestnet,
      to: getAddress(params.to),
      data: params.data as Hex,
      gas: params.gasLimit,
    });

    console.log(
      `[RPC] Transaction submitted via ${endpoint.mode === 'private' ? 'private compute' : 'public fallback'} RPC: ${txHash}`
    );

    return txHash;
  }
}
