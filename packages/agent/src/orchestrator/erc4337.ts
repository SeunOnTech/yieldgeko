

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

const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const;

function pimlicoRpcUrl(apiKey: string, chainId: number = 42161): string {
  return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${apiKey}`;
}

export interface PimlicoLayer {
  
  sendVaultCall(
    vaultAddress: string,
    calldata:     string,
    value:        bigint,
  ): Promise<string>;

  
  sendCall(
    to:       string,
    calldata: string,
    value:    bigint,
  ): Promise<string>;

  
  sendBatch(
    calls: Array<{ to: string; calldata: string; value: bigint }>,
  ): Promise<string>;

  
  readonly smartAccountAddress: string;
}

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

  async sendBatch(calls: Array<{ to: string; calldata: string; value: bigint }>): Promise<string> {
    const userOpHash = await (this.client as any).sendUserOperation({
      calls: calls.map(c => ({
        to:    c.to       as `0x${string}`,
        data:  c.calldata as `0x${string}`,
        value: c.value,
      })),
    }) as Hash;
    
    
    const opReceipt = await (this.client as any).waitForUserOperationReceipt({
      hash: userOpHash,
    });
    return opReceipt.receipt.transactionHash as string;
  }
}

export async function initPimlicoLayer(
  ownerPrivateKey: string,
  pimlicoApiKey:   string,
  arbRpcUrl:       string,
): Promise<PimlicoLayer> {
  const rpcUrl = pimlicoRpcUrl(pimlicoApiKey);

  
  const publicClient = createPublicClient({
    chain:     arbitrum,
    transport: http(arbRpcUrl),
  });

  
  const pimlicoClient = createPimlicoClient({
    transport: http(rpcUrl),
    entryPoint: {
      address: ENTRY_POINT_V07,
      version: '0.7',
    },
  });

  
  
  const paymasterClient = createPaymasterClient({
    transport: http(rpcUrl),
  });

  
  const owner = privateKeyToAccount(ownerPrivateKey as `0x${string}`);

  
  const account = await toSimpleSmartAccount({
    owner,
    client:     publicClient,
    entryPoint: {
      address: ENTRY_POINT_V07,
      version: '0.7',
    },
  });

  
  const smartAccountClient = createSmartAccountClient({
    account,
    chain:            arbitrum,
    bundlerTransport: http(rpcUrl),
    paymaster:        paymasterClient,   
    userOperation: {
      estimateFeesPerGas: async () => {
        
        const price = await pimlicoClient.getUserOperationGasPrice();
        return price.fast;
      },
    },
  });

  return new PimlicoLayerImpl(smartAccountClient, account.address);
}

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
