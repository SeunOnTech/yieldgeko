import { createPublicClient, fallback, http, PublicClient } from 'viem';
import { arbitrum, localhost } from 'viem/chains';

export const zeroGTestnet = {
  id: 16602,
  name: '0G Galileo Testnet',
  network: '0g-galileo',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://evmrpc-testnet.0g.ai'] },
    public: { http: ['https://evmrpc-testnet.0g.ai'] },
  },
  blockExplorers: {
    default: { name: '0G Scan', url: 'https://chainscan-galileo.0g.ai' },
  },
} as const;

const arbitrumFallback = fallback([
  http('https://arb1.arbitrum.io/rpc', { timeout: 3000 }),
  http('https://arbitrum.publicnode.com', { timeout: 3000 }),
  http(`https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || ''}`, { timeout: 3000 }),
], { rank: true });

const zeroGFallback = fallback([
  http(process.env.ZERO_G_RPC || 'https://evmrpc-testnet.0g.ai', { timeout: 3000 }),
  http('https://evmrpc-testnet.0g.ai', { timeout: 3000 }),
], { rank: true });

export const arbitrumClient: PublicClient = createPublicClient({
  chain: arbitrum,
  transport: arbitrumFallback,
  batch: { multicall: { batchSize: 1024, wait: 100 } },
});

export const zeroGClient: PublicClient = createPublicClient({
  chain: zeroGTestnet,
  transport: zeroGFallback,
});
