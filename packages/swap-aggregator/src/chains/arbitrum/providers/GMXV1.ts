import { Address, createPublicClient, http, parseAbi, encodeFunctionData, PublicClient, Hex } from 'viem';
import { arbitrum } from 'viem/chains';
import { ISwapProvider, QuoteParams, SwapRoute } from '../../../core/types';

const READER_ABI = parseAbi([
  'function getAmountOut(address _vault, address _tokenIn, address _tokenOut, uint256 _amountIn) external view returns (uint256 amountOut, uint256 feeBasisPoints)',
]);

const READER_ADDRESS: Address = '0x22199a49a999c351ef7927602cfb187ec3cae489';
const VAULT_ADDRESS: Address  = '0x489ee077994b68d8d790c37c609614974f968e8c';
const ROUTER_ADDRESS: Address = '0xaBBc5F99639c9B6bCb58544ddf04EFA6802F4064'; // checksum fixed
const WETH: Address           = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const ZERO_ADDRESS             = '0x0000000000000000000000000000000000000000';

// GMX V1 only supports whitelisted tokens — check before quoting
const WHITELIST = new Set([
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
  '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', // WBTC
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
  '0xda10009cbd5d07dd0cecc66161c0193050300673', // DAI
  '0xf97f4df75117a78c1a5a0dbb814af92458539fb4', // LINK
]);

export class GMXV1Provider implements ISwapProvider {
  public readonly name = 'GMXV1';
  private client: PublicClient;

  constructor(rpcUrl?: string) {
    this.client = createPublicClient({ chain: arbitrum, transport: http(rpcUrl) });
  }

  public async getQuote(params: QuoteParams): Promise<SwapRoute | null> {
    if (params.chainId !== 42161) return null;

    const tokenIn  = params.tokenIn  === ZERO_ADDRESS ? WETH : params.tokenIn;
    const tokenOut = params.tokenOut === ZERO_ADDRESS ? WETH : params.tokenOut;

    if (!WHITELIST.has(tokenIn.toLowerCase()) || !WHITELIST.has(tokenOut.toLowerCase())) {
      return null;
    }

    try {
      const [amountOut] = await this.client.readContract({
        address:      READER_ADDRESS,
        abi:          READER_ABI,
        functionName: 'getAmountOut',
        args:         [VAULT_ADDRESS, tokenIn, tokenOut, params.amountIn],
      }) as [bigint, bigint];

      if (amountOut === 0n) return null;

      const minAmountOut = (amountOut * BigInt(10_000 - params.slippageBps)) / 10_000n;

      const swapAbi = parseAbi([
        'function swap(address[] memory _path, uint256 _amountIn, uint256 _minOut, address _receiver) external',
      ]);

      const calldata: Hex = encodeFunctionData({
        abi:          swapAbi,
        functionName: 'swap',
        args:         [[tokenIn, tokenOut], params.amountIn, minAmountOut, params.recipient],
      });

      return {
        provider:       this.name,
        tokenIn,
        tokenOut,
        amountIn:       params.amountIn,
        amountOut,
        minAmountOut,
        calldata,
        dex:            ROUTER_ADDRESS,
        approvalTarget: ROUTER_ADDRESS,
        gasEstimate:    200_000n,
        netOutput:      amountOut,
      };
    } catch {
      return null;
    }
  }
}
