import { arbitrumClient } from '../transport/rpc-config';
import { decodeAbiParameters, encodeFunctionData, parseAbi, getAddress } from 'viem';

const POOL_ADDRESS = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
const USDC_ADDRESS = getAddress('0xaf88d065e77c8cC2239327C5EDB3A432268e5831');

const IPool = parseAbi([
  'function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasuryScaled, uint128 totalAToken, uint128 totalStableDebt, uint128 totalVariableDebt)'
]);

export async function fetchAaveUSDCSupplyAPY(): Promise<{
  apyBps: bigint;
  liquidity: bigint;
  utilization: bigint;
  timestamp: number;
}> {
  const calldata = encodeFunctionData({
    abi: IPool,
    functionName: 'getReserveData',
    args: [USDC_ADDRESS],
  });

  const { data: rawResult } = await arbitrumClient.call({
    to: POOL_ADDRESS,
    data: calldata,
  });

  if (!rawResult) throw new Error('Failed to fetch Aave data');

  const fields = [
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }
  ];

  const decoded = decodeAbiParameters(fields as any, rawResult) as bigint[];

  
  
  
  
  const liquidityRate = decoded[2]!;
  const totalAToken = decoded[13]!;
  const totalVariableDebt = decoded[14]!;

  
  const apyBps = liquidityRate / 10n**23n; 

  const utilization = totalAToken > 0n 
    ? (totalVariableDebt * 10000n) / (totalAToken + totalVariableDebt) 
    : 0n;

  return {
    apyBps,
    liquidity: totalAToken,
    utilization,
    timestamp: Math.floor(Date.now() / 1000),
  };
}
