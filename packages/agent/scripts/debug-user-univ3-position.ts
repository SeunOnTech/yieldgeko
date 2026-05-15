#!/usr/bin/env npx ts-node
/**
 * YieldGeko — Real User UniV3 Position Debugger
 *
 * Read-only script. It does not sign, submit transactions, collect fees, or
 * mutate agent state. It independently checks whether the agent's reported
 * UniV3 position state matches Arbitrum on-chain data.
 *
 * Usage:
 *   cd packages/agent
 *   npx ts-node scripts/debug-user-univ3-position.ts
 *
 * Optional env:
 *   DEBUG_USER_ADDRESS=0x...
 *   DEBUG_UNIV3_TOKEN_ID=123
 *   AGENT_URL=http://localhost:3001
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'node:path';
import * as http from 'node:http';
import { fetchPrices, getPriceByAddress, pricesAreHealthy, type PriceMap } from '../src/orchestrator/protocols/chainlink';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const ARB_RPC_URL = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const VAULT_ADDRESS = process.env.VAULT_ADDRESS ?? '';
const USER_ADDRESS = process.env.DEBUG_USER_ADDRESS ?? process.env.TEST_USER_ADDRESS ?? '';
const TOKEN_ID_OVERRIDE = process.env.DEBUG_UNIV3_TOKEN_ID;
const AGENT_URL = process.env.AGENT_URL ?? `http://localhost:${process.env.SSE_PORT ?? 3001}`;

const ADDR = {
  USDC:          '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  USDT:          '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  USDC_E:        '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
  DAI:           '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
  WETH:          '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  WBTC:          '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
  ARB:           '0x912CE59144191C1204E64559FE8253a0e49E6548',
  UNIV3_POS_MGR: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  UNIV3_FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
} as const;

const TOKEN_DECIMALS: Record<string, number> = {
  [ADDR.USDC.toLowerCase()]:   6,
  [ADDR.USDT.toLowerCase()]:   6,
  [ADDR.USDC_E.toLowerCase()]: 6,
  [ADDR.DAI.toLowerCase()]:    18,
  [ADDR.WETH.toLowerCase()]:   18,
  [ADDR.WBTC.toLowerCase()]:   8,
  [ADDR.ARB.toLowerCase()]:    18,
};

const TOKEN_SYMBOLS: Record<string, string> = {
  [ADDR.USDC.toLowerCase()]:   'USDC',
  [ADDR.USDT.toLowerCase()]:   'USDT',
  [ADDR.USDC_E.toLowerCase()]: 'USDC.e',
  [ADDR.DAI.toLowerCase()]:    'DAI',
  [ADDR.WETH.toLowerCase()]:   'WETH',
  [ADDR.WBTC.toLowerCase()]:   'WBTC',
  [ADDR.ARB.toLowerCase()]:    'ARB',
};

const STABLES = new Set([
  ADDR.USDC.toLowerCase(),
  ADDR.USDT.toLowerCase(),
  ADDR.USDC_E.toLowerCase(),
  ADDR.DAI.toLowerCase(),
]);

const POS_MGR_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  `function positions(uint256 tokenId) view returns (
    uint96 nonce,
    address operator,
    address token0,
    address token1,
    uint24 fee,
    int24 tickLower,
    int24 tickUpper,
    uint128 liquidity,
    uint256 feeGrowthInside0LastX128,
    uint256 feeGrowthInside1LastX128,
    uint128 tokensOwed0,
    uint128 tokensOwed1
  )`,
];

const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];

const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function liquidity() view returns (uint128)',
  'function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
];

const VAULT_ABI = [
  'function balances(address user, address asset) view returns (uint256)',
  'function deployed(address user, address asset) view returns (uint256)',
  'function policies(address user) view returns (bool active, uint256 managedUSD, uint256 minAPY, uint256 maxDrawdownBps, uint256 maxFeeBps, uint256 registeredAt, uint256 expiresAt)',
];

function getJSON(url: string): Promise<any | null> {
  return new Promise(resolve => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname,
      method: 'GET',
    }, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function decimals(token: string): number {
  return TOKEN_DECIMALS[token.toLowerCase()] ?? 18;
}

function symbol(token: string): string {
  return TOKEN_SYMBOLS[token.toLowerCase()] ?? `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function fallbackPriceUSD(token: string): number {
  const addr = token.toLowerCase();
  if (STABLES.has(addr)) return 1;
  if (addr === ADDR.WETH.toLowerCase()) return Number(process.env.DEBUG_ETH_PRICE_USD ?? 3000);
  if (addr === ADDR.WBTC.toLowerCase()) return Number(process.env.DEBUG_BTC_PRICE_USD ?? 100000);
  if (addr === ADDR.ARB.toLowerCase()) return Number(process.env.DEBUG_ARB_PRICE_USD ?? 1);
  return 1;
}

function priceUSD(prices: PriceMap, token: string): number {
  const addr = token.toLowerCase();
  if (STABLES.has(addr)) return 1;

  const livePrice = getPriceByAddress(prices, token);
  if (livePrice > 0) return livePrice;

  return fallbackPriceUSD(token);
}

function fmtUnits(raw: bigint, dec: number): string {
  return ethers.formatUnits(raw, dec);
}

function fmtUSD(n: number): string {
  return Number.isFinite(n) ? n.toString() : 'n/a';
}

function pct(n: number): string {
  return Number.isFinite(n) ? `${n.toString()}%` : 'n/a';
}

function tickToPrice(tick: number, dec0: number, dec1: number): number {
  return (1.0001 ** tick) * (10 ** (dec0 - dec1));
}

function liquidityAmounts(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
): { amount0RawApprox: number; amount1RawApprox: number } {
  const q96 = 2n ** 96n;
  const sqrtCurrent = Number(sqrtPriceX96) / Number(q96);
  const sqrtLower = Math.sqrt(1.0001 ** tickLower);
  const sqrtUpper = Math.sqrt(1.0001 ** tickUpper);
  const l = Number(liquidity);

  if (l <= 0) return { amount0RawApprox: 0, amount1RawApprox: 0 };
  const currentTick = Math.log(sqrtCurrent * sqrtCurrent) / Math.log(1.0001);

  if (currentTick < tickLower) {
    return { amount0RawApprox: l * (1 / sqrtLower - 1 / sqrtUpper), amount1RawApprox: 0 };
  }
  if (currentTick >= tickUpper) {
    return { amount0RawApprox: 0, amount1RawApprox: l * (sqrtUpper - sqrtLower) };
  }
  return {
    amount0RawApprox: l * (1 / sqrtCurrent - 1 / sqrtUpper),
    amount1RawApprox: l * (sqrtCurrent - sqrtLower),
  };
}

function feeGrowthInside(
  global: bigint,
  lowerOutside: bigint,
  upperOutside: bigint,
  currentTick: number,
  tickLower: number,
  tickUpper: number,
): bigint {
  const below = currentTick >= tickLower ? lowerOutside : global - lowerOutside;
  const above = currentTick < tickUpper ? upperOutside : global - upperOutside;
  return global - below - above;
}

function pendingFromFeeGrowth(
  liquidity: bigint,
  inside: bigint,
  insideLast: bigint,
): bigint {
  if (inside <= insideLast || liquidity === 0n) return 0n;
  return (liquidity * (inside - insideLast)) / (2n ** 128n);
}

function diff(label: string, agentValue: unknown, chainValue: unknown): string {
  if (agentValue == null) return `${label}: agent missing | chain=${String(chainValue)}`;
  return `${label}: agent=${String(agentValue)} | chain=${String(chainValue)}`;
}

async function main() {
  console.log('\nYieldGeko User UniV3 Debugger');
  console.log('Read-only | Arbitrum | independent on-chain verification\n');

  if (!USER_ADDRESS) throw new Error('Set TEST_USER_ADDRESS or DEBUG_USER_ADDRESS in .env');
  if (!VAULT_ADDRESS) throw new Error('VAULT_ADDRESS missing in .env');

  const provider = new ethers.JsonRpcProvider(ARB_RPC_URL, 42161, { staticNetwork: true });
  const posMgr = new ethers.Contract(ADDR.UNIV3_POS_MGR, POS_MGR_ABI, provider);
  const factory = new ethers.Contract(ADDR.UNIV3_FACTORY, FACTORY_ABI, provider);
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider);
  const prices = await fetchPrices(provider);

  const agentState = await getJSON(`${AGENT_URL}/state/${USER_ADDRESS}`);
  const position = agentState?.portfolio?.positions?.find((p: any) => p.uniV3TokenId)
    ?? agentState?.portfolio?.positions?.[0]
    ?? null;
  const tokenId = TOKEN_ID_OVERRIDE ?? position?.uniV3TokenId;

  if (!tokenId) {
    throw new Error(`No UniV3 tokenId found. Set DEBUG_UNIV3_TOKEN_ID or start the agent at ${AGENT_URL}`);
  }

  const [idleUSDC, deployedUSDC, policyRaw, owner, pos] = await Promise.all([
    vault.balances(USER_ADDRESS, ADDR.USDC) as Promise<bigint>,
    vault.deployed(USER_ADDRESS, ADDR.USDC) as Promise<bigint>,
    vault.policies(USER_ADDRESS).catch(() => null) as Promise<any>,
    posMgr.ownerOf(BigInt(tokenId)) as Promise<string>,
    posMgr.positions(BigInt(tokenId)),
  ]);

  const token0 = pos.token0 as string;
  const token1 = pos.token1 as string;
  const fee = Number(pos.fee);
  const tickLower = Number(pos.tickLower);
  const tickUpper = Number(pos.tickUpper);
  const liquidity = BigInt(pos.liquidity);
  const feeGrowthInside0LastX128 = BigInt(pos.feeGrowthInside0LastX128);
  const feeGrowthInside1LastX128 = BigInt(pos.feeGrowthInside1LastX128);
  const tokensOwed0 = BigInt(pos.tokensOwed0);
  const tokensOwed1 = BigInt(pos.tokensOwed1);

  const poolAddress = await factory.getPool(token0, token1, fee) as string;
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const [slot0, poolLiquidity, feeGrowthGlobal0, feeGrowthGlobal1, lowerTick, upperTick] = await Promise.all([
    pool.slot0(),
    pool.liquidity() as Promise<bigint>,
    pool.feeGrowthGlobal0X128() as Promise<bigint>,
    pool.feeGrowthGlobal1X128() as Promise<bigint>,
    pool.ticks(tickLower),
    pool.ticks(tickUpper),
  ]);

  const sqrtPriceX96 = BigInt(slot0[0]);
  const currentTick = Number(slot0[1]);
  const dec0 = decimals(token0);
  const dec1 = decimals(token1);
  const price0 = priceUSD(prices, token0);
  const price1 = priceUSD(prices, token1);
  const { amount0RawApprox, amount1RawApprox } = liquidityAmounts(liquidity, sqrtPriceX96, tickLower, tickUpper);

  const principal0 = amount0RawApprox / (10 ** dec0);
  const principal1 = amount1RawApprox / (10 ** dec1);
  const principal0USD = principal0 * price0;
  const principal1USD = principal1 * price1;
  const principalUSD = principal0USD + principal1USD;

  const owed0USD = Number(tokensOwed0) / (10 ** dec0) * price0;
  const owed1USD = Number(tokensOwed1) / (10 ** dec1) * price1;

  const inside0 = feeGrowthInside(
    BigInt(feeGrowthGlobal0),
    BigInt(lowerTick.feeGrowthOutside0X128),
    BigInt(upperTick.feeGrowthOutside0X128),
    currentTick,
    tickLower,
    tickUpper,
  );
  const inside1 = feeGrowthInside(
    BigInt(feeGrowthGlobal1),
    BigInt(lowerTick.feeGrowthOutside1X128),
    BigInt(upperTick.feeGrowthOutside1X128),
    currentTick,
    tickLower,
    tickUpper,
  );

  const pending0FromGrowth = pendingFromFeeGrowth(liquidity, inside0, feeGrowthInside0LastX128);
  const pending1FromGrowth = pendingFromFeeGrowth(liquidity, inside1, feeGrowthInside1LastX128);
  const totalPending0 = tokensOwed0 + pending0FromGrowth;
  const totalPending1 = tokensOwed1 + pending1FromGrowth;
  const totalPending0USD = Number(totalPending0) / (10 ** dec0) * price0;
  const totalPending1USD = Number(totalPending1) / (10 ** dec1) * price1;
  const totalPendingUSD = totalPending0USD + totalPending1USD;
  const navUSD = principalUSD + totalPendingUSD;

  const lowerPrice = tickToPrice(tickLower, dec0, dec1);
  const currentPrice = tickToPrice(currentTick, dec0, dec1);
  const upperPrice = tickToPrice(tickUpper, dec0, dec1);
  const outOfRange = currentTick < tickLower || currentTick >= tickUpper;
  const driftFromCenterTicks = Math.abs(currentTick - Math.round((tickLower + tickUpper) / 2));
  const halfRangeTicks = Math.max(1, Math.round((tickUpper - tickLower) / 2));
  const driftPctOfRange = driftFromCenterTicks / halfRangeTicks;

  console.log('1. Identity');
  console.log(`  user:      ${USER_ADDRESS}`);
  console.log(`  vault:     ${VAULT_ADDRESS}`);
  console.log(`  tokenId:   ${tokenId}`);
  console.log(`  nftOwner:  ${owner}`);
  console.log(`  owner OK:  ${owner.toLowerCase() === VAULT_ADDRESS.toLowerCase() ? 'yes' : 'NO'}`);
  console.log(`  agent URL: ${AGENT_URL}`);

  console.log('\n2. Vault');
  console.log(`  idle USDC:     ${fmtUnits(idleUSDC, 6)}`);
  console.log(`  deployed USDC: ${fmtUnits(deployedUSDC, 6)}`);
  console.log(`  policy active: ${policyRaw?.[0] === true}`);
  console.log(`  policy cap:    ${policyRaw ? fmtUnits(BigInt(policyRaw[1]), 6) : 'n/a'} USDC`);

  console.log('\n3. Pool + Range');
  console.log(`  pool:       ${poolAddress}`);
  console.log(`  pair:       ${symbol(token0)} / ${symbol(token1)} | fee ${(fee / 10_000).toString()}%`);
  console.log(`  liquidity:  ${liquidity.toString()}`);
  console.log(`  pool liq:   ${poolLiquidity.toString()}`);
  console.log(`  ticks:      lower=${tickLower} current=${currentTick} upper=${tickUpper}`);
  console.log(`  in range:   ${outOfRange ? 'NO' : 'yes'}`);
  console.log(`  drift:      ${pct(driftPctOfRange * 100)} of half-range`);
  console.log(`  price t1/t0 lower/current/upper: ${lowerPrice.toString()} / ${currentPrice.toString()} / ${upperPrice.toString()}`);

  console.log('\n4. Principal NAV');
  console.log(`  price source:         ${pricesAreHealthy(prices) ? 'Chainlink live' : 'Chainlink partial/fallback'}`);
  console.log(`  ${symbol(token0)} price USD:     ${fmtUSD(price0)}`);
  console.log(`  ${symbol(token1)} price USD:     ${fmtUSD(price1)}`);
  console.log(`  ${symbol(token0)} amount approx: ${principal0.toString()} (${fmtUSD(principal0USD)} USD)`);
  console.log(`  ${symbol(token1)} amount approx: ${principal1.toString()} (${fmtUSD(principal1USD)} USD)`);
  console.log(`  principal USD:       ${fmtUSD(principalUSD)}`);
  console.log(`  pending fees USD:    ${fmtUSD(totalPendingUSD)}`);
  console.log(`  independent NAV USD: ${fmtUSD(navUSD)}`);

  console.log('\n5. Fees');
  console.log(`  tokensOwed0 raw:          ${tokensOwed0.toString()} (${fmtUnits(tokensOwed0, dec0)} ${symbol(token0)})`);
  console.log(`  tokensOwed1 raw:          ${tokensOwed1.toString()} (${fmtUnits(tokensOwed1, dec1)} ${symbol(token1)})`);
  console.log(`  fee-growth pending0 raw:  ${pending0FromGrowth.toString()} (${fmtUnits(pending0FromGrowth, dec0)} ${symbol(token0)})`);
  console.log(`  fee-growth pending1 raw:  ${pending1FromGrowth.toString()} (${fmtUnits(pending1FromGrowth, dec1)} ${symbol(token1)})`);
  console.log(`  total pending0 raw:       ${totalPending0.toString()} (${fmtUnits(totalPending0, dec0)} ${symbol(token0)})`);
  console.log(`  total pending1 raw:       ${totalPending1.toString()} (${fmtUnits(totalPending1, dec1)} ${symbol(token1)})`);
  console.log(`  claimable tokensOwed USD: ${fmtUSD(owed0USD + owed1USD)}`);
  console.log(`  estimated pending USD:    ${fmtUSD(totalPendingUSD)}`);

  console.log('\n6. Agent Comparison');
  if (!agentState || !position) {
    console.log('  agent state unavailable; on-chain audit above still completed.');
  } else {
    console.log(`  phase: ${agentState.phase}`);
    console.log(`  ${diff('currentUSD', position.currentUSD, navUSD)}`);
    console.log(`  ${diff('pendingRewardsUSD', position.pendingRewardsUSD, totalPendingUSD)}`);
    console.log(`  ${diff('tokensOwed0Raw', position.uniV3TokensOwed0Raw, tokensOwed0.toString())}`);
    console.log(`  ${diff('tokensOwed1Raw', position.uniV3TokensOwed1Raw, tokensOwed1.toString())}`);
    console.log(`  ${diff('token0', position.uniV3Token0, token0)}`);
    console.log(`  ${diff('token1', position.uniV3Token1, token1)}`);
    console.log(`  ${diff('outOfRangeTicks', position.uniV3OutOfRangeTicks, outOfRange ? '>=1 after next tick' : 0)}`);
  }

  console.log('\n7. Verdict');
  const navDelta = typeof position?.currentUSD === 'number' ? Math.abs(position.currentUSD - navUSD) : 0;
  const agentNAVOk = !position || navDelta < 0.00001;
  const feeExactOk = !position
    || (String(position.uniV3TokensOwed0Raw ?? '') === tokensOwed0.toString()
      && String(position.uniV3TokensOwed1Raw ?? '') === tokensOwed1.toString());

  console.log(`  NFT owned by vault:       ${owner.toLowerCase() === VAULT_ADDRESS.toLowerCase() ? 'PASS' : 'FAIL'}`);
  console.log(`  Position in range:        ${outOfRange ? 'FAIL' : 'PASS'}`);
  console.log(`  Agent NAV close enough:   ${agentNAVOk ? 'PASS' : `CHECK (delta ${navDelta})`}`);
  console.log(`  Agent raw fees match:     ${feeExactOk ? 'PASS' : 'CHECK'}`);
  console.log(`  Fee-growth pending exists:${totalPendingUSD > 0 ? 'YES' : 'no'}`);
}

main().catch(err => {
  console.error('\nDebug script failed:', err.message);
  process.exit(1);
});
