import { Contract, Interface, JsonRpcProvider } from 'ethers';
import type { PriceMap } from './chainlink';
import { getPrice } from './chainlink';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

export const PENDLE_MARKETS: Record<string, {
  marketAddress: string;
  ptAddress:     string;
  ytAddress:     string;
  underlying:    string;
  underlyingSym: string;
  decimals:      number;
}> = {
  'PT-weETH':   {
    marketAddress: '0x08a152834de126d2ef83D612ff36e4523FD0017F',
    ptAddress:     '0x1c27Ad8a19Ba026ADaBD615F6Bc77158130cfBE4',
    ytAddress:     '0x4E28826d32F1C398DED160DC16Ac6873357d048f',
    underlying:    '0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe',  
    underlyingSym: 'WETH',
    decimals:      18,
  },
  'PT-wstETH':  {
    marketAddress: '0x3A10B7e5a1d43E8E47DDb62A2dE92a2f7D79e3E9',
    ptAddress:     '0xa15B52576BCbf1072F4a011B0F8db7f28B0bBa3b',
    ytAddress:     '0x220700b0b6aBdD7b4c3a24dF36Bc6b3FFdFf1d32',
    underlying:    '0x5979D7b546E38E414F7E9822514be443A4800529',  
    underlyingSym: 'WETH',  
    decimals:      18,
  },
};

export interface PendleMarket {
  name:          string;
  marketAddress: string;
  ptAddress:     string;
  expiry:        number;       
  daysToExpiry:  number;
  isExpired:     boolean;
  ptPriceRatio:  number;       
  impliedAPY:    number;       
  totalSupplyUSD: number;      
  updatedAt:     number;
}

export interface PendleUserPosition {
  market:        string;
  ptBalance:     bigint;
  lpBalance:     bigint;
  ptValueUSD:    number;
  lpValueUSD:    number;
}

const MC3_ABI = ['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)'];

const PENDLE_MARKET_ABI = [
  'function expiry() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function readState(address router) view returns (tuple(int256 totalPt, int256 totalSy, int256 totalLp, address treasury, int256 scalarRoot, uint256 expiry, uint256 lnFeeRateRoot, uint256 reserveFeePercent, uint256 lastLnImpliedRate) marketState)',
];

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

function impliedAPYFromLnRate(lnRate: bigint, expiry: number): number {
  try {
    const now     = Math.floor(Date.now() / 1_000);
    if (expiry <= now) return 0;
    const daysLeft = (expiry - now) / 86_400;
    
    const lnYield  = Number(lnRate) / 1e18;
    const implied  = (Math.exp(lnYield) - 1) * (365 / daysLeft);
    return Math.max(0, implied * 100);  
  } catch { return 0; }
}

export async function fetchPendleMarkets(
  provider: JsonRpcProvider,
  prices:   PriceMap,
): Promise<PendleMarket[]> {
  const mc    = new Contract(MULTICALL3, MC3_ABI, provider);
  const iface = new Interface(PENDLE_MARKET_ABI);
  const eface = new Interface(ERC20_ABI);
  const names = Object.keys(PENDLE_MARKETS);

  
  const DUMMY_ROUTER = '0x0000000001E4ef00d069e71d6bA041b0A16F7eA0';
  const calls: { target: string; allowFailure: boolean; callData: string }[] = [];

  for (const name of names) {
    const m = PENDLE_MARKETS[name];
    calls.push(
      { target: m.marketAddress, allowFailure: true, callData: iface.encodeFunctionData('expiry')      },
      { target: m.marketAddress, allowFailure: true, callData: iface.encodeFunctionData('totalSupply') },
      { target: m.marketAddress, allowFailure: true, callData: iface.encodeFunctionData('readState', [DUMMY_ROUTER]) },
    );
  }

  const markets: PendleMarket[] = [];

  try {
    const raw: { success: boolean; returnData: string }[] = await mc.aggregate3(calls);
    const now = Math.floor(Date.now() / 1_000);

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const mkt  = PENDLE_MARKETS[name];
      const base = i * 3;

      try {
        const expiry      = raw[base].success     ? Number(iface.decodeFunctionResult('expiry', raw[base].returnData)[0]) : 0;
        const totalSupply = raw[base + 1].success ? BigInt(iface.decodeFunctionResult('totalSupply', raw[base + 1].returnData)[0].toString()) : 0n;
        const state       = raw[base + 2].success ? iface.decodeFunctionResult('readState', raw[base + 2].returnData)[0] : null;

        if (expiry === 0) continue;

        const daysToExpiry = Math.max(0, (expiry - now) / 86_400);
        const isExpired    = expiry <= now;

        
        let impliedAPY = 0;
        let ptPriceRatio = 0;
        if (state && !isExpired) {
          const lnImpliedRate = BigInt((state.lastLnImpliedRate ?? 0).toString());
          impliedAPY = impliedAPYFromLnRate(lnImpliedRate, expiry);
          
          ptPriceRatio = daysToExpiry > 0 ? 1 / (1 + impliedAPY / 100) ** (daysToExpiry / 365) : 1;
        }

        const underlyingPrice  = getPrice(prices, mkt.underlyingSym);
        const totalSupplyUSD   = (Number(totalSupply) / 10 ** mkt.decimals) * underlyingPrice;

        markets.push({
          name, marketAddress: mkt.marketAddress, ptAddress: mkt.ptAddress,
          expiry, daysToExpiry, isExpired,
          ptPriceRatio, impliedAPY, totalSupplyUSD,
          updatedAt: Date.now(),
        });
      } catch {  }
    }
  } catch {  }

  return markets.filter(m => !m.isExpired && m.daysToExpiry > 7); 
}

export async function fetchPendleBatchPositions(
  userAddresses: string[],
  markets:       PendleMarket[],
  provider:      JsonRpcProvider,
  prices:        PriceMap,
): Promise<Map<string, PendleUserPosition[]>> {
  if (markets.length === 0 || userAddresses.length === 0) return new Map();

  const mc    = new Contract(MULTICALL3, MC3_ABI, provider);
  const eface = new Interface(ERC20_ABI);

  const calls: { target: string; allowFailure: boolean; callData: string }[] = [];
  for (const user of userAddresses) {
    for (const m of markets) {
      
      calls.push({
        target:       m.ptAddress,
        allowFailure: true,
        callData:     eface.encodeFunctionData('balanceOf', [user]),
      });
      
      calls.push({
        target:       m.marketAddress,
        allowFailure: true,
        callData:     eface.encodeFunctionData('balanceOf', [user]),
      });
    }
  }

  
  const supplyCalls = markets.map(m => ({
    target:       m.marketAddress,
    allowFailure: true,
    callData:     eface.encodeFunctionData('totalSupply'),
  }));

  const results = new Map<string, PendleUserPosition[]>();

  try {
    const [rawBalances, rawSupplies] = await Promise.all([
      mc.aggregate3(calls),
      mc.aggregate3(supplyCalls),
    ]);

    const lpTotalSupplies = markets.map((m, i) => {
      return rawSupplies[i].success ? BigInt(eface.decodeFunctionResult('totalSupply', rawSupplies[i].returnData)[0].toString()) : 1n;
    });

    const stride = markets.length * 2;
    for (let u = 0; u < userAddresses.length; u++) {
      const user = userAddresses[u];
      const base = u * stride;
      const userPos: PendleUserPosition[] = [];

      for (let mIdx = 0; mIdx < markets.length; mIdx++) {
        const m    = markets[mIdx];
        const mkt  = PENDLE_MARKETS[m.name];
        
        const ptRes = rawBalances[base + mIdx * 2];
        const lpRes = rawBalances[base + mIdx * 2 + 1];

        const ptBal = ptRes?.success ? BigInt(eface.decodeFunctionResult('balanceOf', ptRes.returnData)[0].toString()) : 0n;
        const lpBal = lpRes?.success ? BigInt(eface.decodeFunctionResult('balanceOf', lpRes.returnData)[0].toString()) : 0n;

        if (ptBal === 0n && lpBal === 0n) continue;

        const price = getPrice(prices, mkt?.underlyingSym ?? 'WETH');
        const ptValueUSD = (Number(ptBal) / 10 ** (mkt?.decimals ?? 18)) * price * m.ptPriceRatio;
        
        
        const totalLpSupply = lpTotalSupplies[mIdx];
        const lpValueUSD = totalLpSupply > 0n 
          ? (Number(lpBal) / Number(totalLpSupply)) * m.totalSupplyUSD 
          : 0;

        userPos.push({
          market: m.name,
          ptBalance: ptBal,
          lpBalance: lpBal,
          ptValueUSD,
          lpValueUSD,
        });
      }
      results.set(user, userPos);
    }
  } catch (err: any) {
    console.warn('[Pendle] Batch fetch failed:', err.message);
  }

  return results;
}

export async function verifyPendleMarket(
  marketName:   string,
  minDaysLeft:  number = 14,
  provider:     JsonRpcProvider,
  prices:       PriceMap,
): Promise<{ ok: boolean; market: PendleMarket | null; error: string | null }> {
  const markets = await fetchPendleMarkets(provider, prices);
  const market  = markets.find(m => m.name === marketName);

  if (!market) return { ok: false, market: null, error: `Pendle market ${marketName} not found` };
  if (market.daysToExpiry < minDaysLeft) return { ok: false, market, error: `Too close to expiry: ${market.daysToExpiry.toFixed(0)} days left (min ${minDaysLeft})` };
  if (market.impliedAPY <= 0) return { ok: false, market, error: 'Zero or negative implied APY' };

  return { ok: true, market, error: null };
}
