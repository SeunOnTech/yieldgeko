
import fetch from 'node-fetch';

async function test() {
  const url = `http://localhost:3001/health`;
  console.log(`Checking agent health at ${url}...`);
  try {
    const res = await fetch(url);
    const data = await res.json();
    console.log('Health:', data);
    
    console.log('Checking /state size...');
    const stateRes = await fetch('http://localhost:3001/state');
    const stateData = await stateRes.text();
    console.log(`State size: ${stateData.length} bytes`);
    
  } catch (e: any) {
    console.error('Test failed:', e.message);
  }
}

test();
