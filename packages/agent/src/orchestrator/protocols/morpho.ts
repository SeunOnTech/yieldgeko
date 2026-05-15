import { Contract, Interface, JsonRpcProvider } from 'ethers';
import type { PriceMap } from './chainlink';
import { getPrice } from './chainlink';

const MULTICALL3  = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'; 

export const MORPHO_VAULTS: Record<string, {
  vaultAddress: string;
  asset:        string;
  assetSym:     string;
  decimals:     number;
  curator:      string;  
}> = {
  'Morpho USDC': {
    vaultAddress: '0x78Ff5a83beE95F0f4Ebc44D7F37FE92a62e34b31',
    asset:        '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    assetSym:     'USDC',
    decimals:     6,
    curator:      'Gauntlet',
  },
  'Morpho USDT': {
    vaultAddress: '0x7b6bfB957EEA0e19f5e79F0b4C2bfEd4e56d1De4',
    asset:        '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    assetSym:     'USDT',
    decimals:     6,
    curator:      'Gauntlet',
  },
  'Morpho WETH': {
    vaultAddress: '0x9a8bC3B04b7E7f2Cb3b23e1D4ae36b8B40E6e3B0',
    asset:        '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    assetSym:     'WETH',
    decimals:     18,
    curator:      'Steakhouse',
  },
};

export interface MorphoVault {
  name:           string;
  vaultAddress:   string;
  asset:          string;
  assetSym:       string;
  totalAssetsUSD: number;   
  supplyAPY:      number;   
  utilizationPct: number;
  updatedAt:      number;
}

export interface MorphoUserPosition {
  vault:        string;
  shareBalance: bigint;
  valueUSD:     number;
  currentAPY:   number;
}

const MC3_ABI = ['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)'];

const ERC4626_ABI = [
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];

export async function fetchMorphoVaults(
  provider: JsonRpcProvider,
  prices:   PriceMap,
): Promise<MorphoVault[]> {
  const mc    = new Contract(MULTICALL3, MC3_ABI, provider);
  const iface = new Interface(ERC4626_ABI);
  const names = Object.keys(MORPHO_VAULTS);

  const calls: { target: string; allowFailure: boolean; callData: string }[] = [];
  for (const name of names) {
    const v = MORPHO_VAULTS[name];
    calls.push(
      { target: v.vaultAddress, allowFailure: true, callData: iface.encodeFunctionData('totalAssets')  },
      { target: v.vaultAddress, allowFailure: true, callData: iface.encodeFunctionData('totalSupply')  },
      
      { target: v.vaultAddress, allowFailure: true, callData: iface.encodeFunctionData('convertToAssets', [BigInt('1000000000000000000')]) },
    );
  }

  const vaults: MorphoVault[] = [];

  try {
    const raw: { success: boolean; returnData: string }[] = await mc.aggregate3(calls);

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const v    = MORPHO_VAULTS[name];
      const base = i * 3;

      try {
        const totalAssets = raw[base].success
          ? BigInt(iface.decodeFunctionResult('totalAssets', raw[base].returnData)[0].toString())
          : 0n;
        const totalSupply = raw[base + 1].success
          ? BigInt(iface.decodeFunctionResult('totalSupply', raw[base + 1].returnData)[0].toString())
          : 0n;
        
        const sharePrice = raw[base + 2].success
          ? Number(iface.decodeFunctionResult('convertToAssets', raw[base + 2].returnData)[0].toString()) / 10 ** v.decimals
          : 1.0;

        if (totalAssets === 0n) continue;

        const price         = getPrice(prices, v.assetSym);
        const totalAssetsUSD = Number(totalAssets) / 10 ** v.decimals * price;

        
        
        
        const supplyAPY      = 0; 
        const utilizationPct = totalSupply > 0n ? Number(totalAssets * 10_000n / totalSupply) / 100 : 0;

        vaults.push({
          name, vaultAddress: v.vaultAddress,
          asset: v.asset, assetSym: v.assetSym,
          totalAssetsUSD, supplyAPY, utilizationPct,
          updatedAt: Date.now(),
        });
      } catch {  }
    }
  } catch {  }

  return vaults;
}

export async function fetchMorphoBatchPositions(
  userAddresses: string[],
  vaults:        MorphoVault[],
  provider:      JsonRpcProvider,
  prices:        PriceMap,
): Promise<Map<string, MorphoUserPosition[]>> {
  if (vaults.length === 0 || userAddresses.length === 0) return new Map();

  const mc    = new Contract(MULTICALL3, MC3_ABI, provider);
  const iface = new Interface(ERC4626_ABI);

  const calls: { target: string; allowFailure: boolean; callData: string }[] = [];
  for (const user of userAddresses) {
    for (const vault of vaults) {
      calls.push({
        target:       vault.vaultAddress,
        allowFailure: true,
        callData:     iface.encodeFunctionData('balanceOf', [user]),
      });
    }
  }

  
  const convCalls = vaults.map(v => ({
    target:       v.vaultAddress,
    allowFailure: true,
    callData:     iface.encodeFunctionData('convertToAssets', [BigInt('1000000000000000000')]),
  }));

  const results = new Map<string, MorphoUserPosition[]>();

  try {
    const [rawBalances, rawConv] = await Promise.all([
      mc.aggregate3(calls),
      mc.aggregate3(convCalls),
    ]);

    const convRates = vaults.map((vault, i) => {
      const v = MORPHO_VAULTS[vault.name];
      return rawConv[i].success
        ? Number(iface.decodeFunctionResult('convertToAssets', rawConv[i].returnData)[0].toString()) / 10 ** (v?.decimals ?? 18)
        : 1.0;
    });

    const stride = vaults.length;
    for (let u = 0; u < userAddresses.length; u++) {
      const user = userAddresses[u];
      const base = u * stride;
      const userPos: MorphoUserPosition[] = [];

      for (let vIdx = 0; vIdx < vaults.length; vIdx++) {
        const vault = vaults[vIdx];
        const res = rawBalances[base + vIdx];
        if (!res?.success || !res.returnData || res.returnData === '0x') continue;

        try {
          const shareBal = BigInt(iface.decodeFunctionResult('balanceOf', res.returnData)[0].toString());
          if (shareBal === 0n) continue;

          const price = getPrice(prices, vault.assetSym);
          const valueUSD = (Number(shareBal) / 1e18) * convRates[vIdx] * price;

          userPos.push({
            vault:      vault.name,
            shareBalance: shareBal,
            valueUSD,
            currentAPY: vault.supplyAPY,
          });
        } catch {  }
      }
      results.set(user, userPos);
    }
  } catch (err: any) {
    console.warn('[Morpho] Batch fetch failed:', err.message);
  }

  return results;
}

export async function verifyMorphoVault(
  vaultName:  string,
  minTvlUSD:  number,
  provider:   JsonRpcProvider,
  prices:     PriceMap,
): Promise<{ ok: boolean; vault: MorphoVault | null; error: string | null }> {
  const vaults = await fetchMorphoVaults(provider, prices);
  const vault  = vaults.find(v => v.name === vaultName);

  if (!vault) return { ok: false, vault: null, error: `Morpho vault ${vaultName} not found` };
  if (vault.totalAssetsUSD < minTvlUSD) {
    return { ok: false, vault, error: `Vault TVL $${(vault.totalAssetsUSD / 1e6).toFixed(2)}M below minimum $${(minTvlUSD / 1e6).toFixed(2)}M` };
  }

  return { ok: true, vault, error: null };
}
