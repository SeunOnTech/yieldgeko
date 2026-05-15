

import { ethers } from 'ethers';
import {
  createArbitrumAggregator,
  type SwapRoute as AggregatorSwapRoute,
  type QuoteParams,
} from '@yieldgeko/swap-aggregator';
import type { Address } from 'viem';

const USDC    = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const WETH    = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const QUOTER2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';

const FEE_TIERS = [100, 500, 3000, 10_000];

export interface SwapRoute {
  tokenIn:   string;  
  tokenOut:  string;
  singleHop: boolean;
  fee:       number;  
  path?:     string;  
}

const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
];

const POOL_LIQ_ABI = [
  'function liquidity() view returns (uint128)',
];

const QUOTER2_ABI = [
  `function quoteExactInputSingle(
      tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params
   ) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)`,
  `function quoteExactInput(bytes path, uint256 amountIn)
   external returns (
     uint256 amountOut,
     uint160[] sqrtPriceX96AfterList,
     uint32[]  initializedTicksCrossedList,
     uint256   gasEstimate
   )`,
];

function encodeUniswapPath(tokens: string[], fees: number[]): string {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) {
    throw new Error('encodeUniswapPath: tokens.length must be fees.length + 1');
  }
  let packed = tokens[0].toLowerCase().replace('0x', '');
  for (let i = 0; i < fees.length; i++) {
    packed += fees[i].toString(16).padStart(6, '0');
    packed += tokens[i + 1].toLowerCase().replace('0x', '');
  }
  return '0x' + packed;
}

export function reverseUniswapPath(path: string): string {
  const hex    = path.startsWith('0x') ? path.slice(2) : path;
  const tokens: string[] = [];
  const fees:   number[] = [];
  let i = 0;
  while (i < hex.length) {
    tokens.push(hex.slice(i, i + 40));
    i += 40;
    if (i < hex.length) {
      fees.push(parseInt(hex.slice(i, i + 6), 16));
      i += 6;
    }
  }
  tokens.reverse();
  fees.reverse();
  let result = tokens[0];
  for (let j = 0; j < fees.length; j++) {
    result += fees[j].toString(16).padStart(6, '0') + tokens[j + 1];
  }
  return '0x' + result;
}

const ROUTE_CACHE_TTL = 15 * 60_000;

interface CacheEntry {
  route:     SwapRoute | null;
  expiresAt: number;
}

const routeCache = new Map<string, CacheEntry>();

export function clearRouteCache(): void {
  routeCache.clear();
}

async function findDeepestPool(
  tokenA:   string,
  tokenB:   string,
  provider: ethers.JsonRpcProvider,
): Promise<{ address: string; fee: number; liquidity: bigint } | null> {
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);

  type Candidate = { address: string; fee: number };

  const rawCandidates = await Promise.all(
    FEE_TIERS.map(async fee => {
      try {
        const addr = await factory.getPool(tokenA, tokenB, fee) as string;
        if (!addr || addr === ethers.ZeroAddress) return null;
        const c: Candidate = { address: addr, fee };
        return c;
      } catch {
        return null;
      }
    }),
  );
  const candidates: Candidate[] = rawCandidates.filter((c): c is Candidate => c !== null);

  if (candidates.length === 0) return null;

  const withLiq = await Promise.all(
    candidates.map(async c => {
      try {
        const pool = new ethers.Contract(c.address, POOL_LIQ_ABI, provider);
        const liq  = await pool.liquidity() as bigint;
        return { address: c.address, fee: c.fee, liquidity: liq };
      } catch {
        return { address: c.address, fee: c.fee, liquidity: 0n };
      }
    }),
  );

  const best = withLiq.reduce((a, b) => (b.liquidity > a.liquidity ? b : a));
  return best.liquidity > 0n ? best : null;
}

export async function resolveSwapRoute(
  tokenOut: string,
  provider: ethers.JsonRpcProvider,
): Promise<SwapRoute | null> {
  const key = tokenOut.toLowerCase();

  
  if (key === USDC.toLowerCase()) return null;

  const cached = routeCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.route;

  let route: SwapRoute | null = null;

  const tokenOutCs = ethers.getAddress(tokenOut); 

  
  const direct = await findDeepestPool(USDC, tokenOutCs, provider);
  if (direct) {
    route = { tokenIn: USDC, tokenOut: tokenOutCs, singleHop: true, fee: direct.fee };
  } else {
    
    const wethLeg = await findDeepestPool(WETH, tokenOutCs, provider);
    if (wethLeg) {
      route = {
        tokenIn:   USDC,
        tokenOut:  tokenOutCs,
        singleHop: false,
        fee:       wethLeg.fee,
        path:      encodeUniswapPath([USDC, WETH, tokenOutCs], [500, wethLeg.fee]),
      };
    }
  }

  routeCache.set(key, { route, expiresAt: Date.now() + ROUTE_CACHE_TTL });
  return route;
}

export async function quoteSwapFromUSDC(
  route:    SwapRoute,
  amountIn: bigint,
  provider: ethers.JsonRpcProvider,
): Promise<bigint> {
  if (amountIn === 0n) return 0n;

  try {
    const quoter = new ethers.Contract(QUOTER2, QUOTER2_ABI, provider);

    if (route.singleHop) {
      const result = await quoter.quoteExactInputSingle.staticCall({
        tokenIn:           ethers.getAddress(route.tokenIn.toLowerCase()),
        tokenOut:          ethers.getAddress(route.tokenOut.toLowerCase()),
        amountIn,
        fee:               route.fee,
        sqrtPriceLimitX96: 0n,
      }) as [bigint, bigint, number, bigint];
      return result[0] as bigint;
    } else {
      
      const result = await quoter.quoteExactInput.staticCall(route.path!, amountIn);
      return result[0] as bigint;
    }
  } catch (err: any) {
    console.warn(
      `[SwapRouter] Quoter V2 failed for ${route.tokenOut} via ${route.singleHop ? `single-hop fee=${route.fee}` : 'multi-hop'}: ` +
      (err?.shortMessage ?? err?.message ?? String(err)),
    );
    return 0n;
  }
}

export async function quoteSwapToUSDC(
  route:    SwapRoute,       
  amountIn: bigint,          
  provider: ethers.JsonRpcProvider,
): Promise<bigint> {
  if (amountIn === 0n) return 0n;

  try {
    const quoter = new ethers.Contract(QUOTER2, QUOTER2_ABI, provider);

    if (route.singleHop) {
      
      const result = await quoter.quoteExactInputSingle.staticCall({
        tokenIn:           ethers.getAddress(route.tokenOut.toLowerCase()), 
        tokenOut:          ethers.getAddress(route.tokenIn.toLowerCase()),  
        amountIn,
        fee:               route.fee,
        sqrtPriceLimitX96: 0n,
      }) as [bigint, bigint, number, bigint];
      return result[0] as bigint;
    } else {
      
      const reversedPath = reverseUniswapPath(route.path!);
      const result = await quoter.quoteExactInput.staticCall(reversedPath, amountIn);
      return result[0] as bigint;
    }
  } catch (err: any) {
    console.warn(
      `[SwapRouter] quoteSwapToUSDC failed for ${route.tokenOut}: ` +
      (err?.shortMessage ?? err?.message ?? String(err)),
    );
    return 0n;
  }
}

let _aggregator: ReturnType<typeof createArbitrumAggregator> | null = null;

function getAggregator(): ReturnType<typeof createArbitrumAggregator> {
  if (!_aggregator) {
    _aggregator = createArbitrumAggregator(
      process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc',
    );
  }
  return _aggregator;
}

export async function findBestSwapRoute(
  tokenIn:    string,
  tokenOut:   string,
  amountIn:   bigint,
  slippageBps: number,
  recipient:  string,
): Promise<AggregatorSwapRoute | null> {
  try {
    return await getAggregator().findBestRoute({
      chainId:    42161,
      tokenIn:    tokenIn  as Address,
      tokenOut:   tokenOut as Address,
      amountIn,
      slippageBps,
      recipient:  recipient as Address,
    });
  } catch (err: any) {
    console.warn('[SwapAggregator] findBestRoute failed:', err?.message ?? err);
    return null;
  }
}

export type { AggregatorSwapRoute };
