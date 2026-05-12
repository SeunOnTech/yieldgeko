import { describe, it } from 'vitest';
import { SwapAggregator } from '../src/core/aggregator';
import { UniswapV3Provider } from '../src/chains/arbitrum/providers/UniswapV3';
import { CamelotV3Provider } from '../src/chains/arbitrum/providers/CamelotV3';
import { OdosProvider } from '../src/chains/arbitrum/providers/Odos';
import { GMXV1Provider } from '../src/chains/arbitrum/providers/GMXV1';
import { parseUnits, formatUnits, Address, getAddress } from 'viem';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../agent/.env') });

const RPC_URL = process.env.ARB_RPC_URL;
const ETH_ADDR = '0x0000000000000000000000000000000000000000' as Address;

const TOKENS: Record<string, { addr: Address; decimals: number }> = {
  USDC:   { addr: getAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'), decimals: 6 },
  WETH:   { addr: getAddress('0x82af49447d8a07e3bd95bd0d56f35241523fbab1'), decimals: 18 },
  WBTC:   { addr: getAddress('0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f'), decimals: 8 },
  ARB:    { addr: getAddress('0x912ce59144191c1204e64559fe8253a0e49e6548'), decimals: 18 },
  GMX:    { addr: getAddress('0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a'), decimals: 18 },
  PENDLE: { addr: getAddress('0x0c888f7048943554ee4de4f910c988887e91d5bc'), decimals: 18 },
  RDNT:   { addr: getAddress('0x3082cc375029c432822504666bebe9c4b2772522'), decimals: 18 },
  LINK:   { addr: getAddress('0xf97f4df75117a78c1a5a0dbb814af92458539fb4'), decimals: 18 },
  UNI:    { addr: getAddress('0xFa7F8980b0f1e64A2062791cc3b0871572f1F7f0'), decimals: 18 },
  JOE:    { addr: getAddress('0x371c7ec6D8039ff7933a2AA28EB827Ffe1F52f07'), decimals: 18 },
};

const providers = [
  new UniswapV3Provider(RPC_URL),
  new CamelotV3Provider(RPC_URL),
  new OdosProvider(),
  new GMXV1Provider(RPC_URL),
];

const aggregator = new SwapAggregator(providers, RPC_URL);

async function testPair(fromSym: string, toSym: string, amount: string) {
  const from = fromSym === 'ETH' ? { addr: ETH_ADDR, decimals: 18 } : TOKENS[fromSym];
  const to = toSym === 'ETH' ? { addr: ETH_ADDR, decimals: 18 } : TOKENS[toSym];

  const route = await aggregator.findBestRoute({
    chainId: 42161,
    tokenIn: from.addr,
    tokenOut: to.addr,
    amountIn: parseUnits(amount, from.decimals),
    slippageBps: 50,
    recipient: '0x1234567890123456789012345678901234567890'
  }, parseUnits('0.1', 9)); // Use a sample gas price

  if (route) {
    console.log(`[${fromSym} -> ${toSym}] Winner: ${route.provider} | Out: ${formatUnits(route.amountOut, to.decimals)} ${toSym}`);
  } else {
    console.log(`[${fromSym} -> ${toSym}] No route found`);
  }
}

describe('Comprehensive Swap Test', () => {
  it('tests various Arbitrum token pairs', async () => {
    console.log('\n--- Major Pairs ---');
    await testPair('ETH', 'USDC', '1');
    await testPair('USDC', 'ETH', '2000');
    await testPair('ARB', 'USDC', '1000');

    console.log('\n--- Ecosystem Pairs ---');
    await testPair('GMX', 'WETH', '10');
    await testPair('PENDLE', 'WETH', '100');
    await testPair('RDNT', 'USDC', '500');

    console.log('\n--- Blue-Chips ---');
    await testPair('LINK', 'ETH', '50');
    await testPair('UNI', 'ARB', '100');

    console.log('\n--- Multi-Hop Stress ---');
    await testPair('JOE', 'GMX', '100');
    await testPair('RDNT', 'PENDLE', '1000');
  }, 120000);
});
