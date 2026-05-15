import { PriceProvider } from '../src/providers/price';

async function debug() {
  const tokens = [
    { symbol: 'WBTC (Arb)', chain: 'arbitrum', address: '0x2f2a2543b76a4166549f7aab2e7540a576218443' },
    { symbol: 'cbBTC (Base)', chain: 'base', address: '0xcb1e32e9565532724a4d3f56395233509a244a8a' },
    { symbol: 'AERO (Base)', chain: 'base', address: '0x9401518f4eb592e6acc575553725b9f4b5f9e7c3' },
    { symbol: 'WETH (Arb)', chain: 'arbitrum', address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1' }
  ];

  console.log('--- DEBUGGING PRICE RESOLUTION ---');
  
  for (const token of tokens) {
    console.log(`\nTesting ${token.symbol} [${token.address}]...`);
    
    try {
      const id = `${token.chain}:${token.address.toLowerCase()}`;
      const llamaUrl = `https://coins.llama.fi/prices/current/${id}`;
      const dsUrl = `https://api.dexscreener.com/latest/dex/tokens/${token.address}`;

      console.log(`- Fetching Llama: ${llamaUrl}`);
      const llamaResp = await fetch(llamaUrl).then(r => r.json());
      console.log(`- Llama Response: ${JSON.stringify(llamaResp).slice(0, 100)}...`);

      console.log(`- Fetching DexScreener: ${dsUrl}`);
      const dsResp = await fetch(dsUrl).then(r => r.json());
      console.log(`- DexScreener Pair Count: ${dsResp.pairs?.length || 0}`);
      if (dsResp.pairs?.length > 0) {
        console.log(`- Sample DexScreener Pair: ${dsResp.pairs[0].baseToken.symbol}/${dsResp.pairs[0].quoteToken.symbol} on ${dsResp.pairs[0].dexId}`);
        console.log(`- Sample DexScreener Price: $${dsResp.pairs[0].priceUsd}`);
      }
    } catch (err) {
      console.log(`💥 ERROR: ${err.message}`);
    }
  }
}

debug().catch(console.error);
