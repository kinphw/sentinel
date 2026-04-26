// Opus 4.7 단가 (per 1M tokens, USD)
const PRICE_INPUT          = 15.0;    // fresh input
const PRICE_OUTPUT         = 75.0;    // output
const PRICE_CACHE_WRITE    = 18.75;   // cache 새로 쓸 때 (25% premium)
const PRICE_CACHE_READ     = 1.50;    // cache hit (90% discount)
const KRW_PER_USD          = 1400;

export function fmtCost(
  inTok: number,
  outTok: number,
  cacheReadTok: number = 0,
  cacheWriteTok: number = 0,
): string {
  const usd =
    (inTok       / 1_000_000) * PRICE_INPUT +
    (outTok      / 1_000_000) * PRICE_OUTPUT +
    (cacheWriteTok / 1_000_000) * PRICE_CACHE_WRITE +
    (cacheReadTok  / 1_000_000) * PRICE_CACHE_READ;
  return `$${usd.toFixed(5)} (₩${Math.round(usd * KRW_PER_USD).toLocaleString()})`;
}
