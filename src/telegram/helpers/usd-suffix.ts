import {formatUsdSuffix, satsToUsd} from '@core/money/usd.js'
import {getRuntime} from '../../runtime.js'

export async function usdSuffixForSats(sats: number): Promise<string> {
  const btcUsd = await getRuntime().rates.getBtcUsd()
  if (btcUsd === null) return ''
  return formatUsdSuffix(satsToUsd(sats, btcUsd))
}

/** Parallel suffixes for several amounts (one rate fetch). */
export async function usdSuffixesForSats(amounts: number[]): Promise<string[]> {
  const btcUsd = await getRuntime().rates.getBtcUsd()
  if (btcUsd === null) return amounts.map(() => '')
  return amounts.map(sats => formatUsdSuffix(satsToUsd(sats, btcUsd)))
}
