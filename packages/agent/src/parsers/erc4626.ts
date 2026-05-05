import { PublicClient, Address } from 'viem';

const ERC4626_ABI = [
  { name: 'totalAssets', type: 'function', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalSupply', type: 'function', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'previewDeposit', type: 'function', inputs: [{ name: 'assets', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
] as const;

export async function fetchERC4626Metrics(
  client: PublicClient,
  vault: Address,
  assetDecimals: number
): Promise<{ apyBps: bigint; tvl: bigint; sharesPerAsset: bigint }> {
  const results = await client.multicall({
    contracts: [
      { address: vault, abi: ERC4626_ABI, functionName: 'totalAssets' },
      { address: vault, abi: ERC4626_ABI, functionName: 'totalSupply' },
    ],
  });

  const tvl = (results[0].result as bigint) ?? 0n;
  const shares = (results[1].result as bigint) ?? 0n;
  const sharesPerAsset = shares > 0n ? (shares * 10n**BigInt(assetDecimals)) / tvl : 0n;

  // For Day 3: APY calculation from 4626 requires historical sampling or 3rd party API
  // We will return a placeholder and note the SAMPLING requirement for Day 4.
  const apyBps = 650n; // 6.50% placeholder

  return { apyBps, tvl, sharesPerAsset };
}
