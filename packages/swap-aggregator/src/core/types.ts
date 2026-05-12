import { Address, Hex } from 'viem';

export interface QuoteParams {
  chainId:     number;
  tokenIn:     Address;
  tokenOut:    Address;
  amountIn:    bigint;
  slippageBps: number;
  recipient:   Address;  // should always be the user's smart account address
}

export interface SwapRoute {
  provider:       string;
  tokenIn:        Address;
  tokenOut:       Address;
  amountIn:       bigint;
  amountOut:      bigint;
  minAmountOut:   bigint;
  calldata:       Hex;            // ABI-encoded swap function call (not an address)
  dex:            Address;        // router address passed to YieldGekoSwapper.swap(dex, ...)
  approvalTarget: Address;        // address the smart account must approve for tokenIn
  gasEstimate?:   bigint;
  netOutput?:     bigint;         // amountOut - gasCostInTokenOut (gas-normalised comparison)
}

export interface ContractCall {
  address:      Address;
  abi:          any;
  functionName: string;
  args:         any[];
}

export interface ISwapProvider {
  readonly name: string;
  getQuote(params: QuoteParams): Promise<SwapRoute | null>;
  // Batchable path — providers that can express quotes as on-chain read calls
  getQuoteCalls?(params: QuoteParams): ContractCall[];
  processQuoteResults?(params: QuoteParams, results: any[]): SwapRoute | null;
}
