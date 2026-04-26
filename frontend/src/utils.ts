const PRICE_INPUT  = 3.0;
const PRICE_OUTPUT = 15.0;
const KRW_PER_USD  = 1400;

export function fmtCost(inTok: number, outTok: number): string {
  const usd = (inTok / 1_000_000) * PRICE_INPUT + (outTok / 1_000_000) * PRICE_OUTPUT;
  return `$${usd.toFixed(5)} (₩${Math.round(usd * KRW_PER_USD).toLocaleString()})`;
}
