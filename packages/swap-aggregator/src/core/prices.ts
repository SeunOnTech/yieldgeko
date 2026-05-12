import { Address, createPublicClient, http, parseAbi, PublicClient } from 'viem';
import { arbitrum } from 'viem/chains';
import { ContractCall } from './types';

const FEED_ABI = parseAbi([
  'function latestAnswer() external view returns (int256)',
  'function decimals() external view returns (uint8)',
]);

export class PriceService {
  private client: PublicClient;

  private SYMBOL_TO_FEED: Record<string, Address> = {
    WETH:  '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
    USDC:  '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3',
    USDT:  '0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7',
    WBTC:  '0xd0C713E054413dbD020f7cf73feF3c4f9f74912c',
    ARB:   '0xb2A824043730e059341506B012880ae9Ec53E11C',
    LINK:  '0x86E53CF1B873786aC9Cc3e6B62913DaA5b5DeAB0',
    UNI:   '0x9C917083fDb403ab5ADbEC26Ee294f6EcAda2720',
  };

  private ADDR_TO_SYM: Record<string, string> = {
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC',
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'USDT',
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'WETH',
    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': 'WBTC',
    '0x912ce59144191c1204e64559fe8253a0e49e6548': 'ARB',
    '0xf97f4df75117a78c1a5a0dbb814af92458539fb4': 'LINK',
    '0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0': 'UNI',
  };

  // Token decimals — used for gas-normalised comparison in the aggregator
  private ADDR_TO_DECIMALS: Record<string, number> = {
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 6,   // USDC
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 6,   // USDT
    '0xda10009cbd5d07dd0cecc66161c0193050300673': 18,  // DAI
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 18,  // WETH
    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': 8,   // WBTC
    '0x912ce59144191c1204e64559fe8253a0e49e6548': 18,  // ARB
    '0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a': 18,  // GMX
    '0x0c888f7048943554ee4de4f910c988887e91d5bc': 18,  // PENDLE
    '0xf97f4df75117a78c1a5a0dbb814af92458539fb4': 18,  // LINK
    '0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0': 18,  // UNI
    '0x371c7ec6d8039ff7933a2aa28eb827ffe1f52f07': 18,  // JOE
    '0x3082cc375029c432822504666bebe9c4b2772522': 18,  // RDNT
  };

  constructor(rpcUrl?: string) {
    this.client = createPublicClient({
      chain:     arbitrum,
      transport: http(rpcUrl),
    });
  }

  public getPriceCall(symbol: string): ContractCall | null {
    const feed = this.SYMBOL_TO_FEED[symbol.toUpperCase()];
    if (!feed) return null;
    return { address: feed, abi: FEED_ABI, functionName: 'latestAnswer', args: [] };
  }

  public getPriceCallByAddress(address: string): ContractCall | null {
    const sym = this.ADDR_TO_SYM[address.toLowerCase()];
    if (!sym) return null;
    return this.getPriceCall(sym);
  }

  public parsePriceResult(result: any): number {
    if (!result) return 0;
    return Number(result) / 1e8; // Chainlink: 8 decimal places
  }

  /** Returns the number of decimals for a token by address. Defaults to 18. */
  public getDecimalsByAddress(address: string): number {
    return this.ADDR_TO_DECIMALS[address.toLowerCase()] ?? 18;
  }

  public async getPrice(symbol: string): Promise<number> {
    const call = this.getPriceCall(symbol);
    if (!call) return 0;
    try {
      const result = await this.client.readContract(call as any);
      return this.parsePriceResult(result);
    } catch {
      return 0;
    }
  }

  public async getPriceByAddress(address: string): Promise<number> {
    const sym = this.ADDR_TO_SYM[address.toLowerCase()];
    if (!sym) return 0;
    return this.getPrice(sym);
  }
}
