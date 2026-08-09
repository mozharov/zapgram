const SATS_PER_BTC = 100_000_000
const MAX_FRACTION_DIGITS = 8

export function satsToUsd(sats: number, btcUsd: number): number {
  return (sats * btcUsd) / SATS_PER_BTC
}

export function formatUsdAmount(usd: number): string {
  if (usd === 0) return '0.00'
  const abs = Math.abs(usd)
  if (abs >= 0.01) {
    return abs.toFixed(2)
  }
  // Adaptive digits: enough precision that rounding is not truncated to a coarser value
  const full = Number(abs.toFixed(MAX_FRACTION_DIGITS))
  for (let digits = 3; digits <= MAX_FRACTION_DIGITS; digits++) {
    const rounded = abs.toFixed(digits)
    if (Number(rounded) !== 0 && Number(rounded) === full) return rounded
  }
  return abs.toFixed(MAX_FRACTION_DIGITS)
}

export function formatUsdSuffix(usd: number | null): string {
  if (usd === null) return ''
  return ` (~$${formatUsdAmount(usd)})`
}
