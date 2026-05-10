#!/usr/bin/env npx ts-node
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const provider = new ethers.JsonRpcProvider(
  process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc', 42161, { staticNetwork: true },
);
const USDC='0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const WETH='0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const WBTC='0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f';
const USDT='0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const FACTORY='0x1F98431c8aD98523631AE4a59f267346ea31F984';
const QUOTER2='0x61FfE014ba17989e743c5f6cB21BF9697530b21c';
const FACTORY_ABI=['function getPool(address,address,uint24) view returns (address)'];
const POOL_ABI=['function liquidity() view returns (uint128)','function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)'];
const Q_ABI=[`function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)`];
const FEED_ABI=['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'];
const factory=new ethers.Contract(FACTORY,FACTORY_ABI,provider);
const quoter=new ethers.Contract(QUOTER2,Q_ABI,provider);
const iface=new ethers.Interface(Q_ABI);
const AMOUNT_IN=500_000n;

async function main() {
  console.log('\n=== [1] QUOTER2 address ===');
  try { ethers.getAddress(QUOTER2); console.log('✅ checksum OK'); } catch(e:any){console.log('❌ BAD checksum:',e.message);}
  const code=await provider.getCode(QUOTER2);
  console.log(code.length>4?`✅ has code (${code.length} bytes)`:`❌ NO CODE at ${QUOTER2}`);

  console.log('\n=== [2] Pool liquidity ===');
  for(const [name,tA,tB] of [['USDC-WBTC',USDC,WBTC],['USDC-WETH',USDC,WETH],['USDC-USDT',USDC,USDT],['WETH-WBTC',WETH,WBTC]] as [string,string,string][]) {
    for(const fee of [100,500,3000,10000]) {
      const addr=await factory.getPool(tA,tB,fee) as string;
      if(addr===ethers.ZeroAddress)continue;
      const pool=new ethers.Contract(addr,POOL_ABI,provider);
      const [liq,slot0]=await Promise.all([pool.liquidity(),pool.slot0()]);
      const sqrt=(slot0 as any)[0] as bigint;
      console.log(`  ${name} fee=${fee}: liq=${(liq as bigint).toString().padStart(22)} sqrt=${sqrt>0n?'ok':'❌ZERO'}`);
    }
  }

  console.log('\n=== [3] Quoter quotes (0.5 USDC) ===');
  async function tryQ(label:string,tIn:string,tOut:string,fee:number){
    const addr=await factory.getPool(tIn,tOut,fee) as string;
    if(addr===ethers.ZeroAddress){console.log(`  ${label}: no pool`);return;}
    const params={tokenIn:ethers.getAddress(tIn.toLowerCase()),tokenOut:ethers.getAddress(tOut.toLowerCase()),amountIn:AMOUNT_IN,fee,sqrtPriceLimitX96:0n};
    try {
      const raw=await provider.call({to:QUOTER2,data:iface.encodeFunctionData('quoteExactInputSingle',[params])});
      if(raw==='0x'||raw.length<10){console.log(`  ${label}: ⚠️  empty/revert (${raw.slice(0,30)})`);return;}
      if(raw.length>=130){const d=iface.decodeFunctionResult('quoteExactInputSingle',raw);console.log(`  ${label}: ✅ amountOut=${d[0].toString()}`);}
      else{console.log(`  ${label}: ⚠️  short (${raw.length}): ${raw.slice(0,66)}`);}
    }catch(e:any){console.log(`  ${label}: ❌ eth_call: ${e.shortMessage??e.message}`);}
  }
  await tryQ('USDC→WBTC fee=500',USDC,WBTC,500);
  await tryQ('USDC→WBTC fee=3000',USDC,WBTC,3000);
  await tryQ('USDC→WETH fee=500',USDC,WETH,500);
  await tryQ('USDC→USDT fee=100',USDC,USDT,100);
  await tryQ('WETH→WBTC fee=500',WETH,WBTC,500);
  await tryQ('WETH→WBTC fee=3000',WETH,WBTC,3000);

  console.log('\n=== [4] Chainlink ===');
  const FEEDS:Record<string,{feed:string;dec:number}>={
    WETH:{feed:'0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',dec:8},
    WBTC:{feed:'0x6ce185539ad4fdaecd7274954e383768B34A682',dec:8},
    USDT:{feed:'0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7',dec:8},
    ARB:{feed:'0xb2A824043730FE05F3Da2efaFa1CBbe83fa548D6',dec:8},
  };
  for(const [sym,{feed,dec}] of Object.entries(FEEDS)){
    try{
      const c=new ethers.Contract(feed,FEED_ABI,provider);
      const [,ans,,upd]=await c.latestRoundData();
      const price=Number(ans)/10**dec;
      const age=Math.round((Date.now()/1000-Number(upd))/60);
      console.log(`  ${sym.padEnd(5)}: $${price.toFixed(2)} (${age}min ago)`);
    }catch(e:any){console.log(`  ${sym}: ❌ ${e.shortMessage??e.message}`);}
  }
  console.log('\n=== Done ===');
}
main().catch(e=>{console.error('Fatal:',e.message);process.exit(1);});
