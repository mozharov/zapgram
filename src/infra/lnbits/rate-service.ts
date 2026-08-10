import type {AppLogger} from '../logger.js'
import {LNBitsAPI} from './lnbits-api.js'
import {rateResponseSchema} from './schemas.js'

const DEFAULT_TTL_MS = 5 * 60 * 1000

export type RateServiceDeps = {
  fetchUsdBtcRate: () => Promise<number>
  log?: Pick<AppLogger, 'error'> & {warn?: AppLogger['warn']}
  ttlMs?: number
  now?: () => number
}

export type RateService = {
  getBtcUsd(): Promise<number | null>
}

export function createRateService(deps: RateServiceDeps): RateService {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
  const now = deps.now ?? (() => Date.now())
  let cached: {rate: number; fetchedAt: number} | null = null
  let inFlight: Promise<number | null> | null = null

  return {
    async getBtcUsd() {
      if (cached && now() - cached.fetchedAt < ttlMs) return cached.rate
      if (inFlight) return inFlight

      inFlight = (async () => {
        try {
          const rate = await deps.fetchUsdBtcRate()
          cached = {rate, fetchedAt: now()}
          return rate
        } catch (error) {
          if (cached) {
            deps.log?.warn?.({error}, 'BTC/USD rate refresh failed; using last-good')
            return cached.rate
          }
          deps.log?.error({error}, 'BTC/USD rate unavailable')
          return null
        } finally {
          inFlight = null
        }
      })()

      return inFlight
    },
  }
}

class RateClient extends LNBitsAPI {
  getUsdRate() {
    return this.fetchWithSchema('/api/v1/rate/USD', rateResponseSchema)
  }
}

/** Production fetch bound to LNbits public rate endpoint (no API key). */
export function createLnbitsRateFetcher(baseUrl: string, log?: AppLogger): () => Promise<number> {
  const client = new RateClient({baseUrl, log})
  return async () => {
    const body = await client.getUsdRate()
    return body.rate
  }
}
