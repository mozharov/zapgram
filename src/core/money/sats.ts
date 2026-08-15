export function msatsToSats(msats: number) {
  return Math.round(msats / 1000)
}

export function satsToMsats(sats: number) {
  return sats * 1000
}

/**
 * Decimal BTC, as a BIP-21 `amount` expects it: eight fixed places with the trailing zeroes
 * trimmed, never exponential notation — `1e-7` is not an amount any wallet parses.
 */
export function satsToBtcAmount(sats: number) {
  return (sats / 100_000_000).toFixed(8).replace(/\.?0+$/, '')
}
