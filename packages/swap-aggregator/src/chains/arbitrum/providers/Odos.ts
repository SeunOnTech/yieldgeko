import { Address } from 'viem';
import { ISwapProvider, QuoteParams, SwapRoute } from '../../../core/types';

// Odos V2 Router on Arbitrum One — hardcoded so YieldGekoSwapper can pre-approve it
// Update this constant if Odos upgrades their router
export const ODOS_ROUTER_ADDRESS: Address = '0xa669e7A0d4b3e4Fa48af2dE86BD4CD7126Be4e13';

export class OdosProvider implements ISwapProvider {
  public readonly name    = 'Odos';
  private readonly API_BASE = 'https://api.odos.xyz/sor';

  public async getQuote(params: QuoteParams): Promise<SwapRoute | null> {
    try {
      // Step 1 — get optimal route quote
      const quoteRes = await fetch(`${this.API_BASE}/quote/v3`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chainId:             params.chainId,
          inputTokens:         [{ tokenAddress: params.tokenIn,  amount: params.amountIn.toString() }],
          outputTokens:        [{ tokenAddress: params.tokenOut, proportion: 1 }],
          userAddr:            params.recipient,
          slippageLimitPercent: params.slippageBps / 100,
          compact:             true,
        }),
      });

      if (!quoteRes.ok) return null;
      const quoteData = await quoteRes.json();
      const pathId    = quoteData?.pathId;
      if (!pathId) return null;

      // Step 2 — assemble executable calldata
      const assembleRes = await fetch(`${this.API_BASE}/assemble`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userAddr: params.recipient, pathId }),
      });

      if (!assembleRes.ok) return null;
      const assembleData = await assembleRes.json();

      if (!assembleData?.transaction?.data || !assembleData?.transaction?.to) return null;

      const amountOut    = BigInt(quoteData.outAmounts?.[0] ?? 0);
      if (amountOut === 0n) return null;

      const minAmountOut = (amountOut * BigInt(10_000 - params.slippageBps)) / 10_000n;

      // Use hardcoded router — if assembleData returns a different address, log a warning
      const routerFromApi = assembleData.transaction.to as Address;
      if (routerFromApi.toLowerCase() !== ODOS_ROUTER_ADDRESS.toLowerCase()) {
        console.warn(
          `[Odos] Router address mismatch: expected ${ODOS_ROUTER_ADDRESS}, got ${routerFromApi}. ` +
          `Update ODOS_ROUTER_ADDRESS constant and re-register in YieldGekoSwapper.`,
        );
      }

      return {
        provider:       this.name,
        tokenIn:        params.tokenIn,
        tokenOut:       params.tokenOut,
        amountIn:       params.amountIn,
        amountOut,
        minAmountOut,
        calldata:       assembleData.transaction.data as `0x${string}`,
        dex:            ODOS_ROUTER_ADDRESS,   // always use the constant, not dynamic value
        approvalTarget: ODOS_ROUTER_ADDRESS,
        gasEstimate:    BigInt(assembleData.transaction.gas || 350_000),
        netOutput:      amountOut,
      };
    } catch (err) {
      console.error('[Odos] Error:', err);
      return null;
    }
  }
}
