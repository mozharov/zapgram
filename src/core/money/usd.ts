const SATS_PER_BTC = 100_000_000

export function satsToUsd(sats: number, btcUsd: number): number {
  return (sats * btcUsd) / SATS_PER_BTC
}

export function formatUsdAmount(usd: number): string {
  if (usd === 0) return '0.00'
  const abs = Math.abs(usd)
  if (abs >= 0.01) {
    return abs.toFixed(2)
  }

  // Sub-cent: one significant digit
  // e.g. 0.00181391 → 0.002, 0.00032205 → 0.0003, 0.00095 → 0.001
  const order = Math.floor(Math.log10(abs))
  const factor = 10 ** -order
  const rounded = Math.round(abs * factor) / factor
  // Recompute digits after possible carry (e.g. 0.00095 → 0.001, 0.0099 → 0.01)
  const roundedOrder = Math.floor(Math.log10(rounded))
  return rounded.toFixed(Math.max(1, -roundedOrder))
}

export function formatUsdSuffix(usd: number | null): string {
  if (usd === null) return ''
  return ` (~$${formatUsdAmount(usd)})`
}
