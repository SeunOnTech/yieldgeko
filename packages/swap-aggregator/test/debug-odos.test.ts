import { describe, it } from 'vitest';
import { parseUnits } from 'viem';

describe('Odos Debug', () => {
  it('debugs UNI -> ARB route', async () => {
    const params = {
      chainId: 42161,
      tokenIn: '0xFa7F8980b0f1e64A2062791cc3b0871572f1F7f0', // UNI
      tokenOut: '0x912ce59144191c1204e64559fe8253a0e49e6548', // ARB
      amountIn: parseUnits('1', 18),
      recipient: '0x1234567890123456789012345678901234567890',
      slippageBps: 50
    };

    const quoteBody = {
      chainId: params.chainId,
      inputTokens: [{ tokenAddress: params.tokenIn, amount: params.amountIn.toString() }],
      outputTokens: [{ tokenAddress: params.tokenOut, proportion: 1 }],
      userAddr: params.recipient,
      slippageLimitPercent: params.slippageBps / 100,
      compact: true,
    };

    const quoteRes = await fetch('https://api.odos.xyz/sor/quote/v3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(quoteBody),
    });

    if (!quoteRes.ok) {
      const errText = await quoteRes.text();
      console.log('Odos Quote Error Status:', quoteRes.status);
      console.log('Odos Quote Error Body:', errText);
    } else {
      const quoteData = await quoteRes.json();
      console.log('Odos Quote Success, pathId:', quoteData.pathId);

      // Step 2: Assemble
      const assembleBody = {
        userAddr: params.recipient,
        pathId: quoteData.pathId,
      };

      const assembleRes = await fetch('https://api.odos.xyz/sor/assemble', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(assembleBody),
      });

      if (!assembleRes.ok) {
        const errText = await assembleRes.text();
        console.log('Odos Assemble Error Status:', assembleRes.status);
        console.log('Odos Assemble Error Body:', errText);
      } else {
        const assembleData = await assembleRes.json();
        console.log('Odos Assemble Success!');
      }
    }
  });
});
