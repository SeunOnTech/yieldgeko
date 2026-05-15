
async function debugChart() {
  const weth = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
  const start = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);
  
  const formats = [
    `https://coins.llama.fi/chart/arbitrum:${weth}?span=30&period=1d`,
    `https://coins.llama.fi/chart/arbitrum:${weth}?timestamp=${start}&span=30&period=1d`,
    `https://coins.llama.fi/prices/historical/${start}/arbitrum:${weth}`
  ];

  for (const url of formats) {
    console.log(`Testing: ${url}`);
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.prices && data.prices.length > 0) {
        console.log(`✅ SUCCESS: ${url}`);
        console.log(`Found ${data.prices.length} data points.`);
        return;
      } else {
        console.log(`❌ EMPTY: ${url}`);
      }
    } catch (err) {
      console.log(`❌ ERROR: ${url} - ${err.message}`);
    }
  }
}

debugChart();
