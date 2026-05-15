import { Contract, Interface, JsonRpcProvider } from 'ethers';
import type { PriceMap } from './chainlink';
import { getPriceByAddress, getPrice } from './chainlink';

const MULTICALL3    = '0xcA11bde05977b3631167028862bE2a173976CA11';
const PM_ADDRESS    = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const FACTORY_ADDR  = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

const Q96           = 2n ** 96n;

export interface UniV3Pool {
  address:      string;
  token0:       string;   
  token1:       string;
  token0Sym:    string;
  token1Sym:    string;
  feeTier:      number;   
  sqrtPriceX96: bigint;
  currentTick:  number;
  tvlUSD:       number;
  updatedAt:    number;
}

export interface UniV3Position {
  tokenId:        bigint;
  poolAddress:    string;
  token0:         string;
  token1:         string;
  token0Sym:      string;
  token1Sym:      string;
  feeTier:        number;
  tickLower:      number;
  tickUpper:      number;
  currentTick:    number;
  liquidity:      bigint;
  inRange:        boolean;
  
  amount0USD:     number;  
  amount1USD:     number;  
  positionUSD:    number;  
  fee0USD:        number;  
  fee1USD:        number;  
  totalFeesUSD:   number;
  
  estimatedAPY:   number;
  updatedAt:      number;
}

export interface PositionSnapshot {
  tokenId:    bigint;
  positionUSD: number;
  fee0Raw:    bigint;
  fee1Raw:    bigint;
  timestamp:  number;
}

const MC3_ABI = ['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)'];

const PM_ABI = [
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];

const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
];

const FACTORY_ABI = ['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'];

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

function tickToSqrtPriceX96(tick: number): bigint {
  
  const sqrtPrice = Math.sqrt(1.0001 ** tick);
  
  return BigInt(Math.floor(sqrtPrice * Number(Q96)));
}

function calcAmounts(
  sqrtPriceX96: bigint,
  tickLower:    number,
  tickUpper:    number,
  liquidity:    bigint,
): { amount0: bigint; amount1: bigint } {
  if (liquidity === 0n) return { amount0: 0n, amount1: 0n };

  const sqrtLower   = tickToSqrtPriceX96(tickLower);
  const sqrtUpper   = tickToSqrtPriceX96(tickUpper);
  const sqrtCurrent = sqrtPriceX96;

  let amount0 = 0n;
  let amount1 = 0n;

  if (sqrtCurrent <= sqrtLower) {
    
    if (sqrtLower > 0n && sqrtUpper > 0n) {
      amount0 = (liquidity * Q96 * (sqrtUpper - sqrtLower)) / (sqrtUpper * sqrtLower / Q96 + 1n);
    }
  } else if (sqrtCurrent < sqrtUpper) {
    
    const sqrtDiff = sqrtUpper - sqrtCurrent;
    if (sqrtCurrent > 0n && sqrtUpper > 0n) {
      amount0 = (liquidity * Q96 * sqrtDiff) / (sqrtCurrent * sqrtUpper / Q96 + 1n);
    }
    amount1 = (liquidity * (sqrtCurrent - sqrtLower)) / Q96;
  } else {
    
    amount1 = (liquidity * (sqrtUpper - sqrtLower)) / Q96;
  }

  return { amount0, amount1 };
}

export async function fetchUniV3Pool(
  poolAddress: string,
  provider:    JsonRpcProvider,
  prices:      PriceMap,
): Promise<UniV3Pool | null> {
  const mc    = new Contract(MULTICALL3, MC3_ABI, provider);
  const piface = new Interface(POOL_ABI);
  const eiface = new Interface(ERC20_ABI);

  
  const calls = [
    { target: poolAddress, allowFailure: true, callData: piface.encodeFunctionData('slot0')  },
    { target: poolAddress, allowFailure: true, callData: piface.encodeFunctionData('token0') },
    { target: poolAddress, allowFailure: true, callData: piface.encodeFunctionData('token1') },
    { target: poolAddress, allowFailure: true, callData: piface.encodeFunctionData('fee')    },
  ];

  try {
    const raw: { success: boolean; returnData: string }[] = await mc.aggregate3(calls);
    if (!raw[0].success || !raw[1].success || !raw[2].success) return null;

    const slot0       = piface.decodeFunctionResult('slot0',  raw[0].returnData);
    const token0Addr  = (piface.decodeFunctionResult('token0', raw[1].returnData)[0] as string).toLowerCase();
    const token1Addr  = (piface.decodeFunctionResult('token1', raw[2].returnData)[0] as string).toLowerCase();
    const feeTier     = Number(piface.decodeFunctionResult('fee', raw[3].returnData)[0]);

    const sqrtPriceX96 = BigInt(slot0[0].toString());
    const currentTick  = Number(slot0[1]);

    
    const symCalls = [
      { target: token0Addr, allowFailure: true, callData: eiface.encodeFunctionData('symbol')            },
      { target: token1Addr, allowFailure: true, callData: eiface.encodeFunctionData('symbol')            },
      { target: token0Addr, allowFailure: true, callData: eiface.encodeFunctionData('balanceOf', [poolAddress]) },
      { target: token1Addr, allowFailure: true, callData: eiface.encodeFunctionData('balanceOf', [poolAddress]) },
      { target: token0Addr, allowFailure: true, callData: eiface.encodeFunctionData('decimals')          },
      { target: token1Addr, allowFailure: true, callData: eiface.encodeFunctionData('decimals')          },
    ];

    const symRaw: { success: boolean; returnData: string }[] = await mc.aggregate3(symCalls);

    const token0Sym = symRaw[0].success ? (eiface.decodeFunctionResult('symbol',   symRaw[0].returnData)[0] as string) : '?';
    const token1Sym = symRaw[1].success ? (eiface.decodeFunctionResult('symbol',   symRaw[1].returnData)[0] as string) : '?';
    const bal0Raw   = symRaw[2].success ? BigInt(eiface.decodeFunctionResult('balanceOf', symRaw[2].returnData)[0].toString()) : 0n;
    const bal1Raw   = symRaw[3].success ? BigInt(eiface.decodeFunctionResult('balanceOf', symRaw[3].returnData)[0].toString()) : 0n;
    const dec0      = symRaw[4].success ? Number(eiface.decodeFunctionResult('decimals',  symRaw[4].returnData)[0]) : 18;
    const dec1      = symRaw[5].success ? Number(eiface.decodeFunctionResult('decimals',  symRaw[5].returnData)[0]) : 18;

    const p0    = getPriceByAddress(prices, token0Addr) || getPrice(prices, token0Sym);
    const p1    = getPriceByAddress(prices, token1Addr) || getPrice(prices, token1Sym);
    const tvlUSD = Number(bal0Raw) / 10 ** dec0 * p0 + Number(bal1Raw) / 10 ** dec1 * p1;

    return {
      address: poolAddress, token0: token0Addr, token1: token1Addr,
      token0Sym, token1Sym, feeTier, sqrtPriceX96, currentTick, tvlUSD,
      updatedAt: Date.now(),
    };
  } catch { return null; }
}

export async function fetchUniV3Position(
  tokenId:       bigint,
  provider:      JsonRpcProvider,
  prices:        PriceMap,
  entrySnapshot: PositionSnapshot | null = null,
): Promise<UniV3Position | null> {
  try {
    const pm     = new Contract(PM_ADDRESS, PM_ABI,      provider);
    const factory = new Contract(FACTORY_ADDR, FACTORY_ABI, provider);

    const pos = await pm.positions(tokenId);

    const token0Addr  = (pos[2] as string).toLowerCase();
    const token1Addr  = (pos[3] as string).toLowerCase();
    const feeTier     = Number(pos[4]);
    const tickLower   = Number(pos[5]);
    const tickUpper   = Number(pos[6]);
    const liquidity   = BigInt(pos[7].toString());
    const tokensOwed0 = BigInt(pos[10].toString());
    const tokensOwed1 = BigInt(pos[11].toString());

    
    const poolAddr = await factory.getPool(token0Addr, token1Addr, feeTier);
    const pool     = new Contract(poolAddr, POOL_ABI, provider);
    const slot0    = await pool.slot0();
    const sqrtP    = BigInt(slot0[0].toString());
    const curTick  = Number(slot0[1]);
    const inRange  = curTick >= tickLower && curTick < tickUpper;

    
    const mc    = new Contract(MULTICALL3, MC3_ABI, provider);
    const eface = new Interface(ERC20_ABI);
    const symCalls = [
      { target: token0Addr, allowFailure: true, callData: eface.encodeFunctionData('symbol')   },
      { target: token1Addr, allowFailure: true, callData: eface.encodeFunctionData('symbol')   },
      { target: token0Addr, allowFailure: true, callData: eface.encodeFunctionData('decimals') },
      { target: token1Addr, allowFailure: true, callData: eface.encodeFunctionData('decimals') },
    ];
    const sr: { success: boolean; returnData: string }[] = await mc.aggregate3(symCalls);
    const sym0 = sr[0].success ? (eface.decodeFunctionResult('symbol',   sr[0].returnData)[0] as string) : '?';
    const sym1 = sr[1].success ? (eface.decodeFunctionResult('symbol',   sr[1].returnData)[0] as string) : '?';
    const dec0 = sr[2].success ? Number(eface.decodeFunctionResult('decimals', sr[2].returnData)[0]) : 18;
    const dec1 = sr[3].success ? Number(eface.decodeFunctionResult('decimals', sr[3].returnData)[0]) : 18;

    const p0 = getPriceByAddress(prices, token0Addr) || getPrice(prices, sym0);
    const p1 = getPriceByAddress(prices, token1Addr) || getPrice(prices, sym1);

    
    const { amount0, amount1 } = calcAmounts(sqrtP, tickLower, tickUpper, liquidity);
    const amount0USD  = Number(amount0) / 10 ** dec0 * p0;
    const amount1USD  = Number(amount1) / 10 ** dec1 * p1;
    const positionUSD = amount0USD + amount1USD;

    
    const fee0USD = Number(tokensOwed0) / 10 ** dec0 * p0;
    const fee1USD = Number(tokensOwed1) / 10 ** dec1 * p1;
    const totalFeesUSD = fee0USD + fee1USD;

    
    let estimatedAPY = 0;
    if (entrySnapshot && entrySnapshot.positionUSD > 0) {
      const daysSinceEntry = (Date.now() - entrySnapshot.timestamp) / 86_400_000;
      if (daysSinceEntry > 0) {
        const newFees0 = Number(tokensOwed0 - entrySnapshot.fee0Raw) / 10 ** dec0 * p0;
        const newFees1 = Number(tokensOwed1 - entrySnapshot.fee1Raw) / 10 ** dec1 * p1;
        const feesEarned = Math.max(0, newFees0 + newFees1);
        estimatedAPY = (feesEarned / entrySnapshot.positionUSD / daysSinceEntry) * 365 * 100;
      }
    }

    return {
      tokenId, poolAddress: poolAddr,
      token0: token0Addr, token1: token1Addr,
      token0Sym: sym0, token1Sym: sym1,
      feeTier, tickLower, tickUpper, currentTick: curTick,
      liquidity, inRange,
      amount0USD, amount1USD, positionUSD,
      fee0USD, fee1USD, totalFeesUSD,
      estimatedAPY, updatedAt: Date.now(),
    };
  } catch { return null; }
}

export async function createPositionSnapshot(
  tokenId:  bigint,
  provider: JsonRpcProvider,
  prices:   PriceMap,
): Promise<PositionSnapshot | null> {
  const pos = await fetchUniV3Position(tokenId, provider, prices);
  if (!pos) return null;

  const pm    = new Contract(PM_ADDRESS, PM_ABI, provider);
  const data  = await pm.positions(tokenId).catch(() => null);
  if (!data) return null;

  return {
    tokenId,
    positionUSD: pos.positionUSD,
    fee0Raw:     BigInt(data[10].toString()),
    fee1Raw:     BigInt(data[11].toString()),
    timestamp:   Date.now(),
  };
}

export async function verifyUniV3Pool(
  poolAddress:    string,
  minTvlUSD:      number,
  provider:       JsonRpcProvider,
  prices:         PriceMap,
): Promise<{ ok: boolean; pool: UniV3Pool | null; error: string | null }> {
  const pool = await fetchUniV3Pool(poolAddress, provider, prices);
  if (!pool) return { ok: false, pool: null, error: 'Pool not found or unresponsive' };
  if (pool.tvlUSD < minTvlUSD) {
    return { ok: false, pool, error: `TVL $${(pool.tvlUSD / 1e6).toFixed(2)}M below min $${(minTvlUSD / 1e6).toFixed(2)}M` };
  }
  return { ok: true, pool, error: null };
}
