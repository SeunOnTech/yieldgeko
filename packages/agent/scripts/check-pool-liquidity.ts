import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const provider = new ethers.JsonRpcProvider(process.env.ARB_RPC_URL!, 42161, { staticNetwork: true });

const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const WETH    = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const ARB     = '0x912CE59144191C1204E64559FE8253a0e49E6548';
const OUR_POOL = '0x89A4026E9aDE251C67b7fb38054931a39936D9C5'; // current position pool

const factoryAbi = ['function getPool(address,address,uint24) view returns (address)'];
const poolAbi = [
  'function liquidity() view returns (uint128)',
  'function fee() view returns (uint24)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
];

(async () => {
  const factory = new ethers.Contract(FACTORY, factoryAbi, provider);

  console.log('\nWETH-ARB pools across all fee tiers:');
  console.log('─'.repeat(80));

  for (const fee of [100, 500, 3000, 10000]) {
    const addr = await factory.getPool(WETH, ARB, fee) as string;
    if (addr === ethers.ZeroAddress) {
      console.log(`fee ${fee} (${fee/10000}%): no pool`);
      continue;
    }
    const pool = new ethers.Contract(addr, poolAbi, provider);
    const [liq, fg0, fg1] = await Promise.all([
      pool.liquidity() as Promise<bigint>,
      pool.feeGrowthGlobal0X128() as Promise<bigint>,
      pool.feeGrowthGlobal1X128() as Promise<bigint>,
    ]);
    const isOurs = addr.toLowerCase() === OUR_POOL.toLowerCase();
    console.log(
      `fee ${fee} (${(fee/10000).toFixed(2)}%): ${addr.slice(0,12)}…  `
      + `liquidity=${liq.toString().padStart(22)}  `
      + `feeGrowth0=${fg0 > 0n ? 'active' : 'zero  '}`
      + (isOurs ? '  ← OUR POOL' : '')
    );
  }

  console.log('\nConclusion: higher liquidity + active feeGrowth = more trading volume in that tier.\n');
})().catch(console.error);
