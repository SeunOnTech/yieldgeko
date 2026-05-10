/**
 * DriftMonitor — O(1) RPC drift assessment for all active UniV3 positions
 *
 * Uses Multicall3 to batch-read slot0() for every unique pool and positions()
 * for every active tokenId across ALL users in exactly 2 RPC calls regardless
 * of user or position count.
 *
 * Scale: 30,000 positions → 2 Multicall3 calls → sub-second at any RPC provider.
 */

import { ethers, JsonRpcProvider } from 'ethers';
import type { UserState } from './types';

// ── Addresses ─────────────────────────────────────────────────────────────────

const MULTICALL3    = '0xcA11bde05977b3631167028862bE2a173976CA11';
const POS_MGR       = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';

// ── ABIs ──────────────────────────────────────────────────────────────────────

const MC3_ABI  = ['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)'];
const SLOT0_ABI = ['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)'];
const POS_ABI   = ['function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'];

const slot0Iface = new ethers.Interface(SLOT0_ABI);
const posIface   = new ethers.Interface(POS_ABI);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DriftResult {
  userId:       string;
  positionId:   string;
  tokenId:      bigint;
  poolAddress:  string;
  currentTick:  number;
  centerTick:   number;
  tickLower:    number;
  tickUpper:    number;
  driftPct:     number;    // 0–1; triggers rebalance at ≥ 0.70
  inRange:      boolean;
  liquidity:    bigint;
  tokensOwed0:  bigint;
  tokensOwed1:  bigint;
  sqrtPriceX96: bigint;    // for optimal swap sizing during rebalance
}

interface ActiveRef {
  userId:      string;
  positionId:  string;
  tokenId:     bigint;
  poolAddress: string;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function assessAllDrifts(
  provider:   JsonRpcProvider,
  userStates: UserState[],
): Promise<DriftResult[]> {
  // 1. Collect all active UniV3 position references
  const refs: ActiveRef[] = [];
  for (const user of userStates) {
    if (!user.portfolio) continue;
    for (const pos of user.portfolio.positions) {
      if (pos.strategyType !== 'DELTA_NEUTRAL') continue;
      if (!pos.uniV3TokenId || !pos.uniV3EntryPool) continue;
      refs.push({
        userId:      user.userId,
        positionId:  pos.id,
        tokenId:     BigInt(pos.uniV3TokenId),
        poolAddress: pos.uniV3EntryPool.toLowerCase(),
      });
    }
  }

  if (refs.length === 0) return [];

  // 2. Unique pool addresses for slot0 reads
  const uniquePools = [...new Set(refs.map(r => r.poolAddress))];

  const mc3 = new ethers.Contract(MULTICALL3, MC3_ABI, provider);

  // 3. Parallel Multicall3: slot0 for all pools + positions for all tokenIds
  const slot0Calls = uniquePools.map(pool => ({
    target: pool, allowFailure: true,
    callData: slot0Iface.encodeFunctionData('slot0'),
  }));

  const posCalls = refs.map(ref => ({
    target: POS_MGR, allowFailure: true,
    callData: posIface.encodeFunctionData('positions', [ref.tokenId]),
  }));

  // Both batches fire simultaneously — 2 RPC calls total
  const [slot0Results, posResults] = await Promise.all([
    mc3.aggregate3.staticCall(slot0Calls) as Promise<Array<{ success: boolean; returnData: string }>>,
    mc3.aggregate3.staticCall(posCalls)   as Promise<Array<{ success: boolean; returnData: string }>>,
  ]);

  // 4. Parse slot0 → currentTick + sqrtPriceX96 per pool
  const tickByPool    = new Map<string, number>();
  const sqrtByPool    = new Map<string, bigint>();
  for (let i = 0; i < uniquePools.length; i++) {
    const r = slot0Results[i];
    if (!r?.success || !r.returnData || r.returnData === '0x') continue;
    try {
      const decoded = slot0Iface.decodeFunctionResult('slot0', r.returnData);
      tickByPool.set(uniquePools[i], Number(decoded[1]));
      sqrtByPool.set(uniquePools[i], BigInt(decoded[0]));
    } catch { /* skip bad pool */ }
  }

  // 5. Parse positions → compute drift for each
  const results: DriftResult[] = [];
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    const r   = posResults[i];
    if (!r?.success || !r.returnData || r.returnData === '0x') continue;

    try {
      const d         = posIface.decodeFunctionResult('positions', r.returnData);
      const tickLower = Number(d[5]);
      const tickUpper = Number(d[6]);
      const liquidity = BigInt(d[7]);
      const tokensOwed0 = BigInt(d[10]);
      const tokensOwed1 = BigInt(d[11]);

      const currentTick = tickByPool.get(ref.poolAddress) ?? 0;
      const sqrtPrice   = sqrtByPool.get(ref.poolAddress) ?? 0n;
      const centerTick  = Math.floor((tickLower + tickUpper) / 2);
      const halfRange   = tickUpper - centerTick;
      const driftPct    = halfRange > 0 ? Math.abs(currentTick - centerTick) / halfRange : 0;
      const inRange     = currentTick >= tickLower && currentTick <= tickUpper;

      results.push({
        userId: ref.userId, positionId: ref.positionId,
        tokenId: ref.tokenId, poolAddress: ref.poolAddress,
        currentTick, centerTick, tickLower, tickUpper,
        driftPct, inRange, liquidity,
        tokensOwed0, tokensOwed1,
        sqrtPriceX96: sqrtPrice,
      });
    } catch { /* skip bad position */ }
  }

  return results;
}
