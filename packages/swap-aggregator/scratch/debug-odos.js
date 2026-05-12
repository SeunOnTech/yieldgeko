async function debugOdos() {
  const params = {
    chainId: 42161,
    tokenIn: '0xFa7F8980b0f1e64A2062791cc3b0871572f1F7f0', // UNI
    tokenOut: '0x912ce59144191c1204e64559fe8253a0e49e6548', // ARB
    amountIn: '1000000000000000000', // 1 UNI
    recipient: '0x1234567890123456789012345678901234567890',
    slippageBps: 50
  };

  const quoteBody = {
    chainId: params.chainId,
    inputTokens: [{ tokenAddress: params.tokenIn, amount: params.amountIn }],
    outputTokens: [{ tokenAddress: params.tokenOut, proportion: 1 }],
    userAddr: params.recipient,
    slippageLimitPercent: params.slippageBps / 100,
    compact: true,
  };

  try {
    const quoteRes = await fetch('https://api.odos.xyz/sor/quote/v3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(quoteBody),
    });

    if (!quoteRes.ok) {
      const errText = await quoteRes.text();
      console.log('Odos Error Status:', quoteRes.status);
      console.log('Odos Error Body:', errText);
    } else {
      const data = await quoteRes.json();
      console.log('Odos Quote Success:', JSON.stringify(data, null, 2));
    }
  } catch (e) {
    console.error('Fetch failed:', e);
  }
}

debugOdos();
