
async function testGecko() {
  const platform = 'arbitrum-one';
  const address = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1'; // WETH
  const url = `https://api.coingecko.com/api/v3/coins/${platform}/contract/${address}/market_chart/?vs_currency=usd&days=30`;

  console.log(`Testing CoinGecko: ${url}`);
  try {
    const res = await fetch(url);
    if (res.status === 429) {
      console.log('❌ RATE LIMITED (429)');
      return;
    }
    const data = await res.json();
    if (data.prices && data.prices.length > 0) {
      console.log(`✅ SUCCESS: Found ${data.prices.length} historical data points.`);
      console.log(`First point: ${JSON.stringify(data.prices[0])}`);
    } else {
      console.log('❌ EMPTY or INVALID DATA');
      console.log(JSON.stringify(data));
    }
  } catch (err) {
    console.log(`❌ ERROR: ${err.message}`);
  }
}

testGecko();
