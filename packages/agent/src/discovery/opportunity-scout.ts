import { createPublicClient, http, parseAbi, getAddress, keccak256, encodeAbiParameters } from 'viem';
import { arbitrum } from 'viem/chains';

export interface ScannedVenue {
  venue: string;
  asset: string;
  apy: number;
  liquidityScore: number;
  riskScore: number;
  stabilityScore: number;
  metadata: any;
}

const MORPHO_ADDR = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb');
const SUSDE_ADDR = getAddress('0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2');
const USDC_ADDR = getAddress('0xaf88d065e77c8cC2239327C5edB3A432268e5831');

const ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint32 lastUpdate, uint128 fee)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function getReserveData(address asset) view returns (uint256 unk1, uint128 unk2, uint128 unk3, uint128 currentLiquidityRate, uint128 unk4, uint128 unk5, uint128 unk6, uint128 currentLiquidityRateBorrow, uint128 unk8, uint40 unk9)',
  'function getLiquidityAndRates() view returns (uint256 totalDeposits, uint256 totalBorrows, uint256 depositRate, uint256 borrowRate)'
]);

export class OpportunityScout {
  private client: any;
  private managedAmount: bigint;

  constructor(rpcUrl: string, managedAmount: bigint = 5000000000n) { // Default 5k USDC
    this.client = createPublicClient({
      chain: arbitrum,
      transport: http(rpcUrl),
    });
    this.managedAmount = managedAmount;
  }

  private getMorphoId(collateral: string, loan: string, oracle: string, irm: string, lltv: bigint) {
    return keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
        [getAddress(loan), getAddress(collateral), getAddress(oracle), getAddress(irm), lltv]
    ));
  }

  private async getFairValue(asset: string): Promise<number> {
    if (asset.includes('sUSDe')) {
        try {
            const [assets, supply] = await Promise.all([
                this.client.readContract({ address: SUSDE_ADDR, abi: ABI, functionName: 'totalAssets' }),
                this.client.readContract({ address: SUSDE_ADDR, abi: ABI, functionName: 'totalSupply' })
            ]);
            return Number(assets) / Number(supply);
        } catch (e) {
            return 1.024; // Fallback to last known safe
        }
    }
    if (asset.includes('weETH')) return 1.051; 
    return 1.0;
  }

  private calculateStability(asset: string, price: number, fairValue: number): number {
    const deviation = Math.abs(fairValue - price) / fairValue;
    const sensitivity = asset.includes('USDC') || asset.includes('USDT') ? 0.01 : 0.05;
    const score = Math.max(0, 1.0 - (deviation / sensitivity));
    return score * 100;
  }

  async getAlphaLeaderboard(): Promise<ScannedVenue[]> {
    const leaderboard: ScannedVenue[] = [];
    const susdeFairValue = await this.getFairValue('sUSDe');
    
    // 1. DEX Probes (Dynamic)
    const factoryAddr = getAddress('0x1F98431c8aD98523631AE4a59f267346ea31F984');
    try {
        const fees = [100, 500];
        for (const fee of fees) {
            const p = await this.client.readContract({ address: factoryAddr, abi: ABI, functionName: 'getPool', args: [SUSDE_ADDR, USDC_ADDR, fee] });
            if (p === '0x0000000000000000000000000000000000000000') continue;
            
            const [slot, liq, t0] = await Promise.all([
                this.client.readContract({ address: p, abi: ABI, functionName: 'slot0' }),
                this.client.readContract({ address: p, abi: ABI, functionName: 'liquidity' }),
                this.client.readContract({ address: p, abi: ABI, functionName: 'token0' })
            ]);

            const ratio = Number(slot[0]) / 2**96;
            let price = (ratio * ratio) * 1e12;
            if (getAddress(t0 as string) !== SUSDE_ADDR) price = 1 / price;

            const baseApy = 15.4;
            const poolDepth = Number(liq) / 1e12; 
            const priceImpact = Number(this.managedAmount / 1000000n) / (poolDepth * 0.5);
            const lScore = Math.max(0, 1.0 - priceImpact);
            const stability = this.calculateStability('sUSDe', price, susdeFairValue);
            
            leaderboard.push({
                venue: 'Uniswap V3',
                asset: 'sUSDe',
                apy: baseApy * (stability / 100) * (0.8 + 0.2 * lScore),
                liquidityScore: lScore * 100,
                stabilityScore: stability,
                riskScore: 95,
                metadata: { feeTier: fee / 10000, type: 'lp' }
            });
        }
    } catch (e: any) {
        console.warn(`! DEX scanning partially failed: ${e.message}`);
    }

    // 2. Morpho Blue Discovery
    try {
        const morphoMarketId = this.getMorphoId(
            SUSDE_ADDR,
            USDC_ADDR,
            '0xdEb640d2B6e4bE71661A763b652758f1E2293B72',
            '0x66F3699c2794c48972620A0bA5B15252063006DA',
            915000000000000000n
        );
        const mData = await this.client.readContract({ address: MORPHO_ADDR, abi: ABI, functionName: 'market', args: [morphoMarketId] });
        const supply = Number(mData[0]);
        const borrow = Number(mData[2]);
        const utilization = supply > 0 ? borrow / supply : 0.85; 
        
        leaderboard.push({
            venue: 'Morpho Blue',
            asset: 'sUSDe (Isolated)',
            apy: 15.4 + (utilization * 8.5),
            liquidityScore: 85,
            stabilityScore: this.calculateStability('sUSDe', susdeFairValue, susdeFairValue),
            riskScore: 92,
            metadata: { type: 'lending', lltv: 91.5 }
        });
    } catch (e: any) {
        console.warn(`! Morpho scanning failed: ${e.message}`);
    }

    // 3. Silo Finance (Real-Time)
    const SILO_SUSDE = getAddress('0x890786f376dcde0d92b5f899d59a4f038fff620b');
    try {
        const [totalDeposits, totalBorrows, depositRate, borrowRate] = await this.client.readContract({ address: SILO_SUSDE, abi: ABI, functionName: 'getLiquidityAndRates' });
        const siloApy = Number(depositRate) / 1e16; // Convert to %
        leaderboard.push({
            venue: 'Silo Finance',
            asset: 'sUSDe Market',
            apy: siloApy,
            liquidityScore: Math.min(Number(totalDeposits) / 1e21, 100),
            stabilityScore: this.calculateStability('sUSDe', susdeFairValue, susdeFairValue),
            riskScore: 94,
            metadata: { type: 'lending' }
        });
    } catch (e: any) {
        console.warn(`! Silo scanning failed: ${e.message}`);
    }

    // 4. Ecosystem Safety Layer (Mixed Probes)
    const AAVE_POOL = getAddress('0x794a61358D6845594F94dc1DB02A252b5b4814aD');
    try {
        const rData = await this.client.readContract({ address: AAVE_POOL, abi: ABI, functionName: 'getReserveData', args: [USDC_ADDR] });
        const aaveApy = Number(rData[3]) / 1e25; // Convert Ray to %
        leaderboard.push({
            venue: 'Aave V3',
            asset: 'USDC (Safe)',
            apy: aaveApy,
            liquidityScore: 100,
            stabilityScore: 100,
            riskScore: 99,
            metadata: { type: 'lending' }
        });
    } catch (e: any) {
        console.warn(`! Aave scanning failed: ${e.message}`);
    }

    return leaderboard.sort((a, b) => b.apy - a.apy);
  }
}
