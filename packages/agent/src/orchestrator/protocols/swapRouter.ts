/**
 * swapRouter.ts — Universal USDC → token routing for Uniswap V3
 *
 * Two exports used by both the screener (validation) and executor (execution):
 *
 *   resolveSwapRoute(tokenOut, provider)
 *     Discovers the deepest-liquidity swap path from USDC to any token by querying
 *     the UniV3 factory across all fee tiers. Falls back to USDC→WETH→token
 *     multi-hop using the deepest WETH-paired pool. Returns null when no route
 *     exists — the screener uses this to exclude unroutable pools entirely.
 *
 *   quoteSwapFromUSDC(route, amountIn, provider)
 *     Simulates the swap via Quoter V2 (eth_call, free) and returns the exact
 *     expected output at current pool prices. Never throws — returns 0n on error
 *     so the caller can fall back to zero slippage protection rather than reverting.
 *
 * Route cache: 15 min TTL (matches screener cache) — WETH/WBTC/ARB are resolved
 * once and reused across all pools that include them.
 */

import { ethers } from 'ethers';

// ── Addresses (Arbitrum mainnet) ──────────────────────────────────────────────

const USDC    = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const WETH    = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const QUOTER2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';

const FEE_TIERS = [100, 500, 3000, 10_000];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SwapRoute {
  tokenIn:   string;  // always USDC
  tokenOut:  string;
  singleHop: boolean;
  fee:       number;  // direct-pool fee when singleHop=true; WETH-token fee when false
  path?:     string;  // ABI-encoded bytes path for exactInput (multi-hop only)
}

// ── ABIs ──────────────────────────────────────────────────────────────────────

const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
];

const POOL_LIQ_ABI = [
  'function liquidity() view returns (uint128)',
];

// Quoter V2 — staticCall via eth_call, not a real transaction
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

// ── Path encoding ─────────────────────────────────────────────────────────────

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

// ── Route cache ───────────────────────────────────────────────────────────────

const ROUTE_CACHE_TTL = 15 * 60_000;

interface CacheEntry {
  route:     SwapRoute | null;
  expiresAt: number;
}

const routeCache = new Map<string, CacheEntry>();

export function clearRouteCache(): void {
  routeCache.clear();
}

// ── Pool discovery ────────────────────────────────────────────────────────────

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

// ── Route resolver ────────────────────────────────────────────────────────────

/**
 * Find the best swap route from USDC to tokenOut.
 *
 * Priority:
 *   1. Direct USDC↔tokenOut pool — try all fee tiers, pick deepest by liquidity.
 *   2. Multi-hop USDC→WETH→tokenOut — find deepest WETH↔tokenOut pool.
 *   3. null → no route exists; caller should exclude this pool.
 *
 * Results are cached for 15 minutes to avoid redundant factory calls across
 * multiple pools that share the same token (e.g. WETH appears in many pools).
 */
export async function resolveSwapRoute(
  tokenOut: string,
  provider: ethers.JsonRpcProvider,
): Promise<SwapRoute | null> {
  const key = tokenOut.toLowerCase();

  // Return USDC → USDC as "no swap needed" sentinel
  if (key === USDC.toLowerCase()) return null;

  const cached = routeCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.route;

  let route: SwapRoute | null = null;

  const tokenOutCs = ethers.getAddress(tokenOut); // checksummed

  // Step 1: direct USDC↔tokenOut
  const direct = await findDeepestPool(USDC, tokenOutCs, provider);
  if (direct) {
    route = { tokenIn: USDC, tokenOut: tokenOutCs, singleHop: true, fee: direct.fee };
  } else {
    // Step 2: multi-hop USDC→WETH→tokenOut
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

// ── Quoter V2 ─────────────────────────────────────────────────────────────────

/**
 * Simulate a USDC→tokenOut swap using Quoter V2 (eth_call — free, no gas).
 * Returns the exact expected output at current pool prices and tick state.
 * Returns 0n on any error — caller must not proceed with 0n (use fallback).
 */
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
      // path bytes are already packed — no address checksum needed for exactInput
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
