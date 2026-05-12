import { describe, it } from 'vitest';
import { SwapAggregator, OdosProvider, UniswapV3Provider, CamelotV3Provider, GMXV1Provider } from '../src';
import { Address, parseUnits, formatUnits } from 'viem';

// Arbitrum Addresses
const TOKENS = {
  USDC: { addr: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
  WETH: { addr: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
  ARB:  { addr: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
  WBTC: { addr: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8 },
};

const RPC_URL = 'https://arb1.arbitrum.io/rpc';

const aggregator = new SwapAggregator([
  new OdosProvider(),
  new UniswapV3Provider(RPC_URL),
  new CamelotV3Provider(RPC_URL),
  new GMXV1Provider(RPC_URL),
]);

async function testPair(from: keyof typeof TOKENS, to: keyof typeof TOKENS, amountStr: string) {
  const tokenIn = TOKENS[from];
  const tokenOut = TOKENS[to];
  
  const params = {
    tokenIn: tokenIn.addr as Address,
    tokenOut: tokenOut.addr as Address,
    amountIn: parseUnits(amountStr, tokenIn.decimals),
    slippageBps: 50,
    recipient: '0x092106703adE19BF7a638AD371f8f6c25831F349' as Address,
    chainId: 42161,
  };

  console.log(`\n>>> Testing: ${amountStr} ${from} -> ${to}`);
  const best = await aggregator.findBestRoute(params);

  if (best) {
    console.log(`Winner:   ${best.provider}`);
    console.log(`Out:      ${formatUnits(best.amountOut, tokenOut.decimals)} ${to}`);
    console.log(`DEX:      ${best.dex}`);
    console.log(`Approve:  ${best.approvalTarget}`);
  } else {
    console.log('No route found');
  }
}

describe('Manual Aggregator Test', () => {
  it('runs multiple pairs', async () => {
    console.log('\n>>> Testing: 1000 USDC -> WETH');
    await testPair('USDC', 'WETH', '1000');

    console.log('\n>>> Testing: 0.1 ETH -> USDC (Native)');
    const ETH_ADDR = '0x0000000000000000000000000000000000000000' as Address;
    const route = await aggregator.findBestRoute({
      chainId: 42161,
      tokenIn: ETH_ADDR,
      tokenOut: TOKENS.USDC.addr,
      amountIn: parseUnits('0.1', 18),
      slippageBps: 50,
      recipient: '0x1234567890123456789012345678901234567890'
    });
    if (route) {
      console.log(`Winner:   ${route.provider}`);
      console.log(`Out:      ${formatUnits(route.amountOut, 6)} USDC`);
    }

    console.log('\n>>> Testing: 0.5 WETH -> ARB');
    await testPair('WETH', 'ARB', '0.5');

    console.log('\n>>> Testing: 100 ARB -> USDC');
    await testPair('ARB', 'USDC', '100');

    console.log('\n>>> Testing: 0.01 WBTC -> WETH');
    await testPair('WBTC', 'WETH', '0.01');
  }, 60000);
});
