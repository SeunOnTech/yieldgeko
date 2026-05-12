
const fetch = require('node-fetch');

async function test() {
  const address = '0x0000000000000000000000000000000000000000'; // Placeholder or known address
  const url = `http://localhost:3001/state/${address}`;
  console.log(`Fetching ${url}...`);
  try {
    const res = await fetch(url);
    console.log(`Status: ${res.status}`);
    const data = await res.json();
    console.log('Data:', JSON.stringify(data, null, 2).slice(0, 500));
  } catch (e) {
    console.error('Fetch failed:', e.message);
  }
}

test();
