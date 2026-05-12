import {
  Address, createPublicClient, http, parseAbi, encodeFunctionData,
  PublicClient, encodePacked, getAddress, Hex,
} from 'viem';
import { arbitrum } from 'viem/chains';
import { ISwapProvider, QuoteParams, SwapRoute, ContractCall } from '../../../core/types';

// Camelot V3 uses Algebra protocol — quoter ABI differs from Uniswap V3
// Algebra paths don't include fee tiers — just packed addresses
const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint160 limitSqrtPrice) external returns (uint256 amountOut)',
  'function quoteExactInput(bytes memory path, uint256 amountIn) external returns (uint256 amountOut, uint16[] memory fees)',
]);

const QUOTER_ADDRESS: Address = '0x0Fc73040b26E9bC8514fA028D998E73A254Fa76E';
const ROUTER_ADDRESS: Address = '0x1F721E29116517A00331d9a2681feF5046263762';
const WETH: Address           = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const ZERO_ADDRESS             = '0x0000000000000000000000000000000000000000';

export class CamelotV3Provider implements ISwapProvider {
  public readonly name = 'CamelotV3';
  private client: PublicClient;

  constructor(rpcUrl?: string) {
    this.client = createPublicClient({ chain: arbitrum, transport: http(rpcUrl) });
  }

  public getQuoteCalls(params: QuoteParams): ContractCall[] {
    if (params.chainId !== 42161) return [];

    const tokenIn  = getAddress(params.tokenIn  === ZERO_ADDRESS ? WETH : params.tokenIn);
    const tokenOut = getAddress(params.tokenOut === ZERO_ADDRESS ? WETH : params.tokenOut);

    const calls: ContractCall[] = [];

    // Direct pool quote
    calls.push({
      address:      QUOTER_ADDRESS,
      abi:          QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args:         [tokenIn, tokenOut, params.amountIn, 0n],
    });

    // WETH-hop quote (only when neither token is WETH)
    if (tokenIn !== WETH && tokenOut !== WETH) {
      // Algebra path: packed addresses only — no fee tiers
      const hopPath = encodePacked(
        ['address', 'address', 'address'],
        [tokenIn, WETH, tokenOut],
      );
      calls.push({
        address:      QUOTER_ADDRESS,
        abi:          QUOTER_ABI,
        functionName: 'quoteExactInput',
        args:         [hopPath, params.amountIn],
      });
    }

    return calls;
  }

  public processQuoteResults(params: QuoteParams, results: any[]): SwapRoute | null {
    if (!results || results.length === 0) return null;

    const tokenIn  = getAddress(params.tokenIn  === ZERO_ADDRESS ? WETH : params.tokenIn);
    const tokenOut = getAddress(params.tokenOut === ZERO_ADDRESS ? WETH : params.tokenOut);

    let bestAmountOut = 0n;
    let bestIdx       = -1;

    // result[0] = quoteExactInputSingle → returns uint256 directly
    const direct = results[0];
    if (direct && typeof direct === 'bigint' && direct > 0n) {
      bestAmountOut = direct;
      bestIdx       = 0;
    }

    // result[1] = quoteExactInput → returns (uint256, uint16[]) tuple
    if (results[1]) {
      const hopOut = Array.isArray(results[1]) ? results[1][0] : results[1];
      if (typeof hopOut === 'bigint' && hopOut > bestAmountOut) {
        bestAmountOut = hopOut;
        bestIdx       = 1;
      }
    }

    if (bestAmountOut === 0n || bestIdx === -1) return null;

    const minAmountOut = (bestAmountOut * BigInt(10_000 - params.slippageBps)) / 10_000n;
    let calldata: Hex;

    if (bestIdx === 0) {
      // Direct — exactInputSingle
      const swapAbi = parseAbi([
        'function exactInputSingle((address tokenIn, address tokenOut, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 limitSqrtPrice)) external payable returns (uint256 amountOut)',
      ]);
      calldata = encodeFunctionData({
        abi:          swapAbi,
        functionName: 'exactInputSingle',
        args: [{
          tokenIn,
          tokenOut,
          recipient:          params.recipient,
          deadline:           BigInt(Math.floor(Date.now() / 1000) + 1800),
          amountIn:           params.amountIn,
          amountOutMinimum:   minAmountOut,
          limitSqrtPrice:     0n,
        }],
      });
    } else {
      // WETH hop — exactInput
      const swapAbi = parseAbi([
        'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) external payable returns (uint256 amountOut)',
      ]);
      const hopPath = encodePacked(
        ['address', 'address', 'address'],
        [tokenIn, WETH, tokenOut],
      );
      calldata = encodeFunctionData({
        abi:          swapAbi,
        functionName: 'exactInput',
        args: [{
          path:             hopPath,
          recipient:        params.recipient,
          deadline:         BigInt(Math.floor(Date.now() / 1000) + 1800),
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
      dex:            ROUTER_ADDRESS,
      approvalTarget: ROUTER_ADDRESS,
      gasEstimate:    280_000n,
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
