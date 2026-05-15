

export interface DivergenceStats {
  correlation:    number;   
  volatility:     number;   
  divergenceRisk: number;   
  priceRatioVar:  number;   
  dataPoints:     number;
}

export function calculateCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;

  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) {
    sx  += x[i]!; sy  += y[i]!;
    sxy += x[i]! * y[i]!;
    sx2 += x[i]! * x[i]!;
    sy2 += y[i]! * y[i]!;
  }
  const num  = n * sxy - sx * sy;
  const den  = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
  if (den === 0) return 1;
  return Math.max(-1, Math.min(1, num / den));
}

export function calculateVolatility(prices: number[]): number {
  if (prices.length < 3) return 0.5;

  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1]! > 0 && prices[i]! > 0) {
      returns.push(Math.log(prices[i]! / prices[i - 1]!));
    }
  }
  if (returns.length < 2) return 0.5;

  const mean     = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(365);
}

export function calculatePriceRatioVariance(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 1.0;

  const ratios = x.slice(0, n).map((v, i) => (y[i]! > 0 ? v / y[i]! : 1));
  const mean   = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / ratios.length;
}

export function calculateDivergenceStats(
  baseClosePrices:  number[],
  quoteClosePrices: number[],
): DivergenceStats {
  const n = Math.min(baseClosePrices.length, quoteClosePrices.length);

  const correlation   = calculateCorrelation(baseClosePrices, quoteClosePrices);
  const volatility    = calculateVolatility(baseClosePrices);
  const priceRatioVar = calculatePriceRatioVariance(baseClosePrices, quoteClosePrices);

  
  
  
  
  const corrFactor    = 1 - Math.max(0, correlation);
  const pegFactor     = Math.min(1, priceRatioVar * 200);  
  const divergenceRisk = Math.min(1, volatility * corrFactor * (0.3 + 0.7 * pegFactor));

  return { correlation, volatility, divergenceRisk, priceRatioVar, dataPoints: n };
}

export function ewmaVolatility(logReturns: number[], lambda = 0.94): number {
  if (logReturns.length < 3) return 0;
  let v = logReturns[0]! ** 2;
  for (let i = 1; i < logReturns.length; i++) {
    v = lambda * v + (1 - lambda) * logReturns[i]! ** 2;
  }
  return Math.sqrt(v * 365);
}

export function rollingVolatility(logReturns: number[], window: number): number {
  const r = logReturns.slice(-window);
  if (r.length < 3) return 0;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1) * 365);
}

export function conservativeVolatility(logReturns: number[]): number {
  return Math.max(
    rollingVolatility(logReturns, 7),
    rollingVolatility(logReturns, 14),
    rollingVolatility(logReturns, 30),
    ewmaVolatility(logReturns),
  );
}

export function spearmanCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0;

  const rank = (arr: number[]) => {
    const sorted = arr.slice(0, n).map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v);
    const r      = new Array<number>(n);
    sorted.forEach((x, rank) => { r[x.i] = rank + 1; });
    return r;
  };

  const rA = rank(a), rB = rank(b);
  const mA = rA.reduce((s, v) => s + v, 0) / n;
  const mB = rB.reduce((s, v) => s + v, 0) / n;
  let cov = 0, vA = 0, vB = 0;
  for (let i = 0; i < n; i++) {
    const dA = rA[i]! - mA, dB = rB[i]! - mB;
    cov += dA * dB; vA += dA ** 2; vB += dB ** 2;
  }
  return vA * vB > 0 ? cov / Math.sqrt(vA * vB) : 0;
}
