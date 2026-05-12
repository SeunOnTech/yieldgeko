import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const RPC_URL = process.env.ARB_RPC_URL || 'https://arbitrum-one-rpc.publicnode.com';
const PM_ADDR = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const TOKEN_ID = 5485999;

async function check() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const pm = new ethers.Contract(PM_ADDR, [
    'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'
  ], provider);

  console.log(`Checking NFT ${TOKEN_ID} on Arbitrum...`);
  try {
    const pos = await pm.positions(TOKEN_ID);
    console.log('Result:', {
      token0: pos[2],
      token1: pos[3],
      fee: pos[4],
      tickLower: pos[5],
      tickUpper: pos[6],
      liquidity: pos[7].toString(),
    });
  } catch (err: any) {
    console.error('Error:', err.message);
  }
}

check();
