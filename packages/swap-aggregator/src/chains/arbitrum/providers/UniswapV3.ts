import {
  Address, createPublicClient, http, parseAbi, encodeFunctionData,
  PublicClient, encodePacked, getAddress, Hex,
} from 'viem';
import { arbitrum } from 'viem/chains';
import { ISwapProvider, QuoteParams, SwapRoute, ContractCall } from '../../../core/types';

const QUOTER_V2_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]);

const QUOTER_V2_ADDRESS: Address = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const SWAP_ROUTER_ADDRESS: Address = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const WETH: Address = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const ZERO_ADDRESS  = '0x0000000000000000000000000000000000000000';
const FEES          = [500, 3000, 10_000] as const;

export class UniswapV3Provider implements ISwapProvider {
  public readonly name = 'UniswapV3:Arbitrum';
  private client: PublicClient;

  constructor(rpcUrl?: string) {
    this.client = createPublicClient({ chain: arbitrum, transport: http(rpcUrl) });
  }

  public getQuoteCalls(params: QuoteParams): ContractCall[] {
    if (params.chainId !== 42161) return [];

    const tokenIn  = getAddress(params.tokenIn  === ZERO_ADDRESS ? WETH : params.tokenIn);
    const tokenOut = getAddress(params.tokenOut === ZERO_ADDRESS ? WETH : params.tokenOut);

    const calls: ContractCall[] = [];

    // Direct pools — 3 fee tiers
    for (const fee of FEES) {
      calls.push({
        address:      QUOTER_V2_ADDRESS,
        abi:          QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn, tokenOut, amountIn: params.amountIn, fee, sqrtPriceLimitX96: 0n }],
      });
    }

    // WETH-hop — 3×3 = 9 paths (only when neither token is WETH)
    if (tokenIn !== WETH && tokenOut !== WETH) {
      for (const fee1 of FEES) {
        for (const fee2 of FEES) {
          calls.push({
            address:      QUOTER_V2_ADDRESS,
            abi:          QUOTER_V2_ABI,
            functionName: 'quoteExactInput',
            args: [
              encodePacked(
                ['address', 'uint24', 'address', 'uint24', 'address'],
                [tokenIn, fee1, WETH, fee2, tokenOut],
              ),
              params.amountIn,
            ],
          });
        }
      }
    }

    return calls;
  }

  public processQuoteResults(params: QuoteParams, results: any[]): SwapRoute | null {
    if (!results || results.length === 0) return null;

    const tokenIn  = getAddress(params.tokenIn  === ZERO_ADDRESS ? WETH : params.tokenIn);
    const tokenOut = getAddress(params.tokenOut === ZERO_ADDRESS ? WETH : params.tokenOut);

    let bestAmountOut  = 0n;
    let bestGas        = 0n;
    let bestIdx        = -1;

    // Indices 0-2: direct pools
    for (let i = 0; i < 3; i++) {
      const res = results[i];
      if (res && Array.isArray(res) && (res[0] as bigint) > bestAmountOut) {
        bestAmountOut = res[0] as bigint;
        bestGas       = res[3] as bigint;
        bestIdx       = i;
      }
    }

    // Indices 3-11: WETH-hop paths
    if (tokenIn !== WETH && tokenOut !== WETH) {
      for (let i = 0; i < 9; i++) {
        const res = results[3 + i];
        if (res && Array.isArray(res) && (res[0] as bigint) > bestAmountOut) {
          bestAmountOut = res[0] as bigint;
          bestGas       = res[3] as bigint;
          bestIdx       = 3 + i;
        }
      }
    }

    if (bestAmountOut === 0n || bestIdx === -1) return null;

    const minAmountOut = (bestAmountOut * BigInt(10_000 - params.slippageBps)) / 10_000n;
    let calldata: Hex;

    if (bestIdx < 3) {
      // Direct — exactInputSingle
      const fee    = FEES[bestIdx];
      const swapAbi = parseAbi([
        'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
      ]);
      calldata = encodeFunctionData({
        abi:          swapAbi,
        functionName: 'exactInputSingle',
        args: [{
          tokenIn, tokenOut, fee,
          recipient:        params.recipient,
          amountIn:         params.amountIn,
          amountOutMinimum: minAmountOut,
          sqrtPriceLimitX96: 0n,
        }],
      });
    } else {
      // WETH hop — exactInput
      const combinedIdx = bestIdx - 3;
      const fee1 = FEES[Math.floor(combinedIdx / 3)];
      const fee2 = FEES[combinedIdx % 3];
      const swapAbi = parseAbi([
        'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) external payable returns (uint256 amountOut)',
      ]);
      calldata = encodeFunctionData({
        abi:          swapAbi,
        functionName: 'exactInput',
        args: [{
          path: encodePacked(
            ['address', 'uint24', 'address', 'uint24', 'address'],
            [tokenIn, fee1, WETH, fee2, tokenOut],
          ),
          recipient:        params.recipient,
          amountIn:         params.amountIn,
          amountOutMinimum: minAmountOut,
        }],
      });
    }

    return {
      provider:       this.name,
      tokenIn,
      tokenOut,
      amountIn:       params.amountIn,
      amountOut:      bestAmountOut,
      minAmountOut,
      calldata,
      dex:            SWAP_ROUTER_ADDRESS,
      approvalTarget: SWAP_ROUTER_ADDRESS,
      gasEstimate:    bestGas || 250_000n,
      netOutput:      bestAmountOut,
    };
  }

  public async getQuote(params: QuoteParams): Promise<SwapRoute | null> {
    const calls = this.getQuoteCalls(params);
    if (calls.length === 0) return null;
    try {
      const results = await Promise.all(
        calls.map(c => this.client.readContract(c as any).catch(() => null)),
      );
      return this.processQuoteResults(params, results);
    } catch {
      return null;
    }
  }
}
