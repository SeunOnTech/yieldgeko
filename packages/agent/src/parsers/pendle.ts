import { arbitrumClient } from '../transport/rpc-config';
import { decodeAbiParameters, encodeFunctionData, parseAbi, Address, getAddress } from 'viem';

export const DEFAULT_PENDLE_MARKET = getAddress('0x46d62a8dede1bf2d0de04f2ed863245cbba5e538');

const IMarket = parseAbi([
  'function readState(address router) view returns (uint256 totalPt, uint256 totalSy, int256 scalarRoot, uint256 totalLp, uint256 ptPrice, uint256 expiry, uint256 lnFeeRateRoot, uint256 reserveFeePercent, uint256 lastLnImpliedRate)'
]);

export async function fetchPendleMarketYield(market: Address = DEFAULT_PENDLE_MARKET): Promise<{
  impliedApyBps: bigint;
  ptPrice: bigint;
  liquidity: bigint;
  maturity: number;
}> {
  const calldata = encodeFunctionData({
    abi: IMarket,
    functionName: 'readState',
    args: ['0x0000000000000000000000000000000000000000'],
  });

  const { data: rawResult } = await arbitrumClient.call({
    to: market,
    data: calldata,
  });

  if (!rawResult) throw new Error(`Failed to fetch Pendle data from ${market}`);

  const fields = [
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
    { type: 'uint256' }
  ];

  const decoded = decodeAbiParameters(fields as any, rawResult) as bigint[];

  
  
  
  
  
  const impliedApyBps = decoded[8]! / 10n**14n; 

  return {
    impliedApyBps,
    ptPrice: decoded[4]!,
    liquidity: decoded[3]!,
    maturity: Number(decoded[5]!),
  };
}
