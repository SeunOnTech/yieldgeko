import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const RPC_URL = process.env.ARB_RPC_URL || 'https://arbitrum-one-rpc.publicnode.com';
const USDC_ADDR = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const SMART_ACCT = '0x0c43b140cb933Ac1B2D8FbC45a780ca457B9F4e8';

async function check() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const usdc = new ethers.Contract(USDC_ADDR, [
    'function balanceOf(address) view returns (uint256)'
  ], provider);

  console.log(`Checking USDC balance for Smart Account ${SMART_ACCT}...`);
  try {
    const bal = await usdc.balanceOf(SMART_ACCT);
    console.log('Balance:', ethers.formatUnits(bal, 6), 'USDC');
  } catch (err: any) {
    console.error('Error:', err.message);
  }
}

check();
